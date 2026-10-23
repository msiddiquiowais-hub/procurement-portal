import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { DbService, type SessionContext } from '../db/db.service';
import { roleAllowed } from '@procurement/roles';
// cs_reviews.revert_lines is jsonb and arrives through the CSV bridge as a
// STRING, so a plain property access would be undefined forever.
import { parseJsonb } from './rfq.status';
import { WorkflowService } from '../workflow/workflow.service';
import { CS_DRAFT_STAGES } from './cs.stages';
// A leaf module with no imports of its own, so pulling the Cost approval gate in
// here cannot close a cycle back through pr.service.ts.
import { touchesCostApproval, costApprovalGateMessage } from '../pr/cost.stages';
// HOD Procurement, resolved from core.departments rather than a role string —
// also a leaf module, for the same cycle reason. See the note there: a role
// check would hand this gate to four other department heads.
import { isHodProcurement, hodProcurementRefusal } from '../pr/hod.procurement';
// The award sync and the per-line Capex/Opex class. Also a leaf module: it owns
// the approved-line rule, the header total and the award write-back, so the two
// doors out of step 5 cannot disagree about any of them.
import {
  applyAwardToPrLines,
  lockStatementWithAward,
  readAmountGateState,
  readApprovedLines,
  readAwardedLines,
} from './award.sync';

/**
 * CS COMPARATIVE STATEMENT REVIEW SUB-WORKFLOW (migration 065).
 *
 * Four states, inside the existing procurement stage:
 *
 *     DRAFT ──submit──▶ PROC_REVIEW ──send──▶ REQUESTER_REVIEW ──confirm──▶ CONFIRMED
 *        ▲                   │                        │                        │
 *        └───── soft revert ──┴──── hard revert ──────┘                        │
 *        └──────────────────────────────────────────────────────────────────────┘
 *                             (any pre-confirmation state may revert)
 *
 * WHY A SEPARATE SERVICE. proc.comparative_statements.state is read by
 * governance, award, D365 and the MC panel, and 813 rows already carry values
 * in it. The chain therefore lives in proc.cs_reviews (migration 065) and this
 * file owns nothing but the chain. CsService keeps ownership of the statement
 * itself — what is scored, and what is locked.
 *
 * WHY THE STAGE DOES NOT MOVE UNTIL CONFIRMATION. The review is a review. The
 * PR stays inside the sourcing competition — IN_PROCUREMENT_REVIEW, or
 * QUOTES_RECEIVED where the "Ready for CS" hand-off parks it — which is what
 * lets a soft revert return to a reviewer without the PR having gone anywhere.
 * Only CS_CONFIRMED advances the PR, and it does so through the CONFIGURED
 * cs_review step (order_index 17), never by writing a stage the routing table
 * does not describe. The admitted stages are CS_DRAFT_STAGES in ./cs.stages,
 * shared with generate() and lock() so confirmation is never stricter than
 * generation.
 *
 * ORDER IS A CONTROL. DbService.withTransaction() commits per statement, so a
 * refusal raised after a write does NOT undo it. Every gate below is therefore
 * evaluated BEFORE the first statement that changes anything.
 */

type Ctx = SessionContext;

/**
 * Who may approve a statement at PROC_REVIEW and forward it to the blind stage.
 *
 * HOD PROCUREMENT — resolved as an IDENTITY, not a role string, by
 * `isHodProcurement()` against `core.departments` (code 'PROC' -> hod_user_id).
 * See pr/hod.procurement.ts for why a role check cannot express this:
 * `roleAllowed('hod', 'hod')` is true for the Head of Finance, HR, IT and
 * Operations as well.
 *
 * What this replaces: `PROC_REVIEW_ROLES = 'procurement_manager,procurement,admin'`.
 * `procurement_manager` named nobody (0 users held it — a gate nobody could
 * pass), and `procurement` was the desk that RAN the competition approving its
 * own comparison before the requesting department ever saw it.
 *
 * `admin` remains, as the one role that takes no part in the sourcing decision.
 * Note this is a DIFFERENT control from the blind-confirm escalation below,
 * which is also admin-only and is not a route into this one.
 */
const PROC_REVIEW_FALLBACK_ROLES = 'admin';

/** The department-head vocabulary. `hod` is who actually signs in. */
const REQUESTER_REVIEW_ROLES = 'department_manager,hod';

/**
 * Who may open a draft: the desk that prepares the comparison.
 *
 * `procurement_manager` is gone here too. This was the other half of "the
 * officer drafts, the head approves" — leaving it in would have let a role
 * nobody holds open the document its replacement has to approve.
 */
const DRAFT_ROLES = 'cs,procurement,admin';

/**
 * Emergency override for a blind confirmation — `admin` ONLY.
 *
 * Deliberately NOT `procurement`. An escalation path that the people running the
 * competition can use is not a segregation of duties at all: they drafted and
 * ranked the very statement being confirmed, and the originating department —
 * whose money is being spent — would never have seen it. Admin is the one role
 * that is not a participant in the sourcing decision.
 */
const ESCALATION_ROLES = 'admin';

export type SubState = 'DRAFT' | 'PROC_REVIEW' | 'REQUESTER_REVIEW' | 'CONFIRMED' | 'REVERTED';

@Injectable()
export class CsReviewService {
  constructor(
    private readonly db: DbService,
    private readonly workflow: WorkflowService,
  ) {}

  // ── read ────────────────────────────────────────────────────────────────

