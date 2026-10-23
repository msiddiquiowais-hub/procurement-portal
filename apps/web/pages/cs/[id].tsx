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

import { useEffect, useState, useCallback, Fragment } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { useSession } from '../../lib/session';
import { api } from '../../lib/api';
import Shell from '../../components/Shell';
import CsMatrix from '../../components/CsMatrix';
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
  /** Scored dimensions this vendor never stated. Empty = stated everything. */
  missing: string[];
  rank: number;
  compliance: Compliance;
  is_winner: boolean;
  /**
   * True on a row whose commercial detail the server STRIPPED for a blind
   * reviewer. Every numeric field on such a row is null, and a null rendered as
   * a bare cell is indistinguishable from a genuine zero — which is the exact
   * ambiguity this whole feature exists to prevent, so the flag is explicit.
   */
  is_masked?: boolean;
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
  /**
   * Present only while no statement exists yet — the state a PR lands in the
   * moment procurement hands it over. They drive the Generate panel, which is
   * the screen's main event in that state rather than an empty table.
   */
  pr_number?: string | null;
  pr_status?: string | null;
  live_quotes?: number;
  can_generate?: boolean;
  generate_blocked_reason?: string | null;
  cs: {
    id: string; cs_number: string; state: string | null;
    /** Live round. Only surfaced in the UI when > 1 — see the subtitle. */
    cs_round: number;
    generated_at: string; locked_at: string | null;
    pr_number: string; expense_split: string; routing_key: string;
    /**
     * The originating department's NAME for the header bar. Null when the PR has
     * no department_id — the bar then omits the segment rather than printing an
     * empty pair of separators.
     */
    department_name?: string | null;
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
  /**
   * Set by the API when THIS response had its commercial detail stripped for a
   * blind reviewer. The flag is on the payload rather than inferred from empty
   * cells, because "the fields are null" and "you are not allowed to see them"
   * are different claims and only one of them should be rendered.
   */
  masked_for_viewer?: boolean;
  mask_reason?: string | null;
  /** How many vendors were compared. Not secret — a reviewer must know the field. */
  vendor_count?: number;
  /**
   * The sub-state of any review in force, or null. Its presence is what makes
   * `ready` false — locking is closed while a statement is under review, and
   * this is the server's reason for it.
   */
  review_in_progress?: string | null;
};

type SubState = 'DRAFT' | 'PROC_REVIEW' | 'REQUESTER_REVIEW' | 'CONFIRMED' | 'REVERTED';

/** One awarded line's commercial breakdown, as the masked endpoint returns it. */
type BlindAwardLine = {
  line_no: number;
  description: string | null;
  quantity: number | null;
  awarded_qty: number | null;
  uom: string | null;
  /**
   * The item's category (IT_HARDWARE, FACILITIES, OFFICE_SUPPLIES …), from the
   * PR line the RFQ line came from. Null on the handful of rfq_lines with no PR
   * line, and for statements generated before the column was populated — the UI
   * renders an em-dash rather than guessing one.
   */
  category: string | null;
  lead_time_days: number | null;
  unit_price: number | null;
  gross_amount: number | null;
  discount_percent: number | null;
  discount_amount: number | null;
  net_amount: number | null;
  tax_percent: number | null;
  tax_amount: number | null;
  line_total: number | null;
  remarks: string | null;
  is_masked: boolean;
};

type ReviewPayload = {
  review: {
    id: string;
    cs_id: string;
    cs_number: string;
    sub_state: SubState;
    current_round: number;
    generated_at: string | null;
    proc_review_at: string | null;
    requester_review_at: string | null;
    confirmed_at: string | null;
    reverted_at: string | null;
    revert_kind: 'SOFT' | 'HARD' | null;
    revert_reason: string | null;
  } | null;
  sub_state: SubState | null;
  pr_status?: string | null;
  masked_for_viewer?: boolean;
  mask_reason?: string | null;
  requester_scope?: string | null;
  actions: {
    can_submit: boolean;
    can_send_to_requester: boolean;
    can_confirm: boolean;
    can_revert_soft: boolean;
    can_revert_hard: boolean;
    /** Who the blind confirmation is actually waiting on, when it is not you. */
    confirm_waiting_on?: string | null;
  };
};

const CHAIN: { key: SubState; label: string }[] = [
  { key: 'DRAFT', label: 'Drafted' },
  { key: 'PROC_REVIEW', label: 'Procurement review' },
  { key: 'REQUESTER_REVIEW', label: 'Requester review (blind)' },
  { key: 'CONFIRMED', label: 'Confirmed' },
];

/**
 * A money/percent cell in the blind commercial review.
 *
 * An ABSENT figure is an em-dash, never a 0. The recorded columns come straight
 * from quotation_lines and a vendor may genuinely have left tax or discount
 * unstated; printing 0 for that would assert a figure nobody quoted, which on a
 * totals row silently moves the grand total.
 */
