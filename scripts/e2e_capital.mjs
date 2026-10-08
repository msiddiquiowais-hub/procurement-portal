// Legacy capital-PR trio smoke — my-prs / pr-create / pr-detail.
//
//   node scripts/e2e_capital.mjs
//
// Requires: Postgres on 55432, the API on 33001, migrations 021 + 022 applied.
//
// The load-bearing properties are the two hard gates from renderPRCreate —
// every line must be classified, and every line must carry all 4 mandatory D365
// dimensions — plus the Capex/Opex split and the derived routing key.

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

const DIMS = { BusinessUnit: 'PakBoxes', Department: 'IT', CostCenter: 'CC-100', Location: 'Lahore HQ' };

console.log(`\n=== capital-PR trio smoke against ${API} ===\n`);

const login = await api('/auth/login', { method: 'POST', body: { email: 'requester@pakboxes.pk', password: 'demo' } });
const token = login.data?.token;
if (!token) { console.log('  FAIL  login', login.status, login.data); process.exit(1); }
ok(true, 'login as requester');

const ccs = await api('/lookups/cost-centers', { token });
const costCenterId = ccs.data?.[0]?.id;
ok(Boolean(costCenterId), 'cost center resolved');

// ── 1 · hard gates ────────────────────────────────────────────────────────
console.log('\n--- hard gates (from renderPRCreate) ---');
const noClass = await api('/pr/capital', {
  method: 'POST', token,
  body: {
    title: 'Gate probe A', costCenterId, expenseType: 'OPEX', requiredByDate: '2026-12-31',
    submit: true,
    lines: [{ itemId: IT_ITEM, quantity: 1, uom: 'EA', unitPriceEst: 1000, financialDimensions: DIMS }],
  },
});
ok(noClass.status === 400, 'unclassified line rejected with 400', { status: noClass.status, msg: noClass.data?.message });

const noDims = await api('/pr/capital', {
  method: 'POST', token,
  body: {
    title: 'Gate probe B', costCenterId, expenseType: 'OPEX', requiredByDate: '2026-12-31',
    submit: true,
    lines: [{ itemId: IT_ITEM, quantity: 1, uom: 'EA', unitPriceEst: 1000, classification: 'OPEX_CONSUMABLE', financialDimensions: { BusinessUnit: 'PakBoxes' } }],
  },
});
ok(noDims.status === 400, 'line missing the 4 mandatory D365 dims rejected with 400', { status: noDims.status, msg: noDims.data?.message });

const noTitle = await api('/pr/capital', {
  method: 'POST', token,
  body: {
    title: '', costCenterId, expenseType: 'OPEX', requiredByDate: '2026-12-31', submit: true,
    lines: [{ itemId: IT_ITEM, quantity: 1, uom: 'EA', unitPriceEst: 1000, classification: 'OPEX_CONSUMABLE', financialDimensions: DIMS }],
  },
});
ok(noTitle.status === 400, 'blank title rejected with 400', noTitle.status);

const badClass = await api('/pr/capital', {
  method: 'POST', token,
  body: {
    title: 'Gate probe D', costCenterId, expenseType: 'OPEX', requiredByDate: '2026-12-31', submit: true,
    lines: [{ itemId: IT_ITEM, quantity: 1, uom: 'EA', unitPriceEst: 1000, classification: 'NOT_A_CLASS', financialDimensions: DIMS }],
  },
});
ok(badClass.status === 400, 'invalid classification rejected by the DTO with 400', badClass.status);

