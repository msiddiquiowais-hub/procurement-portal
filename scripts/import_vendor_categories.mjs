// ─────────────────────────────────────────────────────────────────────────────
// import_vendor_categories.mjs — bulk-load vendor <-> item-group mappings.
//
//   node scripts/import_vendor_categories.mjs <file.csv> [--dry-run] [--insert]
//                                               [--skip-invalid]
//
// Also reachable as:
//   npm run import:vendor-categories -- <file.csv> [--dry-run]
//
// WHY A SCRIPT AND NOT JUST A SCREEN
// ----------------------------------
// Same reasoning as import_categories.mjs: a mapping file arrives with a vendor
// migration or a supplier master from head office, and the laptop that can run
// `node` is not always the laptop with a browser session. Both paths post to the
// SAME endpoint (POST /vendors/categories/import), so there is one parser and
// one set of validations.
//
// ─── THE TWO VOCABULARIES ───────────────────────────────────────────────────
//
//   vendor_code   V-00081        core.vendors.vendor_code
//   category    IG-OFC         core.dimension_values, dimension_key='ItemGroup'
//   is_active     true|false     (default true)
//
// `category` accepts the code OR the display name ("Office Supplies"), because
// a file from head office is as likely to carry one as the other.
//
// It is an ITEM GROUP and NOT a PR line category. OFFICE_SUPPLIES is a line
// category (core.categories) and is NOT a vendor vocabulary; a row naming one is
// rejected by line number rather than silently stored.
//
// ─── WHAT IT WILL NOT LET YOU DO ────────────────────────────────────────────
//
// Import a mapping and believe the vendor now routes. A link makes a vendor
// ELIGIBLE for automatic RFQs for that group. It does not invite them, does not
// override the risk/hold/blacklist gates, and does not reach back into D365.
//
// ─── DRY RUN IS THE DEFAULT-SAFE PATH ────────────────────────────────────────
//
// --dry-run validates and reports without writing. Run it first; it is free.
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const CONTAINER = process.env.DB_CONTAINER || 'procurement-portal-db';
const ROLE = process.env.CSV_ROLE || 'procurement@pakboxes.pk';
const PASSWORD = process.env.CSV_PASSWORD || 'demo';

// The vendored exit handling from import_categories.mjs: unwind by throwing so
// the event loop can drain. process.exit() on Windows tears down a live fetch
// handle and libuv aborts the process with an assertion failure — a CI job then
// reads a segfault instead of the 400 the script actually reported.
class ExitSignal extends Error {
  constructor(code) { super(`exit:${code}`); this.code = code; }
}
function finish(code) {
  process.exitCode = code;
  throw new ExitSignal(code);
}

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const dryRun = argv.includes('--dry-run');
const insertOnly = argv.includes('--insert');
const skipInvalid = argv.includes('--skip-invalid');

if (!file) {
  console.error(
    'usage: node scripts/import_vendor_categories.mjs <file.csv> [--dry-run] [--insert] ' +
    '[--skip-invalid]\n\n' +
    '  header          vendor_code,category,is_active\n' +
    '  --dry-run       validate and report, write nothing (recommended first)\n' +
    '  --insert        never change an existing link; report it instead\n' +
    '  --skip-invalid  import the valid rows and list the rejected ones\n\n' +
    'env: API_BASE, DB_CONTAINER, CSV_ROLE, CSV_PASSWORD',
  );
  process.exitCode = 2;
} else {
  await main();
}

