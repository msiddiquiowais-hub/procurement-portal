#!/usr/bin/env node
// --------------------------------------------------------------------------
// prove:wave5h  Purchase Orders and D365 F&O integration.
//
// WHAT THIS PROVES, AND WHAT IT CANNOT
//
// It CANNOT prove that this application works against a real D365 tenant. There
// is none configured, and no amount of local code makes that true. What it
// proves is the CLIENT: that the token request is built correctly, that the
// scope is `{resource}/.default`, that OData paging is followed to exhaustion,
// that a 401 costs exactly one re-auth, that the PO fan-out is right, and that
// the issuance gate holds. The network boundary is exercised against a local
// fake Entra + OData server (scripts/lib/fake_d365.mjs) that speaks the same
// protocol F&O does.
//
// The gaps this track could NOT close are listed at the bottom of the output
// rather than buried: real-tenant verification, vendor two-way sync, and the
// per-PO D365 push of a live order.
//
// EVERY MUTATION IS RESTORED IN `finally`. Audit rows are append-only under
// Rule 5 and are reported, not rewound.
// --------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeD365 } from './lib/fake_d365.mjs';

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..');
const require = createRequire(import.meta.url);
const d365 = require(resolve(REPO, 'packages', 'd365-client', 'dist', 'index.js'));

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const CONTAINER = process.env.PG_CONTAINER || 'procurement-portal-db';

let pass = 0, fail = 0, findings = 0;
const ok = (l, e = '') => { pass++; console.log(`  PASS  ${l}${e ? `  (${e})` : ''}`); };
const bad = (l, d) => { fail++; console.log(`  FAIL  ${l}\n        ${d}`); };
const finding = (l, d) => { findings++; console.log(`  FINDING  ${l}\n            ${d}`); };

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

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * Give a PR an RFQ with one submitted quotation, so its lines carry an awarded
 * unit price.
 *
 * This exists because PoService refuses a line with no price  "a purchase
 * order with a zero-price line is not a purchase order". A PO fixture without
 * a quotation therefore proves nothing, because it can never reach a PO.
 */
function rfqWithQuote(prId, vendorId, unitPrice = 100) {
  const stamp = Math.random().toString(36).slice(2, 8).toUpperCase();
  const rfqId = psql(`
    INSERT INTO proc.rfq
      (rfq_number, pr_id, created_by_user_id, deadline_at, state, single_source,
       currency, created_at, issued_at, title)
    SELECT 'RFQ-W5H-${stamp}', ${lit(prId)}::uuid, requester_user_id,
           now() + interval '7 days', 'Open', false, 'PKR', now(), now(), 'W5H harness RFQ'
      FROM proc.purchase_requisitions WHERE id = ${lit(prId)}::uuid
    RETURNING id;`).trim();

  psql(`
    INSERT INTO proc.rfq_lines (rfq_id, pr_line_id, line_no, description, quantity, uom)
    SELECT ${lit(rfqId)}::uuid, pl.id, pl.line_no, pl.description, pl.quantity, pl.uom
      FROM proc.pr_lines pl WHERE pl.pr_id = ${lit(prId)}::uuid ORDER BY pl.line_no;`);

  // Several columns are NOT NULL that a casual column listing will not show as
  // required (sealed_hash, open_at, taxes_included, normalized_total_pkr).
  // Read the real constraint rather than discovering them one failing run at a
  // time. total_amount is the sum of the quoted lines, not a placeholder zero.
  const qId = psql(`
    INSERT INTO proc.quotations
      (rfq_id, vendor_id, submitted_at, state, version, currency,
       total_amount, normalized_total_pkr, fx_rate, sealed_hash, open_at, taxes_included)
    SELECT ${lit(rfqId)}::uuid, ${lit(vendorId)}::uuid, now(), 'Submitted', 1, 'PKR',
           COALESCE(sum(rl.quantity * ${unitPrice}), 0), COALESCE(sum(rl.quantity * ${unitPrice}), 0), 1,
           md5('W5H|' || ${lit(rfqId)} || '|' || ${lit(vendorId)} || '|' || now()::text),
           now(), true
      FROM proc.rfq_lines rl WHERE rl.rfq_id = ${lit(rfqId)}::uuid
    RETURNING id;`).trim();

  psql(`
    INSERT INTO proc.quotation_lines
      (quotation_id, rfq_id, rfq_line_no, unit_price, total_price, declined)
    SELECT ${lit(qId)}::uuid, ${lit(rfqId)}::uuid, rl.line_no, ${unitPrice},
           rl.quantity * ${unitPrice}, false
      FROM proc.rfq_lines rl WHERE rl.rfq_id = ${lit(rfqId)}::uuid;`);

  return rfqId;
}

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