const money = (v: number | null | undefined) =>
  v === null || v === undefined
    ? <span className="text-mute">&mdash;</span>
    : <>{Number(v).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</>;

/**
 * Column total that IGNORES absent lines rather than treating them as zero.
 *
 * Keyed on the numeric columns only. A wider `keyof BlindAwardLine` would let a
 * caller pass 'description' or 'remarks', whose values are strings — and
 * `typeof v === 'number'` would then be a comparison the compiler can prove is
 * dead, which is exactly the check that catches this mistake.
 */
type NumericLineKey = {
  [K in keyof BlindAwardLine]: BlindAwardLine[K] extends number | null ? K : never
}[keyof BlindAwardLine];

const sum = (rows: BlindAwardLine[], key: NumericLineKey) =>
  rows.reduce((s, r) => {
    const v = r[key];
    return typeof v === 'number' ? s + v : s;
  }, 0);

const SPLIT_PILL: Record<string, string> = {
  CAPEX: 'capex', OPEX: 'opex', Mixed: 'mixed', CAPITAL: 'capex',
};

/**
 * The header bar's separator.
 *
 * It is a COMPONENT, not a literal character, for one reason: a separator drawn
 * in the markup between two conditional segments produces "| |" the moment the
 * middle one is absent. Here every segment renders its own leading separator, so
 * dropping the department or the split badge removes exactly one pipe.
 */
const Sep = () => (
  <span aria-hidden style={{ color: 'var(--mute,#64748b)', userSelect: 'none' }}>|</span>
);

export default function CsPage() {
  const { session, ready } = useSession();
  const router = useRouter();
  const id = router.query.id as string;
  const [d, setD] = useState<CsPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Generate — only meaningful before a CS exists, which is the state this
  // screen opens in for a freshly forwarded PR.
  const [genBusy, setGenBusy] = useState(false);
  const [genErr, setGenErr] = useState<string | null>(null);

  // ── Matrix tab ────────────────────────────────────────────────────────────
  // Gated on core.settings `cs.matrixLayout`, NOT on a second switch. Two
  // controls for one decision produce the ambiguous "selected but off, so what
  // renders?" state. Until an admin sets MATRIX, this screen renders exactly
  // what it always did — which is what keeps UAT provably undisturbed.
  //
  // `value` is jsonb and arrives through the CSV bridge as a JSON *string*, so
  // it may be either the bare word or a quoted JSON string. Both are accepted.
  const [layout, setLayout] = useState<'VENDOR_SUMMARY' | 'MATRIX'>('VENDOR_SUMMARY');
  const [tab, setTab] = useState<'summary' | 'matrix'>('summary');

  // ── CS review sub-workflow (migration 065) ──────────────────────────────
  // Loaded alongside the statement so the chain and the commercial detail can
  // never be drawn from two different moments.
  const [rv, setRv] = useState<ReviewPayload | null>(null);
  const [rvBusy, setRvBusy] = useState<string | null>(null);
  const [rvErr, setRvErr] = useState<string | null>(null);
  const [revertKind, setRevertKind] = useState<'SOFT' | 'HARD' | null>(null);
  const [revertReason, setRevertReason] = useState('');
  /**
   * The blind evaluation grid, from the SAME masked endpoint the Matrix tab
   * uses. Fetched only when the server says this viewer is masked, so the
   * competitive data is never requested by a viewer entitled to see none of it.
   */
  const [blindGrid, setBlindGrid] = useState<BlindAwardLine[] | null>(null);

  /**
   * The reviewer's per-line decision. Every line starts OK; a line flips to
   * NEGOTIATE only when the reviewer says so. Held here rather than in the
   * server so the toggle is instant, and submitted as a whole on revert.
   */
  const [decisions, setDecisions] = useState<Record<number, 'OK' | 'NEGOTIATE'>>({});
  const [negotiateNote, setNegotiateNote] = useState<Record<number, string>>({});

  const decisionFor = (lineNo: number) => decisions[lineNo] ?? 'OK';
  const flagged = (blindGrid ?? []).filter((l) => decisionFor(l.line_no) === 'NEGOTIATE');

  const setDecision = (lineNo: number, next: 'OK' | 'NEGOTIATE') => {
    setDecisions((prev) => ({ ...prev, [lineNo]: next }));
    if (next === 'OK') {
      // Collapsing back to OK discards the note with the field it belonged to,
      // so a stale rate cannot be submitted against a line that is no longer
      // flagged.
      setNegotiateNote((prev) => { const c = { ...prev }; delete c[lineNo]; return c; });
    }
  };

  useEffect(() => {
    api
      .get<any>('/admin/settings')
      .then((r) => {
        const row = (r.data?.settings ?? []).find((s: any) => s.key === 'cs.matrixLayout');
        if (!row) return;
        const raw = typeof row.value === 'string' ? row.value.replace(/^"|"$/g, '') : row.value;
        setLayout(raw === 'MATRIX' ? 'MATRIX' : 'VENDOR_SUMMARY');
      })
      .catch(() => { /* settings unreadable -> stay on the summary view */ });
  }, []);

  const matrixOn = layout === 'MATRIX';
  /**
   * THE BLIND REVIEWER'S VIEW OF THIS SCREEN.
   *
   * True only when the SERVER stripped this payload. It is derived from
   * `masked_for_viewer` rather than from the sub-state, because the sub-state
   * alone cannot say whether THIS viewer is the blind reviewer — procurement
   * looking at the same statement during REQUESTER_REVIEW is not masked.
   */
  const blindMode = d?.masked_for_viewer === true;
  // Mirrors the backend's CS_ROLES gate. The service is the real control; this
  // only avoids rendering radios that would 403.
  const canAward = session?.user?.role === 'procurement' || session?.user?.role === 'cs' || session?.user?.role === 'admin';

  const load = useCallback(() => {
    if (!id) return;
    api.get<CsPayload>(`/pr/${id}/cs`).then(r => {
      setD(r.data);
      setBlindGrid(null);
      // Only a masked viewer fetches the commercial review, and only from the masked
      // endpoint. Nobody else ever issues this request.
      if (r.data?.masked_for_viewer && r.data?.cs?.id) {
        setDecisions({});
        setNegotiateNote({});
        api.get<any>(`/cs/${r.data.cs.id}/matrix`)
          .then(m => setBlindGrid(m.data?.awarded_lines_detail ?? []))
          .catch(() => setBlindGrid([]));
      }
    }).catch(e => setErr(e.message));
    // The review chain is a separate resource. A failure here must not blank the
    // statement: the commercial screen is still readable without it, so this
    // catch only records the reason.
    api.get<ReviewPayload>(`/pr/${id}/cs/review`)
      .then(r => setRv(r.data))
      .catch(() => setRv(null));
  }, [id]);

  /** Score the live quotations into a comparative statement, then re-read. */
  const generate = async () => {
    if (!id) return;
    setGenBusy(true); setGenErr(null);
    try {
      await api.post(`/pr/${id}/cs`, {});
      await load();
    } catch (e: any) {
      setGenErr(String(e?.message ?? e));
    } finally {
      setGenBusy(false);
    }
  };

  /**
   * One handler for every step of the review chain.
   *
   * The buttons are role-scoped server-side, so this sends the action and
   * re-reads. It does NOT decide what is allowed: if the server refuses, the
   * message shown is the server's, because a client-side "allowed" the server
   * disagrees with is how a screen ends up offering a dead button.
   */
  const reviewAction = async (path: string, label: string, body?: unknown) => {
    if (!cs) return;
    setRvBusy(label); setRvErr(null);
    try {
      await api.post(`/cs/${cs.id}/review/${path}`, body ?? {});
      setRevertKind(null); setRevertReason('');
      load();
    } catch (e: any) {
      setRvErr(String(e?.message ?? e));
    } finally {
      setRvBusy(null);
    }
  };

  const doRevert = async (kind: 'SOFT' | 'HARD') => {
    if (!revertReason.trim()) {
      setRvErr('A revert must record a reason.');
      return;
    }
    await reviewAction(kind === 'SOFT' ? 'revert-soft' : 'revert-hard', kind, { reason: revertReason.trim() });
  };

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
    // The Shell breadcrumb already reads "Home / Comparative Statement (CS)"
    // and the bar below carries PR number, CS number, OPEX/CAPEX and
    // department. The subtitle is therefore NOT a third copy of those facts —
    // it holds only what the bar has no room for: which round is in force and
    // how the request is routed. All four facts used to be printed twice, which
    // is how a screen says "Comparative Statement" three times before saying
    // anything about the statement.
    <Shell title="Comparative Statement (CS)" screenId="cs"
      subtitle={cs
        ? [
            (cs.cs_round ?? 1) > 1 ? `Round ${cs.cs_round}` : null,
            `Routing: ${routing}`,
          ].filter(Boolean).join(' · ')
        : d?.pr_number ? 'Not yet generated'
          : 'Loading…'}>
      {err && <div className="alert error">{err}</div>}

      {/* ONE COMPACT BAR. PR number · CS number · OPEX/CAPEX · Department.
          Every segment is something a reviewer needs before reading a line, and
          nothing is printed twice. Each separator is rendered INSIDE the segment
          that follows it, so a missing department or a non-SPLIT award cannot
          leave a dangling "|" or two of them side by side. */}
      {cs && (
        <div
          data-testid="cs-header-bar"
          style={{
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            marginBottom: 12, fontSize: 13, lineHeight: 1.5,
          }}
        >
          <b className="mono">{cs.pr_number}</b>
          <Sep />
          <b className="mono">{cs.cs_number}</b>
          {split && (<><Sep /><span className={`pill ${SPLIT_PILL[split] ?? ''}`}>{split}</span></>)}
          {cs.department_name && (<><Sep /><span className="text-mute">{cs.department_name}</span></>)}
          {/* A re-round only happens when the MC sends the statement back. The
              earlier round is deliberately preserved as evidence of what was
              objected to, so the screen has to say which one is in force —
              otherwise two statements on one PR is unexplainable. */}
          {(cs.cs_round ?? 1) > 1 && (<><Sep /><span className="pill draft">Round {cs.cs_round}</span></>)}
        </div>
      )}
      {!cs && d?.pr_number && (
        <p className="page-sub">
          {d.pr_number} &middot; No Comparative Statement has been generated for this PR yet.
        </p>
      )}

      {/* ── CS REVIEW CHAIN (migration 065) ───────────────────────────────
          Four states, and only the reviewer who owns the open gate sees the
          button for the next one. The buttons are decided by the server's
          `actions` block, not by the role in the browser: if this screen ever
          offers an action the API refuses, that is a dead button, so the
          server is the only place the answer is taken from.

          The chain is a STRIP, not a card of four boxes. It used to render as
          stacked cards with a "current" caption under the active one, which cost
          ~90px of vertical space to communicate one fact — where in the chain
          this review is. On a screen whose entire purpose is the 14-column table
          below, that space belongs to the table. It is one line now, and it wraps
          on a narrow window rather than overflowing. */}
      {cs && rv && (
        <div style={{ marginBottom: 12 }}>
          {/* The blind banner comes FIRST. A reviewer who reaches this screen
              and finds an empty bid table has to be told why it is empty
              before they conclude nobody quoted. */}
          {rv.masked_for_viewer && (
            <div className="alert" style={{ marginBottom: 10 }}>
              <b>Blind review.</b> {rv.mask_reason}
              {typeof d?.vendor_count === 'number' && (
                <> {d.vendor_count} vendor{d.vendor_count === 1 ? '' : 's'} were compared.</>
              )}
            </div>
          )}

          {/* Rendered even when no review has been started, because "nothing has
              happened yet" is a state this screen must explain rather than
              omit. */}
          <div
            data-testid="cs-review-chain"
            aria-label="Review chain"
            style={{
              display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
              fontSize: 12, lineHeight: 1,
            }}
          >
            <span className="text-mute" style={{ marginRight: 2 }}>Review</span>
            {CHAIN.map((s, i) => {
              const idx = CHAIN.findIndex(c => c.key === rv.sub_state);
              const done = idx >= 0 && i < idx;
              const now = rv.sub_state === s.key;
              const dim = rv.sub_state === 'REVERTED' && i > 0;
              return (
                <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {/* The connector is aria-hidden: it is decoration between two
                      labelled stops, and announcing "arrow" four times tells a
                      screen-reader user nothing the labels do not already say. */}
                  {i > 0 && (
                    <span aria-hidden style={{
                      color: done ? 'var(--ok,#16a34a)' : 'var(--line,#cbd5e1)', fontWeight: 700,
                    }}>›</span>
                  )}
                  <span
                    aria-current={now ? 'step' : undefined}
                    style={{
                      padding: '3px 8px', borderRadius: 999,
                      border: '1px solid ' + (now ? 'var(--accent,#2563eb)' : 'var(--line,#e5e7eb)'),
                      background: done ? 'var(--ok-bg,#f0fdf4)' : now ? 'var(--accent-bg,#eff6ff)' : 'transparent',
                      color: done ? 'var(--ok,#16a34a)' : now ? 'var(--accent,#2563eb)' : 'var(--mute,#64748b)',
                      fontWeight: now || done ? 700 : 400,
                      whiteSpace: 'nowrap',
                      opacity: dim ? 0.5 : 1,
                    }}
                  >
                    {done && <span aria-hidden>✓ </span>}
                    {s.label}
                  </span>
                </span>
              );
            })}
            {/* A REVERTED chain has no step marked current — the review is not
                sitting at any of the four stops — so the state is stated in
                words rather than left to be inferred from four dim pills. */}
            {rv.sub_state === 'REVERTED' && (
              <span className="pill draft" style={{ marginLeft: 6 }}>Reverted</span>
            )}
          </div>
        </div>
      )}
      {cs && rv && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-b">
            {rv.sub_state === 'REVERTED' && rv.review && (
              <div className="alert" style={{ marginBottom: 12 }}>
                Reverted ({rv.review.revert_kind === 'HARD' ? 'hard — statement withdrawn' : 'soft — negotiate, nothing cancelled'}):
                {' '}<i>{rv.review.revert_reason}</i>
              </div>
            )}

            {rv.requester_scope && (
              <div className="text-sm text-mute" style={{ marginBottom: 10 }}>{rv.requester_scope}</div>
            )}

            {/* Shown ONLY when the lock is genuinely withheld, i.e. when the server set
                `review_in_progress`. Keyed off the sub-state alone it would also
                print at DRAFT — where no review row exists yet, the lock is
                perfectly available, and the Lock CS card sits directly beneath
                this sentence. A notice that contradicts the screen is worse than
                no notice. */}
            {Boolean(d?.review_in_progress) && rv.sub_state !== 'CONFIRMED' && (
              <div className="text-sm text-mute" style={{ marginBottom: 10 }}>
                Locking is unavailable while this statement is in review. The only route forward is
                the review chain above, ending in <b>Confirmed</b>. Confirming settles the rates
                and locks the statement; Procurement then classifies every line and advances the
                request to cost center approval.
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {rv.actions.can_submit && (
                <button className="btn primary" disabled={rvBusy !== null}
                  onClick={() => reviewAction('submit', 'submit')}>
                  {rvBusy === 'submit' ? 'Submitting…' : 'Submit for procurement review'}
                </button>
              )}
              {rv.actions.can_send_to_requester && (
                <button className="btn" disabled={rvBusy !== null}
                  onClick={() => reviewAction('send-to-requester', 'send')}>
                  {rvBusy === 'send' ? 'Sending…' : 'Send to requester (blind)'}
                </button>
              )}
              {rv.actions.can_confirm && (
                <button className="btn primary" disabled={rvBusy !== null}
                  onClick={() => reviewAction('confirm', 'confirm')}>
                  {rvBusy === 'confirm' ? 'Confirming…' : 'Confirm comparative statement'}
                </button>
              )}
              {(rv.actions.can_revert_soft || rv.actions.can_revert_hard) && revertKind === null && (
                <>
                  {rv.actions.can_revert_soft && (
                    <button className="btn" onClick={() => setRevertKind('SOFT')}>Revert for negotiation</button>
                  )}
                  {rv.actions.can_revert_hard && (
                    <button className="btn" onClick={() => setRevertKind('HARD')}>Withdraw statement</button>
                  )}
                </>
              )}
              {revertKind !== null && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    className="input"
                    style={{ minWidth: 260 }}
                    placeholder={revertKind === 'SOFT'
                      ? 'Why is it going back for negotiation?'
                      : 'Why is the statement being withdrawn?'}
                    value={revertReason}
                    onChange={e => setRevertReason(e.target.value)}
                  />
                  <button className="btn primary" disabled={rvBusy !== null} onClick={() => doRevert(revertKind)}>
                    {rvBusy === revertKind ? 'Working…' : `Confirm ${revertKind === 'SOFT' ? 'soft' : 'hard'} revert`}
                  </button>
                  <button className="btn" onClick={() => { setRevertKind(null); setRevertReason(''); }}>Cancel</button>
                </div>
              )}
            </div>

            {/* Nothing available is a sentence, not an empty row: the reviewer
                has to be able to tell "waiting on someone else" from "there is
                no next step". */}
            {!rv.actions.can_submit && !rv.actions.can_send_to_requester
              && !rv.actions.can_confirm && !rv.actions.can_revert_soft && (
              <div className="text-sm text-mute" style={{ marginTop: 8 }}>
                {rv.sub_state === 'CONFIRMED'
                  ? 'This statement is confirmed. It no longer moves through review.'
                  : rv.sub_state === 'REQUESTER_REVIEW'
                    ? `Waiting on ${rv.actions.confirm_waiting_on ?? 'the originating department’s approver'}. ` +
                      'Procurement cannot confirm it on their behalf.'
                    : rv.sub_state === 'PROC_REVIEW'
                      ? 'Waiting on a procurement manager.'
                      : 'No review action is open to you at this stage.'}
              </div>
            )}
            {rvErr && <div className="alert error" style={{ marginTop: 10 }}>{rvErr}</div>}
          </div>
        </div>
      )}

      {/* ── GENERATE ──────────────────────────────────────────────────────
          This screen was a dead end. `POST /pr/:id/cs` exists and works, but
          nothing in the UI ever called it, so a PR that had just been forwarded
          from procurement landed here on an empty bid table with no way to do
          anything about it. Generating the statement IS this screen's main
          event, not an admin afterthought.

          The quote count is read off the server payload rather than inferred
          from the table below, because the table is empty in exactly the case
          this is for — counting it here would always say zero. */}
      {!cs && d && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-b">
            <div style={{ marginBottom: 10 }}>
              {d.live_quotes > 0 ? (
                <>
                  <b>{d.live_quotes}</b> live quotation{d.live_quotes === 1 ? '' : 's'} on file for this
                  request. Scoring them produces the comparative statement the committee votes on.
                </>
              ) : (
                <>
                  No quotations have been received for this request yet, so there is nothing to
                  compare. A comparative statement can be generated once at least one quotation is in.
                </>
              )}
            </div>
            {d.can_generate ? (
              <button className="btn primary" onClick={generate} disabled={genBusy}>
                {genBusy ? 'Generating…' : 'Generate comparative statement'}
              </button>
            ) : (
              <div className="text-sm text-mute">{d.generate_blocked_reason}</div>
            )}
            {genErr && <div className="alert error" style={{ marginTop: 10 }}>{genErr}</div>}
          </div>
        </div>
      )}

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

      {/* ── BLIND COMMERCIAL REVIEW ────────────────────────────────────────────
          Replaces the Summary Form and Matrix Form tabs entirely for a blind
          reviewer. It shows the AWARDED lines and their complete financial
          breakdown — the rates, discounts, taxes and delivery terms the HOD is
          being asked to sign off — with no vendor name, code or id anywhere.

          The figures are the recorded ones, never recomputed: an audit screen
          that re-derived its own totals would be able to disagree with the
          award it is describing. */}
      {blindMode && (
        <div className="card mb-4">
          <div className="card-h">
            <h3>Blind Commercial Review</h3>
            <span className="meta">
              {blindGrid ? `${blindGrid.length} awarded line${blindGrid.length === 1 ? '' : 's'}` : '—'}
            </span>
          </div>
          <div className="card-b">
            {/* DUAL SCROLL. The financial columns cannot be squeezed into the
                viewport, and a 14-column table that only scrolls sideways hides
                the header. Vertical scrolling is bounded for the same reason: an
                unbounded grid pushes the totals off the bottom of the screen,
                and the totals are the point of the review.

                `width: 100%` + `minWidth` TOGETHER, deliberately: the wrapper
                fills the available screen width instead of shrink-wrapping to
                1400px and leaving dead space on a wide monitor, while `minWidth`
                still forces a horizontal scrollbar on a narrow one. Setting only
                minWidth was the old behaviour — the table sat at its intrinsic
                width and ignored the viewport entirely. */}
            <div
              data-testid="cs-blind-scroll"
              style={{
                width: '100%', maxHeight: 460,
                overflowX: 'auto', overflowY: 'auto',
                border: '1px solid var(--border)', borderRadius: 8,
              }}
            >
              {/*
                COLUMN BUDGET. The fourteen columns are given an explicit share of
                the 1400px floor so no single one can starve the rest: the
                description column is the only elastic one, because it is the only
                cell whose content is genuinely unbounded prose. Everything else
                is a number or a short token and is sized to its widest real
                value — a PKR figure reaches six figures, a percentage reaches
                two. Without widths here the browser distributes space by content
                and the remarks column swallows the screen.
              */}
              <table className="t" style={{ minWidth: 1400, width: '100%', tableLayout: 'fixed' }}>
                <colgroup>
                  <col style={{ width: 52 }} />                                   {/* Seq # */}
                  <col />                                                          {/* Item Description — elastic */}
                  <col style={{ width: 84 }} />                                   {/* Quantity */}
                  <col style={{ width: 74 }} />                                   {/* Lead Days */}
                  <col style={{ width: 104 }} />                                  {/* Unit Price */}
                  <col style={{ width: 116 }} />                                  {/* Gross Amount */}
                  <col style={{ width: 78 }} />                                   {/* Discount % */}
                  <col style={{ width: 108 }} />                                  {/* Discount Amount */}
                  <col style={{ width: 112 }} />                                  {/* Net Taxable */}
                  <col style={{ width: 64 }} />                                   {/* Tax % */}
                  <col style={{ width: 100 }} />                                  {/* Tax Amount */}
                  <col style={{ width: 112 }} />                                  {/* Line Total */}
                  <col style={{ width: 150 }} />                                  {/* Remarks */}
                  <col style={{ width: 104 }} />                                  {/* Decision */}
                </colgroup>
                <thead style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--line)', boxShadow: '0 1px 2px rgba(0,0,0,.08)' }}>
                  <tr>
                    <th>Seq #</th>
                    <th>Item Description</th>
                    <th style={{ textAlign: 'right' }}>Quantity</th>
                    <th style={{ textAlign: 'right' }}>Lead Days</th>
                    <th style={{ textAlign: 'right' }}>Unit Price (PKR)</th>
                    <th style={{ textAlign: 'right' }}>Gross Amount (PKR)</th>
                    <th style={{ textAlign: 'right' }}>Discount %</th>
                    <th style={{ textAlign: 'right' }}>Discount Amount (PKR)</th>
                    <th style={{ textAlign: 'right' }}>Net Taxable (PKR)</th>
                    <th style={{ textAlign: 'right' }}>Tax %</th>
                    <th style={{ textAlign: 'right' }}>Tax Amount (PKR)</th>
                    <th style={{ textAlign: 'right' }}>Line Total (PKR)</th>
                    <th>Procurement Remarks</th>
                    {/* The legend lives in the HEADER only. Repeating "OK" and
                        "Negotiate" down every row is what makes these tables
                        unreadable at fourteen columns. Width comes from the
                        colgroup now; a minWidth here would fight it. */}
                    <th style={{ textAlign: 'center' }}>Decision (🟢 OK | 🟠 Negotiate)</th>
                  </tr>
                </thead>
                <tbody>
                  {blindGrid === null ? (
                    <tr><td colSpan={14} className="text-mute" style={{ textAlign: 'center' }}>Loading the commercial review…</td></tr>
                  ) : blindGrid.length === 0 ? (
                    <tr><td colSpan={14} className="text-mute" style={{ textAlign: 'center' }}>
                      No lines have been awarded yet, so there is nothing to review. Return the statement
                      to procurement for line awards before requesting a commercial review.
                    </td></tr>
                  ) : (
                    blindGrid.map((l, i) => {
                      const dec = decisionFor(l.line_no);
                      const negotiate = dec === 'NEGOTIATE';
                      return (
                        // A FRAGMENT, because the negotiate input is a second
                        // <tr> beneath the line it belongs to.
                        <Fragment key={l.line_no}>
                          <tr style={negotiate
                            ? { background: 'rgba(245,158,11,.12)', boxShadow: 'inset 4px 0 0 #f59e0b' }
                            : undefined}>
                            <td className="mono">{i + 1}</td>
                            {/* Description + category. The reviewer is judging a MIX
                                of lines, and category is what says whether a rate
                                is comparable to the one above it — a laptop and a
                                box of pens are not competing on price. It sits
                                UNDER the description rather than in a column of
                                its own: a fifteenth column would cost more width
                                than the badge does, and the badge is short
                                enough to read without a header. */}
                            <td>
                              <div>{l.description ?? '—'}</div>
                              <div style={{ marginTop: 2 }}>
                                {l.category ? (
                                  <span
                                    className="pill draft"
                                    title={`Category: ${l.category}`}
                                    style={{ fontSize: 10, padding: '1px 6px', opacity: 0.85 }}
                                  >
                                    {l.category.replace(/_/g, ' ')}
                                  </span>
                                ) : (
                                  /* A missing category is stated, not hidden: an
                                     em-dash under the description says "not
                                     categorised", where an absent badge reads as
                                     "nobody thought it mattered". */
                                  <span className="text-mute" style={{ fontSize: 10 }}>—</span>
                                )}
                              </div>
                            </td>
                            <td style={{ textAlign: 'right' }} className="mono num">
                              {l.quantity ?? '—'}{l.uom ? ` ${l.uom}` : ''}
                            </td>
                            <td style={{ textAlign: 'right' }} className="mono num">
                              {l.lead_time_days ?? <span className="text-mute">—</span>}
                            </td>
                            <td style={{ textAlign: 'right' }} className="mono num">{money(l.unit_price)}</td>
                            <td style={{ textAlign: 'right' }} className="mono num">{money(l.gross_amount)}</td>
                            <td style={{ textAlign: 'right' }} className="mono num">{money(l.discount_percent)}</td>
                            <td style={{ textAlign: 'right' }} className="mono num">{money(l.discount_amount)}</td>
                            <td style={{ textAlign: 'right' }} className="mono num">{money(l.net_amount)}</td>
                            <td style={{ textAlign: 'right' }} className="mono num">{money(l.tax_percent)}</td>
                            <td style={{ textAlign: 'right' }} className="mono num">{money(l.tax_amount)}</td>
                            <td style={{ textAlign: 'right' }} className="mono num"><b>{money(l.line_total)}</b></td>
                            <td className="text-sm">{l.remarks || <span className="text-mute">—</span>}</td>
                            <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                              <label style={{ cursor: 'pointer', marginRight: 10, fontWeight: 700 }} title="Accept this line">
                                <input type="radio" name={`dec-${l.line_no}`} checked={!negotiate}
                                  onChange={() => setDecision(l.line_no, 'OK')} /> 🟢
                              </label>
                              <label style={{ cursor: 'pointer', fontWeight: 700 }} title="Flag this line for negotiation">
                                <input type="radio" name={`dec-${l.line_no}`} checked={negotiate}
                                  onChange={() => setDecision(l.line_no, 'NEGOTIATE')} /> 🟠
                              </label>
                            </td>
                          </tr>
                          {negotiate && (
                            <tr style={{ background: 'rgba(245,158,11,.12)' }}>
                              <td />
                              <td colSpan={13}>
                                <input
                                  className="input"
                                  style={{ width: '100%' }}
                                  placeholder="Enter target rate or reason to negotiate..."
                                  value={negotiateNote[l.line_no] ?? ''}
                                  onChange={(e) => setNegotiateNote((p) => ({ ...p, [l.line_no]: e.target.value }))}
                                />
                                {!String(negotiateNote[l.line_no] ?? '').trim() && (
                                  <div className="text-sm" style={{ color: '#b45309', marginTop: 4 }}>
                                    A target rate or reason is required before this line can be returned.
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })
                  )}
                </tbody>
                {blindGrid && blindGrid.length > 0 && (
                  <tfoot style={{ position: 'sticky', bottom: 0, zIndex: 10, background: 'var(--line)', boxShadow: 'inset 0 1px 2px rgba(0,0,0,.08)', fontWeight: 700 }}>
                    <tr>
                      <td colSpan={5}>Totals</td>
                      <td style={{ textAlign: 'right' }} className="mono num">{money(sum(blindGrid, 'gross_amount'))}</td>
                      <td />
                      <td style={{ textAlign: 'right' }} className="mono num">{money(sum(blindGrid, 'discount_amount'))}</td>
                      <td style={{ textAlign: 'right' }} className="mono num">{money(sum(blindGrid, 'net_amount'))}</td>
                      <td />
                      <td style={{ textAlign: 'right' }} className="mono num">{money(sum(blindGrid, 'tax_amount'))}</td>
                      <td style={{ textAlign: 'right' }} className="mono num">{money(sum(blindGrid, 'line_total'))}</td>
                      <td colSpan={2} />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>

            <div className="text-sm text-mute" style={{ marginTop: 10 }}>
              Vendor identities and codes are withheld while you review blind. You are confirming the
              awarded rates, taxes and delivery terms are acceptable — not which supplier won.
            </div>

            {/* ── DYNAMIC ACTION BAR ───────────────────────────────────────────
                Confirm and Revert are mutually exclusive by construction: a
                reviewer cannot simultaneously accept the statement and ask for
                a line to be renegotiated. The disabled button is labelled with
                WHY it is disabled, because a greyed-out control with no
                explanation reads as a broken screen. */}
            <div className="btn-row" style={{ marginTop: 14, alignItems: 'center' }}>
              {flagged.length === 0 ? (
                <>
                  <button className="btn primary" disabled={rvBusy !== null || !rv?.actions?.can_confirm}
                    style={{ background: '#16a34a', borderColor: '#16a34a' }}
                    onClick={() => reviewAction('confirm', 'confirm')}>
                    {rvBusy === 'confirm' ? 'Confirming…' : 'Confirm Comparative Statement'}
                  </button>
                  <button className="btn" disabled title="Flag a line 🟠 to request negotiation.">
                    Revert for Negotiation
                  </button>
                </>
              ) : (
                <>
                  <button className="btn primary" disabled
                    title="Resolve every flagged line first.">
                    Confirm Comparative Statement
                  </button>
                  <button
                    className="btn"
                    disabled={rvBusy !== null || !rv?.actions?.can_revert_soft || flagged.some((l) => !String(negotiateNote[l.line_no] ?? '').trim())}
                    style={{ background: '#f59e0b', borderColor: '#f59e0b', color: '#fff' }}
                    onClick={() => reviewAction(
                      'revert-soft', 'revert',
                      {
                        reason: `Blind commercial review: negotiation required on ${flagged.length} line(s) — `
                          + flagged.map((l) => `#${l.line_no}`).join(', '),
                        revertLines: flagged.map((l) => ({
                          lineNo: l.line_no,
                          decision: 'NEGOTIATE',
                          targetRemarks: String(negotiateNote[l.line_no] ?? '').trim(),
                        })),
                      },
                    )}>
                    {rvBusy === 'revert'
                      ? 'Reverting…'
                      : `Revert ${flagged.length} Line${flagged.length === 1 ? '' : 's'} for Negotiation`}
                  </button>
                </>
              )}
              <span className="text-sm text-mute" style={{ alignSelf: 'center' }}>
                {flagged.length === 0
                  ? 'All lines accepted.'
                  : `${flagged.length} line${flagged.length === 1 ? '' : 's'} flagged for negotiation.`}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Tabs are rendered ONLY when the matrix is switched on — and NEVER during a
          blind review. The Matrix Form tab fetches /cs/:id/matrix, a DIFFERENT
          payload from this screen's own, so leaving the tab on the page meant a
          blind reviewer could open the full multi-vendor comparison behind a
          banner claiming the detail was withheld. The API now masks that
          endpoint too; hiding the tab as well is what keeps a masked payload
          from being rendered at all. */}
      {matrixOn && !blindMode && (
        <div style={{ display: 'flex', gap: 8, borderBottom: '2px solid var(--border)', marginBottom: 20 }}>
          <button
            className={`btn ${tab === 'summary' ? 'primary' : 'ghost'}`}
            onClick={() => setTab('summary')}
            style={{ borderRadius: '8px 8px 0 0' }}
          >
            Summary Form
          </button>
          <button
            className={`btn ${tab === 'matrix' ? 'primary' : 'ghost'}`}
            onClick={() => setTab('matrix')}
            style={{ borderRadius: '8px 8px 0 0' }}
          >
            Matrix Form
          </button>
        </div>
      )}

      {(tab === 'summary' || !matrixOn) && !blindMode && (
      <>
      <div className="card mb-4">
        <div className="card-h">
          <h3>Bid comparison</h3>
          <span className="meta">
            {/* For a blind reviewer the row COUNT is shown but never the
                identities. Rendering "0 quotes" would be a different and false
                statement — quotes exist, this viewer simply may not see them. */}
            {d?.masked_for_viewer
              ? `${lines.length} vendor${lines.length === 1 ? '' : 's'} compared · withheld`
              : (
                <>
                  {lines.length} quote{lines.length === 1 ? '' : 's'} &middot;{' '}
                  {winner ? `Winner: ${winner.vendor_name}` : '—'}
                </>
              )}
          </span>
        </div>

        {/* A masked payload is not an empty one. The table is still rendered,
            with the commercial cells visibly withheld, so the reviewer can see
            that a comparison exists and how large it is. */}
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
              {lines.map((l, i) => (
                // A masked row has a null vendor_id, so keying on it alone gives
                // every masked row the same React key. Fall back to the index.
                <tr key={l.vendor_id ?? `masked-${i}`} className={l.is_winner ? 'winner' : undefined}>
                  <td>
                    <b>{l.vendor_name}</b>
                    {l.is_winner && <span className="pill approved" style={{ marginLeft: 6 }}>Winner</span>}
                    <div className="text-sm text-mute">{l.vendor_code}</div>
                  </td>
                  {/* A withheld value is not the same as a missing one, and not
                      the same as a zero. All three render differently so the
                      reviewer cannot read a redaction as a finding. */}
                  {l.is_masked ? (
                    <>
                      <td style={{ textAlign: 'right' }} className="text-mute">&mdash;</td>
                      <td className="text-mute">&mdash;</td>
                      <td className="text-mute">&mdash;</td>
                      <td style={{ textAlign: 'center' }} className="text-mute">&mdash;</td>
                      <td style={{ textAlign: 'right' }} className="text-mute">&mdash;</td>
                      <td style={{ textAlign: 'right' }} className="text-mute">&mdash;</td>
                      <td style={{ textAlign: 'right' }} className="text-mute">&mdash;</td>
                      <td style={{ textAlign: 'right' }} className="text-mute">&mdash;</td>
                      <td style={{ textAlign: 'center' }} className="text-mute">&mdash;</td>
                    </>
                  ) : (
                    <>
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
                  <td style={{ textAlign: 'right' }} className="mono num">
                    {l.warranty_score}
                    {/* A 0 here means one of two very different things, and a bare
                        number cannot tell them apart: the vendor stated no
                        warranty, OR the system never captured one it was given.
                        The scorer records which dimensions were missing; showing
                        that is what stops a real warranty reading as silence. */}
                    {(l.missing || []).includes('warranty') && (
                      <div className="text-sm text-mute" style={{ textAlign: 'right' }}>
                        not stated
                      </div>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}><b className="mono num">{l.weighted_score}</b></td>
                  <td style={{ textAlign: 'center' }}>
                    <span className={`pill ${l.rank === 1 ? 'approved' : 'draft'}`}>{l.rank}</span>
                  </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* The split award IS the decision, so it is withheld along with everything
          else — a blind reviewer who could read it would know the outcome.
          The API already sends `split: null` for a masked payload; this guard
          is the UI agreeing with that rather than a second source of truth. */}
      {splitAward && !d?.masked_for_viewer && (
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
          API reports `ready`, so the UI does not re-derive the stage.

          While a review is in force the server sets `ready: false` AND refuses
          the lock, so this card disappearing is not merely cosmetic — the
          review panel below says where the statement has to go instead. A
          statement that merely left review (reverted) keeps the card. */}
      {!d?.review_in_progress && d?.ready && !d?.masked_for_viewer && lines.length > 0 && (
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
      </>
      )}

      {matrixOn && tab === 'matrix' && cs && !blindMode && (
        <CsMatrix csId={cs.id} canAward={canAward} />
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
