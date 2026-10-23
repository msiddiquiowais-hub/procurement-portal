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
  /**
   * RETIRED as an actor (migration 070). Procurement is a department under the
   * same HOD hierarchy as Finance, HR, IT and Operations, so its head is a
   * `hod` whose identity comes from core.departments — there is no
   * procurement-specific role and nothing was ever assigned this one.
   *
   * Kept in the union deliberately: it is the vocabulary `validateStepConfig`
   * accepts, and a saved config from before 070 must still load rather than
   * fail to parse. No DEFAULT step names it.
   */
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
  /**
   * Procurement sends the PR back to the HOD with remarks.
   *
   * NOT a rejection. Procurement is a sourcing function, not the demand owner,
   * so it cannot kill a PR — it can only return it to the party that owns the
   * demand decision. The HOD then cancels or fixes it.
   */
  revertToHod?: boolean;
  reassign?: boolean;
  mgtRejected?: boolean;
  /**
   * The CS comparative-statement review chain reached CS_CONFIRMED (migration
   * 065). Carried on the decision so the cs_review step matches on that one
   * advance and no other.
   */
  csReviewConfirmed?: boolean;
  /**
   * Procurement forwards the finished competition to the comparative statement
   * (migration 064).
   *
   * The `ready_for_cs` step was seeded with a `readyForCs` condition that the
   * predicate vocabulary did not contain, and an unrecognised keyword is
   * coerced to 'always' by evaluatePredicate(). The step was therefore inert
   * ONLY because its order_index sat below the `procurement` step that owns the
   * same stage — move it up without fixing the keyword and it hijacks every
   * advance out of IN_PROCUREMENT_REVIEW. The keyword now exists so the step
   * means what it says and can be ordered honestly.
   */
  readyForCs?: boolean;
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
  /**
   * The per-line Capex/Opex class: one of the five `pr_lines_classification_check`
   * values, or null/undefined when the line has never been classified.
   *
   * Carried HERE, on the line the predicate reads, rather than as a decision flag
   * on the advance. A flag would be a CLAIM made by whoever pressed the button —
   * anyone could post `capexOpexClassified: true` and walk the gate without
   * classifying a thing. This is the recorded fact, read from proc.pr_lines by
   * the service that builds the snapshot, and it cannot be asserted.
   *
   * Null means unclassified. It is NOT defaulted to a class, and an absent
   * `classification` is treated exactly like an explicit null by the predicate:
   * silence is not an answer.
   */
  classification?: string | null;
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
