// `rfq-list` — Request for Quotations.
//
// Port of renderRFQList (prototype line 8974). Structure preserved exactly:
// page title + subtitle -> 4-up KPI band -> one table with the prototype's
// eight columns.
//
// Every number on this page comes from the API's `rollups` block, which is
// computed by rfqRollups() — the pure port of the prototype's own KPI maths.
// The renderer does no arithmetic of its own, so the tiles and the API can
// never disagree.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useSession } from '../../lib/session';
import { api } from '../../lib/api';
import Shell from '../../components/Shell';
import { pkr, fmtDate } from '../../lib/ui';

type Row = {
  id: string;
  rfq_number: string;
  pr_id: string;
  pr_number: string;
  title: string | null;
  state: string;
  invited: number;
  quotes: number;
  lowest_bid: number | null;
  issued_at: string | null;
  /** The prototype's own label + pill, from rfqStatusView(). */
  status: string;
  pill: string;
};

type Rollups = {
  total: number;
  open: number;
  avgQuotes: string;
  totalQuotedValue: number;
};

export default function RfqList() {
  const { session, ready } = useSession();
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [k, setK] = useState<Rollups | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    if (!session) { router.replace('/'); return; }
    api.get<{ rows: Row[]; rollups: Rollups }>('/rfq')
      .then(r => { setRows(r.data.rows); setK(r.data.rollups); })
      .catch(e => setErr(e.message));
  }, [ready, session]);

  if (!ready) return null;
  if (!session) return null;

  return (
    <Shell title="Request for Quotations" screenId="rfq-list"
      subtitle="All RFQs you can see.">
      {err && <div className="alert error">{err}</div>}

      <h1 className="page-title">Request for Quotations</h1>
      <p className="page-sub">
        All RFQs you can see &middot; {k?.total ?? 0} total &middot; {k?.open ?? 0} open
      </p>

      {/* The four KPI cards, verbatim from renderRFQList:8980-8985. */}
      <div className="grid g-4 mb-4">
        <div className="card kpi">
          <div className="kpi-label">Total RFQs</div>
          <div className="kpi-value">{k?.total ?? 0}</div>
          <div className="kpi-sub">This fiscal year</div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">Open</div>
          <div className="kpi-value" style={{ color: 'var(--warn)' }}>{k?.open ?? 0}</div>
          <div className="kpi-sub">Awaiting or collecting quotes</div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">Avg quotes / RFQ</div>
          <div className="kpi-value">{k?.avgQuotes ?? '0.0'}</div>
          <div className="kpi-sub">Target &ge; 3 per RFQ</div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">Total quoted value</div>
          {/* The prototype styles this tile's value at 18px because a formatted
              PKR figure is much wider than a bare count. */}
          <div className="kpi-value" style={{ fontSize: 18 }}>
            {pkr(k?.totalQuotedValue ?? 0)}
          </div>
          <div className="kpi-sub">Lowest bid per RFQ</div>
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h3>All RFQs</h3>
          <span className="meta">Sorted newest first</span>
        </div>
        {rows.length === 0 ? (
          <div className="card-b empty-state">
            No RFQs yet. They are issued from a Purchase Request once procurement picks it up.
          </div>
        ) : (
          <table className="t">
            <thead>
              <tr>
                <th>RFQ</th><th>PR</th><th>Description</th><th>Vendors</th>
                <th>Quotes</th><th>Lowest bid</th><th>Issued</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className="clickable" onClick={() => router.push(`/rfq/${r.id}`)}>
                  <td className="mono"><b>{r.rfq_number}</b></td>
                  <td className="mono text-mute">{r.pr_number}</td>
                  <td>{r.title || '—'}</td>
                  <td>{r.invited} invited</td>
                  <td>{r.quotes}</td>
                  {/* The prototype renders an em-dash, never 0, when nothing has
                      been quoted yet — a zero would read as a real bid. */}
                  <td style={{ textAlign: 'right' }} className="mono num">
                    {r.lowest_bid !== null ? pkr(r.lowest_bid) : <span className="text-mute">&mdash;</span>}
                  </td>
                  <td className="text-sm text-mute">{fmtDate(r.issued_at)}</td>
                  <td><span className={`pill ${r.pill}`}>{r.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Shell>
  );
}
