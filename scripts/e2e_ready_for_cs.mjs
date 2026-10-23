// e2e_ready_for_cs.mjs — the "Ready for CS" hand-off and the quotation freeze.
//
//   node scripts/e2e_ready_for_cs.mjs
//
// Requires: Postgres on 55432 (container procurement-portal-db), the API on
// 33001, migration 064 applied.
//
// WHAT IS ACTUALLY BEING PROVEN
// ───────────────────────────────
// The claim under test is a NEGATIVE one — "no quotation will be received, no
// changes in quotations" — and a negative claim is the easiest kind to assert
// badly. Every refusal here is checked twice: that the endpoint refused, AND
// that the quotation table is byte-identical before and after. An endpoint that
// returns 400 after having already written is a green suite over a broken
// control, and this repo's DbService commits per statement, so that is a real
// failure mode rather than a hypothetical one.
//
// The three write paths are asserted separately because they fail independently:
//   1. procurement recording a quote   (RFQ_SOURCING_STAGES)
//   2. procurement revising a quote   (a different code path — it never went
//                                      through the shared helper)
//   3. a VENDOR submitting through the emailed token (never consulted the PR's
//                                      stage at all — this was the open hole)
//
// And the CS-lock regression: closing the RFQ at hand-off means cs.service now
// sees 'Closed' where it used to require 'Open'. If that widening is wrong the
// award silently no-ops, so it is asserted rather than assumed.

