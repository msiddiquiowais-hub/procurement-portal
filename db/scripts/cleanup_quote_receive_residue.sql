-- ══════════════════════════════════════════════════════════════════════════
-- One-off DBA cleanup — Receive Quotation verification residue on PR-2026-201247.
-- ══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS REMOVES
--   Rows written by `node scripts/e2e_quote_receive.mjs` and by the CORS
--   diagnostic, both run against this development database on 2026-10-10 between
--   14:29 and 14:47 UTC:
--     * quotation 95358077-…  — "Acme Supplies V1", the V1 the suite posted
--       before its supersede was refused by the Vendor Master gate.
--     * 14 attachment_registry rows + their 14 core.files rows: 9 versions of
--       quotation.pdf, quotation-v2/v3/v4.pdf, and two diagnostics.
--
-- WHY THE IDS ARE SPELLED OUT INSTEAD OF FILTERED BY DATE
--   PR-2026-201247 had no attachments before these runs, so "everything on this
--   PR" was the obvious scope — and it became wrong while this file was being
--   written. At 18:26 UTC the procurement user uploaded
--   "Product Receipt not invoiced.xlsx" to the SAME PR while working live. A
--   date filter written an hour earlier would have deleted their real document.
--   Named rows are the only scope that cannot sweep up a colleague's work; the
--   count post-condition below then proves the blast radius was exactly 14.
--
-- ON THE AUDIT TRAIL
--   core.attachment_audit carries ON DELETE CASCADE from attachment_registry and
--   its attachment_id is NOT NULL, so the audit rows cannot be kept while the
--   attachments they describe are removed. These were synthetic files, never a
--   vendor's real document. A real document is retired through
--   POST /attachments/:id/void instead — deliberately NOT done here.
-- ══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE doomed_attachments (id uuid PRIMARY KEY);
INSERT INTO doomed_attachments (id) VALUES
  ('496d2f37-3b29-4d82-96d9-dcd45d8073a0'),  -- CORS proof - vendor quotation.xlsx (VOID)
  ('500a9663-e8be-4f66-bfe4-73c67fb4a321'),  -- Product Receipt not involved.xlsx  (VOID)
  ('74f83030-598c-47be-af6c-8226ca1802c7'),  -- quotation.pdf v1
  ('b7d9f474-3cb8-4baa-841c-e6c8e3bacf95'),  -- quotation.pdf v2
  ('cdd71ef1-1a33-482c-a6f6-ac64ed3db729'),  -- quotation.pdf v3
  ('97f48426-9b09-4f1b-9045-2f6d4be04468'),  -- quotation.pdf v4
  ('baf3a629-861f-4fec-84d6-fdb8e59467c7'),  -- quotation.pdf v5
  ('cc2eed6c-695a-4429-bf1f-619587a4a381'),  -- quotation.pdf v6
  ('c1b8310e-2168-405d-9e06-b5b796209d16'),  -- quotation.pdf v7
  ('a81ae4fb-a468-4b97-87f0-b2dfdaf12588'),  -- quotation.pdf v8
  ('df9c4723-e804-4591-a544-392f81cc5850'),  -- quotation.pdf v9 (ACTIVE)
  ('8860ff8d-5e8e-45e6-81c7-7ab60a0b66b2'),  -- quotation-v2.pdf
  ('9d145d0c-dae6-481c-b448-ea29eb22a4b7'),  -- quotation-v3.pdf
  ('6f06bad4-68ea-479c-9ddf-fa48238b47f4'); -- quotation-v4.pdf

CREATE TEMP TABLE doomed_files AS
SELECT f.id FROM core.files f
  JOIN doomed_attachments d ON d.id = f.id
 WHERE f.id IN (SELECT file_id FROM core.attachment_registry WHERE id IN (SELECT id FROM doomed_attachments));

-- Everything else on this PR must survive, captured BEFORE any delete. This is
-- the blast-radius proof, and it is deliberately a set rather than a count: the
-- procurement user is working in this app live, and an earlier draft of this
-- file asserted "exactly 1 attachment left", which failed the moment a second
-- genuine upload landed mid-run — even though the cleanup itself was correct.
CREATE TEMP TABLE must_survive AS
SELECT id FROM core.attachment_registry
 WHERE parent_id = '781efc73-6946-4df0-a843-015743554b57'
   AND id NOT IN (SELECT id FROM doomed_attachments);

\echo '--- captured for survival check ---'
SELECT format('  keeping %s attachment(s) the cleanup must not touch', count(*))
  FROM must_survive;

\echo '--- removing ---'
SELECT format('  quotation  %s', id) FROM proc.quotations
 WHERE id = '95358077-f5f2-4357-9eff-44851a862e33';

-- ── quotation: children first, then the self-FK, then the row ──────────────
DELETE FROM proc.quotation_attachments
 WHERE quotation_id = '95358077-f5f2-4357-9eff-44851a862e33'
    OR attachment_id IN (SELECT id FROM doomed_attachments);

