// `award-matrix` — Comparative matrix, split award and offline negotiation.
//
// Wave 5 Track F, back office. Reached from the CS screen as `?cs=<id>`; the
// RFQ id is taken from `?rfq=<id>` when present and is REQUIRED by the
// negotiation panel, for a reason that is this page's one dependence on the
// caller: `/cs/:id/matrix` selects `c.rfq_id` internally but does not RETURN it,
// so there is no way to derive the RFQ id from the payload this page already
// has. Rather than invent one, the negotiation panel states plainly that it
// needs the RFQ id and stays closed until it is supplied. (Reported upstream as
// an API gap — the field is one line away in award.service.ts.)
//
// EVERY CELL IS API DATA. The prototype's version of this screen carried sample
// vendors, sample prices and a "premium 4.2%" that were never stored anywhere;
// none of it is reproduced. Where the API sends no value the cell is an
// em-dash, and the commercially important one is called out rather than filled
// in: a line with no lead time is not a line with a fast lead time.
//
// THE JUSTIFICATION IS NOT DECORATIVE. proc.cs_line_awards and
// negotiation_log both carry a NOT NULL justification (the database refuses the
// insert, not just the service), so the input is marked required and the
// refusal is shown verbatim rather than pre-empted by a message written here.
//
// `premium_vs_lowest` is derived server-side as the awarded bid's unit price
// minus the cheapest bid on that line, and it is the number that decides
// whether a split is worth the hassle of making it — so it is shown next to the
// award rather than buried in a column.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Shell from '../../components/Shell';
import { api, type ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { canSeeScreen } from '@procurement/roles';
import { dash, dateTime, money } from '../../lib/portal';

// ── GET /cs/:id/matrix ───────────────────────────────────────────────────────
type Bid = {
  vendor_id: string; vendor_code: string; vendor_name: string;
  unit_price: number | null; line_total: number | null; remarks: string | null;
  version: number | string;
  lead_time_days: number | null; warranty_months: number | null;
  payment_terms: string | null; validity_days: number | null;
  taxes_included: boolean | null;
  quote_total: number | null; submitted_at: string | null;
};

type MatrixLine = {
  line_no: number;
  description: string | null;
  quantity: number | null;
  uom: string | null;
  bids: Bid[];
  lowest_unit_price: number | null;
  awarded: {
    vendor_id: string; vendor_code: string; vendor_name: string; qty: number;
    justification: string; round: number | string; awarded_at: string | null;
    premium_vs_lowest: number;
  } | null;
};

type Matrix = {
  cs: { id: string; number: string; state: string | null; round: number | string | null };
  pr: { id: string; number: string; title: string | null };
  /** The API returns this so a client holding only a CS id can still reach
   *  /rfq/:id/negotiate. It does NOT have to be threaded through the link. */
  rfq_id: string;
  currency: string;
  lines: MatrixLine[];
  awarded_lines: number;
  total_lines: number;
  complete: boolean;
};

// GET /rfq/:id/negotiations
type Negotiation = {
  id: number; round: number | string; source: string; notes: string | null;
  justification: string | null; rate_before: unknown; rate_after: unknown;
  resulting_quotation_version: number | string | null; created_at: string | null;
  vendor_code: string; legal_name: string; officer: string | null;
};

// POST /cs/:id/pdf
type Compiled = {
  cs_id: string; cs_number: string; document_id: string; object_key: string;
  bytes: number; awarded_lines: number; total_lines: number; complete: boolean;
  note: string | null;
};

const CS_PILL: Record<string, string> = {
  Generated: 'pending',
  Locked: 'approved',
  Superseded: 'draft',
};

const SOURCE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'phone', label: 'Phone' },
  { value: 'email', label: 'Email' },
  { value: 'walk_in', label: 'Walk-in' },
];

type AwardDraft = { vendorId: string; qty: string; justification: string };
type Notice = { kind: 'ok' | 'err'; text: string; detail?: string[] };

/** The server's own refusal, with any per-field detail under it. */
function fromApi(e: unknown): Notice {
  const err = e as ApiError;
  return { kind: 'err', text: err?.message ?? String(e), detail: err?.errors };
}

