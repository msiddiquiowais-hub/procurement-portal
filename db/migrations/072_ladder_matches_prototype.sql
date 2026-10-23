-- 072 — the ladder, corrected against the prototype it was ported from
--
-- Two steps in workflow.steps_config no longer match the prototype's own
-- DEFAULT_WORKFLOW_STEPS (PROCUREMENT_PORTAL_PROTOTYPE.html:1891-1918), and both
-- errors push in the same direction: they put a GOVERNANCE GATE on a step that
-- was never meant to carry one, so a request can be held by a desk it was never
-- meant to reach.
--
-- ── 1. `procurement` must not require a Capex/Opex class ────────────────────
--
-- The prototype, line 1912, verbatim:
--
--   { id:'procurement', name:'Procurement review', actorRole:'procurement',
--     to:'IN_COST_CENTER_APPROVAL', when:'always', canSkip:false,
--     requiresCapexOpex:false, terminal:false },
--
-- The live row has requiresCapexOpex = true. The prototype puts the Capex/Opex
-- gate on the FINANCE band, keyed on amount instead:
--
--   { id:'finance_review',  when:'amountGT',  conditionValue:1000000, requiresCapexOpex:true },
--   { id:'finance_release', when:'amountLTE', conditionValue:1000000, requiresCapexOpex:true },
--
-- …which is the same 1,000,000 the admin screen shows as "Management gate
-- threshold (PKR)".
--
-- WHAT THE TICK BOX COST
-- ----------------------
-- `procurement` is the ALWAYS step out of IN_PROCUREMENT_REVIEW into
-- IN_COST_CENTER_APPROVAL. Carrying requiresCapexOpex made it the ONLY gate on
-- that crossing: `advance()` checks `plan.step.requiresCapexOpex` and refuses an
-- unclassified line, and nothing else on that path requires an RFQ or a
-- comparative statement. So a procurement officer could take a request from
-- Procurement review straight to Cost approval with no RFQ issued, no quotations
-- and no CS — and the Capex/Opex card opened on the screen to invite them to.
--
-- It also opened at the wrong moment even where it was not a hole: the card's own
-- copy said "the request cannot leave the CS step", on a request that had not
-- reached the CS step.
--
-- This is a CONFIG correction, not a code change — the admin grid's CAPEX/OPEX
-- checkbox (prototype line 10212) invites exactly this edit, and nothing in the
-- application was wrong; the value was wrong.
--
-- ── 2. `mc_approval` must be earned, not defaulted ──────────────────────────
--
-- `mc_approval` is `when: 'always'` out of QUOTES_RECEIVED into MC_APPROVED.
-- That is a second permanent door out of the same stage as `cs_review_quotes`,
-- and `cs.service.ts` decides the MC vote off it:
--
--   const routing = c.routing_key || 'STANDARD';
--   const skipMc   = routing === 'FAST_TRACK';
--
-- so EVERY locked statement asked for an MC vote, whatever it was worth. On
-- PR-2026-202043 — PKR 139.73, and `fn_derive_routing(135, 0, 135)` says
-- FAST_TRACK — the CS screen read "Awaiting the MC vote before an approved pack
-- can be locked".
--
-- It is now gated on `aboveMgtThreshold`, the predicate that reads the admin
-- setting `workflow.config.management_threshold` (1,000,000). That is the
-- established idiom in this very table: order 13 "Management review (global
-- threshold)" and order 14 "CFO release (below global threshold)" already split
-- the finance band on it. This makes the MC the first step that actually reads
-- the number the admin screen asks people to configure — before this, nothing in
-- the live step set consulted it.
--
-- WHAT CHANGES FOR A SUB-THRESHOLD REQUEST
-- -----------------------------------------
-- At QUOTES_RECEIVED the only remaining match is `cs_review_quotes`
-- (csReviewConfirmed), which is the route Case 18 already takes. Above the
-- threshold both match and order 17 still wins for the MC — so a large request
-- is unchanged. Nothing is stranded: a sub-threshold PR has `cs_review_quotes`
-- waiting at the same stage with a predicate the review chain sets.
--
-- ── ORDERING, WHICH IS THE WHOLE ENGINE ─────────────────────────────────────
--
-- `stepsFromConfigRows` re-stamps every step's `order` from its ARRAY POSITION,
-- so the array is the priority list and the first candidate whose condition
-- matches wins. Editing a step's PAYLOAD in place — which is what this does —
-- does not move it, and deliberately so: neither correction needs a new row, a
-- new position, or a renumbering of anything else. An `always` step sitting
-- ABOVE a unique-condition step would steal the queue, so this migration asserts
-- the relative order it depends on rather than assuming it.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. `procurement` — drop the Capex/Opex gate, per prototype line 1912
-- ═══════════════════════════════════════════════════════════════════════════
UPDATE workflow.steps_config
   SET payload = jsonb_set(payload, '{requiresCapexOpex}', 'false'::jsonb, true),
       updated_at = now()
 WHERE payload->>'name' = 'Procurement review'
   AND payload->>'from'  = 'IN_PROCUREMENT_REVIEW'
   AND payload->>'to'    = 'IN_COST_CENTER_APPROVAL'
   AND payload->>'when'  = 'always'
   AND COALESCE((payload->>'requiresCapexOpex')::boolean, false) IS DISTINCT FROM false;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. `mc_approval` — gate it on the admin-configured management threshold
