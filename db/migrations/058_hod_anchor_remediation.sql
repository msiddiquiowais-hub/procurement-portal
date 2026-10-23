-- 058_hod_anchor_remediation.sql
--
-- Corrects `hod_approved_at`, which migration 057 backfilled from ONE transition
-- pattern and therefore under-counted every HOD approval that happened before the
-- migration-053 cutover.
--
-- ═══ WHY 057 WAS WRONG ═══════════════════════════════════════════════════════
--
-- 057 looked for exactly one signature: a transition OUT OF `IN_HOD_REVIEW`.
-- That signature only exists from 2026-10-06 onward, because migration
-- 053_hod_review_stage changed the HOD step's `from` in the routing config from
-- `'Submitted'` to `'IN_HOD_REVIEW'`.
--
-- Routing is NOT read from the live table. `pr.service.ts::advance()` calls
-- `workflow.getConfigForPr(prId)`, which returns the FROZEN snapshot taken when
-- the PR was created (`workflow.pr_workflow_snapshot`), so an admin edit cannot
-- strand a request already in flight. Every PR therefore routes under the config
-- as it stood on its creation date:
--
--   snapshot hod_review.from = 'Submitted'      (created 2026-10-01 .. 10-06)  513 PRs
--   snapshot hod_review.from = 'IN_HOD_REVIEW'  (created 2026-10-06 .. 10-11)  236 PRs
--
-- The pre-cutover PRs sat in `Submitted` WHILE AWAITING HOD APPROVAL, and the
-- HOD's single approval action moved them straight to procurement. They were
-- genuinely approved by the HOD — they simply never occupied a visible
-- `IN_HOD_REVIEW` state, so 057's single-pattern backfill found nothing and left
-- `hod_approved_at` NULL for all of them.
--
-- Measured on this estate before this migration: 213 of 979 light PRs anchored.
--
-- ═══ THE ACTOR FILTER IS LOAD-BEARING, NOT COSMETIC ═════════════════════════
--
-- `POST /pr/:id/advance` performs NO authorisation. Neither the controller nor
-- `advance()` compares the caller's role with the step's `actorRole`; the engine's
-- `resolveNextStage` filters on the PR's stage and the step predicate only.
-- Verified live: a requester creates a PR (lands in IN_HOD_REVIEW), then calls
-- advance on it themselves and the API answers 201 with nextStage
-- IN_PROCUREMENT_REVIEW.
--
-- So "which stage did it move to" cannot distinguish an approval from a
-- self-approval. Only the actor can:
--
--   HOD-gate exits on this estate:  hod 549 | requester 173 | admin 2
--
-- The 173 requester self-approvals are NOT HOD approvals and must NOT be stamped
-- — stamping them would assert an approval that never happened, which is the one
-- thing this column must never do. `admin` IS counted, because ROLE_ALIASES in
-- @procurement/roles expands admin to include `hod`, so an admin session holds
-- HOD permissions and its action is a legitimate HOD approval.
--
-- The filter is applied to BOTH patterns, not just the pre-053 one. Leaving it
-- off the post-053 pattern would keep the requester self-approvals that reached
-- procurement by way of IN_HOD_REVIEW, and the column would not be accurate —
-- which is the entire point of this migration.
--
-- ═══ SECOND ANCHOR REMOVED ═══════════════════════════════════════════════════
--
-- `procurement_entered_at` existed only because the 057 alarm had no anchor for
-- fast-track PRs. With the backfill corrected, and with the alarm additionally
-- gated on the PR actually being at or past procurement review (implemented in
-- the query, not here), a second anchor is redundant state that can only drift
-- from the first. It is dropped.
--
-- KNOWN CONSEQUENCE, accepted deliberately: the 173 requester self-approvals now
-- carry NO anchor, so the RFQ-overdue alarm stays dark for them. That is the
-- honest outcome — the alarm reports "the HOD approved this and procurement has
-- not issued an RFQ in time", and for these we cannot assert the first half.
-- The underlying authorisation gap is reported separately and is NOT fixed here;
-- this migration only refuses to record an approval that did not occur.
--
-- REPLAY SAFE — every statement is idempotent; migrate.ps1 replays all files.

