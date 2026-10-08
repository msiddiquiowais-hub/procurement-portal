-- seed.sql
-- Reference + demo data for local dev and CI smoke tests.
-- Idempotent: safe to run repeatedly.
-- Roles + feature flags + FX rates are seeded by migrations; this file
-- focuses on demo users, departments, cost centers, vendors, items,
-- authority matrix sanity, and one open PR.

BEGIN;

SET LOCAL search_path = core, proc, public;

-- ─── Departments ───────────────────────────────────────────────────────────────
INSERT INTO core.departments (id, code, name) VALUES
  ('00000000-0000-0000-0000-000000000001', 'SALES', 'Sales'),
  ('00000000-0000-0000-0000-000000000002', 'IT',    'Information Technology'),
  ('00000000-0000-0000-0000-000000000003', 'FIN',   'Finance'),
  ('00000000-0000-0000-0000-000000000004', 'HR',    'Human Resources'),
  ('00000000-0000-0000-0000-000000000005', 'OPS',   'Operations')
ON CONFLICT (code) DO NOTHING;

-- ─── Cost centers ──────────────────────────────────────────────────────────────
INSERT INTO core.cost_centers (id, code, name, department_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 'PKB-LHR-001', 'Lahore Sales',         '00000000-0000-0000-0000-000000000001'),
  ('11111111-1111-1111-1111-111111111112', 'PKB-LHR-002', 'Lahore IT',            '00000000-0000-0000-0000-000000000002'),
  ('11111111-1111-1111-1111-111111111113', 'PKB-LHR-003', 'Lahore Finance',       '00000000-0000-0000-0000-000000000003'),
  ('11111111-1111-1111-1111-111111111114', 'PKB-LHR-004', 'Lahore HR',            '00000000-0000-0000-0000-000000000004'),
  ('11111111-1111-1111-1111-111111111115', 'PKB-LHR-005', 'Lahore Operations',    '00000000-0000-0000-0000-000000000005')
ON CONFLICT (code) DO NOTHING;

-- ─── Projects ──────────────────────────────────────────────────────────────────
INSERT INTO core.projects (id, code, name, state, start_date) VALUES
  ('22222222-2222-2222-2222-222222222221', 'PRJ-NEW-LINE-2026', 'New Production Line 2026', 'active', date '2026-01-01'),
  ('22222222-2222-2222-2222-222222222222', 'PRJ-WAREHOUSE-EXP',  'Warehouse Expansion',      'active', date '2026-03-01'),
  ('22222222-2222-2222-2222-222222222223', 'PRJ-ERP-MIG',        'ERP Migration',           'active', date '2026-06-01')
ON CONFLICT (code) DO NOTHING;

