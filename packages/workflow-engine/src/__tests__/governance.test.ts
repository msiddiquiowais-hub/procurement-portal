// Wave 3 step 1 — governance chain unit tests.
// Run with: node --test dist/__tests__/governance.test.js (after `npm run build`)
//
// The prototype's governance rules are pure functions, so they are proven here
// rather than discovered through a browser. The load-bearing cases:
//
//   1. Unanimity is 5/5. FOUR IS NOT FIVE. Every permutation is exercised —
//      a quorum bug that only shows at 4/5 is the bug that ships.
//   2. A single reject collapses the round, wherever it lands in the order.
//   3. This table and migration 027's trigger agree, stage for stage.
//   4. A pack digest is either real or absent. Nothing is ever invented.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STAGES,
  STAGE_LABEL,
  GOVERNANCE_STAGES,
  GOVERNANCE_NEXT,
  GOVERNANCE_STAGE_OWNER,
  MC_PANEL_SIZE,
  PACK_DOCUMENT_NAMES,
  asGovernanceStage,
  canGovernanceTransition,
  canPushToD365,
  cfoAlert,
  cfoSummary,
  formatDigest,
  isUnanimous,
  mcAlert,
  mcNext,
  mcTally,
  nextGovernanceStages,
  packDocuments,
  stagePill,
  type McDecision,
} from '../governance';
import { LIGHT_STAGE_LABEL } from '../actors';

// ─── 1 · the stage vocabulary is the prototype's ────────────────────────────

test('the stage list is the prototype STAGES array, in order', () => {
  assert.deepEqual(
    STAGES.map(s => s.k),
    [
      'DRAFT', 'SUBMITTED', 'HOD_APPROVED', 'QUOTES_RECEIVED', 'CS_LOCKED',
      'MC_APPROVED', 'CFO_APPROVED', 'PACK_LOCKED', 'D365_PUSHED',
    ],
  );
  assert.equal(STAGE_LABEL['CS_LOCKED'], 'CS locked');
  assert.equal(STAGE_LABEL['QUOTES_RECEIVED'], 'Quotes received');
});

test('every governance stage is a real entry in the prototype list', () => {
  for (const g of GOVERNANCE_STAGES) {
    assert.ok(STAGES.some(s => s.k === g), `${g} is missing from STAGES`);
    assert.ok(STAGE_LABEL[g], `${g} has no label`);
  }
});

test('the governance stage union is the five migration 027 made storable', () => {
  // If this drifts, a stage will pass the type check and then die on the
  // CHECK constraint at runtime.
  assert.deepEqual(
    [...GOVERNANCE_STAGES],
    ['QUOTES_RECEIVED', 'CS_LOCKED', 'MC_APPROVED', 'CFO_APPROVED', 'PACK_LOCKED'],
  );
});

test('stagePill reproduces the prototype palette, line by line', () => {
  assert.deepEqual(stagePill('DRAFT'), { cls: 'draft', label: 'Draft' });
  assert.deepEqual(stagePill('SUBMITTED'), { cls: 'submitted', label: 'Awaiting HOD' });
  assert.deepEqual(stagePill('HOD_APPROVED'), { cls: 'pending', label: 'HOD approved' });
  assert.deepEqual(stagePill('QUOTES_RECEIVED'), { cls: 'pending', label: 'Quotes received' });
  assert.deepEqual(stagePill('CS_LOCKED'), { cls: 'locked', label: 'CS locked' });
  assert.deepEqual(stagePill('MC_APPROVED'), { cls: 'locked', label: 'MC approved' });
  assert.deepEqual(stagePill('CFO_APPROVED'), { cls: 'locked', label: 'CFO approved' });
  assert.deepEqual(stagePill('PACK_LOCKED'), { cls: 'locked', label: 'Pack locked' });
  assert.deepEqual(stagePill('D365_PUSHED'), { cls: 'pushed', label: 'Pushed to D365' });
});

