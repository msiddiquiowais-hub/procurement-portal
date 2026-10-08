// Wave 2 step 2 — quotations + supersede (append-only versioning).
//
//   node scripts/e2e_quotations.mjs
//
// Requires: Postgres on 55432, the API on 33001, migrations 025 + 026 applied.
//
// The load-bearing property is the plan's definition-of-done item 7:
//
//   "Quotation versions are append-only — no UPDATE ever rewrites a prior
//    version's price; it marks it Superseded and inserts a new row."
//
// So the strongest assertion here is a byte-level one: snapshot v1's money
// columns, run a revision, and prove every one of them is unchanged on disk.
// A service that quietly rewrote the row would pass a naive "v1 is Superseded
// and v2 exists" test while still destroying the audit history.
//
// Also covered: the Q2 no-sealing guarantee, the Q1 vocabulary mapping, the
// per-line math, and the rfq_lines FK that made step 1's omission fatal.

import { execFileSync } from 'child_process';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const LAPTOP = '55555555-5555-5555-5555-555555555503'; // IT_HARDWARE, under 100k -> IN_PROCUREMENT_REVIEW

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

/** Read-only DB probe: the ground truth the API's own response is checked against. */
function psql(sql) {
  return execFileSync('docker', ['exec', '-i', 'procurement-portal-db', 'psql',
    '-U', 'proc', '-d', 'procurementDB', '-X', '-q', '-t', '-A', '-F', '|', '-f', '-'],
    { input: sql, encoding: 'utf8' }).trim();
}

/**
 * Normalise a raw psql cell for comparison.
 * This probe uses plain psql, NOT the API's CSV bridge, so it gets Postgres's
 * native rendering: booleans are 'true'/'false' (not the bridge's 't'/'f') and
 * numerics carry scale ('0.00', '99000.00'). Comparing raw text against
 * hand-written expectations produces failures that look like data bugs.
 */
const cell = (v) => {
  const t = String(v).trim();
  if (t === 't' || t === 'true') return 'true';
  if (t === 'f' || t === 'false') return 'false';
  const n = Number(t);
  if (t !== '' && Number.isFinite(n)) return String(n);
  return t;
};

const login = async (email) => (await api('/auth/login', { method: 'POST', body: { email, password: 'demo' } })).data?.token;

console.log(`\n=== Wave 2 step 2 · quotations + supersede against ${API} ===\n`);

const requester = await login('requester@pakboxes.pk');
const hod = await login('hod.sales@pakboxes.pk');
const procurement = await login('procurement@pakboxes.pk');
ok(Boolean(requester && hod && procurement), 'logins returned tokens');

// ── 1 · fixture: PR -> HOD -> procurement review -> RFQ ─────────────────────
console.log('\n--- fixture: a PR with an issued RFQ ---');

const ccs = await api('/lookups/cost-centers', { token: requester });
const costCenterId = ccs.data?.[0]?.id;

const created = await api('/pr', {
  method: 'POST', token: requester,
  body: {
    scope: 'Step 2 fixture', expenseType: 'OPEX', costCenterId,
    requiredByDate: '2026-12-31', title: 'Quote versioning fixture',
    description: 'Two lines, so per-line pricing is exercised.',
    lines: [
      { itemId: LAPTOP, quantity: 2, uom: 'EA', unitPriceEst: 45000 },
      { itemId: LAPTOP, quantity: 1, uom: 'EA', unitPriceEst: 9000 },
    ],
  },
});
const prId = created.data?.id;
ok(Boolean(prId), 'light PR created with 2 lines', created.data);

const adv = await api(`/pr/${prId}/advance`, {
  method: 'POST', token: hod,
  body: { lineDecisions: { 0: 'approved', 1: 'approved' }, reason: 'step 2' },
});
ok(adv.data?.nextStage === 'IN_PROCUREMENT_REVIEW', 'PR reached IN_PROCUREMENT_REVIEW', adv.data?.nextStage);

const issued = await api(`/pr/${prId}/rfq`, { method: 'POST', token: procurement, body: {} });
ok([200, 201].includes(issued.status), 'RFQ issued', issued.data?.message);
const rfqId = issued.data?.rfq?.id;
const invites = issued.data?.invitations || [];
if (!rfqId || invites.length !== 3) {
  console.log('\n  ABORT  fixture did not produce a 3-vendor RFQ.');
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(1);
}

const v1Vendor = invites[0].vendor_id;
const v2Vendor = invites[1].vendor_id;

