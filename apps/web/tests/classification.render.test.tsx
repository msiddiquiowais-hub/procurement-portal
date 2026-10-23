// The per-line Capex/Opex control: one dropdown, five classes, and the D365
// outcome printed beside each one.
//
//   npm run test:web
//
// WHY THIS FILE EXISTS
// --------------------
// The control replaced five toggle chips that were rendered all at once inside a
// 340px column. Five labels did not fit, so they wrapped onto three rows and made
// every line taller than the item description beside it.
//
// Two things had to survive that change, and neither is visible in a screenshot:
//
//   1. THE VOCABULARY. The five values are pinned by the database
//      (`pr_lines_classification_check`, migration 022) and are what the D365
//      payload builder emits. They keep their machine-value prefixes, because the
//      award trigger splits the header with `LIKE 'CAPEX%'` / `LIKE 'OPEX%'`
//      (migration 069) — a label like "Capex Tangible" would match neither bucket
//      and land in PKR 0 of BOTH the capital and the operating totals. Nothing in
//      this change may rename a value.
//
//   2. THE USEFUL-LIFE DEFAULTING. The input column is gone, but a capital line
//      must still be sent a depreciation period or the API rejects it
//      (`pr.service.ts` — "a capital line needs a useful life"), and an operating
//      line must NOT carry one. So the pick still seeds 4 years for a capital
//      line and clears it for an operating one. A tidier table is not worth a
//      payload D365 cannot post.
//
// WHY THE OUTCOME IS ASSERTED
// ---------------------------
// Each row prints where the class posts the line, and that string is the honest
// version of a duplication the vocabulary has always had. `CAPEX_ASSET` and
// `CAPEX_INFRA` emit an IDENTICAL payload for the same line, as do the three OPEX
// values (`apps/api/src/d365/d365.payload.ts` — ProcurementCategory is just
// `isCapex ? 'CAPEX' : 'OPEX'`). The control now shows that rather than hiding
// it. These tests pin the duplication as a FACT: if a later change ever makes one
// of those pairs differ, it is a change to the D365 contract and this file should
// fail and say so.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import ClassificationCombobox, {
  outcome,
  CLASSIFICATION_CHOICES,
} from '../components/ClassificationCombobox';
import { CLASSIFICATIONS, isCapex } from '@procurement/d365-client';

// This file is compiled to `.render-build/tests/` and run from there, so
// __dirname is NOT the source tree. Walk up to whichever directory actually
// holds `pages/` — apps/web (source) or apps/web/.render-build (compiled).
// Same approach as pr.costMoney.render.test.tsx.
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

/**
 * Comments are stripped before any source assertion.
 *
 * These tests assert on the absence of a code pattern, so a COMMENT quoting the
 * old pattern would break the absence check — and the test would be measuring the
 * prose rather than the render.
 */
function readSource(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/.*$/gm, '$1');
}

const webRoot = resolveWebRoot();
const detailPage = readSource(join(webRoot, 'pages', 'pr', '[id].tsx'));
const createPage = readSource(join(webRoot, 'pages', 'pr', 'create.tsx'));

// ── the rendered control ───────────────────────────────────────────────────

function render(value: string): string {
  return renderToStaticMarkup(
    h(ClassificationCombobox, { value, onChange: () => { /* not clicked in SSR */ } }),
  );
}

test('C1 an unclassified line shows the placeholder, not an empty control', () => {
  const html = render('');
  assert.ok(html.includes('— Select Classification —'),
    'the trigger must name what is missing');
});

test('C2 the trigger is a listbox control, so a keyboard can open it', () => {
  const html = render('');
  assert.ok(html.includes('aria-haspopup="listbox"'), html);
  assert.ok(html.includes('data-trigger'), 'the trigger is focusable by the panel');
});

test('C3 a chosen class prints ITS label on the trigger', () => {
  const html = render('CAPEX_INFRA');
  assert.ok(html.includes('Capex — Infra'), html);
  assert.ok(!html.includes('— Select Classification —'),
    'a chosen line must not still claim to be unclassified');
});

test('C4 every one of the five classes renders as a selection', () => {
  for (const c of CLASSIFICATIONS) {
    const html = render(c.value);
    assert.ok(html.includes(c.label), `${c.value} must render its own label`);
  }
});

test('C5 the control offers the SHARED vocabulary, in the shared order', () => {
  // Imported, never retyped. A second list in the component is a list that can
  // drift from the D365 contract the database actually enforces.
  assert.deepEqual(
    CLASSIFICATION_CHOICES.map((c) => c.value),
    CLASSIFICATIONS.map((c) => c.value),
    'the control must offer exactly the D365 contract values, in order',
  );
  assert.equal(CLASSIFICATION_CHOICES.length, 5);
});

// ── the duplication, stated rather than hidden ─────────────────────────────

