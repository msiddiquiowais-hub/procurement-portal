# syntax=docker/dockerfile:1
#
# Procurement Portal — Public onboarding pages (Next.js)
# Build context: the REPOSITORY ROOT (this file lives in docker/).
#   docker build -f docker/onboarding.Dockerfile -t procurement/onboarding .
#
# This app has no workspace-package dependencies (see apps/onboarding/package.json),
# so it is the simplest of the three to build. It is kept as its own image because
# the vendor-facing onboarding URL must be reachable without exposing the admin
# surface on the same port.

FROM node:20-bookworm-slim AS build
WORKDIR /repo

# Inlined into the client bundle at build time. See web.Dockerfile for why the
# fallback to http://localhost:33001 must never be allowed to win.
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

# tsconfig.base.json is required: apps/onboarding/tsconfig.json extends it, and
# without it `next build` fails with TS5083 before compiling anything.
COPY tsconfig.base.json ./
COPY apps/onboarding ./apps/onboarding
RUN npm run build -w apps/onboarding

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

# curl is used by the HEALTHCHECK below.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
ENV NODE_ENV=production

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/onboarding/package.json   ./apps/onboarding/package.json
COPY --from=build /repo/apps/onboarding/.next          ./apps/onboarding/.next
COPY --from=build /repo/apps/onboarding/next.config.js ./apps/onboarding/next.config.js

# The container listens on 3000; the compose file maps it to the public port.
ENV ONBOARDING_PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${ONBOARDING_PORT}/" || exit 1

WORKDIR /repo/apps/onboarding
CMD ["npx", "next", "start", "-p", "3000"]