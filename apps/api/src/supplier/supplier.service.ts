import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { QuotationService, type QuotationInput } from '../sourcing/quotation.service';
import type { AuthenticatedUser } from '../auth/auth.service';
import {
  inboxKpis,
  supplierRoster,
  quoteLineTotals,
  validateSupplierQuote,
  leadTimeDays,
  warrantyMonths,
  paymentTermsDays,
  supplierInboxParagraph,
  supplierInboxSubtitle,
  supplierQuoteSubtitle,
  supplierQuoteAlert,
  invitedCountLabel,
  SUPPLIER_INBOX_TITLE,
  SUPPLIER_QUOTE_TITLE,
  SUPPLIER_INBOX_EMPTY,
  SUPPLIER_VISIBILITY_NOTE,
  SUPPLIER_REMARKS_PLACEHOLDER,
  SUPPLIER_TERM_OPTIONS,
  SUPPLIER_TERM_DEFAULTS,
  type SupplierInvitation,
  type SupplierQuoteLine,
} from '@procurement/workflow-engine';

/** What the supplier portal form may send. Mirrors the prototype's fields. */
export type SupplierQuoteBody = {
  lines: Array<{ lineNo: number; unitPrice: number | string | null }>;
  totalAmount?: number | null;
  /** The prototype's select LABELS ("7 days"), not the stored integers. */
  leadTime?: string | null;
  warranty?: string | null;
  paymentTerms?: string | null;
  remarks?: string | null;
};

/**
 * The supplier-facing read/write surface (WAVE4_PLAN.md §6, step 2).
 *
 * SCOPING, stated once so every method below can be read against it: this
 * service NEVER accepts a vendor id from the request. It takes the one on
 * `user.vendorId`, which SupplierGuard has already refused to run without, and
 * every query is filtered by it. A supplier therefore cannot see, price or
 * decline another supplier's invitation by guessing a uuid.
 */
@Injectable()
export class SupplierService {
  constructor(
    private readonly db: DbService,
    private readonly quotations: QuotationService,
  ) {}

