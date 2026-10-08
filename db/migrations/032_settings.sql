-- 032_settings.sql
-- Phase: Wave 5 — Track A (Foundations)
-- Purpose: give the `settings` screen a real home — a typed settings catalog
--          carrying the prototype's 11 toggles and 6 scalars with their exact
--          declared defaults.
--
-- WHY THIS MIGRATION EXISTS
-- ------------------------
-- There is no settings table, no settings module and no settings page. The
-- prototype renders all 17 values from STATE.settings, defaulted by
-- settingsInit() (PROCUREMENT_PORTAL_PROTOTYPE.html:9258-9277) and labelled by
-- SETTINGS_TOGGLES (9290-9302). The gap analysis records this as #5, HIGH.
--
-- `value` is jsonb (matching workflow.config in migration 029) so a future
-- non-boolean, non-numeric setting needs no schema change — but jsonb alone
-- would happily store "true" as a STRING next to a real boolean, and a toggle
-- screen reading a string is a silent no-op. So the catalog carries the declared
-- type and a CHECK constraint enforces that the stored jsonb actually matches
-- it. That turns "the toggle is on" from an assumption into a database fact.
--
-- NOTE ON mgmtThresholdCr vs workflow.config
-- -----------------------------------------
-- The prototype's settings screen owns a `Management threshold (PKR Cr)` field
-- defaulting to 1.0. The Remediation Sprint already made the management
-- threshold genuinely live and role-gated as `workflow.config ->
-- 'management_threshold'` (migration 029), and the PR screen reads it from
-- GET /workflow/threshold. There must be exactly ONE threshold with one owner.
--
-- This migration therefore does NOT seed mgmtThresholdCr as an independent
-- setting. It is seeded as a DOCUMENTED ALIAS row that is not read by the engine
-- and carries a pointer to the canonical row, so the W5-C settings screen can
-- render the prototype's field while W5-B binds it to the canonical source. A
-- second writable copy of a governance threshold is precisely the
-- "declared-but-ignored field" defect Part 7 already suffered once with
-- conditionValue.
--
-- Idempotency: ON CONFLICT (key) DO NOTHING, so an admin edit made through the
-- W5-C screen is never clobbered by a re-run.

BEGIN;

SET LOCAL search_path = core, public;

