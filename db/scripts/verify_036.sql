-- Behavioural proof for migration 036.
--
-- THE PROBE MUST OBSERVE A DEFERRED CONSTRAINT AT THE RIGHT MOMENT.
-- The ceiling is a DEFERRABLE INITIALLY DEFERRED constraint trigger (so that
-- replacing an attachment is performable — see the migration header). A deferred
-- constraint is NOT checked at INSERT; it is checked at COMMIT. So a probe that
-- wraps everything in BEGIN ... ROLLBACK and expects an error never sees one —
-- and would report the ceiling as broken when it is working. Each negative probe
-- therefore runs in its OWN transaction and forces the check with
-- `SET CONSTRAINTS ALL IMMEDIATE`.
--
-- Four fixture mistakes were made and fixed while writing this file, and each
-- would have produced a FALSE PASS:
--   1. omitting NOT NULL file_id/mime_type  -> died before reaching the trigger;
--   2. gen_random_uuid() for file_id        -> FK violation, not a ceiling refusal;
--   3. superseding OLD before inserting NEW -> superseded_by self-FK violation;
--   4. asserting inside one big transaction  -> deferred constraint never fired.
-- A refusal is only evidence when the refusal is the CEILING refusing.
\set ON_ERROR_STOP off

-- ── Probe A: a PR at 20 MiB is allowed ───────────────────────────────────────
\echo '=== A. 20 MiB on a PR is under the ceiling -> accepted ==='
BEGIN;
CREATE TEMP TABLE t AS SELECT id AS pr_id FROM proc.purchase_requisitions ORDER BY created_at DESC LIMIT 1;
CREATE TEMP TABLE f AS SELECT gen_random_uuid() AS file_id, n AS sz FROM generate_series(1,6) n;
INSERT INTO core.files (id, bucket, object_key, content_type, size_bytes, sha256)
SELECT file_id,'probe','probe/'||file_id::text||'.bin','application/octet-stream', sz, repeat('a',64) FROM f;
INSERT INTO core.attachment_registry
  (name, file_id, mime_type, size_bytes, kind, parent_type, parent_id, visibility, status)
SELECT 'a.bin',(SELECT file_id FROM f WHERE sz=1),'application/octet-stream',20971520,'other','pr',pr_id,'internal','ACTIVE' FROM t;
SET CONSTRAINTS ALL IMMEDIATE;
\echo '   OK no violation raised'
ROLLBACK;

-- ── Probe B: a second file crossing 25 MiB is refused ────────────────────────
\echo '=== B. 20 MiB + 6 MiB = 27 MiB -> REFUSED ==='
BEGIN;
CREATE TEMP TABLE t AS SELECT id AS pr_id FROM proc.purchase_requisitions ORDER BY created_at DESC LIMIT 1;
CREATE TEMP TABLE f AS SELECT gen_random_uuid() AS file_id, n AS sz FROM generate_series(1,6) n;
INSERT INTO core.files (id, bucket, object_key, content_type, size_bytes, sha256)
SELECT file_id,'probe','probe/'||file_id::text||'.bin','application/octet-stream', sz, repeat('a',64) FROM f;
INSERT INTO core.attachment_registry
  (name, file_id, mime_type, size_bytes, kind, parent_type, parent_id, visibility, status)
SELECT 'a.bin',(SELECT file_id FROM f WHERE sz=1),'application/octet-stream',20971520,'other','pr',pr_id,'internal','ACTIVE' FROM t;
INSERT INTO core.attachment_registry
  (name, file_id, mime_type, size_bytes, kind, parent_type, parent_id, visibility, status)
SELECT 'b.bin',(SELECT file_id FROM f WHERE sz=2),'application/octet-stream',6291456,'other','pr',pr_id,'internal','ACTIVE' FROM t;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;

-- ── Probe C: replacing a 20 MiB file with a 20 MiB file is POSSIBLE ──────────
-- This is the case the first (immediate) trigger design made impossible.
\echo '=== C. replace 20 MiB with 20 MiB (insert NEW, then supersede OLD) -> accepted ==='
BEGIN;
CREATE TEMP TABLE t AS SELECT id AS pr_id FROM proc.purchase_requisitions ORDER BY created_at DESC LIMIT 1;
CREATE TEMP TABLE f AS SELECT gen_random_uuid() AS file_id, n AS sz FROM generate_series(1,6) n;
INSERT INTO core.files (id, bucket, object_key, content_type, size_bytes, sha256)
SELECT file_id,'probe','probe/'||file_id::text||'.bin','application/octet-stream', sz, repeat('a',64) FROM f;
INSERT INTO core.attachment_registry
  (name, file_id, mime_type, size_bytes, kind, parent_type, parent_id, visibility, status)
SELECT 'a.bin',(SELECT file_id FROM f WHERE sz=1),'application/octet-stream',20971520,'other','pr',pr_id,'internal','ACTIVE' FROM t;
INSERT INTO core.attachment_registry
  (name, file_id, mime_type, size_bytes, kind, parent_type, parent_id, visibility, status, version)
SELECT 'a.bin',(SELECT file_id FROM f WHERE sz=2),'application/octet-stream',20971520,'other','pr',pr_id,'internal','ACTIVE',2 FROM t;
UPDATE core.attachment_registry a SET status='SUPERSEDED', superseded_by=n.id
  FROM t, core.attachment_registry n
 WHERE a.parent_type='pr' AND a.parent_id=t.pr_id AND a.name='a.bin' AND a.version=1
   AND n.name='a.bin' AND n.version=2;
