// verify_reissue_ui.mjs — browser proof for Task 4's SHARED dialog.
//
//   node scripts/verify_reissue_ui.mjs
//
// WHY A BROWSER SUITE AND NOT MORE API ASSERTIONS
// -----------------------------------------------
// e2e_rfq_reissue.mjs proves the endpoint behaves. This proves the SCREEN, and
// the screen is where Task 4 actually lives: one button whose LABEL changes,
// one dialog whose title changes, and a roster that must render the
// already-invited vendors as locked rather than offering a tick that invites
// nobody. A green API with a dialog that still says "Issue RFQ" on a PR that
// already has an RFQ is the exact regression worth catching.

import { chromium } from 'playwright';
import { execFileSync } from 'child_process';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const WEB = process.env.WEB_BASE || 'http://127.0.0.1:33002';

let pass = 0, fail = 0;
const check = (cond, label, detail) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`); }
};

async function login(email) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'demo' }),
  });
  if (!r.ok) throw new Error(`login failed for ${email}: ${r.status}`);
  return r.json();
}

// ── fixture ──────────────────────────────────────────────────────────────────
// A PR that has reached procurement AND carries a live RFQ, so the dialog opens
// directly in re-issue mode. Reuses the laptop item so the HOD line rules route
// it to IN_PROCUREMENT_REVIEW rather than the IT-review detour.
const LAPTOP = '55555555-5555-5555-5555-555555555503';

const requesterSession = await login('requester@pakboxes.pk');
const hodSession = await login('hod.sales@pakboxes.pk');
const procSession = await login('procurement@pakboxes.pk');
// The login response IS the session (token + user). LocalStorage wants the whole
// object; the Authorization header wants only the token. Passing the session
// object where a bearer string is expected yields a literal "invalid token".
const requester = requesterSession.token;
const hod = hodSession.token;
const proc = procSession.token;

const hdr = (t) => ({ 'content-type': 'application/json', authorization: `Bearer ${t}` });
const call = async (path, { method = 'GET', token, body } = {}) => {
  const r = await fetch(API + path, {
    method, headers: hdr(token), ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: r.status, data };
};

const ccs = await call('/lookups/cost-centers', { token: requester });
const costCenterId = ccs.data?.[0]?.id;
const created = await call('/pr', {
  method: 'POST', token: requester,
  body: {
    scope: 'Re-issue UI', expenseType: 'OPEX', costCenterId,
    requiredByDate: '2026-12-31', title: 'Laptop — shared dialog fixture',
    description: 'One dialog, two labels.',
    lines: [{ itemId: LAPTOP, quantity: 1, uom: 'EA', unitPriceEst: 50_000 }],
  },
});
const prId = created.data?.id;
if (!prId) { console.error('fixture PR not created', created.data); process.exit(1); }
// POST /pr answers with the id only, so the number comes from the PR itself.
// Referencing `created.data.pr_number` here would print "undefined" and then
// silently find no row on the grid at the end.
const pr = await call(`/pr/${prId}`, { token: proc });
const prNumber = pr.data?.pr_number;
await call(`/pr/${prId}/advance`, {
  method: 'POST', token: hod,
  body: { lineDecisions: { 0: 'approved' }, reason: 'HOD approves' },
});
const cands = await call(`/pr/${prId}/rfq/candidates`, { token: proc });
const pool = cands.data?.vendors || [];
const issued = await call(`/pr/${prId}/rfq`, {
  method: 'POST', token: proc,
  body: { vendorIds: pool.slice(0, 2).map(v => v.id) },
});
if (!issued.data?.rfq?.id) { console.error('fixture RFQ not issued', issued.data); process.exit(1); }
const rfqNumber = issued.data.rfq.rfq_number;

console.log(`\n=== Issue/Re-issue shared dialog against ${WEB} ===\n`);
console.log(`  fixture PR ${prNumber} · RFQ ${rfqNumber} · 2 vendors invited`);

// ── the page ─────────────────────────────────────────────────────────────────
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
// The URL matters: a bare "400 Bad Request" says nothing about WHICH call, and
// on this page several endpoints answer 400 by design.
const badResponses = [];
page.on('response', async (r) => {
  if (r.status() >= 400) {
    let body = '';
    try { body = (await r.text()).slice(0, 200); } catch { /* body already consumed */ }
    badResponses.push(`${r.status()} ${r.request().method()} ${r.url()} :: ${body}`);
  }
});
// The PR page calls endpoints that answer 400 by design once the PR is past its
// sourcing stage, so a non-2xx is only a failure while we are on the
// in-procurement fixture. Reset the list before visiting the forwarded PR.
const resetBad = () => { badResponses.length = 0; };

await page.addInitScript((s) => { window.localStorage.setItem('pk_session', JSON.stringify(s)); }, procSession);
await page.goto(`${WEB}/pr/${prId}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.btn', { timeout: 30000 });

