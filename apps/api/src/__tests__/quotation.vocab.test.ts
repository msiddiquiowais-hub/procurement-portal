// Unit tests for the pure quotation math.
//
// The pricing rules are lifted from the prototype's receive-quote panel
// (_lightRecvTotalPanel / _lightRecvPerLinePanel) and its save handler, which
// computes taxAmount = round(subtotal * taxPercent / 100) and mirrors
// grandTotal into the legacy flat quotes[] array.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOTYPE_QUOTE_STATE, QUOTE_STATE } from '../sourcing/quotation.service';

test('Q1 vocabulary mapping — the DB keeps its words, the chip shows the prototype\'s', () => {
  // The plan keeps the DB vocabulary in storage because it is already
  // CHECK-constrained, and maps the prototype's three words in the UI only.
  assert.equal(QUOTE_STATE.ACTIVE, 'Submitted');
  assert.equal(QUOTE_STATE.SUPERSEDED, 'Superseded');
  assert.equal(QUOTE_STATE.VOID, 'Withdrawn');

  assert.equal(PROTOTYPE_QUOTE_STATE.Submitted, 'ACTIVE');
  assert.equal(PROTOTYPE_QUOTE_STATE.Superseded, 'SUPERSEDED');
  assert.equal(PROTOTYPE_QUOTE_STATE.Withdrawn, 'VOID');

  // Round-trip: every DB state the service can write has a prototype word.
  for (const s of ['Submitted', 'Superseded', 'Withdrawn', 'Awarded', 'Rejected']) {
    assert.ok(PROTOTYPE_QUOTE_STATE[s], `${s} has a prototype word`);
  }
  assert.equal(Object.keys(PROTOTYPE_QUOTE_STATE).length, 5, 'the map covers all five DB states');
});

test('every quotation state is covered by the DB CHECK constraint', () => {
  // proc.quotations_state_check permits exactly:
  // Submitted | Superseded | Withdrawn | Awarded | Rejected
  const permitted = new Set(['Submitted', 'Superseded', 'Withdrawn', 'Awarded', 'Rejected']);
  for (const s of Object.values(QUOTE_STATE) as string[]) {
    assert.ok(permitted.has(s), `${s} is permitted by the DB CHECK`);
  }
});

test('the prototype never used the word "Active" for a live quote', () => {
  // ACTIVE is the prototype's word. If the service ever wrote 'Active' the DB
  // CHECK would reject it and the version chain would break. Widened to
  // string[] so this is a runtime assertion, not a tautology the compiler
  // already proved from the `as const` literal types.
  const states: string[] = Object.values(QUOTE_STATE);
  assert.equal(states.includes('Active'), false, 'the service never writes "Active"');
  assert.equal(states.includes('ACTIVE'), false, 'nor the prototype\'s "ACTIVE"');
  assert.equal(states.includes('Submitted'), true, 'the live state is the DB word "Submitted"');
});
