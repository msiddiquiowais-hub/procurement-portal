// ─────────────────────────────────────────────────────────────────────────────
// prove_w5k_category_admin.mjs
//
// Proves the two category-management surfaces the brief asked for, and — because
// the risk here is silent routing — proves they cannot quietly make a category
// routable when it is not.
//
//   A. The admin API lists categories with the facts an admin needs, including
//      whether each one can actually be routed.
//   B. Create -> the row is immediately in the /pr/new dropdown.
//   C. Edit name/description -> reflected immediately.
//   D. Deactivate/delete is refused WITH COUNTS when the category is in use.
//   E. Bulk import: whole-file validation, refused atomically on a bad row.
//   F. The CSV parser survives the cases Excel actually produces.
//   G. Nothing here weakened an existing validation, and the engine vocabulary
//      is unchanged.
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LIGHT_ITEM_CATEGORY_IDS } from '../packages/workflow-engine/dist/index.js';

const pexec = promisify(execFile);
const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const CONTAINER = 'procurement-portal-db';

let pass = 0, fail = 0;
const failures = [];
const created = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 58 - t.length))}`); }

async function sql(query) {
  const { stdout } = await pexec('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'proc', '-d',
    'procurementDB', '-X', '-q', '-A', '-t', '-F', '|', '-c', query]);
  return stdout.split('\n').map(s => s.trim()).filter(Boolean);
}
const rows = async q => (await sql(q)).map(r => r.split('|'));

async function login(email) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'demo' }),
  });
  if (!r.ok) throw new Error(`login ${email} -> ${r.status}`);
  return (await r.json()).token;
}
const call = (token) => async (path, init = {}) => {
  const r = await fetch(`${API}${path}`, {
    ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const stamp = Date.now().toString().slice(-7);

console.log('=== W5-K: category admin + bulk import ===\n');

const adminTok = await login('procurement@pakboxes.pk');
const requesterTok = await login('requester@pakboxes.pk');
const admin = call(adminTok);
const asRequester = call(requesterTok);

// ── A. the list carries the fact that matters ────────────────────────────────
section('A. the admin list says which categories can actually be routed');
{
  const r = await admin('/admin/categories');
  check('the endpoint responds 200', r.status === 200, `HTTP ${r.status}`);
  const cats = r.body?.categories || [];
  check('it returns the vocabulary', cats.length >= 9, `got ${cats.length}`);
  check('every row carries a routable flag', cats.every(c => typeof c.routable === 'boolean'));
  check('every row carries its usage counts',
    cats.every(c => Number.isFinite(c.itemCount) && Number.isFinite(c.lineCount)));
  check('the seeded vocabulary is all routable',
    cats.filter(c => LIGHT_ITEM_CATEGORY_IDS.includes(c.code)).every(c => c.routable === true),
    'an engine category was reported as unroutable');
  check('the engine vocabulary is unchanged by this work',
    LIGHT_ITEM_CATEGORY_IDS.length === 9, `engine now has ${LIGHT_ITEM_CATEGORY_IDS.length}`);

  // The role gate must actually gate.
  check('a requester is refused the admin list',
    (await asRequester('/admin/categories')).status === 403);
  check('a requester is refused a create',
    (await asRequester('/admin/categories', { method: 'POST', body: JSON.stringify({ code: 'X_NOPE', name: 'Nope' }) })).status === 403);
}

// ── B. create, and it is instantly in the dropdown ───────────────────────────
section('B. a new category is selectable on /pr/new immediately');
{
  const code = `W5K_NEW_${stamp}`;
  const r = await admin('/admin/categories', {
    method: 'POST', body: JSON.stringify({ code, name: `Probe ${stamp}`, description: 'Created by prove_w5k.' }),
  });
  check('the create is accepted', r.status === 201 || r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
  created.push(code);
  check('the response flags it as NOT routable', r.body?.routable === false, `routable=${r.body?.routable}`);
  check('and explains why, in words', /LIGHT_ITEM_CATEGORIES/.test(String(r.body?.warning || '')),
    `warning=${r.body?.warning}`);

  const lookup = await asRequester('/lookups/categories');
  check('it is in the PR dropdown at once',
    (lookup.body || []).some(c => c.code === code), 'not present in /lookups/categories');
  check('the dropdown shows its name AND description',
    (lookup.body || []).find(c => c.code === code)?.description === 'Created by prove_w5k.');
}

// ── C. edit propagates ───────────────────────────────────────────────────────
section('C. an edit is reflected at once');
{
  const code = created[0];
  const r = await admin(`/admin/categories/${code}`, {
    method: 'PUT', body: JSON.stringify({ name: 'Renamed probe', description: 'Edited description.' }),
  });
  check('the edit is accepted', r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
  const lookup = await asRequester('/lookups/categories');
  const row = (lookup.body || []).find(c => c.code === code);
  check('the new name is live in the dropdown', row?.name === 'Renamed probe', `got ${row?.name}`);
  check('the new description is live in the dropdown', row?.description === 'Edited description.');

  // The FK is a VOCABULARY constraint, not a routing one: it accepts any code
  // this table lists, including one the engine cannot route. That is intended —
  // it stops a typo becoming an unroutable line. So assert both halves: the FK
  // still refuses an unlisted code, and the new code really is unroutable in
  // fact, not merely badged as such in the UI.
  const unknownRefused = await sqlExpectingFailure(
    `UPDATE proc.pr_lines SET category='W5K_NOT_A_CATEGORY' WHERE id=(SELECT min(id) FROM proc.pr_lines)`);
  check('the FK still refuses a category that is not in the table', !!unknownRefused,
    'the UPDATE succeeded — the vocabulary constraint is gone');

  const inRules = await sql(`
    SELECT count(*) FROM workflow.steps_config s, jsonb_array_elements(s.payload->'lineRules') rule
     WHERE rule->'category' ? '${code}'`);
  check('and the new code matches no live line rule, as the badge claims',
    inRules[0] === '0', `${inRules[0]} rule(s) reference it`);
  check('and the engine vocabulary was not quietly extended',
    !LIGHT_ITEM_CATEGORY_IDS.includes(code), 'the new code leaked into the engine list');
}

// ── D. in-use protection ─────────────────────────────────────────────────────
section('D. an in-use category cannot be deleted or deactivated');
{
  const [inUse] = await sql(`SELECT category FROM proc.pr_lines WHERE category IS NOT NULL LIMIT 1`);
  if (!inUse) check('a stored line with a category exists to test against', false, 'none found');
  else {
    const del = await admin(`/admin/categories/${inUse}`, { method: 'DELETE' });
    check('delete is refused with a 400', del.status === 400, `HTTP ${del.status}`);
    check('and the refusal names the dependent line count',
      /stored line\(s\)/.test(String(del.body?.message || '')), String(del.body?.message));
    const off = await admin(`/admin/categories/${inUse}`, { method: 'PUT', body: JSON.stringify({ active: false }) });
    check('deactivate is refused with a 400', off.status === 400, `HTTP ${off.status}`);
    const still = await admin('/admin/categories');
    check('and the row is still active afterwards',
      still.body?.categories?.find(c => c.code === inUse)?.active === true);
  }
  // An unused one CAN be removed, or the screen would be read-only.
  const del = await admin(`/admin/categories/${created[0]}`, { method: 'DELETE' });
  check('an unused category CAN be deleted', del.status === 200, `HTTP ${del.status} ${JSON.stringify(del.body)}`);
  if (del.status === 200) created.splice(created.indexOf(created[0]), 1);
}

// ── E. bulk import is atomic ─────────────────────────────────────────────────
section('E. bulk import validates the whole file before writing anything');
{
  const good = `W5K_A_${stamp},Alpha,First imported row\nW5K_B_${stamp},Beta,Second imported row`;
  const r = await admin('/admin/categories/import', {
    method: 'POST', body: JSON.stringify({ csv: `code,name,description\n${good}`, mode: 'merge' }),
  });
  check('a valid file is imported', r.status === 201 || r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
  check('both rows were created', r.body?.createdCount === 2, JSON.stringify(r.body?.created));
  check('and both are reported as unroutable',
    r.body?.unroutable?.length === 2, JSON.stringify(r.body?.unroutable));
  check('a warning explains the routability gap', /LIGHT_ITEM_CATEGORIES/.test(String(r.body?.warning || '')));
  created.push(`W5K_A_${stamp}`, `W5K_B_${stamp}`);

  // One bad row must refuse the WHOLE file, not the good rows in it.
  const mixed = `code,name,description\nW5K_OK_${stamp},Fine,This row is valid\nnot a code!,Bad,This row is not`;
  const before = (await sql(`SELECT count(*) FROM core.categories`))[0];
  const bad = await admin('/admin/categories/import', {
    method: 'POST', body: JSON.stringify({ csv: mixed, mode: 'merge' }),
  });
  check('a file containing a bad row is refused', bad.status === 400, `HTTP ${bad.status}`);
  check('the refusal names the line number', /line 3/.test(String(bad.body?.message || '')), String(bad.body?.message));
  const after = (await sql(`SELECT count(*) FROM core.categories`))[0];
  check('and NOT ONE row from that file was written', before === after, `${before} before, ${after} after`);
  check('the valid row from the refused file is absent',
    !(await sql(`SELECT code FROM core.categories WHERE code='W5K_OK_${stamp}'`)).length);

  // A missing header is refused rather than guessed at.
  const noHeader = await admin('/admin/categories/import', {
    method: 'POST', body: JSON.stringify({ csv: 'JUST,SOME,DATA', mode: 'merge' }),
  });
  check('a file with no code/name header is refused', noHeader.status === 400, `HTTP ${noHeader.status}`);
}

// ── F. the CSV parser survives what Excel produces ───────────────────────────
section('F. CSV parsing handles quoting, CRLF and embedded commas');
{
  // Escaped quotes, an embedded comma, CRLF, and a UTF-8 BOM — the four things
  // Excel actually emits. Every field containing a comma is QUOTED, because an
  // unquoted one is not valid CSV; that case is asserted separately below rather
  // than smuggled in here.
  const csv =
    '﻿' +
    'code,name,description\r\n' +
    `W5K_Q_${stamp},"Quoted ""name"", with comma","Has a comma, a ""quote"", and a semicolon; too"\r\n` +
    `W5K_R_${stamp},Plain,Simple row\r\n`;
  const r = await admin('/admin/categories/import', {
    method: 'POST', body: JSON.stringify({ csv, mode: 'merge' }),
  });
  check('the awkward file imports', r.status === 201 || r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
  created.push(`W5K_Q_${stamp}`, `W5K_R_${stamp}`);

  const stored = await rows(
    `SELECT name, description FROM core.categories WHERE code='W5K_Q_${stamp}'`);
  check('the BOM did not corrupt the first column', stored.length === 1, `found ${stored.length} row(s)`);
  check('the escaped quotes round-tripped', stored[0]?.[0] === 'Quoted "name", with comma',
    JSON.stringify(stored[0]?.[0]));
  check('the embedded comma, quote and semicolon all survived',
    stored[0]?.[1] === 'Has a comma, a "quote", and a semicolon; too',
    JSON.stringify(stored[0]?.[1]));

  // The realistic mistake: a description with a comma that nobody quoted. The
  // parser cannot repair it, so it must REFUSE the row — silently keeping
  // "Has a comma" as the description would look like a real, shorter one.
  const unquoted = `code,name,description\nW5K_U_${stamp},Bad commas,Has a comma, then more text`;
  const uq = await admin('/admin/categories/import', {
    method: 'POST', body: JSON.stringify({ csv: unquoted, mode: 'merge' }),
  });
  check('an unquoted comma in a description is refused, not silently truncated',
    uq.status === 400, `HTTP ${uq.status}`);
  check('and the refusal says to quote the value',
    /unquoted comma/i.test(String(uq.body?.message || '')), String(uq.body?.message));
  check('and the truncated row was not written',
    !(await sql(`SELECT code FROM core.categories WHERE code='W5K_U_${stamp}'`)).length);

  // insert-only must not overwrite.
  const ins = await admin('/admin/categories/import', {
    method: 'POST',
    body: JSON.stringify({ csv: `code,name,description\nW5K_R_${stamp},OVERWRITTEN,Should not land`, mode: 'insert' }),
  });
  check('insert-only mode skips an existing code', ins.body?.skippedCount === 1, JSON.stringify(ins.body?.skipped));
  const afterIns = await rows(`SELECT name FROM core.categories WHERE code='W5K_R_${stamp}'`);
  check('and leaves the existing row untouched', afterIns[0]?.[0] !== 'OVERWRITTEN', afterIns[0]?.[0]);
}

// ── G. no existing validation weakened ───────────────────────────────────────
section('G. the engine vocabulary and the dropdown contract are intact');
{
  const lookup = await asRequester('/lookups/categories');
  const db = await rows(`SELECT code FROM core.categories WHERE active ORDER BY code`);
  const dbActive = db.map(r => r[0]);
  check('the dropdown offers exactly the active rows in the table',
    (lookup.body || []).map(c => c.code).sort().join(',') === dbActive.slice().sort().join(','),
    `api=${(lookup.body || []).length} db=${dbActive.length}`);
  check('every engine category is still offered',
    LIGHT_ITEM_CATEGORY_IDS.every(c => dbActive.includes(c)),
    `missing: ${LIGHT_ITEM_CATEGORY_IDS.filter(c => !dbActive.includes(c)).join(', ')}`);
}

// ── cleanup ───────────────────────────────────────────────────────────────────
section('cleanup');
for (const code of created) {
  await sql(`DELETE FROM core.categories WHERE code='${code}'`);
}
const left = (await sql(`SELECT count(*) FROM core.categories WHERE code LIKE 'W5K\\_%' OR code LIKE 'TEST\\_%'`))[0];
check('every probe category was removed', left === '0', `${left} left behind`);
console.log(`  (removed ${created.length} probe categor(ies))`);

console.log(`\n${'='.repeat(64)}`);
console.log(`TOTAL  pass=${pass}  fail=${fail}`);
if (fail) { console.log('\nFAILURES:'); failures.forEach(f => console.log(`  - ${f}`)); }
console.log('='.repeat(64));
process.exit(fail ? 1 : 0);

async function sqlExpectingFailure(query) {
  try { await sql(query); return null; } catch (e) { return String(e.message || e); }
}
