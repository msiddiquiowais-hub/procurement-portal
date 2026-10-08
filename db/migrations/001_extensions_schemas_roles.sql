-- 001_extensions_schemas_roles.sql
-- Phase: 1 — Foundation
-- Purpose: Enable required extensions, create schemas and DB roles.

BEGIN;

-- ─── Extensions ────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;       -- case-insensitive email
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- fuzzy search
CREATE EXTENSION IF NOT EXISTS btree_gin;     -- GIN over scalar types
-- GiST over scalar types. Needed by the DEFERRABLE partial EXCLUDE constraint in
-- migration 033 (attachment "at most one ACTIVE per parent+name"), which cannot be
-- expressed as a partial UNIQUE index because a UNIQUE index is always IMMEDIATE
-- and would make the Replace lifecycle impossible. See 033's header.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ─── Schemas ───────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS core;       -- identity, vendors, items, budgets, authority, flags, notifications
CREATE SCHEMA IF NOT EXISTS proc;       -- PR, RFQ, quotations, CS, packs, pushes
CREATE SCHEMA IF NOT EXISTS workflow;   -- approval chain, votes, workflow config
CREATE SCHEMA IF NOT EXISTS audit;      -- append-only audit_log
CREATE SCHEMA IF NOT EXISTS reporting;  -- KPI, savings, vendor scorecard

-- ─── Roles ─────────────────────────────────────────────────────────────────────
-- Application roles are created NOLOGIN; the backend service connects with a
-- dedicated login role that is granted these.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN
    CREATE ROLE app_admin NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_writer') THEN
    CREATE ROLE audit_writer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'readonly_user') THEN
    CREATE ROLE readonly_user NOLOGIN;
  END IF;
END$$;

-- Default privileges so future tables inherit sensible perms.
ALTER DEFAULT PRIVILEGES IN SCHEMA core       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA proc       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA workflow   GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA reporting  GRANT SELECT                     ON TABLES TO readonly_user;

GRANT USAGE ON SCHEMA core, proc, workflow, reporting, audit TO app_user, app_admin, readonly_user;

COMMIT;
