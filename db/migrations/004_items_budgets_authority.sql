-- 004_items_budgets_authority.sql
-- Phase: 1 — Foundation
-- Purpose: Items, budgets, authority matrix.

BEGIN;

SET LOCAL search_path = core, public;

-- ─── Items / Service master ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core.items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_code             text UNIQUE NOT NULL,
  name                  text NOT NULL,
  category              text NOT NULL,
  uom                   text NOT NULL,
  gl_account            text NOT NULL,
  expense_type          text NOT NULL CHECK (expense_type IN ('CAPEX','OPEX')),
  asset_category        text,
  preferred_vendor_id   uuid REFERENCES core.vendors(id),
  lead_time_days        int NOT NULL DEFAULT 7 CHECK (lead_time_days >= 0),
  active                boolean NOT NULL DEFAULT true,
  deprecated_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT items_asset_category_capex CHECK (
    (expense_type = 'CAPEX' AND asset_category IS NOT NULL)
    OR expense_type = 'OPEX'
  )
);
CREATE INDEX IF NOT EXISTS idx_items_category_active ON core.items(category) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_items_expense_type     ON core.items(expense_type);
CREATE INDEX IF NOT EXISTS idx_items_name_trgm        ON core.items USING GIN (name gin_trgm_ops);

-- ─── Budgets ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core.budgets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fiscal_year       int  NOT NULL,
  department_id     uuid NOT NULL REFERENCES core.departments(id),
  cost_center_id    uuid NOT NULL REFERENCES core.cost_centers(id),
  project_id        uuid REFERENCES core.projects(id),
  expense_type      text NOT NULL CHECK (expense_type IN ('CAPEX','OPEX')),
  allocated_amount  numeric(18,2) NOT NULL CHECK (allocated_amount >= 0),
  reserved_amount   numeric(18,2) NOT NULL DEFAULT 0 CHECK (reserved_amount >= 0),
  spent_amount      numeric(18,2) NOT NULL DEFAULT 0 CHECK (spent_amount >= 0),
  UNIQUE (fiscal_year, cost_center_id, project_id, expense_type)
);
CREATE INDEX IF NOT EXISTS idx_budgets_year_cc ON core.budgets(fiscal_year, cost_center_id);

-- ─── Budget reservations ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core.budget_reservations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id     uuid NOT NULL REFERENCES core.budgets(id),
  pr_id         uuid,                                       -- FK added in 009 once PR table exists
  amount        numeric(18,2) NOT NULL CHECK (amount > 0),
  state         text NOT NULL
                 CHECK (state IN ('Active','Released','Consumed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  released_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_reservations_budget_state ON core.budget_reservations(budget_id, state);
CREATE INDEX IF NOT EXISTS idx_reservations_pr           ON core.budget_reservations(pr_id);

-- ─── Authority matrix ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core.authority_matrix (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  amount_min       numeric(18,2) NOT NULL,
  amount_max       numeric(18,2) NOT NULL,
  category         text,                                       -- NULL = applies to all
  required_roles   text[] NOT NULL,                            -- e.g. {hod,finance,mc}
  active           boolean NOT NULL DEFAULT true,
  effective_from   date NOT NULL,
  CHECK (amount_max > amount_min),
  CHECK (array_length(required_roles, 1) >= 1)
);
CREATE INDEX IF NOT EXISTS idx_authority_amount ON core.authority_matrix(amount_min, amount_max)
  WHERE active = true;

-- A natural key, so the seed below cannot append a second copy of every band on
-- every `db:migrate` run.
--
-- THIS WAS MISSING, AND `ON CONFLICT DO NOTHING` DID NOT PREVENT IT. That clause
-- with no conflict target only suppresses violations of constraints that already
-- exist; the table's only unique constraint was the `id` primary key, and each
-- insert mints a fresh gen_random_uuid(). So the clause could never fire, and the
-- five seed rows were appended again on every single migration run. The live
-- database had reached 85 rows — 17 identical copies of each of the 5 bands —
-- while still looking entirely healthy. Nothing in apps/ read the table, so it
-- was invisible until a read API was built over it.
--
-- `category` is NULL on every seed row ("NULL = applies to all"), and NULLs are
-- distinct in an ordinary UNIQUE index, so a plain column list would still let
-- two NULL-category rows coexist. NULLS NOT DISTINCT (PG 15+) treats them as
-- equal, which is what "one row per band" actually means here.
--
-- Deduplication happens FIRST because the constraint cannot be created while 17
-- identical copies of each band exist. A row is a duplicate if a strictly
-- lower-id row shares its natural key, so the OLDEST copy is the one kept and
-- the original insertion order and timestamps survive.
--
-- Deliberately written with EXISTS rather than min(id): PostgreSQL has no
-- aggregate for uuid, so `min(id)` does not exist and fails at parse time.
-- Nothing references these rows (no foreign key points at the table, and no
-- trigger fires on it), so removing the copies orphans no audit trail.
DELETE FROM core.authority_matrix a
 WHERE EXISTS (
         SELECT 1
           FROM core.authority_matrix b
          WHERE b.amount_min = a.amount_min
            AND b.amount_max = a.amount_max
            AND b.category IS NOT DISTINCT FROM a.category
            AND b.required_roles = a.required_roles
            AND b.effective_from = a.effective_from
            AND b.id < a.id
       );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'authority_matrix_natural_key'
       AND conrelid = 'core.authority_matrix'::regclass
  ) THEN
    ALTER TABLE core.authority_matrix
      ADD CONSTRAINT authority_matrix_natural_key
      UNIQUE NULLS NOT DISTINCT (amount_min, amount_max, category, required_roles, effective_from);
  END IF;
END $$;

-- Seed default amount bands from PRD §11.1
-- NOTE ON SHAPE: these are ONE amount-banded table, not the blueprint's "two
-- Capex/Opex band tables" — `category` is NULL throughout, meaning "applies to
-- all". Any Capex/Opex split is a data-modelling decision that has NOT been made
-- in this schema, and is flagged for W5-C rather than invented here.
INSERT INTO core.authority_matrix (amount_min, amount_max, category, required_roles, effective_from) VALUES
  (      0,      50000, NULL, ARRAY['hod'],                                          date '2026-01-01'),
  (  50000,     250000, NULL, ARRAY['hod','cost_center_owner','finance'],              date '2026-01-01'),
  ( 250000,    1000000, NULL, ARRAY['hod','cost_center_owner','finance','procurement_manager'], date '2026-01-01'),
  (1000000,    5000000, NULL, ARRAY['hod','cost_center_owner','finance','mc'],         date '2026-01-01'),
  (5000000, 9999999999, NULL, ARRAY['hod','cost_center_owner','finance','mc','cfo'],  date '2026-01-01')
ON CONFLICT ON CONSTRAINT authority_matrix_natural_key DO NOTHING;

-- ─── Admin overrides (audit trail for manual authority overrides) ──────────────
CREATE TABLE IF NOT EXISTS core.admin_audit_overrides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id   uuid NOT NULL REFERENCES core.users(id),
  entity          text NOT NULL,
  entity_id       text NOT NULL,
  override_reason text NOT NULL,
  at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_overrides_entity ON core.admin_audit_overrides(entity, entity_id);

COMMIT;
