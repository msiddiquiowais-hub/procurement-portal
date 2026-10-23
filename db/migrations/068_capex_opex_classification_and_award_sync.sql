-- 068_capex_opex_classification_and_award_sync.sql
--
-- WHAT THIS MIGRATION DOES, IN ONE PARAGRAPH
-- ------------------------------------------
-- The per-line Capex/Opex class is a column that exists (migration 022) and a
-- vocabulary that exists (packages/d365-client, CLASSIFICATIONS) and a D365
-- payload that consumes it — and NOTHING in the light flow ever wrote it. 1498
-- light PRs, 1910 lines, zero classified; the 287 classified lines all belong
-- to the legacy capital flow, which is the one path that refuses an
-- unclassified line at the door. Meanwhile the comparative statement's exit
-- (the `cs_review` step) advanced the PR to Cost approval without writing
-- the winning rates back to proc.pr_lines, so the cost gate could never be
-- satisfied and 35 PRs sat at Cost approval with an UNKNOWN amount and a
-- statement that was never locked.
--
-- This migration adds the columns that make the class a RECORD rather than a
-- guess (who decided it, when, from what, and how long the asset lives), and
-- it moves the `requiresCapexOpex` flag from the two Finance steps to the CS
-- exit, where the class is actually made.
--
-- ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────
-- It does not rewrite the `classification` values that exist, and it does not
-- touch comparative_statements. The 287 capital-flow classifications keep
-- their values and gain an author backfilled from the PR's requester, which
-- is who set them (the capital create screen refused to accept a PR whose
-- lines were not classified, so the requester or their delegate chose).
--
-- ── THE approved-line rule ────────────────────────────────────────────────
-- The header amount and the cost gate both count APPROVED lines only
-- (approved AND NOT rejected AND NOT held). A held line is not being bought
-- in this round and will never carry a vendor rate; demanding a price on it
-- is a constraint against a line that does not exist yet. This is the rule the
-- business approved on 2026-10-21 and it is applied in ONE place
-- (apps/api/src/sourcing/award.sync.ts) so the gate, the header total and the
-- screen cannot disagree about which lines count.

BEGIN;

-- ─── 1 · proc.pr_lines — the classification becomes a record ────────────────
--
-- `classification` alone is a value with no author. Every write to it now
-- carries who wrote it, when, and which route produced it, so "the laptop was
-- capitalised" is an answer somebody gave rather than a column somebody
-- happened to fill.
ALTER TABLE proc.pr_lines
  ADD COLUMN IF NOT EXISTS classified_by        uuid REFERENCES core.users(id),
  ADD COLUMN IF NOT EXISTS classified_at        timestamptz,
  ADD COLUMN IF NOT EXISTS classification_source text,
  ADD COLUMN IF NOT EXISTS useful_life_years    integer,
  -- The requester's own pre-RFQ budget guess, preserved.
  --
  -- The award sync writes the winning rate into `unit_price_est`, which is
  -- what the cost gate reads — so after the sync the estimate column holds
  -- the AWARDED rate, and the requester's guess would be gone. The Cost
  -- approval screen exists to compare a budget against a commitment, and
  -- "A confirmed cost nobody compared against the budget is a rubber stamp"
  -- (apps/web/pages/pr/[id].tsx). This column is the budget, kept so that
  -- comparison survives the sync. It is written ONCE, at the first sync, and
  -- never overwritten.
  ADD COLUMN IF NOT EXISTS budget_unit_price   numeric;

COMMENT ON COLUMN proc.pr_lines.classified_by IS
  'Who set the Capex/Opex class. NULL only on a line that has no class.';
COMMENT ON COLUMN proc.pr_lines.classification_source IS
  'manual | create | award-sync — how the class on this line was arrived at.';
COMMENT ON COLUMN proc.pr_lines.useful_life_years IS
  'Depreciation life for a capitalised line. The D365 payload reads it (d365.payload.ts) and falls back to the prototype policy default of 4 years when it is NULL, so before this column EVERY capital line silently took the default.';
