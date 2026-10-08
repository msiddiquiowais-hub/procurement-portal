-- 033_attachment_registry.sql
-- Phase: Wave 5 — Track A (Foundations)
-- Purpose: create the global attachment registry described in Blueprint Part 11,
--          so attachment lifecycle is data rather than an absent feature.
--
-- WHY THIS MIGRATION EXISTS
-- ------------------------
-- `core.files` and `proc.pr_attachments` exist and hold nothing: both are empty
-- on the live database. `core.files` already carries the right physical columns
-- (bucket, object_key, content_type, size_bytes, sha256, version,
-- superseded_by_file_id) but it describes BYTES, not ATTACHMENTS — it has no
-- notion of which PR or quote version a document belongs to, no status, no
-- visibility, and no audit trail. The gap analysis records this as #10, HIGH.
--
-- ── THE 16-FIELD REGISTRY RECORD ───────────────────────────────────────────
-- Blueprint Part 11.1 specifies exactly:
--   aid, name, mimeType, sizeBytes, dataUrl, uploadedAt, uploadedBy, kind,
--   version, tags, parentType, parentId, visibility, supersededBy, status,
--   auditTrail
--
-- Fifteen of those map to a column here. ONE DOES NOT, and the divergence is
-- deliberate:
--
--   dataUrl -> file_id (FK core.files)
--   The prototype stores attachment bytes as data URLs inside localStorage, so
--   the record carries its own copy. The port already has a storage table
--   designed for object storage, and the blueprint itself says the adapter is
--   swappable — "production can switch to Supabase Storage without touching UI
--   code". The registry therefore REFERENCES core.files rather than duplicating
--   bytes, which is the same adapter-swap the blueprint describes, already done.
--   This is a correction of a prototype storage choice, not a missing feature.
--
-- auditTrail is a child TABLE (core.attachment_audit), not a column, because the
-- seven actions are append-only and queryable in their own right.
--
-- Note for the record: the gap analysis calls this a "19-field registry record".
-- The blueprint lists 16. This migration implements the blueprint's 16.
--
-- ── ATTACHMENT VERSIONING IS INDEPENDENT OF QUOTE VERSIONING ────────────────
-- This is the requirement most likely to be got wrong, so it is enforced here.
-- proc.quotations carries its own `version` and `supersedes_quotation_id`. An
-- attachment is bound to a SPECIFIC quotation id (parent_type='quote',
-- parent_id = quotations.id), not to "the current version of that quotation".
-- Superseding a quotation therefore does not touch its attachments, and V1's PDF
-- stays with V1. The attachment's own `version` column is a separate counter,
-- advanced only by an explicit Replace.
--
-- Enforced by a partial unique index: at most one ACTIVE record per
-- (parent_type, parent_id, name). That is what makes "Replace" well-defined —
-- mint a new ACTIVE, flip the old one to SUPERSEDED and point superseded_by at
-- it. Without this index two ACTIVE records for the same name could coexist and
-- "which one is current" would be unanswerable.
--
-- ── TWO THINGS DELIBERATELY NOT DONE HERE ──────────────────────────────────
--
-- 1. NO CAP/SIZE POLICY IS SEEDED. The prototype's ATT_CAP_BYTES = 4,500,000 is
--    a localStorage quota artefact — it bounded what could be jammed into a
--    browser profile. Server-side object storage has no such ceiling, and picking
--    a number here would be inventing a business rule nobody specified. W5-E
--    must set the per-file and per-PR limits with the user.
--
-- 2. NO TRIGGER ENFORCES THAT parent_id RESOLVES. parent_id is polymorphic
--    (parent_type 'pr' -> proc.purchase_requisitions, 'quote' ->
--    proc.quotations), so no single FOREIGN KEY can cover it. The lookup helper
--    is provided below; the trigger that would call it lands with the service in
--    W5-E, where the parent tables and the write path both exist. Stating the
--    gap here is better than a CHECK that looks like enforcement and is not.
--
-- Idempotency: backfill is guarded by NOT EXISTS, ON CONFLICT DO NOTHING on the
-- partial unique index, and the audit-action set is immutable.

BEGIN;

SET LOCAL search_path = core, proc, public;

-- ─── 1. Immutable vocabulary ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS core.attachment_status (
  status text PRIMARY KEY,
  label  text NOT NULL,
  description text NOT NULL
);

INSERT INTO core.attachment_status (status, label, description) VALUES
  ('ACTIVE',     'Active',     'The current version of this attachment. At most one per (parent, name).'),
  ('SUPERSEDED', 'Superseded', 'Replaced by a newer version. Retained: a V1 PDF must stay with V1.'),
  ('VOID',       'Void',       'Withdrawn. This is the ONLY removal path — the prototype has no delete.')
