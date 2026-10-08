-- 011_proc_cs.sql
-- Phase: 2 — Sourcing + Approvals
-- Purpose: Comparative Statement + scoring lines.

BEGIN;

SET LOCAL search_path = proc, core, public;

CREATE SEQUENCE IF NOT EXISTS proc.cs_number_seq START 100000;

CREATE TABLE IF NOT EXISTS proc.comparative_statements (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cs_number            text UNIQUE NOT NULL,                                -- CS-YYYY-NNNNN
  pr_id                uuid NOT NULL UNIQUE REFERENCES proc.purchase_requisitions(id),
  generated_at         timestamptz NOT NULL DEFAULT now(),
  generated_by_user_id uuid NOT NULL REFERENCES core.users(id),
  locked_at            timestamptz,
  locked_by_user_id    uuid REFERENCES core.users(id),
  recommendation       jsonb,                                                -- {vendor_id, total, reason}
  scores               jsonb NOT NULL DEFAULT '{}'::jsonb,
  weights              jsonb NOT NULL DEFAULT '{"commercial":0.6,"technical":0.3,"warranty":0.1}'::jsonb,
  override_reason      text,
  CONSTRAINT cs_weights_object CHECK (jsonb_typeof(weights) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_cs_locked ON proc.comparative_statements(locked_at);

CREATE TABLE IF NOT EXISTS proc.cs_lines (
  cs_id              uuid NOT NULL REFERENCES proc.comparative_statements(id) ON DELETE CASCADE,
  vendor_id          uuid NOT NULL REFERENCES core.vendors(id),
  commercial_score   numeric(5,2) NOT NULL CHECK (commercial_score BETWEEN 0 AND 100),
  technical_score    numeric(5,2) NOT NULL CHECK (technical_score  BETWEEN 0 AND 100),
  warranty_score     numeric(5,2) NOT NULL CHECK (warranty_score   BETWEEN 0 AND 100),
  weighted_score     numeric(5,2) NOT NULL CHECK (weighted_score   BETWEEN 0 AND 100),
  rank               int  NOT NULL CHECK (rank >= 1),
  PRIMARY KEY (cs_id, vendor_id)
);

CREATE OR REPLACE FUNCTION proc.fn_next_cs_number() RETURNS text AS $$
DECLARE yr int := extract(year from now());
BEGIN
  RETURN 'CS-' || yr || '-' || lpad(nextval('proc.cs_number_seq')::text, 5, '0');
END;
$$ LANGUAGE plpgsql VOLATILE;

COMMIT;
