// cs.stages.ts — where a Comparative Statement may exist in the workflow.
//
// THIS IS ITS OWN FILE FOR A REASON, and the reason is an import cycle.
//
// `cs.service.ts` imports `CsReviewService` from `cs.review.service.ts`. When
// the review chain needed the same stage list that generate() and lock() use,
// importing CS_DRAFT_STAGES back out of `cs.service.ts` closed the loop
// A -> B -> A. Under CommonJS that resolves to a partially-initialised module
// and `CS_DRAFT_STAGES` arrives as `undefined` at load time — so
// `CS_DRAFT_STAGES.includes(...)` throws a TypeError on the first confirm,
// which looks exactly like the stage-mismatch bug this file was written to fix.
// The cycle would have been intermittent and deeply confusing.
//
// The stage rules are shared policy, not a property of either service, so they
// live here and both services read them from one direction.
//
// THE RULE ITSELF — both stages are real and both are load-bearing:
//   IN_PROCUREMENT_REVIEW — procurement owns the competition.
//   QUOTES_RECEIVED       — the "Ready for CS" hand-off (migration 064) parks
//                           the PR here, and the CS is GENERATED after that
//                           hand-off, not before it.
//
// Restricting any of these to procurement review alone would refuse the normal
// flow, which is why the set is stated rather than inferred.

/**
 * The stages a Comparative Statement may be built at, reviewed at, and locked at.
 *
 * Confirmation must never be stricter than generation: if a statement can be
 * generated and reviewed at QUOTES_RECEIVED but only confirmed at
 * IN_PROCUREMENT_REVIEW, then every request that took the Ready-for-CS hand-off
 * — most of them — reaches a blind review it can never finish.
 */
export const CS_DRAFT_STAGES = ['IN_PROCUREMENT_REVIEW', 'QUOTES_RECEIVED'];

/** Type-safe membership test. `readonly string[]` does not narrow a `string`. */
export const isCsDraftStage = (stage: string): boolean => CS_DRAFT_STAGES.includes(stage);
