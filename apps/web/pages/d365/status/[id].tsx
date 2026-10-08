// `d365-status` — D365 Status.
//
// Port of renderD365Status (prototype line 8020). The two alerts, the ten-column
// PO line table (shown only once pushed), and the six-row event stream.
//
// ── The one behavioural divergence ──────────────────────────────────────────
//
// THE PROTOTYPE ADVANCES THE STATUS ON A TIMER. d365Push() ends with
// `setTimeout(..., 2500)` that flips d365Status to INVENTORY_RESERVED by itself
// (line 7302-7306). That is not ported, for the same reason decision Q2 dropped
// sealed bids: a status that changes because a timer fired is a status nobody
// observed. Here it changes only when someone calls the sync endpoint and D365
// reports something new — which is why this screen has a "Check D365 for
// updates" button and the prototype does not.

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { useSession } from '../../../lib/session';
import { api } from '../../../lib/api';
import Shell from '../../../components/Shell';
import { pkr, initials } from '../../../lib/ui';
import {
  D365EventStream, PurposeAckWidget, ImageGalleryCard,
  type D365Event, type PurposeAck, type RefImage,
} from '../../../components/governance/GovernanceCards';

type Line = {
  line_no: number; sku: string; quantity: number; uom: string | null;
  unit_price: number; classification: string | null; gl_account: string | null;
  remarks: string | null; financial_dimensions: Record<string, string> | null;
};

type StatusPayload = {
  pr: { id: string; pr_number: string; expense_split: string | null };
  stage: string;
  pushed: boolean;
  po_number: string | null;
  d365_status: string | null;
  status_index: number;
  events: D365Event[];
  lines: Line[];
  sync_log: Array<{ d365_status: string; source: string; observed_at: string }>;
  can_sync: boolean;
  purpose_ack: PurposeAck | null;
  images: RefImage[];
};

const SPLIT_PILL: Record<string, string> = { CAPEX: 'capex', OPEX: 'opex', Mixed: 'mixed', MIXED: 'mixed' };
const CLASS_LABEL: Record<string, { label: string; cls: string }> = {
  CAPEX_ASSET: { label: 'Capex — Asset', cls: 'capex' },
  CAPEX_INFRA: { label: 'Capex — Infra', cls: 'infra' },
  OPEX_CONSUMABLE: { label: 'Opex — Consumable', cls: 'consumable' },
  OPEX_SERVICE: { label: 'Opex — Service', cls: 'service' },
  OPEX_MAINT: { label: 'Opex — Maintenance', cls: 'maintenance' },
};
const isCapex = (c: string | null | undefined) => !!c && c.startsWith('CAPEX');

