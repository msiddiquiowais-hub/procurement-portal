# Procurement Web Portal

Local-dev stack for the **Procurement Web Portal** — covers purchase requisitions,
RFQ/CS workflow, warehouse + management gates, D365 F&O push, and audit-trail.

## Stack
- **Postgres 16** (Docker, host port `55432`, container `procurement-portal-db`, db `procurementDB`)
- **NestJS API** (`apps/api`, host port `33001`) — JWT auth, PR module, workflow engine, D365 client
- **Next.js web admin** (`apps/web`, host port `33002`) — login, PR list, PR create, HOD approve
- **Next.js public onboarding** (`apps/onboarding`, host port `33004`)
- **Shared libs** — `@procurement/workflow-engine` (TS port of `DEFAULT_WORKFLOW_STEPS` + predicates), `@procurement/d365-client` (stub adapter)

## Why these ports
The user's laptop already has:
- `qc-postgres` on 5432 / 5433
- `open-webui` on 3000
- `n8n` on 5678

The Procurement stack reserves `55432` for Postgres and `33001`–`33004` for app services.

## Quick start

```bash
# 1. Postgres
cp .env.example .env
docker compose -f db/docker/docker-compose.yml up -d
bash db/scripts/migrate.sh      # or: docker exec -i procurement-portal-db psql -U proc -d procurementDB < db/migrations/001_*.sql
bash db/scripts/seed.sh
bash db/scripts/verify.sh       # 28/28 checks

# 2. Backend + apps
npm install                     # workspace install (root + apps + packages)
npm run api:dev                 # NestJS on :33001
npm run web:dev                 # web admin on :33002
npm run onboarding:dev          # public onboarding on :33004

# 3. Smoke test (login → PR create → HOD approve → push to D365)
npm run smoke
```

## End-to-end smoke flow

The `scripts/smoke.mjs` script:
1. Logs in as `requester@pakboxes.pk`, creates a PR with two cardboard lines.
2. Verifies the PR is `Submitted`.
3. Logs in as `hod.sales@pakboxes.pk`, advances the PR (no warehouse flag) → expects `IN_PROCUREMENT_REVIEW`.
4. Logs in as `hod.sales@pakboxes.pk` again on a fresh PR, this time **with `wantWarehouse: true`** → expects `IN_WAREHOUSE_CHECK` (regression for the warehouse-routing fix).
5. Pushes a D365_READY PR to the stub D365 adapter → expects `D365_PUSHED` with a fake PO number.

## Demo logins (any password works locally)

| Role | Email |
|---|---|
| requester | requester@pakboxes.pk |
| HOD (sales) | hod.sales@pakboxes.pk |
| procurement | procurement@pakboxes.pk |
| CS | cs@pakboxes.pk |
| cost-center | cost.center@pakboxes.pk |
| finance | finance@pakboxes.pk |
| MC member | mc.member1@pakboxes.pk |
| CFO | cfo@pakboxes.pk |
| audit (read-only) | audit@pakboxes.pk |
| admin (alias) | admin@pakboxes.pk |
| vendor | vendor1@example.com |

## Project layout

```
procurement-portal/
├─ apps/
│  ├─ api/                  NestJS API
│  ├─ web/                  Next.js admin UI (login, dashboard, PR create, PR detail)
│  └─ onboarding/           Next.js public onboarding form
├─ packages/
│  ├─ workflow-engine/      TS port of DEFAULT_WORKFLOW_STEPS + predicates + engine
│  └─ d365-client/          D365 F&O adapter (stub by default)
├─ db/
│  ├─ docker/docker-compose.yml
│  ├─ migrations/001..016_*.sql
│  ├─ seeds/seed.sql
│  └─ scripts/{migrate,seed,reset,verify}.sh
├─ scripts/smoke.mjs        End-to-end smoke test
└─ package.json             Workspace root
```

## Where to read next

- `PROCUREMENT_PORTAL_PRD.md` (in workspace root) — 27 sections, 108 FRs.
- `PROCUREMENT_PORTAL_SDD.md` — architecture, data model, sequence flows, 13 ADRs.
- `PROCUREMENT_PORTAL_DATABASE.md` — schemas, tables, RLS, materialized views.
- `PROCUREMENT_PORTAL_IMPLEMENTATION_PLAN.md` — 24-week phased build.

## Notes on the workflow engine

`packages/workflow-engine/src/steps.ts` is the canonical port of the live
`PROCUREMENT_PORTAL_PROTOTYPE.html` workflow. The DB's `workflow.steps_config`
table holds the live (admin-editable) copy. Predicates read **both** the PR-side
persistent flag (`warehouseCheckRequired`) and the per-call decision flag
(`decision.wantWarehouse`) — the warehouse-routing regression fix.
