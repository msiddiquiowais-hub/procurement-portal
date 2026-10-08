-- ─────────────────────────────────────────────────────────────────────────────
-- 051 - the vendor mapping speaks LINE CATEGORIES, not D365 item groups.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHAT CHANGED, AND WHY IT IS A REVERSAL
-- -------------------------------------
-- Migration 048 built `core.vendor_categories` against
-- `core.dimension_values` where dimension_key='ItemGroup' (IG-OFC, IG-LAPTOP,
-- ...). That was settled in this wave, and the reasoning was on the record: the
-- D365 payload ships these codes to F&O, and migration 037 seeds the array from
-- that same library.
--
-- The business has since decided the vendor mapping must use the LINE
-- CATEGORIES the organisation actually maintains — core.categories:
-- IT_HARDWARE, OFFICE_SUPPLIES, FACILITIES, ... — because that is the vocabulary
-- buyers and approvers recognise. Routing eligibility and the D365 payload both
-- follow, so nothing here is a cosmetic rename.
--
-- ── WHY core.categories GAINS AN `id` INSTEAD OF THE FK BEING REPOINTED ─────
--
-- `core.categories` is keyed by `code` (text) and has no surrogate key. The
-- junction table's column is `category_id uuid`. The two obvious fixes are both
-- bad:
--
--   a) rename the column to `category_code text`. That changes the column TYPE,
--      which invalidates both partial indexes and the backfill in 048 — and 048
--      is replayed on every `db:migrate`, so it would have to be made
--      shape-aware, or every future migrate fails.
--
--   b) add `id uuid` to core.categories (chosen). The column keeps its name, its
--      type, its indexes and its 048 backfill untouched. The FK now points at a
--      table that contains ONLY line categories, which is a far stronger
--      guarantee than the ItemGroup trigger it replaces: there is no dimension
--      library to be wrong about, because there is only one table.
--
-- `core.categories.code` stays the primary key, so proc.pr_lines.category and
-- every existing reference are untouched.
--
-- ── THE ITEMGROUP TRIGGER IS DELETED, NOT WEAKENED ─────────────────────────
--
-- `fn_vendor_categories_is_itemgroup` existed only because an FK on
-- dimension_values.id cannot tell one dimension library from the other eight in
-- that table. With a dedicated line-category table there is nothing left to
-- check, and a trigger that re-derives "is this in the one table it must be in"
-- would be a second place to forget an update. The FK is the whole rule.
--
-- ── EXISTING LINKS ARE REMAPPED, NOT GUESSED ───────────────────────────────
--
-- Seven demo links exist. The mapping below is recorded here as DATA, with a
-- NOTICE for anything unmapped, so the choice is visible in the migration log
-- rather than buried in a CASE expression nobody will read in a year. A vendor
-- whose group has no line-category equivalent keeps its link if one was mapped
-- and is otherwise left with no link — which the RFQ gate then reports as
-- un-categorised, the honest answer, rather than a fabricated one.

BEGIN;

-- ── 1. core.categories gains a surrogate key ────────────────────────────────
-- Also added by migration 048, which needs it to resolve the array during its
-- own backfill and runs first. IF NOT EXISTS makes this a no-op on a replay and
-- a safety net if 048 is ever applied without 051.
ALTER TABLE core.categories ADD COLUMN IF NOT EXISTS id uuid;

-- Backfill before the NOT NULL: every row must get one, including rows created
-- before this column existed. gen_random_uuid() is already available here —
-- migration 001 installs pgcrypto and several later migrations use it.
UPDATE core.categories SET id = gen_random_uuid() WHERE id IS NULL;

ALTER TABLE core.categories ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE core.categories ALTER COLUMN id SET NOT NULL;

-- Unique, not primary: `code` remains the primary key because PR lines and the
-- whole engine vocabulary reference it by code. The id only has to be unique
-- for the junction table's FK to have something stable to point at.
CREATE UNIQUE INDEX IF NOT EXISTS categories_id_uniq ON core.categories(id);

COMMENT ON COLUMN core.categories.id IS
  'Surrogate key. `code` stays the primary key; this exists so core.vendor_categories '
  'can carry a uuid FK without being retyped. Do not use it in place of `code`.';

-- ── 2. drop the FK before the rows move ─────────────────────────────────────
-- ORDERING, and it matters. The rows currently in this table hold ITEM GROUP
-- ids, which do not exist in core.categories. Repointing the FK while those
-- rows are still present fails immediately with a foreign key violation, so the
-- constraint is removed first, the data is moved, and the constraint is
-- re-added once the table is coherent. Doing it in this order also means there
-- is never a moment where the table looks migrated but is not.
ALTER TABLE core.vendor_categories
  DROP CONSTRAINT IF EXISTS vendor_categories_category_id_fkey;

-- ── 3. delete the ItemGroup trigger ─────────────────────────────────────────
-- Replaced by the FK below. See the header for why this is removal rather than
-- weakening.
DROP TRIGGER IF EXISTS trg_vendor_categories_is_itemgroup ON core.vendor_categories;
DROP FUNCTION IF EXISTS core.fn_vendor_categories_is_itemgroup();

