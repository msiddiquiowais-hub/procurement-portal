-- 035_threshold_wiring_and_capex_opex_bands.sql
-- Phase: Wave 5 — Track B completion (two architectural decisions)
-- Purpose: (1) make the GLOBAL management threshold genuinely drive routing, and
--          (2) split the authority matrix into the two Capex/Opex band tables the
--          blueprint specifies.
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Both changes were raised as findings during Track B and decided explicitly.
--
-- ── PART A: THE GLOBAL THRESHOLD NOW DRIVES ROUTING ────────────────────────
-- The engine has always supported `aboveMgtThreshold` / `belowMgtThreshold` and
-- has always been handed `workflow.config.management_threshold`. But ZERO live
-- steps used them. The management gate was expressed instead as a PAIR of steps
-- carrying DUPLICATED conditionValues:
--
--     finance_review   amountGTE 1,000,000  -> IN_MANAGEMENT_REVIEW
--     finance_release  amountLT  1,000,000  -> READY_FOR_D365
--
-- So the number the settings screen edits changed what the PR screen DISPLAYED
-- and nothing about routing — a dummy field on a dynamic workflow. Worse, the
-- duplicated pair could be edited asymmetrically: raising `finance_review` alone
-- to 50,000,000 while `finance_release` stayed at 1,000,000 leaves no step
-- matching a PKR 2,000,000 PR at all, and it routes to NONE. A single global
-- value makes that dead band STRUCTURALLY UNREPRESENTABLE, which is the real
-- reason to make this change rather than a tidiness fix.
--
-- Behaviour is preserved except at one knife edge: `amountGTE` is `>=` while
-- `aboveMgtThreshold` is `>`. A PR of EXACTLY 1,000,000 previously cleared
-- Management and will now go straight to CFO release. No test in the suite
-- routes that amount (verified: the harnesses all use 2,000,000), and the web
-- gate in pr/[id].tsx was corrected from `>=` to `>` in the same change so the
-- screen and the engine agree.
--
-- Step KEYS are deliberately unchanged. They are the stable lookup key used by
-- the routing table, the API and three existing harnesses; renaming them would
-- churn identity for no behavioural gain. The human-facing `name` is corrected.
--
-- ── PART B: CAPEX AND OPEX BAND TABLES ─────────────────────────────────────
-- Blueprint Part 8.1 specifies TWO band tables, not one. The single
-- amount-banded table seeded from PRD §11.1 is retired by setting
-- active = false rather than deleting it: the rows are removed from the active
-- set, but the history and the ability to roll back are preserved. Deleting
-- seeded authority data is not a migration's decision to take silently.
--
-- Role-name mapping. The blueprint writes approvers in prose ("HOD + Procurement
-- + MC + CFO + Board"). These are stored as the system's canonical role keys, so
-- they work with roleAllowed(). "Board" has no exact key; `management` is the
-- closest available, and the BOARD routing key preserves the concept on the row
-- itself.
--
--   "Department HOD" -> hod      "MC"  -> mc
--   "Procurement"    -> procurement   "CFO" -> cfo
--   "Board"          -> management  (documented approximation)
--
-- Idempotency: every statement is an upsert or an idempotent UPDATE, and the
-- post-condition asserts the resulting shape rather than assuming it.

BEGIN;

SET LOCAL search_path = core, proc, public;

-- ─── PART A ────────────────────────────────────────────────────────────────
-- Swap both steps onto the global predicate and DROP the duplicated numbers.
-- `payload - 'conditionValue'` is what retires them: the key is removed, not
-- zeroed, so nothing can later read a stale threshold off these rows.

UPDATE workflow.steps_config
   SET payload = jsonb_set(payload - 'conditionValue', '{when}', '"aboveMgtThreshold"'::jsonb, true),
       updated_at = now()
 WHERE id = 'finance_review';

UPDATE workflow.steps_config
   SET payload = jsonb_set(payload - 'conditionValue', '{when}', '"belowMgtThreshold"'::jsonb, true),
       updated_at = now()
 WHERE id = 'finance_release';

-- The keys stay; the names should now describe what the steps actually do.
UPDATE workflow.steps_config
   SET payload = jsonb_set(payload, '{name}', '"Management review (global threshold)"'::jsonb, true),
       updated_at = now()
 WHERE id = 'finance_review';

UPDATE workflow.steps_config
   SET payload = jsonb_set(payload, '{name}', '"CFO release (below global threshold)"'::jsonb, true),
       updated_at = now()
 WHERE id = 'finance_release';

-- ─── PART B ────────────────────────────────────────────────────────────────

-- The blueprint's third column: `Routing key`. FAST_TRACK / STANDARD / BOARD,
-- which is what deriveRouting() already computes.
ALTER TABLE core.authority_matrix
  ADD COLUMN IF NOT EXISTS routing_key text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'authority_matrix_routing_key_check'
       AND conrelid = 'core.authority_matrix'::regclass
  ) THEN
    ALTER TABLE core.authority_matrix
      ADD CONSTRAINT authority_matrix_routing_key_check
      CHECK (routing_key IS NULL OR routing_key IN ('FAST_TRACK','STANDARD','BOARD'));
  END IF;
END $$;

-- Retire the PRD §11.1 single-table bands. active = false, not DELETE.
UPDATE core.authority_matrix SET active = false WHERE category IS NULL;