\set ON_ERROR_STOP on
BEGIN;

SET LOCAL search_path = proc, core, public;

-- ═══ 1 · Drop the second anchor ═══════════════════════════════════════════════
--
-- reporting.v_pr_queue_hod is defined in migration 015 as `SELECT p.*`, so
-- Postgres expanded it against the table AS IT STOOD AT THAT MOMENT and absorbed
-- the column 057 had just added. Dropping the column therefore fails unless the
-- view goes first. It is recreated immediately below, and migration 015 will
-- re-create it from source on the next full replay — where `p.*` no longer
-- expands to include the dropped column.

DROP VIEW IF EXISTS reporting.v_pr_queue_hod;

ALTER TABLE proc.purchase_requisitions DROP COLUMN IF EXISTS procurement_entered_at;

CREATE OR REPLACE VIEW reporting.v_pr_queue_hod AS
SELECT p.*
FROM proc.purchase_requisitions p
JOIN core.cost_centers c ON c.id = p.cost_center_id
WHERE p.status = 'Submitted';

-- ═══ 2 · The stamp trigger, reduced to the one fact it can prove ═════════════

CREATE OR REPLACE FUNCTION proc.fn_stamp_sourcing_clock() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- Post-053 this is the only path: a PR is created into IN_HOD_REVIEW and the
  -- HOD's approval leaves it. Two exits are NOT approvals — ON_HOLD is a hold
  -- and IN_HOD_REVIEW -> IN_HOD_REVIEW is not a move at all — and the
  -- IS NULL guard means a PR that is sent back for rework and re-approved keeps
  -- the timestamp of its FIRST approval, which is the one the delay is measured
  -- from.
  IF OLD.status = 'IN_HOD_REVIEW'
     AND NEW.status IS DISTINCT FROM 'IN_HOD_REVIEW'
     AND NEW.status IS DISTINCT FROM 'ON_HOLD'
     AND NEW.status IS DISTINCT FROM 'REJECTED'
     AND NEW.hod_approved_at IS NULL THEN
    NEW.hod_approved_at := now();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prs_stamp_sourcing_clock ON proc.purchase_requisitions;
CREATE TRIGGER trg_prs_stamp_sourcing_clock
  BEFORE UPDATE OF status ON proc.purchase_requisitions
  FOR EACH ROW EXECUTE FUNCTION proc.fn_stamp_sourcing_clock();

COMMENT ON FUNCTION proc.fn_stamp_sourcing_clock() IS
  'Stamps hod_approved_at when a PR leaves IN_HOD_REVIEW forward. Does not judge WHO pressed the button — advance() is unauthenticated by role, so this records that a decision was taken, not that a HOD took it.';

-- ═══ 3 · Undo the anchors 057 wrote without an actor filter ═══════════════════
--
-- 057 backfilled from two sources, NEITHER of which checked who performed the
-- action: proc.pr_departments.hod_decided_at, and the audit exit out of
-- IN_HOD_REVIEW. Because advance() has no role check, both sources can point at
-- a requester's self-approval. On this estate that was 9 PRs, already stamped
-- before this migration ran.
--
-- Filling NULLs is therefore not enough — the bad anchors have to be undone
-- first. An anchor survives only if a decision by somebody entitled to give HOD
-- approval actually explains that exact timestamp. Both sources are checked,
-- because pr_departments has no actor column of its own and is joined to
-- core.users through hod_user_id for exactly that reason.

UPDATE proc.purchase_requisitions pr
   SET hod_approved_at = NULL
 WHERE pr.hod_approved_at IS NOT NULL
   AND NOT EXISTS (
     SELECT 1
       FROM audit.audit_log a
       JOIN core.users u ON u.id = a.actor_user_id
      WHERE a.entity = 'proc.purchase_requisitions'
        AND a.entity_id = pr.id::text
        AND a.ts = pr.hod_approved_at
        AND u.role IN ('hod', 'admin')
   )
   AND NOT EXISTS (
     SELECT 1
       FROM proc.pr_departments pd
       JOIN core.users u ON u.id = pd.hod_user_id
      WHERE pd.pr_id = pr.id
        AND pd.hod_status = 'approved'
        AND pd.hod_decided_at = pr.hod_approved_at
        AND u.role IN ('hod', 'admin')
   );

