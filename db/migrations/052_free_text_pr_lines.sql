-- 052_free_text_pr_lines.sql
--
-- FREE-TEXT LINE ITEMS
-- ====================
--
-- The requester asks for: type anything into the line description, do not make me
-- match a catalogue row, do not block my submit. That is a product decision and it
-- is the right one — the person raising a requisition knows they need "two
-- ergonomic chairs, mesh back, no arms", which is not an SKU, and forcing them to
-- pretend otherwise produced false lines rather than honest ones.
--
-- What this migration changes is NOT "remove validation". The foreign key STAYS.
-- A line that names an item still has to name a REAL one. Only the requirement to
-- name one at all is dropped:
--
--     item_id  uuid NOT NULL REFERENCES core.items(id)   ->   item_id uuid REFERENCES core.items(id)
--
-- The difference between "no item" (NULL, allowed now) and "a made-up item"
-- (a random uuid, still refused) is the whole point. A lookup picker that offers a
-- hint must never be the only way to describe a need.
--
-- WHY EVERY DOWNSTREAM READER HAD TO CHANGE TOO
-- ---------------------------------------------
-- Dropping the NOT NULL is one line. The other half is that five readers INNER JOIN
-- core.items, and an INNER JOIN against a NULL key SILENTLY DROPS THE ROW. That is
-- the dangerous failure mode: not an error, just a line that vanishes from the PR
-- after it was accepted. Specifically:
--
--   * proc.fn_compute_pr_totals()   -> the line's money stops counting toward the
--     PR total, so a free-text line is invisible to the management gate.
--   * pr.service get() lines        -> the line disappears from the detail screen
--     the requester is redirected to immediately after submitting.
--   * pr.service review lines       -> the line disappears from the approver's
--     screen, so the HOD approves a request they cannot see in full.
--   * d365.service push payload     -> the line is silently omitted from the push.
--
-- All four become LEFT JOIN, so a NULL item yields NULL item columns and the line
-- still renders, still totals, and still pushes. Fixing the INSERT without fixing
-- the READS is the exact bug shape this file is written to prevent.
--
-- HOW CAPEX/OPEX IS DECIDED FOR A LINE WITH NO ITEM
-- -------------------------------------------------
-- core.items.expense_type is where a line's Capex/Opex classification comes from,
-- and a free-text line has no item to carry one. Defaulting it to NULL and letting
-- the CASE fall through would silently drop the line's amount out of BOTH sums and
-- out of the total — a PKR 250,000 request would read as PKR 0 and sail past the
-- 2.5M management gate as if it were free.
--
-- So an unbound line is classified OPEX, via COALESCE(i.expense_type,'OPEX'). That
-- is the SAME default the API already applies client-side when no line resolves to
-- an item (`kinds.size === 0 ? 'OPEX'`), so the stored row and the form agree.
--
-- CAPEX CANNOT BE INFERED, AND IS NOT INVENTED
-- ---------------------------------------------
-- A laptop that nobody has yet priced is frequently a free-text line, and laptops
-- are CAPEX. Defaulting to OPEX misfiles it. There is no evidence in the data to
-- do better, so this migration does not pretend otherwise — it records OPEX as the
-- honest "unclassified" bucket and leaves the correction to the approver, who sees
-- the amount and the free-text description on the review screen. What it refuses to
-- do is let the amount vanish, which is the difference between a wrong label and a
-- wrong number.
--
-- REPLAY SAFETY
-- -------------
-- This file is replayed on every `db:migrate` (all files, lexical order, every
-- run). DROP NOT NULL is idempotent, and CREATE OR REPLACE is idempotent. No
-- DELETE, no data movement, no trigger re-arm — nothing here can destroy rows on a
-- second run, which is the replay trap migrations 046/051 already fell into.


-- ─── 1. the catalogue link becomes optional ─────────────────────────────────
-- The FK is deliberately retained. This widens "may I describe this in my own
-- words?" and leaves "may I invent a product code?" answered no.
ALTER TABLE proc.pr_lines ALTER COLUMN item_id DROP NOT NULL;