ON CONFLICT (status) DO NOTHING;

CREATE TABLE IF NOT EXISTS core.attachment_audit_actions (
  action     text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO core.attachment_audit_actions (action, description) VALUES
  ('UPLOADED',              'A new attachment was added to its parent.'),
  ('MIGRATED_FROM_LEGACY',  'Imported from the pre-registry proc.pr_attachments[] array on first read.'),
  ('SUPERSEDED',            'A newer version replaced this one; the old record is kept, not deleted.'),
  ('REPLACED',              'This record is the replacement that superseded a prior version.'),
  ('VIEWED',                'A user opened the attachment.'),
  ('DOWNLOADED',            'A user downloaded the attachment.'),
  ('VOIDED',                'A user voided the attachment. There is no hard delete.')
ON CONFLICT (action) DO NOTHING;

-- ─── 2. The registry ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS core.attachment_registry (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  file_id            uuid NOT NULL REFERENCES core.files(id),
  mime_type          text NOT NULL,
  size_bytes         bigint NOT NULL,
  kind               text NOT NULL,
  version            int NOT NULL DEFAULT 1,
  tags               text[] NOT NULL DEFAULT '{}',
  parent_type        text NOT NULL,
  parent_id          uuid NOT NULL,
  visibility         text NOT NULL DEFAULT 'all',
  status             text NOT NULL DEFAULT 'ACTIVE' REFERENCES core.attachment_status(status),
  superseded_by      uuid REFERENCES core.attachment_registry(id),
  uploaded_by_user_id uuid REFERENCES core.users(id),
  uploaded_at        timestamptz NOT NULL DEFAULT now(),
  voided_by_user_id  uuid REFERENCES core.users(id),
  voided_at          timestamptz,
  CONSTRAINT attachment_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT attachment_size_nonneg CHECK (size_bytes >= 0),
  CONSTRAINT attachment_version_positive CHECK (version >= 1),
  CONSTRAINT attachment_parent_type_known CHECK (parent_type IN ('pr','quote')),
  -- 'all', or an exact role match. A role-named value is what the picker reads.
  CONSTRAINT attachment_visibility_shape CHECK (visibility = 'all' OR btrim(visibility) <> ''),
  CONSTRAINT attachment_kind_known CHECK (kind IN ('pdf','image','doc','xls','other')),
  -- A VOID record must say who voided it and when; an ACTIVE one must not be voided.
  CONSTRAINT attachment_void_consistent CHECK (
    (status = 'VOID' AND voided_at IS NOT NULL AND voided_by_user_id IS NOT NULL)
    OR (status <> 'VOID' AND voided_at IS NULL)
  ),
  -- A SUPERSEDED record must point at what replaced it.
  CONSTRAINT attachment_supersede_consistent CHECK (
    (status = 'SUPERSEDED' AND superseded_by IS NOT NULL)
    OR (status <> 'SUPERSEDED')
  ),
  -- An ACTIVE record is by definition the one that is not superseded.
  CONSTRAINT attachment_active_not_superseded CHECK (
    status <> 'ACTIVE' OR superseded_by IS NULL
  )
);

-- At most one ACTIVE version per attachment name per parent. This is what makes
-- "Replace" well-defined, and it is the database half of "attachment versioning
-- is independent of quote versioning": a V1 PDF and a V2 PDF live under DIFFERENT
-- parent_ids (two quotations), so both can be ACTIVE at once, by design.
--
-- IT MUST BE A DEFERRABLE EXCLUDE, NOT A PARTIAL UNIQUE INDEX. This was found the
-- hard way, by trying to perform the lifecycle this constraint exists to enable:
--
--   Replace = mint the new record, flip the old one to SUPERSEDED, point
--             superseded_by at the new one.
--
-- Under a UNIQUE ... WHERE (status = 'ACTIVE') index the sequence is impossible.
-- The new row must be inserted as ACTIVE, but the old row is still ACTIVE, so the
-- index refuses the insert. Flip the old one first and you cannot point
-- superseded_by at a row that does not exist yet. The only order that survives is a
-- three-step dance (insert new as SUPERSEDED, supersede old, promote new) which
-- leaves the record in a lying intermediate state if a step is missed outside a
-- transaction. A constraint that makes its own feature unperformable is worse than
-- no constraint, because it looks correct.
--
-- A DEFERRABLE INITIALLY DEFERRED exclusion constraint is checked at COMMIT, so
-- both steps may happen in either order inside one transaction, while still
-- refusing to leave two ACTIVE rows behind. Verified in db/scripts/verify_w5a.sql.
--
-- Requires btree_gist (added in migration 001): GiST has no default opclass for
-- text, so `EXCLUDE USING gist` over these text/uuid columns needs it.
-- An earlier revision of this migration created the constraint as a partial
-- UNIQUE INDEX under this same name; a later run finds the EXCLUDE constraint
-- already present. Both are cleared first so the migration is re-runnable — the
-- whole set is replayed in lexical order on every `db:migrate`, and a migration
-- that only works once is a landmine for the next person who re-runs it (the
-- 019/020/027 failure mode).
--
-- The index cannot simply be dropped first: once the EXCLUDE constraint exists it
-- OWNS the index, and `DROP INDEX` on a constraint-backed index errors even with
-- IF EXISTS. So drop the index only when it is standalone, then drop the
-- constraint, then re-add.
DO $$
BEGIN
  IF EXISTS (
        SELECT 1
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'core'
           AND c.relname = 'uq_attachment_active_per_parent_name'
           AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = c.oid)
       ) THEN
    EXECUTE 'DROP INDEX core.uq_attachment_active_per_parent_name';
  END IF;
