// Supplier logic test suite — parity with the prototype's renderSupplierInbox
// (:9001-9035), renderSupplierQuote (:9037-9070), quoteRecalc (:7312-7340) and
// supplierSubmitQuote (:7342-7358).
//
// Run with: node --test dist/__tests__/supplier.test.js (after `npm run build`)
//
// Per WAVE4_PLAN.md §9 rule 2, this suite is written so a wrong value cannot
// pass: the "computed, never hardcoded" tests assert on the VALUE the prototype
// faked, so they fail if the computation is wrong rather than merely present.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fmtPKR,
  inboxKpis,
  supplierRoster,
  vendorPill,
  vendorStatus,
  coverageFor,
  quoteLineTotals,
  quoteLineTotal,
  moneyOrDash,
  isPriced,
  leadTimeDays,
  warrantyMonths,
  paymentTermsDays,
  validateSupplierQuote,
  formatDay,
  canUseSupplierSurfaces,
  supplierInboxParagraph,
  supplierInboxSubtitle,
  supplierQuoteSubtitle,
  supplierQuoteAlert,
  invitedCountLabel,
  SUPPLIER_INBOX_TITLE,
  SUPPLIER_QUOTE_TITLE,
  SUPPLIER_INBOX_EMPTY,
  SUPPLIER_QUOTE_NO_LINES,
  SUPPLIER_VISIBILITY_NOTE,
  SUPPLIER_SUBMIT_HINT,
  SUPPLIER_TERM_OPTIONS,
  SUPPLIER_TERM_DEFAULTS,
  SUPPLIER_REMARKS_PLACEHOLDER,
  type SupplierInvitation,
  type SupplierQuoteLine,
} from '../supplier';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function line(over: Partial<SupplierQuoteLine> = {}): SupplierQuoteLine {
  return { lineNo: 1, sku: 'PKB-CS-001', description: 'Cardboard Sheet (large)', qty: 10, uom: 'sheet', ...over };
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
    deadlineAt: '2026-09-05T00:00:00.000Z',
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

// ─── fmtPKR ─────────────────────────────────────────────────────────────────

test('S01 fmtPKR reproduces the prototype Cr/L/K ladder', () => {
  // renderSupplierInbox:9013 renders fmtPKR(estimatedAmount||2180000) and the
  // plan §7 records that as "PKR 21.8 L".
  assert.equal(fmtPKR(2180000), 'PKR 21.8 L');
  assert.equal(fmtPKR(12000000), 'PKR 1.20 Cr');
  assert.equal(fmtPKR(100000), 'PKR 1.0 L');
  assert.equal(fmtPKR(1000), 'PKR 1.0 K');
  assert.equal(fmtPKR(999), 'PKR 999');
  assert.equal(fmtPKR(0), 'PKR 0');
});

test('S02 fmtPKR boundary: 9,999,999 is L, 10,000,000 is Cr', () => {
  assert.equal(fmtPKR(9999999), 'PKR 100.0 L');
  assert.equal(fmtPKR(10000000), 'PKR 1.00 Cr');
});

test('S03 fmtPKR never emits NaN where the prototype would', () => {
  // The prototype renders "PKR NaN" for undefined. This feeds a financial
  // record, so it must not.
  assert.equal(fmtPKR(NaN), 'PKR 0');
  assert.equal(fmtPKR(undefined), 'PKR 0');
  assert.equal(fmtPKR(null), 'PKR 0');
  assert.equal(fmtPKR('not a number'), 'PKR 0');
});

test('S04 fmtPKR is locale-pinned, not machine-dependent', () => {
  // The prototype's bare toLocaleString() would render 1234567 as "1,234,567"
  // in en-US and "1 234 567" elsewhere, so its output depends on the machine.
  // Here every value >= 1000 is abbreviated with a fixed '.' decimal and never
  // reaches toLocaleString at all; only sub-thousand values are returned
  // verbatim, and those have no separator to disagree about.
  assert.equal(fmtPKR(999), 'PKR 999');
  assert.equal(fmtPKR(1000), 'PKR 1.0 K');
  assert.equal(fmtPKR(1234567), 'PKR 12.3 L');
  assert.equal(fmtPKR(1000000), 'PKR 10.0 L');
  assert.equal(fmtPKR(999999), 'PKR 10.0 L');
  // A large value must abbreviate rather than emit a grouped number whose
  // separator would follow the host locale.
  assert.equal(fmtPKR(1234567890), 'PKR 123.46 Cr');
  assert.doesNotMatch(fmtPKR(1234567890), /[^\x00-\x7F]/, 'abbreviated output must stay ASCII');
});

// ─── Inbox KPIs ─────────────────────────────────────────────────────────────

test('S05 inboxKpis reproduces the prototype band EXACTLY on the same data', () => {
  // The prototype hardcodes 1 / No / 2 / PKR 21.8 L (:9010-9013). Reproducing
  // those four values from real data is the whole test: if the computation were
  // wrong, at least one of them would differ from the prototype's own text.
  const kpis = inboxKpis([invitation()]);
  assert.equal(kpis[0].value, '1');          // Active RFQs
  assert.equal(kpis[1].value, 'No');         // Quoted by me
  assert.equal(kpis[1].sub, 'Action required');
  assert.equal(kpis[1].tone, 'warn');
  assert.equal(kpis[2].value, '2');          // Competitors quoted
  assert.equal(kpis[2].sub, 'of 3 invited');
  assert.equal(kpis[3].value, 'PKR 21.8 L'); // Est. value
  assert.equal(kpis[3].sub, 'Buyer estimate');
});

test('S06 the KPI labels are the prototype\'s, in order', () => {
  const kpis = inboxKpis([invitation()]);
  assert.deepEqual(kpis.map(k => k.label), [
    'Active RFQs',
    'Quoted by me',
    'Competitors quoted',
    'Est. value',
  ]);
  assert.match(kpis[0].sub, /^Due \d{4}-\d{2}-\d{2}$/);
});

test('S07 "Quoted by me" flips to Yes + the version once I have quoted', () => {
  const kpis = inboxKpis([invitation({ myQuote: { version: 2, state: 'Submitted' } })]);
  assert.equal(kpis[1].value, 'Yes');
  assert.equal(kpis[1].sub, 'V2');
  // The warn tone is the prototype styling for an unanswered KPI (:9011).
  assert.equal(kpis[1].tone, undefined);
});

test('S08 the version reported is the HIGHEST across open RFQs, not the first', () => {
  const kpis = inboxKpis([
    invitation({ rfqId: 'a', myQuote: { version: 1, state: 'Submitted' } }),
    invitation({ rfqId: 'b', myQuote: { version: 3, state: 'Submitted' } }),
  ]);
  assert.equal(kpis[1].sub, 'V3');
});

test('S09 a declined RFQ is not an active RFQ', () => {
  const kpis = inboxKpis([
    invitation({ declined: true }),
    invitation({ invitationId: 'inv-2', declined: false }),
  ]);
  assert.equal(kpis[0].value, '1');
});

test('S10 a declined vendor stays in the DENOMINATOR but not the numerator', () => {
  // "Invited" is a fact about the past: the roster card lists every invited
  // vendor (with a 'declined' status for the one who walked), so the KPI
  // denominator must count the same set or the card header and its own rows
  // disagree. Excluding them from the NUMERATOR is separate and still right —
  // a declined vendor is not competing.
  const kpis = inboxKpis([
    invitation({
      roster: [
        { vendorId: ME, legalName: 'Acme', submitted: false, declined: false },
        { vendorId: OTHER_A, legalName: 'KarachiTech', submitted: true, declined: false },
        { vendorId: OTHER_B, legalName: 'Indus', submitted: false, declined: true },
      ],
    }),
  ]);
  assert.equal(kpis[2].sub, 'of 3 invited');
  assert.equal(kpis[2].value, '1');
});

test('S10b a declined vendor who somehow still holds a quote is not counted as competing', () => {
  const kpis = inboxKpis([
    invitation({
      roster: [
        { vendorId: ME, legalName: 'Acme', submitted: false, declined: false },
        { vendorId: OTHER_A, legalName: 'KarachiTech', submitted: true, declined: true },
      ],
    }),
  ]);
  assert.equal(kpis[2].value, '0');
  assert.equal(kpis[2].sub, 'of 2 invited');
});

test('S11 an unknown estimate renders an em-dash, never PKR 0', () => {
  // The prototype's `pr.estimatedAmount||2180000` silently substitutes a
  // fabricated 2.18M. An absent estimate must read as unknown.
  const kpis = inboxKpis([invitation({ estimatedAmount: null })]);
  assert.equal(kpis[3].value, '—');
  assert.equal(kpis[3].sub, 'Buyer estimate');
});

test('S12 an empty inbox reports zero, and the renderer decides to show the empty state', () => {
  const kpis = inboxKpis([]);
  assert.equal(kpis[0].value, '0');
  assert.equal(kpis[2].value, '0');
  assert.equal(kpis[2].sub, 'of 0 invited');
  assert.equal(kpis[3].value, '—');
});

test('S13 Active RFQs shows the NEAREST deadline, not an arbitrary one', () => {
  const kpis = inboxKpis([
    invitation({ invitationId: 'a', deadlineAt: '2026-10-30T00:00:00.000Z' }),
    invitation({ invitationId: 'b', deadlineAt: '2026-09-05T00:00:00.000Z' }),
  ]);
  assert.equal(kpis[0].sub, 'Due 2026-09-05');
});

test('S14 a missing deadline reads as an em-dash inside the Due label', () => {
  const kpis = inboxKpis([invitation({ deadlineAt: null })]);
  assert.equal(kpis[0].sub, 'Due —');
});

// ─── Roster ─────────────────────────────────────────────────────────────────

test('S15 the roster reproduces the prototype\'s 3 rows and coverage values', () => {
  // renderSupplierInbox:9026-9028 — 'Quote received' when the pill is
  // 'approved', otherwise 'Awaiting'.
  const rows = supplierRoster(invitation(), ME);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.coverage), ['Awaiting', 'Quote received', 'Quote received']);
  assert.deepEqual(rows.map(r => r.status), ['not started', 'submitted', 'submitted']);
  assert.deepEqual(rows.map(r => r.pill), ['draft', 'approved', 'approved']);
  assert.deepEqual(rows.map(r => r.isMe), [true, false, false]);
});

