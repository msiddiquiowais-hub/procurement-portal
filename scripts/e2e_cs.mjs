// Wave 2 step 6 — Comparative Statement: generate + lock.
//
//   node scripts/e2e_cs.mjs
//
// Requires: Postgres on 55432, the API on 33001, migrations 025 + 026 applied.
//
// What this suite proves:
//   1. Generation writes REAL cs_lines scores, not decorative numbers.
//   2. Generation does NOT pick a winner — the prototype's CS screen offers
//      "Recommend <vendor>" buttons, so the choice is a human's.
//   3. Locking is TERMINAL: a second lock is refused.
//   4. Separation of duties: the PR's own requester cannot lock the CS
//      (proc.fn_check_sod is the schema's own opinion on this).
//   5. Overriding the top-ranked vendor REQUIRES a written reason.
//   6. FAST_TRACK auto-locks the approved pack, with a REAL sha256 hash — the
//      prototype does this at line 7205 and decision 10 says keep it.
//   7. STANDARD moves the PR to CS_LOCKED — the prototype's own stage, storable
//      since migration 027. This replaces Q4's "leave it parked", which applied
//      only while no governance stage existed in the database.
//   8. Compliance is never a fabricated pass (D5).

import { spawnSync } from 'child_process';
import { issueWithRoster } from './_rfq_roster.mjs';

const API = process.env.API_BASE || 'http://127.0.0.1:33001';
const LAPTOP = '55555555-5555-5555-5555-555555555503';

