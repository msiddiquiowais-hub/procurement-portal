// Wave 5 Track C — the four admin screens render and are load-bearing.
//
//   node scripts/e2e_wave5_admin_web.mjs
//
// Requires: Postgres 55432, the API on 33001, and the web app SERVED BY A
// PRODUCTION BUILD (`npm run build -w apps/web` then `npm run start -w apps/web`).
//
// Chunk names are resolved from .next/build-manifest.json rather than hardcoded.
// An un-hashed path like /_next/static/chunks/pages/admin-matrix.js exists only
// under `next dev`, so against `next start` every chunk assertion 404s while the
// page routes still return 200 — a naming difference that reads as "these screens
// are missing". The manifest is the only authority on the real filename.
//
// What this proves:
//   1. All four routes return 200 and ship a page chunk of their own.
//   2. Each page carries the PROTOTYPE's own strings — the subtitles, the column
//      headers, the card headings. A screen that renders but says nothing the
//      blueprint says is not a port.
//   3. The sidebar no longer badges them "Wave 5", and each now has a LIVE route
//      instead of being absent.
//   4. Role gating matches the blueprint's data-roles for all four.
//   5. The screens are load-bearing, not decorative: each one's data comes from the
//      Track B API, and the settings threshold it displays is the number the
//      routing engine reads.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WEB = process.env.WEB_BASE || 'http://127.0.0.1:33002';
const API = process.env.API_BASE || 'http://127.0.0.1:33001';

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
  if (c) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra !== undefined ? `  -> ${JSON.stringify(extra)}` : ''}`); }
};
const chunkUrl = (f) => `/_next/${f.split('/').map(encodeURIComponent).join('/')}`;
const ownChunk = (files) => files.find((f) => f.includes('/chunks/pages/')) || null;

// ── the production build manifest ───────────────────────────────────────────
const MANIFEST_PATH = fileURLToPath(new URL('../apps/web/.next/build-manifest.json', import.meta.url));
let manifest;
if (!existsSync(MANIFEST_PATH)) {
  console.error(`\n  ABORT  no production build at ${MANIFEST_PATH}\n`
    + `         Run:  npm run build -w apps/web   then   npm run start -w apps/web\n`);
  process.exit(1);
}
try { manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')); }
catch (e) {
  console.error(`\n  ABORT  build manifest is unreadable: ${e.message}\n`
    + `         Re-run: npm run build -w apps/web\n`);
  process.exit(1);
}
{
  const pages = manifest.pages || {};
  const devish = (manifest.devFiles || []).length > 0
    || (manifest.lowPriorityFiles || []).some((f) => f.includes('static/development/'));
  if (devish) {
    console.error(`\n  ABORT  ${MANIFEST_PATH} is a NEXT DEV manifest.\n`
      + `         Run:  npm run build -w apps/web   then   npm run start -w apps/web\n`);
    process.exit(1);
  }
  const unhashd = Object.values(pages).flat().filter((f) => !/(?:^|[-/])[0-9a-f]{16}\.(?:js|css)$/.test(f));
  if (unhashd.length) {
    console.error(`\n  ABORT  ${unhashd.length} manifest chunk(s) are not content-hashed `
      + `(e.g. ${unhashd.slice(0, 3).join(', ')}).\n`
      + `         A production build always hashes. Re-run: npm run build -w apps/web\n`);
    process.exit(1);
  }
}

const ROUTES = [
  { path: '/admin-matrix', page: '/admin-matrix', screen: 'admin-matrix',
    title: 'Authority Matrix', strings: ['Routing rules per Capex/Opex class', 'Amount band', 'Approver(s)', 'Routing key', 'Capex', 'Opex'] },
  { path: '/admin-dimensions', page: '/admin-dimensions', screen: 'admin-dimensions',
    title: 'D365 Dimensions', strings: ['D365 api:', 'Add value', 'Search'] },
  { path: '/admin-uom', page: '/admin-uom', screen: 'admin-uom',
    title: 'D365 UOM', strings: ['PurchUnit', 'in the D365 catalog', 'light flow only'] },
  { path: '/settings', page: '/settings', screen: 'settings',
    title: 'Settings', strings: ['Workflow', 'Notifications', 'D365 integration'] },
];

console.log(`\n--- Wave 5 Track C: the four admin screens (${WEB}) ---`);
console.log(`  ....  manifest is a production manifest (${Object.keys(manifest.pages).length} page keys)`);

for (const r of ROUTES) {
  const res = await fetch(`${WEB}${r.path}`);
  const html = await res.text();
  ok(res.status === 200, `${r.path} returns 200`, res.status);
  ok(!html.includes('Application error'), `${r.screen} has no render error`);
  ok(!html.includes('This page could not be found'), `${r.screen} is not a 404 page`);

  const files = manifest.pages?.[r.page] || [];
  ok(files.length > 0, `${r.screen} is in the production build`, files.length ? `${files.length} chunks` : 'no manifest entry');
  const own = ownChunk(files);
  ok(Boolean(own), `${r.screen} ships a page chunk of its own`, own);
  if (!own) continue;

  const cr = await fetch(`${WEB}${chunkUrl(own)}`);
  ok(cr.status === 200, `${r.screen} serves its own compiled page chunk`, `${own} -> ${cr.status}`);
  const js = cr.ok ? await cr.text() : '';
  ok(js.length > 500, `${r.screen} chunk is a real module (${js.length} bytes)`, js.length);
  // Asserted on the page's OWN chunk, not the union: a string that also lands in a
  // shared split would not prove this page carries the port.
  ok(js.includes(r.title), `${r.screen} ships its title "${r.title}"`);
  ok(js.includes(r.screen), `${r.screen} ships its prototype screen id`);
  for (const s of r.strings) {
    ok(js.includes(s), `${r.screen} ships the prototype string "${s}"`);
  }
}

// ── the sidebar: no longer badged, now routed ──────────────────────────────
console.log('\n--- the sidebar no longer claims these are un-ported ---');
{
  const shell = readFileSync(new URL('../apps/web/components/Shell.tsx', import.meta.url), 'utf8');
  // Comments are stripped before scanning: a comment explaining a removal contains
  // the very strings an "is it still there?" assertion looks for.
  const code = shell.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  // Bound the PENDING scan to the OBJECT LITERAL. Taking everything after the
  // `const PENDING` line would sweep the whole rest of the file, where `settings`
  // legitimately appears again as a nav id.
  const pendingBlock = (code.split('const PENDING')[1] ?? '').split('};')[0];
  for (const s of ROUTES) {
    // Keys may or may not be quoted (`settings:` vs `'admin-matrix':`), so the
    // quotes are optional in the pattern.
    ok(new RegExp(`['"]?${s.screen}['"]?\\s*:\\s*['"]${s.path}['"]`).test(code),
      `${s.screen} has a LIVE route in ROUTES`);
    ok(!new RegExp(`['"]?${s.screen}['"]?\\s*:`).test(pendingBlock),
      `${s.screen} is no longer listed in PENDING`);
  }
  // Asserted on the items that are GENUINELY still deferred. This used to assert
  // that `vendors` was pending, which W5-C verified and W5-D then made false —
  // a stale assertion that fails for the right reason at the wrong time.
  // Deferred to Wave 6: kpi, audit, audit-report. Deferred to W5: none remain.
  //
  // Line-based, not a `['"]key['"]?:` character class: a pattern built around
  // quote characters is opaque and has proved unreliable here more than once.
  const declares = (block, id) =>
    block.split('\n').some((l) => {
      const t = l.trim();
      return t.startsWith(`${id}:`) || t.startsWith(`'${id}':`) || t.startsWith(`"${id}":`);
    });
  ok(declares(pendingBlock, 'kpi') && declares(pendingBlock, 'audit'),
    'genuinely un-ported items are still badged with their wave',
    pendingBlock.trim());
  ok(!declares(pendingBlock, 'vendors') && !declares(pendingBlock, 'vendor-risk'),
    'the Wave 5 screens left the pending list entirely');
}

