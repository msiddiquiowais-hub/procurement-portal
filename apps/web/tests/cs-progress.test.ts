// The My PRs STATUS column during the CS review window, and the ONE door out
// of it.
//
//   npm run test:web
//
// WHY THIS FILE EXISTS
// --------------------
// Requirement: while the workflow engine stage is CS review (QUOTES_RECEIVED)
// the STATUS column must resolve the live sub-state from proc.cs_reviews, not
// freeze at "Quotes received" — and once the request has crossed into cost
// approval it must read "Cost approval pending".
//
// THREE THINGS HAD TO BE TRUE AT ONCE, and only the first is visible
// --------------------------------------------------------------------
//   1. the sub-state is shown;
//   2. the FILTERS still work — components/sourcing/tabs.ts pins
//      QUOTES_RECEIVED into the "Received" tab with a written rationale that
//      sourcing-tabs.test.ts asserts, and that tab's chip currently reads 5.
//      Splitting that one sourcing_status value into five CS_* values would
//      have silently emptied it. So the sub-states are a PARALLEL column and
//      the tab predicates were not touched;
//   3. no "ready to advance" state appeared along the way.
//
// (3) is the one most likely to be re-introduced by a later change, because a
// "ready" pill looks helpful. It is not: the card's button is the only act, and
// a passive state that invites a second, separate click is a second door into
// the same gate.
//
// These assertions read SOURCE rather than render, for the same reason
// classification.render.test.tsx does for the create screen: the SQL lives in
// the API service and the labels in a page component, and the property worth
// pinning is that the two agree — which is only expressible across files.
// Comments are stripped first, so prose quoting a retired label cannot satisfy
// an absence check.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

function resolveWebRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    try {
      if (statSync(join(dir, 'pages')).isDirectory()) return dir;
    } catch { /* keep walking */ }
    dir = dirname(dir);
  }
  throw new Error('could not locate the apps/web root from ' + __dirname);
}

function resolveApiRoot(): string {
  // The sub-state is derived in the API, so this file crosses the app boundary.
  // apps/api is a SIBLING of apps/web, not an ancestor — walking UP from the web
  // root looking for `src/pr/pr.service.ts` passes apps/ and the repo root
  // without ever seeing it. Look for `api/` under each ancestor instead.
  let dir = resolveWebRoot();
  for (let i = 0; i < 4; i++) {
    try {
      if (statSync(join(dir, 'api', 'src', 'pr', 'pr.service.ts')).isFile()) {
        return join(dir, 'api');
      }
    } catch { /* keep walking */ }
    dir = dirname(dir);
  }
  throw new Error('could not locate apps/api from ' + resolveWebRoot());
}

function readSource(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/.*$/gm, '$1');
}

const webRoot = resolveWebRoot();
const apiRoot = resolveApiRoot();
const myPrsPage = readSource(join(webRoot, 'pages', 'my-prs.tsx'));
const detailPage = readSource(join(webRoot, 'pages', 'pr', '[id].tsx'));
const tabsSource = readSource(join(webRoot, 'components', 'sourcing', 'tabs.ts'));
const prService = readSource(join(apiRoot, 'src', 'pr', 'pr.service.ts'));

/** The `END AS cs_progress,` CASE in the myPrs light query. */
function csProgressCase(): string {
  const start = prService.indexOf('END AS cs_progress');
  assert.notEqual(start, -1, 'the myPrs light query must derive a cs_progress column');
  const open = prService.lastIndexOf('CASE', start);
  const head = prService.indexOf('THE CS SUB-STATE', open);
  // The comment block is stripped, so walk forward from the CASE itself.
  const from = open;
  return prService.slice(from, start);
}

/** Every literal the CASE can emit, in SQL order. */
function emittedValues(): string[] {
  const body = csProgressCase();
  const out: string[] = [];
  // THEN covers every named branch; ELSE is read too, because a catch-all that
  // names a real state IS one of those states reaching the screen — and one that
  // names nothing is an honest fallback.
  const re = /(?:THEN|ELSE)\s+'([A-Z_]+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push(m[1]);
  return out;
}

