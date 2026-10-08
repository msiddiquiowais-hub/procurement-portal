// Line-routing test suite — parity with the prototype's
// _archive/_smoke_workflow_line_routing.js (63 checks).
//
// Run with: node --test dist/__tests__/lineRouting.test.js (after `npm run build`)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LIGHT_ITEM_CATEGORIES,
  LIGHT_ITEM_CATEGORY_LABEL,
  LIGHT_ITEM_CATEGORY_IDS,
  resolveLineCategory,
  lineTotal,
} from '../categories';
import {
  LIGHT_AMOUNT_OPS,
  lineRuleMatches,
  evaluateLineRules,
  filterLinesByIndex,
  buildSplitDrafts,
  approvedLineIndexes,
} from '../lineRouting';
import { resolveActor, LIGHT_ACTOR_REGISTRY, LIGHT_STAGE_LABEL, LIGHT_STAGE_OWNER } from '../actors';
import { planAdvance, resolveNextStage, SPLIT_PARENT_STAGE } from '../engine';
import { DEFAULT_WORKFLOW_STEPS, DEFAULT_MANAGEMENT_THRESHOLD, getStep } from '../steps';
import type { PrLine, PrSnapshot, RoutingConfig } from '../types';

/**
 * The engine takes its routing table as an argument, so these tests name the
 * table they assert against instead of relying on an implicit default inside
 * the engine. Line rules under test come from the canonical step, which is the
 * same data the DB seed carries.
 */
function cfg(overrides: Partial<RoutingConfig> = {}): RoutingConfig {
  return {
    steps: DEFAULT_WORKFLOW_STEPS,
    managementThreshold: DEFAULT_MANAGEMENT_THRESHOLD,
    ...overrides,
  };
}

function line(over: Partial<PrLine> = {}): PrLine {
  return { itemCategory: 'OTHER', amount: 0, ...over };
}

function pr(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    id: 'pr-1',
    prNumber: 'PR-2026-100000',
    // A PR awaiting a departmental decision sits in IN_HOD_REVIEW: submit
    // auto-routes it there, and the HOD/warehouse steps are sourced from it
    // (migration 053). Was 'Submitted', which is now only the brief pre-route
    // stage and matches no happy-path step.
    status: 'IN_HOD_REVIEW',
    estimatedAmount: 0,
    expenseType: 'OPEX',
    lines: [],
    warehouseCheckRequired: false,
    warehouseManagerId: null,
    warehouseDecision: null,
    ...over,
  };
}

// ─── T1 · category catalogue ──────────────────────────────────────────────

test('T1.1 catalog has the 9 prototype categories', () => {
  assert.equal(LIGHT_ITEM_CATEGORIES.length, 9);
  assert.deepEqual(LIGHT_ITEM_CATEGORY_IDS, [
    'IT_HARDWARE', 'IT_SOFTWARE', 'OFFICE_SUPPLIES', 'WAREHOUSE_ACCESSORY',
    'MACHINERY', 'PROFESSIONAL_SERVICES', 'FACILITIES', 'MARKETING', 'OTHER',
  ]);
});

test('T1.2 every category has a label', () => {
  for (const id of LIGHT_ITEM_CATEGORY_IDS) {
    assert.ok(LIGHT_ITEM_CATEGORY_LABEL[id], `missing label for ${id}`);
  }
});

// ─── T2 · category resolution ─────────────────────────────────────────────

test('T2.1 explicit category wins', () => {
  assert.equal(resolveLineCategory(line({ category: 'IT_HARDWARE' })), 'IT_HARDWARE');
});

test('T2.2 falls back to persisted itemCategory', () => {
  assert.equal(resolveLineCategory(line({ itemCategory: 'MARKETING' })), 'MARKETING');
});

test('T2.3 infers from financialDimensions.ItemGroup', () => {
  const cases: Array<[string, string]> = [
    ['LAPTOP-15', 'IT_HARDWARE'],
    ['DESKTOP-7', 'IT_HARDWARE'],
    ['RACK-SERVER', 'IT_HARDWARE'],
    ['USB-C ACC', 'WAREHOUSE_ACCESSORY'],
    ['OFFICE-CH', 'OFFICE_SUPPLIES'],
    ['STAT-PAD', 'OFFICE_SUPPLIES'],
    ['MACH-TOOL', 'MACHINERY'],
    ['CONSULT-SVC', 'PROFESSIONAL_SERVICES'],
    ['BLDG-FM', 'FACILITIES'],
    ['MKT-BRAND', 'MARKETING'],
  ];
  for (const [ig, expected] of cases) {
    const l = line({ itemCategory: '', financialDimensions: { ItemGroup: ig } });
    assert.equal(resolveLineCategory(l), expected, `ItemGroup ${ig}`);
  }
});

