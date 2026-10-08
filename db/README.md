# Procurement Portal — Database

Postgres 15 schema for the **Procurement Web Portal**. Implements the DB
structure described in `PROCUREMENT_PORTAL_DATABASE.md` and the implementation
plan in `PROCUREMENT_PORTAL_IMPLEMENTATION_PLAN.md`.

---

## What's in this folder

```
db/
├── docker/
│   ├── docker-compose.yml         # Postgres 15 stack for local dev
│   └── postgresql.conf            # Dev-tuned Postgres config
├── migrations/                    # Schema migrations (applied in lexical order)
│   ├── 001_extensions_schemas_roles.sql
│   ├── 002_core_identity.sql              # users, departments, cost_centers, projects, files, fx, delegations
│   ├── 003_vendors.sql                    # vendors + documents + DD + blacklist + performance
│   ├── 004_items_budgets_authority.sql    # items, budgets, authority matrix
│   ├── 005_notifications.sql              # notifications + templates + outbox
│   ├── 006_proc_purchase_requisitions.sql # PR + lines + amendments + attachments + state machine
│   ├── 007_audit_log.sql                  # append-only audit_log + privilege hardening
│   ├── 008_workflow_steps_config.sql      # workflow.steps_config + per-PR snapshots
│   ├── 009_workflow_votes_escalations.sql # approval_votes + mc_sessions + escalations
│   ├── 010_proc_rfq_quotations.sql        # RFQ + invitations + quotations + negotiation
│   ├── 011_proc_cs.sql                    # comparative statements + scoring lines
│   ├── 012_proc_pack_d365.sql             # approved_packs (immutable) + d365_pushes + sync log
│   ├── 013_reporting_tables.sql           # KPI + savings + scorecard history
│   ├── 014_rls_audit_triggers.sql         # RLS policies + audit emission + budget consistency
│   ├── 015_materialized_views.sql         # mv_pr_cycle_time + mv_push_success_daily + ...
│   └── 016_audit_hash_chain_archival.sql  # tamper-evidence hash chain + cold storage
├── seeds/
│   └── seed.sql                    # Demo users + vendors + items + 1 sample PR
└── scripts/
    ├── migrate.sh                  # Apply all migrations in order
    ├── seed.sh                     # Load demo data
    ├── reset.sh                    # DROP + recreate + migrate + seed (⚠️ destroys data)
    └── verify.sh                   # 60+ schema + behaviour checks
```

---

## Quickstart (Docker)

```bash
# 1. Bring up Postgres 15
docker compose -f db/docker/docker-compose.yml up -d

# 2. Wait for the container to be healthy
docker compose -f db/docker/docker-compose.yml ps

# 3. Apply all migrations
./db/scripts/migrate.sh

# 4. Load demo data
./db/scripts/seed.sh

# 5. Verify
./db/scripts/verify.sh

# 6. Connect
docker compose -f db/docker/docker-compose.yml exec postgres \
  psql -U proc -d proc_portal
```

Or in one go (after `docker compose up -d`):
```bash
./db/scripts/migrate.sh && ./db/scripts/seed.sh && ./db/scripts/verify.sh
```

---

## Quickstart (existing Postgres)

```bash
export DB_HOST=localhost DB_PORT=5432 DB_USER=proc DB_PASSWORD=proc_local DB_NAME=proc_portal
createdb -h $DB_HOST -U $DB_USER $DB_NAME
./db/scripts/migrate.sh
./db/scripts/seed.sh
./db/scripts/verify.sh
```

---

## Demo logins (seeded)

| Email | Role | Sees |
|---|---|---|
| `requester@pakboxes.pk` | requester | own PRs in PKB-LHR-001 |
| `hod.sales@pakboxes.pk` | hod | PKB-LHR-001 inbox |
| `procurement@pakboxes.pk` | procurement | all cost-centers |
| `cs@pakboxes.pk` | cs | all cost-centers |
| `cost.center@pakboxes.pk` | cost_center_owner | PKB-LHR-001 |
| `finance@pakboxes.pk` | finance | all |
| `mc.member1@pakboxes.pk`, `mc.member2@pakboxes.pk` | mc | parallel voting |
| `cfo@pakboxes.pk` | cfo | > 1M approvals |
| `audit@pakboxes.pk` | audit | read-only |
| `admin@pakboxes.pk` | admin | super-role alias — all screens |

