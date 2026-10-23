// ─────────────────────────────────────────────────────────────────────────────
// CsMatrix — the line-item comparative matrix, rendered from the supplied HTML
// design and wired to the EXISTING AwardService. No new backend, no new schema.
//
// Layout is transposed relative to /buyer/award-matrix: that screen is one card
// per line with vendors as ROWS; this one is a single grid with vendors as
// COLUMNS, because column hide / drag-reorder / visibility toggles are the
// features being added and there is nothing to hide or drag in a row layout.
//
// Everything here is PRESENTATION. Column order, visibility and Seq # live in
// component state only — they are deliberately never persisted, because a
// display preference must not become part of the audit record.
//
// The audit-critical half is NOT ours: `POST /cs/:id/award` writes
// proc.cs_line_awards and the service enforces non-blank justification,
// one-live-award-per-line (DEFERRABLE EXCLUDE), and the vendor-was-scored check.
// This component cannot bypass any of that.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { pkr } from '../lib/ui';
import { isPriced } from './sourcing/quoteMath';

type Bid = {
  vendor_id: string;
  vendor_code: string;
  vendor_name: string;
  unit_price: number | null;
  line_total: number | null;
  warranty_months: number | null;
  lead_time_days: number | null;
  quote_total: number | null;
};

type Award = {
  vendor_id: string;
  vendor_code: string;
  vendor_name: string;
  qty: number;
  justification: string;
  round: number;
  premium_vs_lowest: number;
};

type MatrixLine = {
  line_no: number;
  description: string | null;
  quantity: number | null;
  uom: string | null;
  bids: Bid[];
  lowest_unit_price: number | null;
  awarded: Award | null;
};

type MatrixPayload = {
  cs: { id: string; number: string; state: string | null; round: number };
  pr: { id: string; number: string; title: string };
  currency: string;
  lines: MatrixLine[];
  awarded_lines: number;
  total_lines: number;
  complete: boolean;
};

const GREEN_BG = '#f0fdf4';
const GREEN_BORDER = '#86efac';
const AMBER_BORDER = '#f59e0b';

