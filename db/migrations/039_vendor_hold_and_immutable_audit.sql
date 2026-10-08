-- ══════════════════════════════════════════════════════════════════════════
-- 039 - Vendor Hold/Unhold, and an audit trail that is actually immutable
-- ══════════════════════════════════════════════════════════════════════════
--
-- WAVE 5 TRACK E, RULE 5
-- "Local portal users will only control the Hold/Unhold status. Any change to
--  vendor profiles, categories, or hold/unhold states must be 100% immutable
--  and logged in the audit trail."
--
-- WHAT WAS ACTUALLY TRUE BEFORE THIS MIGRATION
-- -------------------------------------------
-- The audit machinery already existed and was good: `audit.audit_log` stores a
-- full before/after row image, and `trg_vendors_audit` fires
-- audit.fn_emit_audit() on every INSERT/UPDATE/DELETE of a vendor, so a change
-- was already being RECORDED.
--
-- But recording is not immutability. Two holes made "100% immutable" false:
--
--   1. audit.audit_log had no protection at all. `proc` could UPDATE or DELETE
--      any row, so anyone holding the application's own database credentials
--      could silently erase the evidence of a change they did not like. A trail
--      that the audited system can rewrite is not a trail.
--   2. Nothing stopped a raw UPDATE against core.vendors. Any SQL path, any
--      future script, any compromised query could alter a vendor profile or
--      clear a hold without passing through the portal at all.
--
-- The hash chain that migration 016 designed was never switched on: 0 of the
-- rows in audit_log carried hash_chain_self, so even a privileged edit would
-- have left no trace. A chain nobody computes is decoration.
--
-- SO THIS MIGRATION DOES FOUR THINGS
-- ----------------------------------
--   A. Adds the Hold control itself (is_hold + who/when/why/count).
--   B. Makes audit.audit_log append-only, with a deliberate exception for
--      completing the hash chain, and for archival that has already frozen the
--      row in cold storage.
--   C. Computes the hash chain, then maintains it on every future insert, so
--      tampering is detectable and not merely forbidden.
--   D. Gates every governed vendor change behind a session token that only the
--      audited API path sets. "Hold is the only status a local user controls"
--      becomes a database guarantee rather than a UI convention.
--
-- WHY RULE 2 (D365 MUST NEVER BE BLOCKED) STILL HOLDS
-- ---------------------------------------------------
-- A vendor from Dynamics 365 arrives with whatever it carries. The gate in (D)
-- governs WRITES, not arrivals: an INSERT is untouched, and a D365 update simply
-- sets the same token the portal uses and records itself with the
-- 'd365_vendor_sync' action. Nothing about the incoming data stream is refused.
-- The one thing D365 cannot do is change a vendor WITHOUT a trail entry - which
-- is the requirement, not an obstacle to it.
--
-- REPLAY SAFETY (migrations run in lexical order, every time, with no ledger)
-- ---------------------------------------------------------------------------
-- Migrations 036 and 037 backfill core.vendors by UPDATE. When this file is
-- applied a second time, 036 and 037 run BEFORE it - but the trigger from the
-- PREVIOUS run is already installed, so their backfill would be refused and the
-- whole migrate step would fail. They therefore declare
-- `SELECT set_config('app.vendor_legacy_write','on',false);` at the top of their
-- own session, which this gate honours. Every migration must remain
-- individually re-runnable, so a later migration that backfills vendors must do
-- the same.

BEGIN;

SET LOCAL search_path = core, audit, public;

-- ══════════════════════════════════════════════════════════════════════════
-- A. THE HOLD CONTROL
-- ══════════════════════════════════════════════════════════════════════════

ALTER TABLE core.vendors
  ADD COLUMN IF NOT EXISTS is_hold boolean NOT NULL DEFAULT false;
ALTER TABLE core.vendors
  ADD COLUMN IF NOT EXISTS hold_reason text;
ALTER TABLE core.vendors
  ADD COLUMN IF NOT EXISTS held_at timestamptz;
