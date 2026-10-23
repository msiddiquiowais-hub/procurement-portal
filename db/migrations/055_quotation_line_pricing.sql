-- 055_quotation_line_pricing.sql
--
-- Per-line pricing waterfall, per-line warranty, and a durable revision reason
-- for quotations.
--
-- WHY
-- ---
-- The Receive Quotation form captures a GROSS -> DISC -> NET -> TAX -> TOTAL
-- waterfall per RFQ line. proc.quotation_lines could store NONE of it: the table
-- held only `unit_price`, `total_price`, `declined` and `remarks`. Meanwhile the
-- only tax columns in the schema lived on the quotation HEADER, in the
-- `tax_breakdown` jsonb bag, so a form that taxes each line differently had
-- nowhere to put those values.
--
-- The old UI papered over this by hiding discount and per-line tax behind one
-- subtotal/tax/freight box on the header. That cannot represent a real vendor
-- quote: a desk with 5% off, a chair with none, each at its own tax rate.
--
-- Three smaller gaps closed here as well:
--   * `revision_reason` — supersede() accepted a reason and returned it in the
--     response string, but never persisted it. There is no column for it, so
--     "why did this price change?" was unanswerable after the fact.
--   * `valid_until`    — the form collects a DATE; the schema only had
--     `validity_days` (an INTEGER). Nothing stored what the vendor actually
--     stated.
--   * `warranty_months` per line — warranty is a property of an item, not of a
--     quotation. A desk and a chair from the same vendor routinely carry
--     different warranty periods, so a single header value silently flattens
--     that.
--
-- WHY NOT REUSE tax_breakdown
-- ---------------------------
-- tax_breakdown is one jsonb object per quotation. A per-line waterfall needs
-- one row per line, and the comparative statement and any future spend report
-- must be able to SUM() discount and tax by vendor. Real columns, not jsonb.
--
-- REPLAY SAFE
-- -----------
-- There is NO migration ledger in this project — db/scripts/migrate.ps1 replays
-- EVERY *.sql file on every run and each one is expected to be a no-op when
-- already applied. Every statement below is therefore guarded, and the backfill
-- only touches rows the new columns have not already filled.
--
-- BACKFILL SEMANTICS
-- ------------------
-- Historic rows were written under the old model, which had no discount and no
-- per-line tax at all: total_price was simply unit_price x quantity. Translating
-- them into the new model therefore means "no discount, no tax":
--   gross = net = line_total = total_price, discount and tax all zero.
-- That is an exact restatement of what those rows actually recorded, not a guess.
-- `warranty_months` stays NULL on legacy rows: the old schema recorded warranty
-- once on the header, and repeating that header value onto every line would
-- assert a per-item figure nobody ever captured. NULL means "not stated", which
-- is what is true.

\set ON_ERROR_STOP on
BEGIN;

-- ══════════════════════════════════════════════════════════════════════════
-- proc.quotation_lines — the per-line waterfall
-- ══════════════════════════════════════════════════════════════════════════

ALTER TABLE proc.quotation_lines
  ADD COLUMN IF NOT EXISTS gross_amount    numeric(18,2),
  ADD COLUMN IF NOT EXISTS discount_percent numeric(5,2),
  ADD COLUMN IF NOT EXISTS discount_amount numeric(18,2),
  ADD COLUMN IF NOT EXISTS net_amount      numeric(18,2),
  ADD COLUMN IF NOT EXISTS tax_percent     numeric(5,2),
  ADD COLUMN IF NOT EXISTS tax_amount      numeric(18,2),
  ADD COLUMN IF NOT EXISTS line_total      numeric(18,2),
  ADD COLUMN IF NOT EXISTS warranty_months integer;

COMMENT ON COLUMN proc.quotation_lines.gross_amount IS
  'quantity x unit_price, before any discount. NULL on pre-055 rows until backfilled.';
COMMENT ON COLUMN proc.quotation_lines.discount_percent IS
  'Vendor discount on this line, 0-100. The AUTHORITATIVE input; discount_amount is derived.';
COMMENT ON COLUMN proc.quotation_lines.discount_amount IS
  'Derived: round(gross_amount * discount_percent / 100, 2). Never entered directly.';
COMMENT ON COLUMN proc.quotation_lines.net_amount IS
  'gross_amount - discount_amount. The taxable base when the quotation is tax-EXCLUSIVE.';
COMMENT ON COLUMN proc.quotation_lines.tax_percent IS
  'Tax rate on this line, 0-100.';
COMMENT ON COLUMN proc.quotation_lines.tax_amount IS
  'Derived: round(base * tax_percent / 100, 2). Rounded PER LINE, then summed, which is what FBR/PRA require.';
COMMENT ON COLUMN proc.quotation_lines.line_total IS
  'What this line contributes to quotations.total_amount. Tax-exclusive: net_amount + tax_amount. Tax-inclusive: net_amount.';
COMMENT ON COLUMN proc.quotation_lines.warranty_months IS
  'Warranty for THIS item. Not the header value — a quote can mix a 5yr desktop and a 1yr chair.';

