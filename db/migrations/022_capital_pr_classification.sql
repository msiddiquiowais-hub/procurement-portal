-- 022_capital_pr_classification.sql
--
-- Wave 1 close-out: the legacy capital-PR trio (`my-prs`, `pr-create`,
-- `pr-detail`). The prototype's `renderPRCreate` / `renderPRDetail` lean on
-- three things the schema does not carry:
--
--   1. Per-line Capex/Opex classification. `proc.pr_lines` had none — the
--      header carried a single `expense_type`, which cannot express a PR whose
--      lines are mixed. The prototype classifies EVERY line.
--   2. Per-line remarks (delivery constraints, justification notes).
--   3. The `deriveRouting()` rules that turn a Capex/Opex mix + amount into a
--      routing key, used by the detail screen and the D365 payload.
--
-- The 9 D365 financial dimensions live in code (packages/d365-client), not in
-- the DB — they are a fixed D365 contract, not data.

BEGIN;

-- ─── 1 · per-line classification + remarks ────────────────────────────────
ALTER TABLE proc.pr_lines ADD COLUMN IF NOT EXISTS classification text;
ALTER TABLE proc.pr_lines ADD COLUMN IF NOT EXISTS remarks text;

ALTER TABLE proc.pr_lines DROP CONSTRAINT IF EXISTS pr_lines_classification_check;
ALTER TABLE proc.pr_lines
  ADD CONSTRAINT pr_lines_classification_check
  CHECK (classification IS NULL OR classification IN (
    'CAPEX_ASSET',      -- Capex — Asset       (depreciable, 1xxx)
    'CAPEX_INFRA',      -- Capex — Infra       (depreciable, 1xxx)
    'OPEX_CONSUMABLE',  -- Opex — Consumable   (expensed, 6xxx)
    'OPEX_SERVICE',     -- Opex — Service      (expensed, 6xxx)
    'OPEX_MAINT'        -- Opex — Maintenance  (expensed, 6xxx)
  ));

-- A CAPEX_* classification must reference an asset; an OPEX_* one must not.
-- Mirrors core.items_asset_category_capex, at line level.
ALTER TABLE proc.pr_lines DROP CONSTRAINT IF EXISTS pr_lines_capex_asset_check;
ALTER TABLE proc.pr_lines
  ADD CONSTRAINT pr_lines_capex_asset_check
  CHECK (
    (classification IS NULL) OR
    (classification LIKE 'CAPEX_%') OR
    (classification IN ('OPEX_CONSUMABLE', 'OPEX_SERVICE', 'OPEX_MAINT'))
  );

-- ─── 2 · justification on the header ──────────────────────────────────────
-- `description` already exists (added in 020) and carries the free-text
-- business case. This adds the prototype's distinct `justification` field so
-- the two are not conflated on the way to D365.
ALTER TABLE proc.purchase_requisitions ADD COLUMN IF NOT EXISTS justification text;

-- ─── 3 · deriveRouting, computed in the DB ────────────────────────────────
-- Port of the prototype's deriveRouting(pr). Kept server-side so the detail
-- screen, the authority matrix and the eventual D365 payload cannot disagree
-- about a PR's routing key.
CREATE OR REPLACE FUNCTION proc.fn_derive_routing(
  p_capex numeric, p_opex numeric, p_total numeric
) RETURNS TABLE (routing_key text, label text, reason text) AS $$
  SELECT
    CASE
      WHEN p_capex > 10000000                       THEN 'BOARD'
      WHEN p_capex > 0 AND p_opex = 0 AND p_total <= 250000 THEN 'FAST_TRACK'
      WHEN p_capex = 0 AND p_total <= 100000         THEN 'FAST_TRACK'
      ELSE 'STANDARD'
    END,
    CASE
      WHEN p_capex > 10000000                       THEN 'Board approval'
      WHEN p_capex > 0 AND p_opex = 0 AND p_total <= 250000 THEN 'HOD + Procurement only'
      WHEN p_capex = 0 AND p_total <= 100000         THEN 'HOD only'
      ELSE 'HOD → MC → CFO'
    END,
    CASE
      WHEN p_capex > 10000000                       THEN 'Capex > PKR 1 Cr'
      WHEN p_capex > 0 AND p_opex = 0 AND p_total <= 250000 THEN 'Capex ≤ PKR 2.5 L (within HOD delegation)'
      WHEN p_capex = 0 AND p_total <= 100000         THEN 'Opex ≤ PKR 1 L (petty)'
      ELSE 'Standard 5-stage routing'
    END;
$$ LANGUAGE sql IMMUTABLE;

COMMENT ON COLUMN proc.pr_lines.classification IS
  'Per-line Capex/Opex classification. NULL = unclassified; the capital-PR create screen blocks submit until every line has one.';
COMMENT ON COLUMN proc.pr_lines.remarks IS
  'Free-text per-line notes (delivery constraints, justification). Separate from `description`, which is the item description.';
COMMENT ON COLUMN proc.purchase_requisitions.justification IS
  'Business case for the PR. Distinct from `description`, which mirrors the prototype PR detail subtitle.';

COMMIT;
