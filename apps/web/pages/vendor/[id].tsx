// `vendor-detail` — Vendor Detail.
//
// Port of renderVendorDetail (blueprint 9.4): a 4-up KPI band, a Profile kv card,
// a Compliance kv card and a Risk-breakdown table.
//
// THE PROTOTYPE'S LITERALS ARE NOT REPRODUCED. The blueprint's own note admits
// this screen hard-codes its grades, its basis strings ("Audited statements, 3
// yrs positive", "96% on-time across 14 POs") and a "★ 4.7 out of 5.0" rating.
// Migration 037 supplied the columns those cells were asking for — rating, city,
// contact, compliance dates and quarterly performance — so this screen now shows
// real stored values rather than dashes. What is still NOT reproduced is the
// prose: the risk-breakdown basis column shows real arithmetic (points x weight),
// because the evidence the prototype cites — audited statements, defect rates —
// is not something this database holds.
//
// Where a record genuinely does not exist the cell still renders an em-dash, and
// the compliance card says "n of 5 recorded" so an unrecorded check is visibly
// unrecorded rather than quietly counted as a pass. That is the same rule the
// codebase already applies to D365 compliance and to a blank quote unit price.

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Shell from '../../components/Shell';
import CategoryCombobox, { type CategoryOption, type CategoryLink } from '../../components/CategoryCombobox';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { canSeeScreen } from '@procurement/roles';

type Breakdown = {
  dimension: string;
  grade: string | null;
  pill: string;
  basis: string | null;
  score?: number | null;
  action?: string;
};

type DetailData = {
  vendor: {
    id: string;
    vendorCode: string;
    name: string;
    state: string;
    composite: { score: number | null; grade: string | null; blocked: boolean | null; pill: string; action: string };
    posAwarded: number;
    lifetimeSpend: number;
    onTimePct: number | null;
    // Rule 5: the hold, as the API shapes it. `isHold` is already normalised
    // server-side because psql returns booleans as 't'/'f' strings.
    isHold?: boolean;
    holdReason?: string | null;
    heldAt?: string | null;
    holdCount?: number;
    categorised?: boolean;
    category?: string[];
  };
  kpis: {
    rating: number | null;
    ratingBasis: string | null;
    posAwarded: number;
    lifetimeSpend: number;
    onTimePct: number | null;
    onTimeBasis: string | null;
    onTimeQuarter: string | null;
    rejectPct: number | null;
    avgResponseHours: number | null;
    since: string | null;
  };
  profile: Record<string, any>;
  compliance: Record<string, any>;
  riskBreakdown: Breakdown[];
};

type AuditEntry = {
  id: number;
  ts: string;
  action: string;
  reason: string | null;
  actor_email: string | null;
  actor_name: string | null;
  before: unknown;
  after: unknown;
  hash_chain_self: string | null;
};

const ACTION_LABEL: Record<string, string> = {
  hold: 'Placed on hold',
  unhold: 'Released from hold',
  category_change: 'Categories changed',
  // The three per-link actions are deliberately distinct in the trail, because
  // "we stopped routing them there" and "we no longer believe this relationship
  // exists" are different decisions and a reader six months later needs to tell
  // them apart.
  category_enable: 'Line category re-enabled',
  category_disable: 'Line category deactivated',
  category_unlink: 'Line category unlinked',
  vendor_update: 'Profile updated',
  d365_vendor_sync: 'Synced from D365',
  update: 'Record updated',
  create: 'Record created',
};

const pkr = (n: number) =>
  n.toLocaleString('en-PK', { style: 'currency', currency: 'PKR', maximumFractionDigits: 0 });

const dash = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

const fmtDate = (v: unknown) => {
  if (!v) return '—';
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 10);
};

