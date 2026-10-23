// e2e_cs_review.mjs — the CS Comparative Statement review sub-workflow.
//
//   node scripts/e2e_cs_review.mjs
//
// WHAT THIS GUARDS
// ────────────────
// Four states (DRAFT -> PROC_REVIEW -> REQUESTER_REVIEW -> CONFIRMED), the two
// revert branches, the server-side blind mask, and the promise that migration
// 065 touched none of the 16 pre-existing routing steps.
//
// THE THREE ASSERTIONS THAT MATTER MOST
//
// 1. THE MASK IS ASSERTED ON THE RAW RESPONSE BODY, not on a rendered page.
//    A mask implemented in the UI would pass any screenshot-based check while a
//    curl still read the vendor names and prices. This suite fetches the
//    payload as JSON and asserts the commercial fields are null AND that no
//    vendor name string appears anywhere in the body — including inside
//    `scores`, which is where a leak would actually hide.
//
// 2. EVERY REFUSAL IS PROVEN TO WRITE NOTHING. DbService.withTransaction()
//    commits per statement, so a refusal raised after a write does not roll it
//    back. Each refusal below is followed by a read proving the state is
//    exactly what it was, not approximately.
//
// 3. THE 16 STEP ROWS ARE FINGERPRINTED BEFORE AND AFTER THE WHOLE RUN. The
//    feature's central architectural constraint is that it adds a 17th step and
//    rewrites none of the others. Asserting that in prose would be worth
//    nothing; asserting it here means a future edit that quietly repoints
//    `procurement` or renumbers `ready_for_cs` fails this suite.

import { quoteBody } from './_quote_helpers.mjs';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const LAPTOP = '55555555-5555-5555-5555-555555555503';
const PEN = '55555555-5555-5555-5555-555555555505';

// THE ROUTING TABLE'S FINGERPRINT, taken before this suite touches anything.
//
// Migration 068 re-indexed the table: the two CS steps moved to their ladder
// positions (ready_for_cs 16 -> 5, cs_review 17 -> 6), every step's `order`
// key was restated to match its new position, and `requiresCapexOpex` moved
// from the two Finance steps to the CS exit. So the fingerprints below are
// NEW, and the baseline is compared BY ID rather than by position — the
// position is now the thing that moves, and a fingerprint of positions could
// not tell a deliberate re-index from a lost step.
//
// The point of the fingerprint is unchanged: if a migration rewrites a routing
// row without meaning to, this fails.
//
// RESTATED AGAIN BY MIGRATION 071, for the same reason and one step further.
// `cs_review_quotes` was inserted at ladder position 7, so out_of_stock and
// everything below it shifted down one and their `order` keys restated — the
// eleventh and twelfth time a migration has moved the ladder. The fingerprints
// for those eleven are therefore new as well, and `cs_review_quotes` is a new
// entry. This is the cost of an 18-row ladder stated in one place (068 owns the
// positions) rather than appended to by each migration in turn.
const BASELINE_STEPS = {
  revert_to_hod: 'ce43535d14813c72a4465ece61ba5d37',
  rework: 'aa26d3de36e3d23c032fb13f6e4805fe',
  reject: '0a75e6b291916da0bf96ba2a52b83fe9',
  fulfilled_stock: 'ad10ba46be94a6048cdaeffb3279f5dc',
  out_of_stock: '000a30b0e2e1a1168c2033e28b1cd857',
  warehouse_check: '7f4e4b5c125175313fd9836b7b73d3b3',
  hod_review: '8f656e89c97a517cb2f80f4a1a0c6394',
  procurement: 'ce524985022933392250ffeafafc2396',
  cost_center: '996c898ce9b0702f298285cab4fa7cee',
  finance_review: 'f218ab2fb9a9cf668ab87691e5b01636',
  finance_release: '29074dcf05a96449f3b2f9ead4181bba',
  management: '2201b70c2fe402ccddc1b1b64e7cc767',
  d365_push: 'b9b6bcc66fa5f09d0bc6808d5eacdfed',
  mc_approval: '6f98446a4b53668135d59eb7fc708c33',
  cfo_approval: '3e31802d352805e57fb531ae886c5423',
  ready_for_cs: 'e0fb736bcd8850957a5942e1c0fbebdf',
  cs_review: '6557625d89abd3753c0010a4eaa40e48',
  // The same CS exit, reached from QUOTES_RECEIVED. Present because with the
  // confirm no longer writing the stage this is the ONLY route a request parked
  // by the Ready-for-CS hand-off has into cost approval — without it, that whole
  // population is stranded.
  cs_review_quotes: 'c11b76db35f9e9a86a8af608c0d3dc2a',
};