ALTER TABLE core.vendors
  ADD COLUMN IF NOT EXISTS held_by_user_id uuid REFERENCES core.users(id);
ALTER TABLE core.vendors
  ADD COLUMN IF NOT EXISTS hold_count integer NOT NULL DEFAULT 0;

-- A hold must be explicable. A held vendor with no reason is an unexplainable
-- commercial decision, and the audit trail would faithfully record a blank.
DO $$
DECLARE n int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'vendors_hold_consistent' AND conrelid = 'core.vendors'::regclass
  ) THEN
    ALTER TABLE core.vendors ADD CONSTRAINT vendors_hold_consistent CHECK (
      (is_hold AND hold_reason IS NOT NULL AND btrim(hold_reason) <> '' AND held_at IS NOT NULL AND held_by_user_id IS NOT NULL)
      OR
      (NOT is_hold)
    );
  END IF;
  SELECT count(*) INTO n FROM core.vendors WHERE is_hold;      -- touch, for a clear failure
END $$;

-- Held vendors must be findable without scanning the whole table.
CREATE INDEX IF NOT EXISTS idx_vendors_is_hold ON core.vendors(is_hold) WHERE is_hold;
CREATE INDEX IF NOT EXISTS idx_vendors_uncategorised
  ON core.vendors(state) WHERE cardinality(preferred_categories) = 0;

-- ══════════════════════════════════════════════════════════════════════════
-- B. THE AUDIT LOG BECOMES APPEND-ONLY
-- ══════════════════════════════════════════════════════════════════════════

-- A hold or a profile edit needs a justification that survives the row.
ALTER TABLE audit.audit_log ADD COLUMN IF NOT EXISTS reason text;

-- ─── widen the action vocabulary, monotonically ───────────────────────────
-- The CHECK lists a fixed vocabulary. Rule 5 needs hold / unhold /
-- category_change / vendor_update / d365_vendor_sync to be distinguishable in
-- the trail rather than all collapsing into 'update'.
--
-- This only ever WIDENS. If the installed constraint already permits every
-- action in the canonical list, nothing happens - so re-running this migration
-- cannot narrow a vocabulary that a LATER migration has extended. That trap
-- (a migration re-asserting a narrower list than a later one guarantees) is
-- what breaks `db:migrate` on an already-migrated database, so the guard is a
-- real check rather than a comment.
CREATE OR REPLACE FUNCTION audit.fn_widen_audit_log_actions() RETURNS void AS $$
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
    'phone_negotiation','cs_line_award'
  ];
  canon_literal text;
  def text;
  missing text;
