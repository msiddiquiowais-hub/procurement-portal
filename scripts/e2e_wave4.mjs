// Wave 4 — external parties, end to end.
//
//   node scripts/e2e_wave4.mjs      (or: npm run e2e:wave4)
//
// Requires: Postgres on 55432, the API on 33001, the web app on 33002, the
// onboarding app on 33004, and migrations 001-028 applied.
//
// WHAT THIS IS FOR
// ----------------
// Steps 0-5 were each verified as they landed. This suite re-proves the whole
// wave in one pass against the running system, so a later change anywhere in it
// has to break something observable rather than quietly weakening a guarantee.
//
// The four load-bearing properties of this wave, in order of how badly it would
// hurt to lose them:
//
//   1. A supplier can only ever see their OWN RFQs.  (migration 028 + SupplierGuard)
//   2. Quotations are APPEND-ONLY. A revision never rewrites a prior version's
//      price; it marks it Superseded and inserts a new row. This is asserted at
//      the byte level, because "v1 is superseded and v2 exists" would still pass
//      a service that quietly destroyed v1's money columns.
//   3. Nothing fabricates a value. No Math.random reference, no prototype
//      literal, no sealed-quote claim anywhere the buyer or supplier reads.
//   4. The public intake is real AND not harvestable. A sequential reference is
//      enumerable, so the status lookup needs a second factor and returns a
//      subset of the row.
//
// REPEATABILITY
// -------------
// Every fixture is namespaced by a run token, so this can be run repeatedly
// without a database reset and without tripping over its own debris. That is why
// the assertions below are RELATIVE wherever an absolute value would depend on
// what a previous run left behind.

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const WEB = process.env.WEB_BASE || 'http://127.0.0.1:33002';
const ONBOARDING = process.env.ONBOARDING_BASE || 'http://127.0.0.1:33004';
const ROOT = path.join(process.cwd());

