\set ON_ERROR_STOP on
-- ===========================================================================
-- verify_028.sql — Wave 4 step 0 (B1 supplier identity, B2 vendor applications)
-- ===========================================================================
--
-- Self-sufficient: every fixture is built inside BEGIN/ROLLBACK, so nothing here
-- persists. `BEGIN;` is its OWN statement before each DO block — psql runs in
-- autocommit, and a bare `ROLLBACK;` after a DO block finds no transaction,
-- warns, and leaves the fixtures committed.
--
-- Section 1 and 2 read the real seeded rows rather than building fixtures,
-- because the claim under test ("the backfill linked the suppliers") is about
-- the database as it stands, not about a scenario.
--
-- Every count in this file is a count of something that exists. There is no
-- "0 rows found because the query was wrong" pass.
-- ===========================================================================

SET app.bypass_rls = 'true';

\echo ''
\echo '=== 1. B1: every supplier login is linked to a vendor (the backfill) ==='
SELECT u.email,
       u.display_name,
       u.vendor_id,
       v.vendor_code,
       v.legal_name,
       v.state
  FROM core.users u
  LEFT JOIN core.vendors v ON v.id = u.vendor_id
 WHERE u.role = 'vendor'
 ORDER BY u.email;
-- expected: 2 rows, vendor_id + vendor_code both populated, V-00081 / V-00082.
-- A NULL vendor_id or a NULL vendor_code here is a FAIL: it is B1 unfixed.

\echo ''
\echo '=== 2. B1: the link points at the RIGHT vendor, not just any vendor ==='
-- "2 linked" is not the claim. "Acme Supplies is Acme Supplies (Pvt) Ltd" is.
-- Asserted as a count so a wrong-but-present link cannot pass.
SELECT count(*) AS correctly_linked
  FROM core.users u
  JOIN core.vendors v ON v.id = u.vendor_id
 WHERE u.role = 'vendor'
   AND left(v.legal_name, length(u.display_name)) = u.display_name;
-- expected: 2

\echo ''
\echo '=== 3. B1: no supplier login was left unlinked ==='
SELECT count(*) AS unlinked_supplier_logins
  FROM core.users
 WHERE role = 'vendor' AND vendor_id IS NULL;
-- expected: 0

\echo ''
\echo '=== 4. B1: the CHECK refuses a vendor login with no vendor_id ==='
BEGIN;
DO $$
DECLARE v_blocked int := 0;
BEGIN
  BEGIN
    INSERT INTO core.users (email, display_name, role, vendor_id)
    VALUES ('verify028-nolink@example.com', 'Unlinked Supplier', 'vendor', NULL);
  EXCEPTION WHEN check_violation THEN v_blocked := v_blocked + 1;
    RAISE NOTICE 'OK: refused a role=vendor row with vendor_id NULL';
  END;
  IF v_blocked <> 1 THEN
    RAISE EXCEPTION 'FAIL: expected the CHECK to refuse 1 insert, it refused %', v_blocked;
  END IF;

  -- The CHECK must not be so broad that it blocks everyone else. A non-vendor
  -- login with no vendor_id is the normal case for 19 of the 21 seeded users.
  INSERT INTO core.users (email, display_name, role, vendor_id)
  VALUES ('verify028-requester@example.com', 'Normal Requester', 'requester', NULL);
  RAISE NOTICE 'OK: a role=requester row with no vendor_id is still allowed';
END $$;
ROLLBACK;

\echo ''
\echo '=== 5. B1: the unique index refuses two logins on one vendor ==='
BEGIN;
DO $$
DECLARE
  v_vendor uuid;
  v_blocked int := 0;
BEGIN
  -- V-00081 specifically, because vendor1@example.com is ALREADY linked to it.
  -- Any other code would make this assertion pass for the wrong reason: an
  -- unclaimed vendor accepts a first login, so the insert below would simply
  -- succeed and the test would prove nothing.
  SELECT id INTO v_vendor FROM core.vendors WHERE vendor_code = 'V-00081';
  IF v_vendor IS NULL THEN RAISE EXCEPTION 'FAIL: V-00081 not found'; END IF;

  IF NOT EXISTS (SELECT 1 FROM core.users WHERE vendor_id = v_vendor) THEN
    RAISE EXCEPTION 'FAIL: nothing is linked to V-00081, so a duplicate cannot be constructed';
  END IF;
  RAISE NOTICE 'OK: V-00081 already has a login, so a second one is a real duplicate';

  BEGIN
    INSERT INTO core.users (email, display_name, role, vendor_id)
    VALUES ('verify028-dup1@example.com', 'Rival Login A', 'vendor', v_vendor);
  EXCEPTION WHEN unique_violation THEN v_blocked := v_blocked + 1;
    RAISE NOTICE 'OK: refused a second login claiming vendor V-00081';
  END;

  IF v_blocked <> 1 THEN
    RAISE EXCEPTION 'FAIL: expected the unique index to refuse 1 insert, it refused %', v_blocked;
  END IF;
  RAISE NOTICE 'OK: one vendor has exactly one login (ux_users_vendor_id)';
