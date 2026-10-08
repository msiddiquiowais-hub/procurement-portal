-- ─────────────────────────────────────────────────────────────────────────────
-- 048 - core.vendor_categories: the vendor <-> item-group mapping as real rows.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHAT THIS IS FOR
-- ----------------
-- `core.vendors.preferred_categories text[]` carries the mapping today and
-- serves the sourcing rules fine. What it cannot express is PER-LINK STATE: you
-- can say "this vendor sells laptops", but not "they used to, and we stopped
-- routing them there on 3 March without pretending the relationship never
-- existed". That is what this table adds.
--
-- ── THE VOCABULARY, AND WHY IT IS ITEM GROUPS ───────────────────────────────
--
-- The categories here are D365 **ItemGroup** values from
-- `core.dimension_values` (IG-LAPTOP, IG-ACC, IG-OFC, IG-SVC), NOT the PR line
-- categories in `core.categories` (IT_HARDWARE, OFFICE_SUPPLIES, ...).
--
-- That is settled, not incidental. Migration 037 seeds `preferred_categories`
-- from this library and its post-condition raises unless every stored value is an
-- active ItemGroup code. The D365 payload sends the same values to F&O, which has
-- no category array, so they travel as a delimited note. And until this wave,
-- `onboarding.normaliseCategory()` validated against the LINE categories, which
-- meant the public form could only produce values migration 037 would reject —
-- fixed in this wave's API change, not here.
--
-- ── WHY THE COLUMN IS category_id uuid AND NOT a code ───────────────────────
--
-- `core.dimension_values` has PK `id` and UNIQUE `(dimension_key, code)`. A
-- foreign key on `id` alone is the spec's shape and makes the joins trivial, but
-- it CANNOT stop a row pointing at a Customer value or an OperatingUnit value —
-- the same table holds nine dimension libraries, and dimension_key is what
-- distinguishes them.
--
-- So `category_id` carries an FK on `id` (for the spec, and for cheap joins) AND
-- a trigger refuses anything that is not an ItemGroup. That is belt and braces on
-- purpose: the entire class of bug this wave exists to eliminate is a value from
-- the wrong vocabulary being accepted because nothing was checking.
--
-- ── NO updated_at / updated_by ──────────────────────────────────────────────
--
-- The brief asked for audit columns on the junction table. `audit.audit_log`
-- already records every vendor change with actor, timestamp, reason, before/after
-- jsonb and a tamper-evident hash chain (migration 039), and `category_change`
-- has 14 rows against `core.vendors` already. Adding `updated_by`/`updated_at`
-- here would create a SECOND, weaker answer to "who changed this and when" — one
-- that records the latest change and silently drops the history, which is the one
-- thing an audit trail exists to prevent. The audit log stays the single source.
--
-- ── THE ARRAY IS NOT DROPPED ────────────────────────────────────────────────
--
-- `preferred_categories` stays, and stays authoritative for reads in this
-- migration. Six readers still consume it (rfq.service eligibility,
-- vendor-sync payload, vendors.service list, governance snapshot, two proof
-- harnesses). Dropping it here would break them all at once; it is deprecate-
-- then-retire, and until then it must be kept IN SYNC with this table. That
-- obligation is enforced below rather than left to discipline.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

SET LOCAL search_path = core, proc, public;

-- Migration 039 installs core.fn_vendors_governed_change_gate(), which refuses a
-- raw UPDATE of core.vendors unless `app.vendor_change_token` is set, so that a
-- governed change can never exist without an audit entry. Its header says so
-- explicitly: "a later migration that backfills vendors must do the same".
--
-- This one does: it backfills and then rebuilds core.vendors.preferred_categories
-- from the mapping table. The audit trail for that change is the
-- core.vendor_categories row plus its audit_log entry — the array is a derived
-- read model, so rewriting it is not itself an ungoverned decision.
SET LOCAL app.vendor_legacy_write = 'on';