export default function D365StatusPage() {
  const { session, ready } = useSession();
  const router = useRouter();
  const id = router.query.id as string;
  const [d, setD] = useState<StatusPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    api.get<StatusPayload>(`/pr/${id}/d365/status`).then(r => setD(r.data)).catch(e => setErr(e.message));
  }, [id]);

  useEffect(() => {
    if (!ready) return;
    if (!session) { router.replace('/'); return; }
    load();
  }, [ready, session, load]);

  if (!ready || !session || !id) return null;

  const sync = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<any>(`/pr/${id}/d365/sync`, {});
      setNote(r.data?.next || '');
      load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const split = d?.pr?.expense_split ?? null;

  return (
    <Shell title="D365 Status" screenId="d365-status" subtitle={d?.pr?.pr_number}>
      {err && <div className="alert error">{err}</div>}
      {note && <div className="alert info">{note}</div>}

      <h1 className="page-title">D365 Status</h1>
      <p className="page-sub">
        {d?.pr?.pr_number} &rarr; {d?.po_number || 'not yet pushed'} &middot;{' '}
        {split && <span className={`pill ${SPLIT_PILL[split] ?? ''}`}>{split}</span>}
      </p>

      {d?.pushed ? (
        <div className="alert success">
          D365 PO created. Async status updates appear below.
        </div>
      ) : (
        <div className="alert info">
          PO will appear here once you push from the <b>Push to D365</b> screen.
        </div>
      )}

      <PurposeAckWidget data={d?.purpose_ack} />
      <ImageGalleryCard images={d?.images} />

      {d?.pushed && d.lines.length > 0 && (
        <div className="card mb-4">
          <div className="card-h"><h3>PO line items in D365</h3></div>
          <table className="t">
            <thead>
              <tr>
                <th>SKU</th><th>Classification</th><th>GL</th><th>Dimensions</th>
                <th style={{ textAlign: 'right' }}>Qty</th><th>UOM</th>
                <th style={{ textAlign: 'right' }}>Amount</th><th>D365 Posting</th>
                <th>Remarks</th><th>Acknowledgement</th>
              </tr>
            </thead>
            <tbody>
              {d.lines.map((l) => {
                const cls = CLASS_LABEL[l.classification || ''] || { label: l.classification || '—', cls: '' };
                const cap = isCapex(l.classification);
                const gl = (l.gl_account || '').split(/\s+/)[0] || '—';
                const dims = Object.entries(l.financial_dimensions || {})
                  .filter(([, v]) => String(v || '').trim());
                return (
                  <tr key={l.line_no}>
                    <td className="mono">{l.sku}</td>
                    <td><span className={`pill ${cls.cls}`}>{cls.label}</span></td>
                    <td className="mono text-sm">{l.gl_account || '—'}</td>
                    <td>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
                        {dims.length === 0
                          ? <span className="text-sm text-mute">—</span>
                          : dims.map(([k, v]) => (
                            <span key={k} className="dim-chip" title={`${k}: ${v}`}>{k}: {v}</span>
                          ))}
                      </div>
                    </td>
                    <td style={{ textAlign: 'right' }}>{l.quantity}</td>
                    <td style={{ textAlign: 'center' }}>
                      <span className="mono" style={{ background: 'var(--bg)', padding: '2px 6px', borderRadius: 4, fontSize: 11 }}>
                        {l.uom || '—'}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>{pkr(l.unit_price * l.quantity)}</td>
                    <td className="text-sm">
                      {cap
                        ? <span style={{ color: 'var(--success)' }}>&rarr; Fixed Asset Register (depreciate 4 yr)</span>
                        : <span style={{ color: '#92400E' }}>&rarr; GL {gl} (P&amp;L)</span>}
                    </td>
                    <td className="text-sm" style={{ whiteSpace: 'pre-wrap', maxWidth: 240 }}>{l.remarks || '—'}</td>
                    <td>
                      <AcknowledgementSummary ack={d.purpose_ack?.approvers || []} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {d && <D365EventStream events={d.events} />}

      {d?.can_sync && (
        <div className="btn-row" style={{ marginTop: 12 }}>
          <button className="btn ghost" disabled={busy} onClick={sync}
            title="Polls D365 and records any change. The status never moves on its own — the prototype's 2.5s setTimeout is not ported.">
            Check D365 for updates
          </button>
        </div>
      )}

      {d && (
        <div className="btn-row" style={{ marginTop: 12 }}>
          <Link href={`/pr/${id}`} className="btn ghost">Back to the Purchase Request</Link>
          <Link href={`/d365/push/${id}`} className="btn ghost">Push to D365</Link>
        </div>
      )}

      {d?.sync_log?.length ? (
        <p className="text-sm text-mute" style={{ marginTop: 12 }}>
          {d.sync_log.length} observed status change{d.sync_log.length === 1 ? '' : 's'} recorded.{' '}
          Latest: <b>{d.sync_log[d.sync_log.length - 1].d365_status}</b>.
        </p>
      ) : null}
    </Shell>
  );
}

/** The prototype's per-line recipient summary (line 8042): first two + overflow. */
function AcknowledgementSummary({ ack }: { ack: Array<{ name: string | null; acknowledged: boolean }> }) {
  if (!ack.length) return <span className="text-sm text-mute">—</span>;
  return (
    <>
      {ack.slice(0, 2).map((a, i) => (
        <span
          key={i}
          className={`pill ${a.acknowledged ? 'approved' : 'pending'}`}
          style={{ margin: 1 }}
          title={a.name || ''}
        >
          {a.name || '—'}{a.acknowledged ? ' ✓' : ''}
        </span>
      ))}
      {ack.length > 2 && <span className="text-sm text-mute">+{ack.length - 2}</span>}
    </>
  );
}
