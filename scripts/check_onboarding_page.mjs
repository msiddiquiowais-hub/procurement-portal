// Wave 4 step 5 — the public onboarding page, checked over HTTP.
//
// The onboarding app has no test harness of its own, and the page is client
// rendered, so a 200 alone proves nothing. What IS checkable on the served
// shell is the part that ships as static markup: the prototype's copy, the field
// labels, and — the thing that actually matters — the prototype's DEMO VALUES
// and its Math.random() reference, which must be absent.
import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WEB = process.env.ONBOARDING_BASE || 'http://127.0.0.1:33004';
const API = process.env.API_BASE || 'http://127.0.0.1:33001';

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
  if (c) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''}`); }
};

/** Segment-encode a manifest path; the manifest stores `[id]` raw, URLs want it encoded. */
const chunkUrl = (file) => `/_next/${file.split('/').map(encodeURIComponent).join('/')}`;

/** The page's OWN module — the entry under `static/chunks/pages/`. */
const ownChunk = (files) => files.find((f) => f.includes('/chunks/pages/')) || null;

/**
 * The build manifest, with the mode it represents made explicit.
 *
 * Both this app's dev and production modes are legitimate ways to run the
 * onboarding page, so this does NOT demand a production build — it just refuses
 * to guess. `isDev` comes from the same two signals a production manifest lacks:
 * a non-empty `devFiles`, and a `static/development/` low-priority file.
 */
function loadBuildManifest(label) {
  const path = fileURLToPath(new URL('../apps/onboarding/.next/build-manifest.json', import.meta.url));
  if (!existsSync(path)) {
    console.error(`\n  ABORT  no onboarding build at\n         ${path}\n`
      + `         Run:  npm run build -w apps/onboarding   (or: npm run dev -w apps/onboarding)\n`);
    process.exit(1);
  }
  let m;
  try { m = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) {
    console.error(`\n  ABORT  onboarding build manifest is unreadable: ${e.message}\n`
      + `         It is truncated when a build is interrupted — re-run: npm run build -w apps/onboarding\n`);
    process.exit(1);
  }
  const pages = m.pages || {};
  const isDev = (m.devFiles || []).length > 0
    || (m.lowPriorityFiles || []).some((f) => f.includes('static/development/'));
  if (!pages['/_app']) {
    console.error(`\n  ABORT  onboarding build manifest has no /_app entry `
      + `(page keys: ${Object.keys(pages).join(', ') || 'none'}).\n`
      + `         Re-run: npm run build -w apps/onboarding\n`);
    process.exit(1);
  }
  ok(true, `${label} build manifest is readable (${isDev ? 'dev' : 'production'}, ${Object.keys(pages).length} page keys)`);
  return { pages, isDev };
}

const html = (await (await fetch(WEB + '/')).text()).replace(/\s+/g, ' ');
const manifest = loadBuildManifest('onboarding');

// The public form is client-rendered, so check the SHELL the browser receives.
console.log('=== the served shell ===');
ok(html.includes('Vendor Onboarding'), 'the prototype title');
ok(html.includes('Apply to become an approved vendor'), 'the prototype subtitle');
ok(/public form/i.test(html), "the alert's \"public form\"");
ok(/no login required/i.test(html), 'and its no-login promise');
ok(/validated\s*by Procurement before vendor master creation/i.test(html), 'and its validation promise');
ok(/Company name/.test(html), 'the Company name field');
ok(/NTN \/ Tax ID/.test(html), "the prototype's exact NTN label");
ok(/Contact person/.test(html) && /Email/.test(html), 'the contact fields');
ok(/Categories supplied/.test(html), 'the categories field');
ok(/Submit application/.test(html), 'the prototype button label');

console.log('\n--- the prototype\'s DEMO VALUES must not be pre-filled ---');
// These are in the prototype's static markup as value="...". On a real public
// form they would make every applicant submit the same company and tax number.
for (const [lit, why] of [
  ['PakBoxes Pvt Ltd', 'the prototype company'],
  ['1234567-8', 'the prototype tax id'],
  ['Ahsan Ali', 'the prototype contact person'],
  ['sales@pakboxes.pk', 'the prototype contact email'],
]) {
  ok(!html.includes(lit), `${why} "${lit}" is not pre-filled`);
}

console.log('\n--- the fabrication must be gone ---');
ok(!/Math\s*\.\s*random/.test(html), 'no Math.random() in the served shell');
ok(!/ONB-\{/.test(html), 'no template-literal reference');
ok(!/\b99999\b/.test(html), 'no 99999 range');

console.log('\n--- the stylesheet is actually applied ---');
// The stylesheet is resolved from the BUILD MANIFEST, the same authority the
// governance suite now uses for chunks. This block used to scrape
// `<link rel=stylesheet>` out of the served HTML and, failing that, fetch a
// HARDCODED `/_next/static/chunks/pages/_app.js` — a filename that only exists
// under `next dev`. On a production server that fetch returns Next's 404 page
// (456 bytes of HTML), so the branch would print "the _app chunk is served
// (dev build)" while the server was plainly in production, and the six styling
// assertions below would then fail for a reason that had nothing to do with
// styling. A latent misdiagnosis, not a live failure — the <link> scrape
// happened to match — but the manifest removes the guesswork entirely:
//   production — pages['/_app'] lists `static/css/<hash>.css` directly
//   dev        — CSS is injected through the _app chunk, listed un-hashed
let css = '';
const cssFile = (manifest.pages['/_app'] || []).find((f) => f.endsWith('.css'));
if (cssFile) {
  const cr = await fetch(`${WEB}${chunkUrl(cssFile)}`);
  ok(cr.ok, 'the production stylesheet the manifest names is served', `${cssFile} -> ${cr.status}`);
  css = cr.ok ? await cr.text() : '';
  // Stronger than the old check: not merely "a <link> exists" but "the page
  // links the stylesheet this build actually produced". Compare the basename —
  // the served href is a /_next URL while the manifest entry is build-relative.
  const linked = (html.match(/<link[^>]+href="([^"]*\.css)"/) || [])[1];
  const cssName = cssFile.split('/').pop();
  ok(Boolean(linked) && linked.includes(cssName),
    'and the served shell links that same stylesheet', linked);
} else {
  const appChunkFile = ownChunk(manifest.pages['/_app'] || []);
  ok(Boolean(manifest.isDev), 'no CSS in the manifest — this must be a dev build');
  ok(Boolean(appChunkFile), 'the _app chunk is listed in the dev manifest', appChunkFile);
  if (appChunkFile) {
    const ar = await fetch(`${WEB}${chunkUrl(appChunkFile)}`);
    ok(ar.ok, 'the _app chunk is served (dev build)', `${appChunkFile} -> ${ar.status}`);
    css = ar.ok ? await ar.text() : '';
  }
}
// Case-insensitive on purpose: a production minifier rewrites #2E86C1 as
// #2e86c1, and asserting the prototype's exact casing tested the minifier
// rather than the styling. The token being PRESENT is the contract.
const cssLower = css.toLowerCase();
ok(cssLower.includes('2e86c1'), "the prototype's --accent token reached the browser");
ok(cssLower.includes('--danger:#dc2626'), "the prototype's --danger token reached the browser");
ok(css.includes('.public-shell'), "the prototype's .public-shell rule reached the browser");
ok(/\.btn\.primary\{[^}]*background:var\(--accent\)/.test(css), "the prototype's primary button rule");
ok(css.includes('label.field .lbl .req'), 'the required-marker rule');
ok(css.includes('.ref-value'), 'the reference panel is styled, not raw');

console.log('\n=== the page depends on the step-3 API, and it is reachable ===');
const cfg = await (await fetch(API + '/onboarding/form')).json();
ok(cfg.title === 'Vendor Onboarding', 'the API serves the same title the page falls back to');
ok(cfg.fields.filter((f) => f.required).map((f) => f.key).join(',') === 'legalName,ntn',
  'and the required set the page marks with a red asterisk', cfg.fields);
ok(cfg.categoryOptions.length === 9, 'the 9 real categories reach the select', cfg.categoryOptions.length);
ok(!cfg.categoryOptions.some((o) => o.id === 'Office equipment'),
  'the prototype\'s unrecognised "Office equipment" is not offered');

console.log('\n--- end to end: submit through the API the page calls, then look up ---');
const email = `step5-${Date.now()}@example.test`;
const sub = await (await fetch(API + '/onboarding/applications', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ legalName: 'Step Five Co', ntn: `5${Date.now() % 10000000}-5`, contactEmail: email, categories: 'IT_HARDWARE' }),
})).json();
ok(/^ONB-\d{4}-\d{5}$/.test(sub.reference), 'the page would show a real reference', sub.reference);

const st = await (await fetch(`${API}/onboarding/applications/${sub.reference}?email=${encodeURIComponent(email)}`)).json();
ok(st.reference === sub.reference && st.state === 'Submitted', 'and the lookup the page offers works', st);
const wrong = await fetch(`${API}/onboarding/applications/${sub.reference}?email=nope@example.test`);
ok(wrong.status === 404, 'a wrong email is refused, so the page\'s lookup cannot enumerate', wrong.status);

execFileSync('docker', ['exec', '-i', 'procurement-portal-db', 'psql', '-U', 'proc', '-d', 'procurementDB',
  '-X', '-q', '-c', `DELETE FROM core.vendor_applications WHERE reference = '${sub.reference}'`], { encoding: 'utf8' });

console.log(`\n=== onboarding step-5 probe: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
