-- 015_materialized_views.sql
-- Phase: 5 — Insight
-- Purpose: Materialized views for KPI dashboards. Refreshed nightly via cron at 02:30 PKT.

BEGIN;

SET LOCAL search_path = reporting, proc, workflow, core, public;

-- ─── Cycle time (median + p90) ─────────────────────────────────────────────────
DROP MATERIALIZED VIEW IF EXISTS reporting.mv_pr_cycle_time CASCADE;
CREATE MATERIALIZED VIEW reporting.mv_pr_cycle_time AS
SELECT
  date_trunc('day', p.created_at)::date AS day,
  count(*) AS pr_count,
  avg(extract(epoch from (s.last_vote - p.created_at))/86400.0) AS avg_days_to_final,
  percentile_cont(0.5) WITHIN GROUP (
    ORDER BY extract(epoch from (s.last_vote - p.created_at))/86400.0
  ) AS p50_days,
  percentile_cont(0.9) WITHIN GROUP (
    ORDER BY extract(epoch from (s.last_vote - p.created_at))/86400.0
  ) AS p90_days
FROM proc.purchase_requisitions p
JOIN LATERAL (
  SELECT max(voted_at) AS last_vote
  FROM workflow.approval_votes
  WHERE pr_id = p.id AND decision = 'approve'
) s ON true
WHERE p.status = 'Pushed_To_D365'
GROUP BY 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_pr_cycle_time_day
  ON reporting.mv_pr_cycle_time(day);

-- ─── D365 push success (daily, first-try) ──────────────────────────────────────
DROP MATERIALIZED VIEW IF EXISTS reporting.mv_push_success_daily CASCADE;
CREATE MATERIALIZED VIEW reporting.mv_push_success_daily AS
SELECT
  date_trunc('day', started_at)::date AS day,
  count(*) FILTER (WHERE status = 'succeeded' AND attempt_no = 1) AS first_try_ok,
  count(*) AS total,
  CASE WHEN count(*) = 0 THEN NULL
       ELSE (count(*) FILTER (WHERE status = 'succeeded' AND attempt_no = 1)) * 100.0 / count(*)
  END AS first_try_pct
FROM proc.d365_pushes
GROUP BY 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_push_success_day
  ON reporting.mv_push_success_daily(day);

-- ─── Savings (monthly by department) ───────────────────────────────────────────
DROP MATERIALIZED VIEW IF EXISTS reporting.mv_savings_monthly CASCADE;
CREATE MATERIALIZED VIEW reporting.mv_savings_monthly AS
SELECT
  date_trunc('month', sl.computed_at)::date AS month,
  d.code AS department_code,
  d.name AS department_name,
  sum(sl.savings_amount) AS total_savings,
  count(DISTINCT sl.pr_id) AS pr_count
FROM reporting.savings_lines sl
JOIN proc.purchase_requisitions p ON p.id = sl.pr_id
JOIN core.cost_centers cc ON cc.id = p.cost_center_id
JOIN core.departments d ON d.id = cc.department_id
GROUP BY 1, 2, 3;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_savings_monthly
  ON reporting.mv_savings_monthly(month, department_code);

-- ─── Vendor scorecard (quarterly) ──────────────────────────────────────────────
DROP MATERIALIZED VIEW IF EXISTS reporting.mv_vendor_scorecard_quarterly CASCADE;
CREATE MATERIALIZED VIEW reporting.mv_vendor_scorecard_quarterly AS
SELECT
  vsc.quarter,
  v.id AS vendor_id,
  v.vendor_code,
  v.legal_name,
  vsc.score,
  vsc.on_time_pct,
  vsc.reject_pct,
  vsc.avg_response_hours
FROM reporting.vendor_scorecard_history vsc
JOIN core.vendors v ON v.id = vsc.vendor_id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mv_scorecard_quarterly
  ON reporting.mv_vendor_scorecard_quarterly(quarter, vendor_id);

-- ─── Dashboard summary view (live, no refresh) ─────────────────────────────────
CREATE OR REPLACE VIEW reporting.v_pr_dashboard AS
SELECT
  status,
  count(*) AS pr_count,
  sum(estimated_amount) AS total_estimated
FROM proc.purchase_requisitions
WHERE last_updated_at >= now() - interval '30 days'
GROUP BY status;

-- ─── HOD inbox view (live) ─────────────────────────────────────────────────────
CREATE OR REPLACE VIEW reporting.v_pr_queue_hod AS
SELECT p.*
FROM proc.purchase_requisitions p
JOIN core.cost_centers c ON c.id = p.cost_center_id
WHERE p.status = 'Submitted';

-- ─── Warehouse inbox view (live) ───────────────────────────────────────────────
CREATE OR REPLACE VIEW reporting.v_pr_warehouse_inbox AS
SELECT p.id, p.pr_number, p.warehouse_manager_id, u.display_name AS warehouse_manager, p.last_updated_at
FROM proc.purchase_requisitions p
LEFT JOIN core.users u ON u.id = p.warehouse_manager_id
WHERE p.warehouse_check_required = true
  AND p.status NOT IN ('Pushed_To_D365','Cancelled','Rejected');

COMMIT;