-- ══════════════════════════════════════════════════════════════════════════
-- proc.quotations — revision reason, stated validity, discount basis
-- ══════════════════════════════════════════════════════════════════════════

ALTER TABLE proc.quotations
  ADD COLUMN IF NOT EXISTS revision_reason text,
  ADD COLUMN IF NOT EXISTS valid_until      date,
  ADD COLUMN IF NOT EXISTS discount_basis   text;

COMMENT ON COLUMN proc.quotations.revision_reason IS
  'Why this version replaced the previous one. Required when recording a new version.';
COMMENT ON COLUMN proc.quotations.valid_until IS
  'The expiry date the VENDOR stated. validity_days is kept for compatibility; this is the authoritative figure.';
COMMENT ON COLUMN proc.quotations.discount_basis IS
  'before_tax  = tax is computed on the discounted net  (discount reduces the taxable base)
   after_tax   = tax is computed on the gross, discount is taken off afterwards.
   NULL means before_tax, which is the default and what the seed data assumes.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'quotations_discount_basis_check'
  ) THEN
    ALTER TABLE proc.quotations
      ADD CONSTRAINT quotations_discount_basis_check
      CHECK (discount_basis IS NULL OR discount_basis IN ('before_tax', 'after_tax'));
  END IF;
END $$;

-- Non-negative money, and a percentage that cannot exceed 100. Money signed to
-- (18,2) matches the existing total_price/unit_price columns exactly.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quotation_lines_gross_amount_check') THEN
    ALTER TABLE proc.quotation_lines ADD CONSTRAINT quotation_lines_gross_amount_check
      CHECK (gross_amount IS NULL OR gross_amount >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quotation_lines_discount_percent_check') THEN
    ALTER TABLE proc.quotation_lines ADD CONSTRAINT quotation_lines_discount_percent_check
      CHECK (discount_percent IS NULL OR (discount_percent >= 0 AND discount_percent <= 100));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quotation_lines_discount_amount_check') THEN
    ALTER TABLE proc.quotation_lines ADD CONSTRAINT quotation_lines_discount_amount_check
      CHECK (discount_amount IS NULL OR discount_amount >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quotation_lines_net_amount_check') THEN
    ALTER TABLE proc.quotation_lines ADD CONSTRAINT quotation_lines_net_amount_check
      CHECK (net_amount IS NULL OR net_amount >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quotation_lines_tax_percent_check') THEN
    ALTER TABLE proc.quotation_lines ADD CONSTRAINT quotation_lines_tax_percent_check
      CHECK (tax_percent IS NULL OR (tax_percent >= 0 AND tax_percent <= 100));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quotation_lines_tax_amount_check') THEN
    ALTER TABLE proc.quotation_lines ADD CONSTRAINT quotation_lines_tax_amount_check
      CHECK (tax_amount IS NULL OR tax_amount >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quotation_lines_line_total_check') THEN
    ALTER TABLE proc.quotation_lines ADD CONSTRAINT quotation_lines_line_total_check
      CHECK (line_total IS NULL OR line_total >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quotation_lines_warranty_months_check') THEN
    ALTER TABLE proc.quotation_lines ADD CONSTRAINT quotation_lines_warranty_months_check
      CHECK (warranty_months IS NULL OR warranty_months >= 0);
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- Backfill — translate pre-055 rows into the waterfall they actually recorded
-- ══════════════════════════════════════════════════════════════════════════

\echo '--- 055: quotation line backfill: before ---'
SELECT count(*) AS total_lines,
       count(*) FILTER (WHERE gross_amount IS NULL) AS needs_backfill
  FROM proc.quotation_lines;

UPDATE proc.quotation_lines
   SET gross_amount    = total_price,
       discount_percent = 0,
       discount_amount = 0,
       net_amount      = total_price,
       tax_percent     = 0,
       tax_amount      = 0,
       line_total      = total_price
 WHERE gross_amount IS NULL;

\echo '--- 055: quotation line backfill: after ---'
SELECT count(*) FILTER (WHERE gross_amount IS NULL) AS still_null,
       count(*) FILTER (WHERE line_total <> total_price) AS total_mismatch
  FROM proc.quotation_lines;

-- The header carry-over: a legacy row's warranty_months is the only warranty
-- figure that was ever captured. Copy it onto that quote's own lines so the
-- per-line column is not empty for data we DO have — but never as an assertion
-- about a specific item. Restricted to pre-055 rows (gross_amount was NULL
-- before the UPDATE above) so a re-run cannot smear a newer header value onto
-- lines that now carry their own.
\echo '--- 055: carrying header warranty onto legacy lines ---'
UPDATE proc.quotation_lines ql
   SET warranty_months = q.warranty_months
  FROM proc.quotations q
 WHERE q.id = ql.quotation_id
   AND ql.warranty_months IS NULL
   AND ql.gross_amount IS NOT NULL
   AND q.warranty_months IS NOT NULL
   AND q.version = 1;

COMMIT;

\echo '--- 055 complete ---'