DELETE FROM proc.quotation_lines
 WHERE quotation_id = '95358077-f5f2-4357-9eff-44851a862e33';

UPDATE proc.quotations SET supersedes_quotation_id = NULL
 WHERE supersedes_quotation_id = '95358077-f5f2-4357-9eff-44851a862e33';

DELETE FROM proc.quotations WHERE id = '95358077-f5f2-4357-9eff-44851a862e33';

-- ── attachments ───────────────────────────────────────────────────────────
-- NOT `UPDATE ... SET superseded_by = NULL` first. The table carries
--   CHECK (status = 'SUPERSEDED' -> superseded_by IS NOT NULL)
-- so blanking that column on a superseded row is itself a violation, and the
-- whole transaction rolls back. The self-FK is NO ACTION and not deferrable, so
-- a row cannot be deleted while another row still points at it either.
--
-- The fix is to delete LEAF FIRST, repeatedly: only rows that nothing points at
-- yet are removable, and each pass frees the next one up the chain. One pass is
-- not enough — quotation.pdf alone is a nine-deep chain.
DO $$
DECLARE n int; total int := 0;
BEGIN
  LOOP
    DELETE FROM core.attachment_registry a
     WHERE a.id IN (SELECT id FROM doomed_attachments)
       AND NOT EXISTS (SELECT 1 FROM core.attachment_registry o
                        WHERE o.superseded_by = a.id);
    GET DIAGNOSTICS n = ROW_COUNT;
    EXIT WHEN n = 0;
    total := total + n;
  END LOOP;

  IF total <> 14 THEN
    RAISE EXCEPTION 'expected to delete 14 attachments, deleted %', total;
  END IF;
  RAISE NOTICE 'deleted % attachments leaf-first', total;
END $$;

DELETE FROM core.files WHERE id IN (SELECT id FROM doomed_files);

-- ── POST-CONDITIONS ───────────────────────────────────────────────────────
DO $$
DECLARE
  gone_att   int; gone_file int; gone_audit int; gone_q int;
  kept       int; survivors  int;
BEGIN
  SELECT count(*) INTO gone_att   FROM core.attachment_registry WHERE id IN (SELECT id FROM doomed_attachments);
  SELECT count(*) INTO gone_file  FROM core.files WHERE id IN (SELECT id FROM doomed_files);
  SELECT count(*) INTO gone_audit FROM core.attachment_audit WHERE attachment_id IN (SELECT id FROM doomed_attachments);
  SELECT count(*) INTO gone_q     FROM proc.quotations WHERE id = '95358077-f5f2-4357-9eff-44851a862e33';

  IF gone_att <> 0 OR gone_file <> 0 OR gone_audit <> 0 OR gone_q <> 0 THEN
    RAISE EXCEPTION 'cleanup did not take: att=% files=% audit=% quotes=%',
      gone_att, gone_file, gone_audit, gone_q;
  END IF;

  -- THE SAFETY ASSERTION: every attachment that was NOT in the doomed set must
  -- still be here afterwards. Set membership, not a count, so a colleague
  -- uploading while this runs cannot turn a correct cleanup into a failure —
  -- and a row of theirs that DID get swept can never pass unnoticed.
  SELECT count(*) INTO survivors FROM must_survive;
  SELECT count(*) INTO kept
    FROM core.attachment_registry a
    JOIN must_survive m ON m.id = a.id;
  IF kept <> survivors THEN
    RAISE EXCEPTION
      'BLAST RADIUS EXCEEDED: % of % surviving attachments were destroyed', survivors - kept, survivors;
  END IF;

  RAISE NOTICE 'post-condition OK: 14 synthetic rows removed, % colleague rows intact', survivors;
END $$;

DROP TABLE doomed_files;
DROP TABLE doomed_attachments;
DROP TABLE must_survive;
COMMIT;

\echo '--- final state of PR-2026-201247 (colleague uploads only) ---'
SELECT format('  %s | %s | %s bytes | %s',
              a.name, a.status, a.size_bytes, a.uploaded_at)
  FROM core.attachment_registry a
 WHERE a.parent_id = '781efc73-6946-4df0-a843-015743554b57'
 ORDER BY a.uploaded_at;

SELECT format('  quotations on the fixture RFQ = %s',
              (SELECT count(*) FROM proc.quotations
                WHERE rfq_id = '2e77f52a-476c-4a9f-80dc-576ac10f53bc'));

\echo '--- the mapping the suite needs is still in place ---'
SELECT format('  V-00081 %s = %s', c.code, CASE WHEN vc.is_active THEN 'ACTIVE' ELSE 'inactive' END)
  FROM core.vendor_categories vc
  JOIN core.vendors v    ON v.id = vc.vendor_id
  JOIN core.categories c ON c.id = vc.category_id
 WHERE v.vendor_code = 'V-00081'
 ORDER BY c.code;