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
  'reassign',
  'mgtRejected',
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
    case 'reassign':
      return flag(ctx, 'reassign');
    case 'mgtRejected':
      return flag(ctx, 'mgtRejected');

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
