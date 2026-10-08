-- 002_core_identity.sql
-- Phase: 1 — Foundation
-- Purpose: Identity, departments, cost centers, projects, files, feature flags.
--          Foundation for users + role aliasing + RLS targets.

BEGIN;

SET LOCAL search_path = core, public;

-- ─── Departments ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core.departments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text UNIQUE NOT NULL,
  name         text NOT NULL,
  hod_user_id  uuid,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ─── Cost centers ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core.cost_centers (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                        text UNIQUE NOT NULL,
  name                        text NOT NULL,
  department_id               uuid NOT NULL REFERENCES core.departments(id),
  hod_user_id                 uuid,
  cost_center_owner_user_id   uuid,
  active                      boolean NOT NULL DEFAULT true,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cost_centers_department ON core.cost_centers(department_id);

-- ─── Projects ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core.projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text UNIQUE NOT NULL,
  name        text NOT NULL,
  state       text NOT NULL DEFAULT 'active'
                CHECK (state IN ('active','on_hold','closed')),
  start_date  date,
  end_date    date,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ─── Roles lookup (mirror of CHECK in core.users.role) ─────────────────────────
CREATE TABLE IF NOT EXISTS core.roles (
  name         text PRIMARY KEY,
  description  text NOT NULL,
  is_internal  boolean NOT NULL,
  aliases      text[] NOT NULL DEFAULT '{}'::text[]
);

-- Seed role rows
INSERT INTO core.roles (name, description, is_internal, aliases) VALUES
  ('requester',           'Field Requester',                                true,  '{}'),
  ('hod',                 'Head of Department',                             true,  '{}'),
  ('department_manager',  'Department Manager',                            true,  '{}'),
  ('procurement',         'Procurement Officer',                            true,  '{}'),
  ('cs',                  'Customer Service / Pack Officer',                true,  '{}'),
  ('procurement_manager', 'Procurement Manager',                            true,  '{}'),
  ('cost_center_owner',   'Cost-Center Owner',                              true,  '{}'),
  ('finance',             'Finance Officer',                                true,  '{}'),
  ('management',          'Management',                                     true,  '{}'),
  ('mc',                  'Management Committee',                           true,  '{}'),
  ('cfo',                 'CFO',                                            true,  '{}'),
  ('audit',               'Audit',                                          true,  '{}'),
  ('hr',                  'HR',                                             true,  '{}'),
  ('store_incharge',      'Store / Warehouse In-charge',                    true,  '{}'),
  ('warehouse_manager',   'Warehouse Manager',                              true,  '{}'),
  ('vendor',              'Supplier Portal User',                           false, '{}'),
  ('public',              'Anonymous public vendor onboarding applicant',   false, '{}'),
  ('admin',               'Super-role alias; see ROLE_ALIASES',             true,
                          ARRAY['cs','procurement','cfo','hod','finance','management','mc','warehouse_manager'])
ON CONFLICT (name) DO NOTHING;

-- ─── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core.users (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  azure_oid                   text,
  email                       citext UNIQUE NOT NULL,
  display_name                text NOT NULL,
  role                        text NOT NULL,
  cost_center_ids             uuid[] NOT NULL DEFAULT '{}',
  mfa_enabled                 boolean NOT NULL DEFAULT false,
  supplier_password_hash      text,
  supplier_otp_secret         text,
  supplier_locked_until       timestamptz,
  last_login_at               timestamptz,
  active                      boolean NOT NULL DEFAULT true,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_role_check CHECK (
    role IN ('requester','hod','department_manager','procurement','cs','procurement_manager',
             'cost_center_owner','finance','management','mc','cfo','audit','hr',
             'store_incharge','warehouse_manager','vendor','public','admin')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_azure_oid
  ON core.users (azure_oid) WHERE azure_oid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_role ON core.users(role) WHERE active = true;

-- FK backfill: departments.hod_user_id and cost_centers FKs to users(id).
ALTER TABLE core.departments
  DROP CONSTRAINT IF EXISTS departments_hod_fk,
  ADD  CONSTRAINT departments_hod_fk FOREIGN KEY (hod_user_id) REFERENCES core.users(id);

ALTER TABLE core.cost_centers
  DROP CONSTRAINT IF EXISTS cost_centers_hod_fk,
  ADD  CONSTRAINT cost_centers_hod_fk FOREIGN KEY (hod_user_id) REFERENCES core.users(id);
ALTER TABLE core.cost_centers
  DROP CONSTRAINT IF EXISTS cost_centers_owner_fk,
  ADD  CONSTRAINT cost_centers_owner_fk FOREIGN KEY (cost_center_owner_user_id) REFERENCES core.users(id);

-- ─── Delegations ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core.delegations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delegator_user_id  uuid NOT NULL REFERENCES core.users(id),
  delegate_user_id   uuid NOT NULL REFERENCES core.users(id),
  scope              text NOT NULL
                       CHECK (scope IN ('approval','vendor_review','finance_review','all')),
  starts_at          timestamptz NOT NULL,
  ends_at            timestamptz NOT NULL,
  reason             text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (delegator_user_id <> delegate_user_id)
);
-- NOTE: a predicate `WHERE ends_at > now()` is not allowed because `now()` is
-- STABLE, not IMMUTABLE. Plain index is fine — "active" filtering is a runtime
-- concern handled by queries using `ends_at > now()`.
CREATE INDEX IF NOT EXISTS idx_delegations_active ON core.delegations(delegate_user_id, ends_at);

-- ─── Files (MinIO metadata mirror) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core.files (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket                   text NOT NULL,
  object_key               text NOT NULL,
  content_type             text NOT NULL,
  size_bytes               bigint NOT NULL CHECK (size_bytes >= 0),
  sha256                   text NOT NULL,
  uploaded_by_user_id      uuid REFERENCES core.users(id),
  uploaded_at              timestamptz NOT NULL DEFAULT now(),
  version                  int  NOT NULL DEFAULT 1,
  superseded_by_file_id    uuid REFERENCES core.files(id),
  UNIQUE (bucket, object_key, version)
);
CREATE INDEX IF NOT EXISTS idx_files_sha ON core.files(sha256);

-- ─── Feature flags ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core.feature_flags (
  key          text PRIMARY KEY,
  enabled      boolean NOT NULL DEFAULT false,
  rollout_pct  int     NOT NULL DEFAULT 0 CHECK (rollout_pct BETWEEN 0 AND 100),
  description  text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO core.feature_flags (key, enabled, rollout_pct, description) VALUES
  ('FF_D365_PUSH',             true, 100, 'Enable D365 OData push'),
  ('FF_WHATSAPP',              false, 0,   'Enable WhatsApp notifications for urgent/deviation/force-majeure'),
  ('FF_PUBLIC_VENDOR_ONBOARD', true, 100, 'Enable anonymous public vendor onboarding form'),
  ('FF_LINE_RULES',            true, 100, 'Enable per-line routing rules + auto-split'),
  ('FF_MERMAID_PANEL',         true, 100, 'Enable live Mermaid workflow diagram in Admin > Workflow Config')
ON CONFLICT (key) DO NOTHING;

-- ─── FX rates (currency normalization for quotations) ──────────────────────────
CREATE TABLE IF NOT EXISTS core.fx_rates (
  currency        text NOT NULL,
  effective_date  date NOT NULL,
  rate_to_pkr     numeric(18,6) NOT NULL CHECK (rate_to_pkr > 0),
  source          text,
  PRIMARY KEY (currency, effective_date)
);
CREATE INDEX IF NOT EXISTS idx_fx_rates_date ON core.fx_rates(effective_date DESC);

-- Seed a few FX rates (PKR = 1 baseline).
INSERT INTO core.fx_rates (currency, effective_date, rate_to_pkr, source) VALUES
  ('PKR', current_date,            1.000000, 'seed'),
  ('USD', current_date,          280.000000, 'seed'),
  ('EUR', current_date,          305.000000, 'seed'),
  ('GBP', current_date,          355.000000, 'seed'),
  ('AED', current_date,           76.250000, 'seed')
ON CONFLICT (currency, effective_date) DO NOTHING;

COMMIT;
