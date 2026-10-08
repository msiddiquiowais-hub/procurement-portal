import { createHash } from 'crypto';
import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { DbService, type SessionContext } from '../db/db.service';
import { roleAllowed } from '@procurement/roles';

type Ctx = SessionContext;

export type QuotationLineInput = {
  /** Must match proc.rfq_lines.line_no on the RFQ (1-based). */
  rfqLineNo: number;
  unitPrice: number;
  /** The prototype's per-line "declined" checkbox: TRUE = will not supply. */
  declined?: boolean;
  remarks?: string;
};

export type QuotationInput = {
  vendorId: string;
  /**
   * The prototype's entry mode (lightProcReceiveQuote's mode selector).
   * 'total'      — one grand-total figure
   * 'per_line'   — priced against each RFQ line
   * Audit-relevant: it records HOW the number was derived.
   */
  quoteMode?: 'total' | 'per_line';
  /** The vendor's grand total. Required for quoteMode 'total'. */
  totalAmount?: number;
  subtotal?: number;
  taxPercent?: number;
  taxAmount?: number;
  freight?: number;
  currency?: string;
  fxRate?: number;
  leadTimeDays?: number;
  warrantyMonths?: number;
  validityDays?: number;
  taxesIncluded?: boolean;
  paymentTerms?: string;
  notes?: string;
  lines?: QuotationLineInput[];
};

/** Prototype quote version states, mapped onto the DB vocabulary (Q1). */
export const QUOTE_STATE = {
  /** The prototype's ACTIVE. */
  ACTIVE: 'Submitted',
  /** Identical in both. */
  SUPERSEDED: 'Superseded',
  /** The prototype's VOID. */
  VOID: 'Withdrawn',
  AWARDED: 'Awarded',
  REJECTED: 'Rejected',
} as const;

/**
 * The prototype's three-word vocabulary, for the version chip. The plan keeps
 * the DB vocabulary in storage and maps these words in the UI only, because
 * this label is user-facing text the prototype specifies.
 */
export const PROTOTYPE_QUOTE_STATE: Record<string, string> = {
  Submitted: 'ACTIVE',
  Superseded: 'SUPERSEDED',
  Withdrawn: 'VOID',
  Awarded: 'AWARDED',
  Rejected: 'REJECTED',
};

@Injectable()
export class QuotationService {
  constructor(private readonly db: DbService) {}

  // ── POST /rfq/:id/quotations ────────────────────────────────────────────
  /**
   * Record a quote as V1. Port of lightProcReceiveQuote /
   * lightProcRecordQuotes, both of which are PROCUREMENT-ONLY
   * ("Only Procurement can receive quotes.").
   *
   * A vendor submitting its own quote through the supplier portal (Wave 4)
   * is a separate, token-authenticated path. Until then the only writer is
   * procurement, exactly as in the prototype.
   *
   * The vendor must be on the RFQ's roster. A vendor that is not invited has
   * no invitation row, so there is nothing to attach the quote to and no
   * `submitted` flag to flip.
   */
  async record(
    rfqId: string,
    userId: string,
    role: string,
    costCenterIds: string[],
    body: QuotationInput,
  ) {
    if (!roleAllowed(role, 'procurement')) {
      throw new ForbiddenException('Only Procurement can receive quotes.');
    }
    if (!body?.vendorId) throw new BadRequestException('vendorId is required');

    return this.db.withTransaction({ userId, role, costCenterIds }, async (run) => {
      const rfq = await this.requireOpenRfq(run, rfqId);
      const invite = await this.requireInvitation(run, rfqId, body.vendorId);
      return this.appendVersion(run, {
        rfqId,
        rfqCurrency: rfq.currency,
        vendorId: body.vendorId,
        userId,
        body,
        invitationId: invite.id,
        // Procurement revises through POST /quotations/:id/supersede, so
        // record() must NOT silently supersede for them. Behaviour unchanged.
        revise: false,
      });
    });
  }

