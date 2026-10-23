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
    key: 'revert_to_hod',
    name: 'Reverted to HOD by procurement',
    actorRole: 'procurement',
    // Narrow on purpose. Once the PR has moved past procurement — comparative
    // statement drafted, forwarded, RFQ live — procurement holds no rights over
    // it. Widening this to '*' would hand the actor who ran the competition the
    // power to rewrite it after handing it to the next authority, with no
    // involvement from that authority. That widening was already rejected once
    // in this codebase, on the reissue gate.
    from: 'IN_PROCUREMENT_REVIEW',
    to: 'IN_HOD_REVIEW',
    order: 0,
    when: 'revertToHod',
    canSkip: false,
    terminal: false,
  },
  {
    key: 'rework',
    name: 'Sent back for rework',
    actorRole: 'requester',
    from: '*',
    to: 'IN_PROCUREMENT_REVIEW',
    order: 2,
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
    order: 3,
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
    order: 4,
    when: 'inStock',
    canSkip: false,
    terminal: true,
  },
  // ─── The CS module — step 5 of the ladder ─────────────────────────────────
  //
  // These two steps were seeded directly into workflow.steps_config by
  // migrations 064 and 065 and were NOT part of this default set. That was not
  // harmless: `POST /workflow/config/reset` upserts the defaults at
  // order_index = array position, so a reset renumbered the fifteen defaults
  // over the top of the two database-only rows and left the CS steps stranded
  // at the end of the table. They are in the default set now, which is also
  // what lets the ladder below be expressed as ONE list.
  //
  // `ready_for_cs` is the forward into the comparative statement; `cs_review`
  // is the exit from it, and it is the step that owns the per-line Capex/Opex
  // classification. The flag is on the EXIT, not on the entry: the classifier
  // is completed as part of confirming the comparison, and the PR may not
  // cross into Cost approval until every approved line carries a class.
  {
    key: 'ready_for_cs',
    name: 'Forwarded to CS for comparative statement',
    actorRole: 'procurement',
    from: 'IN_PROCUREMENT_REVIEW',
    to: 'QUOTES_RECEIVED',
    order: 4,
    // The keyword exists in the predicate vocabulary (see predicates.ts). It
    // used to be absent, which meant evaluatePredicate coerced it to 'always'
    // and the step would have hijacked the `procurement` step that owns this
    // stage the moment it was moved above it.
    when: 'readyForCs',
    canSkip: false,
    terminal: false,
  },
  {
    key: 'cs_review',
    name: 'CS review confirmed',
    // HOD PROCUREMENT — `hod`, the same role string every department head in
    // this deployment carries. There is no `hod_procurement` string, because
    // Procurement is a department like the others and the org chart does not
    // invent a role for it.
    //
    // The actorRole is the ROLE VOCABULARY the admin editor validates and the
    // engine reports; it cannot say "the head of department X". The identity is
    // resolved from core.departments (code 'PROC') -> hod_user_id, in
    // pr/hod.procurement.ts. A role check alone would hand this step to the
    // Head of Finance too, because roleAllowed('hod','hod') is true for all of
    // them — which is why the previous `procurement_manager` was worse than
    // wrong: it named nobody at all.
    actorRole: 'hod',
    from: 'IN_PROCUREMENT_REVIEW',
    to: 'IN_FINANCE_REVIEW',
    order: 5,
    when: 'csExitComplete',
    canSkip: false,
    terminal: false,
    // THE CAPEX/OPEX GATE LIVES HERE — and on `procurement` below.
    //
    // It was on `finance_review` and `finance_release`, which is a step LATER
    // than Cost approval — so a PR could reach the cost centre with lines
    // nobody had classified, and the cost centre was asked to approve a spend
    // nobody had said was capital or operating. The classification belongs to
    // the desk that ran the competition and knows what was quoted, and it must
    // be complete before the cost centre sees the number.
    requiresCapexOpex: true,
  },
  // ─── The SAME exit, from the other CS stage ───────────────────────────────
  //
  // `cs_review` above leaves IN_PROCUREMENT_REVIEW. A comparative statement is
  // just as real at QUOTES_RECEIVED — that is where the "Ready for CS" hand-off
  // (ready_for_cs, order 4) parks the request, and where the statement is
  // generated, reviewed blind and confirmed. Measured on the live estate: 66
  // requests sit at QUOTES_RECEIVED, 65 of them with a review row.
  //
  // A step declares ONE `from`, so one row cannot express "the CS exit, from
  // either sourcing stage". Before this row existed, a request parked at
  // QUOTES_RECEIVED had no gated route to Cost approval at all: the only step
  // out of QUOTES_RECEIVED was mc_approval (order 15, `when: always`, to
  // MC_APPROVED), and proc.fn_check_pr_transition does not allow
  // QUOTES_RECEIVED -> MC_APPROVED, so firing it raised a check violation. The
  // only thing that ever moved such a request was the blind confirm writing
  // `SET status = step.to` behind the engine's back.
  //
  // With the confirm no longer moving the PR, this row IS the exit. It carries
  // the same `when` flag and the same requiresCapexOpex gate as cs_review,
  // because it is the same decision: the statement is confirmed, procurement has
  // classified every approved line, and the request may cross into Cost
  // approval.
  //
  // `order: 6` is cs_review's own precedence, not a fresh slot. The two can
  // never be candidates in the same pass — their `from` values are different
  // stages and the engine filters on `from` before sorting — so sharing the
  // number costs nothing and keeps this row directly behind its twin.
  {
    key: 'cs_review_quotes',
    name: 'CS review confirmed (quotes received)',
    // PROCUREMENT — the desk that classifies the lines and owns the hand-off.
    // HOD Procurement also acts here, and is admitted by IDENTITY in
    // PrService.authorizeAdvance (isHodProcurement), not by this string: `hod`
    // is the role every one of the five department heads carries.
    actorRole: 'procurement',
    from: 'QUOTES_RECEIVED',
    to: 'IN_FINANCE_REVIEW',
    order: 6,
    when: 'csExitComplete',
    canSkip: false,
    terminal: false,
    // THE GATE MOVED HERE. It used to be enforced inside the blind confirm,
    // which made the request unconfirmable: the reviewer confirming commercial
    // rates was asked to classify them, and the classification could not happen
    // until the confirm released the request to procurement. The class is made
    // by procurement AFTER the statement is confirmed and BEFORE this step
    // fires, so it is this step — the crossing into Cost approval — that must
    // demand it.
    requiresCapexOpex: true,
  },
  {
    key: 'out_of_stock',
    name: 'Out of stock (forward)',
    actorRole: 'procurement',
    from: '*',
    to: 'IN_PROCUREMENT_REVIEW',
    order: 6,
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
    order: 7,
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
    order: 8,
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
    to: 'IN_FINANCE_REVIEW',
    order: 9,
    when: 'always',
    // THE SECOND DOOR OUT OF STEP 4, and the one that was standing open.
    //
    // `when: always` with no requiresCapexOpex meant an ordinary procurement
    // approval walked IN_PROCUREMENT_REVIEW straight to IN_COST_CENTER_APPROVAL
    // with no comparative statement, no award and no Capex/Opex class. The cost
    // gate caught the UNPRICED case — which is what unblocked Case 16 — but a
    // request whose lines already carried the requester's own estimate sailed
    // through, and the cost centre was asked to approve an unclassified spend.
    //
    // Measured: 642 requests sat at IN_PROCUREMENT_REVIEW while this was true.
    // A gate on the CS exit does not cover this edge; both edges now carry the
    // flag, and the audit's Finding 1 is asserted CLOSED rather than documented
    // as a gap.
    requiresCapexOpex: true,
  },

  {
    key: 'finance_review',
    name: 'Management review (global threshold)',
    actorRole: 'finance',
    from: 'IN_FINANCE_REVIEW',
    to: 'IN_MANAGEMENT_REVIEW',
    order: 11,
    // Reads the GLOBAL management threshold, not a number of its own. Kept in
    // step with migration 035: when these steps carried duplicated
    // conditionValues, `POST /workflow/config/reset` wrote these in-code defaults
    // back over the live rows and silently REVERTED the single-sourced gate,
    // re-introducing the two-number dead band the architecture exists to remove.
    // A default that disagrees with the database is worse than no default.
    when: 'aboveMgtThreshold',
    canSkip: true,
    // The Capex/Opex flag was here until migration 066 moved it to the CS
    // exit (step 5). Leaving it would have demanded a SECOND classification
    // from finance of lines procurement had already classified — two desks
    // answering the same question, and the answer allowed to disagree.
  },
  {
    key: 'finance_release',
    name: 'CFO release (below global threshold)',
    actorRole: 'finance',
    from: 'IN_FINANCE_REVIEW',
    to: 'READY_FOR_D365',
    order: 12,
    when: 'belowMgtThreshold',
  },
  {
    key: 'management',
    name: 'Management gate',
    actorRole: 'management',
    from: 'IN_MANAGEMENT_REVIEW',
    to: 'READY_FOR_D365',
    order: 13,
    when: 'always',
  },
  {
    key: 'd365_push',
    name: 'D365 push',
    actorRole: 'procurement',
    from: 'READY_FOR_D365',
    to: 'D365_PUSHED',
    order: 14,
    when: 'always',
    terminal: true,
  },
];

