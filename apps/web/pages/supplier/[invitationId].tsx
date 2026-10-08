// `supplier-quote` — the Submit Quote screen.
//
// Port of renderSupplierQuote (prototype line 9037-9070). Reached from the
// inbox, addressed by INVITATION id — which is the supplier's own handle to
// their RFQ, so the URL itself carries the scoping.
//
// The totals are recomputed here with the engine's quoteLineTotals() as the
// vendor types, exactly as the prototype's quoteRecalc did. That is the SAME
// function the API validates with, so the figure on screen and the figure stored
// cannot differ — the prototype's per-line/total mismatch class of bug is
// structurally impossible here.

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { useSession } from '../../lib/session';
import { api } from '../../lib/api';
import Shell from '../../components/Shell';
import {
  SupplierQuoteLines, SupplierCommercialTerms, type QuoteFormData,
} from '../../components/supplier/SupplierCards';
import {
  quoteLineTotals, SUPPLIER_TERM_DEFAULTS,
  type SupplierQuoteLine,
} from '@procurement/workflow-engine';

type Terms = {
  totalAmount: number | null;
  leadTime: string;
  warranty: string;
  paymentTerms: string;
  remarks: string;
};

export default function SupplierQuote() {
  const { session, ready } = useSession();
  const router = useRouter();
  const { invitationId } = router.query as { invitationId?: string };

  const [form, setForm] = useState<QuoteFormData | null>(null);
  const [prices, setPrices] = useState<Record<number, number | null>>({});
  const [terms, setTerms] = useState<Terms>({
    totalAmount: null,
    leadTime: SUPPLIER_TERM_DEFAULTS.leadTime,
    warranty: SUPPLIER_TERM_DEFAULTS.warranty,
    paymentTerms: SUPPLIER_TERM_DEFAULTS.paymentTerms,
    remarks: '',
  });
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!ready || !session || !invitationId) return;
    api.get<QuoteFormData>(`/supplier/rfq/${invitationId}`)
      .then(r => {
        setForm(r.data);
        // Seed the boxes from the CURRENT version when revising, so a vendor
        // who is changing one price does not have to retype the rest. An
        // unpriced line stays null, never 0.
        const seeded: Record<number, number | null> = {};
        for (const l of r.data.lines) {
          seeded[l.lineNo] = l.unitPrice === null || l.unitPrice === undefined
            ? null
            : Number(l.unitPrice);
        }
        setPrices(seeded);
        setTerms(t => ({
          ...t,
          // Only re-derive the total when the vendor has a live version to
          // start from; on a blank form the em-dash IS the correct state.
          totalAmount: r.data.totals.total ?? null,
          remarks: '',
        }));
      })
      .catch(e => setErr(e.message));
  }, [ready, session, invitationId]);

  // One source of truth for the arithmetic: the engine.
  const lines: SupplierQuoteLine[] = useMemo(() => {
    if (!form) return [];
    return form.lines.map(l => ({ ...l, unitPrice: prices[l.lineNo] ?? null }));
  }, [form, prices]);

  const totals = useMemo(() => quoteLineTotals(lines), [lines]);

  // The headline total is DERIVED, exactly as the port requires. The prototype
  // let the vendor type it and redistributed the change back across the line
  // boxes; here the boxes are the source of truth and the total follows, so the
  // two can never contradict each other.
  useEffect(() => {
    setTerms(t => ({ ...t, totalAmount: totals.total }));
  }, [totals.total]);

  if (!ready) return null;
  if (!session) return null;

  const submit = async () => {
    if (!form || !invitationId) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await api.post<{ version: number; isRevision: boolean; transition: string }>(
        `/supplier/rfq/${invitationId}/quote`,
        {
          lines: lines.map(l => ({ lineNo: l.lineNo, unitPrice: l.unitPrice })),
          totalAmount: totals.total,
          leadTime: terms.leadTime,
          warranty: terms.warranty,
          paymentTerms: terms.paymentTerms,
          remarks: terms.remarks,
        },
      );
      setMsg(
        r.data.isRevision
          ? `Revised to V${r.data.version}. ${r.data.transition}.`
          : `Submitted as V${r.data.version}.`,
      );
      const fresh = await api.get<QuoteFormData>(`/supplier/rfq/${invitationId}`);
      setForm(fresh.data);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title="Submit Quote" screenId="supplier-quote" subtitle={form?.subtitle}>
      {err && <div className="alert error">{err}</div>}
      {msg && <div className="alert success">{msg}</div>}
      {!form && !err && <div className="card"><div className="card-b empty-state">Loading&hellip;</div></div>}

      {form && (
        <>
          {/* The prototype's info alert (:9044), with its false "sealed until"
              clause replaced by the honest visibility rule. */}
          <div className="alert info">{form.alert}</div>

          {form.currentQuote && (
            <p className="text-sm text-mute">
              You have a live quote at V{form.currentQuote.version}. Submitting again appends a
              new version and supersedes it &mdash; the earlier price is never rewritten.
            </p>
          )}

          <SupplierQuoteLines
            lines={lines}
            totals={totals}
            editable={form.canSubmit}
            onChange={(lineNo, unitPrice) => setPrices(p => ({ ...p, [lineNo]: unitPrice }))}
          />

          <SupplierCommercialTerms
            values={terms}
            disabled={!form.canSubmit || busy}
            onChange={(k, v) => setTerms(t => ({ ...t, [k]: k === 'totalAmount' ? (v === '' ? null : Number(v)) : v }))}
          />

          {form.canSubmit && (
            <button className="btn success" onClick={submit} disabled={busy}>
              <svg className="icon sm"><use href="#i-check" /></svg>
              {busy ? 'Submitting…' : 'Submit quote'}
            </button>
          )}
        </>
      )}
    </Shell>
  );
}
