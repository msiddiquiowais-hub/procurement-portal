import { createHash } from 'crypto';
import { Injectable, NotFoundException, BadRequestException, ForbiddenException, ConflictException } from '@nestjs/common';
import { DbService, type SessionContext } from '../db/db.service';
import { pgIntArray } from '../db/pg-array';
import { roleAllowed } from '@procurement/roles';
import { RFQ_SOURCING_STAGES } from './rfq.service';

type Ctx = SessionContext;

/**
 * A Postgres int array as a number[], whichever shape the driver hands back.
 *
 * `array_agg` over an `integer` column normally arrives already parsed, but a
 * text[] or a raw `{}`-wrapped string must not silently become `[]` — that reads
 * as "this vendor was invited for no lines", which locks the whole grid and
 * looks like a bug rather than a parse.
 *
 * Now `pgIntArray` from `db/pg-array.ts`, which is the one owner of this parse.
 * The copy that used to live here had a latent trap: `'{}'` parsed to `[0]`,
 * because `Number('')` is 0 — a phantom line 0 for a vendor who quoted nothing.
 * `array_agg` over no rows returns NULL rather than `{}`, so that was never
 * reached in practice, but it was one stray value away from a wrong answer.
 */

/** True for a yyyy-mm-dd that is today or later, in the SERVER's local day. */
function isTodayOrLater(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  return iso >= today;
}

/**
 * Money to 2 decimal places, half-up.
 *
 * Used for EVERY line amount before any of them are summed. The alternative —
 * summing exact fractions and rounding once at the end — produces a printed
 * grand total that does not equal the sum of the printed line totals, which is
 * the discrepancy tax authorities treat as a defect on a tax document.
 *
 * `+(v).toFixed(2)` rather than `Math.round(v * 100) / 100`: the latter
 * returns 10390.624999999999 for values like 10390.625 because of binary
 * floating point, and that residue can push a 2dp figure the wrong way.
 */
export const round2 = (v: number) => Math.round(Number((v + Number.EPSILON).toFixed(2)) * 100) / 100;

export type Waterfall = {
  /** qty x unit — the amount as quoted, before discount. */
  gross: number;
  discountPercent: number;
  discount: number;
  /**
   * The taxable base. This is the column the form shows as "Net Amt", and it is
   * ALWAYS pre-tax — including when the quoted price includes tax. See
   * quoteLineWaterfall for why that distinction is the whole point.
   */
  net: number;
  taxPercent: number;
  /** The tax ACTUALLY charged on this line. Never a figure that was not charged. */
  tax: number;
  /** What this line contributes to quotations.total_amount. === net + tax, always. */
  lineTotal: number;
};

export type WaterfallInput = {
  unit: number;
  qty: number;
  discountPercent: number;
  taxPercent: number;
  /** TRUE = the typed rate already contains the tax. */
  taxesIncluded: boolean;
  basis: 'before_tax' | 'after_tax';
};

/**
 * The per-line pricing waterfall — the single authority for how a quotation line
 * becomes money.
 *
 * THREE CASES, three identities. The identity is different in each, and the
 * GRID COLUMN ORDER plus its heading is what tells you which you are reading.
 *
 *   before tax  gross = qty x unit
 *               discount = gross x disc%
 *               net      = gross - discount      <- the TAXABLE BASE
 *               tax      = net x tax%
 *               total    = net + tax            => Total = Net + Tax
 *
 *   after  tax  gross = qty x unit
 *               tax      = gross x tax%
 *               net      = gross + tax          <- "Inc Tax Amt"
 *               discount = net x disc%          <- off the tax-inclusive figure
 *               total    = net - discount       => Total = Inc Tax Amt - Disc
 *
 *   inclusive   gross = qty x unit
 *               discount = gross x disc%
 *               quoted   = gross - discount      <- ALREADY contains the tax
 *               tax      = quoted - quoted/(1+r)  EXTRACTED, not added
 *               net      = quoted - tax          <- the base
 *               total    = net + tax             => Total = Net + Tax
 *
 * Both exclusive bases reduce to gross x (1 + tax%) x (1 - discount%), so the
 * amount payable does NOT depend on which side the officer read the discount
 * from. What the basis changes is the SPLIT: before-tax bills 324.00 of tax on a
 * 1,800.00 base with a 200.00 discount; after-tax bills 360.00 of tax on a
 * 2,360.00 base with a 236.00 discount. Both total 2,124.00. That matters for
 * remittance and for the discount the vendor actually granted, which is exactly
 * why the toggle exists.
 *
 * `net` is the middle column and MEANS DIFFERENT THINGS IN THE THREE CASES —
 * taxable base, tax-inclusive gross, and extracted base respectively. It is one
 * column of the grid, so it is one stored field (`quotation_lines.net_amount`)
 * with the order and the heading carrying which reading applies. Do not consume
 * it without `discount_basis`; ranking a comparative statement on
 * `net_amount` alone would mix three different quantities.
 *
 * THE TAX-INCLUSIVE BUG THIS FUNCTION USED TO HAVE.
 *
 * The old inclusive path computed `tax = net x taxPercent/100` and then
 * `lineTotal = net` — i.e. it kept the tax-EXCLUSIVE rate beside a total that
 * never included it. For a 118.00 line at 18% that printed 21.24 as the tax
 * when the tax genuinely embedded in 118.00 is 18.00. So the form overstated the
 * tax by 3.24 and displayed a charge that was never applied: 118 + 21.24 = 139.24
 * on screen, 118.00 in the bank. That is the miscalculation, not the absence of
 * double-stacking — the total was already correct, the TAX COLUMN was not.
 *
 * For an inclusive price the two identities cannot both hold, because the tax is
 * inside the quoted figure:
 *     total = net + tax          ALWAYS holds (this is the one we guarantee)
 *     net   = gross - discount   holds only when tax is excluded
 * So `net` is the taxable base rather than "gross minus discount", which is what
 * keeps the guarantee true. An inclusive line reads
 * Gross 118.00 | Disc 0.00 | Net 100.00 | Tax 18.00 | Total 118.00: the
 * tax column reconciles the gap between the quoted and the taxable figures,
 * instead of contradicting the total.
 *
 * ROUNDING. `tax` is rounded first and `net` is then derived by SUBTRACTION from
 * the already-rounded quoted amount. Deriving them independently instead lets
 * binary floating point leave the printed Net and Tax columns a paisa apart, so
 * that Net + Tax no longer reproduces the printed Total — trading a wrong tax
 * for a subtler, harder-to-spot wrong identity. Computing the base as
 * `quoted/(1+r)` and the tax as its complement is the same figure; deriving one
 * from the other is what guarantees they add up.
 *
 * A taxPercent of 0 needs no special case: quoted/(1+0) === quoted, so tax is 0
 * and the line is identical in all three modes.
 *
 * `basis` is ignored when taxesIncluded is true. With a tax-inclusive rate there
 * is exactly one payable number, so the discount comes off the quoted amount
 * and the choice simply does not exist; the caller normalises it to
 * 'before_tax' before calling, so the stored discount_basis is truthful.
 */
