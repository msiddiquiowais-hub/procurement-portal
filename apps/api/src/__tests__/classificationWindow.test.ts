/**
 * The Capex/Opex classification WINDOW: when the card is offered at all.
 *
 *   npm run test:api
 *
 * WHAT THIS GUARDS
 * ----------------
 * The card used to be offered because the request happened to be SITTING at a
 * stage that some step leaves:
 *
 *     const gatedStep = routing.steps.find(
 *       (s) => s.requiresCapexOpex && (s.from === status || s.from === '*'),
 *     );
 *     const windowOpen = Boolean(gatedStep) || (a review is in flight);
 *
 * That is a question about the STAGE. It opened the card at "Procurement
 * review · RFQ not issued" — a request nobody had asked anybody to classify,
 * on a desk that could not act on it, one stage before the work existed.
 *
 * The prototype's own rule is BOTH halves (line 2076):
 *
 *     if(s.requiresCapexOpex && _lightBranchMatches(s.when, pr, {})) return true;
 *
 * The second half is the step's own condition. The two steps that demand a
 * class are the CS exit — cs_review and cs_review_quotes — and both are
 * conditioned on `csReviewConfirmed`. So the card belongs at the CS exit:
 * after the blind review is CONFIRMED, while the request is still held in
 * sourcing. Which is exactly where the CS service says it waits — "the
 * request stays at <stage> until Procurement classifies every line and
 * advances it."
 *
 * WHY THE LADDER IS READ FROM THE DATABASE
 * ----------------------------------------
 * The rule is only as good as the table it is read from. If the `procurement`
 * step were ticked again, the stage-only question would open the card at
 * "RFQ not issued" again, and no amount of correct code in the helper would
 * stop it. So these tests assert the ladder's shape as well as the rule, and
 * the ladder is read through the SAME loader production uses.
 *
 * Anything needing a live database is skipped rather than silently passing
 * when the database is not reachable.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  evaluatePredicate,
  evaluateTrigger,
  predicateContext,
  stepsFromConfigRows,
  type PrSnapshot,
  type Step,
} from '@procurement/workflow-engine';

const CONTAINER = process.env.PP_DB_CONTAINER ?? 'procurement-portal-db';
const USER = process.env.PP_DB_USER ?? 'proc';
const DB = process.env.PP_DB_NAME ?? 'procurementDB';
const MGMT_THRESHOLD = 1_000_000;

function sql(q: string): string {
  return execFileSync(
    'docker',
    ['exec', CONTAINER, 'psql', '-U', USER, '-d', DB, '-X', '-t', '-A', '-c', q],
    { encoding: 'utf8', timeout: 30_000 },
  ).trim();
}

function dbAvailable(): boolean {
  try {
    sql('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * The live routing table, through the loader the repository uses.
 *
 * `stepsFromConfigRows` re-stamps each step's `order` from its array
 * position, so this is the engine's priority list, not the raw rows.
 */
function loadLadder(): Step[] {
  const raw = sql(
    "SELECT id, order_index, payload::text FROM workflow.steps_config ORDER BY order_index",
  );
  const rows = raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [id, orderIndex, ...rest] = line.split('|');
      return {
        id,
        payload: JSON.parse(rest.join('|')),
        order_index: Number(orderIndex),
      };
    });
  return stepsFromConfigRows(rows);
}

/** A request that knows its amount and nothing else. */
const PR: PrSnapshot = {
  id: '00000000-0000-0000-0000-000000000000',
  prNumber: 'PR-0000-000000',
  status: 'IN_PROCUREMENT_REVIEW',
  estimatedAmount: 135,
  amountStatus: 'ESTIMATED',
  expenseType: 'OPEX',
  lines: [],
};

/**
 * THE RULE, encoded.
 *
 * The prototype's line 2076, plus the stage scoping the live ladder needs: a
 * step that demands a classification opens the window only when its own
 * condition is satisfied AND it is reachable from where the request is.
 *
 * MIGRATION 075 — `evaluateTrigger`, NOT `evaluatePredicate`.
 *
 * The step's condition now includes the classification requirement itself
 * (`csExitComplete` = the review closed AND every line classified). The card
 * asks a DIFFERENT question from the advance:
 *
 *   the advance asks  "has the request actually crossed?"   -> evaluatePredicate
 *   the card asks     "is the classification the last thing
 *                      standing between this and the next stage?" -> evaluateTrigger
 *
 * Asked the advance's way, the card could never open: the window would close
 * exactly when there was work to do, because doing the work is what opens it.
 * The line is never classified, so the window stays closed, so the line is
 * never classified. A deadlock with a very polite symptom.
 *
 * So this helper is the CARD's rule. The advance's rule is the engine's, and
 * it is unchanged.
 */
function windowOpen(
  steps: Step[],
  status: string,
  decision: Record<string, unknown> = {},
): boolean {
  return steps.some(
    (s) =>
      s.requiresCapexOpex === true
      && (s.from === status || s.from === '*')
      && evaluateTrigger(s.when, s, predicateContext(PR, decision, MGMT_THRESHOLD)),
  );
}

