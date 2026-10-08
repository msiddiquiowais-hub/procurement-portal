\set ON_ERROR_STOP on
-- â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- 027 governance stages verification (Wave 3 step 0)
--
-- Self-sufficient: builds its own PR/CS/vote fixtures rather than depending on
-- whatever happens to be in the database. Everything runs inside
-- BEGIN/ROLLBACK, so nothing here persists.
--
-- The governance tables are under FORCE ROW LEVEL SECURITY, so these
-- single-session checks bypass it explicitly. core.fn_bypass_rls() reads
-- exactly this setting.
-- â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
SET app.bypass_rls = 'true';

\echo 'â•â•â• 027 governance verification â•â•â•'
\echo ''
\echo 'â”€â”€ 1. the five prototype stages are storable â”€â”€'
-- STAGES[].k from PROCUREMENT_PORTAL_PROTOTYPE.html:1500-1510. Every one of
-- these used to raise a CHECK violation. The whole point of the migration.
WITH chk AS (
  SELECT pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t     ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'proc' AND t.relname = 'purchase_requisitions'
     AND c.conname = 'purchase_requisitions_status_check'
)
SELECT s.stage, (chk.def LIKE '%' || s.stage || '%') AS accepted
  FROM unnest(ARRAY['QUOTES_RECEIVED','CS_LOCKED','MC_APPROVED','CFO_APPROVED','PACK_LOCKED']) AS s(stage),
       chk
 ORDER BY s.stage;
-- expected: accepted = t on all five (before 027 every one of these was f)

\echo ''
\echo 'â”€â”€ 2. a v2 stage was NOT lost by the widening â”€â”€'
-- The migration replaces the whole CHECK. If it forgot a single legacy value the
-- database would still build but a pre-existing row could no longer be updated.
-- This is the regression that migrations 019/020 already fixed once.
SELECT count(*) AS legacy_values_still_present
  FROM unnest(ARRAY['Draft','Submitted','Rejected','REJECTED','Cancelled','On_Hold',
                    'IN_PROCUREMENT_REVIEW','IN_COST_CENTER_APPROVAL','IN_FINANCE_REVIEW',
                    'IN_MANAGEMENT_REVIEW','READY_FOR_D365','D365_PUSHED','FULFILLED_FROM_STOCK',
                    'MC_Approved','CFO_Approved','Fulfilled','SPLIT','CLOSED','ON_HOLD',
                    'IN_HOD_REVIEW','IN_IT_REVIEW','IN_WAREHOUSE','IN_WAREHOUSE_CHECK']) AS s(stage)
 WHERE (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'proc' AND t.relname = 'purchase_requisitions'
          AND c.conname = 'purchase_requisitions_status_check') LIKE '%' || stage || '%';
-- expected: 23 (every row must be t; a single f means a vocabulary was dropped)

\echo ''
\echo 'â”€â”€ 3. the MC panel is 5 members with exactly one chair â”€â”€'
SELECT
  (SELECT count(*) FROM workflow.mc_panel)                       AS panel_size,
  (SELECT count(*) FROM workflow.mc_panel WHERE chair)           AS chairs,
  workflow.fn_mc_quorum()                                        AS quorum_fn,
  (SELECT string_agg(u.display_name, ', ' ORDER BY p.seat)
     FROM workflow.mc_panel p JOIN core.users u ON u.id = p.user_id) AS names_in_seat_order;

\echo ''
\echo 'â”€â”€ 4. the chair is the prototype''s acting member â”€â”€'
-- renderMCVote line 7886: "You are voting as Dr. Imran Shah"
SELECT u.email, u.display_name, u.role FROM workflow.mc_panel p
  JOIN core.users u ON u.id = p.user_id WHERE p.chair;

\echo ''
\echo 'â”€â”€ 5. every MC panel member really has role = mc â”€â”€'
SELECT count(*) FILTER (WHERE u.role = 'mc') AS correct,
       count(*) FILTER (WHERE u.role <> 'mc') AS wrong_role
  FROM workflow.mc_panel p JOIN core.users u ON u.id = p.user_id;

\echo ''
\echo 'â”€â”€ 6. governance step ids exist for the vote ledger FK â”€â”€'
-- approval_votes.step_id -> steps_config(id). Without these, a vote cannot be
-- recorded at all.
SELECT id, payload->>'actorRole' AS actor, payload->>'to' AS to_stage
  FROM workflow.steps_config
 WHERE id IN ('mc_approval','cfo_approval') ORDER BY id;

