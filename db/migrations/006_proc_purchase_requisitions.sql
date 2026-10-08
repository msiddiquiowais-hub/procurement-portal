-- 006_proc_purchase_requisitions.sql
-- Phase: 1 — Foundation
-- Purpose: Purchase requisition header + lines + amendments + attachments.

BEGIN;

SET LOCAL search_path = proc, core, public;

-- ─── Sequence for PR numbering (gap-free per FY in fn_next_pr_number) ─────────
CREATE SEQUENCE IF NOT EXISTS proc.pr_number_seq START 100000;

-- ─── Purchase requisitions (header) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proc.purchase_requisitions (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_number                   text UNIQUE NOT NULL,                              -- PR-YYYY-NNNNN
  requester_user_id           uuid NOT NULL REFERENCES core.users(id),
  department_id               uuid NOT NULL REFERENCES core.departments(id),
  cost_center_id              uuid NOT NULL REFERENCES core.cost_centers(id),
  project_id                  uuid REFERENCES core.projects(id),
  expense_type                text NOT NULL
                                CHECK (expense_type IN ('CAPEX','OPEX','MIXED')),
  required_by_date            date NOT NULL,
  status                      text NOT NULL
                                CHECK (status IN (
                                  'Draft','Submitted','HOD_Approved','Proc_Verified','Vendor_ID_Done',
                                  'RFQ_Open','Quotations_Received','CS_Generated','Req_Cost_Approved',
                                  'CAPEX_OPEX','Finance_Cost_Approved','MC_Submitted','MC_Approved',
                                  'CFO_Approved','Final_Approved','Pushed_To_D365',
                                  'Returned','Rejected','Cancelled','On_Hold','Split')),
  routing_key                 text NOT NULL DEFAULT 'STANDARD'
                                CHECK (routing_key IN ('STANDARD','FAST_TRACK','BOARD')),
  warehouse_check_required    boolean NOT NULL DEFAULT false,
  warehouse_manager_id        uuid REFERENCES core.users(id),
  warehouse_assignment        jsonb,
  warehouse_decision          text CHECK (warehouse_decision IN ('in_stock','out_of_stock')),
  estimated_amount            numeric(18,2) NOT NULL DEFAULT 0 CHECK (estimated_amount >= 0),
  capex_amount                numeric(18,2) NOT NULL DEFAULT 0 CHECK (capex_amount >= 0),
  opex_amount                 numeric(18,2) NOT NULL DEFAULT 0 CHECK (opex_amount >= 0),
  currency                    text NOT NULL DEFAULT 'PKR',
  scope                       text NOT NULL,
  scope_attachment_file_id    uuid REFERENCES core.files(id),
  attachments                 uuid[] NOT NULL DEFAULT '{}',
  version                     int  NOT NULL DEFAULT 1,
  parent_pr_id                uuid REFERENCES proc.purchase_requisitions(id),
  split                       jsonb,
  urgency                     text NOT NULL DEFAULT 'routine'
                                CHECK (urgency IN ('routine','urgent','force_majeure')),
  d365_po_number              text,
  d365_status                 text,
  budget_reservation_id       uuid REFERENCES core.budget_reservations(id),
  workflow_snapshot           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  last_updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prs_status_updated       ON proc.purchase_requisitions(status, last_updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_prs_requester            ON proc.purchase_requisitions(requester_user_id, last_updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_prs_cost_center          ON proc.purchase_requisitions(cost_center_id);
CREATE INDEX IF NOT EXISTS idx_prs_warehouse_required   ON proc.purchase_requisitions(warehouse_check_required)
  WHERE warehouse_check_required = true;
CREATE INDEX IF NOT EXISTS idx_prs_split                ON proc.purchase_requisitions USING GIN (split) WHERE split IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prs_required_by          ON proc.purchase_requisitions(required_by_date);
CREATE INDEX IF NOT EXISTS idx_prs_d365_po_number       ON proc.purchase_requisitions(d365_po_number) WHERE d365_po_number IS NOT NULL;

-- ─── PR lines ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proc.pr_lines (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_id                  uuid NOT NULL REFERENCES proc.purchase_requisitions(id) ON DELETE CASCADE,
  line_no                int  NOT NULL,
  item_id                uuid NOT NULL REFERENCES core.items(id),
  quantity               numeric(18,3) NOT NULL CHECK (quantity > 0),
  uom                    text NOT NULL,
  unit_price_est         numeric(18,2) NOT NULL CHECK (unit_price_est >= 0),
  gl_account             text NOT NULL,
  description            text,
  preferred_vendor_id    uuid REFERENCES core.vendors(id),
  approved               boolean NOT NULL DEFAULT false,
  rejected               boolean NOT NULL DEFAULT false,
  rejected_reason        text,
  UNIQUE (pr_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_pr_lines_item       ON proc.pr_lines(item_id);
CREATE INDEX IF NOT EXISTS idx_pr_lines_preferred  ON proc.pr_lines(preferred_vendor_id) WHERE preferred_vendor_id IS NOT NULL;

-- ─── PR amendments ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proc.pr_amendments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_id               uuid NOT NULL REFERENCES proc.purchase_requisitions(id),
  version             int  NOT NULL,
  diff                jsonb NOT NULL,
  reason              text NOT NULL,
  amended_by_user_id  uuid NOT NULL REFERENCES core.users(id),
  amended_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pr_id, version)
);

-- ─── PR attachments (per-purpose join) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proc.pr_attachments (
  pr_id     uuid NOT NULL REFERENCES proc.purchase_requisitions(id) ON DELETE CASCADE,
  file_id   uuid NOT NULL REFERENCES core.files(id),
  purpose   text NOT NULL DEFAULT 'general',
  PRIMARY KEY (pr_id, file_id, purpose)
);
CREATE INDEX IF NOT EXISTS idx_pr_attachments_file ON proc.pr_attachments(file_id);

-- Backfill FK from budget_reservations.pr_id → purchase_requisitions.id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'reservations_pr_fk'
  ) THEN
    ALTER TABLE core.budget_reservations
      ADD CONSTRAINT reservations_pr_fk FOREIGN KEY (pr_id) REFERENCES proc.purchase_requisitions(id);
  END IF;
END$$;

-- ─── PR numbering function ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION proc.fn_next_pr_number() RETURNS text AS $$
DECLARE
  yr int := extract(year from now());
BEGIN
  RETURN 'PR-' || yr || '-' || lpad(nextval('proc.pr_number_seq')::text, 5, '0');
END;
$$ LANGUAGE plpgsql VOLATILE;

-- ─── State-machine transition guard ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION proc.fn_check_pr_transition() RETURNS trigger AS $$
DECLARE
  valid boolean := false;
BEGIN
  IF NEW.status = OLD.status THEN
    NEW.last_updated_at := now();
    RETURN NEW;
  END IF;

  valid := (
    (OLD.status = 'Draft'                AND NEW.status IN ('Submitted','Cancelled')) OR
    (OLD.status = 'Submitted'            AND NEW.status IN ('HOD_Approved','Returned','Rejected','Cancelled')) OR
    (OLD.status = 'HOD_Approved'         AND NEW.status IN ('Proc_Verified','Returned','Rejected','Cancelled')) OR
    (OLD.status = 'Proc_Verified'        AND NEW.status IN ('Vendor_ID_Done','Returned','Rejected','Cancelled')) OR
    (OLD.status = 'Vendor_ID_Done'       AND NEW.status IN ('RFQ_Open','Cancelled')) OR
    (OLD.status = 'RFQ_Open'             AND NEW.status IN ('Quotations_Received','Cancelled')) OR
    (OLD.status = 'Quotations_Received'  AND NEW.status IN ('CS_Generated','Cancelled')) OR
    (OLD.status = 'CS_Generated'         AND NEW.status IN ('Req_Cost_Approved','Cancelled')) OR
    (OLD.status = 'Req_Cost_Approved'    AND NEW.status IN ('CAPEX_OPEX','Cancelled')) OR
    (OLD.status = 'CAPEX_OPEX'           AND NEW.status IN ('Finance_Cost_Approved','MC_Submitted','Cancelled')) OR
    (OLD.status = 'Finance_Cost_Approved' AND NEW.status IN ('MC_Submitted','Cancelled')) OR
    (OLD.status = 'MC_Submitted'         AND NEW.status IN ('MC_Approved','Cancelled')) OR
    (OLD.status = 'MC_Approved'          AND NEW.status IN ('CFO_Approved','Final_Approved','Cancelled')) OR
    (OLD.status = 'CFO_Approved'         AND NEW.status IN ('Final_Approved','Cancelled')) OR
    (OLD.status = 'Final_Approved'       AND NEW.status IN ('Pushed_To_D365'))
  );

  IF NOT valid THEN
    RAISE EXCEPTION 'Invalid PR status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.last_updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prs_status_transition ON proc.purchase_requisitions;
CREATE TRIGGER trg_prs_status_transition
BEFORE UPDATE OF status ON proc.purchase_requisitions
FOR EACH ROW EXECUTE FUNCTION proc.fn_check_pr_transition();

-- ─── SoD helper ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION proc.fn_check_sod(p_pr_id uuid, p_voter uuid) RETURNS boolean AS $$
DECLARE
  requester uuid;
BEGIN
  SELECT requester_user_id INTO requester FROM proc.purchase_requisitions WHERE id = p_pr_id;
  IF requester IS NULL THEN
    RETURN false;
  END IF;
  RETURN requester IS DISTINCT FROM p_voter;
END;
$$ LANGUAGE plpgsql STABLE;

-- ─── PR totals computation (capex/OPEX split from lines + items) ──────────────
CREATE OR REPLACE FUNCTION proc.fn_compute_pr_totals(p_pr_id uuid) RETURNS void AS $$
DECLARE
  v_capex numeric(18,2);
  v_opex  numeric(18,2);
  v_expense_type text;
BEGIN
  SELECT
    COALESCE(SUM(CASE WHEN i.expense_type = 'CAPEX' THEN l.quantity * l.unit_price_est ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN i.expense_type = 'OPEX'  THEN l.quantity * l.unit_price_est ELSE 0 END), 0)
  INTO v_capex, v_opex
  FROM proc.pr_lines l
  JOIN core.items i ON i.id = l.item_id
  WHERE l.pr_id = p_pr_id;

  IF v_capex > 0 AND v_opex > 0 THEN
    v_expense_type := 'MIXED';
  ELSIF v_capex > 0 THEN
    v_expense_type := 'CAPEX';
  ELSE
    v_expense_type := 'OPEX';
  END IF;

  UPDATE proc.purchase_requisitions
     SET capex_amount     = v_capex,
         opex_amount      = v_opex,
         estimated_amount = v_capex + v_opex,
         expense_type     = v_expense_type,
         last_updated_at  = now()
   WHERE id = p_pr_id;
END;
$$ LANGUAGE plpgsql;

COMMIT;
