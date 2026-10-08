-- ══════════════════════════════════════════════════════════════════════════
-- 040 - Dispatch, line-item splitting, split awards, and the vendor outbox
-- ══════════════════════════════════════════════════════════════════════════
--
-- WAVE 5 TRACK F
--   1. RFQ generation, smart filtering and automated dispatch
--   2. Secure tokenized vendor portal and Excel template ingestion
--   3. Comparative statement, phone negotiation and bid evaluation
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- ---------------------------------------------
-- It does not invent warehouse stock. The requirement is to exclude
-- "warehouse stock-fulfilled items" from an RFQ, and this schema has no stock
-- ledger at all: core.items carries no quantity column, and the only warehouse
-- object is reporting.v_pr_warehouse_inbox, which is a list of PRs NEEDING a
-- check, not a record of what is on the shelf. So fulfilment is modelled as an
-- explicit per-line DISCIMINATOR (PURCHASE | STORE_STOCK) that the RFQ builder
-- filters on, and every existing line is PURCHASE - which is not a guess, it is
-- the truth: nothing in this database is known to be stock-fulfilled. When a
-- stock ledger arrives, the column is already there and already filtered; only
-- the lines that a real ledger marks as STORE_STOCK will drop out.
--
-- It also does not fake a mail server. There is no SMTP configuration in this
-- environment, so the outbox is the real, queryable, retryable queue and the
-- transport is pluggable behind it. Nothing is "sent" and then quietly dropped;
-- a message is either delivered by a configured transport or it sits in the
-- outbox with its failure reason.
--
-- REPLAY SAFETY
-- -------------
-- Migrations run in lexical order with no ledger, so every statement here is
-- idempotent and the post-condition re-asserts the WIDEST state any later
-- migration guarantees - never a narrower one.

BEGIN;

SET LOCAL search_path = core, proc, audit, public;

-- ══════════════════════════════════════════════════════════════════════════
-- A. FULFILMENT DISCIMINATOR — the hook the stock filter will act on
-- ══════════════════════════════════════════════════════════════════════════
ALTER TABLE proc.pr_lines
  ADD COLUMN IF NOT EXISTS fulfilment_source text NOT NULL DEFAULT 'PURCHASE';
ALTER TABLE proc.pr_lines
  ADD COLUMN IF NOT EXISTS store_fulfilled_qty numeric(18,3);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pr_lines_fulfilment_source' AND conrelid = 'proc.pr_lines'::regclass) THEN
    ALTER TABLE proc.pr_lines ADD CONSTRAINT pr_lines_fulfilment_source
      CHECK (fulfilment_source IN ('PURCHASE','STORE_STOCK'));
  END IF;
  -- A store-fulfilled line MUST say how much came from stock. Without the
  -- quantity the pending balance is unknowable, and an RFQ would either
  -- over-order or silently drop the remainder.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pr_lines_store_qty_consistent' AND conrelid = 'proc.pr_lines'::regclass) THEN
    ALTER TABLE proc.pr_lines ADD CONSTRAINT pr_lines_store_qty_consistent CHECK (
      (fulfilment_source = 'PURCHASE' AND store_fulfilled_qty IS NULL)
      OR
      (fulfilment_source = 'STORE_STOCK' AND store_fulfilled_qty IS NOT NULL
         AND store_fulfilled_qty >= 0 AND store_fulfilled_qty <= quantity)
    );
  END IF;
END $$;

-- The index the RFQ builder's "pending purchase lines only" predicate rides on.
CREATE INDEX IF NOT EXISTS idx_pr_lines_rfqable
  ON proc.pr_lines(pr_id) WHERE NOT coalesce(held, false) AND fulfilment_source = 'PURCHASE';

