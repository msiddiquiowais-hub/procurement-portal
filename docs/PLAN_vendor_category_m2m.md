# Feasibility & Plan — Many-to-Many Vendor ↔ Category Association

**Reviewed 2026-10-06 · No code written · Status: needs one decision before implementation**

---

## 1. Verdict

**Feasible, but not as specified.** Roughly 40% of the requested work already exists in a
different shape (a `text[]` column plus a governed write path and a hash-chained audit log),
and the single blocking question is not in the prompt at all: **which "categories" table does
`vendor_categories.category_id` point at?**

The system currently holds **three candidate vocabularies and two validators that contradict
each other.** Building the junction table before settling this would bake the contradiction into
the schema, where it is much harder to undo.

---

## 2. The blocker

| Where | Validates a vendor category against | Accepts |
|---|---|---|
| `db/migrations/037_vendor_detail_columns.sql` (data post-condition, line ~276) | `core.dimension_values` where `dimension_key='ItemGroup'` | `IG-OFC`, `IG-LAPTOP`, … |
| `apps/api/src/onboarding/onboarding.service.ts:226` `normaliseCategory()` (runtime) | `LIGHT_ITEM_CATEGORY_IDS` — the **line** categories | `IT_HARDWARE`, `OFFICE_SUPPLIES`, … |
| Seeded data — all 6 demo vendors | — | `IG-*` |

**Live proof against the running API:**

```
POST /onboarding/applications  categories="IG-OFC"
  → 400 "IG-OFC" is not a known category.
     Allowed: IT_HARDWARE, IT_SOFTWARE, OFFICE_SUPPLIES, WAREHOUSE_ACCESSORY, …

POST /onboarding/applications  categories="OFFICE_SUPPLIES"
  → 201 ACCEPTED
```

So today: a real applicant can only pick values that **migration 037 forbids**, and can never
pick the values the **seed actually uses**. The write path and the seeded estate disagree.

`OFFICE_SUPPLIES` also fails `prove_w5j_categories.mjs`'s check *"vendor categories were NOT
rewritten to line-category names"*, and would fail migration 037's post-condition on replay.

**This is not caused by the requested work — it is pre-existing.** But it decides what
`category_id` means, so it has to be answered first.

---

## 3. Requirement-by-requirement: what already exists

| # | Requirement | Status | Notes |
|---|---|---|---|
| 1 | `vendor_categories` junction table | **Absent** | Today: `core.vendors.preferred_categories text[]` + GIN index `idx_vendors_preferred_categories`. Serves M:N today; has **no per-link `is_active`, no `updated_by`.** |
| 2a | Endpoint: categories for a vendor | **Partial** | No `GET /vendors/:id/categories`. `GET /vendors/:id` returns the raw array via `to_jsonb(...)`. |
| 2b | Endpoint: vendors for a category | **Absent** | No reverse read exists anywhere. |
| 2c | Endpoint: enable/disable a mapping | **Absent** | — |
| 2d | Bulk assign categories/vendors | **Partial** | `POST /vendors/:id/categories` replaces the whole set. No incremental add/remove, no bulk across vendors. |
| 3a | Audit trail | **Already satisfied, and stronger** | `audit.audit_log`: `before`/`after` jsonb, `actor_user_id`, `reason`, `correlation_id`, **plus a `hash_chain_prev`/`hash_chain_self` tamper-evident chain** (migration 039, append-only). 14 `category_change` rows already recorded. |
| 3b | `updated_at` / `updated_by` columns | **Recommend NOT adding** | Would duplicate the audit log. Keep one source of truth for "who changed this and when". |
| 3c | Role gate + reason on change | **Already exists** | `setCategories` → `assertCanGovern(role)` + mandatory reason + min 1 / **max 12** categories. |
| 3d | Vendor list badges/tags | **Data ready, not rendered** | `vendors.service.ts` already returns `category: string[]` and `categorised: boolean` per row; `vendors.tsx` types them but renders nothing. |
| 3e | Two-way "Manage Vendors" on the category screen | **Absent** | `/admin-categories` exists and is the natural host. |
| 4 | CSV import for mappings | **Pattern exists, not for this entity** | `import_categories.mjs` + `POST /admin/categories/import` — atomic whole-file validation, `--dry-run`, RFC 4180 parser. Directly reusable. |

