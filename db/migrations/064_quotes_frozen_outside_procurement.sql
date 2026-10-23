-- 064_quotes_frozen_outside_procurement.sql
--
-- THE HAND-OFF FREEZE. Once procurement forwards a PR to CS, the competition is
-- decided: no quotation may be received, and no quotation may change.
--
-- WHY A TRIGGER AND NOT ONLY THE SERVICE GATE
-- -------------------------------------------
-- `quotation.service.requireOpenRfq` already refuses a procurement officer who
-- records or revises once the PR has left IN_PROCUREMENT_REVIEW, and
-- `RFQ_REISSUE_STAGES` already freezes the roster. But the VENDOR path never
-- consulted the PR's stage at all — `POST /vendor-portal/:token/quote` checked
-- only `rfq.state <> 'Open'` and the deadline, and the RFQ stays `Open` until
-- the CS locks. Measured on this estate before this migration:
--
--     QUOTES_RECEIVED | rfq_state=Open | 137 invitations | 103 submitted
--
-- So a vendor holding a live token could change a price on a PR the buyer had
-- already forwarded. Service gates cannot close that: the vendor endpoint does
-- not pass through the procurement service, and a gate added only to one caller
-- is one route over. The database is the last place that cannot be forgotten.
--
-- WHAT IS *NOT* REFUSED — and why this is not a blanket block
-- ----------------------------------------------------------
-- Every existing `UPDATE proc.quotations` in the codebase changes `state` and
-- nothing else (cs.service -> Awarded/Rejected; governance.service -> restores
-- them to Submitted on an MC rejection; quotation.service -> Superseded /
-- Withdrawn when a vendor revises). A trigger that refused all updates would
-- have broken the CS lock and the MC-rejection round-2 loop, both of which are
-- live. So this guards the COMMERCIAL CONTENT and lets lifecycle bookkeeping
-- through:
--
--     INSERT                     always refused outside procurement
--     UPDATE of any money/term   refused outside procurement
--     UPDATE of `state` alone    allowed (CS lock, MC reject, supersede)
--
-- `proc.quotation_lines` holds the per-line prices but is never updated by any
-- code path — lines are written once at insert — so it needs no trigger of its
-- own. That is asserted in scripts/verify_064.sql rather than assumed: a future
-- change that starts editing line prices must add a guard here.
--
-- This is deliberately keyed on the PR's STAGE, not on rfq.state. The two are
-- not the same question: an MC rejection deliberately returns the PR to
-- QUOTES_RECEIVED and reopens the RFQ so a second round can be scored. A rule
-- keyed on the RFQ would either have to break that round trip or drift from
-- the workflow.

BEGIN;

CREATE OR REPLACE FUNCTION proc.fn_quotes_frozen_outside_procurement() RETURNS trigger AS $$
DECLARE
  v_pr_id     uuid;
  v_pr_status text;
  v_pr_number text;
BEGIN
  SELECT rf.pr_id, p.status, p.pr_number
    INTO v_pr_id, v_pr_status, v_pr_number
    FROM proc.rfq rf
    JOIN proc.purchase_requisitions p ON p.id = rf.pr_id
   WHERE rf.id = COALESCE(NEW.rfq_id, OLD.rfq_id);

  -- No RFQ row (impossible via FK) or still procurement's to run: nothing to do.
  IF v_pr_id IS NULL OR v_pr_status = 'IN_PROCUREMENT_REVIEW' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION
      'Quotation refused: % has moved on to % (stage: %). Quotations are closed once a '
      'request leaves procurement for CS — the quotes on file are now the ones a '
      'decision is being made from.',
      COALESCE(v_pr_number, 'this request'), 'the next stage', v_pr_status
      USING ERRCODE = 'check_violation';
  END IF;

  -- UPDATE. Lifecycle bookkeeping (state alone) is allowed; anything that would
  -- move a price, a term, or the version chain is refused.
  IF NEW.total_amount          IS DISTINCT FROM OLD.total_amount
     OR NEW.currency            IS DISTINCT FROM OLD.currency
     OR NEW.fx_rate             IS DISTINCT FROM OLD.fx_rate
     OR NEW.normalized_total_pkr IS DISTINCT FROM OLD.normalized_total_pkr
     OR NEW.sealed_hash         IS DISTINCT FROM OLD.sealed_hash
     OR NEW.version             IS DISTINCT FROM OLD.version
     OR NEW.supersedes_quotation_id IS DISTINCT FROM OLD.supersedes_quotation_id
     OR NEW.lead_time_days      IS DISTINCT FROM OLD.lead_time_days
     OR NEW.warranty_months     IS DISTINCT FROM OLD.warranty_months
     OR NEW.taxes_included      IS DISTINCT FROM OLD.taxes_included
     OR NEW.tax_breakdown       IS DISTINCT FROM OLD.tax_breakdown
     OR NEW.validity_days       IS DISTINCT FROM OLD.validity_days
     OR NEW.payment_terms       IS DISTINCT FROM OLD.payment_terms
     OR NEW.notes               IS DISTINCT FROM OLD.notes
     OR NEW.quote_mode          IS DISTINCT FROM OLD.quote_mode
     OR NEW.revision_reason     IS DISTINCT FROM OLD.revision_reason
     OR NEW.valid_until         IS DISTINCT FROM OLD.valid_until
     OR NEW.discount_basis      IS DISTINCT FROM OLD.discount_basis
     OR NEW.rfq_id              IS DISTINCT FROM OLD.rfq_id
     OR NEW.vendor_id           IS DISTINCT FROM OLD.vendor_id
  THEN
    RAISE EXCEPTION
      'Quotation refused: % is at % and its quotations are closed. The CS lock and the '
      'MC vote may still change a quotation''s state, but its price and terms are the '
      'record the decision was made from and cannot be edited.',
      COALESCE(v_pr_number, 'this request'), v_pr_status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_quotations_frozen ON proc.quotations;
