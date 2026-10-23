-- ══════════════════════════════════════════════════════════════════════════════
-- 038b · repair the audit hash chain, and stop it forking again
-- ══════════════════════════════════════════════════════════════════════════════
--
-- WHY THIS FILE EXISTS, AND WHY IT SORTS BEFORE 039
-- ---------------------------------------------------
-- Every `db:migrate` failed at 039 with:
--
--     migration 039: the audit hash chain is broken at row 5067
--
-- and it was being bypassed. This diagnoses it, proves what it is, fixes the
-- cause, and repairs the damage. It is NOT a bypass — 039's check is left
-- exactly as written and is allowed to pass only because the chain is
-- genuinely whole by the time it runs.
--
-- It is numbered 038b rather than 059 for one reason: 039 ASSERTS the chain is
-- intact. A repair placed after it would leave 039 failing on the first pass
-- and only succeeding on the second, which is worse than no fix — it trains
-- everyone to ignore that error. Running first means one `db:migrate` converges.
-- The `hash_chain_*` columns were added long before 039 (migration 016), so
-- nothing here depends on 039 having run.
--
-- THE DIAGNOSIS — a race, not tampering
-- --------------------------------------
-- `audit.fn_audit_log_seal()` computed each row's predecessor with:
--
--     SELECT hash_chain_self INTO v_prev
--       FROM audit.audit_log
--      WHERE hash_chain_self IS NOT NULL
--      ORDER BY id DESC LIMIT 1;
--
-- That is an unsynchronised read-modify-write. Two sessions inserting audit
-- rows at the same moment both read the same predecessor — neither can see the
-- other's uncommitted row — and both chain from it. The result is a FORK: two
-- rows sharing one `hash_chain_prev`, the second not chaining from the first.
--
-- The fingerprint is in the data. Rows 5066 and 5067 both point at 5065:
--
--     5066 | ts 11:40:02.462535 | prev ...3eb08410
--     5067 | ts 11:40:02.462318 | prev ...3eb08410   <-- same predecessor
--
-- and 5067's timestamp is 217 microseconds EARLIER than 5066's while its id is
-- higher. Two independent sessions, interleaved.
--
-- A single multi-row INSERT was ruled out by direct experiment: a two-row
-- VALUES insert chains correctly, because PostgreSQL makes each row visible to
-- the next row's BEFORE trigger within the same command.
--
-- WHAT WAS NOT WRONG
-- ------------------
-- Before touching a single hash, every row's content was re-derived from its
-- own columns and compared to its stored `hash_chain_self`:
--
--     total 9976 | content verified 9976 | content mismatch 0
--
-- So no audit fact was altered. The damage is confined to LINKAGE. That is what
-- makes a repair legitimate — and it is why section B RE-RUNS that
-- verification rather than trusting the number written in this comment: it is
-- the difference between fixing a chain and laundering a tampered one.
--
-- THE REPAIR
-- ----------
-- `hash_chain_self` is `sha256(prev | id | ts | actor | entity | entity_id |
-- action | before | after | correlation_id)`. Every term except `prev` comes
-- from the row itself, so the correct hash for any chosen `prev` is fully
-- re-derivable from stored content. The chain is recomputed in id order from
-- the first break to the tail.
--
-- That recomputation CASCADES: re-hashing row N changes its `hash_chain_self`,
-- which row N+1 points at, and so on. Rewriting only the forked rows would
-- merely move the break. Everything from the first fork onward is recomputed,
-- and only rows whose hash genuinely differs are written — so the trail comes
-- out byte-identical wherever it was already correct, and the repaired chain
-- can be compared against the evidence it replaces.
--
-- WHAT THIS DOES NOT DO
-- ---------------------
-- It does not weaken `fn_verify_audit_chain()`, exempt any row, or archive or
-- delete an audit entry. The append-only guard is disabled only for the
-- recomputation and is re-asserted afterwards. Tamper-evidence is unchanged
-- going forward: an altered, inserted or deleted row still breaks the chain,
-- because the hashes are a function of what is actually stored.
--
-- The repair is itself recorded as an audit row, so the one event that rewrote
-- hashes is in the trail.
--
-- ON A FRESH DATABASE the REPAIR is a no-op: at this point no rows are chained
-- yet (039 seals the history), so there is nothing to repair and the trigger
-- that 039 has not yet created is never touched. Sections B1 and B2 do still
-- run — B1 creates `audit.fn_widen_audit_log_actions()`, which 039 calls before
-- any later migration has had a chance to define it, and B2 admits `repair` to
-- a vocabulary that then has no row using it. Both are idempotent.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════════════
-- A. FIX THE RACE
-- ══════════════════════════════════════════════════════════════════════════════
-- `pg_advisory_xact_lock` is transaction-scoped: taken before the predecessor is
-- read, held until commit or rollback, so two concurrent inserts cannot both
-- read the same predecessor. An advisory lock rather than `LOCK TABLE` because
-- it serialises WRITERS only — every audit-trail reader is unaffected.
--
-- The key is an arbitrary fixed constant. Its only requirement is that every
-- writer of this table uses the same one.
--
-- This also removes a second, quieter dependency on ambient state: the seal
-- hashed `NEW.ts::text`, and a timestamptz's text form depends on the session's
-- `TimeZone`, so the same insert would hash differently depending on who ran
-- it. `set_config(..., is_local := true)` pins UTC for the statement and reverts
-- at transaction end. Under UTC the rendering is byte-identical to every hash
-- already stored, so NOT ONE existing hash changes — reformatting the payload
-- would have forced a rewrite of the entire trail, which is exactly the loss of
-- comparability this repair has to avoid.

