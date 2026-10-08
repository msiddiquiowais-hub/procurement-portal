-- ═══════════════════════════════════════════════════════════════════════════
-- 037 — Vendor detail columns, and the backfill that ends the em-dashes
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Wave 5 Track D shipped the Vendor Detail screen honestly: where the schema had
-- no field, it rendered an em-dash and said why. That was the right call for a
-- screen built ahead of its data, but it is not a permanent state. This
-- migration supplies the data the screen was asking for.
--
-- WHY COMPLIANCE IS PARTLY DERIVED AND PARTLY STORED
-- --------------------------------------------------
-- "Tax filing → Up to date" and "Insurance → Valid" are statements about a DATE.
-- Storing the date and computing the label means the label can never contradict
-- the date: there is no second copy to drift. So there is no `tax_filing_status`
-- column — only `tax_filing_valid_until`, and the API derives Up to date / Expired
-- / Not recorded from it against CURRENT_DATE.
--
-- AML and sanctions are NOT derivable. A check timestamp says a check HAPPENED,
-- never that it CAME BACK CLEAN, so inventing a "Clear" from a timestamp would be
-- exactly the fabricated pass this codebase refuses. Those two therefore carry an
-- explicit result alongside their timestamp.
--
-- WHY EVERY COLUMN IS NULLABLE (RULE 2 — D365 SYNC MUST NOT BE BLOCKED)
-- --------------------------------------------------------------------
-- Vendors will sync in from Dynamics 365. A D365 vendor arrives with whatever
-- fields D365 holds — which may be no rating, no city, no compliance dates. If any
-- of these columns were NOT NULL, or carried a CHECK that a fresh vendor could
-- fail, the incoming stream would reject records.
--
-- So: every column added here is nullable. None of it is enforced at write time.
-- The consequence is deliberate and must not be "fixed" later by tightening these
-- columns — see the rule 3 / rule 4 note at the end of this header.
--
-- RULE 3 (category mandatory) IS THEREFORE *NOT* A CHECK CONSTRAINT HERE.
-- A CHECK of the form `state <> 'Active' OR preferred_categories <> '{}'` looks
-- like the obvious way to guarantee rule 3, and it would break rule 2 on the very
-- first D365 vendor that landed as Active without a category. Category is enforced
-- at the point of USE — the RFQ dispatch gate (rule 4) — where an un-categorised
-- vendor is excluded from automatic RFQs and quotation emails rather than
-- refused at the door. The backfill below gives every seeded active vendor a
-- category so the demo estate starts clean; that is DATA, not a constraint.
--
-- The `is_hold` column (rule 5, Hold/Unhold) is deliberately NOT added here. It
-- changes write paths, needs its own audit trigger and its own API, and belongs
-- to Track W5-E where it can be reviewed on its own.
--
-- Idempotency: every ADD COLUMN is IF NOT EXISTS, every constraint is dropped
-- before it is re-added, and the backfills use ON CONFLICT DO NOTHING against
-- existing unique keys. Re-running this file is a no-op.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. The detail columns ──────────────────────────────────────────────────

ALTER TABLE core.vendors ADD COLUMN IF NOT EXISTS rating        numeric(2,1);
ALTER TABLE core.vendors ADD COLUMN IF NOT EXISTS city          text;
ALTER TABLE core.vendors ADD COLUMN IF NOT EXISTS contact_name  text;
ALTER TABLE core.vendors ADD COLUMN IF NOT EXISTS contact_email text;

-- Compliance. Dates, not status words, for the two that are purely date-derived.
ALTER TABLE core.vendors ADD COLUMN IF NOT EXISTS tax_filing_valid_until date;
ALTER TABLE core.vendors ADD COLUMN IF NOT EXISTS insurance_valid_until  date;
ALTER TABLE core.vendors ADD COLUMN IF NOT EXISTS insurance_policy_ref   text;