// ── 2 · Capex/Opex split + derived routing ────────────────────────────────
console.log('\n--- Capex/Opex split + deriveRouting ---');
// Capex 1,200,000 (Opex 0) + Opex 30,000 -> MIXED, capex>10M? no.
// capex>0 && opex==0? no (opex!=0) -> STANDARD
const mixed = await api('/pr/capital', {
  method: 'POST', token,
  body: {
    title: 'Mixed Capex/Opex racking + consumables',
    justification: 'Q3 racking expansion with consumable top-up.',
    purpose: 'capacity increase', costCenterId, expenseType: 'MIXED',
    requiredByDate: '2026-12-31', submit: true,
    lines: [
      { itemId: IT_ITEM,  quantity: 1, uom: 'EA', unitPriceEst: 1_200_000, classification: 'CAPEX_ASSET',      glAccount: '1600', remarks: 'Floor-standing rack', financialDimensions: DIMS },
      { itemId: ACC_ITEM, quantity: 1, uom: 'EA', unitPriceEst: 30_000,   classification: 'OPEX_CONSUMABLE',  glAccount: '6100', remarks: 'Fasteners',          financialDimensions: DIMS },
    ],
  },
});
ok([200, 201].includes(mixed.status), 'mixed PR created', { status: mixed.status, data: mixed.data });
const m = mixed.data || {};
ok(m.capexAmount === 1_200_000, 'capexAmount = 1,200,000', m.capexAmount);
ok(m.opexAmount === 30_000, 'opexAmount = 30,000', m.opexAmount);
ok(m.estimatedAmount === 1_230_000, 'estimatedAmount = 1,230,000', m.estimatedAmount);
ok(m.status === 'Submitted', 'submit=true lands at Submitted', m.status);
ok(m.routingKey === 'STANDARD', 'mixed capex+opex routes STANDARD', m.routingKey);

// Capex <= 250k, opex 0 -> FAST_TRACK "HOD + Procurement only"
const fastCapex = await api('/pr/capital', {
  method: 'POST', token,
  body: {
    title: 'Small capex', costCenterId, expenseType: 'CAPEX', requiredByDate: '2026-12-31', submit: true,
    lines: [{ itemId: IT_ITEM, quantity: 1, uom: 'EA', unitPriceEst: 200_000, classification: 'CAPEX_ASSET', financialDimensions: DIMS }],
  },
});
ok(fastCapex.data?.routingKey === 'FAST_TRACK', 'capex <= 250k with opex 0 routes FAST_TRACK', fastCapex.data?.routingKey);

// Opex <= 100k, capex 0 -> FAST_TRACK
const petty = await api('/pr/capital', {
  method: 'POST', token,
  body: {
    title: 'Petty opex', costCenterId, expenseType: 'OPEX', requiredByDate: '2026-12-31', submit: true,
    lines: [{ itemId: ACC_ITEM, quantity: 1, uom: 'EA', unitPriceEst: 90_000, classification: 'OPEX_SERVICE', financialDimensions: DIMS }],
  },
});
ok(petty.data?.routingKey === 'FAST_TRACK', 'opex <= 100k with capex 0 routes FAST_TRACK', petty.data?.routingKey);

// Capex > 1 Cr -> BOARD
const board = await api('/pr/capital', {
  method: 'POST', token,
  body: {
    title: 'Board level capex', costCenterId, expenseType: 'CAPEX', requiredByDate: '2026-12-31', submit: true,
    lines: [{ itemId: IT_ITEM, quantity: 1, uom: 'EA', unitPriceEst: 11_000_000, classification: 'CAPEX_INFRA', financialDimensions: DIMS }],
  },
});
ok(board.data?.routingKey === 'BOARD', 'capex > 1 Cr routes BOARD', board.data?.routingKey);

// ── 3 · draft path ────────────────────────────────────────────────────────
console.log('\n--- draft path ---');
const draft = await api('/pr/capital', {
  method: 'POST', token,
  body: {
    title: 'Unsubmitted draft', costCenterId, expenseType: 'OPEX', requiredByDate: '2026-12-31',
    submit: false,
    lines: [{ itemId: ACC_ITEM, quantity: 1, uom: 'EA', unitPriceEst: 5_000, classification: 'OPEX_CONSUMABLE', financialDimensions: DIMS }],
  },
});
ok(draft.data?.status === 'Draft', 'submit=false lands at Draft', draft.data?.status);

// ── 4 · my-prs: the two tables ────────────────────────────────────────────
console.log('\n--- my-prs (two tables, split by stage vocabulary) ---');
const my = await api('/pr/capital/my', { token });
ok([200, 201].includes(my.status), 'GET /pr/capital/my 200', my.status);
ok(Array.isArray(my.data?.detailed) && Array.isArray(my.data?.light), 'payload has both arrays');
ok(my.data?.detailed?.length >= 3, 'detailed table has the v1-vocabulary PRs', my.data?.detailed?.length);
ok(my.data?.light?.length >= 1, 'light table has the v2-vocabulary PRs', my.data?.light?.length);
ok(my.data?.detailed?.some((p) => p.id === m.id), 'the MIXED capital PR is in the detailed table');
ok(!my.data?.light?.some((p) => p.id === m.id), 'and is NOT duplicated into the light table');
ok(my.data?.detailed?.find((p) => p.id === m.id)?.estimated_amount === 1_230_000,
  'detailed row amount is numeric', my.data?.detailed?.find((p) => p.id === m.id)?.estimated_amount);
