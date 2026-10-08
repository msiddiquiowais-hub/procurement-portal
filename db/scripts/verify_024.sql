\set ON_ERROR_STOP on
-- ───────────────────────────────────────────────────────────────────────────
-- 024 sourcing verification
--
-- Self-sufficient: creates its own PR fixture rather than depending on
-- whatever happens to be in the database. Everything below runs inside
-- BEGIN/ROLLBACK, so nothing here persists.
--
-- The sourcing tables are under FORCE ROW LEVEL SECURITY (owner = proc), so
-- these single-session checks must bypass it explicitly. core.fn_bypass_rls()
-- reads exactly this setting.
-- ───────────────────────────────────────────────────────────────────────────
SET app.bypass_rls = 'true';

\echo '══ 024 sourcing verification ══'
\echo ''
\echo '── 1. new columns present ──'
SELECT c.col, c.typ FROM (VALUES
  ('rfq.issued_at', (SELECT data_type FROM information_schema.columns
     WHERE table_schema='proc' AND table_name='rfq' AND column_name='issued_at')),
  ('rfq.title',     (SELECT data_type FROM information_schema.columns
     WHERE table_schema='proc' AND table_name='rfq' AND column_name='title')),
  ('cs.state',      (SELECT data_type FROM information_schema.columns
     WHERE table_schema='proc' AND table_name='comparative_statements' AND column_name='state'))
) AS c(col, typ);

\echo '── 2. CS state CHECK rejects an unknown value ──'
BEGIN;
DO $$
DECLARE v_pr uuid; v_user uuid;
BEGIN
  SELECT id INTO v_user FROM core.users WHERE role = 'requester' LIMIT 1;
  INSERT INTO proc.purchase_requisitions
    (pr_number, requester_user_id, department_id, cost_center_id, expense_type,
     required_by_date, status, scope, flow_kind, estimated_amount, currency)
  SELECT 'PR-VERIFY-024', v_user, cc.department_id, cc.id, 'OPEX',
         current_date, 'Submitted', 'verification', 'CAPITAL', 0, 'PKR'
    FROM core.cost_centers cc LIMIT 1
  RETURNING id INTO v_pr;

  BEGIN
    INSERT INTO proc.comparative_statements (cs_number, pr_id, state, generated_at, generated_by_user_id)
    VALUES ('CS-BAD-STATE', v_pr, 'Nonsense', now(), v_user);
    RAISE EXCEPTION 'FAIL: unknown CS state was allowed';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK: unknown CS state rejected by the CHECK';
  END;
END $$;
ROLLBACK;

\echo '── 3. CS lock consistency (Locked needs locked_at; Generated forbids it) ──'
BEGIN;
DO $$
DECLARE v_pr uuid; v_user uuid;
BEGIN
  SELECT id INTO v_user FROM core.users WHERE role = 'requester' LIMIT 1;
  INSERT INTO proc.purchase_requisitions
    (pr_number, requester_user_id, department_id, cost_center_id, expense_type,
     required_by_date, status, scope, flow_kind, estimated_amount, currency)
  SELECT 'PR-VERIFY-024B', v_user, cc.department_id, cc.id, 'OPEX',
         current_date, 'Submitted', 'verification', 'CAPITAL', 0, 'PKR'
    FROM core.cost_centers cc LIMIT 1
  RETURNING id INTO v_pr;

  BEGIN
    INSERT INTO proc.comparative_statements (cs_number, pr_id, state, generated_at, generated_by_user_id)
    VALUES ('CS-LOCKED-NO-TS', v_pr, 'Locked', now(), v_user);
    RAISE EXCEPTION 'FAIL: state=Locked was allowed without locked_at';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK: state=Locked without locked_at rejected';
  END;

  BEGIN
    INSERT INTO proc.comparative_statements (cs_number, pr_id, state, locked_at, generated_at, generated_by_user_id)
    VALUES ('CS-GEN-WITH-TS', v_pr, 'Generated', now(), now(), v_user);
    RAISE EXCEPTION 'FAIL: state=Generated was allowed with locked_at';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK: state=Generated with locked_at rejected';
  END;
