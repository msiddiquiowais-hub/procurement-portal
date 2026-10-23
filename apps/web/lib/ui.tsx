// Shared UI atoms ported from the prototype. Every value here is copied from
// PROCUREMENT_PORTAL_PROTOTYPE.html so the ported screens render identically —
// do not restyle these in place; the prototype is the source of truth.

import {
  stageDepartmentLabel,
  stageOwnerRole,
  type Role,
  type Stage,
} from '@procurement/workflow-engine';

/**
 * Which roles keep HOD-held lines in view.
 *
 * A line the HOD put on hold stops at that stage: it must not reach Procurement or
 * any later one. The API returns every line with no role filter at all, so this is
 * the entire control until global RBAC exists — which is why the rule lives in ONE
 * place. /pr (the grid) and /pr/[id] (the detail) both call it, and they were
 * written separately; two copies of "who may see a hold" is precisely how a stage
 * leak survives a fix to one screen.
 *
 * HOD and requester keep seeing them: the HOD owns the disposition and acts on it,
 * and the requester raised the line and needs to see why it stopped. Everyone
 * downstream does not. `admin` is the union of every stage's permissions, so it
 * sits downstream of the HOD here too.
 */
export const SEES_HELD_LINES = ['hod', 'requester'] as const;

export function seesHeldLines(role: string): boolean {
  return (SEES_HELD_LINES as readonly string[]).includes(role);
}

/**
 * Drop held lines from a list for anyone who may not act on them.
 *
 * Apply this BEFORE deriving anything else from the list — chip previews, the
 * "+N more" overflow and a single-line title fallback all read the result. Deriving
 * them from different sets is what produces a screen whose chips and count quietly
 * disagree.
 */
// TODO (RBAC): Temporary UI-level filter. Move this filtering logic to the backend API once global Role-Based Access Control is implemented.
export function visibleItems<T extends object>(
  items: T[],
  seesHeld: boolean,
): T[] {
  // Read through a cast because `held` is genuinely absent on some callers' line
  // types (an undecided line need not carry the field at all), and a generic
  // constrained to `{ held?: … }` rejects an object that omits it entirely.
  return seesHeld ? items : items.filter(l => !(l as { held?: boolean | null }).held);
}

/**
 * Revert-to-HOD is procurement's only outward action, and it stops the moment
 * procurement has run a live competition.
 *
 * The threshold is ONE vendor invited — not a received quote. A solicitation with a
 * live deadline and no reply has already left procurement's hands; vendors hold a
 * promise that this requisition can no longer honour. An RFQ with an empty roster
 * was never shown to anyone, and reverting there still works: the server cancels it.
 *
 * `PrService.revertToHod` enforces the identical threshold server-side, and that is
 * the control. This exists so the button reflects it instead of offering a click
 * that will be refused.
 */
export function revertBlockedByRfq(invitations: number): boolean {
  return Number(invitations) > 0;
}

/**
 * Stage pill. Port of the prototype's lightStagePill / stagePill: the stage key
 * is humanised, and the colour band tracks where the PR sits in the flow.
 */
const TONE: Record<string, string> = {
  Submitted: 'info',
  IN_HOD_REVIEW: 'warn',
  IN_IT_REVIEW: 'warn',
  IN_WAREHOUSE: 'warn',
  IN_WAREHOUSE_CHECK: 'warn',
  IN_PROCUREMENT_REVIEW: 'warn',
  IN_COST_CENTER_APPROVAL: 'warn',
  IN_FINANCE_REVIEW: 'warn',
  IN_MANAGEMENT_REVIEW: 'warn',
  READY_FOR_D365: 'info',
  D365_PUSHED: 'success',
  FULFILLED_FROM_STOCK: 'success',
  CLOSED: 'success',
  Fulfilled: 'success',
  Final_Approved: 'success',
  Pushed_To_D365: 'success',
  SPLIT: 'info',
  Split: 'info',
  ON_HOLD: 'warn',
  On_Hold: 'warn',
  REJECTED: 'danger',
  Rejected: 'danger',
  RETURNED: 'warn',
  Returned: 'warn',
  Draft: '',
};

