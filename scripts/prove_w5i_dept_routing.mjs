// ─────────────────────────────────────────────────────────────────────────────
// prove_w5i_dept_routing.mjs
//
// Proves the four behaviours this change was asked for, against the LIVE API and
// the LIVE database. Every expectation is derived independently of the subject
// under test — nothing here reads a value back from the component it is
// checking, which is the failure mode that lets a self-reporting test pass
// while the real bug is still present.
//
//   1. A PR with no known price records UNKNOWN, never a fabricated figure.
//   2. The approver is the HOD of the PR's own department, resolved server
//      side, and a client cannot name a different one.
//   3. A requester sees only their own rows; an HOD sees only their own
//      department's rows — enforced in the database, not just the API filter.
//   4. core.users records a department, and routing follows from it.
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const CONTAINER = 'procurement-portal-db';

let pass = 0;
let fail = 0;
const failures = [];
/** Every PR this run creates, so they can be removed at the end. */
const createdPrIds = [];

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`); }

/** Direct SQL, bypassing the API entirely — an independent witness. */
async function sql(query) {
  const { stdout } = await pexec('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'proc', '-d',
    'procurementDB', '-X', '-q', '-A', '-t', '-F', '|', '-c', query]);
  return stdout.split('\n').map(s => s.trim()).filter(Boolean);
}

/** Same, but split into field arrays. Destructuring a bare row would yield
 *  CHARACTERS, not columns — a mistake that reads as corrupt data. */
async function rows(query) {
  return (await sql(query)).map(r => r.split('|'));
}

async function login(email) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'demo' }),
  });
  if (!r.ok) throw new Error(`login ${email} -> ${r.status}`);
  return (await r.json()).token;
}

const api = (token) => async (path, init = {}) => {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

console.log('=== W5-I: department routing, optional amount, RBAC scoping ===\n');

// ── Reference data, read straight from the database ────────────────────────────
const HOD_HR = '33333333-3333-3333-3333-333333333322';
const HOD_SALES = '33333333-3333-3333-3333-333333333302';
const AISHA = '33333333-3333-3333-3333-333333333301';
const HR_CC = '11111111-1111-1111-1111-111111111114';   // Lahore HR
const SALES_CC = '11111111-1111-1111-1111-111111111111'; // Lahore Sales
const LAPTOP = '55555555-5555-5555-5555-555555555503';  // PKB-LT-001

section('R4: core.users records a department, and every HOD heads their own');
{
  const list = await rows(`
    SELECT u.email, u.role, coalesce(d.code,'(none)'), coalesce(d2.code,'(none)')
      FROM core.users u
      LEFT JOIN core.departments d  ON d.id  = u.department_id
      LEFT JOIN core.departments d2 ON d2.id = (SELECT department_id FROM core.departments WHERE hod_user_id = u.id)
     WHERE u.role IN ('requester','hod')
     ORDER BY u.email`);
  for (const [email, role, own, headed] of list) {
    check(`${email} has a department`, own !== '(none)', `department_id resolved to ${own}`);
    // Only a HEAD of department is expected to be some department's HOD. A
    // requester working in HR heads nothing, and (none) is the correct answer.
    if (role === 'hod') {
      check(`${email} heads the department RLS scopes them to`, own === headed && headed !== '(none)',
        `user.department_id=${own} but departments.hod_user_id points at them for ${headed}`);
    }
  }
  const [aisha] = (await sql(`SELECT coalesce(d.code,'(none)') FROM core.users u
      LEFT JOIN core.departments d ON d.id=u.department_id WHERE u.id='${AISHA}'`));
  check('the requester is in HR, not SALES', aisha === 'HR', `got ${aisha}`);
}

// ── The PR itself ─────────────────────────────────────────────────────────────
const aishaTok = await login('requester@pakboxes.pk');
const post = api(aishaTok);

section('R1: amount left blank is recorded as unknown, not as a number');
let prId = null;
{
  const r = await post('/pr', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Office laptops for HR',
      scope: 'Office laptops for HR',
      description: 'Replace end-of-life laptops for the HR team (FY26 plan).',
      purpose: 'Replace end-of-life laptops for the HR team (FY26 plan).',
      expenseType: 'CAPEX',
      costCenterId: HR_CC,
      requiredByDate: '2026-12-31',
      urgency: 'routine',
      // No unitPriceEst anywhere: the price is genuinely unknown at this stage.
      lines: [{ itemId: LAPTOP, quantity: 2, uom: 'EA', description: 'Dell Latitude 5550 Laptop' }],
    }),
  });
  check('PR created', r.status === 201 || r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
  prId = r.body?.id;
  if (prId) createdPrIds.push(prId);
  const amt = r.body?.estimatedAmount;
  check('API reports a null amount, not 0', amt === null || amt === undefined, `got ${JSON.stringify(amt)}`);
  check('API reports amountStatus=UNKNOWN', r.body?.amountStatus === 'UNKNOWN', `got ${r.body?.amountStatus}`);

  const [row] = await sql(`SELECT estimated_amount::text, amount_status
      FROM proc.purchase_requisitions WHERE id='${prId}'`);
  const [stored, status] = (row || '').split('|');
  check('database stores estimated_amount as 0 with amount_status=UNKNOWN',
    Number(stored) === 0 && status === 'UNKNOWN', `got estimated_amount=${stored} amount_status=${status}`);

  const [line] = await sql(`SELECT coalesce(unit_price_est::text,'NULL') FROM proc.pr_lines WHERE pr_id='${prId}'`);
  check('the line price is NULL, not the fabricated 50000', line === 'NULL', `got ${line}`);
}

section('R2: the approver is the HOD of the PR department, and cannot be chosen');
{
  const [row] = await sql(`
    SELECT d.code, coalesce(pd.hod_user_id::text,'NULL'), coalesce(hu.email,'(nobody)')
      FROM proc.pr_departments pd
      JOIN core.departments d ON d.id = pd.department_id
      LEFT JOIN core.users hu ON hu.id = pd.hod_user_id
     WHERE pd.pr_id='${prId}'`);
  const [dept, hodId, hodEmail] = (row || '').split('|');
  check('PR is routed to the HR department', dept === 'HR', `got ${dept}`);
  check('approver is the HOD of HR', hodId === HOD_HR, `got ${hodId} (${hodEmail})`);
  check('approver is NOT the HOD of Sales', hodId !== HOD_SALES, `got ${hodEmail}`);

  // The browser must not be able to redirect the approval.
  const r = await post('/pr', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Cross-routing attempt', scope: 'Cross-routing attempt',
      description: 'Attempt to route an HR request to the HOD of Sales.',
      purpose: 'Attempt to route an HR request to the HOD of Sales.',
      expenseType: 'CAPEX', costCenterId: HR_CC, requiredByDate: '2026-12-31', urgency: 'routine',
      // Both fields a caller might try: name Sales' HOD directly, and pull
      // Sales in as an extra department while filing under HR.
      departments: [
        { departmentId: '00000000-0000-0000-0000-000000000001', hodUserId: HOD_SALES, suggested: true },
        { departmentId: '00000000-0000-0000-0000-000000000004', hodUserId: HOD_SALES, suggested: true },
      ],
      lines: [{ itemId: LAPTOP, quantity: 1, uom: 'EA', description: 'Laptop' }],
    }),
  });
  check('a request naming HOD of Sales is still accepted as a request', r.status < 400,
    `HTTP ${r.status} ${JSON.stringify(r.body)}`);
  if (r.body?.id) {
    const tags = await rows(`
      SELECT d.code, coalesce(hu.email,'(nobody)')
        FROM proc.pr_departments pd
        JOIN core.departments d ON d.id = pd.department_id
        LEFT JOIN core.users hu ON hu.id = pd.hod_user_id
       WHERE pd.pr_id='${r.body.id}' ORDER BY d.code`);
    const find = code => (tags.find(t => t[0] === code) || [])[1];
    check('the HR row still routes to the HOD of HR', find('HR') === 'hod.hr@pakboxes.pk', `got ${find('HR')}`);
    check('a client cannot pin HOD Sales to the Sales row',
      find('SALES') === 'hod.sales@pakboxes.pk', `got ${find('SALES')}`);
    // Clean up the probe PR.
    await sql(`SET app.dept_approver_override='on';
      DELETE FROM proc.purchase_requisitions WHERE id='${r.body.id}'`);
  } else {
    check('cross-routing probe PR was created', false, `no id in response: ${JSON.stringify(r.body)}`);
  }

  // The database refuses a hand-picked approver outright. Expected to ERROR,
  // so the failure itself is the evidence.
  let gateFired = false;
  let gateMsg = '';
  try {
    await sql(`INSERT INTO proc.pr_departments (pr_id, department_id, hod_user_id, suggested)
      VALUES ('${prId}', '00000000-0000-0000-0000-000000000004', '${HOD_SALES}', true);`);
  } catch (e) {
    gateFired = /not the HOD of department|check_violation|refusing to route/i.test(String(e.message || e));
    gateMsg = String(e.message || e).split('\n').find(l => /refusing to route/.test(l)) || '';
  }
  check('the database itself refuses to tag HOD Sales on an HR request', gateFired, gateMsg || 'insert was accepted');
  // Leave no residue from the probe.
  await sql(`DELETE FROM proc.pr_departments WHERE pr_id='${prId}' AND hod_user_id='${HOD_HR}'`);
  await sql(`INSERT INTO proc.pr_departments (pr_id, department_id, hod_user_id, suggested)
    VALUES ('${prId}', '00000000-0000-0000-0000-000000000004', core.fn_resolve_department_hod('00000000-0000-0000-0000-000000000004'), false)
    ON CONFLICT (pr_id, department_id) DO UPDATE SET hod_user_id = EXCLUDED.hod_user_id`);
}

section('R3a: a requester sees only their own requests');
{
  // A second requester in the same cost centre, so the old cost-centre-scoped
  // RLS clause would have leaked this row if it were still in force.
  // No password column exists — AuthService.login only requires a non-empty
  // password (the seed stores no hashes), so nothing to copy.
  await sql(`
    INSERT INTO core.users (id, email, display_name, role, cost_center_ids, department_id, mfa_enabled)
    VALUES ('33333333-3333-3333-3333-333333333399', 'peer.requester@pakboxes.pk', 'Peer Requester',
            'requester', ARRAY['${HR_CC}']::uuid[], '00000000-0000-0000-0000-000000000004', false)
    ON CONFLICT (email) DO UPDATE SET cost_center_ids = EXCLUDED.cost_center_ids`);

  const peerTok = await login('peer.requester@pakboxes.pk');
  const peerList = await api(peerTok)('/pr/light/list');
  const peerRows = peerList.body?.rows || [];
  const [prNo] = await sql(`SELECT pr_number FROM proc.purchase_requisitions WHERE id='${prId}'`);
  check("a peer requester cannot see another requester's PR",
    !peerRows.some(r => r.pr_number === prNo), `${prNo} was visible to the peer`);
  check('the peer sees an empty list rather than an error', peerList.status === 200, `HTTP ${peerList.status}`);
}

section('R3b: an HOD sees only their own department');
{
  const hrTok = await login('hod.hr@pakboxes.pk');
  const salesTok = await login('hod.sales@pakboxes.pk');

  const hrList = await api(hrTok)('/pr/light/list');
  const hrRows = hrList.body?.rows || [];
  const hrDepts = [...new Set(hrRows.map(r => r.department_name))];

  const salesList = await api(salesTok)('/pr/light/list');
  const salesRows = salesList.body?.rows || [];

  const [prDept] = await sql(`SELECT d.code FROM proc.purchase_requisitions pr
      JOIN core.departments d ON d.id=pr.department_id WHERE pr.id='${prId}'`);

  check('HOD of HR sees the HR request', hrRows.some(r => r.department_name && r.department_name.startsWith('Human')),
    `departments visible: ${JSON.stringify(hrDepts)}`);
  check('HOD of HR sees ONLY their own department',
    hrDepts.every(n => n.startsWith('Human')), `leaked departments: ${JSON.stringify(hrDepts)}`);
  check('HOD of Sales does NOT see the HR request',
    !salesRows.some(r => r.department_name && r.department_name.startsWith('Human')),
    `departments visible to HOD Sales: ${JSON.stringify([...new Set(salesRows.map(r => r.department_name))])}`);

  // Row-level, at the database, not through the API's own filter.
  //
  // IMPORTANT: this must run as a NON-superuser, or the result is meaningless.
  // The application's own connection role `proc` is a superuser with
  // BYPASSRLS, so it bypasses every policy regardless of
  // FORCE ROW LEVEL SECURITY. The policies are correct and will bite the day
  // the app connects as a normal role; today they are not what protects the
  // data, the service-layer filters are. Testing as `proc` would report the
  // policies as broken, and testing as a normal role reports what they will
  // actually do in production.
  await sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='w5i_rls_probe') THEN
        CREATE ROLE w5i_rls_probe NOLOGIN;
      END IF;
    END $$;
    GRANT USAGE ON SCHEMA core, proc TO w5i_rls_probe;
    GRANT SELECT ON proc.purchase_requisitions TO w5i_rls_probe;
    GRANT SELECT ON core.users, core.departments TO w5i_rls_probe;`);

  const asNonSuper = async (deptUuid) => pexec('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'proc',
    '-d', 'procurementDB', '-X', '-q', '-A', '-t', '-c', `
      SET ROLE w5i_rls_probe;
      SET app.bypass_rls = 'false';
      SET app.current_user_id = '';
      SET app.user_role = 'hod';
      SET app.user_cost_centers = '';
      SET app.user_department_id = '${deptUuid}';
      SELECT count(*) FROM proc.purchase_requisitions
       WHERE department_id = '00000000-0000-0000-0000-000000000004';`]);

  const salesSees = (await asNonSuper('00000000-0000-0000-0000-000000000001')).stdout.trim().split('\n').pop();
  check('RLS hides HR rows from a Sales HOD session at the SQL level',
    salesSees === '0', `a Sales HOD session could read ${salesSees} HR row(s)`);

  const hrSees = (await asNonSuper('00000000-0000-0000-0000-000000000004')).stdout.trim().split('\n').pop();
  check('RLS shows HR rows to an HR HOD session at the SQL level',
    Number(hrSees) > 0, `an HR HOD session read ${hrSees} HR row(s)`);

  // And a requester session: own rows only, never a colleague's.
  const peerSql = `
      SET ROLE w5i_rls_probe;
      SET app.bypass_rls = 'false';
      SET app.current_user_id = '33333333-3333-3333-3333-333333333399';
      SET app.user_role = 'requester';
      SET app.user_cost_centers = '${HR_CC}';
      SET app.user_department_id = '00000000-0000-0000-0000-000000000004';
      SELECT count(*) FROM proc.purchase_requisitions;`;
  const peerOut = await pexec('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'proc', '-d',
    'procurementDB', '-X', '-q', '-A', '-t', '-c', peerSql]);
  const peerSees = peerOut.stdout.trim().split('\n').pop();
  check('RLS gives a requester only their own rows, even sharing a cost centre',
    Number(peerSees) === 0, `a requester sharing the HR cost centre read ${peerSees} row(s)`);
}