-- ── 4. remap the existing links onto line categories ────────────────────────
-- Done in two moves because the PK is (vendor_id, category_id): mapping in
-- place could collide when one vendor held two item groups that both resolve to
-- IT_HARDWARE (V-00084 held IG-ACC and IG-LAPTOP). Park the old values, insert
-- the new ones, then drop the parked rows.
CREATE TEMP TABLE vc_remap ON COMMIT DROP AS
SELECT vc.vendor_id,
       vc.category_id,
       vc.is_active,
       vc.created_at,
       vc.created_by,
       dv.code AS old_code
  FROM core.vendor_categories vc
  JOIN core.dimension_values dv ON dv.id = vc.category_id
 WHERE dv.dimension_key = 'ItemGroup';

-- THE DELETE IS CONDITIONAL, AND THAT IS THE WHOLE POINT.
--
-- On a replay the links already point at line categories, so the ItemGroup join
-- above matches NOTHING and vc_remap is empty. An unconditional DELETE here
-- would then wipe every vendor mapping and rebuild it from an empty set — the
-- mapping destroyed by running the migration a second time. The row count is
-- therefore tested before anything is deleted, so a replay is a no-op.
DELETE FROM core.vendor_categories
 WHERE EXISTS (SELECT 1 FROM vc_remap);

-- The mapping, stated once, as data. Anything not listed here is reported by
-- the post-condition below rather than being coerced into an arbitrary bucket.
--
-- DISTINCT ON is load-bearing, not tidiness: V-00084 held BOTH IG-ACC and
-- IG-LAPTOP, and both resolve to IT_HARDWARE, so two proposed rows collide on
-- the (vendor_id, category_id) primary key. Postgres refuses to let one INSERT
-- update the same row twice, and the honest fix is to decide here which of the
-- two wins. `is_active DESC` means an active mapping beats a deactivated one, so
-- collapsing two groups into one never silently un-routes a vendor.
INSERT INTO core.vendor_categories (vendor_id, category_id, is_active, created_at, created_by)
SELECT DISTINCT ON (r.vendor_id, c.id)
       r.vendor_id, c.id, r.is_active, r.created_at, r.created_by
  FROM vc_remap r
  JOIN core.categories c ON c.code = CASE r.old_code
      WHEN 'IG-LAPTOP' THEN 'IT_HARDWARE'
      WHEN 'IG-ACC'    THEN 'IT_HARDWARE'
      WHEN 'IG-OFC'    THEN 'OFFICE_SUPPLIES'
      WHEN 'IG-SVC'    THEN 'PROFESSIONAL_SERVICES'
    END
 ORDER BY r.vendor_id, c.id, r.is_active DESC
ON CONFLICT (vendor_id, category_id) DO UPDATE SET is_active = EXCLUDED.is_active;

-- Anything the CASE did not resolve is a real loss of information, so it is
-- logged loudly rather than dropped in silence.
DO $$
DECLARE unmapped text;
BEGIN
  SELECT string_agg(DISTINCT old_code, ', ') INTO unmapped
    FROM vc_remap r
   WHERE NOT EXISTS (SELECT 1 FROM core.vendor_categories vc
                      JOIN core.categories c ON c.id = vc.category_id
                     WHERE vc.vendor_id = r.vendor_id
                       AND c.code = CASE r.old_code
                           WHEN 'IG-LAPTOP' THEN 'IT_HARDWARE'
                           WHEN 'IG-ACC'    THEN 'IT_HARDWARE'
                           WHEN 'IG-OFC'    THEN 'OFFICE_SUPPLIES'
                           WHEN 'IG-SVC'    THEN 'PROFESSIONAL_SERVICES' END);
  IF unmapped IS NOT NULL THEN
    RAISE WARNING 'migration 051: item group(s) % had no line-category equivalent and produced no link. Those vendors are now un-categorised and the RFQ pool will report them as such.', unmapped;
  END IF;
END $$;

-- ── 5. the FK now points at line categories ─────────────────────────────────
-- Added only after the rows are correct, so the constraint is never asked to
-- bless data it does not yet describe.
ALTER TABLE core.vendor_categories
  ADD CONSTRAINT vendor_categories_category_id_fkey
  FOREIGN KEY (category_id) REFERENCES core.categories(id) ON DELETE RESTRICT;

-- RESTRICT, not CASCADE: deleting a line category that vendors are mapped to
-- must be refused by the database, not silently delete the mapping. The admin
-- screen already reports the dependent-row count before deleting one.

-- ── 6. the array projection is rebuilt from LINE category codes ─────────────
-- Same direction of truth as 048: the table owns the state, the array is the
-- derived read model. Only the vocabulary it projects changed.
CREATE OR REPLACE FUNCTION core.fn_vendor_categories_sync_array()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_vendor uuid := COALESCE(NEW.vendor_id, OLD.vendor_id);
  v_prev   text;
