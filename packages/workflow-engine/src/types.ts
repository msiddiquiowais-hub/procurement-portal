// Procurement workflow engine — shared types.
// Mirrors PROCUREMENT_PORTAL_PROTOTYPE.html DEFAULT_WORKFLOW_STEPS + status vocabulary.
//
// v2.1.0 — ported the prototype's v2.0.x-workflow-config-line-routing feature:
// item categories, per-step `lineRules[]`, and PR auto-splitting (B1 of
// PROCUREMENT_PORTAL_PORT_GAP_MATRIX.md).

export type Role =
  | 'requester'
  | 'hod'
  | 'department_manager'
  | 'procurement'
  | 'procurement_manager'
  | 'cs'
  | 'cost_center_owner'
  | 'finance'
  | 'management'
  | 'mc'
  | 'cfo'
  | 'audit'
  | 'hr'
  | 'store_incharge'
  | 'warehouse_manager'
  | 'it_manager'
  | 'system'
  | 'vendor'
  | 'public'
  | 'admin';

// The live prototype's role alias: 'admin' maps to the union of all internal
// roles. We replicate that here so the backend can accept an admin login
// without remapping to a specific role.
export const ADMIN_ALIAS: Role[] = [
  'cs', 'procurement', 'cfo', 'hod', 'finance',
  'management', 'mc', 'warehouse_manager',
];

/**
 * Stage vocabulary. The first 13 entries are the prototype's LIGHT_STAGES.
 * `IN_IT_REVIEW` and `IN_WAREHOUSE` are line-rule routing targets — they only
 * ever appear on a *child* PR produced by an auto-split, never on the parent.
 *
 * The last five are the prototype's GOVERNANCE stages, added in Wave 3. They
 * are in the SAME union rather than a separate one because the database stores
 * them in the same column: migration 027 put `QUOTES_RECEIVED`, `CS_LOCKED`,
 * `MC_APPROVED`, `CFO_APPROVED` and `PACK_LOCKED` into
 * `purchase_requisitions_status_check`, so `pr.status` can legitimately hold
 * either ladder. Which machine a stage belongs to is a question about TRANSITIONS
 * (see governance.ts), not about the value — which is exactly why splitting the
 * type would have bought clarity on paper and a cast on every read.
 */
export type Stage =
  | 'Draft'
  | 'Submitted'
  | 'IN_HOD_REVIEW'
  | 'IN_WAREHOUSE'
  | 'IN_IT_REVIEW'
  | 'IN_PROCUREMENT_REVIEW'
  | 'IN_WAREHOUSE_CHECK'
  | 'IN_COST_CENTER_APPROVAL'
  | 'IN_FINANCE_REVIEW'
  | 'IN_MANAGEMENT_REVIEW'
  | 'READY_FOR_D365'
  | 'D365_PUSHED'
  | 'FULFILLED_FROM_STOCK'
  | 'CLOSED'
  | 'REJECTED'
  | 'RETURNED'
  | 'ON_HOLD'
  | 'SPLIT'
  // v3 prototype governance vocabulary (Wave 3, decision 1A).
  | 'QUOTES_RECEIVED'
  | 'CS_LOCKED'
  | 'MC_APPROVED'
  | 'CFO_APPROVED'
  | 'PACK_LOCKED';

// Item categories — the prototype's LIGHT_ITEM_CATEGORIES. A line's category is
// resolved from an explicit value, else inferred from financialDimensions.
export type ItemCategory =
  | 'IT_HARDWARE'
  | 'IT_SOFTWARE'
  | 'OFFICE_SUPPLIES'
  | 'WAREHOUSE_ACCESSORY'
  | 'MACHINERY'
  | 'PROFESSIONAL_SERVICES'
  | 'FACILITIES'
  | 'MARKETING'
  | 'OTHER';

export type Decision = {
  wantWarehouse?: boolean;
  inStock?: boolean;
  outOfStock?: boolean;
  lineRejected?: boolean;
  lineHeld?: boolean;
  rework?: boolean;
  reworkRequested?: boolean;
  reassign?: boolean;
  mgtRejected?: boolean;
  /**
   * Per-line HOD disposition keyed by zero-based line index. Carried on the
   * decision so an advance can approve/reject/hold individual lines in one
   * call; the service persists it to proc.pr_lines and the line-routing
   * evaluator filters on it.
   */
  lineDecisions?: Record<number, LineDecision>;
  // Free-form text / reason captured for the audit log.
  reason?: string;
};

/** Per-line HOD disposition. Mirrors the prototype's `pr.hodLineDecisions`. */
export type LineDecision = 'approved' | 'rejected' | 'held';

