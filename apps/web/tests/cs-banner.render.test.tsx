// The stage bar's sentence about the comparative statement.
//
// WHAT THIS GUARDS
// ----------------
// On PR-2026-202043 the CS review chain ran to completion — drafted, procurement
// review, blind requester review, CONFIRMED — and the PR screen still said:
//
//     "The comparative statement is yours to build and submit."
//
// That line was rendered from `status` and the viewer's ROLE and nothing else,
// so it was guaranteed to be wrong at exactly the moment the work was finished,
// on the same screen that carries the next action. The reviewer then had no
// reason to advance, and the request sat at `5. CS review · Confirmed` looking
// unfinished.
//
// The fix reads the STATEMENT. These tests pin both branches so the sentence can
// never again be unconditional.
//
// WHY A SOURCE ASSERTION RATHER THAN A RENDER ONE
// ----------------------------------------------
// `pr/[id].tsx` is a Next page that fetches its own data through hooks and a
// session context; it is not in the render-build program and cannot be required
// and called the way the card components are. The same reason `pr.costMoney`
// asserts on source. The rule under test is WHICH CONDITION selects the text,
// and that is legible in the source — asserting a rendered string here would be
// theatre.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

// Compiled tests run from `.render-build/tests/`, so __dirname is not the source
// tree. Walk up to whichever directory actually holds `pages/`.
function resolveWebRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    try {
      if (statSync(join(dir, 'pages')).isDirectory()) return dir;
    } catch { /* keep walking */ }
    dir = dirname(dir);
  }
  throw new Error('could not locate the apps/web root from ' + __dirname);
}

/**
 * Comments are stripped before any source assertion.
 *
 * These tests assert on the ABSENCE of a pattern and on the presence of another,
 * and the fix carries a long comment quoting the old sentence verbatim. Without
 * stripping, that prose would satisfy the presence check on its own.
 */
function readSource(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/.*$/gm, '$1');
}

const webRoot = resolveWebRoot();
const page = readSource(join(webRoot, 'pages', 'pr', '[id].tsx'));
const service = readFileSync(
  join(webRoot, '..', 'api', 'src', 'pr', 'pr.service.ts'), 'utf8',
);

// ── the banner ─────────────────────────────────────────────────────────────

test('B1 the bar reads the statement instead of asserting the work is undone', () => {
  // The branch must be driven by a CS fact. A literal next to the old sentence is
  // not a branch, and an unconditional render is the defect itself.
  assert.ok(/clsCsConfirmed\s*\?/.test(page),
    'the statement sentence must be selected by whether the review concluded');
});

test('B2 both sentences are still present — the fix adds a case, it does not mute the bar', () => {
  assert.ok(page.includes('The comparative statement is yours to build and submit.'),
    'an un-started statement must still say so');
  assert.ok(/Statement confirmed\./.test(page),
    'a concluded review must say so and point at the next action');
});

test('B3 the flag is read from the API, not invented in the browser', () => {
  assert.ok(/pr\.classification\?\.cs_confirmed/.test(page),
    'the branch must read the helper both detail endpoints already call');
});

// ── the helper that answers it ─────────────────────────────────────────────

test('B4 the helper reports a concluded review', () => {
  assert.ok(/cs_confirmed:\s*subState\s*===\s*'CONFIRMED'/.test(service),
    'CONFIRMED must be the claim, read from the row rather than inferred from stage');
});

