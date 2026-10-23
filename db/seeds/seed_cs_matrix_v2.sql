-- ═══════════════════════════════════════════════════════════════════════════════
-- Phase 0 seed — a Comparative Statement test case that can actually PROVE the
-- Matrix Form works.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- STATUS: DRAFT FOR REVIEW. NOT EXECUTED.
--
-- WHY THIS FILE EXISTS
-- --------------------
-- The matrix is a 6-lines x N-vendors grid, and four of its six requirements
-- (No Quote cells, per-line L1, split awards, column hide/drag) are invisible on
-- the current estate. Measured across every RFQ in the database:
--
--     status                    rfqs  max lines  max bidders  with quote gaps
--     IN_PROCUREMENT_REVIEW       161         4            4                 0
--     QUOTES_RECEIVED              48         2            4                 0
--     PACK_LOCKED                 141         2            1                 0
--
-- `with quote gaps = 0` everywhere: not one RFQ has a vendor who failed to quote
-- a line. And the PR previously nominated for the demo, PR-2026-201645, is a
-- single line against two bidders — one row, one column. It cannot exercise
-- points 2, 3 or 6 at all.
--
-- Shipping the matrix against that data would mean shipping it UNVERIFIED,
-- which is how the round-selection defect survived review in the first place.
--
-- ---------------------------------------------------------------------------
-- THE FIXTURE
-- ---------------------------------------------------------------------------
--   PR        PR-2026-UAT-CS-MTX    6 lines, OPEX, STANDARD, QUOTES_RECEIVED
--   RFQ       RFQ-2026-UAT-MTX     state 'Open'  (see note below)
--   vendors   4 of the 6 Active vendors already on file
--   quotes    20 of a possible 24 cells  ->  4 DELIBERATE GAPS
--
-- Vendors (all pre-existing, none invented):
--   V-00087 Northbridge Technologies   lead 10d   the balanced bidder, quotes all 6
--   V-00081 Acme Supplies (Pvt) Ltd    lead 14d   cheap on 2 lines, skips L6
--   V-00084 KarachiTech Supplies       lead  7d   fastest, skips L4
--   V-00088 Punjab IT Systems          lead 21d   CHEAPEST BASKET, quotes only 4
--
-- Why this shape is the right test:
--
--   • Every line has a DIFFERENT cheapest vendor, so the green L1 highlight
--     moves around the grid and a hardcoded "winner" cannot pass.
--   • Punjab IT has the lowest basket (449,200) yet skips 2 lines. A footer
--     that compares "Total Quoted Basket" against "Selected Split Award Total"
--     therefore shows basket-total ordering being WRONG — which is the whole
--     argument for line-item award, demonstrated by data rather than by copy.
--   • 4 No Quote cells sit in 4 different vendor columns and 4 different rows,
--     so column hide / drag / seq-sort each get exercised by a distinct gap.
--
-- On the HTML fixture: it ships 5 vendors, 3 of which (V-00104, V-00119,
-- V-00142) do not exist on this estate — only 6 vendors are Active in total.
-- This fixture uses 4 real ones. Also note the HTML's own demo data contains
-- NO override: every line's `selectedVendor` is already its lowest price, so
-- the mandatory-override modal — the most important part of requirement 4 —
-- can never open. That is fixed here by leaving all awards unselected so the
-- choice (and any override) happens live at review time.
--
-- ---------------------------------------------------------------------------
-- RFQ LEFT 'Open' ON PURPOSE
-- ---------------------------------------------------------------------------
-- Once Phase 2 lands, an Open RFQ blocks CS generation by design. Leaving it
-- Open means the close gate has something real to gate the moment it ships, and
-- the CS can be generated today because that gate does not exist yet. Close the
-- RFQ before generating the CS after Phase 2.
--
-- ---------------------------------------------------------------------------
-- SAFETY
-- ---------------------------------------------------------------------------
-- Every object uses a fixed synthetic UUID in the 0c5e0000-… namespace, which
-- cannot collide with gen_random_uuid() output. A SECOND run raises and aborts
-- rather than duplicating: a silently half-applied fixture is far harder to
-- diagnose than a loud failure. (A bare `RETURN` here would NOT stop the script —
-- the statements below it would still run.)
-- Nothing outside the 0c5e… namespace is read or written — existing PRs, vendors
-- and RFQs are untouched.
--
-- Requires migration 063 (adds proc.cs_item_decisions) so the verification
-- SELECT at the end can query it.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM proc.purchase_requisitions WHERE pr_number = 'PR-2026-UAT-CS-MTX') THEN
    RAISE EXCEPTION
      'seed_cs_matrix_v2 already applied (PR-2026-UAT-CS-MTX exists). Refusing to run twice — delete the fixture first if you need to rebuild it.';
  END IF;
