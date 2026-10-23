/**
 * The my-prs action tabs, extracted so the filter rules can be unit-tested.
 *
 * This is the same reason components/sourcing/quoteColumns.ts exists: a filter
 * predicate that only ever runs against whatever 200 PRs happen to be in the
 * current window proves very little. On this estate the Expired tab is EMPTY in
 * that window — so a green browser run would say nothing about whether the Expired
 * rule is even correct. Testing it on synthetic rows closes that gap.
 *
 * Kept in sync with the sourcing_status derivation in pr.service.ts::myPrs.
 */

export type SourcingTabKey = 'all' | 'awaiting' | 'expired' | 'received';

/** The fields a row needs for the predicates below. */
export type SourcingRow = {
  sourcing_status: string;
  expired_vendor_count: number;
  /**
   * The request's real workflow stage.
   *
   * Added by migration 075, and it exists because `sourcing_status` no longer
   * names stages. That column used to emit QUOTES_RECEIVED alongside its own
   * sourcing-progress values, which meant the Received tab was filtering on a
   * value that had two owners — the ladder in `workflow.steps_config` and a CASE
   * expression in a SELECT list. When they disagree the tab quietly empties, with
   * no error anywhere.
   *
   * `QUOTES_RECEIVED` is a stage question, so it is now answered by the stage.
   * One owner per fact.
   */
  status?: string;
};

export const SOURCING_TABS: Array<{
  key: SourcingTabKey;
  label: string;
  match: (p: SourcingRow) => boolean;
}> = [
  { key: 'all', label: 'All', match: () => true },

  // An RFQ that is out and still short of responses. "Not dispatched" (an RFQ
  // with zero invitations) belongs here: it is a live RFQ awaiting its first
  // vendor contact, not an expiry.
  {
    key: 'awaiting',
    label: 'Awaiting Quotes',
    match: p => p.sourcing_status === 'AWAITING_QUOTES',
  },

  // WIDER than its name, deliberately. A PR that cleared the received threshold
  // has moved on, but the vendors who never answered are exactly who management
  // needs to see — so any PR carrying an expired vendor lands here too, whatever
  // its own status says. Without that clause the fraud check would hide precisely
  // the vendors it exists to surface.
  {
    key: 'expired',
    label: 'Expired',
    match: p => p.sourcing_status === 'EXPIRED' || p.expired_vendor_count > 0,
  },

  // A threshold-met RFQ is still received — that is what lets procurement
  // continue past vendors who never answered.
  //
  // `QUOTES_RECEIVED` belongs here: that is literally the state where the
  // quotes landed, and it is the stage a buyer watches. Migration 075 moved the
  // read from `sourcing_status` to the request's real `status`, because
  // QUOTES_RECEIVED is a value of the ladder and the ladder is its only owner.
  //
  // The FOUR LATER GOVERNANCE STATES DELIBERATELY DO NOT. CS_LOCKED,
  // MC_APPROVED, CFO_APPROVED and PACK_LOCKED are PRs whose sourcing concluded
  // long ago and are now governance items — 215 of them on this estate. Putting
  // them in "Received" would bury the PRs this tab exists to surface under a
  // backlog of awarded work. They remain visible in "All", and — the part that
  // matters for oversight — the Expired rule below still catches any of them
  // carrying a silent vendor, because that predicate is deliberately
  // status-independent.
  {
    key: 'received',
    label: 'Received',
    match: p =>
      p.sourcing_status === 'RECEIVED' ||
      p.sourcing_status === 'RECEIVED_THRESHOLD_MET' ||
      p.status === 'QUOTES_RECEIVED',
  },
];

/**
 * GENERIC in the row type, deliberately.
 *
 * `SourcingRow` is the minimum a PREDICATE needs, but a grid still needs
 * everything else — id, pr_number, title. Returning `SourcingRow[]` made
 * `rowsForTab(light, tab)` drop the full row type on the floor, so every field
 * the grid renders was "not on type SourcingRow". This compiled under
 * tsconfig.render.json (which type-checks the components in isolation) and
 * failed the real `next build`, which is the point of running the real build.
 * Filtering must not change what a row IS.
 */
export const rowsForTab = <T extends SourcingRow>(rows: T[], key: SourcingTabKey): T[] => {
  const tab = SOURCING_TABS.find(t => t.key === key) ?? SOURCING_TABS[0];
  return rows.filter(tab.match);
};