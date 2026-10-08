// E2E — the Part 7 builder's contract, end to end against the live API.
//
// The UI cannot be proven by a unit test: the whole point of Part 7 is that an
// edit in the browser changes what the ROUTING ENGINE does. So this exercises
// the same request sequence the grid issues, and then proves the engine's
// behaviour actually moved — the round trip that matters is
//
//     grid edit -> workflow.steps_config -> engine route
//
// not merely "the PUT returned 200".
//
// Requires: Postgres on 55432 and the API on 33001, both rebuilt.

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const { spawnSync } = await import('node:child_process');
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const { planAdvance } = require('../packages/workflow-engine/dist/index.js');
const CONTAINER = process.env.PG_CONTAINER || 'procurement-portal-db';

/**
 * Route a fixed PKR 2,000,000 PR sitting in Finance review against whatever the
 * API says the live configuration is. This is the assertion that matters: the
 * grid wrote to the database, and the ENGINE — the same code the API runs on
 * every PR advance — now computes something different.
 */
function routeTwoMillion(rawConfig) {
  const plan = planAdvance(
    { steps: rawConfig.steps, managementThreshold: rawConfig.managementThreshold },
    {
      id: 'e2e-pr', prNumber: 'PR-E2E-0001', status: 'IN_FINANCE_REVIEW',
      estimatedAmount: 2_000_000, expenseType: 'CAPEX',
      lines: [{ itemCategory: 'IT_HARDWARE', amount: 2_000_000 }],
    },
  );
  if (plan.kind === 'none') return 'NONE';
  if (plan.kind === 'split') return `SPLIT->${plan.parentStage}`;
  return `${plan.step.key}->${plan.nextStage}`;
}

let pass = 0;
let fail = 0;
const ok = (label, extra = '') => { pass++; console.log(`  PASS  ${label}${extra ? `  (${extra})` : ''}`); };
const bad = (label, detail) => { fail++; console.log(`  FAIL  ${label}\n        ${detail}`); };
const eq = (label, actual, expected) => {
  if (actual === expected) ok(label, String(actual));
  else bad(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

function psqlScalar(sql) {
  const res = spawnSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', process.env.DB_USER || 'proc',
     '-d', process.env.DB_NAME || 'procurementDB',
     '--csv', '-X', '-q', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { input: `BEGIN;\n${sql.trim().replace(/;\s*$/, '')};\nCOMMIT;\n`, encoding: 'utf8' },
  );
  if (res.status !== 0) return null;
  const line = res.stdout.replace(/\r\n/g, '\n').split('\n').filter(l => l.trim() !== '')[1];
  if (line === undefined) return null;
  const cell = line.replace(/^"|"$/g, '');
  const n = Number(cell);
  return Number.isFinite(n) ? n : cell;
}

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}

async function loginAs(email) {
  const r = await api('/auth/login', { method: 'POST', body: { email, password: 'demo' } });
  if (!r.data?.token) throw new Error(`login failed for ${email}: ${r.status}`);
  return r.data.token;
}

console.log(`\n=== Part 7 Step 2 — workflow builder round trip against ${API} ===\n`);

// -- Preflight ------------------------------------------------------------
try {
  const h = await api('/health');
  if (h.status !== 200) { console.error(`  ABORT  API not healthy (${h.status}).`); process.exit(1); }
} catch (e) {
  console.error(`  ABORT  API unreachable: ${e.message}`);
  process.exit(1);
}

const admin = await loginAs('admin@pakboxes.pk');
const requester = await loginAs('requester@pakboxes.pk');
ok('authenticated');

const initial = (await api('/workflow/config', { token: admin })).data;
const originalThreshold = initial.managementThreshold;
const originalSteps = JSON.parse(JSON.stringify(initial.steps));

// The grid's own model, exactly as the page holds it.
let model = { steps: originalSteps, managementThreshold: originalThreshold };
const save = async (m) => {
  const r = await api('/workflow/config', {
    method: 'PUT', token: admin,
    body: { steps: m.steps, managementThreshold: m.managementThreshold },
  });
  return r;
};

