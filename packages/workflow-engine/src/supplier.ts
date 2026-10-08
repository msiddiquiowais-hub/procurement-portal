// Supplier-facing logic — port of the prototype's renderSupplierInbox
// (PROCUREMENT_PORTAL_PROTOTYPE.html:9001-9035), renderSupplierQuote
// (:9037-9070), quoteRecalc (:7312-7340) and supplierSubmitQuote
// (:7342-7358).
//
// PURE. No I/O, no dates from the clock, no randomness. Everything here is a
// function of its arguments so the API (step 2) and the renderer (step 4)
// cannot disagree about a total, a status or a string.
//
// Wave 4 step 1. The blockers this depends on cleared in migration 028:
//   B1  core.users.vendor_id — how a supplier session is scoped to one vendor
//   B2  core.vendor_applications — public onboarding intake
//   B6  rfq_invitations.token_hash — retained but INERT (W4-3)
//
// ── Three places this deliberately diverges from the prototype ──────────────
//
// 1. NO SEALED BID (decision Q2, confirmed W4-2). The prototype says "Your
//    quote is sealed until the buyer closes the RFQ" and renders a "Closing in
//    7 days" countdown. Both are false: no sealing was implemented and no timer
//    may run. SUPPLIER_VISIBILITY_NOTE replaces the false sentence and
//    INBOX_DUE_LABEL replaces the countdown with the real deadline.
//
// 2. NO PRE-FILLED UNIT PRICE. The prototype computes
//    `Math.round(base / totalQty)` and drops that in every unit-price box
//    (renderSupplierQuote:9040). That is a guess dressed as a quote, and
//    submitting it would create a fabricated price in the audit trail. The port
//    starts empty; see quoteLineTotals().
//
// 3. PKR FORMATTING IS THE PROTOTYPE'S, NOT THE WEB APP'S. fmtPKR() below is a
//    faithful port of the prototype's abbreviating ladder (Cr / L / K). The
//    already-ported screens use pkr() in apps/web/lib/ui.tsx, which prints
//    full digits. They are different functions on purpose — these two screens
//    are being ported, so they get the prototype's format. Do not "unify" them.

import type { Role } from './types';

// ─── Money ──────────────────────────────────────────────────────────────────

/**
 * The prototype's fmtPKR (:7363-7368), ported verbatim.
 *
 *   >= 10,000,000  ->  PKR 21.80 L ... no: PKR 2.18 Cr   (2 dp)
 *   >=    100,000  ->  PKR 21.8 L                        (1 dp)
 *   >=      1,000  ->  PKR 21.8 K                        (1 dp)
 *   otherwise      ->  PKR 21,800
 *
 * `toLocaleString()` is pinned to 'en-US'. The prototype relies on the browser
 * locale, which would make this function's output depend on the machine it ran
 * on — unacceptable for a value that reaches a database and an audit trail.
 */
export function fmtPKR(n: number | string | null | undefined): string {
  const v = Number(n);
  // The prototype would print "PKR NaN" here. An engine that feeds a
  // financial record should not be able to.
  if (!Number.isFinite(v)) return 'PKR 0';
  if (v >= 10000000) return `PKR ${(v / 10000000).toFixed(2)} Cr`;
  if (v >= 100000) return `PKR ${(v / 100000).toFixed(1)} L`;
  if (v >= 1000) return `PKR ${(v / 1000).toFixed(1)} K`;
  return `PKR ${v.toLocaleString('en-US')}`;
}

// ─── Types ──────────────────────────────────────────────────────────────────

/** One RFQ line as the supplier sees it. Never carries a price until entered. */
export type SupplierQuoteLine = {
  /** RFQ line number — the join key back to proc.rfq_lines.line_no. */
  lineNo: number;
  sku: string;
  description: string;
  qty: number;
  uom: string;
  /**
   * What the vendor has typed. `null` / `undefined` / `''` means NOT ENTERED —
   * which is distinct from 0 and must never be coerced to 0 (see quoteLineTotals).
   */
  unitPrice?: number | string | null;
};

