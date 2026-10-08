// capture_demo_shot.mjs
// Clean screenshots of /pr/new for the demo: the bare line items grid, and the
// D365-style category lookup open in its two-column form.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const WEB = 'http://127.0.0.1:33002';
const API = 'http://127.0.0.1:33001';
const SHOTS = 'E:/Procurement Application/verify_shots';
mkdirSync(SHOTS, { recursive: true });

const lr = await fetch(`${API}/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'hod.sales@pakboxes.pk', password: 'demo' }),
});
const session = await lr.json();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 1150 } });
await page.addInitScript((s) => { window.localStorage.setItem('pk_session', JSON.stringify(s)); }, session);
await page.goto(`${WEB}/pr/new`, { waitUntil: 'networkidle' });
await page.waitForSelector('.pr-items-table');

// Row 1 in place, then ADD a row for each of the rest. Filling `.last()`
// repeatedly would overwrite the same row, because the table starts with three.
const rows = [
  ['Two ergonomic task chairs, mesh back, no armrests', '4'],
  ['USB-C dock, 100W passthrough', '2'],
  ['Standing desk risers, bamboo', '6'],
];
const first = page.locator('.pr-items-table tbody tr').first();
await first.locator('td:nth-child(4) input').fill(rows[0][0]);
await first.locator('td:nth-child(5) input').fill(rows[0][1]);
await first.locator('td:nth-child(8) input').fill(String(1200 * Number(rows[0][1])));

for (const [desc, qty] of rows.slice(1)) {
  await page.locator('.pr-add-link').click();
  await page.waitForTimeout(200);
  const r = page.locator('.pr-items-table tbody tr').last();
  await r.locator('td:nth-child(4) input').fill(desc);
  await r.locator('td:nth-child(5) input').fill(qty);
  await r.locator('td:nth-child(8) input').fill(String(1200 * Number(qty)));
}
await page.waitForTimeout(400);

// 1 · the clean grid, no toolbar.
await page.locator('.pr-items-card').screenshot({ path: `${SHOTS}/demo-grid-clean.png` });

// 2 · the lookup open with NO search — the whole vocabulary, which is the view
//     that used to be clipped to a single row by the card's overflow.
const catCell = page.locator('.pr-items-table tbody tr').first().locator('td.pr-col-category');
await catCell.locator('.lcc-trigger').click();
await page.waitForSelector('.lcc-search');
await page.waitForTimeout(500);
await page.screenshot({ path: `${SHOTS}/demo-lookup-all.png`, fullPage: false });

// 3 · the same lookup searched on a NAME fragment.
await page.locator('.lcc-search').fill('it');
await page.waitForTimeout(450);
await page.screenshot({ path: `${SHOTS}/demo-lookup-by-name.png`, fullPage: false });

// 4 · searched on a DESCRIPTION-only word, to show that the two fields are
//     searched independently.
await page.locator('.lcc-search').fill('plumbing');
await page.waitForTimeout(450);
await page.screenshot({ path: `${SHOTS}/demo-lookup-by-description.png`, fullPage: false });

console.log('captured demo shots');
await browser.close();