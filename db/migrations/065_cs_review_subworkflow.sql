-- 065 — CS Comparative Statement review sub-workflow.
--
-- Adds a FOUR-STATE REVIEW CHAIN that runs inside the existing procurement
-- stage, without touching any of the 16 existing routing steps.
--
-- ---------------------------------------------------------------------------
-- WHY A NEW TABLE AND NOT A NEW comparative_statements.state
-- ---------------------------------------------------------------------------
-- proc.comparative_statements.state already carries 'Generated' | 'Locked' and
-- is read by governance, award, D365 and the MC panel. Overloading it with four
-- review states would have required rewriting every one of those readers AND
-- would have had to invent a value for all 813 existing rows. Instead the chain
-- lives here, in its own table, and comparative_statements is left exactly as
-- it is. Every existing record keeps working untouched.
--
-- ---------------------------------------------------------------------------
-- THE 16 EXISTING STEPS ARE NOT MODIFIED BY THIS MIGRATION
-- ---------------------------------------------------------------------------
-- The only statement below that writes to workflow.steps_config is a single
-- INSERT of a NEW row at order_index 17. There is no UPDATE and no DELETE
-- against order_index 1..16 anywhere in this file. scripts/e2e_cs_review.mjs
-- re-reads the md5 of all 16 payloads after the full suite and fails if any
-- changed, so this is verified rather than merely asserted.
--
-- ---------------------------------------------------------------------------
-- WHY cs_review GETS ITS OWN PREDICATE KEYWORD
-- ---------------------------------------------------------------------------
-- The predicate vocabulary is CLOSED, and two facts about that closure decide
-- this step's design:
--
--   1. evaluatePredicate() coerces an unrecognised keyword to 'always'
--      (predicates.ts, the `const keyword = isPredicateKeyword(when) ? when :
--      'always'` line). So a made-up keyword is not inert — it is a step that
--      matches on EVERY advance out of its source stage.
--   2. validateStepConfig() REFUSES an unknown keyword outright, and it runs on
--      every admin save of the routing grid. A step seeded with an unknown
--      keyword therefore makes the whole config grid unsaveable.
--
-- So cs_review is seeded with 'csReviewConfirmed', which predicates.ts now
-- recognises explicitly and evaluates as: true only when the advance carries
-- that decision flag, false otherwise. It fails CLOSED — absent the flag it does
-- not match, which is the correct behaviour for a step that must only ever fire
-- from the CS confirmation action and never from an ordinary procurement
-- "approve" click.
--
-- NOTE ON ready_for_cs: that step is seeded with 'readyForCs', which is NOT in
-- the vocabulary. That row is deliberately NOT corrected here — correcting it
-- would rewrite the payload of order_index 16, which is out of scope for this
-- migration and would change its md5. Flagged separately as pre-existing debt.

BEGIN;