// =========================================================================
// 1. handler: lightWorkflowEditStep — rename a step, assert the DB changed
// =========================================================================
{
  const idx = model.steps.findIndex(s => s.key === 'procurement');
  const originalName = model.steps[idx].name;
  const next = JSON.parse(JSON.stringify(model.steps));
  next[idx].name = 'Procurement review (edited)';
  const r = await save({ ...model, steps: next });
  eq('edit step: PUT accepted', r.status, 200);

  const dbName = psqlScalar(
    `SELECT payload->>'name' FROM workflow.steps_config WHERE id = 'procurement'`,
  );
  if (dbName === 'Procurement review (edited)') ok('edit step: the new name is in workflow.steps_config', dbName);
  else bad('edit step: the new name is in workflow.steps_config', `db holds ${JSON.stringify(dbName)}`);
  model.steps = next;
}

// =========================================================================
// 2. handler: lightWorkflowMoveStep — reorder, assert order_index moved
// =========================================================================
{
  const before = psqlScalar(
    `SELECT order_index FROM workflow.steps_config WHERE id = 'management'`,
  );
  const next = JSON.parse(JSON.stringify(model.steps));
  const i = next.findIndex(s => s.key === 'management');
  const j = next.findIndex(s => s.key === 'd365_push');
  [next[i], next[j]] = [next[j], next[i]];
  next.forEach((s, k) => { s.order = k + 1; });
  const r = await save({ ...model, steps: next });
  eq('move step: PUT accepted', r.status, 200);

  const after = psqlScalar(
    `SELECT order_index FROM workflow.steps_config WHERE id = 'management'`,
  );
  if (Number(after) === Number(before) + 1) {
    ok('move step: order_index moved down by one', `${before} -> ${after}`);
  } else {
    bad('move step: order_index moved down by one', `expected ${Number(before) + 1}, got ${after}`);
  }
  model.steps = next;
}

// =========================================================================
// 3. handler: lightWorkflowEditStep — condition + value drive the ENGINE
//    This is the load-bearing assertion: a grid edit must change routing.
// =========================================================================
{
  // Baseline first, or "the engine followed the edit" is unfalsifiable: a moved
  // route would be indistinguishable from the engine never having routed at all.
  const beforeRaw = (await api('/workflow/config/raw', { token: admin })).data;
  const beforePlan = routeTwoMillion(beforeRaw);
  if (beforePlan === 'finance_review->IN_MANAGEMENT_REVIEW') {
    ok('baseline: the 2M PR currently clears Finance for Management', beforePlan);
  } else {
    bad('baseline: the 2M PR currently clears Finance for Management', `engine routes to ${beforePlan}`);
  }

  // The gate is now driven by ONE global number rather than a duplicated pair
  // (migration 035). The invariant under test is unchanged — a grid edit must
  // change routing — but the mechanism is the threshold field the admin-workflow
  // grid already renders, not two conditionValues that could be edited apart.
  const next = JSON.parse(JSON.stringify(model.steps));
  const r = await save({ ...model, steps: next, managementThreshold: 50_000_000 });
  eq('condition value: PUT accepted', r.status, 200);

  const dbThr = psqlScalar(`SELECT value::text FROM workflow.config WHERE key = 'management_threshold'`);
  if (Number(dbThr) === 50_000_000) ok('condition value: persisted to the database', dbThr);
  else bad('condition value: persisted to the database', `db holds ${dbThr}`);

  // THE LOAD-BEARING ASSERTION: the engine must now send the same PR down the
  // other branch, because the grid told it to.
  const raw = (await api('/workflow/config/raw', { token: admin })).data;
  const plan = routeTwoMillion(raw);
  if (plan === 'finance_release->READY_FOR_D365') {
    ok('the ENGINE followed the grid edit: the 2M PR now bypasses Management', plan);
  } else {
    bad('the ENGINE followed the grid edit', `expected finance_release->READY_FOR_D365, got ${plan}`);
  }
  model.steps = next;
  model.managementThreshold = 50_000_000;
}

