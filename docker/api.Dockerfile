# syntax=docker/dockerfile:1
#
# Procurement Portal — API (NestJS)
# Build context: the REPOSITORY ROOT (this file lives in docker/).
#   docker build -f docker/api.Dockerfile -t procurement/api .
#
# ── WHY THIS IMAGE CARRIES THE DOCKER CLI ────────────────────────────────────
# DbService does not use the `pg` driver at runtime. Every single statement is
# executed by spawning `docker exec -i <PG_CONTAINER> psql ...`
# (apps/api/src/db/db.service.ts). That is a deliberate local-dev workaround for
# a WSL/Docker host-TCP relay, and the file says so — but it means this image is
# NOT a normal database client. It needs all three of:
#
#   1. a docker client binary            -> copied in below
#   2. /var/run/docker.sock mounted      -> set in docker-compose.vps.yml
#   3. a container literally named
#      `procurement-portal-db` on a
#      shared docker network             -> set in docker-compose.vps.yml
#
# Drop any one of those and every request that touches the database fails at
# runtime — the container starts, `/health` still answers 200 (it never queries),
# and the failure only appears once a real page loads.
#
# THE RIGHT LONG-TERM FIX is to make DbService use `pg` (already a dependency) and
# drop the docker-exec transport. That is a code change, deliberately NOT taken
# here, because swapping a live query transport is not a deploy-config change.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:20-bookworm-slim AS build
WORKDIR /repo

# Manifests first: `npm ci` is only re-run when a dependency actually changes.
COPY package.json package-lock.json ./
COPY apps/api/package.json         apps/api/package.json
COPY apps/web/package.json         apps/web/package.json
COPY apps/onboarding/package.json  apps/onboarding/package.json
COPY packages/roles/package.json           packages/roles/package.json
COPY packages/workflow-engine/package.json packages/workflow-engine/package.json
COPY packages/d365-client/package.json     packages/d365-client/package.json
RUN npm ci

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api

# Order matters. The API resolves @procurement/* through the node_modules
# symlinks that point at packages/<name>/dist, so the libraries must already be
# compiled or `tsc` cannot find their type declarations.
#
# @procurement/roles is NOT listed in apps/api/package.json dependencies, but the
# API imports `roleAllowed` from it in ~18 services. It compiled here only
# because the whole workspace tree is present in the build stage — which meant
# the missing dependency stayed invisible until runtime, where every one of
# those services failed to load. All three workspace packages must be built.
RUN npm run build -w packages/workflow-engine \
 && npm run build -w packages/d365-client \
 && npm run build -w packages/roles \
 && npm run build -w apps/api


# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

# The docker CLI *binary only* — no daemon, no containerd. This is what
# DbService shells out to. `docker:27-cli` is a distroless-ish image whose only
# payload is the static client, so copying one file is enough.
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker

# curl is used by the HEALTHCHECK below.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
ENV NODE_ENV=production \
    API_PORT=3000 \
    PG_CONTAINER=procurement-portal-db

# node_modules carries the workspace symlinks (node_modules/@procurement/* ->
# ../../packages/* and ../../apps/*), so the package directories below are what
# those links resolve to. They must be copied, not just the dist folders.
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/workflow-engine/package.json ./packages/workflow-engine/package.json
COPY --from=build /repo/packages/workflow-engine/dist         ./packages/workflow-engine/dist
COPY --from=build /repo/packages/d365-client/package.json     ./packages/d365-client/package.json
COPY --from=build /repo/packages/d365-client/dist             ./packages/d365-client/dist
# @procurement/roles is imported by ~18 API services but is missing from
# apps/api/package.json's dependency list. It must be present at runtime or every
# one of those services throws MODULE_NOT_FOUND on first use.
COPY --from=build /repo/packages/roles/package.json           ./packages/roles/package.json
COPY --from=build /repo/packages/roles/dist                   ./packages/roles/dist
COPY --from=build /repo/apps/api/package.json                 ./apps/api/package.json
COPY --from=build /repo/apps/api/dist                         ./apps/api/dist

EXPOSE 3000

# NOTE: /health returns {"ok":true} without touching the database, so this proves
# the Nest process is alive but NOT that the docker-socket/psql path works. The
# deploy script additionally hits a real database-backed endpoint for that.
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${API_PORT}/health" || exit 1

CMD ["node", "apps/api/dist/main.js"]