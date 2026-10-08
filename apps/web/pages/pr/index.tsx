// `light-pr-list` — My Light Purchase Requests.
//
// Port of renderLightPRList (prototype line 8112). Structure preserved exactly:
// CTA row -> gradient hero with a 3-up KPI band -> table with the prototype's
// seven columns, or a role-specific empty state.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { useSession } from '../../lib/session';
import { api } from '../../lib/api';
import Shell from '../../components/Shell';
import { ItemChips, DeptChip, StagePill, pkr, fmtDate } from '../../lib/ui';

type Row = {
  id: string;
  pr_number: string;
  title: string | null;
  description: string | null;
  department_name: string | null;
  requester_name: string;
  estimated_amount: number;
  status: string;
  last_updated_at: string;
  item_count: number;
  items_preview: Array<{ qty: number; uom: string; description: string | null }>;
  items_overflow: number;
};

type Header = {
  total: number; open: number; closed: number;
  seesAll: boolean; scopeDept: string | null; viewLabel: string;
};

export default function LightPrList() {
  const { session, ready } = useSession();
  const router = useRouter();
  const [header, setHeader] = useState<Header | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;                 // session not read from storage yet
    if (!session) { router.replace('/'); return; }
    api.get<{ header: Header; rows: Row[] }>('/pr/light/list')
      .then(r => { setHeader(r.data.header); setRows(r.data.rows); })
      .catch(e => setErr(e.message));
  }, [ready, session]);

  if (!ready) return null;
  if (!session) return null;
  const role = session.user.role;
  const canSubmit = role === 'requester' || header?.seesAll || role === 'hod';

  return (
    <Shell title="My Light Purchase Requests" screenId="light-pr-list"
      subtitle="Lightweight purchase requests raised by the new-process flow.">
      {err && <div className="alert error">{err}</div>}

      {canSubmit && (
        <div className="btn-row" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>
          <Link href="/pr/new" className="btn success">+ New Purchase Request</Link>
          {header?.seesAll && <Link href="/my-prs" className="btn">View My PRs (detailed)</Link>}
        </div>
      )}

      {/* Gradient hero + KPI band — prototype light-pr-list header card */}
      <div className="card list-hero">
        <div className="card-h list-hero-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <h2>My Light Purchase Requests</h2>
              <div className="list-hero-sub">
                {header?.seesAll
                  ? 'Track all lightweight purchase requests across the organization.'
                  : `Track lightweight purchase requests in ${header?.scopeDept || 'your'} department.`}
              </div>
            </div>
            <div className="list-hero-view">
              <span>▤</span>{header?.viewLabel || '—'}
            </div>
          </div>
        </div>
        <div className="card-b list-hero-body">
          <div className="kpi-row">
            <div className="kpi-card">
              <div className="kpi-label">Total Requests</div>
              <div className="kpi-value">{header?.total ?? 0}</div>
              <div className="kpi-sub">All lightweight PRs in scope</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">In Progress</div>
              <div className="kpi-value" style={{ color: 'var(--accent)' }}>{header?.open ?? 0}</div>
              <div className="kpi-sub">Awaiting HOD, Procurement, or Finance</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Closed</div>
              <div className="kpi-value" style={{ color: 'var(--text-mute)' }}>{header?.closed ?? 0}</div>
              <div className="kpi-sub">Rejected, pushed to D365, or closed</div>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h3>Lightweight Purchase Requests</h3>
          <span className="meta">
            {header?.seesAll
              ? `${header.total} visible org-wide`
              : `${header?.total ?? 0} in ${header?.scopeDept || 'your scope'}`}
          </span>
        </div>
        {rows.length === 0 ? (
          <div className="card-b empty-state">
            {header?.seesAll
              ? 'No lightweight PRs in the system yet.'
              : role === 'hod'
                ? 'No lightweight PRs in your department yet.'
                : <>No lightweight PRs yet. Click <b>New Purchase Request</b> above to create your first one.</>}
          </div>
        ) : (
          <table className="t">
            <thead>
              <tr>
                <th>PR Number</th><th>Title</th><th>Department</th><th>Items</th>
                <th>Est. Amount</th><th>Stage</th><th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(p => {
                // Prototype: prefer explicit title; fall back to the single
                // line's description. Never inline the flattened item list.
                const titleText = (p.title || '').trim()
                  || (p.item_count === 1 ? (p.items_preview[0]?.description || '—') : '—');
                return (
                  <tr key={p.id} className="clickable"
                      onClick={() => router.push(`/pr/${p.id}`)}>
                    <td className="mono">{p.pr_number}</td>
                    <td>
                      <div className="row-title">{titleText}</div>
                      {(p.title || '').trim() && p.department_name && (
                        <div className="row-sub">{p.department_name}</div>
                      )}
                    </td>
                    <td><DeptChip name={p.department_name} /></td>
                    <td>
                      <ItemChips items={p.items_preview} overflow={p.items_overflow} />
                    </td>
                    <td className="mono num">{p.estimated_amount ? pkr(p.estimated_amount) : '—'}</td>
                    <td><StagePill stage={p.status} /></td>
                    <td className="text-sm text-mute">{fmtDate(p.last_updated_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Shell>
  );
}
