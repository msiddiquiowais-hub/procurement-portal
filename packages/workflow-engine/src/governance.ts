// Governance chain — port of the prototype's governance half of STAGES
// (PROCUREMENT_PORTAL_PROTOTYPE.html:1500-1522) and the MC/CFO vote rules
// (mcVote line 7221, mcAutoComplete line 7251, cfoDecide line 7264).
//
// Wave 3 step 1 of PROCUREMENT_PORTAL_PORT_GAP_MATRIX.md.
//
// WHY THIS EXISTS SEPARATELY FROM engine.ts
// `engine.ts` drives the LIGHTWEIGHT flow — the v2 stage ladder an employee PR
// walks on its own. The governance chain is a different machine: a comparative
// statement feeds a committee vote that feeds a budget sign-off, and it has
// rules the lightweight flow has no concept of (unanimity, a chair, a
// withdrawal that returns work to the originator). Mixing them into one stage
// map is how you end up unable to answer "who approved this, and what did they
// approve".
//
// NOTHING IN HERE TOUCHES THE DATABASE. Every rule is a pure function so it can
// be exhaustively unit-tested before a single endpoint exists — which is how
// "5/5 unanimity" gets proven across all 2^5 vote permutations rather than
// spot-checked.

import type { Role, Stage } from './types';

// ─── 1 · the prototype's stage vocabulary ──────────────────────────────────

export type StageDef = { k: string; label: string };

/**
 * The prototype's STAGES array, verbatim (line 1500-1510).
 *
 * The first four entries pre-date the governance chain and are carried so a
 * stage pill can render any stage the prototype can reach. The five governance
 * entries are the ones migration 027 made storable in
 * `proc.purchase_requisitions.status` — the DB value now EQUALS this string, so
 * there is no translation layer anywhere in the app.
 */
export const STAGES: StageDef[] = [
  { k: 'DRAFT', label: 'Draft created' },
  { k: 'SUBMITTED', label: 'Submitted (HOD)' },
  { k: 'HOD_APPROVED', label: 'HOD approved' },
  { k: 'QUOTES_RECEIVED', label: 'Quotes received' },
  { k: 'CS_LOCKED', label: 'CS locked' },
  { k: 'MC_APPROVED', label: 'MC approved' },
  { k: 'CFO_APPROVED', label: 'CFO approved' },
  { k: 'PACK_LOCKED', label: 'Pack locked' },
  { k: 'D365_PUSHED', label: 'Pushed to D365' },
];

export const STAGE_LABEL: Record<string, string> = Object.fromEntries(STAGES.map(s => [s.k, s.label]));

/** The five stages migration 027 added to the database CHECK constraint. */
export const GOVERNANCE_STAGES = [
  'QUOTES_RECEIVED',
  'CS_LOCKED',
  'MC_APPROVED',
  'CFO_APPROVED',
  'PACK_LOCKED',
] as const;

export type GovernanceStage = (typeof GOVERNANCE_STAGES)[number];

/**
 * A stage pill, as a CLASS plus a label — not as HTML.
 *
 * The prototype's stagePill() (line 1514) returns a hardcoded <span>. The class
 * it picks is the whole point, because the palette is semantic: `pending` is
 * amber, `locked` is violet, `pushed` is green. Returning the class and letting
 * React render the element keeps the prototype's CSS contract without dragging
 * string concatenation into the service layer.
 */
export type StagePill = { cls: string; label: string };

export function stagePill(stage: string): StagePill {
  if (stage === 'DRAFT') return { cls: 'draft', label: 'Draft' };
  if (stage === 'SUBMITTED') return { cls: 'submitted', label: 'Awaiting HOD' };
  if (stage === 'HOD_APPROVED' || stage === 'QUOTES_RECEIVED') {
    return { cls: 'pending', label: STAGE_LABEL[stage] ?? stage };
  }
  if (stage === 'CS_LOCKED' || stage === 'MC_APPROVED' || stage === 'CFO_APPROVED' || stage === 'PACK_LOCKED') {
    return { cls: 'locked', label: STAGE_LABEL[stage] ?? stage };
  }
  if (stage === 'D365_PUSHED') return { cls: 'pushed', label: STAGE_LABEL[stage] ?? stage };
  return { cls: '', label: STAGE_LABEL[stage] ?? stage };
}