  // ── GET /supplier/inbox ──────────────────────────────────────────────────
  /**
   * The 4-up KPI band, the invitation list and each invitation's roster.
   *
   * Every KPI is computed by the engine's pure inboxKpis(); none of the
   * prototype's literals (1 / No / 2 / PKR 21.8 L) survive as values.
   */
  async inbox(user: AuthenticatedUser) {
    const vendorId = this.requireVendor(user);

    // The identity is read on its own rather than piggybacked on the first
    // invitation row. The prototype ALWAYS renders "Acting as <legal_name> ·
    // <vendor_code>" above the list, including above the empty state — a
    // supplier with nothing to do still needs to know which account they are
    // looking at, and borrowing it from the invitations made the subtitle
    // disappear exactly when it mattered most.
    const me = await this.db.query<any>(
      `SELECT id, vendor_code, legal_name
         FROM core.vendors
        WHERE id = $1::uuid`,
      [vendorId],
      { userId: user.id, role: user.role, costCenterIds: user.costCenterIds, bypassRls: true },
    );
    if (me.rows.length === 0) {
      // Unreachable while ck_users_vendor_role holds, but an FK that silently
      // stops resolving would otherwise render an unidentifiable page.
      throw new NotFoundException('vendor record not found for this account');
    }
    const identity = {
      vendorId,
      vendorCode: me.rows[0].vendor_code ?? null,
      legalName: me.rows[0].legal_name ?? null,
    };
    const subtitle = supplierInboxSubtitle(identity.legalName ?? '', identity.vendorCode ?? '');

    const inv = await this.db.query<any>(
      `SELECT i.id            AS invitation_id,
              i.submitted, i.declined, i.declined_reason, i.invited_at,
              rf.id           AS rfq_id,
              rf.rfq_number, rf.title, rf.state AS rfq_state,
              rf.issued_at, rf.deadline_at, rf.currency,
              pr.estimated_amount
         FROM proc.rfq_invitations i
         JOIN proc.rfq rf               ON rf.id = i.rfq_id
         LEFT JOIN proc.purchase_requisitions pr ON pr.id = rf.pr_id
        WHERE i.vendor_id = $1::uuid
        ORDER BY rf.deadline_at ASC NULLS LAST, i.invited_at DESC`,
      [vendorId],
      { userId: user.id, role: user.role, costCenterIds: user.costCenterIds, bypassRls: true },
    );

    if (inv.rows.length === 0) {
      // The prototype's empty state, verbatim. Rendered instead of a band of
      // zeroes, which would imply a working RFQ exists somewhere.
      return {
        identity,
        subtitle,
        title: SUPPLIER_INBOX_TITLE,
        empty: true,
        emptyMessage: SUPPLIER_INBOX_EMPTY,
        kpis: [],
        invitations: [],
      };
    }

    const rfqIds = [...new Set(inv.rows.map((r: any) => r.rfq_id))];

    // Roster, line counts and my live versions: three more queries for ALL
    // invitations, not three per invitation. Each DbService call spawns a
    // docker exec, so an N+1 here is an N-times-slower inbox.
    const [roster, lineCounts, myQuotes] = await Promise.all([
      this.db.query<any>(
        `SELECT i.rfq_id, i.vendor_id, i.submitted, i.declined, v.legal_name
           FROM proc.rfq_invitations i
           JOIN core.vendors v ON v.id = i.vendor_id
          WHERE i.rfq_id = ANY($1::uuid[])
          ORDER BY v.legal_name`,
        [rfqIds],
        { userId: user.id, role: user.role, costCenterIds: user.costCenterIds, bypassRls: true },
      ),
      this.db.query<any>(
        `SELECT rfq_id, count(*)::int AS line_count
           FROM proc.rfq_lines
          WHERE rfq_id = ANY($1::uuid[])
          GROUP BY rfq_id`,
        [rfqIds],
        { userId: user.id, role: user.role, costCenterIds: user.costCenterIds, bypassRls: true },
      ),
      this.db.query<any>(
        `SELECT DISTINCT ON (rfq_id) rfq_id, id, version, state
           FROM proc.quotations
          WHERE vendor_id = $1::uuid
            AND rfq_id = ANY($2::uuid[])
            AND state = 'Submitted'
          ORDER BY rfq_id, version DESC`,
        [vendorId, rfqIds],
        { userId: user.id, role: user.role, costCenterIds: user.costCenterIds, bypassRls: true },
      ),
    ]);

    const rosterBy = new Map<string, any[]>();
    for (const r of roster.rows) {
      const list = rosterBy.get(r.rfq_id) ?? [];
      list.push(r);
      rosterBy.set(r.rfq_id, list);
    }
    const countBy = new Map<string, number>(
      lineCounts.rows.map((r: any) => [r.rfq_id, Number(r.line_count)]),
    );
    const quoteBy = new Map<string, any>(myQuotes.rows.map((r: any) => [r.rfq_id, r]));

    const invitations: SupplierInvitation[] = inv.rows.map((r: any) => {
      const mine = quoteBy.get(r.rfq_id);
      return {
        invitationId: r.invitation_id,
        rfqId: r.rfq_id,
        rfqNumber: r.rfq_number,
        rfqTitle: r.title,
        issuedAt: r.issued_at,
        deadlineAt: r.deadline_at,
        // The CSV bridge returns numerics as strings; coerce before the engine
        // ever sees them or "0" would be truthy and "1" would sum as a string.
        estimatedAmount: r.estimated_amount === null ? null : Number(r.estimated_amount),
        declined: r.declined === true,
        myQuote: mine
          ? { version: Number(mine.version), state: mine.state }
          : null,
        roster: (rosterBy.get(r.rfq_id) ?? []).map((x: any) => ({
          vendorId: x.vendor_id,
          legalName: x.legal_name,
          submitted: x.submitted === true,
          declined: x.declined === true,
        })),
      };
    });

    return {
      identity,
      title: SUPPLIER_INBOX_TITLE,
      subtitle,
      empty: false,
      emptyMessage: SUPPLIER_INBOX_EMPTY,
      kpis: inboxKpis(invitations),
      // The "Due <date>" label replaces the prototype's "Closing in 7 days"
      // countdown (W4-2 — no timer may run).
      dueLabel: 'Due',
      visibilityNote: SUPPLIER_VISIBILITY_NOTE,
      invitations: invitations.map((it, i) => {
        const row = inv.rows[i];
        // Every invited vendor, declined ones included — the roster card lists
        // the whole field, so the count must match the rows it labels.
        const others = it.roster.filter((v) => v.vendorId !== vendorId).map((v) => v.legalName);
        return {
          ...it,
          lineCount: countBy.get(it.rfqId) ?? 0,
          paragraph: supplierInboxParagraph(countBy.get(it.rfqId) ?? 0, others),
          rosterRows: supplierRoster(it, vendorId),
          invitedLabel: invitedCountLabel(it.roster.length),
          canSubmit: it.rfqNumber ? row.rfq_state === 'Open' && !it.declined : false,
          canDecline: it.rfqNumber ? !it.declined : false,
        };
      }),
    };
  }

