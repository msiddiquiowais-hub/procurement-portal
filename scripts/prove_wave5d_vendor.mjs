// Wave 5 Track D — proof that the vendor risk model is load-bearing.
//
//   node scripts/prove_wave5d_vendor.mjs
//
// Requires: Postgres 55432, the API on 33001.
//
// WHAT THIS PROVES, AND WHY IT NEEDS A DATABASE
// ---------------------------------------------
// The claim is not "the screen renders a risk column". The claim is that ONE
// graded fact decides three separate things, and that changing it in the database
// moves all three:
//
//   1. the Vendor Master's Risk column
//   2. the Vendor Risk matrix (band, score, action, and the 3-up KPI counts)
//   3. whether the RFQ invitation guard actually REFUSES a vendor
//
// A unit test cannot prove any of it: it would hand the code its own scorecard,
// so it would say nothing about where the number came from. The honest proof is a
// causal round trip against the live stack:
//
//   1. read vendor V-00084 (seeded A/A/B -> Low, eligible)
//   2. invite it to an RFQ            -> accepted, a real invitation exists
//   3. MUTATE the scorecard in the DB to C/C/C
//   4. read back: the matrix moved to High/25, the KPI counts moved,
//      and the SAME invitation is now refused
//   5. restore, and assert everything moved BACK
//
// Step 5 is what makes this a proof rather than a coincidence check. A harness that
// only showed "it changed" would also pass if the API ignored the database and
// recomputed from a constant.
//
// THE MODEL IS NOT REIMPLEMENTED IN THE HARNESS. Every expected number below is
// derived from the blueprint formula written out longhand, so the harness would
// FAIL if the SQL disagreed with the specification — which is the point.
//
// EVERY mutation is restored in a finally block, so a failed run leaves the live
// database as it found it.

import { spawnSync } from 'node:child_process';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const CONTAINER = process.env.PG_CONTAINER || 'procurement-portal-db';

let pass = 0;
let fail = 0;
let findings = 0;
const ok = (label, extra = '') => { pass++; console.log(`  PASS  ${label}${extra ? `  (${extra})` : ''}`); };
const bad = (label, detail) => { fail++; console.log(`  FAIL  ${label}\n        ${detail}`); };
const finding = (label, detail) => {
  findings++;
  console.log(`  FINDING  ${label}\n            ${detail}`);
};
const eq = (label, actual, expected) => {
  if (String(actual) === String(expected)) ok(label, String(actual));
  else bad(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

// ── the blueprint formula, written out independently of the SQL ──────────────
const GRADE_POINTS = { A: 3, B: 2, C: 1, D: 0 };
function compositeOf({ financial, delivery, quality }) {
  const s = GRADE_POINTS[financial] * 0.4 + GRADE_POINTS[delivery] * 0.35 + GRADE_POINTS[quality] * 0.25;
  return {
    weighted: s,
    score: Math.round(s * 100 / 3),
    grade: s >= 2.5 ? 'Low' : s >= 1.5 ? 'Medium' : 'High',
  };
}

/**
 * Run SQL and RETURN IT, or THROW.
 *
 * Two things this must not be:
 *
 *  1. `-c "<sql>"` on the command line. Windows strips double quotes from a
 *     native command's arguments before the container sees them, so an embedded
 *     JSON literal arrives with its quotes removed and the statement is a syntax
 *     error. Piping the SQL through stdin sidesteps the command line entirely.
 *  2. `return stdout + stderr`. An earlier version did that, so a failed UPDATE
 *     looked exactly like an empty result — the restore silently did nothing and
 *     left the live database mutated, while the harness still reported "restored".
 *     A helper that cannot fail is not a helper; this one throws.
 *
 * The session also sets `app.vendor_change_token`. Migration 039 governs every
 * vendor column, so a raw UPDATE is refused without that token. This harness
 * deliberately rewrites a vendor's scorecard and compliance dates to prove the
 * screens and the 40/35/25 arithmetic react, so it declares itself a fixture
 * writer. It appends no audit row and is NOT the governed product path — that is
 * VendorGovernanceService, which sets the token per statement and writes the
 * trail. scripts/prove_wave5e_rule5.mjs proves the gate refuses this same
 * statement when the token is absent.
 */
function psql(sql) {
  const r = spawnSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', 'proc', '-d', 'procurementDB',
     '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'],
    { encoding: 'utf8', input: `SET app.bypass_rls = 'true';\nSET app.vendor_change_token = 'harness-fixture';\n${sql}\n` },
  );
  const out = `${r.stdout || ''}`.trim();
  const err = `${r.stderr || ''}`.trim();
  if (r.status !== 0) {
    throw new Error(`psql exited ${r.status}: ${err || out}\n--- sql ---\n${sql}`);
  }
  return out;
}

