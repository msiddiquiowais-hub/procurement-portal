// `settings` — Settings.
//
// Port of renderSettings (blueprint Part 10). Eleven toggles and six scalars, in the
// prototype's own groups, with the prototype's exact labels and defaults.
//
// ONE FIELD IS NOT WHAT IT LOOKS LIKE. "Management threshold (PKR Cr)" reads the
// live value from workflow.config — the number the routing engine actually uses — and
// saving it writes straight back there. It is NOT stored in this screen's own table,
// and the UI says so rather than pretending a local copy is authoritative. A second
// writable copy of a governance threshold would be the declared-but-ignored field
// Part 7 already suffered once with conditionValue.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Shell from '../components/Shell';
import { api, type ApiError } from '../lib/api';
import { useSession } from '../lib/session';

type Setting = {
  key: string;
  value: any;
  valueType: 'boolean' | 'int' | 'number' | 'string';
  label: string;
  description: string | null;
  group: string;
  isToggle: boolean;
  sortOrder: number;
  canonicalSource: string | null;
};

type Threshold = {
  value: number; // PKR, the engine's own unit
  displayCr: number;
  source: string;
  editable: boolean;
  unit: string;
  writesTo: string;
};

type SettingsData = {
  settings: Setting[];
  groups: string[];
  managementThreshold: Threshold;
};

const THRESHOLD_KEY = 'managementThreshold';

