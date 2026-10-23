// Regression cover for the HOD hold leak into Procurement's screens.
//
//   npm run test:web
//
// The defect
// ----------
// An HOD could put a PR line on Hold, approve the rest, and the held line still
// showed on the Procurement grid (/pr) and detail (/pr/[id]). `PrService.lightList`
// SELECTed `items.slice(0, 2)` and never SELECTed the `held` column, so the browser
// had neither the flag nor the untruncated list: a client-side filter would have
// hidden the wrong lines while the count still carried them. The endpoint now sends
// the full list with `held` attached, and the screens filter in the UI pending RBAC.
//
// There is a THIRD surface now. The Receive Quotation form was handed the raw list
// and hid only rejected lines, so a hold placed after the RFQ was issued survived
// there. See "the Receive Quotation form" below.
//
// The mixed case below is the one that matters. Filtering a pre-truncated preview
// does not merely under-report — it reports the OPPOSITE of the truth, promoting
// held lines into view and hiding live ones.
//
// The rule under test lives in lib/ui, not in either page. That is deliberate: it is
// the single definition both screens call, so they cannot drift apart, and it is
// exported so this test can reach it without standing up a Next session.

import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleItems, seesHeldLines, SEES_HELD_LINES } from '../lib/ui';
import { quotationRows } from '../components/sourcing/quoteRows';

type Line = { qty: number; uom: string; description: string; held: boolean };

function line(n: number, held = false): Line {
  return { qty: 1, uom: 'EA', description: `Line ${n}`, held };
}

/**
 * Reproduces the three numbers the grid derives from ONE filtered set: the chip
 * preview, the "+N more" overflow and the single-line title fallback. They must all
 * come from the same array or the row contradicts itself.
 */
function gridCells(items: Line[], seesHeld: boolean) {
  const visible = visibleItems(items, seesHeld);
  return {
    chips: visible.slice(0, 2),
    overflow: Math.max(0, visible.length - 2),
    title: visible.length === 1 ? visible[0].description : '—',
  };
}

// ── who may see a held line ─────────────────────────────────────────────────

test('the HOD and the requester keep seeing held lines', () => {
  for (const r of ['hod', 'requester']) {
    assert.equal(seesHeldLines(r), true, `${r} owns the disposition`);
  }
});

test('every downstream role is denied held lines', () => {
  // `admin` is the union of all stage permissions, so it sits DOWNSTREAM of the HOD
  // here — it is not a superuser for a hold it cannot lift.
  for (const r of ['procurement', 'admin', 'finance', 'cfo', 'management', 'cs', 'mc', 'system']) {
    assert.equal(seesHeldLines(r), false, `${r} must not see a held line`);
  }
});

test('the role list is exactly HOD and requester', () => {
  assert.deepEqual([...SEES_HELD_LINES].sort(), ['hod', 'requester']);
});

// ── the filter itself ───────────────────────────────────────────────────────

test('a downstream role sees no held line', () => {
  const items = [line(1, true), line(2), line(3)];
  const visible = visibleItems(items, false);
  assert.equal(visible.length, 2);
  assert.deepEqual(visible.map(l => l.description), ['Line 2', 'Line 3']);
});

test('the HOD sees every line, held included', () => {
  const items = [line(1, true), line(2), line(3, true)];
  assert.equal(visibleItems(items, true).length, 3);
});

test('a PR whose every line is held is empty for procurement, not absent', () => {
  // PR-2026-201649 as it stood on the estate: four held lines at IN_PROCUREMENT_REVIEW.
  const items = [line(1, true), line(2, true), line(3, true), line(4, true)];
  const c = gridCells(items, false);
  assert.deepEqual(c.chips, [], 'no held line may appear as a chip');
  assert.equal(c.overflow, 0, 'and no phantom "+N more"');
  assert.equal(c.title, '—', 'the title fallback must not quote a held line');
});

test('a NULL held flag is not held (the CSV bridge can send null)', () => {
  const items = [{ qty: 1, uom: 'EA', description: 'Undecided', held: null as any }];
  assert.equal(visibleItems(items, false).length, 1);
});

test('an undecided line is NOT hidden — only held is', () => {
  // advance() treats "undecided" as quotable; hiding it here would silently stop
  // procurement working a PR the HOD never touched.
  const items = [{ qty: 1, uom: 'EA', description: 'Undecided' }];
  assert.equal(visibleItems(items, false).length, 1);
});

// ── the mixed case that breaks a truncated preview ───────────────────────────

test('held lines FIRST then live lines: chips show live work, not phantom count', () => {
  const items = [line(1, true), line(2, true), line(3), line(4), line(5)];
  const c = gridCells(items, false);

  assert.deepEqual(c.chips.map(l => l.description), ['Line 3', 'Line 4'],
    'the two chips must be the first two VISIBLE lines');
  assert.equal(c.overflow, 1, '"+1 more" counts Line 5, not the two hidden held lines');
  // The exact failure this guards: filtering a 2-line preview would have rendered
  // zero chips and "+3 more" — hiding all real work and inventing three items.
  assert.notDeepEqual(c.chips, []);
  assert.notEqual(c.overflow, 3);
});