-- ─── 1. The typed settings catalog ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS core.settings (
  key               text PRIMARY KEY,
  value             jsonb NOT NULL,
  value_type        text NOT NULL,
  label             text NOT NULL,
  description       text,
  group_name        text NOT NULL,
  is_toggle         boolean NOT NULL DEFAULT false,
  -- A setting that must not be edited here because another table owns it.
  canonical_source  text,
  sort_order        int NOT NULL DEFAULT 0,
  updated_by_user_id uuid REFERENCES core.users(id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settings_value_type_known CHECK (value_type IN ('boolean','int','number','string')),
  CONSTRAINT settings_label_not_blank CHECK (btrim(label) <> ''),
  -- The stored jsonb must match the declared type. Without this a toggle can
  -- hold "true" (string) and every reader has to guess.
  CONSTRAINT settings_value_matches_type CHECK (
    (value_type = 'boolean'           AND jsonb_typeof(value) = 'boolean')
    OR (value_type IN ('int','number') AND jsonb_typeof(value) = 'number')
    OR (value_type = 'string'          AND jsonb_typeof(value) = 'string')
  )
);

CREATE INDEX IF NOT EXISTS idx_settings_group ON core.settings (group_name, sort_order);

-- ─── 2. The 11 toggles, with the prototype's exact defaults ────────────────
-- Defaults are transcribed from settingsInit() (9263-9276) and the descriptions
-- from SETTINGS_TOGGLES (9291-9301).

INSERT INTO core.settings (key, value, value_type, label, description, group_name, is_toggle, sort_order) VALUES
  ('emailOnSubmit',     to_jsonb(true),  'boolean', 'Email requester on PR submit',         'Confirmation that the PR entered the approval chain.', 'Notifications',     true, 1),
  ('emailOnDecision',   to_jsonb(true),  'boolean', 'Email approver on every decision',    'Approve / reject / hold notifications to the acting role.', 'Notifications', true, 2),
  ('emailOnD365',       to_jsonb(true),  'boolean', 'Email on D365 push result',            'Sent on success and on failure.', 'Notifications',                          true, 3),
  ('emailOnEscalation', to_jsonb(false), 'boolean', 'Email on SLA escalation',              'Off by default — only when an item breaches the SLA window.', 'Notifications',  true, 4),
  ('requireAck',        to_jsonb(true),  'boolean', 'Require acknowledgement on deep links', 'Approver must acknowledge before the item leaves their queue.', 'Notifications', true, 5),
  ('d365AutoPush',      to_jsonb(false), 'boolean', 'Auto-push once CFO approves',          'Pushes as soon as the pack is locked and CFO has approved.', 'D365 integration',   true, 6),
  ('confirmBeforePush', to_jsonb(true),  'boolean', 'Confirm before D365 push',             'Adds a confirmation step in the Push to D365 screen.', 'D365 integration',          true, 7),
  ('autoRouteOpex',     to_jsonb(true),  'boolean', 'Auto-route Opex to Finance',           'Skip cost-centre approval when all lines are Opex consumable.', 'D365 integration', true, 8),
  ('compactRows',       to_jsonb(false), 'boolean', 'Compact table rows',                   'Denser row height across all list screens.', 'Display',                       true, 9),
  ('showActivityFeed',  to_jsonb(true),  'boolean', 'Show activity feed on dashboard',      'Adds the event feed panel to the Dashboard.', 'Display',                      true, 10),
  ('walkthrough',       to_jsonb(true),  'boolean', 'Show guided walkthrough bar',          'The step-by-step bar pinned above the content area.', 'Display',                           true, 11)
ON CONFLICT (key) DO NOTHING;

-- ─── 3. The 6 scalars ──────────────────────────────────────────────────────
-- Defaults from settingsInit() (9260-9262, 9267, 9271-9272).

INSERT INTO core.settings (key, value, value_type, label, description, group_name, is_toggle, sort_order) VALUES
  ('slaWarnDays',       to_jsonb(3),    'int',    'SLA warning (days)',      'Surface a warning once an item is this many days old.', 'Workflow & approvals', false, 1),
  ('slaBreachDays',     to_jsonb(7),    'int',    'SLA breach (days)',       'Raise an escalation once an item is this many days old.', 'Workflow & approvals', false, 2),
  ('approvalsPerPage',  to_jsonb(25),   'int',    'Rows per page',           'Default page size for the approvals and list screens.', 'Workflow & approvals', false, 3),
  ('d365Env',           '"PROD"'::jsonb,'string', 'Environment',             'Target D365 F&O environment: PROD, UAT or SANDBOX.', 'D365 integration', false, 4),
  ('d365Retries',       to_jsonb(3),    'int',    'Push retries',            'How many times a failed D365 push is retried.', 'D365 integration', false, 5),
  -- Documentation row, NOT an independent source of truth. See the header note.
  ('mgmtThresholdCr',   to_jsonb(1.0),  'number', 'Management threshold (PKR Cr)', 'Items above the management threshold route to Management review before the CFO. Lowering it changes which PRs the engine escalates.',
   'Workflow & approvals', false, 6)
ON CONFLICT (key) DO NOTHING;

UPDATE core.settings
   SET canonical_source = 'workflow.config[management_threshold]'
 WHERE key = 'mgmtThresholdCr';

-- The D365 environment is a closed 3-value set; keep it honest at the database
-- level so W5-B's PATCH cannot write 'PRODUCTION'.
ALTER TABLE core.settings DROP CONSTRAINT IF EXISTS settings_d365_env_domain;
ALTER TABLE core.settings ADD CONSTRAINT settings_d365_env_domain
  CHECK (key <> 'd365Env' OR value #>> '{}' IN ('PROD','UAT','SANDBOX'));

-- ─── Post-condition check (inside the transaction, so a failure rolls back) ─
-- A migration that cannot prove its own effect is a migration nobody should
-- trust. These assert the 17 keys THIS migration owns actually exist with the
-- right shape.
--
-- DELIBERATELY NOT AN EXACT COUNT. This block runs on every `db:migrate` replay,
-- and migration 034 adds an 18th setting (the 5 MB attachment cap). An
-- "expected 6 scalars, found 18" assertion here would abort every subsequent
-- re-migrate — the 019/020/027 landmine in a new costume, and the same class of
-- bug as a migration asserting a narrower final state than a later one. Assert
-- the KEYS, never the TOTAL. Same reasoning as 019's monotonic-widen helper.

DO $$
DECLARE
  missing_toggles text;
  missing_scalars text;
  bad_type        int;
  mgmt_owner      text;
BEGIN
  -- Every one of the prototype's 11 toggles must exist, and be a real boolean.
  SELECT string_agg(t.k, ', ' ORDER BY t.k) INTO missing_toggles
    FROM unnest(ARRAY['emailOnSubmit','emailOnDecision','emailOnD365','emailOnEscalation',
                      'requireAck','autoRouteOpex','confirmBeforePush','d365AutoPush',
                      'compactRows','showActivityFeed','walkthrough']) AS t(k)
   WHERE NOT EXISTS (
          SELECT 1 FROM core.settings s
           WHERE s.key = t.k AND s.is_toggle AND jsonb_typeof(s.value) = 'boolean');
  IF missing_toggles IS NOT NULL THEN
    RAISE EXCEPTION 'migration 032: toggle(s) missing or not stored as booleans: %', missing_toggles;
  END IF;

  -- And the 6 scalars.
  SELECT string_agg(t.k, ', ' ORDER BY t.k) INTO missing_scalars
    FROM unnest(ARRAY['slaWarnDays','slaBreachDays','approvalsPerPage',
                      'd365Env','d365Retries','mgmtThresholdCr']) AS t(k)
   WHERE NOT EXISTS (SELECT 1 FROM core.settings s WHERE s.key = t.k AND NOT s.is_toggle);
  IF missing_scalars IS NOT NULL THEN
    RAISE EXCEPTION 'migration 032: scalar setting(s) missing: %', missing_scalars;
  END IF;

  -- The declared type must match the stored jsonb for EVERY row, including any
  -- added by a later migration — that constraint is the whole point of the table.
  SELECT count(*) INTO bad_type
    FROM core.settings
   WHERE (value_type = 'boolean' AND jsonb_typeof(value) <> 'boolean')
      OR (value_type IN ('int','number') AND jsonb_typeof(value) <> 'number')
      OR (value_type = 'string' AND jsonb_typeof(value) <> 'string');
  IF bad_type > 0 THEN
    RAISE EXCEPTION 'migration 032: % setting(s) store a value that contradicts their declared type', bad_type;
  END IF;

  -- The management threshold must have exactly one owner. If workflow.config has
  -- no management_threshold row the alias would point at nothing, so assert it
  -- exists rather than leaving a dangling pointer.
  SELECT value INTO mgmt_owner FROM workflow.config WHERE key = 'management_threshold';
  IF mgmt_owner IS NULL THEN
    RAISE EXCEPTION 'migration 032: workflow.config has no management_threshold; the settings alias would dangle';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM core.settings WHERE key = 'mgmtThresholdCr' AND canonical_source IS NOT NULL) THEN
    RAISE EXCEPTION 'migration 032: mgmtThresholdCr is not marked as an alias of the canonical workflow.config row';
  END IF;

  RAISE NOTICE 'migration 032 verified — all 11 toggles and 6 scalars present and correctly typed, management threshold has a single canonical owner';
END $$;

COMMIT;
