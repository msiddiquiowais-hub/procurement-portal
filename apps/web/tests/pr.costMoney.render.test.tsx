// What the Line items table may say about money, once Cost approval exists.
//
//   npm run test:web
//
// WHY THIS FILE EXISTS
// --------------------
// A PR reached Cost approval with no estimate on any line, and the table printed
//
//     Unit: PKR 0     Amount: PKR 0
//
// on every row, while the header card directly above it read "not set yet". Both
// were true of the same PR at the same moment. "PKR 0" is not a neutral rendering
// of missing data — it is a QUOTE. It tells the cost-approver the items are free.
//
// So the rule this pins is the em-dash: an absent figure is marked absent, and a
// real zero still prints as a zero, because a requester can genuinely mean free
// and that is an answer rather than a silence (migration 052).
//
// The second half pins the boundary itself. The awarded columns must not appear
// before Cost approval — not because the data is missing (the award exists from
// the moment sourcing records it) but because an award is not the CONFIRMED cost
// until Cost approval has confirmed it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pkr, pkrOrDash } from '../lib/ui';

// This file is compiled to `.render-build/tests/` and run from there, so
// __dirname is NOT the source tree. Walk up to whichever directory actually
// holds `pages/` — apps/web (source) or apps/web/.render-build (compiled).
// Same approach as hooks-order.test.tsx.
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
 * These tests assert on the absence of a code pattern, so a COMMENT that quotes
 * the old pattern would either satisfy the presence check or break the absence
 * one — and either way the test would be measuring the prose, not the render.
 */
function readPageSource(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/.*$/gm, '$1');
}

const detailPage = readPageSource(join(resolveWebRoot(), 'pages', 'pr', '[id].tsx'));

test('M1 pkrOrDash prints an em-dash for an absent figure', () => {
  assert.equal(pkrOrDash(null), '—');
  assert.equal(pkrOrDash(undefined), '—');
  assert.equal(pkrOrDash(''), '—');
});

test('M2 pkrOrDash still prints a REAL zero as a zero', () => {
  // The distinction that makes the em-dash worth having. Collapsing these two is
  // the original defect, not a fix for it.
  assert.equal(pkrOrDash(0), 'PKR 0');
  assert.equal(pkrOrDash('0'), 'PKR 0');
  assert.equal(pkrOrDash(18500), 'PKR 18,500');
});

test('M3 pkr() is unchanged — arithmetic funnel still coerces', () => {
  // Deliberately NOT changed. Totals sum through it and a NaN in a running total
  // is worse than a zero. The fix was to stop feeding it absent FIGURES, not to
  // change what it does with a number.
  assert.equal(pkr(null), 'PKR 0');
  assert.equal(pkr(undefined), 'PKR 0');
  assert.equal(pkr(0), 'PKR 0');
});

test('M4 the line table no longer renders an unpriced line as PKR 0', () => {
  // The two rows that produced the reported screen.
  assert.ok(
    detailPage.includes('{pkrOrDash(l.unit_price_est)}'),
    'the unit column must go through pkrOrDash',
  );
  assert.ok(
    !detailPage.includes('{pkr(l.unit_price_est)}'),
    'the unit column must not go through the coercing formatter',
  );
  assert.ok(
    !detailPage.includes('{pkr(l.quantity * l.unit_price_est)}'),
    'the amount column must not multiply a null into a zero',
  );
});

test('M5 the awarded columns are driven by the API flag, not a local stage list', () => {
  // The browser must not re-derive the stage rule. The API refuses an advance on
  // the same predicate, and a second copy of the stage list here is exactly how a
  // column and a gate drift apart — the columns would appear at a stage the gate
  // does not enforce, or (worse) the gate would be stricter than the display.
  assert.ok(detailPage.includes('pr.cost_confirmed'), 'the flag must be read');
  assert.ok(
    !/const costConfirmed\s*=\s*(pr\.status|pr\.status\s*===|isCost)/.test(detailPage),
    'costConfirmed must not be re-derived from a local stage test',
  );
  assert.ok(detailPage.includes('const costConfirmed = !!pr.cost_confirmed;'));
});

test('M6 both totals refuse to lie by omission', () => {
  // Summing the priced lines of a partly-unpriced PR would print a confident,
  // understated total — the same class of lie as PKR 0, one row up.
  assert.ok(
    detailPage.includes('visibleLines.every(l => l.unit_price_est !== null'),
    'the estimated total must require EVERY visible line to be priced',
  );
  assert.ok(
    detailPage.includes('partial —'),
    'a partial award must be labelled partial rather than presented as the whole',
  );
});

test('M7 the variance is shown, because that is the point of Cost approval', () => {
  // Confirming a cost without comparing it to the budget is a rubber stamp.
  assert.ok(detailPage.includes('vs est.'), 'the variance must reach the screen');
  assert.ok(detailPage.includes('<tfoot>'), 'the totals row must render');
});