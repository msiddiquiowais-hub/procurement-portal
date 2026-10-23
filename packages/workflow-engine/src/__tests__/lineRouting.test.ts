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
import {
  resolveActor,
  LIGHT_ACTOR_REGISTRY,
  LIGHT_STAGE_LABEL,
  LIGHT_STAGE_OWNER,
  SUBSTAGE_OWNER_ROLE,
  stageDepartmentLabel,
} from '../actors';
import { planAdvance, resolveNextStage, SPLIT_PARENT_STAGE } from '../engine';
import { DEFAULT_WORKFLOW_STEPS, DEFAULT_GOVERNANCE_STEPS, DEFAULT_MANAGEMENT_THRESHOLD, getStep } from '../steps';
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
  assert.equal(plan.nextStage, 'IN_FINANCE_REVIEW');
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

/**
 * The prototype's twelve steps, in order. This list is the fidelity contract:
 * PROCUREMENT_PORTAL_PROTOTYPE.html is the source of truth for the workflow, so
 * nothing here may be removed, reordered or renamed without a decision.
 */
const PROTOTYPE_STEP_KEYS = [
  'rework', 'reject', 'fulfilled_stock', 'out_of_stock', 'warehouse_check',
  'hod_review', 'procurement', 'cost_center', 'finance_review', 'finance_release',
  'management', 'd365_push',
];

/**
 * The prototype's steps that are DELIBERATELY NOT IN THE LADDER, each with the
 * business decision that removed it.
 *
 * MIGRATION 075 — cost_center. The ruling: the blind-review confirmation by
 * the requesting HOD IS the cost approval event, so the CS exit crosses
 * straight into Finance review and the separate manual gate is gone.
 *
 * The prototype DOES have that stage, with its own two buttons (lines
 * 3002-3005). Removing it is a change to the prototype's meaning and not a
 * port of it, which is why it is listed here rather than quietly dropped: a
 * step that is REMOVED is a business decision exactly as much as a step that is
 * added, and this list is where both live.
 *
 * The stage was also unusable: its only exit named an actorRole nobody signs
 * in as, from a stage no control in the app could act on, and 117 requests were
 * sitting in it.
 */
const REMOVED_PROTOTYPE_STEPS: Record<string, string> = {
  cost_center:
    'migration 075: the CS confirmation is the cost approval event, so the CS exit '
    + 'crosses straight into Finance review and the separate manual gate is removed',
};

/**
 * Steps ADDED on top of the prototype, each an approved business decision rather
 * than a port. Listed explicitly so a second addition cannot slip through by
 * editing a number: this test fails if the non-prototype set is not EXACTLY this.
 */
const APPROVED_NON_PROTOTYPE_STEPS: Record<string, string> = {
  // Migrations 060/061. Procurement is a sourcing function, not the demand owner,
  // so it has no reject — its whole authority at IN_PROCUREMENT_REVIEW is
  // returning the PR to the HOD with mandatory remarks.
  revert_to_hod: 'procurement returns the PR to the HOD with remarks',
  // Migrations 064/065, promoted into the default set by the 2026-10-21
  // decision to make the CS module step 5 of the ladder.
  //
  // These two were seeded straight into workflow.steps_config and were NOT in
  // this default set, which had a real consequence: `POST /workflow/config/reset`
  // upserts the defaults at order_index = array position, so a reset renumbered
  // the defaults over the top of the two database-only rows and stranded the CS
  // steps at the end of the table. They are in the default set now, which is
  // also what lets the ladder be expressed as one list.
  //
  // `ready_for_cs` is the forward INTO the comparative statement and
  // `cs_review` is the exit from it. The exit carries `requiresCapexOpex`: the
  // per-line Capex/Opex class is made there, by the desk that ran the
  // competition, and the request may not cross into Cost approval until every
  // approved line carries one.
  ready_for_cs: 'procurement forwards the finished competition to the comparative statement',
  cs_review: 'the CS is confirmed, its winning rates are written to the lines, and every line is classified',
  // Migration 071, the 2026-10-21 decision to move the classification gate off
  // the blind confirm and onto the crossing into Cost approval.
  //
  // `cs_review` above leaves IN_PROCUREMENT_REVIEW. A comparative statement is
  // equally real at QUOTES_RECEIVED — `ready_for_cs` parks the request there and
  // the statement is generated, reviewed blind and confirmed from there. A step
  // declares ONE `from`, so the CS exit needs a second row rather than a widened
  // one, and this is that row: same destination, same decision flag, same gate,
  // different source stage.
  //
  // It is not an eighteenth step of the ladder. Nothing is reordered relative to
  // anything, and no prototype step changed. It exists because with the confirm
  // no longer writing the stage, a request parked at QUOTES_RECEIVED otherwise
  // had NO route into Cost approval at all — the only other step out of that
  // stage is mc_approval, and the transition trigger forbids
  // QUOTES_RECEIVED -> MC_APPROVED, so firing it raised a check violation.
  cs_review_quotes: 'the CS is confirmed at QUOTES_RECEIVED and the classified request advances to Cost approval',
};