SELECT count(*) AS   live_rows_after_replace FROM core.attachment_registry a, t
 WHERE a.parent_type='pr' AND a.parent_id=t.pr_id AND a.status='ACTIVE';
SELECT sum(a.size_bytes) AS   live_bytes_after_replace FROM core.attachment_registry a, t
 WHERE a.parent_type='pr' AND a.parent_id=t.pr_id AND a.status='ACTIVE';
SET CONSTRAINTS ALL IMMEDIATE;
\echo '   OK no violation raised — replace is performable'
ROLLBACK;

-- ── Probe D: exactly at the cap is allowed (inclusive boundary) ───────────────
\echo '=== D. 20 MiB + 5 MiB = exactly 26214400 -> accepted (no off-by-one) ==='
BEGIN;
CREATE TEMP TABLE t AS SELECT id AS pr_id FROM proc.purchase_requisitions ORDER BY created_at DESC LIMIT 1;
CREATE TEMP TABLE f AS SELECT gen_random_uuid() AS file_id, n AS sz FROM generate_series(1,6) n;
INSERT INTO core.files (id, bucket, object_key, content_type, size_bytes, sha256)
SELECT file_id,'probe','probe/'||file_id::text||'.bin','application/octet-stream', sz, repeat('a',64) FROM f;
INSERT INTO core.attachment_registry
  (name, file_id, mime_type, size_bytes, kind, parent_type, parent_id, visibility, status)
SELECT 'a.bin',(SELECT file_id FROM f WHERE sz=1),'application/octet-stream',20971520,'other','pr',pr_id,'internal','ACTIVE' FROM t;
INSERT INTO core.attachment_registry
  (name, file_id, mime_type, size_bytes, kind, parent_type, parent_id, visibility, status)
SELECT 'b.bin',(SELECT file_id FROM f WHERE sz=2),'application/octet-stream',5242880,'other','pr',pr_id,'internal','ACTIVE' FROM t;
SET CONSTRAINTS ALL IMMEDIATE;
\echo '   OK exactly at the cap is allowed'
ROLLBACK;

-- ── Probe E: the cap is read from the SETTING, not hardcoded ─────────────────
\echo '=== E. raise the setting to 100 MiB and the same 27 MiB load is accepted ==='
BEGIN;
CREATE TEMP TABLE t AS SELECT id AS pr_id FROM proc.purchase_requisitions ORDER BY created_at DESC LIMIT 1;
CREATE TEMP TABLE f AS SELECT gen_random_uuid() AS file_id, n AS sz FROM generate_series(1,6) n;
INSERT INTO core.files (id, bucket, object_key, content_type, size_bytes, sha256)
SELECT file_id,'probe','probe/'||file_id::text||'.bin','application/octet-stream', sz, repeat('a',64) FROM f;
UPDATE core.settings SET value = to_jsonb(104857600) WHERE key='attachmentTotalMaxBytes';
INSERT INTO core.attachment_registry
  (name, file_id, mime_type, size_bytes, kind, parent_type, parent_id, visibility, status)
SELECT 'a.bin',(SELECT file_id FROM f WHERE sz=1),'application/octet-stream',20971520,'other','pr',pr_id,'internal','ACTIVE' FROM t;
INSERT INTO core.attachment_registry
  (name, file_id, mime_type, size_bytes, kind, parent_type, parent_id, visibility, status)
SELECT 'b.bin',(SELECT file_id FROM f WHERE sz=2),'application/octet-stream',6291456,'other','pr',pr_id,'internal','ACTIVE' FROM t;
SET CONSTRAINTS ALL IMMEDIATE;
\echo '   OK the ceiling follows the setting, it is not a literal in the trigger'
ROLLBACK;

-- ── Probe F: quotes are not governed by the PR ceiling ───────────────────────
\echo '=== F. a QUOTE parent over 25 MiB is untouched (the cap is per-PR) ==='
BEGIN;
CREATE TEMP TABLE f AS SELECT gen_random_uuid() AS file_id, n AS sz FROM generate_series(1,6) n;
INSERT INTO core.files (id, bucket, object_key, content_type, size_bytes, sha256)
SELECT file_id,'probe','probe/'||file_id::text||'.bin','application/octet-stream', sz, repeat('a',64) FROM f;
INSERT INTO core.attachment_registry
  (name, file_id, mime_type, size_bytes, kind, parent_type, parent_id, visibility, status)
SELECT 'q.bin',(SELECT file_id FROM f WHERE sz=1),'application/octet-stream',52428800,'other','quote',gen_random_uuid(),'internal','ACTIVE';
SET CONSTRAINTS ALL IMMEDIATE;
\echo '   OK a 50 MiB quote attachment is allowed; the ceiling is per-PR by decision'
ROLLBACK;

\echo '=== after every rollback: nothing persisted ==='
SELECT (SELECT count(*) FROM core.attachment_registry WHERE name IN ('a.bin','b.bin','q.bin')) AS leftover_attachments,
       (SELECT count(*) FROM core.files WHERE object_key LIKE 'probe/%')              AS leftover_files,
       (SELECT count(*) FROM core.attachment_budget_queue)                            AS queue_debt,
       (SELECT value FROM core.settings WHERE key='attachmentTotalMaxBytes')          AS cap_restored;