export default function CsMatrix({ csId, canAward }: { csId: string; canAward: boolean }) {
  const [d, setD] = useState<MatrixPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Presentation state — deliberately not persisted.
  const [order, setOrder] = useState<string[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [seq, setSeq] = useState<Record<number, number>>({});
  const [sorted, setSorted] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);

  // Override modal: {lineNo, vendorId, label}
  const [pending, setPending] = useState<{ line: MatrixLine; bid: Bid } | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(() => {
    if (!csId) return;
    api
      .get<MatrixPayload>(`/cs/${csId}/matrix`)
      .then((r) => {
        setD(r.data);
        setErr(null);
      })
      .catch((e) => setErr(e.message));
  }, [csId]);

  useEffect(() => { load(); }, [load]);

  const lines = d?.lines ?? [];

  // Vendor columns, derived from the bids that actually exist.
  const vendors = useMemo(() => {
    const m = new Map<string, { id: string; name: string; code: string }>();
    for (const l of lines) for (const b of l.bids) m.set(b.vendor_id, { id: b.vendor_id, name: b.vendor_name, code: b.vendor_code });
    const all = [...m.values()].sort((a, b) => a.code.localeCompare(b.code));
    if (order.length === 0) return all;
    // Honour a stored order, then append anything a later load introduced.
    const known = order.filter((id) => m.has(id));
    const rest = all.filter((v) => !known.includes(v.id));
    return [...known.map((id) => m.get(id)!), ...rest];
  }, [lines, order]);

  const visible = vendors.filter((v) => !hidden.includes(v.id));

  // Default Seq # is the natural line order until the user edits it.
  const shownLines = useMemo(() => {
    if (!sorted) return lines;
    return [...lines].sort((a, b) => (seq[a.line_no] ?? a.line_no) - (seq[b.line_no] ?? b.line_no));
  }, [lines, sorted, seq]);

  const bidFor = (l: MatrixLine, vendorId: string) => l.bids.find((b) => b.vendor_id === vendorId) ?? null;
  // A bid is only eligible to BE the lowest one if it actually carries a price.
// `isPriced` is the shared rule (quoteMath.ts, mirroring the API's
// isL1Eligible/isPriced): strictly > 0, so a PKR 0 line can neither wear the
// green L1 badge nor be picked by Auto-select, and every genuine quote is no
// longer measured as a premium against nothing.
const isL1 = (l: MatrixLine, bid: Bid) =>
  isPriced(bid.unit_price)
  && isPriced(l.lowest_unit_price)
  && Number(bid.unit_price) === Number(l.lowest_unit_price);

  const award = async (line: MatrixLine, bid: Bid, why: string) => {
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/cs/${csId}/award`, {
        lineNo: line.line_no,
        vendorId: bid.vendor_id,
        qty: Number(line.quantity ?? 0),
        justification: why,
      });
      load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const onPick = (line: MatrixLine, bid: Bid) => {
    if (!canAward || busy) return;
    // Non-L1 selection demands a justification BEFORE anything is written.
    if (!isL1(line, bid)) {
      setPending({ line, bid });
      setReason('');
    } else {
      award(line, bid, 'System L1 recommendation — lowest unit price on this line.');
    }
  };

  const confirmOverride = () => {
    if (!pending) return;
    if (!reason.trim()) return;
    award(pending.line, pending.bid, reason.trim());
    setPending(null);
    setReason('');
  };

  const autoSelectAllL1 = async () => {
    setBusy(true);
    for (const l of lines) {
      // Same `> 0` rule as `isL1`. Auto-select used to pick the first bid with a
      // non-null price, which for a zero-priced line is the zero — so "Auto-select
      // all L1" would award a PKR 0 line and write that into the award trail.
      const best = l.bids.filter((b) => isPriced(b.unit_price))
        .sort((a, b) => Number(a.unit_price) - Number(b.unit_price))[0];
      if (!best || (l.awarded && l.awarded.vendor_id === best.vendor_id)) continue;
      try {
        await api.post(`/cs/${csId}/award`, {
          lineNo: l.line_no,
          vendorId: best.vendor_id,
          qty: Number(l.quantity ?? 0),
          justification: 'System L1 recommendation — lowest unit price on this line.',
        });
      } catch (e: any) { setErr(e.message); }
    }
    setBusy(false);
    load();
  };

  // Footer maths. "Basket" is everything a vendor OFFERED; "Selected" is only
  // what was actually awarded to them. These are different numbers on purpose —
  // a vendor can have the cheapest basket and still be unable to supply the
  // whole PR, which is exactly why line-item award exists.
  const basket = useMemo(() => {
    const m: Record<string, number> = {};
    for (const v of vendors) m[v.id] = 0;
    for (const l of lines) for (const b of l.bids) if (b.line_total != null) m[b.vendor_id] = (m[b.vendor_id] ?? 0) + Number(b.line_total);
    return m;
  }, [lines, vendors]);

  const selected = useMemo(() => {
    const m: Record<string, number> = {};
    for (const l of lines) {
      if (!l.awarded) continue;
      const b = bidFor(l, l.awarded.vendor_id);
      if (b?.line_total != null) m[l.awarded.vendor_id] = (m[l.awarded.vendor_id] ?? 0) + Number(b.line_total);
    }
    return m;
  }, [lines]);

  const grandSelected = Object.values(selected).reduce((a, b) => a + b, 0);

  const move = (fromId: string, toId: string) => {
    setOrder((prev) => {
      const base = prev.length ? prev : vendors.map((v) => v.id);
      const next = [...base];
      const fi = next.indexOf(fromId);
      const ti = next.indexOf(toId);
      if (fi < 0 || ti < 0 || fi === ti) return base;
      next.splice(fi, 1);
      next.splice(ti, 0, fromId);
      return next;
    });
  };

  if (err && !d) return <div className="card"><div className="card-b" style={{ color: 'var(--danger)' }}>{err}</div></div>;
  if (!d) return <div className="card"><div className="card-b text-mute">Loading the comparative matrix…</div></div>;

  const overrides = lines.filter((l) => l.awarded && l.awarded.premium_vs_lowest > 0);

  return (
    <div>
      {err && (
        <div className="card mb-4" style={{ borderColor: 'var(--danger)' }}>
          <div className="card-b">{err}</div>
        </div>
      )}

      <div className="card">
        <div className="card-h">
          <div>
            <h3>Line-Item Comparative Matrix</h3>
            <div className="text-sm text-mute">
              Rows = line items · Columns = vendors. Green = lowest unit price on that line.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn ghost" onClick={() => setSorted(s => !s)}>
              {sorted ? 'Clear Seq sort' : 'Sort by Seq #'}
            </button>
            {canAward && (
              <button className="btn ghost" onClick={autoSelectAllL1} disabled={busy}>
                Auto-select all L1
              </button>
            )}
          </div>
        </div>

        {/* Toolbar: hidden vendors + top-right visibility checkboxes */}
        <div className="card-b" style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
            <span className="text-mute" style={{ fontWeight: 600 }}>Hidden:</span>
            {hidden.length === 0 && <span className="text-mute">none — use ✕ on a vendor header</span>}
            {hidden.map((id) => {
              const v = vendors.find((x) => x.id === id);
              return (
                <button key={id} className="btn ghost" style={{ padding: '2px 8px', fontSize: 11 }}
                  onClick={() => setHidden((h) => h.filter((x) => x !== id))}>
                  + {v?.name ?? id}
                </button>
              );
            })}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12 }}>
            <span className="text-mute" style={{ fontWeight: 600 }}>Show:</span>
            {vendors.map((v) => (
              <label key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input type="checkbox" checked={!hidden.includes(v.id)}
                  onChange={(e) => setHidden((h) => (e.target.checked ? h.filter((x) => x !== v.id) : [...h, v.id]))} />
                <span>{v.code}</span>
              </label>
            ))}
            <span className="pill" style={{ marginLeft: 6 }}>PO Value: {pkr(grandSelected)}</span>
          </div>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table className="tbl" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th style={{ width: 70 }}>Seq #</th>
                <th style={{ minWidth: 220 }}>Line Item</th>
                {visible.map((v) => (
                  <th
                    key={v.id}
                    draggable
                    onDragStart={() => setDragId(v.id)}
                    onDragOver={(e) => { e.preventDefault(); setDropId(v.id); }}
                    onDragLeave={() => setDropId((c) => (c === v.id ? null : c))}
                    onDrop={() => { if (dragId) move(dragId, v.id); setDragId(null); setDropId(null); }}
                    style={{
                      cursor: 'grab', minWidth: 190,
                      background: dropId === v.id ? '#dbeafe' : undefined,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                      <span title="Drag to reorder">⠿ {v.name}</span>
                      <button className="btn ghost" style={{ padding: '0 6px', fontSize: 11 }}
                        title={`Hide ${v.name}`}
                        onClick={() => setHidden((h) => [...h, v.id])}>✕</button>
                    </div>
                    <div className="text-sm text-mute">{v.code}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shownLines.map((l) => (
                <tr key={l.line_no}>
                  <td>
                    <input
                      type="number"
                      min={1}
                      value={seq[l.line_no] ?? l.line_no}
                      onChange={(e) => setSeq((s) => ({ ...s, [l.line_no]: Number(e.target.value) || 1 }))}
                      style={{ width: 56, textAlign: 'center' }}
                      aria-label={`Sequence for line ${l.line_no}`}
                    />
                  </td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{l.description ?? `Line ${l.line_no}`}</div>
                    <div className="text-sm text-mute">Line {l.line_no} · {l.quantity ?? '—'} {l.uom ?? ''}</div>
                  </td>
                  {visible.map((v) => {
                    const bid = bidFor(l, v.id);
                    if (!bid || bid.unit_price === null) {
                      // A No Quote is the ABSENCE of an offer, never a zero.
                      return (
                        <td key={v.id} style={{ textAlign: 'center', color: '#94a3b8', fontStyle: 'italic', background: '#f8fafc' }}>
                          No Quote
                        </td>
                      );
                    }
                    const rec = isL1(l, bid);
                    const won = l.awarded?.vendor_id === v.id;
                    return (
                      <td
                        key={v.id}
                        style={{
                          background: won ? '#eff6ff' : rec ? GREEN_BG : undefined,
                          border: `1.5px solid ${won ? '#2563eb' : rec ? GREEN_BORDER : 'transparent'}`,
                        }}
                      >
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: canAward ? 'pointer' : 'default', fontWeight: 700 }}>
                          <input type="radio" checked={!!won} disabled={!canAward || busy}
                            onChange={() => onPick(l, bid)} />
                          <span>{pkr(bid.unit_price)}</span>
                        </label>
                        <div className="text-sm text-mute">
                          Line {pkr(bid.line_total ?? 0)} · {bid.lead_time_days ?? '—'}d · {bid.warranty_months ?? '—'}mo
                        </div>
                        {rec && <span className="pill" style={{ background: '#16a34a', color: '#fff' }}>🟢 L1</span>}
                        {won && <span className="pill" style={{ marginLeft: 4 }}>Awarded</span>}
                        {won && l.awarded!.premium_vs_lowest > 0 && (
                          <div className="text-sm" style={{ color: '#b45309', marginTop: 4 }}>
                            +{pkr(l.awarded!.premium_vs_lowest)} over L1 — {l.awarded!.justification}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: '#f8fafc', fontWeight: 700 }}>
                <td colSpan={2}>Totals</td>
                {visible.map((v) => (
                  <td key={v.id}>
                    <div className="text-sm text-mute">Basket {pkr(basket[v.id] ?? 0)}</div>
                    <div style={{ color: selected[v.id] ? '#1e40af' : undefined }}>
                      Selected {pkr(selected[v.id] ?? 0)}
                    </div>
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="card-b text-sm text-mute">
          {d.awarded_lines}/{d.total_lines} lines awarded{d.complete ? ' — complete.' : ' — every line must be awarded before the CS can be locked.'}
        </div>
      </div>

      <div className="card">
        <div className="card-h"><h3>Override audit trail</h3></div>
        <div className="card-b">
          {overrides.length === 0
            ? <span className="text-mute">No overrides. Every awarded line follows its lowest unit price.</span>
            : overrides.map((l) => (
              <div key={l.line_no} style={{ marginBottom: 6 }}>
                <b>Line {l.line_no}</b> awarded to {l.awarded!.vendor_name} at{' '}
                <b>+{pkr(l.awarded!.premium_vs_lowest)}</b> over the cheapest bid — {l.awarded!.justification}
              </div>
            ))}
        </div>
      </div>

      {pending && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div className="card" style={{ width: 460, maxWidth: '92%' }}>
            <div className="card-h"><h3 style={{ color: '#92400e' }}>Override justification required</h3></div>
            <div className="card-b">
              <p className="text-sm text-mute">
                Line {pending.line.line_no} ({pending.line.description}) — you selected{' '}
                <b>{pending.bid.vendor_name}</b> at {pkr(pending.bid.unit_price)} when the lowest bid was{' '}
                {pkr(pending.line.lowest_unit_price ?? 0)}. This is recorded on the award.
              </p>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why this vendor instead of the cheapest?"
                rows={4}
                style={{ width: '100%', marginTop: 8 }}
              />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                <button className="btn ghost" onClick={() => { setPending(null); setReason(''); }}>Cancel</button>
                <button className="btn primary" onClick={confirmOverride} disabled={!reason.trim()}>
                  Save &amp; award
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}