export type PrLine = {
  lineNo?: number;
  itemCode?: string;
  itemName?: string;
  itemCategory: string;     // e.g. 'CARDBOARD' | 'WAREHOUSE_ACCESSORY' | 'IT_HARDWARE'
  amount: number;           // line total in PR currency
  // Line-routing inputs. The prototype derives the category from
  // financialDimensions.ItemGroup when it is not set explicitly; we keep the
  // raw bag so `resolveLineCategory` can do the same inference.
  category?: string;
  qty?: number;
  unitPrice?: number;
  financialDimensions?: Record<string, string>;
  approved?: boolean;
  rejected?: boolean;
  held?: boolean;
  preferredVendorId?: string | null;
  description?: string | null;
};

export type PrSnapshot = {
  id: string;
  prNumber: string;
  status: Stage;
  /**
   * The PR's monetary amount. Null/undefined means the price is not known yet
   * — a requisition legitimately reaches this state before the RFQ quotes come
   * back, and it must not be flattened to 0 (see predicates.amountUnknown).
   */
  estimatedAmount: number | null;
  /**
   * 'ESTIMATED' when the requester supplied a price, 'UNKNOWN' when they did
   * not. Carried explicitly so an amount of 0 can be told apart from an amount
   * nobody has established: 0 is a real, cheap answer, UNKNOWN is no answer.
   */
  amountStatus?: 'ESTIMATED' | 'UNKNOWN';
  expenseType: 'CAPEX' | 'OPEX' | 'MIXED';
  lines: PrLine[];
  warehouseCheckRequired?: boolean;
  warehouseManagerId?: string | null;
  warehouseDecision?: 'in_stock' | 'out_of_stock' | null;
  decisionLog?: Array<{ step: string; ts: string; decision: Decision }>;
  // Line-routing context (B1/B3). The prototype carries these on the PR object.
  title?: string | null;
  description?: string | null;
  department?: string | null;      // cost-centre code, e.g. 'IT' — actor resolution key
  costCenter?: string | null;
  purpose?: string | null;
  /** Per-line HOD disposition keyed by zero-based line index. */
  lineDecisions?: Record<number, LineDecision>;
  parentPrId?: string | null;
};

/** Numeric operators for `LineRule.amountOp` — the prototype's LIGHT_AMOUNT_OPS. */
export type AmountOp = '>' | '>=' | '<' | '<=' | '=' | '!=';

/**
 * A per-line routing rule attached to a step. Evaluated against each *approved*
 * line; the first matching rule wins (prototype: first-match-wins, not
 * most-specific-wins).
 */
export type LineRule = {
  category?: ItemCategory[] | ItemCategory;
  amountOp?: AmountOp;
  amountValue?: number;
  routeTo: Stage;
  actorRole: Role;
  reason: string;
};

/** One resolved routing destination produced by evaluating lineRules. */
export type RouteTarget = {
  routeTo: Stage;
  actorRole: Role;
  reason: string;
  lineIdxs: number[];
  totalAmount: number;
};

export type LineRuleEvaluation = {
  needsSplit: boolean;
  perLine: Array<{
    lineIdx: number;
    line: PrLine;
    rule: LineRule;
    routeTo: Stage;
    actorRole: Role;
  }>;
  targets: RouteTarget[];
  /** Set when every matching line resolved to the same destination. */
  singleTarget: RouteTarget | null;
};

export type Step = {
  key: string;                 // e.g. 'hod_review'
  from: Stage | '*';           // current PR stage the step applies to
  to: Stage;                   // target stage when this step matches
  order: number;
  name?: string;
  actorRole?: Role;
  /**
   * Condition keyword from PREDICATE_VOCABULARY. This is DATA, evaluated by
   * `evaluatePredicate` — it is not a function, so it round-trips through
   * workflow.steps_config and is editable by an admin. Absent means 'always'.
   */
  when?: string;
  /** Parameterised amount threshold read by amount* predicates. */
  conditionValue?: number;
  /** When true the step forces a CAPEX/OPEX classification before it can fire. */
  requiresCapexOpex?: boolean;
  terminal?: boolean;
  canSkip?: boolean;
  /** Per-line routing rules. See PROCUREMENT_PORTAL_PORT_GAP_MATRIX.md B1. */
  lineRules?: LineRule[];
};

/**
 * The single value the engine accepts to route anything.
 *
 * Both members are required and there is no default. That is the whole point of
 * the Part 7 remediation: the engine cannot be called without someone handing
 * it a routing table, so it is impossible to accidentally route off a hardcoded
 * constant. The API layer's job is to load this from workflow.steps_config.
 */
export type RoutingConfig = {
  steps: Step[];
  /** Live management threshold in PKR. Read by the *MgtThreshold predicates. */
  managementThreshold: number;
};

export type Actor = {
  userId: string;
  role: Role;
  costCenterIds: string[];
};

export type ResolvedActor = {
  name: string;
  email: string;
  role: Role;
};
