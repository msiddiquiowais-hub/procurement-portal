// `rfq-detail` — RFQ & Quotes.
//
// Port of renderRFQDetail (prototype line 7809). Structure preserved exactly:
// page title + subtitle -> the two stage alerts -> the "Vendors & quotes"
// card with a `bid-row` header and one row per bid -> the action row.
//
// ── Two deliberate divergences, both on the record ──────────────────────────
//
// 1. THE WINNER COLUMN IS NOT `i === 0`.
//    The prototype marks the FIRST quote as "Winner" and shades its row,
//    because its demo data has no Comparative Statement — the winner is
//    whatever happens to be first in the array. In a real procurement system
//    that would badge an arbitrary bid as the winner, which is precisely what
//    the CS process exists to prevent. We shade and badge the vendor the LOCKED
//    comparative statement names, and render an em-dash until one is locked.
//
// 2. COMPLIANCE IS DERIVED, NOT ASSUMED (plan D5).
//    The prototype hardcodes "✓ Pass" in the Compliance cell for every bid. It
//    has no compliance source, so that is a decorative constant. We read
//    core.vendor_due_diligence: an approved record is a real pass, and anything
//    else — no record, one in progress, a rejected one — renders as "—".

import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { useSession } from '../../lib/session';
import { api } from '../../lib/api';
import Shell from '../../components/Shell';
import { pkr, fmtDate, fmtDateTime } from '../../lib/ui';

type Compliance = { status: 'pass' | 'unknown' | 'fail'; label: string };

type Bid = {
  quotation_id: string;
  vendor_id: string;
  vendor_name: string;
  vendor_code: string;
  version: number;
  state: string;
  amount: number;
  currency: string;
  lead_days: number | null;
  warranty_months: number | null;
  validity_days: number | null;
  received_at: string | null;
  is_new_vendor: boolean;
  compliance: Compliance;
  is_winner: boolean;
};

type Detail = {
  rfq: {
    id: string; rfq_number: string; pr_id: string; pr_number: string;
    pr_title: string | null; pr_status: string; title: string | null;
    state: string; currency: string; deadline_at: string | null;
    issued_at: string | null; issued_by: string | null;
    status: string; pill: string;
  };
  bids: Bid[];
  winner: { vendor_id: string; vendor_name: string | null; total: number | null; reason: string | null } | null;
  roster: Array<{ vendor_id: string; vendor_name: string; issued_at: string; badge: { label: string }; pending_approval: boolean }>;
  roster_tally: { received: number; invited: number; pending: number; text: string };
};

/** The prototype's lead/warranty cells print whatever the quote recorded. */
function cell(v: number | null, suffix?: string) {
  if (v === null || v === undefined) return <span className="text-mute">&mdash;</span>;
  return <>{v}{suffix ? <span className="text-sm text-mute"> {suffix}</span> : null}</>;
}

