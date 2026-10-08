// `pr-create` — New Purchase Requisition (legacy capital flow).
//
// Port of renderPRCreate (prototype line 8262). Structure preserved:
// title -> Department + Cost center -> Justification -> line-item cards with
// SKU / description / qty / UoM / unit price / GL account / remarks /
// classification chips -> Add / Remove selected -> the sticky totals bar
// (Capex / Opex / Split / Grand total) -> the Financial dimensions accordion
// (9 D365 dims per line) -> Tagged approvers -> Save draft / Submit PR.
//
// Two hard gates, both from the prototype and both enforced server-side too:
//   1. every line must be classified Capex or Opex
//   2. every line must carry all 4 MANDATORY D365 dimensions
// The prototype additionally blocks submit while a tagged approver is
// unacknowledged; that is a SOFT gate here (see the acknowledge screen) and is
// surfaced as a warning, not a block.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useSession } from '../../lib/session';
import { api } from '../../lib/api';
import Shell from '../../components/Shell';
import { pkr } from '../../lib/ui';
import {
  CLASSIFICATIONS, D365_DIMENSIONS, D365_MANDATORY_DIMS,
  deriveRouting, isCapex, missingDims, missingMandatoryDims,
  type FinancialDimensions,
} from '@procurement/d365-client';
import { canSeeScreen } from '@procurement/roles';

type Item = { id: string; item_code: string; name: string; uom: string; gl_account: string; category: string };
type CC = { id: string; code: string; name: string; department_id: string };
type Dept = { id: string; name: string; code: string };

type Line = {
  key: number;
  itemId: string;
  description: string;
  quantity: string;
  uom: string;
  unitPrice: string;
  glAccount: string;
  classification: string;
  remarks: string;
  dims: FinancialDimensions;
  selected: boolean;
};

const blankLine = (): Line => ({
  key: Date.now() + Math.random(), itemId: '', description: '',
  quantity: '1', uom: 'EA', unitPrice: '0', glAccount: '',
  classification: '', remarks: '', dims: {}, selected: false,
});

const DEFAULT_DIMS: FinancialDimensions = {
  BusinessUnit: 'PakBoxes', Department: '', CostCenter: '', Location: 'Lahore HQ',
};

