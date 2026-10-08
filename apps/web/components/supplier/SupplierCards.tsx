// The renderable pieces of the two supplier screens.
//
// Ported from the prototype's renderSupplierInbox (:9001-9035) and
// renderSupplierQuote (:9037-9070). These are COMPONENTS, not pages, for the same
// reason GovernanceCards is: a Next.js page returns null until a session exists,
// so asserting on the page proves nothing about what a reviewer sees. The pages
// fetch and hand data to these; `tests/supplier.render.test.tsx` renders these
// with react-dom/server and asserts on the markup.
//
// The renderer does NO arithmetic and holds NO business rules. Every value
// arrives computed from @procurement/workflow-engine's supplier module, which is
// what makes "the screen and the API cannot disagree" true rather than
// aspirational.
//
// ── Three places this deliberately diverges from the prototype ─────────────
//
// 1. NO SEALED BID (decision Q2, confirmed W4-2). The prototype says "Your quote
//    is sealed until the buyer closes the RFQ" and renders a "Closing in 7 days"
//    countdown. Neither is true — no sealing was implemented and no timer may
//    run. SUPPLIER_VISIBILITY_NOTE is the honest replacement and is asserted by
//    the render test to be PRESENT and the prototype's wording to be ABSENT.
//
// 2. NO PRE-FILLED UNIT PRICE. The prototype computes Math.round(estimated /
//    totalQty) and drops that into every price box (:9040). That is a guess
//    dressed as a quote. The port starts empty and the line total and Quote
//    total both read the em-dash until a real price exists.
//
// 3. Money is the PROTOTYPE's fmtPKR (Cr / L / K), not apps/web's pkr() (full
//    digits). See supplier.ts for why they are deliberately different.

import {
  moneyOrDash,
  SUPPLIER_INBOX_TITLE,
  SUPPLIER_QUOTE_TITLE,
  SUPPLIER_INBOX_EMPTY,
  SUPPLIER_QUOTE_NO_LINES,
  SUPPLIER_SUBMIT_HINT,
  SUPPLIER_REMARKS_PLACEHOLDER,
  SUPPLIER_TERM_OPTIONS,
  type SupplierQuoteLine,
} from '@procurement/workflow-engine';

// ─── shapes the API returns ─────────────────────────────────────────────────

export type InboxKpi = { label: string; value: string; sub: string; tone?: 'warn' };

export type RosterRow = {
  vendorId: string;
  legalName: string;
  isMe: boolean;
  status: string;
  pill: string;
  coverage: string;
};

export type InboxInvitation = {
  invitationId: string;
  rfqId: string;
  rfqNumber: string;
  rfqTitle: string;
  deadlineAt: string | null;
  declined: boolean;
  myQuote: { version: number; state: string } | null;
  lineCount: number;
  paragraph: string;
  invitedLabel: string;
  canSubmit: boolean;
  canDecline: boolean;
  rosterRows: RosterRow[];
};

export type InboxData = {
  title: string;
  subtitle: string;
  empty: boolean;
  emptyMessage: string;
  kpis: InboxKpi[];
  invitations: InboxInvitation[];
};

export type QuoteTotals = {
  lineTotals: Array<number | null>;
  total: number | null;
  complete: boolean;
  pricedCount: number;
};

export type QuoteFormData = {
  title: string;
  subtitle: string;
  alert: string;
  lines: SupplierQuoteLine[];
  totals: QuoteTotals;
  currentQuote: { version: number; totalAmount: number | null } | null;
  canSubmit: boolean;
};

const dash = <span className="text-mute">&mdash;</span>;

// ─── Supplier KpiBand — prototype :9009-9014 ────────────────────────────────

export function SupplierKpiBand({ kpis }: { kpis: InboxKpi[] }) {
  return (
    <div className="grid g-4 mb-4">
      {kpis.map((k, i) => (
        <div className="card kpi" key={k.label + i}>
          <div className="kpi-label">{k.label}</div>
          {/* The prototype inlines the warn colour on the unanswered KPI
              (:9011). `tone` carries that decision from the engine rather than
              the renderer guessing which tile should be amber. */}
          <div className="kpi-value" style={k.tone === 'warn' ? { color: 'var(--warn)' } : undefined}>
            {k.value}
          </div>
          <div className="kpi-sub">{k.sub}</div>
        </div>
      ))}
    </div>
  );
}

// ─── SupplierRosterCard — prototype :9022-9030 ──────────────────────────────

/**
 * "Invited vendors on this RFQ" with the prototype's three columns: Vendor,
 * My status, Coverage.
 *
 * "My status" is the prototype's own header, kept verbatim per W4-4 even though
 * the column reports each vendor's status. Renaming it would have been a
 * "correction" the port has no licence to make.
 */
