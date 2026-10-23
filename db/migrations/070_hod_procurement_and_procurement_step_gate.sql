-- ═══════════════════════════════════════════════════════════════════════════
-- 070 — HOD Procurement, and the classification gate on the DIRECT step.
--
-- WHAT WAS ACTUALLY TRUE BEFORE THIS MIGRATION
-- --------------------------------------------
-- Two things, and only one of them was a bug in the routing table.
--
--   1. There was no Procurement department. core.departments held FIN, HR, IT,
--      OPS and SALES — five heads, no procurement desk, because Procurement
--      was modelled as a functional role (`procurement@`) with no
--      department_id at all. Every other department in the company operates
--      under a head; Procurement was the exception, and the exception was
--      invisible because `procurement_manager` existed as a role name that
--      NOTHING was assigned.
--
--   2. So `cs_review` was owned by a role no user holds (measured: 0 rows in
--      core.users), and the D365 push / PO / vendor-sync gates listed it too.
--      A role nobody holds is a gate nobody can pass: the control is present,
--      legible, and inoperable. Which is worse than absent, because it reads as
--      protection.
--
-- THE DECISION THIS RECORDS
-- -------------------------
-- Procurement follows the SAME HOD hierarchy as every other department, so
-- there is no "manager" role. The head of Procurement is a user whose role is
-- `hod` — the identical role string all five existing heads carry — and whose
-- IDENTITY is recorded on the department's own row:
--
--     core.departments.code = 'PROC'  ->  core.departments.hod_user_id
--
-- The identity, not the role, is what identifies them. That distinction is the
-- whole point: `roleAllowed('hod', 'hod')` is true for the Head of Finance, the
-- Head of HR and the Head of Operations as well, so a role check here would
-- hand the Procurement sign-off to four people who do not run procurement. The
-- database can also refuse such a row — `proc.fn_pr_departments_approver_gate`
-- already enforces the same rule for an originating department's approver —
-- so this is the pattern the codebase already trusts, not a new convention.
--
-- The second half of this migration closes the Step 4 -> Step 6 bypass found in
-- the audit: the `procurement` step was `when: always`, from
-- IN_PROCUREMENT_REVIEW to IN_COST_CENTER_APPROVAL, with no
-- requiresCapexOpex. A request whose lines already carried the requester's
-- estimate could therefore reach the cost centre with no comparative
-- statement, no award and no Capex/Opex class. The cost gate caught only the
-- UNPRICED case. Both steps that leave procurement review now demand a
-- classification, so there is no route out of Step 4 into Step 6 that does not.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── A. the department ──────────────────────────────────────────────────────
-- Idempotent by WHERE NOT EXISTS rather than ON CONFLICT, because the runner
-- replays the whole chain and a replay must be a no-op, not an error.
INSERT INTO core.departments (id, code, name, hod_user_id, active, created_at, updated_at)
SELECT '00000000-0000-0000-0000-000000000006', 'PROC', 'Procurement', NULL, true, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM core.departments WHERE code = 'PROC');

-- ── B. a cost centre it owns ───────────────────────────────────────────────
-- Not optional. core.fn_users_department_consistency_gate (migration 046)
-- REFUSES a user whose department owns none of their cost centres, so without
-- this the head below cannot be inserted at all. That trigger is the reason
-- this is a department + cost centre + user and not just a user row.
INSERT INTO core.cost_centers (id, code, name, department_id, hod_user_id, active, created_at, updated_at)
SELECT '11111111-1111-1111-1111-111111111116', 'PKB-LHR-006', 'Lahore Procurement',
       d.id, NULL, true, now(), now()
  FROM core.departments d
 WHERE d.code = 'PROC'
   AND NOT EXISTS (SELECT 1 FROM core.cost_centers WHERE code = 'PKB-LHR-006');

-- ── C. the head of Procurement ─────────────────────────────────────────────
-- role = 'hod' deliberately: identical to hod.sales / hod.hr / hod.it /
-- hod.finance / hod.operations. There is no procurement-specific role string,
-- because the org chart does not have one.
INSERT INTO core.users
  (id, email, display_name, role, cost_center_ids, mfa_enabled, active, department_id, created_at, updated_at)
