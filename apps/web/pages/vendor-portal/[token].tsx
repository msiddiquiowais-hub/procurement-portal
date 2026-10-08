// `vendor-portal/[token]` — the SUPPLIER'S OWN quotation page.
//
// Wave 5 Track F. This is the only page in the portal that a user reaches with
// NO session: the link arrives in an email and the token in it is the entire
// authorisation (see vendor-portal.controller.ts, which is deliberately not
// behind JwtAuthGuard). Three consequences are load-bearing here:
//
//   1. NO Shell, and NO useSession() in the data path. `Shell` returns `null`
//      when there is no session (components/Shell.tsx), so it would render a
//      blank page for the one user who is meant to see this one. The layout
//      below is therefore standalone: the same cards, tables and pills, without
//      the sidebar, the role pill or a sign-out button that would be a lie about
//      who is signed in. Nothing is fetched until a token exists, and nothing
//      redirects to login.
//   2. NO `api.*` from lib/api.ts — it attaches the stored session's Bearer
//      token to every call, which would both depend on a login this page must
//      not need and put a portal credential on a link minted to work without
//      one. `portalRequest` in lib/portal.ts is the transport, and it sends
//      neither an Authorization header nor cookies.
//   3. The template is a PLAIN <a href>. It needs no auth header, and a
//      JavaScript download would reintroduce the very thing the link removes.
//
// NOTHING HERE IS A PROTOTYPE LITERAL. Every figure is read off
// GET /vendor-portal/:token; where the API sends nothing, the cell is an
// em-dash and the reason is stated in a `.text-mute` note. Re-submitting ADDS a
// quotation version (the service calls submitAsVendor with revise:true and the
// previous version is kept as SUPERSEDED), so the history table below is
// append-only history rather than a log of the current answer.

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { API_BASE, dash, dateOnly, dateTime, money, portalRequest } from '../../lib/portal';

// ── GET /vendor-portal/:token ────────────────────────────────────────────────
type Pack = {
  vendor: { code: string; name: string };
  rfq: {
    number: string; title: string; currency: string;
    deadline: string | null; state: string;
  };
  link_expires_at: string | null;
  submitted: boolean;
  declined: boolean;
  declined_reason: string | null;
  lines: Array<{ line_no: number; description: string | null; quantity: number | null; uom: string | null }>;
  current_quote: {
    version: number;
    total_amount: number | null; currency: string | null;
    lead_time_days: number | null; warranty_months: number | null;
    payment_terms: string | null; validity_days: number | null;
    taxes_included: boolean | null; submitted_at: string | null; state: string;
  } | null;
  versions: Array<{
    version: number; total_amount: number | null; currency: string | null;
    submitted_at: string | null; state: string; line_count: number | string | null;
  }>;
};

// POST /vendor-portal/:token/quote — what this form may send and nothing more.
type QuoteBody = {
  lines: Array<{ lineNo: number; unitPrice: number; remarks?: string }>;
  leadTimeDays?: number;
  warrantyMonths?: number;
  paymentTerms?: string;
  notes?: string;
};

/** Quotation states, from the CHECK on proc.quotations.state. */
const QUOTE_PILL: Record<string, string> = {
  Submitted: 'submitted',
  Superseded: 'draft',
  Withdrawn: 'draft',
  Awarded: 'approved',
  Rejected: 'rejected',
};

/** RFQ states, from the CHECK on proc.rfq.state. */
const RFQ_PILL: Record<string, string> = {
  Open: 'info',
  Closed: 'draft',
  Awarded: 'approved',
  Cancelled: 'danger',
};

type Notice = { kind: 'ok' | 'err'; text: string; detail?: string[] };