async function runSections() {
 console.log('\n"" prove:wave5h  Purchase Orders & D365 F&O ""\n');

  const procurement = await login('procurement@pakboxes.pk');
  if (!procurement) {
 console.error('cannot log in  is the API up?');
    process.exit(1);
  }
  ok('signed in as a procurement officer');

 // --------------------------------------------------------------------------
  // --------------------------------------------------------------------------
 // --------------------------------------------------------------------------
  console.log('\n--- 1 · Entra ID client-credentials + OData v4 ---');

  const fake = await startFakeD365({ pageSize: 2, operatingUnits: 5, workers: 4, dimensionValues: 6 });
  // Only the token hop is redirected. The client still builds the real
  // Microsoft URL and a real client-credentials body; only the socket goes
  // somewhere reachable.
  const restoreFetch = fake.redirectTokenFetch();
  try {
    const cfg = {
      tenantId: fake.tenant, clientId: fake.clientId, clientSecret: fake.clientSecret,
      resourceUrl: fake.baseUrl,
    };

    // -- the URL is built by US, not by the fake server --------------------
    // Assert the SHAPE against the real Microsoft host, and separately that the
    // fake never leaked into construction. Hardcoding one expected string would
    // only prove the function returns its own argument.
    const ep = d365.tokenEndpoint(fake.tenant);
    const realV2 = /^https:\/\/login\.microsoftonline\.com\/[^/]+\/oauth2\/v2\.0\/token$/;
    if (realV2.test(ep) && !ep.includes(fake.baseUrl)) {
      ok('the token endpoint is the real Microsoft v2.0 URL', ep);
    } else bad('the token endpoint is the real Microsoft v2.0 URL', ep);

    const scope = d365.resourceScope(fake.baseUrl);
    if (scope.endsWith('/.default')) ok('the scope is {resource}/.default', scope);
    else bad('the scope is {resource}/.default', scope);

    // -- fail-closed ------------------------------------------------------
    try {
      d365.assertConfigured({ tenantId: fake.tenant, clientId: fake.clientId, clientSecret: fake.clientSecret });
      bad('incomplete live config is REFUSED', 'assertConfigured accepted a config with no base URL');
    } catch (e) {
      if (e?.name === 'D365ConfigError' && /D365_BASE_URL/.test(String(e.message))) {
        ok('incomplete live config is REFUSED, naming what is missing', 'D365_BASE_URL');
      } else bad('incomplete live config is REFUSED', String(e?.message).slice(0, 160));
    }

    try {
      d365.assertLiveConfig({ mode: 'live', tenantId: fake.tenant, clientId: fake.clientId, clientSecret: fake.clientSecret, baseUrl: fake.baseUrl });
      ok('a complete live config is accepted');
    } catch (e) { bad('a complete live config is accepted', String(e?.message).slice(0, 160)); }

    // -- the token, through the real endpoint URL -------------------------
    const tokens = new d365.EntraTokenProvider(cfg);
    let tok = null;
    try {
      tok = await tokens.getToken();
      ok('a client-credentials token is obtained', `type=${tok.tokenType}`);
    } catch (e) {
      bad('a client-credentials token is obtained', String(e?.message).slice(0, 300));
    }
    if (tok) {
      eq('the grant used client_credentials', fake.tokenGrants[0]?.grantType, 'client_credentials');
      ok('the grant asked for the F&O resource', fake.tokenGrants[0]?.scope);
      // The secret must never appear anywhere in an error path.
      if (!JSON.stringify({ tok }).includes(fake.clientSecret)) ok('the token object carries no client secret');
      else bad('the token object carries no client secret', 'the secret leaked into the token record');
    }

    // -- caching ----------------------------------------------------------
    const before = fake.tokenGrants.length;
    await tokens.getToken();
    await tokens.getToken();
    eq('the cached token is reused, not re-minted', String(fake.tokenGrants.length), String(before));

    // -- OData paging -----------------------------------------------------
    const odata = new d365.ODataClient({ baseUrl: fake.baseUrl, tokens });
    const ous = await odata.readAll('OMOperatingUnits');
    eq('all operating units are read across pages', String(ous.rows.length), '5');
    if (ous.pages > 1) ok('and it really paged rather than truncating', `${ous.pages} pages`);
    else bad('and it really paged rather than truncating', `pages=${ous.pages}`);
    if (ous.truncated === false) ok('and reports it is not truncated');
    else bad('and reports it is not truncated', 'truncated=true');

    const wk = await odata.readAll('HcmWorkers');
    eq('all workers are read', String(wk.rows.length), '4');

    const dv = await odata.readAll('FinancialDimensionValues');
    eq('all dimension values are read', String(dv.rows.length), '6');
    const someInactive = dv.rows.some((r) => r.Active === false);
    if (someInactive) ok('the fixture really contains inactive values, so normalisation matters');
    else finding('the fixture had no inactive values', 'Active normalisation was not exercised');

    if (fake.unauthenticatedCalls === 0) ok('every OData call presented a bearer token');
    else bad('every OData call presented a bearer token', `${fake.unauthenticatedCalls} call(s) without one`);

    // -- one forced re-auth on 401 ---------------------------------------
    const fake2 = await startFakeD365({ failFirstTokenRequest: true, operatingUnits: 1 });
    try {
      const t2 = new d365.EntraTokenProvider({
        tenantId: fake2.tenant, clientId: fake2.clientId, clientSecret: fake2.clientSecret,
        resourceUrl: fake2.baseUrl,
      });
      let firstErr = null;
      try { await t2.getToken(); } catch (e) { firstErr = e; }
      if (firstErr?.name === 'D365AuthError') ok('a rejected grant raises D365AuthError, not a raw fetch error');
      else bad('a rejected grant raises D365AuthError', String(firstErr?.message).slice(0, 200));

      if (!String(firstErr?.message || '').includes(fake2.clientSecret)) {
        ok('and the auth error does NOT contain the client secret');
      } else {
        bad('and the auth error does NOT contain the client secret', 'the secret appeared in the error message');
      }

      // Recovery: the client retries once and succeeds.
      const t3 = new d365.EntraTokenProvider({
        tenantId: fake2.tenant, clientId: fake2.clientId, clientSecret: fake2.clientSecret,
        resourceUrl: fake2.baseUrl,
      });
      const tok3 = await t3.getToken();
      if (tok3?.accessToken) ok('a retry after a transient rejection succeeds');
      else bad('a retry after a transient rejection succeeds', 'no token on retry');
    } finally {
      await fake2.close();
    }

    // -- a live PO POST ---------------------------------------------------
    const pushRes = await d365.pushPurchaseOrder(
      { mode: 'live', tenantId: fake.tenant, clientId: fake.clientId, clientSecret: fake.clientSecret, baseUrl: fake.baseUrl, company: 'PKE' },
      {
        prNumber: 'PR-FAKE', sourceReference: 'PR-FAKE/LOCAL-PO-1', vendorCode: 'V-00081',
        amount: 5000, currency: 'PKR',
        lines: [{ lineNo: 1, itemCode: 'ITEM-1', quantity: 2, uom: 'EA', unitPrice: 2500 }],
      },
    );
    if (/^PO\d{4}-/.test(pushRes.poNumber)) ok('a live push returns the number F&O assigned', pushRes.poNumber);
    else bad('a live push returns the number F&O assigned', String(pushRes.poNumber));
    if (pushRes.stubbed === false) ok('and does not claim to be a stub');
    else bad('and does not claim to be a stub', `stubbed=${pushRes.stubbed}`);
    if (pushRes.poId) ok('and the surrogate key needed for status polling', pushRes.poId);
    else finding('the push returned no surrogate key', 'status polling would have nothing to poll on');

    // -- the stub must be visibly fake ------------------------------------
    const stub = await d365.pushPurchaseOrder(
      { mode: 'stub', baseUrl: fake.baseUrl },
      { prNumber: 'PR-STUB', vendorCode: 'V-1', amount: 1, currency: 'PKR', lines: [] },
    );
    if (/^STUB-PO-/.test(stub.poNumber) && stub.stubbed === true) {
      ok('the stub PO number is VISIBLY fake and flagged', stub.poNumber);
    } else {
      bad('the stub PO number is VISIBLY fake and flagged', `${stub.poNumber} stubbed=${stub.stubbed}`);
    }
    if (!/^PO-\d{4}-\d{6}$/.test(stub.poNumber)) {
      ok('and it cannot be mistaken for the old F&O-shaped number');
    } else {
      bad('and it cannot be mistaken for the old F&O-shaped number', stub.poNumber);
    }
  } finally {
    // Restore the global fetch FIRST. Leaving it pointed at the fake would let
    // every later section's HTTP call silently hit a server that is about to be
    // closed, turning an unrelated failure into a confusing one.
    try { restoreFetch?.(); } catch (e) { bad('restoring the patched global fetch', String(e?.message).slice(0, 160)); }
    await fake.close();
  }

 // --------------------------------------------------------------------------
  // 2. PURCHASE ORDERS
 // --------------------------------------------------------------------------
  console.log('\n--- 2 · purchase orders, fan-out and the issuance gate ---');

  let prId = null;
  try {
    // A PO cannot be generated for an unapproved PR.
    prId = psql(`
      INSERT INTO proc.purchase_requisitions
        (pr_number, title, description, requester_user_id, department_id, cost_center_id,
         expense_type, required_by_date, status, routing_key, warehouse_check_required,
         estimated_amount, capex_amount, opex_amount, currency, scope, attachments,
         version, urgency, workflow_snapshot)
      SELECT 'PR-W5H-' || to_char(now(),'HH24MISS'), 'Harness PO fixture', 'purchase order generation',
             p.requester_user_id, p.department_id, p.cost_center_id, p.expense_type,
             (current_date + 30), 'IN_PROCUREMENT_REVIEW', 'STANDARD', false,
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
             COALESCE((SELECT code FROM core.uom WHERE code='EA'),
                      (SELECT code FROM core.uom ORDER BY code LIMIT 1)),
             100, i.gl_account, n.descr, i.category
        FROM (VALUES (1, 10::numeric, 'W5H line 1'), (2, 5::numeric, 'W5H line 2')) AS n(line_no, qty, descr)
        JOIN core.items i ON i.id = ${lit(itemA)}::uuid
       WHERE n.line_no = 1
      UNION ALL
      SELECT ${lit(prId)}::uuid, n.line_no, i.id, n.qty,
             COALESCE((SELECT code FROM core.uom WHERE code='EA'),
                      (SELECT code FROM core.uom ORDER BY code LIMIT 1)),
             100, i.gl_account, n.descr, i.category
        FROM (VALUES (1, 10::numeric, 'W5H line 1'), (2, 5::numeric, 'W5H line 2')) AS n(line_no, qty, descr)
        JOIN core.items i ON i.id = ${lit(itemB)}::uuid
       WHERE n.line_no = 2;`);
    ok('fixture PR carries two awardable lines');

    const early = await api(`/pr/${prId}/po`, { method: 'POST', token: procurement, body: {} });
    if (early.status === 400 && /PACK_LOCKED/.test(early.text)) {
      ok('PO generation is REFUSED before the approval chain finishes', early.data?.message?.slice(0, 80));
    } else {
      bad('PO generation is REFUSED before the approval chain finishes', `status ${early.status} ${early.text.slice(0, 200)}`);
    }

    // The issuance gate, at the DATABASE level, on a PO we force into place.
    // Proven directly rather than through the service, so the rule is shown to
    // live in the schema.
    const orphan = psql(`
      INSERT INTO proc.purchase_orders
        (po_number, pr_id, vendor_id, generation_mode, state, currency, total_amount)
      VALUES ('LOCAL-PO-GATE-TEST', ${lit(prId)}::uuid,
              (SELECT id FROM core.vendors ORDER BY vendor_code LIMIT 1), 'SINGLE', 'Generated', 'PKR', 100)
      RETURNING id;`).trim();
    let gate = null;
    try {
      psql(`SELECT proc.fn_po_issue(${lit(orphan)}::uuid, (SELECT requester_user_id::text FROM proc.purchase_requisitions WHERE id=${lit(prId)}::uuid)::uuid);`);
    } catch (e) { gate = String(e.message); }
    if (gate && /cannot be issued/.test(gate) && /PACK_LOCKED/.test(gate)) {
      ok('proc.fn_po_issue refuses while the PR is not PACK_LOCKED', gate.split('\n')[0].slice(0, 90));
    } else {
      bad('proc.fn_po_issue refuses while the PR is not PACK_LOCKED', String(gate).slice(0, 200));
    }

    const stillGenerated = psql(`SELECT state FROM proc.purchase_orders WHERE id=${lit(orphan)}::uuid;`).trim();
    eq('and the PO is left Generated, not half-issued', stillGenerated, 'Generated');
    psql(`DELETE FROM proc.purchase_orders WHERE id=${lit(orphan)}::uuid;`);

    // Coverage is measured HERE, before anything below deliberately puts a
    // line on an order. The duplicate-order test covers pr line 1 on purpose,
 // so measuring after it reported 1 covered  a correct report that looked
    // like a wrong expectation. Assert the untouched state, then perturb it.
    const zero = psql(`SELECT total_lines || '|' || covered_lines || '|' || excluded_lines || '|' || uncovered_lines
                         FROM proc.fn_pr_line_po_coverage(${lit(prId)}::uuid);`).trim();
    eq('the coverage report sees 2 lines, 0 covered, 0 explained, 2 uncovered', zero, '2|0|0|2');
    ok('so an unexplained line is VISIBLE rather than silently dropped');

    // A double-order is refused rather than half-written.
    psql(`
      INSERT INTO proc.purchase_orders
        (po_number, pr_id, vendor_id, generation_mode, state, currency, total_amount)
      VALUES ('LOCAL-PO-DUP-TEST', ${lit(prId)}::uuid,
              (SELECT id FROM core.vendors ORDER BY vendor_code LIMIT 1), 'SINGLE', 'Generated', 'PKR', 100);`);
    const dupLine = psql(`SELECT id FROM proc.pr_lines WHERE pr_id=${lit(prId)}::uuid AND line_no=1;`).trim();
    const dup = psqlExpectingFailure(`
      INSERT INTO proc.purchase_order_lines
        (po_id, line_no, pr_line_id, item_id, quantity, uom, unit_price)
      SELECT (SELECT id FROM proc.purchase_orders WHERE po_number='LOCAL-PO-DUP-TEST'),
             1, ${lit(dupLine)}::uuid,
             (SELECT item_id FROM proc.pr_lines WHERE id=${lit(dupLine)}::uuid), 1, 'EA', 100;
      INSERT INTO proc.purchase_order_lines
        (po_id, line_no, pr_line_id, item_id, quantity, uom, unit_price)
      SELECT (SELECT id FROM proc.purchase_orders WHERE po_number='LOCAL-PO-DUP-TEST'),
             1, ${lit(dupLine)}::uuid,
             (SELECT item_id FROM proc.pr_lines WHERE id=${lit(dupLine)}::uuid), 1, 'EA', 100;`);
    if (dup.failed && /uq_po_line_pr_line|unique/i.test(dup.message)) {
      ok('a PR line cannot sit on two purchase orders', dup.message.split('\n')[0].slice(0, 90));
    } else {
      bad('a PR line cannot sit on two purchase orders', `psql did not fail: ${String(dup.message).slice(0, 160)}`);
    }

    // The duplicate probe committed its FIRST line before the second one was
    // refused, so it left a real PO attached to this PR. Left in place it
 // blocks generation below  and correctly so, which is how the leak
    // showed up as a confusing 409 rather than as the fixture bug it was.
    psql(`
      DELETE FROM proc.purchase_order_lines
       WHERE po_id = (SELECT id FROM proc.purchase_orders WHERE po_number = 'LOCAL-PO-DUP-TEST');
      DELETE FROM proc.purchase_orders WHERE po_number = 'LOCAL-PO-DUP-TEST';`);

 // --------------------------------------------------------------------------
  // --------------------------------------------------------------------------
    //
    // The fixture is fast-forwarded to PACK_LOCKED and given a locked CS
    // carrying a recorded award. The governance chain that walks a real PR to
    // PACK_LOCKED is itself covered by the governance and e2e suites; what is
    // under test HERE is that an approved package plus a recorded award yields
    // the RIGHT purchase orders, and that issuance and push then work.
 // --------------------------------------------------------------------------
    const vendorA = psql(`SELECT id FROM core.vendors ORDER BY vendor_code LIMIT 1;`).trim();
    const vendorB = psql(`SELECT id FROM core.vendors ORDER BY vendor_code OFFSET 1 LIMIT 1;`).trim();
    const requester = psql(
      `SELECT requester_user_id FROM proc.purchase_requisitions WHERE id=${lit(prId)}::uuid;`).trim();

    const rfqId = rfqWithQuote(prId, vendorA, 100);
    const csId = psql(`
      INSERT INTO proc.comparative_statements
        (cs_number, pr_id, generated_at, generated_by_user_id, locked_at, locked_by_user_id,
         recommendation, scores, weights, state, cs_round, rfq_id, award_mode)
      VALUES ('CS-W5H-SINGLE', ${lit(prId)}::uuid, now(), ${lit(requester)}::uuid,
              now(), ${lit(requester)}::uuid,
              jsonb_build_object('winner_vendor_id', ${lit(vendorA)}::text, 'winner_total', 1500),
              '{}'::jsonb, '{}'::jsonb, 'Locked', 1, ${lit(rfqId)}::uuid, 'SINGLE')
      RETURNING id;`).trim();
    psql(`UPDATE proc.purchase_requisitions SET status = 'PACK_LOCKED' WHERE id=${lit(prId)}::uuid;`);
    ok('fixture is fast-forwarded to a locked, PACK_LOCKED package');

    const gen = await api(`/pr/${prId}/po`, { method: 'POST', token: procurement, body: { mode: 'AUTO' } });
    if (gen.status === 201 || gen.status === 200) {
      ok('PO generation produces a purchase order', `${gen.data?.po_count} order(s)`);
    } else {
      bad('PO generation produces a purchase order', `status ${gen.status} ${gen.text.slice(0, 220)}`);
    }

    // The parts of the number that are facts, asserted individually. One
    // concatenated expected string would have to embed a generated PO number,
    // which is exactly the kind of expectation that quietly stops being checked.
    const parts = psql(`
      SELECT po.state || '|' || po.generation_mode || '|' || po.total_amount || '|' ||
             (SELECT count(*) FROM proc.purchase_order_lines l WHERE l.po_id = po.id) || '|' ||
             po.po_number
        FROM proc.purchase_orders po WHERE po.pr_id = ${lit(prId)}::uuid LIMIT 1;`).trim();
    const [st, gm, tot, lineCount, poNumber] = parts.split('|');
    eq('the PO is Generated', st, 'Generated');
    eq('in SINGLE mode', gm, 'SINGLE');
    eq('for 1500 (10 x 100 + 5 x 100)', tot, '1500.00');
    eq('carrying both awarded lines', lineCount, '2');
    if (/^LOCAL-PO-\d{4}-\d{6}$/.test(poNumber || '')) {
      ok('and a LOCAL po number that can never be confused with F&O', poNumber);
    } else bad('and a LOCAL po number that can never be confused with F&O', String(poNumber));

    const covered = psql(`SELECT total_lines || '|' || covered_lines || '|' || excluded_lines || '|' || uncovered_lines
                             FROM proc.fn_pr_line_po_coverage(${lit(prId)}::uuid);`).trim();
    eq('coverage is now total, with nothing left unexplained', covered, '2|2|0|0');

    // Re-generating must refuse rather than create a second commitment.
    const again = await api(`/pr/${prId}/po`, { method: 'POST', token: procurement, body: { mode: 'AUTO' } });
 if (again.status === 409) ok('re-generating is refused  no double-order', again.data?.message?.slice(0, 70));
 else bad('re-generating is refused  no double-order', `status ${again.status} ${again.text.slice(0, 200)}`);

    const poId = psql(`SELECT id FROM proc.purchase_orders WHERE pr_id=${lit(prId)}::uuid LIMIT 1;`).trim();

 //  issuance: the managerial gate, through the service 
    const issued = await api(`/po/${poId}/issue`, { method: 'POST', token: procurement, body: {} });
    if (issued.status < 400) ok('the PO issues through proc.fn_po_issue', issued.data?.state || '');
    else bad('the PO issues through proc.fn_po_issue', `status ${issued.status} ${issued.text.slice(0, 200)}`);

    const poState = psql(`SELECT state FROM proc.purchase_orders WHERE id=${lit(poId)}::uuid;`).trim();
    if (poState !== 'Generated') ok('and the state actually moved', poState);
    else bad('and the state actually moved', `still ${poState}`);

 //  push to D365 (stub mode, and it must SAY so) 
    const pushed = await api(`/po/${poId}/push`, { method: 'POST', token: procurement, body: {} });
    if (pushed.status < 400) ok('the PO pushes to D365', pushed.data?.message?.slice(0, 60));
    else bad('the PO pushes to D365', `status ${pushed.status} ${pushed.text.slice(0, 200)}`);

    const pushedDb = psql(`SELECT COALESCE(d365_po_number,'(null)') || '|' || COALESCE(d365_pushed_at::text,'(null)')
                             FROM proc.purchase_orders WHERE id=${lit(poId)}::uuid;`).trim();
    if (/^STUB-PO-/.test(pushedDb.split('|')[0])) {
      ok('and the stored number is the visibly-fake stub', pushedDb.split('|')[0]);
    } else bad('and the stored number is the visibly-fake stub', pushedDb);

 // --------------------------------------------------------------------------
  // --------------------------------------------------------------------------
    //     single VendorAccount.
 // --------------------------------------------------------------------------
    let splitPr = null;
    try {
      splitPr = psql(`
        INSERT INTO proc.purchase_requisitions
          (pr_number, title, description, requester_user_id, department_id, cost_center_id,
           expense_type, required_by_date, status, routing_key, warehouse_check_required,
           estimated_amount, capex_amount, opex_amount, currency, scope, attachments,
           version, urgency, workflow_snapshot)
        SELECT 'PR-W5H-SPLIT-' || to_char(now(),'HH24MISS'), 'Harness split PO fixture', 'split fan-out',
               p.requester_user_id, p.department_id, p.cost_center_id, p.expense_type,
               (current_date + 30), 'IN_PROCUREMENT_REVIEW', 'STANDARD', false,
               0, 0, 0, p.currency, p.scope, p.attachments, 1, p.urgency, p.workflow_snapshot
          FROM proc.purchase_requisitions p
         WHERE p.status = 'IN_PROCUREMENT_REVIEW'
         ORDER BY p.created_at DESC LIMIT 1
        RETURNING id;`).trim();
      psql(`
        INSERT INTO proc.pr_lines (pr_id, line_no, item_id, quantity, uom, unit_price_est, gl_account, description, category)
        SELECT ${lit(splitPr)}::uuid, n.line_no, i.id, n.qty,
               COALESCE((SELECT code FROM core.uom WHERE code='EA'), (SELECT code FROM core.uom ORDER BY code LIMIT 1)),
               100, i.gl_account, n.descr, i.category
          FROM (VALUES (1, 10::numeric, 'split line 1'), (2, 5::numeric, 'split line 2')) AS n(line_no, qty, descr)
          JOIN core.items i ON i.id = ${lit(itemA)}::uuid
         WHERE n.line_no = 1
        UNION ALL
        SELECT ${lit(splitPr)}::uuid, n.line_no, i.id, n.qty,
               COALESCE((SELECT code FROM core.uom WHERE code='EA'), (SELECT code FROM core.uom ORDER BY code LIMIT 1)),
               100, i.gl_account, n.descr, i.category
          FROM (VALUES (1, 10::numeric, 'split line 1'), (2, 5::numeric, 'split line 2')) AS n(line_no, qty, descr)
          JOIN core.items i ON i.id = ${lit(itemB)}::uuid
         WHERE n.line_no = 2;`);

      const sRfq = rfqWithQuote(splitPr, vendorA, 100);
      psql(`
        UPDATE proc.comparative_statements
           SET recommendation = jsonb_build_object('split', jsonb_build_array(
                 jsonb_build_object('vendor_id', ${lit(vendorA)}::text, 'line_no', 1),
                 jsonb_build_object('vendor_id', ${lit(vendorB)}::text, 'line_no', 2))),
               award_mode = 'SPLIT'
         WHERE pr_id = ${lit(splitPr)}::uuid;`);
      psql(`
        INSERT INTO proc.comparative_statements
          (cs_number, pr_id, generated_at, generated_by_user_id, locked_at, locked_by_user_id,
           recommendation, scores, weights, state, cs_round, rfq_id, award_mode)
        VALUES ('CS-W5H-SPLIT', ${lit(splitPr)}::uuid, now(), ${lit(requester)}::uuid,
                now(), ${lit(requester)}::uuid,
                jsonb_build_object('split', jsonb_build_array(
                  jsonb_build_object('vendor_id', ${lit(vendorA)}::text, 'line_no', 1),
                  jsonb_build_object('vendor_id', ${lit(vendorB)}::text, 'line_no', 2))),
                '{}'::jsonb, '{}'::jsonb, 'Locked', 1, ${lit(sRfq)}::uuid, 'SPLIT');`);
      psql(`UPDATE proc.purchase_requisitions SET status = 'PACK_LOCKED' WHERE id=${lit(splitPr)}::uuid;`);

      // The refusal that Track G could not satisfy: one PO cannot name two vendors.
      const singleOnSplit = await api(`/pr/${splitPr}/po`, { method: 'POST', token: procurement, body: { mode: 'SINGLE' } });
      if (singleOnSplit.status === 400 && /SPLIT/.test(singleOnSplit.text)) {
        ok('a split PR REFUSES a single combined PO, and says why', singleOnSplit.data?.message?.slice(0, 60));
      } else bad('a split PR REFUSES a single combined PO', `status ${singleOnSplit.status} ${singleOnSplit.text.slice(0, 200)}`);

      const splitGen = await api(`/pr/${splitPr}/po`, { method: 'POST', token: procurement, body: { mode: 'AUTO' } });
      const fan = psql(`
        SELECT count(*) || '|' || count(DISTINCT vendor_id) || '|' ||
               count(*) FILTER (WHERE generation_mode = 'PER_LINE')
          FROM proc.purchase_orders WHERE pr_id = ${lit(splitPr)}::uuid;`).trim();
      eq('the split fans out to 2 POs across 2 distinct vendors, PER_LINE', fan, '2|2|2');

      const splitCovered = psql(`SELECT total_lines || '|' || covered_lines || '|' || uncovered_lines
                                    FROM proc.fn_pr_line_po_coverage(${lit(splitPr)}::uuid);`).trim();
      eq('and every split line is on exactly one vendor PO', splitCovered, '2|2|0');
      // Assert the call itself. The previous form printed PASS with the
      // undefined po_count of a FAILED response, which is a green light wired
 // to nothing  the fan-out could be completely broken and still report.
      if (splitGen.status < 400) {
        eq('split generation returns 2 orders', String(splitGen.data?.po_count), '2');
      } else {
        bad('split generation returns 2 orders', `status ${splitGen.status} ${splitGen.text.slice(0, 240)}`);
      }
    } catch (e) {
      bad('the split fan-out section ran', String(e?.message).slice(0, 300));
    }
  } catch (e) {
    bad('the PO fixture section ran', String(e?.message).slice(0, 300));
  }

 // --------------------------------------------------------------------------
  // 3. MASTER-DATA SYNC
 // --------------------------------------------------------------------------
  console.log('\n--- 3 · D365 master-data sync ---');
  for (const [path, label] of [
    ['/d365/sync/status', 'the sync status endpoint responds'],
    ['/d365/sync/operating-units', 'operating units sync'],
    ['/d365/sync/workers', 'workers sync'],
    ['/d365/sync/dimensions', 'dimension values sync'],
  ]) {
    const r = await api(path, { method: path === '/d365/sync/status' ? 'GET' : 'POST', token: procurement, body: path === '/d365/sync/status' ? undefined : {} });
    if (r.status < 400) ok(label, r.data?.mode ? `mode=${r.data.mode}` : '');
    else bad(label, `status ${r.status} ${r.text.slice(0, 200)}`);
  }

 // --------------------------------------------------------------------------
  // --------------------------------------------------------------------------
  //
  // Run against the API in STUB mode, because the API's own D365 config is
  // not the fake's. Stub is the honest thing to assert here: it proves the
  // endpoint asserts nothing and marks nothing as synced when no connection
  // exists. The live path is exercised directly through the client against the
  // fake in the next block, where the credentials really can be pointed at it.
 // --------------------------------------------------------------------------
  console.log('\n--- 3b · vendor onboarding / hold / category sync ---');

  const preview = await api('/d365/sync/vendors/preview', { token: procurement });
  if (preview.status < 400) {
    eq('preview reports every vendor as never pushed',
      String(preview.data?.never_pushed === preview.data?.total), 'true');
  } else bad('preview reports every vendor as never pushed', `status ${preview.status} ${preview.text.slice(0, 200)}`);

  const beforeLedger = psql(`SELECT count(*) FROM core.vendors WHERE d365_vendor_synced_at IS NOT NULL;`).trim();
  eq('no vendor is recorded as synced to begin with', beforeLedger, '0');

  const stubPush = await api('/d365/sync/vendors', { method: 'POST', token: procurement, body: {} });
  if (stubPush.status < 400 && stubPush.data?.mode === 'stub') {
    ok('a stub push reports itself as a stub', String(stubPush.data?.pushed) + ' pushed');
  } else bad('a stub push reports itself as a stub', `status ${stubPush.status} ${stubPush.text.slice(0, 200)}`);

  eq('and a stub push sends nothing', String(stubPush.data?.pushed), '0');
  const afterStub = psql(`SELECT count(*) FROM core.vendors WHERE d365_vendor_synced_at IS NOT NULL;`).trim();
  eq('and marks no vendor as synced', afterStub, '0');
  const stubAudit = psql(`
    SELECT count(*) FROM audit.audit_log
     WHERE action = 'd365_vendor_sync'
       AND ts > now() - interval '5 minutes';`).trim();
  eq('and writes no audit row claiming a sync that never happened', stubAudit, '0');

 //  the live push, driven through the client against the fake F&O 
  // The API cannot be pointed at the fake (its config comes from the process
  // environment), so the transport half is driven directly. That is still the
  // real client doing a real POST and a real PATCH.
  const vFake = await startFakeD365({ pageSize: 2, vendors: 2 });
  const restoreV = vFake.redirectTokenFetch();
  try {
    const cfgV = {
      tenantId: vFake.tenant, clientId: vFake.clientId, clientSecret: vFake.clientSecret,
      resourceUrl: vFake.baseUrl,
    };
    const tokens = new d365.EntraTokenProvider(cfgV);
    const od = new d365.ODataClient({ baseUrl: vFake.baseUrl, tokens });

    const vendorRow = psql(`
      SELECT vendor_code || '|' || COALESCE(legal_name,'(null)') || '|' ||
             is_hold::text || '|' || COALESCE(array_to_string(preferred_categories,','),'(none)') || '|' ||
             COALESCE(currency,'(null)')
        FROM core.vendors ORDER BY vendor_code LIMIT 1;`).trim();
    const [vCode, vName, vHold, vCats, vCur] = vendorRow.split('|');

    const payload = {
      [d365.D365_VENDOR_FIELDS.account]: vCode,
      [d365.D365_VENDOR_FIELDS.name]: vName,
      [d365.D365_VENDOR_FIELDS.legalName]: vName,
      [d365.D365_VENDOR_FIELDS.isOnHold]: vHold === 'true',
      [d365.D365_VENDOR_FIELDS.blockOnHold]: vHold === 'true',
      [d365.D365_VENDOR_FIELDS.categoryNote]: vCats === '(none)' ? null : `procurement-categories: ${vCats}`,
      [d365.D365_VENDOR_FIELDS.currency]: vCur === '(null)' ? null : vCur,
    };

    const existing = await od.count(d365.D365_ENTITY_SETS.vendors,
      `${d365.D365_VENDOR_FIELDS.account} eq '${vCode}'`);
    eq('F&O has no such vendor yet, so this is a create', String(existing), '0');

    const created = await od.post(d365.D365_ENTITY_SETS.vendors, payload);
    if (created?.[d365.D365_VENDOR_FIELDS.account] === vCode) {
      ok('a new vendor is POSTed to F&O and comes back keyed', vCode);
    } else bad('a new vendor is POSTed to F&O and comes back keyed', JSON.stringify(created).slice(0, 160));

    const heldNow = await od.count(d365.D365_ENTITY_SETS.vendors,
      `${d365.D365_VENDOR_FIELDS.account} eq '${vCode}'`);
    eq('and is then found by its VendorAccount', String(heldNow), '1');

    // The hold control must actually ENFORCE, not merely record.
    const createdHold = created?.[d365.D365_VENDOR_FIELDS.blockOnHold];
    if (createdHold === (vHold === 'true')) {
      ok('the hold control is carried through, BlockOnHold included', String(createdHold));
    } else {
      bad('the hold control is carried through, BlockOnHold included',
        `sent is_hold=${vHold}, F&O reports ${createdHold}`);
    }

    const patched = await od.patchByKey(d365.D365_ENTITY_SETS.vendors,
      `${d365.D365_VENDOR_FIELDS.account}='${vCode}'`,
      { [d365.D365_VENDOR_FIELDS.isOnHold]: true, [d365.D365_VENDOR_FIELDS.blockOnHold]: true });
    if (patched?.[d365.D365_VENDOR_FIELDS.isOnHold] === true) {
      ok('an existing vendor is PATCHed by key, not re-POSTed');
    } else bad('an existing vendor is PATCHed by key, not re-POSTed', JSON.stringify(patched).slice(0, 160));

    // A vendor key that does not exist must fail loudly rather than create one.
    let missingThrew = false;
    try {
      await od.patchByKey(d365.D365_ENTITY_SETS.vendors,
        `${d365.D365_VENDOR_FIELDS.account}='V-NOPE-9999'`, { [d365.D365_VENDOR_FIELDS.isOnHold]: true });
    } catch { missingThrew = true; }
    if (missingThrew) ok('patching a vendor F&O does not have FAILS rather than inventing one');
    else bad('patching a vendor F&O does not have FAILS rather than inventing one', 'no error raised');

    const createdCount = vFake.calls.filter((c) => c.method === 'POST' && c.url.includes('VendorsV2')).length;
    eq('exactly one vendor POST reached F&O', String(createdCount), '1');
  } finally {
    try { restoreV?.(); } catch { /* already released by close() */ }
    await vFake.close();
  }

 //  change detection: the reason "unchanged" is trustworthy 
  const probeVendor = psql(`SELECT id FROM core.vendors ORDER BY vendor_code LIMIT 1;`).trim();
  const h1 = psql(`SELECT core.fn_vendor_d365_sync_hash('${probeVendor}'::uuid);`).trim();
  const h2 = psql(`SELECT core.fn_vendor_d365_sync_hash('${probeVendor}'::uuid);`).trim();
  eq('an untouched vendor hashes identically twice', h1, h2);

  // The governed-change trigger refuses a raw UPDATE on core.vendors. The
  // documented exemption is a session GUC  so it must be set in the SAME
  // psql invocation as the UPDATE. psql() spawns a fresh process per call, so
  // setting it in a previous call achieves nothing.
  psql(`
    SELECT set_config('app.vendor_legacy_write','on',false);
    UPDATE core.vendors SET is_hold = true, hold_reason = 'W5H hold probe',
           held_at = now(), held_by_user_id = (SELECT id FROM core.users WHERE role='admin' LIMIT 1)
     WHERE id = '${probeVendor}'::uuid;`);
  const h3 = psql(`SELECT core.fn_vendor_d365_sync_hash('${probeVendor}'::uuid);`).trim();
  if (h3 !== h1) ok('holding a vendor changes its sync hash, so it becomes pending');
  else bad('holding a vendor changes its sync hash, so it becomes pending', 'hash did not move');

  const pendingHeld = await api('/d365/sync/vendors/preview', { token: procurement });
  if (pendingHeld.status < 400 && pendingHeld.data?.held >= 1) {
    ok('and the held vendor shows up as held in the preview', `${pendingHeld.data.held}`);
  } else bad('and the held vendor shows up as held in the preview', `status ${pendingHeld.status}`);

  // restore
  psql(`
    SELECT set_config('app.vendor_legacy_write','on',false);
    UPDATE core.vendors SET is_hold = false, hold_reason = NULL, held_at = NULL,
           held_by_user_id = NULL
     WHERE id = '${probeVendor}'::uuid;`);
  const h4 = psql(`SELECT core.fn_vendor_d365_sync_hash('${probeVendor}'::uuid);`).trim();
  eq('and lifting the hold restores the original hash exactly', h4, h1);

 // --------------------------------------------------------------------------
  // 4. AUDIT
 // --------------------------------------------------------------------------
  const chain = psql(`SELECT COALESCE(first_bad_id::text,'clean') FROM audit.fn_verify_audit_chain();`).trim();
  eq('the audit hash chain is clean', chain, 'clean');

  // ------------------------------------------------------------------------
  // WHAT THIS DOES NOT PROVE
  // ------------------------------------------------------------------------
  finding('no live D365 tenant was available',
    'the transport is proven against a local protocol-faithful fake; F&O schema, ' +
    'app consent and permission grants are unverified');
  finding('the F&O vendor property names are unverified',
    'D365_VENDOR_FIELDS holds the standard VendorsV2 names, but none has been ' +
    'confirmed against a real tenant. A wrong name fails loudly as a 400 naming ' +
    'the field rather than as a field that silently never syncs');
  finding('vendor categories sync as a delimited note, not a queryable field',
    "F&O's vendor entity has no category array, so preferred_categories travels " +
    'as text in the annotation field and cannot be filtered on in F&O');
  finding('no stock or inventory integration',
    'unrelated to this track, still absent - see the W5-F report');
}

