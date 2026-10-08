-- ─────────────────────────────────────────────────────────────────────────────
-- 046 - A user has a department; an approver is resolved, not chosen; and an
--       unknown price is a real state rather than a fabricated zero.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHAT WAS ACTUALLY TRUE BEFORE THIS MIGRATION
-- --------------------------------------------
-- A purchase requisition could not be routed to the HOD of the department that
-- asked for it, and nobody could tell you why. Four separate facts combined:
--
--   1. core.users HAD NO department_id. A person's department was only
--      inferrable by walking core.users.cost_center_ids ->
--      core.cost_centers.department_id. That path is a COST ALLOCATION
--      mapping, not an org chart, and it silently produced the wrong answer:
--      the demo requester Aisha Khan was mapped to "Lahore Sales", so the
--      requester-scoped department lookup in PrService resolved her to SALES.
--
--   2. There was exactly ONE hod user in the entire system
--      (hod.sales@pakboxes.pk) and only core.departments.SALES had a
--      hod_user_id. HR, IT, FIN and OPS were all NULL. "Route to the HOD of
--      HR" was therefore not a mis-routing bug - it was impossible. The PR
--      for the HR laptop landed in proc.pr_departments with
--      hod_user_id = NULL and routed to NOBODY.
--
--   3. The approver was whatever the browser sent. CreatePrDto accepted a
--      client-supplied hodUserId and PrService.create() wrote it straight into
--      proc.pr_departments with no check that the person was the HOD of that
--      department. Picking the wrong department head was one field away, and
--      the database could not object.
--
--   4. The amount was a GUESS. The create screen derived a unit price from
--      the item's expense_type (CAPEX -> 50000, OPEX -> 1000) and
--      proc.purchase_requisitions.estimated_amount was NOT NULL, so "we do
--      not know the price yet" was not representable. The result: a laptop
--      request with no known price was recorded as a confident PKR 50,000,
--      and because the workflow's amountOf() reads `estimatedAmount ?? 0`, an
--      unknown price of 0 SATISFIED `belowMgtThreshold` and would have let a
--      real capital request skip the management gate entirely.
--
-- SO THIS MIGRATION DOES FIVE THINGS
-- ---------------------------------
--   A. core.users.department_id - the person's own department, backfilled.
--   B. A resolver + a guard, so a PR's approver can only ever be the HOD of
--      the PR's department. Enforced by the database, not by the caller.
--   C. amount_status, so "amount not yet known" is a first-class state that
--      no threshold gate can mistake for "cheap".
--   D. Row-level security that scopes a requester to their own rows and an
--      HOD to their own DEPARTMENT (it was cost-centre scoped).
--   E. app.user_department_id, the session variable RLS reads.
--
-- MIGRATION/SEED EXEMPTION
-- ------------------------
-- The guard in section B refuses a hand-picked approver. Backfills and seeds
-- legitimately need to write one, so they declare themselves with
--   SET LOCAL app.dept_approver_override = 'on';
-- exactly like Rule 5's app.vendor_change_token. Migrations run one psql
-- session each, so a GUC set at the top of the file covers the whole file.
-- The API never sets it.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

SET LOCAL search_path = core, proc, public;
SET LOCAL app.dept_approver_override = 'on';

-- ─── A. core.users.department_id ─────────────────────────────────────────────
-- The authoritative "which department is this person in". Deliberately NOT
-- derived on read: a person belongs to a department, and reading that back
-- through a cost centre makes a cost re-mapping silently re-home them.
ALTER TABLE core.users ADD COLUMN IF NOT EXISTS department_id uuid REFERENCES core.departments(id);

CREATE INDEX IF NOT EXISTS idx_users_department ON core.users(department_id);