/** One row of the inbox's "Invited vendors on this RFQ" table. */
export type SupplierRosterRow = {
  vendorId: string;
  legalName: string;
  /** True for the row representing the signed-in supplier. */
  isMe: boolean;
  status: SupplierQuoteStatus;
  pill: SupplierPill;
  /** 'Quote received' | 'Awaiting' — the prototype derives this from the pill. */
  coverage: string;
};

/** Prototype's `status` on a roster row: 'not started' | 'submitted' | 'declined'. */
export type SupplierQuoteStatus = 'not started' | 'submitted' | 'declined';

/** Prototype's `pill` CSS modifier: 'draft' | 'approved' | (declined). */
export type SupplierPill = 'draft' | 'approved' | 'danger';

/** What the API knows about one invitation, scoped to the signed-in vendor. */
export type SupplierInvitation = {
  invitationId: string;
  rfqId: string;
  rfqNumber: string;
  rfqTitle: string;
  issuedAt: string | null;
  deadlineAt: string | null;
  /** The buyer's real estimate for the underlying PR, in PKR. */
  estimatedAmount: number | null;
  /** True when this vendor has already declined. */
  declined: boolean;
  /** The vendor's current ACTIVE quote version, if any. */
  myQuote: { version: number; state: string } | null;
  /** Every vendor invited to this RFQ, including me. */
  roster: Array<{
    vendorId: string;
    legalName: string;
    submitted: boolean;
    declined: boolean;
  }>;
};

// ─── Inbox KPIs ─────────────────────────────────────────────────────────────

/**
 * The 4-up KPI band (renderSupplierInbox:9009-9014). Every value is COMPUTED.
 *
 * The prototype hardcodes `1` / `No` / `2` / `PKR 21.8 L`; none of them mean
 * anything. Per W4 §6:
 *   Active RFQs         = how many invitations are still open to me
 *   Quoted by me        = yes/no, with my current version when yes
 *   Competitors quoted  = submitted-of-invited, never a bare count
 *   Est. value          = the buyer's real estimate, never a fallback literal
 */
export type InboxKpi = {
  label: string;
  value: string;
  sub: string;
  /** Presentation hint for the renderer; the prototype inlines a style string. */
  tone?: 'warn';
};

export function inboxKpis(invitations: SupplierInvitation[]): InboxKpi[] {
  const open = invitations.filter(i => !i.declined);

  // Active RFQs. The prototype's sub-label is the due date of THE rfq; with a
  // list of them, the nearest deadline is the one a supplier can act on.
  let due = '—';
  const dates = open
    .map(i => i.deadlineAt)
    .filter((d): d is string => !!d)
    .sort();
  if (dates.length) due = formatDay(dates[0]);

  // Quoted by me. 'No' + 'Action required' is the prototype's verbatim pair
  // (and the only state it happens to render). 'Yes' + the version number is
  // the necessary complement; a KPI that can only show one value is not a KPI.
  const quoted = open.filter(i => i.myQuote);
  const quotedValue = quoted.length ? 'Yes' : 'No';
  const quotedSub = quoted.length
    ? `V${Math.max(...quoted.map(i => i.myQuote!.version))}`
    : 'Action required';

  // Competitors quoted — "of N invited", so the supplier can see the field size.
  //
  // The denominator counts EVERYONE who was invited, including vendors who have
  // since declined. "Invited" is a fact about the past and does not shrink when
  // somebody walks away: a supplier reading "0 of 3" when two of the three were
  // asked is being told the size of the field, while "0 of 2" would hide that a
  // competitor was approached. The roster card lists the same set for the same
  // reason, and shows a declined vendor with a distinct 'declined' status rather
  // than pretending they were never asked.
  //
  // The NUMERATOR only counts a quote from a vendor who has not declined — a
  // vendor who declined and somehow holds a stale quote is not competing.
  const invited = open.reduce((n, i) => n + i.roster.length, 0);
  const submitted = open.reduce(
    (n, i) => n + i.roster.filter(r => r.submitted && !r.declined).length,
    0,
  );

  // Est. value. NO `|| 2180000` fallback — an unknown estimate shows as an
  // em-dash, because PKR 0 and PKR 2.18 L are both lies.
  const estimates = open.map(i => i.estimatedAmount).filter((v): v is number => Number.isFinite(Number(v)) && Number(v) > 0);
  const estValue = estimates.length ? fmtPKR(estimates.reduce((a, b) => a + b, 0)) : '—';

  return [
    { label: 'Active RFQs', value: String(open.length), sub: `Due ${due}` },
    {
      label: 'Quoted by me',
      value: quotedValue,
      sub: quotedSub,
      // The prototype colours the unanswered KPI var(--warn). Keep that.
      ...(quoted.length ? {} : { tone: 'warn' as const }),
    },
    { label: 'Competitors quoted', value: String(submitted), sub: `of ${invited} invited` },
    { label: 'Est. value', value: estValue, sub: 'Buyer estimate' },
  ];
}

