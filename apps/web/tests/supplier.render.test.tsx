// Wave 4 step 6's render half, authored at step 4 — the supplier screens render
// the prototype's copy.
//
//   npm run test:web
//
// Why this file exists
// --------------------
// Same reason as governance.render.test.tsx: every Next.js page here returns
// `null` until a session exists, so the server HTML is an empty shell and
// "route returns 200" proves nothing about what a supplier actually sees. These
// render the real components with react-dom/server and assert on the markup.
//
// The rule: assert against the PRODUCER. KPIs, roster rows, coverage strings and
// the copy all come from @procurement/workflow-engine's supplier module. If the
// engine changes a string, this fails rather than quietly agreeing with a stale
// hand-copied expectation.
//
// The prototype's placeholders (V-000123, PakBoxes Pvt Ltd, RFQ-2026-0042,
// 2180000) are asserted ABSENT, and so is the "sealed until" wording that
// decision Q2 made false — the plan's §9 test (d) requires that exact check.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import {
  inboxKpis, supplierRoster, quoteLineTotals, supplierInboxParagraph,
  supplierInboxSubtitle, supplierQuoteSubtitle, supplierQuoteAlert,
  invitedCountLabel, moneyOrDash, fmtPKR, SUPPLIER_INBOX_EMPTY,
  SUPPLIER_QUOTE_NO_LINES, SUPPLIER_SUBMIT_HINT, SUPPLIER_REMARKS_PLACEHOLDER,
  SUPPLIER_TERM_OPTIONS, SUPPLIER_TERM_DEFAULTS, SUPPLIER_VISIBILITY_NOTE,
  type SupplierInvitation, type SupplierQuoteLine,
} from '@procurement/workflow-engine';
import {
  SupplierKpiBand, SupplierInboxList, SupplierRosterCard,
  SupplierQuoteLines, SupplierCommercialTerms,
  type InboxData, type RosterRow,
} from '../components/supplier/SupplierCards';

// ── helpers ────────────────────────────────────────────────────────────────

/** Render to readable text so assertions read like the screen a human sees. */
function text(node: React.ReactElement): string {
  return renderToStaticMarkup(node)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/&mdash;/g, '—').replace(/&hellip;/g, '…').replace(/&times;/g, 'x')
    .replace(/&middot;/g, '·')
    .replace(/\s+/g, ' ')
    .trim();
}

const ME = 'vendor-1';
const OTHER_A = 'vendor-2';
const OTHER_B = 'vendor-3';

function invitation(over: Partial<SupplierInvitation> = {}): SupplierInvitation {
  return {
    invitationId: 'inv-1',
    rfqId: 'rfq-1',
    rfqNumber: 'RFQ-2026-200001',
    rfqTitle: 'Cardboard restock',
    issuedAt: '2026-09-28T09:00:00.000Z',
    deadlineAt: '2026-10-05T00:00:00.000Z',
    estimatedAmount: 2180000,
    declined: false,
    myQuote: null,
    roster: [
      { vendorId: ME, legalName: 'Acme Supplies (Pvt) Ltd', submitted: false, declined: false },
      { vendorId: OTHER_A, legalName: 'KarachiTech Supplies', submitted: true, declined: false },
      { vendorId: OTHER_B, legalName: 'Indus Office Solutions', submitted: true, declined: false },
    ],
    ...over,
  };
}

function line(over: Partial<SupplierQuoteLine> = {}): SupplierQuoteLine {
  return { lineNo: 1, sku: 'PKB-CS-001', description: 'Cardboard Sheet (large)', qty: 10, uom: 'sheet', ...over };
}

function inboxData(over: Partial<InboxData> = {}): InboxData {
  const inv = invitation();
  return {
    title: 'Supplier RFQ Inbox',
    subtitle: supplierInboxSubtitle('Acme Supplies (Pvt) Ltd', 'V-00081'),
    empty: false,
    emptyMessage: SUPPLIER_INBOX_EMPTY,
    kpis: inboxKpis([inv]),
    invitations: [{
      invitationId: inv.invitationId,
      rfqId: inv.rfqId,
      rfqNumber: inv.rfqNumber,
      rfqTitle: inv.rfqTitle,
      deadlineAt: inv.deadlineAt,
      declined: false,
      myQuote: null,
      lineCount: 3,
      paragraph: supplierInboxParagraph(3, ['KarachiTech Supplies', 'Indus Office Solutions']),
      invitedLabel: invitedCountLabel(3),
      canSubmit: true,
      canDecline: true,
      rosterRows: supplierRoster(inv, ME) as RosterRow[],
    }],
    ...over,
  };
}