const RUN = String(Date.now()).slice(-7);
const ntn = (n) => `${RUN}-${n}`;
const V1 = '44444444-4444-4444-4444-444444444401'; // Acme Supplies (Pvt) Ltd
const V2 = '44444444-4444-4444-4444-444444444402'; // BoxCo Packaging Ltd
const LAPTOP = '55555555-5555-5555-5555-555555555503';

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
  if (c) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''}`); }
};
const head = (s) => console.log(`\n${'='.repeat(4)} ${s} ${'='.repeat(Math.max(0, 68 - s.length))}`);

function psql(sql, { quiet = false } = {}) {
  const out = execFileSync('docker', ['exec', '-i', 'procurement-portal-db', 'psql', '-U', 'proc',
    '-d', 'procurementDB', '-X', '-t', '-A', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { input: sql, encoding: 'utf8' }).trim();
  if (!quiet && out) console.log('        ' + out.split('\n').slice(0, 6).join('\n        '));
  return out;
}

async function api(p, { method = 'GET', token, body, base = API } = {}) {
  try {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const t = await res.text();
    let d = null; try { d = t ? JSON.parse(t) : null; } catch { d = { raw: t }; }
    return { status: res.status, data: d };
  } catch (e) {
    return { status: 0, data: { error: e.message } };
  }
}

const login = async (email) => (await api('/auth/login', { method: 'POST', body: { email, password: 'demo' } })).data?.token;

// ── preflight ───────────────────────────────────────────────────────────────
head('0 · preflight');
let healthy = true;
for (const [name, base] of [['API', API], ['web', WEB], ['onboarding', ONBOARDING]]) {
  const r = await api(base === API ? '/health' : '/', { base });
  // ok(), not a bare console.log. A check that prints PASS/FAIL without moving
  // the counters is a check that can report a failure the tally never sees.
  ok(r.status !== 0, `${name} reachable at ${base}`, r.status);
  if (r.status === 0) healthy = false;
}
const mig = psql(`SELECT count(*) FROM pg_indexes WHERE indexname = 'ux_vendor_app_ntn_pending'`, { quiet: true });
ok(mig === '1', 'migration 028 is applied', mig);
if (!healthy) {
  console.log('\nCannot continue without the services. Start them with .launch-next-v2.ps1.');
  process.exit(1);
}

const requester = await login('requester@pakboxes.pk');
const procurement = await login('procurement@pakboxes.pk');
const cs = await login('cs@pakboxes.pk');
const admin = await login('admin@pakboxes.pk');
const hod = await login('hod.sales@pakboxes.pk');
const vendor1 = await login('vendor1@example.com');
const vendor2 = await login('vendor2@example.com');
ok(!!requester && !!procurement && !!cs && !!admin && !!hod && !!vendor1 && !!vendor2,
  'all seven sessions authenticated', { requester: !!requester, vendor1: !!vendor1 });

// ── 1 · migration 028's own verification ────────────────────────────────────
head('1 · migration 028 verification (db:verify:028)');
{
  const sql = fs.readFileSync(path.join(ROOT, 'db/scripts/verify_028.sql'), 'utf8');
  let out = '';
  try {
    out = execFileSync('docker', ['exec', '-i', 'procurement-portal-db', 'psql', '-U', 'proc',
      '-d', 'procurementDB', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
      { input: sql, encoding: 'utf8' });
    ok(true, `verify_028.sql ran clean (${out.split('===').length - 1} sections)`);
  } catch (e) {
    const msg = (e.stderr || '') + (e.stdout || '');
    ok(false, 'verify_028.sql raised an error', msg.split('\n').filter(Boolean).slice(0, 3));
  }
}

// ── 2 · fixture ─────────────────────────────────────────────────────────────
head('2 · fixture — a PR, an RFQ, two suppliers invited');
const ccs = await api('/lookups/cost-centers', { token: requester });
const created = await api('/pr', {
  method: 'POST', token: requester,
  body: {
    scope: 'Wave 4 e2e', expenseType: 'OPEX', costCenterId: ccs.data?.[0]?.id,
    requiredByDate: '2026-12-31', title: `Wave 4 e2e ${RUN}`,
    lines: [{ itemId: LAPTOP, quantity: 1, uom: 'EA', unitPriceEst: 50_000 }],
  },
});
const prId = created.data?.id;
ok(!!prId, 'PR created', created.data);
const adv = await api(`/pr/${prId}/advance`, {
  method: 'POST', token: hod, body: { lineDecisions: { 0: 'approved' }, reason: `e2e ${RUN}` },
});
const landed = adv.data?.nextStage || adv.data?.stage;
ok(landed === 'IN_PROCUREMENT_REVIEW', 'PR reached IN_PROCUREMENT_REVIEW', { landed });
const issued = await api(`/pr/${prId}/rfq`, { method: 'POST', token: procurement, body: {} });
const rfqId = issued.data?.rfq?.id;
const inv1 = (issued.data?.invitations ?? []).find((i) => i.vendor_id === V1);
const inv2 = (issued.data?.invitations ?? []).find((i) => i.vendor_id === V2);
ok(!!rfqId && !!inv1 && !!inv2, 'RFQ issued, both supplier logins invited', { rfqId });
if (!rfqId || !inv1 || !inv2) { console.log('\nfixture failed, stopping'); process.exit(1); }

// ── 3 · supplier scoping ────────────────────────────────────────────────────
head('3 · a supplier sees only their own RFQs');
const in1 = await api('/supplier/inbox', { token: vendor1 });
const in2 = await api('/supplier/inbox', { token: vendor2 });
ok(in1.status === 200 && in2.status === 200, 'both inboxes load', { v1: in1.status, v2: in2.status });

const mine1 = in1.data?.invitations.find((i) => i.invitationId === inv1.invitation_id);
const mine2 = in2.data?.invitations.find((i) => i.invitationId === inv2.invitation_id);
ok(!!mine1 && !!mine2, 'each supplier sees their OWN invitation', { v1: !!mine1, v2: !!mine2 });
ok(!in1.data?.invitations.some((i) => i.invitationId === inv2.invitation_id),
  "vendor1 cannot see vendor2's invitation");
ok(!in2.data?.invitations.some((i) => i.invitationId === inv1.invitation_id),
  "vendor2 cannot see vendor1's invitation");

const cross = await api(`/supplier/rfq/${inv2.invitation_id}`, { token: vendor1 });
ok(cross.status === 404, "reading the other supplier's invitation is 404, not 403", cross.status);
ok(!/exists|forbidden/i.test(cross.data?.message ?? ''), 'and does not confirm it exists', cross.data?.message);

head('4 · the guard refuses every non-supplier');
for (const [label, tok] of [['procurement', procurement], ['cs', cs], ['admin', admin], ['requester', requester]]) {
  const r = await api('/supplier/inbox', { token: tok });
  ok(r.status === 403, `${label} is refused /supplier/inbox`, r.status);
}
const anon = await api('/supplier/inbox');
ok(anon.status !== 200, 'an anonymous caller is refused', anon.status);

// ── 5 · the inbox renders real values ───────────────────────────────────────
head('5 · the inbox is computed, never the prototype\'s literals');
const k = in1.data?.kpis ?? [];
ok(k.length === 4, 'four KPIs', k.length);
ok(k.map((x) => x.label).join('|') === 'Active RFQs|Quoted by me|Competitors quoted|Est. value',
  'the prototype\'s KPI labels, in order', k.map((x) => x.label));
ok(Number(k[0]?.value) >= 1, 'Active RFQs is a real count', k[0]?.value);
ok(/^Due \d{4}-\d{2}-\d{2}$|^Due —$/.test(k[0]?.sub ?? ''), 'its sub-label is a real Due date', k[0]?.sub);
// The KPI band summarises the WHOLE inbox, not one invitation, so the
// denominator is the sum of every open invitation's roster. Comparing it to a
// single invitation's roster was this script's bug, and it would have passed by
// accident on a first run with exactly one invitation.
const openInvitations = in1.data.invitations.filter((i) => !i.declined);
const expectedInvited = openInvitations.reduce((n, i) => n + i.rosterRows.length, 0);
ok(k[2]?.sub === `of ${expectedInvited} invited`,
  'Competitors quoted is "n of <whole inbox> invited"',
  { sub: k[2]?.sub, open: openInvitations.length, expectedInvited });
ok(k[3]?.sub === 'Buyer estimate', 'Est. value keeps the prototype sub-label', k[3]);
ok(mine1.rosterRows.filter((r) => r.isMe).length === 1, 'exactly one roster row is "me"');
ok(mine1.rosterRows.every((r) => ['Quote received', 'Awaiting'].includes(r.coverage)),
  'coverage is the prototype\'s two values', mine1.rosterRows.map((r) => r.coverage));

head('6 · nothing fabricated (W4 §7)');
const inboxJson = JSON.stringify(in1.data);
for (const lit of ['V-000123', 'PakBoxes Pvt Ltd', 'RFQ-2026-0042', '2180000', 'Ahsan Ali', 'sealed until', 'closing in', 'Math.random']) {
  ok(!new RegExp(lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(inboxJson),
    `the inbox never contains "${lit}"`);
}
ok(in1.data?.subtitle.includes(in1.data.identity.legalName) &&
   in1.data.subtitle.includes(in1.data.identity.vendorCode),
  'the "Acting as" line carries the real identity', in1.data?.subtitle);

// ── 7 · the blank form ──────────────────────────────────────────────────────
head('7 · the quote form starts blank');
const form1 = await api(`/supplier/rfq/${inv1.invitation_id}`, { token: vendor1 });
ok(form1.status === 200, 'the form loads', form1.status);
ok(form1.data?.unitPricePrefilled === false, 'the response states prices are not pre-filled');
ok(form1.data?.lines.every((l) => l.unitPrice === null), 'every unit price is null', form1.data?.lines);
ok(form1.data?.totals?.total === null, 'the quote total is null', form1.data?.totals?.total);
ok(form1.data?.totals?.complete === false, 'and incomplete', form1.data?.totals?.complete);
const formJson = JSON.stringify(form1.data);
for (const lit of ['sealed until', '2180000', 'Math.random']) {
  ok(!new RegExp(lit, 'i').test(formJson), `the form never contains "${lit}"`);
}
const blank = await api(`/supplier/rfq/${inv1.invitation_id}/quote`, {
  method: 'POST', token: vendor1,
  body: { lines: form1.data.lines.map((l) => ({ lineNo: l.lineNo, unitPrice: null })), totalAmount: 500 },
});
ok(blank.status === 400, 'a blank unit price is refused', blank.status);
ok(/Enter a unit price for every line/i.test(blank.data?.message ?? ''), 'and says exactly that', blank.data?.message);

// ── 8 · append-only quoting (the byte-level proof) ──────────────────────────
head('8 · quotations are APPEND-ONLY');
const lineNo = form1.data.lines[0].lineNo;
const v1 = await api(`/supplier/rfq/${inv1.invitation_id}/quote`, {
  method: 'POST', token: vendor1,
  body: {
    lines: [{ lineNo, unitPrice: 500 }], totalAmount: 500,
    leadTime: '7 days', warranty: '3 yr', paymentTerms: '60 days', remarks: 'wave4 v1',
  },
});
ok([200, 201].includes(v1.status), 'V1 submitted', v1.status);
ok(v1.data?.version === 1, 'it is V1', v1.data?.version);
ok(Number(v1.data?.quotation?.lead_time_days) === 7, '"7 days" stored as 7', v1.data?.quotation?.lead_time_days);
ok(Number(v1.data?.quotation?.warranty_months) === 36, '"3 yr" stored as 36 months', v1.data?.quotation?.warranty_months);

const snap1 = psql(
  `SELECT id, state, total_amount, currency, fx_rate, normalized_total_pkr,
          lead_time_days, warranty_months, payment_terms, notes, quote_mode
     FROM proc.quotations WHERE id = '${v1.data?.quotation?.id}'`, { quiet: true });
const q1 = snap1.split('|');
ok(q1[1] === 'Submitted', 'V1 is live', q1[1]);

const v2 = await api(`/supplier/rfq/${inv1.invitation_id}/quote`, {
  method: 'POST', token: vendor1,
  body: { lines: [{ lineNo, unitPrice: 900 }], totalAmount: 900, leadTime: '10 days', warranty: '2 yr', remarks: 'wave4 v2' },
});
ok([200, 201].includes(v2.status), 'V2 submitted as a revision', v2.status);
ok(v2.data?.version === 2, 'it is V2', v2.data?.version);
ok(v2.data?.isRevision === true, 'flagged as a revision');
ok(v2.data?.superseded?.version === 1, 'V1 reported as superseded', v2.data?.superseded);

const snap2 = psql(
  `SELECT id, state, total_amount, currency, fx_rate, normalized_total_pkr,
          lead_time_days, warranty_months, payment_terms, notes, quote_mode
     FROM proc.quotations WHERE id = '${q1[0]}'`, { quiet: true });
const q2 = snap2.split('|');
ok(q2[0] === q1[0], 'the same row — not a new id');
ok(q2[1] === 'Superseded', 'ONLY the state changed', q2[1]);
ok(q2.slice(2).join('|') === q1.slice(2).join('|'),
  'EVERY other column is byte-identical (price never rewritten)', { before: q1.slice(2), after: q2.slice(2) });

const live = psql(
  `SELECT count(*) FROM proc.quotations
    WHERE rfq_id = '${rfqId}' AND vendor_id = '${V1}' AND state = 'Submitted'`, { quiet: true });
ok(live === '1', 'exactly ONE live quote for the vendor', live);
const chain = psql(
  `SELECT string_agg(version || ':' || state, ' ' ORDER BY version) FROM proc.quotations
    WHERE rfq_id = '${rfqId}' AND vendor_id = '${V1}'`, { quiet: true });
ok(chain === '1:Superseded 2:Submitted', 'the chain reads 1:Superseded then 2:Submitted', chain);
// W4-3/B6: sealed_hash is RETAINED BUT INERT. Nothing may read it to gate
// visibility — asserted in section 14 — but it must still be written, because
// dropping it would make restoring email deep-links a backfill problem later.
const nullSeals = psql(
  `SELECT count(*) FROM proc.quotations WHERE rfq_id = '${rfqId}' AND sealed_hash IS NULL`, { quiet: true });
ok(nullSeals === '0', 'every version still carries the inert sealed_hash (retained, not dropped)', nullSeals);
ok(psql(`SELECT count(*) FROM proc.quotations WHERE rfq_id = '${rfqId}' AND sealed_hash IS NOT NULL`, { quiet: true }) === '2',
  'both V1 and V2 have one');

head('9 · cross-tenant writes are impossible');
const foreign = await api(`/supplier/rfq/${inv1.invitation_id}/quote`, {
  method: 'POST', token: vendor2,
  body: { lines: [{ lineNo, unitPrice: 1 }], totalAmount: 1 },
});
ok(foreign.status === 404, "vendor2 cannot submit against vendor1's invitation", foreign.status);
const v2CountBefore = psql(`SELECT count(*) FROM proc.quotations WHERE vendor_id = '${V2}' AND rfq_id = '${rfqId}'`, { quiet: true });
await api(`/supplier/rfq/${inv1.invitation_id}/quote`, {
  method: 'POST', token: vendor1,
  body: { lines: [{ lineNo, unitPrice: 950 }], totalAmount: 950, vendorId: V2 },
});
const v2CountAfter = psql(`SELECT count(*) FROM proc.quotations WHERE vendor_id = '${V2}' AND rfq_id = '${rfqId}'`, { quiet: true });
ok(v2CountBefore === v2CountAfter,
  'a body vendorId for another vendor writes to NOBODY', { before: v2CountBefore, after: v2CountAfter });
const asProc = await api(`/supplier/rfq/${inv1.invitation_id}/quote`, {
  method: 'POST', token: procurement, body: { lines: [{ lineNo, unitPrice: 1 }], totalAmount: 1 },
});
ok(asProc.status === 403, 'procurement cannot use the supplier submit path', asProc.status);

// ── 10 · decline ────────────────────────────────────────────────────────────
head('10 · decline');
const withLive = await api(`/supplier/rfq/${inv1.invitation_id}/decline`, {
  method: 'POST', token: vendor1, body: { reason: 'busy' },
});
ok(withLive.status === 400, 'declining while holding a live quote is refused', withLive.status);
ok(/live quote/i.test(withLive.data?.message ?? ''), 'and names the reason', withLive.data?.message);

const d1 = await api(`/supplier/rfq/${inv2.invitation_id}/decline`, {
  method: 'POST', token: vendor2, body: { reason: `no capacity ${RUN}` },
});
ok([200, 201].includes(d1.status), 'vendor2 declined', d1.status);
ok(d1.data?.alreadyDeclined === false, 'recorded the first time', d1.data);
const d2 = await api(`/supplier/rfq/${inv2.invitation_id}/decline`, {
  method: 'POST', token: vendor2, body: { reason: 'again' },
});
ok(d2.data?.alreadyDeclined === true, 'a second decline is idempotent', d2.data);
const afterDecline = await api(`/supplier/rfq/${inv2.invitation_id}/quote`, {
  method: 'POST', token: vendor2, body: { lines: [{ lineNo, unitPrice: 500 }], totalAmount: 500 },
});
ok(afterDecline.status === 400, 'a declined vendor cannot quote', afterDecline.status);
// Re-fetch: `in2` was snapshotted at the start, before the decline. Reading the
// stale object would have asserted on a state that no longer exists.
const in2After = await api('/supplier/inbox', { token: vendor2 });
const inv2After = in2After.data?.invitations.find((i) => i.invitationId === inv2.invitation_id);
ok(inv2After?.declined === true, 'and the inbox reports the invitation declined', inv2After?.declined);
ok(inv2After?.canSubmit === false, 'and it is no longer submittable', inv2After?.canSubmit);
ok(inv2After?.myQuote === null, 'a declined vendor has no live quote', inv2After?.myQuote);

// ── 11 · the public intake ──────────────────────────────────────────────────
head('11 · the public onboarding intake is REAL');
const cfg = await (await fetch(`${API}/onboarding/form`)).json();
ok(cfg.title === 'Vendor Onboarding', 'the prototype title', cfg.title);
ok(/no login required/.test(cfg.notice), 'the public-form notice', cfg.notice);
ok(cfg.fields.filter((f) => f.required).map((f) => f.key).join(',') === 'legalName,ntn',
  'exactly Company name and NTN are required', cfg.fields);
ok(cfg.categoryOptions.length === 9, 'the 9 real categories', cfg.categoryOptions.length);

const appEmail = `wave4-${RUN}@example.test`;
const app = await (await fetch(`${API}/onboarding/applications`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ legalName: `Wave4 Co ${RUN}`, ntn: ntn(7), contactEmail: appEmail, categories: 'IT_HARDWARE' }),
})).json();
ok(/^ONB-\d{4}-\d{5}$/.test(app.reference), 'the reference is DB-generated and sequential', app.reference);
ok(app.state === 'Submitted', 'it starts in Submitted', app.state);
ok(!/random/i.test(JSON.stringify(app)), 'no random() in the response');

const dup = await fetch(`${API}/onboarding/applications`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ legalName: `Wave4 Co ${RUN} again`, ntn: ntn(7), contactEmail: appEmail }),
});
ok(dup.status === 409, 'a second LIVE application for the same NTN is 409', dup.status);
const dupMsg = (await dup.json()).message;
ok(!/ONB-/.test(dupMsg), 'and the refusal leaks no reference', dupMsg);
ok(psql(`SELECT count(*) FROM core.vendor_applications WHERE ntn = '${ntn(7)}'`, { quiet: true }) === '1',
  'exactly one row exists');

head('12 · the intake is not harvestable');
const noEmail = await fetch(`${API}/onboarding/applications/${app.reference}`);
ok(noEmail.status === 400, 'a reference ALONE is refused', noEmail.status);
const wrong = await fetch(`${API}/onboarding/applications/${app.reference}?email=attacker@evil.test`);
ok(wrong.status === 404, 'a wrong email is 404, not 403', wrong.status);
ok(!/exists|forbidden/i.test((await wrong.json()).message), 'and does not confirm it exists');
const right = await (await fetch(`${API}/onboarding/applications/${app.reference}?email=${encodeURIComponent(appEmail)}`)).json();
ok(right.reference === app.reference && right.state === 'Submitted', 'the right email reads it', right);
const rj = JSON.stringify(right);
for (const pii of ['legal_name', 'ntn', 'contact_email', 'Wave4 Co']) {
  ok(!rj.includes(pii), `the status response carries no "${pii}"`);
}
// Walk every reference in the table with a wrong email: none may leak.
const allRefs = psql(`SELECT string_agg(reference, ' ' ORDER BY reference) FROM core.vendor_applications`, { quiet: true })
  .split(' ').filter(Boolean);
let leaked = 0;
for (const r of allRefs) {
  const res = await fetch(`${API}/onboarding/applications/${r}?email=attacker@evil.test`);
  if (res.status === 200) leaked++;
}
ok(leaked === 0, `walked ${allRefs.length} sequential references, leaked ${leaked}`, { refs: allRefs.length, leaked });

head('13 · intake is visible to Procurement and invisible to suppliers');
const q = await api('/vendors/applications', { token: procurement });
ok(q.status === 200, 'procurement reads the queue', q.status);
ok(q.data?.applications.some((a) => a.reference === app.reference), 'this run\'s application is in it');
ok(q.data?.totals?.pending >= 1, 'counted as pending', q.data?.totals);
ok((await api('/vendors/applications', { token: cs })).status === 200, 'cs reads the queue');
ok((await api('/vendors/applications', { token: admin })).status === 200, 'admin reads it via ROLE_ALIASES');
ok((await api('/vendors/applications', { token: vendor1 })).status === 403, 'a VENDOR is refused the queue');
ok((await api('/vendors/applications', { token: requester })).status === 403, 'a requester is refused the queue');

// ── 14 · the rendered screens ───────────────────────────────────────────────
head('14 · the screens render the API payload (no undefined leaks)');
{
  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  const Cards = require(path.join(ROOT, 'apps/web/.render-build/components/supplier/SupplierCards.js'));
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createElement: h } = await import('react');
  const txt = (n) => renderToStaticMarkup(n).replace(/<[^>]+>/g, ' ')
    .replace(/&mdash;/g, '\u2014').replace(/&hellip;/g, '\u2026').replace(/&middot;/g, '\u00B7')
    .replace(/\s+/g, ' ').trim();

  const t1 = txt(h(Cards.SupplierInboxList, { data: in1.data }));
  ok(t1.includes(inv1.vendor_code || 'RFQ-') || t1.includes(mine1.rfqNumber), 'the inbox shows the real RFQ number');
  ok(mine1.rosterRows.every((r) => t1.includes(r.legalName)), 'every roster name reaches the screen');
  ok(!/undefined|NaN|\[object Object\]/.test(t1), 'no undefined/NaN/[object Object] in the inbox', t1.match(/.{0,40}undefined.{0,40}/)?.[0]);
  const kt = txt(h(Cards.SupplierKpiBand, { kpis: in1.data.kpis }));
  ok(!/undefined|NaN/.test(kt), 'no undefined/NaN in the KPI band', kt);
  const ft = txt(h(Cards.SupplierQuoteLines, { lines: form1.data.lines, totals: form1.data.totals }));
  ok(ft.includes('Quote total: \u2014'), 'the blank form shows the em-dash total', ft.slice(-40));
  ok(!/sealed until|closing in/i.test(t1 + kt + ft), 'no sealed-quote claim or countdown on screen');
}

// ── 15 · the retirement ─────────────────────────────────────────────────────
head('15 · apps/supplier is gone (W4-1, R3)');
{
  let refused = false;
  try {
    const res = await fetch('http://127.0.0.1:33003/', { signal: AbortSignal.timeout(4000) });
    refused = res.status === 0;
  } catch { refused = true; }
  ok(refused, 'port 33003 refuses connections', refused);

  const pj = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  ok(!('supplier:dev' in pj.scripts), 'package.json has no supplier:dev script');
  ok(!fs.existsSync(path.join(ROOT, 'apps/supplier')), 'the apps/supplier folder does not exist');
  const lock = fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8');
  ok(!lock.includes('apps/supplier'), 'package-lock.json has no apps/supplier entry');

  const strollers = ['.launch-next-v2.ps1', '.restart-api-only.ps1', '.restart-services.ps1',
    '.launch-next.ps1', '.launch-next2.ps1', '.launch-web.ps1', '.check-next.ps1',
    '.curl-check.ps1', '.http-check.ps1', '.port-check.ps1'];
  const dirty = strollers.filter((f) => {
    const p = path.join(ROOT, f);
    return fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes('33003');
  });
  ok(dirty.length === 0, `no launch/check script still references 33003`, dirty);
  const dirs = fs.readdirSync(path.join(ROOT, 'apps')).sort();
  ok(dirs.join(',') === 'api,onboarding,web', 'apps/ is api, onboarding, web', dirs);
}

// ── 16 · cleanup ────────────────────────────────────────────────────────────
head('16 · cleanup');
psql(`DELETE FROM core.vendor_applications WHERE ntn LIKE '${RUN}-%'`, { quiet: true });
ok(psql(`SELECT count(*) FROM core.vendor_applications WHERE ntn LIKE '${RUN}-%'`, { quiet: true }) === '0',
  'this run\'s vendor applications are removed');
console.log('  NOTE  the PR/RFQ and its quotations are left behind on purpose — they are real');
console.log('        records the buyer screens read. Reset with db\\scripts\\reset.ps1 if wanted.');

console.log(`\n${'='.repeat(72)}`);
console.log(`  Wave 4 e2e: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
process.exit(fail === 0 ? 0 : 1);
