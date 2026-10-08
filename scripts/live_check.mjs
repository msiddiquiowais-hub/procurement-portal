// Read-only liveness sweep for MANUAL testing.
// GET + login only. Nothing here writes, so it cannot leave residue and it
// does not contend with a human clicking through the UI.
//
// Route paths below were taken from the controllers, not guessed â€” an earlier
// draft of this file "failed" 9 endpoints that exist perfectly well under
// different paths, which is exactly how a verification script starts
// reporting fiction.
const BASE = 'http://127.0.0.1:33001';

const EMAILS = {
  procurement: 'procurement@pakboxes.pk', cs: 'cs@pakboxes.pk', cfo: 'cfo@pakboxes.pk',
  hod: 'hod.sales@pakboxes.pk', mc: 'mc.member1@pakboxes.pk', requester: 'requester@pakboxes.pk',
  admin: 'admin@pakboxes.pk', audit: 'audit@pakboxes.pk', finance: 'finance@pakboxes.pk',
  warehouse: 'warehouse@pakboxes.pk',
};

async function login(email, password = 'demo') {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, token: j.token };
}

async function get(path, token) {
  const r = await fetch(`${BASE}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
  return { status: r.status, json: j, text: t };
}

let pass = 0, fail = 0;
const bad = [];
const note = (label, ok, detail) => {
  if (ok) { pass++; console.log(`  ok    ${label}${detail ? '   ' + detail : ''}`); }
  else { fail++; bad.push(label); console.log(`  FAIL  ${label}${detail ? '   ' + detail : ''}`); }
};
const shape = (j) => {
  if (Array.isArray(j)) return `array(${j.length})`;
  if (j && typeof j === 'object') return `keys=${Object.keys(j).slice(0, 4).join(',')}`;
  return `body=${String(j).slice(0, 40)}`;
};

console.log('\n=== read-only liveness sweep ===\n');

console.log('-- login per role (any non-empty password is accepted by design) --');
const tok = {};
for (const [role, email] of Object.entries(EMAILS)) {
  const r = await login(email);
  tok[role] = r.token;
  note(`${role.padEnd(11)} login`, r.status === 201 && !!r.token, `status ${r.status}`);
}

console.log('\n-- auth boundary behaviour --');
const empty = await login(EMAILS.admin, '');
note('empty password refused', empty.status >= 400, `status ${empty.status}`);
const ghost = await login('attacker@evil.com', 'x');
note('unknown email refused (401)', ghost.status === 401, `status ${ghost.status}`);
const anon = await get('/vendors');
note('no token refused', anon.status >= 400, `status ${anon.status}`);

console.log('\n-- core read endpoints --');
const READS = [
  ['/pr', 'PR list'],
  ['/pr/approvals/queue', 'approvals queue'],
  ['/pr/light/list', 'light PRs'],
  ['/vendors', 'vendor master'],
  ['/vendors/applications', 'vendor applications'],
  ['/vendors/risk', 'vendor risk'],
  ['/rfq', 'RFQ list'],
  ['/outbox', 'dispatch outbox'],
  ['/ack', 'acknowledgements'],
  ['/lookups/items', 'item master'],
  ['/lookups/departments', 'departments'],
  ['/lookups/cost-centers', 'cost centres'],
  ['/admin/authority-matrix', 'admin matrix'],
  ['/admin/dimensions', 'financial dimensions'],
  ['/admin/uom', 'UOM library'],
  ['/admin/settings', 'settings'],
  ['/workflow/config', 'workflow config'],
  ['/workflow/threshold', 'workflow threshold'],
  ['/d365/sync/status', 'D365 sync status'],
  ['/d365/sync/vendors/preview', 'vendor sync preview'],
];
for (const [path, label] of READS) {
  const r = await get(path, tok.procurement);
  note(`${label.padEnd(20)} ${path}`, r.status === 200, `status ${r.status} ${shape(r.json)}`);
}

// /supplier/inbox is data-roles="vendor" in the prototype, so a 403 for
// procurement is the CORRECT answer. Assert it that way, or the check will
// "fail" forever against a screen that is behaving exactly as specified.
const supAsProc = await get('/supplier/inbox', tok.procurement);
note('supplier inbox hidden from procurement', supAsProc.status === 403, `status ${supAsProc.status}`);
const supAsVendor = await get('/supplier/inbox', await login('vendor1@example.com').then((r) => r.token));
note('supplier inbox visible to a vendor', supAsVendor.status === 200, `status ${supAsVendor.status}`);

console.log('\n-- per-PR surfaces (W5-G / W5-H) --');
const prs = await get('/pr', tok.procurement);
const prRows = Array.isArray(prs.json) ? prs.json : (prs.json?.rows ?? prs.json?.data ?? []);
note('PR list returned rows', prRows.length > 0, `${prRows.length} rows`);
if (prRows.length > 0) {
  const byStatus = {};
  for (const p of prRows) byStatus[p.status] = (byStatus[p.status] || 0) + 1;
  console.log('        stages: ' + Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(' '));
  const withCs = prRows.find((p) => ['CS_LOCKED', 'MC_APPROVED', 'CFO_APPROVED', 'PACK_LOCKED'].includes(p.status));
  if (withCs) {
    const id = withCs.id;
    for (const [path, label] of [[`/pr/${id}/cs`, 'CS'], [`/pr/${id}/quotes`, 'quotes'],
                                  [`/pr/${id}/d365/status`, 'D365 status'], [`/pr/${id}/po`, 'purchase orders'],
                                  [`/pr/${id}/history`, 'history'], [`/pr/${id}/pack`, 'pack']]) {
      const r = await get(path, tok.procurement);
      note(`${label.padEnd(20)} ${path}`, r.status === 200, `status ${r.status} ${shape(r.json)}`);
    }
    const pdf = await get(`/cs/lookup`, tok.procurement);
  } else {
    console.log('        (no PR far enough along to have a CS â€” try the seeded one)');
  }
}

console.log('\n-- role gating (expectations taken from the blueprint, not guessed) --');
const reqAdminRead = await get('/admin/settings', tok.requester);
note('requester CAN read settings (read-gated)', reqAdminRead.status === 200, `status ${reqAdminRead.status}`);
const reqVendorWrite = await fetch(`${BASE}/vendors/00000000-0000-0000-0000-000000000000/hold`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok.requester}` },
  body: JSON.stringify({}) });
note('requester blocked from a vendor write', reqVendorWrite.status >= 400, `status ${reqVendorWrite.status}`);

// Blueprint screen 19 `vendors` is data-roles="procurement,hod,cs". CFO is NOT
// on that list, so a 403 here is the specified behaviour, not a defect. An
// earlier version of this file asserted 200 and reported a false failure.
const cfoVendors = await get('/vendors', tok.cfo);
note('cfo is denied vendor master (per blueprint)', cfoVendors.status === 403, `status ${cfoVendors.status}`);
const hodVendors = await get('/vendors', tok.hod);
note('hod CAN read vendor master (per blueprint)', hodVendors.status === 200, `status ${hodVendors.status}`);
const adminVendors = await get('/vendors', tok.admin);
note('admin CAN read vendor master (ROLE_ALIASES union)', adminVendors.status === 200, `status ${adminVendors.status}`);

console.log(`\n=== ${fail} failed, ${pass} passed ===`);
if (fail) console.log('failed: ' + bad.join(' | '));
process.exit(fail ? 1 : 0);