// ─── 2 · the state machine ─────────────────────────────────────────────────

/**
 * Governance transitions, keyed by the stage they leave.
 *
 * This table is the TypeScript twin of the branches migration 027 added to
 * `proc.fn_check_pr_transition()`. Keeping them side by side is deliberate: the
 * repeated defect in this schema has been a stage that is STORABLE but not
 * REACHABLE (migrations 018, 019 and 020 each fixed one). `verify_027.sql`
 * section 12 reads both lists back out of the catalogue and fails if they
 * disagree, and the unit tests assert this table, so the two cannot drift
 * silently in either direction.
 *
 * The v2 lightweight ladder is NOT here — `engine.ts` owns that. Cancellation
 * from any non-terminal stage is handled separately below, exactly as the
 * trigger's trailing OR-clause does.
 */
export const GOVERNANCE_NEXT: Record<string, string[]> = {
  // A full PR sits at IN_PROCUREMENT_REVIEW for the whole sourcing block, so
  // the chain hangs off it. PACK_LOCKED from here is the FAST_TRACK shortcut
  // (prototype line 7205): MC and CFO are skipped, not "auto-approved".
  IN_PROCUREMENT_REVIEW: ['IN_COST_CENTER_APPROVAL', 'QUOTES_RECEIVED', 'CS_LOCKED', 'PACK_LOCKED'],
  // Quotes received -> CS locked, or back to sourcing to revise the RFQ.
  QUOTES_RECEIVED: ['CS_LOCKED', 'IN_PROCUREMENT_REVIEW'],
  // The two exits are the MC's approve and the MC's reject. They point in
  // OPPOSITE directions and collapsing them into one "reject -> back" rule is
  // the mistake this comment exists to prevent.
  CS_LOCKED: ['MC_APPROVED', 'QUOTES_RECEIVED', 'PACK_LOCKED'],
  // The CFO's reject returns to the MC gate, not to sourcing: the budget
  // objection is the CFO's, and the committee's unanimous recommendation stands.
  MC_APPROVED: ['CFO_APPROVED', 'CS_LOCKED'],
  CFO_APPROVED: ['PACK_LOCKED'],
  PACK_LOCKED: ['D365_PUSHED'],
  D365_PUSHED: ['Fulfilled'],
};

const REJECT_STATES = ['Rejected', 'REJECTED'];
const TERMINAL_STATES = ['D365_PUSHED', 'Fulfilled', 'Cancelled'];

/** Can the PR move from one stage to another under the governance machine? */
export function canGovernanceTransition(from: string | null | undefined, to: string): boolean {
  if (!from) return false;
  if (from === to) return true; // a no-op UPDATE is always allowed; the trigger permits it
  if (to === 'Cancelled') return !TERMINAL_STATES.includes(from);
  if (to === 'FULFILLED_FROM_STOCK') return true; // the trigger's side channel
  if (REJECT_STATES.includes(to)) return true;
  return (GOVERNANCE_NEXT[from] || []).includes(to);
}

/** Which stage this machine can reach next from `from`, in prototype order. */
export function nextGovernanceStages(from: string | null | undefined): string[] {
  if (!from) return [];
  return [...(GOVERNANCE_NEXT[from] || [])];
}

// ─── 3 · the Management Committee ──────────────────────────────────────────

/**
 * The prototype requires UNANIMITY: `votes.length >= 5 && votes.every(v =>
 * v === 'approve')` (line 7234). Four out of five does not pass.
 */
export const MC_PANEL_SIZE = 5;

export type McDecision = 'approve' | 'reject' | 'return' | 'abstain';
export type McRoundState = 'pending' | 'approved' | 'rejected';

/**
 * Resolve a vote round.
 *
 * The prototype's own order (line 7226-7234) is reject-first: a single reject
 * anywhere in the round collapses the whole thing, and `mcVotes` is cleared.
 * That asymmetry is the point — a committee that cannot reach unanimity should
 * say so immediately rather than letting four approvals accrue against one
 * objection.
 *
 * `return` and `abstain` are in the schema's CHECK for approval_votes but the
 * prototype has no UI for them, so they count as "not an approval" and never as
 * a rejection. A round nobody can complete is `pending`, and the screen keeps
 * asking — which is the honest outcome, not a silent pass.
 */
