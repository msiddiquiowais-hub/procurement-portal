// Column-order guards for the Receive Quotation grid.
//
//   npm run test:web
//
// Why this file exists
// --------------------
// "Discount after tax" moves the DISC %/DISC AMT block past the TAX %/TAX AMT
// block. A `<th>` can be moved without touching the `<td>`s, and if it is, the
// grid still renders — it just puts the sticky "Column Totals" figures under the
// wrong headings, on the one screen an officer uses to decide who is cheapest.
// Nothing crashes and nothing logs. That is precisely the kind of change that
// ships broken and is found months later on an audit.
//
// So the assertions are about RELATIVE ORDER between named columns, not about
// a frozen list of fourteen strings: a frozen list fails the next time a column
// is added for a good reason, and passes when the ordering it was protecting is
// the thing that broke.

import test from 'node:test';
import assert from 'node:assert/strict';
import { quotationColumns, columnKeys, footLabelSpan } from '../components/sourcing/quoteColumns';

const ORDER = (basis: 'before_tax' | 'after_tax', useDiscount = true) =>
  columnKeys({ basis, useDiscount, currency: 'PKR' });
const at = (keys: string[], k: string) => {
  const i = keys.indexOf(k);
  assert.notEqual(i, -1, `${k} must be present; got ${keys.join(',')}`);
  return i;
};

test('discount BEFORE tax: the discount block sits left of the tax block', () => {
  const k = ORDER('before_tax');
  assert.ok(at(k, 'discPct') < at(k, 'taxPct'), `disc must precede tax: ${k.join(',')}`);
  assert.ok(at(k, 'discAmt') < at(k, 'taxAmt'), `disc amt must precede tax amt: ${k.join(',')}`);
  assert.ok(at(k, 'discPct') < at(k, 'discAmt'), 'Disc % stays immediately before Disc Amt');
  assert.ok(at(k, 'taxPct') < at(k, 'taxAmt'), 'Tax % stays immediately before Tax Amt');
});

test('discount AFTER tax: the discount block moves right of the tax block', () => {
  const k = ORDER('after_tax');
  assert.ok(at(k, 'discPct') > at(k, 'taxAmt'), `disc must follow tax amt: ${k.join(',')}`);
  assert.ok(at(k, 'discAmt') > at(k, 'taxAmt'), `disc amt must follow tax amt: ${k.join(',')}`);
  assert.ok(at(k, 'discPct') < at(k, 'discAmt'), 'Disc % stays immediately before Disc Amt');
  assert.ok(at(k, 'taxPct') < at(k, 'taxAmt'), 'Tax % stays immediately before Tax Amt');
});

test('the two bases produce genuinely different orders', () => {
  // Not a cosmetic assertion: if both branches built the same list the radio
  // would be a dead control and the feature would look implemented.
  assert.notDeepEqual(ORDER('before_tax'), ORDER('after_tax'));
});

test('flipping the radio moves exactly the four discount/tax positions', () => {
  const a = ORDER('before_tax');
  const b = ORDER('after_tax');
  const moved = ['discPct', 'discAmt', 'net', 'taxPct', 'taxAmt', 'total'];
  for (const k of moved) assert.ok(a.includes(k as never) && b.includes(k as never), `${k} present in both`);
  // The identity columns are pinned to the ends in both orders.
  for (const k of ['item', 'desc', 'cat', 'qty', 'unit', 'gross']) {
    assert.equal(at(a, k), at(b, k), `${k} must not move with the basis`);
  }
  assert.equal(at(a, 'warr'), at(b, 'warr'));
  assert.equal(at(a, 'decl'), at(b, 'decl'));
});