SELECT '33333333-3333-3333-3333-333333333326', 'hod.procurement@pakboxes.pk', 'Nadia Farooq', 'hod',
       ARRAY['11111111-1111-1111-1111-111111111116']::uuid[], false, true, d.id, now(), now()
  FROM core.departments d
 WHERE d.code = 'PROC'
   AND NOT EXISTS (SELECT 1 FROM core.users WHERE email = 'hod.procurement@pakboxes.pk');

-- ── D. the two-way mapping ─────────────────────────────────────────────────
-- Written both ways, exactly as the other five heads are: the department names
-- its head, and the head belongs to the department. Anything that resolves
-- "who is the HOD of X" (the blind reviewer already does) therefore finds them
-- with the same query it uses for every other department.
UPDATE core.departments d
   SET hod_user_id = u.id,
       updated_at = now()
  FROM core.users u
 WHERE d.code = 'PROC'
   AND u.email = 'hod.procurement@pakboxes.pk'
   AND d.hod_user_id IS DISTINCT FROM u.id;

UPDATE core.cost_centers cc
   SET hod_user_id = u.id,
       updated_at = now()
  FROM core.users u
 WHERE cc.code = 'PKB-LHR-006'
   AND u.email = 'hod.procurement@pakboxes.pk'
   AND cc.hod_user_id IS DISTINCT FROM u.id;

UPDATE core.users u
   SET department_id = d.id,
       updated_at = now()
  FROM core.departments d
 WHERE u.email = 'hod.procurement@pakboxes.pk'
   AND d.code = 'PROC'
   AND u.department_id IS DISTINCT FROM d.id;

-- ── E. the routing table ───────────────────────────────────────────────────
-- cs_review: `procurement_manager` -> `hod`. The step's actorRole is the role
-- vocabulary the ADMIN EDITOR validates against and the engine reports, so the
-- string has to be one the identity model actually has; `hod` is it. The
-- department scoping lives in the service, because a step row cannot express
-- "the head of department X" any more than a role string can.
UPDATE workflow.steps_config
   SET payload = jsonb_set(
         jsonb_set(payload, '{actorRole}', to_jsonb('hod'::text), true),
         '{requiresCapexOpex}', to_jsonb(true), true),
       updated_at = now()
 WHERE id = 'cs_review'
   AND (payload ->> 'actorRole' IS DISTINCT FROM 'hod'
        OR (payload ->> 'requiresCapexOpex')::boolean IS DISTINCT FROM true);

-- procurement: the SECOND door out of Step 4, and the one that was open.
-- `when: always`, IN_PROCUREMENT_REVIEW -> IN_COST_CENTER_APPROVAL, no
-- classification gate — so the gate on cs_review protected only the requests
-- that went through the comparative statement.
UPDATE workflow.steps_config
   SET payload = jsonb_set(payload, '{requiresCapexOpex}', to_jsonb(true), true),
       updated_at = now()
 WHERE id = 'procurement'
   AND (payload ->> 'requiresCapexOpex')::boolean IS DISTINCT FROM true;

-- ── F. the dead role string ────────────────────────────────────────────────
-- The 250k-1M band is INACTIVE, so removing the string changes no routing. It
-- is removed because an inactive band naming a role that cannot be assigned
-- still reads on the screen as "procurement_manager may approve 250k-1M".
--
-- DELETE, not UPDATE — and that is not a style choice. Removing the role makes
-- this row byte-identical to a band that ALREADY EXISTS
-- (250000, 1000000, NULL, {hod,cost_center_owner,finance}, 2026-01-01), and
-- authority_matrix is UNIQUE over exactly those columns, so an UPDATE died with
-- "Key (amount_min, amount_max, category, required_roles, effective_from)
-- already exists" the first time this migration was replayed. The row was
-- always redundant with one that exists; removing the role makes that fact
-- visible to the index rather than hiding it.
--
-- Deleting duplicates FIRST and then updating whatever is left means both
-- shapes are handled, and neither depends on which one this database has.
DELETE FROM core.authority_matrix m
 WHERE 'procurement_manager' = ANY (m.required_roles)
   AND EXISTS (
     SELECT 1 FROM core.authority_matrix d
      WHERE d.id <> m.id
        AND d.amount_min = m.amount_min
        AND d.amount_max = m.amount_max
        AND d.category IS NOT DISTINCT FROM m.category
        AND d.required_roles = array_remove(m.required_roles, 'procurement_manager')
        AND d.effective_from = m.effective_from
   );

