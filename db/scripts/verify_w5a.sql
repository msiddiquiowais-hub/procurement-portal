-- verify_w5a.sql — post-migration verification for Wave 5 Track A.
-- Read-only checks plus one behavioural proof, all inside a transaction that is
-- ROLLED BACK, so the live database is never mutated by the proof itself.
BEGIN;

\echo '=== 030 dimension library ==='
SELECT (SELECT count(*) FROM core.dimensions) AS dims,
       (SELECT count(*) FROM core.dimension_values) AS values_,
       (SELECT count(*) FROM core.dimension_values WHERE is_placeholder) AS placeholders,
       (SELECT count(*) FROM core.hod_directory) AS hods;
\echo '-- values per dimension (prototype declares 4/6/5/7/4/4/4/3/3) --'
SELECT d.key, d.mandatory, count(v.id) AS n,
       count(*) FILTER (WHERE v.is_placeholder) AS placeholders
  FROM core.dimensions d LEFT JOIN core.dimension_values v ON v.dimension_key = d.key
 GROUP BY d.key, d.mandatory, d.sort_order ORDER BY d.sort_order;
\echo '-- every non-placeholder Location value has a real code --'
SELECT code, name FROM core.dimension_values
 WHERE dimension_key = 'Location' ORDER BY sort_order;

\echo ''
\echo '=== 031 UOM vocabulary ==='
SELECT count(*) FILTER (WHERE is_d365_catalog) AS d365_catalog,
       count(*) FILTER (WHERE light_flow)     AS light_flow,
       count(*) FILTER (WHERE is_d365_catalog AND light_flow) AS in_both,
       count(*) FILTER (WHERE light_flow AND NOT is_d365_catalog) AS light_only,
       count(*) AS total
  FROM core.uom;
\echo '-- the light-flow picker, as the form will read it --'
SELECT code FROM core.fn_light_flow_uoms();
\echo '-- validity function, incl. the legacy values that stopped a FK --'
SELECT v AS candidate, core.fn_uom_is_valid(v) AS valid, core.fn_uom_is_valid(v, false) AS exists_at_all
  FROM (VALUES ('EA'),('LEASE'),('BX'),('sheet'),('NOPE'),(''),(NULL)) AS t(v);

\echo ''
\echo '=== 032 settings ==='
SELECT group_name, count(*) AS n,
       count(*) FILTER (WHERE is_toggle) AS toggles,
       string_agg(key, ', ' ORDER BY sort_order) AS keys
  FROM core.settings GROUP BY group_name ORDER BY min(sort_order);
\echo '-- the 11 toggles and their stored defaults --'
SELECT key, value, value_type FROM core.settings WHERE is_toggle ORDER BY sort_order;
\echo '-- the type CHECK must reject a string masquerading as a boolean --'
DO $$
BEGIN
  BEGIN
    INSERT INTO core.settings (key, value, value_type, label, group_name)
    VALUES ('__probe', '"true"'::jsonb, 'boolean', 'probe', 'Display');
    RAISE EXCEPTION 'FAILED: a string was accepted for a boolean setting';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'type CHECK works — "true" (string) refused for a boolean setting';
  END;
END $$;

\echo ''
\echo '=== 033 attachment registry ==='
SELECT (SELECT count(*) FROM core.attachment_status) AS statuses,
       (SELECT count(*) FROM core.attachment_audit_actions) AS audit_actions;
