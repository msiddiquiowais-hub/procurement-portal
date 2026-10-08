// `vendors` — Vendor Master.
//
// Port of renderVendorMaster (blueprint 9.3): a 4-up KPI band and one table,
// with no filter, sort, search, add-vendor or per-row action, exactly as the
// blueprint specifies. Every value is read from core.vendors and
// core.fn_vendor_composite(); nothing here is a prototype literal.
//
// THE RISK COLUMN IS NOT DECORATIVE. "High" means the RFQ invitation guard in
// rfq.service refuses that vendor, so the pill and the enforcement are the same
// fact read twice.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Shell from '../components/Shell';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { canSeeScreen } from '@procurement/roles';

type Composite = {
  score: number | null;
  grade: string | null;
  blocked: boolean | null;
  pill: string;
  action: string;
};

type VendorRow = {
  id: string;
  vendorCode: string;
  name: string;
  city: string | null;
  rating: number | null;
  category: string[];
  inactiveCategory: string[];
  categorised: boolean;
  state: string;
  composite: Composite;
  posAwarded: number;
  lifetimeSpend: number;
  isHold: boolean;
  holdReason: string | null;
};

type Attention = {
  kind: 'uncategorised' | 'held';
  vendor_id: string;
  vendor_code: string;
  name: string;
  message: string;
};

type VendorMasterData = {
  kpis: {
    total: number; low: number; medium: number; high: number;
    unrated: number; uncategorised: number; held: number;
  };
  rows: VendorRow[];
  attention: Attention[];
};

const pkr = (n: number) =>
  n.toLocaleString('en-PK', { style: 'currency', currency: 'PKR', maximumFractionDigits: 0 });

