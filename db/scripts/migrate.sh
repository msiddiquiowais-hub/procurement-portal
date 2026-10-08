#!/usr/bin/env bash
# migrate.sh — apply all *.sql files in db/migrations in lexical order.
#
# Usage:
#   ./db/scripts/migrate.sh
#
# Defaults target the local Docker stack (host 55432, db procurementDB).

set -euo pipefail

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-55432}"
DB_USER="${DB_USER:-proc}"
DB_PASSWORD="${DB_PASSWORD:-proc_local}"
DB_NAME="${DB_NAME:-procurementDB}"

export PGPASSWORD="$DB_PASSWORD"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="$SCRIPT_DIR/../migrations"

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "❌ Migrations directory not found: $MIGRATIONS_DIR" >&2
  exit 1
fi

echo "→ Applying migrations from $MIGRATIONS_DIR to $DB_USER@$DB_HOST:$DB_PORT/$DB_NAME"

shopt -s nullglob
applied=0
for f in "$MIGRATIONS_DIR"/*.sql; do
  fname="$(basename "$f")"
  printf "  ▸ %-50s " "$fname"
  if psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
         -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null; then
    printf "OK\n"
    applied=$((applied + 1))
  else
    printf "FAIL\n"
    exit 1
  fi
done

echo "✓ Applied $applied migration(s)."
