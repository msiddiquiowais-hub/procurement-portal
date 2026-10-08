// Wave 3 step 2 — governance gates: MC vote, CFO decision, pack lock.
//
//   node scripts/e2e_governance.mjs
//
// Requires: Postgres on 55432, the API on 33001, migration 027 applied.
//
// What this suite proves:
//   1. The MC panel is DATA — 5 appointed members, one chair, and a quorum
//      derived from workflow.mc_panel rather than a hardcoded 5.
//   2. Voting is gated on CS_LOCKED, with the prototype's own refusal text.
//   3. UNANIMITY. 4/5 does NOT advance the PR. This is the assertion that
//      would have caught the whole class of quorum bug.
//   4. One reject collapses the round, returns the PR to sourcing, clears the
//      votes — and the audit log keeps the objection answerable.
//   5. A new CS round can then be generated; round 1 is preserved, not overwritten.
//   6. The CFO's reject returns to the MC gate, NOT to sourcing. The two
//      rejects go in opposite directions and must stay that way.
//   7. The pack freezes once, with six REAL sha256 digests — and on FAST_TRACK
//      the two skipped documents carry no hash at all (F2).
//   8. The auto-complete demo helper is refused unless DEMO_HELPERS=1 (F3).

import { spawnSync } from 'child_process';
import { issueWithRoster } from './_rfq_roster.mjs';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';

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

/**
 * psql probe. spawnSync (not execFileSync) because psql sends RAISE NOTICE to
 * STDERR, and a NOTICE is as assertable as a row here — the trigger's refusal
 * messages are the evidence.
 */
