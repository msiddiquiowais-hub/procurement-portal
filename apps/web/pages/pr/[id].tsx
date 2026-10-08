// `light-pr-detail` — Purchase Request detail.
//
// Port of renderLightPRDetail (prototype line 2930). Structure preserved:
// header row -> main card (id + stage pill + requester/department/date,
// 10-step timeline, the 6-cell pr-form-grid, justification, contextual
// banners, stage action buttons) -> line-decision card -> status history.
//
// The prototype's three trailing cards are _lightProcurementCard (RFQ/quotes),
// _lightRosterCard (vendor roster) and lightEmailLogHtml. The first two are
// live as of Wave 2 step 5, fed by one GET /pr/:id/sourcing call — see
// components/sourcing/SourcingCards.tsx. lightEmailLogHtml still reads the
// notification outbox, which is not built yet, so it remains absent rather
// than faked.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { useSession } from '../../lib/session';
import { api } from '../../lib/api';
import Shell from '../../components/Shell';
import { StagePill, DeptChip, pkr, fmtDate, fmtDateTime, stageLabel, stageOwner } from '../../lib/ui';
import { ProcurementCard, RosterCard, type Sourcing } from '../../components/sourcing/SourcingCards';
import { roleAllowed, canSeeScreen } from '@procurement/roles';

/** GET /pr/:id/rfq/candidates — the roster Issue RFQ would send to. */
type RfqCandidates = {
  pr_id: string;
  pr_number: string;
  already_issued: boolean;
  rfq_id: string | null;
  rfq_number: string | null;
  categories: Array<{ code: string; name: string; lineNos: number[] }>;
  vendors: Array<{
    id: string; vendor_code: string; legal_name: string; state: string; categories: string[];
    risk_grade: string | null; risk_score: number | null;
    exclusion_reason: string | null;
  }>;
  /**
   * Matched to this PR's categories but NOT invitable — high risk, on hold,
   * blacklisted, or in a non-invitable lifecycle state. Rendered as disabled,
   * unchecked rows with the reason attached, so "why isn't my vendor here" is
   * answered on the screen instead of leaving the buyer to infer it.
   */
  withheld: Array<{
    id: string; vendor_code: string; legal_name: string; state: string; categories: string[];
    risk_grade: string | null; risk_score: number | null;
    exclusion_reason: string | null;
  }>;
  shortfall: number;
  suggested_deadline: string;
  warnings: string[];
};

/**
 * Why a matched vendor is not on the roster, in the buyer's language.
 *
 * The wording deliberately mirrors the refusal `insertInvitation()` already
 * returns ("blocked pending remediation ... composite risk is High (N/100)"), so
 * the modal and a later manual invite never describe the same block two ways.
 * A TypeScript copy is acceptable here because this is PRESENTATION of a reason
 * the API already computed — `core.fn_vendor_composite()` remains the only
 * thing that decides the band, so there is no second scoring model to drift.
 */
const EXCLUSION_LABEL: Record<string, (v: RfqCandidates['withheld'][number]) => string> = {
  risk_blocked: v =>
    `High risk — blocked pending remediation (composite ${v.risk_score ?? '?'}/100). ` +
    'Cannot be invited until the risk assessment improves.',
  held: () => 'On hold — cannot be invited while the hold is in place.',
  blacklisted: () => 'Blacklisted — an unresolved blacklist entry blocks invitation.',
  vendor_state: v => `Lifecycle state “${v.state}” is not an invitable state.`,
};

type Line = {
  id: string; line_no: number; item_code: string; item_name: string;
  description: string | null; quantity: number; uom: string;
  unit_price_est: number; resolved_category: string;
  approved: boolean; rejected: boolean; held: boolean; rejected_reason: string | null;
};

type Dept = { department_id: string; department_name: string; hod_name: string | null; hod_status: string };type Child = { id: string; pr_number: string; status: string; estimated_amount: number; title: string | null };
type Image = { id: string; mime_type: string; size_bytes: number; sort_order: number; file_id: string };

type Pr = {
  id: string; pr_number: string; title: string | null; description: string | null;
  status: string; estimated_amount: number; expense_type: string; urgency: string;
  required_by_date: string; scope: string; purpose: string | null; routing_key: string;
  warehouse_check_required: boolean; warehouse_decision: string | null;
  parent_pr_id: string | null;
  requester_name: string; department_name: string; cost_center_code: string;
  created_at: string; last_updated_at: string;
  split: any; lines: Line[]; departments: Dept[]; children: Child[]; images: Image[];
};

type HistEvent = { ts: string; action: string; actor: string; from_stage: string | null; to_stage: string | null };

/**
 * Per-line HOD disposition. Mirrors the prototype's
 * `pr.hodLineDecisions` (_lightEnsureLineDecisions) — an undecided line is
 * 'pending', not 'approved'.
 */
type Disp = 'approved' | 'rejected' | 'held';
const DISP_LABEL: Record<Disp, string> = { approved: 'Approve', rejected: 'Reject', held: 'Hold' };

/**
 * Whole-PR outcome from the most conservative line decision:
 * rejected > held > pending > approved. Port of _lightLineDecisionSummary
 * (prototype line 3143) — the prototype treats any pending line as blocking
 * approval, which is what the Apply button's disabled gate keys off.
 */
function lineDecisionSummary(
  disp: Record<number, Disp>,
  lineCount: number,
): { approved: number; held: number; rejected: number; pending: number; total: number; outcome: string } {
  let approved = 0, held = 0, rejected = 0, pending = 0;
  for (let i = 0; i < lineCount; i++) {
    const d = disp[i];
    if (d === 'approved') approved++;
    else if (d === 'held') held++;
    else if (d === 'rejected') rejected++;
    else pending++;
  }
  const outcome = rejected > 0 ? 'rejected' : held > 0 ? 'held' : pending > 0 ? 'pending' : 'approved';
  return { approved, held, rejected, pending, total: lineCount, outcome };
}