test('T15.2 all 12 prototype steps are present with stable order', () => {
  const keys = DEFAULT_WORKFLOW_STEPS.map(s => s.key);

  const extras = keys.filter(k => !PROTOTYPE_STEP_KEYS.includes(k));
  assert.deepEqual(
    Object.keys(APPROVED_NON_PROTOTYPE_STEPS).sort(),
    [...extras].sort(),
    'non-prototype steps drifted. Approved additions are exactly '
    + `${JSON.stringify(Object.keys(APPROVED_NON_PROTOTYPE_STEPS))}; found ${JSON.stringify(extras)}. `
    + 'Adding a step is a business decision, not a port — record it here and say why.',
  );

  // The prototype's own twelve, in their own order, untouched by any addition --
  // MINUS the ones a recorded business decision removed. Both directions are
  // business decisions and both are listed, so neither can happen quietly.
  const expectedPrototypeSteps = PROTOTYPE_STEP_KEYS.filter(
    k => !(k in REMOVED_PROTOTYPE_STEPS),
  );
  assert.deepEqual(keys.filter(k => PROTOTYPE_STEP_KEYS.includes(k)), expectedPrototypeSteps);
  assert.equal(PROTOTYPE_STEP_KEYS.length, 12);

  // And a removed prototype step is really gone, not renamed into the extras.
  for (const removed of Object.keys(REMOVED_PROTOTYPE_STEPS)) {
    assert.ok(!keys.includes(removed),
      removed + ' was removed by a recorded decision and must not be in the ladder');
  }
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
    // The full vocabulary, not LIGHT_STAGE_LABEL alone.
    //
    // LIGHT_STAGES is the DEPARTMENTAL ladder and deliberately does not carry
    // the sourcing sub-states — its own comment says so, and explains why
    // (the admin editor's Target-state select unions it with STAGE_LABEL
    // anyway). The CS sub-states live in STAGE_DEPARTMENT, and the app's own
    // "label for a stage" function already reads both. Asserting against the
    // narrower map would have said that the CS step targets an unlabelled
    // stage, which is not true of the application — only of the map.
    assert.ok(stageDepartmentLabel(s.to), `${s.key} targets unlabelled stage ${s.to}`);
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
    // LIGHT_STAGE_OWNER, then SUBSTAGE_OWNER_ROLE.
    //
    // The same split as T15.4: LIGHT_STAGE_OWNER is the departmental map and
    // deliberately leaves the sourcing sub-states out, because it feeds the
    // "My Approvals" queue and the governance screens are not ordinary queue
    // items. The sub-states have their own owner map for exactly that
    // reason. What this test is really asking is "does every stage have
    // somebody whose desk it is?" — and both maps answer that.
    const owner = LIGHT_STAGE_OWNER[s.to] ?? SUBSTAGE_OWNER_ROLE[s.to];
    assert.ok(owner, `no owner for ${s.to}`);
  }
});

