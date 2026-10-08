-- 031_uom_vocabulary.sql
-- Phase: Wave 5 — Track A (Foundations)
-- Purpose: give units of measure a real catalog, and make "is this a valid UOM"
--          answerable — without breaking the UOMs already on live PR lines.
--
-- WHY THIS MIGRATION EXISTS
-- ------------------------
-- `uom` is a free-text string throughout the build: `proc.pr_lines.uom` and
-- `PurchUnit: ln.uom` on the D365 payload. There is no library, no validation and
-- no subset. The prototype carries a full D365 UOM admin (18 values, editable,
-- searched) plus a 10-value subset on the light-flow creation form. The gap
-- analysis records the absent vocabulary as #4/#25, HIGH — a UOM pickers cannot
-- populate from.
--
-- ── TWO THINGS THIS MIGRATION DELIBERATELY DOES NOT DO ─────────────────────
--
-- 1. IT DOES NOT ADD A FOREIGN KEY ON proc.pr_lines.uom.
--    Live data already violates the vocabulary. Distinct values in
--    proc.pr_lines today:
--        BX     (8 rows)  — almost certainly a typo for BOX, but a PR line's
--                           UOM is a posted financial field sent to D365 as
--                           PurchUnit; silently rewriting it is not a
--                           data-cleaning decision a migration should make.
--        sheet  (2 rows)  — not a D365 unit of measure at all; looks like a
--                           spreadsheet-header artefact from a quotation import.
--        EA   (202 rows)  — valid.
--    A FK here would abort the whole migration on a migrated database — the
--    exact 019/020/027 failure mode where an incremental re-migrate dies on
--    data it was supposed to help. So the catalog is added, and validity is
--    exposed as a FUNCTION (core.fn_uom_is_valid) for W5-B to call
--    deliberately, with the offenders REPORTED here rather than mutated.
--
-- 2. IT DOES NOT SEED EXACTLY 18 VALUES.
--    The prototype's D365_UOM_LIBRARY_SEED has 18 entries and does NOT contain
--    LEASE. But the prototype's light-flow form hardcodes its own option list as
--    ['EA','PCS','BOX','KG','L','M','SET','HR','PKT','LEASE']
--    (PROCUREMENT_PORTAL_PROTOTYPE.html:2315), and seeded light PR
--    LIGHT-26-00003 carries uom:'LEASE'. So LEASE is a 19th unit the prototype
--    actually uses while its own catalog denies it — an internal contradiction
--    that would make the light flow offer an option its own library rejects.
--    LEASE is therefore seeded, flagged light_flow, and documented here as a
--    CORRECTION of a prototype defect (the same treatment Part 7 gave
--    LIGHT_STAGES gaining IN_WAREHOUSE / IN_IT_REVIEW). The blueprint's "18" is
--    preserved as the D365-catalog count: the 18 D365 units plus one
--    light-flow-only unit.
--
-- Idempotency: ON CONFLICT (code) DO NOTHING, so an admin edit through the
-- W5-C admin-uom screen is never clobbered by a re-run.

BEGIN;

SET LOCAL search_path = core, public;

-- ─── 1. The catalog ────────────────────────────────────────────────────────
-- code is the PK, matching the prototype's {code, name, active} row shape and the
-- `PurchUnit` value sent to D365 verbatim.

CREATE TABLE IF NOT EXISTS core.uom (
  code       text PRIMARY KEY,
  name       text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  -- Two independent sets, NOT complements of each other, and conflating them is
  -- the mistake this schema exists to prevent:
  --   is_d365_catalog  the 18 units the prototype's D365_UOM_LIBRARY_SEED declares
  --   light_flow       the 10 the light-flow creation form offers
  -- Nine units are in BOTH. LEASE is in the second and not the first. So
  -- "NOT light_flow" is 9, not 18, and an admin screen counting the catalog by
  -- negating the light flag would report the wrong total.
  is_d365_catalog boolean NOT NULL DEFAULT false,
  light_flow      boolean NOT NULL DEFAULT false,
  sort_order      int NOT NULL DEFAULT 0,
  CONSTRAINT uom_code_not_blank CHECK (btrim(code) <> ''),
  -- The D365 push sends this string; an em dash or a space would be rejected
  -- downstream, so keep the code a clean token.
  CONSTRAINT uom_code_token CHECK (code ~* '^[A-Z0-9]+$')
);

CREATE INDEX IF NOT EXISTS idx_uom_active ON core.uom (active, sort_order);
CREATE INDEX IF NOT EXISTS idx_uom_catalog ON core.uom (is_d365_catalog, sort_order) WHERE is_d365_catalog;
CREATE INDEX IF NOT EXISTS idx_uom_light  ON core.uom (light_flow, sort_order) WHERE light_flow;

-- The 18 D365 catalog units, in the prototype's declared order.
-- light_flow marks the 10-value subset the light-flow creation form exposes
-- (prototype line 2315): EA, PCS, BOX, KG, L, M, SET, HR, PKT — plus LEASE
-- below, which makes ten. The remaining nine are catalog-only.
INSERT INTO core.uom (code, name, is_d365_catalog, light_flow, sort_order) VALUES
  ('EA',      'Each (single unit)',            true,  true,  1),
  ('PCS',     'Pieces',                       true,  true,  2),
  ('SET',     'Set (kit of multiple parts)',  true,  true,  3),
  ('BOX',     'Box (pack of N units)',        true,  true,  4),
  ('CTN',     'Carton',                       true,  false, 5),
  ('PKT',     'Packet / pack',                true,  true,  6),
  ('KG',      'Kilogram',                     true,  true,  7),
  ('G',       'Gram',                         true,  false, 8),
  ('L',       'Litre',                        true,  true,  9),
  ('M',       'Metre',                        true,  true,  10),
  ('M2',      'Square metre',                 true,  false, 11),
  ('M3',      'Cubic metre',                  true,  false, 12),
  ('HR',      'Hour (services)',              true,  true,  13),
  ('DAY',     'Day (services)',               true,  false, 14),
  ('LICENSE', 'Software license (perpetual)', true,  false, 15),
  ('SUB',     'Subscription (per year)',      true,  false, 16),
  ('SEAT',    'Seat (per-user)',              true,  false, 17),
  ('LOT',     'Lot (whole procurement)',      true,  false, 18),
  -- 19th: light-flow only. See the header note — the prototype's light form and
  -- LIGHT-26-00003 both use LEASE while its 18-row catalog omits it.
  ('LEASE',   'Lease (whole term)',           false, true,  19)