  /**
   * The review chain for the PR's live round, or a null row when no review has
   * been started. Read on every CS screen load so the UI can render the state
   * machine and the correct set of buttons.
   */
  async forPr(prId: string, userId: string, role: string, costCenterIds: string[]) {
    const ctx = { userId, role, costCenterIds };
    const row = await this.loadLive(prId, ctx);
    if (!row) {
      // NO REVIEW ROW YET IS THE IMPLICIT DRAFT STATE, and it must offer the
      // entry point.
      //
      // This returned every action false, which meant the "Submit for
      // procurement review" button could never render on a freshly generated
      // statement: the button's own action is what CREATES the review row, so a
      // reader that insists the row exists first can never show the control
      // that would create it. The chain had no way in from the UI.
      //
      // Mirrors assertReviewable's `allowUnstarted` on the write side.
      const cs = await this.db.query<{ state: string | null; cs_number: string; cs_round: number }>(
        `SELECT cs.state, cs.cs_number, cs.cs_round
           FROM proc.comparative_statements cs
          WHERE cs.pr_id = $1::uuid
            AND cs.cs_round = proc.fn_latest_cs_round($1::uuid)
          LIMIT 1`,
        [prId],
        ctx,
      );
      const c = cs.rows[0];
      const generatable = Boolean(c) && c!.state === 'Generated';
      return {
        review: null,
        // Reported as DRAFT rather than null so the screen renders the chain
        // with step 1 current instead of an unlabelled state.
        sub_state: generatable ? 'DRAFT' : null,
        pr_status: null,
        masked_for_viewer: false,
        mask_reason: null,
        requester_scope: null,
        actions: {
          can_submit: generatable && roleAllowed(role, DRAFT_ROLES),
          can_send_to_requester: false,
          can_confirm: false,
          can_revert_soft: false,
          can_revert_hard: false,
          confirm_waiting_on: null,
        },
      };
    }
    return this.shape(row, prId, userId, role, ctx);
  }

  /** Load the live round's review row joined to its statement and PR stage. */
  private async loadLive(prId: string, ctx: Ctx) {
    const r = await this.db.query<any>(
      `SELECT cr.*, cs.state AS cs_state, cs.cs_number, cs.cs_round,
              pr.pr_number, pr.status AS pr_stage, pr.department_id,
              pr.requester_user_id
         FROM proc.cs_reviews cr
         JOIN proc.comparative_statements cs ON cs.id = cr.cs_id
         JOIN proc.purchase_requisitions pr   ON pr.id = cr.pr_id
        WHERE cr.pr_id = $1::uuid
          AND cr.current_round = (
            SELECT max(r2.current_round) FROM proc.cs_reviews r2
             WHERE r2.pr_id = cr.pr_id AND r2.cs_id = cr.cs_id)
        LIMIT 1`,
      [prId],
      ctx,
    );
    return r.rows[0] || null;
  }

  /**
   * Turn a review row into the screen payload, including who may act next and
   * whether this viewer is being shown a masked statement.
   */
  private async shape(row: any, prId: string, userId: string, role: string, ctx: Ctx) {
    const state = String(row.sub_state) as SubState;

    // Blind scope: the originating department's own reviewer, and only while
    // the statement is actually awaiting them. Computed here, server-side.
    const blind = await this.requesterScope(row.pr_id, userId, ctx);
    const masked = state === 'REQUESTER_REVIEW' && blind.isRequesterReviewer;

    // Procurement's own approval gate: the head of the Procurement department.
    // Resolved here, server-side, for the same reason the blind scope is — so
    // the button and the refusal are driven by one fact and cannot disagree.
    const mayApprove =
      (await isHodProcurement(this.db, userId, ctx)) ||
      roleAllowed(role, PROC_REVIEW_FALLBACK_ROLES);

    const atProcReview = state === 'PROC_REVIEW';
    const atRequesterReview = state === 'REQUESTER_REVIEW';
    const preConfirm = state === 'DRAFT' || atProcReview || atRequesterReview || state === 'REVERTED';

    return {
      review: {
        id: row.id,
        cs_id: row.cs_id,
        cs_number: row.cs_number,
        sub_state: state,
        current_round: Number(row.current_round),
        generated_at: row.generated_at,
        proc_review_at: row.proc_review_at,
        requester_review_at: row.requester_review_at,
        confirmed_at: row.confirmed_at,
        reverted_at: row.reverted_at,
        revert_kind: row.revert_kind ?? null,
        revert_reason: row.revert_reason ?? null,
        // Per-line objections from a blind soft revert (migration 066). Null
        // when the statement was returned without naming any line.
        revert_lines: parseJsonb(row.revert_lines) ?? null,
      },
      sub_state: state,
      pr_status: row.pr_stage,
      // True when THIS response had its commercial detail stripped. The UI must
      // say so rather than rendering the gaps as an empty table.
      masked_for_viewer: masked,
      // Why the blind reviewer cannot see the ranking — a name is not a reason.
      //
      // It names WHAT is withheld rather than listing everything that is masked.
      // It used to claim "prices … are withheld", while the panel below the
      // banner printed unit price, gross, discount, tax and line total: a
      // reviewer had no way to tell which statement was true, and the visible
      // figures were the true ones. `blindAwardDetail` documents the rule — the
      // rates are shown precisely BECAUSE confirming them is the reviewer's job.
      mask_reason: masked
        ? 'You are reviewing blind: which vendor won, and the scores and recommendation '
        + 'behind it, are withheld until you confirm. The rates, taxes and delivery terms '
        + 'are shown — confirming them is what you are here to do.'
        : null,
      requester_scope: blind.reason,
      actions: {
        can_submit: (state === 'DRAFT' || state === 'REVERTED')
          && roleAllowed(role, DRAFT_ROLES)
          && row.cs_state === 'Generated',
        can_send_to_requester: atProcReview && mayApprove,
        // The blind stage belongs to the mapped department approver. An admin
        // override is offered alongside it and shown as such — it is an escape
        // hatch, not a second route for procurement, who run the competition and
        // are exactly who the blind stage exists to keep out of the decision.
        can_confirm: atRequesterReview && (blind.isRequesterReviewer || roleAllowed(role, ESCALATION_ROLES)),
        // Reported so the screen can say who the confirmation is actually
        // waiting on instead of showing a nameless "waiting" line.
        confirm_waiting_on: atRequesterReview && !blind.isRequesterReviewer
          ? 'the originating department’s approver'
          : null,
        // Either kind of revert is available to whoever owns the open gate.
        can_revert_soft: preConfirm && (atProcReview || atRequesterReview)
          && (mayApprove || blind.isRequesterReviewer),
        can_revert_hard: preConfirm && (atProcReview || atRequesterReview)
          && mayApprove,
      },
    };
  }

