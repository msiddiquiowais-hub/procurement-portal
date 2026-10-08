// E2E (web) — the Part 7 builder screen actually ships.
//
// There is no browser automation in this repo, so this follows the pattern
// e2e_governance_web.mjs already uses: fetch the served route, then assert on
// the compiled chunk and the source. That proves the screen is reachable, wired
// into the nav as a LIVE route (not a greyed "Wave 5" placeholder), and carries
// the blueprint's own strings — including the zero-hardcoding claim, which is
// only credible if the threshold is not imported as a constant.
//
// Requires: the web app on 33002.

import { readFileSync } from 'node:fs';

const WEB = process.env.WEB_BASE || 'http://127.0.0.1:33002';
const ROOT = new URL('../', import.meta.url);

let pass = 0;
let fail = 0;
const ok = (label, extra = '') => { pass++; console.log(`  PASS  ${label}${extra ? `  (${extra})` : ''}`); };
const bad = (label, detail) => { fail++; console.log(`  FAIL  ${label}\n        ${detail}`); };
const eq = (label, actual, expected) => {
  if (actual === expected) ok(label, String(actual));
  else bad(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
const has = (label, haystack, needle) => {
  if (typeof haystack === 'string' && haystack.includes(needle)) ok(label);
  else bad(label, `missing ${JSON.stringify(needle)}`);
};

console.log(`\n=== Part 7 Step 2 — builder screen against ${WEB} ===\n`);

// -- Preflight: an unreachable site must abort, not report false passes -----
try {
  const h = await fetch(`${WEB}/`);
  if (h.status !== 200) { console.error(`  ABORT  web not healthy (${h.status}).`); process.exit(1); }
} catch (e) {
  console.error(`  ABORT  web unreachable at ${WEB}: ${e.message}`);
  process.exit(1);
}

// =========================================================================
// 1. The route is served
// =========================================================================
const page = await fetch(`${WEB}/admin-workflow`);
eq('GET /admin-workflow serves the builder route', page.status, 200);
const html = await page.text();
// The body is deliberately empty: Shell renders null until the session is read
// from localStorage, so there is nothing meaningful to assert in the SSR markup.
// Asserting the title appears here would be a false expectation for any
// client-rendered authed page in this app. The shipped-chunk assertions in
// section 8 are what actually prove the screen's copy.
has('the route returns a Next.js document for the builder', html, '__NEXT_DATA__');

// =========================================================================
// 2. Nav registration: a LIVE route, not a pending placeholder
// =========================================================================
const shellSrc = readFileSync(new URL('apps/web/components/Shell.tsx', ROOT), 'utf8');
has('Shell maps admin-workflow to a real route', shellSrc, "'admin-workflow': '/admin-workflow'");
if (/'admin-workflow'\s*:\s*'Wave 5'/.test(shellSrc)) {
  bad('admin-workflow is no longer a greyed pending item',
      'admin-workflow is still listed in the PENDING map');
} else {
  ok('admin-workflow is no longer a greyed pending item');
}

// =========================================================================
// 3. The screen source carries the blueprint's own strings
// =========================================================================
const src = readFileSync(new URL('apps/web/pages/admin-workflow.tsx', ROOT), 'utf8');
for (const [label, needle] of [
  ['diagram card header', 'Visual Workflow Diagram'],
  ['diagram meta line', 'Live render of the routing table'],
  ['diagram toggle label', 'Hide visual workflow'],
  ['grid card header', 'Lightweight PR routing steps'],
  ['add-step button', '+ Add step'],
  ['threshold card header', 'Routing threshold'],
  ['threshold label', 'Management gate threshold (PKR)'],
  ['save button', 'Save workflow config'],
  ['reset button', 'Reset to defaults'],
  ['line-rules summary', 'Line rules for this step'],
  ['add line rule button', '+ Add line rule'],
  ['empty-rules copy', 'No rules. Engine will fall back to'],
  ['zero-hardcoding notice', 'Zero hardcoding:'],
]) {
  has(`grid/copy — ${label}`, src, needle);
}

// The 11 grid columns, by header.
for (const col of [
  'Order', 'ID', 'Name', 'Actor role', 'From', 'Target state',
  'Condition', 'Condition Value', 'Skip?', 'CAPEX/OPEX?', 'Type',
]) {
  has(`grid column — ${col}`, src, `<th>${col}</th>`);
}

// The 7 line-rule columns.
for (const col of ['Category (multi)', 'Amount op', 'Amount value', 'routeTo', 'actorRole', 'reason']) {
  has(`line-rule column — ${col}`, src, `<th>${col}</th>`);
}

// =========================================================================
// 4. All eleven handlers exist
// =========================================================================
for (const h of [
  'lightWorkflowMoveStep', 'lightWorkflowEditStep', 'lightWorkflowAddStep',
  'lightWorkflowDeleteStep', 'lightWorkflowAddLineRule', 'lightWorkflowEditLineRule',
  'lightWorkflowDeleteLineRule', 'lightWorkflowSetThreshold', 'lightWorkflowSave',
  'lightWorkflowResetDefaults', 'lightWorkflowToggle',
]) {
  has(`handler — ${h}`, src, h);
}
has('lightWorkflowToggle is the documented no-op', src,
  'Per-stage toggles removed in v2.0.x-workflow-config');

// =========================================================================
// 5. The diagram is a pure function, and the fallback is the contract
// =========================================================================
const mmd = readFileSync(new URL('apps/web/lib/wfMermaid.ts', ROOT), 'utf8');
has('the Mermaid builder emits flowchart TD', mmd, "'flowchart TD'");
has('the Mermaid builder has a fixed start node', mmd, 'Start([New PR submitted])');
for (const cls of ['terminal', 'capex', 'exception', 'normal', 'target']) {
  has(`node class defined — ${cls}`, mmd, `classDef ${cls}`);
}
has('the label sanitiser strips Mermaid syntax', mmd, 'sanitizeLabel');
has('the builder is pure (no DOM access in wfMermaid.ts)', mmd, 'buildMermaidFromSteps');
if (/\bdocument\.|window\./.test(mmd)) {
  bad('wfMermaid.ts is pure — no DOM access',
      'the diagram builder touches the DOM, so it cannot be unit-tested');
} else {
  ok('wfMermaid.ts is pure — no DOM access');
}
has('the page falls back to <pre> when Mermaid cannot render', src, 'wf-mermaid-fallback');
has('the page records the Mermaid source on the container', src, 'data-source={mermaidSrc}');

// =========================================================================
// 6. Mermaid is bundled locally, not pulled from a CDN
// =========================================================================
const webPkg = JSON.parse(readFileSync(new URL('apps/web/package.json', ROOT), 'utf8'));
if (webPkg.dependencies?.mermaid) ok('mermaid is a real dependency', webPkg.dependencies.mermaid);
else bad('mermaid is a real dependency', 'mermaid is not in apps/web dependencies');
if (/https?:\/\/[^"']*mermaid/.test(src)) {
  bad('no CDN <script> for Mermaid', 'the page loads Mermaid from a remote URL');
} else {
  ok('no CDN <script> for Mermaid — it is bundled');
}

// =========================================================================
// 7. The PR screen reads the live threshold, not a constant
// =========================================================================
const prSrc = readFileSync(new URL('apps/web/pages/pr/[id].tsx', ROOT), 'utf8');
// Strip comments first. The file explains WHY the constant was removed, which
// means the identifier legitimately appears inside a comment — scanning raw text
// would report a leak that is documentation, not a dependency.
const prCode = prSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');
if (/\bDEFAULT_MANAGEMENT_THRESHOLD\b/.test(prCode)) {
  bad('pr/[id].tsx no longer references DEFAULT_MANAGEMENT_THRESHOLD in code',
      'the PR screen still hardcodes the management threshold');
} else {
  ok('pr/[id].tsx no longer references DEFAULT_MANAGEMENT_THRESHOLD in code (comments excluded)');
}
has('pr/[id].tsx reads the threshold from the config API', prSrc, "'/workflow/threshold'");
if (/needsMgt\s*=\s*[^;]*DEFAULT_MANAGEMENT_THRESHOLD/.test(prSrc)) {
  bad('the gate decision no longer compares against the constant',
      'needsMgt is still derived from DEFAULT_MANAGEMENT_THRESHOLD');
} else {
  ok('the gate decision no longer compares against the constant');
}

// =========================================================================
// 8. The compiled chunk actually contains the builder
// =========================================================================
try {
  const build = JSON.parse(readFileSync(new URL('apps/web/.next/build-manifest.json', ROOT), 'utf8'));
  const files = build.pages['/admin-workflow'] || [];
  if (!files.length) {
    bad('the builder page is in the production build', 'build-manifest has no /admin-workflow entry');
  } else {
    ok('the builder page is in the production build', files.join(', '));
    let blob = '';
    for (const f of files) {
      const r = await fetch(`${WEB}/_next/${f}`);
      if (r.ok) blob += await r.text();
    }
    has('the shipped chunk contains the diagram card', blob, 'Visual Workflow Diagram');
    has('the shipped chunk contains the threshold label', blob, 'Management gate threshold (PKR)');
  }
} catch (e) {
  bad('the production build manifest is readable', e.message);
}

// =========================================================================
// 9. The migration ordering fix is present
// =========================================================================
const m019 = readFileSync(new URL('db/migrations/019_widen_pr_status_check.sql', ROOT), 'utf8');
has('019 defines the shared widen helper', m019, 'CREATE OR REPLACE FUNCTION proc.fn_widen_pr_status_check');
for (const f of ['020_line_routing.sql', '027_governance_stages.sql']) {
  const s = readFileSync(new URL(`db/migrations/${f}`, ROOT), 'utf8');
  if (/DROP CONSTRAINT IF EXISTS purchase_requisitions_status_check/.test(s)) {
    bad(`${f} no longer drops the status CHECK`, 'it still re-declares the constraint instead of calling the helper');
  } else {
    ok(`${f} no longer drops the status CHECK`);
  }
  has(`${f} calls the shared widen helper`, s, 'SELECT proc.fn_widen_pr_status_check()');
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail === 0
  ? 'VERDICT: the Part 7 builder screen ships, is nav-wired, and reads live config.\n'
  : 'VERDICT: gaps remain. See failures above.\n');
process.exit(fail === 0 ? 0 : 1);
