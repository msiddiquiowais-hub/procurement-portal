// Wave 4 step 4 — the API/UI contract check (`npm run e2e:render_contract`).
//
// Closes the gap the other two suites leave open.
//
//   test:api   proves the API returns the right VALUES.
//   test:web   proves the components render the right MARKUP, from fixtures
//              built by hand.
//
// Neither proves the two agree on the SHAPE. A renamed field in SupplierService
// would still pass 86 API assertions (they read r.data.quotation.*) and all 48
// render assertions (they build their own InboxData), while the real page
// rendered `undefined` for the missing key.
//
// So: fetch the LIVE API as a vendor, render the REAL component with that exact
// payload, and assert the screen shows what the API sent — including that no
// field leaks `undefined`, `NaN` or `[object Object]` into the markup.
//
// Requires a fresh database (`npm run db:reset:ps`) and the API + web running,
// because the fixtures it creates are real RFQs and real quotations.
import { execFileSync } from 'child_process';
import path from 'path';
import { createRequire } from 'module';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';

const require = createRequire(import.meta.url);
const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const BUILD = path.join(process.cwd(), 'apps/web/.render-build/components/supplier/SupplierCards.js');

const C = require(BUILD);

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
  if (c) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''}`); }
};

const text = (node) => renderToStaticMarkup(node)
  .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
  .replace(/&mdash;/g, '\u2014')
  .replace(/&hellip;/g, '\u2026')
  .replace(/&times;/g, '\u00D7')
  .replace(/&middot;/g, '\u00B7')
  .replace(/\s+/g, ' ').trim();

async function api(p, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  let d = null; try { d = t ? JSON.parse(t) : null; } catch { d = { raw: t }; }
  return { status: res.status, data: d };
}

const login = async (email) => (await api('/auth/login', { method: 'POST', body: { email, password: 'demo' } })).data?.token;
const psql = (sql) => execFileSync('docker', ['exec', '-i', 'procurement-portal-db', 'psql', '-U', 'proc',
  '-d', 'procurementDB', '-X', '-t', '-A', '-q', '-f', '-'], { input: sql, encoding: 'utf8' }).trim();

const LAPTOP = '55555555-5555-5555-5555-555555555503';
const ME_VENDOR = '44444444-4444-4444-4444-444444444401';
const DASH = '\u2014';
const MIDDOT = '\u00B7';

console.log('=== fixture: a PR in procurement review, issued to the supplier ===');
const requester = await login('requester@pakboxes.pk');
const procurement = await login('procurement@pakboxes.pk');
const hod = await login('hod.sales@pakboxes.pk');
const vendor1 = await login('vendor1@example.com');
ok(!!requester && !!procurement && !!hod && !!vendor1, 'sessions authenticated');

const ccs = await api('/lookups/cost-centers', { token: requester });
const created = await api('/pr', {
  method: 'POST', token: requester,
  body: {
    scope: 'Render contract probe', expenseType: 'OPEX', costCenterId: ccs.data?.[0]?.id,
    requiredByDate: '2026-12-31', title: 'Render contract',
    // quantity 1 x 50,000 stays under the 100,000 IT ceiling, so the line is
    // not rerouted to the IT Manager (same fixture as the Wave 2 e2e).
    lines: [{ itemId: LAPTOP, quantity: 1, uom: 'EA', unitPriceEst: 50_000 }],
  },
});
const prId = created.data?.id;
await api(`/pr/${prId}/advance`, {
  method: 'POST', token: hod, body: { lineDecisions: { 0: 'approved' }, reason: 'probe' },
});
const issued = await api(`/pr/${prId}/rfq`, { method: 'POST', token: procurement, body: {} });
const rfqId = issued.data?.rfq?.id;
const mine = (issued.data?.invitations ?? []).find((i) => i.vendor_id === ME_VENDOR);
ok(!!rfqId && !!mine, 'RFQ issued and this vendor invited', { rfqId, invited: !!mine });
if (!rfqId || !mine) { console.log('fixture failed, stopping'); process.exit(1); }

console.log('\n=== the LIVE API payload renders through the REAL component ===');
const inbox = await api('/supplier/inbox', { token: vendor1 });
ok(inbox.status === 200, 'inbox 200', inbox.status);

// No hand-built fixture: this is the exact object the page hands to the card.
const t = text(h(C.SupplierInboxList, { data: inbox.data }));

console.log('        rendered: ' + t.slice(0, 200) + '...');
ok(t.includes(inbox.data.invitations[0].rfqNumber), "the API's rfqNumber reaches the screen");
// The subtitle is rendered by <Shell>, not by SupplierInboxList - the page
// passes it straight through. So the contract to pin is that the API sends the
// prototype's "Acting as <name> <middot> <code>" line with the REAL identity.
// This is the only place a supplier's own name appears, and no render test
// covers it, because it belongs to Shell.
ok(
  new RegExp(`^Acting as .+ ${MIDDOT} V-\\d+$`).test(inbox.data.subtitle),
  "the subtitle is the prototype's \"Acting as <legal_name> \u00B7 <vendor_code>\"",
  inbox.data.subtitle,
);
ok(
  inbox.data.subtitle.includes(inbox.data.identity.legalName) &&
  inbox.data.subtitle.includes(inbox.data.identity.vendorCode),
  'and it carries the real identity, not the prototype literal',
  { subtitle: inbox.data.subtitle, identity: inbox.data.identity },
);
ok(t.includes(inbox.data.invitations[0].invitedLabel), "the API's invitedLabel reaches the screen");
ok(inbox.data.invitations[0].rosterRows.every((r) => t.includes(r.legalName)),
  'every roster legal_name from the API is on screen', inbox.data.invitations[0].rosterRows.map((r) => r.legalName));
ok(t.includes('Quote now'), "the prototype's row action is rendered");

console.log('\n--- no field silently renders "undefined" ---');
ok(!/undefined/.test(t), 'no "undefined" anywhere in the rendered inbox', t.match(/.{0,40}undefined.{0,40}/)?.[0]);
ok(!/\[object Object\]/.test(t), 'no "[object Object]"');
ok(!/\bNaN\b/.test(t), 'no NaN');

console.log('\n--- the KPI band from the live payload ---');
const kt = text(h(C.SupplierKpiBand, { kpis: inbox.data.kpis }));
for (const k of inbox.data.kpis) {
  ok(kt.includes(k.label) && kt.includes(k.value) && kt.includes(k.sub),
    `${k.label} renders its API value/sub`, { label: k.label, value: k.value, sub: k.sub });
}
ok(!/undefined|NaN/.test(kt), 'the KPI band has no undefined/NaN', kt);

console.log('\n=== the quote form, with the API\'s real blank prices ===');
const form = await api(`/supplier/rfq/${mine.invitation_id}`, { token: vendor1 });
ok(form.status === 200, 'quote form 200', form.status);
const ft = text(h(C.SupplierQuoteLines, { lines: form.data.lines, totals: form.data.totals }));
console.log('        rendered: ' + ft.slice(0, 200));
ok(ft.includes(`Quote total: ${DASH}`), 'a blank form shows the em-dash total, not PKR 0');
ok(!/undefined|NaN/.test(ft), 'no undefined/NaN on the quote screen', ft.match(/.{0,40}(undefined|NaN).{0,40}/)?.[0]);
ok(form.data.lines.every((l) => ft.includes(l.description)), 'every real line description is on screen',
  form.data.lines.map((l) => l.description));

console.log('\n--- after a REAL submission, the screen reflects the version chain ---');
const lineNo = form.data.lines[0].lineNo;
const sub = await api(`/supplier/rfq/${mine.invitation_id}/quote`, {
  method: 'POST', token: vendor1,
  body: { lines: [{ lineNo, unitPrice: 500 }], totalAmount: 500, leadTime: '7 days', warranty: '3 yr', paymentTerms: '60 days' },
});
ok([200, 201].includes(sub.status), 'V1 submitted', sub.status);
ok(sub.data?.version === 1, 'it is V1', sub.data?.version);

const form2 = await api(`/supplier/rfq/${mine.invitation_id}`, { token: vendor1 });
const ft2 = text(h(C.SupplierQuoteLines, { lines: form2.data.lines, totals: form2.data.totals }));
ok(ft2.includes('Quote total: PKR'), 'a fully priced form now shows a real total', ft2.slice(-60));
ok(!/undefined|NaN/.test(ft2), 'still no undefined/NaN');

const ct = text(h(C.SupplierCommercialTerms, {
  values: { totalAmount: 500, leadTime: '7 days', warranty: '3 yr', paymentTerms: '60 days', remarks: '' },
}));
ok(ct.includes('Submission is recorded in the audit trail.'), "the prototype's audit hint renders");
ok(!/undefined/.test(ct), 'the terms card has no undefined');

console.log('\n--- and the inbox reflects the submission ---');
const inbox2 = await api('/supplier/inbox', { token: vendor1 });
const inv2 = inbox2.data.invitations.find((i) => i.invitationId === mine.invitation_id);
const t2 = text(h(C.SupplierInboxList, { data: inbox2.data }));
ok(inv2?.myQuote?.version === 1, 'the API reports my V1', inv2?.myQuote);
ok(t2.includes('V1 submitted'), 'and the screen shows the V1 pill');
ok(inbox2.data.kpis[1].value === 'Yes', 'the "Quoted by me" KPI flipped to Yes', inbox2.data.kpis[1]);

console.log(`\n=== render contract: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