test('B5 the review query no longer filters the terminal states away', () => {
  // The original query filtered to the OPEN states, which is right for the
  // window and structurally unable to answer "has one finished?" — it returned no
  // row at all for a confirmed review, which is indistinguishable from "no review
  // exists". The filter is now applied where it belongs, in the PATCH guard.
  //
  // Scoped to the helper rather than the file. The SAME `sub_state IN (...)` filter
  // exists a second time in `PATCH /pr/:id/lines/classification`, where it is
  // correct and load-bearing: that guard asks "is a review in flight right now?".
  // A file-wide assertion would have failed here and tempted somebody into
  // deleting a working guard.
  const helper = service.slice(
    service.indexOf('private async classificationAccess('),
    service.indexOf('async lightList('),
  );
  assert.ok(helper.length > 0, 'the classificationAccess helper must still exist');
  assert.ok(!helper.includes('sub_state IN'),
    'the helper must not filter terminal states out of its own result');
  assert.ok(helper.includes('ORDER BY cr.updated_at DESC NULLS LAST'),
    'the newest round must win, so a resumed round-2 review is not read as round 1');

  // And the PATCH guard keeps exactly the one copy that belongs to it.
  const filters = service.match(
    /sub_state IN \('DRAFT','PROC_REVIEW','REQUESTER_REVIEW'\)/g,
  ) || [];
  assert.equal(filters.length, 1,
    'the OPEN-state filter must survive exactly once — in the PATCH guard, not the helper');
});

test('B6 the window opens on the gated step PREDICATE, not on the stage alone', () => {
  // The prototype's rule (line 2076) is BOTH halves:
  //   if(s.requiresCapexOpex && _lightBranchMatches(s.when, pr, {})) return true;
  //
  // The live version tested only the first, which is how the card came up at
  // "Procurement review · RFQ not issued": the request was at a stage a gated
  // step leaves, so the card opened — even though that step's own condition
  // (csReviewConfirmed) was nowhere near satisfied, and the workflow had not
  // asked anybody for a classification at that point at all.
  const helper = service.slice(
    service.indexOf('private async classificationAccess('),
    service.indexOf('async lightList('),
  );
  assert.ok(helper.length > 0, 'the classificationAccess helper must still exist');

  // The condition belongs to the ENGINE. A second copy of the vocabulary in
  // the API would be a second answer to "does this step fire?", and the card
  // would drift from the advance-time gate that asks the same question.
  //
  // MIGRATION 075 — the window asks the ENGINE'S trigger question, not the
  // advance's. `evaluateTrigger` is still the engine: the same evaluator, the
  // same context, the same vocabulary. What differs is which question is put to
  // it — "is the classification the last thing standing?" rather than "has the
  // request already crossed?" — and that difference is the whole reason the card
  // can open at all while lines are still unclassified. Asked the advance's
  // question, the card would close exactly when there was work to do.
  assert.ok(/evaluateTrigger\(/.test(helper),
    "the gated step's trigger must be evaluated by the engine");
  assert.ok(/predicateContext\(/.test(helper),
    'the predicate must be given a context, not a hand-rolled boolean');

  // The verdict that satisfies `csReviewConfirmed` is the review row, read
  // once and used for both the banner's claim and the predicate's claim.
  assert.ok(/csReviewConfirmed:\s*subState === 'CONFIRMED'/.test(helper),
    "the review verdict must be what satisfies the csReviewConfirmed condition");

  // And the window is that predicate and nothing else. The stage-only
  // expression is the defect itself: it opened the card at a stage the
  // workflow had not asked for a classification at.
  assert.ok(!/Boolean\(gatedStep\)\s*\|\|/.test(helper),
    'the window must not be a stage check OR-ed with a review check');
  assert.ok(/const windowOpen = Boolean\(gatedStep\)/.test(helper),
    'the window must be exactly "a gated step whose condition is satisfied"');

  // The review-in-flight widening is gone with it: the class is made at the CS
  // exit, AFTER the blind review is confirmed — which is where the CS service
  // says the request waits ("the request stays at <stage> until Procurement
  // classifies every line").
  assert.ok(!/OPEN_REVIEW_STATES/.test(service),
    'the mid-review widening must be gone; the card opens at the CS exit');
});

test('B7 both detail endpoints still share the one helper', () => {
  // Two callers is the reason this was fixable in one place. If a route starts
  // answering the window itself again, the banner and the card can disagree.
  const calls = service.match(/classificationAccess\(/g) || [];
  assert.ok(calls.length >= 3, `expected the helper plus its two callers, saw ${calls.length}`);
  assert.ok(!/cs_confirmed:\s*true/.test(service),
    'cs_confirmed must be derived per request, never asserted as a constant');
});