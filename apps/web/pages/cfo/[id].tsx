// `cfo-approve` — CFO Final Approval.
//
// Port of renderCFO (prototype line 7894). Title, subtitle, the two stage
// alerts, the seven-row pack summary in the prototype's order, and the decision
// card with its two buttons.
//
// The summary rows come from the service's cfoSummary(), which is the TypeScript
// twin of the prototype's markup — so the row ORDER and the F1 rule (a
// risk class the system did not compute renders as an em-dash) are decided in
// one place rather than re-derived per screen.

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { useSession } from '../../lib/session';
import { api } from '../../lib/api';
import Shell from '../../components/Shell';
import {
  CfoSummaryGrid, PurposeAckWidget, ImageGalleryCard,
  type CfoRow, type PurposeAck, type RefImage,
} from '../../components/governance/GovernanceCards';

type CfoPayload = {
  pr: { id: string; pr_number: string; expense_split: string | null; routing_key: string };
  stage: string;
  stage_label: string;
  ready: boolean;
  winner: { vendor_id: string; vendor_name: string | null; total: number | null } | null;
  alert: { cls: string; text: string } | null;
  summary: CfoRow[];
  risk_source: string;
  can_decide: boolean;
  purpose_ack: PurposeAck | null;
  images: RefImage[];
};

const ALERT_CLS: Record<string, string> = { warn: 'alert warn', success: 'alert success', info: 'alert info' };
const SPLIT_PILL: Record<string, string> = { CAPEX: 'capex', OPEX: 'opex', Mixed: 'mixed', MIXED: 'mixed' };

export default function CfoApprovePage() {
  const { session, ready } = useSession();
  const router = useRouter();
  const id = router.query.id as string;
  const [d, setD] = useState<CfoPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    api.get<CfoPayload>(`/pr/${id}/cfo`).then(r => setD(r.data)).catch(e => setErr(e.message));
  }, [id]);

  useEffect(() => {
    if (!ready) return;
    if (!session) { router.replace('/'); return; }
    load();
  }, [ready, session, load]);

  if (!ready || !session || !id) return null;

  const decide = async (approve: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/pr/${id}/cfo/decide`, { approve, reason: note || undefined });
      load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const split = d?.pr?.expense_split ?? null;
  const riskRow = d?.summary?.find(r => r.key === 'risk');

  return (
    <Shell title="CFO Final Approval" screenId="cfo-approve" subtitle={d?.pr?.pr_number}>
      {err && <div className="alert error">{err}</div>}

      <h1 className="page-title">CFO Final Approval</h1>
      <p className="page-sub">
        {d?.pr?.pr_number} &middot; {d?.winner?.vendor_name || '—'} &mdash;{' '}
        {d?.summary?.find(r => r.key === 'total')?.value || '—'} &middot;{' '}
        {split && <span className={`pill ${SPLIT_PILL[split] ?? ''}`}>{split}</span>}
      </p>

      {d?.alert && <div className={ALERT_CLS[d.alert.cls] || 'alert info'}>{d.alert.text}</div>}

      {/* F1, made visible: the prototype hardcodes "Medium — within delegation".
          We derive it, and say so on the card so nobody reads the em-dash as a
          missing feature. */}
      {riskRow?.unknown && (
        <div className="alert info" style={{ marginTop: 8 }}>
          Risk class is <b>undetermined</b>: the winner has no completed due-diligence
          record carrying a risk score. The prototype asserts &ldquo;Medium &mdash; within
          delegation&rdquo; here; that rating was never computed, so it is not shown.
        </div>
      )}

      {d && <CfoSummaryGrid rows={d.summary} />}

      <PurposeAckWidget data={d?.purpose_ack} />
      <ImageGalleryCard images={d?.images} />

      {d?.can_decide && (
        <div className="card">
          <div className="card-h"><h3>CFO decision</h3></div>
          <div className="card-b">
            <div className="field" style={{ maxWidth: 520, marginBottom: 10 }}>
              <label>Reason (recorded on the decision)</label>
              <input
                className="pk-input"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. within the FY26 Q1 IT capex envelope"
                disabled={busy}
              />
            </div>
            <div className="btn-row">
              <button className="btn success" disabled={busy} onClick={() => decide(true)}>Approve &mdash; within budget</button>
              <button className="btn danger" disabled={busy} onClick={() => decide(false)}>Reject</button>
            </div>
            <p className="text-sm text-mute" style={{ marginTop: 10 }}>
              A rejection returns the PR to the <b>MC gate</b>, not to sourcing &mdash; the
              committee&rsquo;s recommendation stands and the objection is a budget one.
            </p>
          </div>
        </div>
      )}

      {d && !d.can_decide && !d.ready && (
        <div className="text-sm text-mute" style={{ marginTop: 12 }}>
          This gate opens once the Management Committee has approved unanimously.
          Current stage: <b>{d.stage_label}</b>.
        </div>
      )}

      {d && (
        <div className="btn-row" style={{ marginTop: 12 }}>
          <Link href={`/pr/${id}`} className="btn ghost">Back to the Purchase Request</Link>
          {d.ready && <Link href={`/pack/${id}`} className="btn ghost">Go to the approved pack</Link>}
        </div>
      )}
    </Shell>
  );
}
