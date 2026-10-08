// E2E — the Dynamic Workflow Visual Builder's backing API (Part 7, Step 1).
//
// Proves the REST surface is genuinely wired to workflow.steps_config, not to a
// hardcoded array dressed as configuration. Each check goes through ok(), so the
// printed PASS count and the footer tally always agree.
//
// Requires: Postgres on 55432 and the API on 33001, both with the rebuilt code.

const API = process.env.API_BASE || 'http://127.0.0.1:33001';

// Minimal psql bridge, used only to prove the per-PR snapshot row really landed.
// The API is the system under test; the database is the witness.
const { spawnSync } = await import('node:child_process');
const CONTAINER = process.env.PG_CONTAINER || 'procurement-portal-db';
const DB_USER = process.env.DB_USER || 'proc';
const DB_NAME = process.env.DB_NAME || 'procurementDB';

function psqlCount(sql) {
  return psqlScalar(sql);
}

function psqlScalar(sql) {
  const res = spawnSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', DB_USER, '-d', DB_NAME,
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

let pass = 0;
let fail = 0;
const ok = (label, extra = '') => {
  pass++;
  console.log(`  PASS  ${label}${extra ? `  (${extra})` : ''}`);
};
const bad = (label, detail) => {
  fail++;
  console.log(`  FAIL  ${label}\n        ${detail}`);
};
const eq = (label, actual, expected) => {
  if (actual === expected) ok(label, String(actual));
  else bad(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}

async function loginAs(email) {
  const r = await api('/auth/login', { method: 'POST', body: { email, password: 'demo' } });
  if (!r.data?.token) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.token;
}

console.log(`\n=== Part 7 Step 1 — workflow configuration API against ${API} ===\n`);

// -- Preflight: the service must be reachable, or every later check is a lie --
try {
  const h = await api('/health');
  if (h.status !== 200) {
    console.error(`  ABORT  API not healthy (${h.status}).`);
    process.exit(1);
  }
} catch (e) {
  console.error(`  ABORT  API unreachable at ${API}: ${e.message}`);
  process.exit(1);
}

const admin = await loginAs('admin@pakboxes.pk');
const requester = await loginAs('requester@pakboxes.pk');
ok('authenticated as admin and requester');

// -- 1. The config is read from the database -------------------------------
const read = await api('/workflow/config', { token: admin });
if (read.status !== 200) {
  bad('GET /workflow/config returns 200', `got ${read.status} ${JSON.stringify(read.data)}`);
} else {
  const cfg = read.data;
  eq('config reports source=db (NOT a hardcoded fallback)', cfg.source, 'db');
  eq('all 14 steps are served from the table', cfg.steps.length, 14);
  eq('management threshold served from workflow.config', cfg.managementThreshold, 1000000);
  eq(
    'the closed predicate vocabulary ships with the config',
    cfg.predicateVocabulary.length,
    16,
  );
  // Migration 035 moved the management gate onto the GLOBAL threshold: both
  // steps now read workflow.config instead of carrying duplicated
  // conditionValues. A data `when` with no welded number is exactly what makes
  // the gate single-sourced.
  const financeReview = cfg.steps.find(s => s.key === 'finance_review');
  eq('finance_review carries a data `when`, not a closure', financeReview.when, 'aboveMgtThreshold');
  eq('finance_review reads the GLOBAL threshold, not its own number',
     financeReview.conditionValue ?? null, null);
  const financeRelease = cfg.steps.find(s => s.key === 'finance_release');
  eq('finance_release is its complement', financeRelease.when, 'belowMgtThreshold');
  const duplicated = cfg.steps.filter(s => s.conditionValue != null &&
    ['aboveMgtThreshold', 'belowMgtThreshold'].includes(s.when));
  eq('no threshold-gated step carries a duplicated conditionValue', duplicated.length, 0);
  const hod = cfg.steps.find(s => s.key === 'hod_review');
  eq('hod_review still carries its 3 line rules (split not lost)', (hod.lineRules || []).length, 3);
  const everyStepScoped = cfg.steps.every(s => !!s.from);
  if (everyStepScoped) ok('every step has a `from` stage (migration 029 backfill)');
  else bad('every step has a `from` stage', 'at least one step has no from');
}

// -- 2. Reads are role-gated ------------------------------------------------
const denied = await api('/workflow/config', { token: requester });
eq('a requester cannot read the routing table', denied.status, 403);

// -- 3. A threshold edit persists and is read back from the DB --------------
const originalThreshold = read.data.managementThreshold;
const newThreshold = 1_250_000;
const put = await api('/workflow/config/threshold', {
  method: 'PUT',
  token: admin,
  body: { managementThreshold: newThreshold },
});
if (put.status !== 200) {
  bad('PUT /workflow/config/threshold succeeds', `got ${put.status} ${JSON.stringify(put.data)}`);
} else {
  ok('PUT /workflow/config/threshold accepted', `${originalThreshold} -> ${newThreshold}`);
  const reread = await api('/workflow/config', { token: admin });
  eq(
    'the new threshold is read back (persisted, not echoed)',
    reread.data.managementThreshold,
    newThreshold,
  );
}

// -- 4. Invalid configs are refused, and nothing is written -----------------
const cfgNow = (await api('/workflow/config', { token: admin })).data;

const badKeyword = cfgNow.steps.map(s => ({ ...s }));
const target = badKeyword.find(s => s.key === 'procurement');
target.when = 'totallyMadeUpCondition';
const badRes = await api('/workflow/config', {
  method: 'PUT',
  token: admin,
  body: { steps: badKeyword, managementThreshold: cfgNow.managementThreshold },
});
eq('an unknown condition keyword is refused with 400', badRes.status, 400);
if (Array.isArray(badRes.data?.errors) && badRes.data.errors.length > 0) {
  ok('the refusal names the offending condition', badRes.data.errors[0]);
} else {
  bad('the refusal explains itself', `no errors array: ${JSON.stringify(badRes.data)}`);
}

// Stranded pair: amountGTE raised far above amountLT leaves a dead band. The
// `when` keywords must be set explicitly — on the global-threshold predicates a
// stray conditionValue is simply ignored, so the save would look valid.
const stranded = cfgNow.steps.map(s => ({ ...s }));
stranded.find(s => s.key === 'finance_review').when = 'amountGTE';
stranded.find(s => s.key === 'finance_review').conditionValue = 50_000_000;
stranded.find(s => s.key === 'finance_release').when = 'amountLT';
stranded.find(s => s.key === 'finance_release').conditionValue = 1_000_000;
const strandRes = await api('/workflow/config', {
  method: 'PUT',
  token: admin,
  body: { steps: stranded, managementThreshold: cfgNow.managementThreshold },
});
eq('a config that would strand in-flight PRs is refused with 400', strandRes.status, 400);

const afterRefusals = await api('/workflow/config', { token: admin });
eq(
  'a refused save leaves the live table untouched',
  afterRefusals.data.steps.find(s => s.key === 'finance_review').when,
  'aboveMgtThreshold',
);

// Amount predicate with no number must be refused, not silently defaulted.
const noNumber = cfgNow.steps.map(s => ({ ...s }));
noNumber.find(s => s.key === 'finance_review').when = 'amountGTE';
noNumber.find(s => s.key === 'finance_review').conditionValue = null;
const noNumRes = await api('/workflow/config', {
  method: 'PUT',
  token: admin,
  body: { steps: noNumber, managementThreshold: cfgNow.managementThreshold },
});
eq('an amount condition with no conditionValue is refused', noNumRes.status, 400);

// And the global-threshold predicates must NOT accept a number at all, or the
// single source of truth becomes ambiguous again.
const shadow = cfgNow.steps.map(s => ({ ...s }));
shadow.find(s => s.key === 'finance_review').conditionValue = 7_777_777;
const shadowRes = await api('/workflow/config', {
  method: 'PUT',
  token: admin,
  body: { steps: shadow, managementThreshold: cfgNow.managementThreshold },
});
eq(
  'a threshold-gated step that also carries a conditionValue is refused',
  shadowRes.status,
  400,
);

// -- 5. A write-only role cannot change the workflow ------------------------
const asRequester = await api('/workflow/config/threshold', {
  method: 'PUT',
  token: requester,
  body: { managementThreshold: 5 },
});
eq('a requester cannot change the threshold', asRequester.status, 403);

// -- 6. A PR freezes the config it was created under ------------------------
const ccs = await api('/lookups/cost-centers', { token: requester });
const cc = (ccs.data?.costCenters || ccs.data || [])[0];
// A real item is required: the create DTO rejects a line without an item UUID.
const itemId = psqlScalar(`SELECT id::text FROM core.items ORDER BY item_code LIMIT 1`);
if (!cc?.id) {
  bad('a cost centre was available to create a PR', JSON.stringify(ccs.data).slice(0, 160));
} else if (!itemId) {
  bad('an item was available to create a PR line', 'core.items returned no row');
} else {
  const created = await api('/pr', {
    method: 'POST',
    token: requester,
    body: {
      costCenterId: cc.id,
      scope: 'IT',
      expenseType: 'OPEX',
      title: 'Part 7 snapshot proof',
      purpose: 'Verify the routing config is frozen per PR',
      urgency: 'routine',
      requiredByDate: '2026-12-31',
      lines: [{ itemId, description: 'Proof line', quantity: 1, uom: 'EA', unitPriceEst: 1000 }],
    },
  });
  if (created.status >= 400 || !created.data?.id) {
    bad('PR creation succeeded', `${created.status} ${JSON.stringify(created.data).slice(0, 160)}`);
  } else {
    ok('PR created', created.data.prNumber);
    // The snapshot is what stops a later admin edit from re-routing a request
    // that is already in flight. Assert the row exists in the database rather
    // than trusting the service to have written it.
    const snap = psqlCount(
      `SELECT count(*)::text FROM workflow.pr_workflow_snapshot
        WHERE pr_id = '${created.data.id}' AND jsonb_array_length(steps) > 0`,
    );
    if (snap === 1) {
      ok('workflow.pr_workflow_snapshot froze the config for this PR', '1 row, non-empty steps');
    } else {
      bad('workflow.pr_workflow_snapshot froze the config for this PR',
          `expected exactly 1 frozen row, found ${snap}`);
    }
    // The frozen config must carry the routing data the engine needs, not just
    // a bare array of keys.
    const scoped = psqlCount(
      `SELECT count(*)::text FROM workflow.pr_workflow_snapshot s,
              jsonb_array_elements(s.steps) e
        WHERE s.pr_id = '${created.data.id}' AND (e ? 'from')`,
    );
    if (scoped === 14) {
      ok('every frozen step retained its `from` stage', '14/14');
    } else {
      bad('every frozen step retained its `from` stage', `expected 14, found ${scoped}`);
    }
    // The raw config must still be database-sourced after the write path ran.
    const raw = await fetch(`${API}/workflow/config/raw`, {
      headers: { authorization: `Bearer ${admin}` },
    });
    const rawCfg = await raw.json();
    eq(
      'raw config still reports source=db after the PR write path ran',
      rawCfg.source,
      'db',
    );
  }
}

// -- 7. Reset to defaults ---------------------------------------------------
// @Post answers 201 Created by default in Nest; both 200 and 201 are a success.
const reset = await api('/workflow/config/reset', { method: 'POST', token: admin });
if (reset.status === 200 || reset.status === 201) {
  ok('POST /workflow/config/reset succeeds', `HTTP ${reset.status}`);
} else {
  bad('POST /workflow/config/reset succeeds', `expected 200/201, got ${reset.status} ${JSON.stringify(reset.data)}`);
}
if (reset.status === 200 || reset.status === 201) {
  const afterReset = await api('/workflow/config', { token: admin });
  eq('reset restores the canonical 14 steps', afterReset.data.steps.length, 14);
}

// -- 8. Restore the original threshold so the system is left as found ------
await api('/workflow/config/threshold', {
  method: 'PUT',
  token: admin,
  body: { managementThreshold: originalThreshold },
});
const final = await api('/workflow/config', { token: admin });
eq('threshold restored to its original value', final.data.managementThreshold, originalThreshold);

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail === 0 ? 'VERDICT: Part 7 Step 1 backend is live and persisted.\n'
                       : 'VERDICT: gaps remain. See failures above.\n');
process.exit(fail === 0 ? 0 : 1);
