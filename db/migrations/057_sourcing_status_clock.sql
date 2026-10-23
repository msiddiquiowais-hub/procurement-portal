-- 057_sourcing_status_clock.sql
--
-- Task 1 of the sourcing-status work: the columns and configuration the
-- `my-prs` STATUS column needs. NO status text is stored anywhere -- the four
-- core states are derived at query time. This migration only adds the three
-- things that genuinely cannot be derived:
--
--   1. proc.rfq.reissue_count / last_reissued_at
--        "Was this RFQ ever re-issued?" is an EVENT fact. After a vendor top-up
--        the invitation list is byte-for-byte indistinguishable from a first
--        issue to more vendors, so no query over current rows can answer it.
--        (cf. migration 056: same reasoning for pinning a document to a version.)
--
--   2. proc.purchase_requisitions.hod_approved_at
--        The anchor for the RFQ-delay alarm.
--
-- (A SECOND ANCHOR, procurement_entered_at, was added here and removed again by
-- migration 058. It exists only as history; this file must not reintroduce it —
-- it is replayed on every `db:migrate`.)
--
-- WHY ONE ANCHOR AND NOT TWO
-- --------------------------
-- The brief was "if an RFQ is not issued within N hours after HOD approval,
-- flag it red". A second anchor on "reached procurement review" was added for
-- the fast-track population that never passes through HOD review. Measured on
-- this estate that turned out to be the wrong diagnosis: those PRs HAD been
-- approved by a HOD, they simply approved while the PR sat in `Submitted`
-- rather than in a visible `IN_HOD_REVIEW` state. Migration 058 backfills the
-- single anchor correctly and drops the second one.
--
-- FORWARD WRITES GO IN A TRIGGER, NOT IN THE SERVICE
-- -------------------------------------------------
-- There are at least eight distinct `UPDATE proc.purchase_requisitions SET
-- status = ...` sites today (pr.service.ts advance/hold, governance.service.ts
-- x4, cs.service.ts, d365.service.ts). Stamping the clock in each one is eight
-- chances to forget. A BEFORE UPDATE OF status trigger catches all of them plus
-- any future one, and it composes with the existing AFTER UPDATE audit trigger
-- from migration 014 (BEFORE runs first, so the audit row's `after` payload
-- carries the stamp).
--
-- REPLAY SAFE
-- -----------
-- No migration ledger: db/scripts/migrate.ps1 replays every *.sql each run, so
-- every statement here is idempotent.

\set ON_ERROR_STOP on
BEGIN;

SET LOCAL search_path = proc, core, public;

-- ═══ 1 · The re-issue event ═════════════════════════════════════════════════
--
-- Count, not a boolean, so "re-issued twice" is visible and the chip can read
-- "Re-issued x2". Checked >= 0 so a bad write cannot produce a negative chip.

ALTER TABLE proc.rfq ADD COLUMN IF NOT EXISTS reissue_count     int NOT NULL DEFAULT 0;
ALTER TABLE proc.rfq ADD COLUMN IF NOT EXISTS last_reissued_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rfq_reissue_count_nonneg'
  ) THEN
    ALTER TABLE proc.rfq
      ADD CONSTRAINT rfq_reissue_count_nonneg CHECK (reissue_count >= 0);
  END IF;

  -- A reissue_count of 0 must not carry a timestamp, and a positive count must.
  -- Otherwise the chip can render "Re-issued" against a row whose count was
  -- reset, which is precisely the drift these columns exist to prevent.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rfq_reissue_stamp_consistent'
  ) THEN
    ALTER TABLE proc.rfq
      ADD CONSTRAINT rfq_reissue_stamp_consistent CHECK (
        (reissue_count = 0 AND last_reissued_at IS NULL)
     OR (reissue_count >  0 AND last_reissued_at IS NOT NULL)
      );
  END IF;
END $$;

COMMENT ON COLUMN proc.rfq.reissue_count IS
  'Number of times this RFQ was re-issued (vendors added after the first issue). 0 = never.';
COMMENT ON COLUMN proc.rfq.last_reissued_at IS
  'When this RFQ was most recently re-issued. NULL exactly when reissue_count = 0.';

