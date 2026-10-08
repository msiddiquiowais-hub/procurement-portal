-- 028_supplier_external.sql
--
-- Wave 4 step 0 of WAVE4_PLAN.md — external parties.
--
-- WHY THIS MIGRATION EXISTS
-- Wave 4 ports three prototype screens that let the OUTSIDE world in:
-- supplier-rfq, supplier-quote (role 'vendor') and vendor-onboard-public
-- (anonymous). Two of the three have nowhere to live in the schema.
--
--   B1  There is no link from a supplier LOGIN to a vendor RECORD.
--       core.users had no vendor_id and no FK to core.vendors. The two seeded
--       supplier accounts (vendor1@example.com "Acme Supplies",
--       vendor2@example.com "BoxCo Packaging") correspond to V-00081/V-00082
--       by display-name convention only, and core.vendors.contacts is an empty
--       jsonb [] for every vendor. Without a real link a supplier session
--       cannot be scoped to its own proc.rfq_invitations — every supplier
--       would see every invitation, or none. That is the whole of W4-3.
--
--   B2  There is no vendor-application table.
--       The prototype's public form says submissions are "validated by
--       Procurement before vendor master creation", so a submission must be
--       storable in a pending state before any core.vendors row exists.
--       apps/onboarding faked it with `ONB-{Math.floor(Math.random()*99999)}`
--       — a fabricated reference, which this project forbids outright.
--
-- Nothing here is destructive and no existing column is dropped or retyped.
-- This migration is idempotent: every statement is IF NOT EXISTS, and the two
-- backfills are written to be no-ops on a second run.

BEGIN;

SET LOCAL search_path = core, public;

-- ============================================================================
-- B1 · supplier identity: a login is linked to exactly one vendor record
-- ============================================================================

ALTER TABLE core.users
  ADD COLUMN IF NOT EXISTS vendor_id uuid REFERENCES core.vendors(id);

-- The backfill, and why it is written with left() rather than LIKE.
--
-- The two seeded logins are identified by convention: their display_name is a
-- prefix of the vendor's legal_name ('Acme Supplies' -> 'Acme Supplies (Pvt)
-- Ltd', 'BoxCo Packaging' -> 'BoxCo Packaging Ltd'). That convention is the
-- ONLY thing tying them together today.
--
-- The obvious spelling of "is a prefix" is
--     legal_name LIKE display_name || '%'
-- and it is wrong for a reason that only bites later: LIKE reads '%' and '_'
-- inside the LEFT operand as wildcards. A vendor login whose display_name is
-- "Box_Co Packaging" would match any legal_name with a single character where
-- the underscore is — silently linking the account to the wrong company, or to
-- two of them. left()/length() is the same test with no pattern language in it.
-- Verified against live data on 2026-09-30: both seeded logins match, and
-- neither display_name contains '_' or '%' — so today's data was never at
-- risk. The point is that the next vendor login must not be either.
--
-- Idempotent by construction: it only writes rows where vendor_id IS NULL.
UPDATE core.users u
   SET vendor_id = v.id
  FROM core.vendors v
 WHERE u.role = 'vendor'
   AND u.vendor_id IS NULL
   AND left(v.legal_name, length(u.display_name)) = u.display_name;

-- One login per vendor. Two accounts sharing a vendor is ambiguous: which one
-- owns the quotes? The partial predicate keeps this from blocking the ordinary
-- multi-login case (every non-vendor user has vendor_id NULL and is excluded).
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_vendor_id
  ON core.users (vendor_id) WHERE vendor_id IS NOT NULL;

-- The invariant, stated where it cannot be forgotten. Without this, a future
-- INSERT that omits vendor_id would recreate exactly the silent-convention
-- coupling B1 exists to remove, and nothing would fail.
--
-- Added AFTER the backfill, so the backfill satisfies it rather than tripping
-- over it. See the seed-ordering note at the foot of this file: the seed had
-- to be reordered in the same step for a fresh database to load at all.
ALTER TABLE core.users
  DROP CONSTRAINT IF EXISTS ck_users_vendor_role;

