// `admin-dimensions` — D365 Dimensions Admin.
//
// Port of renderD365Dimensions (blueprint Part 8.2). One table per dimension (9),
// each headed by the dimension label plus a MANDATORY / OPTIONAL tag and the meta
// `D365 api: {apiName} · {n} values`. Columns: `code` (inline edit) · `name`
// (inline edit) · `active` (checkbox) · `×` (delete). Per-table search filter.
//
// The prototype persisted this in localStorage; the port persists it in
// core.dimension_values through /admin/dimensions, so a value added here is the
// value a D365 dimension picker offers.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Shell from '../components/Shell';
import { api, type ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { canSeeScreen } from '@procurement/roles';

type DimValue = {
  id: string;
  code: string;
  name: string;
  active: boolean;
  isPlaceholder: boolean;
  sortOrder: number;
};

type Dimension = {
  key: string;
  label: string;
  apiName: string;
  tag: 'MANDATORY' | 'OPTIONAL';
  mandatory: boolean;
  description: string | null;
  values: DimValue[];
};

export default function AdminDimensions() {
  const { session } = useSession();
  const user = session?.user;
  const [dims, setDims] = useState<Dimension[]>([]);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string>('');
  const [err, setErr] = useState<string>('');
  const [busy, setBusy] = useState<string>('');



  const allowed = user ? canSeeScreen(user.role, 'admin-dimensions') : false;

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/dimensions');
      setDims(data.dimensions);
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (allowed) load();
  }, [allowed, load]);

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setErr('');
    setMsg('');
    try {
      await fn();
    } catch (e) {
      const ae = e as ApiError;
      setErr(ae.errors?.length ? ae.errors.join(' · ') : ae.message);
    } finally {
      setBusy('');
    }
  };

  const saveValue = (dimKey: string, v: DimValue, next: Partial<DimValue>) =>
    act(`save-${v.id}`, async () => {
      await api.put(`/admin/dimensions/${encodeURIComponent(dimKey)}/values`, {
        id: v.id,
        code: next.code ?? v.code,
        name: next.name ?? v.name,
        active: next.active ?? v.active,
      });
      await load();
      setMsg(`Saved “${next.name ?? v.name}”.`);
    });

  const addValue = (dimKey: string) =>
    act(`add-${dimKey}`, async () => {
      const code = (globalThis.prompt?.(`New ${dimKey} value code (e.g. NEW-01)`) ?? '').trim();
      if (!code) return;
      const name = (globalThis.prompt?.(`Name for ${code}`) ?? '').trim();
      if (!name) return;
      await api.post(`/admin/dimensions/${encodeURIComponent(dimKey)}/values`, { code, name });
      await load();
      setMsg(`Added ${code} to ${dimKey}.`);
    });

  const deleteValue = (dimKey: string, v: DimValue) =>
    act(`del-${v.id}`, async () => {
      const r = await api.del(`/admin/dimensions/${encodeURIComponent(dimKey)}/values/${v.id}`);
      await load();
      setMsg(r.data?.warning ? r.data.warning : `Deleted “${v.code}”.`);
    });

  const total = useMemo(() => dims.reduce((n, d) => n + d.values.length, 0), [dims]);


  return (
    <Shell
      title="D365 Dimensions"
      subtitle="The value library each financial dimension offers"
      screenId="admin-dimensions"
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

      {allowed && !err && dims.length === 0 && (
        <div className="card"><div className="card-b">Loading the dimension libraries…</div></div>
      )}

      {allowed && dims.length > 0 && (
        <p className="text-sm text-mute" style={{ marginTop: 0 }}>
          {dims.length} dimensions · {total} values. These are the values a financial-dimension picker offers,
          and they are written to <code>core.dimension_values</code> — not to browser storage.
        </p>
      )}

      {allowed && dims.map((d) => {
        const q = (filters[d.key] ?? '').toLowerCase();
        const shown = q
          ? d.values.filter((v) =>
              v.code.toLowerCase().includes(q) || v.name.toLowerCase().includes(q))
          : d.values;
        return (
          <div className="card mb-4" key={d.key}>
            <div className="card-h">
              <h3>
                {d.label}{' '}
                <span className={`pill ${d.mandatory ? 'approved' : 'draft'}`}>{d.tag}</span>
              </h3>
              <span className="meta">D365 api: {d.apiName} · {d.values.length} values</span>
            </div>
            <div className="card-b">
              <div className="row-between mb-2">
                <input
                  className="input"
                  placeholder={`Search ${d.label}…`}
                  value={filters[d.key] ?? ''}
                  onChange={(e) => setFilters((f) => ({ ...f, [d.key]: e.target.value }))}
                />
                <button
                  className="btn ghost sm"
                  disabled={busy === `add-${d.key}`}
                  onClick={() => addValue(d.key)}
                >
                  + Add value
                </button>
              </div>

              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: '28%' }}>code</th>
                    <th>name</th>
                    <th style={{ width: 90 }}>active</th>
                    <th style={{ width: 40 }} />
                  </tr>
                </thead>
                <tbody>
                  {shown.length === 0 && (
                    <tr><td colSpan={4} className="text-mute">No values match “{filters[d.key]}”.</td></tr>
                  )}
                  {shown.map((v) => (
                    <tr key={v.id} style={v.active ? undefined : { opacity: 0.55 }}>
                      <td>
                        <input
                          className="input"
                          defaultValue={v.code}
                          onBlur={(e) => {
                            const code = e.target.value.trim();
                            if (code && code !== v.code) saveValue(d.key, v, { code });
                          }}
                        />
                        {v.isPlaceholder && (
                          <div className="text-sm text-mute">
                            placeholder — selects “no value”, which still fails a non-empty mandatory check
                          </div>
                        )}
                      </td>
                      <td>
                        <input
                          className="input"
                          defaultValue={v.name}
                          onBlur={(e) => {
                            const name = e.target.value.trim();
                            if (name && name !== v.name) saveValue(d.key, v, { name });
                          }}
                        />
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={v.active}
                          onChange={(e) => saveValue(d.key, v, { active: e.target.checked })}
                        />
                      </td>
                      <td>
                        <button
                          className="btn ghost sm danger"
                          disabled={busy === `del-${v.id}`}
                          onClick={() => {
                            if (globalThis.confirm?.(`Delete “${v.code}” from ${d.label}?`)) {
                              deleteValue(d.key, v);
                            }
                          }}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      {allowed && msg && <p className="text-sm">{msg}</p>}
    </Shell>
  );
}
