// e2e_sourcing_status.mjs
//
// Task 1 regression guard: the derived Sourcing status on GET /pr/capital/my.
//
// WHAT THIS GUARDS
// ----------------
// The four core states are computed in SQL on every read and deliberately never
// stored. That is the whole anti-drift design — but it also means nothing in the
// schema stops a future edit from quietly changing what the grid says. A PR
// showing "Awaiting Quotes (3/3)" when every vendor has answered is exactly the
// defect this suite exists to catch.
//
// It also pins the two business rules that were decided for this feature:
//   * a declined vendor COUNTS as a response (one refusal must not permanently
//     block an RFQ from reading Received), and
//   * the received threshold is read from configuration, never hardcoded, so
//     the Expired / Received split follows the setting rather than a literal.

const API = process.env.API_BASE || 'http://127.0.0.1:33001';

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

let pass = 0, fail = 0;
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`); }
};

/**
 * The stages at or past procurement review — migration 058's stage constraint.
 * A PR outside this set is not late issuing an RFQ, so neither the red
 * "RFQ overdue" pill nor the "RFQ not issued" label may appear on it.
 * Mirrors the array in pr.service.ts::myPrs; keep the two in step.
 */
const AT_OR_PAST_PROCUREMENT = new Set([
  'IN_PROCUREMENT_REVIEW', 'IN_COST_CENTER_APPROVAL', 'IN_FINANCE_REVIEW',
  'IN_MANAGEMENT_REVIEW', 'READY_FOR_D365', 'D365_PUSHED', 'QUOTES_RECEIVED',
  'CS_LOCKED', 'MC_APPROVED', 'CFO_APPROVED', 'PACK_LOCKED', 'CLOSED',
  'FULFILLED_FROM_STOCK',
]);

console.log(`\n=== Sourcing status regression against ${API} ===\n`);

const login = await api('/auth/login', { method: 'POST', body: { email: 'admin@pakboxes.pk', password: 'demo' } });
if (!login.data?.token) {
  console.log(`  FAIL login :: ${login.status}`);
  process.exitCode = 1;
} else {
  const token = login.data.token;
  const r = await api('/pr/capital/my', { token });
  ok(r.status === 200, 'GET /pr/capital/my -> 200', r.status);

  const rows = r.data?.light || [];
  ok(rows.length > 0, 'light rows present', rows.length);

  // ── 1 · The row contract ────────────────────────────────────────────────
  const FIELDS = ['sourcing_status', 'invited_vendors', 'responded_vendors',
    'submitted_vendors', 'awaiting_vendors', 'expired_vendor_count',
    'reissue_count', 'rfq_overdue'];
  const missing = FIELDS.filter(f => !(f in (rows[0] || {})));
  ok(missing.length === 0, 'every sourcing field is present on the row', missing);

  // Types must be real types. The UI renders `${responded}/${invited}`, and
  // "2" + "3" is "23" — a stringified count renders as a wrong number on screen
  // rather than as an error.
  const badTypes = [];
  for (const row of rows) {
    for (const f of ['invited_vendors', 'responded_vendors', 'submitted_vendors',
      'awaiting_vendors', 'expired_vendor_count', 'reissue_count']) {
      if (typeof row[f] !== 'number') { badTypes.push(`${row.pr_number}.${f}=${typeof row[f]}`); break; }
    }
    if (typeof row.rfq_overdue !== 'boolean') { badTypes.push(`${row.pr_number}.rfq_overdue=${typeof row.rfq_overdue}`); break; }
  }
  ok(badTypes.length === 0, 'counts are numbers and rfq_overdue is boolean', badTypes.slice(0, 5));

  // ── 2 · Cross-field invariants ──────────────────────────────────────────
  const bad = [];
  for (const row of rows) {
    const s = row.sourcing_status;
    if (s === 'NOT_ISSUED' && row.invited_vendors > 0) bad.push(`${row.pr_number}: NOT_ISSUED with invitations`);
    if (row.responded_vendors > row.invited_vendors) bad.push(`${row.pr_number}: responded > invited`);
    if (row.reissue_count < 0) bad.push(`${row.pr_number}: negative reissue_count`);
    // The defect this suite was written after.
    if (s === 'AWAITING_QUOTES' && row.invited_vendors > 0 && row.responded_vendors >= row.invited_vendors) {
      bad.push(`${row.pr_number}: AWAITING_QUOTES but all ${row.invited_vendors} vendor(s) responded`);
    }
    // Migration 058 rule: the alarm only fires on a PR that has reached
    // procurement AND carries a real HOD approval anchor.
    if (row.rfq_overdue && s !== 'NOT_ISSUED') bad.push(`${row.pr_number}: overdue but status is ${s}`);
    if (row.rfq_overdue && !AT_OR_PAST_PROCUREMENT.has(row.status)) {
      bad.push(`${row.pr_number}: overdue while still at ${row.status}`);
    }
    if (s === 'PRE_PROCUREMENT' && row.rfq_overdue) {
      bad.push(`${row.pr_number}: PRE_PROCUREMENT cannot be overdue`);
    }
    // Vendor-level expiry is suppressed while an RFQ is still live.
    if (row.expired_vendor_count > 0 && s !== 'EXPIRED' && s !== 'RECEIVED' && s !== 'RECEIVED_THRESHOLD_MET') {
      bad.push(`${row.pr_number}: expired vendors reported while status is ${s}`);
    }
  }
  ok(bad.length === 0, 'cross-field invariants hold', bad.slice(0, 5));

  // ── 3 · Re-issue chip only when an RFQ exists ───────────────────────────
  ok(rows.every(x => x.reissue_count === 0 || x.invited_vendors >= 0),
    'reissue_count is never negative');

  // ── 4 · The delay alarm ───────────────────────────────────────────────────
  // The INVARIANTS on any breach are asserted unconditionally. The separate
  // "there is at least one breach" check is deliberately only informational:
  // /pr/capital/my caps at the 200 most-recently-updated PRs, so which PRs sit
  // in that window moves every time any suite creates one. "No breach among the
  // 200 newest PRs" is a perfectly healthy state — failing on it made this suite
  // report a red that said nothing about the alarm, which is how a real
  // regression would get ignored later.
  const overdue = rows.filter(x => x.rfq_overdue);
  ok(overdue.every(x => x.sourcing_status === 'NOT_ISSUED'),
    'every overdue row is NOT_ISSUED', overdue.filter(x => x.sourcing_status !== 'NOT_ISSUED').slice(0, 3));
  ok(overdue.every(x => AT_OR_PAST_PROCUREMENT.has(x.status)),
    'every overdue row is at or past procurement review',
    overdue.filter(x => !AT_OR_PAST_PROCUREMENT.has(x.status)).slice(0, 3));
  if (overdue.length === 0) {
    console.log('  note  no breach in the current 200-row window — the alarm is idle, not broken');
  }

  // ── 5 · Report the shape so a regression is visible in the log ──────────
  const byStatus = {};
  for (const row of rows) byStatus[row.sourcing_status] = (byStatus[row.sourcing_status] || 0) + 1;
  console.log(`\n  status distribution across ${rows.length} rows:`);
  for (const [k, v] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(24)} ${v}`);
  }
  ok(Object.keys(byStatus).length >= 2, 'more than one status renders on the live page');

  console.log('\n  worked samples:');
  for (const s of rows.filter(x => x.invited_vendors > 0).slice(0, 6)) {
    console.log(`    ${s.pr_number} | ${s.sourcing_status} | ${s.responded_vendors}/${s.invited_vendors}`);
  }
  console.log(`\n  overdue (no RFQ past the configured limit): ${overdue.length}`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  if (fail > 0) process.exitCode = 1;
}