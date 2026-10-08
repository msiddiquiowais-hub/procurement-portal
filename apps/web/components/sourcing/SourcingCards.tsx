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
import { pkr, fmtDateTime } from '../../lib/ui';

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
  lead_time_days: number | null;
  warranty_months: number | null;
  valid_until_days: number | null;
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
  declined: boolean;
  declined_reason: string | null;
  quote_count: number;
  pending_approval: boolean;
  badge: { label: string; tone: string };
  versions: Array<{ id: string; version: number; state: string; prototype_state: string; total_amount: number; submitted_at: string | null; quote_mode: string | null }>;
};

export type Sourcing = {
  procurement: {
    rfq: {
      id: string; rfq_id: string;
      vendorIds: string[];
      issuedAt: string | null;
      issuedAtByVendor: Record<string, string | null>;
      deadline: string | null;
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
            &middot; deadline <b>{dash(rfq.deadline)}</b> &middot; <b>{rfq.vendorIds.length}</b> vendor(s)
          </div>
        ) : (
          // The prototype's own empty state (line 6166).
          <div className="text-sm text-mute">
            Click <b>Issue RFQ</b> to start the procurement flow.
          </div>
        )}

        {/* Per-vendor RFQ issued-at table — prototype lines 6122-6130. Rendered
            whenever the RFQ has vendors and there are no per-vendor notes. */}
        {rfq && rfq.vendorIds.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <b>Per-vendor RFQ issued at:</b>
            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 4, fontSize: 13 }}>
              <tbody>
                {s.roster.map(r => (
                  <tr key={r.vendor_id}>
                    <td style={{ padding: '4px 6px' }}><b>{r.vendor_name}</b></td>
                    <td style={{ padding: '4px 6px' }} className="text-sm">
                      {r.issued_at
                        ? <IssuedPill at={r.issued_at} label="issued" />
                        : <span className="text-mute">&mdash;</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {quotes.length > 0 && (
          <>
            <div className="text-sm" style={{ marginTop: 10 }}>
              <b>Quotes received ({quotes.length})</b>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 4 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-mute)', fontWeight: 500, borderBottom: '1px solid var(--line)' }}>
                  <th style={{ padding: '6px 4px' }}>Vendor</th>
                  {/* v2.0.x-audit-rules: these two headers are blank on purpose.
                      For a multi-line PR a single unit price or lead time is
                      misleading; the numbers live in the Versions Panel. */}
                  <th style={{ padding: '6px 4px' }} title="Per-line unit prices: open the Versions Panel">Unit (PKR)</th>
                  <th style={{ padding: '6px 4px' }} title="Per-line lead times: open the Versions Panel">Lead (d)</th>
                  <th style={{ padding: '6px 4px' }}>Valid</th>
                  <th style={{ padding: '6px 4px' }}>Total (PKR)</th>
                  <th style={{ padding: '6px 4px' }}>Received</th>
                  <th style={{ padding: '6px 4px' }}>Outcome</th>
                  <th style={{ padding: '6px 4px' }}>Version</th>
                </tr>
              </thead>
              <tbody>
                {quotes.map(q => {
                  const isWin = Boolean(winner && winner.vendor_id === q.vendor_id);
                  return (
                    <tr key={q.id} style={{ borderBottom: '1px solid var(--line-soft)' }}>
                      <td style={{ padding: '6px 4px' }}>
                        <b>{q.vendor_name}</b>
                        {/* Q3: a vendor off the approved roster is badged, not blocked. */}
                        {q.is_new_vendor && (
                          <span className="pill pending" style={{ marginLeft: 6, fontSize: 10 }}>Pending approval</span>
                        )}
                        <span className="text-sm text-mute"> {q.vendor_code}</span>
                      </td>
                      <td style={{ padding: '6px 4px' }} className="text-sm text-mute"
                          title="Per-line unit prices: open the Versions Panel">&mdash;</td>
                      <td style={{ padding: '6px 4px' }} className="text-sm text-mute"
                          title="Per-line lead times: open the Versions Panel">&mdash;</td>
                      <td style={{ padding: '6px 4px' }}>{dash(q.valid_until_days ? `${q.valid_until_days} d` : null)}</td>
                      <td style={{ padding: '6px 4px' }}><b>{q.total.toLocaleString('en-US')}</b></td>
                      <td style={{ padding: '6px 4px', whiteSpace: 'nowrap' }}>
                        {q.received_at
                          ? <span title={`Received ${q.received_at}`}>{fmtDateTime(q.received_at)}</span>
                          : <span className="text-sm text-mute">&mdash;</span>}
                      </td>
                      <td style={{ padding: '6px 4px' }}>
                        {isWin
                          ? <span className="pill success">Winner</span>
                          : <span className="text-sm text-mute">&mdash;</span>}
                      </td>
                      <td style={{ padding: '6px 4px', whiteSpace: 'nowrap' }}>
                        <VersionChip row={s.roster.find(r => r.vendor_id === q.vendor_id)} />
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
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 4 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--text-mute)', fontWeight: 500, borderBottom: '1px solid var(--line)' }}>
              <th style={{ padding: '6px 4px' }}>Vendor</th>
              <th style={{ padding: '6px 4px' }}>RFQ issued at</th>
              <th style={{ padding: '6px 4px', textAlign: 'right' }}>Status</th>
              <th style={{ padding: '6px 4px' }}>Version</th>
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

/** Winner / Received / Awaiting quote — the prototype's inline pill colours. */
function badgePill(tone: string) {
  if (tone === 'info') return 'info';
  if (tone === 'neutral') return 'draft';
  return 'draft';
}
