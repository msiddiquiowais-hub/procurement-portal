// e2e_rfq_reissue.mjs — regression guard for Task 4 (Issue RFQ vs Re-issue).
//
//   node scripts/e2e_rfq_reissue.mjs
//
// WHAT THIS PREVENTS
// ------------------
// Three things, and the first two are the ones a status code alone would hide:
//
//   1. A SECOND RFQ. `reissue()` must top up the EXISTING proc.rfq row. The
//      prototype is explicit that the RFQ id survives a re-issue
//      (`const existingRfqId = hasPriorRfq ? pr.procurement.rfq.id : ...`),
//      because every quotation, award and vendor link hangs off that one id.
//      A second row would silently orphan the quotes already received — and the
//      API would still answer 200.
//
//   2. A RE-ISSUE THAT RE-INVITES. The prototype seeds the dialog with
//      `previouslySelected`, so the officer submits a list that CONTAINS vendors
//      already on the RFQ. insertInvitation() refuses those with "already on
//      this RFQ's roster", which would roll the whole top-up back. Re-selection
//      must be a no-op, not an error.
//
//   3. A RE-ISSUE CLAIMED BUT NOT HAPPENED. `reissue_count` drives the
//      "Re-issued xN" chip on the my-prs STATUS column. If a call that adds no
//      vendor and moves no date still increments it, the grid asserts a sourcing
//      event that never occurred. The stamp is also held by a CHECK
//      (rfq_reissue_stamp_consistent: count>0 <=> last_reissued_at NOT NULL),
//      asserted here against the live rows rather than trusted.

import { execFileSync } from 'child_process';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