test('S16 pill precedence: declined beats submitted', () => {
  assert.equal(vendorPill(false, true), 'danger');
  assert.equal(vendorStatus('danger'), 'declined');
  assert.equal(coverageFor('danger'), 'Awaiting');
  // A vendor who submitted and then declined must not read as "Quote received".
  assert.equal(vendorPill(true, true), 'danger');
  assert.equal(vendorPill(true, false), 'approved');
  assert.equal(vendorPill(false, false), 'draft');
});

test('S17 coverageFor is derived from the pill, never stored separately', () => {
  assert.equal(coverageFor('approved'), 'Quote received');
  assert.equal(coverageFor('draft'), 'Awaiting');
});

// ─── Quote math ─────────────────────────────────────────────────────────────

test('S18 line total is unit price x qty', () => {
  assert.equal(quoteLineTotal(line({ unitPrice: 500, qty: 200 })), 100000);
  assert.equal(quoteLineTotal(line({ unitPrice: '250.50', qty: 4 })), 1002);
});

test('S19 an unpriced line is null, NOT zero', () => {
  // The prototype coerces a blank box to 0 in quoteRecalc. Zero is a price the
  // vendor chose; null is a price they have not given yet. Conflating them
  // would let an untouched form submit a zero-value quote.
  assert.equal(quoteLineTotal(line({ unitPrice: null })), null);
  assert.equal(quoteLineTotal(line({ unitPrice: '' })), null);
  assert.equal(quoteLineTotal(line({ unitPrice: undefined })), null);
  assert.equal(isPriced(0), true); // 0 IS a real price
  assert.equal(isPriced(''), false);
  assert.equal(isPriced(null), false);
});

