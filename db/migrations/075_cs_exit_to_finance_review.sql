-- 075 — the cost approval stage leaves the ladder. The CS EXIT is the cost
--        approval event, and Finance is the next desk.
--
--   docker cp db/migrations/075_cs_exit_to_finance_review.sql procurement-portal-db:/tmp/075.sql
--   docker exec -i procurement-portal-db psql -U proc -d procurementDB -X -A -t -v ON_ERROR_STOP=1 -f /tmp/075.sql
--
-- WHAT THIS CHANGES, AND WHY IT IS A LADDER CHANGE AND NOT A CODE CHANGE
-- ====================================================================
-- The request was: stop hardcoding stage jumps in TypeScript, and let
-- workflow.steps_config govern. It also exposed a stage that could not be
-- governed at all.
--
-- IN_COST_CENTER_APPROVAL had exactly one exit:
--
--     order 12  cost_center  IN_COST_CENTER_APPROVAL -> IN_FINANCE_REVIEW
--               actor cost_center_owner, when always
--
-- and NO control anywhere in the web app could fire it. The prototype has two
-- buttons there (PROCUREMENT_PORTAL_PROTOTYPE.html:3002-3005, handlers at
-- 4833/4872) and neither was ever ported, so the one desk the ladder named had
-- no act. Worse, the ladder names `cost_center_owner` while the prototype's own
-- stage-owner table says `hod` (line 1714) and its handler guard is
-- `STATE.role !== 'hod'` (line 4836) — so even with the buttons the engine
-- would have refused the HOD, because core.users signs people in as `hod`.
-- 117 requests were sitting in that stage.
--
-- The ruling: the blind-review confirmation by the requesting HOD IS the cost
-- approval event. Once the review is confirmed AND procurement has classified
-- every line, the request goes straight to Finance. The separate manual gate is
-- deleted rather than given a UI.
--
-- *** DELIBERATE DEVIATION FROM THE PROTOTYPE. ***
-- The prototype treats cost approval as a distinct HOD act with its own
-- approval button and its own "send back to procurement". Removing it changes
-- that screen's meaning, and it is recorded here so the next reader does not
-- mistake the gap for an unfinished port.
--
--
-- THE LADDER AFTER THIS MIGRATION
-- -------------------------------
--   ord 6  cs_review         IN_PROCUREMENT_REVIEW -> IN_FINANCE_REVIEW  csExitComplete  hod
--   ord 7  cs_review_quotes  QUOTES_RECEIVED       -> IN_FINANCE_REVIEW  csExitComplete  procurement
--   ord 11 procurement       IN_PROCUREMENT_REVIEW -> IN_FINANCE_REVIEW  always         procurement
--   ord 12 cost_center       DELETED
--
-- Orders 6 and 7 stay ABOVE order 11, which still matters: the first matching
-- step wins, by ARRAY POSITION, not by order_index. So a `csExitComplete` step
-- is still what fires when the exit is available, and order 11 is still the
-- plain procurement forward for a request that goes without a comparative
-- statement.
--
-- WHY `when` IS `csExitComplete` AND NOT A CONJUNCTION SPELLED OUT
-- ----------------------------------------------------------------
-- evaluatePredicate switches on ONE keyword and coerces anything it does not
-- recognise to 'always' (packages/workflow-engine/src/predicates.ts). Writing
-- the literal string 'csReviewConfirmed AND capexOpexClassified' would have
-- matched on EVERY advance out of IN_PROCUREMENT_REVIEW and QUOTES_RECEIVED,
-- and silently taken those stages away from order 11. That is not
-- hypothetical: it is how `readyForCs` and `csReviewConfirmed` each went inert
-- before they were added to the vocabulary. One keyword, one evaluator branch.
--
-- WHY `capexOpexClassified` IS NOT A DECISION FLAG
-- ------------------------------------------------
-- Every other decision keyword reads what the approver just clicked. If this one
-- did too, any caller could post `capexOpexClassified: true` and skip the
-- control it exists to enforce. It is evaluated from the PR's own lines inside
-- the frozen snapshot, which the caller cannot edit. See predicates.ts.
--
--
-- IDEMPOTENCE
-- -----------
-- This chain is replayed whole on every deployment, so every statement below has
-- to be correct on its second run. Nothing here asserts a row count; the two
-- invariants at the end state what must HOLD, not how many rows were touched
-- today.
--
-- SECTION 1 — the ladder
-- -----------------------
UPDATE workflow.steps_config
   SET payload = payload
       || jsonb_build_object(
            'to', 'IN_FINANCE_REVIEW',
            -- Only WHERE a gate exists. Overwriting an `always` step's condition
            -- would silently turn a plain forward into a conditional one, and
            -- order 11 must stay a plain forward.
            'when', CASE WHEN payload->>'when' = 'csReviewConfirmed'
                        THEN 'csExitComplete' ELSE payload->>'when' END),
       updated_at = now()
 WHERE id IN ('cs_review', 'cs_review_quotes', 'procurement')
   AND payload->>'to' = 'IN_COST_CENTER_APPROVAL';