-- Backfill ONLY where the answer is unambiguous: a user whose cost centres
-- resolve to exactly one department. A user spanning two departments (the
-- procurement / cs / finance accounts all hold all five) is left NULL on
-- purpose - picking the first one alphabetically would be a guess, and a
-- guessed department is how HOD Sales ends up on an HR request. Those users
-- are org-wide by role and are handled by the admin role branch in RLS, so a
-- NULL department costs them nothing.
--
-- Also exclude the vendor/public rows, whose cost centre array is empty.
UPDATE core.users u
   SET department_id = sub.department_id
  FROM (
    SELECT u2.id, min(cc.department_id::text)::uuid AS department_id
      FROM core.users u2
      JOIN core.cost_centers cc ON cc.id = ANY (u2.cost_center_ids)
     GROUP BY u2.id
    HAVING count(DISTINCT cc.department_id) = 1
  ) sub
 WHERE sub.id = u.id
   AND u.department_id IS DISTINCT FROM sub.department_id;

-- A user's department must actually own at least one of their cost centres.
-- A user with no cost centre at all (MC members, admin) is exempt: they are
-- not department-scoped. Without this, setting department_id = HR on someone
-- whose only cost centre is Lahore Sales would be accepted, and the mismatch
-- would only surface later as a mis-routed approval.
CREATE OR REPLACE FUNCTION core.fn_users_department_consistency_gate()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owned integer;
BEGIN
  IF NEW.department_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO owned
    FROM core.cost_centers cc
   WHERE cc.id = ANY (NEW.cost_center_ids)
     AND cc.department_id = NEW.department_id;

  IF owned = 0 THEN
    RAISE EXCEPTION
      'user % has department % but none of its cost centres belong to that department',
      COALESCE(NEW.email, NEW.id::text), NEW.department_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_department_consistency ON core.users;
CREATE TRIGGER trg_users_department_consistency
  BEFORE INSERT OR UPDATE OF department_id, cost_center_ids ON core.users
  FOR EACH ROW EXECUTE FUNCTION core.fn_users_department_consistency_gate();

-- ─── B. The approver is resolved, never chosen ───────────────────────────────

-- Single source of truth for "who approves for department X": the department's
-- own hod_user_id. Nothing else - not the browser, not a cost centre owner,
-- not a previously tagged approver - is allowed to decide this.
CREATE OR REPLACE FUNCTION core.fn_resolve_department_hod(p_department_id uuid)
RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT d.hod_user_id
    FROM core.departments d
   WHERE d.id = p_department_id
     AND d.active;
$$;

COMMENT ON FUNCTION core.fn_resolve_department_hod(uuid) IS
  'The HOD of a department, or NULL when the department has no active HOD. The only sanctioned source for proc.pr_departments.hod_user_id.';

-- Refuse any approver who is not the HOD of the department on that same row.
-- This is the hard guarantee behind "an HR request must never route to the HOD
-- of Sales": it is not a rule the API follows, it is a rule the database
-- enforces, so a future service, a script, or psql cannot route around it.
CREATE OR REPLACE FUNCTION proc.fn_pr_departments_approver_gate()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected uuid;
  actual_dept text;
  expected_dept text;
BEGIN
  IF NEW.hod_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NULLIF(current_setting('app.dept_approver_override', true), ''), 'off')
     NOT IN ('on', 'true') THEN
    expected := core.fn_resolve_department_hod(NEW.department_id);

    IF expected IS DISTINCT FROM NEW.hod_user_id THEN
      SELECT code INTO actual_dept   FROM core.departments WHERE id = NEW.department_id;
      SELECT code INTO expected_dept FROM core.departments WHERE id = expected;

      RAISE EXCEPTION
        'refusing to route PR % to user % : that user is not the HOD of department % (expected the HOD of %)',
        NEW.pr_id, NEW.hod_user_id, COALESCE(actual_dept, '?'),
        COALESCE(expected_dept, 'a department with no assigned HOD')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pr_departments_approver_gate ON proc.pr_departments;
CREATE TRIGGER trg_pr_departments_approver_gate
  BEFORE INSERT OR UPDATE OF department_id, hod_user_id ON proc.pr_departments
  FOR EACH ROW EXECUTE FUNCTION proc.fn_pr_departments_approver_gate();

-- Backfill: existing PR rows tagged with someone who is no longer (or never
-- was) that department's HOD get corrected to the resolved HOD, or to NULL
-- when the department has no HOD. An untagged row is NOT a licence to pick a
-- stranger, so this only ever moves a row TO the department's real HOD.
UPDATE proc.pr_departments pd
   SET hod_user_id = core.fn_resolve_department_hod(pd.department_id)
 WHERE pd.hod_user_id IS DISTINCT FROM core.fn_resolve_department_hod(pd.department_id);