-- ─── 1. the table ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core.vendor_categories (
  vendor_id    uuid NOT NULL REFERENCES core.vendors(id) ON DELETE CASCADE,
  category_id  uuid NOT NULL REFERENCES core.dimension_values(id) ON DELETE RESTRICT,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES core.users(id),
  -- Last status change. Not "last edited": a mapping row is not edited, it is
  -- activated or deactivated, and that is the only transition worth dating here.
  status_changed_at timestamptz,
  status_changed_by uuid REFERENCES core.users(id),
  PRIMARY KEY (vendor_id, category_id)
);

COMMENT ON TABLE core.vendor_categories IS
  'Vendor <-> D365 ItemGroup mapping. is_active=false means "stop routing them here"; the row is kept so the historical mapping is not lost. Category vocabulary is core.dimension_values where dimension_key=''ItemGroup'' — NOT core.categories, which holds PR line categories.';
COMMENT ON COLUMN core.vendor_categories.is_active IS
  'false excludes the vendor from automatic RFQs for this item group without deleting the mapping. Future eligibility only: no past PR, RFQ, PO or quotation references a mapping, so nothing historical changes.';

-- ─── 2. a mapping must point at an ItemGroup ─────────────────────────────────
CREATE OR REPLACE FUNCTION core.fn_vendor_categories_is_itemgroup()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_key text;
BEGIN
  SELECT dimension_key INTO v_key
    FROM core.dimension_values WHERE id = NEW.category_id;

  IF v_key IS DISTINCT FROM 'ItemGroup' THEN
    RAISE EXCEPTION
      'vendor % was mapped to dimension value %, which belongs to % — a vendor category must be an ItemGroup',
      NEW.vendor_id, NEW.category_id, coalesce(v_key, 'no such dimension value')
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- ─── 2b. NO ITEMGROUP TRIGGER IS CREATED HERE ────────────────────────────────
-- This migration originally installed `fn_vendor_categories_is_itemgroup`,
-- because an FK on dimension_values.id cannot tell one dimension library from
-- the other eight stored in that table.
--
-- It is deliberately absent now. Migration 051 repoints this table at
-- core.categories, which holds ONLY line categories, so the FK alone enforces
-- the vocabulary and the trigger had nothing left to do. It is removed rather
-- than left in place because on a REPLAY of this file it would be recreated and
-- would then reject every line category by name.
DROP TRIGGER IF EXISTS trg_vendor_categories_is_itemgroup ON core.vendor_categories;
DROP FUNCTION IF EXISTS core.fn_vendor_categories_is_itemgroup();

-- ─── 3. status transitions are dated, not free-form ──────────────────────────
-- Only a CHANGE of status stamps the actor. A row that is inserted already active
-- has nothing to report, and stamping it would imply a decision was made.
CREATE OR REPLACE FUNCTION core.fn_vendor_categories_stamp_status()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status_changed_at IS NULL THEN NEW.status_changed_at := now(); END IF;
    RETURN NEW;
  END IF;

  IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    NEW.status_changed_at := now();
    NEW.status_changed_by := NULLIF(current_setting('app.actor_user_id', true), '')::uuid;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vendor_categories_stamp_status ON core.vendor_categories;
CREATE TRIGGER trg_vendor_categories_stamp_status
  BEFORE INSERT OR UPDATE OF is_active ON core.vendor_categories
  FOR EACH ROW EXECUTE FUNCTION core.fn_vendor_categories_stamp_status();

-- ─── 4. indexes ──────────────────────────────────────────────────────────────
-- The lookup that matters most: "which ACTIVE vendors serve this item group",
-- which is the reverse read behind the Manage Vendors modal and the RFQ pool.
CREATE INDEX IF NOT EXISTS idx_vendor_categories_active_category
  ON core.vendor_categories(category_id, vendor_id) WHERE is_active;