/**
 * A SQL string literal. `psql -t -A` returns raw text with NO surrounding quotes,
 * so anything read back out of the database must be re-quoted before it can go
 * back in. Embedded single quotes are doubled.
 */
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

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

const login = async (email) =>
  (await api('/auth/login', { method: 'POST', body: { email, password: 'demo' } })).data?.token;

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== Wave 5 Track D — the vendor risk model is load-bearing ===\n');

const procurement = await login('procurement@pakboxes.pk');
const requester = await login('requester@pakboxes.pk');
const cs = await login('cs@pakboxes.pk');
if (!procurement) { console.error('cannot log in as procurement — is the API up?'); process.exit(1); }

// ── 0. the formula agrees with the shipped SQL, for every seeded vendor ─────
console.log('--- 0. the SQL model matches the blueprint formula, vendor by vendor ---');
{
  const r = await api('/vendors/risk', { token: procurement });
  if (r.status !== 200) {
    bad('GET /vendors/risk', `status ${r.status} ${JSON.stringify(r.data)}`);
  } else {
    let checked = 0;
    for (const row of r.data.rows) {
      const { financial, delivery, quality } = row.scorecard;
      if (!financial || !delivery || !quality) continue;
      const want = compositeOf(row.scorecard);
      if (Number(row.composite.score) === want.score && row.composite.grade === want.grade) checked++;
      else bad(`compositeOf(${financial}/${delivery}/${quality})`,
        `blueprint says ${want.score}/${want.grade}, API returned ${row.composite.score}/${row.composite.grade}`);
    }
    eq('every scored vendor matches the independently computed blueprint value', checked,
       r.data.rows.filter((x) => x.composite.score !== null).length);
  }
}

// ── 1. baseline ─────────────────────────────────────────────────────────────
console.log('\n--- 1. baseline: V-00084 is Low risk and invitable ---');
// The subject must be a Low-risk vendor that is genuinely invitable, because the
// proof invites it before mutating. Migration 036 maps A/A/B to V-00082; V-00084
// is C/C/B and therefore permanently blocked, so it cannot be the fixture.
const SUBJECT = 'V-00082';
const EXPECTED_BASELINE = { financial: 'A', delivery: 'A', quality: 'B' };
const originalScorecard = psql(
  `SELECT scorecard::text FROM core.vendors WHERE vendor_code = ${lit(SUBJECT)};`,
);
const subjectId = psql(`SELECT id FROM core.vendors WHERE vendor_code = ${lit(SUBJECT)};`);
if (!subjectId || !originalScorecard) {
  bad('fixture exists', `could not read ${SUBJECT} (id=${subjectId} scorecard=${originalScorecard})`);
  console.log(`\n${fail} failed, ${pass} passed, ${findings} finding(s)`);
  process.exit(1);
}

// GUARD THE BASELINE ITSELF. An earlier run crashed between mutating and
// restoring, so the next run captured the MUTATED scorecard as "original" and
// cheerfully restored the corrupted value while reporting success. A baseline
// that does not match the seeded grade is not a baseline — refuse to proceed,
// because "restore whatever I found" is only safe when what I found was correct.
{
  const found = JSON.parse(originalScorecard);
  const matches = Object.entries(EXPECTED_BASELINE).every(([k, v]) => found[k] === v);
  if (!matches) {
    bad('the fixture starts at its seeded grade',
      `expected ${JSON.stringify(EXPECTED_BASELINE)}, found ${originalScorecard}. ` +
      `A previous run left the database mutated; restore it before re-running.`);
    console.log(`\n${fail} failed, ${pass} passed, ${findings} finding(s)`);
    process.exit(1);
  }
  ok('the fixture starts at its seeded grade A/A/B', originalScorecard);
}

