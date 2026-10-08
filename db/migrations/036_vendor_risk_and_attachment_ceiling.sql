-- ═══════════════════════════════════════════════════════════════════════════
-- 036 — One threshold, a per-PR attachment ceiling, and the vendor risk model
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Three decisions from the Master Gap Analysis remediation, Wave 5 Track D.
--
-- (1) ONE SOURCE OF TRUTH FOR THE MANAGEMENT THRESHOLD
--     Migration 032 seeded `core.settings.mgmtThresholdCr` as a *documented
--     alias* to `workflow.config['management_threshold']`. That was a
--     compromise, and it shipped a lie: the row held 1.0 (the prototype's
--     "PKR Cr" figure) forever, because every PATCH was routed to
--     workflow.config and the row was never written. The Settings screen
--     therefore displayed a number that governed nothing. The owner has ruled:
--     drop the row completely; workflow.config is the only threshold.
--
--     REPLAY SAFETY. 032 still seeds the row and still asserts it exists in
--     its own post-condition, which is correct — it describes 032's own
--     effect. 036 removes it afterwards. Lexical replay (032 then 036) is
--     therefore stable, and re-running 036 alone is a no-op. This is the
--     019/020/027 landmine class handled in the right direction: the LATER
--     migration is the one allowed to narrow, and 032 is never re-asserted
--     after 036 has run.
--
-- (2) PER-PR TOTAL ATTACHMENT CEILING — 25 MiB
--     Migration 034 set a per-FILE cap (5,242,880). Nothing bounded the number
--     of files, so one PR could carry 200 attachments. The owner has set the
--     per-PR total ceiling to exactly 26,214,400 bytes (25 MiB).
--
--     This is a TRIGGER, not a helper function nobody calls. The attachment
--     write service is Wave 5-E and does not exist yet; a CHECK cannot span
--     rows, so without a trigger this ceiling would be documentation.
--
-- (3) THE VENDOR RISK MODEL — compositeOf()
--     The blueprint (9.5) defines it exactly:
--         g = {A:3, B:2, C:1, D:0}
--         s = g[financial]*0.40 + g[delivery]*0.35 + g[quality]*0.25
--         score = round(s*100/3)
--         risk grade: s >= 2.5 Low | s >= 1.5 Medium | else High
--     It lived only in the prototype's JS. High-risk vendors are "blocked from
--     new RFQ invitations until remediation" (9.5) and nothing enforced that.
--
--     WHY SQL AND NOT TS. The same three numbers must agree in the Vendor Risk
--     screen, the Vendor Master Risk column, and the RFQ invitation guard. A
--     TypeScript copy would be a second implementation that could drift from
--     the one the guard uses — exactly the class of bug this project keeps
--     refusing. One function, in the database, read by all three.
--
--     THE SEEDED GRADES ARE THE BLUEPRINT'S FIVE COMBINATIONS, ON REAL
--     VENDORS. The blueprint names V-000123 / V-000088 / V-000201 / V-000334 /
--     V-000410. Those are the prototype's placeholder identities: V-000123
--     "PakBoxes Pvt Ltd" is the literal this codebase has spent four waves
--     refusing to fabricate (Wave 4 asserts the supplier inbox never contains
--     "V-000123" or "PakBoxes Pvt Ltd"). Seeding them would reintroduce the
--     fiction. So the MODEL is ported exactly — all five grade combinations,
--     including the two that must land High — and they are attached to the six
--     real seeded vendors. V-00083 is deliberately left UNSCORED: it is
--     DD_In_Progress, a vendor not yet risk-assessed, which gives the screens
--     an honest "not yet scored" row instead of a fabricated grade.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Settings: the per-PR ceiling, and the threshold alias removed ───────

INSERT INTO core.settings (key, value, value_type, label, description, group_name, is_toggle, sort_order) VALUES
  ('attachmentTotalMaxBytes', to_jsonb(26214400), 'int', 'Max attachments per PR (bytes)',
   'Ceiling on the TOTAL size of all active attachments on one PR. Separate from the per-file cap, which bounds a single upload.',
   'Workflow & approvals', false, 7)