test('an unknown stage degrades to a bare pill, never an undefined label', () => {
  const p = stagePill('SOMETHING_NEW');
  assert.equal(p.label, 'SOMETHING_NEW');
  assert.equal(p.cls, '');
});

// ─── 2 · unanimity: the rule the whole MC screen exists to express ────────

/** Every ordered assignment of decisions to 5 named members. */
function allAssignments(depth: number, prefix: McDecision[] = []): McDecision[][] {
  if (depth === 0) return [prefix];
  const out: McDecision[][] = [];
  for (const d of ['approve', 'reject', 'return', 'abstain'] as McDecision[]) {
    out.push(...allAssignments(depth - 1, [...prefix, d]));
  }
  return out;
}

const PANEL = ['m1', 'm2', 'm3', 'm4', 'm5'];

test('unanimity is 5/5 — exhaustive over all 4^5 vote combinations', () => {
  const assignments = allAssignments(MC_PANEL_SIZE);
  assert.equal(assignments.length, 4 ** MC_PANEL_SIZE);

  for (const a of assignments) {
    const votes = Object.fromEntries(PANEL.map((m, i) => [m, a[i]]));
    const expected =
      a.includes('reject') ? 'rejected' : a.every(v => v === 'approve') ? 'approved' : 'pending';
    assert.equal(
      mcNext(votes),
      expected,
      `votes ${JSON.stringify(a)} should resolve to ${expected}`,
    );
  }
});

test('four out of five approvals does NOT pass', () => {
  // The single most important assertion in this file.
  const votes = { m1: 'approve', m2: 'approve', m3: 'approve', m4: 'approve' } as Record<string, McDecision>;
  assert.equal(mcNext(votes), 'pending');
  assert.equal(isUnanimous(votes), false);
  assert.equal(mcTally(votes).text, '4/5');
});

test('5/5 approvals passes', () => {
  const votes = Object.fromEntries(PANEL.map(m => [m, 'approve'])) as Record<string, McDecision>;
  assert.equal(mcNext(votes), 'approved');
  assert.equal(isUnanimous(votes), true);
  assert.equal(mcTally(votes).text, '5/5');
});

test('a single reject collapses the round wherever it lands', () => {
  for (let i = 0; i < MC_PANEL_SIZE; i++) {
    const votes = Object.fromEntries(
      PANEL.map((m, j) => [m, j === i ? ('reject' as McDecision) : ('approve' as McDecision)]),
    );
    assert.equal(mcNext(votes), 'rejected', `reject at seat ${i + 1} must collapse the round`);
  }
});

test('more than five approvals does not fake a pass on a larger panel', () => {
  // A panel is appointed from workflow.mc_panel, so a sixth approval is not
  // reachable in practice. If one were ever recorded it must not let a panel
  // that is still short of unanimity pass.
  const five = Object.fromEntries(PANEL.map(m => [m, 'approve' as McDecision]));
  assert.equal(mcNext(five, MC_PANEL_SIZE), 'approved');   // 5 of 5
  assert.equal(mcNext(five, 6), 'pending');                 // 5 of 6 — one short
  // A genuine sixth approval satisfies a six-person panel.
  const six = { ...five, m6: 'approve' as McDecision };
  assert.equal(mcNext(six, 6), 'approved');
});

test('an empty round is pending, not approved', () => {
  assert.equal(mcNext({}), 'pending');
  assert.equal(mcNext(null), 'pending');
  assert.equal(mcNext(undefined), 'pending');
  assert.equal(isUnanimous({}), false);
});

test('return and abstain are neither an approval nor a rejection', () => {
  // The schema allows them; the prototype has no UI for them. They must never
  // silently complete a round, and never collapse one.
  const returned: Record<string, McDecision> = { m1: 'approve', m2: 'approve', m3: 'approve', m4: 'approve', m5: 'return' };
  assert.equal(mcNext(returned), 'pending');
  const abstained = Object.fromEntries(PANEL.map(m => [m, 'abstain' as McDecision]));
  assert.equal(mcNext(abstained), 'pending');
});

