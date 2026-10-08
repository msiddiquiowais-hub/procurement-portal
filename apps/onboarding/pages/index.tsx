// `vendor-onboard-public` — the public vendor application form.
//
// Port of the prototype's vendor-onboard-public screen (PROCUREMENT_PORTAL_PROTOTYPE.html
// lines 725-754). This is a PUBLIC surface: no session, no shell, and the only
// app outside apps/web.
//
// Everything on this page is driven by `GET /onboarding/form` (step 3), which
// returns the copy, the field metadata and the REAL category vocabulary. The page
// therefore has no hardcoded copy and no hardcoded option list — a label lives
// in exactly one place, the API, and the prototype's text is preserved because
// the API serves the prototype's text.
//
// ── Three deliberate divergences from the prototype ────────────────────────
//
// 1. NO PREFILLED VALUES. The prototype ships `value="PakBoxes Pvt Ltd"`,
//    `value="1234567-8"`, `value="Ahsan Ali"`, `value="sales@pakboxes.pk"` and
//    selects "IT hardware" — demo values baked into static HTML. On a real
//    public form those would make every applicant submit the same company and
//    the same tax number. The fields start empty.
//
// 2. THE REFERENCE IS THE DATABASE'S. The prototype's button does
//    `setRole('procurement'); show('vendor-risk'); toast(...)` — it pretends the
//    applicant is a logged-in procurement user. `apps/onboarding` used to render
//    `ONB-{Math.floor(Math.random() * 99999)}`, a reference that existed in
//    neither the database nor anywhere else. The port shows the reference the
//    API returned from core.fn_next_vendor_app_reference().
//
// 3. THE END STATE IS A LOOKUP, NOT A SCREEN SWAP. Because a public applicant
//    has no session, there is no `vendor-risk` to show them and no way to act on
//    what they just submitted. The honest end state is the reference they were
//    given plus a status lookup they can return to — which is exactly what
//    `GET /onboarding/applications/:reference?email=` exists for.

import { useEffect, useState } from 'react';

const BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:33001';

type FormConfig = {
  title: string;
  subtitle: string;
  notice: string;
  submitLabel: string;
  fields: Array<{ key: string; label: string; required: boolean }>;
  categoryOptions: Array<{ id: string; label: string; desc: string }>;
};

type Submitted = {
  reference: string;
  state: string;
  submittedAt: string;
  message: string;
};

type Status = {
  reference: string;
  state: string;
  pending: boolean;
  decisionNote: string | null;
  submittedAt: string;
  reviewedAt: string | null;
};

const EMPTY = {
  legalName: '', ntn: '', contactName: '', contactEmail: '', categories: '',
};