-- ─── C. An amount that is not yet known ──────────────────────────────────────

ALTER TABLE proc.purchase_requisitions
  ADD COLUMN IF NOT EXISTS amount_status text NOT NULL DEFAULT 'ESTIMATED';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'proc.purchase_requisitions'::regclass
       AND conname  = 'purchase_requisitions_amount_status_check'
  ) THEN
    ALTER TABLE proc.purchase_requisitions
      ADD CONSTRAINT purchase_requisitions_amount_status_check
      CHECK (amount_status IN ('ESTIMATED','UNKNOWN'));
  END IF;
END;
$$;

-- estimated_amount stays NOT NULL. 145 call sites across the API, the D365
-- push, pack lock and the RFQ comparison all read it, and the money-sensitive
-- downstream stages (D365 push, pack lock) have no business running against a
-- NULL. What changes is that a 0 no longer LIES: it is only ever 0 when
-- amount_status says the amount is still unknown, and every surface reads that
-- flag. NULL would have been the more expressive choice and the more dangerous
-- one, because arithmetic on NULL silently yields NULL and a NULL would flow
-- into a D365 payload as a missing field.
--
-- Any pre-existing row whose amount is exactly 0 is, by definition, a row
-- where nobody entered a price. Mark it rather than leave it ambiguous.
UPDATE proc.purchase_requisitions
   SET amount_status = 'UNKNOWN'
 WHERE estimated_amount = 0
   AND amount_status   = 'ESTIMATED';

-- A line may genuinely have no price yet. The CHECK (>= 0) already admits
-- NULL, so only the NOT NULL has to go.
ALTER TABLE proc.pr_lines ALTER COLUMN unit_price_est DROP NOT NULL;

-- Keep the pair honest: UNKNOWN means no line carried a price.
ALTER TABLE proc.purchase_requisitions DROP CONSTRAINT IF EXISTS prs_amount_status_coherent;
ALTER TABLE proc.purchase_requisitions
  ADD CONSTRAINT prs_amount_status_coherent
  CHECK (amount_status <> 'UNKNOWN' OR COALESCE(estimated_amount, 0) = 0);

-- proc.fn_compute_pr_totals() is what recomputes the amount from the lines, so
-- it is the one place that has to maintain amount_status too. It is defined in
-- migration 006 and only the seed calls it today — but the moment a quote comes
-- back and something calls it, a stale amount_status would trip the CHECK above
-- and refuse the price confirmation. The function that computes the amount must
-- also record whether there was one.
--
-- COALESCE(SUM(...), 0) already turns "every line has a NULL price" into 0, so
-- the arithmetic was never the problem; only the flag was missing.
CREATE OR REPLACE FUNCTION proc.fn_compute_pr_totals(p_pr_id uuid)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_capex numeric(18,2);
  v_opex  numeric(18,2);
  v_expense_type text;
  v_amount_status text;
  v_has_capex boolean;
  v_has_opex boolean;
BEGIN
  SELECT
    COALESCE(SUM(CASE WHEN i.expense_type = 'CAPEX' THEN l.quantity * l.unit_price_est ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN i.expense_type = 'OPEX'  THEN l.quantity * l.unit_price_est ELSE 0 END), 0),
    -- 'UNKNOWN' while no line carries a price. An explicit 0 stays 'ESTIMATED':
    -- a requester can genuinely mean free, and that is an answer, not a silence.
    CASE WHEN count(*) FILTER (WHERE l.unit_price_est IS NULL) = count(*) THEN 'UNKNOWN'
         ELSE 'ESTIMATED' END,
    bool_or(i.expense_type = 'CAPEX'),
    bool_or(i.expense_type = 'OPEX')
  INTO v_capex, v_opex, v_amount_status, v_has_capex, v_has_opex
    FROM proc.pr_lines l
    JOIN core.items i ON i.id = l.item_id
   WHERE l.pr_id = p_pr_id;

  -- expense_type follows the ITEMS, not the amounts.
  --
  -- It used to be derived from the totals (`if v_capex > 0 and v_opex > 0`),
  -- which silently reclassifies every UNPRICED line as OPEX: with no price both
  -- totals are 0, the first two tests fail, and a Dell Latitude laptop became an
  -- operating expense. Capex/Opex is a property of what is being bought, and
  -- core.items.expense_type says so without needing a price. The amounts cannot
  -- tell you the classification; they can only tell you how much of each there
  -- is, which is a different question.
  IF v_has_capex AND v_has_opex THEN
    v_expense_type := 'MIXED';
  ELSIF v_has_capex THEN
    v_expense_type := 'CAPEX';
  ELSE
    v_expense_type := 'OPEX';
  END IF;

  UPDATE proc.purchase_requisitions
     SET capex_amount     = v_capex,
         opex_amount      = v_opex,
         estimated_amount = v_capex + v_opex,
         amount_status    = v_amount_status,
         expense_type     = v_expense_type,
         last_updated_at  = now()
   WHERE id = p_pr_id;
