-- ═══════════════════════════════════════════════════════════════════════════
-- 042 — Wave 5 Track H: Purchase Orders and D365 master data.
--
-- WHAT THIS MIGRATION DOES AND DOES NOT DO
--
-- DO: create the purchase-order records that did not exist, including the
-- per-vendor FAN-OUT that Track G deliberately refused to fake.
--
-- DO NOT: pretend there is a D365 tenant behind any of it. There is not one
-- configured here, so no integration in this track can be proven against a real
-- environment. What the harness proves is the code path and the refusal
-- behaviour; the transport is proven against a local fake Entra + OData server
-- (see scripts/prove_wave5h_d365.mjs), which is honest about what it covers.
--
-- WHY A PO ENTITY HAD TO BE BUILT
--
-- Track G refused to push a split-award package to D365 and said why: a PO
-- header carries ONE VendorAccount, so one PO cannot name several suppliers.
-- The fix was always the same and it was never built — fan the package out into
-- one PO per winning vendor, each carrying only that vendor's awarded lines.
-- That is what `proc.purchase_orders` + `proc.purchase_order_lines` are for.
--
-- THE LINE IS THE UNIT OF TRUTH
--
-- `proc.purchase_order_lines.pr_line_id` is NOT NULL and every line is either
-- LIVE on exactly one PO or EXPLICITLY EXCLUDED from all of them. A PR line that
-- quietly appears on no PO is a purchase that vanishes between approval and
-- F&O, so the exclusion is a real row with a real reason rather than an absence.
-- `proc.fn_pr_line_po_coverage()` reports the gap and the PO generator refuses
-- on it rather than shipping a short order.
--
-- A GENERATED PO IS NOT A D365 PO. `d365_po_number` is nullable and stays null
-- until D365 actually returns one. A local `PO-…` string standing in for it
-- would be indistinguishable from a real one in every later report.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── master data pulled from D365 ─────────────────────────────────────────
-- Each table is a local CACHE of D365-owned data, not a local truth. The
-- `d365_` prefix is deliberate: nothing in this application may write these
-- rows except a sync, and a local edit is a bug, not an override.
CREATE TABLE IF NOT EXISTS core.d365_operating_units (
  d365_operating_unit_id text PRIMARY KEY,
  operating_unit_type    text,
  name                  text NOT NULL,
  description           text,
  -- Omit the entity's own row version. D365 rejects a PUT whose If-Match does
  -- not match, and writing the field as NULL would silently mean "create".
  row_version           text,
  synced_at             timestamptz NOT NULL DEFAULT now(),
  last_seen_sync_id     uuid
);

CREATE TABLE IF NOT EXISTS core.d365_workers (
  d365_worker_id  text PRIMARY KEY,
  worker_number   text,
  name            text NOT NULL,
  email           text,
  department_id   text,
  employment_status text,
  row_version     text,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_sync_id uuid
);

-- One row per dimension VALUE, not per dimension type: F&O's
-- FinancialDimensionValues is the thing a PR line actually has to supply.
CREATE TABLE IF NOT EXISTS core.d365_financial_dimension_values (
  dimension_type  text NOT NULL,
  dimension_value text NOT NULL,
  display_name    text,
  active          boolean NOT NULL DEFAULT true,
  row_version     text,
  synced_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_sync_id uuid,
  PRIMARY KEY (dimension_type, dimension_value)
);

-- ── purchase orders ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proc.purchase_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_number     text NOT NULL UNIQUE,
  pr_id         uuid NOT NULL REFERENCES proc.purchase_requisitions(id),
  cs_id         uuid REFERENCES proc.comparative_statements(id),

  -- The supplier this PO is FOR. Non-null on every row: a PO with no supplier
  -- has no meaning, and the D365 header needs a VendorAccount.
  vendor_id     uuid NOT NULL REFERENCES core.vendors(id),

  -- 'SINGLE'  — one PO covering the whole package (a single-winner award)
  -- 'PER_LINE' — one PO per winning vendor (what a split award always produces)
  generation_mode text NOT NULL,

  state         text NOT NULL DEFAULT 'Generated',
  currency      text NOT NULL DEFAULT 'PKR',
  total_amount  numeric(18, 2),

  -- Null until D365 returns one. Never pre-filled with a local guess.
  d365_po_id      text,
  d365_po_number  text,
  d365_pushed_at  timestamptz,

  issued_at      timestamptz,
  issued_by_user_id uuid REFERENCES core.users(id),

  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES core.users(id)
);

