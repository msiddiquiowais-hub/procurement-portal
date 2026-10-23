// Browser proof for the Receive Quotation header work.
//
//   node scripts/verify_receive_quote_layout.mjs <pr-id> [out-dir]
//
// WHAT THIS PROVES, AND WHY A CSS CALCULATION IS NOT ENOUGH
// --------------------------------------------------------
// The claim under test is behavioural: "when the header is collapsed, the grid
// comfortably shows 10-15 rows". That is a claim about how many rows fit between
// the top of the grid and the bottom of the viewport, which depends on the real
// rendered heights of the banner, the field strip, the sticky column header, the
// sticky totals row and each grid row. Deriving it from the stylesheet would be a
// second implementation of the layout, and it would be the kind that is
// confidently wrong: it cannot see `flex-wrap` actually wrapping, a border, or a
// focus ring.
//
// So it is measured in a real browser at real window sizes, and the row count
// comes from the MEASURED row height - not from an assumption.
//
// The 15-line RFQ is injected into the DOM rather than created in the database:
// this is a layout measurement, so persisting a fixture would leave residue in
// the shared demo data for nothing. Nothing is ever submitted.
//
// TWO HARNESS BUGS THIS FILE ALREADY CONTAINS FIXES FOR, both of which produced
// confident, plausible, wrong results on the first run:
//
//  1. `page.evaluate` given a STRING evaluates it as an expression and returns
//     the string. The measurement came back as its own source text and every
//     geometry field was `undefined`, which read as "the layout is broken".
//  2. The sticky band was measured as the SUM of every `th` and `td` - 14 cells
//     per row - which is larger than the grid itself, and produced a row capacity
//     of -16. The sticky bands are two ROWS: one at the top, one at the bottom.
//
// Same trap as a static guard test that cannot see the code it guards: the
// failure mode is a confident report about something never measured.

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const WEB = process.env.WEB_BASE || 'http://localhost:33002';
const PR_ID = process.argv[2];
const OUT = process.argv[3] || 'var/quote-layout';

if (!PR_ID) {
  console.error('usage: node scripts/verify_receive_quote_layout.mjs <pr-id> [out-dir]');
  process.exit(2);
}

let pass = 0, fail = 0;
const ok = (l, x = '') => { pass++; console.log(`  PASS  ${l}${x ? `  (${x})` : ''}`); };
const bad = (l, d) => { fail++; console.log(`  FAIL  ${l}\n        ${d}`); };

/**
 * How many body rows are actually visible inside the grid's scrollport.
 *
 * A row counts only if BOTH its top and its bottom clear the scrollport. Counting
 * rows in the DOM would report 15 either way and prove nothing about whether they
 * can be seen.
 */
const VISIBLE_ROWS = () => {
  const wrap = document.querySelector('.rq-wrap');
  if (!wrap) return { rows: -1, note: 'no .rq-wrap in the DOM' };
  const top = wrap.scrollTop, bottom = top + wrap.clientHeight;
  const trs = [...wrap.querySelectorAll('tbody tr')];
  const full = trs.filter(tr => tr.offsetTop >= top && tr.offsetTop + tr.offsetHeight <= bottom).length;
  const rowH = trs.length ? trs[0].offsetHeight : 0;
  // Two sticky ROW BANDS, not a sum over cells.
  const sticky = ['thead', 'tfoot']
    .reduce((s, sel) => s + (wrap.querySelector(sel)?.offsetHeight || 0), 0);
  return {
    rows: full, rowH, sticky,
    gridH: wrap.clientHeight, count: trs.length,
    docH: document.documentElement.clientHeight,
    chrome: document.documentElement.clientHeight - wrap.getBoundingClientRect().height,
  };
};

/** Clone rows up to 15 so the grid actually fills and the clamp stops governing. */
const PAD_TO_15 = () => {
  const tb = document.querySelector('.rq-tbl tbody');
  const first = tb.querySelector('tr').cloneNode(true);
  while (tb.children.length < 15) {
    const c = first.cloneNode(true);
    c.querySelectorAll('input').forEach(i => { i.value = ''; });
    tb.appendChild(c);
  }
};

