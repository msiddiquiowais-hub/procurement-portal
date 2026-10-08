// `acknowledge` screen smoke — schema, API and the emailed deep link.
//
//   node scripts/e2e_ack.mjs
//
// Requires: Postgres on 55432, the API on 33001, and migration 021 applied.
//
// The load-bearing property is that accepting works WITHOUT a session: the
// prototype emails a `#ack=<token>` link that is followed from a mail client,
// usually logged out. The token is the credential.

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const IT_ITEM = '55555555-5555-5555-5555-555555555503';

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

console.log(`\n=== acknowledge screen smoke against ${API} ===\n`);

// ── setup ─────────────────────────────────────────────────────────────────
const login = await api('/auth/login', { method: 'POST', body: { email: 'requester@pakboxes.pk', password: 'demo' } });
const token = login.data?.token;
if (!token) { console.log('  FAIL  login', login.status, login.data); process.exit(1); }
ok(true, 'login as requester@pakboxes.pk');

const ccs = await api('/lookups/cost-centers', { token });
const costCenterId = ccs.data?.[0]?.id;

const created = await api('/pr', {
  method: 'POST', token,
  body: {
    scope: 'Ack smoke', expenseType: 'OPEX', costCenterId,
    requiredByDate: '2026-12-31', title: 'Acknowledge probe',
    lines: [{ itemId: IT_ITEM, quantity: 1, uom: 'EA', unitPriceEst: 250_000 }],
  },
});
ok(Boolean(created.data?.id), 'PR created', created.data);
const prId = created.data.id;

// ── 1 · tag approvers ─────────────────────────────────────────────────────
console.log('\n--- tagging ---');
const tag = await api(`/pr/${prId}/acknowledgements`, {
  method: 'POST', token,
  body: {
    approvers: [
      { taggedRole: 'employee',   name: 'Owais Siddiqui',       email: 'owais.siddiqui@pakboxes.pk' },
      { taggedRole: 'dept_head',  name: 'Aamir Hussain (HOD)', email: 'aamir.hussain@pakboxes.pk',  deptCode: 'DEP-IT' },
      { taggedRole: 'director',   name: 'Saad Iqbal',          email: 'saad.iqbal@pakboxes.pk' },
    ],
  },
});
ok([200, 201].includes(tag.status), 'POST /pr/:id/acknowledgements 2xx', { status: tag.status, data: tag.data });
ok(tag.data?.rows?.length === 3, '3 approvers tagged', tag.data?.rows?.length);
const rows = tag.data?.rows || [];
ok(rows.every(r => typeof r.token === 'string' && r.token.startsWith('ack-')),
  'every approver got an ack- token', rows.map(r => r.token));
ok(new Set(rows.map(r => r.token)).size === 3, 'tokens are unique per approver');
ok(rows.every(r => r.acknowledged === false), 'all start unacknowledged');
ok(rows.every(r => r.acknowledged_at === null), 'unacknowledged rows have no timestamp');

// ── 2 · validation ────────────────────────────────────────────────────────
console.log('\n--- validation ---');
const badRole = await api(`/pr/${prId}/acknowledgements`, {
  method: 'POST', token,
  body: { approvers: [{ taggedRole: 'wizard', name: 'X', email: 'x@pakboxes.pk' }] },
});
ok(badRole.status === 400, 'unknown taggedRole rejected with 400', badRole.status);
const badEmail = await api(`/pr/${prId}/acknowledgements`, {
  method: 'POST', token,
  body: { approvers: [{ taggedRole: 'employee', name: 'X', email: 'not-an-email' }] },
});
ok(badEmail.status === 400, 'invalid email rejected with 400', badEmail.status);
const empty = await api(`/pr/${prId}/acknowledgements`, { method: 'POST', token, body: { approvers: [] } });
ok(empty.status === 400, 'empty approver list rejected with 400', empty.status);

// ── 3 · idempotent re-tag ─────────────────────────────────────────────────
console.log('\n--- re-tag is an upsert, not a reset ---');
const beforeTag = rows.find(r => r.email === 'owais.siddiqui@pakboxes.pk');
const accept1 = await api(`/ack/${beforeTag.token}/accept`, { method: 'POST' });
ok([200, 201].includes(accept1.status), 'accept by token (no session) 2xx', accept1.status);
ok(Boolean(accept1.data?.acknowledged_at), 'accept records a timestamp', accept1.data);

const retag = await api(`/pr/${prId}/acknowledgements`, {
  method: 'POST', token,
  body: { approvers: [{ taggedRole: 'employee', name: 'Owais Siddiqui', email: 'owais.siddiqui@pakboxes.pk' }] },
});
ok(retag.data?.rows?.length === 1, 're-tag returns 1 row (upsert, not duplicate)', retag.data?.rows?.length);
ok(retag.data?.rows?.[0]?.acknowledged === true,
  're-tag did NOT reset the acknowledgement', retag.data?.rows?.[0]);