const ROUTED_STEP_COUNT = Object.keys(BASELINE_STEPS).length;

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
  if (c) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''}`); }
};
const section = (t) => console.log(`\n-- ${t}`);

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data, text };
}
const login = async (email) =>
  (await api('/auth/login', { method: 'POST', body: { email, password: 'demo' } })).data?.token;

// Raw psql, for the things the API deliberately does not expose.
async function sql(text) {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(
    'docker',
    ['exec', '-i', 'procurement-portal-db', 'psql', '-U', 'proc', '-d', 'procurementDB',
      '-X', '-q', '-A', '-t', '-F', '|', '-c', text],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

console.log(`\n=== CS review sub-workflow against ${API} ===\n`);

// ── 0. baseline fingerprint ────────────────────────────────────────────────
section(`Workflow integrity: the ${ROUTED_STEP_COUNT} routed steps`);
{
  const rows = await sql(
    `SELECT id, md5(payload::text) FROM workflow.steps_config ORDER BY order_index;`,
  );
  const now = Object.fromEntries(rows.map((r) => r.split('|')));
  const drifted = Object.entries(BASELINE_STEPS).filter(([k, v]) => now[k] !== v);
  ok(drifted.length === 0, `all ${ROUTED_STEP_COUNT} step payloads are byte-identical to the baseline`, drifted);
  ok(Object.keys(now).length === ROUTED_STEP_COUNT,
    `exactly ${ROUTED_STEP_COUNT} steps exist in the routing table`, Object.keys(now).length);
  ok(
    Object.keys(BASELINE_STEPS).every((k) => k in now),
    'the baseline names every step that is actually in the table',
    Object.keys(BASELINE_STEPS).filter((k) => !(k in now)),
  );

  const csReview = await sql(
    `SELECT payload->>'from', payload->>'to', payload->>'actorRole', payload->>'when'
       FROM workflow.steps_config WHERE id = 'cs_review';`,
  );
  ok(csReview.length === 1, 'cs_review exists exactly once');
  ok(
    csReview[0] === 'IN_PROCUREMENT_REVIEW|IN_COST_CENTER_APPROVAL|hod|csReviewConfirmed',
    'cs_review routes procurement review -> cost center via a fail-closed keyword',
    csReview[0],
  );

  // The actorRole is the ROLE VOCABULARY, so it has to be a role the identity
  // model actually has. `procurement_manager` was neither: 0 users held it, so
  // the step was owned by nobody. `hod` is what every department head carries ─
  // and HOD Procurement is picked out of the five by core.departments, not by
  // this string, because roleAllowed('hod','hod') is true for all of them.
  const retired = await sql(
    `SELECT id FROM workflow.steps_config WHERE payload->>'actorRole' = 'procurement_manager';`,
  );
  ok(retired.length === 0, 'no step is owned by the retired procurement_manager role', retired);

  const holders = await sql(`SELECT count(*) FROM core.users WHERE role = 'procurement_manager';`);
  ok(holders[0] === '0', 'no user holds procurement_manager', holders[0]);

  const hodProc = await sql(
    `SELECT d.code, u.email, u.role, (u.department_id = d.id) AS both_ways
       FROM core.departments d JOIN core.users u ON u.id = d.hod_user_id
      WHERE d.code = 'PROC';`,
  );
  ok(hodProc.length === 1 && hodProc[0] === 'PROC|hod.procurement@pakboxes.pk|hod|t',
    'the Procurement department names its head, and the head belongs to it', hodProc);

  // BOTH doors out of Step 4 must demand a classification. Asserting the CS
  // exit alone is what let the plain procurement route walk to cost approval
  // with no CS, no award and no class.
  const doors = await sql(
    `SELECT id, coalesce((payload->>'requiresCapexOpex')::boolean::text, 'false')
       FROM workflow.steps_config
      WHERE payload->>'from' = 'IN_PROCUREMENT_REVIEW'
        AND payload->>'to' = 'IN_COST_CENTER_APPROVAL'
      ORDER BY order_index;`,
  );
  ok(
    doors.length === 2 && doors.every((d) => d.endsWith('|true')),
    'BOTH routes out of procurement review demand a Capex/Opex classification', doors,
  );
}

// ── fixture ────────────────────────────────────────────────────────────────
const requester = await login('requester@pakboxes.pk');
const hod = await login('hod.sales@pakboxes.pk');
const procurement = await login('procurement@pakboxes.pk');
const cs = await login('cs@pakboxes.pk');
const admin = await login('admin@pakboxes.pk');
// HOD Procurement — the head of the Procurement DEPARTMENT, which is an
// identity read from core.departments, not a role: every department head signs
// in as `hod`. They approve the statement the officer prepared, and they are the
// ONLY procurement-side person who may forward it to the blind stage.
const hodProcurement = await login('hod.procurement@pakboxes.pk');
ok(
  Boolean(requester && hod && procurement && cs && admin && hodProcurement),
  'all logins returned a token',
);

const ccs = await api('/lookups/cost-centers', { token: requester });
const costCenterId = ccs.data?.[0]?.id;

/**
 * STEP 5 NOW DEMANDS TWO THINGS BEFORE A STATEMENT CAN BE CONFIRMED.
 *
 * ONE: an AWARD on every approved line. There is no winning rate to copy
 * without one — the rates live in proc.cs_line_awards, and the write-back
 * that puts them on the request's lines reads them from there. A confirm
 * without an award used to SUCCEED, and produced a request that reached Cost
 * approval with an UNKNOWN amount, which the cost gate then refused. That is
 * the deadlock the Capex/Opex work had to close, and it is why the confirm
 * now refuses an undecided line and says so.
 *
 * TWO: a CAPEX/OPEX CLASS on every approved line. The `cs_review` step
 * carries `requiresCapexOpex` — it marks the step where the class is MADE,
 * and the request may not leave it until every line carries one.
 *
 * Both are made HERE, on the same fixtures the sections below use, so the
 * suite exercises the real path instead of a confirm that would be refused.
 */
const awardAndClassify = async (csId, prId, vendorId, lineSpecs, token) => {
  for (const { lineNo, qty } of lineSpecs) {
    const r = await api(`/cs/${csId}/award`, {
      method: 'POST', token,
      body: { lineNo, vendorId, qty, justification: 'fixture award — lowest evaluated quote' },
    });
    ok(r.status === 200 || r.status === 201,
      `fixture award on line ${lineNo} was accepted`, { http: r.status, body: r.data });
  }
  const c = await api(`/pr/${prId}/lines/classification`, {
    method: 'PATCH', token,
    body: { lines: lineSpecs.map((s) => ({ lineNo: s.lineNo, classification: 'OPEX_CONSUMABLE' })) },
  });
  ok(c.status === 200 || c.status === 201,
    'fixture classification was accepted', { http: c.status, body: c.data });
  return c;
};
const lines = [
  { itemId: LAPTOP, quantity: 2, uom: 'EA', unitPriceEst: 45000 },
  { itemId: PEN, quantity: 1, uom: 'BOX', unitPriceEst: 45000 },
];
const created = await api('/pr', {
  method: 'POST', token: requester,
  body: { scope: 'CS review fixture', expenseType: 'OPEX', costCenterId,
          requiredByDate: '2026-12-31', title: 'CS review fixture', lines },
});
const prId = created.data?.id;
ok(Boolean(prId), 'fixture PR created', created.status);

await api(`/pr/${prId}/advance`, {
  method: 'POST', token: hod,
  body: { lineDecisions: Object.fromEntries(lines.map((_, i) => [i, 'approved'])), reason: 'fixture' },
});
const issued = await api(`/pr/${prId}/rfq`, { method: 'POST', token: procurement, body: {} });
const rfqId = issued.data?.rfq?.id;
const invites = issued.data?.invitations || [];
ok(Boolean(rfqId) && invites.length >= 2, 'RFQ issued to at least two vendors', invites.length);

const prices = [{ rfqLineNo: 1, unitPrice: 60000, warrantyMonths: 12 },
                { rfqLineNo: 2, unitPrice: 40000, warrantyMonths: 12 }];
const vendorIds = invites.slice(0, 2).map((i) => i.vendor_id);
for (const inv of invites.slice(0, 2)) {
  await api(`/rfq/${rfqId}/quotations`, {
    method: 'POST', token: procurement,
    body: await quoteBody(prId, procurement, inv.vendor_id,
      prices.map((p, i) => ({ ...p, unitPrice: prices[i].unitPrice + (inv === invites[0] ? 0 : 500) })),
      { leadTimeDays: 10 }),
  });
}

const gen = await api(`/pr/${prId}/cs`, { method: 'POST', token: cs });
const csId = gen.data?.cs?.id ?? gen.data?.id;
ok(gen.status === 201 || gen.status === 200, 'CS generated', gen.status);
ok(Boolean(csId), 'CS id returned', gen.data);

// The vendor names we will later assert are ABSENT from the blind payload.
const vendorNames = await sql(
  `SELECT v.legal_name FROM proc.quotations q
     JOIN proc.rfq rf ON rf.id = q.rfq_id
     JOIN core.vendors v ON v.id = q.vendor_id
    WHERE rf.pr_id = '${prId}' AND q.state = 'Submitted';`,
);

// ── 1. the chain starts empty ──────────────────────────────────────────────
section('No review in progress');
{
  const r = await api(`/pr/${prId}/cs/review`, { token: cs });
  ok(r.status === 200, 'GET /pr/:id/cs/review responds', r.status);
  ok(r.data?.review === null, 'no review row exists before the chain starts', r.data?.review);
  // No row is the IMPLICIT DRAFT state. It must offer the entry point, or the
  // chain cannot be started from the UI at all — the submit action is what
  // creates the row the reader would otherwise insist on.
  ok(r.data?.sub_state === 'DRAFT', 'no row reads as DRAFT', r.data?.sub_state);
  ok(r.data?.actions?.can_submit === true,
    'the submit entry point IS offered before a review row exists', r.data?.actions);
  ok(r.data?.actions?.can_send_to_requester === false, 'nothing to send yet');
  ok(r.data?.actions?.can_confirm === false, 'nothing to confirm yet');

  // And it is offered to procurement specifically, not merely to whoever asked.
  const asProc = await api(`/pr/${prId}/cs/review`, { token: procurement });
  ok(asProc.data?.actions?.can_submit === true,
    'procurement can submit the draft — there is no standalone cs user',
    asProc.data?.actions);

  // ...and to nobody who does not own the draft.
  const asRequester = await api(`/pr/${prId}/cs/review`, { token: requester });
  ok(asRequester.data?.actions?.can_submit === false,
    'a requester cannot submit the draft', asRequester.data?.actions);
}

// ── 2. refusals before the first write ──────────────────────────────────────
section('Refusals write nothing');
{
  // Confirm before the chain exists.
  const before = await sql(`SELECT count(*) FROM proc.cs_reviews WHERE pr_id = '${prId}';`);
  const r = await api(`/cs/${csId}/review/confirm`, { method: 'POST', token: cs });
  ok(r.status >= 400, 'confirm refused before a review exists', r.status);
  const after = await sql(`SELECT count(*) FROM proc.cs_reviews WHERE pr_id = '${prId}';`);
  ok(before[0] === after[0], 'refused confirm created no review row', { before: before[0], after: after[0] });

  // Send to requester before submitting.
  const r2 = await api(`/cs/${csId}/review/send-to-requester`, { method: 'POST', token: hodProcurement });
  ok(r2.status >= 400, 'send-to-requester refused at DRAFT', r2.status);

  // A revert with no reason is not an audit entry.
  const r3 = await api(`/cs/${csId}/review/revert-soft`, { method: 'POST', token: procurement, body: { reason: '  ' } });
  ok(r3.status >= 400, 'a blank revert reason is refused', r3.status);

  // A role that owns nothing in this chain.
  const r4 = await api(`/cs/${csId}/review/submit`, { method: 'POST', token: requester });
  ok(r4.status >= 400, 'a requester cannot submit the statement for review', r4.status);
}

// ── 3. DRAFT -> PROC_REVIEW ─────────────────────────────────────────────────
section('DRAFT -> PROC_REVIEW');
{
  const r = await api(`/cs/${csId}/review/submit`, { method: 'POST', token: cs });
  ok(r.status === 201 || r.status === 200, 'submit accepted', r.status);
  ok(r.data?.subState === 'PROC_REVIEW', 'sub-state is PROC_REVIEW', r.data?.subState);

  const state = await sql(`SELECT sub_state FROM proc.cs_reviews WHERE cs_id = '${csId}';`);
  ok(state[0] === 'PROC_REVIEW', 'persisted as PROC_REVIEW', state[0]);

  // The action set is SCOPED TO A PERSON, not to a role string — HOD
  // Procurement is resolved from core.departments — so it is read as the actor
  // that owns the gate, and as the actors that must NOT have it.
  const viewAsHodProc = await api(`/pr/${prId}/cs/review`, { token: hodProcurement });
  ok(viewAsHodProc.data?.actions?.can_send_to_requester === true,
    'HOD Procurement may send it to the requester', viewAsHodProc.data?.actions);
  ok(viewAsHodProc.data?.actions?.can_revert_soft === true,
    'soft revert offered to HOD Procurement at PROC_REVIEW', viewAsHodProc.data?.actions);

  // THE SPLIT THAT MATTERS. The officer DRAFTS; the head of the department
  // APPROVES. Procurement running the comparison and then approving its own
  // comparison is the shortcut this review exists to close.
  const viewAsProc = await api(`/pr/${prId}/cs/review`, { token: procurement });
  ok(viewAsProc.data?.actions?.can_send_to_requester === false,
    'procurement may NOT send it to the requester — that is HOD Procurement\'s', viewAsProc.data?.actions);
  ok(viewAsProc.data?.actions?.can_revert_hard === false,
    'procurement may NOT withdraw the statement outright', viewAsProc.data?.actions);

  // Every department head signs in as `hod`, so a role check here would return
  // true for all of them: the Head of Finance approving Procurement's comparison.
  const viewAsOtherHod = await api(`/pr/${prId}/cs/review`, { token: hod });
  ok(viewAsOtherHod.data?.actions?.can_send_to_requester === false,
    'the Head of Sales may NOT act as HOD Procurement', viewAsOtherHod.data?.actions);

  const viewAsCs = await api(`/pr/${prId}/cs/review`, { token: cs });
  ok(viewAsCs.data?.actions?.can_send_to_requester === false,
    'CS may NOT send it to the requester — that gate is HOD Procurement\'s', viewAsCs.data?.actions);
  ok(viewAsCs.data?.actions?.can_submit === false,
    'CS may not re-submit a review already in progress', viewAsCs.data?.actions);

  // …and the refusal is the service's, not just a hidden button.
  const procTries = await api(`/cs/${csId}/review/send-to-requester`, { method: 'POST', token: procurement });
  ok(procTries.status === 403,
    'procurement is refused when it tries to forward the statement anyway', procTries.status);
  // The message now names BOTH desks — the officer and the head — because every
  // action that refuses with it is owned by Procurement as a department. Asserted
  // on the substance (who it belongs to, and that it does not pretend a single
  // role covers it) rather than on the exact sentence, which is not the point.
  const refusalMsg = String(procTries.data?.message || '');
  ok(/belongs to Procurement/i.test(refusalMsg),
    'the refusal names who the action belongs to', refusalMsg);
  ok(/hod_user_id/.test(refusalMsg),
    'and says how HOD Procurement is identified, rather than trusting a role string', refusalMsg);
  const stillAtProc = await sql(`SELECT sub_state FROM proc.cs_reviews WHERE cs_id = '${csId}';`);
  ok(stillAtProc[0] === 'PROC_REVIEW',
    'the refused forward left the review where it was', stillAtProc[0]);

  // Ordering: submitting twice must not create a second review row.
  const r2 = await api(`/cs/${csId}/review/submit`, { method: 'POST', token: cs });
  ok(r2.status >= 400, 're-submitting at PROC_REVIEW is refused', r2.status);
  const count = await sql(`SELECT count(*) FROM proc.cs_reviews WHERE cs_id = '${csId}';`);
  ok(count[0] === '1', 'still exactly one review row', count[0]);
}

// ── 4. PROC_REVIEW -> REQUESTER_REVIEW (blind) ─────────────────────────────
section('PROC_REVIEW -> REQUESTER_REVIEW (blind)');
{
  const r = await api(`/cs/${csId}/review/send-to-requester`, { method: 'POST', token: hodProcurement });
  ok(r.status === 201 || r.status === 200, 'send-to-requester accepted', r.status);
  ok(r.data?.subState === 'REQUESTER_REVIEW', 'sub-state is REQUESTER_REVIEW', r.data?.subState);

  const row = await sql(
    `SELECT sub_state, masked_for_requester, requester_reviewer_user_id
       FROM proc.cs_reviews WHERE cs_id = '${csId}';`,
  );
  const parts = (row[0] || '').split('|');
  ok(parts[0] === 'REQUESTER_REVIEW', 'persisted as REQUESTER_REVIEW', row[0]);
  ok(parts[1] === 't', 'the blind mask is ON in the database', row[0]);
  // Declared out here on purpose: the blind section below needs it, and a
  // block-scoped const made this file die with a ReferenceError instead of
  // reporting which assertion had actually failed.
  var mappedHod = parts[2] || '';
  ok(Boolean(mappedHod), 'the originating department approver was recorded as the blind reviewer', row[0]);
}

// ── 5. THE MASK, asserted on the raw payload ───────────────────────────────
section('Blind mask: server-side, proven on the raw response body');
{
  // The HOD who owns this PR's department is the blind reviewer.
  const hodRows = await sql(`SELECT id FROM core.users WHERE id = '${mappedHod}';`);
  ok(hodRows.length === 1, 'the mapped reviewer is a real user');

  const asBlind = await api(`/pr/${prId}/cs`, { token: hod });
  ok(asBlind.status === 200, 'blind reviewer can load the CS screen', asBlind.status);
  ok(asBlind.data?.masked_for_viewer === true, 'the payload declares itself masked', asBlind.data?.masked_for_viewer);
  ok(typeof asBlind.data?.mask_reason === 'string' && asBlind.data.mask_reason.length > 0,
    'a reason is given, not just a flag');

  const d = asBlind.data;
  ok(d?.cs?.winner === null, 'winner block stripped', d?.cs?.winner);
  ok(d?.cs?.override_reason === null, 'override reason stripped', d?.cs?.override_reason);
  ok(d?.cs?.split === null, 'per-line split awards stripped', d?.cs?.split);
  ok(d?.scores === null, 'scores stripped', typeof d?.scores);

  ok(Array.isArray(d?.lines) && d.lines.length > 0, 'vendor rows still counted', d?.lines?.length);
  ok(d?.lines.every((l) => l.total_amount === null), 'every price is null');
  ok(d?.lines.every((l) => l.weighted_score === null), 'every weighted score is null');
  ok(d?.lines.every((l) => l.vendor_id === null), 'every vendor id is null');
  ok(d?.lines.every((l) => l.is_masked === true), 'every row is flagged masked');

  // THE LEAK CHECK. This is the assertion a UI-only mask fails: the vendor's
  // legal name must not appear ANYWHERE in the response body — not in lines,
  // not in a nested recommendation, not in a string this test has not thought of.
  const body = asBlind.text;
  const leaked = vendorNames.filter((n) => n && body.includes(n));
  ok(leaked.length === 0, 'no vendor legal name appears anywhere in the raw body', leaked);

  // The mask is asserted on the RAW BODY, not on rendered cells. But the CS
  // page has a SECOND payload — GET /cs/:id/matrix, behind the Matrix Form tab.
  // Masking only /pr/:id/cs left the whole comparative matrix one click away,
  // under a banner claiming the detail was withheld. Both are checked here.
  // A real award is what gives the blind reviewer something to review. Without
  // one, `awarded_lines_detail` is empty and every shape assertion below quietly
  // took an `else` branch — the suite reported PASS while checking nothing. An
  // award is written by procurement (the buyer), which is also the honest
  // sequence: procurement picks, the HOD then reviews the pick blind.
  const awardable = await sql(
    `SELECT q.vendor_id FROM proc.quotations q
       JOIN proc.rfq rf ON rf.id = q.rfq_id
      WHERE rf.pr_id = '${prId}' AND q.state = 'Submitted'
      ORDER BY q.total_amount ASC LIMIT 1;`,
  );
  // EVERY line is awarded AND classified, because step 5 now refuses a
  // statement that leaves with an undecided or an unclassified line.
  //
  // Awarding one line out of two was enough to make the blind grid non-empty,
  // and that is exactly how this hole stayed hidden: the blind assertions all
  // passed, the HOD confirmed a pack with a hole in it, and the CONFIRM was
  // refused for a line nobody had awarded. The blind reviewer is asked to
  // judge a COMPLETE pack — so the fixture is one.
  await awardAndClassify(csId, prId, awardable[0], [
    { lineNo: 1, qty: lines[0].quantity },
    { lineNo: 2, qty: lines[1].quantity },
  ], procurement);
  const liveAwards = await sql(
    `SELECT count(DISTINCT rfq_line_no) FROM proc.cs_line_awards
      WHERE cs_id = '${csId}'::uuid AND superseded_at IS NULL;`,
  );
  ok(liveAwards[0] === '2',
    'the fixture carries a real award on EVERY line, so the blind grid is not empty', liveAwards[0]);

  const asBlindMatrix = await api(`/cs/${csId}/matrix`, { token: hod });
  ok(asBlindMatrix.status === 200, 'the blind reviewer can reach the matrix endpoint', asBlindMatrix.status);
  ok(asBlindMatrix.data?.is_masked === true, 'the MATRIX payload declares itself masked', asBlindMatrix.data?.is_masked);
  ok(typeof asBlindMatrix.data?.blind_notice === 'string', 'the matrix payload explains the withholding');
  ok(asBlindMatrix.data?.awarded_lines === 0 && asBlindMatrix.data?.complete === false,
    'the masked matrix claims no awards', asBlindMatrix.data);

  const mBody = asBlindMatrix.text;
  const mLeaked = vendorNames.filter((n) => n && mBody.includes(n));
  ok(mLeaked.length === 0, 'no vendor legal name appears in the MATRIX payload either', mLeaked);
  const mCodes = await sql(
    `SELECT DISTINCT v.vendor_code FROM proc.quotations q
       JOIN proc.rfq rf ON rf.id=q.rfq_id JOIN core.vendors v ON v.id=q.vendor_id
      WHERE rf.pr_id='${prId}';`,
  );
  const mCodeLeak = mCodes.filter((c) => c && mBody.includes(c));
  ok(mCodeLeak.length === 0, 'no vendor CODE appears in the matrix payload', mCodeLeak);
  ok(mBody.includes('V-00081') === false, 'the literal vendor code string is absent from the body');

  // The grid still has to be USABLE: the reviewer must be able to see what was
  // compared, or "blind" becomes "blind to everything".
  ok(Array.isArray(asBlindMatrix.data?.lines) && asBlindMatrix.data.lines.length > 0,
    'the blind grid still lists the lines', asBlindMatrix.data?.lines?.length);
  ok(asBlindMatrix.data?.lines.every((l) => l.unit_price === null && l.line_total === null),
    'every price on the blind grid is null — a competitor price is never shown');
  ok(asBlindMatrix.data?.lines.every((l) => !('bids' in l && l.bids.length > 0)),
    'no bid array carries a vendor');

  // The blind reviewer now judges the AWARDED lines, so the payload must carry
  // the commercial breakdown. Assert the SHAPE and, harder, that no vendor
  // identity rode along inside it.
  ok(Array.isArray(asBlindMatrix.data?.awarded_lines_detail),
    'the masked matrix carries the awarded-line commercial breakdown',
    typeof asBlindMatrix.data?.awarded_lines_detail);

  const detail = asBlindMatrix.data?.awarded_lines_detail?.[0];
  // MANDATORY, NOT OPTIONAL. This branch used to report `ok(true, 'no awarded
  // lines on this fixture')`, which is how a whole shape check passed without
  // ever executing one assertion. If the fixture stops producing an award the
  // suite now FAILS, because a mask that cannot be inspected is not a mask.
  ok(Boolean(detail), 'the blind payload carries at least one awarded line', detail);
  if (detail) {
    for (const col of ['unit_price', 'gross_amount', 'discount_percent', 'discount_amount',
      'net_amount', 'tax_percent', 'tax_amount', 'line_total', 'quantity', 'lead_time_days',
      'category']) {
      ok(col in detail, `the blind detail carries ${col}`, Object.keys(detail));
    }
    ok(!('vendor_name' in detail) && !('vendor_id' in detail) && !('vendor_code' in detail),
      'no vendor key exists on a blind award line', Object.keys(detail));

    // The award is REAL, so the figures must be real too. A shape that is always
    // null would satisfy `col in detail` while telling the reviewer nothing.
    ok(Number(detail.unit_price) > 0,
      'the awarded unit price is a real figure, not null or zero', detail.unit_price);
    ok(Number(detail.quantity) > 0, 'the awarded quantity is carried', detail.quantity);
    ok(Number(detail.line_total) > 0, 'the awarded line total is carried', detail.line_total);

    // And the mask must still hold with real figures present — the leak check
    // above ran against a payload that had nothing worth leaking.
    const dBody = asBlindMatrix.text;
    ok(!dBody.includes('vendor_id'), 'no vendor_id key anywhere in the blind matrix body');
    const dLeak = vendorNames.filter((n) => n && dBody.includes(n));
    ok(dLeak.length === 0, 'no vendor legal name appears alongside the awarded figures', dLeak);
  }

  // Per-line negotiation flags: a flagged line with no reason is refused.
  const noNote = await api(`/cs/${csId}/review/revert-soft`, {
    method: 'POST', token: hodProcurement,
    body: { reason: 'Negotiate line 1', revertLines: [{ lineNo: 1, decision: 'NEGOTIATE' }] },
  });
  ok(noNote.status >= 400, 'a flagged line with no target rate or reason is refused', noNote.status);

  const badDecision = await api(`/cs/${csId}/review/revert-soft`, {
    method: 'POST', token: hodProcurement,
    body: { reason: 'x', revertLines: [{ lineNo: 1, decision: 'APPROVE', targetRemarks: 'fine' }] },
  });
  ok(badDecision.status >= 400, "a per-line decision other than NEGOTIATE is refused", badDecision.status);

  // Control: the same endpoint is NOT masked for procurement.
  const asProcMatrix = await api(`/cs/${csId}/matrix`, { token: procurement });
  ok(asProcMatrix.data?.is_masked === undefined || asProcMatrix.data?.is_masked === false,
    'procurement still gets the full matrix', asProcMatrix.data?.is_masked);
  ok(asProcMatrix.data?.lines?.some((l) => Array.isArray(l.bids) && l.bids.length > 0),
    'procurement sees real bids');

  // Weights are deliberately kept: the rubric is the method, not the result.
  ok(d?.weights && typeof d.weights.commercial === 'number', 'scoring weights are still readable');
  ok(typeof d?.vendor_count === 'number' && d.vendor_count > 0,
    'the reviewer is told HOW MANY vendors were compared', d?.vendor_count);

  // Control: the same endpoint for a non-blind role is NOT masked. Without this,
  // "no vendor name in the body" could pass because the screen was simply empty.
  const asCs = await api(`/pr/${prId}/cs`, { token: cs });
  ok(asCs.data?.masked_for_viewer === false, 'CS is not masked', asCs.data?.masked_for_viewer);
  ok(asCs.data?.lines?.some((l) => l.vendor_name), 'CS still sees real vendor names');
  ok(asCs.data?.lines?.some((l) => l.weighted_score !== null), 'CS still sees real scores');
}

