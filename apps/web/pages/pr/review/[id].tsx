// `pr-review` — PR Review & Approve (HOD).
//
// Port of renderPRReview (prototype line 7718), scoped to the parts backed by
// real data: the request summary, the per-line disposition controls, and the
// per-department HOD approval. The per-line disposition is what feeds
// `lineDecisions` into the advance call, and therefore what drives the B1
// line-routing auto-split.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { useSession } from '../../../lib/session';
import { api } from '../../../lib/api';
import Shell from '../../../components/Shell';
import { StagePill, DeptChip, pkr, fmtDate, stageOwner } from '../../../lib/ui';
import { canSeeScreen } from '@procurement/roles';

type Line = {
  id: string;
  line_no: number;
  item_code: string;
  item_name: string;
  description: string | null;
  quantity: string | number;
  uom: string;
  unit_price_est: string | number;
  resolved_category: string;
  category: string | null;
  approved: boolean;
  rejected: boolean;
  held: boolean;
  rejected_reason: string | null;
};

type Pr = {
  id: string;
  pr_number: string;
  title: string | null;
  description: string | null;
  status: string;
  estimated_amount: string | number;
  capex_amount: string | number;
  opex_amount: string | number;
  expense_type: string;
  urgency: string;
  required_by_date: string;
  routing_key: string;
  warehouse_check_required: boolean;
  requester_name: string;
  department_name: string;
  cost_center_code: string;
  split: string | Record<string, unknown> | null;
  parent_pr_id: string | null;
  lines: Line[];
  departments: Array<{ department_id: string; department_name: string; hod_name: string | null; hod_status: string }>;
  children: Array<{ id: string; pr_number: string; status: string; estimated_amount: string | number }>;
};

type Disp = 'approved' | 'rejected' | 'held';
const LABEL: Record<Disp, string> = { approved: 'Approve', rejected: 'Reject', held: 'Hold' };

export default function PrReview() {
  const { session, ready } = useSession();
  const router = useRouter();
  const { id } = router.query;

  const [pr, setPr] = useState<Pr | null>(null);
  const [disp, setDisp] = useState<Record<number, Disp>>({});
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);

  const load = useCallback(() => {
    if (!id || Array.isArray(id)) return;
    api.get<Pr>(`/pr/${id}`).then(r => {
      const p = r.data;
      setPr(p);
      // Seed from persisted dispositions so a re-open shows prior decisions.
      const seeded: Record<number, Disp> = {};
      (p.lines || []).forEach((l, i) => {
        if (l.rejected) seeded[i] = 'rejected';
        else if (l.held) seeded[i] = 'held';
        else if (l.approved) seeded[i] = 'approved';
      });
      setDisp(seeded);
    }).catch(e => setErr(e.message));
  }, [id]);

  useEffect(() => {
    if (!ready) return;                 // session not read from storage yet
    if (!session) { router.replace('/'); return; }
    if (!canSeeScreen(session.user.role, 'pr-review')) { router.replace('/pr'); return; }
    load();
  }, [ready, session, load]);

  const lines = pr?.lines || [];
  const totals = useMemo(() => {
    const total = lines.reduce((s, l) => s + Number(l.quantity) * Number(l.unit_price_est), 0);
    return { total };
  }, [lines]);

  if (!ready) return null;
  if (!session) return null;

  // The HOD acts at IN_HOD_REVIEW, which is where a submitted PR is auto-routed.
