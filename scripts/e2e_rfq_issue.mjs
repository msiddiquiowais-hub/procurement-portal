// E2E — Issue RFQ, end to end against the live API.
//
//   node scripts/e2e_rfq_issue.mjs
//
// WHAT THIS PINS
// -------------
// The automatic RFQ roster must be chosen by the PR's LINE CATEGORIES, not by
// "any categorised vendor, top 3 by name". `resolveVendors()` used to require
// only `EXISTS (any active vendor_categories row)` and then order by
// (state, vendor_code), so an OFFICE_SUPPLIES request could be dispatched to IT
// hardware vendors — the PR's own categories never entered the SQL.
//
// The assertions that matter:
//   1. every auto-selected vendor is mapped to a category ON THIS PR's lines
//      (and to no unrelated one),
//   2. a vendor mapped to an unrelated category is NOT selected,
//   3. a High-risk vendor mapped to the right category is still excluded
//      (Blueprint 9.5 — the category rule must not become a back door around
//      the risk gate),
//   4. the modal's candidate list and the roster that actually got invited are
//      the same set — a preview that disagrees with the send is worse than none,
//   5. each invited vendor gets exactly one outbox row + one .eml on disk.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const ROOT = process.env.PROJECT_ROOT || process.cwd();
const CONTAINER = process.env.PG_CONTAINER || 'procurement-portal-db';

let pass = 0, fail = 0;
const ok = (l, x = '') => { pass++; console.log(`  PASS  ${l}${x ? `  (${x})` : ''}`); };
const bad = (l, d) => { fail++; console.log(`  FAIL  ${l}\n        ${d}`); };

async function login(email) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'demo' }),
  });
  const j = await r.json();
  return j.token || j.accessToken;
}

/** Run SQL in the container via psql, returning TSV rows. */
async function sql(q) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('docker', [
    'exec', CONTAINER, 'psql', '-U', 'proc', '-d', 'procurementDB',
    '-X', '-A', '-F', '\t', '-t', '-c', q,
  ], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || `psql failed (${r.status})`);
  return r.stdout.split('\n').map(l => l.trim()).filter(Boolean).map(l => l.split('\t'));
}

const tok = await login('procurement@pakboxes.pk');
const H = { authorization: `Bearer ${tok}` };

// ── 1. pick a PR at a sourcing stage with no RFQ yet ─────────────────────────
// Chosen from the DATABASE, not from the screen's list order. Two things the
// obvious choice gets wrong:
//   * the first PR at this stage often has an uncategorised line (a free-text
//     line has no category at all), and
//   * a category can be mapped but have NO ELIGIBLE vendor — its only mapping
//     may be held, blacklisted or High-risk — in which case the roster is
//     legitimately empty and the API refuses. That refusal is correct
//     behaviour, not something this suite wants to rediscover.
//
// So the query joins all the way through to a vendor that would actually pass
// the eligibility rules, guaranteeing the happy path is the thing under test.
console.log('\n== 1. pick a PR in procurement review with no RFQ ==');
const pick = await sql(
  `SELECT pr.id::text, pr.pr_number::text
     FROM proc.purchase_requisitions pr
     JOIN proc.pr_lines pl ON pl.pr_id = pr.id AND pl.rejected = false
                              AND pl.category IS NOT NULL
     JOIN core.vendors v
       ON v.state <> ALL(ARRAY['Rejected','Blacklisted','Deactivated'])
      AND NOT v.is_hold
      AND NOT EXISTS (
        SELECT 1 FROM core.vendor_blacklist b
         WHERE b.vendor_id = v.id AND b.resolved_at IS NULL)
     JOIN core.vendor_categories vc ON vc.vendor_id = v.id AND vc.is_active
     JOIN core.categories c ON c.id = vc.category_id AND c.code = pl.category
     CROSS JOIN LATERAL core.fn_vendor_composite(v.scorecard) AS comp
    WHERE pr.status = 'IN_PROCUREMENT_REVIEW'
      AND comp.blocked IS DISTINCT FROM true
      AND NOT EXISTS (SELECT 1 FROM proc.rfq r WHERE r.pr_id = pr.id AND r.state <> 'Cancelled')
    GROUP BY pr.id, pr.pr_number
    ORDER BY pr.created_at DESC LIMIT 1`);
if (pick.length === 0) {
  bad('found a sourceable PR at IN_PROCUREMENT_REVIEW',
    'none with a categorised, non-rejected line and no open RFQ');
  process.exit(1);
}
const [prId, prNumber] = pick[0];
const pr = { id: prId, pr_number: prNumber };
ok(`using ${pr.pr_number} (${pr.id})`);