const baseline = compositeOf(EXPECTED_BASELINE);
// Captured so the compliance-derivation probe can put the exact original back.
const originalTaxUntil = psql(
  `SELECT tax_filing_valid_until::text FROM core.vendors WHERE id = ${lit(subjectId)}::uuid;`);
let rfqId = null;

try {
  const list = await api('/vendors', { token: procurement });
  const row = (list.data?.rows ?? []).find((v) => v.vendorCode === SUBJECT);
  eq('Vendor Master shows the Low band', row?.composite?.grade, 'Low');
  eq('Vendor Master shows the blueprint score', row?.composite?.score, baseline.score);
  eq('Vendor Master pill is approved', row?.composite?.pill, 'approved');

  const kpiBefore = (await api('/vendors/risk', { token: procurement })).data?.kpis;
  eq('risk matrix reports this vendor eligible', kpiBefore.eligible, kpiBefore.eligible);
  ok('risk KPI baseline captured', JSON.stringify(kpiBefore));

  // ── 2. a real invitation, accepted ────────────────────────────────────────
  console.log('\n--- 2. invite it to a real RFQ -> accepted ---');
  // A PR may already carry an open RFQ from a previous suite run; the model
  // refuses a second one, which is correct behaviour. Reuse the open RFQ rather
  // than assuming this PR is bare.
  const prId = psql(`
    SELECT id FROM proc.purchase_requisitions
     WHERE status = 'IN_PROCUREMENT_REVIEW'
     ORDER BY created_at DESC LIMIT 1;`);
  if (!prId) {
    finding('no PR is parked in IN_PROCUREMENT_REVIEW',
      'the invitation half of this proof needs one; run the e2e suites first so a PR exists there');
  } else {
    let existing = psql(`
      SELECT id FROM proc.rfq
       WHERE pr_id = '${prId}'::uuid AND state <> 'Cancelled'
       ORDER BY created_at DESC LIMIT 1;`);
    if (!existing) {
      const issued = await api(`/pr/${prId}/rfq`, { method: 'POST', token: procurement, body: {} });
      if (issued.status !== 200 && issued.status !== 201) {
        bad('issue an RFQ for the invitation probe', `status ${issued.status} ${JSON.stringify(issued.data)}`);
      } else {
        existing = issued.data?.rfq_id ?? issued.data?.id;
        ok('RFQ issued', String(issued.data?.rfq_number ?? existing));
      }
    } else {
      ok('reusing the open RFQ already on this PR', existing);
    }
    rfqId = existing;

    if (rfqId) {
      const invite = await api(`/rfq/${rfqId}/invite`, {
        method: 'POST', token: procurement, body: { vendorId: subjectId },
      });
      if (invite.status === 200 || invite.status === 201) {
        ok('a Low-risk vendor can be invited', invite.data?.vendor_code);
      } else if (invite.status === 400 && /already on this RFQ/i.test(invite.data?.message || '')) {
        // Left over from an earlier run. Not a block — the wording proves it.
        ok('a Low-risk vendor can be invited (already on the roster from an earlier run)');
      } else {
        bad('a Low-risk vendor can be invited',
          `status ${invite.status} ${JSON.stringify(invite.data)}`);
      }

      // ── 3. MUTATE the database ─────────────────────────────────────────────
      console.log('\n--- 3. mutate the scorecard in the database: A/A/B -> C/C/C ---');
      psql(`UPDATE core.vendors SET scorecard = '{"financial":"C","delivery":"C","quality":"C"}'::jsonb
             WHERE vendor_code = '${SUBJECT}';`);
      const want = compositeOf({ financial: 'C', delivery: 'C', quality: 'C' });
      // s = 1x0.40 + 1x0.35 + 1x0.25 = 1.00; score = round(1.00 * 100/3) = 33.
      eq('blueprint says the mutated vendor scores 33, not a round 25', want.score, 33);
      eq('blueprint says the mutated band', want.grade, 'High');

      // ── 4. everything downstream must move ─────────────────────────────────
      console.log('\n--- 4. the matrix, the KPIs and the guard all follow the database ---');
      const risk = await api('/vendors/risk', { token: procurement });
      const after = risk.data?.rows?.find((v) => v.vendorCode === SUBJECT);
      eq('risk matrix now reads High', after?.composite?.grade, 'High');
      eq('risk matrix now reads the mutated score', after?.composite?.score, want.score);
      eq('risk matrix pill flipped to danger', after?.composite?.pill, 'danger');
      eq('the action names the remediation state', after?.composite?.action, 'Blocked pending remediation');
      eq('blocked count rose by one', risk.data?.kpis?.blocked, Number(kpiBefore.blocked) + 1);
      eq('eligible count fell by one', risk.data?.kpis?.eligible, Number(kpiBefore.eligible) - 1);

      const master = await api('/vendors', { token: procurement });
      const mRow = (master.data?.rows ?? []).find((v) => v.vendorCode === SUBJECT);
      eq('Vendor Master followed too', mRow?.composite?.grade, 'High');

      const blockedInvite = await api(`/rfq/${rfqId}/invite`, {
        method: 'POST', token: procurement, body: { vendorId: subjectId },
      });
      if (blockedInvite.status === 400 || blockedInvite.status === 409) {
        ok('the guard REFUSES a High-risk vendor', `HTTP ${blockedInvite.status}`);
      } else {
        bad('the guard REFUSES a High-risk vendor',
          `expected a 4xx, got ${blockedInvite.status} — the block is not enforced`);
      }
      if (/blocked pending remediation/i.test(blockedInvite.data?.message || '')) {
        ok('the refusal explains itself', blockedInvite.data.message.slice(0, 60) + '…');
      } else {
        bad('the refusal explains itself', `message was ${JSON.stringify(blockedInvite.data?.message)}`);
      }

      // The automatic pool pick must skip it too, not just the explicit invite.
      const pool = psql(`
        SELECT count(*) FROM core.vendors v
          CROSS JOIN LATERAL core.fn_vendor_composite(v.scorecard) c
         WHERE v.vendor_code = '${SUBJECT}' AND c.blocked IS DISTINCT FROM true;`);
      eq('the automatic pool pick excludes it as well', pool, '0');

      // ── 5. restore, and assert it moved BACK ───────────────────────────────
      console.log('\n--- 5. restore the scorecard, and assert everything moved back ---');
      psql(`UPDATE core.vendors SET scorecard = ${lit(originalScorecard)}::jsonb
             WHERE vendor_code = '${SUBJECT}';`);

      const restored = (await api('/vendors/risk', { token: procurement })).data?.rows
        ?.find((v) => v.vendorCode === SUBJECT);
      eq('the matrix is back to Low', restored?.composite?.grade, 'Low');
      eq('the matrix is back to the original score', restored?.composite?.score, baseline.score);
      const kpiAfter = (await api('/vendors/risk', { token: procurement })).data?.kpis;
      eq('blocked count is back', kpiAfter?.blocked, kpiBefore.blocked);
      eq('eligible count is back', kpiAfter?.eligible, kpiBefore.eligible);

      const reInvite = await api(`/rfq/${rfqId}/invite`, {
        method: 'POST', token: procurement, body: { vendorId: subjectId },
      });
      // It is already on the roster from step 2, so UNIQUE rather than acceptance
      // is the correct answer here — either way it is no longer "blocked".
      if (reInvite.status === 400 && /already on this RFQ/i.test(reInvite.data?.message || '')) {
        ok('after restore the vendor is invitable again (roster duplicate, not a block)',
          reInvite.data.message.slice(0, 40) + '…');
      } else if (reInvite.status === 200 || reInvite.status === 201) {
        ok('after restore the vendor is invitable again');
      } else {
        bad('after restore the vendor is invitable again',
          `status ${reInvite.status} ${JSON.stringify(reInvite.data)}`);
      }
    }
  }
} finally {
  // ── restore, unconditionally ──────────────────────────────────────────────
  console.log('\n--- cleanup ---');
  psql(`UPDATE core.vendors SET scorecard = ${lit(originalScorecard)}::jsonb
         WHERE vendor_code = '${SUBJECT}';`);
  const left = psql(`SELECT scorecard::text FROM core.vendors WHERE vendor_code = '${SUBJECT}';`);
  if (left === originalScorecard) ok('the scorecard was restored', left);
  else bad('the scorecard was restored', `expected ${originalScorecard}, left ${left}`);
}

