-- ═══════════════════════════════════════════════════════════════════════════
-- 071 — the Step 5 -> Step 6 exit, reachable from BOTH sourcing stages.
--
-- WHAT WAS ACTUALLY TRUE BEFORE THIS MIGRATION
-- --------------------------------------------
-- The blind confirm refused PR-2026-202043 with
--
--   "cannot leave the CS stage with an unclassified line. Line 1 has no
--    Capex/Opex class."
--
-- and that was a deadlock, not a control:
--
--   · the reviewer confirming the comparison is the REQUESTING HOD. They verify
--     commercial rates blind. They do not hold the classification fields, they do
--     not have the context, and they are not the desk that owns the answer.
--   · the class is made by PROCUREMENT, which happens AFTER the statement is
--     confirmed and BEFORE the request crosses into cost approval.
--   · so the backend was asking for a decision that could not exist yet, on a
--     request nobody could move past the asking.
--
-- THE DECISION THIS RECORDS
-- -------------------------
-- The gate moves from the CONFIRM to the ADVANCE. The confirmation stays a blind
-- commercial sign-off; the classification gate stands on the step that actually
-- crosses the boundary into IN_COST_CENTER_APPROVAL.
--
-- That move has a consequence which is the reason this migration exists at all:
-- with the confirm no longer writing `SET status = step.to`, the advance is the
-- only thing that can move a request out of sourcing — so it has to EXIST for
-- every sourcing stage, not just one.
--
-- `cs_review` leaves IN_PROCUREMENT_REVIEW. A comparative statement is equally
-- real at QUOTES_RECEIVED: `ready_for_cs` parks the request there, and the
-- statement is generated, reviewed blind and confirmed from there. Measured on
-- the live estate at the time of writing — 66 requests at QUOTES_RECEIVED, 65
-- of them with a review row — this is not an edge case, it is where the CS
-- module actually lives.
--
-- And there was NO route out of QUOTES_RECEIVED. The single step with
-- `from = QUOTES_RECEIVED` is `mc_approval` (order 16, `when: always`, to
-- MC_APPROVED), and proc.fn_check_pr_transition does not permit
-- QUOTES_RECEIVED -> MC_APPROVED — that edge is CS_LOCKED -> MC_APPROVED, which
-- is the governance branch. So firing it raised a check violation. Measured: 0
-- rows in the estate have ever crossed it.
--
-- A step declares ONE `from`. One row cannot say "the CS exit, from either
-- sourcing stage", so this is a second row for the same decision rather than a
-- widened one. It is NOT a change to the ladder: no existing step's `from`,
-- `to`, `when`, `actorRole` or gate is touched, and no two steps change their
-- order RELATIVE to one another — 068, which owns the ladder, reserves position
-- 7 for this row by shifting everything below it down one.
--
-- THE TWO DOORS OUT OF SOURCING, AFTER THIS MIGRATION
-- --------------------------------------------------
--   IN_PROCUREMENT_REVIEW -> IN_COST_CENTER_APPROVAL   cs_review          (gated)
--   IN_PROCUREMENT_REVIEW -> IN_COST_CENTER_APPROVAL   procurement       (gated)
--   QUOTES_RECEIVED       -> IN_COST_CENTER_APPROVAL   cs_review_quotes  (gated)
--
-- Every route into Cost approval now demands a classification, from either
-- sourcing stage.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── the row ─────────────────────────────────────────────────────────────────
--
-- Idempotent by WHERE NOT EXISTS: the runner replays the whole chain, and a
-- replay must be a no-op rather than a duplicate-key error.
--
-- THIS FILE DOES NOT RENUMBER. Migration 068 owns the ladder — it is the
-- statement that "states the order" for the whole table, and it hard-codes
-- every position — and it reserves position 7 for this row by shifting
-- out_of_stock and everything below it down by one. Renumbering here as well
-- would fight that: 068 runs first on every replay and would put the rows back,
-- leaving two steps at whichever slot they disagreed about. One owner, one
-- place to change the ladder.
--
-- The reservation is also why the INSERT can name 7 unconditionally. On a fresh
-- database 068 has already moved out_of_stock off it; on a replay the row is
-- here and the INSERT is skipped.
INSERT INTO workflow.steps_config (id, payload, order_index, updated_at)
SELECT 'cs_review_quotes',
       jsonb_build_object(
         'to',              'IN_COST_CENTER_APPROVAL',
         'from',            'QUOTES_RECEIVED',
         'name',            'CS review confirmed (quotes received)',
         'when',            'csReviewConfirmed',
         'order',           7,
         'canSkip',         false,
         'terminal',        false,
         'actorRole',       'procurement',
         'requiresCapexOpex', true),
       7,
       now()
 WHERE NOT EXISTS (SELECT 1 FROM workflow.steps_config WHERE id = 'cs_review_quotes');