END $$;

-- ─── 1. Purchase requisition ────────────────────────────────────────────────
-- status QUOTES_RECEIVED is the stage at which a CS becomes generatable.
-- amount_status ESTIMATED (the alternative, UNKNOWN, would force estimated_amount
-- to 0 via prs_amount_status_coherent). warehouse_check_required false, so no
-- warehouse gate on this PR.

INSERT INTO proc.purchase_requisitions
  (id, pr_number, title, description, purpose,
   requester_user_id, department_id, cost_center_id,
   expense_type, required_by_date, status, routing_key,
   estimated_amount, capex_amount, opex_amount, currency,
   scope, stage_remarks,
   warehouse_check_required, urgency, amount_status,
   attachments, version, workflow_snapshot, created_at, last_updated_at)
VALUES
  ('0c5e0000-0000-4000-8000-000000000001',
   'PR-2026-UAT-CS-MTX',
   'UAT fixture — line-item comparative matrix',
   'Six industrial/IT lines seeded to exercise the Matrix Form: mixed quotations, per-line L1, split awards, column hide/drag, seq sort.',
   'Phase 0 test data for CS Matrix Form verification. Not a real requisition.',
   -- requester@, NOT procurement@: the procurement account carries no
   -- department_id, and this column is NOT NULL. Verified against core.users.
   (SELECT id           FROM core.users      WHERE email = 'requester@pakboxes.pk'),
   (SELECT department_id FROM core.users      WHERE email = 'requester@pakboxes.pk'),
   '11111111-1111-1111-1111-111111111112'::uuid,   -- Lahore IT
   'OPEX', CURRENT_DATE + 30, 'QUOTES_RECEIVED', 'STANDARD',
   690000, 0, 690000, 'PKR',
   'UAT fixture — line-item comparative matrix', '{}'::jsonb,
   false, 'routine', 'ESTIMATED',
   ARRAY[]::uuid[], 1, '{}'::jsonb, now() - interval '9 days', now());

-- ─── 2. Line items ──────────────────────────────────────────────────────────
-- classification OPEX_CONSUMABLE on every line (pr_lines_classification_check).
-- fulfilment_source PURCHASE, which per pr_lines_store_qty_consistent requires
-- store_fulfilled_qty to stay NULL. approved true / rejected false / held false
-- per pr_lines_disposition_check. unit_price_est is the buyer's own estimate and
-- is deliberately NOT the same number any vendor quoted — it is what makes the
-- saving visible later.
--
-- `category` is deliberately LEFT OUT. pr_lines.category resolves against the
-- category catalogue, so a free-text guess ('Machinery', 'Hydraulics') would
-- either violate a foreign key or force rows to be invented. The matrix does
-- not read it. Inventing a category to satisfy a nullable column is exactly the
-- kind of filler that outlives the test that needed it.

INSERT INTO proc.pr_lines
  (id, pr_id, line_no, description, quantity, uom, unit_price_est, gl_account,
   classification, approved, rejected, held, fulfilment_source)
VALUES
  ('0c5e1000-0000-4000-8000-000000000001', '0c5e0000-0000-4000-8000-000000000001', 1,
   'Industrial Servo Motor 5kW',          4,  'EA',   27000, '6100-01', 'OPEX_CONSUMABLE', true, false, false, 'PURCHASE'),
  ('0c5e1000-0000-4000-8000-000000000002', '0c5e0000-0000-4000-8000-000000000001', 2,
   'PLC Control Module S7-1500',          2,  'EA',   88000, '6100-02', 'OPEX_CONSUMABLE', true, false, false, 'PURCHASE'),
  ('0c5e1000-0000-4000-8000-000000000003', '0c5e0000-0000-4000-8000-000000000001', 3,
   'Heavy Duty Conveyor Belt 50m',       1,  'M',  155000,'6100-03', 'OPEX_CONSUMABLE', true, false, false, 'PURCHASE'),
  ('0c5e1000-0000-4000-8000-000000000004', '0c5e0000-0000-4000-8000-000000000001', 4,
   'Hydraulic Pressure Sensor Bar-250',  10, 'EA',    6500, '6100-04', 'OPEX_CONSUMABLE', true, false, false, 'PURCHASE'),
  ('0c5e1000-0000-4000-8000-000000000005', '0c5e0000-0000-4000-8000-000000000001', 5,
   'Stainless Steel Valve Assembly 3"',  6,  'EA',   15000, '6100-05', 'OPEX_CONSUMABLE', true, false, false, 'PURCHASE'),
  ('0c5e1000-0000-4000-8000-000000000006', '0c5e0000-0000-4000-8000-000000000001', 6,
   'VFD Inverter Drive 15kW',            3,  'EA',   46000, '6100-06', 'OPEX_CONSUMABLE', true, false, false, 'PURCHASE');

