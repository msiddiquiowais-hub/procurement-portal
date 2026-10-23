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
import { StagePill, DeptChip, pkr, pkrOrDash, fmtDate, fmtDateTime, stageLabel, stageOwner, visibleItems, seesHeldLines, revertBlockedByRfq } from '../../lib/ui';
import { ProcurementCard, RosterCard, type Sourcing } from '../../components/sourcing/SourcingCards';
import ReceiveQuotationModal from '../../components/sourcing/ReceiveQuotationModal';
import { quotationRows } from '../../components/sourcing/quoteRows';
import { roleAllowed, canSeeScreen } from '@procurement/roles';
// The per-line Capex/Opex control. It imports CLASSIFICATIONS itself from
// @procurement/d365-client, so this screen no longer holds the vocabulary at
// all — there is no second list here to fall out of step with the panel.
import ClassificationCombobox from '../../components/ClassificationCombobox';

/** GET /pr/:id/rfq/candidates — the roster the shared Issue/Re-issue dialog
 *  would send. One endpoint, one dialog, two modes (`already_issued`). */
type RfqCandidates = {
  pr_id: string;
  pr_number: string;
  already_issued: boolean;
  rfq_id: string | null;
  rfq_number: string | null;
  /**
   * The re-issue event, as recorded on the RFQ. Not derivable from the roster:
   * after a top-up the invitation list is indistinguishable from a first issue
   * to more vendors.
   */
  reissue_count?: number;
  last_reissued_at?: string | null;
  /**
   * Vendors ALREADY on the RFQ, returned only when `already_issued`. The
   * prototype's `previouslySelected`, seeded into the re-issue dialog so the
   * officer can see who is already covered and only add what is missing.
   * Rendered ticked-and-disabled: re-inviting an existing vendor is a no-op
   * server-side, so a tickable box for one would be a control that lies.
   */
  current_vendors?: Array<{
    id: string; vendor_code: string; legal_name: string; state: string;
    invited_at: string | null; submitted: boolean; declined: boolean;
    already_invited: true;
  }>;
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
  /**
   * Line categories on this PR that no vendor can be reached through — either
   * nobody is mapped, or every mapped vendor is blocked from invitation.
   *
   * These are the lines that would ride onto the RFQ and never be quoted. On a
   * FIRST issue they block Send, and `issue()` refuses them server-side, so the
   * block survives a stale bundle or a hand-rolled request. On a RE-ISSUE the
   * RFQ already carries the line and adding vendors cannot remove it, so the
   * server reports it without enforcing — `blocking` says which case this is,
   * rather than leaving the page to re-derive the rule from array lengths.
   */
  unmapped_categories?: Array<{
    code: string; name: string; lineNos: number[]; mappedCount: number;
  }>;
  /**
   * PR lines that cannot ride an RFQ at all, and why — held by HOD review, or a
   * STORE_STOCK line with nothing left to buy.
   *
   * These are NOT in `categories`, by design: the server filters both lists with
   * the same predicate the write uses, so a chip here can never be a line that
   * then fails to appear on the RFQ. That agreement is the whole point — it was
   * broken on PR-2026-201649, where four held lines matched four vendors and the
   * modal offered to send an RFQ that could not be created.
   *
   * Shown when present so the buyer can see which lines are parked, and so an
   * empty roster is not misread as a vendor-mapping problem.
   */
  unquotable_lines?: Array<{
    line_no: number; reason: 'held' | 'no_pending_quantity'; detail: string | null;
  }>;
  /** The server's verdict on whether this mode BLOCKS. Never re-derived here. */
  blocking?: boolean;
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

/**
 * The awarded commercial terms for one line, once the RFQ has come back.
 *
 * Every field is nullable and that is deliberate. A vendor may quote tax-inclusive
 * and leave tax_percent NULL, or genuinely waive a discount and leave
 * discount_amount NULL. Those are different from zero and the UI marks an absent
 * figure absent rather than inventing one — substituting 0 for an unknown tax
 * prints a number nobody quoted.
 */
type Awarded = {
  rfq_line_no: number;
  awarded_qty: number | null;
  unit_price: number | null;
  gross_amount: number | null;
  discount_percent: number | null;
  discount_amount: number | null;
  net_amount: number | null;
  tax_percent: number | null;
  tax_amount: number | null;
  line_total: number | null;
};

type Line = {
  id: string; line_no: number; item_code: string; item_name: string;
  description: string | null; quantity: number; uom: string;
  /**
   * Nullable since this screen stopped lying about it: NULL means nobody has
   * stated a price, which is NOT the same as a price of zero. The API used to
   * coerce it with `Number(null)` and the table printed "PKR 0" for every
   * unpriced line.
   */
  unit_price_est: number | null;
  /**
   * Present only once the PR is cost-confirmed. The API omits the field entirely
   * before that, so absence here is a real absence rather than a hidden one.
   */
  awarded?: Awarded | null;
  resolved_category: string;
  approved: boolean; rejected: boolean; held: boolean; rejected_reason: string | null;
  /** Written by advance() alongside rejected_reason; NULL on lines held before it. */
  held_reason: string | null;
  /**
   * The per-line Capex/Opex class. NULL means nobody has classified the line,
   * which is NOT the same as "it is operating" — the CS exit refuses to let
   * the request leave step 5 while an approved line is unclassified, so a NULL
   * here is a pending decision rather than a default.
   */
  classification: string | null;
  /** Depreciation life for a capitalised line. Required for a CAPEX_* class. */
  useful_life_years: number | null;
  /** Who set the class, and when. */
  classified_at: string | null;
};

type Dept = { department_id: string; department_name: string; hod_name: string | null; hod_status: string };type Child = { id: string; pr_number: string; status: string; estimated_amount: number; title: string | null };
type Image = { id: string; mime_type: string; size_bytes: number; sort_order: number; file_id: string };

type Pr = {
  id: string; pr_number: string; title: string | null; description: string | null;
  status: string; estimated_amount: number | null; expense_type: string; urgency: string;
  /**
   * True once the PR has reached the cost boundary — the stage whose job is to
   * confirm cost. The API computes this from the same stage list it uses to
   * refuse an advance, so the awarded columns and the gate cannot disagree about
   * when the cost is settled.
   */
  cost_confirmed: boolean;
  required_by_date: string; scope: string; purpose: string | null; routing_key: string;
  /**
   * The split of the spend, by the per-line class. Both are 0 until the lines
   * are classified, and they are read from the LINES — the header's
   * `expense_type` is a single choice the requester made at creation and
   * cannot say what each line is.
   */
  capex_amount: number | null;
  opex_amount: number | null;
  amount_status: string | null;
  /**
   * WHO MAY WRITE THE PER-LINE CLASS, decided by the API.
   *
   * The server knows three things the browser cannot: whether the CS review
   * row is live, whether this request is at the `from` of a step carrying
   * requiresCapexOpex, and whether the viewer is HOD Procurement — an
   * identity read from `core.departments`, not a role, because every department
   * head signs in as `hod`. Returning the verdict means the card can never be
   * editable for someone the API would then refuse.
   */
  classification?: {
    can_write: boolean;
    can_set: boolean;
    can_correct: boolean;
    window_open: boolean;
    is_hod_procurement: boolean;
    /** Which gated step opened the window: cs_review or cs_review_quotes. */
    exit_step?: string | null;
    window_reason: string | null;
    /**
     * HAS THE BLIND REVIEW CONCLUDED?
     *
     * `cs_confirmed` is the reviewer's verdict; `cs_state` is the statement's own
     * lock. They are reported because they are not the same claim — a statement
     * can be locked while its review is still open — and they arrive from the same
     * `classificationAccess()` helper that decides whether this card is
     * editable, so the banner and the card cannot disagree about the review.
     *
     * Optional so the screen still works against an API that predates them:
     * the page reads them with `?? false` rather than assuming them.
     */
    cs_confirmed?: boolean;
    cs_state?: string | null;
  };
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

// The prototype's progress order, as a clean TEN-step run that ends at D365
// pushed.
//
// TWO CHANGES FROM THE ORIGINAL, both deliberate:
//
// 1. `CS_REVIEW` is inserted at step 5. It is NOT a `pr.status` — the CS review
//    chain (migration 065) runs while the PR is still IN_PROCUREMENT_REVIEW and
//    only moves it to cost center once confirmed. So this is a synthetic stop,
//    and `curIdx` below decides whether it is reached by reading the review
//    state rather than the stage. Without it the bar jumped from "Procurement
//    review" straight to Finance review and the review the user was asked to
//    do was invisible on the one screen that summarises progress.
//
// 2. `CLOSED` is REMOVED. It was the eleventh entry rendered against a list of
//    ten, it is not a stage the light flow ever routes to (D365_PUSHED is the
//    terminal state), and it left the bar ending on a step nothing could reach.
//
// 3. `IN_COST_CENTER_APPROVAL` is REMOVED (migration 075). It was the stage
//    between the CS exit and Finance review, and it existed only for an approval
//    act no control in this app could perform. The ladder does not route to it
//    any more, so a timeline entry pointing at it would put a stop on the bar
//    that no request can ever reach — the same defect as (2), reintroduced by a
//    stage that had rows in it until 117 of them were moved out.
const TIMELINE = [
  'Submitted', 'IN_HOD_REVIEW', 'IN_WAREHOUSE_CHECK', 'IN_PROCUREMENT_REVIEW',
  'CS_REVIEW',
  'IN_FINANCE_REVIEW', 'IN_MANAGEMENT_REVIEW',
  'READY_FOR_D365', 'D365_PUSHED',
];

/**
 * The four sub-states of the CS review, in the words the people in them use.
 *
 * The key is `proc.cs_reviews.sub_state` (migration 065). The blank is not
 * "draft": the HOD's turn is a BLIND review — the identities and the prices
 * are withheld from the requesting HOD on purpose, so the screen must not
 * describe it as an ordinary look.
 */
const CS_SUBSTATE: Record<string, string> = {
  DRAFT: 'Draft',
  PROC_REVIEW: 'Procurement review',
  REQUESTER_REVIEW: 'HOD review (blind)',
  CONFIRMED: 'Confirmed',
  REVERTED: 'Reverted',
};

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
  // THE CS EXIT AT QUOTES_RECEIVED. This is the other of the two steps that
  // demand a classification, and it was missing here: a PR sitting at
  // QUOTES_RECEIVED with a CONFIRMED statement read "read-only" to the one desk
  // that still had work to do on it, and the page offered no way onward at all
  // except the "Open CS" link — which builds a statement that already exists.
  //
  // Adding the actor does NOT create a second door. There is deliberately no
  // standalone Advance button: the classification card's unified "Save & Proceed
  // to Finance Review" posts `csReviewConfirmed`, and the engine picks the step
  // (order 7, cs_review_quotes, condition `csExitComplete`). This entry only
  // decides whether that desk sees the action bar at all.
  QUOTES_RECEIVED: ['procurement', 'admin'],
  // IN_COST_CENTER_APPROVAL is GONE (migration 075). It granted the HOD and the
  // cost-centre owner an action bar at a stage whose only exit named
  // `cost_center_owner` — a role nobody signs in as, from a stage no control in
  // this app could act on. The HOD's bar there held one dead "Review & act"
  // link, and the cost centre owner's was empty. No entry means no action bar,
  // which is the truth: there is nothing to do at a stage the ladder does not
  // route to. Left in place it would keep advertising a control that cannot
  // exist.
  // THE FINANCE REVIEW STAGE — where the request waits for its financial
  // governance: ledger verification and budget confirmation.
  //
  // `finance` is the desk that owns the release and `cfo` is the second actor
  // the ladder names on the two gates out of this stage. `admin` and `hod` are
  // here because the 2026-10-23 ruling is that the release is NOT the exclusive
  // right of the `finance` desk: during UAT and operational sign-offs a head of
  // department may release it, and the admin alias inherits that.
  //
  // `admin` and `cfo` would pass the `canAct` test through ROLE_ALIASES and the
  // ladder's actorRole anyway. `hod` does not: `hod` is the role all five
  // department heads carry, and it is aliased to nothing.
  IN_FINANCE_REVIEW: ['finance', 'cfo', 'admin', 'hod'],
  IN_MANAGEMENT_REVIEW: ['management'],
  READY_FOR_D365: ['procurement'],
};

/**
 * Where each sourcing/governance sub-state is actually decided.
 *
 * Every one of these has a dedicated screen that enforces its own stage AND
 * role server-side (`can_vote`, `can_decide`, `can_lock`, `can_push`). This
 * table only says WHICH screen, so the PR detail page can offer a route rather
 * than a dead end.
 *
 * `QUOTES_RECEIVED` goes to the CS screen: quotes are in and the next act is
 * building the Comparative Statement. `PACK_LOCKED` goes to the pack screen,
 * which is where it becomes pushable — `packAlert` is explicit that the CS
 * pushes to D365 from there.
 *
 * D365_PUSHED and CLOSED are absent on purpose: there is nothing left to decide.
 */
const GOVERNANCE_NEXT_STEP: Record<string, { href: string; label: string }> = {
  QUOTES_RECEIVED: { href: '/cs', label: 'Open CS' },
  CS_LOCKED: { href: '/mc', label: 'Open MC vote' },
  MC_APPROVED: { href: '/cfo', label: 'Open CFO decision' },
  CFO_APPROVED: { href: '/pack', label: 'Open approved pack' },
  PACK_LOCKED: { href: '/pack', label: 'Open approved pack' },
};

export default function PrDetail() {
  const { session, ready } = useSession();
  const router = useRouter();
  const { id } = router.query;

  const [pr, setPr] = useState<Pr | null>(null);
  const [hist, setHist] = useState<HistEvent[]>([]);
  const [src, setSrc] = useState<Sourcing | null>(null);
  /**
   * The CS review sub-state, or null when no review exists / none is permitted.
   * Read only to place the stepper's synthetic "CS review" stop; it is NOT a
   * second source of truth for whether a review happened.
   */
  const [csReview, setCsReview] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /**
   * The management gate threshold is ADMIN-EDITABLE (Part 7), so this screen
   * must not import the DEFAULT_MANAGEMENT_THRESHOLD constant — doing so made
   * the displayed gate disagree with the threshold the engine actually applied.
   * Read it from the config API instead; a failure leaves the gate shown as
   * "unknown" rather than silently falling back to a stale number.
   */
  const [threshold, setThreshold] = useState<number | null>(null);

  // -- Per-line Capex/Opex classification (step 5) ----------------------------
  //
  // The class is made at step 5, in the CS review chain, by the desk that ran
  // the competition. The draft lives here and is written in one call, because
  // a request is usually classified line by line and a half-classified request
  // is worse than an unclassified one: the split on the card would be a lie.
  const [clsDraft, setClsDraft] = useState<Record<number, { classification: string; usefulLifeYears: string }>>({});
  const [clsBusy, setClsBusy] = useState(false);
  const [clsErr, setClsErr] = useState<string | null>(null);
  const [clsMsg, setClsMsg] = useState<string | null>(null);

  // -- HOD per-line decisions (prototype _lightEnsureLineDecisions) ----------
  const [disp, setDisp] = useState<Record<number, Disp>>({});
  const [actBusy, setActBusy] = useState(false);
  const [actErr, setActErr] = useState<string | null>(null);
  const [actMsg, setActMsg] = useState<string | null>(null);
  // Procurement's revert-to-HOD dialog. A real modal, not window.prompt: the
  // prompt shipped a PRE-FILLED default ("Please review and update this
  // request."), so "mandatory remarks" was satisfiable by pressing OK without
  // typing anything — and the backend now persists whatever arrives here.
  const [revertOpen, setRevertOpen] = useState(false);
  const [revertRemarks, setRevertRemarks] = useState('');

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

  // Receive Quotation (prototype lightProcReceiveQuote). Declared HERE for the
  // same reason as the block above: above the `if (!pr) return null;` early
  // return. A hook below it makes the loading render and the loaded render call
  // different numbers of hooks, and React unmounts the page with a black
  // "Application error" screen. tests/hooks-order.test.tsx guards this.
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [quoteMsg, setQuoteMsg] = useState<string | null>(null);

  // Ready for CS — hand the finished competition to the committee. Declared here,
  // above the `if (!pr) return null;` early return, for the same hook-order
  // reason as the blocks above it.
  const [csBusy, setCsBusy] = useState(false);

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
    // CS review sub-state, for the stepper's "CS review" stop only. Silent on
    // failure: an unreachable review endpoint must not take down the PR page,
    // and the bar simply shows procurement review as the current stop.
    api.get<{ sub_state: string | null }>(`/pr/${id}/cs/review`)
      .then(r => setCsReview(r.data?.sub_state ?? null))
      .catch(() => setCsReview(null));
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
  // ── THE DEAD-END GATE ──────────────────────────────────────────────────────
  // Line categories on this PR that no vendor can be reached through. Non-empty
  // means at least one line would ride onto the RFQ and never be quoted by
  // anyone: the requester picked MACHINERY, MACHINERY has no vendor behind it,
  // the roster below looks perfectly healthy because the OTHER lines do — and
  // the failure only surfaces at AWARD, weeks later, in a different screen.
  //
  const deadEnd = cands?.unmapped_categories ?? [];
  // Both halves matter. On a FIRST issue this disables the button so the buyer
  // is told before they commit, and `issue()` refuses the same PR server-side so
  // the gate does not depend on this bundle being current. On a RE-ISSUE the RFQ
  // already carries the line, so the server reports `blocking: false` and the
  // dead end is stated as a warning instead — the buyer's only real move is to
  // add vendors, and refusing the dialog would leave them with none.
  //
  // `blocking` is optional-chained because the API may answer from an older
  // build; falling back to the legacy array-length rule keeps that case honest.
  const rfqBlocked = cands?.blocking ?? (cands?.unmapped_categories ?? []).length > 0;
  // Lines that cannot ride an RFQ at all. Rendered as a named list rather than
  // inferred from an empty roster: "no vendor is mapped" and "every line is held"
  // look identical on screen and have opposite fixes.
  const parkedLines = cands?.unquotable_lines ?? [];
  const heldLines = parkedLines.filter(l => l.reason === 'held');

  /**
   * HAS THE BUYER MOVED THE QUOTE DATE?
   *
   * A re-issue may legitimately add nobody. `reissue()` refuses only when
   * `fresh.length === 0 && !deadlineMoved` — so pushing the date out on its own
   * is a real, supported action, and it is the ONLY one left when every mapped
   * vendor is already on the roster. Without this the Send button stayed
   * disabled on exactly the PR it was meant to serve.
   *
   * Compared as `yyyy-mm-dd` STRINGS because both sides are already day
   * granular: `rfqDeadline` comes from `<input type="date">` and
   * `suggested_deadline` is `to_char(deadline_at,'YYYY-MM-DD')`. That is the
   * same comparison the server makes at rfq.service.ts:1046. Parsing either
   * side as a Date here would reintroduce the midnight bug documented at
   * rfq.service.ts:1030 — a deadline silently rewritten to 00:00 that the buyer
   * never touched.
   */
  const deadlineChanged = Boolean(cands && rfqDeadline !== cands.suggested_deadline);
  // The exact mirror of the server's `fresh.length === 0 && !deadlineMoved`
  // refusal, so the button is disabled exactly when the POST would be refused.
  const nothingToDo = picked.length === 0 && !deadlineChanged;
  const curIdx = (() => {
  const i = TIMELINE.indexOf(pr.status);
  if (i < 0) return -1;
  // While procurement review is in force, the CS review chain is the thing the
  // request is actually waiting on, so the bar advances one stop to show it.
  // Once the PR has left procurement review the chain is necessarily behind it.
  if (pr.status === 'IN_PROCUREMENT_REVIEW' && csReview) return TIMELINE.indexOf('CS_REVIEW');
  return i;
})();
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

  // ── the per-line Capex/Opex card ────────────────────────────────────────
  //
  // The lines that are part of the spend. A held or rejected line is not being
  // bought, so it carries no class — and the server refuses a class on one.
  const clsLines = pr.lines.filter(l => l.approved && !l.rejected && !l.held);
  //
  // WHO MAY WRITE THE CLASS COMES FROM THE API, not from a role string here.
  //
  // This screen used to keep its own copy of the gate
  // ('procurement,procurement_manager,cs,admin') — two copies of one rule, which
  // is exactly how the retired `procurement_manager` survived in the web after
  // the API had dropped it: a card that was editable for someone the API would
  // refuse. And HOD Procurement cannot be written as a role string at all,
  // because every department head signs in as `hod`; only the API can tell
  // Procurement's head from Finance's.
  //
  // So `pr.classification.can_write` is the single source, computed by the same
  // rules setLineClassifications() refuses on. Nothing is guessed from the review
  // sub-state any more.
  //
  // THE FALLBACK THAT MADE THIS CARD VANISH WAS BACKWARDS, AND IT IS GONE.
  //
  // It used to read
  //
  //   window_open ?? (Boolean(csReview) && ['DRAFT','PROC_REVIEW','REQUESTER_REVIEW'].includes(csReview))
  //
  // — i.e. "show the card while the statement is still being reviewed, hide it
  // once it is CONFIRMED". That was correct while the CONFIRM demanded the
  // class, because confirming without one was refused.
  //
  // Since the gate moved to the crossing (2026-10-22) it is exactly inverted:
  // the confirmation RELEASES the classification work rather than settling it.
  // Procurement tags Capex/Opex and the useful life AFTER the blind review
  // closes, and the CS exit is what demands it. So the card
  // disappeared at precisely the moment it became the only thing left to do —
  // which is why it was not on the screen at all on a confirmed request.
  //
  // `GET /pr/:id` now returns the block (it used to be on the capital detail
  // route only, so the light flow's PR screen never had it). If it is somehow
  // absent — an older API — show the card read-only rather than hide it: a
  // missing class the user cannot see is the one outcome worse than a card
  // that tells them they cannot edit it.
  const clsWindowOpen = pr.classification?.window_open ?? false;
  const clsCanCorrect = pr.classification?.can_correct ?? false;
  const clsCanWrite = pr.classification?.can_write ?? false;
  const clsExitStep = pr.classification?.exit_step ?? null;
  // HAS THE REVIEW BEEN CONCLUDED? Both detail endpoints call
  // `classificationAccess`, so this arrives with the same window authority the
  // card is edited under — one answer, not a second guess made in the browser.
  // (`cs_state` is reported by the same helper but is not read here: the banner
  // asks about the REVIEW. A statement can be locked while its review is still
  // open, and claiming otherwise would be a second, looser rule.)
  const clsCsConfirmed = pr.classification?.cs_confirmed ?? false;
  // The card is shown whenever the class is being made, may still be corrected,
  // or is already there to be read — a request that reached the cost boundary with no
  // class at all must SHOW that, not hide it. And when the API says nothing at
  // all, it still shows, read-only.
  const clsShow = clsWindowOpen
    || clsCanCorrect
    || clsLines.some(l => l.classification)
    || !pr.classification;
  //
  // The draft, seeded from what is already on the line. A chip click only
  // changes the draft; nothing is written until Save.
  const clsValue = (lineNo: number) => {
    const d = clsDraft[lineNo];
    if (d) return d;
    const l = pr.lines.find(x => x.line_no === lineNo);
    return {
      classification: l?.classification ?? '',
      usefulLifeYears: l?.useful_life_years != null ? String(l.useful_life_years) : '',
    };
  };
  const clsUnclassified = clsLines
    .filter(l => !clsValue(l.line_no).classification)
    .map(l => l.line_no);
  const clsCapex = Number(pr.capex_amount || 0);
  const clsOpex = Number(pr.opex_amount || 0);
  const clsUnclassifiedAmount = Math.max(0, amt - clsCapex - clsOpex);
  // CAN THIS DESK LEAVE THE CS STAGE FROM HERE?
  //
  // Four conditions, each answering a different question, and all four have to
  // hold — which is why there is no separate "Advance" control that could hold
  // it at one and not the others:
  //   clsWindowOpen  — a capex-gated step is live at this stage at all
  //                    (the API's own answer, not a stage list restated here)
  //   clsCsConfirmed — the blind review actually concluded. `advance()` carries
  //                    its own guard for this, and posting the flag does not
  //                    make it true.
  //   clsCanWrite    — this desk may write a class. Stamping a class is a
  //                    decision; nobody crosses a gate by asserting one.
  //   nothing left   — every approved line carries a class. This is the same
  //                    population `unclassifiedApprovedLines` refuses on, read
  //                    from the lines the card is editing.
  //
  // Rendered as a disabled button WITH ITS REASON rather than a hidden one: a
  // card that silently lacks its action reads as "nothing left to do here" when
  // the truth is "one more thing, and here it is".
  const clsCanProceed = clsWindowOpen && clsCsConfirmed && clsCanWrite && clsUnclassified.length === 0;
  const clsProceedBlocker =
    clsUnclassified.length > 0
      ? `Line${clsUnclassified.length === 1 ? '' : 's'} ${clsUnclassified.join(', ')} still ${clsUnclassified.length === 1 ? 'carries' : 'carry'} no class. Every approved line must be marked capital or operating before this request can leave the CS step.`
      : !clsCsConfirmed
        ? 'The blind review has not been confirmed yet. Ask the requesting HOD to close the review on the CS screen — confirming it is the HOD’s act, not procurement’s.'
        : null;

  const setCls = (lineNo: number, patch: Partial<{ classification: string; usefulLifeYears: string }>) => {
    setClsDraft(d => ({
      ...d,
      [lineNo]: { ...clsValue(lineNo), ...patch } as { classification: string; usefulLifeYears: string },
    }));
    setClsMsg(null);
    setClsErr(null);
  };

  // The ONE payload both save paths send. Extracted so "Save classification" and
  // "Save & Proceed to Finance Review" cannot ever classify different sets of
  // lines — two builders would be two answers to "what is being written", and
  // only one of them is checked by the reader.
  const clsPayload = () =>
    clsLines
      .map(l => {
        const v = clsValue(l.line_no);
        if (!v.classification) return null;
        const out: { lineNo: number; classification: string; usefulLifeYears?: number } = {
          lineNo: l.line_no, classification: v.classification,
        };
        if (v.usefulLifeYears) out.usefulLifeYears = Number(v.usefulLifeYears);
        return out;
      })
      .filter(Boolean) as Array<{ lineNo: number; classification: string; usefulLifeYears?: number }>;

  const putClassifications = async () => {
    const res = await api.patch(`/pr/${pr.id}/lines/classification`, { lines: clsPayload() });
    return (res.data || {}) as any;
  };

  const saveClassifications = async () => {
    if (!pr) return;
    setClsBusy(true); setClsErr(null); setClsMsg(null);
    try {
      const d = await putClassifications();
      setClsMsg(
        `Classified ${(d.classified || []).length} line${(d.classified || []).length === 1 ? '' : 's'}. `
        + `Capex ${pkr(Number(d.capex_amount || 0))} · Opex ${pkr(Number(d.opex_amount || 0))}.`
        + (d.still_unclassified?.length
          ? ` Still unclassified: line${d.still_unclassified.length === 1 ? '' : 's'} ${d.still_unclassified.join(', ')}.`
          : ''),
      );
      setClsDraft({});
      await load();
    } catch (e: any) {
      setClsErr(e?.message || 'Could not save the classification.');
    } finally {
      setClsBusy(false);
    }
  };

  /**
   * SAVE & PROCEED — the single door out of the CS stage.
   *
   * One click, two writes, in this order and no other way round:
   *   1. PATCH /pr/:id/lines/classification  — the classifications.
   *   2. POST  /pr/:id/advance {csReviewConfirmed: true}
   *
   * Step 2 is what actually moves the PR. The step's condition is
   * `csExitComplete` — csReviewConfirmed AND capexOpexClassified (migration
   * 075) — so this handler is not declaring the crossing, it is supplying the
   * ACT half of it. The STATE half comes from the lines the PATCH above just
   * wrote; the engine reads it from the snapshot and no caller can assert it.
   * Order 7 (`cs_review_quotes`, actor procurement) is then the winning
   * candidate and its `to` is IN_FINANCE_REVIEW. If either half is missing the
   * planner returns kind 'none' — a refusal, never a wrong door.
   *
   * WHY ONE BUTTON AND NOT "SAVE" THEN "ADVANCE": two buttons on two cards, or a
   * passive "ready to advance" state between them, is a second route into the
   * same gate. The buyer would save, come back tomorrow, and find a button that
   * looks like the thing they already did. The eligibility is computed and shown;
   * the crossing is one act.
   *
   * The two writes are NOT atomic, and the failure report says so rather than
   * pretending otherwise: the classification write commits first, so a refused
   * advance has to be told as "your lines are saved, the move was refused" or the
   * buyer will redo work that is already done.
   */
  const saveAndProceed = async () => {
    if (!pr) return;
    setClsBusy(true); setClsErr(null); setClsMsg(null); setActErr(null); setActMsg(null);
    try {
      const d = await putClassifications();
      setClsDraft({});
      const n = (d.classified || []).length;
      const saved =
        `Saved ${n} line${n === 1 ? '' : 's'}. `
        + `Capex ${pkr(Number(d.capex_amount || 0))} · Opex ${pkr(Number(d.opex_amount || 0))}.`;
      let r: any;
      try {
        r = await api.post(`/pr/${pr.id}/advance`, { csReviewConfirmed: true });
      } catch (e: any) {
        setActMsg(
          `${saved} Classifications are saved — but this request did not move to Finance review: `
          + String(e?.message ?? e),
        );
        await load();
        return;
      }
      setActMsg(
        `${saved} Advanced to ${r.data?.nextStage ?? 'IN_FINANCE_REVIEW'} `
        + `through ${clsExitStep ?? 'the CS exit step'}. Finance review now owns it.`,
      );
      await load();
    } catch (e: any) {
      setClsErr(e?.message || 'Could not save the classification.');
    } finally {
      setClsBusy(false);
    }
  };

  // THE FINANCE RELEASE.
  //
  // One act, one endpoint, and the ENGINE decides where the request lands. The
  // two gates out of IN_FINANCE_REVIEW are mutually exclusive — `finance_release`
  // to READY_FOR_D365 below the global management threshold, `finance_review` to
  // IN_MANAGEMENT_REVIEW above it — and the engine picks between them from the
  // request's own amount. This screen does not choose, and does not need to know
  // the answer: it posts the act and reports what the engine did.
  //
  // So NOTHING is posted but a reason. A decision flag would be a claim, and the
  // only claim that belongs at this stage is the one the engine can read for
  // itself. `csReviewConfirmed` is deliberately NOT sent: it is the CS exit's
  // flag, it is honoured only for procurement and HOD Procurement, and posting
  // it here would be asking for a step this stage does not have.
  //
  // The classification is NOT re-checked here either. The CS exit is the ONE
  // gate that demands a class (ruling, 2026-10-23): a request that reached this
  // stage through the comparative-statement exit arrived with every approved
  // line classified, and the advance inherits that. The no-CS path can arrive
  // unclassified — that gap is recorded, not papered over — and closing it with
  // a second gate here is the duplicate gate that ruling forbids.
  const releaseFromFinance = async () => {
    if (!pr) return;
    setActBusy(true); setActErr(null); setActMsg(null);
    try {
      const r = await api.post(`/pr/${pr.id}/advance`, {});
      const to = r.data?.nextStage ?? 'the next stage';
      const via = r.data?.matchedStep ?? 'the finance gate';
      setActMsg(
        `Advanced to ${to} through ${via}. `
        + (to === 'READY_FOR_D365'
          ? 'The request is ready for D365.'
          : to === 'IN_MANAGEMENT_REVIEW'
            ? 'Management review now owns it.'
            : 'The next desk now owns it.'),
      );
      await load();
    } catch (e: any) {
      setActErr(String(e?.message ?? e));
    } finally {
      setActBusy(false);
    }
  };

  // THERE IS NO STANDALONE `cs` OPERATOR IN THIS DEPLOYMENT.
  //
  // SUBSTAGE_OWNER_ROLE maps the CS stages to 'cs', and stageOwner() renders
  // that verbatim, so a procurement officer opening a PR at the CS stage was
  // told "Stage owner is cs — acting as procurement, this is read-only" while
  // being the person who actually builds, edits and submits the comparative
  // statement. The screen said the work belonged to a role nobody holds.
  //
  // Procurement (and admin) therefore operate the CS stage. This only changes
  // the WORDING of the banner and unlocks the inline hand-off — the endpoints
  // were already theirs: CS_ROLES is 'procurement,cs' on generate/lock, and
  // DRAFT_ROLES on the review chain's submit. No API gate is widened here.
  const stageOwnedByCs = stageOwner(pr.status) === 'cs';
  const operatesCsStage = stageOwnedByCs && roleAllowed(role, 'cs,procurement,admin');
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
  // Live quotations on file — the precondition for handing the round to CS. Read
  // from the server's sourcing payload, and counted by STATE, because the quotes
  // array carries every version a vendor sent: V1 stays on the record as
  // `Superseded` after V2 arrives, so `length` alone would report "1 quote" on a
  // PR where nobody has actually quoted.
  const liveQuoteCount = (src?.procurement?.quotes ?? [])
    .filter((q: any) => (q?.state ?? 'Submitted') === 'Submitted').length;
  // Where an RFQ may still be CREATED. Deliberately the API's own list
  // (RFQ_ISSUE_STAGES) rather than a copy of it here.
  const inSourcingStage = ['IN_PROCUREMENT_REVIEW', 'READY_FOR_D365'].includes(pr.status);
  // Where one may still be TOPPED UP — STRICTLY NARROWER. In procurement's
  // review and nowhere else, mirroring RFQ_REISSUE_STAGES in rfq.service.ts.
  //
  // This is segregation of duties, not UX. Once the PR has moved on (a
  // comparative statement exists, a winner is chosen, it has been forwarded to
  // cost centre / finance / D365) procurement holds no action rights over it.
  // Showing "Re-issue RFQ" there would let the actor who ran the competition
  // rewrite its roster after handing the document to the next authority —
  // changing a decided competition with no involvement from the current holder
  // and no audit entry from them. The sanctioned route is to reject the PR
  // with remarks so it returns through the audited workflow.
  //
  // An earlier revision made this `hasRfq || inSourcingStage`, on the reasoning
  // that a buyer who spotted a vendor drop-out late would otherwise have no
  // action. That was rejected: having no action IS the control.
  const canReissue = pr.status === 'IN_PROCUREMENT_REVIEW';
  const isClosed = ['D365_PUSHED', 'CLOSED', 'FULFILLED_FROM_STOCK', 'REJECTED'].includes(pr.status);

  // -- the four HOD actions (prototype lightHodApprove / lightHodRevertForRevision
  // / lightReject / lightOnHold, all posting through one advance endpoint here) --
  // Prototype line 2957: Apply stays DISABLED while any line is undecided;
  // Reject and Hold are meta actions that never depend on line decisions.
  // (`lineSum` itself is the useMemo hoisted above the early returns.)
  const lineGateDisabled = lineSum.outcome === 'pending';
  const isHodStage = pr.status === 'IN_HOD_REVIEW';

  // THE FINANCE REVIEW STAGE. The request arrives here with every approved line
  // already classified by procurement at the CS exit, and the act that waits for
  // it is the release: the engine's `finance_release` (to READY_FOR_D365) below
  // the global management threshold, or `finance_review` (to IN_MANAGEMENT_REVIEW)
  // above it. Both are the finance desk's gates and both are legal engine steps.
  //
  // A STAGE, not a role. `canAct` asks whether THIS desk may act here; this
  // asks whether the stage HAS an act of its own, which is the question the
  // action bar is built to answer.
  const financeStage = pr.status === 'IN_FINANCE_REVIEW';

  // A line the HOD put on hold must not flow forward to Procurement or any later
  // stage, so it is hidden from the downstream roles here. The API deliberately
  // returns every line (`SELECT pl.*` in PrService.get) and applies no role
  // filtering — the exclusion is presentation-only until RBAC lands.
  //
  // The rule itself lives in lib/ui (`seesHeldLines` / `visibleItems`) and the grid
  // at /pr calls the same pair. Two copies of "who may see a hold" is how this
  // defect survived a fix to one screen.
  //
  // INVARIANT — do not filter while `canAct && isHodStage`. `disp` is keyed by the
  // ZERO-BASED index into `pr.lines`, which is the same key the server's
  // `lineDecisions` expects. Filtering first would shift those indices and write a
  // decision onto the wrong line. The two conditions together make that unreachable:
  // rows only carry decision controls when `canAct && isHodStage`, and that is
  // exactly when nothing is filtered.
  const seesHeld = seesHeldLines(role) || (canAct && isHodStage);
  const visibleLines = visibleItems(pr.lines, seesHeld);

  // Whether the awarded cost may be shown. Read from the API's own flag rather
  // than re-tested against a stage list in the browser: the API refuses an
  // advance across the cost boundary on that same predicate, and two
  // copies of a stage rule is exactly how a column and a gate drift apart.
  const costConfirmed = !!pr.cost_confirmed;

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

  /** Open the SHARED dialog and ask the API what it WOULD send. Read-only.
   *
   *  One function for both modes, which is what the prototype does — every
   *  branch of its action bar calls the same `lightProcIssueRFQ()`. The only
   *  difference is what gets pre-ticked: a first issue pre-selects the matched
   *  pool (that IS the roster being sent), a re-issue pre-selects NOTHING
   *  because `current_vendors` is already invited and the only meaningful act
   *  is adding what is missing.
   */
  async function openRfq() {
    if (!pr) return;
    setRfqOpen(true); setRfqBusy(true); setRfqErr(null);
    try {
      const r = await api.get<RfqCandidates>(`/pr/${pr.id}/rfq/candidates`);
      setCands(r.data);
      setPicked(r.data.already_issued ? [] : (r.data.vendors || []).map(v => v.id));
      setRfqDeadline(r.data.suggested_deadline || '');
    } catch (e: any) {
      setRfqErr(e.message || 'Could not load the vendor list.');
    } finally {
      setRfqBusy(false);
    }
  }

  /**
   * One click = (re-)issue AND send.
   *
   * Two calls, deliberately. `POST /pr/:id/rfq` (or `/reissue`) creates or tops
   * up the RFQ, snapshots the PR lines onto it and mints an invitation token per
   * vendor; `POST /rfq/:id/dispatch` is what writes core.email_outbox and the
   * .eml files. The prototype has one "Send RFQ" button that did both, so the
   * button does both — but if dispatch fails the RFQ still exists and the
   * outcome says so, rather than pretending nothing happened. That is also why
   * this is NOT one backend transaction: an emailed invitation cannot be rolled
   * back.
   */
  async function sendRfq() {
    if (!pr) return;
    const reissue = Boolean(cands?.already_issued);

    // `deadlineChanged` / `nothingToDo` are declared in the component body —
    // they gate the Send button's `disabled`, which renders outside this
    // function. Declaring them here shadowed nothing and was used by nothing.
    // Re-checked here, not only on the button. A disabled button is a UI
    // affordance, not a gate — the gate is `issue()`/`reissue()` refusing. This
    // early return just makes the client behave the way the server will. Only
    // the first-issue mode can be blocked; see the `blocking` note above.
    if (!reissue && rfqBlocked) {
      setRfqErr(
        `Cannot issue: line ${deadEnd.map(u => u.lineNos.join(', ')).join(', ')} ` +
        `has no vendor mapped to its category.`,
      );
      return;
    }
    if (nothingToDo) {
      setRfqErr(reissue
        ? 'Nothing to re-issue: every mapped vendor is already on this RFQ and the '
          + 'quote deadline is unchanged. Pick at least one new vendor, or set a '
          + 'different deadline.'
        : 'Select at least one vendor before sending.');
      return;
    }
    setRfqBusy(true); setRfqErr(null);
    try {
      const issued = await api.post<any>(
        reissue ? `/pr/${pr.id}/rfq/reissue` : `/pr/${pr.id}/rfq`,
        { vendorIds: picked, deadlineAt: rfqDeadline || undefined },
      );
      const rfqId = issued.data?.rfq?.id;
      const to = issued.data?.invitations?.length ?? picked.length;
      // A re-issue reports `added`; a first issue just counts what it sent.
      const added = issued.data?.added;
      const head = reissue
        ? `RFQ ${issued.data?.rfq?.rfq_number ?? ''} re-issued — ` +
          `${added ?? to} vendor(s) added${issued.data?.deadline_extended ? ', deadline extended' : ''}.`
        : `RFQ ${issued.data?.rfq?.rfq_number ?? ''} issued to ${to} vendor(s).`;
      if (!rfqId) {
        setActMsg(head);
        setRfqOpen(false); load();
        return;
      }
      let sentMsg = head;
      try {
        // Scoped to the vendors just invited on a re-issue. `dispatch()` is
        // already idempotent per vendor (it skips anything with a
        // dispatched_at), so this is about intent and about not re-stamping
        // the whole roster as part of a top-up.
        const d = await api.post<any>(`/rfq/${rfqId}/dispatch`, {
          channel: 'email',
          ...(reissue ? { vendorIds: picked } : {}),
        });
        sentMsg += ` Queued ${d.data?.queued ?? 0} message(s) in the outbox.`;
      } catch (de: any) {
        // The invitations exist. Say exactly that, and say the emails did not
        // go out, rather than reporting a clean success.
        sentMsg += ` But the emails did NOT go out (${de.message}). ` +
          'Open the RFQ and dispatch again.';
      }
      setActMsg(sentMsg);
      setRfqOpen(false);
      load();
    } catch (e: any) {
      setRfqErr(e.message || (reissue ? 'Could not re-issue the RFQ.' : 'Could not issue the RFQ.'));
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

  /**
   * PROCUREMENT'S ONLY OUTWARD ACTION: return the PR to the HOD.
   *
   * There is deliberately no procurement Reject. Procurement is a sourcing
   * function, not the demand owner — letting it kill a request hands a party
   * with a commercial interest in the outcome the power to end it outright.
   * Its whole authority at this stage is "send it back, and say why"; the HOD
   * then cancels or fixes it.
   *
   * Gated on `pr.status === 'IN_PROCUREMENT_REVIEW'` and nothing looser. Past
   * that stage — comparative statement drafted, forwarded, RFQ live — the PR
   * belongs to the next authority and the actor who ran the competition has no
   * right to unwind it. See the reissue gate for the same argument.
   */
  const revertEligible = canAct && pr.status === 'IN_PROCUREMENT_REVIEW';

  // THE RFQ HALF OF THE SAME GATE.
  //
  // `PrService.revertToHod` refuses this server-side, and the server is the
  // control — this only stops the click it would reject. The threshold is ONE
  // vendor invited, matching the server exactly: a solicitation with a live deadline
  // and no reply is already out of procurement's hands. An RFQ with an empty roster
  // is not a competition, and reverting then still works — the server cancels it.
  //
  // Facts come from the sourcing payload the page already loads, so no request is
  // added: `vendorIds` is the invitation roster, `quotes` the live submissions.
  const revertInvitations = src?.procurement?.rfq?.vendorIds?.length ?? 0;
  const revertQuotes = src?.procurement?.quotes?.length ?? 0;
  const rfqBlocksRevert = revertBlockedByRfq(revertInvitations);
  const revertBlockedReason = rfqBlocksRevert
    ? `${src?.procurement?.rfq?.id || 'This RFQ'} was already issued to ` +
      `${revertInvitations} vendor${revertInvitations === 1 ? '' : 's'}` +
      (revertQuotes > 0
        ? ` and ${revertQuotes} quote${revertQuotes === 1 ? ' has' : 's have'} been received`
        : '') +
      '. A competition vendors have been invited to cannot be unwound by procurement.'
    : null;

  // Two distinct questions, kept apart on purpose:
  //   revertEligible  — may procurement revert at all (role + stage)?
  //   rfqBlocksRevert — has this one run a live competition?
  const canRevertToHod = revertEligible && !rfqBlocksRevert;

  const revertToHod = () => {
    setRevertRemarks('');
    setRevertOpen(true);
  };

  /**
   * READY FOR CS.
   *
   * No confirmation dialog, deliberately — unlike revert-to-hod, which unwinds
   * something. This is the expected end of a sourcing round, and the button's own
   * label says what it does. What IS irreversible is caught here and named back:
   * the response reports how many quotations the CS will score on and how many
   * vendors were still to reply, so a buyer who forwards an incomplete field is
   * told in the same breath that it is happening.
   */
  const forwardToCs = async () => {
    setCsBusy(true); setActErr(null); setActMsg(null);
    try {
      const { data } = await api.post(`/pr/${pr.id}/ready-for-cs`, {});
      const n = (data as any)?.quotations ?? 0;
      const waiting = (data as any)?.vendorsAwaitingQuote ?? 0;
      setActMsg(
        `Forwarded to CS. ${(data as any)?.prNumber ?? pr.pr_number} now sits at ` +
        `${(data as any)?.nextStage ?? 'QUOTES_RECEIVED'} with ${n} quotation${n === 1 ? '' : 's'} ` +
        `on ${(data as any)?.rfq ?? 'the RFQ'}.` +
        (waiting > 0
          ? ` ${waiting} vendor${waiting === 1 ? ' was' : 's were'} still invited but had not quoted — ` +
            'the committee will score what has been received; quotations are now closed.'
          : ' Quotations are now closed: no vendor can change a price and no one can record a new one.'),
      );
      router.reload();
    } catch (e: any) {
      setActErr(String(e?.message ?? e));
    } finally {
      setCsBusy(false);
    }
  };

  const submitRevert = async () => {
    const remarks = revertRemarks.trim();
    if (!remarks) { setActErr('Remarks are required to revert a PR to the HOD.'); return; }
    setActBusy(true); setActErr(null); setActMsg(null);
    try {
      const { data } = await api.post(`/pr/${pr.id}/revert-to-hod`, { remarks });
      const cancelled = (data as any)?.cancelledRfqs ?? [];
      setRevertOpen(false);
      setActMsg(
        `Reverted to HOD review.` +
        (cancelled.length
          ? ` Cancelled ${cancelled.length} unused RFQ (${cancelled.join(', ')}) — nothing had been sent to a vendor.`
          : ''),
      );
      router.reload();
    } catch (e: any) {
      setActErr(String(e?.message ?? e));
    } finally {
      setActBusy(false);
    }
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

  /**
   * DOES THIS STAGE RENDER INLINE ACTIONS OF ITS OWN?
   *
   * Not "may this desk act" — `canAct` answers that, and it is the wrong
   * question here. What the "Open CS" link needs to know is whether the bar is
   * already occupied, because a second control beside a stage's own controls is
   * confusing, whereas an EMPTY bar is a dead end.
   *
   * These are the four things the bar can render, and they are the four the
   * link must not duplicate: the HOD's line/approval buttons, the revert, the
   * review link, and the sourcing trio. At QUOTES_RECEIVED every one of them is
   * false — `inSourcingStage` excludes that stage by design, because the
   * sourcing round is closed — so there is nothing to duplicate there and the
   * "Open CS" link is the whole bar.
   *
   * THE FIFTH IS THE FINANCE RELEASE. This is where the predicate was wrong,
   * and the wrongness had a second face: the bar was not merely missing a
   * button, it was missing the KNOWLEDGE that the stage had one. Finance
   * arriving at IN_FINANCE_REVIEW got an empty bar — `canAct` was true, and
   * every branch inside the `canAct` block was false, because none of the four
   * above describes what the finance desk does at that stage.
   *
   * So `financeStage` joins them. It is there so that "the bar is already
   * occupied" is TRUE exactly when the release button is on screen, which is
   * what keeps the "Open CS"-style link from ever appearing beside it.
   *
   * The classification card is deliberately NOT counted here. It lives on its
   * own card further down the page, not in this bar, and it only opens once the
   * blind review is confirmed. The desk has two things to do in sequence — build
   * and submit the statement on the CS screen, then classify and cross — and
   * hiding the first because the second exists would make the second
   * unreachable.
   */
  const hasInlineActions = Boolean(
    canAct && !onHold && (isHodStage || canRevertToHod || canSeeReview || inSourcingStage || financeStage),
  );
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
              // CS_REVIEW is a synthetic stop, not a `pr.status`, so
              // stageLabel() has no entry for it and would render the raw key.
              const label = s === 'CS_REVIEW' ? 'CS review' : stageLabel(s);
              // The CS sub-state, SHOWN rather than hidden in a tooltip.
              //
              // Step 5 is four steps, not one: the statement is drafted, the
              // procurement manager reviews it, the requesting HOD sees it in
              // blind mode, and it is confirmed. A bar that showed only "CS
              // review" told the user nothing about which of those they were
              // waiting on — the tooltip had the answer, but a tooltip is
              // invisible to anybody not looking for it.
              const sub = s === 'CS_REVIEW' && csReview ? CS_SUBSTATE[csReview] : null;
              return (
                <span key={s} className={passed ? 'pill pr pr-d365' : 'pill'}
                  title={s === 'CS_REVIEW'
                    ? `Comparative statement review — currently ${(csReview ?? 'not started').toLowerCase()}`
                    : undefined}>
                  {i + 1}. {label}
                  {sub ? ` · ${sub}` : ''}
                  {s === 'D365_PUSHED' && ' (Terminal)'}
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
                {visibleLines.length} {visibleLines.length === 1 ? (visibleLines[0]?.uom || 'unit') : 'lines'}
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
                {/* THE FINANCE RELEASE. The act that waits at IN_FINANCE_REVIEW.
                    This bar was EMPTY there until this button: `canAct` was true
                    for the finance desk and every branch inside this block was
                    false, because none of them described what finance does at
                    that stage. The request sat in Finance review with nothing to
                    press and no way out.

                    ONE button, and the ENGINE picks the gate. Below the global
                    management threshold it releases to READY_FOR_D365; above it,
                    it goes to Management review. Both are legal steps in the
                    ladder, both are the finance desk's, and the engine chooses
                    between them from the request's own amount — so this button
                    does not choose a destination, it records an approval and
                    lets the routing table answer.

                    The label says "Approve & Proceed" and the line beneath it
                    says which of the two it will be, so nobody is told
                    "proceed" and then surprised by where it went. The outcome
                    message after the click names the step the engine actually
                    matched.

                    The request arrives here with every approved line already
                    classified by procurement at the CS exit, and the card below
                    is READ-ONLY at this stage: what finance owns here is
                    financial governance, not line-item data entry. */}
                {financeStage && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <button
                      className="btn success sm"
                      disabled={actBusy}
                      onClick={releaseFromFinance}
                      title={
                        needsMgt === null
                          ? 'Releases this request through the engine. The threshold is unavailable, so the routing table decides.'
                          : needsMgt
                            ? 'Approves this request and routes it to Management review: it is above the management threshold.'
                            : 'Approves this request and releases it to Ready for D365: it is below the management threshold.'
                      }
                    >
                      {actBusy ? 'Approving…' : 'Approve & Proceed'}
                    </button>
                    <span className="text-sm text-mute">
                      {needsMgt === null
                        ? 'The engine routes this request.'
                        : needsMgt
                          ? `Above the ${pkr(threshold ?? 0)} management threshold — this goes to Management review.`
                          : `Below the ${pkr(threshold ?? 0)} management threshold — this releases to Ready for D365.`}
                    </span>
                  </div>
                )}
                {/* Procurement has NO reject. Its entire outward authority at
                    this stage is returning the PR to the HOD with remarks — see
                    revertToHod(). Deliberately gated on the stage, not on canAct,
                    for the same segregation-of-duties reason as the reissue gate. */}
                {canRevertToHod && (
                  <button
                    className="btn ghost danger sm"
                    disabled={actBusy}
                    title="Return this PR to the HOD. Procurement cannot reject a request — the HOD owns that decision."
                    onClick={revertToHod}
                  >
                    Revert to HOD
                  </button>
                )}
                {/* Rendered DISABLED rather than hidden. Hiding it would leave the
                    buyer guessing whether procurement lacks the permission or the
                    action is simply gone; a disabled button that says why is a
                    control they can read. The server refuses this too — this only
                    stops the click it would reject. */}
                {revertEligible && rfqBlocksRevert && (
                  <button
                    className="btn ghost danger sm"
                    disabled
                    title={revertBlockedReason || undefined}
                    style={{ opacity: 0.55, cursor: 'not-allowed' }}
                  >
                    Revert to HOD
                  </button>
                )}
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
                {/* ONE button, TWO labels — the prototype's Issue RFQ / Re-issue RFQ pair.
                    Both call `lightProcIssueRFQ()`, so both open THIS dialog and
                    only the endpoint behind Send differs.

                    The two modes have DIFFERENT stage gates, and that asymmetry
                    is the point:
                      - Issue RFQ  -> `inSourcingStage`, exactly as the prototype
                        gates it and as `issue()` enforces.
                      - Re-issue   -> `canReissue` ONLY (IN_PROCUREMENT_REVIEW).
                        An RFQ is a live, sent document with tokens minted and
                        suppliers contacted; editing its roster after the PR has
                        been handed to the next authority is editing a decided
                        competition. The API refuses it independently
                        (`RFQ_REISSUE_STAGES` in rfq.service.ts) — this is the
                        buyer being told before they click, not the gate itself.

                    `hasRfq` comes from the SERVER's sourcing payload, never a
                    local derivation: it is the same fact `issue()` uses to
                    refuse a second RFQ, so a locally-derived answer could offer
                    a button whose only outcome is a 400. */}
                {inSourcingStage && (
                  <>
                    {hasRfq && (
                      <>
                        <Link href={`/rfq/${src?.procurement.rfq?.rfq_id}`} className="btn ghost sm">
                          Open RFQ {src?.procurement.rfq?.id}
                        </Link>
                        {/* Receive Quotation — the prototype's Record-quotes step,
                          which only exists once an RFQ is out. Gated on `canAct`,
                          so it inherits the same "procurement owns this stage"
                          rule as Issue RFQ; the API independently refuses anyone
                          else with "Only Procurement can receive quotes." */}
                        {canAct && (
                          <button className="btn primary sm" onClick={() => setQuoteOpen(true)}>
                            <span style={{ display: 'inline-block', marginRight: 4 }}>&#8615;</span>
                            Receive Quotation
                          </button>
                        )}
                        {/* READY FOR CS — the end of the sourcing round. Visible only
                            while procurement still owns the stage, which is what makes
                            its disappearance the honest signal that the competition is
                            closed: `inSourcingStage` is false at QUOTES_RECEIVED, so
                            Open RFQ / Receive Quotation / Re-issue all go with it.

                            That bar being empty is NOT the same as the page being empty.
                            `STAGE_ACTIONS` now carries QUOTES_RECEIVED, so this desk
                            keeps an action bar at that stage and the one action on it
                            is the classification card's "Save & Proceed to Cost
                            Approval" — the crossing is the CS exit, not a sourcing act.
                            "Open CS" stays in GOVERNANCE_NEXT_STEP for the actors this
                            table excludes (HOD, finance), who still build and confirm
                            the statement from the CS screen.

                            The disabled state below is a courtesy, not the control:
                            `liveQuoteCount` comes from the server payload so the button
                            cannot offer an act whose only outcome is a 400, and the API
                            re-checks the same condition independently. */}
                        {canAct && (
                          <button
                            className="btn success sm"
                            onClick={forwardToCs}
                            disabled={csBusy || liveQuoteCount === 0}
                            title={liveQuoteCount === 0
                              ? 'At least one quotation must be received before this can go to CS — the committee compares quotations, so there is nothing to compare yet.'
                              : 'Hand this to CS for a comparative statement. Quotations close on the moment this is pressed.'}
                            style={liveQuoteCount === 0 ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}
                          >
                            {csBusy ? 'Forwarding…' : 'Ready for CS'}
                          </button>
                        )}
                      </>
                    )}
                    {hasRfq && canReissue && (
                      <button className="btn ghost sm" onClick={openRfq}>
                        <span style={{ display: 'inline-block', marginRight: 4 }}>&#8613;</span>
                        Re-issue RFQ
                      </button>
                    )}
                    {!hasRfq && (
                      <button className="btn ghost sm" onClick={openRfq}>
                        <span style={{ display: 'inline-block', marginRight: 4 }}>&#8613;</span>
                        Issue RFQ
                      </button>
                    )}
                  </>
                )}
              </>
            )}
            {isClosed && (
              <button className="btn ghost sm" disabled style={{ opacity: .5 }}>
                Closed{pr.status === 'FULFILLED_FROM_STOCK' ? ' (fulfilled from stock)' : ''}
              </button>
            )}
            {/* The read-only notice is SUPPRESSED for the stages procurement operates as CS.
                Saying "read-only" to the person who owns the work is not a
                neutral wording bug — it tells the buyer there is nothing they
                can do, which is how a hand-off becomes a dead end. */}
            {!canAct && !isClosed && !operatesCsStage && (
              <span className="text-sm text-mute" style={{ alignSelf: 'center' }}>
                Stage owner is <b>{stageOwner(pr.status) || 'system'}</b> — acting as {role}, this is read-only.
              </span>
            )}
            {!canAct && !isClosed && operatesCsStage && (
              <span className="text-sm text-mute" style={{ alignSelf: 'center' }}>
                {/* Read the STATEMENT, not the stage. This line used to be
                    unconditional, so a request whose comparative statement had been
                    drafted, reviewed blind, confirmed and locked still told
                    procurement it was "yours to build and submit" — the one
                    sentence guaranteed to be wrong at exactly the moment the work
                    was finished, and on the very screen the next action lives on.
                    The two claims are different facts: `cs_confirmed` is the
                    reviewer's verdict, `cs_state` the document's own lock. */}
                {clsCsConfirmed
                  ? 'Statement confirmed. Whoever may write the classification advances this request to Finance review from the Capex / Opex card below.'
                  : 'The comparative statement is yours to build and submit.'}
              </span>
            )}

            {/* ── WHERE A GOVERNANCE PR GOES NEXT ────────────────────────────
                The five Wave-3 states own their actions on dedicated screens,
                which are role-gated server-side. `STAGE_ACTIONS` deliberately
                has no entry for them — a PR that has left procurement must not
                show an inline action bar — but that left all 221 of those PRs
                dead-ending on this page with "read-only" and no way onward.

                Offered to whoever can SEE the target, not whoever can ACT on it:
                each destination screen re-checks the role itself, and a link
                that bounces is better than a link that does not exist.

                MIGRATION 075 CHANGED THE GATE, AND THE OLD ONE DEAD-ENDED THE CS
                STAGE. It read `!canAct`, written when QUOTES_RECEIVED had no
                STAGE_ACTIONS entry at all, so canAct was false for everyone
                there and the two conditions were the same thing. Giving
                procurement an entry — so the classification card has an owner —
                made canAct true there, and the link vanished for exactly the
                desk that most needs it: the page offered an action bar with
                nothing in it, and `inSourcingStage` is false at
                QUOTES_RECEIVED, so there was no other control either. The buyer
                had received the quotations, pressed "Ready for CS", and arrived
                at a stage that could not be left.

                So the gate asks the question the comment above has always meant
                — DOES THIS STAGE HAVE INLINE ACTIONS OF ITS OWN? — rather than
                the proxy that happened to agree with it for every stage except
                the one that changed. For all five entries in
                GOVERNANCE_NEXT_STEP the answer is no: inSourcingStage excludes
                QUOTES_RECEIVED and every governance sub-state, and isHodStage
                excludes them all. There is nothing here to duplicate, which is
                why the gate existed at all and why it can only ever have cost
                this page a link. */}
            {!hasInlineActions && (() => {
              const next = GOVERNANCE_NEXT_STEP[pr.status];
              if (!next) return null;
              return (
                <Link href={`${next.href}/${pr.id}`} className="btn primary sm">
                  {next.label}
                </Link>
              );
            })()}
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

        {/* ── The money columns ──────────────────────────────────────────────
            `unit_price_est` is the REQUESTER'S pre-RFQ budget guess. From Cost
            approval onward the awarded figure exists too, and it is a different
            number — net of the vendor's discount, plus tax. Showing only the
            estimate at the stage whose entire job is to confirm cost showed the
            guess and called it the cost.

            Both are shown, and the variance between them is the point. A confirmed
            cost nobody compared against the budget is a rubber stamp.

            The totals refuse to lie by omission too: the estimated total is only
            printed when EVERY visible line is priced. Summing the priced lines of
            a partly-unpriced PR would print a confident, understated number.
        */}
        {(() => {
          const allPriced = visibleLines.length > 0
            && visibleLines.every(l => l.unit_price_est !== null && l.unit_price_est !== undefined);
          const estTotal = allPriced
            ? visibleLines.reduce((s, l) => s + l.quantity * Number(l.unit_price_est), 0)
            : null;

          const awardedRows = visibleLines.filter(l => l.awarded && l.awarded.line_total !== null);
          const awardedComplete = visibleLines.length > 0 && awardedRows.length === visibleLines.length;
          const awardedSum = awardedRows.reduce((s, l) => s + Number(l.awarded!.line_total), 0);
          // Only a COMPLETE award prints as the PR's cost. A partial one is still
          // worth showing, but it is labelled as partial rather than presented as
          // the whole.
          const awardedTotal = awardedComplete ? awardedSum : (awardedRows.length > 0 ? awardedSum : null);

          const variance = (estTotal !== null && estTotal > 0 && awardedTotal !== null)
            ? ((awardedTotal - estTotal) / estTotal) * 100
            : null;

          const colCount = costConfirmed ? 9 : 7;

          return (
            <>
              <table className="t">
                <thead>
                  <tr>
                    <th>#</th><th>Item</th><th>Category</th><th>Qty</th>
                    <th>Unit <span className="text-mute">(est.)</span></th>
                    <th className="num">Amount <span className="text-mute">(est.)</span></th>
                    {costConfirmed && <th className="num">Unit <span className="text-mute">(awarded)</span></th>}
                    {costConfirmed && <th className="num">Amount <span className="text-mute">(awarded)</span></th>}
                    <th>{canAct && isHodStage ? 'Decision' : 'Disposition'}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleLines.map((l, idx) => {
                    const estLine = l.unit_price_est === null || l.unit_price_est === undefined
                      ? null
                      : l.quantity * Number(l.unit_price_est);
                    const a = costConfirmed ? l.awarded : null;
                    return (
                      <tr key={l.id}>
                        <td className="mono">{l.line_no}</td>
                        <td>
                          <div className="row-title">{l.item_name}</div>
                          <div className="row-sub mono">{l.item_code}{l.description ? ` — ${l.description}` : ''}</div>
                        </td>
                        <td><span className="dept-chip">{l.resolved_category}</span></td>
                        <td>{l.quantity} {l.uom}</td>
                        <td className="mono num">{pkrOrDash(l.unit_price_est)}</td>
                        <td className="mono num">{pkrOrDash(estLine)}</td>
                        {costConfirmed && (
                          <>
                            <td className="mono num">{pkrOrDash(a ? a.unit_price : null)}</td>
                            <td className="mono num">
                              {pkrOrDash(a ? a.line_total : null)}
                              {/* Show the tax and discount behind the figure rather than
                                  than making the reader reconstruct them. Both are
                                  nullable because a vendor may quote tax-inclusive
                                  and state no tax_percent at all. */}
                              {a && (a.discount_amount !== null || a.tax_amount !== null) && (
                                <div className="row-sub mono">
                                  {a.discount_amount !== null && <span>disc {pkr(a.discount_amount)}</span>}
                                  {a.discount_amount !== null && a.tax_amount !== null && ' · '}
                                  {a.tax_amount !== null && <span>tax {pkr(a.tax_amount)}</span>}
                                </div>
                              )}
                            </td>
                          </>
                        )}
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
                            {/* Held lines carry their own reason column now (advance() writes held_reason
                                alongside rejected_reason). Without this the pill said "held" and
                                stopped, which is the one thing the person waiting on the line
                                needs to know. */}{(l.held ? l.held_reason : l.rejected_reason) && (
                              <div className="row-sub">{l.held ? l.held_reason : l.rejected_reason}</div>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                  {visibleLines.length === 0 && (
                    <tr><td colSpan={colCount}><div className="empty-state">
                      {seesHeld
                        ? 'No lines on this PR.'
                        : 'No lines on this PR that are available to source — every line is held or rejected.'}
                    </div></td></tr>
                  )}
                </tbody>
                {visibleLines.length > 0 && (
                  <tfoot>
                    <tr>
                      <td colSpan={4}><b>Total</b></td>
                      <td />
                      <td className="mono num"><b>{pkrOrDash(estTotal)}</b></td>
                      {costConfirmed && <td />}
                      {costConfirmed && (
                        <td className="mono num">
                          <b>{pkrOrDash(awardedTotal)}</b>
                          {!awardedComplete && awardedRows.length > 0 && (
                            <div className="row-sub">partial — {awardedRows.length} of {visibleLines.length} lines awarded</div>
                          )}
                        </td>
                      )}
                      <td>
                        {variance !== null && (
                          <span className={`pill ${variance > 0 ? 'warn' : 'success'}`}>
                            {variance > 0 ? '+' : ''}{variance.toFixed(1)}% vs est.
                          </span>
                        )}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </>
          );
        })()}
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

      {/* -- Capex / Opex classification (step 5) ---------------------------- */}
      {clsShow && (
        <div className="card">
          <div className="card-h">
            <h3>Capex / Opex classification</h3>
            <span className="meta">
              {clsCanWrite
                ? 'Set at the CS exit — the desk that ran the competition'
                : clsCanCorrect
                  ? 'Finance may correct a classification after the cost boundary'
                  : financeStage
                    // At the finance stage the card is read-only for EVERY desk,
                    // and the reason is worth saying: the lines were classified
                    // by procurement at the CS exit, and what finance owns at this
                    // stage is budget confirmation and ledger verification, not
                    // line-item data entry. A card that only said "read-only"
                    // would read as a permission problem rather than as the
                    // stage it actually is.
                    ? 'Read-only — classified at the CS exit. At this stage finance confirms the budget; the lines are not edited here.'
                    : 'Read-only'}
            </span>
          </div>
          {/* WHICH of the two CS exits is in front of them. Both are the same
              decision — statement confirmed, lines classified, request crosses
              into Finance review — reached from the two stages a comparative
              statement can exist at, and naming the one that is actually live
              is more use than saying "step 5".

              These sentences used to be unconditional. On an ALREADY-CONFIRMED
              request they told procurement to "confirm the blind review" — work
              that is finished, attributed to them, and that the blind reviewer
              (the requesting HOD) is the only person who can do. So the copy now
              asks what is actually true. */}
          {clsWindowOpen && (
            <div className="card-b" style={{ paddingBottom: 0 }}>
              <p className="text-sm text-mute" style={{ margin: 0 }}>
                {clsCsConfirmed
                  ? `The blind review is confirmed. Classify every line below${clsCanWrite ? ', then send this request to Finance review' : ''} — the request advances through ${clsExitStep ?? 'the CS exit step'}.`
                  : clsExitStep === 'cs_review_quotes'
                    ? 'This request is at Quotes received. Confirm the blind review, then classify every line here — the request advances to Finance review through cs_review_quotes.'
                    : clsExitStep === 'cs_review'
                      ? 'This request is in procurement review. Confirm the blind review, then classify every line here — the request advances to Finance review through cs_review.'
                      : 'Classify every line before this request advances to Finance review.'}
              </p>
            </div>
          )}
          <div className="card-b">
            {/* The split. Read from the LINES, never from the header's
                expense_type: the header carries one choice the requester made
                for the whole request and cannot say what a laptop line is. */}
            <div className="pr-form-grid" style={{ marginBottom: 12 }}>
              <div className="field">
                <span className="lbl">Capital</span>
                <strong>{pkr(clsCapex)}</strong>
              </div>
              <div className="field">
                <span className="lbl">Operating</span>
                <strong>{pkr(clsOpex)}</strong>
              </div>
              <div className="field">
                <span className="lbl">Not yet classified</span>
                <strong>{pkr(clsUnclassifiedAmount)}</strong>
              </div>
              <div className="field">
                <span className="lbl">Routing</span>
                <strong>{pr.routing_key || '—'}</strong>
              </div>
            </div>

            {clsUnclassified.length > 0 && (
              <div className="banner" style={{ marginBottom: 12 }}>
                Line{clsUnclassified.length === 1 ? '' : 's'} {clsUnclassified.join(', ')} of the spend
                {clsUnclassified.length === 1 ? ' has' : ' have'} no class yet. The request cannot
                leave the CS step until every line you are buying is marked capital or operating.
              </div>
            )}

            {clsLines.length === 0 ? (
              <div className="empty-state">
                No line on this request is being bought, so there is nothing to classify.
              </div>
            ) : (
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 40 }}>#</th>
                      <th>Item</th>
                      <th style={{ width: 340 }}>Classification</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clsLines.map(l => {
                      const v = clsValue(l.line_no);
                      return (
                        <tr key={l.id}>
                          <td>{l.line_no}</td>
                          <td>
                            {l.description || l.item_name || l.item_code || '—'}
                          </td>
                          <td>
                            {/* ONE control, not five chips. It is portalled to
                                <body> and bounded, so a long list scrolls inside
                                the panel and never drags the page — and a row
                                near the bottom of a long request still opens
                                upward instead of off-screen.

                                Useful life is NOT a column any more. It is not
                                dropped, only un-editable: the pick below still
                                seeds a 4-year life for a capital line and
                                clears it for an operating one, so the API's
                                "a capital line needs a useful life" check
                                (pr.service.ts) is still satisfied and D365
                                still receives a DepreciationPeriod only on the
                                lines it belongs on. */}
                            <ClassificationCombobox
                              value={v.classification}
                              disabled={!clsCanWrite || clsBusy}
                              id={`cls-line-${l.line_no}`}
                              onChange={next => setCls(l.line_no, {
                                classification: next,
                                // A capital line needs its life from the moment it
                                // is a capital line. An operating line has none,
                                // and carrying a stale one would send a
                                // depreciation period to the ERP for a
                                // consumable.
                                usefulLifeYears: next.startsWith('CAPEX')
                                  ? (v.usefulLifeYears || '4')
                                  : '',
                              })}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {clsCanWrite && (
              <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
                {/* ONE button, chosen by eligibility — not two buttons and a
                    disabled state. When the CS exit is unlocked this is the
                    ONLY control: "Save classification" would be a way to stop
                    one act short, which is precisely the two-click drift the
                    requirement rules out. */}
                {clsCanProceed ? (
                  <button
                    className="btn success sm"
                    disabled={clsBusy}
                    onClick={saveAndProceed}
                    title={`Saves the classifications and moves this request to Finance review through ${clsExitStep ?? 'the CS exit step'}.`}
                  >
                    {clsBusy ? 'Saving & proceeding…' : 'Save & Proceed to Finance Review'}
                  </button>
                ) : (
                  <button className="btn primary sm" disabled={clsBusy} onClick={saveClassifications}>
                    {clsBusy ? 'Saving…' : 'Save classification'}
                  </button>
                )}
                {clsUnclassified.length > 0 && (
                  <span className="text-sm text-mute">
                    {clsUnclassified.length} line{clsUnclassified.length === 1 ? '' : 's'} still to classify
                  </span>
                )}
              </div>
            )}
            {/* The reason is shown, not hidden. A button that is absent reads as
                "nothing left to do here"; a button that is present and says what
                is missing reads as the work that is. */}
            {clsCanWrite && clsProceedBlocker && clsWindowOpen && (
              <div className="text-sm text-mute" style={{ marginTop: 8 }}>{clsProceedBlocker}</div>
            )}
            {clsErr && <div className="banner danger" style={{ marginTop: 10 }}>{clsErr}</div>}
            {clsMsg && <div className="banner" style={{ marginTop: 10 }}>{clsMsg}</div>}
          </div>
        </div>
      )}

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

      {/* Saved confirmation for Receive Quotation. Lives here rather than inside the
          modal so it survives the close and names the version that was written. */}
      {quoteMsg && (
        <div className="alert success" style={{ marginTop: 12 }}>{quoteMsg}</div>
      )}

      {/* -- Receive Quotation modal ------------------------------------ */}
      {/* Only mounted once the RFQ exists. `pr.lines` already carries the item
          code, item name, resolved category, quantity and uom the grid needs,
          and rfq_lines.line_no is 1:1 with pr_lines.line_no, so the form reads
          its rows straight off the page instead of issuing a second fetch.

          `quotationRows`, NOT `pr.lines`. This used to pass the raw list, and the
          modal dropped only the REJECTED lines — so a held line was invisible on
          the Line Items table directly above this button and fully visible,
          priceable and submittable in the form it opened. The hold was invisible
          because `visibleLines` (line 453) had already removed it; nothing
          removed it here.

          A hold placed BEFORE the RFQ was issued never reaches this form at all —
          rfq.service.ts excludes it from the snapshot. The leak is a hold placed
          AFTER, which is why it survived until PR-2026-201658.

          `seesHeld` is the SAME value the grid below uses, so the table and the
          form cannot disagree about which lines exist. Resolved through the shared
          rule in lib/ui rather than restated here. */}
      {quoteOpen && pr && (
        <ReceiveQuotationModal
          prId={pr.id}
          prNumber={pr.pr_number}
          lines={quotationRows(pr.lines || [], seesHeld).map(l => ({
            line_no: l.line_no,
            item_code: l.item_code,
            item_name: l.item_name,
            resolved_category: l.resolved_category,
            quantity: l.quantity,
            uom: l.uom,
            rejected: l.rejected,
          }))}
          onClose={() => setQuoteOpen(false)}
          onSaved={msg => { setQuoteOpen(false); setQuoteMsg(msg); load(); }}
        />
      )}

      {/* -- email audit trail placeholder ----------------------------- */}
      <div className="card">
        <div className="card-h"><h3>Email audit trail</h3><span className="meta">Wave 5</span></div>
        <div className="card-b empty-state">
          Notification outbox rendering lands with the notification screens.
        </div>
      </div>
    </Shell>

      {/* -- Issue RFQ / Re-issue RFQ — ONE dialog --------------------------------- */}
      {/* Prototype: lightProcIssueRFQ's dialog (lines 5069-5235), reached by BOTH
          the "Issue RFQ" and the "Re-issue RFQ" button — the prototype serves
          them from one function, so this is one panel with one header whose
          title and Send target follow `cands.already_issued`.

          Kept as an inline panel rather than a portal/modal component because
          this page has no modal primitive and the prototype's own overlay is
          plain markup.

          The difference from the prototype that matters: it opens with an EMPTY
          vendor list for the officer to pick from. Here the list arrives
          PRE-SELECTED from the PR's line categories on a first issue, because
          vendors are mapped to categories in core.vendor_categories and that
          mapping — not a human's memory — is what decides who can quote. Every
          vendor can still be unticked, which is the prototype's control
          preserved. On a re-issue the already-invited vendors are shown ticked
          and disabled instead, which is the prototype's `previouslySelected`
          made honest: re-inviting one is a no-op server-side. */}
      {revertOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Revert to HOD — ${pr?.pr_number}`}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
          onClick={e => { if (e.target === e.currentTarget) setRevertOpen(false); }}
        >
          <div
            className="card"
            style={{ width: 'min(560px, 92vw)', margin: 0 }}
            onClick={e => e.stopPropagation()}
          >
            <div className="card-h">Revert to HOD review</div>
            <div className="card-b">
              <p style={{ marginTop: 0 }}>
                <b>{pr?.pr_number}</b> goes back to the department HOD. Procurement
                cannot reject a request — the HOD owns that decision — so this is
                the whole of your authority here.
              </p>
              <label htmlFor="revert-remarks" style={{ display: 'block', marginBottom: 4 }}>
                <b>Remarks (required)</b>
              </label>
              <textarea
                id="revert-remarks"
                autoFocus
                rows={4}
                value={revertRemarks}
                placeholder="What could not be sourced, and what the HOD needs to decide…"
                onChange={e => setRevertRemarks(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitRevert();
                }}
                style={{ width: '100%', boxSizing: 'border-box' }}
              />
              {/* Says exactly what the backend will do, so there are no surprises
                  about the RFQ it is about to cancel. */}
              <p className="text-sm text-mute" style={{ marginTop: 6 }}>
                Your remarks are recorded against this PR and shown to the HOD.{' '}
                Any RFQ on this PR that has <i>never been sent to a vendor</i> will be
                cancelled. One that has live invitations is left untouched.
              </p>
              <div className="btn-row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
                <button className="btn ghost sm" disabled={actBusy} onClick={() => setRevertOpen(false)}>
                  Cancel
                </button>
                <button
                  className="btn primary sm"
                  disabled={actBusy || !revertRemarks.trim()}
                  onClick={submitRevert}
                  title={!revertRemarks.trim() ? 'Remarks are required' : undefined}
                >
                  {actBusy ? 'Reverting…' : 'Revert to HOD'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {rfqOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={cands?.already_issued
            ? `Re-issue RFQ — ${cands.rfq_number}`
            : `Issue RFQ — ${pr?.pr_number}`}
          data-rfq-dialog=""
          style={{
            position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60,
          }}
          onClick={e => { if (e.target === e.currentTarget && !rfqBusy) setRfqOpen(false); }}
        >
          <div className="card" style={{ width: 880, maxWidth: '94vw', maxHeight: '86vh', overflow: 'auto' }}>
            {/* Deadline + send live in the header. The roster is long and the
                deadline field sat under it, so the officer had to scroll past
                every vendor row to reach the two controls that actually issue
                the RFQ. Header actions stay put while the body scrolls. */}
            <div className="card-h" style={{ flexWrap: 'wrap' }}>
              <h3>
                {/* The mode is not known until /rfq/candidates answers. Naming it
                    "Issue RFQ" on the first paint asserted a mode the dialog had
                    not established yet — so a PR that already had an RFQ flashed
                    the wrong title, then corrected itself a moment later. The
                    placeholder says what is actually true at that instant. */}
                {!cands
                  ? `RFQ — ${pr?.pr_number}`
                  : cands.already_issued
                    ? `Re-issue RFQ — ${cands.rfq_number} (${pr?.pr_number})`
                    : `Issue RFQ — ${pr?.pr_number}`}
              </h3>
              {cands?.already_issued && Number(cands.reissue_count || 0) > 0 && (
                <span className="chip-reissued">
                  Re-issued &times;{Number(cands.reissue_count)}
                </span>
              )}
              {/* Loading state, so the header is never a dead strip of controls
                  while the roster is still resolving. */}
              {!cands && rfqBusy && <span className="text-sm text-mute">Resolving…</span>}
              {cands && (
                <>
                  {/* THE BLOCK. Placed ABOVE the roster on purpose: the roster is
                      the reassuring part of this screen, and a buyer who reads the
                      green ticks first has already decided to send. The dead line
                      is stated first, in the requester's own terms — which line,
                      which category, and what to do about it.

                      On a RE-ISSUE this is a WARNING, not a block: the line is
                      already on the RFQ and adding vendors cannot take it off, so
                      the only honest thing to say is that clicking Send will not
                      fix it. Refusing the dialog would leave the buyer with no
                      action at all for a problem they cannot fix here either. */}
                  {rfqBlocked ? (
                    <div className="alert error" style={{ marginBottom: 12 }}>
                      <b>This RFQ cannot be issued yet.</b>
                      <div style={{ marginTop: 4 }}>
                        {deadEnd.map(u => (
                          <div key={u.code}>
                            Line {u.lineNos.join(', ')} is categorised{' '}
                            <b>{u.name}</b>, and{' '}
                            {u.mappedCount > 0
                              ? `all ${u.mappedCount} vendor(s) mapped to it are blocked from invitation`
                              : 'no vendor is mapped to it'}
                            . Nobody can be asked to quote that line, so it would go
                            onto the RFQ, stay un-quoted, and fail at award.
                          </div>
                        ))}
                      </div>
                      <div style={{ marginTop: 6 }}>
                        Map an eligible vendor to the category, or change the line's
                        category or remove the line. Sending is blocked until then.
                      </div>
                    </div>
                  ) : deadEnd.length > 0 ? (
                    <div className="alert warn" style={{ marginBottom: 12 }}>
                      <b>Adding vendors will not fix this.</b>
                      <div style={{ marginTop: 4 }}>
                        {deadEnd.map(u => (
                          <div key={u.code}>
                            Line {u.lineNos.join(', ')} is categorised <b>{u.name}</b>, and{' '}
                            {u.mappedCount > 0
                              ? `all ${u.mappedCount} vendor(s) mapped to it are blocked from invitation`
                              : 'no vendor is mapped to it'}
                            . That line is already on {cands?.rfq_number}, so nobody can be
                            asked to quote it and it will fail at award.
                          </div>
                        ))}
                      </div>
                      <div style={{ marginTop: 6 }}>
                        You can still re-issue to widen the competition — but this line needs
                        a vendor mapping changed in Vendor Master, not another invitation.
                      </div>
                    </div>
                  ) : null}
                  <label
                    className="field"
                    style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    <span className="lbl" style={{ marginBottom: 0 }}>Quote deadline</span>
                    <input
                      type="date"
                      value={rfqDeadline}
                      min={new Date().toISOString().slice(0, 10)}
                      onChange={e => setRfqDeadline(e.target.value)}
                      disabled={rfqBusy}
                      style={{ width: 150 }}
                    />
                  </label>
                  <button
                    className="btn primary sm"
                    onClick={sendRfq}
                    // `rfqBlocked` is not decoration — see the API gate in
                    // rfq.service.issue(). This is the buyer being told early.
                    disabled={rfqBusy || rfqBlocked || nothingToDo}
                    title={
                      rfqBlocked
                        ? (heldLines.length
                            ? `Line${heldLines.length === 1 ? '' : 's'} ${heldLines.map(l => l.line_no).join(', ')} `
                              + `${heldLines.length === 1 ? 'is' : 'are'} held by HOD review and cannot be put on an RFQ.`
                            : `A line on this PR has no vendor mapped to its category.`)
                        : undefined
                    }
                  >
                    {rfqBusy
                      ? 'Sending…'
                      : rfqBlocked
                        // Name WHICH block. "Blocked — 2 line categories have no
                        // vendor" was shown on a PR whose real problem was that
                        // all four lines were held — two different fixes, and the
                        // button used to state the wrong one.
                        ? heldLines.length
                          ? `Blocked — line${heldLines.length === 1 ? '' : 's'} ${heldLines.map(l => l.line_no).join(', ')} held`
                          : `Blocked — ${deadEnd.length} line category has no vendor`
                        : cands?.already_issued
                          ? picked.length > 0
                            // Counts NEW vendors, because that is what this action
                            // adds. Saying "add 5" when 5 are already on the RFQ
                            // would credit the click with the whole roster.
                            ? `Re-issue — add ${picked.length} vendor${picked.length === 1 ? '' : 's'}`
                            // Nobody new can be added, so name what the click
                            // actually does. "Re-issue — add 0 vendors" is not a
                            // description of anything.
                            : `Re-issue — extend deadline to ${rfqDeadline || '—'}`
                          : `Send RFQ to ${picked.length} vendor(s)`}
                  </button>
                </>
              )}
              <button className="btn ghost sm" onClick={() => setRfqOpen(false)} disabled={rfqBusy}>
                Cancel
              </button>
            </div>
            <div className="card-b">
              {rfqErr && <div className="alert error" style={{ marginBottom: 12 }}>{rfqErr}</div>}

              {rfqBusy && !cands && <div className="empty-state">Resolving vendors by line category…</div>}

              {/* THE CURRENT ROSTER — shown first, and read-only.
                  This replaces the old "already has an open RFQ, go elsewhere"
                  notice, which was the reason the Re-issue action had no UI at
                  all: the dialog told the buyer to leave and use a different
                  screen instead of letting them do it here.

                  Each row is ticked and DISABLED, not merely pre-ticked: the
                  server treats a re-invitation of an existing vendor as a no-op,
                  so a live checkbox here would be a control that appears to do
                  something and does not. The response badges are the reason this
                  list is worth reading — it is how the buyer sees WHICH vendor
                  went quiet before choosing who to add. */}
              {cands?.already_issued && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ marginBottom: 6 }}>
                    <b>Already on {cands.rfq_number}</b>{' '}
                    <span className="text-sm text-mute">
                      {cands.current_vendors?.length ?? 0} invited
                      {cands.last_reissued_at
                        ? ` · last re-issued ${new Date(cands.last_reissued_at).toLocaleDateString()}`
                        : ''}
                    </span>
                  </div>
                  {(cands.current_vendors?.length ?? 0) === 0 ? (
                    <div className="alert warn">
                      This RFQ has no vendors on its roster. Pick some below to add them.
                    </div>
                  ) : (
                    <table className="t" style={{ tableLayout: 'fixed' }} data-roster="current">
                      <colgroup>
                        <col style={{ width: 34 }} />
                        <col style={{ width: '48%' }} />
                        <col style={{ width: '32%' }} />
                      </colgroup>
                      <thead>
                        <tr><th /><th>Vendor</th><th>Status</th></tr>
                      </thead>
                      <tbody>
                        {cands.current_vendors?.map(v => (
                          <tr key={v.id}>
                            <td>
                              <input
                                type="checkbox"
                                checked
                                disabled
                                aria-label={`${v.legal_name} is already on this RFQ`}
                                title="Already invited to this RFQ"
                              />
                            </td>
                            <td style={{ whiteSpace: 'nowrap' }}>
                              <span className="text-sm text-mute">{v.vendor_code}</span>{' '}
                              <b>{v.legal_name}</b>
                            </td>
                            <td>
                              <span className="pill">
                                {v.submitted ? 'Quote received'
                                  : v.declined ? 'Declined'
                                  : 'Awaiting quote'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {cands && (
                <>
                  {/* Why these vendors. The mapping is shown, not asserted, so a
                      wrong roster is visible before it is sent. */}
                  <div style={{ marginBottom: 14 }}>
                    <b>Line categories on this PR</b>
                    {cands.categories.length === 0 ? (
                      <div className="text-sm text-mute" style={{ marginTop: 4 }}>
                        {parkedLines.length > 0 ? (
                          /* An empty chip list here used to read as "no category,
                             go fix a mapping" — when the truth was that every
                             line was parked upstream and no vendor was ever
                             going to be matched. Say which of the two it is. */
                          'No line on this PR can be put on an RFQ — see the notice below.'
                        ) : (
                          'No line carries a category, so there is nothing to match vendors against.'
                        )}
                      </div>
                    ) : (
                      <div className="text-sm text-mute" style={{ marginTop: 4 }}>
                        {cands.categories.map(c => {
                          // The same dead-end list, marked where the category is
                          // first named. A buyer scanning the chips should see
                          // which one is the problem without scrolling to the
                          // explanation below.
                          const dead = deadEnd.some(u => u.code === c.code);
                          return (
                            <span
                              key={c.code}
                              className="pill"
                              style={{
                                marginRight: 6,
                                ...(dead ? { background: '#FEF2F2', color: '#991B1B', borderColor: '#FCA5A5' } : {}),
                              }}
                              title={dead ? 'No vendor is mapped to this category' : undefined}
                            >
                              {dead && '⚠ '}
                              {c.name} — lines {c.lineNos.join(', ')}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* PARKED LINES — stated, named, and separate from the roster.
                      These never reach the RFQ, so they are not vendors' problem,
                      but their absence from the chips above is otherwise invisible.
                      Blocking depends on whether anything is LEFT: a PR with two
                      held lines and three quotable ones is still sourceable, and
                      this notice must not read as a refusal in that case. */}
                  {parkedLines.length > 0 && (
                    <div className="alert warn" style={{ marginBottom: 14 }}>
                      <div style={{ marginBottom: 4 }}>
                        <b>
                          {parkedLines.length} line{parkedLines.length === 1 ? '' : 's'} on this PR
                          {' '}cannot go on an RFQ
                        </b>
                        {cands.categories.length > 0 && ' — the RFQ will carry the rest.'}
                      </div>
                      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                        {parkedLines.map(l => (
                          <li key={l.line_no}>
                            Line {l.line_no} —{' '}
                            {l.reason === 'held'
                              ? 'held by HOD review'
                              : 'nothing left to buy from store stock'}
                            {l.detail ? `: ${l.detail}` : ''}
                          </li>
                        ))}
                      </ul>
                      {cands.categories.length === 0 && (
                        <div style={{ marginTop: 6 }}>
                          Nothing on this PR is left to quote, so an RFQ cannot be issued.
                          There is no control here to release a held line — the HOD's per-line
                          decision is only editable while the PR is at HOD review — so this
                          PR has to go back through review, or be raised again without
                          those lines.
                        </div>
                      )}
                    </div>
                  )}

                  <div style={{ marginBottom: 14 }}>
                    {/* The heading is the only place the two modes can differ in
                        wording. "Vendors matched" is right for a first issue (this
                        IS the roster about to be sent); on a re-issue these are
                        candidates for ADDING, and the already-invited names are
                        listed separately above — so calling them "the roster"
                        would double-count against the table above it. */}
                    <b>{cands.already_issued ? 'Add to this RFQ' : 'Vendors matched'}</b>{' '}
                    <span className="text-sm text-mute">
                      {picked.length} of {cands.vendors.length} selected
                      {cands.withheld?.length
                        ? ` · ${cands.withheld.length} withheld`
                        : ''}
                    </span>
                  </div>

                  {/* The roster table. `tableLayout: fixed` plus the colgroup is what makes the
                      vendor column actually WIDE: under the default auto layout the
                      browser sizes every column by its longest content, and a
                      withheld row's multi-line exclusion sentence is the longest
                      string in the table — so it won the width and squeezed
                      "Acme Supplies" onto two lines. */}
                  {cands.vendors.length === 0 ? (
                    <div className="alert warn">
                      {/* An empty ADD list on a re-issue is a different fact from
                          an empty ROSTER on a first issue, and the old copy
                          ("no eligible vendor is mapped") is actively wrong
                          here: vendors ARE mapped, they are simply all already
                          invited. Saying "map one in Vendor Master" sends the
                          buyer to fix a mapping that is already correct. */}
                      {cands.already_issued
                        ? (cands.withheld?.length
                            ? `Every vendor mapped to this PR's categories is already on ${cands.rfq_number} or withheld (${cands.withheld.length} withheld, see below). Nothing can be added from here.`
                            : `Every vendor mapped to this PR's categories is already on ${cands.rfq_number}. To widen the roster, map another vendor to a line category in Vendor Master, or invite one by hand from the RFQ screen.`)
                        : cands.withheld?.length
                          ? `No eligible vendor is available: all ${cands.withheld.length} vendor(s) matched to this PR's categories are withheld (see below).`
                          : <>No eligible vendor is mapped to this PR&apos;s categories. Map one in
                            Vendor Master, or invite a vendor by hand from the RFQ screen.</>}
                    </div>
                  ) : (
                    <table className="t" style={{ marginBottom: 14, tableLayout: 'fixed' }} data-roster="addable">
                      <colgroup>
                        <col style={{ width: 34 }} />
                        <col style={{ width: '48%' }} />
                        <col style={{ width: '16%' }} />
                        <col style={{ width: '32%' }} />
                      </colgroup>
                      <thead>
                        <tr>
                          <th />
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
                            <td style={{ whiteSpace: 'nowrap' }}>
                              {/* Code first, then the legal name: the code is what
                                  the officer matches against the PR line and later
                                  the PO, and leading with it keeps the column
                                  aligned. nowrap so a legal name never breaks. */}
                              <span className="text-sm text-mute">{v.vendor_code}</span>{' '}
                              <b>{v.legal_name}</b>
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
                            <td style={{ whiteSpace: 'nowrap' }}>
                              {/* Code first, then the legal name: the code is what
                                  the officer matches against the PR line and later
                                  the PO, and leading with it keeps the column
                                  aligned. nowrap so a legal name never breaks. */}
                              <span className="text-sm text-mute">{v.vendor_code}</span>{' '}
                              <b>{v.legal_name}</b>
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
                    <table className="t" style={{ marginBottom: 14, tableLayout: 'fixed' }}>
                      <colgroup>
                        <col style={{ width: 34 }} />
                        <col style={{ width: '48%' }} />
                        <col style={{ width: '16%' }} />
                        <col style={{ width: '32%' }} />
                      </colgroup>
                      <tbody>
                        {cands.withheld.map(v => (
                          <tr key={v.id} style={{ opacity: 0.62 }}>
                            <td>
                              <input type="checkbox" checked={false} disabled
                                aria-label={`${v.legal_name} cannot be invited`} />
                            </td>
                            <td style={{ whiteSpace: 'nowrap' }}>
                              {/* Code first, then the legal name: the code is what
                                  the officer matches against the PR line and later
                                  the PO, and leading with it keeps the column
                                  aligned. nowrap so a legal name never breaks. */}
                              <span className="text-sm text-mute">{v.vendor_code}</span>{' '}
                              <b>{v.legal_name}</b>
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

                  {/* The dispatch service has no SMTP in this environment, so a
                      message is queued in core.email_outbox and written to
                      var/outbox as .eml. Saying so here is the point — the
                      button must not imply a vendor already received mail. */}
                  <div className="text-sm text-mute" style={{ marginTop: 14 }}>
                    Emails are queued in the outbox and written as .eml — no SMTP is
                    configured in this environment.
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