\echo ''
\echo 'â”€â”€ 7. comparative_statements is now per-round, not per-PR â”€â”€'
BEGIN;
DO $$
DECLARE v_pr uuid; v_user uuid; v_cs1 uuid; v_cs2 uuid; v_round int;
BEGIN
  SELECT id INTO v_user FROM core.users WHERE role = 'requester' LIMIT 1;
  INSERT INTO proc.purchase_requisitions
    (pr_number, requester_user_id, department_id, cost_center_id, expense_type,
     required_by_date, status, scope, flow_kind, estimated_amount, currency)
  SELECT 'PR-VERIFY-027', v_user, cc.department_id, cc.id, 'OPEX',
         current_date, 'IN_PROCUREMENT_REVIEW', 'verification', 'CAPITAL', 0, 'PKR'
    FROM core.cost_centers cc LIMIT 1
  RETURNING id INTO v_pr;

  -- cs_round defaults to 1
  INSERT INTO proc.comparative_statements (cs_number, pr_id, state, generated_by_user_id)
  VALUES ('CS-027-R1', v_pr, 'Generated', v_user)
  RETURNING id, cs_round INTO v_cs1, v_round;
  IF v_round <> 1 THEN RAISE EXCEPTION 'FAIL: cs_round default is %, expected 1', v_round; END IF;
  RAISE NOTICE 'OK: a new CS defaults to round 1';

  -- decision 2A: a SECOND round is allowed on the same PR...
  INSERT INTO proc.comparative_statements (cs_number, pr_id, cs_round, state, generated_by_user_id)
  VALUES ('CS-027-R2', v_pr, 2, 'Generated', v_user) RETURNING id INTO v_cs2;
  RAISE NOTICE 'OK: round 2 can coexist with round 1 (UNIQUE is now (pr_id, cs_round))';

  -- ...but the SAME round twice is not, and that is what keeps the lock
  -- terminal per round.
  BEGIN
    INSERT INTO proc.comparative_statements (cs_number, pr_id, cs_round, state, generated_by_user_id)
    VALUES ('CS-027-R1-DUP', v_pr, 1, 'Generated', v_user);
    RAISE EXCEPTION 'FAIL: a duplicate round was allowed for the same PR';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK: a duplicate round on the same PR is rejected';
  END;

  -- the latest round is the one in force
  IF proc.fn_latest_cs_round(v_pr) <> 2 THEN
    RAISE EXCEPTION 'FAIL: fn_latest_cs_round returned %, expected 2', proc.fn_latest_cs_round(v_pr);
  END IF;
  RAISE NOTICE 'OK: fn_latest_cs_round resolves the live round to 2';

  -- round 1 is still exactly as it was: the MC's objection has an answer
  IF NOT EXISTS (SELECT 1 FROM proc.comparative_statements
                  WHERE id = v_cs1 AND cs_number = 'CS-027-R1' AND cs_round = 1) THEN
    RAISE EXCEPTION 'FAIL: round 1 was not preserved alongside round 2';
  END IF;
  RAISE NOTICE 'OK: the rejected round is preserved as evidence, not overwritten';
END $$;
ROLLBACK;

\echo ''
\echo 'â”€â”€ 8. the full governance chain is walkable â”€â”€'
BEGIN;
DO $$
DECLARE
  v_pr uuid; v_user uuid;
  v_stage text;
  v_path text[] := ARRAY[
    'IN_PROCUREMENT_REVIEW','QUOTES_RECEIVED','CS_LOCKED','MC_APPROVED',
    'CFO_APPROVED','PACK_LOCKED','D365_PUSHED'
  ];
  i int;
BEGIN
  SELECT id INTO v_user FROM core.users WHERE role = 'requester' LIMIT 1;
  INSERT INTO proc.purchase_requisitions
    (pr_number, requester_user_id, department_id, cost_center_id, expense_type,
     required_by_date, status, scope, flow_kind, estimated_amount, currency)
  SELECT 'PR-VERIFY-027-CHAIN', v_user, cc.department_id, cc.id, 'OPEX',
         current_date, 'IN_PROCUREMENT_REVIEW', 'verification', 'CAPITAL', 0, 'PKR'
    FROM core.cost_centers cc LIMIT 1
  RETURNING id INTO v_pr;

  FOR i IN 1..array_length(v_path,1)-1 LOOP
    UPDATE proc.purchase_requisitions SET status = v_path[i+1] WHERE id = v_pr;
    RAISE NOTICE 'OK: % -> %', v_path[i], v_path[i+1];
  END LOOP;

  SELECT status INTO v_stage FROM proc.purchase_requisitions WHERE id = v_pr;
  IF v_stage <> 'D365_PUSHED' THEN RAISE EXCEPTION 'FAIL: chain ended at %', v_stage; END IF;