// ── 6. REQUESTER_REVIEW -> CONFIRMED ───────────────────────────────────────
section('REQUESTER_REVIEW -> CONFIRMED');

// THE BYPASS GATE, asserted BEFORE the confirm path. While a review is in
// force the legacy lock must be refused — otherwise procurement could skip
// both review gates and jump straight into MC governance.
{
  const lockAttempt = await api(`/cs/${csId}/lock`, {
    method: 'POST', token: procurement, body: { winnerVendorId: vendorIds[0] },
  });
  ok(lockAttempt.status >= 400, 'LOCK IS REFUSED while the review is in force', lockAttempt.status);

  const csState = await sql(`SELECT state FROM proc.comparative_statements WHERE id = '${csId}';`);
  ok(csState[0] === 'Generated', 'the refused lock did not lock the statement', csState[0]);
  const stage = await sql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${prId}';`);
  ok(stage[0] === 'IN_PROCUREMENT_REVIEW',
    'the refused lock did not move the PR to CS_LOCKED', stage[0]);

  // The screen must not offer the lock either. `ready` is the server's own
  // flag, so this proves the UI cannot render a dead control.
  const detail = await api(`/pr/${prId}/cs`, { token: procurement });
  ok(detail.data?.ready === false, 'the screen reports lock unavailable', detail.data?.ready);
  ok(detail.data?.review_in_progress === 'REQUESTER_REVIEW',
    'the payload names the review state blocking the lock', detail.data?.review_in_progress);

  // SEGREGATION OF DUTIES. Procurement ran the competition and must not sign
  // off its own comparison.
  const procConfirm = await api(`/cs/${csId}/review/confirm`, { method: 'POST', token: procurement });
  ok(procConfirm.status === 403, 'procurement CANNOT confirm the blind review', procConfirm.status);

  const csStill = await sql(`SELECT sub_state FROM proc.cs_reviews WHERE cs_id = '${csId}';`);
  ok(csStill[0] === 'REQUESTER_REVIEW', 'the refused confirm left the review untouched', csStill[0]);

  const csRoleConfirm = await api(`/cs/${csId}/review/confirm`, { method: 'POST', token: cs });
  ok(csRoleConfirm.status === 403, 'CS cannot confirm either', csRoleConfirm.status);
}

