-- ─────────────────────────────────────────────────────────────────────────────
-- 047 - A categories table the UI can read, with the names the rest of the
--       system already speaks.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHY THIS TABLE HAD TO BE CREATED RATHER THAN READ
-- --------------------------------------------------
-- The brief was to make the "New Purchase Request" form's category dropdown read
-- from the database instead of a hardcoded list. The obvious source was
-- `SELECT DISTINCT category FROM core.items`, and that would have been wrong in
-- a way that quietly removes a control:
--
--   core.items.category holds four values —
--       IT_HARDWARE, OFFICE_SUPPLIES, SERVICES, WAREHOUSE_ACCESSORY
--
--   The vocabulary the approval rules actually use is NINE, and it lives in
--   packages/workflow-engine/src/categories.ts (LIGHT_ITEM_CATEGORIES):
--       IT_HARDWARE, IT_SOFTWARE, OFFICE_SUPPLIES, WAREHOUSE_ACCESSORY,
--       MACHINERY, PROFESSIONAL_SERVICES, FACILITIES, MARKETING, OTHER
--
-- The live line rule at workflow.steps_config(id='hod_review') routes on
-- IT_HARDWARE / IT_SOFTWARE (over PKR 100,000 to the IT Manager) and on
-- OFFICE_SUPPLIES / WAREHOUSE_ACCESSORY (to Warehouse). Sourcing the dropdown
-- from core.items would have offered SERVICES — which is in no routing rule —
-- while WITHHOLDING IT_SOFTWARE and MACHINERY, so a requester could no longer
-- select a software line and the IT-Manager branch would become unreachable
-- from the form.
--
-- So the table below is seeded from the ENGINE's nine, not from the items' four.
-- The nine are the ones the routing rules and the vendor allowlist both already
-- agree on.
--
-- ─── WHAT THIS MIGRATION DELIBERATELY DOES NOT DO ───────────────────────────
--
-- It does not touch core.vendors.preferred_categories, and there is no trigger
-- on it. That was in an earlier draft of this file and it was wrong, for a
-- reason worth writing down.
--
-- `preferred_categories` is a D365 **ItemGroup** vocabulary, not a line
-- category. Migration 037 seeded it from the W5-A dimension library
-- (IG-LAPTOP, IG-ACC, IG-OFC, IG-SVC in core.dimension_values) and its
-- post-condition actively enforces that contract:
--
--   SELECT count(*) INTO n FROM core.vendors v, unnest(v.preferred_categories) c(cat)
--    WHERE NOT EXISTS (SELECT 1 FROM core.dimension_values dv
--                       WHERE dv.dimension_key='ItemGroup' AND dv.code=c.cat AND dv.active);
--   IF n <> 0 THEN RAISE EXCEPTION 'assigned categories are not active ItemGroup values';
--
-- So that mapping is NOT unmapped-by-accident: it is validated against a
-- deliberate, working reference table, and it is one of the checks this change
-- was told not to weaken. A trigger requiring vendor categories to be line
-- categories would have rejected every legitimate vendor row and quietly
-- replaced a working validation with a wrong one.
--
-- The two vocabularies are legitimately different things — "which D365 item
-- group does this supplier sell" versus "which approval rule applies to this
-- line" — and they are left as they are. Reconciling them into one bridge table
-- was explicitly out of scope.
--
-- Also untouched: LIGHT_ITEM_CATEGORIES in the workflow engine (still the
-- authority the vendor validator checks against), onboarding.service.ts
-- normaliseCategory() (still throws BadRequestException on an unknown category),
-- and the vendor governed-change gate. This migration only ADDS a table the UI
-- can read, fixes one item whose category used a name nothing else recognises,
-- and adds a foreign key that can only ever reject a value the engine would not
-- have understood anyway.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

SET LOCAL search_path = core, proc, public;