  /**
   * Is this viewer the originating department's own reviewer?
   *
   * Scoped to the PR's originating department via proc.pr_departments.hod_user_id
   * — the same routing table the HOD gate uses — rather than by trusting a role
   * string. A role check alone would let ANY department manager open any PR's
   * blind review, which is the opposite of blind.
   *
   * REFUSES rather than defaults open. When the PR has no department mapping
   * the answer is "nobody is the requester reviewer", so the blind stage has no
   * one who may action it. That is reported as a reason instead of silently
   * falling back to unmasked access.
   */
  private async requesterScope(prId: string, userId: string, ctx: Ctx) {
    const r = await this.db.query<{ is_reviewer: boolean; has_mapping: boolean }>(
      `SELECT
         EXISTS (
           SELECT 1 FROM proc.pr_departments pd
            WHERE pd.pr_id = $1::uuid AND pd.hod_user_id = $2::uuid
         ) AS is_reviewer,
         EXISTS (
           SELECT 1 FROM proc.pr_departments pd
            WHERE pd.pr_id = $1::uuid
         ) AS has_mapping`,
      [prId, userId],
      ctx,
    );
    const isRequesterReviewer = r.rows[0]?.is_reviewer === true;
    const hasMapping = r.rows[0]?.has_mapping === true;
    return {
      isRequesterReviewer,
      reason: isRequesterReviewer
        ? null
        : hasMapping
          ? 'This blind review belongs to the originating department’s approver.'
          : 'This PR has no department approver mapped, so nobody is entitled to its blind review.',
    };
  }

  /**
   * Public read used by CsService.detail() to decide whether to strip the
   * payload. Same query as the private requesterScope(), plus the current
   * sub-state, so the masking decision and the action buttons can never
   * disagree about which state the statement is in.
   */
  async blindScope(prId: string, userId: string, ctx: Ctx) {
    const [scope, review] = await Promise.all([
      this.requesterScope(prId, userId, ctx),
      this.loadLive(prId, ctx),
    ]);
    return {
      isRequesterReviewer: scope.isRequesterReviewer,
      reason: scope.reason,
      subState: review ? review.sub_state : null,
    };
  }

  /**
 * Is a review row in force for this statement's live round?
 *
 * Used by CsService.lock() to refuse the legacy bypass. Returns the sub-state,
 * or null when the statement has never entered review — which is the case for
 * all 390 pre-existing statements, so they keep their original behaviour.
 */
async activeReviewState(csId: string, ctx: Ctx): Promise<string | null> {
  const r = await this.db.query<{ sub_state: string }>(
    `SELECT cr.sub_state
       FROM proc.cs_reviews cr
       JOIN proc.comparative_statements cs ON cs.id = cr.cs_id
      WHERE cr.cs_id = $1::uuid AND cr.current_round = cs.cs_round
      LIMIT 1`,
    [csId],
    ctx,
  );
  return r.rows[0]?.sub_state ?? null;
}

  // ── transitions ─────────────────────────────────────────────────────────

  /** DRAFT|REVERTED -> PROC_REVIEW. */
  async submitForProcReview(csId: string, userId: string, role: string, costCenterIds: string[]) {
    if (!roleAllowed(role, DRAFT_ROLES)) {
      throw new ForbiddenException('Only CS, Procurement or Procurement Manager can submit the statement for review.');
    }
    const ctx = { userId, role, costCenterIds };

    return this.db.withTransaction(ctx, async (run) => {
      const head = await this.assertReviewable(csId, run, ['DRAFT', 'REVERTED'], true);
      // A statement that is already Locked is a recorded decision. Reviewing it
      // would be reviewing the past.
      if (head.cs_state !== 'Generated') {
        throw new BadRequestException(
          `${head.cs_number} is ${head.cs_state}; only a Generated statement can enter review.`,
        );
      }

      const row = await this.upsertReview(head, run);
      await run(
        `UPDATE proc.cs_reviews
            SET sub_state = 'PROC_REVIEW',
                masked_for_requester = false,
                proc_reviewer_user_id = $2,
                proc_review_at = now(),
                revert_kind = NULL, revert_reason = NULL, reverted_at = NULL
          WHERE id = $1`,
        [row.id, userId],
      );

      return {
        csId, csNumber: head.cs_number, subState: 'PROC_REVIEW',
        next: 'A Procurement Manager must review the statement before it reaches the requester.',
      };
    });
  }