  // ── extracted from record() ──────────────────────────────────────────────
  /**
   * THE single implementation of "one vendor, one live quote per RFQ, and how a
   * new one is appended". Both writers go through it: procurement's record()
   * and, from Wave 4, the supplier's own submit. That is R4 in
   * WAVE4_PLAN.md — a second implementation of append-only quoting is a second
   * set of bugs.
   *
   * `revise: false` keeps record()'s original refusal (a second live quote is
   * a caller error; use /supersede). `revise: true` is the supplier path, where
   * re-submitting IS the revision and must not be a dead end.
   */
  private async appendVersion(
    run: <U = any>(sql: string, params?: any[]) => Promise<{ rows: U[]; rowCount: number }>,
    args: {
      rfqId: string;
      rfqCurrency: string;
      vendorId: string;
      userId: string;
      body: QuotationInput;
      invitationId: string;
      revise: boolean;
    },
  ) {
    const { rfqId, vendorId, userId, body, invitationId, revise } = args;

    // Already holding a live version -> this is a revision, not a new quote.
    // Which vendor this write is FOR comes from the caller, never from the
    // request body: submitAsVendor copies the same id onto the body, but
    // depending on that would make the scoping a convention, not a rule.
    // Highest version wins if two live rows somehow exist, since the newest
    // is the one the supplier last submitted.
    const live = await run<any>(
      `SELECT id, version FROM proc.quotations
        WHERE rfq_id = $1::uuid AND vendor_id = $2::uuid AND state = 'Submitted'
        ORDER BY version DESC
        LIMIT 1`,
      [rfqId, vendorId],
    );
    if (live.rows.length > 0 && !revise) {
      throw new BadRequestException(
        `${'this vendor'} already has a live quote (V${live.rows[0].version}) on this RFQ — ` +
        `POST /quotations/${live.rows[0].id}/supersede to revise it`,
      );
    }

    const priorVersions = await run<any>(
      `SELECT max(version) AS v FROM proc.quotations
        WHERE rfq_id = $1::uuid AND vendor_id = $2::uuid`,
      [rfqId, vendorId],
    );
    const prior = priorVersions.rows[0]?.v === null || priorVersions.rows[0]?.v === undefined
      ? 0
      : Number(priorVersions.rows[0].v);
    // A withdrawn quote may be replaced outright; otherwise this continues
    // the chain. Both are append-only: the prior row is never rewritten.
    const version = prior === 0 ? 1 : prior + 1;

    // Retire the prior live version BEFORE inserting the new one. Without
    // this the vendor would hold TWO 'Submitted' quotes and the roster card
    // would render two "Quote received" rows for one invitation.
    //
    // This is the ONLY mutation a prior version ever receives: its state.
    // Its price is never touched.
    if (live.rows.length > 0) {
      const sup = await run<any>(
        `UPDATE proc.quotations
            SET state = 'Superseded'
          WHERE id = $1::uuid AND state = 'Submitted'
        RETURNING id`,
        [live.rows[0].id],
      );
      if (sup.rowCount === 0) {
        throw new BadRequestException('the quote changed while you were revising it - reload and try again');
      }
    }

    // DbService.withTransaction wraps EVERY statement in its own
    // BEGIN/COMMIT, so this is not atomic. If the insert fails after the
    // retire above, the vendor is left with NO live quote at all - worse
    // than a stale one. Put the prior back before rethrowing.
    let q: any;
    try {
      q = await this.insertQuotation(run, {
        rfqId,
        vendorId,
        version,
        supersedesQuotationId: live.rows.length > 0 ? live.rows[0].id : null,
        userId,
        body,
        currencyFallback: args.rfqCurrency,
      });
    } catch (e) {
      if (live.rows.length > 0) {
        try {
          await run(
            `UPDATE proc.quotations SET state = 'Submitted'
              WHERE id = $1::uuid AND state = 'Superseded'`,
            [live.rows[0].id],
          );
        } catch { /* surface the original failure, not the restore */ }
      }
      throw e;
    }

    // The roster card reads rfq_invitations.submitted for its "Received"
    // badge, so flip it on the same write.
    await run(
      `UPDATE proc.rfq_invitations
          SET submitted = true
        WHERE id = $1::uuid AND submitted = false`,
      [invitationId],
    );

    return {
      quotation: this.shape(q),
      version,
      isRevision: prior > 0,
      superseded: live.rows.length > 0
        ? { id: live.rows[0].id, version: Number(live.rows[0].version), state: 'Superseded' }
        : null,
      transition: live.rows.length > 0
        ? `V${Number(live.rows[0].version)} superseded by V${version}`
        : 'V1 submitted',
    };
}

