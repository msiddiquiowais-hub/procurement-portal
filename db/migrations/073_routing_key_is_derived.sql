-- 073 — routing_key becomes a DERIVED column
--
-- ── THE DEFECT THIS REMOVES ─────────────────────────────────────────────────
--
-- `proc.purchase_requisitions.routing_key` was a value the application WROTE,
-- and two of the three insert paths wrote the literal 'STANDARD':
--
--   · the light flow       — never derived, ever
--   · the split-child flow — never derived, ever
--   · the capital flow     — inserted 'STANDARD', then immediately derived and
--                            UPDATEd, so it was right by the end of its
--                            transaction and merely wrong on the way in
--
-- Nothing ever recomputed it afterwards. Not the award write-back
-- (`fn_apply_award_to_pr_lines`), not the classification patch (`syncPrTotals`),
-- not the advance. So the column was whatever one INSERT decided, frozen for
-- life.
--
-- The measured cost, on the live database:
--
--     flow_kind | routing_key | rows
--     ----------+-------------+------
--     LIGHT     | STANDARD    |  1740
--     LIGHT     | FAST_TRACK  |   114
--
-- 1,491 LIGHT requests sit at or under PKR 250,000 — inside the band
-- `fn_derive_routing` calls FAST_TRACK ("Capex ≤ PKR 2.5 L (within HOD
-- delegation)") — and were routed STANDARD instead.
--
-- WHY THAT ESCALATED. `cs.service.ts` decides the MC vote off this column:
--
--     const routing = c.routing_key || 'STANDARD';
--     const skipMc   = routing === 'FAST_TRACK';
--
-- So a PKR 139.73 request asked for an MC and CFO vote, on the reading that the
-- authority matrix (migration 035) reserves for the 250,000–10,000,000 band
-- (`['hod','procurement','mc','cfo']`). The 0–250,000 CAPEX band grants `hod`
-- alone.
--
-- And it got worse the moment the class was made. The split that decides the
-- band is itself SQL, computed from the lines:
--
--     FILTER (WHERE pl.classification LIKE 'CAPEX%')  ->  capex_amount
--     FILTER (WHERE pl.classification LIKE 'OPEX%')   ->  opex_amount
--                                                    -- migration 069
--
-- `fn_derive_routing` reads that split. So classifying a PKR 135 request as
-- capital CHANGED the answer it would have given — and nothing carried that
-- change into the column. PR-2026-202043 is the worked example: it was derived
-- FAST_TRACK before the class was made, STANDARD after, and the MC gate turned on
-- the stale value.
--
-- ── WHY A TRIGGER, NOT ANOTHER WRITE IN THE SERVICE ─────────────────────────
--
-- Because the honest fix is not "remember to derive it in four more places".
-- The column is a FUNCTION of three other columns, and a function that lives in
-- the caller is a function with four callers and no enforcement. A BEFORE
-- trigger on the three source columns makes the derivation unavoidable: any
-- writer, from any migration or script, gets the right key or cannot write at
-- all.
--
-- It is also what makes the write-back and the classification correct
-- retroactively. Both already UPDATE `capex_amount` / `opex_amount` /
-- `estimated_amount`; the trigger notices and re-derives in the same statement.
--
-- ── SCOPE: FORWARD ONLY ────────────────────────────────────────────────────
--
-- This migration installs the trigger and recomputes nothing. The 1,491 rows
-- already carrying a stale key are measured separately (see the dry-run report)
-- and corrected in their OWN migration, so a governance change of this size is
-- never buried inside the change that makes it possible.
--
-- The one exception is a NO-OP repair for the rows this trigger would otherwise
-- contradict the moment they are touched — nothing is written here.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- THE TRIGGER
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION workflow.fn_refresh_routing_key()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_key text;
BEGIN
  -- ONLY on the columns the routing is a function of. A trigger that fired on
  -- every UPDATE would re-derive the key while this very function is writing it,
  -- and would rewrite rows whose routing had not changed.
  --
  -- `fn_derive_routing` RETURNS TABLE, so it is selected FROM rather than called
  -- and field-accessed: `fn(...).routing_key` is a syntax error on a set-returning
  -- function, and the compiler says so at the dot.
  SELECT routing_key INTO v_key
    FROM proc.fn_derive_routing(
      COALESCE(NEW.capex_amount, 0),
      COALESCE(NEW.opex_amount, 0),
      COALESCE(NEW.estimated_amount, 0)
    );

  IF NEW.routing_key IS DISTINCT FROM v_key THEN
    NEW.routing_key := v_key;
  END IF;

  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION workflow.fn_refresh_routing_key() IS
  'Keeps purchase_requisitions.routing_key equal to fn_derive_routing(capex, opex, total). '
  'Installed by migration 072-era routing repair; the column was previously written '
  'by the caller and never recomputed, which froze every LIGHT request at STANDARD.';

DROP TRIGGER IF EXISTS trg_prs_refresh_routing_key ON proc.purchase_requisitions;

CREATE TRIGGER trg_prs_refresh_routing_key
  BEFORE INSERT OR UPDATE OF capex_amount, opex_amount, estimated_amount
    ON proc.purchase_requisitions
  FOR EACH ROW
  EXECUTE FUNCTION workflow.fn_refresh_routing_key();