-- WHY EXCLUSIONS ARE RECORDED
-- A vendor must never receive a short pack and be left to guess which line
-- disappeared. Every line the smart filter drops is written here with the reason,
-- so the RFQ screen can say "3 lines excluded (2 held, 1 from stock)" and the
-- vendor-facing pack can be shown as a deliberate subset rather than an omission.
CREATE TABLE IF NOT EXISTS proc.rfq_line_exclusions (
  rfq_id     uuid NOT NULL REFERENCES proc.rfq(id) ON DELETE CASCADE,
  pr_line_id uuid NOT NULL REFERENCES proc.pr_lines(id) ON DELETE CASCADE,
  line_no    integer NOT NULL,
  reason     text NOT NULL,
  quantity   numeric(18,3),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rfq_id, pr_line_id)
);
CREATE INDEX IF NOT EXISTS idx_rfq_line_exclusions_rfq
  ON proc.rfq_line_exclusions(rfq_id, line_no);

-- ══════════════════════════════════════════════════════════════════════════
-- B. TIME-BOUND DISPATCH TOKENS
-- ══════════════════════════════════════════════════════════════════════════
-- An invitation token that never expires is a permanent credential to one
-- vendor's RFQ sitting in a mailbox. The TTL is CONFIGURATION, not a constant:
-- core.fn_vendor_token_ttl_hours() raises if nobody configured it, exactly as
-- the attachment ceilings do, so a missing setting is visible rather than
-- silently becoming "never expires".
ALTER TABLE proc.rfq_invitations
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE proc.rfq_invitations
  ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;
ALTER TABLE proc.rfq_invitations
  ADD COLUMN IF NOT EXISTS dispatch_channel text;
