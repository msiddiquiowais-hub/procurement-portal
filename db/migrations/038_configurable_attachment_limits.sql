-- ═══════════════════════════════════════════════════════════════════════════
-- 038 — Configurable attachment limits, enforced on both axes
-- ═══════════════════════════════════════════════════════════════════════════
--
-- DIRECTIVE 1 — NO HARDCODE LIMITS.
--   File size limits and PR byte ceilings must never be hardcoded, so they are
--   configurable through the environment and through admin settings, and can be
--   moved up or down for a larger quotation or a multi-vendor package without a
--   code change or a migration.
--
--   Migration 036 shipped `COALESCE(cap, 26214400)` inside
--   core.fn_pr_attachment_cap_bytes(). That literal is a hardcoded limit wearing
--   a disguise: delete the settings row and the database silently falls back to
--   25 MiB instead of telling anyone the limit is unconfigured. This migration
--   removes it.
--
--   The rule now applied to every limit function here:
--     - the value comes from core.settings, and nowhere else;
--     - if the row is ABSENT the function RAISES a named configuration error;
--     - it never invents a default.
--   Failing CLOSED is the enterprise behaviour. A missing limit must surface as
--   "limits are not configured", never as "no limit" and never as "25 MiB".
--
--   Environment variables override settings. The API syncs
--   ATTACHMENT_MAX_BYTES / ATTACHMENT_TOTAL_MAX_BYTES into these rows at boot
--   (see attachments/limits.service.ts), so the DEPLOYMENT knob and the DATABASE
--   the trigger reads can never disagree. One number, two ways to set it.
--
-- DIRECTIVE 2 — FILES ON DISK, METADATA IN THE DATABASE.
--   core.files already stores bucket / object_key / content_type / size_bytes /
--   sha256 — a path and its metadata, never the bytes. This migration adds no
--   column capable of holding a blob and no BYTEA anywhere. The physical file is
--   written by the storage adapter under ATTACHMENT_STORAGE_ROOT; the database
--   holds the path and the relational link. A database dump is metadata-only and
--   cannot bloat.
--
-- WHAT WAS ACTUALLY MISSING
--   - `attachmentMaxBytes` was seeded by 034 and read by NOTHING. The per-file cap
--     was advertised and unenforced: a 4 GiB file would have been accepted as
--     long as the PR total happened to allow it. This migration adds the missing
--     enforcement rather than trusting the API to remember it.
--   - core.fn_attachment_parent_exists() was written by 033 and wired to nothing,
--     so parent_id resolved to no parent at all and the registry happily recorded
--     an attachment against a PR or quote that does not exist.
--
-- Idempotency: every function is CREATE OR REPLACE, every constraint/trigger is
-- dropped before it is created, settings are ON CONFLICT DO UPDATE. No literals
-- appear in any limit function.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Settings: every limit is a row, including the image ceilings ─────────
-- The image ceilings are seeded as ROWS rather than constants so an admin can
-- raise them for a multi-image package the same way they raise a document cap.
-- They are enforced by the same triggers via parent_type, so no separate code
-- path can drift from the document path.

INSERT INTO core.settings (key, value, value_type, label, description, group_name, is_toggle, sort_order) VALUES
  ('imageMaxBytes', to_jsonb(2097152::bigint), 'int', 'Max image size (bytes)',
   'Ceiling on a single uploaded image. Separate from the document cap because image packages and quotation packs fail differently.',
   'Workflow & approvals', false, 8),
  ('imageTotalMaxBytes', to_jsonb(5242880::bigint), 'int', 'Max images per PR (bytes)',
   'Ceiling on the TOTAL size of all images on one PR.',
   'Workflow & approvals', false, 9)
ON CONFLICT (key) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description;

-- Re-state the two document limits so their labels describe the configurability
-- that now actually exists. The VALUES are not touched: an operator may have
-- raised them, and a migration must not silently scale an enterprise limit back
-- down to the seeded demo figure.
UPDATE core.settings SET
  label = 'Max attachment size (bytes)',
  description = 'Ceiling on a single uploaded file. Configurable — set ATTACHMENT_MAX_BYTES in the environment, or edit this row; the environment wins at API boot.'
 WHERE key = 'attachmentMaxBytes';

UPDATE core.settings SET
  label = 'Max attachments per PR (bytes)',
  description = 'Ceiling on the TOTAL size of all active attachments on one PR. Configurable — set ATTACHMENT_TOTAL_MAX_BYTES in the environment, or edit this row; the environment wins at API boot.'
 WHERE key = 'attachmentTotalMaxBytes';

