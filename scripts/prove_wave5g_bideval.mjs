#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// prove:wave5g — Comparative Statement & Bid Evaluation.
//
// THE DEFECT THIS PROVES CLOSED
//
// Wave 5 Track F built the split-award machinery — `proc.cs_line_awards`,
// supersede-not-overwrite, re-award — but a split could not be LOCKED. The CS
// lock demanded one `winnerVendorId` from `proc.cs_lines` (per VENDOR) and
// wrote a recommendation with one `winner_vendor_id`. Three concrete failures
// followed, and each is reproduced-then-refuted here:
//
//   1. Locking a split discarded `proc.cs_line_awards` entirely — the decision
//      left no trace in the record that becomes the approved pack.
//   2. It marked ONE quotation 'Awarded' and every other quote 'Rejected', so a
//      vendor who had just WON line 2 had their live quote recorded as REJECTED.
//   3. d365.service.ts INNER JOINed on `recommendation->>'winner_vendor_id'`. A
//      split has none, so the join produced NO ROW — a silently empty PO.
//
// Track G makes the split a first-class outcome: `award_mode` records which
// shape the decision took, the database refuses a split that claims a single
// winner, and every downstream reader reads the shape that actually exists.
//
// EVERY MUTATION IS RESTORED IN `finally`. Audit rows cannot be restored — that
// is Rule 5 working — and the count is reported rather than hidden.
// ═══════════════════════════════════════════════════════════════════════════

import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const CONTAINER = process.env.PG_CONTAINER || 'procurement-portal-db';
const REPO = resolve(fileURLToPath(import.meta.url), '..', '..');

let pass = 0, fail = 0, findings = 0;
const ok = (label, extra = '') => { pass++; console.log(`  PASS  ${label}${extra ? `  (${extra})` : ''}`); };
const bad = (label, detail) => { fail++; console.log(`  FAIL  ${label}\n        ${detail}`); };
const finding = (label, detail) => { findings++; console.log(`  FINDING  ${label}\n            ${detail}`); };
const eq = (label, actual, expected) => {
  if (String(actual) === String(expected)) ok(label, String(actual));
  else bad(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

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

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data, text };
}

const login = async (email) =>
  (await api('/auth/login', { method: 'POST', body: { email, password: 'demo' } })).data?.token;

const uuidish = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