export default function Vendors() {
  const { session } = useSession();
  const user = session?.user;
  const [data, setData] = useState<VendorMasterData | null>(null);
  const [err, setErr] = useState('');

  const allowed = user ? canSeeScreen(user.role, 'vendors') : false;

  const load = useCallback(async () => {
    try {
      const { data: d } = await api.get('/vendors');
      setData(d);
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (allowed) load();
  }, [allowed, load]);

  return (
    <Shell title="Vendor Master" subtitle="Approved suppliers and their standing" screenId="vendors">
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

      {allowed && !data && <div className="card"><div className="card-b">Loading the vendor master…</div></div>}

      {allowed && data && (
        <>
          <div className="card mb-4">
            <div className="card-h"><h3>Portfolio</h3><span className="meta">risk bands are enforced</span></div>
            <div className="card-b">
              <div className="stat-row">
                <div>
                  <div className="stat-n">{data.kpis.total}</div>
                  <div className="text-sm text-mute">Total vendors</div>
                  <div className="text-sm text-mute">All categories</div>
                </div>
                <div>
                  <div className="stat-n">{data.kpis.low}</div>
                  <div className="text-sm text-mute">Low risk</div>
                  <div className="text-sm text-mute">Pre-approved</div>
                </div>
                <div>
                  <div className="stat-n">{data.kpis.medium}</div>
                  <div className="text-sm text-mute">Medium risk</div>
                  <div className="text-sm text-mute">Monitor quarterly</div>
                </div>
                <div>
                  <div className="stat-n">{data.kpis.high}</div>
                  <div className="text-sm text-mute">High risk</div>
                  <div className="text-sm text-mute">Restricted or blocked</div>
                </div>
              </div>
              {(data.attention.length > 0) && (
                <div style={{
                  marginTop: 12, padding: 12, border: '1px solid var(--danger)',
                  borderRadius: 8, background: 'var(--danger-soft, transparent)',
                }}>
                  <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--danger)' }}>
                    {data.attention.length} vendor(s) need attention
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {data.attention.map((a) => (
                      <li key={`${a.kind}-${a.vendor_id}`} className="text-sm" style={{ marginBottom: 4 }}>
                        <Link href={`/vendor/${a.vendor_id}`} className="mono">{a.vendor_code}</Link>
                        {' — '}
                        <Link href={`/vendor/${a.vendor_id}`}>{a.name}</Link>
                        {': '}
                        <span className="text-mute">{a.message}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="text-sm text-mute" style={{ marginTop: 8, marginBottom: 0 }}>
                    These are named rather than counted, because a count does not tell you what to do next.
                    Every one of them is a vendor the RFQ dispatch gate is currently refusing.
                  </p>
                </div>
              )}
              {(data.kpis.uncategorised > 0 || data.kpis.unrated > 0) && (
                <div className="text-sm" style={{ marginBottom: 0 }}>
                  {data.kpis.uncategorised > 0 && (
                    <p style={{ color: 'var(--danger)' }}>
                      <strong>{data.kpis.uncategorised} vendor(s) have no category.</strong> Category is
                      mandatory for a vendor used for procurement, so these are excluded from automatically
                      generated RFQs and quotation emails until one is assigned. Assign it in Vendor Detail.
                    </p>
                  )}
                  {data.kpis.unrated > 0 && (
                    <p className="text-mute" style={{ marginBottom: 0 }}>
                      {data.kpis.unrated} vendor(s) have no risk assessment on file. They are counted
                      separately rather than inside “Low risk”, because not yet assessed is not the same as
                      assessed and found sound.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-h"><h3>Vendors</h3><span className="meta">{data.rows.length} records</span></div>
            <div className="card-b">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 90 }}>Vendor ID</th>
                    <th>Name</th>
                    <th style={{ width: 230 }}>Item groups</th>
                    <th style={{ width: 120 }}>City</th>
                    <th style={{ width: 90 }}>Rating</th>
                    <th style={{ width: 70 }}>POs</th>
                    <th style={{ width: 110 }}>Spend</th>
                    <th style={{ width: 120 }}>Risk</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.length === 0 && (
                    <tr><td colSpan={8} className="text-mute">No vendors.</td></tr>
                  )}
                  {data.rows.map((v) => (
                    <tr key={v.id}>
                      <td className="mono">{v.vendorCode}</td>
                      <td>
                        <Link href={`/vendor/${v.id}`}>{v.name}</Link>
                        {/* RULE 5: the hold is a control, so it is visible in the
                            pool an admin works from, not buried on the detail page. */}
                        {v.isHold && (
                          <span className="pill danger" style={{ marginLeft: 6 }}
                            title={v.holdReason || 'On hold'}>
                            On hold
                          </span>
                        )}
                      </td>
                      <td className="text-sm">
                        {v.category.length
                          ? v.category.map((c) => (
                              <span key={c} className="pill info" style={{ marginRight: 4 }}>{c}</span>
                            ))
                          : (
                            // Rule 3: category is mandatory for an active vendor, but
                            // NOT a DB constraint (that would reject a D365 sync). The
                            // gap is surfaced here and enforced at the RFQ dispatch gate.
                            <span className="pill warn" title="Excluded from automatic RFQs">none</span>
                          )}
                        {/* Deactivated links are shown, not hidden. The relationship
                            still exists and is still audited; it just no longer
                            routes, and that is worth seeing in the pool an admin
                            works from rather than discovering on the detail page. */}
                        {v.inactiveCategory.map((c) => (
                          <span
                            key={`off-${c}`}
                            className="pill draft"
                            style={{ marginRight: 4, opacity: 0.75 }}
                            title={`${c} is linked but deactivated — future RFQs will not route here`}
                          >
                            {c} · off
                          </span>
                        ))}
                      </td>
                      <td>{v.city ?? <span className="text-mute">—</span>}</td>
                      <td>{v.rating !== null ? `★ ${v.rating}` : <span className="text-mute">—</span>}</td>
                      <td>{v.posAwarded}</td>
                      <td>{pkr(v.lifetimeSpend)}</td>
                      <td>
                        {v.composite.grade ? (
                          <span className={`pill ${v.composite.pill}`}>
                            {v.composite.grade} · {v.composite.score}/100
                          </span>
                        ) : (
                          <span className="pill draft">Not assessed</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-sm text-mute" style={{ marginBottom: 0 }}>
                POs and spend are counted from locked comparative statements — there is no purchase-order
                table in this schema, so a locked CS is the award record.
              </p>
            </div>
          </div>
        </>
      )}
    </Shell>
  );
}
