-- 045 — the ledger that lets vendor sync to D365 be honest about "changed".
--
-- WHAT THIS IS FOR
--
-- W5-H must push vendor onboarding status, hold controls and category
-- mappings to D365 F&O. A push that re-sends every vendor on every run is not
-- wrong, but it is unauditable: the audit log fills with identical
-- `d365_vendor_sync` rows and an operator cannot tell whether anything
-- actually moved.
--
-- So each vendor carries two columns recording what was last pushed, and a
-- function that hashes EXACTLY the fields this application owns and pushes.
-- If the hash is unchanged, the sync reports `unchanged` and does not write an
-- audit row claiming a reconciliation that did not happen.
--
-- WHY THE HASH LIVES IN THE DATABASE
--
-- The same predicate is needed by the sync service and by the harness. Defined
-- twice it would drift, and a drift would show up as "everything is always
-- unchanged" — a sync that silently stops pushing. One definition, one owner.
--
-- The hash covers only fields this application is authoritative for. F&O owns
-- vendor descriptive master (bank details, addresses F&O's own credit
-- management). Including those would make a local edit look like a pending
-- F&O change and invite an overwrite of data the other system owns.
--
-- Idempotent: columns are added IF NOT EXISTS and the function is replaced.

BEGIN;

ALTER TABLE core.vendors
  ADD COLUMN IF NOT EXISTS d365_vendor_synced_at timestamptz;
ALTER TABLE core.vendors
  ADD COLUMN IF NOT EXISTS d365_vendor_sync_hash text;

COMMENT ON COLUMN core.vendors.d365_vendor_synced_at IS
  'When this vendor''s D365 master was last successfully pushed. NULL = never pushed.';
COMMENT ON COLUMN core.vendors.d365_vendor_sync_hash IS
  'Hash of the pushed fields at that moment; NULL = never pushed. Unchanged hash means nothing to send.';

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
    -- sorted: preferred_categories is an array, and two arrays holding the
    -- same categories in a different order are the same mapping. Hashing the
    -- raw array order would report a change that does not exist.
    coalesce(array_to_string(ARRAY(SELECT unnest(coalesce(v.preferred_categories, ARRAY[]::text[]))
                                    ORDER BY 1), ','), '')
  )) END
  FROM core.vendors v
  WHERE v.id = p_vendor;
$function$;

-- ── post-condition ────────────────────────────────────────────────────────
-- A causal round trip, not a re-read of the definition: the hash must CHANGE
-- when a hold is applied and RETURN to its original value when it is lifted.
-- If either half is wrong the sync is either blind or permanently dirty.
DO $prove$
DECLARE
  v_id   uuid;
  v_base text;
  v_held text;
BEGIN
  -- The W5-E governed-change trigger (fn_vendors_governed_change_gate) refuses
  -- a raw UPDATE on core.vendors so that a hold can never change without an
  -- audit trail. That guard is correct and this probe must not switch it off
  -- globally: `set_config(..., true)` scopes the exemption to THIS transaction,
  -- so no other session or later statement inherits it.
  PERFORM set_config('app.vendor_legacy_write', 'on', true);

  SELECT id INTO v_id FROM core.vendors ORDER BY vendor_code LIMIT 1;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'post-condition needs at least one vendor';
  END IF;

  IF core.fn_vendor_d365_sync_hash(NULL::uuid) IS NOT NULL THEN
    RAISE EXCEPTION 'post-condition FAILED: a missing vendor reports a sync hash';
  END IF;

  v_base := core.fn_vendor_d365_sync_hash(v_id);
  IF v_base IS NULL THEN
    RAISE EXCEPTION 'post-condition FAILED: an existing vendor reports no sync hash';
  END IF;

  -- Apply a hold the way the product does, then lift it, restoring the row
  -- exactly. Nothing is left behind: the original values are captured first.
  DECLARE
    v_was_hold   boolean;
    v_old_reason text;
    v_old_at     timestamptz;
    v_old_by     uuid;
    v_prober     uuid;
  BEGIN
    SELECT is_hold, hold_reason, held_at, held_by_user_id
      INTO v_was_hold, v_old_reason, v_old_at, v_old_by
      FROM core.vendors WHERE id = v_id;

    -- vendors_hold_consistent requires reason AND held_at AND held_by_user_id
    -- together, so the probe has to look like a real hold or it is refused for
    -- a reason that has nothing to do with the thing being tested.
    SELECT id INTO v_prober FROM core.users WHERE role = 'admin' LIMIT 1;
    IF v_prober IS NULL THEN
      SELECT id INTO v_prober FROM core.users ORDER BY created_at LIMIT 1;
    END IF;

    UPDATE core.vendors
       SET is_hold = true,
           hold_reason = 'migration 045 post-condition probe',
           held_at = now(),
           held_by_user_id = v_prober
     WHERE id = v_id;

    v_held := core.fn_vendor_d365_sync_hash(v_id);
    IF v_held = v_base THEN
      UPDATE core.vendors
         SET is_hold = v_was_hold, hold_reason = v_old_reason,
             held_at = v_old_at, held_by_user_id = v_old_by
       WHERE id = v_id;
      RAISE EXCEPTION 'post-condition FAILED: applying a hold did not change the sync hash';
    END IF;

    UPDATE core.vendors
       SET is_hold = v_was_hold, hold_reason = v_old_reason,
           held_at = v_old_at, held_by_user_id = v_old_by
     WHERE id = v_id;

    IF core.fn_vendor_d365_sync_hash(v_id) IS DISTINCT FROM v_base THEN
      RAISE EXCEPTION 'post-condition FAILED: lifting the hold did not restore the original hash';
    END IF;
  END;
END
$prove$;

COMMIT;