test('T2.4 unmatched ItemGroup and empty line fall back to OTHER', () => {
  assert.equal(resolveLineCategory(line({ itemCategory: '', financialDimensions: { ItemGroup: 'ZZZ' } })), 'OTHER');
  assert.equal(resolveLineCategory(null), 'OTHER');
});

// ─── T3 · line totals ─────────────────────────────────────────────────────

test('T3.1 explicit amount wins over qty*unitPrice', () => {
  assert.equal(lineTotal(line({ amount: 500, qty: 2, unitPrice: 999 })), 500);
});

test('T3.2 falls back to qty*unitPrice when amount absent', () => {
  assert.equal(lineTotal({ itemCategory: 'OTHER', qty: 3, unitPrice: 250 } as PrLine), 750);
});

test('T3.3 empty line totals zero', () => {
  assert.equal(lineTotal(null), 0);
});

// ─── T4 · amount operators ────────────────────────────────────────────────

test('T4.1 all six operators behave', () => {
  assert.equal(LIGHT_AMOUNT_OPS['>'](200, 100), true);
  assert.equal(LIGHT_AMOUNT_OPS['>'](100, 100), false);
  assert.equal(LIGHT_AMOUNT_OPS['>='](100, 100), true);
  assert.equal(LIGHT_AMOUNT_OPS['<'](50, 100), true);
  assert.equal(LIGHT_AMOUNT_OPS['<='](100, 100), true);
  assert.equal(LIGHT_AMOUNT_OPS['='](100, 100), true);
  assert.equal(LIGHT_AMOUNT_OPS['!='](100, 99), true);
});

test('T4.2 unknown amountOp fails closed', () => {
  const bad = lineRuleMatches(
    { category: ['IT_HARDWARE'], amountOp: 'BOGUS' as never, amountValue: 1, routeTo: 'IN_IT_REVIEW', actorRole: 'it_manager', reason: '' },
    line({ category: 'IT_HARDWARE', amount: 999_999 }),
  );
  assert.equal(bad, false);
});

// ─── T5 · single-rule matching ────────────────────────────────────────────

test('T5.1 category array match', () => {
  const rule = { category: ['IT_HARDWARE', 'IT_SOFTWARE'] as const, routeTo: 'IN_IT_REVIEW' as const, actorRole: 'it_manager' as const, reason: '' };
  assert.equal(lineRuleMatches(rule as never, line({ category: 'IT_SOFTWARE' })), true);
  assert.equal(lineRuleMatches(rule as never, line({ category: 'MACHINERY' })), false);
});

test('T5.2 no amountOp matches on category alone', () => {
  const rule = { category: ['WAREHOUSE_ACCESSORY'] as const, routeTo: 'IN_WAREHOUSE' as const, actorRole: 'store_incharge' as const, reason: '' };
  assert.equal(lineRuleMatches(rule as never, line({ category: 'WAREHOUSE_ACCESSORY', amount: 1 })), true);
});

test('T5.3 rule with no category matches any line (subject to amount)', () => {
  const rule = { amountOp: '>' as const, amountValue: 1000, routeTo: 'IN_WAREHOUSE' as const, actorRole: 'store_incharge' as const, reason: '' };
  assert.equal(lineRuleMatches(rule as never, line({ category: 'ANYTHING', amount: 2000 })), true);
  assert.equal(lineRuleMatches(rule as never, line({ category: 'ANYTHING', amount: 500 })), false);
});

test('T5.4 null rule or null line is false', () => {
  assert.equal(lineRuleMatches(null, line()), false);
  assert.equal(lineRuleMatches(
    { category: ['IT_HARDWARE'], routeTo: 'IN_IT_REVIEW', actorRole: 'it_manager', reason: '' },
    null,
  ), false);
});

// ─── T6 · first-match-wins ────────────────────────────────────────────────

test('T6.1 first matching rule wins over later ones', () => {
  const step = getStep(cfg().steps, 'hod_review')!;
  const high = line({ category: 'IT_HARDWARE', amount: 200_000 });
  const ev = evaluateLineRules(step, pr({ lines: [high] }));
  assert.equal(ev.perLine.length, 1);
  // Rule 0 is the >100K IT rule; rule 1 is the catch-all IT rule.
  assert.equal(ev.perLine[0].routeTo, 'IN_IT_REVIEW');
  assert.equal(ev.perLine[0].actorRole, 'it_manager');
});