END $$;
ROLLBACK;

\echo ''
\echo 'â”€â”€ 9. FAST_TRACK lands on PACK_LOCKED, skipping MC and CFO â”€â”€'
-- Prototype line 7205-7207: csLock() on a FAST_TRACK route sets stage directly
-- to PACK_LOCKED. The MC and CFO stages must be bypassable from procurement.
BEGIN;
DO $$
DECLARE v_pr uuid; v_user uuid;
BEGIN
  SELECT id INTO v_user FROM core.users WHERE role = 'requester' LIMIT 1;
  INSERT INTO proc.purchase_requisitions
    (pr_number, requester_user_id, department_id, cost_center_id, expense_type,
     required_by_date, status, scope, flow_kind, estimated_amount, currency)
  SELECT 'PR-VERIFY-027-FT', v_user, cc.department_id, cc.id, 'CAPEX',
         current_date, 'IN_PROCUREMENT_REVIEW', 'verification', 'CAPITAL', 200000, 'PKR'
    FROM core.cost_centers cc LIMIT 1
  RETURNING id INTO v_pr;

  UPDATE proc.purchase_requisitions SET status = 'PACK_LOCKED' WHERE id = v_pr;
  RAISE NOTICE 'OK: IN_PROCUREMENT_REVIEW -> PACK_LOCKED (the FAST_TRACK shortcut)';
  UPDATE proc.purchase_requisitions SET status = 'D365_PUSHED' WHERE id = v_pr;
  RAISE NOTICE 'OK: PACK_LOCKED -> D365_PUSHED';
END $$;
ROLLBACK;

\echo ''
\echo 'â”€â”€ 10. the two rejects go in OPPOSITE directions â”€â”€'
-- MC reject  -> back to sourcing (prototype 7230: stage = QUOTES_RECEIVED)
-- CFO reject -> back to the MC gate (prototype 7275: stage = CS_LOCKED)
-- Collapsing these into one rule loses the distinction the prototype makes.
BEGIN;
DO $$
DECLARE v_pr uuid; v_user uuid;
BEGIN
  SELECT id INTO v_user FROM core.users WHERE role = 'requester' LIMIT 1;

  INSERT INTO proc.purchase_requisitions
    (pr_number, requester_user_id, department_id, cost_center_id, expense_type,
     required_by_date, status, scope, flow_kind, estimated_amount, currency)
  SELECT 'PR-VERIFY-027-MCREJ', v_user, cc.department_id, cc.id, 'OPEX',
         current_date, 'CS_LOCKED', 'verification', 'CAPITAL', 0, 'PKR'
    FROM core.cost_centers cc LIMIT 1 RETURNING id INTO v_pr;
  UPDATE proc.purchase_requisitions SET status = 'QUOTES_RECEIVED' WHERE id = v_pr;
  RAISE NOTICE 'OK: MC reject  CS_LOCKED -> QUOTES_RECEIVED (CS must be revised)';

  UPDATE proc.purchase_requisitions SET status = 'IN_PROCUREMENT_REVIEW' WHERE id = v_pr;
  UPDATE proc.purchase_requisitions SET status = 'CS_LOCKED'   WHERE id = v_pr;
  UPDATE proc.purchase_requisitions SET status = 'MC_APPROVED' WHERE id = v_pr;
  UPDATE proc.purchase_requisitions SET status = 'CS_LOCKED'   WHERE id = v_pr;
  RAISE NOTICE 'OK: CFO reject MC_APPROVED -> CS_LOCKED (back to the MC gate)';
END $$;
ROLLBACK;

