// `cs` — Comparative Statement.
//
// Port of renderCS (prototype line 7842). Structure preserved: page title,
// the PR/RFQ/split/routing subtitle, the stage alerts, the "Bid comparison"
// table, and the "Lock CS" card with one button per quote.
//
// ── One deliberate divergence ───────────────────────────────────────────────
//
// SCORE COLUMNS ARE ADDED. The prototype's table is
//   Vendor | Amount | Lead | Warranty | Compliant
// and carries no scores at all — `pr.quotes` is a flat list and the reviewer
// eyeballs it. But `proc.cs_lines` exists precisely to hold commercial /
// technical / warranty / weighted scores and a rank, each CHECK-constrained to
// 0..100, so the schema expects a scored comparison. We keep the prototype's
// five columns in their original order and APPEND the scores after them, so the
// layout still reads as the prototype and the reviewer can see WHY a vendor
// ranked where it did rather than being handed an unexplained order.
//
// COMPLIANCE IS DERIVED, NOT ASSUMED (D5). The prototype hardcodes a green
// tick for every row. `core.vendor_due_diligence` is empty, so every row
// renders an em-dash.

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { useSession } from '../../lib/session';
import { api } from '../../lib/api';
import Shell from '../../components/Shell';
import { pkr } from '../../lib/ui';

type Compliance = { status: 'pass' | 'unknown' | 'fail'; label: string };

type CsLine = {
  vendor_id: string;
  vendor_name: string;
  vendor_code: string;
  /**
   * The commercial terms are carried alongside the scores. cs_lines itself
   * holds only scores and a rank, so the CS payload joins the scored quote's
   * own figures back in — the reviewer needs to see the amount they are being
   * asked to rank, not a score with nothing behind it.
   */
  total_amount: number | null;
  lead_time_days: number | null;
  warranty_months: number | null;
  commercial_score: number;
  technical_score: number;
  warranty_score: number;
  weighted_score: number;
  rank: number;
  compliance: Compliance;
  is_winner: boolean;
};

type CsSplitLine = {
  line_no: number;
  vendor_id: string;
  vendor_name: string | null;
  vendor_code: string | null;
  awarded_qty: number | null;
  justification: string | null;
};

type CsPayload = {
  cs: {
    id: string; cs_number: string; state: string | null;
    generated_at: string; locked_at: string | null;
    pr_number: string; expense_split: string; routing_key: string;
    override_reason: string | null;
    /** W5-G — 'SPLIT' means the decision is per line and `winner` is null. */
    award_mode: 'SINGLE' | 'SPLIT';
    split: CsSplitLine[] | null;
    winner: { vendor_id: string; vendor_name: string; total: number | null; is_new_vendor: boolean } | null;
  } | null;
  weights: { commercial: number; technical: number; warranty: number };
  scores: Record<string, unknown> | null;
  lines: CsLine[];
  ready: boolean;
  skip_mc: boolean;
};

const SPLIT_PILL: Record<string, string> = {
  CAPEX: 'capex', OPEX: 'opex', Mixed: 'mixed', CAPITAL: 'capex',
};

