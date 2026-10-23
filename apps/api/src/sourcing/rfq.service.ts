import { createHash, randomBytes } from 'crypto';
import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { DbService, type SessionContext } from '../db/db.service';
import { pgArray, pgIntArray } from '../db/pg-array';
import { roleAllowed } from '@procurement/roles';
import { rfqStatusView, rfqRollups, subStatus, emptyProcurement, parseJsonb, type RfqStatusView } from './rfq.status';

/** Caller identity as the JWT guard hands it over. */
type SourcingCtx = SessionContext;

/**
 * D5's default: no due-diligence record, or one that has not concluded, means
 * the compliance state is UNKNOWN. The prototype hardcodes "✓ Pass" here; we
 * never invent a pass.
 */
export const COMPLIANCE_UNKNOWN = { status: 'unknown', label: '—' } as const;

// ── fidelity constants ─────────────────────────────────────────────────────

/** The prototype issues to exactly 3 vendors (rfqIssue(): "sent to 3 vendors"). */
export const DEFAULT_VENDOR_COUNT = 3;

/**
 * `proc.rfq` carries a CHECK (`rfq_check`) that `deadline_at >= created_at +
 * 24h`. That is a schema floor, NOT a business timer: per decision Q2 no
 * deadline ever hides, expires or auto-closes anything. `deadline_at` is
 * display-only — it is rendered on the supplier inbox ('Due …') and the
 * rfq-detail header, and nothing reads it to gate access.
 */
export const MIN_DEADLINE_HOURS = 24;
export const DEFAULT_DEADLINE_DAYS = 7;

/**
 * PR stages from which procurement may issue an RFQ.
 *
 * The prototype gates on `HOD_APPROVED` (rfqIssue(): "PR not ready for RFQ
 * (stage: …)"). `HOD_APPROVED` is the prototype's label for the post-HOD,
 * procurement's-turn state, which the port carries as `IN_PROCUREMENT_REVIEW`;
 * `_lightRosterCard` renders the same card for `READY_FOR_D365`.
 */
export const RFQ_ISSUE_STAGES = ['IN_PROCUREMENT_REVIEW', 'READY_FOR_D365'];

/**
 * Stages from which procurement may RE-ISSUE an RFQ — i.e. add a vendor to one
 * that is already out.
 *
 * NARROWER THAN `RFQ_ISSUE_STAGES`, and deliberately so: `IN_PROCUREMENT_REVIEW`
 * ONLY. This is the chain of custody, and it is not a screen guard.
 *
 * Once a PR leaves procurement — a comparative statement exists, a winner has
 * been selected, the PR has been forwarded to cost centre / finance / D365 —
 * procurement holds no action rights over it. Adding a vendor then changes the
 * competition that was already decided, retroactively, with no audit entry from
 * the authority that owns the document now. That is not a convenience gap; it
 * is the shape of a vendor-selection fraud, and it is exactly what the workflow
 * engine's per-stage actor check exists to prevent.
 *
 * The supported route for a change after the handoff already exists and is
 * mandatory: procurement REJECTS the PR with remarks for the audit trail, the
 * current holder does the same to send it back, and it re-enters
 * `IN_PROCUREMENT_REVIEW` through the audited workflow — where the new actor is
 * recorded. Nothing is lost by gating this; the only thing lost is the ability
 * to change a decided competition in place without anyone else's involvement.
 *
 * The prototype already gates it this way (`stage === 'IN_PROCUREMENT_REVIEW'`
 * in its action bar). An earlier revision of this service widened it to "any
 * stage where the RFQ is still Open", on the reasoning that a buyer who spots
 * a vendor drop-out after the PR moved on would otherwise have no action. That
 * reasoning was wrong: having no action is the control.
 */
export const RFQ_REISSUE_STAGES = ['IN_PROCUREMENT_REVIEW'];

/**
 * The same rule, under the name the quotation path reads it by.
 *
 * Recording or revising a vendor quotation is not a different act from adding a
 * vendor to the roster — both are procurement writing to a live competition
 * that a finished one would be immune to. One constant, so the two paths cannot
 * drift apart.
 */
export const RFQ_SOURCING_STAGES = RFQ_REISSUE_STAGES;

/**
 * Ceiling on how many vendors ONE RFQ can carry.
 *
 * This is the same limit `POST /rfq/:id/invite` enforces ("at most 12 vendors
 * per RFQ"). It replaces DEFAULT_VENDOR_COUNT as the cap on an automatically
 * category-matched roster: a PR with two categories can legitimately have more
 * than three mapped vendors, and truncating to 3 would drop vendors who cover
 * lines the survivors cannot quote. DEFAULT_VENDOR_COUNT survives as the
 * prototype's *target*, which is what `shortfall` is measured against.
 */
export const MAX_ROSTER_VENDORS = 12;

/**
 * The prototype's Issue-RFQ default deadline: `plusDays(5)` in
 * lightProcIssueRFQ. The modal offers this, so the suggested value has to match
 * what the prototype would have put in the field.
 */
export const PROTOTYPE_DEADLINE_DAYS = 5;

/** `yyyy-mm-dd` for `days` from today — what a <input type="date"> wants. */
function isoPlusDays(days: number): string {
  return new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
}

/**
 * Normalise a Postgres array aggregate into a real JS array.
 *
 * `array_agg()` does NOT arrive as an array over this driver — an `int4[]`
 * comes back as the literal string `'{1,2,3}'`, which made
 * `array_agg(...).map(...)` throw a 500 on the first call. Worse, a STRING passed
 * straight through `.join()` would have rendered "{IT_HARDWARE}" in the modal
 * instead of failing, so both ends have to be handled. Typed arrays are only
 * parsed when the driver recognises the OID; the aggregate's type is resolved at
 * runtime, so this cannot be relied on.
 *
 * The parse now has ONE owner, `db/pg-array.ts`. This file had its own copy, and
 * so did auth, quotation and the award-shape builder — four implementations of
 * one rule, which is how the copy here came to differ from the copy that threw.
 */

/**
 * The prototype's approved vendor roster: `lightProcVendorPool()` returns
 * `STATE.lightVendorSeed` (approved) PLUS `STATE.pendingVendors`. Decision Q3 —
 * a vendor off the approved roster is not blocked; the roster card simply
 * badges the quote "Pending approval". These are the *approved* states, and
 * they sort first when auto-picking the roster.
 */
export const APPROVED_VENDOR_STATES = ['Active', 'Approved'];

/**
 * Never invited. `lightProcVendorPool()` can contain a blacklisted vendor but
 * the port must not put one on an RFQ — there is no prototype row for it and
 * inviting one would be a procurement-control failure.
 */
export const EXCLUDED_VENDOR_STATES = ['Rejected', 'Blacklisted', 'Deactivated'];

/**
 * "This vendor could actually be invited today" — the four eligibility rules as
 * ONE SQL fragment, for any query that has to decide reachability rather than
 * report it.
 *
 * `categoryPool()` cannot use this: it deliberately SELECTs each rule as its own
 * column so the refusal reason travels with the row and the modal can explain
 * itself. That is the reporting shape. This is the asking shape — "is there any
 * vendor behind this category at all?", which needs one boolean, not four.
 *
 * It lives here, next to EXCLUDED_VENDOR_STATES, because a second copy of these
 * four rules is a second thing to drift: the dropdown would enable a category
 * whose only vendors the RFQ then refuses, and the buyer would meet a gate with
 * no visible cause. Aliases required: `v`, `comp`; $1 is the excluded states array.
 */
export const INVITABLE_VENDOR_PREDICATE = `
         NOT v.is_hold
     AND (v.state <> ALL($1::text[]))
     AND NOT EXISTS (SELECT 1 FROM core.vendor_blacklist b
                      WHERE b.vendor_id = v.id AND b.resolved_at IS NULL)
     AND comp.blocked IS DISTINCT FROM true`;

/**
 * "This PR line can actually be quoted" — as ONE SQL fragment, for every query
 * that has to decide which lines will ride the RFQ rather than report on them.
 *
 * THREE queries need this answer and they must give the SAME one:
 *   - `snapshotRfqLines()`        — the rows written to proc.rfq_lines
 *   - `categoryPool()`            — the categories vendors are matched against
 *   - `unsourceableCategories()`  — the lines that block Send for want of a vendor
 *
 * They did not agree. `snapshotRfqLines()` excluded HELD lines; the other two
 * only excluded REJECTED ones. So a PR whose every line was held still matched a
 * full category pool and a healthy vendor roster, and the modal offered "Send RFQ
 * to 4 vendor(s)" for a document the write could not produce — `issue()` then
 * refused with a 400 that named no line and no remedy. The preview was
 * describing an RFQ that did not exist. (PR-2026-201649, 2026-10-11.)
 *
 * `pending_qty > 0` is the other half and was already load-bearing in the
 * snapshot: a STORE_STOCK line with nothing left to buy is not a line to quote.
 *
 * `rejected` is now filtered HERE as well as in `categoryPool()`, so all three
 * queries finally agree: a line the HOD threw out is never written, never
 * shown as a chip, and never put out for quote. (Aligned 2026-10-11; previously
 * the snapshot omitted it and 11 live PRs would have quoted rejected lines.)
 *
 * Alias required: `pl`. Callers supply their own `pl.pr_id = $n::uuid`.
 */
export const RFQ_ELIGIBLE_LINE_PREDICATE = `
        NOT COALESCE(pl.held, false)
    AND GREATEST(pl.quantity
           - CASE WHEN pl.fulfilment_source = 'STORE_STOCK'
                  THEN COALESCE(pl.store_fulfilled_qty, 0) ELSE 0 END, 0) > 0`;

/**
 * One category-matched vendor, as the pool query returns it.
 *
 * `exclusion_reason` is null exactly when the vendor may be invited. When it is
 * set, the vendor is WITHHELD — visible and explained, never silently dropped.
 */
export type PoolVendor = {
  id: string;
  vendor_code: string;
  legal_name: string;
  state: string;
  categories: string[];
  risk_grade: string | null;
  risk_score: number | null;
  exclusion_reason: 'vendor_state' | 'blacklisted' | 'risk_blocked' | 'held' | null;
};

/**
 * One PR line that cannot ride an RFQ, and why. The counterpart to the
 * RFQ_ELIGIBLE_LINE_PREDICATE-defined set `snapshotRfqLines()` writes.
 *
 * `no_pending_quantity` is a STORE_STOCK line with nothing left to buy — there
 * is no remainder for a vendor to quote. `rejected` is a line the HOD threw out;
 * it is recorded here only so the buyer can see it was excluded on purpose
 * rather than lost. `held` is the one the buyer must act on.
 */
export type UnquotableLine = {
  line_no: number;
  reason: 'held' | 'rejected' | 'no_pending_quantity';
  detail: string | null;
};

/**
 * `is_active`-style boolean expressions arrive from this driver as `true`, and as
 * the STRING `'true'` on some paths — the codebase already normalises both at
 * `resolveVendors()` (`.filter(r => r.is_hold === true || r.is_hold === 'true')`).
 * A bare `!eligible_risk` would read the string 'false' as TRUTHY and silently
 * withhold every vendor on the affected connection, so both forms are handled.
 */
function truthy(v: unknown): boolean {
  return v === true || v === 'true';
}

/**
 * Why a matched vendor is not on the roster, in the buyer's own language.
 *
 * These strings are the whole point of showing a withheld vendor: "high risk"
 * must be legible in the modal, not something the buyer infers from an absence.
 * `risk_blocked` deliberately names the composite score, matching the refusal
 * text insertInvitation() already returns, so the modal and a later manual
 * invite cannot describe the same block differently.
 */
export const EXCLUSION_LABELS: Record<string, (v: PoolVendor) => string> = {
  risk_blocked: v =>
    `High risk — blocked pending remediation (composite ${v.risk_score ?? '?'}/100). ` +
    'Cannot be invited until the risk assessment improves.',
  held: v => 'On hold — cannot be invited while the hold is in place.',
  blacklisted: () => 'Blacklisted — an unresolved blacklist entry blocks invitation.',
  vendor_state: v => `Lifecycle state "${v.state}" is not an invitable state.`,
};

/** Short count-able nouns for the shortfall summary ("2 high-risk, 1 on hold"). */
export const EXCLUSION_REASON_NOUN: Record<string, string> = {
  risk_blocked: 'high-risk',
  held: 'on hold',
  blacklisted: 'blacklisted',
  vendor_state: 'not invitable',
};

export type IssueRfqInput = {
  vendorIds?: string[];
  deadlineAt?: string;
  title?: string;
  currency?: string;
  incoterm?: string;
  singleSource?: boolean;
  singleSourceJustification?: string;
};

export type InviteVendorInput = {
  vendorId: string;
};

/**
 * Re-issue input. Deliberately narrower than `IssueRfqInput`: a re-issue adds
 * vendors to an RFQ that already exists, so there is no title, currency or
 * incoterm to choose — those were fixed at issue and the prototype carries them
 * across untouched. Only the roster and the deadline can move.
 */
export type ReissueRfqInput = {
  vendorIds?: string[];
  deadlineAt?: string;
};

/** SHA-256 of a raw invitation token, hex. The raw token is never stored. */
function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

@Injectable()
export class RfqService {
  constructor(private readonly db: DbService) {}