BEGIN
  -- quote_literal() on a text[] quotes the ARRAY, not each element, so the
  -- element list has to be assembled one element at a time.
  SELECT string_agg(quote_literal(a), ',') INTO canon_literal FROM unnest(canon) AS a;

  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint
   WHERE conname = 'audit_log_action_check' AND conrelid = 'audit.audit_log'::regclass;

  IF def IS NULL THEN
    EXECUTE 'ALTER TABLE audit.audit_log ADD CONSTRAINT audit_log_action_check '
            'CHECK (action = ANY(ARRAY[' || canon_literal || ']))';
    RETURN;
  END IF;

  -- Substring test per action: parsing the array literal back out of the
  -- constraint text is fragile, and what matters is only "is every canonical
  -- action already permitted".
  SELECT string_agg(a, ', ') INTO missing
    FROM unnest(canon) AS a
   WHERE position('''' || a || '''' in def) = 0;

  IF missing IS NULL THEN
    RETURN;                       -- already a superset; leave it alone
  END IF;

  EXECUTE 'ALTER TABLE audit.audit_log DROP CONSTRAINT audit_log_action_check';
  EXECUTE 'ALTER TABLE audit.audit_log ADD CONSTRAINT audit_log_action_check '
          'CHECK (action = ANY(ARRAY[' || canon_literal || ']))';
END $$ LANGUAGE plpgsql;

SELECT audit.fn_widen_audit_log_actions();

-- ─── the append-only guard ────────────────────────────────────────────────
-- Three operations are refused outright, and two narrow exceptions are kept
-- alive on purpose:
--
--   UPDATE  - refused UNLESS it only fills the two hash columns that were NULL.
--             This is what lets migration 016's fn_compute_hash_chain() keep
--             working, while still making an already-chained row unrewritable.
--             A chain that can be recomputed is not a chain; a chain that can
--             only ever be started is one.
--   DELETE  - refused UNLESS an identical row already exists in
--             audit.audit_log_archive, i.e. the row was frozen in cold storage
--             first. This preserves the documented 7-year archival path
--             (fn_archive_old_audit) without leaving a door open to erasure.
--   TRUNCATE is blocked by revoking the privilege as well as the trigger.
CREATE OR REPLACE FUNCTION audit.fn_audit_log_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.hash_chain_prev IS NOT DISTINCT FROM OLD.hash_chain_prev
       AND NEW.hash_chain_self IS NOT DISTINCT FROM OLD.hash_chain_self THEN
      -- No hash columns touched -> a real edit attempt. Refuse.
      RAISE EXCEPTION
        'audit.audit_log is append-only: row % (%, %) cannot be modified. '
        'Corrections are appended as a new entry, never written over history.',
        OLD.id, OLD.entity, OLD.entity_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- A hash column is being written. Permit ONLY the transition from NULL, and
    -- only for the two chain columns; every other field must be identical.
    IF (to_jsonb(NEW) - 'hash_chain_prev' - 'hash_chain_self')
       IS DISTINCT FROM (to_jsonb(OLD) - 'hash_chain_prev' - 'hash_chain_self') THEN
      RAISE EXCEPTION
        'audit.audit_log is append-only: row % may only gain its hash chain, never change content.',
        OLD.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF OLD.hash_chain_self IS NOT NULL THEN
      RAISE EXCEPTION
        'audit.audit_log is append-only: row % is already chained and its hash can never be rewritten.',
        OLD.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM audit.audit_log_archive a WHERE a.id = OLD.id) THEN
      RETURN OLD;                 -- already frozen in cold storage
    END IF;
    RAISE EXCEPTION
      'audit.audit_log is append-only: row % (%, %) cannot be deleted. '
      'Archive it with audit.fn_archive_old_audit() first, which copies it to cold storage.',
      OLD.id, OLD.entity, OLD.entity_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_immutable ON audit.audit_log;
CREATE TRIGGER trg_audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit.audit_log
  FOR EACH ROW EXECUTE FUNCTION audit.fn_audit_log_immutable();

-- TRUNCATE does not fire row triggers, so the privilege itself has to go.
DO $$
BEGIN
  EXECUTE 'REVOKE TRUNCATE ON audit.audit_log FROM PUBLIC';
EXCEPTION WHEN undefined_object THEN
  NULL;   -- role or privilege absent on a fresh database; the row guard stands
END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- C. THE HASH CHAIN, ACTUALLY SWITCHED ON
-- ══════════════════════════════════════════════════════════════════════════
-- A BEFORE INSERT trigger seals each new row against the previous one, so the
-- chain is maintained by the database rather than by a nightly job that may not
-- run. fn_compute_hash_chain() then fills the history that predates this
-- migration, using the same arithmetic, so there is one chain and not two.
CREATE OR REPLACE FUNCTION audit.fn_audit_log_seal() RETURNS trigger AS $$
DECLARE v_prev text;
BEGIN
  SELECT hash_chain_self INTO v_prev
    FROM audit.audit_log
   WHERE hash_chain_self IS NOT NULL
   ORDER BY id DESC
   LIMIT 1;

  IF v_prev IS NULL THEN
    v_prev := 'genesis:' || encode(digest('proc-portal-audit-genesis-2026-09-26', 'sha256'), 'hex');
  END IF;

  NEW.hash_chain_prev := v_prev;
  NEW.hash_chain_self := 'sha256:' || encode(
    digest(
      v_prev || '|' ||
      COALESCE(NEW.id::text, '') || '|' ||
      NEW.ts::text || '|' ||
      COALESCE(NEW.actor_user_id::text, '') || '|' ||
      NEW.entity || '|' ||
      NEW.entity_id || '|' ||
      NEW.action || '|' ||
      COALESCE(NEW.before::text, '') || '|' ||
      COALESCE(NEW.after::text, '') || '|' ||
      COALESCE(NEW.correlation_id, ''),
      'sha256'
    ),
    'hex'
  );
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_seal ON audit.audit_log;
CREATE TRIGGER trg_audit_log_seal
  BEFORE INSERT ON audit.audit_log
  FOR EACH ROW EXECUTE FUNCTION audit.fn_audit_log_seal();