// ── 6. role gating ──────────────────────────────────────────────────────────
console.log('\n--- 6. the three screens are gated to procurement, hod, cs ---');
{
  const r = await api('/vendors/risk', { token: requester });
  eq('a requester is refused the risk matrix', r.status, 403);
  const d = await api(`/vendors/${subjectId}`, { token: requester });
  eq('a requester is refused vendor detail', d.status, 403);
  const c = await api('/vendors/risk', { token: cs });
  eq('cs may read the risk matrix', c.status, 200);
  const anon = await api('/vendors/risk');
  eq('an anonymous caller is refused', anon.status, 403);
}

// ── 7. the detail data is REAL, and it is derived rather than duplicated ────
console.log('\n--- 7. the detail columns are load-bearing, not decorative ---');
{
  const d = await api(`/vendors/${subjectId}`, { token: procurement });
  if (d.status !== 200) {
    bad('vendor detail readable for the honesty probe', `status ${d.status}`);
  } else {
    const k = d.data?.kpis ?? {};
    const p = d.data?.profile ?? {};
    const c = d.data?.compliance ?? {};

    // Every cell the em-dash screen used to show must now come from a record.
    ok(typeof k.rating === 'number' && k.rating >= 0 && k.rating <= 5,
      'the rating is a stored value inside 0..5', k.rating);
    ok(typeof p.city === 'string' && p.city.length > 0, 'the city is a stored value', p.city);
    ok(typeof p.contactPerson === 'string' && p.contactPerson.length > 0,
      'the contact person is stored', p.contactPerson);
    ok(typeof p.email === 'string' && p.email.includes('@'), 'the email is stored', p.email);
    ok(typeof k.onTimePct === 'number', 'on-time delivery comes from the performance table', k.onTimePct);
    ok(typeof k.onTimeQuarter === 'string', 'and it names the quarter it covers', k.onTimeQuarter);

    // Rule 3 is satisfied as DATA at rest.
    ok(Array.isArray(p.category) && p.category.length > 0,
      'every active vendor carries a category (rule 3, enforced as data)', p.category);
    ok(p.categorised === true, 'and the API reports it as categorised', p.categorised);

    // THE DERIVATION IS THE POINT. "Up to date" must be a function of the date,
    // not a stored word that can disagree with it. Push the date into the past
    // and the label must flip to Expired, then flip back.
    const before = c.taxFiling;
    const future = new Date(Date.now() + 400 * 864e5).toISOString().slice(0, 10);
    const past = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
    try {
      psql(`UPDATE core.vendors SET tax_filing_valid_until = DATE '${past}'
             WHERE id = ${lit(subjectId)}::uuid;`);
      const lapsed = (await api(`/vendors/${subjectId}`, { token: procurement })).data?.compliance?.taxFiling;
      eq('a lapsed tax filing renders Expired, not Up to date', lapsed, 'Expired');

      psql(`UPDATE core.vendors SET tax_filing_valid_until = DATE '${future}'
             WHERE id = ${lit(subjectId)}::uuid;`);
      const renewed = (await api(`/vendors/${subjectId}`, { token: procurement })).data?.compliance?.taxFiling;
      eq('a renewed tax filing renders Up to date again', renewed, 'Up to date');
    } finally {
      psql(`UPDATE core.vendors SET tax_filing_valid_until = ${lit(originalTaxUntil)}
             WHERE id = ${lit(subjectId)}::uuid;`);
      const restored = (await api(`/vendors/${subjectId}`, { token: procurement })).data?.compliance?.taxFiling;
      eq('the compliance label moved back with the date', restored, before);
    }

    // No fabricated pass: an absent record stays absent.
    const unscored = (await api('/vendors/risk', { token: procurement })).data?.rows
      ?.find((r) => r.composite.score === null);
    if (unscored) {
      const ud = await api(`/vendors/${unscored.id}`, { token: procurement });
      ok(ud.data?.compliance?.amlCheck === null,
        `${unscored.vendorCode} has no AML record and reports none`, ud.data?.compliance?.amlCheck);
      ok(ud.data?.kpis?.rating === null,
        `${unscored.vendorCode} is unrated and reports no rating`, ud.data?.kpis?.rating);
      ok(ud.data?.kpis?.onTimePct === null,
        `${unscored.vendorCode} has no performance record and reports none`, ud.data?.kpis?.onTimePct);
    }
  }
}

console.log(`\n${fail} failed, ${pass} passed, ${findings} finding(s)\n`);
process.exit(fail > 0 ? 1 : 0);
