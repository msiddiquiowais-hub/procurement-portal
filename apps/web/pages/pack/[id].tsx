// `pack` — Approved Pack.
//
// Port of renderPack (prototype line 7920). The two stage alerts, the 2-up
// Capex/Opex financial summary, the six-document hash table, and the
// "Lock approved pack" button.
//
// D1: the SHA-256 column carries REAL digests. The prototype renders
// `Math.random().toString(16).slice(2,10)` here (line 7946) — decorative, and
// decorative in a governance pack is worse than blank because it looks like
// evidence. F2: on a FAST_TRACK route the MC and CFO gates never ran, so two of
// the six documents have no content and are shown as skipped, not hashed.

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { useSession } from '../../lib/session';
import { api } from '../../lib/api';
import Shell from '../../components/Shell';
import { pkr, fmtDateTime } from '../../lib/ui';
import {
  PackDocuments, PurposeAckWidget, ImageGalleryCard,
  type PackDoc, type PurposeAck, type RefImage,
} from '../../components/governance/GovernanceCards';

type PackPayload = {
  pr: { id: string; pr_number: string; expense_split: string | null; routing_key: string };
  stage: string;
  stage_label: string;
  ready: boolean;
  winner: { vendor_id: string; vendor_name: string | null; total: number | null } | null;
  alert: { cls: string; text: string } | null;
  financial: {
    capex: number | null; opex: number | null;
    capex_gl: string | null; opex_gl: string | null;
  };
  pack: {
    id: string; pack_hash: string; display_hash: string; frozen_at: string;
    routing_key: string | null; mc_cfo_skipped: boolean; cs_round: number | null; reason: string | null;
  } | null;
  documents: PackDoc[];
  can_lock: boolean;
  purpose_ack: PurposeAck | null;
  images: RefImage[];
};

const ALERT_CLS: Record<string, string> = { warn: 'alert warn', success: 'alert success', info: 'alert info' };
const SPLIT_PILL: Record<string, string> = { CAPEX: 'capex', OPEX: 'opex', Mixed: 'mixed', MIXED: 'mixed' };

export default function PackPage() {
  const { session, ready } = useSession();
  const router = useRouter();
  const id = router.query.id as string;
  const [d, setD] = useState<PackPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    api.get<PackPayload>(`/pr/${id}/pack`).then(r => setD(r.data)).catch(e => setErr(e.message));
  }, [id]);

  useEffect(() => {
    if (!ready) return;
    if (!session) { router.replace('/'); return; }
    load();
  }, [ready, session, load]);

  if (!ready || !session || !id) return null;

  const lock = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/pr/${id}/pack/lock`, {});
      load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const split = d?.pr?.expense_split ?? null;
  const fin = d?.financial;

  return (
    <Shell title="Approved Pack" screenId="pack" subtitle={d?.pr?.pr_number}>
      {err && <div className="alert error">{err}</div>}

      <h1 className="page-title">Approved Pack</h1>
      <p className="page-sub">
        {d?.pr?.pr_number} &middot;{' '}
        {split && <span className={`pill ${SPLIT_PILL[split] ?? ''}`}>{split}</span>} &middot;{' '}
        ready for D365 push
      </p>

      {d?.alert && <div className={ALERT_CLS[d.alert.cls] || 'alert info'}>{d.alert.text}</div>}

      <PurposeAckWidget data={d?.purpose_ack} />
      <ImageGalleryCard images={d?.images} />

      <div className="card mb-4">
        <div className="card-h">
          <h3>Capex/Opex financial summary</h3>
          <span className="meta">
            {split && <span className={`pill ${SPLIT_PILL[split] ?? ''}`}>{split}</span>}
          </span>
        </div>
        <div className="card-b">
          <div className="grid g-2">
            <div style={{ padding: 12, border: '1px solid #BFDBFE', borderRadius: 8, background: '#EFF6FF' }}>
              <div className="text-sm" style={{ color: '#1E3A8A', fontWeight: 600 }}>Capitalised</div>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
                {fin?.capex === null || fin?.capex === undefined ? '—' : pkr(fin.capex)}
              </div>
              <div className="text-sm text-mute">
                Asset register &middot; depreciation 4 yr
                {fin?.capex_gl ? ` · ${fin.capex_gl}` : ''}
              </div>
            </div>
            <div style={{ padding: 12, border: '1px solid #FDE68A', borderRadius: 8, background: '#FFFBEB' }}>
              <div className="text-sm" style={{ color: '#92400E', fontWeight: 600 }}>Expensed</div>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>
                {fin?.opex === null || fin?.opex === undefined ? '—' : pkr(fin.opex)}
              </div>
              <div className="text-sm text-mute">
                GL 6xxx in current month
                {fin?.opex_gl ? ` · ${fin.opex_gl}` : ''}
              </div>
            </div>
          </div>
        </div>
      </div>

      {d && <PackDocuments documents={d.documents} />}

      {d?.pack && (
        <div className="card mb-4">
          <div className="card-h"><h3>Frozen pack</h3></div>
          <div className="card-b">
            <div className="kv">
              <div className="k">Pack hash</div>
              <div className="v mono text-sm" title={d.pack.pack_hash}>{d.pack.display_hash}</div>
              <div className="k">Frozen at</div>
              <div className="v">{fmtDateTime(d.pack.frozen_at)}</div>
              <div className="k">CS round</div>
              <div className="v">{d.pack.cs_round ?? '—'}</div>
              <div className="k">MC + CFO</div>
              <div className="v">
                {d.pack.mc_cfo_skipped
                  ? <span className="pill warn">Skipped (FAST_TRACK)</span>
                  : <span className="pill approved">Both completed</span>}
              </div>
              <div className="k">Reason</div>
              <div className="v text-sm">{d.pack.reason || '—'}</div>
            </div>
            <p className="text-sm text-mute" style={{ marginTop: 10 }}>
              The pack is an INSERT and never an UPDATE: <code>frozen_at</code> and{' '}
              <code>frozen_by_user_id</code> are NOT NULL, so there is no draft state, and a
              trigger rejects any later mutation. Its hash is computed over this payload.
            </p>
          </div>
        </div>
      )}

      {d?.can_lock && (
        <div className="btn-row">
          <button className="btn primary" disabled={busy} onClick={lock}>Lock approved pack</button>
        </div>
      )}

      {d && d.pack && (
        <div className="btn-row" style={{ marginTop: 12 }}>
          <Link href={`/pr/${id}`} className="btn ghost">Back to the Purchase Request</Link>
          <Link href={`/d365/push/${id}`} className="btn primary">Push to D365 F&amp;O</Link>
        </div>
      )}
      {d && !d.pack && !d.can_lock && (
        <div className="text-sm text-mute" style={{ marginTop: 12 }}>
          The pack can be locked once the CFO has approved. Current stage: <b>{d.stage_label}</b>.
        </div>
      )}
    </Shell>
  );
}
