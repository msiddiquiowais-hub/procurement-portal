// The Receive Quotation grid's COLUMN ORDER, as data.
//
//   npm run test:web
//
// WHY THE ORDER IS A FUNCTION AND NOT THREE LISTS OF MARKUP
// -------------------------------------------------------
// "Discount after tax" moves the discount block past the tax block. A `<th>` can
// be moved on its own, and if it is, the grid silently lies: the sticky totals
// row keeps its own hard-coded `colSpan`s and its own sequence of empty `<td>`s,
// so it stays glued to the ORIGINAL columns while the header moves. The result
// looks fine and is wrong — "Column Totals" printed under a heading it no longer
// belongs to, on the screen an officer uses to decide which vendor is cheapest.
//
// So the order is described ONCE here and the header, every body row and the
// totals row are all rendered from it. They cannot drift, because there is only
// one ordering to be out of date with.
//
// The reading each order encodes:
//
//   before tax  Gross → Disc% → DiscAmt → Net → Tax% → TaxAmt → Total
//               the discount shrinks the taxable base, so tax follows the base
//
//   after  tax  Gross → Tax% → TaxAmt → Net → Disc% → DiscAmt → Total
//               tax is charged on the full amount and the discount comes off
//               afterwards, so the discount genuinely sits after the tax
//
// Net Amt always sits flush against the tax block, and which edge it takes
// depends on where the waterfall puts it: immediately BEFORE Tax % in before-tax
// (the discount shrank the base the tax is charged on), immediately AFTER Tax
// Amt in after-tax (the tax was charged on the full amount, so the discount —
// and Net, which is the gross less it — both come afterwards). The rule is the
// same on both sides: Net is never separated from the figures it is added to.
//
// Total stays last. It is what the column sums to and what the comparative
// statement ranks on.

export type ColumnKey =
  | 'item' | 'desc' | 'cat' | 'qty' | 'unit' | 'gross'
  | 'discPct' | 'discAmt' | 'net' | 'taxPct' | 'taxAmt'
  | 'total' | 'warr' | 'decl';

/** Which stored figure the sticky totals row prints under a column. */
export type FootKind = 'gross' | 'discount' | 'net' | 'tax' | 'total' | null;

export type Column = {
  key: ColumnKey;
  label: string;
  /** Applied to the `<th>` AND every row's `<td>`, so the two cannot disagree. */
  cls?: string;
  /**
   * Hidden when "Apply Discount" is off.
   *
   * Net Amt carries this too, which looks wrong until you remember the original
   * grid folded the whole gross→net block away together — hiding Net while
   * keeping Disc% would leave an orphaned percentage column.
   */
  discountOnly?: boolean;
  foot: FootKind;
  /** Emphasised in the totals row. */
  grand?: boolean;
};

const LEAD: Column[] = [
  { key: 'item', label: 'Item & Code', foot: null },
  { key: 'desc', label: 'Description', foot: null },
  { key: 'cat', label: 'Category', foot: null },
  { key: 'qty', label: 'Qty', cls: 'c', foot: null },
  { key: 'unit', label: 'Unit Price', foot: null },
  { key: 'gross', label: 'Gross Amt', cls: 'r', foot: 'gross' },
];

const DISC: Column[] = [
  { key: 'discPct', label: 'Disc %', cls: 'c', discountOnly: true, foot: null },
  { key: 'discAmt', label: 'Disc Amt', cls: 'r', discountOnly: true, foot: 'discount' },
];

const TAX: Column[] = [
  { key: 'taxPct', label: 'Tax %', cls: 'c', foot: null },
  { key: 'taxAmt', label: 'Tax Amt', cls: 'r', foot: 'tax' },
];

const TRAIL: Column[] = [
  { key: 'warr', label: 'Warranty (mo)', cls: 'c', foot: null },
  { key: 'decl', label: 'Declined', cls: 'c', foot: null },
];

/** Total always last: it is the sum of the block to its left. */
const TOTAL = (currency: string): Column =>
  ({ key: 'total', label: `Total (${currency})`, cls: 'r', foot: 'total', grand: true });

/**
 * The column order for the current discount basis.
 *
 * `basis` is the basis ACTUALLY APPLIED, not the radio's current value — a
 * tax-inclusive quote forces `before_tax` (one payable figure, no basis to
 * choose), so passing the raw radio value here would reorder the grid around a
 * rule that is not in force.
 */
export function quotationColumns(opts: {
  basis: 'before_tax' | 'after_tax';
  useDiscount: boolean;
  currency: string;
}): Column[] {
  const { basis, useDiscount, currency } = opts;

  // Net Amt sits flush against the tax block in both orders, so it is never
  // separated from the figures it is added to. It carries `discountOnly` because
  // it is part of the gross->net fold the "Apply Discount" control collapses.
  //
  // The HEADING is basis-dependent because the column means different things:
  // in before-tax it is the taxable base (1,800.00), in after-tax it is the gross
  // INCLUDING the tax (2,360.00). Calling both "Net Amt" would have an officer
  // discounting 2,360.00 while reading it as the base — which is exactly the
  // misreading that produced the 2,160.00 total.
  const net: Column = basis === 'after_tax'
    ? { key: 'net', label: 'Inc Tax Amt', cls: 'r', discountOnly: true, foot: 'net' }
    : { key: 'net', label: 'Net Amt', cls: 'r', discountOnly: true, foot: 'net' };

  const cols = basis === 'after_tax'
    ? [...LEAD, ...TAX, net, ...(useDiscount ? DISC : []), TOTAL(currency), ...TRAIL]
    : [...LEAD, ...(useDiscount ? DISC : []), net, ...TAX, TOTAL(currency), ...TRAIL];

  // Filtered, not merely flagged. The original grid removed Disc %/Disc Amt from
  // the markup but left Net Amt in place with a class the `.cols-off` rule
  // hid with `display: none` — two mechanisms for one outcome, which is why a
  // column count was never something the tests could assert. One rule now.
  return useDiscount ? cols : cols.filter(c => !c.discountOnly);
}

/** Column keys in render order — the form the assertions are written against. */
export function columnKeys(opts: {
  basis: 'before_tax' | 'after_tax';
  useDiscount: boolean;
  currency: string;
}): ColumnKey[] {
  return quotationColumns(opts).map(c => c.key);
}

/**
 * How many leading columns the sticky totals row's caption absorbs.
 *
 * It must stop at the first column that prints a figure. Deriving it from the
 * column COUNT is the mistake: with 14 columns and 3 trailing non-money columns
 * that gives 11, the caption swallows Gross, Disc Amt, Net and Tax Amt, and the
 * totals row quietly stops being totals — while every row still has the right
 * number of cells, so a count-based assertion passes.
 *
 * Exported so it can be asserted rather than trusted.
 */
export function footLabelSpan(cols: Column[]): number {
  return Math.max(1, cols.findIndex(c => c.foot !== null));
}