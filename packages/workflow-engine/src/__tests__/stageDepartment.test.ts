// Stage vs Status separation — unit tests.
//
//   node --test dist/__tests__/stageDepartment.test.js (after `npm run build`)
//
// THE DEFECT THIS LOCKS DOWN
// ---------------------------
// The STAGE column answered "whose desk is this on?" by printing
// `proc.purchase_requisitions.status` through a label map that only covers the
// light-flow vocabulary. The five Wave-3 governance statuses live in the SAME
// column (migration 027 put them in the CHECK constraint) and were absent from
// that map, so they fell through to a snake-case humaniser and rendered
// "Quotes received", "Cs locked", "Pack locked" — 221 PRs, 17% of the visible
// grid, showing a progress marker in the departmental column.
//
// These tests assert the two columns answer DIFFERENT questions. They are
// deliberately narrow: every value in the database CHECK constraint that can
// reach a grid row must resolve to a department, and none of them may ever
// resolve to a progress verb.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIGHT_STAGES,
  LIGHT_STAGE_LABEL,
  STAGE_DEPARTMENT,
  stageDepartmentLabel,
} from '../actors';

const VOCABULARY: string[] = LIGHT_STAGES.map(s => s.k as string);

/**
 * Every status the DB will accept on `proc.purchase_requisitions.status`.
 * Taken from the live CHECK constraint, not from memory — the constraint is the
 * contract, and a test that drifts from it proves nothing.
 */
const STATUSES = [
  'Draft', 'Submitted', 'IN_HOD_REVIEW', 'IN_WAREHOUSE', 'IN_IT_REVIEW',
  'IN_PROCUREMENT_REVIEW', 'IN_WAREHOUSE_CHECK', 'IN_COST_CENTER_APPROVAL',
  'IN_FINANCE_REVIEW', 'IN_MANAGEMENT_REVIEW', 'READY_FOR_D365', 'D365_PUSHED',
  'FULFILLED_FROM_STOCK', 'CLOSED', 'REJECTED', 'RETURNED', 'ON_HOLD', 'SPLIT',
  'QUOTES_RECEIVED', 'CS_LOCKED', 'MC_APPROVED', 'CFO_APPROVED', 'PACK_LOCKED',
];

// ─── 1 · every status resolves, none is left raw ──────────────────────────────

test('every storable status resolves to a human label', () => {
  for (const status of STATUSES) {
    const label = stageDepartmentLabel(status);
    assert.ok(label && label.trim().length > 0, `${status} produced an empty label`);
    // The humaniser only fires for unmapped values. Two things betray it: the
    // label still containing an underscore, or the value coming through in
    // CONSTANT_CASE. Note this is NOT "label !== status" — `Draft` humanises
    // to `Draft` legitimately, and asserting otherwise would have hidden a
    // correct result behind a false failure.
    assert.ok(!label.includes('_'), `${status} rendered with an underscore: ${label}`);
    assert.ok(
      !/^[A-Z0-9_]+$/.test(label),
      `${status} rendered in CONSTANT_CASE: ${JSON.stringify(label)}`,
    );
  }
});

test('the five governance sub-states are NOT in the light vocabulary', () => {
  // This is the ROOT of the defect. If one of them ever gains a LIGHT_STAGES
  // entry, the admin workflow editor's Target-state select starts offering a
  // governance marker as a departmental routing target. Keep them separate.
  for (const s of Object.keys(STAGE_DEPARTMENT)) {
    assert.ok(
      !VOCABULARY.includes(s),
      `${s} must not be part of the LIGHT_STAGES vocabulary`,
    );
  }
});

// ─── 2 · the labels are DEPARTMENTS, not progress markers ─────────────────────

test('a stage label names a locus of control, never a progress verb', () => {
  // The words that leaked into the STAGE column. Each is a STATUS, and every one
  // of them now belongs to the sourcing_status column instead.
  const PROGRESS_VERBS = [
    'received', 'locked', 'approved', 'pushed', 'fulfilled', 'split', 'rejected',
  ];
  for (const [status, label] of Object.entries(STAGE_DEPARTMENT)) {
    const lower = label.toLowerCase();
    for (const verb of PROGRESS_VERBS) {
      assert.ok(
        !lower.includes(verb),
        `${status} -> ${JSON.stringify(label)} names a ${verb} state, not a department`,
      );
    }
  }
});

test('the five sub-states resolve to their owning department', () => {
  assert.equal(stageDepartmentLabel('QUOTES_RECEIVED'), 'CS review');
  assert.equal(stageDepartmentLabel('CS_LOCKED'), 'MC review');
  assert.equal(stageDepartmentLabel('MC_APPROVED'), 'CFO review');
  assert.equal(stageDepartmentLabel('CFO_APPROVED'), 'CS review');
  assert.equal(stageDepartmentLabel('PACK_LOCKED'), 'CS review');
});

test('QUOTES_RECEIVED and PACK_LOCKED share a stage but are NOT the same state', () => {
  // Both sit on the CS's desk, which is the point of the split: the STAGE column
  // says "CS review" for both, and the STATUS column is what tells them apart
  // ("Quotes received" vs "Pack locked"). If the stage label ever grew the
  // distinction back, the separation would have been undone.
  assert.equal(
    stageDepartmentLabel('QUOTES_RECEIVED'),
    stageDepartmentLabel('PACK_LOCKED'),
  );
});

// ─── 3 · the existing vocabulary is untouched ────────────────────────────────

test('light-flow stages still render their original labels', () => {
  for (const s of LIGHT_STAGES) {
    assert.equal(stageDepartmentLabel(s.k), s.label);
  }
});

test('LIGHT_STAGE_LABEL is unchanged — the fix does not rewrite the vocabulary', () => {
  // Guards the admin-workflow Target-state select, which unions LIGHT_STAGES
  // with STAGE_LABEL. If this changed, governance markers would appear there as
  // routing targets.
  assert.equal(LIGHT_STAGE_LABEL.IN_PROCUREMENT_REVIEW, 'Procurement review');
  assert.equal(LIGHT_STAGE_LABEL.IN_WAREHOUSE, 'Warehouse');
  assert.equal(LIGHT_STAGE_LABEL.PACK_LOCKED, undefined);
});

// ─── 4 · unknown values still say something ──────────────────────────────────

test('an unknown status still renders as words rather than vanishing', () => {
  // Not silently promoted to a department — but also not an empty cell.
  const label = stageDepartmentLabel('SOME_FUTURE_STAGE');
  assert.equal(label, 'Some future stage');
  assert.equal(stageDepartmentLabel(''), '');
});