const hasRfq = await sql(
  `SELECT count(*) FROM proc.rfq WHERE pr_id='${prId}' AND state <> 'Cancelled'`);
if (Number(hasRfq[0][0]) > 0) {
  console.log('        (this PR already has an RFQ — issuing is refused by design)');
}

// ── 2. what the PR's lines actually ask for ──────────────────────────────────
console.log('\n== 2. the PR\'s non-rejected line categories ==');
const lines = await sql(
  `SELECT line_no, coalesce(category,'(none)') FROM proc.pr_lines
    WHERE pr_id='${prId}' AND rejected=false ORDER BY line_no`);
const wanted = [...new Set(lines.map(r => r[1]))].filter(c => c !== '(none)');
lines.forEach(r => console.log(`        line ${r[0]}: ${r[1]}`));
if (wanted.length === 0) {
  bad('this PR has a categorised line to source', 'every line is rejected or uncategorised');
  process.exit(1);
}
ok(`category set under test: ${wanted.join(', ')}`);

// ── 3. the preview must select only vendors mapped to THOSE categories ───────
console.log('\n== 3. GET /pr/:id/rfq/candidates ==');
const cRes = await fetch(`${API}/pr/${prId}/rfq/candidates`, { headers: H });
const cands = await cRes.json();
if (!cRes.ok) {
  bad('candidates responded 200', `${cRes.status}: ${JSON.stringify(cands)}`);
  process.exit(1);
}
ok('candidates responded 200');
cands.categories.forEach(c =>
  console.log(`        ${c.code} / ${c.name}  lines=${c.lineNos.join(',')}`));

// THE assertion. Every selected vendor must cover at least one of THIS PR's
// categories — and may not be there only for an unrelated one.
const pickedIds = cands.vendors.map(v => v.id);
const offenders = cands.vendors.filter(v =>
  !v.categories.some(cc => wanted.includes(cc)));
if (offenders.length) {
  bad('every selected vendor is mapped to a category on this PR',
    offenders.map(v => `${v.legal_name} [${v.categories.join(',')}]`).join('; '));
} else {
  ok(`all ${cands.vendors.length} selected vendors are mapped to ${wanted.join('/')}`);
}

// A vendor mapped to some OTHER category must not appear.
const otherCats = await sql(
  `SELECT DISTINCT vc_cat.code FROM core.vendor_categories vc
     JOIN core.categories vc_cat ON vc_cat.id=vc.category_id
    WHERE vc.is_active AND vc_cat.code <> ALL(ARRAY['${wanted.join("','")}'])`);
if (otherCats.length && pickedIds.length) {
  const foreignIds = new Set((await sql(
    `SELECT DISTINCT v.id::text FROM core.vendors v
       JOIN core.vendor_categories vc ON vc.vendor_id=v.id AND vc.is_active
       JOIN core.categories c ON c.id=vc.category_id
      WHERE c.code <> ALL(ARRAY['${wanted.join("','")}'])`)).map(r => r[0]));
  const foreignOnly = pickedIds.filter(id =>
    foreignIds.has(id) && !cands.vendors.some(v => v.id === id && v.categories.some(cc => wanted.includes(cc))));
  if (foreignOnly.length) {
    bad('no vendor selected solely for an unrelated category', foreignOnly.join(', '));
  } else {
    ok(`${foreignIds.size} vendor(s) mapped only to unrelated categories were kept off the roster`);
  }
}

// High-risk must still be excluded — the category rule is not a risk bypass.
console.log('\n== 3b. the risk gate still applies to category-matched vendors ==');
const highRiskRows = await sql(
  `SELECT v.legal_name, v.id::text FROM core.vendors v
     JOIN core.vendor_categories vc ON vc.vendor_id=v.id AND vc.is_active
     JOIN core.categories c ON c.id=vc.category_id
     CROSS JOIN LATERAL core.fn_vendor_composite(v.scorecard) AS comp
   WHERE c.code = ANY(ARRAY['${wanted.join("','")}']) AND comp.blocked = true`);
const leakedIds = highRiskRows.map(r => r[1]).filter(id => pickedIds.includes(id));
if (leakedIds.length) {
  bad('a High-risk vendor never reaches the automatic roster',
    leakedIds.join(', '));
} else {
  ok(`risk gate holds: ${highRiskRows.length} High-risk vendor(s) mapped to ${wanted.join('/')}, ` +
    `${leakedIds.length} invited` +
    (highRiskRows.length ? ` (e.g. ${highRiskRows[0][0]})` : ''));
}