async function main() {
  console.log('\n══ prove:wave5g — Comparative Statement & Bid Evaluation ══\n');

  const procurement = await login('procurement@pakboxes.pk');
  if (!procurement) {
    // Every `return` below skips the summary at the bottom of this function, so
    // bailing out from here must still fail the process. A harness that prints
    // a failure and exits 0 is worse than one that throws: `npm test` chains on
    // the exit code and would carry on to the next suite.
    console.error('cannot log in — is the API up?');
    process.exit(1);
  }
  ok('signed in as a procurement officer');

  let prId = null, rfqId = null, csId = null;
  let vendorA = null, vendorB = null;
  const pdfs = [];

  try {
    // ── 1. fixture ─────────────────────────────────────────────────────────
    // Two awardable lines on one PR, so a split across two vendors is possible.
    // Routing is deliberately STANDARD, not FAST_TRACK. FAST_TRACK auto-locks an
    // approved pack on CS lock, and `proc.fn_reject_pack_mutation` refuses every
    // mutation INCLUDING DELETE on a frozen pack — so a FAST_TRACK fixture could
    // never be cleaned up and would leak a PR, CS, quotations and pack into the
    // database on every run. Immutability there is correct product behaviour;
    // the fixture works around it, not the guard.
    prId = psql(`
      INSERT INTO proc.purchase_requisitions
        (pr_number, title, description, requester_user_id, department_id, cost_center_id,
         expense_type, required_by_date, status, routing_key, warehouse_check_required,
         estimated_amount, capex_amount, opex_amount, currency, scope, attachments,
         version, urgency, workflow_snapshot)
      SELECT 'PR-W5G-' || to_char(now(),'HH24MISS'), 'Harness split fixture', 'split-award lock proof',
             p.requester_user_id, p.department_id, p.cost_center_id,
             p.expense_type, (current_date + 30), 'IN_PROCUREMENT_REVIEW', 'STANDARD', false,
             0, 0, 0, p.currency, p.scope, p.attachments, 1, p.urgency, p.workflow_snapshot
        FROM proc.purchase_requisitions p
       WHERE p.status = 'IN_PROCUREMENT_REVIEW'
       ORDER BY p.created_at DESC LIMIT 1
      RETURNING id;`).trim();

    const itemA = psql(`SELECT id FROM core.items WHERE active ORDER BY item_code LIMIT 1;`).trim();
    const itemB = psql(`SELECT id FROM core.items WHERE active ORDER BY item_code OFFSET 1 LIMIT 1;`).trim();

    psql(`
      INSERT INTO proc.pr_lines
        (pr_id, line_no, item_id, quantity, uom, unit_price_est, gl_account, description, category)
      SELECT ${lit(prId)}::uuid, n.line_no, i.id, n.qty,
             COALESCE((SELECT code FROM core.uom WHERE code = 'EA'),
                      (SELECT code FROM core.uom ORDER BY code LIMIT 1)),
             100, i.gl_account, n.descr, i.category
        FROM (VALUES
          (1, 10::numeric, 'W5G line 1 — awarded to vendor A'),
          (2,  5::numeric, 'W5G line 2 — awarded to vendor B')
        ) AS n(line_no, qty, descr)
        JOIN core.items i ON i.id = ${lit(itemA)}::uuid;`);
    ok('fixture PR carries two awardable lines', prId);

    // Two ACTIVE, categorised, emailed vendors. Not held, not blacklisted.
    // `core.vendors` stores the address as `contact_email` (there is no `email`
    // column), and `core.vendor_blacklist` exists as a table.
    const pool = psql(`
      SELECT v.id::text FROM core.vendors v
       WHERE v.is_hold = false
         AND v.contact_email IS NOT NULL AND v.contact_email <> ''
         AND cardinality(v.preferred_categories) > 0
         AND NOT EXISTS (SELECT 1 FROM core.vendor_blacklist b WHERE b.vendor_id = v.id)
       ORDER BY v.vendor_code LIMIT 2;`).split('\n').map(s => s.trim()).filter(Boolean);
    if (pool.length < 2) {
      bad('two usable vendors exist', `found ${pool.length}; the split proof needs two bidders`);
      return;
    }
    vendorA = pool[0]; vendorB = pool[1];
    ok('two bidders available', psql(`SELECT string_agg(v.vendor_code, ' + ') FROM core.vendors v WHERE v.id = ANY(ARRAY[${lit(vendorA)}::uuid,${lit(vendorB)}::uuid]);`));

    const issued = await api(`/pr/${prId}/rfq`, { method: 'POST', token: procurement, body: { title: 'W5G harness RFQ' } });
    rfqId = issued.data?.rfq?.id || issued.data?.id || null;
    if (!uuidish(rfqId)) { bad('the RFQ is issued', `status ${issued.status} ${issued.text.slice(0, 200)}`); return; }
    ok('the RFQ is issued', issued.data?.rfq?.number || rfqId);

    // Track F's smart filtering already puts every matching vendor on the
    // roster when the RFQ is issued, so these two are normally invited already.
    // Inviting again is correctly REFUSED ("already on this RFQ's roster"), so
    // the assertion is roster membership, not the invite call succeeding.
    for (const [v, who] of [[vendorA, 'A'], [vendorB, 'B']]) {
      const onRoster = psql(`SELECT count(*) FROM proc.rfq_invitations
                              WHERE rfq_id=${lit(rfqId)}::uuid AND vendor_id=${lit(v)}::uuid;`).trim();
      if (Number(onRoster) < 1) {
        const r = await api(`/rfq/${rfqId}/invite`, { method: 'POST', token: procurement, body: { vendorId: v } });
        if (r.status >= 400) { bad(`vendor ${who} is on the RFQ roster`, `status ${r.status} ${r.text.slice(0, 180)}`); return; }
      }
    }
    const roster = psql(`SELECT count(*) FROM proc.rfq_invitations
                           WHERE rfq_id=${lit(rfqId)}::uuid AND vendor_id = ANY(ARRAY[${lit(vendorA)}::uuid,${lit(vendorB)}::uuid]);`).trim();
    eq('both bidders are on the RFQ roster', roster, '2');

    const lines = psql(`SELECT string_agg(line_no::text, ',' ORDER BY line_no) FROM proc.rfq_lines WHERE rfq_id=${lit(rfqId)}::uuid;`).trim();
    const lineNos = lines.split(',').map(Number);

    for (const [v, base] of [[vendorA, 500], [vendorB, 700]]) {
      const q = await api(`/rfq/${rfqId}/quotations`, {
        method: 'POST', token: procurement,
        body: {
          vendorId: v, leadTimeDays: 14, warrantyMonths: 12,
          paymentTerms: '30 days from invoice', validityDays: 45,
          lines: lineNos.map((n, i) => ({ rfqLineNo: n, unitPrice: base + (i * 50) })),
        },
      });
      if (q.status >= 400) { bad(`vendor ${v === vendorA ? 'A' : 'B'} quotes`, `status ${q.status} ${q.text.slice(0, 160)}`); return; }
    }
    ok('both vendors quote every line', `${lineNos.length} line(s) each`);

    const gen = await api(`/pr/${prId}/cs`, { method: 'POST', token: procurement, body: {} });
    csId = gen.data?.cs?.id || gen.data?.id || null;
    if (!uuidish(csId)) { bad('the CS is generated', `status ${gen.status} ${gen.text.slice(0, 200)}`); return; }
    ok('the CS is generated', gen.data?.cs?.cs_number || csId);

    // ── 2. a PARTIAL split must be refused ────────────────────────────────
    const award1 = await api(`/cs/${csId}/award`, {
      method: 'POST', token: procurement,
      body: { lineNo: lineNos[0], vendorId: vendorA, qty: 10, justification: 'Lowest landed cost on line 1.' },
    });
    if (award1.status >= 400) { bad('line 1 is awarded', `status ${award1.status} ${award1.text.slice(0, 200)}`); return; }
    ok('line 1 is awarded to vendor A');

    const partial = await api(`/cs/${csId}/lock`, { method: 'POST', token: procurement, body: { reason: 'try to lock early' } });
    if (partial.status === 400 && /no winner yet/i.test(partial.text)) {
      ok('a PARTIAL split is refused, naming the unawarded line', partial.data?.message?.slice(0, 90));
    } else {
      bad('a PARTIAL split is refused, naming the unawarded line', `status ${partial.status} ${partial.text.slice(0, 220)}`);
    }

    // ── 3. award the remaining line to the OTHER vendor ────────────────────
    const award2 = await api(`/cs/${csId}/award`, {
      method: 'POST', token: procurement,
      body: {
        lineNo: lineNos[1], vendorId: vendorB, qty: 5,
        justification: 'Sole vendor with the certified spare-parts capability for line 2.',
      },
    });
    if (award2.status >= 400) { bad('line 2 is awarded to vendor B', `status ${award2.status} ${award2.text.slice(0, 200)}`); return; }
    ok('line 2 is awarded to vendor B — a genuine split');

    const live = psql(`SELECT count(*) FROM proc.cs_line_awards WHERE cs_id=${lit(csId)}::uuid AND superseded_at IS NULL;`).trim();
    eq('two live awards, one per line, on one CS', live, '2');

    // ── 4. the database refuses a split that claims a single winner ────────
    // Proved at the schema, not at the service. A service-level rule can be
    // bypassed by any other writer; a CHECK cannot.
    // `generated_by_user_id` is NOT NULL and the pre-existing
    // `comparative_statements_lock_consistency` requires locked_at +
    // locked_by_user_id when state='Locked'. All of it is supplied so the probe
    // falls through to `comparative_statements_split_consistency` — otherwise it
    // trips the older constraint first and "passes" for the wrong reason, which
    // is how a test proves nothing while reporting green.
    const bogusUser = psql(`SELECT requester_user_id::text FROM proc.purchase_requisitions WHERE id=${lit(prId)}::uuid;`).trim();

    const bogus = psqlExpectingFailure(`
      INSERT INTO proc.comparative_statements
        (cs_number, pr_id, rfq_id, cs_round, generated_at, generated_by_user_id,
         locked_at, locked_by_user_id, state, scores, recommendation, award_mode)
      SELECT 'CS-W5G-BOGUS', pr_id, rfq_id, 99, now(), ${lit(bogusUser)}::uuid,
             now(), ${lit(bogusUser)}::uuid, 'Locked', '{}'::jsonb,
             jsonb_build_object('winner_vendor_id', ${lit(vendorA)}::text, 'split', '[{"line_no":1}]'::jsonb),
             'SPLIT'
      FROM proc.comparative_statements WHERE id = ${lit(csId)}::uuid;`);
    if (bogus.failed && /comparative_statements_split_consistency/i.test(bogus.message)) {
      ok('the DATABASE refuses a SPLIT that also names a winner', bogus.message.split('\n')[0].slice(0, 90));
    } else {
      bad('the DATABASE refuses a SPLIT that also names a winner', `psql failed for the wrong reason: ${bogus.message.split('\n')[0].slice(0, 200)}`);
    }

    const bogus2 = psqlExpectingFailure(`
      INSERT INTO proc.comparative_statements
        (cs_number, pr_id, rfq_id, cs_round, generated_at, generated_by_user_id,
         locked_at, locked_by_user_id, state, scores, recommendation, award_mode)
      SELECT 'CS-W5G-BOGUS2', pr_id, rfq_id, 98, now(), ${lit(bogusUser)}::uuid,
             now(), ${lit(bogusUser)}::uuid, 'Locked', '{}'::jsonb,
             '{"reason":"x"}'::jsonb, 'SPLIT'
      FROM proc.comparative_statements WHERE id = ${lit(csId)}::uuid;`);
    if (bogus2.failed && /comparative_statements_split_consistency/i.test(bogus2.message)) {
      ok('and refuses a SPLIT with no split array in it', bogus2.message.split('\n')[0].slice(0, 90));
    } else {
      bad('and refuses a SPLIT with no split array in it', `psql failed for the wrong reason: ${bogus2.message.split('\n')[0].slice(0, 200)}`);
    }

    // ── 5. lock it as a split ─────────────────────────────────────────────
    const lockRes = await api(`/cs/${csId}/lock`, {
      method: 'POST', token: procurement,
      body: { reason: 'Split is cheaper and faster than a single winner on this package.' },
    });
    if (lockRes.status >= 400) { bad('the split locks', `status ${lockRes.status} ${lockRes.text.slice(0, 300)}`); return; }
    ok('the split locks');

    eq('the response names no single winner', lockRes.data?.winner === null ? 'null' : JSON.stringify(lockRes.data?.winner), 'null');
    eq('and reports the split', Array.isArray(lockRes.data?.split) ? String(lockRes.data.split.length) : 'missing', String(lineNos.length));

    const mode = psql(`SELECT award_mode FROM proc.comparative_statements WHERE id=${lit(csId)}::uuid;`).trim();
    eq('the row records award_mode', mode, 'SPLIT');

    const rec = psql(`SELECT coalesce(recommendation->>'winner_vendor_id','<absent>') || '|' || coalesce(recommendation->>'split','')::text
                         FROM proc.comparative_statements WHERE id=${lit(csId)}::uuid;`).trim();
    ok('the stored recommendation carries the split', rec.startsWith('<absent>|') ? 'winner_vendor_id is ABSENT, split present' : rec.slice(0, 120));
    if (!rec.startsWith('<absent>')) bad('winner_vendor_id is absent on a split', rec.slice(0, 120));

    const splitNo = psql(`SELECT string_agg((r->>'line_no') || ':' || (r->>'vendor_id'), ',' ORDER BY (r->>'line_no')::int)
                            FROM proc.comparative_statements c, LATERAL jsonb_array_elements(c.recommendation->'split') r
                           WHERE c.id=${lit(csId)}::uuid;`).trim();
    ok('each split line names its own winner', splitNo.slice(0, 90));

    // ── 6. the winning vendors are NOT marked Rejected ─────────────────────
    // This is the bug the old lock produced: one 'Awarded', everyone else
    // 'Rejected' — including a vendor who had just won a line.
    const states = psql(`SELECT q.vendor_id::text || '=' || q.state
                           FROM proc.quotations q
                          WHERE q.rfq_id=${lit(rfqId)}::uuid AND q.state IN ('Awarded','Rejected')
                          ORDER BY q.vendor_id, q.version;`).trim();
    const awardedA = states.split('\n').some(l => l.startsWith(`${vendorA}=Awarded`));
    const awardedB = states.split('\n').some(l => l.startsWith(`${vendorB}=Awarded`));
    if (awardedA) ok('vendor A\'s quote is Awarded', 'it won line 1'); else bad('vendor A\'s quote is Awarded', states);
    if (awardedB) ok('vendor B\'s quote is Awarded', 'it won line 2 — the old lock said Rejected'); else bad('vendor B\'s quote is Awarded', states);
    const wronglyRejected = states.split('\n').filter(l => (l.startsWith(`${vendorA}=`) || l.startsWith(`${vendorB}=`)) && l.endsWith('Rejected'));
    eq('no winning quote was marked Rejected', String(wronglyRejected.length), '0');

    // ── 7. the immutable audit trail ───────────────────────────────────────
    const splitAudit = psql(`SELECT count(*) FROM audit.audit_log
                              WHERE entity = 'proc.comparative_statements'
                                AND entity_id = ${lit(csId)}
                                AND action = 'cs_split_lock';`).trim();
    if (Number(splitAudit) > 0) ok('the split lock is in the audit trail', `${splitAudit} row(s)`);
    else bad('the split lock is in the audit trail', `cs_split_lock rows = ${splitAudit}`);

    // The per-line award is audited against its OWN entity
    // ('proc.cs_line_awards', entity_id = the award id), not against the CS —
    // matching what awardLine() actually writes. Asserting the wrong entity
    // would have reported 0 rows for a trail that is in fact complete.
    const lineAudits = psql(`SELECT count(*) FROM audit.audit_log
                              WHERE entity = 'proc.cs_line_awards'
                                AND action = 'cs_line_award'
                                AND after->>'cs_id' = ${lit(csId)};`).trim();
    if (Number(lineAudits) >= 2) ok('and each line award is auditable', `${lineAudits} row(s)`);
    else bad('and each line award is auditable', `cs_line_award rows = ${lineAudits}`);

    const chain = psql(`SELECT COALESCE(first_bad_id::text,'clean') FROM audit.fn_verify_audit_chain();`).trim();
    eq('and the hash chain is still clean', chain, 'clean');

    // ── 8. DOWNSTREAM: the readers that used to go blank ──────────────────
    const csView = await api(`/pr/${prId}/cs`, { token: procurement });
    if (csView.status === 200) {
      eq('the CS screen reports SPLIT', csView.data?.cs?.award_mode, 'SPLIT');
      const n = Array.isArray(csView.data?.cs?.split) ? csView.data.cs.split.length : 0;
      if (n > 0) ok('and carries the per-line split to the UI', `${n} line(s)`);
      else bad('and carries the per-line split to the UI', 'split was empty');
      eq('and exposes no single winner', csView.data?.cs?.winner === null ? 'null' : 'set', 'null');
    } else bad('the CS screen reads back', `status ${csView.status}`);

    // The D365 payload endpoint returns a WRAPPER: { pr, payload, header, lines,
    // ... }. Assert against that shape — reading top-level `vendor_code` off the
    // wrapper reports null for every case, pass or fail.
    const d365 = await api(`/pr/${prId}/d365/payload`, { token: procurement });
    if (d365.status === 200) {
      const d = d365.data || {};
      eq('the D365 payload knows it is a split', d.award_mode, 'SPLIT');
      eq('and flags the push as blocked', d.split_award, true);
      if (d.push_blocked_reason) ok('and explains why the push is refused', String(d.push_blocked_reason).slice(0, 80));
      else bad('and explains why the push is refused', 'no reason given');
      const nv = Array.isArray(d.vendors) ? d.vendors.length : 0;
      if (nv >= 2) ok('and names every receiving vendor', `${nv} vendor(s)`);
      else bad('and names every receiving vendor', `vendors = ${nv}`);
      if (d.payload?.TotalAmount !== null && d.payload?.TotalAmount !== undefined) {
        ok('the PO total is computed from the awarded lines', String(d.payload.TotalAmount));
      } else bad('the PO total is computed from the awarded lines', `TotalAmount = ${d.payload?.TotalAmount}`);
      // The push must actually refuse, not merely grey out.
      const pushed = await api(`/pr/${prId}/d365/push`, { method: 'POST', token: procurement, body: {} });
      if (pushed.status === 400 && /SPLIT/i.test(pushed.text)) ok('and the PUSH endpoint refuses it too');
      else bad('and the PUSH endpoint refuses it too', `status ${pushed.status} ${pushed.text.slice(0, 160)}`);
    } else bad('the D365 payload builds', `status ${d365.status} ${d365.text.slice(0, 160)}`);

    // vendor master: lifetime spend used to read 0 for every split winner.
    // Asserted through the real reader — `GET /vendors` — because that query is
    // inline in the service and a DB-level probe would not exercise the code
    // that actually ships.
    const vendorsView = await api(`/vendors`, { token: procurement });
    if (vendorsView.status === 200) {
      const all = vendorsView.data?.rows || [];
      for (const [v, who] of [[vendorA, 'vendor A'], [vendorB, 'vendor B']]) {
        const row = (Array.isArray(all) ? all : []).find((x) => x.id === v);
        if (!row) { bad(`${who} appears on the vendor master`, 'not in the GET /vendors rows'); continue; }
        if (Number(row.lifetimeSpend) > 0) ok(`${who} shows a non-zero lifetime spend from the split`, String(row.lifetimeSpend));
        else bad(`${who} shows a non-zero lifetime spend from the split`, `lifetimeSpend = ${row.lifetimeSpend} (the old winner_vendor_id-only join read 0)`);
        if (Number(row.posAwarded) > 0) ok(`${who} shows a PO awarded`, String(row.posAwarded));
        else bad(`${who} shows a PO awarded`, `posAwarded = ${row.posAwarded}`);
      }
    } else bad('the vendor master reads back', `status ${vendorsView.status}`);

    // RFQ screen: lockedWinner used to return null, so a decided package kept
    // showing its "select winner" state forever. The detail route is
    // `GET /rfq/:id` (RfqController) — there is no `GET /pr/:id/rfq`, so the
    // earlier call 404'd and this read as "the split is missing".
    const rfqView = await api(`/rfq/${rfqId}`, { token: procurement });
    if (rfqView.status !== 200) {
      bad('the RFQ detail reads back', `status ${rfqView.status} ${rfqView.text.slice(0, 160)}`);
    } else {
      const w = rfqView.data?.procurement?.rfq?.winner || rfqView.data?.winner || null;
      if (w && Array.isArray(w.split) && w.split.length > 0) {
        ok('the RFQ screen surfaces the split rather than showing "select winner"', `${w.split.length} line(s)`);
      } else {
        bad('the RFQ screen surfaces the split', `winner = ${JSON.stringify(w).slice(0, 160)}`);
      }
    }

    // ── 8b. the governance reads execute at all ───────────────────────────
    // riskClass() and lockedWinner() are the two split-aware readers that the
    // prove harness does not otherwise reach — they live behind the MC/CFO/pack
    // screens. A malformed predicate there is invisible until the eleventh e2e
    // script fails forty minutes later, so the exact SQL is run here against
    // this split and must simply not error.
    //
    // This exists because `jsonb_array_elements_text(...) ->> 'vendor_id'` was
    // shipped: the _text variant yields `text`, and `->>` on text is not an
    // operator. Every CFO read failed.
    const riskSql = psql(`
      SELECT count(*) FROM core.vendor_due_diligence dd
        JOIN proc.comparative_statements cs ON cs.pr_id = ${lit(prId)}::uuid
       WHERE cs.cs_round = proc.fn_latest_cs_round(${lit(prId)}::uuid)
         AND (
           cs.recommendation->>'winner_vendor_id' = dd.vendor_id::text
           OR dd.vendor_id::text IN (
                SELECT s.value ->> 'vendor_id'
                  FROM proc.comparative_statements c2,
                       LATERAL jsonb_array_elements(
                         CASE WHEN jsonb_typeof(c2.recommendation->'split') = 'array'
                              THEN c2.recommendation->'split' ELSE '[]'::jsonb END
                       ) AS s(value)
                 WHERE c2.pr_id = cs.pr_id AND c2.cs_round = cs.cs_round
                   AND s.value ->> 'vendor_id' IS NOT NULL)
         );`).trim();
    ok('the split-aware risk-class predicate executes', `${riskSql} vendor record(s) matched`);

    const winnersForD365 = psql(`
      SELECT count(*) FROM (
        SELECT c.recommendation->>'winner_vendor_id' AS vendor_id
          FROM proc.comparative_statements c
         WHERE c.pr_id = ${lit(prId)}::uuid AND c.state='Locked'
           AND c.recommendation->>'winner_vendor_id' IS NOT NULL
        UNION ALL
        SELECT s.value ->> 'vendor_id'
          FROM proc.comparative_statements c,
               LATERAL jsonb_array_elements(
                 CASE WHEN jsonb_typeof(c.recommendation->'split') = 'array'
                      THEN c.recommendation->'split' ELSE '[]'::jsonb END) AS s(value)
         WHERE c.pr_id = ${lit(prId)}::uuid AND c.state='Locked'
           AND s.value ->> 'vendor_id' IS NOT NULL) w;`).trim();
    eq('and the D365 winner query returns both split winners', winnersForD365, '2');

    // ── 9. the PDF names both winners ─────────────────────────────────────
    // The endpoint returns 201 with `object_key` (e.g. "2026\<uuid>.pdf"), not a
    // `path` field — assert on what the API actually returns.
    const pdf = await api(`/cs/${csId}/pdf`, { method: 'POST', token: procurement, body: {} });
    const objectKey = pdf.data?.object_key;
    if (pdf.status < 400 && objectKey) {
      pdfs.push(join(REPO, 'var', 'documents', String(objectKey).replace(/\\/g, '/')));
      const nameA = psql(`SELECT legal_name FROM core.vendors WHERE id=${lit(vendorA)}::uuid;`).trim();
      const nameB = psql(`SELECT legal_name FROM core.vendors WHERE id=${lit(vendorB)}::uuid;`).trim();
      const onDisk = existsSync(pdfs[pdfs.length - 1]) ? readFileSync(pdfs[pdfs.length - 1], 'utf8') : '';
      // The PDF writer escapes the PDF string delimiters, so a vendor called
      // "Acme Supplies (Pvt) Ltd" is stored as "Acme Supplies \(Pvt\) Ltd".
      // Searching for the RAW name therefore fails on a PDF that is perfectly
      // correct — the assertion has to look for what is actually in the file.
      const pdfEscaped = (s) => s.replace(/([\\()])/g, '\\$1');
      const inA = onDisk.includes(pdfEscaped(nameA));
      const inB = onDisk.includes(pdfEscaped(nameB));
      if (inA && inB) ok('the compiled PDF names BOTH winners', `${nameA} + ${nameB}`);
      else bad('the compiled PDF names BOTH winners', `A=${inA} B=${inB} (bytes=${onDisk.length})`);
    } else bad('the PDF compiles', `status ${pdf.status} ${pdf.text.slice(0, 160)}`);

    // ── 10. REGRESSION: a single-winner CS still behaves exactly as before ─
    const prId2 = psql(`
      INSERT INTO proc.purchase_requisitions
        (pr_number, title, description, requester_user_id, department_id, cost_center_id,
         expense_type, required_by_date, status, routing_key, warehouse_check_required,
         estimated_amount, capex_amount, opex_amount, currency, scope, attachments,
         version, urgency, workflow_snapshot)
      SELECT 'PR-W5G2-' || to_char(now(),'HH24MISS'), 'Harness single fixture', 'single-winner regression',
             p.requester_user_id, p.department_id, p.cost_center_id,
             p.expense_type, (current_date + 30), 'IN_PROCUREMENT_REVIEW', 'STANDARD', false,
             0, 0, 0, p.currency, p.scope, p.attachments, 1, p.urgency, p.workflow_snapshot
        FROM proc.purchase_requisitions p
       WHERE p.status = 'IN_PROCUREMENT_REVIEW'
       ORDER BY p.created_at DESC LIMIT 1
      RETURNING id;`).trim();
    const itemC = psql(`SELECT id FROM core.items WHERE active ORDER BY item_code OFFSET 2 LIMIT 1;`).trim();
    psql(`
      INSERT INTO proc.pr_lines (pr_id, line_no, item_id, quantity, uom, unit_price_est, gl_account, description, category)
      SELECT ${lit(prId2)}::uuid, 1, i.id, 4,
             COALESCE((SELECT code FROM core.uom WHERE code='EA'),(SELECT code FROM core.uom ORDER BY code LIMIT 1)),
             100, i.gl_account, 'W5G single line', i.category
        FROM core.items i WHERE i.id = ${lit(itemC)}::uuid;`);

    const rfq2 = (await api(`/pr/${prId2}/rfq`, { method: 'POST', token: procurement, body: { title: 'W5G single RFQ' } })).data?.rfq?.id;
    if (uuidish(rfq2)) {
      await api(`/rfq/${rfq2}/invite`, { method: 'POST', token: procurement, body: { vendorId: vendorA } });
      await api(`/rfq/${rfq2}/invite`, { method: 'POST', token: procurement, body: { vendorId: vendorB } });
      const l2 = Number(psql(`SELECT line_no FROM proc.rfq_lines WHERE rfq_id=${lit(rfq2)}::uuid ORDER BY line_no LIMIT 1;`).trim());
      await api(`/rfq/${rfq2}/quotations`, { method: 'POST', token: procurement, body: { vendorId: vendorA, leadTimeDays: 7, lines: [{ rfqLineNo: l2, unitPrice: 111 }] } });
      await api(`/rfq/${rfq2}/quotations`, { method: 'POST', token: procurement, body: { vendorId: vendorB, leadTimeDays: 9, lines: [{ rfqLineNo: l2, unitPrice: 222 }] } });
      const cs2 = (await api(`/pr/${prId2}/cs`, { method: 'POST', token: procurement, body: {} })).data?.cs?.id;
      if (uuidish(cs2)) {
        const single = await api(`/cs/${cs2}/lock`, { method: 'POST', token: procurement, body: { winnerVendorId: vendorA, reason: 'single winner regression' } });
        if (single.status < 400) {
          eq('a SINGLE-winner lock still records SINGLE', psql(`SELECT award_mode FROM proc.comparative_statements WHERE id=${lit(cs2)}::uuid;`).trim(), 'SINGLE');
          if (single.data?.winner?.vendor_id === vendorA) ok('and still names its winner', 'vendor A');
          else bad('and still names its winner', JSON.stringify(single.data?.winner));

          // REGRESSION GUARD. Adding split support rewrote the D365 winner query,
          // and the rewrite dropped the join back to the awarded QUOTATION. That
          // made `awarded` null for every ordinary CS, so TotalAmount silently
          // fell through to the PR ESTIMATE and the push would have sent a
          // budget request to F&O as a commitment. The e2e caught it; this makes
          // the fast harness catch it too.
          const singleAwarded = psql(`SELECT recommendation->>'winner_total' FROM proc.comparative_statements WHERE id=${lit(cs2)}::uuid;`).trim();
          const d365single = await api(`/pr/${prId2}/d365/payload`, { token: procurement });
          const total = d365single?.data?.payload?.TotalAmount;
          if (singleAwarded && total !== null && total !== undefined && Math.abs(Number(total) - Number(singleAwarded)) < 0.01) {
            ok('a SINGLE-winner PO total is still the AWARDED quotation', `${total} = winner_total`);
          } else {
            bad('a SINGLE-winner PO total is still the AWARDED quotation',
              `TotalAmount=${total} winner_total=${singleAwarded} (a mismatch means the PR estimate would be pushed)`);
          }
          if (d365single?.data?.award_mode === 'SINGLE') ok('and the D365 payload still reports SINGLE');
          else bad('and the D365 payload still reports SINGLE', `award_mode=${d365single?.data?.award_mode}`);
        } else bad('a SINGLE-winner lock still works', `status ${single.status} ${single.text.slice(0, 200)}`);
      }
    }
    ok('the single-winner path is untouched by the split support');

  } catch (e) {
    bad('the harness ran to completion', `${e && e.message ? e.message : e}`.slice(0, 400));
  } finally {
    // ── cleanup ───────────────────────────────────────────────────────────
    console.log('\n── cleanup ─────────────────────────────────────────────');
    // Each cleanup statement runs independently. One blocked DELETE (a frozen
    // approved_pack refuses even a cascade) used to abort the whole block and
    // leave every later statement — including the PR delete — unrun, so the
    // fixture leaked AND the leak was only visible as a single confusing error.
    // A failure here is recorded and the block continues.
    const step = (label, sql) => {
      try { psql(sql); }
      catch (e) {
        bad(`cleanup step: ${label}`, `${e && e.message ? e.message : e}`.split('\n')[0].slice(0, 180));
      }
    };

    try {
      // Restore any CS this run locked, then take the whole fixture out. Audit
      // rows are NOT deleted: `audit.audit_log` is append-only under Rule 5 and
      // the chain is verified below instead of being rewound.
      step('reset a locked CS', `UPDATE proc.comparative_statements cs
           SET state='Generated', locked_at=NULL, locked_by_user_id=NULL,
               recommendation=NULL, override_reason=NULL, award_mode='SINGLE'
          FROM proc.purchase_requisitions p
         WHERE p.id = cs.pr_id AND p.pr_number LIKE 'PR-W5G%';`);
      step('line awards', `
        DELETE FROM proc.cs_line_awards
         WHERE cs_id IN (SELECT cs.id FROM proc.comparative_statements cs
                          JOIN proc.purchase_requisitions p ON p.id = cs.pr_id
                         WHERE p.pr_number LIKE 'PR-W5G%');`);
      step('negotiation log', `
        DELETE FROM proc.negotiation_log
         WHERE rfq_id IN (SELECT r.id FROM proc.rfq r
                           JOIN proc.purchase_requisitions p ON p.id = r.pr_id
                          WHERE p.pr_number LIKE 'PR-W5G%');`);
      step('quotation lines', `
        DELETE FROM proc.quotation_lines
         WHERE quotation_id IN (SELECT q.id FROM proc.quotations q
                                 JOIN proc.rfq r ON r.id = q.rfq_id
                                 JOIN proc.purchase_requisitions p ON p.id = r.pr_id
                                WHERE p.pr_number LIKE 'PR-W5G%');`);
      step('quotations', `
        DELETE FROM proc.quotations
         WHERE rfq_id IN (SELECT r.id FROM proc.rfq r
                           JOIN proc.purchase_requisitions p ON p.id = r.pr_id
                          WHERE p.pr_number LIKE 'PR-W5G%');`);
      step('invitations', `
        DELETE FROM proc.rfq_invitations
         WHERE rfq_id IN (SELECT r.id FROM proc.rfq r
                           JOIN proc.purchase_requisitions p ON p.id = r.pr_id
                          WHERE p.pr_number LIKE 'PR-W5G%');`);
      step('rfq', `
        DELETE FROM proc.rfq
         WHERE pr_id IN (SELECT id FROM proc.purchase_requisitions WHERE pr_number LIKE 'PR-W5G%');`);
      step('pr lines', `
        DELETE FROM proc.pr_lines
         WHERE pr_id IN (SELECT id FROM proc.purchase_requisitions WHERE pr_number LIKE 'PR-W5G%');`);
      step('comparative statements', `
        DELETE FROM proc.comparative_statements
         WHERE pr_id IN (SELECT id FROM proc.purchase_requisitions WHERE pr_number LIKE 'PR-W5G%');`);
      step('purchase requisitions', `DELETE FROM proc.purchase_requisitions WHERE pr_number LIKE 'PR-W5G%';`);

      const leftover = psql(`SELECT (SELECT count(*) FROM proc.purchase_requisitions WHERE pr_number LIKE 'PR-W5G%')::text || '|' || (SELECT count(*) FROM proc.rfq r JOIN proc.purchase_requisitions p ON p.id=r.pr_id WHERE p.pr_number LIKE 'PR-W5G%')::text;`).trim();
      eq('no harness PR survives', leftover.split('|')[0], '0');
      eq('no harness RFQ survives', leftover.split('|')[1], '0');
      const orphans = psql(`SELECT (SELECT count(*) FROM proc.cs_line_awards WHERE cs_id NOT IN (SELECT id FROM proc.comparative_statements))::text
                             || '|' || (SELECT count(*) FROM proc.comparative_statements WHERE rfq_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM proc.rfq r WHERE r.id = comparative_statements.rfq_id))::text;`).trim();
      eq('no orphaned line awards', orphans.split('|')[0], '0');
      eq('no CS points at a missing RFQ', orphans.split('|')[1], '0');
      for (const f of pdfs) if (existsSync(f)) unlinkSync(f);
      if (pdfs.length) ok('the compiled PDFs are removed', String(pdfs.length));
    } catch (e) {
      bad('cleanup completed', `${e && e.message ? e.message : e}`.slice(0, 300));
    }

    const audits = psql(`SELECT count(*) FROM audit.audit_log WHERE ts > now() - interval '30 minutes';`).trim();
    ok('audit entries this run added are permanent, by design', `${audits} row(s)`);
    const chain = psql(`SELECT COALESCE(first_bad_id::text,'clean') FROM audit.fn_verify_audit_chain();`).trim();
    eq('and the hash chain is still clean', chain, 'clean');

    // The summary lives INSIDE the finally block, not after it. Several fixture
    // steps bail out with a bare `return` from inside the try, and a `return`
    // exits the whole function — so anything written after the try/finally never
    // runs. That produced a red FAIL on screen with an exit code of 0, the worst
    // combination: visible to a human, invisible to any chained runner.
    console.log(`\n${fail} failed, ${pass} passed, ${findings} finding(s)\n`);
    if (fail > 0) process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
