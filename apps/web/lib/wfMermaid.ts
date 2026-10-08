// The Part 7 diagram generator — a PURE function, ported from the prototype's
// _lightBuildMermaidFromSteps().
//
// It takes the routing table and the management threshold and returns Mermaid
// source. It performs no rendering, no DOM access and no fetching, which is what
// makes the diagram testable without a browser and guarantees the picture can
// never disagree with the grid: both are generated from the same state.

import { LIGHT_ACTOR_REGISTRY, LIGHT_STAGE_LABEL } from '@procurement/workflow-engine';

export type WfStep = {
  key: string;
  name?: string;
  from?: string;
  to: string;
  order?: number;
  actorRole?: string;
  when?: string;
  conditionValue?: number;
  canSkip?: boolean;
  requiresCapexOpex?: boolean;
  terminal?: boolean;
  lineRules?: Array<{
    category?: string[] | string;
    amountOp?: string;
    amountValue?: number;
    routeTo?: string;
    actorRole?: string;
    reason?: string;
  }>;
};

export type WfClass = 'terminal' | 'capex' | 'exception' | 'normal';

/** Node colour classes, per blueprint Part 7.2. */
const CLASS_DEFS = [
  'classDef terminal fill:#FEE2E2,stroke:#991B1B,color:#991B1B',
  'classDef capex fill:#DCFCE7,stroke:#166534,color:#166534',
  'classDef exception fill:#FEF3C7,stroke:#92400E,color:#92400E',
  'classDef normal fill:#FFFFFF,stroke:#1E293B,color:#0F172A',
  'classDef target fill:#DBEAFE,stroke:#1E40AF,color:#1E40AF',
].join('\n');

const EXCEPTION_PREDICATES = ['reworkRequested', 'lineRejected', 'inStock', 'outOfStock'];
const AMOUNT_PREDICATES = ['amountGT', 'amountGTE', 'amountLT', 'amountLTE', 'amountEQ'];
const MGMT_PREDICATES = ['aboveMgtThreshold', 'belowMgtThreshold'];

