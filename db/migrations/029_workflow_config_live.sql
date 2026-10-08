-- 029_workflow_config_live.sql
-- Phase: Remediation Sprint — Step 1 (Backend Rewiring, Part 7)
-- Purpose: make workflow.steps_config genuinely load-bearing, and give the
--          management threshold a real home in the database.
--
-- WHY THIS MIGRATION EXISTS
-- ------------------------
-- Migration 008 created workflow.steps_config and seeded it, and nothing ever
-- read it. The engine resolved routing off the DEFAULT_WORKFLOW_STEPS array in
-- packages/workflow-engine/src/steps.ts, where each condition was a JS closure
-- that captured its own threshold. Three defects had to be corrected in the
-- seed before the engine could be pointed at this table without changing
-- behaviour or destroying working features. Each is a real bug, not a cleanup:
--
--   1. `from` WAS NEVER STORED.
--      The engine filters candidate steps by the PR's current stage, but
--      migration 008's jsonb_build_object calls omitted `from` entirely. With
--      no `from` in the database, the table cannot express which stage a step
--      applies to, so pointing the engine at it would have made every step
--      unscoped. Backfilled below from the canonical table.
--
--   2. THE FINANCE GATE WAS OFF BY ONE AT THE BOUNDARY — A GOVERNANCE BYPASS.
--      finance_review was seeded `when: 'amountGT'` and finance_release
--      `when: 'amountLTE'`, both with conditionValue 1000000. The closures they
--      were meant to replace were `>= 1000000` and `< 1000000`. As seeded, a PR
--      of EXACTLY PKR 1,000,000 failed amountGT (1000000 > 1000000 is false)
--      and passed amountLTE (1000000 <= 1000000 is true), routing straight to
--      READY_FOR_D365 and skipping the Management gate. Corrected to the
--      complementary pair amountGTE / amountLT below, which matches for exactly
--      one side of every amount, including the boundary itself.
--
--   3. NO ROW CARRIED lineRules.
--      The line-routing / PR auto-split feature (migration 020) added three
--      rules to the `hod_review` step in code only. Reading the step list from
--      the database would have silently returned a `hod_review` with no line
--      rules, disabling PR splitting for every request — a regression that
--      would have looked like a clean run. Backfilled below.
--
-- The management threshold becomes a first-class config row rather than a
-- module constant, so the Part 7 threshold editor has something to write to.

BEGIN;

SET LOCAL search_path = workflow, proc, public;

-- ─── 1. Live scalar configuration ─────────────────────────────────────────
-- Key/value so the Part 7 editor can grow new scalars without a migration.
-- `value` is jsonb so a future non-numeric setting needs no schema change.