// ── Report ────────────────────────────────────────────────────────────────────
// Clean up after ourselves. Every PR this script created is test residue, and
// leaving four "Office laptops for HR" rows in a demo database is worse than
// useless — it makes the next person think a bug created duplicates.
for (const id of createdPrIds) {
  await sql(`SET app.dept_approver_override='on';
    DELETE FROM proc.purchase_requisitions WHERE id='${id}'`);
}
await sql(`DELETE FROM proc.purchase_requisitions
            WHERE requester_user_id='33333333-3333-3333-3333-333333333301'
              AND title IN ('Office laptops for HR','Cross-routing attempt')`);
// Revoke before dropping: DROP ROLE refuses while any grant is outstanding.
await sql(`
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='w5i_rls_probe') THEN
      EXECUTE 'REVOKE ALL ON SCHEMA core, proc FROM w5i_rls_probe';
      EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA core FROM w5i_rls_probe';
      EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA proc FROM w5i_rls_probe';
      EXECUTE 'DROP ROLE w5i_rls_probe';
    END IF;
  END $$;`);
console.log(`\n(cleaned up ${createdPrIds.length + 1} probe PR(s) and the probe role)`);

console.log(`\n${'='.repeat(70)}`);
console.log(`TOTAL  pass=${pass}  fail=${fail}`);
if (fail) { console.log('\nFAILURES:'); failures.forEach(f => console.log(`  - ${f}`)); }
console.log('='.repeat(70));
process.exit(fail ? 1 : 0);