test('S20 the quote total is null until EVERY line is priced', () => {
  // The divergence from quoteRecalc: a partial sum is not a quote total.
  const partial = quoteLineTotals([
    line({ lineNo: 1, unitPrice: 100, qty: 10 }),
    line({ lineNo: 2, unitPrice: null, qty: 5 }),
  ]);
  assert.equal(partial.total, null);
  assert.equal(partial.complete, false);
  assert.equal(partial.pricedCount, 1);
  assert.deepEqual(partial.lineTotals, [1000, null]);
  assert.equal(moneyOrDash(partial.total), '—');
});

test('S21 a fully priced form totals correctly', () => {
  const r = quoteLineTotals([
    line({ lineNo: 1, unitPrice: 500, qty: 200 }),
    line({ lineNo: 2, unitPrice: 200, qty: 200 }),
  ]);
  assert.equal(r.total, 140000);
  assert.equal(r.complete, true);
  assert.equal(r.pricedCount, 2);
  assert.equal(moneyOrDash(r.total), 'PKR 1.4 L');
});

test('S22 a zero-priced but COMPLETE form is a real total of 0, not null', () => {
  // "0" is a price. Only an absent one is null.
  const r = quoteLineTotals([line({ unitPrice: 0, qty: 10 })]);
  assert.equal(r.total, 0);
  assert.equal(r.complete, true);
  assert.equal(moneyOrDash(r.total), 'PKR 0');
});