const run = async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => console.log('  [page error]', e.message));

  console.log(`\n== 0. sign in and open the Receive Quotation form (${PR_ID.slice(0, 8)}) ==`);
  await page.goto(`${WEB}/`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"], input[name="email"]', 'procurement@pakboxes.pk');
  await page.fill('input[type="password"], input[name="password"]', 'demo');
  await page.click('button[type="submit"]');
  await page.waitForURL(u => !/\/$/.test(u.pathname), { timeout: 20000 }).catch(() => {});
  await page.goto(`${WEB}/pr/${PR_ID}`, { waitUntil: 'networkidle' });

  const openBtn = page.locator('button', { hasText: 'Receive Quotation' }).first();
  await openBtn.waitFor({ state: 'visible', timeout: 20000 });
  await openBtn.click();
  await page.waitForSelector('.rq-wrap', { timeout: 20000 });
  await page.waitForFunction(`document.querySelectorAll('.rq-tbl tbody tr').length > 0`, { timeout: 20000 });
  ok('form opened', await page.locator('.rq-head h2').first().innerText());

  // -- 1. the controls are all in the banner now --------------------------------
  console.log('\n== 1. document, discount and tax-inclusive controls live in the banner ==');
  const inBanner = async sel => page.locator(`.rq-head ${sel}`).count();
  const checks = [
    ['file input', await inBanner('#rq-file')],
    ['Apply Discount', await inBanner('.rq-toggles input[type="checkbox"]')],
    ['basis radios', await inBanner('input[name="rq-basis"]')],
    ['Prices include tax', await page.locator('.rq-head .rq-toggles', { hasText: 'Prices include tax' }).count()],
  ];
  for (const [what, n] of checks) {
    n > 0 ? ok(`${what} is in the header banner`) : bad(`${what} in the banner`, 'not found under .rq-head');
  }
  const strips = await page.locator('.rq-body > .rq-strip').count();
  strips === 1
    ? ok('only the vendor/terms strip remains below the banner', 'was 2')
    : bad('control strips below the banner', `expected 1 (vendor+terms), found ${strips}`);

  // "Compact" is asserted as the property that matters, not as a magic number:
  // remarks shares one horizontal row with the document control instead of
  // claiming a strip of its own. It used to sit in a full-width `.rq-strip`,
  // costing ~67px of vertical space to type something optional.
  const remarksBox = await page.locator('.rq-head .rq-remarks').boundingBox();
  const fileBox = await page.locator('.rq-head .rq-filewrap').boundingBox();
  if (!remarksBox) {
    bad('remarks', 'no .rq-remarks in the banner');
  } else {
    const sharesRow = fileBox &&
      remarksBox.y < fileBox.y + fileBox.height && fileBox.y < remarksBox.y + remarksBox.height;
    sharesRow
      ? ok('remarks shares one row with the document control',
        `${Math.round(remarksBox.height)}px tall, was a ~67px strip`)
      : bad('remarks row', 'it is not on the same row as the document control');
    remarksBox.height <= 40
      ? ok('remarks is a single compact line', `${Math.round(remarksBox.height)}px`)
      : bad('remarks height', `${Math.round(remarksBox.height)}px - not a single line`);
  }

  // -- 2. fill the grid so the clamp stops governing the measurement -----------
  console.log('\n== 2. a 15-item grid, measured with the banner open and folded ==');
  // The demo PR carries 3 lines and 3 rows are shorter than the grid's own clamp
  // floor, so `clientHeight` is identical whether the banner is open or folded.
  // Asserting "folding gained height" there measures the clamp, not the feature.
  await page.evaluate(PAD_TO_15);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}-expanded.png` });
  const exp = await page.evaluate(VISIBLE_ROWS);
  exp.rows > 0
    ? ok('rows visible with the banner open',
      `${exp.rows} of ${exp.count} | grid ${exp.gridH}px | chrome ${exp.chrome}px`)
    : bad('expanded row count', JSON.stringify(exp));
  console.log(`  [grid ${exp.gridH}px | row ${exp.rowH}px | sticky bands ${exp.sticky}px]`);

  // -- 3. fold it ---------------------------------------------------------------
  console.log('\n== 3. collapsed: the fold gives its height to the grid ==');
  await page.click('.rq-fold');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}-collapsed.png` });
  const col = await page.evaluate(VISIBLE_ROWS);
  const gained = col.gridH - exp.gridH;
  gained > 60
    ? ok('the grid grew when the banner folded', `+${gained}px (${exp.gridH} -> ${col.gridH})`)
    : bad('fold gained nothing', `${exp.gridH} -> ${col.gridH}px - the toggle is not handing back its height`);
  const fits = Math.floor((col.gridH - col.sticky) / col.rowH);
  fits >= 10
    ? ok('collapsed grid holds 10+ rows without scrolling', `~${fits} rows fit in ${col.gridH}px`)
    : bad('collapsed row capacity', `only ~${fits} rows fit - the 10-15 row target is not met`);
  col.rows >= 10
    ? ok('10+ of the 15 items are actually visible at once', `${col.rows} fully visible`)
    : bad('collapsed visible rows', `${col.rows} of 15 - needs 10+`);
  col.rows > exp.rows
    ? ok('folding is what makes the difference', `+${col.rows - exp.rows} rows (${exp.rows} -> ${col.rows})`)
    : bad('folding made no difference', `${exp.rows} -> ${col.rows}`);

  // -- 4. the folded banner still says whose quote this is ----------------------
  console.log('\n== 4. a folded banner must still identify the vendor ==');
  const sum = (await page.locator('.rq-folded-sum').innerText()).replace(/\s+/g, ' ').trim();
  sum.length > 0
    ? ok('folded summary is shown', sum)
    : bad('folded summary', 'empty - folding would hide whose quotation is open');
  const stripHidden = await page.locator('.rq-strip').count();
  stripHidden === 0
    ? ok('vendor/terms fields are hidden while folded')
    : bad('vendor strip still visible', 'the whole point of folding is that it is not');
  const toggleThere = await page.locator('.rq-fold').count();
  toggleThere === 1
    ? ok('the expand control is still reachable while folded')
    : bad('no way to expand', 'the fold button disappeared when folded');

  // -- 5. the screen where this originally broke: a 768px-tall laptop ----------
  // Every measurement above is at 900px. "Comfortably displays 10-15 rows" is a
  // claim about the worst case, and the worst case is the short screen - which is
  // where the old fixed `calc(100vh - 330px)` collapsed to two rows.
  console.log('\n== 5. the same 15 items on a 768px-tall laptop ==');
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.waitForTimeout(400);
  const lapFolded = await page.evaluate(VISIBLE_ROWS);
  await page.click('.rq-fold');
  await page.waitForTimeout(400);
  const lapOpen = await page.evaluate(VISIBLE_ROWS);
  await page.screenshot({ path: `${OUT}-laptop-768-expanded.png` });
  console.log(`  [768px | folded ${lapFolded.rows} rows in ${lapFolded.gridH}px | open ${lapOpen.rows} rows in ${lapOpen.gridH}px]`);
  lapOpen.gridH < 260
    ? bad('768px grid collapsed', `${lapOpen.gridH}px - this is the two-row failure the work was meant to fix`)
    : ok('the grid is usable at 768px with the banner open', `${lapOpen.gridH}px | ${lapOpen.rows} rows`);
  lapFolded.rows >= 10
    ? ok('and shows 10+ of 15 folded', `${lapFolded.rows} visible in ${lapFolded.gridH}px`)
    : bad('768px folded capacity', `${lapFolded.rows} rows - needs 10+`);

  // -- 6. the column order follows the basis radio, live ----------------------