END;
$$;

-- ─── D. RLS: requester = own rows, HOD = own DEPARTMENT ──────────────────────

-- Read the session's department. Empty string when the session is anonymous or
-- the user has no department, which compares false against every uuid and so
-- grants nothing - the correct default.
CREATE OR REPLACE FUNCTION core.fn_current_user_department_id()
RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_department_id', true), '')::uuid;
$$;

-- The roles that legitimately see every procurement record. Deliberately
-- separate from the HOD/requester branches: a head of department is scoped,
-- an auditor or procurement officer is not.
--
-- This is the EXACT set the previous policy granted. Narrowing it was not part
-- of this task, and widening it would be a silent privilege grant: management,
-- store_incharge and department_manager deliberately stay out and remain
-- subject to whatever scoping they already had.
CREATE OR REPLACE FUNCTION core.fn_role_sees_all_procurement()
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(core.fn_current_user_role(), '') = ANY (
    ARRAY['admin','procurement','procurement_manager','cs','finance','cfo',
          'mc','audit','hr']
  );
$$;

DROP POLICY IF EXISTS prs_visibility ON proc.purchase_requisitions;
CREATE POLICY prs_visibility ON proc.purchase_requisitions
  FOR SELECT
  USING (
    core.fn_bypass_rls()
    -- Requesters see their OWN submissions and nothing else. This used to also
    -- grant "every PR in one of my cost centres", which is a cost-allocation
    -- scope leaking procurement data sideways: a requester holding Lahore Sales
    -- could read every other person's Sales requisition.
    OR (requester_user_id = core.fn_current_user_id())
    -- HODs see their own DEPARTMENT, not a cost-centre approximation of it. A
    -- department with two cost centres, or an HOD whose account carries the
    -- wrong one, was previously invisible to the person who has to approve.
    OR (core.fn_current_user_role() = 'hod'
        AND department_id = core.fn_current_user_department_id())
    OR core.fn_role_sees_all_procurement()
  );

-- ─── Why proc.pr_departments deliberately does NOT get RLS ───────────────────
-- A reader might expect the same scoping here, since it is a per-PR table. It
-- is left un-RLS'd on purpose, and the reason is structural:
--
--   * The approver gate in section B makes it IMPOSSIBLE for a row to name a
--     head of department from the wrong department. An HR PR row can only ever
--     carry HR's HOD, by database enforcement. So there is no cross-department
--     approver identity in this table to leak - the thing the scoping would
--     protect does not exist.
--   * The remaining columns are pr_id, department_id, hod_status and a
--     comment. No procurement content.
--   * Its only two call sites are the PR-detail SELECT (which must work for
--     the REQUESTER, who is not HOD and not in the org-wide role set) and the
--     create-time INSERT. Adding RLS here means writing a requester INSERT
--     policy and a requester-or-approver SELECT policy for a table that
--     protects nothing, on the requester's own submission path.
--
-- The procurement content itself is protected on proc.purchase_requisitions
-- above, which is the table that actually holds the records.

-- ─── E. The session variable ────────────────────────────────────────────────
-- Nothing to declare here: app.user_department_id is a GUC, and GUCs accept a
-- SET at any time. apps/api/src/db/db.service.ts resolves it per statement from
-- core.users, so the value can never drift from the row.

COMMIT;
