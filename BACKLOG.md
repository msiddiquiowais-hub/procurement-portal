# Backlog — known issues

Open items that are **deliberately not fixed**, with enough evidence for whoever
picks them up to start without re-deriving the diagnosis.

---

## B‑1 · `db:reset` cannot rebuild an empty database

**Status:** Partly resolved (2026‑10‑23). The **production deploy path** is fixed
and verified. The **dev reset path** still needs a decision on ordering — see
"What is still open" below.
**Severity:** Blocks the dev reset path; does not affect the running database.
**Component:** `db/scripts/reset.ps1`, migrations 036/039/043/053 (+ 045/050)

### Summary

`db/scripts/reset.ps1` runs **migrate, then seed** (lines 121 and 124), and
aborts if migrate returns non‑zero. Several migrations carry post‑conditions
that assert against **seeded** data, so on a freshly created, empty database
those assertions fail, migrate exits 1, and the reset never reaches the seed.

The running `procurementDB` is unaffected — it was built incrementally, so every
migration has long since passed its data-dependent probe against real rows. This
is only reachable by destroying and recreating the database.

### Scope correction (2026‑10‑23)

This entry was written against `db:reset` and assumed the production path was
unaffected. It was not. `deploy/migrate.sh` runs the chain in **bootstrap mode**
on a brand-new database — best‑effort, then seed, then strict — and its strict
phase re‑runs anything that failed before the seed. Six migrations survived
that, but two did not, because their subject set is empty **even after seeding**:

```
057_sourcing_status_clock.sql
    ERROR: migration 057: hod_approved_at backfill matched 0 rows — the alarm would never fire
058_hod_anchor_remediation.sql
    ERROR: migration 058: hod_approved_at anchored 0 PR(s), which does not improve on the 213 the single-pattern backfill produced
```

The seed creates no HOD approval history, so no request is ever eligible to be
anchored and the backfill correctly anchors none — but neither migration could
tell "the invariant is broken" from "there is nothing to anchor". **The first
deploy of the new code to a fresh VPS would have aborted at 057**, in strict
phase, with the old stack left running.

The same defect turned up in five more files as the chain was applied end to
end, each asserting the shape of one database rather than the invariant it was
meant to protect:

| File | What it asserted | Why it aborted |
|---|---|---|
| 035 | exactly 2 steps on the global threshold predicates | `072` legitimately gave `mc_approval` its own threshold predicate; `035` then put `finance_release` back onto one, so the count reached 3 |
| 057 | the backfill anchored something | nothing was ever HOD-approved, so nothing was eligible |
| 058 | the backfill beat a remembered count (213) | 213 was taken from one estate; a different estate has a different count |
| 062 | a snapshot is still fully keyed | the snapshot table is empty on a fresh database |
| 065 | a step count, and a routing that `070`/`075` later change | also asserted against a value its own `INSERT` had just written |
| 068 | no step past cost approval carries the class flag | `075` retires the cost-approval stage, after which that stage is where the class is first demanded |
| 071 | a gated route into cost approval, read as a global set | the empty set read as a failure; and `075` retires the stage it named |
| 072 | the gate predicate under its old name | `075` renames it |
| 073 | a probe request built from an existing request | a fresh database has none, so the probe never existed to prove anything |

### What was changed

Each of those post-conditions now states the invariant instead of the estate:

- 057 asserts that **every eligible** request was anchored. Strictly stronger
  than the count‑of‑zero it replaced: it fails when even one eligible request
  was missed.
- 058 computes its baseline instead of remembering one, so a silent no‑op still
  trips it.
- 035 is scoped to the pair it owns (`finance_review` / `finance_release`),
  which is what its own sibling assertion already did.
- 062, 065, 068, 071 and 072 assert only the properties no other migration in
  the chain changes.
- 073 takes its foreign keys from the reference tables.

**No gate was weakened.** Every one of them still fails loudly when its
invariant is genuinely broken on a populated database, which is the acceptance
criterion set out below.

### Verified

- `deploy/migrate.sh` in bootstrap mode applies **all 78 migrations** to a
  brand-new database, exit 0.
- A full replay of all 78 against a clone of the working database (2 125
  requests, 1 136 anchored) applies all 78, exit 0.

### What is still open

`db/scripts/reset.ps1` still runs migrate‑then‑seed, and a replay against a
truly empty database still fails at:

```
036_vendor_risk_and_attachment_ceiling.sql
    ERROR: migration 036: no seeded vendor lands in the High band — blocked-from-RFQ would never fire
```

with 039/043/045/050/053 behind it. Those six are **not** defects and were
deliberately left alone: their subject sets are vendor rows and audit rows
that only the seed creates, so on an empty database they have nothing to
assert against. The deploy runner already solves this with its bootstrap mode;
`reset.ps1` has no equivalent.

The remaining choice is therefore option 3 from the original list, narrowed:

- **Give `reset.ps1` a bootstrap mode** like `deploy/migrate.sh` has — best
  effort, seed, then strict. This is the same shape the deploy runner already
  uses and is known to work against these six.
- Or **reorder `reset.ps1` to seed before migrating**, which is cheaper but
  assumes the seed does not depend on schema later migrations create.

The first is the better fit: it is the arrangement that is already in
production.

### Acceptance criteria (for the part that is still open)

- `reset.ps1` completes on an empty database and reports its post-condition
  (`1` PR, `6` vendors per lines 135–137).
- Every one of the six post-conditions still **fails loudly** when its invariant
  is genuinely violated on a *populated* database. A fix that weakens them
  without this property is not acceptable.
- A regression test exercises the empty-database path so this cannot silently
  reappear.

### Do not "fix" this by weakening a gate

Each of these assertions is a control. Removing one to make a script green
silently narrows what the system proves about itself. If a post-condition looks
unreasonable, raise it — do not delete it.

The data-aware form is the shape to prefer over the counted form: "every
eligible row was affected" survives an empty estate and still fails on a
populated one, where "the count is what it was when this file was written" does
neither.

### Already fixed, for context

Migration **039** had a related fresh-database defect which *was* fixed: it called
`audit.fn_widen_audit_log_actions()` before any migration had created that
function (007 writes the CHECK inline; the function first appears in 041, which
sorts *after* 039). Migration **038b** section B1 now creates it. The remaining
failure above is 039's *data-dependent* post-condition, which is a separate
concern and is the one logged here.
