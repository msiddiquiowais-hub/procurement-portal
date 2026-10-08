# syntax=docker/dockerfile:1
#
# Procurement Portal — Web admin (Next.js)
# Build context: the REPOSITORY ROOT (this file lives in docker/).
#   docker build -f docker/web.Dockerfile -t procurement/web .
#
# ── WHY THERE IS NO `output: 'standalone'` ────────────────────────────────────
# apps/web depends on @procurement/roles, an npm *workspace* package that is
# symlinked into node_modules. Next's standalone output tracer is known to drop
# symlinked workspace dependencies, which produces a server that boots and then
# fails on the first import of the roles module. For a test deployment a
# dependable ~600 MB image beats a broken 150 MB one, so this image ships the
# full node_modules tree and runs plain `next start` — byte-for-byte the same
# code path that already works on the dev machine.
# Revisit standalone once the app stops consuming workspace packages.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:20-bookworm-slim AS build
WORKDIR /repo

# Inlined into the client bundle at build time. Declared as an ARG so
# `docker compose build --build-arg` can supply the real VPS address; without it
# next.config.js silently falls back to http://localhost:33001 and every API call
# from a tester's browser is aimed at their own laptop.
ARG NEXT_PUBLIC_API_BASE
ENV NEXT_PUBLIC_API_BASE=${NEXT_PUBLIC_API_BASE}

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
COPY apps/web ./apps/web

# @procurement/roles resolves through its dist/, so it compiles first.
RUN npm run build -w packages/roles \
 && npm run build -w apps/web

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

# curl is used by the HEALTHCHECK below.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
ENV NODE_ENV=production

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/roles/package.json ./packages/roles/package.json
COPY --from=build /repo/packages/roles/dist         ./packages/roles/dist
COPY --from=build /repo/apps/web/package.json       ./apps/web/package.json
COPY --from=build /repo/apps/web/.next              ./apps/web/.next
COPY --from=build /repo/apps/web/next.config.js     ./apps/web/next.config.js

# The container listens on 3000; the compose file maps it to the public port.
ENV WEB_ADMIN_PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${WEB_ADMIN_PORT}/" || exit 1

WORKDIR /repo/apps/web
CMD ["npx", "next", "start", "-p", "3000"]