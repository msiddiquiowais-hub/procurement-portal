-- ══════════════════════════════════════════════════════════════════════════
-- Fixture — vendor/category mappings the Receive Quotation e2e depends on.
-- ══════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS
-- ---------------
-- scripts/e2e_quote_receive.mjs picks an open RFQ, then a vendor on it who has
-- never quoted, and records V1/V2/V3 against the FIRST TWO lines
-- (`ORDER BY line_no LIMIT 2`). Revising a quotation is gated by Vendor Master:
-- the API refuses to supersede when the vendor has been REMOVED from a category
-- they had already quoted, and answers:
--
--   "This vendor has been removed from a category they had already quoted:
--    line 1 (FACILITIES)."
--
-- Acme Supplies (V-00001) is mapped to IT_HARDWARE, OFFICE_SUPPLIES and OTHER,
-- but has NO row at all for FACILITIES — which is line 1 of the RFQ the suite
-- lands on. The suite therefore could never record a revision, and sections 5-7
-- failed with that refusal while sections 1-4 passed.
--
-- This is MISSING TEST DATA, not a defect in the suite and not a defect in the
-- Vendor Master rule. The rule is correct and deliberately has no override: a
-- vendor must not quietly acquire a category because a test wanted a green run.
-- So the data is corrected here instead — in the table that is the single source
-- of truth for vendor/category scope.
--
-- Idempotent: re-running reactivates an existing row rather than failing on the
-- (vendor_id, category_id) primary key.
--
-- Run:  npm run db:migrate  (no -)  or directly:
--       docker exec -i procurement-portal-db psql -U proc -d procurementDB \
--         -X -A -t -q -v ON_ERROR_STOP=1 -f - < db/scripts/fixture_quote_receive.sql
-- ══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
BEGIN;

-- Acme Supplies is V-00081. That is not guessable from the name: the seeded
-- vendors are V-00081/V-00082, and an earlier draft of this file said V-00001,
-- matched ZERO rows, and still exited 0 — the quietest possible failure. Hence
-- the post-condition at the bottom, which turns a no-op into an error.
INSERT INTO core.vendor_categories (vendor_id, category_id, is_active, created_at, created_by)
SELECT v.id, c.id, true, now(), u.id
  FROM core.vendors v
  JOIN core.categories c ON c.code = 'FACILITIES'
  LEFT JOIN core.users  u ON u.email = 'procurement@pakboxes.pk'
 WHERE v.vendor_code = 'V-00081'
ON CONFLICT (vendor_id, category_id) DO UPDATE
   SET is_active         = true,
       status_changed_at = now(),
       status_changed_by = (SELECT id FROM core.users WHERE email = 'procurement@pakboxes.pk');

-- The AFTER INSERT/UPDATE trigger syncs core.vendors.preferred_categories, so
-- the array must now agree with the table or the next D365 sync pushes a change
-- nobody made deliberately.
\echo '--- Acme Supplies categories after the fixture ---'
SELECT format('  %-22s %s', c.code, CASE WHEN vc.is_active THEN 'ACTIVE' ELSE 'inactive' END)
  FROM core.vendors v
  LEFT JOIN core.vendor_categories vc ON vc.vendor_id = v.id
  LEFT JOIN core.categories c         ON c.id = vc.category_id
 WHERE v.vendor_code = 'V-00081'
 ORDER BY c.code;

SELECT format('  preferred_categories = %s', preferred_categories)
  FROM core.vendors WHERE vendor_code = 'V-00081';

-- POST-CONDITION. ON_ERROR_STOP catches a failed statement, not a statement that
-- quietly matched nothing, so the fixture has to assert its own effect: if this
-- raises, the vendor code or the category code has moved and the mapping above
-- did nothing at all.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
    FROM core.vendor_categories vc
    JOIN core.vendors   v  ON v.id  = vc.vendor_id
    JOIN core.categories c  ON c.id  = vc.category_id
   WHERE v.vendor_code = 'V-00081'
     AND c.code        = 'FACILITIES'
     AND vc.is_active;
  IF n <> 1 THEN
    RAISE EXCEPTION
      'fixture did not take: expected 1 ACTIVE V-00081/FACILITIES mapping, found %', n;
  END IF;
  RAISE NOTICE 'post-condition OK: V-00081 is ACTIVE on FACILITIES';
END $$;

COMMIT;