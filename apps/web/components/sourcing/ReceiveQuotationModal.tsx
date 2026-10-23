// ReceiveQuotationModal — record a vendor's quotation against an issued RFQ.
//
// TRANSLATED from the officer's HTML prototype. Tailwind utility classes became
// the .rq-* classes in styles/globals.css so the form inherits the app's design
// tokens instead of hard-coding greys. Column order is preserved exactly:
//
//   item | description | category | qty | unit price | gross | disc | net | tax % | tax amt | TOTAL | warranty
//
// DERIVED VALUES ARE NOT STORED. Gross, net and line total come from
// components/sourcing/quoteMath, which is the browser's mirror of the server's
// `quoteLineWaterfall`, and the payload still carries only the RATES (unit
// price, disc %, tax %). Accepting a derived figure from the client would let a
// stale screen persist a total that disagrees with its own inputs, and that gap
// would surface later as an unexplained difference in the comparative statement.
//
// DISC AMOUNT and TAX AMOUNT ARE NOW ALSO TYPEABLE, which is not the same thing.
// A vendor's sheet states "2,360 off", not "10%", and making the officer convert
// is how a 10% discount becomes 11%. Typing into those two cells converts the
// amount into the rate beside it immediately (see `setDiscAmount` /
// `setTaxAmount`) and the waterfall then derives the amount back out of it. Both
// directions converge on the single rate that is sent and stored, so there is
// still exactly one source of truth — the amounts are an entry point into it,
// not a second one.
//
// A rate is held at 0-100. Past 100 a discount stops being a discount and a line
// total goes negative, which would then travel into the comparative statement
// and the award recommendation as if it were a real price.
//
// HEADER LAYOUT — WHY EVERYTHING IS UP THERE
// ------------------------------------------
// The vendor fields, the document, the discount options and the tax-inclusive
// switch all live in one banner, and the banner collapses.
//
// They used to be spread over two control strips and a separate section bar
// between the header and the grid — roughly 190px of chrome before a single
// line of pricing was visible. On a laptop that left the grid about five rows
// tall, so recording a 12-item RFQ meant scrolling a list to find the line you
// were on. The banner now carries the identity, the decision (replace vs
// revise), the document, the discount/tax options, the remarks and the actions,
// and it folds to a single line to hand the whole screen to the grid.
//
// Folding does NOT hide who you are editing. A collapsed header still names the
// vendor, the version and the running total, because an officer who collapses
// the banner and then types into the wrong vendor's quotation would not notice
// until after saving. That summary is the whole reason collapsing is safe here.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, uploadFile } from '../../lib/api';
import { round2, waterfall, EMPTY, taxModeNote, sanitizeRate, sanitizePercent, discountBaseOf, taxBaseOf, discountPercentFromAmount, taxPercentFromAmount, type Waterfall } from './quoteMath';
import { quotationColumns, footLabelSpan, type ColumnKey } from './quoteColumns';

/**
 * Why a revision is unavailable, in the officer's terms.
 *
 * The point of naming the route is that there ISN'T one in this screen. An
 * officer who hits a locked revision and is told only "not allowed" will go
 * looking for the switch that turns it on. Saying the remedy is an email to
 * Vendor Master tells them the control is deliberate and where it lives, and it
 * keeps the audit trail outside the app — which is the whole reason the rule is
 * enforced here rather than left to the officer's judgement.
 */
const REVOCATION_HINT =
  'This vendor has been removed from a category they had already quoted. '
  + 'Their recorded quotation stays valid history, but no revision can be added. '
  + 'To proceed, ask Vendor Master to reactivate the mapping — there is no override here.';

type PrLine = {
  line_no: number;
  item_code: string;
  item_name: string;
  resolved_category: string;
  quantity: number;
  uom: string;
  rejected: boolean;
};

type VendorRow = {
  vendor_id: string;
  vendor_code: string;
  vendor_name: string;
  /**
   * The RFQ line numbers this vendor was actually invited to price — the lines
   * whose category they are actively mapped to.
   *
   * Optional, and `undefined` means "coverage not reported", which the form
   * treats as "not restricted". That is the safe direction: an older API then
   * over-permits rather than locking every row and making the form unusable.
   * An explicit `[]` is honoured, because that is a real answer — invited, but
   * no longer mapped to anything on this RFQ.
   */
  quotable_lines?: number[];
  active: {
    id: string;
    version: number;
    lead_time_days: number | null;
    payment_terms: string | null;
    notes: string | null;
    taxes_included: boolean;
    /**
     * The RFQ lines this live version priced.
     *
     * Purely informational. Its only job is to let the form say the accurate
     * thing about a locked line: "you were never invited for this category" and
     * "you quoted this, and the mapping has since been removed" are different
     * events with different remedies, and collapsing them into one greyed row
     * makes a management decision look like a broken form.
     *
     * Nothing here revalidates the quotation against the CURRENT mapping — that
     * would let a vendor un-mapping retroactively invalidate a stored quote.
     */
    line_nos?: number[];
  } | null;
};

type RfqLine = {
  line_no: number;
  description: string | null;
  quantity: number | null;
  uom: string | null;
};

type QuotesPayload = {
  rfq: { id: string; rfq_number: string; state: string; currency: string };
  vendors: VendorRow[];
  lines: RfqLine[];
  totals: { received: number; invited: number; pending: number; text: string };
};

type Currency = { currency: string; rate_to_pkr: number; effective_date: string };

type Row = {
  no: number;
  unit: string;
  disc: string;
  tax: string;
  warranty: string;
  declined: boolean;
};

/** A Row once its quantities and money are computed — what every body cell reads. */
type PricedRow = Row & {
  qty: number;
  p: Waterfall;
  /**
   * The selected vendor was not invited to price this line, because they are
   * not mapped to its category. Derived, never stored: it changes the instant a
   * different vendor is picked, and a stored flag would outlive the vendor that
   * set it.
   *
   * A locked row is worth nothing — empty waterfall, excluded from the totals,
   * absent from the payload — and every input on it is disabled.
   */
  locked: boolean;
  /**
   * This vendor's LIVE quotation already priced this line — so if the row is
   * also `locked`, the lock is a management change made AFTER they quoted, not
   * an absence of invitation. Drives the wording, never the arithmetic.
   */
  wasQuoted: boolean;
  /**
   * The figure the DISCOUNT is taken off — gross, or gross + tax after tax.
   * Zero means there is nothing to take a percentage of yet (no unit price), and
   * the discount amount cell is disabled rather than accepting a keystroke it
   * would have to throw away.
   */
  discBase: number;
  /** Whether a tax amount typed in this row can be converted back to a rate. */
  taxDerivable: boolean;
};

