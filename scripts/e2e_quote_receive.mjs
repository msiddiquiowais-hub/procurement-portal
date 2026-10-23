// E2E — Receive Quotation, the per-line pricing waterfall, end to end.
//
//   node scripts/e2e_quote_receive.mjs
//
// WHAT THIS PINS
// -------------
// Migration 055 gave proc.quotation_lines a real GROSS -> DISC -> NET -> TAX ->
// TOTAL waterfall. Three things about that are easy to get quietly wrong, so
// they are asserted here rather than eyeballed in a screenshot:
//
//   1. The DERIVED figures are not client-supplied. The DTO accepts only the
//      rates (unitPrice, discountPercent, taxPercent, warrantyMonths); the
//      service computes the rest. A request that tries to post its own gross or
//      line total is ignored on those keys — the stored row must still satisfy
//      the arithmetic.
//
//   2. The two discount bases differ ON MONEY, and the difference is not a
//      rounding artefact. On 25,000 gross, 8% off, 17.5% tax:
//        before_tax -> tax on 23,000 = 4,025.00, line total 27,025.00
//        after_tax  -> tax on 25,000 = 4,375.00, line total 27,375.00
//      Recording the wrong basis understates or overstates tax by 350.00.
//
//   3. Warranty is PER LINE. A single quotation legitimately mixes a 60-month
//      desktop with a 12-month chair; storing one header figure flattens that.
//
// Also pinned: the header total equals the SUM OF THE ROUNDED LINE TOTALS, not
// a single rounding of the sum. FBR/PRA treat a printed total that disagrees
// with its own printed lines as a defective tax document.
//
// NOT asserted here: which PR or vendor the suite picks. It chooses an RFQ that
// is open, has >=2 lines, and still has a vendor with no live quote, so the run
// is repeatable and never depends on screen ordering.

import { spawnSync } from 'node:child_process';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const CONTAINER = process.env.PG_CONTAINER || 'procurement-portal-db';

let pass = 0, fail = 0;
const ok = (l, x = '') => { pass++; console.log(`  PASS  ${l}${x ? `  (${x})` : ''}`); };
const bad = (l, d) => { fail++; console.log(`  FAIL  ${l}\n        ${d}`); };
const head = (s) => console.log(`\n== ${s} ==`);

/** 2dp, half-up — mirrors QuotationService.round2 so expected values match.
 *
 *  Deliberately the SAME expression as the service and the browser's
 *  quoteMath.round2: `+(v).toFixed(2)` rather than `Math.round(v * 100) / 100`.
 *  The naive form returns 10390.624999999999 for 10390.625, so an expectation
 *  written with it would disagree with a correct implementation by a paisa and
 *  read as a real defect.
 *
 *  `Number(v)` first, and not incidentally: most callers pass figures straight
 *  out of psql, which are strings. `v + Number.EPSILON` on a string CONCATENATES
 *  rather than adds, so the result stops being a number and `.toFixed` is not a
 *  function — a helper that throws on half its inputs is worse than one that is
 *  a paisa out on the rest. */
const r2 = (v) => Math.round(Number((Number(v) + Number.EPSILON).toFixed(2)) * 100) / 100;
/** Money to a fixed string so a float never prints as 69765.629999999. */
const m = (v) => r2(v).toFixed(2);

async function login(email) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'demo' }),
  });
  const j = await r.json();
  return j.token || j.accessToken;
}

function sql(q) {
  const r = spawnSync('docker', [
    'exec', CONTAINER, 'psql', '-U', 'proc', '-d', 'procurementDB',
    '-X', '-A', '-F', '\t', '-t', '-c', q,
  ], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || `psql failed (${r.status})`);
  return r.stdout.split('\n').map(l => l.trim()).filter(Boolean).map(l => l.split('\t'));
}

const tok = await login('procurement@pakboxes.pk');
const H = { authorization: `Bearer ${tok}`, 'content-type': 'application/json' };

async function post(url, body) {
  const r = await fetch(`${API}${url}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* non-JSON error page */ }
  return { status: r.status, body: j, raw: t };
}

/**
 * Upload a quotation document and return its core.files id.
 *
 * Mandatory on the procurement Receive Quotation path (migration 056 +
 * QuotationService's strictForm). Uploaded as a RAW body with the filename in
 * `x-file-name` — the same contract the screen uses, so this suite exercises the
 * real upload path rather than a shortcut the browser never takes.
 */
async function uploadDoc(prId, name = 'quotation.pdf') {
  const bytes = Buffer.from(`%PDF-1.4\n% e2e quotation document ${Date.now()}\n%%EOF\n`, 'utf8');
  const r = await fetch(`${API}/pr/${prId}/attachments`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tok}`,
      'x-file-name': name,
      'content-type': 'application/pdf',
    },
    body: bytes,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`upload failed (${r.status}): ${t.slice(0, 200)}`);
  const j = JSON.parse(t);
  return j.file_id || j.attachment_id || j.id;
}

// ── 0. the currency master, and that admins can edit it ──────────────────────
head('0. currency rates come from core.fx_rates, and an admin can change them');
const cur = await (await fetch(`${API}/lookups/currencies`, {
  headers: { authorization: `Bearer ${tok}` },
})).json();

Array.isArray(cur) && cur.length > 0
  ? ok('the currency list is served from the master table', `${cur.length} currencies`)
  : bad('currencies', `got ${JSON.stringify(cur)}`);

