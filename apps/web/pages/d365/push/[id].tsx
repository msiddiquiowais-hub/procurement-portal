// `d365-push` — Push to D365 F&O.
//
// Port of renderD365Push (prototype line 7953). Title, subtitle, the two stage
// alerts, the dark payload-preview card, and the push button.
//
// THE PREVIEW IS THE PAYLOAD, NOT A RENDERING OF IT. The prototype builds the
// JSON inline in the render function and prints it, which means the preview and
// a hand-rolled send could drift. We render the response from
// GET /pr/:id/d365/payload verbatim — the same object the push sends.

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { useSession } from '../../../lib/session';
import { api } from '../../../lib/api';
import Shell from '../../../components/Shell';
import {
  PurposeAckWidget, ImageGalleryCard, type PurposeAck, type RefImage,
} from '../../../components/governance/GovernanceCards';

type PushPayload = {
  pr: { id: string; pr_number: string; expense_split: string | null; routing_key: string };
  stage: string;
  ready: boolean;
  can_push: boolean;
  entity: string;
  payload: Record<string, unknown>;
  pack_hash: string | null;
  pack_hash_display: string;
  po_number: string | null;
  pushed: boolean;
  purpose_ack: PurposeAck | null;
  images: RefImage[];
};

const SPLIT_PILL: Record<string, string> = { CAPEX: 'capex', OPEX: 'opex', Mixed: 'mixed', MIXED: 'mixed' };

/** Stable, readable JSON so the preview diffs cleanly against the prototype. */
function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export default function D365PushPage() {
  const { session, ready } = useSession();
  const router = useRouter();
  const id = router.query.id as string;
  const [d, setD] = useState<PushPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    api.get<PushPayload>(`/pr/${id}/d365/payload`).then(r => setD(r.data)).catch(e => setErr(e.message));
  }, [id]);

  useEffect(() => {
    if (!ready) return;
    if (!session) { router.replace('/'); return; }
    load();
  }, [ready, session, load]);

  if (!ready || !session || !id) return null;

  const push = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/pr/${id}/d365/push`, {});
      load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const split = d?.pr?.expense_split ?? null;

  return (
    <Shell title="Push to D365 F&O" screenId="d365-push" subtitle={d?.pr?.pr_number}>
      {err && <div className="alert error">{err}</div>}

      <h1 className="page-title">Push to D365 F&amp;O</h1>
      <p className="page-sub">
        {d?.pr?.pr_number} &middot;{' '}
        {split && <span className={`pill ${SPLIT_PILL[split] ?? ''}`}>{split}</span>} &middot;{' '}
        OData POST to PurchPurchaseOrderHeadersV2
      </p>

      {d?.ready && !d.pushed && (
        <div className="alert warn">Pack locked. Push to D365 to create the PO.</div>
      )}
      {d?.pushed && (
        <div className="alert success">
          Pushed to D365. PO ID: <b>{d.po_number}</b>.
        </div>
      )}
      {!d?.ready && !d?.pushed && (
        <div className="alert info">
          The pack must be locked before it can be pushed. Current stage: <b>{d?.stage ?? '—'}</b>.
        </div>
      )}

      <PurposeAckWidget data={d?.purpose_ack} />
      <ImageGalleryCard images={d?.images} />

      <div className="card mb-4">
        <div className="card-h">
          <h3>Payload preview</h3>
          <span className="meta">{d?.entity} + Lines</span>
        </div>
        <div className="card-b">
          {/* The prototype's own copy block (line 8006) — same dark/cyan
              monospace treatment, verbatim. */}
          <div
            style={{
              background: '#0F172A', color: '#A5F3FC', fontFamily: 'JetBrains Mono, monospace',
              fontSize: 12, padding: 14, borderRadius: 6, overflowX: 'auto', whiteSpace: 'pre',
            }}
          >
            {d ? pretty(d.payload) : 'Loading…'}
          </div>
          <p className="text-sm text-mute" style={{ marginTop: 10 }}>
            This is the exact object the push will send &mdash; it is not a re-rendering. Pack
            hash: <span className="mono">{d?.pack_hash_display || '—'}</span>
            {d?.pack_hash ? (
              <span className="text-mute"> (frozen; cannot change without a new pack)</span>
            ) : (
              <span className="text-mute"> (no pack frozen yet)</span>
            )}
          </p>
        </div>
      </div>

      {d?.can_push && (
        <div className="btn-row">
          <button className="btn success" disabled={busy} onClick={push}>Push to D365 F&amp;O</button>
        </div>
      )}

      {d && (
        <div className="btn-row" style={{ marginTop: 12 }}>
          <Link href={`/pr/${id}`} className="btn ghost">Back to the Purchase Request</Link>
          <Link href={`/d365/status/${id}`} className="btn ghost">D365 status</Link>
        </div>
      )}
    </Shell>
  );
}