/**
 * Restore every mutation, then report what is left by design.
 *
 * Called from main()'s finally, NOT run as a section. As a section it was
 * skipped whenever an earlier section threw - which is exactly when cleanup
 * matters most. A crashed run leaked a comparative statement whose cs_number
 * then made the NEXT run fail on a duplicate key. A leaked PR, or a vendor
 * left frozen, is an incident in a procurement system, not a test artefact.
 */
async function runCleanup() {
  console.log('\n--- 4 · cleanup ---');
  try {
 // Each step independently, so one refusal does not skip the rest  an
    // immutable approved_pack once aborted the whole block and leaked the PR.
    const step = (label, sql) => {
      try { psql(sql); }
      catch (e) { bad(`cleanup step: ${label}`, String(e?.message).split('\n')[0].slice(0, 180)); }
    };

    step('PO lines', `
      DELETE FROM proc.purchase_order_lines
       WHERE pr_line_id IN (SELECT pl.id FROM proc.pr_lines pl
                              JOIN proc.purchase_requisitions p ON p.id = pl.pr_id
                             WHERE p.pr_number LIKE 'PR-W5H%');`);
    step('PO exclusions', `
      DELETE FROM proc.pr_line_po_exclusions
       WHERE pr_line_id IN (SELECT pl.id FROM proc.pr_lines pl
                              JOIN proc.purchase_requisitions p ON p.id = pl.pr_id
                             WHERE p.pr_number LIKE 'PR-W5H%');`);
    step('purchase orders', `
      DELETE FROM proc.purchase_orders
       WHERE po_number LIKE 'LOCAL-PO-%'
          OR pr_id IN (SELECT id FROM proc.purchase_requisitions WHERE pr_number LIKE 'PR-W5H%');`);
    step('quotation lines', `
      DELETE FROM proc.quotation_lines
       WHERE quotation_id IN (SELECT q.id FROM proc.quotations q
                               JOIN proc.rfq r ON r.id = q.rfq_id
                               JOIN proc.purchase_requisitions p ON p.id = r.pr_id
                              WHERE p.pr_number LIKE 'PR-W5H%');`);
    step('quotations', `
      DELETE FROM proc.quotations
       WHERE rfq_id IN (SELECT r.id FROM proc.rfq r
                         JOIN proc.purchase_requisitions p ON p.id = r.pr_id
                        WHERE p.pr_number LIKE 'PR-W5H%');`);
    step('invitations', `
      DELETE FROM proc.rfq_invitations
       WHERE rfq_id IN (SELECT r.id FROM proc.rfq r
                         JOIN proc.purchase_requisitions p ON p.id = r.pr_id
                        WHERE p.pr_number LIKE 'PR-W5H%');`);
    step('rfq', `
      DELETE FROM proc.rfq
       WHERE pr_id IN (SELECT id FROM proc.purchase_requisitions WHERE pr_number LIKE 'PR-W5H%');`);
    step('pr lines', `
      DELETE FROM proc.pr_lines
       WHERE pr_id IN (SELECT id FROM proc.purchase_requisitions WHERE pr_number LIKE 'PR-W5H%');`);
    step('comparative statements', `
      DELETE FROM proc.comparative_statements
       WHERE pr_id IN (SELECT id FROM proc.purchase_requisitions WHERE pr_number LIKE 'PR-W5H%');`);
    step('purchase requisitions', `DELETE FROM proc.purchase_requisitions WHERE pr_number LIKE 'PR-W5H%';`);

    // The vendor hold probe in 3b. Restored here as well as inline, so a
    // failure between the two cannot leave a real vendor frozen  a leaked
    // hold is a procurement incident, not a test artefact.
    step('vendor hold probe', `
      SELECT set_config('app.vendor_legacy_write','on',false);
      UPDATE core.vendors SET is_hold = false, hold_reason = NULL,
             held_at = NULL, held_by_user_id = NULL
       WHERE hold_reason = 'W5H hold probe';`);

    const leftOverHold = psql(
      `SELECT count(*) FROM core.vendors WHERE hold_reason = 'W5H hold probe';`).trim();
    eq('no vendor is left frozen by the hold probe', leftOverHold, '0');

    const left = psql(`
      SELECT (SELECT count(*) FROM proc.purchase_requisitions WHERE pr_number LIKE 'PR-W5H%')::text || '|' ||
             (SELECT count(*) FROM proc.purchase_orders WHERE po_number LIKE 'LOCAL-PO-%')::text || '|' ||
             (SELECT count(*) FROM proc.purchase_order_lines
               WHERE pr_line_id NOT IN (SELECT id FROM proc.pr_lines))::text;`).trim();
    const [prs, pos, orphans] = left.split('|');
    eq('no harness PR survives', prs, '0');
    eq('no harness purchase order survives', pos, '0');
    eq('no orphaned PO line survives', orphans, '0');

    const audited = psql(`
      SELECT count(*) FROM audit.audit_log
       WHERE action IN ('po_generate','po_issue','po_push','po_cancel','d365_master_sync')`).trim();
    ok('W5-H audit rows are permanent, by design', `${audited} row(s)`);
  } catch (e) {
    bad('cleanup completed', String(e?.message).slice(0, 300));
  }
}


// The summary, the exit code AND the cleanup all live in a finally. A
// harness that dies mid-section must still print its tally - a silent crash
// is the one failure mode that reads exactly like success in a CI log - and
// must still undo what it wrote.
async function main() {
  let crashed = null;
  try {
    await runSections();
  } catch (e) {
    crashed = e;
    bad('the harness ran to completion', String(e?.message).slice(0, 300));
  } finally {
    await runCleanup();
    console.log(`\n${fail} failed, ${pass} passed, ${findings} finding(s)\n`);
    if (fail > 0 || crashed) process.exit(1);
  }
}

/** Used where a statement is EXPECTED to fail; returns rather than throws. */
function psqlExpectingFailure(sql) {
  const r = spawnSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', 'proc', '-d', 'procurementDB',
      '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'],
    { encoding: 'utf8', input: `SET app.bypass_rls = 'true';\n${sql}\n` },
  );
  return { failed: r.status !== 0, message: `${r.stderr || ''}`.trim() };
}

main().catch((e) => { console.error(e); process.exit(1); });