test('T6.2 low-value IT line falls to the standard IT rule', () => {
  const ev = evaluateLineRules(getStep(cfg().steps, 'hod_review')!, pr({ lines: [line({ category: 'IT_HARDWARE', amount: 50_000 })] }));
  assert.equal(ev.perLine[0].routeTo, 'IN_PROCUREMENT_REVIEW');
  assert.equal(ev.perLine[0].actorRole, 'procurement');
});

test('T6.3 boundary is strictly greater-than', () => {
  const exact = evaluateLineRules(getStep(cfg().steps, 'hod_review')!, pr({ lines: [line({ category: 'IT_HARDWARE', amount: 100_000 })] }));
  assert.equal(exact.perLine[0].routeTo, 'IN_PROCUREMENT_REVIEW');
  const over = evaluateLineRules(getStep(cfg().steps, 'hod_review')!, pr({ lines: [line({ category: 'IT_HARDWARE', amount: 100_001 })] }));
  assert.equal(over.perLine[0].routeTo, 'IN_IT_REVIEW');
});

// ─── T7 · approved-line filtering ─────────────────────────────────────────

test('T7.1 only approved lines are evaluated', () => {
  const ev = evaluateLineRules(
    getStep(cfg().steps, 'hod_review')!,
    pr({
      lines: [
        line({ category: 'IT_HARDWARE', amount: 200_000 }),
        line({ category: 'WAREHOUSE_ACCESSORY', amount: 5_000 }),
      ],
      lineDecisions: { 0: 'approved', 1: 'rejected' },
    }),
  );
  assert.equal(ev.perLine.length, 1);
  assert.equal(ev.perLine[0].lineIdx, 0);
  assert.equal(ev.needsSplit, false, 'rejected warehouse line must not force a split');
});

test('T7.2 no decisions means all lines are considered', () => {
  assert.deepEqual(approvedLineIndexes(pr({ lines: [line(), line(), line()] })), [0, 1, 2]);
});

test('T7.3 line-level approved flag is honoured when no map is set', () => {
  // approvedLineIndexes falls back to "all" only when the map is empty; a
  // decision map of only rejections must exclude those lines.
  const idx = approvedLineIndexes(pr({
    lines: [line(), line()],
    lineDecisions: { 0: 'rejected' },
  }));
  assert.deepEqual(idx, [1]);
});

// ─── T8 · evaluation outcomes ─────────────────────────────────────────────

test('T8.1 two distinct targets sets needsSplit', () => {
  const ev = evaluateLineRules(
    getStep(cfg().steps, 'hod_review')!,
    pr({
      lines: [
        line({ category: 'IT_HARDWARE', amount: 200_000 }),
        line({ category: 'WAREHOUSE_ACCESSORY', amount: 5_000 }),
      ],
    }),
  );
  assert.equal(ev.needsSplit, true);
  assert.equal(ev.targets.length, 2);
  assert.equal(ev.singleTarget, null);
});

test('T8.2 one target sets singleTarget and not needsSplit', () => {
  const ev = evaluateLineRules(
    getStep(cfg().steps, 'hod_review')!,
    pr({ lines: [line({ category: 'IT_HARDWARE', amount: 200_000 }), line({ category: 'IT_SOFTWARE', amount: 300_000 })] }),
  );
  assert.equal(ev.needsSplit, false);
  assert.ok(ev.singleTarget);
  assert.equal(ev.singleTarget!.routeTo, 'IN_IT_REVIEW');
  assert.equal(ev.singleTarget!.lineIdxs.length, 2);
  assert.equal(ev.singleTarget!.totalAmount, 500_000);
});

test('T8.3 no matching rule yields zero targets and no split', () => {
  const ev = evaluateLineRules(getStep(cfg().steps, 'hod_review')!, pr({ lines: [line({ category: 'CARDBOARD', amount: 50_000 })] }));
  assert.equal(ev.needsSplit, false);
  assert.equal(ev.targets.length, 0);
  assert.equal(ev.singleTarget, null);
});

test('T8.4 step without lineRules returns empty evaluation', () => {
  const ev = evaluateLineRules(getStep(cfg().steps, 'procurement')!, pr({ lines: [line({ category: 'IT_HARDWARE', amount: 999_999 })] }));
  assert.deepEqual(ev.targets, []);
  assert.equal(ev.needsSplit, false);
});