export function quoteLineWaterfall(i: WaterfallInput): Waterfall {
  const gross = round2(i.unit * i.qty);

  // ── tax-inclusive ──────────────────────────────────────────────────────
  // The typed rate already contains the tax, so it is EXTRACTED, not added.
  if (i.taxesIncluded) {
    const discount = round2(gross * i.discountPercent / 100);
    const quoted = round2(gross - discount);
    const tax = round2(quoted - quoted / (1 + i.taxPercent / 100));
    const net = round2(quoted - tax);
    return {
      gross, discountPercent: i.discountPercent, discount, net,
      taxPercent: i.taxPercent, tax, lineTotal: round2(net + tax),
    };
  }

  // ── discount AFTER tax ─────────────────────────────────────────────────
  // The tax is charged on the FULL amount and the discount comes off the total
  // INCLUDING that tax. The middle column is therefore the gross *inclusive* of
  // tax — the grid labels it "Inc Tax Amt" — and it is what the discount is
  // taken from.
  //
  // Worked example, the one the officer reported as wrong:
  //     2 EA x 1000 = 2,000.00 gross, tax 18% = 360.00
  //     Inc Tax Amt = 2,000.00 + 360.00          = 2,360.00
  //     discount 10% of 2,360.00                  =   236.00
  //     total    = 2,360.00 - 236.00             = 2,124.00
  //
  // The version this replaces subtracted the discount from the GROSS (1,800)
  // and then added the tax, billing 2,160.00 — 36.00 more than the same quote
  // under the before-tax basis, for a total that should not depend on which
  // side the officer read the discount from. Both orders are now
  // gross x (1 + tax%) x (1 - discount%), so the bases agree on the amount
  // actually payable and differ only in how the tax and discount are split.
  if (i.basis === 'after_tax') {
    const tax = round2(gross * i.taxPercent / 100);
    const net = round2(gross + tax);
    const discount = round2(net * i.discountPercent / 100);
    return {
      gross, discountPercent: i.discountPercent, discount, net,
      taxPercent: i.taxPercent, tax, lineTotal: round2(net - discount),
    };
  }

  // ── discount BEFORE tax ────────────────────────────────────────────────
  // The discount shrinks the taxable base, and the tax is charged on what is
  // left. Worked example: 2,000.00 less 10% = 1,800.00 net, tax 18% = 324.00,
  // total 2,124.00 — the same payable figure, a different tax remittance.
  const discount = round2(gross * i.discountPercent / 100);
  const net = round2(gross - discount);
  const tax = round2(net * i.taxPercent / 100);
  return {
    gross, discountPercent: i.discountPercent, discount, net,
    taxPercent: i.taxPercent, tax, lineTotal: round2(net + tax),
  };
}

