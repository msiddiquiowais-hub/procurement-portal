// The browser's copy of the per-line pricing waterfall.
//
//   npm run test:web
//
// WHY THIS FILE EXISTS
// --------------------
// The Receive Quotation grid shows six derived figures per line — gross,
// discount, net, tax and the line total — and the officer reads them, trusts
// them, and presses Save. The server then recomputes all six and stores its own.
// Nothing compares the two. So if this module and the API's
// `quoteLineWaterfall` ever disagree, the quote that gets recorded is not the
// quote that was on screen, and the officer finds out at the comparative
// statement, days later, as a difference with no visible cause.
//
// This suite is the drift alarm. It asserts the SAME LITERAL figures as
// apps/api/src/__tests__/quotation.waterfall.test.ts. Literals on purpose: a
// test that re-derived the answers using the formula it is testing would pass
// happily against a broken implementation, which is precisely how the original
// bug survived — the total was right, so every total-shaped assertion passed.
//
// It also pins the specific regression, so "prices include tax" cannot quietly
// go back to reporting the tax-exclusive rate.

import test from 'node:test';
import assert from 'node:assert/strict';
import { waterfall, round2, EMPTY, taxModeNote, sanitizeRate, sanitizePercent, netOf, discountBaseOf, taxBaseOf, discountPercentFromAmount, taxPercentFromAmount } from '../components/sourcing/quoteMath';

test('a rate field cannot hold a negative sign', () => {
  // `type="number"` does not do this on its own — it will hold "-5" and then
  // refuse to submit, which reads as a broken form rather than a bad value.
  for (const bad of ['-5', '-0.5', '-', '1-2', '10-', '-100', 'abc-1', '−5']) {
    const got = sanitizeRate(bad);
    assert.ok(!got.includes('-'), `"${bad}" must not survive as "${got}"`);
    assert.ok(/^[0-9.]*$/.test(got), `"${got}" must be digits and dots only`);
  }
  assert.equal(sanitizeRate('-5'), '5');
  assert.equal(sanitizeRate('1-2'), '12');
  assert.equal(sanitizeRate('-'), '');
});

test('a rate field keeps exactly one decimal point', () => {
  // Two dots make the value unparseable, and `type="number"` silently refuses
  // to submit — the officer is left staring at a field that looks filled.
  assert.equal(sanitizeRate('1.2.3'), '1.23');
  assert.equal(sanitizeRate('...'), '.');
  assert.equal(sanitizeRate('12..5'), '12.5');
  assert.equal(sanitizeRate('0.50'), '0.50', 'a legitimate decimal must survive');
  assert.equal(sanitizeRate('.5'), '.5');
  assert.equal(sanitizeRate('100'), '100');
  assert.equal(sanitizeRate('18'), '18');
  assert.equal(sanitizeRate(''), '');
  assert.equal(sanitizeRate('  7  '), '7');
});

test('sanitising never turns a typed value into a negative number', () => {
  for (const input of ['-1', '-0.01', '-100', '-1e5', '0-5', '-']) {
    assert.ok(Number(sanitizeRate(input)) >= 0,
      `"${input}" must not parse to a negative: got ${sanitizeRate(input)}`);
  }
});

const F = (unit: number, qty: number, discountPercent: number, taxPercent: number,
          taxesIncluded: boolean, basis: 'before_tax' | 'after_tax' = 'before_tax') =>
  waterfall({ unit, qty, discountPercent, taxPercent, taxesIncluded, basis });

test('tax-EXCLUSIVE: gross, discount, net, tax, total read straight off the rate', () => {
  const w = F(100, 2, 10, 18, false);
  assert.equal(w.gross, 200);
  assert.equal(w.discount, 20);
  assert.equal(w.net, 180);
  assert.equal(w.tax, 32.4);
  assert.equal(w.lineTotal, 212.4);
});

