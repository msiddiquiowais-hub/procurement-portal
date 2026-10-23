// cost.stages.ts — when the cost of a PR is settled, and when it is knowable.
//
// THE POINT OF THIS FILE — one predicate, two consumers.
//
// A PR's estimated_amount is the requester's pre-RFQ BUDGET guess. It is not
// what the organisation is about to pay. The real cost appears only once the RFQ
// has come back and a line has been AWARDED, and it arrives with the vendor's own
// commercial terms already resolved: discount applied, tax added, delivered.
//
// So there are two different questions, and this app used to conflate them:
//
//   "What did we think this would cost?"  -> estimated_amount  (from day one)
//   "What did we agree to pay?"            -> the AWARD        (from sourcing on)
//
// Showing the estimate at the CS exit as though it were the cost is how a
// budget-vs-actual control turns into a rubber stamp — the number on screen is
// the one the requester guessed, and the one that actually matters is in another
// screen entirely. So from Finance review onward the screen shows BOTH, side by
// side, with the variance between them.
//
// WHY THE STAGES ARE A LIST AND NOT A COMPARISON
// ------------------------------------------------
// There is no monotonic "rank" to compare against: IN_FINANCE_REVIEW is reached
// from IN_PROCUREMENT_REVIEW and from QUOTES_RECEIVED, but the sourcing
// sub-states (CS_LOCKED, PACK_LOCKED) sit on branches that never pass through it
// at all, and REJECTED/ON_HOLD can be entered from anywhere. Writing
// `stage >= COST_APPROVAL` would quietly exclude the governance path or admit
// REJECTED, and neither is what anyone means. The set is stated.
//
// REJECTED and ON_HOLD are deliberately ABSENT. They are not "cost confirmed",
// they are "this PR is not proceeding". A PR rejected after the CS exit keeps
// its history in the audit trail; it does not keep advertising a live award on
// its detail page.
//
// WHY THIS IS ITS OWN FILE, NOT A CONSTANT IN pr.service.ts
// -------------------------------------------------------
// pr.service.ts imports this. The web renders from the flag this produces. If the
// stage list were inlined at each use site, the columns and the gate would be two
// declarations of one rule and could drift — the columns would appear at a stage
// the gate does not enforce, or (far worse, and the exact bug class this repo has
// already paid for twice) the gate would be stricter than the display, and a
// reviewer would be shown a figure for a stage that should refuse it. One list,
// read by both.

import { roleAllowed } from '@procurement/roles';

/**
 * The stage whose whole purpose is confirming cost.
 *
 * MIGRATION 075: this is now `IN_FINANCE_REVIEW`, not `IN_COST_CENTER_APPROVAL`.
 *
 * The ladder used to route IN_PROCUREMENT_REVIEW -> IN_COST_CENTER_APPROVAL ->
 * IN_FINANCE_REVIEW, with the middle stage existing only for an approval act
 * that no control in the app could perform. The ruling is that the blind-review
 * confirmation by the requesting HOD IS the cost approval event, so the CS exit
 * now lands on IN_FINANCE_REVIEW directly and the middle stage is gone from the
 * ladder.
 *
 * The constant therefore MOVED with the ladder rather than keeping a name for a
 * stage nothing routes to any more. Finance review is now the stage that
 * settles the cost, and it is where the awarded figure first becomes showable —
 * one stage later than before, which is the visible consequence of removing the
 * intervening gate.
 */
export const COST_APPROVAL_STAGE = 'IN_FINANCE_REVIEW';

/**
 * The steps that cross the Cost approval boundary.
 *
 * MIGRATION 075 — the `cost_center` step no longer exists, so the boundary is
 * now crossed on ONE edge with THREE steps:
 *
 *   `cs_review`         IN_PROCUREMENT_REVIEW -> IN_FINANCE_REVIEW  (entering)
 *   `cs_review_quotes`  QUOTES_RECEIVED       -> IN_FINANCE_REVIEW  (entering)
 *   `procurement`       IN_PROCUREMENT_REVIEW -> IN_FINANCE_REVIEW  (entering)
 *
 * Previously this was an entering/leaving PAIR, which is why the gate had to be
 * enforced on both edges: checking only the leaving edge let an unpriced PR sit
 * in Finance before anyone noticed. There is no leaving edge any more — Finance
 * is where the money becomes knowable, and from Finance the ladder only ever
 * moves further from it.
 *
 * `touchesCostApproval` below is driven off the step's own `to`/`from`, not off
 * this list, so this list is documentation of WHICH steps are expected and the
 * gate keeps working on a re-pointed step.
 */