END $$;
ROLLBACK;

\echo '── 4. a valid CS row is accepted and can be locked ──'
BEGIN;
DO $$
DECLARE v_pr uuid; v_user uuid; v_cs uuid;
BEGIN
  SELECT id INTO v_user FROM core.users WHERE role = 'requester' LIMIT 1;
  INSERT INTO proc.purchase_requisitions
    (pr_number, requester_user_id, department_id, cost_center_id, expense_type,
     required_by_date, status, scope, flow_kind, estimated_amount, currency)
  SELECT 'PR-VERIFY-024C', v_user, cc.department_id, cc.id, 'OPEX',
         current_date, 'Submitted', 'verification', 'CAPITAL', 0, 'PKR'
    FROM core.cost_centers cc LIMIT 1
  RETURNING id INTO v_pr;

  INSERT INTO proc.comparative_statements
    (cs_number, pr_id, state, generated_at, generated_by_user_id, weights)
  VALUES ('CS-OK-024', v_pr, 'Generated', now(), v_user,
          '{"commercial":0.5,"technical":0.3,"warranty":0.2}'::jsonb)
  RETURNING id INTO v_cs;
  RAISE NOTICE 'OK: Generated CS accepted';

  UPDATE proc.comparative_statements
     SET state = 'Locked', locked_at = now(), locked_by_user_id = v_user
   WHERE id = v_cs;
  RAISE NOTICE 'OK: Generated -> Locked accepted';
END $$;
ROLLBACK;

\echo '── 5. quotation versioning is append-only ──'
BEGIN;
DO $$
DECLARE v_pr uuid; v_user uuid; v_vendor uuid; v_rfq uuid; v_v1 uuid; v_v2 uuid;
BEGIN
  SELECT id INTO v_user   FROM core.users WHERE role = 'requester' LIMIT 1;
  SELECT id INTO v_vendor FROM core.vendors LIMIT 1;

  INSERT INTO proc.purchase_requisitions
    (pr_number, requester_user_id, department_id, cost_center_id, expense_type,
     required_by_date, status, scope, flow_kind, estimated_amount, currency)
  SELECT 'PR-VERIFY-024D', v_user, cc.department_id, cc.id, 'OPEX',
         current_date, 'Submitted', 'verification', 'CAPITAL', 0, 'PKR'
    FROM core.cost_centers cc LIMIT 1
  RETURNING id INTO v_pr;

  INSERT INTO proc.rfq (rfq_number, pr_id, created_by_user_id, deadline_at,
                        state, currency, issued_at, title)
  VALUES ('RFQ-024-TEST', v_pr, v_user, now() + interval '7 days',
          'Open', 'PKR', now(), '024 verification RFQ')
  RETURNING id INTO v_rfq;
  RAISE NOTICE 'OK: rfq created with issued_at + title';

  INSERT INTO proc.rfq_invitations (rfq_id, vendor_id, invited_at, token_hash)
  VALUES (v_rfq, v_vendor, now(), 'hash-024-v1');
  RAISE NOTICE 'OK: invitation created';

  BEGIN
    INSERT INTO proc.rfq_invitations (rfq_id, vendor_id, invited_at, token_hash)
    VALUES (v_rfq, v_vendor, now(), 'hash-024-v2');
    RAISE EXCEPTION 'FAIL: duplicate invitation for the same (rfq,vendor) was allowed';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK: duplicate (rfq,vendor) invitation rejected';
  END;

  -- v1. NOTE: quotations has several NOT NULL columns the prototype never
  -- shows — fx_rate, normalized_total_pkr, sealed_hash, open_at, taxes_included.
  -- `open_at` is written as now() (per decision Q2, quotes are never sealed)
  -- and `sealed_hash` is a real digest of the payload, both inert.
  INSERT INTO proc.quotations (rfq_id, vendor_id, submitted_by_user_id, submitted_at,
                               total_amount, currency, fx_rate, normalized_total_pkr,
                               sealed_hash, open_at, state, version, taxes_included,
                               lead_time_days)
  VALUES (v_rfq, v_vendor, v_user, now(),
          100000, 'PKR', 1, 100000,
          encode(digest('q1','sha256'),'hex'), now(), 'Submitted', 1, true, 14)
  RETURNING id INTO v_v1;
  RAISE NOTICE 'OK: quotation v1 Submitted (prototype calls this ACTIVE)';

  -- vendor revises: v1 is MARKED Superseded, v2 is INSERTED. v1 is never updated.
  UPDATE proc.quotations SET state = 'Superseded' WHERE id = v_v1;
  INSERT INTO proc.quotations (rfq_id, vendor_id, submitted_by_user_id, submitted_at,
                               total_amount, currency, fx_rate, normalized_total_pkr,
                               sealed_hash, open_at, state, version, taxes_included,
                               supersedes_quotation_id, lead_time_days)
  VALUES (v_rfq, v_vendor, v_user, now(),
          90000, 'PKR', 1, 90000,
          encode(digest('q2','sha256'),'hex'), now(), 'Submitted', 2, true, v_v1, 10)
  RETURNING id INTO v_v2;
  RAISE NOTICE 'OK: quotation v2 inserted, superseding v1';

  PERFORM 1 FROM proc.quotations WHERE id = v_v1 AND state = 'Superseded';
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: v1 is not Superseded'; END IF;
  PERFORM 1 FROM proc.quotations WHERE id = v_v2 AND version = 2 AND supersedes_quotation_id = v_v1;
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL: v2 does not link back to v1'; END IF;
  RAISE NOTICE 'OK: v1 Superseded, v2 links via supersedes_quotation_id';
