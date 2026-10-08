#!/usr/bin/env bash
# deploy.sh — build, migrate, roll. Runs ON the VPS.
#
#   ./deploy/deploy.sh            # normal deploy (used by GitHub Actions)
#   ./deploy/deploy.sh --no-build # roll existing images, skip the rebuild
#
# Exit code 0 = deployed and verified. Non-zero = the old stack is left running
# and the script stops, so a bad push cannot take the test site down.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

COMPOSE_FILE="docker-compose.vps.yml"
ENV_FILE="deploy/env.vps"
BUILD=1
[ "${1:-}" = "--no-build" ] && BUILD=0

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE — copy deploy/env.vps.example and edit it first." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

COMPOSE="docker compose -f $COMPOSE_FILE --env-file $ENV_FILE"

# Tag each build with the short SHA so a rollback is possible and so `docker
# images` shows what is actually running.
DEPLOY_TAG="${DEPLOY_TAG:-$(git rev-parse --short HEAD 2>/dev/null || echo local)}"
export DEPLOY_TAG
echo "=== Deploying tag $DEPLOY_TAG ==="

echo "--- Building images ---"
if [ "$BUILD" = "1" ]; then
  $COMPOSE build --pull
else
  echo "skipped (--no-build)"
fi

echo "--- Starting database ---"
# Migrations need a live database but not the API, so bring postgres up first.
$COMPOSE up -d postgres

echo "--- Applying migrations ---"
PG_CONTAINER="${PG_CONTAINER:-procurement-portal-db}" \
DB_USER="${DB_USER:-proc}" \
DB_NAME="${DB_NAME:-procurementDB}" \
  "$SCRIPT_DIR/migrate.sh"

echo "--- Rolling application containers ---"
# Only recreate what changed. Postgres keeps running, so the database is not
# bounced on every push.
$COMPOSE up -d --remove-orphans

echo "--- Waiting for health ---"
failed=0
for service in api web onboarding; do
  cid="$($COMPOSE ps -q "$service" 2>/dev/null || true)"
  if [ -z "$cid" ]; then
    echo "  x $service (no container)"
    failed=1
    continue
  fi
  printf '  %-12s ' "$service"
  healthy=""
  for i in $(seq 1 40); do
    state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo missing)"
    case "$state" in
      healthy|running) healthy=1; break ;;
      unhealthy|exited|missing)
        echo "FAILED ($state)"
        $COMPOSE logs --tail 30 "$service" || true
        failed=1
        break
        ;;
    esac
    sleep 3
  done
  [ -n "$healthy" ] && echo "OK"
done

if [ "$failed" != "0" ]; then
  echo ""
  echo "Deploy FAILED. The previous containers are still defined; inspect with:"
  echo "  $COMPOSE ps"
  echo "  $COMPOSE logs --tail 100 api"
  exit 1
fi

echo ""
echo "=== Deployed $DEPLOY_TAG ==="
echo "Web admin  : ${PUBLIC_WEB_URL:-http://<VPS_IP>:${WEB_PUBLIC_PORT:-8080}}"
echo "Onboarding : http://<VPS_IP>:${ONBOARDING_PUBLIC_PORT:-8081}"
echo "API        : ${NEXT_PUBLIC_API_BASE}"
echo ""
echo "Live log tail:  docker logs -f ${PG_CONTAINER:-procurement-portal-db}"