-- ═══ 4 · The corrected backfill ══════════════════════════════════════════════
--
-- The destinations the HOD gate can legitimately exit to: the step's default `to`
-- plus its line-rule routes. ON_HOLD and REJECTED are excluded because neither
-- is an approval.
--
-- DISTINCT ON (entity_id) ... ORDER BY ts ASC takes the FIRST qualifying exit, so
-- a rework-and-re-approve cycle cannot move the timestamp forward.

UPDATE proc.purchase_requisitions pr
   SET hod_approved_at = src.ts
  FROM (
    SELECT DISTINCT ON (a.entity_id) a.entity_id, a.ts
      FROM audit.audit_log a
      JOIN core.users u ON u.id = a.actor_user_id
     WHERE a.entity = 'proc.purchase_requisitions'
       AND a.action = 'update'
       AND u.role IN ('hod', 'admin')
       AND (
         -- Pattern A (pre-053): the HOD step's `from` was 'Submitted', so the
         -- approval jumped straight out of Submitted.
         (a.before->>'status' = 'Submitted'
            AND a.after->>'status' IN ('IN_PROCUREMENT_REVIEW','IN_IT_REVIEW','IN_WAREHOUSE'))
         OR
         -- Pattern B (post-053): the ordinary leave-IN_HOD_REVIEW approval.
         (a.before->>'status' = 'IN_HOD_REVIEW'
            AND a.after->>'status' IN ('IN_PROCUREMENT_REVIEW','IN_IT_REVIEW','IN_WAREHOUSE'))
       )
     ORDER BY a.entity_id, a.ts ASC
  ) src
 WHERE src.entity_id = pr.id::text
   AND pr.hod_approved_at IS NULL;

-- ═══ Post-condition check (inside the transaction, so a failure rolls back) ═══

DO $$
DECLARE
  anchored  int;
  stray     int;
  legacy    int;
  legacy_cohort_size int;
  single_pattern    int;
  stray_fn  text;