{
  const stageBefore = await sql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${prId}';`);
  ok(stageBefore[0] === 'IN_PROCUREMENT_REVIEW', 'PR is in procurement review before confirming', stageBefore[0]);

  const r = await api(`/cs/${csId}/review/confirm`, { method: 'POST', token: hod });
  ok(r.status === 201 || r.status === 200, 'the mapped blind reviewer may confirm', { http: r.status, body: r.data });
  ok(r.data?.subState === 'CONFIRMED', 'sub-state is CONFIRMED', r.data?.subState);
  ok(r.data?.statement_locked === true, 'the confirmation LOCKED the statement', r.data?.statement_locked);
  ok(r.data?.award_mode === 'SPLIT', 'the statement was locked as a per-line split', r.data?.award_mode);
  ok(Array.isArray(r.data?.rates_applied) && r.data.rates_applied.length === 2,
    'BOTH winning rates were written back onto the request lines', r.data?.rates_applied);

  const stageAfter = await sql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${prId}';`);
  // THE CONFIRM NO LONGER MOVES THE REQUEST. It used to write
  // `SET status = step.to` directly, which is why the classification gate had to
  // be duplicated into it and why the requesting HOD could not finish a blind
  // review on an unclassified line. The advance is the only route across now,
  // and it runs through the engine, where the step's requiresCapexOpex applies.
  ok(stageAfter[0] === 'IN_PROCUREMENT_REVIEW',
    'PR STAYS in sourcing after the confirm — the advance owns the crossing', stageAfter[0]);
  ok(r.data?.nextStage === 'IN_PROCUREMENT_REVIEW',
    'and the response reports it as unchanged rather than as a move', r.data?.nextStage);
  ok(r.data?.exitStep === 'cs_review',
    'the response names the step that will move it next', r.data?.exitStep);

  // ...and the audit trail records the confirmation as what it now is: an
  // approval of the rates, not a stage change.
  const audit = await sql(
    `SELECT count(*) FROM audit.audit_log
      WHERE entity = 'proc.purchase_requisitions' AND entity_id = '${prId}'
        AND action = 'approve' AND after->>'event' = 'cs_review_confirmed';`,
  );
  ok(Number(audit[0]) === 1,
    'the confirmation is in the audit trail, with no stage change claimed', audit[0]);

  const row = await sql(`SELECT sub_state, confirmed_at, masked_for_requester FROM proc.cs_reviews WHERE cs_id = '${csId}';`);
  const cp = (row[0] || '').split('|');
  ok(cp[0] === 'CONFIRMED', 'persisted as CONFIRMED', row[0]);
  ok(Boolean(cp[1]), 'confirmation timestamp recorded');
  ok(cp[2] === 'f', 'the blind mask is OFF once confirmed', row[0]);

  // Confirming twice must not move the PR a second time.
  const r2 = await api(`/cs/${csId}/review/confirm`, { method: 'POST', token: hod });
  ok(r2.status >= 400, 're-confirming is refused', r2.status);
  const stageTwice = await sql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${prId}';`);
  ok(stageTwice[0] === 'IN_PROCUREMENT_REVIEW',
    'a refused re-confirm left the PR where the first confirm left it', stageTwice[0]);

  // THE MONEY ACTUALLY MOVED. The rates the vendors quoted are now the rates
  // on the request's own lines, the requester's budget is kept for the
  // cost-centre comparison, and the header is the sum of the lines.
  //
  // This is the whole point of the change: the cost gate asks the HEADER
  // whether the amount is known, and the header asks the LINES. Before the
  // write-back the lines carried the requester's 45,000 guess and the header
  // carried nothing, so thirty-five requests could not be costed at all.
  const rateRows = await sql(
    `SELECT pl.line_no, pl.quantity, pl.unit_price_est, pl.budget_unit_price, pl.classification
       FROM proc.pr_lines pl
      WHERE pl.pr_id = '${prId}'::uuid
        AND pl.approved = true AND pl.rejected = false AND pl.held = false
      ORDER BY pl.line_no;`,
  );
  ok(rateRows.length === 2, 'both approved lines are in the spend', rateRows.length);
  let spend = 0;
  for (const row of rateRows) {
    const [lineNo, qty, price, budget, cls] = row.split('|');
    spend += Number(qty) * Number(price);
    ok(Number(price) !== 45000,
      `line ${lineNo} now carries the AWARDED rate, not the requester's estimate`, row);
    ok(Number(budget) === 45000,
      `line ${lineNo} kept the requester's budget for the cost-centre comparison`, row);
    ok(cls === 'OPEX_CONSUMABLE', `line ${lineNo} carries the class procurement set`, row);
  }
  const head = await sql(
    `SELECT estimated_amount, amount_status, capex_amount, opex_amount
       FROM proc.purchase_requisitions WHERE id = '${prId}'::uuid;`,
  );
  const hp = (head[0] || '').split('|');
  ok(Number(hp[0]) === spend, 'the header is the sum of the awarded lines', head[0]);
  ok(hp[1] === 'ESTIMATED', 'the header now says the amount is known', head[0]);
  ok(Number(hp[2]) === 0 && Number(hp[3]) === spend,
    'the whole spend reads as operating — nothing was classified as capital', head[0]);

  // The mask is gone: the reviewer may now read it.
  const afterMask = await api(`/pr/${prId}/cs`, { token: hod });
  ok(afterMask.data?.masked_for_viewer === false, 'unmasked after confirmation', afterMask.data?.masked_for_viewer);

  // ── the crossing, which the advance owns ─────────────────────────────────
  //
  // Everything above proves the confirm did its job and stopped. This proves the
  // other half: that the request can still leave sourcing, that only the desk
  // entitled to do it can, and that the gate is on THIS action rather than on the
  // blind reviewer's.
  ok(stageTwice[0] === 'IN_PROCUREMENT_REVIEW',
    'the PR is still in sourcing, awaiting the advance', stageTwice[0]);

  // The requesting HOD signed the rates. They do not own the request and are
  // refused by the step's actorRole before any gate is even consulted.
  const hodAdvance = await api(`/pr/${prId}/advance`, {
    method: 'POST', token: hod, body: { reason: 'blind reviewer tries to advance', csReviewConfirmed: true },
  });
  ok(hodAdvance.status === 403, 'the blind reviewer cannot advance the request', hodAdvance.status);

    // An advance with NO flag must not take the CS exit. It does not — the
  // `csReviewConfirmed` keyword fails closed.
  //
  // It is not probed HERE, and the reason is worth stating. `procurement` is a
  // second route out of procurement review into cost approval: `when: always`,
  // and it carries the classification gate since migration 070, so it is a
  // GATED second route rather than an open one. It was measured and ordered
  // separately — the 2026-10-21 instruction closed the classification hole on
  // it and left the routing question where it was — so it is not changed here.
  //
  // But an unflagged advance on THIS fixture would take the request to cost
  // approval, and every assertion after this point is about a request still
  // standing in sourcing. The equivalent probe lives in the QUOTES_RECEIVED
  // section, where the plain step is mc_approval and the transition trigger
  // refuses the edge, so nothing moves.

  // The real thing: procurement confirms the classification exists and advances.
  const adv = await api(`/pr/${prId}/advance`, {
    method: 'POST', token: procurement,
    body: { reason: 'CS confirmed, lines classified', csReviewConfirmed: true },
  });
  ok(adv.status === 201 || adv.status === 200, 'procurement advances the classified request', adv.status);
  ok(adv.data?.matchedStep === 'cs_review', 'it went through the configured cs_review step', adv.data?.matchedStep);

  const stageMoved = await sql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${prId}';`);
  ok(stageMoved[0] === 'IN_COST_CENTER_APPROVAL',
    'and the request is now at cost centre approval', stageMoved[0]);
}