-- ─── Users (demo) ──────────────────────────────────────────────────────────────
INSERT INTO core.users (id, email, display_name, role, cost_center_ids, mfa_enabled) VALUES
  ('33333333-3333-3333-3333-333333333301', 'requester@pakboxes.pk',          'Aisha Khan',     'requester',          ARRAY['11111111-1111-1111-1111-111111111111']::uuid[], false),
  ('33333333-3333-3333-3333-333333333303', 'procurement@pakboxes.pk',        'Hina Tariq',     'procurement',        ARRAY['11111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111112','11111111-1111-1111-1111-111111111113','11111111-1111-1111-1111-111111111114','11111111-1111-1111-1111-111111111115']::uuid[], false),
  ('33333333-3333-3333-3333-333333333304', 'cs@pakboxes.pk',                 'Arsalan Majeed', 'cs',                 ARRAY['11111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111112','11111111-1111-1111-1111-111111111113','11111111-1111-1111-1111-111111111114','11111111-1111-1111-1111-111111111115']::uuid[], false),
  ('33333333-3333-3333-3333-333333333305', 'cost.center@pakboxes.pk',        'Mariam Saleem',  'cost_center_owner',  ARRAY['11111111-1111-1111-1111-111111111111']::uuid[], false),
  ('33333333-3333-3333-3333-333333333306', 'finance@pakboxes.pk',            'Omar Farooq',    'finance',            ARRAY['11111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111112','11111111-1111-1111-1111-111111111113','11111111-1111-1111-1111-111111111114','11111111-1111-1111-1111-111111111115']::uuid[], false),
  ('33333333-3333-3333-3333-333333333307', 'mc.member1@pakboxes.pk',         'Dr. Imran Shah', 'mc',                 '{}'::uuid[], false),
  ('33333333-3333-3333-3333-333333333308', 'mc.member2@pakboxes.pk',         'Tariq Saleem',  'mc',                 '{}'::uuid[], false),
  ('33333333-3333-3333-3333-333333333309', 'cfo@pakboxes.pk',                'Yusuf Raza',     'cfo',                '{}'::uuid[], false),
  ('33333333-3333-3333-3333-33333333330a', 'audit@pakboxes.pk',              'Zara Hussain',   'audit',              '{}'::uuid[], false),
  ('33333333-3333-3333-3333-33333333330b', 'hr@pakboxes.pk',                 'Nida Aslam',     'hr',                 '{}'::uuid[], false),
  ('33333333-3333-3333-3333-33333333330c', 'warehouse@pakboxes.pk',          'Faisal Nawaz',   'store_incharge',     '{}'::uuid[], false),
  ('33333333-3333-3333-3333-33333333330d', 'admin@pakboxes.pk',              'System Admin',   'admin',              '{}'::uuid[], true),
  -- The two SUPPLIER logins (vendor1/vendor2) are NOT here. They are inserted
  -- after the vendors block below, because migration 028 added
  -- ck_users_vendor_role: a row with role='vendor' MUST carry a vendor_id, and
  -- that vendor row does not exist yet at this point in the file. Inserting
  -- them here fails a check violation on a fresh database. See the note above
  -- the second users insert.
  -- Wave 3: the MC panel is FIVE members and must be unanimous (prototype
  -- renderMCVote: "Need 5/5 unanimous approve"). Two is not a committee.
  -- These three complete the panel below; the two above are seats 1 and 2.
  ('33333333-3333-3333-3333-333333333310', 'mc.member3@pakboxes.pk',         'Naila Aziz',     'mc',                 '{}'::uuid[], false),
  ('33333333-3333-3333-3333-333333333311', 'mc.member4@pakboxes.pk',         'Junaid Akhtar',  'mc',                 '{}'::uuid[], false),
  ('33333333-3333-3333-3333-333333333312', 'mc.member5@pakboxes.pk',         'Saba Khan',      'mc',                 '{}'::uuid[], false),
  -- ── Heads of Department ────────────────────────────────────────────────────
  -- Migration 046 made a department's approver RESOLVED from
  -- core.departments.hod_user_id and enforced by
  -- proc.fn_pr_departments_approver_gate(): a PR may only ever be tagged with
  -- the HOD of the PR's own department.
  --
  -- Before this, the only hod user in the system was hod.sales@, and only
  -- SALES had a hod_user_id. HR, IT, FIN and OPS resolved to NULL, which
  -- means a requisition raised for any of them was tagged to NOBODY and sat in
  -- Submitted forever. "Route to the HOD of HR" was not a mis-routing bug, it
  -- was an unmapped destination.
  --
  -- Each HOD below holds ONLY their own department's cost centre, so
  -- trg_users_department_consistency (which requires a user's department to
  -- own at least one of their cost centres) is satisfied on insert, and
  -- core.users.department_id backfills unambiguously from that cost centre.
  --
  -- hod.sales keeps its ORIGINAL id (...3302) rather than being renumbered with
  -- the new heads. Renumbering it would collide with its own ON CONFLICT
  -- (email) DO NOTHING - the insert would be skipped, and the id it was
  -- supposed to carry would exist on no row at all.
  ('33333333-3333-3333-3333-333333333302', 'hod.sales@pakboxes.pk',          'Bilal Ahmed',    'hod',                ARRAY['11111111-1111-1111-1111-111111111111']::uuid[], false),
  ('33333333-3333-3333-3333-333333333322', 'hod.hr@pakboxes.pk',            'Sadia Iqbal',    'hod',                ARRAY['11111111-1111-1111-1111-111111111114']::uuid[], false),
  ('33333333-3333-3333-3333-333333333323', 'hod.it@pakboxes.pk',            'Kamran Yousuf',  'hod',                ARRAY['11111111-1111-1111-1111-111111111112']::uuid[], false),
  ('33333333-3333-3333-3333-333333333324', 'hod.finance@pakboxes.pk',       'Rabia Noor',     'hod',                ARRAY['11111111-1111-1111-1111-111111111113']::uuid[], false),
  ('33333333-3333-3333-3333-333333333325', 'hod.operations@pakboxes.pk',   'Shahid Mehmood', 'hod',                ARRAY['11111111-1111-1111-1111-111111111115']::uuid[], false)