// It used to read `=== 'Submitted'`, the stage the PR used to be STUCK at — so
// the gate disagreed with the queue that put the PR here in the first place.
const canAct = pr?.status === 'IN_HOD_REVIEW';
  const decided = Object.keys(disp).length;
  const allDecided = lines.length > 0 && decided === lines.length;
  const anyRejected = Object.values(disp).some(d => d === 'rejected');

  async function submit(extra: Record<string, unknown> = {}) {
    if (!pr) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.post<any>(`/pr/${pr.id}/advance`, {
        lineDecisions: disp,
        reason: reason || 'HOD review',
        ...extra,
      });
      setResult(r.data);
      load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell title="PR Review & Approve" screenId="pr-review"
      subtitle={pr ? `HOD view — ${pr.pr_number} · ${pr.expense_type} · Routing: ${pr.routing_key}` : undefined}>
      {err && <div className="alert error">{err}</div>}

      {!pr && !err && <div className="card"><div className="card-b empty-state">Loading…</div></div>}

      {/* Everything below reads `pr.*` (pr.pr_number, pr.children, pr.departments,
          pr.warehouse_check_required). It has to sit behind ONE `pr &&` guard:
          a loading render would otherwise dereference null and unmount the page
          with Next's black "Application error" screen. The individual cards used
          to guard themselves inconsistently — the "Request summary" card did not
          guard at all, so it threw on the very first paint. */}
      {pr && (
      <>
      {pr && !canAct && (
        <div className="alert info">
          PR is not currently awaiting HOD approval. Stage: <StagePill stage={pr.status} />.
          Switch role and stage to act.
        </div>
      )}

      {result && (
        <div className={`alert ${result.split ? 'info' : 'success'}`}>
          {result.split ? (
            <>
              <b>PR split into {result.children?.length} child PRs.</b>{' '}
              {result.children?.map((c: any) => (
                <span key={c.id} style={{ marginRight: 10 }}>
                  <span className="mono">{c.prNumber}</span> → {c.routeTo} ({c.actorRole}, lines [{c.lineNumbers.join(',')}], {pkr(c.totalAmount)})
                </span>
              ))}
            </>
          ) : (
            <>Advanced to <b>{result.nextStage}</b>{result.lineRoutingApplied ? ' (line routing applied)' : ''}.</>
          )}
          <div style={{ marginTop: 8 }}>
            <Link href={`/pr/${pr.id}`} className="btn sm">Open PR detail →</Link>
          </div>
        </div>
      )}

      {/* ── Request summary (prototype: .kv block) ─────────────────────── */}
      <div className="card">
        <div className="card-h"><h3>Request summary</h3></div>
        <div className="card-b">
          <div className="kv">
            <div className="k">PR Number</div><div className="v mono">{pr.pr_number}</div>
            <div className="k">Title</div><div className="v">{pr.title || '—'}</div>
            <div className="k">Department</div><div className="v"><DeptChip name={pr.department_name} /></div>
            <div className="k">Requester</div><div className="v">{pr.requester_name}</div>
            <div className="k">Total amount</div><div className="v"><b>{pkr(totals.total)}</b></div>
            <div className="k">Required by</div><div className="v">{fmtDate(pr.required_by_date)}</div>
            <div className="k">Priority</div>
            <div className="v"><span className={pr.urgency === 'urgent' ? 'urgency-urgent' : ''}>
              {pr.urgency === 'routine' ? 'NORMAL' : pr.urgency.toUpperCase()}</span></div>
            <div className="k">Routing</div><div className="v"><b>{pr.routing_key}</b></div>
            <div className="k">Items</div><div className="v">{lines.length} line items</div>
            {pr.parent_pr_id && (<>
              <div className="k">Split from</div><div className="v mono">{pr.parent_pr_id}</div>
            </>)}
          </div>
        </div>
      </div>

      {/* ── Split children (only when this PR is itself a child) ───────── */}
      {pr.children?.length > 0 && (
        <div className="card">
          <div className="card-h"><h3>Split children</h3><span className="meta">{pr.children.length}</span></div>
          <table className="t">
            <thead><tr><th>PR Number</th><th>Stage</th><th>Amount</th></tr></thead>
            <tbody>
              {pr.children.map(c => (
                <tr key={c.id} className="clickable" onClick={() => router.push(`/pr/${c.id}`)}>
                  <td className="mono">{c.pr_number}</td>
                  <td><StagePill stage={c.status} /></td>
                  <td className="mono num">{pkr(c.estimated_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Per-department HOD approval ─────────────────────────────────── */}
      {pr.departments?.length > 0 && (
        <div className="card">
          <div className="card-h"><h3>Department approvals</h3></div>
          <div className="card-b" style={{ padding: 0 }}>
            {pr.departments.map(d => (
              <div key={d.department_id} className="queue-row" style={{ cursor: 'default' }}>
                <span className={`pill ${d.hod_status === 'approved' ? 'success' : d.hod_status === 'rejected' ? 'danger' : 'warn'}`} style={{ margin: 0 }}>
                  {d.hod_status}
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{d.department_name}</div>
                  <div className="text-sm text-mute">HOD: {d.hod_name || '—'}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="card-b">
            <p className="text-sm text-mute" style={{ margin: 0 }}>
              Each HOD must independently approve their own department before the PR can advance.
            </p>
          </div>
        </div>
      )}

      {/* ── Line decisions — this is what drives the B1 auto-split ─────── */}
      <div className="card">
        <div className="card-h">
          <h3>Line review</h3>
          <span className="meta">{decided}/{lines.length} decided</span>
        </div>
        <table className="t">
          <thead>
            <tr>
              <th>#</th><th>Item</th><th>Category</th><th>Qty</th>
              <th>Unit</th><th className="num">Amount</th><th>Decision</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.id}>
                <td className="mono">{l.line_no}</td>
                <td>
                  <div className="row-title">{l.item_name}</div>
                  <div className="row-sub mono">{l.item_code}{l.description ? ` — ${l.description}` : ''}</div>
                </td>
                <td><span className="dept-chip">{l.resolved_category || 'OTHER'}</span></td>
                <td>{Number(l.quantity)} {l.uom}</td>
                <td className="mono num">{pkr(l.unit_price_est)}</td>
                <td className="mono num">{pkr(Number(l.quantity) * Number(l.unit_price_est))}</td>
                <td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {(['approved', 'rejected', 'held'] as Disp[]).map(d => (
                      <button
                        key={d}
                        className={`btn sm ${disp[i] === d ? (d === 'approved' ? 'success' : d === 'rejected' ? 'danger' : 'primary') : ''}`}
                        disabled={!canAct}
                        onClick={() => setDisp(s => ({ ...s, [i]: d }))}
                      >
                        {LABEL[d]}
                      </button>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {canAct && (
          <div className="card-b">
            <label className="field">
              <span className="lbl">Review note</span>
              <textarea rows={2} value={reason} onChange={e => setReason(e.target.value)}
                placeholder="Reason recorded on the audit trail and in the split children's workflow snapshot." />
            </label>

            {pr.warehouse_check_required && (
              <div className="alert info" style={{ marginTop: 12 }}>
                This PR is flagged for a warehouse stock check. Confirming sends it to the warehouse queue.
              </div>
            )}

            <div className="btn-row">
              <button className="btn primary" disabled={busy || !allDecided}
                onClick={() => submit(pr.warehouse_check_required ? { wantWarehouse: true } : {})}>
                {busy ? 'Working…' : allDecided ? 'Approve & advance' : `Decide all ${lines.length} lines`}
              </button>
              <button className="btn danger" disabled={busy || !allDecided}
                onClick={() => submit({ lineRejected: true })}>
                Reject PR
              </button>
              {!allDecided && lines.length > 0 && (
                <span className="text-sm text-mute" style={{ alignSelf: 'center' }}>
                  {lines.length - decided} line(s) still undecided — they are treated as approved when you advance.
                </span>
              )}
              {anyRejected && (
                <span className="text-sm text-mute" style={{ alignSelf: 'center' }}>
                  Rejected lines are excluded from routing.
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Context: who owns the current stage ────────────────────────── */}
      <div className="card">
        <div className="card-b">
          <span className="text-sm text-mute">
            Current stage <StagePill stage={pr.status} />
            {stageOwner(pr.status) && <> · owned by <b>{stageOwner(pr.status)}</b></>}
          </span>
        </div>
      </div>
      </>
      )}
    </Shell>
  );
}