const money = (n: number) =>
  n.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function ReceiveQuotationModal({
  prId, prNumber, lines, onClose, onSaved,
}: {
  prId: string;
  prNumber: string;
  lines: PrLine[];
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [q, setQ] = useState<QuotesPayload | null>(null);
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   * Whether the banner is folded to a single line.
   *
   * It is state, not CSS, because the grid's max-height has to change with it:
   * a folded header that did not actually hand back its pixels would collapse
   * the fields and leave the grid exactly as short, which looks like the button
   * is broken.
   */
  const [folded, setFolded] = useState(false);

  const [vendorId, setVendorId] = useState('');
  const [currency, setCurrency] = useState('');
  const [lead, setLead] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [terms, setTerms] = useState('');
  const [notes, setNotes] = useState('');

  const [file, setFile] = useState<File | null>(null);
  const [useDiscount, setUseDiscount] = useState(true);
  const [basis, setBasis] = useState<'before_tax' | 'after_tax'>('before_tax');
  const [inclusive, setInclusive] = useState(false);

  const [rows, setRows] = useState<Row[]>([]);
  const [asRevision, setAsRevision] = useState(true);
  const [reason, setReason] = useState('');

  /**
   * The revision reason lives in its own dialog, opened by SAVE — not by the
   * version radios.
   *
   * It used to be an inline bar that appeared the moment a radio was touched,
   * which meant the form reflowed under the officer mid-edit and the reason box
   * sat far from the Save button it belongs to. Asking at the moment of commit
   * puts the question and the answer together, and makes it structurally
   * impossible to reach Save with a revision chosen and no reason.
   */
  const [askReason, setAskReason] = useState(false);

  /**
   * A REVISION may be saved without the vendor's document.
   *
   * The first version always needs one — it is the only record of what was
   * actually quoted. On a revision the officer is usually recording what the
   * vendor said on the phone, and insisting on a scan there does not improve the
   * audit trail; it produces a dummy file, which is worse than no file because it
   * reads as evidence.
   *
   * So the form asks rather than refuses: confirm, and the revision REASON becomes
   * the mandatory record in the document's place. The server enforces the same
   * rule independently — this flag is a request, not the authority.
   */
  const [askNoAttachment, setAskNoAttachment] = useState(false);
  const [allowNoAttachment, setAllowNoAttachment] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);

  const quoteLines = useMemo(() => lines.filter(l => !l.rejected), [lines]);
  const rfqByNo = useMemo(() => new Map((q?.lines || []).map(l => [l.line_no, l])), [q]);

  // Quantity comes from the RFQ when it is there, and from the PR line as a
  // fallback: the RFQ is what the vendors were asked to price, so its quantity
  // is the authority for what a "unit price" multiplies.
  const qtyOf = useMemo(
    () => new Map(quoteLines.map(l => [
      l.line_no,
      Number(rfqByNo.get(l.line_no)?.quantity ?? l.quantity) || 0,
    ])),
    [quoteLines, rfqByNo],
  );

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [qr, cr] = await Promise.all([
          api.get<QuotesPayload>(`/pr/${prId}/quotes`),
          api.get<Currency[]>('/lookups/currencies'),
        ]);
        if (!live) return;
        setQ(qr.data);
        setCurrencies(cr.data);
        // Default currency is the RFQ's own, and the officer picks from the
        // master list — never a hard-coded PKR.
        setCurrency(qr.data.rfq.currency || cr.data[0]?.currency || 'PKR');
        const pending = qr.data.vendors.find(v => !v.active);
        setVendorId((pending || qr.data.vendors[0])?.vendor_id || '');
      } catch (e: any) {
        if (live) setErr(e.message || 'Could not load the quotations on this RFQ.');
      }
    })();
    return () => { live = false; };
  }, [prId]);

  useEffect(() => {
    setRows(quoteLines.map(l => ({
      no: l.line_no, unit: '', disc: '', tax: '', warranty: '', declined: false,
    })));
    setNotes(''); setReason(''); setFile(null); setErr('');
    if (fileRef.current) fileRef.current.value = '';
  }, [vendorId, quoteLines]);

  const vendor = q?.vendors.find(v => v.vendor_id === vendorId);
  const existing = vendor?.active || null;

  useEffect(() => {
    if (!existing) { setAsRevision(false); return; }
    setLead(existing.lead_time_days === null ? '' : String(existing.lead_time_days));
    setTerms(existing.payment_terms || '');
    setNotes(existing.notes || '');
    setInclusive(existing.taxes_included === true);
    setAsRevision(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorId]);

  const setRow = (no: number, patch: Partial<Row>) =>
    setRows(rs => rs.map(r => (r.no === no ? { ...r, ...patch } : r)));

  /**
   * The discount basis actually applied.
   *
   * A tax-inclusive rate leaves nothing to choose: the price already contains
   * the tax, so the discount comes off the quoted amount and "before tax" is
   * the only meaning it can have. Normalising here — rather than at the point of
   * submission — keeps the grid, the note and the stored discount_basis telling
   * the same story. The API normalises too, so a hand-crafted client that posts
   * after_tax + taxesIncluded lands on the same figures.
   */
  const activeBasis: 'before_tax' | 'after_tax' = inclusive ? 'before_tax' : basis;

  /**
   * THE LINES THIS VENDOR MAY PRICE.
   *
   * An invitation names a vendor, not a line, so the lines a vendor is on the
   * RFQ to answer for are the lines whose CATEGORY they are mapped to. Without
   * this the form let one vendor price all four lines of a four-category RFQ,
   * and a quote recorded against a category the vendor was never invited for
   * reads in the comparative statement exactly like a real bid. Nothing later
   * could tell the two apart.
   *
   * `undefined` (older API) means unrestricted — see the field comment. An
   * empty array is a real answer and locks everything.
   */
  const quotableLines = vendor?.quotable_lines;
  const quotable = useMemo(
    () => (quotableLines === undefined ? null : new Set(quotableLines)),
    [quotableLines],
  );
  const isQuotable = (no: number) => quotable === null || quotable.has(no);

  /** Lines this vendor's live quotation already priced. Drives wording only. */
  const previouslyQuoted = useMemo(
    () => new Set(existing?.line_nos ?? []),
    [existing],
  );

  const priced = useMemo(
    () => rows.map(r => {
      const qty = qtyOf.get(r.no) || 0;
      // Locked rows contribute NOTHING — no waterfall, no totals, not submitted.
      // Treated exactly like a declined line, but for a different and much more
      // important reason: the officer was never asked for this price.
      const locked = !isQuotable(r.no);
      const discountPercent = useDiscount ? (Number(r.disc) || 0) : 0;
      const taxPercent = Number(r.tax) || 0;
      const p = (r.declined || locked)
        ? EMPTY
        : waterfall({
            unit: Number(r.unit) || 0, qty, discountPercent, taxPercent,
            taxesIncluded: inclusive, basis: activeBasis,
          });
      // The bases come from the SAME inputs as the waterfall, through the same
      // helpers the reverse conversions use — not recomputed here by hand. A
      // second implementation of "what is the discount taken off" is exactly
      // the drift these modules exist to prevent.
      return {
        ...r, qty, p, locked, wasQuoted: previouslyQuoted.has(r.no),
        discBase: (r.declined || locked) ? 0 : discountBaseOf({
          gross: p.gross, taxPercent, taxesIncluded: inclusive, basis: activeBasis,
        }),
        taxDerivable: !r.declined && !locked && taxBaseOf({
          gross: p.gross, discountPercent, taxesIncluded: inclusive, basis: activeBasis,
        }) > 0,
      };
    }),
    [rows, qtyOf, useDiscount, inclusive, activeBasis, quotable, previouslyQuoted],
  );

  const totals = priced.reduce(
    (a, r) => ({
      gross: round2(a.gross + r.p.gross), discount: round2(a.discount + r.p.discount),
      net: round2(a.net + r.p.net), tax: round2(a.tax + r.p.tax),
      total: round2(a.total + r.p.lineTotal),
    }),
    { gross: 0, discount: 0, net: 0, tax: 0, total: 0 },
  );

  // The rate the comparative statement ranks on. A PKR quote normalises to
  // itself; anything else is converted, and the normalised figure is what gets
  // compared across vendors.
  const fx = currencies.find(c => c.currency === currency)?.rate_to_pkr ?? 1;
  const normalized = round2(totals.total * fx);

  /**
 * TODAY, IN THE USER'S OWN TIMEZONE — not `toISOString().slice(0,10)`.
 *
 * That idiom is UTC. In PKT (UTC+5) every moment between 00:00 and 05:00 local
 * belongs to the PREVIOUS UTC day, so "today" would read as yesterday and a
 * officer picking today's date would be told their own quotation expired. For a
 * field whose entire job is comparing two calendar days, being off by one is
 * the whole bug.
 */
const today = (() => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();

const expired = !!validUntil && validUntil < today;

  /**
   * THE COLUMN ORDER — and the reason it is one value rather than three sets of
   * markup.
   *
   * "Discount after tax" moves the discount block past the tax block. If only
   * the `<th>`s moved, the grid would still render and would still look fine,
   * but the sticky totals row — which carries its own hard-coded colSpans — would
   * stay glued to the ORIGINAL columns and print "Column Totals" figures under
   * the wrong headings. That is the screen an officer reads to decide who is
   * cheapest, and nothing would report the mistake.
   *
   * So the header, every body row and the totals row are all rendered from this
   * one list (see components/sourcing/quoteColumns). `activeBasis`, not `basis`:
   * a tax-inclusive quote has already had its basis forced to before_tax, and
   * reordering around a rule that is not in force would be reordering fiction.
   */
  const cols = quotationColumns({ basis: activeBasis, useDiscount, currency });
  /** The figures the totals row prints, keyed by ColumnKey. */
  const footValue: Record<string, number> = {
    gross: totals.gross, discount: totals.discount, net: totals.net,
    tax: totals.tax, total: totals.total,
  };
  /**
   * How many leading columns the "Column Totals" caption absorbs.
   *
   * It stops at the first column that prints a figure — NOT at `length - 3`,
   * which is 11 of 14 and swallows Gross, Disc Amt, Net and Tax Amt. That was
   * the live bug this replaced: the caption still spanned the right number of
   * columns' worth of DOM, every row still had 14 cells, and the sticky totals
   * row quietly stopped being totals.
   */
  const footCaption = footLabelSpan(cols);

  /**
   * A rate field may only ever contain digits and at most one decimal point.
   *
   * `min={0}` stays on the element as well as the sanitiser: it is what makes
   * iOS and Android show a numeric keypad instead of the full keyboard. ZERO is
   * rejected at SAVE, not here, so that "0.50" remains typeable — see
   * `sanitizeRate` and `zeroRated`.
   *
   * The two PERCENTAGE fields additionally go through `sanitizePercent`, which
   * holds them at 100. A discount or a tax above 100 is not a rate — and left
   * alone it does something the officer would have to notice a column to see:
   * a 150% discount makes the line total NEGATIVE, which then travels into the
   * comparative statement and the award recommendation as a real number.
   */
  const setRate = (no: number, key: 'unit' | 'disc' | 'tax' | 'warranty', raw: string) => {
    const clean = key === 'disc' || key === 'tax' ? sanitizePercent(raw) : sanitizeRate(raw);
    setRow(no, { [key]: clean } as Partial<Row>);
  };

  /**
   * A DISCOUNT AMOUNT typed into the grid, converted back to the rate.
   *
   * Only the rate is stored — the payload is unchanged and still sends
   * `discountPercent`. This is an entry point into that one value, not a second
   * source of truth, so there is nothing for the server to reconcile later.
   *
   * A `null` means there is no gross yet, so no percentage can be implied; the
   * cell is disabled in that state, and clearing the field is the same as
   * entering zero — which is what the officer means by emptying it.
   */
  const setDiscAmount = (r: PricedRow, raw: string) => {
    const pct = discountPercentFromAmount({
      gross: r.p.gross,
      amount: Number(sanitizeRate(raw)) || 0,
      taxPercent: Number(r.tax) || 0,
      taxesIncluded: inclusive,
      basis: activeBasis,
    });
    if (pct === null) return;
    setRow(r.no, { disc: String(pct) });
  };

  /** A TAX AMOUNT typed into the grid, converted back to the rate. */
  const setTaxAmount = (r: PricedRow, raw: string) => {
    const pct = taxPercentFromAmount({
      gross: r.p.gross,
      discountPercent: useDiscount ? (Number(r.disc) || 0) : 0,
      amount: Number(sanitizeRate(raw)) || 0,
      taxesIncluded: inclusive,
      basis: activeBasis,
    });
    if (pct === null) return;
    setRow(r.no, { tax: String(pct) });
  };

  /**
   * Rates that are present but not usable, and blank lines that will not be sent.
   *
   * A line is recorded when it is DECLINED (the vendor will not supply it) or
   * PRICED. A line left entirely blank is neither, so it is not sent — recording
   * it as a 0.00 quote would read in the comparative statement as "this vendor
   * supplied it free", which is the opposite of "we do not have a price yet".
   *
   * `unitPrice <= 0` is refused server-side for any non-declined line, so a
   * typed 0 has to be caught here first with a message that names the line.
   */
  const quoted = useMemo(
    () => priced.filter(r => !r.locked && (r.declined || Number(r.unit) > 0)),
    [priced],
  );
  // Locked rows are neither "skipped" nor "quoted" — they were never on the
  // form. Counting them as skipped would warn the officer about blank lines they
  // are not allowed to fill, and counting them as priced would submit them.
  const skipped = useMemo(
    () => priced.filter(r => !r.locked && !r.declined && r.unit.trim() === ''),
    [priced],
  );
  const lockedRows = useMemo(() => priced.filter(r => r.locked), [priced]);

  /**
   * MANAGEMENT HAS REVOKED THIS VENDOR ON A LINE THEY ALREADY QUOTED.
   *
   * The stored quotation stays exactly where it is — readable, versioned, part of
   * the comparative statement. What is refused is any NEW write against it. The
   * business rule is that unmapping is immediate and total for forward work: if
   * a vendor is pulled from a category at 15:00 they cannot submit a revision
   * against their own earlier quote at 17:00, and there is no in-app override.
   *
   * Scoped to `wasQuoted` on purpose. A line that is merely locked and was never
   * quoted is not history being invalidated — it is a line they were not asked
   * about — so it locks the row without poisoning the whole revision.
   */
  const revokedHistory = !!existing && lockedRows.some(r => r.wasQuoted);
  const zeroRated = useMemo(
    () => priced.filter(r => !r.locked && !r.declined && r.unit.trim() !== '' && Number(r.unit) <= 0),
    [priced],
  );

  /** Every missing required field named at once, so one round trip fixes all. */
  function missingRequired(): string[] {
    const m: string[] = [];
    if (lead === '' || Number(lead) < 0) m.push('Lead Days');
    if (!validUntil) m.push('Valid Until');
    if (!terms.trim()) m.push('Payment Terms');
    // The document is required on a first quotation, and on a revision UNLESS
    // the officer has confirmed they want to save without it. Before that
    // confirmation this still blocks, which is deliberate: the warning has to be
    // shown, not skipped by a stale "missing fields" message.
    const isRevision = !!existing && asRevision;
    if (!file && !(isRevision && allowNoAttachment)) m.push('the vendor quotation document');
    return m;
  }
  const missing = missingRequired();

  /**
   * Everything except the revision reason has been validated.
   *
   * If this is a revision the reason is requested in a dialog and this returns
   * without writing; the dialog's own confirm calls back in with
   * `skipReasonPrompt`, which is what stops the prompt reopening itself.
   */
  async function save(skipReasonPrompt = false) {
    setErr('');
    if (!vendorId) return setErr('Select the vendor whose quotation you are recording.');
    // Zero and negative are the same refusal: a line that is not declined must
    // carry a price above zero. Named per line so one pass fixes them all.
    if (zeroRated.length) {
      const which = zeroRated.map(r => `line ${r.no}`).join(', ');
      return setErr(
        `Unit price must be greater than zero on ${which}. `
        + 'A line the vendor will not supply should be ticked Declined instead.',
      );
    }
    if (!quoted.length) {
      return setErr(
        'Enter a unit price on at least one line, or tick Declined on every line.',
      );
    }
    if (missing.length) {
      return setErr(`Required before saving: ${missing.join(', ')}.`);
    }
    if (revokedHistory) {
      return setErr(
        'This vendor has been removed from a category they had already quoted, '
        + 'so no revision can be recorded. The existing quotation stands as history. '
        + 'Ask Vendor Master to reactivate the mapping if this quote must progress.',
      );
    }
    if (expired) return setErr('This quotation has already expired. Correct the validity date before recording it.');
    // A past validity date is refused before anything is written, not merely
    // greyed. `expired` is a string compare on yyyy-mm-dd, which is correct only
    // because both sides are zero-padded ISO — it is not a Date parse.
    if (validUntil && validUntil < today) {
      return setErr(`Valid Until cannot be in the past (${validUntil} is before ${today}). Pick today or a future date.`);
    }
    // Belt and braces on the line lock. The inputs are disabled, but `quoted` is
    // built from `priced`, so a row that became locked while a price was already
    // typed (a vendor switched under a stale render) must not ride out in the
    // payload as a quote for a category this vendor was never invited for.
    const stray = quoted.filter(r => r.locked);
    if (stray.length) {
      return setErr(
        `Line ${stray.map(r => r.no).join(', ')} is not one this vendor was invited to price, `
        + 'so it cannot be included in the quotation.',
      );
    }

    if (!skipReasonPrompt && existing && asRevision) {
      // Confirm the missing document FIRST, then ask for the reason that stands
      // in its place. Reversing the order would collect a reason the officer may
      // then decline to proceed with.
      if (!file && !allowNoAttachment) {
        setAskNoAttachment(true);
        return;
      }
      setAskReason(true);
      return;
    }

    setBusy(true);
    try {
      // Upload FIRST, then record. The reverse order would leave a quotation
      // whose insert succeeded and whose document failed, and the insert is the
      // one that is hard to unwind — the version chain would carry a quote with
      // no evidence.
      let attachmentId: string | undefined;
      if (file) {
        const uj = await uploadFile(`/pr/${prId}/attachments`, file);
        attachmentId = uj.file_id || uj.attachment_id || uj.id;
      }

      const payload = {
        vendorId,
        quoteMode: 'per_line',
        currency,
        fxRate: fx,
        // activeBasis, not `basis`: a tax-inclusive quote has no basis to
        // record, and storing the hidden radio's value would put a rule on the
        // quotation that was never applied.
        discountBasis: activeBasis,
        taxesIncluded: inclusive,
        leadTimeDays: Number(lead),
        paymentTerms: terms.trim(),
        validUntil,
        notes: notes.trim() || undefined,
        attachmentId,
        // The server re-decides this. Sending it only records that the officer
        // was asked — the authority to save without a document lives in
        // insertQuotation, not in this form.
        allowMissingAttachment: allowNoAttachment ? true : undefined,
        // `quoted`, not `priced`: a line left entirely blank is neither priced
        // nor declined, so it is NOT recorded. Sending it as unitPrice 0 would
        // put a 0.00 row in the comparative statement, which reads as "this
        // vendor supplied it free" rather than "no price yet".
        lines: quoted.map(r => ({
          rfqLineNo: r.no,
          unitPrice: r.declined ? 0 : Number(r.unit),
          declined: r.declined,
          discountPercent: useDiscount ? (Number(r.disc) || 0) : 0,
          taxPercent: Number(r.tax) || 0,
          warrantyMonths: r.warranty === '' ? undefined : Number(r.warranty),
        })),
      };
      const res = existing && asRevision
        ? await api.post(`/quotations/${existing.id}/supersede`, { ...payload, reason: reason.trim() })
        : await api.post(`/rfq/${q!.rfq.id}/quotations`, payload);
      const v = res.data?.quotation?.version;
      onSaved(
        existing && asRevision
          ? `New revision V${v} saved for ${vendor!.vendor_name}. The previous version is preserved.`
          : `Quotation recorded from ${vendor!.vendor_name}.`,
      );
      onClose();
    } catch (e: any) {
      setErr(e.message || 'Could not save the quotation.');
    } finally {
      setBusy(false);
    }
  }

  if (!q) {
    return (
      <Overlay onClose={busy ? () => {} : onClose}>
        <div className="rq-head">
          <div>
            <h2>Receive Quotation — {prNumber}</h2>
          </div>
          <button className="rq-x" onClick={onClose} aria-label="Close" disabled={busy}>&times;</button>
        </div>
        <div className="rq-body">
          {err ? <div className="alert error">{err}</div> : <div className="empty-state">Loading…</div>}
        </div>
      </Overlay>
    );
  }

  return (
    <Overlay onClose={busy ? () => {} : onClose} folded={folded}>
      {/* ── top banner: identity, decision, document, options, actions ──── */}
      <div className={`rq-head${folded ? ' is-folded' : ''}`}>
        <div className="rq-head-top">
          <div className="rq-id">
            <h2>Receive Quotation — {prNumber}</h2>
            {!folded && (
              <div className="rq-sub">
                RFQ: {q.rfq.rfq_number} · {q.vendors.length} Vendors on RFQ · {q.totals.text}
              </div>
            )}
          </div>

          <div className="rq-head-actions">
            {/* The folded summary. This is NOT decoration: it is what makes
                collapsing safe. It answers "whose quote, which version, how
                much" in the same line the fields used to take three rows to
                answer, so the grid can be the only thing on screen. */}
            {folded && (
              <div className="rq-folded-sum" title="Expand the header to edit the quotation details">
                {vendor && <b>{vendor.vendor_name}</b>}
                {existing && (
                  <span className="rq-folded-v">
                    {asRevision ? `V${existing.version} → V${existing.version + 1}` : `replaces V${existing.version}`}
                  </span>
                )}
                {quoted.length > 0 && <span className="rq-folded-t">{currency} {money(totals.total)}</span>}
                {notes.trim() && <span className="rq-flag" title="Remarks entered (expand to see them)">remarks</span>}
                {/* Without this, a folded officer presses Save and is told four
                    fields are missing — fields they cannot see. */}
                {missing.length > 0 && (
                  <span className="rq-flag warn" title={missing.join(', ')}>
                    {missing.length} required field{missing.length > 1 ? 's' : ''} missing
                  </span>
                )}
              </div>
            )}

            {/* The version decision sits with the save button, so the officer sees what will
                happen before they commit. The revision path is disabled OUTRIGHT
                when management has revoked this vendor, not merely made hard to
                use: a greyed radio they can still click through to a save that
                fails is a worse experience than one that states the rule. */}
            {existing && !folded && (
              <div className="rq-vers">
                {revokedHistory ? (
                  <span className="rq-lock is-revoked" title={REVOCATION_HINT}>
                    Locked by management — no revision
                  </span>
                ) : (
                  <>
                    <label title={`Overwrite the numbers on V${existing.version}`}>
                      <input type="radio" name="rq-save" checked={!asRevision}
                        disabled={busy} onChange={() => setAsRevision(false)} />
                      {' '}Replace V{existing.version}
                    </label>
                    <label title={`Append V${existing.version + 1}; V${existing.version} is preserved`}>
                      <input type="radio" name="rq-save" checked={asRevision}
                        disabled={busy} onChange={() => setAsRevision(true)} />
                      {' '}New revision V{existing.version + 1}
                    </label>
                  </>
                )}
              </div>
            )}

            <button className="rq-btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
            {/* Arrow, not `onClick={save}`: the click handler would pass the React mouse
                event as `skipReasonPrompt`, which is truthy — so the revision
                reason would silently never be asked for. */}
            <button className="rq-btn primary" onClick={() => save()}
              disabled={busy || revokedHistory}
              title={revokedHistory ? REVOCATION_HINT : undefined}>
              {busy ? 'Saving…'
                : revokedHistory ? 'Locked by management'
                : existing && asRevision ? 'Save as new revision' : 'Save Quotation'}
            </button>
            <button
              className="rq-fold"
              onClick={() => setFolded(f => !f)}
              aria-expanded={!folded}
              aria-controls="rq-body"
              title={folded ? 'Expand the header (vendor, terms, document, options)' : 'Collapse the header for more rows'}
              disabled={busy}
            >
              <span aria-hidden="true">{folded ? '▴' : '▾'}</span>
              <span className="rq-sr">{folded ? 'Expand header' : 'Collapse header'}</span>
            </button>
            <button className="rq-x" onClick={onClose} aria-label="Close" disabled={busy}>&times;</button>
          </div>
        </div>

        {/* The one control bar. Everything the officer sets once for the whole
            quote — document, discount, tax treatment, remarks — sits on this
            line, in the order it is used: attach the evidence, decide the
            money, then note why. */}
        {!folded && (
          <div className="rq-head-bar">
            <div className="rq-toggles">
              <label>
                <input type="checkbox" checked={useDiscount} disabled={busy}
                  onChange={e => setUseDiscount(e.target.checked)} />
                Apply Discount
              </label>
              {useDiscount && !inclusive && (
                <span className="sep">
                  <label title="Tax is charged on the discounted amount">
                    <input type="radio" name="rq-basis" checked={basis === 'before_tax'}
                      disabled={busy} onChange={() => setBasis('before_tax')} />
                    Discount before tax
                  </label>
                  <label title="Tax is charged on the full amount, then the discount is taken off">
                    <input type="radio" name="rq-basis" checked={basis === 'after_tax'}
                      disabled={busy} onChange={() => setBasis('after_tax')} />
                    Discount after tax
                  </label>
                </span>
              )}
              <label title="Tick when the vendor's unit prices already include tax">
                <input type="checkbox" checked={inclusive} disabled={busy}
                  onChange={e => setInclusive(e.target.checked)} />
                Prices include tax
              </label>
            </div>

            <span className="rq-bar-sep" />

            {/* Remarks is a single-line input rather than a strip of its own.
                It used to sit in a full-width row above the grid and cost the
                officer ~70px to type something optional. */}
            <input
              type="text" className="rq-remarks" aria-label="Remarks"
              placeholder="Remarks (optional) — e.g. discount agreed on the call…"
              value={notes} disabled={busy} onChange={e => setNotes(e.target.value)}
            />

            <span className="rq-bar-sep" />

            {/* THE DOCUMENT CONTROL.
                The `<input type="file">` is still the real control — it is what
                carries the File object to uploadFile(), and it keeps keyboard
                access and the native picker — but it is hidden behind a real
                label. Its own ::file-selector-button is suppressed because its
                text is fixed by the browser: "Choose File", or the localised
                equivalent in the officer's language. CSS cannot change it, so
                the button you see is our markup and the browser's is gone.

                The required marker moves ONTO the button rather than sitting
                beside it as "document *", which said nothing the button did not
                already say and read as a stray label. */}
            <span className="rq-filewrap">
              <label className={`rq-upload${file ? ' has-file' : ''}`}
                htmlFor="rq-file"
                title={file ? `Replace ${file.name}` : 'Attach the vendor’s quotation document'}>
                <input id="rq-file" ref={fileRef} type="file" className="rq-file"
                  accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx"
                  disabled={busy}
                  aria-label="Vendor quotation document (required)"
                  onChange={e => setFile(e.target.files?.[0] || null)} />
                <span className="rq-upload-txt">
                  {file
                    ? <><span className="rq-tick">✓</span><span className="rq-filename">{file.name}</span></>
                    : <>Upload Quotation<b className="rq-req-star" title="Required before saving">*</b></>}
                </span>
              </label>
            </span>
          </div>
        )}
      </div>

      <div className="rq-body" id="rq-body">
        {err && <div className="alert error">{err}</div>}

        {/* Vendor and terms. Hidden when the banner is folded — that is the
            entire point of folding — which is why the folded summary above
            re-states the vendor. */}
        {!folded && (
          <div className="rq-strip">
            <div className="rq-sp4">
              <label className="lbl" htmlFor="rq-vendor">Select Vendor <span className="req">*</span></label>
              {/* No "(Update · V3)" in the option text: the version decision is
                  the radio pair in the header, and repeating it here made the
                  dropdown read like a status field rather than a picker. */}
              <select id="rq-vendor" value={vendorId} disabled={busy || q.vendors.length === 0}
                onChange={e => setVendorId(e.target.value)}>
                {/* An explicit empty option. Without one a controlled <select>
                    whose value matches nothing renders as a blank box with an
                    invisible, unclickable state — which reads as a broken
                    control, not as "pick a vendor". A real RFQ has a roster, so
                    this only shows when the RFQ genuinely has no invitation. */}
                {q.vendors.length === 0 && (
                  <option value="">No vendor has been invited to this RFQ</option>
                )}
                {q.vendors.map(v => (
                  <option key={v.vendor_id} value={v.vendor_id}>{v.vendor_name}</option>
                ))}
              </select>
              {/* And the reason, in words. A disabled dropdown with no
                  explanation is the same dead end as a broken one. */}
              {q.vendors.length === 0 && (
                <div className="rq-hint-error">
                  This RFQ has no invited vendor, so there is nobody to record a
                  quotation from. Invite a vendor from the RFQ screen first.
                </div>
              )}
            </div>
            <div className="rq-sp2">
              <label className="lbl" htmlFor="rq-currency">Currency <span className="req">*</span></label>
              <select id="rq-currency" value={currency} disabled={busy}
                onChange={e => setCurrency(e.target.value)}>
                {currencies.map(c => (
                  <option key={c.currency} value={c.currency}>
                    {c.currency}{c.currency === 'PKR' ? '' : ` (${c.rate_to_pkr}/PKR)`}
                  </option>
                ))}
              </select>
            </div>
            <div className="rq-sp2">
              <label className="lbl" htmlFor="rq-lead">Lead Days <span className="req">*</span></label>
              <input id="rq-lead" className="rq-center" type="number" min={0} value={lead}
                disabled={busy} onChange={e => setLead(e.target.value.replace(/[^0-9.]/g, ''))} />
            </div>
            <div className="rq-sp2">
              <label className="lbl" htmlFor="rq-valid">Valid Until <span className="req">*</span></label>
              <input id="rq-valid" className="rq-center" type="date" value={validUntil}
                min={today}
                aria-invalid={expired ? 'true' : undefined}
                title={expired ? 'Validity cannot be in the past' : 'Quote valid until (today or later)'}
                disabled={busy} onChange={e => setValidUntil(e.target.value)} />
              {expired && <span className="rq-exp">Already expired</span>}
            </div>
            <div className="rq-sp2">
              <label className="lbl" htmlFor="rq-terms">Payment Terms <span className="req">*</span></label>
              <input id="rq-terms" type="text" placeholder="e.g. 30 Days Net" value={terms}
                disabled={busy} onChange={e => setTerms(e.target.value)} />
            </div>
          </div>
        )}

        {/* Placed directly above the grid, where the locked rows are. The row
            chip says WHAT happened; this says WHO did it and what to do, which
            is the difference between "this screen is broken" and "procurement
            controls decided this". Naming the remedy also removes the incentive
            to go looking for a switch that does not exist. */}
        {lockedRows.length > 0 && (
          <div className="rq-locked-banner" role="status">
            <b>
              {lockedRows.length} of {priced.length} line{priced.length === 1 ? '' : 's'} locked
            </b>{' '}
            for {vendor?.vendor_name}:{' '}
            {vendor?.vendor_code} is not currently mapped to{' '}
            {[...new Set(lockedRows.map(r =>
              quoteLines.find(x => x.line_no === r.no)?.resolved_category))]
              .filter(Boolean).join(', ')}.
            {revokedHistory && (
              <> They had already quoted these lines, so this is a change made
              after the fact — their recorded quotation remains valid, but it
              cannot be revised here.</>
            )}{' '}
            This is a Vendor Master control, not a fault on this screen. Ask
            Vendor Master to reactivate the mapping if this quote must move
            forward.
          </div>
        )}
        {/* the pricing grid — scrolls on both axes; header and totals stay put */}
        <div className={`rq-wrap${folded ? ' is-folded' : ''}`}>
          <table className="rq-tbl">
            <thead>
              <tr>
                {cols.map(c => (
                  <th key={c.key} className={c.cls}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {priced.map(r => {
                const l = quoteLines.find(x => x.line_no === r.no)!;
                const rf = rfqByNo.get(r.no);
                return (
                  <tr key={r.no} className={r.locked ? 'is-locked' : r.declined ? 'is-declined' : undefined}>
                    {/* One CELL PER COLUMN, built in `cols` order. The switch is
                        what reorders the grid when the basis radio changes; it is
                        a plain lookup so there is no second place to forget. */}
                    {cols.map(c => (
                      <td key={c.key} className={`${c.cls || ''} ${cellClass(c.key)}`.trim()}>
                        {cellFor(c.key, { r, l, rf, busy, setRow, setRate, setDiscAmount, setTaxAmount })}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                {/* The caption absorbs only the leading columns that carry no
                    figure; everything from Gross onwards gets its own cell,
                    taken from the SAME list as the header and the body. */}
                <td colSpan={footCaption} className="rq-lbl">Column Totals ({currency}):</td>
                {cols.slice(footCaption).map(c => (
                  <td key={c.key} className={[c.cls, c.grand ? 'rq-grand' : ''].filter(Boolean).join(' ')}>
                    {c.foot ? money(footValue[c.foot]) : ''}
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>

        {/* The comparative statement ranks on normalised PKR, so show the
            officer that figure whenever it differs from what they typed — and
            say which tax rule produced the Total column, because the columns
            look identical in both modes and only the arithmetic differs. */}
        <div className="rq-norm">
          <span>
            Normalised for the comparative statement:{' '}
            <b>PKR {money(normalized)}</b>
            {fx !== 1 && <span className="rq-mute"> ({currency} {money(totals.total)} × {fx})</span>}
          </span>
          <span className="rq-mute">{taxModeNote(inclusive, activeBasis)}</span>
          {/* Non-blocking, but the officer has to know WHICH lines are in the
              quotation. A blank line is silently omitted from the payload, and
              an omission nobody was told about is how a three-line quote ends
              up being read as a whole-RFQ quote. */}
          {skipped.length > 0 && (
            <span className="rq-skip">
              {skipped.length} of {priced.length} line{priced.length === 1 ? '' : 's'} left
              blank will <b>not</b> be recorded
              {skipped.length > 6 && ` (lines ${skipped.map(r => r.no).join(', ')})`}.
              Tick <b>Declined</b> on a line to record that the vendor will not supply it.
            </span>
          )}
        </div>
      </div>

      {/* ── missing document on a revision: asked, not refused ───────── */}
      {askNoAttachment && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(15,23,42,.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 85,
          }}
          onClick={e => { if (e.target === e.currentTarget) setAskNoAttachment(false); }}
        >
          <div
            role="dialog" aria-modal="true" aria-label="Missing attachment on a revised quotation"
            className="rq-modal-sm"
          >
            <div className="rq-modal-h">
              <h3>You are missing the attachment</h3>
              <button className="rq-x" onClick={() => setAskNoAttachment(false)} aria-label="Close" disabled={busy}>
                &times;
              </button>
            </div>
            <div className="rq-modal-b">
              <p className="text-sm text-mute" style={{ marginBottom: 10 }}>
                A revised quotation can be saved without the vendor&rsquo;s document — which is
                what you want when the change came from a phone call rather than a file.
                <b> The Remarks field will then be required</b>, and it becomes the record of
                why the numbers changed in place of the document.
              </p>
              <p className="text-sm text-mute" style={{ marginBottom: 0 }}>
                V{existing?.version} is preserved either way.
              </p>
            </div>
            <div className="rq-modal-f">
              <button className="btn" onClick={() => setAskNoAttachment(false)} disabled={busy}>
                Go back and attach it
              </button>
              <button
                className="btn primary"
                disabled={busy}
                onClick={() => {
                  setAllowNoAttachment(true);
                  setAskNoAttachment(false);
                  // Straight on to the reason step, which is now mandatory.
                  setAskReason(true);
                }}
              >
                Yes, save without it
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── revision reason: asked at the moment of commit ────────────── */}
      {askReason && (
        <div
          style={{
            position: 'fixed', inset: 0, background: 'rgba(15,23,42,.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 80,
          }}
          onClick={e => { if (e.target === e.currentTarget) setAskReason(false); }}
        >
          <div
            role="dialog" aria-modal="true" aria-label="Reason for the new revision"
            className="rq-modal-sm"
          >
            <div className="rq-modal-h">
              <h3>Why is this a new revision?</h3>
              <button className="rq-x" onClick={() => setAskReason(false)} aria-label="Close" disabled={busy}>
                &times;
              </button>
            </div>
            <div className="rq-modal-b">
              <p className="text-sm text-mute" style={{ marginBottom: 10 }}>
                {allowNoAttachment && (
                  <>
                    <b style={{ color: 'var(--danger)' }}>Required</b> — you confirmed this revision has no
                    document, so this is now the only record of what changed.{' '}
                  </>
                )}
                V{existing?.version} stays exactly as it is and V{existing ? existing.version + 1 : ''} is
                added alongside it. The reason is stored on the new version and is the only record of why
                the numbers changed.
              </p>
              <textarea
                autoFocus
                aria-label="Revision reason"
                placeholder="e.g. Vendor accepted a phone follow-up: 8% discount on the laptop line"
                value={reason}
                disabled={busy}
                onChange={e => setReason(e.target.value)}
                onKeyDown={e => {
                  // Enter commits. Without this the officer must find the button,
                  // and Ctrl+Enter inserts a newline in a textarea by default.
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (reason.trim().length >= 3) {
                      setAskReason(false);
                      save(true);
                    }
                  }
                }}
              />
              {reason.trim().length > 0 && reason.trim().length < 3 && (
                <span className="rq-exp">Give at least a few words.</span>
              )}
            </div>
            <div className="rq-modal-f">
              <button className="btn" onClick={() => setAskReason(false)} disabled={busy}>
                Back to the form
              </button>
              <button
                className="btn primary"
                disabled={busy || reason.trim().length < 3}
                onClick={() => { setAskReason(false); save(true); }}
              >
                {busy ? 'Saving…' : `Save as V${existing ? existing.version + 1 : ''}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </Overlay>
  );
}

/**
 * Extra classes on a body cell, beyond what the column model already carries.
 *
 * These are the presentational classes the model deliberately does not know
 * about: `rq-qty` tints the read-only quantity, `rq-desc`/`rq-cat` mute the
 * descriptive columns, `rq-tot` emboldens the line total. They go on the `<td>`
 * rather than a wrapper span, because the originals tinted the whole cell —
 * moving them inside would shrink the tint to the width of the text.
 */
function cellClass(key: ColumnKey): string {
  switch (key) {
    case 'desc': return 'rq-desc';
    case 'cat': return 'rq-cat';
    case 'qty': return 'rq-qty';
    // Gross and Net stay inert. Disc Amt and Tax Amt no longer do — they became
    // entry points for the rate beside them, so the read-only tint has to go
    // with it, or the officer types into a field that looks derived.
    case 'gross': case 'net': return 'rq-ro';
    case 'total': return 'rq-tot';
    default: return '';
  }
}

type RowCtx = {
  r: PricedRow;
  l: PrLine;
  rf: RfqLine | undefined;
  busy: boolean;
  setRow: (no: number, patch: Partial<Row>) => void;
  /** Strips anything that is not a digit or a single decimal point. */
  setRate: (no: number, key: 'unit' | 'disc' | 'tax' | 'warranty', raw: string) => void;
  /** A typed discount amount, converted back into the discount rate. */
  setDiscAmount: (r: PricedRow, raw: string) => void;
  /** A typed tax amount, converted back into the tax rate. */
  setTaxAmount: (r: PricedRow, raw: string) => void;
};

/** The body content for one column of one line. */
function cellFor(key: ColumnKey, { r, l, rf, busy, setRow, setRate, setDiscAmount, setTaxAmount }: RowCtx): React.ReactNode {
  switch (key) {
    case 'item':
      return (
        <>
          <span className="rq-item">{l.item_name}</span>
          <span className="rq-code">{l.item_code}</span>
        </>
      );
    case 'desc':
      // From the RFQ, not the PR: proc.pr_lines.description is NULL for every
      // catalogue line, so the PR could only ever show a category here.
      return rf?.description || <span className="rq-mute">—</span>;
    case 'cat':
      // The category cell also carries WHY the row is locked, when it is. This
      // is the column that already names the category, so the reason lands next
      // to the thing it is about rather than in a banner the officer has to
      // correlate back to a line number by hand.
      return (
        <>
          {l.resolved_category}
          {r.locked && (
            <span
              className={`rq-lock${r.wasQuoted ? ' is-revoked' : ''}`}
              title={
                r.wasQuoted
                  ? 'This vendor quoted this line, and has since been removed from the category. '
                    + 'That is a vendor-master control, not a fault on this screen.'
                  : 'This vendor is not mapped to this line’s category'
              }
            >
              {r.wasQuoted ? 'locked' : 'not invited'}
            </span>
          )}
        </>
      );
    case 'qty':
      return <>{r.qty} {l.uom}</>;
    case 'unit':
      return (
        <input className="rq-in unit" type="number" min={0} step="0.01"
          aria-label={`Unit price, line ${r.no}`}
          value={r.unit} disabled={busy || r.locked || r.declined}
          onChange={e => setRate(r.no, 'unit', e.target.value)} />
      );
    case 'gross':
      return money(r.p.gross);
    case 'discPct':
      return (
        <input className="rq-in disc" type="number" min={0} max={100} step="0.01"
          aria-label={`Discount percent, line ${r.no}`}
          value={r.disc} disabled={busy || r.locked || r.declined}
          onChange={e => setRate(r.no, 'disc', e.target.value)} />
      );
    case 'discAmt':
      // An amount the vendor's sheet states in rupees, typed straight in. It is
      // NOT stored — the rate beside it is, and the payload is unchanged — so
      // this reads back as a rate and the waterfall still does the arithmetic.
      // Disabled while there is no gross, because "10% of nothing" has no rate
      // and silently ignoring the keystroke would look like a dead field.
      return (
        <input className="rq-in amt disc-amt" type="number" min={0} step="0.01"
          aria-label={`Discount amount, line ${r.no}`}
          title="Type the discount in money, or in percent in the column beside it"
          value={r.p.discount ? String(r.p.discount) : ''}
          disabled={busy || r.locked || r.declined || !(r.discBase > 0)}
          onChange={e => setDiscAmount(r, e.target.value)} />
      );
    case 'net':
      return money(r.p.net);
    case 'taxPct':
      return (
        <input className="rq-in pct" type="number" min={0} max={100} step="0.01"
          aria-label={`Tax percent, line ${r.no}`}
          value={r.tax} disabled={busy || r.locked || r.declined}
          onChange={e => setRate(r.no, 'tax', e.target.value)} />
      );
    case 'taxAmt':
      // Same two-way contract as the discount amount. The base it divides into
      // depends on the basis and on whether the price already includes tax, so
      // the conversion is done by taxPercentFromAmount rather than here — and a
      // tax amount that cannot be converted (nothing priced yet) leaves the rate
      // exactly as it was instead of overwriting it with a zero.
      return (
        <input className="rq-in amt tax-amt" type="number" min={0} step="0.01"
          aria-label={`Tax amount, line ${r.no}`}
          title="Type the tax in money, or in percent in the column beside it"
          value={r.p.tax ? String(r.p.tax) : ''}
          disabled={busy || r.locked || r.declined || !r.taxDerivable}
          onChange={e => setTaxAmount(r, e.target.value)} />
      );
    case 'total':
      return money(r.p.lineTotal);
    case 'warr':
      return (
        <input className="rq-in warr" type="number" min={0} step="1"
          aria-label={`Warranty months, line ${r.no}`}
          value={r.warranty} disabled={busy || r.locked || r.declined}
          onChange={e => setRate(r.no, 'warranty', e.target.value)} />
      );
    case 'decl':
      // Locked too: "will not supply" is an answer to a question the vendor was
      // never asked. Recording a decline here would put a refusal for someone
      // else's category into this vendor's quotation.
      return (
        <input type="checkbox" checked={r.declined} disabled={busy || r.locked}
          aria-label={`Vendor declines line ${r.no}`}
          onChange={e => setRow(r.no, { declined: e.target.checked })} />
      );
    default: {
      const never: never = key;
      return never;
    }
  }
}

function Overlay({
  children, onClose, folded,
}: { children: React.ReactNode; onClose: () => void; folded?: boolean }) {
  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 70, padding: 16,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog" aria-modal="true" aria-label="Receive Quotation"
        className={`rq-dialog${folded ? ' is-folded' : ''}`}
      >
        {children}
      </div>
    </div>
  );
}