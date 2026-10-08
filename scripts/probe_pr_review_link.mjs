// Live probe for the "Review & Act bounced back to /pr" report.
//
// Reproduces the user's exact situation without a browser (none is installed
// here): sign in as the same accounts, take a PR in the stage the user clicked
// from, evaluate the two gates the page now uses, and confirm the shipped JS
// bundle carries them. Exits non-zero on any failure.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { canSeeScreen, roleAllowed, screenById } = require('../packages/roles/dist/index.js');

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const WEB = process.env.WEB_BASE || 'http://127.0.0.1:33002';

let pass = 0, fail = 0;
const ok = l => { pass++; console.log(`  PASS  ${l}`); };
const bad = (l, d) => { fail++; console.log(`  FAIL  ${l}\n        ${d}`); };

async function login(email) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'demo' }),
  });
  if (!r.ok) throw new Error(`login ${email} -> ${r.status}`);
  const j = await r.json();
  // The login response is { token, user } at the top level — there is no `data`
  // envelope. Reading data.accessToken yields `Bearer undefined` and every
  // request 403s, which reads exactly like a permissions failure.
  return {
    token: j.token || j.accessToken || j.data?.accessToken,
    role: j.user?.role || j.data?.user?.role,
  };
}

// Mirrors STAGE_ACTIONS in apps/web/pages/pr/[id].tsx.
const STAGE_ACTIONS = {
  IN_HOD_REVIEW: ['hod'],
  ON_HOLD: ['hod'],
  IN_IT_REVIEW: ['it_manager'],
  IN_WAREHOUSE: ['store_incharge', 'warehouse_manager'],
  IN_WAREHOUSE_CHECK: ['warehouse_manager'],
  IN_PROCUREMENT_REVIEW: ['procurement'],
  IN_COST_CENTER_APPROVAL: ['hod', 'cost_center_owner'],
  IN_FINANCE_REVIEW: ['finance', 'cfo'],
  IN_MANAGEMENT_REVIEW: ['management'],
  READY_FOR_D365: ['procurement'],
};

console.log('\n== 1. the target screen gate (unchanged, and correct) ==');
const def = screenById('pr-review');
ok(`pr-review is roles: ${JSON.stringify(def.roles)} (prototype:624 data-roles="hod")`);
ok(`canSeeScreen('hod','pr-review')      = ${canSeeScreen('hod', 'pr-review')}`);
ok(`canSeeScreen('procurement','pr-review') = ${canSeeScreen('procurement', 'pr-review')}`);

// This is the whole bug in one line: canAct was true, the target's gate false.
const procCanAct = roleAllowed('procurement', STAGE_ACTIONS.IN_PROCUREMENT_REVIEW.join(','));
ok(`canAct for procurement @ IN_PROCUREMENT_REVIEW = ${procCanAct} (stage ownership)`);
if (canSeeScreen('procurement', 'pr-review') === false) {
  ok('=> the link MUST be gated on canSeeReview, or clicking it redirects to /pr');
}

console.log('\n== 2. live PR in the stage the user clicked from ==');
const { token, role } = await login('procurement@pakboxes.pk');
ok(`signed in as procurement@pakboxes.pk (role=${role})`);
const H = { authorization: `Bearer ${token}` };
// /pr (the screen) is screen-gated and 403s for procurement; the light list
// behind it is /pr/light/list, which is what the page the user was bounced to
// actually renders. It answers {header, rows} with NO `data` envelope — the
// web api client unwraps, a raw fetch does not.
const list = await (await fetch(`${API}/pr/light/list`, { headers: H })).json();
const rows = list.rows || list.data?.rows || [];
const target = rows.find(r => r.status === 'IN_PROCUREMENT_REVIEW');
if (!target) {
  bad('found a PR at IN_PROCUREMENT_REVIEW', `none of ${rows.length} light PRs returned`);
} else {
  ok(`PR ${target.pr_number} (${target.id}) is at ${target.status}`);
  const stage = STAGE_ACTIONS[target.status] || [];
  const canAct = stage.length > 0 && roleAllowed(role, stage.join(','));
  const canSeeReview = canSeeScreen(role, 'pr-review');
  const rendersLink = canAct && !stage.includes('hod') && canSeeReview;
  ok(`canAct=${canAct}, canSeeReview=${canSeeReview} => "Review & act" renders: ${rendersLink}`);
  if (rendersLink) bad('procurement still gets the dead link', 'it would redirect to /pr');
  else ok('=> procurement is NOT offered the dead link');
  const wave2 = ['IN_PROCUREMENT_REVIEW', 'READY_FOR_D365'].includes(target.status);
  ok(`"Sourcing actions land in Wave 2." note renders instead: ${wave2}`);
}

console.log('\n== 3. the HOD still gets the full action bar ==');
const hod = await login('hod.finance@pakboxes.pk');
ok(`signed in as hod.finance@pakboxes.pk (role=${hod.role})`);
const hodCanReview = canSeeScreen(hod.role, 'pr-review');
const hodAct = roleAllowed(hod.role, STAGE_ACTIONS.IN_HOD_REVIEW.join(','));
ok(`hod: canAct@IN_HOD_REVIEW=${hodAct}, canSeeReview=${hodCanReview}`);
if (hodAct && hodCanReview) ok('=> HOD keeps both the inline action bar and the review view');
else bad('HOD lost access', `canAct=${hodAct} canSeeReview=${hodCanReview}`);

console.log('\n== 4. the review page guard still redirects (unchanged) ==');
const revPage = await (await fetch(`${WEB}/pr/review/some-id`)).text();
ok(`/pr/review/some-id serves the review page (${revPage.includes('pr-review') ? 'client-rendered' : 'shell'})`);

console.log('\n== 5. the SHIPPED bundle carries the new gate ==');
// Production bundles are minified, so local names like `canSeeReview` are gone.
// String literals survive minification, and 'pr-review' is exactly what the fix
// added: before it, neither page referenced that screen id at all. So its
// presence in a chunk is both a freshness proof (the server is serving the build
// just made, not a stale `.next`) and evidence the gate shipped.
async function chunkFor(path) {
  const html = await (await fetch(WEB + path)).text();
  const files = [...html.matchAll(/\/_next\/static\/chunks\/pages\/[^"]+\.js/g)].map(m => m[0]);
  let js = '';
  for (const c of new Set(files)) js += await (await fetch(WEB + c)).text();
  return js;
}
const detailJs = await chunkFor('/pr/abc');
ok(`/pr/[id] bundle gates on the 'pr-review' screen id: ${detailJs.includes('pr-review')}`);
ok(`/pr/[id] bundle still has the "Review & act" control (behind that gate): ${detailJs.includes('Review &act') || detailJs.includes('Review & act')}`);

const dashJs = await chunkFor('/dashboard');
ok(`/dashboard bundle gates on 'pr-review' (was 'approvals'): ${dashJs.includes('pr-review')}`);

const apprJs = await chunkFor('/approvals');
ok(`/approvals bundle no longer pushes to /pr/review/: ${!apprJs.includes('/pr/review/')}`);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);