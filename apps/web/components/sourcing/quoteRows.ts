// WHICH PR LINES THE RECEIVE QUOTATION FORM OFFERS TO PRICE, as a function.
//
//   npm run test:web
//
// WHY THIS IS A MODULE AND NOT AN INLINE FILTER
// ----------------------------------------------
// Two separate questions decide whether a line gets a row on the quotation form,
// and they used to be asked in two different places:
//
//   1. is this line still live?          → `rejected` was checked, in the modal
//   2. may THIS ROLE see it?             → `held` was checked, on the detail page
//
// The detail page and the /pr grid both answered (2) through the shared rule in
// `lib/ui` (`seesHeldLines` / `visibleItems`), and the modal — which the same
// detail page renders — answered only (1). So an HOD hold placed AFTER the RFQ
// went out was invisible on the Line Items table a few pixels above the button
// and fully visible, priceable and submittable, inside the form that button
// opened. PR-2026-201658 is that case.
//
// The fix is not a second copy of the rule. It is ONE function, asked once,
// that composes both questions — with (2) delegated to the shared definition
// rather than restated, so a future change to who may see a hold reaches this
// screen without anyone editing this file.
//
// WHY THE HELD FILTER IS NOT REDUNDANT WITH THE SERVER
// ----------------------------------------------------
// `rfq.service.ts` DOES exclude held lines when it snapshots the RFQ: a line
// held before the RFQ is issued never becomes an `rfq_lines` row, and lands in
// `proc.rfq_line_exclusions` with the reason `held — …`. So most of the time
// there is nothing here to remove.
//
// The gap is a hold placed AFTER the snapshot. `proc.rfq_lines` is a
// point-in-time copy of the PR, and `/pr/:id/quotes` reads it with no join back
// to `pr_lines.held` — the form cannot tell a line that was live when the
// vendors were invited from one the HOD has since parked. That is the only case
// this filter exists to catch, and it is why the rule stays on the client until
// RBAC lands.

import { visibleItems } from '../../lib/ui';

/**
 * The subset of `pr_lines` this file needs. Both flags are optional because the
 * callers genuinely differ: `PrService.get` always sends them, while the
 * CSV bridge and older fixtures can send a line carrying neither.
 */
export type QuotableLine = {
  line_no: number;
  rejected?: boolean | null;
  held?: boolean | null;
};

/**
 * The lines the Receive Quotation grid should render, in `line_no` order.
 *
 * Hold is resolved FIRST and through `visibleItems`, then rejection is applied to
 * whatever survives. That order is not cosmetic: a line that is both held and
 * rejected is invisible to a downstream role either way, but resolving hold
 * first means a role that CAN see holds still has the rejection rule applied to
 * them — a rejected line is never priceable, whoever is looking.
 *
 * @param lines    every line the page holds, including held and rejected
 * @param seesHeld whether this role may act on a hold (see `seesHeldLines`)
 */
export function quotationRows<T extends QuotableLine>(lines: T[], seesHeld: boolean): T[] {
  return visibleItems(lines, seesHeld).filter(l => !l.rejected);
}