// The button text carries the prototype's SVG glyph, which `innerText` reports
// on its own line ("↥\nRe-issue RFQ"). Stripping a LEADING glyph keeps the
// hyphen in "Re-issue" — normalising the whole string would turn the label into
// "Re issue RFQ" and make the comparison about punctuation, not about which
// action the button offers.
const labelOf = (t) => t.replace(/^[^\w]+/, '').replace(/\s+/g, ' ').trim();

/** Read-only DB probe: find a real PR on the estate to drive the gate with. */
function psql(sql) {
  return execFileSync('docker', ['exec', '-i', 'procurement-portal-db', 'psql',
    '-U', 'proc', '-d', 'procurementDB', '-q', '-t', '-A', '-F', '|', '-f', '-'],
    { input: sql, encoding: 'utf8' }).trim();
}
const labels = (await page.$$eval('.btn', (b) => b.map(x => x.innerText.trim()))).map(labelOf);
console.log('  action bar:', labels.join(' | '));

// ── the label is the whole point of Task 4 ───────────────────────────────────
check(labels.filter(t => t === 'Re-issue RFQ').length === 1,
  'the button reads "Re-issue RFQ" on a PR that has an RFQ', labels);
check(labels.filter(t => t === 'Issue RFQ').length === 0,
  'and NOT "Issue RFQ" — the two are mutually exclusive labels', labels);

// ── it opens the SAME dialog ─────────────────────────────────────────────────
const reissueBtn = page.locator('.btn', { hasText: 'Re-issue RFQ' }).first();
await reissueBtn.click();

// Everything below is scoped to [data-rfq-dialog]. The PR page renders its own
// cards with the same .card-h / .card-b / table.t classes, so an unscoped
// `.card-h h3` or `.card-b table.t tbody tr` silently reads the PAGE HEADER
// instead of the dialog — which is how "the dialog retitles itself" can pass
// while asserting the page's own <h3>PR-2026-201420</h3>.
const D = '[data-rfq-dialog] ';
// Wait for the header CONTROLS, not the heading. The <h3> renders on the very
// first paint, before /rfq/candidates has answered, so waiting on it asserts
// the placeholder rather than the resolved dialog. The Send button only exists
// once `cands` is set, so it is the honest readiness signal.
await page.waitForSelector(`${D}.card-h .btn.primary`, { timeout: 20000 });

const title = (await page.textContent(`${D}.card-h h3`))?.trim();
check(/^Re-issue RFQ — /.test(title || ''), 'the dialog retitles itself for the re-issue', title);
check((title || '').includes(rfqNumber), 'and names the RFQ it will top up', title);

// ── the current roster renders as LOCKED ─────────────────────────────────────
// This is the anti-duplication property at the UI level: a tickable box for a
// vendor already invited would be a control that silently does nothing.
//
// The two tables are addressed by their OWN data-roster attribute, and the
// reason matters: filtering on `checkbox.disabled` conflates THREE different
// disabled rows — already-invited, WITHHELD (high-risk / on hold /
// blacklisted), and anything else the dialog locks out. The withheld table
// shares the same `table.t` classes, so a class-based selector counted a
// blocked vendor as an "already invited" one and made this pass for the wrong
// reason on one count and fail on the other.
const readRoster = (which) => page.$$eval(
  `${D}table[data-roster="${which}"] tbody tr`,
  (trs) => trs.map((tr) => ({
    name: (tr.querySelectorAll('td')[1]?.innerText || '').trim(),
    checked: tr.querySelector('input[type=checkbox]')?.checked,
    disabled: tr.querySelector('input[type=checkbox]')?.disabled,
  })),
);
const locked = await readRoster('current');

check(locked.length === 2, 'both already-invited vendors render', locked.map(r => r.name));
check(locked.every(r => r.checked && r.disabled),
  'each is shown TICKED and locked — the prototype\'s previouslySelected, made honest',
  locked.map(r => ({ n: r.name, checked: r.checked, disabled: r.disabled })));

