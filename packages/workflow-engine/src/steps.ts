// CANONICAL DEFAULT WORKFLOW STEPS — data, not behaviour.
//
// ---------------------------------------------------------------------------
// READ THIS BEFORE EDITING. The authority question matters more here than
// anywhere else in the engine.
// ---------------------------------------------------------------------------
//
// This array is NOT the engine's source of truth. It is three things, and only
// three things:
//
//   1. The seed for workflow.steps_config (migration 008 + 029).
//   2. The explicit fallback when the config table is empty or unreadable,
//      via `loadStepsOrFallback` in apps/api/src/workflow/workflow.repository.ts.
//   3. The target of the Part 7 "Reset to defaults" button.
//
// The engine NEVER imports these for routing. `engine.ts` takes `steps` as a
// required argument precisely so that no code path can quietly re-couple
// routing to this constant. If you find yourself wanting to import
// DEFAULT_WORKFLOW_STEPS inside engine.ts, the dependency you actually want is
// `WorkflowConfig` loaded from the database.
//
// Every condition is a `when` KEYWORD plus a numeric `conditionValue`, both of
// which round-trip through the database. The previous implementation used
// `predicate: (pr) => pr.estimatedAmount >= 1_000_000` — a closure that captured
// its own threshold, making `conditionValue` a decorative field that an admin
// could edit forever without changing a single route.
//
// Semantics that must NOT drift, because they are governance rules:
//   - finance_review uses amountGTE and finance_release uses amountLT. Together
//     they are complementary and EXACTLY ONE of them matches any amount, so a
//     PR of precisely the threshold still clears Management. Seeded as
//     amountGT/amountLTE by migration 008 — which made the boundary amount skip
//     the Management gate. Corrected in migration 029.

import type { Step, Stage, Role, LineRule, RoutingConfig } from './types';
import type { PredicateKeyword } from './predicates';
import { isPredicateKeyword, isAmountPredicate, MGMT_THRESHOLD_PREDICATES } from './predicates';

/** Canonical default management threshold, in PKR. */
export const DEFAULT_MANAGEMENT_THRESHOLD = 1_000_000;

/** The routing table the admin maintains. Order is presentation; routing uses
 *  the per-step `order` and the `from` stage filter. */
