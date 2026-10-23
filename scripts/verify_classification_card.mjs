// Asserts the Capex/Opex card has everything it needs, for every role the
// classification is supposed to be reachable by.
//
//   node scripts/verify_classification_card.mjs [prId]
//
// WHAT IT ASSERTS, AND WHY IT IS STAGE-AWARE
// -------------------------------------------
// The card is editable only where the workflow actually asks for a
// classification: at the CS exit, once the blind review is CONFIRMED and the
// request is still held in sourcing. The prototype's rule (line 2076) is
//     requiresCapexOpex && _lightBranchMatches(s.when, pr, {})
// and the two steps that demand a class are the CS exit steps, both
// conditioned on `csReviewConfirmed`.
//
// So a request that is PAST the exit (already at cost approval) correctly has
// a closed window, and a request whose review has not concluded correctly has
// one too. This script used to assert that the card was writable for every PR
// it was pointed at, which is only true at the exit — and it defaulted to
// PR-2026-202043, which sits AT cost approval, so a run with no argument
// reported a failure that was the rule working.
//
// The invariant that holds at EVERY stage is one-directional and is what this
// script now asserts:
//
//   · wherever the API says the card is writable for a role, the PATCH that
//     the card issues must be ACCEPTED — a card that renders editable for
//     someone the API then refuses is worse than no card;
//   · for a role with no business on the request (the Head of Sales, the
//     requester), the PATCH must be REFUSED, whatever the stage.
//
// The default PR is one parked in sourcing with a confirmed review, so the
// writable path is actually exercised.

const BASE = 'http://localhost:33001';

// PR-2026-202216 — IN_PROCUREMENT_REVIEW, CS review CONFIRMED, lines already
// classified. The write-back below is therefore a true no-op, and the fixture
// is left exactly as it was found.
const DEFAULT_PR_ID = '85ee712e-a443-4c46-9385-96c5dbc26fd0';
const PR_ID = process.argv[2] || DEFAULT_PR_ID;

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''}`); }
};

const login = async (email) => {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'demo' }),
  });
  const b = await r.json();
  if (!b.token) throw new Error(`login ${email}: ${JSON.stringify(b)}`);
  return b.token;
};
const get = async (token, path) => {
  const r = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  let b = null; try { b = await r.json(); } catch { /* empty */ }
  return { status: r.status, body: b };
};
const patchLines = async (token, line) => {
  const life = line?.useful_life_years != null ? Number(line.useful_life_years) : undefined;
  const r = await fetch(`${BASE}/pr/${PR_ID}/lines/classification`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      lines: [{
        lineNo: line.line_no,
        classification: line.classification ?? 'OPEX_CONSUMABLE',
        ...(life !== undefined ? { usefulLifeYears: life } : {}),
      }],
    }),
  });
  let b = null; try { b = await r.json(); } catch { /* empty */ }
  return { status: r.status, body: b };
};

const CASES = [
  { email: 'procurement@pakboxes.pk', label: 'Procurement Officer (Hina Tariq)', mayWrite: true },
  { email: 'hod.procurement@pakboxes.pk', label: 'HOD Procurement (Nadia Farooq)', mayWrite: true },
  // The two who must NOT get it. A card editable for the Head of Sales would be
  // the retired-role bug again, one department over.
  { email: 'hod.sales@pakboxes.pk', label: 'Head of Sales (not procurement)', mayWrite: false },
  { email: 'requester@pakboxes.pk', label: 'the requester', mayWrite: false },
];

console.log(`\nclassification access on GET /pr/${PR_ID}\n`);

const first = await login(CASES[0].email);
const stage = await get(first, `/pr/${PR_ID}`);
const cl = stage.body?.classification ?? null;
console.log(`       stage=${stage.body?.status}  window_open=${cl?.window_open}  exit_step=${cl?.exit_step ?? '-'}`);
console.log(`       ${cl?.window_reason ?? '(the window is open)'}\n`);

for (const c of CASES) {
  const token = await login(c.email);
  const d = await get(token, `/pr/${PR_ID}`);
  ok(d.status === 200, `${c.label} can read the PR`, d.status);
  const k = d.body?.classification;
  ok(Boolean(k), `${c.label}: GET /pr/:id returns a classification block`, Object.keys(d.body ?? {}).length);

  if (!c.mayWrite) {
    ok(k?.can_write === false && k?.can_correct === false,
      `${c.label}: no write and no correction`, { w: k?.can_write, c: k?.can_correct });
    // And the write itself must be refused, whatever the stage.
    const live = (d.body?.lines ?? []).filter((l) => l.approved && !l.rejected && !l.held)[0];
    if (live) {
      const w = await patchLines(token, live);
      ok(w.status === 403 || w.status === 400,
        `${c.label}: the write is REFUSED`, { http: w.status, body: w.body });
    }
    continue;
  }

  // The card is editable for this role exactly when the window is open.
  ok(k?.can_write === k?.window_open,
    `${c.label}: can_write follows the window`, { can_write: k?.can_write, window_open: k?.window_open });

  if (k?.window_open) {
    ok(Boolean(k?.exit_step), `${c.label}: the card can name the CS exit in front of them`, k?.exit_step);
    const live = (d.body?.lines ?? []).find((l) => l.approved && !l.rejected && !l.held);
    if (live) {
      const w = await patchLines(token, live);
      ok(w.status === 200 || w.status === 201,
        `${c.label}: the PATCH the card issues is ACCEPTED — the card and the gate agree`,
        { http: w.status, body: w.body });
    }
  } else {
    console.log(`       (the window is closed here, so the card is read-only and no write is attempted)`);
  }
}

console.log(`\npassed ${pass}, failed ${fail}\n`);
process.exit(fail ? 1 : 0);
