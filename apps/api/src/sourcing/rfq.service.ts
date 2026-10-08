import { createHash, randomBytes } from 'crypto';
import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { DbService, type SessionContext } from '../db/db.service';
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
 * `array_agg()` does NOT reliably arrive as an array over this driver — an
 * `int4[]` came back as the literal string `'{1,2,3}'`, which made
 * `array_agg(...).map(...)` throw a 500 on the first call. Worse, a STRING passed
 * straight through `.join()` would have rendered "{IT_HARDWARE}" in the modal
 * instead of failing, so both ends have to be handled. Typed arrays are only
 * parsed when the driver recognises the OID; the aggregate's type is resolved at
 * runtime, so this cannot be relied on.
 */
function pgArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(x => String(x));
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('{') && t.endsWith('}')) {
      return t.slice(1, -1).split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
    }
  }
  return [];
}

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
              i.declined_reason,
              left(i.token_hash, 12) AS token_prefix,
              v.vendor_code, v.legal_name, v.state AS vendor_state
         FROM proc.rfq_invitations i
         JOIN core.vendors v ON v.id = i.vendor_id
        WHERE i.rfq_id = $1::uuid
        ORDER BY i.invited_at ASC`,
      [id],
      { userId, role, costCenterIds },
    );

    const quotes = await this.db.query<any>(
      `SELECT q.id, q.vendor_id, q.version, q.state, q.total_amount, q.currency,
              q.fx_rate, q.normalized_total_pkr, q.lead_time_days, q.warranty_months,
              q.taxes_included, q.tax_breakdown, q.validity_days,
              q.submitted_at, q.supersedes_quotation_id,
              v.vendor_code, v.legal_name, v.state AS vendor_state
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
        warranty_months: q.warranty_months === null ? null : Number(q.warranty_months),
        validity_days: q.validity_days === null ? null : Number(q.validity_days),
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

      // One live RFQ per PR. Re-issuing is `POST /rfq/:id/invite`.
      const existing = await run<any>(
        `SELECT id, rfq_number FROM proc.rfq
          WHERE pr_id = $1::uuid AND state NOT IN ('Cancelled')
          ORDER BY created_at DESC LIMIT 1`,
        [prId],
      );
      if (existing.rows.length > 0) {
        throw new BadRequestException(
          `PR already has an open RFQ (${existing.rows[0].rfq_number}). ` +
          `Use POST /rfq/${existing.rows[0].id}/invite to add another vendor.`,
        );
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
            created_at, issued_at, title)
         VALUES ($1, $2::uuid, $3::uuid, $4, 'Open',
                 $5, $6, $7, $8, now(), now(), $9)
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
        throw new BadRequestException(
          'this PR has no lines to put on an RFQ — an RFQ must snapshot at least one line',
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
      const rfq = await run<any>(
        `SELECT id, rfq_number, state FROM proc.rfq WHERE id = $1::uuid`,
        [rfqId],
      );
      if (rfq.rows.length === 0) throw new NotFoundException('RFQ not found');
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
              q.validity_days, q.submitted_at, q.quote_mode, q.taxes_included,
              v.vendor_code, v.legal_name, v.state AS vendor_state
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
        unit_price: null,
        lead_time_days: q.lead_time_days === null ? null : Number(q.lead_time_days),
        warranty_months: q.warranty_months === null ? null: Number(q.warranty_months),
        valid_until_days: q.validity_days === null ? null : Number(q.validity_days),
        received_at: q.submitted_at,
        quote_mode: q.quote_mode,
        taxes_included: q.taxes_included,
        // Q3 / plan item 8: the prototype's `isNewVendor` flag, which drives
        // the "Pending approval" badge. Off the approved roster => pending.
        is_new_vendor: !onRoster,
        on_approved_roster: onRoster,
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
            AND NOT COALESCE(pl.held, false)
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
            AND ( COALESCE(pl.held, false)
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
        WHERE e.pending_qty > 0
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
           (rfq_id, vendor_id, invited_at, token_hash, submitted, declined, expires_at)
         VALUES ($1::uuid, $2::uuid, now(), $3, false, false,
                 now() + (core.fn_vendor_token_ttl_hours() || ' hours')::interval)
         RETURNING id, invited_at, expires_at`,
        [rfqId, vendorId, hashToken(token)],
      );
      return {
        invitation_id: r.rows[0].id,
        vendor_id: vendor.id,
        vendor_code: vendor.vendor_code,
        vendor_name: vendor.legal_name,
        invited_at: r.rows[0].invited_at,
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
        GROUP BY pl.category, c.name
        ORDER BY pl.category`,
      [prId],
    );
    const categories = catRows.rows.map((r: any) => ({
      code: r.code,
      name: r.name,
      lineNos: pgArray(r.line_nos).map(Number),
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
   * GET /pr/:id/rfq/candidates - what Issue RFQ would send to, before it sends.
   *
   * Read-only, and gated exactly the way `issue()` is: procurement only, and the
   * PR must already be in a sourcing stage. It calls `categoryPool()` rather than
   * re-deriving the rules, because a preview that disagrees with the send is
   * worse than no preview at all.
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
    if (!RFQ_ISSUE_STAGES.includes(p.status)) {
      throw new BadRequestException(`PR not ready for RFQ (stage: ${p.status})`);
    }

    const empty = {
      categories: [] as Array<{ code: string; name: string; lineNos: number[] }>,
      vendors: [] as PoolVendor[],
      withheld: [] as PoolVendor[],
    };

    const existing = await this.db.query<any>(
      `SELECT id, rfq_number FROM proc.rfq
        WHERE pr_id = $1::uuid AND state <> 'Cancelled'
        ORDER BY created_at DESC LIMIT 1`,
      [prId],
    );
    if (existing.rows.length > 0) {
      // Not an error: the prototype's "Re-issue RFQ" reuses the same dialog, so
      // the modal opens and points at the supported top-up path instead.
      return {
        pr_id: prId,
        pr_number: p.pr_number,
        already_issued: true,
        rfq_id: existing.rows[0].id,
        rfq_number: existing.rows[0].rfq_number,
        ...empty,
        shortfall: 0,
        suggested_deadline: isoPlusDays(PROTOTYPE_DEADLINE_DAYS),
        warnings: [
          `This PR already has an open RFQ (${existing.rows[0].rfq_number}). ` +
          'Add vendors from the RFQ screen rather than issuing a second one.',
        ],
      };
    }

    const { categories, vendors, withheld } = await this.categoryPool(
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

    return {
      pr_id: prId,
      pr_number: p.pr_number,
      already_issued: false,
      rfq_id: null,
      rfq_number: null,
      categories,
      vendors,
      withheld,
      shortfall,
      // The prototype's default is today + 5 (lightProcIssueRFQ's plusDays(5)),
      // not this module's DEFAULT_DEADLINE_DAYS of 7.
      suggested_deadline: isoPlusDays(PROTOTYPE_DEADLINE_DAYS),
      warnings: shortfall > 0
        ? [
          `${vendors.length + withheld.length} vendor(s) are mapped to this PR's categories` +
          (withheld.length ? `, ${vendors.length} of them eligible` : '') +
          ` - ${shortfall} short of the ${DEFAULT_VENDOR_COUNT} the prototype issues to. ` +
          'You can still send, and top the roster up afterwards.' +
          withheldNote,
        ]
        : withheld.length
          // No shortfall, so nothing to top up — but a withheld vendor is still
          // something the buyer should be able to see and act on.
          ? [withheldNote.trim()]
          : [],
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
    };
  }
}