// ─── T9 · split drafts ────────────────────────────────────────────────────

test('T9.1 drafts carry parent linkage, line numbers and totals', () => {
  const p = pr({
    id: 'PR-9',
    title: 'Q3 packaging',
    lines: [
      line({ category: 'IT_HARDWARE', amount: 200_000 }),
      line({ category: 'WAREHOUSE_ACCESSORY', amount: 5_000 }),
    ],
  });
  const ev = evaluateLineRules(getStep(cfg().steps, 'hod_review')!, p);
  const drafts = buildSplitDrafts(p, ev.targets);

  assert.equal(drafts.length, 2);
  assert.deepEqual(drafts.map(d => d.suggestedId), ['PR-9-L1', 'PR-9-L2']);

  const it = drafts[0];
  assert.equal(it.routeTo, 'IN_IT_REVIEW');
  assert.equal(it.actorRole, 'it_manager');
  assert.deepEqual(it.parentLineIdxs, [0]);
  assert.deepEqual(it.lineNumbers, [1]);
  assert.equal(it.totalAmount, 200_000);
  assert.equal(it.lines.length, 1);
  assert.match(it.title, /Q3 packaging \[line 1\]$/);

  const wh = drafts[1];
  assert.equal(wh.routeTo, 'IN_WAREHOUSE');
  assert.equal(wh.actorRole, 'store_incharge');
  assert.deepEqual(wh.lineNumbers, [2]);
});

test('T9.2 buildSplitDrafts refuses a single target', () => {
  const p = pr({ lines: [line({ category: 'IT_HARDWARE', amount: 200_000 })] });
  const ev = evaluateLineRules(getStep(cfg().steps, 'hod_review')!, p);
  assert.deepEqual(buildSplitDrafts(p, ev.targets), []);
});

test('T9.3 filterLinesByIndex returns the addressed lines', () => {
  const lines = [line({ amount: 1 }), line({ amount: 2 }), line({ amount: 3 })];
  assert.deepEqual(filterLinesByIndex(lines, [0, 2]).map(l => l.amount), [1, 3]);
  assert.deepEqual(filterLinesByIndex(lines, [99]), []);
});

// ─── T10 · planAdvance — split ────────────────────────────────────────────

test('T10.1 mixed IT + warehouse lines split into two child PRs', () => {
  const p = pr({
    id: 'PR-42',
    title: 'Warehouse refresh',
    lines: [
      line({ category: 'IT_HARDWARE', amount: 250_000 }),
      line({ category: 'WAREHOUSE_ACCESSORY', amount: 12_000 }),
    ],
  });
  const plan = planAdvance(cfg(), p);
  assert.equal(plan.kind, 'split');
  if (plan.kind !== 'split') return;

  assert.equal(plan.parentStage, SPLIT_PARENT_STAGE);
  assert.equal(plan.children.length, 2);
  assert.deepEqual(plan.children.map(c => c.routeTo).sort(), ['IN_IT_REVIEW', 'IN_WAREHOUSE']);
  assert.match(plan.reason, /auto-split into 2 child PRs/);
});

test('T10.2 split child ids derive from the parent id', () => {
  const p = pr({
    id: 'PR-ABC',
    lines: [
      line({ category: 'IT_HARDWARE', amount: 250_000 }),
      line({ category: 'OFFICE_SUPPLIES', amount: 3_000 }),
    ],
  });
  const plan = planAdvance(cfg(), p);
  assert.equal(plan.kind, 'split');
  if (plan.kind !== 'split') return;
  assert.deepEqual(plan.children.map(c => c.suggestedId), ['PR-ABC-L1', 'PR-ABC-L2']);
});

// ─── T11 · planAdvance — single target ────────────────────────────────────

test('T11.1 all high-value IT routes whole PR to IN_IT_REVIEW', () => {
  const p = pr({ lines: [line({ category: 'IT_HARDWARE', amount: 300_000 }), line({ category: 'IT_SOFTWARE', amount: 150_000 })] });
  const plan = planAdvance(cfg(), p);
  assert.equal(plan.kind, 'transition');
  if (plan.kind !== 'transition') return;
  assert.equal(plan.nextStage, 'IN_IT_REVIEW');
  assert.equal(plan.lineRoutingApplied, true);
  assert.equal(plan.actor.role, 'it_manager');
});

