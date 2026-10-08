#!/usr/bin/env bash
# migrate.sh — apply db/migrations/*.sql exactly once each, tracked in a ledger.
#
#   ./deploy/migrate.sh
#
# ── Why not just run every file every time? ──────────────────────────────────
# db/scripts/migrate.sh (the laptop script) replays the whole directory on every
# invocation. All the DDL in this repo is written drop-then-create, so the
# CREATE statements survive a replay — but the INSERT statements (roles,
# fx_rates, steps_config, dimension libraries) collide on their primary keys and
# abort the run. On a deploy loop that means the second push fails and, because
# the script exits non-zero, the new images never come up.
#
# So this version records what has been applied in public.schema_migrations and
# only runs new files. It is safe to run on every deploy.
#
# ── How the SQL reaches Postgres ──────────────────────────────────────────────
# Statements are piped into the database the same way DbService does it:
#   docker exec -i <container> psql -f -
# which keeps this script working on a host that has no local psql client, and
# keeps it consistent with how the API itself talks to the database.

set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-procurement-portal-db}"
DB_USER="${DB_USER:-proc}"
DB_NAME="${DB_NAME:-procurementDB}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/db/migrations"

psql_exec() {
  docker exec -i "$PG_CONTAINER" psql \
    -U "$DB_USER" -d "$DB_NAME" \
    -X -q -v ON_ERROR_STOP=1 -f -
}

# Run one scalar query and return its single value, with nothing else.
#
# `-t -A -q` (tuples-only, unaligned, quiet) is required, not cosmetic. The
# default psql output for `SELECT count(*) ...` is:
#
#        count
#     -------
#        0
#     (1 row)
#
# so stripping non-digits yields "01", which is not equal to "0" — and a
# not-yet-applied migration gets skipped on an empty ledger. The first deploy
# then silently applies nothing and reports 55 migrations as already present.
# -A drops the header/rule/footer; -t drops the "(1 row)" footer.
scalar_query() {
  docker exec -i "$PG_CONTAINER" psql \
    -U "$DB_USER" -d "$DB_NAME" \
    -X -q -t -A -v ON_ERROR_STOP=1 -f - \
    | tr -d '[:space:]'
}

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "Migrations directory not found: $MIGRATIONS_DIR" >&2
  exit 1
fi

if ! docker inspect "$PG_CONTAINER" >/dev/null 2>&1; then
  echo "Container '$PG_CONTAINER' does not exist." >&2
  echo "Start the stack first:  docker compose -f docker-compose.vps.yml --env-file deploy/env.vps up -d postgres" >&2
  exit 1
fi

echo "Waiting for '$PG_CONTAINER' to accept connections..."
for i in $(seq 1 30); do
  if docker exec "$PG_CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "Postgres did not become ready within 30s." >&2
    docker logs --tail 40 "$PG_CONTAINER" >&2 || true
    exit 1
  fi
  sleep 1
done

psql_exec <<'SQL' >/dev/null
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

applied=0
skipped=0

# ── Bootstrap mode ────────────────────────────────────────────────────────────
# On a brand-new database the migrations CANNOT all succeed before the seed runs:
# migration 036 asserts that seeded vendors land in the High/Low risk bands, and
# those vendor rows (V-00081 … V-00086) are created only by db/seeds/seed.sql.
# On the laptop this never surfaced because the database was built up over weeks,
# with the seed re-run in between.
#
# So when the ledger is empty we run in two phases:
#   1. best-effort — apply what can be applied, do NOT abort on failure
#   2. seed the reference data
#   3. strict — re-apply whatever is still pending, and this time a failure is
#      a real failure
#
# This is safe because every migration wraps itself in BEGIN/COMMIT, so a failed
# one rolls back completely and leaves nothing half-applied.
# Load reference / demo data.
#
# NOT optional. Several migrations assert on rows that only this file inserts:
# 036 requires at least one seeded vendor in the High risk band, one in Low, and
# exactly one C/C/B graded High. Those vendors (V-00081 … V-00086) are never
# created by a migration. Against an empty database, 036 aborts on its own
# post-condition with "no seeded vendor lands in the High band".
#
# seed.sql is written to be re-runnable (ON CONFLICT DO NOTHING throughout),
# which is what lets this run on every deploy.
seed_data() {
  SEED_FILE="$REPO_ROOT/db/seeds/seed.sql"
  if [ ! -f "$SEED_FILE" ]; then
    echo "WARNING: $SEED_FILE not found; migrations that assert on seeded rows will fail." >&2
    return 0
  fi
  printf '  + %-52s ' "seeds/seed.sql"
  if psql_exec < "$SEED_FILE" >/dev/null 2>&1; then
    printf 'OK\n'
  else
    printf 'FAIL\n'
    echo "Seed failed. Migrations depend on the seeded vendors, so this must succeed." >&2
    exit 1
  fi
}

ledger_count="$(scalar_query <<SQL
SELECT count(*) FROM public.schema_migrations;
SQL
)"

BOOTSTRAP=0
if [ "${ledger_count:-0}" = "0" ]; then
  BOOTSTRAP=1
  echo "Empty ledger — bootstrapping a new database (migrate -> seed -> migrate)."
fi

apply_pending() {
  # $1 = "strict" (abort on failure) or "best-effort" (collect and continue)
  local mode="$1"
  local failures=0
  for f in "$MIGRATIONS_DIR"/*.sql; do
    fname="$(basename "$f")"

    already="$(scalar_query <<SQL
SELECT count(*) FROM public.schema_migrations WHERE filename = '$fname';
SQL
)"
    if [ "$already" != "0" ]; then
      skipped=$((skipped + 1))
      printf '  = %-52s already applied\n' "$fname"
      continue
    fi

    printf '  + %-52s ' "$fname"
    # Apply the SQL and record it in ONE psql session.
    #
    # Two things constrain how this is written:
    #
    #  * The SQL is piped in rather than included with `\i`. psql runs INSIDE the
    #    postgres container, so a repo path like db/migrations/ does not exist
    #    from its point of view. Piping on stdin also keeps psql meta-commands
    #    (054 uses \set / \echo) working.
    #
    #  * There is no surrounding BEGIN/COMMIT here. Every migration already brings
    #    its own transaction control, and nesting another BEGIN would make the
    #    migration's own COMMIT end the outer transaction early — the ledger insert
    #    would then run outside it and the "all or nothing" guarantee would be a
    #    lie. ON_ERROR_STOP=1 is what actually makes a failure abort.
    {
      cat "$f"
      printf "\nINSERT INTO public.schema_migrations (filename) VALUES ('%s');\n" "$fname"
    } | psql_exec >/dev/null 2>&1 \
      && { printf 'OK\n'; applied=$((applied + 1)); } \
      || {
        printf 'FAIL\n'
        if [ "$mode" = "strict" ]; then
          echo "Migration failed: $fname" >&2
          echo "The ledger was NOT updated, so it will be retried on the next deploy." >&2
          exit 1
        fi
        failures=$((failures + 1))
      }
  done
  return $failures
}

shopt -s nullglob

if [ "$BOOTSTRAP" = "1" ]; then
  apply_pending "best-effort" || true
  echo "  (deferred failures will be retried after seeding)"
  seed_data
  apply_pending "strict"
else
  apply_pending "strict"
  # A deploy may ship corrected reference data, and seed.sql is safe to re-run.
  seed_data
fi

echo "Applied $applied migration(s); $skipped already present."