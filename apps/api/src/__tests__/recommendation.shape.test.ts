// The SINGLE/SPLIT rule, and the shape each answer must produce.
//
// WHY THIS FILE IS THE POINT OF THE CHANGE
// ----------------------------------------
// Two locks decided the shape of a comparative statement's recommendation and
// they disagreed. `cs.service.ts` reasoned from the matrix winner and wrote
// SINGLE. `award.sync.ts` wrote SPLIT — unconditionally, without ever looking at
// how many vendors had won. So PR-2026-202043 stored "a split award across
// 1 vendor(s) and 1 line(s)".
//
// That is not a label. A SPLIT carries no `winner_vendor_id` and none of the
// `winner_*` keys, and the D365 push reads exactly those to build a PO's
// TotalAmount. With them absent the push falls back to the REQUEST'S OWN
// ESTIMATE — a budget handed to the ERP as a commitment.
//
// The rule now lives in one place:
//
//     SINGLE  iff  exactly one vendor won
//            AND  that vendor's quotation covers EXACTLY the awarded lines
//
// The second clause is the one worth testing hard. `winner_total` is the whole
// quotation, not the awarded part of it, so a SINGLE on a partial quotation
// would push a TotalAmount inflated by lines nobody awarded.
//
// NO DATABASE. The builder takes a transaction `run`, so these tests hand it a
// fake that answers only the two questions it asks: the vendors' roster states,
// and the single vendor's live quotation with the line set it carries. That is
// also why the builder is a leaf module — it can be reasoned about without a
// container, a schema, or a fixture.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAwardRecommendation, type Run } from '../sourcing/recommendation.shape';
import { pgArray, pgIntArray } from '../db/pg-array';

const VENDOR_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const VENDOR_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const CS_ID = 'cccccccc-0000-0000-0000-000000000003';
const QUOTE_ID = 'dddddddd-0000-0000-0000-000000000004';

type Fake = {
  /** Roster state per vendor. Anything not listed is treated as not-on-roster. */
  states?: Record<string, string>;
  /** The winning vendor's quotation, or null for "no live quotation". */
  quote?: {
    id?: string;
    total_amount?: number | null;
    currency?: string | null;
    lead_time_days?: number | null;
    version?: number | null;
    /** The rfq_line_no values the quotation carries. */
    lines: number[];
  } | null;
};

/**
 * An integer list as `psql --csv` renders an `array_agg`: the Postgres literal.
 *
 * Null means "the aggregate matched no rows", which the bridge reports as SQL
 * NULL rather than as `{}`.
 */
function csvArray(values: number[] | null | undefined): string | null {
  if (values === null || values === undefined) return null;
  return `{${values.join(',')}}`;
}

/**
 * A `run` that answers exactly what the builder asks and records the order it
 * asked in — the ordering assertion below depends on seeing the sequence.
 */
function fake(f: Fake) {
  const asked: string[] = [];
  // Cast rather than annotate: each branch below answers a different question and
  // therefore returns a differently-shaped row set, which TypeScript will not
  // reconcile into one union for a bare `const run: Run = ...`.
  const run = (async (sql: string, params?: any[]) => {
    if (sql.includes('FROM core.vendors')) {
      const ids: string[] = params?.[0] ?? [];
      asked.push('vendors');
      return {
        rows: ids.map((id) => ({ id, state: f.states?.[id] ?? 'Prospect' })),
        rowCount: ids.length,
      };
    }
    if (sql.includes('FROM proc.quotations')) {
      asked.push('quote');
      const vendorId: string = params?.[1];
      // Only the sole vendor's quotation is ever requested — the builder must
      // not look one up when there is more than one winner.
      if (f.quote === null || f.quote === undefined) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          id: f.quote.id ?? QUOTE_ID,
          total_amount: f.quote.total_amount ?? 139.73,
          currency: f.quote.currency ?? 'PKR',
          lead_time_days: f.quote.lead_time_days ?? 16,
          version: f.quote.version ?? 1,
          // THE SHAPE THE DRIVER ACTUALLY HANDS BACK, NOT THE SHAPE WE WISHED FOR.
          //
          // This used to be `f.quote.lines` — a real array — and the whole suite
          // was green while the CS confirm returned HTTP 500 on a real request:
          // "row.quoted_lines.map is not a function". `DbService` shells out to
          // `psql --csv`, so an `array_agg` arrives as the literal STRING
          // `'{1,2}'`. `?? []` cannot save that, because a non-empty string is
          // truthy and the default never fires.
          //
          // A fake that returns the tidier shape is worse than no fake: it
          // certifies code against a database that does not exist.
          quoted_lines: csvArray(f.quote.lines),
        }],
        rowCount: 1,
      };
    }
    throw new Error(`the builder asked a question this fake does not answer:\n${sql}`);
  }) as Run;
  return { run, asked };
}