/** Steps added by the Wave 3 governance flow (migration 027). Kept separate so
 *  the capital governance ladder is easy to reason about in isolation.
 *
 *  These sit at 16 and 17, AFTER the ten-step light ladder, because they are a
 *  BRANCH of it and not a continuation: a PR reaches QUOTES_RECEIVED and then
 *  either the CS review chain confirms it (step 5 -> Cost approval) or the
 *  committee locks it (QUOTES_RECEIVED -> CS_LOCKED -> MC -> CFO -> PACK).
 *  The two routes never meet.
 *
 *  `cfo_approval` no longer carries `requiresCapexOpex`. The flag marks the
 *  step where the per-line classification is MADE, and the governance branch
 *  never passes through that step, so the flag there was decoration: nothing
 *  read it, and nothing does now. A governance PR therefore reaches the CFO
 *  with unclassified lines unless the CS lock path classifies them — which is
 *  a real gap, recorded in migration 066 rather than papered over here. */
export const DEFAULT_GOVERNANCE_STEPS: Step[] = [
  {
    key: 'mc_approval',
    name: 'MC approval',
    actorRole: 'mc',
    from: 'QUOTES_RECEIVED',
    to: 'MC_APPROVED',
    order: 15,
    when: 'always',
  },
  {
    key: 'cfo_approval',
    name: 'CFO final approval',
    actorRole: 'cfo',
    from: 'CS_LOCKED',
    to: 'CFO_APPROVED',
    order: 16,
    when: 'always',
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

    // A step whose CONDITION includes the classification requirement must also
    // DECLARE it, and the other way round. These are two declarations of one
    // fact — `requiresCapexOpex` says "this step demands a classification"
    // (which is what opens the card and drives the refusal message) and the
    // `csExitComplete` condition says "…and the classification is complete"
    // (which is what decides whether the step fires) — and two editable
    // declarations of one fact WILL be edited apart.
    //
    // The failure when they are: untick `requiresCapexOpex` and the card stops
    // opening, so the lines are never classified, so `csExitComplete` never
    // becomes true, so the step never fires. The request is stuck, and nothing
    // says why. Refuse the config instead of letting it be saved.
    if (s.when === 'csExitComplete' && s.requiresCapexOpex !== true) {
      errors.push(
        `Step "${label}" uses "${s.when}", which requires a complete Capex/Opex `
        + 'classification, but does not declare requiresCapexOpex. Without it the '
        + 'classification card is never offered, the lines are never classified, and '
        + 'the step can never fire — the request would be stuck with nothing to '
        + 'indicate why.',
      );
    }
    if (s.requiresCapexOpex === true && s.when !== 'csExitComplete' && s.when !== 'always') {
      errors.push(
        `Step "${label}" demands a Capex/Opex classification but its condition is `
        + `"${s.when}", which does not test whether the classification is complete. `
        + 'Use "csExitComplete" so the step fires only once every line is classified.',
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