/**
 * negotiation_log.rate_before / rate_after are jsonb OBJECTS keyed by RFQ line
 * number ({ "1": "1200.00" }), not arrays. Rendered as `line 1: 1200.00 → 950.00`
 * so a reader can see what moved; a line only in `after` is a rate the vendor
 * had not quoted at all, and says so rather than showing a blank "before".
 */
function rateTrail(before: unknown, after: unknown): ReactNode {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort(
    (x, y) => Number(x) - Number(y),
  );
  if (keys.length === 0) return <span className="text-mute">no rates recorded on this agreement</span>;
  return (
    <>
      {keys.map((k) => (
        <div key={k}>
          <span className="mono">line {k}</span>:{' '}
          {b[k] === undefined
            ? <span className="text-mute">not quoted before</span>
            : <span className="mono">{String(b[k])}</span>}
          {' → '}
          {a[k] === undefined
            ? <span className="text-mute">not agreed</span>
            : <span className="mono">{String(a[k])}</span>}
        </div>
      ))}
    </>
  );
}

export default function AwardMatrix() {
  const { session, ready } = useSession();
  const router = useRouter();
  const csId = typeof router.query.cs === 'string' ? router.query.cs : '';
  const rfqFromLink = typeof router.query.rfq === 'string' ? router.query.rfq : '';

  const [m, setM] = useState<Matrix | null>(null);
  // The RFQ id comes from the matrix payload, not from the link. Requiring
  // `?rfq=` made the page unreachable from the CS screen (which knows only the
  // CS and PR ids) and left the negotiation panel permanently closed for anyone
  // who followed a link without it.
  const rfqId = rfqFromLink || m?.rfq_id || '';
  const [err, setErr] = useState('');
  const [award, setAward] = useState<Record<string, AwardDraft>>({});
  const [neg, setNeg] = useState<{
    vendorId: string; source: string; justification: string;
    leadTimeDays: string; warrantyMonths: string;
    lines: Record<string, string>;
  }>({ vendorId: '', source: 'phone', justification: '', leadTimeDays: '', warrantyMonths: '', lines: {} });
  const [negs, setNegs] = useState<Negotiation[] | null>(null);
  const [pdf, setPdf] = useState<Compiled | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const allowed = session?.user ? canSeeScreen(session.user.role, 'cs') : false;
  const user = session?.user;

  const load = useCallback(async () => {
    if (!csId) return;
    try {
      const { data } = await api.get<Matrix>(`/cs/${csId}/matrix`);
      setM(data);
      setErr('');
      // Seed one award control per line. The qty defaults to the line's own
      // quantity — the API's figure, not a literal — and an empty draft is
      // created so a partially filled form is not wiped by a refresh.
      setAward((prev) => {
        const next = { ...prev };
        for (const l of data.lines) {
          const k = String(l.line_no);
          if (!next[k]) {
            next[k] = {
              vendorId: '',
              qty: l.quantity !== null ? String(l.quantity) : '',
              justification: '',
            };
          } else if (next[k].qty === '' && l.quantity !== null) {
            next[k] = { ...next[k], qty: String(l.quantity) };
          }
        }
        return next;
      });
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [csId]);

  const loadNegotiations = useCallback(async () => {
    if (!rfqId) { setNegs(null); return; }
    try {
      const { data } = await api.get<{ rfq_id: string; entries: Negotiation[] }>(`/rfq/${rfqId}/negotiations`);
      setNegs(data?.entries ?? []);
    } catch {
      // A supporting panel: failing to read the trail must not blank the matrix
      // the officer came here to award on.
      setNegs([]);
    }
  }, [rfqId]);

  useEffect(() => {
    if (ready && session && csId) load();
  }, [ready, session, csId, load]);

  useEffect(() => {
    if (ready && session && csId) loadNegotiations();
  }, [ready, session, csId, rfqId, loadNegotiations]);

  // The vendor roster for the negotiation form is built from the vendors that
  // actually appear in the matrix, so no supplier list is invented here.
  const bidders = useMemo(() => {
    const seen = new Map<string, { id: string; code: string; name: string }>();
    for (const l of m?.lines ?? []) {
      for (const b of l.bids) {
        if (!seen.has(b.vendor_id)) {
          seen.set(b.vendor_id, { id: b.vendor_id, code: b.vendor_code, name: b.vendor_name });
        }
      }
    }
    return [...seen.values()];
  }, [m]);

  async function awardLine(lineNo: number) {
    if (!csId) return;
    const d = award[String(lineNo)];
    if (!d) return;
    setBusy(`award-${lineNo}`);
    setNotice(null);
    try {
      // Sent exactly as typed — including an EMPTY justification. The service
      // and then the database refuse it, and that refusal is the message the
      // officer needs to read; a client-side guard here would only replace it
      // with a sentence written by this page.
      await api.post(`/cs/${csId}/award`, {
        lineNo,
        vendorId: d.vendorId,
        qty: Number(d.qty),
        justification: d.justification.trim(),
      });
      setNotice({ kind: 'ok', text: `Line ${lineNo} awarded.` });
      await load();
    } catch (e) {
      setNotice(fromApi(e));
    } finally {
      setBusy(null);
    }
  }

  async function recordNegotiation() {
    if (!rfqId) return;
    const lines = Object.entries(neg.lines)
      .filter(([, v]) => v.trim() !== '')
      .map(([lineNo, v]) => ({ lineNo: Number(lineNo), unitPrice: Number(v) }));
    setBusy('negotiate');
    setNotice(null);
    try {
      await api.post(`/rfq/${rfqId}/negotiate`, {
        vendorId: neg.vendorId,
        justification: neg.justification.trim(),
        source: neg.source,
        lines,
        ...(neg.leadTimeDays.trim() ? { leadTimeDays: Number(neg.leadTimeDays) } : {}),
        ...(neg.warrantyMonths.trim() ? { warrantyMonths: Number(neg.warrantyMonths) } : {}),
      });
      setNotice({
        kind: 'ok',
        text: 'The negotiated rate is recorded as a new quotation version. The vendor’s own version is kept.',
      });
      setNeg((p) => ({ ...p, justification: '', leadTimeDays: '', warrantyMonths: '', lines: {} }));
      await Promise.all([load(), loadNegotiations()]);
    } catch (e) {
      setNotice(fromApi(e));
    } finally {
      setBusy(null);
    }
  }

  async function lockAsSplit() {
    if (!csId) return;
    setBusy('lock');
    setNotice(null);
    try {
      // No winnerVendorId: the API derives the mode from the recorded line
      // awards, so this button cannot assert a shape the data does not have.
      const { data } = await api.post<{ split?: unknown[] }>(`/cs/${csId}/lock`, {
        reason: `Locked as a split award across ${m?.awarded_lines} line(s) from the comparative matrix.`,
      });
      setNotice({
        kind: 'ok',
        text: `CS locked as a split award${
          Array.isArray(data?.split) ? ` across ${data!.split!.length} line(s)` : ''}.`,
      });
      await load();
    } catch (e) {
      setNotice(fromApi(e));
    } finally {
      setBusy(null);
    }
  }

  async function compilePdf() {
    if (!csId) return;
    setBusy('pdf');
    setNotice(null);
    try {
      const { data } = await api.post<Compiled>(`/cs/${csId}/pdf`);
      setPdf(data);
      setNotice({ kind: 'ok', text: 'The statement has been compiled.' });
    } catch (e) {
      setNotice(fromApi(e));
    } finally {
      setBusy(null);
    }
  }

  if (!ready || !session || !csId) return null;

  return (
    <Shell
      title="Award matrix"
      subtitle={m ? `${m.cs.number} · ${m.pr.number} · round ${dash(m.cs.round)}` : 'Loading…'}
      screenId="cs"
    >
      {!allowed && (
        <div className="card"><div className="card-b">
          This screen is not available for the current role ({user?.role ?? 'unknown'}).
          Switch role using the pill above.
        </div></div>
      )}

      {allowed && err && (
        <div className="card mb-4" style={{ borderColor: 'var(--danger)' }}>
          <div className="card-b">{err}</div>
        </div>
      )}

      {allowed && !m && !err && (
        <div className="card"><div className="card-b">Loading the comparative matrix…</div></div>
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

      {allowed && m && (
        <>
          {/* ── the header ─────────────────────────────────────────────── */}
          <div className="card mb-4">
            <div className="card-h">
              <h3>{m.pr.title || dash(m.pr.title)}</h3>
              <span className="meta mono">
                {m.cs.number} &middot;{' '}
                <span className={`pill ${CS_PILL[String(m.cs.state)] ?? 'draft'}`}>{dash(m.cs.state)}</span>
              </span>
            </div>
            <div className="card-b">
              <div className="stat-row">
                <div>
                  <div className="stat-n">{m.awarded_lines} / {m.total_lines}</div>
                  <div className="text-sm text-mute">Lines awarded</div>
                  <div className="text-sm text-mute">{dash(m.cs.state)}</div>
                </div>
                <div>
                  <div className="stat-n">
                    {m.complete
                      ? <span className="pill approved">Complete</span>
                      : <span className="pill pending">Incomplete</span>}
                  </div>
                  <div className="text-sm text-mute">Every line has one winner</div>
                  <div className="text-sm text-mute">
                    {m.total_lines - m.awarded_lines} line(s) still open
                  </div>
                </div>
                <div>
                  <div className="stat-n">{bidders.length}</div>
                  <div className="text-sm text-mute">Vendors quoting</div>
                  <div className="text-sm text-mute">live versions only</div>
                </div>
                <div>
                  <div className="stat-n">{dash(m.currency)}</div>
                  <div className="text-sm text-mute">Currency</div>
                  <div className="text-sm text-mute">as returned by the statement</div>
                </div>
              </div>
              <p className="text-sm text-mute" style={{ marginTop: 12, marginBottom: 0 }}>
                Only the LIVE quotation version of each vendor appears. A superseded price is
                history and is never shown as a current bid.
              </p>
            </div>
          </div>

          {/* ── one block per line ─────────────────────────────────────── */}
          {m.lines.length === 0 && (
            <div className="card mb-4"><div className="card-b empty-state">
              No submitted quotations on this RFQ, so there is nothing to compare.
            </div></div>
          )}

          {m.lines.map((l) => {
            const k = String(l.line_no);
            const d = award[k] ?? { vendorId: '', qty: l.quantity !== null ? String(l.quantity) : '', justification: '' };
            const a = l.awarded;
            const premium = a && Number(a.premium_vs_lowest) > 0 ? Number(a.premium_vs_lowest) : null;
            return (
              <div className="card mb-4" key={l.line_no}>
                <div className="card-h">
                  <h3>Line {l.line_no} — {dash(l.description)}</h3>
                  <span className="meta">
                    {l.quantity !== null ? `${l.quantity} ${dash(l.uom)}` : 'quantity not recorded'}
                    {' · '}{l.bids.length} bid(s)
                  </span>
                </div>
                <div className="card-b">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Vendor</th>
                        <th style={{ width: 130 }}>Unit price</th>
                        <th style={{ width: 130 }}>Line total</th>
                        <th style={{ width: 100 }}>Lead</th>
                        <th style={{ width: 110 }}>Warranty</th>
                        <th style={{ width: 150 }}>Payment terms</th>
                        <th style={{ width: 100 }}>Validity</th>
                        <th style={{ width: 100 }}>Taxes</th>
                        <th style={{ width: 130 }}>Quote total</th>
                        <th style={{ width: 160 }}>Remarks</th>
                      </tr>
                    </thead>
                    <tbody>
                      {l.bids.length === 0 && (
                        <tr><td colSpan={10} className="text-mute">No vendor has quoted this line.</td></tr>
                      )}
                      {l.bids.map((b) => {
                        const isLowest =
                          l.lowest_unit_price !== null &&
                          b.unit_price !== null &&
                          Number(b.unit_price) === Number(l.lowest_unit_price);
                        const isWinner = a?.vendor_id === b.vendor_id;
                        return (
                          <tr key={b.vendor_id}>
                            <td>
                              <b>{dash(b.vendor_name)}</b>
                              <div className="text-sm text-mute mono">{b.vendor_code} &middot; v{dash(b.version)}</div>
                              {isLowest && <span className="pill approved" style={{ marginTop: 4 }}>Lowest unit price</span>}
                              {isWinner && <span className="pill info" style={{ marginTop: 4, marginLeft: 4 }}>Awarded</span>}
                            </td>
                            <td className="mono">{money(b.unit_price, m.currency)}</td>
                            <td className="mono">{money(b.line_total, m.currency)}</td>
                            <td>
                              {b.lead_time_days !== null
                                ? <>{b.lead_time_days} d</>
                                : <span className="text-mute" title="This vendor stated no lead time">—</span>}
                            </td>
                            <td>
                              {b.warranty_months !== null
                                ? <>{b.warranty_months} mo</>
                                : <span className="text-mute" title="This vendor stated no warranty">—</span>}
                            </td>
                            <td className="text-sm">{dash(b.payment_terms)}</td>
                            <td className="text-sm">
                              {b.validity_days !== null ? `${b.validity_days} d` : <span className="text-mute">—</span>}
                            </td>
                            <td className="text-sm">
                              {b.taxes_included === null || b.taxes_included === undefined
                                ? <span className="text-mute">—</span>
                                : b.taxes_included ? 'Included' : 'Excluded'}
                            </td>
                            <td className="mono text-sm">
                              {money(b.quote_total, m.currency)}
                              <div className="text-mute">sent {dateTime(b.submitted_at)}</div>
                            </td>
                            <td className="text-sm text-mute">{dash(b.remarks)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <p className="text-sm text-mute">
                    A dash is a value the vendor did not state &mdash; not a zero, and not a good
                    result. <b>Quote total</b> is that vendor&rsquo;s whole quotation, every line
                    together, as submitted; <b>line total</b> is this line alone. A vendor whose
                    quote total is missing is a vendor who submitted figures without stating a
                    total, which is what the record says.
                  </p>

                  {/* ── the current award ───────────────────────────────── */}
                  {a && (
                    <div className="alert info" style={{ marginTop: 14 }}>
                      <div>
                        <b>Awarded:</b> {a.vendor_name} ({a.vendor_code}) &middot; qty {dash(a.qty)}{' '}
                        {l.uom ? l.uom : ''} &middot; round {dash(a.round)} &middot;{' '}
                        {dateTime(a.awarded_at)}
                        {premium !== null && (
                          <>
                            {' '}&middot;{' '}
                            <b>
                              premium {money(premium, m.currency)} per unit over the lowest bid
                            </b>
                          </>
                        )}
                        <div className="text-sm" style={{ marginTop: 4 }}>
                          Justification on file: <i>&ldquo;{dash(a.justification)}&rdquo;</i>
                        </div>
                        {premium !== null && (
                          <div className="text-sm text-mute" style={{ marginTop: 4 }}>
                            This line is not being awarded to its cheapest bidder. The premium above
                            is what that choice costs, per unit, and the justification is what has
                            to stand behind it.
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* ── the award control ───────────────────────────────── */}
                  <div style={{ marginTop: 14 }}>
                    <div className="field-row">
                      <label className="field">
                        <span className="lbl">Award line {l.line_no} to <span className="req">*</span></span>
                        <select
                          value={d.vendorId}
                          onChange={(e) => setAward((p) => ({ ...p, [k]: { ...d, vendorId: e.target.value } }))}
                        >
                          <option value="">Choose a bidder…</option>
                          {l.bids.map((b) => (
                            <option key={b.vendor_id} value={b.vendor_id}>
                              {b.vendor_code} — {b.vendor_name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        <span className="lbl">Quantity to award <span className="req">*</span></span>
                        <input
                          type="number"
                          min={0}
                          step="any"
                          value={d.qty}
                          onChange={(e) => setAward((p) => ({ ...p, [k]: { ...d, qty: e.target.value } }))}
                        />
                      </label>
                    </div>
                    <label className="field">
                      <span className="lbl">
                        Justification <span className="req">*</span> — recorded permanently
                      </span>
                      <textarea
                        value={d.justification}
                        placeholder="why this vendor, for this line"
                        onChange={(e) => setAward((p) => ({ ...p, [k]: { ...d, justification: e.target.value } }))}
                      />
                    </label>
                    <div className="btn-row" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
                      <button
                        className="btn primary"
                        disabled={busy !== null || !d.vendorId}
                        onClick={() => awardLine(l.line_no)}
                      >
                        {busy === `award-${l.line_no}`
                          ? 'Recording…'
                          : a ? 'Re-award this line' : 'Award this line'}
                      </button>
                      {a && (
                        <span className="text-sm text-mute">
                          Re-awarding supersedes the current decision rather than editing it: the old
                          award stays readable and the round number goes up.
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}

          {/* ── the compiled statement ──────────────────────────────────── */}
          <div className="card mb-4">
            <div className="card-h">
              <h3>Compiled statement</h3>
              <span className="meta">a derived artefact, never the record</span>
            </div>
            <div className="card-b">
              <p className="text-sm">
                Compiling writes a PDF to storage under a generated id. Each compile is a new file,
                so a document already issued to a committee is never overwritten.
              </p>
              <button className="btn" disabled={busy !== null} onClick={compilePdf}>
                {busy === 'pdf' ? 'Compiling…' : 'Compile the PDF'}
              </button>
              {pdf && (
                <div className="alert success" style={{ marginTop: 14 }}>
                  <div>
                    <b>Compiled {pdf.cs_number}</b>
                    <div className="text-sm" style={{ marginTop: 4 }}>
                      document id <span className="mono">{pdf.document_id}</span>
                    </div>
                    <div className="text-sm">
                      stored at <span className="mono">{pdf.object_key}</span> &middot;{' '}
                      {pdf.bytes} bytes
                    </div>
                    <div className="text-sm">
                      {pdf.awarded_lines} of {pdf.total_lines} line(s) awarded &middot;{' '}
                      {pdf.complete ? 'complete' : 'incomplete — the document says so on its face'}
                    </div>
                    {pdf.note && <div className="text-sm text-mute" style={{ marginTop: 4 }}>{pdf.note}</div>}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ── offline negotiation ─────────────────────────────────────── */}
          <div className="card mb-4">
            <div className="card-h">
              <h3>Offline agreement</h3>
              <span className="meta">phone, email or in person</span>
            </div>
            <div className="card-b">
              <p className="text-sm">
                A rate agreed offline is not a note against the vendor&rsquo;s quote. It is recorded
                as a <b>new quotation version</b> beside the one they sent, so the price they
                offered and the price they agreed both survive and can be shown to anyone who later
                disputes it.
              </p>

              {!m ? (
                <div className="alert warn" style={{ marginBottom: 0 }}>
                  Load the matrix above before recording an agreement — this panel needs the RFQ id,
                  which arrives with it.
                </div>
              ) : (
                <>
                  <div className="field-row">
                    <label className="field">
                      <span className="lbl">Vendor <span className="req">*</span></span>
                      <select
                        value={neg.vendorId}
                        onChange={(e) => setNeg((p) => ({ ...p, vendorId: e.target.value }))}
                      >
                        <option value="">Choose a quoting vendor…</option>
                        {bidders.map((v) => (
                          <option key={v.id} value={v.id}>{v.code} — {v.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span className="lbl">Agreed how <span className="req">*</span></span>
                      <select
                        value={neg.source}
                        onChange={(e) => setNeg((p) => ({ ...p, source: e.target.value }))}
                      >
                        {SOURCE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <table className="tbl mb-4">
                    <thead>
                      <tr>
                        <th style={{ width: 60 }}>Line</th>
                        <th>Description</th>
                        <th style={{ width: 200 }}>Agreed unit price ({dash(m.currency)})</th>
                      </tr>
                    </thead>
                    <tbody>
                      {m.lines.map((l) => {
                        const lk = String(l.line_no);
                        const theirBid = l.bids.find((b) => b.vendor_id === neg.vendorId);
                        return (
                          <tr key={l.line_no}>
                            <td className="mono">{l.line_no}</td>
                            <td>
                              {dash(l.description)}
                              {theirBid && (
                                <div className="text-sm text-mute">
                                  their live quote {money(theirBid.unit_price, m.currency)}
                                </div>
                              )}
                              {!theirBid && neg.vendorId && (
                                <div className="text-sm text-mute">this vendor did not quote this line</div>
                              )}
                            </td>
                            <td>
                              <input
                                type="number"
                                min={0}
                                step="any"
                                placeholder="leave blank to skip"
                                value={neg.lines[lk] ?? ''}
                                onChange={(e) => setNeg((p) => ({ ...p, lines: { ...p.lines, [lk]: e.target.value } }))}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>

                  <div className="field-row">
                    <label className="field">
                      <span className="lbl">Lead time (days)</span>
                      <input
                        type="number" min={0} step="any"
                        value={neg.leadTimeDays}
                        onChange={(e) => setNeg((p) => ({ ...p, leadTimeDays: e.target.value }))}
                      />
                    </label>
                    <label className="field">
                      <span className="lbl">Warranty (months)</span>
                      <input
                        type="number" min={0} step="any"
                        value={neg.warrantyMonths}
                        onChange={(e) => setNeg((p) => ({ ...p, warrantyMonths: e.target.value }))}
                      />
                    </label>
                  </div>

                  <label className="field">
                    <span className="lbl">Justification <span className="req">*</span></span>
                    <textarea
                      value={neg.justification}
                      placeholder="what was agreed, and on what terms"
                      onChange={(e) => setNeg((p) => ({ ...p, justification: e.target.value }))}
                    />
                  </label>

                  <div className="btn-row" style={{ borderTop: 'none', paddingTop: 0, marginTop: 0 }}>
                    <button
                      className="btn primary"
                      disabled={busy !== null || !neg.vendorId}
                      onClick={recordNegotiation}
                    >
                      {busy === 'negotiate' ? 'Recording…' : 'Record the agreement'}
                    </button>
                    <span className="text-sm text-mute">
                      The justification is required by the database, not just by this form, so a
                      record with no stated reason cannot be created by any route.
                    </span>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* ── the negotiation trail ───────────────────────────────────── */}
          {rfqId && (
            <div className="card">
              <div className="card-h">
                <h3>Negotiation history</h3>
                <span className="meta">every offline agreement on this RFQ</span>
              </div>
              <div className="card-b">
                {!negs && <div className="text-mute">Loading the negotiation trail…</div>}
                {negs && negs.length === 0 && (
                  <div className="text-mute">
                    No offline agreement has been recorded on this RFQ.
                  </div>
                )}
                {negs && negs.length > 0 && (
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th style={{ width: 170 }}>When</th>
                        <th>Vendor</th>
                        <th style={{ width: 100 }}>Source</th>
                        <th style={{ width: 90 }}>Round</th>
                        <th>Rates before → after</th>
                        <th>Justification</th>
                        <th style={{ width: 150 }}>Officer</th>
                      </tr>
                    </thead>
                    <tbody>
                      {negs.map((n) => (
                        <tr key={n.id}>
                          <td className="text-sm">{dateTime(n.created_at)}</td>
                          <td>
                            <b>{dash(n.legal_name)}</b>
                            <div className="text-sm text-mute mono">{n.vendor_code}</div>
                          </td>
                          <td className="text-sm">{dash(n.source)}</td>
                          <td className="text-sm">
                            {dash(n.round)}
                            {n.resulting_quotation_version !== null && n.resulting_quotation_version !== undefined
                              ? ` → v${n.resulting_quotation_version}`
                              : ''}
                          </td>
                          <td className="text-sm">
                            {rateTrail(n.rate_before, n.rate_after)}
                          </td>
                          <td className="text-sm">
                            {n.justification ? n.justification : <span className="text-mute">—</span>}
                            {n.notes && n.notes !== n.justification && (
                              <div className="text-sm text-mute">{n.notes}</div>
                            )}
                          </td>
                          <td className="text-sm">{dash(n.officer)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

          <div className="btn-row">
            <Link className="btn ghost" href={`/cs/${m.cs.id}`}>Back to the Comparative Statement</Link>
            <Link className="btn ghost" href={`/pr/${m.pr.id}`}>Back to the Purchase Request</Link>
            {/* W5-G: locking is the step that makes the split the record. Until
                this button exists the officer could award every line correctly
                and the CS screen could still only offer a single vendor. */}
            {m.cs.state === 'Generated' && (
              <button
                className={`btn ${m.complete ? 'primary' : 'ghost'}`}
                disabled={busy !== null || !m.complete}
                onClick={lockAsSplit}
                title={m.complete
                  ? undefined
                  : `${m.total_lines - m.awarded_lines} line(s) still have no winner. Every line must be awarded before the CS can lock as a split.`}
              >
                Lock CS as split award
              </button>
            )}
          </div>
        </>
      )}
    </Shell>
  );
}
