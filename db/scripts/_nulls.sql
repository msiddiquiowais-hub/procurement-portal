SET app.bypass_rls = 'true';
\pset tuples_only on
\pset format unaligned
SELECT 'QUOT NOT NULL: ' || string_agg(column_name, ', ' ORDER BY ordinal_position)
  FROM information_schema.columns
 WHERE table_schema='proc' AND table_name='quotations' AND is_nullable='NO';
SELECT 'RFQ NOT NULL: ' || string_agg(column_name, ', ' ORDER BY ordinal_position)
  FROM information_schema.columns
 WHERE table_schema='proc' AND table_name='rfq' AND is_nullable='NO';
SELECT 'CS NOT NULL: ' || string_agg(column_name, ', ' ORDER BY ordinal_position)
  FROM information_schema.columns
 WHERE table_schema='proc' AND table_name='comparative_statements' AND is_nullable='NO';
SELECT 'CSLINE NOT NULL: ' || string_agg(column_name, ', ' ORDER BY ordinal_position)
  FROM information_schema.columns
 WHERE table_schema='proc' AND table_name='cs_lines' AND is_nullable='NO';
SELECT 'RFQINV NOT NULL: ' || string_agg(column_name, ', ' ORDER BY ordinal_position)
  FROM information_schema.columns
 WHERE table_schema='proc' AND table_name='rfq_invitations' AND is_nullable='NO';
SELECT 'PACK NOT NULL: ' || string_agg(column_name, ', ' ORDER BY ordinal_position)
  FROM information_schema.columns
 WHERE table_schema='proc' AND table_name='approved_packs' AND is_nullable='NO';
SELECT 'QUOTATION_LINE NOT NULL: ' || string_agg(column_name, ', ' ORDER BY ordinal_position)
  FROM information_schema.columns
 WHERE table_schema='proc' AND table_name='quotation_lines' AND is_nullable='NO';
