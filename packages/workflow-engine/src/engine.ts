// Workflow engine — given a routing table, a PR snapshot and a decision, return
// the next stage.
//
// ---------------------------------------------------------------------------
// THE ENGINE HOLDS NO STATE AND IMPORTS NO DEFAULT CONFIGURATION.
//
// Every entry point takes a `RoutingConfig` as its first argument. There is no
// module-level step array, no DEFAULT_WORKFLOW_STEPS import, and no threshold
// constant reachable from this file. The caller — apps/api — loads the routing
// table from workflow.steps_config (or, for a PR already in flight, from
// workflow.pr_workflow_snapshot) and passes it in.
//
// The previous version resolved routing off `DEFAULT_WORKFLOW_STEPS` and could
// not be made configurable without rewriting its predicates. That coupling is
// now structurally impossible: to route, you must have been given a config.
//
// Algorithm (unchanged from the port, deliberately):
//   1. Consider steps whose `from` is the PR's current status, or '*' for
//      side-channel steps.
//   2. Sort candidates by `order` ascending.
//   3. Take the FIRST step whose `when` condition evaluates true.
//   4. Side-channel steps ('*') only pass when the approver supplied the
//      matching decision flag, so they never fire on an ordinary advance.
// ---------------------------------------------------------------------------

import { LIGHT_STAGE_OWNER, resolveActor } from './actors';
import { buildSplitDrafts, evaluateLineRules, type ChildPrDraft } from './lineRouting';
import { evaluatePredicate, predicateContext } from './predicates';
import type {
  Decision,
  PrSnapshot,
  ResolvedActor,
  RoutingConfig,
  Stage,
  Step,
} from './types';

export type EngineResult = {
  nextStage: Stage | null;     // null = no transition
  matchedStep?: string;        // key of the matching step (if any)
  evaluatedSteps: string[];    // for debugging / audit
  /** Steps that were considered but whose condition was not satisfied. */
  skippedSteps?: string[];
};

/**
 * Guard against a config that would make routing meaningless. Throws rather
 * than silently routing on an empty table, because a PR that advances to nowhere
 * is far harder to diagnose than a request that fails loudly.
 */
function assertRoutable(config: RoutingConfig): void {
  if (!config || !Array.isArray(config.steps) || config.steps.length === 0) {
    throw new Error(
      'Routing requires a non-empty step list. Load workflow.steps_config before calling the engine.',
    );
  }
  if (!Number.isFinite(Number(config.managementThreshold))) {
    throw new Error(
      `Routing requires a numeric managementThreshold (received ${String(config.managementThreshold)}).`,
    );
  }
}

/**
 * The original stage-only resolver.
 *
 * Deliberately does NOT consider line rules — existing callers and tests depend
 * on this exact behaviour. `planAdvance` is the line-routing-aware entry point.
 */
export function resolveNextStage(
  config: RoutingConfig,
  pr: PrSnapshot,
  decision?: Decision,
): EngineResult {
  assertRoutable(config);
  const evaluated: string[] = [];
  const skipped: string[] = [];
  const ctx = predicateContext(pr, decision, config.managementThreshold);

  const candidates = config.steps
    .filter(s => s.from === '*' || s.from === pr.status)
    .sort((a, b) => a.order - b.order);

  for (const step of candidates) {
    evaluated.push(step.key);
    if (!evaluatePredicate(step.when, step, ctx)) {
      skipped.push(step.key);
      continue;
    }
    return {
      nextStage: step.to,
      matchedStep: step.key,
      evaluatedSteps: evaluated,
      skippedSteps: skipped,
    };
  }
  return { nextStage: null, evaluatedSteps: evaluated, skippedSteps: skipped };
}

// ─── Full advance planning (line-routing aware) ──────────────────────────

