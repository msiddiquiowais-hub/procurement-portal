// Hook-order guard — React pages must not call hooks after an early return.
//
//   npm run test:web
//
// Why this file exists
// --------------------
// Adding the HOD per-line decision summary to pages/pr/[id].tsx introduced a
// `useMemo` BELOW the component's early returns:
//
//     if (!ready)   return null;
//     if (!session) return null;
//     if (!pr && !err) return <Loading/>;
//     ...
//     const lineSum = useMemo(...)      // <-- reached only once `pr` has loaded
//
// The loading render calls 4 hooks; the loaded render calls 5. React throws
// "Rendered more hooks than during the previous render", the whole page unmounts,
// and the user gets Next.js's black "Application error: a client-side exception
// has occurred" screen — on /pr/:id AND on any page that navigates there after a
// POST (e.g. /pr/new's Submit, which router.push's to /pr/:id).
//
// Why a static check rather than a render test
// --------------------------------------------
// The failure only reproduces on the SECOND render with changed props, and only
// in the browser. `next build` and `tsc` both pass it — TypeScript cannot see
// that a hook sits below a `return`, and the SWC compile has no rules-of-hooks
// check. Rendering the page twice with react-dom/server would not reproduce it
// either, because the early-return path depends on the session/fetch timing that
// only the client hits. So the invariant is asserted on the source text.
//
// What it checks
// --------------
// For each page under apps/web/pages: within the component body, every hook call
// must appear before the first top-level early `return` at that nesting depth.
// A hook after a return is the exact shape of this bug.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

// This file is compiled to `.render-build/tests/` and run from there, so
// __dirname is NOT the source tree. Walk up to the directory that actually
// holds `pages/` — either apps/web (source) or apps/web/.render-build (compiled).
function resolveWebRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'pages');
    try {
      if (statSync(candidate).isDirectory()) {
        const src = join(candidate, 'pr', '[id].tsx');
        if (statSync(src).isFile()) return dir;   // real .tsx sources
      }
    } catch {
      /* keep walking up */
    }
    dir = dirname(dir);
  }
  throw new Error('could not locate apps/web with pages/pr/[id].tsx');
}

const WEB_ROOT = resolveWebRoot();
const PAGES_DIR = join(WEB_ROOT, 'pages');