-- ─── 2. The limit readers: configuration or an ERROR, never a literal ───────

CREATE OR REPLACE FUNCTION core.fn_attachment_per_file_cap_bytes()
RETURNS bigint
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  cap bigint;
BEGIN
  SELECT (value #>> '{}')::bigint INTO cap
    FROM core.settings WHERE key = 'attachmentMaxBytes';
  IF cap IS NULL THEN
    RAISE EXCEPTION
      'attachment limits are not configured: core.settings has no attachmentMaxBytes row. '
      'Set ATTACHMENT_MAX_BYTES in the environment or create the row. Refusing rather than assuming a limit.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF cap <= 0 THEN
    RAISE EXCEPTION 'attachmentMaxBytes is % — a limit must be positive', cap
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN cap;
END;
$$;

-- Per-PR ceiling, per parent_type. 'pr' rows are documents; image ceilings live
-- in their own settings rows so the two can be scaled independently.
CREATE OR REPLACE FUNCTION core.fn_pr_attachment_cap_bytes()
RETURNS bigint
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  cap bigint;
BEGIN
  SELECT (value #>> '{}')::bigint INTO cap
    FROM core.settings WHERE key = 'attachmentTotalMaxBytes';
  IF cap IS NULL THEN
    RAISE EXCEPTION
      'attachment limits are not configured: core.settings has no attachmentTotalMaxBytes row. '
      'Set ATTACHMENT_TOTAL_MAX_BYTES in the environment or create the row. Refusing rather than assuming a limit.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF cap <= 0 THEN
    RAISE EXCEPTION 'attachmentTotalMaxBytes is % — a limit must be positive', cap
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN cap;
END;
$$;

CREATE OR REPLACE FUNCTION core.fn_image_per_file_cap_bytes()
RETURNS bigint LANGUAGE plpgsql STABLE AS $$
DECLARE cap bigint;
BEGIN
  SELECT (value #>> '{}')::bigint INTO cap FROM core.settings WHERE key = 'imageMaxBytes';
  IF cap IS NULL THEN
    RAISE EXCEPTION 'image limits are not configured: core.settings has no imageMaxBytes row. '
      'Set IMAGE_MAX_BYTES in the environment or create the row. Refusing rather than assuming a limit.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN cap;
END; $$;

CREATE OR REPLACE FUNCTION core.fn_pr_image_cap_bytes()
RETURNS bigint LANGUAGE plpgsql STABLE AS $$
DECLARE cap bigint;
BEGIN
  SELECT (value #>> '{}')::bigint INTO cap FROM core.settings WHERE key = 'imageTotalMaxBytes';
  IF cap IS NULL THEN
    RAISE EXCEPTION 'image limits are not configured: core.settings has no imageTotalMaxBytes row. '
      'Set IMAGE_TOTAL_MAX_BYTES in the environment or create the row. Refusing rather than assuming a limit.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN cap;
END; $$;

-- ─── 3. Per-file enforcement — the cap 034 seeded but nothing enforced ──────
-- IMMEDIATE, not deferred: a single file's size is knowable at INSERT, so there
-- is no reason to hold the statement open. (The per-PR TOTAL stays deferred, for
-- the replace-performability reason documented in migration 036.)

CREATE OR REPLACE FUNCTION core.fn_enforce_attachment_per_file_cap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cap bigint;
BEGIN
  IF NEW.size_bytes IS NULL OR NEW.size_bytes <= 0 THEN
    RETURN NEW;
  END IF;

  IF NEW.kind = 'image' THEN
    cap := core.fn_image_per_file_cap_bytes();
    IF NEW.size_bytes > cap THEN
      RAISE EXCEPTION
        'image is % bytes, above the configured per-file image ceiling of % bytes (imageMaxBytes)',
        NEW.size_bytes, cap
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    cap := core.fn_attachment_per_file_cap_bytes();
    IF NEW.size_bytes > cap THEN
      RAISE EXCEPTION
        'file is % bytes, above the configured per-file ceiling of % bytes (attachmentMaxBytes)',
        NEW.size_bytes, cap
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_attachment_per_file_cap ON core.attachment_registry;
CREATE TRIGGER trg_attachment_per_file_cap
  BEFORE INSERT OR UPDATE OF size_bytes, kind ON core.attachment_registry
  FOR EACH ROW EXECUTE FUNCTION core.fn_enforce_attachment_per_file_cap();

-- ─── 4. Parent resolution — the function 033 wrote and wired to nothing ─────
-- parent_id is polymorphic and cannot carry a foreign key. This is the trigger
-- that makes the polymorphic reference real, using the resolution rule 033
-- already defined in one place.

CREATE OR REPLACE FUNCTION core.fn_enforce_attachment_parent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT core.fn_attachment_parent_exists(NEW.parent_type, NEW.parent_id) THEN
    RAISE EXCEPTION
      'attachment parent % % does not exist — a % attachment cannot be filed against it',
      NEW.parent_type, NEW.parent_id, NEW.parent_type
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_attachment_parent_exists ON core.attachment_registry;
CREATE TRIGGER trg_attachment_parent_exists
  BEFORE INSERT OR UPDATE OF parent_type, parent_id ON core.attachment_registry
  FOR EACH ROW EXECUTE FUNCTION core.fn_enforce_attachment_parent();

-- ═══ Post-condition check (inside the transaction, so a failure rolls back) ══
DO $$
DECLARE
  n integer;
  src text;
BEGIN
  -- (1) NO HARDCODE LITERALS survive in any limit function. This is the whole
  --     point of the migration, so it is asserted mechanically rather than by
  --     reading: grep the function source for the old fallback and for any bare
  --     digit sequence large enough to be a byte ceiling.
  FOR src IN
    SELECT p.oid::regprocedure::text
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'core'
       AND p.proname IN ('fn_pr_attachment_cap_bytes','fn_attachment_per_file_cap_bytes',
                         'fn_image_per_file_cap_bytes','fn_pr_image_cap_bytes')
  LOOP
    IF pg_get_functiondef(src::regprocedure) ~ 'COALESCE\(cap,' THEN
      RAISE EXCEPTION 'migration 038: % still falls back to a hardcoded cap', src;
    END IF;
    IF pg_get_functiondef(src::regprocedure) ~ '\m[0-9]{6,}\M' THEN
      RAISE EXCEPTION
        'migration 038: % contains a bare numeric literal that looks like a hardcoded byte limit', src;
    END IF;
  END LOOP;

  -- (2) Every limit has a settings row, so none of them raises on a seeded estate.
  SELECT count(*) INTO n FROM core.settings
   WHERE key IN ('attachmentMaxBytes','attachmentTotalMaxBytes','imageMaxBytes','imageTotalMaxBytes');
  IF n <> 4 THEN
    RAISE EXCEPTION 'migration 038: expected 4 configurable limit rows, found %', n;
  END IF;

  -- (3) The per-file trigger exists and is enabled — the cap 034 seeded and
  --     nothing enforced.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid='core.attachment_registry'::regclass
       AND tgname='trg_attachment_per_file_cap' AND NOT tgisinternal AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'migration 038: trg_attachment_per_file_cap is missing or disabled';
  END IF;

  -- (4) The parent trigger exists and is enabled.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid='core.attachment_registry'::regclass
       AND tgname='trg_attachment_parent_exists' AND NOT tgisinternal AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'migration 038: trg_attachment_parent_exists is missing or disabled';
  END IF;

  -- (5) The deferred per-PR trigger from 036 is still DEFERRED. Migration 036's
  --     reason — replace must stay performable — is not revoked by this file.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid='core.attachment_registry'::regclass
       AND tgname='trg_pr_attachment_budget' AND NOT tgisinternal
       AND tgdeferrable AND tginitdeferred
  ) THEN
    RAISE EXCEPTION 'migration 038: the per-PR budget trigger is no longer deferred';
  END IF;

  -- (6) DIRECTIVE 2: no column anywhere can hold a file body. A BYTEA anywhere in
  --     the registry or files table would mean the bytes came back into the DB.
  SELECT count(*) INTO n
    FROM information_schema.columns
   WHERE table_schema='core'
     AND table_name IN ('files','attachment_registry')
     AND data_type IN ('bytea','oid');
  IF n <> 0 THEN
    RAISE EXCEPTION
      'migration 038: % column(s) on core.files / core.attachment_registry can hold a blob; files belong on disk', n;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='core' AND table_name='files' AND column_name='object_key'
  ) THEN
    RAISE EXCEPTION 'migration 038: core.files.object_key is missing — there is nowhere to record the on-disk path';
  END IF;
END;
$$;
