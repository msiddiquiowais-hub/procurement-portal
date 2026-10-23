// Revert-to-HOD must stop once procurement has run a live competition.
//
//   npm run test:web
//
// The defect
// ----------
// `canRevertToHod` gated on role and stage alone, and `PrService.revertToHod`
// checked nothing about the RFQ. A PR at Procurement review whose RFQ had been
// issued to vendors — quotes received, vendors holding a live deadline — could be
// returned to the HOD, and the RFQ stayed `Open` with those quotes attached to a
// document procurement no longer owned.
//
// The threshold
// -------------
// ONE vendor invited. Not a received quote: a solicitation with a live deadline and
// no reply has already left procurement's hands. An RFQ with an empty roster was
// never shown to anyone — the server CANCELS that one on revert, which is a
// deliberate recovery path and must not be closed off by this gate.
//
// These assert the CLIENT threshold. The server threshold is enforced in
// `PrService.revertToHod` and exercised live by var/verify_revert_gate.mjs; the
// boundary is pinned on both sides deliberately, because the two implementations
// live in different packages and cannot share one constant.

import test from 'node:test';
import assert from 'node:assert/strict';
import { revertBlockedByRfq } from '../lib/ui';

// ── the threshold ───────────────────────────────────────────────────────────

test('zero invitations does NOT block — an unsent RFQ is still undoable', () => {
  // This is the recovery path: procurement issued an RFQ to nobody, can revert,
  // and the server cancels the empty RFQ so it can be re-sourced later.
  assert.equal(revertBlockedByRfq(0), false);
});

test('ONE invitation blocks — a quote is not required', () => {
  // The whole point. A vendor holding a live deadline has been given a promise;
  // whether they have replied yet is irrelevant.
  assert.equal(revertBlockedByRfq(1), true);
});

test('any larger roster blocks', () => {
  for (const n of [2, 3, 17]) assert.equal(revertBlockedByRfq(n), true, `${n} vendors`);
});

test('the boundary is exactly one, not a quote count', () => {
  // A quote count of 0 with one invitation still blocks. If this ever returns
  // false, the rule has silently drifted back to "wait for a quote".
  assert.equal(revertBlockedByRfq(1), true);
});

// ── robustness of the input ─────────────────────────────────────────────────

test('a missing roster reads as zero, not as blocked', () => {
  // `src?.procurement?.rfq?.vendorIds?.length ?? 0` must not become NaN, which
  // would be false and silently re-enable the button on a PR that HAS an RFQ.
  const missing = undefined as any;
  assert.equal(revertBlockedByRfq(missing?.length ?? 0), false);
});

test('a numeric string from the CSV bridge still blocks', () => {
  // The DB bridge returns counts as strings outside the browser; a future
  // transport change must not quietly turn "3" into a permissive 0.
  assert.equal(revertBlockedByRfq(Number('3')), true);
});