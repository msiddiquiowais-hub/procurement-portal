-- 044 — allocate purchase-order numbers from a sequence, not from max().
--
-- WHAT WAS BROKEN
--
--   SELECT COALESCE(max((regexp_match(po_number, 'LOCAL-(\d+)$'))[1]::bigint), 0) + 1
--     FROM proc.purchase_orders WHERE po_number LIKE 'LOCAL-%'
--
-- Two independent defects, either of which alone is fatal:
--
-- 1. THE REGEX CANNOT MATCH ITS OWN OUTPUT. The number is
--    LOCAL-PO-2026-000001. The pattern requires 'LOCAL-' followed by digits
--    to the end of the string, but what follows 'LOCAL-' is 'PO-2026-000001'.
--    So regexp_match returned NULL, COALESCE collapsed it to 0, and EVERY
--    PO was numbered LOCAL-PO-<year>-000001.
--
-- 2. max() OVER A SEPARATE CONNECTION. The lookup used a pooled read while
--    the inserts ran inside withTransaction, so uncommitted rows from the
--    same transaction were invisible. Even with a working regex, two POs
--    created in one transaction both read the same maximum and collided.
--
-- Together these meant a SPLIT AWARD — the fan-out this whole track exists
-- to deliver — raised "duplicate key value violates unique constraint
-- purchase_orders_po_number_key" on the second vendor, every time. The
-- single-winner path happened to work only because it creates one PO and the
-- fixed 000001 was unused.
--
-- A sequence is the right primitive: it is allocation-safe under concurrency
-- and within a transaction, which a read-max-then-increment never is.
--
-- Idempotent: the sequence is created only when absent, and is seeded above
-- any number already issued.

BEGIN;

DO $pre$
DECLARE
  v_max  bigint := 0;
  v_next bigint;
BEGIN
  IF to_regclass('proc.purchase_orders') IS NULL THEN
    RAISE EXCEPTION 'proc.purchase_orders does not exist — migration 042 must run first';
  END IF;

  SELECT COALESCE(max((regexp_match(po_number, '^LOCAL-PO-[0-9]{4}-([0-9]+)$'))[1]::bigint), 0)
    INTO v_max
    FROM proc.purchase_orders
   WHERE po_number ~ '^LOCAL-PO-[0-9]{4}-[0-9]+$';

  IF to_regclass('proc.seq_po_number') IS NULL THEN
    v_next := v_max + 1;
    EXECUTE format('CREATE SEQUENCE proc.seq_po_number START WITH %s INCREMENT BY 1', v_next);
  END IF;
END
$pre$;

-- ── post-condition ────────────────────────────────────────────────────────
-- Two allocations inside ONE transaction must differ. That is precisely the
-- case the old max()-over-another-connection approach failed, so it is the
-- thing worth proving rather than re-reading the sequence's definition.
DO $prove$
DECLARE
  v_a bigint;
  v_b bigint;
BEGIN
  IF to_regclass('proc.seq_po_number') IS NULL THEN
    RAISE EXCEPTION 'post-condition FAILED: proc.seq_po_number was not created';
  END IF;

  v_a := nextval('proc.seq_po_number');
  v_b := nextval('proc.seq_po_number');

  IF v_a = v_b THEN
    RAISE EXCEPTION 'post-condition FAILED: two allocations in one transaction returned %', v_a;
  END IF;
  IF v_b <> v_a + 1 THEN
    RAISE EXCEPTION 'post-condition FAILED: sequence did not advance (% then %)', v_a, v_b;
  END IF;

  -- The shape must stay unmistakably local, since that is the entire reason
  -- the prefix exists.
  IF ('LOCAL-PO-2026-' || lpad(v_a::text, 6, '0'))
       !~ '^LOCAL-PO-[0-9]{4}-[0-9]{6}$' THEN
    RAISE EXCEPTION 'post-condition FAILED: the composed PO number has the wrong shape';
  END IF;
END
$prove$;

COMMIT;