export function mcNext(
  votes: Record<string, McDecision | null | undefined> | null | undefined,
  panelSize: number = MC_PANEL_SIZE,
): McRoundState {
  const cast = Object.values(votes || {}).filter(
    (v): v is McDecision => v === 'approve' || v === 'reject' || v === 'return' || v === 'abstain',
  );
  if (cast.includes('reject')) return 'rejected';
  const approves = cast.filter(v => v === 'approve').length;
  // `>=` not `===`, because the prototype tests `votes.length >= 5`
  // (line 7234). A panel is appointed from core.users, so a sixth approval is
  // not reachable in practice — but if one ever were recorded it must not
  // silently turn a satisfied round back into a pending one.
  if (panelSize > 0 && approves >= panelSize) return 'approved';
  return 'pending';
}

/** True only on a complete round of approvals. 4/5 is NOT unanimous. */
export function isUnanimous(
  votes: Record<string, McDecision | null | undefined> | null | undefined,
  panelSize: number = MC_PANEL_SIZE,
): boolean {
  return mcNext(votes, panelSize) === 'approved';
}

/**
 * Votes cast / panel size, for the "n/5" meta chip on the MC screen
 * (`'<span class="meta">'+voteCount+'/5</span>'`, line 7881).
 */
export function mcTally(
  votes: Record<string, McDecision | null | undefined> | null | undefined,
  panelSize: number = MC_PANEL_SIZE,
): { cast: number; approves: number; rejects: number; panel: number; text: string } {
  const cast = Object.values(votes || {}).filter(
    (v): v is McDecision => v === 'approve' || v === 'reject' || v === 'return' || v === 'abstain',
  );
  const approves = cast.filter(v => v === 'approve').length;
  const rejects = cast.filter(v => v === 'reject').length;
  return {
    cast: cast.length,
    approves,
    rejects,
    panel: panelSize,
    text: `${cast.length}/${panelSize}`,
  };
}

/**
 * The prototype's copy for each MC screen state, verbatim.
 *
 * Kept here rather than in the controller so the strings and the state they
 * describe cannot drift — the alert text IS the rule, read aloud.
 */
export function mcAlert(stage: string): { cls: string; text: string } | null {
  if (stage === 'CS_LOCKED') {
    return { cls: 'warn', text: 'Voting in progress. Need 5/5 unanimous approve.' };
  }
  if (stage === 'MC_APPROVED') {
    return { cls: 'success', text: 'MC approved 5/5. Switch to CFO role for final sign-off.' };
  }
  return null;
}

/** Which roles may cast an MC vote. The prototype gates the screen to `mc`. */
export const MC_VOTE_ROLES: Role[] = ['mc', 'admin'];

/** Which roles may decide at the CFO gate. The prototype gates the screen to `cfo`. */
export const CFO_DECIDE_ROLES: Role[] = ['cfo', 'admin'];

/** Which roles may lock the approved pack (packLock, line 7282). */
export const PACK_LOCK_ROLES: Role[] = ['cs', 'procurement', 'admin'];

/** Which roles may push to D365 (d365Push, line 7293). */
export const D365_PUSH_ROLES: Role[] = ['cs', 'procurement', 'admin'];

/**
 * Who owns a stage's inbox, mirroring LIGHT_STAGE_OWNER for the governance
 * chain so the "My Approvals" queue can filter by owner.
 */
export const GOVERNANCE_STAGE_OWNER: Record<string, Role> = {
  QUOTES_RECEIVED: 'procurement',
  CS_LOCKED: 'mc',
  MC_APPROVED: 'cfo',
  CFO_APPROVED: 'cs',
  PACK_LOCKED: 'cs',
  D365_PUSHED: 'system',
};

// ─── 4 · the approved pack manifest ────────────────────────────────────────

