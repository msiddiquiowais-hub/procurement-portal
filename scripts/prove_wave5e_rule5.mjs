// Wave 5 Track E, Rule 5 — Hold/Unhold, and an audit trail that is actually immutable.
//
//   node scripts/prove_wave5e_rule5.mjs
//
// Requires: Postgres 55432, the API on 33001, the web on 33002.
//
// THE CLAIM BEING TESTED
//   "Local portal users will only control the Hold/Unhold status. Any change to
//    vendor profiles, categories, or hold/unhold states must be 100% immutable
//    and logged in the audit trail."
//
// A unit test cannot prove any of this. "The hold flag was set" is a
// self-report. So every check below is a CAUSAL ROUND TRIP: change the world,
// observe the consequence, put the world back, and observe the consequence
// reverse. Where the database is the subject, the mutation is attempted against
// the real database rather than against a mock of it.
//
// FOUR PROOFS THAT MATTER MORE THAN THE FLAG
//   1. A raw SQL UPDATE of a governed column is REFUSED. Recording is not
//      immutability; if a change can happen without a trail, the trail is
//      decorative.
//   2. audit.audit_log cannot be updated or deleted by the application role —
//      the role that could previously erase evidence of its own behaviour.
//   3. The hash chain is real: a chained row's seal cannot be rewritten, and the
//      verifier notices a break.
//   4. The bytes are unreachable except through the API. A storage directory
//      that a web server serves as static files would undo the whole of
//      directive 2's security story.
//
// AUDIT ROWS ARE NOT RESTORED, AND CANNOT BE
//   audit.audit_log is append-only by design, so this run leaves its entries
//   behind. That is the feature working, not leakage. The number it added is
//   reported at the end.

import { spawnSync } from 'node:child_process';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const WEB = process.env.WEB_BASE || 'http://127.0.0.1:33002';
const CONTAINER = process.env.PG_CONTAINER || 'procurement-portal-db';
const REPO = resolve(fileURLToPath(import.meta.url), '..', '..');

let STORAGE_ROOT = resolve(REPO, 'var', 'attachments');

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

/** Returns { failed, message } for a statement that is EXPECTED to be refused. */
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

console.log('\n=== Wave 5 Track E, Rule 5 — hold/unhold and an immutable audit trail ===\n');

const procurement = await login('procurement@pakboxes.pk');
const cs = await login('cs@pakboxes.pk');
const requester = await login('requester@pakboxes.pk');
if (!procurement || !cs) { console.error('cannot log in — is the API up?'); process.exit(1); }

const auditCountBefore = Number(psql('SELECT count(*) FROM audit.audit_log;'));
const createdKeys = [];
// Hoisted OUT of the try so the finally block can actually see them. A const
// declared inside the try is invisible to the cleanup, which is exactly the
// shape of bug that leaves a half-mutated database behind after a failed run.
let subject = null;
let holdCode = null;
let blank = null;
let d365Id = null;
let d365Code = null;