  // ── GET /rfq ────────────────────────────────────────────────────────────
  /**
   * `rfq-list` payload. Scoped to the prototype's `data-roles` for the screen
   * (`procurement,cs`, plus the `admin` alias which unions both).
   *
   * Returns the four KPI rollups and one row per RFQ, each row already carrying
   * the prototype's own status label + pill so `renderRFQList` is a pure
   * projection of this response.
   */
  async list(userId: string, role: string, costCenterIds: string[]) {
    if (!roleAllowed(role, 'procurement,cs')) {
      throw new ForbiddenException('rfq-list is available to procurement and cs only');
    }

    const r = await this.db.query<any>(
      `SELECT rf.id, rf.rfq_number, rf.pr_id, rf.state, rf.title, rf.currency,
              rf.incoterm, rf.deadline_at, rf.created_at, rf.issued_at,
              rf.single_source, rf.single_source_justification,
              pr.pr_number, pr.title AS pr_title, pr.status AS pr_status,
              u.display_name AS issued_by,
              (SELECT count(*) FROM proc.rfq_invitations i
                WHERE i.rfq_id = rf.id) AS invited,
              (SELECT count(*) FROM proc.rfq_invitations i
                WHERE i.rfq_id = rf.id AND i.declined) AS declined,
              (SELECT count(DISTINCT q.vendor_id) FROM proc.quotations q
                WHERE q.rfq_id = rf.id AND q.state <> 'Withdrawn') AS quotes,
              (SELECT min(q.normalized_total_pkr) FROM proc.quotations q
                WHERE q.rfq_id = rf.id AND q.state <> 'Withdrawn') AS lowest_bid
         FROM proc.rfq rf
         JOIN proc.purchase_requisitions pr ON pr.id = rf.pr_id
         LEFT JOIN core.users u ON u.id = rf.created_by_user_id
        ORDER BY coalesce(rf.issued_at, rf.created_at) DESC, rf.rfq_number DESC
        LIMIT 200`,
      [],
      { userId, role, costCenterIds },
    );

    const csLockedByPr = await this.csLockedPrIds({ userId, role, costCenterIds });
    const pushedByPr = await this.pushedPrIds({ userId, role, costCenterIds });

    const rows = r.rows.map((x: any) => {
      const view: RfqStatusView = rfqStatusView({
        state: x.state,
        quotes: Number(x.quotes || 0),
        invited: Number(x.invited || 0),
        csLocked: csLockedByPr.has(x.pr_id),
        d365Pushed: pushedByPr.has(x.pr_id),
      });
      return {
        id: x.id,
        rfq_number: x.rfq_number,
        pr_id: x.pr_id,
        pr_number: x.pr_number,
        pr_title: x.pr_title,
        pr_status: x.pr_status,
        title: x.title || x.pr_title,
        state: x.state,
        currency: x.currency,
        incoterm: x.incoterm,
        deadline_at: x.deadline_at,
        issued_at: x.issued_at,
        created_at: x.created_at,
        issued_by: x.issued_by,
        single_source: x.single_source,
        single_source_justification: x.single_source_justification,
        invited: Number(x.invited || 0),
        declined: Number(x.declined || 0),
        quotes: Number(x.quotes || 0),
        lowest_bid: x.lowest_bid === null || x.lowest_bid === undefined
          ? null
          : Number(x.lowest_bid),
        // The prototype's own two fields.
        status: view.label,
        pill: view.pill,
      };
    });

    const rollups = rfqRollups(
      rows.map((x: any) => ({
        quotes: x.quotes,
        lowestBid: x.lowest_bid,
        view: rfqStatusView({
          state: x.state,
          quotes: x.quotes,
          invited: x.invited,
          csLocked: csLockedByPr.has(x.pr_id),
          d365Pushed: pushedByPr.has(x.pr_id),
        }),
      })),
    );

    return { rows, rollups };
  }

  // ── GET /rfq/:id ────────────────────────────────────────────────────────
  /**
   * `rfq-detail` payload: the RFQ, its invitation roster, and every quote
   * version per vendor (the Versions Panel reads the full chain, not just the
   * active version).
   *
   * Tokens are NEVER returned here — only their hash prefix, which is enough
   * to correlate a row with the audit trail without re-exposing a live
   * credential.
   */
  async get(id: string, userId: string, role: string, costCenterIds: string[]) {
    // Prototype `data-roles` for rfq-detail: procurement,cs,hod,vendor,mc,cfo.
    if (!roleAllowed(role, 'procurement,cs,hod,vendor,mc,cfo')) {
      throw new ForbiddenException('not permitted to view this RFQ');
    }
    return this.buildDetail(id, { userId, role, costCenterIds });
  }

  /**
   * The rfq-detail body, WITHOUT the role check.
   *
   * The gate lives in `get()` rather than here because the two callers have
   * DIFFERENT screens and therefore different permissions:
   *   GET /rfq/:id      -> rfq-detail, data-roles procurement,cs,hod,vendor,mc,cfo
   *   GET /pr/:id/sourcing -> light-pr-detail, data-roles 'all'
   * When `sourcing()` called `get()` directly it inherited rfq-detail's gate
   * and refused a requester, which the prototype's detail page does not do.
   */
  private async buildDetail(id: string, ctx: SourcingCtx) {
    const { userId, role, costCenterIds } = ctx as { userId: string; role: string; costCenterIds: string[] };

    const rf = await this.db.query<any>(
      `SELECT rf.*, pr.pr_number, pr.title AS pr_title, pr.status AS pr_status,
              pr.estimated_amount, u.display_name AS issued_by
         FROM proc.rfq rf
         JOIN proc.purchase_requisitions pr ON pr.id = rf.pr_id
         LEFT JOIN core.users u ON u.id = rf.created_by_user_id
        WHERE rf.id = $1::uuid`,
      [id],
      { userId, role, costCenterIds },
    );
    if (rf.rows.length === 0) throw new NotFoundException('RFQ not found');
    const rfq = rf.rows[0];

    const invites = await this.db.query<any>(
      `SELECT i.id, i.vendor_id, i.invited_at, i.submitted, i.declined,
              i.declined_reason, i.reissue_no,
              left(i.token_hash, 12) AS token_prefix,
              v.vendor_code, v.legal_name, v.state AS vendor_state,
              -- The re-issue that ADDED this vendor, when one did. NULL for the
              -- original issue, which is the common case and must stay distinct
              -- from "we don't know" — hence the equality test on reissue_no
              -- rather than a NULL timestamp test.
              rr.reissued_at AS added_at_reissue_no,
              rr.deadline_after AS added_at_reissue_deadline
         FROM proc.rfq_invitations i
         JOIN core.vendors v ON v.id = i.vendor_id
         LEFT JOIN proc.rfq_reissues rr
                ON rr.rfq_id = i.rfq_id AND rr.reissue_no = i.reissue_no
        WHERE i.rfq_id = $1::uuid
        ORDER BY i.invited_at ASC`,
      [id],
      { userId, role, costCenterIds },
    );

    const quotes = await this.db.query<any>(
      `SELECT q.id, q.vendor_id, q.version, q.state, q.total_amount, q.currency,
              q.fx_rate, q.normalized_total_pkr, q.lead_time_days, q.warranty_months,
              q.taxes_included, q.tax_breakdown, q.validity_days, q.valid_until,
              q.submitted_at, q.supersedes_quotation_id,
              v.vendor_code, v.legal_name, v.state AS vendor_state,
              -- Warranty is captured PER LINE by the Receive Quotation grid, so
              -- the header column is NULL for anything recorded through the UI
              -- and an em-dash is drawn over a warranty that was really given.
              -- Same fallback award.service.ts:132 uses, plus the MAX so a
              -- multi-line quote can be shown as the range it is. See the longer
              -- note on liveQuotes().
              (SELECT min(ql.warranty_months) FROM proc.quotation_lines ql
                WHERE ql.quotation_id = q.id AND ql.warranty_months IS NOT NULL) AS line_warranty_min,
              (SELECT max(ql.warranty_months) FROM proc.quotation_lines ql
                WHERE ql.quotation_id = q.id AND ql.warranty_months IS NOT NULL) AS line_warranty_max,
              -- The vendor's OWN document, pinned to THIS version.
              --
              -- proc.quotation_attachments exists precisely so an auditor asking
              -- "what did they actually send on 3 October?" gets the V1 scan and
              -- not whatever is attached now. A VOIDed document is excluded here
              -- rather than offered as a view button that 404s: download()
              -- keeps superseded files readable on purpose, but a voided one is
              -- retired and must not look available.
              COALESCE((
                SELECT jsonb_agg(
                         jsonb_build_object('id', qa.attachment_id, 'name', ar.name, 'kind', qa.kind)
                         ORDER BY qa.created_at)
                  FROM proc.quotation_attachments qa
                  JOIN core.attachment_registry ar ON ar.id = qa.attachment_id
                 WHERE qa.quotation_id = q.id AND ar.status <> 'VOID'
              ), '[]'::jsonb) AS attachments
         FROM proc.quotations q
         JOIN core.vendors v ON v.id = q.vendor_id
        WHERE q.rfq_id = $1::uuid
        ORDER BY q.vendor_id, q.version ASC`,
      [id],
      { userId, role, costCenterIds },
    );

    const onRoster = (state: string) => APPROVED_VENDOR_STATES.includes(state);

    const roster = invites.rows.map((i: any) => {
      const vendorQuotes = quotes.rows
        .filter((q: any) => q.vendor_id === i.vendor_id)
        .map((q: any) => this.shapeQuote(q));
      const active = vendorQuotes.filter((q: any) => q.state === 'Submitted');
      // `_lightRosterCard` badge ladder, verbatim:
      //   Winner | Received | Awaiting quote
      const declined = i.declined === true;
      const hasQuote = vendorQuotes.some((q: any) => q.state === 'Submitted');
      return {
        invitation_id: i.id,
        vendor_id: i.vendor_id,
        vendor_code: i.vendor_code,
        vendor_name: i.legal_name,
        vendor_state: i.vendor_state,
        on_approved_roster: onRoster(i.vendor_state),
        // Per-vendor "RFQ issued at" — the prototype's `issuedAtByVendor`
        // falling back to the RFQ-level `issuedAt`.
        issued_at: i.invited_at || rfq.issued_at,
        // Which re-issue added this vendor, and when. 0 / null = original issue.
        reissue_no: Number(i.reissue_no || 0),
        reissued_at: i.reissue_no > 0 ? (i.added_at_reissue_no ?? null) : null,
        reissued_deadline: i.reissue_no > 0 ? (i.added_at_reissue_deadline ?? null) : null,
        submitted: i.submitted === true,
        declined,
        declined_reason: i.declined_reason,
        token_prefix: i.token_prefix,
        quote_count: active.length,
        versions: vendorQuotes,
        badge: declined
          ? { label: 'Declined', tone: 'mute' }
          : hasQuote
            ? { label: 'Received', tone: 'info' }
            : { label: 'Awaiting quote', tone: 'neutral' },
        // Q3 / plan item 8: a quote from a vendor off the approved roster is
        // accepted and badged, never blocked.
        pending_approval: !onRoster(i.vendor_state),
      };
    });

    const view = rfqStatusView({
      state: rfq.state,
      quotes: new Set(
        quotes.rows.filter((q: any) => q.state !== 'Withdrawn').map((q: any) => q.vendor_id),
      ).size,
      invited: roster.length,
      csLocked: await this.isCsLocked(rfq.pr_id, { userId, role, costCenterIds }),
      d365Pushed: (await this.pushedPrIds({ userId, role, costCenterIds })).has(rfq.pr_id),
    });

    const recv = new Set(
      quotes.rows.filter((q: any) => q.state === 'Submitted').map((q: any) => q.vendor_id),
    ).size;

    // The winner recorded by a LOCKED comparative statement. rfq-detail's
    // "Winner" badge reads this, NOT the prototype's `i===0` — the prototype
    // hardcodes the first quote as the winner because its demo data has no CS.
    // Marking an arbitrary bid "Winner" is exactly what the CS process exists to
    // prevent, so until step 6 locks one there is no winner and the column
    // renders an em-dash. Same reasoning as D5 (never invent a pass).
    const winner = await this.lockedWinner(rfq.pr_id, { userId, role, costCenterIds });
    // W5-G: a split award has no single vendor_id, so `winner.vendor_id` is null
    // and every bid row would render as a loser on a package that was already
    // decided. The winning vendor set comes from the split instead.
    const splitVendorIds = new Set(
      ((winner as any)?.split || []).map((s: any) => s.vendor_id),
    );

    // Per-vendor bid rows for rfq-detail, one per LIVE quote.
    const compliance = await this.complianceMap(
      [...new Set(quotes.rows.map((q: any) => q.vendor_id))],
      { userId, role, costCenterIds },
    );
    const live = quotes.rows
      .filter((q: any) => q.state === 'Submitted' || q.state === 'Awarded')
      .map((q: any) => ({
        quotation_id: q.id,
        vendor_id: q.vendor_id,
        vendor_name: q.legal_name,
        vendor_code: q.vendor_code,
        version: Number(q.version),
        state: q.state,
        amount: Number(q.total_amount),
        currency: q.currency,
        lead_days: q.lead_time_days === null ? null : Number(q.lead_time_days),
        // Already resolved by liveQuotes(): header, else the floor across the
        // quote's lines. `warranty_months_max` rides along so the screen can
        // show "10–12 mo" instead of pretending a range is one number.
        // Header first, else the floor across the quote's own lines — the
        // warranty a buyer actually recorded. `…_max` lets the screen show
        // "10–12 mo" instead of inventing one figure.
        warranty_months: q.warranty_months === null
          ? (q.line_warranty_min === null ? null : Number(q.line_warranty_min))
          : Number(q.warranty_months),
        warranty_months_max: q.line_warranty_max === null ? null : Number(q.line_warranty_max),
        warranty_from_lines: q.warranty_months === null && q.line_warranty_min !== null,
        validity_days: q.validity_days === null ? null : Number(q.validity_days),
        // The recorded expiry date. validity_days is a DURATION and is NULL on
        // quotes that carry a real valid_until — reporting only the duration is
        // what drew two em-dashes beside "Valid" for dates that were on file.
        valid_until: q.valid_until ?? null,
        received_at: q.submitted_at,
        is_new_vendor: !onRoster(q.vendor_state),
        // D5: compliance comes from core.vendor_due_diligence, never assumed.
        compliance: compliance.get(q.vendor_id) ?? COMPLIANCE_UNKNOWN,
        // W5-G: a vendor who won at least one line is a winner even though no
        // single vendor won the whole package.
        is_winner: winner
          ? (winner.vendor_id
              ? winner.vendor_id === q.vendor_id
              : splitVendorIds.has(q.vendor_id))
          : false,
      }));

    return {
      rfq: {
        id: rfq.id,
        rfq_number: rfq.rfq_number,
        pr_id: rfq.pr_id,
        pr_number: rfq.pr_number,
        pr_title: rfq.pr_title,
        pr_status: rfq.pr_status,
        title: rfq.title || rfq.pr_title,
        state: rfq.state,
        currency: rfq.currency,
        incoterm: rfq.incoterm,
        estimated_amount: Number(rfq.estimated_amount || 0),
        deadline_at: rfq.deadline_at,
        created_at: rfq.created_at,
        issued_at: rfq.issued_at,
        issued_by: rfq.issued_by,
        // The re-issue event. Carried here rather than left to be recomputed
        // from the roster, because after a top-up the invitation list is
        // indistinguishable from a first issue to more vendors — `invited_at`
        // says who was asked, never how many times the ask was repeated.
        reissue_count: Number(rfq.reissue_count || 0),
        last_reissued_at: rfq.last_reissued_at,
        // Never mutated, so it is the only surviving record of the deadline the
        // competition was FIRST run to — `deadline_at` above is overwritten in
        // place by every re-issue.
        initial_deadline_at: rfq.initial_deadline_at ?? null,
        single_source: rfq.single_source,
        single_source_justification: rfq.single_source_justification,
        status: view.label,
        pill: view.pill,
      },
      // `_lightRosterCard` header: "<n> vendors on this RFQ" + the prominent
      // "RFQ issued: <ts>" pill.
      roster,
      // rfq-detail's "Vendors & quotes" bid rows, and the locked winner.
      bids: live,
      winner,
      roster_tally: {
        received: recv,
        total: roster.length,
        pending: Math.max(0, roster.length - recv),
        text: `${recv} of ${roster.length} quote${roster.length === 1 || recv === 1 ? '' : 's'} received - ${Math.max(0, roster.length - recv)} pending`,
      },
    };
  }

