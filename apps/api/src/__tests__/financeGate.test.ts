// The FINANCE REVIEW stage: the release that waits there, and the card that is
// READ-ONLY while it waits.
//
//   npm run test:api
//
// WHY THIS FILE EXISTS
// --------------------
// A request that had reached IN_FINANCE_REVIEW had NOTHING to press.
//
// `canAct` was true for the finance desk, and every branch inside the action
// bar's `canAct` block was false — the revert is procurement's, the sourcing
// trio is procurement's, and the review link is a HOD screen. The request sat
// in Finance review with an empty action bar and no way out, and the Capex/Opex
// card underneath it offered Finance an ACTIVE "Save classification" button, so
// the one control the stage did show was a control nobody should have there.
//
// Four separate facts had to be true at once, and this file pins each:
//
//   1. the ENGINE already had a legal step out of the stage — `finance_release`
//      to READY_FOR_D365, `finance_review` to IN_MANAGEMENT_REVIEW — so this
//      was a missing CONTROL, not a missing route;
//   2. the DATABASE's own transition guard had to admit the edge, because it
//      holds a hardcoded edge table of its own (F5);
//   3. the authority to ACT the step had to be widened to the head of
//      department and the admin alias, and the step had to be identified by
//      SHAPE rather than by key (F3);
//   4. the classification card had to become read-only there (F1, F2).
//
// THE SHAPE-NOT-KEY RULE (F3, F6) IS THE PART THAT BITES
// -------------------------------------------------------
// 25 of the 1,370 frozen snapshots carry NO keys at all, so their two finance
// gates come back from `loadForPr` as `step_9` and `step_10` while the live
// ladder names them `finance_review` and `finance_release`. An authority check
// written against the key would have opened the gate for 1,345 requests and
// refused it for exactly the 25 whose snapshots are the oldest.
//
// The engine has never cared: `resolveNextStage` picks candidates by `from` and
// by the step's CONDITION. F3 pins that the authority check asks the same
// question the engine asked, and F6 pins that no snapshot is missing a gate.
//
// A NOTE ON WHAT IS NOT HERE
// --------------------------
// There is deliberately NO classification check on the finance advance. The CS
// exit is the ONE gate that demands a class — F7 re-asserts that — and the
// no-CS path can arrive at Finance unclassified, which is a recorded gap and
// not a second gate. A gate here would put the same decision on a second desk,
// which is the duplicate that the classification-window rules forbid.
//
// Anything needing a live database is skipped rather than silently passing
// when the database is not reachable.

import test from 'node:test';
import { describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  resolveNextStage,
  stepsFromConfigRows,
  type PrSnapshot,
  type Step,
} from '@procurement/workflow-engine';
import {
  COST_APPROVAL_STAGE,
  isCostConfirmedStage,
  isFinanceGate,
  mayActFinanceGate,
  mayCorrectClassification,
} from '../pr/cost.stages';

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
 * `stepsFromConfigRows` re-stamps each step's `order` from its array position,
 * so this is the engine's priority list and not the raw rows.
 */