import { quoteBody } from './_quote_helpers.mjs';
import { execFileSync } from 'node:child_process';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const CONTAINER = process.env.PG_CONTAINER || 'procurement-portal-db';
const LAPTOP = '55555555-5555-5555-5555-555555555503';
const PEN = '55555555-5555-5555-5555-555555555505';

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
  if (c) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''}`); }
};

/** Run SQL, return the output lines. */
function sql(text) {
  const out = execFileSync('docker', [
    'exec', '-i', CONTAINER, 'psql', '-U', 'proc', '-d', 'procurementDB',
    '-X', '-q', '-A', '-t', '-c', text,
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}
/** First column of the first row. */
const sqlStr = (text) => sql(text)[0] ?? '';

/**
 * A fingerprint of every quotation on an RFQ's PR: id, state, amount, version.
 * Comparing this before and after a refusal is the assertion that matters — the
 * status code alone only proves the handler ran.
 */
function quoteFingerprint(prId) {
  return sqlStr(`
    SELECT md5(string_agg(
             q.id || ':' || q.state || ':' || q.total_amount || ':' || q.version,
             ',' ORDER BY q.id))
      FROM proc.quotations q
      JOIN proc.rfq r ON r.id = q.rfq_id
     WHERE r.pr_id = '${prId}'::uuid`);
}

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

console.log(`\n=== Ready for CS · the hand-off freeze against ${API} ===\n`);

const requester = await login('requester@pakboxes.pk');
const hod = await login('hod.sales@pakboxes.pk');
const procurement = await login('procurement@pakboxes.pk');
const cs = await login('cs@pakboxes.pk');
ok(Boolean(requester && hod && procurement && cs), 'all four logins returned a token');

const ccs = await api('/lookups/cost-centers', { token: requester });
const costCenterId = ccs.data?.[0]?.id;

// ── fixture: a PR parked at procurement review, spanning two categories so the
//    roster resolves to more than one vendor.
const lines = [
  { itemId: LAPTOP, quantity: 2, uom: 'EA', unitPriceEst: 45000 },
  { itemId: PEN, quantity: 1, uom: 'BOX', unitPriceEst: 45000 },
];
const created = await api('/pr', {
  method: 'POST', token: requester,
  body: { scope: 'Ready-for-CS fixture', expenseType: 'OPEX', costCenterId,
          requiredByDate: '2026-12-31', title: 'Ready-for-CS hand-off fixture', lines },
});
const prId = created.data?.id;
await api(`/pr/${prId}/advance`, {
  method: 'POST', token: hod,
  body: { lineDecisions: Object.fromEntries(lines.map((_, i) => [i, 'approved'])), reason: 'fixture' },
});
const stageNow = sqlStr(`SELECT status FROM proc.purchase_requisitions WHERE id='${prId}'::uuid`);
ok(stageNow === 'IN_PROCUREMENT_REVIEW', 'fixture PR is at IN_PROCUREMENT_REVIEW', stageNow);

const issued = await api(`/pr/${prId}/rfq`, { method: 'POST', token: procurement, body: {} });
const rfqId = issued.data?.rfq?.id;
const invitations = issued.data?.invitations || [];
ok(Boolean(rfqId), 'RFQ issued', issued.data?.message);
ok(invitations.length >= 1, 'at least one vendor invited', invitations.length);

// A live token for the vendor path. This is the credential — the portal has no
// login, so this is the only way a vendor can write, and the only way to prove
// the portal now refuses.
const vendorToken = invitations[0]?.token;
ok(Boolean(vendorToken), 'an invitation token was returned once, for the vendor test');

// ── 1 · the empty-RFQ gate, and that a refusal writes NOTHING ───────────────
console.log('\n--- no quotation yet: forwarding must be refused ---');

const fpBefore0 = quoteFingerprint(prId);
const rfqStateBefore0 = sqlStr(`SELECT state FROM proc.rfq WHERE id='${rfqId}'::uuid`);

const tooEarly = await api(`/pr/${prId}/ready-for-cs`, { method: 'POST', token: procurement, body: {} });
ok(tooEarly.status === 400, 'ready-for-cs is refused with no quotation in', tooEarly.status);
ok(/no quotation in/i.test(String(tooEarly.data?.message || '')),
  'the refusal names the missing quotation rather than "not permitted"',
  tooEarly.data?.message);

ok(sqlStr(`SELECT status FROM proc.purchase_requisitions WHERE id='${prId}'::uuid`) === 'IN_PROCUREMENT_REVIEW',
  'REFUSED FORWARD WROTE NOTHING: the PR did not move');
ok(sqlStr(`SELECT state FROM proc.rfq WHERE id='${rfqId}'::uuid`) === rfqStateBefore0,
  'REFUSED FORWARD WROTE NOTHING: the RFQ was not closed', { before: rfqStateBefore0 });
ok(quoteFingerprint(prId) === fpBefore0, 'REFUSED FORWARD WROTE NOTHING: quotations untouched');

// ── 2 · the hand-off itself ────────────────────────────────────────────────
console.log('\n--- one quotation on file: forwarding succeeds ---');

const recorded = await api(`/rfq/${rfqId}/quotations`, {
  method: 'POST', token: procurement,
  body: await quoteBody(prId, procurement, invitations[0].vendor_id,
    [{ rfqLineNo: 1, unitPrice: 43000 }, { rfqLineNo: 2, unitPrice: 9000 }]),
});
ok([200, 201].includes(recorded.status), 'a quotation is on file', recorded.status);

const forwarded = await api(`/pr/${prId}/ready-for-cs`, { method: 'POST', token: procurement, body: {} });
ok([200, 201].includes(forwarded.status), 'ready-for-cs accepted', forwarded.data?.message || forwarded.status);
ok(forwarded.data?.nextStage === 'QUOTES_RECEIVED', 'the PR lands on QUOTES_RECEIVED', forwarded.data?.nextStage);
ok(forwarded.data?.rfq === issued.data.rfq.rfq_number, 'the response names the RFQ it closed', forwarded.data?.rfq);
ok(forwarded.data?.quotations === 1, 'it reports how many quotations CS will score', forwarded.data?.quotations);

ok(sqlStr(`SELECT status FROM proc.purchase_requisitions WHERE id='${prId}'::uuid`) === 'QUOTES_RECEIVED',
  'the PR really moved', sqlStr(`SELECT status FROM proc.purchase_requisitions WHERE id='${prId}'::uuid`));
ok(sqlStr(`SELECT state FROM proc.rfq WHERE id='${rfqId}'::uuid`) === 'Closed',
  'the RFQ is CLOSED at hand-off — this is what plugs the vendor portal',
  sqlStr(`SELECT state FROM proc.rfq WHERE id='${rfqId}'::uuid`));

// ── 3 · the three write paths, each refused and each proven inert ──────────
console.log('\n--- after the hand-off: nothing may be received or changed ---');

const fpAfter = quoteFingerprint(prId);
ok(Boolean(fpAfter), 'a fingerprint exists to compare refusals against');

// 3a · procurement recording a NEW quotation
const rec2 = await api(`/rfq/${rfqId}/quotations`, {
  method: 'POST', token: procurement,
  body: await quoteBody(prId, procurement, invitations[1]?.vendor_id || invitations[0].vendor_id,
    [{ rfqLineNo: 1, unitPrice: 1 }]),
});
ok(rec2.status === 400, 'procurement cannot record a new quotation', rec2.status);

// 3b · procurement REVISING an existing one — a different code path
const liveQuoteId = sqlStr(`
  SELECT q.id FROM proc.quotations q JOIN proc.rfq r ON r.id=q.rfq_id
   WHERE r.pr_id='${prId}'::uuid AND q.state='Submitted' LIMIT 1`);
const revised = await api(`/quotations/${liveQuoteId}/supersede`, {
  method: 'POST', token: procurement,
  body: await quoteBody(prId, procurement, invitations[0].vendor_id,
    [{ rfqLineNo: 1, unitPrice: 1 }], { revisionReason: 'e2e: must be refused' }),
});
ok(revised.status === 400, 'procurement cannot revise an existing quotation', revised.status);

// 3c · the vendor, through the emailed token — the path that was open
const vendorSubmit = await api(`/vendor-portal/${vendorToken}/quote`, {
  method: 'POST', token: null,
  body: { lines: [{ rfqLineNo: 1, unitPrice: 1 }], leadTimeDays: 5 },
});
ok(vendorSubmit.status >= 400, 'the vendor portal refuses the submission', vendorSubmit.status);

ok(quoteFingerprint(prId) === fpAfter,
  'ALL THREE REFUSALS WROTE NOTHING: every quotation is byte-identical',
  { before: fpAfter, after: quoteFingerprint(prId) });

// 3d · and the database itself refuses, independently of any service
let triggerRefused = false, triggerMessage = '';
try {
  sql(`UPDATE proc.quotations SET total_amount = total_amount + 1 WHERE id='${liveQuoteId}'::uuid`);
} catch (e) {
  triggerRefused = true;
  triggerMessage = String(e.stderr || e.message || e);
}
ok(triggerRefused, 'the DATABASE refuses a direct price edit (migration 064)');
ok(/quotations are closed|cannot be edited/i.test(triggerMessage),
  'the trigger explains itself', triggerMessage.slice(0, 160));

// ── 4 · the CS lock still works on a Closed RFQ (the regression) ───────────
console.log('\n--- the CS screen, on the Closed RFQ the hand-off produced ---');

// The screen a hand-off lands on must be USABLE, not just present. It used to
// render an empty bid table with no control anywhere in the UI that calls
// POST /pr/:id/cs, so procurement forwarded a PR and arrived at a dead end.
const before = await api(`/pr/${prId}/cs`, { token: cs });
ok(before.data?.cs === null, 'the CS screen opens with no statement yet', before.data?.cs);
ok(before.data?.live_quotes === 1,
  'it reports how many live quotations are waiting to be scored', before.data?.live_quotes);
ok(before.data?.can_generate === true,
  'it tells CS that generating is allowed here', before.data?.can_generate);

const gen = await api(`/pr/${prId}/cs`, { method: 'POST', token: cs });
ok([200, 201].includes(gen.status), 'a comparative statement generates on the forwarded PR',
  gen.data?.message || gen.status);
const csId = gen.data?.cs?.id || gen.data?.id;
ok(Boolean(csId), 'the CS has an id to lock', { csId, data: gen.data });

// The lock needs the winner named. Read it from the CS's own scored lines
// rather than from the render payload — that payload's shape has moved between
// waves (`bids` -> `scores`), and a test that breaks when a field is renamed is
// a test that stops being run.
const winnerVendorId = sqlStr(
  `SELECT vendor_id FROM proc.cs_lines WHERE cs_id='${csId}'::uuid ORDER BY rank LIMIT 1`);
ok(Boolean(winnerVendorId), 'the CS has scored vendors to award', winnerVendorId);

const locked = await api(`/cs/${csId}/lock`, {
  method: 'POST', token: cs, body: { winnerVendorId },
});
ok([200, 201].includes(locked.status), 'the CS locks', locked.data?.message || locked.status);

const rfqAfterLock = sqlStr(`SELECT state FROM proc.rfq WHERE id='${rfqId}'::uuid`);
ok(rfqAfterLock === 'Awarded',
  'THE REGRESSION THIS GUARDS: a Closed RFQ still reaches Awarded on lock',
  rfqAfterLock);
ok(sqlStr(`SELECT status FROM proc.purchase_requisitions WHERE id='${prId}'::uuid`) === 'CS_LOCKED',
  'the PR entered the governance chain');

// ── summary ────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);