-- 026_quotations.sql
--
-- Wave 2 step 2 — make a quote recordable.
--
-- Three gaps, all discovered by reading the live schema rather than assuming:
--
-- 1. proc.rfq_lines WAS NEVER POPULATED.
--    Wave 2 step 1 creates the `rfq` and the invitations but skipped the line
--    snapshot, so proc.rfq_lines was empty. That is not cosmetic:
--    proc.quotation_lines carries
--      FOREIGN KEY (quotation_id, rfq_line_no) REFERENCES rfq_lines(rfq_id, line_no)
--    so a per-line quote is REJECTED while rfq_lines is empty. The two tables
--    are coupled by a composite FK, and step 1 broke half of it.
--    We backfill here, and RfqService.issue() populates it for new RFQs.
--
-- 2. THREE QUOTE FIELDS THE PROTOTYPE CAPTURES HAVE NO COLUMN.
--    lightProcReceiveQuote's payload carries paymentTerms and notes, and the
--    grand-total vs per-line entry mode. The prototype persists all three
--    (quoteLines[vid].paymentTerms / .notes / .quoteMode). With no column they
--    would be UI-only state, which the port's definition of done forbids.
--    quote_mode is audit-relevant in its own right: it records HOW the number
--    was derived, so a reader can tell a vendor's grand total from the sum of
--    per-line prices.
--
-- 3. THE PER-LINE "DECLINED" CHECKBOX HAS NOWHERE TO GO.
--    The prototype's per-line table has a declined checkbox per line. The CS in
--    step 6 needs it: a vendor that will not supply one line must not be read
--    as a zero price for it.
--
-- Idempotent, additive. No destructive changes.

BEGIN;

-- ── 1 · backfill proc.rfq_lines from the PR's lines ─────────────────────────
-- description is NOT NULL on rfq_lines but nullable on pr_lines, so fall back
-- through the item name and finally to a positional label. Never leave ''.
INSERT INTO proc.rfq_lines (rfq_id, pr_line_id, line_no, description, quantity, uom)
SELECT rf.id,
       pl.id,
       pl.line_no,
       coalesce(pl.description, it.name, 'Line ' || pl.line_no),
       pl.quantity,
       pl.uom
  FROM proc.rfq rf
  JOIN proc.pr_lines pl ON pl.pr_id = rf.pr_id
  LEFT JOIN core.items it ON it.id = pl.item_id
 WHERE NOT EXISTS (SELECT 1 FROM proc.rfq_lines rl WHERE rl.rfq_id = rf.id)
ON CONFLICT (rfq_id, line_no) DO NOTHING;

-- ── 2 · the three missing quote columns ─────────────────────────────────────
ALTER TABLE proc.quotations
  ADD COLUMN IF NOT EXISTS payment_terms text,
  ADD COLUMN IF NOT EXISTS notes         text,
  ADD COLUMN IF NOT EXISTS quote_mode    text;

-- The prototype's two entry modes (lightProcReceiveQuote's mode selector):
-- 'total' = one grand-total figure, 'per_line' = priced against each RFQ line.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'quotations_quote_mode_check'
  ) THEN
    ALTER TABLE proc.quotations
      ADD CONSTRAINT quotations_quote_mode_check
      CHECK (quote_mode IS NULL OR quote_mode IN ('total','per_line'));
  END IF;
END $$;

COMMENT ON COLUMN proc.quotations.payment_terms IS
  'Prototype: quoteLines[vid].paymentTerms — free text, e.g. "30 days net", "50% advance".';
COMMENT ON COLUMN proc.quotations.notes IS
  'Prototype: quoteLines[vid].notes — the vendor''s own remarks on the quote.';
COMMENT ON COLUMN proc.quotations.quote_mode IS
  'How the figure was derived: ''total'' (one grand total) or ''per_line'' (sum of RFQ lines). '
  'Audit-relevant: a reader must be able to tell a stated grand total from a computed line sum.';