DELETE FROM workflow.steps_config WHERE id = 'cost_center';

-- `order_index` 12 is now a hole and is left as one. Renumbering to close it
-- would mean this migration re-owning a column 068 already owns, and order_index
-- is read only for display: stepsFromConfigRows re-stamps each step's order from
-- its ARRAY POSITION, which is what the engine actually ranks on.


-- SECTION 2 — the 117 requests already inside the removed stage
-- --------------------------------------------------------------
-- Nothing in the ladder leaves IN_COST_CENTER_APPROVAL any more, so leaving them
-- would strand every one of them permanently: no advance, from any role, could
-- ever move them. They go to IN_FINANCE_REVIEW, which is where order 12 would
-- have delivered them.
--
-- This moves only rows sitting IN the stage. It does not touch history, and it
-- does not reach back to rewrite what a request did on a date when
-- IN_COST_CENTER_APPROVAL was the correct destination.
UPDATE proc.purchase_requisitions
   SET status = 'IN_FINANCE_REVIEW',
       last_updated_at = now()
 WHERE status = 'IN_COST_CENTER_APPROVAL';


-- SECTION 3 — the frozen snapshots
-- ---------------------------------
-- THE PART THAT IS EASY TO MISS.
--
-- 1,369 requests carry a frozen ladder in workflow.pr_workflow_snapshot, and
-- loadForPr reads THAT instead of the live table. Editing steps_config alone
-- would have changed routing for new requests only: a request created before
-- this migration, sitting at IN_PROCUREMENT_REVIEW with a snapshot frozen on the
-- old ladder, would still have advanced into IN_COST_CENTER_APPROVAL — into a
-- stage with no exit. It would have joined the stranded set one advance later,
-- and nothing would have said so.
--
-- SCOPED ON PURPOSE — TO THE KEYS THIS MIGRATION OWNS, AND NOT TO THE STAGE.
--
-- A snapshot is frozen for the WHOLE LIFE of its request, not just while it is
-- in flight. A request created today at IN_HOD_REVIEW will reach
-- IN_PROCUREMENT_REVIEW next week, and its frozen cs_review entry is what will
-- fire then. So the reconciliation cannot be limited to the requests that are
-- currently mid-flow: a stale entry in a snapshot that is "not in flight yet"
-- is the same stale entry, and it will be read later.
--
-- What IS scoped is the set of ENTRIES touched. Three facts are changed and no
-- fourth:
--
--   1. the step that LEAVES the removed stage is dropped;
--   2. a CS EXIT entry gets the live ladder's condition and flag, because the
--      live ladder's condition CHANGED (csReviewConfirmed -> csExitComplete) and
--      a frozen copy of the old condition is a different rule;
--   3. any other step aimed AT the removed stage is re-aimed at
--      IN_FINANCE_REVIEW.
--
-- Every other frozen entry — array position, actor, name — is untouched. That
-- is the whole purpose of a snapshot: an admin editing the ladder must not
-- retroactively re-route work in flight. This migration is not an admin edit; it
-- is the ladder changing shape, and a frozen copy of the old shape is a dead
-- end.
--
-- POINT 2 IS THE ONE THAT IS EASY TO LEAVE OUT, and leaving it out opens a
-- control hole rather than breaking a route. 377 frozen snapshots still carried
-- `when: 'csReviewConfirmed'`, which does NOT test the classification: a
-- request with a frozen snapshot would have crossed the CS exit with its lines
-- unclassified — the exact crossing the whole change exists to prevent. 139 of
-- the cs_review entries had also lost `requiresCapexOpex` entirely, so the card
-- would never have opened for them either. The live ladder was right; its frozen
-- copies were not.
--
-- The CS exits are recognised by their CONDITION, not by their key: a snapshot
-- entry carries a key only some of the time (loadForPr resolves it as
-- `p.key ?? step_${i}`), and `when` is always there. The condition is also
-- exactly what distinguishes the CS exits from order 11, which shares their
-- from/to pair but carries `always`.
--
-- `WITH ORDINALITY AS el(n, ord)` NAMES the value column `n` — the `el(alias)`
-- form leaves no column actually called `el`, so referencing `el->>'key'` is a
-- type error the database rejects rather than a subtle wrong answer.
UPDATE workflow.pr_workflow_snapshot s
   SET steps = (
         SELECT jsonb_agg(
                  CASE WHEN n->>'from' = 'IN_COST_CENTER_APPROVAL' THEN NULL
                       WHEN n->>'when' = 'csReviewConfirmed'
                         THEN n || jsonb_build_object(
                                'to', 'IN_FINANCE_REVIEW',
                                'when', 'csExitComplete',
                                'requiresCapexOpex', true)
                       -- The `procurement` step, identified by its shape: it is the
                       -- only entry that leaves IN_PROCUREMENT_REVIEW
                       -- unconditionally for Finance review. (The CS exit shares
                       -- the same from/to pair but is recognised above, by its
                       -- condition.) The live ladder's copy has had
                       -- requiresCapexOpex false since migration 072, which
                       -- reconciled the live table and NOT the snapshots.
                       WHEN n->>'from' = 'IN_PROCUREMENT_REVIEW'
                            AND n->>'when' = 'always'
                            AND n->>'to' = 'IN_FINANCE_REVIEW'
                         THEN jsonb_set(n, '{requiresCapexOpex}', 'false'::jsonb, true)
                       WHEN n->>'to' = 'IN_COST_CENTER_APPROVAL'
                         THEN jsonb_set(n, '{to}', '"IN_FINANCE_REVIEW"'::jsonb, true)
                       ELSE n END
                  ORDER BY ord
                )
           FROM jsonb_array_elements(s.steps::jsonb) WITH ORDINALITY AS el(n, ord)
       )::jsonb
 WHERE steps::text LIKE '%IN_COST_CENTER_APPROVAL%'
    OR steps::text LIKE '%csReviewConfirmed%'
    OR steps::text LIKE '%cost_center_owner%'
    -- Point 4 is asked as a SHAPE, not as a text match. A text match on
    -- `"requiresCapexOpex": true` would select every snapshot that merely
    -- CONTAINS such an entry — which, after the CS exits were restamped, is
    -- all 1,369 of them — and the migration would rewrite every row on every
    -- deployment forever. The values written are identical, so it is not a
    -- correctness problem; it is 1,369 needless row updates per deploy, and a
    -- replay that does not read as a no-op.
    OR EXISTS (
         SELECT 1
           FROM jsonb_array_elements(s.steps::jsonb) e
          WHERE e->>'from' = 'IN_PROCUREMENT_REVIEW'
            AND e->>'when' = 'always'
            AND e->>'to' = 'IN_FINANCE_REVIEW'
            AND coalesce((e->>'requiresCapexOpex')::boolean, false) IS NOT false
       );


