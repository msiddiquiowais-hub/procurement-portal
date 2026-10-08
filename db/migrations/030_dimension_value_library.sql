-- 030_dimension_value_library.sql
-- Phase: Wave 5 — Track A (Foundations)
-- Purpose: give the D365 financial dimensions a real value library, and the HOD
--          directory a real home, in the database.
--
-- WHY THIS MIGRATION EXISTS
-- ------------------------
-- `packages/d365-client/src/index.ts` exports D365_DIMENSIONS — the nine
-- dimension DEFINITIONS (key, label, apiName, mandatory, desc). Nothing anywhere
-- exported the VALUES. The prototype seeds 40 concrete values
-- (PROCUREMENT_PORTAL_PROTOTYPE.html:1231-1304, D365_DIMENSION_LIBRARY_SEED) and
-- the admin-dimensions screen is specified to render "9 tables, one per
-- dimension, each showing `{n} values`". With no value library the dimension
-- pickers on pr-create have nothing to offer, and the admin screen has nothing
-- to show — the gap analysis records this as #24, HIGH.
--
-- The HOD directory (prototype `_HOD_DIRECTORY`, six departments) is seeded here
-- too. It is the source `prSyncDeptApprovers()` uses to suggest one dept_head per
-- unique Department across a PR's lines, and it is the reference the
-- "departments still needing a dept_head" warning counts against. The
-- `pr_departments.suggested` column already exists (migration 020); the
-- directory it is meant to be derived from did not.
--
-- ── A PROTOTYPE DEFECT DELIBERATELY PRESERVED, NOT REPRODUCED ──────────────
-- Four dimensions (Location, Project, Worker, Customer) seed a FIRST row whose
-- `code` is the empty string, labelled "(unspecified — remote/HO)",
-- "(no project)", "(unassigned)", "(no external customer)". The blueprint
-- (Part 4, note after the seeded library) flags that `lineMissingDims()` tests
-- for a non-empty trimmed value, so selecting "unspecified" still reads as
-- MISSING — an option that can be chosen and can never satisfy its own
-- validator.
--
-- These rows are seeded (they are real prototype content, and dropping them
-- would change what admin-dimensions renders) but tagged is_placeholder = true so
-- the W5-C screen can show them distinctly. They are NOT used to satisfy
-- validation anywhere in this migration. The rows are kept; the trap is made
-- visible rather than silently repeated.
--
-- Idempotency: every insert is ON CONFLICT DO NOTHING keyed on the natural key,
-- so a re-run never clobbers an admin edit made through the W5-C screen.

BEGIN;

SET LOCAL search_path = core, public;

-- ─── 1. The nine dimension DEFINITIONS ─────────────────────────────────────
-- Mirrors D365_DIMENSIONS in packages/d365-client. Denormalised deliberately:
-- the admin screen has to render the label, the D365 api name and the
-- MANDATORY/OPTIONAL tag, and a hardcoded UI list would be exactly the
-- "table the application ignores" failure that Part 7 already suffered once.

CREATE TABLE IF NOT EXISTS core.dimensions (
  key         text PRIMARY KEY,
  label       text NOT NULL,
  api_name    text NOT NULL,
  mandatory   boolean NOT NULL DEFAULT false,
  description text,
  sort_order  int NOT NULL DEFAULT 0,
  CONSTRAINT dimensions_key_not_blank CHECK (btrim(key) <> '')
);

INSERT INTO core.dimensions (key, label, api_name, mandatory, description, sort_order) VALUES
  ('BusinessUnit', 'Business Unit', 'BusinessUnit', true,  'Legal entity / business unit the purchase belongs to.', 1),
  ('Department',   'Department',    'Department',   true,  'Owning department — drives approval routing and reporting.', 2),
  ('CostCenter',   'Cost Center',   'CostCenter',   true,  'Cost center code that absorbs the expense (Capex) or charge (Opex).', 3),
  ('Location',     'Location',      'Location',     true,  'Physical site / warehouse / office where the item will be received and used.', 4),
  ('Project',      'Project',       'Project',      false, 'Internal project / WBS element the purchase is tied to (blank if N/A).', 5),
  ('Worker',       'Worker',        'Worker',       false, 'Employee / worker tag — for HR-cost-attribution workflows.', 6),
  ('ItemGroup',    'Item Group',    'ItemGroup',    false, 'Procurement category that maps to GL / vendor selection.', 7),
  ('Customer',     'Customer',      'Customer',     false, 'If the purchase is for a specific external customer (project work).', 8),
  ('Vendor',       'Vendor',        'Vendor',       false, 'Suggested vendor dimension (overrides default vendor on the PO line).', 9)
ON CONFLICT (key) DO NOTHING;

-- ─── 2. The value library ──────────────────────────────────────────────────
-- code is NOT unique-constrained to be non-empty: the prototype's placeholder
-- rows use '' deliberately (see the header note). surrogate id + a natural
-- unique on (dimension_key, code) keeps those rows expressible.

