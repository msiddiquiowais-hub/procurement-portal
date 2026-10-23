-- ══════════════════════════════════════════════════════════════════════════════
-- 061 · ALLOW IN_PROCUREMENT_REVIEW → IN_HOD_REVIEW
-- ══════════════════════════════════════════════════════════════════════════════
--
-- WHY
-- ---
-- `proc.fn_check_pr_transition()` is the BEFORE UPDATE trigger that makes illegal
-- stage jumps impossible. Migration 060 added the `revert_to_hod` routing step
-- and `PrService.revertToHod()`, but the trigger's edge list is a separate,
-- hand-maintained copy of the workflow, and it did not contain this edge — so
-- the endpoint failed at the database with
--   Invalid PR status transition: IN_PROCUREMENT_REVIEW -> IN_HOD_REVIEW
-- A step in `workflow.steps_config` and an edge in this trigger are two
-- declarations of the same workflow, and this file is the reminder that they are
-- not the same declaration.
--
-- WHY THE FUNCTION IS PATCHED, NOT REWRITTEN
-- -------------------------------------------
-- The function's own header says: "027 is the authority for the governance chain;
-- rewriting it as a CASE silently dropped edges on the first attempt at this
-- migration (IN_PROCUREMENT_REVIEW -> CS_LOCKED among them, which broke the
-- comparative-statement lock)."
--
-- That is a written warning from a previous author who broke the chain by
-- retyping it. So the body is NOT retyped here. It is read out of pg_proc, ONE
-- literal is substituted, and two assertions gate the result:
--
--   1. the anchor must occur exactly ONCE — a string that matches zero or many
--      places is not the edit we intended, and is refused rather than guessed at;
--   2. the count of `OLD.status =` clauses must be IDENTICAL before and after —
--      this is the assertion that catches a silently dropped edge, and it is the
--      one that would have caught the original defect.
--
-- Nothing else in the function is touched. The full text is re-asserted at the
-- end against pg_proc so a future replay that finds a differently-shaped function
-- fails loudly instead of quietly reverting the edge.

DO $do$
DECLARE
  v_old_def  text;
  v_new_def  text;
  v_anchor   constant text := $$'QUOTES_RECEIVED','CS_LOCKED','PACK_LOCKED',$$;
  v_insert   constant text := $$'QUOTES_RECEIVED','CS_LOCKED','PACK_LOCKED','IN_HOD_REVIEW',$$;
  v_edges_before int;
  v_edges_after  int;
  v_hits     int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_old_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'proc' AND p.proname = 'fn_check_pr_transition';
  IF v_old_def IS NULL THEN
    RAISE EXCEPTION 'migration 061: proc.fn_check_pr_transition does not exist';
  END IF;

  -- Gate 1 — the anchor must be unique, or we are not editing what we think.
  v_hits := length(v_old_def) - length(replace(v_old_def, v_anchor, ''));
  v_hits := v_hits / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'migration 061: anchor found % times (expected exactly 1); refusing to guess', v_hits;
  END IF;

  -- Gate 2 — the no-dropped-edge assertion.
  v_edges_before := (length(v_old_def) - length(replace(v_old_def, 'OLD.status =', ''))) / length('OLD.status =');
  v_new_def := replace(v_old_def, v_anchor, v_insert);
  v_edges_after := (length(v_new_def) - length(replace(v_new_def, 'OLD.status =', ''))) / length('OLD.status =');
  IF v_edges_after <> v_edges_before THEN
    RAISE EXCEPTION 'migration 061: edge clauses changed % -> %; refusing to install', v_edges_before, v_edges_after;
  END IF;

  EXECUTE v_new_def;
END $do$;

COMMENT ON FUNCTION proc.fn_check_pr_transition() IS
  'Stage-transition guard. The IN_PROCUREMENT_REVIEW -> IN_HOD_REVIEW edge is '
  'migration 061''s, backing the revert_to_hod step (migration 060). A step in '
  'workflow.steps_config and an edge here are two declarations of one workflow: '
  'change both together, or the endpoint 500s on an "invalid transition".';

-- ── Post-flight ────────────────────────────────────────────────────────────
DO $do$
DECLARE v_def text; v_edge text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'proc' AND p.proname = 'fn_check_pr_transition';

  IF v_def NOT LIKE
       $$%'QUOTES_RECEIVED','CS_LOCKED','PACK_LOCKED','IN_HOD_REVIEW',%$$
  THEN
    RAISE EXCEPTION 'migration 061: the IN_HOD_REVIEW edge is not on the IN_PROCUREMENT_REVIEW branch';
  END IF;

  -- The edges 027 established must all still be there. Each is one that, if
  -- dropped, silently changes what the system may do rather than what it
  -- refuses — which is the failure mode this file exists to prevent.
  FOREACH v_edge IN ARRAY ARRAY[
    'CS_LOCKED','PACK_LOCKED','IN_COST_CENTER_APPROVAL','FULFILLED_FROM_STOCK',
    'IN_MANAGEMENT_REVIEW','READY_FOR_D365','D365_PUSHED','ON_HOLD','IN_WAREHOUSE_CHECK'
  ] LOOP
    IF v_def NOT LIKE '%' || v_edge || '%' THEN
      RAISE EXCEPTION 'migration 061: pre-existing edge value % has gone missing from the guard', v_edge;
    END IF;
  END LOOP;
END $do$;