-- ─────────────────────────────────────────────────────────────────────────────
-- 049 - audit vocabulary: the per-link vendor-category actions.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHAT THIS IS FOR
-- ----------------
-- Migration 048 introduced `core.vendor_categories` and split the single
-- 'category_change' audit action into three per-link decisions:
--
--   category_enable   - a link was re-activated, so the vendor is routable again
--   category_disable  - a link was deactivated, so future RFQs stop routing there
--   category_unlink   - the row was deleted; the relationship is forgotten
--
-- The API already writes all three (vendor-governance.service.ts appendAudit).
-- Without this migration the CHECK constraint refuses them and every one of those
-- calls fails at the INSERT — the whole transaction rolls back, so the operator
-- sees a 500 and NO state change, rather than a rejected action.
--
-- This is the audit vocabulary only. No schema change to vendor_categories.
--
-- ── WHY THE WHOLE LIST IS RESTATED ──────────────────────────────────────────
--
-- This file still restates the earlier actions in `canon`. It no longer has to:
-- the function below rebuilds the CHECK from canon UNION whatever the installed
-- constraint already permits, so it can only ever widen, whatever list it is
-- handed and whatever order the migrations run in.
--
-- The list is restated anyway because a fresh database has no earlier list to
-- inherit, and because a reader of this file should be able to see the whole
-- vocabulary in one place.
--
-- WHY THAT MATTERS — the trap this file used to be part of
-- --------------------------------------------------------
-- `fn_widen_audit_log_actions` used to rebuild the CHECK from its own array
-- ALONE (DROP, then re-ADD from `canon`). That made the list a trap: one author
-- forgetting an action silently NARROWED the vocabulary, and every row already
-- carrying the forgotten action then failed the new CHECK. It was not
-- hypothetical. Migration 038b repairs the audit hash chain and records itself
-- with the action `repair`; 042 and 049 both rebuilt from lists that did not
-- contain it, and both aborted with
--
--     check constraint "audit_log_action_check" of relation "audit_log"
--     is violated by some row
--
-- with each list being perfectly correct in isolation. Migrations 020 and 027
-- hit this identical defect on proc.purchase_requisitions.status; 019 records
-- the same lesson — "a fresh db:reset never hit it, which is why it survived."

BEGIN;

CREATE OR REPLACE FUNCTION audit.fn_widen_audit_log_actions()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  canon text[] := ARRAY[
    'create','update','delete','approve','reject','return','push','reassign',
    'login','logout','workflow_config_change','pack_freeze','pack_push',
    'sod_violation','dead_letter',
    'hold','unhold','category_change','vendor_update','d365_vendor_sync',
    'phone_negotiation','cs_line_award','cs_split_lock',
    'po_generate','po_issue','po_push','po_cancel',
    'd365_master_sync','d365_po_push',
    'category_enable','category_disable','category_unlink',
    -- 038b repairs the audit hash chain and records that fact in the trail
    -- itself. The union below would preserve 'repair' anyway; declaring it here
    -- as well means it is part of the STATED vocabulary rather than something
    -- this list happens to be carrying.
    'repair'
  ];
  canon_literal text;
  def text;
  permitted text[];
  merged text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint
   WHERE conname = 'audit_log_action_check' AND conrelid = 'audit.audit_log'::regclass;

  -- No constraint yet (fresh database): create it from this migration's list.
  IF def IS NULL THEN
    SELECT string_agg(quote_literal(a), ',') INTO canon_literal FROM unnest(canon) AS a;
    EXECUTE 'ALTER TABLE audit.audit_log ADD CONSTRAINT audit_log_action_check '
            'CHECK (action = ANY(ARRAY[' || canon_literal || ']))';
    RETURN;
  END IF;

  -- What the INSTALLED constraint already permits, read from the CONSTRAINT and
  -- never from the table. That distinction is load-bearing: an action that was
  -- never permitted cannot be legitimised here merely because some row happens
  -- to carry it.
  SELECT COALESCE(array_agg(DISTINCT m[1] ORDER BY m[1]), ARRAY[]::text[])
    INTO permitted
    FROM regexp_matches(def, $q$'([^']+)'$q$, 'g') AS m;

  -- A definition we cannot read is a definition we must not replace. Refusing
  -- here is the difference between "widened" and "silently narrowed".
  IF array_length(permitted, 1) IS NULL THEN
    RAISE EXCEPTION
      'fn_widen_audit_log_actions: could not read the permitted action list out of '
      'audit_log_action_check, so rebuilding it could NARROW the audit vocabulary. '
      'Refusing to run. Installed definition: %', def;
  END IF;

  -- Nothing to do when this migration's actions are all permitted already. On a
  -- REPLAY this is the common case, and returning without a DDL round-trip is
  -- what keeps a re-run from touching the table for nothing.
  IF NOT EXISTS (SELECT 1 FROM unnest(canon) a WHERE NOT (a = ANY(permitted))) THEN
    RETURN;
  END IF;

  -- WIDEN: the union of what is installed and what this migration adds.
  -- Rebuilding from `canon` ALONE is the bug this replaces - see the header.
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), ARRAY[]::text[])
    INTO merged
    FROM unnest(canon || permitted) AS x;

  SELECT string_agg(quote_literal(a), ',') INTO canon_literal FROM unnest(merged) AS a;

  EXECUTE 'ALTER TABLE audit.audit_log DROP CONSTRAINT audit_log_action_check';
  EXECUTE 'ALTER TABLE audit.audit_log ADD CONSTRAINT audit_log_action_check '
          'CHECK (action = ANY(ARRAY[' || canon_literal || ']))';
END $function$;

SELECT audit.fn_widen_audit_log_actions();

-- ── post-condition ─────────────────────────────────────────────────────────
-- "the function ran" is not the same claim as "the CHECK permits the value", so
-- probe the rendered constraint text directly (pg_constraint has no `condef`
-- column; the text comes from pg_get_constraintdef(oid)).

DO $$
DECLARE
  def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint
   WHERE conname = 'audit_log_action_check' AND conrelid = 'audit.audit_log'::regclass;

  IF def IS NULL THEN
    RAISE EXCEPTION 'migration 049: audit_log_action_check is missing entirely';
  END IF;

  -- The three new actions must be ACCEPTED...
  IF position('''category_enable''' in def) = 0
     OR position('''category_disable''' in def) = 0
     OR position('''category_unlink''' in def) = 0 THEN
    RAISE EXCEPTION 'migration 049: audit_log_action_check does not permit the per-link category actions';
  END IF;

  -- ...and the widening must not have NARROWED it. Every action an earlier wave
  -- already writes has to still be accepted, or this migration has broken
  -- unrelated audit writes while looking like a pure extension.
  IF position('''hold''' in def) = 0
     OR position('''unhold''' in def) = 0
     OR position('''category_change''' in def) = 0
     OR position('''vendor_update''' in def) = 0
     OR position('''cs_split_lock''' in def) = 0
     OR position('''po_generate''' in def) = 0
     OR position('''po_cancel''' in def) = 0
     OR position('''d365_po_push''' in def) = 0 THEN
    RAISE EXCEPTION
      'migration 049: the audit vocabulary LOST an earlier action — the widening NARROWED the CHECK';
  END IF;

  RAISE NOTICE 'migration 049 ok: per-link vendor-category audit actions admitted';
END $$;

COMMIT;