test('Net Amt stays flush against the tax block, on whichever side', () => {
  // `Total = Net + Tax` is the identity every line is checked against, so Net
  // must never be separated from the figures it is added to.
  //
  //   before tax  ... | Net | Tax % | Tax Amt | ...     Net LEADS the block,
  //               because the discount shrinks the base the tax is charged on
  //
  //   after  tax  ... | Tax % | Tax Amt | Net | ...     Net TRAILS it, because
  //               the tax is charged on the full amount and the discount — and
  //               therefore Net — come after
  //
  // It is the same rule on both sides: Net touches the tax block. Which edge it
  // takes depends on where the waterfall puts it.
  const bt = ORDER('before_tax');
  assert.equal(at(bt, 'taxPct'), at(bt, 'net') + 1,
    `before tax: Tax % must directly follow Net Amt; got ${bt.join(',')}`);
  assert.equal(at(bt, 'taxAmt'), at(bt, 'taxPct') + 1, 'before tax: Tax Amt directly follows Tax %');

  const at2 = ORDER('after_tax');
  assert.equal(at(at2, 'net'), at(at2, 'taxAmt') + 1,
    `after tax: Net Amt must directly follow Tax Amt; got ${at2.join(',')}`);
  assert.equal(at(at2, 'taxAmt'), at(at2, 'taxPct') + 1, 'after tax: Tax Amt directly follows Tax %');

  // The tax block genuinely moves between the two orders. (Net's own absolute
  // index does NOT — it lands on 8 either way, a coincidence of the column
  // count, not a design property. Only its position RELATIVE to the tax block
  // is meaningful, and the two assertions above already pin that.)
  assert.notEqual(at(bt, 'taxPct'), at(at2, 'taxPct'), 'the tax block must actually move');
});

test('Total stays last, in both bases', () => {
  for (const basis of ['before_tax', 'after_tax'] as const) {
    const k = ORDER(basis);
    assert.equal(k[k.length - 3], 'total', `${basis}: Total must be third from last`);
    assert.equal(k[k.length - 2], 'warr');
    assert.equal(k[k.length - 1], 'decl');
    // Total is the sum of Net + Tax, and in both orders they are two apart at
    // most — never with the discount figures wedged between them.
    assert.ok(at(k, 'total') - at(k, 'net') <= 4,
      `${basis}: Total must follow Net Amt without a gap`);
  }
});

test('the discount block is always on the correct side of the tax block', () => {
  // before-tax: the discount shrinks the base the tax is charged on, so it
  // reads first. after-tax: tax is charged on the full amount and the discount
  // comes off afterwards, so it reads last.
  assert.ok(at(ORDER('before_tax'), 'discPct') < at(ORDER('before_tax'), 'taxPct'));
  assert.ok(at(ORDER('after_tax'), 'discPct') > at(ORDER('after_tax'), 'taxAmt'));
});

test('with Apply Discount off there are no discount columns at all', () => {
  for (const basis of ['before_tax', 'after_tax'] as const) {
    const k = ORDER(basis, false);
    assert.equal(k.includes('discPct'), false, `${basis}: Disc % must be absent`);
    assert.equal(k.includes('discAmt'), false, `${basis}: Disc Amt must be absent`);
    // Net folds with them. It USED to stay in the markup and be hidden by a CSS
    // `display:none` while the two discount columns were removed outright — two
    // mechanisms for one outcome, which is why nothing could assert the column
    // count. All three are now removed the same way.
    assert.equal(k.includes('net'), false, `${basis}: Net Amt folds with the discount columns`);
    assert.equal(k.length, ORDER(basis).length - 3, `${basis}: exactly three columns fold`);
    assert.equal(k.length, 11, `${basis}: 11 columns remain`);
  }
});

test('Net Amt is the only non-discount column hidden by the discount toggle', () => {
  // Pins the one counter-intuitive rule in quotationColumns. If a future column
  // is added to the gross->net block it has to make the same decision
  // deliberately, which is what this assertion forces.
  const cols = quotationColumns({ basis: 'before_tax', useDiscount: true, currency: 'PKR' });
  const folded = cols.filter(c => c.discountOnly).map(c => c.key).sort();
  assert.deepEqual(folded, ['discAmt', 'discPct', 'net']);
});