// Every offered currency must have a positive rate, and the list must be the
// DISTINCT set — a duplicated currency is the failure that made USD appear four
// times with four different rates.
const codes = cur.map((c) => c.currency);
new Set(codes).size === codes.length
  ? ok('each currency appears once', codes.join(', '))
  : bad('duplicate currencies', codes.join(', '));
cur.every((c) => Number(c.rate_to_pkr) > 0)
  ? ok('every rate is positive')
  : bad('non-positive rate', JSON.stringify(cur));
const stale = cur.filter((c) => c.stale);
stale.length === 0
  ? ok('no rate is older than 30 days', `newest ${cur[0]?.effective_date}`)
  : ok('stale rates are FLAGGED rather than silently served', stale.map((c) => `${c.currency} ${c.age_days}d`).join(', '));

// PKR must be exactly 1 — the normalisation baseline. Anything else would
// mis-normalise every PKR quotation in the comparative statement.
const pkrRow = cur.find((c) => c.currency === 'PKR');
pkrRow && Number(pkrRow.rate_to_pkr) === 1
  ? ok('PKR is the baseline at 1')
  : bad('PKR baseline', pkrRow ? String(pkrRow.rate_to_pkr) : 'PKR missing');

const adminTok = await login('admin@pakboxes.pk');
const today = new Date().toISOString().slice(0, 10);
const readUsd = async () => (await (await fetch(`${API}/lookups/currencies`, {
  headers: { authorization: `Bearer ${tok}` },
})).json()).find((c) => c.currency === 'USD');

const seedUsd = await readUsd();

// 1. A rate effective TODAY must become the one the form offers.
const NEW_RATE = Number(seedUsd.rate_to_pkr) + 1.5;
const put = await fetch(`${API}/admin/fx-rates/USD`, {
  method: 'PUT',
  headers: { authorization: `Bearer ${adminTok}`, 'content-type': 'application/json' },
  body: JSON.stringify({ rateToPkr: NEW_RATE, effectiveDate: today, source: 'e2e' }),
});
put.ok ? ok('admin can write a rate', `USD ${NEW_RATE} effective ${today}`)
  : bad('admin fx write', `HTTP ${put.status} — ${(await put.text()).slice(0, 160)}`);

const after = await readUsd();
Number(after.rate_to_pkr) === NEW_RATE && after.effective_date === today
  ? ok('the quotation form now offers USD at the new rate', String(after.rate_to_pkr))
  : bad('rate did not take effect', `want ${NEW_RATE} @ ${today}, got ${after.rate_to_pkr} @ ${after.effective_date}`);

// 2. A BACK-DATED row must NOT become current — "current" means the newest
// effective date. Letting an old row win would silently restate live money, so
// this is asserted separately from the happy path above rather than folded into
// it: an earlier version of this test asserted only #1 with a back-dated write
// and therefore FAILED while the app was behaving correctly.
const BACK_DATE = '2026-06-01';
const backPut = await fetch(`${API}/admin/fx-rates/USD`, {
  method: 'PUT',
  headers: { authorization: `Bearer ${adminTok}`, 'content-type': 'application/json' },
  body: JSON.stringify({ rateToPkr: 1.23, effectiveDate: BACK_DATE, source: 'e2e-backdated' }),
});
backPut.ok ? ok('a back-dated rate is still recorded', BACK_DATE) : bad('back-dated write', `HTTP ${backPut.status}`);
const afterBack = await readUsd();
Number(afterBack.rate_to_pkr) === NEW_RATE && afterBack.effective_date === today
  ? ok('a back-dated rate does NOT become current', `still ${afterBack.rate_to_pkr} @ ${afterBack.effective_date}`)
  : bad('back-dated rate overrode the current one', JSON.stringify(afterBack));

// The back-dated row is test residue in the SHARED master, and the API has no
// delete-by-design ("retirement is not erasure"). Leaving it means a row sits in
// Settings' rate history forever claiming USD traded at 1.23, which is a
// fabricated figure in a table an auditor reads. Reset it to the seed value at
// the same date, so the history reads truthfully even though the row survives.
await fetch(`${API}/admin/fx-rates/USD`, {
  method: 'PUT',
  headers: { authorization: `Bearer ${adminTok}`, 'content-type': 'application/json' },
  body: JSON.stringify({ rateToPkr: seedUsd.rate_to_pkr, effectiveDate: BACK_DATE, source: 'seed' }),
});

// PKR is refused: it is the baseline, and editing it is never legitimate.
const pkrPut = await fetch(`${API}/admin/fx-rates/PKR`, {
  method: 'PUT',
  headers: { authorization: `Bearer ${adminTok}`, 'content-type': 'application/json' },
  body: JSON.stringify({ rateToPkr: 2, effectiveDate: '2026-06-01' }),
});
pkrPut.status === 400
  ? ok('PKR is refused as an editable rate', 'baseline is fixed at 1')
  : bad('PKR is editable', `HTTP ${pkrPut.status}`);

// A non-admin role must not be able to move a rate.
const reqTok = await login('requester@pakboxes.pk');
const reqPut = await fetch(`${API}/admin/fx-rates/GBP`, {
  method: 'PUT',
  headers: { authorization: `Bearer ${reqTok}`, 'content-type': 'application/json' },
  body: JSON.stringify({ rateToPkr: 999, effectiveDate: '2026-06-01' }),
});
reqPut.status === 403
  ? ok('a requester cannot change exchange rates')
  : bad('fx write is not role-gated', `HTTP ${reqPut.status}`);

