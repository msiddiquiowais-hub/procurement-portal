// Wave 5 Track D — the three vendor screens ship, are nav-wired, and say nothing
// the prototype merely made up.
//
//   node scripts/e2e_wave5d_vendor_web.mjs
//
// Requires: the web on 33002 (production `next start`) and the API on 33001.
//
// WHAT THIS PROVES
//   1. All three routes return 200 and ship a page chunk of their own.
//   2. Each chunk carries the BLUEPRINT's own strings — the column headers, the
//      KPI labels, the matrix headings. A screen that renders but says nothing
//      the prototype said is not a port.
//   3. The prototype's placeholders reach NEITHER the shipped chunks NOR any API
//      payload. V-000123 / PakBoxes / "★ 4.7" are the prototype's invented
//      vendor; the port must show the six real seeded vendors instead.
//   4. The nav entries are routed and no longer badged as un-ported.
//
// Chunk names come from .next/build-manifest.json, never hardcoded: an
// un-hashed `/chunks/pages/vendors.js` exists only under `next dev`, so against
// `next start` every such assertion 404s while the page still returns 200 — a
// naming difference that reads as "these screens are missing".

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WEB = process.env.WEB_BASE || 'http://127.0.0.1:33002';
const API = process.env.API_BASE || 'http://127.0.0.1:33001';