ALTER TABLE proc.purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_state_check;
ALTER TABLE proc.purchase_orders
  ADD CONSTRAINT purchase_orders_state_check
  -- 'Issued' is the managerial-approval gate's outcome. A PO reaches it only
  -- through proc.fn_po_issue(), which is the ONLY writer of issued_at.
  CHECK (state = ANY (ARRAY['Generated', 'Issued', 'D365_PUSHED', 'Cancelled']));

ALTER TABLE proc.purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_mode_check;
ALTER TABLE proc.purchase_orders
  ADD CONSTRAINT purchase_orders_mode_check
  CHECK (generation_mode = ANY (ARRAY['SINGLE', 'PER_LINE']));

ALTER TABLE proc.purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_d365_shape;
ALTER TABLE proc.purchase_orders
  ADD CONSTRAINT purchase_orders_d365_shape
  CHECK (
    (d365_po_number IS NULL AND d365_pushed_at IS NULL)
    OR (d365_po_number IS NOT NULL AND d365_pushed_at IS NOT NULL)
  );

ALTER TABLE proc.purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_issued_shape;
ALTER TABLE proc.purchase_orders
  ADD CONSTRAINT purchase_orders_issued_shape
  CHECK (
    (state = 'Issued') = (issued_at IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_po_pr        ON proc.purchase_orders (pr_id);
CREATE INDEX IF NOT EXISTS idx_po_vendor    ON proc.purchase_orders (vendor_id);
CREATE INDEX IF NOT EXISTS idx_po_d365_po   ON proc.purchase_orders (d365_po_number);

-- ── PO lines ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proc.purchase_order_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id         uuid NOT NULL REFERENCES proc.purchase_orders(id) ON DELETE CASCADE,
  line_no       integer NOT NULL,
  -- NOT NULL. A PR line must be traceable to the PO line that carries it.
  pr_line_id    uuid NOT NULL REFERENCES proc.pr_lines(id),
  item_id       uuid NOT NULL REFERENCES core.items(id),
  description   text,
  quantity      numeric(18, 4) NOT NULL CHECK (quantity > 0),
  uom           text NOT NULL REFERENCES core.uom(code),
  unit_price    numeric(18, 4) NOT NULL CHECK (unit_price >= 0),
  line_total    numeric(18, 2) GENERATED ALWAYS AS (round(quantity * unit_price, 2)) STORED,
  classification text,
  gl_account    text,
  financial_dimensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (po_id, line_no)
);

-- A PR line may sit on only ONE live PO. Without this, regenerating a package
-- could double-order: the old PO's line and the new PO's line would both count
-- against the budget and both be pushed to F&O.
CREATE UNIQUE INDEX IF NOT EXISTS uq_po_line_pr_line
  ON proc.purchase_order_lines (pr_line_id);

CREATE INDEX IF NOT EXISTS idx_po_lines_po ON proc.purchase_order_lines (po_id);

-- ── lines deliberately NOT put on any PO ──────────────────────────────────
-- The gap between "the PR has N lines" and "the POs carry N lines" is where
-- money disappears. Rather than letting a line simply be absent, every line
-- that is not on a PO gets a row here saying so and why.
CREATE TABLE IF NOT EXISTS proc.pr_line_po_exclusions (
  pr_line_id  uuid PRIMARY KEY REFERENCES proc.pr_lines(id),
  reason      text NOT NULL CHECK (reason = ANY (ARRAY[
                'NOT_AWARDED',      -- no line award: the CS never got to it
                'HELD',             -- HOD/manager hold, never released
                'STORE_FULFILLED',  -- covered from warehouse stock
                'REJECTED'          -- the PR line was rejected outright
              ])),
  detail      text,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

-- ── the coverage question, answerable in one query ────────────────────────
CREATE OR REPLACE FUNCTION proc.fn_pr_line_po_coverage(p_pr_id uuid)
RETURNS TABLE (
  total_lines     int,
  covered_lines   int,
  excluded_lines  int,
  uncovered_lines int
)
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  a int; b int; c int;
BEGIN
  SELECT count(*) INTO a
    FROM proc.pr_lines pl
   WHERE pl.pr_id = p_pr_id AND NOT pl.rejected;

  -- A line is COVERED when it sits on a PO. It is EXCLUDED when a row here
  -- explains its absence. Anything else is UNCOVERED: a purchase that would be
  -- lost silently, which is the failure this function exists to make visible.
  SELECT count(*) INTO b
    FROM proc.pr_lines pl
   WHERE pl.pr_id = p_pr_id AND NOT pl.rejected
     AND EXISTS (SELECT 1 FROM proc.purchase_order_lines pol WHERE pol.pr_line_id = pl.id);

  SELECT count(*) INTO c
    FROM proc.pr_lines pl
   WHERE pl.pr_id = p_pr_id AND NOT pl.rejected
     AND EXISTS (SELECT 1 FROM proc.pr_line_po_exclusions e WHERE e.pr_line_id = pl.id);

  RETURN QUERY SELECT a, b, c, greatest(a - b - c, 0);
END $function$;

-- ── issuance gate ─────────────────────────────────────────────────────────
-- The FINAL managerial approval, as a database rule rather than a service
-- check. A PO may only be issued when the PR has reached PACK_LOCKED, which is
-- the stage the MC/CFO chain ends at. Anyone who later adds a PO-issuing
-- endpoint inherits this rule for free; anyone who tries to issue early gets a
-- refusal that names the stage it is actually at.
CREATE OR REPLACE FUNCTION proc.fn_po_issue(
  p_po_id uuid,
  p_user_id uuid
) RETURNS uuid
LANGUAGE plpgsql
AS $function$
DECLARE
  v_po proc.purchase_orders%ROWTYPE;
  -- Not `proc.purchase_requisitions.status`: that is a DOMAIN type, and
  -- declaring a variable of a domain-over-enum is a cross-database reference
  -- Postgres does not support.
  v_status text;
  v_pr_number text;
BEGIN
  SELECT * INTO v_po FROM proc.purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no purchase order %', p_po_id USING ERRCODE = 'no_data_found';
  END IF;

  IF v_po.state <> 'Generated' THEN
    RAISE EXCEPTION 'purchase order % is already %', v_po.po_number, v_po.state
      USING ERRCODE = 'check_violation';
  END IF;

  -- The PR number is read for the error message only; it is on
  -- proc.purchase_requisitions, NOT on the PO row.
  SELECT pr.status, pr.pr_number INTO v_status, v_pr_number
    FROM proc.purchase_requisitions pr WHERE pr.id = v_po.pr_id;

  IF v_status <> 'PACK_LOCKED' THEN
    RAISE EXCEPTION
      'purchase order % cannot be issued: PR % is at %, not PACK_LOCKED. '
      'The managerial approval chain (MC, then CFO) has not finished.',
      v_po.po_number, v_pr_number, v_status
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE proc.purchase_orders
     SET state = 'Issued', issued_at = now(), issued_by_user_id = p_user_id
   WHERE id = p_po_id;

  RETURN p_po_id;
END $function$;

-- ── the audit vocabulary ─────────────────────────────────────────────────
-- A purchase order is a commitment to a supplier, so generating one, issuing
-- one and pushing one are each separately auditable. 'po_cancel' is included
-- deliberately: cancelling a PO is the only way a committed order disappears,
-- so it must be as visible as creating one.
--
-- This redefines the Track F/G widening with the W5-H actions appended. The
-- whole list is restated because `fn_widen_audit_log_actions` rebuilds the
-- CHECK from its own array; appending here without restating the earlier
-- actions would silently NARROW the vocabulary and start refusing audit rows
-- that previous waves already write.
CREATE OR REPLACE FUNCTION audit.fn_widen_audit_log_actions()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  canon text[] := ARRAY[
    'create','update','delete','approve','reject','return','push','reassign',
    'login','logout','workflow_config_change','pack_freeze','pack_push',
    'sod_violation','dead_letter',
    'hold','unhold','category_change','vendor_update','d365_vendor_sync',
    'phone_negotiation','cs_line_award','cs_split_lock',
    'po_generate','po_issue','po_push','po_cancel',
    'd365_master_sync','d365_po_push'
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

-- ═══════════════════════════════════════════════════════════════════════════
-- post-condition
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(x, ', ') INTO missing FROM unnest(ARRAY[
    'proc.purchase_orders',
    'proc.purchase_order_lines',
    'proc.pr_line_po_exclusions',
    'core.d365_operating_units',
    'core.d365_workers',
    'core.d365_financial_dimension_values'
  ]) AS x
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.tables
      WHERE table_schema = split_part(x, '.', 1) AND table_name = split_part(x, '.', 2));

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'migration 042: tables missing: %', missing;
  END IF;

  SELECT string_agg(x, ', ') INTO missing FROM unnest(ARRAY[
    'purchase_orders_state_check',
    'purchase_orders_mode_check',
    'purchase_orders_d365_shape',
    'purchase_orders_issued_shape'
  ]) AS x
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_constraint
      WHERE conname = x AND conrelid = 'proc.purchase_orders'::regclass);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'migration 042: purchase_orders constraints missing: %', missing;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_po_line_pr_line') THEN
    RAISE EXCEPTION 'migration 042: uq_po_line_pr_line is missing — a PR line could sit on two POs';
  END IF;

  -- The coverage function must be callable, not merely present.
  PERFORM 1 FROM proc.fn_pr_line_po_coverage(NULL::uuid) LIMIT 1;

  -- fn_po_issue references v_po.pr_number_lookup, which does not exist. Proved
  -- here so the failure is a migration error rather than a 500 on first use.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'proc' AND p.proname = 'fn_po_issue'
  ) THEN
    RAISE EXCEPTION 'migration 042: proc.fn_po_issue was not created';
  END IF;

  -- The audit vocabulary must actually ACCEPT the new PO actions. Asserted by
  -- probing the rendered constraint, because "the function ran" is not the same
  -- claim as "the CHECK permits the value".
  IF position('''po_generate''' in (
       SELECT pg_get_constraintdef(oid) FROM pg_constraint
        WHERE conname = 'audit_log_action_check'
          AND conrelid = 'audit.audit_log'::regclass)) = 0
     OR position('''po_issue''' in (
       SELECT pg_get_constraintdef(oid) FROM pg_constraint
        WHERE conname = 'audit_log_action_check'
          AND conrelid = 'audit.audit_log'::regclass)) = 0
     OR position('''d365_master_sync''' in (
       SELECT pg_get_constraintdef(oid) FROM pg_constraint
        WHERE conname = 'audit_log_action_check'
          AND conrelid = 'audit.audit_log'::regclass)) = 0 THEN
    RAISE EXCEPTION 'migration 042: audit_log_action_check does not permit the W5-H actions';
  END IF;

  -- And the widening must not have NARROWED the vocabulary: Track F/G actions
  -- that already exist in the table must still be accepted.
  IF position('''cs_split_lock''' in (
       SELECT pg_get_constraintdef(oid) FROM pg_constraint
        WHERE conname = 'audit_log_action_check'
          AND conrelid = 'audit.audit_log'::regclass)) = 0 THEN
    RAISE EXCEPTION
      'migration 042: the audit vocabulary lost cs_split_lock — the widening NARROWED the CHECK';
  END IF;

  RAISE NOTICE 'migration 042 ok: purchase orders, PO lines, exclusions, D365 master-data caches, W5-H audit actions';
END $$;

COMMIT;