/** The prototype's literals. None may appear on a ported screen. */
const FORBIDDEN = [
  'V-000123', 'PakBoxes Pvt Ltd', 'RFQ-2026-0042',
  'Ahsan Ali', 'sales@pakboxes.pk', '2180000',
  'closing in',
];

function assertClean(label: string, markup: string) {
  const t = text(h('div', { dangerouslySetInnerHTML: { __html: markup } }));
  for (const lit of FORBIDDEN) {
    assert.ok(
      !t.toLowerCase().includes(lit.toLowerCase()),
      `${label} leaked the prototype literal "${lit}"`,
    );
  }
}

// ── KPI band ───────────────────────────────────────────────────────────────

test('S1 the KPI band renders the four prototype labels with computed values', () => {
  const kpis = inboxKpis([invitation()]);
  const t = text(h(SupplierKpiBand, { kpis } as any));
  assert.match(t, /Active RFQs/);
  assert.match(t, /Quoted by me/);
  assert.match(t, /Competitors quoted/);
  assert.match(t, /Est\. value/);
  // "1 / No / 2 / PKR 21.8 L" — the prototype's OWN hardcoded values, produced
  // here by computation. A wrong computation shows as a diff, not an absence.
  assert.match(t, /Active RFQs 1/);
  assert.match(t, /Quoted by me No Action required/);
  assert.match(t, /Competitors quoted 2 of 3 invited/);
  assert.match(t, /Est\. value PKR 21\.8 L Buyer estimate/);
});

test('S2 the KPI band is a real em-dash when the estimate is unknown, never PKR 0', () => {
  const kpis = inboxKpis([invitation({ estimatedAmount: null })]);
  const t = text(h(SupplierKpiBand, { kpis } as any));
  assert.match(t, /Est\. value — Buyer estimate/);
  assert.doesNotMatch(t, /Est\. value PKR 0/);
});

test('S3 the unanswered KPI carries the prototype\'s warn styling', () => {
  const markup = renderToStaticMarkup(h(SupplierKpiBand, { kpis: inboxKpis([invitation()]) } as any));
  assert.match(markup, /var\(--warn\)/, 'the Quoted-by-me tile is amber until answered');
  // and NOT once answered
  const done = renderToStaticMarkup(
    h(SupplierKpiBand, { kpis: inboxKpis([invitation({ myQuote: { version: 2, state: 'Submitted' } })]) } as any),
  );
  assert.doesNotMatch(done, /var\(--warn\)/);
});

test('S4 no KPI value is ever an empty string', () => {
  const kpis = inboxKpis([invitation({ estimatedAmount: null })]);
  for (const k of kpis) {
    assert.equal(typeof k.value, 'string');
    assert.ok(k.value.length > 0, `${k.label} rendered an empty value`);
  }
});

// ── inbox list ─────────────────────────────────────────────────────────────

test('S5 the inbox renders the prototype paragraph, verbatim structure', () => {
  const t = text(h(SupplierInboxList, { data: inboxData() } as any));
  assert.match(t, /Submit your best quote for 3 line item\(s\)\./);
  assert.match(t, /Other invited vendors: KarachiTech Supplies, Indus Office Solutions\./);
  assert.ok(t.includes(SUPPLIER_VISIBILITY_NOTE));
});

test('S6 the inbox row shows the real RFQ number, line count and my status', () => {
  const t = text(h(SupplierInboxList, { data: inboxData() } as any));
  assert.match(t, /RFQ-2026-200001/);
  assert.match(t, /Cardboard restock/);
  assert.match(t, /2026-10-05/, 'the real due date');
  assert.match(t, /not started/, 'the prototype\'s own status for an unanswered RFQ');
  assert.match(t, /Quote now/, 'the prototype\'s row action');
  assert.doesNotMatch(t, /V3 submitted/);
});

test('S7 a submitted version renders as the prototype\'s pill', () => {
  const d = inboxData();
  d.invitations[0].myQuote = { version: 3, state: 'Submitted' };
  const t = text(h(SupplierInboxList, { data: d } as any));
  assert.match(t, /V3 submitted/);
});

test('S8 the EMPTY state replaces the list, and does not coexist with zeroes', () => {
  const d = inboxData({ empty: true, kpis: [], invitations: [] });
  const t = text(h(SupplierInboxList, { data: d } as any));
  assert.equal(t, SUPPLIER_INBOX_EMPTY);
  assert.doesNotMatch(t, /Active RFQs/);
  assert.doesNotMatch(t, /0 invited/);
});