// ─── Roster ─────────────────────────────────────────────────────────────────

/** Map one invitation's roster to display rows, marking the signed-in vendor. */
export function supplierRoster(
  invitation: SupplierInvitation,
  myVendorId: string,
): SupplierRosterRow[] {
  return invitation.roster.map(v => {
    const pill = vendorPill(v.submitted, v.declined);
    return {
      vendorId: v.vendorId,
      legalName: v.legalName,
      isMe: v.vendorId === myVendorId,
      status: vendorStatus(pill),
      pill,
      coverage: coverageFor(pill),
    };
  });
}

/**
 * Pill precedence: a DECLINED vendor is neither awaiting nor received. A vendor
 * who both submitted and then declined reads as declined, because that is the
 * state that stops the buyer counting their quote.
 */
export function vendorPill(submitted: boolean, declined: boolean): SupplierPill {
  if (declined) return 'danger';
  if (submitted) return 'approved';
  return 'draft';
}

export function vendorStatus(pill: SupplierPill): SupplierQuoteStatus {
  if (pill === 'approved') return 'submitted';
  if (pill === 'danger') return 'declined';
  return 'not started';
}

/** The prototype derives Coverage from the pill, not from a separate flag. */
export function coverageFor(pill: SupplierPill): string {
  return pill === 'approved' ? 'Quote received' : 'Awaiting';
}

// ─── Quote math ─────────────────────────────────────────────────────────────

/** True when a unit price has actually been entered. 0 IS a real price. */
export function isPriced(p: SupplierQuoteLine['unitPrice']): boolean {
  if (p === null || p === undefined || p === '') return false;
  return Number.isFinite(Number(p));
}

/**
 * Per-line totals and the running quote total — the pure half of the
 * prototype's quoteRecalc (:7312-7340).
 *
 * DIVergence from quoteRecalc, and the reason it matters: the prototype sums
 * whatever is typed, treating an empty box as 0, and paints that sum into
 * "Quote total". On a partially filled form that understates the quote and
 * looks like a real number. Here an unpriced line contributes `null` and the
 * TOTAL is `null` until every line is priced — so the card footer renders the
 * em-dash the plan requires rather than a partial sum dressed as a total.
 *
 * Returns `total: null` (not 0) precisely so the two states stay
 * distinguishable all the way to the renderer.
 */
export function quoteLineTotals(lines: SupplierQuoteLine[]): {
  lineTotals: Array<number | null>;
  total: number | null;
  complete: boolean;
  pricedCount: number;
} {
  const lineTotals = lines.map(l => (isPriced(l.unitPrice) ? Number(l.unitPrice) * (Number(l.qty) || 0) : null));
  const complete = lines.length > 0 && lineTotals.every(t => t !== null);
  const total = complete ? lineTotals.reduce<number>((a, b) => a + (b as number), 0) : null;
  return { lineTotals, total, complete, pricedCount: lineTotals.filter(t => t !== null).length };
}

/** A single line's total, or null when unpriced. */
export function quoteLineTotal(line: SupplierQuoteLine): number | null {
  return isPriced(line.unitPrice) ? Number(line.unitPrice) * (Number(line.qty) || 0) : null;
}

/** Renders a money value or the em-dash the plan requires for an absent one. */
export function moneyOrDash(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(Number(n)) ? '—' : fmtPKR(n);
}

// ─── Commercial terms (prototype select options, verbatim) ───────────────────

export const SUPPLIER_TERM_OPTIONS = {
  leadTime: ['5 days', '7 days', '10 days', '14 days'],
  warranty: ['1 yr', '2 yr', '3 yr'],
  paymentTerms: ['30 days', '60 days', '90 days'],
} as const;