test('after-tax basis taxes the GROSS, and the discount comes off that', () => {
  // THE REPORTED BUG. 2 EA x 1000, 18% tax, 10% discount. It used to subtract
  // the discount from the GROSS (1,800) and then add the tax, billing 2,160 —
  // 36.00 more than the same quote under the before-tax basis, for a total that
  // must not depend on which side the officer read the discount from.
  const w = F(1000, 2, 10, 18, false, 'after_tax');
  assert.equal(w.gross, 2000);
  assert.equal(w.tax, 360);          // 18% of the GROSS, not of 1,800
  assert.equal(w.net, 2360);         // gross INCLUDING tax — "Inc Tax Amt"
  assert.equal(w.discount, 236);     // 10% of 2,360, not of 2,000
  assert.equal(w.lineTotal, 2124);   // 2,360 - 236
  assert.notEqual(w.net, 1800);
  assert.notEqual(w.lineTotal, 2160);
});

test('on an exact half-paisa the bases differ by ONE paisa, and that is correct', () => {
  // 12,500 gross at 17.5% and 5% off is exactly 13,953.125 — a half-paisa tie.
  // Each basis is the sum of its OWN rounded components (round each to 2dp, THEN
  // add), and they round at different intermediate steps, so they land on
  // opposite sides of the tie. Demanding exact equality here asserted a
  // coincidence of rounding order, not a property of the maths.
  const before = F(12500, 1, 5, 17.5, false, 'before_tax');
  const after = F(12500, 1, 5, 17.5, false, 'after_tax');
  assert.equal(before.lineTotal, 13953.13);
  assert.equal(after.lineTotal, 13953.12);
  assert.equal(before.lineTotal, round2(before.net + before.tax));
  assert.equal(after.lineTotal, round2(after.net - after.discount));
  const exact = 12500 * 1.175 * 0.95;
  assert.ok(Math.abs(before.lineTotal - exact) <= 0.01);
  assert.ok(Math.abs(after.lineTotal - exact) <= 0.01);
});

test('before-tax: Total = Net + Tax, on the discounted base', () => {
  const w = F(1000, 2, 10, 18, false, 'before_tax');
  assert.equal(w.discount, 200);
  assert.equal(w.net, 1800);
  assert.equal(w.tax, 324);
  assert.equal(w.lineTotal, 2124);
  assert.equal(w.lineTotal, round2(w.net + w.tax));
});

test('after-tax: Total = Inc Tax Amt less Disc Amt', () => {
  for (const [unit, qty, disc, tax] of [
    [1000, 2, 10, 18], [12500, 2, 5, 17.5], [99.99, 3, 7.5, 17], [45000, 2, 12.5, 16],
  ] as const) {
    const w = waterfall({ unit, qty, discountPercent: disc, taxPercent: tax, taxesIncluded: false, basis: 'after_tax' });
    assert.equal(w.lineTotal, round2(w.net - w.discount));
    assert.equal(w.net, round2(w.gross + w.tax));
    assert.equal(w.discount, round2(w.net * disc / 100));
  }
});

test('EACH mode has its own identity, and the mode selects which', () => {
  // No single global identity any more — the column order and the "Inc Tax Amt"
  // heading tell the reader which arithmetic they are reading. One identity
  // asserted everywhere would have HIDDEN the after-tax error.
  for (const w of [F(118, 1, 0, 18, true), F(100, 2, 10, 18, false), F(99.99, 3, 7.5, 17, true)]) {
    assert.equal(w.lineTotal, round2(w.net + w.tax));
  }
  for (const w of [F(1000, 2, 10, 18, false, 'after_tax'), F(45000, 2, 12.5, 16, false, 'after_tax')]) {
    assert.equal(w.lineTotal, round2(w.net - w.discount));
    assert.notEqual(round2(w.net - w.discount), round2(w.net + w.tax));
  }
});

test('no line can bill less than its gross when tax is charged', () => {
  for (const basis of ['before_tax', 'after_tax'] as const) {
    for (const disc of [0, 10, 33.33]) {
      for (const tax of [0, 5, 18]) {
        const w = waterfall({ unit: 1000, qty: 2, discountPercent: disc, taxPercent: tax, taxesIncluded: false, basis });
        const lo = round2(2000 * (1 - disc / 100));
        const hi = round2(2000 * (1 + tax / 100) * (1 - disc / 100));
        assert.ok(w.lineTotal >= lo && w.lineTotal <= hi + 0.02,
          `${basis} d=${disc} t=${tax}: ${w.lineTotal} outside [${lo}, ${hi}]`);
      }
    }
  }
});