ON CONFLICT (key) DO UPDATE SET
  label       = EXCLUDED.label,
  description = EXCLUDED.description;

-- The alias row goes. Its column `canonical_source` was the only reason it
-- existed; deleting the row rather than blanking the value means the Settings
-- screen can no longer even render a second number.
DELETE FROM core.settings WHERE key = 'mgmtThresholdCr';

-- ─── 2. compositeOf(), in the database ──────────────────────────────────────
-- Returns (score, weighted, risk_grade, blocked).
--
-- `blocked` is the blueprint's operational consequence: "High-risk vendors are
-- blocked from new RFQ invitations until remediation." It is derived here so
-- the guard, the matrix and the roster cannot disagree about it.

CREATE OR REPLACE FUNCTION core.fn_vendor_composite(p_scorecard jsonb)
RETURNS TABLE (
  score      numeric,
  weighted   numeric,
  risk_grade text,
  blocked    boolean
)
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  g_fin  numeric := 0;
  g_del  numeric := 0;
  g_qual numeric := 0;
  s      numeric := 0;
  grade  text;
BEGIN
  IF p_scorecard IS NULL OR NOT (p_scorecard ?& ARRAY['financial','delivery','quality']) THEN
    -- An unscored vendor is NOT a low-risk vendor. Returning NULLs rather than a
    -- zero score keeps "not assessed" visibly distinct from "assessed as worst".
    RETURN QUERY SELECT NULL::numeric, NULL::numeric, NULL::text, NULL::boolean;
    RETURN;
  END IF;

  g_fin  := CASE upper(p_scorecard->>'financial') WHEN 'A' THEN 3 WHEN 'B' THEN 2 WHEN 'C' THEN 1 WHEN 'D' THEN 0 ELSE NULL END;
  g_del  := CASE upper(p_scorecard->>'delivery')  WHEN 'A' THEN 3 WHEN 'B' THEN 2 WHEN 'C' THEN 1 WHEN 'D' THEN 0 ELSE NULL END;
  g_qual := CASE upper(p_scorecard->>'quality')   WHEN 'A' THEN 3 WHEN 'B' THEN 2 WHEN 'C' THEN 1 WHEN 'D' THEN 0 ELSE NULL END;

  IF g_fin IS NULL OR g_del IS NULL OR g_qual IS NULL THEN
    RAISE EXCEPTION 'core.fn_vendor_composite: scorecard has a grade outside {A,B,C,D}: %', p_scorecard;
  END IF;

  s := g_fin * 0.40 + g_del * 0.35 + g_qual * 0.25;
  grade := CASE WHEN s >= 2.5 THEN 'Low' WHEN s >= 1.5 THEN 'Medium' ELSE 'High' END;

  RETURN QUERY SELECT round(s * 100 / 3, 0), s, grade, (grade = 'High');
END;
$$;

COMMENT ON FUNCTION core.fn_vendor_composite(jsonb) IS
  'Blueprint 9.5 compositeOf(): g={A:3,B:2,C:1,D:0}; s=fin*0.40+del*0.35+qual*0.25; score=round(s*100/3); s>=2.5 Low, >=1.5 Medium, else High. High is blocked from new RFQ invitations.';

-- ─── 3. Seed the grades onto the REAL vendors ──────────────────────────────
-- All FIVE blueprint combinations, one per scored vendor.
--
-- WHICH vendor carries WHICH combination is this port's decision; the blueprint
-- names fictional ones. The constraint is that all five combinations exist, that
-- C/C/B and C/D/C both land High, and that the PENDING vendor is not one of them.
-- That last part is load-bearing: V-00083 is a deliberate blacklist row and
-- V-00086 (Manager_Approved) is the only vendor off the approved roster, so
-- grading it High left the sourcing suite with no invitable off-roster vendor and
-- e2e_sourcing failed against a rule that was working correctly. Mapping A/A/A to
-- V-00086 keeps every combination present, both High bands intact, and the
-- business position coherent: a pending vendor that is also high risk would be a
-- vendor Procurement had not finished approving AND whose risk assessment was
-- poor — refusing to invite it is right, but it is not what this screen exists
-- to demonstrate.