-- The canonical payload expression, defined ONCE and used by the seal, the
-- verifier and the repair, so that "what a correct hash IS" cannot drift
-- between the three places that need it.
CREATE OR REPLACE FUNCTION audit.fn_audit_row_payload(
  p_id bigint, p_ts timestamptz, p_actor uuid, p_entity text, p_entity_id text,
  p_action text, p_before jsonb, p_after jsonb, p_correlation text
) RETURNS text AS $$
  SELECT COALESCE(p_id::text,'') || '|' ||
         p_ts::text || '|' ||
         COALESCE(p_actor::text,'') || '|' || p_entity || '|' || p_entity_id || '|' ||
         p_action || '|' || COALESCE(p_before::text,'') || '|' ||
         COALESCE(p_after::text,'') || '|' || COALESCE(p_correlation, '');
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION audit.fn_audit_log_seal() RETURNS trigger AS $$
DECLARE v_prev text;
BEGIN
  -- Serialise against any other in-flight audit insert. Without this the read
  -- below is a race: two sessions both see the same tail row and both chain
  -- from it, forking the chain.
  PERFORM pg_advisory_xact_lock(741039001);

  -- Make the timestamp rendering a function of the data, not of the session.
  PERFORM set_config('TimeZone', 'UTC', true);

  SELECT hash_chain_self INTO v_prev
    FROM audit.audit_log
   WHERE hash_chain_self IS NOT NULL
    -- ORDER BY id, not by anything derived from the row's own columns: the
    -- chain is defined over id order and the verifier walks id order.
   ORDER BY id DESC
   LIMIT 1;

  IF v_prev IS NULL THEN
    v_prev := 'genesis:' || encode(digest('proc-portal-audit-genesis-2026-09-26', 'sha256'), 'hex');
  END IF;

  NEW.hash_chain_prev := v_prev;
  NEW.hash_chain_self := 'sha256:' || encode(
    digest(
      v_prev || '|' ||
      audit.fn_audit_row_payload(
        NEW.id, NEW.ts, NEW.actor_user_id, NEW.entity, NEW.entity_id,
        NEW.action, NEW.before, NEW.after, NEW.correlation_id),
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ══════════════════════════════════════════════════════════════════════════════
-- B. PRE-FLIGHT — refuse to repair unless the CONTENT is provably intact
-- ══════════════════════════════════════════════════════════════════════════════
-- This is the check that separates "fix a linkage defect" from "paper over
-- tampering". If any row's stored hash does not re-derive from its own columns,
-- a fact was altered and re-hashing it would DESTROY the evidence. The repair
-- must not run, and this migration must fail loudly.
--
-- Only CHAINED rows are examined. An unchained row is not damaged, it is
-- simply not sealed yet, and 039 is what seals it.
DO $$
DECLARE v_bad bigint; v_chained bigint;
BEGIN
  SELECT count(*) INTO v_chained FROM audit.audit_log WHERE hash_chain_self IS NOT NULL;
  IF v_chained = 0 THEN
    RAISE NOTICE 'migration 038b: no chained rows yet (fresh database) — nothing to repair';
    RETURN;
  END IF;

  SELECT count(*) INTO v_bad
    FROM audit.audit_log a
   WHERE a.hash_chain_self IS NOT NULL
     AND a.hash_chain_self IS DISTINCT FROM
         'sha256:' || encode(digest(
           a.hash_chain_prev || '|' ||
           audit.fn_audit_row_payload(a.id, a.ts, a.actor_user_id, a.entity,
                                      a.entity_id, a.action, a.before, a.after,
                                      a.correlation_id),
           'sha256'), 'hex');

  IF v_bad > 0 THEN
    RAISE EXCEPTION
      'migration 038b: % of % chained audit row(s) do NOT re-derive from their own '
      'content. That is content tampering, not a linkage defect, and re-hashing '
      'would destroy the evidence. Repair aborted — investigate those rows first.',
      v_bad, v_chained;
  END IF;
  RAISE NOTICE 'migration 038b: all % chained audit row(s) verified against their own content',
                v_chained;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- B1. MAKE SURE THE VOCABULARY HELPER EXISTS BEFORE 039 CALLS IT
-- ══════════════════════════════════════════════════════════════════════════════
-- Migration 039 calls `audit.fn_widen_audit_log_actions()`, but no migration
-- that runs BEFORE it creates that function. 007 writes the CHECK inline as a
-- column constraint; the function itself first appears in 041, which sorts
-- AFTER 039. A database migrated from scratch therefore fails at 039 with
--
--     function audit.fn_widen_audit_log_actions() does not exist
--
-- and only an incrementally-built database gets past, because some earlier run
-- already created it. The bug is invisible to `db:migrate` on a working
-- database and to every replay of it — it is reachable only by building a
-- database that has never been migrated before.
--
-- Defined here, where it sorts before the first caller. The list is migration
-- 007's own inline vocabulary, restated so the helper is self-contained; 041,
-- 042 and 049 each supersede this definition with a larger `canon` later in the
-- very same run. Where the function already exists this section is a no-op.
DO $$
BEGIN
  IF to_regprocedure('audit.fn_widen_audit_log_actions()') IS NOT NULL THEN
    RETURN;                     -- 041/042/049 already defined it
  END IF;

  EXECUTE $fn$
CREATE FUNCTION audit.fn_widen_audit_log_actions()
 RETURNS void
 LANGUAGE plpgsql
AS $body$
DECLARE
  canon text[] := ARRAY[
    'create','update','delete','approve','reject','return','push','reassign',
    'login','logout','workflow_config_change','pack_freeze','pack_push'
  ];
  def text;
  permitted text[];
  merged text[];
BEGIN
  -- 007 already created this CHECK, so this is normally a rebuild rather than a
  -- first creation. Written in the same union-based form as the 041/042/049
  -- copies, and reading the permitted set from the CONSTRAINT for the same
  -- reason: the vocabulary belongs to the schema, not to whatever rows exist.
  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint
   WHERE conname = 'audit_log_action_check' AND conrelid = 'audit.audit_log'::regclass;

  IF def IS NULL THEN
    permitted := ARRAY[]::text[];
  ELSE
    SELECT COALESCE(array_agg(DISTINCT m[1] ORDER BY m[1]), ARRAY[]::text[])
      INTO permitted
      FROM regexp_matches(def, $qq$'([^']+)'$qq$, 'g') AS m;

    IF array_length(permitted, 1) IS NULL THEN
      RAISE EXCEPTION
        'fn_widen_audit_log_actions: could not read the permitted action list out of '
        'audit_log_action_check, so rebuilding it could NARROW the audit vocabulary. '
        'Refusing to run. Installed definition: %', def;
    END IF;
  END IF;

  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), ARRAY[]::text[])
    INTO merged
    FROM unnest(canon || permitted) AS x;

  EXECUTE 'ALTER TABLE audit.audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check';
  EXECUTE 'ALTER TABLE audit.audit_log ADD CONSTRAINT audit_log_action_check '
          'CHECK (action = ANY(ARRAY[' ||
            (SELECT string_agg(quote_literal(x), ',') FROM unnest(merged) x) || ']))';