test('tax-INCLUSIVE: the tax is EXTRACTED out of the quoted price', () => {
  const w = F(118, 1, 0, 18, true);
  assert.equal(w.gross, 118);
  assert.equal(w.tax, 18);        // 118 contains 18 of tax; the base is 100
  assert.equal(w.net, 100);
  assert.equal(w.lineTotal, 118); // you pay exactly what was quoted
});

test('REGRESSION: an inclusive quote must not report the tax-EXCLUSIVE rate', () => {
  // The bug, pinned. The old grid showed 118 × 18% = 21.24 as the tax on a
  // price that already contained 18.00 of it — an overstated charge on every
  // inclusive quote, and a grid whose columns did not sum to its own total.
  const w = F(118, 1, 0, 18, true);
  assert.notEqual(w.tax, round2(118 * 0.18));
  assert.equal(w.tax, 18);
  assert.notEqual(w.lineTotal, round2(118 + 21.24));
});

test('tax-INCLUSIVE with a discount: the discount comes off the quoted amount', () => {
  const w = F(100, 2, 10, 18, true);
  assert.equal(w.gross, 200);
  assert.equal(w.discount, 20);
  assert.equal(w.tax, 27.46);
  assert.equal(w.net, 152.54);
  assert.equal(w.lineTotal, 180);
});

test('the inclusive total is lower than the exclusive total for the same rate', () => {
  assert.ok(F(118, 1, 0, 18, true).lineTotal < F(118, 1, 0, 18, false).lineTotal);
  assert.equal(F(118, 1, 0, 18, false).lineTotal, 139.24);
});

test('a 0% tax needs no special case: both modes agree exactly', () => {
  assert.deepEqual(F(100, 2, 10, 0, true), F(100, 2, 10, 0, false));
  assert.equal(F(100, 2, 10, 0, true).lineTotal, 180);
});

test('TOTAL = NET + TAX in the before-tax and inclusive modes only', () => {
  // after-tax has its own identity (Inc Tax Amt - Disc Amt) and is asserted
  // separately above. Folding it in here would have passed while the 2,160
  // error stood, because 1,800 + 360 did satisfy net + tax.
  const cases = [
    F(118, 1, 0, 18, true), F(118, 1, 0, 18, false),
    F(100, 2, 10, 18, true), F(100, 2, 10, 18, false),
    F(99.99, 3, 7.5, 17, true), F(99.99, 3, 7.5, 17, false),
    F(0.07, 1, 0, 18, true), F(250000, 4, 3.25, 5, true),
    F(1, 1, 100, 18, true), F(45000, 2, 12.5, 16, false),
  ];
  for (const w of cases) {
    assert.equal(w.lineTotal, round2(w.net + w.tax),
      `Total must equal Net + Tax (net=${w.net} tax=${w.tax} total=${w.lineTotal})`);
  }
});

test('after-tax does NOT satisfy Net + Tax — that is how the bug hid', () => {
  // With the old figures (net 1,800 / tax 360 / total 2,160) the after-tax line
  // satisfied net + tax exactly, so a global identity test passed while the
  // officer was being over-billed 36.00. Pin the divergence.
  const w = F(1000, 2, 10, 18, false, 'after_tax');
  assert.notEqual(round2(w.net + w.tax), w.lineTotal);
  assert.equal(round2(w.net + w.tax), 2720);
  assert.equal(w.lineTotal, 2124);
});

test('an inclusive line pays exactly the quoted amount, whatever the rate', () => {
  for (const taxPercent of [0, 5, 8, 17, 18, 20, 25]) {
    for (const discountPercent of [0, 10, 33.33, 100]) {
      for (const [unit, qty] of [[118, 1], [99.99, 3], [45000, 2], [0.03, 7]] as const) {
        const w = waterfall({ unit, qty, discountPercent, taxPercent, taxesIncluded: true, basis: 'before_tax' });
        const gross = round2(unit * qty);
        const quoted = round2(gross - round2(gross * discountPercent / 100));
        assert.equal(w.lineTotal, quoted,
          `incl t=${taxPercent}% d=${discountPercent}% unit=${unit} must pay ${quoted}, paid ${w.lineTotal}`);
        assert.ok(w.tax >= 0 && w.tax <= w.lineTotal + 1e-9);
      }
    }
  }
});

