-- 034_uom_fk_and_attachment_caps.sql
-- Phase: Wave 5 — Track B (admin data backend)
-- Purpose: enforce the UOM vocabulary at the database level, and record the
--          agreed 5 MB per-file attachment cap.
--
-- WHY THIS MIGRATION EXISTS
-- ------------------------
-- Migration 031 created the UOM catalog and deliberately did NOT put a foreign
-- key on proc.pr_lines.uom, because live data violated the vocabulary and a FK
-- would have aborted every subsequent `db:migrate`. This migration closes that
-- gap, as agreed: the offending rows are removed and the FK is applied.
--
-- ── WHY THE ROWS MUST ALSO BE FIXED IN THE E2E FIXTURES ────────────────────
-- Deleting these rows is necessary but NOT sufficient. They are not random
-- corruption — the e2e suite CREATES them on every run:
--     scripts/e2e_sourcing.mjs:114      uom: 'BX'
--     scripts/e2e_sourcing_card.mjs:103  uom: 'BX'
--     scripts/smoke.mjs:54,55           uom: 'pcs'   (lower case)
-- So a FK applied while those fixtures still emit 'BX' and 'pcs' would break the
-- e2e chain on its next run, not prevent bad data. The fixtures were corrected
-- to 'BOX' and 'PCS' in the same change, and the API now normalises and
-- validates the UOM at the write boundary so the failure is a clear 400 rather
-- than a raw foreign-key violation.
--
-- ── WHY THE AFFECTED PRs ARE DELETED, NOT LEFT EMPTY ───────────────────────
-- 13 of the 14 affected PRs had exactly ONE line, and the two 'sheet' lines
-- were both on PR-2026-200001. Deleting only the lines would therefore leave all
-- 14 requisitions with zero lines — a strictly worse kind of garbage than the
-- UOM typo it replaced, and a shape no screen can render or the engine can
-- route. All 14 were verified to have zero dependent rows (no approved pack,
-- comparative statement, budget reservation, D365 push, sync log, amendment,
-- saving, approval vote, escalation, MC session, department row, image or
-- attachment) before removal, so deleting them orphans no audit trail. They are
-- e2e fixtures that the suite recreates on its next run.
--
-- Idempotency: the deletes are natural-key driven and therefore no-ops on a
-- second run; the FK is dropped and re-added so a changed definition applies.

BEGIN;

SET LOCAL search_path = core, proc, public;

-- ─── 1. Remove the non-catalog UOMs, and the requisitions they would empty ──
-- Reported rather than silently swallowed: an admin needs to know rows vanished.

DO $$
DECLARE
  v_lines int;
  v_prs   int;
BEGIN
  -- The affected requisitions are captured BEFORE the lines are deleted. An
  -- earlier revision of this migration re-checked `EXISTS (SELECT 1 FROM
  -- proc.pr_lines ...)` at DELETE time to decide which PRs it had affected — but
  -- by then every one of their lines was already gone, so the guard matched
  -- nothing and all 14 requisitions were silently left empty. The post-condition
  -- caught it, which is the only reason it was not shipped.
  CREATE TEMP TABLE w5a_bad_pr_ids ON COMMIT DROP AS
    SELECT DISTINCT pr_id FROM proc.pr_lines WHERE uom NOT IN (SELECT code FROM core.uom);

  SELECT count(*) INTO v_lines FROM proc.pr_lines WHERE uom NOT IN (SELECT code FROM core.uom);
  IF v_lines > 0 THEN
    RAISE NOTICE 'migration 034: removing % PR line(s) carrying a non-catalog UOM', v_lines;
  END IF;

  DELETE FROM proc.pr_lines WHERE uom NOT IN (SELECT code FROM core.uom);

  -- A requisition with no lines cannot be submitted, routed or rendered, so the
  -- orphan is removed with its line rather than left behind.
  SELECT count(*) INTO v_prs
    FROM proc.purchase_requisitions p
   WHERE p.id IN (SELECT pr_id FROM w5a_bad_pr_ids)
     AND NOT EXISTS (SELECT 1 FROM proc.pr_lines l WHERE l.pr_id = p.id);
  IF v_prs > 0 THEN
    RAISE NOTICE 'migration 034: removing % requisition(s) left with no lines', v_prs;
  END IF;

  DELETE FROM proc.purchase_requisitions p
   WHERE p.id IN (SELECT pr_id FROM w5a_bad_pr_ids)
     AND NOT EXISTS (SELECT 1 FROM proc.pr_lines l WHERE l.pr_id = p.id);
END $$;

