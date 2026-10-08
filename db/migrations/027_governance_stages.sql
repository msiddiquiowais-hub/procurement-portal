-- 027_governance_stages.sql
--
-- Wave 3 step 0 of PROCUREMENT_PORTAL_PORT_GAP_MATRIX.md — Governance.
--
-- WHY THIS MIGRATION EXISTS
-- The prototype's governance chain (STAGES, line 1500 of
-- PROCUREMENT_PORTAL_PROTOTYPE.html) is:
--
--     ... -> QUOTES_RECEIVED -> CS_LOCKED -> MC_APPROVED
--          -> CFO_APPROVED   -> PACK_LOCKED -> D365_PUSHED
--
-- NOT ONE of those five stages existed in purchase_requisitions.status, in
-- proc.fn_check_pr_transition(), or in the workflow engine's Stage union. The
-- four governance stages plus the MC-reject return target were the only parts
-- of the prototype's state machine with no database representation at all.
--
-- This migration adds them. Decision 1A (user, 2026-09-30): the DB value IS
-- STATE.pr.stage. No mapping table, no translation layer — every already-ported
-- screen (the PR timeline, stagePill, the "voting not yet open" toast) starts
-- emitting the prototype's own vocabulary the moment these are storable.
--
-- The three things that must move together (the recurring lesson of migrations
-- 018, 019 and 020):
--     1. the status CHECK constraint
--     2. proc.fn_check_pr_transition()  -- the state machine
--     3. packages/workflow-engine/src/types.ts  -- the TS Stage union
-- (1) and (2) are here. (3) is Wave 3 step 1; verify_027.sql asserts the two
-- SQL vocabularies agree with each other so the gap cannot go unnoticed.

BEGIN;

-- ─── 1 · the MC panel is data, not code ─────────────────────────────────────
-- The prototype hardcodes its five members in renderMCVote (line 7870):
--   ['Dr. Imran Shah','Tariq Saleem','Naila Aziz','Junaid Akhtar','Saba Khan']
-- and mcVote() keys STATE.pr.mcVotes by that name. A hardcoded name list in a
-- service is exactly the kind of thing that is right in a demo and wrong in a
-- system, so the panel becomes rows: a stable seat order (the prototype's list
-- order) plus an explicit chair. mcAutoComplete's "you are Dr. Imran Shah"
-- persona is a consequence of this table, not a hardcoded name.
CREATE TABLE IF NOT EXISTS workflow.mc_panel (
  user_id     uuid PRIMARY KEY REFERENCES core.users(id) ON DELETE CASCADE,
  seat        int  NOT NULL UNIQUE CHECK (seat >= 1),
  chair       boolean NOT NULL DEFAULT false,
  appointed_at timestamptz NOT NULL DEFAULT now()
);

-- Exactly one chair. A panel with two chairs (or none) has no meaning, and the
-- mc_sessions.chair_user_id FK needs a single answer.
CREATE UNIQUE INDEX IF NOT EXISTS ux_mc_panel_single_chair
  ON workflow.mc_panel ((true)) WHERE chair;

-- The panel size is the quorum. Reading it from the table rather than from a
-- constant means "need 5/5" is derived from who is actually appointed.
CREATE OR REPLACE FUNCTION workflow.fn_mc_quorum() RETURNS int AS $$
  SELECT count(*)::int FROM workflow.mc_panel;
$$ LANGUAGE sql STABLE;

COMMENT ON TABLE workflow.mc_panel IS
  'Management Committee panel. One row per member; seat fixes the display order; chair is the persona the prototype hardcodes as the acting member. The quorum is count(*) — the prototype requires unanimity (5/5).';

-- ─── 2 · governance step ids for the vote ledger ───────────────────────────
-- workflow.approval_votes.step_id is a FK into workflow.steps_config(id), so a
-- vote cannot be recorded until its step exists. These two ids are what a
-- governance vote row carries.
INSERT INTO workflow.steps_config (id, payload, order_index) VALUES
  ('mc_approval',  jsonb_build_object(
      'name','MC approval','actorRole','mc','to','MC_APPROVED','when','always',
      'canSkip',false,'requiresCapexOpex',false,'terminal',false,
      'quorum','unanimous','quorumSource','workflow.mc_panel'),
    13),
  ('cfo_approval', jsonb_build_object(
      'name','CFO final approval','actorRole','cfo','to','CFO_APPROVED','when','always',
      'canSkip',false,'requiresCapexOpex',true,'terminal',false),
    14)
ON CONFLICT (id) DO NOTHING;