ON CONFLICT (email) DO NOTHING;

-- ── Management Committee panel ─────────────────────────────────────────────
-- The prototype hardcodes its member list in renderMCVote (line 7870) and keys
-- STATE.pr.mcVotes by those names. In the app the panel is rows: `seat` fixes
-- the display order, `chair` is the persona the prototype hardcodes as the
-- acting voter ("You are voting as Dr. Imran Shah").
--
-- Names and order are the prototype's, verbatim:
--   Dr. Imran Shah, Tariq Saleem, Naila Aziz, Junaid Akhtar, Saba Khan
-- The quorum is count(*) of this table — see workflow.fn_mc_quorum().
INSERT INTO workflow.mc_panel (user_id, seat, chair) VALUES
  ('33333333-3333-3333-3333-333333333307', 1, true),    -- Dr. Imran Shah
  ('33333333-3333-3333-3333-333333333308', 2, false),   -- Tariq Saleem
  ('33333333-3333-3333-3333-333333333310', 3, false),   -- Naila Aziz
  ('33333333-3333-3333-3333-333333333311', 4, false),   -- Junaid Akhtar
  ('33333333-3333-3333-3333-333333333312', 5, false)    -- Saba Khan
ON CONFLICT (user_id) DO UPDATE SET seat = EXCLUDED.seat, chair = EXCLUDED.chair;

-- ─── Departments: the person, and the head who approves for them ─────────────
-- Two mappings that used to be conflated into one:
--
--   core.users.cost_center_ids  -> WHERE the cost is charged (allocation)
--   core.users.department_id    -> WHICH DEPARTMENT THE PERSON IS IN
--                                       (org chart, drives approval routing)
--
-- Migration 046 added the second one because the first cannot answer the
-- question. A requester was only reachable to a department by walking their
-- cost centres, and Aisha Khan was mapped to "Lahore Sales" - so the
-- requester-scoped department lookup resolved her to SALES, and the only head
-- of department in the system was HOD Sales.
--
-- Aisha Khan works in HR. She KEEPS Lahore Sales in her cost centres so her
-- existing requisitions keep their historical cost allocation; her
-- department_id is HR, and HR owns Lahore HR, which she now also holds -
-- the invariant trg_users_department_consistency enforces.
UPDATE core.users
   SET department_id = '00000000-0000-0000-0000-000000000004',
       cost_center_ids = ARRAY['11111111-1111-1111-1111-111111111114',
                               '11111111-1111-1111-1111-111111111111']::uuid[]
 WHERE email = 'requester@pakboxes.pk';

-- Every department needs a HOD, or a requisition raised for it resolves to
-- nobody and waits in Submitted forever. core.fn_resolve_department_hod()
-- reads exactly this column, and the approver gate accepts exactly this value.
UPDATE core.departments SET hod_user_id = '33333333-3333-3333-3333-333333333302' WHERE code = 'SALES';
UPDATE core.departments SET hod_user_id = '33333333-3333-3333-3333-333333333322' WHERE code = 'HR';
UPDATE core.departments SET hod_user_id = '33333333-3333-3333-3333-333333333323' WHERE code = 'IT';
UPDATE core.departments SET hod_user_id = '33333333-3333-3333-3333-333333333324' WHERE code = 'FIN';
UPDATE core.departments SET hod_user_id = '33333333-3333-3333-3333-333333333325' WHERE code = 'OPS';

