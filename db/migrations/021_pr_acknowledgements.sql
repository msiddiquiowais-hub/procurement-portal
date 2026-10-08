-- 021_pr_acknowledgements.sql
--
-- `acknowledge` screen (Wave 1). Port of the prototype's
-- `purchasePurpose.taggedApprovers[]` — a per-PR list of people who receive a
-- unique email deep link and record a fraud-control acknowledgement.
--
-- The prototype stores this on the PR object in localStorage; the application
-- has no column for it and no table models it, so this adds one.
--
-- Key semantics carried over from the prototype:
--   - The token is the credential. The recipient is NOT required to be logged
--     in, because the link is emailed. `POST /ack/:token/accept` is therefore
--     an unauthenticated endpoint guarded by token uniqueness.
--   - Acknowledgement is a SOFT GATE. It never blocks the workflow — the
--     prototype says so in the "Why am I being asked?" card and in the widget
--     copy. Nothing here participates in proc.fn_check_pr_transition().
--   - One row per (pr, email): re-tagging the same person is an upsert, not a
--     duplicate.

BEGIN;

-- ─── the table ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proc.pr_acknowledgements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_id             uuid NOT NULL REFERENCES proc.purchase_requisitions(id) ON DELETE CASCADE,
  tagged_role       text NOT NULL
                      CHECK (tagged_role IN (
                        'employee','dept_head','director',
                        'project_lead','requester_self','new_employee')),
  name              text NOT NULL,
  email             text NOT NULL,
  dept_code         text,
  -- Deep-link credential. `ack-<12 hex>`, matching the prototype's `#ack=` form.
  token             text NOT NULL UNIQUE
                      DEFAULT 'ack-' || encode(gen_random_bytes(6), 'hex'),
  acknowledged      boolean NOT NULL DEFAULT false,
  acknowledged_at   timestamptz,
  acknowledged_by   uuid REFERENCES core.users(id),
  ip                inet,
  user_agent        text,
  tagged_by         uuid REFERENCES core.users(id),
  tagged_at         timestamptz NOT NULL DEFAULT now(),
  -- Re-tagging the same person on the same PR updates rather than duplicates.
  CONSTRAINT pr_ack_unique_per_pr_email UNIQUE (pr_id, email),
  -- A row cannot be acknowledged without a timestamp, and cannot be
  -- acknowledged with one.
  CONSTRAINT pr_ack_ack_consistent CHECK (
    (acknowledged AND acknowledged_at IS NOT NULL) OR
    (NOT acknowledged AND acknowledged_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_pr_ack_pr      ON proc.pr_acknowledgements(pr_id, tagged_at);
CREATE INDEX IF NOT EXISTS idx_pr_ack_email   ON proc.pr_acknowledgements(email);
CREATE INDEX IF NOT EXISTS idx_pr_ack_pending ON proc.pr_acknowledgements(pr_id)
  WHERE NOT acknowledged;

COMMENT ON TABLE proc.pr_acknowledgements IS
  'Per-PR tagged acknowledgement recipients. Soft gate: recording an ack never blocks or alters the workflow; it is a fraud-control record only.';
COMMENT ON COLUMN proc.pr_acknowledgements.token IS
  'Deep-link credential for the emailed #ack=<token> URL. Treat as a secret: it authorises acceptance without authentication.';

-- ─── helpers ──────────────────────────────────────────────────────────────
-- Summary chip values, ported from the prototype's ackSummaryChip().
CREATE OR REPLACE FUNCTION proc.fn_ack_summary(p_pr_id uuid)
RETURNS TABLE (total int, pending int, acked int) AS $$
  SELECT count(*)::int,
         count(*) FILTER (WHERE NOT acknowledged)::int,
         count(*) FILTER (WHERE acknowledged)::int
    FROM proc.pr_acknowledgements
   WHERE pr_id = p_pr_id;
$$ LANGUAGE sql STABLE;

-- ─── RLS ──────────────────────────────────────────────────────────────────
-- Visibility mirrors proc.purchase_requisitions.prs_visibility: the requester
-- who raised the PR, anyone whose cost centre owns it, and the internal
-- oversight roles. The token in the URL is the public path; this policy
-- governs the authenticated views only.
ALTER TABLE proc.pr_acknowledgements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pr_ack_visibility ON proc.pr_acknowledgements;
CREATE POLICY pr_ack_visibility ON proc.pr_acknowledgements
  FOR SELECT USING (
    core.fn_bypass_rls()
    OR EXISTS (
      SELECT 1 FROM proc.purchase_requisitions pr
       WHERE pr.id = pr_acknowledgements.pr_id
         AND (
           pr.requester_user_id = core.fn_current_user_id()
           OR pr.cost_center_id = ANY (
                string_to_array(NULLIF(current_setting('app.user_cost_centers', true), ''), ',')::uuid[])
           OR core.fn_current_user_role() = ANY (
                ARRAY['admin','procurement','cs','finance','cfo','mc',
                      'audit','hr','procurement_manager']::text[])
         )
    )
  );

-- Accept-by-token and tag-by-requester are both service-layer writes that pass
-- through the API's own checks, so writes are not row-filtered here.
DROP POLICY IF EXISTS pr_ack_insert ON proc.pr_acknowledgements;
CREATE POLICY pr_ack_insert ON proc.pr_acknowledgements FOR INSERT
  WITH CHECK (core.fn_bypass_rls() OR core.fn_current_user_id() IS NOT NULL);

DROP POLICY IF EXISTS pr_ack_update ON proc.pr_acknowledgements;
CREATE POLICY pr_ack_update ON proc.pr_acknowledgements FOR UPDATE
  USING (core.fn_bypass_rls() OR core.fn_current_user_id() IS NOT NULL)
  WITH CHECK (core.fn_bypass_rls() OR core.fn_current_user_id() IS NOT NULL);

-- The accept endpoint resolves purely by token and must bypass RLS, so it sets
-- app.bypass_rls like the other service-layer lookups do.
DROP FUNCTION IF EXISTS proc.fn_accept_acknowledgement(text, uuid, text, text);
CREATE FUNCTION proc.fn_accept_acknowledgement(
  p_token      text,
  p_user_id    uuid DEFAULT NULL,
  p_ip         text DEFAULT NULL,
  p_user_agent text DEFAULT NULL
) RETURNS TABLE (
  pr_id uuid, pr_number text, pr_title text, acknowledged_at timestamptz, display_name text
) AS $$
DECLARE
  v_row proc.pr_acknowledgements%ROWTYPE;
  v_now timestamptz := now();
BEGIN
  SELECT * INTO v_row FROM proc.pr_acknowledgements WHERE token = p_token;

  IF NOT FOUND THEN
    -- Return no rows rather than RAISE. This runs through the CSV-mode psql
    -- bridge, where any server-side exception becomes a non-zero exit and
    -- surfaces as an opaque HTTP 500. Returning zero rows lets the service
    -- raise a proper 404 with a real message.
    RETURN;
  END IF;

  IF v_row.acknowledged THEN
    -- Idempotent: re-opening the same email link reports the original time
    -- rather than erroring, matching the prototype's "already acknowledged" toast.
    RETURN QUERY
      SELECT pr.id, pr.pr_number, pr.title, v_row.acknowledged_at, v_row.name
        FROM proc.purchase_requisitions pr WHERE pr.id = v_row.pr_id;
    RETURN;
  END IF;

  UPDATE proc.pr_acknowledgements
     SET acknowledged    = true,
         acknowledged_at = v_now,
         acknowledged_by = p_user_id,
         ip              = NULLIF(p_ip, '')::inet,
         user_agent      = p_user_agent
   WHERE id = v_row.id;

  RETURN QUERY
    SELECT pr.id, pr.pr_number, pr.title, v_now, v_row.name
      FROM proc.purchase_requisitions pr WHERE pr.id = v_row.pr_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Tag (or re-tag) a set of approvers on a PR. Upsert keyed on (pr, email);
-- re-tagging an already-acknowledged person must NOT reset their record.
CREATE OR REPLACE FUNCTION proc.fn_tag_acknowledgement(
  p_pr_id     uuid,
  p_tagged_by uuid,
  p_tagged_role text,
  p_name      text,
  p_email     text,
  p_dept_code text DEFAULT NULL
) RETURNS SETOF proc.pr_acknowledgements AS $$
DECLARE
  v_row proc.pr_acknowledgements%ROWTYPE;
BEGIN
  INSERT INTO proc.pr_acknowledgements
    (pr_id, tagged_role, name, email, dept_code, tagged_by)
  VALUES (p_pr_id, p_tagged_role, p_name, p_email, NULLIF(p_dept_code, ''), p_tagged_by)
  ON CONFLICT (pr_id, email) DO UPDATE
    SET name        = EXCLUDED.name,
        tagged_role = EXCLUDED.tagged_role,
        dept_code   = COALESCE(EXCLUDED.dept_code, proc.pr_acknowledgements.dept_code)
    -- acknowledged / acknowledged_at are deliberately NOT in the SET list.
  RETURNING * INTO v_row;

  RETURN NEXT v_row;
  RETURN;
END;
$$ LANGUAGE plpgsql;

COMMIT;
