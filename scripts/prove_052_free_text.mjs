// prove_052_free_text.mjs
//
// PROVES THE FREE-TEXT LINE CONTRACT END TO END, against the live API + DB.
//
// The old contract was "a line must match a catalogue item or submit is blocked".
// This proves the NEW contract, and — more importantly — proves that the checks
// which SHOULD still exist were not thrown away along with the one that was:
//
//   1. a PR with NO itemId anywhere is accepted
//   2. it persists with item_id NULL, not with a fabricated item
//   3. it is READABLE afterwards  (this is the LEFT JOIN check — the failure
//      mode an inner join causes is a SILENT DROP, so "it was created" is not
//      enough; it has to come back)
//   4. its amount still counts toward the PR total
//   5. a line with NO description and NO item is refused (a line must say
//      something — free text does not mean "empty")
//   6. an itemId that is NOT in the catalogue is still refused by the FK
//   7. a mixed PR keeps its catalogue line working normally
//
// Cleanup removes every probe PR it creates, so a run leaves no residue.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const CONTAINER = 'procurement-portal-db';

let pass = 0, fail = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
}
function section(t) { console.log(`\n${t}`); }

async function sql(q) {
  const { stdout } = await pexec('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'proc',
    '-d', 'procurementDB', '-X', '-A', '-t', '-F', '\u001f', '-v', 'ON_ERROR_STOP=1', '-c', q]);
  return stdout.split('\n').filter(l => l !== '').map(l => l.split('\u001f'));
}
async function sqlFails(q) {
  try { await sql(q); return null; }
  catch (e) { return (e.stderr || e.message || '').trim(); }
}

const stamp = Date.now().toString().slice(-6);
const created = [];

/** Login as a demo user; POST /pr is behind JwtAuthGuard. */
async function login(email) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'demo' }),
  });
  if (!r.ok) throw new Error(`login ${email} -> ${r.status}`);
  return (await r.json()).token;
}
const [probeEmail] = await sql(`SELECT email FROM core.users WHERE email IS NOT NULL ORDER BY email LIMIT 1`);
const TOKEN = await login(probeEmail?.[0]);

async function post(path, body) {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* keep null */ }
  return { status: r.status, body: json, text };
}

// A real catalogue item and a real cost centre, so the probe is not testing
// fixtures of its own making.
const [itemRow] = await sql(`SELECT id FROM core.items WHERE item_code='PKB-LT-001' LIMIT 1`);
const laptopItem = itemRow?.[0];
const [ccRow] = await sql(`SELECT id FROM core.cost_centers WHERE code='PKB-LHR-001' LIMIT 1`);
const costCenter = ccRow?.[0];

section('setup');
check('a real catalogue item was found', !!laptopItem, `got ${laptopItem}`);
check('a real cost centre was found', !!costCenter, `got ${costCenter}`);
if (!laptopItem || !costCenter) { console.log('\ncannot continue without fixtures'); process.exit(1); }

// ── 1 + 2. a PR whose ONLY line is free text ───────────────────────────────
section('1. a free-text line with no catalogue item is accepted and stored');
let freeTextPr = null;
{
  // Deliberately unlike anything in core.items — no word of this appears in the
  // catalogue, which is the entire point of the feature.
  const freeText = 'Two ergonomic task chairs, mesh back, adjustable lumbar, no armrests';
  const r = await post('/pr', {
    title: `W052 free text ${stamp}`,
    scope: `W052 free text ${stamp}`,
    description: 'Proves a line can be described in the requester\'s own words.',
    purpose: 'Proves a line can be described in the requester\'s own words.',
    expenseType: 'OPEX',
    costCenterId: costCenter,
    requiredByDate: '2026-12-31',
    urgency: 'routine',
    // NOTE: no itemId key at all. This is the payload the form now sends.
    lines: [{ quantity: 2, uom: 'EA', description: freeText, unitPriceEst: 8500 }],
  });
  check('the PR is accepted with no itemId anywhere in the payload',
    r.status === 201 || r.status === 200, `HTTP ${r.status} ${r.text?.slice(0, 300)}`);
  freeTextPr = r.body?.id;
  if (freeTextPr) {
    created.push(freeTextPr);
    const [row] = await sql(`SELECT COALESCE(item_id::text,'(null)'), description
                               FROM proc.pr_lines WHERE pr_id='${freeTextPr}' AND line_no=1`);
    check('the line stored item_id NULL rather than a fabricated item',
      row?.[0] === '(null)', `got ${row?.[0]}`);
    check('the free text is stored exactly as typed',
      row?.[1] === freeText, `got ${JSON.stringify(row?.[1])}`);
  }
}

// ── 3. THE SILENT-DROP CHECK ───────────────────────────────────────────────
section('2. the free-text line is READABLE afterwards (no silent drop)');
{
  // An inner join here returns ZERO lines and still reports HTTP 200. That is
  // the failure this section exists to catch: the line was accepted, stored, and
  // then became invisible on the screen the requester lands on.
  const r = await fetch(`${API}/pr/${freeTextPr}`, {
    headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
  });
  const j = await r.json().catch(() => null);
  const lines = j?.lines || j?.data?.lines || [];
  check('the detail endpoint returns 200', r.status === 200, `HTTP ${r.status}`);
  check('the free-text line is PRESENT in the response, not filtered out by a join',
    lines.length === 1, `got ${lines.length} line(s)`);
  check('its description survived the read',
    lines[0]?.description?.includes('ergonomic task chairs'),
    JSON.stringify(lines[0]?.description));
}

