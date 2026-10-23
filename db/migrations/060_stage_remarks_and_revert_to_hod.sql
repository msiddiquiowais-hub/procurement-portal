-- ══════════════════════════════════════════════════════════════════════════════
-- 060 · STAGE REMARKS + PROCUREMENT "REVERT TO HOD"
-- ══════════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS DOES
-- --------------
-- Three things, all of them prerequisites for the Procurement Revert action:
--
--   A. `proc.purchase_requisitions.stage_remarks` (jsonb) — somewhere for a
--      decision's mandatory remarks to actually live.
--   B. A guard trigger: remarks may only change when the stage changes.
--   C. One new routing step, `revert_to_hod`, IN_PROCUREMENT_REVIEW → IN_HOD_REVIEW.
--
-- ── WHY A COLUMN AT ALL: REMARKS ARE CURRENTLY DISCARDED ────────────────────
-- `PrService.hold()` accepts a `reason`, returns it in the HTTP body as
-- `comment`, and writes NOTHING. `pr.service.ts` emits no audit.audit_log rows
-- of its own, so the only PR trail is the `trg_prs_audit` AFTER UPDATE trigger,
-- which records the whole row image — and there was no column holding a remark,
-- so every mandatory remark collected in the UI was silently thrown away.
--
-- Both existing consumers already demand one: `rejectPr()` refuses an empty
-- reason, and `revertForRevision()` refuses an empty reason. Requiring text the
-- system then throws away is worse than not requiring it, because the record
-- implies the decision was reasoned.
--
-- ── WHY JSONB AND NOT TWO TEXT COLUMNS ──────────────────────────────────────
-- `trg_prs_audit` records `to_jsonb(NEW)` — the ENTIRE row — so any column on
-- this table is captured into the existing hash-chained trail automatically,
-- with no second INSERT and therefore no duplicated audit row.
--
-- One jsonb map keyed by decision covers Revert, Reject and any future stage
-- decision without another ALTER, and it keeps the "why" next to the stage it
-- explains. Two narrow columns would work too, but would need a third and a
-- fourth the first time another action needs one.
--
-- ── WHY THE GUARD IS "ONLY WITH A STAGE CHANGE", NOT "WRITE ONCE" ───────────
-- A write-once rule would forbid a second Revert, which is a legitimate thing
-- for procurement to do (revert, HOD changes something, revert again). What must
-- never happen is a remark being SILENTLY REWRITTEN without the PR actually
-- moving — that is the failure that leaves a decision with no reason.
--
-- So the rule is: stage unchanged ⇒ remarks unchanged. Any real stage move may
-- add remarks freely. History is not at risk either way, because every earlier
-- value is still in the audit chain's before/after images.
--
-- ── NO NEW STATUS VALUE IS NEEDED ───────────────────────────────────────────
-- The revert lands on IN_HOD_REVIEW, which the status CHECK already permits.
-- `REJECTED` is likewise already permitted and already used.
--
-- ── WHY THE STATUS CHECK IS REBUILT THE WAY IT IS ───────────────────────────
-- The permitted set is read OUT OF `pg_constraint` and unioned with the
-- canonical list — never derived from `SELECT DISTINCT status FROM the table`.
-- Deriving it from data lets a row legitimise a value the schema never declared,
-- which is how a constraint silently widens. This is the third rebuild of this
-- constraint; 019 records the identical defect on the same table.

-- ══════════════════════════════════════════════════════════════════════════════
-- A · stage_remarks
-- ══════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='proc' AND table_name='purchase_requisitions'
       AND column_name='stage_remarks'
  ) THEN
    ALTER TABLE proc.purchase_requisitions
      ADD COLUMN stage_remarks jsonb NOT NULL DEFAULT '{}'::jsonb;
  END IF;
END $$;

COMMENT ON COLUMN proc.purchase_requisitions.stage_remarks IS
  'Mandatory remarks per stage decision, keyed by decision name '
  '(revert_to_hod, reject, ...). Captured into audit.audit_log by trg_prs_audit, '
  'which records the whole row — so no second audit INSERT is written here.';

