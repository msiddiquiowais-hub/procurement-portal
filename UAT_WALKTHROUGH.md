# UAT walkthrough — Waves 1, 2, 3

Manual end-to-end test script. The happy path is PR → CS → MC → CFO → Pack → D365
push → sync → status. Section 7 lists deliberate divergences from the prototype —
check them against section 7, **not** as bugs.

---

## 1. Environment

| Service | URL | Notes |
| --- | --- | --- |
| **Employee portal (web)** | **http://localhost:33002** | main app — this is what you test in |
| API | http://localhost:33001 | no `/` route, 404 is correct |
| Vendor onboarding | http://localhost:33004 | public form, **no login**. Submits a real vendor application and returns a real `ONB-…` reference. See §7. |
| Postgres | localhost:55432 | `procurementDB` |

Start at **http://localhost:33002** and log in.

Every seeded account uses the password **`demo`**.

| Role | Email | Name |
| --- | --- | --- |
| Admin | `admin@pakboxes.pk` | System Admin |
| Requester | `requester@pakboxes.pk` | Aisha Khan |
| HOD | `hod.sales@pakboxes.pk` | Bilal Ahmed |
| Procurement | `procurement@pakboxes.pk` | Hina Tariq |
| Commercial / CS | `cs@pakboxes.pk` | Arsalan Majeed |
| CFO | `cfo@pakboxes.pk` | Yusuf Raza |
| MC chair | `mc.member1@pakboxes.pk` | Dr. Imran Shah |
| MC member 2 | `mc.member2@pakboxes.pk` | Tariq Saleem |
| MC member 3 | `mc.member3@pakboxes.pk` | Naila Aziz |
| MC member 4 | `mc.member4@pakboxes.pk` | Junaid Akhtar |
| MC member 5 | `mc.member5@pakboxes.pk` | Saba Khan |
| Finance | `finance@pakboxes.pk` | Omar Farooq |
| Warehouse | `warehouse@pakboxes.pk` | Faisal Nawaz |
| HR | `hr@pakboxes.pk` | Nida Aslam |
| Cost centre owner | `cost.center@pakboxes.pk` | Mariam Saleem |
| Supplier | `vendor1@example.com`, `vendor2@example.com` | Acme Supplies, BoxCo Packaging |

Baseline before you start: **1 PR, 6 vendors, 6 catalogue items, 18 users.**
Any other PR you see is one you created.

---

## 2. Wave 1 — the purchase request

**As `requester@pakboxes.pk`**

1. `/pr/create` — create a PR. Give it a title you will recognise, e.g.
   `UAT laptops 3x`, expense type **OPEX**, pick a cost centre, add at least one
   line (laptop item × 3) with an estimate, set a required-by date.
2. Attach a **purchase purpose** (e.g. Existing Employee) and tag at least one
   approver. Upload a reference image if you want to see the gallery.
3. Submit. Note the PR number.

**Check**

- Stage badge reads `SUBMITTED`; the stage pill colour matches the prototype.
- The acknowledgement widget shows your purpose label and "N of N pending
  acknowledgement" with an `⏳ Awaiting ack` pill.
- The soft-gate box says **"PR keeps moving"** — it must NOT block you.

**As `hod.sales@pakboxes.pk`**

4. `/approvals` — the PR is in the HOD queue with an `HOD` pill.
5. Open it, approve the line. Stage becomes `IN_PROCUREMENT_REVIEW`.

**Edge case worth testing**

6. Create a second PR with an **IT** line whose **line total exceeds PKR 100,000**.
   It should route to `IN_IT_REVIEW` and bypass procurement review entirely.
7. Open a multi-line PR and reject **one line only** — the rest should proceed.
   This is the line-split behaviour.

---

## 3. Wave 2 — sourcing and the comparative statement

**As `procurement@pakboxes.pk`**

8. Open the approved PR → create the **RFQ**. Check the invited vendor list
   (expect 3 vendors on the standard route).
9. `/rfq` → open the RFQ. Enter **three competing quotations**, one per vendor,
   each with a different unit price, lead time and warranty. Prices must differ —
   the CS ranking depends on it.