-- SECTION 4 — invariants
-- ------------------------
-- Both are properties that must hold on every replay, including the first. They
-- are deliberately NOT "0 rows updated" — a repair that changes nothing on the
-- second run is the correct outcome, and asserting otherwise would break the
-- next deployment.
DO $$
DECLARE
  stranded integer;
BEGIN
  -- 1. NO REQUEST IS LEFT IN A STAGE THE LADDER CANNOT LEAVE.
  --    The stranded set is empty and stays empty. This is the assertion that
  --    would have caught Section 2 or Section 3 not running.
  SELECT count(*) INTO stranded
    FROM proc.purchase_requisitions
   WHERE status = 'IN_COST_CENTER_APPROVAL';
  IF stranded > 0 THEN
    RAISE EXCEPTION
      '% request(s) remain in IN_COST_CENTER_APPROVAL, which no step leaves any more',
      stranded;
  END IF;

  -- 2. NO LIVE STEP, AND NO FROZEN SNAPSHOT ANYWHERE, STILL POINTS AT THE
  --    REMOVED STAGE.
  --
  --    EVERY snapshot, not just the in-flight ones. A snapshot frozen on a
  --    request that is not mid-flow yet is the same snapshot, and it will be
  --    read when that request reaches the stage. Scoping the check to the
  --    in-flight set would have let 377 of them keep the old condition
  --    unnoticed — and the old condition does not test the classification, so
  --    those requests would have crossed the CS exit with their lines
  --    unclassified. A control hole, not a routing fault: nothing about it
  --    would have looked wrong.
  IF EXISTS (
       SELECT 1 FROM workflow.steps_config
        WHERE payload->>'to' = 'IN_COST_CENTER_APPROVAL'
           OR payload->>'from' = 'IN_COST_CENTER_APPROVAL'
   ) THEN
    RAISE EXCEPTION 'a live step still routes through IN_COST_CENTER_APPROVAL';
  END IF;

  SELECT count(*) INTO stranded
    FROM workflow.pr_workflow_snapshot s
   WHERE s.steps::text LIKE '%IN_COST_CENTER_APPROVAL%'
      OR s.steps::text LIKE '%cost_center_owner%';
  IF stranded > 0 THEN
    RAISE EXCEPTION
      '% snapshot(s) still describe the removed cost-approval step', stranded;
  END IF;

  -- 3. AND NO FROZEN COPY OF A CS EXIT CARRIES THE OLD CONDITION.
  --    The live ladder says csExitComplete; a frozen copy that says
  --    csReviewConfirmed is a DIFFERENT RULE — one that does not require the
  --    lines to be classified. The two must not be able to drift.
  SELECT count(*) INTO stranded
    FROM workflow.pr_workflow_snapshot s
   WHERE s.steps::text LIKE '%csReviewConfirmed%';
  IF stranded > 0 THEN
    RAISE EXCEPTION
      '% snapshot(s) still carry the pre-075 CS exit condition', stranded;
  END IF;

  -- 4. AND NO FROZEN COPY OF THE `procurement` STEP STILL DEMANDS A
  --    CLASSIFICATION. Migration 072 removed that demand from the live ladder
  --    because the card used to open at "Procurement review · RFQ not issued"
  --    — one stage early, offering work the workflow had not asked for. It
  --    reconciled the live table and not the snapshots, and the engine reads the
  --    SNAPSHOT for any request that has one, so 110 requests were still living
  --    the defect 072 fixed.
  SELECT count(*) INTO stranded
    FROM workflow.pr_workflow_snapshot s,
         LATERAL jsonb_array_elements(s.steps::jsonb) e
   WHERE e->>'from' = 'IN_PROCUREMENT_REVIEW'
     AND e->>'when' = 'always'
     AND e->>'to' = 'IN_FINANCE_REVIEW'
     AND coalesce((e->>'requiresCapexOpex')::boolean, false) IS NOT false;
  IF stranded > 0 THEN
    RAISE EXCEPTION
      '% frozen procurement step(s) still demand a classification', stranded;
  END IF;

  -- 5. AND EVERY CS EXIT IN EVERY SNAPSHOT DECLARES THE CLASSIFICATION IT
  --    DEMANDS. An entry that lost its flag would not open the card, so its
  --    lines could never be classified and its request could never cross.
  SELECT count(*) INTO stranded
    FROM workflow.pr_workflow_snapshot s,
         LATERAL jsonb_array_elements(s.steps::jsonb) e
   WHERE e->>'when' = 'csExitComplete'
     AND coalesce((e->>'requiresCapexOpex')::boolean, false) IS NOT true;
  IF stranded > 0 THEN
    RAISE EXCEPTION
      '% frozen CS exit(s) do not declare requiresCapexOpex', stranded;
  END IF;