  /** PROC_REVIEW -> REQUESTER_REVIEW. This is where the blind mask goes ON. */
  async sendToRequester(csId: string, userId: string, role: string, costCenterIds: string[]) {
    const ctx = { userId, role, costCenterIds };
    // ORDER IS A CONTROL: this refusal precedes the transaction and therefore
    // precedes every write. withTransaction() commits per statement, so a gate
    // raised after the first UPDATE would not undo it.
    if (!(await isHodProcurement(this.db, userId, ctx))
        && !roleAllowed(role, PROC_REVIEW_FALLBACK_ROLES)) {
      throw new ForbiddenException(hodProcurementRefusal('Approving a statement before it advances'));
    }

    return this.db.withTransaction(ctx, async (run) => {
      const head = await this.assertReviewable(csId, run, ['PROC_REVIEW']);
      const row = await this.currentRow(csId, run);
      if (!row) throw new BadRequestException('This statement has no review in progress.');

      // A blind stage nobody can action is the trapdoor this feature must not
      // build. Refuse BEFORE flipping the mask on.
      const owner = await this.db.query<{ hod_user_id: string }>(
        `SELECT pd.hod_user_id FROM proc.pr_departments pd
          WHERE pd.pr_id = $1::uuid AND pd.hod_user_id IS NOT NULL
          LIMIT 1`,
        [head.pr_id],
        ctx,
      );
      if (owner.rows.length === 0 || !owner.rows[0]?.hod_user_id) {
        throw new BadRequestException(
          `${head.pr_number} has no department approver mapped, so there is nobody to send a ` +
          'blind review to. Map the department approver first.',
        );
      }

      await run(
        `UPDATE proc.cs_reviews
            SET sub_state = 'REQUESTER_REVIEW',
                masked_for_requester = true,
                requester_reviewer_user_id = $2,
                requester_review_at = now()
          WHERE id = $1`,
        [row.id, owner.rows[0].hod_user_id],
      );

      return {
        csId, csNumber: head.cs_number, subState: 'REQUESTER_REVIEW',
        next: 'The originating department reviews this blind — vendor detail is withheld.',
      };
    });
  }