  // ── POST /supplier/rfq/:invitationId/quote (Wave 4) ────────────────────────
  /**
   * The SUPPLIER's own submit/revise path, called by SupplierService — never
   * from a controller directly.
   *
   * Two things differ from record() and only two: the actor is the vendor
   * themselves, and the RFQ is addressed by INVITATION id resolved scoped to
   * that vendor. Every rule about the version chain is appendVersion().
   *
   * `expectedVendorId` is the session's own vendor, supplied by SupplierGuard
   * and never read from the request body. It is re-checked against the
   * invitation row here as defence in depth, so a future caller cannot write a
   * quote against someone else's vendor by putting a different id in the body.
   */
  async submitAsVendor(args: {
    userId: string;
    role: string;
    costCenterIds: string[];
    expectedVendorId: string;
    invitationId: string;
    body: QuotationInput;
  }) {
    const { userId, role, costCenterIds, expectedVendorId, invitationId, body } = args;

    return this.db.withTransaction({ userId, role, costCenterIds }, async (run) => {
      // Scoped lookup. A vendor probing another vendor's invitation id gets a
      // 404, not a 403 — a 403 would confirm the invitation exists.
      const inv = await run<any>(
        `SELECT i.id, i.rfq_id, i.vendor_id, i.submitted, i.declined,
                rf.state AS rfq_state, rf.currency AS rfq_currency
           FROM proc.rfq_invitations i
           JOIN proc.rfq rf ON rf.id = i.rfq_id
          WHERE i.id = $1::uuid AND i.vendor_id = $2::uuid`,
        [invitationId, expectedVendorId],
      );
      if (inv.rows.length === 0) throw new NotFoundException('invitation not found');
      const invitation = inv.rows[0];

      if (invitation.rfq_state !== 'Open') {
        throw new BadRequestException(`RFQ is ${invitation.rfq_state} - quotes can no longer be submitted`);
      }
      if (invitation.declined) {
        throw new BadRequestException('you declined this invitation');
      }
      if (body?.vendorId && body.vendorId !== expectedVendorId) {
        throw new BadRequestException('a supplier may only submit their own quote');
      }

      return this.appendVersion(run, {
        rfqId: invitation.rfq_id,
        rfqCurrency: invitation.rfq_currency,
        vendorId: expectedVendorId,
        userId,
        body: { ...body, vendorId: expectedVendorId },
        invitationId: invitation.id,
        // Re-submitting from the supplier portal IS the revision. Refusing it
        // the way record() does would strand a vendor who genuinely wants to
        // change their price, with no /supersede available to them.
        revise: true,
      });
    });
  }

