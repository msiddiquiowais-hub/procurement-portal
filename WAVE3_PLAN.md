# Wave 3 — Governance · Plan for review

**Status:** APPROVED 2026-09-30. Decisions 1A, 2A and F1-F4 locked. Executing.
**Predecessor:** Wave 2 (sourcing) complete — 8/8 steps, 110 unit + 427 e2e + 27 DB green.
**Directive:** fidelity port of `PROCUREMENT_PORTAL_PROTOTYPE.html`. The prototype is
the source of truth. Schema is corrected to match the prototype, never the reverse.

---

## 1. Scope

Per `PROCUREMENT_PORTAL_PORT_GAP_MATRIX.md:388-391`, Wave 3 is:

| Screen | Prototype render fn | Prototype line |
|---|---|---|
| `mc-vote` | `renderMCVote` | 7866 |
| `cfo-approve` | `renderCFO` | 7894 |
| `pack` (deferred from Wave 2) | `renderPack` | 7920 |
| `d365-push` | `renderD365Push` | 7953 |
| `d365-status` | `renderD365Status` | 8020 |

Five pages. Behaviour driven by `mcVote` (7221), `mcAutoComplete` (7251),
`cfoDecide` (7264), `packLock` (7281), `d365Push` (7292).

**Web routes go 16 → 21.** `Shell.tsx` `ROUTES` gains 5 entries; the 5 matching
`PENDING` labels ("Wave 3" / "Wave 2") are removed so the sidebar items become live.

### Out of scope (deliberately)

