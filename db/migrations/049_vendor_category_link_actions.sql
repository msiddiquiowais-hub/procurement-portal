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
-- `fn_widen_audit_log_actions` rebuilds the CHECK from its OWN hardcoded array.
-- It is not additive: it DROPs the constraint and re-adds it from `canon`. So
-- appending three values to the array without restating every earlier action
-- would silently NARROW the vocabulary and start refusing audit rows that
-- Wave 5-F/G/H already write. That exact hazard is what migrations 039, 041 and
-- 042 each document at their own copy of this function.
--
-- The list below is migration 042's verbatim, plus the three new values.

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
    'category_enable','category_disable','category_unlink'
  ];
  canon_literal text;
  def text;
  missing text;
BEGIN
  SELECT string_agg(quote_literal(a), ',') INTO canon_literal FROM unnest(canon) AS a;

  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint
   WHERE conname = 'audit_log_action_check' AND conrelid = 'audit.audit_log'::regclass;

  IF def IS NULL THEN
    EXECUTE 'ALTER TABLE audit.audit_log ADD CONSTRAINT audit_log_action_check '
            'CHECK (action = ANY(ARRAY[' || canon_literal || ']))';
    RETURN;
  END IF;

  SELECT string_agg(a, ', ') INTO missing
    FROM unnest(canon) AS a
   WHERE position('''' || a || '''' in def) = 0;

  IF missing IS NULL THEN
    RETURN;                       -- already a superset; leave it alone
  END IF;

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