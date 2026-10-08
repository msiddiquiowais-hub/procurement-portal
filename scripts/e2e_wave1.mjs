// Wave 1 smoke — the four newly-ported screens' backing API.
//
//   node scripts/e2e_wave1.mjs
//
// Requires: Postgres on 55432 and the API on 33001.
//
// Proves the endpoints behind `dashboard`, `light-pr-list`, `approvals` and
// `pr-review` return the shape those screens bind to, including the B1 split
// feeding the approvals queue.

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const IT_ITEM  = '55555555-5555-5555-5555-555555555503';
const ACC_ITEM = '55555555-5555-5555-5555-555555555501';

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

async function loginAs(email) {
  const r = await api('/auth/login', { method: 'POST', body: { email, password: 'demo' } });
  if (!r.data?.token) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}

console.log(`\n=== Wave 1 API smoke against ${API} ===\n`);

// ── setup: create a PR that will split ────────────────────────────────────
const req = await loginAs('requester@pakboxes.pk');
const token = req.token;
const ccs = await api('/lookups/cost-centers', { token });
const costCenterId = ccs.data?.[0]?.id;
ok(Boolean(costCenterId), 'cost center resolved');

const created = await api('/pr', {
  method: 'POST', token,
  body: {
    scope: 'Wave 1 smoke', expenseType: 'OPEX', costCenterId,
    requiredByDate: '2026-12-31', title: 'Wave 1 split probe',
    purpose: 'Verification',
    lines: [
      { itemId: IT_ITEM,  quantity: 2, uom: 'EA', unitPriceEst: 150_000 },
      { itemId: ACC_ITEM, quantity: 5, uom: 'EA', unitPriceEst: 1_000 },
    ],
  },
});
ok(Boolean(created.data?.id), 'PR created', created.data);
const prId = created.data.id;
const prNumber = created.data.prNumber;

// ══ light-pr-list ═══════════════════════════════════════════════════════
console.log('\n--- light-pr-list ---');
const list = await api('/pr/light/list', { token });
ok([200, 201].includes(list.status), 'GET /pr/light/list 200', list.status);
ok(Boolean(list.data?.header), 'payload has a header (KPI band)', Object.keys(list.data || {}));
ok(Array.isArray(list.data?.rows), 'payload has rows');
const h = list.data?.header || {};
ok(typeof h.total === 'number' && typeof h.open === 'number' && typeof h.closed === 'number',
  'header carries total/open/closed counters', h);
ok(h.total === h.open + h.closed, 'counters reconcile (open + closed = total)', h);
ok(typeof h.viewLabel === 'string' && h.viewLabel.length > 0, 'header carries the view label', h.viewLabel);
ok(typeof h.seesAll === 'boolean', 'header carries the seesAll flag', h);
const row = (list.data?.rows || []).find(r => r.id === prId);
ok(Boolean(row), 'the new PR appears in the list');
ok(row?.title === 'Wave 1 split probe', 'row carries the title', row?.title);
ok(row?.item_count === 2, 'row carries item_count', row?.item_count);
ok(row?.items_preview?.length === 2, 'row carries the 2 item previews', row?.items_preview?.length);
ok(typeof row?.estimated_amount === 'number', 'row amount is numeric', row?.estimated_amount);
ok(Boolean(row?.department_name), 'row carries a department name', row?.department_name);
ok(Boolean(row?.last_updated_at), 'row carries last_updated_at for the Updated column');

// ══ approvals ═══════════════════════════════════════════════════════════
console.log('\n--- approvals (requester before HOD action) ---');
const q0 = await api('/pr/approvals/queue', { token });
ok([200, 201].includes(q0.status), 'GET /pr/approvals/queue 200', q0.status);
ok(Array.isArray(q0.data?.rows), 'queue returns rows array');
ok(q0.data?.rows?.length === 0,
  'requester gets an empty queue — the approvals screen is gated to hod,mc,cfo,cs',
  q0.data?.rows?.length);