END $$;
ROLLBACK;

\echo ''
\echo '=== 6. B2: the application reference is real and sequential ==='
BEGIN;
DO $$
DECLARE
  r1 text; r2 text; r3 text; r4 text;
BEGIN
  INSERT INTO core.vendor_applications (legal_name, ntn) VALUES ('Verify Co A', '9000000-1');
  SELECT reference INTO r1 FROM core.vendor_applications WHERE legal_name = 'Verify Co A';

  INSERT INTO core.vendor_applications (legal_name, ntn) VALUES ('Verify Co B', '9000000-2');
  SELECT reference INTO r2 FROM core.vendor_applications WHERE legal_name = 'Verify Co B';

  INSERT INTO core.vendor_applications (legal_name, ntn) VALUES ('Verify Co C', '9000000-3');
  SELECT reference INTO r3 FROM core.vendor_applications WHERE legal_name = 'Verify Co C';

  RAISE NOTICE 'OK: three references: %, %, %', r1, r2, r3;

  -- The prototype's fabrication was ONB-{random}. The ported reference must be
  -- the deterministic sequential form instead.
  IF r1 !~ '^ONB-[0-9]{4}-[0-9]{5}$' THEN
    RAISE EXCEPTION 'FAIL: reference % does not match ONB-<year>-<5 digits>', r1;
  END IF;
  RAISE NOTICE 'OK: reference format is ONB-<year>-<5 digits>';

  IF r1 !~ ('^ONB-' || extract(year from now()) || '-') THEN
    RAISE EXCEPTION 'FAIL: reference % is not stamped with the current year', r1;
  END IF;
  RAISE NOTICE 'OK: reference carries the current year';

  -- Sequential, not merely well-formed: three distinct, increasing numbers.
  IF r1 >= r2 OR r2 >= r3 THEN
    RAISE EXCEPTION 'FAIL: references are not increasing: %, %, %', r1, r2, r3;
  END IF;
  RAISE NOTICE 'OK: references increase (sequential, not random)';

  -- A fourth application must continue the same sequence.
  --
  -- This replaces an earlier version of this check that compared
  -- core.seq_vendor_app_ref.last_value before and after. That arithmetic is
  -- wrong on a sequence that has never been called: last_value is 1 with
  -- is_called = false, and the first nextval() returns 1 rather than 2, so the
  -- observed delta is one less than the number of inserts. Asserting on the
  -- references themselves tests the contract the applicant actually sees and
  -- has no off-by-one to get wrong.
  INSERT INTO core.vendor_applications (legal_name, ntn) VALUES ('Verify Co D', '9000000-4');
  SELECT reference INTO r4 FROM core.vendor_applications WHERE legal_name = 'Verify Co D';
  IF r4 <= r3 OR left(r4, 8) <> left(r3, 8) THEN
    RAISE EXCEPTION 'FAIL: 4th reference % does not continue the sequence after %', r4, r3;
  END IF;
  RAISE NOTICE 'OK: the 4th reference continues the sequence: % -> %', r3, r4;
END $$;
ROLLBACK;

\echo ''
\echo '=== 7. B2: a pending NTN cannot be applied for twice ==='
BEGIN;
DO $$
DECLARE
  v_blocked int := 0;
  v_app uuid;
BEGIN
  INSERT INTO core.vendor_applications (legal_name, ntn)
  VALUES ('Duplicate Co', '9000000-9') RETURNING id INTO v_app;

  BEGIN
    INSERT INTO core.vendor_applications (legal_name, ntn)
    VALUES ('Duplicate Co Again', '9000000-9');
  EXCEPTION WHEN unique_violation THEN v_blocked := v_blocked + 1;
    RAISE NOTICE 'OK: refused a second LIVE application for the same NTN';
  END;

  IF v_blocked <> 1 THEN
    RAISE EXCEPTION 'FAIL: expected 1 refusal on a duplicate pending NTN, got %', v_blocked;
  END IF;
  RAISE NOTICE 'OK: ux_vendor_app_ntn_pending is the duplicate-application control (W4 R6)';
END $$;
ROLLBACK;

\echo ''
\echo '=== 8. B2: ...but a REJECTED application frees the NTN to re-apply ==='
-- The partial predicate is the whole point. A blanket unique on ntn would lock
-- a company out forever after one rejection, which is a control that punishes
-- the applicant instead of the duplicate.
BEGIN;
DO $$
DECLARE
  v_app uuid;
  v_ok int := 0;
