// ─────────────────────────────────────────────────────────────────────────────
// import_categories.mjs — bulk-load core.categories from a CSV file.
//
//   node scripts/import_categories.mjs <file.csv> [--dry-run] [--insert]
//
// Also reachable as:  npm run import:categories -- <file.csv> [--dry-run]
//
// WHY A SCRIPT AND NOT JUST A SCREEN
// ----------------------------------
// The admin screen can paste CSV, but a script is the thing you can run from a
// migration, a scheduled job, or a laptop that has the repo but no browser. Both
// paths post to the SAME endpoint (POST /admin/categories/import), so they share
// one parser and one set of validations. Two implementations would drift, and the
// drift would show up as "the import worked in the screen but not on the server".
//
// ─── WHAT IT WILL NOT LET YOU DO ─────────────────────────────────────────────
//
// Import a category and believe it is now routed. A row in core.categories makes
// a category SELECTABLE on /pr/new and satisfies the proc.pr_lines.category
// foreign key — and nothing more. Routing is decided by the workflow engine, and
// a line rule only fires for a code in LIGHT_ITEM_CATEGORY_IDS. An unroutable
// category is accepted on a line and then matches no rule, so the line is never
// rejected and never routed.
//
// So this script exits NON-ZERO when any imported code is unroutable. That is
// not a failure of the import — the rows are committed — it is the script
// refusing to report success while something the operator needs to know is
// unresolved. Use --allow-unroutable when you genuinely only want the rows.
//
// ─── DRY RUN IS THE DEFAULT-SAFE PATH ────────────────────────────────────────
//
// --dry-run validates and reports without writing. Run it first; it is free.
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { LIGHT_ITEM_CATEGORY_IDS } from '../packages/workflow-engine/dist/index.js';

const pexec = promisify(execFile);
const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const CONTAINER = process.env.DB_CONTAINER || 'procurement-portal-db';
const ROLES = (process.env.CSV_ROLE || 'procurement@pakboxes.pk');
const PASSWORD = process.env.CSV_PASSWORD || 'demo';

// ── exit handling ─────────────────────────────────────────────────────────────
//
// `finish()` sets the exit code and unwinds by throwing, so the process is
// allowed to END ON ITS OWN.
//
// It deliberately does not call process.exit(). On Windows that aborts while a
// handle is still closing and libuv trips
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)
// so the script printed a correct, useful answer and then died with a crash exit
// code — which a CI job reads as a segfault rather than as the 400 it actually
// reported. fetch's connection pool is the handle that stays open; letting the
// event loop drain avoids both the crash and the truncated output.
class ExitSignal extends Error {
  constructor(code) { super(`exit:${code}`); this.code = code; }
}
function finish(code) {
  process.exitCode = code;
  throw new ExitSignal(code);
}

// ── arguments ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const dryRun = argv.includes('--dry-run');
const insertOnly = argv.includes('--insert');
const allowUnroutable = argv.includes('--allow-unroutable');
const skipInvalid = argv.includes('--skip-invalid');