export type AdvancePlan =
  | {
      kind: 'none';
      comment?: string;
      evaluatedSteps: string[];
      skippedSteps?: string[];
    }
  | {
      kind: 'transition';
      nextStage: Stage;
      step: Step;
      actor: ResolvedActor;
      lineRoutingApplied: boolean;
      reason: string;
      comment: string;
      evaluatedSteps: string[];
      skippedSteps?: string[];
    }
  | {
      kind: 'split';
      /** The parent is parked here once its children take over the lines. */
      parentStage: Stage;
      step: Step;
      actor: ResolvedActor;
      children: ChildPrDraft[];
      reason: string;
      comment: string;
      evaluatedSteps: string[];
      skippedSteps?: string[];
    };

/**
 * The stage a parent PR is parked at when its lines split into children.
 * Matches the prototype, which leaves the parent in Procurement review with a
 * `split` marker rather than a terminal state.
 */
export const SPLIT_PARENT_STAGE: Stage = 'IN_PROCUREMENT_REVIEW';

/**
 * Plan a workflow advance. Port of _lightWorkflowAdvance.
 *
 * Line rules are evaluated only for a step that declares them. Three outcomes:
 *   - multiple distinct destinations -> split into child PRs
 *   - exactly one destination       -> route the whole PR there
 *   - zero destinations             -> fall through to the step's default `to`
 */
export function planAdvance(
  config: RoutingConfig,
  pr: PrSnapshot,
  decision?: Decision,
): AdvancePlan {
  const resolved = resolveNextStage(config, pr, decision);
  if (!resolved.nextStage || !resolved.matchedStep) {
    return {
      kind: 'none',
      evaluatedSteps: resolved.evaluatedSteps,
      skippedSteps: resolved.skippedSteps,
    };
  }

  // Look the step up in the SAME config the resolver used. Previously this
  // re-imported the constant list, which meant a caller passing a custom table
  // got a match from one config and a plan from another.
  const step = config.steps.find(s => s.key === resolved.matchedStep);
  if (!step) {
    // Unreachable while resolveNextStage and this lookup share `config.steps`,
    // but a missing step would otherwise throw on `.lineRules` below.
    throw new Error(
      `Engine matched step "${resolved.matchedStep}" but it is absent from the supplied config.`,
    );
  }

  if (Array.isArray(step.lineRules) && step.lineRules.length > 0) {
    const evaluation = evaluateLineRules(step, pr);

    if (evaluation.needsSplit) {
      const children = buildSplitDrafts(pr, evaluation.targets);
      if (children.length > 0) {
        const reason = `PR auto-split into ${children.length} child PRs by line rules`;
        return {
          kind: 'split',
          parentStage: SPLIT_PARENT_STAGE,
          step,
          actor: resolveActor(step, pr),
          children,
          reason,
          comment: (decision?.reason || '') + (decision?.reason ? ' | ' : '') + reason,
          evaluatedSteps: resolved.evaluatedSteps,
          skippedSteps: resolved.skippedSteps,
        };
      }
    }

    if (evaluation.singleTarget) {
      const t = evaluation.singleTarget;
      // All matching lines agree on one destination — route the whole PR there
      // with a synthesized step, exactly as the prototype does.
      const syntheticStep: Step = { ...step, to: t.routeTo, actorRole: t.actorRole };
      return {
        kind: 'transition',
        nextStage: t.routeTo,
        step: syntheticStep,
        actor: resolveActor(syntheticStep, pr),
        lineRoutingApplied: true,
        reason: t.reason,
        comment: (decision?.reason || '') + (decision?.reason && t.reason ? ' | ' : '') + t.reason,
        evaluatedSteps: resolved.evaluatedSteps,
        skippedSteps: resolved.skippedSteps,
      };
    }
  }

  const reason = `${step.name || step.key} completed.`;
  return {
    kind: 'transition',
    nextStage: step.to,
    step,
    actor: resolveActor(step, pr),
    lineRoutingApplied: false,
    reason,
    comment: decision?.reason || reason,
    evaluatedSteps: resolved.evaluatedSteps,
    skippedSteps: resolved.skippedSteps,
  };
}

/**
 * The stage owner role for a stage — drives the "My Approvals" queue filter.
 * Port of the prototype's LIGHT_STAGE_OWNER.
 */
export function stageOwnerRole(stage: Stage): string {
  return LIGHT_STAGE_OWNER[stage] || 'system';
}