  // ── POST /pr/:id/rfq ────────────────────────────────────────────────────
  /**
   * Issue an RFQ. Port of `rfqIssue()`.
   *
   * The prototype's version fabricates three quotes inline and jumps the PR
   * straight to QUOTES_RECEIVED. We do not fabricate anything: the RFQ and
   * its invitations are persisted, and quotes arrive later from the supplier
   * surface (step 2). The PR's own stage is deliberately left alone — the
   * prototype's `QUOTES_RECEIVED` stage is the *post-quote* state, and it is
   * reached in step 2 when quotes actually exist, not fabricated at issue
   * time. Sourcing progress lives in `proc.rfq.state` until then.
   *
   * Returns the raw invitation tokens ONCE. Only their SHA-256 is persisted,
   * so this response is the sole opportunity to deliver them (email, portal
   * link). They cannot be re-read afterwards.
   */
  async issue(
    prId: string,
    userId: string,
    role: string,
    costCenterIds: string[],
    body: IssueRfqInput,
  ) {
    // rfqIssue(): "Only Procurement can issue an RFQ."
    if (!roleAllowed(role, 'procurement')) {
      throw new ForbiddenException('Only Procurement can issue an RFQ.');
    }

    return this.db.withTransaction({ userId, role, costCenterIds }, async (run) => {
      const pr = await run<any>(
        `SELECT pr.id, pr.pr_number, pr.title, pr.status, pr.currency,
                pr.estimated_amount
           FROM proc.purchase_requisitions pr
          WHERE pr.id = $1::uuid`,
        [prId],
      );
      if (pr.rows.length === 0) throw new NotFoundException('PR not found');
      const p = pr.rows[0];

      if (!RFQ_ISSUE_STAGES.includes(p.status)) {
        // rfqIssue(): "PR not ready for RFQ (stage: …)"
        throw new BadRequestException(`PR not ready for RFQ (stage: ${p.status})`);
      }

      // One live RFQ per PR. Re-issuing tops THAT ONE up —
      // `POST /pr/:id/rfq/reissue` — rather than creating a second RFQ, which
      // would orphan every quotation already received against this one.
      const existing = await run<any>(
        `SELECT id, rfq_number FROM proc.rfq
          WHERE pr_id = $1::uuid AND state NOT IN ('Cancelled')
          ORDER BY created_at DESC LIMIT 1`,
        [prId],
      );
      if (existing.rows.length > 0) {
        throw new BadRequestException(
          `PR already has an open RFQ (${existing.rows[0].rfq_number}). ` +
          `Use POST /pr/${existing.rows[0].id}/invite to add another vendor, ` +
          `or POST /pr/${prId}/rfq/reissue to add several at once.`,
        );
      }

      // THE DEAD-END GATE. Checked before the roster is resolved and before the
      // RFQ row is inserted, so a blocked PR leaves nothing behind to clean up.
      //
      // It runs on BOTH paths into this method — a caller naming vendors by hand
      // gets no exemption, because naming a vendor by hand does not create one
      // for the MACHINERY line: `insertInvitation()` still refuses a vendor that
      // is not mapped to it, so the line would be quoted by nobody and fail at
      // award. The fix is a vendor mapping, and a mapping is not something the
      // requester's form submission can supply.
      const unsourceable = await this.unsourceableCategories(run, prId);
      if (unsourceable.length > 0) {
        throw new BadRequestException(this.describeUnsourceable(unsourceable));
      }

      // THE NOTHING-TO-QUOTE GATE. Same placement rule as the dead-end gate above,
      // and for the same reason — this must run BEFORE the INSERT.
      //
      // It used to run after, via snapshotRfqLines()'s return value. That worked
      // until it didn't: DbService.withTransaction() gives each statement its own
      // BEGIN/COMMIT, so throwing here rolled back nothing and left the PR
      // carrying an Open RFQ with no lines and no invitations. Observed on
      // PR-2026-201649 — RFQ-2026-200616, 0 lines, 0 invitations, 0 audit rows.
      // The PR could not then be retried: the next attempt failed with "PR
      // already has an open RFQ", pointing at an RFQ that had never been sent.
      //
      // Asking here also means the refusal can NAME the lines, which the
      // post-hoc count could not do.
      const unquotable = await this.unquotableLines(run, prId);
      if (unquotable.length > 0) {
        const quotable = await run<{ n: number }>(
          `SELECT count(*)::int AS n
             FROM proc.pr_lines pl
            WHERE pl.pr_id = $1::uuid AND pl.rejected = false
              AND ${RFQ_ELIGIBLE_LINE_PREDICATE}`,
          [prId],
        );
        if (Number(quotable.rows[0]?.n ?? 0) === 0) {
          throw new BadRequestException(this.describeUnquotable(p.pr_number, unquotable));
        }
      }

      const { vendorIds, shortfall, warnings } = await this.resolveVendors(run, prId, body.vendorIds);

      // rfq_check: deadline_at >= created_at + 24h. Display-only per Q2.
      const deadline = this.resolveDeadline(body.deadlineAt);
      const title = (body.title || p.title || p.pr_number).trim();
      const currency = (body.currency || p.currency || 'PKR').trim();

      if (body.singleSource && !(body.singleSourceJustification || '').trim()) {
        throw new BadRequestException(
          'a single-source justification is required when single_source is set',
        );
      }

      const num = await run<{ rfq_number: string }>(
        `SELECT proc.fn_next_rfq_number() AS rfq_number`,
      );
      const rfqNumber = num.rows[0].rfq_number;

      const ins = await run<any>(
        `INSERT INTO proc.rfq
           (rfq_number, pr_id, created_by_user_id, deadline_at, state,
            single_source, single_source_justification, currency, incoterm,
            created_at, issued_at, title, initial_deadline_at)
         VALUES ($1, $2::uuid, $3::uuid, $4, 'Open',
                 $5, $6, $7, $8, now(), now(), $9, $4)
         RETURNING id, rfq_number, issued_at, deadline_at, currency, title`,
        [
          rfqNumber, prId, userId, deadline, body.singleSource === true,
          body.singleSourceJustification || null, currency, body.incoterm || null, title,
        ],
      );
      const rfq = ins.rows[0];

      // Snapshot the PR's lines onto the RFQ. This is NOT optional: the schema
      // carries FOREIGN KEY (quotation_id, rfq_line_no) REFERENCES
      // rfq_lines(rfq_id, line_no), so without these rows a per-line quote is
      // rejected outright. Wave 2 step 1 shipped the RFQ without them and the
      // per-line path was silently unusable; migration 026 backfilled the
      // rows that were missed, and this closes the door on new RFQs.
      const lineCount = await this.snapshotRfqLines(run, rfq.id, prId);
      if (lineCount === 0) {
        // Unreachable while the pre-flight gate above is in place — it counts the
        // same rows with the same predicate. Kept anyway, and kept LOUD, because
        // this statement sits after the INSERT: if the two ever do disagree, the
        // RFQ row is already committed and DbService will not roll it back. A
        // throw here is the last chance to say so in the response rather than
        // leave a silent orphan for the next attempt to trip over.
        throw new BadRequestException(
          'this PR has no lines to put on an RFQ — an RFQ must snapshot at least one line. ' +
          `An RFQ row (${rfq.rfq_number}) was created for this attempt and must be ` +
          'cancelled before the PR can be issued again.',
        );
      }

      const invitations = [];
      for (const vendorId of vendorIds) {
        invitations.push(await this.insertInvitation(run, rfq.id, vendorId));
      }

      return {
        rfq: {
          id: rfq.id,
          rfq_number: rfq.rfq_number,
          pr_id: prId,
          pr_number: p.pr_number,
          title: rfq.title,
          state: 'Open',
          currency: rfq.currency,
          deadline_at: rfq.deadline_at,
          issued_at: rfq.issued_at,
        },
        invitations: invitations.map((i: any) => ({
          invitation_id: i.invitation_id,
          vendor_id: i.vendor_id,
          vendor_code: i.vendor_code,
          vendor_name: i.vendor_name,
          invited_at: i.invited_at,
          on_approved_roster: i.on_approved_roster,
          // DELIVERED ONCE. Only sha256(token) is stored.
          token: i.token,
          accept_path: `/rfq/invite/accept/${i.token}`,
        })),
        // The prototype's pushEvent() line, rebuilt from real data.
        event: {
          action: 'RFQ issued',
          detail: `${rfq.rfq_number} sent to ${vendorIds.length} vendor` +
            `${vendorIds.length === 1 ? '' : 's'}`,
        },
        // rfqIssue() always ends with 3 vendors. When the eligible pool was
        // short we did NOT reach 3, and the UI must say so and offer the
        // top-up rather than implying a compliant 3-quote competition.
        roster_shortfall: shortfall,
        ...(shortfall > 0
          ? {
              warning:
                `Only ${vendorIds.length} vendor(s) were eligible to invite ` +
                `(${shortfall} short of the ${DEFAULT_VENDOR_COUNT} ` +
                `the prototype issues to). Use POST /rfq/${rfq.id}/invite to top the roster up.`,
            }
          : {}),
        // Named vendors that are held, or un-categorised and invited by hand.
        // The UI shows these so an admin knows exactly who was dropped and why,
        // instead of discovering a silently short roster later.
        ...(warnings.length ? { warnings } : {}),
      };
    });
  }

  // ── POST /rfq/:id/invite ────────────────────────────────────────────────
  /**
   * Add one more vendor to an open RFQ. The prototype's roster is editable
   * after issue, so this is the supported way to top the roster up to the
   * "Target ≥ 3 per RFQ" the rfq-list KPI advertises.
   *
   * THE SAME CHAIN-OF-CUSTODY GATE AS `reissue()`, and it was MISSING HERE.
   *
   * `reissue()` is the multi-vendor door; this is the single-vendor one, and
   * until now it checked only `rfq.state === 'Open'` — never the PR's stage.
   * Verified live before this fix: on a PR sitting at `QUOTES_RECEIVED`, with
   * quotes already returned and the competition in progress,
   * `POST /rfq/:id/invite` returned **201** and appended a fourth vendor to the
   * roster. Gating only the newer endpoint would have left the identical act
   * fully open one route over, which is worse than never gating either: the
   * control would have looked real while being trivially bypassed.
   *
   * The rule is the same and the reasoning is the same: the moment a PR leaves
   * `IN_PROCUREMENT_REVIEW`, the vendor set is a decided competition and the
   * actor who ran it holds no rights over it. Changes go back through the
   * audited workflow — reject with remarks, routed back to procurement.
   */
  async invite(
    rfqId: string,
    userId: string,
    role: string,
    costCenterIds: string[],
    body: InviteVendorInput,
  ) {
    if (!roleAllowed(role, 'procurement')) {
      throw new ForbiddenException('Only Procurement can invite vendors to an RFQ.');
    }
    if (!body?.vendorId) throw new BadRequestException('vendorId is required');

    return this.db.withTransaction({ userId, role, costCenterIds }, async (run) => {
      // Joined to the PR because the gate is on the PR's stage. Before this the
      // query could not even SEE the stage, so no gate was possible.
      const rfq = await run<any>(
        `SELECT rf.id, rf.rfq_number, rf.state, pr.status AS pr_status
           FROM proc.rfq rf
           JOIN proc.purchase_requisitions pr ON pr.id = rf.pr_id
          WHERE rf.id = $1::uuid`,
        [rfqId],
      );
      if (rfq.rows.length === 0) throw new NotFoundException('RFQ not found');

      if (!RFQ_REISSUE_STAGES.includes(rfq.rows[0].pr_status)) {
        throw new BadRequestException(
          `RFQ ${rfq.rows[0].rfq_number} cannot take new vendors once the PR has left ` +
          `${RFQ_REISSUE_STAGES[0]} (stage: ${rfq.rows[0].pr_status}). ` +
          'Adding a vendor now would change a competition that has already been decided ' +
          'or forwarded. Reject the PR with remarks to return it to procurement.',
        );
      }
      if (rfq.rows[0].state !== 'Open') {
        throw new BadRequestException(
          `RFQ is ${rfq.rows[0].state} — no further invitations can be issued`,
        );
      }

      const i = await this.insertInvitation(run, rfqId, body.vendorId);
      return {
        invitation_id: i.invitation_id,
        vendor_id: i.vendor_id,
        vendor_code: i.vendor_code,
        vendor_name: i.vendor_name,
        invited_at: i.invited_at,
        on_approved_roster: i.on_approved_roster,
        token: i.token,
        accept_path: `/rfq/invite/accept/${i.token}`,
      };
    });
  }