-- ═══ 2 · The delay-clock anchor ════════════════════════════════════════════════
--
-- ONE anchor, not two. An earlier draft of this file also carried
-- `procurement_entered_at` as a second clock for PRs that reach procurement by
-- fast-track. Migration 058 removed it, and the backfill below was the reason
-- that column existed at all. See 058's header for the full account.

ALTER TABLE proc.purchase_requisitions ADD COLUMN IF NOT EXISTS hod_approved_at timestamptz;

COMMENT ON COLUMN proc.purchase_requisitions.hod_approved_at IS
  'When the HOD approved this PR. NULL while the PR is still awaiting HOD review.';

-- The stamp trigger. Runs BEFORE UPDATE so the value is already on NEW when
-- migration 014''s AFTER trigger serialises the row into audit.audit_log.
CREATE OR REPLACE FUNCTION proc.fn_stamp_sourcing_clock() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- HOD approved: the PR is leaving IN_HOD_REVIEW for real work. Two exits do
  -- NOT count -- a hold (IN_HOD_REVIEW -> ON_HOLD) and a return to the same
  -- stage are the opposite of an approval, and ON_HOLD -> IN_HOD_REVIEW is the
  -- PR coming BACK for review, which must not overwrite a stamp already earned.
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

-- ═══ 3 · Backfill ════════════════════════════════════════════════════════════
--
-- Sources, in order of trustworthiness:
--
--   hod_approved_at
--     (a) proc.pr_departments.hod_decided_at -- a real indexed column the HOD
--         decision path already writes (pr.service.ts:1118). No JSONB parsing.
--     (b) audit.audit_log -- the IN_HOD_REVIEW exit transition. Needed because
--         pr_departments only covers 197 of 968 light PRs; it is written by one
--         code path, while the stage trigger fired on every transition.
--
-- DISTINCT ON (entity_id) ... ORDER BY ts ASC is what makes "first" correct;
-- the naive MAX(ts) would stamp the alarm anchor with the most recent visit and
-- make every re-entered PR look freshly approved.

UPDATE proc.purchase_requisitions pr
   SET hod_approved_at = src.hod_decided_at
  FROM (
    SELECT DISTINCT ON (pd.pr_id) pd.pr_id, pd.hod_decided_at
      FROM proc.pr_departments pd
     WHERE pd.hod_status = 'approved'
       AND pd.hod_decided_at IS NOT NULL
     ORDER BY pd.pr_id, pd.hod_decided_at ASC
  ) src
 WHERE src.pr_id = pr.id
   AND pr.hod_approved_at IS NULL;

UPDATE proc.purchase_requisitions pr
   SET hod_approved_at = src.ts
  FROM (
    SELECT DISTINCT ON (a.entity_id) a.entity_id, a.ts
      FROM audit.audit_log a
     WHERE a.entity = 'proc.purchase_requisitions'
       AND a.action = 'update'
       AND a.before->>'status' = 'IN_HOD_REVIEW'
       AND a.after->>'status' IS DISTINCT FROM 'IN_HOD_REVIEW'
       AND a.after->>'status' IS DISTINCT FROM 'ON_HOLD'
       AND a.after->>'status' IS DISTINCT FROM 'REJECTED'
     ORDER BY a.entity_id, a.ts ASC
  ) src
 WHERE src.entity_id = pr.id::text
   AND pr.hod_approved_at IS NULL;

-- The `procurement_entered_at` backfill that used to sit here was removed by
-- migration 058 along with the column itself. See 058's header.

-- ═══ 4 · Configuration ═══════════════════════════════════════════════════════
--
-- Two new rows in the typed catalog from migration 032. Neither is seeded with
-- a bare literal inside a function; migration 038's DIRECTIVE 1 ("no hardcoded
-- limits -- fail closed, never invent a default") applies to these exactly as
-- it does to the attachment ceilings.
--
-- The threshold key is deliberately verbose. An admin reading a settings list
-- must be able to tell from the NAME what it governs without opening it.

INSERT INTO core.settings (key, value, value_type, label, description, group_name, is_toggle, sort_order) VALUES
  ('rfqDelayHours', to_jsonb(48), 'int',
   'RFQ issue delay limit (hours)',
   'Hours after a PR becomes procurement''s responsibility (HOD approval, or fast-track straight to procurement) within which an RFQ must be issued. Past this, the PR''s sourcing status is flagged red on the Lightweight PRs grid.',
   'Sourcing', false, 20),
  ('quotation_received_threshold_against_rfq', to_jsonb(50), 'number',
   'Quotation received threshold vs invited vendors (%)',
   'Percentage of invited vendors whose response (quotation OR manual decline) closes the RFQ once the quote deadline passes. At or above this, sourcing is marked "Received (threshold met)" and procurement continues. Below it, the PR is flagged Expired. Individual vendors who never responded are still flagged Expired internally either way.',
   'Sourcing', false, 21)
