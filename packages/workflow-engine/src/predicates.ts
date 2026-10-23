// Data-driven predicate evaluation.
//
// This module replaces the closure-based `Step.predicate` that the engine used
// to carry. A closure is a *compiled* condition: it cannot be stored in
// workflow.steps_config, cannot be edited by an admin, and cannot be rendered in
// a UI. Every threshold it captured (1_000_000) was baked into the function body
// while ALSO being declared as `conditionValue` on the step — so the declared
// field was decorative and editing it would have changed nothing.
//
// Here a step's condition is *data*: a keyword from PREDICATE_VOCABULARY plus an
// optional numeric `conditionValue`. The evaluator is the single place that
// reads `conditionValue`, so changing the number in the database changes
// routing. This is what makes the Part 7 grid a real control panel.

import type { PrSnapshot, Decision, Step } from './types';

/**
 * The complete, closed predicate vocabulary an admin may choose from.
 *
 * This list is the contract the Part 7 "Condition" dropdown renders, and
 * `validateStepConfig` rejects any `when` outside it. Closed on purpose: an
 * admin cannot invent arbitrary logic, they can only pick from rules the engine
 * can actually evaluate. An unknown keyword is a validation error at save time,
 * never a silent route to the fallback.
 */
export const PREDICATE_VOCABULARY = [
  'always',
  'wantWarehouse',
  'inStock',
  'outOfStock',
  'lineRejected',
  'lineHeld',
  'reworkRequested',
  // Procurement sending a PR back to the HOD. Distinct from `reworkRequested`:
  // that one routes the REQUESTER back to PROCUREMENT, this one routes
  // PROCUREMENT back to the HOD. They are opposite directions of the same idea
  // and must not share a keyword.
  'revertToHod',
  'reassign',
  'mgtRejected',
  // CS sub-workflow (migration 065). True only when the advance carries the
  // `csReviewConfirmed` decision flag — i.e. when someone confirmed a
  // comparative statement through the review chain, not when procurement
  // clicked an ordinary "approve".
  //
  // Added to the vocabulary rather than reusing an existing keyword because the
  // step it gates must be reachable from EXACTLY one action. An unrecognised
  // keyword would have been coerced to 'always' by evaluatePredicate below and
  // would then match on every advance out of IN_PROCUREMENT_REVIEW, hijacking
  // the `procurement` step that legitimately owns that stage. It also would not
  // have been accepted by validateStepConfig at all.
  'csReviewConfirmed',
  // Migration 075. The Capex/Opex half of the CS exit, as a FACT rather than a
  // flag.
  //
  // It is deliberately NOT a Decision field. Every other decision-flag keyword
  // reads what the approver just clicked; this one reads what is recorded on the
  // PR's own lines, because "has procurement classified this?" is a question
  // about the database and not about the request. A caller that could post
  // `capexOpexClassified: true` would be able to skip the control the keyword
  // exists to enforce — the definition of a gate that is decorative.
  //
  // Same population as the API's `unclassifiedApprovedLines`: approved, not
  // rejected, not held. A held or rejected line is not being bought and carries
  // no class, so counting it would hold a request hostage to a line nobody is
  // purchasing.
  'capexOpexClassified',
  // The CS EXIT, as one condition. The review is confirmed AND every line being
  // bought carries a class — then the request goes to Finance, which is the
  // desk that reviews budget and the GL/Capex-Opex mapping.
  //
  // WHY ONE KEYWORD AND NOT "csReviewConfirmed AND capexOpexClassified"
  // ---------------------------------------------------------------------
  // `evaluatePredicate` switches on a single keyword, and an unrecognised string
  // is coerced to 'always' at the top of this function. Writing the conjunction
  // as a literal would therefore have made the step match on EVERY advance out
  // of its stage — silently taking that stage away from the step below it. That
  // is not hypothetical: it is exactly how `readyForCs` and `csReviewConfirmed`
  // both went inert before they were added to this vocabulary.
  //
  // One keyword, one evaluator branch, one admin-selectable condition. The
  // conjunction lives in code where it can be read and tested, instead of being
  // spelled as a string that the engine would silently misread.
  'csExitComplete',
  // The "Ready for CS" hand-off (migration 064). Same reasoning as
  // `csReviewConfirmed` above, and for the same reason: the step was seeded
  // with a keyword this vocabulary did not contain, and evaluatePredicate()
  // coerces an unrecognised keyword to 'always'. The step was inert only
  // because its order_index sat BELOW the `procurement` step that owns the
  // same stage — the first step whose condition matches wins, so an 'always'
  // step placed after `procurement` never fires. It was correct by accident,
  // and the accident ended the moment the CS steps were moved up to the
  // positions the 10-step ladder gives them.
  //
  // Adding it to the vocabulary is what makes the step honest: the condition
  // it declares is now the condition the engine evaluates, and it fails
  // CLOSED — absent the flag it does not match.
  'readyForCs',
  'aboveMgtThreshold',
  'belowMgtThreshold',
  'amountGT',
  'amountGTE',
  'amountLT',
  'amountLTE',
  'amountEQ',
] as const;

