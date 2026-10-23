-- 066 — per-line negotiation flags on a CS soft revert.
--
-- WHY THIS COLUMN EXISTS
-- ---------------------
-- The blind reviewer does not have to accept or reject a statement whole. A
-- department head who agrees with four awarded lines and objects to the fifth
-- needs to say SO on four and NEGOTIATE on one, with a target rate or reason.
--
-- Until now the only thing a revert carried was one `revert_reason` string, so
-- the two cases collapsed into each other: either the reviewer rejected the
-- whole statement, or they said nothing about the line they disagreed with.
--
-- `revert_lines` records the per-line decisions as jsonb. It is written only on
-- a SOFT revert and is empty otherwise, so an existing row is unaffected and
-- the reading paths that do not know about this column keep working.
--
-- The flags are a RECORD OF THE REVIEWER'S OBJECTION. They do not modify the
-- award: no cs_line_awards row is touched, the statement stays 'Generated',
-- and procurement re-runs the negotiation against the same lines. That is what
-- makes this a soft revert rather than a withdrawal.
--
-- Deliberately NOT a separate child table: the flags are only ever read as the
-- set attached to one revert event, they are never queried across statements,
-- and they are immutable once written (the review row's sub_state has already
-- moved on). A child table would add a second thing to join with nothing to
-- select on.

BEGIN;

ALTER TABLE proc.cs_reviews
  ADD COLUMN IF NOT EXISTS revert_lines jsonb;

COMMENT ON COLUMN proc.cs_reviews.revert_lines IS
  'Per-line decisions attached to a SOFT revert: [{line_no, decision, target_remarks}]. '
  'NULL when no line was flagged. The award itself is untouched by these.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'proc' AND table_name = 'cs_reviews'
       AND column_name = 'revert_lines'
  ) THEN
    RAISE EXCEPTION 'revert_lines was not added to proc.cs_reviews';
  END IF;
  RAISE NOTICE '066 applied: proc.cs_reviews.revert_lines added';
END $$;

COMMIT;