CREATE TABLE IF NOT EXISTS core.dimension_values (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dimension_key text NOT NULL REFERENCES core.dimensions(key) ON DELETE CASCADE,
  code          text NOT NULL DEFAULT '',
  name          text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  is_placeholder boolean NOT NULL DEFAULT false,
  sort_order    int NOT NULL DEFAULT 0,
  CONSTRAINT dimension_values_unique UNIQUE (dimension_key, code),
  CONSTRAINT dimension_values_name_not_blank CHECK (btrim(name) <> '')
);

CREATE INDEX IF NOT EXISTS idx_dimension_values_lookup
  ON core.dimension_values (dimension_key, active, sort_order);

-- BusinessUnit (4)
INSERT INTO core.dimension_values (dimension_key, code, name, sort_order) VALUES
  ('BusinessUnit', 'BU-LHR', 'Lahore Operations', 1),
  ('BusinessUnit', 'BU-KHI', 'Karachi Operations', 2),
  ('BusinessUnit', 'BU-ISB', 'Islamabad Operations', 3),
  ('BusinessUnit', 'BU-HQ',  'Corporate HQ', 4)
ON CONFLICT (dimension_key, code) DO NOTHING;

-- Department (6)
INSERT INTO core.dimension_values (dimension_key, code, name, sort_order) VALUES
  ('Department', 'DEP-IT',    'IT Department', 1),
  ('Department', 'DEP-FIN',   'Finance', 2),
  ('Department', 'DEP-HR',    'Human Resources', 3),
  ('Department', 'DEP-OPS',   'Operations', 4),
  ('Department', 'DEP-SALES', 'Sales', 5),
  ('Department', 'DEP-MKT',   'Marketing', 6)
ON CONFLICT (dimension_key, code) DO NOTHING;

-- CostCenter (5)
INSERT INTO core.dimension_values (dimension_key, code, name, sort_order) VALUES
  ('CostCenter', 'CC-IT-001',  'IT Infrastructure', 1),
  ('CostCenter', 'CC-IT-002',  'IT End-User Computing', 2),
  ('CostCenter', 'CC-FIN-001', 'Finance Operations', 3),
  ('CostCenter', 'CC-OPS-001', 'Plant Operations', 4),
  ('CostCenter', 'CC-HQ-001',  'Corporate Admin', 5)
ON CONFLICT (dimension_key, code) DO NOTHING;

