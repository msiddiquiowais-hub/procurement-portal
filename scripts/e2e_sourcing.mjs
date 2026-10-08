// Wave 2 step 1 — sourcing: RFQ issue + invitations.
//
//   node scripts/e2e_sourcing.mjs
//
// Requires: Postgres on 55432, the API on 33001, migration 024 applied.
//
// Load-bearing properties, all traced to the prototype:
//   1. rfqIssue() is procurement-only and stage-gated.
//   2. It sends to exactly 3 vendors, each with a UNIQUE credential.
//   3. The credential is a bearer token: only sha256(token) is persisted, and
//      the raw token is returned exactly once.
//   4. deadline_at is display-only (decision Q2) but must clear the schema's
//      own >= created_at + 24h floor.
//   5. The roster is editable after issue (POST /rfq/:id/invite), and
//      UNIQUE(rfq_id, vendor_id) makes a double-invite an error, not a no-op.

import { createHash } from 'crypto';
import { execFileSync } from 'child_process';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
// Routing fixture, chosen from DEFAULT_WORKFLOW_STEPS' `hod_review` line rules
// (packages/workflow-engine/src/steps.ts:83-104):
//   IT_HARDWARE over PKR 100,000 -> IN_IT_REVIEW
//   IT_HARDWARE at or under      -> IN_PROCUREMENT_REVIEW   <- we want this
//   OFFICE_SUPPLIES / WAREHOUSE_ACCESSORY -> IN_WAREHOUSE
const LAPTOP = '55555555-5555-5555-5555-555555555503'; // PKB-LT-001, IT_HARDWARE
const PEN = '55555555-5555-5555-5555-555555555505';    // PKB-PEN-001, OFFICE_SUPPLIES -> IN_WAREHOUSE
const LAPTOP_PRICE = 50_000;                            // under the 100,000 IT ceiling

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
  if (c) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''}`); }
};

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

/** Read-only DB probe so the suite can prove what the API did NOT persist. */
function psql(sql) {
  return execFileSync('docker', ['exec', '-i', 'procurement-portal-db', 'psql',
    '-U', 'proc', '-d', 'procurementDB', '-q', '-t', '-A', '-F', '|', '-f', '-'],
    { input: sql, encoding: 'utf8' }).trim();
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

console.log(`\n=== Wave 2 step 1 · RFQ issue + invitations against ${API} ===\n`);

const login = async (email) => {
  const r = await api('/auth/login', { method: 'POST', body: { email, password: 'demo' } });
  return r.data?.token;
};

const requester = await login('requester@pakboxes.pk');
const hod = await login('hod.sales@pakboxes.pk');
const procurement = await login('procurement@pakboxes.pk');
const cs = await login('cs@pakboxes.pk');
const admin = await login('admin@pakboxes.pk');
ok(Boolean(requester && hod && procurement && cs && admin), 'all five logins returned a token');

// ── 1 · build a PR that reaches procurement review ─────────────────────────
console.log('\n--- fixture: a PR in IN_PROCUREMENT_REVIEW ---');

const ccs = await api('/lookups/cost-centers', { token: requester });
const costCenterId = ccs.data?.[0]?.id;

const created = await api('/pr', {
  method: 'POST', token: requester,
  body: {
    scope: 'Sourcing step-1 fixture',
    expenseType: 'OPEX',
    costCenterId,
    requiredByDate: '2026-12-31',
    title: 'Laptop for the Lahore office',
    description: 'Three vendors to be invited for quotation.',
    lines: [{ itemId: LAPTOP, quantity: 1, uom: 'EA', unitPriceEst: LAPTOP_PRICE }],
  },
});
ok([200, 201].includes(created.status), 'light PR created', created.status);
const prId = created.data?.id;
ok(Boolean(prId), 'PR id returned', created.data);

const advanced = await api(`/pr/${prId}/advance`, {
  method: 'POST', token: hod,
  body: { lineDecisions: { 0: 'approved' }, reason: 'step 1: HOD approved' },
});
const landed = advanced.data?.nextStage || advanced.data?.stage || advanced.data?.status;
ok(landed === 'IN_PROCUREMENT_REVIEW',
  'PR reached IN_PROCUREMENT_REVIEW (the port\'s HOD_APPROVED)', { landed, body: advanced.data });

// ── 2 · the prototype's two gates ───────────────────────────────────────────
console.log('\n--- gates: procurement only, correct stage only ---');

const asRequester = await api(`/pr/${prId}/rfq`, { method: 'POST', token: requester, body: {} });
ok(asRequester.status === 403, 'requester cannot issue an RFQ', { status: asRequester.status });
ok(/Only Procurement/i.test(asRequester.data?.message || ''),
  "the rejection carries rfqIssue()'s own words", asRequester.data?.message);

const draftPr = await api('/pr', {
  method: 'POST', token: requester,
  body: {
    scope: 'Stage-gate negative', expenseType: 'OPEX', costCenterId,
    requiredByDate: '2026-12-31', title: 'Stage gate probe',
    lines: [{ itemId: PEN, quantity: 40, uom: 'BOX', unitPriceEst: 3500 }],
  },
});
const wrongStage = await api(`/pr/${draftPr.data?.id}/rfq`, { method: 'POST', token: procurement, body: {} });
ok(wrongStage.status === 400, 'RFQ refused for a PR outside procurement review', { status: wrongStage.status });
ok(/not ready for RFQ \(stage:/i.test(wrongStage.data?.message || ''),
  "the refusal carries rfqIssue()'s own words", wrongStage.data?.message);

// ── 3 · issue ──────────────────────────────────────────────────────────────
console.log('\n--- POST /pr/:id/rfq — the issue ---');

const issued = await api(`/pr/${prId}/rfq`, { method: 'POST', token: procurement, body: {} });
ok([200, 201].includes(issued.status), 'RFQ issued', { status: issued.status, msg: issued.data?.message });

const rfqId = issued.data?.rfq?.id;
const invites = issued.data?.invitations || [];
// Everything below reads the issue response. Without an RFQ there is nothing
// left to assert, and the cascade would bury the real failure in a TypeError.
if (!rfqId || !invites.length) {
  console.log('\n  ABORT  the issue produced no RFQ — the remaining assertions cannot run.');
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(1);
}
ok(Boolean(rfqId), 'RFQ id returned');
ok(/^RFQ-\d{4}-\d{6}$/.test(issued.data?.rfq?.rfq_number || ''),
  'rfq_number comes from proc.fn_next_rfq_number() in the 6-digit form migration 026 established',
  issued.data?.rfq?.rfq_number);
ok(invites.length === 3, 'exactly 3 invitations, per rfqIssue() "sent to 3 vendors"', invites.length);
ok(issued.data?.roster_shortfall === 0, 'no roster shortfall — the pool covered all 3', issued.data?.roster_shortfall);
ok(issued.data?.warning === undefined, 'a compliant roster raises no warning', issued.data?.warning);
ok(issued.data?.rfq?.state === 'Open', 'RFQ state is Open', issued.data?.rfq?.state);
ok(Boolean(issued.data?.rfq?.issued_at), 'issued_at is set', issued.data?.rfq?.issued_at);
ok(issued.data?.event?.detail === `${issued.data?.rfq?.rfq_number} sent to 3 vendors`,
  'the event line is rebuilt from real data', issued.data?.event);

// deadline: display-only, but it must clear the schema floor
const dl = Date.parse(issued.data?.rfq?.deadline_at);
const hoursOut = (dl - Date.now()) / 3600000;
ok(Number.isFinite(dl) && hoursOut >= 24,
  'deadline_at is at least +24h (proc.rfq rfq_check floor)', { deadline_at: issued.data?.rfq?.deadline_at, hoursOut });

const tooSoon = await api(`/pr/${prId}/rfq`, { method: 'POST', token: procurement, body: { deadlineAt: new Date(Date.now() + 3600000).toISOString() } });
ok(tooSoon.status === 400, 'a deadline inside the 24h floor is refused', { status: tooSoon.status, msg: tooSoon.data?.message });

// ── 4 · tokens are credentials ──────────────────────────────────────────────
console.log('\n--- invitation tokens ---');

const tokens = invites.map(i => i.token);
ok(tokens.every(t => typeof t === 'string' && t.length >= 32), 'every token is a long opaque string');
ok(new Set(tokens).size === 3, 'all 3 tokens are unique', { tokens: tokens.map(t => t.slice(0, 8)) });
ok(tokens.every(t => /[A-Za-z0-9_-]/.test(t) && !/[+/=]/.test(t)), 'tokens are url-safe base64');
ok(invites.every(i => typeof i.accept_path === 'string' && i.accept_path.includes(i.token)),
  'each invitation carries its accept path');

const stored = psql(`
  SET app.bypass_rls = 'true';
  SELECT i.vendor_id || '|' || i.token_hash
    FROM proc.rfq_invitations i
   WHERE i.rfq_id = '${rfqId}'
   ORDER BY i.invited_at;`).split('\n').filter(Boolean);
ok(stored.length === 3, '3 invitation rows persisted', stored.length);

const storedHashes = stored.map(s => s.split('|')[1]);
ok(stored.every(s => !tokens.includes(s.split('|')[1])),
  'the raw token is never stored verbatim');
ok(storedHashes.every(h => tokens.some(t => sha256(t) === h)),
  'each stored token_hash is exactly sha256(raw token)');
ok(new Set(storedHashes).size === 3, 'stored hashes are unique per vendor');

// GET /rfq/:id must never re-expose a live credential
const detail = await api(`/rfq/${rfqId}`, { token: procurement });
ok(detail.status === 200, 'GET /rfq/:id 200', detail.status);
ok(!JSON.stringify(detail.data).includes(tokens[0]),
  'GET /rfq/:id does not leak any raw token');
ok(detail.data?.roster?.every(r => typeof r.token_prefix === 'string' && r.token_prefix.length === 12),
  'roster shows a 12-char hash prefix for correlation only');

// ── 5 · re-issue is refused, top-up is allowed ──────────────────────────────
console.log('\n--- one RFQ per PR; roster is top-up-able ---');

const reissue = await api(`/pr/${prId}/rfq`, { method: 'POST', token: procurement, body: {} });
ok(reissue.status === 400, 'a second RFQ on the same PR is refused', { status: reissue.status });
ok(/already has an open RFQ/i.test(reissue.data?.message || ''), 'the refusal points at POST /rfq/:id/invite');

const fourth = await api(`/rfq/${rfqId}/invite`, {
  method: 'POST', token: procurement, body: { vendorId: invites[0].vendor_id },
});
ok(fourth.status === 400, 're-inviting a vendor already on the roster is refused (UNIQUE)', { status: fourth.status, msg: fourth.data?.message });
ok(/already on this RFQ/i.test(fourth.data?.message || ''), 'the duplicate-invite message names the cause');

// Q3: a vendor OFF the APPROVED roster is badged "Pending approval", not hidden
// and not blocked. GET /vendors returns { kpis, rows } as of W5-D.
//
// WHAT CHANGED IN W5-D, AND WHY THE FIXTURE MOVED. A High composite is now an
// outright bar on new invitations (blueprint 9.5). The seed has six vendors: one
// is a deliberate blacklist row, two are graded High, so only three are
// invitable — and the pool invites exactly three. That means there is no longer
// a vendor left OFF the roster to top up with.
//
// The Q3 claim is about ROSTER STATE, not about topping up, so it is now asserted
// against the pending vendor the pool itself invited: V-00086 (Manager_Approved)
// is on the roster, is NOT on the approved roster, and must still badge normally.
// That is a stronger test than the old one — it proves the badge survives for a
// vendor the system chose, not only for one a buyer hand-picked.
const vendorList = await api('/vendors', { token: procurement });
const vendors = vendorList.data?.rows ?? [];
const onRoster = invites.map(i => i.vendor_id);
const pending = vendors.find(
  v => !['Active', 'Approved'].includes(v.state) && v.composite?.blocked !== true);
ok(Boolean(pending), 'the seed has an invitable vendor off the APPROVED roster',
  vendors.map(v => `${v.vendorCode}:${v.state}:blocked=${v.composite?.blocked}`).join(', '));
if (pending) {
  if (!onRoster.includes(pending.id)) {
    // Only possible when the pool is not saturated; keep the original invite path
    // covered if the seed ever grows another invitable vendor.
    const add = await api(`/rfq/${rfqId}/invite`, { method: 'POST', token: procurement, body: { vendorId: pending.id } });
    ok(add.status === 201 || add.status === 200, 'a pending-roster vendor can be invited (Q3)', { status: add.status, msg: add.data?.message });
    ok(add.data?.on_approved_roster === false, 'the response flags the vendor as off-roster', add.data?.on_approved_roster);
    ok(typeof add.data?.token === 'string' && add.data.token.length >= 32, 'the off-roster invitee still gets a real token');
  } else {
    ok('the pool invited the pending-roster vendor unprompted', pending.vendorCode);
  }

  // and the roster card badges it rather than hiding it
  const after = await api(`/rfq/${rfqId}`, { token: procurement });
  const added = after.data?.roster?.find(r => r.vendor_id === pending.id);
  ok(added?.pending_approval === true, 'the roster row carries pending_approval = true', added);
  ok(added?.on_approved_roster === false, 'the roster row records it as off-roster', added);
  ok(added?.badge?.label === 'Awaiting quote', 'an off-roster vendor still gets a normal status badge', added?.badge);
  ok(after.data?.roster_tally?.total === after.data?.roster?.length, 'the tally counts every rostered vendor', after.data?.roster_tally);
}

// ── W5-D: the High-risk vendors are refused, and the pool skipped them ────────
{
  const blocked = vendors.filter(v => v.composite?.blocked === true);
  ok(blocked.length > 0, 'the seed contains a High-risk vendor to refuse', blocked.map(v => v.vendorCode).join(', '));
  const first = blocked[0];
  if (first) {
    const refused = await api(`/rfq/${rfqId}/invite`, { method: 'POST', token: procurement, body: { vendorId: first.id } });
    ok(refused.status === 400, 'a High-risk vendor cannot be invited to a new RFQ', { status: refused.status });
    ok(/blocked pending remediation/i.test(refused.data?.message || ''),
      'and the refusal names the remediation state', refused.data?.message);
  }
  const rostered = new Set(onRoster);
  ok(blocked.every(v => !rostered.has(v.id)),
    'the automatic pool never reached for a High-risk vendor',
    blocked.filter(v => rostered.has(v.id)).map(v => v.vendorCode).join(', ') || 'none on the roster');
}

const asRequesterInvite = await api(`/rfq/${rfqId}/invite`, { method: 'POST', token: requester, body: { vendorId: invites[0].vendor_id } });
ok(asRequesterInvite.status === 403, 'requester cannot invite vendors', { status: asRequesterInvite.status });

const singleSourceNoReason = await api(`/pr/${draftPr.data?.id}/rfq`, {
  method: 'POST', token: procurement, body: { singleSource: true },
});
ok(singleSourceNoReason.status === 400, 'single-source without a justification is refused', { status: singleSourceNoReason.status });

// ── 6 · the roster card, as the prototype reads it ─────────────────────────
console.log('\n--- GET /rfq/:id — the _lightRosterCard shape ---');

const detail2 = await api(`/rfq/${rfqId}`, { token: procurement });
ok(detail2.data?.rfq?.rfq_number === issued.data?.rfq?.rfq_number, 'rfq-detail echoes the RFQ');
ok(Array.isArray(detail2.data?.roster) && detail2.data.roster.length >= 3, 'roster carries every invitee', detail2.data?.roster?.length);
ok(detail2.data?.roster?.every(r => r.badge.label === 'Awaiting quote'),
  'with no quotes in yet, every badge reads "Awaiting quote"',
  detail2.data?.roster?.map(r => r.badge?.label));
ok(detail2.data?.roster?.every(r => Boolean(r.issued_at)),
  'per-vendor "RFQ issued at" is populated for the roster card');
ok(detail2.data?.roster_tally?.text === `${detail2.data?.roster_tally?.received} of ${detail2.data?.roster?.length} quotes received - ${detail2.data?.roster_tally?.pending} pending`,
  'the roster tally is the prototype\'s own sentence', detail2.data?.roster_tally);
ok(detail2.data?.roster?.every(r => Array.isArray(r.versions)),
  'each roster row carries a versions[] chain for the Versions Panel');

// Q2 — no waiting period. The roster is readable the instant the RFQ is issued.
ok(detail2.status === 200, 'Q2: the RFQ is readable immediately, no timer, no open_at gate');

// ── 7 · rfq-list, with the prototype's rollups ──────────────────────────────
console.log('\n--- GET /rfq — the rfq-list KPIs and gates ---');

const list = await api('/rfq', { token: procurement });
ok(list.status === 200, 'GET /rfq 200 for procurement', list.status);
ok(Array.isArray(list.data?.rows), 'rows[] returned');
const row = (list.data?.rows || []).find(r => r.id === rfqId);
ok(Boolean(row), 'the issued RFQ appears in the list');
ok(row?.status === 'Awaiting quotes' && row?.pill === 'draft',
  "the row carries the prototype's own label + pill", { status: row?.status, pill: row?.pill });
// The roster grew to 4 earlier via the Q3 top-up, so reconcile against the
// live roster rather than the original 3.
const rosterLen = detail2.data?.roster?.length;
ok(row?.quotes === 0, 'no quotes yet, so the quote count is 0', row?.quotes);
ok(row?.invited === rosterLen,
  'the list row\'s invited count reconciles with the roster (3 issued + 1 top-up)', { invited: row?.invited, rosterLen });
ok(row?.lowest_bid === null, 'lowest bid is null, never a fabricated 0', row?.lowest_bid);

const k = list.data?.rollups || {};
ok(k.total === list.data.rows.length, 'rollup total reconciles with rows[]', { k: k.total, rows: list.data?.rows?.length });
ok(typeof k.avgQuotes === 'string' && !Number.isNaN(Number(k.avgQuotes)), 'avg quotes/RFQ is a number string', k.avgQuotes);
ok(k.total === 0 || k.open >= 1, 'the just-issued RFQ counts toward Open', k);

const csList = await api('/rfq', { token: cs });
ok(csList.status === 200, 'rfq-list is also reachable by cs (prototype data-roles)', csList.status);
const adminList = await api('/rfq', { token: admin });
ok(adminList.status === 200, 'the admin alias reaches rfq-list', adminList.status);
const reqList = await api('/rfq', { token: requester });
ok(reqList.status === 403, 'rfq-list is refused to a requester', reqList.status);

const notFound = await api('/rfq/00000000-0000-0000-0000-000000000000', { token: procurement });
ok(notFound.status === 404, 'unknown RFQ is a 404', notFound.status);

// ── summary ────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