-- The head of department is also the cost centre's hod, mirroring the SALES
-- mapping that already existed. The cost-centre owner stays with Mariam Saleem.
UPDATE core.cost_centers SET hod_user_id = '33333333-3333-3333-3333-333333333302' WHERE code = 'PKB-LHR-001';
UPDATE core.cost_centers SET hod_user_id = '33333333-3333-3333-3333-333333333323' WHERE code = 'PKB-LHR-002';
UPDATE core.cost_centers SET hod_user_id = '33333333-3333-3333-3333-333333333324' WHERE code = 'PKB-LHR-003';
UPDATE core.cost_centers SET hod_user_id = '33333333-3333-3333-3333-333333333322' WHERE code = 'PKB-LHR-004';
UPDATE core.cost_centers SET hod_user_id = '33333333-3333-3333-3333-333333333325' WHERE code = 'PKB-LHR-005';

UPDATE core.cost_centers SET cost_center_owner_user_id = '33333333-3333-3333-3333-333333333305'
 WHERE code = 'PKB-LHR-001';

-- Each head of department is IN that department. Derived from the department's
-- own hod_user_id rather than hard-coded, so the two can never drift, and so
-- re-pointing a department at a different head moves the head's department
-- with it.
--
-- This has to be explicit: migration 046 backfilled core.users.department_id
-- from cost centres at migration time, which is BEFORE these four heads exist.
-- Leaving it to the backfill would give them a NULL department, and a NULL
-- department matches no uuid in the RLS policy - an HOD with a NULL department
-- can see nothing at all, which looks exactly like "approvals are broken".
UPDATE core.users u
   SET department_id = d.id
  FROM core.departments d
 WHERE d.hod_user_id = u.id
   AND u.department_id IS DISTINCT FROM d.id;

-- Any PR row already tagged with a head of department is re-pointed at the
-- resolved HOD for its OWN department. Runs under the migration's
-- app.dept_approver_override exemption, because correcting a bad tag is
-- precisely the write the gate is designed to refuse.
SET LOCAL app.dept_approver_override = 'on';
UPDATE proc.pr_departments pd
   SET hod_user_id = core.fn_resolve_department_hod(pd.department_id)
 WHERE pd.hod_user_id IS DISTINCT FROM core.fn_resolve_department_hod(pd.department_id);

-- ─── Vendors ───────────────────────────────────────────────────────────────────
-- The vendor pool is DEMO/REFERENCE data, so it lives in the seed and NOT in a
-- migration: these rows carry created_by_user_id -> core.users(id), and
-- migrations run BEFORE this seed, so a migration inserting them fails its own
-- FK. The seed is idempotent, so re-running db/scripts/seed.ps1 on an existing
-- database picks up any vendors added here.
--
-- V-00081..83 are the original three. rfqIssue() issues to THREE vendors, and
-- V-00083 is both DD_In_Progress and blacklisted, which left the eligible
-- invitation pool at 2 — too short to exercise the prototype's own 3-quote
-- competition. V-00084/85 restore a pool of 4. Their names are the prototype's
-- own RFQ vendors (rfqIssue(): KarachiTech Supplies, Indus Office Solutions),
-- so the demo roster matches the prototype rather than merely counting right.
INSERT INTO core.vendors (id, vendor_code, legal_name, ntn, strn, state, created_by_user_id, approved_by_user_id, approved_at) VALUES
  ('44444444-4444-4444-4444-444444444401', 'V-00081', 'Acme Supplies (Pvt) Ltd',   '1234567-8', '3214567-8', 'Active',           '33333333-3333-3333-3333-33333333330d','33333333-3333-3333-3333-33333333330d', now()),
  ('44444444-4444-4444-4444-444444444402', 'V-00082', 'BoxCo Packaging Ltd',       '2345678-9', '4321567-8', 'Active',           '33333333-3333-3333-3333-33333333330d','33333333-3333-3333-3333-33333333330d', now()),
  ('44444444-4444-4444-4444-444444444403', 'V-00083', 'Delta Office Furnishers',   '3456789-0', '5432167-8', 'DD_In_Progress',   '33333333-3333-3333-3333-33333333330d', NULL, NULL),
  ('44444444-4444-4444-4444-444444444404', 'V-00084', 'KarachiTech Supplies',      '4567890-1', '6543217-8', 'Active',           '33333333-3333-3333-3333-33333333330d','33333333-3333-3333-3333-33333333330d', now()),
  ('44444444-4444-4444-4444-444444444405', 'V-00085', 'Indus Office Solutions',    '5678901-2', '7654321-8', 'Active',           '33333333-3333-3333-3333-33333333330d','33333333-3333-3333-3333-33333333330d', now()),
  -- V-00086 is mid-onboarding and NOT blacklisted: the one vendor in the seed
  -- that is legitimately off the approved roster but still invitable. It exists
  -- so decision Q3 — a new vendor is invited and badged "Pending approval",
  -- never blocked — has something real to act on. (V-00083 cannot serve that
  -- role: it is blacklisted, and a blacklisted vendor must never be invited.)
  ('44444444-4444-4444-4444-444444444406', 'V-00086', 'Crescent Tech Traders',     '6789012-3', '8765432-1', 'Manager_Approved','33333333-3333-3333-3333-33333333330d', NULL, NULL)
