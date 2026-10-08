# Wave 4 — External parties

**Status:** steps 0-7 SHIPPED 2026-09-30. Wave 4 complete; 2 open gaps recorded in §20.2.
**Date:** 2026-09-30
**Scope:** 3 prototype screens — `supplier-rfq`, `supplier-quote`, `vendor-onboard-public`.
**Mandate (unchanged):** fidelity port. The prototype is the source of truth; the
schema is corrected to match it, never the reverse.

---

## 1. Scope

| # | Screen | Prototype roles | Renderer | Today | Wave |
|---|---|---|---|---|---|
| 20 | `supplier-rfq` | `vendor` | `renderSupplierInbox` (9001-9035) | ❌ | 4 |
| 21 | `supplier-quote` | `vendor` | `renderSupplierQuote` (9037-9070) | ❌ | 4 |
| 22 | `vendor-onboard-public` | `all`, full-screen | static markup (725-754) | ⚠️ scaffold | 4 |

Plus the submit action `supplierSubmitQuote()` (7342-7358) and the recalc helper.

**Explicitly out of scope.** `vendors` · `vendor-detail` · `vendor-risk` are
Wave 5. The prototype's onboarding submit *jumps the operator into `vendor-risk`*
(748) — that is a walkthrough shortcut, and the review half of the loop is Wave 5.
Wave 4 delivers the intake and proves the application is captured and visible to
Procurement through a read endpoint; the review UI is not built here.

---

## 2. What the prototype actually says

Copied here because fidelity is measured against it.

**`renderSupplierInbox`** — title `Supplier RFQ Inbox`; subtitle
`Acting as <vendor> · <vendor code>`; a **4-up KPI band** (`Active RFQs` / `Quoted by me` /
`Competitors quoted` / `Est. value`); the RFQ card with issued + due dates, a
paragraph naming the other invited vendors, a 4-column line table
(`SKU`, `Description`, `Qty`, `UoM`), a **Submit quote** button, and a 3-column
roster table (`Vendor`, `My status`, `Coverage`). Empty state: *"No active RFQs at
the moment. The buyer will issue one soon."*

**`renderSupplierQuote`** — title `Submit Quote`; subtitle
`<rfq id> · <title> · Due <date>`; an info alert; a **6-column** line-pricing
table (`SKU`, `Description`, `Qty`, `UoM`, `Unit price`, `Line total`) with live
recalc and a **Quote total** in the card footer; a **Commercial terms** card
(`Total amount`\*, `Lead time`, `Warranty`, `Payment terms`, `Remarks`) and a
**Submit quote** button.