// rfq_lines is the table step 1 forgot to populate; without it a per-line
// quote is rejected by a composite FK.
const rfqLines = psql(`
  SET app.bypass_rls = 'true';
  SELECT line_no || '|' || quantity || '|' || uom FROM proc.rfq_lines
   WHERE rfq_id = '${rfqId}' ORDER BY line_no;`).split('\n').filter(Boolean);
ok(rfqLines.length === 2, 'the RFQ snapshotted both PR lines into rfq_lines', rfqLines);
ok(rfqLines[0]?.startsWith('1|2'), 'line 1 carries its quantity (2 EA)', rfqLines[0]);

// ── 2 · record V1 ──────────────────────────────────────────────────────────
console.log('\n--- POST /rfq/:id/quotations — V1 ---');

const v1 = await api(`/rfq/${rfqId}/quotations`, {
  method: 'POST', token: procurement,
  body: {
    vendorId: v1Vendor, quoteMode: 'per_line', currency: 'PKR',
    subtotal: 99000, taxPercent: 16, freight: 0,
    leadTimeDays: 14, warrantyMonths: 36, validityDays: 30, taxesIncluded: false,
    paymentTerms: '30 days net', notes: 'Delivered to Lahore HQ.',
    // line 1: 2 units @ 45,000 = 90,000. line 2: 1 unit @ 9,000 = 9,000.
    lines: [{ rfqLineNo: 1, unitPrice: 45000 }, { rfqLineNo: 2, unitPrice: 9000 }],
  },
});
ok([200, 201].includes(v1.status), 'V1 recorded', { status: v1.status, msg: v1.data?.message });
const v1Id = v1.data?.quotation?.id;
ok(Boolean(v1Id), 'V1 id returned');
ok(v1.data?.quotation?.version === 1 && v1.data?.quotation?.state === 'Submitted',
  'V1 is version 1, state Submitted (the prototype calls this ACTIVE)', v1.data?.quotation);
ok(v1.data?.quotation?.prototype_state === 'ACTIVE',
  'the Q1 mapping exposes the prototype\'s own word for the chip', v1.data?.quotation?.prototype_state);

// total = 90,000 + 9,000 = 99,000, which equals subtotal with 0 tax applied
// (taxAmount is recorded separately, as the prototype does).
ok(Number(v1.data?.quotation?.total_amount) === 99000,
  'the per-line sum becomes the grand total (90,000 + 9,000)', v1.data?.quotation?.total_amount);
ok(Number(v1.data?.quotation?.normalized_total_pkr) === 99000,
  'normalized_total_pkr = total x fx_rate (fx defaults to 1)', v1.data?.quotation?.normalized_total_pkr);

// the invitation flips to submitted, which is what the roster card reads
const invAfter = psql(`
  SET app.bypass_rls = 'true';
  SELECT submitted FROM proc.rfq_invitations
   WHERE rfq_id = '${rfqId}' AND vendor_id = '${v1Vendor}';`);
ok(cell(invAfter) === 'true', 'the roster invitation flipped to submitted', invAfter);

// ── 3 · the prototype's gates ──────────────────────────────────────────────
console.log('\n--- gates ---');

const asRequester = await api(`/rfq/${rfqId}/quotations`, {
  method: 'POST', token: requester, body: { vendorId: v1Vendor, totalAmount: 1 },
});
ok(asRequester.status === 403, 'a requester cannot record quotes', { status: asRequester.status });
ok(/Only Procurement/i.test(asRequester.data?.message || ''),
  "the rejection carries lightProcReceiveQuote()'s own words", asRequester.data?.message);

const dupe = await api(`/rfq/${rfqId}/quotations`, {
  method: 'POST', token: procurement, body: { vendorId: v1Vendor, totalAmount: 5 },
});
ok(dupe.status === 400, 'a second live quote for the same vendor is refused', { status: dupe.status });
ok(/already has a live quote \(V1\)/.test(dupe.data?.message || ''), 'the refusal points at /supersede', dupe.data?.message);

