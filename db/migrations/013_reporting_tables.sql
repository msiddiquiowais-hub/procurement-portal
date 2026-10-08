-- 013_reporting_tables.sql
-- Phase: 5 — Insight
-- Purpose: KPI targets + daily rollup, savings lines, vendor scorecard history.

BEGIN;

SET LOCAL search_path = reporting, proc, core, public;

CREATE TABLE IF NOT EXISTS reporting.kpi_targets (
  kpi_key         text PRIMARY KEY,
  target_value    numeric(18,4) NOT NULL,
  unit            text NOT NULL,
  updated_by_user_id uuid REFERENCES core.users(id),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reporting.kpi_daily (
  kpi_key       text NOT NULL,
  day           date   NOT NULL,
  actual_value  numeric(18,4) NOT NULL,
  sample_count  int    NOT NULL CHECK (sample_count >= 0),
  PRIMARY KEY (kpi_key, day)
);
CREATE INDEX IF NOT EXISTS idx_kpi_daily_day ON reporting.kpi_daily(day DESC);

CREATE TABLE IF NOT EXISTS reporting.savings_lines (
  pr_id                    uuid NOT NULL REFERENCES proc.purchase_requisitions(id),
  line_no                  int  NOT NULL,
  quoted_avg_unit_price    numeric(18,2) NOT NULL CHECK (quoted_avg_unit_price >= 0),
  final_unit_price         numeric(18,2) NOT NULL CHECK (final_unit_price      >= 0),
  quantity                 numeric(18,3) NOT NULL CHECK (quantity              >  0),
  savings_amount           numeric(18,2) NOT NULL,                                  -- (quoted_avg - final) * qty
  computed_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pr_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_savings_computed ON reporting.savings_lines(computed_at DESC);

CREATE TABLE IF NOT EXISTS reporting.vendor_scorecard_history (
  vendor_id            uuid NOT NULL REFERENCES core.vendors(id),
  quarter              text NOT NULL CHECK (quarter ~ '^\d{4}-Q[1-4]$'),
  score                numeric(5,2) NOT NULL CHECK (score BETWEEN 0 AND 100),
  on_time_pct          numeric(5,2) NOT NULL CHECK (on_time_pct BETWEEN 0 AND 100),
  reject_pct           numeric(5,2) NOT NULL CHECK (reject_pct  BETWEEN 0 AND 100),
  avg_response_hours   numeric(8,2) NOT NULL CHECK (avg_response_hours >= 0),
  PRIMARY KEY (vendor_id, quarter)
);
CREATE INDEX IF NOT EXISTS idx_scorecard_quarter ON reporting.vendor_scorecard_history(quarter);

-- Seed KPI targets
INSERT INTO reporting.kpi_targets (kpi_key, target_value, unit) VALUES
  ('cycle_time_median_days',         5,    'days'),
  ('cycle_time_p90_days',            10,   'days'),
  ('d365_push_first_try_pct',        95,   'percent'),
  ('sla_breach_pct',                 5,    'percent'),
  ('vendor_onboarding_days',         5,    'days'),
  ('user_adoption_pct',              85,   'percent')
ON CONFLICT (kpi_key) DO NOTHING;

COMMIT;