// ── the rule itself ────────────────────────────────────────────────────────

describe('the window rule', () => {
  const CS_STEP: Step = {
    key: 'cs_review',
    name: 'CS review confirmed',
    from: 'IN_PROCUREMENT_REVIEW',
    to: 'IN_FINANCE_REVIEW',
    order: 6,
    when: 'csExitComplete',
    actorRole: 'hod',
    requiresCapexOpex: true,
  };

  test('the condition is the engine\'s to evaluate, and it fails closed', () => {
    // Satisfied — on the ADVANCE's question, with every line classified.
    const classified = predicateContext(
      { ...PR, lines: [{ lineNo: 1, itemCategory: 'OTHER', amount: 135, approved: true, classification: 'OPEX_ASSET' }] },
      { csReviewConfirmed: true },
      MGMT_THRESHOLD,
    );
    assert.equal(
      evaluatePredicate(CS_STEP.when, CS_STEP, classified),
      true,
    );
    // Not satisfied — the review has not concluded.
    assert.equal(
      evaluatePredicate(CS_STEP.when, CS_STEP, predicateContext(PR, {}, MGMT_THRESHOLD)),
      false,
      'csReviewConfirmed must fail closed when the review has not concluded',
    );
    // And it is the step's condition that decides, not the step's presence.
    assert.equal(
      evaluatePredicate('always', CS_STEP, predicateContext(PR, {}, MGMT_THRESHOLD)),
      true,
      "an 'always' step fires on every advance — which is exactly why a step that "
      + 'must fire on ONE action has to name its condition',
    );
  });

  test('the advance refuses while a line is unclassified, and the card still opens', () => {
    // THE PAIR, because either half alone is a bug.
    //
    // The advance must refuse: an unclassified line means the classification
    // control has not been satisfied. The card must open: that is how the line
    // is going to get classified. If the card did not open, the refusal would
    // be permanent.
    const unclassified = predicateContext(
      { ...PR, lines: [{ lineNo: 1, itemCategory: 'OTHER', amount: 135, approved: true, classification: null }] },
      { csReviewConfirmed: true },
      MGMT_THRESHOLD,
    );
    assert.equal(
      evaluatePredicate(CS_STEP.when, CS_STEP, unclassified),
      false,
      'the advance must refuse while a line is unclassified',
    );
    assert.equal(
      evaluateTrigger(CS_STEP.when, CS_STEP, unclassified),
      true,
      'the card must still open — it is the only way that line gets classified',
    );
  });

  test('a stage alone is not a condition', () => {
    // The step exists and the request sits at the stage it leaves. The card is
    // still not offered, because the step would not fire.
    const steps: Step[] = [CS_STEP];
    assert.equal(windowOpen(steps, 'IN_PROCUREMENT_REVIEW', {}), false);
    assert.equal(windowOpen(steps, 'IN_PROCUREMENT_REVIEW', { csReviewConfirmed: true }), true);
  });
});

// ── the ladder the rule is read from ───────────────────────────────────────