const notInvited = await api(`/rfq/${rfqId}/quotations`, {
  method: 'POST', token: procurement, body: { vendorId: '44444444-4444-4444-4444-444444444401', totalAmount: 5 },
});
// Acme may or may not already be on the roster; either way it must not create
// a quote for a vendor with no invitation row.
const acmeOnRoster = invites.some(i => i.vendor_id === '44444444-4444-4444-4444-444444444401');
if (acmeOnRoster) {
  ok(dupe.status === 400, 'Acme is on this roster, so the duplicate-vendor gate applies', { status: dupe.status });
} else {
  ok(notInvited.status === 400, 'a vendor with no invitation row cannot be quoted', { status: notInvited.status });
  ok(/not on the RFQ roster/.test(notInvited.data?.message || ''), 'the refusal names the missing invitation', notInvited.data?.message);
}

const badLine = await api(`/rfq/${rfqId}/quotations`, {
  method: 'POST', token: procurement,
  body: { vendorId: v2Vendor, quoteMode: 'per_line', lines: [{ rfqLineNo: 99, unitPrice: 10 }] },
});
ok(badLine.status === 400, 'a line number that is not on the RFQ is refused', { status: badLine.status });
ok(/line 99 is not on this RFQ/.test(badLine.data?.message || ''), 'the refusal names the bad line', badLine.data?.message);

const mismatch = await api(`/rfq/${rfqId}/quotations`, {
  method: 'POST', token: procurement,
  body: {
    vendorId: v2Vendor, quoteMode: 'per_line', totalAmount: 500,
    lines: [{ rfqLineNo: 1, unitPrice: 45000 }],
  },
});
ok(mismatch.status === 400, 'a stated total that contradicts the line sum is refused', { status: mismatch.status });

// ── 4 · declined line ──────────────────────────────────────────────────────
console.log('\n--- the per-line declined checkbox ---');

const v2 = await api(`/rfq/${rfqId}/quotations`, {
  method: 'POST', token: procurement,
  body: {
    vendorId: v2Vendor, quoteMode: 'per_line',
    paymentTerms: '50% advance',
    // Line 2 is DECLINED: the vendor will not supply it. That is not a zero
    // price, and the grand total must exclude it entirely.
    lines: [{ rfqLineNo: 1, unitPrice: 47000 }, { rfqLineNo: 2, unitPrice: 0, declined: true, remarks: 'Out of stock' }],
  },
});
ok([200, 201].includes(v2.status), 'V1 for the second vendor recorded with a declined line', v2.data?.message);
ok(Number(v2.data?.quotation?.total_amount) === 94000,
  'a declined line contributes nothing: 2 x 47,000 = 94,000', v2.data?.quotation?.total_amount);

const declinedRow = psql(`
  SET app.bypass_rls = 'true';
  SELECT declined || '|' || total_price FROM proc.quotation_lines ql
    JOIN proc.quotations q ON q.id = ql.quotation_id
   WHERE q.id = '${v2.data?.quotation?.id}' AND ql.rfq_line_no = 2;`)
  .split('|').map(cell).join('|');
ok(declinedRow === 'true|0', 'the declined line is stored as declined with a zero total', declinedRow);

// ── 5 · THE APPEND-ONLY PROOF ──────────────────────────────────────────────
console.log('\n--- append-only: v1 must be byte-identical after a revision ---');

const moneyCols = 'id, version, state, total_amount, currency, fx_rate, normalized_total_pkr, ' +
  'lead_time_days, warranty_months, taxes_included, tax_breakdown, validity_days, ' +
  'payment_terms, notes, quote_mode, submitted_at, open_at';
const v1Before = psql(`
  SET app.bypass_rls = 'true';
  SELECT ${moneyCols} FROM proc.quotations WHERE id = '${v1Id}';`);
const v1LinesBefore = psql(`
  SET app.bypass_rls = 'true';
  SELECT rfq_line_no || '|' || unit_price || '|' || total_price || '|' || declined
    FROM proc.quotation_lines WHERE quotation_id = '${v1Id}' ORDER BY rfq_line_no;`);
ok(v1Before.length > 0, 'snapshotted v1 before the revision');