ON CONFLICT (key) DO UPDATE SET
  label       = EXCLUDED.label,
  description = EXCLUDED.description,
  group_name  = EXCLUDED.group_name;

-- ── 4a · The two fail-closed readers ─────────────────────────────────────────
--
-- Same contract as core.fn_pr_attachment_cap_bytes(): configuration or an
-- ERROR, never a literal. A missing row must surface as "not configured", not
-- as a silent 48-hour default that quietly disables the fraud alarm.

CREATE OR REPLACE FUNCTION proc.fn_rfq_delay_hours()
RETURNS int
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v int;
BEGIN
  SELECT (value #>> '{}')::int INTO v FROM core.settings WHERE key = 'rfqDelayHours';
  IF v IS NULL THEN
    RAISE EXCEPTION
      'RFQ delay limit is not configured: core.settings has no rfqDelayHours row. '
      'Create it before relying on the sourcing delay alarm — refusing rather than assuming a limit.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v <= 0 THEN
    RAISE EXCEPTION 'rfqDelayHours is % — a delay limit must be positive', v
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION proc.fn_quotation_received_threshold_pct()
RETURNS numeric
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v numeric;
BEGIN
  SELECT (value #>> '{}')::numeric INTO v
    FROM core.settings WHERE key = 'quotation_received_threshold_against_rfq';
  IF v IS NULL THEN
    RAISE EXCEPTION
      'quotation received threshold is not configured: core.settings has no '
      'quotation_received_threshold_against_rfq row. Create it before relying on '
      'the Expired / Received split — refusing rather than assuming a threshold.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Percent, not a fraction: 0.5 and 50 are both "half" and only one of them is
  -- what an admin typing into a percentage field means. 0 would make every RFQ
  -- close on the first response; 100 would mean never close early.
  IF v <= 0 OR v > 100 THEN
    RAISE EXCEPTION 'quotation_received_threshold_against_rfq is % — must be a percentage in (0,100]', v
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v;
END;
$$;

COMMENT ON FUNCTION proc.fn_rfq_delay_hours() IS
  'Configured RFQ issue delay in hours. RAISES when unconfigured; never defaults.';
COMMENT ON FUNCTION proc.fn_quotation_received_threshold_pct() IS
  'Configured quotation-received threshold as a percentage of invited vendors. RAISES when unconfigured; never defaults.';

-- ═══ Post-condition check (inside the transaction, so a failure rolls back) ═══

DO $$
DECLARE
  n           int;
  anchored    int;
  eligible    int;
BEGIN
  -- (1) The new RFQ columns exist with the right shape.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='proc' AND table_name='rfq' AND column_name='reissue_count'
       AND data_type='integer' AND is_nullable='NO' AND column_default='0'
  ) THEN
    RAISE EXCEPTION 'migration 057: proc.rfq.reissue_count is missing or not NOT NULL DEFAULT 0';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='proc' AND table_name='rfq' AND column_name='last_reissued_at'
  ) THEN
    RAISE EXCEPTION 'migration 057: proc.rfq.last_reissued_at is missing';
  END IF;

  -- (2) The consistency CHECK is live. A constraint that can be violated is not
  --     a guard, and both of these columns exist precisely to be trusted.
  --     pg_constraint, not pg_trigger: a CHECK is enforced by the rewrite
  --     machinery, it has no trigger row at all.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='proc.rfq'::regclass
       AND conname='rfq_reissue_stamp_consistent'
       AND contype='c'
  ) THEN
    RAISE EXCEPTION 'migration 057: rfq_reissue_stamp_consistent CHECK is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='proc.rfq'::regclass
       AND conname='rfq_reissue_count_nonneg'
       AND contype='c'
  ) THEN
    RAISE EXCEPTION 'migration 057: rfq_reissue_count_nonneg CHECK is missing';
  END IF;

  -- (3) The stamp trigger is live and BEFORE, so it runs ahead of the audit
  --     trigger from 014 and every status write is covered -- not just the ones
  --     someone remembered to touch.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid='proc.purchase_requisitions'::regclass
       AND tgname='trg_prs_stamp_sourcing_clock' AND NOT tgisinternal AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'migration 057: trg_prs_stamp_sourcing_clock is missing or disabled';
  END IF;

  -- (4) The audit trigger from 014 must still be there. These two triggers run
  --     in sequence and one silently replacing the other would look identical
  --     to "the audit log stopped growing".
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid='proc.purchase_requisitions'::regclass
       AND tgname='trg_prs_audit' AND NOT tgisinternal AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'migration 057: trg_prs_audit from migration 014 is gone';
  END IF;

  -- (5) Both settings exist and store the jsonb type their row declares.
  SELECT count(*) INTO n FROM core.settings
   WHERE key IN ('rfqDelayHours','quotation_received_threshold_against_rfq')
     AND jsonb_typeof(value) = 'number';
  IF n <> 2 THEN
    RAISE EXCEPTION 'migration 057: expected 2 numeric sourcing settings, found %', n;
  END IF;

  -- (6) Both readers work, which proves the rows are reachable and in range.
  PERFORM proc.fn_rfq_delay_hours();
  PERFORM proc.fn_quotation_received_threshold_pct();

  -- (7) The backfill anchored EVERY PR it was supposed to. A backfill that
  --     silently matched zero rows while eligible rows existed would leave the
  --     alarm dark on every historical PR and still report success, so the
  --     count is asserted, not assumed.
  --
  --     "Zero anchored" is a failure only when there was provably something to
  --     anchor. The old unconditional `anchored = 0` test aborted the first
  --     deploy of every FRESH environment: a database where no PR had ever been
  --     HOD-approved has nothing to anchor, and zero is the correct answer.
  --     Eligibility below is the UNION of the two sources the backfill above
  --     reads, joined to real PRs, so the comparison is exact.
  --
  --     This is strictly STRONGER than the test it replaces: it fails when even
  --     ONE eligible PR was left unanchored, not only when all of them were.
  SELECT count(*) INTO anchored FROM proc.purchase_requisitions
   WHERE hod_approved_at IS NOT NULL;
  SELECT count(*) INTO eligible FROM (
    SELECT pd.pr_id::text AS pr_id
      FROM proc.pr_departments pd
      JOIN proc.purchase_requisitions pr2 ON pr2.id = pd.pr_id
     WHERE pd.hod_status = 'approved' AND pd.hod_decided_at IS NOT NULL
    UNION
    SELECT a.entity_id
      FROM audit.audit_log a
      JOIN proc.purchase_requisitions pr3 ON pr3.id::text = a.entity_id
     WHERE a.entity = 'proc.purchase_requisitions'
       AND a.action = 'update'
       AND a.before->>'status' = 'IN_HOD_REVIEW'
       AND a.after->>'status' IS DISTINCT FROM 'IN_HOD_REVIEW'
       AND a.after->>'status' IS DISTINCT FROM 'ON_HOLD'
       AND a.after->>'status' IS DISTINCT FROM 'REJECTED'
  ) el;
  IF anchored < eligible THEN
    RAISE EXCEPTION 'migration 057: hod_approved_at backfill anchored % PR(s) but % were eligible — the alarm would be dark on some PRs', anchored, eligible;
  END IF;

  -- (8) No RFQ may claim a re-issue without saying when. This is the invariant
  --     the whole Re-issued chip depends on.
  SELECT count(*) INTO n FROM proc.rfq
   WHERE (reissue_count > 0 AND last_reissued_at IS NULL)
      OR (reissue_count = 0 AND last_reissued_at IS NOT NULL);
  IF n <> 0 THEN
    RAISE EXCEPTION 'migration 057: % proc.rfq row(s) have an inconsistent re-issue stamp', n;
  END IF;

  RAISE NOTICE 'migration 057 verified — % PR(s) anchored to HOD approval; sourcing settings live', anchored;
END $$;

\echo '--- 057: sourcing status clock ready ---'
SELECT count(*) AS rfqs                    FROM proc.rfq;
SELECT count(*) AS prs_with_hod_anchor     FROM proc.purchase_requisitions WHERE hod_approved_at IS NOT NULL;

COMMIT;