-- ─── proc.cs_reviews ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS proc.cs_reviews (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The statement under review. UNIQUE with current_round so one round holds
  -- exactly one review row: a re-review of the same round is an UPDATE of the
  -- chain, not a second competing opinion.
  cs_id                   uuid NOT NULL
                            REFERENCES proc.comparative_statements(id) ON DELETE CASCADE,
  pr_id                   uuid NOT NULL
                            REFERENCES proc.purchase_requisitions(id) ON DELETE CASCADE,

  sub_state               text NOT NULL DEFAULT 'DRAFT'
                            CHECK (sub_state IN ('DRAFT','PROC_REVIEW','REQUESTER_REVIEW','CONFIRMED','REVERTED')),
  current_round           integer NOT NULL DEFAULT 1,

  -- Blind review. True while the statement is awaiting the originating
  -- department's own review, which is the one state where the vendor ranking
  -- and scores are withheld from the reviewer.
  masked_for_requester    boolean NOT NULL DEFAULT false,

  -- Who owns each gate, recorded at the moment the gate opens.
  proc_reviewer_user_id      uuid REFERENCES core.users(id),
  requester_reviewer_user_id uuid REFERENCES core.users(id),

  -- Audit spine. Null until the gate is actually reached; a row that skipped
  -- PROC_REVIEW cannot carry a requester_review timestamp.
  generated_at            timestamptz,
  proc_review_at          timestamptz,
  requester_review_at     timestamptz,
  confirmed_at            timestamptz,
  reverted_at             timestamptz,

  -- Dual revert. SOFT returns the statement for negotiation and leaves the
  -- RFQ and its quotations standing; HARD withdraws the statement so a fresh
  -- round can be solicited. The kind is recorded, not inferred from timestamps.
  revert_kind             text CHECK (revert_kind IN ('SOFT','HARD')),
  revert_reason           text,

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cs_reviews_unique_round UNIQUE (cs_id, current_round),
  -- A revert is a REASON or it is nothing. The service refuses an empty one
  -- before it writes; this constraint means a direct SQL write cannot slip a
  -- null reason past the same check.
  CONSTRAINT cs_reviews_revert_reason CHECK (
    revert_kind IS NULL OR (revert_reason IS NOT NULL AND length(trim(revert_reason)) > 0)
  ),
  -- CONFIRMED is terminal for a round: it must carry the timestamp that proves
  -- the confirmation happened.
  CONSTRAINT cs_reviews_confirmed_needs_timestamp CHECK (
    sub_state <> 'CONFIRMED' OR confirmed_at IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS ix_cs_reviews_cs    ON proc.cs_reviews(cs_id);
CREATE INDEX IF NOT EXISTS ix_cs_reviews_pr    ON proc.cs_reviews(pr_id, current_round DESC);
CREATE INDEX IF NOT EXISTS ix_cs_reviews_state ON proc.cs_reviews(sub_state);

COMMENT ON TABLE proc.cs_reviews IS
  'Four-state CS review chain. Deliberately separate from comparative_statements.state '
  'so all 813 pre-existing statements keep their original values unchanged.';

-- updated_at maintenance. Same shape as the other audit tables in this schema.
CREATE OR REPLACE FUNCTION proc.fn_touch_cs_reviews_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cs_reviews_touch ON proc.cs_reviews;
CREATE TRIGGER trg_cs_reviews_touch
  BEFORE UPDATE ON proc.cs_reviews
  FOR EACH ROW EXECUTE FUNCTION proc.fn_touch_cs_reviews_updated_at();

-- ─── The new routing step ───────────────────────────────────────────────────
--
-- INSERT ONLY. This is the single statement in this migration that touches
-- workflow.steps_config, and it adds a row. It rewrites nothing.
--
-- The payload shape must match stepToPayload() in packages/workflow-engine/src/steps.ts
-- exactly, because normalizeStep() reads these keys back.

INSERT INTO workflow.steps_config (id, payload, order_index, updated_by_user_id, version)
SELECT
  'cs_review',
  jsonb_build_object(
    'name',             'CS review confirmed',
    'actorRole',        'procurement_manager',
    'from',             'IN_PROCUREMENT_REVIEW',
    'to',               'IN_COST_CENTER_APPROVAL',
    'order',            17,
    'when',             'csReviewConfirmed',
    'canSkip',          false,
    'terminal',         false,
    'requiresCapexOpex', false
  ),
  17,
  NULL,
  1
WHERE NOT EXISTS (SELECT 1 FROM workflow.steps_config WHERE id = 'cs_review');

-- ─── Self-check ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_total  integer;
  v_ones   integer;
  v_step   record;
BEGIN
  -- A FLOOR, not an equality, for the same reason the ORDER is not asserted
  -- below: the runner replays the whole chain on every deployment, and later
  -- migrations in the chain both ADD steps (071 adds cs_review_quotes) and
  -- REMOVE them (075 retires cost_center), so the total moves in both
  -- directions.
  --
  -- The floor is therefore expressed RELATIVE to what this migration
  -- guarantees -- the fifteen steps it names below, plus the one it adds --
  -- rather than as an absolute count taken from one estate. The absolute
  -- form ("at least 17") described a particular ladder and failed on a
  -- freshly seeded database, where the ladder holds the fifteen named steps
  -- and this migration's own step is the sixteenth.
  SELECT count(*) INTO v_total FROM workflow.steps_config;
  IF v_total < 16 THEN
    RAISE EXCEPTION 'expected at least 16 steps after migration 065, found %', v_total;
  END IF;

  -- The fifteen pre-existing step KEYS must all still be present. The ORDER is
  -- deliberately not asserted here.
  --
  -- `cost_center` is NOT in this list, and that is deliberate. Migration 075
  -- retires it -- the CS exit now goes straight to finance review -- and 075
  -- runs LATER in this same chain. Listing it here asserted that a step a
  -- later migration removes was still present, which made the chain fail on
  -- its second run: exactly what a re-runnable migration must not do. The
  -- fifteen steps below are the ones no later migration in this chain removes.
  SELECT count(*) INTO v_ones
    FROM workflow.steps_config
   WHERE id IN ('revert_to_hod','rework','reject','fulfilled_stock','out_of_stock',
                'warehouse_check','hod_review','procurement','finance_review',
                'finance_release','management','d365_push','mc_approval','cfo_approval','ready_for_cs');
  IF v_ones <> 15 THEN
    RAISE EXCEPTION 'expected the 15 pre-existing steps to still be present, found %', v_ones;
  END IF;

  -- The new step must be the one row this migration adds, and it must still
  -- carry the shape the chain leaves it in.
  --
  -- What is asserted here is deliberately limited to the properties that hold
  -- across the WHOLE chain, not only at the moment 065 runs. Two later
  -- migrations in this same chain are entitled to re-point attributes of this
  -- step, and each asserts the result in its own post-condition:
  --
  --   070 rebinds actorRole   procurement_manager -> hod   (asserts 'hod')
  --   075 rewrites to / when   -> IN_FINANCE_REVIEW / csExitComplete
  --
  -- Asserting the pre-070 and pre-075 values made 065 fail on the second run
  -- of any database it had ever created -- which is what a re-runnable
  -- migration must not do. Worse, the actorRole test below contradicted this
  -- file's OWN INSERT, which writes 'procurement_manager': 065 created the
  -- step and then refused the step it had just created, so the migration could
  -- not succeed on any database where it actually had work to do.
  --
  -- The rule, kept from the note above: assert the shape the step must keep,
  -- and leave the attributes a later migration is entitled to re-point to that
  -- migration's own post-condition.
  SELECT * INTO v_step FROM workflow.steps_config WHERE id = 'cs_review';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cs_review was not added to the ladder';
  END IF;

  -- `from` and `name` are not rewritten by any migration in this chain.
  IF v_step.payload->>'from' <> 'IN_PROCUREMENT_REVIEW'
     OR v_step.payload->>'name' <> 'CS review confirmed' THEN
    RAISE EXCEPTION 'cs_review is not the step this migration adds: %', v_step.payload;
  END IF;

  -- `to` is IN_COST_CENTER_APPROVAL until 075 retires the cost-center door,
  -- and IN_FINANCE_REVIEW after it. Both are real approval stages; anything
  -- else means the routing was corrupted.
  IF coalesce(v_step.payload->>'to','') NOT IN ('IN_COST_CENTER_APPROVAL','IN_FINANCE_REVIEW') THEN
    RAISE EXCEPTION 'cs_review targets an unknown stage: %', v_step.payload;
  END IF;

  -- A fail-closed keyword must be present. 065 writes 'csReviewConfirmed' and
  -- 075 rewrites it to 'csExitComplete'; both are real predicates, and an
  -- absent `when` would let the step fire unconditionally.
  IF coalesce(v_step.payload->>'when','') NOT IN ('csReviewConfirmed','csExitComplete') THEN
    RAISE EXCEPTION 'cs_review has no fail-closed keyword: %', v_step.payload;
  END IF;

  -- The actor must be one of the two roles this step has ever legitimately
  -- been owned by: 'procurement_manager' until 070 rebinds it, 'hod' after.
  -- 070 owns the final binding and asserts it; this rejects only a corrupted
  -- or unknown actor, and does not forbid 070's rebind.
  IF coalesce(v_step.payload->>'actorRole','') NOT IN ('procurement_manager','hod') THEN
    RAISE EXCEPTION 'cs_review is owned by an unknown role: %', v_step.payload;
  END IF;

  RAISE NOTICE '065 applied: 15 original steps intact, cs_review added at order_index 17';
END $$;

COMMIT;