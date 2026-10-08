// `pr-detail` — Purchase Requisition detail (legacy capital flow).
//
// Port of renderPRDetail (prototype line 7630). Structure preserved:
// 3-up KPI band (Amount / Current stage / Approval routing) -> Capex/Opex
// breakdown widget with the routing alert -> purpose + acknowledgement widget
// -> line-items table (SKU, Description, Classification, GL Account, Qty, UoM,
// Unit, Total, Remarks) with a grand total -> financial dimensions accordion
// -> action row -> end-to-end gate view -> image gallery -> audit trail.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useSession } from '../../../lib/session';
import { api } from '../../../lib/api';
import Shell from '../../../components/Shell';
import { StagePill, DeptChip, pkr, fmtDate, fmtDateTime } from '../../../lib/ui';
import {
  CLASSIFICATION_LABEL, CLASSIFICATION_CLASS, D365_DIMENSIONS,
  missingDims, splitPill, SPLIT_PILL_LABEL,
} from '@procurement/d365-client';

type Line = {
  id: string; line_no: number; item_code: string; item_name: string;
  description: string | null; gl_account: string; classification: string | null;
  remarks: string | null; quantity: number; uom: string; unit_price_est: number;
  financialDimensions: Record<string, string>;
};
type Ack = { id: string; name: string; email: string; tagged_role: string; acknowledged: boolean; acknowledged_at: string | null };

type Pr = {
  id: string; pr_number: string; title: string; description: string | null;
  justification: string | null; purpose: string | null; status: string;
  estimated_amount: number; capex_amount: number; opex_amount: number;
  currency: string; expense_type: string; urgency: string; required_by_date: string;
  routing: { routing_key: string; label: string; reason: string };
  requester_name: string; department_name: string; cost_center_code: string;
  created_at: string; lines: Line[]; images: any[];
};

type HistEvent = { ts: string; action: string; actor: string; from_stage: string | null; to_stage: string | null };

// The prototype's end-to-end gate view — the legacy capital chain.
const GATES = [
  { key: 'HOD_Approved', label: 'HOD approved', owner: 'Aamir Hussain (HOD IT)' },
  { key: 'Proc_Verified', label: 'Procurement verified', owner: 'Bilal Ahmed' },
  { key: 'RFQ_Open', label: 'RFQ open', owner: 'Bilal Ahmed' },
  { key: 'CS_Generated', label: 'Comparative statement', owner: 'Hina Tariq (CS)' },
  { key: 'MC_Approved', label: 'MC approved', owner: 'Dr. Imran Shah' },
  { key: 'CFO_Approved', label: 'CFO approved', owner: 'Faisal Mehmood' },
  { key: 'Pushed_To_D365', label: 'Pushed to D365', owner: 'system' },
];
const GATE_ORDER = GATES.map(g => g.key);