test('S23 an empty line list is never "complete"', () => {
  // Otherwise a zero-line RFQ reports a legitimate total of PKR 0.
  const r = quoteLineTotals([]);
  assert.equal(r.total, null);
  assert.equal(r.complete, false);
});

test('S24 a non-numeric unit price is unpriced, not NaN', () => {
  const r = quoteLineTotals([line({ unitPrice: 'abc', qty: 3 })]);
  assert.equal(r.total, null);
  assert.deepEqual(r.lineTotals, [null]);
});

test('S25 moneyOrDash renders the prototype format or the em-dash', () => {
  assert.equal(moneyOrDash(2180000), 'PKR 21.8 L');
  assert.equal(moneyOrDash(null), '—');
  assert.equal(moneyOrDash(undefined), '—');
  assert.equal(moneyOrDash(NaN), '—');
});

// ─── Term label conversion ──────────────────────────────────────────────────

test('S26 lead time labels convert to the integer the column stores', () => {
  assert.equal(leadTimeDays('5 days'), 5);
  assert.equal(leadTimeDays('14 days'), 14);
  assert.equal(leadTimeDays('7 days'), 7);
});

test('S27 warranty converts to MONTHS, not years', () => {
  assert.equal(warrantyMonths('1 yr'), 12);
  assert.equal(warrantyMonths('2 yr'), 24);
  assert.equal(warrantyMonths('3 yr'), 36);
});

test('S28 payment terms convert to days', () => {
  assert.equal(paymentTermsDays('30 days'), 30);
  assert.equal(paymentTermsDays('60 days'), 60);
  assert.equal(paymentTermsDays('90 days'), 90);
});

test('S29 an unrecognised term is null, never a silent default', () => {
  // Falling back to 7 days would put a number in the database that no supplier
  // ever agreed to.
  assert.equal(leadTimeDays('as soon as possible'), null);
  assert.equal(leadTimeDays(''), null);
  assert.equal(warrantyMonths('lifetime'), null);
  assert.equal(paymentTermsDays('net 45'), null);
});

test('S30 every default in SUPPLIER_TERM_DEFAULTS is a real option', () => {
  // A default that is not in the option list renders a select with nothing
  // selected and submits a label the conversion above would reject.
  assert.ok(SUPPLIER_TERM_OPTIONS.leadTime.includes(SUPPLIER_TERM_DEFAULTS.leadTime as never));
  assert.ok(SUPPLIER_TERM_OPTIONS.warranty.includes(SUPPLIER_TERM_DEFAULTS.warranty as never));
  assert.ok(SUPPLIER_TERM_OPTIONS.paymentTerms.includes(SUPPLIER_TERM_DEFAULTS.paymentTerms as never));
});

test('S31 the term options are the prototype\'s, in the prototype\'s order', () => {
  assert.deepEqual([...SUPPLIER_TERM_OPTIONS.leadTime], ['5 days', '7 days', '10 days', '14 days']);
  assert.deepEqual([...SUPPLIER_TERM_OPTIONS.warranty], ['1 yr', '2 yr', '3 yr']);
  assert.deepEqual([...SUPPLIER_TERM_OPTIONS.paymentTerms], ['30 days', '60 days', '90 days']);
});

