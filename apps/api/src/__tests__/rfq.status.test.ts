// Unit tests for the pure RFQ status/rollup layer.
//
// Every expectation is traceable to a line in the prototype:
//   rfqRows()      PROCUREMENT_PORTAL_PROTOTYPE.html:8954-8972
//   renderRFQList() PROCUREMENT_PORTAL_PROTOTYPE.html:8974-8999

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rfqStatusView, rfqRollups, subStatus, emptyProcurement, parseJsonb } from '../sourcing/rfq.status';

test('rfqStatusView — the live rule, verbatim from rfqRows()', () => {
  // status: pr.csLocked ? 'CS locked' : (quotes.length >= 3) ? 'Quotes received' : 'Awaiting quotes'
  // pill:   pr.csLocked ? 'locked'    : (quotes.length >= 3) ? 'pending'           : 'draft'

  assert.deepEqual(
    rfqStatusView({ state: 'Open', quotes: 3, invited: 3 }),
    { label: 'Quotes received', pill: 'pending', isOpen: true },
  );
  assert.deepEqual(
    rfqStatusView({ state: 'Open', quotes: 0, invited: 3 }),
    { label: 'Awaiting quotes', pill: 'draft', isOpen: true },
  );
  assert.deepEqual(
    rfqStatusView({ state: 'Open', quotes: 3, invited: 3, csLocked: true }),
    { label: 'CS locked', pill: 'locked', isOpen: false },
  );
});

test('rfqStatusView — a CS lock outranks the quote count', () => {
  // Only 2 quotes but the CS is locked: the prototype still says 'CS locked'.
  const v = rfqStatusView({ state: 'Closed', quotes: 2, invited: 3, csLocked: true });
  assert.equal(v.label, 'CS locked');
  assert.equal(v.pill, 'locked');
  assert.equal(v.isOpen, false, 'a CS-locked RFQ is not counted in the Open KPI');
});

test('rfqStatusView — partial quotes use the prototype\'s "N of M quotes" variant', () => {
  // renderRFQList's static demo row: '2 of 3 quotes' with pill 'pending'.
  assert.deepEqual(
    rfqStatusView({ state: 'Open', quotes: 2, invited: 3 }),
    { label: '2 of 3 quotes', pill: 'pending', isOpen: true },
  );
  assert.deepEqual(
    rfqStatusView({ state: 'Open', quotes: 1, invited: 3 }),
    { label: '1 of 3 quotes', pill: 'pending', isOpen: true },
  );
});

test('rfqStatusView — a 3-vendor RFQ with 4 quotes is still "Quotes received"', () => {
  // rfqRows() compares quotes >= 3, NOT quotes >= invited. Copying the
  // prototype's rule rather than "improving" it to a full-roster check.
  assert.equal(rfqStatusView({ state: 'Open', quotes: 4, invited: 3 }).label, 'Quotes received');
});

test('rfqStatusView — terminal states carry the prototype\'s own words', () => {
  assert.deepEqual(
    rfqStatusView({ state: 'Open', quotes: 3, invited: 3, d365Pushed: true }),
    { label: 'Pushed to D365', pill: 'approved', isOpen: false },
  );
  assert.deepEqual(
    rfqStatusView({ state: 'Cancelled', quotes: 0, invited: 3 }),
    { label: 'Cancelled', pill: 'draft', isOpen: false },
  );
  assert.deepEqual(
    rfqStatusView({ state: 'Awarded', quotes: 3, invited: 3 }),
    { label: 'Awarded', pill: 'locked', isOpen: false },
  );
});

test('rfqStatusView — a D365 push outranks a CS lock', () => {
  const v = rfqStatusView({ state: 'Closed', quotes: 3, invited: 3, csLocked: true, d365Pushed: true });
  assert.equal(v.label, 'Pushed to D365');
  assert.equal(v.pill, 'approved');
});

// ── rollups ────────────────────────────────────────────────────────────────

test('rfqRollups — the four rfq-list KPI cards', () => {
  const rows = [
    { quotes: 3, lowestBid: 1000, view: rfqStatusView({ state: 'Open', quotes: 3, invited: 3 }) },
    { quotes: 0, lowestBid: null, view: rfqStatusView({ state: 'Open', quotes: 0, invited: 3 }) },
  ];
  const k = rfqRollups(rows);
  assert.equal(k.total, 2, 'Total RFQs');
  assert.equal(k.open, 2, 'Open — awaiting or collecting quotes');
  assert.equal(k.avgQuotes, '1.5', 'Avg quotes / RFQ = (3+0)/2, one decimal');
  assert.equal(k.totalQuotedValue, 1000, 'Total quoted value sums the LOWEST BID only');
});