  // ── GET /supplier/rfq/:invitationId ──────────────────────────────────────
  /**
   * The quote form: RFQ header, its lines, and my current quote version.
   *
   * Unit prices are NOT pre-filled. The prototype drops in
   * `Math.round(estimated / totalQty)`, which is a guess dressed as a quote;
   * W4 §7 requires a blank form, and the engine returns a null total until a
   * real price exists.
   */
  async quoteForm(user: AuthenticatedUser, invitationId: string) {
    const vendorId = this.requireVendor(user);

    const r = await this.db.query<any>(
      `SELECT i.id AS invitation_id, i.submitted, i.declined, i.declined_reason, i.invited_at,
              rf.id AS rfq_id, rf.rfq_number, rf.title, rf.state AS rfq_state,
              rf.currency, rf.issued_at, rf.deadline_at, rf.incoterm,
              pr.title AS pr_title, pr.estimated_amount,
              d.name AS buyer_department
         FROM proc.rfq_invitations i
         JOIN proc.rfq rf                     ON rf.id = i.rfq_id
         LEFT JOIN proc.purchase_requisitions pr ON pr.id = rf.pr_id
         LEFT JOIN core.departments d         ON d.id = pr.department_id
         JOIN core.vendors me                 ON me.id = i.vendor_id
        WHERE i.id = $1::uuid AND i.vendor_id = $2::uuid`,
      [invitationId, vendorId],
      { userId: user.id, role: user.role, costCenterIds: user.costCenterIds, bypassRls: true },
    );
    // 404, never 403: a 403 would confirm that some other supplier's
    // invitation id exists.
    if (r.rows.length === 0) throw new NotFoundException('invitation not found');
    const h = r.rows[0];

    // proc.rfq_lines carries NO sku column. The prototype's line-pricing table
    // shows one, so it is reached through the PR line this RFQ line was built
    // from: rfq_lines.pr_line_id -> pr_lines.item_id -> items.item_code.
    // (An earlier draft selected `sku` here and every form load 500'd.)
    const rfqLines = await this.db.query<any>(
      `SELECT rl.line_no, rl.description, rl.quantity, rl.uom,
              COALESCE(it.item_code, '') AS sku
         FROM proc.rfq_lines rl
         LEFT JOIN proc.pr_lines prl ON prl.id = rl.pr_line_id
         LEFT JOIN core.items  it  ON it.id = prl.item_id
        WHERE rl.rfq_id = $1::uuid
        ORDER BY rl.line_no`,
      [h.rfq_id],
      { userId: user.id, role: user.role, costCenterIds: user.costCenterIds, bypassRls: true },
    );

    // My current live version and its prices, so a revision starts from what I
    // actually submitted rather than from a blank form.
    const mine = await this.db.query<any>(
      `SELECT DISTINCT ON (version) id, version, state, total_amount, lead_time_days,
              warranty_months, payment_terms, notes
         FROM proc.quotations
        WHERE rfq_id = $1::uuid AND vendor_id = $2::uuid AND state = 'Submitted'
        ORDER BY version DESC`,
      [h.rfq_id, vendorId],
      { userId: user.id, role: user.role, costCenterIds: user.costCenterIds, bypassRls: true },
    );
    const current = mine.rows[0] ?? null;

    const mineLines = current
      ? await this.db.query<any>(
          `SELECT rfq_line_no, unit_price, declined, remarks
             FROM proc.quotation_lines
            WHERE quotation_id = $1::uuid
            ORDER BY rfq_line_no`,
          [current.id],
          { userId: user.id, role: user.role, costCenterIds: user.costCenterIds, bypassRls: true },
        )
      : { rows: [] as any[] };

    const priceBy = new Map<number, number>(
      mineLines.rows
        .filter((l: any) => l.declined !== true)
        .map((l: any) => [Number(l.rfq_line_no), Number(l.unit_price)]),
    );

    const lines: SupplierQuoteLine[] = rfqLines.rows.map((l: any) => ({
      lineNo: Number(l.line_no),
      sku: l.sku ?? '',
      description: l.description ?? '',
      qty: Number(l.quantity ?? 0),
      uom: l.uom ?? '',
      unitPrice: priceBy.has(Number(l.line_no)) ? priceBy.get(Number(l.line_no))! : null,
    }));

    const totals = quoteLineTotals(lines);

    return {
      title: SUPPLIER_QUOTE_TITLE,
      subtitle: supplierQuoteSubtitle(h.rfq_number, h.title ?? h.pr_title ?? '', h.deadline_at),
      // The real buying department, because the schema has no buyer/tenant
      // entity and the prototype's alert is one literal that is really its fake
      // buyer AND its fake supplier. See supplierInboxSubtitle() for why that
      // literal is described rather than quoted.
      alert: supplierQuoteAlert(h.buyer_department ?? 'the buyer'),
      visibilityNote: SUPPLIER_VISIBILITY_NOTE,
      invitation: {
        id: h.invitation_id,
        rfqId: h.rfq_id,
        rfqNumber: h.rfq_number,
        rfqState: h.rfq_state,
        issuedAt: h.issued_at,
        deadlineAt: h.deadline_at,
        currency: h.currency,
        incoterms: h.incoterms ?? null,
        submitted: h.submitted === true,
        declined: h.declined === true,
        declinedReason: h.declined_reason ?? null,
        invitedAt: h.invited_at,
      },
      // A blank form is the point. `complete: false` makes the renderer show
      // the em-dash rather than a total derived from nothing.
      lines,
      unitPricePrefilled: false,
      totals: {
        lineTotals: totals.lineTotals,
        total: totals.total,
        complete: totals.complete,
        pricedCount: totals.pricedCount,
      },
      currentQuote: current
        ? {
            id: current.id,
            version: Number(current.version),
            state: current.state,
            totalAmount: current.total_amount === null ? null : Number(current.total_amount),
            leadTimeDays: current.lead_time_days === null ? null : Number(current.lead_time_days),
            warrantyMonths: current.warranty_months === null ? null : Number(current.warranty_months),
            paymentTerms: current.payment_terms ?? null,
            remarks: current.notes ?? null,
          }
        : null,
      terms: {
        leadTime: [...SUPPLIER_TERM_OPTIONS.leadTime],
        warranty: [...SUPPLIER_TERM_OPTIONS.warranty],
        paymentTerms: [...SUPPLIER_TERM_OPTIONS.paymentTerms],
        defaults: SUPPLIER_TERM_DEFAULTS,
        remarksPlaceholder: SUPPLIER_REMARKS_PLACEHOLDER,
      },
      canSubmit: h.rfq_state === 'Open' && h.declined !== true,
    };
  }