COMMENT ON COLUMN proc.pr_lines.budget_unit_price IS
  'The requester''s pre-RFQ budget guess, captured once when the award sync first overwrites unit_price_est. Never overwritten afterwards.';

-- ─── 2 · backfill the existing classifications ─────────────────────────────
--
-- The 287 classified lines predate the audit columns. Their author is the
-- PR's requester, because the capital create screen refused to store a PR
-- whose lines were not classified — the classification was made on the create
-- screen, by the person raising the requisition, at the moment the PR was
-- raised. `pr.created_at` is that moment.
--
-- A Capex line needs a life. The existing capital lines get the prototype's
-- own policy default (4 years, d365.payload.ts DEFAULT_USEFUL_LIFE_YEARS) so
-- that the D365 payload's behaviour is unchanged for them — before this
-- column they all took that default anyway, and now they take it EXPLICITLY
-- instead of by accident.
UPDATE proc.pr_lines pl
   SET classified_by = pr.requester_user_id,
       classified_at = pr.created_at,
       classification_source = COALESCE(pl.classification_source, 'create'),
       useful_life_years = CASE
         WHEN pl.classification LIKE 'CAPEX%'
           THEN COALESCE(pl.useful_life_years, 4)
         ELSE pl.useful_life_years
       END
  FROM proc.purchase_requisitions pr
 WHERE pr.id = pl.pr_id
   AND pl.classification IS NOT NULL
   AND (pl.classified_by IS NULL OR pl.classification_source IS NULL);

-- ─── 3 · the constraints that make the record honest ───────────────────────
--
-- A class with no author is not a decision. This is a CHECK rather than a
-- trigger because it is a statement about ONE row: a line that carries a
-- classification must carry the author and the moment, and a line that
-- carries neither must carry no class.
ALTER TABLE proc.pr_lines DROP CONSTRAINT IF EXISTS pr_lines_classification_audit_ck;
ALTER TABLE proc.pr_lines ADD CONSTRAINT pr_lines_classification_audit_ck CHECK (
  (classification IS NULL AND classified_by IS NULL AND classified_at IS NULL)
  OR
  (classification IS NOT NULL AND classified_by IS NOT NULL AND classified_at IS NOT NULL)
);

-- A capitalised line is an asset, and an asset has a life. Without one the
-- D365 payload falls back to a default, which is exactly the "nobody decided
-- this" state the column exists to prevent.
ALTER TABLE proc.pr_lines DROP CONSTRAINT IF EXISTS pr_lines_capex_needs_life_ck;
ALTER TABLE proc.pr_lines ADD CONSTRAINT pr_lines_capex_needs_life_ck CHECK (
  classification IS NULL
  OR classification NOT LIKE 'CAPEX%'
  OR (useful_life_years IS NOT NULL AND useful_life_years > 0)
);