\echo ''
\echo 'â”€â”€ 11. illegal governance jumps are still refused â”€â”€'
-- A permissive trigger would let the PR skip governance entirely, which is the
-- exact failure the whole wave exists to prevent.
BEGIN;
DO $$
DECLARE v_pr uuid; v_user uuid; v_blocked int := 0;
BEGIN
  SELECT id INTO v_user FROM core.users WHERE role = 'requester' LIMIT 1;
  INSERT INTO proc.purchase_requisitions
    (pr_number, requester_user_id, department_id, cost_center_id, expense_type,
     required_by_date, status, scope, flow_kind, estimated_amount, currency)
  SELECT 'PR-VERIFY-027-BAD', v_user, cc.department_id, cc.id, 'OPEX',
         current_date, 'IN_PROCUREMENT_REVIEW', 'verification', 'CAPITAL', 0, 'PKR'
    FROM core.cost_centers cc LIMIT 1 RETURNING id INTO v_pr;

  -- procurement -> CFO: skips the CS and the MC entirely
  BEGIN
    UPDATE proc.purchase_requisitions SET status = 'CFO_APPROVED' WHERE id = v_pr;
  EXCEPTION WHEN check_violation THEN v_blocked := v_blocked + 1;
    RAISE NOTICE 'OK: refused  IN_PROCUREMENT_REVIEW -> CFO_APPROVED (skips the MC)';
  END;

  -- MC gate -> pack: skips the CFO
  UPDATE proc.purchase_requisitions SET status = 'CS_LOCKED'   WHERE id = v_pr;
  UPDATE proc.purchase_requisitions SET status = 'MC_APPROVED' WHERE id = v_pr;
  BEGIN
    UPDATE proc.purchase_requisitions SET status = 'PACK_LOCKED' WHERE id = v_pr;
  EXCEPTION WHEN check_violation THEN v_blocked := v_blocked + 1;
    RAISE NOTICE 'OK: refused  MC_APPROVED -> PACK_LOCKED (skips the CFO)';
  END;

  -- a pushed PO is not reversible: you cannot walk the pack back
  -- D365_PUSHED -> Fulfilled is the one legal exit (it means goods arrived).
  UPDATE proc.purchase_requisitions SET status = 'CFO_APPROVED' WHERE id = v_pr;
  UPDATE proc.purchase_requisitions SET status = 'PACK_LOCKED'  WHERE id = v_pr;
  UPDATE proc.purchase_requisitions SET status = 'D365_PUSHED' WHERE id = v_pr;
  BEGIN
    UPDATE proc.purchase_requisitions SET status = 'PACK_LOCKED' WHERE id = v_pr;
    RAISE EXCEPTION 'FAIL: a pushed PO was allowed to go back to being un-pushed';
  EXCEPTION WHEN check_violation THEN v_blocked := v_blocked + 1;
    RAISE NOTICE 'OK: refused  D365_PUSHED -> PACK_LOCKED (a pushed PO is not reversible)';
  END;
  -- ...but goods arriving IS the legal exit, and must not be broken
  UPDATE proc.purchase_requisitions SET status = 'Fulfilled' WHERE id = v_pr;
  RAISE NOTICE 'OK: allowed  D365_PUSHED -> Fulfilled (goods arrived)';

  IF v_blocked <> 3 THEN RAISE EXCEPTION 'FAIL: expected 3 refusals, got %', v_blocked; END IF;
  RAISE NOTICE 'OK: % illegal governance jumps refused', v_blocked;
END $$;
ROLLBACK;

\echo ''
\echo 'â”€â”€ 12. the CHECK and the trigger agree on the governance stages â”€â”€'
-- The recurring drift (migrations 018/019/020): a stage storable by the CHECK
-- but unreachable by the trigger. Both lists are read back out of the
-- catalogue here so a future migration that widens one without the other is
-- caught by this script rather than in production.
WITH trig AS (
  SELECT pg_get_functiondef(p.oid) AS def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'proc' AND p.proname = 'fn_check_pr_transition'
), chk AS (
  SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
   WHERE conname = 'purchase_requisitions_status_check'
     AND connamespace = 'proc'::regnamespace
)
SELECT s.stage,
       (chk.def LIKE '%' || s.stage || '%') AS in_check,
       (trig.def LIKE '%' || s.stage || '%') AS in_trigger
  FROM unnest(ARRAY['QUOTES_RECEIVED','CS_LOCKED','MC_APPROVED','CFO_APPROVED','PACK_LOCKED']) AS s(stage),
       chk, trig
 ORDER BY s.stage;
-- expected: every row true / true

\echo ''
\echo 'â”€â”€ 13. indexes created by 027 â”€â”€'
SELECT indexname FROM pg_indexes
 WHERE (schemaname, indexname) IN
   (('workflow','idx_mc_sessions_pr_open'),
    ('workflow','ux_mc_panel_single_chair'),
    ('proc','idx_cs_pr_round'),
    ('proc','idx_d365_sync_pr_observed'))
 ORDER BY indexname;

\echo ''
\echo 'â•â•â• 027 verification complete â•â•â•'