ok(my.data?.detailed?.some((p) => p.id === draft.data.id && p.status === 'Draft'),
  'the draft appears in the detailed table');
ok(my.data?.detailed?.some((p) => p.routing_key === 'BOARD'),
  'BOARD-routed PR carries its routing key into my-prs');
const anyLight = my.data?.light?.[0];
ok(typeof anyLight?.item_count === 'number', 'light row carries a numeric item_count', anyLight?.item_count);

// ── 5 · pr-detail ─────────────────────────────────────────────────────────
console.log('\n--- pr-detail (capital) ---');
const det = await api(`/pr/capital/${m.id}/detail`, { token });
ok([200, 201].includes(det.status), 'GET /pr/capital/:id/detail 200', det.status);
const d = det.data || {};
ok(d.pr_number === m.prNumber, 'detail carries the PR number', d.pr_number);
ok(d.title === 'Mixed Capex/Opex racking + consumables', 'detail carries the title', d.title);
ok(d.justification === 'Q3 racking expansion with consumable top-up.', 'detail carries the justification', d.justification);
ok(d.capex_amount === 1_200_000 && d.opex_amount === 30_000, 'detail carries the capex/opex split', { c: d.capex_amount, o: d.opex_amount });
ok(d.routing?.routing_key === 'STANDARD', 'detail routing comes from fn_derive_routing', d.routing);
ok(d.routing?.label && d.routing?.reason, 'detail routing carries label + reason', d.routing);
ok(d.lines?.length === 2, 'detail carries 2 lines', d.lines?.length);
ok(d.lines?.[0]?.classification === 'CAPEX_ASSET', 'line 1 classification persisted', d.lines?.[0]?.classification);
ok(d.lines?.[1]?.classification === 'OPEX_CONSUMABLE', 'line 2 classification persisted', d.lines?.[1]?.classification);
ok(d.lines?.[0]?.remarks === 'Floor-standing rack', 'line 1 remarks persisted', d.lines?.[0]?.remarks);
ok(d.lines?.[0]?.gl_account === '1600', 'line 1 GL account persisted', d.lines?.[0]?.gl_account);
ok(typeof d.lines?.[0]?.quantity === 'number' && typeof d.lines?.[0]?.unit_price_est === 'number',
  'line numbers coerced to numeric', { q: typeof d.lines?.[0]?.quantity, u: typeof d.lines?.[0]?.unit_price_est });
const dims = d.lines?.[0]?.financialDimensions || {};
ok(Object.keys(dims).length >= 4, 'financialDimensions parsed back to an object', Object.keys(dims).length);
ok(dims.BusinessUnit === 'PakBoxes' && dims.Location === 'Lahore HQ', 'dimension values round-trip', dims);

// ── 6 · tagged approvers flow through createCapital ───────────────────────
console.log('\n--- tagged approvers on create ---');
const tagged = await api('/pr/capital', {
  method: 'POST', token,
  body: {
    title: 'With tagged approvers', costCenterId, expenseType: 'OPEX',
    requiredByDate: '2026-12-31', submit: true,
    lines: [{ itemId: ACC_ITEM, quantity: 1, uom: 'EA', unitPriceEst: 12_000, classification: 'OPEX_CONSUMABLE', financialDimensions: DIMS }],
    taggedApprovers: [{ taggedRole: 'dept_head', name: 'Aamir Hussain', email: 'aamir.hussain@pakboxes.pk', deptCode: 'DEP-IT' }],
  },
});
ok([200, 201].includes(tagged.status), 'PR with tagged approvers created', tagged.status);
const ackRows = await api(`/pr/${tagged.data.id}/acknowledgements`, { token });
ok(ackRows.data?.rows?.length === 1, 'the tagged approver was created via fn_tag_acknowledgement', ackRows.data?.rows?.length);
ok(ackRows.data?.rows?.[0]?.acknowledged === false, 'newly tagged approver starts unacknowledged');
ok(ackRows.data?.rows?.[0]?.token?.startsWith('ack-'), 'tagged approver got an ack- token');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
console.log(`    (mixed probe: ${m.prNumber} capex=1,200,000 opex=30,000 routing=${m.routingKey})\n`);
process.exit(fail === 0 ? 0 : 1);