/** The labels map, and nothing else on the page. */
function labelsBlock(): string {
  const start = myPrsPage.indexOf('CS_PROGRESS_LABELS');
  assert.notEqual(start, -1, 'my-prs.tsx must carry a CS_PROGRESS_LABELS map');
  return myPrsPage.slice(start, myPrsPage.indexOf('function SourcingCell'));
}

/** Every key the web maps to a label. */
function labelledKeys(): string[] {
  return [...labelsBlock().matchAll(/^\s{2}([A-Z_]+):\s*\{/gm)].map((m) => m[1]);
}

// ── the SQL ─────────────────────────────────────────────────────────────────

test('S1 the myPrs light query emits the five CS sub-states and nothing else', () => {
  const values = emittedValues();
  for (const expected of [
    'CS_DRAFT',
    'CS_PROC_REVIEW',
    'CS_AWAITING_HOD',
    'CS_CONFIRMED_CLASSIFY',
    'CS_REVERTED',
  ]) {
    assert.ok(values.includes(expected), `the query must be able to emit ${expected}`);
  }
  // COST_APPROVAL_PENDING was here until migration 075 removed the stage it
  // described. The CS exit now lands on IN_FINANCE_REVIEW, which is a stage
  // question answered by the STAGE column.
  assert.ok(!values.includes('COST_APPROVAL_PENDING'),
    'no sub-state may describe a stage the ladder no longer routes to');
});

test('S2 there is deliberately NO "ready to advance" state', () => {
  const body = csProgressCase();
  assert.ok(
    !/READY/i.test(body),
    'a confirmed statement has exactly ONE outstanding action — the card\'s button. A '
    + 'passive "ready" state invites a second, separate click into the same gate.',
  );
  // Scoped to the LABELS, not the file. The word "ready" is also the session
  // readiness flag and appears inside "already" throughout this page, so a
  // whole-file check measures English rather than behaviour.
  assert.ok(
    !/ready/i.test(labelsBlock()),
    'no CS label may reintroduce a passive ready state on the STATUS cell',
  );
});

test('S3 the sub-states come from the CS chain at the LIVE round only', () => {
  // The join that makes a re-rolled statement report the round in force rather
  // than the round that was abandoned — the difference between "awaiting the
  // HOD" and "the HOD already sent it back".
  assert.ok(/current_round\s*=\s*cs\.cs_round/.test(prService),
    'the csprog CTE must join on the live round');
  assert.ok(/FROM\s+proc\.cs_reviews/.test(prService),
    'the sub-state must be read from proc.cs_reviews, not re-derived in the browser');
});

// ── the labels ──────────────────────────────────────────────────────────────

test('S4 every value the query can emit has a label, and every label is one it emits', () => {
  const emitted = emittedValues();
  const labelled = labelledKeys();
  for (const v of emitted) {
    assert.ok(labelled.includes(v),
      `the API emits ${v} and my-prs.tsx has no label for it — it would render as a raw enum`);
  }
  for (const v of labelled) {
    assert.ok(emitted.includes(v),
      `my-prs.tsx labels ${v}, which the query cannot emit — a label for a state that does `
      + 'not exist is a rule nobody is enforcing');
  }
});

test('S5 the STATUS cell prefers the sub-state over the frozen lifecycle value', () => {
  // Without the preference the six labels are dead code and every PR in the
  // window still reads "Quotes received" — the freeze the requirement forbids.
  const cell = myPrsPage.slice(
    myPrsPage.indexOf('function SourcingCell'),
    myPrsPage.indexOf('const SOURCING_TABS'),
  );
  const prefIdx = cell.search(/CS_PROGRESS_LABELS\[p\.cs_progress\]/);
  const switchIdx = cell.indexOf('switch (s)');
  assert.notEqual(prefIdx, -1, 'SourcingCell must consult CS_PROGRESS_LABELS');
  assert.notEqual(switchIdx, -1, 'SourcingCell must still fall back to sourcing_status');
  assert.ok(prefIdx < switchIdx,
    'the sub-state check must come BEFORE the sourcing_status switch, or it is unreachable');
});

test('S6 the required wording is what the requirement asked for', () => {
  for (const phrase of [
    'CS Draft',
    'CS In Review',
    'Awaiting HOD Confirm',
    'CS Confirmed / Classify Lines',
  ]) {
    assert.ok(myPrsPage.includes(`label: '${phrase}'`),
      `the STATUS cell must be able to say "${phrase}"`);
  }
});

// ── the filters ─────────────────────────────────────────────────────────────

test('S7 the Received tab filters on the real stage, not on a column that shadows it', () => {
  // Migration 075. `sourcing_status` used to emit QUOTES_RECEIVED alongside its
  // own sourcing-progress values, which gave one fact two owners — the ladder
  // and a CASE expression in a SELECT list. The regression this design exists to
  // prevent: if they disagree the Received chip silently empties, with no error
  // anywhere and the tab whose entire purpose is surfacing landed quotes.
  assert.ok(/p\.status\s*===\s*'QUOTES_RECEIVED'/.test(tabsSource),
    'the Received predicate must read the request\'s real stage');
  assert.ok(!/sourcing_status\s*===\s*'QUOTES_RECEIVED'/.test(tabsSource),
    'QUOTES_RECEIVED must not come back out of sourcing_status — that is the shadow');
  assert.ok(!/cs_progress/.test(tabsSource),
    'tabs.ts must not read cs_progress — the sub-states are display-only, and a tab '
    + 'that filters on them would split one bucket into five');
});

test('S7b sourcing_status no longer names a workflow stage', () => {
  // The masking, by name. Every value below is a stage of
  // proc.purchase_requisitions.status, and the derivation used to re-emit them —
  // which is how a request sitting in Finance review rendered in STATUS as
  // "Awaiting Quotes", because its quote deadline was still ahead. The column
  // reported sourcing progress in the vocabulary of the workflow.
  // A window rather than a brace match: the CASE is 3,000 characters of SQL
  // with comments inside it, and the only strings that matter are the emitted
  // literals. Comments in that block deliberately name the stages they stopped
  // emitting, which is why the check is for `THEN '<stage>'` and not for the
  // bare name.
  const end = prService.indexOf('END AS sourcing_status');
  const caseBlock = prService.slice(end - 6000, end);
  for (const stage of ['PACK_LOCKED', 'CFO_APPROVED', 'MC_APPROVED', 'CS_LOCKED', 'QUOTES_RECEIVED']) {
    assert.ok(
      !new RegExp(`THEN '${stage}'`).test(caseBlock),
      `sourcing_status must not emit ${stage} — the STAGE column owns that, and a `
      + 'second owner is free to drift from the ladder',
    );
  }
  assert.ok(/THEN 'SOURCING_CLOSED'/.test(caseBlock),
    'the precedence branch must still exist, saying only that sourcing concluded — '
    + 'without it a concluded PR with a past deadline reads EXPIRED again');
});

test('S7c no request past the CS exit reports a LIVE quotation state', () => {
  // Found by the user, not a test: Case 21 sat in FINANCE REVIEW reading
  // "Awaiting Quotes", and 118 other requests did the same, plus one wearing a
  // red "Expired" and 70 in D365_PUSHED reading "Received".
  //
  // The RFQ deadline was still ahead on all of them, so every one of those
  // readings was arithmetically correct and factually nonsense: nobody was
  // waiting on those vendors, the award had been made, and the money was with
  // Finance. The derivation only named the five sourcing sub-states, so the
  // live-RFQ branches below it were free to describe finished work.
  //
  // The boundary is the one the web already uses: `inSourcingStage` =
  // IN_PROCUREMENT_REVIEW, READY_FOR_D365. Everywhere past the CS exit the
  // quotation round is closed.
  const end = prService.indexOf('END AS sourcing_status');
  const caseBlock = prService.slice(end - 7000, end);
  // The stage list is the `ANY(ARRAY[ ... ])` IMMEDIATELY BEFORE the THEN, not
  // after it — slicing forward from the THEN finds the next `]` in the query and
  // silently reads the wrong text.
  const thenIdx = caseBlock.indexOf("THEN 'SOURCING_CLOSED'");
  assert.notEqual(thenIdx, -1, 'the precedence branch must still exist');
  const openIdx = caseBlock.lastIndexOf('ANY(ARRAY[', thenIdx);
  // The list's OWN closing bracket, which also sits BEFORE the THEN — the array
  // literal ends on the line above it. Searching forward from the THEN finds the
  // next branch's `]` instead, and reads text belonging to another rule.
  const closeIdx = caseBlock.indexOf(']', openIdx);
  assert.ok(openIdx !== -1 && closeIdx > openIdx && closeIdx < thenIdx,
    'the SOURCING_CLOSED branch must be an explicit stage list, not a bare condition');
  const list = caseBlock.slice(openIdx, closeIdx);
  for (const stage of [
    'IN_FINANCE_REVIEW', 'IN_MANAGEMENT_REVIEW', 'D365_PUSHED',
    'CLOSED', 'FULFILLED_FROM_STOCK', 'IN_COST_CENTER_APPROVAL',
  ]) {
    assert.ok(list.includes(`'${stage}'`),
      `${stage} is past the CS exit, so its quotation round is closed — it must be in the `
      + 'SOURCING_CLOSED precedence branch, or the live-RFQ branches below will describe '
      + 'a competition that ended months ago');
  }
  // IN_PROCUREMENT_REVIEW is the ONE stage where the round is still open, so it
  // is the one stage that must keep reporting live quotation progress. Everything
  // else either has not started (PRE_PROCUREMENT) or is done.
  assert.ok(!list.includes("'IN_PROCUREMENT_REVIEW'"),
    'IN_PROCUREMENT_REVIEW is the one stage where the quotation round is still open — it '
    + 'must keep reporting live progress, or the Awaiting Quotes tab empties of real work');

  // READY_FOR_D365 is a DELIBERATE cost, not an oversight: procurement may still
  // top up an RFQ there, but leaving it out put a red "Expired" pill on requests
  // one step from D365. Pinned so a later reader does not "fix" it either way
  // without knowing which way it was ruled.
  assert.ok(list.includes("'READY_FOR_D365'"),
    'READY_FOR_D365 stays in the concluded list: a request one step from D365 must not '
    + 'wear a live-RFQ pill. The reissue is visible on the RFQ panel, which is where it '
    + 'is actionable');
});

// ── the one door ────────────────────────────────────────────────────────────

test('S8 QUOTES_RECEIVED is an actionable stage for procurement', () => {
  assert.ok(
    /QUOTES_RECEIVED:\s*\['procurement',\s*'admin'\]/.test(detailPage),
    'the CS exit stage must grant the desk that has the work left to do — and admin '
    + 'alongside it, spelled out rather than left to the alias expansion',
  );
});

test('S8b and that stage must still OFFER the CS screen to the desk that can act', () => {
  // THE REGRESSION THIS EXISTS TO CATCH, and it was found by a user, not a test.
  //
  // The "Open CS" link was gated on `!canAct`, written when QUOTES_RECEIVED had
  // no STAGE_ACTIONS entry and canAct was therefore false for everyone there —
  // the gate and "this stage has no inline actions" were the same condition.
  // Granting procurement an entry (so the classification card has an owner)
  // flipped canAct, the link vanished, and `inSourcingStage` is false at
  // QUOTES_RECEIVED, so the bar rendered NOTHING: a buyer who had pressed
  // "Ready for CS" arrived at a stage they could not leave, with a card that
  // had not opened yet and no way to build the statement that would open it.
  //
  // The gate must therefore ask the question it always meant — does this stage
  // have inline actions of its own?
  assert.ok(/const hasInlineActions = Boolean\(/.test(detailPage),
    'the CS link must be gated on whether the bar already has controls, not on canAct');
  assert.ok(!/\{!canAct && \(\(\) => \{\s*const next = GOVERNANCE_NEXT_STEP/.test(detailPage),
    'the governance link must NOT be gated on !canAct — that is the dead end');
  assert.ok(/!hasInlineActions && \(\(\) => \{/.test(detailPage),
    'the governance link must render when the stage has no inline actions of its own');
  // …and QUOTES_RECEIVED must be one of those stages, which is why the gate has
  // to be about the stage rather than about the role.
  assert.ok(/QUOTES_RECEIVED:\s*\{\s*href:\s*'\/cs'/.test(detailPage),
    'the CS stage must still name its destination screen');
  assert.ok(
    /const inSourcingStage = \[[^\]]*\]\.includes\(pr\.status\)/.test(detailPage),
    'the sourcing trio must still be an explicit stage list, so that QUOTES_RECEIVED is '
    + 'visibly absent from it — the sourcing round is closed there',
  );
  assert.ok(
    !/inSourcingStage = \[[^\]]*QUOTES_RECEIVED[^\]]*\]/.test(detailPage),
    'inSourcingStage must not include QUOTES_RECEIVED: an RFQ may not be issued or topped '
    + 'up once the quotes have landed, and the bar must stay empty so the CS link can show',
  );
});

test('S9 the card carries ONE button, and it saves then advances', () => {
  assert.ok(/Save & Proceed to Finance Review/.test(detailPage),
    'the unified control must be on the card');
  // Order matters and is not expressible by counting: the save commits first,
  // so the advance cannot run against classifications that were never written.
  const save = detailPage.indexOf("api.patch(`/pr/${pr.id}/lines/classification`");
  const advance = detailPage.indexOf("api.post(`/pr/${pr.id}/advance`, { csReviewConfirmed: true })");
  assert.notEqual(save, -1, 'the unified path must save the classifications');
  assert.notEqual(advance, -1, 'the unified path must post the advance');
  assert.ok(save < advance, 'save must be sent BEFORE the advance, and by the same handler');
  assert.ok(/csReviewConfirmed:\s*true/.test(detailPage),
    "the advance must carry csReviewConfirmed — without it the planner returns kind 'none', "
    + 'which is a refusal and not a route to another door');
});

test('S10 the plain Save remains only while the exit is NOT unlocked', () => {
  // Not a removal: partial work still has to be savable while lines remain
  // unclassified. What is forbidden is BOTH controls being offered at once, which
  // would let the buyer stop one act short without being told.
  const proceed = detailPage.search(/clsCanProceed\s*\?/);
  const plain = detailPage.search(/'Save classification'/);
  assert.notEqual(proceed, -1, 'the button must be CHOSEN by eligibility');
  assert.notEqual(plain, -1, 'plain save must still exist for in-progress classification');
  assert.ok(proceed < plain,
    'the unified control must be the first branch, so the eligible case cannot reach the '
    + 'plain one');
});

test('S11 there is no separate Advance control on the page', () => {
  // One door. A second control that advances the same request from somewhere
  // else on the screen is the shape of thing this requirement rules out, and it
  // would be invisible in any per-component render test.
  const advanceCalls = detailPage.match(/advance\(/g) ?? [];
  const buttons = detailPage.match(/<button[^>]*>/g) ?? [];
  const advanceButtons = buttons.filter((b) => /advance/i.test(b));
  assert.deepEqual(advanceButtons, [],
    `no button may advance the request on its own; found ${advanceButtons.length}`);
  assert.ok(advanceCalls.length >= 3,
    'the existing HOD/line-decision advances are unrelated and must survive');
});

test('S12 the copy no longer asks for a review that is already confirmed', () => {
  // The stale sentence told procurement to "confirm the blind review" on a
  // request whose review was CONFIRMED — work that is finished, and attributed
  // to the one desk that is not allowed to do it.
  const cardCopy = detailPage.slice(
    detailPage.indexOf('clsWindowOpen &&'),
    detailPage.indexOf('pr-form-grid'),
  );
  assert.ok(cardCopy.length > 0, 'the card copy block must still be findable');
  assert.ok(!/clsExitStep === 'cs_review_quotes'\s*\?\s*'This request is at Quotes received\. Confirm the blind review/.test(cardCopy),
    'the confirmed branch must be asked FIRST, so a confirmed request never reads the '
    + 'unconfirmed sentence');
  assert.ok(/clsCsConfirmed/.test(cardCopy),
    'the copy must branch on whether the review has actually concluded');
});

test('S13 the crossing is the ENGINE\'s, not a status write', () => {
  // Belt and braces on the architectural rule: nothing on this screen may move a
  // request's stage by writing to it.
  assert.ok(!/status\s*:\s*['"]IN_FINANCE_REVIEW/.test(detailPage),
    'the page must never name a destination status as something it writes');
  assert.ok(!/\/pr\/\$\{pr\.id\}\/status/.test(detailPage),
    'no direct status endpoint may be called from the detail page');
});