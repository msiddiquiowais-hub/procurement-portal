-- 074 · The header's expense_type must follow the LINES
-- ============================================================================
--
-- THE DEFECT
-- ----------
-- A request's per-line Capex/Opex class is the decision. `proc.purchase_
-- requisitions.expense_type` is the SUMMARY of that decision — and it did not
-- carry it.
--
-- `proc.fn_compute_pr_totals` (last written in 052) derives the header type
-- from `core.items.expense_type`, with `COALESCE(i.expense_type,'OPEX')` for a
-- line that binds to no item. A free-text line therefore votes OPEX, ALWAYS,
-- and a free-text line is exactly the one the procurement desk classified by
-- hand. Four consumers read that column:
--
--     d365.service.ts:460        pr.expense_type AS expense_split
--     governance.service.ts:750 pr.expense_type AS expense_split
--     cs.service.ts:299,766     pr.expense_type AS expense_split
--     web  approvals.tsx:86,115  p.expense_type
--
-- `buildPurchaseOrderPayload` maps that value onto the ERP's PurchaseType
-- ('CAPEX' -> 'IT Capex', 'OPEX' -> 'Operating Expense'). So a request whose
-- lines were all CAPEX_ASSET with a 4-year life was pushed to F&O as an
-- OPERATING EXPENSE. The classification a buyer made, and a capital ledger
-- cannot be posted to, disagreed for as long as it took to notice.
--
-- WHY THE AMOUNTS WERE RIGHT AND THE TYPE WAS NOT
-- ----------------------------------------------
-- Two owners, two rules. `syncPrTotals` (apps/api/src/sourcing/award.sync.ts)
-- computes capex_amount/opex_amount from `pl.classification LIKE 'CAPEX%'` —
-- correct. It does not write expense_type at all. Meanwhile the SQL function
-- writes both, from items. So the MONEY followed the lines and the LABEL
-- followed the catalogue, and no test could see it because each owner was
-- tested in isolation and each was correct in its own terms.
--
-- THE RULE, STATED ONCE
-- ---------------------
--   If ANY approved line carries a classification, the header follows the
--   LINES:
--       all CAPEX%  -> CAPEX
--       all OPEX%   -> OPEX
--       both        -> MIXED
--   Otherwise fall back to the ITEM MASTER, exactly as before.
--
-- The fallback is load-bearing. Migration 046 replaced a totals-derived rule
-- with an items-derived one for a reason: with no price, both totals are 0,
-- the arithmetic tests all fail, and a Dell Latitude laptop became an
-- operating expense. Capex/Opex is a property of what is being bought. Before
-- the desk has classified anything, the item master is the best answer
-- available — but it is an ANSWER, not a default, and once a human has
-- decided, a catalogue default must not overrule them.
--
-- SCOPE, STATED PLAINLY
-- ---------------------
-- This migration rewrites `proc.fn_compute_pr_totals` and repairs the rows
-- already stored. It does NOT touch the amounts that function computes: those
-- still follow the item master, which is what 052 left. That function has no
-- caller and no trigger — `syncPrTotals` is the live owner — so changing its
-- amount semantics would be an unmeasured change to 2,121 rows in exchange for
-- tidiness in dead code. What it gets here is the TYPE, so that if anything
-- ever re-wires it, it cannot re-introduce this bug.
--
-- The live owner (`syncPrTotals`) is corrected in the same change, in the
-- application, and it writes BOTH the amounts and the type from the lines.
--
-- REPAIR
-- ------
-- 1,372 headers were rewritten on the first run. That is far more than the 20
-- rows whose header contradicted their APPROVED lines (11 all-capital reading
-- 'OPEX', 9 mixed reading 'OPEX'), and the extra 1,352 are the second half of
-- the same defect rather than a separate one:
--
-- The old rule counted EVERY line, including rejected, held and not-yet-approved
-- ones. `syncPrTotals` has always counted only lines actually being bought. So
-- a request whose capital line was rejected, and whose remaining approved line
-- was operating, had money computed from the live lines and a TYPE computed
-- from a line nobody is buying — `expense_type: 'OPEX'` on a request whose
-- capex_amount was 0, or the reverse. Narrowing the type to the same
-- population the money already uses is the point of the migration, so the
-- write set is larger than the contradiction set.
--
-- The amounts were NOT touched. They were already right, and `syncPrTotals` is
-- what keeps them right.

-- ── 1 · the rule, in one expression, reusable by the repair ────────────────
--
-- Kept as a real function so the repair below and any future caller cannot
-- re-type it. plpgsql so the fallback branch is readable rather than a nested
-- CASE that nobody can audit at a glance.
CREATE OR REPLACE FUNCTION proc.fn_header_expense_type(p_pr_id uuid)
RETURNS text AS $$
DECLARE
  v_classified int;
  v_capex_lines int;
  v_opex_lines  int;
  v_item_capex  boolean;
  v_item_opex   boolean;
BEGIN
  SELECT
    count(*)::int,
    count(*) FILTER (WHERE l.classification LIKE 'CAPEX%')::int,
    count(*) FILTER (WHERE l.classification LIKE 'OPEX%')::int
    INTO v_classified, v_capex_lines, v_opex_lines
    FROM proc.pr_lines l
   WHERE l.pr_id = p_pr_id
     AND l.approved AND NOT l.rejected AND NOT l.held
     AND l.classification IS NOT NULL;

  IF v_classified > 0 THEN
    -- THE DESK HAS DECIDED. A catalogue default does not overrule a human.
    IF v_capex_lines > 0 AND v_opex_lines > 0 THEN RETURN 'MIXED'; END IF;
    IF v_capex_lines > 0 THEN RETURN 'CAPEX'; END IF;
    RETURN 'OPEX';
  END IF;

  -- NOTHING CLASSIFIED YET: the item master answers, as it always has.
  SELECT bool_or(COALESCE(i.expense_type,'OPEX') = 'CAPEX'),
         bool_or(COALESCE(i.expense_type,'OPEX') = 'OPEX')
    INTO v_item_capex, v_item_opex
    FROM proc.pr_lines l
    LEFT JOIN core.items i ON i.id = l.item_id
   WHERE l.pr_id = p_pr_id;

  IF v_item_capex AND v_item_opex THEN RETURN 'MIXED'; END IF;
  IF v_item_capex THEN RETURN 'CAPEX'; END IF;
  RETURN 'OPEX';
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION proc.fn_header_expense_type(uuid) IS
  'The PR header expense_type, derived from the approved classified lines when the '
  'desk has made a decision and from the item master otherwise. One owner: the '
  'repair in 074 and the live path (syncPrTotals) must not re-type this rule.';

-- ── 2 · the same rule inside the totals function ───────────────────────────
-- The AMOUNTS below are unchanged from 052 and still follow the item master.
-- Only the TYPE now follows the lines. See SCOPE above for why.
CREATE OR REPLACE FUNCTION proc.fn_compute_pr_totals(p_pr_id uuid) RETURNS void AS $$
DECLARE
  v_capex numeric(18,2);
  v_opex  numeric(18,2);
  v_expense_type text;
  v_amount_status text;
BEGIN
  SELECT
    COALESCE(SUM(CASE WHEN COALESCE(i.expense_type,'OPEX') = 'CAPEX'
                      THEN l.quantity * l.unit_price_est ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN COALESCE(i.expense_type,'OPEX') = 'OPEX'
                      THEN l.quantity * l.unit_price_est ELSE 0 END), 0),
    -- 'UNKNOWN' while no line carries a price. An explicit 0 stays 'ESTIMATED':
    -- a requester can genuinely mean free, and that is an answer, not a silence.
    CASE WHEN count(*) FILTER (WHERE l.unit_price_est IS NULL) = count(*) THEN 'UNKNOWN'
         ELSE 'ESTIMATED' END
  INTO v_capex, v_opex, v_amount_status
    FROM proc.pr_lines l
    LEFT JOIN core.items i ON i.id = l.item_id
   WHERE l.pr_id = p_pr_id;

  v_expense_type := proc.fn_header_expense_type(p_pr_id);

  UPDATE proc.purchase_requisitions
     SET capex_amount     = v_capex,
         opex_amount      = v_opex,
         estimated_amount = v_capex + v_opex,
         amount_status    = v_amount_status,
         expense_type     = v_expense_type,
         last_updated_at  = now()
   WHERE id = p_pr_id;
END;
$$ LANGUAGE plpgsql;

-- ── 3 · repair what is already stored ──────────────────────────────────────
--
-- expense_type ONLY. The amounts are already correct: `syncPrTotals` has
-- always computed capex/opex from the approved classified lines, and that is
-- the same population this rule reads.
--
-- IDEMPOTENT ON PURPOSE. This chain is replayed whole on every deployment, so
-- "nothing needed correcting" is a normal outcome — on every run after the
-- first — and must not be treated as a failure. An earlier draft of this file
-- raised when zero rows changed, which would have made the migration fail on
-- the second deployment forever. The invariant below is the real check.
DO $$
DECLARE
  v_fixed int;
BEGIN
  WITH disagreeing AS (
    SELECT pr.id
      FROM proc.purchase_requisitions pr
     WHERE pr.expense_type IS DISTINCT FROM proc.fn_header_expense_type(pr.id)
  ), updated AS (
    UPDATE proc.purchase_requisitions pr
       SET expense_type = proc.fn_header_expense_type(pr.id),
           last_updated_at = now()
      FROM disagreeing d
     WHERE pr.id = d.id
     RETURNING pr.id
  )
  SELECT count(*) INTO v_fixed FROM updated;

  RAISE NOTICE '074: % header expense_type value(s) corrected to follow the lines', v_fixed;
END;
$$;

-- ── 4 · POST-CONDITIONS ───────────────────────────────────────────────────
--
-- INVARIANTS, not counts. A count is a statement about today; an invariant is
-- a rule that survives the next migration. This chain is replayed on every
-- deployment, so an assertion written as a number goes false the moment a row
-- is legitimately added.
DO $$
DECLARE
  v_bad_type int;
  v_bad_life int;
BEGIN
  -- INVARIANT 1: no header may disagree with its own approved classified lines.
  SELECT count(*) INTO v_bad_type
    FROM proc.purchase_requisitions pr
   WHERE pr.expense_type IS DISTINCT FROM proc.fn_header_expense_type(pr.id);

  IF v_bad_type <> 0 THEN
    RAISE EXCEPTION '074: % request(s) still carry a header expense_type that '
      'disagrees with their approved classified lines', v_bad_type;
  END IF;

  -- INVARIANT 2: every capital classification carries a useful life.
  --
  -- This is the ledger half, and it is scoped to CLASSIFIED lines on purpose.
  -- An earlier draft of this file asserted the stronger, wrong thing — "no
  -- request may carry capital money without a capital line" — and it failed on
  -- 123 rows that were perfectly consistent: Submitted requests nobody has
  -- classified yet, whose header AND whose money both come from the item
  -- master. A capital amount on an unclassified request is not a contradiction,
  -- it is the only answer available.
  --
  -- What the ERP actually cannot accept is a capital classification with no
  -- depreciation period — an asset with no life is not an asset. That is
  -- enforced by `pr_lines_capex_needs_life_ck`, and asserted here so the
  -- ledger requirement is stated where the header's type is decided.
  SELECT count(*) INTO v_bad_life
    FROM proc.pr_lines
   WHERE classification LIKE 'CAPEX%'
     AND (useful_life_years IS NULL OR useful_life_years <= 0);

  IF v_bad_life <> 0 THEN
    RAISE EXCEPTION '074: % capital line(s) carry no useful life and cannot post '
      'to a fixed asset register', v_bad_life;
  END IF;

  RAISE NOTICE '074: every header expense_type agrees with its approved lines, '
    'and every capital line has a useful life';
END;
$$;