export type PredicateKeyword = (typeof PREDICATE_VOCABULARY)[number];

/**
 * Predicates that consume `Step.conditionValue` as a number. Used by the admin
 * API to decide whether to render a threshold input, and by validation to
 * require the value be present and non-negative.
 */
export const AMOUNT_PREDICATES: readonly PredicateKeyword[] = [
  'amountGT',
  'amountGTE',
  'amountLT',
  'amountLTE',
  'amountEQ',
];

/** Predicates that consume the GLOBAL management threshold, not conditionValue. */
export const MGMT_THRESHOLD_PREDICATES: readonly PredicateKeyword[] = [
  'aboveMgtThreshold',
  'belowMgtThreshold',
];

export function isPredicateKeyword(value: unknown): value is PredicateKeyword {
  return (
    typeof value === 'string' &&
    (PREDICATE_VOCABULARY as readonly string[]).includes(value)
  );
}

export function isAmountPredicate(value: unknown): boolean {
  return isPredicateKeyword(value) && AMOUNT_PREDICATES.includes(value);
}

/** Everything a predicate is allowed to observe. Nothing else is in scope. */
export type PredicateContext = {
  pr: PrSnapshot | null;
  decision: Decision | null;
  /** Live, admin-editable management threshold. Never a module constant. */
  managementThreshold: number;
  /**
   * "Treat the classification requirement as already satisfied."
   *
   * SET BY `evaluateTrigger` AND BY NOTHING ELSE. It exists because a step whose
   * condition includes `capexOpexClassified` poses a question that has two
   * different right answers, and the card must ask the second one.
   *
   * The step fires when the review is closed AND every line is classified. The
   * CARD asks a different question: "is the classification the last thing
   * standing between this request and the next stage?" — which is the question
   * that decides whether to OFFER the card at all.
   *
   * Asked the first way, the card could never open: the window would be closed
   * exactly when there was work to do, because the work is what closes it. A
   * request with an unclassified line has `capexOpexClassified` false, so
   * `csExitComplete` is false, so no gated step matches, so the card is closed,
   * so the line is never classified, so the request never advances. A deadlock
   * with a very polite symptom.
   *
   * So the trigger question is asked with the classification requirement
   * satisfied, and the REAL requirement is still enforced — by the same
   * evaluator, in the same place, on the advance. One rule, two questions, both
   * answered by this file.
   */
  classificationSatisfied?: boolean;
};

/**
 * Build a context from loose input, normalising the two ways a flag can arrive.
 *
 * Decision flags are read from BOTH the per-call `decision` (what the current
 * approver just clicked) and the persistent PR-side field (so a re-route still
 * works on a later advance, when the original decision object is long gone).
 * The OR is what the closures did; preserving it is why warehouse re-routes and
 * stock decisions keep working after the approving turn ends.
 */
export function predicateContext(
  pr: PrSnapshot | null | undefined,
  decision?: Decision | null,
  managementThreshold = 0,
): PredicateContext {
  return {
    pr: pr ?? null,
    decision: decision ?? null,
    managementThreshold,
  };
}

