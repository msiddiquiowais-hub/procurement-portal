// Wave 2 step 3 — GET /pr/:id/sourcing.
//
//   node scripts/e2e_sourcing_card.mjs
//
// Requires: Postgres on 55432, the API on 33001, migrations 025 + 026 applied.
//
// This endpoint is the single request that powers BOTH detail-page cards. The
// prototype reads the same `pr.procurement` object from _lightProcurementCard
// (RFQ & quotes) and _lightRosterCard (vendor roster), so the port returns
// that object in the prototype's own shape rather than inventing a new one.
//
// The load-bearing properties:
//   1. It returns the `_lightProcurement` SHAPE — rfq / quotes / winner /
//      selectedQuoteIndex — so the renderer is a projection, not a place where
//      business rules hide.
//   2. The sub-status ladder is the prototype's fixed three rungs.
//   3. Before an RFQ exists it returns a well-formed EMPTY procurement object,
//      not null, so the card can render "Click Issue RFQ to start the
//      procurement flow." without special-casing.
//   4. Quote totals are the REAL recorded totals. The prototype synthesises a
//      unit price by dividing the total by the PR quantity and multiplies it
//      back — lossy, and wrong for any multi-line PR. We never do that.
//   5. Both cards gate on IN_PROCUREMENT_REVIEW / READY_FOR_D365, and the
//      payload says so rather than the renderer guessing.

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

const login = async (email) => (await api('/auth/login', { method: 'POST', body: { email, password: 'demo' } })).data?.token;

console.log(`\n=== Wave 2 step 3 · GET /pr/:id/sourcing against ${API} ===\n`);

const requester = await login('requester@pakboxes.pk');
const hod = await login('hod.sales@pakboxes.pk');
const procurement = await login('procurement@pakboxes.pk');
const cs = await login('cs@pakboxes.pk');
const admin = await login('admin@pakboxes.pk');
ok(Boolean(requester && hod && procurement && cs && admin), 'all five logins returned a token');

const ccs = await api('/lookups/cost-centers', { token: requester });
const costCenterId = ccs.data?.[0]?.id;

/** Create a light PR and drive it to procurement review. */
async function prInProcurementReview(title, lines) {
  const c = await api('/pr', {
    method: 'POST', token: requester,
    body: { scope: 'Step 3 fixture', expenseType: 'OPEX', costCenterId,
            requiredByDate: '2026-12-31', title, lines },
  });
  const a = await api(`/pr/${c.data.id}/advance`, {
    method: 'POST', token: hod,
    body: { lineDecisions: Object.fromEntries(lines.map((_, i) => [i, 'approved'])), reason: 'step 3' },
  });
  if (a.data?.nextStage !== 'IN_PROCUREMENT_REVIEW') {
    throw new Error(`fixture PR did not reach procurement review: ${JSON.stringify(a.data)}`);
  }
  return c.data.id;
}

// ── 1 · before any RFQ ─────────────────────────────────────────────────────
console.log('\n--- no RFQ yet: the empty procurement object ---');

const barePr = await prInProcurementReview('No RFQ issued yet', [
  { itemId: LAPTOP, quantity: 1, uom: 'EA', unitPriceEst: 45000 },
]);

const bare = await api(`/pr/${barePr}/sourcing`, { token: procurement });
ok(bare.status === 200, 'GET /pr/:id/sourcing 200 before an RFQ exists', bare.status);
ok(bare.data?.procurement?.rfq === null, 'procurement.rfq is null', bare.data?.procurement?.rfq);
ok(Array.isArray(bare.data?.procurement?.quotes) && bare.data.procurement.quotes.length === 0,
  'procurement.quotes is []', bare.data?.procurement?.quotes);
ok(bare.data?.procurement?.selectedQuoteIndex === -1, 'selectedQuoteIndex is -1 (the prototype default)');
ok(bare.data?.procurement?.winner === null, 'winner is null');
ok(bare.data?.cards?.procurement_card === true && bare.data?.cards?.roster_card === true,
  'both cards are enabled at IN_PROCUREMENT_REVIEW', bare.data?.cards);
ok(bare.data?.pr?.pr_number, 'the PR summary is echoed for the card header', bare.data?.pr);
ok(/no RFQ/i.test(bare.data?.empty_reason || ''), 'the payload explains why sourcing is empty', bare.data?.empty_reason);

// A PR that is NOT in a sourcing stage: the cards must report false.
const draft = await api('/pr', {
  method: 'POST', token: requester,
  body: { scope: 'Stage gate', expenseType: 'OPEX', costCenterId, requiredByDate: '2026-12-31',
          title: 'Not in sourcing',
          lines: [{ itemId: PEN, quantity: 1, uom: 'BOX', unitPriceEst: 100 }] },
});
const notSourcing = await api(`/pr/${draft.data.id}/sourcing`, { token: procurement });
ok(notSourcing.status === 200, 'a PR outside procurement review still answers 200', notSourcing.status);
ok(notSourcing.data?.cards?.procurement_card === false,
  'the cards report false outside IN_PROCUREMENT_REVIEW / READY_FOR_D365', notSourcing.data?.cards);

