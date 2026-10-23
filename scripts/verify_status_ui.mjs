// verify_status_ui.mjs — browser proof that the STATUS column actually renders.
//
// The API suite proves the data; this proves the SCREEN. A green API response
// with a column that silently fails to render is the failure mode that a
// JSON-level assertion cannot see.

import { chromium } from 'playwright';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const WEB = process.env.WEB_BASE || 'http://127.0.0.1:33002';

let pass = 0, fail = 0;
const check = (cond, label, detail) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`); }
};

const lr = await fetch(`${API}/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@pakboxes.pk', password: 'demo' }),
});
if (!lr.ok) { console.error(`login failed: ${lr.status}`); process.exit(1); }
const session = await lr.json();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

// Counted so the tab test can prove filtering does not hit the network.
const apiRequests = [];
page.on('request', (r) => {
  if (r.url().includes('/api/') || r.url().includes(':33001')) apiRequests.push(r.url());
});

await page.addInitScript((s) => { window.localStorage.setItem('pk_session', JSON.stringify(s)); }, session);
await page.goto(`${WEB}/my-prs`, { waitUntil: 'networkidle' });
await page.waitForSelector('table.t tbody tr', { timeout: 30000 });

const headers = await page.$$eval('table.t thead th', (ths) => ths.map((t) => t.textContent.trim()));
console.log('\n  headers:', headers.join(' | '));

const statusIdx = headers.indexOf('Status');
check(statusIdx >= 0, 'a STATUS column exists in the grid', headers);

{
  // It must sit AFTER Stage, so the row reads: what -> where in approval ->
  // where in sourcing -> when it moved.
  const stageIdx = headers.indexOf('Stage');
  check(stageIdx >= 0 && statusIdx === stageIdx + 1, 'STATUS sits immediately after Stage', { stageIdx, statusIdx });

  const cells = await page.$$eval('table.t tbody tr', (rows, idx) =>
    rows.map((r) => (r.querySelectorAll('td')[idx]?.innerText || '').trim()),
  statusIdx);

  const nonEmpty = cells.filter((c) => c.length > 0);
  check(nonEmpty.length === cells.length, 'every row renders a status', nonEmpty.length + '/' + cells.length);

  const kinds = [...new Set(nonEmpty.map((c) => {
    if (c === '—') return 'Pre-procurement (em-dash)';
    if (/RFQ overdue/i.test(c)) return 'RFQ overdue';
    if (/Received \(threshold met\)/i.test(c)) return 'Received (threshold met)';
    // The post-RFQ governance lifecycle. ORDER MATTERS: these must be matched
    // before the /^Received/ rule below, because "Quotes received" would
    // otherwise be swallowed by it and silently relabelled "Received" — which
    // is exactly the kind of quiet mis-classification this guard exists to
    // prevent.
    if (/^Quotes received/i.test(c)) return 'Quotes received';
    if (/Comparative statement locked/i.test(c)) return 'CS locked';
    if (/^MC approved/i.test(c)) return 'MC approved';
    if (/^CFO approved/i.test(c)) return 'CFO approved';
    if (/^Pack locked/i.test(c)) return 'Pack locked';
    if (/^Received/i.test(c)) return 'Received';
    if (/^Expired/i.test(c)) return 'Expired';
    if (/Awaiting Quotes/i.test(c)) return 'Awaiting Quotes';
    if (/Not dispatched/i.test(c)) return 'Not dispatched';
    if (/not issued/i.test(c)) return 'RFQ not issued';
    return 'UNRECOGNISED: ' + c;
  }))];
  console.log('\n  rendered status kinds:', kinds.join(' | '));
  check(!kinds.some((k) => k.startsWith('UNRECOGNISED')), 'every status maps to a known label', kinds);

  // ── THE STAGE / STATUS SEPARATION ────────────────────────────────────────
  // The load-bearing property of this change: the two columns answer different
  // questions, and neither borrows the other's vocabulary.
  //
  // The STAGE column answers "whose desk is this on?". The STATUS column answers
  // "how far through sourcing is this?". Before the split, 221 PRs rendered
  // "Pack locked" / "Quotes received" in the STAGE column and a red "Expired"
  // pill in the STATUS column — a progress verb in the departmental column and a
  // false alarm on awarded work.
  const stageCells = await page.$$eval('table.t tbody tr', (rows, idx) =>
    rows.map((r) => (r.querySelectorAll('td')[idx]?.innerText || '').trim()),
  stageIdx);
  const stageKinds = [...new Set(stageCells)];
  console.log('\n  rendered stage kinds:', stageKinds.join(' | '));

  // Nothing in the STAGE column may be a progress verb.
  const PROGRESS_VERBS = [
    /^quotes received/i, /comparative statement locked/i, /^cs locked/i,
    /^mc approved/i, /^cfo approved/i, /^pack locked/i, /^pushed to d365/i,
    /fulfilled from stock/i,
  ];
  const leaked = stageKinds.filter(s => PROGRESS_VERBS.some(re => re.test(s)));
  check(leaked.length === 0,
    'the STAGE column never renders a progress marker', leaked);

  // …and every stage must actually name something departmental.
  const DEPARTMENTS = [
    'procurement', 'hod', 'warehouse', 'it review', 'cost approval', 'finance',
    'management', 'cs review', 'mc review', 'cfo review', 'd365', 'closed',
    'rejected', 'on hold', 'draft', 'submitted',
  ];
  const nonDept = stageKinds.filter(
    s => s && !DEPARTMENTS.some(d => s.toLowerCase().includes(d)),
  );
  check(nonDept.length === 0,
    'every STAGE cell names a locus of control', nonDept);

  // The fraction must be a real ratio, not a concatenated number.
  const badFraction = nonEmpty.filter((c) => {
    const m = /(\d+)\/(\d+)/.exec(c);
    return m && Number(m[1]) > Number(m[2]);
  });
  check(badFraction.length === 0, 'no fraction shows responded > invited', badFraction.slice(0, 3));

  // The overdue pill must actually be styled red, not merely worded.
  const overdueRed = await page.$$eval('table.t tbody tr', (rows, idx) => {
    const out = [];
    for (const r of rows) {
      const td = r.querySelectorAll('td')[idx];
      const pill = td?.querySelector('.pill');
      if (pill && /RFQ overdue/i.test(pill.textContent)) {
        out.push(getComputedStyle(pill).backgroundColor);
      }
    }
    return out;
  }, statusIdx);
  console.log('  overdue pill colours:', [...new Set(overdueRed)].join(', ') || '(none on this page)');
  if (overdueRed.length) {
    // .pill.rejected is #FEE2E2 — the prototype's own red, not an arbitrary one.
    check(overdueRed.every((c) => /254,\s*226,\s*226/.test(c)), 'the overdue pill renders red', [...new Set(overdueRed)]);
  }

  // Re-issued chip styling must exist in the stylesheet.
  const chipStyled = await page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      for (const r of Array.from(rules)) {
        if (r.selectorText && /chip-reissued/.test(r.selectorText)) {
          return { found: true, css: r.cssText.slice(0, 160) };
        }
      }
    }
    return { found: false };
  });
  check(chipStyled.found, 'the Re-issued chip has styles', chipStyled);
}