  // ── POST /quotations/:id/supersede ───────────────────────────────────────
  /**
   * Mint the next version. Port of _lightAppendQuoteVersion(action:
   * 'new_revision'): the prior ACTIVE version becomes SUPERSEDED and a new
   * ACTIVE version is appended with version = prior + 1.
   *
   * APPEND-ONLY, PER THE PLAN'S DEFINITION OF DONE: no UPDATE ever rewrites a
   * prior version's price. The prior row's only mutation is its state flipping
   * to 'Superseded' — the money it recorded is never touched.
   *
   * NOTE A DELIBERATE DIVERGENCE. The prototype also offers 'update', which
   * overwrites the active version IN PLACE (Object.assign on the existing
   * version object) and appends an 'UPDATED_IN_PLACE' audit row. We do not
   * port that. The prototype already locks the in-place option in the rework
   * case (v2.0.x-audit-rules) and forces "Save as new revision"; making
   * append-only unconditional is the same audit-safe reading applied
   * consistently, and it is what the plan committed to.
   */
  async supersede(
    quotationId: string,
    userId: string,
    role: string,
    costCenterIds: string[],
    body: QuotationInput,
    reason?: string,
  ) {
    if (!roleAllowed(role, 'procurement')) {
      throw new ForbiddenException('Only Procurement can receive quotes.');
    }

    return this.db.withTransaction({ userId, role, costCenterIds }, async (run) => {
      const prior = await run<any>(
        `SELECT q.id, q.rfq_id, q.vendor_id, q.version, q.state, q.currency,
                rf.state AS rfq_state, rf.currency AS rfq_currency
           FROM proc.quotations q
           JOIN proc.rfq rf ON rf.id = q.rfq_id
          WHERE q.id = $1::uuid`,
        [quotationId],
      );
      if (prior.rows.length === 0) throw new NotFoundException('quotation not found');
      const p = prior.rows[0];

      if (p.state !== QUOTE_STATE.ACTIVE) {
        throw new BadRequestException(
          `only a live quote can be revised — V${p.version} is ${p.state}`,
        );
      }
      if (p.rfq_state !== 'Open') {
        throw new BadRequestException(
          `RFQ is ${p.rfq_state} — quotes can no longer be revised`,
        );
      }
      // The vendor comes from the prior version, not the body: a revision is
      // by definition the same vendor's quote.
      if (body?.vendorId && body.vendorId !== p.vendor_id) {
        throw new BadRequestException(
          'a revision must stay with the same vendor — record a new quote instead',
        );
      }

      // 1 · the ONLY mutation the prior version ever receives.
      const sup = await run<any>(
        `UPDATE proc.quotations
            SET state = 'Superseded'
          WHERE id = $1::uuid AND state = 'Submitted'
        RETURNING id, version, state`,
        [quotationId],
      );
      if (sup.rowCount === 0) {
        throw new BadRequestException('the quote changed while you were revising it — reload and try again');
      }

      // 2 · append the new version.
      // Same non-atomic-bridge caveat as insertQuotation: the mark-Superseded
      // above has already committed. If the new version cannot be written the
      // vendor would be left with NO live quote at all, so put the prior one
      // back before rethrowing.
      let next: any;
      try {
        next = await this.insertQuotation(run, {
          rfqId: p.rfq_id,
          vendorId: p.vendor_id,
          version: Number(p.version) + 1,
          supersedesQuotationId: p.id,
          userId,
          body: { ...body, vendorId: p.vendor_id },
          currencyFallback: p.rfq_currency || p.currency,
        });
      } catch (e) {
        try {
          await run(
            `UPDATE proc.quotations SET state = 'Submitted'
              WHERE id = $1::uuid AND state = 'Superseded'`,
            [p.id],
          );
        } catch { /* surface the original failure, not the restore */ }
        throw e;
      }

      return {
        superseded: { id: p.id, version: Number(p.version), state: 'Superseded' },
        quotation: this.shape(next),
        // The prototype's auditTrail note for this transition.
        transition: `V${p.version} superseded by V${Number(p.version) + 1}` +
          (reason ? ` — ${reason}` : ''),
      };
    });
  }

  // ── POST /quotations/:id/withdraw ────────────────────────────────────────
  /**
   * Withdraw a live quote. This is the prototype's VOID, stored under the DB's
   * 'Withdrawn'. A withdrawn version's numbers are frozen exactly like a
   * superseded one's — the state changes, the money does not.
   */
  async withdraw(
    quotationId: string,
    userId: string,
    role: string,
    costCenterIds: string[],
    reason?: string,
  ) {
    if (!roleAllowed(role, 'procurement')) {
      throw new ForbiddenException('Only Procurement can withdraw quotes.');
    }

    return this.db.withTransaction({ userId, role, costCenterIds }, async (run) => {
      const r = await run<any>(
        `SELECT id, version, state, vendor_id FROM proc.quotations WHERE id = $1::uuid`,
        [quotationId],
      );
      if (r.rows.length === 0) throw new NotFoundException('quotation not found');
      const q = r.rows[0];
      if (q.state !== QUOTE_STATE.ACTIVE) {
        throw new BadRequestException(`only a live quote can be withdrawn — V${q.version} is ${q.state}`);
      }

      const w = await run<any>(
        `UPDATE proc.quotations
            SET state = 'Withdrawn'
          WHERE id = $1::uuid AND state = 'Submitted'
        RETURNING id, version, state`,
        [quotationId],
      );
      if (w.rowCount === 0) {
        throw new BadRequestException('the quote changed while you were withdrawing it — reload and try again');
      }

      // The roster badge must fall back to "Awaiting quote" again.
      await run(
        `UPDATE proc.rfq_invitations i
            SET submitted = false
           FROM proc.quotations q
          WHERE q.id = $1::uuid AND i.rfq_id = q.rfq_id AND i.vendor_id = q.vendor_id`,
        [quotationId],
      );

      return {
        quotation: { id: q.id, version: Number(q.version), state: 'Withdrawn' },
        prototype_state: PROTOTYPE_QUOTE_STATE['Withdrawn'],
        transition: `V${q.version} withdrawn` + (reason ? ` — ${reason}` : ''),
      };
    });
  }