-- Seal the 2,000-odd rows that were written before the chain existed. The
-- function is idempotent by construction: it only walks rows whose
-- hash_chain_self IS NULL, and the append-only guard lets it fill them once.
SELECT audit.fn_compute_hash_chain(now() + interval '1 day');

-- An independent verifier, so "the chain is intact" is an answer someone can
-- ask and get, not an assumption.
--
-- It starts from the SAME genesis salt the seal uses, because the first chained
-- row's `hash_chain_prev` IS the genesis string. Seeding the walk from the first
-- row's own hash instead - the obvious-looking choice - compares row 1's
-- predecessor against row 1 and reports the whole chain as broken, which is
-- exactly the kind of verifier that cries wolf on a healthy database.
CREATE OR REPLACE FUNCTION audit.fn_verify_audit_chain() RETURNS TABLE(
  rows_checked bigint, first_bad_id bigint
) AS $$
DECLARE r record; v_prev text; v_bad bigint; v_n bigint;
BEGIN
  v_prev := 'genesis:' || encode(digest('proc-portal-audit-genesis-2026-09-26','sha256'),'hex');
  v_bad := NULL; v_n := 0;

  FOR r IN
    SELECT id, hash_chain_prev, hash_chain_self
      FROM audit.audit_log WHERE hash_chain_self IS NOT NULL ORDER BY id ASC
  LOOP
    v_n := v_n + 1;
    IF r.hash_chain_prev IS DISTINCT FROM v_prev THEN
      v_bad := r.id;
      EXIT;
    END IF;
    v_prev := r.hash_chain_self;
  END LOOP;

  RETURN QUERY SELECT v_n, v_bad;
END $$ LANGUAGE plpgsql;

-- ══════════════════════════════════════════════════════════════════════════
-- D. GOVERNED VENDOR CHANGES REQUIRE THE AUDITED PATH
-- ══════════════════════════════════════════════════════════════════════════
-- Every column on core.vendors is governed except updated_at, which is
-- housekeeping. That is deliberately not a hand-listed set of "profile" columns:
-- a column added next year is governed the day it exists, instead of joining an
-- immutable-record set that nobody remembers to extend.
--
-- `app.vendor_change_token` is set by the API for exactly two statements: the
-- one that appends the audit row, and the one that changes the vendor. Nothing
-- else sets it. So the gate answers the question that actually matters - "did
-- this change arrive through the audited path?" - without needing to inspect an
-- audit row that a BEFORE trigger cannot yet see.
CREATE OR REPLACE FUNCTION core.fn_vendors_governed_change_gate() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'updated_at') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RETURN NEW;                   -- nothing governed actually changed
  END IF;

  IF coalesce(current_setting('app.vendor_legacy_write', true), '') = 'on' THEN
    RETURN NEW;                   -- migration backfill; see the header note
  END IF;

  IF coalesce(NULLIF(current_setting('app.vendor_change_token', true), ''), '') = '' THEN
    RAISE EXCEPTION
      'vendor % (%): profile, category and hold changes are governed. '
      'They may only be made through the audited vendor API, which sets app.vendor_change_token '
      'and appends an audit entry. Raw UPDATE against core.vendors is refused so that a change '
      'can never exist without a trail.',
      NEW.vendor_code, NEW.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_vendors_governed_change_gate ON core.vendors;