END
$body$
$fn$;

  RAISE NOTICE 'migration 038b: created audit.fn_widen_audit_log_actions() (missing on a fresh database)';
END $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- B2. PERMIT THE `repair` ACTION
-- ══════════════════════════════════════════════════════════════════════════════
-- The repair records itself in the audit trail, and `repair` is not a
-- pre-existing action name, so the action vocabulary has to admit it first.
--
-- The new set is every action the INSTALLED CHECK already permits, plus
-- `repair`. Deriving it from the CONSTRAINT rather than from the TABLE keeps one
-- rule in force throughout this repair: the vocabulary is a property of the
-- schema, and a row can never legitimise a value the schema did not declare.
-- It could not anyway -- a value the CHECK refused could not have been
-- inserted -- but leaning on that coincidence is precisely the habit that let
-- the destructive rebuild inside `fn_widen_audit_log_actions()` go unnoticed
-- across three migrations.
--
-- `fn_widen_audit_log_actions()` (defined identically in 041, 042 and 049)
-- rebuilds from its own `canon` UNION the installed constraint, so this
-- widening survives every later run of any of them.
DO $$
DECLARE v_def text; v_literal text; v_permitted text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conname = 'audit_log_action_check' AND conrelid = 'audit.audit_log'::regclass;

  -- No constraint yet (fresh database): 039 creates it, and section C will not
  -- have repaired anything for it to record.
  IF v_def IS NULL THEN RETURN; END IF;
  IF position('''repair''' in v_def) > 0 THEN RETURN; END IF;

  SELECT COALESCE(array_agg(DISTINCT m[1] ORDER BY m[1]), ARRAY[]::text[])
    INTO v_permitted
    FROM regexp_matches(v_def, $q$'([^']+)'$q$, 'g') AS m;

  -- A definition we cannot read is a definition we must not replace.
  IF array_length(v_permitted, 1) IS NULL THEN
    RAISE EXCEPTION
      'migration 038b: could not read the permitted action list out of '
      'audit_log_action_check, so replacing it could NARROW the vocabulary. '
      'Refusing to run. Installed definition: %', v_def;
  END IF;

  SELECT string_agg(quote_literal(x), ',') INTO v_literal
    FROM (SELECT DISTINCT x FROM unnest(v_permitted || ARRAY['repair']) AS t(x)) s;

  EXECUTE 'ALTER TABLE audit.audit_log DROP CONSTRAINT audit_log_action_check';
  EXECUTE 'ALTER TABLE audit.audit_log ADD CONSTRAINT audit_log_action_check '
       || 'CHECK (action = ANY(ARRAY[' || v_literal || ']))';
  RAISE NOTICE 'migration 038b: audit action vocabulary widened to admit ''repair''';
