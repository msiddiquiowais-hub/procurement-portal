-- verify_052_free_text.sql
-- Proves the free-text line contract migration 052 actually established.
-- Run: db:verify:052 (or docker exec -i ... < db/scripts/verify_052_free_text.sql)

\pset tuples_only on
\pset format unaligned

\echo '--- 1. pr_lines.item_id is NULLABLE (free text is representable) ---'
SELECT 'item_id nullable = ' || is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'proc' AND table_name = 'pr_lines' AND column_name = 'item_id';

\echo '--- 2. the FK to core.items still EXISTS (inventing a SKU is still refused) ---'
SELECT 'fk to core.items = ' || count(*)
  FROM pg_constraint
 WHERE conrelid = 'proc.pr_lines'::regclass
   AND contype = 'f'
   AND confrelid = 'core.items'::regclass;

\echo '--- 3. a line still has to say SOMETHING ---'
SELECT 'item-or-description constraint = ' || count(*)
  FROM pg_constraint
 WHERE conrelid = 'proc.pr_lines'::regclass
   AND conname = 'pr_lines_line_states_something';

\echo '--- 4. totals LEFT JOIN items, so a free-text line is not dropped from the sum ---'
SELECT 'fn_compute_pr_totals LEFT JOINs items = ' ||
       CASE WHEN prosrc LIKE '%LEFT JOIN core.items%' THEN 'yes' ELSE 'NO' END
  FROM pg_proc
 WHERE proname = 'fn_compute_pr_totals';

\echo '--- 5. NO inner joins remain on core.items from pr_lines (each would drop a free-text row) ---'
SELECT 'inner joins on pr_lines->items = ' || count(*)
  FROM pg_views
 WHERE definition LIKE '%JOIN core.items%'
   AND definition LIKE '%pr_lines%'
   AND definition NOT LIKE '%LEFT JOIN core.items%';