test('a declined line contributes nothing, and is not a zero-priced quote', () => {
  // The prototype's per-line "declined" checkbox means "will not supply this",
  // which is not the same claim as "supplies it free". EMPTY is what the grid
  // and the payload both use for it.
  assert.equal(EMPTY.lineTotal, 0);
  assert.equal(EMPTY.gross, 0);
  assert.equal(EMPTY.net, 0);
  assert.equal(EMPTY.tax, 0);
});

test('round2 matches the API form on values that break naive rounding', () => {
  // The API uses `+(v).toFixed(2)`; a browser-side `Math.round(v * 100) / 100`
  // returns 10390.624999999999 here. If this ever changes, the printed columns
  // stop matching the stored quote by a paisa.
  assert.equal(round2(10390.625), 10390.63);
  assert.equal(round2(0.07), 0.07);
  assert.equal(round2(118.005), 118);   // stored as 118.00499999999999545
  assert.equal(round2(1.005), 1.01);    // EPSILON nudges the tie up
});

test('the mode note says the tax is never added twice when prices include it', () => {
  const incl = taxModeNote(true, 'before_tax');
  assert.match(incl, /never added again/i);
  assert.match(incl, /Total = Net \+ Tax/);
  // The basis is irrelevant once the price is inclusive, and saying so stops an
  // officer reading the hidden radio pair as still in force.
  assert.match(incl, /discount comes off the quoted amount/i);

  const excl = taxModeNote(false, 'after_tax');
  assert.match(excl, /full amount/i);
  assert.doesNotMatch(excl, /never added again/i);
});
// ── the 100% cap ─────────────────────────────────────────────────────────────

test('a percentage cannot be typed above 100', () => {
  // Clamped, not refused. Refusing the keystroke that would cross 100 turns a
  // typed "150" into "15" - a different, plausible number the officer never
  // meant. Clamping lands on 100, which is what they were told cannot be passed.
  assert.equal(sanitizePercent('150'), '100');
  assert.equal(sanitizePercent('100'), '100');
  assert.equal(sanitizePercent('100.01'), '100');
  assert.equal(sanitizePercent('9999'), '100');
  // ...and nothing below the cap is disturbed.
  assert.equal(sanitizePercent('18'), '18');
  assert.equal(sanitizePercent('17.5'), '17.5');
  assert.equal(sanitizePercent('0'), '0');
  // Zero stays typeable, for the same reason sanitizeRate leaves it alone:
  // refusing the character makes "0.50" impossible to enter.
  assert.equal(sanitizePercent('0.50'), '0.50');
  assert.equal(sanitizePercent(''), '');
  // The minus sign rule still applies here.
  assert.equal(sanitizePercent('-5'), '5');
  assert.equal(sanitizePercent('-150'), '100');
});

test('a rate above 100 would drive the line total negative', () => {
  // WHY the cap exists, asserted rather than asserted-about: a 150% discount
  // does not merely look wrong, it makes the figure the comparative statement
  // ranks on less than zero.
  const wild = waterfall({
    unit: 1000, qty: 2, discountPercent: 150, taxPercent: 18,
    taxesIncluded: false, basis: 'before_tax',
  });
  assert.equal(wild.discount, 3000);
  assert.ok(wild.lineTotal < 0, `a 150% discount must be impossible, got ${wild.lineTotal}`);
  // At the cap the line is merely free of the discount - a figure with meaning.
  const capped = waterfall({
    unit: 1000, qty: 2, discountPercent: 100, taxPercent: 18,
    taxesIncluded: false, basis: 'before_tax',
  });
  assert.equal(capped.discount, 2000);
  assert.equal(capped.lineTotal, 0);
});

// ── the other direction: an amount typed instead of a rate ───────────────────

test('a typed discount amount becomes the rate that produces it', () => {
  // before tax: the discount comes off the gross.
  assert.equal(discountPercentFromAmount({
    gross: 2000, amount: 200, taxPercent: 18,
    taxesIncluded: false, basis: 'before_tax',
  }), 10);
  // after tax: it comes off the tax-INCLUSIVE figure, which is why the same
  // 236.00 on a 2,000.00 gross is still 10% - 236 is a tenth of 2,360.
  assert.equal(discountPercentFromAmount({
    gross: 2000, amount: 236, taxPercent: 18,
    taxesIncluded: false, basis: 'after_tax',
  }), 10);
  // inclusive: back to the gross, because the discount precedes the extraction.
  assert.equal(discountPercentFromAmount({
    gross: 2000, amount: 200, taxPercent: 18,
    taxesIncluded: true, basis: 'before_tax',
  }), 10);
});