export default function SettingsPage() {
  const { session } = useSession();
  const user = session?.user;
  const [data, setData] = useState<SettingsData | null>(null);
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [err, setErr] = useState<string>('');
  const [msg, setMsg] = useState<string>('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data: d } = await api.get('/admin/settings');
      setData(d);
      setDraft({});
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const valueOf = (s: Setting) => (s.key in draft ? draft[s.key] : s.value);

  const set = (s: Setting, v: any) => setDraft((d) => ({ ...d, [s.key]: v }));

  // The threshold is not a catalogue row, so it has its own draft slot under a
  // key the API routes to workflow.config rather than to core.settings.
  const thresholdValue =
    THRESHOLD_KEY in draft ? draft[THRESHOLD_KEY] : data?.managementThreshold.displayCr;

  const pending = Object.keys(draft);
  const toggles = useMemo(() => (data?.settings ?? []).filter((s) => s.isToggle), [data]);
  const scalars = useMemo(() => (data?.settings ?? []).filter((s) => !s.isToggle), [data]);

  const save = async () => {
    setBusy(true);
    setErr('');
    setMsg('');
    setWarnings([]);
    try {
      const r = await api.patch('/admin/settings', draft);
      const updated: string[] = r.data?.updated ?? [];
      setWarnings(r.data?.warnings ?? []);
      setMsg(`Saved ${updated.length} setting${updated.length === 1 ? '' : 's'}.`);
      await load();
    } catch (e) {
      const ae = e as ApiError;
      setErr(ae.errors?.length ? ae.errors.join(' · ') : ae.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleRow = (s: Setting) => (
    <div className="toggle-row" key={s.key}>
      <label style={{ flex: 1 }}>
        <div>{s.label}</div>
        {s.description && <div className="text-sm text-mute">{s.description}</div>}
      </label>
      <input
        type="checkbox"
        checked={Boolean(valueOf(s))}
        onChange={(e) => set(s, e.target.checked)}
      />
    </div>
  );

  return (
    <Shell title="Settings" subtitle="How this instance behaves" screenId="settings">
      {err && (
        <div className="card mb-4" style={{ borderColor: 'var(--danger)' }}>
          <div className="card-b">Not saved — nothing was written. {err}</div>
        </div>
      )}

      {!data && !err && <div className="card"><div className="card-b">Loading settings…</div></div>}

      {data && (
        <>
          <div className="card mb-4">
            <div className="card-h"><h3>Workflow &amp; approvals</h3><span className="meta">Thresholds and routing</span></div>
            <div className="card-b">
              {/* The management threshold, rendered from `data.managementThreshold`
                  rather than from a catalogue row. Migration 036 deleted the
                  `mgmtThresholdCr` alias that used to sit here: it held a second
                  number the routing engine never read. This field IS the engine's
                  value, and saving it writes straight back to workflow.config. */}
              <div className="toggle-row">
                <label style={{ flex: 1 }}>
                  <div>Management threshold ({data.managementThreshold.unit})</div>
                  <div className="text-sm text-mute">
                    Items above the management threshold route to Management review before the CFO.
                    Lowering it changes which PRs the engine escalates.
                  </div>
                  <div className="text-sm" style={{ color: 'var(--accent)' }}>
                    Stored in {data.managementThreshold.writesTo} — the value the routing engine
                    reads on every PR advance. This screen keeps no copy of its own.
                  </div>
                </label>
                <input
                  className="input"
                  style={{ width: 140 }}
                  type="number"
                  step={0.0001}
                  value={thresholdValue ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, [THRESHOLD_KEY]: Number(e.target.value) }))}
                />
              </div>
              {scalars
                .filter((s) => s.group === 'Workflow & approvals')
                .map((s) => (
                  <div className="toggle-row" key={s.key}>
                    <label style={{ flex: 1 }}>
                      <div>{s.label}</div>
                      {s.description && <div className="text-sm text-mute">{s.description}</div>}
                    </label>
                    <input
                      className="input"
                      style={{ width: 140 }}
                      type="number"
                      step={s.valueType === 'int' ? 1 : 0.0001}
                      value={valueOf(s) ?? ''}
                      onChange={(e) => set(s, Number(e.target.value))}
                    />
                  </div>
                ))}
            </div>
          </div>

          <div className="card mb-4">
            <div className="card-h"><h3>Notifications</h3><span className="meta">{toggles.filter((s) => s.group === 'Notifications').length} toggles</span></div>
            <div className="card-b">
              {toggles.filter((s) => s.group === 'Notifications').map(toggleRow)}
            </div>
          </div>

          <div className="card mb-4">
            <div className="card-h"><h3>D365 integration</h3><span className="meta">push and mapping</span></div>
            <div className="card-b">
              {toggles.filter((s) => s.group === 'D365 integration').map(toggleRow)}
              {scalars
                .filter((s) => s.group === 'D365 integration')
                .map((s) => (
                  <div className="toggle-row" key={s.key}>
                    <label style={{ flex: 1 }}>
                      <div>{s.label}</div>
                      {s.description && <div className="text-sm text-mute">{s.description}</div>}
                    </label>
                    {s.valueType === 'string' ? (
                      <select
                        className="input"
                        style={{ width: 140 }}
                        value={String(valueOf(s) ?? 'PROD')}
                        onChange={(e) => set(s, e.target.value)}
                      >
                        {['PROD', 'UAT', 'SANDBOX'].map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    ) : (
                      <input
                        className="input"
                        style={{ width: 140 }}
                        type="number"
                        value={valueOf(s) ?? ''}
                        onChange={(e) => set(s, Number(e.target.value))}
                      />
                    )}
                  </div>
                ))}
            </div>
          </div>

          {(['Display', 'Attachments'] as const).map((g) => {
            const rows = data.settings.filter((s) => s.group === g);
            if (!rows.length) return null;
            return (
              <div className="card mb-4" key={g}>
                <div className="card-h">
                  <h3>{g}</h3>
                  <span className="meta">{rows.length} setting{rows.length === 1 ? '' : 's'}</span>
                </div>
                <div className="card-b">
                  {rows.filter((s) => s.isToggle).map(toggleRow)}
                  {rows.filter((s) => !s.isToggle).map((s) => (
                    <div className="toggle-row" key={s.key}>
                      <label style={{ flex: 1 }}>
                        <div>{s.label}</div>
                        {s.description && <div className="text-sm text-mute">{s.description}</div>}
                      </label>
                      <input
                        className="input"
                        style={{ width: 160 }}
                        type="number"
                        value={valueOf(s) ?? ''}
                        onChange={(e) => set(s, Number(e.target.value))}
                      />
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          <div className="btn-row">
            <button className="btn primary" disabled={pending.length === 0 || busy} onClick={save}>
              {busy ? 'Saving…' : `Save${pending.length ? ` (${pending.length})` : ''}`}
            </button>
            <button
              className="btn ghost"
              disabled={pending.length === 0 || busy}
              onClick={() => { setDraft({}); setErr(''); setMsg(''); setWarnings([]); }}
            >
              Discard
            </button>
            {pending.length === 0 && <span className="text-sm text-mute">No changes to save.</span>}
          </div>

          {warnings.length > 0 && (
            <ul className="text-sm mt-2">
              {warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
          {msg && <p className="text-sm mt-2">{msg}</p>}

          <p className="text-sm text-mute mt-4">
            {data.settings.length} settings in the catalog. The routing threshold currently resolves from{' '}
            <code>{data.managementThreshold.source}</code> at {data.managementThreshold.displayCr} PKR Cr.
            {user ? ` You are acting as ${user.role}.` : ''}
          </p>
        </>
      )}
    </Shell>
  );
}
