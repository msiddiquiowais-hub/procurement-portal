-- 024_sourcing.sql
--
-- Wave 2, step 0. Sourcing foundation: RFQ issue, quotation versioning,
-- comparative statement, approved pack.
--
-- The sourcing tables were already designed in migration 010/011/012, so this
-- migration is ADDITIVE ONLY. No tables, no destructive changes, no column
-- drops or retypes. It adds the three things the Wave 2 screens need that the
-- schema did not carry, and it documents the four free-form jsonb shapes so
-- they become a contract rather than an assumption.
--
-- ── Sealed bids: deliberately NOT implemented (user decision Q2, 2026-09-30)
-- `proc.quotations.open_at` and `proc.quotations.sealed_hash` already exist and
-- are intentionally left in place, but NOTHING in Wave 2 reads them to gate
-- visibility. Quotes are visible the instant they are submitted. There is no
-- scheduler, no opening time, no deadline sweeper, and no hash verification on
-- read. `proc.rfq.deadline_at` is stored and DISPLAYED as information only; it
-- never hides, expires, or auto-closes anything.
--
-- Do not reintroduce deadline gating without a fresh decision from the user.

BEGIN;

-- ─── 1 · RFQ: issue timestamp and its own title ───────────────────────────
-- The prototype leads BOTH sourcing cards with a prominent
-- "RFQ issued: <datetime>" pill. `created_at` is when the row was written;
-- invitations may go out later, and the per-vendor `invited_at` is a third
-- value again. The card-level pill needs its own column to be honest.
ALTER TABLE proc.rfq ADD COLUMN IF NOT EXISTS issued_at timestamptz;

-- `rfq-list` has a Description column. Deriving it from the PR title works, but
-- a procurement officer may name the RFQ differently from the PR it serves.
ALTER TABLE proc.rfq ADD COLUMN IF NOT EXISTS title text;

-- ─── 2 · Comparative statement: explicit state ───────────────────────────
-- `locked_at IS NULL` is a usable state, but BOTH the CS screen and the pack
-- builder branch on it, and a CHECK-constrained column is cheaper to read and
-- cheaper to index than a nullable-timestamp scan.
ALTER TABLE proc.comparative_statements ADD COLUMN IF NOT EXISTS state text;

ALTER TABLE proc.comparative_statements
  DROP CONSTRAINT IF EXISTS comparative_statements_state_check;
ALTER TABLE proc.comparative_statements
  ADD CONSTRAINT comparative_statements_state_check
  CHECK (state IS NULL OR state IN ('Generated', 'Locked'));

-- 'Locked' and 'Generated' must agree with locked_at.
ALTER TABLE proc.comparative_statements
  DROP CONSTRAINT IF EXISTS comparative_statements_lock_consistency;
ALTER TABLE proc.comparative_statements
  ADD CONSTRAINT comparative_statements_lock_consistency
  CHECK (
    (state = 'Locked'    AND locked_at IS NOT NULL) OR
    (state = 'Generated' AND locked_at IS NULL)     OR
    (state IS NULL)
  );

-- Existing rows: a CS with a locked_at is already Locked, otherwise Generated.
UPDATE proc.comparative_statements
   SET state = CASE WHEN locked_at IS NOT NULL THEN 'Locked' ELSE 'Generated' END
 WHERE state IS NULL;

