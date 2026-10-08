-- 053_hod_review_stage.sql
--
-- Fixes the reported defect: a submitted PR never reaches "HOD review", so the
-- department HOD (e.g. Finance) sees no Approve/Reject buttons and the request
-- never behaves like a routed approval.
--
-- THE DEFECT, IN THREE LAYERS
-- -------------------------
-- The prototype (PROCUREMENT_PORTAL_PROTOTYPE.html) creates the PR at SUBMITTED
-- and then immediately auto-routes it:
--
--     // Auto-route to HOD via SUBMITTED -> IN_HOD_REVIEW transition
--     lightTransition(pr, 'IN_HOD_REVIEW', {comment:'Auto-routed to HOD ' + ...});
--
-- In the ported app all three layers of that were missing:
--
--   1. PR service.  apps/api/src/pr/pr.service.ts create() INSERTed a hardcoded
--      'Submitted' and never called the engine, so no auto-route happened.
--   2. Database.     proc.fn_check_pr_transition() had no Submitted -> IN_HOD_REVIEW
--      edge and no IN_HOD_REVIEW source branch at all, so even an explicit
--      UPDATE was rejected:
--          ERROR: Invalid PR status transition: Submitted -> IN_HOD_REVIEW
--      `IN_HOD_REVIEW` was admitted by the status CHECK but unreachable as a
--      transition -- the value was legal everywhere except the one place it
--      mattered. That is why this looked like a routing-table bug.
--   3. Routing.      workflow.steps_config scoped `hod_review` to
--      from='Submitted'. packages/workflow-engine/src/engine.ts filters candidate
--      steps with `s.from === '*' || s.from === pr.status`, so a PR sitting AT
--      IN_HOD_REVIEW would match NO happy-path step. Fixing (1) and (2) alone
--      would have moved the failure: the HOD's Approve would then 400 with
--      "no workflow step matched for status=IN_HOD_REVIEW".
--
-- The routing table is DATA (migration 029 made steps_config load-bearing), so
-- layer 3 is repaired here as data, not as a code constant.
--
-- WHY hod_review BECOMES from='IN_HOD_REVIEW' RATHER THAN ADDING A SECOND STEP
-- ---------------------------------------------------------------------------
-- `from` is a single scalar in this table; there is no "from set". Two steps
-- would double-count the HOD gate in the admin matrix and in the per-line
-- decision UI, so instead the step is retargeted to the stage the PR now
-- actually occupies while awaiting the HOD. `to` is untouched
-- (IN_PROCUREMENT_REVIEW), which is correct: that is where a PR goes AFTER the
-- HOD approves. The prototype's own default list has the same shape -- its
-- `to` is IN_PROCUREMENT_REVIEW, and the pending state is set by the separate
-- auto-route call on submit.
--
-- REPLAY / INCREMENTAL SAFETY
-- ---------------------------
-- Every statement below is idempotent: the function is CREATE OR REPLACE, the
-- route update is guarded by `payload->>'from' = 'Submitted'` so a second run
-- matches nothing, and the backfill is guarded by `status = 'Submitted'`. The
-- post-conditions RAISE rather than trusting the write, per the convention in
-- 029. Replaying this file must be a no-op that changes no rows.
--
-- Note the backfill deliberately touches ONLY rows that (a) are still
-- 'Submitted' AND (b) have a pending routed HOD in proc.pr_departments.
-- 228 PRs sit at 'Submitted' but only 19 have a routed department HOD; the
-- other 209 are CAPITAL-flow PRs with no routed HOD at all. Moving those would
-- invent an approval gate that never existed for them.

BEGIN;

SET LOCAL search_path = proc, workflow, core, public;

-- ─── 1. Transition guard: teach the trigger the IN_HOD_REVIEW edges ─────────
--
-- Replaces the whole function (same shape as migrations 018/020): adds
-- Submitted -> IN_HOD_REVIEW, and an IN_HOD_REVIEW source branch whose targets
-- mirror exactly what `hod_review` can route to, so whatever the engine decided
-- is what the database will accept.

