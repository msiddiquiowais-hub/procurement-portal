-- 009_workflow_votes_escalations.sql
-- Phase: 2 — Sourcing + Approvals
-- Purpose: approval_votes (per-step vote ledger), MC parallel sessions, escalations.

BEGIN;

SET LOCAL search_path = workflow, core, public;

CREATE TABLE IF NOT EXISTS workflow.approval_votes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_id           uuid NOT NULL REFERENCES proc.purchase_requisitions(id),
  step_id         text NOT NULL REFERENCES workflow.steps_config(id),
  voter_user_id   uuid NOT NULL REFERENCES core.users(id),
  decision        text NOT NULL CHECK (decision IN ('approve','reject','return','abstain')),
  reason          text,
  voted_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pr_id, step_id, voter_user_id)
);
CREATE INDEX IF NOT EXISTS idx_votes_pr_step ON workflow.approval_votes(pr_id, step_id);
CREATE INDEX IF NOT EXISTS idx_votes_voter    ON workflow.approval_votes(voter_user_id, voted_at DESC);

CREATE TABLE IF NOT EXISTS workflow.mc_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_id           uuid NOT NULL REFERENCES proc.purchase_requisitions(id),
  opened_at       timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz,
  outcome         text CHECK (outcome IN ('approved','rejected','tie','pending')),
  chair_user_id   uuid REFERENCES core.users(id)
);
CREATE INDEX IF NOT EXISTS idx_mc_pr ON workflow.mc_sessions(pr_id);

CREATE TABLE IF NOT EXISTS workflow.escalations (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_id                       uuid NOT NULL REFERENCES proc.purchase_requisitions(id),
  step_id                     text NOT NULL,
  triggered_at                timestamptz NOT NULL DEFAULT now(),
  escalation_target_user_id   uuid REFERENCES core.users(id),
  reason                      text NOT NULL CHECK (reason IN ('sla_80','sla_100'))
);
CREATE INDEX IF NOT EXISTS idx_escalations_pr ON workflow.escalations(pr_id, triggered_at DESC);

COMMIT;