BEGIN
  INSERT INTO core.vendor_applications (legal_name, ntn, state)
  VALUES ('Rejected Co', '9000000-8', 'Rejected') RETURNING id INTO v_app;

  INSERT INTO core.vendor_applications (legal_name, ntn, state)
  VALUES ('Rejected Co Re-apply', '9000000-8', 'Submitted');
  v_ok := v_ok + 1;
  RAISE NOTICE 'OK: a rejected application does not block a re-application';

  -- and the moment it is live again, the block returns
  BEGIN
    INSERT INTO core.vendor_applications (legal_name, ntn, state)
    VALUES ('Rejected Co Third', '9000000-8', 'Under_Review');
  EXCEPTION WHEN unique_violation THEN v_ok := v_ok + 1;
    RAISE NOTICE 'OK: while the re-application is live, a third is refused';
  END;

  IF v_ok <> 2 THEN RAISE EXCEPTION 'FAIL: expected both re-apply behaviours, got %', v_ok; END IF;
END $$;
ROLLBACK;

\echo ''
\echo '=== 9. B2: every state value round-trips, and a bad one is refused ==='
BEGIN;
DO $$
DECLARE
  s text; v_blocked int := 0;
  n int := 0;
BEGIN
  FOREACH s IN ARRAY ARRAY['Submitted','Under_Review','Approved','Rejected'] LOOP
    INSERT INTO core.vendor_applications (legal_name, ntn, state)
    VALUES ('State Co ' || s, '9000' || (100 + n) || '-0', s);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'OK: all 4 prototype states are storable';

  BEGIN
    INSERT INTO core.vendor_applications (legal_name, ntn, state)
    VALUES ('Bad State Co', '9000999-9', 'Cancelled');
  EXCEPTION WHEN check_violation THEN v_blocked := v_blocked + 1;
    RAISE NOTICE 'OK: refused a state outside the prototype vocabulary';
  END;
  IF v_blocked <> 1 THEN RAISE EXCEPTION 'FAIL: bad state was not refused'; END IF;
END $$;
ROLLBACK;

\echo ''
\echo '=== 10. B2: reference is DB-generated, so the API cannot fabricate one ==='
-- If `reference` had no DEFAULT, apps/onboarding would have to build it — which
-- is how the prototype's Math.random() placeholder got in. Assert the default
-- exists rather than trusting the migration comment.
SELECT column_name,
       column_default,
       is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'core' AND table_name = 'vendor_applications'
   AND column_name = 'reference';
-- expected: column_default contains fn_next_vendor_app_reference, is_nullable = NO

\echo ''
\echo '=== 11. the objects migration 028 created are all present ==='
SELECT c.relkind, n.nspname AS schema, c.relname
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE (n.nspname, c.relname) IN
   (('core','vendor_applications'), ('core','seq_vendor_app_ref'))
 ORDER BY c.relname;
-- expected: 2 rows — one r (table), one S (sequence)

SELECT p.proname
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'core' AND p.proname = 'fn_next_vendor_app_reference';
-- expected: 1 row

SELECT indexname FROM pg_indexes
 WHERE (schemaname, indexname) IN
   (('core','ux_users_vendor_id'), ('core','ux_vendor_app_ntn_pending'), ('core','idx_vendor_app_queue'))
 ORDER BY indexname;
-- expected: 3 rows

\echo ''
\echo '=== 12. the CHECK and the unique index are both PARTIAL-free and live ==='
-- Guards against a future migration quietly widening the vendor CHECK to cover
-- non-vendor roles, which would make every internal login need a vendor_id.
SELECT conname, pg_get_constraintdef(oid) AS def
  FROM pg_constraint
 WHERE conname = 'ck_users_vendor_role'
   AND connamespace = 'core'::regnamespace;

SELECT indexdef FROM pg_indexes
 WHERE schemaname = 'core' AND indexname = 'ux_users_vendor_id';

\echo ''
\echo '=== 13. B6: the invitation token is documented as inert, not silently so ==='
SELECT col_description(c.oid, a.attnum) AS token_hash_comment
  FROM pg_class c
  JOIN pg_namespace n  ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid
 WHERE n.nspname = 'proc' AND c.relname = 'rfq_invitations'
   AND a.attname = 'token_hash';
-- expected: a comment mentioning INERT. Empty means W4-3's decision was not
-- recorded where a future reader will actually find it.

\echo ''
\echo '=== 14. nothing this script created persisted ==='
SELECT count(*) AS leftover_fixture_applications
  FROM core.vendor_applications
 WHERE legal_name LIKE 'Verify Co%'
    OR legal_name LIKE 'Duplicate Co%'
    OR legal_name LIKE 'State Co%'
    OR legal_name LIKE 'Rejected Co%'
    OR legal_name LIKE 'Bad State Co%';
-- expected: 0. A verify script that pollutes the database it verifies is worse
-- than no script: the next test sees phantom fixtures.
-- If this is not 0, a BEGIN; is missing before a DO block and psql committed it.

\echo ''
\echo '=== 028 verification complete ==='