export const DEFAULT_WORKFLOW_STEPS: Step[] = [
  // ─── Side-channel steps (require an explicit decision flag to fire) ───────
  {
    key: 'rework',
    name: 'Sent back for rework',
    actorRole: 'requester',
    from: '*',
    to: 'IN_PROCUREMENT_REVIEW',
    order: 1,
    when: 'reworkRequested',
    canSkip: false,
    terminal: false,
  },
  {
    key: 'reject',
    name: 'Rejected',
    actorRole: 'system',
    from: '*',
    to: 'REJECTED',
    order: 2,
    when: 'lineRejected',
    canSkip: false,
    terminal: true,
  },
  {
    key: 'fulfilled_stock',
    name: 'Fulfilled from stock',
    actorRole: 'system',
    from: '*',
    to: 'FULFILLED_FROM_STOCK',
    order: 3,
    when: 'inStock',
    canSkip: false,
    terminal: true,
  },
  {
    key: 'out_of_stock',
    name: 'Out of stock (forward)',
    actorRole: 'procurement',
    from: '*',
    to: 'IN_PROCUREMENT_REVIEW',
    order: 4,
    when: 'outOfStock',
    canSkip: false,
    terminal: false,
  },
  {
    key: 'warehouse_check',
    name: 'Warehouse stock check',
    actorRole: 'store_incharge',
    // Scoped to IN_HOD_REVIEW, the stage a submitted PR is auto-routed into.
    // The engine filters candidates on `from`, so a PR awaiting the HOD has to
    // match here or this branch silently stops firing. See migration 053.
    from: 'IN_HOD_REVIEW',
    to: 'IN_WAREHOUSE_CHECK',
    order: 5,
    when: 'wantWarehouse',
    canSkip: true,
    terminal: false,
  },

  // ─── Main flow (auto-walked after each successful advance) ───────────────
  {
    key: 'hod_review',
    name: 'Department review',
    actorRole: 'department_manager',
    // `from` is the stage the PR sits in WHILE AWAITING this step, not the stage
    // it lands on. It was 'Submitted', which was true only because create() never
    // auto-routed; the prototype submits straight into HOD review. `to` is
    // unchanged and is where the PR goes once the HOD approves.
    from: 'IN_HOD_REVIEW',
    to: 'IN_PROCUREMENT_REVIEW',
    order: 6,
    when: 'always',
    canSkip: false,
    terminal: false,
    // Default fallthrough when no line rule matches. Line rules below override
    // this per line and can split the PR across multiple destinations.
    lineRules: [
      {
        category: ['IT_HARDWARE', 'IT_SOFTWARE'],
        amountOp: '>',
        amountValue: 100_000,
        routeTo: 'IN_IT_REVIEW' as Stage,
        actorRole: 'it_manager' as Role,
        reason: 'High-value IT line > PKR 100,000 routes to IT Manager.',
      },
      {
        category: ['IT_HARDWARE', 'IT_SOFTWARE'],
        routeTo: 'IN_PROCUREMENT_REVIEW' as Stage,
        actorRole: 'procurement' as Role,
        reason: 'Standard IT line, route to Procurement for RFQ.',
      },
      {
        category: ['OFFICE_SUPPLIES', 'WAREHOUSE_ACCESSORY'],
        routeTo: 'IN_WAREHOUSE' as Stage,
        actorRole: 'store_incharge' as Role,
        reason: 'Standard accessory / supply, route to Warehouse for stock check.',
      },
    ],
  },
  {
    key: 'procurement',
    name: 'Procurement review',
    actorRole: 'procurement',
    from: 'IN_PROCUREMENT_REVIEW',
    to: 'IN_COST_CENTER_APPROVAL',
    order: 7,
    when: 'always',
  },
  {
    key: 'cost_center',
    name: 'Cost approval',
    actorRole: 'cost_center_owner',
    from: 'IN_COST_CENTER_APPROVAL',
    to: 'IN_FINANCE_REVIEW',
    order: 8,
    when: 'always',
  },
  {
    key: 'finance_review',
    name: 'Management review (global threshold)',
    actorRole: 'finance',
    from: 'IN_FINANCE_REVIEW',
    to: 'IN_MANAGEMENT_REVIEW',
    order: 9,
    // Reads the GLOBAL management threshold, not a number of its own. Kept in
    // step with migration 035: when these steps carried duplicated
    // conditionValues, `POST /workflow/config/reset` wrote these in-code defaults
    // back over the live rows and silently REVERTED the single-sourced gate,
    // re-introducing the two-number dead band the architecture exists to remove.
    // A default that disagrees with the database is worse than no default.
    when: 'aboveMgtThreshold',
    canSkip: true,
    requiresCapexOpex: true,
  },
  {
    key: 'finance_release',
    name: 'CFO release (below global threshold)',
    actorRole: 'finance',
    from: 'IN_FINANCE_REVIEW',
    to: 'READY_FOR_D365',
    order: 10,
    when: 'belowMgtThreshold',
    requiresCapexOpex: true,
  },
  {
    key: 'management',
    name: 'Management gate',
    actorRole: 'management',
    from: 'IN_MANAGEMENT_REVIEW',
    to: 'READY_FOR_D365',
    order: 11,
    when: 'always',
  },
  {
    key: 'd365_push',
    name: 'D365 push',
    actorRole: 'procurement',
    from: 'READY_FOR_D365',
    to: 'D365_PUSHED',
    order: 12,
    when: 'always',
    terminal: true,
  },
];

/** Steps added by the Wave 3 governance flow (migration 027). Kept separate so
 *  the capital governance ladder is easy to reason about in isolation. */
export const DEFAULT_GOVERNANCE_STEPS: Step[] = [
  {
    key: 'mc_approval',
    name: 'MC approval',
    actorRole: 'mc',
    from: 'QUOTES_RECEIVED',
    to: 'MC_APPROVED',
    order: 13,
    when: 'always',
  },
  {
    key: 'cfo_approval',
    name: 'CFO final approval',
    actorRole: 'cfo',
    from: 'CS_LOCKED',
    to: 'CFO_APPROVED',
    order: 14,
    when: 'always',
    requiresCapexOpex: true,
  },
];

/**
 * Everything the engine needs, in one value. Passed by the API to the engine on
 * every routing decision so that a single DB read serves both the step list and
 * the threshold, and so a PR can be advanced against its own snapshot.
 *
 * Extends RoutingConfig, so a WorkflowConfig can be handed straight to
 * resolveNextStage / planAdvance.
 */
export type WorkflowConfig = RoutingConfig & {
  /** Where the config came from — surfaced in the Part 7 header and in audit. */
  source: 'db' | 'snapshot' | 'fallback';
  /** Per-row `version` values, for optimistic concurrency on admin writes. */
  version?: number;
};

export function defaultWorkflowConfig(): WorkflowConfig {
  return {
    steps: [...DEFAULT_WORKFLOW_STEPS, ...DEFAULT_GOVERNANCE_STEPS],
    managementThreshold: DEFAULT_MANAGEMENT_THRESHOLD,
    source: 'fallback',
  };
}

