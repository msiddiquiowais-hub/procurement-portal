// The classification WINDOW, across the stages that matter.
//
//   node scripts/verify_classification_window.mjs
//
// A read-only probe. It logs in, asks the API for four requests that sit at
// four different points, and prints what the API says about the card.
//
// The four are the ones that tell each other apart:
//
//   PR-2026-202216  IN_PROCUREMENT_REVIEW, review CONFIRMED   -> the CS exit
//   PR-2026-201708  IN_PROCUREMENT_REVIEW, review REQUESTER_REVIEW -> mid-review
//   PR-2026-202219  QUOTES_RECEIVED, no statement at all       -> RFQ not issued
//   PR-2026-202043  IN_COST_CENTER_APPROVAL, review CONFIRMED  -> past the exit
//
// Only the first may have the card open. The second is the change: a review
// that is under way is not a conclusion, and the class is made at the exit.

const BASE = 'http://localhost:33001';

const CASES = [
  { pr: '85ee712e-a443-4c46-9385-96c5dbc26fd0', n: 'PR-2026-202216', want: 'OPEN  ', why: 'at the CS exit: the blind review is CONFIRMED' },
  { pr: '165d0664-d81d-4b5c-8c01-026ce1f82ddb', n: 'PR-2026-201708', want: 'CLOSED', why: 'mid-review: the blind review has NOT concluded' },
  { pr: '62dd30cb-58c7-4dca-89b0-944cc23f2162', n: 'PR-2026-202219', want: 'CLOSED', why: 'RFQ not issued: there is no statement to exit' },
  { pr: '5b22df2b-90b4-44c4-9df9-ed7e43c6d286', n: 'PR-2026-202043', want: 'CLOSED', why: 'past the exit: the class was made on the way in' },
];

const login = async (email) => {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'demo' }),
  });
  const b = await r.json();
  if (!b.token) throw new Error(`login ${email}: ${JSON.stringify(b)}`);
  return b.token;
};

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''}`); }
};

const token = await login('procurement@pakboxes.pk');
console.log('\nclassification window, by stage\n');

for (const c of CASES) {
  const r = await fetch(`${BASE}/pr/${c.pr}`, { headers: { authorization: `Bearer ${token}` } });
  const b = await r.json();
  const cl = b.classification;
  const state = cl?.window_open ? 'OPEN  ' : 'CLOSED';
  console.log(`  ${c.n}  ${String(b.status).padEnd(22)} window=${state}  exit_step=${cl?.exit_step ?? '-'}`);
  console.log(`             ${c.why}`);
  ok(state === c.want, `${c.n}: the window is ${c.want.trim()}`, { got: state, want: c.want.trim(), window_open: cl?.window_open });
  if (c.want === 'OPEN  ') {
    ok(cl?.exit_step === 'cs_review' || cl?.exit_step === 'cs_review_quotes',
      `${c.n}: the card names the CS exit in front of them`, cl?.exit_step);
  } else {
    ok(cl?.can_set === false, `${c.n}: the class cannot be set here`, cl?.can_set);
  }
  console.log('');
}

console.log(`passed ${pass}, failed ${fail}\n`);
process.exit(fail ? 1 : 0);