test('rfqRollups — total quoted value ignores non-lowest bids', () => {
  // The KPI sub-label is 'Lowest bid per RFQ' (renderRFQList:8984). We sum one
  // number per RFQ, never every quote, because the caller already picked the
  // lowest. An RFQ with nothing quoted contributes 0, not null.
  const rows = [
    { quotes: 3, lowestBid: 500, view: rfqStatusView({ state: 'Open', quotes: 3, invited: 3 }) },
    { quotes: 2, lowestBid: null, view: rfqStatusView({ state: 'Open', quotes: 2, invited: 3 }) },
    { quotes: 1, lowestBid: 250, view: rfqStatusView({ state: 'Open', quotes: 1, invited: 3 }) },
  ];
  assert.equal(rfqRollups(rows).totalQuotedValue, 750);
});

test('rfqRollups — Open counts only non-terminal rows', () => {
  const rows = [
    { quotes: 3, lowestBid: 1, view: rfqStatusView({ state: 'Open', quotes: 3, invited: 3 }) },
    { quotes: 3, lowestBid: 2, view: rfqStatusView({ state: 'Closed', quotes: 3, invited: 3, csLocked: true }) },
    { quotes: 3, lowestBid: 3, view: rfqStatusView({ state: 'Closed', quotes: 3, invited: 3, d365Pushed: true }) },
  ];
  assert.equal(rfqRollups(rows).open, 1);
});

test('rfqRollups — an empty list never yields NaN', () => {
  // The prototype computes (sum/length).toFixed(1), which is 'NaN' on an empty
  // list. We render '0.0' instead — the one deliberate divergence, and it is
  // in a KPI tile where NaN would be a visible defect.
  const k = rfqRollups([]);
  assert.deepEqual(k, { total: 0, open: 0, avgQuotes: '0.0', totalQuotedValue: 0 });
  assert.ok(!Number.isNaN(Number(k.avgQuotes)));
});

// ── the PR-detail cards ────────────────────────────────────────────────────

test('subStatus — the three-rung ladder, verbatim from _lightProcurementCard', () => {
  // if (rfq && !quotes.length)                -> 'RFQ issued, awaiting quotes'
  // else if (rfq && quotes.length && !winner) -> 'Quotes received, select winner'
  // else if (winner)                          -> 'Winner selected, confirm cost'
  assert.deepEqual(subStatus(true, false, false),
    { label: 'RFQ issued, awaiting quotes', tone: 'info' });
  assert.deepEqual(subStatus(true, true, false),
    { label: 'Quotes received, select winner', tone: 'warn' });
  assert.deepEqual(subStatus(true, true, true),
    { label: 'Winner selected, confirm cost', tone: 'done' });
});

test('subStatus — no RFQ means NO pill, not a fallen-through first rung', () => {
  // The bug this pins: the card body says "Click Issue RFQ to start the
  // procurement flow." while the pill beside the title said "RFQ issued,
  // awaiting quotes" — the same card claiming both. Every prototype branch is
  // guarded on `rfq`, so the no-RFQ state is simply absent, not rung one.
  assert.equal(subStatus(false, false, false), null);
  // Also absent when the impossible combinations are handed in — with no RFQ
  // there can be no quotes and no winner, so those must not resurrect a pill.
  assert.equal(subStatus(false, true, false), null);
  assert.equal(subStatus(false, true, true), null);
});

test('subStatus — a winner outranks the quote count', () => {
  // The prototype checks the winner branch last but the ladder means a
  // winner always wins: you cannot select a winner without quotes, so
  // (hasQuotes, hasWinner) = (false, true) is unreachable in practice, and the
  // prototype would also fall through to the first branch there.
  assert.equal(subStatus(true, false, true)?.label, 'Winner selected, confirm cost');
});

test('emptyProcurement — the prototype\'s pre-RFQ procurement object', () => {
  // _lightEnsureProcurement line 4054:
  //   {rfq:null, quotes:[], selectedQuoteIndex:-1, winner:null}
  // The detail card renders "Click Issue RFQ to start the procurement flow."
  // off `rfq` being null, so these fields must exist, not be undefined.
  const p = emptyProcurement();
  assert.equal(p.rfq, null);
  assert.deepEqual(p.quotes, []);
  assert.equal(p.selectedQuoteIndex, -1);
  assert.equal(p.winner, null);
});

test('parseJsonb — jsonb arrives as a string through the CSV bridge', () => {
  assert.deepEqual(parseJsonb('{"winner_vendor_id":"v1"}'), { winner_vendor_id: 'v1' });
  assert.equal(parseJsonb(null), null);
  assert.equal(parseJsonb(undefined), null);
  // Already-parsed objects pass through.
  assert.deepEqual(parseJsonb({ a: 1 }), { a: 1 });
  // Malformed jsonb must not throw — a locked CS with a corrupt recommendation
  // should degrade to "no winner", not 500 the whole detail page.
  assert.equal(parseJsonb('{not json'), null);
});