export function SupplierRosterCard({ rows, invitedLabel }: { rows: RosterRow[]; invitedLabel: string }) {
  return (
    <div className="card">
      <div className="card-h">
        <h3>Invited vendors on this RFQ</h3>
        <span className="meta">{invitedLabel}</span>
      </div>
      <table className="t">
        <thead>
          <tr><th>Vendor</th><th>My status</th><th>Coverage</th></tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={3} className="empty-state">No invitations yet.</td></tr>
          ) : rows.map(r => (
            <tr key={r.vendorId}>
              <td>
                {r.legalName}
                {r.isMe && <span className="text-sm text-mute"> (you)</span>}
              </td>
              <td><span className={`pill ${r.pill}`}>{r.status}</span></td>
              <td className="text-sm text-mute">{r.coverage}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── SupplierInboxList — prototype :9016-9020 ───────────────────────────────

/**
 * The empty state is the prototype's own sentence (:9030) and renders INSTEAD of
 * the list — never as an empty table, and never alongside a band of zeroes that
 * would imply a working RFQ exists somewhere.
 */
export function SupplierInboxList({
  data, onQuote,
}: {
  data: InboxData;
  /**
   * The prototype's "Quote now" button (:9021). Optional: when absent the row
   * renders the same button non-interactive, which is what the render tests want
   * and what a host with no router wants.
   */
  onQuote?: (invitationId: string) => void;
}) {
  if (data.empty) {
    return (
      <div className="card">
        <div className="card-b empty-state">{data.emptyMessage}</div>
      </div>
    );
  }
  return (
    <>
      {data.invitations.map((inv, i) => (
        <div className="grid g-2" key={inv.invitationId} style={{ marginBottom: 16 }}>
          <div className="card">
            <div className="card-b">
              <p className="text-sm text-mute" style={{ marginTop: 0 }}>{inv.paragraph}</p>
              <table className="t">
                <thead>
                  <tr>
                    <th>RFQ</th><th>Description</th><th>Due</th><th>Lines</th>
                    <th>My status</th><th style={{ textAlign: 'right' }}></th>
                  </tr>
                </thead>
                <tbody>
                  <tr key={inv.invitationId}>
                    <td className="mono"><b>{inv.rfqNumber}</b></td>
                    <td>{inv.rfqTitle || dash}</td>
                    <td className="text-sm">{inv.deadlineAt ? new Date(inv.deadlineAt).toISOString().slice(0, 10) : dash}</td>
                    <td>{inv.lineCount}</td>
                    <td>
                      {inv.myQuote
                        ? <span className="pill approved">V{inv.myQuote.version} submitted</span>
                        : <span className="pill draft">not started</span>}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {/* One button per row. The prototype's "Quote now" /
                          "Closing in 7 days" pair is replaced by a real Due date
                          (W4-2) and a disabled state that SAYS why it is
                          disabled — a silently dead button is worse. */}
                      {inv.canSubmit ? (
                        onQuote ? (
                          <button
                            className="btn sm"
                            data-invitation={inv.invitationId}
                            onClick={() => onQuote(inv.invitationId)}
                          >
                            Quote now
                          </button>
                        ) : (
                          <button className="btn sm" disabled data-invitation={inv.invitationId}>
                            Quote now
                          </button>
                        )
                      ) : (
                        <span className="btn sm" aria-disabled="true" title={
                          inv.declined ? 'You declined this invitation'
                            : 'This RFQ is closed, so quotes can no longer be submitted'
                        }>
                          {inv.declined ? 'Declined' : 'Closed'}
                        </span>
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <SupplierRosterCard rows={inv.rosterRows} invitedLabel={inv.invitedLabel} />
        </div>
      ))}
    </>
  );
}

// ─── SupplierQuoteLines — prototype :9045-9056 ──────────────────────────────

/**
 * The line-pricing table. Line total and Quote total both come from
 * quoteLineTotals() in the engine; this component formats them and nothing else.
 *
 * An unpriced line shows the em-dash in BOTH the line total and the Quote total.
 * That is the divergence from the prototype's quoteRecalc, which summed whatever
 * was typed (treating a blank box as 0) and painted a partial sum as the total.
 */
export function SupplierQuoteLines({
  lines, totals, editable = false, onChange,
}: {
  lines: SupplierQuoteLine[];
  totals: QuoteTotals;
  /** Pages pass false and render a static table; a future editable host passes true. */
  editable?: boolean;
  onChange?: (lineNo: number, unitPrice: number | null) => void;
}) {
  return (
    <div className="card mb-4">
      <div className="card-h">
        <h3>Line pricing</h3>
        <span className="meta">Unit price (PKR) &times; qty</span>
      </div>
      <table className="t">
        <thead>
          <tr>
            <th>SKU</th><th>Description</th>
            <th style={{ textAlign: 'right' }}>Qty</th><th>UoM</th>
            <th style={{ textAlign: 'right' }}>Unit price</th>
            <th style={{ textAlign: 'right' }}>Line total</th>
          </tr>
        </thead>
        <tbody>
          {lines.length === 0 ? (
            <tr><td colSpan={6} className="empty-state">{SUPPLIER_QUOTE_NO_LINES}</td></tr>
          ) : lines.map((l, i) => (
            <tr key={l.lineNo}>
              <td className="mono">{l.sku || dash}</td>
              <td>{l.description}</td>
              <td style={{ textAlign: 'right' }} className="mono num">{l.qty}</td>
              <td>{l.uom}</td>
              <td style={{ textAlign: 'right' }}>
                {editable && onChange ? (
                  <input
                    type="number"
                    className="quote-unit"
                    data-line={l.lineNo}
                    data-qty={l.qty}
                    value={l.unitPrice ?? ''}
                    placeholder="—"
                    onChange={(e) => {
                      const raw = e.target.value;
                      onChange(l.lineNo, raw === '' ? null : Number(raw));
                    }}
                    style={{ width: 120, textAlign: 'right' }}
                  />
                ) : (
                  <span className="mono num" data-unit-price={l.lineNo}>
                    {l.unitPrice === null || l.unitPrice === undefined || l.unitPrice === ''
                      ? dash
                      : Number(l.unitPrice).toLocaleString('en-US')}
                  </span>
                )}
              </td>
              <td style={{ textAlign: 'right', fontWeight: 600 }} className="mono num">
                {moneyOrDash(totals.lineTotals[i])}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="card-b" style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, fontWeight: 600 }}>
        <span>
          Quote total:{' '}
          {totals.complete ? <span className="mono">{moneyOrDash(totals.total)}</span> : dash}
        </span>
      </div>
    </div>
  );
}

// ─── SupplierCommercialTerms — prototype :9057-9068 ─────────────────────────

/**
 * The prototype's four fields, verbatim labels and option lists. The option
 * arrays and the `selected` values come from the engine so the form can never
 * offer a label the API's converter would reject.
 */
export function SupplierCommercialTerms({
  values, onChange, disabled = false,
}: {
  values: { totalAmount: number | null; leadTime: string; warranty: string; paymentTerms: string; remarks: string };
  onChange?: (key: string, value: string) => void;
  disabled?: boolean;
}) {
  const set = onChange || (() => { /* static render */ });
  return (
    <div className="card">
      <div className="card-h"><h3>Commercial terms</h3></div>
      <div className="card-b">
        <div className="field-row">
          <label className="field">
            <span className="lbl">Total amount (PKR) <span className="req">*</span></span>
            <input
              id="quote-amount" type="number" value={values.totalAmount ?? ''}
              placeholder="Derived from the line prices"
              disabled={disabled}
              onChange={(e) => set('totalAmount', e.target.value)}
            />
          </label>
          <label className="field">
            <span className="lbl">Lead time</span>
            <select id="quote-lead" value={values.leadTime} disabled={disabled}
              onChange={(e) => set('leadTime', e.target.value)}>
              {SUPPLIER_TERM_OPTIONS.leadTime.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span className="lbl">Warranty</span>
            <select id="quote-warranty" value={values.warranty} disabled={disabled}
              onChange={(e) => set('warranty', e.target.value)}>
              {SUPPLIER_TERM_OPTIONS.warranty.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="lbl">Payment terms</span>
            <select id="quote-terms" value={values.paymentTerms} disabled={disabled}
              onChange={(e) => set('paymentTerms', e.target.value)}>
              {SUPPLIER_TERM_OPTIONS.paymentTerms.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
        </div>
        <label className="field">
          <span className="lbl">Remarks</span>
          <textarea
            id="quote-remarks" rows={2} value={values.remarks} disabled={disabled}
            placeholder={SUPPLIER_REMARKS_PLACEHOLDER}
            onChange={(e) => set('remarks', e.target.value)}
          />
        </label>
        <div className="btn-row">
          <button className="btn success" disabled={disabled}>
            <svg className="icon sm"><use href="#i-check" /></svg>
            Submit quote
          </button>
          <span className="text-sm text-mute" style={{ alignSelf: 'center' }}>{SUPPLIER_SUBMIT_HINT}</span>
        </div>
      </div>
    </div>
  );
}

export { SUPPLIER_INBOX_TITLE, SUPPLIER_QUOTE_TITLE };
