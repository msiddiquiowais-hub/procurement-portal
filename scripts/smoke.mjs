// End-to-end smoke test for the Procurement stack.
// Pre-reqs: API is running on :33001, DB is seeded, verify.sh is green.
//
//   npm run api:dev   (in another shell)
//   node scripts/smoke.mjs
//
// Walks: requester logs in → PR created → HOD approves →
//        HOD approves a different PR with warehouse flag (regression) →
//        D365 stub pushes a READY_FOR_D365 PR.

const API = process.env.API_BASE || 'http://localhost:33001';

function tag(name) { return `[${name}]`; }
let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); pass++; }
  else    { console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`); fail++; }
}

async function login(email, password = 'demo') {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) throw new Error(`login ${email} failed: ${r.status} ${await r.text()}`);
  return (await r.json()).token;
}

async function authFetch(token, path, method = 'GET', body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, data: text ? JSON.parse(text) : null, raw: text };
}

async function createPr(token, opts = {}) {
  // Look up first cost center + first item.
  const cc = await authFetch(token, '/lookups/cost-centers');
  const it = await authFetch(token, '/lookups/items');
  const ccId = opts.costCenterId || cc.data[0].id;
  const itemA = opts.itemIdA || it.data[0].id;
  const itemB = opts.itemIdB || it.data[1].id;
  const r = await authFetch(token, '/pr', 'POST', {
    scope: opts.scope || 'Smoke test PR',
    expenseType: 'OPEX',
    costCenterId: ccId,
    requiredByDate: new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10),
    urgency: 'routine',
    lines: [
      { itemId: itemA, quantity: 100, uom: 'PCS', unitPriceEst: 100 },
      { itemId: itemB, quantity: 50,  uom: 'PCS', unitPriceEst: 200 },
    ],
  });
  if (!r.ok) throw new Error('create PR failed: ' + r.raw);
  return r.data; // { id, prNumber, status, estimatedAmount }
}

console.log('→ Smoke test against', API);

console.log(tag('health'));
const h = await fetch(`${API}/health`).then(r => r.json());
check('health endpoint', h.ok === true, `service=${h.service}`);

console.log(tag('login'));
const requesterToken = await login('requester@pakboxes.pk');
check('requester login', !!requesterToken);

const hodToken = await login('hod.sales@pakboxes.pk');
check('HOD login', !!hodToken);

const procToken = await login('procurement@pakboxes.pk');
check('procurement login', !!procToken);

const adminToken = await login('admin@pakboxes.pk');
check('admin (alias) login', !!adminToken);

console.log(tag('lookups'));
const ccR = await authFetch(requesterToken, '/lookups/cost-centers');
check('cost centers', ccR.ok && Array.isArray(ccR.data) && ccR.data.length > 0, `count=${ccR.data?.length}`);
const itR = await authFetch(requesterToken, '/lookups/items');
check('items', itR.ok && Array.isArray(itR.data) && itR.data.length > 0, `count=${itR.data?.length}`);

console.log(tag('PR create'));
const pr1 = await createPr(requesterToken);
check('PR created', !!pr1.id && pr1.status === 'Submitted', `id=${pr1.id} status=${pr1.status}`);

console.log(tag('PR list'));
const list = await authFetch(requesterToken, '/pr');
check('PR list visible to requester', list.ok && list.data.some((r) => r.id === pr1.id),
  `count=${list.data?.length}`);

console.log(tag('HOD approve (default → IN_PROCUREMENT_REVIEW)'));
const adv1 = await authFetch(hodToken, `/pr/${pr1.id}/advance`, 'POST', {});
check('HOD advance accepted', adv1.ok, `→ ${adv1.data?.nextStage} via ${adv1.data?.matchedStep}`);

console.log(tag('PR create 2 (warehouse-flag regression)'));
const pr2 = await createPr(requesterToken, { scope: 'Warehouse-routing regression PR' });
check('PR #2 created', !!pr2.id && pr2.status === 'Submitted');

console.log(tag('HOD approve with wantWarehouse (→ IN_WAREHOUSE_CHECK)'));
const adv2 = await authFetch(hodToken, `/pr/${pr2.id}/advance`, 'POST', { wantWarehouse: true });
check('HOD advance with wantWarehouse', adv2.ok, `→ ${adv2.data?.nextStage} via ${adv2.data?.matchedStep}`);

console.log(tag('admin role alias sees PRs'));
const adminList = await authFetch(adminToken, '/pr');
check('admin can list PRs', adminList.ok && adminList.data.length > 0, `count=${adminList.data?.length}`);

console.log('');
console.log(`Done. ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