// ── role gating matches the blueprint's data-roles ─────────────────────────
console.log('\n--- role gating ---');
{
  const { roleAllowed } = await import('../packages/roles/dist/index.js').catch(() => ({}));
  const rolesSrc = readFileSync(new URL('../packages/roles/src/index.ts', import.meta.url), 'utf8');
  const expect = {
    'admin-matrix': 'cs,procurement,cfo',
    'admin-dimensions': 'cs,procurement,cfo',
    'admin-uom': 'cs,procurement,cfo',
    settings: 'all',
  };
  for (const [id, csv] of Object.entries(expect)) {
    const m = rolesSrc.match(new RegExp(`id: '${id}',[^\\n]*roles: '([^']+)'`));
    ok(Boolean(m) && m[1] === csv, `${id} is gated to ${csv} in the blueprint's role CSV`, m?.[1]);
    if (id === 'settings') continue;
    // 'all' aside, a requester must fail and a member of the CSV must pass.
    ok(typeof roleAllowed === 'function', 'roleAllowed is available for the gate check');
    if (typeof roleAllowed === 'function') {
      ok(!roleAllowed('requester', csv), `a requester cannot open ${id}`);
      ok(roleAllowed('cfo', csv), `CFO can open ${id}`);
    }
  }
}

// ── the screens are load-bearing: real data, and a bound threshold ─────────
console.log('\n--- the screens read the live Track B API, not a constant ---');
{
  const login = async (email) => (await (await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'demo' }),
  })).json()).token;

  const admin = await login('admin@pakboxes.pk');
  const h = { authorization: `Bearer ${admin}` };

  const matrix = await (await fetch(`${API}/admin/authority-matrix`, { headers: h })).json();
  ok(matrix.capexOpexSplit === true, 'the matrix screen will render a Capex/Opex split');
  ok(matrix.tables?.CAPEX?.length === 3 && matrix.tables?.OPEX?.length === 3,
    'both band tables have the blueprint\'s 3 bands each',
    { capex: matrix.tables?.CAPEX?.length, opex: matrix.tables?.OPEX?.length });

  const dims = await (await fetch(`${API}/admin/dimensions`, { headers: h })).json();
  ok(dims.dimensions?.length === 9, 'the dimensions screen will render 9 tables', dims.dimensions?.length);
  ok(dims.dimensions?.every((d) => Array.isArray(d.values)),
    'every dimension carries its value list, so none renders empty');
  // MANDATORY / OPTIONAL are computed SERVER-side and travel as `tag`, so they are
  // asserted here rather than in the page chunk. Asserting them against the chunk
  // would fail for the right architecture and the wrong reason.
  ok(dims.dimensions?.every((d) => d.tag === 'MANDATORY' || d.tag === 'OPTIONAL'),
    'every dimension is tagged MANDATORY or OPTIONAL, as the blueprint requires',
    dims.dimensions?.filter((d) => d.tag !== 'MANDATORY' && d.tag !== 'OPTIONAL').map((d) => d.key));
  ok(dims.dimensions?.filter((d) => d.mandatory).length === 4,
    'the 4 mandatory dimensions are the ones the engine requires',
    dims.dimensions?.filter((d) => d.mandatory).length);
  ok(dims.dimensions?.every((d) => d.values.some((v) => v.isPlaceholder) === ['Location', 'Project', 'Worker', 'Customer'].includes(d.key)),
    'the 4 placeholder rows are flagged exactly where the prototype has them');

  const uom = await (await fetch(`${API}/admin/uom`, { headers: h })).json();
  ok(uom.counts?.d365Catalog === 18 && uom.counts?.lightFlow === 10,
    'the UOM screen will show 18 catalog / 10 light', uom.counts);

  const settings = await (await fetch(`${API}/admin/settings`, { headers: h })).json();
  // Migration 036 deleted the `mgmtThresholdCr` alias row. The threshold is now a
  // first-class field sourced from workflow.config, not a catalogue entry — so the
  // assertion is that no such row EXISTS and the field IS the live value.
  ok(!settings.settings?.some((s) => s.key === 'mgmtThresholdCr'),
    'core.settings carries no second threshold row to drift from');
  ok(settings.managementThreshold?.writesTo === 'workflow.config[management_threshold]',
    'the settings screen shows the threshold as bound, not a local copy',
    settings.managementThreshold?.writesTo);
  ok(settings.managementThreshold?.value > 0,
    'and that bound value is the live one the engine reads', settings.managementThreshold);

  // The number the screen renders must be the number the engine serves, or the
  // threshold field would be showing something the router ignores.
  const raw = await (await fetch(`${API}/workflow/config/raw`, { headers: h })).json();
  ok(raw.managementThreshold === settings.managementThreshold?.value,
    'the settings screen and the routing engine report the SAME threshold',
    { screen: settings.managementThreshold?.value, engine: raw.managementThreshold });
  ok(raw.steps?.find((s) => s.key === 'finance_review')?.when === 'aboveMgtThreshold',
    'and the engine really is gated on the global threshold');
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
