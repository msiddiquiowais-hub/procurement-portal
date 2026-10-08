-- ═══════════════════════════════════════════════════════════════════════════
-- 041 — Wave 5 Track G: make a LINE-ITEM SPLIT AWARD a lockable outcome.
--
-- THE GAP THIS CLOSES, stated precisely
--
-- Track F built the whole split-award machinery: `proc.cs_line_awards` records
-- a winner per RFQ line, supersedes rather than overwrites, and can re-award.
-- But the COMPARATIVE STATEMENT could not express one. `csLock()` demanded a
-- single `winnerVendorId` drawn from `proc.cs_lines` (which is per VENDOR, not
-- per line) and wrote `recommendation` with exactly one `winner_vendor_id`.
--
-- So a procurement officer who awarded line 1 to vendor A and line 2 to vendor
-- B could not record that decision where it matters. Locking the CS did two
-- actively wrong things:
--
--   1. It marked ONE quotation 'Awarded' and every other vendor's quotation
--      'Rejected' — so vendor B, who won line 2, had their live quote
--      recorded as rejected. Not "losing", REJECTED.
--   2. It discarded `proc.cs_line_awards` entirely from the recommendation,
--      which is what the approved pack hashes and what D365 pushes.
--
-- Six call sites read `recommendation->>'winner_vendor_id'`. The worst is
-- d365.service.ts, which INNER JOINs on it — a NULL winner there produces no
-- row at all rather than an error, i.e. a silently empty D365 push.
--
-- THE DECISION THIS RECORDS
--
-- `award_mode` says whether the CS was locked as ONE winner for the whole
-- package (SINGLE — the prototype's flow, unchanged) or as per-line winners
-- (SPLIT). For a SPLIT the recommendation carries a `split` array and carries
-- NO `winner_vendor_id`, because a split genuinely has no single winner.
--
-- Inventing a "lead vendor" to keep the old column populated was considered and
-- rejected: it would over-attribute the whole `winner_total` to one vendor and
-- silently inflate their lifetime spend by lines they did not win. A column
-- that cannot hold the truth is worse than an absent one, because it looks
-- populated.
--
-- The consistency CHECK below is the part that matters: it is the DATABASE
-- refusing to hold a SPLIT that claims a single winner, or a single winner
-- with no vendor. A half-written split cannot sit in the table.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── the column ───────────────────────────────────────────────────────────
-- 'SINGLE' as the default, not NULL: every CS locked before this migration had
-- exactly one winner, and saying so explicitly is truer than leaving the new
-- column NULL on historical rows and making every reader special-case it.
ALTER TABLE proc.comparative_statements
  ADD COLUMN IF NOT EXISTS award_mode text;

UPDATE proc.comparative_statements
   SET award_mode = 'SINGLE'
 WHERE award_mode IS NULL;

ALTER TABLE proc.comparative_statements
  ALTER COLUMN award_mode SET DEFAULT 'SINGLE',
  ALTER COLUMN award_mode SET NOT NULL;

-- Idempotent: the constraint is dropped and recreated, so a replay of this
-- migration on an already-migrated database is a no-op rather than an error.
ALTER TABLE proc.comparative_statements
  DROP CONSTRAINT IF EXISTS comparative_statements_award_mode_check;

ALTER TABLE proc.comparative_statements
  ADD CONSTRAINT comparative_statements_award_mode_check
  CHECK (award_mode = ANY (ARRAY['SINGLE', 'SPLIT']));

-- ── the consistency rule ─────────────────────────────────────────────────
-- Only applies to a LOCKED CS. A Generated CS has no recommendation yet, so
-- asserting on it would fail every freshly generated statement.
ALTER TABLE proc.comparative_statements
  DROP CONSTRAINT IF EXISTS comparative_statements_split_consistency;

-- NULL-SAFE, and the `coalesce(...,'null'::jsonb)` is load-bearing rather than
-- cosmetic. A CHECK constraint fails only when its expression is FALSE — a NULL
-- result PASSES. `jsonb_typeof(recommendation->'split')` returns SQL NULL when
-- the key is absent, so the naive form evaluated to NULL and let a SPLIT with no
-- split array through. That is not theoretical: it wrote a real comparative
-- statement at round 98 for the fixture PR, which then declared the genuine
-- round-1 CS superseded and broke every subsequent read of it.
ALTER TABLE proc.comparative_statements
  ADD CONSTRAINT comparative_statements_split_consistency
  CHECK (
    coalesce(state IS DISTINCT FROM 'Locked' OR award_mode = 'SINGLE', true)
    OR (
      recommendation IS NOT NULL
      AND jsonb_typeof(coalesce(recommendation -> 'split', 'null'::jsonb)) = 'array'
      AND jsonb_array_length(recommendation -> 'split') > 0
      AND NOT coalesce(recommendation ? 'winner_vendor_id', true)
    )
  );

-- ── the audit vocabulary ─────────────────────────────────────────────────
-- A split lock is a different commercial event from a single lock and a
-- different event again from an individual line award (which Track F already
-- logs as 'cs_line_award'). A later reader asking "who decided this package was
-- split, and why" gets its own answer.
CREATE OR REPLACE FUNCTION audit.fn_widen_audit_log_actions()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  canon text[] := ARRAY[
    'create','update','delete','approve','reject','return','push','reassign',
    'login','logout','workflow_config_change','pack_freeze','pack_push',
    'sod_violation','dead_letter',
    -- Rule 5 additions. Everything above is pre-existing and is repeated here
    -- deliberately, so this list is a strict superset of migration 007's.
    'hold','unhold','category_change','vendor_update','d365_vendor_sync',
    -- Wave 5 Track F: a rate agreed on a phone call, and a line awarded inside a
    -- comparative statement. Both are commercial decisions a later reader must be
    -- able to find, so they get their own action rather than hiding inside
    -- 'update' alongside every incidental column change.
    'phone_negotiation','cs_line_award',
    -- Wave 5 Track G: the CS was locked as a SPLIT across several vendors, which
    -- is not the same decision as any individual line award and not the same as
    -- locking a single winner.
    'cs_split_lock'
  ];
  canon_literal text;
  def text;
  missing text;
BEGIN
  SELECT string_agg(quote_literal(a), ',') INTO canon_literal FROM unnest(canon) AS a;

  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint
   WHERE conname = 'audit_log_action_check' AND conrelid = 'audit.audit_log'::regclass;

  IF def IS NULL THEN
    EXECUTE 'ALTER TABLE audit.audit_log ADD CONSTRAINT audit_log_action_check '
            'CHECK (action = ANY(ARRAY[' || canon_literal || ']))';
    RETURN;
  END IF;

  SELECT string_agg(a, ', ') INTO missing
    FROM unnest(canon) AS a
   WHERE position('''' || a || '''' in def) = 0;

  IF missing IS NULL THEN
    RETURN;                       -- already a superset; leave it alone
  END IF;

  EXECUTE 'ALTER TABLE audit.audit_log DROP CONSTRAINT audit_log_action_check';
  EXECUTE 'ALTER TABLE audit.audit_log ADD CONSTRAINT audit_log_action_check '
          'CHECK (action = ANY(ARRAY[' || canon_literal || ']))';
END $function$;

SELECT audit.fn_widen_audit_log_actions();

-- ── post-condition ───────────────────────────────────────────────────────
DO $$
DECLARE
  missing text;
  locked_splits int;
BEGIN
  SELECT string_agg(x, ', ') INTO missing FROM unnest(ARRAY[
    'comparative_statements_award_mode_check',
    'comparative_statements_split_consistency'
  ]) AS x
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_constraint
      WHERE conname = x AND conrelid = 'proc.comparative_statements'::regclass);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'migration 041: constraints missing: %', missing;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'proc' AND table_name = 'comparative_statements'
       AND column_name = 'award_mode' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'migration 041: proc.comparative_statements.award_mode missing or nullable';
  END IF;

  -- The audit vocabulary must actually accept the new action. Asserted by
  -- probing the constraint text rather than by trusting the function ran.
  -- pg_constraint has no `condef` column — the rendered text comes from
  -- pg_get_constraintdef(oid).
  IF position('''cs_split_lock''' in (
       SELECT pg_get_constraintdef(oid) FROM pg_constraint
        WHERE conname = 'audit_log_action_check'
          AND conrelid = 'audit.audit_log'::regclass)) = 0 THEN
    RAISE EXCEPTION 'migration 041: audit_log_action_check does not permit cs_split_lock';
  END IF;

  -- A historical CS can never have been a split: there was no way to record
  -- one. Anything else here would mean the backfill mislabelled something.
  SELECT count(*) INTO locked_splits
    FROM proc.comparative_statements
   WHERE state = 'Locked' AND award_mode <> 'SINGLE';

  IF locked_splits > 0 THEN
    RAISE EXCEPTION
      'migration 041: % locked CS row(s) are not SINGLE; a pre-split CS cannot be one', locked_splits;
  END IF;

  -- ── PROVE the CHECK bites, rather than trusting that it does ─────────────
  -- A constraint that is present but never fires is worse than no constraint:
  -- it reads as protection. This attempts the illegal INSERT for real, inside
  -- an exception block (plpgsql only permits ROLLBACK there), and FAILS the
  -- migration if the row is accepted.
  --
  -- The template row is an existing CS, because the NOT NULL FKs make a
  -- synthetic row impossible to construct. An empty table simply skips the
  -- probe — there is nothing to prove against yet.
  IF EXISTS (SELECT 1 FROM proc.comparative_statements LIMIT 1) THEN
    DECLARE accepted boolean := false;
    BEGIN
      BEGIN
        INSERT INTO proc.comparative_statements
          (cs_number, pr_id, rfq_id, cs_round, generated_at, generated_by_user_id,
           locked_at, locked_by_user_id, state, scores, recommendation, award_mode)
        SELECT 'CS-W5G041-PROBE', pr_id, rfq_id, 999999, now(), generated_by_user_id,
               now(), generated_by_user_id, 'Locked', '{}'::jsonb,
               '{"reason":"migration 041 probe"}'::jsonb, 'SPLIT'
          FROM proc.comparative_statements LIMIT 1;
        accepted := true;
      EXCEPTION WHEN others THEN
        NULL;   -- refused, which is the outcome this migration wants
      END;
      IF accepted THEN
        RAISE EXCEPTION
          'migration 041: a SPLIT with no split array was ACCEPTED — the CHECK is NULL-unsafe '
          '(a CHECK only fails on FALSE, and jsonb_typeof of a missing key returns SQL NULL)';
      END IF;
    END;
  END IF;

  RAISE NOTICE 'migration 041 ok: award_mode present, split consistency enforced AND proven, cs_split_lock auditable';
END $$;

COMMIT;