-- ─── 3 · comparative statements get rounds ─────────────────────────────────
-- Decision 2A (user, 2026-09-30). The prototype's mcVote() reject path
-- (line 7226-7232) clears the votes, sets the stage to QUOTES_RECEIVED and
-- sets csLocked = false, so the CS is REVISED. Wave 2 made the lock terminal
-- instead: comparative_statements was UNIQUE(pr_id), one row per PR, and the
-- locked winner is never rewritten.
--
-- Those two rules only collide on reject. The resolution is rounds: the
-- rejected round is not deleted, it is EVIDENCE. Months later "why did the MC
-- send this back?" has to have an answer, and overwriting round 1 to make room
-- for round 2 destroys it. Every round is an INSERT; a locked round is never
-- updated except by its own lock.
--
-- The column is cs_round, not round: `round` is a built-in function name, and
-- in a PL/pgSQL RETURNING clause a bare `round` parses as a call rather than a
-- column, which is a trap worth not carrying into every future service.
ALTER TABLE proc.comparative_statements
  ADD COLUMN IF NOT EXISTS cs_round int NOT NULL DEFAULT 1;

ALTER TABLE proc.comparative_statements
  DROP CONSTRAINT IF EXISTS comparative_statements_pr_id_key;
ALTER TABLE proc.comparative_statements
  DROP CONSTRAINT IF EXISTS comparative_statements_round_check;
ALTER TABLE proc.comparative_statements
  ADD CONSTRAINT comparative_statements_round_check CHECK (cs_round >= 1);

-- pr_id is no longer unique on its own. The 1:1 guarantee now lives here.
ALTER TABLE proc.comparative_statements
  DROP CONSTRAINT IF EXISTS comparative_statements_pr_round_key;
ALTER TABLE proc.comparative_statements
  ADD CONSTRAINT comparative_statements_pr_round_key UNIQUE (pr_id, cs_round);

-- The "current" CS is the highest round. Exposed as a function rather than a
-- view on purpose: a view would evaluate under the definer's rights and quietly
-- bypass the RLS the rest of the API runs under, whereas a function call in a
-- WHERE clause leaves the base table's policy in force.
CREATE OR REPLACE FUNCTION proc.fn_latest_cs_round(p_pr_id uuid) RETURNS int AS $$
  SELECT max(cs_round) FROM proc.comparative_statements WHERE pr_id = p_pr_id;
$$ LANGUAGE sql STABLE;

CREATE INDEX IF NOT EXISTS idx_cs_pr_round
  ON proc.comparative_statements(pr_id, cs_round DESC);

COMMENT ON COLUMN proc.comparative_statements.cs_round IS
  'Revision round. Round 1 is the first CS; an MC reject opens round 2. Locked rounds are never rewritten — UNIQUE(pr_id, cs_round) is what makes the lock terminal PER ROUND rather than per PR.';

-- ─── 4 · widen the status vocabulary ───────────────────────────────────────
-- v3: the prototype's own governance stages. See the header for why.
SELECT proc.fn_widen_pr_status_check();

-- ─── 5 · the governance state machine ──────────────────────────────────────
-- Every v2 branch is preserved verbatim. The governance branches are additive.
--
--   IN_PROCUREMENT_REVIEW --quotes in-->        QUOTES_RECEIVED
--   IN_PROCUREMENT_REVIEW --CS locked-->         CS_LOCKED
--   IN_PROCUREMENT_REVIEW --CS locked, FAST-->  PACK_LOCKED   (prototype 7205)
--   QUOTES_RECEIVED       --CS locked-->         CS_LOCKED
--   QUOTES_RECEIVED       --revise sourcing-->   IN_PROCUREMENT_REVIEW
--   CS_LOCKED             --MC 5/5 approve-->    MC_APPROVED
--   CS_LOCKED             --any reject-->        QUOTES_RECEIVED  (prototype 7230)
--   MC_APPROVED           --CFO approve-->       CFO_APPROVED
--   MC_APPROVED           --CFO reject-->        CS_LOCKED       (prototype 7275)
--   CFO_APPROVED          --pack locked-->       PACK_LOCKED
--   PACK_LOCKED           --D365 push-->         D365_PUSHED
--
-- Note the two rejects go in OPPOSITE directions, exactly as the prototype has
-- them. MC reject returns to sourcing (the CS must be revised). CFO reject
-- returns to the MC gate (the budget objection is the CFO's, and the MC's
-- unanimous recommendation stands). Collapsing these into one "reject -> back"
-- rule would lose the distinction the prototype is making.
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
    -- ── v3 governance exits from procurement review ──────────────────────
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

    -- ── v3 governance chain ───────────────────────────────────────────────
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
$$ LANGUAGE plpgsql;

-- ─── 6 · read paths for the governance screens ─────────────────────────────
-- The MC screen is a per-PR read of a per-PR vote ledger; the sync log is
-- read newest-first per PR. Both are hot on every screen load in Wave 3.
CREATE INDEX IF NOT EXISTS idx_mc_sessions_pr_open
  ON workflow.mc_sessions(pr_id) WHERE closed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_d365_sync_pr_observed
  ON proc.d365_sync_log(pr_id, observed_at DESC);

-- The pack is locked once per PR; the unique index already carries the lookup.
COMMENT ON FUNCTION proc.fn_latest_cs_round(uuid) IS
  'The CS revision round currently in force for a PR (max round). Callers filter on it rather than reading a view, so RLS on comparative_statements stays in force.';

COMMIT;