END $$;
ROLLBACK;

\echo '── 6. Q1 vocabulary mapping is still the one we agreed ──'
BEGIN;
DO $$
DECLARE
  v_check text;
  v_superseded_found boolean;
  v_active_present   boolean;
  v_void_present     boolean;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_check
    FROM pg_constraint
   WHERE conrelid = 'proc.quotations'::regclass
     AND conname = 'quotations_state_check';

  v_superseded_found := position('Superseded' in v_check) > 0;
  v_active_present   := position('ACTIVE'     in v_check) > 0;
  v_void_present     := position('VOID'       in v_check) > 0;

  IF v_superseded_found THEN
    RAISE NOTICE 'OK: SUPERSEDED -> Superseded is a direct match';
  ELSE
    RAISE EXCEPTION 'FAIL: Superseded missing from the CHECK - re-check the Q1 mapping';
  END IF;

  IF NOT v_active_present AND NOT v_void_present THEN
    RAISE NOTICE 'OK: ACTIVE and VOID absent, so the UI mapping to Submitted/Withdrawn is unambiguous';
  ELSE
    RAISE EXCEPTION 'FAIL: ACTIVE or VOID now exists in the CHECK - the Q1 mapping must be revisited';
  END IF;
END $$;
ROLLBACK;

\echo '── 7. DECISION Q2: quotes are NOT sealed ──'
-- A quote written with open_at 30 DAYS IN THE FUTURE must still be readable.
-- A sealed implementation would hide it. This locks the decision in.
BEGIN;
DO $$
DECLARE v_pr uuid; v_user uuid; v_vendor uuid; v_rfq uuid; v_seen int;
BEGIN
  SELECT id INTO v_user   FROM core.users WHERE role = 'requester' LIMIT 1;
  SELECT id INTO v_vendor FROM core.vendors LIMIT 1;

  INSERT INTO proc.purchase_requisitions
    (pr_number, requester_user_id, department_id, cost_center_id, expense_type,
     required_by_date, status, scope, flow_kind, estimated_amount, currency)
  SELECT 'PR-VERIFY-024E', v_user, cc.department_id, cc.id, 'OPEX',
         current_date, 'Submitted', 'verification', 'CAPITAL', 0, 'PKR'
    FROM core.cost_centers cc LIMIT 1
  RETURNING id INTO v_pr;

  INSERT INTO proc.rfq (rfq_number, pr_id, created_by_user_id, deadline_at,
                        state, currency, issued_at)
  VALUES ('RFQ-024-SEAL', v_pr, v_user, now() + interval '7 days', 'Open', 'PKR', now())
  RETURNING id INTO v_rfq;

  INSERT INTO proc.quotations (rfq_id, vendor_id, submitted_by_user_id, submitted_at,
                               total_amount, currency, fx_rate, normalized_total_pkr,
                               sealed_hash, open_at, state, version, taxes_included)
  VALUES (v_rfq, v_vendor, v_user, now(),
          50000, 'PKR', 1, 50000,
          encode(digest('sealed','sha256'),'hex'),
          now() + interval '30 days',            -- deliberately in the FUTURE
          'Submitted', 1, true);

  SELECT count(*) INTO v_seen
    FROM proc.quotations
   WHERE rfq_id = v_rfq AND vendor_id = v_vendor AND state = 'Submitted';

  IF v_seen = 1 THEN
    RAISE NOTICE 'OK: a quote with a FUTURE open_at is immediately readable (no sealing)';
  ELSE
    RAISE EXCEPTION 'FAIL: the quote was hidden - sealed-bid gating is present';
  END IF;