/** The prototype's `selected` option on each select (:9060-9064). */
export const SUPPLIER_TERM_DEFAULTS = {
  leadTime: '7 days',
  warranty: '3 yr',
  paymentTerms: '60 days',
} as const;

export const SUPPLIER_REMARKS_PLACEHOLDER = 'Delivery, installation, exclusions…';

/**
 * "5 days" / "3 yr" -> 5 / 36.
 *
 * proc.quotations stores lead_time_days and warranty_months as integers, so the
 * label a supplier picks has to become a number somewhere. Doing it here keeps
 * one table for the conversion rather than a switch in the service AND a switch
 * in the form.
 *
 * Returns null for anything unrecognised — never a default. A lead time we
 * failed to parse must not silently become 7 days in the database.
 */
export function leadTimeDays(label: string): number | null {
  const m = /^\s*(\d+)\s*days?\s*$/i.exec(label);
  return m ? Number(m[1]) : null;
}

export function warrantyMonths(label: string): number | null {
  const m = /^\s*(\d+)\s*(yr|year)s?\s*$/i.exec(label);
  return m ? Number(m[1]) * 12 : null;
}

export function paymentTermsDays(label: string): number | null {
  const m = /^\s*(\d+)\s*days?\s*$/i.exec(label);
  return m ? Number(m[1]) : null;
}

// ─── Copy ───────────────────────────────────────────────────────────────────

/** renderSupplierInbox / renderSupplierQuote page titles (:9032, :9042). */
export const SUPPLIER_INBOX_TITLE = 'Supplier RFQ Inbox';
export const SUPPLIER_QUOTE_TITLE = 'Submit Quote';

/**
 * W4-2. Replaces the prototype's "Your quote is sealed until the buyer closes
 * the RFQ", which is false: no sealing exists and no timer runs.
 *
 * This string is asserted by the render tests to be present AND the prototype's
 * "sealed" wording to be absent. If you change it, change that test too.
 */
export const SUPPLIER_VISIBILITY_NOTE =
  'Your quote is visible to the buyer as soon as you submit it. You may revise it until the RFQ is closed.';

/** W4-2: the "Closing in 7 days" countdown becomes the real deadline. */
export const INBOX_DUE_LABEL = 'Due';

/** renderSupplierInbox:9030, verbatim. */
export const SUPPLIER_INBOX_EMPTY = 'No active RFQs at the moment. The buyer will issue one soon.';

/** renderSupplierQuote:9053, verbatim. */
export const SUPPLIER_QUOTE_NO_LINES = 'No lines to quote.';

/** The prototype's "Submission is recorded in the audit trail." (:9068). */
export const SUPPLIER_SUBMIT_HINT = 'Submission is recorded in the audit trail.';

export const SUPPLIER_ROSTER_CARD_TITLE = 'Invited vendors on this RFQ';

/**
 * "Acting as <b><real legal name></b> · <real vendor code>" (:9033). The
 * prototype hard-codes one fake company name and one fake vendor code here;
 * neither exists in the database, so both are arguments.
 *
 * NOTE FOR THE NEXT EDITOR. This module is bundled into the shared chunk that
 * every web page loads, and Wave 3's `e2e_governance_web.mjs` fails if any
 * prototype placeholder appears in a compiled page. Record the DECISION, never
 * the literal: a placeholder quoted inside a JSDoc comment still ships to the
 * browser in a dev build, which is exactly how that suite caught this.
 */
export function supplierInboxSubtitle(legalName: string, vendorCode: string): string {
  return `Acting as ${legalName} · ${vendorCode}`;
}

/** "<rfq id> · <title> · Due <date>" (:9043). */
export function supplierQuoteSubtitle(rfqNumber: string, title: string, deadlineAt: string | null): string {
  return `${rfqNumber} · ${title} · ${INBOX_DUE_LABEL} ${formatDay(deadlineAt)}`;
}