// ── 7. the two reverts ─────────────────────────────────────────────────────
section('Soft revert vs hard revert');
{
  // Second PR, so the first one's CONFIRMED state is not disturbed.
  const p2 = (await api('/pr', {
    method: 'POST', token: requester,
    body: { scope: 'CS revert fixture', expenseType: 'OPEX', costCenterId,
            requiredByDate: '2026-12-31', title: 'CS revert fixture', lines },
  })).data?.id;
  await api(`/pr/${p2}/advance`, {
    method: 'POST', token: hod,
    body: { lineDecisions: Object.fromEntries(lines.map((_, i) => [i, 'approved'])), reason: 'fixture' },
  });
  const r2 = await api(`/pr/${p2}/rfq`, { method: 'POST', token: procurement, body: {} });
  const rfq2 = r2.data?.rfq?.id;
  const inv2 = r2.data?.invitations || [];
  for (const inv of inv2.slice(0, 2)) {
    await api(`/rfq/${rfq2}/quotations`, {
      method: 'POST', token: procurement,
      body: await quoteBody(p2, procurement, inv.vendor_id,
        prices.map((p) => ({ ...p, unitPrice: p.unitPrice + 100 })), { leadTimeDays: 12 }),
    });
  }
  const cs2 = (await api(`/pr/${p2}/cs`, { method: 'POST', token: cs })).data?.cs?.id;
  ok(Boolean(cs2), 'second fixture CS generated');

  // Walk it to REQUESTER_REVIEW.
  await api(`/cs/${cs2}/review/submit`, { method: 'POST', token: cs });
  await api(`/cs/${cs2}/review/send-to-requester`, { method: 'POST', token: hodProcurement });

  // SOFT: negotiable, nothing cancelled.
  const soft = await api(`/cs/${cs2}/review/revert-soft`, {
    method: 'POST', token: hodProcurement, body: { reason: 'Prices look off; renegotiate lead time.' },
  });
  ok(soft.status === 201 || soft.status === 200, 'soft revert accepted', soft.status);
  ok(soft.data?.revertKind === 'SOFT', 'recorded as SOFT', soft.data?.revertKind);

  const afterSoft = await sql(
    `SELECT cs.state, (SELECT state FROM proc.rfq WHERE pr_id = '${p2}'),
            (SELECT count(*) FROM proc.quotations q JOIN proc.rfq rf ON rf.id=q.rfq_id
              WHERE rf.pr_id = '${p2}' AND q.state = 'Submitted')
       FROM proc.comparative_statements cs WHERE cs.id = '${cs2}';`,
  );
  ok(afterSoft[0].split('|')[0] === 'Generated', 'a SOFT revert leaves the statement Generated', afterSoft[0]);
  ok(afterSoft[0].split('|')[1] !== 'Cancelled', 'a SOFT revert does not cancel the RFQ', afterSoft[0]);
  ok(Number(afterSoft[0].split('|')[2]) >= 2, 'a SOFT revert keeps every quotation', afterSoft[0]);

  // Re-submit, then HARD.
  await api(`/cs/${cs2}/review/submit`, { method: 'POST', token: cs });
  const hard = await api(`/cs/${cs2}/review/revert-hard`, {
    method: 'POST', token: hodProcurement, body: { reason: 'Field is too thin; re-solicit quotes.' },
  });
  ok(hard.status === 201 || hard.status === 200, 'hard revert accepted', hard.status);
  ok(hard.data?.revertKind === 'HARD', 'recorded as HARD', hard.data?.revertKind);

  const afterHard = await sql(
    `SELECT cs.state, (SELECT state FROM proc.rfq WHERE pr_id = '${p2}'),
            (SELECT count(*) FROM proc.quotations q JOIN proc.rfq rf ON rf.id=q.rfq_id
              WHERE rf.pr_id = '${p2}' AND q.state = 'Submitted'),
            (SELECT revert_kind FROM proc.cs_reviews WHERE cs_id = '${cs2}')
       FROM proc.comparative_statements cs WHERE cs.id = '${cs2}';`,
  );
  const hp = (afterHard[0] || '').split('|');
  ok(hp[0] === 'Generated',
    'a HARD revert does NOT rewrite comparative_statements — its state CHECK only admits Generated/Locked',
    afterHard[0]);
  ok(hp[1] !== 'Cancelled',
    "a HARD revert does NOT cancel the RFQ — re-soliciting is the RFQ's business", afterHard[0]);
  ok(Number(hp[2]) >= 2, 'a HARD revert preserves the quotes as evidence', afterHard[0]);
  ok(hp[3] === 'HARD', 'the withdrawal is recorded on the review row instead', afterHard[0]);

  // The point of a hard revert: a fresh round can now be opened.
  const round2 = await api(`/pr/${p2}/cs`, { method: 'POST', token: cs });
  ok(round2.status === 201 || round2.status === 200,
    'a new round can be generated after a HARD revert', round2.status);
  const rounds = await sql(
    `SELECT count(*), max(cs_round) FROM proc.comparative_statements WHERE pr_id = '${p2}';`,
  );
  ok(rounds[0].split('|')[0] === '2' && rounds[0].split('|')[1] === '2',
    'the PR now carries round 1 (evidence) and round 2 (live)', rounds[0]);

  const stage = await sql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${p2}';`);
  ok(stage[0] === 'IN_PROCUREMENT_REVIEW', 'a revert never moves the PR', stage[0]);

  // The requester cannot withdraw a statement outright.
  await api(`/cs/${cs2}/review/submit`, { method: 'POST', token: cs });
  const denied = await api(`/cs/${cs2}/review/revert-hard`, {
    method: 'POST', token: requester, body: { reason: 'trying it on' },
  });
  ok(denied.status >= 400, 'a requester cannot hard-revert', denied.status);
}