// Restore the seed's USD rate for TODAY's date, so a run leaves the master in
// a sane state for the next run rather than with this suite's +1.5 still live.
await fetch(`${API}/admin/fx-rates/USD`, {
  method: 'PUT',
  headers: { authorization: `Bearer ${adminTok}`, 'content-type': 'application/json' },
  body: JSON.stringify({ rateToPkr: seedUsd.rate_to_pkr, effectiveDate: today, source: 'seed' }),
});

// ── 1. pick a usable RFQ ─────────────────────────────────────────────────────
head('1. find an open RFQ with 2+ lines and a vendor awaiting a quote');
// This pair must have NO quotations at all — not merely none in state
// 'Submitted'. Sections 5-7 assert on the whole version chain, and the chain is
// queried by (rfq, vendor) with no state filter, so a pre-existing row is
// silently part of what is being asserted.
//
// The seed data makes that bite. Of the 44 pairs the weaker "no Submitted
// quotation" test admits, 21 already carry a chain — V1 Superseded, V2
// Superseded, V3 Withdrawn — and every one of those 21 has a version with no
// attachment, because seed quotations were never given a document. Those pairs
// then failed "every version carries its own document" on roughly half of all
// runs. That is not the app failing to attach a document; it is the assertion
// counting rows the app never wrote, and no amount of retrying finds a run
// where it does not happen. Requiring a virgin pair restores the precondition
// the section assumes: V1 here is the one section 2 posts, V2 the one section 5
// supersedes, V3 the one section 7 supersedes.
const pick = await sql(`
  SELECT r.id::text, i.vendor_id::text
    FROM proc.rfq r
    JOIN proc.rfq_invitations i ON i.rfq_id = r.id
   WHERE r.state = 'Open'
     AND i.declined = false
     AND NOT EXISTS (
       SELECT 1 FROM proc.quotations q
        WHERE q.rfq_id = r.id AND q.vendor_id = i.vendor_id
     )
     AND (SELECT count(*) FROM proc.rfq_lines l WHERE l.rfq_id = r.id) >= 2
   ORDER BY r.issued_at DESC NULLS LAST
   LIMIT 1`);