/**
 * "Quote for <the buyer>. …" (:9044), with the false sealing clause replaced.
 *
 * DIVERGENCE. The prototype's alert hard-codes a fake buyer name AND a fake
 * vendor code in one string — a single literal doing two jobs, which is why §7
 * of the plan lists it as a value to eliminate. There is no buyer/tenant table
 * in the schema, so `buyerLabel` is supplied by the caller from the real buying
 * department on the PR. The supplier's own name is never passed here:
 * "Quote for <myself>" would be nonsense. See the note on
 * `supplierInboxSubtitle` about why no literal is quoted here.
 */
export function supplierQuoteAlert(buyerLabel: string): string {
  return `Quote for ${buyerLabel}. ${SUPPLIER_VISIBILITY_NOTE}`;
}

/**
 * "Submit your best quote for 3 line item(s). Other invited vendors: KarachiTech,
 * Indus Office Solutions. Quotes are sealed until the buyer closes the RFQ."
 * (:9017-9018) — trailing sentence replaced per W4-2.
 *
 * The vendor list is COMPUTED from the real roster, excluding me. The prototype
 * hardcodes two short names; the port shows each other invited vendor's real
 * legal_name, so the supplier can recognise a competitor they actually bid
 * against. Returns the bare sentence when I am the only invitee, rather than
 * leaving an empty "Other invited vendors: ." behind.
 */
export function supplierInboxParagraph(lineCount: number, otherVendorNames: string[]): string {
  const head = `Submit your best quote for ${lineCount} line item(s).`;
  const roster = otherVendorNames.length
    ? ` Other invited vendors: ${otherVendorNames.join(', ')}.`
    : '';
  return `${head}${roster} ${SUPPLIER_VISIBILITY_NOTE}`;
}

/** "<N> invited" in the roster card header (:9025). */
export function invitedCountLabel(n: number): string {
  return `${n} invited`;
}

// ─── Validation ─────────────────────────────────────────────────────────────

export type QuoteValidation = { ok: true } | { ok: false; message: string };

/**
 * What a supplier must supply before a quote can be submitted. Pure so the
 * service (step 2) and the form (step 4) apply the identical rule, and so the
 * message is testable without a browser.
 *
 * `totalAmount` is the "Total amount (PKR) *" field — the prototype's only
 * required commercial term.
 */
export function validateSupplierQuote(input: {
  lines: SupplierQuoteLine[];
  totalAmount: number | string | null | undefined;
  leadTime?: string | null;
  warranty?: string | null;
  paymentTerms?: string | null;
}): QuoteValidation {
  if (!input.lines.length) return { ok: false, message: SUPPLIER_QUOTE_NO_LINES };

  const unpriced = input.lines.filter(l => !isPriced(l.unitPrice));
  if (unpriced.length) {
    const first = unpriced[0];
    return {
      ok: false,
      message: `Enter a unit price for every line. "${first.description}" (line ${first.lineNo}) is blank.`,
    };
  }

  if (!isPriced(input.totalAmount) || Number(input.totalAmount) <= 0) {
    return { ok: false, message: 'Total amount is required.' };
  }

  if (input.leadTime != null && leadTimeDays(input.leadTime) === null) {
    return { ok: false, message: `Unrecognised lead time "${input.leadTime}".` };
  }
  if (input.warranty != null && warrantyMonths(input.warranty) === null) {
    return { ok: false, message: `Unrecognised warranty "${input.warranty}".` };
  }
  if (input.paymentTerms != null && paymentTermsDays(input.paymentTerms) === null) {
    return { ok: false, message: `Unrecognised payment terms "${input.paymentTerms}".` };
  }

  return { ok: true };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * YYYY-MM-DD for display. Returns the em-dash for a missing/unparseable date
 * rather than "Invalid Date", which is what `new Date(x).toString()` gives you.
 */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().slice(0, 10);
}

/**
 * The only role allowed to use any of this. Mirrors supplierSubmitQuote's guard
 * (`STATE.role!=='vendor'`) and the prototype's data-roles="vendor" on both
 * screens. `admin` is deliberately NOT aliased in: the admin union in
 * @procurement/roles is for back-office features, and a super-role that can
 * impersonate a supplier would defeat the scoping migration 028 exists to
 * guarantee.
 */
export function canUseSupplierSurfaces(role: Role | string | null | undefined): boolean {
  return role === 'vendor';
}
