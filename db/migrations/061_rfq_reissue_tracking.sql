-- 061_rfq_reissue_tracking.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY A TABLE, WHEN proc.rfq ALREADY HAS reissue_count AND last_reissued_at
-- ─────────────────────────────────────────────────────────────────────────────
-- Those two columns answer "has this RFQ ever been re-issued, and when was the
-- last time" and nothing else. The detail page has to show the ORIGINAL issue
-- beside the RE-ISSUE, side by side, and the original deadline is not
-- recoverable from `proc.rfq` after the fact:
--
--     UPDATE proc.rfq SET deadline_at = COALESCE($2, deadline_at)
--
-- overwrites it in place. Once a re-issue has moved the date, the number the
-- buyer was originally working to is simply gone. So:
--
--   proc.rfq.initial_deadline_at  the deadline as first issued, never mutated
--   proc.rfq_reissues             one row per re-issue — the deadline BEFORE
--                                 and AFTER each one, so a competition that
--                                 was extended four times can still be read
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY proc.rfq_invitations GETS ITS OWN reissue_no
-- ─────────────────────────────────────────────────────────────────────────────
-- The obvious derivation is "invited_at > issued_at means a re-issue", and it
-- is WRONG on this data. Measured before writing this migration:
--
--     rfq total 553 · invitations 1582 · invitations after issued_at 1582
--
-- Every single invitation — including the ones from the very first issue — is
-- stamped a few microseconds after `issued_at`, because `issue()` writes the RFQ
-- row and then the invitations in one call. The heuristic classifies all 1582
-- of them as re-invited. It carries no information at all, and shipping a
-- column derived from it would have made the new UI assert a re-invitation that
-- never happened.
--
-- So the marker is written by the only code that can know it: `reissue()`,
-- which knows which invitations it just created.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THE BACKFILL DELIBERATELY DOES NOT CLAIM
-- ─────────────────────────────────────────────────────────────────────────────
-- 26 RFQs carry reissue_count = 1 from earlier e2e runs, so real re-issues DID
-- happen before this migration. Which of their invitations those re-issues
-- added cannot be recovered from the data, and is NOT guessed here: every
-- existing invitation backfills to 0 = "original issue".
--
-- That under-claims rather than over-claims. The RFQ-level re-issue
-- (reissue_count / last_reissued_at) is still reported for those 26, so they
-- still show as re-issued; only the per-vendor "added at re-issue #N" is absent
-- for pre-existing invitations.
--
-- `initial_deadline_at = deadline_at` IS safe for every existing row, and that
-- was checked rather than assumed: of the 26 re-issued RFQs, none has a
-- deadline that deviates from `issued_at + 7 days`. The 5 that look like they do
-- carry a midnight-truncated deadline (00:00:00) — the day-granularity defect
-- documented at rfq.service.ts:1030 — not a deadline a re-issue moved.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- AUDIT
-- ─────────────────────────────────────────────────────────────────────────────
-- proc.rfq has NO audit trigger (the four trg_*_audit triggers cover
-- core.vendors, proc.purchase_requisitions, workflow.approval_votes and
-- core.email_outbox). So until now a re-issue updated reissue_count and
-- last_reissued_at and left NOTHING in audit.audit_log — the one event on this
-- document that changes who is competing against whom was the one event with no
-- trail. `rfq_reissue` is added to the vocabulary so it is greppable.
--
-- REPLAY SAFETY: every statement is IF NOT EXISTS / UPDATE-guarded. The scratch
-- runner has no migration ledger and re-applies every file on every run.


-- ═════════════════════════════════════════════════════════════════════════════
-- A · proc.rfq_reissues — one row per re-issue
-- ═════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS proc.rfq_reissues (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id          uuid NOT NULL REFERENCES proc.rfq(id) ON DELETE CASCADE,
  -- 1-based. Matches proc.rfq.reissue_count once the re-issue has been applied,
  -- so "the Nth re-issue" has one unambiguous meaning across both places.
  reissue_no      integer NOT NULL CHECK (reissue_no >= 1),
  reissued_at     timestamptz NOT NULL DEFAULT now(),
  -- Both deadlines are kept. `deadline_before` is the only surviving record of
  -- a date a competition was originally run to.
  deadline_before timestamptz NOT NULL,
  deadline_after  timestamptz NOT NULL,
  vendors_added   integer NOT NULL DEFAULT 0 CHECK (vendors_added >= 0),
  actor_user_id   uuid REFERENCES core.users(id),
  reason          text,
  CONSTRAINT rfq_reissues_unique UNIQUE (rfq_id, reissue_no)
);