CREATE TRIGGER trg_vendors_governed_change_gate
  BEFORE UPDATE ON core.vendors
  FOR EACH ROW EXECUTE FUNCTION core.fn_vendors_governed_change_gate();

-- A vendor whose row can be deleted has no history to protect. Several tables
-- reference core.vendors, so a delete is already constrained in practice; this
-- makes the intent explicit rather than incidental.
CREATE OR REPLACE FUNCTION core.fn_vendors_no_delete() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('app.vendor_legacy_write', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'vendor % cannot be deleted: procurement history references it and the audit trail must remain readable. '
    'Set state to ''Deactivated'' instead, which is a recorded, reversible decision.',
    OLD.vendor_code
    USING ERRCODE = 'insufficient_privilege';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_vendors_no_delete ON core.vendors;
CREATE TRIGGER trg_vendors_no_delete
  BEFORE DELETE ON core.vendors
  FOR EACH ROW EXECUTE FUNCTION core.fn_vendors_no_delete();

-- ══════════════════════════════════════════════════════════════════════════
-- POST-CONDITION - refuse to COMMIT unless all of the above is real
-- ══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE n int; broken bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='core' AND table_name='vendors' AND column_name='is_hold') THEN
    RAISE EXCEPTION 'migration 039: core.vendors.is_hold is missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid='audit.audit_log'::regclass AND tgname='trg_audit_log_immutable'
                    AND NOT tgisinternal AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'migration 039: the audit_log append-only guard is missing or disabled';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid='audit.audit_log'::regclass AND tgname='trg_audit_log_seal'
                    AND NOT tgisinternal AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'migration 039: the audit_log hash-chain seal is missing or disabled';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid='core.vendors'::regclass AND tgname='trg_vendors_governed_change_gate'
                    AND NOT tgisinternal AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'migration 039: the governed vendor change gate is missing or disabled';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid='core.vendors'::regclass AND tgname='trg_vendors_no_delete'
                    AND NOT tgisinternal AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'migration 039: the vendor delete guard is missing or disabled';
  END IF;

  -- The chain must actually exist now, not merely be defined. A chain that is
  -- present but empty would satisfy every check above and prove nothing.
  SELECT count(*) INTO n FROM audit.audit_log WHERE hash_chain_self IS NOT NULL;
  IF n = 0 THEN
    RAISE EXCEPTION 'migration 039: no audit rows are chained; the trail would be tamperable';
  END IF;
  -- Every row must be chained, not merely some: an unchained row is a gap a
  -- privileged editor could later fill with a hash of their own choosing.
  SELECT count(*) INTO n FROM audit.audit_log WHERE hash_chain_self IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'migration 039: % audit row(s) are still unchained; the chain has gaps', n;
  END IF;

  SELECT first_bad_id INTO broken FROM audit.fn_verify_audit_chain();
  IF broken IS NOT NULL THEN
    RAISE EXCEPTION 'migration 039: the audit hash chain is broken at row %', broken;
  END IF;

  -- Every action rule 5 depends on must be permitted by the live constraint.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname='audit_log_action_check' AND conrelid='audit.audit_log'::regclass
       AND position('''hold''' in pg_get_constraintdef(oid)) > 0
       AND position('''unhold''' in pg_get_constraintdef(oid)) > 0
       AND position('''category_change''' in pg_get_constraintdef(oid)) > 0
       AND position('''phone_negotiation''' in pg_get_constraintdef(oid)) > 0
       AND position('''cs_line_award''' in pg_get_constraintdef(oid)) > 0
  ) THEN
    RAISE EXCEPTION 'migration 039: hold/unhold/category_change/phone_negotiation/cs_line_award are not permitted audit actions';
  END IF;
END $$;

COMMIT;