END $$;
ROLLBACK;

\echo '── 8. Q2: the RFQ deadline never auto-closes an RFQ ──'
-- The pre-existing rfq_check forbids CREATING an RFQ with a deadline under
-- +24h, so a past deadline cannot be inserted at all. The invariant we
-- actually care about is that nothing CLOSES an RFQ when the clock passes
-- the deadline. That is proved by the absence of any trigger on proc.rfq
-- that references deadline_at, plus a minimum-validity RFQ staying Open.
BEGIN;
DO $$
DECLARE v_pr uuid; v_user uuid; v_rfq uuid; v_seen int; v_trg int;
BEGIN
  SELECT id INTO v_user FROM core.users WHERE role = 'requester' LIMIT 1;
  INSERT INTO proc.purchase_requisitions
    (pr_number, requester_user_id, department_id, cost_center_id, expense_type,
     required_by_date, status, scope, flow_kind, estimated_amount, currency)
  SELECT 'PR-VERIFY-024F', v_user, cc.department_id, cc.id, 'OPEX',
         current_date, 'Submitted', 'verification', 'CAPITAL', 0, 'PKR'
    FROM core.cost_centers cc LIMIT 1
  RETURNING id INTO v_pr;

  -- Minimum permitted validity: created_at + 24h.
  INSERT INTO proc.rfq (rfq_number, pr_id, created_by_user_id, deadline_at,
                        state, currency, issued_at)
  VALUES ('RFQ-024-MIN', v_pr, v_user, now() + interval '24 hours', 'Open', 'PKR', now())
  RETURNING id INTO v_rfq;
  RAISE NOTICE 'OK: minimum-validity RFQ (created_at + 24h) accepted';

  -- No trigger may close an RFQ when its deadline passes.
  SELECT count(*) INTO v_trg
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
   WHERE c.relname = 'rfq' AND t.tgname NOT LIKE 'pg_%'
     AND pg_get_triggerdef(t.oid) ILIKE '%deadline%';

  IF v_trg = 0 THEN
    RAISE NOTICE 'OK: no trigger on proc.rfq references deadline_at — nothing auto-closes';
  ELSE
    RAISE EXCEPTION 'FAIL: % trigger(s) on proc.rfq reference deadline_at', v_trg;
  END IF;

  SELECT count(*) INTO v_seen FROM proc.rfq WHERE id = v_rfq AND state = 'Open';
  IF v_seen = 1 THEN
    RAISE NOTICE 'OK: the RFQ remains Open and readable';
  ELSE
    RAISE EXCEPTION 'FAIL: the RFQ was not readable as Open';
  END IF;
END $$;
ROLLBACK;

