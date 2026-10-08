// Shared UI atoms ported from the prototype. Every value here is copied from
// PROCUREMENT_PORTAL_PROTOTYPE.html so the ported screens render identically —
// do not restyle these in place; the prototype is the source of truth.

import { LIGHT_STAGE_LABEL, LIGHT_STAGE_OWNER, type Role, type Stage } from '@procurement/workflow-engine';

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
  const label = LIGHT_STAGE_LABEL[stage]
    || stage.replace(/_/g, ' ').toLowerCase().replace(/^./, c => c.toUpperCase());
  return <span className={`pill${tone ? ' ' + tone : ''}`}>{label}</span>;
}

export function stageLabel(stage: string): string {
  return LIGHT_STAGE_LABEL[stage]
    || stage.replace(/_/g, ' ').toLowerCase().replace(/^./, c => c.toUpperCase());
}

export function stageOwner(stage: string): Role | undefined {
  return LIGHT_STAGE_OWNER[stage] as Role | undefined;
}

/** PKR formatting, matching the prototype's toLocaleString('en-US') usage. */
export function pkr(n: number | string | null | undefined): string {
  const v = Number(n || 0);
  return 'PKR ' + v.toLocaleString('en-US');
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
