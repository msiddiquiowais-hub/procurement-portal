-- ═══════════════════════════════════════════════════════════════════════════════
-- 063 — Comparative Statement: matrix layout switch (CONFIG ONLY)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- STATUS: DRAFT FOR REVIEW. NOT APPLIED.
--
-- SCOPE CHANGE (2026-10-18): partial line-level locking was dropped from scope.
-- That removes `proc.cs_item_decisions` and `comparative_statements.lock_path`
-- from this migration entirely. With only DOCUMENT-level locking in scope there
-- is exactly one locking behaviour, so a "which lock mode" setting has nothing
-- to choose between and would be a knob governing nothing.
--
-- This migration is now PURE DATA. It creates no table, alters no column, and
-- touches no existing constraint. The matrix itself needs no schema at all:
-- column order, column visibility and Seq # are presentation state held in the
-- browser, because a display preference must not become part of the audit
-- record.
--
-- Later phases, NOT in this file:
--   064  rfq.closed_at / closed_by_user_id + CHECK, widen audit_log_action_check
--   065  proc.cs_blind_reviews
--
-- ─── ONE SWITCH, NOT TWO ────────────────────────────────────────────────────
-- An earlier draft of this migration carried BOTH `cs.matrixLayout` and a
-- `FF_CS_MATRIX_V2` feature flag for the same decision. Two switches for one
-- thing produce the ambiguous state "matrix selected but flag off, so what
-- renders?" — and that is the "declared but ignored field" defect, not a
-- safety net. `admin.service.ts` records that migration 036 DELETED a
-- core.settings row for exactly this reason: an alias for a value the engine
-- never read, so the Settings screen displayed a second number governing
-- nothing.
--
-- `cs.matrixLayout` wins, because it is admin-visible on the Settings screen
-- and already editable through PATCH /admin/settings. If staged percentage
-- rollout is wanted later, add `rollout_pct` support THEN — as an extension of
-- this one setting, not as a second parallel switch.

BEGIN;

INSERT INTO core.settings
  (key, value, value_type, label, description, group_name, is_toggle, sort_order)
VALUES
  ('cs.matrixLayout', '"VENDOR_SUMMARY"'::jsonb, 'string',
   'CS screen layout',
   'Which layout the Comparative Statement screen renders. VENDOR_SUMMARY = Bid comparison table only, as it does today. MATRIX = adds the line-item Matrix Form as a second tab beside it. The Bid comparison is never removed.',
   'Sourcing', false, 91)
-- Re-runnable. The migration runner applies the WHOLE chain every time, with
-- no ledger of what has already been applied, so a plain INSERT fails the
-- second time round on the settings primary key and takes the whole run down
-- with it. The setting is the same either way — the matrix is still OFF by
-- default — so an admin's later edit is NOT overwritten: the conflict clause
-- leaves an existing row's value alone and only fills in the descriptive
-- columns when they are missing.
ON CONFLICT (key) DO UPDATE
   SET label = EXCLUDED.label,
       description = EXCLUDED.description,
       group_name = EXCLUDED.group_name,
       sort_order = EXCLUDED.sort_order;

-- DEFAULT IS TODAY''S BEHAVIOUR. A migration that turned the matrix on at deploy
-- would change what UAT renders on first restart, which is the opposite of the
-- requirement that UAT stay provably undisturbed until someone chooses it.

DO $$
DECLARE
  dupes integer;
BEGIN
  -- The catalogue is keyed, so this can only fire if a prior run half-applied.
  SELECT count(*) INTO dupes
    FROM core.settings WHERE key = 'cs.matrixLayout';
  IF dupes > 1 THEN
    RAISE EXCEPTION 'cs.matrixLayout appears % times; the settings PK should have prevented this', dupes;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM core.settings WHERE key = 'cs.matrixLayout') THEN
    RAISE EXCEPTION 'cs.matrixLayout was not inserted';
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════════
-- ONE PHASE-1 CODE CHANGE, deliberately not taken here
-- ═══════════════════════════════════════════════════════════════════════════════
-- settings.tsx renders value_type 'string' as a free-text input, and is_toggle
-- only covers booleans. This key holds a 2-value enum and should be a dropdown.
-- That renderer addition is kept out of this file so the migration stays pure
-- data and reviewable on its own.
--
-- Without it the setting is still live and writable through the API — the
-- screen would just accept a typo. So the renderer ships in the same phase as
-- the matrix; until then, do not advertise this control in UAT.
-- ═══════════════════════════════════════════════════════════════════════════════