BEGIN
  -- The governed-change gate on core.vendors (migration 039) refuses a raw
  -- UPDATE without `app.vendor_change_token`. This trigger fires on ANY write
  -- to core.vendor_categories, including a runtime status toggle made through
  -- the API — a different statement from the one that carried the token, so the
  -- exemption has to be re-established here. Saved and restored rather than
  -- set, so the gate stays armed for the rest of the transaction.
  v_prev := current_setting('app.vendor_legacy_write', true);
  PERFORM set_config('app.vendor_legacy_write', 'on', true);

  UPDATE core.vendors v
     SET preferred_categories = ARRAY(
           SELECT c.code
             FROM core.vendor_categories vc
             JOIN core.categories c ON c.id = vc.category_id
            WHERE vc.vendor_id = v.id AND vc.is_active
            ORDER BY c.code)
   WHERE v.id = v_vendor;

  PERFORM set_config('app.vendor_legacy_write', coalesce(v_prev, ''), true);
  RETURN NULL;   -- AFTER trigger; the return value is ignored
END;
$$;

-- Rebuild every vendor now, so no array is left holding item-group codes that
-- the trigger would only correct on the next write.
--
-- Migration 039's governed-change gate refuses a raw UPDATE on core.vendors
-- without `app.vendor_change_token`, and that guard is correct: it is what stops
-- a category changing without a trail. The documented exemption for a migration
-- that must rewrite the projection is `app.vendor_legacy_write`, scoped by
-- SET LOCAL to THIS transaction, so nothing outside it is affected. (The runtime
-- trigger above does the same thing per-statement and restores the prior value.)
SET LOCAL app.vendor_legacy_write = 'on';

UPDATE core.vendors v
   SET preferred_categories = ARRAY(
         SELECT c.code
           FROM core.vendor_categories vc
           JOIN core.categories c ON c.id = vc.category_id
          WHERE vc.vendor_id = v.id AND vc.is_active
          ORDER BY c.code);

-- ═══ post-condition ═══════════════════════════════════════════════════════
DO $$
DECLARE n integer;
BEGIN
  -- (1) Every link resolves to a real line category. The FK guarantees the row
  --     exists, so this checks the thing the FK cannot: that the target is not
  --     an item group that survived from the 048 era.
  SELECT count(*) INTO n
    FROM core.vendor_categories vc
    JOIN core.dimension_values dv ON dv.id = vc.category_id
   WHERE dv.dimension_key = 'ItemGroup';
  IF n <> 0 THEN
    RAISE EXCEPTION 'migration 051: % link(s) still point at an item group', n;
  END IF;

  -- (2) core.categories.id is total and unique.
  SELECT count(*) INTO n FROM core.categories WHERE id IS NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION 'migration 051: % line categor(ies) have no id', n;
  END IF;

  SELECT count(*) INTO n FROM (SELECT id FROM core.categories GROUP BY id HAVING count(*) > 1) d;
  IF n <> 0 THEN
    RAISE EXCEPTION 'migration 051: core.categories.id is not unique';
  END IF;

  -- (3) The FK is actually present. "The function ran" is not the claim; this
  --     is, because a missing FK is exactly how a line category and an item
  --     group end up interchangeable again.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'vendor_categories_category_id_fkey'
       AND conrelid = 'core.vendor_categories'::regclass
  ) THEN
    RAISE EXCEPTION 'migration 051: vendor_categories is not FK-bound to core.categories';
  END IF;

  -- (4) The item-group trigger is gone. Leaving it would reject every line
  --     category by name, which is a spectacular way to discover the problem.
  IF EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_vendor_categories_is_itemgroup'
  ) THEN
    RAISE EXCEPTION 'migration 051: the item-group trigger still exists and would reject every line category';
  END IF;

  -- (5) The array holds only real line categories.
  SELECT count(*) INTO n
    FROM core.vendors v, unnest(coalesce(v.preferred_categories, ARRAY[]::text[])) AS c(code)
   WHERE NOT EXISTS (SELECT 1 FROM core.categories cat WHERE cat.code = c.code);
  IF n <> 0 THEN
    RAISE EXCEPTION 'migration 051: % array value(s) are not line categories', n;
  END IF;

  -- (6) The array and the active links agree — the invariant the RFQ gate, the
  --     master list and the D365 payload all rely on.
  SELECT count(*) INTO n
    FROM core.vendors v
   WHERE coalesce((
           SELECT string_agg(x, ',' ORDER BY x)
             FROM unnest(coalesce(v.preferred_categories, ARRAY[]::text[])) AS t(x)
         ), '')
      <> coalesce((
            SELECT string_agg(c.code, ',' ORDER BY c.code)
              FROM core.vendor_categories vc
              JOIN core.categories c ON c.id = vc.category_id
             WHERE vc.vendor_id = v.id AND vc.is_active), '');
  IF n <> 0 THEN
    RAISE EXCEPTION 'migration 051: % vendor(s) have an array that disagrees with their active links', n;
  END IF;

  RAISE NOTICE 'migration 051 ok: the vendor mapping speaks line categories';
END $$;

COMMIT;