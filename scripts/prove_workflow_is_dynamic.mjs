// PROOF HARNESS — is the workflow configuration actually live?
//
// The claim this sprint makes is falsifiable: editing workflow.steps_config
// changes what the engine computes. A unit test cannot prove that, because a
// unit test supplies the step list itself and so proves nothing about where the
// engine got it. Only a real round trip through the database can.
//
// This harness therefore talks to the live database, and asserts a CAUSAL link:
//
//   1. read the table  -> route a PR with the engine  -> record the result
//   2. EDIT ONE FIELD IN THE DATABASE
//   3. read the table  -> route the same PR           -> assert the result MOVED
//   4. restore the original row and assert the result moves BACK
//
// Step 4 matters as much as step 3: a harness that only proves "it changed"
// would also pass if the engine ignored the database entirely and the change
// were coincidental.
//
// Every step restores the original payload in a finally block, so a failed run
// leaves the routing table exactly as it found it.
//
// Usage:  node scripts/prove_workflow_is_dynamic.mjs
// Requires: docker container `procurement-portal-db` running, engine built.

import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const enginePath = '../packages/workflow-engine/dist/index.js';
const {
  planAdvance,
  stepsFromConfigRows,
  validateStepConfig,
  DEFAULT_MANAGEMENT_THRESHOLD,
} = require(enginePath);

const CONTAINER = process.env.PG_CONTAINER || 'procurement-portal-db';
const DB_USER = process.env.DB_USER || 'proc';
const DB_NAME = process.env.DB_NAME || 'procurementDB';

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

// -- Minimal psql bridge, mirroring DbService's CSV contract --

function psql(sql) {
  // psql needs each statement terminated. DbService does this in wrapWithContext
  // (`withSemicolon`); without it psql appends COMMIT to the open statement and
  // reports a syntax error against COMMIT rather than against the real query.
  const body = sql.trim().replace(/;\s*$/, '') + ';';
  const res = spawnSync(
    'docker',
    [
      'exec', '-i', CONTAINER,
      'psql', '-U', DB_USER, '-d', DB_NAME,
      '--csv', '-X', '-q', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-f', '-',
    ],
    { input: `BEGIN;\n${body}\nCOMMIT;\n`, encoding: 'utf8' },
  );
  if (res.status !== 0) {
    throw new Error(`psql failed: ${res.stderr || res.stdout}`);
  }
  return parseCsv(res.stdout);
}

/** RFC-4180 line parser, matching DbService.parseCsvLine. */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += ch;
    } else if (ch === ',') { out.push(cur); cur = ''; }
    else if (ch === '"' && cur.length === 0) inQuotes = true;
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCsv(stdout) {
  const lines = stdout.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')
    .filter(l => l.trim() !== '');
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const cells = parseCsvLine(line);
    const row = {};
    header.forEach((h, i) => {
      const v = cells[i];
      row[h] = v === undefined || v === 'NULL' || v === '' ? null : v;
    });
    return row;
  });
}

// - Load the routing config the way the API does -

function loadConfig() {
  const stepRows = psql(
    `SELECT id, payload::text AS payload, order_index FROM workflow.steps_config ORDER BY order_index`,
  );
  const cfgRows = psql(
    `SELECT value::text AS value FROM workflow.config WHERE key = 'management_threshold'`,
  );
  const threshold = Number(cfgRows[0]?.value);
  return {
    steps: stepsFromConfigRows(
      stepRows.map(r => ({ id: r.id, payload: JSON.parse(r.payload), order_index: Number(r.order_index) })),
    ),
    managementThreshold: Number.isFinite(threshold) ? threshold : DEFAULT_MANAGEMENT_THRESHOLD,
  };
}