const line = (line_no: number, vendor_id: string) => ({
  line_no,
  vendor_id,
  vendor_name: vendor_id === VENDOR_A ? 'Acme Supplies' : 'BoxCo Packaging',
  vendor_code: vendor_id === VENDOR_A ? 'V-00081' : 'V-00082',
  awarded_qty: 1,
  justification: 'lowest unit price',
  award_round: 1,
});

// ── the rule ───────────────────────────────────────────────────────────────

test('R1 one vendor, and its quotation covers exactly the award → SINGLE', async () => {
  // The Case 18 shape: one line, one vendor, one line on their quotation.
  const { run } = fake({ states: { [VENDOR_A]: 'Active' }, quote: { lines: [1] } });
  const d = await buildAwardRecommendation(run, {
    csId: CS_ID,
    lineAwards: [line(1, VENDOR_A)],
    rfqLineNos: [1],
    reason: 'confirmed',
    routingKey: 'STANDARD',
    lockedVia: 'cs_review_confirm',
  });

  assert.equal(d.awardMode, 'SINGLE');
  assert.equal(d.winnerVendorId, VENDOR_A);
  assert.equal(d.recommendation.award_mode, 'SINGLE');
  assert.equal(d.recommendation.winner_vendor_id, VENDOR_A);
  // THE KEY THE D365 PUSH READS FOR A PO's TotalAmount.
  assert.equal(d.recommendation.winner_quotation_id, QUOTE_ID);
  assert.equal(d.recommendation.winner_total, 139.73);
  assert.equal(d.recommendation.winner_currency, 'PKR');
  assert.equal(d.recommendation.winner_is_new_vendor, false);
});

test('R2 a SINGLE must NOT carry a split key', async () => {
  // Not tidiness — `rfq.service.ts` reads:
  //     const split = Array.isArray(rec?.split) && rec.split.length > 0 ? ... : null
  //     if (split) return { vendor_id: null, ..., split };
  //     if (!rec.winner_vendor_id) return null;
  // so a SINGLE carrying `split` is read as a SPLIT WITH NO WINNER and the whole
  // change silently does nothing. This is the assertion that stops that.
  const { run } = fake({ quote: { lines: [1] } });
  const d = await buildAwardRecommendation(run, {
    csId: CS_ID,
    lineAwards: [line(1, VENDOR_A)],
    rfqLineNos: [1],
  });

  assert.equal(d.awardMode, 'SINGLE');
  assert.ok(!('split' in d.recommendation), 'a SINGLE must have no `split` key at all');
  assert.ok(!('split_vendor_count' in d.recommendation));
  assert.ok(!('split_line_count' in d.recommendation));
});

test('R3 two vendors, even across two lines → SPLIT', async () => {
  const { run } = fake({ quote: { lines: [1, 2] } });
  const d = await buildAwardRecommendation(run, {
    csId: CS_ID,
    lineAwards: [line(1, VENDOR_A), line(2, VENDOR_B)],
    rfqLineNos: [1, 2],
  });

  assert.equal(d.awardMode, 'SPLIT');
  assert.equal(d.winnerVendorId, null);
  assert.equal(d.winnerQuote, null);
  assert.equal(d.recommendation.award_mode, 'SPLIT');
  assert.equal(d.recommendation.split_vendor_count, 2);
  assert.equal(d.recommendation.split_line_count, 2);
  assert.ok(!('winner_vendor_id' in d.recommendation),
    'a SPLIT must claim no winner — the DB CHECK refuses one that does');
});

test('R4 ONE vendor, but their quotation covers more lines than were awarded → SPLIT', async () => {
  // The clause that protects the PO total. This vendor quoted three lines and
  // won one; `quotations.total_amount` is for all three, so a SINGLE here would
  // push a TotalAmount inflated by two lines nobody awarded them.
  const { run } = fake({ quote: { lines: [1, 2, 3] } });
  const d = await buildAwardRecommendation(run, {
    csId: CS_ID,
    lineAwards: [line(1, VENDOR_A)],
    rfqLineNos: [1, 2, 3],
  });

  assert.equal(d.awardMode, 'SPLIT',
    'a partial quotation must not be presented as the whole award');
  assert.equal(d.recommendation.award_mode, 'SPLIT');
  assert.ok(!('winner_total' in d.recommendation));
});