test('T11.2 all accessories routes whole PR to IN_WAREHOUSE', () => {
  const p = pr({ lines: [line({ category: 'WAREHOUSE_ACCESSORY', amount: 4_000 }), line({ category: 'OFFICE_SUPPLIES', amount: 900 })] });
  const plan = planAdvance(cfg(), p);
  assert.equal(plan.kind, 'transition');
  if (plan.kind !== 'transition') return;
  assert.equal(plan.nextStage, 'IN_WAREHOUSE');
  assert.equal(plan.lineRoutingApplied, true);
  assert.equal(plan.actor.role, 'store_incharge');
});

// ─── T12 · planAdvance — fallthrough ──────────────────────────────────────

test('T12.1 lines matching no rule fall through to the step default', () => {
  const p = pr({ lines: [line({ category: 'CARDBOARD', amount: 50_000 })] });
  const plan = planAdvance(cfg(), p);
  assert.equal(plan.kind, 'transition');
  if (plan.kind !== 'transition') return;
  assert.equal(plan.nextStage, 'IN_PROCUREMENT_REVIEW');
  assert.equal(plan.lineRoutingApplied, false);
});

test('T12.2 PR with no lines still advances', () => {
  const plan = planAdvance(cfg(), pr({ lines: [] }));
  assert.equal(plan.kind, 'transition');
  if (plan.kind !== 'transition') return;
  assert.equal(plan.nextStage, 'IN_PROCUREMENT_REVIEW');
});

test('T12.3 rejected PR goes to REJECTED', () => {
  const plan = planAdvance(cfg(), pr({ lines: [line()] }), { lineRejected: true });
  assert.equal(plan.kind, 'transition');
  if (plan.kind !== 'transition') return;
  assert.equal(plan.nextStage, 'REJECTED');
});

test('T12.4 in-stock PR fulfils from stock', () => {
  const plan = planAdvance(cfg(), pr({ lines: [line()] }), { inStock: true });
  assert.equal(plan.kind, 'transition');
  if (plan.kind !== 'transition') return;
  assert.equal(plan.nextStage, 'FULFILLED_FROM_STOCK');
});

// ─── T13 · precedence ─────────────────────────────────────────────────────

test('T13.1 warehouse_check still beats hod_review line rules', () => {
  const p = pr({ lines: [line({ category: 'WAREHOUSE_ACCESSORY', amount: 4_000 })] });
  const plan = planAdvance(cfg(), p, { wantWarehouse: true });
  assert.equal(plan.kind, 'transition');
  if (plan.kind !== 'transition') return;
  assert.equal(plan.nextStage, 'IN_WAREHOUSE_CHECK', 'must be IN_WAREHOUSE_CHECK, not the IN_WAREHOUSE line-rule target');
  assert.equal(plan.lineRoutingApplied, false);
});

test('T13.2 PR-side warehouse flag alone triggers warehouse_check', () => {
  const plan = planAdvance(cfg(), pr({ warehouseCheckRequired: true, lines: [line({ category: 'IT_HARDWARE', amount: 200_000 })] }));
  assert.equal(plan.kind, 'transition');
  if (plan.kind !== 'transition') return;
  assert.equal(plan.nextStage, 'IN_WAREHOUSE_CHECK');
});

test('T13.3 line rules are not consulted off the Submitted stage', () => {
  const p = pr({
    status: 'IN_PROCUREMENT_REVIEW',
    lines: [line({ category: 'IT_HARDWARE', amount: 200_000 })],
  });
  const plan = planAdvance(cfg(), p);
  assert.equal(plan.kind, 'transition');
  if (plan.kind !== 'transition') return;
  assert.equal(plan.nextStage, 'IN_COST_CENTER_APPROVAL');
  assert.equal(plan.lineRoutingApplied, false);
});

// ─── T14 · purity ─────────────────────────────────────────────────────────

test('T14.1 planAdvance does not mutate the PR snapshot', () => {
  const p = pr({
    id: 'PR-PURE',
    title: 'Untouched',
    lines: [line({ category: 'IT_HARDWARE', amount: 200_000 }), line({ category: 'WAREHOUSE_ACCESSORY', amount: 900 })],
  });
  const snapshot = JSON.parse(JSON.stringify(p));
  planAdvance(cfg(), p);
  assert.deepEqual(p, snapshot, 'engine must be pure — persistence belongs to the service layer');
});