export default function RfqDetail() {
  const { session, ready } = useSession();
  const router = useRouter();
  const id = router.query.id as string;
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!ready || !id) return;
    if (!session) { router.replace('/'); return; }
    api.get<Detail>(`/rfq/${id}`)
      .then(r => setD(r.data))
      .catch(e => setErr(e.message));
  }, [ready, session, id]);

  if (!ready || !session || !id) return null;

  const role = session.user.role;
  const canLock = role === 'procurement' || role === 'cs' || role === 'admin';
  const bids = d?.bids ?? [];
  // The prototype's two stage alerts. The port keys them off real state rather
  // than the prototype's stage names: the PR being in procurement review with
  // no RFQ is step 1's concern, so here "quotes needed" is simply an RFQ whose
  // quotes have not all arrived.
  const awaitingQuotes = bids.length === 0;
  const allIn = bids.length > 0 && d!.roster_tally.received >= d!.roster_tally.invited;

  return (
    <Shell title={`RFQ ${d?.rfq.rfq_number ?? '…'}`} screenId="rfq-detail"
      subtitle={d ? `${d.rfq.pr_number} · ${d.rfq.title ?? ''}` : ''}>
      {err && <div className="alert error">{err}</div>}

      <h1 className="page-title">RFQ {d?.rfq.rfq_number ?? 'pending'}</h1>
      <p className="page-sub">
        {d?.rfq.pr_number} &middot; {d?.rfq.title ?? ''}
      </p>

      {awaitingQuotes && (
        <div className="alert info">
          RFQ issued to {d?.roster_tally.invited ?? 0} vendors. No quotes have arrived yet.
        </div>
      )}
      {allIn && (
        <div className="alert success">
          {d?.roster_tally.received} quotes received. Lock the Comparative Statement to
          recommend a winner.
        </div>
      )}

      <div className="card mb-4">
        <div className="card-h">
          <h3>Vendors &amp; quotes</h3>
          <span className="meta">
            {d?.roster_tally.text}
            {d?.rfq.deadline_at ? ` · Due ${fmtDate(d.rfq.deadline_at)}` : ''}
          </span>
        </div>

        <div className="bid-row head">
          <div>Vendor</div><div>Amount</div><div>Lead</div><div>Warranty</div>
          <div>Compliance</div><div></div>
        </div>

        {bids.length === 0 ? (
          <div className="empty-state">No quotes yet</div>
        ) : (
          bids.map(b => (
            <div key={b.quotation_id} className={`bid-row${b.is_winner ? ' winner' : ''}`}>
              <div>
                <div style={{ fontWeight: 600 }}>
                  {b.vendor_name}
                  {/* The prototype's `isNewVendor` flag (Q3). */}
                  {b.is_new_vendor && (
                    <span className="pill pending" style={{ marginLeft: 6 }}>Pending approval</span>
                  )}
                </div>
                <div className="text-sm text-mute">
                  Valid {b.validity_days !== null ? `${b.validity_days} days` : '—'}
                  {b.received_at ? ` · Received ${fmtDateTime(b.received_at)}` : ''}
                </div>
              </div>
              <div>
                <div className="text-sm text-mute">Amount</div>
                <div style={{ fontWeight: 600 }}>{pkr(b.amount)}</div>
              </div>
              <div>
                <div className="text-sm text-mute">Lead time</div>
                <div>{cell(b.lead_days, 'days')}</div>
              </div>
              <div>
                <div className="text-sm text-mute">Warranty</div>
                <div>{cell(b.warranty_months, 'mo')}</div>
              </div>
              <div>
                <div className="text-sm text-mute">Compliance</div>
                {/* D5: unknown renders as an em-dash, never a fabricated pass. */}
                <div style={b.compliance.status === 'pass' ? { color: 'var(--success)' } : undefined}
                     title={b.compliance.status === 'unknown'
                       ? 'No completed due-diligence record for this vendor'
                       : undefined}>
                  {b.compliance.status === 'unknown'
                    ? <span className="text-mute">&mdash;</span>
                    : b.compliance.label}
                </div>
              </div>
              {/* Winner from the LOCKED CS, never "the first row". */}
              {b.is_winner
                ? <div className="bid-winner"><span className="pill locked">Winner</span></div>
                : <div className="text-sm text-mute">&mdash;</div>}
            </div>
          ))
        )}

        {canLock && bids.length > 0 && (
          <div className="card-b" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {/* The CS lock lands with Wave 2 step 6 and the `cs` screen in step 7.
                Rendered disabled rather than wired to a route that 404s. */}
            {bids.map(b => (
              <button key={b.quotation_id} className="btn ghost" disabled
                title="Comparative Statement lock lands with Wave 2 step 6">
                Lock CS &mdash; pick {b.vendor_name}
              </button>
            ))}
          </div>
        )}
      </div>

      {canLock && (
        <div className="btn-row">
          {bids.length === 0 ? (
            <Link href={`/pr/${d?.rfq.pr_id}`} className="btn primary">
              Open the Purchase Request
            </Link>
          ) : (
            <Link href={`/pr/${d?.rfq.pr_id}`} className="btn ghost">
              View on Purchase Request
            </Link>
          )}
        </div>
      )}
    </Shell>
  );
}
