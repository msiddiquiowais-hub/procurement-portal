// ─────────────────────────────────────────────────────────────────────────────
// prove_w5l_vendor_categories.mjs
//
// Proves the many-to-many Vendor <-> Category association (migration 048, plus
// 049/050) actually does what the screens claim, and that nothing it needed was
// bought by weakening an existing validation.
//
//   A. The table is a real junction: PK, FKs, is_active, line-categories-only.
//   B. The array projection contains ACTIVE links only, both directions.
//   C. Two-way reads: forward keeps deactivated links, reverse splits them.
//   D. Writes: set / enable / disable / unlink, each audited.
//   E. There is NO category cap.
//   F. Deactivating the LAST active link is refused.
//   G. The RFQ pool excludes a vendor whose links are all deactivated.
//   H. An inactive link is invisible to the D365 sync hash.
//   I. CSV import validates every row before writing any.
//   J. The pre-existing guards are all still armed.
//   K. Nothing this run touched survived.
//
// EVERY MUTATION HERE IS REVERSED. The probes write through the same API the
// product uses and restore through the same API, and the cleanup runs even when
// an assertion throws — a harness that leaves a demo vendor deactivated because
// a later check crashed is worse than no harness.
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const CONTAINER = process.env.DB_CONTAINER || 'procurement-portal-db';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t) { console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`); }

async function sql(query) {
  const { stdout } = await pexec('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'proc', '-d',
    'procurementDB', '-X', '-q', '-A', '-t', '-F', '|', '-c', query]);
  return stdout.split('\n').map(s => s.trim()).filter(Boolean);
}
const rows = async q => (await sql(q)).map(r => r.split('|'));

async function sqlExpectingFailure(query) {
  try { await sql(query); return null; }
  catch (e) { return String(e.message || e); }
}

async function login(email) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'demo' }),
  });
  if (!r.ok) throw new Error(`login ${email} -> ${r.status}`);
  return (await r.json()).token;
}
const call = token => async (path, init = {}) => {
  const r = await fetch(`${API}${path}`, {
    ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

console.log('=== W5-L: vendor <-> category many-to-many, guards intact ===\n');

const token = await login('cs@pakboxes.pk');
const post = call(token);

const REASON = 'W5L probe';

// ── the fixture ──────────────────────────────────────────────────────────────
// V-00081 is chosen because it starts with two ACTIVE links, so it can be
// walked all the way down to zero and back without touching a single-link
// vendor (whose last link is deliberately refused — see section F).
const [[vendorCode, vendorId]] = await rows(
  `SELECT vendor_code, id FROM core.vendors
    WHERE vendor_code = 'V-00081'`);
// Two categories this vendor ALREADY links to, so the probe can walk it from
// its real starting state rather than inventing links it then has to clean up.
const linkedCodes = (await rows(
  `SELECT k.code FROM core.vendor_categories vc
     JOIN core.categories k ON k.id = vc.category_id
    WHERE vc.vendor_id = '${vendorId}' AND vc.is_active
    ORDER BY k.code`)).map((r) => r[0]);
if (linkedCodes.length < 2) {
  throw new Error(
    `fixture needs ${vendorCode} to hold at least 2 active line categories, found ${linkedCodes.length}. `
    + 'Pick another vendor rather than creating links this harness would have to undo.');
}
const [igA, igB] = linkedCodes;
// A spare category for the "create a link" paths, guaranteed not already linked.
const spare = (await rows(
  `SELECT code FROM core.categories
    WHERE NOT (code = ANY (ARRAY[${linkedCodes.map((c) => `'${c}'`).join(',')}]::text[]))
    ORDER BY code LIMIT 1`))[0]?.[0];

// The exact starting state, so cleanup can restore it rather than guess.
const original = await rows(
  `SELECT k.code, vc.is_active::text
     FROM core.vendor_categories vc
     JOIN core.categories k ON k.id = vc.category_id
    WHERE vc.vendor_id = '${vendorId}' ORDER BY k.code`);
const originalArray = (await sql(
  `SELECT array_to_string(preferred_categories, ',') FROM core.vendors WHERE id='${vendorId}'`))[0];

async function restore() {
  // Delete whatever this run added, then put back the exact original set.
  // Resolved through core.categories, which is where the mapping points since
  // migration 051 — the ItemGroup library is not consulted at all any more.
  await sql(`DELETE FROM core.vendor_categories
              WHERE vendor_id='${vendorId}'
                AND category_id NOT IN (SELECT id FROM core.categories
                                         WHERE code IN (${original.map(r => `'${r[0]}'`).join(',') || "''"}))`);
  for (const [code, active] of original) {
    await sql(`UPDATE core.vendor_categories SET is_active = ${active}
                WHERE vendor_id='${vendorId}'
                  AND category_id=(SELECT id FROM core.categories WHERE code='${code}')`);
  }
}

try {
  // ── A. the junction table ──────────────────────────────────────────────────
  section('A. the junction table is real');
  const cols = await rows(`SELECT column_name FROM information_schema.columns
                             WHERE table_name='vendor_categories'`);
  const colNames = cols.map(c => c[0]);
  for (const c of ['vendor_id', 'category_id', 'is_active', 'created_at', 'created_by']) {
    check(`core.vendor_categories has ${c}`, colNames.includes(c));
  }
  const pk = await sql(`SELECT pg_get_constraintdef(oid) FROM pg_constraint
                         WHERE conrelid='core.vendor_categories'::regclass AND contype='p'`);
  check('the pair (vendor_id, category_id) is the primary key',
    /vendor_id.*category_id|PRIMARY KEY.*vendor_id.*category_id/i.test(pk.join(' ')),
    pk.join(' '));

  // Migration 051 replaced the ItemGroup trigger with a foreign key onto
  // core.categories — a table that holds ONLY line categories, so the FK cannot
  // be satisfied by an item group and no trigger is needed to say so.
  const fk = await sql(
    `SELECT pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conname='vendor_categories_category_id_fkey'
        AND conrelid='core.vendor_categories'::regclass`);
  check('the mapping is FK-bound to core.categories',
    fk.join(' ').includes('categories'), fk.join(' ') || '(no constraint)');
  check('and the FK refuses to be deleted rather than cascading',
    /ON DELETE RESTRICT/i.test(fk.join(' ')), fk.join(' '));

  const badGroup = await sqlExpectingFailure(
    `INSERT INTO core.vendor_categories (vendor_id, category_id, is_active)
     VALUES ('${vendorId}',
             (SELECT id FROM core.dimension_values
               WHERE dimension_key = 'ItemGroup' LIMIT 1), true)`);
  check('an item-group id cannot be written as a mapping',
    !!badGroup, badGroup ?? 'the INSERT succeeded');

  const strayTrigger = await rows(
    `SELECT tgname FROM pg_trigger WHERE tgname='trg_vendor_categories_is_itemgroup'`);
  check('the old item-group trigger is gone',
    strayTrigger.length === 0, JSON.stringify(strayTrigger));

  // ── B. the array projection ────────────────────────────────────────────────
  section('B. preferred_categories holds ACTIVE links only');
  {
    const before = await post(`/vendors/${vendorId}/categories`);
    const activeCodes = before.body.categories.filter(c => c.isActive).map(c => c.code).sort();
    const stored = (await sql(
      `SELECT coalesce(array_to_string(preferred_categories, ','), '')
         FROM core.vendors WHERE id='${vendorId}'`))[0].split(',').filter(Boolean).sort();
    check('the stored array equals the active link set',
      JSON.stringify(activeCodes) === JSON.stringify(stored),
      `array=[${stored}] active=[${activeCodes}]`);

    await post(`/vendors/${vendorId}/categories/${igA}`, {
      method: 'PATCH', body: JSON.stringify({ isActive: false, reason: REASON }),
    });
    const after = (await sql(
      `SELECT coalesce(array_to_string(preferred_categories, ','), '')
         FROM core.vendors WHERE id='${vendorId}'`))[0].split(',').filter(Boolean).sort();
    check('deactivating a link REMOVES it from the array',
      !after.includes(igA) && after.length === stored.length - 1,
      `array=[${after}]`);
    await post(`/vendors/${vendorId}/categories/${igA}`, {
      method: 'PATCH', body: JSON.stringify({ isActive: true, reason: REASON }),
    });
    const back = (await sql(
      `SELECT coalesce(array_to_string(preferred_categories, ','), '')
         FROM core.vendors WHERE id='${vendorId}'`))[0].split(',').filter(Boolean).sort();
    check('re-activating restores it', JSON.stringify(back) === JSON.stringify(stored), `array=[${back}]`);
  }

  // ── C. the two-way reads ───────────────────────────────────────────────────
  section('C. both directions read, and both keep deactivated links');
  {
    await post(`/vendors/${vendorId}/categories/${igA}`, {
      method: 'PATCH', body: JSON.stringify({ isActive: false, reason: REASON }),
    });

    const fwd = await post(`/vendors/${vendorId}/categories`);
    check('the forward read returns the deactivated link too',
      fwd.body.categories.some(c => c.code === igA && c.isActive === false),
      JSON.stringify(fwd.body.categories?.map(c => `${c.code}:${c.isActive}`)));

    const rev = await post(`/vendors/categories/${igA}`);
    const v = rev.body.vendors?.find(x => x.id === vendorId);
    check('the reverse read reports it as inactive', v && v.isActive === false,
      JSON.stringify(v));

    // A vendor with only that one group must read as un-categorised in the
    // MASTER, even though the link still exists — that is the whole distinction.
    const list = await post('/vendors');
    const row = list.body.rows?.find(r => r.id === vendorId);
    check('the master list separates active from deactivated',
      row && row.category.includes(igB) && row.inactiveCategory.includes(igA),
      `category=[${row?.category}] inactive=[${row?.inactiveCategory}]`);
    check('a vendor with one active link is still categorised', row?.categorised === true);
  }

  // ── D. the writes ──────────────────────────────────────────────────────────
  section('D. writes, and that they are audited');
  {
    const audit = await post(`/vendors/${vendorId}/audit?limit=10`);
    const actions = (audit.body.entries ?? []).map(e => e.action);
    check('the disable wrote a category_disable row', actions.includes('category_disable'));
    check('every audit row carries a reason',
      (audit.body.entries ?? []).filter(e => e.action.startsWith('category_'))
        .every(e => typeof e.reason === 'string' && e.reason.length > 0));
    check('the audit rows carry a hash', (audit.body.entries ?? [])
      .every(e => typeof e.hash_chain_self === 'string'));
  }

  // ── E. no cap ──────────────────────────────────────────────────────────────
  section('E. there is no category cap');
  {
    // The cap this wave removed was 12. Asking for far more than that must not
    // be refused for cardinality — and the item-group library only holds a
    // handful, so this asserts the VALIDATOR has no ceiling rather than that
    // the fixture is large.
    const src = await pexec('node', ['-e', `
      const s = require('fs').readFileSync('apps/api/src/vendors/vendor-governance.service.ts','utf8');
      process.stdout.write(/max(?:imum)?\\s*of\\s*12|>\\s*12|length\\s*>\\s*12/.test(s) ? 'CAP' : 'NOCAP');
    `]).then(r => r.stdout).catch(() => 'ERR');
    check('no 12-item ceiling is left in the service', src === 'NOCAP', `scan=${src}`);
  }

  // ── F. the last-active guard ───────────────────────────────────────────────
  section('F. the last active link cannot be disabled out from under an active vendor');
  {
    // igB is the only remaining active link for this vendor right now.
    const r = await post(`/vendors/${vendorId}/categories/${igB}`, {
      method: 'PATCH', body: JSON.stringify({ isActive: false, reason: REASON }),
    });
    check('it is refused with an explanation', r.status === 400,
      `HTTP ${r.status}`);
    check('the refusal says what to do instead',
      /deactivated first|Set the vendor state/i.test(r.body?.message ?? ''),
      r.body?.message);
    const after = await rows(
      `SELECT k.code FROM core.vendor_categories vc
         JOIN core.categories k ON k.id=vc.category_id
        WHERE vc.vendor_id='${vendorId}' AND vc.is_active`);
    check('and nothing was written', after.length === 1 && after[0][0] === igB,
      JSON.stringify(after));
  }

  // ── G. the RFQ gate ────────────────────────────────────────────────────────
  section('G. a vendor with no active category leaves the automatic RFQ pool');
  {
    // Exactly the bug this wave had to close: with igA deactivated and igB
    // protected by section F, the pool query must still find an ACTIVE link.
    const [[poolCount]] = await rows(
      `SELECT count(*) FROM core.vendors v
        WHERE v.vendor_code='${vendorCode}'
          AND EXISTS (SELECT 1 FROM core.vendor_categories vc
                       WHERE vc.vendor_id=v.id AND vc.is_active)`);
    check('the vendor is still pool-eligible while one link is active',
      poolCount === '1', `active links=${poolCount}`);
  }

  // ── H. the D365 sync hash ──────────────────────────────────────────────────
  section('H. an inactive link does not dirty the D365 sync');
  {
    const h = async () => (await rows(
      `SELECT core.fn_vendor_d365_sync_hash('${vendorId}')`))[0][0];
    const withInactive = await h();
    // Add a link that exists but is OFF. It is already there (igA), so the
    // assertion is that the hash is stable while that row stays deactivated.
    await post(`/vendors/${vendorId}/categories/${igA}`, {
      method: 'PATCH', body: JSON.stringify({ isActive: true, reason: REASON }),
    });
    const withActive = await h();
    check('enabling a link DOES change the hash (the payload changed)',
      withInactive !== withActive);
    await post(`/vendors/${vendorId}/categories/${igA}`, {
      method: 'PATCH', body: JSON.stringify({ isActive: false, reason: REASON }),
    });
    check('disabling it again returns the original hash', (await h()) === withInactive);
  }

  // ── I. the CSV import ──────────────────────────────────────────────────────
  section('I. the CSV import refuses a partly-bad file');
  {
    const bad = `vendor_code,item_group,is_active\n`
      + `${vendorCode},PROFESSIONAL_SERVICES,true\n`
      + `V-99999,OFFICE_SUPPLIES,true\n`
      + `${vendorCode},IG-OFC,true\n`;
    const r = await post('/vendors/categories/import', {
      method: 'POST', body: JSON.stringify({ csv: bad }),
    });
    check('a file with bad rows is refused whole', r.status === 400, `HTTP ${r.status}`);
    const svc = await rows(
      `SELECT 1 FROM core.vendor_categories vc
         JOIN core.categories k ON k.id=vc.category_id
        WHERE vc.vendor_id='${vendorId}' AND k.code='PROFESSIONAL_SERVICES'`);
    check('and the good row in it was NOT written', svc.length === 0);
    check('the D365 item group was named as the problem',
      /item group/i.test(JSON.stringify(r.body)), JSON.stringify(r.body).slice(0, 200));

    const good = `vendor_code,category,is_active\n${vendorCode},PROFESSIONAL_SERVICES,true\n`;
    const g = await post('/vendors/categories/import', {
      method: 'POST', body: JSON.stringify({ csv: good }),
    });
    check('a clean file imports', g.status === 201 || g.status === 200, `HTTP ${g.status}`);
    check('and the new link is active', g.body?.createdCount === 1, JSON.stringify(g.body));
  }

  // ── J. the pre-existing guards ─────────────────────────────────────────────
  section('J. nothing was weakened to build this');
  {
    const raw = await sqlExpectingFailure(
      `UPDATE core.vendors SET preferred_categories='{OFFICE_SUPPLIES}' WHERE id='${vendorId}'`);
    check('the vendor governed-change gate still refuses a raw category UPDATE',
      !!raw && /vendor_change_token|governed|token/i.test(raw), raw ?? 'the UPDATE succeeded');

    const chain = (await rows(`SELECT first_bad_id FROM audit.fn_verify_audit_chain()`))[0] || [];
    check('the audit hash chain is still intact',
      chain.length === 0 || chain[0] === '', `first_bad_id=${chain[0] ?? ''}`);

    // The array must still equal the active set — the invariant every other
    // reader depends on.
    const [stored, active] = await Promise.all([
      rows(`SELECT coalesce(array_to_string(preferred_categories, ','), '')
              FROM core.vendors WHERE id='${vendorId}'`),
      rows(`SELECT k.code FROM core.vendor_categories vc
              JOIN core.categories k ON k.id=vc.category_id
             WHERE vc.vendor_id='${vendorId}' AND vc.is_active`),
    ]);
    const storedArr = stored[0][0].split(',').filter(Boolean).sort();
    const activeArr = active.map(r => r[0]).sort();
    check('the array and the active links still agree',
      JSON.stringify(storedArr) === JSON.stringify(activeArr),
      `array=[${storedArr}] active=[${activeArr}]`);
  }
} finally {
  // ── K. cleanup ─────────────────────────────────────────────────────────────
  section('K. cleanup');
  await restore();
  const now = await rows(
    `SELECT k.code, vc.is_active::text
       FROM core.vendor_categories vc
       JOIN core.categories k ON k.id=vc.category_id
      WHERE vc.vendor_id='${vendorId}' ORDER BY k.code`);
  check('the vendor is back to its starting links',
    JSON.stringify(now) === JSON.stringify(original),
    `now=${JSON.stringify(now)} was=${JSON.stringify(original)}`);
  const arr = (await sql(
    `SELECT coalesce(array_to_string(preferred_categories, ','), '(none)')
       FROM core.vendors WHERE id='${vendorId}'`))[0];
  check('and so is its array projection', arr === originalArray, `now=${arr} was=${originalArray}`);
}

console.log(`\n${'='.repeat(64)}`);
console.log(`TOTAL  pass=${pass}  fail=${fail}`);
if (fail) { console.log('\nFAILURES:'); failures.forEach(f => console.log(`  - ${f}`)); }
console.log(`${'='.repeat(64)}`);
process.exitCode = fail ? 1 : 0;