-- Result + timestamp, because "checked" is not the same claim as "clear".
ALTER TABLE core.vendors ADD COLUMN IF NOT EXISTS aml_check_result text;
ALTER TABLE core.vendors ADD COLUMN IF NOT EXISTS aml_checked_at   timestamptz;
ALTER TABLE core.vendors ADD COLUMN IF NOT EXISTS sanctions_result text;
ALTER TABLE core.vendors ADD COLUMN IF NOT EXISTS sanctions_screened_at timestamptz;

ALTER TABLE core.vendors ADD COLUMN IF NOT EXISTS last_audit_at  timestamptz;
ALTER TABLE core.vendors ADD COLUMN IF NOT EXISTS next_review_at timestamptz;

COMMENT ON COLUMN core.vendors.rating IS
  '0.0-5.0 supplier rating. NULL means not rated; it is never inferred from the risk composite.';
COMMENT ON COLUMN core.vendors.tax_filing_valid_until IS
  'Date the tax filing lapses. The Up-to-date / Expired label is DERIVED from this against CURRENT_DATE; there is deliberately no status column to disagree with it.';
COMMENT ON COLUMN core.vendors.aml_check_result IS
  'Clear | Adverse | Pending. Stored explicitly because a check timestamp cannot tell you the outcome.';
COMMENT ON COLUMN core.vendors.sanctions_result IS
  'Clear | Match | Pending. Stored explicitly for the same reason as aml_check_result.';

-- ─── 2. Constraints, dropped then re-added so a replay is safe ───────────────

ALTER TABLE core.vendors DROP CONSTRAINT IF EXISTS vendors_rating_range;
ALTER TABLE core.vendors ADD CONSTRAINT vendors_rating_range
  CHECK (rating IS NULL OR (rating >= 0 AND rating <= 5));

ALTER TABLE core.vendors DROP CONSTRAINT IF EXISTS vendors_aml_result_domain;
ALTER TABLE core.vendors ADD CONSTRAINT vendors_aml_result_domain
  CHECK (aml_check_result IS NULL OR aml_check_result IN ('Clear','Adverse','Pending'));

ALTER TABLE core.vendors DROP CONSTRAINT IF EXISTS vendors_sanctions_result_domain;
ALTER TABLE core.vendors ADD CONSTRAINT vendors_sanctions_result_domain
  CHECK (sanctions_result IS NULL OR sanctions_result IN ('Clear','Match','Pending'));

-- A result without a date is a claim nobody can date, and a date without a result
-- is an incomplete record. Requiring BOTH keeps the two halves together.
ALTER TABLE core.vendors DROP CONSTRAINT IF EXISTS vendors_aml_result_has_date;
ALTER TABLE core.vendors ADD CONSTRAINT vendors_aml_result_has_date
  CHECK ((aml_check_result IS NULL) = (aml_checked_at IS NULL));

ALTER TABLE core.vendors DROP CONSTRAINT IF EXISTS vendors_sanctions_result_has_date;
ALTER TABLE core.vendors ADD CONSTRAINT vendors_sanctions_result_has_date
  CHECK ((sanctions_result IS NULL) = (sanctions_screened_at IS NULL));

-- ─── 3. Backfill: performance metrics ────────────────────────────────────────
-- On-time delivery belongs in core.vendor_performance, which is quarterly and
-- already keyed UNIQUE (vendor_id, quarter). Putting it there rather than adding a
-- second on-time column to core.vendors keeps one source of truth; the Vendor
-- Detail screen already reads the latest quarter.

INSERT INTO core.vendor_performance
  (vendor_id, quarter, on_time_pct, reject_pct, avg_response_hours, score, computed_at)
