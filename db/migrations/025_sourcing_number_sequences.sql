-- 025_sourcing_number_sequences.sql
--
-- (This file was previously numbered 026. It was renumbered to keep the
--  migration sequence contiguous after the vendor-pool data was moved out of
--  migrations and into db/seeds/seed.sql — see that file's vendor block. The
--  vendor pool is DEMO/REFERENCE data whose rows carry an FK to a seeded user,
--  so it cannot live in a migration: migrations run BEFORE the seed, and the
--  FK target does not exist yet. The seed is idempotent, so anyone patching an
--  existing database just re-runs db/scripts/seed.ps1 to pick them up.)
--
-- Wave 2 step 1 defect: proc.fn_next_rfq_number() collided with seeded data.
--
-- The failure, verbatim:
--   duplicate key value violates unique constraint "rfq_rfq_number_key"
--   DETAIL:  Key (rfq_number)=(RFQ-2026-10000) already exists.
--
-- ROOT CAUSE — the same lpad trap migration 017 fixed for PR numbers, never
-- applied to the sourcing sequences:
--
--   lpad(string, N, fill) does not only PAD, it TRUNCATES. Any input longer
--   than N is cut to its first N characters.
--
--     SELECT lpad('100002', 5, '0');  -->  '10000'      (not '100002')
--
-- The seed contains RFQ-2026-10000, and proc.rfq_number_seq starts at 10000.
-- So the first generated number is 'RFQ-' || yr || '-' || lpad('10000',5,'0')
-- = RFQ-2026-10000 — the row that is already there. From the second call
-- onward the sequence is past 100000, lpad truncates it back to 5 chars, and
-- every call collides again. The function can never produce a usable number.
--
-- FIX, mirroring 017 exactly:
--   1. pad to 6 characters, not 5, so the 100000..999999 band is representable
--   2. move the sequences past the seeded band so the first post-migration
--      value is 200001 — a 6-digit number that cannot equal any 5-digit seed
--
-- 6 digits is the same width 017 chose for PR numbers and gives ~800k RFQs /
-- CS documents of headroom before truncation could recur. If the sequence ever
-- approaches 999999, widen the pad again — do not assume lpad will do the
-- right thing for an arbitrary-length input.
--
-- The existing 5-digit seed row RFQ-2026-10000 is left alone: it is real
-- existing data, and reformatting it would break the audit trail.

BEGIN;

-- ── RFQ numbers ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION proc.fn_next_rfq_number()
RETURNS text
LANGUAGE plpgsql
AS $fn$
DECLARE
  yr int := extract(year from now());
  n  bigint := nextval('proc.rfq_number_seq');
BEGIN
  -- 6-wide pad. See the header: lpad truncates at 5.
  RETURN 'RFQ-' || yr || '-' || lpad(n::text, 6, '0');
END;
$fn$;

-- Leave the sequence past the seeded band. GREATEST so a sequence that is
-- already ahead is never wound backwards.
SELECT setval('proc.rfq_number_seq',
              GREATEST((SELECT last_value FROM proc.rfq_number_seq), 200000));

-- ── CS numbers ─────────────────────────────────────────────────────────────
-- Identical defect, identical fix. proc.fn_next_cs_number() has no seeded row
-- today, so it has not bitten yet — but it shares the function body verbatim
-- and would truncate the moment the count passed 99999. Fix it now, in the
-- same migration, rather than discovering it during Wave 2 step 6.
CREATE OR REPLACE FUNCTION proc.fn_next_cs_number()
RETURNS text
LANGUAGE plpgsql
AS $fn$
DECLARE
  yr int := extract(year from now());
  n  bigint := nextval('proc.cs_number_seq');
BEGIN
  RETURN 'CS-' || yr || '-' || lpad(n::text, 6, '0');
END;
$fn$;

SELECT setval('proc.cs_number_seq',
              GREATEST((SELECT last_value FROM proc.cs_number_seq), 200000));

COMMIT;
