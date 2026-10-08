-- 052b_free_text_po_exclusion.sql
--
-- Companion to 052_free_text_pr_lines.sql: teach the PO exclusion table the one
-- new reason free text introduces.
--
-- WHY THIS IS NEEDED
-- -----------------
-- proc.pr_line_po_exclusions.reason carries
--     CHECK (reason = ANY (ARRAY['NOT_AWARDED','HELD','STORE_FULFILLED','REJECTED']))
-- from migration 042. A line that is free text has no catalogue item, and
-- proc.purchase_order_lines.item_id is still NOT NULL + FK, so it cannot be
-- ordered. po.service.ts now excludes it with a reason — and a reason outside
-- that CHECK is a constraint violation, which is an opaque 500 in the middle of
-- order generation rather than the explanation the requester needs.
--
-- The alternative — reusing 'NOT_AWARDED' — would have been a lie in the audit
-- trail: the line WAS awarded. It is missing a product code, which is a
-- different problem with a different fix, and an auditor reading "no line award
-- covers this line" would go looking for an award problem that does not exist.
--
-- ADDED, NOT REPLACED
-- -------------------
-- The existing four values are untouched. Widening a CHECK is additive and
-- replay-safe: re-running this file finds the value already present and skips.
-- Nothing is dropped, so every historical exclusion row still validates.


DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pr_line_po_exclusions_reason_check'
  ) THEN
    -- Drop and rebuild only when the new value is genuinely missing. Doing this
    -- unconditionally on every replay would churn the catalog for no reason.
    IF NOT EXISTS (
      SELECT 1
        FROM pg_constraint c
        CROSS JOIN LATERAL unnest(c.conkey) AS k(attnum)
       WHERE c.conname = 'pr_line_po_exclusions_reason_check'
         AND pg_get_constraintdef(c.oid) LIKE '%NO_CATALOGUE_ITEM%'
    ) THEN
      ALTER TABLE proc.pr_line_po_exclusions
        DROP CONSTRAINT pr_line_po_exclusions_reason_check;

      ALTER TABLE proc.pr_line_po_exclusions
        ADD CONSTRAINT pr_line_po_exclusions_reason_check
        CHECK (reason = ANY (ARRAY[
              'NOT_AWARDED',        -- no line award: the CS never got to it
              'HELD',               -- HOD/manager hold, never released
              'STORE_FULFILLED',    -- covered from warehouse stock
              'REJECTED',           -- the PR line was rejected outright
              'NO_CATALOGUE_ITEM'   -- free text: awarded, but no product code to order
            ]));
    END IF;
  END IF;
END $$;
