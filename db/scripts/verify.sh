#!/usr/bin/env bash
# verify.sh — smoke test the schema.

set -euo pipefail

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-55432}"
DB_USER="${DB_USER:-proc}"
DB_PASSWORD="${DB_PASSWORD:-proc_local}"
DB_NAME="${DB_NAME:-procurementDB}"

export PGPASSWORD="$DB_PASSWORD"

fail=0
pass() { printf "  ✓ %s\n" "$1"; }
miss() { printf "  ✗ %s\n" "$1"; fail=$((fail + 1)); }

echo "→ Verifying schema in $DB_USER@$DB_HOST:$DB_PORT/$DB_NAME"

# 1. Schemas
for s in core proc workflow audit reporting; do
  c=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tA \
    -c "SELECT count(*) FROM pg_namespace WHERE nspname='$s';")
  [ "$c" = "1" ] && pass "schema $s" || miss "schema $s missing"
done

# 2. Tables (compact list — one assertion per schema)
for schema in core proc workflow audit reporting; do
  expected=0
  case "$schema" in
    core) expected=18 ;; proc) expected=12 ;; workflow) expected=5 ;;
    audit) expected=1 ;; reporting) expected=4 ;;
  esac
  actual=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tA \
    -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='$schema';")
  if [ "$actual" -ge "$expected" ]; then
    pass "$schema tables = $actual (≥$expected)"
  else
    miss "$schema tables = $actual (expected ≥$expected)"
  fi
done

# 3. RLS forced on PR
rls=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tA \
  -c "SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='proc.purchase_requisitions'::regclass;")
[ "$rls" = "t" ] && pass "RLS forced on proc.purchase_requisitions" || miss "RLS not forced"

# 4. Audit append-only
rev=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tA \
  -c "SELECT has_table_privilege('app_user','audit.audit_log','UPDATE');")
[ "$rev" = "f" ] && pass "app_user cannot UPDATE audit.audit_log" || miss "app_user can UPDATE audit"

# 5. Key functions
for fn in proc.fn_next_pr_number proc.fn_check_pr_transition proc.fn_check_sod \
         proc.fn_compute_pr_totals proc.fn_pack_hash proc.fn_reject_pack_mutation \
         audit.fn_compute_hash_chain audit.fn_archive_old_audit \
         core.fn_current_user_id core.fn_bypass_rls core.fn_update_budget_reserved; do
  c=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tA \
    -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname=split_part('$fn','.',1) AND p.proname=split_part('$fn','.',2);")
  [ "$c" = "1" ] && pass "function $fn" || miss "function $fn missing"
done

# 6. Workflow steps
s=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tA \
  -c "SELECT count(*) FROM workflow.steps_config;")
[ "$s" -ge 12 ] && pass "workflow.steps_config = $s steps" || miss "workflow.steps_config = $s (expected ≥12)"

# 7. Demo data
for tc in "core.users:14" "core.vendors:3" "core.items:6" "core.departments:5" "proc.purchase_requisitions:1"; do
  tbl="${tc%%:*}"; exp="${tc##*:}"
  act=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tA -c "SELECT count(*) FROM $tbl;")
  if [ "$act" -ge "$exp" ]; then
    pass "$tbl = $act"
  else
    miss "$tbl = $act (expected ≥$exp)"
  fi
done

# 8. State machine rejects invalid transition
# Pick any PR and try to skip ahead — must fail. We don't filter by 'Draft'
# because the demo seed only ships with a Submitted PR; either way the engine
# must reject the leap from whatever current status to Pushed_To_D365.
pr_id=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tA \
  -c "SELECT id FROM proc.purchase_requisitions LIMIT 1;" | tr -d '[:space:]')
if [ -z "$pr_id" ]; then
  miss "no PR available to test state machine"
else
  cur_status=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tA \
    -c "SELECT status FROM proc.purchase_requisitions WHERE id='$pr_id';" | tr -d '[:space:]')
  if psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tA \
    -c "UPDATE proc.purchase_requisitions SET status='Pushed_To_D365' WHERE id='$pr_id';" >/dev/null 2>&1; then
    miss "state machine allowed ${cur_status} → Pushed_To_D365"
  else
    pass "state machine rejected ${cur_status} → Pushed_To_D365"
  fi
fi

# 9. Pack immutability
# Clean up any leftover test pack from a previous run so the INSERT below can
# succeed (pack pr_id is UNIQUE). We disable the no-delete trigger temporarily.
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAq \
  -c "ALTER TABLE proc.approved_packs DISABLE TRIGGER trg_approved_packs_no_delete;
      DELETE FROM proc.approved_packs WHERE frozen_by_user_id='33333333-3333-3333-3333-33333333330d';
      ALTER TABLE proc.approved_packs ENABLE TRIGGER trg_approved_packs_no_delete;" \
  >/dev/null 2>&1 || true
pack_id=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAq \
  -c "INSERT INTO proc.approved_packs (pr_id, pack_hash, payload, frozen_by_user_id)
      SELECT id,'sha256:test','{}'::jsonb,'33333333-3333-3333-3333-33333333330d'::uuid
        FROM proc.purchase_requisitions LIMIT 1 RETURNING id;" 2>/dev/null | head -n1 | tr -d '[:space:]' || true)
if [ -n "$pack_id" ]; then
  if psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAq \
    -c "UPDATE proc.approved_packs SET pack_hash='sha256:new' WHERE id='$pack_id';" >/dev/null 2>&1; then
    miss "approved_packs allowed UPDATE"
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAq -c "DELETE FROM proc.approved_packs WHERE id='$pack_id';" >/dev/null 2>&1 || true
  else
    pass "approved_packs rejected UPDATE"
    # Immutability trigger blocks DELETE — clean up by disabling it for the
    # test row only, then re-enable.
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAq \
      -c "ALTER TABLE proc.approved_packs DISABLE TRIGGER trg_approved_packs_no_delete;
          DELETE FROM proc.approved_packs WHERE id='$pack_id';
          ALTER TABLE proc.approved_packs ENABLE TRIGGER trg_approved_packs_no_delete;" \
      >/dev/null 2>&1 || true
  fi
else
  miss "could not insert test pack"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "✅ All checks passed."
  exit 0
else
  echo "❌ $fail check(s) failed."
  exit 1
fi