/** Every .tsx under pages/, including the [id] / review / [token] segments. */
function pageFiles(dir: string = PAGES_DIR): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...pageFiles(full));
    } else if (entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/** Strip line comments so commented-out code cannot trip the check. */
function stripLineComments(src: string): string {
  return src
    .split('\n')
    .map(line => {
      // Leave URLs alone (https://… contains //), drop everything from a // that
      // starts a comment (preceded by start-of-line whitespace, or a quote/paren).
      const m = line.match(/^(\s*(?:\/\*|\/\/)|.*?[^:'"\\])\/\/.*$/);
      return m ? m[1] : line;
    })
    .join('\n');
}

const HOOK_RE = /\buse(State|Effect|Callback|Memo|Ref|Reducer|ImperativeHandle|LayoutEffect|Transition)\s*\(/;

/**
 * Remove `{/* … *\/}` JSX comments, including multi-line ones.
 *
 * stripLineComments above only handles `//`, but JSX comments are block comments
 * and this suite writes its rationale in them — so a comment that merely NAMES a
 * route (`… navigated away to /pr/review/[id]`) was read as a link to that
 * route. Commented-out code must never trip a check. Line count is preserved so
 * failure messages still quote real line numbers.
 */
function stripJsxBlockComments(src: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    let buf = '';
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end === -1) { i = line.length; } else { inBlock = false; i = end + 2; }
      } else {
        const start = line.indexOf('/*', i);
        if (start === -1) { buf += line.slice(i); i = line.length; }
        else { buf += line.slice(i, start); inBlock = true; i = start + 2; }
      }
    }
    out.push(buf);
  }
  return out.join('\n');
}

/** Both comment forms stripped — the source a link check should read. */
function readPageSource(file: string): string {
  return stripJsxBlockComments(stripLineComments(readFileSync(file, 'utf8')));
}

/**
 * Bracket depth at the START of each line.
 *
 * Needed because "is this gate an ancestor of this link" cannot be answered by
 * scanning upwards for `{cond && (`: the previous SIBLING block's gate matches
 * just as well. That is not a hypothetical — the action bar renders an HOD block
 * (`{canHoldAct && (`) immediately above a `{canAct && … && (` block, so a
 * naive scan lets canHoldAct vouch for a link that sits outside it, and the
 * real bug passes. Counting `{}()[]` per line gives the nesting that JSX
 * indentation only approximates. Strings and comments are skipped; `${…}`
 * inside a template literal is treated as string content, which leaves the
 * count balanced.
 */
function bracketDepths(lines: string[]): number[] {
  const depths: number[] = [];
  let d = 0;
  for (const line of lines) {
    depths.push(d);
    let i = 0;
    while (i < line.length) {
      const c = line[i];
      if (c === '/' && line[i + 1] === '/') break;
      if (c === '/' && line[i + 1] === '*') {
        const end = line.indexOf('*/', i + 2);
        i = end === -1 ? line.length : end + 2;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        const q = c;
        i++;
        while (i < line.length) {
          if (line[i] === '\\') { i += 2; continue; }
          if (line[i] === q) { i++; break; }
          i++;
        }
        continue;
      }
      if (c === '{' || c === '(' || c === '[') d++;
      else if (c === '}' || c === ')' || c === ']') d--;
      i++;
    }
  }
  return depths;
}

/** Gates of every `{cond && (` that ENCLOSES line `i` (ancestors, not siblings). */
function enclosingGates(lines: string[], depths: number[], i: number): string[] {
  const gates: string[] = [];
  let shallowest = depths[i];
  for (let j = i - 1; j >= 0; j--) {
    if (depths[j] < shallowest) {
      shallowest = depths[j];
      const m = lines[j].match(/^\s*\{\s*(.+?)\s*&&\s*\(/);
      if (m) gates.push(m[1]);
      if (shallowest <= 0) break;
    }
  }
  return gates;
}

/**
 * Only statements directly in the exported component's body count — i.e. at the
 * component's own indentation (2 spaces) inside its body, NOT:
 *   - module-level helpers above the component (their `return` is 2-space too,
 *     which is why the body start has to be located first), or
 *   - returns/hooks nested inside callbacks (4+ spaces).
 *
 * So both matchers are anchored to the component body found by `componentBodyRange`.
 */
interface Range { start: number; end: number; }

/** Locate the exported default function component and its closing brace. */
function componentBodyRange(lines: string[]): Range | null {
  const startIdx = lines.findIndex(l =>
    /export\s+default\s+function\s+\w+/.test(l));
  if (startIdx === -1) return null;

  // The body opens on the first line after the signature that ends with '{'.
  let depth = 0;
  let bodyStart = startIdx;
  for (let i = startIdx; i < lines.length; i++) {
    depth += (lines[i].match(/\{/g) || []).length;
    depth -= (lines[i].match(/\}/g) || []).length;
    if (depth > 0 && lines[i].includes('{')) { bodyStart = i; break; }
  }

  // Walk forward to the line where the component's own brace closes.
  depth = 0;
  for (let i = bodyStart; i < lines.length; i++) {
    depth += (lines[i].match(/\{/g) || []).length;
    depth -= (lines[i].match(/\}/g) || []).length;
    if (depth === 0) return { start: bodyStart, end: i };
  }
  return { start: bodyStart, end: lines.length - 1 };
}

/**
 * A `return` at the component body's own indentation that ends the component.
 *
 * Two shapes matter, and BOTH occur in these pages:
 *   - `if (!ready) return null;`   (return inline in the `if`)
 *   - a bare `return (` that opens the final JSX
 *
 * A `return` nested deeper (inside an `if` block, a callback, a helper) is not
 * an early return of the component and must not count. `if (!x) return <JSX/>`
 * written as two lines returns from inside a block — the component body still
 * continues below it — so only a `return` at the body's own indentation, or the
 * single-line `if (…) return …` form, ends the component.
 */
const EARLY_RETURN_RE = /^ {2}return\b|^ {2}if\s*\([^)]*\)\s+return\b/;

/**
 * A hook assigned to a component-level binding, or called bare at body level.
 *
 * The binding must allow ARRAY DESTRUCTURING. `[\w.]+` alone cannot match
 * `const [open, setOpen] = useState(false)`, and that is the form React's own
 * docs lead with — so the matcher went blind to the most common way a hook is
 * ever declared. It passed a page whose five Issue-RFQ `useState` calls sit below
 * `if (!pr) return null;`, which is the black-screen crash this file exists to
 * prevent: the guard that was supposed to stop it had the same blind spot.
 */
const BODY_HOOK_RE =
  /^ {2}(?:(?:const|let|var)\s+(?:\[[^\]]*\]|[\w.]+)\s*=\s*)?use[A-Z]\w*\s*\(/;

test('no page calls a React hook after an early return', () => {
  const offenders: string[] = [];
  const pages = pageFiles();

  for (const file of pages) {
    const src = stripLineComments(readFileSync(file, 'utf8'));
    const lines = src.split('\n');

    const range = componentBodyRange(lines);
    if (!range) continue;                       // no exported component: nothing to check

    let firstReturn = -1;
    let lastHook = -1;

    for (let i = range.start; i <= range.end; i++) {
      const line = lines[i];
      if (BODY_HOOK_RE.test(line)) lastHook = i;
      if (EARLY_RETURN_RE.test(line) && firstReturn === -1) firstReturn = i;
    }

    if (lastHook > firstReturn && firstReturn !== -1) {
      offenders.push(
        `${relative(WEB_ROOT, file)}: hook on line ${lastHook + 1} ` +
        `comes AFTER an early return on line ${firstReturn + 1}`,
      );
    }
  }

  assert.equal(
    offenders.length, 0,
    'React hook called after an early return — this crashes the page with ' +
    '"Rendered more hooks than during the previous render":\n  ' +
    offenders.join('\n  '),
  );
});

test('pages/pr/[id].tsx keeps its line-decision summary above the early returns', () => {
  // The specific regression, pinned so a refactor that reintroduces it fails
  // here with a clear message instead of as a black screen in the browser.
  const file = join(PAGES_DIR, 'pr', '[id].tsx');
  const src = stripLineComments(readFileSync(file, 'utf8'));
  const lines = src.split('\n');

  const range = componentBodyRange(lines);
  assert.ok(range, 'could not locate the component body in pages/pr/[id].tsx');

  const memoIdx = lines.findIndex((l, i) =>
    i >= range.start && i <= range.end && /const\s+lineSum\s*=\s*useMemo/.test(l));
  assert.notEqual(memoIdx, -1, 'lineSum useMemo not found in the component body of pages/pr/[id].tsx');

  const firstReturn = lines.findIndex((l, i) =>
    i >= range.start && i <= range.end && EARLY_RETURN_RE.test(l));
  assert.notEqual(firstReturn, -1, 'no early return found — did the page change shape?');

  assert.ok(
    memoIdx < firstReturn,
    `lineSum useMemo (line ${memoIdx + 1}) must sit above the first early return ` +
    `(line ${firstReturn + 1}); otherwise the loading render calls one hook count ` +
    'and the loaded render another, which unmounts the page.',
  );
});

test('pages/pr/review/[id].tsx guards every pr.* dereference behind pr &&', () => {
  // The second black-screen bug, same symptom, different cause: this page
  // renders `pr.pr_number`, `pr.children` and `pr.departments` while `pr` is
  // still null during the loading paint. TypeScript does not catch it (the state
  // is `Pr | null`, and JSX widens it), and `next build` has no such check, so
  // the page unmounted with "Application error: a client-side exception".
  //
  // The fix is ONE `{pr && ( … )}` around the whole data-dependent region.
  // This asserts that guard exists and wraps the first `pr.` dereference.
  const file = join(PAGES_DIR, 'pr', 'review', '[id].tsx');
  const src = stripLineComments(readFileSync(file, 'utf8'));
  const lines = src.split('\n');

  const guardIdx = lines.findIndex(l => /\{\s*pr\s*&&\s*\(\s*$/.test(l.trim()));
  assert.notEqual(
    guardIdx, -1,
    'pages/pr/review/[id].tsx has no `{pr && (` guard — the loading render will ' +
    'dereference null and crash the page.',
  );

  // Every bare `pr.<field>` after the guard must come after it.
  const firstDeref = lines.findIndex(
    (l, i) => i > guardIdx && /(?<!\?)\bpr\.[a-z_]/.test(l) && !/pr\?\./.test(l),
  );
  assert.ok(
    firstDeref > guardIdx,
    'a `pr.<field>` dereference appears before the `{pr && (` guard',
  );

  // And the region must be closed again, or the JSX will not compile.
  assert.ok(
    lines.slice(guardIdx).some(l => /^\s*<>\s*$/.test(l)),
    'the `{pr && (` guard is not followed by a fragment open — unbalanced JSX',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Dead-link guard — a link must never point at a screen its role is denied.
// ─────────────────────────────────────────────────────────────────────────────
//
// The symptom: signed in as procurement (Hina Tariq) on a PR at
// IN_PROCUREMENT_REVIEW, "Review & act" navigated to /pr/review/<id> and the
// browser landed back on /pr — which reads as "the page refreshed".
//
// Cause, in order:
//   1. pages/pr/[id].tsx renders that link off `canAct`, which answers "does this
//      role OWN this stage" (STAGE_ACTIONS: IN_PROCUREMENT_REVIEW -> procurement).
//   2. pages/pr/review/[id].tsx guards itself with canSeeScreen(role,'pr-review')
//      and calls router.replace('/pr') when denied.
//   3. SCREENS['pr-review'].roles is 'hod' — faithful to the prototype's nav item
//      (PROCUREMENT_PORTAL_PROTOTYPE.html:624, data-roles="hod").
// So `canAct` and "may open the review screen" are different questions, and the
// link was gated on the wrong one. The same mistake existed on dashboard.tsx
// (gated on 'approvals' = hod,mc,cfo,cs) and approvals.tsx (ungated), so mc, cfo
// and cs hit the identical bounce.
//
// Why a static check
// ------------------
// The bug is a MISMATCH between two independently-correct guards, and the role
// only exists at runtime in the browser. Neither tsc nor next build compares a
// link's target screen against the role allowed to open it. What is checkable
// statically is the pairing: a `/pr/review/` navigation must sit behind a gate
// that resolves to a role the screen admits.

test('SCREENS pins pr-review to hod, as the prototype nav does', () => {
  // Read as source text, not imported: this suite is compiled to .render-build
  // and run by plain node, so importing the workspace package is not reliable.
  const src = readFileSync(
    join(WEB_ROOT, '..', '..', 'packages', 'roles', 'src', 'index.ts'), 'utf8');
  const entry = src.match(/\{\s*id:\s*'pr-review'[^\n]*/);
  assert.ok(entry, "SCREENS has no 'pr-review' entry");

  // If this ever widens, every gate below starts hiding a legitimately
  // reachable screen from roles that can act — and the assertions here become
  // vacuous. Prototype line 624 is the authority: data-roles="hod".
  assert.match(
    entry![0], /roles:\s*'hod'/,
    "SCREENS['pr-review'] must stay roles:'hod' (prototype:624 data-roles=\"hod\"). " +
    'Widening it is a port deviation and invalidates the dead-link gates.',
  );
});

test('no page navigates to /pr/review/ without a pr-review role gate', () => {
  const offenders: string[] = [];
  for (const file of pageFiles()) {
    const src = readPageSource(file);
    if (!src.includes('/pr/review/')) continue;
    // A file may only link to the review screen if it checks that screen's own
    // gate. `canSeeScreen(role,'approvals')` is NOT that check.
    const gated = /canSeeScreen\([^)]*'pr-review'/.test(src)
      || /canSeeReview\s*=\s*canSeeScreen\(/.test(src);
    if (!gated) offenders.push(relative(WEB_ROOT, file));
  }
  assert.deepEqual(
    offenders, [],
    'these pages link to /pr/review/<id> without gating on canSeeScreen(role,' +
    "'pr-review'); the target page redirects any other role to /pr, so the click " +
    'looks like a page refresh: ' + offenders.join(', '),
  );
});

test('pages/pr/[id].tsx gates every pr-review link on a HOD-only gate', () => {
  const file = join(PAGES_DIR, 'pr', '[id].tsx');
  const src = readPageSource(file);
  const lines = src.split('\n');

  // canSeeReview must be the TARGET's gate, not the stage-ownership gate.
  assert.match(
    src, /const\s+canSeeReview\s*=\s*canSeeScreen\(\s*role\s*,\s*'pr-review'\s*\)/,
    "pages/pr/[id].tsx must derive canSeeReview from canSeeScreen(role,'pr-review')",
  );

  // The two gates this file legitimately uses to reach the review screen:
  //   canSeeReview -> pr-review's own guard
  //   canHoldAct   -> canAct && (isHodStage || onHold)
  // The second is only HOD-safe while STAGE_ACTIONS keeps those stages hod-only,
  // so that is asserted too — otherwise widening the stage map silently makes
  // canHoldAct admit a role that pr-review bounces.
  const stageMap = src.match(/const\s+STAGE_ACTIONS[\s\S]*?\n\};/);
  assert.ok(stageMap, 'STAGE_ACTIONS not found in pages/pr/[id].tsx');
  for (const stage of ['IN_HOD_REVIEW', 'ON_HOLD']) {
    const re = new RegExp(stage + ":\\s*\\[([^\\]]*)\\]");
    const m = stageMap![0].match(re);
    assert.ok(m, `STAGE_ACTIONS has no ${stage} entry`);
    assert.equal(
      m![1].replace(/['"\s]/g, ''), 'hod',
      `STAGE_ACTIONS['${stage}'] must stay ['hod'] — the HOD action bar on this ` +
      'page links to /pr/review/<id>, which admits the HOD only.',
    );
  }

  // Every `/pr/review/` link must sit under one of those gates. A JSX
  // conditional only renders when EVERY enclosing `cond && (` holds, so it is
  // enough that ONE true ancestor is HOD-only — and the link is often two levels
  // deep (`{canHoldAct && (<>{!onHold && <> … <Link/>`), where the nearest gate
  // is the inner `!onHold` and says nothing about the role.
  const ACCEPTED = /\b(canSeeReview|canHoldAct)\b/;
  const depths = bracketDepths(lines);
  const bad: Array<{ line: number; gates: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/\/pr\/review\//.test(lines[i])) continue;
    const gates = enclosingGates(lines, depths, i);
    if (!gates.some(g => ACCEPTED.test(g))) {
      bad.push({ line: i + 1, gates: gates.join(' | ') || '(none)' });
    }
  }
  assert.deepEqual(
    bad, [],
    'these /pr/review/ links have no canSeeReview/canHoldAct guard among their ' +
    'enclosing JSX conditionals, so a role the review screen denies will click ' +
    'through and get redirected to /pr:\n' +
    bad.map(b => `  line ${b.line}: guarded only by [${b.gates}]`).join('\n'),
  );
});
