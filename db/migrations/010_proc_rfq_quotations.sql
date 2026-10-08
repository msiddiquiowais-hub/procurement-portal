-- 010_proc_rfq_quotations.sql
-- Phase: 2 — Sourcing + Approvals
-- Purpose: RFQ + invitations, quotations + lines, negotiation log.

BEGIN;

SET LOCAL search_path = proc, core, public;

CREATE SEQUENCE IF NOT EXISTS proc.rfq_number_seq START 100000;
CREATE SEQUENCE IF NOT EXISTS proc.quotation_number_seq START 100000;

-- ─── RFQ ───────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proc.rfq (
  id                                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_number                              text UNIQUE NOT NULL,                -- RFQ-YYYY-NNNNN
  pr_id                                   uuid NOT NULL REFERENCES proc.purchase_requisitions(id),
  created_by_user_id                      uuid NOT NULL REFERENCES core.users(id),
  deadline_at                             timestamptz NOT NULL,
  state                                   text NOT NULL
                                            CHECK (state IN ('Open','Closed','Awarded','Cancelled')),
  single_source                           boolean NOT NULL DEFAULT false,
  single_source_justification             text,
  single_source_approved_by_mc_at         timestamptz,
  single_source_approved_by_mc_user_id    uuid REFERENCES core.users(id),
  single_source_approved_by_audit_at      timestamptz,
  single_source_approved_by_audit_user_id uuid REFERENCES core.users(id),
  currency                                text NOT NULL DEFAULT 'PKR',
  incoterm                                text,
  created_at                              timestamptz NOT NULL DEFAULT now(),
  CHECK (deadline_at >= created_at + interval '24 hours')
);
CREATE INDEX IF NOT EXISTS idx_rfq_pr     ON proc.rfq(pr_id);
CREATE INDEX IF NOT EXISTS idx_rfq_state  ON proc.rfq(state, deadline_at);

CREATE OR REPLACE FUNCTION proc.fn_next_rfq_number() RETURNS text AS $$
DECLARE yr int := extract(year from now());
BEGIN
  RETURN 'RFQ-' || yr || '-' || lpad(nextval('proc.rfq_number_seq')::text, 5, '0');
END;
$$ LANGUAGE plpgsql VOLATILE;

-- ─── RFQ lines (mirror PR lines at issuance) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS proc.rfq_lines (
  rfq_id      uuid NOT NULL REFERENCES proc.rfq(id) ON DELETE CASCADE,
  pr_line_id  uuid NOT NULL REFERENCES proc.pr_lines(id),
  line_no     int  NOT NULL,
  description text NOT NULL,
  quantity    numeric(18,3) NOT NULL CHECK (quantity > 0),
  uom         text NOT NULL,
  PRIMARY KEY (rfq_id, line_no)
);

-- ─── RFQ invitations ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proc.rfq_invitations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id       uuid NOT NULL REFERENCES proc.rfq(id) ON DELETE CASCADE,
  vendor_id    uuid NOT NULL REFERENCES core.vendors(id),
  invited_at   timestamptz NOT NULL DEFAULT now(),
  token_hash   text NOT NULL,
  submitted    boolean NOT NULL DEFAULT false,
  declined     boolean NOT NULL DEFAULT false,
  declined_reason text,
  UNIQUE (rfq_id, vendor_id)
);
CREATE INDEX IF NOT EXISTS idx_rfq_inv_vendor ON proc.rfq_invitations(vendor_id);

-- ─── Quotations ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proc.quotations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id                   uuid NOT NULL REFERENCES proc.rfq(id),
  vendor_id                uuid NOT NULL REFERENCES core.vendors(id),
  submitted_by_user_id     uuid REFERENCES core.users(id),
  submitted_at             timestamptz NOT NULL DEFAULT now(),
  total_amount             numeric(18,2) NOT NULL CHECK (total_amount >= 0),
  currency                 text NOT NULL DEFAULT 'PKR',
  fx_rate                  numeric(18,6) NOT NULL DEFAULT 1.0 CHECK (fx_rate > 0),
  normalized_total_pkr     numeric(18,2) NOT NULL CHECK (normalized_total_pkr >= 0),
  sealed_hash              text NOT NULL,
  open_at                  timestamptz NOT NULL,
  state                    text NOT NULL
                            CHECK (state IN ('Submitted','Superseded','Withdrawn','Awarded','Rejected')),
  version                  int NOT NULL DEFAULT 1,
  supersedes_quotation_id  uuid REFERENCES proc.quotations(id),
  lead_time_days           int CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  warranty_months          int CHECK (warranty_months IS NULL OR warranty_months >= 0),
  taxes_included           boolean NOT NULL DEFAULT false,
  tax_breakdown            jsonb,
  validity_days            int CHECK (validity_days IS NULL OR validity_days > 0)
);
CREATE INDEX IF NOT EXISTS idx_quotations_rfq_vendor ON proc.quotations(rfq_id, vendor_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_quotations_state       ON proc.quotations(state, submitted_at DESC);

-- ─── Quotation lines ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proc.quotation_lines (
  quotation_id  uuid NOT NULL REFERENCES proc.quotations(id) ON DELETE CASCADE,
  rfq_line_no   int  NOT NULL,
  unit_price    numeric(18,2) NOT NULL CHECK (unit_price >= 0),
  total_price   numeric(18,2) NOT NULL CHECK (total_price >= 0),
  PRIMARY KEY (quotation_id, rfq_line_no),
  FOREIGN KEY (quotation_id, rfq_line_no) REFERENCES proc.rfq_lines(rfq_id, line_no)
);

-- ─── Negotiation log ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proc.negotiation_log (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id             uuid NOT NULL REFERENCES proc.rfq(id),
  vendor_id          uuid NOT NULL REFERENCES core.vendors(id),
  round              int  NOT NULL CHECK (round >= 1),
  notes              text NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES core.users(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_negotiation_rfq ON proc.negotiation_log(rfq_id);

COMMIT;