// The prototype's 10-step progress order.
const TIMELINE = [
  'Submitted', 'IN_HOD_REVIEW', 'IN_WAREHOUSE_CHECK', 'IN_PROCUREMENT_REVIEW',
  'IN_COST_CENTER_APPROVAL', 'IN_FINANCE_REVIEW', 'IN_MANAGEMENT_REVIEW',
  'READY_FOR_D365', 'D365_PUSHED', 'CLOSED',
];

// Stage -> roles that get an action bar here. Mirrors the prototype's
// actionButtons blocks; only the actions whose endpoints exist are rendered.
const STAGE_ACTIONS: Record<string, string[]> = {
  // The prototype's HOD gate: `stage === 'IN_HOD_REVIEW' && role === 'hod'`
  // (PROCUREMENT_PORTAL_PROTOTYPE.html, lightActionButtons). A PR lands here on
  // submit via the auto-route, so this is the stage the department HOD acts on.
  IN_HOD_REVIEW: ['hod'],
  // On hold, the HOD still owns the release decision (prototype lightOnHold
  // resumes the PR from ON_HOLD back to IN_HOD_REVIEW). Without this the PR
  // would sit on hold with no actor able to release it.
  ON_HOLD: ['hod'],
  IN_IT_REVIEW: ['it_manager'],
  IN_WAREHOUSE: ['store_incharge', 'warehouse_manager'],
  IN_WAREHOUSE_CHECK: ['warehouse_manager'],
  IN_PROCUREMENT_REVIEW: ['procurement'],
  IN_COST_CENTER_APPROVAL: ['hod', 'cost_center_owner'],
  IN_FINANCE_REVIEW: ['finance', 'cfo'],
  IN_MANAGEMENT_REVIEW: ['management'],
  READY_FOR_D365: ['procurement'],
};