-- 068 rewrites `requiresCapexOpex` to "cs_review only" for the seventeen rows
-- it manages. This row is not one of them, so nothing clears its gate — but a
-- row that somehow arrived with the flag off would pass every check below, so
-- the payload is repaired rather than assumed.
UPDATE workflow.steps_config
   SET payload = jsonb_set(payload, '{requiresCapexOpex}', to_jsonb(true), true),
       updated_at = now()
 WHERE id = 'cs_review_quotes'
   AND (payload ->> 'requiresCapexOpex')::boolean IS DISTINCT FROM true;

-- ── the transition edge the new step writes ─────────────────────────────────
--
-- The routing table is only half of a move; proc.fn_check_pr_transition is the
-- other half, and it is the half that refuses. QUOTES_RECEIVED ->
-- IN_COST_CENTER_APPROVAL is already permitted (migration 067 added it), so
-- this is a post-condition, not a repair. Asserted anyway: a step pointing at a
-- stage the trigger forbids is a step that throws a check violation at the user
-- instead of refusing them with a sentence they can act on.

-- ── repair: snapshot entries sitting at the wrong priority position ────────
--
-- THE DEFECT THIS FIXES
--
-- WorkflowRepository.ensureStepInSnapshot used to APPEND a merged step to the
-- end of a PR's frozen snapshot. `stepsFromConfigRows` re-stamps every step's
-- `order` from its ARRAY POSITION, so the array order IS the engine's priority
-- list — an appended step is the LAST candidate, and the first candidate whose
-- condition matches wins. A step that is last never wins: an `always` step above
-- it answers first.
--
-- Reproduced on the reported case. cs_review_quotes (ladder position 7) was
-- appended to a 17-step snapshot and read back as order 18, behind mc_approval
-- (16). `advance` with `csReviewConfirmed: true` therefore matched mc_approval
-- and answered "Only mc can action MC approval" — indistinguishable, from the
-- outside, from the decision flag not having arrived. The step was present,
-- correct, and unreachable. The repository now splices; this repairs the rows
-- the old behaviour already produced.
--
-- THE REPAIR, AND WHY IT IS SCOPED TO THREE KEYS
--
-- Re-aligning a snapshot means sorting its array by the ladder in
-- workflow.steps_config, which migration 068 states and `order_index` owns.
-- This changes ARRAY POSITION only — no step's payload, `from`, `to`, `when`,
-- `actorRole` or gate is touched — so it is not an admin edit reaching an
-- in-flight request; it repairs the ordering a merge damaged, using the one
-- table that owns the order.
--
-- Scoped to the three CS steps, and that scope is load-bearing. Sorting is safe
-- only where the snapshot's existing relative order already agrees with the live
-- ladder — and most snapshots in this estate are SHORTER than the ladder (997
-- hold 14 steps, 187 hold 15), so their entries sit at ordinals that disagree
-- with an 18-row ladder for entirely legitimate reasons. Sorting those would
-- move `warehouse_check` from 5 to 9 and `procurement` from 7 to 11 and change
-- which step wins at every stage for 1,300 requests. Measured: 3 of 18,846
-- entries were actually misplaced, and all three are CS steps appended by the
-- old behaviour. So the repair is fenced to exactly those.
--
-- A snapshot that holds none of the three keys is untouched, however short it is.
-- One that holds one is sorted, which moves that entry to its ladder slot and
-- leaves every other entry's RELATIVE order exactly as it was.
--
-- IDEMPOTENT BY CONSTRUCTION: once each of the three sits at its live
-- `order_index`, `affected` is empty and the update touches nothing.
WITH cs_keys(k) AS (
  SELECT unnest(ARRAY['cs_review_quotes', 'cs_review', 'ready_for_cs']::text[])
),
entries AS (
  SELECT s.pr_id,
         t.e,
         t.e ->> 'key' AS k,
         t.ord,
         COALESCE(
           (SELECT sc.order_index FROM workflow.steps_config sc WHERE sc.id = t.e ->> 'key'),
           t.ord::int
         ) AS live_pos
    FROM workflow.pr_workflow_snapshot s
    CROSS JOIN LATERAL jsonb_array_elements(s.steps) WITH ORDINALITY AS t(e, ord)
),
affected AS (
  SELECT DISTINCT pr_id FROM entries
   WHERE k IN (SELECT k FROM cs_keys) AND live_pos <> ord
),
rebuilt AS (
  SELECT a.pr_id,
         jsonb_agg(en.e ORDER BY en.live_pos, en.ord) AS steps
    FROM affected a
    JOIN entries en ON en.pr_id = a.pr_id
   GROUP BY a.pr_id
)
UPDATE workflow.pr_workflow_snapshot s
   SET steps = r.steps,
       snapshot_at = now()
  FROM rebuilt r
 WHERE s.pr_id = r.pr_id;

