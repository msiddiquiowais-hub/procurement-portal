import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { WorkflowService } from '../workflow/workflow.service';
import { roleAllowed } from '@procurement/roles';
import {
  planAdvance,
  resolveLineCategory,
  LIGHT_STAGE_OWNER,
  evaluatePredicate,
  evaluateTrigger,
  predicateContext,
  type ChildPrDraft,
  type Decision,
  type PrLine,
  type PrSnapshot,
  type Stage,
  type Step,
} from '@procurement/workflow-engine';
import {
  isCostConfirmedStage,
  touchesCostApproval,
  costApprovalGateMessage,
  isFinanceGate,
  mayActFinanceGate,
  mayCorrectClassification,
  CORRECT_ROLES,
} from './cost.stages';
// HOD Procurement, resolved from core.departments rather than from a role
// string — every department head signs in as `hod`, so only the identity
// distinguishes Procurement's head from Finance's, HR's, IT's and Operations'.
import { isHodProcurement, hodProcurementRefusal } from './hod.procurement';
// The D365 contract's classification vocabulary. Imported, not retyped, so the
// API cannot accept a class the ERP does not know.
import { CLASSIFICATIONS } from '@procurement/d365-client';
// The award write-back, the header total and the per-line Capex/Opex class.
// A leaf module in ../sourcing, so importing it here cannot close a cycle.
import {
  syncPrTotals,
  capexOpexGateApplies,
  unclassifiedApprovedLines,
  applyAwardToPrLines,
  lockStatementWithAward,
} from '../sourcing/award.sync';
// Where a comparative statement can exist. A leaf module in sourcing/ for the
// import-cycle reason recorded there; imported here so the advance can tell "this
// request is still inside sourcing" from "this request is somewhere else", which
// is the difference between amending a snapshot and not.
import { CS_DRAFT_STAGES } from '../sourcing/cs.stages';

/**
 * Who may SET the per-line Capex/Opex class.
 *
 * Procurement and the committee secretary ran the competition and know what
 * was quoted, so they are the desk that says whether a line is an asset or a
 * consumable — plus HOD Procurement, who approves the statement they prepared.
 * `admin` passes through roleAllowed's aliases.
 *
 * `procurement_manager` is GONE. It named nobody (0 users held it, measured) and
 * was in every one of these lists, so it read as an approver and admitted nobody.
 * HOD Procurement is not in this string either, because they are identified from
 * core.departments rather than from a role — see `isHodProcurement`, which is
 * OR'd alongside this. `roleAllowed('hod', ...)` would admit all five heads.
 */
const CLASSIFY_ROLES = 'procurement,cs,admin';

/**
 * The two steps that cross out of sourcing into cost approval.
 *
 * Both are the SAME decision — the statement is confirmed, every approved line
 * is classified, the request moves — reached from the two stages a comparative
 * statement can exist at. A step declares one `from`, so there are two keys
 * (migration 071), and the actor rule is stated per KEY rather than per
 * actorRole: `cs_review` is owned by `hod` and `cs_review_quotes` by
 * `procurement`, but both are actionable by Procurement and by HOD Procurement.
 * Keying the rule on the actorRole instead would make "which desk owns this
 * step" and "which desk may act it" the same question, which is exactly the
 * conflation that let `roleAllowed('hod','hod')` hand the blind review to the
 * Head of Finance.
 */
const CS_EXIT_STEP_KEYS = ['cs_review', 'cs_review_quotes'];

/**
 * The facts about a request that a step's PREDICATE is allowed to observe.
 *
 * `evaluatePredicate` reads three things and nothing else: the request's
 * amount, its warehouse flag, and the decision flags of the turn. It never
 * reads the line list, so the classification window does not need the lines to
 * decide whether it is open.
 *
 * These are the same fields the engine's `PrSnapshot` carries, read from the
 * PR row the caller already has — the row is passed in rather than re-queried
 * so the two detail endpoints do not each pay for a second read of the same
 * request.
 */
type PrPredicateFacts = {
  pr_number?: string | null;
  estimated_amount?: number | string | null;
  amount_status?: string | null;
  expense_type?: string | null;
  warehouse_check_required?: boolean | null;
};

/**
 * Who may RE-APPLY an award.
 *
 * The same desk, because the award is its decision to apply — plus HOD
 * Procurement (department-scoped, see `isHodProcurement`) and admin, who is the
 * one role that does not take part in the sourcing decision and is therefore the
 * only safe holder of an emergency override.
 */
const REAPPLY_AWARD_ROLES = 'procurement,cs,admin';

export type CreatePrLineInput = {
  /**
   * Optional since migration 052 — a line may be free text.
   *
   * `undefined` means the requester described the need in their own words and no
   * catalogue row matched, and the INSERT stores NULL. The FK to core.items is
   * still enforced, so an id that IS supplied has to be a real one. Widening the
   * type is what lets the create() below write `l.itemId ?? null` honestly rather
   * than claiming every line is catalogued.
   */
  itemId?: string;
  quantity: number;
  uom: string;
  /** Omit when the price is not known yet. See create() for why that is valid. */
  unitPriceEst?: number;
  description?: string;
  preferredVendorId?: string;
  /** Per-line routing category override; null = use core.items.category. */
  category?: string;
  financialDimensions?: Record<string, string>;
};

export type CreatePrInput = {
  scope: string;
  expenseType: 'CAPEX' | 'OPEX' | 'MIXED';
  costCenterId: string;
  requiredByDate: string;       // YYYY-MM-DD
  urgency?: 'routine' | 'urgent' | 'force_majeure';
  title?: string;
  description?: string;
  purpose?: string;
  departments?: Array<{ departmentId: string; hodUserId?: string; suggested?: boolean }>;
  images?: Array<{ fileId: string; lineIndex?: number; mimeType: string; sizeBytes: number }>;
  lines: CreatePrLineInput[];
};

export type CreateCapitalPrLineInput = {
  itemId: string;
  quantity: number;
  uom: string;
  unitPriceEst: number;
  description?: string;
  glAccount?: string;
  classification?: string;
  remarks?: string;
  financialDimensions?: Record<string, string>;
  preferredVendorId?: string;
};

export type CreateCapitalPrInput = {
  title: string;
  /** Optional — derived from the cost centre when omitted. */
  departmentId?: string;
  costCenterId: string;
  scope?: string;
  expenseType: 'CAPEX' | 'OPEX' | 'MIXED';
  requiredByDate: string;
  urgency?: 'routine' | 'urgent' | 'force_majeure';
  justification?: string;
  description?: string;
  purpose?: string;
  taggedApprovers?: Array<{ taggedRole: string; name: string; email: string; deptCode?: string }>;
  images?: Array<{ fileId: string; lineIndex?: number; mimeType: string; sizeBytes: number }>;
  lines: CreateCapitalPrLineInput[];
  /** false = save as Draft. The prototype's "Save draft" / "Submit PR". */
  submit?: boolean;
};

@Injectable()
export class PrService {
  constructor(
    private readonly db: DbService,
    private readonly workflow: WorkflowService,
  ) {}

  /**
   * Normalise and validate every line's UOM against the catalog, in one query.
   *
   * Migration 034 puts a foreign key on proc.pr_lines.uom, so a non-catalog value
   * is now impossible to store. That is the right place for the invariant, but on
   * its own it is a bad developer experience: a raw foreign-key violation names
   * a constraint, not the mistake. This resolves the value to a real catalog code
   * first and refuses with a message naming what was wrong and what is available.
   *
   * Normalisation matters because the vocabulary is upper-case by definition
   * (it is sent to D365 as `PurchUnit`), and callers legitimately write 'pcs'.
   * Silently upper-casing is right; silently accepting an unknown code is not.
   */
  private async resolveUoms(codes: string[]): Promise<string[]> {
    const wanted = [...new Set(codes.map((c) => String(c ?? '').trim().toUpperCase()))];
    const r = await this.db.query<{ code: string; name: string }>(
      `SELECT code, name FROM core.uom WHERE code = ANY($1::text[])`,
      [`{${wanted.map((c) => `"${c.replace(/"/g, '\\"')}"`).join(',')}}`],
      { bypassRls: true },
    );
    const known = new Map(r.rows.map((x) => [x.code, x.name]));