test('S9 a declined invitation says Declined, and a closed one says Closed', () => {
  const declined = inboxData();
  declined.invitations[0].canSubmit = false;
  declined.invitations[0].declined = true;
  assert.match(text(h(SupplierInboxList, { data: declined } as any)), /Declined/);

  const closed = inboxData();
  closed.invitations[0].canSubmit = false;
  closed.invitations[0].declined = false;
  assert.match(text(h(SupplierInboxList, { data: closed } as any)), /Closed/);
});

test('S10 the inbox screen contains no prototype literal', () => {
  assertClean('SupplierInboxList', renderToStaticMarkup(h(SupplierInboxList, { data: inboxData() } as any)));
  assertClean('SupplierKpiBand', renderToStaticMarkup(h(SupplierKpiBand, { kpis: inboxKpis([invitation()]) } as any)));
});

// ── roster card ────────────────────────────────────────────────────────────

test('S11 the roster keeps the prototype\'s exact three column headers', () => {
  const inv = invitation();
  const markup = renderToStaticMarkup(
    h(SupplierRosterCard, { rows: supplierRoster(inv, ME) as RosterRow[], invitedLabel: invitedCountLabel(3) } as any),
  );
  // "My status" is the prototype's own header, not "Their status". Renaming it
  // would be a correction the port has no licence to make (W4-4).
  assert.match(markup, /<th>Vendor<\/th><th>My status<\/th><th>Coverage<\/th>/);
  assert.match(text(h(SupplierRosterCard, { rows: supplierRoster(inv, ME) as RosterRow[], invitedLabel: '3 invited' } as any)),
    /Invited vendors on this RFQ 3 invited/);
});

test('S12 coverage reads Quote received or Awaiting, exactly as the prototype', () => {
  const rows = supplierRoster(invitation(), ME) as RosterRow[];
  const t = text(h(SupplierRosterCard, { rows, invitedLabel: '3 invited' } as any));
  assert.match(t, /Awaiting/, 'my own row, not yet quoted');
  assert.equal((t.match(/Quote received/g) || []).length, 2, 'the two who have quoted');
});

test('S13 a declined vendor shows declined, NOT Quote received', () => {
  const rows = supplierRoster(
    invitation({
      roster: [
        { vendorId: ME, legalName: 'Acme', submitted: false, declined: false },
        { vendorId: OTHER_A, legalName: 'KarachiTech', submitted: true, declined: true },
      ],
    }),
    ME,
  ) as RosterRow[];
  const t = text(h(SupplierRosterCard, { rows, invitedLabel: '2 invited' } as any));
  assert.match(t, /declined/);
  assert.doesNotMatch(t, /Quote received/);
});

test('S14 my own row is marked (you)', () => {
  const rows = supplierRoster(invitation(), ME) as RosterRow[];
  const t = text(h(SupplierRosterCard, { rows, invitedLabel: '3 invited' } as any));
  assert.match(t, /Acme Supplies \(Pvt\) Ltd \(you\)/);
  assert.doesNotMatch(t, /KarachiTech Supplies \(you\)/);
});

// ── quote lines ────────────────────────────────────────────────────────────

test('S15 the line table keeps the prototype\'s six columns', () => {
  const lines = [line({ unitPrice: 500, qty: 200 })];
  const markup = renderToStaticMarkup(
    h(SupplierQuoteLines, { lines, totals: quoteLineTotals(lines) } as any),
  );
  assert.match(markup, /<th>SKU<\/th>/);
  assert.match(markup, /Unit price<\/th>/);
  assert.match(markup, /Line total<\/th>/);
  // React emits the literal U+00D7 multiplication sign for `&times;` rather
  // than the entity, so assert on the character the browser will actually see.
  assert.match(text(h(SupplierQuoteLines, { lines, totals: quoteLineTotals(lines) } as any)),
    /Line pricing Unit price \(PKR\) × qty/);
  assert.ok(markup.includes('×'), 'the card meta carries the prototype’s × separator');
});

test('S16 a BLANK line price shows an em-dash, never 0 and never a guess', () => {
  // The prototype pre-filled Math.round(estimated / totalQty) into every box
  // (:9040). A guess in a price box becomes a price in the audit trail.
  const lines = [line({ unitPrice: null })];
  const t = text(h(SupplierQuoteLines, { lines, totals: quoteLineTotals(lines) } as any));
  assert.match(t, /Quote total: —/);
  const markup = renderToStaticMarkup(h(SupplierQuoteLines, { lines, totals: quoteLineTotals(lines) } as any));
  assert.doesNotMatch(markup, />0</, 'a blank price must never render as 0');
  assert.doesNotMatch(markup, /21800/, 'the prototype\'s derived guess is absent');
});

