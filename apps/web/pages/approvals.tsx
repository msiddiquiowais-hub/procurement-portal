// `approvals` — My Approvals.
//
// Port of renderApprovals (prototype line 8896). The prototype builds two
// queues: "Detailed flow" (legacy capital-PR stages) and "Lightweight PRs"
// (PRs whose current stage is owned by the viewer's role). The Lightweight
// queue is the one backed by real data; the Detailed flow section renders
// whenever legacy-vocabulary PRs are present and stays empty until Wave 1's
// legacy screens land.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { useSession } from '../lib/session';
import { api } from '../lib/api';
import Shell from '../components/Shell';
import { StagePill, DeptChip, pkr, fmtDate } from '../lib/ui';
import { canSeeScreen } from '@procurement/roles';

type QRow = {
  id: string;
  pr_number: string;
  title: string | null;
  status: string;
  stage_owner: string;
  estimated_amount: number;
  currency: string;
  required_by_date: string;
  urgency: string;
  expense_type: string;
  department_name: string | null;
  requester_name: string;
  warehouse_check_required: boolean;
  is_split_parent: boolean;
  last_updated_at: string;
};

const LEGACY_DETAIL: Array<{ stage: string; pill: string; pillText: string; action: string; target: string }> = [
  { stage: 'Submitted',  pill: 'info',   pillText: 'HOD',  action: 'Approve / Reject', target: 'pr-review' },
  { stage: 'CS_Generated', pill: 'warn', pillText: 'MC',   action: 'Vote',             target: 'mc-vote' },
  { stage: 'MC_Approved', pill: 'info',  pillText: 'CFO',  action: 'Approve / Reject', target: 'cfo-approve' },
  { stage: 'CFO_Approved',pill: 'warn',  pillText: 'CS',   action: 'Lock',             target: 'pack' },
];

export default function Approvals() {
  const { session, ready } = useSession();
  const router = useRouter();
  const [rows, setRows] = useState<QRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;                 // session not read from storage yet
    if (!session) { router.replace('/'); return; }
    if (!canSeeScreen(session.user.role, 'approvals')) { router.replace('/pr'); return; }
    api.get<{ rows: QRow[] }>('/pr/approvals/queue')
      .then(r => setRows(r.data.rows))
      .catch(e => setErr(e.message));
  }, [ready, session]);

  if (!ready) return null;
  if (!session) return null;
  const role = session.user.role;

  // The legacy "Detailed flow" cards only appear for legacy-vocabulary stages.
  const detailed = rows.filter(r => LEGACY_DETAIL.some(d => d.stage === r.status));
  const light = rows.filter(r => !LEGACY_DETAIL.some(d => d.stage === r.status));

  return (
    <Shell title="My Approvals" screenId="approvals"
      subtitle={`Pending decisions for role ${role.toUpperCase()}.`}>
      {err && <div className="alert error">{err}</div>}

      {detailed.length > 0 && (
        <div className="card">
          <div className="card-h"><h3>Detailed flow</h3></div>
          <div className="card-b" style={{ padding: 0 }}>
            {detailed.map(p => {
              const d = LEGACY_DETAIL.find(x => x.stage === p.status)!;
              return (
                <div key={p.id} className="queue-row" onClick={() => router.push(`/pr/${p.id}`)}>
                  <span className={`pill ${d.pill}`} style={{ margin: 0 }}>{d.pillText}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>
                      {p.pr_number} — {p.title || '(no title)'}
                    </div>
                    <div className="text-sm text-mute">
                      {p.department_name} · {pkr(p.estimated_amount)} · {p.expense_type}
                    </div>
                  </div>
                  <button className="btn primary sm">{d.action} →</button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {light.length > 0 && (
        <div className="card">
          <div className="card-h">
            <h3>Lightweight PRs</h3>
            <span className="meta">{light.length} pending</span>
          </div>
          <div className="card-b" style={{ padding: 0 }}>
            {light.map(p => (
              <div key={p.id} className="queue-row" onClick={() => router.push(`/pr/${p.id}`)}>
                <StagePill stage={p.status} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>
                    <span className="mono">{p.pr_number}</span>
                    {' — '}
                    {p.title || '(no description)'}
                    {p.is_split_parent && <span className="split-flag">SPLIT</span>}
                  </div>
                  <div className="text-sm text-mute">
                    <DeptChip name={p.department_name} /> {pkr(p.estimated_amount)} · {p.expense_type} ·{' '}
                    {p.urgency === 'routine' ? 'NORMAL' : p.urgency.toUpperCase()} · due {fmtDate(p.required_by_date)}
                  </div>
                </div>
                <button className="btn primary sm">Review →</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {detailed.length === 0 && light.length === 0 && (
        <div className="card">
          <div className="card-b empty-state">
            No approvals pending for your role at the current stage.
          </div>
        </div>
      )}

      {light.length > 0 && (
        <div className="btn-row">
          <Link href="/pr" className="btn">Back to all requests</Link>
        </div>
      )}
    </Shell>
  );
}
