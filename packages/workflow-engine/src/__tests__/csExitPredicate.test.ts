// The CS EXIT, as two predicates and the conjunction between them.
//
//   npm run test:engine
//
// WHAT IS ACTUALLY BEING PINNED
// -----------------------------
// Migration 075 replaced the cost-approval stage with a single crossing:
// the blind-review confirmation AND a fully classified request go straight to
// IN_FINANCE_REVIEW. The condition that decides it is `csExitComplete`, whose
// two halves are `csReviewConfirmed` (an ACT — somebody closed the review) and
// `capexOpexClassified` (a STATE — every line being bought has a class).
//
// Both halves are load-bearing and they are independent, which is the whole
// reason this is a conjunction:
//   * the review can be confirmed while lines are still blank;
//   * lines can all be classified while the review is still open.
// Either one alone must refuse to cross.
//
// THE TEST THAT MATTERS MOST IS THE THIRD ONE DOWN
// ------------------------------------------------
// `capexOpexClassified` reads the PR's LINES, not the advance payload. That is
// the difference between a gate and a suggestion, and it is only observable if
// somebody actually posts the flag and watches it be ignored. `flag()` prefers
// the decision payload over the PR, so the test below asserts that when BOTH
// are present and disagree, the recorded fact wins — i.e. posting
// `capexOpexClassified: true` on a request with an unclassified approved line
// does not open the gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePredicate, evaluateTrigger, isPredicateKeyword, predicateContext } from '../predicates';
import type { Decision, PrSnapshot, Step } from '../types';

const STEP: Step = {
  key: 'cs_review_quotes',
  from: 'QUOTES_RECEIVED',
  to: 'IN_FINANCE_REVIEW',
  order: 7,
  actorRole: 'procurement',
  when: 'csExitComplete',
  name: 'CS exit (quotes received)',
};

/** Two approved, both classified. The state in which the gate is satisfied. */
function classifiedPr(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    id: 'pr-1',
    prNumber: 'PR-2026-10000',
    status: 'QUOTES_RECEIVED',
    estimatedAmount: 380,
    expenseType: 'CAPEX',
    lines: [
      { lineNo: 1, itemCategory: 'OTHER', approved: true, rejected: false, held: false, classification: 'CAPEX_ASSET', amount: 200 },
      { lineNo: 2, itemCategory: 'OTHER', approved: true, rejected: false, held: false, classification: 'CAPEX_ASSET', amount: 180 },
    ],
    warehouseCheckRequired: false,
    warehouseManagerId: null,
    warehouseDecision: null,
    ...overrides,
  };
}

/** Run one keyword through the real context builder, not a hand-rolled object. */
function check(when: string, pr: PrSnapshot | null, decision: Decision = {}): boolean {
  return evaluatePredicate(when, STEP, predicateContext(pr, decision));
}

const reviewConfirmed: Decision = { csReviewConfirmed: true };

// ── vocabulary ──────────────────────────────────────────────────────────────

test('both keywords are in the vocabulary, or evaluatePredicate would coerce them to always', () => {
  // The failure this guards is silent and catastrophic: an unrecognised `when`
  // becomes `always`, so the CS step would match EVERY advance out of
  // QUOTES_RECEIVED and take that stage away from every step below it. It is
  // exactly how `readyForCs` and `csReviewConfirmed` each went inert once
  // already.
  assert.equal(isPredicateKeyword('capexOpexClassified'), true);
  assert.equal(isPredicateKeyword('csExitComplete'), true);
});

// ── capexOpexClassified: the STATE half ─────────────────────────────────────

test('fully classified approved lines satisfy the gate', () => {
  assert.equal(check('capexOpexClassified', classifiedPr()), true);
});

test('one unclassified approved line blocks it', () => {
  const pr = classifiedPr();
  pr.lines[1].classification = null;
  assert.equal(check('capexOpexClassified', pr), false);
});

test('an ABSENT classification is unclassified — silence is not an answer', () => {
  // A snapshot frozen before the field existed carries nothing at all. Reading
  // that as "classified" would open the gate on every request created before
  // the migration, which is the population least likely to have been checked.
  const pr = classifiedPr();
  delete (pr.lines[1] as { classification?: string | null }).classification;
  assert.equal(check('capexOpexClassified', pr), false);
});

test('a line that is not being bought carries no class and must not block', () => {
  // Same population the API's `unclassifiedApprovedLines` reads: approved, not
  // rejected, not held. Demanding a class on a held or rejected line is a
  // constraint against a line nobody is buying, and if the predicate disagreed
  // with that SQL the screen could show a request as classified while the gate
  // still held it.
  for (const flag of [{ held: true }, { rejected: true }]) {
    const pr = classifiedPr();
    Object.assign(pr.lines[1], flag, { classification: null });
    assert.equal(
      check('capexOpexClassified', pr),
      true,
      `a ${Object.keys(flag)[0]} line is not being bought and must not hold the gate`,
    );
  }
  // …and the flip side: a line still pending approval is also out of scope.
  const pending = classifiedPr();
  Object.assign(pending.lines[1], { approved: false, classification: null });
  assert.equal(check('capexOpexClassified', pending), true);
});