--
-- `conditionValue` is REMOVED rather than set: the validation in
-- `validateStepConfig` refuses a global-threshold step that also carries its own
-- number, because two thresholds for one band is the ambiguity this codebase has
-- already been bitten by (see scripts/prove_workflow_is_dynamic.mjs, which
-- asserts exactly that refusal). The threshold has ONE owner.
-- ═══════════════════════════════════════════════════════════════════════════
UPDATE workflow.steps_config
   SET payload = (payload - 'conditionValue')
                 || jsonb_build_object('when', 'aboveMgtThreshold'),
       updated_at = now()
 WHERE payload->>'name' = 'MC approval'
   AND payload->>'from'  = 'QUOTES_RECEIVED'
   AND payload->>'to'    = 'MC_APPROVED'
   AND payload->>'when'  = 'always';

-- ── post-conditions ────────────────────────────────────────────────────────
--
-- INVARIANTS, NOT COUNTS. The runner replays this whole chain on every
-- deployment, so anything phrased as "expect N rows" is false the moment a later
-- migration adds a step. Each assertion below is a property that must HOLD.
DO $$
DECLARE
  step_key   text;
  step_when  text;
  pos_proc   int;
  pos_mc     int;
  pos_quotes int;
  mc_condval text;
BEGIN
  -- 1. No `always` step out of procurement review may carry the gate. This is
  --    the invariant the prototype states, not a claim about this one row: if a
  --    future migration re-ticks it, this fires.
  SELECT payload->>'name' INTO step_key
    FROM workflow.steps_config
   WHERE payload->>'from' = 'IN_PROCUREMENT_REVIEW'
     AND payload->>'to'   = 'IN_COST_CENTER_APPROVAL'
     AND payload->>'when' = 'always'
     AND COALESCE((payload->>'requiresCapexOpex')::boolean, false);

  IF step_key IS NOT NULL THEN
    RAISE EXCEPTION
      'migration 072: the always step "%" out of IN_PROCUREMENT_REVIEW still carries '
      'requiresCapexOpex. The prototype (line 1912) sets it false: the gate belongs '
      'to the finance band, keyed on amount.', step_key;
  END IF;

  -- 2. The Capex/Opex gate must still exist SOMEWHERE — it may not be deleted to
  --    make assertion 1 pass. The CS exits are where the class is actually made.
  --
  --    `csExitComplete` is in that vocabulary because migration 075, later in this
  --    same chain, renames the CS exits' predicate from `csReviewConfirmed` to
  --    `csExitComplete` when it retires the cost-approval stage. Listing only
  --    the old name meant that after 075 had run this file could no longer find
  --    the gate it was asserting still existed, and failed on the second run of
  --    any database it had created. The list below is the set of predicates a
  --    gate-carrying step may use, and it now includes both names.
  IF NOT EXISTS (
    SELECT 1 FROM workflow.steps_config
     WHERE COALESCE((payload->>'requiresCapexOpex')::boolean, false)
       AND payload->>'when' IN ('csReviewConfirmed', 'csExitComplete', 'amountGT', 'amountGTE',
                                'aboveMgtThreshold', 'amountLTE', 'amountLT')
  ) THEN
    RAISE EXCEPTION
      'migration 072: no step now requires a Capex/Opex class at all. The class is '
      'made at the comparative-statement exit; removing the gate with the tick is '
      'not a fix.';
  END IF;

  -- 3. The MC must read the threshold, and must not shadow it with its own number.
  SELECT payload->>'when' INTO step_when
    FROM workflow.steps_config
   WHERE payload->>'name' = 'MC approval' AND payload->>'to' = 'MC_APPROVED';

  IF step_when IS DISTINCT FROM 'aboveMgtThreshold' THEN
    RAISE EXCEPTION
      'migration 072: mc_approval is gated on "%", not aboveMgtThreshold. Without it '
      'every locked statement asks for an MC vote regardless of value.', step_when;
  END IF;

  SELECT payload->>'conditionValue' INTO mc_condval
    FROM workflow.steps_config
   WHERE payload->>'name' = 'MC approval' AND payload->>'to' = 'MC_APPROVED';

  IF mc_condval IS NOT NULL THEN
    RAISE EXCEPTION
      'migration 072: mc_approval carries conditionValue=% while reading the global '
      'threshold. One band, one number.', mc_condval;
  END IF;

  -- 4. ORDER. `cs_review_quotes` must sit ABOVE `mc_approval`, or the `always`
  --    step answers first and the CS exit is unreachable — the "a step that is
  --    last is a step that never wins" trap, restated for this pair.
  SELECT order_index INTO pos_proc
    FROM workflow.steps_config WHERE payload->>'name' = 'Procurement review'
      AND payload->>'from' = 'IN_PROCUREMENT_REVIEW';

  SELECT order_index INTO pos_mc
    FROM workflow.steps_config WHERE payload->>'name' = 'MC approval';

  SELECT order_index INTO pos_quotes
    FROM workflow.steps_config WHERE payload->>'name' = 'CS review confirmed (quotes received)';

  IF pos_quotes IS NULL THEN
    RAISE EXCEPTION 'migration 072: the QUOTES_RECEIVED CS exit step is missing.';
  END IF;

  IF pos_quotes >= pos_mc THEN
    RAISE EXCEPTION
      'migration 072: the quotes CS exit sits at % and mc_approval at %. The CS exit '
      'must come first or mc_approval answers first for every sub-threshold request.',
      pos_quotes, pos_mc;
  END IF;

  RAISE NOTICE 'migration 072 ok: procurement no longer gates on Capex/Opex (prototype 1912); '
    'mc_approval now reads aboveMgtThreshold (quotes exit at %, mc at %)',
    pos_quotes, pos_mc;
END $$;

COMMIT;