-- ── post-conditions ────────────────────────────────────────────────────────
--
-- INVARIANTS, NOT COUNTS. Re-running this chain must not fail because a later
-- migration added a step or a row; every assertion is a property that holds.
DO $$
DECLARE
  v_fresh record;
  v_stale int;
  v_total int;
BEGIN
  -- 1. The trigger exists, fires on exactly the three source columns, and is
  --    installed BEFORE the row is written (AFTER would leave the row momentarily
  --    carrying the caller's value, which is the value we are correcting).
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_prs_refresh_routing_key'
       AND tgrelid = 'proc.purchase_requisitions'::regclass
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'migration 073: the routing_key trigger is not installed.';
  END IF;

  -- 2. It must actually work. This is the assertion that would catch a trigger
  --    that exists but was wired to the wrong columns — which would look
  --    perfectly correct in \d output and never fire.
  --
  --    The probe's foreign keys come from the REFERENCE tables, not from an
  --    existing purchase requisition. The earlier version copied them from
  --    "some PR whose flow_kind = 'LIGHT'", which made the probe's existence
  --    depend on the estate having a LIGHT request in it: on a freshly seeded
  --    database the seeded request carries no flow_kind, the INSERT ... SELECT
  --    matched no rows, and the probe never existed to prove anything. What
  --    the probe needs is a valid requester, department and cost centre — all
  --    of which the seed provides — and nothing about a real request.
  INSERT INTO proc.purchase_requisitions
    (pr_number, requester_user_id, department_id, cost_center_id,
     expense_type, required_by_date, status, urgency, scope, flow_kind,
     estimated_amount, capex_amount, opex_amount, amount_status, currency)
  SELECT 'PR-072-PROBE', u.id,
         COALESCE(u.department_id, (SELECT id FROM core.departments ORDER BY code LIMIT 1)),
         (SELECT id FROM core.cost_centers ORDER BY code LIMIT 1),
         'CAPEX', current_date, 'Draft', 'routine', 'routing probe', 'LIGHT',
         135, 135, 0, 'ESTIMATED', 'PKR'
    FROM core.users u
   WHERE u.role = 'requester'
   ORDER BY u.email
   LIMIT 1;

  SELECT routing_key, estimated_amount, capex_amount, opex_amount
    INTO v_fresh
    FROM proc.purchase_requisitions
   WHERE pr_number = 'PR-072-PROBE';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'migration 073: could not create the probe row.';
  END IF;

  IF v_fresh.routing_key <> 'FAST_TRACK' THEN
    RAISE EXCEPTION
      'migration 073: a PKR 135 capital request derived "%" instead of FAST_TRACK. '
      'The trigger fired but derived the wrong answer.', v_fresh.routing_key;
  END IF;

  -- …and it must REACT. A trigger that only ever computes the same value is
  -- indistinguishable from a column default, so this step must land on a
  -- DIFFERENT band than the insert did.
  --
  -- PKR 500,000, all operating: outside the 100,000 petty-opex ceiling and
  -- outside the 250,000 capex-delegation ceiling, so STANDARD. Note that PKR 250
  -- would NOT do — fn_derive_routing(0, 0, 250) is FAST_TRACK ("HOD only"), which
  -- is why an earlier draft of this assertion passed the wrong pair and proved
  -- nothing.
  UPDATE proc.purchase_requisitions
     SET capex_amount = 0, opex_amount = 0, estimated_amount = 500000
   WHERE pr_number = 'PR-072-PROBE';

  SELECT routing_key INTO v_fresh
    FROM proc.purchase_requisitions WHERE pr_number = 'PR-072-PROBE';

  IF v_fresh.routing_key <> 'STANDARD' THEN
    RAISE EXCEPTION
      'migration 073: after re-splitting the probe as operating, routing_key stayed '
      '"%". The trigger is not re-deriving on UPDATE.', v_fresh.routing_key;
  END IF;

  DELETE FROM proc.purchase_requisitions WHERE pr_number = 'PR-072-PROBE';

  IF EXISTS (SELECT 1 FROM proc.purchase_requisitions WHERE pr_number = 'PR-072-PROBE') THEN
    RAISE EXCEPTION 'migration 073: the probe row survived its own deletion.';
  END IF;

  -- 3. FORWARD-ONLY, and honest about it. Existing rows keep whatever key they
  --    hold until they are touched or backfilled. This migration must not
  --    silently rewrite 1,491 governance records — that is a separate, reported
  --    decision, and the count is printed so nobody believes it happened.
  SELECT count(*) FILTER (
           WHERE pr.routing_key <> (
             SELECT routing_key FROM proc.fn_derive_routing(
               COALESCE(pr.capex_amount,0), COALESCE(pr.opex_amount,0),
               COALESCE(pr.estimated_amount,0))
           )
         ),
         count(*)
    INTO v_stale, v_total
    FROM proc.purchase_requisitions pr;

  RAISE NOTICE 'migration 073 ok: routing_key is now trigger-maintained.';
  RAISE NOTICE '  rows carrying a stale key, unchanged by this migration: % of %',
    v_stale, v_total;
  RAISE NOTICE '  they are corrected by a SEPARATE migration — see the dry-run report.';
END $$;

COMMIT;