  // ── GET /pr/:id/quotes ───────────────────────────────────────────────────
  /**
   * The Versions Panel payload: every version of every quote on the PR's RFQ,
   * grouped by vendor, newest version last — the exact order
   * `_lightQuoteVersionsByVid` walks.
   *
   * The `active` pointer per vendor is what `_lightGetActiveQuoteVersion`
   * returns, and it is computed from the DB state rather than stored, so it
   * can never disagree with the rows it points at.
   */
  async forPr(prId: string, userId: string, role: string, costCenterIds: string[]) {
    const rfq = await this.db.query<any>(
      `SELECT rf.id, rf.rfq_number, rf.state, rf.currency
         FROM proc.rfq rf
        WHERE rf.pr_id = $1::uuid
        ORDER BY rf.created_at DESC LIMIT 1`,
      [prId],
      { userId, role, costCenterIds },
    );
    if (rfq.rows.length === 0) {
      return { rfq: null, vendors: [], totals: { received: 0, invited: 0, pending: 0 } };
    }
    const rf = rfq.rows[0];

    const rows = await this.db.query<any>(
      `SELECT q.id, q.vendor_id, q.version, q.state, q.total_amount, q.currency,
              q.fx_rate, q.normalized_total_pkr, q.lead_time_days, q.warranty_months,
              q.taxes_included, q.tax_breakdown, q.validity_days, q.submitted_at,
              q.supersedes_quotation_id, q.payment_terms, q.notes, q.quote_mode,
              q.sealed_hash, q.open_at,
              v.vendor_code, v.legal_name, v.state AS vendor_state,
              (SELECT count(*) FROM proc.quotation_lines ql WHERE ql.quotation_id = q.id) AS line_count
         FROM proc.quotations q
         JOIN core.vendors v ON v.id = q.vendor_id
        WHERE q.rfq_id = $1::uuid
        ORDER BY v.legal_name, q.version ASC`,
      [rf.id],
      { userId, role, costCenterIds },
    );

    const invited = await this.db.query<any>(
      `SELECT vendor_id FROM proc.rfq_invitations WHERE rfq_id = $1::uuid`,
      [rf.id],
      { userId, role, costCenterIds },
    );

    const byVendor = new Map<string, any>();
    for (const r of rows.rows) {
      if (!byVendor.has(r.vendor_id)) {
        byVendor.set(r.vendor_id, {
          vendor_id: r.vendor_id,
          vendor_code: r.vendor_code,
          vendor_name: r.legal_name,
          vendor_state: r.vendor_state,
          on_approved_roster: ['Active', 'Approved'].includes(r.vendor_state),
          versions: [],
          active: null,
        });
      }
      const shaped = this.shape(r);
      byVendor.get(r.vendor_id).versions.push(shaped);
    }

    // The active pointer is derived, never stored: the last version whose state
    // is 'Submitted' (or 'Awarded' — an awarded quote is still the live one).
    for (const v of byVendor.values()) {
      const live = [...v.versions]
        .reverse()
        .find((x: any) => x.state === QUOTE_STATE.ACTIVE || x.state === QUOTE_STATE.AWARDED);
      v.active = live ?? null;
    }

    const vendors = [...byVendor.values()];
    const received = vendors.filter((v: any) => v.active !== null).length;
    const total = invited.rows.length;

    return {
      rfq: {
        id: rf.id,
        rfq_number: rf.rfq_number,
        state: rf.state,
        currency: rf.currency,
      },
      vendors,
      // `_lightRosterCard`'s tally sentence.
      totals: {
        received,
        invited: total,
        pending: Math.max(0, total - received),
        text: `${received} of ${total} quote${total === 1 || received === 1 ? '' : 's'} received - ` +
          `${Math.max(0, total - received)} pending`,
      },
    };
  }