describe('the live ladder', () => {
  test('exactly two steps demand a classification, and both are the CS exit', (t) => {
    if (!dbAvailable()) return t.skip('database not reachable');
    const ladder = loadLadder();
    const gated = ladder.filter((s) => s.requiresCapexOpex === true);
    assert.deepEqual(
      gated.map((s) => s.key).sort(),
      ['cs_review', 'cs_review_quotes'],
      'the only steps that may demand a classification are the two CS exits',
    );
    for (const s of gated) {
      assert.equal(
        s.when,
        'csExitComplete',
        `${s.key} must stay conditioned on the whole CS exit — an unconditioned `
        + 'step would open the card at every stage it leaves. `csExitComplete` is '
        + 'csReviewConfirmed AND capexOpexClassified (migration 075): the review '
        + 'being closed AND every line being bought carrying a class.',
      );
      assert.equal(
        s.to,
        'IN_FINANCE_REVIEW',
        `${s.key} must land on Finance review. The cost-approval stage between them `
        + 'was removed in migration 075 and is not in the ladder any more.',
      );
    }

    // MIGRATION 075 — the removed stage leaves no trace in the routing table.
    // Asserted rather than assumed, because the failure it prevents is silent: a
    // step aimed at a stage with no exit strands its request permanently, and
    // nothing says so until somebody tries to advance it.
    for (const s of ladder) {
      assert.notEqual(
        s.from,
        'IN_COST_CENTER_APPROVAL',
        `${s.key} starts from a stage the ladder no longer routes to`,
      );
      assert.notEqual(
        s.to,
        'IN_COST_CENTER_APPROVAL',
        `${s.key} aims at a stage the ladder no longer routes to`,
      );
    }

    // ── AND, NAMED: THE FINANCE BAND IS NOT A SECOND GATE. ──────────────────
    //
    // This is a requirement, not an observation. Cost approval and the two
    // finance steps are where a reviewer is most tempted to re-assert the
    // control — "the lines might not be classified, better to check" — and a
    // duplicate gate is not a harmless belt-and-braces: it puts the same
    // decision on a second desk, where it can be answered differently, and the
    // two drift until one of them is a deadlock (which is what happened once
    // already, when the duplicate was hung on the blind reviewer — a role that
    // is not allowed to make the classification in the first place).
    //
    // So the assertion is per-STEP and by NAME, not merely "still only two".
    // If someone ticks `requiresCapexOpex` on finance_review tomorrow this fails
    // with the step name instead of a count that has quietly grown.
    for (const key of ['finance_review', 'finance_release', 'mc_approval', 'cfo_approval']) {
      const step = ladder.find((s) => s.key === key);
      if (!step) continue;                 // not every deployment has every step
      assert.notEqual(
        step!.requiresCapexOpex,
        true,
        `${key} (order ${step!.order}) must not demand a classification: the CS exit `
        + 'is the single authoritative gate, and finance may only CORRECT a class '
        + 'already on a line — never block a request on the absence of one',
      );
    }
  });

  test('the direct procurement forward step does NOT demand one', (t) => {
    // Migration 072, and prototype line 1912: `procurement` has
    // requiresCapexOpex:false. The live table had it ticked, which is what put
    // the card on the screen at "Procurement review · RFQ not issued".
    if (!dbAvailable()) return t.skip('database not reachable');
    const step = loadLadder().find((s) => s.key === 'procurement');
    assert.ok(step, 'the procurement step must exist in the routing table');
    assert.equal(step!.requiresCapexOpex, undefined);
    assert.equal(step!.from, 'IN_PROCUREMENT_REVIEW');
  });
});

// ── the outcome, per stage ─────────────────────────────────────────────────

describe('the window, stage by stage', () => {
  test('"RFQ not issued" — procurement review, no review concluded: CLOSED', (t) => {
    if (!dbAvailable()) return t.skip('database not reachable');
    const steps = loadLadder();
    // The reported symptom. The request is at procurement review, the RFQ has
    // not gone out, so there is no statement and nothing has been confirmed.
    assert.equal(windowOpen(steps, 'IN_PROCUREMENT_REVIEW', {}), false);
  });

  test('the CS exit — the review is confirmed and the request is still held: OPEN', (t) => {
    if (!dbAvailable()) return t.skip('database not reachable');
    const steps = loadLadder();
    assert.equal(windowOpen(steps, 'IN_PROCUREMENT_REVIEW', { csReviewConfirmed: true }), true);
    assert.equal(windowOpen(steps, 'QUOTES_RECEIVED', { csReviewConfirmed: true }), true);
  });

  test('the same two stages with the review still open: CLOSED', (t) => {
    if (!dbAvailable()) return t.skip('database not reachable');
    const steps = loadLadder();
    // A review under way is not a conclusion. The class is made at the exit,
    // after the blind review — not while the blind review is running.
    assert.equal(windowOpen(steps, 'IN_PROCUREMENT_REVIEW', {}), false);
    assert.equal(windowOpen(steps, 'QUOTES_RECEIVED', {}), false);
  });

  test('past the exit the card is closed — the class was made on the way in', (t) => {
    if (!dbAvailable()) return t.skip('database not reachable');
    const steps = loadLadder();
    // IN_COST_CENTER_APPROVAL was here until migration 075 removed the stage.
    // It is not in this list because it is not a stage the ladder reaches any
    // more, and asserting that a stage with no steps and no exit does not offer
    // a card is a vacuous assertion — it would pass whatever the rule became.
    for (const stage of [
      'IN_FINANCE_REVIEW',
      'IN_MANAGEMENT_REVIEW',
      'READY_FOR_D365',
      'D365_PUSHED',
    ]) {
      assert.equal(
        windowOpen(steps, stage, { csReviewConfirmed: true }),
        false,
        `${stage} must not offer the card: the class was made at the CS exit`,
      );
    }
  });

  test('the card opens at the CS exit WHILE the classification is outstanding', (t) => {
    // The deadlock, stated as a test.
    //
    // The step's condition now includes the classification requirement, so the
    // card's question ("is the classification the last thing standing?") and the
    // advance's question ("has the request actually crossed?") are different
    // questions. If the card asked the advance's, the window would close
    // exactly when there was work to do — and the work would never be done.
    if (!dbAvailable()) return t.skip('database not reachable');
    const steps = loadLadder();
    // A confirmed review, with a line that has NOT been classified yet.
    assert.equal(
      windowOpen(steps, 'QUOTES_RECEIVED', { csReviewConfirmed: true }),
      true,
      'the card must be offered while a line is still unclassified — it is the only '
      + 'way that line gets classified, and without it the request could never cross',
    );
  });
});