ALTER TABLE proc.rfq_invitations
  ADD COLUMN IF NOT EXISTS outbox_id bigint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'rfq_invitations_channel' AND conrelid = 'proc.rfq_invitations'::regclass) THEN
    ALTER TABLE proc.rfq_invitations ADD CONSTRAINT rfq_invitations_channel
      CHECK (dispatch_channel IS NULL OR dispatch_channel IN ('email','manual','portal'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_rfq_invitations_live
  ON proc.rfq_invitations(rfq_id) WHERE NOT submitted AND NOT declined;
CREATE INDEX IF NOT EXISTS idx_rfq_invitations_outbox ON proc.rfq_invitations(outbox_id);

-- Backfill BEFORE the NOT NULL constraint, not after. A CHECK is validated
-- against existing rows the instant it is added, so declaring it first fails
-- on exactly the rows the backfill exists to repair — and the error names the
-- constraint, not the ordering mistake.
--
-- proc.rfq_invitations has no created_at; the invitation time is invited_at.
-- 72 hours matches the vendorPortalTokenHours seed below — the column is
-- honestly populated, not left null and not silently "never expires".
UPDATE proc.rfq_invitations
   SET expires_at = COALESCE(expires_at, invited_at + interval '72 hours');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'rfq_invitations_never_expires' AND conrelid = 'proc.rfq_invitations'::regclass) THEN
    -- A token must be issued with an expiry. A token whose expiry has PASSED is
    -- a different thing from one that was never time-bounded; both are refused
    -- at read time, and this constraint only forbids the never-set case.
    ALTER TABLE proc.rfq_invitations ADD CONSTRAINT rfq_invitations_never_expires
      CHECK (expires_at IS NOT NULL);
  END IF;
  -- An expiry at or before the invitation is not a time bound, it is a dead link.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'rfq_invitations_expiry_after_invite' AND conrelid = 'proc.rfq_invitations'::regclass) THEN
    ALTER TABLE proc.rfq_invitations ADD CONSTRAINT rfq_invitations_expiry_after_invite
      CHECK (expires_at > invited_at);
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- C. THE EMAIL OUTBOX
-- ══════════════════════════════════════════════════════════════════════════
-- A dispatch that reports success without a transport is worse than one that
-- fails loudly, so the outbox IS the queue of record. `state` moves
-- pending -> sent | failed, and a failed row keeps its error for the operator.
CREATE TABLE IF NOT EXISTS core.email_outbox (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  to_vendor_id      uuid REFERENCES core.vendors(id),
  to_email          text NOT NULL,
  subject           text NOT NULL,
  body_html         text NOT NULL,
  body_text         text NOT NULL,
  template          text NOT NULL,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  state             text NOT NULL DEFAULT 'pending',
  attempts          integer NOT NULL DEFAULT 0,
  last_error        text,
  sent_at           timestamptz,
  rfq_id            uuid REFERENCES proc.rfq(id) ON DELETE SET NULL,
  invitation_id     uuid REFERENCES proc.rfq_invitations(id) ON DELETE SET NULL,
  created_by_user_id uuid REFERENCES core.users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='email_outbox_state' AND conrelid='core.email_outbox'::regclass) THEN
    ALTER TABLE core.email_outbox ADD CONSTRAINT email_outbox_state
      CHECK (state IN ('pending','sending','sent','failed'));
  END IF;
  -- A 'sent' row with no timestamp, or a timestamp with no sent state, is a lie
  -- about delivery. Both halves are asserted together.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='email_outbox_sent_shape' AND conrelid='core.email_outbox'::regclass) THEN
    ALTER TABLE core.email_outbox ADD CONSTRAINT email_outbox_sent_shape
      CHECK ((state = 'sent' AND sent_at IS NOT NULL) OR (state <> 'sent'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_email_outbox_pending
  ON core.email_outbox(created_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_email_outbox_vendor ON core.email_outbox(to_vendor_id, created_at DESC);

-- The outbox is an append-and-mark record, so it is audited like everything
-- else rather than being a silent side table.
DROP TRIGGER IF EXISTS trg_email_outbox_audit ON core.email_outbox;
CREATE TRIGGER trg_email_outbox_audit
  AFTER INSERT OR UPDATE OR DELETE ON core.email_outbox
  FOR EACH ROW EXECUTE FUNCTION audit.fn_emit_audit();

-- ══════════════════════════════════════════════════════════════════════════
-- D. LINE-ITEM SPLIT AWARDS
-- ══════════════════════════════════════════════════════════════════════════
-- proc.cs_lines ranks a VENDOR against the whole pack. It has no line dimension
-- at all, so a CS today cannot say "this laptop line came from vendor A and the
-- chairs from vendor B" - which is the normal commercial outcome once an RFQ has
-- more than one line.
--
-- Rather than reshape cs_lines' primary key (cs_id, vendor_id), split awards get
-- their own table: at most ONE winner per line. That is the real business rule -
-- you cannot award the same line to two vendors - and expressing it as
-- UNIQUE(cs_id, rfq_line_no) makes the database enforce it rather than a UI
-- dropdown.
CREATE TABLE IF NOT EXISTS proc.cs_line_awards (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cs_id           uuid NOT NULL REFERENCES proc.comparative_statements(id) ON DELETE CASCADE,
  rfq_line_no     integer NOT NULL,
  vendor_id       uuid NOT NULL REFERENCES core.vendors(id),
  awarded_qty     numeric(18,3) NOT NULL,
  award_round     integer NOT NULL DEFAULT 1,
  justification   text NOT NULL,
  awarded_by_user_id uuid NOT NULL REFERENCES core.users(id),
  awarded_at      timestamptz NOT NULL DEFAULT now(),
  supersedes_award_id uuid REFERENCES proc.cs_line_awards(id),
  superseded_at   timestamptz,
  supersede_reason text
);

-- WHY A SURROGATE KEY AND NOT PRIMARY KEY (cs_id, rfq_line_no)
-- -------------------------------------------------------------
-- The obvious key is (cs_id, rfq_line_no): one winner per line. But that key
-- makes changing a winner IMPOSSIBLE. Re-awarding a line has to keep the old
-- decision ("vendor A won line 3, and here is why") and add the new one, and a
-- single-column-per-line key cannot hold two rows for the same line at all.
--
-- So the real rule is not "one row per line" but "at most one LIVE row per
-- line" - which is what the EXCLUDE below states. It is DEFERRABLE INITIALLY
-- DEFERRED so insert-new-then-retire-old is legal inside one transaction; a
-- plain UNIQUE would be immediate and would refuse the new award while the old
-- one is still live. This is the same trap the attachment registry hit, and the
-- same fix.
CREATE INDEX IF NOT EXISTS idx_cs_line_awards_line
  ON proc.cs_line_awards(cs_id, rfq_line_no);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cs_line_awards_round
  ON proc.cs_line_awards(cs_id, rfq_line_no, award_round);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname='cs_line_awards_one_live_per_line' AND conrelid='proc.cs_line_awards'::regclass) THEN
    EXECUTE 'ALTER TABLE proc.cs_line_awards ADD CONSTRAINT cs_line_awards_one_live_per_line '
            'EXCLUDE USING gist (cs_id WITH =, rfq_line_no WITH =) '
            'WHERE (superseded_at IS NULL) DEFERRABLE INITIALLY DEFERRED';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='cs_line_awards_shape' AND conrelid='proc.cs_line_awards'::regclass) THEN
    -- A changing an award is a supersede, never an in-place edit: the old row
    -- keeps who decided what, and the new one says why it changed. This is the
    -- same "refuse the operation, not the row" rule the audit log uses.
    ALTER TABLE proc.cs_line_awards ADD CONSTRAINT cs_line_awards_shape CHECK (
      (superseded_at IS NULL AND supersede_reason IS NULL)
      OR
      (superseded_at IS NOT NULL AND supersede_reason IS NOT NULL AND btrim(supersede_reason) <> '')
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='cs_line_awards_qty' AND conrelid='proc.cs_line_awards'::regclass) THEN
    ALTER TABLE proc.cs_line_awards ADD CONSTRAINT cs_line_awards_qty CHECK (awarded_qty > 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='cs_line_awards_justification' AND conrelid='proc.cs_line_awards'::regclass) THEN
    ALTER TABLE proc.cs_line_awards ADD CONSTRAINT cs_line_awards_justification
      CHECK (btrim(justification) <> '');
  END IF;
END $$;

-- The award must belong to a line that is actually on the pack. Without this the
-- primary key happily accepts line 999. Resolved by walking CS -> PR -> RFQ ->
-- line, because the CS table has no rfq_id until the ALTER at the end of this
-- section (added so the matrix and the awards can join directly).
CREATE OR REPLACE FUNCTION proc.fn_cs_line_award_line_exists() RETURNS trigger AS $$
DECLARE
  v_rfq_line record;
BEGIN
  -- `quantity` is SELECTed because the ceiling check below reads it. A record
  -- variable only exposes the columns actually selected, so omitting it fails
  -- at runtime with "record has no field quantity" rather than at creation.
  SELECT l.rfq_id, l.line_no, l.quantity INTO v_rfq_line
    FROM proc.comparative_statements c
    JOIN proc.rfq r ON r.id = (
      SELECT i.rfq_id FROM proc.rfq_invitations i
       WHERE i.rfq_id IN (SELECT id FROM proc.rfq WHERE pr_id = c.pr_id)
       LIMIT 1)
    JOIN proc.rfq_lines l ON l.rfq_id = r.id AND l.line_no = NEW.rfq_line_no
   WHERE c.id = NEW.cs_id
   LIMIT 1;

  IF v_rfq_line IS NULL THEN
    RAISE EXCEPTION
      'line % is not on the pack for comparative statement %',
      NEW.rfq_line_no, NEW.cs_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.awarded_qty > v_rfq_line.quantity THEN
    RAISE EXCEPTION
      'cannot award % of line % — the line quantity is only %',
      NEW.awarded_qty, NEW.rfq_line_no, v_rfq_line.quantity
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cs_line_award_line ON proc.cs_line_awards;
CREATE TRIGGER trg_cs_line_award_line
  BEFORE INSERT OR UPDATE ON proc.cs_line_awards
  FOR EACH ROW EXECUTE FUNCTION proc.fn_cs_line_award_line_exists();

-- A CS must record which RFQ it evaluates, otherwise line awards and the
-- matrix have nothing to join to.
ALTER TABLE proc.comparative_statements
  ADD COLUMN IF NOT EXISTS rfq_id uuid REFERENCES proc.rfq(id) ON DELETE SET NULL;

-- ══════════════════════════════════════════════════════════════════════════
-- E. PHONE / OFFLINE NEGOTIATION
-- ══════════════════════════════════════════════════════════════════════════
-- negotiation_log already exists with (rfq, vendor, round, notes). A phone
-- negotiation is not a note though - it is a RATE that changed, and it has to
-- say whose number it used to be.
ALTER TABLE negotiation_log
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'portal';
ALTER TABLE negotiation_log
  ADD COLUMN IF NOT EXISTS justification text;
ALTER TABLE negotiation_log
  ADD COLUMN IF NOT EXISTS rate_before jsonb;
ALTER TABLE negotiation_log
  ADD COLUMN IF NOT EXISTS rate_after jsonb;
ALTER TABLE negotiation_log
  ADD COLUMN IF NOT EXISTS resulting_quotation_version integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='negotiation_log_source' AND conrelid='negotiation_log'::regclass) THEN
    ALTER TABLE negotiation_log ADD CONSTRAINT negotiation_log_source
      CHECK (source IN ('portal','phone','email','walk_in'));
  END IF;
  -- A phone-negotiated rate with no written justification is not auditable, so
  -- the source decides whether one is mandatory. Portal entries keep the old
  -- nullable behaviour, which is why this is a conditional and not NOT NULL.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='negotiation_log_justification' AND conrelid='negotiation_log'::regclass) THEN
    ALTER TABLE negotiation_log ADD CONSTRAINT negotiation_log_justification CHECK (
      source = 'portal' OR (justification IS NOT NULL AND btrim(justification) <> '')
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_negotiation_log_rfq ON negotiation_log(rfq_id, vendor_id, round DESC);

-- ══════════════════════════════════════════════════════════════════════════
-- F. CONFIGURATION — no hardcoded TTLs
-- ══════════════════════════════════════════════════════════════════════════
-- Same fail-closed shape as the attachment ceilings: a missing row raises
-- rather than defaulting, so "nobody configured the token lifetime" is visible
-- instead of silently becoming "the link never expires".
CREATE OR REPLACE FUNCTION core.fn_vendor_token_ttl_hours() RETURNS numeric AS $$
DECLARE v numeric;
BEGIN
  SELECT (value #>> '{}')::numeric INTO v
    FROM core.settings WHERE key = 'vendorPortalTokenHours';
  IF v IS NULL THEN
    RAISE EXCEPTION
      'vendorPortalTokenHours is not configured: core.settings has no row. '
      'Set VENDOR_PORTAL_TOKEN_HOURS in the environment (which seeds the row at boot) '
      'or create it. Refusing rather than issuing a link that never expires.';
  END IF;
  IF v <= 0 THEN
    RAISE EXCEPTION 'vendorPortalTokenHours is % — a lifetime must be positive', v;
  END IF;
  RETURN v;
END $$ LANGUAGE plpgsql;

INSERT INTO core.settings (key, value, value_type, label, description, group_name, is_toggle, sort_order)
VALUES ('vendorPortalTokenHours', to_jsonb(72::bigint), 'int',
        'Vendor portal link lifetime (hours)',
        'How long a dispatched RFQ link stays valid. Raising it widens the window in which a forwarded email remains usable.',
        'Workflow & approvals', false, 21)
ON CONFLICT (key) DO NOTHING;

INSERT INTO core.settings (key, value, value_type, label, description, group_name, is_toggle, sort_order)
VALUES ('emailOutboxEnabled', to_jsonb(true), 'boolean',
        'Queue dispatch emails',
        'When off, a dispatch writes no outbox message and sends nothing. Turn this off only to take the queue out of service deliberately.',
        'Workflow & approvals', true, 22)
ON CONFLICT (key) DO NOTHING;

INSERT INTO core.settings (key, value, value_type, label, description, group_name, is_toggle, sort_order)
VALUES ('rfqSplitJobIntervalSeconds', to_jsonb(300::bigint), 'int',
        'RFQ line-split sweep interval (seconds)',
        'How often the background sweep re-evaluates purchase lines for RFQ eligibility. 0 disables the sweep entirely.',
        'Workflow & approvals', false, 23)
ON CONFLICT (key) DO NOTHING;

-- ══════════════════════════════════════════════════════════════════════════
-- G. JOB RUN LEDGER — a background job you cannot see is not a job
-- ══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS core.job_runs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_name      text NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  ok            boolean,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  error         text
);
CREATE INDEX IF NOT EXISTS idx_job_runs_name ON core.job_runs(job_name, started_at DESC);

-- ══════════════════════════════════════════════════════════════════════════
-- H. VENDOR EMAIL COMPLETENESS
-- ══════════════════════════════════════════════════════════════════════════
-- A vendor with no email cannot be dispatched to, so it is a silent dead end in
-- the pool. This is a COMPUTED flag, not a stored column: core.vendors.contact_email
-- is the single source of truth and a second boolean would be free to disagree.
CREATE OR REPLACE FUNCTION core.fn_vendor_email_missing() RETURNS TABLE(
  vendor_id uuid, vendor_code text, legal_name text, state text
) AS $$
  SELECT v.id, v.vendor_code, v.legal_name, v.state
    FROM core.vendors v
   WHERE NULLIF(btrim(coalesce(v.contact_email,'')), '') IS NULL
     AND v.state NOT IN ('Blacklisted','Deactivated')
   ORDER BY v.vendor_code;
$$ LANGUAGE sql STABLE;

-- ══════════════════════════════════════════════════════════════════════════
-- POST-CONDITION
-- ══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE n int; v_fail_closed boolean := false;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='proc' AND table_name='pr_lines' AND column_name='fulfilment_source') THEN
    RAISE EXCEPTION 'migration 040: pr_lines.fulfilment_source is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='proc' AND table_name='rfq_invitations' AND column_name='expires_at') THEN
    RAISE EXCEPTION 'migration 040: rfq_invitations.expires_at is missing — dispatch links would never expire';
  END IF;
  IF to_regclass('core.email_outbox') IS NULL THEN
    RAISE EXCEPTION 'migration 040: core.email_outbox was not created';
  END IF;
  IF to_regclass('proc.cs_line_awards') IS NULL THEN
    RAISE EXCEPTION 'migration 040: proc.cs_line_awards was not created — split awards have nowhere to live';
  END IF;
  IF to_regclass('core.job_runs') IS NULL THEN
    RAISE EXCEPTION 'migration 040: core.job_runs was not created';
  END IF;
  IF to_regclass('proc.rfq_line_exclusions') IS NULL THEN
    RAISE EXCEPTION
      'migration 040: proc.rfq_line_exclusions was not created — a line dropped by the smart filter '
      'would vanish silently and the vendor would be sent a short pack with no explanation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                   WHERE proname='fn_vendor_token_ttl_hours' AND pronamespace='core'::regnamespace) THEN
    RAISE EXCEPTION 'migration 040: the token TTL function is missing';
  END IF;

  -- The TTL function must actually fail closed. A function that quietly returns
  -- a number when nothing is configured is the exact failure this migration
  -- exists to prevent, so the BEHAVIOUR is asserted, not just the function's
  -- existence.
  --
  -- The probe removes the row and calls the function inside an EXCEPTION block.
  -- plpgsql turns an exception block into a subtransaction, so the handler's
  -- catch automatically rolls the DELETE back and the seeded row survives. If the
  -- function does NOT raise, the flag stays false and the RAISE below aborts the
  -- whole migration transaction - which rolls the DELETE back as well, so the
  -- probe is safe in both directions.
  BEGIN
    BEGIN
      DELETE FROM core.settings WHERE key = 'vendorPortalTokenHours';
      PERFORM core.fn_vendor_token_ttl_hours();
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE '%not configured%' THEN v_fail_closed := true; END IF;
    END;
  END;

  IF NOT v_fail_closed THEN
    RAISE EXCEPTION
      'migration 040: the TTL function returned a value with no row configured — it must RAISE, '
      'otherwise an unconfigured deployment issues dispatch links that never expire';
  END IF;

  SELECT count(*) INTO n FROM core.settings WHERE key = 'vendorPortalTokenHours';
  IF n <> 1 THEN
    RAISE EXCEPTION 'migration 040: expected the vendorPortalTokenHours setting to exist, found % row(s)', n;
  END IF;
END $$;

COMMIT;