SELECT v.id, '2026-Q3', d.on_time, d.rej, d.resp, d.score, now()
  FROM core.vendors v
  JOIN (VALUES
    ('V-00081', 96.4::numeric, 1.2::numeric,  3.5::numeric, 88::numeric),  -- Low
    ('V-00082', 91.8::numeric, 3.4::numeric,  6.2::numeric, 74::numeric),  -- Medium
    ('V-00084', 74.2::numeric, 9.1::numeric, 18.4::numeric, 46::numeric),  -- High
    ('V-00085', 68.9::numeric, 12.7::numeric, 22.0::numeric, 38::numeric), -- High
    ('V-00086', 95.1::numeric, 2.0::numeric,  4.1::numeric, 85::numeric)   -- Low
  ) AS d(vendor_code, on_time, rej, resp, score)
    ON d.vendor_code = v.vendor_code
ON CONFLICT (vendor_id, quarter) DO NOTHING;

-- V-00083 is deliberately absent. It is DD_In_Progress and blacklisted: a vendor
-- that has not cleared due diligence has no delivery history to report, and a
-- fabricated 0% would read as a performance finding rather than an absence of one.

-- ─── 4. Backfill: profile, rating, city, contact, compliance ────────────────
-- All values are DEMO SEED DATA for a seeded estate, exactly like the seeded PRs,
-- vendors and comparative statements already in this database. They are not
-- measurements of any real company.
--
-- The compliance states are deliberately NOT uniformly green. V-00084's insurance
-- has lapsed and V-00085's tax filing has expired with AML still pending. A demo
-- where every vendor passes every check proves nothing about the display logic,
-- and reads as fabricated.

-- REPLAY EXEMPTION (added by 039)
-- Migration 039 installs core.fn_vendors_governed_change_gate(), which refuses any
-- UPDATE of a governed vendor column that does not carry an audit token. This
-- backfill IS such an UPDATE, and migrations replay in lexical order with no ledger -
-- on the second `db:migrate` this statement would run with 039's trigger already
-- installed and abort the whole step. Declaring the session a migration write keeps
-- this file individually re-runnable. The runtime API path is unaffected: it is
-- governed by app.vendor_change_token, not by this flag.
SELECT set_config('app.vendor_legacy_write', 'on', false);

UPDATE core.vendors SET
  rating        = d.rating,
  city          = d.city,
  contact_name  = d.contact_name,
  contact_email = d.contact_email,
  tax_filing_valid_until = d.tax_until,
  insurance_valid_until  = d.ins_until,
  insurance_policy_ref   = d.ins_ref,
  aml_check_result       = d.aml_result,
  aml_checked_at         = d.aml_at,
  sanctions_result       = d.sanctions,
  sanctions_screened_at  = d.sanctions_at,
  last_audit_at          = d.audited_at,
  next_review_at         = d.review_at,
  bank_account_verified_at = d.bank_at
FROM (VALUES
  ('V-00081', 4.8::numeric, 'Karachi',  'Sana Yousuf',  'sana@acmesupplies.pk',
     CURRENT_DATE + 210, CURRENT_DATE + 300, 'INS-ACME-2026-114',
     'Clear',   now() - interval '20 days', 'Clear', now() - interval '20 days',
     now() - interval '75 days', now() + interval '285 days', now() - interval '95 days'),
  ('V-00082', 3.9::numeric, 'Karachi',  'Imran Qureshi','imran@boxco.pk',
     CURRENT_DATE + 95,  CURRENT_DATE + 150, 'INS-BOX-2026-087',
     'Clear',   now() - interval '35 days', 'Clear', now() - interval '35 days',
     now() - interval '140 days', now() + interval '220 days', now() - interval '150 days'),
  ('V-00084', 2.6::numeric, 'Lahore',   'Farah Siddiqui','farah@karachitech.pk',
     CURRENT_DATE + 60,  CURRENT_DATE - 25,  'INS-KTC-2025-402',
     'Clear',   now() - interval '48 days', 'Clear', now() - interval '48 days',
     now() - interval '210 days', now() + interval '60 days',  now() - interval '220 days'),
  ('V-00085', 2.1::numeric, 'Islamabad','Bilal Ahmed',  'bilal@indusoffice.pk',
     CURRENT_DATE - 30, CURRENT_DATE + 45,  'INS-IOS-2026-019',
     'Pending', now() - interval '6 days',  'Clear', now() - interval '62 days',
     now() - interval '260 days', now() + interval '12 days',  NULL::timestamptz),
  ('V-00086', 4.5::numeric, 'Lahore',   'Hina Kamal',   'hina@crescenttech.pk',
     CURRENT_DATE + 165, CURRENT_DATE + 240, 'INS-CRD-2026-233',
     'Clear',   now() - interval '11 days', 'Clear', now() - interval '11 days',
     now() - interval '55 days', now() + interval '310 days', now() - interval '70 days')
) AS d(vendor_code, rating, city, contact_name, contact_email,
       tax_until, ins_until, ins_ref,
       aml_result, aml_at, sanctions, sanctions_at,
       audited_at, review_at, bank_at)