export default function VendorOnboarding() {
  const [cfg, setCfg] = useState<FormConfig | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Submitted | null>(null);

  // The status lookup. Its email is a SECOND FACTOR on a sequential reference,
  // so the field is pre-filled from what the applicant just typed — they have
  // already proven they own that address by submitting with it.
  const [lookupEmail, setLookupEmail] = useState('');
  const [lookup, setLookup] = useState<Status | null>(null);
  const [lookupErr, setLookupErr] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${BASE}/onboarding/form`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setCfg)
      .catch((e) => setErr(`Cannot reach the application service at ${BASE}.`));
  }, []);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`${BASE}/onboarding/applications`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          legalName: form.legalName,
          ntn: form.ntn,
          contactName: form.contactName || null,
          contactEmail: form.contactEmail || null,
          categories: form.categories || null,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // The API's own message: "Company name is required.", "An application
        // for this NTN is already under review...", or the
        // class-validator array. Surface it rather than a generic failure.
        const msg = Array.isArray(data?.message) ? data.message.join(', ') : data?.message;
        setErr(msg || `HTTP ${res.status}`);
        return;
      }
      setDone(data as Submitted);
      setLookupEmail(form.contactEmail);
    } catch (e2: any) {
      setErr(e2?.message || 'Network error.');
    } finally {
      setBusy(false);
    }
  }

  async function checkStatus(e: React.FormEvent) {
    e.preventDefault();
    if (!done) return;
    setLookupErr(null); setLookup(null);
    try {
      const res = await fetch(
        `${BASE}/onboarding/applications/${encodeURIComponent(done.reference)}?email=${encodeURIComponent(lookupEmail)}`,
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = Array.isArray(data?.message) ? data.message.join(', ') : data?.message;
        setLookupErr(msg || `HTTP ${res.status}`);
        return;
      }
      setLookup(data as Status);
    } catch (e2: any) {
      setLookupErr(e2?.message || 'Network error.');
    }
  }

  const required = (k: string) => cfg?.fields.find((f) => f.key === k)?.required;
  const labelFor = (k: string, fallback: string) =>
    cfg?.fields.find((f) => f.key === k)?.label ?? fallback;

  return (
    <div className="public-screen">
      <div className="public-shell">
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div className="brand-logo" style={{ margin: '0 auto 12px', width: 40, height: 40 }}>P</div>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>{cfg?.title ?? 'Vendor Onboarding'}</h1>
          <p className="text-mute text-sm">{cfg?.subtitle ?? 'Apply to become an approved vendor'}</p>
        </div>

        <div className="card">
          <div className="card-b">
            {/* The prototype's own alert, including the "public form" bold. The
                notice is served by the API, so the prototype's wording is
                preserved without being restated here. */}
            <div className="alert info">
              <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
              </svg>
              <div>
                This is a <b>public form</b> &mdash; no login required. Submissions are validated
                by Procurement before vendor master creation.
              </div>
            </div>

            {err && <div className="alert error">{err}</div>}

            {done ? (
              <>
                <div className="ref-panel">
                  <div className="alert success" style={{ textAlign: 'left' }}>{done.message}</div>
                  <div className="text-mute text-sm">Your application reference</div>
                  {/* The DATABASE's reference. Nothing on this page invents one. */}
                  <div className="ref-value" data-testid="reference">{done.reference}</div>
                  <div className="ref-note">
                    Keep this reference. It is the only way to check on your application.
                  </div>
                </div>

                <form onSubmit={checkStatus}>
                  <div className="lookup-row">
                    <input
                      type="email"
                      value={lookupEmail}
                      onChange={(e) => setLookupEmail(e.target.value)}
                      placeholder="The email you applied with"
                    />
                    <button className="btn" type="submit">Check status</button>
                  </div>
                </form>

                {lookupErr && <div className="alert error" style={{ marginTop: 14 }}>{lookupErr}</div>}
                {lookup && (
                  <div className="lookup-result" data-testid="status">
                    <div>
                      Reference <b className="mono">{lookup.reference}</b> &middot;{' '}
                      <span className="state">{lookup.state}</span>
                      {lookup.pending ? '' : ' — this application has been decided.'}
                    </div>
                    {lookup.decisionNote && (
                      <div style={{ marginTop: 6 }}>
                        <span className="text-mute text-sm">Reason: </span>{lookup.decisionNote}
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <form onSubmit={submit}>
                <label className="field">
                  <span className="lbl">
                    {labelFor('legalName', 'Company name')}
                    {required('legalName') && <span className="req">*</span>}
                  </span>
                  <input type="text" value={form.legalName} onChange={set('legalName')}
                    autoComplete="organization" required={required('legalName')} />
                </label>

                <label className="field">
                  <span className="lbl">
                    {labelFor('ntn', 'NTN / Tax ID')}
                    {required('ntn') && <span className="req">*</span>}
                  </span>
                  <input type="text" value={form.ntn} onChange={set('ntn')} required={required('ntn')} />
                </label>

                <div className="field-row">
                  <label className="field">
                    <span className="lbl">{labelFor('contactName', 'Contact person')}</span>
                    <input type="text" value={form.contactName} onChange={set('contactName')}
                      autoComplete="name" />
                  </label>
                  <label className="field">
                    <span className="lbl">{labelFor('contactEmail', 'Email')}</span>
                    <input type="email" value={form.contactEmail} onChange={set('contactEmail')}
                      autoComplete="email" />
                  </label>
                </div>

                <label className="field">
                  <span className="lbl">{labelFor('categories', 'Categories supplied')}</span>
                  {/* The REAL vocabulary from the API, not the prototype's three
                      hardcoded options. "Office equipment" is not a category id
                      anything in the system recognises. */}
                  <select value={form.categories} onChange={set('categories')}>
                    <option value="">Select a category&hellip;</option>
                    {(cfg?.categoryOptions ?? []).map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </select>
                </label>

                <button className="btn primary" type="submit"
                  style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>
                  {busy ? 'Submitting…' : (cfg?.submitLabel ?? 'Submit application')}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