    const bad = wanted.filter((c) => !known.has(c));
    if (bad.length) {
      const available = r.rows.length
        ? r.rows.map((x) => x.code).join(', ')
        : 'the catalog is empty';
      throw new BadRequestException(
        `Unknown unit of measure: ${bad.map((b) => b || '(blank)').join(', ')}. ` +
          `Valid units are: ${available}. UOM must be a D365 catalog code and is sent on every PO line as PurchUnit.`,
      );
    }
    return codes.map((c) => String(c ?? '').trim().toUpperCase());
  }

  async list(userId: string, role: string, costCenterIds: string[]) {
    const r = await this.db.query<any>(
      `SELECT pr.id, pr.pr_number, pr.status, pr.estimated_amount, pr.currency,
              pr.required_by_date, pr.urgency, pr.expense_type, pr.title, pr.purpose,
              u.display_name AS requester_name, c.code AS cost_center_code,
              d.name AS department_name
         FROM proc.purchase_requisitions pr
         JOIN core.users u ON u.id = pr.requester_user_id
         JOIN core.cost_centers c ON c.id = pr.cost_center_id
         JOIN core.departments d ON d.id = pr.department_id
        ORDER BY pr.last_updated_at DESC
        LIMIT 100`,
      [],
      { userId, role, costCenterIds },
    );
    return r.rows;
  }

  /**
   * `light-pr-list` — My Light Purchase Requests.
   *
   * Port of renderLightPRList's scoping: procurement/finance/cfo/management/cs/mc
   * see the whole org; a requester and an HOD are scoped to their own
   * department; anyone else (vendor, unscoped) sees nothing rather than
   * leaking. Returns the KPI header counters and the row set the screen needs.
   */
  /**
   * `light-pr-detail` status history. The prototype renders
   * lightStatusHistoryHtml(pr) from the PR's own statusHistory array; here the
   * equivalent is the audit trail, which is hash-chained and therefore the
   * authoritative record. `before`/`after` carry the stage transitions.
   */
  async history(id: string, userId: string, role: string, costCenterIds: string[]) {
    const r = await this.db.query<any>(
      `SELECT a.ts, a.action, a.actor_user_id, u.display_name AS actor_name,
              a.before, a.after, a.correlation_id
         FROM audit.audit_log a
         LEFT JOIN core.users u ON u.id = a.actor_user_id
        WHERE a.entity = 'proc.purchase_requisitions'
          AND a.entity_id = $1::text
        ORDER BY a.ts ASC
        LIMIT 200`,
      [id],
      { userId, role, costCenterIds },
    );

    const parse = (v: any) => {
      if (!v) return null;
      if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } }
      return v;
    };

    return {
      events: r.rows.map((e: any) => ({
        ts: e.ts,
        action: e.action,
        actor: e.actor_name || (e.actor_user_id ? e.actor_user_id : 'system'),
        from_stage: parse(e.before)?.status ?? null,
        to_stage: parse(e.after)?.status ?? null,
        correlation_id: e.correlation_id || null,
      })),
    };
  }

  /**
   * `my-prs` — My Purchase Requisitions.
   *
   * Port of renderMyPRs, which renders TWO tables: the legacy capital PRs
   * (PR Number / Title / Amount / Class / Status / Stage) and the lightweight
   * PRs. Both come from proc.purchase_requisitions; they are split by stage
   * vocabulary because the capital flow uses the v1 names and the light flow
   * the v2 ones.
   */
  async myPrs(userId: string, role: string, costCenterIds: string[]) {
    // Partition on `flow_kind`, not `scope`. `scope` is free business text the
    // requester types ("Laptop", "sales") — overloading it with the sentinel
    // 'CAPITAL_PR' would misfile a request who happens to type that string.
    const detailed = await this.db.query<any>(
      `SELECT pr.id, pr.pr_number, pr.title, pr.estimated_amount, pr.currency,
              pr.expense_type, pr.status, pr.routing_key, pr.last_updated_at,
              pr.capex_amount, pr.opex_amount,
              u.display_name AS requester_name, d.name AS department_name
         FROM proc.purchase_requisitions pr
         JOIN core.users u ON u.id = pr.requester_user_id
         JOIN core.departments d ON d.id = pr.department_id
        WHERE pr.flow_kind = 'CAPITAL'
        ORDER BY pr.last_updated_at DESC
        LIMIT 200`,
      [],
      { userId, role, costCenterIds },
    );

    // ── Sourcing status (Task 1) ────────────────────────────────────────────
    //
    // The four core states are DERIVED here, never stored. Storing a text status
    // would drift: quotes are received by a different endpoint than the one that
    // issues RFQs, and nothing would force both to remember to update it.
    //
    // `cfg` is a one-row CTE on purpose. The two settings readers are STABLE
    // plpgsql, so a bare call in the SELECT list would run once PER ROW — 400
    // single-row lookups against core.settings for a 200-row page. Cross-joining
    // one row evaluates each reader exactly once and the planner can then treat
    // the values as constants.
    //
    // `responded` counts submitted + declined. A vendor who declined over the
    // phone has answered; leaving them in the denominator forever would mean a
    // single refusal could permanently block the RFQ from ever reading Received.
    const light = await this.db.query<any>(
      `WITH cfg AS (
         SELECT proc.fn_rfq_delay_hours()                  AS delay_hours,
                proc.fn_quotation_received_threshold_pct() AS threshold_pct
       ), src AS (
         SELECT pr.id, pr.pr_number, pr.title, pr.description, pr.estimated_amount,
                pr.currency, pr.urgency, pr.status, pr.department_id, pr.last_updated_at,
                pr.hod_approved_at,
                d.name AS department_name,
                (SELECT count(*) FROM proc.pr_lines pl WHERE pl.pr_id = pr.id) AS item_count,
                (SELECT pl.quantity FROM proc.pr_lines pl
                  WHERE pl.pr_id = pr.id ORDER BY pl.line_no LIMIT 1) AS first_qty,
                (SELECT pl.uom FROM proc.pr_lines pl
                  WHERE pl.pr_id = pr.id ORDER BY pl.line_no LIMIT 1) AS first_uom
           FROM proc.purchase_requisitions pr
           JOIN core.departments d ON d.id = pr.department_id
          WHERE pr.flow_kind IS DISTINCT FROM 'CAPITAL'
          ORDER BY pr.last_updated_at DESC
          LIMIT 200
       ), rfq AS (
         -- The LIVE RFQ for the PR: newest non-cancelled. A cancelled RFQ is
         -- treated as never issued, which is what a requester would expect.
         SELECT DISTINCT ON (r.pr_id) r.pr_id, r.id AS rfq_id, r.rfq_number,
                r.deadline_at, r.reissue_count, r.last_reissued_at
           FROM proc.rfq r
          WHERE r.state <> 'Cancelled'
          ORDER BY r.pr_id, r.created_at DESC
       ), csprog AS (
         -- THE CS REVIEW CHAIN, LIVE ROUND ONLY.
         --
         -- 'cr.current_round = cs.cs_round' is the same join the confirm path
         -- uses, so a re-rolled statement reports the round actually in force
         -- rather than the round that was abandoned — the difference between
         -- "awaiting the HOD" and "the HOD already sent it back".
         SELECT DISTINCT ON (cs.pr_id)
                cs.pr_id, cr.sub_state,
                -- Approved lines still carrying no class. This is what the
                -- unified Save & Proceed button is gated on, and the same
                -- population unclassifiedApprovedLines refuses on, read here
                -- only so the grid does not have to be refetched per row.
                (SELECT count(*)::int
                   FROM proc.pr_lines pl
                  WHERE pl.pr_id = cs.pr_id
                    AND pl.approved AND NOT pl.rejected AND NOT pl.held
                    AND pl.classification IS NULL) AS unclassified
           FROM proc.comparative_statements cs
           JOIN proc.cs_reviews cr
             ON cr.cs_id = cs.id AND cr.current_round = cs.cs_round
          ORDER BY cs.pr_id, cs.cs_round DESC
       ), inv AS (
         SELECT i.rfq_id,
                count(*)::int                            AS invited,
                count(*) FILTER (WHERE i.submitted)::int AS submitted,
                count(*) FILTER (WHERE i.declined)::int  AS declined,
                count(*) FILTER (
                  WHERE NOT i.submitted AND NOT i.declined
                )::int                                    AS silent
           FROM proc.rfq_invitations i
          GROUP BY i.rfq_id
       )
       SELECT s.*,
              f.rfq_id, f.rfq_number, f.deadline_at,
              COALESCE(f.reissue_count, 0)::int AS reissue_count,
              f.last_reissued_at,
              COALESCE(v.invited, 0)::int      AS invited_vendors,
              COALESCE(v.silent, 0)::int        AS awaiting_vendors,
              -- Numerator of the x/y fraction. Declines count as a response.
              (COALESCE(v.submitted,0) + COALESCE(v.declined,0))::int AS responded_vendors,
              COALESCE(v.submitted,0)::int      AS submitted_vendors,
              -- The sourcing PROGRESS, not just the RFQ's quote window.
              --
              -- PRECEDENCE MATTERS, and this is the part that was wrong.
              -- This branch comes FIRST, before every RFQ-derived branch below.
              -- A PR whose competition has concluded was not "Expired" just
              -- because its quote deadline has since passed — sourcing ended for
              -- that PR, and the deadline is historical. Before this ordering, a
              -- concluded PR with a past deadline rendered a red "Expired (2/3)"
              -- pill in the STATUS column, which reads as an unresolved sourcing
              -- failure on a document that had already been awarded. A column
              -- that cries wolf on settled work is worse than one that is quiet.
              --
              -- MIGRATION 075 — THIS COLUMN NO LONGER NAMES A WORKFLOW STAGE.
              --
              -- It used to emit PACK_LOCKED / CFO_APPROVED / MC_APPROVED /
              -- CS_LOCKED / QUOTES_RECEIVED, and those are values of
              -- proc.purchase_requisitions.status. Emitting them here built a
              -- SECOND state machine inside a SELECT: one ladder in
              -- workflow.steps_config, and a shadow of it in this CASE, free to
              -- drift. A request in Finance review rendered here as
              -- "AWAITING_QUOTES", because its quote deadline was still ahead —
              -- the STATUS column answered a question about sourcing progress
              -- using the vocabulary of the workflow.
              --
              -- So the branch keeps its PRECEDENCE and loses its vocabulary. What
              -- is true of all five stages is one sourcing fact — the competition
              -- is over and the window is historical — and that is what it now
              -- says. The stage itself is on s.status, which is what the STAGE
              -- column renders and what tabs.ts now filters the Received tab on.
              --
              -- The branch is deliberately kept even though it no longer needs to
              -- win against the branches below it: without it a concluded PR with
              -- a past deadline would be reported EXPIRED again, and the Expired
              -- tab is deliberately vendor-driven and status-independent, so it
              -- would light up red on work that finished months ago.
              --
              -- THE LIST IS EVERY STAGE WHERE THE QUOTATION ROUND IS CLOSED, and
              -- that is a bigger list than it looks.
              --
              -- It used to name only the five sourcing sub-states, which left the
              -- RFQ-derived branches below it free to describe requests that have
              -- been over for weeks. Measured on this estate: 118 requests in
              -- FINANCE REVIEW reading "Awaiting Quotes", one more reading a red
              -- "Expired", and 70 in D365_PUSHED reading "Received" — all of them
              -- reporting on an RFQ whose deadline was still ahead and whose answer
              -- nobody was waiting for any more.
              --
              -- THE BOUNDARY IS ONE STAGE, and it is not the CS exit.
              --
              -- This column describes ONE ROUND: the competition procurement ran.
              -- That round is decided the moment the quotes are in and the
              -- comparative statement or the pack has locked. IN_PROCUREMENT_REVIEW
              -- is the single stage where it is still open, and the only one where
              -- this column can honestly report AWAITING_QUOTES or EXPIRED as a live
              -- state rather than a record.
              --
              -- READY_FOR_D365 IS IN THE LIST DESPITE PROCUREMENT STILL BEING ABLE
              -- TO TOP UP AN RFQ THERE, and that is a deliberate cost. The web's
              -- inSourcingStage includes it, so a chase is still possible — but
              -- leaving it out meant a PR one step from D365 with a passed deadline
              -- wears a red "Expired" pill, which is the same crying wolf the
              -- precedence branch exists to stop, and the round it would be describing
              -- is over. The exception is visible on the RFQ panel itself, where the
              -- reissue is; it is not visible from a grid whose job is to say what
              -- stage the request is at.
              CASE
                WHEN s.status = ANY(ARRAY[
                       'QUOTES_RECEIVED','CS_LOCKED','MC_APPROVED','CFO_APPROVED','PACK_LOCKED',
                       -- Legacy: removed from the ladder by migration 075, still a
                       -- legal status string, and still a stage no request can reach.
                       'IN_COST_CENTER_APPROVAL',
                       'IN_FINANCE_REVIEW','IN_MANAGEMENT_REVIEW',
                       'READY_FOR_D365','D365_PUSHED',
                       'CLOSED','FULFILLED_FROM_STOCK'])
                  THEN 'SOURCING_CLOSED'
                -- PRE_PROCUREMENT is a real answer, not a missing one: a PR that
              -- has not reached procurement is not late issuing an RFQ. Saying
              -- "RFQ not issued" to a PR sitting in HOD review would accuse it
              -- of a delay it has not had the opportunity to incur.
              WHEN f.rfq_id IS NOT NULL AND COALESCE(v.invited,0) > 0
                     AND (COALESCE(v.submitted,0)+COALESCE(v.declined,0)) >= COALESCE(v.invited,0)
                  THEN 'RECEIVED'
                -- Deadline passed and enough responded to clear the configured
                -- threshold: procurement continues rather than being held open
                -- by vendors who simply never answer.
                -- invited > 0 is load-bearing: with zero invitations both
                -- sides are 0, and 0 >= 0 is true, so an RFQ that was created
                -- but never dispatched would report its threshold as met.
                WHEN f.rfq_id IS NOT NULL AND COALESCE(v.invited,0) > 0
                     AND now() > f.deadline_at
                     AND (COALESCE(v.submitted,0)+COALESCE(v.declined,0)) * 100.0
                         >= COALESCE(v.invited,0) * c.threshold_pct
                  THEN 'RECEIVED_THRESHOLD_MET'
                -- Deadline passed, threshold not met: flag for investigation.
                WHEN f.rfq_id IS NOT NULL AND now() > f.deadline_at THEN 'EXPIRED'
                -- An RFQ that exists but has invited nobody yet still reads
                -- Awaiting Quotes; the UI renders it "Not dispatched".
                WHEN f.rfq_id IS NOT NULL THEN 'AWAITING_QUOTES'
                -- IN_COST_CENTER_APPROVAL was here until migration 075 removed the stage from
                -- the ladder. It is gone rather than left as dead vocabulary: a
                -- stage name in a display CASE that the state machine can no
                -- longer produce is precisely the drift this change is removing.
                WHEN s.status = ANY(ARRAY['IN_PROCUREMENT_REVIEW',
                       'IN_FINANCE_REVIEW','IN_MANAGEMENT_REVIEW','READY_FOR_D365','D365_PUSHED',
                       'QUOTES_RECEIVED','CS_LOCKED','MC_APPROVED','CFO_APPROVED','PACK_LOCKED',
                       'CLOSED','FULFILLED_FROM_STOCK'])
                  THEN 'NOT_ISSUED'
                ELSE 'PRE_PROCUREMENT'
              END AS sourcing_status,
              -- THE CS SUB-STATE, as its own column.
              --
              -- It is NOT a sourcing_status value, and after migration 075 it no
              -- longer sits alongside a shadow of the lifecycle either: that
              -- column now reports sourcing PROGRESS only (see above), so this
              -- one owns the CS window outright and the STATUS cell reads it
              -- first. The two columns answer different questions and neither
              -- borrows the other's vocabulary.
              --
              -- It is scoped to the CS window itself. Before migration 075 there
              -- was a COST_APPROVAL_PENDING branch for the stage that followed
              -- the exit, and it is gone because that stage is gone — the CS exit
              -- now lands on IN_FINANCE_REVIEW, which is not a CS sub-state and
              -- is reported by the STAGE column like any other.
              --
              -- There is deliberately NO "ready to advance" value. A confirmed
              -- statement has exactly ONE outstanding action — the card's
              -- "Save & Proceed to Finance Review" — so a passive state
              -- inviting a second, separate click would be a second door into
              -- the same gate.
              CASE
                WHEN s.status <> 'QUOTES_RECEIVED'          THEN NULL
                WHEN g.sub_state IS NULL                    THEN NULL
                WHEN g.sub_state = 'DRAFT'                  THEN 'CS_DRAFT'
                WHEN g.sub_state = 'PROC_REVIEW'            THEN 'CS_PROC_REVIEW'
                WHEN g.sub_state = 'REQUESTER_REVIEW'       THEN 'CS_AWAITING_HOD'
                WHEN g.sub_state = 'CONFIRMED'              THEN 'CS_CONFIRMED_CLASSIFY'
                WHEN g.sub_state = 'REVERTED'               THEN 'CS_REVERTED'
                -- ELSE is NOT "CS_REVERTED". A catch-all that names the worst
                -- state would let an unrecognised sub_state accuse a document of
                -- having been sent back by its HOD. NULL falls through to the
                -- lifecycle value instead, which is merely less specific.
                ELSE NULL
              END AS cs_progress,
              -- Vendor-level expiry. INDEPENDENT of the PR-level state on
              -- purpose: a PR that cleared the threshold still carries these
              -- vendors, and they must remain visible for the fraud review even
              -- though procurement has moved on.
              CASE WHEN f.rfq_id IS NOT NULL AND now() > f.deadline_at
                   THEN COALESCE(v.silent, 0)::int ELSE 0 END AS expired_vendor_count,
              -- The RFQ-delay alarm. ONE anchor, one rule:
              --   no RFQ  AND  the PR has reached procurement  AND  a real HOD
              --   approval is on record  AND  the configured window has passed.
              --
              -- Migration 058 removed the second anchor this used to fall back
              -- on (procurement_entered_at). It is deliberately not missed: an
              -- anchor asserted for a PR whose HOD approval we cannot evidence
              -- would be exactly the kind of convenient fiction this column
              -- must never hold.
              (f.rfq_id IS NULL
               AND s.status = ANY(ARRAY['IN_PROCUREMENT_REVIEW','IN_COST_CENTER_APPROVAL',
                      'IN_FINANCE_REVIEW','IN_MANAGEMENT_REVIEW','READY_FOR_D365','D365_PUSHED',
                      'QUOTES_RECEIVED','CS_LOCKED','MC_APPROVED','CFO_APPROVED','PACK_LOCKED',
                      'CLOSED','FULFILLED_FROM_STOCK'])
               AND s.hod_approved_at IS NOT NULL
               AND now() > s.hod_approved_at + make_interval(hours => c.delay_hours)
              ) AS rfq_overdue
         FROM src s
         CROSS JOIN cfg c
         LEFT JOIN rfq f ON f.pr_id = s.id
         LEFT JOIN inv v ON v.rfq_id = f.rfq_id
         LEFT JOIN csprog g ON g.pr_id = s.id
        -- Ordering deliberately UNCHANGED. Overdue rows are made visible by the
        -- red pill, not by re-sorting: the screen's contract is "most recently
        -- updated first" (the Flow column shows that date), and silently
        -- reordering it to float breaches would bury the recent activity and
        -- changes behaviour nobody asked for. Grouping and sorting are Task 2's
        -- tabs, and belong there.
        ORDER BY s.last_updated_at DESC`,
      [],
      { userId, role, costCenterIds },
    );

    return {
      detailed: detailed.rows.map((p: any) => ({
        ...p,
        estimated_amount: Number(p.estimated_amount || 0),
        capex_amount: Number(p.capex_amount || 0),
        opex_amount: Number(p.opex_amount || 0),
      })),
      light: light.rows.map((p: any) => ({
        ...p,
        estimated_amount: Number(p.estimated_amount || 0),
        item_count: Number(p.item_count || 0),
        first_qty: p.first_qty === null ? null : Number(p.first_qty),
        // Coerced rather than trusted: the CSV bridge hands back numerics as
        // strings for some shapes, and a UI doing `x/y` on "2" + "3" renders
        // "23", not "2/3". Numbers are made numbers here, once.
        reissue_count: Number(p.reissue_count || 0),
        invited_vendors: Number(p.invited_vendors || 0),
        responded_vendors: Number(p.responded_vendors || 0),
        submitted_vendors: Number(p.submitted_vendors || 0),
        awaiting_vendors: Number(p.awaiting_vendors || 0),
        expired_vendor_count: Number(p.expired_vendor_count || 0),
        rfq_overdue: p.rfq_overdue === true || p.rfq_overdue === 'true',
      })),
    };
  }

  /**
   * Create a legacy capital PR. Backed by `POST /pr/capital`.
   *
   * Computes the Capex/Opex split from per-line classification and derives the
   * routing key via proc.fn_derive_routing(), so the detail screen, the
   * authority matrix and the D365 payload cannot disagree.
   */
  async createCapital(
    userId: string, role: string, costCenterIds: string[],
    input: CreateCapitalPrInput,
  ) {
    if (!input.title || !input.title.trim()) throw new BadRequestException('title is required');
    if (!input.lines?.length) throw new BadRequestException('at least one line is required');

    for (const [i, l] of input.lines.entries()) {
      if (!l.classification) {
        throw new BadRequestException(`line ${i + 1} needs a classification — every line must be Capex or Opex`);
      }
      const filled = Object.keys(l.financialDimensions || {})
        .filter(k => String((l.financialDimensions || {})[k] || '').trim()).length;
      if (filled < 4) {
        throw new BadRequestException(`line ${i + 1} needs all 4 mandatory D365 dimensions (Business Unit, Department, Cost Center, Location)`);
      }
    }

    return this.db.withTransaction({ userId, role, costCenterIds }, async (run) => {
      const cc = await run<{ department_id: string }>(
        `SELECT department_id FROM core.cost_centers WHERE id = $1::uuid`,
        [input.costCenterId],
      );
      if (cc.rows.length === 0) throw new BadRequestException('cost center not found');

      let capex = 0, opex = 0;
      for (const l of input.lines) {
        const amt = l.quantity * l.unitPriceEst;
        if (l.classification!.startsWith('CAPEX_')) capex += amt; else opex += amt;
      }
      const total = capex + opex;
      const status = input.submit ? 'Submitted' : 'Draft';

      const prNumberRes = await run(`SELECT proc.fn_next_pr_number() AS n`);
      const prNumber: string = prNumberRes.rows[0].n;

      const ins = await run<{ id: string }>(
        `INSERT INTO proc.purchase_requisitions
           (pr_number, requester_user_id, department_id, cost_center_id,
            expense_type, required_by_date, status, urgency, scope, flow_kind,
            title, description, purpose, justification,
            estimated_amount, capex_amount, opex_amount, currency, routing_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'CAPITAL', $10, $11, $12, $13, $14, $15, $16, 'PKR', 'STANDARD')
         RETURNING id`,
        [
          prNumber, userId, input.departmentId || cc.rows[0].department_id, input.costCenterId,
          input.expenseType, input.requiredByDate, status, input.urgency || 'routine',
          // `scope` stays free business text; `flow_kind` is the discriminator.
          input.scope || 'Capital requisition', input.title.trim(), input.description || null,
          input.purpose || null, input.justification || null,
          total, capex, opex,
        ],
      );
      const prId = ins.rows[0].id;

      const routing = await run<{ routing_key: string }>(
        `SELECT * FROM proc.fn_derive_routing($1::numeric, $2::numeric, $3::numeric)`,
        [capex, opex, total],
      );
      await run(`UPDATE proc.purchase_requisitions SET routing_key = $1 WHERE id = $2`,
        [routing.rows[0].routing_key, prId]);

      const lineIds: string[] = [];
      const uoms = await this.resolveUoms(input.lines.map((l) => l.uom));
      for (let i = 0; i < input.lines.length; i++) {
        const l = input.lines[i];
        const row = await run<{ id: string }>(
          `INSERT INTO proc.pr_lines
             (pr_id, line_no, item_id, quantity, uom, unit_price_est, gl_account,
              description, classification, remarks, financial_dimensions,
              preferred_vendor_id, approved, category)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13,
                   -- Inherit the catalogue item's category.
                   --
                   -- This INSERT used to omit the category column entirely, so every PR
                   -- raised through the detailed flow stored NULL there while
                   -- the item it was raised against carried a perfectly good
                   -- category (the Dell Latitude fixture is IT_HARDWARE). That
                   -- silently disabled everything downstream of category: the
                   -- line-routing rules, and the RFQ roster, which is matched to
                   -- line categories via core.vendor_categories. 1201 of 1216
                   -- lines were NULL.
                   --
                   -- COALESCE, not a plain SELECT, so a free-text line with no
                   -- item_id still stores NULL — there is no catalogue row to
                   -- inherit from, and inventing an 'OTHER' would put a
                   -- fabricated category in front of procurement.
                   COALESCE((SELECT i.category FROM core.items i WHERE i.id = $3::uuid),
                            NULL))
           RETURNING id`,
          [
            prId, i + 1, l.itemId, l.quantity, uoms[i], l.unitPriceEst,
            l.glAccount || 'NA', l.description || null, l.classification,
            l.remarks || null, JSON.stringify(l.financialDimensions || {}),
            l.preferredVendorId || null, !input.submit,
          ],
        );
        lineIds.push(row.rows[0].id);
      }

      for (const a of input.taggedApprovers || []) {
        if (!a.email?.trim()) continue;
        await run(
          `SELECT * FROM proc.fn_tag_acknowledgement($1::uuid, $2::uuid, $3, $4, $5, $6)`,
          [prId, userId, a.taggedRole || 'employee', a.name || a.email, a.email.trim().toLowerCase(), a.deptCode || null],
        );
      }

      const images = input.images || [];
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        await run(
          `INSERT INTO proc.pr_images (pr_id, line_id, file_id, mime_type, size_bytes, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [prId, img.lineIndex !== undefined ? lineIds[img.lineIndex] ?? null : null,
           img.fileId, img.mimeType, img.sizeBytes, i],
        );
      }

      return {
        id: prId, prNumber, status,
        estimatedAmount: total, capexAmount: capex, opexAmount: opex,
        routingKey: routing.rows[0].routing_key,
      };
    });
  }

  /**
   * `pr-detail` (capital) — the detail payload the legacy screen binds to:
   * KPI band, Capex/Opex breakdown, routing, line items with classification
   * and GL account, and the 9 D365 dimensions per line.
   */
  async capitalDetail(id: string, userId: string, role: string, costCenterIds: string[]) {
    const p = await this.get(id, userId, role, costCenterIds) as any;

    const dims = await this.db.query<any>(
      `SELECT line_no, financial_dimensions FROM proc.pr_lines
        WHERE pr_id = $1::uuid ORDER BY line_no`,
      [id],
      { userId, role, costCenterIds },
    );
    const dimsByLine = new Map<number, any>();
    for (const d of dims.rows) {
      let parsed: any = d.financial_dimensions;
      if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { parsed = {}; } }
      dimsByLine.set(Number(d.line_no), parsed || {});
    }

    const capex = Number(p.capex_amount ?? 0);
    const opex = Number(p.opex_amount ?? 0);
    const total = Number(p.estimated_amount ?? 0);

    const r = await this.db.query<any>(
      `SELECT * FROM proc.fn_derive_routing($1::numeric, $2::numeric, $3::numeric)`,
      [capex, opex, total],
    );

    // WHO MAY CLASSIFY — computed by the one helper both detail endpoints use.
    //
    // The screen used to answer this itself with its own copy of the role
    // string ('procurement,procurement_manager,cs,admin'), which is how a role
    // string ends up in two places and drifts: the retired `procurement_manager`
    // was still in the web's copy after the API had dropped it. Two copies of
    // one gate means the card can be editable for someone the API will refuse.
    //
    // HOD Procurement cannot be expressed as a role string at all — every
    // department head signs in as `hod` — so the card would have had to guess.
    // The answer therefore comes from here, where the identity can be read.
    const ctx = { userId, role, costCenterIds };
    const classification = await this.classificationAccess(id, String(p.status), ctx, p);

    return {
      ...p,
      capex_amount: capex,
      opex_amount: opex,
      estimated_amount: total,
      routing: r.rows[0] || { routing_key: p.routing_key, label: p.routing_key, reason: '' },
      // The screen renders the classification card from this and nothing else.
      classification,
      lines: (p.lines || []).map((l: any) => ({
        ...l,
        financialDimensions: dimsByLine.get(Number(l.line_no)) || {},
      })),
    };
  }

  /**
   * WHO MAY SET THE PER-LINE CAPEX/OPEX CLASS, AND WHETHER THE WINDOW IS OPEN.
   *
   * ONE implementation, called by BOTH `GET /pr/:id` and the capital detail
   * endpoint, because the card is rendered from `/pr/:id` and a second copy of
   * this answer is a second answer. It lived only on the capital detail route
   * until 2026-10-22, so the light flow's PR screen had no `classification` block
   * at all and fell back to a guess — which guessed that the card disappears
   * once the blind review is confirmed. That guess was true while the confirm
   * demanded the class; it is false now that the class is made AFTER the
   * confirmation, by procurement, on the step that crosses into cost approval.
   * So the card vanished exactly when it became the only thing left to do.
   *
   * THE WINDOW, restated — and this is the PROTOTYPE's rule, not a new one.
   *
   * Prototype line 2076:
   *
   *     if(s.requiresCapexOpex && _lightBranchMatches(s.when, pr, {})) return true;
   *
   * BOTH halves. The live version tested only the first: "is there a step that
   * demands a classification and that this request is sitting at a stage it
   * leaves?". That is a question about the STAGE, and it was answered yes at
   * "Procurement review · RFQ not issued" — where the card offered work the
   * workflow had not asked for, one stage early, to a desk that could not act
   * on it. The second half — the step's own condition — is the half that says
   * whether the step would ACTUALLY FIRE.
   *
   *   · OPEN when a step that demands a classification would actually fire from
   *     where this request is sitting.
   *   · The two steps that demand a class are the CS exit: cs_review (from
   *     IN_PROCUREMENT_REVIEW) and cs_review_quotes (from QUOTES_RECEIVED),
   *     and both are conditioned on csReviewConfirmed. So the window opens at
   *     the CS exit — after the blind review is CONFIRMED, while the request
   *     is still held in sourcing. Which is exactly where the CS service says
   *     it waits: "the request stays at <stage> until Procurement classifies
   *     every line and advances it."
   *   · CLOSED everywhere else, EXCEPT the correction window: finance (and the
   *     admin) may still correct a class once the cost centre has approved the
   *     number, because by then the number is a fact and the label is a typo.
   *
   * The predicate is evaluated by the ENGINE, not by a second copy of it here.
   * That matters twice over: a step whose condition an admin changes is
   * honoured by the card without touching this method, and the card cannot
   * disagree with the advance-time gate about whether the step will fire —
   * because both ask the same evaluator the same question.
   *
   * `maySet` is the CARD's authority. The PATCH endpoint keeps its own guard,
   * which is WIDER than this: it still accepts a classification while a review
   * is in flight, and it still accepts it at a stage the gated step leaves.
   * That is unchanged here on purpose — narrowing a control gate is a separate
   * ruling, and the gate that actually decides whether a request may cross
   * into cost approval (the advance) was not widened by this work.
   */
  private async classificationAccess(
    prId: string,
    status: string,
    ctx: { userId: string; role: string; costCenterIds: string[] },
    facts: PrPredicateFacts,
  ) {
    const isHod = await isHodProcurement(this.db, ctx.userId, ctx);
    const routing = await this.workflow.getConfigForPr(prId);
    // The steps that demand a classification AND could be reached from where
    // this request is sitting. Both halves of the prototype's rule, minus the
    // condition, which is evaluated below.
    const gatedSteps = routing.steps.filter(
      (s) => s.requiresCapexOpex && (s.from === status || s.from === '*'),
    );

    // The review in force, terminal states INCLUDED.
    //
    // The window question and the "what should this screen say" question are the
    // same row read two ways, so they are one query. The previous form filtered
    // to the OPEN states, which is correct for the window and useless for the
    // banner: a CS that has been reviewed and CONFIRMED is exactly the case the
    // screen used to get wrong.
    //
    // Ordered by recency and limited to one, because a request can hold several
    // rounds and only the latest describes what is happening now. Taking the
    // newest also answers the resume case: a round-2 review that is DRAFT must
    // report "in review" even while round 1 sits at CONFIRMED.
    const reviewRow = await this.db.query<any>(
      `SELECT cr.sub_state, cs.state AS cs_state
         FROM proc.cs_reviews cr
         JOIN proc.comparative_statements cs ON cs.id = cr.cs_id
        WHERE cr.pr_id = $1::uuid
          AND cr.current_round = cs.cs_round
        ORDER BY cr.updated_at DESC NULLS LAST
        LIMIT 1`,
      [prId],
      ctx,
    );
    const live = reviewRow.rows[0] ?? null;
    const subState: string | null = live?.sub_state ?? null;
    const csState: string | null = live?.cs_state ?? null;

    // THE PREDICATE, EVALUATED BY THE ENGINE.
    //
    // The one fact the evaluator cannot read for itself is the review's verdict,
    // and that is the row read above: the same row the advance-time guard checks
    // the `csReviewConfirmed` decision flag against. So the verdict is passed in
    // as the flag it claims to be, and the engine decides what the step's
    // condition means — rather than this file re-implementing what
    // `csReviewConfirmed` is.
    //
    // The snapshot carries the request's amount and its warehouse flag, because
    // those are the other two things a step's condition may ask about. Its line
    // list is empty and that is stated rather than hidden: the predicate
    // evaluator never reads it.
    const amount = facts.estimated_amount === null || facts.estimated_amount === undefined
      ? null
      : Number(facts.estimated_amount);
    const predicateCtx = predicateContext(
      {
        id: prId,
        prNumber: String(facts.pr_number ?? ''),
        status: status as Stage,
        estimatedAmount: amount !== null && Number.isFinite(amount) ? amount : null,
        amountStatus: facts.amount_status === 'UNKNOWN' ? 'UNKNOWN' : 'ESTIMATED',
        expenseType:
          facts.expense_type === 'CAPEX' || facts.expense_type === 'OPEX'
            ? facts.expense_type
            : 'MIXED',
        lines: [],
        warehouseCheckRequired: facts.warehouse_check_required === true,
      },
      { csReviewConfirmed: subState === 'CONFIRMED' },
      routing.managementThreshold,
    );
    // The first gated step whose TRIGGER is satisfied. `evaluateTrigger` — not
    // `evaluatePredicate` — and the difference is the whole point.
    //
    // A gated step's condition now includes the classification requirement
    // itself (`csExitComplete` = the review closed AND every line classified).
    // The CARD's question is not "has the request already crossed?" but "is the
    // classification the last thing standing between this request and the next
    // stage?" — so the classification half is treated as satisfied here, and
    // every other part of the condition is evaluated for real.
    //
    // `evaluatePredicate` would be the DEADLOCK: the window closes exactly when
    // there is work to do, because doing the work is what opens it. The card
    // would never appear, the lines would never be classified, and the request
    // would never advance — with no error anywhere to say why.
    //
    // The requirement itself is still enforced, by the same evaluator, on the
    // advance. `evaluateTrigger` changes which question is asked, never what
    // the rule says.
    const gatedStep =
      gatedSteps.find((s) => evaluateTrigger(s.when, s, predicateCtx)) ?? null;
    const windowOpen = Boolean(gatedStep);
    // THE CORRECTION WINDOW, AND THE ONE STAGE WHERE IT IS CLOSED.
    //
    // The rule itself lives in cost.stages.ts (`mayCorrectClassification`), which
    // is where the cost boundary's rules live and where it can be tested on its
    // own. It is closed at IN_FINANCE_REVIEW: the lines are classified at the CS
    // exit, by procurement, and what finance owns at that stage is financial
    // governance — ledger verification and budget confirmation — not line-item
    // data entry. The card is READ-ONLY there and the "Save classification"
    // button is gone.
    //
    // The PATCH endpoint keeps its own, deliberately WIDER, guard — that ruling
    // stands. This is the CARD's authority, and the card is what Finance reads.
    const mayCorrect = mayCorrectClassification(ctx.role, status);
    const maySet = (roleAllowed(ctx.role, CLASSIFY_ROLES) || isHod) && windowOpen;

    return {
      can_write: maySet || mayCorrect,
      can_set: maySet,
      can_correct: mayCorrect,
      window_open: windowOpen,
      is_hod_procurement: isHod,
      // HAS THE COMPARATIVE STATEMENT BEEN FINISHED?
      //
      // The stage bar used to answer "build and submit" from `status` and the
      // viewer's role alone, so a request whose statement was reviewed, approved
      // and locked still told procurement the statement was theirs to build —
      // the one sentence on the screen that was guaranteed to be wrong at exactly
      // the moment the work had been done. These two fields let it be right.
      //
      // `cs_confirmed` is the reviewer's verdict, `cs_state` the document's own
      // lock. Both are reported because they are not the same claim: a review can
      // be confirmed while the statement is still open.
      cs_confirmed: subState === 'CONFIRMED',
      cs_state: csState,
      // WHICH gated step opened the window, and what the caller may therefore do.
      // Named so the card can say which of the two doors is the one in front of
      // them — the CS exit from procurement review, or the same exit from the
      // quotes-received stage — rather than talking about "step 5" in general.
      exit_step: gatedStep?.key ?? null,
      window_reason: windowOpen
        ? null
        : `${status} is not a stage where the Capex/Opex class is made. It is made at the `
          + 'comparative-statement exit on the way into cost approval, and finance may '
          + 'correct it afterwards.',
    };
  }

  async lightList(userId: string, role: string, costCenterIds: string[]) {
    const SEES_ALL = ['procurement', 'finance', 'cfo', 'management', 'cs', 'mc', 'admin'];
    const seesAll = SEES_ALL.includes(role) || roleAllowed(role, 'procurement');

    // Scope department for the requester / HOD views.
    //
    // A person's department is core.users.department_id (migration 046). It
    // used to be derived by walking cost_center_ids -> cost_centers and taking
    // the first department alphabetically, which is a cost-allocation mapping
    // being asked an org-chart question. A requester holding several cost
    // centres was silently pinned to whichever department sorted first —
    // Aisha Khan resolved to SALES from "Lahore Sales" while working in HR,
    // which is how an HR requisition ended up with no HR approver in reach.
    let scopeDept: string | null = null;
    if (role === 'requester' || role === 'hod') {
      const d = await this.db.query<{ code: string | null }>(
        `SELECT d.code
           FROM core.users u
           LEFT JOIN core.departments d ON d.id = u.department_id
          WHERE u.id = $1`,
        [userId],
        { bypassRls: true },
      );
      scopeDept = d.rows[0]?.code ?? null;
    }

    const filters: string[] = [];
    const params: any[] = [];
    if (!seesAll) {
      // A REQUESTER sees only their own submissions. This screen is
      // "My Light Purchase Requests", and a requester's department is not a
      // licence to read their colleagues' requisitions: the filter used to be
      // department-only, so any two requesters in the same department saw each
      // other's requests in full.
      //
      // An HOD sees their own DEPARTMENT — that is the job. Scoping a head of
      // department to their own rows would leave the approvals queue empty.
      if (role === 'hod') {
        if (scopeDept) {
          params.push(scopeDept);
          filters.push(`d.code = $${params.length}`);
        } else {
          // HOD with no department: show nothing. Never fall back to "all".
          const header = { total: 0, open: 0, closed: 0, seesAll: false, scopeDept: null, viewLabel: 'HOD view' };
          return { header, rows: [] };
        }
      } else {
        params.push(userId);
        filters.push(`pr.requester_user_id = $${params.length}::uuid`);
      }
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const r = await this.db.query<any>(
      `SELECT pr.id, pr.pr_number, pr.status, pr.estimated_amount, pr.amount_status, pr.currency,
              pr.title, pr.description, pr.last_updated_at,
              d.name AS department_name, d.code AS department_code,
              u.display_name AS requester_name
         FROM proc.purchase_requisitions pr
         JOIN core.users u ON u.id = pr.requester_user_id
         JOIN core.cost_centers c ON c.id = pr.cost_center_id
         JOIN core.departments d ON d.id = pr.department_id
         ${where}
        ORDER BY pr.last_updated_at DESC
        LIMIT 200`,
      params,
      { userId, role, costCenterIds },
    );

    // Line preview chips: first two lines + overflow, exactly like the prototype.
    const lineRows = r.rows.length
      ? await this.db.query<any>(
          `SELECT pl.pr_id, pl.line_no, pl.quantity, pl.uom, pl.description, pl.held
             FROM proc.pr_lines pl
             JOIN proc.purchase_requisitions pr ON pr.id = pl.pr_id
             JOIN core.departments d ON d.id = pr.department_id
            ${where ? where.replace('d.code', 'd.code') : ''}
            ORDER BY pl.pr_id, pl.line_no`,
          params,
          { userId, role, costCenterIds },
        )
      : { rows: [] as any[] };

    const byPr = new Map<string, any[]>();
    for (const l of lineRows.rows) {
      if (!byPr.has(l.pr_id)) byPr.set(l.pr_id, []);
      byPr.get(l.pr_id)!.push(l);
    }

    const TERMINAL = ['D365_PUSHED', 'REJECTED', 'CLOSED'];
    const rows = r.rows.map(p => {
      const items = byPr.get(p.id) || [];
      return {
        id: p.id,
        pr_number: p.pr_number,
        title: p.title,
        description: p.description,
        department_name: p.department_name,
        department_code: p.department_code,
        requester_name: p.requester_name,
        // Null when the price is genuinely unknown, so the screen can render an
        // em-dash instead of a PKR 0 that reads like a quote.
        estimated_amount: p.amount_status === 'UNKNOWN' ? null : Number(p.estimated_amount || 0),
        amount_status: p.amount_status,
        currency: p.currency,
        status: p.status,
        last_updated_at: p.last_updated_at,
        // `items` is the FULL line list, with the `held` flag attached, and the server
        // applies NO role filtering — it returns every line to every caller. This
        // endpoint used to send `items.slice(0, 2)` with `held` absent, which made
        // the held-line exclusion impossible to do in the UI: the browser could
        // neither see which lines were held nor know how many it had not been
        // shown, so any client-side filter produced wrong chips and a wrong count.
        //
        // Slicing is now the renderer's job, over the lines it is allowed to show.
        // The derived `item_count` / `items_overflow` are deliberately NOT sent any
        // more: they were computed from the unfiltered set, so keeping them would
        // leave a second, always-wrong answer sitting in the same payload for the
        // next consumer to reach for.
        items: items.map(i => ({
          qty: Number(i.quantity),
          uom: i.uom,
          description: i.description,
          // NOT `Boolean(i.held)`. The CSV bridge coerces psql's "t"/"f" to real
          // booleans, but a NULL column arrives as null and a future transport
          // could hand back the string "f" — which Boolean() would call true, so
          // every held line would render as visible. This accepts both shapes and
          // treats everything else as not held.
          held: i.held === true || i.held === 't',
        })),
      };
    });

    const total = rows.length;
    const closed = rows.filter(p => TERMINAL.includes(p.status)).length;

    return {
      header: {
        total,
        open: total - closed,
        closed,
        seesAll,
        scopeDept,
        viewLabel: seesAll ? 'Admin view' : role === 'hod' ? 'HOD view' : 'Personal view',
      },
      rows,
    };
  }

  /**
   * `approvals` — My Approvals queue. Port of renderApprovals.
   *
   * A PR appears in the queue when its current stage is owned by the viewer's
   * role (LIGHT_STAGE_OWNER), or when the viewer is one of the routed HODs on
   * a multi-department PR.
   */
  async approvalsQueue(userId: string, role: string, costCenterIds: string[]) {
    // Queue membership is decided by LIGHT_STAGE_OWNER below, not by the
    // prototype's `approvals` nav data-roles ("hod,mc,cfo,cs"). Those differ:
    // the nav list omits procurement even though IN_PROCUREMENT_REVIEW is owned
    // by it, so gating on the nav CSV would wrongly starve the procurement
    // queue. Non-approvers (requester, vendor, public) get an empty queue —
    // the requester has the My-Light-PRs screen instead, and the prototype's
    // approvals screen is not reachable for them.
    const NON_APPROVER = ['requester', 'vendor', 'public', 'system'];
    if (NON_APPROVER.includes(role)) {
      return { rows: [] };
    }

    const { LIGHT_STAGE_OWNER } = await import('@procurement/workflow-engine');
    const ownedStages = Object.entries(LIGHT_STAGE_OWNER)
      .filter(([, owner]) => owner === role || roleAllowed(role, owner))
      .map(([stage]) => stage);
    const aliasStages = role === 'admin'
      ? Object.entries(LIGHT_STAGE_OWNER).map(([stage]) => stage)
      : ownedStages;

    if (aliasStages.length === 0) return { rows: [] };

    const r = await this.db.query<any>(
      `SELECT pr.id, pr.pr_number, pr.title, pr.status, pr.estimated_amount,
              pr.amount_status, pr.currency, pr.required_by_date, pr.urgency, pr.expense_type,
              pr.last_updated_at, d.name AS department_name, d.code AS department_code,
              u.display_name AS requester_name,
              pr.warehouse_check_required, pr.split,
              -- True when this row is here because the viewer is the head of
              -- department it is routed to, not because of the stage.
              EXISTS (SELECT 1 FROM proc.pr_departments pd
                       WHERE pd.pr_id = pr.id
                         AND pd.hod_user_id = $2::uuid
                         AND pd.hod_status = 'pending') AS hod_routed
         FROM proc.purchase_requisitions pr
         JOIN core.users u ON u.id = pr.requester_user_id
         JOIN core.cost_centers c ON c.id = pr.cost_center_id
         JOIN core.departments d ON d.id = pr.department_id
        -- Two ways in. Either the current stage is owned by this viewer's role,
        -- or the viewer is the head of department this request was routed to.
        -- The second clause is what makes routing mean anything: without it a
        -- PR tagged to a HOD sits in the queue for nobody until it happens to
        -- advance into a stage that role owns, and "route this to the HOD of HR"
        -- is a row in a table that no screen reads.
        WHERE pr.status = ANY($1::text[])
           OR EXISTS (SELECT 1 FROM proc.pr_departments pd
                       WHERE pd.pr_id = pr.id
                         AND pd.hod_user_id = $2::uuid
                         AND pd.hod_status = 'pending')
        ORDER BY pr.last_updated_at DESC
        LIMIT 200`,
      [aliasStages, userId],
      { userId, role, costCenterIds },
    );

    return {
      rows: r.rows.map(p => ({
        id: p.id,
        pr_number: p.pr_number,
        title: p.title,
        status: p.status,
        stage_owner: LIGHT_STAGE_OWNER[p.status] || 'system',
        // Null while the price is unknown, so the card shows an em-dash rather
        // than a PKR 0 that reads like a quote.
        estimated_amount: p.amount_status === 'UNKNOWN' ? null : Number(p.estimated_amount || 0),
        amount_status: p.amount_status,
        currency: p.currency,
        required_by_date: p.required_by_date,
        urgency: p.urgency,
        expense_type: p.expense_type,
        department_name: p.department_name,
        department_code: p.department_code,
        requester_name: p.requester_name,
        warehouse_check_required: p.warehouse_check_required,
        is_split_parent: !!p.split,
        last_updated_at: p.last_updated_at,
      })),
    };
  }

  async get(id: string, userId: string, role: string, costCenterIds: string[]) {
    const r = await this.db.query<any>(
      `SELECT pr.*, u.display_name AS requester_name, c.code AS cost_center_code,
              d.name AS department_name
         FROM proc.purchase_requisitions pr
         JOIN core.users u ON u.id = pr.requester_user_id
         JOIN core.cost_centers c ON c.id = pr.cost_center_id
         JOIN core.departments d ON d.id = pr.department_id
        WHERE pr.id = $1`,
      [id],
      { userId, role, costCenterIds },
    );
    if (r.rows.length === 0) throw new NotFoundException('PR not found or not visible');
    // The CSV-mode DB bridge returns every column as a string except booleans.
    // Coerce the fields the screens bind to numerically or as parsed JSON so
    // the API contract is stable regardless of transport.
    const head = r.rows[0];
    if (head && typeof head.split === 'string') {
      try { head.split = JSON.parse(head.split); } catch { /* leave as-is */ }
    }

    // LEFT JOIN, not JOIN (migration 052).
    //
    // A line with no catalogue item is a VALID line, not a broken one. An INNER
    // JOIN against a NULL item_id silently drops the row — no error, just a line
    // missing from the screen the requester lands on right after submitting. This
    // is the read that decides whether free text is real, so it has to be LEFT.
    const lines = await this.db.query<any>(
      `SELECT pl.*, i.item_code AS item_code, i.name AS item_name,
              COALESCE(pl.category, i.category) AS resolved_category,
              v.legal_name AS vendor_name
         FROM proc.pr_lines pl
         LEFT JOIN core.items i ON i.id = pl.item_id
         LEFT JOIN core.vendors v ON v.id = pl.preferred_vendor_id
        WHERE pl.pr_id = $1 ORDER BY pl.line_no`,
      [id],
      { userId, role, costCenterIds },
    );
    for (const l of lines.rows) {
      l.line_no = Number(l.line_no);
      l.quantity = Number(l.quantity);
      // `Number(null)` is 0, and that is the whole bug this line used to carry.
      //
      // A line with no price is UNKNOWN, not free. The header above already
      // refuses to conflate the two — it nulls `estimated_amount` when
      // `amount_status = 'UNKNOWN'` so the card can print "not set yet" — and this
      // coercion then turned the very same PR into "PKR 0" on the Line items
      // table one screen lower. One PR, one truth, two opposite statements about
      // whether anybody knows what it costs.
      //
      // The requester's explicit 0 still survives as 0: migration 052 keeps an
      // explicit zero at amount_status 'ESTIMATED' because "free" is an answer,
      // not a silence. Only NULL is passed through.
      l.unit_price_est = l.unit_price_est === null || l.unit_price_est === undefined
        ? null
        : Number(l.unit_price_est);
    }

    // The awarded cost — what the organisation actually agreed to pay, with the
    // vendor's discount applied and tax added — is a DIFFERENT number from
    // `unit_price_est`, which is the requester's pre-RFQ guess.
    //
    // It is fetched only once the PR has reached Cost approval, and when it is
    // not fetched it is not merely hidden by the UI: it is absent from the
    // response. A money figure suppressed in the component but still present in
    // the payload is a leak with a styling rule on it.
    //
    // The join is deliberately the same shape award.service.ts uses: cs_line_awards
    // carries no quotation_id, so the awarded quote is reached through the RFQ
    // line plus the award's vendor, taking the newest live version. Reusing the
    // proven path beats inventing a second one that agrees with it only today.
    const costConfirmed = isCostConfirmedStage(String(head.status));
    const [departments, images, children, awards] = await Promise.all([
      this.db.query<any>(
        `SELECT pd.*, d.name AS department_name, hu.display_name AS hod_name
           FROM proc.pr_departments pd
           JOIN core.departments d ON d.id = pd.department_id
           LEFT JOIN core.users hu ON hu.id = pd.hod_user_id
          WHERE pd.pr_id = $1`,
        [id], { userId, role, costCenterIds },
      ),
      this.db.query<any>(
        `SELECT pi.* FROM proc.pr_images pi WHERE pi.pr_id = $1 ORDER BY pi.sort_order`,
        [id], { userId, role, costCenterIds },
      ),
      this.db.query<any>(
        `SELECT id, pr_number, status, estimated_amount, parent_pr_id
           FROM proc.purchase_requisitions WHERE parent_pr_id = $1 ORDER BY created_at`,
        [id], { userId, role, costCenterIds },
      ),
      costConfirmed
        ? this.db.query<any>(
            `SELECT pl.id AS pr_line_id,
                    a.rfq_line_no,
                    a.awarded_qty,
                    ql.unit_price,
                    ql.gross_amount,
                    ql.discount_percent,
                    ql.discount_amount,
                    ql.net_amount,
                    ql.tax_percent,
                    ql.tax_amount,
                    ql.line_total
               FROM proc.comparative_statements cs
               JOIN proc.cs_line_awards a
                 ON a.cs_id = cs.id AND a.superseded_at IS NULL
               JOIN proc.rfq_lines l
                 ON l.rfq_id = cs.rfq_id AND l.line_no = a.rfq_line_no
               JOIN proc.pr_lines pl
                 ON pl.id = l.pr_line_id
               LEFT JOIN LATERAL (
                 SELECT q2.id
                   FROM proc.quotations q2
                  WHERE q2.rfq_id = cs.rfq_id
                    AND q2.vendor_id = a.vendor_id
                    AND q2.state IN ('Submitted','Awarded')
                  ORDER BY q2.version DESC LIMIT 1
               ) q ON true
               LEFT JOIN proc.quotation_lines ql
                 ON ql.quotation_id = q.id AND ql.rfq_line_no = a.rfq_line_no
              WHERE cs.pr_id = $1`,
            [id], { userId, role, costCenterIds },
          )
        : Promise.resolve({ rows: [] } as any),
    ]);

    // Preserve NULL rather than coercing it: a quotation that left tax or
    // discount unstated is genuinely silent on it, and turning that silence into
    // a 0 is precisely the bug that made unpriced lines read "PKR 0" above.
    const awardNum = (v: any) => (v === null || v === undefined ? null : Number(v));
    const awardByLine = new Map<string, any>(
      awards.rows.map((a: any) => [
        String(a.pr_line_id),
        {
          rfq_line_no: Number(a.rfq_line_no),
          awarded_qty: awardNum(a.awarded_qty),
          unit_price: awardNum(a.unit_price),
          gross_amount: awardNum(a.gross_amount),
          discount_percent: awardNum(a.discount_percent),
          discount_amount: awardNum(a.discount_amount),
          net_amount: awardNum(a.net_amount),
          tax_percent: awardNum(a.tax_percent),
          tax_amount: awardNum(a.tax_amount),
          line_total: awardNum(a.line_total),
        },
      ]),
    );
    if (costConfirmed) {
      for (const l of lines.rows) l.awarded = awardByLine.get(String(l.id)) ?? null;
    }

    return {
      ...head,
      lines: lines.rows,
      departments: departments.rows,
      images: images.rows,
      children: children.rows,
      // THE CAPEX/OPEX CARD'S AUTHORITY, ON THE ROUTE THAT RENDERS IT.
      //
      // This block used to exist only on the capital detail endpoint, so the
      // light flow's PR screen had no answer and fell back to guessing from the
      // review sub-state — a guess that assumed the card disappears once the
      // blind review is confirmed. Since 2026-10-22 that assumption is exactly
      // backwards: the confirmation RELEASES the classification work, so the
      // stage where the card matters most is the confirmed one. Both endpoints
      // now call `classificationAccess()`, so there is one answer and not two.
      classification: await this.classificationAccess(
        id,
        String(head.status),
        { userId, role, costCenterIds },
        head,
      ),
      // The web renders the awarded columns from THIS flag rather than
      // re-deriving the stage list, so the columns and the advance() gate below
      // cannot disagree about which stages are cost-confirmed.
      cost_confirmed: costConfirmed,
    };
  }

  /**
   * Create a PR. The proc.fn_next_pr_number() function in the DB generates the
   * PR number. We compute totals here, let the trigger set the workflow
   * snapshot, then return the new id.
   */
  async create(userId: string, role: string, costCenterIds: string[], input: CreatePrInput) {
    if (input.lines.length === 0) throw new BadRequestException('at least one line required');

    // Fetch department from cost center
    const cc = await this.db.query<{ department_id: string }>(
      `SELECT department_id FROM core.cost_centers WHERE id = $1`,
      [input.costCenterId],
      { bypassRls: true },
    );
    if (cc.rows.length === 0) throw new BadRequestException('cost center not found');

    // Financial total.
    //
    // "We do not know the price yet" is a legitimate state for a requisition:
    // a laptop request goes out before anyone has picked a model, and the
    // price comes back with the RFQ quotes. This used to be impossible to
    // express, because the create screen derived a unit price from the item's
    // expense_type (CAPEX -> 50000, OPEX -> 1000) and stored the result as a
    // confident PKR figure.
    //
    // A line is priced only if the caller actually said what it costs. If NO
    // line is priced, the PR is recorded as amount_status = 'UNKNOWN' rather
    // than as 0 - see the CHECK in migration 046. The distinction matters
    // because an amount-driven gate must not read "unknown" as "cheap".
    const priced = input.lines.filter(
      (l) => l.unitPriceEst !== null && l.unitPriceEst !== undefined && Number.isFinite(l.unitPriceEst),
    );
    // EVERY line must carry a price — not "at least one".
    //
    // The old rule (`any line priced` ⇒ the amount is known) had two problems.
    // It stored the total of the PRICED lines as if it were the total of the
    // request, which is a confident, understated number — the exact thing the
    // web screen refuses to print. And it could not be written at all: the
    // database constrains an UNKNOWN amount to be zero
    // (prs_amount_status_coherent), so a PR with two priced lines and one
    // unpriced line was refused by its own CHECK constraint.
    //
    // A partial amount is not a small amount. It is an unknown one.
    const amountKnown = input.lines.length > 0 && priced.length === input.lines.length;
    const total = amountKnown
      ? input.lines.reduce((sum, l) => sum + l.quantity * (l.unitPriceEst ?? 0), 0)
      : 0;

    return this.db.withTransaction(
      { userId, role, costCenterIds },
      async (run) => {
        const prNumberRes = await run(`SELECT proc.fn_next_pr_number() AS n`);
        const prNumber: string = prNumberRes.rows[0].n;

        // THE ROUTING KEY IS DERIVED, NOT DECLARED.
        //
        // This INSERT used to carry the literal 'STANDARD' — as the capital path's
        // did at the time — and nothing ever derived it here, so every LIGHT
        // request was born STANDARD and stayed that way for life. Nothing
        // recomputes the column: not the award write-back, not the classification
        // patch, not the advance. So the 1,491 LIGHT requests under PKR 250,000
        // that should have been FAST_TRACK were routed STANDARD, and
        // `skipMc = routing === 'FAST_TRACK'` demanded an MC and CFO vote from
        // requests the authority matrix says belong to the HOD alone.
        //
        // `capex` and `opex` are 0 here because no line is classified yet, which
        // is the honest input: the split follows the lines, and a request whose
        // classification has not been made has no capital or operating part to
        // count. Migration 073 installs a BEFORE trigger that re-derives this on
        // every write, so the two cannot disagree — both call the same function.
        const routing = await run<{ routing_key: string }>(
          `SELECT routing_key FROM proc.fn_derive_routing(0::numeric, 0::numeric, $1::numeric)`,
          [total],
        );

        const ins = await run<{ id: string }>(
          `INSERT INTO proc.purchase_requisitions
             (pr_number, requester_user_id, department_id, cost_center_id,
              expense_type, required_by_date, status, urgency,
              scope, flow_kind, title, description, purpose,
              estimated_amount, amount_status, currency, routing_key)
           VALUES ($1, $2, $3, $4, $5, $6, 'Submitted', $7, $8, 'LIGHT', $9, $10, $11, $12, $13, 'PKR', $14)
           RETURNING id`,
          [
            prNumber, userId, cc.rows[0].department_id, input.costCenterId,
            input.expenseType, input.requiredByDate, input.urgency || 'routine',
            input.scope, input.title || null, input.description || null, input.purpose || null,
            total, amountKnown ? 'ESTIMATED' : 'UNKNOWN',
            routing.rows[0]?.routing_key ?? 'STANDARD',
          ],
        );
        const prId = ins.rows[0].id;

        const lineIds: string[] = [];
        const uoms = await this.resolveUoms(input.lines.map((l) => l.uom));
        for (let i = 0; i < input.lines.length; i++) {
          const l = input.lines[i];
          const row = await run<{ id: string }>(
            `INSERT INTO proc.pr_lines
               (pr_id, line_no, item_id, quantity, uom, unit_price_est,
                description, preferred_vendor_id, gl_account, category, approved)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'NA',
                   -- A client-supplied category wins; otherwise inherit the
                   -- catalogue item's.
                   --
                   -- This read ONLY $9 (what the browser sent), so any caller
                   -- that raised a line against a catalogue item without also
                   -- restating its category stored NULL — and NULL category
                   -- silently disables everything downstream of it: the
                   -- line-routing rules, and the RFQ roster, which
                   -- core.vendor_categories matches to vendors. A Dell Latitude
                   -- laptop line carrying no IT_HARDWARE is an RFQ that can
                   -- resolve no vendor at all.
                   --
                   -- COALESCE, not a plain subquery, so /pr/new's explicit
                   -- choice still wins, and a free-text line with no item_id
                   -- stays NULL — inventing 'OTHER' would put a fabricated
                   -- category in front of procurement.
                   COALESCE($9::text,
                            (SELECT i.category FROM core.items i WHERE i.id = $3::uuid)),
                   $10)
             RETURNING id`,
            [
              prId, i + 1, l.itemId ?? null, l.quantity, uoms[i],
              // Preserve "not priced yet" as NULL rather than coercing to 0,
              // so a line-level cost check can tell the two apart.
              l.unitPriceEst ?? null,
              l.description || null, l.preferredVendorId || null,
              l.category || null, true,
            ],
          );
          lineIds.push(row.rows[0].id);
        }

        // Multi-department HOD routing (prototype "Suggest HOD" per department).
        //
        // The approver is RESOLVED here, never taken from the request body. A
        // client-supplied hodUserId used to be written straight through, which
        // made "this request goes to the wrong department head" a field the
        // browser controlled. proc.fn_pr_departments_approver_gate() would
        // refuse such a row anyway, so honouring the client value could only
        // ever produce a 500 - resolve it and let the gate confirm it.
        //
        // The PR's OWN department is always routed, whether or not the client
        // mentioned it. Relying on the caller to list the department the PR was
        // just filed under is how a requisition ends up in Submitted with no
        // approver at all: the PR has a department (it is a NOT NULL column)
        // but the routing table did not get a row for it. `input.departments`
        // is then only ever ADDITIONAL departments a requester is pulling in.
        const routeDept = await run<{ department_id: string }>(
          `SELECT department_id FROM proc.purchase_requisitions WHERE id = $1`,
          [prId],
        );
        const deptIds = [
          ...new Set([
            routeDept.rows[0].department_id,
            ...(input.departments || []).map((d) => d.departmentId),
          ]),
        ];

        // Tracks whether any department actually resolved to a HOD, so the auto-route
        // below knows it has someone to route to.
        let routedHodCount = 0;

        for (const departmentId of deptIds) {
          // `suggested` is the prototype's "Suggest HOD" provenance pill. Only
          // the departments the requester explicitly named were suggested; the
          // PR's own department is routed by definition, so it is not.
          const explicit = (input.departments || []).find((d) => d.departmentId === departmentId);
          const routed = await run<{ hod_user_id: string | null }>(
            `INSERT INTO proc.pr_departments (pr_id, department_id, hod_user_id, suggested)
             VALUES ($1, $2, core.fn_resolve_department_hod($2::uuid), $3)
             ON CONFLICT (pr_id, department_id) DO UPDATE
               SET hod_user_id = EXCLUDED.hod_user_id, suggested = EXCLUDED.suggested
             RETURNING hod_user_id`,
            [prId, departmentId, explicit ? (explicit.suggested ?? true) : false],
          );
          if (routed.rows[0]?.hod_user_id) routedHodCount++;
        }

        // Per-line reference images. DB triggers enforce the 3-per-PR and
        // 5 MB-total caps, so a buggy caller gets a violation, not a silent
        // over-store.
        const images = input.images || [];
        for (let i = 0; i < images.length; i++) {
          const img = images[i];
          await run(
            `INSERT INTO proc.pr_images (pr_id, line_id, file_id, mime_type, size_bytes, sort_order)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              prId,
              img.lineIndex !== undefined ? lineIds[img.lineIndex] ?? null : null,
              img.fileId, img.mimeType, img.sizeBytes, i,
            ],
          );
        }

        // Freeze the routing config this PR was created under.
        //
        // Without this, an admin editing the workflow mid-flight would re-route
        // requests that are already in progress: a PR sitting in
        // IN_FINANCE_REVIEW could find that no step matches its stage any more
        // and become permanently stuck. The snapshot is what makes the Part 7
        // builder safe to use on a live system.
        //
        // Frozen BEFORE the auto-route below, so the snapshot records the config
        // the PR was actually created under.
        await this.workflow.snapshotForPr(prId);

        // Auto-route to the department HOD.
        //
        // Port of the prototype's submit handler, which creates the PR at
        // SUBMITTED and then immediately transitions it:
        //
        //   // Auto-route to HOD via SUBMITTED -> IN_HOD_REVIEW transition
        //   lightTransition(pr, 'IN_HOD_REVIEW', {comment:'Auto-routed to HOD ' + ...});
        //
        // Without this the PR sits at Submitted forever: the HOD queue surfaces
        // it only through the proc.pr_departments fallback clause, the stage
        // reads "Submitted" instead of "HOD review", and the detail screen
        // renders read-only because the HOD has no action for that stage.
        //
        // Only when a HOD was actually routed above. A PR with no routed HOD
        // (a CAPITAL-flow request, say) keeps Submitted rather than being parked
        // in a queue nobody can see it in.
        if (routedHodCount > 0) {
          await run(
            `UPDATE proc.purchase_requisitions
                SET status = 'IN_HOD_REVIEW',
                    last_updated_at = now()
              WHERE id = $1`,
            [prId],
          );
        }

        return {
          id: prId,
          prNumber,
          // 'IN_HOD_REVIEW' once the auto-route above fired, matching what the
          // row now holds — a caller must not have to re-read to learn the stage.
          status: routedHodCount > 0 ? 'IN_HOD_REVIEW' : 'Submitted',
          // Null, not 0, when the price is genuinely unknown - the caller must
          // be able to render "amount to be confirmed" without having to
          // re-derive that from the status code.
          estimatedAmount: amountKnown ? total : null,
          amountStatus: amountKnown ? 'ESTIMATED' : 'UNKNOWN',
        };
      },
    );
  }

  /**
   * The role a session must hold to fire `step`.
   *
   * TWO VOCABULARIES, not one. The routing config names the HOD step's actor
   * `department_manager`, but nobody signs in as that — core.users.role is
   * `hod`, and LIGHT_STAGE_OWNER already maps IN_HOD_REVIEW to 'hod'. Every
   * other actorRole in steps_config (procurement, finance, management, mc, cfo,
   * store_incharge, cost_center_owner, requester, system) is a real role, so
   * this map carries exactly one entry. Adding an alias here is the supported
   * way to add another; do not special-case roles at the call site.
   */
  private static readonly STEP_ACTOR_ROLE: Record<string, string> = {
    department_manager: 'hod',
  };

  /**
   * Refuse a transition the caller is not entitled to make.
   *
   * WHY THIS IS HERE AT ALL
   * -----------------------
   * `advance()` used to accept ANY authenticated caller. The engine's
   * resolveNextStage filters on the PR's stage and the step predicate, never on
   * who is asking, so a requester could approve their own PR out of HOD review:
   * the gate fired `hod_review`, the status moved to IN_PROCUREMENT_REVIEW, and
   * the audit row recorded the requester as the actor. Measured on this estate
   * before the fix: 173 such self-approvals.
   *
   * WHY THE MATCHED STEP, NOT plan.step
   * -----------------------------------
   * `planAdvance` REWRITES the step it returns whenever a line rule matches
   * (engine.ts: `const syntheticStep = { ...step, to, actorRole }`). That
   * actorRole is the NEXT owner of the PR, not the role that may fire the step:
   * a HOD approving an IT line under PKR 100k returns actorRole 'procurement'.
   * Authorising on it refused the HOD and allowed procurement to approve their
   * own purchase — the exact bug, inverted. `plan.step.key` is always the
   * matched step's key, so the original actorRole is looked up from the config.
   *
   * `system` steps (reject, fulfilled_from_stock) are the one wrinkle. They are
   * automatic — they fire because a human decided something — and no session
   * holds the role 'system', so authorising against the step actor would make
   * the reject gate unreachable. For those the authority is whoever owns the
   * stage the PR is currently sitting at, which is exactly the person whose
   * decision triggered the automatic transition.
   */
  private authorizeAdvance(
    role: string,
    planStep: Step,
    matchedStep: Step | undefined,
    currentStage: string,
    isHodProc = false,
  ): void {
    const step = matchedStep ?? planStep;
    const stepActor = PrService.STEP_ACTOR_ROLE[step.actorRole as string] ?? step.actorRole;

    let required: string = stepActor;
    if (stepActor === 'system') {
      required = (LIGHT_STAGE_OWNER[currentStage] as string) ?? 'system';
    }
    // The PR is already in a terminal/automatic stage (D365_PUSHED, CLOSED,
    // REJECTED, ...). Nothing is delegated to a person here.
    if (required === 'system') return;

    // WHO MAY ACT THE STEP THAT JUST MATCHED.
    //
    // The plain rule is the step's actorRole. Two allowances sit on top of it,
    // and both exist because the Procurement DESK is two people with two role
    // strings, while the CS exit is one step they share.
    //
    // ONE, HOD PROCUREMENT MAY ACT A `procurement`-OWNED STEP.
    //
    // A department head who does not own the steps of their own department is
    // not a head of anything, and the head is precisely who approves a
    // statement, so `cs_review_quotes` (actorRole `procurement`) has to be
    // reachable by them. It cannot be reached by role: they sign in as `hod`,
    // which all five heads carry, and `roleAllowed('hod', 'procurement')` is
    // false for every one of them — including the right one.
    //
    // Scoped to `procurement` on purpose. The flag is an identity, not a
    // promotion: it opens the steps this department owns and nothing else, so
    // it cannot reach a cost-centre, finance, MC or CFO approval.
    //
    // TWO, THE PROCUREMENT OFFICER MAY ACT A CS EXIT.
    //
    // The 2026-10-21 instruction is that "Procurement / HOD Procurement
    // advances" the classified request out of step 5. `cs_review` is owned by
    // `hod` — the head approves the statement procurement prepared — so the
    // officer is refused by the role check even though they are the desk that
    // classified the lines and are therefore the desk that advances them.
    //
    // Scoped to the two CS exits by KEY rather than to "any `hod` step",
    // because `roleAllowed('hod','hod')` is true for all five heads, and a
    // blanket allowance would rest on `hod` happening to own only one step
    // today. The `csReviewConfirmed` guard downstream still narrows every one
    // of the five heads to the Procurement HOD by identity.
    // THREE, A HEAD MAY ACT A GATE OUT OF THE FINANCE REVIEW STAGE.
    //
    // The 2026-10-23 instruction is that the finance release is not the exclusive
    // right of the `finance` desk: during UAT and operational sign-offs, a head
    // of department may release it, and the admin alias inherits that.
    //
    // Scoped to the finance gates by SHAPE, not by key, and that is not a
    // stylistic choice. A frozen snapshot entry carries a key only some of the
    // time — `loadForPr` resolves it as `p.key ?? step_${i}` — and 25 snapshots
    // on this estate carry no keys at all, so their finance gates are named
    // `step_9` and `step_10`. A key-based allowance would have opened the gate
    // for 1,345 requests and refused it for exactly the 25 whose routing was
    // already different. The engine itself selects candidates by `from` and by
    // the step's condition, never by key; this allowance has to ask the same
    // question the engine asked.
    //
    // Scoped to the STAGE, so it opens the two gates out of IN_FINANCE_REVIEW and
    // nothing else: a head gains no other step, and in particular no
    // procurement, CS, MC or CFO approval.
    if (!roleAllowed(role, required)
        && !(isHodProc && required === 'procurement')
        && !(CS_EXIT_STEP_KEYS.includes(step.key) && roleAllowed(role, 'procurement'))
        && !(mayActFinanceGate(role, step))) {
      throw new ForbiddenException(
        `Only ${required} can action "${step.name || step.key}" on this PR. ` +
        `You are signed in as ${role}, so this approval cannot be recorded as theirs.`,
      );
    }
  }

  /**
   * Advance a PR through the workflow.
   *
   * Uses planAdvance() — the line-routing aware planner. When the matched step
   * declares line rules and the approved lines resolve to more than one
   * destination, the PR is split: one child PR per destination, each carrying
   * its own line subset, with parent_pr_id linkage and a `split` audit record
   * on the parent.
   */
  async advance(
    prId: string,
    decision: Decision,
    userId: string,
    role: string,
    costCenterIds: string[],
  ) {
    return this.db.withTransaction(
      { userId, role, costCenterIds },
      async (run) => {
        const r = await run<any>(
          `SELECT id, pr_number, status, estimated_amount, amount_status, expense_type, title,
                  description, purpose, department_id, cost_center_id,
                  requester_user_id, required_by_date, urgency, scope,
                  warehouse_check_required, warehouse_manager_id, warehouse_decision
             FROM proc.purchase_requisitions WHERE id = $1`,
          [prId],
        );
        if (r.rows.length === 0) throw new NotFoundException('PR not found');
        const pr = r.rows[0];

        // Cost-centre code is the actor-resolution key (LIGHT_ACTOR_REGISTRY).
        const ccRes = await run<{ code: string }>(
          `SELECT code FROM core.cost_centers WHERE id = $1`,
          [pr.cost_center_id],
        );
        const costCenterCode = ccRes.rows[0]?.code ?? null;

        const lineRows = await run<any>(
          `SELECT pl.id, pl.line_no, pl.quantity, pl.unit_price_est,
                  pl.approved, pl.rejected, pl.held, pl.rejected_reason,
                  pl.financial_dimensions,
                  pl.description,
                  pl.classification,
                  COALESCE(pl.category, i.category) AS item_category
             FROM proc.pr_lines pl
             LEFT JOIN core.items i ON i.id = pl.item_id
            WHERE pl.pr_id = $1
            ORDER BY pl.line_no`,
          [prId],
        );

        const prLines: PrLine[] = lineRows.rows.map((l: any) => ({
          lineNo: l.line_no,
          itemCategory: l.item_category || 'OTHER',
          amount: Number(l.quantity) * Number(l.unit_price_est),
          qty: Number(l.quantity),
          unitPrice: Number(l.unit_price_est),
          category: l.category ?? undefined,
          financialDimensions: l.financial_dimensions ?? undefined,
          approved: l.approved,
          rejected: l.rejected,
          held: l.held,
          // Read straight through, null and all. The engine's
          // `capexOpexClassified` predicate counts on `classification` being
          // ABSENT for an unclassified line — so coalescing this to ''
          // or 'UNCLASSIFIED' here would invert the gate and let an unmarked
          // request through to Finance.
          classification: l.classification ?? null,
        }));

        const snapshot: PrSnapshot = {
          id: pr.id,
          prNumber: pr.pr_number,
          status: pr.status as Stage,
          estimatedAmount: Number(pr.estimated_amount),
          expenseType: pr.expense_type,
          title: pr.title,
          description: pr.description,
          purpose: pr.purpose,
          costCenter: costCenterCode,
          lines: prLines,
          warehouseCheckRequired: pr.warehouse_check_required,
          warehouseManagerId: pr.warehouse_manager_id,
          warehouseDecision: pr.warehouse_decision,
          lineDecisions: decision?.lineDecisions || {},
        };

        // NOTE: the per-line disposition write that used to sit here was MOVED
        // below the authorisation gate further down. Leaving a write above the
        // gate means a caller who is about to be refused has already rewritten
        // the PR's lines.

        // Persist the HOD's per-line disposition. MOVED BELOW the authorisation
        // gate on purpose: it used to run first, so a caller who was about to be
        // refused had already rewritten the PR's lines. A refused advance must
        // leave the record exactly as it found it.
        //
        // Stamp PR-side flags from the decision so the predicates match on
        // re-routes (no fresh decision). Also moved below the gate for the same
        // reason; planAdvance reads `wantWarehouse` from the decision body, not
        // from this column, so planning before the write is equivalent.

        // Route against the config this PR was created under (its frozen
        // snapshot), falling back to the live table for PRs that predate
        // snapshotting. This is the whole point of the Part 7 remediation: the
        // routing table is data read from the database, not a constant compiled
        // into the engine.
        //
        // cs_review_quotes is the Step 5 -> Step 6 exit for a request parked at
        // QUOTES_RECEIVED by the Ready-for-CS hand-off (migration 071). A step
        // declares one `from`, so the CS exit needed a second row, and a PR
        // whose snapshot was frozen before that row existed would match nothing
        // out of QUOTES_RECEIVED at all — the exact stranding
        // WorkflowRepository.ensureStepInSnapshot() exists to prevent.
        //
        // So it is amended in, once, for the one step, only when the PR is
        // actually at a sourcing stage. Measured: 1,292 snapshots exist and only
        // 222 carry cs_review, so snapshots are routinely older than the live
        // table; this is not a rare shape.
        if (CS_DRAFT_STAGES.includes(String(pr.status))) {
          await this.workflow.ensureStepForPr(prId, 'cs_review_quotes');
        }

        const routing = await this.workflow.getConfigForPr(prId);
        const plan = planAdvance(routing, snapshot, decision);

        if (plan.kind === 'none') {
          throw new BadRequestException(
            `no workflow step matched for status=${pr.status} decision=${JSON.stringify(decision)}` +
              ` (config source: ${'source' in routing ? routing.source : 'live'})`,
          );
        }

        // ── THE GATE. Everything above this line is a read; everything below it
        //    is a write. Nothing mutates until the caller has proved they own
        //    the step that just matched.
        const matchedStep = routing.steps.find((s) => s.key === plan.step.key);
        // Resolved once, here, and handed to authorizeAdvance as an IDENTITY.
        // The `csReviewConfirmed` branch below reads it too, so a caller who is
        // neither Procurement nor its head is refused by name rather than by a
        // generic 403 after the stage had already been planned.
        const callerIsHodProc = await isHodProcurement(this.db, userId, { userId, role, costCenterIds });
        this.authorizeAdvance(role, plan.step, matchedStep, pr.status as string, callerIsHodProc);

        // ── THE CS HAND-OFF FLAGS ARE CLAIMS, NOT SWITCHES ──────────────────
        //
        // `csReviewConfirmed` and `readyForCs` used to be invisible here: the
        // DTO did not declare them, `whitelist: true` stripped them from the
        // body, and the engine's `evaluatedSteps` listed both steps while the
        // response reported `matchedStep: 'procurement'`. They are declared now,
        // so they ARRIVE — which means this route can finally reach a step it
        // previously could not, and an unverified flag would be a way straight
        // past the blind review.
        //
        // Declaring the property only makes the value visible. Every gate that
        // matters is re-checked here, against the database, before a byte moves:
        //
        //   · csReviewConfirmed — honoured ONLY when a review row for this PR's
        //     LIVE round genuinely says CONFIRMED, and only for Procurement,
        //     HOD Procurement, or a recorded admin override.
        //
        //     This used to be a claim nobody could act on: `confirm()` moved the
        //     PR itself, so a genuine confirmation arrived with the request
        //     already at IN_COST_CENTER_APPROVAL and this branch refused every
        //     caller while naming a route that had already run. The confirm no
        //     longer writes the stage — it confirms the statement, writes the
        //     award and locks it — so this is now the ONLY route that crosses
        //     Step 5 into Step 6 through the engine, and therefore the only place
        //     the classification gate is applied. That is the point of it.
        //
        //     Procurement is in the authority set because they are the desk that
        //     makes the call: they ran the competition, they tag Capex/Opex and
        //     the useful life, and they advance. HOD Procurement is there by
        //     IDENTITY, not by role — see isHodProcurement.
        //
        //   · readyForCs — honoured only when there is a GENERATED statement to
        //     hand over, and for procurement. POST /pr/:id/ready-for-cs does the
        //     same move; this is the flag form of it, so both say the same
        //     thing rather than one of them being the real route.
        if (decision?.csReviewConfirmed) {
          const review = await run<{ sub_state: string | null }>(
            `SELECT cr.sub_state
               FROM proc.cs_reviews cr
              WHERE cr.pr_id = $1::uuid
                AND cr.current_round = (SELECT max(r2.current_round)
                                          FROM proc.cs_reviews r2 WHERE r2.pr_id = cr.pr_id)
              LIMIT 1`,
            [prId],
          );
          const subState = review.rows[0]?.sub_state ?? null;
          if (subState !== 'CONFIRMED') {
            throw new BadRequestException(
              `csReviewConfirmed was sent, but this request's comparative statement is ` +
              `${subState ? `at ${subState}` : 'not in review'}. The blind review is confirmed by ` +
              `POST /cs/:id/review/confirm, which is the route that applies the award and writes ` +
              `the rates — an approval cannot stand in for it.`,
            );
          }
          if (!callerIsHodProc
              && !roleAllowed(role, 'procurement')
              && !roleAllowed(role, 'admin')) {
            throw new ForbiddenException(hodProcurementRefusal('Recording a confirmed CS exit'));
          }
        }

        if (decision?.readyForCs) {
          const cs = await run<{ state: string | null }>(
            `SELECT cs.state
               FROM proc.comparative_statements cs
              WHERE cs.pr_id = $1::uuid
                AND cs.cs_round = proc.fn_latest_cs_round($1::uuid)
              LIMIT 1`,
            [prId],
          );
          if (cs.rows[0]?.state !== 'Generated') {
            throw new BadRequestException(
              `readyForCs was sent, but there is no GENERATED comparative statement to forward ` +
              `(latest round is ${cs.rows[0]?.state ?? 'absent'}). Generate the statement first, or ` +
              `use POST /pr/:id/ready-for-cs.`,
            );
          }
        }

        // ── THE HOD NOTHING-TO-SOURCE GATE ──────────────────────────────────
        // Runs here, between the authority check and the first write, and it
        // computes the outcome IN MEMORY rather than writing the dispositions
        // and counting them afterwards. Writing first would break the invariant
        // two lines above this one: a refused advance must leave the record
        // exactly as it found it.
        //
        // A PR whose every line is held or rejected has nothing to source. It
        // used to walk straight through HOD review into procurement, where it
        // sat until someone tried to raise an RFQ and was refused by a 400 that
        // named no line and no remedy — and there is no route to release a held
        // line afterwards. PR-2026-201649 is exactly this, and it was the only
        // such PR on the estate when this was added.
        //
        // "Quotable" is deliberately NOT "approved". An undecided line still
        // rides the RFQ (RFQ_ELIGIBLE_LINE_PREDICATE rejects on held/rejected),
        // so counting approved-only would refuse a PR the sourcing stage is
        // perfectly able to handle.
        if (matchedStep?.key === 'hod_review' && !decision?.lineRejected) {
          const dispositions: Record<string, string> = decision?.lineDecisions || {};
          const quotable = lineRows.rows.filter((row: any, idx: number) => {
            const override = dispositions[String(idx)];
            if (override === 'rejected' || override === 'held') return false;
            if (override === 'approved') return true;
            return !row.held && !row.rejected;
          });
          if (quotable.length === 0) {
            const dead = lineRows.rows.map((row: any, idx: number) => {
              const override = dispositions[String(idx)];
              const held = override === 'held' || (override !== 'rejected' && row.held);
              const rejected =
                override === 'rejected' || (override !== 'held' && row.rejected);
              return {
                line_no: Number(row.line_no),
                state: rejected ? 'rejected' : held ? 'held' : 'not decided',
              };
            });
            throw new BadRequestException(
              `${pr.pr_number} has no line that can be sourced: ` +
              `${dead
                .filter(d => d.state !== 'not decided')
                .map(d => `line ${d.line_no} is ${d.state}`)
                .join('; ')}. ` +
              'A held or rejected line is never put out to vendors, so approving this PR ' +
              'would move a document with nothing in it into procurement review. ' +
              'Decide at least one line — approve it, or reject the PR instead.',
            );
          }
        }

        // ── THE COST-APPROVAL ESTIMATE GATE ─────────────────────────────────────────
        // A cost cannot be confirmed against an unknown.
        //
        // Migration 046 exists precisely so that "nobody has priced this" is
        // distinguishable from "this costs nothing": amount_status is NOT NULL,
        // CHECK-constrained to ESTIMATED/UNKNOWN, and 046's own header records
        // the incident that motivated it — an unpriced capital request stored as
        // a confident PKR 50,000 and then read by the workflow as
        // `estimatedAmount ?? 0`, which SATISFIED the below-threshold test and let
        // a real capital request skip the management gate entirely.
        //
        // That is the same defect wearing a different stage. The flag has been in
        // the schema ever since and this gate was never written, so every unpriced
        // PR could still walk into Cost approval, Finance and Management — three
        // stages confirming a figure nobody had stated — and Cost approval is
        // precisely the stage whose entire job is to confirm cost.
        //
        // Enforced on BOTH edges, not one: entering via `procurement` and leaving
        // via `cost_center` (see cost.stages.ts). Checking only the leaving edge
        // would let an unpriced PR sit in Finance and Management review before
        // anyone noticed, which is the failure the gate exists to prevent.
        //
        // The predicate is `amount_status <> 'ESTIMATED'`, NOT
        // `estimated_amount > 0`. An explicit zero is a legitimate answer —
        // migration 052 deliberately keeps it at ESTIMATED because a requester can
        // genuinely mean free — so a `> 0` test would refuse that PR while
        // catching nothing the flag does not already catch.
        if (touchesCostApproval(plan.step) && pr.amount_status !== 'ESTIMATED') {
          // APPROVED lines only.
          //
          // A held line is not being bought in this round: it never went out to
          // vendors, so it never had a rate, and demanding one of it is a
          // constraint against a line that does not exist yet. The rule is the
          // business's, approved on 2026-10-21, and it is stated once in
          // ./cost.stages.ts and read by the other door out of this boundary
          // (CsReviewService.confirm) as well as by this one.
          const unpriced = lineRows.rows
            .filter((row: any) => row.approved && !row.rejected && !row.held)
            .filter((row: any) => row.unit_price_est === null)
            .map((row: any) => Number(row.line_no));
          throw new BadRequestException(
            costApprovalGateMessage(
              pr.pr_number,
              unpriced,
              'Set a unit price on every line, or reject the PR if it is genuinely not costed yet.',
            ),
          );
        }

        // ── THE CAPEX/OPEX GATE ─────────────────────────────────────────────
        //
        // A step that declares `requiresCapexOpex` is the step where the
        // per-line Capex/Opex class is MADE, and the PR may not leave it until
        // every approved line carries one. The flag is read from the routing
        // table rather than from a list here, so an admin can move the gate by
        // ticking the box in Admin → Workflow and the API honours it.
        //
        // THIS IS NOW THE ONLY DOOR. The check used to be duplicated into
        // CsReviewService.confirm, because that route wrote
        // `UPDATE proc.purchase_requisitions SET status = step.to` and never came
        // through advance() — a gate with the other door standing open is not a
        // gate. That duplicate is gone, and with it the deadlock: the blind
        // reviewer was being asked to classify lines that procurement classifies
        // after the confirmation this same gate waits for.
        //
        // The class is made on the request itself, through
        // PATCH /pr/:id/lines/classification, and the card on the PR screen
        // offers it for exactly the window this step is responsible for. So the
        // caller refused here has something to do next, and it is on the same
        // screen they are already on.
        //
        // The gate is forward-only: a PR that was already in the step when the
        // gate was armed is not held to it.
        if (plan.step.requiresCapexOpex) {
          const stage = plan.step.from && plan.step.from !== '*' ? plan.step.from : pr.status;
          if (await capexOpexGateApplies(run, { prId, stage })) {
            const unclassified = await unclassifiedApprovedLines(run, prId);
            if (unclassified.length) {
              throw new BadRequestException(
                `${pr.pr_number} cannot leave ${stage} with an unclassified line. ` +
                `Line${unclassified.length > 1 ? 's' : ''} ${unclassified.join(', ')} ` +
                `${unclassified.length > 1 ? 'have' : 'has'} no Capex/Opex class. ` +
                'Classify every line before advancing the request, so the next desk knows whether ' +
                'it is approving a capital purchase or an operating expense. A capital line also ' +
                'needs a useful life — an asset with no depreciation period is not an asset. ' +
                'Use the Capex/Opex card on this request, or PATCH /pr/:id/lines/classification.',
              );
            }
          }
        }

        // Authorised. Now, and only now, does anything get written.
        //
        // `held_reason` is written on the same terms as `rejected_reason`: the
        // disposition's own flag gates it, so a line moving back to approved clears
        // a stale hold note instead of keeping it forever. It was read in three
        // places (po.service.ts exclusion detail, and both rfq.service.ts exclusion
        // reasons) and written in none — every held line in the database had
        // held_reason NULL, so a buyer saw the word "held" and no explanation.
        for (const [idxStr, disp] of Object.entries(decision?.lineDecisions || {})) {
          const idx = Number(idxStr);
          const row = lineRows.rows[idx];
          if (!row) continue;
          await run(
            `UPDATE proc.pr_lines
                SET approved = $1, rejected = $2, held = $3,
                    rejected_reason = CASE WHEN $2 THEN $4 ELSE NULL END,
                    held_reason    = CASE WHEN $3 THEN $4 ELSE NULL END
              WHERE id = $5`,
            [disp === 'approved', disp === 'rejected', disp === 'held', decision?.reason || null, row.id],
          );
        }

        // The header follows the lines.
        //
        // Holding or rejecting a line takes it OUT of the spend, so the PR's
        // amount changes with it. Without this, a PR whose only unpriced line
        // was held still carried the old total and the old amount_status, and
        // the cost gate then judged a document nobody was buying against a
        // number that included something they were not.
        await syncPrTotals(run, prId);

        if (decision?.wantWarehouse) {
          await run(
            `UPDATE proc.purchase_requisitions SET warehouse_check_required = true WHERE id = $1`,
            [prId],
          );
          snapshot.warehouseCheckRequired = true;
        }

        if (plan.kind === 'split') {
          const children = await this.persistSplit(
            run, pr, lineRows.rows, plan.children, plan.comment, costCenterCode,
          );

          await run(
            `UPDATE proc.purchase_requisitions
                SET status = $1,
                    split = $2::jsonb
              WHERE id = $3`,
            [
              plan.parentStage,
              JSON.stringify({
                by: userId,
                at: new Date().toISOString(),
                reason: plan.reason,
                childIds: children.map(c => c.id),
                children: children.map(c => ({
                  id: c.id,
                  prNumber: c.prNumber,
                  status: c.routeTo,
                  actorRole: c.actorRole,
                  lines: c.lineNumbers,
                  totalAmount: c.totalAmount,
                  reason: c.reason,
                })),
              }),
              prId,
            ],
          );

          return {
            prNumber: pr.pr_number,
            previousStage: pr.status,
            parentStage: plan.parentStage,
            split: true,
            matchedStep: plan.step.key,
            reason: plan.reason,
            children,
            evaluatedSteps: plan.evaluatedSteps,
          };
        }

        await run(
          `UPDATE proc.purchase_requisitions SET status = $1 WHERE id = $2`,
          [plan.nextStage, prId],
        );

        // Close out the routed-HOD rows when the HOD has actually decided.
        //
        // The approvals queue surfaces a PR through proc.pr_departments as well
        // as through the stage, so without this an APPROVED request keeps
        // matching `hod_status = 'pending'` and lands back in the HOD's queue
        // after it has moved on — the same PR listed at a stage the HOD no
        // longer owns. Recording the decision is what makes the routing row a
        // record of what happened rather than a permanent "pending".
        //
        // Only touched when the decision was made AT the HOD stage, so a later
        // Procurement/Finance advance never rewrites a HOD decision it did not make.
        if (pr.status === 'IN_HOD_REVIEW') {
          // `reworkRequested` sends the PR back to the requester, so that HOD has
          // not signed it off — the row stays pending and legitimately returns.
          const hodOutcome = decision.lineRejected ? 'rejected' : 'approved';
          await run(
            `UPDATE proc.pr_departments
                SET hod_status = $1,
                    hod_decided_at = now()
              WHERE pr_id = $2
                AND hod_status = 'pending'`,
            [hodOutcome, prId],
          );
        }

        return {
          prNumber: pr.pr_number,
          previousStage: pr.status,
          nextStage: plan.nextStage,
          matchedStep: plan.step.key,
          lineRoutingApplied: plan.lineRoutingApplied,
          actor: plan.actor,
          comment: plan.comment,
          evaluatedSteps: plan.evaluatedSteps,
        };
      },
    );
  }

  /**
   * Persist the child PRs for a split. Each child gets its own PR number, its
   * own line subset (re-numbered from 1), parent_pr_id linkage, and lands on
   * the destination stage its line rules selected.
   */
  private async persistSplit(
    run: <T = any>(sql: string, params?: any[]) => Promise<{ rows: T[] }>,
    parent: any,
    parentLineRows: any[],
    drafts: ChildPrDraft[],
    comment: string,
    costCenterCode: string | null,
  ) {
    const created: Array<{
      id: string; prNumber: string; routeTo: Stage; actorRole: string;
      lineNumbers: number[]; totalAmount: number; reason: string;
    }> = [];

    for (const draft of drafts) {
      const prNumberRes = await run(`SELECT proc.fn_next_pr_number() AS n`);
      const prNumber: string = prNumberRes.rows[0].n;

      // Same rule as the light create path, for the same reason: a child PR
      // carries its OWN total, so inheriting a fixed 'STANDARD' — or the parent's
      // key — would route a split child on an amount it does not have.
      const childRouting = await run<{ routing_key: string }>(
        `SELECT routing_key FROM proc.fn_derive_routing(0::numeric, 0::numeric, $1::numeric)`,
        [draft.totalAmount],
      );

      const ins = await run<{ id: string }>(
        `INSERT INTO proc.purchase_requisitions
           (pr_number, requester_user_id, department_id, cost_center_id,
            expense_type, required_by_date, status, urgency, scope,
            title, description, purpose, parent_pr_id,
            estimated_amount, currency, routing_key, workflow_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'PKR', $15, $16::jsonb)
         RETURNING id`,
        [
          prNumber, parent.requester_user_id, parent.department_id, parent.cost_center_id,
          parent.expense_type, parent.required_by_date, draft.routeTo,
          parent.urgency, parent.scope,
          draft.title, parent.description, parent.purpose, parent.id,
          draft.totalAmount,
          childRouting.rows[0]?.routing_key ?? 'STANDARD',
          JSON.stringify({
            splitFrom: parent.pr_number,
            reason: draft.reason,
            actorRole: draft.actorRole,
            costCenter: costCenterCode,
            parentLineIdxs: draft.parentLineIdxs,
            comment,
          }),
        ],
      );
      const childId = ins.rows[0].id;

      // Re-number the child's lines from 1 — the subset is a fresh document.
      for (let n = 0; n < draft.parentLineIdxs.length; n++) {
        const src = parentLineRows[draft.parentLineIdxs[n]];
        if (!src) continue;
        await run(
          `INSERT INTO proc.pr_lines
             (pr_id, line_no, item_id, quantity, uom, unit_price_est, gl_account,
              description, category, approved)
           SELECT $1, $2, item_id, quantity, uom, unit_price_est, gl_account,
                  description, category, approved
             FROM proc.pr_lines WHERE id = $3`,
          [childId, n + 1, src.id],
        );
      }

      created.push({
        id: childId,
        prNumber,
        routeTo: draft.routeTo,
        actorRole: draft.actorRole as string,
        lineNumbers: draft.lineNumbers,
        totalAmount: draft.totalAmount,
        reason: draft.reason,
      });
    }

    return created;
  }

  /** Categories the engine will route on — feeds the Admin line-rule editor. */
  async routingCategories() {
    return { resolved: resolveLineCategory };
  }

  /**
   * Hold a PR (ON_HOLD), or resume one that is already held.
   *
   * Port of the prototype's lightOnHold and lightHodRevertForRevision, which
   * both do `lightTransition(pr, 'ON_HOLD', {comment})` — a DIRECT transition,
   * not a step walk. The distinction matters: ON_HOLD is the target of no step
   * in the routing table, so a Decision flag would have failed with "no
   * workflow step matched".
   *
   * ON_HOLD is owned by the requester (LIGHT_STAGE_OWNER), which is what makes
   * "Revert for revision" land in their queue rather than procurement's.
   */
  async hold(
    prId: string,
    userId: string,
    role: string,
    costCenterIds: string[],
    reason?: string,
    resume = false,
  ) {
    return this.db.withTransaction({ userId, role, costCenterIds }, async (run) => {
      const r = await run<any>(
        `SELECT id, pr_number, status FROM proc.purchase_requisitions WHERE id = $1`,
        [prId],
      );
      if (r.rows.length === 0) throw new NotFoundException('PR not found');
      const pr = r.rows[0];

      const nextStage = resume ? 'IN_HOD_REVIEW' : 'ON_HOLD';

      if (resume && pr.status !== 'ON_HOLD') {
        throw new BadRequestException(`PR is not on hold (status=${pr.status}).`);
      }
      if (!resume && pr.status === 'ON_HOLD') {
        throw new BadRequestException('PR is already on hold; resume it instead.');
      }

      await run(
        `UPDATE proc.purchase_requisitions SET status = $1 WHERE id = $2`,
        [nextStage, prId],
      );

      return {
        prNumber: pr.pr_number,
        previousStage: pr.status,
        nextStage,
        held: !resume,
        comment: reason || (resume ? 'Resumed from hold' : 'Placed on hold'),
      };
    });
  }

  /**
   * Procurement returns a PR to the HOD, with remarks.
   *
   * WHY PROCUREMENT HAS NO REJECT
   * -----------------------------
   * Procurement is a sourcing function, not the demand owner. Letting it kill a
   * PR would hand a party with a commercial interest in the outcome the power to
   * end the request outright. So its entire authority here is "send it back".
   * The HOD — who owns the demand decision — then cancels it or raises a new one.
   *
   * WHY THIS IS A STEP AND NOT A DIRECT TRANSITION
   * ------------------------------------------------
   * Unlike ON_HOLD (which the prototype reaches directly and which no step
   * targets), IN_HOD_REVIEW *is* the target of `hod_review`. Routing through the
   * engine means this transition is authorised by a row an admin can see and
   * edit, appears in the step list, and is covered by the same authorization
   * path as everything else — rather than being a privileged UPDATE.
   *
   * WHY REMARKS ARE MANDATORY AND PERSISTED
   * ----------------------------------------
   * The remarks are the entire content of this action. "Reverted" with no
   * reason is indistinguishable from a mistake, and the HOD receiving it cannot
   * act. They are written to `stage_remarks`, which `trg_prs_audit` picks up in
   * the same row image as the status change — so the reason lands in the
   * hash-chained trail without a second, hand-written audit row.
   *
   * WHY THE CASCADE BELOW
   * ---------------------
   * An RFQ with zero invitations has never been shown to a vendor, so cancelling
   * it removes nothing a vendor or an approver could ever have relied on. One
   * with live invitations is a real competition and is left strictly alone.
   */
  async revertToHod(prId: string, userId: string, role: string, remarks: string) {
    const clean = (remarks ?? '').trim();
    if (clean.length === 0) {
      throw new BadRequestException(
        'Remarks are required to revert a PR to HOD review. ' +
        'Say what procurement could not source and what the HOD needs to decide.',
      );
    }

    return this.db.withTransaction({ userId, role }, async (run) => {
      const r = await run<any>(
        `SELECT id, pr_number, status FROM proc.purchase_requisitions WHERE id = $1`,
        [prId],
      );
      if (r.rows.length === 0) throw new NotFoundException('PR not found');
      const pr = r.rows[0];

      // Chain of custody. Procurement owns this PR only while it sits at
      // procurement review; past that the PR belongs to the next authority and
      // the actor who ran the competition has no right to unwind it.
      if (pr.status !== 'IN_PROCUREMENT_REVIEW') {
        throw new BadRequestException(
          `${pr.pr_number} can only be reverted from IN_PROCUREMENT_REVIEW (it is at ${pr.status}). ` +
          'Procurement holds the PR only at its own stage.',
        );
      }

      // Route through the CONFIGURED step rather than hard-coding the target, so the
      // transition is authorised the same way as every other one and an admin can
      // see it in the routing table.
      //
      // This PR was almost certainly snapshotted before the step existed — every
      // PR created before migration 060 was. Amend the snapshot for this ONE
      // step rather than ignoring it: ignoring it would also expose the PR to any
      // admin edit of the steps already in there, which is the thing the
      // snapshot exists to prevent.
      await this.workflow.ensureStepForPr(prId, 'revert_to_hod');
      const routing = await this.workflow.getConfigForPr(prId);
      const matchedStep = routing.steps.find((s) => s.key === 'revert_to_hod');
      if (!matchedStep) {
        throw new BadRequestException(
          'the revert_to_hod step is not in this PR\'s routing configuration ' +
          `(${('source' in routing ? routing.source : 'live')}) — it cannot be reverted right now`,
        );
      }
      if (matchedStep.from !== '*' && matchedStep.from !== pr.status) {
        throw new BadRequestException(
          `the revert_to_hod step accepts PRs at ${matchedStep.from}, not ${pr.status}`,
        );
      }
      this.authorizeAdvance(role, matchedStep, matchedStep, pr.status as string);

      // CHAIN OF CUSTODY, PART TWO — the RFQ, not just the stage.
      //
      // The stage check above stops procurement unwinding a PR that has MOVED ON.
      // This stops procurement unwinding a competition it has already LAUNCHED. A
      // PR with an RFQ nobody was ever invited to quote is not a competition — the
      // cascade below cancels it precisely so procurement can undo a mistake and
      // re-source. The moment one vendor is invited, though, that RFQ is a live
      // promise made outside this system, and quotes against it are data a vendor
      // can already see. Reverting the PR underneath it would leave an RFQ sitting
      // Open on a document that has walked back to HOD review, with the buyer
      // holding a competition the requisition no longer reaches.
      //
      // One invitation is the threshold, not a quote. A solicitation with a live
      // deadline and no reply is already out of the buyer's hands.
      //
      // Placement is deliberate: AFTER authorizeAdvance, so an unauthorised caller
      // cannot learn whether an RFQ exists, and BEFORE any write, so a refused
      // revert leaves the PR, its RFQ and its snapshot exactly as they were.
      const liveRfq = await run<{ rfq_number: string; invitations: number; quotes: number }>(
        `SELECT r.rfq_number,
                (SELECT count(*)::int FROM proc.rfq_invitations i
                  WHERE i.rfq_id = r.id) AS invitations,
                (SELECT count(*)::int FROM proc.quotations q
                  WHERE q.rfq_id = r.id AND q.state = 'Submitted') AS quotes
           FROM proc.rfq r
          WHERE r.pr_id = $1::uuid
            AND r.state <> 'Cancelled'
            AND EXISTS (SELECT 1 FROM proc.rfq_invitations i WHERE i.rfq_id = r.id)
          ORDER BY r.created_at DESC
          LIMIT 1`,
        [prId],
      );
      const live = liveRfq.rows[0];
      if (live) {
        const invitations = Number(live.invitations || 0);
        const quotes = Number(live.quotes || 0);
        throw new BadRequestException(
          `${pr.pr_number} cannot be reverted: ${live.rfq_number} was already issued to ` +
          `${invitations} vendor${invitations === 1 ? '' : 's'}` +
          (quotes > 0 ? ` and ${quotes} quote${quotes === 1 ? ' has' : 's have'} been received` : '') +
          '. A competition that vendors have been invited to cannot be unwound by ' +
          'procurement — it belongs to the vendors who were invited to it. Return this ' +
          'PR only while no vendor has been solicited.',
        );
      }

      const stamp = { reason: clean, by: userId, at: new Date().toISOString() };

      // The STAGE MOVE FIRST, the cascade second. Order is a control, not a
      // style choice: `DbService.withTransaction()` gives each statement its own
      // BEGIN/COMMIT, so a failure here does NOT roll back a statement that ran
      // earlier in this function. Cancelling first and moving second would let a
      // refused transition leave the PR untouched while its RFQs had already
      // been cancelled — destroying state on a request that was denied. This was
      // observed live: a transition refused by the guard still cancelled the
      // empty RFQ, because the cascade had already committed.
      await run(
        `UPDATE proc.purchase_requisitions
            SET status = $1,
                stage_remarks = stage_remarks || jsonb_build_object('revert_to_hod', $2::jsonb)
          WHERE id = $3`,
        [matchedStep.to, JSON.stringify(stamp), prId],
      );

      // Cascade: an RFQ nobody was ever invited to quote is not a competition.
      // Cancelling it unblocks the PR if procurement re-sources it later.
      const cancelled = await run<{ rfq_number: string }>(
        `UPDATE proc.rfq
            SET state = 'Cancelled'
          WHERE pr_id = $1
            AND state <> 'Cancelled'
            AND NOT EXISTS (SELECT 1 FROM proc.rfq_invitations i WHERE i.rfq_id = proc.rfq.id)
        RETURNING rfq_number`,
        [prId],
      );

      return {
        prNumber: pr.pr_number,
        previousStage: pr.status,
        nextStage: matchedStep.to,
        remarks: clean,
        revertedBy: userId,
        cancelledRfqs: cancelled.rows.map((x) => x.rfq_number),
      };
    });
  }

  /**
   * READY FOR CS — procurement hands the finished competition to the committee.
   *
   * WHAT THIS DOES. Moves the PR from IN_PROCUREMENT_REVIEW to QUOTES_RECEIVED,
   * the stage at which a Comparative Statement becomes generatable, and closes
   * the RFQ. From that instant the competition is the record a decision is made
   * from: no quotation can be received and none can change.
   *
   * The freeze is enforced in three places, deliberately, because they fail
   * independently:
   *   - the quotation table refuses the write outright (migration 064);
   *   - `RFQ_SOURCING_STAGES` already refuses procurement recording a quote;
   *   - the vendor portal now reads the PR's stage, which it never used to do.
   * A control that lives in one place is a control one refactor can lose.
   *
   * WHY THE RFQ IS CLOSED HERE. The RFQ otherwise stays `Open` until the CS
   * locks, which left the vendor portal's own `state <> 'Open'` check
   * meaningless exactly when it mattered. Closing it here turns that existing
   * check into the control it was always meant to be.
   *
   * ORDER IS A CONTROL, NOT A STYLE CHOICE. `DbService.withTransaction()` gives
   * each statement its own BEGIN/COMMIT, so a later failure does NOT roll back
   * an earlier write. Every refusal is therefore evaluated BEFORE the first
   * statement that changes anything — otherwise a denied hand-off could leave
   * the PR untouched with its RFQ already closed, destroying a live competition
   * on a request that was never forwarded. The stage move itself goes first,
   * for the same reason.
   */
  async readyForCs(prId: string, userId: string, role: string, remarks?: string) {
    const note = (remarks ?? '').trim();

    return this.db.withTransaction({ userId, role }, async (run) => {
      const r = await run<any>(
        `SELECT id, pr_number, status FROM proc.purchase_requisitions WHERE id = $1`,
        [prId],
      );
      if (r.rows.length === 0) throw new NotFoundException('PR not found');
      const pr = r.rows[0];

      // Same chain of custody as revertToHod, read the other way: procurement
      // owns this act only while the PR sits at its own stage.
      if (pr.status !== 'IN_PROCUREMENT_REVIEW') {
        throw new BadRequestException(
          `${pr.pr_number} has already been forwarded (it is at ${pr.status}). ` +
          'Procurement hands a request to CS only from procurement review.',
        );
      }

      // Routed through the CONFIGURED step for the same reasons revertToHod is:
      // one role table for every transition, and visible to an admin.
      await this.workflow.ensureStepForPr(prId, 'ready_for_cs');
      const routing = await this.workflow.getConfigForPr(prId);
      const step = routing.steps.find((s) => s.key === 'ready_for_cs');
      if (!step) {
        throw new BadRequestException(
          'the ready_for_cs step is not in this PR\'s routing configuration ' +
          `(${('source' in routing ? routing.source : 'live')}) — it cannot be forwarded right now`,
        );
      }
      if (step.from !== '*' && step.from !== pr.status) {
        throw new BadRequestException(
          `the ready_for_cs step accepts PRs at ${step.from}, not ${pr.status}`,
        );
      }
      this.authorizeAdvance(role, step, step, pr.status as string);

      // THE LAST GATE, and it is the one the buyer actually feels. Without a
      // quote there is nothing for CS to compare, and cs.service refuses to
      // build a statement from an empty field ('Quotes not yet received.').
      // Catching it here means the buyer is told before the hand-off rather
      // than after it, while they can still act.
      const comp = await run<{
        rfq_id: string; rfq_number: string; rfq_state: string;
        invited: number; live_quotes: number; waiting: number;
      }>(
        `SELECT r.id AS rfq_id, r.rfq_number, r.state AS rfq_state,
                (SELECT count(*)::int FROM proc.rfq_invitations i
                  WHERE i.rfq_id = r.id) AS invited,
                (SELECT count(DISTINCT q.vendor_id)::int FROM proc.quotations q
                  WHERE q.rfq_id = r.id AND q.state = 'Submitted') AS live_quotes,
                (SELECT count(*)::int FROM proc.rfq_invitations i
                  WHERE i.rfq_id = r.id
                    AND NOT EXISTS (SELECT 1 FROM proc.quotations q
                                     WHERE q.rfq_id = r.id AND q.vendor_id = i.vendor_id
                                       AND q.state = 'Submitted')) AS waiting
           FROM proc.rfq r
          WHERE r.pr_id = $1::uuid
            AND r.state <> 'Cancelled'
          ORDER BY r.created_at DESC
          LIMIT 1`,
        [prId],
      );
      const rfq = comp.rows[0];

      if (!rfq) {
        throw new BadRequestException(
          `${pr.pr_number} has no RFQ to forward — issue an RFQ and record at least ` +
          'one quotation before handing it to CS.',
        );
      }
      if (Number(rfq.live_quotes || 0) < 1) {
        const invited = Number(rfq.invited || 0);
        throw new BadRequestException(
          `${pr.pr_number} cannot go to CS yet: ${rfq.rfq_number} has no quotation in. ` +
          (invited > 0
            ? `${invited} vendor${invited === 1 ? ' has' : 's have'} been invited and none has quoted — ` +
              'CS compares quotations, so there is nothing to compare until one arrives.'
            : 'No vendor has been invited yet.') +
          ' Record a quotation first, or re-issue the RFQ to extend the deadline.',
        );
      }

      // ── past this line everything succeeds; nothing below can be refused ──
      const live = Number(rfq.live_quotes || 0);
      const waiting = Number(rfq.waiting || 0);
      const stamp = { note, by: userId, at: new Date().toISOString(), quotes: live };

      // STAGE MOVE FIRST, RFQ CLOSE SECOND — the same ordering rule as
      // revertToHod's cascade, for the same reason: per-statement commits mean a
      // refused close would leave a forwarded PR with a still-open RFQ.
      await run(
        `UPDATE proc.purchase_requisitions
            SET status = $1,
                stage_remarks = stage_remarks || jsonb_build_object('ready_for_cs', $2::jsonb)
          WHERE id = $3`,
        [step.to, JSON.stringify(stamp), prId],
      );

      const closed = await run<{ rfq_number: string }>(
        `UPDATE proc.rfq
            SET state = 'Closed'
          WHERE id = $1::uuid
            AND state = 'Open'
        RETURNING rfq_number`,
        [rfq.rfq_id],
      );

      return {
        prNumber: pr.pr_number,
        previousStage: pr.status,
        nextStage: step.to,
        rfq: rfq.rfq_number,
        quotations: live,
        // Named rather than left implicit: forwarding with vendors still to
        // reply is allowed, but the buyer should know the CS will score on an
        // incomplete field.
        vendorsAwaitingQuote: waiting,
        closedRfq: closed.rows.map((x) => x.rfq_number),
        forwardedBy: userId,
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  PER-LINE CAPEX/OPEX CLASSIFICATION
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Classify the lines of a PR as capital or operating.
   *
   * WHERE THIS HAPPENS
   * ------------------
   * At step 5, in the CS review chain — the desk that ran the competition and
   * knows what was quoted. The `cs_review` step declares `requiresCapexOpex`,
   * and the PR may not leave it until every approved line carries a class.
   *
   * The step's `from` is IN_PROCUREMENT_REVIEW, but the chain actually parks
   * the PR at QUOTES_RECEIVED, so "is the PR at the gated step" is asked two
   * ways: against the routing table, and against the live review row. Either
   * one means the PR is inside the window where the class is made.
   *
   * Finance may correct a class afterwards, and only afterwards: a correction
   * is a change to a decision that was already taken, so there has to BE a
   * decision, and the PR has to be far enough along that the class has already
   * been demanded.
   *
   * The classes are the D365 contract's five values (packages/d365-client
   * CLASSIFICATIONS), and the vocabulary is imported rather than retyped so
   * the API cannot accept a class the ERP does not know.
   */
  async setLineClassifications(
    prId: string,
    userId: string,
    role: string,
    costCenterIds: string[],
    input: {
      lines: Array<{ lineNo: number; classification: string; usefulLifeYears?: number | null }>;
      reason?: string;
    },
  ) {
    const ctx = { userId, role, costCenterIds };
    return this.db.withTransaction(ctx, async (run) => {
      const pr = await run<any>(
        `SELECT id, pr_number, status FROM proc.purchase_requisitions WHERE id = $1`,
        [prId],
      );
      if (pr.rows.length === 0) throw new NotFoundException('PR not found');
      const header = pr.rows[0];

      // Is the PR inside the window where the class is made?
      const routing = await this.workflow.getConfigForPr(prId);
      const gatedStep = routing.steps.find(
        (s) => s.requiresCapexOpex && (s.from === header.status || s.from === '*'),
      );
      const review = await run<any>(
        `SELECT cr.sub_state
           FROM proc.cs_reviews cr
           JOIN proc.comparative_statements cs ON cs.id = cr.cs_id
          WHERE cr.pr_id = $1::uuid
            AND cr.current_round = cs.cs_round
            AND cr.sub_state IN ('DRAFT','PROC_REVIEW','REQUESTER_REVIEW')`,
        [prId],
      );
      const inCsReview = review.rows.length > 0;

      const isHod = await isHodProcurement(this.db, userId, ctx);
      const mayClassify = roleAllowed(role, CLASSIFY_ROLES) || isHod;
      const mayCorrect = roleAllowed(role, CORRECT_ROLES);
      if (!mayClassify && !mayCorrect) {
        throw new ForbiddenException(
          'Only procurement, HOD Procurement, the committee secretary or finance may classify the ' +
          'lines of a request.',
        );
      }
      if (mayClassify && !mayCorrect && !gatedStep && !inCsReview) {
        throw new BadRequestException(
          `${header.pr_number} is at ${header.status}. The Capex/Opex classification is made at the ` +
          'comparative-statement exit, on the way into cost approval: after the review is confirmed ' +
          'and before the request advances. Finance can correct a classification once the request ' +
          'has reached cost approval.',
        );
      }
      if (mayCorrect && !mayClassify && !isCostConfirmedStage(String(header.status))) {
        throw new ForbiddenException(
          'A classification can only be corrected once the request has reached cost approval. ' +
          'Before that, it is set by procurement as part of the comparison.',
        );
      }

      // The lines being classified, and whether they are even in the spend.
      const rows = await run<any>(
        `SELECT line_no, description, approved, rejected, held
           FROM proc.pr_lines
          WHERE pr_id = $1::uuid
          ORDER BY line_no`,
        [prId],
      );
      const byLine = new Map<number, any>();
      for (const r of rows.rows) byLine.set(Number(r.line_no), r);

      const written: number[] = [];
      for (const entry of input.lines || []) {
        const lineNo = Number(entry.lineNo);
        const line = byLine.get(lineNo);
        if (!line) {
          throw new BadRequestException(`${header.pr_number} has no line ${lineNo}.`);
        }
        if (!line.approved || line.rejected || line.held) {
          throw new BadRequestException(
            `Line ${lineNo} of ${header.pr_number} is not being bought in this round, so it does not ` +
            'carry a Capex/Opex class. A class on a line nobody is buying would be a figure nobody ' +
            'reads and a total that does not add up.',
          );
        }
        const cls = CLASSIFICATIONS.find((c) => c.value === entry.classification);
        if (!cls) {
          throw new BadRequestException(
            `"${entry.classification}" is not a Capex/Opex class. The values are: ` +
            CLASSIFICATIONS.map((c) => c.value).join(', ') + '.',
          );
        }
        const life = entry.usefulLifeYears ?? null;
        if (cls.capex && (life === null || life === undefined || !(Number(life) > 0))) {
          throw new BadRequestException(
            `Line ${lineNo} is a capital line (${cls.value}) and needs a useful life. An asset with no ` +
            'depreciation period is not an asset — the ERP would take a default and nobody would know ' +
            'it had.',
          );
        }
        await run(
          `UPDATE proc.pr_lines
              SET classification = $2,
                  useful_life_years = $3,
                  classified_by = $4::uuid,
                  classified_at = now(),
                  classification_source = 'manual'
            WHERE pr_id = $1::uuid AND line_no = $5`,
          [prId, cls.value, cls.capex ? Number(life) : null, userId, lineNo],
        );
        written.push(lineNo);
      }

      // The header's split follows the lines.
      const totals = await syncPrTotals(run, prId);

      return {
        prNumber: header.pr_number,
        classified: written,
        capex_amount: totals.capex_amount,
        opex_amount: totals.opex_amount,
        estimated_amount: totals.estimated_amount,
        // The header's own summary, so the card can show the number the ERP
        // will read. It used to be absent here and derived from the ITEM
        // MASTER in the database — so classifying every line capital still left
        // a request calling itself an operating expense to `d365.service.ts`.
        expense_type: totals.expense_type,
        still_unclassified: totals.unclassified_lines,
        by: userId,
        at: new Date().toISOString(),
      };
    });
  }

  /**
   * RE-APPLY THE AWARD AND SYNC THE RATES.
   *
   * The recovery action for a PR whose statement was confirmed without its
   * winning rates ever reaching the lines — which is what 35 PRs sitting at
   * Cost approval with an UNKNOWN amount actually are. The same routine the
   * CS confirmation uses, so the repair cannot behave differently from the
   * path it repairs.
   *
   * It writes the awarded rates and recomputes the header. It does NOT move
   * the PR, does NOT touch the statement's state, and does NOT classify
   * anything: this is a money repair, not a decision.
   */
  async reapplyAward(prId: string, userId: string, role: string, costCenterIds: string[]) {
    const ctx = { userId, role, costCenterIds };
    if (!(await isHodProcurement(this.db, userId, ctx))
        && !roleAllowed(role, REAPPLY_AWARD_ROLES)) {
      throw new ForbiddenException(
        'Only procurement, HOD Procurement, the committee secretary or an administrator may ' +
        're-apply an award.',
      );
    }
    return this.db.withTransaction(ctx, async (run) => {
      const pr = await run<any>(
        `SELECT id, pr_number, status FROM proc.purchase_requisitions WHERE id = $1`,
        [prId],
      );
      if (pr.rows.length === 0) throw new NotFoundException('PR not found');
      const header = pr.rows[0];

      const cs = await run<any>(
        `SELECT id, cs_number, cs_round, state
           FROM proc.comparative_statements
          WHERE pr_id = $1::uuid
          ORDER BY cs_round DESC
          LIMIT 1`,
        [prId],
      );
      if (cs.rows.length === 0) {
        throw new BadRequestException(
          `${header.pr_number} has no comparative statement, so there is no award to re-apply.`,
        );
      }
      const statement = cs.rows[0];

      const sync = await applyAwardToPrLines(run, { prId, csId: statement.id });

      // A statement that was decided but never LOCKED is half a decision, and
      // the D365 push reads the winners from a locked statement with an INNER
      // JOIN — an unlocked one produces no row, so the purchase order would
      // push with no vendor on it. The lock is part of the repair.
      let locked: { awardMode: string; vendors: string[] } | null = null;
      if (statement.state !== 'Locked') {
        try {
          locked = await lockStatementWithAward(run, {
            csId: statement.id,
            userId,
            reason: `Award re-applied on ${new Date().toISOString().slice(0, 10)}.`,
          });
        } catch (e) {
          // No live award to lock. Reported, not thrown: the rates may still
          // have been recoverable, and refusing the whole repair over the
          // statement's state would leave the request stuck.
          locked = null;
        }
      }

      await run(
        `INSERT INTO audit.audit_log
           (actor_user_id, entity, entity_id, action, before, after, reason)
         VALUES ($1::uuid, 'proc.purchase_requisitions', $2::text, 'repair',
                 $3::jsonb, $4::jsonb, $5)`,
        [
          userId,
          prId,
          JSON.stringify({ estimated_amount: null, amount_status: null }),
          JSON.stringify({
            estimated_amount: sync.totals.estimated_amount,
            amount_status: sync.totals.amount_status,
            rates_applied: sync.synced,
            statement_locked: !!locked,
          }),
          `Award re-applied from ${statement.cs_number} (round ${statement.cs_round}, ${statement.state}).`,
        ],
      );

      return {
        prNumber: header.pr_number,
        csNumber: statement.cs_number,
        csState: statement.state,
        rates_applied: sync.synced,
        unawarded_lines: sync.unawarded_lines,
        split_lines: sync.split_lines,
        statement_locked: !!locked,
        awarded_vendors: locked?.vendors ?? [],
        estimated_amount: sync.totals.estimated_amount,
        capex_amount: sync.totals.capex_amount,
        opex_amount: sync.totals.opex_amount,
        amount_status: sync.totals.amount_status,
        by: userId,
        at: new Date().toISOString(),
      };
    });
  }
}
