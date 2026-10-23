// Verifies the reported blind-review deadlock end to end, on the record it was
// reported on.
//
//   PR-2026-202043 / CS-2026-200663
//   reported by: the REQUESTING HOD, clicking "Confirm comparative statement"
//   failed with: HTTP 400 — "cannot leave the CS stage with an unclassified line"
//
// THE BUG
//
// CsReviewService.confirm() wrote `UPDATE proc.purchase_requisitions SET status
// = step.to` directly, behind the engine's back. The step's requiresCapexOpex
// was therefore never enforced on the crossing, and the check had to be
// duplicated INTO the confirm to close it. So the blind reviewer — who verifies
// the vendors' commercial rates, and who does not hold the classification
// fields — was asked to produce a class that only procurement can make, and
// which procurement makes AFTER that confirmation. A deadlock, not a control.
//
// THE FIX
//
// The confirm confirms the rates and stops. The advance is the only route across
// now, it runs through the engine, and the classification gate is enforced
// there — on cs_review (IN_PROCUREMENT_REVIEW) and cs_review_quotes
// (QUOTES_RECEIVED), the same exit from the two stages a comparative statement
// can exist at.
//
// WHAT THIS SCRIPT PROVES, IN ORDER
//
//   1. the requesting HOD confirms with NO class on the line
//   2. the request does NOT move on confirm
//   3. the award rates are still written (the write-back is not collateral)
//   4. the requesting HOD still cannot ADVANCE it — they signed the rates, they
//      do not own the request
//   5. the Head of another department cannot advance it either
//   6. procurement classifies and advances -> IN_COST_CENTER_APPROVAL
//
// USAGE
//
//   node scripts/verify_reported_case.mjs              walk the case, leave it advanced
//   node scripts/verify_reported_case.mjs --reset      walk it, then put the fixture back
//
// The fixture is restored to its exact pre-fix state by --reset, so the case can
// be walked again from the blind stage: REQUESTER_REVIEW, masked, the request
// at QUOTES_RECEIVED with no amount, the statement 'Generated' with a NULL
// recommendation, and the line unpriced and unclassified.
//
// The one thing --reset does NOT undo is the `cs_split_lock` audit row, because
// audit.audit_log is append-only by design. A lock did happen here, during
// testing, and erasing it would be the one thing an audit log exists to
// prevent.