  /**
   * REQUESTER_REVIEW -> CONFIRMED. The PR does NOT move.
   *
   * It used to. This action wrote `SET status = step.to` directly, taking the
   * request to IN_COST_CENTER_APPROVAL from behind the engine's back, and that
   * write is why the classification gate had to live here:
   *
   *   A step's requiresCapexOpex is enforced in PrService.advance(). This route
   *   never went through advance(), so nothing enforced it — and rather than
   *   leave the crossing ungated, the check was duplicated into this method.
   *   That is how a blind rate check ended up refusing to release a request
   *   whose only defect was that nobody had classified its lines yet, when the
   *   person confirming was the requesting HOD and the classification is
   *   procurement's to make AFTER this confirmation.
   *
   * So the crossing moved to where it belongs. The confirm is now exactly what
   * the blind stage is for — the originating department signs off that the
   * commercial rates are sound — and it writes the award onto the lines, locks
   * the statement and records the audit trail. The request then sits at its
   * sourcing stage with a confirmed, priced, locked statement, and procurement
   * classifies it and advances it through the engine, where the gate is.
   *
   * The refusals that remain are the two the reviewer is actually competent to
   * make: an undecided line (nothing was awarded) and an award with no rate
   * behind it. Both are commercial facts visible on the comparison in front of
   * them. The classification is not one of them.
   */
  async confirm(csId: string, userId: string, role: string, costCenterIds: string[]) {
    const ctx = { userId, role, costCenterIds };

    return this.db.withTransaction(ctx, async (run) => {
      const head = await this.assertReviewable(csId, run, ['REQUESTER_REVIEW']);
      const row = await this.currentRow(csId, run);
      if (!row) throw new BadRequestException('This statement has no review in progress.');

      // Resolved here and enforced once, after the step is resolved, so the refusal
      // names the actual problem. The rule is stated below at the gate.
      const blind = await this.requesterScope(head.pr_id, userId, ctx);

      if (head.cs_state !== 'Generated') {
        throw new BadRequestException(
          `${head.cs_number} is ${head.cs_state}; only a Generated statement can be confirmed.`,
        );
      }

      // Resolve the step BEFORE any write. An unresolvable step must not leave a
      // confirmed review attached to a PR that never moved.
      await this.workflow.ensureStepForPr(head.pr_id, 'cs_review');
      const routing = await this.workflow.getConfigForPr(head.pr_id);
      const step = routing.steps.find((s) => s.key === 'cs_review');
      if (!step) {
        throw new BadRequestException(
          "the cs_review step is not in this PR's routing configuration — it cannot be confirmed right now",
        );
      }
      // The step declares a SINGLE `from`, and cs_review is seeded
      // IN_PROCUREMENT_REVIEW. A PR parked at QUOTES_RECEIVED by the Ready-for-CS
      // hand-off is therefore refused HERE — one check before the stage gate it
      // is really about — so fixing only the stage gate would have changed the
      // error text and not the outcome.
      //
      // A step's `from` names where it was authored to fire, not a claim that
      // nothing else may. The strict reading (from === pr_stage or nothing) makes
      // the chain unconfirmable for every request that took the hand-off, which
      // is most of them. So the step must still be a REAL configured step with a
      // real `to` — the stage is written from the routing table either way — but
      // its `from` is checked against the admitted sourcing stages rather than
      // against the PR's exact current string.
      const stepAdmitsStage =
        step.from === '*' || CS_DRAFT_STAGES.includes(step.from) || step.from === head.pr_stage;
      if (!stepAdmitsStage) {
        throw new BadRequestException(
          `the cs_review step accepts PRs at ${step.from}, not ${head.pr_stage}`,
        );
      }
      // THE PR MUST STILL BE INSIDE THE SOURCING COMPETITION.
      //
      // This was `head.pr_stage !== 'IN_PROCUREMENT_REVIEW'`, copied from the
      // assumption that a review never leaves procurement review. It does not
      // survive contact with the "Ready for CS" hand-off (migration 064): that
      // step routes IN_PROCUREMENT_REVIEW -> QUOTES_RECEIVED, and the CS is
      // GENERATED after it, so a perfectly normal request is at QUOTES_RECEIVED
      // while its review chain runs. Confirming one of those threw
      // "PR stage mismatch" and left the blind reviewer permanently unable to
      // finish — the exact dead end the chain exists to avoid.
      //
      // CS_DRAFT_STAGES is already the measured answer to "where may a CS exist":
      // generate() and lock() both admit these two, and the live estate agrees
      // (reviews sit at both). Confirming a statement must not be stricter than
      // generating it, or the statement becomes unconfirmable.
      if (!CS_DRAFT_STAGES.includes(head.pr_stage)) {
        throw new BadRequestException(
          `${head.pr_number} is at ${head.pr_stage}; confirmation moves the PR out of sourcing.`,
        );
      }
      // SEGREGATION OF DUTIES — the blind review is the whole point, and it is
      // destroyed the moment procurement confirms it.
      //
      // This previously accepted any PROC_REVIEW role as an escalation path,
      // which is precisely the shortcut the blind stage exists to close:
      // procurement drafted the comparison, procurement ranked the vendors, and
      // procurement then signed off on its own work while the originating
      // department — the party whose money is being spent — never saw it.
      //
      // So the ONLY two ways to confirm are: the mapped blind reviewer, or admin
      // as a recorded emergency override. Procurement is refused, which is the
      // control working, not a gap in it.
      const isEscalation = roleAllowed(role, ESCALATION_ROLES);
      const mayConfirm = blind.isRequesterReviewer || isEscalation;
      if (!mayConfirm) {
        throw new ForbiddenException(
          blind.reason ??
          'Only the originating department’s approver may confirm a blind review. ' +
          'An administrator can override this if the approver is unavailable.',
        );
      }

      // DELIBERATELY NO actorRole CHECK HERE.
      //
      // There used to be one immediately below this comment:
      //
      //     const mayAct = roleAllowed(role, step.actorRole ?? '') || mayConfirm;
      //
      // It was harmless while cs_review's actorRole was `procurement_manager`,
      // because nobody held that role — `mayAct` added nothing to `mayConfirm`.
      // Migration 070 rebinds the step to `hod`, and the same line would then
      // have made EVERY department head a blind confirmer: roleAllowed('hod',
      // 'hod') is true for the Head of Finance, HR, IT and Operations alike, so
      // the Head of Finance could have confirmed the blind review of a request
      // they hold no department claim to — the precise failure the blind stage
      // exists to prevent, introduced by the fix for it.
      //
      // The step's actorRole answers "who OWNS this routing step", which is not
      // the question being asked here. "Who may confirm the originating
      // department's blind review" is answered above and has exactly two
      // answers: the mapped blind reviewer, or a recorded admin override.
      //
      // Removing the clause is behaviour-preserving today (mayAct was false for
      // every role in the deployment) and closes a segregation-of-duties hole
      // that would otherwise have opened the moment the step was owned by
      // anybody at all.

      // ── THE AWARD AND THE RATES ──────────────────────────────────────────
      //
      // Two things have to be true before the PR may leave step 5, and both are
      // checked BEFORE anything is written.
      //
      // ONE: the competition must have produced an award for every approved
      // line. The winning rates exist — proc.cs_line_awards carries them, and
      // the D365 push already prefers them over the estimate — but nothing
      // ever wrote them onto proc.pr_lines. So the PR's amount stayed UNKNOWN
      // and the cost gate refused it forever. Thirty-five PRs are sitting at
      // Cost approval right now with a statement that was confirmed but never
      // priced. The write-back happens below, in this same transaction.
      //
      // TWO: every approved line must carry a rate. An award with no
      // quotation behind it is a decision nobody can cost.
      //
      // A THIRD used to be checked here — the per-line Capex/Opex class — and it
      // is deliberately not. See the method comment: the reviewer confirming
      // this statement is verifying commercial rates blind, and the class is
      // procurement's decision, made after this confirmation and enforced on
      // the step that crosses into cost approval. Asking for it here asked the
      // wrong desk for the wrong answer at the wrong moment.
      const approvedLines = await readApprovedLines(run, head.pr_id);
      const awardedLines = await readAwardedLines(run, csId);

      // One award per line: the vendor with the largest share of it. A split
      // (two vendors winning part of one line) is reported rather than hidden,
      // because the line's unit price is then a choice, not a fact.
      const awardByLine = new Map<number, (typeof awardedLines)[number]>();
      const splitLines: number[] = [];
      for (const a of awardedLines) {
        if (!a.approved || a.rejected || a.held) continue;
        const key = Number(a.line_no);
        const held = awardByLine.get(key);
        if (!held) {
          awardByLine.set(key, a);
          continue;
        }
        if (!splitLines.includes(key)) splitLines.push(key);
        if (Number(a.awarded_qty || 0) > Number(held.awarded_qty || 0)) awardByLine.set(key, a);
      }

      const unawarded: number[] = [];
      const unpriced: number[] = [];
      for (const l of approvedLines) {
        const award = awardByLine.get(l.line_no);
        if (!award) {
          unawarded.push(l.line_no);
          continue;
        }
        if (award.awarded_unit_price === null || award.awarded_unit_price === undefined) {
          unpriced.push(l.line_no);
        }
      }

      if (unawarded.length) {
        throw new BadRequestException(
          `${head.pr_number} cannot leave the CS stage with an undecided line. ` +
          `Line${unawarded.length > 1 ? 's' : ''} ${unawarded.join(', ')} ` +
          `${unawarded.length > 1 ? 'have' : 'has'} no award on this comparison. ` +
          'Every line that was put out to vendors must be awarded before the statement can be ' +
          'confirmed — otherwise the cost centre would be asked to approve a spend that nobody ' +
          'agreed a price for.',
        );
      }

      if (unpriced.length) {
        throw new BadRequestException(
          `${head.pr_number} cannot leave the CS stage with an award that carries no rate. ` +
          `Line${unpriced.length > 1 ? 's' : ''} ${unpriced.join(', ')} ` +
          `${unpriced.length > 1 ? 'have' : 'has'} an award with no quotation price behind it. ` +
          'The winning rate is what the cost centre confirms against, so it has to exist.',
        );
      }

      // NO CLASSIFICATION GATE HERE. That check lived in this block and has been
      // moved to the advance, onto the step that crosses into cost approval
      // (cs_review / cs_review_quotes, both requiresCapexOpex). It is kept out of
      // this method deliberately, not overlooked: the forward-only `gateFrom`
      // rule still exists — read through `capexOpexGateApplies` in ./award.sync,
      // which the advance calls — because that is where a request that predates
      // the gate is exempt. What is gone here is only the demand that the blind
      // reviewer produce the class.
      //
      // The rates, though, are not optional — they are what makes the request
      // affordable — and they are written below. Everything is decided and
      // nothing is refused: write the winning rates onto the PR lines, lock the
      // statement, and recompute the header.
      const sync = await applyAwardToPrLines(run, { prId: head.pr_id, csId });
      const locked = await lockStatementWithAward(run, {
        csId,
        userId,
        reason: `Confirmed through the CS review chain on ${new Date().toISOString().slice(0, 10)}.`,
      });

      // ── THE COST-APPROVAL ESTIMATE GATE — THE SECOND DOOR ───────────────────
      //
      // This used to be load-bearing: this route wrote `SET status = step.to`
      // directly and never went through PrService.advance(), so the identical
      // gate in advance() did not run here — a gate with the other door standing
      // open is not a gate.
      //
      // It no longer writes the stage, so advance() is the only door and that
      // gate is now the authoritative one. This check stays anyway, deliberately:
      // it runs AFTER applyAwardToPrLines, so it is really asserting that the
      // award write-back did what it claims, and it refuses a statement whose
      // lines are still unpriced before the confirmation is recorded at all. A
      // request that would arrive at the cost centre unpriced is stopped while
      // the thing that will cause it is still in front of the reviewer.
      //
      // Both doors read the same predicate from ../pr/cost.stages, so they cannot
      // drift apart in what they consider a priced PR. The lines are the
      // APPROVED ones, for the same reason on both sides.
      if (touchesCostApproval(step)) {
        const cost = await readAmountGateState(run, head.pr_id);
        if (cost.amount_status !== 'ESTIMATED') {
          throw new BadRequestException(
            costApprovalGateMessage(
              head.pr_number,
              cost.unpriced_lines,
              'Set a unit price on every line before confirming the comparative statement.',
            ),
          );
        }
      }

      // ── past this line nothing can be refused ──
      await run(
        `UPDATE proc.cs_reviews
            SET sub_state = 'CONFIRMED',
                masked_for_requester = false,
                confirmed_at = now()
          WHERE id = $1`,
        [row.id],
      );

      // THE STAGE IS NOT WRITTEN HERE.
      //
      // This used to be `SET status = $1` with step.to, which took the request to
      // IN_COST_CENTER_APPROVAL without ever passing through the engine — and
      // therefore without ever passing through the step's requiresCapexOpex
      // gate. That is the whole reason the classification check had to be
      // duplicated into this method, and the whole reason the requesting HOD
      // could not finish a blind review.
      //
      // The advance owns the crossing now. The confirmation itself is recorded
      // in the immutable audit trail instead of on the request — which is not
      // only better, it is the ONLY option: proc.fn_pr_stage_remarks_guard
      // REFUSES a change to stage_remarks that is not accompanied by a change
      // of status. The old statement wrote stage_remarks without moving the
      // stage, so keeping it after removing the stage move fails with
      //
      //   stage_remarks on PR-2026-202043 may only change when the PR changes
      //   stage (status is still QUOTES_RECEIVED)
      //
      // — a 500 from a trigger, on the very action this change exists to make
      // work. The guard is right: a stage remark that arrives with no stage
      // change is a remark about nothing.
      await run(
        `INSERT INTO audit.audit_log
           (actor_user_id, entity, entity_id, action, after, reason)
         VALUES ($1::uuid, 'proc.purchase_requisitions', $2::text, 'approve', $3::jsonb, $4)`,
        [
          userId,
          head.pr_id,
          JSON.stringify({
            event: 'cs_review_confirmed',
            cs: head.cs_number,
            cs_id: csId,
            review_round: row.current_round,
            pr_stage_at_confirmation: head.pr_stage,
            rates_applied: sync.synced.length,
            split_lines: sync.split_lines,
            estimated_amount: sync.totals.estimated_amount,
            statement_locked: true,
            award_mode: locked.awardMode,
            // Deliberately NOT a stage change: the request stays in sourcing
            // until procurement classifies it and advances it.
            advanced_to: null,
          }),
          `Blind comparative review confirmed for ${head.cs_number}; ${head.pr_number} held at ${head.pr_stage} pending Capex/Opex classification.`,
        ],
      );

      return {
        csId, csNumber: head.cs_number, subState: 'CONFIRMED',
        prNumber: head.pr_number,
        // Unchanged by this action, and reported as such rather than as a move.
        previousStage: head.pr_stage,
        nextStage: head.pr_stage,
        // Where the request goes NEXT is a decision, not a side effect: the step
        // that will move it, once procurement has classified every approved line.
        exitStep: head.pr_stage === 'QUOTES_RECEIVED' ? 'cs_review_quotes' : 'cs_review',
        matchedStep: step.key,
        // What the confirmation actually did to the money. The rates are now on
        // the PR lines and the header carries a known amount, which is what
        // lets the PR cross into Cost approval at all.
        rates_applied: sync.synced,
        split_lines: sync.split_lines,
        statement_locked: true,
        award_mode: locked.awardMode,
        awarded_vendors: locked.vendors,
        estimated_amount: sync.totals.estimated_amount,
        capex_amount: sync.totals.capex_amount,
        opex_amount: sync.totals.opex_amount,
        next: `Statement confirmed. ${sync.synced.length} line rate${sync.synced.length === 1 ? '' : 's'} written to ${head.pr_number}. ` +
          `The request stays at ${head.pr_stage} until Procurement classifies every line and advances it to ${step.to}.`,
      };
    });
  }