check(consoleErrors.length === 0, 'no console errors on the page', consoleErrors.slice(0, 3));

// ── Task 2 · action tabs filter in place ─────────────────────────────────────
// The requirement is specific: no page reload, no sub-form, no panel. So the
// proof is that the URL is unchanged and the network stays quiet while the rows
// change — a refetch would show up as a request, and a router navigation would
// change the location.
const netBefore = apiRequests.length;
const urlBefore = page.url();

const tabs = await page.$$eval('[role="tab"]', (els) =>
  els.map((e) => ({ label: e.textContent.trim(), selected: e.getAttribute('aria-selected') })));
console.log('\n  tabs:', tabs.map((t) => `${t.label}${t.selected === 'true' ? '*' : ''}`).join(' | '));
check(tabs.length === 4, 'four action tabs are rendered', tabs.map((t) => t.label));
check(tabs.filter((t) => t.selected === 'true').length === 1, 'exactly one tab is selected');

// All is measured FIRST so the other tabs can be compared against it.
const counts = {};
for (const label of ['All', 'Awaiting Quotes', 'Expired', 'Received']) {
  await page.click(`[role="tab"]:has-text("${label}")`);
  await page.waitForTimeout(120);
  const rowCount = await page.$$eval('table.t tbody tr', (r) => r.length);
  const statuses = await page.$$eval('table.t tbody tr', (rows, idx) =>
    rows.map((r) => r.querySelectorAll('td')[idx]?.innerText.trim() || ''), statusIdx);
  counts[label] = rowCount;

  if (label === 'All') {
    check(rowCount > 0, 'All shows every row', rowCount);
  } else if (rowCount === 0) {
    // Which PRs sit in the 200-row window moves every time a suite creates one,
    // so a tab can legitimately have nothing behind it right now. What must
    // hold is that the empty state is shown and says WHICH tab is empty —
    // silently rendering a blank grid would look like the filter did nothing.
    const emptyMsg = await page.textContent('.empty-state').catch(() => null);
    check(!!emptyMsg && emptyMsg.includes(label),
      `${label} shows an empty state naming the tab`, emptyMsg);
    console.log(`  note  ${label} is empty in the current window`);
  } else {
    check(rowCount < counts.All, `${label} narrows the grid`, { label, rowCount, all: counts.All });
    // Every visible row must satisfy that tab's rule — in particular a
    // threshold-met PR must NOT appear under Awaiting, and a plain Expired row
    // must not appear under Received.
    const bad = statuses.filter((s) => {
      if (label === 'Awaiting Quotes') return !/Awaiting Quotes|Not dispatched/.test(s);
      // "Quotes received" was deliberately added to this tab — it is the moment
      // the quotes land. The four LATER governance states (CS/MC/CFO/Pack
      // locked) are NOT here, and this assertion is what keeps them out.
      if (label === 'Received') return !/^Received|Quotes received/.test(s);
      if (label === 'Expired') return !/Expired|Received/.test(s);
      return false;
    });
    check(bad.length === 0, `${label} shows only rows belonging to it`, bad.slice(0, 3));
  }
}
console.log('  row counts:', JSON.stringify(counts));

check(page.url() === urlBefore, 'the URL never changed — no navigation', page.url());
const netAfter = apiRequests.length;
check(netAfter === netBefore, 'no network request was made while filtering', { netBefore, netAfter });
const dialogs = await page.$$eval('[role="dialog"], .modal, dialog', (d) => d.length).catch(() => 0);
check(dialogs === 0, 'no sub-form or modal opened', dialogs);

await page.click('[role="tab"]:has-text("All")');
await page.screenshot({ path: process.env.SHOT || 'var/verify_status_ui.png', fullPage: false });
await browser.close();

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
if (fail > 0) process.exit(1);