  // ── POST /pr/:id/rfq/reissue ─────────────────────────────────────────────
  /**
   * RE-ISSUE — the prototype's "Re-issue RFQ" button, which every branch of the
   * action bar offers once an RFQ exists (prototype lines 2983 / 2985 / 2989,
   * all calling the SAME `lightProcIssueRFQ()` the first issue uses).
   *
   * A TOP-UP ON THE SAME RFQ. Never a second `proc.rfq` row. The prototype is
   * explicit about this — `const existingRfqId = hasPriorRfq ? pr.procurement.rfq.id
   * : 'RFQ-' + pr.id + ...` — because every quotation, every award and every
   * vendor portal link hangs off that one identifier. Minting a new RFQ here
   * would orphan the quotes already received against the old one.
   *
   * WHY THE STAGE GATE IS TIGHTER THAN issue()'s
   * ----------------------------------------------
   * `issue()` keeps `RFQ_ISSUE_STAGES` verbatim from the prototype. A RE-ISSUE
   * is gated on `RFQ_REISSUE_STAGES` — `IN_PROCUREMENT_REVIEW` only — and this
   * is the chain of custody, not a usability decision.
   *
   * Once a PR leaves procurement (a comparative statement exists, a winner is
   * chosen, it has been forwarded to cost centre / finance / D365), procurement
   * holds no write rights over it. Adding a vendor at that point rewrites a
   * competition that has already been decided, with no involvement from the
   * authority that now owns the document and no audit entry from it. That is a
   * vendor-selection fraud shape, and it is precisely what the workflow's
   * per-stage actor check exists to prevent — this endpoint would have been a
   * hole straight through it.
   *
   * The sanctioned route already exists and is not a workaround: procurement
   * REJECTS the PR with mandatory remarks, the current holder sends it back,
   * and it re-enters `IN_PROCUREMENT_REVIEW` through the audited workflow. A
   * buyer who finds a problem late is not left without recourse — they are
   * routed through the control.
   *
   * An earlier revision of this method deliberately widened the gate to "any
   * stage where the RFQ is still Open", arguing that a buyer who noticed a
   * drop-out after the PR moved on would otherwise have no action. That was
   * wrong, and the owner rejected it: having no action IS the control.
   *
   * RE-SELECTING AN EXISTING VENDOR IS A NO-OP, NOT AN ERROR. The prototype
   * seeds the dialog with `previouslySelected` and lets the officer submit
   * unchanged; `insertInvitation()` would refuse every one of them with
   * "already on this RFQ's roster" and roll the whole top-up back. The roster is
   * therefore diffed here and only genuinely new vendors are invited — which is
   * also what makes the shared dialog safe to open and close without acting.
   */
  async reissue(
    prId: string,
    userId: string,
    role: string,
    costCenterIds: string[],
    body: ReissueRfqInput,
  ) {
    // rfqIssue()/lightProcIssueRFQ(): "Only Procurement can issue an RFQ."
    if (!roleAllowed(role, 'procurement')) {
      throw new ForbiddenException('Only Procurement can re-issue an RFQ.');
    }

    return this.db.withTransaction({ userId, role, costCenterIds }, async (run) => {
      // The live rfq — a Cancelled one is not a top-up target, matching the
      // `state <> 'Cancelled'` rule `issue()` and `sourcing()` both use to
      // answer "does this PR have an RFQ".
      //
      // `deadline_day` is the deadline rendered at DAY granularity in SQL rather
      // than sliced off a raw timestamptz in JS. See the day-granularity note at
      // the comparison below for why that difference is load-bearing.
      const rf = await run<any>(
        `SELECT rf.id, rf.rfq_number, rf.state, rf.reissue_count,
                rf.last_reissued_at, pr.pr_number, pr.status AS pr_status,
                rf.deadline_at,
                to_char(rf.deadline_at, 'YYYY-MM-DD') AS deadline_day
           FROM proc.rfq rf
           JOIN proc.purchase_requisitions pr ON pr.id = rf.pr_id
          WHERE rf.pr_id = $1::uuid AND rf.state <> 'Cancelled'
          ORDER BY rf.created_at DESC LIMIT 1`,
        [prId],
      );
      if (rf.rows.length === 0) {
        // Not a 404: the PR plainly exists, it just has nothing to re-issue.
        throw new BadRequestException(
          'this PR has no open RFQ to re-issue — use POST /pr/:id/rfq to issue one first',
        );
      }
      const rfq = rf.rows[0];

      // THE CHAIN-OF-CUSTODY GATE. Checked before anything is resolved or
      // written, so a refused re-issue leaves no trace at all — not even a
      // bumped `reissue_count`.
      //
      // The message names the sanctioned route on purpose. Telling a buyer
      // merely "not permitted" invites a workaround; telling them to reject the
      // PR with remarks tells them the control exists and is the way through.
      if (!RFQ_REISSUE_STAGES.includes(rfq.pr_status)) {
        throw new BadRequestException(
          `RFQ ${rfq.rfq_number} cannot be re-issued once the PR has left ` +
          `${RFQ_REISSUE_STAGES[0]} (stage: ${rfq.pr_status}). ` +
          'Adding a vendor now would change a competition that has already been ' +
          'decided or forwarded. To change it, reject the PR with remarks so it ' +
          'returns to procurement through the audited workflow.',
        );
      }

      if (rfq.state !== 'Open') {
        throw new BadRequestException(
          `RFQ ${rfq.rfq_number} is ${rfq.state} — no further invitations can be issued`,
        );
      }

      // The roster as it stands. Diffed, not rejected — see the class comment.
      const onRoster = await run<any>(
        `SELECT vendor_id FROM proc.rfq_invitations WHERE rfq_id = $1::uuid`,
        [rfq.id],
      );
      const already = new Set(onRoster.rows.map((r: any) => r.vendor_id));

      // `vendorIds` is STRICTLY OPT-IN. Omitting it must add nobody.
      //
      // This is not a defensive nicety. `resolveVendors()` falls through to an
      // automatic pool pick when handed no explicit list — correct for a FIRST
      // issue, where the pool IS the roster about to be created, and wrong
      // here: a caller who sends `{ deadlineAt }` alone to push the quote date
      // out would silently have every eligible vendor on the estate invited to
      // a live RFQ. Widening a competition is a consequential act and must
      // never be a side effect of moving a date.
      //
      // The prototype's dialog always submits the ticked list, so this costs
      // the real UI nothing — and it keeps the deadline-only top-up honest.
      const named = body.vendorIds && body.vendorIds.length ? body.vendorIds : undefined;
      const { vendorIds, warnings } = named
        ? await this.resolveVendors(run, prId, named)
        : { vendorIds: [] as string[], warnings: [] as string[] };
      const fresh = vendorIds.filter((id) => !already.has(id));

      // The deadline may legitimately be the ONLY thing that changes: the
      // prototype's dialog carries the date over and lets the officer push it
      // out.
      //
      // COMPARED AT DAY GRANULARITY, and this is a bug that shipped once.
      // The shared dialog edits a `<input type="date">`, so its unit of change
      // is a calendar DAY and it round-trips as `yyyy-mm-dd` — midnight. The
      // first issue had stored `created_at + 7 days`, i.e. a deadline carrying
      // the clock time it was created at. Comparing that stored timestamp
      // against the submitted midnight found them different EVERY time, so
      // "add one vendor and press Send" silently rewrote the deadline from
      // 2026-10-18 11:05 to 2026-10-18 00:00. The buyer never touched the
      // field. The vendor's "Due" date in the dispatch email moved, and
      // `deadline_extended` reported a change that nobody made.
      //
      // `resolveDeadline()` is called ONLY when the day really differs, which
      // also matters for its 24h-from-now floor: a stored deadline that has
      // since passed would be rejected outright, making an expired-but-open
      // RFQ impossible to top up — the exact case a top-up exists for.
      const requestedDay = (body.deadlineAt || '').slice(0, 10);
      const deadlineMoved = Boolean(requestedDay) && requestedDay !== rfq.deadline_day;
      const nextDeadline = deadlineMoved ? this.resolveDeadline(body.deadlineAt) : null;

      // Refuse rather than silently do nothing. A re-issue that adds no vendor
      // and moves no date would still bump `reissue_count`, and the "Re-issued
      // xN" chip on the PR grid would then assert a sourcing event that never
      // happened.
      if (fresh.length === 0 && !deadlineMoved) {
        throw new BadRequestException(
          already.size === 0
            ? 'nothing to re-issue: this RFQ has no vendors on its roster'
            : `nothing to re-issue: every selected vendor is already on ${rfq.rfq_number}'s roster ` +
              'and the quote deadline is unchanged. Pick at least one new vendor, or set a different deadline.',
        );
      }

      const invitations = [];
      // The number this re-issue will BE. Read before the UPDATE below bumps
      // `reissue_count`, so the invitations, the history row and the counter all
      // agree on one ordinal instead of each deriving its own.
      const reissueNo = Number(rfq.reissue_count || 0) + 1;
      for (const vendorId of fresh) {
        invitations.push(await this.insertInvitation(run, rfq.id, vendorId, reissueNo));
      }

      // The event stamp. Inside the same transaction as the invitations, so a
      // failed invite cannot leave the RFQ claiming a re-issue that added nobody.
      // The CHECK rfq_reissue_stamp_consistent holds because count and stamp
      // move together on one row.
      const upd = await run<any>(
        `UPDATE proc.rfq
            SET reissue_count    = reissue_count + 1,
                last_reissued_at = now(),
                deadline_at      = COALESCE($2::timestamptz, deadline_at)
          WHERE id = $1::uuid
        RETURNING reissue_count, last_reissued_at, deadline_at`,
        [rfq.id, nextDeadline],
      );
      const after = upd.rows[0];

      // ── THE HISTORY ROW ──────────────────────────────────────────────────
      // `proc.rfq` keeps only the CURRENT deadline; the UPDATE above has just
      // overwritten the one the buyer was originally working to. This row is the
      // only place that value survives, which is what lets the detail page show
      // "issued / deadline A | re-issued / deadline B" rather than just B.
      await run(
        `INSERT INTO proc.rfq_reissues
           (rfq_id, reissue_no, reissued_at, deadline_before, deadline_after,
            vendors_added, actor_user_id)
         VALUES ($1::uuid, $2::int, $3::timestamptz, $4::timestamptz, $5::timestamptz,
                 $6::int, $7::uuid)`,
        [rfq.id, reissueNo, after.last_reissued_at, rfq.deadline_at,
         after.deadline_at, fresh.length, userId],
      );

      // ── THE AUDIT ROW ────────────────────────────────────────────────────
      // proc.rfq carries no audit trigger, so without this the re-issue updated
      // reissue_count and last_reissued_at and left NOTHING in audit.audit_log.
      // That is the one event on this document which changes who is competing
      // against whom, and it was the one event with no trail.
      //
      // Placed after every gate: the chain-of-custody refusal and the
      // nothing-to-do refusal both throw earlier, so neither can leave an audit
      // row for an action that did not happen.
      await run(
        `INSERT INTO audit.audit_log
           (actor_user_id, entity, entity_id, action, before, after, reason)
         VALUES ($1::uuid, 'proc.rfq', $2::uuid, 'rfq_reissue', $3::jsonb, $4::jsonb, $5)`,
        [
          userId, rfq.id,
          JSON.stringify({
            deadline_at: rfq.deadline_at,
            reissue_count: Number(rfq.reissue_count || 0),
            last_reissued_at: rfq.last_reissued_at,
          }),
          JSON.stringify({
            rfq_number: rfq.rfq_number,
            pr_number: rfq.pr_number,
            reissue_no: reissueNo,
            reissue_count: Number(after.reissue_count),
            reissued_at: after.last_reissued_at,
            deadline_at: after.deadline_at,
            deadline_extended: deadlineMoved,
            vendors_added: fresh.length,
            roster_size: already.size + fresh.length,
          }),
          `RFQ ${rfq.rfq_number} re-issued (re-issue #${reissueNo}): ` +
            `${fresh.length} vendor(s) added` +
            (deadlineMoved ? ', quote deadline extended' : ', deadline unchanged'),
        ],
      );

      return {
        // `mode` is what the shared dialog reads to render "Re-issue RFQ"
        // instead of "Issue RFQ" without the client having to infer it from the
        // absence of an id.
        mode: 'reissue' as const,
        rfq: {
          id: rfq.id,
          rfq_number: rfq.rfq_number,
          pr_id: prId,
          pr_number: rfq.pr_number,
          title: null,
          state: rfq.state,
          currency: null,
          deadline_at: after.deadline_at,
          issued_at: null,
          reissue_count: Number(after.reissue_count),
          last_reissued_at: after.last_reissued_at,
        },
        added: fresh.length,
        already_on_roster: already.size,
        deadline_extended: deadlineMoved,
        invitations: invitations.map((i: any) => ({
          invitation_id: i.invitation_id,
          vendor_id: i.vendor_id,
          vendor_code: i.vendor_code,
          vendor_name: i.vendor_name,
          invited_at: i.invited_at,
          on_approved_roster: i.on_approved_roster,
          // DELIVERED ONCE, exactly as on the first issue. Only sha256 is stored.
          token: i.token,
          accept_path: `/rfq/invite/accept/${i.token}`,
        })),
        // The prototype's pushEvent() line, rebuilt from real data.
        event: {
          action: 'RFQ re-issued',
          detail:
            `${rfq.rfq_number} re-issued (re-issue #${Number(after.reissue_count)}) — ` +
            `${fresh.length} vendor${fresh.length === 1 ? '' : 's'} added` +
            (deadlineMoved ? ', quote deadline extended' : ''),
        },
        ...(warnings.length ? { warnings } : {}),
      };
    });
  }

  // ── GET /pr/:id/sourcing ─────────────────────────────────────────────────
  /**
   * One call that powers BOTH detail-page cards.
   *
   * The prototype reads the same `pr.procurement` object from
   * _lightProcurementCard (RFQ & quotes) and _lightRosterCard (vendor roster),
   * and the plan called for a single request rather than two. This returns
   * that object in the prototype's own shape — `rfq`, `quotes`, `winner`,
   * `selectedQuoteIndex` — plus the derived `subStatus` ladder the card header
   * shows, so the renderer is a projection of this response and not a place
   * where business rules hide.
   *
   * Returns a well-formed empty procurement object when no RFQ exists yet, so
   * the card can render its "Click Issue RFQ to start the procurement flow."
   * empty state rather than having to special-case null.
   */
  async sourcing(prId: string, userId: string, role: string, costCenterIds: string[]) {
    const ctx = { userId, role, costCenterIds };
    // Prototype `data-roles` for the two cards' screen (light-pr-detail) is
    // 'all', so every authenticated user may read sourcing. The cards simply
    // do not render outside IN_PROCUREMENT_REVIEW / READY_FOR_D365, and the
    // renderer applies that gate.
    const pr = await this.db.query<any>(
      `SELECT pr.id, pr.pr_number, pr.title, pr.status, pr.currency,
              pr.estimated_amount, pr.urgency, pr.flow_kind
         FROM proc.purchase_requisitions pr
        WHERE pr.id = $1::uuid`,
      [prId],
      ctx,
    );
    if (pr.rows.length === 0) throw new NotFoundException('PR not found');
    const p = pr.rows[0];

    const rf = await this.db.query<any>(
      `SELECT id, rfq_number FROM proc.rfq
        WHERE pr_id = $1::uuid AND state <> 'Cancelled'
        ORDER BY created_at DESC LIMIT 1`,
      [prId],
      ctx,
    );

    if (rf.rows.length === 0) {
      // The cards are ENABLED here, not disabled: this is precisely the state
      // that renders "Click Issue RFQ to start the procurement flow." (the
      // prototype's `_lightProcurementCard` body when `rfq` is falsy). Gating on
      // "an RFQ exists" would hide the one screen that tells the reader to
      // create one. What gates the cards is the PR's STAGE, exactly as the
      // prototype does at lines 6076 and 6195.
      const inSourcingStage = ['IN_PROCUREMENT_REVIEW', 'READY_FOR_D365'].includes(p.status);
      return {
        pr: this.prSummary(p),
        procurement: emptyProcurement(),
        sub_status: subStatus(false, false, false),
        cards: { procurement_card: inSourcingStage, roster_card: inSourcingStage },
        empty_reason: 'no RFQ has been issued on this PR yet',
      };
    }

    const rfqId = rf.rows[0].id;
    const detail = await this.buildDetail(rfqId, ctx);
    const quotes = await this.liveQuotes(rfqId, ctx);
    const winner = await this.lockedWinner(prId, ctx);
    // W5-G: a split lock has no `vendor_id`, so `findIndex` would match nothing
    // and `selectedQuoteIndex` stays -1, leaving the card on its "select
    // winner" state on a package that was already decided line by line. The
    // winning vendors are therefore marked on their own quote rows instead, and
    // `winner.split` is passed through so the UI can render the per-line table.
    const splitVendorIds = new Set(
      ((winner as any)?.split || []).map((s: any) => s.vendor_id),
    );
    const selectedQuoteIndex = winner && (winner as any).vendor_id
      ? quotes.findIndex((q: any) => q.vendor_id === (winner as any).vendor_id)
      : -1;

    // rfq.issuedAtByVendor — the prototype's per-vendor issue stamp, falling
    // back to the RFQ-level issued_at for a vendor whose own stamp is missing.
    const issuedAtByVendor: Record<string, string> = {};
    for (const row of detail.roster) issuedAtByVendor[row.vendor_id] = row.issued_at;

    return {
      pr: this.prSummary(p),
      procurement: {
        rfq: {
          id: detail.rfq.rfq_number,
          rfq_id: detail.rfq.id,
          vendorIds: detail.roster.map((r: any) => r.vendor_id),
          issuedAt: detail.rfq.issued_at,
          issuedAtByVendor,
          deadline: detail.rfq.deadline_at,
          // ── THE RE-ISSUE STORY, SIDE BY SIDE WITH THE ORIGINAL ──────────────
          // `initial_deadline_at` is never mutated, so it is the only surviving
          // record of the date the competition was originally run to. The detail
          // page shows it beside `deadline`, because a re-issue moves the live
          // deadline in place and the original is otherwise unrecoverable.
          initialDeadline: detail.rfq.initial_deadline_at ?? null,
          reissueCount: Number(detail.rfq.reissue_count || 0),
          lastReissuedAt: detail.rfq.last_reissued_at ?? null,
          state: detail.rfq.state,
          notes: null,
          notesByVendor: null,
        },
        // The prototype's flat quotes[] — one entry per vendor, holding the
        // LIVE version only. The full chain is in `roster[].versions`.
        quotes,
        selectedQuoteIndex,
        winner,
      },
      // The card header's sub-status, verbatim from _lightProcurementCard.
      sub_status: subStatus(true, quotes.length > 0, Boolean(winner)),
      roster: detail.roster,
      roster_tally: detail.roster_tally,
      // Both cards gate on the same two stages (prototype lines 6076, 6195).
      cards: {
        procurement_card: ['IN_PROCUREMENT_REVIEW', 'READY_FOR_D365'].includes(p.status),
        roster_card: ['IN_PROCUREMENT_REVIEW', 'READY_FOR_D365'].includes(p.status),
      },
    };
  }