**`vendor-onboard-public`** — centred `.public-shell`, brand block, an info
alert (*"This is a **public form** — no login required. Submissions are validated
by Procurement before vendor master creation."*), then **five fields**:
`Company name`\*, `NTN / Tax ID`\*, `Contact person`, `Email`, `Categories supplied`,
and a full-width **Submit application**.

> **Gap-matrix correction.** The matrix says Wave 4 needs "onboarding application +
> due-diligence upload". The prototype has **no upload on this screen** — five
> fields and a button. I am porting the prototype, not the matrix. The
> `core.vendor_documents` upload surface belongs to `vendor-risk` in Wave 5.

---

## 3. Blockers found

These are schema/model contradictions, not screen work. All six must clear first.

### B1 — There is no link from a supplier login to a vendor record

`core.users` has **no `vendor_id`** and no FK to `core.vendors`. The two supplier
accounts (`vendor1@example.com` "Acme Supplies", `vendor2@example.com` "BoxCo
Packaging") correspond to `V-00081`/`V-00082` **by display-name convention only**,
and `core.vendors.contacts` is an empty jsonb `[]` for all six vendors.

Without this link a supplier login cannot be scoped to its own
`rfq_invitations` — every supplier would see every invitation, or none.
**Fix:** migration 028 adds `core.users.vendor_id`, backfilled with
`legal_name LIKE display_name || '%'` (both seeds are prefixes of their legal
name: `Acme Supplies` → `Acme Supplies (Pvt) Ltd`). A partial unique index
enforces one vendor per login, and a CHECK forces `vendor_id IS NOT NULL` when
`role = 'vendor'` so this can never silently regress to a convention again.

### B2 — There is no vendor-application table

The prototype says applications are *"validated by Procurement before vendor
master creation"*, so a submission must be storable in a pending state. No table
exists. `apps/onboarding` fakes it: `Reference: ONB-{Math.floor(Math.random() *
99999)}` — a fabricated number, which this project forbids outright.
**Fix:** migration 028 adds `core.vendor_applications` with a real reference from
a sequence.

### B3 — Quote submission is procurement-gated

`QuotationService.record()` and `.supersede()` both throw unless
`roleAllowed(role, 'procurement')`. A `vendor` session cannot submit today.
**Fix:** a supplier-scoped service method that gates on `role = 'vendor'` **and**
`users.vendor_id` matching the invitation's `vendor_id` — the supplier may only
write their own quote.

### B4 — Where the screens live

The prototype puts `supplier-rfq` / `supplier-quote` in the **main sidebar** as
`data-roles="vendor"`; only `login` and `vendor-onboard-public` are full-screen
"public" surfaces. But the repo has four apps and `apps/supplier` (33003) is a
scaffold whose form calls `alert('Supplier login backend not wired')`.
**Fix (locked):** build both in `apps/web`; retire `apps/supplier`.

### B5 — The sealing copy is false under Q2

Both screens claim quotes are *"sealed until the buyer closes the RFQ"*, and the
inbox renders a *"Closing in 7 days"* countdown. Q2 removed sealed bidding, and
no timer may run.
**Fix (locked):** same layout, honest sentence. See §5.

### B6 — Invitation tokens have no consumer

`rfq_invitations.token_hash` is written on invite (a real SHA-256 of a generated
token) but nothing ever reads it. The prototype never uses a token — the operator
is simply *in* the vendor role.
**Fix (locked):** scope by `users.vendor_id`. `token_hash` stays **inert**,
documented exactly like `sealed_hash` — real, unused, so restoring email
deep-links later needs no backfill.

---

## 4. Migration 028 — `028_supplier_external.sql`

```sql
-- B1: supplier identity
ALTER TABLE core.users ADD COLUMN vendor_id uuid REFERENCES core.vendors(id);
UPDATE core.users u SET vendor_id = v.id
  FROM core.vendors v
 WHERE u.role = 'vendor' AND v.legal_name LIKE u.display_name || '%';
CREATE UNIQUE INDEX ux_users_vendor_id ON core.users(vendor_id) WHERE vendor_id IS NOT NULL;
ALTER TABLE core.users ADD CONSTRAINT ck_users_vendor_role
  CHECK (role <> 'vendor' OR vendor_id IS NOT NULL);

-- B2: public applications
CREATE SEQUENCE core.seq_vendor_app_ref;
CREATE TABLE core.vendor_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,          -- 'ONB-2026-00001', from the sequence
  legal_name text NOT NULL,
  ntn text NOT NULL,
  contact_name text,
  contact_email text,
  categories text,                         -- the prototype's select value
  state text NOT NULL DEFAULT 'Submitted'
    CHECK (state IN ('Submitted','Under_Review','Approved','Rejected')),
  reference_note text,
  reviewed_by_user_id uuid REFERENCES core.users(id),
  reviewed_at timestamptz,
  decision_note text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_vendor_app_ntn_pending ON core.vendor_applications(ntn)
  WHERE state IN ('Submitted','Under_Review');
```

`ux_vendor_app_ntn_pending` stops the same company applying twice while an earlier
application is still live, without blocking a re-application after a rejection.

`db/scripts/verify_028.sql` asserts: the backfill linked both supplier logins;
the CHECK rejects a `vendor` with no `vendor_id`; the unique index rejects two
logins on one vendor; the sequence produces sequential real references; the
partial unique index allows a re-application after rejection but blocks a
duplicate while pending; every state value round-trips.

---

## 5. Decisions locked (user, 2026-09-30)

| # | Decision |
|---|---|
| W4-1 | **Surface** — `supplier-rfq` and `supplier-quote` live in `apps/web`, gated to `role = 'vendor'`, exactly where the prototype's nav puts them. `vendor-onboard-public` stays a public page in `apps/onboarding` (33004). **Amendment (user, 2026-09-30):** `apps/supplier` is to be **deleted outright**, not merely de-listed from the launch script — the folder itself goes, along with its `supplier:dev` script. Not yet executed; it ships with step 4, which also updates `.launch-next-v2.ps1` and the UAT walkthrough (R3). |
| W4-2 | **Sealing copy** — prototype layout, labels and position kept; the one false sentence is corrected to: *"Your quote is visible to the buyer as soon as you submit it. You may revise it until the RFQ is closed."* "Closing in 7 days" becomes the real `Due <date>`, matching how Wave 2 already treats `deadline_at` as display-only. |
| W4-3 | **Supplier identity** — `core.users.vendor_id`, backfilled. Endpoints scope by it. `rfq_invitations.token_hash` stays inert. |
| W4-4 | **Onboarding form** — the prototype's five fields exactly. The scaffold's extra phone / IBAN / address fields are **dropped**; the prototype is the source of truth. |
| W4-5 | **Append-only quoting** — a supplier revising a quote INSERTs a new version and marks the prior one `Superseded`, reusing `QuotationService`'s existing semantics. No UPDATE ever rewrites a prior version's price. |
| W4-6 | **No rate limiter this wave** (user, 2026-09-30, answering R6) — the public application endpoint is guarded by `ux_vendor_app_ntn_pending` alone. No new rate-limiting infrastructure is built in Wave 4. Revisit when the endpoint is exposed beyond the dev origin. |

---

## 6. API surface

New `apps/api/src/supplier/` module, gated by a `SupplierGuard` that resolves
`users.vendor_id` and refuses any session without one.

| Method | Path | Role | Purpose |
|---|---|---|---|
| `GET` | `/supplier/inbox` | vendor | Invitations scoped to the vendor + the 4 KPI values + roster |
| `GET` | `/supplier/rfq/:invitationId` | vendor | The quote form: RFQ header, lines, my current quote version |
| `POST` | `/supplier/rfq/:invitationId/quote` | vendor | Submit / revise — append-only |
| `POST` | `/supplier/rfq/:invitationId/decline` | vendor | Decline with a reason |
| `GET` | `/vendors/applications` | procurement, cs, admin | Wave 4's read side, so intake is provably visible |

New `apps/api/src/onboarding/` module:

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/onboarding/applications` | **public** | Create an application, return the real reference |
| `GET` | `/onboarding/applications/:reference` | **public** | Status lookup |

`POST /onboarding/applications` is deliberately unauthenticated — the prototype's
alert says so, and it is the same reasoning as `POST /ack/:token/accept`: this is
a public intake form, not an authenticated resource. The reference is returned so
the applicant can track it.

Every KPI on the inbox is **computed**, never the prototype's literals:
`Active RFQs` = open invitations · `Quoted by me` = yes/no + version ·
`Competitors quoted` = `count(submitted) of count(invited)` ·
`Est. value` = the buyer's real estimate.

---

## 7. Fabricated values to eliminate

| Prototype | Ours |
|---|---|
| `Acting as PakBoxes Pvt Ltd · V-000123` | the real `legal_name` · `vendor_code` |
| `RFQ-2026-0042`, `Issued 2026-08-28`, `Due 2026-09-05` | real ids and timestamps |
| `Other invited vendors: KarachiTech, Indus Office Solutions` | the real roster |
| KPI values `1` / `No` / `2` / `PKR 21.8 L` | computed per §6 |
| Unit price pre-filled with `base / totalQty` | **blank** — a guessed price is a fabricated quote |
| `ONB-{Math.random()}` | `ONB-2026-00001` from the sequence |

The prototype pre-fills every unit price with `Math.round(estimated / totalQty)`.
That is a *guess dressed as a quote*, so the ported form starts empty and the
Quote total reads `—` until a real price is entered.

---

## 8. Steps

| Step | Work | Depends on |
|---|---|---|
| 0 | Migration 028 + `verify_028` | ✅ **DONE 2026-09-30** — 28/28 from empty, idempotent, 14 sections green (`npm run db:verify:028`) |
| 1 | `workflow-engine/src/supplier.ts` — inbox KPIs, quote line math, per-line totals, empty-state strings | ✅ **DONE 2026-09-30** — 51 new tests, engine 100→151 |
| 2 | `apps/api/src/supplier/**` — guard, inbox, form, submit (append-only), decline, `GET /vendors/applications` | ✅ **DONE 2026-09-30** — 87 live API assertions, 259 unit |
| 3 | `apps/api/src/onboarding/**` — public submit + status lookup | ✅ **DONE 2026-09-30** — 61 live + 20 unit, 279 total |
| 4 | `apps/web/pages/supplier/{inbox,quote}.tsx` + wire `Shell.ROUTES` | ✅ **DONE 2026-09-30** — 31 render tests, 310 unit, `apps/supplier` deleted |
| 5 | `apps/onboarding/pages/index.tsx` — port the five fields to the real endpoint | ✅ **DONE 2026-09-30** — 31 HTTP assertions in dev AND production, 310 unit |
| 6 | Verification — `test:web` render tests + `scripts/e2e_wave4.mjs` | ✅ **DONE 2026-09-30** — 114 live assertions, 17 sections, mutation-proved, wired as `npm run e2e:wave4` |
| 7 | Full regression, `WAVE4_PLAN.md` as-built | ✅ **DONE 2026-09-30** — 841 e2e (12 suites) + 310 unit, gap matrix 37/37, 1 cross-wave regression found and fixed, 2 open gaps recorded |

Steps 1, 3 and 5 are independent of 2 and 4.

---

## 9. Verification — carrying Wave 3's lesson forward

Wave 3 found three clusters of assertions that **passed vacuously** because every
page is client-rendered and the server HTML is an empty shell. Two rules apply
from the start:

1. **Never assert on server HTML for these pages.** Assert on the compiled page
   chunk (that the prototype title and screen id ship) and on the API payload the
   page consumes — exactly what `e2e_governance_web.mjs` does now.
2. **A counting assertion must be able to count.** "0 un-ported items" is
   meaningless if the markup isn't in the response at all. Every new assertion
   gets a deliberate failure injected once to prove it can fail.

`npm run test:web` extends to a `supplier.render.test.tsx` covering: the 4-up KPI
band with real values, the 4-column and 6-column table headers in prototype order,
the empty inbox state, the blank-unit-price rule, the revised sealing sentence
present **and** the prototype's "sealed until" wording **absent**, and the
`ONB-` reference pattern.

`scripts/e2e_wave4.mjs` covers: a `vendor` sees only its own invitations; a
`vendor` cannot read or write another vendor's quote; procurement/CS/admin cannot
use the supplier endpoints; quote revision creates version 2 and supersedes
version 1 without altering version 1's price; decline flips the invitation and
shows the reason; the public application endpoint works with **no** token and
returns a real sequential reference; a duplicate pending NTN is refused; and the
retired `apps/supplier` is no longer served.

---

## 10. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | The `users.vendor_id` backfill matches nothing, leaving suppliers unusable | `verify_028` asserts both seeded logins are linked; the assertion is a count, so zero links fails |
| R2 | The vendor `CK` breaks a future vendor row created by a migration | Vendor seed rows live in `seed.sql`; a new seeded supplier must set `vendor_id` in the same statement |
| R3 | Retiring `apps/supplier` breaks a bookmark or the launch script | `.launch-next-v2.ps1` and the UAT walkthrough are updated in the same step |
| R4 | Supplier quote submission diverges from procurement quote submission | The supplier path reuses `QuotationService`'s version/supersede semantics rather than reimplementing them |
| R5 | "Honest copy" reads as an unrequested redesign | W4-2 is explicitly user-locked, and the render test pins both the new sentence and the absence of the old one |
| R6 | Public endpoint abused to spam applications | **Closed by decision W4-6 (user, 2026-09-30): no rate limiter in this wave.** The partial unique index on a live NTN is the sole control; see `028_supplier_external.sql` and verify_028 §7-8. If the endpoint is ever exposed beyond the dev origin, this risk reopens. |
| R7 | The new `ck_users_vendor_role` CHECK makes a fresh database unseedable | **Found and fixed in step 0.** `core.users.vendor_id -> core.vendors(id)` and `core.vendors.created_by_user_id -> core.users(id)` form a cycle, and the seed inserted all users before any vendor. Migrations run before the seed, so the CHECK already existed when the vendor logins were inserted. `seed.sql` now inserts the 19 non-supplier users, then the vendors, then the 2 supplier logins with an explicit `vendor_id`. Proved by a full `reset.ps1` -> 28 migrations -> seed, clean. |

---

## 11. Definition of done

- [x] Migration 028 applies clean from empty; 28 migrations total; `verify_028` green.
      ✅ 2026-09-30 — 28/28 from empty AND on re-run, 14/14 sections, 199 unit green.
- [x] **Both supplier screens render at prototype fidelity** — titles, subtitles, KPI
      band, column order, button labels, empty state.
      ✅ 2026-09-30 — **37/37** prototype elements confirmed present by the step-7 gap
      matrix. ⚠️ Two elements are absent and are recorded as **open gaps** in §20.2: the
      inbox card's per-RFQ line table, and the `Issued` date on the card meta.
- [x] `vendor-onboard-public` renders the prototype's five fields and returns a
      real `ONB-YYYY-NNNNN` reference.
      ✅ 2026-09-30 — five fields asserted in dev AND production (31 HTTP assertions);
      the reference comes from `core.seq_vendor_app_ref`; `verify_028` §6 proves the
      sequence continues across applications.
- [x] **A `vendor` session sees only its own invitations and can write only its own
      quotes; procurement sessions are refused by the supplier endpoints.**
      ✅ 2026-09-30 — `e2e_wave4` §3/§4/§9. Proven by mutation, not by comment: a
      cross-tenant read pointed at the caller's own invitation makes the 404 fail.
- [x] **A revised quote appends a version; no prior version's price is ever rewritten.**
      ✅ 2026-09-30 — `e2e_wave4` §8 compares a V1 snapshot against a re-read of the
      same row byte-for-byte. B1 in the mutation harness re-points the "after" snapshot
      at version 2 and breaks **three** assertions, so the comparison is provably
      between two live values.
- [x] **No `Math.random()`, no sealed-quote claim, no countdown, no `V-000123`, no
      `PakBoxes Pvt Ltd`, no `ONB-` random reference anywhere.**
      ✅ 2026-09-30 — ten fabrications scanned with comments stripped, plus S22/S27 on
      rendered markup and `e2e_wave4` §6/§14 on the live payloads. The prototype has no
      `ONB-` at all; the port's reference is DB-generated.
- [x] **Regression green: 27→28 migrations, 199 unit, 727 e2e, plus Wave 4 additions.**
      ✅ 2026-09-30 — **310 unit** (199 → 310) and **841 e2e across 12 suites**
      (727 → 841, i.e. the Wave 3 baseline unchanged and +114 for Wave 4),
      `db:verify:028` 14/14. The first chain run **failed exit 1** and is
      written up in §20: a Wave 4 JSDoc comment quoted a placeholder that Wave 3
      forbids in a compiled chunk. Fixed, re-verified by re-fetching the chunks.
- [x] `WAVE4_PLAN.md` updated as-built.
      ✅ 2026-09-30 — §13-§20, one per step, plus the §20 close-out.

---

## 12. Open for you

Nothing blocking. Both questions from the plan review are now **answered and
locked** (2026-09-30):

- **R6** → the unique-index guard alone, no new rate-limiting infrastructure in
  this wave. Recorded as W4-6.
- **`apps/supplier`** → delete the folder outright, not just stop launching it.
  Recorded as an amendment to W4-1; execution ships with step 4.

---

## 13. Step 0 outcome — 2026-09-30

`db/migrations/028_supplier_external.sql` (additive, idempotent) +
`db/scripts/verify_028.sql` (14 sections) + `npm run db:verify:028`.

**Verified, not asserted:**

| Check | Result |
|---|---|
| Full reset -> migrate from empty | **28/28 OK, 0 FAIL** |
| Re-run migrate on a populated DB | **28/28 OK, 0 FAIL** |
| `verify_028.sql` | 14/14 sections green |
| `npm test` | **199 pass, 0 fail** (100 engine + 24 roles + 58 api + 17 web) |
| Reset postcondition | 1 PR row, 6 vendors |

### What landed

- **B1** `core.users.vendor_id` (FK -> `core.vendors`), backfilled, with
  `ux_users_vendor_id` (partial unique) and `ck_users_vendor_role` (CHECK).
  Both seeded supplier logins link to the correct vendor.
- **B2** `core.vendor_applications` + `core.seq_vendor_app_ref` +
  `core.fn_next_vendor_app_reference()`, with `reference` **defaulted from the
  sequence** so the API layer structurally cannot fabricate an `ONB-` value the
  way `apps/onboarding` does today. `ux_vendor_app_ntn_pending` (partial unique)
  + `idx_vendor_app_queue`.
- **B6** `COMMENT ON proc.rfq_invitations.token_hash` records the token as
  retained-but-inert, mirroring how `024_sourcing.sql` documented `sealed_hash`.

### Three things step 0 changed about the steps that follow

1. **The seed had to be split (R7) — this was a blocker, not a nicety.**
   `users.vendor_id -> vendors.id` and `vendors.created_by_user_id -> users.id`
   are a genuine cycle. Migrations run *before* the seed, so `ck_users_vendor_role`
   already existed when `seed.sql` inserted the two `role='vendor'` rows with no
   `vendor_id`. **A fresh database could not have been seeded at all.** The seed
   now inserts the 19 non-supplier users, then the vendors, then the 2 supplier
   logins. Anyone adding a third supplier login must add it to the *second*
   users insert, after the vendors block.

2. **The backfill uses `left()`/`length()`, not `LIKE`, and that is deliberate.**
   The obvious spelling — `legal_name LIKE display_name || '%'` — reads a `_` in
   the display name as a single-character wildcard, so a vendor login called
   `Box_Co Packaging` would match any legal name with one character in that
   position, silently linking to the wrong company or to two of them. Today's
   data has no `_` or `%` in either display name, so nothing was ever at risk;
   the point is that the *next* login must not be either. `left()` is the same
   test with no pattern language in it.

3. **The reference is DB-generated, so the fabrication cannot come back.**
   `reference` has a DEFAULT, not a service-supplied value. `verify_028` §10
   asserts the default exists rather than trusting the migration's comment.

### Two defects found and fixed outside this step

- **Migration `026_quotations.sql` was not idempotent.** `ADD CONSTRAINT
  quotation_lines_rfq_line_fkey` had no preceding `DROP ... IF EXISTS`, so
  re-running `npm run db:migrate` on an already-migrated database reported
  `FAIL` — which is how a real migration failure stops being visible. Fixed
  with the same guard 027 already uses one file later. All 28 are now
  idempotent.
- **`verify_027.sql` and `020_line_routing.sql` are mojibake on disk** (U+00E2 /
  U+201D / U+20AC — CP1252 mis-decoding of `═` and `─`, 206 and 186 sequences).
  Confined to comment text and `\echo` strings: no code and no data literal is
  affected, so nothing behavioural is wrong. It does make the verification
  banners unreadable. Not repaired yet — it is cosmetic and belongs to Waves
  1 and 3, not to step 0. Both new files were byte-checked clean (no BOM, no
  mojibake).

### Verification honesty

Per §9 rule 2, the "0 unlinked supplier logins" assertion was proven capable of
counting: with the CHECK dropped and one unlinked vendor row inserted inside a
transaction, the same query returns **1**; after `ROLLBACK` it returns **0** and
the CHECK is present. A counting assertion that cannot count is worse than no
assertion.

One check in the first draft of `verify_028` passed for the wrong reason — the
duplicate-login test used `V-00084`, which no login was linked to, so the insert
was never a duplicate and the unique index was never actually tested. It now
collides on `V-00081`, which already has a login, and asserts that precondition
first.

---

## 14. Step 1 outcome — 2026-09-30

`packages/workflow-engine/src/supplier.ts` + `__tests__/supplier.test.ts`
(51 tests). Pure — no I/O, no clock, no randomness, so the API (step 2) and the
renderer (step 4) cannot disagree about a total, a status or a string.

**Suite: 250 unit green** (151 engine + 24 roles + 58 api + 17 web), up from 199.

| Delivered | Prototype source |
|---|---|
| `inboxKpis()` — 4-up band, every value computed | `renderSupplierInbox` :9009-9014 |
| `supplierRoster()` + `vendorPill/Status/coverageFor` | :9026-9028 |
| `quoteLineTotals()` / `quoteLineTotal()` / `moneyOrDash` | `quoteRecalc` :7312-7340 |
| `validateSupplierQuote()` | `supplierSubmitQuote` :7342-7358 |
| `fmtPKR()` | `fmtPKR` :7363-7368 |
| Copy constants + subtitle/paragraph/alert builders | :9017-9018, :9032-9044 |
| `leadTimeDays/warrantyMonths/paymentTermsDays` | select options :9060-9064 |
| `canUseSupplierSurfaces()` | `STATE.role!=='vendor'` :7343 |

### Four decisions, on the record before step 2 builds on them

1. **`fmtPKR` is the prototype's, not the web app's `pkr()`.** `supplier.ts`
   reproduces the abbreviating Cr/L/K ladder; `apps/web/lib/ui.tsx`'s `pkr()`
   prints full digits. Both are correct for their own screens — these two are
   being *ported*, so they get the prototype's format. There is now an explicit
   comment in `supplier.ts` telling the next reader not to "unify" them.

2. **An unpriced line is `null`, never `0`; and the quote total stays `—` until
   every line is priced.** This is the deliberate break from `quoteRecalc`,
   which sums whatever is typed and paints a partial sum into "Quote total".
   On a half-filled form that understates the quote and looks like a real
   number. `quoteLineTotals` returns `total: null` so the two states stay
   distinguishable all the way to the renderer. A *complete* form priced at 0
   still totals `0` — an entered zero is a price, an absent one is not.

3. **`admin` does NOT get the supplier surfaces.** `canUseSupplierSurfaces` is
   strictly `role === 'vendor'`, deliberately excluding the admin alias that
   governs back-office features. A super-role able to impersonate a supplier
   would defeat the exact scoping migration 028 exists to guarantee. Asserted
   twice (S50, S51) so a future `ROLE_ALIASES` edit cannot grant it silently.

4. **An unparseable commercial term is rejected, never defaulted.** `"whenever"`
   → `null`, not 7 days. Falling back would write a lead time into
   `proc.quotations` that no supplier ever agreed to. The same reasoning keeps
   `SUPPLIER_TERM_DEFAULTS` asserted to be real options (S30) — a default that
   is not in its own select list renders nothing selected and submits a label
   the converter would reject.

### Verification honesty

S05 asserts the four KPIs reproduce the prototype's own hardcoded `1` / `No` /
`2` / `PKR 21.8 L` **from real data** — so a wrong computation shows up as a
diff against the prototype's text, not as an absence.

Mutation-tested rather than assumed: forcing `quoteLineTotals` to the
prototype's always-sum behaviour (the exact regression this module exists to
prevent) was caught by **3 tests** (S20, S23, S24), and the probe was reverted
and the suite re-confirmed at 151/151 with no probe text left in the source.

One test failed during authoring — S04 assumed 999,999 reaches the
`toLocaleString` branch, but it lands in the `L` branch. That was the test
being wrong, not the code; it now asserts the real determinism guarantee
(ASCII-only abbreviated output) instead.

### Not done in step 1

`apps/supplier` is still on disk; its deletion ships with step 4 alongside the
launch-script and `supplier:dev` cleanup (W4-1 amendment, R3).

---

## 15. Step 2 outcome — 2026-09-30

`apps/api/src/supplier/{guard,service,controller,module}.ts`, plus a
`vendor_id` on the session, a shared quote write path, and
`GET /vendors/applications`.

| Check | Result |
|---|---|
| Live probe against a freshly reset database | **87 assertions, 0 failed** |
| `npm test` | **259 pass, 0 fail** (152 engine + 24 roles + 66 api + 17 web) |
| `api:build` | clean |

Endpoints: `GET /supplier/inbox`, `GET /supplier/rfq/:invitationId`,
`POST /supplier/rfq/:invitationId/quote`, `POST /supplier/rfq/:invitationId/decline`,
`GET /vendors/applications`.

### R4 honoured by extraction, not by copy

The version-chain logic was **moved** into a private `appendVersion()` inside
`QuotationService`, not reimplemented. `record()` (procurement) and the new
`submitAsVendor()` (supplier) are now two gates over one implementation. The one
behavioural difference is an explicit `revise` flag: `record()` keeps its
original refusal (procurement revises via `POST /quotations/:id/supersede`,
unchanged), while `revise: true` is the supplier path, where re-submitting IS
the revision and refusing it would strand a vendor who genuinely wants to change
their price.

Verified live, not just compiled: V1 `500.00 / probe v1` is byte-identical after
V2 supersedes it, only `state` changed, exactly one live quote exists afterwards,
and the chain reads `1:Superseded` then `2:Submitted`.

### Scoping, proven by the probe rather than asserted in a comment

`AuthenticatedUser` gained `vendorId` (migration 028). Every supplier query is
filtered by it, and no supplier endpoint ever accepts one from the request.

- vendor1 and vendor2 receive **different** invitation ids from the same RFQ.
- vendor1 reading vendor2's invitation is **404, not 403** — a 403 would confirm
  it exists. The probe asserts the message does not leak existence either.
- `procurement`, `cs`, `admin` and `requester` are all refused `/supplier/inbox`.
- A `vendor` is refused `/vendors/applications`; `procurement`, `cs` and `admin`
  are admitted (admin via `ROLE_ALIASES`).

A body `vendorId` naming another vendor is **ignored, not refused** — and the
probe asserts *where the quote landed* (vendor2's quote count unchanged,
vendor1's at V3) rather than a status code. Reason: `ValidationPipe({whitelist:
true})` strips undeclared properties before the service runs, so a check there
would be a guard that can never fire. The reachable defence-in-depth is
`submitAsVendor()`'s own check.

### Four bugs the probe caught that the build never would

1. **`rf.incoterms` does not exist** (it is `rf.incoterm`) — every quote-form
   load 500'd.
2. **`proc.rfq_lines` has no `sku` column.** The prototype's line table shows
   one, reached via `rfq_lines.pr_line_id -> pr_lines.item_id ->
   items.item_code`. Without the join, every form load 500'd.
3. **Commercial terms were stored but never echoed back.** The INSERT's
   `RETURNING` omitted `lead_time_days`, `warranty_months`, `payment_terms`,
   `notes`, `taxes_included`, `validity_days`, so a vendor who chose "3 yr" saw
   a success response with `warranty_months: null` and no way to tell the terms
   had been dropped. Now returned.
4. **A declined vendor was dropped from the "of N invited" denominator while
   still being listed on the roster** — so the card header said "2 invited" over
   3 rows. Corrected: the denominator counts everyone invited, the numerator
   only counts live quotes. "Invited" is a fact about the past and should not
   shrink when somebody walks away. A declined vendor stays on the roster with a
   distinct `declined` pill rather than pretending they were never asked.

### One deliberate protocol change

The quote alert now names the **real buying department from the PR**, not a
literal. The prototype's "Quote for PakBoxes Pvt Ltd (V-000123)" is one string
doing two jobs — fake buyer *and* fake supplier — and the schema has no
buyer/tenant table, so the department is the honest available answer.
`supplierQuoteAlert()` was reduced to one argument and its test updated.

### Not done in step 2

`apps/supplier` is still on disk (deletion ships with step 4, per W4-1 / R3).
The formal `scripts/e2e_wave4.mjs` is step 6; step 2 was verified with a live
probe of the same shape, which found all four bugs above.

---

## 16. Step 3 outcome — 2026-09-30

`apps/api/src/onboarding/{service,controller,module}.ts` + 20 unit tests.

| Check | Result |
|---|---|
| Live probe (run 3x, no manual cleanup between) | **61 assertions, 0 failed, every run** |
| Residue after 3 runs | 0 rows |
| `npm test` | **279 pass, 0 fail** (152 engine + 24 roles + 86 api + 17 web) |
| `api:build` | clean |

Endpoints: `GET /onboarding/form` · `POST /onboarding/applications` ·
`GET /onboarding/applications/:reference?email=`

The reference is never generated in the service. `core.vendor_applications
.reference` has a DEFAULT from `core.fn_next_vendor_app_reference()` (migration
028) and the API returns what the database assigned. Verified live: three
submissions produce adjacent, increasing, real references.

### The design decision this step forced, and it is not a detail

**The status lookup requires the applicant's email as a second factor.**

`core.seq_vendor_app_ref` is sequential by design — the plan asked for
`ONB-2026-00001`, `00002`, … so references read as real. That makes every
reference **enumerable**. Answering on the reference alone would have turned
`ONB-2026-00001..N` into a directory of every applicant's company name, NTN and
contact email, readable by anyone on the internet.

W4-6 removed the rate limiter, which removes the other control that would have
limited enumeration. What remains is the email requirement, so the combination is
safe rather than merely quiet. The live probe walks the entire reference
sequence with a wrong email and asserts **0 of N** leak.

The response is deliberately a **subset** — `reference`, `state`, `submittedAt`,
`reviewedAt`, `decisionNote`, `referenceNote`, `pending`, `notice`. No
`legal_name`, no `ntn`, no contact details: a status lookup that echoed the
application would hand over the very fields the email check protects.
`decision_note` is the exception because Procurement writes it *for* the
applicant — it is how a rejection explains itself.

A wrong email is **404, not 403**, and the message must not contain "exists".

### Two bugs the probe caught

1. **`ON CONFLICT ON CONSTRAINT ux_vendor_app_ntn_pending` 500'd every
   submission.** That form accepts CONSTRAINTS only; `ux_vendor_app_ntn_pending`
   is a bare unique **INDEX**, so psql reported `constraint ... does not exist`.
   Corrected to index inference —
   `ON CONFLICT (ntn) WHERE state IN ('Submitted','Under_Review') DO NOTHING` —
   whose predicate must match the index exactly. `rowCount === 0` then signals
   the duplicate, which is race-free (a read-then-compare would let two
   simultaneous submissions both see no existing row) and avoids the
   `psql exited 3: duplicate key` 500 that the bridge would otherwise produce.
2. **The DTO pre-empted the prototype's own wording.** `@IsString()` on
   `legalName` made `ValidationPipe` answer a missing field with
   *"legalName should be a string"* — developer-speak naming a JSON key that
   appears nowhere on a form labelled "Company name". `legalName` and `ntn` are
   now `@IsOptional()` and presence is decided in the service, which owns the
   copy. Required-ness is a product rule that lives with the wording, not a type.

A third failure was the probe's own: its happy path still sent a hard-coded NTN
from an earlier run, so a genuine duplicate was correctly refused. The probe now
uses run-scoped NTNs and cleans up after itself, and was confirmed repeatable
across three consecutive runs.

### Other choices, on the record

- **The category vocabulary is real.** The prototype hardcodes three options
  ("Office equipment", "IT hardware", "Services") of which only "IT hardware" is
  a real category id. The form serves all nine `LIGHT_ITEM_CATEGORIES` and stores
  the **id** — accepting either the id or a label, and refusing anything else,
  because an unrecognised category in `preferred_categories` is worse than none.
- **Single category, matching the prototype's single `<select>`.**
  `core.vendor_applications.categories` is `text`, not `text[]`. A multi-category
  application is a schema question for when the Wave 5 review UI decides what it
  needs — not something to change the migration for now.
- **This is the only unguarded controller in the app**, deliberately, because the
  prototype's screen says "no login required". Everything that makes it safe is
  written in the controller and service docstrings so the next reader finds it
  before adding a field.

### Verification honesty

The security-critical assertion (no PII in the status response) was
mutation-tested: adding `legal_name` to the response was caught by O18, the probe
was reverted, the suite re-confirmed at 86/86, and no probe text remains in the
source.

### Not done in step 3

`apps/onboarding/pages/index.tsx` still renders its own non-prototype form and
still contains `ONB-{Math.floor(Math.random() * 99999)}`. Replacing that UI is
**step 5**; nothing consumes the new endpoints until then.

---

## 17. Step 4 outcome — 2026-09-30

`apps/web/components/supplier/SupplierCards.tsx`,
`apps/web/pages/supplier/index.tsx`, `apps/web/pages/supplier/[invitationId].tsx`,
`apps/web/tests/supplier.render.test.tsx` (31 tests), plus the `apps/supplier`
retirement.

| Check | Result |
|---|---|
| `npm test` | **310 pass, 0 fail** (152 engine + 24 roles + 86 api + 48 web) |
| `next build` | 23 pages, both new routes built, no type errors |
| Live route check | `/supplier` 200, `/supplier/[invitationId]` 200 |
| Port 33003 | refused — the retired app no longer serves |
| `e2e:render_contract` | **30 assertions, 0 failed** |

### Why the screens are components, not just pages

A Next.js page here returns `null` until a session exists, so the server HTML is
an empty shell and "the route returns 200" proves nothing about what a supplier
sees. The markup lives in `SupplierCards` and is asserted with
react-dom/server, exactly as Wave 3 did for the governance cards. The pages only
fetch and wire.

The renderer holds no business logic: KPIs, roster rows, coverage strings, the
copy and the money format all arrive computed from the engine. That is what
makes "the screen and the API cannot disagree" structural rather than aspirational.

### A third suite, closing a gap the first two leave open

`test:api` proves the API returns the right VALUES. `test:web` proves the
components render the right MARKUP — from fixtures **built by hand**. Neither
proves the two agree on the **SHAPE**: a renamed field in `SupplierService` would
pass all 86 API assertions and all 48 render assertions while the real page
rendered `undefined`.

`scripts/render_contract.mjs` (`npm run e2e:render_contract`) fetches the LIVE
API as a supplier and renders the REAL component with that exact payload,
asserting every roster name, KPI and line description appears, and that no
`undefined`, `NaN` or `[object Object]` leaks into the markup. 30 assertions,
including after a real submission, so the version chain is exercised end to end.

It caught nothing this time, which is the point: it is a standing guard for the
next person who renames a field.

### Three prototype behaviours deliberately not ported

1. **No sealed bid (Q2 / W4-2).** S27 asserts the rendered markup of all five
   supplier components contains neither "sealed until" nor "closing in" — the
   plan's §9 test (d), asserted where a reviewer actually sees it.
2. **No pre-filled unit price.** The prototype computes
   `Math.round(estimated / totalQty)` into every box (:9040). S16 asserts a blank
   price renders an em-dash and that `21800` (the prototype's guess for a 10-unit
   line) appears nowhere.
3. **No partial Quote total.** S17 asserts a half-filled form shows no total at
   all rather than the sum of the priced lines, which is `quoteRecalc`'s
   behaviour and understates the quote. S19 pins the other half of that rule: a
   COMPLETE form priced at 0 shows `PKR 0`, because an entered zero is a price
   and only an absent one is unknown.

### `apps/supplier` deleted outright (W4-1 amendment, R3)

Recoverable delete. Port 33003 was stopped first and now refuses connections.
`apps/` is `api`, `onboarding`, `web`.

Every reference removed, all verified by a repo-wide grep:

- `package.json` — `supplier:dev` gone; `package-lock.json` regenerated (0 hits)
- 9 scripts: `.launch-next-v2`, `.restart-api-only`, `.restart-services`,
  `.launch-next`, `.launch-next2`, `.launch-web`, `.check-next`, `.curl-check`,
  `.http-check`, `.port-check` — port 33003 and the app entry removed
- `README.md`, `UAT_WALKTHROUGH.md` — the portal row, the `supplier:dev` command,
  the tree entry and the log path

`Shell.ROUTES` now maps both `supplier-rfq` and `supplier-quote`, and both left
the `PENDING` map, so they stop rendering with a "Wave 4" badge. `supplier-quote`
lands on `/supplier` for the same reason `pr-review` and `rfq-detail` do: it
needs an id, so the nav entry opens the inbox where a row navigates in.

### A mistake of my own, caught by a detector I had not written properly

While promoting the contract check into `scripts/` I copied a non-ASCII file with
PowerShell `Get-Content -Raw | Set-Content` — the exact mojibake trap this project
already has a memory entry for — and corrupted five lines.

It was nearly missed, because the mojibake needle in that memory entry
(`â` + `"` + `€`) only matches the byte order of `═`/`─`. Damaged `—`, `…` and
`×` come out as a DIFFERENT order (`â` + `€` + `"`), so the detector reported
**0** on a damaged file.

The file was rewritten and a general detector — any of `Â`/`Ã` followed by a
CP1252 sign-of-damage cluster — was then run across all 28 files this wave has
touched. Result: clean. The corrected pattern is in memory.

### Not done in step 4

`apps/onboarding/pages/index.tsx` is untouched and still fabricates
`ONB-{Math.floor(Math.random() * 99999)}` — that is **step 5**, which will also
consume the step-3 endpoints. `scripts/e2e_wave4.mjs` is **step 6**; the
`render_contract.mjs` above is step 4's own verification and is a separate
artefact, not a substitute for it.

---

## 18. Step 5 outcome — 2026-09-30

`apps/onboarding/pages/index.tsx` (rewritten), `pages/_app.tsx` (new),
`styles/globals.css` (new), `scripts/check_onboarding_page.mjs`.

| Check | Result |
|---|---|
| `npm test` | **310 pass, 0 fail** (unchanged — step 5 is UI) |
| `next build -w apps/onboarding` | clean, 4.4 KB stylesheet emitted |
| `npm run e2e:onboarding_page` — **dev server** | **31 assertions, 0 failed** |
| `npm run e2e:onboarding_page` — **production server** | **31 assertions, 0 failed** |
| Mojibake (general detector) | clean |

### The page holds no copy of its own

Every string on the form — title, subtitle, the public-form alert, the five
field labels, which fields are required, the button text, the category list —
comes from `GET /onboarding/form` (step 3). The prototype's copy is preserved
because **the API serves the prototype's copy**, not because this page restated
it. That is why the app needs no dependency on `@procurement/workflow-engine`:
it is a workspace that hoists, so importing an undeclared package would work by
accident and break on a clean install.

### CSS extracted from the prototype, not invented

`styles/globals.css` is copied verbatim out of the prototype's `<style>` block
(`--accent:#2E86C1`, `.public-shell{max-width:880px;margin:0 auto;padding:48px
24px}`, `label.field .lbl .req{color:var(--danger)}`, and so on). Only the rules
this page uses are carried across; the prototype's sheet is ~44 KB for every
screen. The comment header says "kept verbatim means kept recognisable" so the
next reader knows an odd-looking selector is fidelity, not debris.

One deviation, documented in place: the prototype hides `.public-screen` and
reveals it with a `body.screen-public` class, because *its* single page hosts
three mutually exclusive shells. This app has one shell, so the class is dropped
and `.public-screen` simply displays. Importing the toggle would mean importing
a mechanism with nothing to toggle.

### Three prototype behaviours deliberately not ported

1. **No pre-filled demo values.** The prototype ships `value="PakBoxes Pvt Ltd"`,
   `value="1234567-8"`, `value="Ahsan Ali"`, `value="sales@pakboxes.pk"` and
   selects "IT hardware". On a real public form every applicant would submit the
   same company and the same tax number. The probe asserts all four literals are
   absent from the served shell.
2. **The reference is the database's.** The old page rendered
   `ONB-{Math.floor(Math.random() * 99999)}` — a reference that existed in
   neither the database nor anywhere else. The probe asserts no `Math.random`, no
   `ONB-{` and no `99999` survive, and that a real submit through the API returns
   `ONB-<year>-<5 digits>`.
3. **The end state is a lookup, not a screen swap.** The prototype's button does
   `setRole('procurement'); show('vendor-risk')` — it pretends the applicant is a
   logged-in procurement user. A public applicant has no session and nothing to
   act on, so the honest end state is the reference they were given plus the
   status lookup the step-3 endpoint exists for. The lookup's email is
   pre-filled from what they just submitted, because that is also the second
   factor the endpoint requires.

### Two checks that were wrong before they were right

- **Asserting a `<link rel=stylesheet>`.** Next's dev server hides the body
  (`data-next-hide-fouc` → `body{display:none}`) and injects CSS through the
  `_app` chunk, so a dev shell legitimately has no stylesheet link. The check now
  looks in **both** places and passes in dev and production.
- **Asserting `#2E86C1` with the prototype's exact casing.** A production
  minifier rewrites it `#2e86c1`, so the check failed on correct CSS. Token
  *presence* is the contract; casing is a minifier's business.

Running `next build` while the dev server was live also clobbered `.next` and
made the dev server serve an empty shell — the exact hazard the UAT walkthrough
warns about. The "production" run that first appeared to fail 16 checks was a
broken dev server, not a broken page; a real `next start` was needed to test it.

### UAT_WALKTHROUGH.md

Section 7 gained divergences 10-17 covering the supplier screens in the web app
(port 33003 is gone), the honest visibility note replacing "sealed until", the
blank price boxes and the `—` total, vendor scoping, the empty public form, the
real sequential reference, the email second factor, and the duplicate-NTN rule.
Section 1's onboarding row now describes what to expect. Section 9 lists the
step-4 and step-5 scripts and warns that they create real data and need a reset
first.

### Not done in step 5

`scripts/e2e_wave4.mjs` — the consolidated Wave 4 suite — is **step 6**.

---

## 19. Step 6 outcome — 2026-09-30

`scripts/e2e_wave4.mjs` (new, 17 sections), plus one line in `package.json`:
`e2e:wave4`, and the same script appended to the end of the `e2e` chain.

| Check | Result |
|---|---|
| `npm test` | **310 pass, 0 fail** (152 engine + 24 roles + 86 api + 48 web) |
| `npm run e2e:wave4` | **114 assertions, 0 failed**, exit 0 |
| Repeat run, no reset | **114 assertions, 0 failed** — fixtures are run-scoped |
| Mutation harness (5 probes) | all hold; each forces `exit=1` and fires its named assertion |
| Mojibake (general detector, 22 files) | clean |

### The sections

`0` preflight · `1` `db:verify:028` · `2` fixture (a PR advanced by
`hod.sales@pakboxes.pk`, then an RFQ with two suppliers invited) · `3` a supplier
sees only their own RFQs · `4` the guard refuses every non-supplier · `5` the
inbox is computed, never the prototype's literals · `6` nothing fabricated ·
`7` the quote form starts blank · `8` quotations are APPEND-ONLY · `9`
cross-tenant writes are impossible · `10` decline · `11` the public onboarding
intake is REAL · `12` the intake is not harvestable · `13` intake is visible to
Procurement and invisible to suppliers · `14` the screens render the API
payload · `15` `apps/supplier` is gone · `16` cleanup.

### Repeatable without a reset

Every fixture is stamped with a run-scoped suffix (`RUN`, derived from the
clock), so NTNs and applications never collide with an earlier run. The suite
therefore re-runs green on a populated database — which matters, because
`verify_028` and this suite both leave real rows behind and a reset-then-run
cycle would hide ordering bugs rather than catch them.

### The preflight never checked the preflight

Writing the final numbers surfaced a defect that the suite's own green runs could
not: **114 `PASS` lines were printed but the tally read 111.** Three checks were
printing `PASS`/`FAIL` with bare `console.log`, outside `ok()`, so they never
moved the counters — a check that can report a failure the tally never sees.

Fixing that exposed the real bug underneath. The loop was written as

```js
for (const [name, base] of [['API', API], ['web', WEB], ['onboarding', ONBOARDING]]) {
  const r = await api(base === API ? '/health' : '/', { });
```

but `api()` hardcoded `` fetch(`${API}${p}`) `` and ignored `base` entirely. The
suite was therefore probing the **API three times** and labelling the results
`web` and `onboarding`. The two other services had never been checked at all.
`api()` now takes a `base` override and the loop passes it.

Proven by pointing each base at a dead port:

| Case | Result |
|---|---|
| `ONBOARDING_BASE=http://127.0.0.1:33999` | `FAIL onboarding reachable … -> 0`, **exit 1** |
| `WEB_BASE=http://127.0.0.1:33998` | `FAIL web reachable … -> 0`, **exit 1** |

Before the fix, the first of those printed `PASS onboarding reachable at
http://127.0.0.1:33999` and the suite exited 0 against a port with nothing
listening on it. This is §9's exact failure mode — a green suite that was never
looking at what it claimed to look at — and it survived four earlier green runs
because every run genuinely had all three services up. Nothing about a passing
run can reveal it; only deliberately breaking the precondition can.

### The first run failed three times, and all three were the script's fault

`105 passed, 3 failed` on the first execution. Each failure was a bug in the
harness I had just written, not in the system under test: the KPI denominator
was compared against one invitation instead of the whole inbox; one assertion
referenced a column by a garbled name; and a decline snapshot read a value
captured *before* the decline. Fixed all three, re-ran: `111 passed, 0 failed`.

Recording this because the temptation is to present a green first run. Three of
the four earlier steps in this wave each had a defect that only surfaced under
mutation, and the only reason they were caught is that the suite was written to
be *able* to fail — which had to be demonstrated rather than asserted.

### Mutation proof — the assertions are not decorative

WAVE4_PLAN §9 rule (a) demands assertions that can fail, and rule (e) demands a
non-zero exit. Both were tested by perturbation rather than by inspection:

| Probe | Perturbation | Result |
|---|---|---|
| A | Assert a status no endpoint returns (418 instead of 409) | reported, `exit=1` |
| B1 | Make the append-only "after" snapshot re-read **version 2** instead of V1 | `exit=1`, **3 assertions** failed |
| B2 | Point the cross-tenant read at the caller's **own** invitation | `exit=1`, the 404 fired |
| B3 | Hand the status lookup the **correct** email | `exit=1`, the 404 fired |
| B4 | Put a genuinely allowed token where `admin` was | `exit=1`, the 403 fired |

Each probe rewrites the **data or the token**, never the assertion. Rewriting an
assertion to `ok(true)` would delete the check and prove nothing, and a suite
full of those would exit 0 forever. B1 is the strongest of the five: pointing the
"before" and "after" snapshots at different rows breaks three assertions at
once, so `EVERY other column is byte-identical (price never rewritten)` is
demonstrably a comparison between two live values.

### A stale anchor reads as "the suite is vacuous" for the wrong reason

The mutation harness finds its target by exact string match. Two of the five
anchors were stale, so those probes were **silently skipped** and the harness
printed `SOMETHING IS VACUOUS -- fix before trusting this suite` — a verdict
about the suite that was actually a verdict about the harness. One anchor was
missing a closing quote; the other was missing a character that looked like part
of a template literal but is in fact its terminator.

Fixed with a pre-flight that asserts every anchor resolves **exactly once**
before any probe runs. A skipped probe is now reported as
`anchor ... is gone from the suite`, which is the truth, instead of being
allowed to masquerade as a failing assertion.

### Not done in step 6

Step 7 — the full regression sweep across all four waves, the gap matrix
against the prototype, and the memory close-out.

---

## 20. Step 7 outcome — 2026-09-30 (Wave 4 complete)

No new code except one fix, described below. This step is the close-out: full
regression, a measured gap matrix, and an honest list of what did not land.

### Full regression

| Check | Result |
|---|---|
| `npm test` | **310 pass, 0 fail** (152 engine + 24 roles + 86 api + 48 web) |
| `npm run e2e` | **12 suites, 841 assertions, 0 failed**, exit 0 |
| — the Wave 3 baseline within it | **727** (35+60+41+45+65+62+62+58+116+79+104) — unchanged |
| — Wave 4's addition | **114** (`e2e_wave4`) |
| `npm run db:verify:028` | 14 sections, 16 OK, **0 FAIL**, exit 0 |
| Migrations | 28, proven from empty AND idempotent in step 0 |
| Mojibake (general detector) | clean on every file touched in steps 6-7 |

### The regression caught a real leak in Wave 4

The first full-chain run **failed, exit 1** — `e2e_governance_web.mjs` reported
`99 passed, 5 failed`, with all five failures reading
`<screen>'s compiled page contains no "V-000123"`.

Wave 4's own suites were green. This was Wave 3's guard doing exactly its job,
against Wave 4's code. `supplier.ts` documented *why* the prototype's fake vendor
code was removed — and did so by **quoting the literal in a JSDoc comment**.
`@procurement/workflow-engine` is imported by `apps/web`, so webpack bundles
that comment into the shared chunk every page loads, and a dev build is
unminified, so comments survive. Five governance chunks carried a placeholder
that the port had deliberately eliminated.

The nastiest detail: `supplier.test.ts` asserts
`assert.doesNotMatch(alert, /V-000123/)` and **passed**, because test files are
not bundled. An output assertion proved the rendered string clean while the
shipped chunk was dirty. Both kinds of assertion are needed; neither subsumes
the other.

Fixed by describing the literal rather than quoting it, and by leaving a note in
the file explaining why — a comment that omits the literal reads as less useful,
so the next editor would otherwise helpfully put it back. Swept out of
`supplier.service.ts` too, even though it is server-side and could never have
tripped the guard, to keep the rule uniform. The chunks were re-fetched and
confirmed clean before re-running.

**This is the argument for running the whole chain at least once at the end of a
wave.** Nothing inside Wave 4 could have found it: every Wave 4 suite was green,
the port was correct, and the regression was only visible from outside the wave.

### Gap matrix — measured, not remembered

Built by scanning `PROCUREMENT_PORTAL_PROTOTYPE.html` and the ported files
directly, with comments stripped first:

| Result | Count |
|---|---|
| Prototype elements confirmed present in the port | **37 / 37** |
| Prototype fabrications confirmed absent | **10 / 10** |
| Confirmed gaps (prototype has it, port does not, nothing recorded) | **2** |

**The first version of this matrix reported 14 problems and all 14 were its own
bad needles.** Fabricated literals appeared "leaked" because they sat in the
comments explaining their removal; table headers were matched with a closing
`</th>` that JSX never writes; one row used a placeholder needle that matched
nothing. Written from the plan's *prose description* of a screen rather than from
the screen, it was a hypothesis wearing a tick.

### The two open gaps, both on the supplier inbox

Both are on screen 20 and neither was recorded among the step-4 "deliberately not
ported" list.

1. **The per-RFQ line table.** `renderSupplierInbox` (:9019-9021) renders each
   RFQ's actual line items — `SKU | Description | Qty | UoM`. The port renders
   a `Lines` **count** instead (`SupplierCards.tsx:196-205`). The line items are
   reachable one click away on the quote screen, so nothing is unreachable — but
   the inbox no longer shows what it is asking the supplier to price.

   The likely cause is deliberate and documented, but as an *engineering* note
   rather than a *fidelity* divergence: `supplier.service.ts:123-125` explains
   that the roster, line counts and versions are fetched for **all** invitations
   in three queries, because each `DbService` call spawns a `docker exec` and an
   N+1 would make the inbox N-times slower. The prototype is internally
   inconsistent here — it has inbox framing (plural `Active RFQs`, an empty state
   reading "No active RFQs") wrapped around a single-RFQ body.

2. **The `Issued` date.** The prototype's card meta reads
   `Issued 2026-08-28 · Due 2026-09-05` (:9015). The port shows only `Due`, as a
   table column. **`issuedAt` is already in the inbox payload**
   (`supplier.service.ts:174`) — this is purely a rendering omission, and the
   cheapest of the two to close.

**Recommendation, and why it is not done here.** Restoring fidelity means
deciding how far the inbox goes toward the prototype's single-RFQ card. Both gaps
disappear together if the invitation row is replaced by the prototype's card —
but that reverses a deliberate N+1-avoidance decision and makes a long inbox
visually heavy. That is a design call, not a close-out chore, so it is recorded
here rather than decided unilaterally in the regression step. Fixing only the
`Issued` date would leave the card half-faithful in a way that reads as an
oversight.

### Memory close-out

Four durable lessons written to agent memory from steps 6-7: printed-PASS vs
tally mismatch as a detector; a preflight loop whose helper hardcodes the base;
a stale mutation-harness anchor that silently skips a probe and misreports it as
a suite defect; and the one just found — a "never ship this literal" placeholder
quoted in a comment that ships anyway, caught only by another wave's guard.

### Wave 4 close

Steps 0-7 shipped. Two open gaps stand, both cosmetic-to-moderate on one screen
and both recorded above with a recommendation. Wave 5 (`vendors` ·
`vendor-detail` · `vendor-risk`) is unstarted, and its `vendor-risk` screen is
where the prototype's post-submit jump finally lands.