ALTER TABLE core.users
  ADD CONSTRAINT ck_users_vendor_role
  CHECK (role <> 'vendor' OR vendor_id IS NOT NULL);

COMMENT ON COLUMN core.users.vendor_id IS
  'The vendor record this supplier login acts for. Required (ck_users_vendor_role) whenever role = ''vendor''; unique (ux_users_vendor_id) so one vendor has one login. This is the scope key for every supplier endpoint in Wave 4 — a vendor session reads and writes only its own proc.rfq_invitations and proc.quotations.';

-- ============================================================================
-- B2 · public vendor applications
-- ============================================================================

-- The reference is real and sequential, from a database sequence, because the
-- applicant is told it and has to be able to track it. Mirrors the shape of
-- proc.fn_next_rfq_number() / proc.fn_next_cs_number() from migration 025.
CREATE SEQUENCE IF NOT EXISTS core.seq_vendor_app_ref START WITH 1;

CREATE OR REPLACE FUNCTION core.fn_next_vendor_app_reference() RETURNS text
LANGUAGE plpgsql
AS $fn$
DECLARE
  yr int    := extract(year from now());
  n  bigint := nextval('core.seq_vendor_app_ref');
BEGIN
  -- 5-wide pad, matching the prototype's ONB-2026-00001.
  --
  -- WIDTH WARNING, in the spirit of migration 025: lpad() TRUNCATES as well as
  -- pads, so past 99999 this would fold 100000 back to '00000' and start
  -- colliding. That is ~100k public applications, which is far beyond anything
  -- this form will see, but it is a real ceiling and not a self-healing one.
  -- If the sequence ever approaches it, widen the pad in a migration — do not
  -- assume lpad will do the right thing for a longer input.
  RETURN 'ONB-' || yr || '-' || lpad(n::text, 5, '0');
END;
$fn$;

COMMENT ON FUNCTION core.fn_next_vendor_app_reference() IS
  'Sequential public onboarding reference, ''ONB-<year>-<5 digits>''. The single source of the reference — apps/onboarding must not invent one (the prototype''s Math.random() placeholder is exactly the fabrication this replaces). lpad truncates at 5 digits, so widening the format requires a migration.';

-- R2 note: vendor_applications lives in core, which this schema deliberately
-- leaves without RLS (only proc.purchase_requisitions and
-- proc.pr_acknowledgements are RLS-protected, from migrations 014 and 021).
-- Matching that convention is correct here: the table is reachable through an
-- intentionally PUBLIC endpoint, and the guard on who may see an application's
-- contents is the role gate in the API, not a row policy.
CREATE TABLE IF NOT EXISTS core.vendor_applications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference           text NOT NULL UNIQUE
                        DEFAULT core.fn_next_vendor_app_reference(),
  legal_name          text NOT NULL,
  -- The prototype's field is labelled "NTN / Tax ID". NTN is the Pakistan
  -- National Tax Number; it is the one field the applicant must supply that
  -- identifies the company to the tax authorities, so it is the natural
  -- de-duplication key. See ux_vendor_app_ntn_pending below.
  ntn                 text NOT NULL,
  contact_name        text,
  contact_email       text,
  categories          text,
  state               text NOT NULL DEFAULT 'Submitted'
                        CHECK (state IN ('Submitted','Under_Review','Approved','Rejected')),
  -- Why a pending application was rejected, and why a rejection was overridden
  -- on the way in. Both are the applicant-facing audit trail.
  reference_note      text,
  reviewed_by_user_id uuid REFERENCES core.users(id),
  reviewed_at         timestamptz,
  decision_note       text,
  submitted_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Duplicate-application guard, scoped to LIVE applications only.