test('a typed tax amount becomes the rate that produces it', () => {
  // before tax: charged on what the discount left.
  assert.equal(taxPercentFromAmount({
    gross: 2000, discountPercent: 10, amount: 360,
    taxesIncluded: false, basis: 'before_tax',
  }), 20);
  // after tax: charged on the full amount.
  assert.equal(taxPercentFromAmount({
    gross: 2000, discountPercent: 10, amount: 360,
    taxesIncluded: false, basis: 'after_tax',
  }), 18);
  // inclusive: 236.00 quoted carrying 36.00 of tax leaves a 200.00 base, so the
  // rate is 36/200 - NOT 36/236, which is the tax-exclusive reading.
  assert.equal(taxPercentFromAmount({
    gross: 236, discountPercent: 0, amount: 36,
    taxesIncluded: true, basis: 'before_tax',
  }), 18);
});

test('an amount that cannot be converted yields null rather than a wrong rate', () => {
  // No gross yet: there is no figure to take a percentage of. Inventing 0 here
  // would silently erase a rate the officer had already set.
  assert.equal(discountPercentFromAmount({
    gross: 0, amount: 500, taxPercent: 18,
    taxesIncluded: false, basis: 'before_tax',
  }), null);
  assert.equal(taxPercentFromAmount({
    gross: 0, discountPercent: 0, amount: 500,
    taxesIncluded: false, basis: 'before_tax',
  }), null);
  // Inclusive: a tax that has consumed the whole quoted amount corresponds to
  // no finite rate, so there is nothing to convert it to.
  assert.equal(taxPercentFromAmount({
    gross: 236, discountPercent: 0, amount: 236,
    taxesIncluded: true, basis: 'before_tax',
  }), null);
});

test('an amount larger than its base clamps to 100, never past it', () => {
  assert.equal(discountPercentFromAmount({
    gross: 1000, amount: 5000, taxPercent: 18,
    taxesIncluded: false, basis: 'before_tax',
  }), 100);
  assert.equal(taxPercentFromAmount({
    gross: 1000, discountPercent: 0, amount: 5000,
    taxesIncluded: false, basis: 'before_tax',
  }), 100);
});

test('the base each rate is charged on is the one the waterfall uses', () => {
  // These two helpers are what the reverse conversions divide by, so a drift
  // between them and `waterfall` would read an amount back as the wrong rate.
  // They are asserted against the waterfall's OWN output rather than restated.
  const exclusive = [
    { unit: 2000, qty: 1, discountPercent: 10, taxPercent: 18, taxesIncluded: false, basis: 'after_tax' as const },
    { unit: 2000, qty: 1, discountPercent: 10, taxPercent: 18, taxesIncluded: false, basis: 'before_tax' as const },
  ];
  for (const c of exclusive) {
    const p = waterfall(c);
    assert.equal(discountBaseOf({ gross: p.gross, taxPercent: c.taxPercent, taxesIncluded: c.taxesIncluded, basis: c.basis }),
      p.discount / (p.discountPercent / 100), `discount base, ${c.basis}`);
    assert.equal(taxBaseOf({ gross: p.gross, discountPercent: c.discountPercent, taxesIncluded: c.taxesIncluded, basis: c.basis }),
      p.tax / (p.taxPercent / 100), `tax base, ${c.basis}`);
  }

  // TAX-INCLUSIVE IS NOT THE SAME RELATIONSHIP, and this is where the first
  // version of this test was wrong: it asserted `tax / tax%` for all three modes
  // and only failed on the inclusive one.
  //
  // Nothing is ADDED to an inclusive price — the tax is already inside it and is
  // taken back out — so there is no figure the rate was "charged on" in the same
  // sense. `taxBaseOf` returns the QUOTED amount, which is only where the
  // extraction starts. The base the rate really divides into is that amount less
  // the tax, and because it depends on the amount being converted it CANNOT be
  // known in advance — which is exactly why `taxPercentFromAmount` computes
  // `quoted - amount` per keystroke instead of calling this helper.
  const incl = { unit: 2000, qty: 1, discountPercent: 10, taxPercent: 18, taxesIncluded: true, basis: 'before_tax' as const };
  const pi = waterfall(incl);
  assert.equal(discountBaseOf({ gross: pi.gross, taxPercent: 18, taxesIncluded: true, basis: 'before_tax' }),
    pi.discount / (pi.discountPercent / 100), 'discount base, inclusive');
  assert.equal(taxBaseOf({ gross: pi.gross, discountPercent: 10, taxesIncluded: true, basis: 'before_tax' }),
    round2(pi.gross - pi.discount), 'inclusive tax base is the QUOTED amount, not the net');
  assert.equal(round2(taxBaseOf({ gross: pi.gross, discountPercent: 10, taxesIncluded: true, basis: 'before_tax' }) - pi.tax),
    pi.net, 'and the base actually divided into is that less the tax — the net');
});

