-- 019_widen_pr_status_check.sql
--
-- Widen proc.purchase_requisitions.status to the v2 stage vocabulary used by
-- the workflow engine (packages/workflow-engine/src/steps.ts). The original
-- constraint used v1 stage names (HOD_Approved, Proc_Verified, ...) that don't
-- match the current engine.
--
-- This migration also introduces proc.fn_widen_pr_status_check(), which
-- migrations 020 and 027 reuse.
--
-- WHY THE HELPER EXISTS
-- --------------------
-- 019, 020 and 027 each originally did:
--
--     ALTER TABLE ... DROP CONSTRAINT purchase_requisitions_status_check;
--     ALTER TABLE ... ADD  CONSTRAINT purchase_requisitions_status_check
--         CHECK (status IN (<this migration's own list>));
--
-- Each list was correct AT THE TIME and strictly grew: 019 < 020 < 027. But
-- because every migration replaced the whole constraint rather than adding to
-- it, replaying the set on a database that had already run 027 made 020 try to
-- NARROW the constraint back to its own list. Rows already sitting in a
-- governance stage (QUOTES_RECEIVED, CS_LOCKED, MC_APPROVED, CFO_APPROVED,
-- PACK_LOCKED) then violated the CHECK, so `npm run db:migrate` aborted on 019
-- and 020 with a violation "by some row" that named the constraint rather than
-- the real cause.
--
-- A fresh `db:reset` was unaffected, which is exactly why this survived: the
-- bug only appears on an INCREMENTAL re-migrate.
--
-- The helper makes the vocabulary a single superset owned in one place. It:
--   * is idempotent — a no-op when the constraint already matches;
--   * only ever WIDENS — the target list is the union of 019 + 020 + 027, so
--     no migration can shrink what an earlier one allowed;
--   * VERIFIES first — if any existing row holds a status outside the canonical
--     list it RAISEs rather than silently writing a constraint that would then
--     fail on the next write.
--
-- Run:  SELECT proc.fn_widen_pr_status_check();

BEGIN;

CREATE OR REPLACE FUNCTION proc.fn_widen_pr_status_check()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  -- The canonical superset: v1 + v2 + v2.1 + v3 governance. A migration that
  -- needs a new stage ADDS it here; it must never replace the list, because
  -- every replay of 020 and 027 re-applies this function's list.
  wanted text[] := ARRAY[
    -- v1 vocabulary (kept for back-compat with seed data / tests)
    'Draft','Submitted','HOD_Approved','Proc_Verified','Vendor_ID_Done',
    'RFQ_Open','Quotations_Received','CS_Generated','Req_Cost_Approved',
    'CAPEX_OPEX','Finance_Cost_Approved','MC_Submitted','MC_Approved',
    'CFO_Approved','Final_Approved','Pushed_To_D365',
    'Returned','Rejected','Cancelled','On_Hold','Split',
    -- v2 vocabulary (current engine)
    'IN_WAREHOUSE_CHECK','IN_PROCUREMENT_REVIEW','IN_COST_CENTER_APPROVAL',
    'IN_FINANCE_REVIEW','IN_MANAGEMENT_REVIEW','READY_FOR_D365','D365_PUSHED',
    'FULFILLED_FROM_STOCK','Fulfilled',
    -- v2.1 line-routing targets (child PRs only) + engine stage vocabulary
    'IN_HOD_REVIEW','IN_IT_REVIEW','IN_WAREHOUSE',
    'ON_HOLD','SPLIT','CLOSED',
    -- v2.1: the engine's Stage type emits 'REJECTED'; the v1 seed used
    -- 'Rejected'. Both must be storable or a reject transition raises a CHECK
    -- violation instead of transitioning.
    'REJECTED',
    -- v3 prototype governance vocabulary (Wave 3, decision 1A) — added by 027.
    'QUOTES_RECEIVED','CS_LOCKED','MC_APPROVED','CFO_APPROVED','PACK_LOCKED'
  ];
  offenders text;
  current_def text;
BEGIN
  -- Refuse to write a constraint that existing rows already violate. Without
  -- this the ADD CONSTRAINT below would fail with a message pointing at the
  -- constraint rather than at the offending data.
  SELECT string_agg(DISTINCT s, ', ' ORDER BY s) INTO offenders
    FROM (SELECT status AS s FROM proc.purchase_requisitions) t
   WHERE t.s <> ALL (wanted);

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'fn_widen_pr_status_check: % existing PR row(s) hold status value(s) outside the canonical vocabulary: %. Add the new stage to wanted[] in this function before re-running.',
      offenders, offenders;
  END IF;

  -- No-op when the constraint already describes exactly this set, so a replay
  -- does not rewrite the table for nothing.
  SELECT pg_get_constraintdef(oid) INTO current_def
    FROM pg_constraint
   WHERE conrelid = 'proc.purchase_requisitions'::regclass
     AND conname = 'purchase_requisitions_status_check';

  IF current_def IS NOT NULL
     AND NOT EXISTS (
          SELECT 1 FROM unnest(wanted) w
           WHERE position('''' || w || '''' in current_def) = 0
        ) THEN
    RETURN; -- every wanted value is already permitted
  END IF;

  EXECUTE 'ALTER TABLE proc.purchase_requisitions
             DROP CONSTRAINT IF EXISTS purchase_requisitions_status_check';
  EXECUTE format(
    'ALTER TABLE proc.purchase_requisitions
        ADD CONSTRAINT purchase_requisitions_status_check
        CHECK (status IN (%s))',
    (SELECT string_agg(quote_literal(w), ',' ORDER BY w) FROM unnest(wanted) w)
  );
END;
$$;

COMMENT ON FUNCTION proc.fn_widen_pr_status_check() IS
  'Idempotently widen proc.purchase_requisitions.status to the canonical stage vocabulary. Only ever widens; raises if an existing row holds an unknown status.';

-- Apply it.
SELECT proc.fn_widen_pr_status_check();

COMMIT;