function loadLadder(): Step[] {
  const raw = sql(
    'SELECT id, order_index, payload::text FROM workflow.steps_config ORDER BY order_index',
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

/** A request at the finance stage with a known (or unknown) amount. */
function pr(amount: number | null): PrSnapshot {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    prNumber: 'PR-0000-000000',
    status: 'IN_FINANCE_REVIEW',
    estimatedAmount: amount,
    amountStatus: amount === null ? 'UNKNOWN' : 'ESTIMATED',
    expenseType: 'OPEX',
    lines: [],
  };
}

// ── the card's authority ───────────────────────────────────────────────────

describe('the classification card at the finance stage', () => {
  test('F1 the correction window is CLOSED at IN_FINANCE_REVIEW, for every role', () => {
    // The reported symptom: Finance arrived at a request whose lines were
    // already classified and were offered an ACTIVE "Save classification"
    // button. The button was not a bug in the page — the page renders whatever
    // authority the API hands it — it was the rule behind that authority.
    //
    // Closed by STAGE, so it is closed for every role: at IN_FINANCE_REVIEW no
    // desk has a class to write. Procurement's own authority over the class was
    // exercised at the CS exit, which is a different stage.
    for (const role of ['finance', 'cfo', 'admin', 'hod', 'procurement', 'cs', 'requester']) {
      assert.equal(
        mayCorrectClassification(role, 'IN_FINANCE_REVIEW'),
        false,
        `${role} must not be able to correct a class at the finance stage`,
      );
    }
  });

  test('F2 the closure is scoped to that ONE stage, and is not a change of role', () => {
    // Two ways this could have gone wrong, and both are pinned.
    //
    // (a) CLOSED EVERYWHERE. If the rule had been written as "nobody may
    //     correct a class after the cost boundary", the window would have shut
    //     at the stages where the correction is the point of the rule.
    // (b) CHANGED TO A DIFFERENT ROLE. The correction right is a property of
    //     the stage, not of the role string.
    assert.equal(isCostConfirmedStage('IN_FINANCE_REVIEW'), true,
      'the stage is still a cost-confirmed stage — the CLOSURE is the new fact');
    for (const role of ['finance', 'cfo', 'admin']) {
      assert.equal(
        mayCorrectClassification(role, 'IN_MANAGEMENT_REVIEW'),
        true,
        `${role} keeps the correction right at the next stage`,
      );
      assert.equal(
        mayCorrectClassification(role, 'READY_FOR_D365'),
        true,
        `${role} keeps the correction right at Ready for D365`,
      );
    }
    // And before the cost boundary nobody had a correction to make, because
    // there was no decision to correct yet.
    for (const stage of ['IN_PROCUREMENT_REVIEW', 'QUOTES_RECEIVED', 'IN_HOD_REVIEW']) {
      assert.equal(
        mayCorrectClassification('finance', stage),
        false,
        `${stage} is before the cost boundary — the class belongs to procurement there`,
      );
    }
  });
});

// ── identifying the finance gates ──────────────────────────────────────────

describe('identifying a finance gate', () => {
  /**
   * `isFinanceGate` takes the SHAPE it reads — `from` and `to` — and nothing
   * else. A frozen entry carries more than that (`when`, `key`, `order`, …),
   * which is why the production call site passes a `Step` and never a literal.
   *
   * This wrapper is the same thing with the extra fields admitted at the type
   * level, so a test can spell out a WHOLE entry — which is the point: the
   * gate must be recognised from its shape, whatever else the entry carries.
   */
  const gate = (step: { from?: string; to?: string; when?: string; key?: string }): boolean =>
    isFinanceGate(step);

  test('F3 the gate is identified by SHAPE, so a keyless snapshot still matches', () => {
    // The 25 oldest snapshots on this estate carry no keys at all. Their gates
    // come back from `loadForPr` as `step_9` and `step_10`. A key-based test
    // would have refused them.
    const keyed = {
      key: 'finance_release',
      from: 'IN_FINANCE_REVIEW',
      to: 'READY_FOR_D365',
      when: 'belowMgtThreshold',
    };
    const keyless = {
      from: 'IN_FINANCE_REVIEW',
      to: 'READY_FOR_D365',
      when: 'belowMgtThreshold',
    };
    assert.equal(gate(keyed), true);
    assert.equal(gate(keyless), true,
      'a frozen entry with no key is still a finance gate');

    // The sibling gate, and its older spelling.
    assert.equal(
      gate({ from: 'IN_FINANCE_REVIEW', to: 'IN_MANAGEMENT_REVIEW' }),
      true,
    );
    assert.equal(
      gate({
        from: 'IN_FINANCE_REVIEW',
        to: 'READY_FOR_D365',
        when: 'amountLT',
      }),
      true,
      'the OLDER threshold spelling is the same gate — the condition is not part of the identity',
    );

    // And nothing else is.
    for (const step of [
      { from: 'IN_PROCUREMENT_REVIEW', to: 'IN_FINANCE_REVIEW' },   // the CS exit
      { from: 'IN_MANAGEMENT_REVIEW', to: 'READY_FOR_D365' },        // the management gate
      { from: 'READY_FOR_D365', to: 'D365_PUSHED' },                 // the D365 push
      { from: '*', to: 'REJECTED' },                                 // a side channel
    ]) {
      assert.equal(gate(step), false,
        `${step.from} -> ${step.to} is not a gate out of the finance stage`);
    }
  });

  test('F3b the release is not the exclusive right of the finance desk', () => {
    // The 2026-10-23 ruling, and the one thing this allowance must not become:
    // a promotion. It is scoped to the STAGE, so a head gains the two gates out
    // of IN_FINANCE_REVIEW and nothing else.
    const release = { from: 'IN_FINANCE_REVIEW', to: 'READY_FOR_D365' };
    const referral = { from: 'IN_FINANCE_REVIEW', to: 'IN_MANAGEMENT_REVIEW' };

    for (const role of ['hod', 'cfo', 'admin']) {
      assert.equal(mayActFinanceGate(role, release), true,
        `${role} must be able to act the release`);
      assert.equal(mayActFinanceGate(role, referral), true,
        `${role} must be able to act the management referral`);
    }

    // And the gates it does NOT open.
    for (const step of [
      { from: 'IN_PROCUREMENT_REVIEW', to: 'IN_FINANCE_REVIEW' },  // the CS exit
      { from: 'IN_MANAGEMENT_REVIEW', to: 'READY_FOR_D365' },       // the management gate
      { from: 'QUOTES_RECEIVED', to: 'MC_APPROVED' },               // the MC vote
      { from: 'CS_LOCKED', to: 'CFO_APPROVED' },                    // the CFO approval
      { from: 'READY_FOR_D365', to: 'D365_PUSHED' },                // the D365 push
    ]) {
      assert.equal(mayActFinanceGate('hod', step), false,
        `a head must not gain ${step.from} -> ${step.to} by way of the finance release`);
    }

    // A desk with no business at this stage gets nothing.
    for (const role of ['procurement', 'cs', 'requester', 'vendor', 'management']) {
      assert.equal(mayActFinanceGate(role, release), false,
        `${role} must not act the finance release`);
    }
  });
});

// ── the engine, on the live ladder ─────────────────────────────────────────

describe('the release, on the live ladder', () => {
  test('F4 the engine picks the gate from the amount, and the two are exclusive', (t) => {
    if (!dbAvailable()) return t.skip('database not reachable');
    const ladder = loadLadder();
    const config = { steps: ladder, managementThreshold: MGMT_THRESHOLD };

    // Below the threshold: the release, to Ready for D365.
    const below = resolveNextStage(config, pr(500_000));
    assert.equal(below.nextStage, 'READY_FOR_D365');
    assert.equal(below.matchedStep, 'finance_release');

    // Above it: the management referral, NOT the release.
    const above = resolveNextStage(config, pr(5_000_000));
    assert.equal(above.nextStage, 'IN_MANAGEMENT_REVIEW');
    assert.equal(above.matchedStep, 'finance_review');

    // An UNKNOWN amount is treated as above, never below. Not knowing a price
    // is not evidence of a small one, and a request nobody has priced must not
    // walk past the management gate.
    const unknown = resolveNextStage(config, pr(null));
    assert.equal(unknown.nextStage, 'IN_MANAGEMENT_REVIEW',
      'an unpriced request must not be released to D365');
  });

  test('F4b exactly two gates leave the finance stage, and both are legal', (t) => {
    if (!dbAvailable()) return t.skip('database not reachable');
    const ladder = loadLadder();
    const gates = ladder.filter((s) => s.from === 'IN_FINANCE_REVIEW');
    assert.deepEqual(
      gates.map((s) => s.to).sort(),
      ['IN_MANAGEMENT_REVIEW', 'READY_FOR_D365'],
      'the finance stage has exactly two exits',
    );
    for (const g of gates) {
      assert.equal(g.actorRole, 'finance',
        `${g.key} is the finance desk's act`);
      assert.notEqual(g.requiresCapexOpex, true,
        `${g.key} must not demand a classification — the CS exit is the single gate`);
    }
  });

  test('F5 the DATABASE admits the edge the engine is about to take', (t) => {
    // The trigger holds a HARDCODED edge table of its own, and it has refused
    // an engine-planned transition before. The engine planning the move is not
    // the move.
    //
    // Proved by ATTEMPTING it, in a transaction that is rolled back: if the
    // trigger refuses, the statement raises and nothing is committed.
    if (!dbAvailable()) return t.skip('database not reachable');
    const prId = sql(
      "SELECT id FROM proc.purchase_requisitions WHERE status='IN_FINANCE_REVIEW' LIMIT 1",
    );
    if (!prId) return t.skip('no request is at the finance stage right now');
    const out = sql(
      `BEGIN; UPDATE proc.purchase_requisitions SET status='READY_FOR_D365' WHERE id='${prId}'; ROLLBACK;`,
    );
    assert.ok(!/ERROR/i.test(out), `the trigger refused the edge: ${out}`);
  });

  test('F6 every frozen snapshot carries a gate, so no request can strand there', (t) => {
    // The check that CANCELLED migration 076.
    //
    // 25 snapshots carry no keys, and 119 carry the older per-step threshold
    // spelling (`amountLT` / `amountGTE` with the number pinned in the step)
    // rather than the global `belowMgtThreshold`. Both facts looked alarming and
    // neither is a defect: the engine matches candidates by `from` and by the
    // condition, so a keyed-but-older entry routes, and a keyless one routes
    // too. What would be a defect is a snapshot with NO gate at all, because
    // that request could never leave the stage.
    if (!dbAvailable()) return t.skip('database not reachable');
    const stranded = sql(`
      SELECT count(*) FROM workflow.pr_workflow_snapshot s
       WHERE NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(s.steps::jsonb) e
              WHERE e->>'from' = 'IN_FINANCE_REVIEW' AND e->>'to' = 'READY_FOR_D365')
         OR NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(s.steps::jsonb) e
              WHERE e->>'from' = 'IN_FINANCE_REVIEW' AND e->>'to' = 'IN_MANAGEMENT_REVIEW')`);
    assert.equal(
      Number(stranded),
      0,
      'a snapshot with no finance gate strands its request at the finance stage forever',
    );
  });

  test('F7 the classification is still demanded at exactly one place', (t) => {
    // Re-asserted here, in the band where a second gate is most tempting.
    //
    // The ruling (2026-10-23): the CS exit is the ONE gate that demands a
    // class, and the finance release does NOT re-check it. A duplicate gate
    // puts the same decision on a second desk, where it can be answered
    // differently, and the two drift until one of them is a deadlock.
    if (!dbAvailable()) return t.skip('database not reachable');
    const ladder = loadLadder();
    const gated = ladder.filter((s) => s.requiresCapexOpex === true);
    assert.deepEqual(
      gated.map((s) => s.key).sort(),
      ['cs_review', 'cs_review_quotes'],
      'the only steps that may demand a classification are the two CS exits',
    );
  });
});