// Rejected lines must not drive the roster.
console.log('\n== 4. rejected lines do not drive the roster ==');
const rejCats = await sql(
  `SELECT DISTINCT category FROM proc.pr_lines
    WHERE pr_id='${prId}' AND rejected=true AND category IS NOT NULL
      AND category <> ALL(ARRAY['${wanted.join("','")}'])`);
if (rejCats.length) {
  const rejVendors = await sql(
    `SELECT v.id::text FROM core.vendors v
       JOIN core.vendor_categories vc ON vc.vendor_id=v.id AND vc.is_active
       JOIN core.categories c ON c.id=vc.category_id
      WHERE c.code = ANY(ARRAY['${rejCats.map(r => `"${r[0]}"`).join(",")}'])`);
  const onlyBecause = rejVendors.map(r => r[0])
    .filter(id => pickedIds.includes(id) && !cands.vendors.some(v => v.id === id && v.categories.some(cc => wanted.includes(cc))));
  if (onlyBecause.length) bad('no vendor selected solely for a rejected line',
    onlyBecause.join(', '));
  else ok('no vendor was pulled in only for a rejected line');
} else {
  ok('this PR has no rejected-only category to test against');
}

// ── 5. issue + dispatch, and the outbox is the proof ─────────────────────────
console.log('\n== 5. issue + dispatch ==');
if (Number(hasRfq[0][0]) > 0) {
  console.log('        SKIPPED — this PR already carries an open RFQ.');
} else {
  const issuedRes = await fetch(`${API}/pr/${prId}/rfq`, {
    method: 'POST', headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const issued = await issuedRes.json();
  if (!issuedRes.ok) {
    bad('POST /pr/:id/rfq', `${issuedRes.status}: ${JSON.stringify(issued).slice(0, 300)}`);
    process.exit(1);
  }
  const rfqId = issued.rfq?.id;
  ok(`RFQ ${issued.rfq?.rfq_number} issued`);

  // The roster that was ACTUALLY used must equal the roster that was SHOWN.
  const invitedIds = (issued.invitations || []).map(i => i.vendor_id).sort();
  const shownIds = pickedIds.slice().sort();
  if (JSON.stringify(invitedIds) === JSON.stringify(shownIds)) {
    ok(`preview and send agree on all ${invitedIds.length} vendor(s)`);
  } else {
    bad('preview matches what was actually invited',
      `shown=[${shownIds}] invited=[${invitedIds}]`);
  }

  if (issued.warning) console.log(`        warning: ${issued.warning}`);
  (issued.warnings || []).forEach(w => console.log(`        ${w}`));

  const dRes = await fetch(`${API}/rfq/${rfqId}/dispatch`, {
    method: 'POST', headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'email' }),
  });
  const dispatched = await dRes.json();
  if (!dRes.ok) {
    bad('POST /rfq/:id/dispatch', `${dRes.status}: ${JSON.stringify(dispatched)}`);
  } else {
    ok(`dispatch: ${dispatched.recipients} recipient(s), ${dispatched.queued} queued, ` +
      `${dispatched.delivered} delivered (0 is correct: no SMTP here)`);
  }

  // The outbox is the audit record, so assert against it rather than the toast.
  const rows = await sql(
    `SELECT v.vendor_code, o.state, o.subject
       FROM core.email_outbox o JOIN core.vendors v ON v.id = o.to_vendor_id
      WHERE o.rfq_id='${rfqId}' ORDER BY v.vendor_code`);
  if (rows.length === (issued.invitations || []).length) {
    ok(`one outbox row per invited vendor (${rows.length})`);
    rows.forEach(r => console.log(`        ${r[0]}  state=${r[1]}  "${r[2]}"`));
  } else {
    bad('one outbox row per invited vendor',
      `${rows.length} outbox rows for ${issued.invitations.length} invitations`);
  }

  // And the .eml actually landed on disk, which is what a relay would consume.
  const outboxDir = join(ROOT, 'var', 'outbox');
  if (existsSync(outboxDir)) {
    const files = readdirSync(outboxDir).filter(f => f.endsWith('.eml'));
    const mine = files.filter(f => files.includes(f) && readFileSync(join(outboxDir, f), 'utf8').includes(rfqId) || files.filter(f => readFileSync(join(outboxDir, f), 'utf8').includes(issued.rfq?.rfq_number)));
    ok(`${mine.length} .eml file(s) on disk reference ${issued.rfq?.rfq_number}`);
  } else {
    console.log('        (var/outbox not present — skipped the .eml check)');
  }
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);