--
-- This replaces the IP rate-limiter proposed as risk R6: the user (2026-09-30)
-- chose to rely on this index alone for Wave 4 rather than introduce
-- rate-limiting infrastructure the app does not currently have. The predicate
-- is the point — the same company may legitimately re-apply after a
-- Rejection, but not while an earlier application is still live.
CREATE UNIQUE INDEX IF NOT EXISTS ux_vendor_app_ntn_pending
  ON core.vendor_applications (ntn)
  WHERE state IN ('Submitted','Under_Review');

-- The procurement/CS queue read (GET /vendors/applications): newest first,
-- pending above decided.
CREATE INDEX IF NOT EXISTS idx_vendor_app_queue
  ON core.vendor_applications (state, submitted_at DESC);

-- The applicant's own status lookup: UNIQUE(reference) already carries the
-- index for the equality match this makes.

COMMENT ON TABLE core.vendor_applications IS
  'Public vendor onboarding intake. A row here is an APPLICATION, not a vendor: no core.vendors row is created until Procurement approves one (the prototype''s public-form alert: "validated by Procurement before vendor master creation"). The review UI is Wave 5 — Wave 4 only proves intake is real and readable.';

COMMENT ON COLUMN core.vendor_applications.reference IS
  'Sequential applicant-facing reference, ''ONB-<year>-<5 digits>'', defaulted from core.seq_vendor_app_ref. Returned once at submission and used for the public status lookup. Never invented by the application layer.';

COMMENT ON COLUMN core.vendor_applications.ntn IS
  'National Tax Number supplied by the applicant. Unique among LIVE applications only (ux_vendor_app_ntn_pending), which is the duplicate-application control for this wave — see WAVE4_PLAN.md R6. Not yet cross-checked against core.vendors.ntn: an application is unverified input, so a duplicate against an EXISTING vendor is a Wave 5 review decision, not a constraint here.';

COMMENT ON COLUMN core.vendor_applications.state IS
  'Submitted -> Under_Review -> Approved | Rejected. Submitted is the default because the public endpoint has no reviewer; only a procurement/CS/admin session may move it off Submitted. Wave 4 exposes no write path past Submitted.';

-- ============================================================================
-- B6 · document the invitation token as deliberately inert
-- ============================================================================
-- proc.rfq_invitations.token_hash has held a real SHA-256 of a generated token
-- since Wave 2 step 1, and nothing has ever read it: the prototype never uses a
-- token, the operator is simply logged in AS the vendor. Per W4-3 the token
-- stays INERT rather than being deleted, so restoring email deep-links later
-- needs no backfill. This mirrors how migration 024 documented sealed_hash.
COMMENT ON COLUMN proc.rfq_invitations.token_hash IS
  'SHA-256 of a bearer invitation token; the raw token is returned once at invite time. RETAINED BUT INERT — Wave 4 scopes supplier access by core.users.vendor_id (W4-3), not by this hash, because the prototype has the operator logged in as the vendor and never uses a token. Kept so a future email deep-link needs no backfill.';

COMMIT;

-- ============================================================================
-- SEED-ORDERING NOTE (the one thing this migration forced elsewhere)
-- ============================================================================
-- ck_users_vendor_role makes a genuine circular dependency between two tables:
--
--     core.users.vendor_id  -> core.vendors(id)      (B1, this migration)
--     core.vendors.created_by_user_id -> core.users(id)  (migration 003)
--
-- db/seeds/seed.sql inserted ALL users (including the two role='vendor' ones)
-- before it inserted any vendors. On a FRESH database that ordering now fails:
-- migrations run first, so the CHECK already exists when the seed runs, and the
-- vendor-user rows arrive with vendor_id NULL.
--
-- The seed was therefore split in the same step — the 19 non-supplier users are
-- inserted first, the vendors, then the 2 supplier logins with an explicit
-- vendor_id. That is the only ordering that satisfies both foreign keys.
-- If you add a third supplier login, add it to the SECOND users insert, after
-- the vendors block — never the first.
