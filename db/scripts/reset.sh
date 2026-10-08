#!/usr/bin/env bash
# reset.sh — drop and recreate the database, then re-apply migrations + seed.
# ⚠️  DESTROYS ALL DATA. Dev only.

set -euo pipefail

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-55432}"
DB_USER="${DB_USER:-proc}"
DB_PASSWORD="${DB_PASSWORD:-proc_local}"
DB_NAME="${DB_NAME:-procurementDB}"

export PGPASSWORD="$DB_PASSWORD"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "⚠️  Dropping database '$DB_NAME' on $DB_HOST:$DB_PORT ..."
# The identifier MUST be quoted. Unquoted, PostgreSQL folds it to lowercase, so
# `DROP DATABASE IF EXISTS procurementDB` targets "procurementdb" — a different
# database from the "procurementDB" that `psql -d procurementDB` connects to.
# That bug silently dropped and recreated a decoy while the real database kept
# every stale row, so the next run failed on pre-existing data as if it were a
# migration bug.
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres \
     -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$DB_NAME\";"
echo "→ Creating fresh database '$DB_NAME' ..."
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres \
     -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DB_NAME\";"

"$SCRIPT_DIR/migrate.sh"
"$SCRIPT_DIR/seed.sh"

echo "✓ Reset complete: $DB_NAME is fresh and seeded."