  // ── internals ───────────────────────────────────────────────────────────

  private async requireOpenRfq(
    run: <U = any>(sql: string, params?: any[]) => Promise<{ rows: U[]; rowCount: number }>,
    rfqId: string,
  ) {
    const r = await run<any>(
      `SELECT id, state, currency FROM proc.rfq WHERE id = $1::uuid`,
      [rfqId],
    );
    if (r.rows.length === 0) throw new NotFoundException('RFQ not found');
    if (r.rows[0].state !== 'Open') {
      throw new BadRequestException(`RFQ is ${r.rows[0].state} — it is no longer accepting quotes`);
    }
    return r.rows[0];
  }

  private async requireInvitation(
    run: <U = any>(sql: string, params?: any[]) => Promise<{ rows: U[]; rowCount: number }>,
    rfqId: string,
    vendorId: string,
  ) {
    const r = await run<any>(
      `SELECT id, submitted, declined FROM proc.rfq_invitations
        WHERE rfq_id = $1::uuid AND vendor_id = $2::uuid`,
      [rfqId, vendorId],
    );
    if (r.rows.length === 0) {
      throw new BadRequestException(
        'this vendor is not on the RFQ roster — invite them first (POST /rfq/:id/invite)',
      );
    }
    if (r.rows[0].declined) {
      throw new BadRequestException('this vendor declined the invitation');
    }
    return r.rows[0];
  }

