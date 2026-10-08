// ─────────────────────────────────────────────────────────────────────────────
// prove_w5j_categories.mjs
//
// Proves the category dropdown is genuinely database-driven, and — the part that
// matters most — that no existing validation was weakened to achieve it.
//
// The drift check compares the LIVE database against the LIVE TypeScript export
// of LIGHT_ITEM_CATEGORIES. A test that asserted the database matches a list
// written inside the test file would only prove the test file agrees with itself.
//
//   A. core.categories covers the engine vocabulary, exactly.
//   B. The dropdown endpoint serves every category with name AND description.
//   C. A PR created through /pr/new persists the chosen category code.
//   D. The free-text description survives alongside the category.
//   E. An unknown category is still refused by the database.
//   F. Every pre-existing validation is still live:
//        - pr_lines.item_id STILL refuses an item id that is not in the catalogue
//          (rewritten 2026-10-06 for migration 052; see the note at F1)
//        - proc.pr_lines.uom is still FK'd to core.uom
//        - onboarding still rejects an unknown category
//        - the vendor governed-change gate still refuses a raw category UPDATE
//        - vendor categories are validated as LINE categories (migration 051)
//
// FREE TEXT IS NOT TESTED HERE. Migration 052 (2026-10-06) made a line with no
// catalogue item valid, so the old "the form blocks a line with no catalog match"
// assertion is gone rather than quietly weakened. The replacement contract — a
// free-text line is accepted, stores NULL, is READABLE, and still counts toward
// the PR total — is proven end to end in scripts/prove_052_free_text.mjs.
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LIGHT_ITEM_CATEGORIES, LIGHT_ITEM_CATEGORY_IDS } from '../packages/workflow-engine/dist/index.js';

const pexec = promisify(execFile);
const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const CONTAINER = 'procurement-portal-db';

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