test('R5 ONE vendor, quotation missing an awarded line → SPLIT', async () => {
  // The mirror of R4. Under-pricing is as wrong as over-pricing.
  const { run } = fake({ quote: { lines: [1] } });
  const d = await buildAwardRecommendation(run, {
    csId: CS_ID,
    lineAwards: [line(1, VENDOR_A), line(2, VENDOR_A)],
    rfqLineNos: [1, 2],
  });

  assert.equal(d.awardMode, 'SPLIT');
});

test('R6 one vendor winning every line of a multi-line RFQ → SINGLE', async () => {
  // R1 generalised: the "covers exactly" test is about the LINE SETS matching,
  // not about there being only one line.
  const { run } = fake({ quote: { lines: [1, 2, 3] } });
  const d = await buildAwardRecommendation(run, {
    csId: CS_ID,
    lineAwards: [line(1, VENDOR_A), line(2, VENDOR_A), line(3, VENDOR_A)],
    rfqLineNos: [1, 2, 3],
  });

  assert.equal(d.awardMode, 'SINGLE');
  assert.equal(d.recommendation.winner_vendor_id, VENDOR_A);
});

test('R7 a sole vendor with NO live quotation → SPLIT, never a bare winner', async () => {
  // Without a quotation there is no total to commit, and a SINGLE that carried a
  // null winner_quotation_id would put the push back on the estimate — the exact
  // failure this change exists to remove. The array is the honest answer.
  const { run } = fake({ quote: null });
  const d = await buildAwardRecommendation(run, {
    csId: CS_ID,
    lineAwards: [line(1, VENDOR_A)],
    rfqLineNos: [1],
  });

  assert.equal(d.awardMode, 'SPLIT');
  assert.equal(d.recommendation.winner_vendor_id, undefined);
});

// ── the things that must not break ─────────────────────────────────────────

test('R8 a statement with no award is refused, not locked as something', async () => {
  const { run } = fake({});
  await assert.rejects(
    () => buildAwardRecommendation(run, { csId: CS_ID, lineAwards: [], rfqLineNos: [1] }),
    /no live award/i,
  );
});

test('R9 the winning quotation is looked up ONCE, and only when there is one vendor', async () => {
  // Ordering matters: the caller flips the winners' quotations to 'Awarded' right
  // after this returns, so a lookup that ran later would see a different table.
  const one = fake({ quote: { lines: [1] } });
  await buildAwardRecommendation(one.run, {
    csId: CS_ID, lineAwards: [line(1, VENDOR_A)], rfqLineNos: [1],
  });
  assert.deepEqual(one.asked, ['vendors', 'quote']);
  assert.equal(one.asked.filter((a) => a === 'quote').length, 1);

  const two = fake({ quote: { lines: [1, 2] } });
  await buildAwardRecommendation(two.run, {
    csId: CS_ID, lineAwards: [line(1, VENDOR_A), line(2, VENDOR_B)], rfqLineNos: [1, 2],
  });
  assert.ok(!two.asked.includes('quote'),
    'with more than one winner there is no single quotation to find');
});

test('R10 a vendor off the roster is flagged on both shapes', async () => {
  const established = fake({ states: { [VENDOR_A]: 'Approved' }, quote: { lines: [1] } });
  const single = await buildAwardRecommendation(established.run, {
    csId: CS_ID, lineAwards: [line(1, VENDOR_A)], rfqLineNos: [1],
  });
  assert.equal(single.recommendation.winner_is_new_vendor, false);

  const prospect = fake({ states: { [VENDOR_B]: 'Prospect' }, quote: { lines: [1] } });
  const risky = await buildAwardRecommendation(prospect.run, {
    csId: CS_ID, lineAwards: [line(1, VENDOR_B)], rfqLineNos: [1],
  });
  assert.equal(risky.recommendation.winner_is_new_vendor, true,
    'a Q3 risk the reviewer must be able to see on the statement');

  const splitRisk = fake({ states: { [VENDOR_A]: 'Active', [VENDOR_B]: 'Prospect' } });
  const split = await buildAwardRecommendation(splitRisk.run, {
    csId: CS_ID, lineAwards: [line(1, VENDOR_A), line(2, VENDOR_B)], rfqLineNos: [1, 2],
  });
  assert.equal(split.recommendation.winner_is_new_vendor, true,
    'one new vendor anywhere in a split is still a new vendor');
});

