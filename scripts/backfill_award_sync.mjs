// backfill_award_sync.mjs — re-apply the award to the requests that were
// stranded by the missing write-back.
//
// WHAT WENT WRONG
// ----------------
// The CS review chain's confirm() moved a request to Cost approval without
// ever writing the winning rates onto proc.pr_lines. The cost gate asks the
// header whether the amount is known, and the header asks the lines, and the
// lines had no price — so the gate refused every one of them, and the request
// sat at Cost approval with an UNKNOWN amount and a statement that was
// confirmed but never priced.
//
// THE FIX IS NOT IN THIS SCRIPT
// -----------------------------
// The repair is the endpoint POST /pr/:id/reapply-award, which calls the same
// routine the CS confirmation calls. This script finds the stranded requests
// and calls it. There is no second implementation of the award rule: a script
// that wrote the rates itself would be a second declaration of it, and the two
// would drift.
//
// FORWARD-ONLY
// ------------
// Only requests whose comparative statement is still 'Generated' — never locked,
// no winner recorded — are touched. A statement that was locked went through
// the legacy CS lock, which records its own winner, and is not this problem.
//
// Usage:
//   node scripts/backfill_award_sync.mjs            # plan only, writes nothing
//   node scripts/backfill_award_sync.mjs --apply    # do it
//   node scripts/backfill_award_sync.mjs --apply --only PR-2026-201687

import { execFileSync } from 'node:child_process';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const APPLY = process.argv.includes('--apply');
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  return i >= 0 ? process.argv[i + 1] : null;
})();

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

const login = async (email) =>
  (await api('/auth/login', { method: 'POST', body: { email, password: 'demo' } })).data?.token;