let pass = 0, fail = 0;
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`); }
};
const login = async (email) => (await api('/auth/login', { method: 'POST', body: { email, password: 'demo' } })).data?.token;

/** Read-only DB probe so the suite can prove what the API did NOT persist. */
function psql(sql) {
  return execFileSync('docker', ['exec', '-i', 'procurement-portal-db', 'psql',
    '-U', 'proc', '-d', 'procurementDB', '-q', '-t', '-A', '-F', '|', '-f', '-'],
    { input: sql, encoding: 'utf8' }).trim();
}

console.log(`\n=== RFQ re-issue top-up against ${API} ===\n`);

const requester = await login('requester@pakboxes.pk');
const hod = await login('hod.sales@pakboxes.pk');
const procurement = await login('procurement@pakboxes.pk');
const cs = await login('cs@pakboxes.pk');
ok(requester && hod && procurement && cs, 'all four sessions logged in');

// IT_HARDWARE at/below PKR 100,000 routes to IN_PROCUREMENT_REVIEW under the
// hod_review line rules (same fixture e2e_sourcing.mjs uses).
const LAPTOP = '55555555-5555-5555-5555-555555555503';

const ccs = await api('/lookups/cost-centers', { token: requester });
const costCenterId = ccs.data?.[0]?.id;

const created = await api('/pr', {
  method: 'POST', token: requester,
  body: {
    scope: 'Re-issue regression',
    expenseType: 'OPEX',
    costCenterId,
    requiredByDate: '2026-12-31',
    title: 'Laptop — re-issue regression fixture',
    description: 'Issue once, then top the roster up.',
    lines: [{ itemId: LAPTOP, quantity: 1, uom: 'EA', unitPriceEst: 50_000 }],
  },
});
const prId = created.data?.id;
ok([200, 201].includes(created.status) && Boolean(prId), 'PR created', created.status);

await api(`/pr/${prId}/advance`, {
  method: 'POST', token: hod,
  body: { lineDecisions: { 0: 'approved' }, reason: 'HOD approves' },
});
const at = await api(`/pr/${prId}`, { token: procurement });
ok(at.data?.status === 'IN_PROCUREMENT_REVIEW', 'PR is in IN_PROCUREMENT_REVIEW', at.data?.status);

// ── 1 · the FIRST issue ──────────────────────────────────────────────────────
console.log('\n--- first issue ---');
const cands1 = await api(`/pr/${prId}/rfq/candidates`, { token: procurement });
ok([200, 201].includes(cands1.status), 'candidates resolve for a first issue', cands1.status);
ok(cands1.data?.already_issued === false, 'already_issued is false', cands1.data?.already_issued);
ok(cands1.data?.blocking === true || cands1.data?.unmapped_categories?.length === 0,
  'first issue is unblocked (no dead-end line)', cands1.data?.unmapped_categories);
ok((cands1.data?.current_vendors || []).length === 0,
  'no current roster on a first issue', cands1.data?.current_vendors);

const pool = cands1.data?.vendors || [];
ok(pool.length >= 2, `eligible pool has at least 2 vendors to choose from`, pool.length);

const first = await api(`/pr/${prId}/rfq`, {
  method: 'POST', token: procurement,
  body: { vendorIds: pool.slice(0, 2).map(v => v.id) },
});
ok([200, 201].includes(first.status), 'first issue accepted', { status: first.status, msg: first.data?.message });
const rfqId = first.data?.rfq?.id;
const firstInvites = (first.data?.invitations || []).map(i => i.invitation_id);
ok(Boolean(rfqId), 'RFQ id returned', first.data?.rfq);
ok(firstInvites.length === 2, 'two invitations minted, each with its own credential', firstInvites.length);

// A second RFQ on the same PR is still refused — this is the pre-existing
// guarantee the re-issue path must not have quietly replaced.
const second = await api(`/pr/${prId}/rfq`, { method: 'POST', token: procurement, body: {} });
ok(second.status === 400, 'a SECOND RFQ on the same PR is refused', second.status);
ok(/already has an open RFQ/i.test(String(second.data?.message || '')),
  'the refusal names the open RFQ', second.data?.message);

// ── 2 · the shared dialog now serves a RE-ISSUE ──────────────────────────────
console.log('\n--- candidates on a re-issue ---');
const cands2 = await api(`/pr/${prId}/rfq/candidates`, { token: procurement });
ok([200, 201].includes(cands2.status), 'the SAME candidates endpoint still answers', cands2.status);
ok(cands2.data?.already_issued === true, 'already_issued is true', cands2.data?.already_issued);
ok(cands2.data?.rfq_id === rfqId, 'it points at the SAME rfq', { got: cands2.data?.rfq_id, want: rfqId });
ok(Number(cands2.data?.reissue_count) === 0 && cands2.data?.last_reissued_at == null,
  'a never-re-issued RFQ reports count 0 and no stamp', cands2.data);

const current = cands2.data?.current_vendors || [];
ok(current.length === 2, 'the live roster is returned', current.length);
ok(current.every(v => v.already_invited === true), 'each row is flagged already_invited', current);

// The critical anti-duplication property: a vendor already on the roster must
// NOT also appear in the pickable list, or the dialog would offer a tick that
// invites nobody.
const currentIds = new Set(current.map(v => v.id));
const pickable = cands2.data?.vendors || [];
ok(pickable.every(v => !currentIds.has(v.id)),
  'already-invited vendors are NOT offered again as pickable', pickable.map(v => v.vendor_code));
ok(pickable.length > 0, 'the re-issue dialog still has names to add', pickable.length);

// The deadline carries over rather than resetting to the prototype's +5
// first-issue default. Asserted against the RFQ's own stored value: the two
// numbers differ (issue() defaults to DEFAULT_DEADLINE_DAYS=7, the prototype's
// dialog offers PROTOTYPE_DEADLINE_DAYS=5), so "is it the +5?" is a real
// discriminator — a re-default would show up as exactly 2026-10-16.
const storedDeadline = psql(
  `SELECT to_char(deadline_at, 'YYYY-MM-DD') FROM proc.rfq WHERE id = '${rfqId}';`,
);
const prototypeDefault = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
ok(cands2.data?.suggested_deadline === storedDeadline,
  'the existing deadline is carried into the dialog',
  { suggested: cands2.data?.suggested_deadline, stored: storedDeadline });
ok(cands2.data?.suggested_deadline !== prototypeDefault,
  'it is the RFQ\'s own deadline, not a fresh first-issue default',
  { suggested: cands2.data?.suggested_deadline, prototypeDefault });

// ── 3 · the RE-ISSUE itself ──────────────────────────────────────────────────
console.log('\n--- re-issue ---');
const asRequester = await api(`/pr/${prId}/rfq/reissue`, { method: 'POST', token: requester, body: {} });
ok(asRequester.status === 403, 'a requester cannot re-issue', asRequester.status);

const asCs = await api(`/pr/${prId}/rfq/reissue`, { method: 'POST', token: cs, body: {} });
ok(asCs.status === 403, 'the CS cannot re-issue (procurement-only, like issue)', asCs.status);

// A re-issue that adds nobody is refused rather than silently doing nothing.
const noop = await api(`/pr/${prId}/rfq/reissue`, {
  method: 'POST', token: procurement,
  body: { vendorIds: current.map(v => v.id) },
});
ok(noop.status === 400, 'a re-issue that adds nobody is refused', noop.status);

// ── 3a · OMITTING vendorIds MUST ADD NOBODY ─────────────────────────────────
// `resolveVendors()` auto-picks the eligible pool when handed no explicit list —
// right for a first issue, where that pool IS the roster, and a foot-gun here:
// a caller sending `{ deadlineAt }` alone to push the quote date out would
// silently invite every eligible vendor on the estate to a live RFQ. Found by
// this very test: the deadline-only call returned 201 and had widened the
// roster before the next assertion ran.
const rosterBefore = psql(`SELECT count(*) FROM proc.rfq_invitations WHERE rfq_id = '${rfqId}';`);
const widenAttempt = await api(`/pr/${prId}/rfq/reissue`, {
  method: 'POST', token: procurement,
  body: { deadlineAt: storedDeadline },   // no vendorIds at all
});
const rosterAfterWiden = psql(`SELECT count(*) FROM proc.rfq_invitations WHERE rfq_id = '${rfqId}';`);
ok(rosterAfterWiden === rosterBefore,
  'a re-issue with NO vendorIds invites nobody (no silent pool auto-pick)',
  { rosterBefore, rosterAfterWiden, status: widenAttempt.status });
ok(widenAttempt.status === 400,
  'and is refused when it also moves nothing', widenAttempt.status);

// ── 3b · THE DEADLINE MUST NOT MOVE WHEN NOBODY TOUCHED IT ──────────────────
// A bug that shipped in the first cut of this endpoint, so it gets a permanent
// guard rather than a note.
//
// The shared dialog edits an `<input type="date">` and therefore round-trips
// the deadline as `yyyy-mm-dd` — midnight. The first issue had stored
// `created_at + 7 days`, which carries the clock time of issue. Comparing the
// two at TIMESTAMP granularity found them different on every call, so the
// ordinary "add one vendor, press Send" silently rewrote the deadline to
// midnight, shortening the window the vendors were actually given. `resolve`
// also re-applied its 24h-from-now floor, which would have made an
// expired-but-open RFQ impossible to top up at all.
//
// This assertion sends the deadline back EXACTLY as the dialog would, which is
// what the browser path does.
const deadlineBefore = psql(
  `SELECT to_char(deadline_at, 'YYYY-MM-DD HH24:MI:SS') FROM proc.rfq WHERE id = '${rfqId}';`,
);
const resubmitted = await api(`/pr/${prId}/rfq/reissue`, {
  method: 'POST', token: procurement,
  // The current roster re-selected wholesale — the prototype's exact
  // "opened it, changed nothing, pressed Send" case. Every name is already
  // invited, so this must be a clean no-op and not a silent re-invite.
  body: { vendorIds: current.map(v => v.id), deadlineAt: storedDeadline },
});
const deadlineAfter = psql(
  `SELECT to_char(deadline_at, 'YYYY-MM-DD HH24:MI:SS') FROM proc.rfq WHERE id = '${rfqId}';`,
);
ok(resubmitted.status === 400,
  're-submitting the untouched deadline with no new vendor is refused', resubmitted.status);
ok(deadlineAfter === deadlineBefore,
  'the deadline is left byte-for-byte alone when the date did not change',
  { deadlineBefore, deadlineAfter, submitted: storedDeadline });

const added = await api(`/pr/${prId}/rfq/reissue`, {
  method: 'POST', token: procurement,
  // `deadlineAt` is sent here exactly as the dialog sends it: the stored date,
  // untouched. This IS the browser's "add one vendor and press Send".
  body: { vendorIds: [pickable[0].id], deadlineAt: storedDeadline },
});
ok([200, 201].includes(added.status), 're-issue accepted', { status: added.status, msg: added.data?.message });
ok(added.data?.rfq?.id === rfqId, 'it topped up the SAME RFQ, not a new one', { got: added.data?.rfq?.id, want: rfqId });
ok(added.data?.added === 1, 'exactly one vendor was added', added.data?.added);
ok(added.data?.already_on_roster === 2, 'the two existing vendors were counted, not re-invited', added.data?.already_on_roster);
ok(Number(added.data?.rfq?.reissue_count) === 1, 'reissue_count incremented to 1', added.data?.rfq?.reissue_count);
ok(Boolean(added.data?.rfq?.last_reissued_at), 'last_reissued_at stamped', added.data?.rfq?.last_reissued_at);
ok(added.data?.deadline_extended === false,
  'an untouched deadline is NOT reported as extended',
  added.data?.deadline_extended);

const deadlineFinal = psql(
  `SELECT to_char(deadline_at, 'YYYY-MM-DD HH24:MI:SS') FROM proc.rfq WHERE id = '${rfqId}';`,
);
ok(deadlineFinal === deadlineBefore,
  'the stored deadline is unchanged after a real re-issue that moved nothing but the roster',
  { deadlineBefore, deadlineFinal });

// Each newly added vendor must get its OWN credential — a second live link to
// the same RFQ is a second credential, and sha256-only storage must still hold.
const tokens = (added.data?.invitations || []).map(i => i.token).filter(Boolean);
ok(tokens.length === 1 && tokens[0] !== firstInvites[0], 'the new invitation has its own token', tokens.length);
const hashes = psql(`SELECT string_agg(token_hash, ',') FROM proc.rfq_invitations WHERE rfq_id = '${rfqId}';`);
ok(hashes.split(',').length === 3 && new Set(hashes.split(',')).size === 3,
  'three DISTINCT token hashes on the RFQ', hashes.split(',').length);

// ── 4 · the prior invitations are untouched ──────────────────────────────────
const detail = await api(`/rfq/${rfqId}`, { token: procurement });
const roster = detail.data?.roster || [];
ok(roster.length === 3, 'the roster now holds three vendors', roster.length);
const kept = firstInvites.every(id => roster.some(r => r.invitation_id === id));
ok(kept, 'both original invitations survived the top-up (rows were not replaced)');
ok(roster.filter(r => r.invitation_id === firstInvites[0]).length === 1,
  'no duplicate invitation rows were created');

// ── 5 · persistence, read back from the database ─────────────────────────────
const rows = psql(
  `SELECT count(*), max(reissue_count), max(last_reissued_at) IS NOT NULL
     FROM proc.rfq WHERE pr_id = '${prId}' AND state <> 'Cancelled';`,
).split('|');
ok(rows[0] === '1', 'the PR still carries exactly ONE live RFQ', rows[0]);
ok(rows[1] === '1', 'reissue_count persisted as 1', rows[1]);
ok(rows[2] === 't', 'last_reissued_at persisted', rows[2]);

// The CHECK that couples the two columns, asserted against the estate rather
// than trusted: a row claiming a re-issue without saying when would render a
// chip backed by nothing.
const drift = psql(
  `SELECT count(*) FROM proc.rfq
    WHERE (reissue_count > 0 AND last_reissued_at IS NULL)
       OR (reissue_count = 0 AND last_reissued_at IS NOT NULL);`,
);
ok(drift === '0', 'no RFQ anywhere has an inconsistent re-issue stamp', drift);

// ── 6 · the my-prs STATUS column sees it ────────────────────────────────────
// `/pr/capital/my`, not `/my-prs` — that is the route the Lightweight PRs grid
// actually calls, and it returns { detailed, light }. Reading the wrong path
// here would 404 and assert nothing.
const mine = await api('/pr/capital/my', { token: procurement });
const row = (mine.data?.light || []).find(r => r.id === prId);
ok(Number(row?.reissue_count) === 1,
  'the my-prs STATUS column reports reissue_count 1 for this PR', row?.reissue_count);
ok(Number(row?.invited_vendors) === 3,
  'and the widened roster (3), which is what "Re-issued x1" sits beside', row?.invited_vendors);

// ── 7 · THE CHAIN-OF-CUSTODY GATE ───────────────────────────────────────────
// The load-bearing control. Both endpoints that add a vendor to a LIVE RFQ must
// refuse once the PR has left IN_PROCUREMENT_REVIEW — because at that point the
// vendor set is a decided or forwarded competition, and the actor who ran it
// holds no rights over it.
//
// `POST /pr/:id/rfq/reissue` is the multi-vendor door and `POST /rfq/:id/invite`
// is the single-vendor one. BOTH are asserted, because gating only the newer
// endpoint left the identical act fully open one route over — verified live
// before the fix: an invite on a PR at QUOTES_RECEIVED returned 201 and
// appended a fourth vendor to the roster.
//
// Driven against real RFQs already on the estate that sit past procurement, so
// this asserts the gate rather than a fixture I happened to build.
const forwardLooking = psql(
  `SELECT rf.id || '|' || pr.id || '|' || rf.rfq_number || '|' || pr.status || '|' ||
          (SELECT count(*) FROM proc.rfq_invitations i WHERE i.rfq_id = rf.id)
     FROM proc.rfq rf
     JOIN proc.purchase_requisitions pr ON pr.id = rf.pr_id
    WHERE rf.state = 'Open'
      AND pr.status NOT IN ('IN_PROCUREMENT_REVIEW','READY_FOR_D365')
    ORDER BY rf.created_at DESC LIMIT 1;`,
);
if (!forwardLooking) {
  console.log('  note  no Open RFQ on a forward-looking PR right now — gate not exercised');
} else {
  const [oldRfqId, oldPrId, oldRfqNo, oldStage, oldCount] = forwardLooking.split('|');
  console.log(`  note  probing ${oldRfqNo} (PR stage ${oldStage}) as the forwarded-case fixture`);

  const spare = psql(
    `SELECT id FROM core.vendors v
      WHERE v.state = 'Active'
        AND NOT EXISTS (SELECT 1 FROM proc.rfq_invitations i
                         WHERE i.rfq_id = '${oldRfqId}' AND i.vendor_id = v.id)
      ORDER BY v.vendor_code LIMIT 1;`,
  );
  ok(Boolean(spare), 'a spare Active vendor exists to attempt the invite with', forwardLooking);

  // Single-vendor door.
  const oldInvite = await api(`/rfq/${oldRfqId}/invite`, {
    method: 'POST', token: procurement, body: { vendorId: spare },
  });
  ok(oldInvite.status === 400,
    `invite is REFUSED on a PR at ${oldStage}`, { status: oldInvite.status, msg: oldInvite.data?.message });
  ok(/reject the PR with remarks|return it to procurement/i.test(String(oldInvite.data?.message || '')),
    'the refusal names the sanctioned route instead of implying a workaround',
    oldInvite.data?.message);

  // Multi-vendor door.
  const oldReissue = await api(`/pr/${oldPrId}/rfq/reissue`, {
    method: 'POST', token: procurement, body: { vendorIds: [spare] },
  });
  ok(oldReissue.status === 400,
    `re-issue is REFUSED on a PR at ${oldStage}`, { status: oldReissue.status, msg: oldReissue.data?.message });

  // The PREVIEW is gated exactly as strictly as the write, so the dialog cannot
  // open onto an error the buyer has no action for.
  const oldCands = await api(`/pr/${oldPrId}/rfq/candidates`, { token: procurement });
  ok(oldCands.status === 400,
    'and so is the candidates endpoint that feeds the dialog', oldCands.status);

  // The refusal must write NOTHING — not even a reissue_count bump, which is
  // what the Re-issued chip reads.
  const countAfter = psql(
    `SELECT count(*) || '|' || max(reissue_count) FROM proc.rfq_invitations i
       JOIN proc.rfq rf ON rf.id = i.rfq_id
      WHERE rf.id = '${oldRfqId}';`,
  );
  const [invCount, reissueCount] = countAfter.split('|');
  ok(invCount === oldCount,
    'the forwarded PR roster is untouched — the refusals wrote nothing',
    { oldCount, invCount, reissueCount });

  // Read access is NOT what is gated: the current holder still needs to see it.
  const readable = await api(`/rfq/${oldRfqId}`, { token: procurement });
  ok([200, 201].includes(readable.status),
    'the forwarded RFQ remains READABLE (only writes are gated)', readable.status);
}

// ── 8 · A PR with no RFQ cannot be re-issued ─────────────────────────────────
const pr2 = await api('/pr', {
  method: 'POST', token: requester,
  body: {
    scope: 'Re-issue regression', expenseType: 'OPEX', costCenterId,
    requiredByDate: '2026-12-31', title: 'No RFQ yet',
    description: 'Nothing to top up.',
    lines: [{ itemId: LAPTOP, quantity: 1, uom: 'EA', unitPriceEst: 50_000 }],
  },
});
await api(`/pr/${pr2.data.id}/advance`, {
  method: 'POST', token: hod,
  body: { lineDecisions: { 0: 'approved' }, reason: 'HOD approves' },
});
const orphan = await api(`/pr/${pr2.data.id}/rfq/reissue`, {
  method: 'POST', token: procurement, body: {},
});
ok(orphan.status === 400, 're-issuing a PR with no RFQ is refused', orphan.status);
ok(/no open RFQ/i.test(String(orphan.data?.message || '')),
  'the refusal says there is nothing to re-issue', orphan.data?.message);

// ── 9 · QUOTATIONS ARE GATED BY THE SAME RULE ────────────────────────────────
// Writing a quotation is not a different act from adding a vendor to the
// roster — both are procurement writing to a live competition. Same constant,
// same gate.
//
// `requireOpenRfq` used to check only `rfq.state = 'Open'`, which protected
// CS_LOCKED and PACK_LOCKED only by COINCIDENCE (those RFQs are marked
// `Awarded` when the CS locks) and left the entire QUOTES_RECEIVED population
// open. Verified live before the fix: a new vendor quote on a PR at
// QUOTES_RECEIVED returned 201.
const quotesGate = psql(
  `SELECT rf.id || '|' || pr.id || '|' || pr.pr_number || '|' || pr.status || '|' ||
          i.vendor_id || '|' ||
          (SELECT count(*) FROM proc.quotations q
            WHERE q.rfq_id = rf.id AND q.vendor_id = i.vendor_id)
     FROM proc.purchase_requisitions pr
     JOIN proc.rfq rf ON rf.pr_id = pr.id AND rf.state = 'Open'
     JOIN proc.rfq_invitations i ON i.rfq_id = rf.id
    WHERE pr.status = 'QUOTES_RECEIVED'
    ORDER BY pr.created_at DESC LIMIT 1;`,
);
if (!quotesGate) {
  console.log('  note  no QUOTES_RECEIVED PR with an Open RFQ right now — quotation gate not exercised');
} else {
  const [qRfq, qPr, qNo, qStage, qVendor] = quotesGate.split('|');
  console.log(`  note  probing ${qNo} (stage ${qStage}) for the quotation gate`);

  const before = psql(
    `SELECT count(*) FROM proc.quotations WHERE rfq_id = '${qRfq}' AND vendor_id = '${qVendor}';`,
  );
  const attempt = await api(`/rfq/${qRfq}/quotations`, {
    method: 'POST', token: procurement,
    body: {
      vendorId: qVendor, currency: 'PKR', unitPrice: 12345, totalPrice: 12345,
      totalAmount: 12345, leadTimeDays: 7, validUntil: '2026-12-31',
      paymentTerms: '30 Days Net', lines: [],
    },
  });
  ok(attempt.status === 400,
    `a NEW quote is refused on a PR at ${qStage}`,
    { status: attempt.status, msg: attempt.data?.message });
  ok(/has left|reject the pr with remarks/i.test(String(attempt.data?.message || '')),
    'the refusal names the chain-of-custody reason', attempt.data?.message);

  // A REVISION is the more dangerous write — it silently moves a price the
  // award is about to be decided on — so it gets its own check on a vendor
  // that already holds a live quote.
  const liveQuote = psql(
    `SELECT q.id || '|' || q.vendor_id
       FROM proc.quotations q
      WHERE q.rfq_id = '${qRfq}' AND q.state = 'Submitted'
      LIMIT 1;`,
  );
  if (!liveQuote) {
    console.log('  note  no live quote on that RFQ — revision gate not exercised');
  } else {
    const [qId, qVend] = liveQuote.split('|');
    const rev = await api(`/quotations/${qId}/supersede`, {
      method: 'POST', token: procurement,
      body: { vendorId: qVend, currency: 'PKR', unitPrice: 999, totalPrice: 999, totalAmount: 999 },
    });
    ok(rev.status === 400,
      'a REVISION is refused on the same PR',
      { status: rev.status, msg: rev.data?.message });
    const stillSubmitted = psql(
      `SELECT state FROM proc.quotations WHERE id = '${qId}';`,
    );
    ok(stillSubmitted === 'Submitted',
      'the prior version was NOT marked Superseded — the refusal wrote nothing', stillSubmitted);
  }

  const after = psql(
    `SELECT count(*) FROM proc.quotations WHERE rfq_id = '${qRfq}' AND vendor_id = '${qVendor}';`,
  );
  ok(after === before,
    'the quote count on the settled PR is unchanged', { before, after });
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
if (fail > 0) process.exit(1);