test('a zero-sized panel can never reach unanimity', () => {
  // Otherwise an un-appointed committee would approve everything by default.
  const votes = Object.fromEntries(PANEL.map(m => [m, 'approve' as McDecision]));
  assert.equal(mcNext(votes, 0), 'pending');
  assert.equal(isUnanimous(votes, 0), false);
});

test('the tally counts the prototype\'s own chip text', () => {
  const votes: Record<string, McDecision> = { m1: 'approve', m2: 'approve', m3: 'reject' };
  assert.deepEqual(mcTally(votes), { cast: 3, approves: 2, rejects: 1, panel: 5, text: '3/5' });
});

// ─── 3 · the alert copy IS the rule ────────────────────────────────────────

test('MC alerts match the prototype verbatim', () => {
  assert.deepEqual(mcAlert('CS_LOCKED'), {
    cls: 'warn',
    text: 'Voting in progress. Need 5/5 unanimous approve.',
  });
  assert.deepEqual(mcAlert('MC_APPROVED'), {
    cls: 'success',
    text: 'MC approved 5/5. Switch to CFO role for final sign-off.',
  });
  assert.equal(mcAlert('CS_GENERATED'), null);
});

test('CFO alerts match the prototype verbatim', () => {
  assert.deepEqual(cfoAlert('MC_APPROVED'), {
    cls: 'warn',
    text: 'MC approved 5/5. Awaiting CFO final budget sign-off.',
  });
  assert.deepEqual(cfoAlert('CFO_APPROVED'), {
    cls: 'success',
    text: 'CFO approved. CS can now lock the approved pack.',
  });
  assert.equal(cfoAlert('CS_LOCKED'), null);
});

// ─── 4 · the state machine agrees with migration 027 ───────────────────────

test('the full STANDARD chain is walkable end to end', () => {
  const chain = [
    'IN_PROCUREMENT_REVIEW', 'QUOTES_RECEIVED', 'CS_LOCKED',
    'MC_APPROVED', 'CFO_APPROVED', 'PACK_LOCKED', 'D365_PUSHED',
  ];
  for (let i = 0; i < chain.length - 1; i++) {
    assert.ok(
      canGovernanceTransition(chain[i], chain[i + 1]),
      `${chain[i]} -> ${chain[i + 1]} must be legal`,
    );
  }
});

test('the FAST_TRACK shortcut skips the MC and the CFO', () => {
  // Prototype line 7205-7207.
  assert.ok(canGovernanceTransition('IN_PROCUREMENT_REVIEW', 'PACK_LOCKED'));
  // ...and it is a SKIP, not an implicit approval: the middle stages are never
  // entered, so they cannot be claimed as passed.
  assert.equal(mcAlert('PACK_LOCKED'), null);
  assert.equal(cfoAlert('PACK_LOCKED'), null);
});

test('the two rejects go in OPPOSITE directions', () => {
  // MC reject -> back to sourcing, because the CS must be revised.
  assert.ok(canGovernanceTransition('CS_LOCKED', 'QUOTES_RECEIVED'));
  assert.ok(canGovernanceTransition('QUOTES_RECEIVED', 'CS_LOCKED'));
  // CFO reject -> back to the MC gate, because the MC's recommendation stands.
  assert.ok(canGovernanceTransition('MC_APPROVED', 'CS_LOCKED'));
  // The CFO does NOT get to send work back to sourcing, and the MC does not get
  // to jump the CFO.
  assert.ok(!canGovernanceTransition('MC_APPROVED', 'QUOTES_RECEIVED'));
  assert.ok(!canGovernanceTransition('CS_LOCKED', 'CFO_APPROVED'));
});

test('governance cannot be skipped', () => {
  // Procurement straight to the CFO: no CS, no committee.
  assert.ok(!canGovernanceTransition('IN_PROCUREMENT_REVIEW', 'CFO_APPROVED'));
  assert.ok(!canGovernanceTransition('IN_PROCUREMENT_REVIEW', 'MC_APPROVED'));
  assert.ok(!canGovernanceTransition('IN_PROCUREMENT_REVIEW', 'D365_PUSHED'));
  // MC straight to the pack: no budget sign-off.
  assert.ok(!canGovernanceTransition('MC_APPROVED', 'PACK_LOCKED'));
  // No pushing an unpacked pack.
  assert.ok(!canGovernanceTransition('CFO_APPROVED', 'D365_PUSHED'));
});