-- ══════════════════════════════════════════════════════════════════════════════
-- B · THE GUARD
-- ══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION proc.fn_pr_stage_remarks_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.stage_remarks IS DISTINCT FROM OLD.stage_remarks THEN
    RAISE EXCEPTION
      'stage_remarks on % may only change when the PR changes stage (status is still %)',
      COALESCE(OLD.pr_number, OLD.id::text), OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pr_stage_remarks_guard ON proc.purchase_requisitions;
CREATE TRIGGER trg_pr_stage_remarks_guard
  BEFORE UPDATE ON proc.purchase_requisitions
  FOR EACH ROW EXECUTE FUNCTION proc.fn_pr_stage_remarks_guard();

-- ══════════════════════════════════════════════════════════════════════════════
-- C · STATUS CHECK — add the one value the code declares and the schema lacks
-- ══════════════════════════════════════════════════════════════════════════════
-- `workflow-engine/types.ts` declares 'RETURNED' in its Stage union. The CHECK
-- permitted only 'Returned' (mixed case). Nothing writes either today, so the
-- divergence is currently silent — and would surface as a constraint violation
-- the first time anything did. Adding the canonical spelling rather than
-- dropping the legacy one: 'Returned' may be in historical rows or in a
-- hand-rolled request we have not seen.

DO $$
DECLARE
  v_check_name text;
  v_def        text;   -- the raw constraint body, still quoted+cast
  v_norm       text;   -- declared set: unquoted, sorted  -> COMPARED
  v_final      text;   -- declared set + canonical       -> REBUILT FROM
  v_added      text;
  v_sql        text;
BEGIN
  -- Anchored on purpose. The column is `status`, but `amount_status = ANY(...)`
  -- ALSO contains the substring `status = ANY`, so a plain ILIKE matched both
  -- checks and `LIMIT 1` then picked whichever the planner returned first —
  -- which meant this file silently rebuilt the WRONG constraint, non-deterministically,
  -- across runs. The leading boundary is what makes it select exactly one.
  SELECT conname, pg_get_constraintdef(oid)
    INTO v_check_name, v_def
    FROM pg_constraint
   WHERE conrelid = 'proc.purchase_requisitions'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ~ '(^|[^A-Za-z0-9_])status = ANY'
   LIMIT 1;

  IF v_check_name IS NULL THEN
    RAISE EXCEPTION 'migration 060: the status CHECK on proc.purchase_requisitions is missing';
  END IF;
  IF v_check_name = 'purchase_requisitions_amount_status_check' THEN
    RAISE EXCEPTION 'migration 060: selector resolved to the amount_status CHECK, not the status CHECK';
  END IF;

  v_def := regexp_replace(v_def, '^.*= ANY \(ARRAY\[(.*)\]\)\).*$', '\1');

  -- Each element arrives QUOTED and CAST — `'Draft'::text`. The cast has to
  -- come off BEFORE the quotes: stripping the quotes first leaves `Draft'::text`,
  -- which then matches neither pattern and survives as `Draft'` — a value no
  -- row holds, and a rebuilt CHECK that admits nothing. That is precisely how
  -- the first two attempts at this file failed.
  v_norm := (
    SELECT string_agg(DISTINCT clean, ',' ORDER BY clean)
      FROM (
        SELECT btrim(regexp_replace(regexp_replace(btrim(v), '::text$', ''), '^''+|''+$', '', 'g')) AS clean
          FROM unnest(string_to_array(v_def, ',')) AS t(v)
         WHERE btrim(v) <> ''
      ) s
  );

  -- One new spelling only: the canonical uppercase the engine's Stage union
  -- declares. The legacy mixed-case 'Returned' stays — it is in the INSTALLED
  -- constraint, so it may be in rows we have not seen.
  v_added := (
    SELECT string_agg(DISTINCT clean, ',' ORDER BY clean)
      FROM (
        SELECT 'RETURNED' AS clean
        UNION ALL
        SELECT btrim(regexp_replace(regexp_replace(btrim(v), '::text$', ''), '^''+|''+$', '', 'g'))
          FROM unnest(string_to_array(v_def, ',')) AS t(v)
         WHERE btrim(v) <> ''
      ) s
  );

  -- Set comparison, never a string comparison: `v_norm` is sorted but `v_def`
  -- is in declaration order, so comparing the raw strings is ALWAYS unequal and
  -- would drop and rebuild the constraint on every replay. This runner has NO
  -- migration ledger — every file is re-applied on every run — so an
  -- idempotency that only holds on a fresh database is not idempotency at all.
  IF v_added = v_norm THEN
    RETURN;   -- already a superset: touch nothing
  END IF;

  v_final := v_added;
  v_sql := format(
    'ALTER TABLE proc.purchase_requisitions DROP CONSTRAINT %I; '
    'ALTER TABLE proc.purchase_requisitions ADD CONSTRAINT %I '
    'CHECK (status = ANY (ARRAY[%s]::text[]))',
    v_check_name, v_check_name,
    (SELECT string_agg(quote_literal(clean) || '::text', ', ' ORDER BY clean)
       FROM unnest(string_to_array(v_final, ',')) AS t(clean))
  );
  EXECUTE v_sql;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- D · THE REVERT ROUTING STEP
