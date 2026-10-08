// `mc-vote` — Management Committee Vote.
//
// Port of renderMCVote (prototype line 7866). Title, subtitle, the two stage
// alerts, the members/votes table with its n/5 chip, and the vote card with
// Approve / Reject / the demo helper — all in the prototype's order.
//
// ── Two deliberate divergences ──────────────────────────────────────────────
//
// 1. "You are voting as <name>" shows the AUTHENTICATED user, not the
//    prototype's hardcoded "Dr. Imran Shah" (line 7886). The vote is recorded
//    against a real voter_user_id; rendering a fixed persona above it would be
//    a caption the data does not support.
//
// 2. THE PANEL IS DATA. The prototype hardcodes memberList (line 7870); ours is
//    workflow.mc_panel, so the quorum is who is actually appointed rather than a
//    literal 5. The five names and their order are the prototype's.

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { useSession } from '../../lib/session';
import { api } from '../../lib/api';
import Shell from '../../components/Shell';
import { pkr } from '../../lib/ui';
import {
  McVoteTable, PurposeAckWidget, ImageGalleryCard, type McPanelRow, type PurposeAck, type RefImage,
} from '../../components/governance/GovernanceCards';

type McPayload = {
  pr: {
    id: string; pr_number: string; expense_split: string | null; routing_key: string;
    amount_text: string | null;
  };
  stage: string;
  stage_label: string;
  ready: boolean;
  winner: { vendor_id: string; vendor_name: string | null; total: number | null } | null;
  alert: { cls: string; text: string } | null;
  panel: McPanelRow[];
  tally: { cast: number; approves: number; rejects: number; panel: number; text: string };
  round: 'pending' | 'approved' | 'rejected';
  unanimous: boolean;
  you: { user_id: string; name: string; chair: boolean } | null;
  can_vote: boolean;
  demo_helper_allowed: boolean;
  next: string;
  purpose_ack: PurposeAck | null;
  images: RefImage[];
};

const ALERT_CLS: Record<string, string> = { warn: 'alert warn', success: 'alert success', info: 'alert info' };

export default function McVotePage() {
  const { session, ready } = useSession();
  const router = useRouter();
  const id = router.query.id as string;
  const [d, setD] = useState<McPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState('');
  // The service returns the prototype's own next-step sentence (mcVote's
  // toast). It is shown as a banner rather than swallowed, so the reviewer sees
  // the same words the prototype would have put in a toast.
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    api.get<McPayload>(`/pr/${id}/mc`).then(r => setD(r.data)).catch(e => setErr(e.message));
  }, [id]);

  useEffect(() => {
    if (!ready) return;
    if (!session) { router.replace('/'); return; }
    load();
  }, [ready, session, load]);

  if (!ready || !session || !id) return null;

  const vote = async (decision: 'approve' | 'reject') => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<any>(`/pr/${id}/mc/vote`, { decision, reason: note || undefined });
      setBanner(r.data?.next || null);
      load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const autoComplete = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.post<any>(`/pr/${id}/mc/auto-complete`, {});
      setBanner(r.data?.next || null);
      load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const winner = d?.winner ?? null;

  return (
    <Shell title="Management Committee Vote" screenId="mc-vote"
      subtitle={d?.pr?.pr_number}>
      {err && <div className="alert error">{err}</div>}
      {banner && <div className="alert info">{banner}</div>}

      <h1 className="page-title">Management Committee Vote</h1>
      <p className="page-sub">
        {d?.pr?.pr_number} &middot; {winner?.vendor_name || '—'} &mdash;{' '}
        {winner?.total !== null && winner?.total !== undefined
          ? pkr(winner.total)
          : d?.pr?.amount_text || '—'}
      </p>

      {d?.alert && (
        <div className={ALERT_CLS[d.alert.cls] || 'alert info'}>{d.alert.text}</div>
      )}

      {d && <McVoteTable panel={d.panel} tally={d.tally} />}

      <PurposeAckWidget data={d?.purpose_ack} />
      <ImageGalleryCard images={d?.images} />

      {d?.can_vote && (
        <div className="card">
          <div className="card-h"><h3>Your vote</h3></div>
          <div className="card-b">
            <p className="text-sm">
              You are voting as <b>{d.you?.name || session?.user?.displayName || 'a panel member'}</b>.{' '}
              All {d.tally.panel} members must approve for the recommendation to pass.
            </p>
            <div className="field" style={{ maxWidth: 520, marginTop: 10 }}>
              <label>Reason (optional — recorded on the vote)</label>
              <input
                className="pk-input"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. warranty terms are below our 24-month floor"
                disabled={busy}
              />
            </div>
            <div className="btn-row" style={{ marginTop: 10 }}>
              <button className="btn success" disabled={busy} onClick={() => vote('approve')}>Approve</button>
              <button className="btn danger" disabled={busy} onClick={() => vote('reject')}>Reject</button>
              {d.demo_helper_allowed && (
                <button
                  className="btn ghost"
                  disabled={busy}
                  onClick={autoComplete}
                  title="Demo helper: records the other members' approvals. Writes real vote rows for the real panel."
                >
                  Auto-complete all {d.tally.panel} votes
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {d && !d.can_vote && (
        <div className="text-sm text-mute" style={{ marginTop: 12 }}>
          {d.ready
            ? 'You are not an appointed member of this panel, so you cannot cast a vote.'
            : d.next}
        </div>
      )}

      {d && (
        <div className="btn-row" style={{ marginTop: 12 }}>
          <Link href={`/pr/${id}`} className="btn ghost">Back to the Purchase Request</Link>
          {d.round === 'approved' && (
            <Link href={`/cfo/${id}`} className="btn ghost">Continue to the CFO gate</Link>
          )}
        </div>
      )}
    </Shell>
  );
}
