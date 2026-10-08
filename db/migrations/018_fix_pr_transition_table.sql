-- Fix the PR status transition table. The original migration used stage names
-- from an earlier v1 design (HOD_Approved, Proc_Verified, Vendor_ID_Done, ...).
-- The current DEFAULT_WORKFLOW_STEPS use a different vocabulary:
--   Submitted → IN_WAREHOUSE_CHECK (side-channel)
--   Submitted → IN_PROCUREMENT_REVIEW (default)
--   IN_PROCUREMENT_REVIEW → IN_COST_CENTER_APPROVAL
--   IN_COST_CENTER_APPROVAL → IN_FINANCE_REVIEW
--   IN_FINANCE_REVIEW → IN_MANAGEMENT_REVIEW (≥1M) | READY_FOR_D365 (<1M)
--   IN_MANAGEMENT_REVIEW → READY_FOR_D365
--   READY_FOR_D365 → D365_PUSHED
-- Plus REJECTED, FULFILLED_FROM_STOCK side-channel targets.
CREATE OR REPLACE FUNCTION proc.fn_check_pr_transition() RETURNS trigger AS $$
DECLARE
  valid boolean := false;
BEGIN
  IF NEW.status = OLD.status THEN
    NEW.last_updated_at := now();
    RETURN NEW;
  END IF;

  valid := (
    (OLD.status = 'Draft'                  AND NEW.status IN ('Submitted','Cancelled')) OR
    (OLD.status = 'Submitted'              AND NEW.status IN ('IN_PROCUREMENT_REVIEW','IN_WAREHOUSE_CHECK','IN_PROCUREMENT_REVIEW_WAREHOUSE','Rejected','Cancelled')) OR
    (OLD.status = 'IN_WAREHOUSE_CHECK'     AND NEW.status IN ('IN_PROCUREMENT_REVIEW','Rejected','Cancelled')) OR
    (OLD.status = 'IN_PROCUREMENT_REVIEW'  AND NEW.status IN ('IN_COST_CENTER_APPROVAL','Rejected','Cancelled')) OR
    (OLD.status = 'IN_COST_CENTER_APPROVAL' AND NEW.status IN ('IN_FINANCE_REVIEW','Rejected','Cancelled')) OR
    (OLD.status = 'IN_FINANCE_REVIEW'      AND NEW.status IN ('IN_MANAGEMENT_REVIEW','READY_FOR_D365','Rejected','Cancelled')) OR
    (OLD.status = 'IN_MANAGEMENT_REVIEW'   AND NEW.status IN ('READY_FOR_D365','Cancelled')) OR
    (OLD.status = 'READY_FOR_D365'         AND NEW.status IN ('D365_PUSHED','Cancelled')) OR
    (OLD.status = 'D365_PUSHED'            AND NEW.status IN ('Fulfilled','Cancelled')) OR
    (OLD.status = 'Rejected'               AND NEW.status IN ('Cancelled')) OR
    (OLD.status = 'Fulfilled'              AND NEW.status IN ('Cancelled')) OR
    -- Side-channel: any state can short-circuit to Fulfilled-from-stock
    (NEW.status = 'FULFILLED_FROM_STOCK') OR
    -- Cancellation allowed from any non-terminal state
    (NEW.status = 'Cancelled' AND OLD.status NOT IN ('D365_PUSHED','Fulfilled','Cancelled'))
  );

  IF NOT valid THEN
    RAISE EXCEPTION 'Invalid PR status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.last_updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;