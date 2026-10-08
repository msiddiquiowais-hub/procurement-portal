// rfq.status.ts — the pure presentation layer for an RFQ row.
//
// Every value here is lifted verbatim from the prototype's `rfqRows()` /
// `renderRFQList()` (PROCUREMENT_PORTAL_PROTOTYPE.html:8954-8999). The
// prototype builds these labels and pills inline in the renderer; we lift them
// into a pure function so they are unit-testable and so `GET /rfq` can return
// exactly the fields the rfq-list screen renders, rather than the API inventing
// a shape the screen then has to re-derive.
//
// The prototype's live-row rule is verbatim:
//   status: pr.csLocked ? 'CS locked'
//                       : (quotes.length >= 3) ? 'Quotes received'
//                                               : 'Awaiting quotes'
//   pill:   pr.csLocked ? 'locked'
//                       : (quotes.length >= 3) ? 'pending' : 'draft'
//
// The prototype also carries a partial variant on its static demo rows
// ('2 of 3 quotes' / pill 'pending'). That is the same rule with the count
// surfaced, so it generalises cleanly without changing the live case.

export type RfqDbState = 'Open' | 'Closed' | 'Awarded' | 'Cancelled';

export type RfqStatusInput = {
  /** proc.rfq.state */
  state: RfqDbState | string;
  /** Number of vendors holding a live (non-Withdrawn) quote. */
  quotes: number;
  /** Number of vendors invited. */
  invited: number;
  /** True once a Comparative Statement has been locked on this RFQ. */
  csLocked?: boolean;
  /** True once the pack has been pushed to D365. */
  d365Pushed?: boolean;
};

export type RfqStatusView = {
  /** The prototype's user-facing word, e.g. 'Awaiting quotes'. */
  label: string;
  /** The prototype's `pill` class: draft | submitted | pending | locked | approved. */
  pill: string;
  /** True when the prototype counts this row in the 'Open' KPI. */
  isOpen: boolean;
};

/**
 * Prototype rollup membership (renderRFQList:8976):
 *   open = rows.filter(r => r.status === 'Awaiting quotes'
 *                        || r.status === 'Quotes received'
 *                        || r.status === '2 of 3 quotes').length
 * i.e. everything that has not reached a terminal approval state.
 */
export function rfqStatusView(s: RfqStatusInput): RfqStatusView {
  const quotes = s.quotes || 0;
  const invited = s.invited || 0;

  // Terminal states first — the prototype's static rows carry these words
  // ('Pushed to D365', 'CFO approval') for RFQs that already left sourcing.
  if (s.d365Pushed) return { label: 'Pushed to D365', pill: 'approved', isOpen: false };
  if (s.csLocked) return { label: 'CS locked', pill: 'locked', isOpen: false };
  if (s.state === 'Cancelled') return { label: 'Cancelled', pill: 'draft', isOpen: false };
  if (s.state === 'Awarded') return { label: 'Awarded', pill: 'locked', isOpen: false };

  // Live rule, verbatim from rfqRows().
  if (quotes >= 3) return { label: 'Quotes received', pill: 'pending', isOpen: true };
  if (quotes > 0 && invited > 0) {
    return { label: `${quotes} of ${invited} quotes`, pill: 'pending', isOpen: true };
  }
  return { label: 'Awaiting quotes', pill: 'draft', isOpen: true };
}

export type RfqRollupInput = {
  quotes: number;
  /** Lowest live quote total for the RFQ, or null when nothing has been quoted. */
  lowestBid: number | null;
  /** The view returned by rfqStatusView() for this same row. */
  view: RfqStatusView;
};

export type RfqRollups = {
  /** rows.length */
  total: number;
  /** open */
  open: number;
  /** (sum(quotes) / rows.length).toFixed(1) — '0.0' when there are no rows,
   *  because the prototype's naive divide yields NaN and we render a number. */
  avgQuotes: string;
  /** sum(lowest bid) across rows. */
  totalQuotedValue: number;
};

/**
 * The four KPI cards on `rfq-list`, with the prototype's exact labels and
 * semantics. Two details copied rather than "corrected":
 *
 *  1. `Total quoted value` sums the LOWEST BID per RFQ, not every quote —
 *     renderRFQList:8984 says so in its own sub-label ('Lowest bid per RFQ').
 *  2. `Avg quotes / RFQ` is `sum(quotes) / rows.length` rendered with
 *     `.toFixed(1)`. The prototype divides by zero on an empty list and prints
 *     'NaN'; we render '0.0' instead, which is the only difference and is
 *     strictly an improvement in a KPI tile.
 */
export function rfqRollups(rows: RfqRollupInput[]): RfqRollups {
  const total = rows.length;
  const open = rows.filter(r => r.view.isOpen).length;
  const sumQuotes = rows.reduce((s, r) => s + (r.quotes || 0), 0);
  const totalQuotedValue = rows.reduce((s, r) => s + (r.lowestBid || 0), 0);
  return {
    total,
    open,
    avgQuotes: total === 0 ? '0.0' : (sumQuotes / total).toFixed(1),
    totalQuotedValue,
  };
}

// ── the PR-detail cards ────────────────────────────────────────────────────

/**
 * The procurement card's sub-status pill, verbatim from
 * `_lightProcurementCard` (prototype line 6081-6085):
 *
 *   if (rfq && !quotes.length)                 -> 'RFQ issued, awaiting quotes'
 *   else if (rfq && quotes.length && !winner)  -> 'Quotes received, select winner'
 *   else if (winner)                            -> 'Winner selected, confirm cost'
 *
 * Plan item 7 calls this "a fixed ladder" — three rungs, in order, and the
 * first that matches wins.
 *
 * NO FOURTH RUNG. Every branch above is guarded on `rfq`, so before an RFQ
 * exists the prototype has NO sub-status at all — the card body reads "Click
 * Issue RFQ to start the procurement flow." and nothing sits beside the title.
 * This function used to take only (hasQuotes, hasWinner) and fall through to
 * the first rung, which printed "RFQ issued, awaiting quotes" directly ABOVE
 * that instruction: the screen claiming an RFQ was issued on the same card
 * that asks you to issue one. `hasRfq` is therefore the first argument, and
 * the no-RFQ case returns null.
 */
export type SubStatus = { label: string; tone: 'info' | 'warn' | 'done' } | null;

export function subStatus(hasRfq: boolean, hasQuotes: boolean, hasWinner: boolean): SubStatus {
  if (!hasRfq) return null;
  if (hasWinner) return { label: 'Winner selected, confirm cost', tone: 'done' };
  if (hasQuotes) return { label: 'Quotes received, select winner', tone: 'warn' };
  return { label: 'RFQ issued, awaiting quotes', tone: 'info' };
}

/**
 * The prototype's `pr.procurement` object before an RFQ exists
 * (`_lightEnsureProcurement`, line 4054). The detail page needs a real object
 * with these fields to render the card's empty state — "Click Issue RFQ to
 * start the procurement flow." — rather than branching on null.
 */
export function emptyProcurement() {
  return {
    rfq: null,
    quotes: [],
    selectedQuoteIndex: -1,
    winner: null,
  };
}

/** Postgres jsonb arrives as a string through the CSV bridge. */
export function parseJsonb(v: unknown): any {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return null; }
  }
  return null;
}
