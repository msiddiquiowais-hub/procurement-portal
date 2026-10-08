-- 054_line_category_from_item.sql
--
-- Backfill proc.pr_lines.category from the catalogue item the line was raised
-- against.
--
-- WHY
-- ---
-- POST /pr (the detailed/capital flow) inserted pr_lines WITHOUT the category
-- column, so every line it created stored NULL there even when the
-- core.items row it referenced carried a perfectly good category. Measured
-- before this migration: 1201 of 1216 lines had category IS NULL.
--
-- That silently disabled everything downstream of line category:
--   * the RFQ roster, which core.vendor_categories maps to vendors — an
--     uncategorised line matches no vendor, so "Issue RFQ" could not resolve a
--     single roster, and
--   * the line-routing rules in the workflow engine.
--
-- The light "New Purchase Request" flow (/pr/new) always wrote the category, so
-- the gap only ever hit the detailed flow.
--
-- SCOPE — deliberately narrow
-- --------------------------
--   * only lines with a catalogue item (item_id IS NOT NULL), because a free-text
--     line has nothing to inherit and inventing 'OTHER' would put a fabricated
--     category in front of procurement;
--   * only where the item actually HAS a category;
--   * only where the line is NULL, so a hand-picked category is never overwritten.
--
-- REPLAY SAFE — every statement is guarded on the row not already being filled,
-- so re-running this migration is a no-op.

\set ON_ERROR_STOP on
BEGIN;

-- Report before/after so a run is legible in the migration log.
\echo '--- line category backfill: before ---'
SELECT count(*) FILTER (WHERE category IS NULL) AS null_category,
       count(*) AS total_lines
  FROM proc.pr_lines;

UPDATE proc.pr_lines pl
   SET category = i.category
  FROM core.items i
 WHERE pl.item_id = i.id
   AND pl.category IS NULL
   AND i.category IS NOT NULL;

\echo '--- line category backfill: after ---'
SELECT count(*) FILTER (WHERE category IS NULL) AS null_category,
       count(*) AS total_lines
  FROM proc.pr_lines;

\echo '--- proof: no line now disagrees with its own catalogue item ---'
DO $$
DECLARE mismatches int;
BEGIN
  SELECT count(*) INTO mismatches
    FROM proc.pr_lines pl
    JOIN core.items i ON i.id = pl.item_id
   WHERE pl.category IS DISTINCT FROM i.category;
  IF mismatches > 0 THEN
    RAISE EXCEPTION '054: % line(s) still disagree with their catalogue item category', mismatches;
  END IF;
  RAISE NOTICE '054: every catalogued line carries its item''s category';
END $$;

COMMIT;