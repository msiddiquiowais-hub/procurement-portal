// The two sourcing cards on `light-pr-detail`.
//
// Port of _lightProcurementCard (prototype line 6074, "RFQ & quotes") and
// _lightRosterCard (prototype line 6193, "Request for Quotations"). Both read
// the same `pr.procurement` object in the prototype, so both are fed from the
// single `GET /pr/:id/sourcing` response — one request, two cards.
//
// Layout, labels, pill colours and the sub-status ladder are the prototype's.
// The two divergences are documented in rfq.service.ts (sourcing): the winner
// is never `i===0`, and compliance is never an assumed pass.

import Link from 'next/link';
import React from 'react';
import { pkr, fmtDateTime } from '../../lib/ui';
import { downloadFile } from '../../lib/api';

export type SourcingCompliance = { status: 'pass' | 'unknown' | 'fail'; label: string };

export type SourcingQuote = {
  id: string;
  vendor_id: string;
  vendor_name: string;
  vendor_code: string;
  version: number;
  state: string;
  total: number;
  total_currency: string;
  unit_price: number | null;
  /** Quoted lead time in days. Per-QUOTATION, not per-line, so it is not ambiguous. */
  lead_time_days: number | null;
  warranty_months: number | null;
  valid_until_days: number | null;
  /**
   * The vendor's own document for THIS version. `[]` means none was attached
   * (a superseded record predating the mandatory-attachment rule, or a voided
   * one) — which is different from the payload being unavailable.
   */
  attachments: Array<{ id: string; name: string | null; kind: string | null }>;
  received_at: string | null;
  quote_mode: string | null;
  is_new_vendor: boolean;
  on_approved_roster: boolean;
};

export type SourcingRosterRow = {
  invitation_id: string;
  vendor_id: string;
  vendor_code: string;
  vendor_name: string;
  vendor_state: string;
  on_approved_roster: boolean;
  issued_at: string | null;
  /**
   * Which re-issue ADDED this vendor, and when. `reissue_no === 0` means the
   * original issue — which is not the same as "unknown", and is why the UI can
   * say "invited on the original issue" rather than showing a blank.
   *
   * Pre-existing invitations all carry 0: migration 061 could not recover which
   * vendor an earlier e2e re-issue had added, and did not guess. They under-claim
   * rather than over-claim — the RFQ-level re-issue still shows for those.
   */
  reissue_no: number;
  reissued_at: string | null;
  reissued_deadline: string | null;
  declined: boolean;
  declined_reason: string | null;
  quote_count: number;
  pending_approval: boolean;
  badge: { label: string; tone: string };
  /**
   * The vendor's FULL version chain on this RFQ — every version, including the
   * superseded ones. This, not `procurement.quotes`, is where every version's
   * document lives: `quotes` holds only the live version per vendor, so a
   * buyer reading an audit trail needs this list.
   */
  versions: Array<{
    id: string;
    version: number;
    state: string;
    prototype_state: string;
    total_amount: number;
    currency: string;
    lead_time_days: number | null;
    validity_days: number | null;
    submitted_at: string | null;
    quote_mode: string | null;
    attachments: Array<{ id: string; name: string | null; kind: string | null }>;
  }>;
};

export type Sourcing = {
  procurement: {
    rfq: {
      id: string; rfq_id: string;
      vendorIds: string[];
      issuedAt: string | null;
      issuedAtByVendor: Record<string, string | null>;
      deadline: string | null;
      /**
       * The deadline as first issued, and the re-issue story beside it.
       *
       * `deadline` is overwritten in place by a re-issue, so `initialDeadline`
       * is the only surviving record of the date the competition was first run
       * to. Without it the header can show the current date and silently lose
       * the one the vendors were originally given.
       */
      initialDeadline: string | null;
      reissueCount: number;
      lastReissuedAt: string | null;
      state: string;
    } | null;
    quotes: SourcingQuote[];
    selectedQuoteIndex: number;
    winner: { vendor_id: string; vendor_name: string | null; total: number | null; reason: string | null; lead_time_days: number | null } | null;
  };
  sub_status: { label: string; tone: string } | null;
  roster: SourcingRosterRow[];
  roster_tally: { received: number; invited: number; pending: number; text: string };
  cards: { procurement_card: boolean; roster_card: boolean };
};

const PILL_TONE: Record<string, string> = {
  info: 'info', warn: 'warn', done: 'success',
  neutral: '', mute: 'draft',
};