  /** The live (Submitted or Awarded) version of every vendor's quote, newest last. */
  private async liveQuotes(rfqId: string, ctx: SourcingCtx) {
    const r = await this.db.query<any>(
      `SELECT DISTINCT ON (q.vendor_id)
              q.id, q.vendor_id, q.version, q.state, q.total_amount, q.currency,
              q.normalized_total_pkr, q.lead_time_days, q.warranty_months,
              q.validity_days, q.valid_until, q.submitted_at, q.quote_mode, q.taxes_included,
              v.vendor_code, v.legal_name, v.state AS vendor_state,
              -- WARRANTY IS USUALLY RECORDED PER LINE, NOT ON THE HEADER.
              --
              -- The procurement "Receive Quotation" grid collects a warranty cell
              -- per line and sends it inside the lines array; nothing ever sends a
              -- header warrantyMonths. So proc.quotations.warranty_months is NULL
              -- for every quote recorded through the UI, while the data a buyer
              -- actually entered sits in proc.quotation_lines. Measured on this
              -- estate: 300 of 1408 quote lines carry a line warranty with a NULL
              -- header.
              --
              -- Every read path that rendered the header column therefore drew an
              -- em-dash over a warranty that HAD been captured — which reads as
              -- "this vendor offers no warranty", the exact opposite of the truth,
              -- and is commercially dangerous: a real 10-month warranty scoring
              -- zero is a vendor losing an award they qualified for.
              --
              -- award.service.ts:132 already resolves this with
              -- line_warranty_months ?? warranty_months. This does the same, and
              -- additionally returns the MAX so the UI can show the true range
              -- instead of silently picking one number when lines differ.
              (SELECT min(ql.warranty_months) FROM proc.quotation_lines ql
                WHERE ql.quotation_id = q.id AND ql.warranty_months IS NOT NULL) AS line_warranty_min,
              (SELECT max(ql.warranty_months) FROM proc.quotation_lines ql
                WHERE ql.quotation_id = q.id AND ql.warranty_months IS NOT NULL) AS line_warranty_max,
              -- The vendor's own document, pinned to THIS version.
              --
              -- proc.quotation_attachments exists precisely so an auditor asking
              -- "what did they actually send?" gets the scan that was quoted, not
              -- whatever was attached later. A VOIDed document is excluded rather
              -- than offered as a View button that 404s — download() keeps a
              -- SUPERSEDED file readable on purpose, but a voided one is retired
              -- and must not look available.
              COALESCE((
                SELECT jsonb_agg(
                         jsonb_build_object('id', qa.attachment_id, 'name', ar.name, 'kind', qa.kind)
                         ORDER BY qa.created_at)
                  FROM proc.quotation_attachments qa
                  JOIN core.attachment_registry ar ON ar.id = qa.attachment_id
                 WHERE qa.quotation_id = q.id AND ar.status <> 'VOID'
              ), '[]'::jsonb) AS attachments
         FROM proc.quotations q
         JOIN core.vendors v ON v.id = q.vendor_id
        WHERE q.rfq_id = $1::uuid
          AND q.state IN ('Submitted','Awarded')
        ORDER BY q.vendor_id, q.version DESC`,
      [rfqId],
      ctx,
    );

    return r.rows.map((q: any) => {
      const onRoster = APPROVED_VENDOR_STATES.includes(q.vendor_state);
      return {
        id: q.id,
        vendor_id: q.vendor_id,
        vendor_name: q.legal_name,
        vendor_code: q.vendor_code,
        version: Number(q.version),
        state: q.state,
        // The REAL grand total. The prototype synthesises a unit price by
        // dividing the total by the PR quantity and then multiplies it back —
        // a lossy round-trip that is wrong for any multi-line PR. We carry the
        // total as recorded. `unit_price` stays null: for a grand-total quote
        // no unit price exists, and inventing one is what the prototype's own
        // v2.0.x-audit-rules rule was blanking the Unit column to avoid.
        total: Number(q.total_amount),
        total_currency: q.currency,
        // No unit price is invented here — for a grand-total quote none exists.
        // The Unit column was removed from the card entirely (owner decision);
        // per-line prices live in the Versions Panel.
        unit_price: null,
        lead_time_days: q.lead_time_days === null ? null : Number(q.lead_time_days),
        // Header first, then the lines the quote really was recorded against —
        // see the SELECT for why the header is usually NULL. `…_max` is exposed
        // so a caller can show the range rather than an invented single figure.
        warranty_months: q.warranty_months === null
          ? (q.line_warranty_min === null ? null : Number(q.line_warranty_min))
          : Number(q.warranty_months),
        warranty_months_max: q.line_warranty_max === null
          ? null
          : Number(q.line_warranty_max),
        warranty_from_lines: q.warranty_months === null && q.line_warranty_min !== null,
        valid_until_days: q.validity_days === null ? null : Number(q.validity_days),
        // The recorded expiry date. `validity_days` is a DIFFERENT thing — a
        // duration — and it is NULL on quotes that carry a real `valid_until`.
        // Reporting only the duration is why the RFQ screen showed two em-dashes
        // beside "Valid" for quotes whose validity date was on file all along.
        valid_until: q.valid_until ?? null,
        received_at: q.submitted_at,
        quote_mode: q.quote_mode,
        taxes_included: q.taxes_included,
        // Q3 / plan item 8: the prototype's `isNewVendor` flag, which drives
        // the "Pending approval" badge. Off the approved roster => pending.
        is_new_vendor: !onRoster,
        on_approved_roster: onRoster,
        // Always an array, never null: "no document on this version" and "the
        // payload did not carry attachments" must not render the same.
        //
        // parseJsonb, NOT Array.isArray — see shapeQuote. A jsonb column crosses
        // the psql CSV bridge as a STRING, so an isArray test is always false
        // and the View button would be disabled on rows that do have a document.
        attachments: (() => {
          const parsed = parseJsonb(q.attachments);
          return Array.isArray(parsed)
            ? parsed.map((a: any) => ({ id: a.id, name: a.name, kind: a.kind }))
            : [];
        })(),
      };
    });
  }

  /**
   * The winner recorded by a LOCKED comparative statement. The CS lock in step
   * 6 writes `comparative_statements.recommendation`; until then there is no
   * winner and the cards show their "select winner" state. Read defensively
   * because `recommendation` is free-form jsonb.
   */
  private async lockedWinner(prId: string, ctx: SourcingCtx) {
    const r = await this.db.query<any>(
      `SELECT recommendation FROM proc.comparative_statements
        WHERE pr_id = $1::uuid AND state = 'Locked' LIMIT 1`,
      [prId],
      ctx,
    );
    if (r.rows.length === 0) return null;
    const rec = parseJsonb(r.rows[0].recommendation);

    // W5-G: a SPLIT lock has no winner_vendor_id, so returning null here made the
    // RFQ cards show their "select winner" state forever on a package that was
    // already decided — line by line. The split is reported in the same shape so
    // a caller that only knows about `vendor_id` sees null rather than a lie,
    // and a caller that knows about splits sees the real decision.
    const split = Array.isArray(rec?.split) && rec.split.length > 0
      ? rec.split.map((s: any) => ({
          line_no: Number(s.line_no),
          vendor_id: s.vendor_id,
          vendor_name: s.vendor_name ?? null,
          awarded_qty: s.awarded_qty === undefined ? null : Number(s.awarded_qty),
          justification: s.justification ?? null,
        }))
      : null;

    if (!rec) return null;
    if (split) {
      return {
        vendor_id: null,
        vendor_name: null,
        quotation_id: null,
        total: null,
        reason: rec.reason ?? null,
        override_reason: rec.override_reason ?? null,
        lead_time_days: null,
        split,
      };
    }

    if (!rec.winner_vendor_id) return null;
    return {
      vendor_id: rec.winner_vendor_id,
      vendor_name: rec.winner_vendor_name ?? null,
      quotation_id: rec.winner_quotation_id ?? null,
      total: rec.winner_total === undefined ? null : Number(rec.winner_total),
      reason: rec.reason ?? null,
      override_reason: rec.override_reason ?? null,
      lead_time_days: rec.lead_time_days ?? null,
      split: null,
    };
  }

  /**
   * D5 — compliance is DERIVED, never assumed.
   *
   * renderRFQDetail hardcodes `✓ Pass` in the Compliance column for every bid.
   * The prototype has no compliance source at all, so that is a decorative
   * constant, not a finding — and rendering it in a real system would assert a
   * due-diligence result nobody ever performed.
   *
   * So: read core.vendor_due_diligence. A vendor with an APPROVED record is a
   * genuine pass. Everyone else — no record, one still in progress, a rejected
   * one — is `unknown` and renders as `—`, which is what the plan called for.
   *
   * One query for the whole RFQ rather than one per bid.
   */
  private async complianceMap(vendorIds: string[], ctx: SourcingCtx) {
    const map = new Map<string, { status: 'pass' | 'unknown' | 'fail'; label: string }>();
    for (const id of vendorIds) map.set(id, COMPLIANCE_UNKNOWN);
    if (vendorIds.length === 0) return map;

    const r = await this.db.query<any>(
      `SELECT DISTINCT ON (vendor_id) vendor_id, state
         FROM core.vendor_due_diligence
        WHERE vendor_id = ANY($1::uuid[])
        ORDER BY vendor_id, started_by_user_id DESC`,
      [`{${vendorIds.join(',')}}`],
      ctx,
    );
    for (const row of r.rows) {
      const st = String(row.state || '');
      if (st === 'Approved' || st === 'Manager_Approved' || st === 'DD_Approved') {
        map.set(row.vendor_id, { status: 'pass', label: '✓ Pass' });
      } else if (st === 'Rejected') {
        map.set(row.vendor_id, { status: 'fail', label: '✕ Failed' });
      } else {
        // Pending_DD / DD_In_Progress / anything unrecognised: a check was
        // started but has not concluded. That is NOT a pass.
        map.set(row.vendor_id, COMPLIANCE_UNKNOWN);
      }
    }
    return map;
  }

  private prSummary(p: any) {
    return {
      id: p.id,
      pr_number: p.pr_number,
      title: p.title,
      status: p.status,
      currency: p.currency,
      estimated_amount: Number(p.estimated_amount || 0),
      urgency: p.urgency,
      flow_kind: p.flow_kind,
    };
  }

  // ── internals ───────────────────────────────────────────────────────────

