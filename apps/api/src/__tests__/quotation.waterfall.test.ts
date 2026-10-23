// Unit tests for the per-line pricing waterfall.
//
//   npm run test:api
//
// Why this file exists
// --------------------
// "Prices include tax" was wrong, and it was wrong in a way no status code
// reports. The stored total was correct — it was never double-stacked — but the
// tax AMOUNT printed and stored beside it was the tax-EXCLUSIVE rate applied to
// a tax-inclusive price. For a 118.00 line at 18% that recorded 21.24 as the
// tax when the tax genuinely inside 118.00 is 18.00: the officer was told 21.24
// of tax was charged on a document that charges 18.00, and the form's own
// columns did not add up (Net 118.00 + Tax 21.24 = 139.24 against a Total of
// 118.00).
//
// Nothing failed. The quote saved, the total was right, and only the tax figure
// was fiction — which is exactly the class of defect a unit test has to catch,
// because the integration suite asserts on totals that never moved.
//
// EXPECTED VALUES ARE LITERALS, NOT RECOMPUTATIONS. Each case below states the
// six figures a tax document has to show. A test that re-derived them with the
// same formula it is testing would agree with a broken implementation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteLineWaterfall, round2 } from '../sourcing/quotation.service';

const F = (unit: number, qty: number, discountPercent: number, taxPercent: number,
          taxesIncluded: boolean, basis: 'before_tax' | 'after_tax' = 'before_tax') =>
  quoteLineWaterfall({ unit, qty, discountPercent, taxPercent, taxesIncluded, basis });

test('tax-EXCLUSIVE: gross, discount, net, tax, total read straight off the rate', () => {
  const w = F(100, 2, 10, 18, false);
  assert.equal(w.gross, 200);            // 2 x 100
  assert.equal(w.discount, 20);          // 10% of 200
  assert.equal(w.net, 180);              // 200 - 20
  assert.equal(w.tax, 32.4);             // 18% of 180
  assert.equal(w.lineTotal, 212.4);      // 180 + 32.40
});

test('after-tax basis taxes the GROSS, and the discount comes off that', () => {
  // THE REPORTED BUG, pinned. 2 EA x 1000, 18% tax, 10% discount.
  //
  // It used to subtract the discount from the GROSS and then add the tax:
  //   net = 2,000 - 200 = 1,800;  total = 1,800 + 360 = 2,160
  // which billed 36.00 MORE than the same quote under the before-tax basis, for
  // a total that must not depend on which side the discount was read from.
  const w = F(1000, 2, 10, 18, false, 'after_tax');
  assert.equal(w.gross, 2000);
  assert.equal(w.tax, 360);          // 18% of the GROSS, not of 1,800
  assert.equal(w.net, 2360);         // gross INCLUDING tax — "Inc Tax Amt"
  assert.equal(w.discount, 236);     // 10% of 2,360, not of 2,000
  assert.equal(w.lineTotal, 2124);   // 2,360 - 236
  assert.notEqual(w.net, 1800, 'net must NOT be the gross less the discount here');
  assert.notEqual(w.lineTotal, 2160, 'the old total billed 36.00 too much');
});

test('the two exclusive bases agree on what is payable, and differ on the split', () => {
  // This is what makes the toggle meaningful rather than a trap: the same quote
  // costs the buyer the same either way. What changes is the tax remittance and
  // the discount the vendor actually granted.
  const before = F(1000, 2, 10, 18, false, 'before_tax');
  const after = F(1000, 2, 10, 18, false, 'after_tax');
  assert.equal(before.lineTotal, 2124);
  assert.equal(after.lineTotal, 2124);
  assert.equal(before.lineTotal, after.lineTotal,
    'the payable amount must not depend on the basis');

  assert.equal(before.tax, 324);     // 18% of the 1,800 base
  assert.equal(after.tax, 360);      // 18% of the full 2,000
  assert.equal(before.discount, 200);// 10% of 2,000
  assert.equal(after.discount, 236); // 10% of 2,360
  assert.notEqual(before.tax, after.tax, 'the tax charged must differ');
  assert.notEqual(before.discount, after.discount, 'the discount granted must differ');

  // Both reduce to gross x (1 + t) x (1 - d), so the totals reconcile on paper.
  assert.equal(after.lineTotal, round2(2000 * 1.18 * 0.9));
  assert.equal(before.lineTotal, round2(2000 * 0.9 * 1.18));
});