-- ─── 3. RFQ ─────────────────────────────────────────────────────────────────
-- deadline 7 days after issue, satisfying rfq_check (deadline_at >= created_at
-- + 24h). reissue_count 0 with last_reissued_at NULL per rfq_reissue_stamp_consistent.
-- state 'Open' on purpose — see the header note.

INSERT INTO proc.rfq
  (id, rfq_number, pr_id, created_by_user_id, deadline_at, state,
   single_source, currency, incoterm, created_at, issued_at,
   reissue_count, last_reissued_at,
   title, initial_deadline_at)
VALUES
  ('0c5e2000-0000-4000-8000-000000000001', 'RFQ-2026-UAT-MTX',
   '0c5e0000-0000-4000-8000-000000000001',
   (SELECT id FROM core.users WHERE email = 'procurement@pakboxes.pk'),
   now() - interval '2 days', 'Open',
   false, 'PKR', 'EXW', now() - interval '9 days', now() - interval '9 days',
   0, NULL,
   'UAT fixture — line-item comparative matrix', now() - interval '2 days');

-- Snapshot of the PR lines onto the RFQ, exactly as RfqService.snapshotRfqLines
-- would have produced it at issue time. rfq_lines.pr_line_id is what lets the
-- matrix tie a quotation cell back to the buyer's own line.

-- `rfq_lines` has NO id column — it is keyed on (rfq_id, line_no).
INSERT INTO proc.rfq_lines (rfq_id, pr_line_id, line_no, description, quantity, uom)
SELECT
  '0c5e2000-0000-4000-8000-000000000001'::uuid,
  id, line_no, description, quantity, uom
FROM proc.pr_lines
WHERE pr_id = '0c5e0000-0000-4000-8000-000000000001'
ORDER BY line_no;

-- ─── 4. Invitations ─────────────────────────────────────────────────────────
-- `submitted` is what the RFQ screen's "x of y quotes received" counter reads.
-- All four are marked submitted=true because all four HAVE returned a quote; a
-- quote that exists for a line is not the same thing as a quote for every line.
-- The gaps live in quotation_lines, not here — that is the whole point.

-- `rfq_invitations_never_expires` is MISNAMED: the CHECK is
-- (expires_at IS NOT NULL) — an invitation MUST carry an expiry, not never
-- expire. rfq_invitations_expiry_after_invite additionally requires
-- expires_at > invited_at. Verified against the live definition; the name
-- alone would have led to the opposite conclusion.
INSERT INTO proc.rfq_invitations
  (id, rfq_id, vendor_id, invited_at, expires_at, dispatched_at, dispatch_channel,
   token_hash, submitted, declined, reissue_no)
SELECT
  ('0c5e5000-0000-4000-8000-00000000000' || ROW_NUMBER() OVER (ORDER BY v.vendor_code))::uuid,
  '0c5e2000-0000-4000-8000-000000000001',
  v.id, now() - interval '9 days', now() + interval '3 days',
  now() - interval '9 days', 'manual',
  encode(digest('uat-seed-' || v.vendor_code || '-mx', 'sha256'), 'hex'),
  true, false, 0
FROM core.vendors v
WHERE v.vendor_code IN ('V-00081','V-00084','V-00087','V-00088');

-- ─── 5. Quotations (headers) ────────────────────────────────────────────────
-- total_amount is each vendor's basket over the lines it actually quoted, so a
-- vendor that skipped lines carries a LOWER total than a fuller bid. That is
-- deliberate: Punjab IT (449,200) beats Northbridge (687,000) on basket while
-- being able to supply only 4 of 6 lines, which is precisely the trap a
-- document-level "cheapest vendor" award falls into.
-- version 1, state 'Submitted' — nothing is awarded or rejected by this seed.

-- sealed_hash and open_at are BOTH NOT NULL with no default — they are part of
-- the quote's integrity envelope and were the last two columns missing.
INSERT INTO proc.quotations
  (id, rfq_id, vendor_id, submitted_by_user_id, submitted_at, open_at,
   total_amount, currency, fx_rate, normalized_total_pkr, sealed_hash,
   state, version, lead_time_days, warranty_months,
   taxes_included, quote_mode, validity_days, payment_terms)
