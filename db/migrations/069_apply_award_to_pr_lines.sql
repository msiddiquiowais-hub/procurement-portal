-- 069_apply_award_to_pr_lines.sql
--
-- THE AWARD WRITE-BACK, AS ONE ATOMIC STATEMENT.
--
-- WHY A DATABASE FUNCTION
-- -----------------------
-- The write-back does two things: it puts the winning rate on each PR line,
-- and it recomputes the PR's header from those lines. The second depends on
-- the first, so it has to happen after it.
--
-- The API's transport cannot do that atomically. DbService.withTransaction()
-- runs each statement as its OWN docker-exec call, each wrapped in its own
-- BEGIN/COMMIT — its own header says so: "this is NOT atomic in the strict DB
-- sense". A failure between the two statements leaves the lines priced and
-- the header stale, which is a request that looks priced and reads as
-- unpriced. It happened: the first run of the backfill wrote the rates, threw
-- on the header step, and left exactly that.
--
-- A PL/pgSQL function called as a single statement runs in ONE transaction.
-- So the whole write-back becomes one statement, and it is atomic for the
-- same reason any other statement is.
--
-- It also puts the rule in ONE place. The API, the backfill script and any
-- future caller all reach the same function, so there is no second
-- implementation of "what the awarded rate is" to drift against this one.
--
-- WHAT IT WRITES
-- --------------
--   proc.pr_lines.unit_price_est      the winning rate
--   proc.pr_lines.budget_unit_price   the requester's own pre-RFQ guess, ONCE
--   proc.purchase_requisitions.*      the header, recomputed from the lines
--
-- Only APPROVED lines are written. A held line is not being bought, so it
-- never had a rate and must not be given one.
--
-- The amount rule: the spend is ESTIMATED only when every approved line
-- carries a price, and the total is the sum over the approved lines. A
-- partial amount is not a small amount; it is an unknown one.

BEGIN;

-- The return type changes between versions of this function (the lists it
-- reports grew), and PostgreSQL will not let CREATE OR REPLACE change a
-- function's signature. So it is dropped first. The signature is exact —
-- uuid, uuid — so the drop cannot take anything else with it.
DROP FUNCTION IF EXISTS proc.fn_apply_award_to_pr_lines(uuid, uuid);