-- ─── 4 · workflow.steps_config — the CS module takes its ladder position ───
--
-- ORDER IS A PRIORITY LIST, NOT A LADDER.
--
-- The engine takes the FIRST candidate whose condition matches, in
-- order_index order (packages/workflow-engine/src/engine.ts). So order_index
-- answers "which step wins when two of them could match?", and it cannot
-- answer "which step is number 5 of the progression?" — those are different
-- questions and the ten-step ladder the product shows is the second one.
--
-- The order below therefore keeps every decision-driven step AHEAD of the
-- `always` step that shares its stage, which is the only invariant the engine
-- actually depends on. Moving a step without preserving that invariant does
-- not make the ladder prettier; it makes a branch unreachable, because the
-- `always` step matches first and the decision step is never evaluated.
--
-- The two CS steps move to 5 and 6, which is where the ladder puts them.
-- `ready_for_cs` was previously at 16 and `cs_review` at 17.
--
-- Position 7 is RESERVED for `cs_review_quotes`, the same CS exit reached from
-- QUOTES_RECEIVED, seeded by migration 071. It is reserved here rather than
-- renumbered there because this statement is the one that owns the ladder: it
-- already hard-codes every position, so a row inserted at 7 without this file
-- moving out_of_stock off it would collide with out_of_stock on every replay —
-- and the runner replays the whole chain with no ledger of what has been
-- applied. Reserving the slot here means the ladder has exactly one owner and
-- the position exists whether or not the row that uses it has been seeded yet.
-- Everything from out_of_stock down shifts by one as a result.
--
-- This statement is also what makes the migration chain RE-RUNNABLE. Migrations
-- 008 and 053 write order_index with hardcoded numbers, and 060 inserts a step
-- at position 1 and shifts the rest, so applying the chain a second time
-- leaves a duplicated index and a gap. Nothing downstream can rely on the
-- order until somebody states it, and this is that statement.
--
-- The `readyForCs` condition on `ready_for_cs` was NOT in the predicate
-- vocabulary, and evaluatePredicate() coerces an unrecognised keyword to
-- 'always' (packages/workflow-engine/src/predicates.ts). The step was
-- therefore an 'always' step that happened to sit BELOW the `procurement`
-- step that owns the same stage — it never fired, and moving it above
-- `procurement` would have hijacked every advance out of IN_PROCUREMENT_REVIEW
-- and sent the whole flow to QUOTES_RECEIVED. The keyword now exists
-- (predicates.ts), so the step's declared condition is the condition the
-- engine evaluates, and it fails CLOSED.
--
-- `requiresCapexOpex` moves from the two Finance steps to `cs_review`:
--
--   * It was on `finance_review` and `finance_release`, which are LATER than
--     Cost approval. So a PR could reach the cost centre with lines nobody
--     had classified, and the cost centre was asked to approve a spend nobody
--     had said was capital or operating.
--   * The class belongs to the desk that ran the competition and knows what
--     was quoted, and it must be complete BEFORE the cost centre sees the
--     number. That is the CS exit.
--   * `cfo_approval` also carried the flag. It is on the governance branch
--     (QUOTES_RECEIVED -> CS_LOCKED -> MC -> CFO), which never passes through
--     the CS review chain, so a class made at the CS exit does not reach it.
--     The flag there was decoration: nothing read it, and nothing does now.
--     This is a REAL GAP and it is recorded rather than papered over: a PR on
--     the governance branch reaches the CFO with unclassified lines unless the
--     CS lock path classifies them too. Bringing that branch under the same
--     rule is the next piece of work, and it needs the lock path to write
--     classes the way the confirm path now does.
-- The step's key is the ROW ID, not a field in the payload. The payload of a
-- seeded step carries name/actorRole/from/to/when/order/canSkip/terminal and
-- nothing that identifies the step, so `payload->>'key'` is NULL on every row
-- and a CASE written against it writes nothing at all. `id` is the key.
UPDATE workflow.steps_config
   SET order_index = CASE id
         WHEN 'revert_to_hod'      THEN 1
         WHEN 'rework'             THEN 2
         WHEN 'reject'             THEN 3
         WHEN 'fulfilled_stock'    THEN 4
         WHEN 'ready_for_cs'       THEN 5
         WHEN 'cs_review'          THEN 6
         WHEN 'cs_review_quotes'   THEN 7
         WHEN 'out_of_stock'       THEN 8
         WHEN 'warehouse_check'    THEN 9
         WHEN 'hod_review'         THEN 10
         WHEN 'procurement'        THEN 11
         WHEN 'cost_center'        THEN 12
         WHEN 'finance_review'     THEN 13
         WHEN 'finance_release'    THEN 14
         WHEN 'management'         THEN 15
         WHEN 'd365_push'          THEN 16
         WHEN 'mc_approval'        THEN 17
         WHEN 'cfo_approval'       THEN 18
         ELSE order_index
       END,
       payload = jsonb_set(
         jsonb_set(
           payload,
           '{order}',
           to_jsonb(CASE id
             WHEN 'revert_to_hod'      THEN 1
             WHEN 'rework'             THEN 2
             WHEN 'reject'             THEN 3
             WHEN 'fulfilled_stock'    THEN 4
             WHEN 'ready_for_cs'       THEN 5
             WHEN 'cs_review'          THEN 6
             WHEN 'cs_review_quotes'   THEN 7
             WHEN 'out_of_stock'       THEN 8
             WHEN 'warehouse_check'    THEN 9
             WHEN 'hod_review'         THEN 10
             WHEN 'procurement'        THEN 11
             WHEN 'cost_center'        THEN 12
             WHEN 'finance_review'     THEN 13
             WHEN 'finance_release'    THEN 14
             WHEN 'management'         THEN 15
             WHEN 'd365_push'          THEN 16
             WHEN 'mc_approval'        THEN 17
             WHEN 'cfo_approval'       THEN 18
             ELSE order_index
           END)
         ),
         '{requiresCapexOpex}',
         to_jsonb(CASE id WHEN 'cs_review' THEN true ELSE false END)
       )
 -- `cs_review_quotes` is deliberately NOT in the WHERE list. This statement
   -- rewrites `requiresCapexOpex` to "cs_review only" for every row it manages,
   -- which is correct for the seventeen it owns (070 re-arms `procurement`
   -- immediately afterwards) but would strip the gate off the reserved row on
   -- every replay, because 071 only writes its payload when the row is absent.
   -- The slot is reserved here; the row is owned by 071.
 WHERE id IN (
   'revert_to_hod','reject','fulfilled_stock','rework','ready_for_cs','cs_review',
   'out_of_stock','warehouse_check','hod_review','procurement','cost_center',
   'finance_review','finance_release','management','d365_push','mc_approval','cfo_approval'
 );