/** Run SQL expected to FAIL. Returns the error text, or null if it succeeded. */
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
const api = token => async (path, init = {}) => {
  const r = await fetch(`${API}${path}`, {
    ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

console.log('=== W5-J: database-driven categories, validations intact ===\n');

const requester = await login('requester@pakboxes.pk');
const post = api(requester);
const created = [];

// ── A. drift: database vs the real engine export ──────────────────────────────
section('A. core.categories matches the engine vocabulary exactly');
{
  check('the engine export is readable (not a hardcoded copy in this test)',
    Array.isArray(LIGHT_ITEM_CATEGORIES) && LIGHT_ITEM_CATEGORIES.length > 0,
    `got ${JSON.stringify(LIGHT_ITEM_CATEGORIES)?.slice(0, 80)}`);

  const db = await rows(`SELECT code FROM core.categories WHERE active ORDER BY code`);
  const dbCodes = db.map(r => r[0]).sort();
  const engineCodes = [...LIGHT_ITEM_CATEGORY_IDS].sort();

  const missing = engineCodes.filter(c => !dbCodes.includes(c));
  const extra = dbCodes.filter(c => !engineCodes.includes(c));

  check('every engine category is offered by the database',
    missing.length === 0, `missing from core.categories: ${missing.join(', ')}`);
  check('the database offers no category the engine does not know',
    extra.length === 0, `unknown to the engine: ${extra.join(', ')}`);
  check('the two vocabularies are the same size',
    dbCodes.length === engineCodes.length, `db=${dbCodes.length} engine=${engineCodes.length}`);
}

// ── B. the endpoint serves name AND description ───────────────────────────────
section('B. GET /lookups/categories returns name and description from the DB');
{
  const r = await post('/lookups/categories');
  check('the endpoint responds 200', r.status === 200, `HTTP ${r.status}`);
  const list = Array.isArray(r.body) ? r.body : [];
  check('it returns the full vocabulary', list.length === LIGHT_ITEM_CATEGORIES.length,
    `got ${list.length}, expected ${LIGHT_ITEM_CATEGORIES.length}`);
  check('every row carries a code', list.every(c => c.code), JSON.stringify(list[0] || {}));
  check('every row carries a name', list.every(c => c.name && c.name.length), JSON.stringify(list[0] || {}));
  check('every row carries a non-empty description',
    list.every(c => c.description && c.description.length > 10),
    JSON.stringify(list.filter(c => !c.description || c.description.length <= 10).map(c => c.code)));
  // Also assert the description text matches, not just the label — a label that
  // survives while the description is paraphrased is still drift.
  const descDrift = list.filter(c => {
    const e = LIGHT_ITEM_CATEGORIES.find(x => x.id === c.code);
    return e && e.desc !== c.description;
  });
  check('descriptions agree with LIGHT_ITEM_CATEGORIES',
    descDrift.length === 0, JSON.stringify(descDrift.map(c => `${c.code}: db="${c.description}" engine="${LIGHT_ITEM_CATEGORIES.find(x => x.id === c.code)?.desc}"`)));
}

// ── C + D. a PR through /pr/new keeps the category and the free text ─────────
section('C. a created PR stores the chosen category AND the free-text description');
let laptopItem = null;
{
  const [id] = await sql(`SELECT id FROM core.items WHERE item_code='PKB-LT-001'`);
  laptopItem = id;
  const freeText = 'Two replacement laptops for the HR office — model to be confirmed with IT';
  const r = await post('/pr', {
    method: 'POST',
    body: JSON.stringify({
      title: 'W5J category routing check',
      scope: 'W5J category routing check',
      description: 'Proves the category dropdown reaches the database.',
      purpose: 'Proves the category dropdown reaches the database.',
      expenseType: 'CAPEX',
      costCenterId: '11111111-1111-1111-1111-111111111114',
      requiredByDate: '2026-12-31',
      urgency: 'routine',
      // A category the hardcoded 4-value items vocabulary could never offer.
      // If the dropdown had been sourced from core.items this would be
      // unreachable from the form, and the IT-Manager rule would be dead.
      lines: [{ itemId: laptopItem, quantity: 2, uom: 'EA', category: 'IT_HARDWARE', description: freeText }],
    }),
  });
  check('the PR is accepted', r.status === 201 || r.status === 200, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
  if (r.body?.id) {
    created.push(r.body.id);
    const [line] = await rows(`SELECT coalesce(category,'(null)'), description
                                 FROM proc.pr_lines WHERE pr_id='${r.body.id}' AND line_no=1`);
    // rows() already returns field arrays — splitting again would destructure
    // CHARACTERS, which reads as corrupt data rather than a coding slip.
    const cat = line?.[0], desc = line?.[1];
    check('the line stored the category CODE', cat === 'IT_HARDWARE', `got ${cat}`);
    check('the free-text description is intact and unmodified',
      desc === freeText, `got ${JSON.stringify(desc)}`);
  }
}

// ── E. an unknown category is still refused ──────────────────────────────────
section('E. the database refuses a category nobody knows');
{
  const prId = created[0];
  if (!prId) { check('a PR was available to tamper with', false, 'no PR created'); }
  else {
    const err = await sqlExpectingFailure(
      `UPDATE proc.pr_lines SET category='NOT_A_REAL_CATEGORY' WHERE pr_id='${prId}' AND line_no=1;`);
    check('an unknown category cannot be written to proc.pr_lines',
      !!err, 'the UPDATE succeeded — nothing is enforcing the vocabulary');
    const [still] = await sql(`SELECT category FROM proc.pr_lines WHERE pr_id='${prId}' AND line_no=1`);
    check('and the stored value was left alone', still === 'IT_HARDWARE', `got ${still}`);
  }
}

// ── F. every pre-existing validation is still live ────────────────────────────
section('F. pre-existing validations were not weakened');
{
  // F1. pr_lines.item_id — REWRITTEN for migration 052.
  //
  // This used to assert `NOT NULL + FK`, i.e. that a line could not exist
  // without a catalogue item. That contract was deliberately removed on
  // 2026-10-06: the requester types free text, and a line that matches nothing
  // is valid and submittable.
  //
  // What replaced it is the check that actually matters now, and it is narrower
  // in one direction and wider in the other:
  //
  //   WIDER   — omitting item_id is legal and stores NULL.
  //   NARROWER — SENDING an item_id that is not a real catalogue row is still
  //             refused by the FK. "Describe it your way" got opened; "invent a
  //             product code" did not.
  //
  // Asserting only the first half would let someone drop the FK and this suite
  // would stay green, which is exactly the kind of quiet weakening this file
  // exists to catch. The full end-to-end free-text contract is proven by
  // prove_052_free_text.mjs; this stays as the category-side regression guard.
  const err1 = await sqlExpectingFailure(
    `INSERT INTO proc.pr_lines (pr_id, line_no, item_id, quantity, uom, unit_price_est, gl_account, description)
     SELECT id, 90, gen_random_uuid(), 1,
            (SELECT code FROM core.uom ORDER BY code LIMIT 1), 10, 'NA', 'invented sku'
       FROM proc.purchase_requisitions WHERE id='${created[0] || gen_random_uuid()}';`);
  check('pr_lines.item_id STILL refuses an item that is not in the catalogue', !!err1);
  if (err1) {
    check('and the refusal is the foreign key, not some unrelated constraint',
      /foreign key|violates foreign key constraint/i.test(String(err1)),
      `got: ${String(err1).slice(0, 160)}`);
  }

  // F2. pr_lines.uom FK to core.uom — the constraint the hardcoded 10-item UOM
  //     list used to hide, since it offered only codes that happened to exist.
  const err2 = await sqlExpectingFailure(
    `INSERT INTO proc.pr_lines (pr_id, line_no, item_id, quantity, uom, unit_price_est, gl_account, description)
     SELECT id, 91, '${laptopItem}', 1, 'NOT_A_UOM', 10, 'NA', 'bogus uom'
       FROM proc.purchase_requisitions WHERE id='${created[0] || gen_random_uuid()}';`);
  check('pr_lines.uom still refuses a code that is not in core.uom', !!err2);
  if (err2) {
    // Without this, a dropped uom FK would still report "refused" if some other
    // NOT NULL column happened to fail first — the probe would pass for the
    // wrong reason, which is worse than not asserting at all.
    check('and the refusal is the uom foreign key',
      /foreign key|violates foreign key constraint/i.test(String(err2)),
      `got: ${String(err2).slice(0, 160)}`);
  }

  // F3. core.uom is still the single vocabulary the form can offer.
  const uomDb = (await rows(`SELECT code FROM core.uom ORDER BY code`)).map(r => r[0]);
  const uomApi = (await post('/lookups/uoms')).body || [];
  check('the UOM endpoint serves exactly what core.uom defines',
    uomApi.length === uomDb.length && uomApi.every(u => uomDb.includes(u.code)),
    `api=${uomApi.length} db=${uomDb.length}`);
  check('the UOM list is no longer the old hardcoded 10',
    uomApi.length > 10, `only ${uomApi.length} codes offered`);

  // F4. onboarding still rejects a category outside the vocabulary.
  //     This is a PUBLIC route (no bearer token) — it is the supplier-facing
  //     application form, so it is exactly the one place an unmapped category
  //     would arrive from outside.
  //
  //     Note the DTO shape: `categories` is a @IsString (the prototype's select
  //     serialises to a single value, possibly a display LABEL) and the company
  //     field is `legalName`. Sending an array or `companyName` is a malformed
  //     request, and a 400 for that reason says nothing about category
  //     validation — which is why the positive case below is asserted too.
  //
  //     A run-unique NTN, because the applications table refuses a repeat and a
  //     leftover from an earlier run would answer 409 instead of 201 — which
  //     looks like "validation is rejecting everything" and is not.
  const stamp = Date.now().toString().slice(-8);
  const applyAs = (categories, ntn) => fetch(`${API}/onboarding/applications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      legalName: `W5J Category Probe ${ntn}`, ntn, strn: `W5J-${ntn}`,
      contactName: 'W5J Probe',
      contactEmail: `w5j.${ntn}@example.com`,
      categories,
    }),
  });

  const unknownVendor = await applyAs('NOT_A_REAL_CATEGORY', `W5JU${stamp}`);
  check('onboarding still refuses an unknown category',
    unknownVendor.status === 400, `HTTP ${unknownVendor.status} ${JSON.stringify(await unknownVendor.json().catch(() => null))}`);

  // ...and still ACCEPTS a real one, so the check above is rejecting a bad value
  // rather than the endpoint being simply closed.
  //
  // The valid value must be a LINE category — the same vocabulary this screen
  // edits. Migration 051 moved the vendor mapping from the D365 ItemGroup library
  // onto core.categories; before that, onboarding validated against ItemGroups and
  // the mismatch here is what let the two vocabularies drift. This assertion is
  // what holds the CURRENT contract in place.
  const goodVendor = await applyAs('OFFICE_SUPPLIES', `W5JG${stamp}`);
  check('onboarding still accepts a valid category',
    goodVendor.status === 201 || goodVendor.status === 200,
    `HTTP ${goodVendor.status} — a 4xx here would mean the endpoint rejects everything, not just bad categories`);
  const goodBody = await goodVendor.json().catch(() => null);
  const appId = goodBody?.id || goodBody?.application?.id;
  if (appId) await sql(`DELETE FROM core.vendor_applications WHERE id='${appId}'`);

  // The other vocabulary is still refused, and refused with a reason that names
  // the mistake rather than a generic "invalid". A blank 400 would leave an
  // operator who typed a legitimate-looking code with no idea what they did
  // wrong — and since migration 051 the line categories ARE accepted here, so
  // the thing worth proving is that a D365 ITEM GROUP is not.
  const igVendor = await applyAs('IG-OFC', `W5JL${stamp}`);
  const igBody = await igVendor.json().catch(() => null);
  check('onboarding refuses a D365 item group and says why',
    igVendor.status === 400
      && /item group/i.test(String(igBody?.message ?? '')),
    `HTTP ${igVendor.status} ${JSON.stringify(igBody?.message ?? null)}`);

  // F5. vendor categories are still governed: a raw UPDATE is still refused.
  const [vid] = await sql(`SELECT id FROM core.vendors ORDER BY vendor_code LIMIT 1`);
  const rawUpdate = await sqlExpectingFailure(
    `UPDATE core.vendors SET preferred_categories = '{OFFICE_SUPPLIES}' WHERE id='${vid}';`);
  check('the vendor governed-change gate still refuses a raw category UPDATE',
    !!rawUpdate, 'the raw UPDATE succeeded');

  // F6. vendor categories are LINE categories, validated by the
  //     migration 037 contract — NOT the line categories. This is the check
  //     that would have caught a trigger trying to force both vocabularies
  //     into one.
  // rows() yields field ARRAYS, so the count is item[0] — comparing the array
  // itself to '0' is always false and reads as "the data is wrong".
  // F6. vendor categories are LINE categories — the vocabulary this screen edits.
  // Migration 051 moved them off the D365 ItemGroup library; a stored value that
  // is neither is exactly the drift that must be caught here.
  const lineOnly = await rows(`
    SELECT count(*) FROM core.vendors v, unnest(v.preferred_categories) c(cat)
     WHERE NOT EXISTS (SELECT 1 FROM core.categories WHERE code = c.cat)`);
  check('every stored vendor category is a line category',
    lineOnly[0]?.[0] === '0', `${lineOnly[0]?.[0]} vendor categor(y/ies) are not line categories`);
  // The mapping table and the array must not drift. They agree by construction
// (a trigger rebuilds the array from the active links) but that is exactly the
// kind of thing that rots, and it is the invariant the RFQ pool and the D365
// payload both read rather than the junction table itself.
  const arrayVsLinks = await rows(`
    SELECT count(*) FROM core.vendors v
     WHERE coalesce((SELECT string_agg(x, ',' ORDER BY x)
                       FROM unnest(coalesce(v.preferred_categories, ARRAY[]::text[])) t(x)), '')
        <> coalesce((SELECT string_agg(k.code, ',' ORDER BY k.code)
                       FROM core.vendor_categories vc
                       JOIN core.categories k ON k.id = vc.category_id
                      WHERE vc.vendor_id = v.id AND vc.is_active), '')`);
  check('the stored array matches the active mapping rows',
    arrayVsLinks[0]?.[0] === '0',
    `${arrayVsLinks[0]?.[0]} vendor(s) have an array that disagrees with their links`);

  // F7. core.items.category is intentionally NOT foreign-keyed, so a catalogue
  //     row can still be given a category the vocabulary does not contain. That
  //     is a known gap, guarded by db/scripts/verify_categories.sql check 2d
  //     rather than by a constraint — record the fact, do not assert it.
  //
  //     Earlier, this check ran the mutation and left the result behind, which
  //     put 'NOT_A_REAL_CATEGORY' on the real Dell Latitude row and then broke
  //     an unrelated proof run (prove_wave5g, which copies i.category into
  //     proc.pr_lines and is stopped by the new foreign key). A test that
  //     asserts a mutation is NOT blocked must never perform it outside a
  //     transaction it rolls back.
  const [origItemCat] = await sql(`SELECT category FROM core.items WHERE item_code='PKB-LT-001'`);
  await sql(`UPDATE core.items SET category='W5J_PROBE_VALUE' WHERE item_code='PKB-LT-001'`);
  const [mutated] = await sql(`SELECT category FROM core.items WHERE item_code='PKB-LT-001'`);
  await sql(`UPDATE core.items SET category='${origItemCat}' WHERE item_code='PKB-LT-001'`);
  const [restored] = await sql(`SELECT category FROM core.items WHERE item_code='PKB-LT-001'`);
  check('core.items.category is unconstrained (gap guarded by verify_categories.sql 2d, not an FK)',
    mutated === 'W5J_PROBE_VALUE', `the UPDATE was refused: got ${mutated}`);
  check('and the probe restored the original value — no residue left behind',
    restored === origItemCat, `left ${restored}, expected ${origItemCat}`);

  // F8. the workflow line rules are still present and still branch on categories.
  const rules = await rows(`
    SELECT count(*) FROM workflow.steps_config s, jsonb_array_elements(s.payload->'lineRules') rule
     WHERE jsonb_array_length(rule->'category') > 0`);
  check('the live line rules are untouched', Number(rules[0]) >= 3, `${rules[0]} rule(s) with categories`);
}

// ── cleanup ───────────────────────────────────────────────────────────────────
for (const id of created) {
  await sql(`DELETE FROM proc.purchase_requisitions WHERE id='${id}'`);
}
if (created.length) console.log(`\n(cleaned up ${created.length} probe PR(s))`);

console.log(`\n${'='.repeat(66)}`);
console.log(`TOTAL  pass=${pass}  fail=${fail}`);
if (fail) { console.log('\nFAILURES:'); failures.forEach(f => console.log(`  - ${f}`)); }
console.log('='.repeat(66));
process.exit(fail ? 1 : 0);