// ── the pickable list excludes them ──────────────────────────────────────────
// The addable table carries BOTH the tickable candidates and the WITHHELD rows
// (V-00084 KarachiTech is High-risk), so "addable" does not mean "enabled".
// The property that matters is not that every row is tickable — it is that any
// row which cannot be ticked says WHY, so the buyer is never left guessing at a
// grey box.
const addableRows = await page.$$eval(
  `${D}table[data-roster="addable"] tbody tr`,
  (trs) => trs.map((tr) => ({
    name: (tr.querySelectorAll('td')[1]?.innerText || '').trim(),
    checked: tr.querySelector('input[type=checkbox]')?.checked,
    disabled: tr.querySelector('input[type=checkbox]')?.disabled,
    title: tr.querySelector('input[type=checkbox]')?.title || '',
  })),
);
const pickable = addableRows.filter(r => !r.disabled);
const lockedOut = addableRows.filter(r => r.disabled);

check(pickable.length > 0, 'there are still vendors to ADD', pickable.length);
check(!pickable.some(r => locked.some(l => l.name === r.name)),
  'an already-invited vendor is never offered again as pickable',
  { locked: locked.map(r => r.name), pickable: pickable.map(r => r.name) });
check(lockedOut.every(r => /High risk|on hold|Blacklisted|Lifecycle state/i.test(r.title)),
  'every row that cannot be ticked states the rule that blocked it',
  lockedOut.map(r => ({ n: r.name, title: r.title })));

// ── Send counts NEW vendors, and starts disabled ─────────────────────────────
const send = await page.textContent(`${D}.card-h .btn.primary`);
check(/Re-issue — add 0 vendor/.test(send || ''),
  'the Send button counts what this action ADDS, not the whole roster', send);
check(await page.locator(`${D}.card-h .btn.primary`).isDisabled(),
  'and is disabled until a new vendor is ticked');

await page.locator(`${D}table[data-roster="addable"] input[type=checkbox]:not(:disabled)`).first().check();
const send2 = await page.textContent(`${D}.card-h .btn.primary`);
check(/Re-issue — add 1 vendor$/.test(send2 || ''), 'ticking one updates it to "add 1 vendor"', send2);
check(!(await page.locator(`${D}.card-h .btn.primary`).isDisabled()),
  'and enables the action');

await page.screenshot({ path: process.env.SHOT || 'var/verify_reissue_ui.png' });

// ── the deadline carries over, not a fresh default ──────────────────────────
const deadline = await page.inputValue(`${D}.card-h input[type=date]`);
check(Boolean(deadline), 'the dialog pre-fills the existing quote deadline', deadline);

// ── performing it ────────────────────────────────────────────────────────────
await page.click(`${D}.card-h .btn.primary`);
await page.waitForSelector('.alert.success', { timeout: 30000 });
const done = (await page.textContent('.alert.success')) || '';
check(/re-issued/i.test(done), 'the confirmation says the RFQ was re-issued', done);
check(/1 vendor\(s\) added/.test(done), 'and how many vendors were added', done);