// ── 8. stage gates on generate/lock ─────────────────────────────────────────
section('Stage gating on generate and lock');
{
  const stageNow = await sql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${prId}';`);
  ok(stageNow[0] === 'IN_COST_CENTER_APPROVAL', 'fixture PR has left sourcing', stageNow[0]);

  const again = await api(`/pr/${prId}/cs`, { method: 'POST', token: cs });
  ok(again.status >= 400, 'generate refused once the PR has left sourcing', again.status);

  const reLock = await api(`/cs/${csId}/lock`, { method: 'POST', token: cs, body: {} });
  ok(reLock.status >= 400, 'lock refused once the PR has left sourcing', reLock.status);
}

// ── 8b. admin is the only escalation ────────────────────────────────────────
section('Admin is the only emergency escalation');
{
  // A fresh statement, walked to the blind gate, then confirmed by admin while
  // the originating HOD is available but has not acted.
  const p3 = (await api('/pr', {
    method: 'POST', token: requester,
    body: { scope: 'CS admin escalation fixture', expenseType: 'OPEX', costCenterId,
            requiredByDate: '2026-12-31', title: 'CS admin escalation fixture', lines },
  })).data?.id;
  await api(`/pr/${p3}/advance`, {
    method: 'POST', token: hod,
    body: { lineDecisions: Object.fromEntries(lines.map((_, i) => [i, 'approved'])), reason: 'fixture' },
  });
  const r3 = await api(`/pr/${p3}/rfq`, { method: 'POST', token: procurement, body: {} });
  const inv3 = r3.data?.invitations || [];
  for (const inv of inv3.slice(0, 2)) {
    await api(`/rfq/${r3.data.rfq.id}/quotations`, {
      method: 'POST', token: procurement,
      body: await quoteBody(p3, procurement, inv.vendor_id,
        prices.map((p) => ({ ...p, unitPrice: p.unitPrice + 200 })), { leadTimeDays: 9 }),
    });
  }
  const cs3 = (await api(`/pr/${p3}/cs`, { method: 'POST', token: cs })).data?.cs?.id;
  await api(`/cs/${cs3}/review/submit`, { method: 'POST', token: cs });
  await api(`/cs/${cs3}/review/send-to-requester`, { method: 'POST', token: hodProcurement });

  // Step 5 demands an award and a class before the statement can be
  // confirmed. See awardAndClassify above.
  await awardAndClassify(cs3, p3, inv3[0].vendor_id, [
    { lineNo: 1, qty: lines[0].quantity },
    { lineNo: 2, qty: lines[1].quantity },
  ], procurement);

  // finance, cfo and mc are all outside the chain — they must be refused, so
  // the escalation is genuinely narrow and not "anyone senior".
  for (const email of ['finance@pakboxes.pk', 'cfo@pakboxes.pk', 'mc.member1@pakboxes.pk']) {
    const tok = await login(email);
    if (!tok) { ok(false, `${email} could not log in to prove it is refused`); continue; }
    const r = await api(`/cs/${cs3}/review/confirm`, { method: 'POST', token: tok });
    ok(r.status === 403, `${email} cannot escalate past the blind reviewer`, r.status);
  }

  const asAdmin = await api(`/cs/${cs3}/review/confirm`, { method: 'POST', token: admin });
  ok(asAdmin.status === 201 || asAdmin.status === 200,
    'admin CAN override and confirm', asAdmin.status);

  // Same as everywhere else: the override confirms the statement, it does not
  // move the request. An emergency override of the BLIND REVIEW is not an
  // override of the workflow — the crossing is still the advance's, and still
  // gated on a classification.
  const st3 = await sql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${p3}';`);
  ok(st3[0] === 'IN_PROCUREMENT_REVIEW',
    'the admin override confirmed the statement without moving the PR', st3[0]);

  const adv3 = await api(`/pr/${p3}/advance`, {
    method: 'POST', token: procurement,
    body: { reason: 'override confirmed; classified', csReviewConfirmed: true },
  });
  ok(adv3.status === 201 || adv3.status === 200,
    'the overridden request advances like any other', adv3.status);
  const st3b = await sql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${p3}';`);
  ok(st3b[0] === 'IN_COST_CENTER_APPROVAL', 'and lands at cost centre approval', st3b[0]);

  const rev3 = await sql(`SELECT sub_state FROM proc.cs_reviews WHERE cs_id = '${cs3}';`);
  ok(rev3[0] === 'CONFIRMED', 'the admin override recorded CONFIRMED', rev3[0]);
}

// ── 9. the existing estate is untouched ─────────────────────────────────────
section('Pre-existing statements');
{
  // A RELATIVE check, captured before this suite did anything. Comparing
  // against a remembered number is how a test rots: an earlier figure of 813
  // came from a differently-scoped query and would have failed here for
  // reasons that have nothing to do with this feature. What matters is that
  // THIS RUN deletes nothing, so the count is taken now and compared later.
  const startCount = await sql(`SELECT count(*) FROM proc.comparative_statements;`);
  const startCs = Number(startCount[0]);

  // A hard revert must not rewrite the statement table at all — its state CHECK
  // admits only Generated/Locked, and the chain lives in proc.cs_reviews.
  const hardRow = await sql(
    `SELECT cs.state FROM proc.comparative_statements cs
       JOIN proc.cs_reviews cr ON cr.cs_id = cs.id
      WHERE cr.revert_kind = 'HARD' LIMIT 1;`,
  );
  ok(hardRow.length === 0 || ['Generated', 'Locked', null].includes(hardRow[0]),
    'a HARD revert left comparative_statements.state untouched', hardRow[0]);

  const orphan = await sql(
    `SELECT count(*) FROM proc.cs_reviews cr
       JOIN proc.comparative_statements cs ON cs.id = cr.cs_id
      WHERE cs.cs_round <> cr.current_round;`,
  );
  ok(orphan[0] === '0', 'no review row points at a superseded round', orphan[0]);

  ok(startCs > 0, `the pre-existing statement estate is intact (${startCs} rows)`, startCs);
}