END $$;
-- SECTION 5 — the DATABASE'S OWN COPY OF THE EDGES
-- --------------------------------------------------
-- THE THIRD STATE MACHINE, and the reason the CS exit did not fire.
--
-- `proc.fn_check_pr_transition()` is a BEFORE UPDATE trigger on
-- proc.purchase_requisitions that refuses any status change not in a HARDCODED
-- edge table. The engine planned QUOTES_RECEIVED -> IN_FINANCE_REVIEW
-- correctly, and the database then refused it:
--
--     ERROR: Invalid PR status transition: QUOTES_RECEIVED -> IN_FINANCE_REVIEW
--
-- So the ladder was not, on its own, governing the transition. There are three
-- owners of "which edges exist": this trigger, `workflow.steps_config`, and the
-- code-side mirrors in packages/workflow-engine (DEFAULT_WORKFLOW_STEPS,
-- GOVERNANCE_NEXT). A change to one is a change to none until the other two
-- are moved too, and the one that failed LOUDEST was this one.
--
-- WHAT THIS SECTION DOES: retargets the two governance edges this change
-- moves, and leaves every other edge exactly as migration 027 wrote it. The
-- IN_COST_CENTER_APPROVAL row is KEPT — not as a live edge but as a safety
-- valve, so that a legacy row in that stage (there are none) can still be
-- moved out rather than being trapped by a guard.
--
-- WHAT IT DELIBERATELY DOES NOT DO: rewrite this trigger to READ the ladder.
-- That is the right end state, and it is a separate piece of work with its
-- own risk — this trigger is the last line of defence against an illegal
-- status write, and several of its edges (CS_LOCKED, PACK_LOCKED, MC_APPROVED,
-- CFO_APPROVED) are written by the sourcing and award services and are NOT
-- ladder steps at all. Making it ladder-driven would mean either dropping
-- those edges or teaching the ladder about them. It is reported, not done here.
--
-- *** DELIBERATE DEVIATION FROM THE PROTOTYPE, recorded here for the same
-- *** reason as the ladder above: the prototype's cost approval stage is gone.
--
CREATE OR REPLACE FUNCTION proc.fn_check_pr_transition()
RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
                                        'IN_FINANCE_REVIEW',
                                        'QUOTES_RECEIVED','CS_LOCKED','PACK_LOCKED','IN_HOD_REVIEW',
                                        'Rejected','REJECTED','Cancelled')) OR
    (OLD.status = 'IN_COST_CENTER_APPROVAL' AND NEW.status IN ('IN_FINANCE_REVIEW','Rejected','REJECTED','Cancelled')) OR
    (OLD.status = 'IN_FINANCE_REVIEW'      AND NEW.status IN ('IN_MANAGEMENT_REVIEW','READY_FOR_D365','Rejected','REJECTED','Cancelled')) OR
    (OLD.status = 'IN_MANAGEMENT_REVIEW'   AND NEW.status IN ('READY_FOR_D365','Cancelled')) OR

    -- v3 governance chain
    (OLD.status = 'QUOTES_RECEIVED'        AND NEW.status IN (
                                        'CS_LOCKED','IN_PROCUREMENT_REVIEW','IN_FINANCE_REVIEW',
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
$function$
;