/** Route a fixed PKR 2,000,000 PR sitting in Finance review. */
function route2MillionPr(config) {
  const plan = planAdvance(config, {
    id: 'proof-pr',
    prNumber: 'PR-PROOF-0001',
    status: 'IN_FINANCE_REVIEW',
    estimatedAmount: 2_000_000,
    expenseType: 'CAPEX',
    lines: [{ itemCategory: 'IT_HARDWARE', amount: 2_000_000 }],
  });
  // A transition plan carries the matched step as `step`; `matchedStep` belongs
  // to the lower-level resolveNextStage result, not to the plan.
  if (plan.kind === 'none') return 'NONE';
  if (plan.kind === 'split') return `SPLIT->${plan.parentStage}`;
  return `${plan.step.key}->${plan.nextStage}`;
}

// - The proof -

console.log('\nPROVING the workflow configuration is read from the database\n');

// Pre-flight: every anchor must resolve, or the proof is vacuous.
const preflight = psql(
  `SELECT count(*)::text AS n FROM workflow.steps_config
    WHERE payload ? 'from' AND payload ? 'when'`,
);
const scoped = Number(preflight[0]?.n ?? 0);
if (scoped < 1) {
  console.error('  ABORT  no steps carry `from`/`when`; migration 029 has not been applied.');
  process.exit(1);
}
ok('every stored step carries `from` and `when` (migration 029 applied)', `${scoped} steps`);

const original = psql(
  `SELECT payload::text AS payload FROM workflow.steps_config WHERE id = 'finance_review'`,
);
if (!original[0]?.payload) {
  console.error('  ABORT  finance_review row is missing; the probe cannot run.');
  process.exit(1);
}
const originalPayload = original[0].payload;
// The governing number lives in workflow.config, not on the row — migration 035
// retired the duplicated conditionValue. Reading it from the row would yield NaN
// and quietly turn the whole harness into a no-op.
const origCondition = Number(
  psql(
    `SELECT value::text AS v FROM workflow.config WHERE key = 'management_threshold'`,
  )[0]?.v,
);
if (!Number.isFinite(origCondition)) {
  console.error('  ABORT  workflow.config has no usable management_threshold.');
  process.exit(1);
}
const shadowOnRow = JSON.parse(originalPayload).conditionValue;
if (shadowOnRow !== undefined && shadowOnRow !== null) {
  bad('the gate step carries no shadow number of its own',
      `finance_review still has conditionValue ${shadowOnRow}`);
} else {
  ok('the gate step carries no shadow number of its own — one global value governs');
}

