// End-to-end proof of B1 (line routing / PR auto-split) against the live API.
//
//   node scripts/e2e_line_split.mjs
//
// Requires: Postgres on 55432 and the API on 33001.
//
// Flow: login -> create a PR with a high-value IT line AND a warehouse
// accessory line -> advance it as the HOD -> assert the PR split into two
// children, one routed to IN_IT_REVIEW (IT Manager) and one to IN_WAREHOUSE
// (Store In-charge), with the parent parked and its split metadata recorded.

const API = process.env.API_BASE || 'http://127.0.0.1:33001';

const IT_ITEM   = '55555555-5555-5555-5555-555555555503'; // Dell Latitude 5550 Laptop  (IT_HARDWARE)
const ACC_ITEM  = '55555555-5555-5555-5555-555555555501'; // Cardboard Sheet (large)   (WAREHOUSE_ACCESSORY)
const SERVICES_ITEM = '55555555-5555-5555-5555-555555555506'; // Maintenance Contract  (SERVICES — matches no rule)

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? '  -> ' + JSON.stringify(extra) : ''}`); }
};

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

console.log(`\n=== B1 line-routing split — end-to-end against ${API} ===\n`);

// ── 1 · login ─────────────────────────────────────────────────────────────
const login = await api('/auth/login', {
  method: 'POST',
  body: { email: 'requester@pakboxes.pk', password: 'demo' },
});
if (![200, 201].includes(login.status) || !login.data?.token) {
  console.log('  FAIL  login', login.status, login.data);
  process.exit(1);
}
const token = login.data.token;
console.log('  PASS  login as requester@pakboxes.pk\n');

// ── 2 · lookups ───────────────────────────────────────────────────────────
const ccs = await api('/lookups/cost-centers', { token });
const costCenterId = ccs.data?.[0]?.id;
ok(Boolean(costCenterId), 'cost center resolved', ccs.data);

// ── 3 · create a mixed PR (2 lines that route to different destinations) ───
const created = await api('/pr', {
  method: 'POST',
  token,
  body: {
    scope: 'Wave 0 B1 verification',
    expenseType: 'OPEX',
    costCenterId,
    requiredByDate: '2026-12-31',
    urgency: 'routine',
    title: 'E2E split probe',
    purpose: 'IT refresh + warehouse consumables',
    lines: [
      { itemId: IT_ITEM,  quantity: 2, uom: 'EA', unitPriceEst: 150_000 }, // 300,000 > 100,000 -> IN_IT_REVIEW
      { itemId: ACC_ITEM, quantity: 5, uom: 'EA', unitPriceEst: 1_000 },   //   5,000           -> IN_WAREHOUSE
    ],
  },
});
ok(created.status === 201 || created.status === 200, 'PR created', created.data);
// Submit AUTO-ROUTES into the HOD's stage, the way the prototype does
// (lightTransition to IN_HOD_REVIEW right after building the PR). It used to
// stop at 'Submitted', which is why the HOD had nothing to act on and the line
// rules below — which live on the hod_review step — could never be reached.
ok(created.data?.status === 'IN_HOD_REVIEW', 'PR auto-routes to IN_HOD_REVIEW on submit', created.data?.status);
const prId = created.data?.id;
if (!prId) { console.log('\n  aborting — no PR id'); process.exit(1); }
console.log(`        ${created.data.prNumber}  total=${created.data.estimatedAmount}\n`);

// ── 4 · advance as the HOD ────────────────────────────────────────────────
const advanced = await api(`/pr/${prId}/advance`, {
  method: 'POST',
  token,
  body: { reason: 'E2E: HOD approves all lines' },
});
ok(advanced.status === 200 || advanced.status === 201, 'advance accepted', advanced.data);
ok(advanced.data?.split === true, 'plan returned a SPLIT', advanced.data);
ok(advanced.data?.matchedStep === 'hod_review', 'matched hod_review', advanced.data?.matchedStep);

const children = advanced.data?.children || [];
ok(children.length === 2, 'exactly 2 children created', children.length);

// ── 5 · each child landed on the right stage with the right lines ─────────
const byRoute = Object.fromEntries(children.map(c => [c.routeTo, c]));
ok(Boolean(byRoute.IN_IT_REVIEW), 'a child routed to IN_IT_REVIEW (IT Manager)');
ok(Boolean(byRoute.IN_WAREHOUSE), 'a child routed to IN_WAREHOUSE (Store In-charge)');

const it = byRoute.IN_IT_REVIEW;
const wh = byRoute.IN_WAREHOUSE;
ok(it?.actorRole === 'it_manager', 'IT child actorRole = it_manager', it?.actorRole);
ok(wh?.actorRole === 'store_incharge', 'warehouse child actorRole = store_incharge', wh?.actorRole);
ok(it?.lineNumbers?.join() === '1', 'IT child carries line 1', it?.lineNumbers);
ok(wh?.lineNumbers?.join() === '2', 'warehouse child carries line 2', wh?.lineNumbers);
ok(it?.totalAmount === 300_000, 'IT child total = 300,000', it?.totalAmount);
ok(wh?.totalAmount === 5_000, 'warehouse child total = 5,000', wh?.totalAmount);
ok(it?.prNumber && wh?.prNumber, 'both children got their own PR numbers');
ok(it?.prNumber !== wh?.prNumber, 'child PR numbers are distinct');

console.log('\n--- children ---');
for (const c of children) {
  console.log(`  ${c.prNumber}  ${c.routeTo.padEnd(20)} ${c.actorRole.padEnd(16)} lines=[${c.lineNumbers}]  PKR ${c.totalAmount.toLocaleString()}`);
}

// ── 6 · parent parked with split metadata ─────────────────────────────────
const parent = await api(`/pr/${prId}`, { token });
ok(parent.data?.status === 'IN_PROCUREMENT_REVIEW', 'parent parked at IN_PROCUREMENT_REVIEW', parent.data?.status);
// `split` is a jsonb column; the API's CSV-mode DB bridge hands it back as a
// JSON *string* rather than an object, so normalise before asserting.
const splitMeta = typeof parent.data?.split === 'string'
  ? JSON.parse(parent.data.split) : parent.data?.split;
ok(splitMeta?.children?.length === 2, 'parent.split records both children', splitMeta);
ok(Boolean(parent.data?.children?.length === 2), 'GET /pr/:id surfaces both children', parent.data?.children?.length);
ok(parent.data?.lines?.length === 2, 'parent still shows its 2 original lines', parent.data?.lines?.length);

// ── 7 · each child is independently retrievable with its own subset ───────
for (const c of children) {
  const d = await api(`/pr/${c.id}`, { token });
  ok(d.data?.status === c.routeTo, `child ${c.prNumber} persisted at ${c.routeTo}`, d.data?.status);
  ok(d.data?.lines?.length === 1, `child ${c.prNumber} has exactly 1 line`, d.data?.lines?.length);
  ok(d.data?.parent_pr_id === prId, `child ${c.prNumber} links to its parent via parent_pr_id`);
}

// ── 8 · single-destination PR must NOT split ──────────────────────────────
// Two HIGH-VALUE IT lines: rule 0 catches both, so they agree on one
// destination and the whole PR routes to IN_IT_REVIEW.
// (Note: an IT line + an OFFICE_SUPPLIES line would NOT be a single-destination
// case — rule 2 sends the office line to IN_WAREHOUSE, so that is a 2-way split.)
const single = await api('/pr', {
  method: 'POST',
  token,
  body: {
    scope: 'Wave 0 B1 control', expenseType: 'OPEX', costCenterId,
    requiredByDate: '2026-12-31',
    lines: [
      { itemId: IT_ITEM, quantity: 1, uom: 'EA', unitPriceEst: 250_000 },
      { itemId: IT_ITEM, quantity: 1, uom: 'EA', unitPriceEst: 150_000 },
    ],
  },
});
const singleAdv = await api(`/pr/${single.data.id}/advance`, {
  method: 'POST', token, body: { reason: 'E2E: single-destination control' },
});
ok(singleAdv.data?.split !== true, 'two high-value IT lines do not split', singleAdv.data);
ok(singleAdv.data?.nextStage === 'IN_IT_REVIEW', 'both-IT PR routes whole to IN_IT_REVIEW', singleAdv.data?.nextStage);
ok(singleAdv.data?.lineRoutingApplied === true, 'lineRoutingApplied flag set', singleAdv.data?.lineRoutingApplied);

// ── 9 · lines matching NO rule fall through to the step default ───────────
// SERVICES matches none of the three hod_review line rules.
const fallthrough = await api('/pr', {
  method: 'POST', token,
  body: {
    scope: 'Wave 0 B1 fallthrough', expenseType: 'OPEX', costCenterId,
    requiredByDate: '2026-12-31',
    lines: [
      { itemId: SERVICES_ITEM, quantity: 1, uom: 'EA', unitPriceEst: 40_000 },
    ],
  },
});
const ftAdv = await api(`/pr/${fallthrough.data.id}/advance`, { method: 'POST', token, body: {} });
ok(ftAdv.data?.split !== true, 'unmatched line does not split', ftAdv.data);
ok(ftAdv.data?.nextStage === 'IN_PROCUREMENT_REVIEW', 'unmatched line falls through to the step default', ftAdv.data?.nextStage);
ok(ftAdv.data?.lineRoutingApplied === false, 'lineRoutingApplied false on fallthrough', ftAdv.data?.lineRoutingApplied);

// ── 10 · rejected lines must not be routed ────────────────────────────────
const rej = await api('/pr', {
  method: 'POST', token,
  body: {
    scope: 'Wave 0 B1 rejected-line', expenseType: 'OPEX', costCenterId,
    requiredByDate: '2026-12-31',
    lines: [
      { itemId: IT_ITEM,  quantity: 1, uom: 'EA', unitPriceEst: 250_000 },
      { itemId: ACC_ITEM, quantity: 1, uom: 'EA', unitPriceEst: 1_000 },
    ],
  },
});
const rejAdv = await api(`/pr/${rej.data.id}/advance`, {
  method: 'POST', token,
  body: { lineDecisions: { 0: 'approved', 1: 'rejected' }, reason: 'E2E: warehouse line rejected' },
});
ok(rejAdv.data?.split !== true, 'rejecting the warehouse line prevents a split', rejAdv.data);
ok(rejAdv.data?.nextStage === 'IN_IT_REVIEW', 'only the approved IT line is routed', rejAdv.data?.nextStage);

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