test('on an exact half-paisa the bases differ by ONE paisa, and that is correct', () => {
  // 12,500 gross at 17.5% tax and 5% off gives exactly 13,953.125 — a half-paisa
  // tie. Each basis is the sum of its OWN rounded components, which is the rule
  // this form follows (round each component to 2dp, THEN add), and the two round
  // at different intermediate steps:
  //
  //   before-tax  11,875.00 + 2,078.13   tax      2078.125 rounds UP
  //   after-tax   14,687.50 - 734.38    discount  734.375 rounds UP
  //
  // An earlier assertion here demanded exact equality, which was asserting a
  // coincidence of rounding order rather than a property of the maths. It went
  // red on one fixture out of many — the definition of a flaky assertion.
  const before = F(12500, 1, 5, 17.5, false, 'before_tax');
  const after = F(12500, 1, 5, 17.5, false, 'after_tax');
  assert.equal(before.lineTotal, 13953.13);
  assert.equal(after.lineTotal, 13953.12);
  assert.equal(round2(after.lineTotal - before.lineTotal), -0.01);

  const exact = 12500 * 1.175 * 0.95;             // 13953.125
  assert.equal(exact, 13953.125, 'this fixture must actually be a half-paisa tie');
  // Both are within half a paisa of exact — neither is wrong.
  assert.ok(Math.abs(before.lineTotal - exact) <= 0.01);
  assert.ok(Math.abs(after.lineTotal - exact) <= 0.01);
  // And each basis is internally consistent with its own printed columns.
  assert.equal(before.lineTotal, round2(before.net + before.tax));
  assert.equal(after.lineTotal, round2(after.net - after.discount));
});

test('after-tax: Total = Inc Tax Amt less Disc Amt', () => {
  for (const [unit, qty, disc, tax] of [
    [1000, 2, 10, 18], [12500, 2, 5, 17.5], [99.99, 3, 7.5, 17], [45000, 2, 12.5, 16],
  ] as const) {
    const w = F(unit, qty, disc, tax, false, 'after_tax');
    assert.equal(w.lineTotal, round2(w.net - w.discount),
      `after_tax: ${w.lineTotal} must be ${w.net} - ${w.discount}`);
    assert.equal(w.net, round2(w.gross + w.tax), 'Inc Tax Amt = gross + tax');
    assert.equal(w.discount, round2(w.net * disc / 100), 'the discount is off the inc-tax figure');
  }
});

test('before-tax: Total = Net + Tax, on the discounted base', () => {
  const w = F(1000, 2, 10, 18, false, 'before_tax');
  assert.equal(w.discount, 200);
  assert.equal(w.net, 1800);
  assert.equal(w.tax, 324);
  assert.equal(w.lineTotal, 2124);
  assert.equal(w.lineTotal, round2(w.net + w.tax));
});

test('tax-INCLUSIVE: the tax is EXTRACTED out of the quoted price', () => {
  const w = F(118, 1, 0, 18, true);
  assert.equal(w.gross, 118);
  assert.equal(w.tax, 18);               // 118 contains 18 of tax; the base is 100
  assert.equal(w.net, 100);
  assert.equal(w.lineTotal, 118);        // you pay exactly what was quoted
});

test('REGRESSION: an inclusive quote must not report the tax-EXCLUSIVE rate', () => {
  // The bug, pinned. 118 x 18% = 21.24 is the figure the old code stored as the
  // tax on a price that already contained 18.00 of it. If this assertion ever
  // needs loosening, the form is overstating tax on every inclusive quote.
  const w = F(118, 1, 0, 18, true);
  assert.notEqual(w.tax, round2(118 * 0.18));
  assert.equal(w.tax, 18);
  // And it was never a stacking bug either — the total was always the quote.
  assert.notEqual(w.lineTotal, round2(118 + 21.24));
});

test('tax-INCLUSIVE with a discount: the discount comes off the quoted amount', () => {
  // 200 incl. 10% discount -> the vendor quotes 180 payable. The 18% tax is
  // inside that 180, not on top of it.
  const w = F(100, 2, 10, 18, true);
  assert.equal(w.gross, 200);
  assert.equal(w.discount, 20);
  assert.equal(w.tax, 27.46);            // 180 - 180/1.18
  assert.equal(w.net, 152.54);           // 180 - 27.46
  assert.equal(w.lineTotal, 180);        // net + tax === what was quoted
});

test('the inclusive total is lower than the exclusive total for the same rate', () => {
  // Same typed unit price, only the checkbox differs. Inclusive must not exceed
  // exclusive — that ordering is what "no double-stacking" means numerically.
  const incl = F(118, 1, 0, 18, true);
  const excl = F(118, 1, 0, 18, false);
  assert.ok(incl.lineTotal < excl.lineTotal,
    `inclusive ${incl.lineTotal} must be less than exclusive ${excl.lineTotal}`);
  assert.equal(excl.lineTotal, 139.24);  // 118 + 18% on top
});

test('a 0% tax needs no special case: both modes agree exactly', () => {
  const incl = F(100, 2, 10, 0, true);
  const excl = F(100, 2, 10, 0, false);
  assert.deepEqual(incl, excl);
  assert.equal(incl.lineTotal, 180);
});