// =========================================================================
// 3a. the duplicated pair is gone, so the dead band is unrepresentable
// =========================================================================
{
  // Migration 035 removed conditionValue from both gate steps and put them on
  // the global threshold predicates. This asserts that structurally, because a
  // dead band used to be possible by editing one side of the pair — and the
  // single global number is the reason it no longer is.
  // Test for a NUMBER, not for the key's presence: a payload may legitimately
  // carry `"conditionValue": null`, and key presence alone would report a
  // duplicated threshold where there is none.
  const dup = psqlScalar(
    `SELECT count(*) FROM workflow.steps_config
      WHERE id IN ('finance_review','finance_release')
        AND jsonb_typeof(payload->'conditionValue') <> 'null'`,
  );
  if (Number(dup) === 0) ok('neither gate step carries a duplicated conditionValue');
  else bad('neither gate step carries a duplicated conditionValue', `${dup} still do`);

  const wired = psqlScalar(
    `SELECT count(*) FROM workflow.steps_config
      WHERE id IN ('finance_review','finance_release')
        AND payload->>'when' IN ('aboveMgtThreshold','belowMgtThreshold')`,
  );
  if (Number(wired) === 2) ok('both gate steps read the global threshold');
  else bad('both gate steps read the global threshold', `${wired} of 2 do`);
}

// =========================================================================
// 3b. reintroducing a mismatched pair is still refused — the dead band
// =========================================================================
{
  const next = JSON.parse(JSON.stringify(model.steps));
  // Re-add the old per-step predicates so the two disagree: review above 50M,
  // release below 50M is fine, but review above 50M against release below 1M
  // strands every PR between the two.
  next.find(s => s.key === 'finance_review').when = 'amountGTE';
  next.find(s => s.key === 'finance_review').conditionValue = 50_000_000;
  next.find(s => s.key === 'finance_release').when = 'amountLT';
  next.find(s => s.key === 'finance_release').conditionValue = 1_000_000;

  const before = psqlScalar(`SELECT payload->>'when' FROM workflow.steps_config WHERE id = 'finance_release'`);
  const r = await save({ ...model, steps: next, managementThreshold: model.managementThreshold });
  eq('a mismatched amount pair is refused with 400', r.status, 400);
  const after = psqlScalar(`SELECT payload->>'when' FROM workflow.steps_config WHERE id = 'finance_release'`);
  eq('the refused save left the live table untouched', after, before);
}

// =========================================================================
// 4. a dead band is refused with an explanation, and nothing is written
// =========================================================================
{
  const dead = JSON.parse(JSON.stringify(model.steps));
  // amountGTE 50M against amountLT 1M: every amount between 1M and 50M matches
  // neither step, so those PRs could never advance. The `when` keywords must be
  // overridden too, or the conditionValues would simply be ignored by the
  // global-threshold predicates and the save would look valid.
  dead.find(s => s.key === 'finance_review').when = 'amountGTE';
  dead.find(s => s.key === 'finance_review').conditionValue = 50_000_000;
  dead.find(s => s.key === 'finance_release').when = 'amountLT';
  dead.find(s => s.key === 'finance_release').conditionValue = 1_000_000;

  const before = psqlScalar(`SELECT payload->>'when' FROM workflow.steps_config WHERE id = 'finance_review'`);
  const r = await save({ ...model, steps: dead, managementThreshold: model.managementThreshold });
  eq('dead-band config: refused with 400', r.status, 400);
  if (Array.isArray(r.data?.errors) && r.data.errors.length) {
    ok('dead-band config: the refusal explains itself', r.data.errors[0].slice(0, 90));
  } else {
    bad('dead-band config: the refusal explains itself', `no errors array: ${JSON.stringify(r.data)}`);
  }
  const after = psqlScalar(`SELECT payload->>'when' FROM workflow.steps_config WHERE id = 'finance_review'`);
  eq('dead-band config: the live table is untouched', after, before);
}