console.log(`        requester queue depth = ${q0.data?.rows?.length ?? 0}`);

// ══ pr-review + B1 split ═════════════════════════════════════════════════
console.log('\n--- pr-review: HOD decides lines, split fires ---');
const hod = await loginAs('hod.sales@pakboxes.pk');
const detail = await api(`/pr/${prId}`, { token: hod.token });
ok([200, 201].includes(detail.status), 'GET /pr/:id 200 for HOD', detail.status);
ok(Array.isArray(detail.data?.lines) && detail.data.lines.length === 2, 'detail carries 2 lines', detail.data?.lines?.length);
ok(detail.data?.lines?.[0]?.resolved_category === 'IT_HARDWARE', 'line 1 resolved category', detail.data?.lines?.[0]?.resolved_category);
ok(detail.data?.lines?.[1]?.resolved_category === 'WAREHOUSE_ACCESSORY', 'line 2 resolved category', detail.data?.lines?.[1]?.resolved_category);
ok(detail.data?.lines?.[0]?.line_no === 1, 'lines are line_no-ordered', detail.data?.lines?.[0]?.line_no);
ok(Array.isArray(detail.data?.departments), 'detail carries departments[]', detail.data?.departments);
ok(Array.isArray(detail.data?.children), 'detail carries children[]');
ok(detail.data?.requester_name && detail.data?.department_name, 'detail carries requester + department');

const adv = await api(`/pr/${prId}/advance`, {
  method: 'POST', token: hod.token,
  body: { lineDecisions: { 0: 'approved', 1: 'approved' }, reason: 'Wave 1 smoke: both lines approved' },
});
ok(adv.data?.split === true, 'HOD advance split the PR', adv.data);
ok(adv.data?.children?.length === 2, 'two children', adv.data?.children?.length);

// ══ approvals (HOD after) ═══════════════════════════════════════════════
console.log('\n--- approvals (HOD) ---');
const qHod = await api('/pr/approvals/queue', { token: hod.token });
ok([200, 201].includes(qHod.status), 'GET /pr/approvals/queue 200 for HOD', qHod.status);
ok(Array.isArray(qHod.data?.rows), 'HOD queue returns rows');
console.log(`        HOD queue depth = ${qHod.data?.rows?.length ?? 0}`);
if (qHod.data?.rows?.length) {
  const r0 = qHod.data.rows[0];
  ok(typeof r0.stage_owner === 'string', 'queue row carries stage_owner', r0.stage_owner);
  ok(typeof r0.is_split_parent === 'boolean', 'queue row carries is_split_parent', r0.is_split_parent);
  ok('requester_name' in r0 && 'department_name' in r0, 'queue row carries requester + department');
  ok(typeof r0.estimated_amount === 'number', 'queue row amount is numeric', r0.estimated_amount);
}

// Split children land on OWNER-owned stages: IN_IT_REVIEW -> it_manager,
// IN_WAREHOUSE -> store_incharge. Procurement owns neither, so the children
// must NOT appear in the procurement queue; the split PARENT (parked at
// IN_PROCUREMENT_REVIEW, which procurement does own) must.
console.log('\n--- approvals (procurement: parent yes, split children no) ---');
const proc = await loginAs('procurement@pakboxes.pk');
const qProc = await api('/pr/approvals/queue', { token: proc.token });
ok([200, 201].includes(qProc.status), 'GET /pr/approvals/queue 200 for procurement', qProc.status);
const procRows = qProc.data?.rows || [];
const kids = (adv.data?.children || []).map(c => c.id);
ok(!procRows.some(r => kids.includes(r.id)),
  'procurement does NOT see children owned by it_manager / store_incharge', procRows.map(r => r.status));
ok(procRows.some(r => r.id === prId),
  'procurement sees the split parent parked at IN_PROCUREMENT_REVIEW', procRows.map(r => r.status));
ok(procRows.find(r => r.id === prId)?.is_split_parent === true,
  'the parent is flagged is_split_parent in the queue');