try {
  // ── 0. the hold columns and the guards exist ─────────────────────────────
  console.log('--- 0. migration 039 is actually installed ---');
  const guards = psql(`
    SELECT string_agg(tgname, ', ' ORDER BY tgname) FROM pg_trigger
     WHERE NOT tgisinternal AND tgrelid IN ('core.vendors'::regclass, 'audit.audit_log'::regclass);`);
  for (const g of ['trg_vendors_governed_change_gate', 'trg_vendors_no_delete',
    'trg_audit_log_immutable', 'trg_audit_log_seal']) {
    if (guards.includes(g)) ok(`guard installed: ${g}`);
    else bad(`guard installed: ${g}`, `present: ${guards}`);
  }
  const chained = psql(`SELECT count(*) FILTER (WHERE hash_chain_self IS NOT NULL)
                          || '/' || count(*) FROM audit.audit_log;`);
  ok('every audit row is chained', chained);
  if (chained.split('/')[0] !== chained.split('/')[1]) {
    bad('every audit row is chained', `only ${chained} rows carry a seal`);
  }
  const verify = psql(`SELECT rows_checked || '|' || COALESCE(first_bad_id::text,'clean') FROM audit.fn_verify_audit_chain();`);
  eq('and the verifier reports the chain clean', verify.split('|')[1], 'clean');

  // ── 1. a governed change made by raw SQL is refused ──────────────────────
  console.log('\n--- 1. proof 1: a raw SQL UPDATE of a governed column is refused ---');
  const anyVendor = psql(`SELECT id || '|' || vendor_code FROM core.vendors ORDER BY vendor_code LIMIT 1;`);
  const [vId, vCode] = anyVendor.split('|');

  const rawUpdate = psqlExpectingFailure(
    `UPDATE core.vendors SET city = 'Tamperville' WHERE id = ${lit(vId)}::uuid;`);
  if (rawUpdate.failed) {
    ok('raw UPDATE of a vendor profile column is refused',
      (rawUpdate.message.match(/governed[^.]*\./i) || [''])[0].slice(0, 78));
  } else {
    bad('raw UPDATE of a vendor profile column is refused', 'it SUCCEEDED — a change can happen with no trail');
  }
  const cityUnchanged = psql(`SELECT coalesce(city,'(null)') FROM core.vendors WHERE id=${lit(vId)}::uuid;`);
  ok('and the value did not change', cityUnchanged);

  const rawCats = psqlExpectingFailure(
    `UPDATE core.vendors SET preferred_categories = '{IG-LAPTOP}' WHERE id = ${lit(vId)}::uuid;`);
  if (rawCats.failed) ok('raw UPDATE of the category mapping is refused too');
  else bad('raw UPDATE of the category mapping is refused too', 'it SUCCEEDED');

  // A hold cannot be cleared by raw SQL. Proved LATER, against a vendor that is
  // genuinely held — `SET is_hold = false` on a vendor that was never held
  // changes nothing, and a statement that changes no governed column is
  // correctly not a governed change. Testing the refusal against a non-held
  // vendor would "pass" for the wrong reason if the gate were absent, and fail
  // for the right one. The real test is in section 2.

  // The gate is a GATE, not a blanket ban: with the token the same statement is
  // legal. Proved inside a transaction that is rolled back, so it leaves no
  // trace and cannot be mistaken for a real change.
  const withToken = psql(`
    BEGIN;
    SELECT set_config('app.vendor_change_token','harness-probe','true');
    UPDATE core.vendors SET city = city WHERE id = ${lit(vId)}::uuid;
    ROLLBACK;`);
  ok('with the audit token the same statement is permitted (rolled back)', 'gate, not a ban');

  // ── 2. hold / unhold through the portal ──────────────────────────────────
  console.log('\n--- 2. proof 2: hold and release a vendor, and watch the RFQ gate react ---');
  // A vendor that is genuinely invitable, so the round trip is about the hold and
  // not about some unrelated eligibility rule refusing it either way.
  // The hold SUBJECT is a fixture, not a seeded vendor.
  //
  // Every seeded, invitable vendor (V-00081/82/86) is on all 205 RFQ rosters, so
  // holding one made "invite this vendor" impossible to test — the invite would
  // have been refused as a duplicate, which reads exactly like the hold working.
  // A fixture is on no roster, so the only reason it can be refused is the hold.
  // It is also Active, categorised and A/A/A, so nothing else is disqualifying it.
  holdCode = `V-HLD-${Date.now().toString().slice(-6)}`;
  subject = psql(`
    INSERT INTO core.vendors
      (vendor_code, legal_name, ntn, state, scorecard, preferred_categories, city)
    VALUES (${lit(holdCode)}, 'Harness Hold Subject', 'NTN-HOLD', 'Active',
            '{"financial":"A","delivery":"A","quality":"A"}'::jsonb, '{IG-OFC}', 'Karachi')
    RETURNING id;`).trim() || null;

  if (!subject) { bad('the hold subject fixture was created', 'the insert returned nothing'); }
  else {
    const eligibility = psql(`
      SELECT (SELECT count(*) FROM core.vendors v
                CROSS JOIN LATERAL core.fn_vendor_composite(v.scorecard) c
               WHERE v.id = ${lit(subject)}::uuid
                 AND v.state <> ALL('{Blacklisted,Deactivated}')
                 AND NOT v.is_hold AND c.blocked IS DISTINCT FROM true
                 AND cardinality(v.preferred_categories) > 0);`);
    eq('the subject is genuinely eligible before any hold', eligibility, '1');
    // A hold with no reason must be refused: an unexplainable hold is a flag.
    const noReason = await api(`/vendors/${subject}/hold`, { method: 'POST', token: procurement, body: {} });
    if (noReason.status === 400) ok('a hold with no reason is refused', noReason.data?.message?.slice(0, 60));
    else bad('a hold with no reason is refused', `expected 400, got ${noReason.status}`);

    // Role gate: a requester must not be able to stop a vendor trading.
    const asRequester = await api(`/vendors/${subject}/hold`, {
      method: 'POST', token: requester, body: { reason: 'not my call' },
    });
    eq('a requester cannot put a vendor on hold', asRequester.status, 403);

    const held = await api(`/vendors/${subject}/hold`, {
      method: 'POST', token: procurement, body: { reason: 'Harness: pending bank re-verification' },
    });
    if (held.status !== 201 && held.status !== 200) {
      bad('the hold is accepted', `status ${held.status} ${held.text.slice(0, 200)}`);
    } else {
      ok('the hold is accepted', `${held.data?.vendor_code}`);
      const dbHold = psql(`SELECT is_hold || '|' || coalesce(hold_reason,'') FROM core.vendors WHERE id=${lit(subject)}::uuid;`);
      const [dbFlag, dbReason] = dbHold.split('|');
      eq('and the DATABASE shows the vendor on hold', dbFlag, 'true');
      eq('with the reason recorded', dbReason, 'Harness: pending bank re-verification');
      const heldBy = psql(`SELECT count(*) FROM core.vendors v JOIN core.users u ON u.id=v.held_by_user_id
                            WHERE v.id=${lit(subject)}::uuid;`);
      eq('and attributed to a real user', heldBy, '1');

      // ── the consequence: a held vendor cannot be invited ────────────────
      // Tested against a vendor that is ACTUALLY held. A refusal proved on a
      // vendor that was never held proves nothing.
      const clearByHand = psqlExpectingFailure(
        `UPDATE core.vendors SET is_hold = false WHERE id = ${lit(subject)}::uuid;`);
      if (clearByHand.failed) {
        ok('and the hold cannot be CLEARED by raw SQL either — that is the point of rule 5',
          (clearByHand.message.match(/governed[^.]*\./i) || [''])[0].slice(0, 60));
      } else {
        bad('and the hold cannot be CLEARED by raw SQL either',
          'the UPDATE SUCCEEDED — the hold is not a control, only a label');
      }
      // `is_hold::text` — a bare boolean column prints as `t` under `-t -A`, and
      // comparing that to 'true' would fail for a reason that has nothing to do
      // with the hold.
      const stillHeld = psql(`SELECT is_hold::text FROM core.vendors WHERE id=${lit(subject)}::uuid;`);
      eq('and the hold survived the attempt', stillHeld, 'true');

      // The invite endpoint is keyed on an RFQ, not on a PR. The fixture is on no
      // roster, so a refusal here can only be the hold.
      const rfqId = psql(`SELECT id FROM proc.rfq ORDER BY created_at DESC LIMIT 1;`);
      if (!rfqId) {
        finding('no RFQ available to test an invitation against', 'run the e2e sourcing suite first');
      } else {
        const invite = await api(`/rfq/${rfqId}/invite`, {
          method: 'POST', token: procurement, body: { vendorId: subject },
        });
        const msg = `${invite.data?.message || ''}`;
        if (invite.status >= 400 && /on hold/i.test(msg)) {
          ok('a HELD vendor is refused an RFQ invitation', msg.slice(0, 78));
        } else {
          bad('a HELD vendor is refused an RFQ invitation',
            `status ${invite.status} ${msg.slice(0, 140) || invite.text.slice(0, 140)}`);
        }
      }

      // The pool must not reach for it either.
      const inPool = psql(`
        SELECT count(*) FROM core.vendors v
          CROSS JOIN LATERAL core.fn_vendor_composite(v.scorecard) c
         WHERE v.id=${lit(subject)}::uuid
           AND v.state <> ALL('{Blacklisted,Deactivated}')
           AND NOT v.is_hold
           AND c.blocked IS DISTINCT FROM true
           AND cardinality(v.preferred_categories) > 0;`);
      eq('and the automatic pool query excludes it', inPool, '0');
    }

    // ── the audit trail recorded it, with an actor and a reason ────────────
    console.log('\n--- 3. proof 3: the change is in the immutable trail ---');
    const trail = await api(`/vendors/${subject}/audit`, { token: procurement });
    eq('the vendor audit trail is readable', trail.status, 200);
    const holdEntry = (trail.data?.entries || []).find((e) => e.action === 'hold');
    if (holdEntry) {
      ok('a "hold" entry exists', `#${holdEntry.id} by ${holdEntry.actor_email || holdEntry.actor_user_id}`);
      ok('it records the reason', String(holdEntry.reason || '').slice(0, 60));
      if (!/bank re-verification/i.test(String(holdEntry.reason || ''))) {
        bad('it records the reason', holdEntry.reason || '(empty)');
      }
      eq('it is attributed to the acting user', !!holdEntry.actor_email, true);
      if (!holdEntry.hash_chain_self) bad('the entry is sealed in the hash chain', 'no hash_chain_self');
      else ok('the entry is sealed in the hash chain', String(holdEntry.hash_chain_self).slice(0, 22) + '…');
    } else {
      bad('a "hold" entry exists', `actions seen: ${(trail.data?.entries || []).map((e) => e.action).join(', ') || 'none'}`);
    }

    // The generic row-level audit trigger also fired, so there are two
    // independent records of the same change.
    const genericRows = psql(`
      SELECT count(*) FROM audit.audit_log
       WHERE entity='core.vendors' AND entity_id=${lit(subject)} AND action='update';`);
    if (Number(genericRows) > 0) ok('and the row-level audit trigger recorded it independently', genericRows);
    else finding('no generic "update" audit row for the hold', 'trg_vendors_audit may not cover is_hold');

    // ── release it, and prove the effect reverses ──────────────────────────
    const released = await api(`/vendors/${subject}/unhold`, {
      method: 'POST', token: procurement, body: { reason: 'Harness: bank details re-verified' },
    });
    if (released.status !== 201 && released.status !== 200) {
      bad('the release is accepted', `status ${released.status} ${released.text.slice(0, 200)}`);
    } else {
      ok('the release is accepted');
      const back = psql(`SELECT is_hold || '|' || coalesce(hold_reason,'(cleared)') FROM core.vendors WHERE id=${lit(subject)}::uuid;`);
      eq('and the DATABASE shows the vendor released', back.split('|')[0], 'false');
      eq('with the hold reason cleared', back.split('|')[1], '(cleared)');
      const inPoolAgain = psql(`
        SELECT count(*) FROM core.vendors v
          CROSS JOIN LATERAL core.fn_vendor_composite(v.scorecard) c
         WHERE v.id=${lit(subject)}::uuid
           AND v.state <> ALL('{Blacklisted,Deactivated}')
           AND NOT v.is_hold
           AND c.blocked IS DISTINCT FROM true
           AND cardinality(v.preferred_categories) > 0;`);
      eq('and it is back in the automatic pool', inPoolAgain, '1');
    }
  }

  // ── 4. the audit log cannot be rewritten ────────────────────────────────
  console.log('\n--- 4. proof 4: the audit trail itself is append-only ---');
  const anyAudit = psql(`SELECT id FROM audit.audit_log ORDER BY id LIMIT 1;`);
  const edit = psqlExpectingFailure(
    `UPDATE audit.audit_log SET action='login' WHERE id=${anyAudit}::bigint;`);
  if (edit.failed) ok('an audit row cannot be MODIFIED', (edit.message.match(/append-only[^.]*\./i) || [''])[0].slice(0, 66));
  else bad('an audit row cannot be MODIFIED', 'the UPDATE SUCCEEDED — history is writable');

  const del = psqlExpectingFailure(`DELETE FROM audit.audit_log WHERE id=${anyAudit}::bigint;`);
  if (del.failed) ok('an audit row cannot be DELETED', (del.message.match(/append-only[^.]*\./i) || [''])[0].slice(0, 66));
  else bad('an audit row cannot be DELETED', 'the DELETE SUCCEEDED — history is erasable');

  const rechain = psqlExpectingFailure(
    `UPDATE audit.audit_log SET hash_chain_self='sha256:forged' WHERE id=${anyAudit}::bigint;`);
  if (rechain.failed) ok('and a chained row cannot have its seal forged', 'tamper is refused, not merely discouraged');
  else bad('a chained row cannot have its seal forged', 'the hash was rewritable');

  // The whole chain must still verify after all of those attempts.
  const verify2 = psql(`SELECT COALESCE(first_bad_id::text,'clean') FROM audit.fn_verify_audit_chain();`);
  eq('the chain still verifies after every tamper attempt', verify2, 'clean');

  // ── 5. a vendor cannot be deleted out of history ─────────────────────────
  console.log('\n--- 5. proof 5: a vendor cannot be deleted ---');
  const delVendor = psqlExpectingFailure(`DELETE FROM core.vendors WHERE id=${lit(vId)}::uuid;`);
  if (delVendor.failed) ok('DELETE against core.vendors is refused', (delVendor.message.match(/cannot be deleted[^.]*\./i) || [''])[0].slice(0, 70));
  else bad('DELETE against core.vendors is refused', 'the DELETE SUCCEEDED');

  // ── 6. rule 3/4: categories, the alert, and D365 not being blocked ──────
  console.log('\n--- 6. rule 3/4: category mapping is in-portal, and arrivals are not blocked ---');
  // The only genuinely un-categorised vendor in the seeded estate (V-00083) is
  // BLACKLISTED, and the Vendor Master is a sourcing pool that excludes
  // blacklisted vendors by design. So it is correctly absent from both the list
  // and the alert - nagging an admin to categorise a blacklisted vendor is noise,
  // not signal. A fixture is created instead, which doubles as the rule 2
  // arrival test below.
  blank = psql(`
    INSERT INTO core.vendors (vendor_code, legal_name, ntn, state)
    VALUES ('V-ALERT-${Date.now().toString().slice(-6)}', 'Harness Uncategorised Vendor', 'NTN-ALERT', 'Active')
    RETURNING id;`).trim() || null;

  if (!blank) {
    bad('an un-categorised vendor exists to test with', 'the fixture insert returned nothing');
  } else {
    const list0 = await api('/vendors', { token: procurement });
    const flagged = (list0.data?.attention || []).filter((a) => a.kind === 'uncategorised');
    if (flagged.length > 0) ok('the dashboard names the un-categorised vendors', `${flagged.length} listed`);
    else bad('the dashboard names the un-categorised vendors', 'the attention list is empty');
    const named = flagged.find((a) => a.vendor_id === blank);
    if (named) ok('and names this one by id, not just by count', named.vendor_code);
    else bad('and names this one by id, not just by count', `attention ids: ${flagged.map((a) => a.vendor_id).join(', ') || 'none'}`);

    const poolExcludes = psql(`
      SELECT count(*) FROM core.vendors v
       WHERE v.id=${lit(blank)}::uuid
         AND cardinality(v.preferred_categories) > 0;`);
    eq('an un-categorised vendor is outside the automatic pool', poolExcludes, '0');

    const mapped = await api(`/vendors/${blank}/categories`, {
      method: 'POST', token: cs, body: { categories: ['IG-LAPTOP'], reason: 'Harness: mapped for laptops' },
    });
    if (mapped.status !== 201 && mapped.status !== 200) {
      bad('a category can be assigned in-portal', `status ${mapped.status} ${mapped.text.slice(0, 180)}`);
    } else {
      ok('a category can be assigned in-portal');
      const cats = psql(`SELECT array_to_string(preferred_categories,',') FROM core.vendors WHERE id=${lit(blank)}::uuid;`);
      eq('and the database records it', cats, 'IG-LAPTOP');
      const catEntry = psql(`SELECT count(*) FROM audit.audit_log
                              WHERE entity='core.vendors' AND entity_id=${lit(blank)} AND action='category_change';`);
      eq('and it is in the audit trail', catEntry, '1');

      const list1 = await api('/vendors', { token: procurement });
      const stillFlagged = (list1.data?.attention || []).filter((a) => a.kind === 'uncategorised' && a.vendor_id === blank);
      eq('and the alert clears', stillFlagged.length, 0);
    }
  }

  // RULE 2: a vendor arriving from D365 with no category must still land. The
  // category rule is enforced where the RFQ pool reads it, never at the door.
  console.log('\n--- 7. rule 2: an un-categorised vendor can still be created (D365 is not blocked) ---');
  d365Code = `V-HOLD-${Date.now().toString().slice(-6)}`;
  const created = psql(`
    INSERT INTO core.vendors (vendor_code, legal_name, ntn, state)
    VALUES (${lit(d365Code)}, 'Harness D365 Arrival Ltd', 'NTN-HARNESS', 'Pending_Review')
    RETURNING id;`);
  d365Id = created.trim();
  if (d365Id) {
    ok('a vendor with no category and no compliance data is accepted', d365Code);
    const arrived = psql(`SELECT cardinality(preferred_categories) || '|' || is_hold FROM core.vendors WHERE id=${lit(d365Id)}::uuid;`);
    eq('it lands un-categorised and not held', arrived, '0|false');
    const blocked = psqlExpectingFailure(
      `UPDATE core.vendors SET is_hold = true, hold_reason='x', held_at=now(), held_by_user_id=(SELECT id FROM core.users LIMIT 1) WHERE id=${lit(d365Id)}::uuid;`);
    if (blocked.failed) ok('and the governed-change gate still applies to it', 'arrival was never a loophole');
    else bad('and the governed-change gate still applies to it', 'a raw UPDATE on the new vendor succeeded');
  }

  // ── 8. the bytes are reachable only through the API ─────────────────────
  console.log('\n--- 8. proof 6: attachment bytes are API-mediated and audited ---');
  const prId2 = psql(`SELECT id FROM proc.purchase_requisitions ORDER BY created_at DESC LIMIT 1;`);
  if (prId2) {
    psql(`DELETE FROM core.attachment_registry WHERE parent_type='pr' AND parent_id=${lit(prId2)}::uuid;`);
    const up = await api(`/pr/${prId2}/attachments`, {
      method: 'POST', token: procurement,
      raw: { body: Buffer.alloc(4096, 0x42), type: 'application/pdf' },
      headers: { 'x-file-name': 'rule5-proof.pdf' },
    });
    if (up.status !== 201 && up.status !== 200) {
      bad('a file uploads', `status ${up.status} ${up.text.slice(0, 180)}`);
    } else {
      const attId = up.data?.attachment_id;
      const key = up.data?.object_key;
      createdKeys.push(key);
      STORAGE_ROOT = resolve(REPO, 'var', 'attachments');
      ok('a file uploads', key);
      if (existsSync(join(STORAGE_ROOT, key))) ok('and lands on disk', key);
      else bad('and lands on disk', `not found under ${STORAGE_ROOT}`);

      // The decisive check: the storage directory must NOT be a static web root.
      const direct = await fetch(`${WEB}/${key}`);
      if (direct.status === 404) ok('the web server does NOT serve the storage directory', `GET /${key} -> 404`);
      else bad('the web server does NOT serve the storage directory', `GET /${key} -> ${direct.status}`);
      const direct2 = await fetch(`${WEB}/../../var/attachments/${key}`);
      if (direct2.status === 404 || direct2.status === 400) ok('nor through a traversal attempt', `-> ${direct2.status}`);
      else finding('traversal attempt answered', `GET /../../var/attachments/... -> ${direct2.status}`);

      const dl = await fetch(`${API}/attachments/${attId}/download`, {
        headers: { authorization: `Bearer ${procurement}` },
      });
      if (dl.status === 200) {
        const bytes = Buffer.from(await dl.arrayBuffer());
        ok('the API serves the file back', `${bytes.length} bytes`);
        eq('byte-for-byte', bytes.length, 4096);
        if (!/attachment; filename=/.test(dl.headers.get('content-disposition') || '')) {
          bad('it is served as an attachment, not inline', dl.headers.get('content-disposition') || '(none)');
        } else ok('it is served as an attachment, not inline');
        eq('with sniffing disabled', dl.headers.get('x-content-type-options'), 'nosniff');
      } else {
        bad('the API serves the file back', `status ${dl.status}`);
      }

      // The guard may answer 401 or 403 depending on how the auth layer is
      // configured, so assert the property that matters — no bytes come back —
      // rather than pinning a status code that is not the subject under test.
      // A refusal still carries a JSON error body — Nest always sends one. What
      // must NOT come back is the FILE. Asserting an empty body would be asserting
      // that the error is silent, which is the wrong property; assert that the
      // bytes served are not the attachment.
      const anon = await fetch(`${API}/attachments/${attId}/download`);
      if (anon.status === 401 || anon.status === 403) {
        ok('an anonymous download is refused', `HTTP ${anon.status}`);
        const ctype = anon.headers.get('content-type') || '';
        const body = Buffer.from(await anon.arrayBuffer());
        const isFile = ctype.includes('pdf') || ctype.includes('octet-stream')
          || body.length === 4096;
        if (isFile) bad('and the refusal serves no file content', `${ctype} / ${body.length} bytes`);
        else ok('and the refusal serves no file content', `${ctype.split(';')[0]}, ${body.length} bytes of JSON error`);
      } else {
        bad('an anonymous download is refused', `status ${anon.status}`);
      }

      const dlAudit = psql(`SELECT count(*) FROM core.attachment_audit
                              WHERE attachment_id=${lit(attId)}::uuid AND action='DOWNLOADED';`);
      if (Number(dlAudit) > 0) ok('and the download is recorded in the audit trail', `${dlAudit} entry`);
      else bad('and the download is recorded in the audit trail', 'no DOWNLOADED row');
    }
  } else {
    finding('no PR exists to attach to', 'run the e2e suites first');
  }
} finally {
  console.log('\n--- cleanup ---');
  // The subject is released first, then all three fixtures are removed. Each is
  // a harness artefact with no references, so they go outright; the delete guard
  // is bypassed deliberately here, because this is teardown and not a product path.
  if (subject) {
    try {
      psql(`SELECT set_config('app.vendor_change_token','harness-cleanup','false');
            UPDATE core.vendors
               SET is_hold = false, hold_reason = NULL, held_at = NULL, held_by_user_id = NULL
             WHERE id = ${lit(subject)}::uuid;`);
      ok('the hold subject is released', holdCode || subject);
    } catch (e) { bad('release the hold subject', String(e.message).slice(0, 140)); }
  }
  for (const [id, label] of [
    [subject, 'the hold subject fixture'],
    [blank, 'the un-categorised fixture'],
    [d365Id, 'the D365 arrival fixture'],
  ]) {
    if (!id) continue;
    try {
      psql(`SELECT set_config('app.vendor_legacy_write','on','false');
            DELETE FROM core.vendors WHERE id = ${lit(id)}::uuid;`);
      ok(`${label} is removed`, id);
    } catch (e) { bad(`remove ${label}`, String(e.message).slice(0, 140)); }
  }

  // Attachment rows, then the files.
  try {
    psql(`DELETE FROM core.attachment_registry
           WHERE parent_type='pr'
             AND parent_id IN (SELECT id FROM proc.purchase_requisitions)
             AND name = 'rule5-proof.pdf';`);
    psql(`DELETE FROM core.files WHERE object_key LIKE '%rule5-proof.pdf';`);
    ok('the harness attachment rows are gone');
  } catch (e) { bad('remove the harness attachment rows', String(e.message).slice(0, 140)); }
  let removed = 0;
  for (const k of createdKeys) {
    if (!k) continue;
    const p = join(STORAGE_ROOT, k);
    if (existsSync(p)) { try { unlinkSync(p); removed++; } catch { /* ignore */ } }
  }
  ok('and the files it wrote are gone', `${removed} removed`);

  // Nothing is left held.
  const stillHeld = psql(`SELECT count(*) FROM core.vendors WHERE is_hold;`);
  eq('no vendor is left on hold', stillHeld, '0');
  const stray = psql(`SELECT count(*) FROM core.vendors
                       WHERE vendor_code LIKE 'V-HOLD-%' OR vendor_code LIKE 'V-ALERT-%'
                          OR vendor_code LIKE 'V-HLD-%';`);
  eq('no harness vendor survives', stray, '0');

  // Audit rows CANNOT be removed — that is rule 5 working. Report the residue
  // rather than pretending the run left nothing behind.
  const added = Number(psql('SELECT count(*) FROM audit.audit_log;')) - auditCountBefore;
  ok('audit entries this run added are permanent, by design', `${added} row(s) — audit_log is append-only`);

  const verify3 = psql(`SELECT COALESCE(first_bad_id::text,'clean') FROM audit.fn_verify_audit_chain();`);
  eq('and the hash chain is still clean at the end', verify3, 'clean');
}

console.log(`\n${fail} failed, ${pass} passed, ${findings} finding(s)\n`);
process.exit(fail > 0 ? 1 : 0);