// ─── T17 · the classification gate covers BOTH doors out of step 4 ─────────

test('T17.1 every route out of IN_PROCUREMENT_REVIEW into cost approval is gated', () => {
  // The audit's Finding 1, locked down.
  //
  // `cs_review` carried requiresCapexOpex while the ordinary `procurement`
  // approval (`when: always`, same stage, same target) did not — so a request
  // whose lines already held the REQUESTER's estimate walked to cost approval
  // with no comparative statement, no award and no Capex/Opex class. The cost
  // gate caught only the unpriced case.
  //
  // The assertion is about the PAIR, deliberately: a test that names either step
  // on its own passes while the other one stays open, which is exactly what
  // happened. So this enumerates the routes and requires every one to be gated.
  const routes = DEFAULT_WORKFLOW_STEPS.filter(
    s => s.from === 'IN_PROCUREMENT_REVIEW' && s.to === 'IN_FINANCE_REVIEW',
  );
  assert.equal(routes.length, 2, `expected 2 routes into Finance review, got ${routes.map(r => r.key)}`);
  for (const s of routes) {
    assert.equal(s.requiresCapexOpex, true, `${s.key} leaves step 4 ungated`);
  }
});

test('T17.2 no other step carries the classification gate', () => {
  // The flag used to sit on `finance_review` and `finance_release` — steps
  // LATER than cost approval — so it gated a point the spend had already passed.
  //
  // Asserted as the three ROUTES rather than as a list of keys, because the list
  // is a statement about how many doors exist and the claim worth keeping is
  // about which ones are locked. Migration 070 opened a second door
  // (`procurement`); 071 opened a third (`cs_review_quotes`, the same CS exit
  // reached from QUOTES_RECEIVED). Each of those broke a count written before
  // them, and a count is the wrong shape for this assertion: the failure mode
  // being guarded against is a step that ARRIVES somewhere without the gate,
  // which a count cannot see.
  const flagged = DEFAULT_WORKFLOW_STEPS.filter(s => s.requiresCapexOpex);
  assert.deepEqual(
    flagged.map(s => s.key).sort(),
    ['cs_review', 'cs_review_quotes', 'procurement'],
    'every route from a sourcing stage into cost approval is gated, and nothing else is',
  );

  // The direction of the flag is the actual invariant: a step that CONTINUES
  // past cost approval must not carry it, because the number has already been
  // approved by the cost centre by then. This is the assertion that would have
  // caught the original misplacement, and it survives another door being added.
  for (const s of flagged) {
    assert.equal(s.to, 'IN_FINANCE_REVIEW',
      `${s.key} carries the classification gate but does not arrive at Finance review`);
  }

  // ...and stated positively, so the next person to add a route out of sourcing
  // has to write down here that they gated it.
  for (const s of DEFAULT_WORKFLOW_STEPS) {
    if (!['IN_PROCUREMENT_REVIEW', 'QUOTES_RECEIVED'].includes(s.from)) continue;
    if (s.to !== 'IN_FINANCE_REVIEW') continue;
    assert.equal(s.requiresCapexOpex, true,
      `${s.key} crosses from ${s.from} into Finance review without the classification gate`);
  }
});

test('T17.3 no default step is owned by the retired procurement_manager role', () => {
  // Procurement is a department under the same HOD hierarchy as every other one,
  // so its head is a `hod`. `procurement_manager` was a role string that nothing
  // was ever assigned: the cs_review step it owned was a gate nobody could pass,
  // which reads as protection and is not.
  //
  // `hod` is asserted too, and it is NOT sufficient on its own — roleAllowed
  // ('hod','hod') is true for all five department heads, which is why the
  // service resolves HOD Procurement from core.departments rather than here.
  for (const s of DEFAULT_WORKFLOW_STEPS) {
    assert.notEqual(s.actorRole, 'procurement_manager', `${s.key} is owned by a retired role`);
  }
  assert.equal(getStep(cfg().steps, 'cs_review')?.actorRole, 'hod');
});