VALUES
  ('0c5e4000-0000-4000-8000-000000000001', '0c5e2000-0000-4000-8000-000000000001',
   (SELECT id FROM core.vendors WHERE vendor_code = 'V-00087'),
   NULL, now() - interval '6 days', now() - interval '6 days',
   687000, 'PKR', 1, 687000,
   encode(digest('V-00087-687000-uat', 'sha256'), 'hex'),
   'Submitted', 1, 10, 24, true, 'per_line', 30, 'Net 30'),

  ('0c5e4000-0000-4000-8000-000000000002', '0c5e2000-0000-4000-8000-000000000001',
   (SELECT id FROM core.vendors WHERE vendor_code = 'V-00081'),
   NULL, now() - interval '6 days', now() - interval '6 days',
   571000, 'PKR', 1, 571000,
   encode(digest('V-00081-571000-uat', 'sha256'), 'hex'),
   'Submitted', 1, 14, 12, true, 'per_line', 30, 'Net 30'),

  ('0c5e4000-0000-4000-8000-000000000003', '0c5e2000-0000-4000-8000-000000000001',
   (SELECT id FROM core.vendors WHERE vendor_code = 'V-00084'),
   NULL, now() - interval '6 days', now() - interval '6 days',
   630300, 'PKR', 1, 630300,
   encode(digest('V-00084-630300-uat', 'sha256'), 'hex'),
   'Submitted', 1,  7, 18, true, 'per_line', 30, 'Net 30'),

  ('0c5e4000-0000-4000-8000-000000000004', '0c5e2000-0000-4000-8000-000000000001',
   (SELECT id FROM core.vendors WHERE vendor_code = 'V-00088'),
   NULL, now() - interval '6 days', now() - interval '6 days',
   449200, 'PKR', 1, 449200,
   encode(digest('V-00088-449200-uat', 'sha256'), 'hex'),
   'Submitted', 1, 21, 12, true, 'per_line', 30, 'Net 30');

-- ─── 6. Quotation lines — 20 of 24 cells, 4 DELIBERATE GAPS ─────────────────
-- The gaps are the point of this fixture:
--     L1 Punjab IT (V-00088)  — cheapest overall, missing from the biggest line
--     L3 Punjab IT (V-00088)
--     L4 KarachiTech (V-00084) — the FASTEST vendor, missing from a line where
--                               it would have been competitive
--     L6 Acme (V-00081)       — cheapest on 2 lines, missing from the last
--
-- These are ABSENT ROWS, not rows with a zero price. A No Quote is the absence
-- of an offer; a 0 would be a free item. AwardService.matrix() produces them
-- from its LEFT JOIN, and Point 3 (disabled radio + marker) is what renders
-- them. Nothing here writes a row with unit_price = 0.

INSERT INTO proc.quotation_lines
  (quotation_id, rfq_id, rfq_line_no, unit_price, total_price, declined, warranty_months)