// ─── Serialisation ──────────────────────────────────────────────────────────
// The database stores each step as a jsonb payload plus an `order_index`
// column. `order_index` is authoritative for ordering; `order` is mirrored into
// the payload purely so the JSON is self-describing when read outside the app.

/** Convert a Step to the exact object stored in workflow.steps_config.payload. */
export function stepToPayload(step: Step): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: step.name,
    actorRole: step.actorRole ?? null,
    from: step.from,
    to: step.to,
    order: step.order,
    when: step.when ?? 'always',
    canSkip: step.canSkip ?? false,
    terminal: step.terminal ?? false,
    requiresCapexOpex: step.requiresCapexOpex ?? false,
  };
  // conditionValue is OMITTED when the step has none, rather than written as an
  // explicit null. A step gated on aboveMgtThreshold reads the global threshold
  // and must not appear to own a number; persisting the key as null made every
  // key-presence assertion about the retirement of the duplicated values flip on
  // the next unrelated save. normalizeStep tolerates an absent key, so omitting it
  // is the honest representation of "this step carries no threshold of its own".
  if (step.conditionValue !== undefined && step.conditionValue !== null) {
    payload.conditionValue = step.conditionValue;
  }
  if (step.lineRules && step.lineRules.length > 0) {
    payload.lineRules = step.lineRules as unknown as Record<string, unknown>[];
  }
  return payload;
}

/**
 * Coerce one stored payload into a Step, tolerating the shapes real rows have
 * accumulated: absent `from` (migration 008 never stored it), a null
 * `conditionValue`, and a single category string instead of an array.
 *
 * Normalisation is deliberately forgiving; VALIDATION is not. `normalizeStep`
 * gets a row into the engine's type, `validateStepConfig` is what refuses to
 * save a config the engine could not honour.
 */
export function normalizeStep(
  id: string,
  payload: unknown,
  orderIndex: number,
): Step {
  const p = (payload ?? {}) as Record<string, unknown>;
  const rawRules = p.lineRules;
  const lineRules: LineRule[] = Array.isArray(rawRules)
    ? (rawRules as LineRule[])
    : [];

  const condRaw = p.conditionValue;
  const condNum =
    condRaw === null || condRaw === undefined || condRaw === ''
      ? undefined
      : Number(condRaw);

  const step: Step = {
    key: id,
    from: (p.from as Step['from']) ?? '*',
    to: (p.to as Stage) ?? (p.to as unknown as Stage),
    order: Number.isFinite(Number(p.order)) ? Number(p.order) : orderIndex,
    name: (p.name as string) ?? id,
    when: (p.when as string) ?? 'always',
  };
  if (p.actorRole) step.actorRole = p.actorRole as Role;
  if (condNum !== undefined && Number.isFinite(condNum)) {
    step.conditionValue = condNum;
  }
  if (p.canSkip === true) step.canSkip = true;
  if (p.terminal === true) step.terminal = true;
  if (p.requiresCapexOpex === true) step.requiresCapexOpex = true;
  if (lineRules.length > 0) step.lineRules = lineRules;
  return step;
}

/**
 * Build the engine's step list from raw database rows.
 *
 * `order_index` is the authority for ordering. Rows are sorted ascending, then
 * `order` is re-stamped from the resulting position so that the in-memory list
 * and the grid the admin sees can never disagree about sequence.
 */
export function stepsFromConfigRows(
  rows: Array<{ id: string; payload: unknown; order_index: number | string }>,
): Step[] {
  return [...rows]
    .sort((a, b) => Number(a.order_index) - Number(b.order_index))
    .map((r, idx) => {
      const step = normalizeStep(r.id, r.payload, Number(r.order_index));
      return { ...step, order: idx + 1 };
    });
}

// ─── Validation ─────────────────────────────────────────────────────────────

export type ConfigValidation = { ok: boolean; errors: string[]; warnings: string[] };

/**
 * Refuse any config the engine could not faithfully honour.
 *
 * The important rule: a step with a non-`always` condition that ALSO lacks a
 * `from` stage is rejected, not defaulted. Silently coercing it to `'*'` would
 * create a step that can fire from any stage — the exact class of routing bug
 * this remediation exists to eliminate.
 */
