// Wave 3 step 6 — the governance screens RENDER the prototype's copy.
//
//   npm run test:web
//
// Why this file exists
// --------------------
// `scripts/e2e_governance_web.mjs` can only prove a route returns 200. Every
// Wave 3 page returns `null` until a session exists, so the server HTML is an
// empty 1.2 KB shell — "no Application error" proved nothing about what a
// reviewer actually sees. This suite closes that gap by rendering the real
// components with react-dom/server and asserting on the markup.
//
// The rule: assert against the PRODUCER, not a hand-copied fixture. Pack
// documents come from the engine's own `packDocuments()`, digests from its
// `formatDigest()`, the MC header chip from `mcTally()`. If the engine changes
// a note, this test fails rather than quietly agreeing with a stale expectation.
//
// The prototype's placeholders (PO-2026-00781, V-000123, a3f9c1, 2400000) are
// asserted ABSENT from every rendered screen. The prototype generates its hash
// column with Math.random() (line 7946) — a decorative hash in a governance
// pack looks like evidence, which is exactly what D1 forbids.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement as h } from 'react';
import {
  packDocuments, formatDigest, mcTally, PACK_DOCUMENT_NAMES, MC_PANEL_SIZE,
  type PackDocument,
} from '@procurement/workflow-engine';
import {
  PurposeAckWidget, ImageGalleryCard, McVoteTable, PackDocuments,
  D365EventStream, CfoSummaryGrid,
} from '../components/governance/GovernanceCards';

// ── helpers ────────────────────────────────────────────────────────────────

