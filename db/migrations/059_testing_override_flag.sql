-- ══════════════════════════════════════════════════════════════════════════════
-- 059 · TESTING_OVERRIDE flag on unstamped past-HOD PRs
-- ══════════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS DOES
-- --------------
-- Marks PRs that ADVANCED PAST THE HOD GATE but carry no HOD approval stamp:
--
--     status IN (a stage only reachable by passing HOD)
--     AND hod_approved_at IS NULL
--
-- Each one gets `[TESTING_OVERRIDE] - ` prepended to its `justification`.
-- Nothing else changes: no status is rewritten, no stage, no transition, no
-- vendor, no quotation. This is a LABEL, not a workflow decision.
--
-- ── THE SCOPE IS 364, NOT 173 ───────────────────────────────────────────────
-- The figure "173" came from earlier notes and does not reproduce. Every
-- definition that was tried returns a different number:
--
--     requester == HOD approver, hod_status='approved' .........   1
--     requester among the MC voters ...........................   0
--     past HOD AND hod_approved_at IS NULL ..................... 364   <-- this file
--     past HOD AND no pr_departments row marked approved ....... 789
--     past HOD AND no pr_departments row at all ................. 686
--     every hod_status='pending' PR in the database ............ 174
--
-- The owner confirmed 364 as the correct scope. The migration states the count
-- it ACTUALLY acted on in the audit row below, so the trail can never be read
-- as claiming a number it did not touch.
--
-- ── WHY `justification`, AND WHY THAT IS SAFE ───────────────────────────────
-- `proc.purchase_requisitions` has no remarks column. Of the free-text columns
-- it does have, `justification` is the one that states WHY a PR was raised —
-- which is exactly what this flag is about, so it is not being used to carry
-- unrelated content.
--
-- Every one of the 364 currently has justification IS NULL, so this prepends
-- onto nothing: it writes a fresh marker and cannot overwrite real text. The
-- UPDATE is still written to preserve existing text if a future run finds any,
-- so the migration stays safe if this file is replayed against richer data.
--
-- ── WHY NO SCHEMA IS TOUCHED ────────────────────────────────────────────────
-- A deliberate choice, and the reason the file is shaped the way it is:
--   * no new table            — the working set is a TEMP table, dropped at commit
--   * no new status value     — `proc.purchase_requisitions.status` is not written,
--                               so the status CHECK and the workflow state machine
--                               are untouched and these PRs keep their real stage
--   * no new audit action     — `audit.fn_widen_audit_log_actions()` is not invoked
--
-- ── HOW IT IS LOGGED ────────────────────────────────────────────────────────
-- `trg_prs_audit` is an AFTER UPDATE trigger on proc.purchase_requisitions that
-- calls `audit.fn_emit_audit()`, recording the FULL before and after row of every
-- touched PR. That trigger fires on this UPDATE by itself, so the per-PR detail
-- is written by the application's own mechanism — this file deliberately does NOT
-- insert its own per-PR audit rows, which would duplicate them.
--
-- One summary row IS added, because 364 identical-shaped updates answering
-- "why?" would otherwise be unreadable. Each audit row is sealed into the hash
-- chain by `fn_audit_log_seal()`, which 038b made race-free, so these rows extend
-- the REPAIRED chain rather than forking it. The post-flight check below proves
-- the chain still verifies end to end.
--
-- ── IDEMPOTENCE ─────────────────────────────────────────────────────────────
-- `db/scripts/migrate.ps1` has no migration ledger: it re-applies every file on
-- every run, so replay IS the normal path. A second run selects the same 364
-- (status and hod_approved_at are not written), finds the flag already present,
-- updates 0 rows, emits 0 audit rows, and passes.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════════════
-- 1 · THE TARGET SET, defined exactly once
-- ══════════════════════════════════════════════════════════════════════════════
-- TEMP, so the selection predicate appears once in this file and leaves no trace
-- in the schema. `justification_before` is captured here because the UPDATE below
-- overwrites it and the value has to survive for the record.
--
-- The status list is every stage reachable ONLY by passing the HOD gate, taken
-- from workflow.steps_config: the hod_review transition and its line rules
-- (IN_IT_REVIEW, IN_WAREHOUSE), the warehouse branch, and the whole chain after
-- it through D365 and the MC/CFO governance gates. REJECTED is deliberately
-- excluded — a reject can fire from any stage, so its presence does not prove
-- the PR ever passed HOD.
CREATE TEMP TABLE mig059_target ON COMMIT DROP AS
SELECT p.id,
       p.pr_number,
       p.status,
       p.justification AS justification_before
  FROM proc.purchase_requisitions p
 WHERE p.status IN (
         'IN_PROCUREMENT_REVIEW','IN_IT_REVIEW','IN_WAREHOUSE','IN_WAREHOUSE_CHECK',
         'IN_COST_CENTER_APPROVAL','IN_FINANCE_REVIEW','IN_MANAGEMENT_REVIEW',
         'READY_FOR_D365','D365_PUSHED','QUOTES_RECEIVED','CS_LOCKED',
         'MC_APPROVED','CFO_APPROVED','PACK_LOCKED')
   AND p.hod_approved_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════════
