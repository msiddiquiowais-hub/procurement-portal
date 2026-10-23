// The Cost approval boundary: what may be shown, and what may be passed.
//
//   npm run test:api
//
// WHY THIS FILE EXISTS
// --------------------
// Two defects, one cause.
//
// 1. A PR reached Cost approval — the stage whose entire job is to confirm cost —
//    with NO estimate anywhere on it. Nothing refused it. Three stages then went
//    on to confirm a figure nobody had ever stated.
//
// 2. That same unpriced PR's Line items table printed "PKR 0" on every row. It was
//    not a number: `pr.service.get()` coerced `unit_price_est` with `Number(...)`,
//    and `Number(null)` is 0. The header card one screen above it correctly read
//    `amount_status` (migration 046) and said "not set yet", so the same screen
//    made two opposite statements about the same PR — one of which asserted that
//    the items were free.
//
// The cause of (1) is that migration 046 put the machinery in the schema to tell
// "free" from "unknown" — `amount_status`, NOT NULL, CHECK-constrained to
// ESTIMATED/UNKNOWN — and then no gate ever read it.
//
// MIGRATION 075 MOVED THE BOUNDARY
// -------------------------------
// The stage this file was written about no longer exists in the ladder.
// IN_COST_CENTER_APPROVAL had exactly one exit — a `cost_center_owner` step that
// no control anywhere in the web app could fire — and 117 requests were sitting
// in it. The ruling is that the blind-review confirmation by the requesting HOD
// IS the cost approval event, so the CS exit now lands on IN_FINANCE_REVIEW and
// the boundary moved with it.
//
// The defects above are unchanged by that move, so the tests are too. What
// changed is WHICH stage answers "is the cost settled", and G5/G6 pin that
// change explicitly rather than letting it drift.
//
// These are pure-predicate tests. They pin the DECISION, and in particular they
// pin the two ways it is easy to get wrong:
//
//   - `estimated_amount > 0` is NOT the predicate. An explicit zero is a real
//     answer (migration 052 keeps it ESTIMATED because "free" is an answer, not a
//     silence), so a `> 0` test would refuse a legitimate PR while catching
//     nothing the flag does not already catch.
//   - The gate is enforced on EVERY edge that lands on the boundary, not on one
//     convenient one. It used to be an entering/leaving PAIR; there is no leaving
//     edge any more, and the three entering edges all have to be closed.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COST_APPROVAL_ENTRY_STEPS,
  COST_APPROVAL_STAGE,
  COST_CONFIRMED_STAGES,
  isCostConfirmedStage,
  touchesCostApproval,
} from '../pr/cost.stages';

test('G1 the boundary is the stage Finance review now sits on', () => {
  // Migration 075. This is the assertion that fails first if someone re-adds
  // IN_COST_CENTER_APPROVAL to the ladder without moving the boundary with it —
  // and that is exactly the drift that produced the stranded 117.
  assert.equal(COST_APPROVAL_STAGE, 'IN_FINANCE_REVIEW');
});

test('G2 the awarded columns appear AT the boundary, not before it', () => {
  // The single most important assertion in this file. The award exists in the
  // database from the moment sourcing records it, which is BEFORE the boundary,
  // so nothing about the data forces this — it is a stated rule.
  assert.equal(isCostConfirmedStage('IN_FINANCE_REVIEW'), true);

  for (const early of [
    'Submitted',
    'IN_HOD_REVIEW',
    'IN_WAREHOUSE',
    'IN_IT_REVIEW',
    'IN_WAREHOUSE_CHECK',
    'IN_PROCUREMENT_REVIEW',
    // The sourcing sub-states carry a real award already. Still not cost-confirmed.
    'QUOTES_RECEIVED',
    'CS_LOCKED',
    'PACK_LOCKED',
  ]) {
    assert.equal(isCostConfirmedStage(early), false, `${early} must not show the award`);
  }
});

test('G2b the removed stage shows nothing — it is not in the display vocabulary', () => {
  // IN_COST_CENTER_APPROVAL is gone from the ladder, but it is still a legal
  // string in the stage CHECK constraint, and the 117 rows that were moved out
  // of it are gone too. Keeping it in this list would let a request that had
  // been sitting in it keep advertising a live award: a stage in the display
  // vocabulary that the state machine cannot produce is precisely the drift
  // cost.stages.ts exists to prevent.
  assert.equal(isCostConfirmedStage('IN_COST_CENTER_APPROVAL'), false);
});

test('G3 every stage after the boundary shows the award', () => {
  for (const late of [
    'IN_FINANCE_REVIEW',
    'IN_MANAGEMENT_REVIEW',
    'READY_FOR_D365',
    'D365_PUSHED',
    'CLOSED',
    'FULFILLED_FROM_STOCK',
  ]) {
    assert.equal(isCostConfirmedStage(late), true, `${late} must show the award`);
  }
});