-- ── Capex bands (blueprint 8.1) ───────────────────────────────────────────
-- Up to PKR 250 K | Department HOD only                | FAST_TRACK · 1 stage
-- PKR 250 K – 1 Cr  | HOD + Procurement + MC + CFO     | STANDARD  · 5 stages
-- Above PKR 1 Cr    | HOD + Procurement + MC + CFO + Board | BOARD  · 6 stages
INSERT INTO core.authority_matrix
  (amount_min, amount_max, category, required_roles, effective_from, routing_key, active)
VALUES
  (       0,    250000, 'CAPEX', ARRAY['hod'],                                                  date '2026-01-01', 'FAST_TRACK', true),
  (  250000,  10000000, 'CAPEX', ARRAY['hod','procurement','mc','cfo'],                          date '2026-01-01', 'STANDARD',   true),
  ( 10000000, 9999999999,'CAPEX', ARRAY['hod','procurement','mc','cfo','management'],            date '2026-01-01', 'BOARD',      true)
ON CONFLICT ON CONSTRAINT authority_matrix_natural_key
DO UPDATE SET routing_key = EXCLUDED.routing_key, active = EXCLUDED.active;

-- ── Opex bands (blueprint 8.1) ────────────────────────────────────────────
-- Up to PKR 100 K  | Department HOD only       | FAST_TRACK · 1 stage
-- PKR 100 K – 25 L | HOD + Procurement         | FAST_TRACK · 2 stages
-- Above PKR 25 L   | HOD + Procurement + MC + CFO | STANDARD · 5 stages
INSERT INTO core.authority_matrix
  (amount_min, amount_max, category, required_roles, effective_from, routing_key, active)
VALUES
  (       0,    100000, 'OPEX', ARRAY['hod'],                                date '2026-01-01', 'FAST_TRACK', true),
  (  100000,   2500000, 'OPEX', ARRAY['hod','procurement'],                  date '2026-01-01', 'FAST_TRACK', true),
  ( 2500000, 9999999999,'OPEX', ARRAY['hod','procurement','mc','cfo'],       date '2026-01-01', 'STANDARD',   true)
ON CONFLICT ON CONSTRAINT authority_matrix_natural_key
DO UPDATE SET routing_key = EXCLUDED.routing_key, active = EXCLUDED.active;

-- ─── Post-condition check ──────────────────────────────────────────────────

DO $$
DECLARE
  n_mgt_steps  int;
  leftover     int;
  capex_bands  int;
  opex_bands   int;
  legacy_active int;
  missing_keys int;
BEGIN
  -- ── Part A ──
  SELECT count(*) INTO n_mgt_steps
    FROM workflow.steps_config
   WHERE payload->>'when' IN ('aboveMgtThreshold','belowMgtThreshold');
  IF n_mgt_steps <> 2 THEN
    RAISE EXCEPTION 'migration 035: expected 2 steps on the global threshold predicates, found %', n_mgt_steps;
  END IF;

  -- The duplicated numbers must be GONE, not merely ignored. A leftover
  -- conditionValue on these rows is a second place an admin could think to
  -- edit the threshold, which is the confusion this migration exists to remove.
  SELECT count(*) INTO leftover
    FROM workflow.steps_config
   WHERE id IN ('finance_review','finance_release')
     AND payload ? 'conditionValue';
  IF leftover > 0 THEN
    RAISE EXCEPTION 'migration 035: % step(s) still carry a duplicated conditionValue', leftover;
  END IF;

  -- The two steps must remain a complementary pair on the same global value.
  SELECT count(*) INTO missing_keys
    FROM (VALUES ('finance_review'),('finance_release')) v(k)
   WHERE NOT EXISTS (
     SELECT 1 FROM workflow.steps_config s
      WHERE s.id = v.k
        AND s.payload->>'from' = 'IN_FINANCE_REVIEW'
        AND s.payload->>'when' IN ('aboveMgtThreshold','belowMgtThreshold')
   );
  IF missing_keys > 0 THEN
    RAISE EXCEPTION 'migration 035: % complementary step(s) missing from IN_FINANCE_REVIEW', missing_keys;
  END IF;

  -- ── Part B ──
  SELECT count(*) INTO capex_bands FROM core.authority_matrix
   WHERE category = 'CAPEX' AND active;
  IF capex_bands <> 3 THEN
    RAISE EXCEPTION 'migration 035: expected 3 active Capex bands, found %', capex_bands;
  END IF;

  SELECT count(*) INTO opex_bands FROM core.authority_matrix
   WHERE category = 'OPEX' AND active;
  IF opex_bands <> 3 THEN
    RAISE EXCEPTION 'migration 035: expected 3 active Opex bands, found %', opex_bands;
  END IF;

  -- Retired, not deleted.
  SELECT count(*) INTO legacy_active FROM core.authority_matrix
   WHERE category IS NULL AND active;
  IF legacy_active > 0 THEN
    RAISE EXCEPTION 'migration 035: % legacy NULL-category band(s) are still active', legacy_active;
  END IF;

  -- Every active band must carry a routing key, or the screen's third column is
  -- blank and deriveRouting cannot be cross-checked against it.
  SELECT count(*) INTO missing_keys
    FROM core.authority_matrix
   WHERE active AND routing_key IS NULL;
  IF missing_keys > 0 THEN
    RAISE EXCEPTION 'migration 035: % active band(s) have no routing key', missing_keys;
  END IF;

  RAISE NOTICE 'migration 035 verified — 2 steps now driven by the global threshold (duplicated conditionValues removed), 3 Capex + 3 Opex active bands, legacy single-table bands retired';
END $$;

COMMIT;