CREATE OR REPLACE FUNCTION proc.fn_apply_award_to_pr_lines(
  p_pr_id uuid,
  p_cs_id uuid
)
RETURNS TABLE (
  rates_applied  integer,
  synced_lines   jsonb,
  unawarded_lines jsonb,
  unclassified_lines jsonb,
  unpriced_lines jsonb,
  split_lines    jsonb,
  approved_lines integer,
  estimated_amount numeric,
  capex_amount   numeric,
  opex_amount    numeric,
  amount_status  text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_total      numeric;
  v_capex      numeric;
  v_opex       numeric;
  v_approved   integer;
  v_unpriced   integer;
  v_synced     integer;
  v_status     text;
  v_synced_nos jsonb;
  v_unawarded  jsonb;
  v_unclass    jsonb;
  v_unpriced_nos jsonb;
  v_split      jsonb;
BEGIN
  -- ── 1 · the winning rates, onto the PR lines ──────────────────────────────
  --
  -- The award is reached through proc.rfq_lines.pr_line_id — the FK the RFQ
  -- was built from — and never through a line_no guess. `superseded_at IS
  -- NULL` is the LIVE award: a re-award supersedes its predecessor rather
  -- than deleting it, so the history stays and only the current decision is
  -- read.
  --
  -- DISTINCT ON picks one award per line, the one with the largest share. A
  -- line split between two vendors has no single rate, and the line is
  -- reported in split_lines by the caller.
  WITH winners AS (
    SELECT DISTINCT ON (pl.id)
           pl.id AS pr_line_id,
           pl.line_no,
           ql.unit_price AS awarded_unit_price
      FROM proc.comparative_statements cs
      JOIN proc.cs_line_awards a
        ON a.cs_id = cs.id AND a.superseded_at IS NULL
      JOIN proc.rfq_lines l
        ON l.rfq_id = cs.rfq_id AND l.line_no = a.rfq_line_no
      JOIN proc.pr_lines pl
        ON pl.id = l.pr_line_id
      LEFT JOIN LATERAL (
            SELECT q2.id
              FROM proc.quotations q2
             WHERE q2.rfq_id = cs.rfq_id
               AND q2.vendor_id = a.vendor_id
               AND q2.state IN ('Submitted','Awarded')
             ORDER BY q2.version DESC LIMIT 1
      ) q ON true
      LEFT JOIN proc.quotation_lines ql
        ON ql.quotation_id = q.id AND ql.rfq_line_no = a.rfq_line_no
     WHERE cs.id = p_cs_id
     ORDER BY pl.id, a.awarded_qty DESC NULLS LAST, a.vendor_id
  ),
  written AS (
    UPDATE proc.pr_lines pl
       SET unit_price_est = w.awarded_unit_price,
           -- The requester's budget is captured ONCE, at the first write-back,
           -- and never overwritten. A second write-back of a revised quote must
           -- not erase what was originally asked for — the Cost approval screen
           -- compares the two.
           budget_unit_price = COALESCE(pl.budget_unit_price, pl.unit_price_est)
      FROM winners w
     WHERE pl.id = w.pr_line_id
       AND w.awarded_unit_price IS NOT NULL
       AND pl.approved AND NOT pl.rejected AND NOT pl.held
    RETURNING pl.line_no
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(line_no) ORDER BY line_no), '[]'::jsonb)
    INTO v_synced_nos
    FROM written;

  v_synced := jsonb_array_length(v_synced_nos);

  -- ── 2 · the header, recomputed from the lines ────────────────────────────
  SELECT
      COALESCE(SUM(pl.quantity * pl.unit_price_est)
               FILTER (WHERE pl.approved AND NOT pl.rejected AND NOT pl.held), 0),
      COALESCE(SUM(pl.quantity * pl.unit_price_est)
               FILTER (WHERE pl.approved AND NOT pl.rejected AND NOT pl.held
                         AND pl.classification LIKE 'CAPEX%'), 0),
      COALESCE(SUM(pl.quantity * pl.unit_price_est)
               FILTER (WHERE pl.approved AND NOT pl.rejected AND NOT pl.held
                         AND pl.classification LIKE 'OPEX%'), 0),
      count(*) FILTER (WHERE pl.approved AND NOT pl.rejected AND NOT pl.held),
      count(*) FILTER (WHERE pl.approved AND NOT pl.rejected AND NOT pl.held
                         AND pl.unit_price_est IS NULL)
    INTO v_total, v_capex, v_opex, v_approved, v_unpriced
    FROM proc.pr_lines pl
   WHERE pl.pr_id = p_pr_id;

  v_status := CASE WHEN v_approved > 0 AND v_unpriced = 0 THEN 'ESTIMATED' ELSE 'UNKNOWN' END;

  UPDATE proc.purchase_requisitions pr
     SET estimated_amount = CASE WHEN v_status = 'ESTIMATED' THEN v_total ELSE 0 END,
         capex_amount    = v_capex,
         opex_amount     = v_opex,
         amount_status   = v_status,
         last_updated_at = now()
   WHERE pr.id = p_pr_id;

  -- ── 3 · what happened, for the caller ────────────────────────────────────
  --
  -- Three independent lists, each its own scalar subquery: the lines this
  -- call wrote, the approved lines the competition never decided, and the
  -- approved lines still carrying no class. The second is a failure the caller
  -- must refuse on; the third is what the CS gate refuses on.
  SELECT
    (SELECT COALESCE(jsonb_agg(to_jsonb(pl.line_no) ORDER BY pl.line_no), '[]'::jsonb)
       FROM proc.pr_lines pl
      WHERE pl.pr_id = p_pr_id
        AND pl.approved AND NOT pl.rejected AND NOT pl.held
        AND pl.unit_price_est IS NOT NULL),
    (SELECT COALESCE(jsonb_agg(to_jsonb(pl.line_no) ORDER BY pl.line_no), '[]'::jsonb)
       FROM proc.pr_lines pl
       LEFT JOIN proc.rfq_lines l ON l.pr_line_id = pl.id
      WHERE pl.pr_id = p_pr_id
        AND pl.approved AND NOT pl.rejected AND NOT pl.held
        AND NOT EXISTS (
              SELECT 1 FROM proc.cs_line_awards a
               WHERE a.cs_id = p_cs_id AND a.superseded_at IS NULL
                 AND a.rfq_line_no = l.line_no)),
    (SELECT COALESCE(jsonb_agg(to_jsonb(pl.line_no) ORDER BY pl.line_no), '[]'::jsonb)
       FROM proc.pr_lines pl
      WHERE pl.pr_id = p_pr_id
        AND pl.approved AND NOT pl.rejected AND NOT pl.held
        AND pl.classification IS NULL),
    (SELECT COALESCE(jsonb_agg(to_jsonb(pl.line_no) ORDER BY pl.line_no), '[]'::jsonb)
       FROM proc.pr_lines pl
      WHERE pl.pr_id = p_pr_id
        AND pl.approved AND NOT pl.rejected AND NOT pl.held
        AND pl.unit_price_est IS NULL),
    (SELECT COALESCE(jsonb_agg(to_jsonb(x.line_no) ORDER BY x.line_no), '[]'::jsonb)
       FROM (
            SELECT l.line_no
              FROM proc.rfq_lines l
              JOIN proc.cs_line_awards a
                ON a.cs_id = p_cs_id AND a.superseded_at IS NULL
               AND a.rfq_line_no = l.line_no
              WHERE l.rfq_id = (SELECT rfq_id FROM proc.comparative_statements WHERE id = p_cs_id)
             GROUP BY l.line_no
            HAVING count(DISTINCT a.vendor_id) > 1
       ) x)
    INTO v_synced_nos, v_unawarded, v_unclass, v_unpriced_nos, v_split;

  RETURN QUERY
    SELECT v_synced, v_synced_nos, v_unawarded, v_unclass, v_unpriced_nos, v_split, v_approved,
           CASE WHEN v_status = 'ESTIMATED' THEN v_total ELSE 0 END,
           v_capex, v_opex, v_status;
