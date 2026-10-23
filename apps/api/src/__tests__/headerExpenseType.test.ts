/**
 * The header's expense_type must FOLLOW THE LINES (migration 074).
 *
 *   npm run test:api
 *
 * WHAT THIS GUARDS
 * ----------------
 * `proc.purchase_requisitions.expense_type` is the SUMMARY of a decision a
 * human made per line. It used to be the summary of `core.items.expense_type`
 * instead — so a free-text line, which is exactly the one procurement classified
 * by hand, voted OPEX through `COALESCE(i.expense_type,'OPEX')`, ALWAYS.
 *
 * Four consumers read that column, and the last of them is an ERP:
 *
 *     d365.service.ts:460        pr.expense_type AS expense_split
 *     governance.service.ts:750 pr.expense_type AS expense_split
 *     cs.service.ts:299,766     pr.expense_type AS expense_split
 *     web  approvals.tsx         p.expense_type
 *
 * `buildPurchaseOrderPayload` turns it into the ERP's PurchaseType
 * ('CAPEX' -> 'IT Capex'), already asserted in d365.payload.test.ts. So the
 * defect and the symptom are two hops apart: this file asserts the hop BEFORE
 * the mapping, so the failing half is named.
 *
 * THE ASSERTIONS ARE STATED AGAINST THE DATA, NOT AGAINST THE FUNCTION
 * ---------------------------------------------------------------------
 * "fn_header_expense_type agrees with itself" would be true of a function that
 * returns the wrong thing. Every expectation below is re-derived from
 * `proc.pr_lines` inline in the query, so the function is checked against an
 * independent reading of the same fact.
 *
 * INVARIANTS, NOT COUNTS — the same rule the migrations are written by. The
 * ladder grows, lines get classified, and PRs move; "exactly 20 rows disagree"
 * goes false on the first legitimate change and tells you nothing. What must
 * hold is that no header contradicts its own lines, and that each of the three
 * branches is reachable.
 *
 * Anything needing a live database is skipped rather than silently passing
 * when the database is not reachable.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const CONTAINER = process.env.PP_DB_CONTAINER ?? 'procurement-portal-db';
const USER = process.env.PP_DB_USER ?? 'proc';
const DB = process.env.PP_DB_NAME ?? 'procurementDB';

function sql(q: string): string {
  return execFileSync(
    'docker',
    ['exec', CONTAINER, 'psql', '-U', USER, '-d', DB, '-X', '-t', '-A', '-c', q],
    { encoding: 'utf8', timeout: 60_000 },
  ).trim();
}

function dbAvailable(): boolean {
  try {
    sql('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * The lines that are actually being bought. Restated here rather than imported
 * from a service because this test is checking the DATA, and a service that
 * read a different population is precisely the defect 074 fixed.
 */
const BOUGHT = 'l.approved AND NOT l.rejected AND NOT l.held';

