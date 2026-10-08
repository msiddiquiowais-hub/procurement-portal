// Per-line rule evaluation + PR auto-split — port of the prototype's
// v2.0.x-workflow-config-line-routing block
// (_lightLineRuleMatches, _lightEvaluateLineRules, _lightFilterLinesByIndex,
//  _lightSplitPRByLineRouting, LIGHT_AMOUNT_OPS).
//
// Design note: the prototype mutates its in-page `STATE.lightPRs` array. This
// port is PURE — it returns a *plan* describing the split, and the service
// layer performs the INSERTs. Same routing decisions, testable side effects.

import { lineAmountUnknown, lineTotal, resolveLineCategory } from './categories';
import type {
  AmountOp,
  LineRule,
  LineRuleEvaluation,
  PrLine,
  PrSnapshot,
  Role,
  RouteTarget,
  Stage,
} from './types';

/** Numeric operators for `LineRule.amountOp` — the prototype's LIGHT_AMOUNT_OPS. */
export const LIGHT_AMOUNT_OPS: Record<AmountOp, (a: number, b: number) => boolean> = {
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '=': (a, b) => a === b,
  '!=': (a, b) => a !== b,
};

/**
 * Evaluate a single rule against a single line. Both the category predicate and
 * the amount predicate must hold. A rule with no `amountOp` matches on category
 * alone (this is how the prototype's "Standard IT line" rule works).
 */
export function lineRuleMatches(rule: LineRule | null | undefined, line: PrLine | null | undefined): boolean {
  if (!rule || !line) return false;

  const lineCat = resolveLineCategory(line);
  if (Array.isArray(rule.category)) {
    if (rule.category.indexOf(lineCat) < 0) return false;
  } else if (rule.category && rule.category !== lineCat) {
    return false;
  }

  if (rule.amountOp) {
    const op = LIGHT_AMOUNT_OPS[rule.amountOp];
    if (!op) return false;
    // An uncosted line cannot satisfy an amount rule in EITHER direction.
    // lineTotal() reports "no unit price" as 0, so a rule of the form
    // `amount < 50000` would otherwise match a line nobody has priced and
    // route it down the cheap path on the strength of a missing number.
    // Matching on category alone stays available for such a line — that is
    // what a rule with no `amountOp` means.
    if (lineAmountUnknown(line)) return false;
    const v = Number(rule.amountValue || 0);
    if (!op(lineTotal(line), v)) return false;
  }

  return true;
}

/**
 * Zero-based indices of the lines a routing pass should consider.
 *
 * DELIBERATE DIVERGENCE FROM THE PROTOTYPE. The prototype does:
 *
 *     const approvedIdxs = [];
 *     Object.keys(decisions).forEach(k => { if (decisions[k]==='approved') approvedIdxs.push(+k); });
 *     const itemIdxs = approvedIdxs.length ? approvedIdxs : pr.items.map((_, i) => i);
 *
 * i.e. it falls back to "route EVERYTHING" whenever no line came back
 * approved. That means a PR whose lines were all rejected would have its
 * rejected lines routed anyway — the fallback fires on "nothing approved"
 * rather than on "no decisions taken". We fall back per line instead:
 * anything not explicitly rejected or held is considered approved, which
 * matches the prototype's stated intent ("if no per-line decisions yet,
 * treat all lines as approved") without the rejected-line defect.
 */
export function approvedLineIndexes(pr: PrSnapshot): number[] {
  const lines = pr.lines || [];
  const decisions = pr.lineDecisions || {};

  return lines
    .map((line, i) => ({ line, i }))
    .filter(({ line, i }) => {
      const d = decisions[i];
      if (d === 'rejected' || d === 'held') return false;
      if (d === 'approved') return true;

      // Fall back to the persisted per-line flags (proc.pr_lines.approved /
      // .rejected) when no in-memory decision map addresses this line.
      if (line && (line.rejected === true || line.held === true)) return false;
      if (line && line.approved !== undefined) return line.approved === true;

      // No disposition recorded for this line -> treat as approved.
      return true;
    })
    .map(({ i }) => i);
}