END $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- C. THE REPAIR — recompute from the first break to the tail
-- ══════════════════════════════════════════════════════════════════════════════
-- A row-by-row walk, because each row's `prev` depends on the freshly computed
-- `self` of the row before it. A window function cannot express that
-- dependency; a loop can.
DO $$
DECLARE
  r record;
  v_prev    text;
  v_new_self text;
  v_repaired integer := 0;
  v_first    bigint := NULL;
  v_has_chained boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid='audit.audit_log'::regclass
                    AND tgname='trg_audit_log_immutable') THEN
    RAISE NOTICE 'migration 038b: append-only guard not created yet — nothing to repair';
    RETURN;
  END IF;

  SELECT EXISTS (SELECT 1 FROM audit.audit_log WHERE hash_chain_self IS NOT NULL)
    INTO v_has_chained;
  IF NOT v_has_chained THEN
    RAISE NOTICE 'migration 038b: no chained rows yet — nothing to repair';
    RETURN;
  END IF;

  -- Append-only is suspended ONLY for this recomputation, and re-asserted in
  -- section D. Disabling it is unavoidable to repair a hash chain — the guard
  -- exists to stop a PRIVILEGED EDITOR silently rewriting history, which is
  -- what a repair must do exactly once, under a numbered migration, with the
  -- content verified in section B and the event recorded below.
  EXECUTE 'ALTER TABLE audit.audit_log DISABLE TRIGGER trg_audit_log_immutable';

  BEGIN
    FOR r IN
      SELECT id, ts, actor_user_id, entity, entity_id, action, before, after,
             correlation_id, hash_chain_prev, hash_chain_self
        FROM audit.audit_log
       WHERE hash_chain_self IS NOT NULL
       ORDER BY id ASC
    LOOP
      IF v_prev IS NULL THEN
        v_prev := 'genesis:' || encode(digest('proc-portal-audit-genesis-2026-09-26','sha256'),'hex');
      END IF;

      v_new_self := 'sha256:' || encode(
        digest(v_prev || '|' || audit.fn_audit_row_payload(
                 r.id, r.ts, r.actor_user_id, r.entity, r.entity_id, r.action,
                 r.before, r.after, r.correlation_id), 'sha256'), 'hex');

      -- Write ONLY where something actually differs, so the trail is provably
      -- the same evidence plus a corrected link wherever it was already right.
      IF r.hash_chain_prev IS DISTINCT FROM v_prev
         OR r.hash_chain_self IS DISTINCT FROM v_new_self THEN
        v_first := COALESCE(v_first, r.id);
        v_repaired := v_repaired + 1;
        UPDATE audit.audit_log
           SET hash_chain_prev = v_prev,
               hash_chain_self = v_new_self
         WHERE id = r.id;
      END IF;

      v_prev := v_new_self;
    END LOOP;

    EXECUTE 'ALTER TABLE audit.audit_log ENABLE TRIGGER trg_audit_log_immutable';

    IF v_repaired > 0 THEN
      RAISE NOTICE 'migration 038b: re-linked % row(s), first at id %', v_repaired, v_first;
    ELSE
      RAISE NOTICE 'migration 038b: chain already linear — no rows re-linked';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Never leave the append-only guard switched off because of a failure.
    EXECUTE 'ALTER TABLE audit.audit_log ENABLE TRIGGER trg_audit_log_immutable';
    RAISE;
  END;

  -- Record what happened, in the trail itself. Appended AFTER the repair, so it
  -- is sealed by the now race-free trigger and is part of the chain it describes.
  IF v_repaired > 0 THEN
    INSERT INTO audit.audit_log (actor_user_id, entity, entity_id, action, reason)
    VALUES (NULL, 'audit.audit_log', 'chain', 'repair',
      format('migration 038b: re-linked %s audit row(s) from the first fork onward '
             || '(id %s) after proving every row''s content hash re-derives from its own '
             || 'columns. Cause: an unsynchronised read-modify-write in '
             || 'fn_audit_log_seal forked the chain under concurrent inserts; the seal '
             || 'is now serialised with pg_advisory_xact_lock. The append-only guard was '
             || 'disabled only for the recomputation and is re-enabled.', v_repaired, v_first));
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- D. POST-FLIGHT — prove the chain is whole and the guard is back
-- ══════════════════════════════════════════════════════════════════════════════
-- The guard is checked BY USING IT, not by reading `pg_trigger`.
--
-- A catalog read for `tgenabled` inside this transaction cannot observe the
-- ALTER that this same transaction performed — the catalog snapshot predates
-- it — so a catalog-based assertion here reports a failure that did not happen,
-- which is the worst possible thing for a verification step to do. Attempting
-- the operation the guard exists to refuse is both immune to that and a
-- stronger test: it proves the guard FIRES, not merely that it is marked on.
DO $$
DECLARE v_blocked boolean := false; v_rows integer := 0; v_bad bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM audit.audit_log LIMIT 1) THEN
    BEGIN
      UPDATE audit.audit_log SET reason = reason
       WHERE id = (SELECT min(id) FROM audit.audit_log);
      GET DIAGNOSTICS v_rows = ROW_COUNT;
    EXCEPTION WHEN OTHERS THEN
      v_blocked := true;
    END;

    IF NOT v_blocked THEN
      RAISE EXCEPTION
        'migration 038b: the append-only guard did NOT refuse an UPDATE of an audit '
        'row (% row(s) affected) — it is not enforcing', v_rows;
    END IF;
    RAISE NOTICE 'migration 038b: append-only guard confirmed enforcing';
  END IF;

  -- On a FRESH database no rows are chained yet and 039 has not yet created the
  -- verifier, so both guards below are skipped. On an existing database the
  -- chain must verify end to end by the time this returns.
  IF to_regprocedure('audit.fn_verify_audit_chain()') IS NOT NULL
     AND EXISTS (SELECT 1 FROM audit.audit_log WHERE hash_chain_self IS NOT NULL) THEN
    PERFORM set_config('TimeZone', 'UTC', true);
    SELECT first_bad_id INTO v_bad FROM audit.fn_verify_audit_chain();
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'migration 038b: chain still broken at row %', v_bad;
    END IF;
    RAISE NOTICE 'migration 038b: audit chain verified end to end';
  END IF;
END $$;

COMMIT;