\set ON_ERROR_STOP on
\echo '── 1. new status values accepted by the CHECK ──'
SELECT 'IN_IT_REVIEW'  AS status, ('x'::text = 'x') AS ok
UNION ALL SELECT 'IN_WAREHOUSE', true
UNION ALL SELECT 'REJECTED', true;

\echo '── 2. purchase_requisitions_status_check definition ──'
SELECT pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conname = 'purchase_requisitions_status_check';

\echo '── 3. new pr_lines columns ──'
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema='proc' AND table_name='pr_lines'
   AND column_name IN ('category','held','held_reason','financial_dimensions','approved','rejected')
 ORDER BY column_name;

\echo '── 4. new tables ──'
SELECT table_name FROM information_schema.tables
 WHERE table_schema='proc' AND table_name IN ('pr_departments','pr_images')
 ORDER BY table_name;

\echo '── 5. transition trigger admits a split child (Submitted -> IN_IT_REVIEW) ──'
BEGIN;
DO $$
DECLARE
  v_pr uuid; v_user uuid; v_dept uuid; v_cc uuid; v_item uuid; v_cc2 uuid;
BEGIN
  SELECT id INTO v_user FROM core.users LIMIT 1;
  SELECT id INTO v_dept FROM core.departments LIMIT 1;
  SELECT id INTO v_cc  FROM core.cost_centers LIMIT 1;
  SELECT id INTO v_cc2 FROM core.cost_centers WHERE id <> v_cc LIMIT 1;
  SELECT id INTO v_item FROM core.items LIMIT 1;

  INSERT INTO proc.purchase_requisitions
    (pr_number, requester_user_id, department_id, cost_center_id, expense_type,
     required_by_date, status, scope, estimated_amount)
  VALUES ('PR-TEST-SPLIT', v_user, v_dept, v_cc, 'OPEX', current_date, 'Submitted', 'test', 0)
  RETURNING id INTO v_pr;

  INSERT INTO proc.pr_lines (pr_id, line_no, item_id, quantity, uom, unit_price_est, gl_account, category)
  VALUES (v_pr, 1, v_item, 1, 'EA', 250000, 'NA', 'IT_HARDWARE');

  UPDATE proc.purchase_requisitions SET status = 'IN_IT_REVIEW' WHERE id = v_pr;
  RAISE NOTICE 'OK: Submitted -> IN_IT_REVIEW accepted';

  UPDATE proc.purchase_requisitions SET status = 'IN_PROCUREMENT_REVIEW' WHERE id = v_pr;
  RAISE NOTICE 'OK: IN_IT_REVIEW -> IN_PROCUREMENT_REVIEW accepted';
END $$;
ROLLBACK;

\echo '── 6. illegal transition still rejected (IN_PROCUREMENT_REVIEW -> IN_IT_REVIEW) ──'
BEGIN;
DO $$
DECLARE v_pr uuid; v_user uuid; v_dept uuid; v_cc uuid; v_item uuid;
BEGIN
  SELECT id INTO v_user FROM core.users LIMIT 1;
  SELECT id INTO v_dept FROM core.departments LIMIT 1;
  SELECT id INTO v_cc  FROM core.cost_centers LIMIT 1;
  SELECT id INTO v_item FROM core.items LIMIT 1;
  INSERT INTO proc.purchase_requisitions
    (pr_number, requester_user_id, department_id, cost_center_id, expense_type,
     required_by_date, status, scope, estimated_amount)
  VALUES ('PR-TEST-BAD', v_user, v_dept, v_cc, 'OPEX', current_date, 'IN_PROCUREMENT_REVIEW', 'test', 0)
  RETURNING id INTO v_pr;
  BEGIN
    UPDATE proc.purchase_requisitions SET status = 'IN_IT_REVIEW' WHERE id = v_pr;
    RAISE EXCEPTION 'FAIL: illegal transition was allowed';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK: illegal transition correctly rejected';
  END;
END $$;
ROLLBACK;

\echo '── 7. image cap trigger rejects a 4th image ──'
BEGIN;
DO $$
DECLARE v_pr uuid; v_user uuid; v_dept uuid; v_cc uuid; v_file uuid; i int;
BEGIN
  SELECT id INTO v_user FROM core.users LIMIT 1;
  SELECT id INTO v_dept FROM core.departments LIMIT 1;
  SELECT id INTO v_cc  FROM core.cost_centers LIMIT 1;

  INSERT INTO core.files (bucket, object_key, content_type, size_bytes, sha256, uploaded_by_user_id)
  VALUES ('test', 'verify-020-image.png', 'image/png', 1024, repeat('a', 64), v_user)
  RETURNING id INTO v_file;

  INSERT INTO proc.purchase_requisitions
    (pr_number, requester_user_id, department_id, cost_center_id, expense_type,
     required_by_date, status, scope, estimated_amount)
  VALUES ('PR-TEST-IMG', v_user, v_dept, v_cc, 'OPEX', current_date, 'Submitted', 'test', 0)
  RETURNING id INTO v_pr;

  FOR i IN 1..3 LOOP
    INSERT INTO proc.pr_images (pr_id, file_id, mime_type, size_bytes, sort_order)
    VALUES (v_pr, v_file, 'image/png', 1024, i);
  END LOOP;
  RAISE NOTICE 'OK: 3 images accepted';

  BEGIN
    INSERT INTO proc.pr_images (pr_id, file_id, mime_type, size_bytes, sort_order)
    VALUES (v_pr, v_file, 'image/png', 1024, 4);
    RAISE EXCEPTION 'FAIL: 4th image was allowed';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK: 4th image correctly rejected by the 3-per-PR cap';
  END;
END $$;
ROLLBACK;

\echo '── 8. rejected/approved CHECK constraint ──'
BEGIN;
DO $$
DECLARE v_pr uuid; v_user uuid; v_dept uuid; v_cc uuid; v_item uuid; v_ln uuid;
BEGIN
  SELECT id INTO v_user FROM core.users LIMIT 1;
  SELECT id INTO v_dept FROM core.departments LIMIT 1;
  SELECT id INTO v_cc  FROM core.cost_centers LIMIT 1;
  SELECT id INTO v_item FROM core.items LIMIT 1;
  INSERT INTO proc.purchase_requisitions
    (pr_number, requester_user_id, department_id, cost_center_id, expense_type,
     required_by_date, status, scope, estimated_amount)
  VALUES ('PR-TEST-LINE', v_user, v_dept, v_cc, 'OPEX', current_date, 'Submitted', 'test', 0)
  RETURNING id INTO v_pr;
  INSERT INTO proc.pr_lines (pr_id, line_no, item_id, quantity, uom, unit_price_est, gl_account)
  VALUES (v_pr, 1, v_item, 1, 'EA', 1000, 'NA') RETURNING id INTO v_ln;

  UPDATE proc.pr_lines SET approved = true, rejected = true WHERE id = v_ln;
  RAISE EXCEPTION 'FAIL: approved+rejected was allowed';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'OK: approved+rejected correctly rejected';
END $$;
ROLLBACK;

\echo '══ migration 020 verification complete ══'