-- ── 3 · REPAIR THE BROKEN PER-LINE FOREIGN KEY ─────────────────────────────
-- THE BIG ONE. proc.quotation_lines carried this composite constraint:
--
--   FOREIGN KEY (quotation_id, rfq_line_no) REFERENCES rfq_lines(rfq_id, line_no)
--
-- while the SAME column also carried
--
--   FOREIGN KEY (quotation_id) REFERENCES quotations(id) ON DELETE CASCADE
--
-- Those two are mutually unsatisfiable. The first demands
-- quotation_lines.quotation_id == rfq_lines.rfq_id; the second demands it be
-- quotations.id. A quotation's id and its RFQ's id are never equal, so EVERY
-- per-line quote insert died with:
--
--   violates foreign key constraint "quotation_lines_quotation_id_rfq_line_no_fkey"
--   DETAIL: Key (quotation_id, rfq_line_no)=(c84ca20a-…, 1) is not present in
--           table "rfq_lines".
--
-- The intent of the composite FK was sound — a quote line must reference a
-- line that actually exists on its own RFQ — but it cannot be expressed
-- without the RFQ's id, which the table did not carry. So add it, and rebuild
-- the constraint against the column that means what the FK needs.
ALTER TABLE proc.quotation_lines
  ADD COLUMN IF NOT EXISTS rfq_id uuid;

-- Drop orphans first so the backfill and the NOT NULL cannot fail.
DELETE FROM proc.quotation_lines ql
 WHERE NOT EXISTS (SELECT 1 FROM proc.quotations q WHERE q.id = ql.quotation_id);

UPDATE proc.quotation_lines ql
   SET rfq_id = q.rfq_id
  FROM proc.quotations q
 WHERE q.id = ql.quotation_id AND ql.rfq_id IS NULL;

-- And drop any line whose rfq has no matching line_no, which the old (broken)
-- FK was supposed to prevent.
DELETE FROM proc.quotation_lines ql
 WHERE NOT EXISTS (
   SELECT 1 FROM proc.rfq_lines rl
    WHERE rl.rfq_id = ql.rfq_id AND rl.line_no = ql.rfq_line_no);

ALTER TABLE proc.quotation_lines
  ALTER COLUMN rfq_id SET NOT NULL;

ALTER TABLE proc.quotation_lines
  DROP CONSTRAINT IF EXISTS quotation_lines_quotation_id_rfq_line_no_fkey;

-- Idempotency: ADD CONSTRAINT has no IF NOT EXISTS, so a second run of this
-- migration died with `constraint "quotation_lines_rfq_line_fkey" already
-- exists`. migrate.ps1 re-applies every migration in order, so that made a
-- plain `npm run db:migrate` report FAIL on any already-migrated database —
-- which is how a real migration failure stops being visible. Same
-- DROP IF EXISTS guard as the statement above, for the constraint this
-- migration is replacing.
ALTER TABLE proc.quotation_lines
  DROP CONSTRAINT IF EXISTS quotation_lines_rfq_line_fkey;

ALTER TABLE proc.quotation_lines
  ADD CONSTRAINT quotation_lines_rfq_line_fkey
  FOREIGN KEY (rfq_id, rfq_line_no) REFERENCES rfq_lines(rfq_id, line_no);

COMMENT ON COLUMN proc.quotation_lines.rfq_id IS
  'The RFQ this line prices against. Needed because (rfq_id, rfq_line_no) is what '
  'identifies a line on rfq_lines — quotation_id cannot stand in for it, since a '
  'quotation id and its RFQ id are different values.';

-- ── 4 · per-line declined flag + remarks ────────────────────────────────────
-- The prototype's per-line table has BOTH a declined checkbox and a free-text
-- remarks box per line (v1.9.x-recv-quote). Neither had a column: without
-- remarks the service's line INSERT fails with
--   column "remarks" of relation "quotation_lines" does not exist
ALTER TABLE proc.quotation_lines
  ADD COLUMN IF NOT EXISTS declined boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS remarks text;

COMMENT ON COLUMN proc.quotation_lines.declined IS
  'Prototype: the per-line "declined" checkbox. TRUE means the vendor will not supply '
  'this line at all — NOT a zero price. The CS must not read a declined line as PKR 0.';
COMMENT ON COLUMN proc.quotation_lines.remarks IS
  'Prototype: the per-line remarks box, e.g. "out of stock", "alternate model offered". '
  'Per-line, so it is NOT the same as quotations.notes which is quote-wide.';

COMMIT;