- **BOARD routing gate.** The prototype itself calls this a simplification
  (comment at line 7236: *"For prototype simplicity: MC_APPROVED is next for both
  STANDARD and BOARD"*) and there is no Board screen among the 33. The Board text is
  ported as text; no Board vote is cast. See §7, F4.
- **Supplier-side anything** (Wave 4), **admin/master data** (Wave 5),
  **reporting/audit** (Wave 6).
- **Live D365 credentials.** `D365_MODE=stub` remains the default. Wave 3 makes the
  *bookkeeping* real, not the ERP.

---

## 2. The governance chain

The prototype's stage machine (`STAGES`, line 1500) is:

```
DRAFT → SUBMITTED → HOD_APPROVED → QUOTES_RECEIVED
      → CS_LOCKED → MC_APPROVED → CFO_APPROVED → PACK_LOCKED → D365_PUSHED
```

With one shortcut at line 7205: a FAST_TRACK CS lock jumps `CS_LOCKED → PACK_LOCKED`,
skipping MC and CFO. That shortcut is **already implemented** (Decision 10) in
`cs.service.ts:326`.

### The problem (this is the blocking decision)

**None of the four governance stages exist in the database or the engine.**

- `db/migrations/020_line_routing.sql:32-50` — `purchase_requisitions_status_check`
  has 34 permitted values. The closest are the dormant v1 names `MC_Submitted`,
  `MC_Approved`, `CFO_Approved`, `Final_Approved`, `Pushed_To_D365` — **none of which
  the prototype emits**, and none of which the engine can set.
- `020_line_routing.sql:65-89` — `fn_check_pr_transition()` has **no branch** that
  reaches any governance stage. `IN_PROCUREMENT_REVIEW` may only go to
  `IN_COST_CENTER_APPROVAL`, `Rejected`, `REJECTED`, `Cancelled`.
- `packages/workflow-engine/src/types.ts` — the `Stage` union (18 members) contains
  no `CS_LOCKED` / `MC_APPROVED` / `CFO_APPROVED` / `PACK_LOCKED`.

So Wave 3 cannot record a single prototype transition without a schema change.
See §3 for the three candidate fixes and the recommendation.

---

## 3. Decision 1 — stage vocabulary — ✅ **APPROVED: Option A** (user, 2026-09-30)

### Option A — adopt the prototype's four stage names as first-class DB values ★ ADOPTED

Migration `027` adds `CS_LOCKED`, `MC_APPROVED`, `CFO_APPROVED`, `PACK_LOCKED` to the
CHECK and adds the matching branches to `fn_check_pr_transition()`; the engine's
`Stage` union gains the same four members.

```
IN_PROCUREMENT_REVIEW ──(CS locked)───────────────→ CS_LOCKED
IN_PROCUREMENT_REVIEW ──(CS locked, FAST_TRACK)──→ PACK_LOCKED   -- shortcut
CS_LOCKED               ──(MC 5/5 approve)───────→ MC_APPROVED
CS_LOCKED               ──(MC reject)────────────→ IN_PROCUREMENT_REVIEW
MC_APPROVED             ──(CFO approve)──────────→ CFO_APPROVED
MC_APPROVED             ──(CFO reject)───────────→ CS_LOCKED
CFO_APPROVED            ──(pack locked)──────────→ PACK_LOCKED
PACK_LOCKED             ──(D365 push)────────────→ D365_PUSHED
```

**Why A:** the DB value *is* `STATE.pr.stage`. The stage pill
(`stagePill`, line 1514), the timeline on `/pr/[id]`, the "Voting not yet open
(stage: …)" toast and every event line read the column directly. Zero mapping
tables, zero translation bugs, and it is the only option where the *timeline and
breadcrumbs on already-ported Wave 0/1/2 screens* start showing the governance
stages automatically. Cost: one migration + one engine type widening.

**Against:** it grows the status vocabulary a fourth time (v1 Title-Case, v2
uppercase, engine uppercase, now prototype uppercase). Mitigated by keeping the
migrations ordered and the CHECK commented per generation — the same way
`019`/`020` did it.

### Option B — map the prototype's stages onto existing v2 stages

`CS_LOCKED → IN_COST_CENTER_APPROVAL`, `MC_APPROVED → IN_FINANCE_REVIEW`,
`CFO_APPROVED → IN_MANAGEMENT_REVIEW`, `PACK_LOCKED → READY_FOR_D365`,
`D365_PUSHED → D365_PUSHED` (already exists).

**Against:** the shipped D365 service already gates on `READY_FOR_D365`, so
`pack` and `d365-push` would appear "ready" before the MC has even voted — a
governance screen would lie. It also needs a permanent
`PROTOTYPE_STAGE → DB_STAGE` map that every screen and every toast must consult.
Rejected.

### Option C — leave `purchase_requisitions.status` alone, track governance separately

Governance progress lives in `workflow.mc_sessions.outcome` + a new
`proc.governance_state(pr_id, stage)` table. The PR status stays in the v2 chain
and only jumps `IN_PROCUREMENT_REVIEW → READY_FOR_D365 → D365_PUSHED` at the end.

**Against:** the PR detail screen, approvals queue and dashboard would all show a
stage that contradicts the governance screens. This is the "map it out of band"
approach that keeps producing divergence. Rejected.

---

## 4. Decision 2 — what MC reject does to the Comparative Statement — ✅ **APPROVED: Option A** (user, 2026-09-30)

The prototype (line 7226-7232) on any reject vote: clears **all** MC votes, sets
stage to `QUOTES_RECEIVED`, and sets `csLocked = false` — so the CS is re-opened
and re-generated from the quotes.

Our schema deliberately made the lock terminal (`cs.service.ts:151-157`):
`comparative_statements` is `UNIQUE(pr_id)`, the lock is an `UPDATE` of that one
row, and `proc.fn_reject_pack_mutation`-style immutability means the winner
recommendation is never rewritten. The two rules collide.

### Option A — new CS round ★ ADOPTED

Migration `027` adds `proc.comparative_statements.round int NOT NULL DEFAULT 1` and
swaps `UNIQUE(pr_id)` → `UNIQUE(pr_id, round)`.

On MC reject:
1. close `workflow.mc_sessions` with `outcome = 'rejected'`
2. delete/void every `approval_votes` row for that round (a fresh round = fresh
   votes, exactly as the prototype's `STATE.pr.mcVotes = {}`)
3. PR → `IN_PROCUREMENT_REVIEW`
4. the locked CS row stays, untouched, as `round = 1`
5. re-generating creates `round = 2`; it only becomes the live CS because
   `round = max(round)` wins

**This preserves append-only.** The rejected round is evidence, not garbage — the
MC's objection has to be answerable months later. It also matches the prototype's
semantics exactly ("CS must revise").

### Option B — keep the CS locked, return the PR to sourcing

Reject moves the PR to `IN_PROCUREMENT_REVIEW` but the CS stays `Locked` and
`csLocked` stays true. Cheapest, but it silently drops the prototype's "CS must
revise" loop: there is no way to re-score with new quotes.

---

## 5. Implementation steps

### Step 0 — `db/migrations/027_governance_stages.sql` + `verify_027.sql` — ✅ DONE 2026-09-30

**As built.** Delivered exactly as scoped, plus two things the research turned up
that the plan had not anticipated.

`db/migrations/027_governance_stages.sql` (~14 KB) and
`db/scripts/verify_027.sql` (~15 KB, 22 assertions). Registered as
`npm run db:verify:027`.

**Result:** all 27 migrations apply clean from an empty database. All 22
assertions green. Regression intact: **110 unit + 427 e2e**, zero failures, and
`verify_020` / `verify_024` unaffected.

**The MC panel became a table.** The plan said "seed 5 MC users with the
prototype's names"; doing that alone would have left the panel's *order* and its
*chair* as facts buried in a seed file. So `workflow.mc_panel` (user_id, seat,
chair) is the real answer, with `workflow.fn_mc_quorum()` deriving the
"5/5 unanimous" the screen demands. The prototype's hardcoded `memberList`
(line 7870) and its hardcoded *"You are voting as Dr. Imran Shah"* (line 7886)
both become consequences of rows rather than constants. This is the one place
Wave 3 deliberately departs from the prototype's literal text, and it departs
*toward* the prototype's intent.

**A name collision had to be resolved.** `cs@pakboxes.pk` was seeded as
*"Junaid Akhtar"* — who is also one of the prototype's five MC members. Left
alone, the MC vote table and the CS signature line would show the same human on
both sides of a governance gate. The CS user is now *Arsalan Majeed*; the MC seat
carries *Junaid Akhtar*, as the prototype has it.

**`QUOTES_RECEIVED` was added as a sixth stage.** The plan assumed the MC-reject
target would be `IN_PROCUREMENT_REVIEW`. The prototype names it explicitly
(line 7230: `stage = 'QUOTES_RECEIVED'`), and it is already in the prototype's
`STAGES` array. Storing it means the MC-reject toast and the stage pill say
*"Quotes received"* rather than *"Procurement review"* — the difference between
telling the reviewer what happened and telling them what a queue is called.

**Two bugs found in my own verification script while writing it** — both would
have shipped as false confidence:

1. `cs_round`, not `round`. `RETURNING id, round INTO v` in a PL/pgSQL block
   parses `round` as a call to the built-in and raises *"round is not a known
   variable"*. The column is now `cs_round`, which also reads better.
2. `DO $$ … $$; ROLLBACK;` without a preceding `BEGIN;` **commits the
   fixtures** — psql is in autocommit, so the `ROLLBACK` found no transaction,
   warned *"there is no transaction in progress"*, and left five `PR-VERIFY-027`
   rows and two `CS-027` rows behind in the database. A verification script that
   pollutes the database it verifies is worse than no script. Every `DO` block
   is now wrapped.

**One assertion was wrong, not the schema.** The first draft asserted
`D365_PUSHED → Fulfilled` should be refused. It is legitimately allowed — it
means goods arrived. The trigger was right and the test was wrong; the assertion
now checks `D365_PUSHED → PACK_LOCKED` (a pushed PO is not reversible) *and*
asserts the legal `D365_PUSHED → Fulfilled` still works.

#### Step 0 — the original scope, for the record

Depends on Decisions 1 and 2. No app code yet — schema first, so every later step
has something to test against.

1. **Widen the CHECK** — add `CS_LOCKED`, `MC_APPROVED`, `CFO_APPROVED`,
   `PACK_LOCKED` to `purchase_requisitions_status_check`, in a
   `-- v3 prototype governance vocabulary` block with the same comment discipline
   as `019`/`020`.
2. **Rewrite `fn_check_pr_transition()`** with the §3 transition table, including
   the FAST_TRACK shortcut and both reject returns. Every branch keeps the existing
   `Rejected` **and** `REJECTED` duality (the lesson from migration 020).
3. **Seed a 5-member MC panel.** The prototype hardcodes 5 names; the seed has 2
   (`mc.member1@` Saad Iqbal, `mc.member2@` Tariq Mehmood). Add 3 more so the
   quorum is 5/5 as the screen demands, using the prototype's own names:
   Dr. Imran Shah, Tariq Saleem, Naila Aziz, Junaid Akhtar, Saba Khan. Seed data
   only — **not** a migration (the FK-ordering lesson from `025_vendor_pool`).
4. **Add governance step ids to `workflow.steps_config`** — `mc_approval`,
   `cfo_approval`. `workflow.approval_votes.step_id` is a FK into this table, so
   the ids must exist before any vote can be inserted.
5. **`comparative_statements.round`** + `UNIQUE(pr_id, round)` (Decision 2A).
6. **`proc.approved_packs.payload.documents[]`** — a real document manifest so
   `renderPack` can print true SHA-256s (D1). See §6 step 3.
7. **Indexes** — `idx_cs_pr_round`, and a partial index on
   `workflow.approval_votes(pr_id, step_id) WHERE decision IS NOT NULL` is already
   covered by `idx_votes_pr_step`.

`verify_027.sql` — ~25 assertions: CHECK accepts/rejects the right values, every
branch of the transition table is exercised, the FAST_TRACK shortcut lands on
`PACK_LOCKED` and not `CS_LOCKED`, a 4/5 MC quorum does **not** advance, the MC
panel is 5 rows, `step_id` FK resolves, the pack document manifest hashes stably,
and round-2 generation does not mutate round 1.

### Step 1 — `packages/workflow-engine/src/governance.ts` — ✅ DONE 2026-09-30

**As built.** `packages/workflow-engine/src/governance.ts` (~19 KB) +
`src/__tests__/governance.test.ts` (~20 KB, **40 tests**). Engine suite
**60 → 100**; total unit **110 → 150**, zero failures. The API still compiles
against the widened `Stage` union, so nothing downstream needed a cast.

Exports, in the order a screen needs them:

| Export | What it is |
|---|---|
| `STAGES` / `STAGE_LABEL` | the prototype's `STAGES` array, verbatim (line 1500-1510) |
| `GOVERNANCE_STAGES` | the five migration 027 made storable |
| `stagePill` | the prototype's `stagePill` palette — returns `{cls, label}`, not HTML |
| `GOVERNANCE_NEXT` / `canGovernanceTransition` | the TypeScript twin of migration 027's trigger branches |
| `MC_PANEL_SIZE` / `mcNext` / `isUnanimous` / `mcTally` | the unanimity rule |
| `mcAlert` / `cfoAlert` | the prototype's alert copy, verbatim |
| `packDocuments` / `formatDigest` | the D1 + F2 pack manifest |
| `cfoSummary` | the CFO's seven rows, in prototype order |
| `MC_VOTE_ROLES` / `CFO_DECIDE_ROLES` / `PACK_LOCK_ROLES` / `D365_PUSH_ROLES` | the prototype's `data-roles` gates |
| `GOVERNANCE_STAGE_OWNER` | inbox owner per stage, mirroring `LIGHT_STAGE_OWNER` |

**Two deliberate departures from the prototype's literal text**, both recorded
in the file:

- **`stagePill` returns a class and a label, not a `<span>`.** The prototype
  hardcodes the element. The *class* is the contract — `pending` is amber,
  `locked` is violet, `pushed` is green — and returning the class lets React own
  the markup while the prototype's CSS still applies unchanged. Every other
  engine module already returns data rather than HTML.
- **The unanimity test is `>=` panelSize, and 4/5 is proven not to pass.** The
  exhaustive test runs all **4⁵ = 1024** vote combinations and asserts the
  resolved state for each. The single assertion that matters most is that four
  approvals resolve to `pending` — a quorum bug that only manifests at 4/5 is
  precisely the one that ships.

**F2 is enforced in code, not just in the UI.** `packDocuments()` takes a FAST_TRACK
context *with digests supplied for the MC and CFO slots* and still refuses to
hash them, because a digest for a gate that never ran is not evidence. The test
passes those digests deliberately to prove it.

**The pack manifest has three states, not two.** `present` (real digest),
`skipped` (the gate never ran — FAST_TRACK), and `missing` (the gate should have
run but no digest was recorded). Collapsing `missing` into `present` with a
blank hash is how a real gap becomes invisible.

#### Step 1 — the original scope, for the record

No I/O, so it is exhaustively unit-testable before any endpoint exists.

- `GOVERNANCE_STAGES` — the 4 stages + `GOVERNANCE_STAGE_LABEL`, a direct port of
  `STAGES`/`STAGE_LABEL` lines 1500-1512
- `GOVERNANCE_STAGE_PILL` — port of `stagePill` line 1514 (`locked` for all four)
- `GOVERNANCE_NEXT` — the `OLD → NEW[]` table, exported so the service and the DB
  trigger are checked against the same source of truth
- `MC_PANEL_SIZE = 5`, `isUnanimous(votes)` — the quorum predicate
- `mcNext(votes)` → `'pending' | 'approved' | 'rejected'`
- `packDocuments(...)` — builds the §6 document manifest and derives each SHA-256

### Step 2 — governance API module — ✅ DONE 2026-09-30

**As built.** Four new files under `apps/api/src/governance/`:

| File | Size | What |
|---|---|---|
| `pack.lock.ts` | ~13 KB | the **shared** `lockPack()` + the six document digests |
| `governance.service.ts` | ~34 KB | the three gates, the MC session, the pack read |
| `governance.controller.ts` | ~3.5 KB | 7 endpoints, DTOs only |
| `governance.module.ts` | ~1 KB | wired into `AppModule` |

Plus `scripts/e2e_governance.mjs` (~24 KB, **116 assertions**) and edits to
`cs.service.ts` and `e2e_cs.mjs`.

**Q4 is now retired.** Locking the CS moves the PR: `STANDARD`/`BOARD` →
`CS_LOCKED`, `FAST_TRACK` → `PACK_LOCKED`. The assertion in `e2e_cs.mjs` that
pinned *"Q4: the PR status is UNCHANGED"* was **inverted**, and the comment
above it rewritten to say why it was ever true.

**The pack lock is genuinely one implementation.** Risk R7 was that the
FAST_TRACK path (`cs.service`) and the STANDARD path (`governance.service`)
would drift. `lockPack()` moved out of `cs.service` into `pack.lock.ts` and both
call it, so "once-only", "immutable" and "real digests" are properties of the
module rather than of whichever screen fired the request.

**Three design decisions the plan did not anticipate:**

1. **A withdrawn award must withdraw its consequence.** The CS lock marks the
   winner `Awarded` and the rest `Rejected`. When the MC rejects, the PR returns
   to sourcing with *no live quote left* — round 2 could never be scored. The MC
   reject now restores `Awarded`/`Rejected` → `Submitted` and the RFQ → `Open`.
   This is a lifecycle transition, not a rewrite: prices, line splits and the
   version chain are untouched, and the CS row stays `Locked` so the rejected
   round remains answerable.
2. **Idempotency is checked before the stage gate.** A retry after a dropped
   connection used to 409 with *"CFO approval pending"*, because the first
   attempt had already moved the PR to `PACK_LOCKED` and the CFO gate had
   correctly closed behind it. `packLock` now asks "is the pack already frozen?"
   before asking "is it legal to freeze it?".
3. **The pack documents are record digests, not file digests.** There is no
   PR→file link table in this schema (`core.files` is unattached except for
   `proc.pr_images`), so each of the six is a canonical JSON snapshot hashed by
   `proc.fn_pack_hash()`. The engine's `sources: 'file'` slot stays for Wave 4.

**Bugs found and fixed while writing it** — four were mine, not inherited:

| Bug | Symptom | Fix |
|---|---|---|
| `pr.pr_status` | the whole CS lock 500'd; the column is `pr.status` | corrected |
| `recommendation` read as an object | jsonb arrives as a **string** through the psql CSV bridge, so `rec.winner_vendor_id` was `undefined` and every CS looked winnerless | `parseJsonb()` |
| `'abandoned'` MC outcome | `workflow.mc_sessions.outcome` is CHECKed to `approved\|rejected\|tie\|pending`; a stale session is now closed keeping `outcome='pending'` — the CHECK's own word for "opened, never concluded" | corrected |
| `cs_round` missing from the generate response | a screen cannot explain why a PR has two CSs if the round is not in the payload | added to the RETURNING and the response |

**The suite proves the things that matter, in order:**
5 panel rows and 1 chair · the quorum derived from the panel · 4/5 leaves the PR
at `CS_LOCKED` · the 5th moves it · a single reject collapses the round, returns
the PR to `QUOTES_RECEIVED` and survives in the audit log · the CFO's reject
returns to `CS_LOCKED` and *not* to sourcing · six real 64-hex digests · one
pack row · a payload mutation refused by the schema · FAST_TRACK carries four
hashes and two "Skipped (FAST_TRACK)" rows · round 2 generates while round 1
stays `Locked` · the superseded round cannot be re-locked.

#### Step 2 — the original scope, for the record

New `apps/api/src/governance/` — `governance.module.ts`, `governance.service.ts`,
`governance.controller.ts`. Sibling to the existing `sourcing/` module.

| Method | Route | Role | Port of |
|---|---|---|---|
| GET | `/pr/:id/mc` | `mc,admin` | `renderMCVote` data |
| POST | `/pr/:id/mc/vote` | `mc,admin` | `mcVote` (7221) |
| POST | `/pr/:id/mc/auto-complete` | `mc,admin`, **demo-gated** | `mcAutoComplete` (7251) |
| GET | `/pr/:id/cfo` | `cfo,admin` | `renderCFO` data |
| POST | `/pr/:id/cfo/decide` | `cfo,admin` | `cfoDecide` (7264) |
| GET | `/pr/:id/pack` | `cs,procurement,cfo,admin` | `renderPack` data |
| POST | `/pr/:id/pack/lock` | `cs,procurement,admin` | `packLock` (7281) |

Rules, all in the **service** (never the UI, per Decision 10's precedent):

- Voting only opens at `CS_LOCKED`; otherwise 409 with the prototype's own text
  *"Voting not yet open (stage: <label>)"*.
- One vote per `(pr_id, step_id, voter_user_id)` — the DB UNIQUE enforces it;
  re-voting updates the row and is audited.
- **5/5 unanimous to approve.** Any single `reject` closes the session as
  `rejected`, clears the round's votes, and returns the PR (Decision 2A).
- `packLock` requires `CFO_APPROVED` and delegates to the **existing private
  `lockPack()`** in `cs.service.ts` — one implementation, two entry points. This is
  why the pack-document manifest lands in Step 0, not in a new service.
- The pack INSERT is still once-only (`UNIQUE(pr_id)`) and still hashed by
  `proc.fn_pack_hash()`. A second lock returns the existing pack, not an error.

**`mcAutoComplete` is a demo helper and will be labelled as one.** The prototype
says so in its own tooltip. The port: it writes **real `approval_votes` rows for
the real seeded members** (not in-memory fakes), and it is refused with 403 unless
`DEMO_HELPERS=1` in the environment. Same affordance, honest data, no accidental
production unanimity.

### Step 3 — D365 module rewrite — ✅ DONE 2026-09-30

**As built.** The 63-line stub is gone, replaced by:

| File | Size | What |
|---|---|---|
| `d365.payload.ts` | ~11 KB | the **pure** payload builder + the status ladder + event stream |
| `d365.service.ts` | ~21 KB | payload read, push, status, sync |
| `d365.controller.ts` | ~2 KB | 4 endpoints under `pr/` |
| `d365.module.ts` | — | now imports `GovernanceModule` |
| `__tests__/d365.payload.test.ts` | ~16 KB | **32 unit tests** (API suite 26 → 58) |
| `scripts/e2e_d365.mjs` | ~17 KB | **79 e2e assertions** |

**What the old stub got wrong, and what replaced it:**

| Old | New |
|---|---|
| `vendorCode: 'TBD'` | the CS winner's real `core.vendors.vendor_code` |
| `bypassRls: true` everywhere | reads through the session context |
| no role check | `D365_PUSH_ROLES` = `cs,procurement,admin` |
| no idempotency | `idempotency_key = <pr>:<pack_hash>`, UNIQUE, replay returns the original |
| never wrote `proc.d365_pushes` | every attempt is claimed *before* the outbound call |
| `status !== 'READY_FOR_D365'` gate | `PACK_LOCKED` + a frozen pack |
| flat `POST d365/push/:prId` | `POST pr/:id/d365/push` plus payload / status / sync |

**A security decision worth surfacing:** the prototype puts the raw
acknowledgement `token` into `AcknowledgementTokens` on every D365 line
(line 7995) — and would therefore *render* it on the push screen. That token is
a **bearer credential**: whoever holds it can acknowledge the request. It is
now excluded. Each entry carries `email`, `name`, `role`, `acknowledged` and
`acknowledgedAt` — which is what D365 actually needs — while the
`AcknowledgementTokens` *key* is preserved so the contract still matches. A unit
test walks the entire payload object and fails on any key named `token`.

**Two schema constraints the plan did not anticipate:**

1. **`d365_sync_log.source` is CHECKed to `poll|webhook|reconciliation`.** The
   push is none of those, so the push writes **no** sync-log row — the ERP's
   response to our push belongs in `d365_pushes.d365_response`, which is where
   it now lives. `d365_sync_log` is a log of *observations*; a push is not one.
   The `CONFIRMED` timestamp the status screen needs comes from
   `d365_pushes.finished_at`, which is when the ERP first actually told us.
2. **The stub advances from real state, not a row count.** The first version
   counted `d365_sync_log` rows to decide which ladder step to report, which
   desynchronises the moment a poll fails. It now counts from the PO's current
   `d365_status`, so the ladder's base is real state.

**The idempotency-before-gate lesson repeated.** The second push 409'd with
*"Pack not yet locked"* — because after the first push the stage is
`D365_PUSHED`, which is correctly no longer pushable. Same fix as the pack lock:
ask *"has this pack already been pushed?"* before asking *"is it legal to push?"*.

**`TotalAmount` is the AWARDED total, not the PR estimate.** The first version
computed it from `capex_amount + opex_amount`, which are `0` (not NULL) on a
capital-light PR and produced a total of `0`. A D365 PO's total is what the
vendor was awarded; the PR estimate is a budget request, not a commitment.

#### Step 3 — the original scope, for the record

`apps/api/src/d365/d365.service.ts` is currently a placeholder. Wave 3 replaces
it. `D365_MODE=stub` remains the default — Wave 3 makes the *bookkeeping* real,
not the ERP.

| Method | Route | Role | Notes |
|---|---|---|---|
| GET | `/pr/:id/d365/payload` | `cs,procurement,cfo,admin` | the exact JSON that will be POSTed |
| POST | `/pr/:id/d365/push` | `cs,procurement,admin` | `d365Push` (7292) |
| GET | `/pr/:id/d365/status` | all | `renderD365Status` data |
| POST | `/pr/:id/d365/sync` | `cs,procurement,admin` | poll → writes `d365_sync_log` |

- **The payload is built server-side and returned by the endpoint.** The prototype
  renders the payload as the screen's own content; recomputing it in the browser
  would let the preview and the actual POST drift. One builder, two consumers.
- Reuses the existing `@procurement/d365-client` exports —
  `D365_DIMENSIONS` (9, 4 mandatory), `CLASSIFICATIONS`, `deriveRouting`,
  `splitPill`, `missingMandatoryDims`, `pushPurchaseOrder`. Nothing reimplemented.
- `PortalPackHash` is the **real** `pack_hash` from `proc.approved_packs` — this is
  what replaces the prototype's literal `"a3f9c1..."` and ties D1 to the push.
- `PurchaseOrderNumber` / `VendorAccount` are `—` before the push and the real
  `d365_po_number` / `vendor_code` after, replacing `PO-2026-00781` / `V-000123`.
- `TotalAmount` uses the real `estimated_amount` / awarded quotation total, never
  the prototype's `pr.amount||2400000` fallback.
- **No timers.** The prototype's `setTimeout(…, 2500)` that flips status to
  `INVENTORY_RESERVED` is not ported. Status only advances when
  `POST /d365/sync` reads it from D365 and writes a `d365_sync_log` row
  (`source = 'poll'`). In `stub` mode the stub returns a deterministic progression;
  nothing advances on its own. Same spirit as Q2.
- **Idempotency:** `idempotency_key = <pr_id>:<pack_hash>`, which is UNIQUE. A
  second push returns the existing `d365_pushes` row rather than creating a second
  PO. `attempt_no` increments 1→5, then `dead_letter`.

### Step 4 — web pages

Five new pages, CSS copied verbatim from the prototype as in Waves 0-2.

| Route | Screen id | Prototype roles |
|---|---|---|
| `/mc/[id]` | `mc-vote` | `mc` |
| `/cfo/[id]` | `cfo-approve` | `cfo` |
| `/pack/[id]` | `pack` | `cs,procurement,cfo` |
| `/d365/push/[id]` | `d365-push` | `cs,procurement` |
| `/d365/status/[id]` | `d365-status` | `all` |

Registered in `Shell.tsx` `ROUTES`; the 5 `PENDING` entries are deleted. Each page
uses the existing `Shell` guard (`canSee(role, screenId)`) so the sidebar gating
matches the prototype's `data-roles` exactly — the nav CSVs are already correct in
`packages/roles`.

### Step 5 — shared components

All five screens call `purposeAndAckWidget(pr)` and `imageGalleryCard(pr,'viewer')`
(prototype lines 7883-7884, 7911-7912, 7935-7936, 8003-8004, 8033-8034). Rather
than five copies:

- `components/governance/PurposeAck.tsx` — backed by `proc.pr_acknowledgements`
  (migration 021). Reuse Wave 1's `Acknowledge` page logic; extract, don't fork.
- `components/governance/ImageGallery.tsx` — backed by `proc.pr_images` (migration
  020), viewer mode.
- `components/governance/McVoteTable.tsx`, `PackDocuments.tsx`,
  `D365EventStream.tsx` — the three bespoke cards.

### Step 6 — tests

- **Unit (~28 new):** governance stage map + pill classes; `isUnanimous` across
  all 5-vote permutations (0/5 … 5/5, one-reject-at-each-position); `mcNext`;
  `packDocuments` hash stability and the FAST_TRACK 4-vs-6 document case; the
  payload builder's dimension completeness and Capex/Opex branch.
- **e2e (~4 suites):** `e2e_mc.mjs` (vote, quorum, reject-clears-and-returns,
  auto-complete gate, role refusal, double-vote), `e2e_cfo.mjs`,
  `e2e_pack.mjs` (lock, once-only, real hash), `e2e_d365.mjs` (payload shape,
  idempotency, push → sync → status, no-auto-advance).
- **DB:** `verify_027.sql`, ~25 assertions.

### Step 7 — full regression

`npm test` · `npm run e2e` · all 12 e2e suites · `verify_027`. Baseline to beat:
**110 unit + 427 e2e + 27 DB, all green.** Then a clean `db:reset` so the 27
migrations apply from empty.

---

## 6. Screen-by-screen fidelity notes

### `mc-vote` (`renderMCVote`, 7866)
- Title *"Management Committee Vote"*, subtitle `<pr> · <winner> — PKR <amount>`.
- The header amount must read the **locked CS winner's** amount, not
  `pr.quotes[0]` — the prototype's own `i===0` bug, already fixed in Wave 2
  (Decision 7). `—` until the CS is locked.
- Alerts: warn *"Voting in progress. Need 5/5 unanimous approve."* at `CS_LOCKED`;
  success *"MC approved 5/5. Switch to CFO role for final sign-off."* at
  `MC_APPROVED`.
- Table: Member / Vote / Note, with `Approve` / `Reject` / `Pending` pills and a
  `n/5` meta chip.
- *"You are voting as **Dr. Imran Shah**"* — the prototype hardcodes the current
  user. **Deviation:** it renders the authenticated user's real name. Hardcoding a
  named person is a demo artefact, and the actual vote is already attributed to the
  real `voter_user_id`.
- Board note: when `routing_key = 'BOARD'`, the toast reads *"Board confirmation
  still required."* (text only — see §1).

### `cfo-approve` (`renderCFO`, 7894)
- Pack summary `kv` grid, 7 rows, in prototype order: Vendor, Total amount, Capex
  portion, Opex portion, Budget source, MC vote, Risk class.
- *"MC vote — 5/5 unanimous"* becomes a **real** count from `approval_votes`.
- **Risk class is the one fabricated value on this screen** (hardcoded
  *"Medium — within delegation"*). Ported as a derived value from vendor
  due-diligence / risk tier, falling back to `—` when there is no record. Same
  rule as D5. See §7, F1.
- Capex/Opex GL captions (`GL 1710-00`, `GL 6320-00`) are prototype constants;
  real values come from the awarded lines' `gl_account`, with the constant as the
  fallback when a line carries none.

### `pack` (`renderPack`, 7920) — the deferred Wave 2 step 8
- Capex/Opex financial summary: the 2-up blue/amber cards, **real** `capex_amount`
  / `opex_amount` from the PR, "depreciation 4 yr" from the line's
  `useful_life` (prototype default 4).
- Pack documents table: 6 rows with **real SHA-256** (D1), replacing
  `Math.random().toString(16)`. Each document is either file-backed
  (`core.files.sha256` — the column already exists) or record-backed (hashed from
  its canonical JSON). The manifest is written into
  `proc.approved_packs.payload.documents[]` at lock time, so the hashes are frozen
  with the pack.
- *"Lock approved pack"* → `packLock` (7281), `cs`/`procurement` only, requires
  `CFO_APPROVED`. On FAST_TRACK the pack is already locked (Decision 10) and this
  button is absent. See §7, F2.

### `d365-push` (`renderD365Push`, 7953)
- Payload preview card, dark (`#0F172A`) / cyan (`#A5F3FC`) monospace block,
  rendering the **server-built** payload from `GET /pr/:id/d365/payload`.
  Line-for-line identical key order to the prototype, so the preview diffs
  cleanly against `PROCUREMENT_PORTAL_PROTOTYPE.html:7961-7996`.
- Per-line: `ItemId` ← `sku`, `PurchUnit` ← `uom`,
  `ProcurementCategory` ← `CAPEX`/`OPEX` from `CLASSIFICATIONS`,
  `FixedAssetGroup`/`DepreciationPeriod` only on Capex lines,
  `FinancialDimensions` over all 9 `D365_DIMENSIONS` keys,
  `AcknowledgementTokens` from `proc.pr_acknowledgements`.
- *"Push to D365 F&O"* → `d365Push` (7292), `cs`/`procurement` only, requires
  `PACK_LOCKED`.

### `d365-status` (`renderD365Status`, 8020)
- 6-event timeline, verbatim labels and order. **`state` is computed** from the
  real `d365_status` in `proc.d365_sync_log` instead of the prototype's
  `pr.d365Status==='INVENTORY_RESERVED'` single check. **`ts` uses the real
  `observed_at`** for completed steps; pending steps keep the prototype's relative
  labels (`+1 hour`, `+3 days`, …), because those are the prototype's design.
- 10-column PO line table, shown only once pushed.
- Before the push: the info alert *"PO will appear here once you push from the
  **Push to D365** screen."*

---

## 7. Decisions embedded in the plan

**All accepted by the user on 2026-09-30.** Recorded here as the wave's standing
rules rather than as open questions.

- **F1 — Risk class is derived, not asserted.** ✅ APPROVED. The prototype
  hardcodes *"Medium — within delegation"*. A real procurement system must not
  assert a risk rating it did not compute. Derived from vendor due-diligence + risk
  tier, `—` when unknown. (Consistent with D5.)
- **F2 — the pack shows only documents that exist.** ✅ APPROVED. The prototype
  hardcodes 6 documents. On a FAST_TRACK route MC and CFO never ran, so
  *"MC vote record"* and *"CFO approval"* have no content. The table renders the
  documents that exist and shows the other two as *"Skipped (FAST_TRACK)"* rather
  than fabricating a hash for an approval that never happened. The 6-row structure
  and order are preserved.
- **F3 — `mcAutoComplete` is ported but gated.** ✅ APPROVED. It is an explicit demo
  affordance in the prototype (its own tooltip says so). Kept in the UI, writes
  real vote rows for real members, returns 403 unless `DEMO_HELPERS=1`.
- **F4 — BOARD is a message, not a gate.** ✅ APPROVED. Per the prototype's own
  comment, Board and STANDARD both land on `MC_APPROVED`. The Board guidance text is
  ported verbatim; no Board vote is cast. A real Board gate needs a screen the
  prototype does not have.

---

## 8. Risk register

| # | Risk | Mitigation |
|---|---|---|
| R1 | CHECK / trigger / `Stage` union drift again — the exact class of bug migrations 018, 019, 020 each fixed | One migration widens **all three together**; `verify_027.sql` asserts the engine's stage list and the CHECK list side by side |
| R2 | A 4/5 quorum silently advances the PR | `isUnanimous` unit-tested across every permutation **and** an e2e that asserts the PR is still `CS_LOCKED` at 4/5 |
| R3 | Push runs twice and creates two POs in D365 | `idempotency_key = <pr>:<pack_hash>` UNIQUE; e2e fires the push twice and asserts one `d365_pushes` row |
| R4 | The D365 preview and the actual POST drift apart | One server-side builder; the screen renders the endpoint's response verbatim |
| R5 | Auto-advance reappears as a `setTimeout` | `d365-status` renders only from `d365_sync_log`; e2e asserts status is unchanged after a delay |
| R6 | MC seed data is inserted as a migration and breaks FK ordering | Panel members go in `seed.sql`, not `027` (the `025_vendor_pool` lesson) |
| R7 | The pack document list diverges between the FAST_TRACK path (`cs.service.ts:326`) and the new `pack/lock` path | Both call the same `lockPack()`; one manifest builder |

---

## 9. Step order and dependencies

```
Step 0  migration 027 + verify_027 ......... depends on Decision 1 + Decision 2
Step 1  workflow-engine/governance.ts ...... pure, needs nothing
Step 2  API governance module .............. needs 0 (DB) and 1 (helpers)
Step 3  D365 module rewrite ................ needs 0 (DB); reuses d365-client
Step 4  web pages (5) ....................... needs 2 + 3
Step 5  shared components .................. needs 0 (pr_acknowledgements, pr_images)
Step 6  tests .............................. needs 1-5
Step 7  full regression + docs ............. needs 6
```

Steps 1 and 5 can run in parallel with 0. Steps 2 and 3 are independent of each
other and can also run in parallel.

---

## 10. Definition of done

- [x] All 5 screens render at prototype fidelity: same titles, subtitles, card
      order, table column order, alert copy, button labels and role gating.
- [x] Full chain demonstrable: CS lock → 5/5 MC → CFO → pack lock → D365 push →
      sync → status, on a STANDARD route; and CS lock → pack lock → D365 push on
      FAST_TRACK.
- [x] MC reject demonstrably returns the PR to sourcing and opens a new CS round
      with round 1 preserved.
- [x] Every SHA-256 on screen is real and stable across reloads.
- [x] No `Math.random()`, no `setTimeout` status advance, no hardcoded
      `PO-2026-00781` / `V-000123` / `2400000` anywhere in the five screens.
- [x] Zero fabricated values: anything unknown renders `—`.
- [x] 27 migrations apply clean from an empty database.
- [x] **182 unit + 623 e2e still green** (the pre-Wave-3 baseline), plus 17 new
      web render tests, 104 new governance-web e2e assertions and 22 new DB
      assertions.
- [x] `WAVE3_PLAN.md` updated with the as-built result (section 11).

---

## 11. As-built (Wave 3 complete)

### What shipped

| Step | Artefact | Verification |
| --- | --- | --- |
| 0 | `db/migrations/027_governance_stages.sql` | 27 migrations clean from empty; `verify_027` 22 assertions, 0 FAIL |
| 1 | `packages/workflow-engine/src/governance.ts` | 40 new tests (engine 60 → 100) |
| 2 | `apps/api/src/governance/*` | 116 e2e assertions |
| 3 | `apps/api/src/d365/*` rewrite | 32 unit + 79 e2e |
| 4 | 5 pages: `mc` `cfo` `pack` `d365/push` `d365/status` | `next build` compiles; 104 web e2e |
| 5 | `components/governance/GovernanceCards.tsx` | 17 render tests |
| 6 | `apps/web/tsconfig.render.json` + `tests/governance.render.test.tsx` | `npm run test:web` |
| 7 | this section | full regression green |

### Step 6 — the verification gap that was found and closed

The first version of `scripts/e2e_governance_web.mjs` reported **48 passed, 12
failed**, and every failure was the test's fault, not the port's. Diagnosing them
turned up a real hole in how the wave was being verified, which is worth
recording because the same trap will catch the next wave.

All five pages are client-rendered and return `null` until a session exists, so
`GET /mc/:id` returns a **1,189-byte empty shell** — identical for a correct page
and a blank one. Three clusters of assertions were therefore meaningless:

1. **Titles asserted in server HTML.** Passed or failed on the session, not on
   the port. The titles are real (they are in the source and in the compiled
   chunk), but that HTML could never show them.
2. **`nav-item-pending` counted on `/dashboard`.** The nav renders client-side,
   so the count was **0 because no nav was present at all** — a vacuous pass
   that would have stayed green no matter how many screens were un-ported.
3. **Placeholders scanned in server HTML.** Same empty shell, same vacuity.

Fixes, each asserting something that can actually fail:

- The five pages now assert on their **compiled page chunk**: the chunk is
  served, is a real module, and **contains the prototype's own title and screen
  id**. That is the honest place to check the title ships.
- The sidebar is asserted against **Shell.tsx source** — each screen id has a
  route in `ROUTES` and is absent from `PENDING`. Role gating itself already
  lives and is proven in `packages/roles` (the five `data-roles` CSVs verbatim
  at `roles.test.ts:63-67`, plus `navFor('mc'/'cfo'/'cs')` behaviour).
- Placeholders are scanned in the **compiled chunks and the API payloads**.
- `npm run test:web` is the new answer to "what does the screen actually say".
  It compiles the components with `tsc` and renders them through
  `react-dom/server`, asserting on real markup. No jsdom or testing-library was
  added; `react-dom` was already there.

The render suite asserts against the **producer**, never a hand-copied fixture:
pack documents come from the engine's own `packDocuments()`, digests from
`formatDigest()`, the MC chip from `mcTally()`. Four of the first assertions
failed and all four were wrong expectations, not component bugs — most usefully,
`McVoteTable`/`PackDocuments` have **no `.card-b`**, because the prototype puts
the table straight under the card header (lines 7876, 7944-7947). Adding one
would have been a redesign. W6-17 now pins that exception so it stays.

### Two corrections to earlier assumptions in this plan

- `PACK_DOCUMENT_NAMES` slots are only `mc_vote_record` and `cfo_approval` for
  the "gate never ran" branch. A FAST_TRACK pack therefore reports exactly
  **2 skipped** (`Skipped (FAST_TRACK)`) and 4 `No digest recorded` — not six
  skips, and never `Gate not reached`.
- `mcTally` text is `cast/panel`, not `approves/panel`. A round with one approve
  and one reject reads **2/5**, which is what the header chip now shows.

### Final regression

- Migrations: **27 OK / 0 FAIL** from an empty database, seed OK, postcondition
  verified (1 PR, 6 vendors) on the correctly-quoted `"procurementDB"`.
- `npm run db:verify:027`: 13 sections, **0 FAIL**.
- `npm test`: **199 pass / 0 fail** — engine 100, roles 24, api 58, web render 17.
- `npm run e2e`: **11 suites, 727 assertions passed, 0 failed** (35 + 60 + 41 + 45
  + 65 + 62 + 62 + 58 + 116 + 79 + 104). The four sourcing/CS suites print their
  summary without the `===` decoration, so a log grep for `=== N passed` alone
  under-counts the chain by four suites.

### Security note carried forward

The raw acknowledgement bearer token is excluded from the D365 payload and is
never rendered or sent — only `email`, `name`, `role`, `acknowledged`,
`acknowledgedAt`. The on-screen deep link shows the literal `#ack=<token>`
placeholder, and W6-04 asserts no 32+ hex string ever appears in that widget.