\echo '-- kind mapping agrees with the blueprint MIME table --'
SELECT m AS mime, core.fn_attachment_kind(m) AS kind
  FROM (VALUES ('application/pdf'),('image/png'),('image/webp'),
               ('application/msword'),
               ('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
               ('application/vnd.ms-excel'),
               ('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
               ('text/plain'),('application/octet-stream')) AS t(m);

\echo ''
\echo '=== BEHAVIOURAL PROOF: attachment versioning is independent of quote versioning ==='
\echo '-- Builds two quotations on one RFQ, a file each, and two PRs, then proves:'
\echo '--   (a) V1''s PDF stays ACTIVE on quote v1 even after quote v2 exists'
\echo '--   (b) the same attachment name can be ACTIVE on BOTH quotations at once'
\echo '--   (c) Replace on v1 supersedes v1 only, and v2 is untouched'
\echo '-- All of this is rolled back at the end of the transaction.'

-- Minimal fixtures. Column names, enum casing and required fields are taken from
-- the live schema, not assumed: core.users needs display_name (not full_name) and
-- a non-null cost_center_ids/mfa_enabled/active, proc.quotations.state is
-- 'Superseded' (capital S), and the parent tables have real FKs.
INSERT INTO core.users (id, email, display_name, role, cost_center_ids, mfa_enabled, active)
VALUES ('55555555-5555-5555-5555-55555555aa01','w5a.probe.one@pakboxes.pk','W5A Probe One','procurement',
        '{}'::uuid[], false, true)
ON CONFLICT (email) DO NOTHING;

INSERT INTO proc.purchase_requisitions
  (id, pr_number, title, requester_user_id, department_id, cost_center_id, expense_type, required_by_date, status, scope)
VALUES ('55555555-5555-5555-5555-55555555bb01','W5A-PROBE-1','W5A probe PR',
        '55555555-5555-5555-5555-55555555aa01','00000000-0000-0000-0000-000000000002',
        '11111111-1111-1111-1111-111111111112','OPEX', current_date, 'Draft','W5A proof fixture');

INSERT INTO core.files (id, bucket, object_key, content_type, size_bytes, sha256, uploaded_by_user_id, version)
VALUES ('55555555-5555-5555-5555-55555555cc01','w5a','probe/quote-v1.pdf','application/pdf',1024,
        repeat('a',64),'55555555-5555-5555-5555-55555555aa01',1),
       ('55555555-5555-5555-5555-55555555cc02','w5a','probe/quote-v2.pdf','application/pdf',2048,
        repeat('b',64),'55555555-5555-5555-5555-55555555aa01',1),
       ('55555555-5555-5555-5555-55555555cc03','w5a','probe/quote-v1-rev2.pdf','application/pdf',3072,
        repeat('c',64),'55555555-5555-5555-5555-55555555aa01',1);

-- Two quotation versions on one real RFQ, so they are genuinely a v1/v2 pair.
INSERT INTO proc.quotations (id, rfq_id, vendor_id, total_amount, normalized_total_pkr, currency,
                             sealed_hash, open_at, state, version, submitted_by_user_id)
VALUES ('55555555-5555-5555-5555-55555555dd01','0f4404d5-e7e4-4c2e-ae4b-90e551a9dc87',
        '44444444-4444-4444-4444-444444444401',30000,30000,'PKR', repeat('1',64), now(), 'Submitted',1,
        '55555555-5555-5555-5555-55555555aa01'),
       ('55555555-5555-5555-5555-55555555dd02','0f4404d5-e7e4-4c2e-ae4b-90e551a9dc87',
        '44444444-4444-4444-4444-444444444401',31000,31000,'PKR', repeat('2',64), now(), 'Superseded',2,
        '55555555-5555-5555-5555-55555555aa01');

-- (a) V1's PDF attaches to quotation v1 and is ACTIVE.
INSERT INTO core.attachment_registry
  (name, file_id, mime_type, size_bytes, kind, version, parent_type, parent_id, status, uploaded_by_user_id)
VALUES ('Vendor Quotation','55555555-5555-5555-5555-55555555cc01','application/pdf',1024,'pdf',1,
        'quote','55555555-5555-5555-5555-55555555dd01','ACTIVE','55555555-5555-5555-5555-55555555aa01');

\echo '-- (a) one ACTIVE on quote v1 --'
SELECT r.name, r.version, r.status, q.version AS quote_version
  FROM core.attachment_registry r JOIN proc.quotations q ON q.id = r.parent_id
 WHERE r.parent_type = 'quote';

\echo '-- (b) SAME attachment name, ACTIVE on quote v2 as well (must be allowed) --'
INSERT INTO core.attachment_registry
  (name, file_id, mime_type, size_bytes, kind, version, parent_type, parent_id, status, uploaded_by_user_id)
VALUES ('Vendor Quotation','55555555-5555-5555-5555-55555555cc02','application/pdf',2048,'pdf',1,
        'quote','55555555-5555-5555-5555-55555555dd02','ACTIVE','55555555-5555-5555-5555-55555555aa01');

SELECT count(*) AS active_same_name_across_two_quotes
  FROM core.attachment_registry
 WHERE parent_type = 'quote' AND name = 'Vendor Quotation' AND status = 'ACTIVE';

\echo '-- (c) DEFERRABLE: a second ACTIVE on the same parent IS accepted mid-transaction --'
\echo '--     (this is what makes Replace expressible) but it must be refused at COMMIT.'
\echo '--     SET CONSTRAINTS ... IMMEDIATE performs exactly the check COMMIT would.'
DO $$
DECLARE
  v_new uuid;
BEGIN
  BEGIN
    -- Insert the replacement FIRST — the order the old immediate index forbade.
    INSERT INTO core.attachment_registry
      (name, file_id, mime_type, size_bytes, kind, version, parent_type, parent_id, status)
    VALUES ('Vendor Quotation','55555555-5555-5555-5555-55555555cc03','application/pdf',3072,'pdf',2,
            'quote','55555555-5555-5555-5555-55555555dd01','ACTIVE')
    RETURNING id INTO v_new;
    RAISE NOTICE 'replacement row inserted as ACTIVE while the old one is still ACTIVE — accepted mid-transaction';

    -- Now the old one steps aside, pointing at the replacement.
    UPDATE core.attachment_registry
       SET status = 'SUPERSEDED', superseded_by = v_new
     WHERE parent_type = 'quote' AND parent_id = '55555555-5555-5555-5555-55555555dd01'
       AND version = 1;

    SET CONSTRAINTS core.uq_attachment_active_per_parent_name IMMEDIATE;
    RAISE NOTICE 'COMMIT-time check passed — exactly one ACTIVE remains on quote v1';
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'FAILED: Replace in a single transaction was refused';
  END;
END $$;

\echo '-- (c2) leaving TWO ACTIVE behind must still be refused --'
DO $$
BEGIN
  BEGIN
    INSERT INTO core.attachment_registry
      (name, file_id, mime_type, size_bytes, kind, version, parent_type, parent_id, status)
    VALUES ('Vendor Quotation','55555555-5555-5555-5555-55555555cc03','application/pdf',3072,'pdf',3,
            'quote','55555555-5555-5555-5555-55555555dd01','ACTIVE');
    SET CONSTRAINTS core.uq_attachment_active_per_parent_name IMMEDIATE;
    RAISE EXCEPTION 'FAILED: two ACTIVE rows with the same name on one parent were allowed to commit';
  EXCEPTION WHEN exclusion_violation THEN
    RAISE NOTICE 'one-ACTIVE-per-parent-and-name is enforced at COMMIT, as a deferred constraint';
  END;
END $$;

\echo '-- (c3) quote v1 holds SUPERSEDED v1 + ACTIVE v2; quote v2 untouched and still ACTIVE --'
SELECT q.version AS quote_version, r.version AS att_version, r.status,
       (r.superseded_by IS NOT NULL) AS has_predecessor,
       (r.superseded_by = r.id) AS self_referential
  FROM core.attachment_registry r JOIN proc.quotations q ON q.id = r.parent_id
 WHERE r.parent_type = 'quote' ORDER BY q.version, r.version;

\echo '-- (d) VOID requires an actor and a timestamp (constraint must refuse) --'
DO $$
BEGIN
  BEGIN
    UPDATE core.attachment_registry SET status = 'VOID'
     WHERE parent_id = '55555555-5555-5555-5555-55555555dd01' AND version = 2;
    RAISE EXCEPTION 'FAILED: a VOID with no actor and no timestamp was allowed';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'VOID bookkeeping is enforced — a void with no actor/timestamp was refused';
  END;
END $$;

ROLLBACK;
\echo ''
\echo '=== rolled back: the live database is unchanged by this proof ==='
SELECT (SELECT count(*) FROM core.attachment_registry) AS registry_rows,
       (SELECT count(*) FROM core.users WHERE email = 'w5a.probe.one@pakboxes.pk') AS probe_users;