  /**
   * Copy the PR's lines onto the RFQ.
   *
   * `description` is NOT NULL here but nullable on proc.pr_lines, so fall back
   * through the item name and finally to a positional label — never ''. The
   * supplier quote screen (renderSupplierQuote) renders SKU + description + qty
   * + UoM straight off these rows, so a blank description would be a blank
   * line in the vendor's inbox.
   */
  private async snapshotRfqLines(
    run: <U = any>(sql: string, params?: any[]) => Promise<{ rows: U[]; rowCount: number }>,
    rfqId: string,
    prId: string,
  ): Promise<number> {
    const r = await run<{ inserted: string }>(
      `WITH eligible AS (
         SELECT pl.id,
                pl.line_no,
                GREATEST(
                  pl.quantity
                  - CASE WHEN pl.fulfilment_source = 'STORE_STOCK'
                         THEN COALESCE(pl.store_fulfilled_qty, 0) ELSE 0 END,
                  0
                ) AS pending_qty
           FROM proc.pr_lines pl
          WHERE pl.pr_id = $2::uuid
            -- The ONE definition of "this line can be quoted". The roster in the
            -- modal and the dead-end gate both read it, so the three cannot
            -- disagree about which lines this RFQ will carry.
            AND ${RFQ_ELIGIBLE_LINE_PREDICATE}
            -- Rejected lines are NEVER snapshotted. A rejected line was thrown
            -- out by the HOD; copying it onto an RFQ puts it out for quote to
            -- vendors who have no business pricing it. categoryPool() and
            -- unsourceableCategories() have always filtered it, so this is
            -- where the write finally caught up with the preview — 11 PRs at
            -- IN_PROCUREMENT_REVIEW held lines that would have gone out this way.
            AND pl.rejected = false
       ),
       excluded AS (
         -- A STORE_STOCK line with a pending REMAINDER still belongs on the RFQ
         -- at that remainder. Only a line with nothing left to buy is excluded,
         -- and the two are different decisions: "fulfilled" vs "partly
         -- fulfilled". An earlier version filtered on fulfilment_source
         -- outright and silently dropped a partly-fulfilled line, which is the
         -- opposite of quoting the pending quantity.
         INSERT INTO proc.rfq_line_exclusions (rfq_id, pr_line_id, line_no, reason, quantity)
         SELECT $1::uuid, pl.id, pl.line_no,
                CASE
                  WHEN COALESCE(pl.rejected, false)
                    THEN 'rejected' || COALESCE(' — ' || NULLIF(btrim(pl.rejected_reason), ''), '')
                  WHEN COALESCE(pl.held, false)
                    THEN 'held' || COALESCE(' — ' || NULLIF(btrim(pl.held_reason), ''), '')
                  WHEN GREATEST(pl.quantity
                      - CASE WHEN pl.fulfilment_source = 'STORE_STOCK'
                             THEN COALESCE(pl.store_fulfilled_qty, 0) ELSE 0 END, 0) = 0
                    THEN 'fully fulfilled from store stock'
                  ELSE 'no pending quantity'
                END,
                pl.quantity
           FROM proc.pr_lines pl
          WHERE pl.pr_id = $2::uuid
            -- Every line that did NOT make it onto the RFQ is recorded here, with
            -- the reason. A rejected line must appear too: dropping it silently
            -- would leave the buyer unable to tell "excluded on purpose" apart
            -- from "lost". rfq_line_exclusions has no CHECK on reason, so the
            -- vocabulary is open — this row is the record.
            AND ( COALESCE(pl.rejected, false)
                  OR COALESCE(pl.held, false)
                  OR GREATEST(pl.quantity
                      - CASE WHEN pl.fulfilment_source = 'STORE_STOCK'
                             THEN COALESCE(pl.store_fulfilled_qty, 0) ELSE 0 END, 0) = 0 )
        ON CONFLICT (rfq_id, pr_line_id) DO UPDATE
          SET reason = EXCLUDED.reason, quantity = EXCLUDED.quantity
        RETURNING 1 AS inserted
       )
       INSERT INTO proc.rfq_lines (rfq_id, pr_line_id, line_no, description, quantity, uom)
       SELECT $1::uuid, e.id, e.line_no,
              COALESCE(NULLIF(btrim(pl.description), ''), it.name, 'Line ' || e.line_no),
              e.pending_qty,
              COALESCE(NULLIF(btrim(pl.uom), ''), it.uom, 'Unit')
         FROM eligible e
         JOIN proc.pr_lines pl ON pl.id = e.id
         LEFT JOIN core.items it ON it.id = pl.item_id
        -- No pending_qty filter here: RFQ_ELIGIBLE_LINE_PREDICATE already
        -- guarantees pending_qty > 0, and a second copy of that rule in the same
        -- statement is a second thing that can drift from the first.
        ON CONFLICT (rfq_id, line_no) DO NOTHING
       RETURNING 1 AS inserted`,
      [rfqId, prId],
    );
    return r.rowCount;
  }

  /**
   * Insert one invitation, returning the raw token exactly once.
   *
   * `UNIQUE(rfq_id, vendor_id)` is the duplicate-invite guard. A second invite
   * for the same vendor is a caller error, not a silent upsert — re-inviting a
   * vendor who already declined should be a deliberate, visible act.
   */
  private async insertInvitation(
    run: <U = any>(sql: string, params?: any[]) => Promise<{ rows: U[]; rowCount: number }>,
    rfqId: string,
    vendorId: string,
    /**
     * Which re-issue created this invitation. 0 = the original issue.
     *
     * Recorded here rather than derived from `invited_at > issued_at` because
     * that comparison is worthless in practice: every invitation, including the
     * very first, is stamped microseconds after `issued_at`. Measured — 1582 of
     * 1582 invitations on this database are "after" their RFQ's issue stamp.
     * Only the caller knows, so only the caller says.
     */
    reissueNo = 0,
  ) {
    const v = await run<any>(
      `SELECT v.id, v.vendor_code, v.legal_name, v.state, v.is_hold, v.hold_reason,
              c.score, c.risk_grade, c.blocked
         FROM core.vendors v
         CROSS JOIN LATERAL core.fn_vendor_composite(v.scorecard) AS c
        WHERE v.id = $1::uuid`,
      [vendorId],
    );
    if (v.rows.length === 0) throw new NotFoundException('vendor not found');
    const vendor = v.rows[0];

    // ── RULE 5: a HELD vendor is not invited, by any route.
    // Hold is the one status a local portal user controls, so it has to mean
    // something. Checking it here, at the only place an invitation is created,
    // means neither the automatic pool pick nor naming the vendor explicitly can
    // route around it.
    //
    // `is_hold` arrives as the string 'true'/'false' because DbService shells out
    // to psql, so a bare `if (vendor.is_hold)` is always truthy and would block
    // every vendor in the portal.
    if (vendor.is_hold === true || vendor.is_hold === 'true') {
      throw new BadRequestException(
        `${vendor.legal_name} is on hold and cannot be invited to an RFQ` +
          (vendor.hold_reason ? ` — hold reason: ${vendor.hold_reason}.` : '.') +
          ' Release the hold first if the vendor should return to the pool.',
      );
    }

    // ── BLUEPRINT 9.5: "High-risk vendors are blocked from new RFQ invitations
    // until remediation." Enforced here, at the ONLY place an invitation is
    // created, so it cannot be bypassed by the automatic pool pick or by naming
    // the vendor explicitly.
    //
    // The verdict comes from `core.fn_vendor_composite()` — the same SQL function
    // the Vendor Risk screen renders. A second TypeScript copy of the 40/35/25
    // arithmetic would be free to drift from the one this guard trusts.
    //
    // An UNSCORED vendor (composite NULL) is allowed through: `blocked` is null,
    // not true. Only an explicit High band blocks. Treating "not yet assessed" as
    // blocked would deadlock every new vendor out of sourcing, and treating it as
    // cleared is the existing, explicit onboarding-pending behaviour.
    if (vendor.blocked === true) {      throw new BadRequestException(
        `${vendor.legal_name} is blocked pending remediation — composite risk is ` +
          `High (${vendor.score}/100). High-risk vendors cannot be invited to new RFQs ` +
          `until their risk assessment improves.`,
      );
    }

    const token = newToken();
    try {
      // WAVE 5 TRACK F: every invitation is TIME-BOUND.
      //
      // Migration 040 made rfq_invitations.expires_at NOT NULL, so an insert
      // without it is refused — which is the point, but it means this statement
      // has to supply the value or EVERY new RFQ issuance 500s. The lifetime
      // comes from core.fn_vendor_token_ttl_hours(), the same fail-closed
      // configuration the dispatch path reads, so there is one number rather
      // than a second copy here that could drift.
      const r = await run<any>(
        `INSERT INTO proc.rfq_invitations
           (rfq_id, vendor_id, invited_at, token_hash, submitted, declined, expires_at, reissue_no)
         VALUES ($1::uuid, $2::uuid, now(), $3, false, false,
                 now() + (core.fn_vendor_token_ttl_hours() || ' hours')::interval,
                 $4::int)
         RETURNING id, invited_at, expires_at, reissue_no`,
        [rfqId, vendorId, hashToken(token), reissueNo],
      );
      return {
        invitation_id: r.rows[0].id,
        vendor_id: vendor.id,
        vendor_code: vendor.vendor_code,
        vendor_name: vendor.legal_name,
        invited_at: r.rows[0].invited_at,
        reissue_no: Number(r.rows[0].reissue_no),
        on_approved_roster: APPROVED_VENDOR_STATES.includes(vendor.state),
        token,
      };
    } catch (e: any) {
      const msg = String(e?.message || '');
      if (msg.includes('duplicate key') || msg.includes('unique')) {
        throw new BadRequestException(
          `${vendor.legal_name} is already on this RFQ's roster`,
        );
      }
      throw e;
    }
  }

  /**
   * The prototype's `rfqIssue()` sends to exactly 3 vendors. When the caller
   * does not name them, take up to N from the pool, approved vendors first —
   * `lightProcVendorPool()` is `lightVendorSeed` (approved) concat
   * `pendingVendors`, and the seed of that concat puts approved entries ahead
   * of pending ones. Blacklisted and deactivated vendors are excluded; that is
   * a procurement control, not a presentation choice.
   *
   * A SHORT POOL IS NOT AN ERROR. The pool is whatever onboarding has produced,
   * and the prototype's roster is explicitly top-up-able
   * (`POST /rfq/:id/invite`) — the rfq-list KPI even advertises
   * 'Target ≥ 3 per RFQ' as something to work toward, not an invariant. So we
   * issue to the whole pool and report `shortfall`, which the UI turns into the
   * "only N vendors on this RFQ — invite more" prompt. Hard-failing here would
   * strand a PR in procurement review with no way to source it.
   */
  private async resolveVendors(
    run: <U = any>(sql: string, params?: any[]) => Promise<{ rows: U[]; rowCount: number }>,
    prId: string,
    explicit?: string[],
  ): Promise<{ vendorIds: string[]; shortfall: number; warnings: string[] }> {
    if (explicit && explicit.length) {
      const want = Array.from(new Set(explicit));
      if (want.length > 12) throw new BadRequestException('at most 12 vendors per RFQ');
      const found = await run<any>(
        `SELECT id FROM core.vendors WHERE id = ANY($1::uuid[])`,
        [`{${want.join(',')}}`],
      );
      if (found.rows.length !== want.length) {
        const missing = want.filter(id => !found.rows.some((r: any) => r.id === id));
        throw new NotFoundException(`vendor not found: ${missing.join(', ')}`);
      }
      // Held and un-categorised vendors are reported back here rather than being
      // filtered out, because a caller who named them explicitly deserves to know
      // which ones will be dropped and why. insertInvitation() is the hard gate;
      // this is the honest warning. An un-categorised vendor can still be invited
      // by hand — rule 4 excludes them from the AUTOMATIC pool, and a human
      // inviting one on purpose is exactly the deliberate act it allows.
      const flags = await run<any>(
        `SELECT v.id, v.legal_name, v.is_hold,
                (SELECT count(*) FROM core.vendor_categories vc
                  WHERE vc.vendor_id = v.id AND vc.is_active) AS cat_count
           FROM core.vendors v WHERE v.id = ANY($1::uuid[])`,
        [`{${want.join(',')}}`],
      );
      const heldIds = new Set(
        flags.rows.filter((r: any) => r.is_hold === true || r.is_hold === 'true').map((r: any) => r.id),
      );
      const uncategorised = flags.rows
        .filter((r: any) => Number(r.cat_count) === 0 && r.is_hold !== true && r.is_hold !== 'true')
        .map((r: any) => r.legal_name);

      return {
        vendorIds: want,
        shortfall: Math.max(0, DEFAULT_VENDOR_COUNT - want.length),
        warnings: [
          ...(heldIds.size
            ? [`${heldIds.size} named vendor(s) are on hold and will be refused: ${[...heldIds]
                .map((id) => flags.rows.find((r: any) => r.id === id)?.legal_name)
                .filter(Boolean).join(', ')}`]
            : []),
          ...(uncategorised.length
            ? [`Un-categorised, invited by hand: ${uncategorised.join(', ')}. Map their categories so the automatic pool can reach them.`]
            : []),
        ],
      };
    }

    const { vendors: pool, categories, withheld } = await this.categoryPool(run, prId);
    if (pool.length === 0) {
      // Name the categories that resolved to nothing, AND the vendors that were
      // matched but withheld. The old query counted only un-categorised and held
      // vendors, so a PR whose only matched vendors were High-risk produced the
      // bare "no eligible vendor is mapped to this PR's line categories" with no
      // remedy — sending the buyer to fix a mapping that was already correct.
      const codes = categories.map(c => c.code);
      if (codes.length === 0) {
        throw new BadRequestException(
          'no sourceable lines on this PR - every line is rejected or has no category, ' +
          'so there is nothing to send an RFQ for',
        );
      }
      const reasons = withheld.map(w => EXCLUSION_LABELS[w.exclusion_reason!]?.(w) ?? 'unavailable');
      const detail = reasons.length
        ? ` - all ${withheld.length} matched vendor(s) are withheld: ${reasons.join(' ')}`
        : '. Map a vendor to the category in Vendor Master, or invite one by hand.';
      throw new BadRequestException(
        `no eligible vendor is mapped to this PR's ` +
        `${codes.length === 1 ? 'line category' : 'line categories'} ${codes.join(', ')}` +
        detail,
      );
    }
    return {
      vendorIds: pool.map((v: any) => v.id),
      shortfall: Math.max(0, DEFAULT_VENDOR_COUNT - pool.length),
      warnings: [
        `Vendors matched by line category: ${categories
          .map(c => `${c.code} (lines ${c.lineNos.join(', ')})`)
          .join('; ')}.`,
      ],
    };
  }

