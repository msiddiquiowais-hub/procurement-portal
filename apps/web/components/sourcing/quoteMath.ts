// The per-line pricing waterfall, as the browser computes it for DISPLAY.
//
//   npm run test:web
//
// WHY A SEPARATE FILE
// -------------------
// This is the same arithmetic the API runs in `quoteLineWaterfall`, and it has
// to stay identical to it: the officer reads these six figures off the screen,
// trusts them, and presses Save. If the two disagree by a paisa the quote that
// gets stored is not the quote that was shown — and nothing reports that.
//
// It lives in its own module with NO imports precisely so it can be unit-tested
// without pulling in `lib/api` (which touches `window`/`localStorage` at import
// time and cannot be loaded by plain `node --test`). The file exists so the two
// copies have one obvious place to be compared, not so there is one copy.
//
// The guard against drift is apps/web/tests/quote-math.test.ts, which asserts
// the SAME LITERAL expected figures as apps/api's quotation.waterfall.test.ts.
// Literals, not recomputation: a test that re-derived the answers with the
// formula under test would happily agree with a broken implementation.
//
// DERIVED VALUES ARE NOT INPUTS. Only unit price, discount %, tax % and
// warranty are typed; gross, discount, net, tax and the line total are computed
// here and recomputed server-side. Accepting a derived figure from the client
// would let a stale screen persist a total that disagrees with its own inputs,
// and that gap would surface later as an unexplained difference in the
// comparative statement.

/**
 * Money to 2 decimal places, half-up.
 *
 * Deliberately `+(v).toFixed(2)` rather than `Math.round(v * 100) / 100`: the
 * latter returns 10390.624999999999 for 10390.625, because 10390.625 is not
 * exactly representable in binary floating point. This is the same expression
 * the API's `round2` uses — the two MUST stay byte-identical or the printed
 * columns stop matching the stored quote.
 */
export const round2 = (v: number) =>
  Math.round(Number((v + Number.EPSILON).toFixed(2)) * 100) / 100;

/**
 * Keep only what a rate field may contain: digits, and at most one decimal point.
 *
 * `type="number"` does NOT prevent a minus sign. It will hold "-5" happily and
 * then refuse to submit, which the officer reads as the form being broken
 * rather than the value being wrong. So the sign, exponents, spaces and stray
 * characters are stripped as the officer types.
 *
 * ZERO IS NOT BLOCKED HERE, and that is deliberate: refusing the character would
 * make "0.50" untypeable, because the leading 0 is a legitimate part of it.
 * Zero is rejected at save, with a message naming the line.
 *
 * Exported rather than inlined in the component so it can be tested — a rule
 * that lives inside a React callback is a rule nothing can assert.
 */
export function sanitizeRate(raw: string): string {
  let s = String(raw).replace(/[^0-9.]/g, '');
  const dot = s.indexOf('.');
  if (dot !== -1) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, '');
  return s;
}

/**
 * A percentage stops being a percentage at 100.
 *
 * `max={100}` on the element is not enforcement: these inputs are not inside a
 * `<form>`, so nothing ever reads the attribute, and the browser will happily
 * hold "150" and hand it to the payload. The API bounds the rate too, but an
 * officer who has been told a field accepts a figure and is then refused at
 * Save reads the form as broken rather than the figure as wrong — so the cap is
 * applied as the value is typed.
 *
 * CLAMP rather than refuse, deliberately. Refusing the keystroke that would
 * cross 100 turns a typed "150" into "15" — a DIFFERENT, plausible number that
 * the officer never meant, and one that looks like a typo they must hunt for.
 * Clamping lands on 100, which is what they were told cannot be exceeded, and is
 * a figure with a meaning (a 100% discount is free goods; 100% tax is not
 * chargeable but is not a silent zero either).
 */
export const MAX_PERCENT = 100;

export function sanitizePercent(raw: string): string {
  const s = sanitizeRate(raw);
  if (s === '' || s === '.') return s;
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return n > MAX_PERCENT ? String(MAX_PERCENT) : s;
}