export default function CapitalPrDetail() {
  const { session, ready } = useSession();
  const router = useRouter();
  const { id } = router.query;

  const [pr, setPr] = useState<Pr | null>(null);
  const [ack, setAck] = useState<Ack[]>([]);
  const [hist, setHist] = useState<HistEvent[]>([]);
  const [openDims, setOpenDims] = useState<Record<number, boolean>>({});
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;                 // session not read from storage yet
    if (!session) { router.replace('/'); return; }
    if (!id || Array.isArray(id)) return;
    api.get<Pr>(`/pr/capital/${id}/detail`).then(r => setPr(r.data)).catch(e => setErr(e.message));
    api.get<{ rows: Ack[] }>(`/pr/${id}/acknowledgements`)
      .then(r => setAck(r.data.rows || [])).catch(() => setAck([]));
    api.get<{ events: HistEvent[] }>(`/pr/${id}/history`)
      .then(r => setHist(r.data.events || [])).catch(() => setHist([]));
  }, [ready, session, id]);

  if (!ready) return null;
  if (!session) return null;
  if (!pr && !err) {
    return <Shell title="Purchase Requisition" screenId="pr-detail">
      <div className="card"><div className="card-b empty-state">Loading…</div></div>
    </Shell>;
  }
  if (!pr) {
    return <Shell title="Purchase Requisition" screenId="pr-detail">
      <div className="card"><div className="card-b empty-state">{err}</div></div>
    </Shell>;
  }

  const sp = splitPill(pr.expense_type);
  const curGate = GATE_ORDER.indexOf(pr.status);
  const pendingAck = ack.filter(a => !a.acknowledged).length;
  const grand = pr.lines.reduce((s, l) => s + l.quantity * l.unit_price_est, 0);

  return (
    <Shell title={pr.title} screenId="pr-detail"
      subtitle={`${pr.pr_number} · ${pr.department_name} · raised by ${pr.requester_name} on ${fmtDate(pr.created_at)}`}>
      {err && <div className="alert error">{err}</div>}

      {/* ── 3-up KPI band ───────────────────────────────────────────── */}
      <div className="grid g-4">
        <div className="card kpi">
          <div className="kpi-label">Amount</div>
          <div className="kpi-value" style={{ fontSize: 24 }}>{pkr(pr.estimated_amount)}</div>
          <div className="kpi-sub">
            <span className={`pill ${sp === 'CAPEX' ? 'capex' : sp === 'OPEX' ? 'opex' : 'mixed'}`}>
              {SPLIT_PILL_LABEL[sp]}
            </span>
          </div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">Current stage</div>
          <div className="kpi-value" style={{ fontSize: 18 }}><StagePill stage={pr.status} /></div>
          <div className="kpi-sub">Required by {fmtDate(pr.required_by_date)}</div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">Approval routing</div>
          <div className="kpi-value" style={{ fontSize: 18 }}><b className="mono">{pr.routing?.routing_key || '—'}</b></div>
          <div className="kpi-sub">{pr.routing?.label}</div>
        </div>
        <div className="card kpi">
          <div className="kpi-label">Tagged approvers</div>
          <div className="kpi-value">{ack.length ? `${ack.length - pendingAck}/${ack.length}` : '—'}</div>
          <div className="kpi-sub">
            {ack.length === 0 ? 'none tagged'
              : pendingAck === 0 ? 'all acknowledged' : `${pendingAck} pending`}
          </div>
        </div>
      </div>

      {/* ── Capex/Opex breakdown widget ──────────────────────────────── */}
      <div className="grid g-2-1">
        <div className="card">
          <div className="card-h"><h3>Capex / Opex breakdown</h3></div>
          <div className="card-b">
            <div className="grid g-4">
              <div className="card kpi" style={{ border: 'none', padding: 0 }}>
                <div className="kpi-label">Capex</div>
                <div className="kpi-value" style={{ fontSize: 24, color: '#0E7490' }}>{pkr(pr.capex_amount)}</div>
                <div className="kpi-sub">
                  {pr.estimated_amount > 0
                    ? `${Math.round((pr.capex_amount / pr.estimated_amount) * 100)}% of total`
                    : '—'}
                </div>
              </div>
              <div className="card kpi" style={{ border: 'none', padding: 0 }}>
                <div className="kpi-label">Opex</div>
                <div className="kpi-value" style={{ fontSize: 24, color: '#B45309' }}>{pkr(pr.opex_amount)}</div>
                <div className="kpi-sub">
                  {pr.estimated_amount > 0
                    ? `${Math.round((pr.opex_amount / pr.estimated_amount) * 100)}% of total`
                    : '—'}
                </div>
              </div>
            </div>
            {pr.routing?.routing_key === 'BOARD' && (
              <div className="alert error" style={{ marginTop: 12 }}>
                <b>Board approval required.</b> {pr.routing.reason}
              </div>
            )}
            {pr.routing?.routing_key === 'FAST_TRACK' && (
              <div className="alert success" style={{ marginTop: 12 }}>
                <b>Fast track.</b> {pr.routing.reason} — {pr.routing.label}.
              </div>
            )}
          </div>
        </div>

        {/* purpose + acknowledgement widget — prototype's purposeAndAckWidget */}
        <div className="card">
          <div className="card-h"><h3>Purpose &amp; acknowledgement</h3></div>
          <div className="card-b">
            <div className="kv">
              <div className="k">Purpose</div><div className="v">{pr.purpose || '—'}</div>
              <div className="k">Department</div><div className="v"><DeptChip name={pr.department_name} /></div>
              <div className="k">Cost centre</div><div className="v mono">{pr.cost_center_code}</div>
              <div className="k">Ack</div>
              <div className="v">
                {ack.length === 0
                  ? <span className="pill ack-none">No approvers tagged</span>
                  : pendingAck === 0
                    ? <span className="pill ack-done">All {ack.length} acknowledgers done</span>
                    : <span className="pill ack-pending">{pendingAck} of {ack.length} pending acknowledgement</span>}
              </div>
            </div>
            <Link href="/acknowledge" className="btn sm" style={{ marginTop: 10 }}>Manage acknowledgements →</Link>
          </div>
        </div>
      </div>

      {/* ── justification ───────────────────────────────────────────── */}
      {pr.justification && (
        <div className="card">
          <div className="card-h"><h3>Justification</h3></div>
          <div className="card-b">{pr.justification}</div>
        </div>
      )}

      {/* ── line items ──────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-h">
          <h3>Line items</h3>
          <span className="meta">{pr.lines.length} line{pr.lines.length === 1 ? '' : 's'}</span>
        </div>
        <table className="t">
          <thead>
            <tr>
              <th>SKU</th><th>Description</th><th>Classification</th><th>GL Account</th>
              <th>Qty</th><th>UoM</th><th className="num">Unit</th>
              <th className="num">Total</th><th>Remarks</th>
            </tr>
          </thead>
          <tbody>
            {pr.lines.map(l => (
              <>
                <tr key={l.id}>
                  <td className="mono">{l.item_code}</td>
                  <td>
                    <div className="row-title">{l.item_name}</div>
                    {l.description && <div className="row-sub">{l.description}</div>}
                  </td>
                  <td>
                    <span className={`chip static ${CLASSIFICATION_CLASS[l.classification || ''] || ''}`}>
                      {CLASSIFICATION_LABEL[l.classification || ''] || '—'}
                    </span>
                  </td>
                  <td className="mono">{l.gl_account}</td>
                  <td>{l.quantity}</td>
                  <td>{l.uom}</td>
                  <td className="mono num">{pkr(l.unit_price_est)}</td>
                  <td className="mono num">{pkr(l.quantity * l.unit_price_est)}</td>
                  <td className="text-sm text-mute">{l.remarks || '—'}</td>
                </tr>
                <tr key={`${l.id}-dims`}>
                  <td colSpan={9} style={{ paddingTop: 0, borderBottom: '1px solid var(--line-soft)' }}>
                    <div className="dim-inline">
                      <button className="dim-toggle"
                        onClick={() => setOpenDims(o => ({ ...o, [l.line_no]: !o[l.line_no] }))}>
                        {openDims[l.line_no] ? '▾' : '▸'} Financial dimensions
                        {missingDims(l.financialDimensions).length === 0
                          ? <span className="pill ack-done" style={{ marginLeft: 8 }}>complete</span>
                          : <span className="pill ack-pending" style={{ marginLeft: 8 }}>
                            {missingDims(l.financialDimensions).length} missing
                          </span>}
                      </button>
                      {openDims[l.line_no] && (
                        <div className="dim-chips">
                          {D365_DIMENSIONS.map(d => {
                            const v = l.financialDimensions?.[d.key];
                            return (
                              <span key={d.key} className={`dim-chip${v ? ' on' : ''}${d.mandatory ? ' mand' : ''}`}>
                                <b>{d.label}</b>{v ? v : '—'}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              </>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={7} style={{ textAlign: 'right', fontWeight: 700, borderTop: '2px solid var(--line)' }}>
                Grand total
              </td>
              <td className="mono num" style={{ fontWeight: 700, borderTop: '2px solid var(--line)' }}>
                {pkr(grand)}
              </td>
              <td style={{ borderTop: '2px solid var(--line)' }} />
            </tr>
          </tfoot>
        </table>
      </div>

      {/* ── end-to-end gate view ────────────────────────────────────── */}
      <div className="card">
        <div className="card-h">
          <h3>End-to-end gates</h3>
          <span className="meta">{GATES.length} steps</span>
        </div>
        <div className="card-b" style={{ padding: 0 }}>
          {GATES.map((g, i) => {
            const done = curGate >= i && curGate >= 0;
            const current = curGate === i;
            return (
              <div key={g.key} className="queue-row" style={{ cursor: 'default' }}>
                <span className={`pill ${current ? 'info' : done ? 'success' : ''}`} style={{ margin: 0 }}>
                  {done ? '✓' : i + 1}
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: current ? 700 : 400 }}>{g.label}</div>
                  <div className="text-sm text-mute">{g.owner}</div>
                </div>
                {current && <span className="text-sm text-mute">current stage</span>}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── action row ──────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-h"><h3>Actions</h3></div>
        <div className="card-b">
          <div className="btn-row" style={{ margin: 0, padding: 0, borderTop: 'none' }}>
            <Link href="/my-prs" className="btn">Back to My PRs</Link>
            <Link href="/pr" className="btn ghost">View lightweight requests</Link>
            {pr.status === 'Draft' && (
              <span className="text-sm text-mute" style={{ alignSelf: 'center' }}>
                This is a draft — it has not entered the approval chain.
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── audit trail ─────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-h"><h3>Audit trail</h3><span className="meta">{hist.length} events</span></div>
        <div className="card-b" style={{ padding: 0 }}>
          {hist.length === 0
            ? <div className="card-b empty-state">No recorded transitions yet.</div>
            : hist.map((e, i) => (
              <div key={i} className="queue-row" style={{ cursor: 'default' }}>
                {e.to_stage ? <StagePill stage={e.to_stage} /> : <span className="pill">{e.action}</span>}
                <div style={{ flex: 1 }}>
                  <div className="row-title">
                    {e.from_stage && e.to_stage ? `${e.from_stage} → ${e.to_stage}` : e.action}
                  </div>
                  <div className="row-sub">{e.actor} · {fmtDateTime(e.ts)}</div>
                </div>
              </div>
            ))}
        </div>
      </div>
    </Shell>
  );
}