  /**
   * The automatic roster: every ELIGIBLE vendor mapped to at least one of the
   * PR's non-rejected line categories.
   *
   * WHY THIS IS CATEGORY-DRIVEN. The previous pool only required a vendor to
   * have SOME active category and then took the top 3 by state/vendor_code, so an
   * OFFICE_SUPPLIES request could be sent to three IT-hardware vendors - the PR's
   * own categories never entered the query. The agreement is that the RFQ goes
   * to the vendors mapped to the selected line categories, and
   * core.vendor_categories is already the table recording who is mapped to what.
   * `proc.pr_lines.category` is a TEXT FK to `core.categories.code`, while
   * `vendor_categories.category_id` is a UUID FK to `categories.id`, so the
   * join has to pass through the category row itself.
   *
   * Rejected lines are excluded: the HOD already threw them out, and
   * `snapshotRfqLines` skips them too, so including them would put a line on the
   * RFQ that no vendor could ever be asked to quote.
   *
   * The eligibility rules are unchanged and still load-bearing - blacklisted,
   * high-risk and held vendors are all out of the automatic pool. A vendor with
   * no active mapping is now excluded by the category join itself rather than by
   * a separate EXISTS: the same rule, one less thing to drift.
   *
   * NOT capped at DEFAULT_VENDOR_COUNT. That 3 was the prototype's fixed roster;
   * with several categories on one PR, truncating to 3 would silently drop
   * vendors who cover lines the survivors cannot quote. The cap is now the same
   * 12 the explicit-invite path enforces, and `shortfall` still reports the gap
   * against the prototype's 3.
   *
   * `rfqCandidates()` and `resolveVendors()` both call THIS, so the roster the
   * procurement officer is shown can never disagree with the one that is sent.
   */
  /**
   * The PR's line categories that NO vendor can be invited from.
   *
   * This is the black hole, stated as a query. A line's category is the only
   * thing that decides who is asked to quote it, so a category with no
   * invitable vendor behind it means that line is carried onto the RFQ, is
   * never quoted, and fails at AWARD time — weeks later, in a different screen,
   * with the original mistake untraceable. Nothing in between complains: the
   * roster looks healthy because the OTHER lines have vendors.
   *
   * "No invitable vendor" is deliberately wider than "no vendor". A category
   * whose only mappings are High-risk, on hold or blacklisted is exactly as
   * unsourceable as one with nobody mapped at all, and `insertInvitation()`
   * would refuse those names anyway — so they cannot be invited by hand to
   * rescue the line. Both are reported, distinguished, because the fix differs:
   * map a vendor, versus fix the vendor that is mapped.
   *
   * Only lines that can actually ride the RFQ are counted, via
   * RFQ_ELIGIBLE_LINE_PREDICATE — the same fragment `snapshotRfqLines()` writes
   * with. A held line is never carried onto the RFQ, so a held line in an
   * unsourceable category must NOT block Send: doing so sends the buyer to
   * Vendor Master to repair a mapping for a line nobody will ever be asked to
   * quote. That was the same preview/write disagreement as `categoryPool()`.
   *
   * Rejected lines are excluded here, in `categoryPool()` and in
   * `snapshotRfqLines()` alike, so all three read the same predicate. A rejected
   * line reaches no vendor and blocks no send. (Aligned 2026-10-11.)
   */
  private async unsourceableCategories(
    run: <U = any>(sql: string, params?: any[]) => Promise<{ rows: U[]; rowCount: number }>,
    prId: string,
  ): Promise<Array<{ code: string; name: string; lineNos: number[]; mappedCount: number }>> {
    const r = await run<any>(
      `SELECT pl.category AS code,
              c.name,
              array_agg(pl.line_no ORDER BY pl.line_no) AS line_nos,
              -- How many vendors ARE mapped, so the message can tell "nobody is
              -- mapped" apart from "everyone mapped is blocked".
              (SELECT count(*)::int
                 FROM core.vendor_categories vc2
                 JOIN core.vendors v2 ON v2.id = vc2.vendor_id
                WHERE vc2.category_id = c.id AND vc2.is_active) AS mapped_count
         FROM proc.pr_lines pl
         JOIN core.categories c ON c.code = pl.category
         -- LEFT LATERAL + HAVING is the whole trick: it keeps every category in
         -- the result and then drops the ones where the subquery found nothing.
         -- An INNER JOIN or a WHERE NOT EXISTS would both work, but this reads
         -- as the question it is ("which of these have nobody behind them?").
         LEFT JOIN LATERAL (
           SELECT 1 AS invitable
             FROM core.vendor_categories vc
             JOIN core.vendors v ON v.id = vc.vendor_id
             CROSS JOIN LATERAL core.fn_vendor_composite(v.scorecard) AS comp
            WHERE vc.category_id = c.id
              AND vc.is_active
              AND ${INVITABLE_VENDOR_PREDICATE}
            LIMIT 1
         ) AS probe ON true
        WHERE pl.pr_id = $2::uuid AND pl.rejected = false
         AND ${RFQ_ELIGIBLE_LINE_PREDICATE}
        GROUP BY pl.category, c.name, c.id
       HAVING count(probe.invitable) = 0
        ORDER BY pl.category`,
      [`{${EXCLUDED_VENDOR_STATES.join(',')}}`, prId],
    );
    return r.rows.map((x: any) => ({
      code: x.code,
      name: x.name,
      lineNos: pgIntArray(x.line_nos),
      mappedCount: Number(x.mapped_count ?? 0),
    }));
  }

  /**
   * The refusal text, shared by the API and the modal's copy.
   *
   * It names the lines, because "cannot issue an RFQ" is not actionable and
   * "line 3 is Machinery / plant, which has no vendor" is.
   */
  private describeUnsourceable(
    unsourceable: Array<{ name: string; lineNos: number[]; mappedCount: number }>,
  ): string {
    const rows = unsourceable
      .map(u =>
        `line ${u.lineNos.join(', ')} (${u.name}) has no vendor mapped to it` +
        (u.mappedCount > 0
          ? ` — all ${u.mappedCount} mapped vendor(s) are blocked from invitation`
          : ''))
      .join('; ');
    return (
      `This PR cannot be issued an RFQ yet: ${rows}. ` +
      'Map an eligible vendor to the category, or change the line\'s category / remove the line. ' +
      'A line with no reachable vendor would go onto the RFQ, never be quoted, and fail at award.'
    );
  }

  /**
   * The PR's lines that CANNOT ride an RFQ, and why — the complement of
   * RFQ_ELIGIBLE_LINE_PREDICATE.
   *
   * `issue()` used to discover this only AFTER inserting the RFQ row, by
   * snapshoting and counting what came back. That had two consequences, both
   * observed live on PR-2026-201649:
   *
   *   1. The buyer got `HTTP 400: this PR has no lines to put on an RFQ`. True,
   *      and useless: it named no line, no reason and no remedy, on a modal that
   *      had just told them four vendors were matched and ready to send.
   *   2. The RFQ row survived the failure. `DbService.withTransaction()` issues
   *      each statement in its OWN BEGIN/COMMIT, so the throw rolled nothing
   *      back. The PR was left carrying an Open RFQ with 0 lines, 0 invitations
   *      and 0 audit rows — and the retry then failed differently, with "PR
   *      already has an open RFQ".
   *
   * Asking the question up front fixes both: the gate can run before the INSERT,
   * and the refusal can name the lines.
   *
   * `rejected` lines are INCLUDED: they are unquotable too, and leaving them
   * out would report "lines 1, 2 held" for a PR whose real position is "lines
   * 1, 2 held and lines 3, 4 rejected" — a different thing for the buyer to go
   * and do about.
   */
  private async unquotableLines(
    run: <U = any>(sql: string, params?: any[]) => Promise<{ rows: U[]; rowCount: number }>,
    prId: string,
  ): Promise<UnquotableLine[]> {
    const r = await run<any>(
      `SELECT pl.line_no,
              CASE
                WHEN COALESCE(pl.rejected, false) THEN 'rejected'
                WHEN COALESCE(pl.held, false)    THEN 'held'
                ELSE 'no_pending_quantity'
              END AS reason,
              NULLIF(btrim(COALESCE(pl.held_reason, pl.rejected_reason, '')), '') AS detail
         FROM proc.pr_lines pl
        WHERE pl.pr_id = $1::uuid
          -- NOT "rejected = false" here. Rejected lines are exactly the ones that
          -- are NOT quotable, so filtering them out would hide the very rows this
          -- exists to explain.
          AND NOT (${RFQ_ELIGIBLE_LINE_PREDICATE} AND pl.rejected = false)
        ORDER BY pl.line_no`,
      [prId],
    );
    return r.rows.map((x: any) => ({
      line_no: Number(x.line_no),
      reason: x.reason === 'rejected' ? 'rejected' : x.reason === 'held' ? 'held' : 'no_pending_quantity',
      detail: x.detail ?? null,
    }));
  }

  /**
   * The refusal text for a PR with nothing quotable on it, in the same
   * name-the-line spirit as `describeUnsourceable()`.
   *
   * The remedy has to be TRUE, and that constrains it. There is no endpoint that
   * releases a held PR LINE — `hold`/`unhold` exist for vendors only
   * (`POST /vendors/:id/unhold`), and the HOD's per-line disposition controls
   * are only live while the PR sits at IN_HOD_REVIEW
   * (`canAct = pr?.status === 'IN_HOD_REVIEW'`). So by the time procurement sees
   * this, the hold cannot be lifted from this screen. The sanctioned route is to
   * send the PR back through the audited workflow for revision. Copy that offers
   * a button that does not exist would be worse than this 400.
   */
  private describeUnquotable(prNumber: string, lines: UnquotableLine[]): string {
    const held = lines.filter(l => l.reason === 'held');
    const rejected = lines.filter(l => l.reason === 'rejected');
    const dry = lines.filter(l => l.reason === 'no_pending_quantity');
    const nums = (ls: UnquotableLine[]) => ls.map(l => l.line_no).join(', ');
    const verb = (n: number) => (n === 1 ? 'is' : 'are');
    const parts: string[] = [];
    if (held.length) {
      const detail = held.find(l => l.detail)?.detail;
      parts.push(
        `line${held.length === 1 ? '' : 's'} ${nums(held)} ${verb(held.length)} held by HOD review` +
        (detail ? ` — "${detail}"` : ''),
      );
    }
    if (rejected.length) {
      const detail = rejected.find(l => l.detail)?.detail;
      parts.push(
        `line${rejected.length === 1 ? '' : 's'} ${nums(rejected)} ${verb(rejected.length)} rejected by HOD review` +
        (detail ? ` — "${detail}"` : ''),
      );
    }
    if (dry.length) {
      parts.push(
        `line${dry.length === 1 ? '' : 's'} ${nums(dry)} ${dry.length === 1 ? 'has' : 'have'} no quantity left to buy`,
      );
    }
    return (
      `${prNumber} has no line that can be put on an RFQ: ${parts.join('; ')}. ` +
      'A held or rejected line is never carried onto an RFQ, so there is nothing for a vendor to quote. ' +
      'Revert the PR to HOD review with your reasons, and the HOD will cancel it or raise a new one ' +
      'for the lines that should still be sourced.'
    );
  }

  private async categoryPool(
    run: <U = any>(sql: string, params?: any[]) => Promise<{ rows: U[]; rowCount: number }>,
    prId: string,
  ): Promise<{
    categories: Array<{ code: string; name: string; lineNos: number[] }>;
    vendors: PoolVendor[];
    withheld: PoolVendor[];
  }> {
    const catRows = await run<any>(
      `SELECT pl.category AS code, c.name,
              array_agg(pl.line_no ORDER BY pl.line_no) AS line_nos
         FROM proc.pr_lines pl
         JOIN core.categories c ON c.code = pl.category
        WHERE pl.pr_id = $1::uuid AND pl.rejected = false
          AND ${RFQ_ELIGIBLE_LINE_PREDICATE}
        GROUP BY pl.category, c.name
        ORDER BY pl.category`,
      [prId],
    );
    const categories = catRows.rows.map((r: any) => ({
      code: r.code,
      name: r.name,
      lineNos: pgIntArray(r.line_nos),
    }));
    if (categories.length === 0) return { categories: [], vendors: [], withheld: [] };
    const codes = categories.map(c => c.code);

    // EVERY category-matched vendor comes back here, eligible or not.
    //
    // The four exclusion rules used to sit in WHERE, which meant a withheld
    // vendor left no trace: the modal said "only 2 vendors are mapped to this
    // PR's categories" when four were mapped and two had been filtered out. An
    // operator sent to Vendor Master to fix category chips that were already
    // correct. Each rule is now a SELECTed column so the reason travels with the
    // row, and eligibility is decided once, here, in one place — `vendors` and
    // `withheld` are a partition of this single result set, so the roster that is
    // sent and the roster that is shown still cannot disagree.
    //
    // The category join itself stays a JOIN, not a UNION of two queries: a vendor
    // who is un-categorised is NOT "relevant to this PR" and has no business
    // appearing in the modal's exclusion list either.
    const pool = await run<any>(
      `SELECT v.id, v.vendor_code, v.legal_name, v.state,
              array_agg(DISTINCT c.code ORDER BY c.code) AS categories,
              -- Blueprint 9.5: the automatic pick must not reach for a High-risk
              -- vendor. IS DISTINCT FROM true keeps UNSCORED vendors (composite
              -- NULL) eligible — only an explicit High band is excluded, matching
              -- the hard guard in insertInvitation().
              (comp.blocked IS DISTINCT FROM true)   AS eligible_risk,
              comp.risk_grade, comp.score AS risk_score,
              -- RULE 5: hold is the local kill switch, so it applies to the pool
              -- and not only to a manual invite.
              NOT v.is_hold                           AS eligible_hold,
              -- A resolved blacklist entry is historical and no longer blocks.
              NOT EXISTS (
                SELECT 1 FROM core.vendor_blacklist b
                 WHERE b.vendor_id = v.id AND b.resolved_at IS NULL
              )                                       AS eligible_blacklist,
              (v.state <> ALL($1::text[]))            AS eligible_state,
              max((v.state = ANY($3::text[]))::int)   AS approved_flag
         FROM core.vendors v
         JOIN core.vendor_categories vc ON vc.vendor_id = v.id AND vc.is_active
         JOIN core.categories c ON c.id = vc.category_id
         CROSS JOIN LATERAL core.fn_vendor_composite(v.scorecard) AS comp
        WHERE c.code = ANY($2::text[])
        GROUP BY v.id, v.vendor_code, v.legal_name, v.state, v.is_hold,
                 comp.blocked, comp.risk_grade, comp.score
        ORDER BY max((v.state = ANY($3::text[]))::int) DESC, v.vendor_code`,
      [
        `{${EXCLUDED_VENDOR_STATES.join(',')}}`,
        `{${codes.join(',')}}`,
        `{${APPROVED_VENDOR_STATES.join(',')}}`,
      ],
    );

    const all: PoolVendor[] = pool.rows.map((r: any) => {
      const {
        approved_flag,
        eligible_risk, eligible_hold, eligible_blacklist, eligible_state,
        ...rest
      } = r;
      return {
        ...rest,
        categories: pgArray(r.categories),
        risk_score: r.risk_score === null || r.risk_score === undefined
          ? null : Number(r.risk_score),
        risk_grade: r.risk_grade ?? null,
        // Precedence is the order a buyer would triage in: an excluded lifecycle
        // state outranks a risk band, which outranks a hold. The FIRST failing
        // rule is the one shown, so the message names the thing to act on.
        exclusion_reason: !truthy(eligible_state) ? 'vendor_state'
          : !truthy(eligible_blacklist) ? 'blacklisted'
          : !truthy(eligible_risk) ? 'risk_blocked'
          : !truthy(eligible_hold) ? 'held'
          : null,
      };
    });

    // The approved-first ordering survives (the ORDER BY is unchanged), so the
    // slice reproduces the old `LIMIT $4` roster exactly: same rows, same order,
    // same ceiling.
    return {
      categories,
      vendors: all.filter(v => v.exclusion_reason === null).slice(0, MAX_ROSTER_VENDORS),
      withheld: all.filter(v => v.exclusion_reason !== null),
    };
  }

