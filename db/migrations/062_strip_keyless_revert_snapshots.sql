-- ══════════════════════════════════════════════════════════════════════════════
-- 062 · STRIP KEYLESS REVERT STEPS FROM FROZEN ROUTING SNAPSHOTS
-- ══════════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS REPAIRS
-- ------------------
-- `WorkflowRepository.ensureStepInSnapshot()` appends the `revert_to_hod` step
-- to a PR's frozen routing snapshot so that PRs created before migration 060
-- can use it. Its first implementation copied `workflow.steps_config.payload`
-- into the snapshot verbatim.
--
-- That cannot work, because the two tables disagree about where the key lives:
--
--   - `workflow.steps_config` stores the step key in the table's `id` COLUMN;
--     its `payload` has no `key` field.
--   - `loadForPr()` derives a snapshot entry's key from the payload's `key`
--     FIELD (`String(p.key ?? 'step_' + i)`).
--
-- So the appended entry came back as `step_12`, `steps.find(s => s.key ===
-- 'revert_to_hod')` could not see it, and every call to the merge appended
-- ANOTHER copy — the NOT EXISTS clause keys on that same absent field and never
-- matched either. Measured before this migration: 352 keyless entries across 26
-- of 1022 snapshots.
--
-- The user-visible symptom was a 400 on the one PR this feature was built to
-- rescue — "the revert_to_hod step is not in this PR's routing configuration" —
-- on a PR the merge had already touched and reported success on.
--
-- WHY DELETE, NOT REPAIR IN PLACE
-- -------------------------------
-- The entry is unrecoverable as written: a `revert_to_hod` step with no key is
-- inert — the engine cannot match it, and a snapshot entry that cannot match
-- anything is only ever going to confuse the next reader. `ensureStepInSnapshot`
-- re-appends it correctly on the next call, so removing it here is safe and
-- self-healing.
--
-- SCOPE IS DELIBERATELY NARROW
-- ----------------------------
-- Only entries that are BOTH keyless AND carry `when = 'revertToHod'` are
-- removed. That predicate cannot match any of the prototype's steps, all of
-- which carry a key, so this cannot touch real routing — and if some other
-- keyless entry ever appears, it is left alone and reported rather than deleted
-- on a guess.

DO $do$
DECLARE
  v_bad   int;
  v_fixed int;
BEGIN
  SELECT count(*), coalesce(sum(n), 0)
    INTO v_bad, v_fixed
    FROM (
      SELECT s.pr_id,
             (SELECT count(*) FROM jsonb_array_elements(s.steps) e
               WHERE e->>'key' IS NULL AND e->>'when' = 'revertToHod') AS n
        FROM workflow.pr_workflow_snapshot s
    ) t
   WHERE t.n > 0;

  IF v_bad = 0 THEN
    RETURN;   -- already clean: leave every row untouched
  END IF;

  UPDATE workflow.pr_workflow_snapshot s
     SET steps = COALESCE((
           SELECT jsonb_agg(e)
             FROM jsonb_array_elements(s.steps) e
            WHERE NOT (e->>'key' IS NULL AND e->>'when' = 'revertToHod')
         ), '[]'::jsonb),
         snapshot_at = now()
   WHERE EXISTS (
     SELECT 1 FROM jsonb_array_elements(s.steps) e
      WHERE e->>'key' IS NULL AND e->>'when' = 'revertToHod'
   );

  RAISE NOTICE '062: stripped % keyless revert_to_hod entries from % snapshot(s)', v_fixed, v_bad;
END $do$;

-- ── Post-flight ────────────────────────────────────────────────────────────
DO $do$
DECLARE v_left int; v_other int;
BEGIN
  SELECT count(*) INTO v_left
    FROM workflow.pr_workflow_snapshot s, LATERAL jsonb_array_elements(s.steps) e
   WHERE e->>'key' IS NULL AND e->>'when' = 'revertToHod';
  IF v_left <> 0 THEN
    RAISE EXCEPTION '062: % keyless revert_to_hod entries survived', v_left;
  END IF;

  -- Anything still keyless is NOT ours. It must be left in place — and this
  -- asserts we did, rather than trusting the WHERE clause above.
  SELECT count(*) INTO v_other
    FROM workflow.pr_workflow_snapshot s, LATERAL jsonb_array_elements(s.steps) e
   WHERE e->>'key' IS NULL AND COALESCE(e->>'when', '') <> 'revertToHod';
  IF v_other <> 0 THEN
    RAISE NOTICE '062: % pre-existing keyless entries (not revert steps) left untouched', v_other;
  END IF;

  -- The prototype's steps must all still be there, with their keys.
  --
  -- Only asserted when there ARE snapshots to have damaged. The rebuild above
  -- can only touch snapshots that carried a keyless revert_to_hod entry, and
  -- on a database with no frozen snapshots at all there is nothing it could
  -- have removed. The unguarded form of this test read "no snapshot exists
  -- that is fully keyed" as "the rebuild removed too much", which is true of
  -- an EMPTY table and false of every database that actually holds snapshots.
  -- Where snapshots do exist, the assertion is unchanged: at least one of them
  -- must still carry all of its keys.
  IF EXISTS (
    SELECT 1 FROM workflow.pr_workflow_snapshot s
     WHERE jsonb_array_length(s.steps) > 0
  )
  AND NOT EXISTS (
    SELECT 1 FROM workflow.pr_workflow_snapshot s
     WHERE jsonb_array_length(s.steps) > 0
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(s.steps) e WHERE e->>'key' IS NULL)
  ) THEN
    RAISE EXCEPTION '062: no snapshot is left fully keyed — the rebuild removed too much';
  END IF;
END $do$;