/**
 * Evaluate a step's lineRules against a PR's approved lines.
 *
 * Rules are first-match-wins, matching the prototype: iteration is in rule
 * declaration order and the first hit for a line wins. Lines matching NO rule
 * are left at the parent / skipped — they do not create a target.
 */
export function evaluateLineRules(step: { lineRules?: LineRule[] } | null | undefined, pr: PrSnapshot): LineRuleEvaluation {
  const empty: LineRuleEvaluation = { needsSplit: false, perLine: [], targets: [], singleTarget: null };
  if (!step || !Array.isArray(step.lineRules) || step.lineRules.length === 0) return empty;
  if (!pr || !Array.isArray(pr.lines) || pr.lines.length === 0) return empty;

  const perLine: LineRuleEvaluation['perLine'] = [];
  const targetMap = new Map<string, RouteTarget>();

  for (const i of approvedLineIndexes(pr)) {
    const line = pr.lines[i];
    if (!line) continue;

    let matched: LineRule | null = null;
    for (const rule of step.lineRules) {
      if (lineRuleMatches(rule, line)) { matched = rule; break; }
    }
    if (!matched) continue; // no rule matched -> line stays at the parent

    const routeTo: Stage = matched.routeTo;
    const actorRole: Role = matched.actorRole;
    const key = `${routeTo}|${actorRole}`;
    const total = lineTotal(line);

    if (!targetMap.has(key)) {
      targetMap.set(key, {
        routeTo,
        actorRole,
        reason: matched.reason || `Routed by line-rule on ${resolveLineCategory(line)} (line ${i + 1})`,
        lineIdxs: [],
        totalAmount: 0,
      });
    }
    const target = targetMap.get(key)!;
    target.lineIdxs.push(i);
    target.totalAmount += total;

    perLine.push({ lineIdx: i, line, rule: matched, routeTo, actorRole });
  }

  const targets = Array.from(targetMap.values());
  return {
    needsSplit: targets.length > 1,
    perLine,
    targets,
    singleTarget: targets.length === 1 ? targets[0] : null,
  };
}

/** The lines of a PR that route to a given target. */
export function filterLinesByIndex(lines: PrLine[], lineIdxs: number[]): PrLine[] {
  if (!Array.isArray(lines) || !Array.isArray(lineIdxs)) return [];
  return lineIdxs.map(i => lines[i]).filter((x): x is PrLine => !!x);
}

/** A child PR the service layer must persist for a split. */
export type ChildPrDraft = {
  /** Deterministic, human-readable id: `<parentId>-L<n>`. */
  suggestedId: string;
  title: string;
  routeTo: Stage;
  actorRole: Role;
  reason: string;
  lines: PrLine[];
  parentLineIdxs: number[];
  totalAmount: number;
  /** 1-based line numbers as shown in the UI. */
  lineNumbers: number[];
};

/**
 * Build the child-PR drafts for a split. The caller persists them and stamps
 * the parent as split; this function performs no I/O and no mutation.
 */
export function buildSplitDrafts(pr: PrSnapshot, targets: RouteTarget[]): ChildPrDraft[] {
  if (!pr || !Array.isArray(targets) || targets.length <= 1) return [];

  const drafts: ChildPrDraft[] = [];
  targets.forEach((t, idx) => {
    const childLines = filterLinesByIndex(pr.lines || [], t.lineIdxs);
    if (childLines.length === 0) return;

    const lineNumbers = t.lineIdxs.map(i => i + 1);
    const baseTitle = pr.title || pr.description || 'Split PR';
    drafts.push({
      suggestedId: `${pr.id}-L${idx + 1}`,
      title: `${baseTitle} [line ${lineNumbers.join(',')}]`,
      routeTo: t.routeTo,
      actorRole: t.actorRole,
      reason: t.reason,
      lines: childLines,
      parentLineIdxs: t.lineIdxs.slice(),
      totalAmount: t.totalAmount,
      lineNumbers,
    });
  });
  return drafts;
}
