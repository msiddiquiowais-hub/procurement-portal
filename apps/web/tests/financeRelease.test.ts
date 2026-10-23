// The FINANCE REVIEW stage: the release that waits there, and the card that is
// READ-ONLY while it waits.
//
//   npm run test:web
//
// WHY THIS FILE EXISTS
// --------------------
// A request that had reached IN_FINANCE_REVIEW had NOTHING to press.
//
// `canAct` was true for the finance desk and every branch inside the action
// bar's `canAct` block was false — the revert is procurement's, the sourcing
// trio is procurement's, the review link is a HOD screen — so the bar rendered
// empty. And underneath it, the Capex/Opex card offered Finance an ACTIVE
// "Save classification" button, so the one control the stage did show was a
// control nobody should have had there.
//
// The bar is the visible half. The rules that make it correct live in the API
// (the engine's steps, the correction window, the advance's authority), so
// these assertions cross the app boundary the way classificationWindow.test.ts
// does on the other side: the property worth pinning is that the two agree.
//
// THESE ASSERTIONS READ SOURCE, for the same reason cs-progress.test.ts does:
// the SQL lives in the API service and the labels in a page component, and
// "the page offers the control the API will honour" is only expressible
// across files. Comments are stripped first, so prose quoting a retired label
// cannot satisfy an absence check.

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
const detailPage = readSource(join(webRoot, 'pages', 'pr', '[id].tsx'));
const costStages = readSource(join(apiRoot, 'src', 'pr', 'cost.stages.ts'));
const prService = readSource(join(apiRoot, 'src', 'pr', 'pr.service.ts'));

/** The STAGE_ACTIONS table, and nothing else on the page. */
function stageActionsBlock(): string {
  const start = detailPage.indexOf('const STAGE_ACTIONS');
  assert.notEqual(start, -1, 'the PR detail page must carry a STAGE_ACTIONS table');
  return detailPage.slice(start, detailPage.indexOf('};', start));
}

/** The action bar's `canAct` block, and nothing else. */
function actionBarBlock(): string {
  const start = detailPage.indexOf('canAct && !isHodStage && !onHold && (');
  assert.notEqual(start, -1, 'the action bar must gate on canAct');
  return detailPage.slice(start, start + 6000);
}

/** The whole `hasInlineActions` expression. */
function hasInlineActionsExpr(): string {
  const start = detailPage.indexOf('const hasInlineActions');
  assert.notEqual(start, -1, 'the page must derive hasInlineActions');
  const end = detailPage.indexOf(');', start);
  return detailPage.slice(start, end + 2);
}

// ── who may act the stage ──────────────────────────────────────────────────

test('W1 the finance stage names every desk that may release it', () => {
  // `finance` is the desk that owns the release and `cfo` the second actor on
  // the ladder's two gates. `admin` and `hod` are there because the ruling is
  // that the release is not the exclusive right of the `finance` desk.
  //
  // `admin` and `cfo` would pass through ROLE_ALIASES and the ladder's
  // actorRole anyway; `hod` does not, because `hod` is the role all five
  // department heads carry and it is aliased to nothing.
  const block = stageActionsBlock();
  const m = block.match(/IN_FINANCE_REVIEW:\s*\[([^\]]*)\]/);
  assert.ok(m, 'the finance stage must name its actors');
  for (const role of ['finance', 'cfo', 'admin', 'hod']) {
    assert.ok(
      m[1].includes(`'${role}'`),
      `${role} must be an actor at the finance stage — the release is not the `
      + `exclusive right of the finance desk`,
    );
  }
});

// ── the button ─────────────────────────────────────────────────────────────