ON CONFLICT (vendor_code) DO NOTHING;

-- ── Supplier logins (must come AFTER the vendors block) ─────────────────────
-- Wave 4 / migration 028. These two rows are role='vendor' and therefore
-- require core.users.vendor_id — check ck_users_vendor_role. Their vendor rows
-- are created immediately above, and those rows in turn require a core.users
-- row (created_by_user_id -> core.users(id)), which is why the supplier
-- logins could not simply move back up into the main users insert.
--
-- The link is by vendor_code, the stable business key, rather than a raw uuid:
-- if a vendor row is ever renamed or re-id'd the key still resolves, and if it
-- is missing the NOT NULL on vendor_id fails loudly instead of silently
-- creating another unlinked supplier.
INSERT INTO core.users (id, email, display_name, role, cost_center_ids, mfa_enabled, vendor_id) VALUES
  ('33333333-3333-3333-3333-33333333330e', 'vendor1@example.com', 'Acme Supplies',   'vendor', '{}'::uuid[], false, (SELECT id FROM core.vendors WHERE vendor_code = 'V-00081')),
  ('33333333-3333-3333-3333-33333333330f', 'vendor2@example.com', 'BoxCo Packaging', 'vendor', '{}'::uuid[], false, (SELECT id FROM core.vendors WHERE vendor_code = 'V-00082'))
ON CONFLICT (email) DO NOTHING;

-- Belt and braces for an EXISTING database seeded before migration 028: the
-- migration backfills vendor_id by display_name/prefix match, but a database
-- that skipped it (or whose vendor login was added by hand) would otherwise
-- keep an unlinked supplier. Only rows that are currently unlinked are
-- touched, and only for a role that the CHECK would already have rejected.
UPDATE core.users u
   SET vendor_id = v.id
  FROM core.vendors v
 WHERE u.role = 'vendor'
   AND u.vendor_id IS NULL
   AND left(v.legal_name, length(u.display_name)) = u.display_name;

INSERT INTO core.vendor_blacklist (vendor_id, reason, flagged_by_user_id)
SELECT id, 'Sample blacklist row for demo', '33333333-3333-3333-3333-33333333330d'
FROM core.vendors
WHERE vendor_code = 'V-00083'
ON CONFLICT DO NOTHING;