ON CONFLICT (code) DO NOTHING;

-- ─── 2. Validity as a function, not a constraint ───────────────────────────
-- W5-B calls this on save. It is deliberately a plain lookup rather than a FK so
-- that a UOM which is inactive can be reported as a distinct condition from one
-- that does not exist: an existing PR keeps its snapshotted UOM, but a NEW line
-- must not be offered an inactive unit.

CREATE OR REPLACE FUNCTION core.fn_uom_is_valid(p_code text, p_require_active boolean DEFAULT true)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
           WHEN p_code IS NULL OR btrim(p_code) = '' THEN false
           WHEN p_require_active THEN EXISTS (
                  SELECT 1 FROM core.uom u WHERE u.code = upper(btrim(p_code)) AND u.active)
           ELSE EXISTS (
                  SELECT 1 FROM core.uom u WHERE u.code = upper(btrim(p_code)))
         END;
$$;

COMMENT ON FUNCTION core.fn_uom_is_valid(text, boolean) IS
  'True when the UOM exists in the catalog (and is active when p_require_active). '
  'W5-B uses this instead of an FK because live pr_lines carry BX and sheet, which '
  'are not catalog units. See migration 031 header.';

-- The light-flow subset the creation form exposes, as data rather than a
-- hardcoded array, so the form and the catalog cannot drift apart.
CREATE OR REPLACE FUNCTION core.fn_light_flow_uoms()
RETURNS TABLE (code text, name text)
LANGUAGE sql
STABLE
AS $$
  SELECT u.code, u.name FROM core.uom u
   WHERE u.light_flow AND u.active
   ORDER BY u.sort_order;
$$;

-- ─── Post-condition check (inside the transaction, so a failure rolls back) ─

DO $$
DECLARE
  n_catalog     int;
  n_light       int;
  n_both        int;
  n_light_only  int;
  bad_fn        text;
BEGIN
  SELECT count(*) INTO n_catalog FROM core.uom WHERE is_d365_catalog;
  IF n_catalog <> 18 THEN
    RAISE EXCEPTION 'migration 031: expected 18 D365 catalog UOMs, found %', n_catalog;
  END IF;

  SELECT count(*) INTO n_light FROM core.uom WHERE light_flow AND active;
  IF n_light <> 10 THEN
    RAISE EXCEPTION 'migration 031: expected a 10-value light-flow subset, found %', n_light;
  END IF;

  -- The two sets overlap but are not complements: exactly nine units are in both
  -- and exactly one (LEASE) is light-flow only. If this drifts, the admin
  -- screen's "18 values" header and the light form's picker stop agreeing.
  SELECT count(*) INTO n_both FROM core.uom WHERE is_d365_catalog AND light_flow;
  IF n_both <> 9 THEN
    RAISE EXCEPTION 'migration 031: expected 9 units in BOTH the D365 catalog and the light subset, found %', n_both;
  END IF;

  SELECT count(*) INTO n_light_only FROM core.uom WHERE light_flow AND NOT is_d365_catalog;
  IF n_light_only <> 1 THEN
    RAISE EXCEPTION 'migration 031: expected exactly 1 light-flow-only unit (LEASE), found %', n_light_only;
  END IF;

  -- The prototype defect this migration corrects: LEASE must exist, or the
  -- light-flow form offers a unit its own catalog denies.
  IF NOT EXISTS (SELECT 1 FROM core.uom WHERE code = 'LEASE') THEN
    RAISE EXCEPTION 'migration 031: LEASE is used by the light-flow form and by LIGHT-26-00003 but is not in the catalog';
  END IF;

  -- fn_uom_is_valid must agree with the table it reads.
  IF core.fn_uom_is_valid('EA') IS NOT true THEN
    RAISE EXCEPTION 'migration 031: fn_uom_is_valid rejected a known-good UOM (EA)';
  END IF;
  IF core.fn_uom_is_valid('sheet') IS NOT false THEN
    RAISE EXCEPTION 'migration 031: fn_uom_is_valid accepted "sheet", which is not a catalog unit';
  END IF;

  -- REPORT, DO NOT MUTATE. These are the values that stopped a foreign key from
  -- being created here. A NOTICE is the deliverable: W5-B decides what to do
  -- about them with a human in the loop.
  SELECT string_agg(DISTINCT l.uom, ', ' ORDER BY l.uom) INTO bad_fn
    FROM (SELECT DISTINCT uom FROM proc.pr_lines WHERE uom IS NOT NULL) l
   WHERE NOT core.fn_uom_is_valid(l.uom);

  IF bad_fn IS NOT NULL THEN
    RAISE NOTICE 'migration 031: existing pr_lines carry non-catalog UOM(s): % — left unchanged on purpose; no FK was added', bad_fn;
  END IF;

  RAISE NOTICE 'migration 031 verified — 18 D365 catalog UOMs, 10 light-flow subset (incl. corrected LEASE), fn_uom_is_valid agrees with the table';
END $$;

COMMIT;