export type Waterfall = {
  gross: number;
  discountPercent: number;
  discount: number;
  /**
   * The MIDDLE column of the grid — and it is a different quantity in each of
   * the three cases, which is why the column is labelled per-basis:
   *
   *   before tax  the taxable base, gross less the discount
   *   after  tax  the gross INCLUDING tax ("Inc Tax Amt")
   *   inclusive   the taxable base, extracted out of the quoted figure
   *
   * It is one column and one stored `net_amount`, so anything that consumes it
   * MUST also read `discount_basis` — ranking a comparative statement on this
   * alone would compare three different quantities.
   */
  net: number;
  taxPercent: number;
  /** The tax actually charged. Never a figure that was not charged. */
  tax: number;
  /**
   * What this line contributes to the quote.
   *
   *   before tax / inclusive:  net + tax
   *   after tax:              net - discount   (net already contains the tax)
   */
  lineTotal: number;
};

/**
 * THE PER-LINE WATERFALL — the browser's copy of the API's `quoteLineWaterfall`.
 *
 * THREE CASES, three identities. The middle column means something different in
 * each, which is why the grid labels it per-basis rather than always "Net Amt".
 *
 *   before tax  gross    = qty x unit
 *               discount = gross x disc%
 *               net      = gross - discount     <- the TAXABLE BASE
 *               tax      = net x tax%
 *               total    = net + tax           => Total = Net + Tax
 *
 *   after  tax  gross    = qty x unit
 *               tax      = gross x tax%
 *               net      = gross + tax         <- "Inc Tax Amt"
 *               discount = net x disc%         <- off the tax-inclusive figure
 *               total    = net - discount      => Total = Inc Tax Amt - Disc
 *
 *   inclusive   gross    = qty x unit
 *               discount = gross x disc%
 *               quoted   = gross - discount     <- ALREADY contains the tax
 *               tax      = quoted - quoted/(1+r)   EXTRACTED, not added
 *               net      = quoted - tax         <- the base
 *               total    = net + tax           => Total = Net + Tax
 *
 * THE AFTER-TAX CASE, because this was wrong and the officer reported it.
 *
 * The grid used to subtract the discount from the GROSS and then add the tax:
 *
 *     2,000.00 gross, 18% tax = 360.00
 *     net = 2,000 - 200 (10% of gross) = 1,800.00   <- WRONG
 *     total = 1,800 + 360 = 2,160.00                <- 36.00 too much
 *
 * Under after-tax the tax is charged on the full amount, so the discount comes
 * off the figure that INCLUDES the tax:
 *
 *     Inc Tax Amt = 2,000.00 + 360.00        = 2,360.00
 *     discount 10% of 2,360.00               =   236.00
 *     total    = 2,360.00 - 236.00           = 2,124.00
 *
 * Both exclusive bases now reduce to gross x (1 + tax%) x (1 - discount%), so
 * the amount payable does not depend on which side the officer read the
 * discount from. The basis changes the SPLIT, not the bill: before-tax charges
 * 324.00 of tax on a 1,800.00 base with a 200.00 discount; after-tax charges
 * 360.00 on a 2,360.00 base with a 236.00 discount. Both total 2,124.00. That
 * difference is real and matters — it is the tax remittance and the discount the
 * vendor actually granted.
 *
 * `net` is deliberately the same field name in all three cases because it is the
 * same COLUMN of the grid (and the same stored `net_amount`). It is NOT the same
 * quantity, so anything consuming it must read `discount_basis` too.
 *
 * THE TAX-INCLUSIVE BUG THIS REPLACED: the old inclusive path computed
 * `tax = net x r/100` and `total = net`, i.e. the tax-EXCLUSIVE rate printed
 * beside a total that never included it. On a 118.00 line at 18% that showed
 * 21.24 of tax when the tax inside 118.00 is 18.00 — an overstated charge on
 * every inclusive quote, and a grid whose columns did not sum to its own total.
 *
 * `basis` is ignored when taxesIncluded is true — with one payable figure there
 * is no before/after to choose, and the form normalises it to 'before_tax' so
 * the stored discount_basis stays truthful.
 */