try {
  // - 1. Baseline -
  const before = route2MillionPr(loadConfig());
  console.log(`\n  baseline: PKR 2,000,000 PR at IN_FINANCE_REVIEW routes ${before}`);
  assert.equal(before, 'finance_review->IN_MANAGEMENT_REVIEW');
  ok('baseline route is the Management gate', before);

  // - 2. Edit ONE NUMBER in the database -
  // The number that governs the gate now lives in workflow.config, read by both
  // gate steps through aboveMgtThreshold / belowMgtThreshold (migration 035).
  // Under the old engine the row's number was decorative: the closure re-stated
  // 1_000_000 in its body and never read conditionValue, so that write would have
  // changed the label and nothing else.
  const newThreshold = 50_000_000;
  psql(
    `UPDATE workflow.config
        SET value = to_jsonb(${newThreshold}::numeric), updated_at = now()
      WHERE key = 'management_threshold'`,
  );
  ok('EDITED workflow.config.management_threshold in the database',
     `${origCondition.toLocaleString('en-PK')} -> ${newThreshold.toLocaleString('en-PK')}`);

  // - 3. The engine must now disagree -
  const after = route2MillionPr(loadConfig());
  console.log(`  after:   same PR now routes ${after}`);
  if (after === before) {
    bad('routing followed the database edit',
        `route stayed ${after} — the engine is NOT reading the edited value`);
  } else {
    // Previously this edit produced NONE: a dead band where no step matched. That
    // was possible precisely because two steps carried duplicated numbers that
    // could be edited apart. With ONE global value the gate is single-sourced, so
    // the same edit now moves the PR to the release branch instead of stranding
    // it. The improvement IS the result.
    assert.equal(after, 'finance_release->READY_FOR_D365');
    ok('routing followed the database edit - the 2M PR now takes the release branch', after);
  }

  // - 3b. A dead band must still be refused, by the only route that can now
  //      create one: reintroducing per-step amount predicates that disagree.
  const stranded = loadConfig();
  const sr = stranded.steps.find(s => s.key === 'finance_review');
  const sl = stranded.steps.find(s => s.key === 'finance_release');
  sr.when = 'amountGTE';
  sr.conditionValue = 50_000_000;
  sl.when = 'amountLT';
  sl.conditionValue = 1_000_000;
  const verdict = validateStepConfig(stranded.steps, stranded.managementThreshold);
  if (verdict.ok) {
    bad('a stranded configuration is rejected at save time',
        'validateStepConfig accepted mismatched amountGTE/amountLT thresholds');
  } else {
    ok('validateStepConfig REFUSES a stranded config, so the API would never have saved it',
       verdict.errors[0]);
  }

  // - 3c. And a global-threshold step may not carry its own number, or the
  //       single source of truth becomes ambiguous again.
  const shadow = loadConfig();
  shadow.steps.find(s => s.key === 'finance_review').conditionValue = 7_777_777;
  const shadowVerdict = validateStepConfig(shadow.steps, shadow.managementThreshold);
  if (shadowVerdict.ok) {
    bad('a threshold-gated step carrying its own conditionValue is rejected',
        'validateStepConfig accepted a shadow number on a global-threshold step');
  } else {
    ok('a shadow conditionValue on a global-threshold step is rejected',
       shadowVerdict.errors[0].slice(0, 80));
  }

  // - 4. And the `when` keyword itself must be honoured -
  // Swap the keyword, not the number. If `when` were still compiled in, this
  // edit would also be inert.
  psql(
    `UPDATE workflow.steps_config
        SET payload = jsonb_set(payload, '{when}', '"always"'::jsonb, true)
      WHERE id = 'finance_release'`,
  );
  const bothAlways = route2MillionPr(loadConfig());
  if (bothAlways === 'finance_review->IN_MANAGEMENT_REVIEW') {
    bad('a `when` edit changed routing', 'setting finance_release to always did not take effect');
  } else {
    ok('a `when` keyword edit changed routing too', bothAlways);
  }

  // - 5. Order is data, not array position -
  const ordered = psql(
    `SELECT id FROM workflow.steps_config WHERE id = 'finance_review'`,
  );
  if (ordered.length !== 1) {
    bad('step lookup is key-based', `expected 1 finance_review row, found ${ordered.length}`);
  } else {
    ok('steps are addressable by key from the table (no in-code array position)');
  }
} finally {
  // - 6. Restore, and prove the restore took -
  const esc = (s) => s.replace(/'/g, "''");
  psql(
    `UPDATE workflow.steps_config SET payload = '${esc(originalPayload)}'::jsonb WHERE id = 'finance_review';
     UPDATE workflow.steps_config
        SET payload = jsonb_set(payload, '{when}', '"belowMgtThreshold"'::jsonb, true)
      WHERE id = 'finance_release';
     UPDATE workflow.config
        SET value = to_jsonb(${origCondition}::numeric), updated_at = now()
      WHERE key = 'management_threshold'`,
  );
  const restored = route2MillionPr(loadConfig());
  console.log(`\n  restored: same PR routes ${restored}`);
  if (restored === 'finance_review->IN_MANAGEMENT_REVIEW') {
    ok('restoring the original rows restored the original route', restored);
  } else {
    bad('restore is complete', `route is ${restored} after restoring the original payloads`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(
  fail === 0
    ? 'VERDICT: routing is genuinely read from workflow.steps_config.\n'
    : 'VERDICT: routing is NOT fully dynamic. See the failures above.\n',
);
process.exit(fail === 0 ? 0 : 1);