  /**
   * SOFT revert — send it back for negotiation. The statement, the RFQ and
   * every quotation survive; nothing is cancelled. This is the branch for
   * "the comparison is wrong", not "the competition was wrong".
   */
  async revertSoft(
    csId: string, userId: string, role: string, costCenterIds: string[],
    reason: string, flags?: unknown,
  ) {
    return this.revert(csId, userId, role, costCenterIds, 'SOFT', reason, flags);
  }

  /**
   * HARD revert — withdraw the statement and open a fresh round. Used when the
   * competition itself must be re-solicited.
   */
  async revertHard(csId: string, userId: string, role: string, costCenterIds: string[], reason: string) {
    return this.revert(csId, userId, role, costCenterIds, 'HARD', reason);
  }

  /**
   * Per-line negotiation flags the blind reviewer can attach to a SOFT revert.
   *
   * `{ line_no: number, decision: 'NEGOTIATE', target_remarks?: string }[]`
   *
   * The point of the flags is that a reviewer who disagrees with ONE line does
   * not have to reject the whole statement, and the officer receiving it learns
   * which line and why. Stored verbatim on the review row; nothing about the
   * award itself is changed — that is what makes this a SOFT revert.
   */
  private validateFlags(raw: unknown): Array<{ line_no: number; decision: string; target_remarks: string | null }> {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new BadRequestException('revertLines must be an array');
    if (raw.length > 200) throw new BadRequestException('revertLines carries too many entries');
    return raw.map((f: any) => {
      const lineNo = Number(f?.line_no);
      if (!Number.isInteger(lineNo) || lineNo < 1) {
        throw new BadRequestException(`revertLines: line_no must be a positive integer, received ${String(f?.line_no)}`);
      }
      if (f?.decision !== 'NEGOTIATE') {
        throw new BadRequestException(`revertLines: decision must be 'NEGOTIATE', received ${String(f?.decision)}`);
      }
      const remarks = String(f?.target_remarks ?? '').trim();
      if (remarks.length === 0) {
        // A flagged line with no reason tells the buyer nothing actionable. This
        // is the same rule as the revert reason itself: an audit entry that says
        // nothing is not an audit entry.
        throw new BadRequestException(`revertLines: line ${lineNo} is flagged for negotiation with no target rate or reason.`);
      }
      return { line_no: lineNo, decision: 'NEGOTIATE', target_remarks: remarks };
    });
  }

