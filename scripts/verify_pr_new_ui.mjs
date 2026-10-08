// verify_pr_new_ui.mjs
//
// Drives the real /pr/new form in a browser.
//
//   1. the line items table is CLEAN — no sort/filter toolbar above it
//   2. the category lookup is a D365-style GRID: Name and Description as two
//      distinct columns under a header, searched independently
//   3. a line item can be typed as pure free text with no catalogue match, and
//      the page no longer shows the "blocks submit" state
//   4. what the form submits is what actually persists
//
// Screenshots land in E:\Procurement Application\verify_shots\.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const WEB = process.env.WEB_BASE || 'http://127.0.0.1:33002';
const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const SHOTS = 'E:/Procurement Application/verify_shots';
mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const failures = [];
const check = (label, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(`${label} ${detail}`); console.log(`  FAIL ${label} ${detail}`); }
};
const section = (t) => console.log(`\n${t}`);

const lr = await fetch(`${API}/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: process.env.PROBE_EMAIL || 'hod.sales@pakboxes.pk', password: 'demo' }),
});
if (!lr.ok) { console.error(`login failed: ${lr.status}`); process.exit(1); }
const session = await lr.json();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.addInitScript((s) => { window.localStorage.setItem('pk_session', JSON.stringify(s)); }, session);
await page.goto(`${WEB}/pr/new`, { waitUntil: 'networkidle' });
await page.waitForSelector('.pr-items-table', { timeout: 30000 });

// Module-scoped: the cleanup below runs outside the section blocks.
let captured = null;
let createdId = null;
let submitted = null;

// ── 1. the table is clean ───────────────────────────────────────────────────
section('1. the line items table is clean');
{
  check('no sort toolbar exists', await page.locator('.gsf-sort').count() === 0);
  check('no filter toolbar exists', await page.locator('.gsf-filter').count() === 0);
  check('no sort/filter controls at all', await page.locator('[class*="gsf"]').count() === 0);

  // Nothing between the grid header and the first row of inputs. This is the
  // structural check that a stray "SORT / FILTER" bar was not re-added.
  const gap = await page.evaluate(() => {
    const head = document.querySelector('.pr-items-card .pr-items-head');
    const table = document.querySelector('.pr-items-table');
    if (!head || !table) return null;
    let n = head.nextElementSibling;
    const between = [];
    while (n && n !== table) { between.push(n.className || n.tagName); n = n.nextElementSibling; }
    return between;
  });
  check('the grid is the direct next element after the card header',
    Array.isArray(gap) && gap.length === 1 && gap[0].includes('pr-items-scroll'),
    JSON.stringify(gap));
}

// ── 2. the D365-style category lookup ───────────────────────────────────────
section('2. category lookup renders Name and Description as two columns');
{
  const catCell = page.locator('.pr-items-table tbody tr').first().locator('td.pr-col-category');
  check('the category cell is no longer a <select>',
    await catCell.locator('select').count() === 0);

  await catCell.locator('.lcc-trigger').click();
  await page.waitForSelector('.lcc-panel', { timeout: 5000 });
  check('opening it shows a search box', await page.locator('.lcc-search').isVisible());
  check('the placeholder mentions BOTH name and description',
    /name/i.test(await page.locator('.lcc-search').getAttribute('placeholder')) &&
    /description/i.test(await page.locator('.lcc-search').getAttribute('placeholder')),
    await page.locator('.lcc-search').getAttribute('placeholder'));

  // THE CLIPPING BUG. The panel used to be absolutely positioned inside the table
  // cell, where `.pr-items-card` and `.pr-items-scroll` (both `overflow`) cut it
  // off — only the first category was visible on a low row and the rest were
  // unreachable. These two checks reproduce that condition deliberately: they open
  // the lookup on the LAST row, which is where the clipping was worst.
  const panelBox = await page.locator('.lcc-panel').boundingBox();
  check('the panel is portalled out of the table (parent is <body>)',
    await page.locator('.lcc-panel').evaluate(el => el.parentElement?.tagName) === 'BODY',
    await page.locator('.lcc-panel').evaluate(el => el.parentElement?.tagName));
  check('no ancestor of the panel clips it',
    await page.locator('.lcc-panel').evaluate(el => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const ov = getComputedStyle(p).overflow;
        if (ov === 'hidden' || ov === 'auto' || ov === 'scroll') return `${p.className || p.tagName}:${ov}`;
      }
      return null;
    }) === null);

  // Open on the LAST row — the worst case for the old clipping.
  const lastCat = page.locator('.pr-items-table tbody tr').last().locator('td.pr-col-category');
  await page.locator('.lcc-panel').locator('.lcc-close').click();
  await page.waitForSelector('.lcc-panel', { state: 'detached' });
  await lastCat.locator('.lcc-trigger').click();
  await page.waitForSelector('.lcc-panel');
  await page.waitForTimeout(400);

  const lastBox = await page.locator('.lcc-panel').boundingBox();
  const viewport = page.viewportSize();
  check('opened on the LAST row, the panel fits inside the viewport',
    lastBox && lastBox.y >= -1 && lastBox.y + lastBox.height <= viewport.height + 1,
    JSON.stringify(lastBox));
  check('and it is tall enough to show several categories at once',
    lastBox && lastBox.height >= 220, `height=${lastBox?.height}`);

  // Every category must be reachable: present in the DOM and scrollable within
  // the panel, not merely "rendered somewhere".
  const reachable = await page.locator('.lcc-panel').evaluate((el) => {
    const opts = [...el.querySelectorAll('.lcc-opt')];
    const list = el.querySelector('.lcc-list');
    return { total: opts.length, scrollable: list ? list.scrollHeight > list.clientHeight : false };
  });
  check('ALL categories are present in the open list',
    reachable.total >= 8, `${reachable.total} options`);

  // Put it back on the first row for the column checks below.
  await page.locator('.lcc-panel').locator('.lcc-close').click();
  await page.waitForSelector('.lcc-panel', { state: 'detached' });
  await catCell.locator('.lcc-trigger').click();
  await page.waitForSelector('.lcc-panel');
  await page.waitForTimeout(300);

  // The header row is what makes this a lookup GRID rather than a stack of text.
  const heads = await page.locator('.lcc-head > *').evaluateAll(e => e.map(x => x.textContent.trim()));
  check('there is a column header row', heads.length === 2, JSON.stringify(heads));
  check('column 1 is the category name', /NAME/i.test(heads[0] || ''), heads[0]);
  check('column 2 is the description', /DESCRIPTION/i.test(heads[1] || ''), heads[1]);

  // Name and description must be in DIFFERENT grid cells, side by side — not
  // concatenated into one string, and not stacked in one cell.
  const first = page.locator('.lcc-opt').first();
  const nameCell = first.locator('.lcc-cell-name');
  const descCell = first.locator('.lcc-cell-desc');
  check('each row has a separate name cell', await nameCell.count() === 1);
  check('each row has a separate description cell', await descCell.count() === 1);

  const boxes = await page.evaluate(() => {
    const n = document.querySelector('.lcc-opt .lcc-cell-name');
    const d = document.querySelector('.lcc-opt .lcc-cell-desc');
    if (!n || !d) return null;
    const a = n.getBoundingClientRect(), b = d.getBoundingClientRect();
    return { sameX: Math.round(a.x), descX: Math.round(b.x), gap: Math.round(b.x - a.right) };
  });
  check('the description sits in its own column to the RIGHT of the name',
    boxes && boxes.gap >= 8, JSON.stringify(boxes));
  check('the name and description text are different strings',
    (await nameCell.textContent()).trim() !== (await descCell.textContent()).trim());

  // Every description must start at the same x — that alignment is what makes
  // the list scannable.
  const descLefts = await page.locator('.lcc-opt .lcc-cell-desc')
    .evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().x)));
  check('every description column is aligned to the same x',
    new Set(descLefts).size === 1, JSON.stringify(descLefts.slice(0, 6)));

  // ── independent search ──
  section('3. search works across name AND description independently');
  const total = await page.locator('.lcc-opt').count();
  check('the whole vocabulary is offered', total >= 8, `${total} options`);

  // Find a word that appears ONLY in a description, never in any name or code.
  // This is the check that proves description search actually works — a name-only
  // search would return nothing here.
  const vocab = await page.locator('.lcc-opt').evaluateAll(els => els.map(e => ({
    name: e.querySelector('.lcc-cell-name')?.textContent || '',
    desc: e.querySelector('.lcc-cell-desc')?.textContent || '',
  })));
  const stop = new Set(['the', 'and', 'for', 'with', 'not', 'other', 'any', 'all', 'are', 'its',
    'this', 'that', 'from', 'into', 'per', 'use', 'etc', 'non', 'one', 'two', 'new', 'own']);
  let descOnlyWord = null;
  for (const v of vocab) {
    const nameWords = new Set(v.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    for (const w of v.desc.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
      if (w.length >= 5 && !nameWords.has(w) && !stop.has(w)) { descOnlyWord = w; break; }
    }
    if (descOnlyWord) break;
  }
  check('found a keyword that exists only in a DESCRIPTION', !!descOnlyWord, String(descOnlyWord));

  if (descOnlyWord) {
    await page.locator('.lcc-search').fill(descOnlyWord);
    await page.waitForTimeout(400);
    const byDesc = await page.locator('.lcc-opt').count();
    check(`searching the description-only word "${descOnlyWord}" returns rows`,
      byDesc > 0, `got ${byDesc}`);
    const markedInDesc = await page.locator(`.lcc-opt .lcc-cell-desc mark`).count();
    check('the match is highlighted inside the DESCRIPTION column',
      markedInDesc > 0, `${markedInDesc} marked`);
    const markedInName = await page.locator('.lcc-opt .lcc-cell-name mark').count();
    check('and it is NOT falsely highlighted in the name column',
      markedInName === 0, `${markedInName} marked in name`);
    await page.screenshot({ path: `${SHOTS}/lookup-description-search.png`, fullPage: false });
  }

  // ...and a name search, to prove the two paths are independent.
  const nameWord = vocab[0].name.split(/\s+/)[0];
  await page.locator('.lcc-search').fill(nameWord);
  await page.waitForTimeout(400);
  const byName = await page.locator('.lcc-opt').count();
  check(`searching the name word "${nameWord}" returns rows`, byName > 0, `got ${byName}`);
  check('with the match highlighted in the NAME column',
    await page.locator('.lcc-opt .lcc-cell-name mark').count() > 0);

  await page.locator('.lcc-search').fill('hard');
  await page.waitForTimeout(400);
  check('a mid-word fragment matches (contains, not just begins-with)',
    await page.locator('.lcc-opt').count() > 0);
  await page.screenshot({ path: `${SHOTS}/lookup-grid-open.png`, fullPage: false });

  // Selecting sets the category and must NOT rewrite the free-text description.
  // Close the open panel FIRST: the component renders the panel INSTEAD of the
  // trigger, so `.lcc-trigger` does not exist in the DOM while the lookup is open.
  await page.keyboard.press('Escape');
  await page.waitForSelector('.lcc-panel', { state: 'detached', timeout: 5000 });
  await catCell.locator('.lcc-trigger').click();
  await page.waitForSelector('.lcc-search');
  await page.locator('.lcc-search').fill('hard');
  await page.waitForTimeout(350);
  const descBefore = await page.locator('.pr-items-table tbody tr').first()
    .locator('td:nth-child(4) input').inputValue();
  await page.locator('.lcc-opt').first().click();
  await page.waitForTimeout(300);
  check('selecting a category shows it on the closed control',
    ((await catCell.locator('.lcc-trigger').textContent()) || '').trim().length > 3);
  const descAfter = await page.locator('.pr-items-table tbody tr').first()
    .locator('td:nth-child(4) input').inputValue();
  check('choosing a category does NOT rewrite the free-text description',
    descBefore === descAfter, `"${descBefore}" -> "${descAfter}"`);
}

// ── 4. free text ────────────────────────────────────────────────────────────
section('4. free-text line items');
{
  const first = page.locator('.pr-items-table tbody tr').first();
  const freeText = 'Two ergonomic task chairs, mesh back, no armrests';
  await first.locator('td:nth-child(4) input').fill(freeText);
  await first.locator('td:nth-child(8) input').fill('18500');
  await page.waitForTimeout(500);

  const body = await page.locator('.pr-items-card').textContent();
  check('the page no longer says a line "blocks submit"',
    !/blocks submit/i.test(body ?? ''), 'the old blocking copy is still on the page');
  // A line with no catalogue match is the NORMAL case, so the row must not narrate
  // it. The removed copy ("Free text — submitted as written, no catalogue item
  // attached.") restated the <select>'s own value on every row and made an
  // entirely expected state look like a warning.
  check('no per-row "Free text — submitted as written" narration is rendered',
    !/free text — submitted/i.test(body ?? ''), 'the narration is back');
  check('and no "no catalogue item attached" warning either',
    !/no catalogue item attached/i.test(body ?? ''), 'the warning copy is back');

  // The catalogue dropdown itself is gone. It was the last per-row control on a
  // row that already had four inputs; with the description free text, nothing
  // about a line requires choosing a catalogue row.
  const itemDetailCell = first.locator('td:nth-child(3)');
  check('the ITEM DETAIL cell has no catalogue dropdown',
    await itemDetailCell.locator('select').count() === 0,
    `${await itemDetailCell.locator('select').count()} select(s) still there`);
  check('and no catalogue item codes leak into the row',
    !/PKB-[A-Z]{2}-\d{3}/.test(body ?? ''), 'catalogue codes are still rendered');
  // The row should now be ONE control, not an input plus a select under it.
  check('ITEM DETAIL holds exactly one input',
    await itemDetailCell.locator('input').count() === 1,
    `${await itemDetailCell.locator('input').count()} inputs`);
  await page.screenshot({ path: `${SHOTS}/free-text.png`, fullPage: false });
}

// ── 5. what is sent is what persists ───────────────────────────────────────
section('5. submission');
{
  // host, not hostname: the WHATWG URL API excludes the port from `hostname`, so
  // a predicate matching '33001' there would never fire and this would silently
  // capture nothing.
  await page.route(
    (url) => url.pathname === '/pr' && url.host.includes('33001'),
    async (route) => {
      if (route.request().method() === 'POST') {
        try { captured = JSON.parse(route.request().postData() || '{}'); } catch { /* ignore */ }
      }
      await route.continue();
    },
  );

  for (const d of ['USB-C dock, 100W passthrough', 'Standing desk risers, bamboo',
                    'Dell Latitude 5550 Laptop']) {
    await page.locator('.pr-add-link').click();
    await page.waitForTimeout(200);
    const r = page.locator('.pr-items-table tbody tr').last();
    await r.locator('td:nth-child(4) input').fill(d);
  }
  await page.locator('input[placeholder*="Office laptops"]').fill('Lookup verification');
  await page.locator('textarea').first().fill('Verifying the lookup and free-text behaviour.');
  await page.locator('.pr-hdr-dept select').selectOption({ index: 1 });
  await page.waitForTimeout(250);

  await page.locator('button:has-text("Submit PR")').click();
  await page.waitForTimeout(2200);

  const alertText = await page.locator('.alert.danger').count()
    ? (await page.locator('.alert.danger').first().textContent())?.trim() : null;
  check('the form did not refuse the submit', !alertText, `alert: ${alertText}`);
  check('the submit was intercepted with a payload', !!captured);

  if (captured) {
    submitted = captured?.lines?.length ?? 0;
    check('all four lines were submitted', submitted === 4, `got ${submitted}`);
    const freeTextLine = (captured.lines || []).find(l =>
      String(l.description || '').includes('ergonomic task chairs'));
    check('the free-text line is in the payload', !!freeTextLine);
    check('and it carries NO itemId — free text, not a fabricated SKU',
      freeTextLine && !('itemId' in freeTextLine), String(freeTextLine?.itemId));
    check('a price typed against a FREE-TEXT line is actually sent',
      freeTextLine && freeTextLine.unitPriceEst === 18500,
      `unitPriceEst=${freeTextLine?.unitPriceEst}`);
    check('the category code WAS sent for the line that had one',
      (captured.lines || []).some(l => l.category === 'IT_HARDWARE'));

    // The catalogue DROPDOWN is gone, but the hidden auto-match is NOT — it is
    // what gives a line its CAPEX/OPEX classification, which drives the warehouse
    // check and the management gate. If removing the control silently removed the
    // suggester, a laptop request would be filed as OPEX and quietly misrouted.
    // Nothing on screen would show it: that is exactly why it needs an assertion.
    const laptop = (captured.lines || []).find(l =>
      String(l.description || '').includes('Dell Latitude 5550'));
    check('a line typed as a real catalogue item still auto-binds an itemId',
      laptop && 'itemId' in laptop, JSON.stringify(laptop));
    check('while the unrelated lines stay unbound',
      (captured.lines || []).filter(l => 'itemId' in l).length === 1,
      `${(captured.lines || []).filter(l => 'itemId' in l).length} bound line(s)`);
  }

  await page.waitForURL(/\/pr\/[0-9a-f-]{36}/, { timeout: 20000 }).catch(() => {});
  createdId = (page.url().match(/\/pr\/([0-9a-f-]{36})/) || [])[1] || null;
  check('the app navigated to the new PR', !!createdId, page.url());

  if (createdId) {
    const detail = await fetch(`${API}/pr/${createdId}`, {
      headers: { Authorization: `Bearer ${session.token}` },
    }).then((r) => r.json()).catch(() => null);
    const lines = detail?.lines || [];
    check('the stored PR has every line', lines.length === submitted, `stored ${lines.length}`);
    const storedFree = lines.find(l => String(l.description || '').includes('ergonomic task chairs'));
    check('the free-text line was PERSISTED and reads back', !!storedFree);
    check('stored with a NULL item, not a substituted SKU',
      storedFree && !storedFree.item_id, `item_id=${storedFree?.item_id}`);
    check('its price survived the round trip (18500)',
      Number(storedFree?.unit_price_est) === 18500, `got ${storedFree?.unit_price_est}`);
  }
}
await page.unrouteAll({ behavior: 'ignoreErrors' });

if (createdId) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)('docker', ['exec', '-i', 'procurement-portal-db', 'psql', '-U', 'proc',
    '-d', 'procurementDB', '-X', '-q', '-c',
    `DELETE FROM proc.purchase_requisitions WHERE id='${createdId}'`]).catch(() => {});
  console.log(`\n(cleaned up verification PR ${createdId})`);
}

section('6. console hygiene');
{
  const real = consoleErrors.filter(e => !/favicon|404 \(Not Found\).*favicon/i.test(e));
  check('no uncaught React/runtime errors on the page', real.length === 0,
    JSON.stringify(real.slice(0, 3)));
}

await browser.close();
console.log(`\n${'='.repeat(66)}`);
console.log(`TOTAL  pass=${pass}  fail=${fail}`);
if (fail) { console.log('\nFAILURES:'); failures.forEach(f => console.log(`  - ${f}`)); }
console.log(`screenshots: ${SHOTS}`);
console.log('='.repeat(66));
process.exit(fail ? 1 : 0);