10. Generate the **Comparative Statement** (`/cs/<prId>`).

**Check**

- CS table ranks the three quotes and scores the lines.
- The winner is the one you expect from the numbers you entered.
- Quote status pills read from the DB vocabulary: `Submitted` / `Superseded` /
  `Withdrawn` / `Awarded` / `Rejected`.

**As `cs@pakboxes.pk`**

11. Open `/cs/<prId>`, confirm the winner, then **lock** the pack (CS lock).
12. **Check the PR stage moved to `CS_LOCKED`.** (A `STANDARD` PR goes
    `CS_LOCKED`; a `FAST_TRACK` one goes straight to `PACK_LOCKED`.)

---

## 4. Wave 3 — governance

**As the five MC members** (log out / log in between each, or open five browsers)

13. `/mc/<prId>` as `mc.member1` → **Approve**. Watch the chip go to `1/5`.
14. Repeat for members 2–5. The chip reads `5/5` and the round resolves.
    - The **MC Vote** item appears in the sidebar only for `mc` and `admin` roles.
    - The MC screen is *not* reachable in the nav for a `cfo` login.
15. The PR stage becomes `MC_APPROVED`. Alert reads "MC approved 5/5. Switch to
    CFO role for final sign-off."

**As `cfo@pakboxes.pk`**

16. `/cfo/<prId>` — review the **Pack summary** (7 rows). Approve.
17. Stage becomes `CFO_APPROVED`.

**As `cs@pakboxes.pk`**

18. `/pack/<prId>` → **Lock approved pack**. Six documents, each with a real
    SHA-256. Stage becomes `PACK_LOCKED`.
19. `/d365/push/<prId>` → **Push to D365 F&O**. A real PO number is returned.
20. `/d365/status/<prId>` — six-row event stream. Row 1 turns green.
21. **Sync** → row 2 turns green. Sync again → row 3. **One sync = one step.**

---

## 5. Reject paths (test these on a *second* PR)

| Path | Expected behaviour |
| --- | --- |
| HOD rejects | PR returns to the requester / draft |
| MC member rejects | PR goes back to `QUOTES_RECEIVED`; quotations return to `Submitted`; the RFQ reopens; **CS round 2** opens and **round 1 is preserved** |
| CFO rejects | PR returns to `CS_LOCKED` and the MC vote ledger is cleared so the committee can vote again — it does **not** go back to sourcing |
| Pack lock retried | Idempotent — no second pack, no error |
| D365 push retried | Idempotent — same PO number, no duplicate push |

The two rejects go in **opposite** directions on purpose: MC reject → sourcing,
CFO reject → the MC gate.

---

## 6. Fidelity spot-checks

- Titles, subtitles, card order and button labels match the prototype.
- The pack hash column shows **8 hex characters + `…`** (not a full hash).
- The D365 PO number is **generated** — it must not read `PO-2026-00781`.
- Nothing renders a fabricated value. Unknown → `—`.
- No page shows a raw hash, a random hash, or a hardcoded vendor code like
  `V-000123`.

---

## 7. Deliberate divergences — do NOT report these as bugs

1. **Nav links for the five governance screens** (MC Vote, CFO Approval, Approved
   Pack, Push to D365, D365 Status) all point at `/approvals`. They act on one PR
   while the app has many, so the nav entry lands on the queue where a role sees
   what is waiting. The per-PR screens are `/mc/<id>`, `/cfo/<id>`, `/pack/<id>`,
   `/d365/push/<id>`, `/d365/status/<id>`, and each page links to the next. This
   is the same pattern `PR Review` and `RFQ & Quotes` already use.
2. **"You are voting as …"** shows *your* logged-in name, not a hardcoded
   "Dr. Imran Shah". The vote is recorded against a real voter.
3. **The MC panel is data**, read from `workflow.mc_panel` — five members,
   Dr. Imran Shah as chair, which are the prototype's names, but the quorum is
   `count(*)` of actual appointments rather than a literal 5.
4. **No timers anywhere.** D365 status advances only when a sync is observed.
   Leave the screen open and nothing moves — that is correct.