ok(retag.data?.rows?.[0]?.token === beforeTag.token, 're-tag preserved the original token');

// ── 4 · the deep link: unauthenticated accept ─────────────────────────────
console.log('\n--- deep link accept (no Authorization header) ---');
const hodToken = rows.find(r => r.tagged_role === 'dept_head').token;
const noAuth = await api(`/ack/${hodToken}/accept`, { method: 'POST' });
ok([200, 201].includes(noAuth.status), 'accept works with no session', noAuth.status);
ok(noAuth.data?.pr_number === created.data.prNumber, 'accept returns the PR number', noAuth.data);
ok(noAuth.data?.display_name === 'Aamir Hussain (HOD)', 'accept returns the approver name', noAuth.data?.display_name);
ok(Boolean(noAuth.data?.acknowledged_at), 'accept returns the recorded timestamp');

const again = await api(`/ack/${hodToken}/accept`, { method: 'POST' });
ok([200, 201].includes(again.status), 're-accepting the same link is idempotent (2xx, not 4xx)', again.status);
ok(again.data?.acknowledged_at === noAuth.data?.acknowledged_at,
  're-accept reports the ORIGINAL timestamp', { first: noAuth.data?.acknowledged_at, second: again.data?.acknowledged_at });

const bogus = await api('/ack/ack-deadbeefcafe/accept', { method: 'POST' });
ok(bogus.status === 404 || bogus.status === 400, 'invalid token rejected', bogus.status);

// ── 5 · resolve (banner) ──────────────────────────────────────────────────
console.log('\n--- token resolve ---');
const resolved = await api(`/ack/resolve/${hodToken}`);
ok([200, 201].includes(resolved.status), 'GET /ack/resolve/:token 200', resolved.status);
ok(resolved.data?.approver?.name === 'Aamir Hussain (HOD)', 'resolve returns the approver', resolved.data?.approver);
ok(resolved.data?.approver?.acknowledged === true, 'resolve reports acknowledged state', resolved.data?.approver);
ok(resolved.data?.approver?.pr_number === created.data.prNumber, 'resolve returns the PR number', resolved.data?.approver);

// ── 6 · per-PR list + inbox ───────────────────────────────────────────────
console.log('\n--- lists ---');
const perPr = await api(`/pr/${prId}/acknowledgements`, { token });
ok([200, 201].includes(perPr.status), 'GET /pr/:id/acknowledgements 200', perPr.status);
ok(perPr.data?.rows?.length === 3, 'per-PR list has 3 rows', perPr.data?.rows?.length);
ok(perPr.data?.rows?.filter(r => r.acknowledged).length === 2, '2 of 3 acknowledged', perPr.data?.rows?.filter(r => r.acknowledged).length);
// Pending sort first
ok(perPr.data?.rows?.[0]?.acknowledged === false, 'pending approvers sort first', perPr.data?.rows?.[0]);

const inbox = await api('/ack', { token });
ok([200, 201].includes(inbox.status), 'GET /ack 200', inbox.status);
ok(Array.isArray(inbox.data?.requests), 'inbox returns requests[]');
const mine = (inbox.data?.requests || []).find(r => r.pr_id === prId);
ok(Boolean(mine), 'this PR appears in the inbox');
ok(mine?.total === 3 && mine?.pending === 1 && mine?.acked === 2,
  'inbox counters reconcile (3 total / 1 pending / 2 acked)', { total: mine?.total, pending: mine?.pending, acked: mine?.acked });
// The prototype's ackSummaryChip() vocabulary, verbatim.
ok(mine?.summary?.tone === 'pending' && /^1 of 3 pending acknowledgement$/.test(mine?.summary?.label || ''),
  'summary chip matches the prototype copy', mine?.summary);
ok(typeof mine?.estimated_amount === 'number', 'inbox amount is numeric', mine?.estimated_amount);
ok(typeof inbox.data?.totalPending === 'number', 'inbox carries totalPending', inbox.data?.totalPending);

// ── 7 · soft gate: the workflow is untouched ──────────────────────────────
console.log('\n--- soft gate ---');
const after = await api(`/pr/${prId}`, { token });
// IN_HOD_REVIEW, not 'Submitted': a submitted PR is auto-routed into the HOD's
// stage. What this gate actually checks is that ACKNOWLEDGEMENTS left the stage
// alone, so it compares against the stage the PR was created into.
ok(after.data?.status === 'IN_HOD_REVIEW', 'PR status unchanged by acknowledgements', after.data?.status);
const adv = await api(`/pr/${prId}/advance`, {
  method: 'POST', token: login.data.token,
  body: { lineDecisions: { 0: 'approved' }, reason: 'ack smoke' },
});
ok([200, 201].includes(adv.status), 'PR still advances normally', adv.status);
ok(adv.data?.nextStage === 'IN_IT_REVIEW' || adv.data?.split === true,
  'ack did not interfere with routing', { next: adv.data?.nextStage, split: adv.data?.split });

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