/** Compliance cells carry a tone so an expiry is not the same colour as a pass. */
function complianceCell(value: unknown) {
  if (value === null || value === undefined) return <span className="text-mute">Not recorded</span>;
  const v = String(value);
  const tone =
    v === 'Expired' || v === 'Adverse' || v === 'Match' || v === 'Not verified'
      ? 'danger'
      : v === 'Pending review' || v === 'Pending'
        ? 'warn'
        : 'success';
  return <span className={`pill ${tone}`}>{v}</span>;
}

export default function VendorDetail() {
  const router = useRouter();
  const { session } = useSession();
  const user = session?.user;
  const id = typeof router.query.id === 'string' ? router.query.id : '';
  // This route is PRERENDERED, so `router.query` is {} until Next hydrates the
  // page. Fetching against that empty id is how this screen used to sit on
  // "Loading vendor…" forever: the loader returned early, set neither data nor
  // an error, and nothing ever retried. `isReady` is the documented signal that
  // the query string has actually arrived — wait for it, and if it is ready and
  // the id is STILL empty, the link itself is wrong and that is what gets said.
  const routeReady = router.isReady;
  const missingId = routeReady && !id;

  const [data, setData] = useState<DetailData | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [err, setErr] = useState('');
  const [action, setAction] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  // Separate from `busy`, which belongs to the governed-action buttons: a retry
  // is not an action, and borrowing that flag would leave "Retry" disabled and
  // unlabelled while the fetch was running.
  const [retrying, setRetrying] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // ── the two-way LINE CATEGORY mapping (migrations 048 + 051) ──────────────
  const [links, setLinks] = useState<CategoryLink[] | null>(null);
  const [library, setLibrary] = useState<CategoryOption[]>([]);
  // `draft` is the UNSAVED desired ACTIVE set. It is seeded from the server on
  // every load, changed only by clicking in the picker, and sent only by the
  // Save button. Nothing here writes to the database by itself — that was the
  // bug: a stray click in the list was an immediate, audited write.
  const [draft, setDraft] = useState<string[]>([]);
  const [catReason, setCatReason] = useState('');
  const [catNotice, setCatNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const allowed = user ? canSeeScreen(user.role, 'vendor-detail') : false;
  // `admin` expands to procurement and cs through ROLE_ALIASES, so the control
  // appears for an admin session without a special case here — the same
  // predicate the API enforces.
  const canGovern = !!user && ['procurement', 'cs', 'admin', 'hod'].includes(user.role);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const { data: d } = await api.get(`/vendors/${id}`);
      setData(d);
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [id]);

  const loadAudit = useCallback(async () => {
    if (!id) return;
    try {
      const { data: d } = await api.get(`/vendors/${id}/audit`);
      setAudit(d?.entries ?? []);
    } catch {
      // The trail is a supporting panel; failing to read it must not blank the
      // profile the admin came here for.
      setAudit([]);
    }
  }, [id]);

  const loadLinks = useCallback(async () => {
    if (!id) return;
    try {
      const { data: d } = await api.get(`/vendors/${id}/categories`);
      const cats = d?.categories ?? [];
      setLinks(cats);
      // The draft always starts from the server's truth, so a reload discards
      // an unsaved edit rather than silently keeping a stale one.
      setDraft(cats.filter((c: any) => c.isActive).map((c: any) => c.code));
    } catch (e) {
      // The mapping panel is an addition to the screen, not the screen itself.
      // Failing to read it must not blank the profile the admin came for.
      setLinks([]);
      setCatNotice({
        kind: 'err',
        text: `Could not read line-category links: ${(e as Error).message}`,
      });
    }
  }, [id]);

  const loadLibrary = useCallback(async () => {
    try {
      const { data: d } = await api.get('/vendors/categories');
      setLibrary(d?.items ?? []);
    } catch {
      setLibrary([]);
    }
  }, []);

  /**
   * One place that fetches everything the screen shows, so a retry re-runs all
   * of it. The three secondary readers deliberately never block the profile: a
   * missing item-group panel or trail is a degraded screen, not a dead one.
   */
  const loadAll = useCallback(async () => {
    if (!id) return;
    setRetrying(true);
    try {
      await Promise.all([load(), loadAudit(), loadLinks(), loadLibrary()]);
    } finally {
      setRetrying(false);
    }
  }, [id, load, loadAudit, loadLinks, loadLibrary]);

  useEffect(() => {
    // `routeReady` is the point of this guard: before hydration the query is
    // empty, and firing then would fetch the wrong URL (or none).
    if (allowed && routeReady && id) loadAll();
  }, [allowed, routeReady, id, loadAll]);

  /**
   * THE ONLY WRITE PATH for this panel.
   *
   * One button, one POST. The endpoint treats the submitted list as the
   * vendor's DESIRED ACTIVE set: anything submitted is linked, anything linked
   * but not submitted is DEACTIVATED (not deleted), so a single call expresses
   * "these are the categories this vendor should serve" without having to know
   * which of them were already there.
   *
   * Unlinking is deliberately NOT in here. Removing the relationship is a
   * different decision from turning it off, it is not reversible, and folding
   * it into a bulk save would make a mis-click destructive. It keeps its own
   * button, its own reason and its own confirmation.
   */
  async function saveCategoryMapping() {
    if (!catReason.trim()) {
      setCatNotice({ kind: 'err', text: 'A reason is required. A mapping nobody can explain later is a flag, not a control.' });
      return;
    }
    const saved = draft;
    setBusy(true);
    setCatNotice(null);
    try {
      const r = await api.post(`/vendors/${id}/categories`, {
        categories: saved,
        reason: catReason.trim(),
      });
      setCatReason('');
      setCatNotice({
        kind: 'ok',
        text: `Saved. ${r?.data?.activeCount ?? saved.length} active, `
          + `${r?.data?.inactiveCount ?? 0} deactivated.`,
      });
      await Promise.all([load(), loadAudit(), loadLinks()]);
    } catch (e) {
      setCatNotice({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  /** Forget the relationship entirely. Separate from deactivating, on purpose. */
  async function unlinkLink(code: string) {
    if (!catReason.trim()) {
      setCatNotice({ kind: 'err', text: 'A reason is required before unlinking a line category.' });
      return;
    }
    setBusy(true);
    setCatNotice(null);
    try {
      await api.del(`/vendors/${id}/categories/${code}`, { reason: catReason.trim() });
      setCatReason('');
      setCatNotice({ kind: 'ok', text: `${code} unlinked. The audit trail keeps the record.` });
      await Promise.all([load(), loadAudit(), loadLinks()]);
    } catch (e) {
      setCatNotice({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function submitHold(next: 'hold' | 'unhold') {
    if (!reason.trim()) {
      setNotice({ kind: 'err', text: 'A reason is required. A hold nobody can explain later is a flag, not a control.' });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await api.post(`/vendors/${id}/${next}`, { reason: reason.trim() });
      setReason('');
      setAction('');
      setNotice({ kind: 'ok', text: next === 'hold' ? 'Vendor placed on hold.' : 'Vendor released.' });
      await load();
      await loadAudit();
    } catch (e) {
      setNotice({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const since = data?.kpis.since ? new Date(data.kpis.since).toISOString().slice(0, 10) : null;

  return (
    <Shell title="Vendor Detail" subtitle="Profile, compliance and risk" screenId="vendor-detail">
      {!allowed && (
        <div className="card"><div className="card-b">
          This screen is not available for the current role ({user?.role ?? 'unknown'}).
          Switch role using the pill above.
        </div></div>
      )}

      {allowed && missingId && (
        <div className="card" style={{ borderColor: 'var(--danger)' }}>
          <div className="card-b">
            <strong>This link has no vendor id.</strong> Open a vendor from the{' '}
            <Link href="/vendors">Vendor Master</Link> list. (The route loaded,
            but nothing came after <code>/vendor/</code> — this is not a loading
            state and waiting will not help.)
          </div>
        </div>
      )}

      {allowed && err && (
        <div className="card mb-4" style={{ borderColor: 'var(--danger)' }}>
          <div className="card-b">
            <strong>Could not load this vendor.</strong>
            <div className="text-sm" style={{ marginTop: 4 }}>{err}</div>
            <div style={{ marginTop: 10 }}>
              <button className="btn" disabled={retrying} onClick={() => { setErr(''); setData(null); loadAll(); }}>
                {retrying ? 'Retrying…' : 'Retry'}
              </button>
            </div>
          </div>
        </div>
      )}

      {allowed && routeReady && !missingId && !data && !err && (
        <div className="card">
          <div className="card-b">
            Loading vendor…
            <button className="btn" style={{ marginLeft: 10 }} disabled={retrying} onClick={() => loadAll()}>
              {retrying ? 'Loading…' : 'Load now'}
            </button>
          </div>
        </div>
      )}

      {allowed && data && (
        <>
          <div className="card mb-4">
            <div className="card-h">
              <h3>{data.vendor.name}</h3>
              <span className="meta mono">{data.vendor.vendorCode} · {data.vendor.state}</span>
            </div>
            <div className="card-b">
              <div className="stat-row">
                <div>
                  <div className="stat-n">
                    {data.kpis.rating !== null ? `★ ${data.kpis.rating} / 5.0` : '—'}
                  </div>
                  <div className="text-sm text-mute">Rating</div>
                  <div className="text-sm text-mute">
                    {data.kpis.ratingBasis ?? 'As recorded against the supplier'}
                  </div>
                </div>
                <div>
                  <div className="stat-n">{data.kpis.posAwarded}</div>
                  <div className="text-sm text-mute">POs awarded</div>
                  <div className="text-sm text-mute">{since ? `Since ${since}` : ''}</div>
                </div>
                <div>
                  <div className="stat-n">{pkr(data.kpis.lifetimeSpend)}</div>
                  <div className="text-sm text-mute">Lifetime spend</div>
                </div>
                <div>
                  <div className="stat-n">{data.kpis.onTimePct !== null ? `${data.kpis.onTimePct}%` : '—'}</div>
                  <div className="text-sm text-mute">On-time delivery</div>
                  <div className="text-sm text-mute">
                    {data.kpis.onTimeBasis
                      ?? (data.kpis.onTimeQuarter ? `${data.kpis.onTimeQuarter} performance` : '')}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="card mb-4">
            <div className="card-h"><h3>Profile</h3></div>
            <div className="card-b">
              <table className="tbl">
                <tbody>
                  <tr><th style={{ width: 180 }}>Vendor ID</th><td className="mono">{data.profile.vendorId}</td></tr>
                  <tr><th>NTN</th><td className="mono">{dash(data.profile.ntn)}</td></tr>
                  <tr>
                    <th>Category</th>
                    <td>
                      {Array.isArray(data.profile.category) && data.profile.category.length ? (
                        <>
                          {data.profile.category.map((c: string) => (
                            <span key={c} className="pill info" style={{ marginRight: 6 }}>{c}</span>
                          ))}
                        </>
                      ) : (
                        // Rule 3: a category is mandatory for an active vendor used
                        // for procurement. It is NOT a database constraint — that would
                        // reject a D365 sync — so the gap is stated here rather than
                        // hidden, and the RFQ dispatch gate excludes this vendor.
                        <span className="pill warn">No category assigned — excluded from automatic RFQs</span>
                      )}
                    </td>
                  </tr>
                  <tr><th>City</th><td>{dash(data.profile.city)}</td></tr>
                  <tr><th>Active since</th><td>{since ?? '—'}</td></tr>
                  <tr><th>Contact person</th><td>{dash(data.profile.contactPerson)}</td></tr>
                  <tr><th>Email</th><td>{dash(data.profile.email)}</td></tr>
                  <tr>
                    <th>Rating</th>
                    <td>{data.profile.rating !== null ? `★ ${data.profile.rating} out of 5.0` : <span className="text-mute">Not rated</span>}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="card mb-4">
            <div className="card-h">
              <h3>Compliance</h3>
              <span className="meta">
                {data.compliance.checksRecorded} of 5 checks recorded
              </span>
            </div>
            <div className="card-b">
              <table className="tbl">
                <tbody>
                  <tr><th style={{ width: 200 }}>Tax filing</th><td>{complianceCell(data.compliance.taxFiling)}</td></tr>
                  <tr><th>Bank account</th><td>{complianceCell(data.compliance.bankAccount)}</td></tr>
                  <tr><th>Insurance</th><td>{complianceCell(data.compliance.insurance)}</td></tr>
                  <tr><th>AML check</th><td>{complianceCell(data.compliance.amlCheck)}</td></tr>
                  <tr><th>Sanctions screening</th><td>{complianceCell(data.compliance.sanctionsScreening)}</td></tr>
                  <tr><th>Last audit</th><td>{fmtDate(data.compliance.lastAudit)}</td></tr>
                  <tr><th>Next review</th><td>{fmtDate(data.compliance.nextReview)}</td></tr>
                  {data.compliance.insurancePolicyRef && (
                    <tr><th>Insurance policy</th><td className="mono">{data.compliance.insurancePolicyRef}</td></tr>
                  )}
                </tbody>
              </table>
              <p className="text-sm text-mute" style={{ marginBottom: 0 }}>
                Tax filing and insurance are <strong>derived</strong> from their expiry dates, so the label can
                never contradict the date behind it. AML and sanctions carry a stored result as well as a date —
                a check timestamp cannot tell you the outcome. A missing record reads{' '}
                <strong>Not recorded</strong>: an absent check is not a cleared check.
              </p>
            </div>
          </div>

          <div className="card">
            <div className="card-h"><h3>Risk breakdown</h3><span className="meta">weighted 40/35/25</span></div>
            <div className="card-b">
              <table className="tbl">
                <thead>
                  <tr><th style={{ width: 140 }}>Dimension</th><th style={{ width: 90 }}>Grade</th><th>Basis</th></tr>
                </thead>
                <tbody>
                  {data.riskBreakdown.map((b) => (
                    <tr key={b.dimension}>
                      <td>{b.dimension}</td>
                      <td>
                        {b.grade
                          ? <span className={`pill ${b.pill}`}>{b.grade}</span>
                          : <span className="text-mute">Not assessed</span>}
                      </td>
                      <td className="text-sm">
                        {b.basis ?? <span className="text-mute">No scorecard on file</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-sm text-mute">
                The basis column is real arithmetic — points × weight — not the prototype&apos;s prose, which
                cites evidence (audited statements, defect rates) this database does not hold.
              </p>
              <Link className="btn" href="/vendor-risk">Open risk review</Link>
            </div>
          </div>

          {/* ── RULE 5: the only vendor status a local portal user controls ── */}
          {canGovern && (
            <div className="card mb-4" style={data.vendor.isHold ? { borderColor: 'var(--danger)' } : undefined}>
              <div className="card-h">
                <h3>Hold</h3>
                <span className="meta">
                  {data.vendor.isHold
                    ? `on hold since ${fmtDate(data.vendor.heldAt)}`
                    : 'not on hold'}
                </span>
              </div>
              <div className="card-b">
                {data.vendor.isHold ? (
                  <>
                    <p style={{ color: 'var(--danger)' }}>
                      <strong>This vendor is excluded from RFQ invitations</strong> — both the automatic
                      pool and any manual invite. Reason on file:{' '}
                      <em>{data.vendor.holdReason ?? 'not recorded'}</em>
                    </p>
                    {Number(data.vendor.holdCount) > 1 && (
                      <p className="text-sm text-mute">
                        This vendor has been held {data.vendor.holdCount} times.
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-mute">
                    A held vendor is refused RFQ invitations and left out of the automatic pool. Every
                    hold and release is written to the audit trail below and cannot be edited or erased.
                  </p>
                )}

                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
                  <select value={action} onChange={(e) => setAction(e.target.value)}>
                    <option value="">Choose an action…</option>
                    {data.vendor.isHold
                      ? <option value="unhold">Release from hold</option>
                      : <option value="hold">Place on hold</option>}
                  </select>
                  <input
                    type="text"
                    placeholder="Reason (recorded permanently)"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    style={{ flex: 1, minWidth: 220 }}
                  />
                  <button
                    className="btn"
                    disabled={busy || !action}
                    onClick={() => {
                      if (action === 'hold') submitHold('hold');
                      else if (action === 'unhold') submitHold('unhold');
                    }}
                  >
                    {busy ? 'Working…' : 'Apply'}
                  </button>
                </div>

                {notice && (
                  <p
                    className="text-sm"
                    style={{ marginTop: 10, marginBottom: 0, color: notice.kind === 'ok' ? 'var(--ok, #0a7)' : 'var(--danger)' }}
                  >
                    {notice.text}
                  </p>
                )}
                <p className="text-sm text-mute" style={{ marginBottom: 0 }}>
                  Hold is the only vendor STATUS you can change here. Vendor profile and every other
                  state come from Dynamics 365 and are changed at source — this portal records them, it
                  does not edit them. Line categories are the exception: they are managed in this portal,
                  in the card below.
                </p>
              </div>
            </div>
          )}

          {/* ── line categories: the two-way mapping ──────────────────── */}
          {allowed && data && canGovern && (
            <div className="card">
              <div className="card-h">
                <h3>Line categories</h3>
                <span className="meta">
                  {links
                    ? `${links.filter((l) => l.isActive).length} active`
                      + `${links.filter((l) => !l.isActive).length ? ` · ${links.filter((l) => !l.isActive).length} deactivated` : ''}`
                    : ''}
                </span>
              </div>
              <div className="card-b">
                {links === null && <div className="text-mute">Loading line categories…</div>}

                {links && (
                  <>
                    <p className="text-sm text-mute" style={{ marginTop: 0 }}>
                      Search, tick what this vendor should serve, review the draft, then press
                      <strong> Save changes</strong>. Nothing is written until you do.
                    </p>

                    <CategoryCombobox
                      library={library}
                      draft={draft}
                      onToggle={(code) => setDraft((d) => (
                        d.includes(code) ? d.filter((x) => x !== code) : [...d, code]
                      ))}
                      disabled={busy}
                    />

                    <div style={{ marginTop: 12 }}>
                      <input
                        type="text"
                        placeholder="Reason for this change (recorded permanently)"
                        value={catReason}
                        onChange={(e) => setCatReason(e.target.value)}
                        style={{ width: '100%' }}
                      />
                      <div style={{ marginTop: 10 }}>
                        <button
                          className="btn primary"
                          disabled={busy || !catReason.trim()}
                          onClick={saveCategoryMapping}
                        >
                          {busy ? 'Saving…' : 'Save changes'}
                        </button>{' '}
                        <button
                          className="btn"
                          disabled={busy}
                          onClick={() => {
                            setDraft(links.filter((l) => l.isActive).map((l) => l.code));
                            setCatNotice(null);
                          }}
                        >
                          Reset
                        </button>
                      </div>
                      {!catReason.trim() && (
                        <p className="text-sm text-mute" style={{ marginTop: 6, marginBottom: 0 }}>
                          A reason is required before saving.
                        </p>
                      )}
                    </div>

                    {links.length > 0 && (
                      <div style={{ marginTop: 16 }}>
                        <h4 style={{ margin: '0 0 6px' }}>Saved mappings</h4>
                        <table className="tbl">
                          <thead>
                            <tr>
                              <th>Line category</th>
                              <th style={{ width: 110 }}>Status</th>
                              <th style={{ width: 190 }}>Last changed</th>
                              <th style={{ width: 110 }} />
                            </tr>
                          </thead>
                          <tbody>
                            {links.map((l) => (
                              <tr key={l.code}>
                                <td>
                                  <span className="mono">{l.code}</span>
                                  <span className="text-mute" style={{ marginLeft: 8 }}>{l.name}</span>
                                </td>
                                <td>
                                  {l.isActive
                                    ? <span className="pill success">Active</span>
                                    : <span className="pill draft">Deactivated</span>}
                                </td>
                                <td className="text-sm text-mute">
                                  {l.statusChangedAt ? l.statusChangedAt.slice(0, 10) : '—'}
                                  {l.changedBy ? ` · ${l.changedBy.name || l.changedBy.email}` : ''}
                                </td>
                                <td style={{ textAlign: 'right' }}>
                                  <button
                                    className="btn"
                                    disabled={busy}
                                    title="Removes the link entirely. Only the audit record remains."
                                    onClick={() => {
                                      if (globalThis.confirm?.(
                                        `Unlink ${l.code} from this vendor?\n\n`
                                        + 'The mapping is deleted. The audit trail keeps the record, '
                                        + 'and past PRs and POs are unaffected.',
                                      )) unlinkLink(l.code);
                                    }}
                                  >
                                    Unlink
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    <p className="text-sm text-mute" style={{ marginTop: 12, marginBottom: 0 }}>
                      Removing a category from the draft <strong>deactivates</strong> it: the mapping is
                      kept and readable, and future RFQs stop routing to it.{' '}
                      <strong>Unlink</strong> deletes it, leaving only the audit record. Past PRs and
                      purchase orders are untouched either way — this governs future eligibility only.
                    </p>
                    <p className="text-sm text-mute" style={{ marginBottom: 0 }}>
                      Saving while it would leave the vendor with no active category is refused.
                      Dropping a supplier out of the RFQ pool is a vendor-state decision, not a side
                      effect of tidying a list — set the vendor to Deactivated first if that is the intent.
                    </p>

                    {catNotice && (
                      <p
                        className="text-sm"
                        style={{ marginTop: 10, marginBottom: 0, color: catNotice.kind === 'ok' ? 'var(--ok, #0a7)' : 'var(--danger)' }}
                      >
                        {catNotice.text}
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {/* ── the immutable trail ─────────────────────────────────────────── */}
          <div className="card">
            <div className="card-h">
              <h3>Change history</h3>
              <span className="meta">append-only · hash-chained</span>
            </div>
            <div className="card-b">
              {!audit && <div className="text-mute">Loading the audit trail…</div>}
              {audit && audit.length === 0 && (
                <div className="text-mute">No recorded changes yet.</div>
              )}
              {audit && audit.length > 0 && (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 150 }}>When</th>
                      <th style={{ width: 170 }}>Action</th>
                      <th>Reason</th>
                      <th style={{ width: 180 }}>By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.map((e) => (
                      <tr key={e.id}>
                        <td className="text-sm">{new Date(e.ts).toISOString().slice(0, 19).replace('T', ' ')}</td>
                        <td className="text-sm">{ACTION_LABEL[e.action] ?? e.action}</td>
                        <td className="text-sm">{e.reason ?? <span className="text-mute">—</span>}</td>
                        <td className="text-sm">
                          {e.actor_email ?? <span className="text-mute">system</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="text-sm text-mute" style={{ marginBottom: 0 }}>
                These rows live in an append-only log. The application role cannot update or delete them,
                and each one carries a hash of the entry before it, so a removal is detectable even by
                someone with direct database access.
              </p>
            </div>
          </div>
        </>
      )}
    </Shell>
  );
}