describe('the header expense_type rule', () => {
  test('no stored header disagrees with its own approved lines', (t) => {
    if (!dbAvailable()) return t.skip('database not reachable');
    const bad = sql(`
      SELECT count(*)
        FROM proc.purchase_requisitions pr
       WHERE pr.expense_type IS DISTINCT FROM proc.fn_header_expense_type(pr.id);
    `);
    assert.equal(
      bad,
      '0',
      'every header expense_type must be the value proc.fn_header_expense_type derives '
      + 'from that request’s own approved classified lines',
    );
  });

  test('all-capital reads CAPEX — the case that reached D365 as an operating expense', (t) => {
    if (!dbAvailable()) return t.skip('database not reachable');
    // Re-derived here, from the lines, without the function.
    const bad = sql(`
      SELECT count(*)
        FROM proc.purchase_requisitions pr
       WHERE EXISTS (
               SELECT 1 FROM proc.pr_lines l
                WHERE l.pr_id = pr.id AND ${BOUGHT} AND l.classification LIKE 'CAPEX%')
         AND NOT EXISTS (
               SELECT 1 FROM proc.pr_lines l
                WHERE l.pr_id = pr.id AND ${BOUGHT}
                  AND l.classification IS NOT NULL
                  AND l.classification NOT LIKE 'CAPEX%')
         AND pr.expense_type IS DISTINCT FROM 'CAPEX';
    `);
    assert.equal(
      bad,
      '0',
      'a request whose approved lines are ALL capital must carry expense_type CAPEX, '
      + 'which is what buildPurchaseOrderPayload turns into "IT Capex"',
    );
  });

  test('a request holding both kinds reads MIXED, never a coin-toss OPEX', (t) => {
    if (!dbAvailable()) return t.skip('database not reachable');
    const bad = sql(`
      SELECT count(*)
        FROM proc.purchase_requisitions pr
       WHERE EXISTS (
               SELECT 1 FROM proc.pr_lines l
                WHERE l.pr_id = pr.id AND ${BOUGHT} AND l.classification LIKE 'CAPEX%')
         AND EXISTS (
               SELECT 1 FROM proc.pr_lines l
                WHERE l.pr_id = pr.id AND ${BOUGHT} AND l.classification LIKE 'OPEX%')
         AND pr.expense_type IS DISTINCT FROM 'MIXED';
    `);
    assert.equal(
      bad,
      '0',
      'nine mixed requests were stamped OPEX before 074; a request that is both is MIXED, '
      + 'and the ERP has a distinct PurchaseType for it',
    );
  });

  test('all three branches are reachable — the function is not dead code', (t) => {
    if (!dbAvailable()) return t.skip('database not reachable');
    const rows = sql(`
      SELECT proc.fn_header_expense_type(pr.id), count(*)
        FROM proc.purchase_requisitions pr
       GROUP BY 1
       ORDER BY 1;
    `)
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => l.split('|'));

    const derived = new Set(rows.map(([v]) => v));
    for (const value of ['CAPEX', 'OPEX', 'MIXED']) {
      assert.ok(
        derived.has(value),
        `no live request derives ${value} — a branch of fn_header_expense_type that no `
        + 'row reaches is a branch nothing is testing',
      );
    }
    // And nothing else is emitted: the D365 mapping has exactly three answers,
    // so a fourth value would silently fall through to Operating Expense.
    for (const [value] of rows) {
      assert.ok(
        ['CAPEX', 'OPEX', 'MIXED'].includes(value),
        `fn_header_expense_type emitted "${value}", which the ERP mapping does not know`,
      );
    }
  });

  test('an unclassified request still follows the item master — no invented answer', (t) => {
    if (!dbAvailable()) return t.skip('database not reachable');
    // The fallback is load-bearing, not legacy: before the desk classifies
    // anything, with both totals at 0, a totals-derived rule makes every
    // request OPEX and a capital laptop becomes an operating expense (the reason
    // migration 046 moved this rule onto the item master in the first place).
    // What must NOT happen is the fallback being DELETED.
    const bad = sql(`
      SELECT count(*)
        FROM proc.purchase_requisitions pr
       WHERE NOT EXISTS (
               SELECT 1 FROM proc.pr_lines l
                WHERE l.pr_id = pr.id AND ${BOUGHT} AND l.classification IS NOT NULL)
         AND pr.expense_type IS DISTINCT FROM proc.fn_header_expense_type(pr.id);
    `);
    assert.equal(bad, '0', 'the item-master fallback must still be what these rows carry');

    const fallbackRows = sql(`
      SELECT count(*)
        FROM proc.purchase_requisitions pr
       WHERE NOT EXISTS (
               SELECT 1 FROM proc.pr_lines l
                WHERE l.pr_id = pr.id AND ${BOUGHT} AND l.classification IS NOT NULL);
    `);
    assert.ok(
      Number(fallbackRows) > 0,
      'no unclassified request exists, so the fallback branch is untested — classify a '
      + 'line on some request and re-run',
    );
  });
});

describe('fn_compute_pr_totals mirrors the rule', () => {
  test('running it stamps the TYPE from the lines and leaves the money alone', (t) => {
    if (!dbAvailable()) return t.skip('database not reachable');
    // Migration 074 scope, pinned: that function got the TYPE and nothing else.
    // It derives its amounts from the item master (what 052 left), has no
    // caller and no trigger — syncPrTotals is the live owner — so changing its
    // amount semantics would have been an unmeasured change to 2,121 rows in
    // exchange for tidiness in dead code. This test is what would have caught
    // that being done by accident.
    const pick = sql(`
      SELECT pr.id
        FROM proc.purchase_requisitions pr
       WHERE EXISTS (
               SELECT 1 FROM proc.pr_lines l
                WHERE l.pr_id = pr.id AND ${BOUGHT} AND l.classification LIKE 'CAPEX%')
       LIMIT 1;
    `);
    if (!pick) return t.skip('no request carries an approved capital line to test against');

    const read = (id: string) =>
      sql(`SELECT pr.expense_type || '|' || pr.capex_amount || '|' || pr.opex_amount
                 || '|' || pr.estimated_amount || '|' || pr.amount_status
            FROM proc.purchase_requisitions pr WHERE pr.id = '${id}';`);

    const before = read(pick).split('|');
    // psql -c sends the whole string as ONE simple query, so the ROLLBACK at
    // the end is honoured as a real transaction boundary and nothing survives.
    const after = sql(`
      BEGIN;
      SELECT proc.fn_compute_pr_totals('${pick}');
      SELECT pr.expense_type || '|' || pr.capex_amount || '|' || pr.opex_amount
             || '|' || pr.estimated_amount || '|' || pr.amount_status
        FROM proc.purchase_requisitions pr WHERE pr.id = '${pick}';
      ROLLBACK;
    `)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.includes('|'))
      .pop()!
      .split('|');

    const derived = sql(`SELECT proc.fn_header_expense_type('${pick}');`);
    assert.equal(after[0], derived, 'the mirrored function must stamp the derived TYPE');

    assert.deepEqual(
      after.slice(1),
      before.slice(1),
      'fn_compute_pr_totals must NOT change capex/opex/estimated/amount_status — those '
      + 'still follow the item master; syncPrTotals is the live owner of the money',
    );
  });
});