  // ── POST /supplier/rfq/:invitationId/quote ───────────────────────────────
  /**
   * Submit, or REVISE by re-submitting. Append-only: the prior version is
   * marked Superseded and its price is never rewritten.
   *
   * The write itself is QuotationService.submitAsVendor(), which shares its
   * version-chain logic with the procurement path (R4).
   */
  async submitQuote(user: AuthenticatedUser, invitationId: string, body: SupplierQuoteBody) {
    const vendorId = this.requireVendor(user);

    // A vendorId in the body is IGNORED, not honoured and not refused.
    //
    // The reason is the DTO, not this method: app.useGlobalPipes in main.ts sets
    // `whitelist: true`, so any property the DTO does not declare is stripped
    // before the service is called. A check here would look like a guard while
    // being unreachable — a guard that can never fire is worse than no guard,
    // because a reader trusts it.
    //
    // The real defence-in-depth is in QuotationService.submitAsVendor(), which
    // re-checks the invitation against the session vendor. That one is reachable
    // by any future direct caller. The write below always uses `vendorId` from
    // the session, never anything from the request.

    // Validate BEFORE touching the database, with the engine's pure rule, so a
    // blank unit price produces a line-specific message rather than a
    // constraint violation from somewhere deep in the write.
    const lines: SupplierQuoteLine[] = (body?.lines ?? []).map(l => ({
      lineNo: Number(l.lineNo),
      sku: '',
      description: `line ${Number(l.lineNo)}`,
      qty: 0,
      uom: '',
      unitPrice: l.unitPrice === null || l.unitPrice === undefined || l.unitPrice === ''
        ? null
        : Number(l.unitPrice),
    }));

    // The quantities and descriptions come from the RFQ, not the client — a
    // client that sends qty: 0 must not be able to make every line total zero.
    const form = await this.quoteForm(user, invitationId);
    const real = new Map(form.lines.map((l: any) => [l.lineNo, l]));
    for (const l of lines) {
      const src = real.get(l.lineNo);
      if (!src) {
        throw new BadRequestException(`line ${l.lineNo} is not on this RFQ`);
      }
      l.qty = src.qty;
      l.uom = src.uom;
      l.sku = src.sku;
      l.description = src.description;
    }

    const v = validateSupplierQuote({
      lines,
      totalAmount: body?.totalAmount,
      leadTime: body?.leadTime,
      warranty: body?.warranty,
      paymentTerms: body?.paymentTerms,
    });
    if (!v.ok) throw new BadRequestException(v.message);

    // Label -> the integer the column stores. An unrecognised label is already
    // refused by validateSupplierQuote; null here means "not supplied", which
    // is different from "supplied and unparseable".
    const lead = body?.leadTime ? leadTimeDays(body.leadTime) : null;
    const warranty = body?.warranty ? warrantyMonths(body.warranty) : null;
    const paymentDays = body?.paymentTerms ? paymentTermsDays(body.paymentTerms) : null;

    const quotationInput: QuotationInput = {
      vendorId,
      // The prototype's form prices per line, and the headline total is
      // derived from them. Passing the client's stated total too lets
      // QuotationService refuse a total that disagrees with the sum, rather
      // than silently storing whichever number it liked.
      quoteMode: 'per_line',
      totalAmount: body?.totalAmount === undefined || body?.totalAmount === null
        ? undefined
        : Number(body.totalAmount),
      // QuotationInput distinguishes "not supplied" (undefined) from a value.
      // `?? undefined` keeps an omitted term omitted rather than writing a
      // null into a column that records "the supplier did not say".
      leadTimeDays: lead ?? undefined,
      warrantyMonths: warranty ?? undefined,
      paymentTerms: body?.paymentTerms ?? undefined,
      notes: body?.remarks ?? undefined,
      lines: lines.map(l => ({ rfqLineNo: l.lineNo, unitPrice: Number(l.unitPrice) })),
    };

    const result = await this.quotations.submitAsVendor({
      userId: user.id,
      role: user.role,
      costCenterIds: user.costCenterIds,
      expectedVendorId: vendorId,
      invitationId,
      body: quotationInput,
    });

    return {
      ...result,
      paymentTermsDays: paymentDays,
      // The prototype's reassurance, verbatim. It is also true here: the
      // revision chain is the audit trail.
      hint: 'Submission is recorded in the audit trail.',
    };
  }