const unknown = await api('/pr/00000000-0000-0000-0000-000000000000/sourcing', { token: procurement });
ok(unknown.status === 404, 'an unknown PR is a 404', unknown.status);

// ── 2 · after issuing ──────────────────────────────────────────────────────
console.log('\n--- after issuing an RFQ: the _lightProcurement shape ---');

const livePr = await prInProcurementReview('Sourcing payload fixture', [
  { itemId: LAPTOP, quantity: 2, uom: 'EA', unitPriceEst: 45000 },
]);
const issued = await api(`/pr/${livePr}/rfq`, { method: 'POST', token: procurement, body: {} });
ok([200, 201].includes(issued.status), 'RFQ issued', issued.data?.message);
const invites = issued.data?.invitations || [];
if (invites.length !== 3) {
  console.log('\n  ABORT  fixture did not produce a 3-vendor RFQ.');
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(1);
}

const s = await api(`/pr/${livePr}/sourcing`, { token: procurement });
ok(s.status === 200, 'GET /pr/:id/sourcing 200 after issuing', s.status);

const proc = s.data?.procurement || {};
ok(proc.rfq && typeof proc.rfq === 'object', 'procurement.rfq is an object', typeof proc.rfq);
ok(proc.rfq?.id === issued.data.rfq.rfq_number, 'rfq.id is the human-readable RFQ number', proc.rfq?.id);
ok(proc.rfq?.rfq_id === issued.data.rfq.id, 'rfq.rfq_id is the internal uuid, kept separately');
ok(Array.isArray(proc.rfq?.vendorIds) && proc.rfq.vendorIds.length === 3,
  'rfq.vendorIds has the 3 invitees', proc.rfq?.vendorIds?.length);
ok(Object.keys(proc.rfq?.issuedAtByVendor || {}).length === 3,
  'rfq.issuedAtByVendor is stamped for every vendor (prototype lines 4083-4092)',
  Object.keys(proc.rfq?.issuedAtByVendor || {}));
ok(Object.values(proc.rfq?.issuedAtByVendor || {}).every(Boolean),
  'every per-vendor issued-at is populated, not an empty string');
ok(Boolean(proc.rfq?.issuedAt), 'rfq.issuedAt is set at the RFQ level');
ok(Boolean(proc.rfq?.deadline), 'rfq.deadline is carried (display-only, per Q2)', proc.rfq?.deadline);

ok(Array.isArray(proc.quotes) && proc.quotes.length === 0, 'procurement.quotes is [] with nothing quoted yet');
ok(proc.selectedQuoteIndex === -1, 'selectedQuoteIndex is -1 with no winner');
ok(proc.winner === null, 'winner is null before the CS lock');

ok(s.data?.sub_status?.label === 'RFQ issued, awaiting quotes',
  "sub-status rung 1 is the prototype's own words", s.data?.sub_status);
ok(Array.isArray(s.data?.roster) && s.data.roster.length === 3, 'roster carries the 3 invitees');
ok(s.data?.roster?.every(r => r.badge?.label === 'Awaiting quote'), 'every badge reads "Awaiting quote"');
ok(s.data?.roster_tally?.pending === 3, 'the tally reports 3 pending', s.data?.roster_tally);

// ── 3 · with quotes in: the ladder climbs, totals are real ──────────────────
console.log('\n--- with quotes: rung 2, and REAL totals ---');

const [v1, v2] = invites;
await api(`/rfq/${issued.data.rfq.id}/quotations`, {
  method: 'POST', token: procurement,
  body: { vendorId: v1.vendor_id, quoteMode: 'per_line', paymentTerms: '30 days net',
          lines: [{ rfqLineNo: 1, unitPrice: 43000 }] },
});
await api(`/rfq/${issued.data.rfq.id}/quotations`, {
  method: 'POST', token: procurement,
  body: { vendorId: v2.vendor_id, totalAmount: 91000, quoteMode: 'total', leadTimeDays: 10 },
});

const s2 = await api(`/pr/${livePr}/sourcing`, { token: procurement });
const proc2 = s2.data?.procurement || {};
ok(proc2.quotes.length === 2, 'both live quotes appear', proc2.quotes?.length);
ok(s2.data?.sub_status?.label === 'Quotes received, select winner',
  'sub-status climbs to rung 2 once quotes arrive', s2.data?.sub_status);
ok(proc2.selectedQuoteIndex === -1, 'still no winner selected', proc2.selectedQuoteIndex);

const q1 = proc2.quotes.find(q => q.vendor_id === v1.vendor_id);
const q2 = proc2.quotes.find(q => q.vendor_id === v2.vendor_id);