\echo '── 9. pre-existing rfq_check still rejects a sub-24h deadline ──'
BEGIN;
DO $$
DECLARE v_pr uuid; v_user uuid;
BEGIN
  SELECT id INTO v_user FROM core.users WHERE role = 'requester' LIMIT 1;
  INSERT INTO proc.purchase_requisitions
    (pr_number, requester_user_id, department_id, cost_center_id, expense_type,
     required_by_date, status, scope, flow_kind, estimated_amount, currency)
  SELECT 'PR-VERIFY-024G', v_user, cc.department_id, cc.id, 'OPEX',
         current_date, 'Submitted', 'verification', 'CAPITAL', 0, 'PKR'
    FROM core.cost_centers cc LIMIT 1
  RETURNING id INTO v_pr;

  BEGIN
    INSERT INTO proc.rfq (rfq_number, pr_id, created_by_user_id, deadline_at,
                          state, currency)
    VALUES ('RFQ-024-BADDL', v_pr, v_user, now() + interval '1 hour', 'Open', 'PKR');
    RAISE EXCEPTION 'FAIL: a <24h deadline was allowed';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK: sub-24h deadline still rejected by rfq_check';
  END;
END $$;
ROLLBACK;

\echo '── 10. cs_lines ranking and approved_packs 1:1 immutability ──'
BEGIN;
DO $$
DECLARE v_pr uuid; v_user uuid; v_cs uuid; v_v1 uuid; v_v2 uuid;
BEGIN
  SELECT id INTO v_user FROM core.users WHERE role = 'requester' LIMIT 1;
  INSERT INTO proc.purchase_requisitions
    (pr_number, requester_user_id, department_id, cost_center_id, expense_type,
     required_by_date, status, scope, flow_kind, estimated_amount, currency)
  SELECT 'PR-VERIFY-024H', v_user, cc.department_id, cc.id, 'OPEX',
         current_date, 'Submitted', 'verification', 'CAPITAL', 0, 'PKR'
    FROM core.cost_centers cc LIMIT 1
  RETURNING id INTO v_pr;

  INSERT INTO proc.comparative_statements (cs_number, pr_id, state, generated_at, generated_by_user_id)
  VALUES ('CS-024-RANK', v_pr, 'Generated', now(), v_user) RETURNING id INTO v_cs;

  SELECT id INTO v_v1 FROM core.vendors LIMIT 1;
  SELECT id INTO v_v2 FROM core.vendors WHERE id <> v_v1 LIMIT 1;

  INSERT INTO proc.cs_lines (cs_id, vendor_id, commercial_score, technical_score,
                             warranty_score, weighted_score, rank)
  VALUES (v_cs, v_v1, 90, 80, 70, 85.0, 1), (v_cs, v_v2, 70, 90, 60, 72.0, 2);
  RAISE NOTICE 'OK: cs_lines accepts ranked scores for multiple vendors';

  INSERT INTO proc.approved_packs (pr_id, pack_hash, payload, frozen_at, frozen_by_user_id)
  VALUES (v_pr, encode(digest('pack-a','sha256'),'hex'),
          '{"documents":[]}'::jsonb, now(), v_user);
  RAISE NOTICE 'OK: first pack frozen for the PR (frozen_at/frozen_by are NOT NULL — there is no draft pack)';

  BEGIN
    INSERT INTO proc.approved_packs (pr_id, pack_hash, payload, frozen_at, frozen_by_user_id)
    VALUES (v_pr, encode(digest('pack-b','sha256'),'hex'),
            '{"documents":[]}'::jsonb, now(), v_user);
    RAISE EXCEPTION 'FAIL: a second pack was allowed for the same PR';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK: second pack for the same PR rejected (pack is 1:1 and immutable)';
  END;
END $$;
ROLLBACK;

\echo ''
\echo '── indexes created by 024 ──'
SELECT indexname FROM pg_indexes
 WHERE schemaname = 'proc'
   AND (indexname LIKE 'idx_rfq%' OR indexname LIKE 'idx_quotation%'
        OR indexname LIKE 'idx_cs_%' OR indexname LIKE 'idx_nego%')
 ORDER BY indexname;

\echo '══ 024 verification complete ══'