// =========================================================================
// 5. handler: lightWorkflowAddLineRule — line rules round-trip
// =========================================================================
{
  const next = JSON.parse(JSON.stringify(model.steps));
  const hod = next.find(s => s.key === 'hod_review');
  const beforeCount = (hod.lineRules || []).length;
  hod.lineRules = [
    ...(hod.lineRules || []),
    {
      category: ['OFFICE_SUPPLIES'],
      amountOp: '>',
      amountValue: 750_000,
      routeTo: 'IN_MANAGEMENT_REVIEW',
      actorRole: 'management',
      reason: 'High-value supplies need Management sign-off.',
    },
  ];
  const r = await save({ ...model, steps: next });
  eq('add line rule: PUT accepted', r.status, 200);

  const dbCount = psqlScalar(
    `SELECT jsonb_array_length(payload->'lineRules') FROM workflow.steps_config WHERE id = 'hod_review'`,
  );
  if (Number(dbCount) === beforeCount + 1) {
    ok('add line rule: the rule reached the database', `${beforeCount} -> ${dbCount}`);
  } else {
    bad('add line rule: the rule reached the database', `expected ${beforeCount + 1}, got ${dbCount}`);
  }
  const dbReason = psqlScalar(
    `SELECT payload->'lineRules'->${beforeCount}->>'reason' FROM workflow.steps_config WHERE id = 'hod_review'`,
  );
  if (String(dbReason).includes('Management sign-off')) ok('add line rule: the reason text survived verbatim');
  else bad('add line rule: the reason text survived verbatim', `db holds ${JSON.stringify(dbReason)}`);
  model.steps = next;
}

// =========================================================================
// 6. handler: lightWorkflowEditLineRule — edit the rule we just added
// =========================================================================
{
  const next = JSON.parse(JSON.stringify(model.steps));
  const hod = next.find(s => s.key === 'hod_review');
  const last = hod.lineRules.length - 1;
  hod.lineRules[last].amountValue = 900_000;
  const r = await save({ ...model, steps: next });
  eq('edit line rule: PUT accepted', r.status, 200);
  const dbVal = psqlScalar(
    `SELECT payload->'lineRules'->${last}->>'amountValue' FROM workflow.steps_config WHERE id = 'hod_review'`,
  );
  if (Number(dbVal) === 900_000) ok('edit line rule: the new amount persisted', dbVal);
  else bad('edit line rule: the new amount persisted', `db holds ${dbVal}`);
  model.steps = next;
}

// =========================================================================
// 7. handler: lightWorkflowDeleteLineRule
// =========================================================================
{
  const next = JSON.parse(JSON.stringify(model.steps));
  const hod = next.find(s => s.key === 'hod_review');
  const beforeCount = hod.lineRules.length;
  hod.lineRules = hod.lineRules.slice(0, -1);
  const r = await save({ ...model, steps: next });
  eq('delete line rule: PUT accepted', r.status, 200);
  const dbCount = psqlScalar(
    `SELECT jsonb_array_length(payload->'lineRules') FROM workflow.steps_config WHERE id = 'hod_review'`,
  );
  if (Number(dbCount) === beforeCount - 1) ok('delete line rule: the rule is gone from the database', `${beforeCount} -> ${dbCount}`);
  else bad('delete line rule: the rule is gone from the database', `expected ${beforeCount - 1}, got ${dbCount}`);
  model.steps = next;
}

// =========================================================================
// 8. handler: lightWorkflowSetThreshold
// =========================================================================
{
  const r = await api('/workflow/config/threshold', {
    method: 'PUT', token: admin, body: { managementThreshold: 2_500_000 },
  });
  eq('set threshold: accepted', r.status, 200);
  const dbThr = psqlScalar(`SELECT value::text FROM workflow.config WHERE key = 'management_threshold'`);
  if (Number(dbThr) === 2_500_000) ok('set threshold: persisted to workflow.config', dbThr);
  else bad('set threshold: persisted to workflow.config', `db holds ${dbThr}`);

  // The PR detail screen reads the threshold from here, so prove it is readable
  // by a role that cannot read the whole routing table.
  const asRequester = await api('/workflow/threshold', { token: requester });
  eq('set threshold: a requester can read the threshold endpoint', asRequester.status, 200);
  if (Number(asRequester.data?.managementThreshold) === 2_500_000) {
    ok('set threshold: the PR screen will show the live value', String(asRequester.data.managementThreshold));
  } else {
    bad('set threshold: the PR screen will show the live value', JSON.stringify(asRequester.data));
  }
  model.managementThreshold = 2_500_000;
}

