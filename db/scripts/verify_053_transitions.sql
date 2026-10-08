-- verify_053_transitions.sql — asserts the shape of proc.fn_check_pr_transition().
--
-- Two things are checked, and both matter:
--
--   1. Every edge the prototype/027 state machine requires is ALLOWED.
--      A missing edge is the failure mode this whole file exists to catch:
--      `IN_HOD_REVIEW` was admitted by the status CHECK constraint and named in
--      the engine, yet no transition reached it, so the stage was legal
--      everywhere except the one place that mattered.
--
--   2. A sample of nonsense edges is still REFUSED. Without this half the guard
--      could be "fixed" by permitting everything, which would pass check 1 while
--      destroying the state machine.
--
-- Edges are written as literal pairs, NOT as two parallel arrays. Two parallel
-- arrays are walked positionally, so one stray element silently shifts every
-- pair after it — this file was wrong twice that way before being rewritten.

\set ON_ERROR_STOP on

-- Probe helper. Each call runs in its own subtransaction and is always
-- discarded, so probing never mutates a PR.
CREATE OR REPLACE FUNCTION pg_temp.t_try(f text, t text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v_probe uuid; v_res text;
BEGIN
  SELECT id INTO v_probe FROM proc.purchase_requisitions LIMIT 1;
  BEGIN
    UPDATE proc.purchase_requisitions SET status = 'Draft'    WHERE id = v_probe;
    UPDATE proc.purchase_requisitions SET status = f          WHERE id = v_probe;
    UPDATE proc.purchase_requisitions SET status = t          WHERE id = v_probe;
    v_res := 'ALLOWED';
  EXCEPTION WHEN check_violation THEN
    v_res := 'REFUSED';
  END;
  RETURN v_res;
END;
$$;

DO $$
DECLARE
  edges text[][];
  edge  text[];
  bad   text := '';
  n_ok  int := 0;
  n_bad int := 0;
  i     int;

  -- ── must stay ALLOWED ────────────────────────────────────────────────
  allow_edges text[][] := ARRAY[
    -- draft / submit
    ARRAY['Draft','Submitted'], ARRAY['Draft','Cancelled'],
    -- submit auto-routes into HOD review (migration 053)
    ARRAY['Submitted','IN_HOD_REVIEW'],
    ARRAY['Submitted','IN_PROCUREMENT_REVIEW'],
    ARRAY['Submitted','IN_WAREHOUSE_CHECK'],
    ARRAY['Submitted','IN_IT_REVIEW'], ARRAY['Submitted','IN_WAREHOUSE'],
    ARRAY['Submitted','Rejected'], ARRAY['Submitted','REJECTED'],
    ARRAY['Submitted','Cancelled'],
    -- HOD decision outcomes + line-rule targets
    ARRAY['IN_HOD_REVIEW','IN_PROCUREMENT_REVIEW'],
    ARRAY['IN_HOD_REVIEW','IN_WAREHOUSE'],
    ARRAY['IN_HOD_REVIEW','IN_IT_REVIEW'],
    ARRAY['IN_HOD_REVIEW','IN_WAREHOUSE_CHECK'],
    ARRAY['IN_HOD_REVIEW','Rejected'], ARRAY['IN_HOD_REVIEW','REJECTED'],
    ARRAY['IN_HOD_REVIEW','Cancelled'],
    -- hold / revert-for-revision, and the resume back out of it
    ARRAY['IN_HOD_REVIEW','ON_HOLD'],
    ARRAY['ON_HOLD','IN_HOD_REVIEW'], ARRAY['ON_HOLD','Cancelled'],
    -- split children re-entering the main flow
    ARRAY['IN_IT_REVIEW','IN_PROCUREMENT_REVIEW'],
    ARRAY['IN_WAREHOUSE','IN_PROCUREMENT_REVIEW'],
    ARRAY['IN_WAREHOUSE_CHECK','IN_PROCUREMENT_REVIEW'],
    -- procurement + governance chain (027)
    ARRAY['IN_PROCUREMENT_REVIEW','IN_COST_CENTER_APPROVAL'],
    ARRAY['IN_PROCUREMENT_REVIEW','QUOTES_RECEIVED'],
    ARRAY['IN_PROCUREMENT_REVIEW','CS_LOCKED'],
    ARRAY['IN_PROCUREMENT_REVIEW','PACK_LOCKED'],
    ARRAY['IN_COST_CENTER_APPROVAL','IN_FINANCE_REVIEW'],
    ARRAY['IN_FINANCE_REVIEW','IN_MANAGEMENT_REVIEW'],
    ARRAY['IN_FINANCE_REVIEW','READY_FOR_D365'],
    ARRAY['IN_MANAGEMENT_REVIEW','READY_FOR_D365'],
    ARRAY['QUOTES_RECEIVED','CS_LOCKED'],
    ARRAY['QUOTES_RECEIVED','IN_PROCUREMENT_REVIEW'],
    ARRAY['CS_LOCKED','MC_APPROVED'], ARRAY['CS_LOCKED','QUOTES_RECEIVED'],
    ARRAY['CS_LOCKED','PACK_LOCKED'],
    ARRAY['MC_APPROVED','CFO_APPROVED'], ARRAY['MC_APPROVED','CS_LOCKED'],
    ARRAY['CFO_APPROVED','PACK_LOCKED'], ARRAY['PACK_LOCKED','D365_PUSHED'],
    ARRAY['READY_FOR_D365','D365_PUSHED'], ARRAY['D365_PUSHED','Fulfilled'],
    ARRAY['Rejected','Cancelled'], ARRAY['Fulfilled','Cancelled']
  ];

  -- ── must stay REFUSED (the guard is not a no-op) ────────────────────
  deny_edges text[][] := ARRAY[
    ARRAY['Draft','IN_PROCUREMENT_REVIEW'],
    ARRAY['Draft','IN_HOD_REVIEW'],
    ARRAY['IN_MANAGEMENT_REVIEW','D365_PUSHED'],
    ARRAY['CFO_APPROVED','D365_PUSHED'],
    ARRAY['IN_FINANCE_REVIEW','CS_LOCKED'],
    ARRAY['D365_PUSHED','READY_FOR_D365'],
    ARRAY['ON_HOLD','IN_PROCUREMENT_REVIEW'],
    ARRAY['PACK_LOCKED','MC_APPROVED']
  ];
BEGIN
  -- FOREACH cannot iterate a text[][] (the loop variable would itself be an
  -- array type), so walk the outer array by index instead.
  FOR i IN 1..array_length(allow_edges, 1) LOOP
    edge := allow_edges[i];
    IF pg_temp.t_try(edge[1], edge[2]) <> 'ALLOWED' THEN
      bad  := bad || ' [REFUSED but must be allowed: ' || edge[1] || ' -> ' || edge[2] || ']';
      n_bad := n_bad + 1;
    ELSE
      n_ok := n_ok + 1;
    END IF;
  END LOOP;

  FOR i IN 1..array_length(deny_edges, 1) LOOP
    edge := deny_edges[i];
    IF pg_temp.t_try(edge[1], edge[2]) <> 'REFUSED' THEN
      bad  := bad || ' [ALLOWED but must be refused: ' || edge[1] || ' -> ' || edge[2] || ']';
      n_bad := n_bad + 1;
    ELSE
      n_ok := n_ok + 1;
    END IF;
  END LOOP;

  IF bad <> '' THEN
    RAISE EXCEPTION 'transition table is wrong:%', bad;
  END IF;

  RAISE NOTICE 'transition table verified: % edges OK (% allowed, % refused)',
    n_ok, array_length(allow_edges, 1), array_length(deny_edges, 1);
END;
$$;