export type QuotationLineInput = {
  /** Must match proc.rfq_lines.line_no on the RFQ (1-based). */
  rfqLineNo: number;
  unitPrice: number;
  /** The prototype's per-line "declined" checkbox: TRUE = will not supply. */
  declined?: boolean;
  remarks?: string;
  /**
   * The AUTHORITATIVE per-line rates. Everything else on the line
   * (gross / discount / net / tax / line total) is derived server-side, so a
   * stored total can never disagree with the inputs that produced it.
   */
  discountPercent?: number;
  taxPercent?: number;
  /** Warranty for THIS item. Different items in one quote differ here. */
  warrantyMonths?: number;
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
  /**
   * core.files.id of the vendor's own quotation document, uploaded through
   * POST /pr/:id/attachments. Linked to THIS VERSION in
   * proc.quotation_attachments (migration 056), so a revision can carry a
   * different scan rather than inheriting the one that justified the price it
   * replaced.
   *
   * Required on the procurement Receive Quotation path; optional on the
   * supplier portal.
   */
  attachmentId?: string;
  /**
   * Set by the form only after the officer has answered YES to
   * "you are missing the attachment". Absent on a revision, the save is refused
   * with ATTACHMENT_CONFIRMATION_REQUIRED; present, the revision reason becomes
   * the mandatory record in its place.
   *
   * Deliberately server-enforced. If the browser simply stopped sending the
   * attachment the rule would be gone, and the audit trail would accept a price
   * change with no document and no stated reason.
   */
  allowMissingAttachment?: boolean;
  /** The expiry date the VENDOR stated, YYYY-MM-DD. Authoritative over validityDays. */
  validUntil?: string;
  /**
   * Whether a line discount shrinks the taxable base or is taken off after tax.
   * before_tax (default) — tax is computed on the discounted net.
   * after_tax          — tax is computed on the gross, discount comes off after.
   */
  discountBasis?: 'before_tax' | 'after_tax';
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
        // The Receive Quotation form's stricter rules (required terms +
        // required vendor document). The supplier portal deliberately does not
        // pass this — see appendVersion's `strictForm` comment.
        strictForm: true,
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
      /**
       * TRUE only for the procurement "Receive Quotation" form, which applies
       * STRICTER rules than the supplier portal:
       *
       *   * the vendor's own document must be attached, because the point of a
       *     procurement-recorded quotation is evidencing what the vendor
       *     actually sent;
       *   * lead time, validity date and payment terms must all be stated,
       *     because a quote missing them cannot be compared or awarded on.
       *
       * Deliberately NOT applied to the supplier portal: a vendor submitting
       * through their own portal uploads the file via a different endpoint, and
       * refusing their quote for a missing attachment would block the channel
       * that needs it least.
       */
      strictForm?: boolean;
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
        strictForm: args.strictForm,
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

  /**
   * Lines this vendor QUOTED on this quotation but can no longer price, because
   * their category mapping has since been removed.
   *
   * Strictly a write-time question, asked only when someone tries to append a
   * version. It is never used to filter, hide or invalidate anything already
   * stored: `forPr()` reports the same fact as `quotable_lines` purely so the
   * form can lock a row, and the rows themselves stay fully readable.
   *
   * The join is the same one `categoryPool()` uses to decide who gets invited,
   * so "who was invited for this line" and "who may price it now" cannot drift
   * into two different answers.
   */
  private async revokedQuotationLines(
    run: <U = any>(sql: string, params?: any[]) => Promise<{ rows: U[]; rowCount: number }>,
    rfqId: string,
    vendorId: string,
    quotationId: string,
  ): Promise<Array<{ line_no: number; category: string }>> {
    const r = await run<any>(
      `SELECT ql.rfq_line_no AS line_no, pl.category
         FROM proc.quotation_lines ql
         JOIN proc.rfq_lines rl ON rl.rfq_id = $1::uuid AND rl.line_no = ql.rfq_line_no
         JOIN proc.pr_lines pl ON pl.id = rl.pr_line_id
        WHERE ql.quotation_id = $2::uuid
          AND NOT EXISTS (
            SELECT 1 FROM core.vendor_categories vc
              JOIN core.categories c ON c.id = vc.category_id
             WHERE vc.vendor_id = $3::uuid AND vc.is_active AND c.code = pl.category
          )
        ORDER BY ql.rfq_line_no`,
      [rfqId, quotationId, vendorId],
    );
    return r.rows.map((x: any) => ({ line_no: Number(x.line_no), category: x.category }));
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
      // Same gate, same reason as `requireOpenRfq`, and it is called HERE
      // rather than relied upon there: a revision reaches this code through its
      // own path and never went through the shared helper. The `rfq_state`
      // check above covers CS_LOCKED and PACK_LOCKED, but an RFQ on a PR at
      // QUOTES_RECEIVED is still `Open`, so a revision could rewrite a vendor's
      // price AFTER the quotes were returned and BEFORE the comparative
      // statement is built — silently moving a number the award is about to be
      // decided on.
      await this.requireOpenRfq(run, p.rfq_id);
      // The vendor comes from the prior version, not the body: a revision is
      // by definition the same vendor's quote.
      if (body?.vendorId && body.vendorId !== p.vendor_id) {
        throw new BadRequestException(
          'a revision must stay with the same vendor — record a new quote instead',
        );
      }

      // MANAGEMENT REVOCATION — refuses a NEW write, changes no history.
      //
      // A vendor unmapped from a category keeps their recorded quotation
      // forever: it is never edited, never hidden, never re-scored against the
      // current mapping. What is refused here is the forward action — appending
      // a new version against a quotation whose line they may no longer price.
      //
      // Placed BEFORE the mark-Superseded UPDATE so a refusal is genuinely
      // side-effect free. After that statement the prior version is already
      // committed as 'Superseded' outside the caller's transaction, so a throw
      // further down would leave the vendor with no live quote at all.
      const revoked = await this.revokedQuotationLines(run, p.rfq_id, p.vendor_id, quotationId);
      if (revoked.length > 0) {
        const where = revoked.map((r) => `line ${r.line_no} (${r.category})`).join(', ');
        throw new BadRequestException(
          `This vendor has been removed from a category they had already quoted: ${where}. `
          + 'The recorded quotation stands as valid history, but no revision can be added to it. '
          + 'Ask Vendor Master to reactivate the mapping — there is no override here.',
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
          // The whole point of the column: the reason used to survive only as
          // text in the HTTP response, so the audit trail could show a price
          // changed but never why.
          revisionReason: reason ?? null,
          // A revision is an officer re-recording what the vendor sent, so the
          // same strict form rules apply — including its own document, which is
          // the point: V2 must not inherit V1's scan as its evidence.
          strictForm: true,
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
      return { rfq: null, vendors: [], totals: { received: 0, invited: 0, pending: 0 }, lines: [] };
    }
    const rf = rfq.rows[0];

    // The RFQ's OWN line descriptions.
    //
    // The Receive Quotation grid used to be fed from proc.pr_lines, whose
    // `description` is NULL for every catalogue line — the wording lives on
    // core.items.name, and rfq_lines carries the description that was actually
    // SENT to vendors. An officer pricing a quotation needs the line they are
    // answering, so this is read from the RFQ, not reconstructed from the PR.
    // Free-text lines have no catalogue item, so rfq_lines.description is their
    // own text and is the only place it exists.
    const rfqLines = await this.db.query<any>(
      `SELECT line_no, description, quantity, uom
         FROM proc.rfq_lines WHERE rfq_id = $1::uuid ORDER BY line_no`,
      [rf.id],
      { userId, role, costCenterIds },
    );

    const rows = await this.db.query<any>(
      `SELECT q.id, q.vendor_id, q.version, q.state, q.total_amount, q.currency,
              q.fx_rate, q.normalized_total_pkr, q.lead_time_days, q.warranty_months,
              q.taxes_included, q.tax_breakdown, q.validity_days, q.submitted_at,
              q.supersedes_quotation_id, q.payment_terms, q.notes, q.quote_mode,
              q.sealed_hash, q.open_at,
              v.vendor_code, v.legal_name, v.state AS vendor_state,
              (SELECT count(*) FROM proc.quotation_lines ql WHERE ql.quotation_id = q.id) AS line_count,
              -- WHICH lines this version priced, so the Receive Quotation form can
              -- tell "never invited for this category" apart from "quoted it, and
              -- has since been unmapped". Those need different words: the first is
              -- routine, the second is a management control that has locked a
              -- revision the officer used to be able to make.
              (SELECT array_agg(ql.rfq_line_no ORDER BY ql.rfq_line_no)
                 FROM proc.quotation_lines ql WHERE ql.quotation_id = q.id) AS line_nos
         FROM proc.quotations q
         JOIN core.vendors v ON v.id = q.vendor_id
        WHERE q.rfq_id = $1::uuid
        ORDER BY v.legal_name, q.version ASC`,
      [rf.id],
      { userId, role, costCenterIds },
    );

    // The ROSTER, not the quote history. This query exists because `vendors` used
    // to be assembled purely from `proc.quotations`, i.e. only from vendors who
    // had already quoted — so the very first quotation on an RFQ was impossible
    // to record. The picker listed nobody, `pending` had no candidate, and the
    // modal opened with an empty SELECT and a header claiming "0 Vendors on RFQ"
    // while the same payload's own `totals.invited` said 3. The officer's whole
    // task in this modal is to record a quote FROM someone, and that someone is
    // by definition not in the quote history yet.
    const invited = await this.db.query<any>(
      `SELECT i.vendor_id, v.vendor_code, v.legal_name, v.state AS vendor_state
         FROM proc.rfq_invitations i
         JOIN core.vendors v ON v.id = i.vendor_id
        WHERE i.rfq_id = $1::uuid
        ORDER BY v.legal_name`,
      [rf.id],
      { userId, role, costCenterIds },
    );

    const byVendor = new Map<string, any>();
    // WHICH LINES EACH VENDOR WAS ACTUALLY INVITED FOR.
    //
    // An invitation is issued per VENDOR, not per line, so `rfq_invitations`
    // alone cannot say what a given vendor was asked to price. The fact lives in
    // the category mapping: this vendor was invited because they are mapped to
    // one or more of the PR's line categories, so the lines they may quote are
    // exactly the lines whose category they are mapped to. That is the same join
    // `categoryPool()` uses to BUILD the invitation, so "what they were invited
    // for" and "what the form lets them price" cannot drift apart.
    //
    // `rfq_lines` carries no category — it is a snapshot of description/qty/uom
    // taken at issue — so the category is read live through `pr_line_id`. If a
    // line is re-categorised after the RFQ went out, coverage follows it, which
    // is the correct direction to be wrong in: it re-points at the mapping that
    // now governs the line rather than freezing a stale answer.
    const coverage = await this.db.query<any>(
      `SELECT i.vendor_id,
              array_agg(DISTINCT rl.line_no ORDER BY rl.line_no) AS line_nos
         FROM proc.rfq_invitations i
         JOIN proc.rfq_lines rl ON rl.rfq_id = i.rfq_id
         JOIN proc.pr_lines pl ON pl.id = rl.pr_line_id
         JOIN core.vendor_categories vc ON vc.vendor_id = i.vendor_id AND vc.is_active
         JOIN core.categories c ON c.id = vc.category_id AND c.code = pl.category
        WHERE i.rfq_id = $1::uuid
        GROUP BY i.vendor_id`,
      [rf.id],
      { userId, role, costCenterIds },
    );
    const covered = new Map<string, number[]>(
      coverage.rows.map((r: any) => [r.vendor_id, pgIntArray(r.line_nos)]),
    );

    // Every invited vendor is an entry from the start, with no versions. That
    // empty `versions` / `active: null` shape is not a placeholder — it is the
    // PENDING state the modal already knows how to render, and it is what the
    // form's own default selection reads
    // (`vendors.find(v => !v.active)`) to pre-pick the vendor still owed a quote.
    for (const r of invited.rows) {
      byVendor.set(r.vendor_id, {
        vendor_id: r.vendor_id,
        vendor_code: r.vendor_code,
        vendor_name: r.legal_name,
        vendor_state: r.vendor_state,
        on_approved_roster: ['Active', 'Approved'].includes(r.vendor_state),
        // Empty when the vendor's category mappings no longer reach any line on
        // this RFQ — invited once, mapping since removed. The form locks every
        // row for such a vendor rather than letting them price lines they were
        // never asked about.
        quotable_lines: covered.get(r.vendor_id) ?? [],
        versions: [],
        active: null,
      });
    }
    // Then overlay the quote history. A vendor here who is NOT in `byVendor` is
    // still added rather than dropped: a quotation that outlived its invitation
    // is history worth showing, and silently discarding it would hide the
    // inconsistency that produced it.
    for (const r of rows.rows) {
      if (!byVendor.has(r.vendor_id)) {
        byVendor.set(r.vendor_id, {
          vendor_id: r.vendor_id,
          vendor_code: r.vendor_code,
          vendor_name: r.legal_name,
          vendor_state: r.vendor_state,
          on_approved_roster: ['Active', 'Approved'].includes(r.vendor_state),
          // A quotation from a vendor no longer on the roster: no coverage to
          // derive, so it is reported as covering nothing rather than silently
          // inheriting the roster's answer for a different vendor.
          quotable_lines: [],
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
      // What the vendors were actually asked to price, in the RFQ's own words.
      lines: rfqLines.rows.map((l: any) => ({
        line_no: Number(l.line_no),
        description: l.description ?? null,
        quantity: l.quantity === null || l.quantity === undefined ? null : Number(l.quantity),
        uom: l.uom ?? null,
      })),
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

  // ── the Receive Quotation form contract ───────────────────────────────────

  /**
   * The fields the procurement Receive Quotation form REQUIRES.
   *
   * These used to exist only as conditionals inside insertQuotation, so every
   * e2e suite that records a quote had to know the rule by copying it — and six
   * of them predate the rule entirely. When the form tightened its contract, all
   * six failed at once on the same message, each needing its own hand-edit.
   *
   * Exported so a suite satisfies the contract from ONE definition. A change to
   * the form's required fields then cannot silently leave the suites posting a
   * body the API rejects.
   */
  static readonly REQUIRED_FORM_FIELDS = {
    leadTimeDays: 7,
    validUntil: '2026-12-31',
    paymentTerms: '30 Days Net',
  } as const;

  // ── internals ───────────────────────────────────────────────────────────

  private async requireOpenRfq(
    run: <U = any>(sql: string, params?: any[]) => Promise<{ rows: U[]; rowCount: number }>,
    rfqId: string,
  ) {
    // The PR is JOINED because the chain-of-custody gate is on the PR's stage.
    // Before this the query could only see the RFQ, so no such check was even
    // possible.
    const r = await run<any>(
      `SELECT rf.id, rf.state, rf.currency, pr.status AS pr_status, pr.pr_number
         FROM proc.rfq rf
         JOIN proc.purchase_requisitions pr ON pr.id = rf.pr_id
        WHERE rf.id = $1::uuid`,
      [rfqId],
    );
    if (r.rows.length === 0) throw new NotFoundException('RFQ not found');
    if (r.rows[0].state !== 'Open') {
      throw new BadRequestException(`RFQ is ${r.rows[0].state} — it is no longer accepting quotes`);
    }
    // THE GATE. Once the PR has left IN_PROCUREMENT_REVIEW the RFQ is a record
    // of a competition that has already been decided, and procurement holds no
    // write rights over it.
    //
    // `rfq.state = 'Open'` was NOT sufficient on its own, and the gap was real:
    // verified live before this fix, a procurement officer POSTed a brand-new
    // vendor quote onto a PR at QUOTES_RECEIVED — quotes already returned, CS
    // about to be built — and got 201. Every one of the 47 RFQs in that state on
    // this estate is still `Open`, because the RFQ is only marked `Awarded` when
    // the CS locks. So the RFQ-state check protected CS_LOCKED and PACK_LOCKED
    // only by coincidence, and left the entire QUOTES_RECEIVED population open.
    //
    // Confined to IN_PROCUREMENT_REVIEW because that is precisely where the
    // legitimate activity is: of every Open RFQ on this estate, 232 sit on a PR
    // at IN_PROCUREMENT_REVIEW and 47 do not. The gate permits all of the
    // former and refuses exactly the latter.
    if (!RFQ_SOURCING_STAGES.includes(r.rows[0].pr_status)) {
      throw new BadRequestException(
        `Quotations can no longer be recorded: ${r.rows[0].pr_number} has left ` +
        `${RFQ_SOURCING_STAGES[0]} (stage: ${r.rows[0].pr_status}). The quotes on this ` +
        'RFQ are now part of a decision that has been made. Reject the PR with remarks ' +
        'to return it to procurement.',
      );
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
      /** Persisted onto the row (migration 055). Null on a first version. */
      revisionReason?: string | null;
      /** Set by record()/supersede(); not by the supplier portal. */
      strictForm?: boolean;
    },
  ) {
    const { rfqId, vendorId, version, supersedesQuotationId, userId, body, currencyFallback, revisionReason, strictForm } = args;

    // ── The Receive Quotation form's required fields ──────────────────────
    // Checked HERE, at the top of the write, rather than in the DTO — because a
    // DTO-level rule would also fire for the supplier portal, which has its own
    // (looser) submission contract, and for the deliberate negative-path tests
    // that post a minimal body to prove a DIFFERENT gate refuses it.
    //
    // The message names every missing field at once. An officer who fixed them
    // one 400 at a time would have to resubmit four times to learn four things
    // the form already showed as empty.
    if (strictForm) {
      const missing: string[] = [];
      if (body.leadTimeDays === undefined || body.leadTimeDays === null || body.leadTimeDays < 0) {
        missing.push('Lead Days');
      }
      if (!body.validUntil) missing.push('Valid Until');
      else if (!isTodayOrLater(body.validUntil)) {
        // A quotation whose validity has already lapsed is not a record of a
        // live offer, and the comparative statement would rank it against
        // current quotes as though it were. Today itself is allowed — "valid
        // until today" is the ordinary way to say "good for today".
        //
        // Compared as a STRING because both sides are zero-padded yyyy-mm-dd,
        // which is also the form this column is stored in. Parsing to a Date
        // would drag the server's timezone into a value that is a plain
        // calendar day.
        missing.push(`a Valid Until of today or later (got ${body.validUntil})`);
      }
      if (!body.paymentTerms || !String(body.paymentTerms).trim()) missing.push('Payment Terms');

      // ── The attachment rule: mandatory ONCE, warned-about thereafter ──────
      //
      // A FIRST version must carry the vendor's document — there is nothing else
      // recording what was actually quoted.
      //
      // A REVISION does not have to. The business case is that the officer is
      // recording what the vendor said on the phone, and forcing a scan there
      // does not produce a better audit trail — it produces a dummy file, which
      // is worse than no file because it looks like evidence.
      //
      // So a revision without an attachment is not refused outright. It is
      // REFUSED PENDING CONFIRMATION: the server answers with a distinct code so
      // the form can ask, and once the officer confirms, the remark becomes the
      // mandatory audit record instead. The confirmation is enforced HERE, not
      // in the browser — a client-only check is bypassable, and the whole point
      // is that the reason is recorded with the revision.
      const isRevision = version > 1;
      const hasAttachment = !!body.attachmentId;

      if (!hasAttachment && version === 1) {
        missing.push('the vendor quotation document (attachment)');
      } else if (!hasAttachment && isRevision && !body.allowMissingAttachment) {
        // ConflictException, NOT BadRequestException with a statusCode field in
        // the payload: the request is well-formed and the STATE is what blocks
        // it, and a client must be able to branch on the status. Putting
        // statusCode inside a BadRequest body returns HTTP 400 anyway, so the
        // signal only exists for a caller that reads the body.
        throw new ConflictException({
          code: 'ATTACHMENT_CONFIRMATION_REQUIRED',
          message:
            'You are missing the attachment. A revised quotation can be saved without one, ' +
            'but the reason must be recorded. Confirm to continue.',
        });
      } else if (!hasAttachment && isRevision && !String(revisionReason ?? '').trim()) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'REVISION_REASON_REQUIRED',
          message:
            'Saving a revised quotation without an attachment requires a Remarks entry ' +
            'explaining what changed.',
        });
      }

      if (missing.length) {
        throw new BadRequestException(
          `this quotation is missing required field(s): ${missing.join(', ')}`,
        );
      }
      // The DTO already enforces the shape; this is a second gate for callers
      // that reach the service directly (SupplierService does). Skipped when
      // there is no attachment, which is now legal on a revision.
      if (hasAttachment && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        .test(String(body.attachmentId))) {
        throw new BadRequestException('attachmentId must be a UUID');
      }
    }

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

    // ── Per-line waterfall ─────────────────────────────────────────────────
    //   gross = qty x unit
    //   discount = gross x discountPercent        (derived — never accepted from the client)
    //   net = the taxable base
    //   tax = the tax actually charged             (derived)
    //   lineTotal = net + tax — what this line contributes to quotations.total_amount
    //
    // The arithmetic lives in quoteLineWaterfall(), exported and unit-tested,
    // because the browser recomputes the same six figures to display them and
    // two copies of this rule is how the screen and the stored quote drift apart.
    //
    // Every amount is rounded to 2dp INDIVIDUALLY and the header total is the
    // sum of the already-rounded lines. Rounding the column instead would make
    // the printed figure differ from the sum of the printed lines, which is
    // exactly the discrepancy FBR/PRA treat as a defect on a tax document.
    //
    // A tax-inclusive quote forces the discount basis. With one payable figure
    // already containing the tax there is no "before" or "after" to choose, so
    // recording whatever the radio happened to be set to would put a basis on
    // the row that was never applied.
    const basis = body.taxesIncluded === true || body.discountBasis !== 'after_tax'
      ? 'before_tax'
      : 'after_tax';
    const taxesIncluded = body.taxesIncluded === true;

    const priced = (body.lines || []).map((l) => {
      const no = Number(l.rfqLineNo);
      if (!qtyBy.has(no)) {
        throw new BadRequestException(
          `line ${no} is not on this RFQ (the RFQ has lines ${[...qtyBy.keys()].join(', ') || 'none'})`,
        );
      }
      const unit = Number(l.unitPrice || 0);
      if (!(unit >= 0)) throw new BadRequestException(`line ${no}: unitPrice must not be negative`);
      const discPct = Number(l.discountPercent ?? 0);
      const taxPct = Number(l.taxPercent ?? 0);
      if (!(discPct >= 0 && discPct <= 100)) {
        throw new BadRequestException(`line ${no}: discountPercent must be between 0 and 100`);
      }
      if (!(taxPct >= 0 && taxPct <= 100)) {
        throw new BadRequestException(`line ${no}: taxPercent must be between 0 and 100`);
      }
      const declined = l.declined === true;

      // A line that is not declined must carry a price ABOVE zero, and the RFQ
      // line it prices must have a quantity above zero.
      //
      // Both were `>= 0`, which let a quotation record a 0.00 line that was not
      // declined. In the comparative statement a 0.00 row is read as "this
      // vendor supplied it free", not "there is no price yet" — and a zero
      // quantity on the RFQ line makes every figure on the row zero no matter
      // what was typed, which is a corrupt RFQ rather than a quote.
      //
      // A DECLINED line is exempt on both counts: "will not supply" is a
      // meaningful answer and carries no price, which is why the prototype has
      // the checkbox at all.
      if (!declined) {
        if (!(unit > 0)) {
          throw new BadRequestException(
            `line ${no}: unitPrice must be greater than zero`
            + ' (mark the line Declined if the vendor will not supply it)',
          );
        }
        const qty = qtyBy.get(no)!;
        if (!(qty > 0)) {
          throw new BadRequestException(
            `line ${no}: the RFQ quantity is ${qty}, so no unit price can produce a total`,
          );
        }
      }
      // A declined line contributes NOTHING — it is not a zero-priced line.
      // The prototype's per-line table has a declined checkbox precisely so a
      // vendor can decline one line without implying they quoted it for free.
      if (declined) {
        return {
          no, unit, declined, gross: 0, discPct, discount: 0, net: 0, taxPct, tax: 0, lineTotal: 0,
          // total_price keeps its pre-055 meaning (gross) so the CS lock and the
          // award sheet still read a sane figure on a declined line.
          totalPrice: 0,
          warrantyMonths: l.warrantyMonths ?? null, remarks: l.remarks ?? null,
        };
      }
      const w = quoteLineWaterfall({
        unit, qty: qtyBy.get(no)!, discountPercent: discPct, taxPercent: taxPct,
        taxesIncluded, basis,
      });
      return {
        no, unit, declined, gross: w.gross, discPct, discount: w.discount, net: w.net,
        taxPct, tax: w.tax, lineTotal: w.lineTotal,
        totalPrice: w.gross,
        warrantyMonths: l.warrantyMonths ?? null, remarks: l.remarks ?? null,
      };
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
      const summed = round2(live.reduce((s, l) => s + l.lineTotal, 0));
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

    const taxBreakdown = this.buildTaxBreakdown(
      body, totalAmount, mode === 'per_line' ? priced : undefined,
    );

    const ins = await run<any>(
      `INSERT INTO proc.quotations
         (rfq_id, vendor_id, submitted_by_user_id, submitted_at, total_amount, currency,
          fx_rate, normalized_total_pkr, state, version, supersedes_quotation_id,
          lead_time_days, warranty_months, taxes_included, tax_breakdown, validity_days,
          payment_terms, notes, quote_mode,
          sealed_hash, open_at,
          revision_reason, valid_until, discount_basis)
       VALUES ($1::uuid, $2::uuid, $3::uuid, now(), $4, $5,
               $6, $7, 'Submitted', $8, $9::uuid,
               $10, $11, $12, $13::jsonb, $14,
               $15, $16, $17,
               $18, now(),
               $19, $20::date, $21)
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
                 lead_time_days, warranty_months, payment_terms, notes, taxes_included, validity_days,
                 revision_reason, valid_until, discount_basis`,
      [
        rfqId, vendorId, userId, totalAmount, currency,
        fxRate, round2(totalAmount * fxRate), version, supersedesQuotationId,
        body.leadTimeDays ?? null, body.warrantyMonths ?? null,
        body.taxesIncluded === true, JSON.stringify(taxBreakdown), body.validityDays ?? null,
        body.paymentTerms ?? null, body.notes ?? null, mode,
        this.inertSealHash(rfqId, vendorId, version, totalAmount, currency),
        // Persisted, not just echoed back. supersede() used to accept a reason
        // and drop it: there was no column, so the audit trail could show that a
        // price changed but never why.
        revisionReason ?? null,
        body.validUntil ?? null,
        basis,
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
             (quotation_id, rfq_id, rfq_line_no, unit_price, total_price, declined, remarks,
              gross_amount, discount_percent, discount_amount, net_amount,
              tax_percent, tax_amount, line_total, warranty_months)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7,
                   $8, $9, $10, $11,
                   $12, $13, $14, $15)
           RETURNING 1`,
          [
            q.id, rfqId, l.no, l.unit, l.totalPrice, l.declined, l.remarks,
            l.gross, l.discPct, l.discount, l.net,
            l.taxPct, l.tax, l.lineTotal, l.warrantyMonths,
          ],
        );
        // RETURNING is load-bearing: through the CSV psql bridge a statement
        // with no RETURNING emits no rows, so rowCount would be 0 even on a
        // successful insert and this guard would reject a good write.
        if (lr.rowCount === 0) throw new BadRequestException('could not record a quotation line');
      }

      // Pin the vendor's document to THIS version. Inside the same try so a
      // bad attachment id rolls the whole quotation back rather than leaving a
      // quote whose numbers exist but whose evidence does not.
      if (body.attachmentId) {
        // Resolve the attachment rather than trusting the id. An id that names
        // no registry row — or one that has been VOIDed — would otherwise be
        // caught only by the foreign key, and the error a caller sees would be a
        // raw constraint violation rather than a sentence about a retired
        // document.
        const doc = await run<any>(
          `SELECT id, name, status FROM core.attachment_registry
            WHERE id = $1::uuid`,
          [body.attachmentId],
        );
        if (doc.rows.length === 0) {
          throw new BadRequestException(
            `attachment ${body.attachmentId} is not an uploaded document — upload it to this PR first`,
          );
        }
        if (doc.rows[0].status === 'VOID') {
          throw new BadRequestException(
            `the attached document "${doc.rows[0].name}" has been voided and cannot evidence a quotation`,
          );
        }
        const link = await run(
          `INSERT INTO proc.quotation_attachments (quotation_id, attachment_id, kind)
           VALUES ($1::uuid, $2::uuid, $3)
           RETURNING 1`,
          [q.id, body.attachmentId, 'quotation'],
        );
        if (link.rowCount === 0) {
          throw new BadRequestException('could not attach the quotation document');
        }
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
   *
   * PER-LINE QUOTES ARE SUMMED FROM THE WATERFALL, NOT FROM THE HEADER FIELDS.
   * `subtotal` / `taxPercent` / `taxAmount` are header-level inputs, and the
   * receive-quote form never sends them — it sends per-line rates and lets the
   * server derive the amounts. So this used to fall through to its defaults and
   * store `subtotal = totalAmount, tax_percent = 0, tax_amount = 0` on every
   * quote the officer actually records: a tax document that claims no tax at
   * all, on the one path that charges tax per line. The per-line branch reads
   * the real figures off the priced lines instead, and keeps `tax_percent: null`
   * because a per-line quote genuinely has no single header rate — several lines
   * may each carry a different one.
   */
  private buildTaxBreakdown(
    body: QuotationInput,
    totalAmount: number,
    priced?: Array<{ declined: boolean; net: number; tax: number }>,
  ) {
    if (priced) {
      const live = priced.filter((l) => !l.declined);
      const subtotal = round2(live.reduce((s, l) => s + l.net, 0));
      const taxAmount = round2(live.reduce((s, l) => s + l.tax, 0));
      return {
        subtotal,
        tax_percent: null,
        tax_amount: taxAmount,
        freight: 0,
        computed_grand_total: totalAmount,
        quoted_grand_total: totalAmount,
        taxes_included: body.taxesIncluded === true,
        source: 'per_line_waterfall',
      };
    }
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
      // Empty wherever the caller's query does not select it — additive only, and
      // read-only. It reports what was ALREADY quoted; it never revalidates it
      // against the vendor's current mappings, because a lapsed mapping must not
      // be able to invalidate history.
      line_nos: pgIntArray(q.line_nos),
    };
  }
}