-- 2 · PRE-FLIGHT — report the real scope before touching anything
-- ══════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_total int; v_flagged int;
BEGIN
  SELECT count(*) INTO v_total FROM mig059_target;

  SELECT count(*) INTO v_flagged FROM mig059_target
   WHERE justification_before LIKE '[TESTING_OVERRIDE]%';

  IF v_total = 0 THEN
    RAISE NOTICE 'migration 059: no unstamped past-HOD PRs found — nothing to flag';
  ELSE
    RAISE NOTICE 'migration 059: % unstamped past-HOD PR(s) found, % already flagged',
                  v_total, v_flagged;
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- 3 · THE FLAG
-- ══════════════════════════════════════════════════════════════════════════════
-- `rtrim` only collapses the trailing space of the marker when there is no
-- original text to follow it, so a replay writes '[TESTING_OVERRIDE] -' rather
-- than a marker with a dangling separator. Existing text is preserved and
-- prefixed; NULL becomes the bare marker.
--
-- The LIKE guard is what makes a replay a no-op: a PR already carrying the
-- marker is excluded, so it is neither rewritten nor re-audited.
UPDATE proc.purchase_requisitions p
   SET justification = rtrim('[TESTING_OVERRIDE] - ' || coalesce(t.justification_before, ''))
  FROM mig059_target t
 WHERE p.id = t.id
   AND coalesce(t.justification_before, '') NOT LIKE '[TESTING_OVERRIDE]%';

-- ══════════════════════════════════════════════════════════════════════════════
-- 4 · ONE SUMMARY AUDIT ROW — the "why" for all of them
-- ══════════════════════════════════════════════════════════════════════════════
-- The per-PR before/after is already in the trail from trg_prs_audit. This row
-- exists so a reader hitting 364 identical `update` rows learns the cause in one
-- place: which PRs, how many, which invariant, and that it was testing-only.
--
-- `update` is reused from the existing vocabulary on purpose — no new action is
-- introduced, so no constraint is widened to record a temporary test artefact.
DO $$
DECLARE v_total int; v_new int; v_statuses text;
BEGIN
  SELECT count(*) INTO v_total FROM mig059_target;
  SELECT count(*) INTO v_new FROM mig059_target
   WHERE coalesce(justification_before, '') NOT LIKE '[TESTING_OVERRIDE]%';

  IF v_new = 0 THEN
    RAISE NOTICE 'migration 059: every target PR was already flagged — no audit row written';
    RETURN;
  END IF;

  SELECT string_agg(DISTINCT status, ', ' ORDER BY status) INTO v_statuses FROM mig059_target;

  INSERT INTO audit.audit_log (actor_user_id, entity, entity_id, action, before, after, reason)
  VALUES (
    NULL,
    'migration.059_testing_override',
    'unstamped-past-hod',
    'update',
    jsonb_build_object('flag','absent','scope','PRs past the HOD gate with hod_approved_at IS NULL'),
    jsonb_build_object(
      'flag',            'TESTING_OVERRIDE',
      'prefix',          '[TESTING_OVERRIDE] - ',
      'prs_flagged',     v_new,
      'prs_in_scope',    v_total,
      'stages',          v_statuses,
      'column_written',  'proc.purchase_requisitions.justification',
      'reversible_by',   'strip the [TESTING_OVERRIDE] prefix from justification'
    ),
    format('migration 059: prepended [TESTING_OVERRIDE] - to the justification of %s of %s '
           || 'purchase requisitions that advanced past the HOD gate but carry no HOD '
           || 'approval stamp (hod_approved_at IS NULL). TESTING-ONLY label: no PR status, '
           || 'stage, transition or related record was modified, and no workflow rule was '
           || 'bypassed. The underlying self-approval path in advance() is closed and cannot '
           || 'reproduce in production. Per-PR before/after is in the trail from trg_prs_audit.',
           v_new, v_total)
  );
END $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- 5 · POST-FLIGHT — prove the flag landed and the chain is still whole
-- ══════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_unflagged int; v_bad bigint; v_bad_prefix int;
BEGIN
  -- Re-read the LIVE rows rather than trusting the temp table's captured copy:
  -- the assertion is about what is stored, not about what we intended to store.
  SELECT count(*) INTO v_unflagged
    FROM mig059_target t
    JOIN proc.purchase_requisitions p ON p.id = t.id
   WHERE coalesce(p.justification, '') NOT LIKE '[TESTING_OVERRIDE]%';

  IF v_unflagged > 0 THEN
    RAISE EXCEPTION
      'migration 059: % target PR(s) do not carry the TESTING_OVERRIDE marker', v_unflagged;
  END IF;

  -- No double-prefixing: the marker must appear exactly once per row. The
  -- search string omits the trailing space, because `rtrim` in step 3 drops it
  -- when there is no original text to follow — so the stored marker is
  -- '[TESTING_OVERRIDE] -' for a previously-NULL justification and
  -- '[TESTING_OVERRIDE] - <original>' otherwise. Counting occurrences of the
  -- common 18-character form covers both.
  SELECT count(*) INTO v_bad_prefix
    FROM mig059_target t
    JOIN proc.purchase_requisitions p ON p.id = t.id
   WHERE (length(p.justification)
          - length(replace(p.justification, '[TESTING_OVERRIDE] -', '')))
         / length('[TESTING_OVERRIDE] -') <> 1;

  IF v_bad_prefix > 0 THEN
    RAISE EXCEPTION
      'migration 059: % target PR(s) carry the marker more than once', v_bad_prefix;
  END IF;

  RAISE NOTICE 'migration 059: all % target PR(s) carry exactly one TESTING_OVERRIDE marker',
                (SELECT count(*) FROM mig059_target);

  -- The audit rows this migration produced must extend the repaired chain, not
  -- fork it. Verifying the chain is the only claim that actually proves it.
  IF to_regprocedure('audit.fn_verify_audit_chain()') IS NOT NULL THEN
    SELECT first_bad_id INTO v_bad FROM audit.fn_verify_audit_chain();
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'migration 059: audit chain broken at row %', v_bad;
    END IF;
    RAISE NOTICE 'migration 059: audit chain verified end to end after flagging';
  END IF;
END $$;

COMMIT;