test('C6 both capex classes post the line to the Fixed Asset Register', () => {
  const asset = outcome(CLASSIFICATION_CHOICES.find((c) => c.value === 'CAPEX_ASSET')!);
  const infra = outcome(CLASSIFICATION_CHOICES.find((c) => c.value === 'CAPEX_INFRA')!);
  assert.equal(asset, 'Fixed Asset Register');
  // The fact this file exists to record. These two emit an identical payload, so
  // the control showing the SAME outcome for both is truthful, not a bug. If a
  // future migration makes them differ, this assertion is the one to update —
  // deliberately, with the contract change behind it.
  assert.equal(infra, asset,
    'CAPEX_INFRA and CAPEX_ASSET still post identically; do not drift this silently');
});

test('C7 all three opex classes post the line to the same GL range', () => {
  const out = ['OPEX_CONSUMABLE', 'OPEX_SERVICE', 'OPEX_MAINT']
    .map((v) => outcome(CLASSIFICATION_CHOICES.find((c) => c.value === v)!));
  assert.equal(out[0], 'Expensed · GL 6xxx');
  assert.deepEqual(new Set(out).size, 1,
    'the three opex classes post identically; do not drift this silently');
});

test('C8 every value keeps a machine prefix the SQL bucketing can read', () => {
  // The award trigger splits the header with LIKE 'CAPEX%' / LIKE 'OPEX%'
  // (migration 069). A label without that prefix would fall out of BOTH totals
  // and pass the NULL-only gate, which is the silent-PKR-0 failure.
  for (const c of CLASSIFICATION_CHOICES) {
    assert.ok(
      c.value.startsWith('CAPEX') || c.value.startsWith('OPEX'),
      `${c.value} must keep a CAPEX/OPEX prefix the trigger's LIKE can match`,
    );
  }
  // And that prefix must agree with the `capex` flag the payload builder reads.
  for (const c of CLASSIFICATION_CHOICES) {
    assert.equal(c.capex, isCapex(c.value),
      `${c.value}: the capex flag and the SQL prefix must not disagree`);
  }
});

// ── both screens use it ────────────────────────────────────────────────────

test('C9 the CS-exit card uses the dropdown', () => {
  assert.ok(detailPage.includes('<ClassificationCombobox'), detailPage.slice(0, 400));
});

test('C10 the PR create line card uses the same dropdown', () => {
  assert.ok(createPage.includes('<ClassificationCombobox'), createPage.slice(0, 400));
});

test('C11 neither screen still renders the five-chip wall', () => {
  // `CLASSIFICATIONS.map(` over a `.chips` div was the old control. Its absence
  // is the whole point of the change, so it is asserted on both screens.
  for (const [name, src] of [['pr/[id].tsx', detailPage], ['pr/create.tsx', createPage]] as const) {
    assert.ok(!/CLASSIFICATIONS\.map\(/.test(src),
      `${name} must not still map the vocabulary into chips`);
  }
});

test('C12 the CS-exit card keeps the useful-life defaulting it always had', () => {
  // The column is gone; the RULE is not. A capital line is sent a period (the API
  // rejects a capital line without one) and an operating line is sent none.
  assert.ok(/usefulLifeYears:\s*next\.startsWith\('CAPEX'\)/.test(detailPage),
    'the pick must still branch on CAPEX for the useful life');
  assert.ok(/v\.usefulLifeYears\s*\|\|\s*'4'/.test(detailPage),
    'a capital line must still default to a 4-year life');
  // The ELSE branch is the assertion that matters: an operating line must be sent
  // NO depreciation period, or D365 is told to depreciate a consumable. Anchored
  // on the ternary's closing paren so it cannot be satisfied by an unrelated ''.
  assert.ok(
    /usefulLifeYears:\s*next\.startsWith\('CAPEX'\)\s*\?\s*\([^)]*\)\s*:\s*''/.test(detailPage),
    'the else branch of the useful-life ternary must still clear it',
  );
  // The old editable input must be gone — that was the column we removed.
  assert.ok(!/<th[^>]*>Useful life<\/th>/i.test(detailPage),
    'the Useful life column header must be gone');
});

// ── the create screen's side effect is preserved ────────────────────────────

test('C13 choosing a class still seeds an empty GL account from that class', () => {
  // The old chip click did `glAccount: l.glAccount || c.gl.split(' ')[0]`. The
  // dropdown must seed the SAME account, and — the part that is easy to lose in a
  // rewrite — must NOT overwrite a GL the buyer already typed.
  assert.ok(/glAccount:\s*l\.glAccount\s*\|\|/.test(createPage),
    'the GL account must still be seeded only when it is empty');
  assert.ok(/c\.gl\.split\(' '\)\[0\]/.test(createPage),
    "the seed must come from the class's own GL contract");
});

test('C14 the panel offers a real clear, so a class can be taken off a line', () => {
  // The panel only exists after a click, so it cannot be asserted through
  // renderToStaticMarkup — this reads the component source instead. The old chips
  // toggled the chosen one off. If the clear is lost, a line classified by
  // mistake can never be un-classified from the UI, and the CS gate then holds a
  // request nobody is able to release.
  const src = readSource(join(webRoot, 'components', 'ClassificationCombobox.tsx'));
  assert.ok(/onClick=\{\(\)\s*=>\s*choose\(''\)\}/.test(src),
    "the clear control must hand back an empty class, not merely re-open the panel");
});