export const COST_APPROVAL_ENTRY_STEPS = [
  'cs_review',
  'cs_review_quotes',
  'procurement',
];

/**
 * Stages at which the awarded cost is a settled fact and may be shown.
 *
 * An award is recorded during sourcing, which happens BEFORE the CS exit, so
 * the data exists earlier than this list admits. That is intentional: the award
 * is not the confirmed cost until the requester has confirmed the comparative
 * statement and procurement has classified every line, and putting a
 * settled-looking money figure in front of procurement mid-RFQ invites the
 * number to be argued with rather than quoted against.
 *
 * MIGRATION 075: `IN_COST_CENTER_APPROVAL` is REMOVED from this list, not
 * retained. It is not a stage the ladder reaches any more, and leaving it here
 * would let a request that had been moved out of it keep advertising a live
 * award — a stage in the display vocabulary that the state machine cannot
 * produce is exactly the drift this file exists to prevent.
 */
export const COST_CONFIRMED_STAGES = [
  'IN_FINANCE_REVIEW',
  'IN_MANAGEMENT_REVIEW',
  'READY_FOR_D365',
  'D365_PUSHED',
  'CLOSED',
  'FULFILLED_FROM_STOCK',
];

/** Type-safe membership test. `readonly string[]` does not narrow a `string`. */
export const isCostConfirmedStage = (stage: string): boolean =>
  COST_CONFIRMED_STAGES.includes(stage);

/**
 * Does this step land the PR on, or take it off, the Cost approval boundary?
 *
 * Driven off the step's own `to`/`from` rather than a list of step keys where it
 * can be done, so a renamed step cannot silently stop being gated.
 */
export const touchesCostApproval = (step: { to?: string; from?: string }): boolean =>
  step.to === COST_APPROVAL_STAGE || step.from === COST_APPROVAL_STAGE;

/**
 * Is this step one of the two gates out of the FINANCE REVIEW stage?
 *
 *   IN_FINANCE_REVIEW -> READY_FOR_D365        the release (below the threshold)
 *   IN_FINANCE_REVIEW -> IN_MANAGEMENT_REVIEW  the management referral (above it)
 *
 * ASKED BY SHAPE, NOT BY KEY, and the reason is not stylistic.
 *
 * A frozen routing snapshot carries a key only some of the time:
 * `loadForPr` resolves an entry's key as `p.key ?? step_${i}`. 25 snapshots on
 * this estate carry no keys at all, so their two finance gates come back named
 * `step_9` and `step_10` while the live ladder names them `finance_release` and
 * `finance_review`. A key test would have passed on 1,345 requests and failed on
 * exactly the 25 whose snapshots are the oldest.
 *
 * The engine has never cared: `resolveNextStage` picks candidates by `from` and
 * by the step's CONDITION, and `from`/`to` are always present. This predicate
 * asks the same question the engine asked, so an authority check written here
 * and a route computed there cannot disagree.
 *
 * `when` is deliberately NOT part of the test. The two gates are told apart by
 * where they go, not by the condition that chooses between them: one request
 * matches at most one of them, and both are the finance desk's act.
 */
export const isFinanceGate = (step: { from?: string; to?: string }): boolean =>
  step.from === COST_APPROVAL_STAGE
  && (step.to === 'READY_FOR_D365' || step.to === 'IN_MANAGEMENT_REVIEW');