CREATE INDEX IF NOT EXISTS idx_rfq_reissues_rfq
  ON proc.rfq_reissues(rfq_id, reissue_no DESC);


-- ═════════════════════════════════════════════════════════════════════════════
-- B · proc.rfq.initial_deadline_at
-- ═════════════════════════════════════════════════════════════════════════════
-- A bare `IF ... END IF` is not valid at script top level, so each guard is a
-- DO block; the DDL inside is EXECUTEd, which is the only way to run ALTER
-- TABLE conditionally from plpgsql.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'proc' AND table_name = 'rfq'
       AND column_name = 'initial_deadline_at'
  ) THEN
    EXECUTE 'ALTER TABLE proc.rfq ADD COLUMN initial_deadline_at timestamptz';
  END IF;
END $$;

UPDATE proc.rfq SET initial_deadline_at = deadline_at WHERE initial_deadline_at IS NULL;


-- ═════════════════════════════════════════════════════════════════════════════
-- C · proc.rfq_invitations.reissue_no — 0 = original issue
-- ═════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'proc' AND table_name = 'rfq_invitations'
       AND column_name = 'reissue_no'
  ) THEN
    EXECUTE 'ALTER TABLE proc.rfq_invitations ADD COLUMN reissue_no integer NOT NULL DEFAULT 0';
    EXECUTE 'ALTER TABLE proc.rfq_invitations ADD CONSTRAINT rfq_invitations_reissue_no_nonneg CHECK (reissue_no >= 0)';
  END IF;
END $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- D · audit vocabulary gains 'rfq_reissue'
-- ═════════════════════════════════════════════════════════════════════════════
-- Redefined with one action appended. The installed helper takes NO arguments
-- and carries its own hardcoded canon, so an action has to be added to that
-- array — the same thing 041, 042 and 049 each did for theirs.
--
-- The body is the installed one, unchanged, and its union of canon with the
-- PERMITTED set read out of pg_constraint is what makes this safe to replay and
-- safe to run after any other migration: rebuilding from canon alone is the
-- defect that silently narrowed the vocabulary three times.
CREATE OR REPLACE FUNCTION audit.fn_widen_audit_log_actions() RETURNS void AS $body$
DECLARE
  canon text[] := ARRAY[
    'create','update','delete','approve','reject','return','push','reassign',
    'login','logout','workflow_config_change','pack_freeze','pack_push',
    'sod_violation','dead_letter',
    'hold','unhold','category_change','vendor_update','d365_vendor_sync',
    'phone_negotiation','cs_line_award','cs_split_lock',
    'po_generate','po_issue','po_push','po_cancel',
    'd365_master_sync','d365_po_push',
    'category_enable','category_disable','category_unlink',
    'repair',
    -- 061: an RFQ re-issue changed the roster and/or the deadline of a live
    -- competition. Until this action existed the event updated proc.rfq and
    -- wrote no audit row at all.
    'rfq_reissue'
  ];
  canon_literal text;
  def text;
  permitted text[];
  merged text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint
   WHERE conname = 'audit_log_action_check' AND conrelid = 'audit.audit_log'::regclass;

  IF def IS NULL THEN
    SELECT string_agg(quote_literal(a), ',') INTO canon_literal FROM unnest(canon) AS a;
    EXECUTE 'ALTER TABLE audit.audit_log ADD CONSTRAINT audit_log_action_check '
            'CHECK (action = ANY(ARRAY[' || canon_literal || ']))';
    RETURN;
  END IF;

  SELECT COALESCE(array_agg(DISTINCT m[1] ORDER BY m[1]), ARRAY[]::text[])
    INTO permitted
    FROM regexp_matches(def, $q$'([^']+)'$q$, 'g') AS m;

  IF array_length(permitted, 1) IS NULL THEN
    RAISE EXCEPTION
      'fn_widen_audit_log_actions: could not read the permitted action list out of '
      'audit_log_action_check, so rebuilding it could NARROW the audit vocabulary. '
      'Refusing to run. Installed definition: %', def;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM unnest(canon) a WHERE NOT (a = ANY(permitted))) THEN
    RETURN;
  END IF;

  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), ARRAY[]::text[])
    INTO merged
    FROM unnest(canon || permitted) AS x;

  SELECT string_agg(quote_literal(a), ',') INTO canon_literal FROM unnest(merged) AS a;

  EXECUTE 'ALTER TABLE audit.audit_log DROP CONSTRAINT audit_log_action_check';
  EXECUTE 'ALTER TABLE audit.audit_log ADD CONSTRAINT audit_log_action_check '
          'CHECK (action = ANY(ARRAY[' || canon_literal || ']))';