test('a pushed PO is not reversible, but goods arriving is still allowed', () => {
  assert.ok(!canGovernanceTransition('D365_PUSHED', 'PACK_LOCKED'));
  assert.ok(!canGovernanceTransition('D365_PUSHED', 'CFO_APPROVED'));
  assert.ok(canGovernanceTransition('D365_PUSHED', 'Fulfilled'));
});

test('cancellation follows the trigger: any non-terminal stage, no further', () => {
  for (const s of ['QUOTES_RECEIVED', 'CS_LOCKED', 'MC_APPROVED', 'CFO_APPROVED', 'PACK_LOCKED']) {
    assert.ok(canGovernanceTransition(s, 'Cancelled'), `${s} must be cancellable`);
  }
  assert.ok(!canGovernanceTransition('D365_PUSHED', 'Cancelled'));
  assert.ok(!canGovernanceTransition('Fulfilled', 'Cancelled'));
});

test('a no-op update is always allowed (the trigger permits it)', () => {
  assert.ok(canGovernanceTransition('CS_LOCKED', 'CS_LOCKED'));
});

test('rejection is always reachable, and an unknown stage reaches nothing', () => {
  assert.ok(canGovernanceTransition('CS_LOCKED', 'Rejected'));
  assert.ok(canGovernanceTransition('CS_LOCKED', 'REJECTED'));
  // The CHECK carries BOTH spellings; neither is a dead end.
  assert.ok(!canGovernanceTransition('NONSENSE', 'CS_LOCKED'));
  assert.ok(!canGovernanceTransition(null, 'CS_LOCKED'));
});

test('every governance stage has an inbox owner', () => {
  for (const g of GOVERNANCE_STAGES) {
    assert.ok(GOVERNANCE_STAGE_OWNER[g], `${g} has no owner for the approvals queue`);
  }
  assert.equal(GOVERNANCE_STAGE_OWNER['CS_LOCKED'], 'mc');
  assert.equal(GOVERNANCE_STAGE_OWNER['MC_APPROVED'], 'cfo');
});

test('nextGovernanceStages lists exactly the legal exits', () => {
  assert.deepEqual(nextGovernanceStages('CS_LOCKED'), ['MC_APPROVED', 'QUOTES_RECEIVED', 'PACK_LOCKED']);
  assert.deepEqual(nextGovernanceStages('CFO_APPROVED'), ['PACK_LOCKED']);
  assert.deepEqual(nextGovernanceStages('NOPE'), []);
});

test('every table entry names a stage one of the two vocabularies knows', () => {
  // The governance table legitimately references v2 stages (a PR can leave for
  // IN_COST_CENTER_APPROVAL instead of going down the governance chain), so the
  // check spans BOTH ladders rather than the prototype's STAGES array alone.
  const known = new Set<string>([
    ...STAGES.map(s => s.k),
    ...Object.keys(LIGHT_STAGE_LABEL),
    // 'Fulfilled' is the one v1 Title-Case value the governance chain can
    // reach, from D365_PUSHED. It predates both ladders above and has no label
    // map, but it IS in the database CHECK constraint, so it has to be here.
    'Fulfilled',
  ]);
  for (const [from, tos] of Object.entries(GOVERNANCE_NEXT)) {
    for (const to of tos) {
      assert.ok(known.has(to), `${from} -> ${to} names an unknown stage`);
      assert.ok(
        canGovernanceTransition(from, to),
        `the table claims ${from} -> ${to} but canGovernanceTransition disagrees`,
      );
    }
  }
});

// ─── 5 · the pack manifest: D1 and F2 ──────────────────────────────────────

