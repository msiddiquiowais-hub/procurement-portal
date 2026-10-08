// Unit tests for the CS scoring model.
//
// The prototype has no scoring at all — renderCS just lists Amount / Lead /
// Warranty and lets a human pick. The schema demands real numbers, so these
// tests pin the rules that make the numbers defensible rather than decorative.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCs, type CsWeights } from '../sourcing/cs.scoring';

const W: CsWeights = { commercial: 0.6, technical: 0.3, warranty: 0.1 };

const v = (o: Partial<Parameters<typeof scoreCs>[0][number]>) => ({
  vendor_id: 'v1', vendor_name: 'V1', vendor_code: 'V-1',
  total_amount: 100000, lead_time_days: 10, warranty_months: 12,
  quotation_id: 'q1', version: 1,
  ...o,
});

test('cheapest wins commercial, fastest wins technical, longest warranty wins warranty', () => {
  const r = scoreCs([
    v({ vendor_id: 'cheap', total_amount: 50000 }),
    v({ vendor_id: 'dear', total_amount: 150000 }),
    v({ vendor_id: 'fast', lead_time_days: 3 }),
    v({ vendor_id: 'slow', lead_time_days: 30 }),
    v({ vendor_id: 'longw', warranty_months: 60 }),
    v({ vendor_id: 'shortw', warranty_months: 1 }),
  ], W);
  const by = Object.fromEntries(r.map(x => [x.vendor_id, x]));

  assert.equal(by.cheap.commercial_score, 100, 'cheapest scores 100 on commercial');
  assert.equal(by.dear.commercial_score, 0, 'dearest scores 0 on commercial');
  assert.equal(by.fast.technical_score, 100, 'fastest scores 100 on technical');
  assert.equal(by.slow.technical_score, 0, 'slowest scores 0 on technical');
  assert.equal(by.longw.warranty_score, 100, 'longest warranty scores 100');
  assert.equal(by.shortw.warranty_score, 0, 'shortest warranty scores 0');
});

test('a missing value scores 0 and is named in `missing` — it never wins by silence', () => {
  // D5's rule applied to numbers: a vendor that did not state a lead time must
  // not collect a perfect technical score by saying nothing.
  const r = scoreCs([
    v({ vendor_id: 'silent', lead_time_days: null, warranty_months: null }),
    v({ vendor_id: 'spoken', lead_time_days: 10, warranty_months: 12 }),
  ], W);
  const silent = r.find(x => x.vendor_id === 'silent')!;

  assert.equal(silent.technical_score, 0);
  assert.equal(silent.warranty_score, 0);
  assert.deepEqual(silent.missing.sort(), ['technical', 'warranty']);
  // It must not outrank the vendor that actually answered.
  assert.equal(r[0].vendor_id, 'spoken');
});

test('a criterion where every vendor is identical gives everyone 100', () => {
  const r = scoreCs([
    v({ vendor_id: 'a', total_amount: 100000, lead_time_days: 7 }),
    v({ vendor_id: 'b', total_amount: 100000, lead_time_days: 7 }),
  ], W);
  assert.ok(r.every(x => x.commercial_score === 100));
  assert.ok(r.every(x => x.technical_score === 100));
});

test('a single vendor scores 100 across the board and ranks 1', () => {
  const r = scoreCs([v({})], W);
  assert.equal(r.length, 1);
  assert.equal(r[0].rank, 1);
  assert.ok(r.every(x => [x.commercial_score, x.technical_score, x.warranty_score].every(s => s === 100)));
});

test('rank order follows the weighted score, descending', () => {
  const r = scoreCs([
    v({ vendor_id: 'a', total_amount: 90000, lead_time_days: 5, warranty_months: 36 }),
    v({ vendor_id: 'b', total_amount: 110000, lead_time_days: 5, warranty_months: 36 }),
    v({ vendor_id: 'c', total_amount: 100000, lead_time_days: 5, warranty_months: 36 }),
  ], W);
  assert.deepEqual(r.map(x => x.rank), [1, 2, 3]);
  for (let i = 1; i < r.length; i++) {
    assert.ok(r[i - 1].weighted_score >= r[i].weighted_score, 'weighted score is non-increasing');
  }
});

test('a tie on weighted score breaks on the cheaper total, so the order is deterministic', () => {
  // scan order must not decide a rank
  const r = scoreCs([
    v({ vendor_id: 'dearer', total_amount: 120000 }),
    v({ vendor_id: 'cheaper', total_amount: 80000 }),
  ], { commercial: 0, technical: 0, warranty: 0 } as CsWeights);
  // With zero weights every weighted score ties at 0, so the tiebreak is the
  // only thing ordering them — and it must favour the cheaper bid.
  assert.equal(r[0].vendor_id, 'cheaper');
  assert.equal(r[0].rank, 1);
});

test('every score lands inside the schema\'s 0..100 CHECK bounds', () => {
  // proc.cs_lines CHECKs each score column to BETWEEN 0 AND 100. A model that
  // could emit 100.0000001 would fail at INSERT, not at render.
  const r = scoreCs([
    v({ vendor_id: 'a', total_amount: 0, lead_time_days: 0, warranty_months: 0 }),
    v({ vendor_id: 'b', total_amount: 999999999, lead_time_days: 9999, warranty_months: 999 }),
  ], W);
  for (const s of r) {
    for (const k of ['commercial_score', 'technical_score', 'warranty_score', 'weighted_score'] as const) {
      assert.ok(s[k] >= 0 && s[k] <= 100, `${k}=${s[k]} is within 0..100`);
    }
    assert.ok(s.rank >= 1, 'rank satisfies cs_lines_rank_check (rank >= 1)');
  }
});

test('weights are normalised, so an un-normalised set still lands in 0..100', () => {
  // If the weights summed to 2 the weighted score would double past 100 and the
  // INSERT would fail. Dividing by the weight sum makes the model safe for any
  // weight set the DB default might be changed to.
  const r = scoreCs([
    v({ vendor_id: 'a', total_amount: 50000, lead_time_days: 1, warranty_months: 60 }),
    v({ vendor_id: 'b', total_amount: 150000, lead_time_days: 30, warranty_months: 1 }),
  ], { commercial: 1.2, technical: 0.6, warranty: 0.2 });
  for (const s of r) {
    assert.ok(s.weighted_score >= 0 && s.weighted_score <= 100, `${s.weighted_score} within 0..100`);
  }
});

test('an empty roster produces no lines rather than throwing', () => {
  assert.deepEqual(scoreCs([], W), []);
});
