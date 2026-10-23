// e2e_capex_opex.mjs — the per-line Capex/Opex classification and the award
// write-back, asserted end to end against a running API.
//
//   node scripts/e2e_capex_opex.mjs
//
// WHAT THIS SUITE IS FOR
// ----------------------
// e2e_cs_review.mjs proves the REVIEW CHAIN (who may confirm, what the blind
// mask hides). This suite proves the MONEY and the CLASS — the two things the
// request's number and its D365 payload are made of, and the two things the
// step-5 gate exists to protect.
//
// It is written as a separate suite, not more sections of the review suite,
// because the failure modes are different: a review suite that breaks usually
// means a role or a state machine moved. A failure HERE means a request
// reached a desk with a number nobody agreed to, or with a class nobody set.
//
// THE RULES UNDER TEST
// --------------------
//   1. A line that is being bought carries a Capex/Opex class, and a capital
//      line carries a useful life. The vocabulary is D365's own five values.
//   2. The class is made at step 5, by procurement — the desk that ran the
//      competition. Finance may correct it later, never set it early.
//   3. A statement cannot be CONFIRMED while an approved line carries no award
//      or no class. The refusal names the line.
//   4. Confirming writes the winning rates onto the request's own lines and
//      recomputes the header, so the cost centre approves a real number.
//   5. A HELD line is not the spend. It is not priced, not classified, and it
//      does not block the cost gate — that is the shape Case 16 was in.
//   6. The class reaches the D365 payload, and a capital line carries its
//      depreciation period.

import { quoteBody } from './_quote_helpers.mjs';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const LAPTOP = '55555555-5555-5555-5555-555555555503';
const PEN = '55555555-5555-5555-5555-555555555505';

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

console.log(`\n=== Capex/Opex classification + award sync against ${API} ===\n`);

const requester = await login('requester@pakboxes.pk');
const hod = await login('hod.sales@pakboxes.pk');
const procurement = await login('procurement@pakboxes.pk');
const cs = await login('cs@pakboxes.pk');
const finance = await login('finance@pakboxes.pk');
const admin = await login('admin@pakboxes.pk');
// HOD Procurement — the head of the Procurement DEPARTMENT. Not a role: every
// department head signs in as `hod`, so the API resolves this one from
// core.departments (code 'PROC' -> hod_user_id).
const hodProcurement = await login('hod.procurement@pakboxes.pk');
ok(
  Boolean(requester && hod && procurement && cs && finance && admin && hodProcurement),
  'all logins returned a token',
);

const ccs = await api('/lookups/cost-centers', { token: requester });
const costCenterId = ccs.data?.[0]?.id;

const STOCK = [
  { itemId: LAPTOP, quantity: 2, uom: 'EA', unitPriceEst: 45000 },
  { itemId: PEN, quantity: 1, uom: 'BOX', unitPriceEst: 45000 },
];

/**
 * Build a request that has been through sourcing and has a comparative
 * statement waiting.
 *
 * The prices differ per line on purpose: a fixture where every line costs the
 * same cannot tell a write-back from a no-op, because a wrong line rate still
 * produces the right header.
 */
