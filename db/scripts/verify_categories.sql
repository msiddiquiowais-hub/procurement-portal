-- ─────────────────────────────────────────────────────────────────────────────
-- verify_categories.sql
--
-- Two jobs in one file, so there is a single command to run after touching
-- either side of the category vocabulary:
--
--   1. POPULATE  — re-seed core.categories from the canonical list. Safe to
--                  run repeatedly; it is an upsert, never a truncate. This is
--                  the "quick way to populate" — no migration needed after an
--                  admin adds a category through the UI or a data fix.
--   2. DRIFT     — prove the database and the workflow engine still agree.
--
-- WHY THE DRIFT CHECK IS THE IMPORTANT HALF
-- ------------------------------------------
-- core.categories.code is the value stored on proc.pr_lines.category and matched
-- by the line rules. LIGHT_ITEM_CATEGORY_IDS in
-- packages/workflow-engine/src/categories.ts is the same vocabulary in
-- TypeScript. They are two copies of one list, and nothing in the database can
-- see the TypeScript one — so the day someone adds a category to the engine and
-- forgets the database, the picker for that category silently disappears from
-- the form and the rule that needs it stops firing. This file is how you find
-- out before a requester does.
--
-- Run:  docker exec -i procurement-portal-db psql -U proc -d procurementDB \
--         -v ON_ERROR_STOP=1 -f - < db/scripts/verify_categories.sql
-- ─────────────────────────────────────────────────────────────────────────────

\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path = core, proc, public;

-- ═══ 1. populate ═════════════════════════════════════════════════════════════
-- Labels and descriptions are transcribed EXACTLY from LIGHT_ITEM_CATEGORIES, not
-- paraphrased. scripts/prove_w5j_categories.mjs asserts this list against the
-- live engine export, so a divergence here fails the proof run.
INSERT INTO core.categories (code, name, description) VALUES
  ('IT_HARDWARE',           'IT hardware',          'Laptops, desktops, servers, networking equipment.'),
  ('IT_SOFTWARE',           'IT software',          'Licensed software, SaaS subscriptions, cloud services.'),
  ('OFFICE_SUPPLIES',       'Office supplies',      'Stationery, printer consumables, general consumables.'),
  ('WAREHOUSE_ACCESSORY',   'Warehouse accessory',  'Docks, cables, bags, mounts -- bundled or standalone.'),
  ('MACHINERY',             'Machinery / plant',    'Production-line machinery, tooling, heavy equipment.'),
  ('PROFESSIONAL_SERVICES', 'Professional services','Consultancy, audit, legal, training.'),
  ('FACILITIES',            'Facilities / FM',      'HVAC, plumbing, electrical, building maintenance.'),
  ('MARKETING',             'Marketing / branding', 'Campaigns, events, collateral, signage.'),
  ('OTHER',                 'Other',                'Catch-all when no category fits.')
ON CONFLICT (code) DO UPDATE
   SET name        = EXCLUDED.name,
       description = EXCLUDED.description,
       active      = true;

\echo ''
\echo '── populated core.categories ──'

-- ═══ 2. drift check ══════════════════════════════════════════════════════════
-- The engine's nine, spelled out here. This list is the ONLY thing this file
-- shares with the TypeScript, and it is deliberate: it is a transcription, so it
-- must be compared against the real thing.
--
-- If you add a category to LIGHT_ITEM_CATEGORIES, add it here too, then run
-- scripts/prove_w5j_categories.mjs, which compares this file's expectation with
-- the ACTUAL engine export rather than with another copy of it.

-- 2a. The engine knows every category the database has. A category in the
--     database that the engine does not know would be offered in the picker and
--     then match no rule — a dead option presented as a live one.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
    FROM core.categories c
   WHERE c.active
     AND c.code <> ALL (ARRAY['IT_HARDWARE','IT_SOFTWARE','OFFICE_SUPPLIES',
                               'WAREHOUSE_ACCESSORY','MACHINERY',
                               'PROFESSIONAL_SERVICES','FACILITIES',
                               'MARKETING','OTHER']);
  IF n > 0 THEN
    RAISE EXCEPTION
      'verify_categories: % active category/ies in core.categories are not in LIGHT_ITEM_CATEGORY_IDS. '
      'They would appear in the picker and match no routing rule.', n;
  END IF;
  RAISE NOTICE 'ok: every active core.categories row is a known engine category';
END $$;

-- 2b. The database has every category the engine needs. Missing ones are worse
--     than extra: the rule that depends on the missing category exists and can
--     no longer be selected by a requester, so that branch is unreachable.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
    FROM unnest(ARRAY['IT_HARDWARE','IT_SOFTWARE','OFFICE_SUPPLIES',
                      'WAREHOUSE_ACCESSORY','MACHINERY',
                      'PROFESSIONAL_SERVICES','FACILITIES',
                      'MARKETING','OTHER']) AS want(code)
   WHERE NOT EXISTS (SELECT 1 FROM core.categories c
                      WHERE c.code = want.code AND c.active);
  IF n > 0 THEN
    RAISE EXCEPTION
      'verify_categories: % engine category/ies are missing from core.categories. '
      'The picker cannot offer them and their routing rules cannot fire.', n;
  END IF;
  RAISE NOTICE 'ok: core.categories covers every engine category';
END $$;

-- 2c. No stored line carries a category the table does not know. The foreign
--     key guarantees this going forward; this reports the state, so a table
--     that was ever written before the key existed cannot hide here.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
    FROM proc.pr_lines l
   WHERE l.category IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM core.categories c WHERE c.code = l.category);
  IF n > 0 THEN
    RAISE EXCEPTION
      'verify_categories: % stored line(s) carry a category absent from core.categories', n;
  END IF;
  RAISE NOTICE 'ok: no stored line carries an unknown category';
END $$;

-- 2d. Every catalogue item sits in a real category. Before migration 047 an
--     item could hold any string at all, and PKB-SRV-001 in fact held
--     'SERVICES' — a name nothing else in the system recognised, so its lines
--     matched no rule.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
    FROM core.items i
   WHERE i.active
     AND (i.category IS NULL OR NOT EXISTS (SELECT 1 FROM core.categories c WHERE c.code = i.category));
  IF n > 0 THEN
    RAISE EXCEPTION
      'verify_categories: % active catalogue item(s) have a null or unknown category', n;
  END IF;
  RAISE NOTICE 'ok: every active catalogue item sits in a known category';
END $$;

-- 2e. The categories the live routing rules actually branch on must be
--     selectable. This is the check that would have caught sourcing the
--     dropdown from core.items instead of core.categories.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
    FROM (
      SELECT jsonb_array_elements_text(rule->'category') AS code
        FROM workflow.steps_config s, jsonb_array_elements(s.payload->'lineRules') AS rule
    ) wanted
   WHERE NOT EXISTS (SELECT 1 FROM core.categories c WHERE c.code = wanted.code AND c.active);
  IF n > 0 THEN
    RAISE EXCEPTION
      'verify_categories: % category/ies referenced by a live line rule are not offered in the picker', n;
  END IF;
  RAISE NOTICE 'ok: every category a live line rule branches on is selectable';
END $$;

\echo ''
\echo '── current state ──'
SELECT code, name, active FROM core.categories ORDER BY code;

SELECT c.code,
       (SELECT count(*) FROM core.items i WHERE i.category = c.code)          AS catalogue_items,
       (SELECT count(*) FROM proc.pr_lines l WHERE l.category = c.code)       AS stored_lines
  FROM core.categories c
 ORDER BY c.code;

COMMIT;
\echo ''
\echo 'verify_categories: all checks passed'