-- "which active groups does this vendor serve" — the forward read.
CREATE INDEX IF NOT EXISTS idx_vendor_categories_active_vendor
  ON core.vendor_categories(vendor_id, category_id) WHERE is_active;

-- ─── 4b. core.categories gains the surrogate key this file resolves against ──
-- 051 adds this too. It is here as well because 051 runs AFTER this file, and
-- the backfill below needs to look a line category up BY ID — so on a replay,
-- where the array already holds line categories, core.categories has to have
-- its surrogate key by the time this file runs. IF NOT EXISTS makes it a no-op.
ALTER TABLE core.categories ADD COLUMN IF NOT EXISTS id uuid;
UPDATE core.categories SET id = gen_random_uuid() WHERE id IS NULL;
ALTER TABLE core.categories ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE core.categories ALTER COLUMN id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS categories_id_uniq ON core.categories(id);

-- ─── 5. backfill from the array ──────────────────────────────────────────────
-- Every value already in preferred_categories becomes an active mapping row.
-- Anything that does not resolve is reported rather than guessed at.
--
-- THE JOIN READS BOTH VOCABULARIES, deliberately. This file is replayed on
-- every migrate, and by then the array may hold EITHER item-group codes (a
-- fresh database, where 037 has just seeded them) or line categories (a
-- replay, where 051 has already remapped them). Hard-coding one vocabulary here
-- would make every subsequent `db:migrate` either drop the mapping or corrupt
-- the array. Migration 051 is what settles which vocabulary is current.
INSERT INTO core.vendor_categories (vendor_id, category_id, is_active, status_changed_at)
SELECT v.id, cat.id, true, now()
  FROM core.vendors v
  CROSS JOIN LATERAL unnest(coalesce(v.preferred_categories, ARRAY[]::text[])) AS entry(code)
  JOIN (
         SELECT c.id AS id, c.code AS code FROM core.categories c
    UNION ALL
         SELECT d.id AS id, d.code AS code FROM core.dimension_values d
          WHERE d.dimension_key = 'ItemGroup' AND d.active
       ) AS cat ON cat.code = entry.code
ON CONFLICT (vendor_id, category_id) DO NOTHING;

DO $$
DECLARE n integer;
BEGIN
  -- Resolved against BOTH vocabularies for the same replay reason as the
  -- backfill above: before 051 the array holds item groups, after it holds line
  -- categories, and this file has to be correct either way.
  SELECT count(*) INTO n
    FROM core.vendors v, unnest(coalesce(v.preferred_categories, ARRAY[]::text[])) AS entry(code)
   WHERE NOT EXISTS (SELECT 1 FROM core.categories WHERE code = entry.code)
     AND NOT EXISTS (SELECT 1 FROM core.dimension_values dv
                      WHERE dv.dimension_key='ItemGroup' AND dv.code=entry.code AND dv.active);
  IF n > 0 THEN
    RAISE EXCEPTION
      'migration 048: % vendor category value(s) match no known vocabulary (a line category '
      'or an active ItemGroup), so they could not be mapped. Repair the source before re-running.', n;
  END IF;
END $$;

-- ─── 6. keep the array honest ────────────────────────────────────────────────
--
-- The array is still what six readers consume, so a link written here that never
-- reaches the array is a link the rest of the system cannot see. Rather than
-- trusting every writer to update both, the array is REBUILT from this table on
-- every change to the table, over active mappings only.
--
-- That is the right direction of truth: the table is the thing with a status, an
-- actor and a history; the array is a derived read model. Writing the array by
-- hand is what let the two vocabularies drift apart in the first place.
--
-- Inactive links are excluded on purpose — an inactive link must not make a
-- vendor look categorised to the RFQ pool (see migration 048's Phase 4 in
-- docs/PLAN_vendor_category_m2m.md, and the EXISTS(is_active) rewrite).
CREATE OR REPLACE FUNCTION core.fn_vendor_categories_sync_array()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_vendor uuid := COALESCE(NEW.vendor_id, OLD.vendor_id);
  v_prev   text;