-- ─── 5 · the gate's own vocabulary ──────────────────────────────────────────
--
-- `core.settings` carries the live business values the app reads instead of
-- hardcoding them. The Capex/Opex gate is armed from the moment it goes live:
-- a PR that entered the CS step BEFORE that moment is not held to it, which is
-- what "forward-only" means in practice. Without this, every PR that already
-- passed step 5 would be refused at a gate it was never subject to.
INSERT INTO core.settings
  (key, value, value_type, label, description, group_name, is_toggle, canonical_source, sort_order, updated_at)
VALUES (
  'capex_opex_gate_from',
  to_jsonb(now()),
  'string',
  'Capex/Opex gate start',
  'Timestamp from which the per-line Capex/Opex gate applies. A PR that entered the CS step before this moment is exempt; one that entered after it must have every approved line classified before it can cross into Cost approval.',
  'Sourcing',
  false,
  'migration 068',
  50,
  now()
)
ON CONFLICT (key) DO UPDATE
   SET value = EXCLUDED.value,
       label = EXCLUDED.label,
       description = EXCLUDED.description,
       updated_at = now();

-- ─── 6 · verification ───────────────────────────────────────────────────────
DO $$
DECLARE
  n int;
BEGIN
  -- The flag must never sit on a step that lands AFTER cost approval.
  --
  -- This used to read "exactly one step is flagged, and it is the CS exit".
  -- That was true when written and stopped being true twice: 070 added the
  -- gate to `procurement` (the second door out of Step 4) and 071 added
  -- `cs_review_quotes` (the CS exit reached from QUOTES_RECEIVED). A count is
  -- a statement about the number of doors, not about whether they are locked,
  -- and every door added since has made this file fail on the second run of
  -- the chain.
  --
  -- What actually matters, and survives another door being opened, is the
  -- direction the flag points: a step that ARRIVES at cost approval may demand
  -- a classification; a step that continues past it may not, because the cost
  -- centre has already approved the number. That is the failure this whole
  -- migration was about — the flag used to sit on finance_review and
  -- finance_release, which are later than cost approval.
  -- A step that continues past the point where the class is settled may not
  -- carry the flag. The stages below are the ones that come AFTER the
  -- classification has been demanded and satisfied.
  --
  -- IN_FINANCE_REVIEW is NOT among them, and that is deliberate. While the
  -- cost-centre approval still existed, the flag was demanded on the doors
  -- INTO cost approval, and IN_FINANCE_REVIEW sat safely behind it. Migration
  -- 075 then retired the cost-approval step entirely and moved the CS and
  -- procurement doors to point straight at IN_FINANCE_REVIEW -- so
  -- IN_FINANCE_REVIEW is now the stage where the classified number FIRST
  -- lands, and the demand belongs on the doors into it. Listing it as "past
  -- cost approval" forbade the correct configuration after 075 had run, and
  -- made this file fail on the second run of any database it had created.
  --
  -- The invariant this check actually protects is unchanged: the flag must not
  -- sit on a step that continues PAST the first finance gate.
  SELECT count(*) INTO n
    FROM workflow.steps_config
   WHERE payload->>'requiresCapexOpex' = 'true'
     AND (payload->>'to')::text IN (
           'IN_MANAGEMENT_REVIEW','READY_FOR_D365','D365_PUSHED',
           'MC_APPROVED','CFO_APPROVED','PACK_LOCKED','Fulfilled','REJECTED','FULFILLED_FROM_STOCK');
  IF n <> 0 THEN
    RAISE EXCEPTION
      'migration 068: % step(s) past the finance gate carry requiresCapexOpex — the class must be '
      'settled before finance sees the number, not after', n;
  END IF;

  SELECT count(*) INTO n
    FROM workflow.steps_config
   WHERE id = 'cs_review' AND payload->>'requiresCapexOpex' = 'true';
  IF n <> 1 THEN
    RAISE EXCEPTION 'migration 068: cs_review must carry the requiresCapexOpex flag';
  END IF;

  -- The two CS steps hold ladder positions 5 and 6.
  SELECT count(*) INTO n
    FROM workflow.steps_config
   WHERE (id = 'ready_for_cs' AND order_index = 5)
      OR (id = 'cs_review'    AND order_index = 6);
  IF n <> 2 THEN
    RAISE EXCEPTION 'migration 068: the CS steps are not at ladder positions 5 and 6';
  END IF;

  -- No two steps share an order_index: the engine sorts by it, and a tie
  -- makes the winner depend on the sort's stability.
  SELECT count(*) INTO n FROM (
    SELECT order_index FROM workflow.steps_config
     GROUP BY order_index HAVING count(*) > 1
  ) d;
  IF n <> 0 THEN
    RAISE EXCEPTION 'migration 068: duplicate order_index values remain';
  END IF;

  -- The steps this migration owns are all still there. Counted as a floor, not
  -- an equality: 071 adds a row after this file runs, and the runner replays
  -- the chain on every deployment, so "exactly 17" made this file fail the
  -- second time it was ever executed. Which steps are required is asserted by
  -- key, two checks above; how many there are in total is not this file's
  -- claim to make.
  --
  -- The floor is RELATIVE to the ladder this migration works with rather than
  -- an absolute count taken from one estate: the fifteen steps every
  -- deployment carries, plus the CS exit this chain adds, is sixteen. The
  -- absolute form counted a step the seeded ladder does not contain, and so
  -- aborted the first deploy of a fresh environment.
  SELECT count(*) INTO n FROM workflow.steps_config;
  IF n < 16 THEN
    RAISE EXCEPTION 'migration 068: expected at least 16 routing steps, found %', n;
  END IF;

  -- Every pre-existing classification now has an author.
  SELECT count(*) INTO n
    FROM proc.pr_lines
   WHERE classification IS NOT NULL
     AND (classified_by IS NULL OR classified_at IS NULL);
  IF n <> 0 THEN
    RAISE EXCEPTION 'migration 068: % classified line(s) have no author', n;
  END IF;

  -- Every pre-existing capital line has a life.
  SELECT count(*) INTO n
    FROM proc.pr_lines
   WHERE classification LIKE 'CAPEX%' AND useful_life_years IS NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION 'migration 068: % capital line(s) have no useful life', n;
  END IF;
END $$;

COMMIT;