/** The prototype's "RFQ issued: <ts>" pill, verbatim including its colours. */
function IssuedPill({ at, label = 'RFQ issued' }: { at: string | null; label?: string }) {
  if (!at) return null;
  return (
    <span className="pill info"
          style={{ background: '#EFF6FF', color: '#1E40AF', border: '1px solid #BFDBFE' }}
          title={`${label} at ${at}`}>
      {label}: <b>{at}</b>
    </span>
  );
}

function dash(v: string | number | null | undefined) {
  return v === null || v === undefined || v === '' ? <span className="text-mute">&mdash;</span> : v;
}

/**
 * What a re-issue did to THIS vendor. Three cases, and they must not collapse:
 *
 *   added at re-issue #N   the vendor was brought onto the roster by a re-issue
 *   on RFQ                the RFQ was re-issued while this vendor was already on
 *                         it — a deadline-only re-issue, which is exactly the
 *                         action the re-issue button now allows
 *   —                     this RFQ has never been re-issued
 *
 * The middle case is the one that used to be unrenderable: a re-issue that adds
 * nobody changes no invitation, so the only honest per-vendor statement is that
 * the competition they are on was re-issued. Saying "not invited" there would
 * be false, and showing the RFQ's stamp with no qualification would read as
 * though they had personally been re-invited.
 */
function ReissueCell({ row, rfq }: { row: SourcingRosterRow; rfq: NonNullable<Sourcing['procurement']['rfq']> }) {
  if (row.reissue_no > 0) {
    return (
      <IssuedPill
        at={row.reissued_at}
        label={`added at re-issue #${row.reissue_no}`}
      />
    );
  }
  if (rfq.reissueCount > 0 && rfq.lastReissuedAt) {
    return (
      <span
        className="pill warn"
        style={{ background: '#FEF3C7', color: '#92400E', border: '1px solid #FDE68A' }}
        title={`This vendor was already on the roster when ${rfq.id} was re-issued. The re-issue extended the quote deadline; it did not re-invite this vendor.`}
      >
        on RFQ &middot; <b>{fmtDateTime(rfq.lastReissuedAt)}</b>
      </span>
    );
  }
  return <span className="text-mute">&mdash;</span>;
}

// ── card 1 · _lightProcurementCard ─────────────────────────────────────────