export default function VendorPortalToken() {
  const router = useRouter();
  // Next.js has not populated `query` on the first render of a dynamic route.
  const token = typeof router.query.token === 'string' ? router.query.token : '';
  const path = token ? `/vendor-portal/${encodeURIComponent(token)}` : '';

  const [pack, setPack] = useState<Pack | null>(null);
  const [linkErr, setLinkErr] = useState<{ status: number; message: string } | null>(null);
  const [loading, setLoading] = useState(false);

  // Prices are held as STRINGS because they are being typed. Coercing on every
  // keystroke would make "1," or a trailing dot impossible to type.
  const [price, setPrice] = useState<Record<string, string>>({});
  const [remark, setRemark] = useState<Record<string, string>>({});
  const [leadTime, setLeadTime] = useState('');
  const [warranty, setWarranty] = useState('');
  const [terms, setTerms] = useState('');
  const [notes, setNotes] = useState('');
  const [declineReason, setDeclineReason] = useState('');
  const [busy, setBusy] = useState<'quote' | 'decline' | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      const d = await portalRequest<Pack>('GET', path);
      setPack(d);
      setLinkErr(null);
      // Seed the terms block from the LIVE version so a vendor revising only one
      // line does not have to retype the commercial terms they already sent.
      setLeadTime(d.current_quote?.lead_time_days != null ? String(d.current_quote.lead_time_days) : '');
      setWarranty(d.current_quote?.warranty_months != null ? String(d.current_quote.warranty_months) : '');
      setTerms(d.current_quote?.payment_terms ?? '');
    } catch (e: any) {
      // A dead link is the EXPECTED outcome for an expired or unknown token, so
      // it is kept apart from the pack: the API's own wording is shown on its
      // own, and no empty form is rendered underneath it.
      setPack(null);
      setLinkErr({ status: Number(e?.status ?? 0), message: String(e?.message ?? e) });
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => { load(); }, [load]);

  async function submitQuote() {
    if (!path || !pack) return;
    const bad: string[] = [];
    const lines: QuoteBody['lines'] = [];
    for (const l of pack.lines) {
      const k = String(l.line_no);
      const raw = (price[k] ?? '').trim();
      if (raw === '') continue;
      const n = Number(raw);
      // Refused here rather than sent: the service does `Number(l.unitPrice)`,
      // so a non-numeric cell would arrive as NaN, serialise as null and be
      // stored as a price of 0. A silent zero is worse than a refusal.
      if (!Number.isFinite(n) || n < 0) { bad.push(`line ${l.line_no}`); continue; }
      lines.push({
        lineNo: l.line_no,
        unitPrice: n,
        ...(remark[k]?.trim() ? { remarks: remark[k].trim() } : {}),
      });
    }
    if (bad.length) {
      setNotice({
        kind: 'err',
        text: `Unit price is not a number on line(s) ${bad.join(', ')}. Nothing has been sent.`,
      });
      return;
    }

    const body: QuoteBody = { lines };
    if (leadTime.trim()) body.leadTimeDays = Number(leadTime);
    if (warranty.trim()) body.warrantyMonths = Number(warranty);
    if (terms.trim()) body.paymentTerms = terms.trim();
    if (notes.trim()) body.notes = notes.trim();

    setBusy('quote');
    setNotice(null);
    try {
      // No client-side "at least one line" guard on purpose: the API refuses an
      // empty submission with its own sentence, and that sentence is the better
      // thing for a supplier to read than one written here.
      await portalRequest('POST', `${path}/quote`, body);
      setPrice({});
      setRemark({});
      setNotes('');
      setNotice({
        kind: 'ok',
        text: 'Your quotation has been received. It is kept as a new version alongside your earlier ones.',
      });
      await load();
    } catch (e: any) {
      setNotice({ kind: 'err', text: String(e?.message ?? e), detail: e?.errors });
    } finally {
      setBusy(null);
    }
  }

  async function submitDecline() {
    if (!path) return;
    // The API stores a null reason if this is left blank (declined_reason is
    // nullable), so this is a house rule rather than a server constraint: a
    // decline nobody can explain later is not a record of anything.
    if (!declineReason.trim()) {
      setNotice({
        kind: 'err',
        text: 'Give a reason so the buyer knows whether to re-issue the invitation. Nothing has been sent.',
      });
      return;
    }
    setBusy('decline');
    setNotice(null);
    try {
      await portalRequest('POST', `${path}/decline`, { reason: declineReason.trim() });
      setNotice({ kind: 'ok', text: 'This invitation has been declined. The buyer has been given your reason.' });
      await load();
    } catch (e: any) {
      setNotice({ kind: 'err', text: String(e?.message ?? e), detail: e?.errors });
    } finally {
      setBusy(null);
    }
  }

  // ── The dead-link surface. No form is rendered on this branch. ────────────
  if (!token) {
    return (
      <div className="pk-shell">
        <h1 className="page-title">Quotation request</h1>
        <div className="alert info">This link carries no token. Open the link exactly as it was emailed.</div>
      </div>
    );
  }

  if (linkErr) {
    return (
      <div className="pk-shell">
        <h1 className="page-title">Quotation request</h1>
        <p className="page-sub">This link could not be opened. Nothing has been saved and nothing needs to be re-sent by you.</p>
        <div className="card mb-4" style={{ borderColor: 'var(--danger)' }}>
          <div className="card-h">
            <h3>This link cannot be used</h3>
            <span className="meta">HTTP {linkErr.status || '—'}</span>
          </div>
          <div className="card-b">
            <div className="alert danger" style={{ marginBottom: 0 }}>{linkErr.message}</div>
            <p className="text-sm text-mute" style={{ marginTop: 12, marginBottom: 0 }}>
              The message above is the buyer&apos;s system&apos;s own. If you have already sent a
              quotation, it is on file — a link that stops working does not withdraw it.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (loading && !pack) {
    return (
      <div className="pk-shell">
        <h1 className="page-title">Quotation request</h1>
        <div className="card"><div className="card-b">Opening your quotation request…</div></div>
      </div>
    );
  }

  if (!pack) {
    return (
      <div className="pk-shell">
        <h1 className="page-title">Quotation request</h1>
        <div className="card"><div className="card-b">Loading…</div></div>
      </div>
    );
  }

  const { rfq, vendor } = pack;
  const cur = pack.current_quote;
  // The service refuses a quote once the RFQ leaves 'Open', so the button is
  // disabled against the state the API itself reported rather than a guess.
  const quotesOpen = rfq.state === 'Open';
  const answered = pack.declined;

  return (
    <div className="pk-shell">
      <div className="row-flex mb-4">
        <div className="brand-logo">P</div>
        <div>
          <div className="brand-name" style={{ color: 'var(--navy)' }}>Procurement Portal</div>
          <div className="brand-sub">Supplier quotation request &middot; no login needed</div>
        </div>
      </div>

      <h1 className="page-title">Quotation request</h1>
      <p className="page-sub">
        You are pricing <b>{rfq.number}</b> as <b>{vendor.name}</b> ({vendor.code}). This page
        works from the link in the email &mdash; there is no account to sign in to.
      </p>

      {answered && (
        <div className="alert danger">
          <div>
            <b>You declined this invitation.</b>{' '}
            {pack.declined_reason
              ? <>Reason given: <i>&ldquo;{pack.declined_reason}&rdquo;</i></>
              : 'No reason was recorded with the decline.'}{' '}
            The system will refuse a quotation against a declined invitation, so this form is closed.
            Contact the buyer if the position has changed.
          </div>
        </div>
      )}

      {!answered && !quotesOpen && (
        <div className="alert warn">
          This RFQ is <b>{dash(rfq.state)}</b>, so the system will refuse a new quotation
          against it. What you have already sent is unaffected.
        </div>
      )}

      {notice && (
        <div className={`alert ${notice.kind === 'ok' ? 'success' : 'danger'}`}>
          <div>
            {notice.text}
            {notice.detail && notice.detail.length > 0 && (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {notice.detail.map((d, i) => <li key={i} className="text-sm">{d}</li>)}
              </ul>
            )}
          </div>
        </div>
      )}

      {/* ── the request ───────────────────────────────────────────────────── */}
      <div className="card mb-4">
        <div className="card-h">
          <h3>{rfq.title || dash(rfq.title)}</h3>
          <span className="meta mono">{rfq.number}</span>
        </div>
        <div className="card-b">
          <div className="stat-row">
            <div>
              <div className="stat-n">{dash(rfq.number)}</div>
              <div className="text-sm text-mute">RFQ</div>
              <div className="text-sm text-mute">Quoted in {dash(rfq.currency)}</div>
            </div>
            <div>
              <div className="stat-n">{dateOnly(rfq.deadline)}</div>
              <div className="text-sm text-mute">Deadline</div>
              <div className="text-sm text-mute">
                {rfq.deadline ? 'as stated by the buyer' : 'no deadline recorded on this RFQ'}
              </div>
            </div>
            <div>
              <div className="stat-n">
                <span className={`pill ${RFQ_PILL[rfq.state] ?? 'draft'}`}>{dash(rfq.state)}</span>
              </div>
              <div className="text-sm text-mute">RFQ state</div>
              <div className="text-sm text-mute">quotations are open only while Open</div>
            </div>
            <div>
              <div className="stat-n">{dateTime(pack.link_expires_at)}</div>
              <div className="text-sm text-mute">This link expires</div>
              <div className="text-sm text-mute">
                {pack.link_expires_at ? 'ask the buyer for a new one afterwards' : 'no expiry recorded'}
              </div>
            </div>
          </div>
          <p className="text-sm text-mute" style={{ marginTop: 12, marginBottom: 0 }}>
            Only the lines below were sent to you. The purchase requisition, the budget and the
            other suppliers&apos; prices are not part of this link and are not shown here.
          </p>
        </div>
      </div>

      {/* ── your latest version on file ───────────────────────────────────── */}
      {cur && (
        <div className="card mb-4">
          <div className="card-h">
            <h3>Your current quotation</h3>
            <span className="meta">
              v{cur.version} &middot; <span className={`pill ${QUOTE_PILL[cur.state] ?? 'draft'}`}>{dash(cur.state)}</span>
            </span>
          </div>
          <div className="card-b">
            <table className="tbl">
              <tbody>
                <tr>
                  <th style={{ width: 200 }}>Total quoted</th>
                  <td className="mono">{money(cur.total_amount, cur.currency ?? rfq.currency)}</td>
                </tr>
                <tr>
                  <th>Lead time</th>
                  <td>{cur.lead_time_days !== null ? `${cur.lead_time_days} days` : <span className="text-mute">—</span>}</td>
                </tr>
                <tr>
                  <th>Warranty</th>
                  <td>{cur.warranty_months !== null ? `${cur.warranty_months} months` : <span className="text-mute">—</span>}</td>
                </tr>
                <tr>
                  <th>Payment terms</th>
                  <td>{dash(cur.payment_terms)}</td>
                </tr>
                <tr>
                  <th>Quote valid for</th>
                  <td>{cur.validity_days !== null ? `${cur.validity_days} days` : <span className="text-mute">—</span>}</td>
                </tr>
                <tr>
                  <th>Taxes</th>
                  <td>
                    {cur.taxes_included === null || cur.taxes_included === undefined
                      ? <span className="text-mute">—</span>
                      : cur.taxes_included ? 'Included in the quoted price' : 'Not included — added on top'}
                  </td>
                </tr>
                <tr>
                  <th>Submitted</th>
                  <td className="text-sm">{dateTime(cur.submitted_at)}</td>
                </tr>
              </tbody>
            </table>
            <p className="text-sm text-mute" style={{ marginBottom: 0 }}>
              A dash means you did not state that on this version — it is not a zero and not a
              default. Sending a new quotation replaces none of this: it is kept as version{' '}
              {Number(cur.version) + 1}.
            </p>
          </div>
        </div>
      )}

      {/* ── the form ──────────────────────────────────────────────────────── */}
      <div className="card mb-4">
        <div className="card-h">
          <h3>Lines to price</h3>
          <span className="meta">{pack.lines.length} line(s) sent to you</span>
        </div>
        <div className="card-b">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 60 }}>Line</th>
                <th>Description</th>
                <th style={{ width: 120 }}>Quantity</th>
                <th style={{ width: 170 }}>Unit price ({dash(rfq.currency)})</th>
                <th style={{ width: 220 }}>Remarks</th>
              </tr>
            </thead>
            <tbody>
              {pack.lines.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-mute">
                    No lines are attached to this invitation.
                  </td>
                </tr>
              )}
              {pack.lines.map((l) => {
                const k = String(l.line_no);
                return (
                  <tr key={l.line_no}>
                    <td className="mono">{l.line_no}</td>
                    <td>{dash(l.description)}</td>
                    <td>
                      {l.quantity !== null ? (
                        <>{l.quantity} {dash(l.uom)}</>
                      ) : (
                        <span className="text-mute" title="The buyer recorded no quantity against this line">—</span>
                      )}
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        step="any"
                        placeholder="unit price"
                        value={price[k] ?? ''}
                        disabled={answered || !quotesOpen}
                        onChange={(e) => setPrice((p) => ({ ...p, [k]: e.target.value }))}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        placeholder="optional"
                        value={remark[k] ?? ''}
                        disabled={answered || !quotesOpen}
                        onChange={(e) => setRemark((p) => ({ ...p, [k]: e.target.value }))}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-sm text-mute">
            Leave a price blank to leave that line unpriced — a blank is not sent as zero. The
            workbook template below is generated from these same lines, with the line numbers
            frozen in.
          </p>

          <div className="field-row" style={{ marginTop: 14 }}>
            <label className="field">
              <span className="lbl">Lead time (days)</span>
              <input
                type="number" min={0} step="any"
                value={leadTime}
                disabled={answered || !quotesOpen}
                onChange={(e) => setLeadTime(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="lbl">Warranty (months)</span>
              <input
                type="number" min={0} step="any"
                value={warranty}
                disabled={answered || !quotesOpen}
                onChange={(e) => setWarranty(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="lbl">Payment terms</span>
              <input
                type="text"
                value={terms}
                disabled={answered || !quotesOpen}
                onChange={(e) => setTerms(e.target.value)}
              />
            </label>
          </div>

          <label className="field">
            <span className="lbl">Notes for the buyer</span>
            <textarea
              value={notes}
              disabled={answered || !quotesOpen}
              onChange={(e) => setNotes(e.target.value)}
            />
          </label>

          <div className="btn-row">
            <button
              className="btn primary"
              disabled={busy !== null || answered || !quotesOpen}
              onClick={submitQuote}
            >
              {busy === 'quote' ? 'Sending…' : pack.submitted ? 'Send a revised quotation' : 'Send my quotation'}
            </button>
            {/* A bare <a> on purpose: the template endpoint needs no auth header,
                so the download must not depend on a fetch either. The server sets
                Content-Disposition, so no `download` attribute is needed here. */}
            <a className="btn" href={`${API_BASE}/vendor-portal/${encodeURIComponent(token)}/template.xlsx`}>
              Download the Excel template
            </a>
          </div>
          <p className="text-sm text-mute" style={{ marginBottom: 0 }}>
            Sending adds a new version to the record below. It never overwrites an earlier one, so
            a price you have since improved on can always be shown alongside the price you first
            sent.
          </p>
        </div>
      </div>

      {/* ── decline ───────────────────────────────────────────────────────── */}
      {!answered && (
        <div className="card mb-4" style={{ borderColor: 'var(--line)' }}>
          <div className="card-h"><h3>Not quoting this one?</h3></div>
          <div className="card-b">
            <p className="text-sm">
              Declining closes this invitation. The system then refuses any quotation against it,
              so a quotation cannot be sent after a decline.
            </p>
            <label className="field">
              <span className="lbl">Reason <span className="req">*</span></span>
              <input
                type="text"
                placeholder="e.g. cannot meet the required lead time"
                value={declineReason}
                onChange={(e) => setDeclineReason(e.target.value)}
              />
            </label>
            <button className="btn danger" disabled={busy !== null} onClick={submitDecline}>
              {busy === 'decline' ? 'Sending…' : 'Decline this invitation'}
            </button>
          </div>
        </div>
      )}

      {/* ── the append-only history ───────────────────────────────────────── */}
      <div className="card">
        <div className="card-h">
          <h3>Your submission history</h3>
          <span className="meta">{pack.versions.length} version(s) on file</span>
        </div>
        <div className="card-b">
          {pack.versions.length === 0 ? (
            <div className="text-mute">
              You have not sent a quotation for this RFQ yet. Every version you send from here on
              will be listed below, oldest first.
            </div>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 80 }}>Version</th>
                  <th style={{ width: 160 }}>Total</th>
                  <th style={{ width: 180 }}>Sent</th>
                  <th style={{ width: 130 }}>State</th>
                  <th>Lines</th>
                </tr>
              </thead>
              <tbody>
                {pack.versions.map((v) => (
                  <tr key={v.version}>
                    <td className="mono">v{v.version}</td>
                    <td className="mono">{money(v.total_amount, v.currency ?? rfq.currency)}</td>
                    <td className="text-sm">{dateTime(v.submitted_at)}</td>
                    <td>
                      <span className={`pill ${QUOTE_PILL[v.state] ?? 'draft'}`}>{dash(v.state)}</span>
                    </td>
                    <td className="text-sm text-mute">
                      {v.line_count === null || v.line_count === undefined
                        ? '—'
                        : `${v.line_count} priced`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-sm text-mute" style={{ marginBottom: 0 }}>
            Sending again <b>adds</b> a version and never overwrites an earlier one: the previous
            version is retained and marked Superseded, so what you first sent is still on record.
            Only the newest version is the one the buyer compares.
          </p>
        </div>
      </div>
    </div>
  );
}
