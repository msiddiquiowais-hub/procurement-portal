-- 056_quotation_attachments.sql
--
-- Attach the vendor's own quotation document to the QUOTATION VERSION it
-- belongs to.
--
-- WHY NOT proc.pr_attachments
-- --------------------------
-- pr_attachments links a file to a PR, and its key is (pr_id, file_id,
-- purpose). That answers "which documents exist for this PR" but cannot answer
-- "which document did V2 arrive with". Quotation versions are APPEND-ONLY â€” V1
-- is never rewritten, it is marked Superseded â€” so the document has to be pinned
-- to the same version as the numbers it evidences. Otherwise an auditor asking
-- "what did this vendor actually send us on 3 October?" gets whatever file
-- happened to be attached to the PR, which by then may be the V5 scan.
--
-- WHY NOT A COLUMN ON proc.quotations
-- -----------------------------------
-- Same reason, one level up: a revision may carry a different scan (a revised
-- offer letter). One row per (quotation, file) also allows a quote evidenced by
-- two documents â€” the quotation plus a signed letter of intent â€” without a
-- second column and a "which one is authoritative" flag to maintain.
--
-- REPLAY SAFE
-- -----------
-- No migration ledger exists in this project: db/scripts/migrate.ps1 replays
-- every *.sql on every run, so this file is written to be a no-op once applied.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS proc.quotation_attachments (
  quotation_id uuid NOT NULL REFERENCES proc.quotations(id) ON DELETE CASCADE,
  -- core.attachment_registry.id, NOT core.files.id.
  --
  -- The upload endpoint returns the REGISTRY id (AttachmentsService returns
  -- `attachment_id: row.id`, where row.id came from an INSERT into
  -- attachment_registry). The bytes live in core.files; the registry row is the
  -- addressable thing with a name, a version, a status and an audit trail.
  -- Referencing core.files directly accepted a file that existed but had no
  -- registry row — i.e. a document nothing can list, void or download.
  attachment_id uuid NOT NULL REFERENCES core.attachment_registry(id) ON DELETE CASCADE,
  -- What this document IS, in the officer's words. Free text on purpose: a
  -- CHECK enum would need a migration the first time someone uploads a
  -- "revised offer letter", and an unrecognised purpose is far less harmful
  -- than a refused upload.
  kind         text NOT NULL DEFAULT 'quotation',
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- One document cannot be linked to the same version twice. Two DIFFERENT documents
  -- legitimately can (quotation + covering letter), so the key stops at attachment_id.
  PRIMARY KEY (quotation_id, attachment_id)
);

COMMENT ON TABLE proc.quotation_attachments IS
  'The vendor''s own quotation document, pinned to the exact version of the numbers it evidences.';
COMMENT ON COLUMN proc.quotation_attachments.kind IS
  'quotation | cover_letter | amendment | other â€” officer-supplied label, not an enum.';

-- The CS and award screens read a quotation by id and want its documents in the
-- same round trip. Without this index that lookup is a sequential scan of every
-- link ever written.
CREATE INDEX IF NOT EXISTS quotation_attachments_attachment_idx
  ON proc.quotation_attachments (attachment_id);

\echo '--- 056: quotation_attachments ready ---'
SELECT count(*) AS existing_links FROM proc.quotation_attachments;

COMMIT;