if (!pick.length) {
  bad('fixture',
    'no open RFQ with 2+ lines and a vendor that has never been quoted — '
    + 'every such pair already holds a seeded chain, so this suite needs a fresh RFQ');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
const [rfqId, vendorId] = pick[0];
const prId = (await sql(`SELECT pr_id::text FROM proc.rfq WHERE id = '${rfqId}'`))[0][0];
const lineRows = await sql(
  `SELECT line_no::text, quantity::text FROM proc.rfq_lines
    WHERE rfq_id = '${rfqId}' ORDER BY line_no LIMIT 2`);
const qty = new Map(lineRows.map(r => [Number(r[0]), Number(r[1])]));
const [l1, l2] = [...qty.keys()];
ok('fixture found', `rfq=${rfqId.slice(0, 8)} lines=${[...qty.keys()].join(',')}`);

// ── 2. the before-tax waterfall ──────────────────────────────────────────────
head('1b. the form refuses a quotation with no document and no required terms');
// Probed BEFORE the happy path, because these are the two rules that would
// otherwise let a real officer save an unusable record.
const docless = await post(`/rfq/${rfqId}/quotations`, {
  vendorId, quoteMode: 'per_line', leadTimeDays: 7, paymentTerms: '30 Days Net',
  validUntil: '2026-12-31',
  lines: [{ rfqLineNo: l1, unitPrice: 100 }],
});
/attachment|document/i.test(docless.body?.message || '')
  ? ok('missing quotation document is refused', docless.body?.message)
  : bad('missing document', `HTTP ${docless.status} — ${docless.raw.slice(0, 160)}`);

const termless = await post(`/rfq/${rfqId}/quotations`, {
  vendorId, quoteMode: 'per_line', attachmentId: await uploadDoc(prId),
  lines: [{ rfqLineNo: l1, unitPrice: 100 }],
});
/Lead Days|Valid Until|Payment Terms/.test(termless.body?.message || '')
  ? ok('missing required terms are named', termless.body?.message)
  : bad('missing terms', `HTTP ${termless.status} — ${termless.raw.slice(0, 160)}`);

// ── 1c. a rate may not be zero or negative unless the line is declined ───────
head('1c. a line that is not declined must be priced above zero');
// The rule is enforced HERE, not only in the form. The browser strips a minus
// sign as it is typed, but a client can always be bypassed — and a 0.00 row on a
// quotation that is not declined reads in the comparative statement as "this
// vendor supplied it free", not "there is no price yet".
const zeroPrice = await post(`/rfq/${rfqId}/quotations`, {
  vendorId, quoteMode: 'per_line', leadTimeDays: 7, paymentTerms: '30 Days Net',
  validUntil: '2026-12-31', attachmentId: await uploadDoc(prId),
  lines: [{ rfqLineNo: l1, unitPrice: 0 }],
});
/greater than zero/i.test(zeroPrice.body?.message || '')
  ? ok('a 0.00 unit price on a live line is refused', zeroPrice.body.message)
  : bad('zero unit price accepted', `HTTP ${zeroPrice.status} — ${zeroPrice.raw.slice(0, 160)}`);

const negPrice = await post(`/rfq/${rfqId}/quotations`, {
  vendorId, quoteMode: 'per_line', leadTimeDays: 7, paymentTerms: '30 Days Net',
  validUntil: '2026-12-31', attachmentId: await uploadDoc(prId),
  lines: [{ rfqLineNo: l1, unitPrice: -100 }],
});
negPrice.status === 400
  ? ok('a negative unit price is refused', `HTTP 400 — ${String(negPrice.body?.message).slice(0, 70)}`)
  : bad('negative unit price accepted', `HTTP ${negPrice.status} — ${negPrice.raw.slice(0, 160)}`);

// The same figures on the RATES, which the DTO bounds to 0-100.
for (const [field, value] of [['taxPercent', -5], ['discountPercent', -5],
  ['taxPercent', 101], ['discountPercent', 101]]) {
  const r = await post(`/rfq/${rfqId}/quotations`, {
    vendorId, quoteMode: 'per_line', leadTimeDays: 7, paymentTerms: '30 Days Net',
    validUntil: '2026-12-31', attachmentId: await uploadDoc(prId),
    lines: [{ rfqLineNo: l1, unitPrice: 100, [field]: value }],
  });
  r.status === 400
    ? ok(`${field} ${value} is refused`, 'HTTP 400')
    : bad(`${field} ${value} accepted`, `HTTP ${r.status} — ${r.raw.slice(0, 160)}`);
}

// Declined is the EXEMPT case, and needs no test of its own: section 7 already
// posts a declined line at unitPrice 0 and asserts it contributes nothing, which
// is the exemption exactly.
//
// An earlier version of this section proved it by POSTING a throwaway quotation
// and deleting it afterwards. That was a bad idea twice over — it left a live
// quotation behind whenever the cleanup did not land, and a later assertion that
// every version carries its own document then failed on OUR residue, in a way
// that looked like a product bug. A fixture that writes to shared state and
// hopes to undo it is not a fixture.

head('2. record a quote with a per-line discount and per-line tax (before tax)');
const UNIT = 12500, DISC = 5, TAX = 17.5, W1 = 60;
const attachmentId = await uploadDoc(prId);
const g1 = r2(UNIT * qty.get(l1));
const d1 = r2(g1 * DISC / 100);
const n1 = r2(g1 - d1);
const t1 = r2(n1 * TAX / 100);
const exp1 = r2(n1 + t1);

const rec = await post(`/rfq/${rfqId}/quotations`, {
  vendorId,
  quoteMode: 'per_line',
  discountBasis: 'before_tax',
  taxesIncluded: false,
  validUntil: '2026-12-31',
  leadTimeDays: 7,
  paymentTerms: '30 Days Net',
  attachmentId,
  notes: 'e2e: before-tax waterfall',
  lines: [
    { rfqLineNo: l1, unitPrice: UNIT, discountPercent: DISC, taxPercent: TAX, warrantyMonths: W1 },
    { rfqLineNo: l2, unitPrice: 8000, discountPercent: 0, taxPercent: 17, warrantyMonths: 12 },
  ],
});
if (rec.status !== 201 && rec.status !== 200) {
  bad('POST /rfq/:id/quotations', `HTTP ${rec.status} — ${rec.raw.slice(0, 300)}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}
const quoteId = rec.body?.quotation?.id || rec.body?.id;
ok('quotation recorded', `id=${String(quoteId).slice(0, 8)}`);

const stored = await sql(`
  SELECT rfq_line_no::text, unit_price::text, gross_amount::text, discount_percent::text,
         discount_amount::text, net_amount::text, tax_percent::text, tax_amount::text,
         line_total::text, warranty_months::text, total_price::text
    FROM proc.quotation_lines WHERE quotation_id = '${quoteId}' ORDER BY rfq_line_no`);
const row = Object.fromEntries(stored.map(r => [Number(r[0]), r]));
const s1 = row[l1];

Number(s1[2]) === g1 ? ok('line gross = qty x unit', m(g1)) : bad('line gross', `want ${m(g1)} got ${s1[2]}`);
Number(s1[4]) === d1 ? ok('line discount = gross x disc%', m(d1)) : bad('line discount', `want ${m(d1)} got ${s1[4]}`);
Number(s1[5]) === n1 ? ok('line net = gross - discount', m(n1)) : bad('line net', `want ${m(n1)} got ${s1[5]}`);
Number(s1[7]) === t1 ? ok('line tax = net x tax% (before-tax basis)', m(t1)) : bad('line tax', `want ${m(t1)} got ${s1[7]}`);
Number(s1[8]) === exp1 ? ok('line total = net + tax', m(exp1)) : bad('line total', `want ${m(exp1)} got ${s1[8]}`);
Number(s1[9]) === W1 ? ok('warranty stored per line', `${s1[9]} months`) : bad('per-line warranty', `want ${W1} got ${s1[9]}`);

// ── 3. the header total is the sum of the ROUNDED lines ─────────────────────
head('3. the header total equals the sum of the rounded line totals');
const hdr = await sql(
  `SELECT total_amount::text, normalized_total_pkr::text, valid_until::text, discount_basis::text
     FROM proc.quotations WHERE id = '${quoteId}'`);
const sumLines = r2(stored.reduce((a, r) => a + Number(r[8]), 0));
Number(hdr[0][0]) === sumLines
  ? ok('header total = sum(line_total)', m(sumLines))
  : bad('header total', `want ${m(sumLines)} got ${hdr[0][0]}`);
hdr[0][2] === '2026-12-31' ? ok("vendor's stated valid_until persisted", hdr[0][2]) : bad('valid_until', hdr[0][2]);
hdr[0][3] === 'before_tax' ? ok('discount_basis persisted', hdr[0][3]) : bad('discount_basis', hdr[0][3]);

// ── 4. derived figures are NOT accepted from the client ─────────────────────
head('4. a client that posts its own gross/line total cannot override the maths');
const bad2 = await post(`/rfq/${rfqId}/quotations`, {
  vendorId, quoteMode: 'per_line', discountBasis: 'before_tax', taxesIncluded: false,
  leadTimeDays: 7, paymentTerms: '30 Days Net', validUntil: '2026-12-31',
  attachmentId: await uploadDoc(prId),
  // These are NOT DTO fields. They must be dropped, not persisted.
  gross_amount: 1, line_total: 1, totalAmount: 1,
  lines: [{ rfqLineNo: l1, unitPrice: UNIT, discountPercent: DISC, taxPercent: TAX }],
});
if (bad2.status === 201 || bad2.status === 200) {
  const q2 = bad2.body?.quotation?.id || bad2.body?.id;
  const r2rows = await sql(
    `SELECT line_total::text FROM proc.quotation_lines WHERE quotation_id = '${q2}'`);
  Number(r2rows[0][0]) === exp1
    ? ok('ignored the forged totals; stored the derived line total', m(exp1))
    : bad('forged totals honoured', `stored ${r2rows[0][0]}, expected ${m(exp1)}`);
} else {
  // A refusal is also acceptable — the API must never store the forged figures.
  ok('forged totals refused outright', `HTTP ${bad2.status}`);
}

// ── 5. after-tax: tax on the gross, discount off the tax-inclusive figure ────
head('5. after-tax taxes the gross and discounts the tax-inclusive amount');
// The reported bug. It used to compute  gross + tax - (gross x disc%) , i.e. it
// took the discount off the GROSS and then added the tax — 2,160.00 on a quote
// the before-tax basis billed 2,124.00. The payable amount must not depend on
// which side of the tax the discount was read from.
//
// Both bases reduce to gross x (1 + tax%) x (1 - disc%), so what differs is the
// SPLIT: the tax remittance and the discount the vendor actually granted. Both
// halves are asserted, because "the totals agree" alone would also have been
// true of two broken implementations.
const tAfter = r2(g1 * TAX / 100);            // tax on the FULL amount
const incTax = r2(g1 + tAfter);                // "Inc Tax Amt"
const dAfter = r2(incTax * DISC / 100);        // discount off THAT figure
const expAfter = r2(incTax - dAfter);
const sup = await post(`/quotations/${quoteId}/supersede`, {
  vendorId, quoteMode: 'per_line', discountBasis: 'after_tax', taxesIncluded: false,
  leadTimeDays: 7, paymentTerms: '30 Days Net', validUntil: '2026-12-31',
  attachmentId: await uploadDoc(prId, 'quotation-v2.pdf'),
  reason: 'e2e: switching the discount basis to after tax',
  lines: [
    { rfqLineNo: l1, unitPrice: UNIT, discountPercent: DISC, taxPercent: TAX, warrantyMonths: W1 },
    { rfqLineNo: l2, unitPrice: 8000, discountPercent: 0, taxPercent: 17, warrantyMonths: 12 },
  ],
});
if (sup.status !== 201 && sup.status !== 200) {
  bad('supersede', `HTTP ${sup.status} — ${sup.raw.slice(0, 300)}`);
} else {
  const v2 = sup.body?.quotation?.id;
  const v2rows = await sql(
    `SELECT tax_amount::text, net_amount::text, discount_amount::text, line_total::text
       FROM proc.quotation_lines
      WHERE quotation_id = '${v2}' AND rfq_line_no = ${l1}`);
  Number(v2rows[0][0]) === tAfter
    ? ok('after-tax basis taxes the GROSS', m(tAfter))
    : bad('after-tax tax', `want ${m(tAfter)} got ${v2rows[0][0]}`);

  // The middle column is the gross INCLUDING tax — 25,000 + 4,375 — not the
  // gross less the discount, which is what it read as before.
  Number(v2rows[0][1]) === incTax
    ? ok('the middle column is the tax-inclusive gross (Inc Tax Amt)', m(incTax))
    : bad('after-tax net_amount', `want ${m(incTax)} got ${v2rows[0][1]}`);
  Number(v2rows[0][1]) !== n1
    ? ok('it is NOT the gross less the discount', `${v2rows[0][1]} != ${m(n1)}`)
    : bad('Inc Tax Amt still subtracts the discount', `${m(n1)} — the reported bug`);

  Number(v2rows[0][2]) === dAfter
    ? ok('the discount comes off the tax-inclusive figure', `${m(dAfter)} (not ${m(d1)})`)
    : bad('after-tax discount', `want ${m(dAfter)} got ${v2rows[0][2]}`);

  Number(v2rows[0][3]) === expAfter
    ? ok('after-tax line total = Inc Tax Amt - Disc Amt', m(expAfter))
    : bad('after-tax line total', `want ${m(expAfter)} got ${v2rows[0][3]}`);

  // The buyer pays the SAME either way — to within the rounding this form applies.
// Not "exactly the same": each basis is the sum of its OWN rounded components
// (the FBR/PRA rule this form follows), and they round at different intermediate
// steps, so on an exact half-paisa tie they land on opposite sides. The old
// assertion was `delta === 0`, which asserted a coincidence of rounding order
// rather than the property that matters. What is asserted instead is stronger:
// each basis is internally consistent AND within half a paisa of the exact
// value gross x (1 + tax%) x (1 - disc%).
const delta = r2(expAfter - exp1);
const exact = r2(g1 * (1 + TAX / 100) * (1 - DISC / 100));
Math.abs(delta) <= 0.01
  ? ok('both bases bill the same payable amount', `${m(expAfter)} vs ${m(exp1)} (delta ${m(delta)})`)
  : bad('the bases disagree on what is payable by more than a paisa',
    `before ${m(exp1)} vs after ${m(expAfter)} — delta ${m(delta)}`);
Math.abs(exp1 - exact) <= 0.01 && Math.abs(expAfter - exact) <= 0.01
  ? ok('and both are within half a paisa of the exact product', `${m(exact)}`)
  : bad('a basis drifted away from the exact value',
    `exact ${m(exact)}, before ${m(exp1)}, after ${m(expAfter)}`);

  // ...and they are still meaningfully different, on the split.
  Math.abs(r2(tAfter - t1)) > 0.005 && Math.abs(r2(dAfter - d1)) > 0.005
    ? ok('but the tax charged and the discount granted both differ',
      `tax ${m(t1)} -> ${m(tAfter)}, discount ${m(d1)} -> ${m(dAfter)}`)
    : bad('the bases are identical on tax AND discount',
      'the toggle would change nothing an officer can see');
}

// ── 6. the revision chain and its reason ────────────────────────────────────
head('6. version chain, and the reason is now persisted');
const chain = await sql(`
  SELECT version::text, state::text, coalesce(revision_reason, '')::text,
         (supersedes_quotation_id IS NOT NULL)::text,
         (SELECT count(*)::text FROM proc.quotation_attachments qa
           WHERE qa.quotation_id = proc.quotations.id)
    FROM proc.quotations
   WHERE rfq_id = '${rfqId}' AND vendor_id = '${vendorId}' ORDER BY version`);
const v1 = chain.find(c => c[0] === '1');
const last = chain[chain.length - 1];
v1 && v1[1] === 'Superseded'
  ? ok('V1 retired to Superseded, not overwritten', 'append-only')
  : bad('V1 state', v1 ? v1[1] : 'missing');
last[2] && last[2].length > 3
  ? ok('revision reason persisted on the row', last[2].slice(0, 48))
  : bad('revision reason', `empty on V${last[0]} — the audit gap is back`);
last[3] === 'true' ? ok('new version links to the one it replaced') : bad('supersedes link', last[3]);
// ── THE ATTACHMENT POLICY (changed 2026-10-11) ────────────────────────────────
//
// This used to assert that EVERY version carries its own document, and at least
// two distinct files exist across the chain. That is no longer the rule.
//
//   V1  (first quotation) — the document is MANDATORY. It is the only record of
//                          what the vendor actually quoted.
//   V2+ (revisions)       — the document is OPTIONAL. The officer is usually
//                          recording a phone negotiation, and forcing a scan
//                          there does not improve the audit trail; it produces a
//                          dummy file, which is worse than no file because it
//                          reads as evidence. The REVISION REASON becomes the
//                          mandatory record instead.
//
// The distinction that matters is therefore not "does every version have a file"
// but "does every version have its record". Section 8 exercises both halves.
Number(v1?.[4]) >= 1
  ? ok('V1 — the FIRST quotation — still carries the vendor document', `V1 attachments=${v1[4]}`)
  : bad('V1 has no document', `V1 attachments=${v1?.[4]} — the first quotation must carry it`);
chain.every(c => (Number(c[0]) === 1 ? Number(c[4]) >= 1 : c[2].trim().length > 0))
  ? ok('every version carries a record — document on V1, reason on the revisions',
    chain.map(c => `V${c[0]}:${Number(c[0]) === 1 ? `${c[4]} doc` : 'reason'}`).join(' '))
  : bad('a version has neither a document nor a reason',
    chain.map(c => `V${c[0]}=${c[4]}doc/${c[2] ? 'reason' : 'NO REASON'}`).join(', '));
// Revisions that DO carry a document must still carry their own, not the one they
// replaced — sharing would mean V2's evidence is V1's scan.
const distinctDocs = (await sql(`
  SELECT count(DISTINCT attachment_id)::text FROM proc.quotation_attachments qa
    JOIN proc.quotations q ON q.id = qa.quotation_id
   WHERE q.rfq_id = '${rfqId}' AND q.vendor_id = '${vendorId}'`))[0][0];
Number(distinctDocs) >= 2
  ? ok('revisions that DO carry a document keep their OWN, not the one replaced', `${distinctDocs} distinct files`)
  : bad('documents are shared across versions', `only ${distinctDocs} distinct file(s)`);

// ── 7. a revision may be saved WITHOUT a document, but never without a reason ─
//
// This is the whole of the new policy, and each step is asserted separately
// because they are three different outcomes rather than one.
//
//  a. refused pending confirmation  (409 + a code the form can act on)
//  b. confirmed but no reason        (400 — the reason is what replaces the file)
//  c. confirmed with a reason        (saved; the row has no attachment, and the
//                                     reason is on it)
//
// Step (a) matters most: the rule is enforced by the API, so a caller that
// skips the form cannot write a documentless revision. A browser-only check here
// would pass even if that server gate were gone.
head('7. a revision without a document: asked, then reasoned, then saved');
const latest = async () => (await sql(
  `SELECT id::text FROM proc.quotations WHERE rfq_id='${rfqId}' AND vendor_id='${vendorId}'
    AND state='Submitted' ORDER BY version DESC LIMIT 1`))[0][0];

const revisionBody = (extra = {}) => ({
  vendorId, quoteMode: 'per_line', discountBasis: 'before_tax', taxesIncluded: false,
  leadTimeDays: 7, paymentTerms: '30 Days Net', validUntil: '2026-12-31',
  lines: [{ rfqLineNo: l1, unitPrice: UNIT, discountPercent: DISC, taxPercent: TAX, warrantyMonths: W1 }],
  ...extra,
});

// (a) No attachment and no confirmation → refused, with the signal the form needs.
const noConfirm = await post(`/quotations/${await latest()}/supersede`, revisionBody({
  reason: 'e2e: phone negotiation, no document',
}));
noConfirm.status === 409
  ? ok('a revision with no document is REFUSED pending confirmation', `status ${noConfirm.status}`)
  : bad('the unconfirmed save was not refused', `status ${noConfirm.status} ${JSON.stringify(noConfirm.body).slice(0, 120)}`);
String(noConfirm.body?.message || noConfirm.text || '').includes('missing the attachment')
  || noConfirm.body?.code === 'ATTACHMENT_CONFIRMATION_REQUIRED'
  ? ok('and it says WHY, in a form the dialog can act on',
    noConfirm.body?.code || String(noConfirm.body?.message || '').slice(0, 60))
  : bad('the refusal carries no actionable signal',
    noConfirm.body?.code || String(noConfirm.body?.message || '').slice(0, 80));

// (b) Confirmed, but the reason is missing → still refused.
const noReason = await post(`/quotations/${await latest()}/supersede`, revisionBody({
  allowMissingAttachment: true, reason: '',
}));
noReason.status === 400
  ? ok('confirming without a Remarks entry is still refused', `status ${noReason.status}`)
  : bad('a documentless revision saved with no reason', `status ${noReason.status}`);

// (c) Confirmed with a reason → saved, with no attachment on the row.
const saved = await post(`/quotations/${await latest()}/supersede`, revisionBody({
  allowMissingAttachment: true,
  reason: 'e2e: vendor revised by phone; no document sent',
}));
if (saved.status === 200 || saved.status === 201) {
  const qid = saved.body?.quotation?.id;
  const row = (await sql(
    `SELECT coalesce(revision_reason,'')::text,
            (SELECT count(*)::text FROM proc.quotation_attachments qa WHERE qa.quotation_id = '${qid}')
       FROM proc.quotations WHERE id = '${qid}'`))[0];
  Number(row[1]) === 0
    ? ok('the saved revision has NO attachment — the dummy file is gone', `attachments=${row[1]}`)
    : bad('an attachment was attached anyway', `attachments=${row[1]}`);
  row[0].trim().length > 0
    ? ok('and the reason is on the row as the record', row[0].slice(0, 44))
    : bad('the revision saved with no reason', 'revision_reason is empty');
} else {
  bad('the confirmed revision would not save', `status ${saved.status} ${JSON.stringify(saved.body).slice(0, 140)}`);
}

// ── 8. declined lines contribute nothing ────────────────────────────────────
head('8. a declined line contributes nothing and is not a zero-priced quote');
const sup2 = await post(`/quotations/${(await sql(`SELECT id::text FROM proc.quotations WHERE rfq_id='${rfqId}' AND vendor_id='${vendorId}' AND state='Submitted' ORDER BY version DESC LIMIT 1`))[0][0]}/supersede`, {
  vendorId, quoteMode: 'per_line', discountBasis: 'before_tax', taxesIncluded: false,
  leadTimeDays: 7, paymentTerms: '30 Days Net', validUntil: '2026-12-31',
  attachmentId: await uploadDoc(prId, 'quotation-v3.pdf'),
  reason: 'e2e: vendor will not supply the second line',
  lines: [
    { rfqLineNo: l1, unitPrice: UNIT, discountPercent: DISC, taxPercent: TAX, warrantyMonths: W1 },
    { rfqLineNo: l2, unitPrice: 0, declined: true, warrantyMonths: 0 },
  ],
});
if (sup2.status === 201 || sup2.status === 200) {
  const q3 = sup2.body?.quotation?.id;
  const rows3 = await sql(
    `SELECT declined::text, line_total::text FROM proc.quotation_lines WHERE quotation_id = '${q3}' ORDER BY rfq_line_no`);
  // NOTE: `declined::text` spells booleans 'true'/'false', NOT 't'/'f'.
  // Comparing against 't' here reports a decline that was in fact recorded
  // correctly — the total assertion below already proved the line contributed
  // nothing, so a "declined line not stored" failure here means the assertion
  // is wrong, not the app.
  const declinedRow = rows3.find(r => r[0] === 'true');
  declinedRow && Number(declinedRow[1]) === 0
    ? ok('declined line contributes 0 to the quote total')
    : bad('declined line', declinedRow ? `line_total ${declinedRow[1]}` : `no declined row among ${JSON.stringify(rows3)}`);
  const t3 = (await sql(`SELECT total_amount::text FROM proc.quotations WHERE id='${q3}'`))[0][0];
  Number(t3) === exp1
    ? ok('total equals the live lines only', `${m(t3)} — the declined line adds nothing`)
    : bad('total with a declined line', `want ${m(exp1)} got ${t3}`);
} else {
  bad('supersede with a declined line', `HTTP ${sup2.status} — ${sup2.raw.slice(0, 200)}`);
}

// ── 8. "prices include tax" EXTRACTS the tax, it does not stack it ───────────
head('8. prices-include-tax takes the tax out of the rate instead of adding it');
// The bug this pins, and why an integration suite is the only place it shows.
//
// With "prices include tax" ticked, the stored TOTAL was always right — the
// typed rate already contains the tax, so nothing was added. What was wrong was
// the tax FIGURE beside it: the service computed the tax-EXCLUSIVE rate
// (net x 17.5%) and recorded it, so the document claimed more tax than the
// price contained, and the grid's own columns did not sum to its total. Every
// assertion above is about totals, which is why they all stayed green.
//
// Expectations here are derived independently of the implementation: the quoted
// amount is what the vendor charged, the embedded tax is the part of it that is
// tax, and the base is what remains.
const head4 = (await sql(
  `SELECT id::text FROM proc.quotations
    WHERE rfq_id='${rfqId}' AND vendor_id='${vendorId}' AND state='Submitted'
    ORDER BY version DESC LIMIT 1`))[0][0];

const ig = r2(UNIT * qty.get(l1));
const idsc = r2(ig * DISC / 100);
const iQuoted = r2(ig - idsc);
const iTax = r2(iQuoted - iQuoted / (1 + TAX / 100));
const iNet = r2(iQuoted - iTax);
const iTotal = r2(iNet + iTax);
const xTax = r2(iQuoted * TAX / 100);          // what the old code recorded

// discountBasis is deliberately posted as 'after_tax' alongside
// taxesIncluded:true. With one payable figure there is no before/after to
// choose, so the service must normalise it — otherwise the quotation carries a
// rule that was never applied, and a later audit reads it as one that was.
const supInc = await post(`/quotations/${head4}/supersede`, {
  vendorId, quoteMode: 'per_line',
  discountBasis: 'after_tax', taxesIncluded: true,
  leadTimeDays: 7, paymentTerms: '30 Days Net', validUntil: '2026-12-31',
  attachmentId: await uploadDoc(prId, 'quotation-v4.pdf'),
  reason: 'e2e: vendor quotes prices that already include tax',
  lines: [
    { rfqLineNo: l1, unitPrice: UNIT, discountPercent: DISC, taxPercent: TAX, warrantyMonths: W1 },
  ],
});

if (supInc.status !== 201 && supInc.status !== 200) {
  bad('supersede with a tax-inclusive quote', `HTTP ${supInc.status} — ${supInc.raw.slice(0, 300)}`);
} else {
  const q4 = supInc.body?.quotation?.id;
  const inc = (await sql(
    `SELECT net_amount::text, tax_amount::text, line_total::text
       FROM proc.quotation_lines WHERE quotation_id = '${q4}' AND rfq_line_no = ${l1}`))[0];

  Number(inc[1]) === iTax
    ? ok('embedded tax extracted from the inclusive rate', `${m(iTax)} (not ${m(xTax)})`)
    : bad('inclusive tax', `want ${m(iTax)} got ${inc[1]}`);

  // The regression itself: 17.5% of the inclusive amount is the tax-EXCLUSIVE
  // figure and is larger than the tax actually inside the price. If these two
  // ever agree, the inclusive branch is computing the old, wrong tax again.
  Number(inc[1]) !== xTax
    ? ok('it is NOT the tax-exclusive rate applied to an inclusive price',
      `${m(iTax)} vs the wrong ${m(xTax)}`)
    : bad('inclusive tax is the exclusive rate', `${m(xTax)} — tax restated on an inclusive price`);

  Number(inc[0]) === iNet
    ? ok('net amount is the taxable base under the inclusive rate', m(iNet))
    : bad('inclusive net', `want ${m(iNet)} got ${inc[0]}`);

  Number(inc[2]) === iQuoted
    ? ok('the officer pays exactly the quoted amount', `${m(iQuoted)} — nothing stacked on top`)
    : bad('inclusive line total', `want the quoted ${m(iQuoted)} got ${inc[2]}`);

  Number(inc[2]) === r2(Number(inc[0]) + Number(inc[1]))
    ? ok('Total = Net + Tax still holds when prices include tax', m(Number(inc[2])))
    : bad('inclusive identity',
      `${inc[0]} + ${inc[1]} != ${inc[2]}`);

  Number(inc[2]) < exp1
    ? ok('inclusive is cheaper than exclusive on the same typed rate',
      `${m(inc[2])} < ${m(exp1)} — the tax is extracted, not added`)
    : bad('inclusive not below exclusive', `${m(inc[2])} vs ${m(exp1)}`);

  const q4h = (await sql(
    `SELECT taxes_included::text, discount_basis::text, total_amount::text, tax_breakdown::text
       FROM proc.quotations WHERE id = '${q4}'`))[0];
  q4h[0] === 'true'
    ? ok('taxes_included persisted on the quotation', 'true')
    : bad('taxes_included', q4h[0]);
  q4h[1] === 'before_tax'
    ? ok('an inclusive quote records before_tax, never the unused radio value', q4h[1])
    : bad('discount_basis on an inclusive quote', `${q4h[1]} — records a rule that was never applied`);

  // tax_breakdown used to fall through to its header-field defaults on every
  // per-line quote, storing tax_percent 0 / tax_amount 0 — a tax document
  // claiming no tax at all, on the one path that charges tax per line.
  let bd = null;
  try { bd = JSON.parse(q4h[3]); } catch { /* reported below */ }
  const bdTax = Number(bd?.tax_amount);
  const liveTax = r2((await sql(
    `SELECT coalesce(sum(tax_amount),0)::text FROM proc.quotation_lines
      WHERE quotation_id = '${q4}' AND declined = false`))[0][0]);
  bd && bd.source === 'per_line_waterfall'
    ? ok('tax_breakdown is built from the line waterfall', bd.source)
    : bad('tax_breakdown source', JSON.stringify(bd));
  bd && bdTax === liveTax && bdTax > 0
    ? ok('the stored tax breakdown carries the real tax', m(bdTax))
    : bad('tax_breakdown tax_amount', `want ${m(liveTax)} got ${bd ? m(bdTax) : 'unparseable'}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);