test('a STANDARD pack with every gate run has six real documents', () => {
  const docs = packDocuments({
    routingKey: 'STANDARD',
    mcApprovedAt: '2026-09-30T10:00:00Z',
    cfoApprovedAt: '2026-09-30T11:00:00Z',
    digests: {
      pr_form: 'a'.repeat(64),
      vendor_quotes: 'b'.repeat(64),
      comparative_statement: 'c'.repeat(64),
      mc_vote_record: 'd'.repeat(64),
      cfo_approval: 'e'.repeat(64),
      compliance_checklist: 'f'.repeat(64),
    },
  });
  assert.equal(docs.length, 6);
  assert.deepEqual(docs.map(d => d.name), [...PACK_DOCUMENT_NAMES]);
  for (const d of docs) {
    assert.equal(d.state, 'present', `${d.name} should be present`);
    assert.ok(d.sha256 && d.sha256.length === 64);
  }
});

test('a FAST_TRACK pack never fabricates the MC and CFO documents', () => {
  // Decision F2. Two of the six have no content because the gates never ran.
  const docs = packDocuments({
    routingKey: 'FAST_TRACK',
    // NOTE: digests deliberately supplied for the skipped slots. A digest for a
    // gate that never ran is still not evidence, so it must be ignored.
    digests: {
      pr_form: 'a'.repeat(64),
      vendor_quotes: 'b'.repeat(64),
      comparative_statement: 'c'.repeat(64),
      mc_vote_record: 'd'.repeat(64),
      cfo_approval: 'e'.repeat(64),
      compliance_checklist: 'f'.repeat(64),
    },
  });
  assert.equal(docs.length, 6, 'the six-row structure is preserved');
  const skipped = docs.filter(d => d.state === 'skipped');
  assert.deepEqual(skipped.map(d => d.name), ['MC vote record', 'CFO approval']);
  for (const d of skipped) {
    assert.equal(d.sha256, null, `${d.name} must carry no hash`);
    assert.equal(d.note, 'Skipped (FAST_TRACK)');
  }
  // ...and the four real documents are untouched.
  assert.equal(docs.filter(d => d.state === 'present').length, 4);
});

test('a STANDARD PR that has not reached the MC says so, rather than hashing nothing', () => {
  const docs = packDocuments({
    routingKey: 'STANDARD',
    mcApprovedAt: null,
    cfoApprovedAt: null,
    digests: { pr_form: 'a'.repeat(64) },
  });
  const mc = docs.find(d => d.slot === 'mc_vote_record')!;
  assert.equal(mc.state, 'skipped');
  assert.equal(mc.note, 'Gate not reached');
  assert.equal(mc.sha256, null);
});

test('a document with no digest is `missing`, not silently present', () => {
  const docs = packDocuments({
    routingKey: 'STANDARD',
    mcApprovedAt: 'x',
    cfoApprovedAt: 'y',
    digests: { pr_form: 'a'.repeat(64) },
  });
  const cs = docs.find(d => d.slot === 'comparative_statement')!;
  assert.equal(cs.state, 'missing');
  assert.equal(cs.sha256, null);
  assert.equal(cs.note, 'No digest recorded');
});

test('no document ever returns a digest it was not given', () => {
  const docs = packDocuments({ routingKey: 'STANDARD' });
  for (const d of docs) {
    assert.ok(d.sha256 === null, `${d.name} invented a digest`);
  }
});

test('the document names and order are the prototype\'s, unmodified', () => {
  assert.deepEqual([...PACK_DOCUMENT_NAMES], [
    'PR Form (signed)',
    'Vendor quotes (3)',
    'Comparative Statement (locked)',
    'MC vote record',
    'CFO approval',
    'Internal compliance checklist',
  ]);
});

test('a file-backed digest is labelled differently from a hashed record', () => {
  const docs = packDocuments({
    routingKey: 'STANDARD',
    mcApprovedAt: 'x',
    cfoApprovedAt: 'y',
    digests: { pr_form: 'a'.repeat(64), mc_vote_record: 'd'.repeat(64) },
    sources: { pr_form: 'file' },
  });
  assert.equal(docs.find(d => d.slot === 'pr_form')!.source, 'file');
  assert.equal(docs.find(d => d.slot === 'mc_vote_record')!.source, 'record');
});

