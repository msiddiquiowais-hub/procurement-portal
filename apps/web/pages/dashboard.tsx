// `dashboard` — port of renderDashboard (prototype line 7582).
//
// Structure is the prototype's: page title, role subtitle, a 4-up KPI band,
// then a 2:1 grid with the focus-PR card on the left and the activity feed +
// quick actions on the right.
//
// DIVERGENCE (deliberate): the prototype's four KPI cards are hardcoded demo
// constants — a fixed role count, "PKR 1.2 Cr" tracked savings, "8.4 days"
// average cycle. Those are walkthrough placeholders; rendering them against
// real data would be a lie. The card *structure* and labels are the
// prototype's, the *values* are computed from the queue + reporting tables.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useSession } from '../lib/session';
import { api } from '../lib/api';
import Shell from '../components/Shell';
import { StagePill, DeptChip, pkr, fmtDate } from '../lib/ui';
import { ROLE_LABELS, canSeeScreen } from '@procurement/roles';

type Row = {
  id: string; pr_number: string; title: string | null; status: string;
  estimated_amount: number; department_name: string | null;
  requester_name: string; required_by_date: string; last_updated_at: string;
  urgency: string;
};

type Queue = { rows: Array<Row & { stage_owner: string; is_split_parent: boolean; warehouse_check_required: boolean }> };

const ROLE_KPI_LABEL: Record<string, string> = {
  requester: 'My Open PRs',
  hod: 'Awaiting HOD',
  procurement: 'In Procurement',
  cs: 'CS in progress',
  mc: 'MC open votes',
  cfo: 'Pending CFO',
  finance: 'Awaiting Finance',
  management: 'Awaiting Management',
  vendor: 'Open RFQs for me',
  admin: 'Active items',
};

const TERMINAL = ['D365_PUSHED', 'REJECTED', 'CLOSED', 'Fulfilled'];