-- A line must say SOMETHING. Without this the form could submit a row that is
-- empty in every column — no item, no description — and it would be a real,
-- routed, approvable line that requests nothing at all. The client already skips
-- blank rows; this is the database saying the same thing independently, because a
-- client-side check is not a guarantee.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pr_lines_line_states_something'
  ) THEN
    ALTER TABLE proc.pr_lines
      ADD CONSTRAINT pr_lines_line_states_something
      CHECK (item_id IS NOT NULL OR COALESCE(BTRIM(description), '') <> '');
  END IF;
END $$;

COMMENT ON COLUMN proc.pr_lines.item_id IS
  'Optional. NULL means the requester described the need in free text instead of '
  'choosing a catalogue row (migration 052). The FK to core.items is retained: a '
  'line that names an item must name a real one.';


-- ─── 2. totals must count a line that has no item ───────────────────────────
-- fn_compute_pr_totals was defined in 006 and replaced in 046. Both INNER JOINED
-- core.items, which dropped every free-text line from the arithmetic. The COALESCE
-- is what stops an unclassified line falling out of BOTH the CAPEX sum and the
-- OPEX sum — see the header note on why the default is OPEX.
CREATE OR REPLACE FUNCTION proc.fn_compute_pr_totals(p_pr_id uuid)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_capex numeric(18,2);
  v_opex  numeric(18,2);
  v_expense_type text;
  v_amount_status text;
  v_has_capex boolean;
  v_has_opex boolean;
BEGIN
  SELECT
    COALESCE(SUM(CASE WHEN COALESCE(i.expense_type,'OPEX') = 'CAPEX'
                      THEN l.quantity * l.unit_price_est ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN COALESCE(i.expense_type,'OPEX') = 'OPEX'
                      THEN l.quantity * l.unit_price_est ELSE 0 END), 0),
    -- 'UNKNOWN' while no line carries a price. An explicit 0 stays 'ESTIMATED':
    -- a requester can genuinely mean free, and that is an answer, not a silence.
    --
    -- count(*) here counts LINES, not joined rows. Under the old INNER JOIN a
    -- free-text line was absent from the row set entirely, so it could not
    -- influence this flag. With the LEFT JOIN every line is present and an
    -- unpriced free-text line correctly holds the PR at UNKNOWN.
    CASE WHEN count(*) FILTER (WHERE l.unit_price_est IS NULL) = count(*) THEN 'UNKNOWN'
         ELSE 'ESTIMATED' END,
    bool_or(COALESCE(i.expense_type,'OPEX') = 'CAPEX'),
    bool_or(COALESCE(i.expense_type,'OPEX') = 'OPEX')
  INTO v_capex, v_opex, v_amount_status, v_has_capex, v_has_opex
    FROM proc.pr_lines l
    LEFT JOIN core.items i ON i.id = l.item_id
   WHERE l.pr_id = p_pr_id;

  -- expense_type follows the ITEMS, not the amounts.
  --
  -- It used to be derived from the totals (`if v_capex > 0 and v_opex > 0`),
  -- which silently reclassifies every UNPRICED line as OPEX: with no price both
  -- totals are 0, the first two tests fail, and a Dell Latitude laptop became an
  -- operating expense. Capex/Opex is a property of what is being bought, and
  -- core.items.expense_type says so without needing a price. The amounts cannot
  -- tell you the classification; they can only tell you how much of each there
  -- is, which is a different question.
  --
  -- Migration 052 adds the third state: a line with no item at all. It is
  -- COALESCEd to OPEX above, so it lands in the OPEX branch here exactly as the
  -- form's client-side default does.
  IF v_has_capex AND v_has_opex THEN
    v_expense_type := 'MIXED';
  ELSIF v_has_capex THEN
    v_expense_type := 'CAPEX';
  ELSE
    v_expense_type := 'OPEX';
  END IF;

  UPDATE proc.purchase_requisitions
     SET capex_amount     = v_capex,
         opex_amount      = v_opex,
         estimated_amount = v_capex + v_opex,
         amount_status    = v_amount_status,
         expense_type     = v_expense_type,
         last_updated_at  = now()
   WHERE id = p_pr_id;
END;
$$;
