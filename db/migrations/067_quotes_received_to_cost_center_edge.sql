-- ══════════════════════════════════════════════════════════════════════════════
-- 067 · ALLOW QUOTES_RECEIVED → IN_COST_CENTER_APPROVAL
-- ══════════════════════════════════════════════════════════════════════════════
--
-- WHY
-- ---
-- The CS review chain (migration 065) ends in `CsReviewService.confirm()`, which
-- moves the PR to IN_COST_CENTER_APPROVAL through the configured `cs_review`
-- step. UAT found that a reviewer whose PR had taken the "Ready for CS"
-- hand-off (migration 064, `ready_for_cs`: IN_PROCUREMENT_REVIEW ->
-- QUOTES_RECEIVED) could not confirm at all — HTTP 400 "stage mismatch".
--
-- There were TWO gates in the way, and fixing only the first changes the error
-- message without changing the outcome:
--
--   1. CsReviewService.confirm() asserted `pr_stage === 'IN_PROCUREMENT_REVIEW'`,
--      and separately required the routing step's single-valued `from` to equal
--      the PR's exact stage. Fixed in code — see cs.stages.ts. Confirmation now
--      admits the same CS_DRAFT_STAGES that generate() and lock() already did.
--
--   2. THIS FILE. `proc.fn_check_pr_transition()` is a separate, hand-maintained
--      copy of the same workflow, and its QUOTES_RECEIVED branch listed only
--      CS_LOCKED, IN_PROCUREMENT_REVIEW, Rejected, REJECTED and Cancelled — so
--      the write then failed at the database with
--        Invalid PR status transition: QUOTES_RECEIVED -> IN_COST_CENTER_APPROVAL
--      A step in `workflow.steps_config` and an edge in this trigger are two
--      declarations of one workflow. Migration 061 exists for exactly this class
--      of defect, and this is its second instance.
--
-- WHY THE FUNCTION IS PATCHED, NOT REWRITTEN
-- -------------------------------------------
-- 027 is the authority for the governance chain and its own header warns that
-- retyping the body "silently dropped edges on the first attempt at this
-- migration (IN_PROCUREMENT_REVIEW -> CS_LOCKED among them, which broke the
-- comparative-statement lock)". So the text is READ OUT of pg_proc, ONE literal
-- is substituted, and the same two gates as 061 apply:
--
--   1. the anchor must occur exactly ONCE — a string matching zero or many
--      places is refused rather than guessed at;
--   2. the count of `OLD.status =` clauses must be IDENTICAL before and after,
--      which is the assertion that catches a silently dropped edge.
--
-- WHAT THIS DOES NOT DO
-- ---------------------
-- It adds exactly ONE edge to exactly ONE branch. It does not widen any other
-- transition, and in particular the `procurement` and `cs_review` routing steps,
-- the blind-review segregation of duties, and every rejection/cancellation edge
-- are untouched. The edge is available to any caller that moves a PR from
-- QUOTES_RECEIVED to IN_COST_CENTER_APPROVAL — that is inherent to a
-- trigger-level rule — so `CsReviewService.confirm()` remains the only place
-- that reaches it in this codebase, and it applies its own reviewer and
-- stage gates before the write.

DO $do$
DECLARE
  v_old_def  text;
  v_new_def  text;
  v_anchor   constant text := $$'CS_LOCKED','IN_PROCUREMENT_REVIEW',$$;
  v_insert   constant text := $$'CS_LOCKED','IN_PROCUREMENT_REVIEW','IN_COST_CENTER_APPROVAL',$$;
  v_edges_before int;
  v_edges_after  int;
  v_hits     int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_old_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'proc' AND p.proname = 'fn_check_pr_transition';
  IF v_old_def IS NULL THEN
    RAISE EXCEPTION 'migration 067: proc.fn_check_pr_transition does not exist';
  END IF;

  -- Gate 1 — the anchor must be unique, or we are not editing what we think.
  v_hits := length(v_old_def) - length(replace(v_old_def, v_anchor, ''));
  v_hits := v_hits / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'migration 067: anchor found % times (expected exactly 1); refusing to guess', v_hits;
  END IF;

  -- Gate 2 — the no-dropped-edge assertion.
  v_edges_before := (length(v_old_def) - length(replace(v_old_def, 'OLD.status =', ''))) / length('OLD.status =');
  v_new_def := replace(v_old_def, v_anchor, v_insert);
  v_edges_after := (length(v_new_def) - length(replace(v_new_def, 'OLD.status =', ''))) / length('OLD.status =');
  IF v_edges_after <> v_edges_before THEN
    RAISE EXCEPTION 'migration 067: edge clauses changed % -> %; refusing to install', v_edges_before, v_edges_after;
  END IF;

  EXECUTE v_new_def;
END $do$;

COMMENT ON FUNCTION proc.fn_check_pr_transition() IS
  'Stage-transition guard. IN_PROCUREMENT_REVIEW -> IN_HOD_REVIEW is migration '
  '061''s (revert_to_hod). QUOTES_RECEIVED -> IN_COST_CENTER_APPROVAL is '
  'migration 067''s, backing the cs_review step (migration 065) so a blind '
  'review can be confirmed after the Ready-for-CS hand-off. A step in '
  'workflow.steps_config and an edge here are two declarations of one workflow: '
  'change both together, or the endpoint fails on an "invalid transition".';

-- ── Post-flight ────────────────────────────────────────────────────────────
DO $do$
DECLARE v_def text; v_edge text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'proc' AND p.proname = 'fn_check_pr_transition';

  -- The new edge must be on the QUOTES_RECEIVED branch specifically. Finding
  -- the string somewhere in the function is not enough: IN_COST_CENTER_APPROVAL
  -- already appears on the IN_PROCUREMENT_REVIEW branch, so a LIKE on the bare
  -- value would pass even if this migration had done nothing.
  IF v_def NOT LIKE
       $$%'QUOTES_RECEIVED'%'CS_LOCKED','IN_PROCUREMENT_REVIEW','IN_COST_CENTER_APPROVAL',%$$
  THEN
    RAISE EXCEPTION 'migration 067: the IN_COST_CENTER_APPROVAL edge is not on the QUOTES_RECEIVED branch';
  END IF;

  -- The edges 027 and 061 established must all still be there. Each is one that,
  -- if dropped, silently changes what the system may do rather than what it
  -- refuses — which is the failure mode this file exists to prevent.
  FOREACH v_edge IN ARRAY ARRAY[
    'CS_LOCKED','PACK_LOCKED','IN_COST_CENTER_APPROVAL','FULFILLED_FROM_STOCK',
    'IN_MANAGEMENT_REVIEW','READY_FOR_D365','D365_PUSHED','ON_HOLD',
    'IN_WAREHOUSE_CHECK','IN_HOD_REVIEW','MC_APPROVED','CFO_APPROVED'
  ] LOOP
    IF v_def NOT LIKE '%' || v_edge || '%' THEN
      RAISE EXCEPTION 'migration 067: pre-existing edge value % has gone missing from the guard', v_edge;
    END IF;
  END LOOP;
END $do$;