export default function Dashboard() {
  const { session, ready } = useSession();
  const router = useRouter();
  const [mine, setMine] = useState<Row[]>([]);
  const [queue, setQueue] = useState<Queue['rows']>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;                 // session not read from storage yet
    if (!session) { router.replace('/'); return; }
    const me = session.user.id;

    api.get<Row[]>('/pr')
      .then(r => {
        // "My" = raised by me, or in my queue. Mirrors the prototype's
        // role-scoped dashboard rather than dumping the whole org.
        const rows = r.data as Row[];
        setMine(rows.filter(p => p.requester_name === session.user.displayName).slice(0, 8));
      })
      .catch(e => setErr(e.message));

    if (canSeeScreen(session.user.role, 'approvals')) {
      api.get<Queue>('/pr/approvals/queue')
        .then(r => setQueue(r.data.rows))
        .catch(() => setQueue([]));
    }
  }, [ready, session]);

  if (!ready) return null;
  if (!session) return null;
  const role = session.user.role;

  const focus = queue[0] || mine[0] || null;
  const kpiLabel = ROLE_KPI_LABEL[role] || 'Active items';
  const kpiValue = role === 'requester' ? mine.length : queue.length;
  const kpiSub = role === 'requester'
    ? 'Open requests you raised'
    : queue.some(q => q.urgency === 'urgent') ? '1 SLA at risk' : 'As of today';

  const openValue = (mine.filter(p => !TERMINAL.includes(p.status)).reduce((s, p) => s + p.estimated_amount, 0));

  return (
    <Shell title={`Welcome, ${session.user.displayName}`} screenId="dashboard"
      subtitle={`Acting as ${ROLE_LABELS[role] || role.toUpperCase()}.`}>
      {err && <div className="alert error">{err}</div>}

      {/* 4-up KPI band — prototype structure */}
      <div className="grid g-4">
        <div className="card kpi">
          <div className="kpi-label">{kpiLabel}</div>
          <div className="kpi-value">{kpiValue}</div>
          <div className="kpi-sub">{kpiSub}</div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">Focus PR</div>
          <div className="kpi-value" style={{ fontSize: 18 }}>
            {focus ? <StagePill stage={focus.status} /> : '—'}
          </div>
          <div className="kpi-sub">
            {focus ? <span className="mono">{focus.pr_number} · {pkr(focus.estimated_amount)}</span> : 'Nothing in your queue'}
          </div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">My Open Value</div>
          <div className="kpi-value" style={{ fontSize: 24, color: 'var(--success)' }}>{pkr(openValue)}</div>
          <div className="kpi-sub">Across {mine.length} raised requests</div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">Pending in my queue</div>
          <div className="kpi-value">{queue.length}</div>
          <div className="kpi-sub">{canSeeScreen(role, 'approvals') ? 'Awaiting your decision' : 'No approval stage for this role'}</div>
        </div>
      </div>

      {/* 2:1 grid — focus card + activity/quick actions */}
      <div className="grid g-2-1">
        <div className="card">
          <div className="card-h">
            <h3>{focus ? 'Focus request' : 'No active request'}</h3>
            {focus && <Link href={`/pr/${focus.id}`} className="btn sm">Open detail →</Link>}
          </div>
          <div className="card-b">
            {!focus ? (
              <div className="empty-state">
                Nothing is waiting on you right now.
                {role === 'requester' && <> Start a <Link href="/pr/new"><b>New Purchase Request</b></Link>.</>}
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>
                      {focus.title || focus.pr_number}
                    </div>
                    <div className="text-sm text-mute">
                      <DeptChip name={focus.department_name} /> · {focus.requester_name}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontWeight: 700, fontSize: 18 }}>{pkr(focus.estimated_amount)}</div>
                    <div><StagePill stage={focus.status} /></div>
                  </div>
                </div>
                <div className="btn-row">
                  <Link href={`/pr/${focus.id}`} className="btn primary">Open PR detail</Link>
                  {/* Gated on pr-review, not on `approvals`: /pr/review/[id]
                      redirects any other role back to /pr, so gating this on
                      `approvals` (hod,mc,cfo,cs) handed mc/cfo/cs a button that
                      silently dumped them on the PR list. Only the HOD may open
                      the review screen (prototype:624 data-roles="hod"). */}
                  {canSeeScreen(role, 'pr-review') && (
                    <Link href={`/pr/review/${focus.id}`} className="btn">Review lines</Link>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        <div>
          {/* Activity feed — the prototype's eventFeedHtml(5) */}
          <div className="card">
            <div className="card-h">
              <h3>Activity feed</h3>
              <span className="meta">{mine.length + queue.length} events</span>
            </div>
            <div className="card-b" style={{ padding: 0 }}>
              {[...queue.slice(0, 3), ...mine.slice(0, 3)].slice(0, 5).map((p: any, i) => (
                <div key={p.id + i} className="queue-row" onClick={() => router.push(`/pr/${p.id}`)}>
                  <StagePill stage={p.status} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row-title">{p.title || p.pr_number}</div>
                    <div className="row-sub">{fmtDate(p.last_updated_at)} · {p.requester_name}</div>
                  </div>
                </div>
              ))}
              {mine.length + queue.length === 0 && (
                <div className="card-b empty-state">No recent activity.</div>
              )}
            </div>
          </div>

          {/* Quick actions — prototype's quick-actions card */}
          <div className="card">
            <div className="card-h"><h3>Quick actions</h3></div>
            <div className="card-b" style={{ display: 'grid', gap: 8 }}>
              {canSeeScreen(role, 'light-pr-new') && (
                <Link href="/pr/new" className="btn">+ New Purchase Request</Link>
              )}
              <Link href="/pr" className="btn">Open my requests</Link>
              {canSeeScreen(role, 'approvals') && (
                <Link href="/approvals" className="btn">My Approvals ({queue.length})</Link>
              )}
            </div>
          </div>
        </div>
      </div>
    </Shell>
  );
}