-- REPLAY EXEMPTION (added by 039)
-- Migration 039 installs core.fn_vendors_governed_change_gate(), which refuses any
-- UPDATE of a governed vendor column that does not carry an audit token. This file's
-- backfill IS such an UPDATE, and migrations replay in lexical order with no ledger -
-- so on the second `db:migrate` this statement would run with 039's trigger already
-- installed and abort the whole step. Every migration must stay individually
-- re-runnable, so the backfill declares itself as a migration write. This changes
-- nothing about the runtime API path, which is governed by the token.
SELECT set_config('app.vendor_legacy_write', 'on', false);

UPDATE core.vendors SET scorecard = '{"financial":"B","delivery":"B","quality":"A"}'::jsonb
 WHERE vendor_code = 'V-00081';   -- B/B/A -> s=2.25 ->  75 -> Medium
UPDATE core.vendors SET scorecard = '{"financial":"A","delivery":"A","quality":"B"}'::jsonb
 WHERE vendor_code = 'V-00082';   -- A/A/B -> s=2.75 ->  92 -> Low
UPDATE core.vendors SET scorecard = '{"financial":"C","delivery":"C","quality":"B"}'::jsonb
 WHERE vendor_code = 'V-00084';   -- C/C/B -> s=1.25 ->  42 -> High  (blocked)
UPDATE core.vendors SET scorecard = '{"financial":"C","delivery":"D","quality":"C"}'::jsonb
 WHERE vendor_code = 'V-00085';   -- C/D/C -> s=0.65 ->  22 -> High  (blocked)
UPDATE core.vendors SET scorecard = '{"financial":"A","delivery":"A","quality":"A"}'::jsonb
 WHERE vendor_code = 'V-00086';   -- A/A/A -> s=3.00 -> 100 -> Low    (Manager_Approved)

-- `risk_score` was a column nothing ever wrote. Materialise it from the same
-- function so any pre-existing reader of risk_score sees the model rather than
-- a stale or NULL value.
--
-- The composite is computed in a CTE rather than inline: in `UPDATE ... FROM`
-- the TARGET TABLE IS NOT A FROM-LIST ENTRY, so a LATERAL item there cannot
-- reference it ("invalid reference to FROM-clause entry"). Reading the vendors
-- in a CTE first and joining back on id avoids that entirely.
WITH scored AS (
  SELECT v.id, c.score
    FROM core.vendors v
    CROSS JOIN LATERAL core.fn_vendor_composite(v.scorecard) AS c
   WHERE c.score IS NOT NULL
)
UPDATE core.vendors v
   SET risk_score = s.score
  FROM scored s
 WHERE s.id = v.id
   AND v.risk_score IS DISTINCT FROM s.score;

-- ─── 4. The per-PR attachment ceiling, enforced ────────────────────────────
-- Only ACTIVE rows count: replacing an attachment supersedes the old version,
-- and the ceiling must apply to the live set, not to the audit history.
--
-- WHY THIS IS A DEFERRED CONSTRAINT TRIGGER, NOT A BEFORE-INSERT ROW TRIGGER.
-- The first draft was an ordinary BEFORE INSERT row trigger summing ACTIVE rows.
-- It works — and it makes "replace this attachment" IMPERFORMABLE, which is the
-- same trap as the EXCLUDE-vs-partial-UNIQUE finding in migration 033. Replace is
-- insert-NEW-as-ACTIVE then flip-OLD-to-SUPERSEDED. An immediate check sees both
-- rows live and refuses at old+new, so a 20 MiB file can never be replaced by a
-- 20 MiB file: the insert fails on 40 MiB and the user cannot get out of it.
--
-- DEFERRABLE INITIALLY DEFERRED moves the check to COMMIT, by which point the old
-- row is already SUPERSEDED and only the live total is counted. Both orders then
-- work, while still refusing to leave a PR over budget. A constraint that makes
-- its own feature unperformable is worse than no constraint, because it looks
-- right.
--
-- It is a CONSTRAINT trigger over a TRANSITION TABLE (statement-level), because
-- at COMMIT it must re-examine every touched parent, not just the one row that
-- happened to change.