/**
 * The six documents the prototype prints in renderPack (line 7922-7929), in
 * its own order and with its own names.
 *
 * Decision D1 replaces the prototype's `Math.random().toString(16)` column with
 * real SHA-256 digests. Decision F2 handles the consequence: on a FAST_TRACK
 * route the MC and CFO never ran, so two of these six have no content and no
 * honest digest. They are marked `skipped` rather than given a fabricated hash.
 */
export const PACK_DOCUMENT_NAMES = [
  'PR Form (signed)',
  'Vendor quotes (3)',
  'Comparative Statement (locked)',
  'MC vote record',
  'CFO approval',
  'Internal compliance checklist',
] as const;

/** Which manifest slot each document name draws its digest from. */
export type PackDocumentSlot =
  | 'pr_form'
  | 'vendor_quotes'
  | 'comparative_statement'
  | 'mc_vote_record'
  | 'cfo_approval'
  | 'compliance_checklist';

export type PackDocumentState =
  /** A real digest was recorded. Render the hash. */
  | 'present'
  /** Deliberately not produced — FAST_TRACK skipped this gate. Never hash it. */
  | 'skipped'
  /** Should exist on this route but no digest was recorded. A real gap; render an em-dash. */
  | 'missing';

export type PackDocument = {
  /** The prototype's own label, unmodified. */
  name: string;
  state: PackDocumentState;
  /** Never fabricated. Null means "render —", full stop. */
  sha256: string | null;
  /** Where a real digest came from: a stored file, or a hashed record. */
  source: 'file' | 'record' | null;
  slot: PackDocumentSlot;
  /** Only set when state is 'skipped' or 'missing'. */
  note?: string;
};

/** The slot each of the prototype's six names maps to, in the same order. */
const PACK_SLOTS: PackDocumentSlot[] = [
  'pr_form',
  'vendor_quotes',
  'comparative_statement',
  'mc_vote_record',
  'cfo_approval',
  'compliance_checklist',
];

export type PackDigests = Partial<Record<PackDocumentSlot, string | null>>;

export type PackContext = {
  routingKey: string | null | undefined;
  /** Real timestamps, or null if the gate never ran. */
  mcApprovedAt?: string | null;
  cfoApprovedAt?: string | null;
  digests?: PackDigests;
  /**
   * Which digests came from a stored file in core.files versus a record hashed
   * from its canonical JSON. Defaults to 'record' for a present document.
   */
  sources?: Partial<Record<PackDocumentSlot, 'file' | 'record'>>;
};

/** FAST_TRACK skips the MC and CFO entirely (prototype line 7205). */
const FAST_TRACK = 'FAST_TRACK';

/**
 * Build the pack manifest.
 *
 * The rule throughout: a digest is either real or absent. There is no third
 * option, and no fallback that invents one. That is the whole point of D1 — the
 * prototype's hash column was decorative, and a decorative hash in a governance
 * pack is worse than a blank cell because it looks like evidence.
 */
export function packDocuments(ctx: PackContext): PackDocument[] {
  const fastTrack = (ctx.routingKey || 'STANDARD') === FAST_TRACK;
  const digests = ctx.digests || {};
  const sources = ctx.sources || {};

  return PACK_DOCUMENT_NAMES.map((name, i) => {
    const slot = PACK_SLOTS[i];
    const digest = digests[slot] ?? null;

    // A gate that never ran cannot have produced a document. Say so, in words,
    // rather than printing an empty hash beside an approval nobody gave.
    const gateNeverRan =
      (slot === 'mc_vote_record' || slot === 'cfo_approval') &&
      (fastTrack || !(slot === 'mc_vote_record' ? ctx.mcApprovedAt : ctx.cfoApprovedAt));

    if (gateNeverRan) {
      return {
        name,
        slot,
        sha256: null,
        source: null,
        state: 'skipped' as const,
        note: fastTrack ? 'Skipped (FAST_TRACK)' : 'Gate not reached',
      };
    }

    if (!digest) {
      return {
        name,
        slot,
        sha256: null,
        source: null,
        state: 'missing' as const,
        note: 'No digest recorded',
      };
    }

    return { name, slot, sha256: digest, source: sources[slot] || 'record', state: 'present' as const };
  });
}

