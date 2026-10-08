-- 014_rls_audit_triggers.sql
-- Phase: 1 — Foundation (defense-in-depth)
-- Purpose: Row-Level Security on PR, audit-emit trigger, session-config helpers,
--          budget reservation consistency trigger.

BEGIN;

SET LOCAL search_path = core, proc, audit, public;

-- ─── Session-config helpers (set by backend per request) ───────────────────────
-- app.current_user_id   — uuid of the caller
-- app.user_cost_centers — uuid[] of cost-centers the caller is bound to
-- app.user_role         — text role
-- app.correlation_id    — text correlation id
-- app.bypass_rls        — 'true' to bypass RLS for service/admin operations
CREATE OR REPLACE FUNCTION core.fn_current_user_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION core.fn_current_user_role() RETURNS text AS $$
  SELECT NULLIF(current_setting('app.user_role', true), '');
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION core.fn_bypass_rls() RETURNS boolean AS $$
  SELECT COALESCE(NULLIF(current_setting('app.bypass_rls', true), ''), 'false') = 'true';
$$ LANGUAGE sql STABLE;

-- ─── Enable + FORCE RLS on PR (defense in depth) ──────────────────────────────
ALTER TABLE proc.purchase_requisitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE proc.purchase_requisitions FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS prs_visibility ON proc.purchase_requisitions;
CREATE POLICY prs_visibility ON proc.purchase_requisitions
  FOR SELECT
  USING (
    core.fn_bypass_rls()
    OR requester_user_id = core.fn_current_user_id()
    OR cost_center_id = ANY (
         string_to_array(NULLIF(current_setting('app.user_cost_centers', true), ''), ',')::uuid[]
       )
    OR core.fn_current_user_role() IN ('admin','procurement','cs','finance','cfo','mc','audit','hr','procurement_manager')
  );

DROP POLICY IF EXISTS prs_modify_self ON proc.purchase_requisitions;
CREATE POLICY prs_modify_self ON proc.purchase_requisitions
  FOR UPDATE
  USING (
    core.fn_bypass_rls()
    OR (status = 'Draft' AND requester_user_id = core.fn_current_user_id())
  )
  WITH CHECK (
    core.fn_bypass_rls()
    OR requester_user_id = core.fn_current_user_id()
  );

-- ─── Audit-emit trigger (skeleton; production would filter sensitive columns) ──
-- Domain tables that have an `id uuid` column and want audit emission can
-- `CREATE TRIGGER ... EXECUTE FUNCTION audit.fn_emit_audit()` on them.
-- Sensitive tables (users.password, vendor.bank) should redact before insert.

CREATE OR REPLACE FUNCTION audit.fn_emit_audit() RETURNS trigger AS $$
DECLARE
  v_entity_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_entity_id := COALESCE((OLD.id)::text, '');
    INSERT INTO audit.audit_log (actor_user_id, entity, entity_id, action, before, after, correlation_id)
    VALUES (
      core.fn_current_user_id(),
      TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
      v_entity_id,
      'delete',
      to_jsonb(OLD),
      NULL,
      NULLIF(current_setting('app.correlation_id', true), '')
    );
    RETURN OLD;
  ELSE
    v_entity_id := COALESCE((NEW.id)::text, '');
    INSERT INTO audit.audit_log (actor_user_id, entity, entity_id, action, before, after, correlation_id)
    VALUES (
      core.fn_current_user_id(),
      TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
      v_entity_id,
      -- Normalize: audit vocabulary uses 'create' instead of 'insert'
      -- (matches audit_log_action_check allowed values).
      CASE lower(TG_OP) WHEN 'insert' THEN 'create' ELSE lower(TG_OP) END,
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
      CASE WHEN TG_OP = 'INSERT' THEN to_jsonb(NEW) ELSE to_jsonb(NEW) END,
      NULLIF(current_setting('app.correlation_id', true), '')
    );
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Example wiring: emit audit on vendor and PR-line tables.
-- (Comment out for high-volume write paths where application-layer emission is preferred.)
DROP TRIGGER IF EXISTS trg_vendors_audit ON core.vendors;
CREATE TRIGGER trg_vendors_audit
AFTER INSERT OR UPDATE OR DELETE ON core.vendors
FOR EACH ROW EXECUTE FUNCTION audit.fn_emit_audit();

DROP TRIGGER IF EXISTS trg_prs_audit ON proc.purchase_requisitions;
CREATE TRIGGER trg_prs_audit
AFTER INSERT OR UPDATE OR DELETE ON proc.purchase_requisitions
FOR EACH ROW EXECUTE FUNCTION audit.fn_emit_audit();

DROP TRIGGER IF EXISTS trg_votes_audit ON workflow.approval_votes;
CREATE TRIGGER trg_votes_audit
AFTER INSERT ON workflow.approval_votes
FOR EACH ROW EXECUTE FUNCTION audit.fn_emit_audit();

-- ─── Budget reservation consistency ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION core.fn_update_budget_reserved() RETURNS trigger AS $$
BEGIN
  IF NEW.state = 'Active' AND OLD.state IS DISTINCT FROM 'Active' THEN
    UPDATE core.budgets
       SET reserved_amount = reserved_amount + NEW.amount
     WHERE id = NEW.budget_id;
  ELSIF NEW.state IN ('Released','Consumed') AND OLD.state = 'Active' THEN
    UPDATE core.budgets
       SET reserved_amount = reserved_amount - NEW.amount
     WHERE id = NEW.budget_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reservations_state ON core.budget_reservations;
CREATE TRIGGER trg_reservations_state
AFTER UPDATE OF state ON core.budget_reservations
FOR EACH ROW EXECUTE FUNCTION core.fn_update_budget_reserved();

COMMIT;
