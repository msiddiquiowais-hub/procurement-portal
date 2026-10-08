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

shopt -s nullglob
for f in "$MIGRATIONS_DIR"/*.sql; do
  fname="$(basename "$f")"

  already="$(psql_exec <<SQL
SELECT count(*) FROM public.schema_migrations WHERE filename = '$fname';
SQL
)"
  # psql -q still emits the value of a bare SELECT, so trim whatever came back.
  if [ "$(printf '%s' "$already" | tr -dc '0-9')" != "0" ]; then
    skipped=$((skipped + 1))
    printf '  = %-52s already applied\n' "$fname"
    continue
  fi

  printf '  + %-52s ' "$fname"
  if psql_exec < "$f" >/dev/null; then
    psql_exec <<SQL >/dev/null
INSERT INTO public.schema_migrations (filename) VALUES ('$fname');
SQL
    printf 'OK\n'
    applied=$((applied + 1))
  else
    printf 'FAIL\n'
    echo "Migration failed: $fname" >&2
    echo "The ledger was NOT updated, so it will be retried on the next deploy." >&2
    exit 1
  fi
done

echo "Applied $applied migration(s); $skipped already present."