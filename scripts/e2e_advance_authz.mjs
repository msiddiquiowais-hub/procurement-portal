// e2e_advance_authz.mjs — regression guard for the HOD-gate authorization fix.
//
// WHAT THIS PREVENTS
// ------------------
// `advance()` used to accept any authenticated caller. A requester could approve
// their own PR out of IN_HOD_REVIEW: the gate fired `hod_review`, the status moved
// to IN_PROCUREMENT_REVIEW, and the audit row named the REQUESTER as the actor.
// 173 such self-approvals exist on this estate as a result.
//
// Three properties are asserted, and the third is the one that is easy to get
// wrong: a REFUSED advance must not leave half a decision behind. The per-line
// disposition used to be written before any check existed, so a caller who was
// about to be 403'd had already rewritten the PR's lines.

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
const login = async (email) => (await api('/auth/login', { method: 'POST', body: { email, password: 'demo' } })).data?.token;

console.log(`\n=== advance() authorization against ${API} ===\n`);

const requester = await login('requester@pakboxes.pk');
const hod = await login('hod.sales@pakboxes.pk');
const admin = await login('admin@pakboxes.pk');
ok(requester && hod && admin, 'all three sessions logged in');

const ccs = await api('/lookups/cost-centers', { token: requester });
const costCenterId = ccs.data?.[0]?.id;

async function newPr(title) {
  const c = await api('/pr', {
    method: 'POST', token: requester,
    body: {
      scope: 'Authz regression', expenseType: 'OPEX', costCenterId,
      requiredByDate: '2026-12-31', title,
      description: 'advance() authorization fixture',
      lines: [{ itemId: '55555555-5555-5555-5555-555555555503', quantity: 1, uom: 'EA', unitPriceEst: 50_000 }],
    },
  });
  return c.data?.id;
}

// ── 1 · The requester is refused at the HOD gate ─────────────────────────────
const pr1 = await newPr('AUTHZ REFUSED - requester must not approve');
const before1 = await api(`/pr/${pr1}`, { token: hod });
ok(before1.data?.status === 'IN_HOD_REVIEW', 'the PR is sitting in IN_HOD_REVIEW', before1.data?.status);

// Snapshot the lines as they stand BEFORE the refused call. `create()` inserts
// lines with approved = true by design (the requester signs off their own
// request), so asserting a literal false here would be asserting the wrong
// thing. What matters is that the refused call changes NOTHING.
const lineStateBefore = (before1.data?.lines || []).map(
  (l) => `${l.line_no}:${l.approved}/${l.rejected}/${l.held}`).join(',');

const denied = await api(`/pr/${pr1}/advance`, {
  method: 'POST', token: requester,
  body: { lineDecisions: { 0: 'rejected' }, reason: 'self-approve attempt' },
});
ok(denied.status === 403, 'requester advance is REFUSED with 403', denied.status);
ok(/hod/i.test(String(denied.data?.message || '')),
  'the refusal names the role that was required', denied.data?.message);

// ── 2 · The refusal must leave NOTHING behind ────────────────────────────────
// This is the half of the bug that is invisible in a status code alone: the
// per-line disposition is written on the same request, so a naive gate placed
// after that write leaves the PR with its lines already rejected by someone who
// was not allowed to decide anything.
const after1 = await api(`/pr/${pr1}`, { token: hod });
ok(after1.data?.status === 'IN_HOD_REVIEW', 'status unchanged by the refused advance', after1.data?.status);
const lineStateAfter = (after1.data?.lines || []).map(
  (l) => `${l.line_no}:${l.approved}/${l.rejected}/${l.held}`).join(',');
ok(lineStateAfter === lineStateBefore,
  'the refused call wrote no line disposition', { lineStateBefore, lineStateAfter });

// ── 3 · The HOD is allowed, and the same PR then moves ───────────────────────
const allowed = await api(`/pr/${pr1}/advance`, {
  method: 'POST', token: hod,
  body: { lineDecisions: { 0: 'approved' }, reason: 'HOD approves' },
});
ok([200, 201].includes(allowed.status), 'HOD advance is ACCEPTED', allowed.status);
const after2 = await api(`/pr/${pr1}`, { token: hod });
ok(after2.data?.status !== 'IN_HOD_REVIEW', 'the HOD actually moved the PR', after2.data?.status);

// ── 4 · admin keeps working: ROLE_ALIASES expands admin to include hod ───────
const pr2 = await newPr('AUTHZ ADMIN - super-role must still pass');
const byAdmin = await api(`/pr/${pr2}/advance`, {
  method: 'POST', token: admin,
  body: { lineDecisions: { 0: 'approved' }, reason: 'admin acts as HOD' },
});
ok([200, 201].includes(byAdmin.status), 'admin advance is ACCEPTED (admin aliases hod)', byAdmin.status);

// ── 5 · The reject gate is still reachable ───────────────────────────────────
// `reject` is a `system` step: no session holds that role, so it authorises
// against the owner of the stage the PR is sitting at. If this regressed, a
// rejected line could never be recorded.
const pr3 = await newPr('AUTHZ REJECT - system step must route to the stage owner');
const rejected = await api(`/pr/${pr3}/advance`, {
  method: 'POST', token: hod,
  body: { lineDecisions: { 0: 'rejected' }, reason: 'HOD rejects the line' },
});
ok([200, 201].includes(rejected.status), 'HOD can reject a line (system step reachable)', rejected.status);

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
if (fail > 0) process.exit(1);