CREATE OR REPLACE FUNCTION proc.fn_check_pr_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    NEW.last_updated_at := now();
    RETURN NEW;
  END IF;

  -- Every edge below EXCEPT the IN_HOD_REVIEW block is carried over verbatim
  -- from migration 027's predicate form. 027 is the authority for the
  -- governance chain; rewriting it as a CASE silently dropped edges on the first
  -- attempt at this migration (IN_PROCUREMENT_REVIEW -> CS_LOCKED among them,
  -- which broke the comparative-statement lock). The only ADDITIONS are the
  -- IN_HOD_REVIEW rows, marked.
  v_ok := (
    (OLD.status = 'Draft'                  AND NEW.status IN ('Submitted','Cancelled')) OR

    -- NEW: submit auto-routes into the HOD's stage, and the HOD's decision
    -- moves it on. Targets mirror what the `hod_review` step can route to.
    (OLD.status = 'Submitted'              AND NEW.status IN (
                                        'IN_HOD_REVIEW',
                                        'IN_PROCUREMENT_REVIEW','IN_WAREHOUSE_CHECK',
                                        'IN_PROCUREMENT_REVIEW_WAREHOUSE',
                                        -- v2.1 line-routing split children
                                        'IN_IT_REVIEW','IN_WAREHOUSE',
                                        'Rejected','REJECTED','Cancelled')) OR
    (OLD.status = 'IN_HOD_REVIEW'          AND NEW.status IN (
                                        'IN_PROCUREMENT_REVIEW','IN_WAREHOUSE_CHECK',
                                        'IN_IT_REVIEW','IN_WAREHOUSE','FULFILLED_FROM_STOCK',
                                        'Returned','Rejected','REJECTED','Cancelled','ON_HOLD')) OR
    -- Resume from hold. lightOnHold takes an ON_HOLD PR back to
    -- IN_HOD_REVIEW (prototype line 6589), so without this edge the HOD's
    -- Resume button would be refused by the guard and the PR would be stranded
    -- on hold with nobody able to release it.
    (OLD.status = 'ON_HOLD'               AND NEW.status IN (
                                        'IN_HOD_REVIEW','Cancelled')) OR

    -- v2.1: a child PR re-enters the main flow after its routed approver acts
    (OLD.status = 'IN_IT_REVIEW'           AND NEW.status IN ('IN_PROCUREMENT_REVIEW','Rejected','REJECTED','Cancelled')) OR
    (OLD.status = 'IN_WAREHOUSE'           AND NEW.status IN ('IN_PROCUREMENT_REVIEW','IN_WAREHOUSE_CHECK','Rejected','REJECTED','Cancelled')) OR
    (OLD.status = 'IN_WAREHOUSE_CHECK'     AND NEW.status IN ('IN_PROCUREMENT_REVIEW','Rejected','REJECTED','Cancelled')) OR
    -- v3 governance exits from procurement review
    (OLD.status = 'IN_PROCUREMENT_REVIEW'  AND NEW.status IN (
                                        'IN_COST_CENTER_APPROVAL',
                                        'QUOTES_RECEIVED','CS_LOCKED','PACK_LOCKED',
                                        'Rejected','REJECTED','Cancelled')) OR
    (OLD.status = 'IN_COST_CENTER_APPROVAL' AND NEW.status IN ('IN_FINANCE_REVIEW','Rejected','REJECTED','Cancelled')) OR
    (OLD.status = 'IN_FINANCE_REVIEW'      AND NEW.status IN ('IN_MANAGEMENT_REVIEW','READY_FOR_D365','Rejected','REJECTED','Cancelled')) OR
    (OLD.status = 'IN_MANAGEMENT_REVIEW'   AND NEW.status IN ('READY_FOR_D365','Cancelled')) OR

    -- v3 governance chain
    (OLD.status = 'QUOTES_RECEIVED'        AND NEW.status IN (
                                        'CS_LOCKED','IN_PROCUREMENT_REVIEW',
                                        'Rejected','REJECTED','Cancelled')) OR
    (OLD.status = 'CS_LOCKED'              AND NEW.status IN (
                                        'MC_APPROVED','QUOTES_RECEIVED',
                                        'PACK_LOCKED',
                                        'Rejected','REJECTED','Cancelled')) OR
    (OLD.status = 'MC_APPROVED'            AND NEW.status IN (
                                        'CFO_APPROVED','CS_LOCKED',
                                        'Rejected','REJECTED','Cancelled')) OR
    (OLD.status = 'CFO_APPROVED'           AND NEW.status IN ('PACK_LOCKED','Cancelled')) OR
    (OLD.status = 'PACK_LOCKED'            AND NEW.status IN ('D365_PUSHED','Cancelled')) OR

    (OLD.status = 'READY_FOR_D365'         AND NEW.status IN ('D365_PUSHED','Cancelled')) OR
    (OLD.status = 'D365_PUSHED'            AND NEW.status IN ('Fulfilled','Cancelled')) OR
    (OLD.status IN ('Rejected','REJECTED')  AND NEW.status IN ('Cancelled')) OR
    (OLD.status = 'Fulfilled'              AND NEW.status IN ('Cancelled')) OR
    -- Side-channel: any state can short-circuit to Fulfilled-from-stock
    (NEW.status = 'FULFILLED_FROM_STOCK') OR
    -- Cancellation allowed from any non-terminal state
    (NEW.status = 'Cancelled' AND OLD.status NOT IN ('D365_PUSHED','Fulfilled','Cancelled'))
  );

  IF NOT v_ok THEN
    RAISE EXCEPTION 'Invalid PR status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.last_updated_at := now();
  RETURN NEW;