CREATE OR REPLACE FUNCTION core.fn_pr_attachment_cap_bytes()
RETURNS bigint
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  cap bigint;
BEGIN
  SELECT (value #>> '{}')::bigint INTO cap
    FROM core.settings WHERE key = 'attachmentTotalMaxBytes';
  RETURN COALESCE(cap, 26214400);
END;
$$;

-- A CONSTRAINT trigger cannot carry a REFERENCING transition table (PostgreSQL
-- rejects that grammar outright), so the "which parents did this statement
-- touch" question is answered by a QUEUE instead. An immediate BEFORE trigger
-- records the parent; the deferred trigger drains the queue at COMMIT, by which
-- point a replace has already superseded its predecessor.
CREATE TABLE IF NOT EXISTS core.attachment_budget_queue (
  parent_id uuid PRIMARY KEY
);

CREATE OR REPLACE FUNCTION core.fn_queue_pr_attachment_budget()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Quotes have their own parent; this ceiling is per-PR by decision.
  IF NEW.parent_type = 'pr' THEN
    INSERT INTO core.attachment_budget_queue (parent_id)
    VALUES (NEW.parent_id)
    ON CONFLICT (parent_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION core.fn_enforce_pr_attachment_budget()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cap   bigint := core.fn_pr_attachment_cap_bytes();
  pid   uuid;
  total bigint;
BEGIN
  FOR pid IN SELECT parent_id FROM core.attachment_budget_queue LOOP
    SELECT COALESCE(sum(a.size_bytes), 0) INTO total
      FROM core.attachment_registry a
     WHERE a.parent_type = 'pr'
       AND a.parent_id   = pid
       AND a.status      = 'ACTIVE';

    IF total > cap THEN
      -- Drain first: the transaction is about to roll back, but leaving stale
      -- ids behind would make the next run re-check a PR it did not touch.
      DELETE FROM core.attachment_budget_queue WHERE parent_id = pid;
      RAISE EXCEPTION
        'per-PR attachment ceiling exceeded: % active bytes on PR %, limit is % bytes',
        total, pid, cap
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  DELETE FROM core.attachment_budget_queue;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_queue_pr_attachment_budget ON core.attachment_registry;
CREATE TRIGGER trg_queue_pr_attachment_budget
  BEFORE INSERT OR UPDATE OF size_bytes, status, parent_id ON core.attachment_registry
  FOR EACH ROW EXECUTE FUNCTION core.fn_queue_pr_attachment_budget();

DROP TRIGGER IF EXISTS trg_pr_attachment_budget ON core.attachment_registry;
-- FOR EACH ROW is not a stylistic choice: CREATE CONSTRAINT TRIGGER accepts no
-- other form, on PostgreSQL 16 as on every earlier version. The queue makes the
-- per-row firing harmless — the first row to fire drains it, the rest find it
-- empty, and a parent with many attachments is still checked exactly once.
CREATE CONSTRAINT TRIGGER trg_pr_attachment_budget
  AFTER INSERT OR UPDATE ON core.attachment_registry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION core.fn_enforce_pr_attachment_budget();

-- ═══ Post-condition check (inside the transaction, so a failure rolls back) ══
DO $$
DECLARE
  n     numeric;
  grade text;
  cap   bigint;
BEGIN
  -- (1) The alias row is gone, and workflow.config still owns the threshold.
  IF EXISTS (SELECT 1 FROM core.settings WHERE key = 'mgmtThresholdCr') THEN
    RAISE EXCEPTION 'migration 036: core.settings.mgmtThresholdCr still exists — the duplicate threshold survived';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM workflow.config WHERE key = 'management_threshold') THEN
    RAISE EXCEPTION 'migration 036: workflow.config lost management_threshold; removing the alias left no source of truth';
  END IF;

  -- (2) The ceiling exists and is the agreed number.
  IF NOT EXISTS (SELECT 1 FROM core.settings WHERE key = 'attachmentTotalMaxBytes') THEN
    RAISE EXCEPTION 'migration 036: attachmentTotalMaxBytes was not seeded';
  END IF;
  SELECT (value #>> '{}')::bigint INTO cap FROM core.settings WHERE key = 'attachmentTotalMaxBytes';
  IF cap <> 26214400 THEN
    RAISE EXCEPTION 'migration 036: per-PR attachment ceiling is %, expected 26214400', cap;
  END IF;

  -- The trigger must exist AND be enabled AND be DEFERRED. A disabled trigger is
  -- a ceiling that only looks like one; a non-deferred one makes "replace this
  -- attachment" impossible, which is the failure this design exists to avoid.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'core.attachment_registry'::regclass
       AND tgname  = 'trg_pr_attachment_budget'
       AND NOT tgisinternal
       AND tgenabled    <> 'D'
       AND tgdeferrable
       AND tginitdeferred
  ) THEN
    RAISE EXCEPTION
      'migration 036: trg_pr_attachment_budget must exist, be enabled, and be DEFERRABLE INITIALLY DEFERRED';
  END IF;

  -- Its enqueuing half must exist too, or the deferred check always finds an
  -- empty queue and never fires — a ceiling that silently does nothing.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'core.attachment_registry'::regclass
       AND tgname  = 'trg_queue_pr_attachment_budget'
       AND NOT tgisinternal
       AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'migration 036: trg_queue_pr_attachment_budget is missing or disabled';
  END IF;

  -- A queue that is not empty at rest means a previous transaction left debt.
  IF EXISTS (SELECT 1 FROM core.attachment_budget_queue) THEN
    RAISE EXCEPTION 'migration 036: core.attachment_budget_queue is not empty at rest';
  END IF;

  -- (3) The model is real: at least one vendor MUST land High, or nothing is
  --     blocked and the whole screen is decorative.
  SELECT count(*) INTO n
    FROM core.vendors v CROSS JOIN LATERAL core.fn_vendor_composite(v.scorecard) AS c
   WHERE c.risk_grade = 'High';
  IF n = 0 THEN
    RAISE EXCEPTION 'migration 036: no seeded vendor lands in the High band — blocked-from-RFQ would never fire';
  END IF;

  -- ...and at least one Low, or "Eligible for RFQ" is always zero.
  SELECT count(*) INTO n
    FROM core.vendors v CROSS JOIN LATERAL core.fn_vendor_composite(v.scorecard) AS c
   WHERE c.risk_grade = 'Low';
  IF n = 0 THEN
    RAISE EXCEPTION 'migration 036: no seeded vendor lands in the Low band';
  END IF;

  -- The two blueprint combinations that must be High really are, by grade not
  -- by vendor code — the assertion is on the outcome, not on our own seeds.
  SELECT count(*) INTO n
    FROM core.vendors v CROSS JOIN LATERAL core.fn_vendor_composite(v.scorecard) AS c
   WHERE v.scorecard->>'financial' = 'C'
     AND v.scorecard->>'delivery'  = 'C'
     AND v.scorecard->>'quality'   = 'B'
     AND c.risk_grade = 'High';
  IF n <> 1 THEN
    RAISE EXCEPTION 'migration 036: expected exactly 1 C/C/B vendor graded High, found %', n;
  END IF;

  SELECT count(*) INTO n
    FROM core.vendors v CROSS JOIN LATERAL core.fn_vendor_composite(v.scorecard) AS c
   WHERE v.scorecard->>'financial' = 'A'
     AND v.scorecard->>'delivery'  = 'A'
     AND v.scorecard->>'quality'   = 'A'
     AND c.score = 100
     AND c.risk_grade = 'Low';
  IF n <> 1 THEN
    RAISE EXCEPTION 'migration 036: A/A/A must score exactly 100 and grade Low; found % such vendors', n;
  END IF;

  -- risk_score must agree with the function wherever the function has an
  -- answer; divergence here is what a second implementation looks like.
  SELECT count(*) INTO n
    FROM core.vendors v CROSS JOIN LATERAL core.fn_vendor_composite(v.scorecard) AS c
   WHERE c.score IS NOT NULL
     AND v.risk_score IS DISTINCT FROM c.score;
  IF n <> 0 THEN
    RAISE EXCEPTION 'migration 036: % vendors have a risk_score that disagrees with compositeOf()', n;
  END IF;
END;
$$;