export function waterfall(input: {
  unit: number;
  qty: number;
  discountPercent: number;
  taxPercent: number;
  taxesIncluded: boolean;
  basis: 'before_tax' | 'after_tax';
}): Waterfall {
  const gross = round2(input.unit * input.qty);

  if (input.taxesIncluded) {
    const discount = round2(gross * input.discountPercent / 100);
    const quoted = round2(gross - discount);
    const tax = round2(quoted - quoted / (1 + input.taxPercent / 100));
    const net = round2(quoted - tax);
    return {
      gross, discountPercent: input.discountPercent, discount, net,
      taxPercent: input.taxPercent, tax, lineTotal: round2(net + tax),
    };
  }

  if (input.basis === 'after_tax') {
    const tax = round2(gross * input.taxPercent / 100);
    const net = round2(gross + tax);
    const discount = round2(net * input.discountPercent / 100);
    return {
      gross, discountPercent: input.discountPercent, discount, net,
      taxPercent: input.taxPercent, tax, lineTotal: round2(net - discount),
    };
  }

  const discount = round2(gross * input.discountPercent / 100);
  const net = round2(gross - discount);
  const tax = round2(net * input.taxPercent / 100);
  return {
    gross, discountPercent: input.discountPercent, discount, net,
    taxPercent: input.taxPercent, tax, lineTotal: round2(net + tax),
  };
}

/** The all-zero waterfall for a declined line: it contributes nothing at all. */
export const EMPTY: Waterfall = {
  gross: 0, discountPercent: 0, discount: 0, net: 0, taxPercent: 0, tax: 0, lineTotal: 0,
};

/**
 * What a line costs, described for the officer — one sentence, because the
 * columns look identical in every mode and only the arithmetic differs.
 *
 * after-tax gets its own wording rather than being described as "before tax with
 * the numbers moved": the discount genuinely comes off the tax-inclusive figure,
 * and that is the whole point of the toggle.
 */
export function taxModeNote(inclusive: boolean, basis: 'before_tax' | 'after_tax'): string {
  if (inclusive) {
    return 'Prices include tax: the tax is already inside the rate and is taken out of it, '
      + 'so it is never added again. The discount comes off the quoted amount. '
      + 'Every line reads Total = Net + Tax.';
  }
  return basis === 'after_tax'
    ? 'Tax is charged on the full amount, then the discount is taken off that '
      + 'tax-inclusive figure — so the discount reduces the tax too. '
      + 'Total = Inc Tax Amt less Disc Amt.'
    : 'The discount is taken first, then tax is charged on what is left. '
      + 'Total = Net + Tax.';
}

/**
 * IS THIS PRICE A REAL OFFER?
 *
 * Strictly `> 0`. A zero is not a cheaper price, it is an absent one, and every
 * place that picks a "lowest" bid has to make the same decision or they will
 * disagree: the matrix would badge a PKR 0 vendor as L1, the scorer would let
 * that same 0 set the floor of the commercial scale and score every genuine
 * bidder toward zero, and the summary would report a 0 that reads like free
 * goods.
 *
 * This is the web copy of `isL1Eligible` in
 * `apps/api/src/sourcing/award.service.ts` and `isPriced` in
 * `apps/api/src/sourcing/cs.scoring.ts`. Three files, one rule — they have to
 * stay identical or the buyer is shown an L1 the server will refuse.
 */
/**
 * The type is deliberately wider than `number`. The figure reaches the browser
 * through a CSV bridge, so a rate can arrive as the STRING "0" or "" and be
 * compared as a number; narrowing this to `number` would make the string
 * guards unreachable code, which is exactly how a zero slips back in through
 * the type system.
 */
export function isPriced(amount: number | string | null | undefined): boolean {
  if (amount === null || amount === undefined || amount === '') return false;
  const n = Number(amount);
  return Number.isFinite(n) && n > 0;
}

// ── THE OTHER DIRECTION: an AMOUNT typed into the grid ────────────────────────
//
// The vendor's sheet states a discount in rupees far more often than in percent
// ("we take off 2,360 on the monitors"). Making the officer convert that to a
// rate by hand is how a 10% discount becomes 11% and nobody notices.
//
// So the amount columns became entry points as well: type a percentage and the
// amount follows, type an amount and the percentage follows. What is STORED and
// submitted is still only the rate — these functions do not add a second source
// of truth, they only translate into the one the waterfall already computes from.
//
// `null` means "this figure cannot be converted right now" — there is no gross
// yet, or (tax-inclusive) the typed tax has consumed the whole quoted amount. The
// caller leaves the rate alone rather than inventing one.

