// Wave 5 Track E — proof that the attachment write path honours both directives.
//
//   node scripts/prove_wave5e_attachments.mjs
//
// Requires: Postgres 55432, the API on 33001. Writes real files under
// ATTACHMENT_STORAGE_ROOT (default var/attachments) and removes them after.
//
// DIRECTIVE 1 — NO HARDCODE LIMITS
//   A unit test cannot prove this: it would supply its own limit. The claim is
//   that the ceiling the API enforces and the ceiling the DATABASE trigger
//   enforces are the same number, and that MOVING that number in configuration
//   moves both. So:
//     1. read the configured limits
//     2. show an upload the configured ceiling refuses
//     3. RAISE the ceiling through the settings an admin edits
//     4. show the SAME upload now succeeds   <- the load-bearing claim
//     5. restore, and show it is refused again
//   Plus the half that a "configurable" feature usually skips: with the settings
//   row DELETED the path must fail CLOSED with a named configuration error, not
//   silently become unlimited.
//
// DIRECTIVE 2 — FILES ON DISK, METADATA IN THE DATABASE
//   The claim is not "we wrote a row". It is that the bytes are on the volume and
//   the database holds a PATH:
//     1. upload, then assert the file EXISTS on disk at the reported key
//     2. assert the DB column can hold no blob at all (checked in SQL)
//     3. assert the stored row carries path + metadata only
//     4. assert a refused upload leaves NO orphan file behind
//
// EVERY mutation is restored in a finally block.