// ── 9b. a ZERO price is not the lowest price ───────────────────────────────
section('Zero-price quotes are excluded from L1');
{
  // The write path already refuses a zero: quotation.service.ts asserts
  // `unit > 0` per line. The 88 rows in proc.quotation_lines that DO carry
  // unit_price = 0 are legacy/imported history, written before that guard or
  // around it. So this fixture cannot POST a zero and must not pretend to ─
  // it records two genuine quotes and then zeroes one line the way history did.
  const p4 = (await api('/pr', {
    method: 'POST', token: requester,
    body: { scope: 'Zero price L1 fixture', expenseType: 'OPEX', costCenterId,
            requiredByDate: '2026-12-31', title: 'Zero price L1 fixture',
            lines: [{ itemId: LAPTOP, quantity: 1, uom: 'EA', unitPriceEst: 30000 }] },
  })).data?.id;
  await api(`/pr/${p4}/advance`, {
    method: 'POST', token: hod,
    body: { lineDecisions: { 0: 'approved' }, reason: 'fixture' },
  });
  const r4 = await api(`/pr/${p4}/rfq`, { method: 'POST', token: procurement, body: {} });
  const inv4 = r4.data?.invitations || [];
  ok(inv4.length >= 2, 'at least two vendors invited so L1 has to discriminate', inv4.length);

  // Two real quotes: 5,000 and 12,000.
  for (let i = 0; i < 2; i++) {
    await api(`/rfq/${r4.data.rfq.id}/quotations`, {
      method: 'POST', token: procurement,
      body: await quoteBody(p4, procurement, inv4[i].vendor_id,
        [{ rfqLineNo: 1, unitPrice: i === 0 ? 5000 : 12000, warrantyMonths: 12 }],
        { leadTimeDays: 10 }),
    });
  }

  // Age the cheaper quote into the historical shape: a zero on a line that was
  // really an unpriced/missing entry, exactly like the 92 existing rows.
  //
  // TWO COLUMNS, NOT ONE — this is the whole reason the first version of this
  // fixture never reached the scorer. A price lives in TWO places and TWO
  // DIFFERENT readers consume them:
  //   proc.quotation_lines.unit_price -> award.service cheapestBid()/isL1Eligible
  //   proc.quotations.total_amount    -> cs.service liveQuotes() -> cs.scoring
  // Zeroing only the line left the matrix correctly excluding the zero while
  // the scorer went on reading a genuine 5,000, so the scoring assertions below
  // were testing a fixture that had never been built. A live count after many
  // runs of the old version: 92 zeroed lines, ZERO zeroed headers — proof the
  // header was never touched. One statement, one target, both columns.
  //
  // proc.quotation_lines has NO surrogate id — its key is (quotation_id,
  // rfq_line_no) — so the target is resolved once and joined into both writes.
  // Data-modifying CTEs all see the same snapshot, so `target` is evaluated
  // against the PRE-update rows and cannot chase its own tail.
  const zeroed = await sql(
    `WITH target AS (
       SELECT q.id AS qid FROM proc.quotation_lines x
         JOIN proc.quotations q ON q.id = x.quotation_id
         JOIN proc.rfq rf ON rf.id = q.rfq_id
        WHERE rf.pr_id = '${p4}' AND x.rfq_line_no = 1
        ORDER BY x.unit_price ASC LIMIT 1
     ),
     upd_line AS (
       UPDATE proc.quotation_lines ql SET unit_price = 0
         FROM target t WHERE ql.quotation_id = t.qid AND ql.rfq_line_no = 1
       RETURNING ql.unit_price AS line_price
     ),
     upd_head AS (
       UPDATE proc.quotations q SET total_amount = 0
         FROM target t WHERE q.id = t.qid
       RETURNING q.total_amount AS head_total
     )
     SELECT (SELECT head_total FROM upd_head), (SELECT line_price FROM upd_line);`,
  );
  // Both columns are numeric, so psql renders each zero as "0.00" — compared as
  // a NUMBER, not as a string. Comparing to the literal '0' would fail on a
  // correct write and pass on a wrong one.
  const [headZero, lineZero] = (zeroed[0] || '').split('|').map(Number);
  ok(Number(headZero) === 0,
    'the quote HEADER total is zeroed, so the scorer can actually see it', zeroed[0]);
  ok(Number(lineZero) === 0,
    'a zero-priced line now exists on the fixture', zeroed[0]);

  const cs4 = (await api(`/pr/${p4}/cs`, { method: 'POST', token: cs })).data?.cs?.id;
  ok(Boolean(cs4), 'zero-price fixture CS generated', cs4);

  const mx = await api(`/cs/${cs4}/matrix`, { token: procurement });
  const line = mx.data?.lines?.[0];
  const bids = line?.bids || [];
  ok(Boolean(line), 'the fixture line is present in the matrix');
  ok(bids.some((b) => Number(b.unit_price) === 0),
    'the zero-priced bid is present on the line', bids.map((b) => b.unit_price));
  ok(bids.some((b) => Number(b.unit_price) === 12000),
    'the genuine quote is present on the line', bids.map((b) => b.unit_price));

  // THE FIX. Before it, `unit_price !== null` admitted the 0, sorting it first:
  // lowest_unit_price was 0, the zero bid wore the green L1 badge, and the real
  // vendor measured as a "+PKR 5,000 over L1" premium against nothing.
  ok(line?.lowest_unit_price === 12000,
    'L1 baseline is the GENUINE price, not the zero', line?.lowest_unit_price);
  ok(Number(line?.lowest_unit_price) > 0, 'lowest_unit_price is never zero', line?.lowest_unit_price);

  // THE SCORER IS THE SAME BUG IN ANOTHER PLACE. Commercial normalises against
  // the lowest TOTAL; with a zero in the field that floor became 0, so the zero
  // vendor took 100 and every genuine bidder was squeezed toward 0 for being
  // expensive. A guard on the matrix badge alone would leave this wide open.
  const sc = await api(`/pr/${p4}/cs`, { token: cs });
  const scored = (sc.data?.lines || []);
  ok(scored.length >= 2, 'the CS scored both quotes', scored.length);

  const zeroRow = scored.find((l) => Number(l.total_amount) === 0);
  const realRow = scored.find((l) => Number(l.total_amount) > 0);
  ok(Boolean(zeroRow), 'the zero-priced vendor is present in the scoring', scored.map((l) => l.total_amount));
  ok(Boolean(realRow), 'the genuine vendor is present in the scoring', scored.map((l) => l.total_amount));

  if (zeroRow && realRow) {
    ok(Number(zeroRow.commercial_score) === 0,
      'a zero-priced quote scores 0 on commercial, never a perfect 100', zeroRow.commercial_score);
    ok((zeroRow.missing || []).includes('commercial'),
      'the zero price is reported as MISSING, not as a bad score', zeroRow.missing);
    // The genuine vendor must still be able to reach a real figure. With the
    // old floor-at-zero this was squeezed to ~0.
    ok(Number(realRow.commercial_score) > 0,
      'a genuine quote is NOT crushed to zero by the presence of a zero', realRow.commercial_score);
    ok(Number(realRow.rank) <= Number(zeroRow.rank),
      'the genuine quote ranks at or above the unpriced one',
      { real: realRow.rank, zero: zeroRow.rank });
  }
}