let pass = 0, fail = 0;
const ok = (c, label, extra) => {
  if (c) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''}`); }
};

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, data };
}

/**
 * Read-only DB probe. stderr is PIPED as well as stdout: the immutability
 * check below relies on a plpgsql RAISE NOTICE, and psql sends notices to
 * stderr — inheriting it would leave the captured string empty and the
 * assertion would fail for the wrong reason.
 */
/**
 * Read-only DB probe. spawnSync (not execFileSync) because psql sends RAISE
 * NOTICE to STDERR, and execFileSync returns only stdout — the immutability
 * check below would then see an empty string and fail for the wrong reason.
 * Both streams are concatenated so a NOTICE is as assertable as a row.
 */
function psql(sql) {
  const r = spawnSync('docker', ['exec', '-i', 'procurement-portal-db', 'psql',
    '-U', 'proc', '-d', 'procurementDB', '-X', '-q', '-t', '-A', '-F', '|', '-f', '-'],
    { input: sql, encoding: 'utf8' });
  if (r.error) throw r.error;
  return `${r.stdout || ''}${r.stderr || ''}`.trim();
}

const login = async (email) => (await api('/auth/login', { method: 'POST', body: { email, password: 'demo' } })).data?.token;
const cell = (x) => {
  const t = String(x).trim();
  if (t === 't' || t === 'true') return 'true';
  if (t === 'f' || t === 'false') return 'false';
  const n = Number(t);
  return t !== '' && Number.isFinite(n) ? String(n) : t;
};

console.log(`\n=== Wave 2 step 6 · Comparative Statement against ${API} ===\n`);

const requester = await login('requester@pakboxes.pk');
const hod = await login('hod.sales@pakboxes.pk');
const procurement = await login('procurement@pakboxes.pk');
const csUser = await login('cs@pakboxes.pk');
ok(Boolean(requester && hod && procurement && csUser), 'logins returned tokens');

const ccs = await api('/lookups/cost-centers', { token: requester });
const costCenterId = ccs.data?.[0]?.id;

/**
 * A PR in procurement review with an issued RFQ and `bids` vendor quotes.
 * `bids` = [[amount, leadDays, warrantyMonths], ...] — deliberately varied so
 * the scoring has something real to rank.
 */
async function fixture(title, bids) {
  const c = await api('/pr', {
    method: 'POST', token: requester,
    body: { scope: 'Step 6 fixture', expenseType: 'OPEX', costCenterId,
            requiredByDate: '2026-12-31', title,
            lines: [{ itemId: LAPTOP, quantity: 1, uom: 'EA', unitPriceEst: 45000 }] },
  });
  const prId = c.data.id;
  await api(`/pr/${prId}/advance`, {
    method: 'POST', token: hod,
    body: { lineDecisions: { 0: 'approved' }, reason: 'step 6' },
  });
  const { rfqId, invites } = await issueWithRoster(api, procurement, prId, bids.length);
  for (let i = 0; i < bids.length; i++) {
    const [amount, lead, warranty] = bids[i];
    const r = await api(`/rfq/${rfqId}/quotations`, {
      method: 'POST', token: procurement,
      body: { vendorId: invites[i].vendor_id, totalAmount: amount, quoteMode: 'total',
              leadTimeDays: lead, warrantyMonths: warranty,
              paymentTerms: '30 days net' },
    });
    if (r.status >= 400) throw new Error(`quote ${i} failed: ${JSON.stringify(r.data)}`);
  }
  return { prId, rfqId, invites };
}

// ── 1 · STANDARD route: generate, score, lock ──────────────────────────────
console.log('\n--- generate: real cs_lines scores ---');

const std = await fixture('CS standard route', [
  [120000, 21, 12],   // dearest, slowest, shortest warranty
  [90000, 7, 36],     // cheapest, fastest, longest warranty — should rank 1
  [110000, 14, 24],
]);

const gen = await api(`/pr/${std.prId}/cs`, { method: 'POST', token: procurement });
ok([200, 201].includes(gen.status), 'CS generated', { status: gen.status, msg: gen.data?.message });
ok(gen.data?.cs?.state === 'Generated', 'the CS starts in state Generated', gen.data?.cs?.state);
ok(/^CS-\d{4}-\d{6}$/.test(gen.data?.cs?.cs_number || ''),
  'cs_number uses proc.fn_next_cs_number() (6-digit form from migration 025)', gen.data?.cs?.cs_number);

const lines = gen.data?.lines || [];
ok(lines.length === 3, 'one cs_lines row per live quote', lines.length);
ok(lines.every(l => l.rank >= 1), 'every line satisfies cs_lines_rank_check (rank >= 1)');
ok(lines.every(l => [l.commercial_score, l.technical_score, l.warranty_score, l.weighted_score]
  .every(s => typeof s === 'number' && s >= 0 && s <= 100)),
  'every score is inside the schema\'s 0..100 CHECK bounds');

// The vendor that is best on ALL THREE axes must rank 1.
const best = lines.find(l => l.vendor_id === std.invites[1].vendor_id);
const worst = lines.find(l => l.vendor_id === std.invites[0].vendor_id);
ok(best?.rank === 1, 'the best-on-every-axis vendor ranks 1', { rank: best?.rank, scores: best });
ok(best?.commercial_score === 100 && best?.technical_score === 100 && best?.warranty_score === 100,
  'and scores 100 on each criterion', best);
ok(worst?.rank === 3, 'the worst-on-every-axis vendor ranks 3', worst?.rank);
ok(worst?.commercial_score === 0 && worst?.technical_score === 0 && worst?.warranty_score === 0,
  'and scores 0 on each criterion', worst);
ok(best.weighted_score > worst.weighted_score, 'the weighted score agrees with the rank order',
  { best: best.weighted_score, worst: worst.weighted_score });

ok(gen.data?.cs?.winner === undefined || gen.data.cs.winner === null,
  'generation does NOT pick a winner — that is the reviewer\'s choice at lock time');

const stored = psql(`
  SET app.bypass_rls = 'true';
  SELECT count(*) || '|' || sum(rank)::text FROM proc.cs_lines WHERE cs_id = '${gen.data.cs.id}';`)
  .split('|').map(cell).join('|');
ok(stored === '3|6', 'the DB holds 3 cs_lines rows with ranks summing to 6 (1+2+3)', stored);

const genAgain = await api(`/pr/${std.prId}/cs`, { method: 'POST', token: procurement });
ok(genAgain.status === 400, 'generating a second CS on the same PR is refused', genAgain.status);
ok(/UNIQUE\(pr_id, ?cs_round\)/.test(genAgain.data?.message || ''), 'the refusal names the unique constraint');

const asRequester = await api(`/pr/${std.prId}/cs`, { method: 'POST', token: requester });
ok(asRequester.status === 403, 'a requester cannot generate a CS', asRequester.status);

// ── 2 · lock guards ────────────────────────────────────────────────────────
console.log('\n--- lock guards ---');

const asReqLock = await api(`/cs/${gen.data.cs.id}/lock`, {
  method: 'POST', token: requester, body: { winnerVendorId: best.vendor_id },
});
ok(asReqLock.status === 403, 'a requester cannot lock the CS (role gate)', asReqLock.status);
ok(/Only Procurement \/ CS/.test(asReqLock.data?.message || ''),
  "the refusal carries csLock()'s own words", asReqLock.data?.message);

const unknownWinner = await api(`/cs/${gen.data.cs.id}/lock`, {
  method: 'POST', token: procurement,
  body: { winnerVendorId: '44444444-4444-4444-4444-444444444401' },
});
ok(unknownWinner.status === 400, 'the winner must be a vendor scored on this CS', unknownWinner.status);

// Top rank needs no override reason; second rank does.
const noReason = await api(`/cs/${gen.data.cs.id}/lock`, {
  method: 'POST', token: csUser, body: { winnerVendorId: lines[1].vendor_id },
});
ok(noReason.status === 400, 'overriding the top-ranked vendor requires an overrideReason', noReason.status);
ok(/overrideReason/.test(noReason.data?.message || ''), 'the refusal names the missing field', noReason.data?.message);

// ── 3 · lock on STANDARD: winner recorded, PR enters the MC gate ───────────
console.log('\n--- lock on a STANDARD route (PR moves to CS_LOCKED) ---');

const lock = await api(`/cs/${gen.data.cs.id}/lock`, {
  method: 'POST', token: csUser,
  body: { winnerVendorId: best.vendor_id, reason: 'Best total, fastest lead, longest warranty.' },
});
ok([200, 201].includes(lock.status), 'CS locked by the cs role', { status: lock.status, msg: lock.data?.message });
ok(lock.data?.cs?.state === 'Locked', 'state is Locked', lock.data?.cs?.state);
ok(Boolean(lock.data?.cs?.locked_at), 'locked_at is stamped (the state/lock consistency CHECK requires it)');
ok(lock.data?.winner?.vendor_id === best.vendor_id, 'the winner is the one chosen', lock.data?.winner);
ok(lock.data?.winner?.is_override === false, 'choosing rank 1 is not an override');
ok(lock.data?.routing_key === 'STANDARD', 'the route is STANDARD', lock.data?.routing_key);
ok(lock.data?.pack === null || lock.data?.pack === undefined, 'a STANDARD route does NOT auto-lock the pack');
ok(lock.data?.stage === 'CS_LOCKED', 'the response reports the new stage', lock.data?.stage);
ok(lock.data?.next?.includes('MC Member to vote'), 'the response says to switch to MC', lock.data?.next);

// Wave 3 decision 1A superseded Q4. The PR used to stay at
// IN_PROCUREMENT_REVIEW because no governance stage was storable; migration 027
// added the prototype's own values, so the CS lock now moves the PR exactly as
// csLock() does at line 7201-7215.
const prAfter = psql(`
  SET app.bypass_rls = 'true';
  SELECT status FROM proc.purchase_requisitions WHERE id = '${std.prId}';`);
ok(prAfter === 'CS_LOCKED',
  'the CS lock moved the PR to CS_LOCKED — the committee now has a vote to cast', prAfter);

const qStates = psql(`
  SET app.bypass_rls = 'true';
  SELECT state || ':' || count(*) FROM proc.quotations
   WHERE rfq_id = '${std.rfqId}' AND state IN ('Awarded','Rejected')
   GROUP BY state ORDER BY state;`).split('\n').filter(Boolean);
ok(qStates.length === 2 && qStates[0] === 'Awarded:1' && qStates[1] === 'Rejected:2',
  'the winner is Awarded and the other two Rejected (the DB vocabulary, Q1)', qStates);

ok(psql(`
  SET app.bypass_rls = 'true';
  SELECT state FROM proc.rfq WHERE id = '${std.rfqId}';`) === 'Awarded', 'the RFQ is Awarded');

// ── 4 · the lock is TERMINAL ───────────────────────────────────────────────
console.log('\n--- locking is terminal ---');

const relock = await api(`/cs/${gen.data.cs.id}/lock`, {
  method: 'POST', token: procurement, body: { winnerVendorId: best.vendor_id },
});
ok(relock.status === 400, 'a second lock is refused', { status: relock.status });
ok(/already locked/.test(relock.data?.message || ''), 'the refusal says it was already locked', relock.data?.message);
ok(/terminal/.test(relock.data?.message || ''), 'and states that locking is terminal', relock.data?.message);

// ── 5 · FAST_TRACK auto-locks the pack (decision 10) ───────────────────────
console.log('\n--- FAST_TRACK auto-locks the approved pack ---');

const ft = await fixture('CS fast-track route', [[80000, 5, 24], [95000, 9, 12]]);
// Force the route. The engine derives routing_key; sourcing only reacts to it.
psql(`
  SET app.bypass_rls = 'true';
  UPDATE proc.purchase_requisitions SET routing_key = 'FAST_TRACK' WHERE id = '${ft.prId}';`);

const ftGen = await api(`/pr/${ft.prId}/cs`, { method: 'POST', token: procurement });
ok([200, 201].includes(ftGen.status), 'CS generated on the fast-track PR', ftGen.data?.message);
const ftBest = (ftGen.data?.lines || [])[0];
ok(ftBest?.rank === 1, 'the fast-track CS scored its vendors', ftBest?.rank);

const ftLock = await api(`/cs/${ftGen.data.cs.id}/lock`, {
  method: 'POST', token: procurement,
  body: { winnerVendorId: ftBest.vendor_id, reason: 'Cheapest and fastest.' },
});
ok([200, 201].includes(ftLock.status), 'CS locked on a FAST_TRACK route', ftLock.data?.message);
ok(ftLock.data?.routing_key === 'FAST_TRACK', 'the route is FAST_TRACK', ftLock.data?.routing_key);
ok(ftLock.data?.pack?.auto_locked === true, 'the pack was auto-locked in the same action', ftLock.data?.pack);
ok(/^sha256:[0-9a-f]{64}$/.test(ftLock.data?.pack?.pack_hash || ''),
  'D1: pack_hash is a REAL sha256 digest, not a placeholder', ftLock.data?.pack?.pack_hash);

const packRow = psql(`
  SET app.bypass_rls = 'true';
  SELECT (pack_hash = proc.fn_pack_hash(payload))::text || '|' || (mc = true)::text
    FROM (SELECT pack_hash, payload,
                 (payload->>'mc_cfo_skipped')::boolean AS mc
            FROM proc.approved_packs WHERE pr_id = '${ft.prId}') s;`);
ok(packRow === 'true|true',
  'the stored hash actually matches the payload, and the payload records mc_cfo_skipped', packRow);

ok(ftLock.data?.event?.action === 'CS locked (fast-track)',
  "the event line is the prototype's own fast-track wording", ftLock.data?.event);
ok(/MC \+ CFO skipped/.test(ftLock.data?.event?.detail || ''),
  'and says MC + CFO were skipped', ftLock.data?.event?.detail);
ok(/Pack auto-locked/.test(ftLock.data?.next || ''),
  'the next-step text says the pack was auto-locked', ftLock.data?.next);

// The pack is immutable: the trigger must reject a mutation.
const mutate = psql(`
  SET app.bypass_rls = 'true';
  DO $$
  BEGIN
    BEGIN
      UPDATE proc.approved_packs SET payload = jsonb_set(payload,'{reason}','"tampered"')
       WHERE pr_id = '${ft.prId}';
      RAISE NOTICE 'MUTATION ALLOWED — the immutability trigger is missing';
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'MUTATION REJECTED: %', SQLERRM;
    END;
  END $$;`);
ok(/MUTATION REJECTED/.test(mutate), 'a post-lock pack mutation is rejected by the schema', mutate.trim());

// ── 6 · the CS screen payload + D5 compliance ──────────────────────────────
console.log('\n--- GET /pr/:id/cs and D5 compliance ---');

const screen = await api(`/pr/${std.prId}/cs`, { token: procurement });
ok(screen.status === 200, 'GET /pr/:id/cs 200', screen.status);
ok(screen.data?.cs?.state === 'Locked', 'the payload reports the locked state', screen.data?.cs?.state);
ok(screen.data?.cs?.winner?.vendor_id === best.vendor_id, 'and the winner', screen.data?.cs?.winner);
ok(screen.data?.ready === false, 'the lock buttons disappear once locked', screen.data?.ready);
ok(Array.isArray(screen.data?.lines) && screen.data.lines.length === 3, 'all 3 scored lines are returned');
ok(screen.data?.weights?.commercial !== undefined, 'the weights come back from the schema', screen.data?.weights);

// D5: no vendor has a due-diligence record, so compliance is unknown everywhere.
ok(screen.data?.lines?.every(l => l.compliance?.status === 'unknown'),
  'D5: compliance is unknown for every vendor', screen.data?.lines?.map(l => l.compliance));
ok(screen.data?.lines?.every(l => l.compliance?.label === '—'),
  'and renders as an em-dash, never a fabricated pass');
ok(screen.data?.scores?.compliance_scored === false,
  'the CS records that compliance is NOT a scored criterion', screen.data?.scores);

const none = await api('/pr/00000000-0000-0000-0000-000000000000/cs', { token: procurement });
ok(none.status === 404, 'an unknown PR is a 404', none.status);

// ── summary ────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