export default function PrCreate() {
  const { session, ready } = useSession();
  const router = useRouter();

  const [items, setItems] = useState<Item[]>([]);
  const [ccs, setCcs] = useState<CC[]>([]);
  const [depts, setDepts] = useState<Dept[]>([]);
  const [title, setTitle] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [costCenterId, setCostCenterId] = useState('');
  const [justification, setJustification] = useState('');
  const [purpose, setPurpose] = useState('');
  const [requiredBy, setRequiredBy] = useState('2026-12-31');
  const [urgency, setUrgency] = useState<'routine' | 'urgent' | 'force_majeure'>('routine');
  const [lines, setLines] = useState<Line[]>([blankLine()]);
  const [openDims, setOpenDims] = useState<Record<number, boolean>>({});
  const [approvers, setApprovers] = useState<Array<{ taggedRole: string; name: string; email: string; deptCode: string }>>([
    { taggedRole: 'dept_head', name: '', email: '', deptCode: '' },
  ]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    if (!ready) return;                 // session not read from storage yet
    if (!session) { router.replace('/'); return; }
    if (!canSeeScreen(session.user.role, 'pr-create')) { router.replace('/my-prs'); return; }
    api.get<Item[]>('/lookups/items').then(r => setItems(r.data)).catch(() => setItems([]));
    api.get<CC[]>('/lookups/cost-centers').then(r => setCcs(r.data)).catch(() => setCcs([]));
    api.get<Dept[]>('/lookups/departments').then(r => setDepts(r.data)).catch(() => setDepts([]));
  }, [ready, session]);

  const patch = (key: number, p: Partial<Line>) =>
    setLines(ls => ls.map(l => (l.key === key ? { ...l, ...p } : l)));

  const amountOf = (l: Line) => (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0);

  const totals = useMemo(() => {
    let capex = 0, opex = 0;
    for (const l of lines) {
      const a = amountOf(l);
      if (isCapex(l.classification)) capex += a; else opex += a;
    }
    return { capex, opex, total: capex + opex };
  }, [lines]);

  // The header class is DERIVED, exactly as the prototype does — you do not
  // pick "Mixed" by hand, you get it because the lines disagree.
  const expenseType = totals.capex > 0 && totals.opex > 0
    ? 'MIXED' : totals.capex > 0 ? 'CAPEX' : 'OPEX';
  const routing = deriveRouting(totals.capex, totals.opex, totals.total);

  const unclassified = lines.filter(l => !l.classification).length;
  const dimShort = lines.filter(l => missingMandatoryDims(l.dims).length > 0).length;
  const canSubmit = title.trim() && costCenterId && lines.length > 0
    && unclassified === 0 && dimShort === 0;

  async function save(submit: boolean) {
    setBusy(true); setErr(null); setOk(null);
    try {
      const r = await api.post<any>('/pr/capital', {
        title, departmentId: departmentId || undefined, costCenterId,
        expenseType, requiredByDate: requiredBy, urgency,
        justification: justification || undefined, purpose: purpose || undefined,
        scope: 'CAPITAL_PR',
        submit,
        lines: lines.map(l => ({
          itemId: l.itemId,
          quantity: Number(l.quantity) || 0,
          uom: l.uom,
          unitPriceEst: Number(l.unitPrice) || 0,
          description: l.description || undefined,
          glAccount: l.glAccount || undefined,
          classification: l.classification,
          remarks: l.remarks || undefined,
          financialDimensions: l.dims,
        })),
        taggedApprovers: approvers.filter(a => a.email.trim()).map(a => ({
          taggedRole: a.taggedRole, name: a.name || a.email, email: a.email, deptCode: a.deptCode || undefined,
        })),
      });
      setOk(`${submit ? 'Submitted' : 'Saved as draft'}: ${r.data.prNumber} — ${pkr(r.data.estimatedAmount)} (${r.data.routingKey})`);
      setTimeout(() => router.push(`/pr/capital/${r.data.id}`), 900);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!ready) return null;
  if (!session) return null;

  return (
    <Shell title="New Purchase Requisition" screenId="pr-create"
      subtitle="Detailed capital flow. Every line must be classified and dimensioned before submit.">
      {err && <div className="alert error">{err}</div>}
      {ok && <div className="alert success">{ok}</div>}

      {/* ── header ──────────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-h"><h3>Requisition header</h3></div>
        <div className="card-b">
          <label className="field">
            <span className="lbl">Title *</span>
            <input value={title} onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Q3 warehouse racking expansion" />
          </label>

          <div className="grid g-4" style={{ marginTop: 12 }}>
            <label className="field">
              <span className="lbl">Department</span>
              <select value={departmentId} onChange={e => setDepartmentId(e.target.value)}>
                <option value="">— select —</option>
                {depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
            <label className="field">
              <span className="lbl">Cost center *</span>
              <select value={costCenterId} onChange={e => {
                setCostCenterId(e.target.value);
                const cc = ccs.find(c => c.id === e.target.value);
                if (cc) setDepartmentId(d => d || cc.department_id);
              }}>
                <option value="">— select —</option>
                {ccs.map(c => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
              </select>
            </label>
            <label className="field">
              <span className="lbl">Required by</span>
              <input type="date" value={requiredBy} onChange={e => setRequiredBy(e.target.value)} />
            </label>
            <label className="field">
              <span className="lbl">Priority</span>
              <select value={urgency} onChange={e => setUrgency(e.target.value as any)}>
                <option value="routine">Normal</option>
                <option value="urgent">Urgent</option>
                <option value="force_majeure">Force majeure</option>
              </select>
            </label>
          </div>

          <label className="field" style={{ marginTop: 12 }}>
            <span className="lbl">Justification *</span>
            <textarea rows={3} value={justification} onChange={e => setJustification(e.target.value)}
              placeholder="Why is this purchase needed? This becomes the business case on the PR detail screen." />
          </label>
          <label className="field">
            <span className="lbl">Purpose</span>
            <input value={purpose} onChange={e => setPurpose(e.target.value)}
              placeholder="e.g. capacity increase, compliance requirement, replacement" />
          </label>
        </div>
      </div>

      {/* ── line items ──────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-h">
          <h3>Line items</h3>
          <span className="meta">{lines.length} line{lines.length === 1 ? '' : 's'}</span>
        </div>
        <div className="card-b">
          {lines.map((l, i) => {
            const missing = missingMandatoryDims(l.dims);
            const allMissing = missingDims(l.dims);
            return (
              <div key={l.key} className={`line-card${l.selected ? ' sel' : ''}`}>
                <label className="line-select">
                  <input type="checkbox" checked={l.selected}
                    onChange={e => patch(l.key, { selected: e.target.checked })} />
                </label>

                <div className="grid g-4" style={{ flex: 1 }}>
                  <label className="field">
                    <span className="lbl">SKU *</span>
                    <select value={l.itemId} onChange={e => {
                      const it = items.find(x => x.id === e.target.value);
                      patch(l.key, {
                        itemId: e.target.value,
                        uom: it?.uom || l.uom,
                        glAccount: it?.gl_account || l.glAccount,
                        description: it?.name || l.description,
                        dims: { ...DEFAULT_DIMS, Department: depts.find(d => d.id === departmentId)?.name || l.dims.Department, ...l.dims },
                      });
                    }}>
                      <option value="">— select —</option>
                      {items.map(it => <option key={it.id} value={it.id}>{it.item_code} — {it.name}</option>)}
                    </select>
                  </label>
                  <label className="field">
                    <span className="lbl">Description</span>
                    <input value={l.description} onChange={e => patch(l.key, { description: e.target.value })} />
                  </label>
                  <label className="field">
                    <span className="lbl">Qty *</span>
                    <input type="number" min="0" value={l.quantity}
                      onChange={e => patch(l.key, { quantity: e.target.value })} />
                  </label>
                  <label className="field">
                    <span className="lbl">UoM</span>
                    <input value={l.uom} onChange={e => patch(l.key, { uom: e.target.value })} />
                  </label>
                  <label className="field">
                    <span className="lbl">Unit price (PKR) *</span>
                    <input type="number" min="0" value={l.unitPrice}
                      onChange={e => patch(l.key, { unitPrice: e.target.value })} />
                  </label>
                  <label className="field">
                    <span className="lbl">GL account</span>
                    <input value={l.glAccount} onChange={e => patch(l.key, { glAccount: e.target.value })} />
                  </label>
                  <label className="field" style={{ gridColumn: 'span 2' }}>
                    <span className="lbl">Remarks</span>
                    <input value={l.remarks} onChange={e => patch(l.key, { remarks: e.target.value })}
                      placeholder="Delivery constraints, install notes, etc." />
                  </label>
                </div>

                {/* classification chips — prototype renders these inline per line */}
                <div className="field" style={{ marginTop: 10 }}>
                  <span className="lbl">Classification *</span>
                  <div className="chips">
                    {CLASSIFICATIONS.map(c => (
                      <button key={c.value}
                        className={`chip ${c.cls}${l.classification === c.value ? ' on' : ''}`}
                        disabled={!l.itemId}
                        onClick={() => patch(l.key, {
                          classification: l.classification === c.value ? '' : c.value,
                          glAccount: l.glAccount || c.gl.split(' ')[0],
                        })}>
                        {c.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* financial dimensions accordion */}
                <div className="dim-acc">
                  <button className="dim-acc-head"
                    onClick={() => setOpenDims(d => ({ ...d, [i]: !d[i] }))}>
                    <span>Financial dimensions</span>
                    <span>
                      {missing.length === 0
                        ? <span className="pill ack-done">{D365_DIMENSIONS.length} of {D365_DIMENSIONS.length} filled</span>
                        : <span className="pill ack-pending">{allMissing.length} dims missing</span>}
                      <span style={{ marginLeft: 8 }}>{openDims[i] ? '▾' : '▸'}</span>
                    </span>
                  </button>
                  {openDims[i] && (
                    <div className="dim-grid">
                      {D365_DIMENSIONS.map(d => (
                        <label key={d.key} className="field" title={d.desc}>
                          <span className="lbl">
                            {d.label}{d.mandatory && ' *'}
                          </span>
                          <input
                            className={missing.includes(d.key) ? 'missing' : ''}
                            defaultValue={l.dims[d.key] || ''}
                            placeholder={d.apiName}
                            onChange={e => patch(l.key, { dims: { ...l.dims, [d.key]: e.target.value } })} />
                        </label>
                      ))}
                      <p className="text-sm text-mute" style={{ gridColumn: '1 / -1', margin: 0 }}>
                        Mandatory: {D365_MANDATORY_DIMS.join(', ')}. The server rejects a submit
                        when any line is missing one of these.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* line actions */}
          <div className="btn-row" style={{ marginTop: 14 }}>
            <button className="btn" onClick={() => setLines(ls => [...ls, blankLine()])}>Add line</button>
            <button className="btn"
              disabled={!lines.some(l => l.selected)}
              onClick={() => setLines(ls => ls.filter(l => !l.selected))}>
              Remove selected ({lines.filter(l => l.selected).length})
            </button>
            <span className="text-sm text-mute" style={{ alignSelf: 'center' }}>
              {lines.length} line{lines.length === 1 ? '' : 's'} · grand total {pkr(totals.total)}
            </span>
          </div>
        </div>

        {/* ── sticky totals bar — prototype's stTotalsBar ──────────── */}
        <div className="totals-bar">
          <div className="tb-item"><span>Capex</span><b>{pkr(totals.capex)}</b></div>
          <div className="tb-item"><span>Opex</span><b>{pkr(totals.opex)}</b></div>
          <div className="tb-item">
            <span>Split</span>
            <b className={`pill ${expenseType === 'CAPEX' ? 'capex' : expenseType === 'OPEX' ? 'opex' : 'mixed'}`}>
              {expenseType === 'MIXED' ? 'Mixed: Capex + Opex' : expenseType === 'CAPEX' ? 'Capex only' : 'Opex only'}
            </b>
          </div>
          <div className="tb-item grand"><span>Grand total</span><b>{pkr(totals.total)}</b></div>
        </div>
      </div>

      {/* ── routing preview ──────────────────────────────────────────── */}
      <div className="card">
        <div className="card-h"><h3>Approval routing</h3></div>
        <div className="card-b">
          <div className="kv">
            <div className="k">Routing key</div><div className="v"><b className="mono">{routing.key}</b></div>
            <div className="k">Path</div><div className="v">{routing.label}</div>
            <div className="k">Reason</div><div className="v">{routing.reason}</div>
            <div className="k">Mgmt gate</div>
              <div className="v">{totals.capex > 0 && totals.total > 1_000_000 ? 'REQUIRED (> PKR 1 L)' : 'not needed'}</div>
          </div>
          <p className="text-sm text-mute">
            Derived from the Capex/Opex mix and amount, server-side by
            <span className="mono"> proc.fn_derive_routing()</span>.
          </p>
        </div>
      </div>

      {/* ── tagged approvers ─────────────────────────────────────────── */}
      <div className="card">
        <div className="card-h">
          <h3>Tagged approvers</h3>
          <span className="meta">soft gate — does not block the flow</span>
        </div>
        <div className="card-b">
          {approvers.map((a, i) => (
            <div key={i} className="ack-tagger-row" style={{ marginBottom: 8 }}>
              <select value={a.taggedRole}
                onChange={e => setApprovers(as => as.map((x, j) => j === i ? { ...x, taggedRole: e.target.value } : x))}>
                <option value="employee">Employee</option>
                <option value="dept_head">Dept Head</option>
                <option value="director">Director</option>
                <option value="project_lead">Project Lead</option>
                <option value="requester_self">Requester</option>
                <option value="new_employee">New Employee</option>
              </select>
              <input placeholder="Name" value={a.name}
                onChange={e => setApprovers(as => as.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
              <input placeholder="email@pakboxes.pk" value={a.email}
                onChange={e => setApprovers(as => as.map((x, j) => j === i ? { ...x, email: e.target.value } : x))} />
              <input placeholder="Dept code" value={a.deptCode} style={{ maxWidth: 120 }}
                onChange={e => setApprovers(as => as.map((x, j) => j === i ? { ...x, deptCode: e.target.value } : x))} />
              {approvers.length > 1 && (
                <button className="btn sm" onClick={() => setApprovers(as => as.filter((_, j) => j !== i))}>−</button>
              )}
            </div>
          ))}
          <button className="btn sm" onClick={() => setApprovers(as => [...as, { taggedRole: 'employee', name: '', email: '', deptCode: '' }])}>
            + Add approver
          </button>
        </div>
      </div>

      {/* ── gates + actions ──────────────────────────────────────────── */}
      <div className="card">
        <div className="card-h"><h3>Submit</h3></div>
        <div className="card-b">
          <ul className="gate-list">
            <li className={title.trim() ? 'ok' : 'no'}>{title.trim() ? '✓' : '✗'} Title set</li>
            <li className={costCenterId ? 'ok' : 'no'}>{costCenterId ? '✓' : '✗'} Cost center selected</li>
            <li className={unclassified === 0 ? 'ok' : 'no'}>
              {unclassified === 0 ? '✓' : '✗'} Every line classified ({unclassified} missing)
            </li>
            <li className={dimShort === 0 ? 'ok' : 'no'}>
              {dimShort === 0 ? '✓' : '✗'} All 4 mandatory D365 dimensions on every line ({dimShort} lines short)
            </li>
          </ul>

          {approvers.some(a => a.email.trim()) && (
            <div className="alert warn">
              Tagging approvers is a <b>soft gate</b> — the PR still moves. Recipients get a
              unique <span className="ack-deep-link">#ack=&lt;token&gt;</span> link and their
              acknowledgement is recorded on the audit log.
            </div>
          )}

          <div className="btn-row">
            <button className="btn" disabled={busy} onClick={() => save(false)}>Save draft</button>
            <button className="btn success" disabled={busy || !canSubmit} onClick={() => save(true)}>
              {busy ? 'Working…' : 'Submit PR'}
            </button>
            <Link href="/my-prs" className="btn ghost">Cancel</Link>
          </div>
        </div>
      </div>
    </Shell>
  );
}