const BASE = process.env.API_BASE || 'http://127.0.0.1:33001';
const PR_ID = '5b22df2b-90b4-44c4-9df9-ed7e43c6d286';
const CS_ID = '1709bbbd-7fc5-46bb-a904-92c1295d4513';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''}`); }
};
const login = async (email) => {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'demo' }),
  });
  const b = await r.json();
  if (!b.token) throw new Error(`login ${email}: ${JSON.stringify(b)}`);
  return b.token;
};
const call = async (token, method, path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let parsed = null;
  try { parsed = await r.json(); } catch { /* empty body */ }
  return { status: r.status, body: parsed };
};

const hod = await login('hod.finance@pakboxes.pk');   // the REQUESTING HOD on this PR
const proc = await login('procurement@pakboxes.pk');
const sales = await login('hod.sales@pakboxes.pk');

console.log('\nreported case: PR-2026-202043 / CS-2026-200663\n');

// ── 0 · the state before ───────────────────────────────────────────────────
{
  const d = await call(hod, 'GET', `/pr/${PR_ID}`);
  const rev = await call(hod, 'GET', `/pr/${PR_ID}/cs/review`);
  ok(d.status === 200, 'PR readable', d.status);
  ok(d.body?.status === 'QUOTES_RECEIVED', 'the request is parked at QUOTES_RECEIVED', d.body?.status);
  ok(d.body?.amount_status === 'UNKNOWN', 'and carries no amount yet', d.body?.amount_status);
  ok(rev.body?.actions?.can_confirm === true,
    'the blind reviewer is offered the confirm action', rev.body?.actions);
  console.log(`       review sub_state=${rev.body?.sub_state ?? rev.body?.review?.sub_state}`);
}

// ── 1 · THE FIX ────────────────────────────────────────────────────────────
{
  const r = await call(hod, 'POST', `/cs/${CS_ID}/review/confirm`, {});
  ok(r.status === 201 || r.status === 200,
    '1. the requesting HOD confirms the blind review WITHOUT classifying',
    { http: r.status, body: r.body });
  ok(r.body?.subState === 'CONFIRMED', '1b. the review is CONFIRMED', r.body?.subState);
  ok(r.body?.statement_locked === true, '1c. the statement is LOCKED', r.body?.statement_locked);
  ok(r.body?.nextStage === 'QUOTES_RECEIVED',
    '1d. and the response reports the request as NOT moved', r.body?.nextStage);
  ok(r.body?.exitStep === 'cs_review_quotes',
    '1e. naming the step that will move it', r.body?.exitStep);
  console.log(`       next: ${r.body?.next}`);
}

// ── 2 · the request did not move ───────────────────────────────────────────
{
  const d = await call(hod, 'GET', `/pr/${PR_ID}`);
  ok(d.body?.status === 'QUOTES_RECEIVED',
    '2. the request STAYED at QUOTES_RECEIVED', d.body?.status);
  ok(d.body?.amount_status === 'ESTIMATED' && Number(d.body?.estimated_amount) > 0,
    '2b. but the award rates were written onto the line',
    { status: d.body?.amount_status, amount: d.body?.estimated_amount });
}

// ── 3 · the requesting HOD still cannot ADVANCE it ─────────────────────────
{
  const r = await call(hod, 'POST', `/pr/${PR_ID}/advance`, {
    reason: 'blind reviewer tries to advance', csReviewConfirmed: true,
  });
  ok(r.status === 403, '3. the blind reviewer cannot advance it', { http: r.status, body: r.body });
}

// ── 4 · nor the Head of another department ──────────────────────────────────
{
  const r = await call(sales, 'POST', `/pr/${PR_ID}/advance`, {
    reason: 'head of sales tries to advance', csReviewConfirmed: true,
  });
  ok(r.status === 403, '4. the Head of Sales cannot advance it', { http: r.status, body: r.body });
}

// ── 5 · procurement classifies and advances ─────────────────────────────────
{
  const c = await call(proc, 'PATCH', `/pr/${PR_ID}/lines/classification`, {
    lines: [{ lineNo: 1, classification: 'OPEX_CONSUMABLE' }],
  });
  ok(c.status === 200 || c.status === 201,
    '5. procurement classifies the line', { http: c.status, body: c.body });

  const r = await call(proc, 'POST', `/pr/${PR_ID}/advance`, {
    reason: 'CS confirmed, line classified', csReviewConfirmed: true,
  });
  ok(r.status === 201 || r.status === 200,
    '5b. procurement advances the request', { http: r.status, body: r.body });
  ok(r.body?.matchedStep === 'cs_review_quotes',
    '5c. through cs_review_quotes', r.body?.matchedStep);

  const d = await call(proc, 'GET', `/pr/${PR_ID}`);
  ok(d.body?.status === 'IN_COST_CENTER_APPROVAL',
    '5d. and it lands at cost centre approval', d.body?.status);
}

console.log(`\npassed ${pass}, failed ${fail}\n`);

if (process.argv.includes('--reset')) {
  // The transition trigger is disabled for ONE statement only. There is no
  // legal edge from IN_COST_CENTER_APPROVAL back to QUOTES_RECEIVED (the
  // allowed targets are IN_FINANCE_REVIEW, Rejected, REJECTED, Cancelled), so
  // a fixture that has been driven forward cannot be walked back without it.
  //
  // The other three triggers stay on, deliberately: trg_prs_audit still records
  // the status change, trg_prs_stamp_sourcing_clock still stamps it, and
  // trg_pr_stage_remarks_guard still refuses a stage remark that arrives
  // without a stage change. The audit trail of this reset is therefore whole.
  const { execFileSync } = await import('node:child_process');
  execFileSync('docker', ['exec', '-i', 'procurement-portal-db', 'psql',
    '-U', 'proc', '-d', 'procurementDB', '-X', '-q', '-f', '-'],
    {
      encoding: 'utf8',
      input: `
BEGIN;
ALTER TABLE proc.purchase_requisitions DISABLE TRIGGER trg_prs_status_transition;
UPDATE proc.purchase_requisitions
   SET status = 'QUOTES_RECEIVED', amount_status = 'UNKNOWN',
       estimated_amount = 0, capex_amount = 0, opex_amount = 0
 WHERE id = '${PR_ID}';
ALTER TABLE proc.purchase_requisitions ENABLE TRIGGER trg_prs_status_transition;
UPDATE proc.comparative_statements
   SET state = 'Generated', locked_at = NULL, locked_by_user_id = NULL,
       award_mode = 'SINGLE', recommendation = NULL
 WHERE id = '${CS_ID}';
UPDATE proc.cs_reviews
   SET sub_state = 'REQUESTER_REVIEW', masked_for_requester = true, confirmed_at = NULL
 WHERE cs_id = '${CS_ID}';
UPDATE proc.pr_lines
   SET unit_price_est = NULL, budget_unit_price = NULL, classification = NULL,
       classified_by = NULL, classified_at = NULL, classification_source = NULL
 WHERE pr_id = '${PR_ID}';
COMMIT;
`,
    });
  console.log('fixture restored to its pre-fix state (REQUESTER_REVIEW, QUOTES_RECEIVED, unpriced)\n');
}

process.exit(fail ? 1 : 0);