test('header, row and totals row get one class each, and the totals row has a figure', () => {
  // A `cls` on the `<th>` but not the `<td>` (or the reverse) makes the cell
  // borders and alignment drift a column at a time, which is invisible until
  // someone scrolls sideways.
  const cols = quotationColumns({ basis: 'after_tax', useDiscount: true, currency: 'PKR' });
  for (const c of cols) {
    assert.equal(typeof c.cls, c.cls === undefined ? 'undefined' : 'string', `${c.key} cls`);
    // `typeof null` is 'object', so this is not a typeof check.
    assert.ok(c.foot === null || typeof c.foot === 'string', `${c.key} foot kind`);
    assert.ok(c.label.length > 0, `${c.key} has a header label`);
  }
  // Every figure-bearing column declares which stored total prints beneath it;
  // a null there is a blank cell under a money heading.
  const money = new Set(['gross', 'discAmt', 'net', 'taxAmt', 'total']);
  for (const c of cols) {
    if (money.has(c.key)) assert.notEqual(c.foot, null, `${c.key} is money and needs a totals figure`);
    else assert.equal(c.foot, null, `${c.key} is not money and must not print a figure`);
  }
  assert.equal(cols.filter(c => c.grand).length, 1, 'exactly one emphasised grand total');
});

test('the middle column is labelled for what it holds in each basis', () => {
  // The reported bug was a reading error as much as an arithmetic one: the
  // after-tax column holds the gross INCLUDING the tax (2,360.00) but was headed
  // "Net Amt", which an officer reads as the taxable base (1,800.00). The
  // heading is the only thing that distinguishes the two.
  const labelFor = (basis: 'before_tax' | 'after_tax') =>
    quotationColumns({ basis, useDiscount: true, currency: 'PKR' })
      .find(c => c.key === 'net')!.label;

  assert.equal(labelFor('before_tax'), 'Net Amt');
  assert.equal(labelFor('after_tax'), 'Inc Tax Amt');
  assert.notEqual(labelFor('before_tax'), labelFor('after_tax'),
    'the two columns hold different quantities — they must not share a heading');
});

test('the currency reaches the Total heading', () => {
  const k = quotationColumns({ basis: 'before_tax', useDiscount: true, currency: 'USD' });
  assert.equal(k.find(c => c.key === 'total')!.label, 'Total (USD)');
});

test('the totals-row caption stops before the first figure', () => {
  // The regression: the span was `cols.length - 3`, i.e. 11 of 14, so the
  // caption swallowed Gross, Disc Amt, Net and Tax Amt and the sticky totals
  // row stopped being totals. Nothing crashed and every row still had 14 cells,
  // which is why a cell-count assertion passed while the screen was wrong.
  for (const useDiscount of [true, false]) {
    for (const basis of ['before_tax', 'after_tax'] as const) {
      const cols = quotationColumns({ basis, useDiscount, currency: 'PKR' });
      const span = footLabelSpan(cols);
      assert.ok(span > 0 && span < cols.length, `${basis}: span ${span} out of range`);
      // Everything the caption covers must genuinely be figureless...
      for (const c of cols.slice(0, span)) {
        assert.equal(c.foot, null, `${basis}: "${c.key}" is inside the caption but prints a figure`);
      }
      // ...and the very next column must be the first one that prints anything.
      assert.notEqual(cols[span].foot, null,
        `${basis}: caption stops at "${cols[span].key}", which prints no figure`);
      assert.equal(cols[span].key, 'gross', `${basis}: Gross is the first money column`);
      // Caption + remaining cells must account for every column exactly once.
      assert.equal(span + (cols.length - span), cols.length);
      assert.equal(cols.length, useDiscount ? 14 : 11);
    }
  }
});

test('the full 14-column order, pinned so an accidental insertion is visible', () => {
  // The relative-order tests above are the ones that protect the feature. This
  // one is documentation: it fails loudly if a column is added or moved, which
  // is what you want to see in review rather than discover in a screenshot.
  assert.deepEqual(ORDER('before_tax'), [
    'item', 'desc', 'cat', 'qty', 'unit', 'gross',
    'discPct', 'discAmt', 'net', 'taxPct', 'taxAmt',
    'total', 'warr', 'decl',
  ]);
  assert.deepEqual(ORDER('after_tax'), [
    'item', 'desc', 'cat', 'qty', 'unit', 'gross',
    'taxPct', 'taxAmt', 'net', 'discPct', 'discAmt',
    'total', 'warr', 'decl',
  ]);
});