-- Location (7 — first row is the prototype's empty-code placeholder)
INSERT INTO core.dimension_values (dimension_key, code, name, is_placeholder, sort_order) VALUES
  ('Location', '',            '(unspecified — remote/HO)',  true, 1),
  ('Location', 'LOC-LHR-HQ',  'Lahore HQ — Main Office',    false, 2),
  ('Location', 'LOC-LHR-F3',  'Lahore HQ — Floor 3 (IT)',  false, 3),
  ('Location', 'LOC-KHI-OFC', 'Karachi Regional Office',    false, 4),
  ('Location', 'LOC-KHI-PLT', 'Karachi Plant — Warehouse',  false, 5),
  ('Location', 'LOC-ISB-HQ',  'Islamabad Regional Office',  false, 6),
  ('Location', 'LOC-REMOTE',  'Remote / Work-from-home',    false, 7)
ON CONFLICT (dimension_key, code) DO NOTHING;

-- Project (4 — first row is a placeholder)
INSERT INTO core.dimension_values (dimension_key, code, name, is_placeholder, sort_order) VALUES
  ('Project', '',            '(no project)', true, 1),
  ('Project', 'PRJ-2026-118', 'FY26 ERP Rollout', false, 2),
  ('Project', 'PRJ-2026-119', 'FY26 Warehouse Expansion', false, 3),
  ('Project', 'PRJ-2026-120', 'FY26 Mobile App v2', false, 4)
ON CONFLICT (dimension_key, code) DO NOTHING;

-- Worker (4 — first row is a placeholder)
INSERT INTO core.dimension_values (dimension_key, code, name, is_placeholder, sort_order) VALUES
  ('Worker', '',          '(unassigned)', true, 1),
  ('Worker', 'EMP-1023',  'Owais Siddiqui', false, 2),
  ('Worker', 'EMP-1118',  'Aamir Hussain',  false, 3),
  ('Worker', 'EMP-1234',  'Saad Iqbal',     false, 4)
ON CONFLICT (dimension_key, code) DO NOTHING;

-- ItemGroup (4)
INSERT INTO core.dimension_values (dimension_key, code, name, sort_order) VALUES
  ('ItemGroup', 'IG-LAPTOP', 'Laptops & PCs', 1),
  ('ItemGroup', 'IG-ACC',    'IT Accessories', 2),
  ('ItemGroup', 'IG-OFC',    'Office Supplies', 3),
  ('ItemGroup', 'IG-SVC',    'Professional Services', 4)
ON CONFLICT (dimension_key, code) DO NOTHING;

-- Customer (3 — first row is a placeholder)
INSERT INTO core.dimension_values (dimension_key, code, name, is_placeholder, sort_order) VALUES
  ('Customer', '',          '(no external customer)', true, 1),
  ('Customer', 'CUST-0042', 'Atlas Logistics', false, 2),
  ('Customer', 'CUST-0117', 'Beacon Trading Co.', false, 3)
ON CONFLICT (dimension_key, code) DO NOTHING;

-- Vendor (3)
INSERT INTO core.dimension_values (dimension_key, code, name, sort_order) VALUES
  ('Vendor', 'V-000123', 'PakBoxes Pvt Ltd', 1),
  ('Vendor', 'V-000088', 'KarachiTech Supplies', 2),
  ('Vendor', 'V-000201', 'Indus Office Solutions', 3)
ON CONFLICT (dimension_key, code) DO NOTHING;

-- ─── 3. HOD directory ──────────────────────────────────────────────────────
-- Six departments, one Head of Department each. department_code is the FK
-- target for pr_departments and for the dept_head suggestion logic.

CREATE TABLE IF NOT EXISTS core.hod_directory (
  department_code text PRIMARY KEY,
  name            text NOT NULL,
  email           text NOT NULL,
  active          boolean NOT NULL DEFAULT true,
  CONSTRAINT hod_directory_email_not_blank CHECK (btrim(email) <> ''),
  CONSTRAINT hod_directory_email_shape CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

INSERT INTO core.hod_directory (department_code, name, email) VALUES
  ('DEP-IT',    'Aamir Hussain (HOD IT)',   'aamir.hussain@pakboxes.pk'),
  ('DEP-FIN',   'Adeel Khan (HOD Finance)', 'adeel.khan@pakboxes.pk'),
  ('DEP-HR',    'Asma Tariq (HOD HR)',      'asma.tariq@pakboxes.pk'),
  ('DEP-OPS',   'Faisal Mehmood (HOD Ops)', 'faisal.mehmood@pakboxes.pk'),
  ('DEP-SALES', 'Hina Rashid (HOD Sales)',  'hina.rashid@pakboxes.pk'),
  ('DEP-MKT',   'Junaid Akhtar (HOD Mkt)',  'junaid.akhtar@pakboxes.pk')
ON CONFLICT (department_code) DO NOTHING;

-- ─── Post-condition check (inside the transaction, so a failure rolls back) ─
-- A migration that cannot prove its own effect is a migration nobody should
-- trust. These assert the counts the prototype actually ships, and that every
-- seeded department has a HOD — because a Department value with no dept_head is
-- precisely the "no HOD seeded" case the submit gate blocks on.

DO $$
DECLARE
  n_dims        int;
  n_values      int;
  n_placeholders int;
  n_hods        int;
  orphan_dims   int;
  hodless_depts int;
BEGIN
  SELECT count(*) INTO n_dims FROM core.dimensions;
  IF n_dims <> 9 THEN
    RAISE EXCEPTION 'migration 030: expected 9 dimension definitions, found %', n_dims;
  END IF;

  SELECT count(*) INTO n_values FROM core.dimension_values;
  IF n_values <> 40 THEN
    RAISE EXCEPTION 'migration 030: expected 40 dimension values, found %', n_values;
  END IF;

  SELECT count(*) INTO n_placeholders FROM core.dimension_values WHERE is_placeholder;
  IF n_placeholders <> 4 THEN
    RAISE EXCEPTION 'migration 030: expected 4 prototype placeholder rows, found %', n_placeholders;
  END IF;

  SELECT count(*) INTO n_hods FROM core.hod_directory;
  IF n_hods <> 6 THEN
    RAISE EXCEPTION 'migration 030: expected 6 HOD directory rows, found %', n_hods;
  END IF;

  -- Every seeded value must hang off a real dimension (FK would catch it, but
  -- naming it here makes the failure legible rather than deferred to DML).
  SELECT count(*) INTO orphan_dims
    FROM core.dimension_values v
   WHERE NOT EXISTS (SELECT 1 FROM core.dimensions d WHERE d.key = v.dimension_key);
  IF orphan_dims > 0 THEN
    RAISE EXCEPTION 'migration 030: % dimension value(s) reference an unknown dimension', orphan_dims;
  END IF;

  -- Every Department value must have a HOD, or PR submit is blocked for it.
  SELECT count(*) INTO hodless_depts
    FROM core.dimension_values v
   WHERE v.dimension_key = 'Department'
     AND v.code <> ''
     AND NOT EXISTS (SELECT 1 FROM core.hod_directory h WHERE h.department_code = v.code);
  IF hodless_depts > 0 THEN
    RAISE EXCEPTION 'migration 030: % department(s) have no HOD; submit would block on them', hodless_depts;
  END IF;

  RAISE NOTICE 'migration 030 verified — 9 dimensions, 40 values (4 placeholders), 6 HODs, every department has a HOD';
END $$;

COMMIT;
