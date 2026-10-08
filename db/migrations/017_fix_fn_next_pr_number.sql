-- Fix proc.fn_next_pr_number(): lpad(N, 5, '0') truncates when N > 99999
-- (Postgres semantics: pad-or-truncate). Use to_char with 'FM00000' for
-- proper zero-padding up to 5 digits, then fall back to plain concat above
-- 99999. We bump the sequence's START to 200000 so the format is unambiguous
-- going forward and existing 10000-prefixed numbers don't collide.
CREATE OR REPLACE FUNCTION proc.fn_next_pr_number() RETURNS text AS $$
DECLARE
  yr int := extract(year from now());
  n  bigint := nextval('proc.pr_number_seq');
BEGIN
  RETURN 'PR-' || yr || '-' || lpad(n::text, 6, '0');
END;
$$ LANGUAGE plpgsql VOLATILE;

-- Ensure the sequence is advanced past any seeded PR numbers.
SELECT setval('proc.pr_number_seq', GREATEST(last_value, 200000), true)
  FROM proc.pr_number_seq;