  // ── POST /supplier/rfq/:invitationId/decline ─────────────────────────────
  /**
   * Decline the invitation, with the prototype's reason field.
   *
   * Declining while holding a LIVE quote is refused: the two states are
   * contradictory, and allowing it would leave the buyer counting a quote from
   * a vendor that has walked away. Withdraw the quote first.
   */
  async decline(user: AuthenticatedUser, invitationId: string, reason?: string) {
    const vendorId = this.requireVendor(user);

    return this.db.withTransaction(
      { userId: user.id, role: user.role, costCenterIds: user.costCenterIds, bypassRls: true },
      async (run) => {
        const r = await run<any>(
          `SELECT i.id, i.declined, i.submitted, rf.id AS rfq_id, rf.state AS rfq_state
             FROM proc.rfq_invitations i
             JOIN proc.rfq rf ON rf.id = i.rfq_id
            WHERE i.id = $1::uuid AND i.vendor_id = $2::uuid`,
          [invitationId, vendorId],
        );
        if (r.rows.length === 0) throw new NotFoundException('invitation not found');
        const inv = r.rows[0];

        if (inv.rfq_state !== 'Open') {
          throw new BadRequestException(`RFQ is ${inv.rfq_state} - it can no longer be declined`);
        }

        // Idempotent: a second click reports the existing state rather than
        // erroring, so a double-tapped button is not a support ticket.
        if (inv.declined === true) {
          return { invitationId, declined: true, alreadyDeclined: true, reason: null };
        }

        const live = await run<any>(
          `SELECT id, version FROM proc.quotations
            WHERE rfq_id = $1::uuid AND vendor_id = $2::uuid AND state = 'Submitted'
            LIMIT 1`,
          [inv.rfq_id, vendorId],
        );
        if (live.rows.length > 0) {
          throw new BadRequestException(
            `you still have a live quote (V${live.rows[0].version}) on this RFQ - ` +
            `withdraw it before declining the invitation`,
          );
        }

        const upd = await run<any>(
          `UPDATE proc.rfq_invitations
              SET declined = true,
                  declined_reason = $2,
                  submitted = false
            WHERE id = $1::uuid AND declined = false
          RETURNING id, declined, declined_reason`,
          [invitationId, reason ?? null],
        );
        // RETURNING is load-bearing: through the CSV psql bridge a statement
        // with no RETURNING emits no rows, so rowCount would be 0 even on a
        // successful write.
        if (upd.rowCount === 0) {
          throw new BadRequestException('the invitation changed while you were declining it - reload and try again');
        }

        return {
          invitationId,
          declined: true,
          alreadyDeclined: false,
          reason: reason ?? null,
        };
      },
    );
  }

  // ── internals ───────────────────────────────────────────────────────────
  private requireVendor(user: AuthenticatedUser): string {
    if (!user.vendorId) {
      // SupplierGuard already refuses this; the service refuses too so the
      // rule holds even if a future caller reaches the service directly.
      throw new ForbiddenException('This supplier account is not linked to a vendor record.');
    }
    return user.vendorId;
  }
}