VALUES
  -- L1 Industrial Servo Motor 5kW (qty 4) — L1 = Northbridge @25,000
  ('0c5e4000-0000-4000-8000-000000000001','0c5e2000-0000-4000-8000-000000000001',1, 25000, 100000, false, 24),
  ('0c5e4000-0000-4000-8000-000000000002','0c5e2000-0000-4000-8000-000000000001',1, 28000, 112000, false, 12),
  ('0c5e4000-0000-4000-8000-000000000003','0c5e2000-0000-4000-8000-000000000001',1, 26500, 106000, false, 18),
  --   ^ V-00088 Punjab IT — GAP

  -- L2 PLC Control Module (qty 2) — L1 = Acme @79,000
  ('0c5e4000-0000-4000-8000-000000000001','0c5e2000-0000-4000-8000-000000000001',2, 85000, 170000, false, 24),
  ('0c5e4000-0000-4000-8000-000000000002','0c5e2000-0000-4000-8000-000000000001',2, 79000, 158000, false, 12),
  ('0c5e4000-0000-4000-8000-000000000003','0c5e2000-0000-4000-8000-000000000001',2, 82000, 164000, false, 18),
  ('0c5e4000-0000-4000-8000-000000000004','0c5e2000-0000-4000-8000-000000000001',2, 88000, 176000, false,  6),

  -- L3 Conveyor Belt (qty 1) — L1 = KarachiTech @138,000
  ('0c5e4000-0000-4000-8000-000000000001','0c5e2000-0000-4000-8000-000000000001',3,145000, 145000, false, 12),
  ('0c5e4000-0000-4000-8000-000000000002','0c5e2000-0000-4000-8000-000000000001',3,152000, 152000, false, 12),
  ('0c5e4000-0000-4000-8000-000000000003','0c5e2000-0000-4000-8000-000000000001',3,138000, 138000, false, 18),
  --   ^ V-00088 Punjab IT — GAP

  -- L4 Hydraulic Sensor (qty 10) — L1 = Punjab IT @5,900
  ('0c5e4000-0000-4000-8000-000000000001','0c5e2000-0000-4000-8000-000000000001',4,  6200,  62000, false, 24),
  ('0c5e4000-0000-4000-8000-000000000002','0c5e2000-0000-4000-8000-000000000001',4,  6800,  68000, false, 12),
  --   ^ V-00084 KarachiTech (the fastest bidder) — GAP
  ('0c5e4000-0000-4000-8000-000000000004','0c5e2000-0000-4000-8000-000000000001',4,  5900,  59000, false, 12),

  -- L5 Valve Assembly (qty 6) — L1 = Acme @13,500
  ('0c5e4000-0000-4000-8000-000000000001','0c5e2000-0000-4000-8000-000000000001',5, 14000,  84000, false, 24),
  ('0c5e4000-0000-4000-8000-000000000002','0c5e2000-0000-4000-8000-000000000001',5, 13500,  81000, false, 12),
  ('0c5e4000-0000-4000-8000-000000000003','0c5e2000-0000-4000-8000-000000000001',5, 14800,  88800, false, 18),
  ('0c5e4000-0000-4000-8000-000000000004','0c5e2000-0000-4000-8000-000000000001',5, 15200,  91200, false, 12),

  -- L6 VFD Inverter Drive (qty 3) — L1 = Punjab IT @41,000
  ('0c5e4000-0000-4000-8000-000000000001','0c5e2000-0000-4000-8000-000000000001',6, 42000, 126000, false, 24),
  --   ^ V-00081 Acme — GAP
  ('0c5e4000-0000-4000-8000-000000000003','0c5e2000-0000-4000-8000-000000000001',6, 44500, 133500, false, 18),
  ('0c5e4000-0000-4000-8000-000000000004','0c5e2000-0000-4000-8000-000000000001',6, 41000, 123000, false,  6);

-- ─── 7. Verify the fixture actually has the shape it claims ─────────────────
-- A seed that silently produces 24/24 cells is worse than no seed, because the
-- gap-driven requirements would look broken rather than untested. This asserts
-- the count instead of trusting the INSERTs.

DO $$
DECLARE
  v_lines   integer;
  v_vendors integer;
  v_filled  integer;
  v_gaps    integer;
BEGIN
  SELECT count(DISTINCT rfq_line_no) INTO v_lines   FROM proc.quotation_lines WHERE rfq_id = '0c5e2000-0000-4000-8000-000000000001';
  SELECT count(DISTINCT vendor_id) INTO v_vendors FROM proc.quotations      WHERE rfq_id = '0c5e2000-0000-4000-8000-000000000001';
  SELECT count(*) INTO v_filled FROM proc.quotation_lines WHERE rfq_id = '0c5e2000-0000-4000-8000-000000000001';
  v_gaps := (v_lines * v_vendors) - v_filled;

  IF v_lines <> 6 THEN RAISE EXCEPTION 'expected 6 quoted lines, got %', v_lines; END IF;
  IF v_vendors <> 4 THEN RAISE EXCEPTION 'expected 4 bidders, got %', v_vendors; END IF;
  IF v_filled <> 20 THEN RAISE EXCEPTION 'expected 20 filled cells, got %', v_filled; END IF;
  IF v_gaps <> 4 THEN RAISE EXCEPTION 'expected 4 quote gaps, got %', v_gaps; END IF;

  -- No zero-price rows: a No Quote must be an ABSENT row, never a free line.
  IF EXISTS (SELECT 1 FROM proc.quotation_lines
              WHERE rfq_id = '0c5e2000-0000-4000-8000-000000000001'
                AND unit_price = 0) THEN
    RAISE EXCEPTION 'a No Quote was seeded as unit_price = 0; it must be an absent row';
  END IF;

  RAISE NOTICE 'fixture OK: % lines x % vendors = % cells, % filled, % deliberate gaps',
    v_lines, v_vendors, (v_lines * v_vendors), v_filled, v_gaps;
END $$;

COMMIT;

-- ─── Expected output ────────────────────────────────────────────────────────
--   fixture OK: 6 lines x 4 vendors = 24 cells, 20 filled, 4 deliberate gaps
--
-- Then: open PR-2026-UAT-CS-MTX -> CS -> Generate Comparative Statement.
-- Sign in as cs@pakboxes.pk or procurement@pakboxes.pk.
-- Before generating the CS after Phase 2 lands, close the RFQ first — that gate
-- is the point of leaving it 'Open'.