// =========================================================================
// 9. handler: lightWorkflowAddStep / lightWorkflowDeleteStep
// =========================================================================
{
  const key = `custom_${Date.now()}`;
  const next = [
    ...JSON.parse(JSON.stringify(model.steps)),
    {
      key, name: 'New step', from: 'Submitted', to: 'IN_PROCUREMENT_REVIEW',
      order: model.steps.length + 1, actorRole: 'system', when: 'always',
      canSkip: false, requiresCapexOpex: false, terminal: false,
    },
  ];
  const r = await save({ ...model, steps: next });
  eq('add step: PUT accepted', r.status, 200);
  const exists = psqlScalar(`SELECT count(*) FROM workflow.steps_config WHERE id = '${key}'`);
  if (Number(exists) === 1) ok('add step: the custom step exists in the database', key);
  else bad('add step: the custom step exists in the database', `count=${exists}`);

  // Delete it again, the way the grid's confirm-guarded × does.
  const trimmed = next.filter(s => s.key !== key).map((s, i) => ({ ...s, order: i + 1 }));
  const r2 = await save({ ...model, steps: trimmed });
  eq('delete step: PUT accepted', r2.status, 200);
  const gone = psqlScalar(`SELECT count(*) FROM workflow.steps_config WHERE id = '${key}'`);
  if (Number(gone) === 0) ok('delete step: the custom step is gone from the database');
  else bad('delete step: the custom step is gone from the database', `count=${gone}`);
  model.steps = trimmed;
}

// =========================================================================
// 10. role gates: a requester can read the threshold but not the config
// =========================================================================
{
  const cfg = await api('/workflow/config', { token: requester });
  eq('a requester cannot read the routing table', cfg.status, 403);
  const put = await api('/workflow/config', {
    method: 'PUT', token: requester,
    body: { steps: model.steps, managementThreshold: 1 },
  });
  eq('a requester cannot rewrite the routing table', put.status, 403);
}

// =========================================================================
// 11. handler: lightWorkflowResetDefaults — restore, then prove restoration
// =========================================================================
{
  const r = await api('/workflow/config/reset', { method: 'POST', token: admin });
  if (r.status === 200 || r.status === 201) ok('reset to defaults: accepted', `HTTP ${r.status}`);
  else bad('reset to defaults: accepted', `got ${r.status} ${JSON.stringify(r.data)}`);

  // Migration 035 moved the gate onto the global threshold, so there is no
  // per-step conditionValue on finance_review any more. What a reset must
  // restore is the WIRING: both steps back on the global predicates, with no
  // duplicated number reintroduced.
  const wired = psqlScalar(
    `SELECT count(*) FROM workflow.steps_config
      WHERE id IN ('finance_review','finance_release')
        AND payload->>'when' IN ('aboveMgtThreshold','belowMgtThreshold')`,
  );
  if (Number(wired) === 2) ok('reset to defaults: both gate steps are back on the global threshold');
  else bad('reset to defaults: both gate steps are back on the global threshold', `db has ${wired} of 2`);

  const dup = psqlScalar(
    `SELECT count(*) FROM workflow.steps_config
      WHERE id IN ('finance_review','finance_release')
        AND jsonb_typeof(payload->'conditionValue') <> 'null'`,
  );
  if (Number(dup) === 0) ok('reset to defaults: and no duplicated conditionValue came back');
  else bad('reset to defaults: and no duplicated conditionValue came back', `${dup} present`);

  const name = psqlScalar(`SELECT payload->>'name' FROM workflow.steps_config WHERE id = 'procurement'`);
  if (name === 'Procurement review') ok('reset to defaults: the renamed step is back to its default name');
  else bad('reset to defaults: the renamed step is back to its default name', `db holds ${name}`);

  const thr = psqlScalar(`SELECT value::text FROM workflow.config WHERE key = 'management_threshold'`);
  ok('reset to defaults: the threshold is reported to the caller (deliberately NOT reset)', thr);
}

// -- restore the threshold this suite moved -------------------------------
await api('/workflow/config/threshold', {
  method: 'PUT', token: admin, body: { managementThreshold: originalThreshold },
});
const finalThr = psqlScalar(`SELECT value::text FROM workflow.config WHERE key = 'management_threshold'`);
eq('suite left the threshold as it found it', finalThr, originalThreshold);

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail === 0
  ? 'VERDICT: the Part 7 builder round-trips through the real API and the engine follows it.\n'
  : 'VERDICT: gaps remain. See failures above.\n');
process.exit(fail === 0 ? 0 : 1);