BEGIN
  -- (1) The second anchor is GONE. A leftover column is exactly the drift this
  --     migration exists to remove.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='proc' AND table_name='purchase_requisitions'
       AND column_name='procurement_entered_at'
  ) THEN
    RAISE EXCEPTION 'migration 058: procurement_entered_at still exists — it must be dropped';
  END IF;

  -- (2) No query may still read the dropped column. `prokind = 'f'` is required:
  --     evaluating pg_get_functiondef across aggregate rows raises
  --     '"array_agg" is an aggregate function', because the row for an
  --     aggregate cannot be rendered as a routine definition. Without the
  --     filter this check fails on a clean estate and looks like a real fault.
  SELECT string_agg(p.proname, ', ') INTO stray_fn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'proc'
     AND p.prokind = 'f'
     AND position('procurement_entered_at' in pg_get_functiondef(p.oid)) > 0;
  IF stray_fn IS NOT NULL THEN
    RAISE EXCEPTION 'migration 058: proc function(s) still reference procurement_entered_at: %', stray_fn;
  END IF;

  -- (3) The stamp trigger is live.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid='proc.purchase_requisitions'::regclass
       AND tgname='trg_prs_stamp_sourcing_clock' AND NOT tgisinternal AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'migration 058: trg_prs_stamp_sourcing_clock is missing or disabled';
  END IF;

  -- (4) The audit trigger from 014 must survive — it is how the backfill found
  --     anything at all, and its loss would be silent.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid='proc.purchase_requisitions'::regclass
       AND tgname='trg_prs_audit' AND NOT tgisinternal AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'migration 058: trg_prs_audit from migration 014 is gone';
  END IF;

  -- (5) The backfill must have moved the number substantially. The baseline is
  --     COMPUTED, not remembered. The original test compared against 213 -- a
  --     count taken from one particular estate. On any other database,
  --     including a freshly seeded one, that constant was simply wrong, and the
  --     guard aborted a deploy that had nothing wrong with it. Recomputing the
  --     single-pattern count here keeps the assertion exactly as strong: a
  --     silent no-op still trips it, because then anchored <= single_pattern.
  SELECT count(*) INTO anchored
    FROM proc.purchase_requisitions WHERE hod_approved_at IS NOT NULL;
  SELECT count(*) INTO single_pattern
    FROM proc.purchase_requisitions pr
   WHERE EXISTS (SELECT 1 FROM proc.pr_departments pd
                  WHERE pd.pr_id = pr.id
                    AND pd.hod_status = 'approved'
                    AND pd.hod_decided_at IS NOT NULL)
      OR EXISTS (SELECT 1 FROM audit.audit_log a
                  WHERE a.entity = 'proc.purchase_requisitions'
                    AND a.entity_id = pr.id::text
                    AND a.action = 'update'
                    AND a.before->>'status' = 'IN_HOD_REVIEW'
                    AND a.after->>'status' IS DISTINCT FROM 'IN_HOD_REVIEW'
                    AND a.after->>'status' IS DISTINCT FROM 'ON_HOLD'
                    AND a.after->>'status' IS DISTINCT FROM 'REJECTED');
  IF single_pattern > 0 AND anchored <= single_pattern THEN
    RAISE EXCEPTION
      'migration 058: hod_approved_at anchored % PR(s), which does not improve on the % the single-pattern backfill produced', anchored, single_pattern;
  END IF;

  -- (6) A requester must never appear as the approver. This is the invariant
  --     the actor filter exists to protect, asserted rather than assumed.
  SELECT count(*) INTO stray
    FROM proc.purchase_requisitions pr
    JOIN audit.audit_log a ON a.entity_id = pr.id::text
    JOIN core.users u ON u.id = a.actor_user_id
   WHERE pr.hod_approved_at = a.ts
     AND u.role = 'requester';
  IF stray > 0 THEN
    RAISE EXCEPTION
      'migration 058: % PR(s) have a requester stamped as the HOD approver — the actor filter failed', stray;
  END IF;

  -- (7) The pre-053 cohort must now be anchored. This is the population 057
  --     missed entirely, so it is asserted directly rather than inferred.
  --     regexp_matches is set-returning, so it cannot sit in WHERE; the snapshot
  --     is unnested in a subquery and the predicate applied outside it.
  SELECT count(*) INTO legacy
    FROM (
      SELECT pr.id
        FROM (SELECT pr_id,
                     (regexp_matches(steps::text, '"key": "hod_review", "from": "([A-Za-z_]+)"'))[1] AS snap
                FROM workflow.pr_workflow_snapshot) s
        JOIN proc.purchase_requisitions pr ON pr.id = s.pr_id
       WHERE s.snap = 'Submitted'
         AND pr.hod_approved_at IS NOT NULL
    ) legacy_cohort;
  -- Only asserted when the pre-053 cohort EXISTS. An empty cohort means there
  -- is nothing to anchor, not that the backfill failed -- and on a fresh
  -- database there is no cohort at all. Where the cohort does exist, the
  -- assertion is unchanged: it must still be anchored.
  SELECT count(*) INTO legacy_cohort_size
    FROM (
      SELECT pr.id
        FROM (SELECT pr_id,
                     (regexp_matches(steps::text, '"key": "hod_review", "from": "([A-Za-z_]+)"'))[1] AS snap
                FROM workflow.pr_workflow_snapshot) s
        JOIN proc.purchase_requisitions pr ON pr.id = s.pr_id
       WHERE s.snap = 'Submitted'
    ) legacy_all;
  IF legacy_cohort_size > 0 AND legacy = 0 THEN
    RAISE EXCEPTION 'migration 058: the pre-053 cohort still has zero anchored PRs — the corrected backfill did not fire';
  END IF;

  RAISE NOTICE 'migration 058 verified — % PR(s) anchored to a real HOD approval (% pre-053); second anchor removed', anchored, legacy;
END $$;

\echo '--- 058: HOD anchor remediated ---'
SELECT count(*) AS anchored_hod_approvals FROM proc.purchase_requisitions WHERE hod_approved_at IS NOT NULL;

COMMIT;