const rev = await api(`/quotations/${v1Id}/supersede`, {
  method: 'POST', token: procurement,
  body: {
    vendorId: v1Vendor, quoteMode: 'per_line',
    subtotal: 92000, taxPercent: 16, leadTimeDays: 10, warrantyMonths: 24,
    paymentTerms: '30 days net', notes: 'Revised after negotiation.',
    lines: [{ rfqLineNo: 1, unitPrice: 43000 }, { rfqLineNo: 2, unitPrice: 6000 }],
  },
});
ok([200, 201].includes(rev.status), 'revision recorded as a new version', { status: rev.status, msg: rev.data?.message });
ok(rev.data?.quotation?.version === 2, 'the new version is V2', rev.data?.quotation?.version);
ok(rev.data?.quotation?.supersedes_quotation_id === v1Id, 'V2 links back to V1', rev.data?.quotation);
ok(rev.data?.superseded?.state === 'Superseded', 'the prior version reports Superseded', rev.data?.superseded);
ok(/^V1 superseded by V2/.test(rev.data?.transition || ''), 'the transition reads like the prototype audit note', rev.data?.transition);
ok(Number(rev.data?.quotation?.total_amount) === 92000,
  'V2 total = 2 x 43,000 + 1 x 6,000 = 92,000', rev.data?.quotation?.total_amount);

const v1After = psql(`
  SET app.bypass_rls = 'true';
  SELECT ${moneyCols} FROM proc.quotations WHERE id = '${v1Id}';`);
const v1LinesAfter = psql(`
  SET app.bypass_rls = 'true';
  SELECT rfq_line_no || '|' || unit_price || '|' || total_price || '|' || declined
    FROM proc.quotation_lines WHERE quotation_id = '${v1Id}' ORDER BY rfq_line_no;`);

// v1's state is the ONLY thing allowed to differ. Everything money-shaped must
// be byte-identical, which is what "no UPDATE ever rewrites a prior version's
// price" means in practice.
ok(stripState(v1Before) === stripState(v1After),
  'v1 is byte-identical after the revision apart from its state',
  { before: stripState(v1Before), after: stripState(v1After) });
ok(v1LinesBefore === v1LinesAfter, 'v1 line prices are byte-identical too',
  { before: v1LinesBefore, after: v1LinesAfter });
ok(v1After.includes('|Superseded|'), 'and that one permitted change is exactly state -> Superseded');

// Scope to THIS run's RFQ. Earlier runs against a shared dev database left
// their own quotes behind, and an unscoped query would assert on those.
const chain = psql(`
  SET app.bypass_rls = 'true';
  SELECT version || '|' || state || '|' || COALESCE(supersedes_quotation_id::text, '-')
    FROM proc.quotations
   WHERE rfq_id = '${rfqId}' AND vendor_id = '${v1Vendor}'
   ORDER BY version;`).split('\n');
ok(chain.length === 2, 'the vendor now has exactly 2 quotation rows on this RFQ', chain);
ok(chain[0] === '1|Superseded|-', 'V1 is Superseded', chain);
ok(chain[1] === `2|Submitted|${v1Id}`, 'V2 is Submitted and points at V1', chain);

// ── 6 · supersede guards ───────────────────────────────────────────────────
console.log('\n--- supersede / withdraw guards ---');

const again = await api(`/quotations/${v1Id}/supersede`, {
  method: 'POST', token: procurement, body: { vendorId: v1Vendor, totalAmount: 1 },
});
ok(again.status === 400, 'a Superseded version cannot be superseded again', { status: again.status });
ok(/only a live quote can be revised/i.test(again.data?.message || ''), 'the guard names the live-quote rule', again.data?.message);

const v2Id = rev.data?.quotation?.id;
const v3 = await api(`/quotations/${v2Id}/supersede`, {
  method: 'POST', token: procurement,
  body: { vendorId: v1Vendor, quoteMode: 'per_line', lines: [{ rfqLineNo: 1, unitPrice: 41000 }] },
});
ok([200, 201].includes(v3.status), 'a third revision mints V3', v3.data?.message);
ok(v3.data?.quotation?.version === 3, 'the chain keeps counting up', v3.data?.quotation?.version);
ok(Number(v3.data?.quotation?.total_amount) === 82000, 'V3 priced only line 1: 2 x 41,000 = 82,000', v3.data?.quotation?.total_amount);

const v2Immutable = psql(`
  SET app.bypass_rls = 'true';
  SELECT version || '|' || state || '|' || total_amount FROM proc.quotations WHERE id = '${v2Id}';`);
ok(v2Immutable.split('|').map(cell).join('|') === '2|Superseded|92000',
  'V2 kept its own total after V3 superseded it', v2Immutable);

const crossVendor = await api(`/quotations/${v3.data?.quotation?.id}/supersede`, {
  method: 'POST', token: procurement, body: { vendorId: v2Vendor, totalAmount: 1 },
});
ok(crossVendor.status === 400, 'a revision cannot be switched to a different vendor', { status: crossVendor.status });