-- Any band that does NOT collide with an existing one is updated in place.
UPDATE core.authority_matrix
   SET required_roles = array_remove(required_roles, 'procurement_manager')
 WHERE 'procurement_manager' = ANY (required_roles);

-- ── post-condition ─────────────────────────────────────────────────────────
-- Every claim above is proven by a SELECT, not by the absence of an error.
DO $$
DECLARE
  missing text;
  step_ok boolean;
  holders int;
  stranded_steps int;
  bands int;
BEGIN
  -- The department, the cost centre, the head, and the two-way mapping.
  IF NOT EXISTS (SELECT 1 FROM core.departments WHERE code = 'PROC' AND active) THEN
    RAISE EXCEPTION 'migration 070: the PROC department is missing or inactive';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM core.departments d
      JOIN core.users u ON u.id = d.hod_user_id
      JOIN core.cost_centers cc ON cc.department_id = d.id
                           AND cc.hod_user_id = u.id
     WHERE d.code = 'PROC'
       AND u.email = 'hod.procurement@pakboxes.pk'
       AND u.role = 'hod'
       AND u.active
       AND u.department_id = d.id
       AND u.cost_center_ids @> ARRAY[cc.id]::uuid[]
  ) THEN
    RAISE EXCEPTION
      'migration 070: HOD Procurement is not wired both ways — the department must name the head, '
      'the head must belong to the department, and both must hold the Procurement cost centre';
  END IF;

  -- The role nobody holds must not be what owns a step.
  SELECT count(*) INTO holders FROM core.users WHERE role = 'procurement_manager';
  IF holders > 0 THEN
    RAISE EXCEPTION 'migration 070: % user(s) still hold procurement_manager', holders;
  END IF;

  SELECT count(*) INTO stranded_steps
    FROM workflow.steps_config
   WHERE payload ->> 'actorRole' = 'procurement_manager';
  IF stranded_steps > 0 THEN
    RAISE EXCEPTION
      'migration 070: % step(s) still name procurement_manager as their actor', stranded_steps;
  END IF;

  SELECT count(*) INTO bands
    FROM core.authority_matrix
   WHERE 'procurement_manager' = ANY (required_roles);
  IF bands > 0 THEN
    RAISE EXCEPTION 'migration 070: % authority band(s) still require procurement_manager', bands;
  END IF;

  -- Both doors out of Step 4 must demand a classification. Asserted as the
  -- pair, because asserting either one alone is what let the other stay open.
  SELECT bool_and((payload ->> 'requiresCapexOpex')::boolean) INTO step_ok
    FROM workflow.steps_config
   WHERE id IN ('cs_review', 'procurement')
     AND payload ->> 'from' = 'IN_PROCUREMENT_REVIEW';

  IF step_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'migration 070: both cs_review and procurement must carry requiresCapexOpex and leave '
      'IN_PROCUREMENT_REVIEW, or a request can still reach cost approval unclassified';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM workflow.steps_config WHERE id = 'cs_review' AND payload ->> 'actorRole' = 'hod'
  ) THEN
    RAISE EXCEPTION 'migration 070: cs_review is not owned by the HOD';
  END IF;

  RAISE NOTICE
    'migration 070 ok: HOD Procurement mapped both ways, procurement_manager retired, '
    'both routes out of IN_PROCUREMENT_REVIEW now demand a classification';
END $$;

COMMIT;