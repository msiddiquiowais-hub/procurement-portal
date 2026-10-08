// `admin-matrix` — Authority Matrix.
//
// Port of renderAuthorityMatrix (blueprint Part 8.1). Subtitle "Routing rules per
// Capex/Opex class", and TWO band tables, each `Amount band | Approver(s) | Routing key`.
//
// This screen is EDITABLE, which the prototype's was not. The prototype is
// explicitly read-only documentation that "also disagrees with deriveRouting"; the
// port corrects that by writing to core.authority_matrix through
// PUT /admin/authority-matrix, and the API refuses any save that would leave a gap
// or an overlap inside a class. A save that lands here changes which approvers the
// engine asks for — it is not documentation.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Shell from '../components/Shell';
import { api, type ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { canSeeScreen } from '@procurement/roles';
import { pkr } from '../lib/ui';

type RoutingKey = 'FAST_TRACK' | 'STANDARD' | 'BOARD';

type Band = {
  id?: string;
  amountMin: number;
  amountMax: number;
  category: 'CAPEX' | 'OPEX';
  requiredRoles: string[];
  routingKey: RoutingKey;
  active: boolean;
  effectiveFrom: string;
};

type MatrixData = {
  capexOpexSplit: boolean;
  tables: { CAPEX: Band[]; OPEX: Band[] };
  bands: Band[];
  retired: Band[];
  note: string;
};

const CLASS_INFO: Record<string, { title: string; blurb: string }> = {
  CAPEX: {
    title: 'Capex (capitalised → asset register)',
    blurb: 'An amount that lands in the asset register and depreciates.',
  },
  OPEX: {
    title: 'Opex (expensed → GL 6xxx)',
    blurb: 'An amount expensed straight to a GL 6xxx account.',
  },
};

const ROUTING_LABEL: Record<RoutingKey, string> = {
  FAST_TRACK: 'FAST_TRACK · fewest stages',
  STANDARD: 'STANDARD',
  BOARD: 'BOARD · longest chain',
};

/** Approver lists render as roles, so a reader can see the actual keys. */
const rolesText = (b: Band) => (b.requiredRoles || []).join(' + ') || '(none)';

export default function AdminMatrix() {
  const { session } = useSession();
  const user = session?.user;
  const [data, setData] = useState<MatrixData | null>(null);
  const [draft, setDraft] = useState<Band[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [msg, setMsg] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>('');

  const allowed = user ? canSeeScreen(user.role, 'admin-matrix') : false;

  const load = useCallback(async () => {
    try {
      const { data: d } = await api.get('/admin/authority-matrix');
      setData(d);
      setDraft(d.bands);
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (allowed) load();
  }, [allowed, load]);

  const patch = (original: Band, next: Partial<Band>) =>
    setDraft((cur) => cur.map((b) => (b === original ? { ...b, ...next } : b)));

  const save = async () => {
    setBusy(true);
    setErrors([]);
    setMsg('');
    try {
      const { data: d } = await api.put('/admin/authority-matrix', { bands: draft });
      setData(d);
      setDraft(d.bands);
      setMsg('Saved. These bands are what the routing engine reads.');
    } catch (e) {
      const ae = e as ApiError;
      // The validator's reasons are the payload here: a gap or an overlap names
      // the exact range. Collapsing that to one line would leave an admin
      // guessing which edge they moved.
      setErrors(ae.errors?.length ? ae.errors : [ae.message]);
    } finally {
      setBusy(false);
    }
  };

  const table = (key: 'CAPEX' | 'OPEX') =>
    data?.tables?.[key]?.slice().sort((a, b) => a.amountMin - b.amountMin) ?? [];

  const changed = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(data?.bands ?? []),
    [draft, data],
  );

  return (
    <Shell
      title="Authority Matrix"
      subtitle="Routing rules per Capex/Opex class"
      screenId="admin-matrix"
    >
      {!allowed && (
        <div className="card"><div className="card-b">
          This screen is not available for the current role ({user?.role ?? 'unknown'}).
          Switch role using the pill above.
        </div></div>
      )}

      {allowed && err && <div className="card"><div className="card-b">Could not read the matrix: {err}</div></div>}

      {allowed && !err && !data && <div className="card"><div className="card-b">Loading the band tables…</div></div>}

      {allowed && data && (
        <>
          <div className="card mb-4">
            <div className="card-h"><h3>How these bands are read</h3><span className="meta">live configuration</span></div>
            <div className="card-b">
              <p style={{ margin: 0 }}>{data.note}</p>
              <p style={{ margin: '8px 0 0' }} className="text-sm text-mute">
                Each class is validated as its own partition of the amount range: bands must start at 0 and
                meet exactly at every boundary. A save that would leave a gap or an overlap is refused and
                nothing is written, so one class&apos;s edit can never silently break the other.
              </p>
            </div>
          </div>

          {(['CAPEX', 'OPEX'] as const).map((key) => (
            <div className="card mb-4" key={key}>
              <div className="card-h">
                <h3>{CLASS_INFO[key].title}</h3>
                <span className="meta">{table(key).length} bands · {CLASS_INFO[key].blurb}</span>
              </div>
              <div className="card-b">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Amount band</th>
                      <th>Approver(s)</th>
                      <th>Routing key</th>
                    </tr>
                  </thead>
                  <tbody>
                    {table(key).map((b) => {
                      const d = draft.find((x) => x.id && x.id === b.id) ?? b;
                      return (
                        <tr key={b.id ?? `${b.category}-${b.amountMin}`}>
                          <td>
                            <div style={{ fontVariantNumeric: 'tabular-nums' }}>
                              {b.amountMin === 0 ? 'Up to' : `${pkr(b.amountMin)} –`}{' '}
                              {b.amountMax >= 9_000_000_000 ? '' : pkr(b.amountMax)}
                              {b.amountMax >= 9_000_000_000 ? 'anything above' : ''}
                            </div>
                            <div className="text-sm text-mute">approvers: {rolesText(d)}</div>
                          </td>
                          <td>
                            <input
                              className="input"
                              value={(d.requiredRoles || []).join(', ')}
                              onChange={(e) =>
                                patch(b, {
                                  requiredRoles: e.target.value
                                    .split(',')
                                    .map((s) => s.trim())
                                    .filter(Boolean),
                                })
                              }
                            />
                          </td>
                          <td>
                            <select
                              className="input"
                              value={d.routingKey}
                              onChange={(e) => patch(b, { routingKey: e.target.value as RoutingKey })}
                            >
                              {(Object.keys(ROUTING_LABEL) as RoutingKey[]).map((k) => (
                                <option key={k} value={k}>{k} — {ROUTING_LABEL[k]}</option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          <div className="btn-row">
            <button className="btn primary" disabled={!changed || busy} onClick={save}>
              {busy ? 'Saving…' : 'Save band tables'}
            </button>
            <button className="btn ghost" disabled={!changed || busy} onClick={() => { setDraft(data.bands); setErrors([]); setMsg(''); }}>
              Discard changes
            </button>
            {!changed && <span className="text-sm text-mute">No changes to save.</span>}
          </div>

          {errors.length > 0 && (
            <div className="card mt-4" style={{ borderColor: 'var(--danger)' }}>
              <div className="card-b">
                <strong>Not saved — nothing was written.</strong>
                <ul style={{ margin: '8px 0 0' }}>
                  {errors.map((e, i) => <li key={i} className="text-sm">{e}</li>)}
                </ul>
              </div>
            </div>
          )}

          {msg && <p className="text-sm mt-2">{msg}</p>}

          {data.retired.length > 0 && (
            <div className="card mt-4">
              <div className="card-h"><h3>Superseded bands</h3><span className="meta">{data.retired.length} retained</span></div>
              <div className="card-b">
                <p className="text-sm text-mute" style={{ marginTop: 0 }}>
                  These were retired rather than deleted, so the history of what used to apply is still
                  recoverable. They carry no routing weight.
                </p>
                <table className="tbl">
                  <thead><tr><th>Amount band</th><th>Approver(s)</th><th>Status</th></tr></thead>
                  <tbody>
                    {data.retired.map((b, i) => (
                      <tr key={b.id ?? i}>
                        <td>{pkr(b.amountMin)} – {pkr(b.amountMax)}</td>
                        <td>{rolesText(b)}</td>
                        <td><span className="pill draft">{b.category ? 'superseded' : 'retired single-table band'}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </Shell>
  );
}