// ══ dashboard ═══════════════════════════════════════════════════════════
console.log('\n--- dashboard ---');
const dash = await api('/pr', { token });
ok([200, 201].includes(dash.status), 'GET /pr 200', dash.status);
ok(Array.isArray(dash.data), 'GET /pr returns rows array');
const mineRow = (dash.data || []).find(r => r.id === prId);
ok(Boolean(mineRow), 'split parent still listed for the dashboard activity feed');
ok(Boolean(mineRow?.requester_name), 'dashboard row carries requester_name for scoping');
ok(typeof mineRow?.estimated_amount !== 'undefined', 'dashboard row carries estimated_amount');

// ══ light-pr-detail surface ═════════════════════════════════════════════
console.log('\n--- light-pr-detail (the screen the HOD lands on) ---');
const after = await api(`/pr/${prId}`, { token: hod.token });
const d2 = after.data || {};
ok([200, 201].includes(after.status), 'GET /pr/:id 200 after the split', after.status);
ok(d2.status === 'IN_PROCUREMENT_REVIEW', 'parent parked at IN_PROCUREMENT_REVIEW', d2.status);
ok(d2.split && typeof d2.split === 'object',
  'split jsonb is parsed into an object (not a raw string)', typeof d2.split);
ok(d2.split?.children?.length === 2, 'split.children lists both children', d2.split?.children?.length);
ok(typeof d2.split?.children?.[0]?.reason === 'string',
  'each split child carries its line-rule reason', d2.split?.children?.[0]?.reason);
ok(Array.isArray(d2.children) && d2.children.length === 2, 'children[] surfaces both PRs', d2.children?.length);
ok(typeof d2.estimated_amount !== 'undefined', 'detail carries estimated_amount', d2.estimated_amount);
ok(typeof d2.lines?.[0]?.line_no === 'number', 'line_no is coerced to a number (CSV bridge)', typeof d2.lines?.[0]?.line_no);
ok(typeof d2.lines?.[0]?.quantity === 'number', 'quantity is coerced to a number', typeof d2.lines?.[0]?.quantity);
ok(typeof d2.lines?.[0]?.unit_price_est === 'number', 'unit_price_est is coerced to a number', typeof d2.lines?.[0]?.unit_price_est);
ok(Array.isArray(d2.departments), 'departments[] present for the HOD-rows card', Array.isArray(d2.departments));
ok(Array.isArray(d2.images), 'images[] present for the reference-pictures card', Array.isArray(d2.images));
ok(typeof d2.requester_name === 'string' && typeof d2.department_name === 'string',
  'detail carries requester_name + department_name for the header line');

// status history
const hist = await api(`/pr/${prId}/history`, { token: hod.token });
ok([200, 201].includes(hist.status), 'GET /pr/:id/history 200', hist.status);
ok(Array.isArray(hist.data?.events), 'history returns an events array');
ok((hist.data?.events?.length ?? 0) > 0, 'history is non-empty after create + advance', hist.data?.events?.length);
const ev0 = hist.data?.events?.[0] || {};
ok('ts' in ev0 && 'action' in ev0 && 'actor' in ev0,
  'history event carries ts/action/actor for the status-history card', Object.keys(ev0));

// A split child must expose its own lineage
const childId = (adv.data?.children || [])[0]?.id;
if (childId) {
  const cd = await api(`/pr/${childId}`, { token });
  ok(cd.data?.parent_pr_id === prId, 'child exposes parent_pr_id for the SPLIT CHILD flag', cd.data?.parent_pr_id);
  ok(cd.data?.lines?.length === 1, 'child carries only its own line subset', cd.data?.lines?.length);
  ok(cd.data?.children?.length === 0, 'a child has no children of its own');
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
console.log(`    (split probe: ${prNumber} -> ${(adv.data?.children || []).map(c => `${c.prNumber}@${c.routeTo}`).join(', ')})\n`);
process.exit(fail === 0 ? 0 : 1);
