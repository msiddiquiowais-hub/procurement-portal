-- 003_vendors.sql
-- Phase: 1 — Foundation
-- Purpose: Vendor master, vendor documents, due diligence, blacklist, performance scorecard.

BEGIN;

SET LOCAL search_path = core, public;

-- ─── Vendors ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core.vendors (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_code                     text UNIQUE NOT NULL,
  legal_name                      text NOT NULL,
  ntn                             text NOT NULL,
  strn                            text,
  bank_account_iban               text,
  bank_account_verified_at        timestamptz,
  bank_account_verified_by_user_id uuid REFERENCES core.users(id),
  address                         jsonb NOT NULL DEFAULT '{}'::jsonb,
  contacts                        jsonb NOT NULL DEFAULT '[]'::jsonb,
  risk_score                      numeric(5,2) CHECK (risk_score IS NULL OR (risk_score >= 0 AND risk_score <= 100)),
  scorecard                       jsonb NOT NULL DEFAULT '{}'::jsonb,
  preferred_categories            text[] NOT NULL DEFAULT '{}',
  payment_terms                   text,
  currency                        text NOT NULL DEFAULT 'PKR',
  state                           text NOT NULL
                                    CHECK (state IN ('Pending_Review','Docs_Verified','DD_In_Progress',
                                                     'DD_Approved','Manager_Approved','Approved','Active',
                                                     'Rejected','Blacklisted','Suspended','Deactivated')),
  created_by_user_id              uuid REFERENCES core.users(id),
  approved_by_user_id             uuid REFERENCES core.users(id),
  approved_at                     timestamptz,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendors_state               ON core.vendors(state);
CREATE INDEX IF NOT EXISTS idx_vendors_risk_score          ON core.vendors(risk_score) WHERE risk_score IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vendors_preferred_categories ON core.vendors USING GIN (preferred_categories);
CREATE INDEX IF NOT EXISTS idx_vendors_legal_name_trgm     ON core.vendors USING GIN (legal_name gin_trgm_ops);

-- ─── Vendor documents ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core.vendor_documents (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id              uuid NOT NULL REFERENCES core.vendors(id) ON DELETE CASCADE,
  doc_type               text NOT NULL
                           CHECK (doc_type IN ('NTN_CERT','STRN_CERT','BANK_LETTER','TAX_CERT',
                                               'FINANCIALS_2YR','REFERENCE_LETTER','SOLE_SUPPLIER_LETTER','OTHER')),
  file_id                uuid NOT NULL REFERENCES core.files(id),
  mandatory              boolean NOT NULL DEFAULT false,
  verified_at            timestamptz,
  verified_by_user_id    uuid REFERENCES core.users(id),
  uploaded_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vendor_docs_vendor ON core.vendor_documents(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_docs_type   ON core.vendor_documents(doc_type);

-- ─── Vendor due diligence ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core.vendor_due_diligence (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id                uuid NOT NULL UNIQUE REFERENCES core.vendors(id),
  started_by_user_id       uuid NOT NULL REFERENCES core.users(id),
  dd_officer_user_id       uuid REFERENCES core.users(id),
  dd_manager_user_id       uuid REFERENCES core.users(id),
  checklist                jsonb NOT NULL DEFAULT '[]'::jsonb,
  risk_score               numeric(5,2) CHECK (risk_score IS NULL OR (risk_score >= 0 AND risk_score <= 100)),
  manager_justification    text,                              -- required when risk_score < 40
  state                    text NOT NULL
                            CHECK (state IN ('DD_In_Progress','DD_Approved','Manager_Approved','Rejected')),
  approved_by_officer_at   timestamptz,
  approved_by_manager_at   timestamptz,
  CHECK (manager_justification IS NOT NULL OR risk_score IS NULL OR risk_score >= 40)
);

-- ─── Vendor blacklist ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS core.vendor_blacklist (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id             uuid NOT NULL REFERENCES core.vendors(id),
  reason                text NOT NULL,
  flagged_by_user_id    uuid NOT NULL REFERENCES core.users(id),
  flagged_at            timestamptz NOT NULL DEFAULT now(),
  resolved_at           timestamptz,
  resolved_by_user_id   uuid REFERENCES core.users(id)
);
CREATE INDEX IF NOT EXISTS idx_vendor_blacklist_vendor ON core.vendor_blacklist(vendor_id)
  WHERE resolved_at IS NULL;

-- ─── Vendor performance (quarterly scorecard) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS core.vendor_performance (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id            uuid NOT NULL REFERENCES core.vendors(id),
  quarter              text NOT NULL CHECK (quarter ~ '^\d{4}-Q[1-4]$'),
  on_time_pct          numeric(5,2) NOT NULL CHECK (on_time_pct BETWEEN 0 AND 100),
  reject_pct           numeric(5,2) NOT NULL CHECK (reject_pct  BETWEEN 0 AND 100),
  avg_response_hours   numeric(8,2) NOT NULL CHECK (avg_response_hours >= 0),
  score                numeric(5,2) NOT NULL CHECK (score BETWEEN 0 AND 100),
  computed_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendor_id, quarter)
);
CREATE INDEX IF NOT EXISTS idx_vendor_perf_quarter ON core.vendor_performance(quarter);

COMMIT;
