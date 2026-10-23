// make_ready_for_cs_fixture.mjs — a throwaway PR parked at procurement review
// with one quotation already on file, so the "Ready for CS" button is enabled
// and can be exercised in the browser without touching seeded data.
//
//   node scripts/make_ready_for_cs_fixture.mjs
//
// Prints the PR id and number. Deliberately stops BEFORE forwarding: the
// hand-off is the irreversible half, and the browser pass is there to click it.

import { quoteBody } from './_quote_helpers.mjs';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const LAPTOP = '55555555-5555-5555-5555-555555555503';
const PEN = '55555555-5555-5555-5555-555555555505';

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

const login = async (email) =>
  (await api('/auth/login', { method: 'POST', body: { email, password: 'demo' } })).data?.token;

const requester = await login('requester@pakboxes.pk');
const hod = await login('hod.sales@pakboxes.pk');
const procurement = await login('procurement@pakboxes.pk');

const ccs = await api('/lookups/cost-centers', { token: requester });
const costCenterId = ccs.data?.[0]?.id;

const lines = [
  { itemId: LAPTOP, quantity: 2, uom: 'EA', unitPriceEst: 45000 },
  { itemId: PEN, quantity: 1, uom: 'BOX', unitPriceEst: 45000 },
];

const created = await api('/pr', {
  method: 'POST', token: requester,
  body: {
    scope: 'Browser fixture', expenseType: 'OPEX', costCenterId,
    requiredByDate: '2026-12-31', title: 'Ready for CS — browser fixture', lines,
  },
});
if (!created.data?.id) {
  console.error('create failed', created.status, created.data);
  process.exit(1);
}
const prId = created.data.id;

await api(`/pr/${prId}/advance`, {
  method: 'POST', token: hod,
  body: { lineDecisions: Object.fromEntries(lines.map((_, i) => [i, 'approved'])), reason: 'fixture' },
});

const issued = await api(`/pr/${prId}/rfq`, { method: 'POST', token: procurement, body: {} });
const rfqId = issued.data?.rfq?.id;
const invites = issued.data?.invitations || [];
if (!rfqId || !invites.length) {
  console.error('issue failed', issued.status, issued.data);
  process.exit(1);
}

// One quotation, recorded the way the buyer would — this is what makes the
// button enabled rather than greyed out.
const q = await api(`/rfq/${rfqId}/quotations`, {
  method: 'POST', token: procurement,
  body: await quoteBody(prId, procurement, invites[0].vendor_id,
    [{ rfqLineNo: 1, unitPrice: 43000 }, { rfqLineNo: 2, unitPrice: 9000 }]),
});
if (![200, 201].includes(q.status)) {
  console.error('quote failed', q.status, q.data);
  process.exit(1);
}

const detail = await api(`/pr/${prId}`, { token: procurement });
console.log(JSON.stringify({
  prId,
  prNumber: detail.data?.pr_number,
  rfqId,
  rfqNumber: issued.data?.rfq?.rfq_number,
  vendors: invites.length,
  liveQuotes: 1,
  stage: detail.data?.status,
}, null, 2));