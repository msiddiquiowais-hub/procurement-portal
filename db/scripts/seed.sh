#!/usr/bin/env bash
# seed.sh — load demo + reference data.

set -euo pipefail

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-55432}"
DB_USER="${DB_USER:-proc}"
DB_PASSWORD="${DB_PASSWORD:-proc_local}"
DB_NAME="${DB_NAME:-procurementDB}"

export PGPASSWORD="$DB_PASSWORD"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEED_FILE="$SCRIPT_DIR/../seeds/seed.sql"

if [ ! -f "$SEED_FILE" ]; then
  echo "❌ Seed file not found: $SEED_FILE" >&2
  exit 1
fi

echo "→ Loading seed data from $SEED_FILE into $DB_NAME"
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
     -v ON_ERROR_STOP=1 -q -f "$SEED_FILE"
echo "✓ Seed data loaded."