/**
 * MAY THIS DESK ACT A GATE OUT OF THE FINANCE REVIEW STAGE?
 *
 * The plain rule is the step's own `actorRole`, which is `finance` on both
 * gates — so finance passes by the ordinary path, and `admin` passes because
 * ROLE_ALIASES expands it to `finance`.
 *
 * On top of that, the 2026-10-23 ruling is that the release is NOT the
 * exclusive right of the `finance` desk: during UAT and operational sign-offs
 * a head of department may release it, and the CFO may too — it is already a
 * stage actor, and a stage actor that gets a 403 is a control that cannot be
 * used.
 *
 * `roleAllowed('hod', 'hod')` is true for ALL FIVE department heads, because
 * `hod` is the role string every head signs in as. That is the deliberate
 * breadth of the ruling, and the reason the allowance is scoped to the STAGE:
 * it opens the two gates out of IN_FINANCE_REVIEW and nothing else, so a head
 * gains no procurement, CS, MC or CFO approval by way of it.
 */
export const mayActFinanceGate = (
  role: string,
  step: { from?: string; to?: string },
): boolean =>
  isFinanceGate(step) && (roleAllowed(role, 'hod') || roleAllowed(role, 'cfo'));

/**
 * Who may CORRECT a classification after the fact.
 *
 * Finance and the CFO, and only once the request has reached cost approval.
 * A correction is a change to a decision somebody already took, so there has
 * to BE a decision to correct, and the request has to be far enough along that
 * the classification was already demanded of procurement. Before that point
 * the class belongs to procurement and nobody else may touch it.
 */
export const CORRECT_ROLES = 'finance,cfo,admin';

/**
 * MAY THIS DESK CORRECT A CLASSIFICATION, ON THE CARD?
 *
 * THIS IS THE CARD'S RULE, AND IT IS NOT THE PATCH ENDPOINT'S RULE.
 *
 * The two are deliberately different, and the difference is an earlier ruling
 * that still stands: the PATCH guard (`PrService.setLineClassifications`) is
 * WIDER than the card. So `mayCorrectClassification` CLOSES the window at
 * IN_FINANCE_REVIEW, while the endpoint still accepts a correction there.
 * Unifying them would be tightening a control gate, which is a separate
 * decision and not this one.
 *
 * WHY THE WINDOW IS CLOSED AT IN_FINANCE_REVIEW (ruling, 2026-10-23)
 * ------------------------------------------------------------------
 * The lines are classified at the CS exit, by procurement, and the request
 * arrives at Finance with every approved line already marked. What finance owns
 * at that stage is financial governance — ledger verification and budget
 * confirmation — and line-item data entry is not part of it. So the card is
 * READ-ONLY there, for every desk, and the "Save classification" button is
 * gone rather than merely disabled.
 *
 * Closed by STAGE, not by role: at IN_FINANCE_REVIEW no desk has a class to
 * write. Procurement's own authority over the class was exercised at the CS
 * exit, which is a different stage, and that window is untouched by this.
 */
export const mayCorrectClassification = (role: string, stage: string): boolean =>
  roleAllowed(role, CORRECT_ROLES)
  && isCostConfirmedStage(stage)
  && stage !== COST_APPROVAL_STAGE;

/**
 * The cost-approval gate's refusal, in one place.
 *
 * TWO doors enforce this gate. `PrService.advance()` refuses an ordinary
 * procurement advance, and `CsReviewService.confirm()` refuses a CS
 * confirmation — the second because that route writes the stage directly and
 * never goes through advance(), which is exactly how a gate with one door
 * standing open stops being a gate.
 *
 * They must therefore say the same thing, because they must also mean the
 * same thing. Two messages is two gates, and the quieter one is the one
 * people learn to work around.
 *
 * `unpricedLines` is the APPROVED lines with no price. A held line is not
 * being bought and never carries a vendor rate, so demanding one of it is a
 * constraint against a line that does not exist yet.
 */
export const costApprovalGateMessage = (
  prNumber: string,
  unpricedLines: number[],
  remedy: string,
): string =>
  `${prNumber} cannot cross the Cost approval boundary with an unknown amount. ` +
  (unpricedLines.length
    ? `No unit price is set on line${unpricedLines.length > 1 ? 's' : ''} ${unpricedLines.join(', ')}. `
    : '') +
  'The estimated amount is UNKNOWN rather than zero, so there is nothing for Cost ' +
  `approval to confirm against. ${remedy} ` +
  'A line priced at exactly 0 counts as an answer.';