test('ROUND TRIP: a typed amount, read back as a rate, reproduces that amount', () => {
  // The property the feature actually promises. The officer types a figure; if
  // the rate read back off it does not regenerate the SAME money, the field
  // visibly changes under the cursor and reads as broken. This is the assertion
  // that catches it - the individual conversions above cannot, because each one
  // passes on its own while the pair still fails to settle.
  const cases = [
    { unit: 1000, qty: 2, discountPercent: 10, taxPercent: 18, taxesIncluded: false, basis: 'after_tax' as const },
    { unit: 12500, qty: 1, discountPercent: 5, taxPercent: 17.5, taxesIncluded: false, basis: 'before_tax' as const },
    { unit: 118, qty: 3, discountPercent: 7.5, taxPercent: 18, taxesIncluded: false, basis: 'after_tax' as const },
    { unit: 999.99, qty: 3, discountPercent: 12.345, taxPercent: 8.5, taxesIncluded: true, basis: 'before_tax' as const },
    { unit: 333.33, qty: 7, discountPercent: 3.333, taxPercent: 19.5, taxesIncluded: false, basis: 'before_tax' as const },
    { unit: 1, qty: 3, discountPercent: 33.333, taxPercent: 0.01, taxesIncluded: false, basis: 'after_tax' as const },
  ];
  for (const c of cases) {
    const p = waterfall(c);
    const d = discountPercentFromAmount({
      gross: p.gross, amount: p.discount, taxPercent: c.taxPercent,
      taxesIncluded: c.taxesIncluded, basis: c.basis,
    });
    const t = taxPercentFromAmount({
      gross: p.gross, discountPercent: c.discountPercent, amount: p.tax,
      taxesIncluded: c.taxesIncluded, basis: c.basis,
    });
    assert.ok(d !== null && t !== null, `no rate recovered from ${JSON.stringify(c)}`);
    const again = waterfall({ ...c, discountPercent: d!, taxPercent: t! });
    const where = `${c.unit} x${c.qty} ${c.discountPercent}%/${c.taxPercent}% ${c.basis}${c.taxesIncluded ? ' incl' : ''}`;
    assert.equal(again.discount, p.discount, `discount did not round trip on ${where}`);
    assert.equal(again.tax, p.tax, `tax did not round trip on ${where}`);
    assert.equal(again.lineTotal, p.lineTotal, `line total did not round trip on ${where}`);
  }
});

test('the recovered rate carries enough precision to reproduce a paisa', () => {
  // Two decimals is NOT enough, and the reason is the officer's, not the
  // maths': 3.33% of 1,000.00 is 33.30, so typing 33.33 and getting 33.30 back
  // looks like the field is refusing the figure.
  const pct = discountPercentFromAmount({
    gross: 1000, amount: 33.33, taxPercent: 0,
    taxesIncluded: false, basis: 'before_tax',
  });
  assert.equal(pct, 3.333);
  const back = waterfall({
    unit: 500, qty: 2, discountPercent: pct!, taxPercent: 0,
    taxesIncluded: false, basis: 'before_tax',
  });
  assert.equal(back.discount, 33.33);
});

test('netOf is the gross less the discount, with the waterfall rounding', () => {
  // Asserted against `waterfall` rather than restated, because this is the
  // figure both the inclusive extraction and the before-tax base are built on.
  const w = waterfall({
    unit: 999.99, qty: 3, discountPercent: 12.345, taxPercent: 18,
    taxesIncluded: false, basis: 'before_tax',
  });
  assert.equal(netOf(w.gross, 12.345), w.net);
});