5. **Pack documents have three states**: `present` (real hash), `skipped`
   (reads "Skipped (FAST_TRACK)" — the gate never ran) and `missing` (reads
   "No digest recorded"). A skipped or missing document shows `—`, never a hash.
6. **Risk class** is derived, not hardcoded. The prototype always shows "Medium";
   ours shows `—` when it cannot be derived.
7. **Acknowledgement is a soft gate.** Tagged approvers get an email deep link;
   the PR does not wait for them. Board approval is likewise a message, not a gate.
8. **Quote vocabulary** in the UI maps `ACTIVE → Submitted` and `VOID →
   Withdrawn`; the database keeps its own five values.
9. **The CS screen is at `/cs/<prId>`** (the prototype has one global state).
10. **The supplier screens are inside the web app, at `/supplier`** — there is no
    longer a separate supplier app on port 33003. Sign in as `vendor1@example.com`
    and the sidebar shows **Supplier Inbox** and **Submit Quote** under Library.
11. **No sealed bids.** The prototype says a quote "is sealed until the buyer
    closes the RFQ" and shows a "Closing in 7 days" countdown. Neither is true
    and neither is ported. The screens say *"Your quote is visible to the buyer
    as soon as you submit it. You may revise it until the RFQ is closed."* and
    show a real **Due &lt;date&gt;**. Leave the page open — nothing counts down.
    That is correct.
12. **Unit-price boxes start EMPTY** and the line total and **Quote total** both
    read `—` until you type a price. The prototype pre-fills
    `Math.round(estimated ÷ totalQty)` into every box, which is a guess dressed as
    a price. Partially price a form and the total stays `—`: there is no partial
    sum. Price every line and the total appears.
13. **A supplier can only see their own RFQs.** The sidebar entry is a
    convenience; `SupplierGuard` is the boundary, and it refuses any session
    without a vendor record.
14. **The public onboarding form starts empty.** The prototype ships with
    "PakBoxes Pvt Ltd" and tax id "1234567-8" already typed in; on a real public
    form every applicant would submit the same company. The fields are blank.
15. **The onboarding reference is real and sequential** (`ONB-2026-00001`), not
    the prototype's `Math.random()` number. It is worth keeping: it is the only
    way to check on an application.
16. **The onboarding status lookup asks for your email.** The reference is
    sequential, so on its own it is guessable and `ONB-2026-00001…N` would be a
    public directory of every applicant. A wrong email gets a plain "no
    application matches" — it does not confirm the reference exists.
17. **A second application for a live NTN is refused** ("already under review").
    If one was rejected, the same company may apply again.

---

## 8. If something breaks

- API log: `apps/api/.dev.log` (or whatever `.restart-api-v2.ps1` writes).
- Web logs: `apps/web/.dev.log`,
  `apps/onboarding/.dev.log`.
- Restart the front-ends: `powershell -NoProfile -ExecutionPolicy Bypass -File .launch-next-v2.ps1`
- Restart the API: `powershell -NoProfile -ExecutionPolicy Bypass -File .restart-api-v2.ps1`
- **Do not run `npm run build -w apps/web` while the dev server is running** — it
  overwrites `.next/` and takes the web app down with HTTP 500 until relaunched.
- Reset to a clean baseline:
  `powershell -NoProfile -ExecutionPolicy Bypass -File db\scripts\reset.ps1`
  (destructive — wipes everything you have entered).

---

## 9. Regression safety net

If you change nothing and just want the automated proof that the three waves are
still green:

```
npm test                      # 310 unit tests (engine 152, roles 24, api 86, web render 48)
npm run db:verify:027         # 13 sections, governance transition rules
npm run db:verify:028         # 14 sections, supplier identity + vendor applications
npm run e2e                   # 11 suites, 727 assertions
npm run e2e:render_contract   # 30 assertions, live API payload through the real components
node scripts/check_onboarding_page.mjs   # 31 assertions, the public form over HTTP
```

The two Wave 4 scripts create real RFQs, quotations and vendor applications, so
**reset first** or they will trip over your own data:
`powershell -NoProfile -ExecutionPolicy Bypass -File db\scripts\reset.ps1`

Note: `npm run e2e` writes test data into the same database, so run it **after**
your manual UAT, not before.