/** Strip the characters Mermaid treats as syntax, collapse space, cap length. */
export function sanitizeLabel(s: string, max = 120): string {
  const cleaned = String(s ?? '')
    .replace(/[\\"|(){}[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

/** Non-alphanumerics become underscores, for use as a Mermaid node id. */
export function nodeId(key: string, index: number): string {
  const base = String(key ?? '').replace(/[^a-zA-Z0-9]/g, '_');
  return `s_${index}_${base || 'step'}`;
}

/**
 * Resolve the actor a step will page.
 *
 * The prototype resolves through LIGHT_ACTOR_REGISTRY[role][pr.costCenter] and
 * falls back to _default. This screen has no PR, so _default is the only
 * honest answer: the diagram shows who receives a step for a typical
 * cost centre, and the per-cost-centre overrides are real but unknowable here.
 */
export function resolveActorName(role: string | undefined): string {
  if (!role) return 'unassigned';
  const entry = (LIGHT_ACTOR_REGISTRY as Record<string, any>)?.[role];
  const fallback = entry?._default?.name;
  if (fallback) return String(fallback);
  return String(role);
}

/** The class a step's node is drawn with. */
export function classifyStep(step: WfStep): WfClass {
  if (step.terminal === true) return 'terminal';
  const when = String(step.when ?? 'always');
  if (MGMT_PREDICATES.includes(when) || AMOUNT_PREDICATES.includes(when)) return 'capex';
  if (EXCEPTION_PREDICATES.includes(when)) return 'exception';
  return 'normal';
}

/** The "when: …" fragment, with the threshold appended exactly once. */
export function conditionLabel(step: WfStep, managementThreshold: number): string {
  const when = String(step.when ?? 'always');
  if (AMOUNT_PREDICATES.includes(when)) {
    const v = step.conditionValue;
    return v === undefined || v === null
      ? `when: ${when}`
      : `when: ${when} ${Number(v).toLocaleString('en-PK')}`;
  }
  if (MGMT_PREDICATES.includes(when)) {
    return `when: ${when} ${Number(managementThreshold).toLocaleString('en-PK')}`;
  }
  return `when: ${when}`;
}

/** Compose one step's node label, in the blueprint's exact order. */
export function buildNodeLabel(step: WfStep, managementThreshold: number): string {
  const parts: string[] = [sanitizeLabel(step.name || step.key)];
  parts.push(`<br/><i>${sanitizeLabel(step.key)}</i>`);
  parts.push(`<br/>actor: ${sanitizeLabel(resolveActorName(step.actorRole))}`);
  parts.push(`<br/>${conditionLabel(step, managementThreshold)}`);
  if (step.terminal === true) parts.push('<br/><b>TERMINAL</b>');
  if (step.requiresCapexOpex === true) parts.push('<br/><b>CAPEX/OPEX</b>');
  const n = step.lineRules?.length ?? 0;
  if (n > 0) parts.push(`<br/><b>${n} line rule${n === 1 ? '' : 's'}</b>`);
  return parts.join('');
}

/**
 * Build the `flowchart TD` source for the current routing table.
 *
 * Edges: Start -> first step, then step -> next step, with NO edge leaving a
 * terminal step (the PR stops there). Each step's line rules add dotted edges to
 * de-duplicated target nodes labelled "routeTo via actor", styled :::target.
 */
export function buildMermaidFromSteps(
  steps: WfStep[],
  managementThreshold: number,
): string {
  const lines: string[] = ['flowchart TD'];
  const ids = steps.map((s, i) => nodeId(s.key, i));
  const targetNodes = new Map<string, string>();
  const targetMeta = new Map<string, { stage: string; actor: string }>();

  // Start node, then one node per step.
  lines.push('  Start([New PR submitted])');
  steps.forEach((step, i) => {
    lines.push(`  ${ids[i]}["${buildNodeLabel(step, managementThreshold)}"]`);
  });

  // Main chain. The edge out of a terminal step is deliberately omitted.
  if (steps.length > 0) {
    lines.push(`  Start --> ${ids[0]}`);
    for (let i = 0; i < steps.length - 1; i++) {
      if (steps[i].terminal === true) continue;
      lines.push(`  ${ids[i]} --> ${ids[i + 1]}`);
    }
  }

  // Line-rule edges, de-duplicated by stage+actor.
  steps.forEach((step, i) => {
    for (const rule of step.lineRules ?? []) {
      const stage = rule.routeTo || step.to || 'END';
      const actor = rule.actorRole || step.actorRole || 'system';
      const target = String(stage);
      const dedupeKey = `${target}|${actor}`;
      const nodeIdForTarget = `t_${target}_${actor}`.replace(/[^a-zA-Z0-9_]/g, '_');
      if (!targetNodes.has(dedupeKey)) {
        targetNodes.set(dedupeKey, nodeIdForTarget);
        targetMeta.set(dedupeKey, { stage: target, actor });
      }
      const cats = Array.isArray(rule.category) ? rule.category : rule.category ? [rule.category] : [];
      const catLabel = cats.length ? cats.join('+') : 'any';
      const amtLabel = rule.amountOp && rule.amountValue !== undefined && rule.amountValue !== null
        ? ` ${rule.amountOp} ${Number(rule.amountValue).toLocaleString('en-PK')}`
        : '';
      const label = sanitizeLabel(`${catLabel}${amtLabel}`, 60);
      lines.push(`  ${ids[i]} -.->|${label}| ${nodeIdForTarget}`);
    }
  });

  // Emit target nodes after their edges so Mermaid never sees a forward ref.
  for (const [key, id] of targetNodes) {
    const meta = targetMeta.get(key)!;
    const stageLabel = LIGHT_STAGE_LABEL[meta.stage] ?? meta.stage;
    lines.push(
      `  ${id}["${sanitizeLabel(stageLabel)}<br/>via ${sanitizeLabel(resolveActorName(meta.actor))}"]:::target`,
    );
  }

  // Apply classes.
  steps.forEach((step, i) => {
    lines.push(`  class ${ids[i]} ${classifyStep(step)}`);
  });

  lines.push(CLASS_DEFS);
  return lines.join('\n');
}