export function StagePill({ stage }: { stage: string }) {
  const tone = TONE[stage] ?? '';
  // `stageDepartmentLabel`, not LIGHT_STAGE_LABEL. The five Wave-3 governance
  // statuses live in the same `pr.status` column but are not part of the stage
  // vocabulary, so a raw lookup fell through to snake-case and rendered
  // "Quotes received" / "Pack locked" / "Cs locked" in the column that answers
  // "whose desk is this on?" — 221 PRs, 17% of the visible grid. This resolves
  // them to the department that actually holds the PR.
  return <span className={`pill${tone ? ' ' + tone : ''}`}>{stageDepartmentLabel(stage)}</span>;
}

export function stageLabel(stage: string): string {
  return stageDepartmentLabel(stage);
}

export function stageOwner(stage: string): Role | undefined {
  // `stageOwnerRole`, not LIGHT_STAGE_OWNER: the five Wave-3 governance states
  // had no entry, so every one of the 221 PRs on them rendered "Stage owner is
  // system" — wrong (CS and MC own them) and unhelpful (it names nowhere to go).
  //
  // The engine's signature takes the closed `Stage` union and returns `string`
  // with a `'system'` fallback; PR statuses arrive from the DB as plain strings
  // and can carry values outside the union, so the boundary casts rather than
  // pretending the type is narrower than it is. The `'system'` literal is
  // preserved for stages that genuinely have no owner.
  const role = stageOwnerRole(stage as Stage);
  return role === 'system' ? undefined : (role as Role);
}

/** PKR formatting, matching the prototype's toLocaleString('en-US') usage. */
export function pkr(n: number | string | null | undefined): string {
  const v = Number(n || 0);
  return 'PKR ' + v.toLocaleString('en-US');
}

/**
 * PKR, or an em-dash when the figure is genuinely unknown.
 *
 * `pkr()` coerces null to 0, which is right for arithmetic funnel — a NaN in a
 * running total is worse than a zero — but wrong for a price that nobody has
 * stated. A line with no estimate printed "PKR 0", which reads as a QUOTE: the
 * screen asserted the item was free when the truth was that its cost is unknown.
 * The same PR showed "Estimated amount: not set yet" in the header card directly
 * above it, because that card reads `amount_status` (migration 046) while the
 * line did not.
 *
 * So the em-dash is not a cosmetic choice. It restores the distinction the schema
 * already draws between "free" and "unknown" — an explicit 0 still prints PKR 0
 * here, because a requester can genuinely mean free and that is an answer.
 */
export function pkrOrDash(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === '') return '—';
  return pkr(n);
}

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function initials(name?: string | null): string {
  if (!name) return '?';
  return name.split(/\s+/).slice(0, 2).map(p => p[0]).join('').toUpperCase();
}

export function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().slice(0, 10);
}

export function fmtDateTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * Item preview chips — first two lines plus an overflow chip. Port of the
 * prototype's `itemChips` in renderLightPRList.
 */
export function ItemChips({
  items, overflow, max = 2,
}: {
  items: Array<{ qty: number; uom: string; description: string | null }>;
  overflow?: number;
  max?: number;
}) {
  if (!items.length) return <span className="text-mute">—</span>;
  const shown = items.slice(0, max);
  const more = (overflow ?? Math.max(0, items.length - max));
  return (
    <div className="item-chip-row">
      {shown.map((it, i) => {
        const d = (it.description || '').trim();
        const short = d.length > 28 ? d.slice(0, 26) + '…' : d;
        return (
          <span key={i} className="item-chip-prev" title={d}>
            {it.qty} {it.uom} × {short || '—'}
          </span>
        );
      })}
      {more > 0 && <span className="item-chip-more">+{more} more</span>}
    </div>
  );
}

export function DeptChip({ name }: { name?: string | null }) {
  return <span className="dept-chip">{name || '—'}</span>;
}