// ── the grid's own STATUS column now shows the chip ──────────────────────────
await page.goto(`${WEB}/my-prs`, { waitUntil: 'networkidle' });
await page.waitForSelector('table.t tbody tr', { timeout: 30000 });
const prRow = page.locator('table.t tbody tr', { hasText: prNumber }).first();
  const cellText = (await prRow.innerText()).replace(/\s+/g, ' ');
  check(/Re-issued/.test(cellText),
    'the my-prs STATUS column shows the Re-issued chip for this PR', cellText.slice(0, 200));

  // ── THE READ-ONLY BANNER AND THE WAY ONWARD ─────────────────────────────────
  // Two defects this audit found, both on PRs whose stage has no inline action
  // bar — all 221 Wave-3 governance PRs. They used to render "Stage owner is
  // system" (wrong: CS and MC own them) and offered no route forward at all.
  const governance = psql(
    `SELECT pr.id || '|' || pr.pr_number || '|' || pr.status
       FROM proc.purchase_requisitions pr
      WHERE pr.status IN ('QUOTES_RECEIVED','CS_LOCKED','MC_APPROVED','CFO_APPROVED','PACK_LOCKED')
      ORDER BY pr.created_at DESC LIMIT 1;`,
  );
  if (!governance) {
    console.log('  note  no governance PR right now — banner/route assertions skipped');
  } else {
    const [gId, gNo, gStage] = governance.split('|');
    console.log(`  note  probing ${gNo} (stage ${gStage})`);

    await resetBad();
    await page.goto(`${WEB}/pr/${gId}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.btn', { timeout: 30000 });

    const banner = (await page.textContent('body')) || '';
    check(!/Stage owner is\s*system/i.test(banner),
      'the read-only banner does NOT claim the stage owner is "system"', { stage: gStage });

    // The route onward must exist, and must point at a screen that exists.
    const routeHref = await page.$$eval('.btn-row a.btn', (as) =>
      as.map((a) => ({ href: a.getAttribute('href'), text: a.innerText.trim() })));
    const next = routeHref.find((a) => /\/(cs|mc|cfo|pack)\//.test(a.href || ''));
    check(Boolean(next), 'a governance PR offers a route onward', routeHref);

    if (next) {
      const target = next.href.replace(/^.*\/pr\//, '/');
      const res = await page.goto(`${WEB}${target}`, { waitUntil: 'networkidle' });
      check(Boolean(res) && !page.url().endsWith('/pr'),
        `that route resolves rather than bouncing: ${next.text} -> ${target}`, page.url());
    }
  }

  // Back on the grid for the chip assertion's screenshot.
  await resetBad();
  await page.goto(`${WEB}/my-prs`, { waitUntil: 'networkidle' });

// ── THE CHAIN-OF-CUSTODY GATE, ON THE SCREEN ────────────────────────────────
// The API refuses a re-issue once the PR leaves IN_PROCUREMENT_REVIEW, and the
// server is the real gate. But a control the API enforces while the UI still
// offers the button is a control the buyer learns to work around — so the button
// itself must not be there.
//
// Driven against a real PR already on the estate that carries an RFQ and sits
// PAST procurement, which is the exact shape the gate exists for.
const forwarded = psql(
  `SELECT pr.id || '|' || pr.pr_number || '|' || pr.status
     FROM proc.purchase_requisitions pr
     JOIN proc.rfq rf ON rf.pr_id = pr.id AND rf.state <> 'Cancelled'
    WHERE pr.status NOT IN ('IN_PROCUREMENT_REVIEW','READY_FOR_D365')
      AND pr.status NOT IN ('D365_PUSHED','CLOSED','FULFILLED_FROM_STOCK','REJECTED')
    ORDER BY pr.created_at DESC LIMIT 1;`,
);
if (!forwarded) {
  console.log('  note  no forwarded PR with an RFQ right now — button gate not exercised');
} else {
  const [fwdId, fwdNo, fwdStage] = forwarded.split('|');
  console.log(`  note  probing ${fwdNo} (stage ${fwdStage}) as the forwarded case`);

  await resetBad();
  await page.goto(`${WEB}/pr/${fwdId}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.btn', { timeout: 30000 });

  const fwdLabels = (await page.$$eval('.btn', (b) => b.map(x => x.innerText.trim())))
    .map(labelOf);
  console.log('  forwarded action bar:', fwdLabels.join(' | '));

  check(!fwdLabels.includes('Re-issue RFQ'),
    `no "Re-issue RFQ" button exists on a PR at ${fwdStage}`, fwdLabels);
  check(!fwdLabels.includes('Issue RFQ'),
    'and no "Issue RFQ" either — the PR is past its sourcing stage', fwdLabels);

  // Opening the dialog must not be possible by any other route: the candidates
  // endpoint that feeds it is gated too, so the button and the data agree.
  const fwdDialogs = await page.$$eval('[data-rfq-dialog]', (d) => d.length).catch(() => 0);
  check(fwdDialogs === 0, 'no Issue/Re-issue dialog can be opened', fwdDialogs);
}

check(consoleErrors.length === 0, 'no console errors on any screen', consoleErrors.slice(0, 4));
// Named separately from consoleErrors: this page calls endpoints that answer
// 400 BY DESIGN on some paths, so the useful signal is which call failed, not
// merely that one did.
if (badResponses.length) console.log('  note  non-2xx responses seen:', JSON.stringify(badResponses, null, 1));
check(badResponses.length === 0, 'no non-2xx response on either screen', badResponses.slice(0, 3));

await browser.close();
console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
if (fail > 0) process.exit(1);