async function buildPr({ scope, title, lineSpecs = STOCK, decisions = { 0: 'approved', 1: 'approved' }, prices }) {
  const created = await api('/pr', {
    method: 'POST', token: requester,
    body: { scope, expenseType: 'OPEX', costCenterId, requiredByDate: '2026-12-31', title, lines: lineSpecs },
  });
  const prId = created.data?.id;
  if (!prId) return { prId: null, error: created };

  await api(`/pr/${prId}/advance`, {
    method: 'POST', token: hod,
    body: { lineDecisions: decisions, reason: 'fixture' },
  });
  const stage = (await sql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${prId}';`))[0];

  const issued = await api(`/pr/${prId}/rfq`, { method: 'POST', token: procurement, body: {} });
  const rfqId = issued.data?.rfq?.id;
  const invites = issued.data?.invitations || [];

  // The RFQ only carries the lines that are actually being bought, so the
  // quote prices are keyed by the RFQ's own line numbering.
  const quotable = await sql(
    `SELECT l.line_no FROM proc.rfq_lines l
       JOIN proc.pr_lines pl ON pl.id = l.pr_line_id
      WHERE l.rfq_id = '${rfqId}'::uuid ORDER BY l.line_no;`,
  );
  const quoteLines = quotable.map((rfqLine, idx) => ({
    rfqLineNo: Number(rfqLine),
    unitPrice: (prices ?? [60000, 40000, 25000, 15000])[idx] ?? 30000,
    warrantyMonths: 12,
  }));

  for (const inv of invites.slice(0, 2)) {
    await api(`/rfq/${rfqId}/quotations`, {
      method: 'POST', token: procurement,
      body: await quoteBody(prId, procurement, inv.vendor_id,
        quoteLines.map((p) => ({ ...p, unitPrice: p.unitPrice + (inv === invites[0] ? 0 : 500) })),
        { leadTimeDays: 10 }),
    });
  }

  const gen = await api(`/pr/${prId}/cs`, { method: 'POST', token: cs });
  return {
    prId, stage, rfqId, invites, quoteLines,
    csId: gen.data?.cs?.id ?? gen.data?.id,
    winnerVendorId: invites[0]?.vendor_id,
  };
}

/** The item code (the ERP's ItemId) behind each PR line. */
async function skuLookup(prId) {
  const rows = await sql(
    `SELECT pl.line_no, i.item_code FROM proc.pr_lines pl
       LEFT JOIN core.items i ON i.id = pl.item_id
      WHERE pl.pr_id = '${prId}'::uuid ORDER BY pl.line_no;`,
  );
  return (lineNo) => (rows.find((r) => r.split('|')[0] === String(lineNo)) || '').split('|')[1];
}

/** Award one RFQ line to the cheapest vendor. */
async function award(fx, rfqLineNo, qty) {
  return api(`/cs/${fx.csId}/award`, {
    method: 'POST', token: procurement,
    body: { lineNo: rfqLineNo, vendorId: fx.winnerVendorId, qty, justification: 'fixture award — lowest evaluated quote' },
  });
}

/** Classify PR lines. `usefulLifeYears` is required for a capital class. */
async function classify(prId, lines, token = procurement) {
  return api(`/pr/${prId}/lines/classification`, { method: 'PATCH', token, body: { lines } });
}

/** Walk a statement to the blind gate.
 *
 * The officer DRAFTS it; HOD Procurement APPROVES it and forwards it on. That
 * split is the point — the desk that ran the competition does not sign off on
 * its own comparison, which is why `procurement` is refused here.
 */
async function toBlind(fx) {
  await api(`/cs/${fx.csId}/review/submit`, { method: 'POST', token: cs });
  await api(`/cs/${fx.csId}/review/send-to-requester`, { method: 'POST', token: hodProcurement });
}

// ── 0. where the flag lives ────────────────────────────────────────────────
section('Every route from a sourcing stage into cost approval is gated');
{
  const flagged = await sql(
    `SELECT id, order_index FROM workflow.steps_config
      WHERE (payload->>'requiresCapexOpex')::boolean = true ORDER BY order_index;`,
  );
  // EVERY route, from EITHER sourcing stage, not just the two out of procurement
  // review. Two gaps have been closed here, in the same shape:
  //
  //   1. the CS exit was gated while the ordinary procurement approval was not,
  //      so a request whose lines already carried the requester's own estimate
  //      walked straight to cost approval with no comparative statement, no
  //      award and no class;
  //   2. the confirm stopped being the thing that moves the PR (2026-10-21), so
  //      the crossing is now the advance's — and a request parked at
  //      QUOTES_RECEIVED by the Ready-for-CS hand-off had no gated route at all.
  //      That second one is a deadlock, not a hole: the requesting HOD could not
  //      confirm a blind review because the classification could not be made
  //      until after the confirmation that was being refused for it.
  //
  // Asserted as a SET rather than as a count, because a count is a statement
  // about how many doors exist and this claim is about which ones are locked.
  ok(
    flagged.map((f) => f.split('|')[0]).join(',') === 'cs_review,cs_review_quotes,procurement',
    'the CS exit (from both sourcing stages) and the direct step carry requiresCapexOpex', flagged,
  );
  const windows = await sql(
    `SELECT id, payload->>'from', payload->>'to' FROM workflow.steps_config
      WHERE (payload->>'requiresCapexOpex')::boolean = true ORDER BY order_index;`,
  );
  // Asserted positively, from the routing table itself: any step that ARRIVES at
  // cost approval out of sourcing must be gated, and the gate must never sit on a
  // step that continues past it — that was the original misplacement, on the two
  // Finance steps, which are later than the cost centre's decision.
  ok(
    windows.every((w) => {
      const [, from, to] = w.split('|');
      return ['IN_PROCUREMENT_REVIEW', 'QUOTES_RECEIVED'].includes(from) && to === 'IN_COST_CENTER_APPROVAL';
    }),
    'and every one of them crosses from a sourcing stage into cost approval', windows,
  );
  const past = await sql(
    `SELECT id FROM workflow.steps_config
      WHERE (payload->>'requiresCapexOpex')::boolean = true
        AND (payload->>'to')::text IN ('IN_FINANCE_REVIEW','IN_MANAGEMENT_REVIEW','READY_FOR_D365',
                                        'MC_APPROVED','CFO_APPROVED','PACK_LOCKED','D365_PUSHED');`,
  );
  ok(past.length === 0,
    'and NO gated step lands past cost approval — the class is settled before the centre sees it', past);

  const cleared = await sql(
    `SELECT id FROM workflow.steps_config
      WHERE id IN ('finance_review','finance_release','cfo_approval')
        AND (payload->>'requiresCapexOpex')::boolean = true;`,
  );
  ok(cleared.length === 0,
    'the finance and CFO steps carry no classification gate', cleared);

  const gateArmed = await sql(`SELECT value::text FROM core.settings WHERE key='capex_opex_gate_from';`);
  ok(Boolean(gateArmed[0]), 'the gate is armed from a recorded moment', gateArmed[0]);
}

// ── 1. the classification endpoint ─────────────────────────────────────────
section('The classification endpoint: vocabulary, life, and who may write');
{
  // A request that has not entered the CS review window at all.
  const fresh = (await api('/pr', {
    method: 'POST', token: requester,
    body: { scope: 'Capex/Opex — fresh request', expenseType: 'OPEX', costCenterId,
            requiredByDate: '2026-12-31', title: 'Capex/Opex fresh request', lines: STOCK },
  })).data?.id;
  const freshStage = (await sql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${fresh}';`))[0];

  // The vocabulary is D365's own, so a class the ERP does not know must not
  // reach the database.
  const bogus = await classify(fresh, [{ lineNo: 1, classification: 'SOMETHING_ELSE' }]);
  ok(bogus.status >= 400, 'a class outside the D365 vocabulary is refused', bogus.status);

  // A capital line with no depreciation period is not an asset.
  const noLife = await classify(fresh, [{ lineNo: 1, classification: 'CAPEX_ASSET' }]);
  ok(noLife.status >= 400, 'a CAPEX class with no useful life is refused', noLife.status);

  // The requester cannot classify their own spend.
  const asRequester = await classify(fresh, [{ lineNo: 1, classification: 'OPEX_SERVICE' }], requester);
  ok(asRequester.status >= 400, 'a requester cannot classify the lines', asRequester.status);

  // Finance may CORRECT, but only once the request has reached cost approval.
  const asFinance = await classify(fresh, [{ lineNo: 1, classification: 'OPEX_SERVICE' }], finance);
  ok(asFinance.status >= 400, 'finance cannot classify a request that has not reached cost approval', asFinance.status);

  // And procurement can only classify inside the step-5 window.
  const asProc = await classify(fresh, [{ lineNo: 1, classification: 'OPEX_SERVICE' }]);
  ok(asProc.status >= 400,
    `procurement cannot classify a request at ${freshStage} — outside step 5`, { http: asProc.status, body: asProc.data });

  // Nothing was written by any of those refusals.
  const after = await sql(
    `SELECT count(*) FROM proc.pr_lines WHERE pr_id = '${fresh}'::uuid AND classification IS NOT NULL;`,
  );
  ok(after[0] === '0', 'not one refused classification was written', after[0]);
}

// ── 2. the classification endpoint, inside step 5 ──────────────────────────
section('Inside step 5 the class can be set — and is recorded with its author');
{
  const fx = await buildPr({ scope: 'Capex/Opex — classification window', title: 'Capex/Opex classification window' });
  ok(Boolean(fx.prId && fx.csId), 'fixture built', fx);
  ok(fx.stage === 'IN_PROCUREMENT_REVIEW', 'the fixture sits in procurement review', fx.stage);

  // A line that does not exist.
  const ghost = await classify(fx.prId, [{ lineNo: 99, classification: 'OPEX_SERVICE' }]);
  ok(ghost.status >= 400, 'a line that does not exist is refused', ghost.status);

  // A capital line WITH a life is accepted, and the life is kept.
  const cap = await classify(fx.prId, [{ lineNo: 1, classification: 'CAPEX_ASSET', usefulLifeYears: 7 }]);
  ok(cap.status === 200 || cap.status === 201, 'a CAPEX class with a useful life is accepted', { http: cap.status, body: cap.data });

  const stored = await sql(
    `SELECT classification, useful_life_years, classified_by IS NOT NULL, classification_source, classified_at IS NOT NULL
       FROM proc.pr_lines WHERE pr_id = '${fx.prId}'::uuid AND line_no = 1;`,
  );
  const st = (stored[0] || '').split('|');
  ok(st[0] === 'CAPEX_ASSET', 'the class is stored on the line', stored[0]);
  ok(Number(st[1]) === 7, 'the useful life is stored on the line', stored[0]);
  ok(st[2] === 't', 'the author is recorded', stored[0]);
  ok(st[3] === 'manual', 'the source is recorded as a manual classification', stored[0]);
  ok(st[4] === 't', 'the moment is recorded', stored[0]);

  // The class is what the D365 contract calls it, not a near-miss.
  const d365 = await api(`/pr/${fx.prId}/d365/payload`, { token: cs });
  const skuOf = await skuLookup(fx.prId);
  const poLine = (d365.data?.lines || []).find((l) => l.ItemId === skuOf(1));
  ok(poLine?.ProcurementCategory === 'CAPEX',
    'the ERP payload marks the line CAPEX from the class procurement set', poLine);

  // A CAPEX class with no life is refused even after one was accepted.
  const capNoLife = await classify(fx.prId, [{ lineNo: 2, classification: 'CAPEX_INFRA' }]);
  ok(capNoLife.status >= 400, 'a CAPEX class with no useful life is still refused', capNoLife.status);
}

// ── 3. the confirm refuses an undecided line ───────────────────────────────
section('The confirm refuses a line nobody awarded');
{
  const fx = await buildPr({ scope: 'Capex/Opex — unawarded line', title: 'Capex/Opex unawarded line' });
  ok(Boolean(fx.prId && fx.csId), 'fixture built', fx);

  // Line 1 is awarded and classified. Line 2 is not awarded at all.
  await award(fx, 1, STOCK[0].quantity);
  await classify(fx.prId, [
    { lineNo: 1, classification: 'OPEX_CONSUMABLE' },
    { lineNo: 2, classification: 'OPEX_CONSUMABLE' },
  ]);
  await toBlind(fx);

  const r = await api(`/cs/${fx.csId}/review/confirm`, { method: 'POST', token: hod });
  ok(r.status >= 400, 'the confirm is refused while a line has no award', { http: r.status, body: r.data });
  ok(/award/i.test(String(r.data?.message || '')),
    'the refusal names the award as the reason', r.data?.message);
  ok(/\b2\b/.test(String(r.data?.message || '')),
    'the refusal names the line', r.data?.message);

  // And it wrote nothing.
  const state = await sql(
    `SELECT cr.sub_state, cs.state FROM proc.cs_reviews cr
       JOIN proc.comparative_statements cs ON cs.id = cr.cs_id
      WHERE cr.cs_id = '${fx.csId}'::uuid;`,
  );
  ok(state[0] === 'REQUESTER_REVIEW|Generated',
    'the refused confirm left the review and the statement untouched', state[0]);
  const prState = await sql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${fx.prId}';`);
  ok(prState[0] === 'IN_PROCUREMENT_REVIEW', 'the refused confirm did not move the request', prState[0]);
}

// ── 4. the CLASSIFICATION gate now sits on the crossing, not the confirm ────
section('The blind reviewer may confirm an unclassified line; the crossing may not');
{
  const fx = await buildPr({ scope: 'Capex/Opex — unclassified line', title: 'Capex/Opex unclassified line' });
  ok(Boolean(fx.prId && fx.csId), 'fixture built', fx);

  // Both lines are awarded. Only line 1 is classified.
  await award(fx, 1, STOCK[0].quantity);
  await award(fx, 2, STOCK[1].quantity);
  await classify(fx.prId, [{ lineNo: 1, classification: 'OPEX_CONSUMABLE' }]);
  await toBlind(fx);

  // THE DEADLOCK THIS FIXES.
  //
  // This used to be `ok(r.status >= 400, 'the confirm is refused while a line has
  // no class')` — and it was the right assertion for the wrong reason, written
  // to lock in a control that was actually a trap. The person confirming here is
  // the REQUESTING HOD: they are verifying the vendors' commercial rates blind.
  // They do not hold the classification fields, they do not have the context,
  // and the class is PROCUREMENT's decision — made after this confirmation.
  //
  // So the backend was asking the wrong desk for a decision that could not exist
  // yet, on a request nobody could move past the asking. It was reported live as
  // PR-2026-202043 / CS-2026-200663, where the requesting HOD simply could not
  // finish a blind review.
  const r = await api(`/cs/${fx.csId}/review/confirm`, { method: 'POST', token: hod });
  ok(r.status === 200 || r.status === 201,
    'the blind reviewer CAN confirm a comparison whose lines are not all classified',
    { http: r.status, body: r.data });

  const stayedPut = await sql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${fx.prId}';`);
  ok(stayedPut[0] === 'IN_PROCUREMENT_REVIEW',
    'and the request stays in sourcing — the confirm no longer moves it', stayedPut[0]);

  // The control did not disappear. It moved to the action that actually crosses
  // into cost approval, and it is asserted HERE, on the same fixture, one call
  // later — which is the only place it can mean anything.
  const blocked = await api(`/pr/${fx.prId}/advance`, {
    method: 'POST', token: procurement,
    body: { reason: 'unclassified', csReviewConfirmed: true },
  });
  ok(blocked.status >= 400, 'the ADVANCE is refused while a line has no class', { http: blocked.status, body: blocked.data });
  ok(/Capex\/Opex|class/i.test(String(blocked.data?.message || '')),
    'the refusal names the classification as the reason', blocked.data?.message);
  ok(/\b2\b/.test(String(blocked.data?.message || '')),
    'the refusal names the line', blocked.data?.message);

  const stillIn = await sql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${fx.prId}';`);
  ok(stillIn[0] === 'IN_PROCUREMENT_REVIEW', 'and the refused advance did not move the request', stillIn[0]);

  // Classify the missing line and the same advance goes through. The confirm
  // needed no second attempt — it was never the thing refusing.
  await classify(fx.prId, [{ lineNo: 2, classification: 'OPEX_SERVICE' }]);
  const r2 = await api(`/pr/${fx.prId}/advance`, {
    method: 'POST', token: procurement,
    body: { reason: 'classified', csReviewConfirmed: true },
  });
  ok(r2.status === 200 || r2.status === 201,
    'the same advance succeeds once the class is set', { http: r2.status, body: r2.data });
  ok(r2.data?.matchedStep === 'cs_review',
    'through the gated CS exit step', r2.data?.matchedStep);
  const landed = await sql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${fx.prId}';`);
  ok(landed[0] === 'IN_COST_CENTER_APPROVAL', 'and the request reached cost approval', landed[0]);
}

// ── 5. the success path — the money moves ──────────────────────────────────
section('A complete step 5: the winning rates reach the request');
{
  const fx = await buildPr({ scope: 'Capex/Opex — complete pack', title: 'Capex/Opex complete pack' });
  ok(Boolean(fx.prId && fx.csId), 'fixture built', fx);

  await award(fx, 1, STOCK[0].quantity);
  await award(fx, 2, STOCK[1].quantity);
  await classify(fx.prId, [
    { lineNo: 1, classification: 'CAPEX_ASSET', usefulLifeYears: 5 },
    { lineNo: 2, classification: 'OPEX_CONSUMABLE' },
  ]);
  await toBlind(fx);

  const r = await api(`/cs/${fx.csId}/review/confirm`, { method: 'POST', token: hod });
  ok(r.status === 200 || r.status === 201, 'the blind reviewer confirms', { http: r.status, body: r.data });
  ok(r.data?.statement_locked === true, 'the statement was locked', r.data?.statement_locked);
  ok(r.data?.award_mode === 'SPLIT', 'it was locked as a per-line split', r.data?.award_mode);
  ok(Array.isArray(r.data?.rates_applied) && r.data.rates_applied.length === 2,
    'both rates were written back', r.data?.rates_applied);

  // The lines now carry the AWARDED rate, and the requester's budget is kept.
  const lines = await sql(
    `SELECT line_no, quantity, unit_price_est, budget_unit_price, classification, useful_life_years
       FROM proc.pr_lines WHERE pr_id = '${fx.prId}'::uuid ORDER BY line_no;`,
  );
  let spend = 0, capex = 0, opex = 0;
  for (const row of lines) {
    const [lineNo, qty, price, budget, cls, life] = row.split('|');
    spend += Number(qty) * Number(price);
    if (String(cls).startsWith('CAPEX')) capex += Number(qty) * Number(price);
    else opex += Number(qty) * Number(price);
    ok(Number(price) !== 45000, `line ${lineNo} carries the AWARDED rate, not the requester's estimate`, row);
    ok(Number(budget) === 45000, `line ${lineNo} kept the requester's budget`, row);
    ok(cls && cls !== '', `line ${lineNo} carries its class`, row);
    if (String(cls).startsWith('CAPEX')) ok(Number(life) === 5, `line ${lineNo} kept its useful life`, row);
  }

  // The header is the sum of the lines, split by class.
  const head = await sql(
    `SELECT estimated_amount, amount_status, capex_amount, opex_amount
       FROM proc.purchase_requisitions WHERE id = '${fx.prId}'::uuid;`,
  );
  const hp = (head[0] || '').split('|');
  ok(Number(hp[0]) === spend, 'the header is the sum of the awarded lines', head[0]);
  ok(hp[1] === 'ESTIMATED', 'the header says the amount is known', head[0]);
  ok(Number(hp[2]) === capex && Number(hp[3]) === opex,
    'the header splits the spend into capital and operating', head[0]);
  ok(capex > 0 && opex > 0, 'the fixture really is a mixed pack', head[0]);

  const stage = await sql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${fx.prId}';`);
  ok(stage[0] === 'IN_PROCUREMENT_REVIEW',
    'the confirm left the request in sourcing; the advance owns the crossing', stage[0]);

  const adv = await api(`/pr/${fx.prId}/advance`, {
    method: 'POST', token: procurement,
    body: { reason: 'confirmed and classified', csReviewConfirmed: true },
  });
  ok(adv.status === 200 || adv.status === 201,
    'the classified request advances', { http: adv.status, body: adv.data });
  const stage2 = await sql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${fx.prId}';`);
  ok(stage2[0] === 'IN_COST_CENTER_APPROVAL', 'the request is at cost approval', stage2[0]);

  // The class reaches the ERP payload, and the capital line carries its life.
  const d365 = await api(`/pr/${fx.prId}/d365/payload`, { token: cs });
  const skuOf = await skuLookup(fx.prId);
  const poLines = d365.data?.lines || [];
  const capexPo = poLines.find((l) => l.ItemId === skuOf(1));
  ok(capexPo?.ProcurementCategory === 'CAPEX', 'the ERP payload marks the capital line CAPEX', capexPo);
  ok(Number(capexPo?.DepreciationPeriod) === 60,
    'the ERP payload carries the 5-year depreciation period (5 x 12 months)', capexPo);
  ok(capexPo?.FixedAssetGroup, 'a capital line carries the fixed-asset group', capexPo);
  const opexPo = poLines.find((l) => l.ItemId === skuOf(2));
  ok(opexPo?.ProcurementCategory === 'OPEX', 'the ERP payload marks the operating line OPEX', opexPo);
  ok(!('FixedAssetGroup' in (opexPo || {})), 'an operating line carries no fixed-asset fields', opexPo);
}

// ── 6. a held line is not the spend ─────────────────────────────────────────
section('A held line is not the spend (the Case 16 shape)');
{
  const three = [
    { itemId: LAPTOP, quantity: 2, uom: 'EA', unitPriceEst: 900 },
    { itemId: PEN, quantity: 1, uom: 'BOX', unitPriceEst: 1200 },
    { itemId: LAPTOP, quantity: 1, uom: 'EA', unitPriceEst: 0 },
  ];
  const fx = await buildPr({
    scope: 'Capex/Opex — held line', title: 'Capex/Opex held line',
    lineSpecs: three,
    decisions: { 0: 'approved', 1: 'approved', 2: 'held' },
    prices: [900, 1200],
  });
  ok(Boolean(fx.prId && fx.csId), 'fixture built', fx);

  // The held line never went out to vendors, so the RFQ carries two lines.
  ok(fx.quoteLines.length === 2, 'the held line was never put out to vendors', fx.quoteLines.length);

  // It cannot be classified — it is not being bought.
  const held = await classify(fx.prId, [{ lineNo: 3, classification: 'OPEX_CONSUMABLE' }]);
  ok(held.status >= 400, 'a held line cannot be classified', { http: held.status, body: held.data });

  await award(fx, 1, 2);
  await award(fx, 2, 1);
  await classify(fx.prId, [
    { lineNo: 1, classification: 'OPEX_CONSUMABLE' },
    { lineNo: 2, classification: 'OPEX_CONSUMABLE' },
  ]);
  await toBlind(fx);

  const r = await api(`/cs/${fx.csId}/review/confirm`, { method: 'POST', token: hod });
  ok(r.status === 200 || r.status === 201,
    'the confirm goes through with a held line on the request', { http: r.status, body: r.data });

  // The held line was never given an award rate. It keeps whatever the
  // requester put on it — here zero — because it is not being bought, and the
  // award write-back only ever touches the approved lines.
  const lines = await sql(
    `SELECT line_no, approved, held, unit_price_est, classification
       FROM proc.pr_lines WHERE pr_id = '${fx.prId}'::uuid ORDER BY line_no;`,
  );
  const l3 = (lines.find((r) => r.startsWith('3|')) || '').split('|');
  ok(l3[1] === 'f' && l3[2] === 't', 'line 3 is held, not approved', lines.join(' / '));
  ok(Number(l3[3]) === 0,
    'the held line was given no award rate — it keeps the requester\'s own figure', lines.join(' / '));
  ok(Number(l3[3]) !== 900 && Number(l3[3]) !== 1200,
    'the held line was not priced by the winning quote', lines.join(' / '));
  ok(!l3[4], 'the held line carries no class', lines.join(' / '));

  // 2 x 900 + 1 x 1200 = 3000, and the held line contributes nothing.
  const head = await sql(
    `SELECT estimated_amount, amount_status FROM proc.purchase_requisitions WHERE id = '${fx.prId}'::uuid;`,
  );
  ok(head[0] === '3000.00|ESTIMATED',
    'the header is the approved lines only — the held line adds nothing', head[0]);
}

// ── 7. BOTH doors out of step 4 ───────────────────────────────────────────
section('Both doors out of step 4, and the retired role');
{
  // `procurement_manager` is retired. Procurement is a department under the same
  // HOD hierarchy as Finance, HR, IT and Operations, so its head is a user whose
  // role is `hod` and whose IDENTITY comes from core.departments.
  const holders = await sql(`SELECT count(*) FROM core.users WHERE role = 'procurement_manager';`);
  ok(holders[0] === '0', 'no user holds procurement_manager', holders[0]);

  const stranded = await sql(
    `SELECT id FROM workflow.steps_config WHERE payload->>'actorRole' = 'procurement_manager';`,
  );
  ok(stranded.length === 0, 'no step is owned by the retired role', stranded);

  const bands = await sql(
    `SELECT count(*) FROM core.authority_matrix WHERE 'procurement_manager' = ANY(required_roles);`,
  );
  ok(bands[0] === '0', 'no routing band still requires the retired role', bands[0]);

  const hodProc = await sql(
    `SELECT d.code, u.email, u.role, (u.department_id = d.id) AS both_ways
       FROM core.departments d JOIN core.users u ON u.id = d.hod_user_id
      WHERE d.code = 'PROC';`,
  );
  ok(hodProc.length === 1 && hodProc[0] === 'PROC|hod.procurement@pakboxes.pk|hod|t',
    'HOD Procurement exists and is mapped BOTH ways', hodProc);

  // ── 7a. the flag now ARRIVES, and is verified ──────────────────────────
  //
  // `csReviewConfirmed` used to be stripped by ValidationPipe's whitelist, so
  // this call could never reach the cs_review step: the step was evaluated and
  // then rejected on a condition whose flag had already been deleted. It is
  // declared on the DTO now, so it arrives — and the SERVICE checks it against
  // the database instead of trusting it. Declaring the property is what makes a
  // value visible; refusing to believe it is what keeps the blind review a
  // control rather than a claim in a request body.
  const fx = await buildPr({ scope: 'Capex/Opex — advance door', title: 'Capex/Opex advance door' });
  ok(Boolean(fx.prId), 'fixture built', fx);

  // Procurement MAY fire the CS exit. This used to be a 403 — "the step belongs to
  // the HOD" — and the refusal was the ROLE check, not the claim check: the
  // `cs_review` step names `hod` as its actor, and `roleAllowed('procurement',
  // 'hod')` is false. But the 2026-10-21 instruction is that "Procurement / HOD
  // Procurement advances" the classified request out of step 5, and procurement
  // is the desk that classifies the lines and therefore the desk that advances
  // them. The CS exit is keyed on the two DESKS, not on one role string.
  //
  // So this call is no longer refused for WHO is calling. It is refused for
  // WHAT is claimed, which is the point of the guard: the fixture has no
  // confirmed comparative statement, so `csReviewConfirmed` is a claim the
  // database contradicts.
  const advAsProc = await api(`/pr/${fx.prId}/advance`, {
    method: 'POST', token: procurement, body: { csReviewConfirmed: true },
  });
  ok(advAsProc.status >= 400,
    'procurement reaches the CS exit — the step no longer belongs to the HOD alone',
    { http: advAsProc.status, body: advAsProc.data });
  ok(!/Only .* can action/i.test(String(advAsProc.data?.message || '')),
    'and the refusal is NOT a role refusal', advAsProc.data?.message);
  ok(/review\/confirm/i.test(String(advAsProc.data?.message || '')),
    'it is the claim check — the flag is refused against the database', advAsProc.data?.message);

  // As the actor the step actually names. Authority passes, so this is the
  // guard doing the work: the review has not been confirmed, so the flag is a
  // claim the database contradicts.
  const adv = await api(`/pr/${fx.prId}/advance`, {
    method: 'POST', token: hodProcurement, body: { csReviewConfirmed: true },
  });
  ok(adv.status >= 400,
    'the csReviewConfirmed flag is REFUSED while the blind review is not confirmed',
    { http: adv.status, body: adv.data });
  ok(/review\/confirm/i.test(String(adv.data?.message || '')),
    'the refusal names the route that actually owns the CS exit', adv.data?.message);
  const stillInSourcing = await sql(
    `SELECT status FROM proc.purchase_requisitions WHERE id = '${fx.prId}';`,
  );
  ok(stillInSourcing[0] === 'IN_PROCUREMENT_REVIEW',
    'the refused advance left the request where it was', stillInSourcing[0]);

  // ── 7b. THE BYPASS IS CLOSED ──────────────────────────────────────────
  //
  // This is the audit's Finding 1, which used to be recorded as an open gap: the
  // `procurement` step (when: always, IN_PROCUREMENT_REVIEW ->
  // IN_COST_CENTER_APPROVAL) carried no requiresCapexOpex, so an ordinary
  // approval walked to cost approval with no CS, no award and no class. The flag
  // is on that step now, so the same call is refused — and refused for the RIGHT
  // reason: the classification, not authority.
  const plain = await api(`/pr/${fx.prId}/advance`, {
    method: 'POST', token: procurement, body: { reason: 'plain procurement advance' },
  });
  ok(plain.status >= 400,
    'a plain procurement advance is REFUSED while a line is unclassified',
    { http: plain.status, body: plain.data });
  ok(/Capex\/Opex|class/i.test(String(plain.data?.message || '')),
    'the refusal names the classification as the reason', plain.data?.message);
  // `evaluatedSteps` is only reported on a successful advance — a refusal is an
  // error shape — so what identifies the step here is the gate that fired.
  const refusedStage = await sql(
    `SELECT status FROM proc.purchase_requisitions WHERE id = '${fx.prId}';`,
  );
  ok(refusedStage[0] === 'IN_PROCUREMENT_REVIEW',
    'and the request did not move', refusedStage[0]);

  const unclassified = await sql(
    `SELECT count(*) FROM proc.pr_lines
      WHERE pr_id = '${fx.prId}'::uuid AND approved = true AND rejected = false AND held = false
        AND classification IS NULL;`,
  );
  ok(unclassified[0] === '2', 'both approved lines are still unclassified', unclassified[0]);

  // ── 7c. and the gate OPENS once the class exists ───────────────────────
  //
  // A gate that refuses unconditionally is not a gate, it is a wall. HOD
  // Procurement — an identity, not a role, so this could not be written as a
  // role string at all — classifies both lines, and the very same advance then
  // goes through. That is what proves the flag is a rule rather than a blanket
  // refusal.
  const byHod = await classify(fx.prId, [
    { lineNo: 1, classification: 'OPEX_CONSUMABLE' },
    { lineNo: 2, classification: 'OPEX_CONSUMABLE' },
  ], hodProcurement);
  ok(byHod.status === 200 || byHod.status === 201,
    'HOD Procurement may classify inside step 5', { http: byHod.status, body: byHod.data });

  const who = await sql(
    `SELECT count(*) FROM proc.pr_lines
      WHERE pr_id = '${fx.prId}'::uuid AND classification = 'OPEX_CONSUMABLE'
        AND classification_source = 'manual';`,
  );
  ok(who[0] === '2', 'both lines carry the class HOD Procurement set', who[0]);

  const now = await api(`/pr/${fx.prId}/advance`, {
    method: 'POST', token: procurement, body: { reason: 'plain procurement advance' },
  });
  ok(now.status === 200 || now.status === 201,
    'the same advance is ACCEPTED once the lines are classified',
    { http: now.status, body: now.data });
  ok(now.data?.matchedStep === 'procurement',
    'and it took the procurement step', now.data?.matchedStep);
  const landed = await sql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${fx.prId}';`);
  ok(landed[0] === 'IN_COST_CENTER_APPROVAL',
    'the request reached cost approval — classified, with no comparative statement at all', landed[0]);

  // ── 7d. HOD Procurement is one of five heads, and only one of them ─────
  //
  // Every department head signs in as `hod`, so a role check cannot tell them
  // apart. This is the assertion that fails if the department lookup is ever
  // replaced by roleAllowed(role, 'hod') — which would hand the Procurement
  // sign-off to the Head of Finance.
  const otherHead = await api(`/pr/${fx.prId}/lines/classification`, {
    method: 'PATCH', token: hod,
    body: { lines: [{ lineNo: 1, classification: 'OPEX_SERVICE' }] },
  });
  ok(otherHead.status >= 400,
    'the Head of Sales may NOT act as HOD Procurement',
    { http: otherHead.status, body: otherHead.data });
}

// ── 8. re-apply award & sync rates ─────────────────────────────────────────
section('Re-apply Award & Sync Rates repairs a request that lost its rates');
{
  const fx = await buildPr({ scope: 'Capex/Opex — reapply', title: 'Capex/Opex reapply' });
  await award(fx, 1, STOCK[0].quantity);
  await award(fx, 2, STOCK[1].quantity);
  await classify(fx.prId, [
    { lineNo: 1, classification: 'OPEX_CONSUMABLE' },
    { lineNo: 2, classification: 'OPEX_CONSUMABLE' },
  ]);
  await toBlind(fx);
  const c = await api(`/cs/${fx.csId}/review/confirm`, { method: 'POST', token: hod });
  ok(c.status === 200 || c.status === 201, 'the pack is confirmed', { http: c.status, body: c.data });

  // Break it the way the estate was broken: the rates are gone from the lines
  // and the header says UNKNOWN. The API cannot create this state, so it is
  // created here — and then repaired through the API, which is the point.
  await sql(
    `UPDATE proc.pr_lines SET unit_price_est = NULL, budget_unit_price = NULL
      WHERE pr_id = '${fx.prId}'::uuid;`,
  );
  await sql(
    `UPDATE proc.purchase_requisitions SET estimated_amount = 0, amount_status = 'UNKNOWN'
      WHERE id = '${fx.prId}'::uuid;`,
  );
  const broken = await sql(
    `SELECT amount_status, (SELECT count(*) FROM proc.pr_lines WHERE pr_id = '${fx.prId}'::uuid AND unit_price_est IS NOT NULL)
       FROM proc.purchase_requisitions WHERE id = '${fx.prId}'::uuid;`,
  );
  ok(broken[0] === 'UNKNOWN|0', 'the request is broken', broken[0]);

  // A requester has no business repairing it.
  const asRequester = await api(`/pr/${fx.prId}/reapply-award`, { method: 'POST', token: requester });
  ok(asRequester.status >= 400, 'a requester cannot re-apply the award', asRequester.status);

  const rep = await api(`/pr/${fx.prId}/reapply-award`, { method: 'POST', token: procurement });
  ok(rep.status === 200 || rep.status === 201, 'procurement re-applies the award', { http: rep.status, body: rep.data });

  const fixed = await sql(
    `SELECT p.amount_status, p.estimated_amount,
            (SELECT count(*) FROM proc.pr_lines WHERE pr_id = '${fx.prId}'::uuid AND unit_price_est IS NOT NULL)
       FROM proc.purchase_requisitions p WHERE p.id = '${fx.prId}'::uuid;`,
  );
  ok(fixed[0].split('|')[0] === 'ESTIMATED', 'the amount is known again', fixed[0]);
  ok(fixed[0].split('|')[2] === '2', 'both lines carry a rate again', fixed[0]);
  ok(Number(fixed[0].split('|')[1]) > 0, 'the header carries the total again', fixed[0]);

  // The repair is audited, and the statement is not re-locked behind the
  // requester's back.
  const audited = await sql(
    `SELECT count(*) FROM audit.audit_log
      WHERE entity = 'proc.purchase_requisitions' AND entity_id = '${fx.prId}' AND action = 'repair';`,
  );
  ok(Number(audited[0]) > 0, 'the repair is in the audit trail', audited[0]);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