test('EACH mode has its own identity, and the mode selects which', () => {
  // There is no single global identity any more, and that is the point: the
  // column order and the "Inc Tax Amt" heading tell the reader which arithmetic
  // they are looking at. Asserting one identity everywhere would have hidden
  // the after-tax error rather than caught it.
  const sumCases = [
    F(118, 1, 0, 18, true), F(118, 1, 0, 18, false),
    F(100, 2, 10, 18, true), F(100, 2, 10, 18, false, 'before_tax'),
    F(99.99, 3, 7.5, 17, true), F(99.99, 3, 7.5, 17, false, 'before_tax'),
    F(0.07, 1, 0, 18, true), F(250000, 4, 3.25, 5, true),
    F(1, 1, 100, 18, true), F(45000, 2, 12.5, 16, false, 'before_tax'),
  ];
  for (const w of sumCases) {
    assert.equal(w.lineTotal, round2(w.net + w.tax),
      `Total must equal Net + Tax (net=${w.net} tax=${w.tax} total=${w.lineTotal})`);
  }
  const diffCases = [
    F(1000, 2, 10, 18, false, 'after_tax'),
    F(12500, 2, 5, 17.5, false, 'after_tax'),
    F(45000, 2, 12.5, 16, false, 'after_tax'),
    F(100, 2, 0, 18, false, 'after_tax'),
  ];
  for (const w of diffCases) {
    assert.equal(w.lineTotal, round2(w.net - w.discount),
      `after-tax Total must equal Inc Tax Amt - Disc (net=${w.net} disc=${w.discount})`);
    assert.notEqual(round2(w.net - w.discount), round2(w.net + w.tax),
      'the two identities must actually differ, or the mode is not being applied');
  }
});

test('no line can bill less than its gross when tax is charged', () => {
  // Both exclusive bases reduce to gross x (1 + t) x (1 - d), so the total is
  // pinned to the gross from below by (1 - d) and from above by (1 + t). A line
  // that drifted outside that band would be a rounding bug or a wrong sign.
  for (const basis of ['before_tax', 'after_tax'] as const) {
    for (const disc of [0, 10, 33.33]) {
      for (const tax of [0, 5, 18]) {
        const w = quoteLineWaterfall({ unit: 1000, qty: 2, discountPercent: disc, taxPercent: tax, taxesIncluded: false, basis });
        const lo = round2(2000 * (1 - disc / 100));
        const hi = round2(2000 * (1 + tax / 100) * (1 - disc / 100));
        assert.ok(w.lineTotal >= lo && w.lineTotal <= hi + 0.02,
          `${basis} d=${disc} t=${tax}: ${w.lineTotal} outside [${lo}, ${hi}]`);
      }
    }
  }
});

test('an inclusive line pays exactly the quoted amount, whatever the rate', () => {
  // Swept rather than sampled: the extraction is a division, and a single
  // hand-picked case says nothing about the other 999 rates an officer can type.
  for (const taxPercent of [0, 5, 8, 17, 18, 20, 25]) {
    for (const discountPercent of [0, 10, 33.33, 100]) {
      for (const [unit, qty] of [[118, 1], [99.99, 3], [45000, 2], [0.03, 7]] as const) {
        const w = quoteLineWaterfall({ unit, qty, discountPercent, taxPercent, taxesIncluded: true, basis: 'before_tax' });
        const quoted = round2(round2(unit * qty) - round2(round2(unit * qty) * discountPercent / 100));
        assert.equal(w.lineTotal, quoted,
          `incl t=${taxPercent}% d=${discountPercent}% unit=${unit} must pay the quoted ${quoted}, paid ${w.lineTotal}`);
        assert.ok(w.net >= 0 && w.tax >= 0, 'no negative split');
        assert.ok(w.tax <= w.lineTotal + 1e-9, 'the extracted tax cannot exceed the price it came out of');
      }
    }
  }
});

test('round2 agrees with toFixed on the values a money column actually shows', () => {
  // round2 is the API's helper; the browser used to carry its own
  // `Math.round(v * 100) / 100`, which returns 10390.624999999999 for 10390.625
  // because of binary floating point. The browser now uses this same form.
  assert.equal(round2(10390.625), 10390.63);
  assert.equal(round2(0.005), 0.01);
  assert.equal(round2(0.07), 0.07);

  // A value written as .xx5 in source is not .xx5 in memory: 118.005 is stored
  // as 118.00499999999999545, so it rounds DOWN. Asserting 118.01 here would be
  // asserting a fiction — the figure is decided by the stored value, not the
  // literal you typed. (Verified, not assumed.)
  assert.equal(round2(118.005), 118);
  assert.equal(round2(2.675), 2.67);

  // The EPSILON is load-bearing in the other direction: 1.005 is stored just
  // below the tie, and nudging it up before toFixed is what makes the sum of
  // the printed lines match the printed total.
  assert.equal((1.005).toFixed(2), '1.00');
  assert.equal(round2(1.005), 1.01);
});