/**
 * The gross less the discount — the base the tax is charged on before tax, and
 * the QUOTED amount when the price already includes its tax.
 *
 * Same two round2s, same order, as the inclusive and before-tax branches of
 * `waterfall`. A reverse calculation that recomputed this with one rounding
 * would drift by a paisa per keystroke and never settle.
 */
export function netOf(gross: number, discountPercent: number): number {
  return round2(gross - round2(gross * discountPercent / 100));
}

/**
 * THE FIGURE A DISCOUNT IS TAKEN OFF — the denominator when reading a discount
 * amount back as a rate.
 *
 * after tax is the only case where it is not the gross: the discount comes off
 * the tax-inclusive figure, so it is off `gross + tax`. Note that figure does NOT
 * depend on the discount itself, which is what makes the reverse safe — there is
 * no circularity to resolve, and the officer can type in either order.
 */
export function discountBaseOf(input: {
  gross: number;
  taxPercent: number;
  taxesIncluded: boolean;
  basis: 'before_tax' | 'after_tax';
}): number {
  if (!input.taxesIncluded && input.basis === 'after_tax') {
    return round2(input.gross + round2(input.gross * input.taxPercent / 100));
  }
  return input.gross;
}

/**
 * THE FIGURE THE TAX IS CHARGED ON — the denominator for a typed tax amount.
 *
 * The tax-inclusive case is NOT `quoted`. There the tax is already inside the
 * quoted amount and is extracted from it, so the rate is charged on the base
 * that is left after the tax is removed:
 *
 *     tax = quoted - quoted/(1 + r)   =>   r = tax / (quoted - tax)
 *
 * `quoted - tax` is the net, so the extraction inverts to `tax / net` — see
 * `taxPercentFromAmount`, which uses `round2(quoted - amount)` as that base.
 */
export function taxBaseOf(input: {
  gross: number;
  discountPercent: number;
  taxesIncluded: boolean;
  basis: 'before_tax' | 'after_tax';
}): number {
  if (input.taxesIncluded) return netOf(input.gross, input.discountPercent);
  if (input.basis === 'after_tax') return input.gross;
  return netOf(input.gross, input.discountPercent);
}

/**
 * Hold a derived rate inside 0-100 and off the float noise.
 *
 * SIX decimals, not two, and that is load-bearing rather than fussiness. The
 * officer typed an AMOUNT, and the rate is only the means of reproducing it: a
 * 3.33% rate on a 1,000.00 gross gives back 33.30, so the figure they typed
 * visibly changes under the cursor and the field reads as broken. Carrying
 * 3.333 instead gives 33.33 back exactly, and `round2` absorbs the residue on
 * the awkward cases (a 0.333333% rate on a gross of 3.00 still yields 0.01).
 * So the round trip settles instead of drifting a paisa per keystroke.
 */
function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= MAX_PERCENT) return MAX_PERCENT;
  return Math.round(n * 1e6) / 1e6;
}

/** A typed discount amount read back as the rate that produces it. */
export function discountPercentFromAmount(input: {
  gross: number;
  amount: number;
  taxPercent: number;
  taxesIncluded: boolean;
  basis: 'before_tax' | 'after_tax';
}): number | null {
  const base = discountBaseOf(input);
  if (!(base > 0)) return null;
  return clampPercent((input.amount / base) * 100);
}

/** A typed tax amount read back as the rate that produces it. */
export function taxPercentFromAmount(input: {
  gross: number;
  discountPercent: number;
  amount: number;
  taxesIncluded: boolean;
  basis: 'before_tax' | 'after_tax';
}): number | null {
  if (input.taxesIncluded) {
    // r = tax / (quoted - tax). The subtraction is rounded exactly as the
    // inclusive branch of `waterfall` rounds its net, so the two agree.
    const base = round2(netOf(input.gross, input.discountPercent) - input.amount);
    if (!(base > 0)) return null;
    return clampPercent((input.amount / base) * 100);
  }
  const base = taxBaseOf(input);
  if (!(base > 0)) return null;
  return clampPercent((input.amount / base) * 100);
}