function sql(text) {
  const out = execFileSync(
    'docker',
    ['exec', '-i', 'procurement-portal-db', 'psql', '-U', 'proc', '-d', 'procurementDB',
      '-X', '-q', '-A', '-t', '-F', '|', '-c', text],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

console.log(`\n=== Award write-back backfill against ${API} ===\n`);

// ── the stranded requests ───────────────────────────────────────────────────
//
// A request is stranded when it is sitting at Cost approval, its statement was
// never locked, and the money is not whole. Two ways that happens:
//
//   * the header says UNKNOWN and an approved line carries no price — the
//     original deadlock, where the award was never written back at all; or
//   * the header says UNKNOWN but the lines DO carry prices — a half-written
//     state, left by a write-back that failed between writing the lines and
//     recomputing the header. The first run of this script produced exactly
//     that, which is why the header is checked as well as the lines.
//
// The approved-line rule is the same one the application uses; a held line is
// not part of the spend and never had a rate.
const rows = sql(`
  SELECT pr.pr_number,
         pr.id::text,
         pr.status,
         pr.amount_status,
         COALESCE(pr.estimated_amount, 0)::text,
         cs.cs_number,
         cs.state,
         (SELECT count(*) FROM proc.cs_line_awards a
           WHERE a.cs_id = cs.id AND a.superseded_at IS NULL)::text AS awards,
         (SELECT count(*) FROM proc.pr_lines pl
           WHERE pl.pr_id = pr.id AND pl.approved AND NOT pl.rejected AND NOT pl.held
             AND pl.unit_price_est IS NULL)::text AS unpriced
    FROM proc.purchase_requisitions pr
    JOIN proc.comparative_statements cs
      ON cs.id = (SELECT c2.id FROM proc.comparative_statements c2
                   WHERE c2.pr_id = pr.id ORDER BY c2.cs_round DESC LIMIT 1)
   WHERE pr.status = 'IN_COST_CENTER_APPROVAL'
     AND cs.state = 'Generated'
     AND (pr.amount_status <> 'ESTIMATED'
          OR EXISTS (SELECT 1 FROM proc.pr_lines pl
                      WHERE pl.pr_id = pr.id AND pl.approved AND NOT pl.rejected AND NOT pl.held
                        AND pl.unit_price_est IS NULL))
   ORDER BY pr.pr_number;`);

const targets = rows
  .map((r) => {
    const [pr_number, id, status, amount_status, estimated, cs_number, cs_state, awards, unpriced] =
      r.split('|');
    return {
      pr_number, id, status, amount_status, estimated,
      cs_number, cs_state, awards: Number(awards), unpriced: Number(unpriced),
    };
  })
  .filter((t) => !ONLY || t.pr_number === ONLY);

console.log(`Stranded requests found: ${targets.length}\n`);
for (const t of targets) {
  console.log(
    `  ${t.pr_number.padEnd(18)} ${t.cs_number.padEnd(16)} state=${t.cs_state.padEnd(10)} ` +
    `amount=${t.amount_status.padEnd(9)} awards=${String(t.awards).padStart(2)} ` +
    `unpriced approved lines=${t.unpriced}`,
  );
}

if (!targets.length) {
  console.log('\nNothing to do.\n');
  process.exit(0);
}

// ── the plan ────────────────────────────────────────────────────────────────
const noAwards = targets.filter((t) => t.awards === 0);
if (noAwards.length) {
  console.log(
    `\nNOTE: ${noAwards.length} of these have NO recorded award (nobody won a line). ` +
    'The write-back can only price a line that was awarded, so these will be ' +
    'reported and left alone: ' + noAwards.map((t) => t.pr_number).join(', '),
  );
}

if (!APPLY) {
  console.log('\nPLAN ONLY — nothing was written. Re-run with --apply to do it.\n');
  process.exit(0);
}

// ── do it ───────────────────────────────────────────────────────────────────
const token = await login('procurement@pakboxes.pk') || await login('admin@pakboxes.pk');
if (!token) {
  console.error('\nCould not log in. Aborting — nothing was written.\n');
  process.exit(1);
}
console.log('\nApplying...\n');

let ok = 0; let failed = 0; let unawarded = 0;
for (const t of targets) {
  const res = await api(`/pr/${t.id}/reapply-award`, { method: 'POST', token });
  if (res.status >= 200 && res.status < 300) {
    const d = res.data || {};
    const stillUnpriced = (d.unawarded_lines || []).length;
    if (stillUnpriced) unawarded++; else ok++;
    console.log(
      `  OK   ${t.pr_number}  rates applied: [${(d.rates_applied || []).join(', ')}]  ` +
      `amount=${d.amount_status} ${d.estimated_amount}  capex=${d.capex_amount} opex=${d.opex_amount}` +
      (stillUnpriced ? `  (no award on lines ${(d.unawarded_lines || []).join(', ')})` : ''),
    );
  } else {
    failed++;
    console.log(`  FAIL ${t.pr_number}  HTTP ${res.status}  ${JSON.stringify(res.data).slice(0, 220)}`);
  }
}

console.log(
  `\nDone. priced=${ok}  no-award-left=${unawarded}  failed=${failed}\n`,
);

// ── verify ──────────────────────────────────────────────────────────────────
const after = sql(`
  SELECT pr.pr_number, pr.amount_status, COALESCE(pr.estimated_amount,0)::text,
         (SELECT count(*) FROM proc.pr_lines pl
           WHERE pl.pr_id = pr.id AND pl.approved AND NOT pl.rejected AND NOT pl.held
             AND pl.unit_price_est IS NULL)::text
    FROM proc.purchase_requisitions pr
   WHERE pr.status = 'IN_COST_CENTER_APPROVAL'
     AND pr.id IN (${targets.map((t) => `'${t.id}'`).join(',') || `'00000000-0000-0000-0000-000000000000'`})
   ORDER BY pr.pr_number;`);
console.log('After the backfill:');
for (const r of after) {
  const [pr_number, amount_status, estimated, unpriced] = r.split('|');
  console.log(`  ${pr_number.padEnd(18)} amount=${amount_status.padEnd(9)} ${estimated.padStart(12)}  unpriced approved lines=${unpriced}`);
}
console.log('');
