// `my-prs` — My Purchase Requisitions.
//
// Port of renderMyPRs (prototype line 8059), reduced to the lightweight
// request table. The prototype's first table ("Detailed flow" — the capital
// requisition) is no longer shown here; capital PRs stay reachable through
// the New PR / New Purchase Requisition entry points and their own detail
// screens, they are just not listed on this page.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useSession } from '../lib/session';
import { api } from '../lib/api';
import Shell from '../components/Shell';
import { StagePill, DeptChip, pkr, fmtDate } from '../lib/ui';
import { canSeeScreen } from '@procurement/roles';

type Light = {
  id: string; pr_number: string; title: string | null; description: string | null;
  estimated_amount: number; urgency: string; status: string;
  department_name: string; item_count: number;
  first_qty: number | null; first_uom: string | null;
  last_updated_at: string;
};

export default function MyPrs() {
  const { session, ready } = useSession();
  const router = useRouter();
  const [light, setLight] = useState<Light[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;                 // session not read from storage yet
    if (!session) { router.replace('/'); return; }
    api.get<{ detailed: unknown[]; light: Light[] }>('/pr/capital/my')
      .then(r => setLight(r.data.light || []))
      .catch(e => setErr(e.message));
  }, [ready, session]);

  if (!ready) return null;
  if (!session) return null;
  const role = session.user.role;
  const canCreate = canSeeScreen(role, 'pr-create');

  return (
    <Shell title="My Purchase Requisitions" screenId="my-prs"
      subtitle="The lightweight purchase requests you have raised.">
      {err && <div className="alert error">{err}</div>}

      {canCreate && (
        <div className="btn-row" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>
          <Link href="/pr/create" className="btn success">+ New Purchase Requisition</Link>
          <Link href="/pr/new" className="btn">New Lightweight Request</Link>
        </div>
      )}

      {/* ── Lightweight PRs ─────────────────────────────────────────── */}
      <div className="card">
        <div className="card-h">
          <h3>Lightweight PRs</h3>
          <span className="meta">{light.length} requests</span>
        </div>
        {light.length === 0 ? (
          <div className="card-b empty-state">No lightweight requests yet.</div>
        ) : (
          <table className="t">
            <thead>
              <tr>
                <th>PR Number</th><th>Description</th><th>Dept</th>
                <th>Qty × UoM</th><th className="num">Est. Amount</th>
                <th>Priority</th><th>Stage</th><th>Flow</th>
              </tr>
            </thead>
            <tbody>
              {light.map(p => (
                <tr key={p.id} className="clickable" onClick={() => router.push(`/pr/${p.id}`)}>
                  <td className="mono">{p.pr_number}</td>
                  <td>
                    <div className="row-title">{p.title || p.description || '—'}</div>
                    {p.title && p.description && <div className="row-sub">{p.description}</div>}
                  </td>
                  <td><DeptChip name={p.department_name} /></td>
                  <td className="text-sm">
                    {p.first_qty !== null ? `${p.first_qty} ${p.first_uom || ''}` : '—'}
                    {p.item_count > 1 && <span className="text-mute"> +{p.item_count - 1}</span>}
                  </td>
                  <td className="mono num">{pkr(p.estimated_amount)}</td>
                  <td>
                    <span className={p.urgency === 'urgent' ? 'urgency-urgent' : p.urgency === 'force_majeure' ? 'urgency-force_majeure' : 'text-sm text-mute'}>
                      {p.urgency === 'routine' ? 'NORMAL' : p.urgency.toUpperCase()}
                    </span>
                  </td>
                  <td><StagePill stage={p.status} /></td>
                  <td className="text-sm text-mute">{fmtDate(p.last_updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Shell>
  );
}