export default function CsPage() {
  const { session, ready } = useSession();
  const router = useRouter();
  const id = router.query.id as string;
  const [d, setD] = useState<CsPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    api.get<CsPayload>(`/pr/${id}/cs`).then(r => setD(r.data)).catch(e => setErr(e.message));
  }, [id]);

  useEffect(() => {
    if (!ready) return;
    if (!session) { router.replace('/'); return; }
    load();
  }, [ready, session, load]);

  if (!ready || !session || !id) return null;

  const cs = d?.cs ?? null;
  const lines = d?.lines ?? [];
  const split = cs?.expense_split;
  const routing = cs?.routing_key ?? 'STANDARD';
  const skipMc = d?.skip_mc ?? false;
  const winner = cs?.winner ?? null;
  // W5-G: a split-award CS has `winner: null` and carries its decision in
  // `split`. Both shapes must be renderable, or a locked split CS would show an
  // empty winner line and read as broken.
  const splitAward = cs?.split ?? null;
  const isSplitAward = (cs?.award_mode ?? 'SINGLE') === 'SPLIT';

  const lock = async (vendorId: string) => {
    if (!cs) return;
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/cs/${cs.id}/lock`, {
        winnerVendorId: vendorId,
        reason: 'Selected from the CS bid comparison.',
      });
      load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  // W5-G: locking a split sends NO winnerVendorId. The API decides the mode from
  // the recorded line awards, so the UI cannot assert a mode — it can only say
  // "lock what is there".
  const lockSplit = async () => {
    if (!cs) return;
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/cs/${cs.id}/lock`, {
        reason: 'Locked as a split award from the CS line-award review.',
      });
      load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="Comparative Statement (CS)" screenId="cs"
      subtitle={cs ? `${cs.pr_number} · ${routing}` : 'Loading…'}>
      {err && <div className="alert error">{err}</div>}

      <h1 className="page-title">Comparative Statement (CS)</h1>
      <p className="page-sub">
        {cs ? (
          <>
            {cs.pr_number} &middot; {cs.cs_number} &middot;{' '}
            {split && <span className={`pill ${SPLIT_PILL[split] ?? ''}`}>{split}</span>}
            {' '} &middot; Routing: <b>{routing}</b>
          </>
        ) : 'No Comparative Statement has been generated for this PR yet.'}
      </p>

      {/* The prototype's alerts, keyed off real state rather than its stage
          names: a Generated CS invites a lock, a Locked one reports the winner. */}
      {d?.ready && !skipMc && (
        <div className="alert info">
          {lines.length} quote{lines.length === 1 ? '' : 's'} scored. Lock the CS to recommend
          a winner to the MC.
        </div>
      )}
      {d?.ready && skipMc && (
        <div className="alert info">
          {lines.length} quote{lines.length === 1 ? '' : 's'} scored.{' '}
          <b>FAST-TRACK routing</b> &mdash; lock CS will skip MC + CFO and auto-lock the pack.
        </div>
      )}
      {cs?.state === 'Locked' && winner && (
        <div className="alert success">
          CS locked. Winner: <b>{winner.vendor_name}</b>.{' '}
          {skipMc ? 'Pack auto-locked. Ready to push to D365.' : 'Awaiting MC vote.'}
        </div>
      )}
      {cs?.state === 'Locked' && isSplitAward && splitAward && (
        <div className="alert success">
          CS locked as a <b>split award</b> across{' '}
          <b>{new Set(splitAward.map((s: any) => s.vendor_id)).size} vendor(s)</b> and{' '}
          {splitAward.length} line(s).{' '}
          {skipMc ? 'Pack auto-locked. Ready to push to D365.' : 'Awaiting MC vote.'}
        </div>
      )}

      {cs?.override_reason && (
        <div className="alert warn">
          The winner was NOT the top-ranked vendor. Reason: <i>&ldquo;{cs.override_reason}&rdquo;</i>
        </div>
      )}

      <div className="card mb-4">
        <div className="card-h">
          <h3>Bid comparison</h3>
          <span className="meta">
            {lines.length} quote{lines.length === 1 ? '' : 's'} &middot;{' '}
            {winner ? `Winner: ${winner.vendor_name}` : '—'}
          </span>
        </div>

        {lines.length === 0 ? (
          <div className="card-b empty-state">
            {cs
              ? 'No quotes were available to score when this CS was generated.'
              : 'No quotes received yet.'}
          </div>
        ) : (
          <table className="t">
            <thead>
              <tr>
                <th>Vendor</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th>Lead</th>
                <th>Warranty</th>
                <th style={{ textAlign: 'center' }}>Compliant</th>
                {/* The appended score columns — see the header note. */}
                <th style={{ textAlign: 'right' }} title={`Weight ${d?.weights.commercial}`}>Commercial</th>
                <th style={{ textAlign: 'right' }} title={`Weight ${d?.weights.technical}`}>Technical</th>
                <th style={{ textAlign: 'right' }} title={`Weight ${d?.weights.warranty}`}>Warranty&nbsp;score</th>
                <th style={{ textAlign: 'right' }}>Weighted</th>
                <th style={{ textAlign: 'center' }}>Rank</th>
              </tr>
            </thead>
            <tbody>
              {lines.map(l => (
                <tr key={l.vendor_id} className={l.is_winner ? 'winner' : undefined}>
                  <td>
                    <b>{l.vendor_name}</b>
                    {l.is_winner && <span className="pill approved" style={{ marginLeft: 6 }}>Winner</span>}
                    <div className="text-sm text-mute">{l.vendor_code}</div>
                  </td>
                  <td style={{ textAlign: 'right' }} className="mono num">
                    {l.total_amount !== null ? pkr(l.total_amount) : <span className="text-mute">&mdash;</span>}
                  </td>
                  <td>
                    {l.lead_time_days !== null
                      ? <>{l.lead_time_days} d</>
                      : <span className="text-mute" title="The vendor did not state a lead time">&mdash;</span>}
                  </td>
                  <td>
                    {l.warranty_months !== null
                      ? <>{l.warranty_months} mo</>
                      : <span className="text-mute" title="The vendor did not state a warranty">&mdash;</span>}
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    {/* D5: unknown renders as an em-dash, never a fabricated pass. */}
                    {l.compliance.status === 'unknown'
                      ? <span className="text-mute" title="No completed due-diligence record">&mdash;</span>
                      : <span style={{ color: l.compliance.status === 'pass' ? 'var(--success)' : 'var(--danger)' }}>
                          {l.compliance.label}
                        </span>}
                  </td>
                  <td style={{ textAlign: 'right' }} className="mono num">{l.commercial_score}</td>
                  <td style={{ textAlign: 'right' }} className="mono num">{l.technical_score}</td>
                  <td style={{ textAlign: 'right' }} className="mono num">{l.warranty_score}</td>
                  <td style={{ textAlign: 'right' }}><b className="mono num">{l.weighted_score}</b></td>
                  <td style={{ textAlign: 'center' }}>
                    <span className={`pill ${l.rank === 1 ? 'approved' : 'draft'}`}>{l.rank}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {splitAward && (
        <div className="card mb-4">
          <div className="card-h">
            <h3>Split award by line</h3>
            <span className="meta">{splitAward.length} line(s) awarded</span>
          </div>
          <div className="card-b">
            <table className="t">
              <thead>
                <tr>
                  <th>Line</th>
                  <th>Winner</th>
                  <th style={{ textAlign: 'right' }}>Qty awarded</th>
                  <th>Justification</th>
                </tr>
              </thead>
              <tbody>
                {splitAward.map((s: any) => (
                  <tr key={s.line_no}>
                    <td className="mono">#{s.line_no}</td>
                    <td>
                      <b>{s.vendor_name}</b>
                      <div className="text-sm text-mute">{s.vendor_code}</div>
                    </td>
                    <td style={{ textAlign: 'right' }} className="mono num">{s.awarded_qty}</td>
                    <td className="text-sm">{s.justification}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* The lock card. renderCS gates it on `ready && (procurement || cs)`; the
          API reports `ready`, so the UI does not re-derive the stage. */}
      {d?.ready && lines.length > 0 && (
        <div className="card">
          <div className="card-h"><h3>Lock CS</h3></div>
          <div className="card-b">
            {splitAward && splitAward.length > 0 ? (
              <>
                <p className="text-sm">
                  This CS carries <b>{splitAward.length} line award(s)</b> across{' '}
                  <b>{new Set(splitAward.map((s: any) => s.vendor_id)).size} vendor(s)</b>, so it
                  will lock as a <b>split award</b> &mdash; the per-line winners above become the
                  decision of record and no single vendor is named.{' '}
                  Locking is final &mdash; a locked CS cannot be re-locked.
                </p>
                <div className="btn-row">
                  <Link href={`/buyer/award-matrix?cs=${cs?.id}&pr=${id}`} className="btn primary">
                    Review line awards in the matrix
                  </Link>
                  <button className="btn ghost" disabled={busy} onClick={lockSplit}>Lock as split award</button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm">
                  Pick a winner. The CS will be locked and routed{' '}
                  {skipMc
                    ? 'directly to D365 push (MC + CFO skipped)'
                    : 'to the MC for a vote'}.
                  Locking is final &mdash; a locked CS cannot be re-locked.
                </p>
                <div className="btn-row">
                  {lines.map((l, i) => (
                    <button
                      key={l.vendor_id}
                      className={`btn ${i === 0 ? 'primary' : 'ghost'}`}
                      disabled={busy}
                      title={i === 0
                        ? undefined
                        : `Rank ${l.rank}, not the top-ranked vendor. Locking without an override reason will be refused.`}
                      onClick={() => lock(l.vendor_id)}
                    >
                      Recommend {l.vendor_name} ({l.weighted_score})
                    </button>
                  ))}
                  <Link href={`/buyer/award-matrix?cs=${cs?.id}&pr=${id}`} className="btn ghost">
                    Split by line item&hellip;
                  </Link>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {cs && (
        <div className="btn-row" style={{ marginTop: 12 }}>
          <Link href={`/pr/${id}`} className="btn ghost">Back to the Purchase Request</Link>
          {/* The `pack` page is reached from here once a winner exists. It is
              not built until step 8, so no link is rendered rather than
              pointing at a 404. */}
          {cs.state === 'Locked' && !skipMc && (
            <span className="text-sm text-mute">
              Awaiting the MC vote before an approved pack can be locked.
            </span>
          )}
          {cs.state === 'Locked' && skipMc && (
            <span className="text-sm text-mute">
              Pack auto-locked on this FAST-TRACK route. The D365 push is Wave 3.
            </span>
          )}
        </div>
      )}
    </Shell>
  );
}