// The whole grid is re-rendered from one column list, so the header, every body
// row and the sticky totals row move together. Asserting the header alone would
// miss the failure that matters: a moved <th> with a totals row still glued to
// the old columns prints totals under the wrong headings, and nothing errors.
  // PRICE A LINE FIRST.
  // Without this every total is "0.00" and the positional checks below compare
  // zeros to zeros — they pass whether or not the totals row moved with its
  // columns. Distinct values are what make the comparison mean anything.
  console.log('\n== 6. the grid reorders when the basis radio changes ==');
  await page.evaluate(() => {
    const tr = document.querySelectorAll('.rq-tbl tbody tr')[0];
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    for (const [sel, v] of [['input.unit', '1000'], ['input.disc', '10'], ['input.pct', '18']]) {
      const el = tr.querySelector(sel);
      if (!el) throw new Error(`no ${sel} on the first row`);
      set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await page.waitForTimeout(200);

  // One evaluate, returning the header labels AND the totals row expanded to
  // the same width. Two evaluates sharing a helper looked tidier and does not
  // work: a function passed to page.evaluate is re-created in the browser and
  // cannot see the Node-side one it referenced.
  const GRID = () => {
    const head = [...document.querySelectorAll('.rq-tbl thead th')].map(th => th.textContent.trim());
    const tds = [...document.querySelectorAll('.rq-tbl tfoot td')];
    // The leading totals cell carries a colSpan; expand it so the row is
    // positionally comparable with the header.
    const foot = [];
    for (let i = 0; i < tds.length; i++) {
      const width = tds[i].colSpan > 1 ? tds[i].colSpan : 1;
      const txt = tds[i].textContent.trim();
      for (let k = 0; k < width; k++) foot.push(txt);
    }
    const body = document.querySelector('.rq-tbl tbody tr');
    return {
      head,
      foot: foot.slice(0, head.length),
      bodyCells: body ? body.querySelectorAll('td').length : -1,
      headCells: head.length,
      footCells: foot.length,
    };
  };

  const before = await page.evaluate(GRID);
  console.log(`  [before tax] ${before.head.join(' | ')}`);
  const iDiscB = before.head.indexOf('Disc %');
  const iTaxB = before.head.indexOf('Tax %');
  iDiscB >= 0 && iDiscB < iTaxB
    ? ok('before tax: Disc % precedes Tax %', `positions ${iDiscB + 1} < ${iTaxB + 1}`)
    : bad('before-tax order', before.head.join(' | '));
  before.head[before.head.indexOf('Net Amt') + 1] === 'Tax %'
    ? ok('before tax: Net Amt leads the tax block',
      'the discount shrank the base the tax is charged on')
    : bad('before-tax Net Amt position', before.head.join(' | '));
  before.headCells === before.bodyCells && before.headCells === before.footCells
    ? ok('header, body and totals row have the same number of cells',
      `${before.headCells} each`)
    : bad('row widths disagree',
      `head ${before.headCells} | body ${before.bodyCells} | foot ${before.footCells}`);

  // Flip the radio and re-read, with no reload: this is the "instantly" claim.
  await page.click('.rq-head label:has-text("Discount after tax") input');
  await page.waitForTimeout(250);
  const after = await page.evaluate(GRID);
  console.log(`  [after tax]  ${after.head.join(' | ')}`);
  const iDiscA = after.head.indexOf('Disc %');
  const iTaxAmtA = after.head.indexOf('Tax Amt');
  // The heading is basis-dependent: after-tax this column is the gross
  // INCLUDING tax, so it is called "Inc Tax Amt" and reading it as "the base"
  // is exactly the misreading behind the 2,160.00 total.
  const iNetA = after.head.indexOf('Inc Tax Amt');
  iDiscA > iTaxAmtA && iDiscA > 0
    ? ok('after tax: the discount block moved past the tax block',
      `Disc % now at ${iDiscA + 1}, Tax Amt at ${iTaxAmtA + 1}`)
    : bad('after-tax order', after.head.join(' | '));
  iNetA === iTaxAmtA + 1
    ? ok('after tax: Inc Tax Amt sits directly after Tax Amt',
      `positions ${iTaxAmtA + 1} then ${iNetA + 1}`)
    : bad('Inc Tax Amt is not after Tax Amt',
      `Tax Amt at ${iTaxAmtA + 1}, Inc Tax Amt at ${iNetA + 1} — ${after.head.join(' | ')}`);
  after.head.includes('Net Amt')
    ? bad('the after-tax column is still labelled "Net Amt"',
      `it holds gross + tax, not the base — ${after.head.join(' | ')}`)
    : ok('and it is no longer labelled "Net Amt"',
      'the heading distinguishes the taxable base from the tax-inclusive gross');
  after.head[iNetA - 1] === 'Tax Amt' && after.head[iNetA + 1] === 'Disc %'
    ? ok('the discount columns follow it, so it is never stranded',
      'Tax Amt | Inc Tax Amt | Disc % | Disc Amt')
    : bad('columns around Inc Tax Amt', after.head.join(' | '));
  after.head[after.head.length - 3] === 'Total (PKR)'
    ? ok('Total is still third from last')
    : bad('Total moved', after.head.join(' | '));
  after.headCells === after.bodyCells && after.headCells === after.footCells
    ? ok('all three rows still agree after the move', `${after.headCells} cells each`)
    : bad('row widths disagree after reorder',
      `head ${after.headCells} | body ${after.bodyCells} | foot ${after.footCells}`);

  const netIdxB = before.head.indexOf('Net Amt');
  after.foot.join('|') !== before.foot.join('|')
    ? ok('the totals row re-ordered with the header, not just the header')
    : bad('totals row did not move', 'it is still aligned to the previous order');
  // The same column, relabelled and holding a DIFFERENT figure — so the totals
  // row is checked positionally, not by value.
  before.foot[netIdxB] !== after.foot[iNetA]
    ? ok('the middle column now carries the tax-inclusive figure',
      `was ${before.foot[netIdxB]} (taxable base), now ${after.foot[iNetA]} (gross + tax)`)
    : bad('Inc Tax Amt still shows the base',
      `${after.foot[iNetA]} — it should be gross + tax, not gross - discount`);
  const discIdxB = before.head.indexOf('Disc Amt');
  const discIdxA = after.head.indexOf('Disc Amt');
  // The discount is taken off DIFFERENT bases in the two modes, so it must be a
  // different figure — and it moves to a different column at the same time.
  before.foot[discIdxB] !== after.foot[discIdxA]
    ? ok('the discount is taken off a different base in each mode',
      `${before.foot[discIdxB]} (off gross) -> ${after.foot[discIdxA]} (off gross + tax)`)
    : bad('the discount figure did not change base',
      `${after.foot[discIdxA]} — it should be 10% of the tax-inclusive amount`);

  // The reported case, checked end to end in the rendered grid.
  //   2 EA x 1000, 18% tax, 10% discount
  //   before tax: disc 200.00 | net 1,800.00 | tax 324.00 | total 2,124.00
  //   after  tax: tax 360.00 | Inc Tax Amt 2,360.00 | disc 236.00 | total 2,124.00
  const rowMoney = await page.evaluate(() => {
    const head = [...document.querySelectorAll('.rq-tbl thead th')].map(t => t.textContent.trim());
    const td = [...document.querySelectorAll('.rq-tbl tbody tr')[0].querySelectorAll('td')];
    // Disc Amt and Tax Amt became editable, so their textContent is EMPTY and
    // the figure lives in the input's value. Reading textContent alone reports
    // those two as blank and then compares '' against '360.00' — a failure, or
    // worse a pass, that has nothing to do with the arithmetic.
    const pick = label => {
      const cell = td[head.indexOf(label)];
      if (!cell) return '';
      const input = cell.querySelector('input');
      return input ? input.value.trim() : cell.textContent.trim();
    };
    return {
      gross: pick('Gross Amt'), taxAmt: pick('Tax Amt'), net: pick('Net Amt'),
      incTax: pick('Inc Tax Amt'), discAmt: pick('Disc Amt'), total: pick('Total (PKR)'),
    };
  });
  console.log(`  [after-tax row] gross ${rowMoney.gross} | tax ${rowMoney.taxAmt} | `
    + `inc-tax ${rowMoney.incTax} | disc ${rowMoney.discAmt} | total ${rowMoney.total}`);
  // Compared as NUMBERS. A derived money cell prints "2,360.00"; an editable one
  // prints "236". String equality would be asserting on that formatting choice —
  // which changed here — rather than on the figure, and it would report a
  // formatting regression as an arithmetic failure.
  const num = s => parseFloat(String(s).replace(/,/g, '')) || 0;
  const wanted = { gross: 2000, taxAmt: 360, incTax: 2360, discAmt: 236, total: 2124 };
  for (const [k, v] of Object.entries(wanted)) {
    Math.abs(num(rowMoney[k]) - v) < 0.005
      ? ok(`after-tax ${k} is ${v}`)
      : bad(`after-tax ${k}`, `want ${v} got "${rowMoney[k]}"`);
  }
  Math.abs(num(rowMoney.incTax) - num(rowMoney.discAmt) - num(rowMoney.total)) < 0.005
    ? ok('the row satisfies Total = Inc Tax Amt - Disc Amt',
      `${rowMoney.incTax} - ${rowMoney.discAmt} = ${rowMoney.total}`)
    : bad('row identity',
      `${rowMoney.incTax} - ${rowMoney.discAmt} != ${rowMoney.total}`);
  rowMoney.net === ''
    ? ok('and no column claims to be a "Net Amt" here')
    : bad('a Net Amt column is still shown in after-tax mode', rowMoney.net);

  await page.screenshot({ path: `${OUT}-after-tax-reorder.png` });

  // Flip back, and confirm it is reversible.
  await page.click('.rq-head label:has-text("Discount before tax") input');
  await page.waitForTimeout(250);
  const back = await page.evaluate(GRID);
  back.head.join('|') === before.head.join('|') && back.foot.join('|') === before.foot.join('|')
    ? ok('and flipping back restores the original order, header and totals row together')
    : bad('order did not restore', `${back.head.join(' | ')} / ${back.foot.join(' | ')}`);

  // -- 7. rate fields: no spinners, no negative sign, no zero price -------------
  console.log('\n== 7. rate fields reject what they should ==');
  // Spinners. Asserted from the COMPUTED style, not from the stylesheet: a rule
  // can ship, match nothing, and still read as done in the source. Chrome
  // reports `appearance: textfield` once both the WebKit pseudo-elements are
  // hidden and the standard property is set.
  const spinners = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('.rq-dialog input[type="number"]')) {
      const cs = getComputedStyle(el);
      out.push({
        cls: el.className || '(none)',
        appearance: cs.appearance || cs.getPropertyValue('-webkit-appearance') || '(unset)',
        spinner: cs.getPropertyValue('-webkit-appearance'),
      });
    }
    return out;
  });
  const withSpinner = spinners.filter(s => s.appearance === 'auto' || s.appearance === 'number');
  withSpinner.length === 0 && spinners.length > 0
    ? ok('no up/down steppers on any number field in the form',
      `${spinners.length} inputs, all textfield`)
    : bad('steppers still drawn',
      withSpinner.length ? JSON.stringify(withSpinner) : 'no number inputs found to test');

  // No negative sign. `type="number"` does not do this on its own — it holds
  // "-5" and then refuses to submit, which reads as a broken form.
  const typed = await page.evaluate(() => {
    const tr = document.querySelector('.rq-tbl tbody tr');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const el = tr.querySelector('input.unit');
    set.call(el, '-500');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  });
  !typed.includes('-')
    ? ok('a typed minus sign is stripped from the unit price', `"${typed}"`)
    : bad('the field accepted a negative', typed);
  const typedPct = await page.evaluate(() => {
    const tr = document.querySelector('.rq-tbl tbody tr');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const el = tr.querySelector('input.pct');
    set.call(el, '-18');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  });
  !typedPct.includes('-')
    ? ok('and from the tax percent', `"${typedPct}"`)
    : bad('the tax field accepted a negative', typedPct);

  // -- 7b. the 100% cap, and the amount <-> percentage two-way sync ------------
  console.log('\n== 7b. a rate is held at 100, and an amount sets the rate ==');
  const row = '.rq-tbl tbody tr';
  const round2 = v => Math.round(Number((Number(v) + Number.EPSILON).toFixed(2)) * 100) / 100;
  const typeIn = async (sel, v) => {
    await page.evaluate(([s, val]) => {
      const tr = document.querySelector('.rq-tbl tbody tr');
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const el = tr.querySelector(s);
      set.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, [sel, v]);
    await page.waitForTimeout(120);
  };
  const read = async sel => (await page.locator(`${row} ${sel}`).first().inputValue());

  // Put the row into a known state FIRST. The earlier sections leave a rate on
  // it, and an expectation that ignores an input still on screen is an
  // expectation about a row nobody is reading.
  await typeIn('input.unit', '1000');
  await typeIn('input.disc', '0');
  await typeIn('input.pct', '0');
  // The 4th cell of the FIRST row is Qty. Scoped through the row locator rather
  // than `.first().nth(3)` — `.first()` resolves to a single <td>, and asking for
  // index 3 of one cell times out forever.
  const qtyB = num(await page.locator(`${row} td`).nth(3).innerText()) || 1;
  const grossB = round2(1000 * qtyB);
  console.log(`  [row 1: qty ${qtyB} x 1000 = gross ${grossB}]`);

  await typeIn('input.disc', '150');
  const capD = await read('input.disc');
  capD === '100'
    ? ok('a discount above 100 is held at 100', `"150" -> "${capD}"`)
    : bad('the discount took a value above 100', `got "${capD}"`);

  await typeIn('input.pct', '150');
  const capT = await read('input.pct');
  capT === '100'
    ? ok('and so is the tax', `"150" -> "${capT}"`)
    : bad('the tax took a value above 100', `got "${capT}"`);

  // With no price there is nothing to take a percentage of, so the amount
  // cannot be converted — it is disabled rather than silently swallowing keys.
  await typeIn('input.unit', '');
  const noBase = await page.locator(`${row} input.disc-amt`).first().isDisabled();
  noBase
    ? ok('the discount amount is disabled until there is a price', 'there is no base to divide')
    : bad('a discount amount can be typed with no price', 'it would be discarded, reading as a dead field');
  await typeIn('input.unit', '1000');

  // rate -> amount, then amount -> rate, then that it SETTLES. The last one is
  // the point of the feature: if the recovered rate did not regenerate the same
  // money, the figure would visibly change under the officer's cursor.
  await typeIn('input.disc', '0');
  await typeIn('input.pct', '0');
  await typeIn('input.disc', '10');
  const fromPct = num(await read('input.disc-amt'));
  Math.abs(fromPct - round2(grossB * 0.10)) < 0.005
    ? ok('a typed discount % sets the amount', `10% of ${grossB} = ${fromPct}`)
    : bad('the discount amount ignored the rate', `want ${round2(grossB * 0.10)} got ${fromPct}`);

  const typedDisc = round2(grossB * 0.25);
  await typeIn('input.disc-amt', String(typedDisc));
  const backPct = num(await read('input.disc'));
  Math.abs(backPct - 25) < 0.005
    ? ok('a typed discount amount sets the %', `${typedDisc} on ${grossB} = ${backPct}%`)
    : bad('the rate ignored the amount', `want 25 got ${backPct}`);
  const settledD = num(await read('input.disc-amt'));
  Math.abs(settledD - typedDisc) < 0.005
    ? ok('and the amount does not drift once set', `${typedDisc} still reads ${settledD}`)
    : bad('the discount amount moved under the cursor', `typed ${typedDisc}, now ${settledD}`);

  // Tax, before tax: the rate is charged on what the discount left, not on the
  // gross. Reading it off the gross instead would be the tax-exclusive slip.
  const netB = round2(grossB - typedDisc);
  const typedTax = round2(netB * 0.18);
  await typeIn('input.tax-amt', String(typedTax));
  const backTax = num(await read('input.pct'));
  Math.abs(backTax - 18) < 0.005
    ? ok('a typed tax amount sets the %, off the discounted base',
      `${typedTax} on ${netB} = ${backTax}%`)
    : bad('the tax rate ignored the amount', `want 18 off ${netB}, got ${backTax}`);
  const settledT = num(await read('input.tax-amt'));
  Math.abs(settledT - typedTax) < 0.005
    ? ok('and the tax amount does not drift either', `${typedTax} still reads ${settledT}`)
    : bad('the tax amount moved under the cursor', `typed ${typedTax}, now ${settledT}`);

  await page.screenshot({ path: `${OUT}-two-way.png` });

  // A blank line is not recorded, and the officer is told which ones.
  const notice = await page.locator('.rq-skip').count();
  notice === 1
    ? ok('blank lines are reported as "will not be recorded"',
      (await page.locator('.rq-skip').innerText()).replace(/\s+/g, ' ').slice(0, 72))
    : bad('no notice about blank lines', `${notice} found — a silent omission is how a 3-line quote reads as a whole-RFQ quote`);

  // Zero is refused at SAVE, not while typing — refusing the character would
  // make "0.50" untypeable, because the leading 0 is legitimate.
  await page.evaluate(() => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const el = document.querySelector('.rq-tbl tbody tr').querySelector('input.unit');
    set.call(el, '0');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(200);
  await page.locator('.rq-head .rq-btn.primary').click();
  await page.waitForTimeout(400);
  const saveErr = await page.locator('.rq-body .alert.error').innerText().catch(() => '');
  /greater than zero/i.test(saveErr) && /line \d+/i.test(saveErr)
    ? ok('Save refuses a 0.00 price and names the line', saveErr.replace(/\s+/g, ' ').slice(0, 80))
    : bad('zero price was not refused at save', saveErr || 'no error shown');

  await page.screenshot({ path: `${OUT}-rate-rules.png` });

  // -- 8. the upload control -------------------------------------------------
  console.log('\n== 8. the document control ==');
  const btnText = (await page.locator('.rq-upload .rq-upload-txt').innerText()).trim();
  btnText.startsWith('Upload Quotation')
    ? ok('the button reads "Upload Quotation"', btnText)
    : bad('upload button label', `"${btnText}"`);
  const stray = await page.locator('.rq-head').innerText();
  /Choose File|No file chosen/.test(stray)
    ? bad("the browser's default button text is still visible", stray.match(/.{0,30}(Choose File|No file chosen).{0,20}/)[0])
    : ok('no native "Choose File" / "No file chosen" text anywhere in the banner');
  const docWord = await page.locator('.rq-head .rq-req-note').count();
  docWord === 0
    ? ok('the redundant "document *" label is gone')
    : bad('stray document label', `${docWord} still present`);
  const star = await page.locator('.rq-upload .rq-req-star').count();
  star === 1
    ? ok('the required marker is on the button itself', 'so required-ness is not lost')
    : bad('required marker', `${star} found on the button`);
  // And it still opens a picker: the hidden input is driven by the label.
  const chooser = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
  await page.locator('.rq-upload').click();
  (await chooser)
    ? ok('clicking the label still opens the native file picker')
    : bad('file picker', 'clicking the button did not open a picker');

  console.log('\n== 9. a tax-inclusive line reconciles on screen ==');
  await page.evaluate(() => {
    const tr = document.querySelector('.rq-tbl tbody tr');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    // The discount is zeroed EXPLICITLY rather than assumed. Section 6 left 10%
    // on this row, and with it in place the extraction is entirely correct —
    // 236 quoted less 10% = 212.40 payable, of which 32.40 is tax — so the run
    // reported a failure for a line that was right. An expectation that ignores
    // an input still on screen is an expectation about a row nobody is reading.
    for (const [sel, v] of [['input.unit', '118'], ['input.disc', '0'], ['input.pct', '18']]) {
      const el = tr.querySelector(sel);
      set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await page.click('.rq-head .rq-toggles label:has-text("Prices include tax") input');
  await page.waitForTimeout(300);
  const line = await page.evaluate(() => {
    const tr = document.querySelectorAll('.rq-tbl tbody tr')[0];
    // An editable cell's figure is in its input's value, not its innerText.
    const n = [...tr.querySelectorAll('td')].map(td => {
      const input = td.querySelector('input');
      return input ? input.value.trim() : td.innerText.trim();
    });
    return { qty: n[3], gross: n[5], disc: n[7], net: n[8], tax: n[10], total: n[11] };
  });
  // Expectations DERIVED from the row's own quantity, not hard-coded. The first
  // run of this section asserted 118/100/18 and failed on a line of qty 2, where
  // 236 -> Net 200 + Tax 36 = Total 236 is not merely different but correct. A
  // fixture-shaped expectation is an assertion about the fixture.
  const qty = parseFloat(line.qty) || 1;
  const gross = Math.round(118 * qty * 100) / 100;
  const tax = Math.round((gross - gross / 1.18) * 100) / 100;
  const net = Math.round((gross - tax) * 100) / 100;
  const exclusive = Math.round(gross * 0.18 * 100) / 100;
  const want = [gross, net, tax, gross];
  const got = [line.gross, line.net, line.tax, line.total];
  // Numerically, not as "36.00" === "36": the tax cell is an input now and
  // prints the figure ungrouped. Comparing the strings would be asserting on
  // that presentation rather than on the extraction.
  const names = ['gross', 'net', 'tax', 'total'];
  console.log(`  [qty ${qty} | grid reads Gross ${line.gross} | Net ${line.net} | Tax ${line.tax} | Total ${line.total}]`);
  console.log(`  [independent: gross ${want[0].toFixed(2)} | net ${want[1].toFixed(2)} | tax ${want[2].toFixed(2)} | total ${want[3].toFixed(2)}]`);
  await page.screenshot({ path: `${OUT}-tax-inclusive.png` });
  got.every((g, i) => Math.abs(num(g) - want[i]) < 0.005)
    ? ok('the grid extracts the embedded tax out of the quoted amount',
      `${tax.toFixed(2)} of tax inside ${gross.toFixed(2)}, payable ${gross.toFixed(2)}`)
    : bad('inclusive grid figures',
      `got ${got.map((g, i) => `${names[i]} ${num(g)}`).join(' | ')} `
      + `want ${want.map((w, i) => `${names[i]} ${w.toFixed(2)}`).join(' | ')}`);
  Math.abs(num(line.tax) - exclusive) > 0.005
    ? ok('it is NOT the tax-exclusive rate', `${num(line.tax)} != ${exclusive.toFixed(2)}`)
    : bad('grid shows the exclusive rate', `${exclusive.toFixed(2)} - the old bug`);
  Math.abs(num(line.net) + num(line.tax) - num(line.total)) < 0.005
    ? ok('the printed columns reconcile', `${line.net} + ${line.tax} = ${line.total}`)
    : bad('columns do not reconcile', `${line.net} + ${line.tax} != ${line.total}`);
  const basisHidden = await page.locator('.rq-head input[name="rq-basis"]').count();
  basisHidden === 0
    ? ok('the before/after-tax radios hide while prices include tax',
      'one payable figure means there is no basis to choose')
    : bad('basis radios still shown', 'they would record a rule that is not applied');
  const stillBeforeTax = await page.locator('.rq-head input[name="rq-basis"]:checked')
    .evaluateAll(els => els.map(e => e.parentElement.textContent.trim()));
  void stillBeforeTax;

  await page.click('.rq-x');
  await browser.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  writeFileSync(`${OUT}-report.json`,
    JSON.stringify({ exp, col, lapFolded, lapOpen, line, pass, fail }, null, 2));
  process.exit(fail === 0 ? 0 : 1);
};

run().catch(e => { console.error('harness error:', e.message); process.exit(3); });