  /**
   * Insert one quotation version plus its per-line rows.
   *
   * The five NOT NULL columns the prototype never shows (found in step 0) are
   * all supplied here, and two of them honour decision Q2 explicitly:
   *
   *   open_at      = now()  — quotes are visible immediately. Never read to
   *                           gate visibility. There is no waiting period.
   *   sealed_hash  = a REAL sha256 over the payload, not a placeholder. It is
   *                           still INERT: nothing reads it, because sealed
   *                           bidding was deliberately not implemented (Q2).
   *                           A real digest means if sealing is ever restored
   *                           there is no migration to backfill.
   */
  private async insertQuotation(
    run: <U = any>(sql: string, params?: any[]) => Promise<{ rows: U[]; rowCount: number }>,
    args: {
      rfqId: string;
      vendorId: string;
      version: number;
      supersedesQuotationId: string | null;
      userId: string;
      body: QuotationInput;
      currencyFallback: string;
    },
  ) {
    const { rfqId, vendorId, version, supersedesQuotationId, userId, body, currencyFallback } = args;

    const mode = body.quoteMode || (body.lines?.length ? 'per_line' : 'total');
    const currency = (body.currency || currencyFallback || 'PKR').trim();
    const fxRate = body.fxRate === undefined || body.fxRate === null ? 1 : Number(body.fxRate);
    if (!(fxRate > 0)) throw new BadRequestException('fxRate must be greater than zero');

    // Resolve the RFQ's lines up front. proc.quotation_lines stores no qty, so
    // the line total has to be unit_price x rfq_lines.quantity — and a line
    // number that is not on the RFQ is a caller error we can name, rather
    // than a raw foreign-key violation surfacing as an opaque 500.
    const rfqLines = await this.loadRfqLines(run, rfqId);
    const qtyBy = new Map<number, number>(
      rfqLines.map((l: any) => [Number(l.line_no), Number(l.quantity)]),
    );

    const priced = (body.lines || []).map((l) => {
      const no = Number(l.rfqLineNo);
      if (!qtyBy.has(no)) {
        throw new BadRequestException(
          `line ${no} is not on this RFQ (the RFQ has lines ${[...qtyBy.keys()].join(', ') || 'none'})`,
        );
      }
      const unit = Number(l.unitPrice || 0);
      if (!(unit >= 0)) throw new BadRequestException(`line ${no}: unitPrice must not be negative`);
      const declined = l.declined === true;
      // A declined line contributes NOTHING — it is not a zero-priced line.
      // The prototype's per-line table has a declined checkbox precisely so a
      // vendor can decline one line without implying they quoted it for free.
      const totalPrice = declined ? 0 : Math.round(unit * qtyBy.get(no)! * 100) / 100;
      return { no, unit, declined, totalPrice, remarks: l.remarks ?? null };
    });

    // The grand total: stated for 'total', summed from the lines for
    // 'per_line'. The two must not silently disagree, so when both are
    // supplied we keep the vendor's stated figure and refuse a mismatch.
    let total = body.totalAmount;
    if (mode === 'per_line') {
      const live = priced.filter((l) => !l.declined);
      if (live.length === 0) {
        throw new BadRequestException('a per-line quote needs at least one priced line');
      }
      const summed = Math.round(live.reduce((s, l) => s + l.totalPrice, 0) * 100) / 100;
      if (total === undefined || total === null) {
        total = summed;
      } else if (Math.abs(Number(total) - summed) > 0.01) {
        throw new BadRequestException(
          `totalAmount ${Number(total)} does not match the sum of the priced lines ${summed.toFixed(2)}`,
        );
      }
    }
    if (total === undefined || total === null) {
      throw new BadRequestException('totalAmount is required for a grand-total quote');
    }
    const totalAmount = Number(total);
    if (!(totalAmount >= 0)) throw new BadRequestException('totalAmount must not be negative');

    const taxBreakdown = this.buildTaxBreakdown(body, totalAmount);

    const ins = await run<any>(
      `INSERT INTO proc.quotations
         (rfq_id, vendor_id, submitted_by_user_id, submitted_at, total_amount, currency,
          fx_rate, normalized_total_pkr, state, version, supersedes_quotation_id,
          lead_time_days, warranty_months, taxes_included, tax_breakdown, validity_days,
          payment_terms, notes, quote_mode,
          sealed_hash, open_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, now(), $4, $5,
               $6, $7, 'Submitted', $8, $9::uuid,
               $10, $11, $12, $13::jsonb, $14,
               $15, $16, $17,
               $18, now())
       RETURNING id, version, state, total_amount, currency, fx_rate,
                 normalized_total_pkr, submitted_at, quote_mode,
                 -- Must be returned: the response is the client's only view of
                 -- the version chain, and a response that omits it claims the
                 -- version is unlinked even though the row links it.
                 supersedes_quotation_id,
                 -- Also returned, and the reason is the supplier portal: a
                 -- vendor who just chose "3 yr" and "60 days" needs the values
                 -- echoed back to confirm what was recorded. Omitting them made
                 -- a successful submit look like the terms had been dropped.
                 lead_time_days, warranty_months, payment_terms, notes, taxes_included, validity_days`,
      [
        rfqId, vendorId, userId, totalAmount, currency,
        fxRate, Math.round(totalAmount * fxRate * 100) / 100, version, supersedesQuotationId,
        body.leadTimeDays ?? null, body.warrantyMonths ?? null,
        body.taxesIncluded === true, JSON.stringify(taxBreakdown), body.validityDays ?? null,
        body.paymentTerms ?? null, body.notes ?? null, mode,
        this.inertSealHash(rfqId, vendorId, version, totalAmount, currency),
      ],
    );
    const q = ins.rows[0];

    // COMPENSATING DELETE. DbService.withTransaction wraps EVERY statement in
    // its own BEGIN/COMMIT, so this is not atomic in the strict DB sense (the
    // class docstring says as much). Without the rollback below, a failure on
    // the Nth line would leave a committed V1 with only N-1 lines and no way
    // to retry — the next POST would hit "already has a live quote" and the
    // vendor would be permanently stuck. Deleting the header restores the
    // pre-call state, which is what a real transaction would have done.
    try {
      for (const l of priced) {
        const lr = await run(
          `INSERT INTO proc.quotation_lines
             (quotation_id, rfq_id, rfq_line_no, unit_price, total_price, declined, remarks)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
           RETURNING 1`,
          [q.id, rfqId, l.no, l.unit, l.totalPrice, l.declined, l.remarks],
        );
        // RETURNING is load-bearing: through the CSV psql bridge a statement
        // with no RETURNING emits no rows, so rowCount would be 0 even on a
        // successful insert and this guard would reject a good write.
        if (lr.rowCount === 0) throw new BadRequestException('could not record a quotation line');
      }
    } catch (e) {
      // ON DELETE CASCADE clears the lines that did land.
      try {
        await run(`DELETE FROM proc.quotations WHERE id = $1::uuid`, [q.id]);
      } catch { /* the original error is the one worth surfacing */ }
      throw e;
    }

    return q;
  }