/**
 * Tri-state read of a decision flag: `true`, `false`, or `undefined` when the
 * approver never sent the field at all.
 *
 * The distinction is load-bearing. `inStock: false` is an active claim ("not in
 * stock") and must route the PR onward; an absent `inStock` is silence and must
 * not. Collapsing both to `false` would make every advance without a stock
 * answer jump to the out-of-stock step.
 */
function explicitFlag(
  ctx: PredicateContext,
  name: keyof Decision,
): boolean | undefined {
  const d = ctx.decision;
  if (d && typeof d[name] === 'boolean') return d[name] as boolean;
  // A handful of flags are also carried on the PR itself so that they survive
  // across advances without re-derivation.
  const pr = ctx.pr as (PrSnapshot & Record<string, unknown>) | null;
  if (pr && typeof pr[name] === 'boolean') return pr[name] as boolean;
  return undefined;
}

/** Boolean convenience form: absent reads as false. */
function flag(ctx: PredicateContext, name: keyof Decision): boolean {
  return explicitFlag(ctx, name) === true;
}

/**
 * The PR's monetary amount, and whether it is actually known.
 *
 * A requisition can be raised before anyone knows the price — the cost arrives
 * with the RFQ quotes. That is recorded as `estimatedAmount: null` /
 * `amountStatus: 'UNKNOWN'`, NOT as 0, precisely so the two are distinguishable.
 *
 * It has to be distinguishable here. `amountOf()` used to collapse an unknown
 * amount to 0, and every amount comparison in the workflow is a threshold test,
 * so an unpriced request read as cheaper than every threshold: a laptop request
 * with no price yet satisfied `belowMgtThreshold` and walked straight past the
 * management gate. Not knowing a number is not evidence of a small one.
 */