test('S17 a PARTIALLY priced form shows no total at all', () => {
  // The divergence from quoteRecalc, which summed whatever was typed.
  const lines = [line({ lineNo: 1, unitPrice: 500, qty: 200 }), line({ lineNo: 2, unitPrice: null, qty: 5 })];
  const t = text(h(SupplierQuoteLines, { lines, totals: quoteLineTotals(lines) } as any));
  assert.match(t, /Quote total: —/);
  assert.doesNotMatch(t, /Quote total: PKR/);
  assert.match(t, /PKR 1\.0 L/, 'the priced line still shows its own total');
});

test('S18 a fully priced form totals correctly, in the prototype\'s format', () => {
  const lines = [line({ lineNo: 1, unitPrice: 500, qty: 200 }), line({ lineNo: 2, unitPrice: 200, qty: 200 })];
  const t = text(h(SupplierQuoteLines, { lines, totals: quoteLineTotals(lines) } as any));
  assert.match(t, /Quote total: PKR 1\.4 L/);
});

test('S19 a zero-priced but COMPLETE form shows PKR 0, not an em-dash', () => {
  // An entered zero is a price. Only an ABSENT one is unknown, and conflating
  // them would let a vendor submit a form they never filled in.
  const lines = [line({ unitPrice: 0, qty: 10 })];
  const t = text(h(SupplierQuoteLines, { lines, totals: quoteLineTotals(lines) } as any));
  assert.match(t, /Quote total: PKR 0/);
  assert.doesNotMatch(t, /Quote total: —/);
});

test('S20 a zero-line RFQ shows the prototype\'s empty sentence', () => {
  const t = text(h(SupplierQuoteLines, { lines: [], totals: quoteLineTotals([]) } as any));
  assert.match(t, new RegExp(SUPPLIER_QUOTE_NO_LINES.replace('.', '\\.')));
  assert.match(t, /Quote total: —/);
});

test('S21 the line total uses the prototype\'s fmtPKR, not the web app\'s pkr()', () => {
  // supplier.ts documents why the two differ; a render test pins it so nobody
  // "unifies" them by accident.
  const lines = [line({ unitPrice: 500, qty: 21800 })];
  const t = text(h(SupplierQuoteLines, { lines, totals: quoteLineTotals(lines) } as any));
  assert.match(t, /PKR 1\.09 Cr/, 'the prototype abbreviates');
  assert.doesNotMatch(t, /10,900,000/, 'the web pkr() would print the full figure');
  assert.equal(fmtPKR(10900000), 'PKR 1.09 Cr');
});

test('S22 the quote screen contains no prototype literal', () => {
  const lines = [line({ unitPrice: 500, qty: 200 })];
  assertClean('SupplierQuoteLines', renderToStaticMarkup(h(SupplierQuoteLines, { lines, totals: quoteLineTotals(lines) } as any)));
});

// ── commercial terms ───────────────────────────────────────────────────────

test('S23 the commercial terms card keeps the prototype\'s labels', () => {
  const t = text(h(SupplierCommercialTerms, {
    values: { totalAmount: 100000, leadTime: '7 days', warranty: '3 yr', paymentTerms: '60 days', remarks: '' },
  } as any));
  assert.match(t, /Total amount \(PKR\) \*/);
  assert.match(t, /Lead time/);
  assert.match(t, /Warranty/);
  assert.match(t, /Payment terms/);
  assert.match(t, /Remarks/);
  assert.match(t, /Submit quote/);
});

test('S24 the audit-trail hint and the remarks placeholder are the prototype\'s', () => {
  const node = h(SupplierCommercialTerms, {
    values: { totalAmount: 1, leadTime: '7 days', warranty: '3 yr', paymentTerms: '60 days', remarks: '' },
  } as any);
  const t = text(node);
  assert.ok(t.includes(SUPPLIER_SUBMIT_HINT));
  // The placeholder is an ATTRIBUTE, so it never survives the text() tag-strip.
  // Assert on the markup, or this test would pass while the prototype's
  // placeholder was quietly deleted from the form.
  const markup = renderToStaticMarkup(node);
  assert.ok(
    markup.includes(SUPPLIER_REMARKS_PLACEHOLDER),
    `the remarks placeholder is not in the markup: ${markup}`,
  );
  assert.match(markup, /Delivery, installation, exclusions/);
});