if (!file) {
  console.error(
    'usage: node scripts/import_categories.mjs <file.csv> [--dry-run] [--insert] ' +
    '[--skip-invalid] [--allow-unroutable]\n\n' +
    '  --dry-run           validate and report, write nothing (recommended first)\n' +
    '  --insert            never overwrite an existing code; report it instead\n' +
    '  --skip-invalid      import the valid rows and list the rejected ones\n' +
    '  --allow-unroutable  exit 0 even if some rows match no approval rule\n\n' +
    'env: API_BASE, DB_CONTAINER, CSV_ROLE, CSV_PASSWORD',
  );
  process.exitCode = 2;   // nothing has been opened yet, so exiting here is safe
} else {
  await main();
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  // ── helpers ─────────────────────────────────────────────────────────────────
  async function sql(query) {
    const { stdout } = await pexec('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'proc', '-d',
      'procurementDB', '-X', '-q', '-A', '-t', '-F', '|', '-c', query]);
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  async function login() {
    const r = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ROLES, password: PASSWORD }),
    });
    if (!r.ok) throw new Error(`login as ${ROLES} failed: HTTP ${r.status}. Is the API running on ${API}?`);
    return (await r.json()).token;
  }

  // ── read the file ───────────────────────────────────────────────────────────
  let csv;
  try {
    csv = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`cannot read ${file}: ${e.message}`);
    process.exitCode = 2;
    return;
  }

  console.log(`=== import_categories ===`);
  console.log(`file        ${file}`);
  console.log(`mode        ${insertOnly ? 'insert only (never overwrite)' : 'merge (insert new, update existing)'}`);
  console.log(`write       ${dryRun ? 'NO — dry run' : 'yes'}`);
  console.log(`skipInvalid ${skipInvalid ? 'yes' : 'no'}`);

  // ── dry run ────────────────────────────────────────────────────────────────
  // The database is asked directly rather than by calling the import endpoint,
  // because calling it would COMMIT the rows. That is the whole difference a dry
  // run has to get right: a "dry run" that writes is worse than no dry run.
  if (dryRun) {
    const incoming = parseCsv(csv);
    if (!incoming.rows.length) {
      console.error('no data rows found — the CSV needs a header row: code,name,description');
      process.exitCode = 2;
      return;
    }
    const existing = new Set((await sql(`SELECT code FROM core.categories`))
      .map((r) => r.replace(/^\|+|\|+$/g, '')));
    const engine = new Set(LIGHT_ITEM_CATEGORY_IDS);

    const problems = [];
    const newCodes = [], updateCodes = [], skipCodes = [], unroutable = [];
    incoming.rows.forEach((row, i) => {
      const line = i + 2;
      const code = String(row.code || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
      if (!code) return;
      const name = String(row.name || '').trim();
      if (!/^[A-Z0-9_]+$/.test(code)) { problems.push(`line ${line}: "${code}" is not a usable code`); return; }
      if (!name) { problems.push(`line ${line}: ${code} has no name`); return; }
      if (existing.has(code)) { (insertOnly ? skipCodes : updateCodes).push(code); }
      else newCodes.push(code);
      if (!engine.has(code)) unroutable.push(code);
    });

    console.log(`\nrows        ${incoming.rows.filter((r) => String(r.code || '').trim()).length}`);
    console.log(`new         ${newCodes.length}${newCodes.length ? ': ' + newCodes.join(', ') : ''}`);
    console.log(`update      ${updateCodes.length}${updateCodes.length ? ': ' + updateCodes.join(', ') : ''}`);
    console.log(`skip        ${skipCodes.length}${skipCodes.length ? ': ' + skipCodes.join(', ') : ''}`);
    console.log(`unroutable  ${unroutable.length}${unroutable.length ? ': ' + unroutable.join(', ') : ''}`);
    if (problems.length) {
      console.log(`\nproblems (${problems.length}):`);
      problems.slice(0, 15).forEach((p) => console.log('  - ' + p));
    }
    if (unroutable.length) {
      console.log(`\nNOTE: these would be SELECTABLE but match no approval rule until added to`);
      console.log(`      LIGHT_ITEM_CATEGORIES in packages/workflow-engine/src/categories.ts.`);
    }
    console.log(`\nNothing was written. Re-run without --dry-run to apply.`);
    process.exitCode = problems.length ? 1 : 0;
    return;
  }

  // ── real import, through the same endpoint the admin screen uses ───────────
  const token = await login();
  const r = await fetch(`${API}/admin/categories/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ csv, mode: insertOnly ? 'insert' : 'merge', skipInvalid }),
  });

  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    console.error(`\nimport REFUSED: HTTP ${r.status}`);
    console.error(`  ${Array.isArray(body.message) ? body.message.join('; ') : body.message ?? '(no message)'}`);
    console.error('\nNothing was imported. Fix the CSV, or pass --skip-invalid to import the valid rows.');
    process.exitCode = 1;
    return;
  }

  const res = await r.json();
  console.log(`\ncreated     ${res.createdCount}${res.created?.length ? ': ' + res.created.join(', ') : ''}`);
  console.log(`updated     ${res.updatedCount}${res.updated?.length ? ': ' + res.updated.join(', ') : ''}`);
  console.log(`skipped     ${res.skippedCount}${res.skipped?.length ? ': ' + res.skipped.join(', ') : ''}`);
  if (res.errorCount) {
    console.log(`rejected    ${res.errorCount}`);
    res.errors.slice(0, 15).forEach((e) => console.log(`  - line ${e.line} (${e.code || 'blank'}): ${e.reason}`));
  }
  if (res.warning) console.log(`\nWARNING: ${res.warning}`);

  console.log('\nnow in core.categories:');
  for (const line of await sql(`SELECT code || '  ' || name FROM core.categories ORDER BY code`)) {
    console.log('  ' + line);
  }

  if (res.unroutable?.length && !allowUnroutable) {
    console.error(`\n${res.unroutable.length} imported row(s) match no approval rule yet.`);
    console.error('The rows are committed and ARE selectable on the PR form, but a line carrying them');
    console.error('will not be routed. Add them to LIGHT_ITEM_CATEGORIES in the workflow engine.');
    console.error('Pass --allow-unroutable to treat this as success.');
    process.exitCode = 1;
  }
}

// ── a small CSV reader, matching the server's parser ────────────────────────
// Duplicated deliberately ONLY for the dry-run path, which by definition cannot
// call the endpoint. The committed import always goes through the server, so the
// two parsers cannot disagree about anything that reaches the database.
function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records = [];
  let field = '', record = [], inQuotes = false, touched = false;
  const endField = () => { record.push(field); field = ''; touched = false; };
  const endRecord = () => { endField(); records.push(record); record = []; };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += ch;
      continue;
    }
    if (ch === '"' && !touched) { inQuotes = true; touched = true; continue; }
    if (ch === ',') { endField(); continue; }
    if (ch === '\r') { if (src[i + 1] === '\n') i++; endRecord(); continue; }
    if (ch === '\n') { endRecord(); continue; }
    field += ch; touched = true;
  }
  if (field.length || record.length || touched) endRecord();
  const recs = records.filter((r) => r.length > 1 || (r[0] || '').trim() !== '');
  if (!recs.length) return { rows: [] };
  const headers = recs[0].map((h) => h.trim().toLowerCase().replace(/[\s_-]+/g, ''));
  const codeAt = headers.indexOf('code');
  const nameAt = headers.indexOf('name');
  const descAt = headers.indexOf('description');
  if (codeAt < 0 || nameAt < 0) {
    console.error(`header must contain "code" and "name"; found: ${recs[0].join(', ')}`);
    process.exitCode = 2;
    return { rows: [] };
  }
  return {
    rows: recs.slice(1).map((r) => ({
      code: r[codeAt] ?? '', name: r[nameAt] ?? '', description: descAt >= 0 ? (r[descAt] ?? '') : '',
    })),
  };
}