WHERE d.vendor_code = core.vendors.vendor_code
  -- Only fill gaps. A later real edit must not be clobbered by a replay.
  AND core.vendors.rating IS DISTINCT FROM d.rating;

-- ─── 5. Backfill: preferred categories (rule 3, at the DATA level) ──────────
-- Category is mandatory for active vendors, but it is NOT a constraint (see the
-- header). Every seeded active vendor therefore gets a real ItemGroup code from
-- the W5-A dimension library, so the demo estate satisfies rule 3 from day one
-- and the RFQ dispatch gate has nothing to exclude at rest.

-- `preferred_categories` is a text[] (not jsonb), so emptiness is
-- cardinality() = 0 rather than a comparison against '{}'.
UPDATE core.vendors SET preferred_categories = d.cats
FROM (VALUES
  ('V-00081', ARRAY['IG-OFC','IG-ACC']::text[]),
  ('V-00082', ARRAY['IG-OFC']::text[]),
  ('V-00084', ARRAY['IG-LAPTOP','IG-ACC']::text[]),
  ('V-00085', ARRAY['IG-SVC']::text[]),
  ('V-00086', ARRAY['IG-LAPTOP']::text[])
) AS d(vendor_code, cats)
WHERE d.vendor_code = core.vendors.vendor_code
  AND COALESCE(cardinality(core.vendors.preferred_categories), 0) = 0;

-- ═══ Post-condition check (inside the transaction, so a failure rolls back) ══
DO $$
DECLARE
  n   integer;
  col text;