test('an empty or absent line list fails CLOSED', () => {
  assert.equal(check('capexOpexClassified', classifiedPr({ lines: [] })), false);
  // Vacuous truth — "every line is classified" over no lines — would open the
  // gate on an empty request.
  assert.equal(check('capexOpexClassified', null), false);
});

test('POSTING the flag does not open a gate the lines have not opened', () => {
  // The whole reason this is not a decision flag. `flag()` prefers the payload,
  // so a keyword implemented that way would be satisfied by the caller's own
  // assertion; the recorded fact has to win.
  const pr = classifiedPr();
  pr.lines[0].classification = null;
  const lied = { csReviewConfirmed: true, capexOpexClassified: true } as unknown as Decision;
  assert.equal(
    check('capexOpexClassified', pr, lied),
    false,
    'an unclassified approved line must refuse even when the caller posts the flag',
  );
  // …while the other half of the same lie still counts, because confirming a
  // review is an act the actor performs and nobody else can assert.
  assert.equal(check('csReviewConfirmed', pr, lied), true);
});

// ── csExitComplete: the ACT and the STATE together ──────────────────────────

test('the CS exit needs BOTH halves', () => {
  assert.equal(
    check('csExitComplete', classifiedPr(), reviewConfirmed),
    true,
    'review confirmed and every line classified is the crossing',
  );
});

test('the CS exit refuses on the act alone', () => {
  // The realistic failure: the HOD confirms the review, and procurement opens
  // the card to classify — but has not finished. A step that fired here would
  // walk the classification control entirely.
  const pr = classifiedPr();
  pr.lines[0].classification = null;
  assert.equal(check('csExitComplete', pr, reviewConfirmed), false);
});

test('the CS exit refuses on the state alone', () => {
  // Equally realistic: procurement classifies early, before the HOD has closed
  // the review. The blind review is the control; classifications cannot stand
  // in for it.
  assert.equal(check('csExitComplete', classifiedPr()), false);
});

test('the CS exit refuses with no PR and with no lines at all', () => {
  assert.equal(check('csExitComplete', null, reviewConfirmed), false);
  assert.equal(check('csExitComplete', classifiedPr({ lines: [] }), reviewConfirmed), false);
});

test('a csReviewConfirmed of anything other than true is not a confirmation', () => {
  // The strict reading. `csReviewConfirmed: "false"` from a form that serialises
  // booleans as strings would otherwise be truthy and cross the gate.
  for (const v of ['false', 'no', 0, null, undefined]) {
    assert.equal(
      check('csExitComplete', classifiedPr(), { csReviewConfirmed: v } as unknown as Decision),
      false,
      `csReviewConfirmed: ${JSON.stringify(v)} is not a confirmation`,
    );
  }
});

// ── the CARD's question: evaluateTrigger ────────────────────────────────────

test('the trigger says yes while the classification is still outstanding', () => {
  // THE DEADLOCK THIS EXISTS TO PREVENT.
  //
  // The card asks "is the classification the last thing standing between this
  // request and the next stage?" If it asked the advance's question instead, the
  // window would close exactly when there was work to do — because doing the
  // work is what opens it. The card would never appear, the lines would never
  // be classified, and the request would never advance, with no error anywhere.
  const pr = classifiedPr();
  pr.lines[0].classification = null;

  assert.equal(
    evaluateTrigger('csExitComplete', STEP, predicateContext(pr, reviewConfirmed)),
    true,
    'the card must open while the classification is still outstanding',
  );
  // The advance, meanwhile, still refuses. The requirement is not weakened; it
  // is asked of a different question.
  assert.equal(
    evaluatePredicate('csExitComplete', STEP, predicateContext(pr, reviewConfirmed)),
    false,
    'the advance must still refuse while a line is unclassified',
  );
});

test('the trigger still refuses when the OTHER half is missing', () => {
  // Treating the classification as satisfied must not make the step fire on the
  // strength of the classification alone. The review is still required.
  const pr = classifiedPr();
  pr.lines[0].classification = null;
  assert.equal(
    evaluateTrigger('csExitComplete', STEP, predicateContext(pr, {})),
    false,
    'an unclosed review is still an unclosed review, whatever the lines say',
  );
});

test('the trigger opens the card even with no line list at all', () => {
  // The card's context does not carry the lines — it asks the trigger question,
  // and the trigger question does not need them. An empty list must not read as
  // "unclassified", because the card would then never open for a request whose
  // lines the context happens not to carry.
  assert.equal(
    evaluateTrigger('csExitComplete', STEP, predicateContext(classifiedPr({ lines: [] }), reviewConfirmed)),
    true,
  );
});