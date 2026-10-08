// Actor registry — port of the prototype's LIGHT_ACTOR_REGISTRY.
//
// Routing resolves (actorRole -> costCentre -> {name, email}) so no manager
// names are hardcoded in routing logic. In production this is replaced by a
// lookup against core.users / core.authority_matrix; the registry below is the
// faithful prototype default and is what admin-editable config is seeded from.

import type { Role, ResolvedActor, Stage } from './types';

export type ActorContact = { name: string; email: string };

type RoleRegistry = Record<string, ActorContact>;

export const LIGHT_ACTOR_REGISTRY: Record<string, RoleRegistry> = {
  department_manager: {
    INVENTORY: { name: 'Sara Ahmed', email: 'sara.ahmed@pakboxes.pk' },
    FINANCE: { name: 'Imran Ali', email: 'imran.ali@pakboxes.pk' },
    OPERATIONS: { name: 'Khalid Mehmood', email: 'khalid.mehmood@pakboxes.pk' },
    IT: { name: 'Adeel Khan', email: 'adeel.khan@pakboxes.pk' },
    HR: { name: 'Ayesha Malik', email: 'ayesha.malik@pakboxes.pk' },
    _default: { name: 'Hassan Ali', email: 'hassan.ali@pakboxes.pk' },
  },
  warehouse_manager: {
    INVENTORY: { name: 'Store In-charge', email: 'store.incharge@pakboxes.pk' },
    OPERATIONS: { name: 'Warehouse Lead', email: 'warehouse.lead@pakboxes.pk' },
    _default: { name: 'Warehouse Manager', email: 'warehouse.manager@pakboxes.pk' },
  },
  store_incharge: {
    INVENTORY: { name: 'Store In-charge', email: 'store.incharge@pakboxes.pk' },
    OPERATIONS: { name: 'Floor Supervisor', email: 'floor.supervisor@pakboxes.pk' },
    _default: { name: 'Store In-charge', email: 'store.incharge@pakboxes.pk' },
  },
  procurement: {
    _default: { name: 'Hassan Ali', email: 'hassan.ali@pakboxes.pk' },
  },
  cost_center_owner: {
    INVENTORY: { name: 'Ali Khan', email: 'ali.khan@pakboxes.pk' },
    FINANCE: { name: 'Fatima Noor', email: 'fatima.noor@pakboxes.pk' },
    OPERATIONS: { name: 'Tariq Aziz', email: 'tariq.aziz@pakboxes.pk' },
    IT: { name: 'Adeel Khan', email: 'adeel.khan@pakboxes.pk' },
    HR: { name: 'Ayesha Malik', email: 'ayesha.malik@pakboxes.pk' },
    _default: { name: 'Ali Khan', email: 'ali.khan@pakboxes.pk' },
  },
  finance: {
    _default: { name: 'Bilal Hussain', email: 'bilal.hussain@pakboxes.pk' },
  },
  management: {
    _default: { name: 'Omar Sheikh', email: 'omar.sheikh@pakboxes.pk' },
  },
  it_manager: {
    IT: { name: 'Adeel Khan', email: 'adeel.khan@pakboxes.pk' },
    _default: { name: 'Adeel Khan', email: 'adeel.khan@pakboxes.pk' },
  },
  system: {
    _default: { name: 'system', email: 'system@pakboxes.pk' },
  },
};

/** Every actorRole key — feeds the Admin UI's line-rule actorRole dropdown. */
export const LIGHT_ACTOR_ROLES: string[] = Object.keys(LIGHT_ACTOR_REGISTRY);

/**
 * Resolve the actor a step routes to. Port of _lightResolveActor.
 *
 * `costCenter` is the PR's cost-centre code; falls back to `_default` in the
 * registry. Unknown roles degrade to a synthetic `<role>@pakboxes.pk` rather
 * than throwing, so an admin typo degrades gracefully instead of 500-ing.
 */
export function resolveActor(
  step: { actorRole?: Role | string } | null | undefined,
  pr?: { costCenter?: string | null } | null,
): ResolvedActor {
  const role = (step && step.actorRole) || 'system';
  const reg = LIGHT_ACTOR_REGISTRY[role];
  if (!reg) return { name: role, email: `${role}@pakboxes.pk`, role: role as Role };

  const cc = (pr && pr.costCenter) || '_default';
  const hit = reg[cc] || reg._default || { name: role, email: `${role}@pakboxes.pk` };
  return { name: hit.name, email: hit.email, role: role as Role };
}

/** Human label for a stage — port of the prototype's LIGHT_STAGE_LABEL. */
export const LIGHT_STAGES: Array<{ k: Stage; label: string }> = [
  { k: 'Submitted', label: 'Submitted' },
  { k: 'IN_HOD_REVIEW', label: 'HOD review' },
  { k: 'IN_WAREHOUSE', label: 'Warehouse' },
  { k: 'IN_IT_REVIEW', label: 'IT review' },
  { k: 'IN_WAREHOUSE_CHECK', label: 'Warehouse check' },
  { k: 'IN_PROCUREMENT_REVIEW', label: 'Procurement review' },
  { k: 'IN_COST_CENTER_APPROVAL', label: 'Cost approval' },
  { k: 'IN_FINANCE_REVIEW', label: 'Finance review' },
  { k: 'IN_MANAGEMENT_REVIEW', label: 'Management review' },
  { k: 'READY_FOR_D365', label: 'Ready for D365' },
  { k: 'D365_PUSHED', label: 'D365 pushed' },
  { k: 'CLOSED', label: 'Closed' },
  { k: 'REJECTED', label: 'Rejected' },
  { k: 'ON_HOLD', label: 'On hold' },
  { k: 'FULFILLED_FROM_STOCK', label: 'Fulfilled from stock' },
];

export const LIGHT_STAGE_LABEL: Record<string, string> =
  Object.fromEntries(LIGHT_STAGES.map(s => [s.k, s.label]));

/** Owner role per stage — drives the "My Approvals" queue filter. */
export const LIGHT_STAGE_OWNER: Record<string, Role> = {
  Submitted: 'requester',
  IN_HOD_REVIEW: 'hod',
  IN_WAREHOUSE: 'store_incharge',
  IN_IT_REVIEW: 'it_manager',
  IN_WAREHOUSE_CHECK: 'warehouse_manager',
  IN_PROCUREMENT_REVIEW: 'procurement',
  IN_COST_CENTER_APPROVAL: 'hod',
  IN_FINANCE_REVIEW: 'finance',
  IN_MANAGEMENT_REVIEW: 'management',
  READY_FOR_D365: 'procurement',
  D365_PUSHED: 'system',
  CLOSED: 'system',
  REJECTED: 'system',
  ON_HOLD: 'system',
  FULFILLED_FROM_STOCK: 'system',
};