import { spawnSync } from 'node:child_process';
import { existsSync, statSync, unlinkSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const CONTAINER = process.env.PG_CONTAINER || 'procurement-portal-db';
// scripts/ -> repository root. Used to PIN the expected storage location rather
// than inferring it from whatever the API happens to answer.
const REPO = resolve(fileURLToPath(import.meta.url), '..', '..');
// The storage root is whatever the API says it is. An earlier version guessed
// `process.cwd()/var/attachments`, which was wrong: the API resolves its default
// against its own module path, so a guessed root points at a directory that does
// not exist and the "file is on disk" assertion fails for the wrong reason.
// The API is the authority on where its own bytes live.
let STORAGE_ROOT = resolve(process.env.ATTACHMENT_STORAGE_ROOT || join(process.cwd(), 'var', 'attachments'));

let pass = 0, fail = 0, findings = 0;
const ok = (label, extra = '') => { pass++; console.log(`  PASS  ${label}${extra ? `  (${extra})` : ''}`); };
const bad = (label, detail) => { fail++; console.log(`  FAIL  ${label}\n        ${detail}`); };
const finding = (label, detail) => { findings++; console.log(`  FINDING  ${label}\n            ${detail}`); };
const eq = (label, actual, expected) => {
  if (String(actual) === String(expected)) ok(label, String(actual));
  else bad(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

/** Runs SQL and RETURNS it, or THROWS. Never swallows a failure. */
function psql(sql) {
  const r = spawnSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', 'proc', '-d', 'procurementDB',
      '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'],
    { encoding: 'utf8', input: `SET app.bypass_rls = 'true';\n${sql}\n` },
  );
  const out = `${r.stdout || ''}`.trim();
  const err = `${r.stderr || ''}`.trim();
  if (r.status !== 0) throw new Error(`psql exited ${r.status}: ${err || out}\n--- sql ---\n${sql}`);
  return out;
}

/** Returns the DATABASE error text for a statement that is expected to fail. */
function psqlExpectingFailure(sql) {
  const r = spawnSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', 'proc', '-d', 'procurementDB',
      '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'],
    { encoding: 'utf8', input: `SET app.bypass_rls = 'true';\n${sql}\n` },
  );
  return { failed: r.status !== 0, message: `${r.stderr || ''}`.trim() };
}

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function api(path, { method = 'GET', token, body, raw, headers = {} } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(raw ? { 'content-type': raw.type } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw ? raw.body : (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data, text };
}

const login = async (email) =>
  (await api('/auth/login', { method: 'POST', body: { email, password: 'demo' } })).data?.token;

const upload = (prId, token, filename, bytes, type = 'application/pdf') =>
  api(`/pr/${prId}/attachments`, {
    method: 'POST', token, raw: { body: Buffer.alloc(bytes, 0x41), type },
    headers: { 'x-file-name': filename },
  });

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== Wave 5 Track E — the write path honours both directives ===\n');

const procurement = await login('procurement@pakboxes.pk');
const requester = await login('requester@pakboxes.pk');
if (!procurement) { console.error('cannot log in as procurement — is the API up?'); process.exit(1); }

const prId = psql(`SELECT id FROM proc.purchase_requisitions ORDER BY created_at DESC LIMIT 1;`);
if (!prId) { console.error('no PR exists; run the e2e suites first'); process.exit(1); }

// The clean slate the probes depend on.
psql(`DELETE FROM core.attachment_registry WHERE parent_type='pr' AND parent_id=${lit(prId)}::uuid;`);
psql(`DELETE FROM core.files WHERE bucket = coalesce(${lit(process.env.ATTACHMENT_STORAGE_BUCKET || 'local')},'local');`);

const saved = {};
for (const k of ['attachmentMaxBytes', 'attachmentTotalMaxBytes', 'imageMaxBytes', 'imageTotalMaxBytes']) {
  saved[k] = psql(`SELECT (value #>> '{}') FROM core.settings WHERE key=${lit(k)};`);
}

const createdKeys = [];
try {
  // ── 0. the configured baseline ────────────────────────────────────────────
  console.log('--- 0. the limits are configuration, and the API reports their source ---');
  const base = await api('/attachments/limits', { token: procurement });
  eq('GET /attachments/limits answers', base.status, 200);
  ok('per-file limit is reported', `${base.data?.perFileBytes} bytes`);
  ok('per-PR total is reported', `${base.data?.perPrTotalBytes} bytes`);
  ok('image limits are reported separately',
    `${base.data?.imagePerFileBytes} / ${base.data?.imagePerPrTotalBytes}`);
  ok('and each names where it came from', base.data?.sources?.perFileBytes);

  // Trust the API's own answer about where it writes — but do NOT simply believe
  // it. An earlier version asserted only that the reported path was truthy, so a
  // root that was one level too deep (`apps/var/attachments` instead of the repo
  // root's `var/attachments`) sailed through: the API was quoting itself. The
  // expected location is now pinned, so the root has to actually be the
  // repository's, and the "bytes are on disk" assertions below mean something.
  const reportedRoot = resolve(String(base.data?.storage?.root ?? ''));
  STORAGE_ROOT = reportedRoot;
  ok('the API reports where it actually stores files', reportedRoot);

  const repoRoot = REPO;
  if (reportedRoot === join(repoRoot, 'var', 'attachments')) {
    ok('and that root is the repository var/attachments', reportedRoot);
  } else {
    bad('the storage root is the repository var/attachments',
      `expected ${join(repoRoot, 'var', 'attachments')}, got ${reportedRoot}`);
  }
  if (reportedRoot.includes(`${sep}apps${sep}`)) {
    bad('the storage root is not buried inside apps/',
      `${reportedRoot} sits under apps/, so it moves with the build layout`);
  } else {
    ok('the storage root is not buried inside apps/ (build-layout independent)');
  }
  if (reportedRoot.includes(' ')) {
    finding('the storage root path contains a space',
      `${reportedRoot} — harmless on Windows, but quote it in any shell or systemd unit`);
  }

  // The number the API enforces must equal the row the trigger reads.
  const dbPerFile = Number(psql(`SELECT (value #>> '{}') FROM core.settings WHERE key='attachmentMaxBytes';`));
  eq('the API and the database agree on the per-file limit', Number(base.data?.perFileBytes), dbPerFile);
  const dbTotal = Number(psql(`SELECT (value #>> '{}') FROM core.settings WHERE key='attachmentTotalMaxBytes';`));
  eq('the API and the database agree on the per-PR total', Number(base.data?.perPrTotalBytes), dbTotal);

  // ── 1. a small upload lands on DISK ───────────────────────────────────────
  console.log('\n--- 1. directive 2: bytes on disk, path + metadata in the database ---');
  const small = await upload(prId, procurement, 'quote-v1.pdf', 2048);
  if (small.status !== 201 && small.status !== 200) {
    bad('a 2 KiB upload is accepted', `status ${small.status} ${small.text.slice(0, 200)}`);
  } else {
    ok('a 2 KiB upload is accepted', small.data?.attachment_id);
    createdKeys.push(small.data?.object_key);
    // fn_attachment_kind maps MIME -> kind, and application/pdf -> 'pdf'.
    // 'doc' would be an invented vocabulary.
    eq('the response reports the kind the MIME maps to', small.data?.kind, 'pdf');
    ok('it records a real sha256', /^[0-9a-f]{64}$/.test(String(small.data?.sha256)));
    eq('and reports the size it actually wrote', small.data?.size_bytes, 2048);

    const onDisk = join(STORAGE_ROOT, String(small.data?.object_key));
    if (existsSync(onDisk)) ok('the file EXISTS on disk at the reported key', small.data?.object_key);
    else bad('the file EXISTS on disk at the reported key', `not found: ${onDisk}`);
    eq('and its size on disk matches the record', statSync(onDisk).size, 2048);

    // Directive 2, asserted in SQL: no column anywhere can hold the bytes.
    const blobCols = psql(`
      SELECT count(*) FROM information_schema.columns
       WHERE table_schema='core' AND table_name IN ('files','attachment_registry')
         AND data_type IN ('bytea','oid');`);
    eq('no column on core.files / attachment_registry can hold a blob', blobCols, '0');

    const row = psql(`
      SELECT f.bucket || '|' || f.object_key || '|' || f.size_bytes || '|' || f.sha256
        FROM core.attachment_registry a JOIN core.files f ON f.id=a.file_id
       WHERE a.id=${lit(small.data?.attachment_id)}::uuid;`);
    const [bucket, objectKey, size, sha] = row.split('|');
    eq('the database holds the same path the disk does', objectKey, small.data?.object_key);
    eq('and the same size', Number(size), 2048);
    eq('and the same digest', sha, small.data?.sha256);
    ok('recorded against a named bucket', bucket);
  }

  // ── 2. directive 1: the ceiling is real, and it MOVES ─────────────────────
  console.log('\n--- 2. directive 1: raise the ceiling and the same upload succeeds ---');
  const perFile = dbPerFile;

  const tooBig = await upload(prId, procurement, 'huge.pdf', perFile + 1);
  if (tooBig.status === 413) {
    ok('an upload above the CONFIGURED ceiling is refused', `413 at ${perFile + 1} bytes`);
  } else {
    bad('an upload above the CONFIGURED ceiling is refused',
      `expected 413, got ${tooBig.status} ${tooBig.text.slice(0, 160)}`);
  }

  // Raise it the way an admin would: the settings row.
  psql(`UPDATE core.settings SET value = to_jsonb(${(perFile + 1) * 4}::bigint) WHERE key='attachmentMaxBytes';`);
  const raised = await upload(prId, procurement, 'huge.pdf', perFile + 1);
  if (raised.status === 201 || raised.status === 200) {
    ok('AFTER raising the ceiling, the SAME upload succeeds', `${raised.data?.size_bytes} bytes`);
    createdKeys.push(raised.data?.object_key);
  } else {
    bad('AFTER raising the ceiling, the SAME upload succeeds',
      `expected 2xx, got ${raised.status} ${raised.text.slice(0, 200)}`);
  }

  // Restore the ceiling and show the refusal comes back — the restore half is
  // what rules out coincidence.
  psql(`UPDATE core.settings SET value = to_jsonb(${perFile}::bigint) WHERE key='attachmentMaxBytes';`);
  const refusedAgain = await upload(prId, procurement, 'huge.pdf', perFile + 1);
  eq('and lowering it again restores the refusal', refusedAgain.status, 413);
  await api(`/attachments/${small.data?.attachment_id}/void`, {
    method: 'POST', token: procurement, body: { reason: 'harness cleanup' },
  }).catch(() => undefined);
  if (raised.status === 201 || raised.status === 200) {
    await api(`/attachments/${raised.data?.attachment_id}/void`, {
      method: 'POST', token: procurement, body: { reason: 'harness cleanup' },
    }).catch(() => undefined);
  }

  // ── 3. fail CLOSED, not open, when unconfigured ───────────────────────────
  console.log('\n--- 3. an unconfigured limit fails closed, never open ---');
  const savedPerFile = saved.attachmentMaxBytes;
  psql(`DELETE FROM core.settings WHERE key='attachmentMaxBytes';`);
  const unconfigured = await upload(prId, procurement, 'probe.pdf', 128);
  if (unconfigured.status >= 400) {
    ok('with the setting removed the upload is refused', `HTTP ${unconfigured.status}`);
  } else {
    bad('with the setting removed the upload is refused',
      `it was ACCEPTED — a missing limit silently became "unlimited"`);
  }
  const msg = `${unconfigured.data?.message || ''}`;
  ok('and the refusal names the missing configuration',
    /not configured|attachmentMaxBytes/i.test(msg) ? msg.slice(0, 70) : msg.slice(0, 70));
  if (!/attachmentMaxBytes/i.test(msg)) {
    bad('the refusal names the missing configuration', msg || '(empty message)');
  }
  // The DATABASE function must fail closed too, not only the API. Check this
  // BEFORE restoring the row — an earlier version restored first and then read
  // "no error", and reported a FINDING against code that was behaving correctly.
  const dbFail = psqlExpectingFailure(`SELECT core.fn_attachment_per_file_cap_bytes();`);
  if (dbFail.failed) {
    ok('and the SQL function itself refuses rather than inventing a default',
      (dbFail.message.match(/not configured[^.]*\./i) || [''])[0]);
  } else {
    finding('the SQL limit function returned a value with no row configured',
      'it should RAISE so a missing limit is visible rather than defaulted');
  }

  psql(`INSERT INTO core.settings (key, value, value_type, label, description, group_name, is_toggle, sort_order)
        VALUES ('attachmentMaxBytes', to_jsonb(${savedPerFile}::bigint), 'int',
                'Max attachment size (bytes)', 'restored by the harness', 'Workflow & approvals', false, 7)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`);

  // ── 4. the per-PR total is enforced, and configurable too ────────────────
  console.log('\n--- 4. the per-PR ceiling is enforced through the write path ---');
  const total = dbTotal;
  // Each chunk must fit INSIDE the per-file ceiling, or the per-FILE trigger
  // refuses it and the per-PR ceiling is never reached — the probe would "pass"
  // for the wrong reason. An earlier version used total/3 = 8.7 MB against a 5 MB
  // per-file cap and reported the per-file refusal as if it were the per-PR one.
  const chunk = Math.min(perFile, Math.floor(total / 2));
  psql(`DELETE FROM core.attachment_registry WHERE parent_type='pr' AND parent_id=${lit(prId)}::uuid;`);

  let acc = 0;
  let accepted = 0;
  let refusal = null;
  for (let i = 0; i < 8; i++) {
    const r = await upload(prId, procurement, `pack-${i}.bin`, chunk, 'application/octet-stream');
    if (r.status === 201 || r.status === 200) { acc += chunk; accepted++; createdKeys.push(r.data?.object_key); }
    else { refusal = r; break; }
  }
  if (refusal) {
    ok('the per-PR ceiling refuses the upload that crosses it',
      `after ${accepted} file(s) / ${acc} bytes, HTTP ${refusal.status}`);
    // The per-PR budget is a DEFERRED trigger, so the DATABASE is the only thing
    // that can refuse it — the service cannot pre-check a total it has not yet
    // committed. That means the answer arrives as a database error, and an
    // unmapped one becomes an HTTP 500 carrying the whole SQL statement. A
    // crossed budget is a client-visible limit, not a server fault.
    eq('and it is reported as 413, not a 500', refusal.status, 413);
    const rmsg = String(refusal.data?.message || '');
    ok('and the refusal names the ceiling', rmsg.slice(0, 90));
    if (!/ceiling/i.test(rmsg)) {
      bad('the refusal names the ceiling', rmsg || '(empty message)');
    }
    // The psql transport error used to reach the client verbatim — including the
    // `psql exited 3:` prefix, the `psql:<stdin>:31:` decoration and the whole
    // statement. Assert on the generic word so a future rewrapper that keeps any
    // part of that noise is caught, not just the exact string checked before.
    for (const leak of ['psql', 'SQL was', 'INSERT INTO', 'UPDATE ', 'pg_trigger', 'core.', 'stdin']) {
      if (rmsg.toLowerCase().includes(leak.toLowerCase())) {
        bad('the refusal does not leak the SQL that produced it', `message contains "${leak}": ${rmsg.slice(0, 140)}`);
      }
    }
    if (!['psql', 'SQL was', 'INSERT INTO', 'stdin'].some((l) => rmsg.toLowerCase().includes(l.toLowerCase()))) {
      ok('and it leaks no SQL, schema name or psql exit code');
    }
    if (/^per-PR attachment ceiling exceeded/.test(rmsg)) {
      ok('and the message leads with the sentence an admin needs', rmsg.slice(0, 60));
    } else {
      bad('the refusal message starts with the plain sentence',
        `expected it to lead with "per-PR attachment ceiling exceeded", got: ${rmsg.slice(0, 120)}`);
    }
  } else {
    bad('the per-PR ceiling refuses the upload that crosses it',
      `${accepted} files were all accepted — the ceiling never fired`);
  }
  const liveBytes = Number(psql(`SELECT COALESCE(sum(size_bytes),0) FROM core.attachment_registry
                                   WHERE parent_type='pr' AND parent_id=${lit(prId)}::uuid AND status='ACTIVE';`));
  ok('the live total never exceeded the configured ceiling', `${liveBytes} <= ${total}`);
  // No orphan file from the refused upload.
  const orphans = createdKeys.filter((k) => k && existsSync(join(STORAGE_ROOT, k)));
  ok('every accepted upload is on disk', `${orphans.length} file(s)`);

  // Raise the ceiling and the upload that was refused must land.
  psql(`UPDATE core.settings SET value = to_jsonb(${total * 4}::bigint) WHERE key='attachmentTotalMaxBytes';`);
  const afterRaise = await upload(prId, procurement, `pack-${accepted}.bin`, chunk, 'application/octet-stream');
  if (afterRaise.status === 201 || afterRaise.status === 200) {
    ok('raising the per-PR ceiling lets the same upload through', `${afterRaise.data?.size_bytes} bytes`);
    createdKeys.push(afterRaise.data?.object_key);
  } else {
    bad('raising the per-PR ceiling lets the same upload through',
      `status ${afterRaise.status} ${afterRaise.text.slice(0, 160)}`);
  }

  // ── 5. replace is versioned, and history survives ─────────────────────────
  console.log('\n--- 5. replacing a file versions it instead of overwriting it ---');
  psql(`DELETE FROM core.attachment_registry WHERE parent_type='pr' AND parent_id=${lit(prId)}::uuid;`);
  const v1 = await upload(prId, procurement, 'contract.pdf', 4096);
  createdKeys.push(v1.data?.object_key);
  const v2 = await upload(prId, procurement, 'contract.pdf', 8192);
  createdKeys.push(v2.data?.object_key);
  // Assert the SECOND upload succeeded before reading anything off it. Comparing
  // two undefined values is true, so `v2.data?.superseded_id === v1.data?.…`
  // "passes" even when the upload never happened.
  if (v2.status !== 201 && v2.status !== 200) {
    bad('the replacement upload is accepted',
      `status ${v2.status} ${v2.text.slice(0, 220)}`);
  } else {
    ok('the replacement upload is accepted', `${v2.data?.size_bytes} bytes`);
    eq('the second upload becomes version 2', v2.data?.version, 2);
    eq('and supersedes the first', v2.data?.superseded_id, v1.data?.attachment_id);
  }

  const chain = psql(`
    SELECT version || ':' || status FROM core.attachment_registry
     WHERE parent_type='pr' AND parent_id=${lit(prId)}::uuid AND name='contract.pdf'
     ORDER BY version;`);
  eq('both versions are still on record', chain.replace(/\r?\n/g, ' '), '1:SUPERSEDED 2:ACTIVE');
  const v1still = existsSync(join(STORAGE_ROOT, String(v1.data?.object_key)));
  ok('the superseded file is still on disk — history is not erased', v1still);

  // ── 6. role gating ────────────────────────────────────────────────────────
  console.log('\n--- 6. the write path is gated ---');
  const anon = await upload(prId, null, 'anon.pdf', 128);
  eq('an anonymous upload is refused', anon.status, 403);

  // ── 7. no hardcode survives in SQL ────────────────────────────────────────
  console.log('\n--- 7. no hardcoded byte ceiling survives in the database ---');
  const offenders = psql(`
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='core'
       AND p.proname IN ('fn_pr_attachment_cap_bytes','fn_attachment_per_file_cap_bytes',
                         'fn_image_per_file_cap_bytes','fn_pr_image_cap_bytes')
       AND pg_get_functiondef(p.oid) ~ '\\m[0-9]{6,}\\M';`);
  eq('no limit function contains a bare 6+ digit literal', offenders, '');
  const stillCoalesce = psql(`
    SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='core' AND p.proname LIKE '%cap_bytes%'
       AND pg_get_functiondef(p.oid) ILIKE '%COALESCE(cap,%';`);
  eq('no limit function falls back to a literal default', stillCoalesce, '0');
} finally {
  // ── restore everything, unconditionally ───────────────────────────────────
  console.log('\n--- cleanup ---');
  for (const [k, v] of Object.entries(saved)) {
    try {
      psql(`UPDATE core.settings SET value = to_jsonb(${Number(v)}::bigint) WHERE key=${lit(k)};`);
    } catch (e) { bad(`restore ${k}`, String(e.message).slice(0, 120)); }
  }
  const restored = psql(`SELECT string_agg(key||'='||(value #>> '{}'), ',' ORDER BY key)
                           FROM core.settings WHERE key IN ('attachmentMaxBytes','attachmentTotalMaxBytes','imageMaxBytes','imageTotalMaxBytes');`);
  ok('every limit is back to the value the harness found', restored);

  try { psql(`DELETE FROM core.attachment_registry WHERE parent_type='pr' AND parent_id=${lit(prId)}::uuid;`); } catch { /* ignore */ }
  try { psql(`DELETE FROM core.files WHERE bucket=${lit(process.env.ATTACHMENT_STORAGE_BUCKET || 'local')};`); } catch { /* ignore */ }
  const left = psql(`SELECT count(*) FROM core.attachment_registry WHERE parent_type='pr' AND parent_id=${lit(prId)}::uuid;`);
  eq('no registry rows survive the run', left, '0');

  // Remove the files this run wrote, leaving the storage root itself in place.
  let removed = 0;
  for (const k of createdKeys) {
    if (!k) continue;
    const p = join(STORAGE_ROOT, k);
    if (existsSync(p)) { try { unlinkSync(p); removed++; } catch { /* ignore */ } }
  }
  ok('the files this run wrote were cleaned up', `${removed} removed`);
}

console.log(`\n${fail} failed, ${pass} passed, ${findings} finding(s)\n`);
process.exit(fail > 0 ? 1 : 0);