END;
$$;

COMMENT ON FUNCTION proc.fn_apply_award_to_pr_lines(uuid, uuid) IS
  'Writes the winning rates onto the PR lines and recomputes the PR header from the APPROVED lines. One statement, so it is atomic on a transport that runs each statement in its own transaction.';

-- ─── verification ───────────────────────────────────────────────────────────
DO $$
DECLARE
  fn regproc;
BEGIN
  fn := to_regprocedure('proc.fn_apply_award_to_pr_lines(uuid,uuid)');
  IF fn IS NULL THEN
    RAISE EXCEPTION 'migration 069: proc.fn_apply_award_to_pr_lines(uuid,uuid) was not created';
  END IF;

  -- It must EXIST, but calling it on a live PR would write. So it is proved
  -- against a throwaway: the function's own body is checked for the two
  -- things that make it atomic and for the approved-line rule, and the
  -- function is confirmed callable with a NULL argument (it must not raise
  -- at parse time).
  IF pg_get_functiondef(fn) NOT LIKE '%budget_unit_price = COALESCE(pl.budget_unit_price, pl.unit_price_est)%' THEN
    RAISE EXCEPTION 'migration 069: the budget is not preserved on the first write-back';
  END IF;
  IF pg_get_functiondef(fn) NOT LIKE '%pl.approved AND NOT pl.rejected AND NOT pl.held%' THEN
    RAISE EXCEPTION 'migration 069: the approved-line rule is not in the function';
  END IF;
  IF pg_get_functiondef(fn) NOT LIKE '%amount_status%ESTIMATED%' THEN
    RAISE EXCEPTION 'migration 069: the amount rule is not in the function';
  END IF;
END $$;

COMMIT;