  /**
   * GET /pr/:id/rfq/candidates — what the shared Issue/Re-issue dialog WOULD
   * send, before it sends.
   *
   * Read-only, and never a gate the client could route around: it calls
   * `categoryPool()` rather than re-deriving the rules, because a preview that
   * disagrees with the send is worse than no preview at all.
   *
   * THE STAGE GATE MIRRORS THE ACTION BEING PREVIEWED, which is why the RFQ
   * lookup has to happen FIRST:
   *
   *   no live RFQ -> this is a FIRST ISSUE, so the prototype's
   *                  `RFQ_ISSUE_STAGES` gate applies verbatim.
   *   live RFQ     -> this is a RE-ISSUE, so `RFQ_REISSUE_STAGES` applies:
   *                  `IN_PROCUREMENT_REVIEW` only.
   *
   * The preview must be gated exactly as strictly as the write it previews. If
   * this endpoint stayed open on a forwarded PR, the Re-issue dialog would open,
   * let the buyer compose a roster, and only then refuse — which reads as the
   * system being broken rather than the control being enforced. The gate belongs
   * here, where the dialog is opened.
   *
   * The refusal text is the prototype's own string, unchanged: the prototype
   * serves both actions from one function, so "issue" is also the honest word
   * for a re-issue.
   */
  async rfqCandidates(prId: string, role: string) {
    // rfqIssue(): "Only Procurement can issue an RFQ."
    if (!roleAllowed(role, 'procurement')) {
      throw new ForbiddenException('Only Procurement can issue an RFQ.');
    }
    const pr = await this.db.query<any>(
      `SELECT id, pr_number, status FROM proc.purchase_requisitions WHERE id = $1::uuid`,
      [prId],
    );
    if (pr.rows.length === 0) throw new NotFoundException('PR not found');
    const p = pr.rows[0];

    const existing = await this.db.query<any>(
      `SELECT id, rfq_number, state, reissue_count, last_reissued_at,
              to_char(deadline_at, 'YYYY-MM-DD') AS deadline_day
         FROM proc.rfq
        WHERE pr_id = $1::uuid AND state <> 'Cancelled'
        ORDER BY created_at DESC LIMIT 1`,
      [prId],
    );
    const rfqState = existing.rows[0]?.state as string | undefined;

    // The gate depends on WHICH action this dialog would perform, so it can only be
    // decided once the RFQ lookup below has run. A first issue keeps the
    // prototype's `RFQ_ISSUE_STAGES`; a re-issue is held to
    // `RFQ_REISSUE_STAGES` — IN_PROCUREMENT_REVIEW only. See the method
    // comment: a forwarded PR's competition is not editable in place.
    if (existing.rows.length === 0 && !RFQ_ISSUE_STAGES.includes(p.status)) {
      throw new BadRequestException(`PR not ready for RFQ (stage: ${p.status})`);
    }
    if (existing.rows.length > 0 && !RFQ_REISSUE_STAGES.includes(p.status)) {
      throw new BadRequestException(
        `RFQ ${existing.rows[0].rfq_number} cannot be re-issued once the PR has left ` +
        `${RFQ_REISSUE_STAGES[0]} (stage: ${p.status}). Reject the PR with remarks to ` +
        'return it to procurement.',
      );
    }

    if (existing.rows.length > 0) {
      // NOT an empty list and NOT an error. The prototype's "Re-issue RFQ"
      // opens the SAME dialog as the first issue, seeded with the vendors
      // already on the RFQ (lightProcIssueRFQ's `previouslySelected`). Returning
      // an empty roster here — which is what this branch used to do — is what
      // made the port replace the button with an inert "Open RFQ" link: the
      // shared dialog had nothing to show, so the action disappeared entirely.
      //
      // So the re-issue shape is assembled properly: the LIVE roster, the
      // eligible pool MINUS that roster (the pickable new names), the
      // re-issue stamp, and the same category chips the first issue shows.
      const cur = await this.db.query<any>(
        `SELECT v.id, v.vendor_code, v.legal_name, v.state, i.invited_at,
                i.submitted, i.declined
           FROM proc.rfq_invitations i
           JOIN core.vendors v ON v.id = i.vendor_id
          WHERE i.rfq_id = $1::uuid
          ORDER BY v.vendor_code`,
        [existing.rows[0].id],
      );
      const onRoster = new Set(cur.rows.map((r: any) => r.id));

      const { categories, vendors, withheld } = await this.categoryPool(
        (sql, params) => this.db.query(sql, params),
        prId,
      );
      const unsourceable = await this.unsourceableCategories(
        (sql, params) => this.db.query(sql, params),
        prId,
      );

      // A vendor already invited is removed from the PICKABLE list and shown as
      // a locked "already invited" row instead. Without the subtraction it
      // would appear twice, and ticking the duplicate would invite nothing.
      const addable = vendors.filter((v: any) => !onRoster.has(v.id));

      // THE DEAD-END NOTICE IS REPORTED BUT NOT ENFORCED HERE.
      // On a first issue the gate blocks, because sending is what would carry
      // an unquotable line onto a new RFQ. On a re-issue the RFQ is already out
      // and already carries that line — adding vendors cannot remove it, and
      // refusing the top-up would leave the buyer with no action at all for a
      // problem they cannot fix by clicking this button either. `blocking` is
      // sent so the UI never has to re-derive the rule.
      const warnings: string[] = [];
      if (unsourceable.length > 0) {
        warnings.push(
          this.describeUnsourceable(unsourceable) +
          ' Adding vendors will not fix this — the line is already on the RFQ.',
        );
      }
      if (rfqState !== 'Open') {
        warnings.push(
          `RFQ ${existing.rows[0].rfq_number} is ${rfqState} — no further invitations can be issued.`,
        );
      }
      if (addable.length === 0 && withheld.length === 0) {
        warnings.push(
          'Every eligible vendor is already on this RFQ. Map another vendor to a line category ' +
          'in Vendor Master, or invite one by hand from the RFQ screen.',
        );
      }

      return {
        pr_id: prId,
        pr_number: p.pr_number,
        already_issued: true,
        rfq_id: existing.rows[0].id,
        rfq_number: existing.rows[0].rfq_number,
        reissue_count: existing.rows[0].reissue_count,
        last_reissued_at: existing.rows[0].last_reissued_at,
        // The prototype's `previouslySelected`, as real rows. Each carries the
        // badge it already has so the dialog can show what came back.
        current_vendors: cur.rows.map((r: any) => ({
          id: r.id,
          vendor_code: r.vendor_code,
          legal_name: r.legal_name,
          state: r.state,
          invited_at: r.invited_at,
          submitted: r.submitted === true || r.submitted === 'true',
          declined: r.declined === true || r.declined === 'true',
          // Marks the row as locked in the shared dialog. A separate flag
          // rather than an inference from `state`: a re-invited vendor can be
          // Active, and "Active" must not read as "still pickable".
          already_invited: true,
        })),
        categories,
        vendors: addable,
        withheld,
        unmapped_categories: unsourceable,
        // Reported, never blocking: the RFQ already exists, so a line held since
        // it was issued cannot be un-sent by refusing this dialog. Sending the
        // empty array on this path keeps the modal's type from having to ask
        // which branch it is looking at.
        unquotable_lines: [],
        shortfall: 0,
        // A carried-over deadline, not the +5 default: re-submitting the form
        // without touching the date must not silently move the deadline.
        // Rendered by the database at day granularity for the same reason the
        // re-issue comparison is — see `reissue()`.
        suggested_deadline: existing.rows[0].deadline_day
          ?? isoPlusDays(PROTOTYPE_DEADLINE_DAYS),
        // See above — the dead end is stated, not enforced, on this path.
        blocking: false,
        warnings,
      };
    }

    const { categories, vendors, withheld } = await this.categoryPool(
      (sql, params) => this.db.query(sql, params),
      prId,
    );
    const unsourceable = await this.unsourceableCategories(
      (sql, params) => this.db.query(sql, params),
      prId,
    );
    const shortfall = Math.max(0, DEFAULT_VENDOR_COUNT - vendors.length);

    // The shortfall notice must NOT say "only N vendors are mapped" when more
    // than N are mapped and some were withheld — that sends the buyer to Vendor
    // Master to repair a mapping that is already correct. Count the withheld
    // vendors separately and say which rule withheld them.
    const byReason = new Map<string, number>();
    for (const w of withheld) {
      const k = w.exclusion_reason!;
      byReason.set(k, (byReason.get(k) ?? 0) + 1);
    }
    const withheldNote = withheld.length
      ? ` ${withheld.length} matched vendor(s) are withheld: ` +
        [...byReason.entries()].map(([reason, n]) =>
          `${n} ${EXCLUSION_REASON_NOUN[reason] ?? reason}`).join(', ') +
        '. They are listed below the roster with the reason.'
      : '';

    // The dead-end notice leads the list. It is not one warning among several — it
    // is the one that makes the others moot, and burying it under a shortfall
    // count is how a healthy-looking roster talks a buyer into sending an RFQ
    // with an unquotable line on it.
    const warnings: string[] = [];
    if (unsourceable.length > 0) {
      warnings.push(this.describeUnsourceable(unsourceable));
    }
    // The nothing-to-quote case, stated BEFORE the buyer presses Send rather than
    // as a 400 afterwards. `categories` is empty in this state — every line was
    // filtered out by RFQ_ELIGIBLE_LINE_PREDICATE — so the category chips above
    // read empty and the roster reads "no vendor mapped", which sends the buyer
    // to Vendor Master to repair a mapping that was never the problem.
    const unquotable = await this.unquotableLines(
      (sql, params) => this.db.query(sql, params),
      prId,
    );
    // Only when NOTHING is quotable. A PR with 2 held and 3 quotable lines can
    // still be sourced on the other three, and saying otherwise would block a
    // perfectly good RFQ over two lines the HOD parked on purpose.
    const nothingQuotable = unquotable.length > 0 && categories.length === 0;
    if (nothingQuotable) {
      warnings.unshift(this.describeUnquotable(p.pr_number, unquotable));
    }
    if (shortfall > 0 && !nothingQuotable) {
      warnings.push(
        `${vendors.length + withheld.length} vendor(s) are mapped to this PR's categories` +
        (withheld.length ? `, ${vendors.length} of them eligible` : '') +
        ` - ${shortfall} short of the ${DEFAULT_VENDOR_COUNT} the prototype issues to. ` +
        'You can still send, and top the roster up afterwards.' +
        withheldNote,
      );
    } else if (withheld.length) {
      // No shortfall, so nothing to top up — but a withheld vendor is still
      // something the buyer should be able to see and act on.
      warnings.push(withheldNote.trim());
    }

    return {
      pr_id: prId,
      pr_number: p.pr_number,
      already_issued: false,
      rfq_id: null,
      rfq_number: null,
      reissue_count: 0,
      last_reissued_at: null,
      // Never an RFQ exists, so there is nothing locked in the dialog. Named
      // explicitly (rather than inferred from array length) so the shared
      // dialog renders one way on both branches.
      current_vendors: [],
      categories,
      vendors,
      withheld,
      // Lines that no vendor can be reached for. The modal blocks Send on these;
      // `issue()` refuses them independently, so this is the visible copy of a
      // gate that does not depend on the client honouring it.
      unmapped_categories: unsourceable,
      // Lines this PR cannot put on an RFQ at all, and why. Sent even when they
      // do not block (a partly-held PR still sources its other lines), so the
      // modal can show the buyer which lines are parked instead of quietly
      // omitting them from the category chips.
      unquotable_lines: unquotable,
      shortfall,
      // The prototype's default is today + 5 (lightProcIssueRFQ's plusDays(5)),
      // not this module's DEFAULT_DEADLINE_DAYS of 7.
      suggested_deadline: isoPlusDays(PROTOTYPE_DEADLINE_DAYS),
      // A first issue IS blocked by a dead-end line — sending is what would put
      // it on a new RFQ — and equally by having nothing quotable to send.
      // Stated, not re-derived by the client.
      blocking: unsourceable.length > 0 || nothingQuotable,
      warnings,
    };
  }

  /**
   * `deadline_at` satisfies the schema's >= created_at + 24h floor. Per Q2 it is
   * presentation only — no timer reads it.
   */
  private resolveDeadline(iso?: string): string {
    const minMs = MIN_DEADLINE_HOURS * 3600 * 1000;
    if (iso) {
      const t = Date.parse(iso);
      if (Number.isNaN(t)) throw new BadRequestException(`deadlineAt is not a valid date: ${iso}`);
      if (t < Date.now() + minMs) {
        throw new BadRequestException(
          `deadlineAt must be at least ${MIN_DEADLINE_HOURS}h from now (proc.rfq rfq_check)`,
        );
      }
      return new Date(t).toISOString();
    }
    return new Date(Date.now() + DEFAULT_DEADLINE_DAYS * 86400 * 1000).toISOString();
  }

  private async csLockedPrIds(ctx: SourcingCtx): Promise<Set<string>> {
    const r = await this.db.query<any>(
      `SELECT DISTINCT pr_id FROM proc.comparative_statements WHERE state = 'Locked'`,
      [],
      ctx,
    );
    return new Set(r.rows.map((x: any) => x.pr_id));
  }

  private async isCsLocked(prId: string, ctx: SourcingCtx): Promise<boolean> {
    const r = await this.db.query<any>(
      `SELECT 1 FROM proc.comparative_statements
        WHERE pr_id = $1::uuid AND state = 'Locked' LIMIT 1`,
      [prId],
      ctx,
    );
    return r.rows.length > 0;
  }

  /**
   * PRs already pushed to D365. The prototype's static rfq-rows carry the
   * 'Pushed to D365' pill; the port derives it from the PR's own terminal
   * status rather than hard-coding a demo row. Both spellings are in the
   * `purchase_requisitions_status_check` (migration 018/020 widened it), so
   * match either.
   */
  private async pushedPrIds(ctx: SourcingCtx): Promise<Set<string>> {
    const r = await this.db.query<any>(
      `SELECT id FROM proc.purchase_requisitions
        WHERE status IN ('D365_PUSHED', 'Pushed_To_D365')`,
      [],
      ctx,
    );
    return new Set(r.rows.map((x: any) => x.id));
  }

  private shapeQuote(q: any) {
    return {
      id: q.id,
      vendor_id: q.vendor_id,
      vendor_code: q.vendor_code,
      vendor_name: q.legal_name,
      vendor_state: q.vendor_state,
      version: Number(q.version),
      state: q.state,
      total_amount: Number(q.total_amount),
      currency: q.currency,
      fx_rate: Number(q.fx_rate),
      normalized_total_pkr: Number(q.normalized_total_pkr),
      lead_time_days: q.lead_time_days === null ? null : Number(q.lead_time_days),
      warranty_months: q.warranty_months === null ? null : Number(q.warranty_months),
      taxes_included: q.taxes_included,
      tax_breakdown: q.tax_breakdown,
      validity_days: q.validity_days === null ? null : Number(q.validity_days),
      submitted_at: q.submitted_at,
      supersedes_quotation_id: q.supersedes_quotation_id,
      // Always an array, never null: "no document on this version" and "the
      // payload did not carry attachments" must not render the same.
      //
      // parseJsonb, NOT Array.isArray. DbService runs psql as a subprocess, so a
      // jsonb column arrives as a JSON STRING — Array.isArray is false on it and
      // the button silently disables itself on every row that HAS a document.
      // This is the same trap vendors.service.ts:52 documents for `scorecard`.
      attachments: (() => {
        const parsed = parseJsonb(q.attachments);
        return Array.isArray(parsed)
          ? parsed.map((a: any) => ({ id: a.id, name: a.name, kind: a.kind }))
          : [];
      })(),
    };
  }
}