-- ─── 1. the table ────────────────────────────────────────────────────────────
-- Deliberately plain: a code, a name, a description, a flag. No vendor mapping,
-- no D365 bridge — the brief asked for a category list and nothing more.
CREATE TABLE IF NOT EXISTS core.categories (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  description text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE core.categories IS
  'Canonical LINE categories, used by proc.pr_lines.category and by the workflow engine routing rules. Distinct from core.vendors.preferred_categories, which holds D365 ItemGroup codes (see migration 037).';
COMMENT ON COLUMN core.categories.code IS
  'Stable machine id, e.g. IT_HARDWARE. Never a display label. Must stay equal to LIGHT_ITEM_CATEGORY_IDS in packages/workflow-engine/src/categories.ts.';

-- ─── 2. seed ─────────────────────────────────────────────────────────────────
-- Labels and descriptions are transcribed EXACTLY from LIGHT_ITEM_CATEGORIES in
-- packages/workflow-engine/src/categories.ts. They are not paraphrases: an
-- earlier draft of this file invented friendlier wording ("Machinery" where the
-- engine says "Machinery / plant"), which is precisely the drift the check in
-- scripts/verify_categories.sql and scripts/prove_w5j_categories.mjs exists to
-- catch. Copy the strings; do not improve them.
INSERT INTO core.categories (code, name, description) VALUES
  ('IT_HARDWARE',           'IT hardware',          'Laptops, desktops, servers, networking equipment.'),
  ('IT_SOFTWARE',           'IT software',          'Licensed software, SaaS subscriptions, cloud services.'),
  ('OFFICE_SUPPLIES',       'Office supplies',      'Stationery, printer consumables, general consumables.'),
  ('WAREHOUSE_ACCESSORY',   'Warehouse accessory',  'Docks, cables, bags, mounts -- bundled or standalone.'),
  ('MACHINERY',             'Machinery / plant',    'Production-line machinery, tooling, heavy equipment.'),
  ('PROFESSIONAL_SERVICES', 'Professional services','Consultancy, audit, legal, training.'),
  ('FACILITIES',            'Facilities / FM',      'HVAC, plumbing, electrical, building maintenance.'),
  ('MARKETING',             'Marketing / branding', 'Campaigns, events, collateral, signage.'),
  ('OTHER',                 'Other',                'Catch-all when no category fits.')
ON CONFLICT (code) DO UPDATE
   SET name        = EXCLUDED.name,
       description = EXCLUDED.description,
       active      = true;

-- ─── 3. one catalogue row used a name nothing else recognises ────────────────
--
-- core.items has a real row (PKB-SRV-001, Annual Maintenance Contract) whose
-- category is `SERVICES`. The engine calls that idea `PROFESSIONAL_SERVICES`,
-- so `SERVICES` matched no routing rule and was not accepted by
-- onboarding.service.ts normaliseCategory() either. It was a dead value: it
-- looked like a category and routed nowhere.
--
-- Correcting the name rather than adding `SERVICES` to the table is the
-- difference between a coherent vocabulary and a second one. The alternative
-- was to seed ten rows, one of which was a synonym — and a dropdown that offers
-- a requester an option guaranteed not to route is worse than no dropdown.
--
-- No test or harness asserts on the literal 'SERVICES' for this item; the three
-- proof harnesses that copy core.items.category into proc.pr_lines.category
-- (prove_wave5f, prove_wave5g, prove_wave5h) pick items by item_code, so they
-- read the corrected value and stay valid.
UPDATE core.items SET category = 'PROFESSIONAL_SERVICES'
 WHERE category = 'SERVICES';

-- ─── 4. foreign key: a line cannot carry a category nobody knows ─────────────
--
-- proc.pr_lines.category was a bare text column, so any string at all could be
-- written to it. A value outside the vocabulary silently matched no line rule,
-- which is the worst failure mode for a routing key: the line is not rejected,
-- it is simply never routed, and nothing anywhere reports it.
--
-- Added NOT VALID so a pre-existing bad row could not abort the migration, then
-- validated straight after. Every existing row is either NULL or one of the
-- nine, so the validation is a formality — but it is kept so the guarantee is
-- real rather than assumed.
ALTER TABLE proc.pr_lines
  DROP CONSTRAINT IF EXISTS pr_lines_category_fkey;
ALTER TABLE proc.pr_lines
  ADD CONSTRAINT pr_lines_category_fkey
  FOREIGN KEY (category) REFERENCES core.categories(code) NOT VALID;

ALTER TABLE proc.pr_lines VALIDATE CONSTRAINT pr_lines_category_fkey;

COMMIT;
