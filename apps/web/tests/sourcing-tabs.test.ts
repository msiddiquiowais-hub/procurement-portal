// Unit guard for the my-prs action tabs.
//
// WHY THIS EXISTS SEPARATELY FROM THE BROWSER CHECK
// --------------------------------------------------
// verify_status_ui.mjs proves the tabs filter in place, but the Expired tab is
// EMPTY in the current 200-row window (which 200 PRs sit there moves every time
// a suite creates one). A browser-only guard would therefore never execute the
// Expired rule and could report green while it was wrong. These cases are
// synthetic on purpose.

import test from 'node:test';
import assert from 'node:assert/strict';
import { SOURCING_TABS, rowsForTab, type SourcingRow } from '../components/sourcing/tabs';

const row = (sourcing_status: string, expired_vendor_count = 0, status?: string): SourcingRow =>
  ({ sourcing_status, expired_vendor_count, status });

const ALL: SourcingRow[] = [
  row('AWAITING_QUOTES', 0),
  row('RECEIVED', 0),
  row('RECEIVED_THRESHOLD_MET', 2), // cleared the threshold, but 2 vendors never answered
  row('EXPIRED', 2),
  row('NOT_ISSUED', 0),
  row('PRE_PROCUREMENT', 0),
];

const statusOf = (rows: SourcingRow[]) => rows.map(r => r.sourcing_status).sort();

test('All keeps every row', () => {
  assert.equal(rowsForTab(ALL, 'all').length, ALL.length);
});

test('Awaiting Quotes shows only RFQs still short of responses', () => {
  assert.deepEqual(statusOf(rowsForTab(ALL, 'awaiting')), ['AWAITING_QUOTES']);
});

test('Received includes a threshold-met RFQ', () => {
  // The business rule is that procurement continues once the configured share of
  // vendors has responded. That is a form of received, not an expiry.
  assert.deepEqual(statusOf(rowsForTab(ALL, 'received')), ['RECEIVED', 'RECEIVED_THRESHOLD_MET']);
});

test('Expired pulls in a threshold-met PR whose vendors never answered', () => {
  // THE rule that makes this tab a fraud check rather than a status mirror. The
  // PR moved on; the vendors who timed out must still be investigable.
  assert.deepEqual(statusOf(rowsForTab(ALL, 'expired')), ['EXPIRED', 'RECEIVED_THRESHOLD_MET']);
});

test('Expired does NOT capture a clean received RFQ', () => {
  const clean = [row('RECEIVED', 0), row('AWAITING_QUOTES', 0), row('NOT_ISSUED', 0)];
  assert.equal(rowsForTab(clean, 'expired').length, 0);
});

test('a PR before procurement is in no bucket except All', () => {
  const pre = [row('PRE_PROCUREMENT', 0)];
  assert.equal(rowsForTab(pre, 'awaiting').length, 0);
  assert.equal(rowsForTab(pre, 'expired').length, 0);
  assert.equal(rowsForTab(pre, 'received').length, 0);
});

test('an unknown tab key falls back to All rather than an empty grid', () => {
  // A blank table reads as "the filter did nothing", which is the one thing the
  // in-place requirement is meant to avoid.
  assert.equal(rowsForTab(ALL, 'nonsense' as never).length, ALL.length);
});

test('exposes exactly the four tabs the brief names', () => {
  assert.deepEqual(SOURCING_TABS.map(t => t.label), ['All', 'Awaiting Quotes', 'Expired', 'Received']);
});

// ─── the post-RFQ governance lifecycle ───────────────────────────────────────
//
// MIGRATION 075 RESTRUCTURED THIS FIXTURE, and the reason is worth stating
// because the old shape asserted something that has stopped being true.
//
// `sourcing_status` used to emit PACK_LOCKED / CS_LOCKED / MC_APPROVED /
// CFO_APPROVED / QUOTES_RECEIVED — five values that are stages of
// proc.purchase_requisitions.status, re-declared inside a CASE in a SELECT
// list. That gave one fact two owners: the ladder in workflow.steps_config, and
// a shadow of it in a query. They had already drifted — a request in Finance
// review rendered in STATUS as "Awaiting Quotes", because its quote deadline
// was still ahead.
//
// So the column now reports sourcing PROGRESS only, and these five are expressed
// the honest way: the same stage names on `status`, plus the one sourcing fact
// they share — that the competition closed.

const GOVERNANCE = [
  row('SOURCING_CLOSED', 0, 'QUOTES_RECEIVED'),
  row('SOURCING_CLOSED', 0, 'CS_LOCKED'),
  row('SOURCING_CLOSED', 0, 'MC_APPROVED'),
  row('SOURCING_CLOSED', 0, 'CFO_APPROVED'),
  row('SOURCING_CLOSED', 0, 'PACK_LOCKED'),
];

test('settled work never reaches Awaiting Quotes, and only QUOTES_RECEIVED reaches Received', () => {
  // Awaiting Quotes is for RFQs still short of responses — none of these are.
  assert.deepEqual(rowsForTab(GOVERNANCE, 'awaiting'), []);
  // Received carries QUOTES_RECEIVED only. The four LATER states would bury the
  // PRs this tab exists to surface under 135 awarded documents.
  assert.deepEqual(statusOf(rowsForTab(GOVERNANCE, 'received')), ['SOURCING_CLOSED']);
  assert.equal(rowsForTab(GOVERNANCE, 'all').length, 5);
});

test('Received includes QUOTES_RECEIVED', () => {
  // Unlike the four later states, this one IS the moment quotes land — it is the
  // state a buyer watches, so it belongs in the tab. Note WHERE it is read from:
  // the request's real stage, not a column that shadows the stage. If those two
  // ever disagree again this tab empties silently, with no error anywhere.
  assert.equal(
    rowsForTab(GOVERNANCE, 'received').filter(r => r.status === 'QUOTES_RECEIVED').length,
    1,
  );
  assert.deepEqual(
    rowsForTab(GOVERNANCE, 'received').map(r => r.status),
    ['QUOTES_RECEIVED'],
    'the four later governance stages must stay OUT of Received',
  );
});

test('the Expired rule still catches settled PRs with a silent vendor', () => {
  // THE fraud check. A PR that has been awarded is precisely where a vendor who
  // never answered matters most, so the status-independence of this predicate
  // has to survive the new statuses — otherwise the split would have quietly
  // narrowed the fraud review to in-flight PRs only.
  const awardedWithSilent = [
    row('SOURCING_CLOSED', 3, 'PACK_LOCKED'),
    row('SOURCING_CLOSED', 1, 'CS_LOCKED'),
  ];
  assert.equal(rowsForTab(awardedWithSilent, 'expired').length, 2);
});

test('a settled PR with no silent vendor never reaches Expired', () => {
  assert.equal(rowsForTab(GOVERNANCE, 'expired').length, 0);
});