-- ══════════════════════════════════════════════════════════════════════════════
-- Procurement is a SOURCING function, not the demand owner. It therefore gets
-- no Reject: only this. Sending the PR back to the HOD, who owns the demand
-- decision, with mandatory remarks is the whole of procurement's authority here.
--
-- `from` is deliberately narrow — IN_PROCUREMENT_REVIEW only. Once a PR has
-- moved on (comparative statement drafted, forwarded, RFQ live) procurement
-- holds no rights over it; widening `from` to '*' would hand the actor who ran
-- the competition the power to rewrite it after handing it to the next
-- authority. That is the reissue widening that was already rejected once here.

INSERT INTO workflow.steps_config (id, payload, order_index)
VALUES (
  'revert_to_hod',
  '{
    "to": "IN_HOD_REVIEW",
    "from": "IN_PROCUREMENT_REVIEW",
    "name": "Reverted to HOD by procurement",
    "when": "revertToHod",
    "order": 0,
    "canSkip": false,
    "terminal": false,
    "actorRole": "procurement",
    "requiresCapexOpex": false
  }'::jsonb,
  0
)
ON CONFLICT (id) DO UPDATE
   SET payload = EXCLUDED.payload;

-- ══════════════════════════════════════════════════════════════════════════════
-- E · POST-FLIGHT — assert the migration did what it claims
-- ══════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE n int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='proc' AND table_name='purchase_requisitions'
       AND column_name='stage_remarks') THEN
    RAISE EXCEPTION 'migration 060: stage_remarks column is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid='proc.purchase_requisitions'::regclass
       AND tgname='trg_pr_stage_remarks_guard'
       AND NOT tgisinternal AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'migration 060: the stage_remarks guard trigger is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='proc.purchase_requisitions'::regclass
       AND contype='c'
       AND pg_get_constraintdef(oid) LIKE '%''RETURNED''%') THEN
    RAISE EXCEPTION 'migration 060: the status CHECK still lacks RETURNED';
  END IF;

  SELECT count(*) INTO n
    FROM workflow.steps_config
   WHERE id='revert_to_hod'
     AND payload->>'actorRole' = 'procurement'
     AND payload->>'from'      = 'IN_PROCUREMENT_REVIEW'
     AND payload->>'to'        = 'IN_HOD_REVIEW'
     AND payload->>'when'      = 'revertToHod';
  IF n <> 1 THEN
    RAISE EXCEPTION 'migration 060: revert_to_hod step is missing or malformed (found % row(s))', n;
  END IF;

  -- The 014 audit trigger must survive; it is what carries remarks into the
  -- hash chain. Its loss would be silent — remarks would simply stop appearing.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid='proc.purchase_requisitions'::regclass
       AND tgname='trg_prs_audit' AND NOT tgisinternal AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'migration 060: trg_prs_audit from migration 014 is gone';
  END IF;
END $$;