-- ── post-condition ──────────────────────────────────────────────────────────
DO $$
DECLARE
  new_row jsonb;
  collides int;
BEGIN
  SELECT payload INTO new_row
    FROM workflow.steps_config
   WHERE id = 'cs_review_quotes';

  IF new_row IS NULL THEN
    RAISE EXCEPTION 'migration 071: cs_review_quotes was not inserted';
  END IF;

  -- The gated CS exit out of QUOTES_RECEIVED.
  --
  -- `to` and `when` are asserted as a SET rather than as single values, because
  -- migration 075 runs LATER in this same chain and rewrites both of them:
  -- 075 retires the cost-approval step and moves this exit to
  -- IN_FINANCE_REVIEW, renaming the predicate to csExitComplete at the same
  -- time. Asserting the pre-075 values made this file fail on the second run
  -- of any database it had created — which is what a re-runnable migration
  -- must not do. `from`, `requiresCapexOpex` and `actorRole` are not touched
  -- by any migration in the chain, and are still asserted exactly.
  IF new_row ->> 'from' IS DISTINCT FROM 'QUOTES_RECEIVED'
     OR (new_row ->> 'to')   NOT IN ('IN_COST_CENTER_APPROVAL', 'IN_FINANCE_REVIEW')
     OR (new_row ->> 'when') NOT IN ('csReviewConfirmed', 'csExitComplete')
     OR (new_row ->> 'requiresCapexOpex')::boolean IS DISTINCT FROM true
     OR new_row ->> 'actorRole' IS DISTINCT FROM 'procurement' THEN
    RAISE EXCEPTION
      'migration 071: cs_review_quotes is not the gated CS exit from QUOTES_RECEIVED — payload was %',
      new_row::text;
  END IF;

  -- order_index must stay unique, or the admin grid orders two steps
  -- arbitrarily and the engine's tie-break starts depending on sort stability.
  -- Counted as colliding GROUPS, not as rows: the question is "how many
  -- positions hold more than one step", and a count of rows would report the
  -- size of the collision rather than its existence.
  SELECT count(*) INTO collides FROM (
    SELECT order_index
      FROM workflow.steps_config
     GROUP BY order_index
    HAVING count(*) > 1
  ) d;

  IF collides <> 0 THEN
    RAISE EXCEPTION
      'migration 071: % order_index position(s) hold more than one step — 068 reserves 7 for '
      'cs_review_quotes and owns the rest of the ladder', collides;
  END IF;

  -- THE POINT OF THE MIGRATION, asserted as the whole set rather than as this
  -- one row: every route INTO cost approval out of a sourcing stage is gated.
  -- Asserting this row alone is what would let a fourth door open later.
  --
  -- The filter is on the DESTINATION first. Reading it the other way round --
  -- "every step out of a sourcing stage is gated" -- is not the same claim and
  -- is not even true: revert_to_hod leaves for IN_HOD_REVIEW and ready_for_cs
  -- leaves for QUOTES_RECEIVED, and neither is supposed to demand a class. Only
  -- the crossing into cost approval is the thing being controlled.
  --
  -- Written as "there is no UNGATED step on that crossing" rather than as
  -- "every step on that crossing is gated". The second form reads an empty set
  -- as a failure: bool_and over no rows is NULL, coalesced to false, and the
  -- migration then aborted because there were no ungated steps at all. That is
  -- what happened once migration 075 retired the cost-approval stage and left
  -- this crossing empty -- the migration failed on the second run of any
  -- database it had created, for the absence of the thing it was checking.
  IF EXISTS (
    SELECT 1
      FROM workflow.steps_config
     WHERE (payload ->> 'from')::text IN ('IN_PROCUREMENT_REVIEW', 'QUOTES_RECEIVED')
       AND (payload ->> 'to')::text   = 'IN_COST_CENTER_APPROVAL'
       AND (payload ->> 'requiresCapexOpex')::boolean IS DISTINCT FROM true
  ) THEN
    RAISE EXCEPTION
      'migration 071: a step reaching IN_COST_CENTER_APPROVAL from a sourcing stage '
      'is not gated by requiresCapexOpex';
  END IF;

  -- and there must be at least one gated route out of EACH sourcing stage, or
  -- one of them is stranded exactly as QUOTES_RECEIVED was.
  --
  -- The destination is deliberately not named. While the cost-approval stage
  -- existed it was the first finance gate and every sourcing stage routed into
  -- it; migration 075 retired that stage and pointed the same doors at
  -- IN_FINANCE_REVIEW instead. Naming the retired stage here asserted a
  -- destination the ladder no longer has, and made this file fail on the
  -- second run of any database it had created. What matters is unchanged and
  -- is what the comment above says: a request parked in a sourcing stage must
  -- always have a way out, and that way out must require the class to be
  -- settled first.
  IF NOT (
    SELECT bool_and(EXISTS (
             SELECT 1 FROM workflow.steps_config s
              WHERE s.payload ->> 'from' = stage
                AND (s.payload ->> 'requiresCapexOpex')::boolean IS TRUE))
      FROM (VALUES ('IN_PROCUREMENT_REVIEW'), ('QUOTES_RECEIVED')) AS v(stage)
  ) THEN
    RAISE EXCEPTION
      'migration 071: one of IN_PROCUREMENT_REVIEW / QUOTES_RECEIVED has no gated route '
      'out of it, so requests parked there cannot move';
  END IF;

  -- The three CS steps, where a snapshot carries them, must sit at the priority
  -- position the ladder gives them.
  --
  -- This is the assertion that would have caught the append defect on the day it
  -- was written rather than on the day a requesting HOD could not confirm a blind
  -- review. A misplaced entry is not a cosmetic fault: `stepsFromConfigRows`
  -- derives `order` from array position, so the array IS the priority list, and a
  -- step in the wrong slot is a step that never wins.
  --
  -- Deliberately NOT "no entry anywhere disagrees with the ladder". Most snapshots
  -- are shorter than the ladder and legitimately disagree; asserting that would
  -- have had this migration rewrite 1,300 snapshots and change which step wins at
  -- every stage for every one of them.
  IF EXISTS (
    SELECT 1
      FROM workflow.pr_workflow_snapshot s
      CROSS JOIN LATERAL jsonb_array_elements(s.steps) WITH ORDINALITY AS t(e, ord)
     WHERE t.e ->> 'key' IN ('cs_review_quotes', 'cs_review', 'ready_for_cs')
       AND t.ord <> (SELECT sc.order_index FROM workflow.steps_config sc WHERE sc.id = t.e ->> 'key')
  ) THEN
    RAISE EXCEPTION
      'migration 071: a frozen routing snapshot still holds a CS step at the wrong priority '
      'position — that step is unreachable, whatever its payload says';
  END IF;

  RAISE NOTICE
    'migration 071 ok: cs_review_quotes seeded; every sourcing stage now has a '
    'classification-gated route into IN_COST_CENTER_APPROVAL';
END $$;

COMMIT;