// ─── Validation ─────────────────────────────────────────────────────────────

test('S32 a complete quote validates', () => {
  const r = validateSupplierQuote({
    lines: [line({ unitPrice: 500, qty: 200 })],
    totalAmount: 100000,
    leadTime: '7 days',
    warranty: '3 yr',
    paymentTerms: '60 days',
  });
  assert.equal(r.ok, true);
});

test('S33 a blank unit price is refused, naming the offending line', () => {
  const r = validateSupplierQuote({
    lines: [
      line({ lineNo: 1, unitPrice: 500 }),
      line({ lineNo: 7, description: 'Ballpoint Pen (Box of 50)', unitPrice: '' }),
    ],
    totalAmount: 100000,
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.message, /Ballpoint Pen/);
    assert.match(r.message, /line 7/);
  }
});

test('S34 a zero-line quote is refused with the prototype\'s empty copy', () => {
  const r = validateSupplierQuote({ lines: [], totalAmount: 1000 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.message, SUPPLIER_QUOTE_NO_LINES);
});

test('S35 a missing total amount is refused', () => {
  const r = validateSupplierQuote({ lines: [line({ unitPrice: 10 })], totalAmount: null });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /Total amount/);
});

test('S36 an unrecognised commercial term is refused rather than defaulted', () => {
  const r = validateSupplierQuote({
    lines: [line({ unitPrice: 10 })],
    totalAmount: 100,
    leadTime: 'whenever',
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /lead time/i);
});

// ─── Copy ───────────────────────────────────────────────────────────────────

test('S37 the page titles are the prototype\'s', () => {
  assert.equal(SUPPLIER_INBOX_TITLE, 'Supplier RFQ Inbox');
  assert.equal(SUPPLIER_QUOTE_TITLE, 'Submit Quote');
});

test('S38 the empty states are the prototype\'s, verbatim', () => {
  assert.equal(SUPPLIER_INBOX_EMPTY, 'No active RFQs at the moment. The buyer will issue one soon.');
  assert.equal(SUPPLIER_QUOTE_NO_LINES, 'No lines to quote.');
});

test('S39 W4-2: the false "sealed" sentence is gone from EVERY copy string', () => {
  // The render test also pins the absence of this wording in the DOM. This
  // catches it at the source, where the copy actually lives.
  const forbidden = /sealed until/i;
  const all = [
    SUPPLIER_VISIBILITY_NOTE,
    SUPPLIER_INBOX_EMPTY,
    SUPPLIER_QUOTE_NO_LINES,
    SUPPLIER_SUBMIT_HINT,
    SUPPLIER_REMARKS_PLACEHOLDER,
    supplierInboxParagraph(3, ['KarachiTech Supplies']),
    supplierInboxSubtitle('Acme Supplies (Pvt) Ltd', 'V-00081'),
    supplierQuoteSubtitle('RFQ-2026-200001', 'Cardboard restock', '2026-09-05T00:00:00.000Z'),
    supplierQuoteAlert('Information Technology'),
    invitedCountLabel(3),
  ];
  for (const s of all) {
    assert.doesNotMatch(s, forbidden, `copy still claims a sealed quote: ${s}`);
  }
});

test('S40 W4-2: the visibility note says exactly what was approved', () => {
  assert.equal(
    SUPPLIER_VISIBILITY_NOTE,
    'Your quote is visible to the buyer as soon as you submit it. You may revise it until the RFQ is closed.',
  );
});

test('S41 W4-2: the "Closing in 7 days" countdown is gone', () => {
  // No timer may run (Q2). The deadline is shown as a date or not at all.
  const inbox = supplierInboxParagraph(1, []);
  assert.doesNotMatch(inbox, /closing in/i);
  assert.equal(inboxKpis([invitation()])[0].sub, 'Due 2026-09-05');
});

test('S42 the inbox paragraph keeps the prototype\'s sentence structure', () => {
  const s = supplierInboxParagraph(3, ['KarachiTech Supplies', 'Indus Office Solutions']);
  assert.match(s, /^Submit your best quote for 3 line item\(s\)\./);
  assert.match(s, /Other invited vendors: KarachiTech Supplies, Indus Office Solutions\./);
  assert.ok(s.endsWith(SUPPLIER_VISIBILITY_NOTE));
});

test('S43 the inbox paragraph omits the roster clause when I am the only invitee', () => {
  // Not an empty "Other invited vendors: ." — the clause is dropped whole.
  const s = supplierInboxParagraph(2, []);
  assert.doesNotMatch(s, /Other invited vendors/);
  assert.match(s, /^Submit your best quote for 2 line item\(s\)\./);
});

test('S44 the subtitles use the real identity, not the prototype placeholder', () => {
  const sub = supplierInboxSubtitle('Acme Supplies (Pvt) Ltd', 'V-00081');
  assert.equal(sub, 'Acting as Acme Supplies (Pvt) Ltd · V-00081');
  assert.doesNotMatch(sub, /V-000123/);
  assert.doesNotMatch(sub, /PakBoxes/);
});

test('S45 the quote subtitle is "<rfq> · <title> · Due <date>"', () => {
  assert.equal(
    supplierQuoteSubtitle('RFQ-2026-200001', 'Cardboard restock', '2026-09-05T00:00:00.000Z'),
    'RFQ-2026-200001 · Cardboard restock · Due 2026-09-05',
  );
});

test('S46 the quote alert names the real buyer and states the honest visibility rule', () => {
  // The prototype's "Quote for PakBoxes Pvt Ltd (V-000123)" is one literal doing
  // two jobs — fake buyer AND fake supplier. There is no buyer table, so the
  // caller supplies the real buying department.
  const a = supplierQuoteAlert('Information Technology');
  assert.match(a, /^Quote for Information Technology\./);
  assert.ok(a.endsWith(SUPPLIER_VISIBILITY_NOTE));
  assert.doesNotMatch(a, /V-000123/);
  assert.doesNotMatch(a, /PakBoxes/);
});

test('S47 no prototype literal leaked into any copy helper', () => {
  const everything = [
    supplierInboxParagraph(2, ['KarachiTech Supplies']),
    supplierInboxSubtitle('Acme Supplies (Pvt) Ltd', 'V-00081'),
    supplierQuoteSubtitle('RFQ-2026-200001', 'Cardboard restock', '2026-09-05T00:00:00.000Z'),
    supplierQuoteAlert('Information Technology'),
  ].join(' | ');
  for (const lit of ['V-000123', 'PakBoxes Pvt Ltd', 'RFQ-2026-0042', '2026-08-28', '2026-09-15']) {
    assert.doesNotMatch(everything, new RegExp(lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `leaked prototype literal: ${lit}`);
  }
});

test('S48 invitedCountLabel is the prototype\'s "<N> invited"', () => {
  assert.equal(invitedCountLabel(3), '3 invited');
  assert.equal(invitedCountLabel(1), '1 invited');
});

// ─── Dates & role ───────────────────────────────────────────────────────────

test('S49 formatDay returns a real date or an em-dash, never "Invalid Date"', () => {
  assert.equal(formatDay('2026-09-05T00:00:00.000Z'), '2026-09-05');
  assert.equal(formatDay(null), '—');
  assert.equal(formatDay(undefined), '—');
  assert.equal(formatDay('nonsense'), '—');
});

test('S50 only a vendor session may use the supplier surfaces', () => {
  // Mirrors supplierSubmitQuote's `STATE.role!=='vendor'` guard (:7343).
  assert.equal(canUseSupplierSurfaces('vendor'), true);
  for (const r of ['procurement', 'cs', 'admin', 'requester', 'hod', 'public', null, undefined]) {
    assert.equal(canUseSupplierSurfaces(r), false, `${r} must not reach the supplier surfaces`);
  }
});

test('S51 the admin alias deliberately does NOT include supplier surfaces', () => {
  // Documented decision, asserted so a future ROLE_ALIASES edit cannot quietly
  // grant it: a super-role that can impersonate a supplier would defeat the
  // vendor scoping migration 028 exists to guarantee.
  assert.equal(canUseSupplierSurfaces('admin'), false);
});