test('R11 the matrix-winner route still produces a SINGLE', async () => {
  // The legacy lock's own path: no line awards, one vendor chosen on the matrix,
  // covering every line. It must not regress to SPLIT.
  const { run } = fake({ states: { [VENDOR_A]: 'Active' }, quote: { lines: [1, 2] } });
  const d = await buildAwardRecommendation(run, {
    csId: CS_ID,
    lineAwards: [],
    matrixWinner: { vendor_id: VENDOR_A, legal_name: 'Acme Supplies' },
    rfqLineNos: [1, 2],
    overrodeRank: null,
    routingKey: 'STANDARD',
  });

  assert.equal(d.awardMode, 'SINGLE');
  assert.equal(d.recommendation.winner_vendor_id, VENDOR_A);
  assert.equal(d.vendors.length, 1);
  assert.deepEqual(d.lines, [1, 2]);
});

test('R12 provenance and reason survive into the recommendation', async () => {
  // `locked_via` is how a decision is traced back to the door that made it.
  const { run } = fake({ quote: { lines: [1] } });
  const d = await buildAwardRecommendation(run, {
    csId: CS_ID,
    lineAwards: [line(1, VENDOR_A)],
    rfqLineNos: [1],
    reason: 'Confirmed through the CS review chain',
    overrideReason: null,
    routingKey: 'FAST_TRACK',
    lockedVia: 'cs_review_confirm',
  });

  assert.equal(d.recommendation.locked_via, 'cs_review_confirm');
  assert.equal(d.recommendation.reason, 'Confirmed through the CS review chain');
  assert.equal(d.recommendation.routing_key, 'FAST_TRACK');
});

// ── the driver's real shape ─────────────────────────────────────────────────

test('R13 quoted_lines arrives as the Postgres literal, not as an array', async () => {
  // The 500 on the CS confirm, on PR-2026-202228 / CS-2026-200743:
  //
  //   HTTP 500: (row.quoted_lines ?? []).map is not a function
  //
  // `DbService` shells out to `psql --csv`, which returns every column as text,
  // so `array_agg(ql.rfq_line_no)` came back as the string `'{1,2}'`. The `?? []`
  // cannot rescue it: a non-empty string is truthy, so the default never runs
  // and `.map` is called on a string.
  //
  // R1–R12 all passed against the live database's exact behaviour before this,
  // because the FAKE returned a real array. The fake is the thing that has to
  // match the driver, so it now returns the literal — and this test states the
  // shape outright so a future tidy-up cannot quietly restore the pretty one.
  const { run } = fake({ states: { [VENDOR_A]: 'Active' }, quote: { lines: [1, 2] } });
  const asked = await run(
    `SELECT 1 FROM proc.quotations q WHERE q.id = $1::uuid`,
    [QUOTE_ID],
  );
  assert.ok(asked, 'the fake must answer the quotation lookup');

  const d = await buildAwardRecommendation(run, {
    csId: CS_ID,
    lineAwards: [line(1, VENDOR_A), line(2, VENDOR_A)],
    rfqLineNos: [1, 2],
  });

  // Two quoted lines, both awarded: SINGLE. If the literal were not parsed, this
  // would have thrown before reaching an assertion.
  assert.equal(d.awardMode, 'SINGLE');
  assert.equal(d.winnerVendorId, VENDOR_A);
});

test('R14 the literal parse is the bridge owner, not a rule in the caller', async () => {
  // Pin the parse itself, because the four copies this replaced each had a
  // slightly different shape — and one of them (`quotation.service.ts`) turned
  // `'{}'` into `[0]`, a phantom line zero.
  assert.deepEqual(pgIntArray('{1,2}'), [1, 2]);
  assert.deepEqual(pgIntArray('{}'), [], 'an empty array is empty, not [0]');
  assert.deepEqual(pgIntArray(null), []);
  assert.deepEqual(pgIntArray([3, 4]), [3, 4], 'a driver that DID parse it still works');
  assert.deepEqual(pgIntArray('{1,NULL,3}'), [1, 3], 'NULL is not line 0');
  assert.deepEqual(pgArray('{IT_HARDWARE,"a,b",""}'), ['IT_HARDWARE', 'a,b', '']);
});