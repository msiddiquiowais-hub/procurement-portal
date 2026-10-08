-- ─────────────────────────────────────────────────────────────────────────────
-- 050 - the D365 vendor sync hash ignores DEACTIVATED category links.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHAT THIS IS FOR
-- ----------------
-- Decision 3 of this wave: inactive vendor<->item-group links are excluded from
-- the D365 payload AND from the hash that decides whether a push is needed.
--
-- `core.fn_vendor_d365_sync_hash` hashed `v.preferred_categories`. Migration 048
-- made that array a projection of the ACTIVE links only, so the two already
-- agreed by accident. This migration makes the dependency explicit instead:
-- the hash now reads `core.vendor_categories` directly, filtered on is_active.
--
-- ── WHY NOT LEAVE IT ON THE ARRAY ───────────────────────────────────────────
--
-- Because a hash that is correct only as long as some unrelated trigger keeps
-- working is not a fact anyone can rely on. The RFQ gate got the same treatment
-- for the same reason. Reading the source of truth also means the invariant is
-- checkable by the post-condition below rather than assumed.
--
-- ── WHAT A TOGGLE DOES TO THE HASH — READ THIS ──────────────────────────────
--
-- Deactivating a link REMOVES a code from the active set, so the hash CHANGES
-- and the next sync does push. That is intended and it is not optional: the hash
-- exists to describe exactly what is about to be sent, and the payload now
-- contains only active groups. Hashing anything else would make the ledger claim
-- "unchanged" while `categoryNote` had silently diverged from what F&O holds,
-- and the category note would then never be corrected.
--
-- What is excluded is the INACTIVE ROWS THEMSELVES — their presence, count and
-- history have no effect. The post-condition proves exactly that, because that
-- is the property that actually had to change.
--
-- Idempotent: the function is replaced, nothing is inserted.

BEGIN;

CREATE OR REPLACE FUNCTION core.fn_vendor_d365_sync_hash(p_vendor uuid)
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  -- NULL in, NULL out: a vendor that does not exist has no sync state, and
  -- pretending otherwise would let a phantom row compare "unchanged".
  SELECT CASE WHEN v.id IS NULL THEN NULL ELSE md5(concat_ws('|',
    coalesce(v.vendor_code,        ''),
    coalesce(v.legal_name,         ''),
    coalesce(v.ntn,                ''),
    coalesce(v.strn,               ''),
    coalesce(v.currency,           ''),
    coalesce(v.payment_terms,      ''),
    coalesce(v.state,              ''),
    v.is_hold::text,
    coalesce(v.hold_reason,        ''),
    -- sorted, and ACTIVE LINKS ONLY. Sorted because two vendors holding the
    -- same groups in a different order are the same mapping; active-only
    -- because a deactivated group is not sent to F&O, so it must not count as
    -- a difference worth pushing. Inactive rows contribute nothing here.
    --
    -- core.categories, NOT core.dimension_values: migration 051 moved the vendor
    -- mapping onto the line categories, and joining the ItemGroup library here
    -- would silently hash an empty category string for every vendor — a sync
    -- that reports "unchanged" forever because it stopped seeing the field it
    -- exists to track.
    coalesce((
      SELECT string_agg(c.code, ',' ORDER BY c.code)
        FROM core.vendor_categories vc
        JOIN core.categories c ON c.id = vc.category_id
       WHERE vc.vendor_id = v.id AND vc.is_active
    ), '')
  )) END
  FROM core.vendors v
  WHERE v.id = p_vendor;
$function$;

-- ── post-condition ─────────────────────────────────────────────────────────
-- Asserting "the function was replaced" is not the claim we need. What we need
-- is that INACTIVE ROWS CANNOT MOVE THE HASH, proved by causal round trip: add
-- a deactivated link, observe the hash does not change, remove it, observe the
-- hash returns to its base. Every write here is undone.

DO $prove$
DECLARE
  v_vendor uuid;
  v_group  uuid;
  v_prober uuid;
  v_base   text;
  v_dirty  text;
BEGIN
  -- Migration 039's governed-change gate refuses raw UPDATEs on core.vendors
  -- without a change token. This probe only inserts/DELETEs mapping rows, never
  -- updates a vendor, so the gate stays armed for everything else in the
  -- transaction.
  SELECT id INTO v_vendor FROM core.vendors ORDER BY vendor_code LIMIT 1;
  IF v_vendor IS NULL THEN
    RAISE EXCEPTION 'post-condition needs at least one vendor';
  END IF;

  IF core.fn_vendor_d365_sync_hash(NULL::uuid) IS NOT NULL THEN
    RAISE EXCEPTION 'post-condition FAILED: a missing vendor reports a sync hash';
  END IF;

  v_base := core.fn_vendor_d365_sync_hash(v_vendor);
  IF v_base IS NULL THEN
    RAISE EXCEPTION 'post-condition FAILED: an existing vendor reports no sync hash';
  END IF;

  -- Pick a line category this vendor does NOT already link to (active or not), so
  -- the probe cannot collide with an existing row. core.categories is the table
  -- the mapping points at; the ItemGroup library no longer has any bearing here.
  SELECT c.id INTO v_group
    FROM core.categories c
   WHERE c.active
     AND NOT EXISTS (
       SELECT 1 FROM core.vendor_categories vc
        WHERE vc.vendor_id = v_vendor AND vc.category_id = c.id
     )
   ORDER BY c.code
   LIMIT 1;
  IF v_group IS NULL THEN
    RAISE NOTICE 'post-condition skipped: every active line category is already linked to the probe vendor';
    RETURN;
  END IF;

  -- The probe writes an INACTIVE link. The hash must not notice it.
  INSERT INTO core.vendor_categories (vendor_id, category_id, is_active)
  VALUES (v_vendor, v_group, false);

  v_dirty := core.fn_vendor_d365_sync_hash(v_vendor);
  IF v_dirty IS DISTINCT FROM v_base THEN
    DELETE FROM core.vendor_categories
     WHERE vendor_id = v_vendor AND category_id = v_group AND is_active = false;
    RAISE EXCEPTION
      'post-condition FAILED: an INACTIVE link changed the D365 sync hash — it would push a re-sync F&O does not need';
  END IF;

  DELETE FROM core.vendor_categories
   WHERE vendor_id = v_vendor AND category_id = v_group AND is_active = false;

  IF core.fn_vendor_d365_sync_hash(v_vendor) IS DISTINCT FROM v_base THEN
    RAISE EXCEPTION 'post-condition FAILED: removing the probe link did not restore the original hash';
  END IF;

  -- Nothing left behind: the probe link is gone.
  IF EXISTS (SELECT 1 FROM core.vendor_categories
              WHERE vendor_id = v_vendor AND category_id = v_group) THEN
    RAISE EXCEPTION 'post-condition FAILED: the probe left a mapping row behind';
  END IF;

  RAISE NOTICE 'migration 050 ok: inactive links are invisible to the D365 vendor sync hash';
END
$prove$;

COMMIT;