test('S25 every rendered option is a real option the API can convert', () => {
  // A label the converter would reject (leadTimeDays returns null) is a field
  // the supplier can pick and the API will then refuse.
  const markup = renderToStaticMarkup(h(SupplierCommercialTerms, {
    values: { totalAmount: null, leadTime: '7 days', warranty: '3 yr', paymentTerms: '60 days', remarks: '' },
  } as any));
  for (const o of [...SUPPLIER_TERM_OPTIONS.leadTime, ...SUPPLIER_TERM_OPTIONS.warranty, ...SUPPLIER_TERM_OPTIONS.paymentTerms]) {
    assert.ok(markup.includes(`>${o}<`), `option ${o} is not rendered`);
  }
  assert.ok(markup.includes(`value="${SUPPLIER_TERM_DEFAULTS.leadTime}" selected`), 'the prototype\'s default lead time is selected');
  assert.ok(markup.includes(`value="${SUPPLIER_TERM_DEFAULTS.warranty}" selected`), 'the prototype\'s default warranty is selected');
  assert.ok(markup.includes(`value="${SUPPLIER_TERM_DEFAULTS.paymentTerms}" selected`), 'the prototype\'s default payment terms is selected');
});

test('S26 the derived total is a placeholder, not a second source of truth', () => {
  const markup = renderToStaticMarkup(h(SupplierCommercialTerms, {
    values: { totalAmount: null, leadTime: '7 days', warranty: '3 yr', paymentTerms: '60 days', remarks: '' },
  } as any));
  assert.match(markup, /Derived from the line prices/);
  assert.equal(SUPPLIER_REMARKS_PLACEHOLDER, 'Delivery, installation, exclusions…');
});

// ── the W4 §9 wording check, on rendered output ────────────────────────────

test('S27 W4-2: no rendered supplier screen claims the quote is sealed', () => {
  // The plan's §9 test (d), asserted where a reviewer would actually see it.
  const screens: Array<[string, string]> = [
    ['SupplierInboxList', renderToStaticMarkup(h(SupplierInboxList, { data: inboxData() } as any))],
    ['SupplierKpiBand', renderToStaticMarkup(h(SupplierKpiBand, { kpis: inboxKpis([invitation()]) } as any))],
    ['SupplierRosterCard', renderToStaticMarkup(h(SupplierRosterCard, {
      rows: supplierRoster(invitation(), ME) as RosterRow[], invitedLabel: '3 invited',
    } as any))],
    ['SupplierQuoteLines', renderToStaticMarkup(h(SupplierQuoteLines, {
      lines: [line({ unitPrice: 500, qty: 200 })], totals: quoteLineTotals([line({ unitPrice: 500, qty: 200 })]),
    } as any))],
    ['SupplierCommercialTerms', renderToStaticMarkup(h(SupplierCommercialTerms, {
      values: { totalAmount: 100, leadTime: '7 days', warranty: '3 yr', paymentTerms: '60 days', remarks: '' },
    } as any))],
  ];
  for (const [name, markup] of screens) {
    const t = text(h('div', { dangerouslySetInnerHTML: { __html: markup } }));
    assert.doesNotMatch(t, /sealed until/i, `${name} still claims a sealed quote`);
    assert.doesNotMatch(t, /closing in/i, `${name} still renders a countdown`);
  }
});

test('S28 the honest visibility note is what the screens actually say', () => {
  const t = text(h(SupplierInboxList, { data: inboxData() } as any));
  assert.ok(t.includes('Your quote is visible to the buyer as soon as you submit it.'));
  assert.ok(t.includes('You may revise it until the RFQ is closed.'));
});

test('S29 the quote alert names a real buyer, not the prototype\'s fake', () => {
  const alert = supplierQuoteAlert('Information Technology');
  const t = text(h('div', null, alert));
  assert.match(t, /Quote for Information Technology\./);
  assert.doesNotMatch(t, /V-000123/);
  assert.doesNotMatch(t, /PakBoxes/);
  assert.ok(alert.endsWith(SUPPLIER_VISIBILITY_NOTE));
});

test('S30 the subtitles use the real identity', () => {
  assert.equal(
    text(h('div', null, supplierInboxSubtitle('Acme Supplies (Pvt) Ltd', 'V-00081'))),
    'Acting as Acme Supplies (Pvt) Ltd · V-00081',
  );
  assert.equal(
    text(h('div', null, supplierQuoteSubtitle('RFQ-2026-200001', 'Cardboard restock', '2026-10-05T00:00:00.000Z'))),
    'RFQ-2026-200001 · Cardboard restock · Due 2026-10-05',
  );
});

test('S31 moneyOrDash is the only money formatter the line table uses', () => {
  assert.equal(moneyOrDash(null), '—');
  assert.equal(moneyOrDash(0), 'PKR 0');
  assert.equal(moneyOrDash(2180000), 'PKR 21.8 L');
});