test('formatDigest shows 8 real hex characters plus the prototype\'s ellipsis', () => {
  // The prototype rendered Math.random().toString(16).slice(2,10) + '…'.
  const real = 'a3f9c1d2e5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
  assert.equal(formatDigest(real), 'a3f9c1d2…');
  // The proc.fn_pack_hash() 'sha256:' wrapper is tolerated.
  assert.equal(formatDigest('sha256:' + real), 'a3f9c1d2…');
  // A short digest is shown whole rather than truncated into nonsense.
  assert.equal(formatDigest('abc'), 'abc');
  // Absent is an em-dash. Never an empty cell, never a placeholder.
  assert.equal(formatDigest(null), '—');
  assert.equal(formatDigest(undefined), '—');
});

test('the D365 push needs a locked stage AND a frozen pack', () => {
  assert.ok(canPushToD365('PACK_LOCKED', true));
  assert.ok(!canPushToD365('PACK_LOCKED', false), 'the stage alone is not enough');
  assert.ok(!canPushToD365('CFO_APPROVED', true), 'an unlocked pack cannot be pushed');
});

// ─── 6 · the CFO summary: F1 ───────────────────────────────────────────────

test('the CFO summary keeps the prototype\'s seven rows in order', () => {
  const rows = cfoSummary({
    winnerName: 'Acme Supplies',
    amountText: 'PKR 2,400,000',
    capexAmount: 1_200_000,
    opexAmount: 30_000,
    capexGlText: 'GL 1710-00 (IT Equipment)',
    opexGlText: 'GL 6320-00 (Office Supplies)',
    expenseSplit: 'MIXED',
    mcApproves: 5,
    mcPanelSize: 5,
    riskClass: 'Medium — within delegation',
  });
  assert.deepEqual(rows.map(r => r.key), ['vendor', 'total', 'capex', 'opex', 'budget', 'mc', 'risk']);
  assert.equal(rows[5].value, '5/5 unanimous');
  assert.equal(rows[4].value, 'Mixed: IT Capex (capex lines) + Stationery Opex (opex lines)');
});

test('F1: an underivable risk class is an em-dash, not an invented rating', () => {
  const rows = cfoSummary({
    winnerName: null, amountText: null,
    capexAmount: null, opexAmount: null,
    capexGlText: null, opexGlText: null,
    expenseSplit: null, mcApproves: 0, mcPanelSize: 5, riskClass: null,
  });
  const risk = rows.find(r => r.key === 'risk')!;
  assert.equal(risk.value, '—');
  assert.equal(risk.unknown, true);
  assert.equal(rows.find(r => r.key === 'vendor')!.value, '—');
  assert.equal(rows.find(r => r.key === 'mc')!.unknown, true);
});

test('the budget source sentence follows the expense split', () => {
  const base = {
    winnerName: 'V', amountText: 'PKR 1', capexAmount: 1, opexAmount: 0,
    capexGlText: null, opexGlText: null, mcApproves: 5, mcPanelSize: 5, riskClass: 'R',
  };
  assert.equal(cfoSummary({ ...base, expenseSplit: 'CAPEX' }).find(r => r.key === 'budget')!.value, 'IT Capex FY26 Q1');
  assert.equal(cfoSummary({ ...base, expenseSplit: 'OPEX' }).find(r => r.key === 'budget')!.value, 'Opex FY26 Q1');
});

// ─── 7 · the narrow cast ───────────────────────────────────────────────────

test('asGovernanceStage recognises the five and rejects everything else', () => {
  assert.equal(asGovernanceStage('CS_LOCKED'), 'CS_LOCKED');
  assert.equal(asGovernanceStage('D365_PUSHED'), null);
  assert.equal(asGovernanceStage('IN_HOD_REVIEW'), null);
  assert.equal(asGovernanceStage(null), null);
});
