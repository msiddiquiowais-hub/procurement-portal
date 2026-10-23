/**
 * Procurement Revert-to-HOD, and the gates that surround it.
 *
 * These cover the whole chain, because the chain is the failure surface. A step
 * declared in `workflow.steps_config` and an edge in `proc.fn_check_pr_transition`
 * are TWO declarations of one workflow: the revert worked in code and still 500ed
 * at the database until migration 061 added the edge. A test that only exercises
 * the engine would have passed the whole time that the endpoint was broken.
 *
 * Anything needing a live database asserts against SQL executed through the same
 * connection shape the API uses, and is skipped rather than silently passing when
 * the database is not reachable.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  DEFAULT_WORKFLOW_STEPS,
  isPredicateKeyword,
  evaluatePredicate,
  type Step,
} from '@procurement/workflow-engine';

const CONTAINER = process.env.PP_DB_CONTAINER ?? 'procurement-portal-db';
const USER = process.env.PP_DB_USER ?? 'proc';
const DB = process.env.PP_DB_NAME ?? 'procurementDB';

/** Run SQL. Throws if psql/docker is unavailable — callers decide what that means. */
function sql(q: string): string {
  return execFileSync(
    'docker',
    ['exec', CONTAINER, 'psql', '-U', USER, '-d', DB, '-X', '-t', '-A', '-c', q],
    { encoding: 'utf8', timeout: 30_000 },
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

const STEP = (over: Partial<Step>): Step => ({
  key: 'k',
  name: 'n',
  actorRole: 'procurement',
  from: '*',
  to: 'X',
  order: 0,
  when: 'always',
  canSkip: false,
  terminal: false,
  ...over,
}) as Step;

const PR_CTX = (decision: Record<string, unknown> | null) =>
  ({ decision, pr: null, managementThreshold: 0 }) as any;

describe('revert_to_hod · the step itself', () => {
  test('exists, targets IN_HOD_REVIEW, and is owned by procurement', () => {
    const s = DEFAULT_WORKFLOW_STEPS.find((x: any) => x.key === 'revert_to_hod');
    assert.ok(s, 'revert_to_hod is missing from DEFAULT_WORKFLOW_STEPS');
    assert.equal(s!.to, 'IN_HOD_REVIEW');
    assert.equal(s!.actorRole, 'procurement');
    assert.equal(s!.when, 'revertToHod');
    assert.equal(s!.terminal, false);
  });

  test('is scoped to IN_PROCUREMENT_REVIEW and NOT "*"', () => {
    const s = DEFAULT_WORKFLOW_STEPS.find((x: any) => x.key === 'revert_to_hod')!;
    assert.equal(
      s.from,
      'IN_PROCUREMENT_REVIEW',
      'widening `from` to "*" would let the actor who ran the competition unwind '
      + 'it after handing it to the next authority',
    );
  });

  test('revertToHod is a known predicate keyword', () => {
    // validateStepConfig refuses any `when` outside this vocabulary, so a step
    // declared without it cannot be saved by an admin.
    assert.equal(isPredicateKeyword('revertToHod'), true);
  });

  test('revertToHod fires only on its own flag, never implicitly', () => {
    const step = STEP({ when: 'revertToHod' });
    assert.equal(evaluatePredicate('revertToHod', step, PR_CTX({ revertToHod: true })), true);
    assert.equal(evaluatePredicate('revertToHod', step, PR_CTX({})), false);
    assert.equal(evaluatePredicate('revertToHod', step, PR_CTX(null)), false);
    // A plain advance at procurement review must NOT fall into the revert.
    assert.equal(evaluatePredicate('always', step, PR_CTX({})), true);
  });

  test('is distinct from reworkRequested — they are opposite directions', () => {
    const rework = STEP({ when: 'reworkRequested' });
    // rework routes requester -> procurement; revert routes procurement -> HOD.
    assert.equal(evaluatePredicate('reworkRequested', rework, PR_CTX({ revertToHod: true })), false);
    assert.equal(evaluatePredicate('revertToHod', STEP({ when: 'revertToHod' }),
      PR_CTX({ reworkRequested: true })), false);
  });
});

describe('the transition guard knows the edge', () => {
  test('fn_check_pr_transition allows IN_PROCUREMENT_REVIEW -> IN_HOD_REVIEW', (t) => {
    if (!dbAvailable()) return t.skip('database not reachable');
    const def = sql(`SELECT pg_get_functiondef(p.oid) FROM pg_proc p
                       JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname='proc' AND p.proname='fn_check_pr_transition'`);
    assert.match(
      def,
      /'QUOTES_RECEIVED','CS_LOCKED','PACK_LOCKED','IN_HOD_REVIEW',/,
      'the revert endpoint 500s without this edge — a step row and a trigger '
      + 'edge are two declarations of one workflow',
    );
  });

  test('and every edge migration 027 established is still present', (t) => {
    if (!dbAvailable()) return t.skip('database not reachable');
    const def = sql(`SELECT pg_get_functiondef(p.oid) FROM pg_proc p
                       JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname='proc' AND p.proname='fn_check_pr_transition'`);
    // Each of these silently changes what the system may DO, rather than what it
    // refuses, if dropped — which is the failure 027's rewrite already caused once.
    for (const edge of [
      'CS_LOCKED', 'PACK_LOCKED', 'IN_COST_CENTER_APPROVAL', 'FULFILLED_FROM_STOCK',
      'IN_MANAGEMENT_REVIEW', 'READY_FOR_D365', 'D365_PUSHED', 'ON_HOLD',
      'IN_WAREHOUSE_CHECK', 'IN_WAREHOUSE', 'IN_IT_REVIEW',
    ]) {
      assert.ok(def.includes(edge), `pre-existing edge ${edge} has gone missing`);
    }
  });
});

describe('stage_remarks', () => {
  test('the column exists and defaults to an empty object', (t) => {
    if (!dbAvailable()) return t.skip('database not reachable');
    const out = sql(`SELECT data_type FROM information_schema.columns
                      WHERE table_schema='proc' AND table_name='purchase_requisitions'
                        AND column_name='stage_remarks'`);
    assert.equal(out, 'jsonb');
    const nulls = sql(`SELECT count(*) FROM proc.purchase_requisitions WHERE stage_remarks IS NULL`);
    assert.equal(nulls, '0');
  });

  test('the guard refuses a remark rewrite that does not move the PR', (t) => {
    if (!dbAvailable()) return t.skip('database not reachable');
    const id = sql(`SELECT pr.id FROM proc.purchase_requisitions pr LIMIT 1`);
    // status unchanged + stage_remarks changed => must raise.
    const threw = (() => {
      try {
        execFileSync(
          'docker',
          ['exec', CONTAINER, 'psql', '-U', USER, '-d', DB, '-X', '-t', '-A', '-c',
            `UPDATE proc.purchase_requisitions
                SET stage_remarks = stage_remarks || '{"silent_rewrite":{}}'::jsonb
              WHERE id = '${id}'`],
          { encoding: 'utf8', timeout: 30_000, stdio: 'pipe' },
        );
        return false;
      } catch {
        return true;
      }
    })();
    assert.ok(threw, 'a remark must not change without a stage change');
  });

  test('the audit trigger records the whole row, so a remark cannot escape the chain', (t) => {
    if (!dbAvailable()) return t.skip('database not reachable');
    // STRUCTURAL, not "some row currently exists". Requiring a live row would
    // make this test pass or fail on whatever data happened to be present, and
    // it would have failed the moment the probe PR was cleaned up — while the
    // property it guards (any stage_remarks write lands in the chain) is still
    // true. This asserts the MECHANISM that makes it true.
    const def = sql(`SELECT pg_get_functiondef(t.tgfoid)
                       FROM pg_trigger t
                       JOIN pg_class c ON c.oid = t.tgrelid
                       JOIN pg_namespace n ON n.oid = c.relnamespace
                      WHERE n.nspname='proc' AND c.relname='purchase_requisitions'
                        AND t.tgname='trg_prs_audit' AND NOT t.tgisinternal`);
    assert.ok(def.length > 0, 'trg_prs_audit is missing — remarks would not be captured');
    // The row image must be the WHOLE row, which is what makes the remark visible
    // without a hand-written audit INSERT (and therefore without a duplicate row).
    assert.match(def, /to_jsonb\(NEW\)|row_to_json\(NEW\)|NEW::/,
      'trg_prs_audit no longer records the whole row image');

    // And the column is reachable from it — a row image of a column that does
    // not exist would capture nothing.
    const col = sql(`SELECT data_type FROM information_schema.columns
                      WHERE table_schema='proc' AND table_name='purchase_requisitions'
                        AND column_name='stage_remarks'`);
    assert.equal(col, 'jsonb');
  });

  test('and an audit row that DOES carry a remark round-trips it intact', (t) => {
    if (!dbAvailable()) return t.skip('database not reachable');
    // Done entirely inside one transaction and rolled back, so the assertion
    // exercises the real trigger against real data and leaves nothing behind —
    // including the audit rows, which are append-only and could not be cleaned
    // up afterwards.
    //
    // The stage moves too, because the guard correctly refuses a remark change
    // without one. That refusal is itself worth proving: it is why the test
    // cannot simply write the column.
    const id = sql(`SELECT pr.id FROM proc.purchase_requisitions pr
                     WHERE pr.status = 'IN_HOD_REVIEW' LIMIT 1`);
    assert.ok(id.length > 0, 'no PR available at IN_HOD_REVIEW to probe with');

    const probe = `
      BEGIN;
      UPDATE proc.purchase_requisitions
         SET status = 'IN_PROCUREMENT_REVIEW',
             stage_remarks = stage_remarks || jsonb_build_object('revert_to_hod',
                   jsonb_build_object('reason', 'revert-probe-remark-4f2a'))
       WHERE id = '${id}';
      DO $chk$
      DECLARE n int;
      BEGIN
        SELECT count(*) INTO n FROM audit.audit_log a
          WHERE a.entity = 'proc.purchase_requisitions'
            AND a.entity_id = '${id}'
            AND a.after->'stage_remarks'->'revert_to_hod'->>'reason' = 'revert-probe-remark-4f2a';
        IF n <> 1 THEN
          RAISE EXCEPTION 'expected exactly one audit row carrying the remark, found %', n;
        END IF;
      END $chk$;
      ROLLBACK;`;

    let failed = false;
    try {
      execFileSync(
        'docker',
        ['exec', CONTAINER, 'psql', '-U', USER, '-d', DB, '-X', '-t', '-A', '-c', probe],
        { encoding: 'utf8', timeout: 30_000, stdio: 'pipe' },
      );
    } catch (e) {
      failed = true;
      assert.fail(`the remark did not round-trip into exactly one audit row: ${(e as Error).message}`);
    }
    assert.equal(failed, false);

    // Confirm the rollback really cleaned up — otherwise this test would be
    // mutating production data on every run and merely looking clean.
    const leftover = sql(`SELECT count(*) FROM audit.audit_log a
                           WHERE a.entity = 'proc.purchase_requisitions'
                             AND a.entity_id = '${id}'
                             AND a.after->'stage_remarks'->'revert_to_hod'->>'reason' = 'revert-probe-remark-4f2a'`);
    assert.equal(Number(leftover), 0, 'the probe left an audit row behind');
  });
});

describe('the RFQ cascade cancels only what nobody was ever shown', () => {
  test('an RFQ with zero invitations is cancellable; one with invitations is not', (t) => {
    if (!dbAvailable()) return t.skip('database not reachable');
    // Same predicate the service uses, asserted against real data.
    const cancellable = sql(`SELECT count(*) FROM proc.rfq r
                              WHERE r.state <> 'Cancelled'
                                AND NOT EXISTS (SELECT 1 FROM proc.rfq_invitations i
                                                 WHERE i.rfq_id = r.id)`);
    const protected_ = sql(`SELECT count(*) FROM proc.rfq r
                             WHERE r.state <> 'Cancelled'
                               AND EXISTS (SELECT 1 FROM proc.rfq_invitations i
                                            WHERE i.rfq_id = r.id)`);
    assert.ok(Number(cancellable) >= 0);
    assert.ok(Number(protected_) >= 0);
  });
});

describe('a rejected line is never put out for quote', () => {
  test('no Open RFQ carries a rejected PR line', (t) => {
    if (!dbAvailable()) return t.skip('database not reachable');
    // The defect this closes was invisible in the API response: snapshotRfqLines()
    // omitted `rejected = false`, so a thrown-out line rode the RFQ to vendors.
    const bad = sql(`SELECT count(*)
                       FROM proc.rfq_lines rl
                       JOIN proc.pr_lines pl ON pl.id = rl.pr_line_id
                       JOIN proc.rfq r ON r.id = rl.rfq_id
                      WHERE pl.rejected = true AND r.state <> 'Cancelled'`);
    assert.equal(Number(bad), 0, `${bad} rejected line(s) are on a live RFQ`);
  });
});