---

## 4. Risks that will bite

### R1 — `is_active` breaks the RFQ eligibility gate *(highest)*
`sourcing/rfq.service.ts:1121` uses **`cardinality(preferred_categories) > 0`** as rule-4
eligibility, and `vendors.service.ts:277` raises an *"uncategorised → excluded from automatic
RFQs"* alert. With a junction table, a vendor whose only link is **inactive** would still test
`cardinality > 0` as true and keep entering the automatic pool with no usable category.

**Fix:** the gate must become `EXISTS (SELECT 1 … WHERE is_active)` — not an emptiness test on
an array. Same for the uncategorised alert. This is a correctness change, not cosmetic.

### R2 — "Preserve historical links for old PRs/POs"
Nothing currently snapshots a vendor category onto a PR. `proc.pr_lines.category` is the **line**
category; the PR→vendor link is `proc.purchase_orders.vendor_id` / `proc.quotations.vendor_id`,
and a vendor id never changes.

**So historical preservation is already true** — deactivating a link changes future eligibility
only, not what any past PR meant. Worth confirming that is the intent, because it removes a
large amount of otherwise-expected work.

### R3 — D365 sync churn
`vendor-sync.service.ts:349` sends categories as a delimited note (F&O has no category array),
and `core.fn_vendor_d365_sync_hash` (migration 045) hashes the array. Deactivating a link changes
that hash → **triggers a vendor re-push to D365**. Decide whether inactive links sync, and if not,
exclude them from the hash as well as the payload — otherwise every toggle becomes a sync event.

### R4 — the 12-category cap
`setCategories` caps at 12. The prompt says "10+", so a searchable combobox is justified — but
the cap must be kept deliberately, not dropped by accident while rebuilding the write path.

### R5 — the baseline is not clean
`core.categories` currently holds **`OTHERS`** ("Mix Category", created 2026-10-05 09:16 through
the new admin screen). It is not in the engine vocabulary, so it is **unroutable**, and
`npm run verify:categories` currently **fails**:

```
verify_categories: 1 active category/ies in core.categories are not in LIGHT_ITEM_CATEGORY_IDS.
They would appear in the picker and match no routing rule.
```

This is the screen working as designed — but plan against a clean baseline, or fix it first.

---

## 5. The decision that unblocks everything

**What should `vendor_categories.category_id` reference?**

| Option | Preserves | Costs / breaks |
|---|---|---|
| **A. `core.categories`** (line categories) | The admin screen built yesterday becomes the picker for free; onboarding's behaviour becomes canonical | Must migrate all 6 seeded vendors `IG-*` → line names; **breaks migration 037's post-condition and `prove_w5j` check**; D365 payload semantics change from ItemGroup to line category |
| **B. `core.dimension_values` (ItemGroup)** | Migration 037, the seed, and the D365 payload all stay as they are | `onboarding` must be **fixed** (it currently refuses `IG-*`); `/admin-categories` is the wrong picker; needs its own admin surface |
| **C. New `vendor_category_codes` table** | Full isolation; nothing existing is disturbed | A **third** vocabulary; deliberately duplicates data already validated by migration 037 |

**My recommendation: Option B.** It is the only one that leaves the two existing contracts
intact and fixes the actual contradiction (`onboarding` is wrong, not migration 037). Option A
is defensible only if "vendor category" is genuinely meant to be the same thing as "line
category" — which, given they are named differently and feed different rules, it is not.

Whichever is chosen, the `onboarding` validator must be corrected to match. That fix is
worth doing **on its own** regardless of this task.

---

## 6. Phased plan