export function ProcurementCard({ s }: { s: Sourcing }) {
  const proc = s.procurement;
  const rfq = proc.rfq;
  const quotes = proc.quotes ?? [];
  const winner = proc.winner;

  return (
    <div className="card mb-4">
      <div className="card-h">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h3>RFQ &amp; quotes</h3>
          {s.sub_status && (
            <span className={`pill ${PILL_TONE[s.sub_status.tone] ?? ''}`}>{s.sub_status.label}</span>
          )}
        </div>
      </div>
      <div className="card-b">
        {rfq ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            <b>RFQ:</b>
            <span className="mono">{rfq.id}</span>
            <IssuedPill at={rfq.issuedAt} />
            &middot; deadline <b>{dash(rfq.initialDeadline ?? rfq.deadline)}</b>
            {/* ── ORIGINAL BESIDE RE-ISSUE, SPLIT BY A VERTICAL PIPE ──────────
                Rendered only when the RFQ has actually been re-issued. A pipe
                with nothing on the far side is just a stray glyph, so the whole
                right half is conditional — the left half is the unchanged
                prototype line either way. */}
            {rfq.reissueCount > 0 && (
              <>
                <span className="rq-split-pipe" aria-hidden="true">|</span>
                <span className="chip-reissued" style={{ whiteSpace: 'nowrap' }}>
                  Re-issued &times;{rfq.reissueCount}
                </span>
                <IssuedPill at={rfq.lastReissuedAt} label="re-issued" />
                &middot; new deadline <b>{dash(rfq.deadline)}</b>
              </>
            )}
            &middot; <b>{rfq.vendorIds.length}</b> vendor(s)
          </div>
        ) : (
          // The prototype's own empty state (line 6166).
          <div className="text-sm text-mute">
            Click <b>Issue RFQ</b> to start the procurement flow.
          </div>
        )}

        {/* ── PER-VENDOR RFQ ISSUED-AT TABLE: REMOVED BY OWNER DECISION ───────
            The block that used to sit here listed one row per invitee with that
            vendor's own "issued" stamp and, on a re-issued RFQ, a "RFQ re-issue
            date" cell. It is gone from this card.

            Nothing was lost from the page: the same per-vendor issued stamp and
            the same ReissueCell still render in the "Request for Quotations"
            roster card below, which is the screen that lists vendors anyway.
            What is gone is the duplicate roster on a screen whose job is the
            RFQ header and the quotes table — two tables of vendors on one card,
            the second of which restates the first. */}
        {quotes.length > 0 && (
          <>
            <div className="text-sm" style={{ marginTop: 10 }}>
              <b>Quotes received ({quotes.length})</b>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 4 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-mute)', fontWeight: 500, borderBottom: '1px solid var(--line)' }}>
                  <th style={{ padding: '6px 4px' }}>Vendor</th>
                  {/* "Unit (PKR)" is GONE, by owner decision. It was rendered as a
                      permanent em-dash because a multi-line PR has no single unit
                      price — the numbers live per line in the Versions Panel. A
                      column that can only ever say "—" is worse than no column:
                      it reads as a missing value rather than a deliberate
                      decision, and it pushes the columns a buyer actually uses
                      (Total, Received, Outcome, Version) further right.

                      LEAD (d) IS SHOWN, because it is genuinely per-QUOTATION, not
                      per-line: a vendor quotes one lead time for the whole
                      submission, so it is not ambiguous here. */}
                  <th style={{ padding: '6px 4px' }}>Lead (d)</th>
                  <th style={{ padding: '6px 4px' }}>Valid</th>
                  <th style={{ padding: '6px 4px' }}>Total (PKR)</th>
                  <th style={{ padding: '6px 4px' }}>Received</th>
                  <th style={{ padding: '6px 4px' }}>Outcome</th>
                  <th style={{ padding: '6px 4px' }}>Version</th>
                  {/* Plural, and per-version: this column lists one button for
                      every version's document, not one for the live quote. */}
                  <th style={{ padding: '6px 4px' }}>Attachments</th>
                </tr>
              </thead>
              <tbody>
                {/* One <tr> per VENDOR, as before. Each stacked cell inside it
                    renders one line per VERSION from the same array, so V1's
                    numbers sit beside V1's document and V2's beside V2's. The
                    vendor is not repeated per version — that was the earlier
                    split layout's mistake. */}
                {s.roster.filter(r => (r.versions?.length ?? 0) > 0).map(r => {
                  const versions = versionStack(r);
                  const live = r.versions.filter(v => v.state === 'Submitted').slice(-1)[0];
                  const isWin = Boolean(winner && winner.vendor_id === r.vendor_id);
                  // The award belongs to the LIVE quote, so the Winner badge
                  // lands on the last Submitted line and not on V1 — pinning
                  // it to the top of the stack would read as "V1 won".
                  const liveId = live?.id;
                  return (
                    <tr key={r.vendor_id} style={{ borderBottom: '1px solid var(--line-soft)' }}>
                      <td style={{ padding: '6px 4px', verticalAlign: 'top' }}>
                        <b>{r.vendor_name}</b>
                        {r.pending_approval && (
                          <span className="pill pending" style={{ marginLeft: 6, fontSize: 10 }}>Pending approval</span>
                        )}
                        <div className="text-sm text-mute"> {r.vendor_code}</div>
                      </td>
                      <td style={{ padding: '6px 4px' }}>
                        <StackedCell
                          versions={versions}
                          render={v => (v.lead_time_days === null || v.lead_time_days === undefined
                            ? <span className="text-sm text-mute" title="No lead time stated on this version">&mdash;</span>
                            : <span title={`V${v.version} lead time`}>{v.lead_time_days}</span>)}
                        />
                      </td>
                      <td style={{ padding: '6px 4px' }}>
                        <StackedCell
                          versions={versions}
                          render={v => dash(v.validity_days ? `${v.validity_days} d` : null)}
                        />
                      </td>
                      <td style={{ padding: '6px 4px' }}>
                        <StackedCell
                          versions={versions}
                          render={v => (
                            <span title={`V${v.version} total (${versionStateWord(v)})`}>
                              <b>{Number(v.total_amount || 0).toLocaleString('en-US')}</b>
                            </span>
                          )}
                        />
                      </td>
                      <td style={{ padding: '6px 4px' }}>
                        <StackedCell
                          versions={versions}
                          render={v => (v.submitted_at
                            ? <span title={`V${v.version} received ${v.submitted_at}`}>{fmtDateTime(v.submitted_at)}</span>
                            : <span className="text-sm text-mute">&mdash;</span>)}
                        />
                      </td>
                      <td style={{ padding: '6px 4px' }}>
                        <StackedCell
                          versions={versions}
                          align="right"
                          render={v => (isWin && v.id === liveId
                            ? <span className="pill success">Winner</span>
                            : <span className="text-sm text-mute">&mdash;</span>)}
                        />
                      </td>
                      <td style={{ padding: '6px 4px' }}>
                        <StackedCell versions={versions} render={v => <VersionChipFor v={v} />} />
                      </td>
                      <td style={{ padding: '6px 4px' }}>
                        <AttachmentViews row={r} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}

        {winner && (
          <div style={{ marginTop: 10, padding: '10px 12px', background: '#DCFCE7', border: '1px solid #86EFAC', borderRadius: 8 }}>
            <div>
              <b>Winner:</b> {winner.vendor_name ?? '—'}
              <span className="text-sm text-mute"> {winner.vendor_id}</span>
            </div>
            <div className="text-sm">
              {/* Unit price is a dash, never a number divided by a quantity:
                  a grand-total quote has no unit price and inventing one is
                  exactly the error v2.0.x-audit-rules blanked the column for. */}
              Unit PKR &mdash; &middot; <b>Total {pkr(winner.total ?? 0)}</b>
            </div>
            {winner.lead_time_days !== null && winner.lead_time_days !== undefined && (
              <div className="text-sm text-mute">Lead time {winner.lead_time_days} days</div>
            )}
            {winner.reason && (
              <div className="text-sm text-mute" style={{ marginTop: 4 }}><i>"{winner.reason}"</i></div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The version chip (prototype _lightQuoteVersionChipHtml): the live version
 * number plus its status. `ACTIVE`/`SUPERSEDED`/`VOID` are the prototype's own
 * words — the plan keeps the DB vocabulary in storage and shows these here.
 */
function VersionChip({ row }: { row?: SourcingRosterRow }) {
  if (!row) return <span className="text-mute">&mdash;</span>;
  const live = row.versions.filter(v => v.state === 'Submitted' || v.state === 'Awarded').slice(-1)[0];
  if (!live) return <span className="text-mute">&mdash;</span>;
  return (
    <span className="pill success" style={{ fontSize: 10 }}>
      V{live.version} <span className="text-sm">({live.prototype_state})</span>
    </span>
  );
}

// ── card 2 · _lightRosterCard ──────────────────────────────────────────────

export function RosterCard({ s }: { s: Sourcing }) {
  const proc = s.procurement;
  const rfq = proc.rfq;
  if (!rfq) return null;   // prototype line 6197: `if(!rfq) return '';`

  return (
    <div className="card mb-4">
      <div className="card-h">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h3>Request for Quotations</h3>
          <span className="text-sm text-mute">{rfq.vendorIds.length} vendor(s) on this RFQ</span>
          <IssuedPill at={rfq.issuedAt} />
        </div>
      </div>
      <div className="card-b">
        {/* ONE ROW PER VENDOR.
            A split "original | re-issued" layout was tried and reverted by the
            owner: it printed every vendor twice, once per panel, and the roster
            is a list of people — a person appearing two rows apart is read as
            two people. The re-issue information is a COLUMN on the one row
            that vendor has, not a second copy of the row.

            The column is conditional. On an RFQ that has never been re-issued
            there is no re-issue date to show, and a permanently-present header
            full of em-dashes says nothing except that the header exists. */}
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 4 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--text-mute)', fontWeight: 500, borderBottom: '1px solid var(--line)' }}>
              <th style={{ padding: '6px 4px' }}>Vendor</th>
              <th style={{ padding: '6px 4px' }}>RFQ issued at</th>
              {rfq.reissueCount > 0 && (
                <th style={{ padding: '6px 4px' }}>RFQ re-issue date</th>
              )}
              {/* The two columns that answer "did this vendor ever answer, and
                  how often". Status alone says "Received" for a quote that
                  arrived once and for one revised four times, which is not a
                  distinction anyone can act on. */}
              <th style={{ padding: '6px 4px' }}>First quote received</th>
              <th style={{ padding: '6px 4px', textAlign: 'right' }}>Versions</th>
              <th style={{ padding: '6px 4px', textAlign: 'right' }}>Status (now)</th>
              <th style={{ padding: '6px 4px' }}>Version (now)</th>
            </tr>
          </thead>
          <tbody>
            {s.roster.map(r => (
              <tr key={r.vendor_id} style={{ borderBottom: '1px solid var(--line-soft)' }}>
                <td style={{ padding: '6px 4px' }}>
                  <b>{r.vendor_name}</b>{' '}
                  <span className="text-sm text-mute">{r.vendor_code}</span>
                  {r.pending_approval && (
                    <span className="pill pending" style={{ marginLeft: 6, fontSize: 10 }}>Pending approval</span>
                  )}
                </td>
                <td style={{ padding: '6px 4px', whiteSpace: 'nowrap' }}>
                  {r.issued_at ? <IssuedPill at={r.issued_at} label="issued" /> : <span className="text-sm text-mute">&mdash;</span>}
                </td>
                {rfq.reissueCount > 0 && (
                  <td style={{ padding: '6px 4px', whiteSpace: 'nowrap' }}>
                    <ReissueCell row={r} rfq={rfq} />
                  </td>
                )}
                <FirstQuoteCell row={r} />
                <td style={{ padding: '6px 4px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <VersionCountCell row={r} />
                </td>
                <td style={{ padding: '6px 4px', textAlign: 'right' }}>
                  <span className={`pill ${badgePill(r.badge.tone)}`}>{r.badge.label}</span>
                </td>
                <td style={{ padding: '6px 4px', whiteSpace: 'nowrap' }}>
                  <VersionChip row={r} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="text-sm text-mute" style={{ marginTop: 6 }}>
          <b>{s.roster_tally.received}</b> of <b>{s.roster_tally.invited}</b> quote
          {s.roster_tally.received === 1 ? '' : 's'} received - <b>{s.roster_tally.pending}</b> pending
        </div>
        <div className="btn-row" style={{ marginTop: 10 }}>
          <Link href={`/rfq/${rfq.rfq_id}`} className="btn sm">Open the RFQ</Link>
        </div>
      </div>
    </div>
  );
}

/**
 * WHEN DID THIS VENDOR FIRST ANSWER?
 *
 * `badge.label` only says "Received", which is the same word for a quote that
 * landed once and for one revised four times — so it cannot answer "did they
 * ever respond, and when". This is the EARLIEST submitted_at across the whole
 * version chain, not the latest: a vendor who quoted on day 1 and revised on
 * day 5 was first heard from on day 1, and the current version's timestamp
 * would silently move that answer every time they revised.
 *
 * An em-dash means never quoted at all, which is a different fact from "quoted
 * but the timestamp is missing" and must not be rendered the same way.
 */
function FirstQuoteCell({ row }: { row: SourcingRosterRow }) {
  const times = row.versions
    .map(v => v.submitted_at)
    .filter((t): t is string => Boolean(t))
    .sort();
  const first = times[0];
  if (!first) {
    return (
      <span className="text-sm text-mute" title="No quotation has been received from this vendor">
        &mdash; not received
      </span>
    );
  }
  return (
    <span style={{ whiteSpace: 'nowrap' }} title={`First received ${first} · ${row.versions.length} version(s) in total`}>
      {fmtDateTime(first)}
    </span>
  );
}

/**
 * How many quotation VERSIONS this vendor has submitted, in one number.
 *
 * Counts the whole chain, not just the live one. A superseded version is still a
 * version a human sent — a vendor who quoted three times has answered three
 * times, and showing only the live chip ("V3") hides that they revised rather
 * than simply replied late. Zero renders as an explicit 0 rather than a dash,
 * because "no versions" is the number the buyer is looking for on a row whose
 * Status already says "Awaiting quote".
 */
function VersionCountCell({ row }: { row: SourcingRosterRow }) {
  const n = row.versions.length;
  if (n === 0) return <span className="text-sm text-mute">0</span>;
  return (
    <span title={`${n} version${n === 1 ? '' : 's'} submitted in total`}>
      {n}
    </span>
  );
}

/**
 * THE VERTICAL STRUCTURE OF ONE VENDOR ROW IN "Quotes received".
 *
 * Every stacked column in that row — Lead, Valid, Total, Received, Outcome,
 * Version, Attachments — renders ONE entry per element of this list, in this
 * order. That is the whole mechanism: because all of them iterate the same
 * array, V1's lead time, V1's total, V1's receipt date and V1's document all
 * sit on the same line without any of them having to know about the others.
 *
 * It comes from `roster[].versions[]` (the whole chain, oldest first) rather
 * than `procurement.quotes` (the live version only). Reading `quotes[]` is what
 * made the row show V2's numbers under a single V2 document while V1 existed
 * in the database and was unreachable.
 */
export type VendorVersion = SourcingRosterRow['versions'][number];

function versionStack(row?: SourcingRosterRow): VendorVersion[] {
  return (row?.versions ?? []).slice().sort((a, b) => a.version - b.version);
}

/**
 * One column's worth of a stacked cell: one child per version, same count and
 * same gap as every other column in the row, so the lines line up across the
 * table. A version with nothing to show still renders (as a dash) — omitting it
 * would pull that column's lines out of alignment with the attachment buttons.
 */
function StackedCell({
  versions,
  render,
  align = 'left',
}: {
  versions: VendorVersion[];
  render: (v: VendorVersion, index: number) => React.ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        alignItems: align === 'right' ? 'flex-end' : 'flex-start',
      }}
    >
      {versions.map((v, i) => (
        <div key={v.id} style={{ whiteSpace: 'nowrap' }}>{render(v, i)}</div>
      ))}
    </div>
  );
}

/**
 * The state word for a version chip.
 *
 * `prototype_state` is the prototype's own vocabulary, but `shapeQuote` does
 * not populate it — which is why these chips have always rendered as
 * "V1 ( )" with an empty pair of brackets. Falling back to the stored `state`
 * shows the real word instead of nothing, and keeps the prototype's term if the
 * API ever starts sending one. Inventing a mapping here would be a guess; the
 * database's own word is not.
 */
function versionStateWord(v: VendorVersion): string {
  return v.prototype_state || v.state || '—';
}

function VersionChipFor({ v }: { v: VendorVersion }) {
  return (
    <span className="pill success" style={{ fontSize: 10 }}>
      V{v.version} <span className="text-sm">({versionStateWord(v)})</span>
    </span>
  );
}

/**
 * Every document in the vendor's chain, one button per VERSION, vertically
 * aligned with the stacked data columns beside it.
 *
 * A version with no document renders a muted marker rather than nothing: the
 * line stays present so this column keeps the same height as the data columns,
 * and "this version exists but has no file" is a fact worth seeing next to its
 * price. When the chain is empty entirely, one disabled View keeps the column
 * from being silently blank.
 */
function AttachmentViews({ row }: { row?: SourcingRosterRow }) {
  const versions = versionStack(row);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const open = async (attachmentId: string, name: string) => {
    if (busyId) return;
    setBusyId(attachmentId);
    setErr(null);
    try {
      await downloadFile(attachmentId, name);
    } catch (e: any) {
      setErr(e?.message || 'Could not open the attachment.');
    } finally {
      setBusyId(null);
    }
  };

  if (versions.length === 0) {
    return (
      <button type="button" className="btn sm" disabled title="This vendor has not submitted a quotation">
        View
      </button>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start' }}>
      {versions.map(v => {
        const att = (v.attachments ?? [])[0];
        if (!att) {
          return (
            <span key={v.id} className="text-sm text-mute" style={{ whiteSpace: 'nowrap' }}>
              &mdash; no file
            </span>
          );
        }
        const extra = v.attachments.length - 1;
        return (
          <span key={v.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <button
              type="button"
              className="btn sm"
              disabled={busyId !== null}
              onClick={() => open(att.id, att.name || `quotation-v${v.version}`)}
              title={`Open ${att.name || 'attachment'} — version ${v.version} (${versionStateWord(v)})`}
            >
              {busyId === att.id ? 'Opening…' : `View V${v.version}`}
            </button>
            {extra > 0 && (
              <span className="text-sm text-mute" title={`${v.attachments.length} documents on this version`}>
                +{extra}
              </span>
            )}
          </span>
        );
      })}
      {err && <span className="text-sm" style={{ color: '#B91C1C' }} title={err}>{err}</span>}
    </div>
  );
}

/** Winner / Received / Awaiting quote — the prototype's inline pill colours. */
function badgePill(tone: string) {
  if (tone === 'info') return 'info';
  if (tone === 'neutral') return 'draft';
  return 'draft';
}