-- ─── Items ─────────────────────────────────────────────────────────────────────
INSERT INTO core.items (id, item_code, name, category, uom, gl_account, expense_type, asset_category, lead_time_days) VALUES
  ('55555555-5555-5555-5555-555555555501', 'PKB-CS-001', 'Cardboard Sheet (large)',     'WAREHOUSE_ACCESSORY', 'sheet', '6-04-001', 'OPEX',  NULL,             5),
  ('55555555-5555-5555-5555-555555555502', 'PKB-CS-002', 'Cardboard Sheet (small)',     'WAREHOUSE_ACCESSORY', 'sheet', '6-04-001', 'OPEX',  NULL,             5),
  ('55555555-5555-5555-5555-555555555503', 'PKB-LT-001', 'Dell Latitude 5550 Laptop',   'IT_HARDWARE',         'unit',  '1-06-002', 'CAPEX', 'Plant & Machinery', 14),
  ('55555555-5555-5555-5555-555555555504', 'PKB-MO-001', 'Logitech MX Master Mouse',    'IT_HARDWARE',         'unit',  '1-06-002', 'CAPEX', 'Plant & Machinery', 14),
  ('55555555-5555-5555-5555-555555555505', 'PKB-PEN-001','Ballpoint Pen (Box of 50)',  'OFFICE_SUPPLIES',     'box',   '6-04-002', 'OPEX',  NULL,             3),
  -- Category is 'PROFESSIONAL_SERVICES', not 'SERVICES'. The workflow engine
  -- and core.categories (migration 047) both use that name, and a line tagged
  -- 'SERVICES' matched no routing rule at all. Migration 047 section 3 applies
  -- the same correction to an existing database, so seed and migration cannot
  -- disagree.
  ('55555555-5555-5555-5555-555555555506', 'PKB-SRV-001','Annual Maintenance Contract', 'PROFESSIONAL_SERVICES', 'lot', '6-05-001', 'OPEX', NULL, 30)
ON CONFLICT (item_code) DO NOTHING;

-- Preferred vendors
UPDATE core.items SET preferred_vendor_id = '44444444-4444-4444-4444-444444444401' WHERE item_code IN ('PKB-CS-001','PKB-CS-002');
UPDATE core.items SET preferred_vendor_id = '44444444-4444-4444-4444-444444444402' WHERE item_code IN ('PKB-LT-001','PKB-MO-001');
UPDATE core.items SET preferred_vendor_id = '44444444-4444-4444-4444-444444444402' WHERE item_code IN ('PKB-PEN-001','PKB-SRV-001');

-- ─── Budgets (current FY for PKB-LHR-001) ──────────────────────────────────────
INSERT INTO core.budgets (id, fiscal_year, department_id, cost_center_id, project_id, expense_type, allocated_amount)
VALUES
  ('66666666-6666-6666-6666-666666666601', 2026, '00000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', NULL, 'CAPEX', 5000000.00),
  ('66666666-6666-6666-6666-666666666602', 2026, '00000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', NULL, 'OPEX',  2000000.00)
ON CONFLICT DO NOTHING;

-- ─── Demo PR (Submitted, waiting on HOD) ───────────────────────────────────────
DO $$
DECLARE
  v_pr_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM proc.purchase_requisitions WHERE scope = 'Demo PR — Cardboard restock') THEN
    v_pr_id := gen_random_uuid();
    INSERT INTO proc.purchase_requisitions (
      id, pr_number,
      requester_user_id, department_id, cost_center_id, project_id,
      expense_type, required_by_date, status, routing_key,
      scope, estimated_amount, currency
    ) VALUES (
      v_pr_id, proc.fn_next_pr_number(),
      '33333333-3333-3333-3333-333333333301', '00000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', NULL,
      'OPEX', current_date + 14, 'Submitted', 'STANDARD',
      'Demo PR — Cardboard restock', 140000, 'PKR'
    );

    -- uom must be a core.uom code: migration 034 put a foreign key on
    -- proc.pr_lines.uom and migration 031 normalised the vocabulary to
    -- upper-case codes. The legacy literal 'sheet' no longer exists, and
    -- PrService.resolveUoms() upper-cases before it looks the value up, so
    -- 'sheet' would have been rejected there too. PCS is the code for
    -- countable sheets; core.items.uom keeps its own legacy display value and
    -- carries no such foreign key.
    INSERT INTO proc.pr_lines (pr_id, line_no, item_id, quantity, uom, unit_price_est, gl_account, description)
    VALUES
      (v_pr_id, 1, '55555555-5555-5555-5555-555555555501', 200, 'PCS', 500.00, '6-04-001', 'Cardboard Sheet (large)'),
      (v_pr_id, 2, '55555555-5555-5555-5555-555555555502', 200, 'PCS', 200.00, '6-04-001', 'Cardboard Sheet (small)');

    PERFORM proc.fn_compute_pr_totals(v_pr_id);
  END IF;
END$$;

COMMIT;