**Phase 0 — Unblock (decision + small fix).** Settle Option A/B/C. Correct
`onboarding.normaliseCategory()` to validate against the chosen vocabulary. Clean `OTHERS`.
*Exit:* one validator, zero contradictions, `verify:categories` green.

**Phase 1 — Schema (additive, migration 048).** `core.vendor_categories`
(`vendor_id` FK, `category_id` FK, `is_active` bool default true, `created_at`/`created_by`,
PK `(vendor_id, category_id)`, GIN + partial index `WHERE is_active`).
**Backfill** from `preferred_categories` so the array and the table agree, then leave the array
in place as the read cache. **Do not drop it in this phase** — R1/R3 consumers still read it.
*Exit:* table matches the array; `verify` script proves row-for-row equality.

**Phase 2 — Reads.** `GET /vendors/:id/categories` (active + inactive, with actor/timestamp),
`GET /categories/:code/vendors`. Both report `activeCount`/`inactiveCount` so the UI can show
"3 active, 1 inactive" rather than hiding history.
*Exit:* two-way reads proven against a seeded mapping.

**Phase 3 — Writes + status.** Incremental `POST`/`DELETE` link endpoints and a
`PATCH …/is_active` toggle, each routed through the **existing** `assertCanGovern` +
`assertReason` + append-to-audit-then-update pattern (`vendorChangeToken`). Audit actions:
`vendor_category_link`, `vendor_category_unlink`, `vendor_category_status`.
*Exit:* every change has a before/after audit row in the hash chain.

**Phase 4 — Fix the gate (R1).** Rewrite the RFQ pool query and the uncategorised alert to use
`EXISTS (… WHERE is_active)`. **Must land with Phase 3, not after it** — until it does, Phase 3
ships a latent bug where a fully-deactivated vendor still gets auto-invited.
*Exit:* deactivate a vendor's last link → it leaves the pool and raises the alert.

**Phase 5 — UI.** (a) Vendor edit: searchable multi-select combobox over the 12-category cap,
with active/inactive toggles inline. (b) Vendor Master list: category badges in the existing row
shape. (c) `/admin-categories`: **Manage Vendors** modal, the true two-way view.
*Exit:* edit one link on either side and watch the other side update.

**Phase 6 — CSV import.** Extend the existing pattern to `vendor_code,category_code,is_active`.
Row-by-row validation with line numbers, whole-file atomicity unless `--skip-invalid`,
`--dry-run` that reports create/link/skip/unmatched counts, and a post-run report of mappings
that imported but could not be matched to a real vendor.
*Exit:* a bad row 40 writes nothing, as already proven for categories.

**Phase 7 — Verification.** New prove script covering both directions, the status toggle, the
RFQ gate, the audit chain, and the import. Re-run `npm test` (320), `prove_wave5e` (67),
`prove_wave5g` (54), `prove_w5j` (27), `verify:categories`.

---

## 7. What I need from you

1. **Option A, B, or C** from §5. This blocks everything else.
2. **R2 confirmation:** is "preserve historical links" about *future eligibility only*? My
   reading is that past PRs/POs are already unaffected, which removes real scope.
3. **R3:** should inactive links be excluded from the D365 payload and its sync hash?
4. **The 12-category cap** — keep as-is, or raise it now that a real picker exists?

## 8. Effort

Phases 1–7 are **one focused piece of work, not a rewrite** — the audit path, role gates, CSV
import pattern, and admin screen all exist to build on. The honest cost is concentrated in
Phase 4 (the RFQ gate), which is a correctness fix to existing sourcing behaviour and deserves
its own testing.

---

*Related, already shipped: the category admin screen (`/admin-categories`), the
`core.categories` table and its FK on `proc.pr_lines.category`, and
`scripts/verify_categories.sql`. The "selectable is not routable" distinction in that screen
applies here too — a vendor-category mapping makes a vendor *eligible* for an RFQ; it does not
decide which rule that RFQ follows.*