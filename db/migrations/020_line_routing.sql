-- 020_line_routing.sql
--
-- Wave 0 / B1 + B3 of PROCUREMENT_PORTAL_PORT_GAP_MATRIX.md.
--
-- Restores the prototype's v2.0.x-workflow-config-line-routing surface to the
-- database so packages/workflow-engine can actually perform PR auto-splitting.
--
-- Adds:
--   1. the status vocabulary widened to admit line-rule targets (now via the
--      shared proc.fn_widen_pr_status_check() from 019)
--   2. fn_check_pr_transition rewritten to admit the split transitions
--   3. proc.pr_lines.category  -- per-line override of core.items.category,
--      which is what resolveLineCategory() reads first
--   4. proc.pr_lines.held      -- third HOD disposition (approved/rejected/held)
--   5. proc.pr_departments    -- a PR can route to several department HODs
--      (prototype: multi-department "Suggest HOD" on the create form)
--   6. proc.pr_images         -- per-line reference images (prototype caps at
--      3 images, 2 MB each / 5 MB per PR)
--   7. purchase_requisitions.purpose / .title / .description -- the remaining
--      CreatePrDto fields the prototype form captures
--
-- RECONSTRUCTION NOTE (2026-10-01)
-- --------------------------------
-- This file was accidentally truncated to zero bytes by a failed in-place edit
-- and has been reconstructed from the live schema rather than from memory: the
-- function bodies below were recovered verbatim via pg_get_functiondef(), and
-- the tables, constraints, partial indexes and trigger were recovered from
-- pg_constraint / pg_indexes / information_schema. The end state of a replay is
-- identical to before; `npm run db:verify:020`-style checks and a clean
-- `db:reset` both confirm it.
--
-- One deliberate difference from the original: fn_check_pr_transition is
-- installed here with the COMPLETE transition table (v1 + v2 + v2.1 split
-- branches + the v3 governance branches). The original 020 carried only the
-- v2.1 branches and let 027 append the governance ones. Installing the full
-- table here is safe and strictly more robust — 027 re-writes the same function
-- with the same content, so the end state is identical, and there is no window
-- during a replay in which a governance transition would be rejected.
--
-- Everything below is IF NOT EXISTS / OR REPLACE so a replay is a no-op.

BEGIN;

-- -- 1 . widen the status vocabulary --
-- IN_IT_REVIEW and IN_WAREHOUSE are line-rule targets. They are NOT reachable
-- on a parent PR -- only on children created by _splitPr.
--
-- The vocabulary is no longer re-declared here. It lives in
-- proc.fn_widen_pr_status_check(), defined by migration 019 and called below.
--
-- Re-declaring it is what made this migration DESTRUCTIVE ON REPLAY: the file
-- used to DROP the constraint and re-ADD it with its own (narrower) list, so
-- re-running `npm run db:migrate` on a database that had already applied 027
-- tried to strip the governance stages and aborted with a CHECK violation
-- "by some row". A fresh db:reset never hit it, which is why it survived.
-- The helper only ever WIDENS, and is a no-op when the constraint already
-- permits the full vocabulary. See 019 for the full explanation.
SELECT proc.fn_widen_pr_status_check();

