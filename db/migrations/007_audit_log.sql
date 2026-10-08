-- 007_audit_log.sql
-- Phase: 1 — Foundation
-- Purpose: Append-only audit_log. Privilege separation enforced via roles.

BEGIN;

SET LOCAL search_path = audit, public;

CREATE TABLE IF NOT EXISTS audit.audit_log (
  id                bigserial PRIMARY KEY,
  ts                timestamptz NOT NULL DEFAULT now(),
  actor_user_id     uuid,
  entity            text NOT NULL,
  entity_id         text NOT NULL,
  action            text NOT NULL CHECK (action IN (
                       'create','update','delete','approve','reject','return','push','reassign',
                       'login','logout','workflow_config_change','pack_freeze','pack_push',
                       'sod_violation','dead_letter')),
  before            jsonb,
  after             jsonb,
  correlation_id    text,
  ip                inet,
  user_agent        text,
  hash_chain_prev   text,
  hash_chain_self   text
);

CREATE INDEX IF NOT EXISTS idx_audit_ts_entity   ON audit.audit_log(ts DESC, entity);
CREATE INDEX IF NOT EXISTS idx_audit_entity_id   ON audit.audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor_ts    ON audit.audit_log(actor_user_id, ts DESC)
  WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_correlation ON audit.audit_log(correlation_id)
  WHERE correlation_id IS NOT NULL;

-- ─── Privilege hardening: nobody can UPDATE/DELETE/TRUNCATE ───────────────────
REVOKE ALL    ON audit.audit_log FROM PUBLIC;
GRANT  SELECT ON audit.audit_log TO readonly_user, app_user, app_admin;
GRANT  INSERT ON audit.audit_log TO audit_writer, app_admin;

-- Convenience: app_admin can also insert (covers admin actions).
GRANT USAGE ON SEQUENCE audit.audit_log_id_seq TO app_admin, audit_writer;

COMMIT;