export default function PrDetail() {
  const { session, ready } = useSession();
  const router = useRouter();
  const { id } = router.query;

  const [pr, setPr] = useState<Pr | null>(null);
  const [hist, setHist] = useState<HistEvent[]>([]);
  const [src, setSrc] = useState<Sourcing | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /**
   * The management gate threshold is ADMIN-EDITABLE (Part 7), so this screen
   * must not import the DEFAULT_MANAGEMENT_THRESHOLD constant — doing so made
   * the displayed gate disagree with the threshold the engine actually applied.
   * Read it from the config API instead; a failure leaves the gate shown as
   * "unknown" rather than silently falling back to a stale number.
   */
  const [threshold, setThreshold] = useState<number | null>(null);

  // -- HOD per-line decisions (prototype _lightEnsureLineDecisions) ----------
  const [disp, setDisp] = useState<Record<number, Disp>>({});
  const [actBusy, setActBusy] = useState(false);
  const [actErr, setActErr] = useState<string | null>(null);
  const [actMsg, setActMsg] = useState<string | null>(null);

  // -- Issue RFQ (prototype lightProcIssueRFQ) --------------------------------
  // The RFQ modal, its candidate roster and the send itself. Kept as one block
  // because the candidate list, the selection and the result message are only
  // meaningful together — splitting them across the component invited exactly
  // the "preview disagrees with what is sent" failure this flow is built to
  // avoid (both come from the server's categoryPool).
  //
  // THESE MUST STAY ABOVE THE EARLY RETURNS. This block originally sat down
  // beside the send handlers, i.e. below `if (!pr) return null;`. The loading
  // render then called 9 hooks and the loaded render 14, React threw
  // "Rendered more hooks than during the previous render", and EVERY /pr/:id
  // unmounted with a black "Application error" screen — the whole PR list was
  // unreachable, not just the RFQ button. Moving them up is the fix;
  // tests/hooks-order.test.tsx is what keeps them there.
  const [rfqOpen, setRfqOpen] = useState(false);
  const [rfqBusy, setRfqBusy] = useState(false);
  const [rfqErr, setRfqErr] = useState<string | null>(null);
  const [cands, setCands] = useState<RfqCandidates | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [rfqDeadline, setRfqDeadline] = useState('');

  const load = useCallback(() => {
    if (!id || Array.isArray(id)) return;
    api.get<Pr>(`/pr/${id}`).then(r => {
      setPr(r.data);
      // Seed per-line decisions from what is already persisted, so a reload (or
      // a revisit) shows the decisions this HOD made rather than resetting them
      // to pending. A line with no stored decision stays undecided, which is
      // what keeps the Apply button disabled.
      const seeded: Record<number, Disp> = {};
      (r.data.lines || []).forEach((l, i) => {
        if (l.rejected) seeded[i] = 'rejected';
        else if (l.held) seeded[i] = 'held';
        else if (l.approved) seeded[i] = 'approved';
      });
      setDisp(seeded);
    }).catch(e => setErr(e.message));
    api.get<{ events: HistEvent[] }>(`/pr/${id}/history`)
      .then(r => setHist(r.data.events || []))
      .catch(() => setHist([]));
    // One call for BOTH sourcing cards — the prototype reads the same
    // pr.procurement object from each, so there is nothing to fetch twice.
    // A sourcing failure must not take down the PR page, hence the silent
    // catch: the cards simply do not render.
    api.get<Sourcing>(`/pr/${id}/sourcing`)
      .then(r => setSrc(r.data))
      .catch(() => setSrc(null));
    // The gate threshold lives in the workflow config, not in this PR row.
    api.get<{ managementThreshold: number }>('/workflow/threshold')
      .then(r => setThreshold(Number(r.data.managementThreshold)))
      .catch(() => setThreshold(null));
  }, [id]);

  useEffect(() => {
    if (!ready) return;                 // session not read from storage yet
    if (!session) { router.replace('/'); return; }
    load();
  }, [ready, session, load]);

  // MUST sit above every early return below. This component returns early while
  // `pr` is still loading, so a hook placed after those returns would be called
  // on some renders and not others — React throws "Rendered more hooks than
  // during the previous render" and the whole page dies with the black
  // "Application error" screen. The count has to be constant across renders.
  const lineSum = useMemo(
    () => lineDecisionSummary(disp, pr?.lines?.length ?? 0),
    [disp, pr?.lines?.length],
  );

  if (!ready) return null;
  if (!session) return null;

  if (!pr && !err) {
    return <Shell title="Purchase Request" screenId="light-pr-detail">
      <div className="card"><div className="card-b empty-state">Loading…</div></div>
    </Shell>;
  }
  if (err && !pr) {
    return <Shell title="Purchase Request" screenId="light-pr-detail">
      <div className="card"><div className="card-b empty-state">{err}</div></div>
    </Shell>;
  }
  if (!pr) return null;

  const role = session.user.role;
  const curIdx = TIMELINE.indexOf(pr.status);
  const amt = Number(pr.estimated_amount || 0);
  // `>` matches the engine's aboveMgtThreshold predicate on the `finance_review`
  // step: a PR must be STRICTLY above the global threshold to clear Management.
  // This previously read `>=` to match `amountGTE`, and would have disagreed with
  // the engine for a PR of exactly the threshold — the screen would show the
  // Management gate while the engine routed the PR straight to CFO release.
  const needsMgt = threshold === null ? null : amt > threshold;
  const splitMeta = typeof pr.split === 'string'
    ? (() => { try { return JSON.parse(pr.split); } catch { return null; } })()
    : pr.split;
  const allowedActors = STAGE_ACTIONS[pr.status] || [];
  // roleAllowed(), not Array.includes(): the API expands the `admin` super-role
  // through ROLE_ALIASES, so a raw includes() hid the action bar from an admin
  // session even though POST /pr/:id/advance would have accepted the call. The
  // roles package exists so the two sides cannot disagree; this page was the one
  // place that bypassed it.
  const canAct = allowedActors.length > 0 && roleAllowed(role, allowedActors.join(','));
  // Can this role actually OPEN /pr/review/[id]? That page guards itself with
  // canSeeScreen(role,'pr-review') and router.replace('/pr') when denied — so a
  // link to it is a dead end that looks like the page reloaded. `pr-review` is
  // HOD-only in the prototype (PROCUREMENT_PORTAL_PROTOTYPE.html:624
  // data-roles="hod"), which is why `canAct` is NOT the same question: a
  // procurement officer owns IN_PROCUREMENT_REVIEW and so passes canAct, then
  // gets bounced off the review screen. Gate the link on the TARGET's gate.
  const canSeeReview = canSeeScreen(role, 'pr-review');
  // Does this PR already carry an RFQ? Asked of the SERVER's sourcing payload,
  // not recomputed here: RfqService.issue() refuses a second RFQ on a PR, so a
  // locally-derived answer could offer a button whose only outcome is a 400.
  const hasRfq = Boolean(src?.procurement?.rfq);
  const isClosed = ['D365_PUSHED', 'CLOSED', 'FULFILLED_FROM_STOCK', 'REJECTED'].includes(pr.status);

  // -- the four HOD actions (prototype lightHodApprove / lightHodRevertForRevision
  // / lightReject / lightOnHold, all posting through one advance endpoint here) --
  // Prototype line 2957: Apply stays DISABLED while any line is undecided;
  // Reject and Hold are meta actions that never depend on line decisions.
  // (`lineSum` itself is the useMemo hoisted above the early returns.)
  const lineGateDisabled = lineSum.outcome === 'pending';
  const isHodStage = pr.status === 'IN_HOD_REVIEW';

  async function advance(decision: Record<string, unknown>, successMsg: string) {
    setActBusy(true); setActErr(null); setActMsg(null);
    try {
      const r = await api.post<any>(`/pr/${pr.id}/advance`, decision);
      const advanced = r.data?.nextStage
        ? `Advanced to ${r.data.nextStage}${r.data.lineRoutingApplied ? ' (line routing applied)' : ''}.`
        : `Split into ${r.data?.children?.length ?? 0} child PRs.`;
      setActMsg(`${successMsg} ${advanced}`);
      load();
    } catch (e: any) {
      setActErr(e.message || 'Action failed');
    } finally {
      setActBusy(false);
    }
  }

  /**
   * Hold / Revert — POST /pr/:id/hold rather than /advance.
   *
   * The prototype reaches ON_HOLD with a direct `lightTransition` (lines 3486,
   * 3662, 6603), and ON_HOLD is the target of no step in the routing table, so
   * there is no Decision flag that would route it. This mirrors that.
   */
  async function sendToHold(reason: string, resume: boolean) {
    setActBusy(true); setActErr(null); setActMsg(null);
    try {
      const r = await api.post<any>(`/pr/${pr.id}/hold`, { reason, resume });
      setActMsg(resume
        ? `Resumed from hold — back to ${r.data?.nextStage}.`
        : 'Sent back to the requester for revision.');
      load();
    } catch (e: any) {
      setActErr(e.message || 'Action failed');
    } finally {
      setActBusy(false);
    }
  }

  /** Apply line decisions — the prototype's `lightHodApprove`. */
  const applyDecisions = () => advance(
    { lineDecisions: disp, reason: 'HOD applied line decisions' },
    `Applied decisions for ${lineSum.total} line(s).`,
  );

  /** Open the modal and ask the API what it WOULD send. Read-only. */
  async function openRfq() {
    if (!pr) return;
    setRfqOpen(true); setRfqBusy(true); setRfqErr(null);
    try {
      const r = await api.get<RfqCandidates>(`/pr/${pr.id}/rfq/candidates`);
      setCands(r.data);
      setPicked((r.data.vendors || []).map(v => v.id));
      setRfqDeadline(r.data.suggested_deadline || '');
    } catch (e: any) {
      setRfqErr(e.message || 'Could not load the vendor list.');
    } finally {
      setRfqBusy(false);
    }
  }

  /**
   * One click = issue AND send.
   *
   * Two calls, deliberately. `POST /pr/:id/rfq` creates the RFQ, snapshots the
   * PR lines onto it and mints an invitation token per vendor; `POST /rfq/:id/
   * dispatch` is what writes core.email_outbox and the .eml files. The prototype
   * has one "Send RFQ" button that did both, so the button does both — but if
   * dispatch fails the RFQ still exists and the outcome says so, rather than
   * pretending nothing happened. That is also why this is NOT one backend
   * transaction: an emailed invitation cannot be rolled back.
   */
  async function sendRfq() {
    if (!pr) return;
    if (picked.length === 0) { setRfqErr('Select at least one vendor before sending.'); return; }
    setRfqBusy(true); setRfqErr(null);
    try {
      const issued = await api.post<any>(`/pr/${pr.id}/rfq`, {
        vendorIds: picked,
        deadlineAt: rfqDeadline || undefined,
      });
      const rfqId = issued.data?.rfq?.id;
      const to = issued.data?.invitations?.length ?? picked.length;
      if (!rfqId) {
        setActMsg(`RFQ ${issued.data?.rfq?.rfq_number ?? ''} issued to ${to} vendor(s).`);
        setRfqOpen(false); load();
        return;
      }
      let sentMsg = `RFQ ${issued.data.rfq.rfq_number} issued to ${to} vendor(s).`;
      try {
        const d = await api.post<any>(`/rfq/${rfqId}/dispatch`, { channel: 'email' });
        sentMsg += ` Queued ${d.data?.queued ?? 0} message(s) in the outbox.`;
      } catch (de: any) {
        // The RFQ exists and the invitations exist. Say exactly that, and say
        // the emails did not go out, rather than reporting a clean success.
        sentMsg += ` But the emails did NOT go out (${de.message}). ` +
          'Open the RFQ and dispatch again.';
      }
      setActMsg(sentMsg);
      setRfqOpen(false);
      load();
    } catch (e: any) {
      setRfqErr(e.message || 'Could not issue the RFQ.');
    } finally {
      setRfqBusy(false);
    }
  }

  /** Revert for revision — `lightHodRevertForRevision`. The prototype transitions
   *  to ON_HOLD (line 3662), NOT to procurement: LIGHT_STAGE_OWNER marks ON_HOLD
   *  as owner:'requester', so the requester edits and resubmits and the same PR
   *  id flips back to IN_HOD_REVIEW. Routing to procurement would skip the one
   *  party who can actually make the change. Remarks are REQUIRED, as the
   *  prototype's modal enforces. */
  const revertForRevision = () => {
    const remarks = window.prompt(
      'Remarks for requester (required) — tell them exactly what to fix or add:',
      'Please review and update this request.',
    ) || '';
    if (!remarks.trim()) { setActErr('Remarks are required to revert a PR.'); return; }
    sendToHold(`Reverted for revision by HOD: ${remarks.trim()}`, false);
  };

  /** Reject — `lightReject`. The prototype demands a reason; so does this. */
  const rejectPr = () => {
    const reason = window.prompt('Reason for rejection (required):', 'Not aligned with procurement policy.') || '';
    if (!reason.trim()) { setActErr('Rejection requires a reason.'); return; }
    advance({ lineRejected: true, reason: reason.trim() }, 'Rejected.');
  };

  /** Hold — `lightOnHold`. Toggles: hold (reason required, prototype line 6600),
   *  then resume back to IN_HOD_REVIEW (prototype line 6589). */
  const toggleHold = () => {
    if (onHold) { sendToHold('Resumed from hold by HOD', true); return; }
    const reason = window.prompt(
      'Reason for hold (required):',
      'Waiting for more information from requester.',
    ) || '';
    if (!reason.trim()) { setActErr('Hold requires a reason.'); return; }
    sendToHold(reason.trim(), false);
  };
  const onHold = pr.status === 'ON_HOLD';
  // While a PR is on hold the prototype shows the HOD a Resume control, and it
  // treats an ON_HOLD PR as the REQUESTER's item (prototype line 2939:
  // `if(stage === 'ON_HOLD' && pr.revertForRevision) ownerRole = 'requester'`).
  // Our Hold button is a toggle, so the HOD keeps acting at ON_HOLD — otherwise
  // the PR would be stranded with nobody able to release it.
  const canHoldAct = canAct && (isHodStage || onHold);

  return (
    <>
    <Shell title={pr.title || 'Purchase Request'} screenId="light-pr-detail"
      subtitle={`${pr.pr_number} · ${pr.department_name} · raised by ${pr.requester_name}`}>

      {/* header row */}
      <div className="btn-row" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>
        <Link href="/pr/new" className="btn ghost sm">+ New request</Link>
        <span className="text-sm text-mute">Lightweight Purchase Request</span>
      </div>

      {/* -- main card -------------------------------------------------- */}
      <div className="card">
        <div className="card-h">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h3 className="mono">{pr.pr_number}</h3>
            <StagePill stage={pr.status} />
            {pr.parent_pr_id && <span className="split-flag">SPLIT CHILD</span>}
            {splitMeta?.children?.length > 0 && <span className="split-flag">SPLIT PARENT</span>}
            <span className="text-sm text-mute" style={{ marginLeft: 'auto' }}>
              {pr.requester_name} · {pr.department_name} · {fmtDate(pr.created_at)}
            </span>
          </div>
        </div>
        <div className="card-b">
          {/* 10-step timeline */}
          <div className="timeline-steps">
            {TIMELINE.map((s, i) => {
              const passed = (curIdx >= 0 && i <= curIdx)
                || (pr.status === 'REJECTED' && curIdx < 0);
              return (
                <span key={s} className={passed ? 'pill pr pr-d365' : 'pill'}>
                  {i + 1}. {stageLabel(s)}
                </span>
              );
            })}
          </div>

          <div className="pr-form-grid">
            <div>
              <div className="text-sm text-mute">Item</div>
              <div><b>{pr.title || pr.description || '—'}</b></div>
            </div>
            <div>
              <div className="text-sm text-mute">Qty</div>
              <div>
                {pr.lines.length} {pr.lines.length === 1 ? (pr.lines[0]?.uom || 'unit') : 'lines'}
              </div>
            </div>
            <div>
              <div className="text-sm text-mute">Estimated amount</div>
              <div><b>{amt > 0 ? pkr(amt) : <span className="text-mute">not set yet</span>}</b></div>
            </div>
            <div>
              <div className="text-sm text-mute">Mgmt threshold</div>
              <div>{threshold === null ? <span className="text-mute">unavailable</span> : pkr(threshold)}</div>
            </div>
            <div>
              <div className="text-sm text-mute">HOD</div>
              <div>
                {pr.departments?.[0]?.hod_name
                  || <span className="text-mute">no HOD seeded for {pr.cost_center_code}</span>}
              </div>
            </div>
            <div>
              <div className="text-sm text-mute">Management gate</div>
              <div>
                {needsMgt === null
                  ? <span className="text-mute">unknown &mdash; threshold unavailable</span>
                  : needsMgt
                    ? <span className="pill pr pr-mgt">REQUIRED</span>
                    : <span className="text-mute">not needed</span>}
              </div>
            </div>
          </div>

          <div style={{ marginTop: 8 }}>
            <div className="text-sm text-mute">Justification</div>
            <div>{pr.description || pr.scope || '—'}</div>
          </div>

          {pr.purpose && (
            <div style={{ marginTop: 8 }}>
              <div className="text-sm text-mute">Purpose</div>
              <div>{pr.purpose}</div>
            </div>
          )}

          {/* -- contextual banners ----------------------------------- */}
          {pr.status === 'REJECTED' && (
            <div className="alert" style={{ marginTop: 10, background: '#FEE2E2', border: '1px solid #FCA5A5', color: '#991B1B' }}>
              <b>Rejected</b>. The PR did not pass its last review.
            </div>
          )}
          {pr.status === 'ON_HOLD' && (
            <div className="alert" style={{ marginTop: 10, background: '#FEF3C7', border: '1px solid #FDE68A', color: '#92400E' }}>
              <b>On hold</b> — awaiting a resume decision.
            </div>
          )}
          {pr.status === 'IN_WAREHOUSE_CHECK' && (
            <div className="alert" style={{ marginTop: 10, background: '#E0F2FE', border: '1px solid #BAE6FD', color: '#075985' }}>
              <b>Awaiting warehouse stock check.</b>{' '}
              {pr.warehouse_decision
                ? `Decision recorded: ${pr.warehouse_decision.replace(/_/g, ' ')}.`
                : 'No inventory decision recorded yet.'}
            </div>
          )}
          {pr.status === 'FULFILLED_FROM_STOCK' && (
            <div className="alert" style={{ marginTop: 10, background: '#D1FAE5', border: '1px solid #A7F3D0', color: '#065F46' }}>
              <b>Fulfilled from stock.</b> No purchase was raised.
            </div>
          )}

          {/* split lineage — the B1 payoff */}
          {splitMeta?.children?.length > 0 && (
            <div className="alert" style={{ marginTop: 10, background: '#F5F3FF', border: '1px solid #DDD6FE', color: '#5B21B6' }}>
              <b>Auto-split by line rules</b> — {splitMeta.reason}
              <div style={{ marginTop: 6 }}>
                {(splitMeta.children || []).map((c: any) => (
                  <div key={c.id}>
                    <Link href={`/pr/${c.id}`}><span className="mono">{c.prNumber}</span></Link>
                    {' ? '}{c.status} ({c.actorRole}, lines [{c.lines?.join(',')}], {pkr(c.totalAmount)})
                    <div className="text-sm" style={{ paddingLeft: 8 }}><i>{c.reason}</i></div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* -- action bar --------------------------------------------------- */}
          <div className="btn-row">
            {actErr && <span className="alert error" style={{ marginRight: 10 }}>{actErr}</span>}
            {actMsg && <span className="alert success" style={{ marginRight: 10 }}>{actMsg}</span>}

            {/* The prototype renders the HOD's four actions INLINE on this screen
                (prototype line 2951-2969). This page used to show a single
                "Review & act" link that navigated away to /pr/review/[id], which
                is a two-page split the prototype never had. Both pages stay —
                this one now carries the actions the prototype shows here. */}
            {canHoldAct && (              <>
                {/* On hold: only the resume control applies — the PR has left
                    HOD review, so the other three actions are not meaningful. */}
                {!onHold && <>
                <button
                  className="btn success sm"
                  disabled={lineGateDisabled || actBusy}
                  style={lineGateDisabled ? { opacity: .5, cursor: 'not-allowed' } : undefined}
                  title={lineGateDisabled
                    ? `Decide every line first (${lineSum.pending} of ${lineSum.total} pending)`
                    : 'Apply the per-line decisions you just made'}
                  onClick={applyDecisions}
                >
                  Apply line decisions
                </button>
                <button
                  className="btn ghost danger sm"
                  disabled={actBusy}
                  title="Send this PR back to the requester with remarks"
                  onClick={revertForRevision}
                >
                  <span style={{ display: 'inline-block', transform: 'translateY(-1px)', marginRight: 2 }}>&#8630;</span>
                  Revert for revision
                </button>
                <button className="btn danger sm" disabled={actBusy} onClick={rejectPr}>
                  Reject
                </button>
                <button className="btn sm" disabled={actBusy} onClick={toggleHold}>
                  Hold
                </button>
                </>}
                {/* Resume only makes sense while the PR is actually on hold; in
                    HOD review the Hold button above already covers both states. */}
                {onHold && (
                  <button className="btn primary sm" disabled={actBusy} onClick={toggleHold}>
                    Resume from hold
                  </button>
                )}
                {/* Wave 2 review page kept for the request summary / split view. */}
                <Link href={`/pr/review/${pr.id}`} className="btn ghost sm">
                  Open review view ?
                </Link>
              </>
            )}
            {canAct && !isHodStage && !onHold && (
              <>
                {/* Only rendered for a role that may OPEN the target. This link
                    used to hang off canAct alone, so procurement at
                    IN_PROCUREMENT_REVIEW got a button that navigated to
                    /pr/review/<id> and was immediately redirected back to /pr by
                    that page's own pr-review guard — the click looked like a
                    refresh. The Wave-2 note is the honest signal for the roles
                    that own a stage whose actions are not built yet. */}
                {canSeeReview && (
                  <Link href={`/pr/review/${pr.id}`} className="btn success sm">Review &amp; act</Link>
                )}
                {/* Issue RFQ — prototype lightProcIssueRFQ, gated exactly as
                    the prototype gates it: stage IN_PROCUREMENT_REVIEW (or
                    READY_FOR_D365) AND role 'procurement'. `canAct` already
                    encodes "owns this stage" via STAGE_ACTIONS, and both
                    sourcing stages map to ['procurement'], so reaching here IS
                    the prototype's condition.

                    The prototype only offers Issue RFQ while `!pr.procurement.rfq`
                    and swaps to Record quotes / Select winner once one exists —
                    those endpoints are not built, so once an RFQ is out the
                    button becomes a link to the RFQ rather than a control that
                    silently does nothing. `src.procurement.rfq` is the server's
                    own answer to "does this PR have an RFQ"; recomputing it here
                    is how the two sides would drift. */}
                {['IN_PROCUREMENT_REVIEW', 'READY_FOR_D365'].includes(pr.status) && (
                  hasRfq ? (
                    <Link href={`/rfq/${src?.procurement.rfq?.rfq_id}`} className="btn ghost sm">
                      Open RFQ {src?.procurement.rfq?.id}
                    </Link>
                  ) : (
                    <button className="btn primary sm" onClick={openRfq}>
                      <span style={{ display: 'inline-block', marginRight: 4 }}>&#8613;</span>
                      Issue RFQ
                    </button>
                  )
                )}
              </>
            )}
            {isClosed && (
              <button className="btn ghost sm" disabled style={{ opacity: .5 }}>
                Closed{pr.status === 'FULFILLED_FROM_STOCK' ? ' (fulfilled from stock)' : ''}
              </button>
            )}
            {!canAct && !isClosed && (
              <span className="text-sm text-mute" style={{ alignSelf: 'center' }}>
                Stage owner is <b>{stageOwner(pr.status) || 'system'}</b> — acting as {role}, this is read-only.
              </span>
            )}
          </div>
        </div>
      </div>

      {/* -- line decisions -------------------------------------------- */}
      <div className="card">
        <div className="card-h">
          <h3>{canAct && isHodStage ? 'Items & per-line decisions' : 'Line items'}</h3>
          <span className="meta">
            {canAct && isHodStage ? (
              <>
                {lineSum.approved} approved · {lineSum.held} held · {lineSum.rejected} rejected · {lineSum.pending} pending
                {' · '}
                <span className="pill">Outcome: {lineSum.outcome}</span>
              </>
            ) : (
              <>
                {pr.lines.filter(l => l.approved).length} approved ·{' '}
                {pr.lines.filter(l => l.rejected).length} rejected ·{' '}
                {pr.lines.filter(l => l.held).length} held
              </>
            )}
          </span>
        </div>

        {/* Bulk actions — prototype "Bulk action: Approve all / Hold all / Reject all / Reset" */}
        {canAct && isHodStage && pr.lines.length > 0 && (
          <div className="card-b" style={{ paddingBottom: 0 }}>
            <span className="text-sm text-mute" style={{ marginRight: 8 }}>Bulk action:</span>
            <button className="btn success sm" disabled={actBusy}
              onClick={() => setDisp(Object.fromEntries(pr.lines.map((_, i) => [i, 'approved' as Disp])))}>
              Approve all
            </button>{' '}
            <button className="btn sm" disabled={actBusy}
              onClick={() => setDisp(Object.fromEntries(pr.lines.map((_, i) => [i, 'held' as Disp])))}>
              Hold all
            </button>{' '}
            <button className="btn danger sm" disabled={actBusy}
              onClick={() => setDisp(Object.fromEntries(pr.lines.map((_, i) => [i, 'rejected' as Disp])))}>
              Reject all
            </button>{' '}
            <button className="btn ghost sm" disabled={actBusy} onClick={() => setDisp({})}>Reset</button>
          </div>
        )}

        <table className="t">
          <thead>
            <tr>
              <th>#</th><th>Item</th><th>Category</th><th>Qty</th>
              <th>Unit</th><th className="num">Amount</th>
              <th>{canAct && isHodStage ? 'Decision' : 'Disposition'}</th>
            </tr>
          </thead>
          <tbody>
            {pr.lines.map((l, idx) => (
              <tr key={l.id}>
                <td className="mono">{l.line_no}</td>
                <td>
                  <div className="row-title">{l.item_name}</div>
                  <div className="row-sub mono">{l.item_code}{l.description ? ` — ${l.description}` : ''}</div>
                </td>
                <td><span className="dept-chip">{l.resolved_category}</span></td>
                <td>{l.quantity} {l.uom}</td>
                <td className="mono num">{pkr(l.unit_price_est)}</td>
                <td className="mono num">{pkr(l.quantity * l.unit_price_est)}</td>
                {/* Live decision controls while the HOD is acting; the persisted
                    disposition otherwise. Prototype renders Approve/Hold/Reject
                    per row at this stage (lightSetLineDecision). */}
                {canAct && isHodStage ? (
                  <td>
                    <span style={{ display: 'inline-flex', gap: 6 }}>
                      {(['approved', 'held', 'rejected'] as Disp[]).map(d => (
                        <button
                          key={d}
                          className={`btn sm ${disp[idx] === d ? (d === 'approved' ? 'success' : d === 'rejected' ? 'danger' : 'primary') : 'ghost'}`}
                          disabled={actBusy}
                          onClick={() => setDisp((prev) => ({ ...prev, [idx]: d }))}
                        >
                          {DISP_LABEL[d]}
                        </button>
                      ))}
                    </span>
                  </td>
                ) : (
                <td>
                  <span className={`pill ${l.rejected ? 'danger' : l.held ? 'warn' : l.approved ? 'success' : ''}`}>
                    {l.rejected ? 'rejected' : l.held ? 'held' : l.approved ? 'approved' : 'pending'}
                  </span>
                  {l.rejected_reason && <div className="row-sub">{l.rejected_reason}</div>}
                </td>
                )}
              </tr>
            ))}
            {pr.lines.length === 0 && (
              <tr><td colSpan={7}><div className="empty-state">No lines on this PR.</div></td></tr>
            )}
          </tbody>
        </table>
        {canAct && canSeeReview && (
          <div className="card-b">
            <Link href={`/pr/review/${pr.id}`} className="btn primary sm">Open line review</Link>
          </div>
        )}
      </div>

      {/* -- departments ----------------------------------------------- */}
      {pr.departments?.length > 0 && (
        <div className="card">
          <div className="card-h"><h3>Departments</h3><span className="meta">{pr.departments.length}</span></div>
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
        </div>
      )}

      {/* -- reference images ------------------------------------------ */}
      {pr.images?.length > 0 && (
        <div className="card">
          <div className="card-h">
            <h3>Reference pictures</h3>
            <span className="meta">{pr.images.length} of max 3</span>
          </div>
          <div className="card-b">
            {pr.images.map(im => (
              <div key={im.id} className="row-sub">
                {im.mime_type} · {Math.round(im.size_bytes / 1024)} KB
              </div>
            ))}
          </div>
        </div>
      )}

      {/* -- sourcing cards (Wave 2) ------------------------------------- */}
      {/* Prototype: _lightProcurementCard + _lightRosterCard, both gated on
          IN_PROCUREMENT_REVIEW / READY_FOR_D365 (lines 6076, 6195). The gate
          is reported by the API rather than recomputed here. */}
      {src?.cards.procurement_card && <ProcurementCard s={src} />}
      {src?.cards.roster_card && <RosterCard s={src} />}

      {/* -- status history -------------------------------------------- */}
      <div className="card">
        <div className="card-h"><h3>Status history</h3><span className="meta">{hist.length} events</span></div>
        <div className="card-b" style={{ padding: 0 }}>
          {hist.length === 0 ? (
            <div className="card-b empty-state">No recorded transitions yet.</div>
          ) : (
            hist.map((e, i) => (
              <div key={i} className="queue-row" style={{ cursor: 'default' }}>
                {e.to_stage
                  ? <StagePill stage={e.to_stage} />
                  : <span className="pill">{e.action}</span>}
                <div style={{ flex: 1 }}>
                  <div className="row-title">
                    {e.from_stage && e.to_stage
                      ? `${stageLabel(e.from_stage)} ? ${stageLabel(e.to_stage)}`
                      : e.action}
                  </div>
                  <div className="row-sub">{e.actor} · {fmtDateTime(e.ts)}</div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* -- email audit trail placeholder ----------------------------- */}
      <div className="card">
        <div className="card-h"><h3>Email audit trail</h3><span className="meta">Wave 5</span></div>
        <div className="card-b empty-state">
          Notification outbox rendering lands with the notification screens.
        </div>
      </div>
    </Shell>

      {/* -- Issue RFQ modal ------------------------------------------- */}
      {/* Prototype: lightProcIssueRFQ's dialog (lines 5069-5235). Kept as an
          inline panel rather than a portal/modal component because this page
          has no modal primitive and the prototype's own overlay is plain markup.

          The difference that matters: the prototype opens with an EMPTY vendor
          list for the officer to pick from. Here the list arrives PRE-SELECTED
          from the PR's line categories, because vendors are mapped to categories
          in core.vendor_categories and that mapping — not a human's memory — is
          what decides who can quote. Every vendor can still be unticked, which
          is the prototype's control preserved. */}
      {rfqOpen && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60,
          }}
          onClick={e => { if (e.target === e.currentTarget && !rfqBusy) setRfqOpen(false); }}
        >
          <div className="card" style={{ width: 720, maxWidth: '92vw', maxHeight: '86vh', overflow: 'auto' }}>
            <div className="card-h">
              <h3>Issue RFQ — {pr?.pr_number}</h3>
              <button className="btn ghost sm" onClick={() => setRfqOpen(false)} disabled={rfqBusy}>
                Cancel
              </button>
            </div>
            <div className="card-b">
              {rfqErr && <div className="alert error" style={{ marginBottom: 12 }}>{rfqErr}</div>}

              {rfqBusy && !cands && <div className="empty-state">Resolving vendors by line category…</div>}

              {cands?.already_issued && (
                <div className="alert info">
                  This PR already has an open RFQ ({cands.rfq_number}). Close this and add
                  vendors from the RFQ screen — a PR carries one live RFQ at a time.
                </div>
              )}

              {cands && !cands.already_issued && (
                <>
                  {/* Why these vendors. The mapping is shown, not asserted, so a
                      wrong roster is visible before it is sent. */}
                  <div style={{ marginBottom: 14 }}>
                    <b>Line categories on this PR</b>
                    {cands.categories.length === 0 ? (
                      <div className="text-sm text-mute" style={{ marginTop: 4 }}>
                        No line carries a category, so there is nothing to match vendors against.
                      </div>
                    ) : (
                      <div className="text-sm text-mute" style={{ marginTop: 4 }}>
                        {cands.categories.map(c => (
                          <span key={c.code} className="pill" style={{ marginRight: 6 }}>
                            {c.name} — lines {c.lineNos.join(', ')}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div style={{ marginBottom: 14 }}>
                    <b>Vendors matched</b>{' '}
                    <span className="text-sm text-mute">
                      {picked.length} of {cands.vendors.length} selected
                      {cands.withheld?.length
                        ? ` · ${cands.withheld.length} withheld`
                        : ''}
                    </span>
                  </div>

                  {cands.vendors.length === 0 ? (
                    <div className="alert warn">
                      {cands.withheld?.length
                        ? `No eligible vendor is available: all ${cands.withheld.length} vendor(s) matched to this PR's categories are withheld (see below).`
                        : <>No eligible vendor is mapped to this PR&apos;s categories. Map one in
                          Vendor Master, or invite a vendor by hand from the RFQ screen.</>}
                    </div>
                  ) : (
                    <table className="t" style={{ marginBottom: 14 }}>
                      <thead>
                        <tr>
                          <th style={{ width: 34 }} />
                          <th>Vendor</th>
                          <th>Matched by</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cands.vendors.map(v => (
                          <tr key={v.id}>
                            <td>
                              <input
                                type="checkbox"
                                checked={picked.includes(v.id)}
                                disabled={rfqBusy}
                                onChange={e => setPicked(p =>
                                  e.target.checked ? [...p, v.id] : p.filter(x => x !== v.id))}
                                aria-label={`Invite ${v.legal_name}`}
                              />
                            </td>
                            <td>
                              <b>{v.legal_name}</b>{' '}
                              <span className="text-sm text-mute">{v.vendor_code}</span>
                            </td>
                            <td className="text-sm text-mute">{v.categories.join(', ')}</td>
                            <td><span className="pill">{v.state}</span></td>
                          </tr>
                        ))}

                        {/* WITHHELD VENDORS ARE SHOWN, NOT HIDDEN.
                            These matched this PR's categories — V-00085 is mapped to
                            IT_SOFTWARE and IT_SOFTWARE is line 3 here — and were dropped
                            by an eligibility rule. Hiding them produced a modal that said
                            "only 2 vendors are mapped", which sends the buyer to fix a
                            category mapping that is already correct. The box is rendered
                            UNCHECKED and disabled: it cannot be ticked, because
                            insertInvitation() would refuse it with a 400. A tickable box
                            that always fails is worse than a visible reason. */}
                        {cands.withheld?.map(v => (
                          <tr key={v.id} style={{ opacity: 0.62 }}>
                            <td>
                              <input
                                type="checkbox"
                                checked={false}
                                disabled
                                aria-label={`${v.legal_name} cannot be invited`}
                                title={EXCLUSION_LABEL[v.exclusion_reason ?? '']?.(v)}
                              />
                            </td>
                            <td>
                              <b>{v.legal_name}</b>{' '}
                              <span className="text-sm text-mute">{v.vendor_code}</span>
                            </td>
                            <td className="text-sm text-mute">{v.categories.join(', ')}</td>
                            <td>
                              <span className="pill danger">
                                {v.exclusion_reason === 'risk_blocked' && v.risk_score !== null
                                  ? `High risk · ${v.risk_score}/100`
                                  : v.exclusion_reason === 'held' ? 'On hold'
                                  : v.exclusion_reason === 'blacklisted' ? 'Blacklisted'
                                  : v.state}
                              </span>
                              <div className="text-sm text-mute" style={{ marginTop: 2 }}>
                                {EXCLUSION_LABEL[v.exclusion_reason ?? '']?.(v)
                                  ?? 'Not available for invitation.'}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  {/* Withheld-only case: the roster table is not rendered at all
                      above, so the exclusion rows would never be seen. */}
                  {cands.vendors.length === 0 && cands.withheld?.length > 0 && (
                    <table className="t" style={{ marginBottom: 14 }}>
                      <tbody>
                        {cands.withheld.map(v => (
                          <tr key={v.id} style={{ opacity: 0.62 }}>
                            <td>
                              <input type="checkbox" checked={false} disabled
                                aria-label={`${v.legal_name} cannot be invited`} />
                            </td>
                            <td>
                              <b>{v.legal_name}</b>{' '}
                              <span className="text-sm text-mute">{v.vendor_code}</span>
                            </td>
                            <td className="text-sm text-mute">{v.categories.join(', ')}</td>
                            <td>
                              <span className="pill danger">
                                {v.exclusion_reason === 'risk_blocked' && v.risk_score !== null
                                  ? `High risk · ${v.risk_score}/100`
                                  : v.exclusion_reason === 'held' ? 'On hold'
                                  : v.exclusion_reason === 'blacklisted' ? 'Blacklisted'
                                  : v.state}
                              </span>
                              <div className="text-sm text-mute" style={{ marginTop: 2 }}>
                                {EXCLUSION_LABEL[v.exclusion_reason ?? '']?.(v)
                                  ?? 'Not available for invitation.'}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}

                  {cands.warnings.map((w, i) => (
                    <div key={i} className="alert warn" style={{ marginBottom: 8 }}>{w}</div>
                  ))}

                  <label className="field" style={{ maxWidth: 260 }}>
                    <span className="lbl">Quote deadline</span>
                    <input
                      type="date"
                      value={rfqDeadline}
                      min={new Date().toISOString().slice(0, 10)}
                      onChange={e => setRfqDeadline(e.target.value)}
                      disabled={rfqBusy}
                    />
                  </label>

                  <div className="btn-row" style={{ marginTop: 14 }}>
                    <button
                      className="btn primary"
                      onClick={sendRfq}
                      disabled={rfqBusy || picked.length === 0}
                    >
                      {rfqBusy ? 'Sending…' : `Send RFQ to ${picked.length} vendor(s)`}
                    </button>
                    <button className="btn ghost" onClick={() => setRfqOpen(false)} disabled={rfqBusy}>
                      Cancel
                    </button>
                    {/* The dispatch service has no SMTP in this environment, so a
                        message is queued in core.email_outbox and written to
                        var/outbox as .eml. Saying so here is the point — the
                        button must not imply a vendor already received mail. */}
                    <span className="text-sm text-mute" style={{ alignSelf: 'center' }}>
                      Emails are queued in the outbox and written as .eml — no SMTP is
                      configured in this environment.
                    </span>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