  private async revert(
    csId: string, userId: string, role: string, costCenterIds: string[],
    kind: 'SOFT' | 'HARD', reasonRaw: string,
    flagsRaw?: unknown,
  ) {
    const flags = this.validateFlags(flagsRaw);
    const reason = (flags.length > 0
      ? reasonRaw
      : (reasonRaw ?? '')).trim() || (flags.length > 0 ? 'Returned for negotiation by the originating department.' : '');
    // A revert with no reason is not an audit trail entry, it is a shrug. The
    // table also enforces this, but the service refuses first so the caller
    // gets a useful message instead of a constraint violation.
    if (reason.length === 0) {
      throw new BadRequestException('A revert must record why the statement is going back.');
    }

    const ctx = { userId, role, costCenterIds };
    if (kind === 'HARD' && !(await isHodProcurement(this.db, userId, ctx))
        && !roleAllowed(role, PROC_REVIEW_FALLBACK_ROLES)) {
      throw new ForbiddenException(hodProcurementRefusal('Withdrawing a statement outright'));
    }
    if (!(await isHodProcurement(this.db, userId, ctx))
        && !roleAllowed(role, PROC_REVIEW_FALLBACK_ROLES)
        && !roleAllowed(role, REQUESTER_REVIEW_ROLES)) {
      throw new ForbiddenException('You cannot revert a comparative statement review.');
    }

    return this.db.withTransaction(ctx, async (run) => {
      const head = await this.assertReviewable(csId, run, ['PROC_REVIEW', 'REQUESTER_REVIEW']);
      const row = await this.currentRow(csId, run);
      if (!row) throw new BadRequestException('This statement has no review in progress.');

      if (head.cs_state === 'Locked') {
        throw new BadRequestException(
          `${head.cs_number} is already Locked; a recorded decision cannot be reverted.`,
        );
      }

      // ── past this line nothing can be refused ──
      await run(
        `UPDATE proc.cs_reviews
            SET sub_state = 'REVERTED',
                masked_for_requester = false,
                revert_kind = $2,
                revert_reason = $3,
                revert_lines = $4::jsonb,
                reverted_at = now()
          WHERE id = $1`,
        [row.id, kind, reason, flags.length > 0 ? JSON.stringify(flags) : null],
      );

      // A HARD revert does NOT rewrite proc.comparative_statements.
      //
      // The obvious move is to set that row's state to 'Withdrawn', and it is
      // wrong twice over. comparative_statements_state_check permits only
      // 'Generated', 'Locked' or NULL, so the write raises a constraint
      // violation and returns a 500 — the withdrawal is recorded nowhere and
      // the reviewer is told nothing. And even if the constraint allowed it,
      // this feature's whole design is that the chain lives in proc.cs_reviews
      // and the statement table is left exactly as it is.
      //
      // So the withdrawal IS the review row: sub_state REVERTED with
      // revert_kind HARD. CsService.generate() reads that row to decide whether
      // the live round still blocks a new one, and opens the next round. The
      // withdrawn statement stays as evidence of what was objected to, which is
      // the same reason a rejected MC round is never deleted.
      return {
        csId, csNumber: head.cs_number, subState: 'REVERTED',
        revertKind: kind,
        reason,
        flaggedLines: flags,
        withdrawnStatement: kind === 'HARD' ? csId : null,
        next: kind === 'SOFT'
          ? 'Returned for negotiation. The RFQ and its quotations are untouched.'
          : 'Statement withdrawn. A new round can be generated once the field is re-solicited.',
      };
    });
  }