test('T17.4 the cs_review step is fireable only behind a confirmed review', () => {
  // Its condition keyword is in the predicate vocabulary and its flag is a
  // declared property on the advance DTO, so the step is REACHABLE — which it
  // was not for as long as the DTO stripped the flag. That is why the API
  // verifies a CONFIRMED review row before honouring `csReviewConfirmed`: the
  // route exists, so it has to be closed by a fact and not by silence.
  const cs = getStep(cfg().steps, 'cs_review')!;
  assert.equal(cs.when, 'csExitComplete');
  assert.equal(cs.from, 'IN_PROCUREMENT_REVIEW');
  assert.equal(cs.to, 'IN_FINANCE_REVIEW');
  assert.equal(cs.requiresCapexOpex, true);

  // And the keyword must not be coerced to 'always', or the step would hijack
  // every plain procurement approval out of this stage.
  const plain = planAdvance(cfg(), pr({ status: 'IN_PROCUREMENT_REVIEW' }), {});
  assert.equal(plain.kind, 'transition');
  assert.equal(plain.kind === 'transition' ? plain.step.key : null, 'procurement',
    'an empty decision must take the plain step');

  // MIGRATION 075 — the condition is now csExitComplete: the review closed AND
  // every line being bought carrying a class. So the flag ALONE no longer makes
  // the step reachable, and that is the whole point of the change.
  const classified = {
    status: 'IN_PROCUREMENT_REVIEW' as const,
    lines: [line({ approved: true, classification: 'OPEX_ASSET' })],
  };

  // The flag but no classification: the step must NOT fire. If it did, the
  // control would be the flag alone, and anyone who could post it could walk
  // the gate without classifying a line.
  const half = planAdvance(
    cfg(),
    pr({ status: 'IN_PROCUREMENT_REVIEW',
         lines: [line({ approved: true, classification: null })] }),
    { csReviewConfirmed: true },
  );
  assert.notEqual(half.kind === 'transition' ? half.step.key : null, 'cs_review',
    'the review flag alone must not fire the CS exit — the lines must be classified too');

  // Both halves: the step fires, and it fires INSTEAD of the plain step.
  const flagged = planAdvance(cfg(), pr(classified), { csReviewConfirmed: true });
  assert.equal(flagged.kind === 'transition' ? flagged.step.key : null, 'cs_review',
    'the review confirmed AND the lines classified together make the step reachable');
  assert.equal(flagged.kind === 'transition' ? flagged.nextStage : null, 'IN_FINANCE_REVIEW');
});