async function main() {
  async function sql(query) {
    const { stdout } = await pexec('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'proc', '-d',
      'procurementDB', '-X', '-q', '-A', '-t', '-F', '|', '-c', query]);
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  async function login() {
    const r = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ROLE, password: PASSWORD }),
    });
    if (!r.ok) throw new Error(`login as ${ROLE} failed: HTTP ${r.status}. Is the API running on ${API}?`);
    return (await r.json()).token;
  }

  let csv;
  try {
    csv = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`cannot read ${file}: ${e.message}`);
    process.exitCode = 2;
    return;
  }

  console.log('=== import_vendor_categories ===');
  console.log(`file        ${file}`);
  console.log(`mode        ${insertOnly ? 'insert only (never change an existing link)' : 'merge (create missing, change existing)'}`);
  console.log(`write       ${dryRun ? 'NO — dry run' : 'yes'}`);
  console.log(`skipInvalid ${skipInvalid ? 'yes' : 'no'}`);

  // ── dry run ────────────────────────────────────────────────────────────────
  // The database is read DIRECTLY rather than by calling the import endpoint,
  // because calling it would COMMIT. A "dry run" that writes is worse than none.
  if (dryRun) {
    const incoming = parseMappingCsv(csv);
    if (!incoming.rows.length) {
      console.error('no data rows found — the CSV needs a header: vendor_code,category,is_active');
      process.exitCode = 2;
      return;
    }

    const vendorIds = new Map(
      (await sql('SELECT vendor_code, id FROM core.vendors'))
        .map((r) => r.split('|').map((s) => s.trim()))
        .map(([code, id]) => [code.toUpperCase(), id]));
    const groups = (await sql(`SELECT code, name FROM core.dimension_values
                               WHERE dimension_key='ItemGroup'`))
      .map((r) => r.split('|').map((s) => s.trim()));
    const groupIds = new Map();
    for (const [code, name] of groups) {
      groupIds.set(code.toUpperCase(), code);
      groupIds.set(name.toUpperCase(), code);
    }
    const links = new Set(
      (await sql(`SELECT v.vendor_code, dv.code
                    FROM core.vendor_categories vc
                    JOIN core.vendors v ON v.id = vc.vendor_id
                    JOIN core.dimension_values dv ON dv.id = vc.category_id
                   WHERE dv.dimension_key='ItemGroup'`))
        .map((r) => {
          const [vc, gc] = r.split('|').map((s) => s.trim());
          return `${vc.toUpperCase()}/${gc.toUpperCase()}`;
        }));

    const truthy = new Set(['TRUE', 'YES', 'Y', '1', 'ACTIVE', 'ON']);
    const falsy = new Set(['FALSE', 'NO', 'N', '0', 'INACTIVE', 'OFF']);

    const problems = [];
    const newRows = [], updateRows = [], skipRows = [], offRows = [];
    const seen = new Set();

    incoming.rows.forEach((row, i) => {
      const line = i + 2;
      const vendorCode = String(row.vendorCode || '').trim().toUpperCase();
      const groupRaw = String(row.category || '').trim().toUpperCase();
      if (!vendorCode && !groupRaw) return;
      if (!vendorCode) { problems.push(`line ${line}: no vendor_code`); return; }
      if (!groupRaw) { problems.push(`line ${line}: ${vendorCode} has no category`); return; }
      if (!vendorIds.has(vendorCode)) { problems.push(`line ${line}: no such vendor "${vendorCode}"`); return; }
      if (!groupIds.has(groupRaw)) {
        problems.push(`line ${line}: "${groupRaw}" is not a D365 line category (expected IG-*, not a PR line category)`);
        return;
      }
      const groupCode = groupIds.get(groupRaw);
      const rawActive = String(row.isActive || '').trim().toUpperCase();
      let isActive = true;
      if (rawActive) {
        if (truthy.has(rawActive)) isActive = true;
        else if (falsy.has(rawActive)) isActive = false;
        else { problems.push(`line ${line}: is_active "${rawActive}" is not a boolean`); return; }
      }
      const pair = `${vendorCode}/${groupCode}`;
      if (seen.has(pair)) { problems.push(`line ${line}: duplicate row for ${pair} in this file`); return; }
      seen.add(pair);
      if (!isActive) offRows.push(pair);
      else if (links.has(pair)) (insertOnly ? skipRows : updateRows).push(pair);
      else newRows.push(pair);
    });

    console.log(`\nrows        ${incoming.rows.filter((r) => String(r.vendorCode || '').trim()).length}`);
    console.log(`new         ${newRows.length}${newRows.length ? ': ' + newRows.join(', ') : ''}`);
    console.log(`update      ${updateRows.length}${updateRows.length ? ': ' + updateRows.join(', ') : ''}`);
    console.log(`deactivate  ${offRows.length}${offRows.length ? ': ' + offRows.join(', ') : ''}`);
    console.log(`skip        ${skipRows.length}${skipRows.length ? ': ' + skipRows.join(', ') : ''}`);
    if (problems.length) {
      console.log(`\nproblems (${problems.length}):`);
      problems.slice(0, 15).forEach((p) => console.log('  - ' + p));
    }
    console.log('\nNothing was written. Re-run without --dry-run to apply.');
    process.exitCode = problems.length ? 1 : 0;
    return;
  }

  // ── real import, through the same endpoint the admin screen uses ───────────
  const token = await login();
  const r = await fetch(`${API}/vendors/categories/import`, {
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
  console.log(`deactivated ${res.deactivatedCount}${res.deactivated?.length ? ': ' + res.deactivated.join(', ') : ''}`);
  console.log(`skipped     ${res.skippedCount}${res.skipped?.length ? ': ' + res.skipped.join(', ') : ''}`);
  if (res.errorCount) {
    console.log(`rejected    ${res.errorCount}`);
    res.errors.slice(0, 15).forEach((e) => console.log(`  - line ${e.line} (${e.vendor}): ${e.reason}`));
  }

  console.log('\nlinks in core.vendor_categories:');
  for (const line of await sql(`SELECT v.vendor_code || '  ' || dv.code ||
                                     CASE WHEN vc.is_active THEN '' ELSE '   (deactivated)' END
                                  FROM core.vendor_categories vc
                                  JOIN core.vendors v ON v.id = vc.vendor_id
                                  JOIN core.dimension_values dv ON dv.id = vc.category_id
                                 WHERE dv.dimension_key='ItemGroup'
                                  ORDER BY v.vendor_code, dv.code`)) {
    console.log('  ' + line);
  }
}

// ── CSV reader, matching the server's RFC 4180 parser ───────────────────────
// Duplicated ONLY for the dry-run path, which by definition cannot call the
// endpoint. The committed import always goes through the server, so the two
// parsers cannot disagree about anything that reaches the database.
function parseMappingCsv(text) {
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
  const vendorAt = headers.indexOf('vendorcode');
  const groupAt = headers.indexOf('itemgroup');
  const activeAt = headers.indexOf('isactive');
  if (vendorAt < 0 || groupAt < 0) {
    console.error(`header must contain "vendor_code" and "category"; found: ${recs[0].join(', ')}`);
    process.exitCode = 2;
    return { rows: [] };
  }
  return {
    rows: recs.slice(1).map((r) => ({
      vendorCode: r[vendorAt] ?? '',
      category: r[groupAt] ?? '',
      isActive: activeAt >= 0 ? (r[activeAt] ?? '') : '',
    })),
  };
}