/**
 * Truncate a digest the way the prototype's column does — 8 hex characters
 * plus an ellipsis (line 7946). The prototype generated 8 random characters; we
 * show the first 8 of the real digest, so the column looks identical and the
 * value means something.
 */
export function formatDigest(sha256: string | null | undefined, chars = 8): string {
  if (!sha256) return '—';
  // Tolerate the proc.fn_pack_hash() 'sha256:<hex>' wrapper.
  const hex = sha256.includes(':') ? sha256.slice(sha256.indexOf(':') + 1) : sha256;
  if (hex.length <= chars) return hex;
  return `${hex.slice(0, chars)}…`;
}

/**
 * A pack is pushable only once locked, and the prototype's d365Push() refuses
 * with "Pack not yet locked." (line 7294). Decision 10 makes the FAST_TRACK
 * auto-lock live in the service, so by the time the D365 screen reads this the
 * pack is either frozen or absent.
 */
export function canPushToD365(stage: string, packLocked: boolean): boolean {
  return stage === 'PACK_LOCKED' && packLocked;
}

// ─── 5 · the CFO's screen ──────────────────────────────────────────────────

/**
 * The CFO pack summary (renderCFO, line 7901-7910), in the prototype's order,
 * with each value's provenance made explicit.
 *
 * "MC vote — 5/5 unanimous" is a real count. "Risk class" is NOT: the prototype
 * hardcodes "Medium — within delegation", and decision F1 requires a derived
 * value or an em-dash rather than a risk rating the system never computed.
 */
export type CfoSummaryRow = {
  key: string;
  label: string;
  value: string;
  /** True when the value could not be derived and the em-dash is deliberate. */
  unknown?: boolean;
};

export function cfoSummary(input: {
  winnerName: string | null;
  amountText: string | null;
  capexAmount: number | null;
  opexAmount: number | null;
  capexGlText: string | null;
  opexGlText: string | null;
  expenseSplit: string | null;
  mcApproves: number;
  mcPanelSize: number;
  riskClass: string | null;
}): CfoSummaryRow[] {
  const budgetSource =
    input.expenseSplit === 'CAPEX' ? 'IT Capex FY26 Q1'
    : input.expenseSplit === 'OPEX' ? 'Opex FY26 Q1'
    : 'Mixed: IT Capex (capex lines) + Stationery Opex (opex lines)';

  return [
    { key: 'vendor', label: 'Vendor', value: input.winnerName || '—', unknown: !input.winnerName },
    { key: 'total', label: 'Total amount', value: input.amountText || '—', unknown: !input.amountText },
    {
      key: 'capex',
      label: 'Capex portion',
      value: input.capexAmount === null ? '—' : `PKR ${input.capexAmount.toLocaleString('en-PK')} → ${input.capexGlText || '—'}`,
      unknown: input.capexAmount === null,
    },
    {
      key: 'opex',
      label: 'Opex portion',
      value: input.opexAmount === null ? '—' : `PKR ${input.opexAmount.toLocaleString('en-PK')} → ${input.opexGlText || '—'}`,
      unknown: input.opexAmount === null,
    },
    { key: 'budget', label: 'Budget source', value: budgetSource },
    {
      key: 'mc',
      label: 'MC vote',
      value: `${input.mcApproves}/${input.mcPanelSize} unanimous`,
      unknown: input.mcApproves === 0,
    },
    {
      key: 'risk',
      label: 'Risk class',
      value: input.riskClass || '—',
      unknown: !input.riskClass,
    },
  ];
}

/** The prototype's CFO alerts (line 7899-7900). */
export function cfoAlert(stage: string): { cls: string; text: string } | null {
  if (stage === 'MC_APPROVED') {
    return { cls: 'warn', text: 'MC approved 5/5. Awaiting CFO final budget sign-off.' };
  }
  if (stage === 'CFO_APPROVED') {
    return { cls: 'success', text: 'CFO approved. CS can now lock the approved pack.' };
  }
  return null;
}

/** Narrow a wide stage string to the governance union, or null if it is not one. */
export function asGovernanceStage(stage: Stage | string | null | undefined): GovernanceStage | null {
  const s = String(stage ?? '');
  return (GOVERNANCE_STAGES as readonly string[]).includes(s) ? (s as GovernanceStage) : null;
}