export function validateStepConfig(
  steps: Step[],
  managementThreshold: number,
): ConfigValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const keys = new Set<string>();

  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, errors: ['The routing table is empty.'], warnings };
  }

  if (!Number.isFinite(managementThreshold) || managementThreshold < 0) {
    errors.push(
      `Management threshold must be a non-negative number (received ${String(managementThreshold)}).`,
    );
  }

  for (const [i, s] of steps.entries()) {
    const label = s.key || `step #${i + 1}`;
    if (!s.key) errors.push(`Step #${i + 1} has no key.`);
    if (keys.has(s.key)) errors.push(`Duplicate step key "${s.key}".`);
    keys.add(s.key);

    if (!s.to) errors.push(`Step "${label}" has no target stage.`);
    if (!s.from) {
      errors.push(`Step "${label}" has no source stage ("from").`);
    } else if (s.from === '*' && (!s.when || s.when === 'always')) {
      // A stage-agnostic step with an unconditional condition fires on EVERY
      // advance from any stage, which is almost never intended and is easy to
      // create by accident in the Part 7 grid. Allowed, but never silently.
      warnings.push(
        `Step "${label}" applies to every stage ("*") and is unconditional, so it will match on any advance. ` +
          `Give it a source stage or a condition unless that is intended.`,
      );
    }

    // Predicate validation lives in predicates.ts.
    if (s.when && !isPredicateKeyword(s.when)) {
      errors.push(
        `Step "${label}" has unknown condition "${s.when}". Choose one of the supported keywords.`,
      );
    }
    if (isAmountPredicate(s.when)) {
      // null counts as MISSING, not as zero. `Number(null)` is 0, which is
      // finite, so a grid field the admin cleared would otherwise validate as
      // "amount >= 0" and match every PR — a silent, catastrophic broadening of
      // the gate. undefined and null must both be refused.
      if (
        s.conditionValue === undefined ||
        s.conditionValue === null ||
        !Number.isFinite(Number(s.conditionValue))
      ) {
        errors.push(
          `Step "${label}" uses "${s.when}" and needs a numeric conditionValue (currently ${
            s.conditionValue === undefined || s.conditionValue === null
              ? 'missing'
              : String(s.conditionValue)
          }).`,
        );
      } else if (Number(s.conditionValue) < 0) {
        errors.push(`Step "${label}" has a negative conditionValue.`);
      }
    }

    // A global-threshold step must NOT carry its own number. The whole point of
    // the aboveMgtThreshold / belowMgtThreshold predicates is that ONE admin
    // setting governs the gate; a conditionValue left on the row is silently
    // IGNORED by the engine, so the grid would show a number that does nothing
    // and the two sides of the gate could be edited apart again. Refuse it
    // rather than accept a field that appears editable and is not.
    if (
      MGMT_THRESHOLD_PREDICATES.includes(s.when as PredicateKeyword) &&
      s.conditionValue !== undefined &&
      s.conditionValue !== null
    ) {
      errors.push(
        `Step "${label}" is gated on "${s.when}", which reads the GLOBAL management threshold, ` +
          `so it must not carry its own conditionValue (found ${String(s.conditionValue)}). ` +
          `That number would be ignored by the engine. Edit the management threshold instead.`,
      );
    }

    for (const [j, r] of (s.lineRules ?? []).entries()) {
      if (!r.routeTo) errors.push(`Step "${label}" line rule #${j + 1} has no routeTo stage.`);
      if (!r.actorRole) errors.push(`Step "${label}" line rule #${j + 1} has no actorRole.`);
      if (!r.reason) {
        warnings.push(`Step "${label}" line rule #${j + 1} has no reason; it will read blank in the audit trail.`);
      }
      if (r.amountValue !== undefined && !r.amountOp) {
        errors.push(`Step "${label}" line rule #${j + 1} sets amountValue but no amountOp.`);
      }
    }
  }

  // Complementary-pair check for the finance gate. The two steps split on the
  // same threshold; if they stop being complementary, some amounts match
  // neither and the PR falls through with no defined route.
  const gte = steps.find(s => /^amountGTE$/.test(String(s.when)));
  const lt = steps.find(s => /^amountLT$/.test(String(s.when)));
  if (gte && lt) {
    const a = Number(gte.conditionValue);
    const b = Number(lt.conditionValue);
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) {
      errors.push(
        `Steps "${gte.key}" (amountGTE) and "${lt.key}" (amountLT) use different thresholds ` +
          `(${a.toLocaleString('en-PK')} vs ${b.toLocaleString('en-PK')}). Amounts between them match neither.`,
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** A blank step for the Part 7 "Add step" button. */
export function newStepTemplate(order: number): Step {
  return {
    key: '',
    name: '',
    from: 'Submitted',
    to: 'IN_PROCUREMENT_REVIEW',
    order,
    when: 'always',
    canSkip: false,
    terminal: false,
  };
}

/**
 * Look up a step by key in a GIVEN step list.
 *
 * Takes the list as an argument rather than searching the canonical defaults,
 * so that callers inspecting a live or snapshotted config cannot accidentally
 * read a step out of the wrong table.
 */
export function getStep(steps: Step[], key: string): Step | undefined {
  return steps.find(s => s.key === key);
}

export { DEFAULT_WORKFLOW_STEPS as CANONICAL_STEPS };