// The point of the test: real totals, no synthesized unit price.
ok(q1?.total === 86000, 'per-line quote total is the real 2 x 43,000', q1?.total);
ok(q1?.unit_price === null, 'unit_price is null — never synthesized from total / qty', q1?.unit_price);
ok(q2?.total === 91000, 'grand-total quote total is carried verbatim', q2?.total);
ok(q2?.unit_price === null, 'a grand-total quote has no unit price either', q2?.unit_price);
ok(proc2.quotes.every(q => q.vendor_name && q.vendor_id), 'every quote carries its vendor name + id');
ok(proc2.quotes.every(q => typeof q.is_new_vendor === 'boolean'),
  'is_new_vendor is present — the prototype\'s "Pending approval" driver');
ok(proc2.quotes.every(q => q.received_at), 'every quote carries its received timestamp');
ok(proc2.quotes.every(q => q.quote_mode), 'quote_mode records HOW each total was derived');

const totalSum = proc2.quotes.reduce((a, q) => a + Number(q.total || 0), 0);
ok(totalSum === 177000, 'the two totals reconcile against the DB values', { totalSum });

// ── 4 · one call, both cards ───────────────────────────────────────────────
console.log('\n--- one response serves both cards ---');

ok(Array.isArray(s2.data?.roster) && s2.data.roster.length === 3,
  'the same response carries the roster the roster card needs');
ok(s2.data?.roster?.every(r => Array.isArray(r.versions)),
  'each roster row carries its version chain for the Versions Panel');
const rosterQuoteCount = s2.data.roster.filter(r => r.versions.some(v => v.state === 'Submitted')).length;
ok(rosterQuoteCount === 2, 'the roster shows 2 vendors with a live quote', { rosterQuoteCount });
ok(s2.data?.roster_tally?.received === 2, 'and the tally agrees', s2.data?.roster_tally);
ok(s2.data?.roster?.find(r => r.vendor_id === v1.vendor_id)?.badge?.label === 'Received',
  'a vendor with a live quote badges as "Received"');

// ── 5 · read access follows the screen, which is 'all' ─────────────────────
console.log('\n--- role access ---');

for (const [name, tok] of [['requester', requester], ['hod', hod], ['cs', cs], ['admin', admin]]) {
  const r = await api(`/pr/${livePr}/sourcing`, { token: tok });
  ok(r.status === 200, `${name} can read /sourcing — light-pr-detail is data-roles 'all'`, { name, status: r.status });
}

const noToken = await api(`/pr/${livePr}/sourcing`);
// JwtAuthGuard returns false for a missing/invalid token, which Nest surfaces
// as 403 Forbidden rather than 401. That is the established behaviour for
// every protected endpoint in this API, so assert what the codebase does
// rather than special-casing one route.
ok(noToken.status === 403, 'an unauthenticated read is refused (403, the codebase-wide guard behaviour)', noToken.status);

// ── 6 · the rfq-detail payload: bids, winner, compliance ──────────────────
console.log('\n--- GET /rfq/:id — the rfq-detail bid payload ---');

const det = await api(`/rfq/${issued.data.rfq.id}`, { token: procurement });
ok(det.status === 200, 'GET /rfq/:id 200', det.status);
ok(Array.isArray(det.data?.bids) && det.data.bids.length === 2,
  'bids[] holds one row per live quote', det.data?.bids?.length);
ok(det.data?.winner === null, 'winner is null before any CS is locked', det.data?.winner);

const bid1 = det.data.bids.find(b => b.vendor_id === v1.vendor_id);
ok(bid1?.amount === 86000, 'the bid carries the real recorded total', bid1?.amount);
ok(bid1?.unit_price === undefined, 'a bid exposes no synthesized unit price', bid1?.unit_price);
ok(bid1?.is_winner === false, 'no bid claims to be the winner yet', bid1?.is_winner);
ok(bid1?.vendor_name && bid1?.vendor_code, 'each bid carries its vendor identity');

// D5: no vendor in the seed has a due-diligence record, so compliance must be
// UNKNOWN. The prototype hardcodes "✓ Pass" for every bid.
ok(det.data.bids.every(b => b.compliance?.status === 'unknown'),
  'D5: compliance is unknown, never an assumed pass', det.data.bids.map(b => b.compliance));
ok(det.data.bids.every(b => b.compliance?.label === '—'),
  'and it renders as an em-dash', det.data.bids.map(b => b.compliance?.label));

const sumBids = det.data.bids.reduce((a, b) => a + b.amount, 0);
ok(sumBids === 177000, 'the bid amounts reconcile with the stored quote totals', { sumBids });

const detailAsRequester = await api(`/rfq/${issued.data.rfq.id}`, { token: requester });
ok(detailAsRequester.status === 403,
  'rfq-detail keeps its own narrower gate — requester is refused', detailAsRequester.status);

// ── summary ────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
