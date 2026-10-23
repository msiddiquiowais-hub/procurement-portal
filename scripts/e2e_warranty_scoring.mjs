// e2e_warranty_scoring.mjs — warranty captured per line must REACH the CS score.
//
//   node scripts/e2e_warranty_scoring.mjs
//
// THE BUG THIS GUARDS
// ───────────────────
// The Receive Quotation grid captures warranty on each line and writes it to
// proc.quotation_lines. Nothing ever writes proc.quotations.warranty_months.
// CS scoring read the header, so every quote recorded through the UI scored 0
// on the warranty dimension. Measured on CS-2026-200428: all four vendors
// scored warranty_score 0.00, including one that had offered 10/12/24 months
// across its lines.
//
// That is the D5 rule — "a missing value scores zero, it never wins by silence"
// — firing backwards. It is meant to stop silence collecting a perfect score;
// here it made a vendor who DID speak score identically to one who said
// nothing, and listed it under `missing` as if it had stayed quiet.
//
// The fix is a floor across the quote's lines (a vendor promising 24 months on
// one line and 10 on another has not promised 24 months for this order).
//
// THE TEST IS BUILT SO WARRANTY IS THE ONLY DIFFERENCE
// Both vendors quote the SAME total and the SAME lead time, so commercial and
// technical tie exactly and the warranty dimension is the sole discriminator.
// A regression that quietly restored the header-only read would put the two
// back on the same score — and this would notice, rather than pass.

import { quoteBody } from './_quote_helpers.mjs';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const LAPTOP = '55555555-5555-5555-5555-555555555503';
const PEN = '55555555-5555-5555-5555-555555555505';

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
const login = async (email) =>
  (await api('/auth/login', { method: 'POST', body: { email, password: 'demo' } })).data?.token;

console.log(`\n=== Warranty reaches the CS score against ${API} ===\n`);

const requester = await login('requester@pakboxes.pk');
const hod = await login('hod.sales@pakboxes.pk');
const procurement = await login('procurement@pakboxes.pk');
const cs = await login('cs@pakboxes.pk');
ok(Boolean(requester && hod && procurement && cs), 'all logins returned a token');

const ccs = await api('/lookups/cost-centers', { token: requester });
const costCenterId = ccs.data?.[0]?.id;

const lines = [
  { itemId: LAPTOP, quantity: 2, uom: 'EA', unitPriceEst: 45000 },
  { itemId: PEN, quantity: 1, uom: 'BOX', unitPriceEst: 45000 },
];
const created = await api('/pr', {
  method: 'POST', token: requester,
  body: { scope: 'Warranty scoring fixture', expenseType: 'OPEX', costCenterId,
          requiredByDate: '2026-12-31', title: 'Warranty scoring fixture', lines },
});
const prId = created.data?.id;
await api(`/pr/${prId}/advance`, {
  method: 'POST', token: hod,
  body: { lineDecisions: Object.fromEntries(lines.map((_, i) => [i, 'approved'])), reason: 'fixture' },
});

const issued = await api(`/pr/${prId}/rfq`, { method: 'POST', token: procurement, body: {} });
const rfqId = issued.data?.rfq?.id;
const invites = issued.data?.invitations || [];
ok(Boolean(rfqId) && invites.length >= 2, 'RFQ issued to at least two vendors', invites.length);

// Identical money and identical lead time, so ONLY warranty can separate them.
const samePrice = [{ rfqLineNo: 1, unitPrice: 60000 }, { rfqLineNo: 2, unitPrice: 40000 }];

const withWarranty = invites[0];
const without = invites[1];

const qA = await api(`/rfq/${rfqId}/quotations`, {
  method: 'POST', token: procurement,
  body: await quoteBody(prId, procurement, withWarranty.vendor_id,
    samePrice.map((l) => ({ ...l, warrantyMonths: 24 })),
    { leadTimeDays: 10 }),
});
ok([200, 201].includes(qA.status), 'the warranty-bearing quote is recorded', qA.status);

const qB = await api(`/rfq/${rfqId}/quotations`, {
  method: 'POST', token: procurement,
  body: await quoteBody(prId, procurement, without.vendor_id, samePrice,
    { leadTimeDays: 10 }),
});
ok([200, 201].includes(qB.status), 'the silent-warranty quote is recorded', qB.status);

// The header column must still be NULL — that is what makes this a real test of
// the fallback rather than of the header path happening to be populated.
const headerA = (await api(`/rfq/${rfqId}`, { token: procurement }))
  .data?.bids?.find((b) => b.vendor_id === withWarranty.vendor_id);
ok(headerA?.warranty_from_lines === true,
  'the warranty really is line-level (the header path is genuinely empty)',
  { warranty_from_lines: headerA?.warranty_from_lines });

const gen = await api(`/pr/${prId}/cs`, { method: 'POST', token: cs });
ok([200, 201].includes(gen.status), 'a comparative statement generates', gen.status);

const detail = await api(`/pr/${prId}/cs`, { token: cs });
const rows = detail.data?.lines || [];
const A = rows.find((r) => r.vendor_id === withWarranty.vendor_id);
const B = rows.find((r) => r.vendor_id === without.vendor_id);
ok(Boolean(A && B), 'both vendors are on the statement', { got: rows.map((r) => r.vendor_id) });

// THE ASSERTION
ok(A?.warranty_months === 24,
  'the 24-month warranty recorded on the lines REACHES the scored vendor',
  { got: A?.warranty_months });
ok(B?.warranty_months === null,
  'the vendor that quoted no warranty still reads as null', { got: B?.warranty_months });

ok(A?.warranty_score > 0,
  'the vendor that DID quote a warranty no longer scores zero', { score: A?.warranty_score });
ok(B?.warranty_score === 0,
  'the silent vendor still scores zero — the D5 rule is not weakened', { score: B?.warranty_score });

ok(A?.commercial_score === B?.commercial_score && A?.technical_score === B?.technical_score,
  'the fixture held: price and lead time tied, so warranty is the only difference',
  { a: [A?.commercial_score, A?.technical_score], b: [B?.commercial_score, B?.technical_score] });

ok((A?.missing || []).includes('warranty') === false,
  'a vendor that quoted a warranty is NOT reported under `missing`', { missing: A?.missing });
ok((B?.missing || []).includes('warranty') === true,
  'the silent vendor IS still reported under `missing`', { missing: B?.missing });

ok(A?.weighted_score > B?.weighted_score,
  'quoting a warranty now changes the outcome — this is what was broken',
  { a: A?.weighted_score, b: B?.weighted_score });
ok(A?.rank === 1, 'the warrantied vendor ranks first', { rank: A?.rank, other: B?.rank });

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);