// `admin-uom` — D365 UOM Admin.
//
// Port of renderD365Uom (blueprint Part 8.3). The prototype stores the UOM library
// in localStorage; the port stores it in core.uom and enforces it with a foreign key
// on proc.pr_lines.uom (migration 034), so a unit a PR line does not recognise is
// rejected by the database, not merely absent from a dropdown.
//
// THE TWO COUNTS ARE NOT COMPLEMENTS. "18 D365 catalog units" and "10 light-flow
// units" overlap in nine, and LEASE belongs only to the light flow. Negating one
// flag to derive the other would report 9 instead of 18, so both are reported
// separately and the overlap is stated rather than left for the reader to infer.

import { useCallback, useEffect, useState } from 'react';
import Shell from '../components/Shell';
import { api, type ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { canSeeScreen } from '@procurement/roles';

type Uom = {
  code: string;
  name: string;
  active: boolean;
  inD365Catalog: boolean;
  lightFlow: boolean;
  sortOrder: number;
};

type UomData = {
  uoms: Uom[];
  counts: {
    d365Catalog: number; lightFlow: number; inBoth: number;
    lightFlowOnly: number; total: number;
  };
};

export default function AdminUom() {
  const { session } = useSession();
  const user = session?.user;
  const [data, setData] = useState<UomData | null>(null);
  const [filter, setFilter] = useState('');
  const [msg, setMsg] = useState<string>('');
  const [err, setErr] = useState<string>('');
  const [busy, setBusy] = useState('');

  const allowed = user ? canSeeScreen(user.role, 'admin-uom') : false;

  const load = useCallback(async () => {
    try {
      const { data: d } = await api.get('/admin/uom');
      setData(d);
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
      setErr(ae.message);
    } finally {
      setBusy('');
    }
  };

  const save = (u: Uom, next: Partial<Uom>) =>
    act(`save-${u.code}`, async () => {
      await api.put(`/admin/uom/${encodeURIComponent(u.code)}`, next);
      await load();
      setMsg(`Saved ${u.code}.`);
    });

  const add = () =>
    act('add', async () => {
      const code = (globalThis.prompt?.('New UOM code (letters and digits, e.g. PALLET)') ?? '').trim();
      if (!code) return;
      const name = (globalThis.prompt?.(`Name for ${code}`) ?? '').trim();
      if (!name) return;
      await api.post('/admin/uom', { code, name });
      await load();
      setMsg(`Added ${code.toUpperCase()} to the catalog.`);
    });

  const remove = (u: Uom) =>
    act(`del-${u.code}`, async () => {
      await api.del(`/admin/uom/${encodeURIComponent(u.code)}`);
      await load();
      setMsg(`Deleted ${u.code}.`);
    });

  const q = filter.toLowerCase();
  const shown = (data?.uoms ?? []).filter(
    (u) => !q || u.code.toLowerCase().includes(q) || u.name.toLowerCase().includes(q),
  );

  return (
    <Shell title="D365 UOM" subtitle="Units of measure sent to D365 as PurchUnit" screenId="admin-uom">
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

      {allowed && !data && <div className="card"><div className="card-b">Loading the UOM catalog…</div></div>}

      {allowed && data && (
        <>
          <div className="card mb-4">
            <div className="card-h"><h3>The catalog in numbers</h3><span className="meta">two overlapping sets</span></div>
            <div className="card-b">
              <div className="stat-row">
                <div><div className="stat-n">{data.counts.d365Catalog}</div><div className="text-sm text-mute">in the D365 catalog</div></div>
                <div><div className="stat-n">{data.counts.lightFlow}</div><div className="text-sm text-mute">offered by the light flow</div></div>
                <div><div className="stat-n">{data.counts.inBoth}</div><div className="text-sm text-mute">in both sets</div></div>
                <div><div className="stat-n">{data.counts.lightFlowOnly}</div><div className="text-sm text-mute">light flow only</div></div>
                <div><div className="stat-n">{data.counts.total}</div><div className="text-sm text-mute">in the catalog</div></div>
              </div>
              <p className="text-sm text-mute" style={{ marginBottom: 0 }}>
                {data.counts.inBoth} units are in both sets and {data.counts.lightFlowOnly} is in the light flow
                only, so the two totals are not complements. <strong>LEASE</strong> is that one: the prototype&apos;s
                light-flow form offers it and a seeded light request uses it, while the prototype&apos;s own
                18-row library omitted it — a contradiction corrected here rather than reproduced.
              </p>
            </div>
          </div>

          <div className="card">
            <div className="card-h">
              <h3>Units</h3>
              <span className="meta">a code is sent verbatim to D365</span>
            </div>
            <div className="card-b">
              <div className="row-between mb-2">
                <input
                  className="input"
                  placeholder="Search code or name…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                <button className="btn ghost sm" disabled={busy === 'add'} onClick={add}>+ Add unit</button>
              </div>

              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 110 }}>code</th>
                    <th>name</th>
                    <th style={{ width: 150 }}>sets</th>
                    <th style={{ width: 80 }}>active</th>
                    <th style={{ width: 40 }} />
                  </tr>
                </thead>
                <tbody>
                  {shown.length === 0 && (
                    <tr><td colSpan={5} className="text-mute">No units match “{filter}”.</td></tr>
                  )}
                  {shown.map((u) => (
                    <tr key={u.code} style={u.active ? undefined : { opacity: 0.55 }}>
                      <td><code>{u.code}</code></td>
                      <td>
                        <input
                          className="input"
                          defaultValue={u.name}
                          onBlur={(e) => {
                            const name = e.target.value.trim();
                            if (name && name !== u.name) save(u, { name });
                          }}
                        />
                      </td>
                      <td>
                        <label className="text-sm" style={{ marginRight: 10 }}>
                          <input
                            type="checkbox"
                            checked={u.inD365Catalog}
                            onChange={(e) => save(u, { inD365Catalog: e.target.checked })}
                          /> D365
                        </label>
                        <label className="text-sm">
                          <input
                            type="checkbox"
                            checked={u.lightFlow}
                            onChange={(e) => save(u, { lightFlow: e.target.checked })}
                          /> light
                        </label>
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={u.active}
                          onChange={(e) => save(u, { active: e.target.checked })}
                        />
                      </td>
                      <td>
                        <button
                          className="btn ghost sm danger"
                          disabled={busy === `del-${u.code}`}
                          onClick={() => {
                            if (globalThis.confirm?.(
                              `Delete ${u.code}? If any PR line still uses it the database will refuse.`,
                            )) remove(u);
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
        </>
      )}

      {allowed && msg && <p className="text-sm mt-2">{msg}</p>}
    </Shell>
  );
}
