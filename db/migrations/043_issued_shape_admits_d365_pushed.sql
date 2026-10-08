-- 043 — the issuance shape must admit the state that actually follows issuance.
--
-- WHAT WAS BROKEN
--
--   CHECK ((state = 'Issued') = (issued_at IS NOT NULL))
--
-- Two states were imagined when that was written: 'Generated' with no
-- issued_at, and 'Issued' with one. The table's own state vocabulary is
-- Generated | Issued | D365_PUSHED | Cancelled — so 'D365_PUSHED' was never
-- accounted for.
--
-- PoService.push() moves an issued PO to state 'D365_PUSHED' while
-- issued_at stays set. Against this constraint that is FALSE = TRUE, i.e. a
-- violation. Every push therefore failed with a 500 CHECK violation, and an
-- approved, issued purchase order could never reach F&O.
--
-- This is the shape of bug the constraint was supposed to prevent, arriving
-- through the constraint itself: a guard written against a two-state world
-- that rejected the third legitimate state. No test had driven the full
-- sequence generate -> issue -> push, so it stayed invisible.
--
-- WHAT IS ASSERTED NOW
--
-- issued_at IS NOT NULL exactly when the PO is in an issued-or-pushed state,
-- with one deliberate exception: a CANCELLED PO may carry an issued_at,
-- because cancelling an order that was already issued is legitimate and must
-- not be impossible.
--
-- Idempotent: the constraint is dropped before being re-added, so a replay
-- converges rather than failing on a duplicate name.

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('proc.purchase_orders') IS NULL THEN
    RAISE EXCEPTION 'proc.purchase_orders does not exist — migration 042 must run first';
  END IF;
END
$pre$;

ALTER TABLE proc.purchase_orders
  DROP CONSTRAINT IF EXISTS purchase_orders_issued_shape;

ALTER TABLE proc.purchase_orders
  ADD CONSTRAINT purchase_orders_issued_shape
  CHECK (
    (state IN ('Issued', 'D365_PUSHED')) = (issued_at IS NOT NULL)
    OR state = 'Cancelled'
  );

-- ── post-condition ────────────────────────────────────────────────────────
-- Proves the constraint BITES by exercising every shape, not by re-reading
-- its own definition back. Each negative case must be refused and each
-- positive case must be accepted; the proof rows are removed before COMMIT.
DO $prove$
DECLARE
  v_pr     uuid;
  v_vendor uuid;
BEGIN
  SELECT id INTO v_pr     FROM proc.purchase_requisitions ORDER BY created_at DESC LIMIT 1;
  SELECT id INTO v_vendor FROM core.vendors                      ORDER BY vendor_code    LIMIT 1;

  IF v_pr IS NULL OR v_vendor IS NULL THEN
    RAISE EXCEPTION 'post-condition needs at least one PR and one vendor to test against';
  END IF;

  -- 1. THE BUG: issued, then pushed. issued_at is set and state is
  --    D365_PUSHED. Under the old constraint this row was refused.
  BEGIN
    INSERT INTO proc.purchase_orders
      (po_number, pr_id, vendor_id, generation_mode, state, currency,
       total_amount, issued_at, d365_po_number, d365_pushed_at)
    VALUES
      ('LOCAL-PO-PROOF-PUSHED', v_pr, v_vendor, 'SINGLE', 'D365_PUSHED', 'PKR',
       1, now(), 'PO000042', now());
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION
      'post-condition FAILED: an issued PO that has been pushed to D365 is still refused (%). '
      'Issuance and D365 push cannot complete.', SQLERRM;
  END;

  -- 2. An Issued PO with no issued_at is still a lie, and still refused.
  BEGIN
    INSERT INTO proc.purchase_orders
      (po_number, pr_id, vendor_id, generation_mode, state, currency, total_amount)
    VALUES
      ('LOCAL-PO-PROOF-ISSUED-NO-TS', v_pr, v_vendor, 'SINGLE', 'Issued', 'PKR', 1);
    RAISE EXCEPTION
      'post-condition FAILED: an Issued PO with no issued_at was accepted — '
      'the issuance guarantee has been weakened';
  EXCEPTION WHEN check_violation THEN
    NULL;  -- refused, exactly as it must be
  END;

  -- 3. A Generated PO may not carry an issued_at either.
  BEGIN
    INSERT INTO proc.purchase_orders
      (po_number, pr_id, vendor_id, generation_mode, state, currency,
       total_amount, issued_at)
    VALUES
      ('LOCAL-PO-PROOF-GENERATED-TS', v_pr, v_vendor, 'SINGLE', 'Generated', 'PKR', 1, now());
    RAISE EXCEPTION
      'post-condition FAILED: a Generated PO with an issued_at was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;  -- refused, exactly as it must be
  END;

  -- 4. An ordinary Generated PO is still accepted — the fix did not over-tighten.
  BEGIN
    INSERT INTO proc.purchase_orders
      (po_number, pr_id, vendor_id, generation_mode, state, currency, total_amount)
    VALUES
      ('LOCAL-PO-PROOF-GENERATED', v_pr, v_vendor, 'SINGLE', 'Generated', 'PKR', 1);
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'post-condition FAILED: an ordinary Generated PO is now refused (%)', SQLERRM;
  END;

  DELETE FROM proc.purchase_orders WHERE po_number LIKE 'LOCAL-PO-PROOF-%';
END
$prove$;

COMMIT;