/** Render to readable text so assertions read like the screen a human sees. */
function text(node: React.ReactElement): string {
  return renderToStaticMarkup(node)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Raw markup, for asserting on attributes (titles, class names, colors). */
function markup(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

const PLACEHOLDERS = ['PO-2026-00781', 'V-000123', 'a3f9c1', '2400000'];

/** No placeholder may survive in any screen. */
function assertNoPlaceholders(label: string, node: React.ReactElement) {
  const out = text(node);
  for (const p of PLACEHOLDERS) {
    assert.ok(!out.includes(p), `${label} must not contain the prototype placeholder "${p}"`);
  }
}

const REAL_SHA = 'sha256:' + 'a'.repeat(64);

/**
 * The bridge the service performs: the engine yields `sha256`, the API adds the
 * pre-truncated `display_hash` the browser renders. Reproducing it here means
 * the component is tested against the SHAPE the server actually sends, not a
 * shape invented for the test.
 */
const toPackDocs = (docs: PackDocument[]) =>
  docs.map(d => ({ ...d, display_hash: formatDigest(d.sha256) }));

// ── PurposeAckWidget — prototype purposeAndAckWidget (line 1595) ───────────

test('W6-01 the widget renders nothing when the PR has no purpose (prototype line 1597)', () => {
  assert.equal(renderToStaticMarkup(h(PurposeAckWidget, { data: null })), '');
  assert.equal(renderToStaticMarkup(h(PurposeAckWidget, { data: { purpose_type: null } as any })), '');
});

test('W6-02 the scenario pill uses the prototype label, not the raw enum', () => {
  const out = text(h(PurposeAckWidget, {
    data: { purpose_type: 'EXISTING_EMPLOYEE', summary: null, approvers: [], total: 0, pending: 0 },
  }));
  assert.match(out, /Purchase purpose & acknowledgements/);
  assert.match(out, /Scenario:/);
  assert.match(out, /Existing Employee/);
  assert.ok(!out.includes('EXISTING_EMPLOYEE'), 'the raw enum must not reach the screen');
});

test('W6-03 acknowledgement state renders the prototype pills', () => {
  const out = text(h(PurposeAckWidget, {
    data: {
      purpose_type: 'NEW_EMPLOYEE',
      summary: 'Two replacements for the Lahore support desk.',
      approvers: [
        { name: 'Dr. Imran Shah', email: 'imran.shah@pakboxes.pk', role: 'mc', acknowledged: true, acknowledged_at: '2026-09-30 10:15' },
        { name: 'Tariq Saleem', email: 'tariq.saleem@pakboxes.pk', role: 'mc', acknowledged: false, acknowledged_at: null },
      ],
      total: 2, pending: 1,
    },
  }));
  assert.match(out, /New Employee/);
  assert.match(out, /Two replacements for the Lahore support desk\./);
  assert.match(out, /Tagged approvers \(2\)/);
  assert.match(out, /✓ Acknowledged 2026-09-30 10:15/);
  assert.match(out, /⏳ Awaiting ack/);
  assert.match(out, /1 of 2 pending acknowledgement/);
});

test('W6-04 the soft gate says the PR KEEPS MOVING (F4: a message, not a gate)', () => {
  const pending = text(h(PurposeAckWidget, {
    data: {
      purpose_type: 'BACKUP', summary: null,
      approvers: [{ name: 'A', email: 'a@x.pk', role: 'cfo', acknowledged: false, acknowledged_at: null }],
      total: 1, pending: 1,
    },
  }));
  assert.match(pending, /Soft gate:/);
  assert.match(pending, /PR keeps moving/);
  // The deep link shows the token PLACEHOLDER, not a real bearer token. The
  // text() helper decodes entities, so the escaped JSX literal arrives as this.
  assert.match(pending, /#ack=<token>/);
  assert.ok(!/[0-9a-f]{32,}/i.test(pending), 'no real acknowledgement token is ever rendered');

  const done = text(h(PurposeAckWidget, {
    data: { purpose_type: 'BACKUP', summary: null, approvers: [], total: 3, pending: 0 },
  }));
  assert.match(done, /All acknowledgements complete\./);
  assert.match(done, /All 3 acknowledgers done/);
  assert.ok(!done.includes('Soft gate'), 'a completed pack must not show the soft-gate warning');
});

test('W6-05 zero tagged approvers says so rather than rendering an empty table', () => {
  const out = text(h(PurposeAckWidget, {
    data: { purpose_type: 'NEW_PROJECT', summary: null, approvers: [], total: 0, pending: 0 },
  }));
  assert.match(out, /No approvers tagged/);
});

// ── ImageGalleryCard — prototype imageGalleryCard (line 9763) ─────────────

test('W6-06 the empty gallery uses the prototype viewer copy verbatim', () => {
  const out = text(h(ImageGalleryCard, { images: [] }));
  assert.match(out, /Reference pictures/);
  assert.match(out, /No reference pictures were attached to this purchase request\./);
  assert.match(out, /0 pictures/);
  assert.match(out, /0 KB/);
});

test('W6-07 the populated gallery keeps the prototype viewer copy and lists each image', () => {
  const out = text(h(ImageGalleryCard, {
    images: [
      { id: 'i1', line_id: 'l1', caption: 'Damaged corner', mime_type: 'image/png', size_bytes: 204800, sort_order: 0, uploaded_at: '2026-09-30T09:00:00Z' },
      { id: 'i2', line_id: 'l1', caption: null, mime_type: null, size_bytes: 0, sort_order: 1, uploaded_at: null },
    ],
  }));
  assert.match(out, /Reference pictures uploaded by the requester\. Click a thumbnail to enlarge\./);
  assert.match(out, /2 pictures/);
  assert.match(out, /Damaged corner/);
  assert.match(out, /image\/png/);
  assert.match(out, /200 KB/);
  // A captionless image falls back rather than rendering an empty box.
  assert.match(out, /Reference picture/);
  // A null mime_type is an em-dash, never "undefined" or "null".
  assert.ok(!out.includes('undefined'), 'no undefined leaked into the gallery');
  assert.ok(!/>\s*null\s*</.test(out), 'no null leaked into the gallery');
});

// ── McVoteTable — prototype renderMCVote table (line 7876) ────────────────

test('W6-08 the vote table renders the tally and each member state from the real mcTally', () => {
  const panel = [
    { user_id: 'u1', name: 'Dr. Imran Shah', email: 'imran.shah@pakboxes.pk', seat: 1, chair: true, vote: 'approve' as const, note: '', reason: null },
    { user_id: 'u2', name: 'Tariq Saleem', email: 'tariq.saleem@pakboxes.pk', seat: 2, chair: false, vote: 'reject' as const, note: '', reason: 'warranty below floor' },
    { user_id: 'u3', name: 'Naila Aziz', email: 'naila.aziz@pakboxes.pk', seat: 3, chair: false, vote: null, note: '', reason: null },
  ];
  // Votes keyed by voter, exactly as the service holds them. The tally text is
  // `cast/panel`, so a partial round reads 2/5 — never a hardcoded 5/5.
  const tally = mcTally({ u1: 'approve', u2: 'reject', u3: null } as any, MC_PANEL_SIZE);
  assert.equal(tally.text, '2/5', 'the tally counts CAST votes, not approves');
  assert.equal(tally.approves, 1);
  assert.equal(tally.rejects, 1);

  const out = text(h(McVoteTable, { panel, tally: { text: tally.text, approves: tally.approves, rejects: tally.rejects } }));

  assert.match(out, /Members & votes/);
  assert.match(out, /2\/5/, 'the header chip is the real tally, not a hardcoded 5/5');
  assert.match(out, /Dr\. Imran Shah/);
  assert.match(out, /Chair/);
  assert.match(out, /Tariq Saleem/);
  assert.match(out, /Reject/);
  assert.match(out, /Pending/);
  // A reject reason is evidence — it is shown, quoted.
  assert.match(out, /“warranty below floor”/);
});

// ── PackDocuments — prototype renderPack table (line 7944) ────────────────

const SLOTS = ['pr_form', 'vendor_quotes', 'comparative_statement', 'mc_vote_record', 'cfo_approval', 'compliance_checklist'] as const;

/** Valid 64-char hex, distinct per slot so a mis-mapped row is visible. */
const hexFor = (i: number) => `sha256:${i.toString(16).repeat(64).slice(0, 64)}`;
const allDigests = () => Object.fromEntries(SLOTS.map((s, i) => [s, hexFor(i)]));

const GATES_RAN = { mcApprovedAt: '2026-09-30T10:00:00Z', cfoApprovedAt: '2026-09-30T11:00:00Z' };

test('W6-09 a STANDARD pack renders six present documents with real digests', () => {
  const docs = packDocuments({ routingKey: 'STANDARD', digests: allDigests(), ...GATES_RAN });
  const out = text(h(PackDocuments, { documents: toPackDocs(docs) }));

  assert.match(out, /Pack documents \(6\)/);
  assert.match(out, /6 hashed/);
  // The prototype's six names, in order, unmodified.
  for (const name of PACK_DOCUMENT_NAMES) {
    assert.ok(out.includes(name), `the prototype document name "${name}" is rendered`);
  }
  // The prototype's display format: 8 hex chars + a single-character ellipsis.
  for (const d of docs) {
    const shown = text(h(PackDocuments, { documents: toPackDocs([d]) }));
    assert.match(shown, /[0-9a-f]{8}…/, `${d.name} must render 8 hex chars + ellipsis`);
    assert.equal(formatDigest(d.sha256).length, 9, 'formatDigest returns 8 chars + the ellipsis');
  }
  assertNoPlaceholders('the STANDARD pack', h(PackDocuments, { documents: toPackDocs(docs) }));
});

test('W6-10 F2: a FAST_TRACK pack shows only what exists, and says why the rest is empty', () => {
  const docs = packDocuments({ routingKey: 'FAST_TRACK', digests: {} });
  const out = text(h(PackDocuments, { documents: toPackDocs(docs) }));
  const raw = markup(h(PackDocuments, { documents: toPackDocs(docs) }));

  assert.match(out, /Pack documents \(6\)/);
  // FAST_TRACK skips the MC and CFO gates, so exactly those two documents are
  // "skipped"; the other four simply have no digest recorded.
  assert.equal(docs.filter(d => d.state === 'skipped').length, 2);
  assert.match(out, /Skipped \(FAST_TRACK\)/, 'the gate-skip note survives to the screen');
  assert.match(out, /No digest recorded/, 'a document with no digest says so');
  assert.ok(!out.includes('Gate not reached'), 'FAST_TRACK reports the skip reason, not a missing gate');

  // The critical part: a skipped document renders an em-dash, never a hash.
  const mcRow = raw.split('<tr>').find(r => r.includes('MC vote record'))!;
  assert.ok(mcRow, 'the MC vote record row is present');
  assert.ok(!/[0-9a-f]{8}…/.test(mcRow), 'a skipped document must NOT show a hash');
  assert.match(mcRow, /—/, 'a skipped document shows an em-dash');
  assert.ok(!mcRow.includes('sha256'), 'no digest is implied for a skipped document');
  // And no tick, because nothing was signed.
  assert.ok(!mcRow.includes('class="pill approved"'), 'a skipped document is not ticked as signed');
});

test('W6-11 a gate that never ran is reported as a skip, distinct from a missing digest', () => {
  // Digests exist for all six, but the MC/CFO approvals were never recorded, so
  // those two documents cannot exist either.
  const docs = packDocuments({ routingKey: 'STANDARD', digests: allDigests() });
  const out = text(h(PackDocuments, { documents: toPackDocs(docs) }));
  assert.match(out, /Gate not reached/, 'an unrun gate says so in words');
  assert.equal(docs.filter(d => d.state === 'skipped').length, 2);
  assert.equal(docs.filter(d => d.state === 'present').length, 4);
});

test('W6-12 a missing digest is a gap, never substituted, and is not counted as hashed', () => {
  const digests = { ...allDigests(), compliance_checklist: null };
  const docs = packDocuments({ routingKey: 'STANDARD', digests, ...GATES_RAN });
  const out = text(h(PackDocuments, { documents: toPackDocs(docs) }));
  const raw = markup(h(PackDocuments, { documents: toPackDocs(docs) }));

  assert.match(out, /5 hashed/, 'a missing document is not counted as hashed');
  assert.match(out, /No digest recorded/);
  const row = raw.split('<tr>').find(r => r.includes('Internal compliance checklist'))!;
  assert.ok(!/[0-9a-f]{8}…/.test(row), 'the gap does not borrow another document\'s digest');
  assert.match(row, /—/);
  assert.ok(!row.includes('class="pill approved"'), 'an unsigned gap is not ticked as signed');
});

// ── D365EventStream — prototype renderD365Status rows (line 8054) ─────────

test('W6-13 the event stream shows a relative label while pending and a timestamp once done', () => {
  const events = [
    { key: 'confirmed', ts: 'Just now', action: 'PO confirmed', detail: 'Awaiting a PO number', state: 'pending' as const, reachedAt: null },
    { key: 'paid', ts: '+7 days', action: 'Payment run', detail: 'Disbursed to vendor bank account', state: 'done' as const, reachedAt: '2026-09-30T12:00:00Z' },
  ];
  const out = text(h(D365EventStream, { events }));
  const raw = markup(h(D365EventStream, { events }));

  assert.match(out, /D365 event stream/);
  assert.match(out, /PO confirmed/);
  assert.match(out, /Payment run/);
  assert.match(out, /Disbursed to vendor bank account/);

  // A pending row keeps its relative label; a done row is stamped with when it
  // actually happened. Neither shows the other's value.
  assert.match(out, /Just now/, 'the pending row keeps the relative label');
  assert.match(out, /2026-09-30 12:00/, 'the done row shows when it was reached');
  assert.ok(!out.includes('+7 days'), 'a reached row does not keep its relative label');

  // The dot colour encodes state — the prototype's only progress cue.
  assert.equal((raw.match(/var\(--success\)/g) || []).length, 1, 'exactly one green dot');
  assert.equal((raw.match(/var\(--line\)/g) || []).length, 1, 'exactly one grey dot');
});

test('W6-14 the stream renders six rows for the six-step ladder, all pending before any push', () => {
  const events = ['confirmed', 'reserved', 'grn', 'invoice', 'match', 'paid'].map(key => ({
    key, ts: '+1', action: key, detail: 'detail', state: 'pending' as const, reachedAt: null,
  }));
  const out = text(h(D365EventStream, { events }));
  const raw = markup(h(D365EventStream, { events }));
  assert.equal((raw.match(/class="event-row"/g) || []).length, 6);
  // No timer: nothing is green until a sync is actually observed.
  assert.equal((raw.match(/var\(--success\)/g) || []).length, 0);
  assert.ok(!out.includes('undefined'));
});

// ── CfoSummaryGrid — prototype renderCFO kv block (line 7901) ─────────────

test('W6-15 F1: an underivable value is an em-dash with a tooltip, never a plausible number', () => {
  const rows = [
    { key: 'split', label: 'Expense split', value: 'OPEX' },
    { key: 'total', label: 'Awarded total', value: 'PKR 1,234,567' },
    { key: 'risk', label: 'Risk class', value: '—', unknown: true },
  ];
  const out = text(h(CfoSummaryGrid, { rows }));
  const raw = markup(h(CfoSummaryGrid, { rows }));

  assert.match(out, /Pack summary/);
  assert.match(out, /Expense split/);
  assert.match(out, /OPEX/);
  assert.match(raw, /This value could not be derived from the record\./,
    'the em-dash explains itself on hover');
  assert.ok(!/N\/A|TBD|Unknown/i.test(out), 'an unknown value is never a made-up substitute');
  // Only the unknown row carries the explanatory tooltip.
  assert.equal((raw.match(/This value could not be derived/g) || []).length, 1);
});

// ── cross-screen invariants ───────────────────────────────────────────────

test('W6-16 every governance card renders, and none leaks a prototype placeholder', () => {
  const screens: [string, React.ReactElement][] = [
    ['PurposeAckWidget', h(PurposeAckWidget, { data: { purpose_type: 'EXISTING_EMPLOYEE', summary: 'Laptops for the field team.', approvers: [], total: 0, pending: 0 } })],
    ['ImageGalleryCard', h(ImageGalleryCard, { images: [] })],
    ['McVoteTable', h(McVoteTable, { panel: [], tally: { text: '0/5', approves: 0, rejects: 0 } })],
    ['PackDocuments', h(PackDocuments, { documents: toPackDocs(packDocuments({ routingKey: 'STANDARD', digests: {} })) })],
    ['D365EventStream', h(D365EventStream, { events: [] })],
    ['CfoSummaryGrid', h(CfoSummaryGrid, { rows: [] })],
  ];
  for (const [label, node] of screens) {
    assertNoPlaceholders(label, node);
    assert.ok(renderToStaticMarkup(node).length > 0, `${label} must render something`);
    assert.ok(!text(node).includes('undefined'), `${label} must not render "undefined"`);
  }
});

test('W6-17 the card chrome matches the prototype, including its two exceptions', () => {
  // The prototype wraps body content in .card-b for the widget cards...
  const withBody: [string, React.ReactElement][] = [
    ['PurposeAckWidget', h(PurposeAckWidget, { data: { purpose_type: 'EXISTING_EMPLOYEE', summary: null, approvers: [], total: 0, pending: 0 } })],
    ['ImageGalleryCard', h(ImageGalleryCard, { images: [] })],
    ['D365EventStream', h(D365EventStream, { events: [] })],
    ['CfoSummaryGrid', h(CfoSummaryGrid, { rows: [] })],
  ];
  for (const [label, node] of withBody) {
    const raw = markup(node);
    assert.match(raw, /class="card/, `${label} uses .card`);
    assert.match(raw, /class="card-h"/, `${label} uses .card-h`);
    assert.match(raw, /class="card-b"/, `${label} uses .card-b`);
  }

  // ...but puts the table DIRECTLY under .card for the two table cards
  // (prototype lines 7876 and 7944-7947). Adding a .card-b there would be a
  // redesign, not a port.
  for (const [label, node] of [
    ['McVoteTable', h(McVoteTable, { panel: [], tally: { text: '0/5', approves: 0, rejects: 0 } })],
    ['PackDocuments', h(PackDocuments, { documents: [] })],
  ] as [string, React.ReactElement][]) {
    const raw = markup(node);
    assert.match(raw, /class="card/, `${label} uses .card`);
    assert.match(raw, /class="card-h"/, `${label} uses .card-h`);
    assert.ok(!raw.includes('card-b'), `${label} has no .card-b — the prototype has none either`);
    assert.match(raw, /<table class="t">/, `${label} puts the table straight under the header`);
  }
});