BEGIN
  -- (1) Every column this migration owns exists.
  FOREACH col IN ARRAY ARRAY[
    'rating','city','contact_name','contact_email',
    'tax_filing_valid_until','insurance_valid_until','insurance_policy_ref',
    'aml_check_result','aml_checked_at','sanctions_result','sanctions_screened_at',
    'last_audit_at','next_review_at']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='core' AND table_name='vendors' AND column_name=col
    ) THEN
      RAISE EXCEPTION 'migration 037: core.vendors.% does not exist', col;
    END IF;
  END LOOP;

  -- (2) The constraints exist. A domain CHECK that silently failed to attach is
  --     worse than none, because the API would start trusting it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='vendors_rating_range'
                  AND conrelid='core.vendors'::regclass) THEN
    RAISE EXCEPTION 'migration 037: vendors_rating_range was not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='vendors_aml_result_domain'
                  AND conrelid='core.vendors'::regclass) THEN
    RAISE EXCEPTION 'migration 037: vendors_aml_result_domain was not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='vendors_sanctions_result_domain'
                  AND conrelid='core.vendors'::regclass) THEN
    RAISE EXCEPTION 'migration 037: vendors_sanctions_result_domain was not created';
  END IF;

  -- (3) No rating outside 0..5 survived the backfill.
  SELECT count(*) INTO n FROM core.vendors
   WHERE rating IS NOT NULL AND (rating < 0 OR rating > 5);
  IF n <> 0 THEN RAISE EXCEPTION 'migration 037: % vendors have a rating outside 0..5', n; END IF;

  -- (4) The AML/sanctions result-and-date pairing holds for every row.
  SELECT count(*) INTO n FROM core.vendors
   WHERE (aml_check_result IS NULL) <> (aml_checked_at IS NULL)
      OR (sanctions_result IS NULL) <> (sanctions_screened_at IS NULL);
  IF n <> 0 THEN
    RAISE EXCEPTION 'migration 037: % vendors have a compliance result without its date, or the reverse', n;
  END IF;

  -- (5) RULE 3, as data: every ACTIVE vendor carries at least one category.
  --     This is a seed assertion, not a constraint. A D365 vendor may still land
  --     without one; the RFQ gate excludes it and the dashboard flags it.
  SELECT count(*) INTO n
    FROM core.vendors
   WHERE state = 'Active'
     AND COALESCE(cardinality(preferred_categories), 0) = 0;
  IF n <> 0 THEN
    RAISE EXCEPTION
      'migration 037: % active vendor(s) still have no category; rule 3 is satisfied by data, not by a constraint', n;
  END IF;

  -- (6) Every category assigned is a category this system actually knows about.
  --
  --     This accepts EITHER vocabulary on purpose. The vendor mapping started
  --     life on the ItemGroup library and migration 051 moved it to the line
  --     categories in core.categories, so this file is replayed with the array
  --     holding line codes on a database that has already migrated and item
  --     group codes on a fresh one. Validating against only one of them made
  --     every `db:migrate` fail the moment 051 had run.
  --
  --     EXECUTE is required, not decorative: on a fresh database core.categories
  --     does not exist yet at this point (migration 047 creates it), and a plain
  --     reference would be a parse error rather than a skipped branch.
  IF to_regclass('core.categories') IS NOT NULL THEN
    EXECUTE $q$
      SELECT count(*) FROM core.vendors v, unnest(v.preferred_categories) AS c(cat)
       WHERE NOT EXISTS (SELECT 1 FROM core.categories WHERE code = c.cat)
         AND NOT EXISTS (SELECT 1 FROM core.dimension_values dv
                          WHERE dv.dimension_key='ItemGroup' AND dv.code=c.cat AND dv.active)
    $q$ INTO n;
  ELSE
    SELECT count(*) INTO n
      FROM core.vendors v, unnest(v.preferred_categories) AS c(cat)
     WHERE NOT EXISTS (SELECT 1 FROM core.dimension_values dv
                        WHERE dv.dimension_key='ItemGroup' AND dv.code=c.cat AND dv.active);
  END IF;
  IF n <> 0 THEN
    RAISE EXCEPTION
      'migration 037: % assigned categories match no known vocabulary (a line category or an '
      'active ItemGroup). A typo here would surface as an empty picker with no explanation.', n;
  END IF;

  -- (7) Performance exists for every SCORED vendor. The unscored, blacklisted
  --     V-00083 is excluded on purpose and must stay that way.
  SELECT count(*) INTO n
    FROM core.vendors v
    CROSS JOIN LATERAL core.fn_vendor_composite(v.scorecard) AS c
   WHERE c.score IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM core.vendor_performance p WHERE p.vendor_id = v.id);
  IF n <> 0 THEN
    RAISE EXCEPTION 'migration 037: % scored vendor(s) have no on-time record; the detail screen would show a dash', n;
  END IF;

  -- (8) Performance percentages are in range.
  SELECT count(*) INTO n FROM core.vendor_performance
   WHERE on_time_pct < 0 OR on_time_pct > 100
      OR reject_pct  < 0 OR reject_pct  > 100;
  IF n <> 0 THEN RAISE EXCEPTION 'migration 037: % performance row(s) have a percentage outside 0..100', n; END IF;
END;
$$;