CREATE TABLE IF NOT EXISTS workflow.config (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by_user_id uuid REFERENCES core.users(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT config_value_not_null CHECK (value IS NOT NULL)
);

INSERT INTO workflow.config (key, value)
VALUES ('management_threshold', to_jsonb(1000000::numeric))
ON CONFLICT (key) DO NOTHING;

-- ─── 2. Backfill `from` (defect 1) ────────────────────────────────────────
-- Applied per step id. '?' marks a side-channel step that matches any stage.
-- jsonb `||` merges, so extra keys already present (branchOf, quorum,
-- quorumSource) are preserved rather than clobbered.

UPDATE workflow.steps_config s
   SET payload = s.payload || jsonb_build_object('from', v.from_stage)
  FROM (VALUES
    ('rework',          '*'),
    ('reject',          '*'),
    ('fulfilled_stock', '*'),
    ('out_of_stock',    '*'),
    ('warehouse_check', 'Submitted'),
    ('hod_review',      'Submitted'),
    ('procurement',     'IN_PROCUREMENT_REVIEW'),
    ('cost_center',     'IN_COST_CENTER_APPROVAL'),
    ('finance_review',  'IN_FINANCE_REVIEW'),
    ('finance_release', 'IN_FINANCE_REVIEW'),
    ('management',      'IN_MANAGEMENT_REVIEW'),
    ('d365_push',       'READY_FOR_D365'),
    ('mc_approval',     'QUOTES_RECEIVED'),
    ('cfo_approval',    'CS_LOCKED')
  ) AS v(id, from_stage)
 WHERE s.id = v.id
   AND NOT (s.payload ? 'from');

-- ─── 3. Correct the finance gate boundary (defect 2) ──────────────────────
-- amountGT  -> amountGTE   (so the threshold amount itself clears Finance)
-- amountLTE -> amountLT    (so the threshold amount itself does not release)

UPDATE workflow.steps_config
   SET payload = payload || jsonb_build_object('when', 'amountGTE'),
       updated_at = now()
 WHERE id = 'finance_review'
   AND payload->>'when' = 'amountGT';

UPDATE workflow.steps_config
   SET payload = payload || jsonb_build_object('when', 'amountLT'),
       updated_at = now()
 WHERE id = 'finance_release'
   AND payload->>'when' = 'amountLTE';

-- ─── 4. Backfill lineRules on hod_review (defect 3) ───────────────────────
-- Mirrors DEFAULT_GOVERNANCE-free canonical hod_review.lineRules in
-- packages/workflow-engine/src/steps.ts. Guarded so a future admin edit to
-- these rules is never overwritten by a re-run of this migration.

UPDATE workflow.steps_config
   SET payload = payload || jsonb_build_object(
         'lineRules', jsonb_build_array(
           jsonb_build_object(
             'category',    jsonb_build_array('IT_HARDWARE', 'IT_SOFTWARE'),
             'amountOp',    '>',
             'amountValue', 100000,
             'routeTo',     'IN_IT_REVIEW',
             'actorRole',   'it_manager',
             'reason',      'High-value IT line > PKR 100,000 routes to IT Manager.'
           ),
           jsonb_build_object(
             'category',  jsonb_build_array('IT_HARDWARE', 'IT_SOFTWARE'),
             'routeTo',   'IN_PROCUREMENT_REVIEW',
             'actorRole', 'procurement',
             'reason',    'Standard IT line, route to Procurement for RFQ.'
           ),
           jsonb_build_object(
             'category',  jsonb_build_array('OFFICE_SUPPLIES', 'WAREHOUSE_ACCESSORY'),
             'routeTo',   'IN_WAREHOUSE',
             'actorRole', 'store_incharge',
             'reason',    'Standard accessory / supply, route to Warehouse for stock check.'
           )
         )
       ),
       updated_at = now()
 WHERE id = 'hod_review'
   AND NOT (payload ? 'lineRules');

-- ─── 5. Mirror order into the payload ─────────────────────────────────────
-- order_index remains authoritative for sorting; this makes each jsonb payload
-- self-describing so the grid and the engine cannot disagree about sequence.

UPDATE workflow.steps_config s
   SET payload = s.payload || jsonb_build_object('order', s.order_index)
 WHERE NOT (s.payload ? 'order');

-- ─── Post-condition check (inside the transaction, so a failure rolls back) ─
-- A migration that cannot prove its own effect is a migration nobody should
-- trust. This raises if any of the three defects survives.
DO $$
DECLARE
  bad_from      int;
  bad_gate      int;
  bad_gate_pair int;
  bad_rules     int;
BEGIN
  SELECT count(*) INTO bad_from
    FROM workflow.steps_config WHERE NOT (payload ? 'from');

  -- The complementary pair must be in place, or a boundary amount falls through.
  --
  -- EITHER shape is acceptable, and that flexibility is load-bearing. Migration
  -- 035 superseded the original amountGTE/amountLT pair with the global
  -- aboveMgtThreshold/belowMgtThreshold predicates, so asserting only the
  -- original keywords here would abort EVERY subsequent `db:migrate` at
  -- migration 029 — the same "a migration asserts a narrower final state than a
  -- later one guarantees" landmine as 019/020/027. What must be invariant is the
  -- COMPLEMENTARITY, not the particular keywords: two steps on the same source
  -- stage, one above the line and one below it.
  SELECT count(*) INTO bad_gate
    FROM workflow.steps_config s
   WHERE (s.id = 'finance_review'  AND s.payload->>'when'
            NOT IN ('amountGTE','aboveMgtThreshold'))
      OR (s.id = 'finance_release' AND s.payload->>'when'
            NOT IN ('amountLT','belowMgtThreshold'));

  -- And the two must genuinely be opposites on the SAME stage, whichever shape
  -- is live. This is the invariant that actually protects a request.
  SELECT count(*) INTO bad_gate_pair
    FROM workflow.steps_config a
    JOIN workflow.steps_config b ON b.id = 'finance_release'
   WHERE a.id = 'finance_review'
     AND a.payload->>'from' IS DISTINCT FROM b.payload->>'from';
  IF bad_gate_pair > 0 THEN
    RAISE EXCEPTION 'migration 029: the two finance gate steps sit on different source stages, so they cannot be complementary';
  END IF;

  -- NOTE: the "a global-threshold step must not also carry a shadow
  -- conditionValue" rule deliberately does NOT live here. It was introduced by
  -- migration 035, and backporting it into an older migration is how a replay
  -- order becomes a landmine: a database that 035 is about to repair would fail
  -- at 029 first, and 035 never gets to run. The rule is asserted in 035's own
  -- post-condition, in validateStepConfig on every save, and in the e2e suites.

  SELECT count(*) INTO bad_rules
    FROM workflow.steps_config
   WHERE id = 'hod_review' AND NOT (payload ? 'lineRules');

  IF bad_from > 0 THEN
    RAISE EXCEPTION 'migration 029: % step(s) still have no `from` stage', bad_from;
  END IF;
  IF bad_gate > 0 THEN
    RAISE EXCEPTION 'migration 029: finance gate is not the complementary amountGTE/amountLT pair';
  END IF;
  IF bad_rules > 0 THEN
    RAISE EXCEPTION 'migration 029: hod_review has no lineRules; PR splitting would be dead';
  END IF;

  RAISE NOTICE 'migration 029: routing config verified — all steps scoped, finance gate complementary, line rules present';
END $$;

COMMIT;