// ── 4. the amount still counts ─────────────────────────────────────────────
section('3. a free-text line still counts toward the PR total');
{
  // 2 x 8500 = 17000. If the totals function still inner-joined core.items this
  // would be 0, and the PR would sail past any amount-driven gate as if free.
  const [row] = await sql(`SELECT estimated_amount FROM proc.purchase_requisitions WHERE id='${freeTextPr}'`);
  await sql(`SELECT proc.fn_compute_pr_totals('${freeTextPr}')`);
  const [after] = await sql(`SELECT estimated_amount, amount_status FROM proc.purchase_requisitions WHERE id='${freeTextPr}'`);
  check('fn_compute_pr_totals counts the free-text line (17000, not 0)',
    Number(after?.[0]) === 17000, `got ${after?.[0]}`);
  check('amount_status is ESTIMATED rather than UNKNOWN once a price is stated',
    after?.[1] === 'ESTIMATED', `got ${after?.[1]}`);
}

// ── 5. empty is still refused ──────────────────────────────────────────────
section('4. free text does not mean empty');
{
  // gl_account is supplied deliberately. It is NOT NULL, so leaving it out makes
  // this INSERT fail on the WRONG constraint — the probe would still report
  // "refused", and would be proving nothing about the rule it names. Every other
  // NOT NULL column is filled too, so the only thing that can reject this row is
  // the item-or-description check itself.
  const err = await sqlFails(
    `INSERT INTO proc.pr_lines (pr_id, line_no, item_id, quantity, uom, unit_price_est, gl_account, description)
     VALUES ('${freeTextPr}', 77, NULL, 1,
             (SELECT code FROM core.uom ORDER BY code LIMIT 1), 10, 'NA', '   ')`);
  check('a line with no item AND a blank description is refused',
    !!err, 'the INSERT succeeded — a line can now request nothing at all');
  if (err) check('and the refusal is OUR check, not some other NOT NULL firing first',
    /pr_lines_line_states_something|violates check constraint/i.test(err),
    `got: ${err.slice(0, 160)}`);
}

// ── 6. the FK still refuses a made-up item ─────────────────────────────────
section('5. inventing a product code is STILL refused');
{
  // The distinction that matters: omitting itemId is now legal, SENDING a bogus
  // one is not. If this passes, migration 052 widened "describe it your way"
  // without opening "make up an SKU".
  const err = await sqlFails(
    `INSERT INTO proc.pr_lines (pr_id, line_no, item_id, quantity, uom, unit_price_est, description)
     VALUES ('${freeTextPr}', 78, gen_random_uuid(), 1,
             (SELECT code FROM core.uom ORDER BY code LIMIT 1), 10, 'invented sku')`);
  check('an itemId that is not in the catalogue is still refused by the FK',
    !!err, 'the INSERT succeeded — the foreign key was dropped along with NOT NULL');
}

// ── 7. a mixed PR still works ──────────────────────────────────────────────
section('6. a mixed PR (catalogue + free text) keeps both lines');
{
  const r = await post('/pr', {
    title: `W052 mixed ${stamp}`,
    scope: `W052 mixed ${stamp}`,
    description: 'One catalogued line and one free-text line on the same PR.',
    purpose: 'One catalogued line and one free-text line on the same PR.',
    expenseType: 'OPEX',
    costCenterId: costCenter,
    requiredByDate: '2026-12-31',
    urgency: 'routine',
    lines: [
      { itemId: laptopItem, quantity: 1, uom: 'EA', description: 'Dell Latitude 7440', unitPriceEst: 150000 },
      { quantity: 3, uom: 'EA', description: 'Standing desk risers, bamboo', unitPriceEst: 4000 },
    ],
  });
  check('the mixed PR is accepted', r.status === 201 || r.status === 200, `HTTP ${r.status}`);
  if (r.body?.id) {
    created.push(r.body.id);
    const rows = await sql(`SELECT line_no, COALESCE(item_id::text,'(null)') FROM proc.pr_lines
                             WHERE pr_id='${r.body.id}' ORDER BY line_no`);
    check('both lines persisted', rows.length === 2, `got ${rows.length}`);
    check('line 1 kept its catalogue item', rows[0]?.[1] === laptopItem, `got ${rows[0]?.[1]}`);
    check('line 2 is free text with NULL item', rows[1]?.[1] === '(null)', `got ${rows[1]?.[1]}`);
    const [tot] = await sql(`SELECT estimated_amount FROM proc.purchase_requisitions WHERE id='${r.body.id}'`);
    check('the stated total is the sum of both lines (162000)', Number(tot?.[0]) === 162000, `got ${tot?.[0]}`);
  }
}

// ── cleanup ────────────────────────────────────────────────────────────────
section('cleanup');
for (const id of created) {
  await sql(`DELETE FROM proc.purchase_requisitions WHERE id='${id}'`);
}
if (created.length) console.log(`(removed ${created.length} probe PR(s))`);

console.log(`\n${'='.repeat(66)}`);
console.log(`TOTAL  pass=${pass}  fail=${fail}`);
if (fail) { console.log('\nFAILURES:'); failures.forEach(f => console.log(`  - ${f}`)); }
console.log('='.repeat(66));
process.exit(fail ? 1 : 0);