END $$;

ALTER TABLE core.attachment_registry
  DROP CONSTRAINT IF EXISTS uq_attachment_active_per_parent_name;
ALTER TABLE core.attachment_registry
  ADD CONSTRAINT uq_attachment_active_per_parent_name
  EXCLUDE USING gist (parent_type WITH =, parent_id WITH =, name WITH =)
  WHERE (status = 'ACTIVE') DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX IF NOT EXISTS idx_attachment_parent
  ON core.attachment_registry (parent_type, parent_id, status);

-- The picker's list is "everything on this parent, newest version first".
CREATE INDEX IF NOT EXISTS idx_attachment_name_version
  ON core.attachment_registry (name, version DESC);

-- ─── 3. The audit trail ────────────────────────────────────────────────────
-- Append-only. One row per action, carrying the actor and a jsonb detail bag so
-- a future action can record context without a migration.

CREATE TABLE IF NOT EXISTS core.attachment_audit (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attachment_id   uuid NOT NULL REFERENCES core.attachment_registry(id) ON DELETE CASCADE,
  action          text NOT NULL REFERENCES core.attachment_audit_actions(action),
  actor_user_id   uuid REFERENCES core.users(id),
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attachment_audit_by_attachment
  ON core.attachment_audit (attachment_id, at);

-- ─── 4. Polymorphic parent lookup helper ───────────────────────────────────
-- parent_id cannot carry a foreign key (see the header). W5-E turns this into
-- a trigger; exposing it as a function now means the resolution rule lives in
-- exactly one place instead of being re-implemented per caller.

-- MIME -> kind, per Blueprint Part 11.4.9. Defined as a function (not a CASE
-- inline at each call site) so the backfill below, the W5-E service, and the
-- post-condition all agree by construction — a divergent second copy of this
-- mapping is how an upload ends up filed under the wrong kind.
CREATE OR REPLACE FUNCTION core.fn_attachment_kind(p_mime_type text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
           WHEN p_mime_type IS NULL THEN 'other'
           WHEN lower(p_mime_type) = 'application/pdf' THEN 'pdf'
           WHEN lower(p_mime_type) IN ('image/png','image/jpeg','image/gif','image/webp') THEN 'image'
           WHEN lower(p_mime_type) IN ('application/msword',
                 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') THEN 'doc'
           WHEN lower(p_mime_type) IN ('application/vnd.ms-excel',
                 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') THEN 'xls'
           ELSE 'other'
         END;
$$;

COMMENT ON FUNCTION core.fn_attachment_kind(text) IS
  'Maps a MIME type to the prototype''s attachment kind (pdf/image/doc/xls/other). '
  'Single source of truth for the backfill, the W5-E service and the post-condition check.';

CREATE OR REPLACE FUNCTION core.fn_attachment_parent_exists(p_parent_type text, p_parent_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF p_parent_type = 'pr' THEN
    RETURN EXISTS (SELECT 1 FROM proc.purchase_requisitions WHERE id = p_parent_id);
  ELSIF p_parent_type = 'quote' THEN
    RETURN EXISTS (SELECT 1 FROM proc.quotations WHERE id = p_parent_id);
  END IF;
  RETURN false;
END;
$$;

COMMENT ON FUNCTION core.fn_attachment_parent_exists(text, uuid) IS
  'Resolves a polymorphic attachment parent. parent_id carries no FK by design; '
  'W5-E wires this into a trigger on core.attachment_registry.';

-- ─── 5. Legacy backfill ────────────────────────────────────────────────────
-- The prototype migrates a pre-registry pr.attachments[] array into the registry
-- on first read with the note "Auto-migrated from pr.attachments[]". The
-- equivalent rows already exist here as proc.pr_attachments (pr_id, file_id,
-- purpose) joined to core.files. Both tables are EMPTY on the live database, so
-- this is a no-op today — but it must be present and correct for any database
-- that does carry them, and it must be safe to re-run.

INSERT INTO core.attachment_registry
  (name, file_id, mime_type, size_bytes, kind, version, parent_type, parent_id,
   status, uploaded_by_user_id, uploaded_at, visibility)
SELECT
  f.object_key,
  f.id,
  f.content_type,
  f.size_bytes,
  core.fn_attachment_kind(f.content_type),
  COALESCE(f.version, 1),
  'pr',
  a.pr_id,
  'ACTIVE',
  f.uploaded_by_user_id,
  f.uploaded_at,
  'all'
  FROM proc.pr_attachments a
  JOIN core.files f ON f.id = a.file_id
 WHERE NOT EXISTS (
         SELECT 1 FROM core.attachment_registry r
          WHERE r.parent_type = 'pr' AND r.parent_id = a.pr_id AND r.file_id = a.file_id
       );

-- Record the migration in the audit trail for anything the backfill created.
INSERT INTO core.attachment_audit (attachment_id, action, actor_user_id, detail)
SELECT r.id, 'MIGRATED_FROM_LEGACY', NULL,
       jsonb_build_object('note', 'Auto-migrated from pr.attachments[]', 'purpose', a.purpose)
  FROM proc.pr_attachments a
  JOIN core.attachment_registry r
    ON r.parent_type = 'pr' AND r.parent_id = a.pr_id AND r.file_id = a.file_id
 WHERE NOT EXISTS (
         SELECT 1 FROM core.attachment_audit au
          WHERE au.attachment_id = r.id AND au.action = 'MIGRATED_FROM_LEGACY'
       );

-- ─── Post-condition check (inside the transaction, so a failure rolls back) ─

DO $$
DECLARE
  n_status   int;
  n_actions  int;
  n_registry int;
  n_dupes    int;
  bad_kind   int;
  bad_void   int;
BEGIN
  SELECT count(*) INTO n_status FROM core.attachment_status;
  IF n_status <> 3 THEN
    RAISE EXCEPTION 'migration 033: expected 3 attachment statuses (ACTIVE/SUPERSEDED/VOID), found %', n_status;
  END IF;

  SELECT count(*) INTO n_actions FROM core.attachment_audit_actions;
  IF n_actions <> 7 THEN
    RAISE EXCEPTION 'migration 033: expected 7 audit actions, found %', n_actions;
  END IF;

  -- The partial unique index is the whole point of the Replace lifecycle; prove
  -- it is actually enforcing rather than merely present.
  SELECT count(*) INTO n_dupes FROM (
    SELECT parent_type, parent_id, name FROM core.attachment_registry
     WHERE status = 'ACTIVE'
     GROUP BY parent_type, parent_id, name HAVING count(*) > 1
  ) d;
  IF n_dupes > 0 THEN
    RAISE EXCEPTION 'migration 033: % parent/name group(s) have more than one ACTIVE attachment', n_dupes;
  END IF;

  SELECT count(*) INTO bad_kind
    FROM core.attachment_registry
   WHERE kind <> core.fn_attachment_kind(mime_type);
  IF bad_kind > 0 THEN
    RAISE EXCEPTION 'migration 033: % attachment(s) have a kind that contradicts their MIME type', bad_kind;
  END IF;

  -- A VOID record without an actor, or a non-VOID record carrying voided_at,
  -- would both be invisible corruption of the audit story.
  SELECT count(*) INTO bad_void
    FROM core.attachment_registry
   WHERE (status = 'VOID' AND (voided_at IS NULL OR voided_by_user_id IS NULL))
      OR (status <> 'VOID' AND voided_at IS NOT NULL);
  IF bad_void > 0 THEN
    RAISE EXCEPTION 'migration 033: % attachment(s) have inconsistent void bookkeeping', bad_void;
  END IF;

  SELECT count(*) INTO n_registry FROM core.attachment_registry;
  RAISE NOTICE 'migration 033 verified — 3 statuses, 7 audit actions, % registry row(s), one ACTIVE per parent/name enforced, kinds agree with MIME types', n_registry;
END $$;

COMMIT;