let pass = 0, fail = 0, findings = 0;
const ok = (c, label, extra) => {
  if (c) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra !== undefined ? `  -> ${JSON.stringify(extra)}` : ''}`); }
};
const finding = (label, detail) => { findings++; console.log(`  FINDING  ${label}\n            ${detail}`); };

const chunkUrl = (f) => `/_next/${f.split('/').map(encodeURIComponent).join('/')}`;
const ownChunk = (files) => files.find((f) => f.includes('/chunks/pages/')) || null;

const MANIFEST_PATH = fileURLToPath(new URL('../apps/web/.next/build-manifest.json', import.meta.url));
let manifest;
try {
  const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  // The page routes live under a `pages` key; the top level holds only the shared
  // bundles (polyfillFiles, rootMainFiles, ...). Reading the top level would find
  // zero page keys and every screen would read as missing.
  manifest = raw.pages ?? raw;
} catch (e) {
  console.log(`  FAIL  the production build manifest is readable (${MANIFEST_PATH})\n        ${e.message}`);
  console.log('\n0 passed, 1 failed\n');
  process.exit(1);
}

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
console.log('\n==== Wave 5 Track D · vendor screens against', WEB, '====\n');

console.log('==== 0 · preflight ===================================================');
{
  const r = await fetch(`${WEB}/`);
  ok(r.status === 200, 'web reachable', r.status);
  const token = await login('procurement@pakboxes.pk');
  ok(Boolean(token), 'procurement authenticated');
  ok(Object.keys(manifest).length > 0, 'the production build manifest is readable',
    `${Object.keys(manifest).length} page keys`);
}

// The three routes, and the copy the blueprint gives each one.
const SCREENS = [
  {
    id: 'vendors',
    route: '/vendors',
    pageKey: '/vendors',
    title: 'Vendor Master',
    copy: ['Vendor ID', 'Name', 'Category', 'City', 'Rating', 'POs', 'Spend', 'Risk',
           'Total vendors', 'Low risk', 'Medium risk', 'High risk',
           'Pre-approved', 'Monitor quarterly'],
  },
  {
    id: 'vendor-risk',
    route: '/vendor-risk',
    pageKey: '/vendor-risk',
    title: 'Vendor Risk Review',
    copy: ['Financial', 'Delivery', 'Quality', 'Weighted score', 'Composite', 'Action',
           'Eligible for RFQ', 'Blocked', 'Avg composite'],
  },
  {
    id: 'vendor-detail',
    route: '/vendors',
    // The nav entry lands on the list (a detail screen needs an id); the screen
    // itself is the dynamic route.
    pageKey: '/vendor/[id]',
    title: 'Vendor Detail',
    copy: ['Profile', 'Compliance', 'Risk breakdown', 'Vendor ID', 'NTN', 'Category',
           'City', 'Active since', 'Contact person', 'Email', 'Rating',
           'Tax filing', 'Bank account', 'Insurance', 'AML check', 'Sanctions screening',
           'Last audit', 'Next review', 'Dimension', 'Grade', 'Basis', 'Open risk review'],
  },
];

console.log('\n==== 1 · the three routes serve, and ship a chunk of their own =====');
const chunkText = {};
for (const s of SCREENS) {
  const r = await fetch(`${WEB}${s.route}`);
  ok(r.status === 200, `${s.id} ${s.route} serves`, r.status);
  const body = await r.text();
  ok(body.includes('<!DOCTYPE html>') || body.includes('<html'),
    `${s.id} returns a Next.js document`);

  const files = manifest[s.pageKey] ?? [];
  const own = ownChunk(files);
  if (!own) {
    // The page is missing from the build entirely. Say so plainly rather than
    // falling through to chunk assertions that would fail for a different reason.
    ok(false, `${s.id} ("${s.pageKey}") is in the production build`,
      `manifest keys near it: ${Object.keys(manifest).filter((k) => /vendor/i.test(k)).join(', ') || 'none'}`);
    continue;
  }
  ok(true, `${s.id} ("${s.pageKey}") is in the production build`, own);
  const res = await fetch(`${WEB}${chunkUrl(own)}`);
  ok(res.status === 200, `${s.id} serves its own compiled page chunk`, res.status);
  chunkText[s.id] = await res.text();
  ok(chunkText[s.id].length > 500, `${s.id} chunk is a real module`, `${chunkText[s.id].length} bytes`);
}

console.log('\n==== 2 · the prototype\'s own copy survives the port ================');
for (const s of SCREENS) {
  const text = chunkText[s.id] ?? '';
  for (const phrase of s.copy) {
    ok(text.includes(phrase), `${s.id} carries "${phrase}"`);
  }
}

console.log('\n==== 3 · the prototype\'s invented vendor reaches no screen ========');
// These are the prototype's placeholder identities. The Wave 4 suites already
// refuse "V-000123" and "PakBoxes Pvt Ltd" in supplier screens; the vendor
// screens must be equally clean, or the fiction leaks back in.
const FORBIDDEN = ['V-000123', 'PakBoxes', '4.7 out of 5', '★ 4.7', '2180000'];
for (const s of SCREENS) {
  const text = chunkText[s.id] ?? '';
  for (const needle of FORBIDDEN) {
    ok(!text.includes(needle), `${s.id} chunk contains no "${needle}"`);
  }
}

console.log('\n==== 4 · no API payload carries a prototype placeholder ===========');
{
  const procurement = await login('procurement@pakboxes.pk');
  const list = await api('/vendors', { token: procurement });
  const payloads = [list, await api('/vendors/risk', { token: procurement })];
  const first = list.data?.rows?.[0];
  if (first) payloads.push(await api(`/vendors/${first.id}`, { token: procurement }));

  for (const p of payloads) {
    const text = JSON.stringify(p.data ?? {});
    for (const needle of FORBIDDEN) {
      ok(!text.includes(needle), `no API payload contains "${needle}"`);
    }
  }
}

console.log('\n==== 5 · the sidebar wiring =========================================');
{
  const shell = readFileSync(fileURLToPath(new URL('../apps/web/components/Shell.tsx', import.meta.url)), 'utf8');
  // A route key can appear in a COMMENT explaining why it was added, so assert on
  // the ROUTES/PENDING ASSIGNMENTS, not on the bare identifier.
  const routesBlock = shell.slice(shell.indexOf('const ROUTES'), shell.indexOf('const PENDING'));
  const pendingBlock = shell.slice(shell.indexOf('const PENDING'), shell.indexOf('function NavRow'));

  // Line-based rather than a built RegExp: an assembled pattern with embedded
  // quotes is opaque, and a wrong-but-plausible regex reports a wiring problem
  // that does not exist.
  const declaresKey = (block, id) =>
    block.split('\n').some((l) => {
      const t = l.trim();
      return t.startsWith(`${id}:`) || t.startsWith(`'${id}':`) || t.startsWith(`"${id}":`);
    });

  for (const s of SCREENS) {
    ok(declaresKey(routesBlock, s.id), `${s.id} has a live route in ROUTES`);
    ok(!declaresKey(pendingBlock, s.id), `${s.id} is no longer listed in PENDING`);
  }

  // vendor-detail needs an id, so its nav entry must land on the list.
  ok(routesBlock.split('\n').some((l) => l.trim() === "'vendor-detail': '/vendors',"),
    'vendor-detail lands on the list, as pr-review and rfq-detail do');
  ok(pendingBlock.includes('kpi') && pendingBlock.includes('audit'),
    'genuinely un-ported items are still badged with their wave');
  ok(!pendingBlock.includes('vendors') && !pendingBlock.includes('vendor-risk'),
    'the vendor trio left the pending list entirely');
}

console.log('\n==== 6 · the model the screens render =================================');
{
  const procurement = await login('procurement@pakboxes.pk');
  const risk = await api('/vendors/risk', { token: procurement });
  ok(risk.status === 200, 'GET /vendors/risk answers', risk.status);
  const k = risk.data?.kpis;
  ok(k && k.eligible + k.blocked + k.unrated === risk.data.rows.length,
    'every vendor is in exactly one of eligible / blocked / unrated',
    `${k?.eligible}+${k?.blocked}+${k?.unrated} vs ${risk.data?.rows?.length}`);
  ok(k && k.blocked > 0, 'at least one vendor is genuinely blocked', k?.blocked);
  ok(k && k.eligible > 0, 'at least one vendor is eligible', k?.eligible);
  ok(k && k.scored === risk.data.rows.filter((x) => x.composite.score !== null).length,
    'the average is taken over scored vendors only');

  for (const row of risk.data?.rows ?? []) {
    if (row.composite.score === null) {
      ok(row.composite.action === 'Not yet risk-assessed',
        `${row.vendorCode} is unscored rather than treated as eligible`,
        row.composite.action);
    } else {
      const inRange = row.composite.score >= 0 && row.composite.score <= 100;
      ok(inRange, `${row.vendorCode} score is inside 0..100`, row.composite.score);
      ok(typeof row.composite.action === 'string' && row.composite.action.length > 0,
        `${row.vendorCode} carries an action`, row.composite.action);
    }
  }

  // The blueprint's action strings, asserted where they actually live: the API's
  // risk-action map, not the page chunk. A screen that rendered its own copy of
  // these words would be a second source of truth.
  const actions = new Set((risk.data?.rows ?? []).map((r) => r.composite.action));
  const EXPECTED_ACTIONS = [
    'Eligible for RFQ',            // Low
    'Eligible — monitored',        // Medium
    'Blocked pending remediation', // High
    'Not yet risk-assessed',       // unscored
  ];
  for (const a of EXPECTED_ACTIONS) {
    ok(actions.has(a), `the API emits the action "${a}"`, [...actions].join(' | '));
  }
}

console.log('\n==== 7 · the detail columns reached the screens ======================');
{
  const procurement = await login('procurement@pakboxes.pk');
  const list = await api('/vendors', { token: procurement });
  const scored = (list.data?.rows ?? []).find((v) => v.rating !== null);

  // The chunk must ship the wording that replaced the old dashes.
  const detailChunk = chunkText['vendor-detail'] ?? '';
  ok(detailChunk.includes('Not recorded'),
    'vendor-detail still renders "Not recorded" for a genuinely absent fact');
  ok(detailChunk.includes('★'),
    'vendor-detail renders a star rating now that a rating column exists');

  const masterChunk = chunkText['vendors'] ?? '';
  ok(masterChunk.includes('Excluded from automatic RFQs'),
    'the master states the rule-4 consequence of a missing category');

  // And the API must actually be serving the values, not just the labels.
  ok(scored, 'at least one vendor has a stored rating', (list.data?.rows ?? []).map((v) => v.vendorCode).join(', '));
  if (scored) {
    ok(typeof scored.city === 'string' && scored.city.length > 0, `${scored.vendorCode} carries a city`, scored.city);
    ok(Array.isArray(scored.category) && scored.category.length > 0,
      `${scored.vendorCode} carries a category`, scored.category);
    ok(scored.categorised === true, `${scored.vendorCode} reports itself categorised`);

    const d = await api(`/vendors/${scored.id}`, { token: procurement });
    ok(d.status === 200, `${scored.vendorCode} detail answers`, d.status);
    ok(d.data?.kpis?.rating === scored.rating,
      'the detail screen and the list agree on the rating', `${d.data?.kpis?.rating} vs ${scored.rating}`);
    ok(d.data?.kpis?.onTimeQuarter, 'the on-time figure names its quarter', d.data?.kpis?.onTimeQuarter);
    ok(d.data?.compliance?.checksRecorded > 0,
      'the compliance card counts the checks that are actually recorded', d.data?.compliance?.checksRecorded);

    // Every rendered compliance cell must be one of the values the derivation can
    // produce. A screen inventing a label would slip past a "not null" check.
    const ALLOWED = new Set(['Up to date', 'Expired', 'Verified', 'Not verified', 'Valid', 'Clear', 'Adverse', 'Match', 'Pending review', 'Not recorded']);
    for (const k of ['taxFiling', 'bankAccount', 'insurance', 'amlCheck', 'sanctionsScreening']) {
      const v = d.data?.compliance?.[k];
      ok(v === null || ALLOWED.has(String(v)), `compliance.${k} is a derived value, not invented`, v);
    }
  }

  // Rule 3 must be satisfied across the whole seeded estate, not just one vendor.
  const uncategorised = (list.data?.rows ?? []).filter((v) => !v.categorised);
  ok(uncategorised.length === 0,
    'no visible vendor is missing a category, so the RFQ gate excludes nobody at rest',
    uncategorised.map((v) => v.vendorCode).join(', '));
  ok(list.data?.kpis?.uncategorised === 0,
    'and the KPI agrees with the rows', list.data?.kpis?.uncategorised);
}

console.log(`\n==== ${fail} · summary =================================================`);
console.log(`  ${pass} passed, ${fail} failed, ${findings} finding(s)`);
if (findings) console.log('\n  Findings are characterised gaps, not broken assertions.');
console.log('');
process.exit(fail > 0 ? 1 : 0);