-- -- 2 . admit the split transitions --
-- Submitted -> IN_IT_REVIEW / IN_WAREHOUSE is the split child landing.
-- IN_IT_REVIEW / IN_WAREHOUSE -> IN_PROCUREMENT_REVIEW is the child
-- rejoining the main flow once its approver is done.
CREATE OR REPLACE FUNCTION proc.fn_check_pr_transition() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  valid boolean := false;
BEGIN
  IF NEW.status = OLD.status THEN
    NEW.last_updated_at := now();
    RETURN NEW;
  END IF;

  valid := (
    (OLD.status = 'Draft'                  AND NEW.status IN ('Submitted','Cancelled')) OR
    (OLD.status = 'Submitted'              AND NEW.status IN (
                                        'IN_PROCUREMENT_REVIEW','IN_WAREHOUSE_CHECK',
                                        'IN_PROCUREMENT_REVIEW_WAREHOUSE',
                                        -- v2.1 line-routing split children
                                        'IN_IT_REVIEW','IN_WAREHOUSE',
                                        'Rejected','REJECTED','Cancelled')) OR
    -- v2.1: a child PR re-enters the main flow after its routed approver acts
    (OLD.status = 'IN_IT_REVIEW'           AND NEW.status IN ('IN_PROCUREMENT_REVIEW','Rejected','REJECTED','Cancelled')) OR
    (OLD.status = 'IN_WAREHOUSE'           AND NEW.status IN ('IN_PROCUREMENT_REVIEW','IN_WAREHOUSE_CHECK','Rejected','REJECTED','Cancelled')) OR
    (OLD.status = 'IN_WAREHOUSE_CHECK'     AND NEW.status IN ('IN_PROCUREMENT_REVIEW','Rejected','REJECTED','Cancelled')) OR
    -- v3 governance exits from procurement review
    -- A full PR sits at IN_PROCUREMENT_REVIEW for the whole sourcing block, so
    -- the governance chain hangs off it. FAST_TRACK skips the middle two stages
    -- and lands straight on PACK_LOCKED (prototype line 7205).
    (OLD.status = 'IN_PROCUREMENT_REVIEW'  AND NEW.status IN (
                                        'IN_COST_CENTER_APPROVAL',
                                        'QUOTES_RECEIVED','CS_LOCKED','PACK_LOCKED',
                                        'Rejected','REJECTED','Cancelled')) OR
    (OLD.status = 'IN_COST_CENTER_APPROVAL' AND NEW.status IN ('IN_FINANCE_REVIEW','Rejected','REJECTED','Cancelled')) OR
    (OLD.status = 'IN_FINANCE_REVIEW'      AND NEW.status IN ('IN_MANAGEMENT_REVIEW','READY_FOR_D365','Rejected','REJECTED','Cancelled')) OR
    (OLD.status = 'IN_MANAGEMENT_REVIEW'   AND NEW.status IN ('READY_FOR_D365','Cancelled')) OR

    -- v3 governance chain --
    -- Quotes received -> CS locked, or back to sourcing to revise the RFQ.
    (OLD.status = 'QUOTES_RECEIVED'        AND NEW.status IN (
                                        'CS_LOCKED','IN_PROCUREMENT_REVIEW',
                                        'Rejected','REJECTED','Cancelled')) OR
    -- CS locked -> MC. The two exits are the MC's approve and the MC's reject.
    (OLD.status = 'CS_LOCKED'              AND NEW.status IN (
                                        'MC_APPROVED','QUOTES_RECEIVED',
                                        'PACK_LOCKED',
                                        'Rejected','REJECTED','Cancelled')) OR
    (OLD.status = 'MC_APPROVED'            AND NEW.status IN (
                                        'CFO_APPROVED','CS_LOCKED',
                                        'Rejected','REJECTED','Cancelled')) OR
    (OLD.status = 'CFO_APPROVED'           AND NEW.status IN ('PACK_LOCKED','Cancelled')) OR
    (OLD.status = 'PACK_LOCKED'            AND NEW.status IN ('D365_PUSHED','Cancelled')) OR

    (OLD.status = 'READY_FOR_D365'         AND NEW.status IN ('D365_PUSHED','Cancelled')) OR
    (OLD.status = 'D365_PUSHED'            AND NEW.status IN ('Fulfilled','Cancelled')) OR
    (OLD.status IN ('Rejected','REJECTED')  AND NEW.status IN ('Cancelled')) OR
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
$$;

-- -- 3 . per-line HOD disposition and category override --
-- `category` overrides core.items.category so a line can be reclassified
-- without touching the item master; resolveLineCategory() reads it first.
-- `held` is the prototype's third disposition, alongside approved/rejected.
ALTER TABLE proc.pr_lines ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE proc.pr_lines ADD COLUMN IF NOT EXISTS held boolean NOT NULL DEFAULT false;
ALTER TABLE proc.pr_lines ADD COLUMN IF NOT EXISTS held_reason text;

-- A line is exactly one disposition: approved / rejected / held.
ALTER TABLE proc.pr_lines
  DROP CONSTRAINT IF EXISTS pr_lines_disposition_check;
ALTER TABLE proc.pr_lines
  ADD CONSTRAINT pr_lines_disposition_check
  CHECK (NOT (approved AND rejected)
     AND NOT (approved AND held)
     AND NOT (rejected AND held));

-- -- 4 . multi-department HOD routing --
-- The prototype's create form suggests one HOD per department on a PR, so the
-- requester can be routed to several approvers at once.
CREATE TABLE IF NOT EXISTS proc.pr_departments (
  pr_id          uuid NOT NULL REFERENCES proc.purchase_requisitions(id) ON DELETE CASCADE,
  department_id  uuid NOT NULL REFERENCES core.departments(id),
  hod_user_id    uuid REFERENCES core.users(id),
  hod_status     text NOT NULL DEFAULT 'pending'
                   CHECK (hod_status IN ('pending','approved','rejected','skipped')),
  hod_comment    text,
  hod_decided_at timestamptz,
  -- True when this pairing came from the create form's "Suggest HOD" helper
  -- rather than being chosen by hand; drives the HOD-tagged pill.
  suggested      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (pr_id, department_id)
);

-- The approvals queue looks up "what is waiting on me" by HOD user.
CREATE INDEX IF NOT EXISTS idx_pr_departments_hod
  ON proc.pr_departments (hod_user_id)
  WHERE hod_status = 'pending';

-- -- 5 . per-line reference images --
-- The prototype caps a PR at 3 images, 2 MB each and 5 MB in total. The per-row
-- size cap and MIME allowlist are CHECK constraints; the per-PR count and total
-- are enforced by the trigger below, because a CHECK cannot see sibling rows.
CREATE TABLE IF NOT EXISTS proc.pr_images (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_id      uuid NOT NULL REFERENCES proc.purchase_requisitions(id) ON DELETE CASCADE,
  line_id    uuid REFERENCES proc.pr_lines(id) ON DELETE CASCADE,
  file_id    uuid NOT NULL REFERENCES core.files(id),
  mime_type  text NOT NULL
               CHECK (mime_type IN ('image/jpeg','image/jpg','image/png','image/webp','image/gif')),
  size_bytes int  NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 2097152),  -- 2 MB per file
  sort_order int  NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pr_images_pr
  ON proc.pr_images (pr_id, sort_order);

CREATE OR REPLACE FUNCTION proc.fn_check_pr_image_caps() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  n_count int;
  n_bytes bigint;
BEGIN
  SELECT count(*), coalesce(sum(size_bytes), 0)
    INTO n_count, n_bytes
    FROM proc.pr_images
   WHERE pr_id = NEW.pr_id
     AND id <> NEW.id;                     -- exclude this row on UPDATE

  IF n_count + 1 > 3 THEN
    RAISE EXCEPTION 'PR % exceeds the 3 reference-image limit', NEW.pr_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF n_bytes + NEW.size_bytes > 5242880 THEN   -- 5 MB
    RAISE EXCEPTION 'PR % exceeds the 5 MB reference-image total', NEW.pr_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pr_images_caps ON proc.pr_images;
CREATE TRIGGER trg_pr_images_caps
  BEFORE INSERT OR UPDATE ON proc.pr_images
  FOR EACH ROW EXECUTE FUNCTION proc.fn_check_pr_image_caps();

-- -- 6 . the remaining CreatePrDto fields --
-- The prototype's request form captures a title, a free-text description and a
-- purchase purpose; none of them existed on the table.
ALTER TABLE proc.purchase_requisitions ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE proc.purchase_requisitions ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE proc.purchase_requisitions ADD COLUMN IF NOT EXISTS purpose text;

COMMIT;