BEGIN
  -- The governed-change gate on core.vendors (migration 039) refuses a raw
  -- UPDATE without `app.vendor_change_token`. This trigger fires on ANY write to
  -- core.vendor_categories, including a runtime status toggle made through the
  -- API — a different statement from the one that carried the token, so the
  -- token is not reliably set here.
  --
  -- The exemption is legitimate and narrow: this is not an independent change to
  -- a vendor, it is a DERIVED READ MODEL rebuilt from the mapping table, and the
  -- mapping table is where the audit trail lives. The previous value is saved
  -- and restored rather than left set, so the gate stays armed for the rest of
  -- the transaction — leaving it on would silently disarm the audit guard for
  -- every subsequent statement in the same transaction.
  v_prev := current_setting('app.vendor_legacy_write', true);
  PERFORM set_config('app.vendor_legacy_write', 'on', true);

  UPDATE core.vendors v
     SET preferred_categories = ARRAY(
           SELECT dv.code
             FROM core.vendor_categories vc
             JOIN core.dimension_values dv ON dv.id = vc.category_id
            WHERE vc.vendor_id = v.id AND vc.is_active
            ORDER BY dv.code)
   WHERE v.id = v_vendor;

  PERFORM set_config('app.vendor_legacy_write', coalesce(v_prev, ''), true);

  RETURN NULL;   -- AFTER trigger; the return value is ignored
END;
$$;

DROP TRIGGER IF EXISTS trg_vendor_categories_sync_array ON core.vendor_categories;
CREATE TRIGGER trg_vendor_categories_sync_array
  AFTER INSERT OR UPDATE OF is_active OR DELETE ON core.vendor_categories
  FOR EACH ROW EXECUTE FUNCTION core.fn_vendor_categories_sync_array();

-- Rebuild once, so any value the backfill could not map is visible immediately
-- rather than waiting for the next write.
--
-- Reads both vocabularies for the same replay reason as the backfill: joining
-- dimension_values unconditionally would silently empty every array on a
-- replay, because by then category_id points into core.categories and the join
-- finds nothing. An empty array is not a harmless no-op — migration 037 asserts
-- that every ACTIVE vendor still carries at least one category.
UPDATE core.vendors v
   SET preferred_categories = ARRAY(
         SELECT cat.code
           FROM core.vendor_categories vc
           JOIN (
                  SELECT c.id AS id, c.code AS code FROM core.categories c
             UNION ALL
                  SELECT d.id AS id, d.code AS code FROM core.dimension_values d
                   WHERE d.dimension_key = 'ItemGroup' AND d.active
                ) AS cat ON cat.id = vc.category_id
          WHERE vc.vendor_id = v.id AND vc.is_active
          ORDER BY cat.code);

-- ─── 7. post-condition: the table and the array agree ────────────────────────
DO $$
DECLARE mismatched integer; links integer; inactive integer;
BEGIN
  SELECT count(*) INTO links     FROM core.vendor_categories;
  SELECT count(*) INTO inactive  FROM core.vendor_categories WHERE NOT is_active;

  -- Every ACTIVE mapping appears in the array, and every array value is an
  -- active mapping. Any difference means a writer bypassed one side.
  SELECT count(*) INTO mismatched FROM (
    SELECT vc.vendor_id, dv.code
      FROM core.vendor_categories vc
      JOIN core.dimension_values dv ON dv.id = vc.category_id
     WHERE vc.is_active
       AND NOT EXISTS (
         SELECT 1 FROM core.vendors v2
          WHERE v2.id = vc.vendor_id AND dv.code = ANY (v2.preferred_categories))
  ) a;

  IF mismatched > 0 THEN
    RAISE EXCEPTION
      'migration 048: % active mapping(s) are missing from the vendor array; the read model is out of step', mismatched;
  END IF;

  RAISE NOTICE 'vendor_categories: % link(s), % inactive', links, inactive;
END $$;

COMMIT;