-- ─── 3 · indexes for the Wave 2 read paths ────────────────────────────────
-- RFQ list is filtered by PR and by state and ordered by issue time.
CREATE INDEX IF NOT EXISTS idx_rfq_pr        ON proc.rfq(pr_id);
CREATE INDEX IF NOT EXISTS idx_rfq_state     ON proc.rfq(state);
CREATE INDEX IF NOT EXISTS idx_rfq_issued    ON proc.rfq(issued_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_rfq_lines_pr  ON proc.rfq_lines(rfq_id, line_no);

-- The quotes table on a PR: active version per vendor, newest first.
CREATE INDEX IF NOT EXISTS idx_quotations_rfq_vendor_state
  ON proc.quotations(rfq_id, vendor_id, state);
-- The Versions Panel walks a vendor's whole history, newest version first.
CREATE INDEX IF NOT EXISTS idx_quotations_version
  ON proc.quotations(rfq_id, vendor_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_quotation_lines_q ON proc.quotation_lines(quotation_id, rfq_line_no);

-- The roster card reads invitations per RFQ, pending first.
CREATE INDEX IF NOT EXISTS idx_rfq_inv_rfq ON proc.rfq_invitations(rfq_id, submitted, declined);
-- Wave 4's public accept/decline links resolve by token.
CREATE INDEX IF NOT EXISTS idx_rfq_inv_token ON proc.rfq_invitations(token_hash);

CREATE INDEX IF NOT EXISTS idx_cs_lines_cs      ON proc.cs_lines(cs_id, rank);
CREATE INDEX IF NOT EXISTS idx_cs_pr            ON proc.comparative_statements(pr_id);
CREATE INDEX IF NOT EXISTS idx_nego_rfq         ON proc.negotiation_log(rfq_id, round);

-- ─── 4 · the four free-form jsonb shapes become a contract ────────────────
-- These columns are unconstrained jsonb. Wave 2 writes them; documenting the
-- shape here means the next reader does not have to reverse-engineer it from
-- the TypeScript.

COMMENT ON TABLE  proc.rfq IS
  'Request for Quotation. state: Open | Closed | Awarded | Cancelled.
   `issued_at` is when invitations were dispatched (nullable while still being
   built); `deadline_at` is DISPLAY-ONLY and never gates quote visibility.';

COMMENT ON COLUMN proc.rfq.issued_at IS
  'When the RFQ was actually issued to vendors. Distinct from created_at and from the per-vendor rfq_invitations.invited_at. Shown as the prominent "RFQ issued: <dt>" pill on both sourcing cards.';

COMMENT ON COLUMN proc.rfq.deadline_at IS
  'Advertised response deadline. INFORMATIONAL ONLY — never hides quotes, never
   expires an RFQ, never auto-closes. Per user decision Q2 (2026-09-30).';

COMMENT ON TABLE  proc.quotations IS
  'A submitted quote. APPEND-ONLY VERSIONING: revising a quote marks the prior
   version ''Superseded'' and inserts a new row with version = prior + 1 and
   supersedes_quotation_id set. No UPDATE ever rewrites a prior version''s price.
   state: Submitted | Superseded | Withdrawn | Awarded | Rejected.
   "Submitted" is the prototype''s ACTIVE; "Withdrawn" is the prototype''s VOID.
   `open_at` / `sealed_hash` are RETAINED BUT INERT — sealed bidding was
   deliberately not implemented (user decision Q2, 2026-09-30).';

COMMENT ON COLUMN comparative_statements.recommendation IS
  'Shape: {"vendorId": uuid, "quotationId": uuid, "version": int,
            "rank": int, "reason": text|null, "overrideReason": text|null,
            "isOverride": bool, "lockedAt": timestamptz}.
   `isOverride` is true when the winner is NOT rank 1; the reason is then
   mandatory and mirrored into `override_reason` for auditability.';

COMMENT ON COLUMN comparative_statements.weights IS
  'Shape: {"commercial": 0..1, "technical": 0..1, "warranty": 0..1}. The three
   weights must sum to 1.0. Defaults are 0.5 / 0.3 / 0.2 (the prototype treats
   price as the primary axis but scores lead time and warranty explicitly).';

COMMENT ON COLUMN comparative_statements.scores IS
  'Shape: {"generatedFrom": "manual"|"derived", "compliance": {<vendorId>: bool|null}}
   A null compliance entry means UNKNOWN — it is rendered as an em dash, never
   as a pass. Vendors with no due-diligence record must not be shown as compliant
   (divergence D5).';

COMMENT ON COLUMN approved_packs.payload IS
  'Frozen document set. Shape:
   {"documents": [{"#": int, "name": text, "kind": text, "sha256": text,
                   "sourceId": uuid|null, "signedAt": timestamptz, "signedBy": uuid}],
    "pr": {<pr header fields>},
    "cs": {<comparative statement fields>},
    "quotes": [{<quotation header fields>}, ...],
    "routing": {"routingKey": text, "label": text, "reason": text}}
   Hashes are REAL sha256 over the canonicalised payload. The prototype renders
   Math.random() placeholders here; those are deliberately not ported
   (divergence D1).';

COMMENT ON COLUMN proc.approved_packs.pack_hash IS
  'sha256 over the canonicalised `payload`. Computed once at freeze time. The pack is immutable: a second POST .../pack/lock is rejected, never an update.';

COMMIT;