test('W2 the action bar offers the release, and it is the ONLY thing it offers there', () => {
  const bar = actionBarBlock();
  assert.ok(/Approve & Proceed/.test(bar),
    'the finance stage must offer the release');
  assert.ok(/releaseFromFinance/.test(bar),
    'the button must be wired to the release handler');
  // It goes through the ENGINE, on the one advance endpoint every step uses.
  assert.ok(/api\.post\(`\/pr\/\$\{pr\.id\}\/advance`/.test(detailPage),
    'the release must go through the workflow advance endpoint');
});

test('W3 the release posts NO decision flag — the engine picks the gate', () => {
  // The two gates out of the finance stage are mutually exclusive and the
  // engine chooses between them from the request's own amount. A flag posted
  // from the browser would be a CLAIM, and the only claim that belongs at this
  // stage is the one the engine can read for itself.
  //
  // `csReviewConfirmed` in particular is the CS exit's flag: it is honoured
  // only for procurement and HOD Procurement, so posting it here would be
  // asking for a step this stage does not have.
  const start = detailPage.indexOf('const releaseFromFinance');
  assert.notEqual(start, -1, 'the release handler must exist');
  const body = detailPage.slice(start, detailPage.indexOf('\n  };', start));
  assert.ok(/advance`,\s*\{\s*\}\s*\)/.test(body),
    'the release must post an empty decision — the engine selects the gate');
  assert.ok(!/csReviewConfirmed/.test(body),
    'the release must not post the CS exit\'s flag');
  assert.ok(!/readyForCs/.test(body),
    'the release must not post a sourcing flag');
});

test('W4 the release is offered at the finance stage and NOWHERE else', () => {
  // The button is gated on `financeStage`, so a request at any other stage
  // cannot show it. A release control that appeared at a stage with no release
  // step would post an advance the engine would refuse.
  const bar = actionBarBlock();
  assert.ok(/financeStage\s*&&\s*\(/.test(bar),
    'the release must be gated on the finance stage');
  assert.ok(/const financeStage = pr\.status === 'IN_FINANCE_REVIEW'/.test(detailPage),
    'financeStage must be the finance review stage and nothing else');
});

test('W5 the button says what it will do, and the outcome names where it went', () => {
  // One label, and the consequence spelled out. The two gates lead to
  // different places, so a bare "Proceed" would be a label that can be wrong.
  const bar = actionBarBlock();
  assert.ok(/Approve & Proceed/.test(bar), 'the button carries the agreed label');
  assert.ok(/needsMgt/.test(bar),
    'the button must say which of the two gates it will take');
  assert.ok(/Ready for D365/.test(bar) && /Management review/.test(bar),
    'the button must name BOTH destinations, in the words the screen uses');

  // And the outcome message names the stage the ENGINE actually reached, by
  // its own key. The button's line is derived from the live threshold; the
  // message is derived from the engine's decision. They are two different
  // facts and the message is the authoritative one.
  const start = detailPage.indexOf('const releaseFromFinance');
  assert.notEqual(start, -1, 'the release handler must exist');
  const body = detailPage.slice(start, detailPage.indexOf('\n  };', start));
  assert.ok(/READY_FOR_D365/.test(body) && /IN_MANAGEMENT_REVIEW/.test(body),
    'the outcome must name the stage the engine actually moved the request to');
  assert.ok(/matchedStep/.test(body),
    'the outcome must name the step the engine matched');
});

// ── the bar must not double up ─────────────────────────────────────────────

test('W6 the bar knows the finance stage has inline actions of its own', () => {
  // `hasInlineActions` answers "is the bar already occupied", and it gates the
  // "Open CS"-style link. It omitted the finance stage, which is the second
  // half of the same defect: the bar did not merely lack a button, it lacked
  // the KNOWLEDGE that the stage had one.
  const expr = hasInlineActionsExpr();
  assert.ok(/financeStage/.test(expr),
    'hasInlineActions must count the finance release, or the stage has two doors');
  assert.ok(/canAct/.test(expr) && /!onHold/.test(expr),
    'the occupied-bar test is still a question about the VIEWER');
});

// ── the card is read-only there ────────────────────────────────────────────

test('W7 the card takes its authority from the API, and the API closes the window there', () => {
  // The page renders whatever authority the API hands it — it keeps no copy of
  // the gate. So the read-only behaviour is the API's rule, and the rule has
  // to be there, not on the page.
  assert.ok(/const clsCanWrite = pr\.classification\?\.can_write/.test(detailPage),
    'the page must read the card\'s write authority from the API');
  assert.ok(/mayCorrectClassification/.test(prService),
    'the API must derive the correction window from the shared rule');
  assert.ok(/mayCorrectClassification\(ctx\.role, status\)/.test(prService),
    'the card\'s authority must be the shared rule, not a second copy of it');

  // And the shared rule closes the window at the finance stage.
  assert.ok(/stage !== COST_APPROVAL_STAGE/.test(costStages),
    'the correction window must be closed at the cost approval stage');
  assert.ok(/const COST_APPROVAL_STAGE = 'IN_FINANCE_REVIEW'/.test(costStages),
    'the cost approval stage is the finance stage — the closure is on the stage the ruling names');
});

test('W8 the PATCH endpoint stays WIDER than the card — deliberately', () => {
  // An earlier ruling that still stands: the guard on the write endpoint is
  // wider than the card. Unifying them would be tightening a control gate,
  // which is a separate decision and was not the one taken.
  //
  // So the card is read-only at the finance stage AND the endpoint still
  // accepts a correction there. That is a fact about the system, and it is
  // pinned so nobody "fixes" it by accident.
  const start = prService.indexOf('const mayCorrect = roleAllowed(role, CORRECT_ROLES)');
  assert.notEqual(start, -1, 'the PATCH guard must keep its own rule');
  assert.ok(
    !/mayCorrectClassification/.test(prService.slice(start, start + 200)),
    'the PATCH guard must NOT be narrowed to the card\'s rule',
  );
});