-- ─── 2. Strict foreign key on proc.pr_lines.uom ────────────────────────────
-- ON DELETE RESTRICT, not CASCADE: retiring a UOM that is in use must be
-- refused by the database. Deleting a vocabulary value out from under posted PR
-- lines is exactly the silent data loss a vocabulary is supposed to prevent,
-- and the admin screen needs to be told "3 lines still use BOX" rather than
-- discovering later that the history no longer resolves.

ALTER TABLE proc.pr_lines DROP CONSTRAINT IF EXISTS pr_lines_uom_fkey;
ALTER TABLE proc.pr_lines
  ADD CONSTRAINT pr_lines_uom_fkey
  FOREIGN KEY (uom) REFERENCES core.uom(code) ON DELETE RESTRICT;

COMMENT ON CONSTRAINT pr_lines_uom_fkey ON proc.pr_lines IS
  'A PR line''s UOM must be a catalog unit (migration 031). ON DELETE RESTRICT so '
  'a UOM cannot be retired while lines still reference it.';

-- ─── 3. The 5 MB per-file attachment cap ───────────────────────────────────
-- An explicit decision, not an inference. The prototype's ATT_CAP_BYTES of
-- 4,500,000 was a localStorage quota artefact; this is a real server-side limit
-- on object storage and is deliberately a different, round number.
--
-- Seeded as a scalar setting so W5-E's upload path reads one value rather than
-- hardcoding a byte count. The per-PR total is NOT seeded: that limit was not
-- specified, and inventing one would be a business rule nobody agreed to.
INSERT INTO core.settings (key, value, value_type, label, description, group_name, is_toggle, sort_order)
VALUES ('attachmentMaxBytes', to_jsonb(5242880::bigint), 'int', 'Max attachment size (bytes)',
        'Server-side per-file upload ceiling. 5,242,880 bytes = 5 MiB. Applies to every uploaded attachment; uploads above it are refused, not truncated.',
        'Attachments', false, 7)
ON CONFLICT (key) DO NOTHING;

-- ─── Post-condition check (inside the transaction, so a failure rolls back) ─

DO $$
DECLARE
  bad_uom   int;
  fk_exists boolean;
  cap_value bigint;
  empty_prs int;
BEGIN
  -- The whole point of this migration: the vocabulary must now be enforced.
  SELECT count(*) INTO bad_uom
    FROM proc.pr_lines l
   WHERE NOT EXISTS (SELECT 1 FROM core.uom u WHERE u.code = l.uom);
  IF bad_uom > 0 THEN
    RAISE EXCEPTION 'migration 034: % PR line(s) still carry a non-catalog UOM after cleanup', bad_uom;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pr_lines_uom_fkey'
       AND conrelid = 'proc.pr_lines'::regclass
       AND contype = 'f'
  ) INTO fk_exists;
  IF NOT fk_exists THEN
    RAISE EXCEPTION 'migration 034: the pr_lines.uom foreign key is not present';
  END IF;

  -- A FK that exists but is NOT VALID would allow existing bad rows to persist,
  -- so assert it was validated, not merely created.
  IF NOT (SELECT convalidated FROM pg_constraint
           WHERE conname = 'pr_lines_uom_fkey' AND conrelid = 'proc.pr_lines'::regclass) THEN
    RAISE EXCEPTION 'migration 034: the pr_lines.uom foreign key exists but is NOT VALID';
  END IF;

  SELECT (value #>> '{}')::bigint INTO cap_value
    FROM core.settings WHERE key = 'attachmentMaxBytes';
  IF cap_value IS DISTINCT FROM 5242880 THEN
    RAISE EXCEPTION 'migration 034: attachmentMaxBytes is %, expected 5242880 (5 MiB)', coalesce(cap_value::text, 'unset');
  END IF;

  -- None of the requisitions this migration emptied may be left behind. Scoped to
  -- the affected set captured earlier (the temp table lives until COMMIT), not to
  -- the whole table, so an unrelated empty PR from a later test run cannot break
  -- every future replay (the 032 lesson).
  SELECT count(*) INTO empty_prs
    FROM proc.purchase_requisitions p
   WHERE p.id IN (SELECT pr_id FROM w5a_bad_pr_ids)
     AND NOT EXISTS (SELECT 1 FROM proc.pr_lines l WHERE l.pr_id = p.id);
  IF empty_prs > 0 THEN
    RAISE EXCEPTION 'migration 034: % emptied requisition(s) were left with no lines', empty_prs;
  END IF;

  RAISE NOTICE 'migration 034 verified — every PR line UOM is a catalog unit, FK present and VALID, 5 MiB cap seeded, no empty requisitions';
END $$;

COMMIT;