const withdraw = await api(`/quotations/${v3.data?.quotation?.id}/withdraw`, {
  method: 'POST', token: procurement, body: { reason: 'Vendor withdrew after repricing' },
});
ok([200, 201].includes(withdraw.status), 'the live quote can be withdrawn', withdraw.data?.message);
ok(withdraw.data?.quotation?.state === 'Withdrawn', 'state is Withdrawn (the prototype VOID)', withdraw.data?.quotation);
ok(withdraw.data?.prototype_state === 'VOID', 'the response reports the prototype\'s word', withdraw.data?.prototype_state);
ok(/^V3 withdrawn/.test(withdraw.data?.transition || ''), 'the transition is recorded', withdraw.data?.transition);

const wdImmutable = psql(`
  SET app.bypass_rls = 'true';
  SELECT version || '|' || state || '|' || total_amount FROM proc.quotations WHERE id = '${v3.data?.quotation?.id}';`);
ok(wdImmutable.split('|').map(cell).join('|') === '3|Withdrawn|82000',
  'withdrawing froze the amount, it did not clear it', wdImmutable);

const doubleWithdraw = await api(`/quotations/${v3.data?.quotation?.id}/withdraw`, {
  method: 'POST', token: procurement, body: { reason: 'again' },
});
ok(doubleWithdraw.status === 400, 'a Withdrawn quote cannot be withdrawn again', { status: doubleWithdraw.status });

// ── 7 · Q2 no sealing, and the Versions Panel payload ──────────────────────
console.log('\n--- Q2: no sealing, no waiting period ---');

const seal = psql(`
  SET app.bypass_rls = 'true';
  SELECT length(sealed_hash) || '|' || (open_at <= now()) FROM proc.quotations WHERE id = '${v1Id}';`);
ok(seal.split('|').map(cell).join('|') === '64|true',
  'sealed_hash is a real 64-char digest and open_at is already past (inert)', seal);
ok(psql(`
  SET app.bypass_rls = 'true';
  SELECT count(*) FROM pg_trigger
   WHERE tgrelid = 'proc.quotations'::regclass AND NOT tgisinternal
     AND pg_get_triggerdef(oid) ILIKE '%open_at%'
     OR (tgrelid = 'proc.quotations'::regclass AND NOT tgisinternal
         AND pg_get_triggerdef(oid) ILIKE '%sealed_hash%');`) === '0',
  'no trigger on proc.quotations reads open_at or sealed_hash — nothing gates visibility');

const panel = await api(`/pr/${prId}/quotes`, { token: procurement });
ok(panel.status === 200, 'GET /pr/:id/quotes 200', panel.status);
ok(panel.data?.rfq?.id === rfqId, 'the panel resolves the PR\'s RFQ');
const pv = panel.data?.vendors?.find((v) => v.vendor_id === v1Vendor);
ok(Boolean(pv), 'the vendor appears in the panel', panel.data?.vendors?.map((v) => v.vendor_code));
ok(pv?.versions?.length === 3, 'all three versions are in the panel', pv?.versions?.length);
ok(pv?.versions?.[0]?.version === 1 && pv?.versions?.[2]?.version === 3, 'versions ascend, as the panel walks them', pv?.versions?.map((v) => v.version));
ok(pv?.versions?.every((v, i) => i === 0 || pv.versions[i - 1].version < v.version),
  'the chain never goes backwards');
ok(pv?.active === null, 'with V3 withdrawn there is no live version, so active is null', pv?.active);
ok(panel.data?.totals?.text === `${panel.data?.totals?.received} of ${panel.data?.totals?.invited} quote` +
  `${panel.data?.totals?.invited === 1 || panel.data?.totals?.received === 1 ? '' : 's'} received - ` +
  `${panel.data?.totals?.pending} pending`,
  'the tally is the prototype\'s own sentence', panel.data?.totals);

const liveVendor = panel.data?.vendors?.find((v) => v.vendor_id === v2Vendor);
ok(liveVendor?.active?.version === 1, 'the untouched vendor still has a live V1', liveVendor?.active);
ok(liveVendor?.active?.prototype_state === 'ACTIVE', 'and the chip word is ACTIVE', liveVendor?.active);

// ── summary ────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

// The one change a revision is allowed to make to a prior version: its state.
// moneyCols starts id, version, state — so field index 2 is the state.
function stripState(row) {
  const parts = row.split('|');
  parts[2] = '<STATE>';
  return parts.join('|');
}
