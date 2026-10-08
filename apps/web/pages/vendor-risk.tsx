// `vendor-risk` — Vendor Risk Review.
//
// Port of renderVendorRisk (blueprint 9.5): the weighted-composite matrix and a
// 3-up KPI band, plus the alert explaining the weighting.
//
// THE MODEL IS NOT REIMPLEMENTED HERE. `core.fn_vendor_composite()` in the
// database computes score, band and blocked-ness; this screen renders whatever
// it returns. The same function is what the RFQ invitation guard consults, so
// the "Blocked pending remediation" row below and the refusal a buyer actually
// hits cannot drift apart.
//
// BLOCKED VENDORS ARE SHOWN, NOT HIDDEN. This screen is a remediation queue.

import { useCallback, useEffect, useState } from 'react';
import Shell from '../components/Shell';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { canSeeScreen } from '@procurement/roles';

type RiskRow = {
  id: string;
  vendorCode: string;
  name: string;
  scorecard: { financial: string | null; delivery: string | null; quality: string | null };
  grades: { financial: string; delivery: string; quality: string };
  composite: { score: number | null; grade: string | null; blocked: boolean | null; pill: string; action: string };
};

type RiskData = {
  kpis: { eligible: number; blocked: number; unrated: number; avgComposite: number | null; scored: number };
  weights: Record<string, number>;
  rows: RiskRow[];
};

export default function VendorRisk() {
  const { session } = useSession();
  const user = session?.user;
  const [data, setData] = useState<RiskData | null>(null);
  const [err, setErr] = useState('');

  const allowed = user ? canSeeScreen(user.role, 'vendor-risk') : false;

  const load = useCallback(async () => {
    try {
      const { data: d } = await api.get('/vendors/risk');
      setData(d);
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (allowed) load();
  }, [allowed, load]);

  const gradeCell = (letter: string | null, pill: string) =>
    letter ? <span className={`pill ${pill}`}>{letter}</span> : <span className="text-mute">—</span>;

  return (
    <Shell title="Vendor Risk Review" subtitle="Weighted composite scoring" screenId="vendor-risk">
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

      {allowed && !data && <div className="card"><div className="card-b">Loading the risk matrix…</div></div>}

      {allowed && data && (
        <>
          <div className="card mb-4" style={{ borderColor: 'var(--warn)' }}>
            <div className="card-b">
              Composite grade is weighted {Math.round((data.weights.financial ?? 0.4) * 100)}% financial,{' '}
              {Math.round((data.weights.delivery ?? 0.35) * 100)}% delivery,{' '}
              {Math.round((data.weights.quality ?? 0.25) * 100)}% quality. High-risk vendors are blocked from new
              RFQ invitations until remediation.
            </div>
          </div>

          <div className="card mb-4">
            <div className="card-h"><h3>Standing</h3><span className="meta">scored vendors only</span></div>
            <div className="card-b">
              <div className="stat-row">
                <div>
                  <div className="stat-n">{data.kpis.eligible}</div>
                  <div className="text-sm text-mute">Eligible for RFQ</div>
                </div>
                <div>
                  <div className="stat-n">{data.kpis.blocked}</div>
                  <div className="text-sm text-mute">Blocked</div>
                </div>
                <div>
                  <div className="stat-n">{data.kpis.avgComposite ?? '—'}</div>
                  <div className="text-sm text-mute">Avg composite</div>
                  <div className="text-sm text-mute">across {data.kpis.scored} scored vendors</div>
                </div>
              </div>
              {data.kpis.unrated > 0 && (
                <p className="text-sm text-mute" style={{ marginBottom: 0 }}>
                  {data.kpis.unrated} vendor(s) carry no scorecard and are excluded from the average. Counting
                  an unscored vendor as zero would drag the figure down and read as a risk signal that is not
                  actually measured.
                </p>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-h"><h3>Risk matrix</h3><span className="meta">{data.rows.length} vendors</span></div>
            <div className="card-b">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Vendor</th>
                    <th style={{ width: 90 }}>Financial</th>
                    <th style={{ width: 90 }}>Delivery</th>
                    <th style={{ width: 90 }}>Quality</th>
                    <th style={{ width: 120 }}>Weighted score</th>
                    <th style={{ width: 110 }}>Composite</th>
                    <th style={{ width: 200 }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.length === 0 && (
                    <tr><td colSpan={7} className="text-mute">No vendors.</td></tr>
                  )}
                  {data.rows.map((v) => (
                    <tr key={v.id} style={v.composite.blocked ? { background: 'var(--danger-soft)' } : undefined}>
                      <td>
                        <div>{v.name}</div>
                        <div className="text-sm text-mute mono">{v.vendorCode}</div>
                      </td>
                      <td>{gradeCell(v.scorecard.financial, v.grades.financial)}</td>
                      <td>{gradeCell(v.scorecard.delivery, v.grades.delivery)}</td>
                      <td>{gradeCell(v.scorecard.quality, v.grades.quality)}</td>
                      <td>{v.composite.score === null ? <span className="text-mute">—</span> : <>{v.composite.score}/100</>}</td>
                      <td>
                        {v.composite.grade
                          ? <span className={`pill ${v.composite.pill}`}>{v.composite.grade}</span>
                          : <span className="pill draft">Not assessed</span>}
                      </td>
                      <td className="text-sm">{v.composite.action}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-sm text-mute" style={{ marginBottom: 0 }}>
                A vendor with no scorecard is <strong>not</strong> treated as low risk. It is not blocked either —
                blocking every new vendor out of sourcing until Procurement assesses it would deadlock intake.
                Only an explicit High composite blocks an invitation.
              </p>
            </div>
          </div>
        </>
      )}
    </Shell>
  );
}
