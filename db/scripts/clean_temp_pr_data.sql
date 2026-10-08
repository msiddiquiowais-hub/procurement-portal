-- ══════════════════════════════════════════════════════════════════════════
-- Remove temp / test data from the procurement DB.
--
-- KEEPS the single seeded demo row from db/seeds/seed.sql
--   ("Demo PR — Cardboard restock")
-- DELETES every other purchase requisition and everything hanging off it.
--
-- Child rows are removed explicitly first: most FKs into purchase_requisitions
-- are NO ACTION, not CASCADE, so a bare DELETE would abort.
-- Runs in one transaction — any FK miss rolls the whole thing back.
-- ══════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE doomed AS
SELECT id FROM proc.purchase_requisitions
 WHERE scope IS DISTINCT FROM 'Demo PR — Cardboard restock';

DO $$
DECLARE
  t  text;
  n  bigint;
  ord text[] := ARRAY[
    -- proc chain, deepest first
    'proc.quotation_lines', 'proc.quotations', 'proc.rfq_invitations',
    'proc.rfq_lines', 'proc.negotiation_log', 'proc.cs_lines',
    'proc.comparative_statements', 'proc.approved_packs',
    'proc.d365_sync_log', 'proc.d365_pushes',
    'proc.approval_votes', 'proc.escalations', 'proc.mc_sessions',
    'proc.savings_lines', 'proc.budget_reservations', 'proc.pr_amendments',
    -- direct children of purchase_requisitions that do NOT cascade
    'proc.pr_acknowledgements', 'proc.pr_amendments', 'proc.pr_attachments',
    'proc.pr_departments', 'proc.pr_images', 'proc.pr_lines',
    'proc.pr_workflow_snapshot'
  ];
BEGIN
  FOREACH t IN ARRAY ord LOOP
    IF to_regclass(t) IS NULL THEN CONTINUE; END IF;

    -- Some tables hang off pr_line / rfq / approved_pack rather than pr_id,
    -- and a few have no pr_id column at all. Build the predicate from whatever
    -- columns this table actually has.
    DECLARE
      has_pr_id  boolean := EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema || '.' || table_name = t AND column_name = 'pr_id');
    BEGIN
      EXECUTE format($f$
        DELETE FROM %s d
         WHERE %s
      $f$, t,
        concat_ws(' OR ',
          CASE WHEN has_pr_id
            THEN 'd.pr_id IN (SELECT id FROM doomed)' END,
          CASE
            WHEN t = 'proc.rfq_lines'
              THEN 'd.pr_line_id IN (SELECT pl.id FROM proc.pr_lines pl JOIN doomed ON doomed.id = pl.pr_id)
                    OR d.rfq_id IN (SELECT r.id FROM proc.rfq r JOIN doomed ON doomed.id = r.pr_id)'
            WHEN t IN ('proc.quotations','proc.rfq_invitations','proc.negotiation_log')
              THEN 'd.rfq_id IN (SELECT r.id FROM proc.rfq r JOIN doomed ON doomed.id = r.pr_id)'
            WHEN t = 'proc.quotation_lines'
              THEN 'd.quotation_id IN (SELECT q.id FROM proc.quotations q JOIN proc.rfq r ON r.id=q.rfq_id JOIN doomed ON doomed.id=r.pr_id)'
            WHEN t = 'proc.cs_lines'
              THEN 'd.cs_id IN (SELECT cs.id FROM proc.comparative_statements cs JOIN doomed ON doomed.id=cs.pr_id)'
            WHEN t = 'proc.pr_images'
              THEN 'd.line_id IN (SELECT pl.id FROM proc.pr_lines pl JOIN doomed ON doomed.id=pl.pr_id)'
            ELSE NULL
          END));
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n > 0 THEN RAISE NOTICE '  % -> % row(s)', rpad(t,32), n; END IF;
    END;
  END LOOP;
END $$;

-- Parent/child self-FK is NO ACTION, so break it before the main delete.
UPDATE proc.purchase_requisitions SET parent_pr_id = NULL
 WHERE parent_pr_id IN (SELECT id FROM doomed);

DELETE FROM proc.purchase_requisitions WHERE id IN (SELECT id FROM doomed);

-- Trim the PR-number sequence back so the next PR reads naturally.
SELECT setval('proc.pr_number_seq',
              GREATEST((SELECT last_value FROM proc.pr_number_seq),
                       (SELECT COALESCE(MAX(split_part(pr_number,'-',3)::bigint), 0)
                          FROM proc.purchase_requisitions)));

DROP TABLE doomed;
COMMIT;

\echo '--- remaining ---'
SELECT pr_number, scope, title, created_at FROM proc.purchase_requisitions ORDER BY created_at;