  // ── internals ───────────────────────────────────────────────────────────

  /**
   * The statement under review, plus the PR stage. Every refusal path starts
   * here so that a caller can never reach a write without having proved which
   * statement and which stage it is acting on.
   */
  private async assertReviewable(
    csId: string,
    run: <T = any>(sql: string, p?: any[]) => Promise<any>,
    allowed: string[],
    /** True only for the transition that CREATES the chain. See the body. */
    allowUnstarted = false,
  ) {
    const r = await run<any>(
      `SELECT cs.id, cs.cs_number, cs.cs_round, cs.pr_id, cs.state AS cs_state,
              pr.pr_number, pr.status AS pr_stage
         FROM proc.comparative_statements cs
         JOIN proc.purchase_requisitions pr ON pr.id = cs.pr_id
        WHERE cs.id = $1::uuid`,
      [csId],
    );
    if (r.rows.length === 0) throw new NotFoundException('Comparative Statement not found');
    const head = r.rows[0];

    const latest = await run<{ r: number }>(
      `SELECT proc.fn_latest_cs_round($1::uuid) AS r`, [head.pr_id],
    );
    if (Number(head.cs_round) !== Number(latest.rows[0]?.r ?? 0)) {
      throw new BadRequestException(
        `${head.cs_number} is round ${head.cs_round}, which is no longer in force — ` +
        'a later round superseded it',
      );
    }

    const row = await this.currentRow(csId, run);
    const state = row ? String(row.sub_state) : null;

    // `allowUnstarted` is for the ONE transition that creates the chain.
    //
    // submitForProcReview() is the entry point, so it is the only action that
    // may legitimately run when no review row exists yet — it is what upserts
    // one. Every other action requires an existing row, otherwise "no review in
    // progress" would be indistinguishable from "your review is in a different
    // state" and the second case would silently fall through to the first.
    if (!allowUnstarted && !allowed.includes(state ?? '')) {
      throw new BadRequestException(
        row
          ? `${head.cs_number} is in ${state}; this action is only valid at ${allowed.join(' or ')}.`
          : `${head.cs_number} has no review in progress — start one before acting on it.`,
      );
    }
    // If the row DOES exist, it must be in an allowed state. Unstarted is not a
    // wildcard: re-submitting an in-flight review is still refused.
    if (allowUnstarted && state !== null && !allowed.includes(state)) {
      throw new BadRequestException(
        `${head.cs_number} is in ${state}; this action is only valid at ${allowed.join(' or ')}.`,
      );
    }
    return head;
  }

  /**
   * The review row for a statement's live round, if any.
   *
   * Matches `current_round` against the STATEMENT's own `cs_round`, so a review
   * row left behind on a superseded round can never be read as the live one.
   *
   * This took a second `head.cs_id` argument that the header query does not
   * select, so the bound parameter was `undefined` and this read NULL — which
   * surfaced as "has no review in progress" against a review that plainly
   * existed in the table.
   */
  private async currentRow(csId: string, run: <T = any>(sql: string, p?: any[]) => Promise<any>) {
    const r = await run<any>(
      `SELECT cr.* FROM proc.cs_reviews cr
         JOIN proc.comparative_statements cs ON cs.id = cr.cs_id
        WHERE cr.cs_id = $1::uuid
          AND cr.current_round = cs.cs_round
        LIMIT 1`,
      [csId],
    );
    return r.rows[0] || null;
  }

  /**
   * Fetch or create the review row for the statement's current round. The
   * UNIQUE(cs_id, current_round) constraint means a second concurrent submit
   * collides here rather than producing two competing reviews.
   */
  private async upsertReview(head: any, run: <T = any>(sql: string, p?: any[]) => Promise<any>) {
    const r = await run<{ id: string }>(
      `INSERT INTO proc.cs_reviews (cs_id, pr_id, sub_state, current_round, generated_at)
       VALUES ($1, $2, 'DRAFT', $3, now())
       ON CONFLICT (cs_id, current_round) DO UPDATE SET updated_at = now()
       RETURNING id`,
      [head.id, head.pr_id, Number(head.cs_round)],
    );
    return r.rows[0];
  }
}