Passwords are not seeded (use Azure AD SSO in dev). For supplier-portal testing, the seed includes `vendor1@example.com` and `vendor2@example.com` (role = `vendor`).

---

## Demo PR

A sample `Submitted` PR with two lines (cardboard sheets) is seeded in
`proc.purchase_requisitions` so you can immediately exercise the HOD approve
flow.

```sql
SET app.current_user_id = '33333333-3333-3333-3333-333333333302';
SET app.user_role       = 'hod';
SET app.bypass_rls      = 'false';

-- Should show PR-2026-00001 in 'Submitted' state
SELECT pr_number, status, estimated_amount, scope
  FROM proc.purchase_requisitions
 WHERE status = 'Submitted';
```

---

## Key features wired up

| Feature | Where |
|---|---|
| **Append-only audit log** | `audit.audit_log` with INSERT-only grant to `audit_writer` |
| **PR state machine** | `proc.fn_check_pr_transition()` + trigger `trg_prs_status_transition` |
| **Pack immutability** | `proc.fn_reject_pack_mutation()` + `trg_approved_packs_no_update/delete` |
| **RLS on PR** | `prs_visibility` policy on `proc.purchase_requisitions` |
| **SoD helper** | `proc.fn_check_sod(pr_id, voter)` |
| **Budget reservation consistency** | `core.fn_update_budget_reserved()` |
| **Idempotent D365 push** | UNIQUE on `proc.d365_pushes.idempotency_key` |
| **Live workflow engine seed** | 12 steps in `workflow.steps_config` mirroring the live prototype |
| **Hash chain** | `audit.fn_compute_hash_chain()` for tamper-evidence |
| **Materialized KPI views** | `mv_pr_cycle_time`, `mv_push_success_daily`, `mv_savings_monthly`, `mv_vendor_scorecard_quarterly` |
| **Sealed-bid integrity** | `sealed_hash` + `open_at` on `proc.quotations` |
| **FX normalization** | `core.fx_rates` table for currency conversion |

---

## Refreshing materialized views (nightly cron)

```sql
-- Run at 02:30 PKT
REFRESH MATERIALIZED VIEW CONCURRENTLY reporting.mv_pr_cycle_time;
REFRESH MATERIALIZED VIEW CONCURRENTLY reporting.mv_push_success_daily;
REFRESH MATERIALIZED VIEW CONCURRENTLY reporting.mv_savings_monthly;
REFRESH MATERIALIZED VIEW CONCURRENTLY reporting.mv_vendor_scorecard_quarterly;

-- Audit hash chain
SELECT audit.fn_compute_hash_chain();

-- Old audit archival (rarely)
SELECT audit.fn_archive_old_audit();
```

---

## Reset (DESTROYS data)

```bash
./db/scripts/reset.sh
```

Equivalent to: drop DB → create DB → migrate → seed.

---

## Troubleshooting

- **`psql: error: connection to server ... failed`** → Postgres isn't up. Run `docker compose -f db/docker/docker-compose.yml up -d`.
- **`extension "pg_trgm" does not exist`** → Make sure you're on Postgres 15+. The migration uses `CREATE EXTENSION IF NOT EXISTS`.
- **RLS blocking your queries** → Set `app.bypass_rls = 'true'` per session (service role only) **or** set `app.current_user_id`, `app.user_role`, `app.user_cost_centers`.
- **`check_violation` on PR status update** → You're attempting an invalid transition. The state machine is locked down.

---

## References

- `PROCUREMENT_PORTAL_PRD.md` — product scope + acceptance criteria
- `PROCUREMENT_PORTAL_SDD.md` — software design (engine semantics, D365 client, security)
- `PROCUREMENT_PORTAL_DATABASE.md` — full DB spec (50+ tables, RLS, materialized views)
- `PROCUREMENT_PORTAL_IMPLEMENTATION_PLAN.md` — 24-week phased build plan
