// Wave 3 step 3 — the D365 push, payload preview, idempotency and sync.
//
//   node scripts/e2e_d365.mjs
//
// Requires: Postgres on 55432, the API on 33001, migrations 027 applied.
//
// What this suite proves:
//   1. The payload preview IS the payload — one builder, two consumers.
//   2. NONE of the prototype's placeholders survive: no PO-2026-00781, no
//      V-000123, no 2400000, no "a3f9c1...".
//   3. The bearer acknowledgement token never leaves the portal.
//   4. A push is IDEMPOTENT. Two pushes, one PO, one d365_pushes row.
//   5. Status advances ONLY on an observed sync. There is no timer.
//   6. attempt_no is capped at 5 by the schema; a dead letter is terminal.

import { spawnSync } from 'child_process';
import { issueWithRoster } from './_rfq_roster.mjs';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
  if (c) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''}`); }
};

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

function psql(sql) {
  const r = spawnSync(
    'docker', ['exec', '-i', 'procurement-portal-db', 'psql', '-U', 'proc',
               '-d', 'procurementDB', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { input: `SET app.bypass_rls = 'true';\n${sql}`, encoding: 'utf8' },
  );
  return `${r.stdout || ''}${r.stderr || ''}`.trim();
}

const login = async (email) =>
  (await api('/auth/login', { method: 'POST', body: { email, password: 'demo' } })).data?.token;

const LAPTOP = '55555555-5555-5555-5555-555555555503';

const requester = await login('requester@pakboxes.pk');
const hod = await login('hod.sales@pakboxes.pk');
const proc = await login('procurement@pakboxes.pk');
const csUser = await login('cs@pakboxes.pk');
const cfo = await login('cfo@pakboxes.pk');
const p1 = await login('mc.member1@pakboxes.pk');
const p2 = await login('mc.member2@pakboxes.pk');
const p3 = await login('mc.member3@pakboxes.pk');
const p4 = await login('mc.member4@pakboxes.pk');
const p5 = await login('mc.member5@pakboxes.pk');
const PANEL = [p1, p2, p3, p4, p5];
ok(Boolean(requester && hod && proc && csUser && cfo && PANEL.every(Boolean)), 'all logins returned a token');

async function fixture(title, unitPriceEst) {
  const ccs = await api('/lookups/cost-centers', { token: requester });
  const c = await api('/pr', {
    method: 'POST', token: requester,
    body: {
      scope: 'Wave 3 step 3 fixture', expenseType: 'OPEX', costCenterId: ccs.data?.[0]?.id,
      requiredByDate: '2026-12-31', title, description: title,
      lines: [{ itemId: LAPTOP, quantity: 1, uom: 'EA', unitPriceEst }],
    },
  });
  const id = c.data.id;
  const a = await api(`/pr/${id}/advance`, {
    method: 'POST', token: hod,
    body: { lineDecisions: { 0: 'approved' }, reason: 'HOD approved' },
  });
  if ((a.data?.nextStage) !== 'IN_PROCUREMENT_REVIEW') {
    throw new Error(`fixture landed at ${a.data?.nextStage}`);
  }
  return id;
}

async function quote(rfqId, vendorId, o) {
  return api(`/rfq/${rfqId}/quotations`, {
    method: 'POST', token: proc,
    body: {
      vendorId, quoteMode: 'per_line', currency: 'PKR', subtotal: o.unitPrice,
      taxPercent: 0, freight: 0, leadTimeDays: o.leadTimeDays,
      warrantyMonths: o.warrantyMonths, validityDays: 30, taxesIncluded: false,
      paymentTerms: '30 days net', notes: 'Quoted.',
      lines: [{ rfqLineNo: 1, unitPrice: o.unitPrice }],
    },
  });
}

/** Drive a PR all the way to PACK_LOCKED on a STANDARD route. */
async function toPackLocked(title) {
  const prId = await fixture(title, 30_000);
  psql(`UPDATE proc.purchase_requisitions SET routing_key = 'STANDARD' WHERE id = '${prId}';`);
  // The automatic roster is CATEGORY-matched and risk-filtered, so it is
  // legitimately shorter than the prototype's fixed 3 — this fixture is a
  // laptop (IT_HARDWARE) and the only third IT vendor carries a High risk band,
  // which Blueprint 9.5 keeps off the roster. issueWithRoster tops it up via the
  // supported POST /rfq/:id/invite path. Hard-coding 3 here assumed the old
  // category-blind pool, which would have picked 3 vendors from ANY category.
  const { rfqId, invites: roster } = await issueWithRoster(api, proc, prId, 3);
  const offers = [
    { unitPrice: 28_000, leadTimeDays: 21, warrantyMonths: 36 },
    { unitPrice: 31_000, leadTimeDays: 10, warrantyMonths: 24 },
    { unitPrice: 34_000, leadTimeDays: 30, warrantyMonths: 12 },
  ];
  for (let i = 0; i < Math.min(3, roster.length); i++) {
    await quote(rfqId, roster[i].vendor_id, offers[i]);
  }
  const gen = await api(`/pr/${prId}/cs`, { method: 'POST', token: csUser, body: {} });
  if (gen.status >= 400 || !gen.data?.cs) {
    throw new Error(
      `CS compile failed (${gen.status}): ${JSON.stringify(gen.data).slice(0, 300)} ` +
      `— rfq=${rfqId} roster=${roster.length}`);
  }
  await api(`/cs/${gen.data.cs.id}/lock`, {
    method: 'POST', token: csUser, body: { winnerVendorId: gen.data.lines[0].vendor_id },
  });
  for (const t of PANEL) await api(`/pr/${prId}/mc/vote`, { method: 'POST', token: t, body: { decision: 'approve' } });
  await api(`/pr/${prId}/cfo/decide`, { method: 'POST', token: cfo, body: { approve: true } });
  await api(`/pr/${prId}/pack/lock`, { method: 'POST', token: csUser, body: {} });
  return prId;
}

// ── 1 · the payload is refused before the pack is locked ───────────────────

console.log('\n--- gates: a PR without a frozen pack cannot be pushed ---');

const early = await fixture('D365 e2e — not packed', 30_000);
const earlyPayload = await api(`/pr/${early}/d365/payload`, { token: csUser });
ok(earlyPayload.status === 200, 'the payload reads for any PR', earlyPayload.data?.message);
ok(earlyPayload.data?.ready === false, 'not pushable without a pack');
ok(earlyPayload.data?.can_push === false, 'and the button is off');

const earlyPush = await api(`/pr/${early}/d365/push`, { method: 'POST', token: csUser });
ok(earlyPush.status === 409, 'a push is refused', earlyPush.status);
ok(/Pack not yet locked/.test(earlyPush.data?.message || ''),
  'the refusal is d365Push()\'s own words', earlyPush.data?.message);

const reqPush = await api(`/pr/${early}/d365/push`, { method: 'POST', token: requester });
ok(reqPush.status === 403, 'a requester cannot push', reqPush.status);
ok(/Only CS can push/.test(reqPush.data?.message || ''), 'the refusal is d365Push()\'s own words', reqPush.data?.message);

// ── 2 · the payload preview ───────────────────────────────────────────────

console.log('\n--- the payload preview ---');

const prId = await toPackLocked('D365 e2e — full chain');
const pv = await api(`/pr/${prId}/d365/payload`, { token: csUser });
ok(pv.status === 200, 'GET /pr/:id/d365/payload 200', pv.data?.message);
ok(pv.data?.ready === true, 'pushable once the pack is frozen');
ok(pv.data?.can_push === true, 'CS may push');
ok(pv.data?.entity === 'PurchPurchaseOrderHeadersV2', 'the entity is the prototype\'s', pv.data?.entity);

const p = pv.data?.payload || {};
ok(p.PurchaseOrderNumber === null, 'no PO number before the push — the prototype hardcodes PO-2026-00781', p.PurchaseOrderNumber);
ok(p.VendorAccount !== 'V-000123', 'not the prototype\'s V-000123', p.VendorAccount);
ok(/^V-/.test(p.VendorAccount || ''), 'it is the CS winner\'s real vendor code', p.VendorAccount);
ok(p.TotalAmount !== 2400000, 'not the prototype\'s 2400000 fallback', p.TotalAmount);
ok(p.TotalAmount === 28000, 'the total is the AWARDED quotation, not the PR estimate', p.TotalAmount);
ok(/^sha256:[0-9a-f]{64}$/.test(p.PortalPackHash || ''),
  'PortalPackHash is the real frozen hash, not "a3f9c1..."', p.PortalPackHash);
ok(p.PortalPRNumber === psql(`SELECT pr_number FROM proc.purchase_requisitions WHERE id = '${prId}';`),
  'the envelope carries the real PR number');

ok(Array.isArray(p.Lines) && p.Lines.length === 1, 'the payload has the PR lines', p.Lines?.length);
const l0 = p.Lines[0];
ok(l0.ItemId === 'PKB-LT-001', 'ItemId is the real item code', l0.ItemId);
ok(Object.keys(l0.FinancialDimensions).length === 9, 'all 9 financial dimensions', Object.keys(l0.FinancialDimensions));
ok('FixedAssetGroup' in l0 === false, 'an opex line carries no fixed-asset fields');

const serialised = JSON.stringify(pv.data?.payload);
ok(serialised.includes('PO-2026-00781') === false, 'the payload contains no prototype placeholder');
ok(serialised.includes('V-000123') === false, 'and no placeholder vendor');
ok(serialised.includes('a3f9c1') === false, 'and no placeholder pack hash');

// The bearer token must not leave the portal. Tag approvers first so the
// acknowledgement block is actually populated.
await api(`/pr/${prId}/acknowledgements`, {
  method: 'POST', token: requester,
  body: { approvers: [{ taggedRole: 'employee', name: 'Owais Siddiqui', email: 'owais@pakboxes.pk' }] },
});
const pv2 = await api(`/pr/${prId}/d365/payload`, { token: csUser });
const tokens = pv2.data?.payload?.Lines?.[0]?.AcknowledgementTokens || [];
ok(tokens.length === 1, 'the acknowledgement block is populated', tokens);
ok(tokens[0]?.email === 'owais@pakboxes.pk', 'and carries the real approver', tokens[0]);
const walk = (v) => {
  if (Array.isArray(v)) return v.forEach(walk);
  if (v && typeof v === 'object') for (const [k, val] of Object.entries(v)) {
    if (k.toLowerCase() === 'token') ok(false, 'the payload leaked a bearer token', k);
    walk(val);
  }
};
walk(pv2.data?.payload);
ok(true, 'no bearer token anywhere in the payload');
ok(pv2.data?.header?.AcknowledgementStatus === 'PENDING 0/1', 'the ack status is a real count', pv2.data?.header?.AcknowledgementStatus);

// ── 3 · the push, and only once ───────────────────────────────────────────

console.log('\n--- the push is idempotent ---');

const push1 = await api(`/pr/${prId}/d365/push`, { method: 'POST', token: csUser });
ok([200, 201].includes(push1.status), 'push accepted', push1.data?.message);
ok(push1.data?.pushed === true, 'pushed');
ok(push1.data?.already_pushed === false, 'this was the first push');
// W5-H: the assertion used to be `/^PO-\d{4}-\d{6}$/` — "a real PO number came
// back". In stub mode NO real purchase order exists, and the old stub produced a
// number with exactly that shape, so the test could not tell a fabricated PO from
// a real one. It was checking plausibility, not truth.
//
// The contract is now: the stub's number is visibly a stub, the response says
// so, and the success message refuses to claim a commitment. A live-mode run
// asserts the F&O shape instead.
const stubbed = push1.data?.stubbed === true;
if (stubbed) {
  ok(/^STUB-PO-\d{4}-\d{6}$/.test(push1.data?.po_number || ''),
    'the stub PO number is VISIBLY a stub and cannot be mistaken for F&O',
    push1.data?.po_number);
  ok(/STUB MODE/.test(push1.data?.next || ''),
    'and the API refuses to present it as a real commitment', push1.data?.next);
} else {
  ok(/^PO-\d{4}-\d{6}$/.test(push1.data?.po_number || ''),
    'a real PO number came back from F&O', push1.data?.po_number);
}
ok(push1.data?.stage === 'D365_PUSHED', 'the PR moved to D365_PUSHED', push1.data?.stage);
ok(/OData POST PurchPurchaseOrderHeadersV2 succeeded/.test(push1.data?.event?.detail || ''),
  'the event line is the prototype\'s own', push1.data?.event);

ok(psql(`SELECT status FROM proc.purchase_requisitions WHERE id = '${prId}';`) === 'D365_PUSHED',
  'the DB is at D365_PUSHED');
ok(psql(`SELECT d365_po_number FROM proc.purchase_requisitions WHERE id = '${prId}';`) === push1.data.po_number,
  'the PO number is stamped on the PR');

const push2 = await api(`/pr/${prId}/d365/push`, { method: 'POST', token: csUser });
ok([200, 201].includes(push2.status), 'a second push is not an error', push2.status);
ok(push2.data?.already_pushed === true, 'the second push is reported as a replay', push2.data);
ok(push2.data?.po_number === push1.data.po_number, 'and reports the ORIGINAL PO number', push2.data?.po_number);
ok(psql(`SELECT count(*) FROM proc.d365_pushes WHERE pr_id = '${prId}';`) === '1',
  'still exactly ONE d365_pushes row — no second PO');
ok(psql(`SELECT status FROM proc.d365_pushes WHERE pr_id = '${prId}';`) === 'succeeded',
  'the push row is succeeded');
ok(psql(`SELECT count(*) FROM audit.audit_log WHERE entity_id = '${prId}' AND action = 'pack_push';`) === '1',
  'exactly one pack_push audit entry');

// The idempotency key is the PR plus the FROZEN PACK, so it is reproducible.
const packHash = psql(`SELECT pack_hash FROM proc.approved_packs WHERE pr_id = '${prId}';`);
ok(psql(`SELECT idempotency_key FROM proc.d365_pushes WHERE pr_id = '${prId}';`) === `${prId}:${packHash}`,
  'the key is <pr>:<pack_hash>');

// ── 4 · status does NOT advance on a timer ────────────────────────────────

console.log('\n--- status advances only on an observed sync (no timers) ---');

const st0 = await api(`/pr/${prId}/d365/status`, { token: csUser });
ok(st0.status === 200, 'GET /pr/:id/d365/status 200', st0.data?.message);
ok(st0.data?.pushed === true, 'the status screen knows the PO exists');
ok(st0.data?.po_number === push1.data.po_number, 'and which PO');
ok(st0.data?.d365_status === 'CONFIRMED', 'the push recorded CONFIRMED', st0.data?.d365_status);
ok(st0.data?.events?.length === 6, 'the six-row event stream', st0.data?.events?.length);
ok(JSON.stringify(st0.data?.events?.[0]?.detail).includes(push1.data.po_number),
  'the confirmed row names the real PO, not PO-2026-00781', st0.data?.events?.[0]?.detail);
ok(st0.data?.events?.[0]?.state === 'done', 'row 1 is done');
ok(st0.data?.events?.[1]?.state === 'pending', 'row 2 is pending');
ok(st0.data?.lines?.length === 1, 'the PO line table is populated once pushed');

const beforeWait = psql(`SELECT d365_status FROM proc.purchase_requisitions WHERE id = '${prId}';`);
await new Promise((r) => setTimeout(r, 3000));
const afterWait = psql(`SELECT d365_status FROM proc.purchase_requisitions WHERE id = '${prId}';`);
ok(beforeWait === afterWait,
  'waiting does NOT advance the status — the prototype setTimeout(2500) is not ported',
  { beforeWait, afterWait });

// ── 5 · sync observes and records ──────────────────────────────────────────

console.log('\n--- an observed sync moves the status ---');

const s1 = await api(`/pr/${prId}/d365/sync`, { method: 'POST', token: csUser });
ok([200, 201].includes(s1.status), 'sync accepted', s1.data?.message);
ok(s1.data?.changed === true, 'the status changed', s1.data);
ok(s1.data?.status === 'INVENTORY_RESERVED', 'and moved one ladder step', s1.data?.status);
ok(psql(`SELECT d365_status FROM proc.purchase_requisitions WHERE id = '${prId}';`) === 'INVENTORY_RESERVED',
  'the DB agrees');
ok(psql(`SELECT count(*) FROM proc.d365_sync_log WHERE pr_id = '${prId}' AND source = 'poll';`) === '1',
  'one poll row in d365_sync_log');

const st1 = await api(`/pr/${prId}/d365/status`, { token: csUser });
ok(st1.data?.events?.[1]?.state === 'done', 'row 2 flipped to done');
ok(st1.data?.events?.[0]?.reachedAt, 'the completed row carries a REAL observed timestamp', st1.data?.events?.[0]?.reachedAt);
ok(!/^\+\d/.test(st1.data?.events?.[0]?.ts || ''), 'and no longer shows a relative label', st1.data?.events?.[0]?.ts);

for (let i = 0; i < 4; i++) await api(`/pr/${prId}/d365/sync`, { method: 'POST', token: csUser });
const stFull = await api(`/pr/${prId}/d365/status`, { token: csUser });
ok(stFull.data?.d365_status === 'PAID', 'the ladder tops out at PAID', stFull.data?.d365_status);
ok(stFull.data?.events?.every((e) => e.state === 'done'), 'all six rows are done');
ok(psql(`SELECT count(*) FROM proc.d365_sync_log WHERE pr_id = '${prId}' AND source = 'poll';`) === '5',
  'five poll rows recorded');

// Syncing at the top of the ladder is a no-op, and is NOT written.
const top = await api(`/pr/${prId}/d365/sync`, { method: 'POST', token: csUser });
ok(top.data?.changed === false, 'a sync at the top of the ladder changes nothing', top.data);
ok(psql(`SELECT count(*) FROM proc.d365_sync_log WHERE pr_id = '${prId}' AND source = 'poll';`) === '5',
  'and is not recorded — the log is a record of CHANGES');

const cfoSync = await api(`/pr/${prId}/d365/sync`, { method: 'POST', token: cfo });
ok(cfoSync.status === 403, 'a CFO cannot sync', cfoSync.status);

// ── 6 · the attempt cap ───────────────────────────────────────────────────

console.log('\n--- attempt_no is capped at 5 by the schema ---');

const cap = psql(`
  DO $do$
  DECLARE v_pr uuid; i int; ok_count int := 0;
  BEGIN
    SELECT id INTO v_pr FROM proc.purchase_requisitions WHERE id = '${prId}';
    FOR i IN 1..6 LOOP
      BEGIN
        -- a distinct key per attempt: the UNIQUE on idempotency_key is a
        -- different constraint from the CHECK on attempt_no, and this probe is
        -- about the CHECK.
        INSERT INTO proc.d365_pushes (pr_id, idempotency_key, attempt_no, status)
        VALUES (v_pr, 'probe:' || v_pr::text || ':' || i::text, i, 'failed');
        ok_count := ok_count + 1;
      EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'attempt % refused by attempt_no BETWEEN 1 AND 5', i;
      END;
    END LOOP;
    RAISE NOTICE 'accepted % of 6 attempts', ok_count;
  END $do$;`);
ok(/accepted 5 of 6 attempts/.test(cap), 'exactly 5 of 6 attempts were accepted', cap.slice(0, 200));
ok(/attempt 6 refused/.test(cap), 'a 6th attempt is refused by the CHECK', cap.slice(0, 200));
ok(psql(`
  SELECT count(*) FROM proc.d365_pushes
   WHERE idempotency_key LIKE 'probe:${prId}:%';`) === '5',
  'five probe rows persisted, the 6th was rejected');
ok(psql(`SELECT count(*) FROM proc.d365_sync_log WHERE pr_id = '${prId}' AND source = 'poll';`) === '5',
  'the fixture\'s real push row is untouched by the probe');
ok(psql(`SELECT status FROM proc.d365_pushes WHERE pr_id = '${prId}' AND idempotency_key = '${prId}:${packHash}';`) === 'succeeded',
  'and the real push row still reads succeeded');

// ── 7 · an unpushed PR shows the prototype's info alert ────────────────────

console.log('\n--- before the push ---');

const stEarly = await api(`/pr/${early}/d365/status`, { token: requester });
ok(stEarly.status === 200, 'the status screen reads for an unpushed PR', stEarly.data?.message);
ok(stEarly.data?.pushed === false, 'nothing is pushed');
ok(stEarly.data?.po_number === null, 'no PO number');
ok(stEarly.data?.lines?.length === 0, 'no PO line table before a push');
ok(stEarly.data?.events?.length === 6, 'the event stream still renders its six rows');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