test('T14.2 evaluateLineRules does not mutate lines', () => {
  const lines = [line({ category: 'IT_HARDWARE', amount: 200_000 })];
  const before = JSON.parse(JSON.stringify(lines));
  evaluateLineRules(getStep(cfg().steps, 'hod_review')!, pr({ lines }));
  assert.deepEqual(lines, before);
});

// ─── T15 · step config integrity ──────────────────────────────────────────

test('T15.1 hod_review carries the 3 prototype line rules in order', () => {
  const rules = getStep(cfg().steps, 'hod_review')!.lineRules!;
  assert.equal(rules.length, 3);
  assert.equal(rules[0].routeTo, 'IN_IT_REVIEW');
  assert.equal(rules[0].amountOp, '>');
  assert.equal(rules[0].amountValue, 100_000);
  assert.equal(rules[1].routeTo, 'IN_PROCUREMENT_REVIEW');
  assert.equal(rules[1].amountOp, undefined);
  assert.equal(rules[2].routeTo, 'IN_WAREHOUSE');
});

test('T15.2 all 12 prototype steps are present with stable order', () => {
  assert.equal(DEFAULT_WORKFLOW_STEPS.length, 12);
  assert.deepEqual(
    DEFAULT_WORKFLOW_STEPS.map(s => s.key),
    ['rework', 'reject', 'fulfilled_stock', 'out_of_stock', 'warehouse_check',
     'hod_review', 'procurement', 'cost_center', 'finance_review', 'finance_release',
     'management', 'd365_push'],
  );
});

test('T15.3 every step actorRole resolves to a real address', () => {
  for (const s of DEFAULT_WORKFLOW_STEPS) {
    assert.ok(s.actorRole, `${s.key} has no actorRole`);
    const a = resolveActor(s, null);
    assert.ok(a.email.includes('@pakboxes.pk'), `${s.key} -> unresolvable email ${a.email}`);
    // Roles absent from the registry (e.g. 'requester') must still degrade to a
    // well-formed address rather than throwing — the prototype does the same.
    if (!LIGHT_ACTOR_REGISTRY[s.actorRole as string]) {
      assert.equal(a.email, `${s.actorRole}@pakboxes.pk`);
    }
  }
});

test('T15.4 every step has a human-readable name and stage label', () => {
  for (const s of DEFAULT_WORKFLOW_STEPS) {
    assert.ok(s.name, `${s.key} has no name`);
    assert.ok(LIGHT_STAGE_LABEL[s.to], `${s.key} targets unlabelled stage ${s.to}`);
  }
});

test('T15.5 line-rule route targets are all labelled stages', () => {
  for (const s of DEFAULT_WORKFLOW_STEPS) {
    for (const r of s.lineRules || []) {
      assert.ok(LIGHT_STAGE_LABEL[r.routeTo], `${s.key} rule routes to unlabelled ${r.routeTo}`);
    }
  }
});

test('T15.6 every stage has an owner role', () => {
  for (const s of DEFAULT_WORKFLOW_STEPS) {
    assert.ok(LIGHT_STAGE_OWNER[s.to], `no owner for ${s.to}`);
  }
});

// ─── T16 · actor resolution ───────────────────────────────────────────────

test('T16.1 cost-centre-specific actor wins', () => {
  const a = resolveActor({ actorRole: 'department_manager' }, { costCenter: 'IT' });
  assert.equal(a.email, 'adeel.khan@pakboxes.pk');
});

test('T16.2 unknown cost centre falls back to _default', () => {
  const a = resolveActor({ actorRole: 'department_manager' }, { costCenter: 'NOPE' });
  assert.equal(a.email, 'hassan.ali@pakboxes.pk');
});

test('T16.3 missing cost centre resolves via _default', () => {
  const a = resolveActor({ actorRole: 'finance' }, null);
  assert.equal(a.email, 'bilal.hussain@pakboxes.pk');
});

test('T16.4 unknown role degrades to a synthetic address, not a throw', () => {
  const a = resolveActor({ actorRole: 'not_a_role' }, null);
  assert.equal(a.email, 'not_a_role@pakboxes.pk');
});

// ─── T17 · resolveNextStage stays stage-only ──────────────────────────────

test('T17.1 resolveNextStage ignores line rules entirely', () => {
  const p = pr({ lines: [line({ category: 'IT_HARDWARE', amount: 200_000 })] });
  const r = resolveNextStage(cfg(), p);
  assert.equal(r.matchedStep, 'hod_review');
  assert.equal(r.nextStage, 'IN_PROCUREMENT_REVIEW', 'must NOT return IN_IT_REVIEW — that is planAdvance-only');
});