  /** The RFQ's lines, used to validate line numbers and source the quantities. */
  private async loadRfqLines(
    run: <U = any>(sql: string, params?: any[]) => Promise<{ rows: U[]; rowCount: number }>,
    rfqId: string,
  ) {
    const r = await run<any>(
      `SELECT line_no, quantity, uom, description FROM proc.rfq_lines
        WHERE rfq_id = $1::uuid ORDER BY line_no`,
      [rfqId],
    );
    return r.rows;
  }

  /**
   * The prototype's tax model, kept as one jsonb so the components survive even
   * when the vendor overrode the computed figure — both the rate and the
   * amount are stored, so a later audit can show what was charged even if the
   * amount does not equal rate x subtotal.
   */
  private buildTaxBreakdown(body: QuotationInput, totalAmount: number) {
    const subtotal = body.subtotal === undefined || body.subtotal === null ? totalAmount : Number(body.subtotal);
    const taxPercent = Number(body.taxPercent || 0);
    const computed = Math.round((subtotal * taxPercent) / 100 * 100) / 100;
    const taxAmount = body.taxAmount === undefined || body.taxAmount === null ? computed : Number(body.taxAmount);
    const freight = Number(body.freight || 0);
    return {
      subtotal,
      tax_percent: taxPercent,
      tax_amount: taxAmount,
      freight,
      // Grand total = subtotal + tax + freight. `quoted` records what the
      // vendor actually stated, so a discrepancy is visible rather than lost.
      computed_grand_total: Math.round((subtotal + taxAmount + freight) * 100) / 100,
      quoted_grand_total: totalAmount,
      taxes_included: body.taxesIncluded === true,
    };
  }

  /**
   * A real SHA-256 over the version's identifying tuple, stored because
   * `sealed_hash` is NOT NULL — and deliberately never read. Decision Q2
   * removed sealed bidding: quotes are visible the moment they are submitted,
   * and no deadline, timer or open_at gate exists. The digest is here so the
   * NOT NULL column holds something honest rather than a placeholder, and so
   * restoring sealing later needs no backfill.
   */
  private inertSealHash(rfqId: string, vendorId: string, version: number, total: number, currency: string) {
    return createHash('sha256')
      .update(`${rfqId}|${vendorId}|${version}|${total}|${currency}`)
      .digest('hex');
  }

  private shape(q: any) {
    if (!q) return q;
    return {
      id: q.id,
      vendor_id: q.vendor_id ?? null,
      vendor_code: q.vendor_code ?? null,
      vendor_name: q.legal_name ?? null,
      version: q.version === undefined ? null : Number(q.version),
      state: q.state,
      // The prototype's own word, for the version chip.
      prototype_state: PROTOTYPE_QUOTE_STATE[q.state] ?? q.state,
      total_amount: q.total_amount === undefined ? null : Number(q.total_amount),
      currency: q.currency,
      fx_rate: q.fx_rate === undefined ? null : Number(q.fx_rate),
      normalized_total_pkr: q.normalized_total_pkr === undefined ? null : Number(q.normalized_total_pkr),
      lead_time_days: q.lead_time_days ?? null,
      warranty_months: q.warranty_months ?? null,
      taxes_included: q.taxes_included ?? null,
      tax_breakdown: q.tax_breakdown ?? null,
      validity_days: q.validity_days ?? null,
      payment_terms: q.payment_terms ?? null,
      notes: q.notes ?? null,
      quote_mode: q.quote_mode ?? null,
      submitted_at: q.submitted_at ?? null,
      supersedes_quotation_id: q.supersedes_quotation_id ?? null,
      line_count: q.line_count === undefined ? null : Number(q.line_count),
    };
  }
}