END;
$$;

-- ─── 2. Post-condition: the guard actually accepts the new edge ────────────
-- Proves the repair INSIDE the transaction instead of trusting the write.
--
-- The probe deliberately raises and catches on a REAL row: an UPDATE that
-- matched no rows would leave the exception unset and make this check pass
-- vacuously. The synthetic raise is what discards the probe's own write — the
-- inner exception block is a subtransaction, so the UPDATE is rolled back and
-- the PR keeps its real status.

DO $$
DECLARE
  v_probe uuid;
  v_blocked boolean := false;
  v_succeeded boolean := false;
BEGIN
  SELECT id INTO v_probe
    FROM proc.purchase_requisitions
   WHERE status = 'Submitted'
   LIMIT 1;

  IF v_probe IS NULL THEN
    RAISE EXCEPTION '053: no Submitted PR available to probe the transition guard with.';
  END IF;

  BEGIN
    UPDATE proc.purchase_requisitions
       SET status = 'IN_HOD_REVIEW'
     WHERE id = v_probe;
    -- Reaching here means the guard ALLOWED it. Abandon the subtransaction so
    -- the probe's write is discarded.
    RAISE EXCEPTION 'probe_discard' USING ERRCODE = 'P0001';
  EXCEPTION
    WHEN check_violation THEN
      v_blocked := true;                      -- still blocked: the fix did not land
    WHEN OTHERS THEN
      IF SQLERRM <> 'probe_discard' THEN
        RAISE;                                -- a real, unrelated error
      END IF;
      v_succeeded := true;                    -- transition permitted
  END;

  IF v_blocked OR NOT v_succeeded THEN
    RAISE EXCEPTION
      '053: Submitted -> IN_HOD_REVIEW is still refused by fn_check_pr_transition; '
      'the guard was not replaced. blocked=% allowed=%', v_blocked, v_succeeded;
  END IF;
END;
$$;

-- ─── 3. Routing data: retarget the HOD gate to the stage the PR now sits in ─
--
-- Guarded, so replay matches nothing. `to` and lineRules are deliberately NOT
-- touched: the line-routing / auto-split behaviour (migration 020/029) rides on
-- this step and must keep working.

UPDATE workflow.steps_config
   SET payload = jsonb_set(payload, '{from}', '"IN_HOD_REVIEW"'::jsonb),
       updated_at = now()
 WHERE id = 'hod_review'
   AND payload->>'from' = 'Submitted';