function amountOf(pr: PrSnapshot | null): number {
  const n = Number(pr?.estimatedAmount ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * True when the PR has no usable amount yet.
 *
 * `estimatedAmount` null/undefined, or a non-finite value. An explicit 0 is
 * NOT unknown: a requester can genuinely mean "free" (an internal transfer, a
 * loan), and treating that as unknown would send it to a cost-confirmation step
 * forever. The database agrees: it stores 0 with amount_status = 'ESTIMATED'
 * unless the requester said they had no price.
 */
function amountUnknown(pr: PrSnapshot | null): boolean {
  if (!pr) return true;
  if (pr.amountStatus === 'UNKNOWN') return true;
  const raw = pr.estimatedAmount;
  return raw === null || raw === undefined || !Number.isFinite(Number(raw));
}

function thresholdOf(step: Step, ctx: PredicateContext): number {
  const n = Number(step.conditionValue ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Evaluate a step's condition.
 *
 * `when` defaults to 'always' when absent, which preserves the engine's
 * historical behaviour for steps that declared no predicate at all (procurement,
 * cost_center, management, d365_push) — those were unconditional.
 *
 * A step with NO matching PR (`pr === null`) only passes 'always'. Every other
 * keyword is a statement about a concrete request, so with no request there is
 * nothing to assert true. This is stricter than the old
 * `predicate: (pr) => !!pr && ...` and is deliberate: it prevents a
 * side-channel step from firing on a null PR.
 */
/**
 * WOULD THIS STEP FIRE, IF THE CLASSIFICATION IT DEMANDS HAD BEEN MADE?
 *
 * The card's question, as opposed to the advance's.
 *
 * A step whose condition includes `capexOpexClassified` poses two questions at
 * once, and they have different right answers:
 *
 *   the ADVANCE asks  "has the review been closed AND is every line
 *                      classified?"  — the real question, answered from the
 *                      recorded lines. Both halves must hold or the step does
 *                      not fire.
 *
 *   the CARD asks     "is the classification the last thing standing between
 *                      this request and the next stage?" — answered with the
 *                      classification requirement treated as satisfied, and
 *                      every OTHER part of the condition evaluated for real.
 *
 * Asking the card the advance's question deadlocks the flow: the window would
 * close exactly when there was work to do, because doing that work is what
 * opens it. A request with an unclassified line fails `capexOpexClassified`,
 * so `csExitComplete` is false, so no gated step matches, so the card is
 * closed, so the line is never classified, so the request never advances.
 *
 * Asking the advance the card's question would be worse: the classification
 * control would be a decoration. So the two questions are asked separately,
 * by two functions, and BOTH live here — where the rule is — rather than in a
 * service file that re-implements it.
 *
 * Nothing else in the engine calls this. `evaluatePredicate` is what the
 * advance uses, and it is untouched by this.
 */
export function evaluateTrigger(
  when: string | null | undefined,
  step: Step,
  ctx: PredicateContext,
): boolean {
  return evaluatePredicate(when, step, { ...ctx, classificationSatisfied: true });
}

export function evaluatePredicate(
  when: string | null | undefined,
  step: Step,
  ctx: PredicateContext,
): boolean {
  const keyword = isPredicateKeyword(when) ? when : 'always';
  const pr = ctx.pr;

  switch (keyword) {
    case 'always':
      return true;

    // Decision-flag keywords.
    case 'wantWarehouse':
      // Fires when the PR was already flagged for a warehouse check OR the
      // current approver is asking for one. Both must be honoured.
      return !!(pr && pr.warehouseCheckRequired) || flag(ctx, 'wantWarehouse');
    case 'inStock':
      return explicitFlag(ctx, 'inStock') === true;
    case 'outOfStock':
      // "Not in stock" and "out of stock" are the same signal from an approver's
      // point of view: a vendor returning `inStock: false` must route the same
      // way as one returning `outOfStock: true`. An ABSENT `inStock` is silence
      // and routes nowhere.
      return explicitFlag(ctx, 'outOfStock') === true || explicitFlag(ctx, 'inStock') === false;
    case 'lineRejected':
      return flag(ctx, 'lineRejected');
    case 'lineHeld':
      return flag(ctx, 'lineHeld');
    case 'reworkRequested':
      return flag(ctx, 'rework') || flag(ctx, 'reworkRequested');
    case 'revertToHod':
      return flag(ctx, 'revertToHod');
    case 'reassign':
      return flag(ctx, 'reassign');
    case 'mgtRejected':
      return flag(ctx, 'mgtRejected');
    case 'csReviewConfirmed':
      // Explicitly, and NOT via `flag()`. An unrecognised keyword silently
      // becomes 'always' at the top of this function, so this branch is what
      // stops the cs_review step from firing on every procurement advance. It
      // must stay a strict `=== true` check.
      return flag(ctx, 'csReviewConfirmed');
    case 'readyForCs':
      // The forward to the comparative statement. Strictly `=== true`.
      //
      // This step used to declare a keyword the vocabulary did not contain,
      // so evaluatePredicate coerced it to 'always' and the step would have
      // matched EVERY advance out of IN_PROCUREMENT_REVIEW — taking the
      // `procurement` step's stage away from it. It was harmless only while
      // its order_index sat after `procurement`. Now that the CS steps carry
      // their real positions in the ladder, the condition has to be the one it
      // claims to be.
      return flag(ctx, 'readyForCs');

    // The CS EXIT and its two halves. See PREDICATE_VOCABULARY for why these
    // are two keywords and a conjunction rather than one string.
    case 'capexOpexClassified':
      // `evaluateTrigger` — the CARD's question — asks whether the
      // classification is the last thing standing, and the context says it is
      // satisfied. The advance's question is the real one, and it is answered
      // from the lines below.
      if (ctx.classificationSatisfied) return true;
      // Read from the PR's LINES. Fails CLOSED in three distinct ways, all of
      // which matter:
      //   no PR at all          -> false (nothing to assert about)
      //   no lines at all       -> false (nothing was bought, so nothing can
      //                             be said to be classified; the vacuous
      //                             truth here would open the gate on an
      //                             empty request)
      //   one unclassified line -> false
      //
      // `null` and an absent key are the same answer on purpose. A snapshot
      // built before this field existed carries nothing, and treating that as
      // "classified" would open the gate on every PR created before the
      // migration.
      //
      // THE POPULATION IS THE API'S, CHARACTER FOR CHARACTER:
      //   `pl.approved AND NOT pl.rejected AND NOT pl.held AND classification IS NULL`
      // Both halves of that — the three flags and the null test — are copied
      // rather than paraphrased. `unclassifiedApprovedLines` in
      // sourcing/award.sync.ts raises the refusal that NAMES the offending
      // lines, and this decides whether the step fires; if the two disagreed
      // about which lines are in scope, the screen could show a request as
      // fully classified while the gate still held it, or the reverse. Two
      // readings of one rule is how that happens.
      if (!pr || !Array.isArray(pr.lines) || pr.lines.length === 0) return false;
      return !pr.lines.some(
        (l) => Boolean(l.approved) && !l.rejected && !l.held && !l.classification,
      );
    case 'csExitComplete':
      // AND, and both halves must be true on their own terms. `csReviewConfirmed`
      // is the ACT (somebody closed the blind review); `capexOpexClassified` is
      // the STATE (every line being bought has a class). Neither implies the
      // other — the review can be confirmed with lines still blank, and lines
      // can all be classified while the review is still open — which is why this
      // is a conjunction and not one of the two under a different name.
      return flag(ctx, 'csReviewConfirmed') && evaluatePredicate(
        'capexOpexClassified',
        step,
        ctx,
      );

    // Global management threshold.
    //
    // An unknown amount is treated as ABOVE the threshold, never below. The
    // gates that use these keywords exist to catch expensive requests; a
    // request whose price nobody has established yet is exactly the one you
    // cannot rule out as expensive, so it routes to review. `belowMgtThreshold`
    // would otherwise be satisfied by 0, which is how an unpriced capital
    // request skipped management entirely.
    case 'aboveMgtThreshold':
      return !!pr && (amountUnknown(pr) || amountOf(pr) > ctx.managementThreshold);
    case 'belowMgtThreshold':
      return !!pr && !amountUnknown(pr) && amountOf(pr) <= ctx.managementThreshold;

    // Per-step amount comparison — the values that were previously welded shut.
    //
    // Same rule: no known amount means no amount comparison can be trusted, so
    // every "at least this much" form stays closed and the "at most" forms
    // stay open for a cost-confirmation step to resolve. amountEQ is simply
    // false — nothing is known to equal anything.
    case 'amountGT':
      return !!pr && (amountUnknown(pr) || amountOf(pr) > thresholdOf(step, ctx));
    case 'amountGTE':
      return !!pr && (amountUnknown(pr) || amountOf(pr) >= thresholdOf(step, ctx));
    case 'amountLT':
      return !!pr && !amountUnknown(pr) && amountOf(pr) < thresholdOf(step, ctx);
    case 'amountLTE':
      return !!pr && !amountUnknown(pr) && amountOf(pr) <= thresholdOf(step, ctx);
    case 'amountEQ':
      return !!pr && !amountUnknown(pr) && amountOf(pr) === thresholdOf(step, ctx);

    default:
      // Unreachable: callers validate before this point. Fail closed rather
      // than open — an unknown condition must not open a routing path.
      return false;
  }
}

/**
 * Human-readable rendering of a step's condition, for the Part 7 grid's
 * Condition column and for audit records. Kept beside the evaluator so the text
 * can never drift from the behaviour it describes.
 */
export function describePredicate(
  when: string | null | undefined,
  step: Step,
  managementThreshold?: number,
): string {
  const keyword = isPredicateKeyword(when) ? when : 'always';
  if (isAmountPredicate(keyword)) {
    const v = step.conditionValue;
    return v === undefined || v === null
      ? keyword
      : `${keyword} ${Number(v).toLocaleString('en-PK')}`;
  }
  if (MGMT_THRESHOLD_PREDICATES.includes(keyword)) {
    return managementThreshold === undefined
      ? keyword
      : `${keyword} ${Number(managementThreshold).toLocaleString('en-PK')}`;
  }
  return keyword;
}