test('T17.5 the CS exit is reachable from QUOTES_RECEIVED too', () => {
  // The 2026-10-21 fix. The blind confirm used to write
  // `UPDATE proc.purchase_requisitions SET status = step.to` directly, which is
  // why the classification gate had to be duplicated into CsReviewService and
  // why the requesting HOD could not finish a blind review. With the confirm no
  // longer moving the request, the advance is the only thing that can — so it
  // has to exist from EVERY sourcing stage, not just one.
  //
  // Before this step, a request at QUOTES_RECEIVED had no route into cost
  // approval at all. The only other candidate there is mc_approval (when:
  // 'always', to MC_APPROVED) and proc.fn_check_pr_transition forbids
  // QUOTES_RECEIVED -> MC_APPROVED, so the request could only ever be moved by
  // the confirm's back-door write.
  const quotes = getStep(cfg().steps, 'cs_review_quotes')!;
  assert.equal(quotes.from, 'QUOTES_RECEIVED');
  assert.equal(quotes.to, 'IN_FINANCE_REVIEW');
  assert.equal(quotes.when, 'csExitComplete');
  assert.equal(quotes.requiresCapexOpex, true);

  // It must WIN at that stage, and only behind BOTH halves of the exit.
  const classified = {
    status: 'QUOTES_RECEIVED' as const,
    lines: [line({ approved: true, classification: 'OPEX_ASSET' })],
  };
  const flagged = planAdvance(cfg(), pr(classified), { csReviewConfirmed: true });
  assert.equal(flagged.kind === 'transition' ? flagged.step.key : null, 'cs_review_quotes',
    'the confirmed review AND the classified lines route QUOTES_RECEIVED into Finance review');
  assert.equal(flagged.kind === 'transition' ? flagged.nextStage : null, 'IN_FINANCE_REVIEW');

  // The flag alone is not enough — see T17.4. The classification is a second,
  // independent half of the same gate.
  const half = planAdvance(cfg(), pr({ status: 'QUOTES_RECEIVED' }), { csReviewConfirmed: true });
  assert.notEqual(half.kind === 'transition' ? half.step.key : null, 'cs_review_quotes',
    'the review flag alone must not fire the CS exit');

  // Fails CLOSED: no flag, no match. A keyword outside the vocabulary is coerced
  // to 'always' by evaluatePredicate and would hijack every advance out of this
  // stage, so this is the assertion that keeps that from happening.
  //
  // The DEFAULT set has no other step out of QUOTES_RECEIVED — mc_approval is a
  // GOVERNANCE step and lives in DEFAULT_GOVERNANCE_STEPS, which the live table
  // merges in. So here the honest statement is "nothing matches", and in the
  // live table it is "mc_approval matches, and the transition trigger forbids the
  // edge it writes". Both are asserted; neither is a transition to cost approval.
  const plain = planAdvance(cfg(), pr({ status: 'QUOTES_RECEIVED' }), {});
  assert.notEqual(plain.kind === 'transition' ? plain.step.key : null, 'cs_review_quotes',
    'an empty decision must not reach the CS exit');

  const governance = planAdvance(
    { steps: [...cfg().steps, ...DEFAULT_GOVERNANCE_STEPS], managementThreshold: 1_000_000 },
    pr({ status: 'QUOTES_RECEIVED' }),
    {},
  );
  assert.equal(governance.kind === 'transition' ? governance.step.key : null, 'mc_approval',
    'the governance branch out of QUOTES_RECEIVED is untouched by this step');
  assert.notEqual(governance.kind === 'transition' ? governance.nextStage : null, 'IN_FINANCE_REVIEW',
    'an unflagged advance out of QUOTES_RECEIVED must not reach cost approval');

  // ...and with the flag it still wins against that branch, because the CS exit
  // carries the lower order.
  const both = planAdvance(
    { steps: [...cfg().steps, ...DEFAULT_GOVERNANCE_STEPS], managementThreshold: 1_000_000 },
    pr({ status: 'QUOTES_RECEIVED',
         lines: [line({ approved: true, classification: 'OPEX_ASSET' })] }),
    { csReviewConfirmed: true },
  );
  assert.equal(both.kind === 'transition' ? both.step.key : null, 'cs_review_quotes');

  // And it must not interfere at the OTHER sourcing stage, where cs_review still
  // owns the exit. Two steps with the same destination are fine; two steps
  // claiming the same stage is how a branch becomes unreachable.
  const other = planAdvance(
    cfg(),
    pr({ status: 'IN_PROCUREMENT_REVIEW',
         lines: [line({ approved: true, classification: 'OPEX_ASSET' })] }),
    { csReviewConfirmed: true },
  );
  assert.equal(other.kind === 'transition' ? other.step.key : null, 'cs_review',
    'cs_review still owns the exit from IN_PROCUREMENT_REVIEW');
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