test('held lines LAST: the visible head is unchanged, only the tail shortens', () => {
  const items = [line(1), line(2), line(3), line(4, true), line(5, true)];
  const c = gridCells(items, false);
  assert.deepEqual(c.chips.map(l => l.description), ['Line 1', 'Line 2']);
  assert.equal(c.overflow, 1);
});

test('exactly one visible line drives the title fallback', () => {
  const c = gridCells([line(1, true), line(2)], false);
  assert.equal(c.title, 'Line 2',
    'a held line must not become the PR title via the single-line fallback');
});

test('a single HELD line must not become the PR title either', () => {
  // visible.length === 0 here, so the fallback must read "—" and not index into an
  // empty array — the original bug's shape, one line short.
  const c = gridCells([line(1, true)], false);
  assert.equal(c.title, '—');
});

test('filtering never mutates the source array', () => {
  // The rows come straight off the fetch; mutating them would make a re-render show
  // a different answer for the same data.
  const items = [line(1, true), line(2)];
  const snapshot = items.length;
  visibleItems(items, false);
  assert.equal(items.length, snapshot);
  assert.equal(items[0].held, true, 'the held line is filtered out, not cleared');
});

// ── the Receive Quotation form ──────────────────────────────────────────────
//
// The form the "Receive Quotation" button opens used to be handed `pr.lines`
// raw. It dropped rejected lines and knew nothing about hold, so an HOD hold
// placed after the RFQ went out was hidden on the Line Items table directly
// above the button and fully visible, priceable and submittable inside it.
// PR-2026-201658 is that case.
//
// `quotationRows` is where that is fixed, and it delegates the hold half to
// `visibleItems` rather than restating the rule — so these cases and the ones
// above cannot drift apart.

type QLine = { line_no: number; description: string; rejected?: boolean | null; held?: boolean | null };

function qline(n: number, held = false, rejected = false): QLine {
  return { line_no: n, description: `Line ${n}`, held, rejected };
}

test('a downstream role is offered no held line to quote', () => {
  const rows = quotationRows([qline(1, true), qline(2), qline(3)], false);
  assert.deepEqual(rows.map(l => l.line_no), [2, 3]);
});

test('the HOD still sees the held line on the form', () => {
  const rows = quotationRows([qline(1, true), qline(2)], true);
  assert.deepEqual(rows.map(l => l.line_no), [1, 2]);
});

test('a rejected line is not priceable even by a role that sees holds', () => {
  // Rejection is not a visibility question. Hold decides WHO looks; rejection
  // decides whether a line can be quoted at all.
  const rows = quotationRows([qline(1, false, true), qline(2)], true);
  assert.deepEqual(rows.map(l => l.line_no), [2]);
});

test('held AND rejected is gone for every role', () => {
  for (const seesHeld of [true, false]) {
    assert.deepEqual(quotationRows([qline(1, true, true), qline(2)], seesHeld).map(l => l.line_no), [2]);
  }
});

test('an undecided line is still quoted, exactly as on the grid', () => {
  // `advance()` treats undecided as quotable. Hiding it would silently stop
  // procurement working a PR nobody ever touched.
  const rows = quotationRows([{ line_no: 1, description: 'Undecided' }], false);
  assert.deepEqual(rows.map(l => l.line_no), [1]);
});

test('a NULL held flag is not held', () => {
  const rows = quotationRows([{ line_no: 1, description: 'Undecided', held: null }], false);
  assert.equal(rows.length, 1);
});

test('the locked banner counts the rows the form actually shows', () => {
  // "2 of 5 lines locked" is rendered from `priced.length`. If that counted the
  // unfiltered list the banner would name lines the officer cannot see and
  // cannot fill — the screen contradicting itself one row below the claim.
  const lines = [qline(1), qline(2), qline(3), qline(4, true), qline(5)];
  assert.equal(quotationRows(lines, false).length, 4, 'the denominator is the filtered set');
  assert.equal(quotationRows(lines, true).length, 5);
});

test('line order is preserved — the form is not re-sorted by the filter', () => {
  const rows = quotationRows([qline(1, true), qline(5), qline(3), qline(2)], false);
  assert.deepEqual(rows.map(l => l.line_no), [5, 3, 2]);
});

test('the form filter does not mutate the PR lines it was given', () => {
  const lines = [qline(1, true), qline(2)];
  quotationRows(lines, false);
  assert.equal(lines.length, 2, 'the held line is filtered out, not removed');
  assert.equal(lines[0].held, true);
  assert.equal(lines[0].rejected, false);
});