function psql(sql) {
  const r = spawnSync(
    'docker', ['exec', '-i', 'procurement-portal-db', 'psql', '-U', 'proc',
               '-d', 'procurementDB', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { input: `SET app.bypass_rls = 'true';\n${sql}`, encoding: 'utf8' },
  );
  return `${r.stdout || ''}${r.stderr || ''}`.trim();
}

async function login(email) {
  const r = await api('/auth/login', { method: 'POST', body: { email, password: 'demo' } });
  return r.data?.token;
}

const LAPTOP = '55555555-5555-5555-5555-555555555503'; // PKB-LT-001, IT_HARDWARE
const DOCK = '55555555-5555-5555-5555-555555555501';   // PKB-CS-001, WAREHOUSE_ACCESSORY

// ── the panel ──────────────────────────────────────────────────────────────

const panel = await login('mc.member1@pakboxes.pk');
const panel2 = await login('mc.member2@pakboxes.pk');
const panel3 = await login('mc.member3@pakboxes.pk');
const panel4 = await login('mc.member4@pakboxes.pk');
const panel5 = await login('mc.member5@pakboxes.pk');
const cfo = await login('cfo@pakboxes.pk');
const csUser = await login('cs@pakboxes.pk');
const proc = await login('procurement@pakboxes.pk');
const requester = await login('requester@pakboxes.pk');
const hod = await login('hod.sales@pakboxes.pk');
const admin = await login('admin@pakboxes.pk');
ok(Boolean(panel && panel2 && panel3 && panel4 && panel5 && cfo && csUser && proc && requester && hod && admin),
  'all five panel members + cfo + cs + procurement + requester + hod + admin logged in');

const PANEL_TOKENS = [panel, panel2, panel3, panel4, panel5];

// ── fixture: a PR driven to CS_LOCKED ──────────────────────────────────────

console.log('\n--- fixture: PR -> RFQ -> quotes -> CS -> CS_LOCKED ---');

/**
 * Build a PR that is already in IN_PROCUREMENT_REVIEW.
 *
 * The advance is the HOD's, with an explicit per-line decision — advancing as
 * procurement applies the LINE RULES, and a high-value line gets routed to the
 * IT Manager instead of reaching procurement review. Same trap e2e_sourcing
 * hits; the lineDecisions body is what keeps the whole PR on one path.
 */
async function fixture(title, unitPriceEst = 30_000) {
  const ccs = await api('/lookups/cost-centers', { token: requester });
  const costCenterId = ccs.data?.[0]?.id;
  const c = await api('/pr', {
    method: 'POST', token: requester,
    body: {
      scope: 'Wave 3 step 2 governance fixture', expenseType: 'OPEX', costCenterId,
      requiredByDate: '2026-12-31', title, description: title,
      lines: [{ itemId: LAPTOP, quantity: 1, uom: 'EA', unitPriceEst }],
    },
  });
  if (![200, 201].includes(c.status)) throw new Error(`fixture create failed: ${JSON.stringify(c.data)}`);
  const id = c.data.id;
  const a = await api(`/pr/${id}/advance`, {
    method: 'POST', token: hod,
    body: { lineDecisions: { 0: 'approved' }, reason: 'HOD approved for the governance walkthrough' },
  });
  const landed = a.data?.nextStage || a.data?.stage || a.data?.status;
  if (landed !== 'IN_PROCUREMENT_REVIEW') {
    throw new Error(`fixture did not reach IN_PROCUREMENT_REVIEW, landed at ${landed}`);
  }
  return { prId: id };
}

/**
 * Record a quotation against the RFQ.
 *
 * per_line with rfqLineNo + unitPrice, because that is the shape the service
 * validates against rfq_lines; a grand_total with an empty lines array is
 * refused. The RFQ snapshots the PR's lines, so line 1 is the whole PR here.
 * Differing prices / lead times / warranties are what the CS scoring reads, so
 * they are varied on purpose.
 */
async function quote(rfqId, vendorId, { unitPrice, leadTimeDays, warrantyMonths }) {
  return api(`/rfq/${rfqId}/quotations`, {
    method: 'POST', token: proc,
    body: {
      vendorId, quoteMode: 'per_line', currency: 'PKR',
      subtotal: unitPrice, taxPercent: 0, freight: 0,
      leadTimeDays, warrantyMonths, validityDays: 30, taxesIncluded: false,
      paymentTerms: '30 days net', notes: 'Quoted for the governance walkthrough.',
      lines: [{ rfqLineNo: 1, unitPrice }],
    },
  });
}

const std = await fixture('Governance e2e — laptops + docking stations');
const prId = std.prId;
ok(Boolean(prId), 'PR created and advanced to IN_PROCUREMENT_REVIEW', { prId });

// Force a STANDARD route so the MC and CFO gates actually run.
psql(`UPDATE proc.purchase_requisitions SET routing_key = 'STANDARD' WHERE id = '${prId}';`);

// The automatic roster is CATEGORY-matched and risk-filtered, so it can be
// shorter than the prototype's 3. issueWithRoster tops it up via the supported
// invite path — and asserting `>= 3` afterwards is now a real check rather than
// a fact about how the pool used to sort.
const { rfqId, invites: roster } = await issueWithRoster(api, proc, prId, 3);
ok(true, 'RFQ issued');
ok(roster.length >= 3, `roster has ${roster.length} vendors`);

// Prices fall and warranties rise across the three vendors, so the min-max
// scoring has something real to rank on every axis.
const OFFERS = [
  { unitPrice: 28_000, leadTimeDays: 21, warrantyMonths: 36 },
  { unitPrice: 31_000, leadTimeDays: 10, warrantyMonths: 24 },
  { unitPrice: 34_000, leadTimeDays: 30, warrantyMonths: 12 },
];
let n = 0;
for (const v of roster.slice(0, 3)) {
  n += 1;
  const q = await quote(rfqId, v.vendor_id, OFFERS[n - 1]);
  ok([200, 201].includes(q.status), `quote recorded for vendor ${n}`, { status: q.status, msg: q.data?.message });
}

const gen = await api(`/pr/${prId}/cs`, { method: 'POST', token: csUser, body: {} });
ok([200, 201].includes(gen.status), 'CS generated', gen.data?.message);
const csId = gen.data?.cs?.id;
const csLines = gen.data?.lines || [];
ok(csLines.length === 3, `CS scored ${csLines.length} vendors`);
ok(gen.data?.cs?.cs_round === 1, 'first CS is round 1', gen.data?.cs?.cs_round);

const lk = await api(`/cs/${csId}/lock`, {
  method: 'POST', token: csUser,
  body: { winnerVendorId: csLines[0].vendor_id, reason: 'Best weighted score.' },
});
ok([200, 201].includes(lk.status), 'CS locked', lk.data?.message);
ok(lk.data?.stage === 'CS_LOCKED', 'the PR is at CS_LOCKED', lk.data?.stage);

const prStage = psql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${prId}';`);
ok(prStage === 'CS_LOCKED', 'DB agrees the PR is at CS_LOCKED', prStage);

// ── 1 · the panel is data ──────────────────────────────────────────────────

console.log('\n--- the MC panel is appointed rows, not a hardcoded list ---');

const mc = await api(`/pr/${prId}/mc`, { token: panel });
ok(mc.status === 200, 'GET /pr/:id/mc 200', mc.data?.message);
ok(mc.data?.panel?.length === 5, 'the panel has 5 members', mc.data?.panel?.length);
ok(mc.data?.panel?.filter(p => p.chair).length === 1, 'exactly one chair');
ok(mc.data?.panel?.[0]?.chair === true, 'the chair holds seat 1 (the prototype acts as Dr. Imran Shah)');
ok(mc.data?.panel?.map(p => p.seat).join(',') === '1,2,3,4,5', 'seats are 1..5 in appointment order');
ok(mc.data?.tally?.text === '0/5', 'the tally chip reads 0/5', mc.data?.tally?.text);
ok(mc.data?.quorum?.required === 5, 'the quorum is derived from the panel', mc.data?.quorum);
ok(mc.data?.ready === true, 'voting is open at CS_LOCKED');
ok(mc.data?.alert?.text === 'Voting in progress. Need 5/5 unanimous approve.',
  'the alert is the prototype\'s own sentence', mc.data?.alert);
ok(mc.data?.round === 'pending', 'no votes yet');
ok(mc.data?.can_vote === true, 'an appointed member may vote');
ok(mc.data?.demo_helper_allowed === false, 'the demo helper is off by default');

const asNonMember = await api(`/pr/${prId}/mc`, { token: proc });
ok(asNonMember.data?.can_vote === false, 'procurement cannot vote');

// ── 2 · gates ──────────────────────────────────────────────────────────────

console.log('\n--- voting gates ---');

const reqVote = await api(`/pr/${prId}/mc/vote`, { method: 'POST', token: requester, body: { decision: 'approve' } });
ok(reqVote.status === 403, 'a requester cannot vote', reqVote.status);
ok(/Only MC members can vote/.test(reqVote.data?.message || ''), 'the refusal is mcVote()\'s own words', reqVote.data?.message);

const csVote = await api(`/pr/${prId}/mc/vote`, { method: 'POST', token: csUser, body: { decision: 'approve' } });
ok(csVote.status === 403, 'a CS user cannot vote — the role gate refuses first', csVote.status);
ok(/Only MC members can vote/.test(csVote.data?.message || ''), 'the refusal is mcVote()\'s own words', csVote.data?.message);

// A user who IS an MC by role but holds no seat gets a DIFFERENT, more precise
// refusal: the panel table is the authority on membership, not the role string.
const adminNoSeat = await api(`/pr/${prId}/mc/vote`, { method: 'POST', token: admin, body: { decision: 'approve' } });
ok(adminNoSeat.status === 403, 'a role-MC with no seat cannot vote', adminNoSeat.status);
ok(/not a member of the MC panel/.test(adminNoSeat.data?.message || ''),
  'the panel gate names the panel', adminNoSeat.data?.message);

const badDec = await api(`/pr/${prId}/mc/vote`, { method: 'POST', token: panel, body: { decision: 'maybe' } });
ok(badDec.status === 400, 'a decision outside approve/reject is refused', badDec.status);

// The helper is gated (F3) even for a real panel member.
const helper = await api(`/pr/${prId}/mc/auto-complete`, { method: 'POST', token: panel });
ok(helper.status === 403, 'the demo helper is refused without DEMO_HELPERS=1 (F3)', helper.status);
ok(/DEMO_HELPERS/.test(helper.data?.message || ''), 'the refusal names the flag', helper.data?.message);

// ── 3 · UNANIMITY — 4/5 must not pass ──────────────────────────────────────

console.log('\n--- unanimity: 4/5 does NOT advance the PR ---');

for (let i = 0; i < 4; i++) {
  const v = await api(`/pr/${prId}/mc/vote`, { method: 'POST', token: PANEL_TOKENS[i], body: { decision: 'approve' } });
  ok(v.status === 200 || v.status === 201, `approval ${i + 1} recorded`, v.data?.message);
  ok(v.data?.round === 'pending', `still pending after ${i + 1}/5`, v.data?.round);
}

const atFour = psql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${prId}';`);
ok(atFour === 'CS_LOCKED', 'the PR is STILL at CS_LOCKED after 4 approvals', atFour);

const tally4 = await api(`/pr/${prId}/mc`, { token: panel });
ok(tally4.data?.tally?.text === '4/5', 'the chip reads 4/5', tally4.data?.tally);
ok(tally4.data?.unanimous === false, '4/5 is not unanimous');

// ── 4 · the fifth vote completes the round ─────────────────────────────────

console.log('\n--- the fifth approval completes the round ---');

const v5 = await api(`/pr/${prId}/mc/vote`, { method: 'POST', token: PANEL_TOKENS[4], body: { decision: 'approve' } });
ok(v5.data?.round === 'approved', '5/5 resolves to approved', v5.data?.round);
ok(v5.data?.stage === 'MC_APPROVED', 'the response reports MC_APPROVED', v5.data?.stage);
ok(/Switch to CFO/.test(v5.data?.next || ''), 'the next-step text names the CFO', v5.data?.next);

const afterMc = psql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${prId}';`);
ok(afterMc === 'MC_APPROVED', 'the DB moved the PR to MC_APPROVED', afterMc);

const voteRows = psql(`SELECT count(*) FROM workflow.approval_votes WHERE pr_id = '${prId}' AND step_id = 'mc_approval';`);
ok(voteRows === '5', '5 approval_votes rows exist', voteRows);

const sess = psql(`SELECT outcome FROM workflow.mc_sessions WHERE pr_id = '${prId}';`);
ok(sess === 'approved', 'the mc_session closed as approved', sess);

// Re-voting after the round closed is refused by the stage gate.
const late = await api(`/pr/${prId}/mc/vote`, { method: 'POST', token: panel, body: { decision: 'reject' } });
ok(late.status === 409, 'voting is closed once the round is approved', late.status);
ok(/Voting not yet open/.test(late.data?.message || ''), 'the refusal is mcVote()\'s own words', late.data?.message);

// ── 5 · the CFO gate ───────────────────────────────────────────────────────

console.log('\n--- CFO: reject goes back to the MC gate, not to sourcing ---');

const cfoView = await api(`/pr/${prId}/cfo`, { token: cfo });
ok(cfoView.status === 200, 'GET /pr/:id/cfo 200', cfoView.data?.message);
ok(cfoView.data?.ready === true, 'the CFO gate is open at MC_APPROVED');
ok(cfoView.data?.summary?.length === 7, 'the pack summary has the prototype\'s 7 rows', cfoView.data?.summary?.length);
ok(cfoView.data?.summary?.find(r => r.key === 'mc')?.value === '5/5 unanimous',
  'the MC vote row is a REAL count', cfoView.data?.summary?.find(r => r.key === 'mc'));

const riskRow = cfoView.data?.summary?.find(r => r.key === 'risk');
ok(riskRow?.value === '—' || riskRow?.unknown === false,
  'F1: risk class is derived or an em-dash, never the prototype\'s hardcoded "Medium"', riskRow);

const cfoEarly = await api(`/pr/${prId}/cfo/decide`, { method: 'POST', token: panel, body: { approve: true } });
ok(cfoEarly.status === 403, 'an MC member cannot decide at the CFO gate', cfoEarly.status);

const cfoReject = await api(`/pr/${prId}/cfo/decide`, {
  method: 'POST', token: cfo, body: { approve: false, reason: 'Over the FY26 Q1 IT capex envelope.' },
});
ok(cfoReject.data?.approved === false, 'CFO rejected');
ok(cfoReject.data?.stage === 'CS_LOCKED', 'the reject returns to CS_LOCKED, not to sourcing', cfoReject.data?.stage);

const afterCfoRej = psql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${prId}';`);
ok(afterCfoRej === 'CS_LOCKED', 'the DB is at CS_LOCKED after the CFO reject', afterCfoRej);
ok(psql(`SELECT count(*) FROM workflow.approval_votes WHERE pr_id = '${prId}' AND step_id = 'mc_approval';`) === '0',
  'the MC vote ledger was cleared so the committee can vote again');

const cfoAudit = psql(`SELECT count(*) FROM audit.audit_log WHERE entity_id = '${prId}' AND action = 'reject';`);
ok(cfoAudit === '1', 'the CFO rejection is in the audit log', cfoAudit);

// Re-approve, this time for real.
for (let i = 0; i < 5; i++) {
  await api(`/pr/${prId}/mc/vote`, { method: 'POST', token: PANEL_TOKENS[i], body: { decision: 'approve' } });
}
ok(psql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${prId}';`) === 'MC_APPROVED',
  'the committee re-approved and the PR is back at MC_APPROVED');

const cfoApprove = await api(`/pr/${prId}/cfo/decide`, {
  method: 'POST', token: cfo, body: { approve: true },
});
ok(cfoApprove.data?.approved === true, 'CFO approved');
ok(cfoApprove.data?.stage === 'CFO_APPROVED', 'the PR is at CFO_APPROVED', cfoApprove.data?.stage);
ok(/lock the approved pack/.test(cfoApprove.data?.next || ''), 'the next step is the pack', cfoApprove.data?.next);

// ── 6 · the pack freezes with REAL digests ─────────────────────────────────

console.log('\n--- the pack: six real digests, frozen once ---');

const packView = await api(`/pr/${prId}/pack`, { token: csUser });
ok(packView.status === 200, 'GET /pr/:id/pack 200', packView.data?.message);
ok(packView.data?.documents?.length === 6, 'the manifest has the prototype\'s six documents', packView.data?.documents?.length);
ok(packView.data?.pack === null, 'no pack before the lock', packView.data?.pack);
ok(packView.data?.can_lock === true, 'CS may lock the approved pack');
ok(packView.data?.documents?.every(d => d.state !== 'present'), 'nothing is hashed before the lock',
  packView.data?.documents?.map(d => d.state));

const earlyLock = await api(`/pr/${prId}/pack/lock`, { method: 'POST', token: panel, body: {} });
ok(earlyLock.status === 403, 'an MC member cannot lock the pack', earlyLock.status);

const packLock = await api(`/pr/${prId}/pack/lock`, { method: 'POST', token: csUser, body: {} });
ok([200, 201].includes(packLock.status), 'pack locked', packLock.data?.message);
ok(packLock.data?.pack?.pack_hash, 'the pack carries a hash', packLock.data?.pack);
ok(packLock.data?.stage === 'PACK_LOCKED', 'the PR moved to PACK_LOCKED', packLock.data?.stage);

const docs = packLock.data?.pack?.documents || [];
ok(docs.length === 6, 'the frozen manifest still has six rows', docs.length);
ok(docs.every(d => d.state === 'present'), 'a STANDARD pack has all six documents present',
  docs.map(d => `${d.name}=${d.state}`));
ok(docs.every(d => /^sha256:[0-9a-f]{64}$/.test(d.sha256 || '')),
  'every digest is a real 64-hex sha256', docs.map(d => d.sha256?.slice(0, 20)));
ok(docs.every(d => d.display_hash.endsWith('…') && d.display_hash.length === 9),
  'each renders as 8 hex chars + the prototype\'s ellipsis', docs.map(d => d.display_hash));

// Re-freezing is idempotent, not a second pack.
const relock = await api(`/pr/${prId}/pack/lock`, { method: 'POST', token: csUser, body: {} });
ok([200, 201].includes(relock.status), 'a second lock is not an error', relock.status);
ok(relock.data?.already_locked === true, 'the second lock reports the existing pack', relock.data);
ok(psql(`SELECT count(*) FROM proc.approved_packs WHERE pr_id = '${prId}';`) === '1',
  'still exactly ONE pack row');

const hashMatches = psql(`
  SELECT (pack_hash = proc.fn_pack_hash(payload)) FROM proc.approved_packs WHERE pr_id = '${prId}';`);
ok(hashMatches === 't', 'the stored hash still matches the frozen payload');

const mut = psql(`UPDATE proc.approved_packs SET payload = '{}'::jsonb WHERE pr_id = '${prId}';`);
ok(/immutable/i.test(mut), 'a post-lock payload mutation is rejected by the schema', mut.slice(0, 80));

// ── 7 · F2: FAST_TRACK never fabricates the skipped documents ──────────────

console.log('\n--- FAST_TRACK pack: the MC and CFO documents are skipped, not hashed ---');

const ftF = await fixture('Governance e2e — fast track', 20_000);
const ftId = ftF.prId;
psql(`UPDATE proc.purchase_requisitions SET routing_key = 'FAST_TRACK' WHERE id = '${ftId}';`);
const ftRfq = await api(`/pr/${ftId}/rfq`, { method: 'POST', token: proc, body: {} });
const ftRoster = ftRfq.data?.invitations || [];
for (let i = 0; i < 2; i++) {
  const q = await quote(ftRfq.data?.rfq?.id, ftRoster[i].vendor_id,
    { unitPrice: 15_000 - i * 2_000, leadTimeDays: 10 + i * 5, warrantyMonths: 12 + i * 12 });
  ok([200, 201].includes(q.status), `fast-track quote ${i + 1} recorded`, q.data?.message);
}
const ftGen = await api(`/pr/${ftId}/cs`, { method: 'POST', token: csUser, body: {} });
const ftLock = await api(`/cs/${ftGen.data?.cs?.id}/lock`, {
  method: 'POST', token: csUser, body: { winnerVendorId: ftGen.data?.lines?.[0]?.vendor_id },
});
ok(ftLock.data?.stage === 'PACK_LOCKED', 'a FAST_TRACK lock skips straight to PACK_LOCKED', ftLock.data?.stage);

const ftDocs = ftLock.data?.pack?.documents || [];
ok(ftDocs.length === 6, 'the six-row structure is preserved on a fast track', ftDocs.length);
const skipped = ftDocs.filter(d => d.state === 'skipped');
ok(skipped.map(d => d.name).join(' | ') === 'MC vote record | CFO approval',
  'exactly the MC and CFO documents are skipped', skipped.map(d => d.name));
ok(skipped.every(d => d.sha256 === null), 'a skipped document carries NO hash', skipped.map(d => d.sha256));
ok(skipped.every(d => d.note === 'Skipped (FAST_TRACK)'), 'and says why', skipped.map(d => d.note));
ok(ftDocs.filter(d => d.state === 'present').length === 4, 'the other four carry real digests',
  ftDocs.filter(d => d.state === 'present').map(d => d.name));

const ftStage = psql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${ftId}';`);
ok(ftStage === 'PACK_LOCKED', 'the fast-track PR is at PACK_LOCKED, having never seen the MC', ftStage);
ok(psql(`SELECT count(*) FROM workflow.mc_sessions WHERE pr_id = '${ftId}';`) === '0',
  'no MC session was ever opened on a fast track');

// ── 8 · an MC reject opens a new CS round (decision 2A) ────────────────────

console.log('\n--- MC reject: returns to sourcing, opens round 2, keeps round 1 ---');

const rjF = await fixture('Governance e2e — MC reject', 30_000);
const rjId = rjF.prId;
psql(`UPDATE proc.purchase_requisitions SET routing_key = 'STANDARD' WHERE id = '${rjId}';`);
const rjRfq = await api(`/pr/${rjId}/rfq`, { method: 'POST', token: proc, body: {} });
const rjRoster = rjRfq.data?.invitations || [];
for (let i = 0; i < 2; i++) {
  const q = await quote(rjRfq.data?.rfq?.id, rjRoster[i].vendor_id,
    { unitPrice: 28_000 - i * 3_000, leadTimeDays: 14 - i * 4, warrantyMonths: 12 + i * 12 });
  ok([200, 201].includes(q.status), `reject-case quote ${i + 1} recorded`, q.data?.message);
}
const rjGen = await api(`/pr/${rjId}/cs`, { method: 'POST', token: csUser, body: {} });
const rjCs1 = rjGen.data?.cs?.id;
ok(rjGen.data?.cs?.cs_round === 1, 'the first CS is round 1');
await api(`/cs/${rjCs1}/lock`, { method: 'POST', token: csUser, body: { winnerVendorId: rjGen.data?.lines?.[0]?.vendor_id } });

const rejectVote = await api(`/pr/${rjId}/mc/vote`, {
  method: 'POST', token: panel, body: { decision: 'reject', reason: 'Warranty terms below our 24-month floor.' },
});
ok(rejectVote.data?.round === 'rejected', 'one reject collapses the round', rejectVote.data?.round);
ok(rejectVote.data?.stage === 'QUOTES_RECEIVED', 'the PR returns to sourcing', rejectVote.data?.stage);
ok(rejectVote.data?.cleared === true, 'the vote ledger was cleared', rejectVote.data);
ok(/CS must revise/.test(rejectVote.data?.next || ''), 'the next step is a CS revision', rejectVote.data?.next);

ok(psql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${rjId}';`) === 'QUOTES_RECEIVED',
  'the DB is at QUOTES_RECEIVED');
ok(psql(`SELECT count(*) FROM workflow.approval_votes WHERE pr_id = '${rjId}' AND step_id = 'mc_approval';`) === '0',
  'the MC votes were cleared');
ok(/rejected/.test(psql(`SELECT outcome FROM workflow.mc_sessions WHERE pr_id = '${rjId}';`)),
  'the mc_session closed as rejected');
ok(/Warranty terms/.test(psql(`SELECT after::text FROM audit.audit_log WHERE entity_id = '${rjId}' AND action = 'reject' LIMIT 1;`)),
  'the objection and its reason survive in the audit log');

// The CS lock had marked the quotes Awarded/Rejected. A withdrawn award has to
// withdraw its consequence, or round 2 has nothing left to score.
const reopened = psql(`
  SELECT count(*) FROM proc.quotations
   WHERE rfq_id = (SELECT id FROM proc.rfq WHERE pr_id = '${rjId}')
     AND state = 'Submitted';`);
ok(Number(reopened) >= 2, 'the quotes were reopened as Submitted for the revision', reopened);
ok(psql(`SELECT state FROM proc.rfq WHERE pr_id = '${rjId}';`) === 'Open',
  'the RFQ is Open again');

// Round 2 is now allowed, and round 1 is untouched.
const rjGen2 = await api(`/pr/${rjId}/cs`, { method: 'POST', token: csUser, body: {} });
ok([200, 201].includes(rjGen2.status), 'a new CS round can be generated', rjGen2.data?.message);
ok(rjGen2.data?.cs?.cs_round === 2, 'it is round 2', rjGen2.data?.cs?.cs_round);

const round1 = psql(`
  SELECT concat_ws('|', cs_round, state, (locked_at IS NOT NULL)::text)
    FROM proc.comparative_statements WHERE id = '${rjCs1}';`);
ok(round1 === '1|Locked|true',
  'round 1 is still Locked with its lock timestamp — preserved as evidence', round1);
ok(psql(`SELECT count(*) FROM proc.comparative_statements WHERE pr_id = '${rjId}';`) === '2',
  'both rounds coexist');

const staleLock = await api(`/cs/${rjCs1}/lock`, { method: 'POST', token: csUser, body: { winnerVendorId: rjGen.data?.lines?.[0]?.vendor_id } });
ok(staleLock.status === 400, 'the superseded round cannot be locked again', staleLock.status);
ok(/no longer in force/.test(staleLock.data?.message || ''), 'the refusal says why', staleLock.data?.message);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