END
$body$ LANGUAGE plpgsql;

SELECT audit.fn_widen_audit_log_actions();


-- ═════════════════════════════════════════════════════════════════════════════
-- E · VERIFY — assert what this migration claims, not what it intended
-- ═════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_def text;
  n integer;
  v_missing text;
BEGIN
  -- (1) The action must be PERMITTED. "The function ran" is not the same claim
  --     as "the CHECK accepts the value" — probe the rendered constraint.
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conname = 'audit_log_action_check' AND conrelid = 'audit.audit_log'::regclass;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'migration 061: audit_log_action_check is missing';
  END IF;

  IF position('''rfq_reissue''' in v_def) = 0 THEN
    RAISE EXCEPTION 'migration 061: audit_log_action_check does not permit rfq_reissue';
  END IF;

  -- (2) The widen must not have DROPPED anything that was permitted before.
  --     Every action named in 038b/041/042 must still be there; a rebuild that
  --     quietly lost one would fail on every row already carrying it.
  FOREACH v_missing IN ARRAY ARRAY['repair','po_generate','po_issue',
                                    'cs_split_lock','d365_master_sync'] LOOP
    IF position('''' || v_missing || '''' in v_def) = 0 THEN
      RAISE EXCEPTION
        'migration 061: widening the audit vocabulary dropped ''%'' — the rebuild '
        'narrowed instead of widened', v_missing;
    END IF;
  END LOOP;

  -- (3) No issued RFQ may lack its original deadline. The header renders that
  --     column beside the re-issued one, and a blank there reads as "no
  --     deadline", which is a different claim from "we cannot say".
  SELECT count(*) INTO n FROM proc.rfq
   WHERE issued_at IS NOT NULL AND initial_deadline_at IS NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION
      'migration 061: % issued proc.rfq row(s) have no initial_deadline_at', n;
  END IF;

  -- (4) initial_deadline_at must never sit AFTER the current deadline. The
  --     deadline only ever moves outward, so an original later than the live
  --     one means a backfill or a manual edit went wrong.
  SELECT count(*) INTO n FROM proc.rfq
   WHERE initial_deadline_at IS NOT NULL
     AND deadline_at IS NOT NULL
     AND initial_deadline_at > deadline_at + interval '1 second';
  IF n <> 0 THEN
    RAISE EXCEPTION
      'migration 061: % proc.rfq row(s) have initial_deadline_at AFTER deadline_at', n;
  END IF;

  -- (5) Every invitation's reissue_no must name a re-issue its own RFQ
  --     actually has. An orphan here would render a "re-invited at" date
  --     pointing at a row that does not exist.
  SELECT count(*) INTO n
    FROM proc.rfq_invitations i
    JOIN proc.rfq r ON r.id = i.rfq_id
   WHERE i.reissue_no > r.reissue_count;
  IF n <> 0 THEN
    RAISE EXCEPTION
      'migration 061: % invitation(s) carry a reissue_no greater than their RFQ''s reissue_count', n;
  END IF;

  RAISE NOTICE
    'migration 061: rfq_reissue permitted · initial_deadline_at backfilled on % rfq(s) · invitations backfilled to reissue_no 0',
    (SELECT count(*) FROM proc.rfq WHERE initial_deadline_at IS NOT NULL);
END $$;