-- The warehouse branch is reachable from the same HOD stage: the prototype
-- routes IN_WAREHOUSE_CHECK off the HOD's approval, so both steps must be
-- in scope from IN_HOD_REVIEW or that checkbox silently stops working.

UPDATE workflow.steps_config
   SET payload = jsonb_set(payload, '{from}', '"IN_HOD_REVIEW"'::jsonb),
       updated_at = now()
 WHERE id = 'warehouse_check'
   AND payload->>'from' = 'Submitted';

-- Ordering: warehouse_check must still be evaluated BEFORE hod_review (its
-- predicate `wantWarehouse` is more specific than `always`). Renumbering keeps
-- that guarantee now that both share a `from`.

UPDATE workflow.steps_config SET order_index = 5 WHERE id = 'warehouse_check';
UPDATE workflow.steps_config SET order_index = 6 WHERE id = 'hod_review';

DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(t, ', ')
    INTO v_missing
    FROM unnest(ARRAY['warehouse_check','hod_review']) AS t
   WHERE NOT EXISTS (
     SELECT 1 FROM workflow.steps_config
      WHERE id = t AND payload->>'from' = 'IN_HOD_REVIEW'
   );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION
      '053: no IN_HOD_REVIEW-routable step for: % -- a PR in HOD review would not advance.', v_missing;
  END IF;
END;
$$;

-- ─── 4. Backfill the requests that are already stranded ────────────────────
--
-- Only Submitted PRs that have a pending routed HOD. These are the ones the
-- user can see in the HOD queue but cannot act on. Moves them to the stage they
-- would have been in had create() auto-routed them.

WITH stranded AS (
  SELECT p.id
    FROM proc.purchase_requisitions p
   WHERE p.status = 'Submitted'
     AND EXISTS (
       SELECT 1 FROM proc.pr_departments pd
        WHERE pd.pr_id = p.id
          AND pd.hod_status = 'pending'
          AND pd.hod_user_id IS NOT NULL
     )
)
UPDATE proc.purchase_requisitions p
   SET status = 'IN_HOD_REVIEW',
       last_updated_at = now()
  FROM stranded s
 WHERE p.id = s.id;

-- These PRs pre-date the fix and were frozen against the OLD routing table, where
-- no step was sourced from IN_HOD_REVIEW. getConfigForPr prefers the snapshot, so
-- without a refresh they would still fail to advance ("no workflow step matched").
-- Re-freeze ONLY the ones just moved, and only when their snapshot is actually
-- stale -- the guard is what makes a replay a no-op.
--
-- The snapshot is the WHOLE ordered step array (workflow.repository.loadForPr
-- rebuilds the config from it), so this copies every step in order rather than
-- just the two touched above.

WITH moved AS (
  SELECT p.id
    FROM proc.purchase_requisitions p
   WHERE p.status = 'IN_HOD_REVIEW'
     AND EXISTS (
       SELECT 1 FROM proc.pr_departments pd
        WHERE pd.pr_id = p.id AND pd.hod_status = 'pending'
     )
     AND NOT EXISTS (
       SELECT 1
         FROM workflow.pr_workflow_snapshot s,
              LATERAL jsonb_array_elements(s.steps) AS st
        WHERE s.pr_id = p.id
          AND st->>'from' = 'IN_HOD_REVIEW'
     )
),
fresh AS (
  SELECT COALESCE(jsonb_agg(payload ORDER BY order_index), '[]'::jsonb) AS steps,
         (SELECT COALESCE(
                   MAX(CASE WHEN key = 'management_threshold' THEN (value->>'value')::numeric END),
                   1000000
                 ) FROM workflow.config) AS threshold
    FROM workflow.steps_config
)
INSERT INTO workflow.pr_workflow_snapshot (pr_id, steps, management_threshold)
SELECT m.id, f.steps, f.threshold
  FROM moved m
 CROSS JOIN fresh f
ON CONFLICT (pr_id) DO UPDATE
   SET steps = EXCLUDED.steps,
       management_threshold = EXCLUDED.management_threshold,
       snapshot_at = now();

COMMIT;