CREATE TRIGGER trg_quotations_frozen
BEFORE INSERT OR UPDATE ON proc.quotations
FOR EACH ROW EXECUTE FUNCTION proc.fn_quotes_frozen_outside_procurement();

COMMENT ON FUNCTION proc.fn_quotes_frozen_outside_procurement() IS
  'Chain-of-custody freeze: a quotation may not be inserted, nor have its price or '
  'terms changed, once its PR has left IN_PROCUREMENT_REVIEW. Lifecycle `state` '
  'changes (CS lock -> Awarded/Rejected, MC reject -> Submitted, revision -> '
  'Superseded) remain permitted. See 064_quotes_frozen_outside_procurement.sql.';

-- ══════════════════════════════════════════════════════════════════════════════
-- B · THE "READY FOR CS" ROUTING STEP
-- ══════════════════════════════════════════════════════════════════════════════
--
-- The freeze above needs a door to close, and the door is a workflow step rather
-- than a hard-coded UPDATE so that:
--   - the transition is authorised by the same role table as every other one,
--   - an admin can see it in the routing table and turn it off like any other,
--   - a PR created before this migration can be amended for it by
--     `WorkflowService.ensureStepForPr`, exactly as `revert_to_hod` is.
--
-- `from` is narrow on purpose: IN_PROCUREMENT_REVIEW only. Widening it to '*'
-- would let the actor who ran the competition hand a PR to CS from any stage —
-- the same widening that was already rejected once on the reissue gate, and
-- rejected again for `revert_to_hod`.
--
-- `to` is QUOTES_RECEIVED, the stage at which a Comparative Statement becomes
-- generatable (see db/seeds/seed_cs_matrix_v2.sql). proc.fn_check_pr_transition
-- already admits IN_PROCUREMENT_REVIEW -> QUOTES_RECEIVED, so no edge is added
-- here — a step row and a trigger edge are two declarations of one workflow, and
-- only the second already existed.

INSERT INTO workflow.steps_config (id, payload, order_index)
VALUES (
  'ready_for_cs',
  '{
    "to": "QUOTES_RECEIVED",
    "from": "IN_PROCUREMENT_REVIEW",
    "name": "Forwarded to CS for comparative statement",
    "when": "readyForCs",
    "order": 12,
    "canSkip": false,
    "terminal": false,
    "actorRole": "procurement",
    "requiresCapexOpex": false
  }'::jsonb,
  16
)
ON CONFLICT (id) DO UPDATE
SET payload = EXCLUDED.payload,
    order_index = EXCLUDED.order_index;

-- ══════════════════════════════════════════════════════════════════════════════
-- SELF-CHECK — a migration that installs the wrong thing is worse than none
-- ══════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE n int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid='proc.quotations'::regclass
       AND tgname='trg_quotations_frozen' AND NOT tgisinternal AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'migration 064: the quotations freeze trigger is missing';
  END IF;

  SELECT count(*) INTO n
    FROM workflow.steps_config
   WHERE id='ready_for_cs'
     AND payload->>'actorRole' = 'procurement'
     AND payload->>'from'      = 'IN_PROCUREMENT_REVIEW'
     AND payload->>'to'        = 'QUOTES_RECEIVED'
     AND payload->>'when'      = 'readyForCs';
  IF n <> 1 THEN
    RAISE EXCEPTION 'migration 064: ready_for_cs step is missing or malformed (found % row(s))', n;
  END IF;

  -- The edge this step relies on. A step whose target the trigger refuses would
  -- 500 the endpoint on its first real use, which is exactly the silent failure
  -- this file exists to prevent elsewhere.
  IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
       WHERE ns.nspname='proc' AND p.proname='fn_check_pr_transition')
     !~ 'IN_PROCUREMENT_REVIEW''\s+AND NEW\.status IN \([^)]*QUOTES_RECEIVED' THEN
    RAISE EXCEPTION
      'migration 064: proc.fn_check_pr_transition does not admit IN_PROCUREMENT_REVIEW -> '
      'QUOTES_RECEIVED, so ready_for_cs would fail at the database';
  END IF;
END $$;

COMMIT;