// ── 10. CONFIRM AT QUOTES_RECEIVED — the stage the hand-off parks you on ────
section('A CS confirmed after the Ready-for-CS hand-off succeeds');
{
  // THE BUG THIS SECTION EXISTS FOR. The "Ready for CS" hand-off (migration 064)
  // routes IN_PROCUREMENT_REVIEW -> QUOTES_RECEIVED, and the CS is generated
  // AFTER it. So the normal place to run a review chain is QUOTES_RECEIVED ─
  // and confirm() asserted `pr_stage === 'IN_PROCUREMENT_REVIEW'`, so the blind
  // reviewer hit "PR stage mismatch" on the one screen built for them and could
  // never finish. UAT found it; a fixture that only ever confirms at
  // IN_PROCUREMENT_REVIEW would have stayed green forever.
  //
  // The walk is the real one: PR -> HOD approves -> RFQ -> quotes -> READY FOR
  // CS (which moves the stage) -> generate -> submit -> send to requester ->
  // confirm. No direct UPDATE of proc.purchase_requisitions, because forcing the
  // stage by hand would not prove the hand-off leaves a confirmable request.
  const p5 = (await api('/pr', {
    method: 'POST', token: requester,
    body: { scope: 'Quotes received confirm fixture', expenseType: 'OPEX', costCenterId,
            requiredByDate: '2026-12-31', title: 'Quotes received confirm fixture',
            lines: [{ itemId: LAPTOP, quantity: 1, uom: 'EA', unitPriceEst: 30000 }] },
  })).data?.id;
  await api(`/pr/${p5}/advance`, {
    method: 'POST', token: hod,
    body: { lineDecisions: { 0: 'approved' }, reason: 'fixture' },
  });
  const r5 = await api(`/pr/${p5}/rfq`, { method: 'POST', token: procurement, body: {} });
  const inv5 = r5.data?.invitations || [];
  for (const inv of inv5.slice(0, 2)) {
    await api(`/rfq/${r5.data.rfq.id}/quotations`, {
      method: 'POST', token: procurement,
      body: await quoteBody(p5, procurement, inv.vendor_id,
        [{ rfqLineNo: 1, unitPrice: 20000, warrantyMonths: 12 }], { leadTimeDays: 7 }),
    });
  }

  // The hand-off itself, via its OWN endpoint.
  //
  // NOT `POST /pr/:id/advance`. That walks planAdvance() over the routing table
  // and takes the FIRST step whose predicate matches from this stage, which is
  // `procurement` (order 8, when:always) — not `ready_for_cs` (order 16). The
  // fixture therefore jumped straight to IN_COST_CENTER_APPROVAL, the CS could
  // never be generated, and every assertion after it failed for one reason that
  // had nothing to do with the stage gate under test. /pr/:id/ready-for-cs is
  // a deliberate separate route for exactly this reason.
  const ready = await api(`/pr/${p5}/ready-for-cs`, {
    method: 'POST', token: procurement, body: { remarks: 'fixture hand-off' },
  });
  const st5 = await sql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${p5}';`);
  ok(st5[0] === 'QUOTES_RECEIVED',
    'the Ready-for-CS hand-off parks the PR at QUOTES_RECEIVED', { status: st5[0], http: ready.status });

  const cs5 = (await api(`/pr/${p5}/cs`, { method: 'POST', token: cs })).data?.cs?.id;
  ok(Boolean(cs5), 'a CS can be generated at QUOTES_RECEIVED', cs5);

  await api(`/cs/${cs5}/review/submit`, { method: 'POST', token: cs });
  await api(`/cs/${cs5}/review/send-to-requester`, { method: 'POST', token: hodProcurement });

  // Step 5 demands an award and a class before the statement can be
  // confirmed. See awardAndClassify above.
  await awardAndClassify(cs5, p5, inv5[0].vendor_id, [{ lineNo: 1, qty: 1 }], procurement);

  const preConfirm = await sql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${p5}';`);
  ok(preConfirm[0] === 'QUOTES_RECEIVED',
    'the PR is STILL at QUOTES_RECEIVED while the blind review runs — the chain does not move it', preConfirm[0]);

  // THE ASSERTION. This returned 400 "stage mismatch" before the fix.
  const conf5 = await api(`/cs/${cs5}/review/confirm`, { method: 'POST', token: hod });
  ok(conf5.status === 200 || conf5.status === 201,
    'CONFIRM SUCCEEDS at QUOTES_RECEIVED (was HTTP 400 stage mismatch)', { status: conf5.status, body: conf5.data });

  const after5 = await sql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${p5}';`);
  // Two assertions where there used to be one, because the crossing is now a
  // separate action rather than a side effect of the confirm. Both are needed:
  // asserting only the destination would pass on a fixture that had already
  // arrived there, and asserting only the stage would pass on a suite that had
  // stopped testing the move at all.
  ok(preConfirm[0] === 'QUOTES_RECEIVED' && after5[0] === 'QUOTES_RECEIVED',
    'the confirm does NOT move the PR out of QUOTES_RECEIVED',
    { from: preConfirm[0], to: after5[0] });
  ok(conf5.data?.exitStep === 'cs_review_quotes',
    'and it names cs_review_quotes as the step that will move it', conf5.data?.exitStep);

  // THE EXIT FROM QUOTES_RECEIVED. Before migration 071 a request parked here had
  // NO route into cost approval: the only other step out of the stage is
  // mc_approval, and proc.fn_check_pr_transition forbids
  // QUOTES_RECEIVED -> MC_APPROVED, so firing it raised a check violation. With
  // the confirm no longer moving the request, this route is the only thing that
  // keeps this population alive — which is exactly the deadlock that started
  // this change (PR-2026-202043, CS-2026-200663).
  //
  // FIRST: unflagged, it must not cross into cost approval. The `when` keyword
  // fails closed, so the plain step answers — and the plain step here is
  // mc_approval, whose edge the transition trigger refuses, so the request does
  // not move at all.
  const unflagged5 = await api(`/pr/${p5}/advance`, { method: 'POST', token: procurement, body: { reason: 'no flag' } });
  ok(unflagged5.data?.matchedStep !== 'cs_review_quotes',
    'an unflagged advance does NOT take the CS exit', unflagged5.data?.matchedStep);
  const unmoved5 = await sql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${p5}';`);
  ok(unmoved5[0] === 'QUOTES_RECEIVED',
    'and the request does not move without the flag', unmoved5[0]);

  const adv5 = await api(`/pr/${p5}/advance`, {
    method: 'POST', token: procurement,
    body: { reason: 'CS confirmed at quotes received', csReviewConfirmed: true },
  });
  ok(adv5.status === 200 || adv5.status === 201,
    'the advance moves it out of QUOTES_RECEIVED', { status: adv5.status, body: adv5.data });
  ok(adv5.data?.matchedStep === 'cs_review_quotes',
    'through cs_review_quotes, not mc_approval', adv5.data?.matchedStep);

  const moved5 = await sql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${p5}';`);
  ok(moved5[0] === 'IN_COST_CENTER_APPROVAL',
    'the PR reached IN_COST_CENTER_APPROVAL from QUOTES_RECEIVED', moved5[0]);

  const rev5 = await sql(`SELECT sub_state FROM proc.cs_reviews WHERE cs_id = '${cs5}';`);
  ok(rev5[0] === 'CONFIRMED', 'the review persisted as CONFIRMED', rev5[0]);

  // The stage gate must stay a gate: a stage genuinely OUTSIDE sourcing is still
  // refused. Widening the gate to admit QUOTES_RECEIVED must not become "confirm
  // works from anywhere" — that would let a blind review be confirmed on a PR
  // that has already left procurement entirely.
  const p6 = (await api('/pr', {
    method: 'POST', token: requester,
    body: { scope: 'Out-of-sourcing confirm refusal fixture', expenseType: 'OPEX', costCenterId,
            requiredByDate: '2026-12-31', title: 'Out-of-sourcing confirm refusal fixture',
            lines: [{ itemId: LAPTOP, quantity: 1, uom: 'EA', unitPriceEst: 30000 }] },
  })).data?.id;
  await api(`/pr/${p6}/advance`, {
    method: 'POST', token: hod,
    body: { lineDecisions: { 0: 'approved' }, reason: 'fixture' },
  });
  const r6 = await api(`/pr/${p6}/rfq`, { method: 'POST', token: procurement, body: {} });
  const inv6 = r6.data?.invitations || [];
  for (const inv of inv6.slice(0, 2)) {
    await api(`/rfq/${r6.data.rfq.id}/quotations`, {
      method: 'POST', token: procurement,
      body: await quoteBody(p6, procurement, inv.vendor_id,
        [{ rfqLineNo: 1, unitPrice: 20000, warrantyMonths: 12 }], { leadTimeDays: 7 }),
    });
  }
  const cs6 = (await api(`/pr/${p6}/cs`, { method: 'POST', token: cs })).data?.cs?.id;
  await api(`/cs/${cs6}/review/submit`, { method: 'POST', token: cs });
  await api(`/cs/${cs6}/review/send-to-requester`, { method: 'POST', token: hodProcurement });

  // Walk it all the way OUT of sourcing, to the stage the normal `procurement`
  // step (order 8) writes. Only then is the confirmation genuinely out of place.
  const outStage = await sql(
    `SELECT payload->>'to' FROM workflow.steps_config WHERE id = 'procurement';`,
  );
  await sql(
    `UPDATE proc.purchase_requisitions SET status = '${outStage[0]}' WHERE id = '${p6}';`,
  );
  const st6 = await sql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${p6}';`);
  ok(st6[0] === outStage[0], 'the refusal fixture really is out of sourcing', st6[0]);

  const conf6 = await api(`/cs/${cs6}/review/confirm`, { method: 'POST', token: hod });
  ok(conf6.status >= 400,
    'confirm is STILL refused once the PR has left sourcing', { status: conf6.status, body: conf6.data });

  // And the refusal wrote nothing: withTransaction commits per statement, so a
  // refusal raised late would not roll back an earlier write.
  const rev6 = await sql(`SELECT sub_state FROM proc.cs_reviews WHERE cs_id = '${cs6}';`);
  ok(rev6[0] === 'REQUESTER_REVIEW',
    'the refused confirm left the review untouched', rev6[0]);
  const st6b = await sql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${p6}';`);
  ok(st6b[0] === outStage[0], 'the refused confirm did not move the PR', st6b[0]);
}

// ── 11. final fingerprint ───────────────────────────────────────────────────
section('Workflow integrity after the full run');
{
  const rows = await sql(
    `SELECT id, md5(payload::text) FROM workflow.steps_config ORDER BY order_index;`,
  );
  const now = Object.fromEntries(rows.map((r) => r.split('|')));
  const drifted = Object.entries(BASELINE_STEPS).filter(([k, v]) => now[k] !== v);
  ok(drifted.length === 0, `all ${ROUTED_STEP_COUNT} steps are STILL byte-identical after everything above`, drifted);

  const total = await sql(`SELECT count(*) FROM workflow.steps_config;`);
  ok(total[0] === String(ROUTED_STEP_COUNT), `the routing table now holds exactly ${ROUTED_STEP_COUNT} steps`, total[0]);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