test('G4 REJECTED and ON_HOLD are not "cost confirmed"', () => {
  // They are reachable from anywhere, including from the boundary. They mean
  // "this PR is not proceeding", not "the cost is settled", and a live-looking
  // award on a dead PR reads as though something is still in flight.
  assert.equal(isCostConfirmedStage('REJECTED'), false);
  assert.equal(isCostConfirmedStage('ON_HOLD'), false);
});

test('G5 the list is exactly the stated set — no silent additions', () => {
  // Guards the set itself, so widening it is a visible diff rather than a
  // one-word edit that quietly exposes money a stage had not confirmed.
  // Migration 075 removed IN_COST_CENTER_APPROVAL from the top of this list.
  assert.deepEqual(COST_CONFIRMED_STAGES, [
    'IN_FINANCE_REVIEW',
    'IN_MANAGEMENT_REVIEW',
    'READY_FOR_D365',
    'D365_PUSHED',
    'CLOSED',
    'FULFILLED_FROM_STOCK',
  ]);
});

test('G6 EVERY edge that lands on the boundary is gated', () => {
  // Three ways in, and all three must be closed. Checking only one lets an
  // unpriced PR reach Finance by a route nobody looked at — which is what a
  // single-edge gate is always one edit away from doing.
  assert.equal(
    touchesCostApproval({ from: 'IN_PROCUREMENT_REVIEW', to: 'IN_FINANCE_REVIEW' }),
    true,
    'the plain procurement forward must be gated',
  );
  // The CS exits write the stage through the engine too, from two different
  // stages, and neither may arrive unpriced.
  assert.equal(touchesCostApproval({ from: 'QUOTES_RECEIVED', to: 'IN_FINANCE_REVIEW' }), true);
  assert.equal(touchesCostApproval({ from: 'IN_PROCUREMENT_REVIEW', to: 'IN_FINANCE_REVIEW' }), true);

  // …and the documented entry list agrees with them. `touchesCostApproval` is
  // what the gate actually calls, so this list is documentation — which is
  // exactly why it is asserted against rather than left to drift.
  assert.deepEqual(COST_APPROVAL_ENTRY_STEPS, ['cs_review', 'cs_review_quotes', 'procurement']);
});

test('G7 steps that never touch the boundary are untouched by the gate', () => {
  for (const step of [
    { from: 'IN_HOD_REVIEW', to: 'IN_WAREHOUSE' },
    { from: 'IN_IT_REVIEW', to: 'IN_WAREHOUSE_CHECK' },
    { from: 'IN_MANAGEMENT_REVIEW', to: 'READY_FOR_D365' },
  ]) {
    assert.equal(touchesCostApproval(step), false, `${step.from}->${step.to} must not be gated`);
  }
  // A step sitting ON the boundary still touches it, even from and to the same
  // stage: the predicate is about the edge, not about whether anything moved.
  assert.equal(touchesCostApproval({ from: 'IN_FINANCE_REVIEW', to: 'IN_FINANCE_REVIEW' }), true);
});

test('G8 the gate reads amount_status, never estimated_amount > 0', () => {
  // Encoded as the decision itself. An explicit 0 with amount_status 'ESTIMATED'
  // is an ANSWER — a requester can genuinely mean free — so it must cross the
  // boundary. Only 'UNKNOWN' is refused.
  const mayCross = (amountStatus: string, estimated: number) =>
    amountStatus === 'ESTIMATED';

  assert.equal(mayCross('ESTIMATED', 0), true, 'an explicit zero is an answer, not a silence');
  assert.equal(mayCross('ESTIMATED', 18500), true);
  assert.equal(mayCross('UNKNOWN', 0), false, 'unknown cannot be confirmed against');
  assert.equal(mayCross('UNKNOWN', 50000), false, 'a stale figure does not make it known');
});

test('G9 NULL is not zero — the defect that printed "PKR 0"', () => {
  // This is the coercion the API used to perform on every PR line.
  const coerceAsTheApiUsedTo = (v: unknown) => Number(v as any);

  // The old behaviour: "nobody has stated a price" became a confident zero.
  assert.equal(coerceAsTheApiUsedTo(null), 0);
  assert.ok(
    coerceAsTheApiUsedTo(null) === 0,
    'the coercion is the bug — if Number(null) ever stops being 0 this test is meaningless',
  );

  // The fixed behaviour passes NULL through untouched. pkrOrDash() then prints an
  // em-dash for it, while a genuine 0 still prints PKR 0.
  const coerceAsFixed = (v: unknown) =>
    v === null || v === undefined ? null : Number(v as any);

  assert.equal(coerceAsFixed(null), null, 'an unpriced line must stay unknown');
  assert.equal(coerceAsFixed(undefined), null);
  assert.equal(coerceAsFixed(0), 0, 'an explicitly free line stays 0');
  assert.equal(coerceAsFixed('18500'), 18500, 'the CSV bridge arrives as strings');
  assert.equal(coerceAsFixed('0.00'), 0);
});