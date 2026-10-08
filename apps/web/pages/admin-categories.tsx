// `admin-categories` — the line-category library.
//
// Follows admin-uom deliberately: same Shell, same role gate, same
// "report the dependent rows before the FK refuses" rule. Categories differ from
// UOMs in one way that the screen has to make obvious, and that is the whole
// reason it exists as its own page rather than being folded into admin-uom.
//
// ─── A CATEGORY HERE IS SELECTABLE, NOT ROUTED ────────────────────────────────
//
// This table feeds two different consumers:
//
//   1. GET /lookups/categories  → the CATEGORY dropdown on /pr/new
//   2. proc.pr_lines.category   → a foreign key, so a line cannot carry a
//                                 category this table does not list
//
// Neither of those makes a line ROUTED. Routing lives in the workflow engine:
// a line rule fires only when proc.pr_lines.category equals one of
// LIGHT_ITEM_CATEGORY_IDS. So a row added here is immediately selectable and
// immediately storable, and it will match no approval rule until the same code
// is added to packages/workflow-engine/src/categories.ts.
//
// That is the failure this screen is built to make visible: the line is never
// rejected and never routed, so nothing anywhere complains. Every row therefore
// carries a routable flag, unroutable rows are badged, and a bulk import reports
// how many of the rows it just loaded cannot route. The screen does not block
// the edit — a category is reference data and adding one is legitimate — but it
// will not let an admin believe the edit did more than it did.
//
// The BULK IMPORT panel posts raw CSV text rather than a multipart upload, so
// this screen and scripts/import_categories.mjs go through the same parser and
// the same validation. Two parsers would drift.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Shell from '../components/Shell';
import ManageVendorsModal from '../components/ManageVendorsModal';
import { api, type ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { canSeeScreen } from '@procurement/roles';

type Category = {
  code: string;
  name: string;
  description: string | null;
  active: boolean;
  routable: boolean;
  itemCount: number;
  lineCount: number;
  vendorCount: number;
  vendorInactiveCount: number;
};

type CategoryData = {
  categories: Category[];
  counts: { total: number; active: number; unroutable: number; selectable: number };
};

type ImportResult = {
  mode: string;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  created: string[];
  updated: string[];
  skipped: string[];
  errorCount: number;
  errors: Array<{ line: number; code: string; reason: string }>;
  unroutable: string[];
  warning: string | null;
};

const TEMPLATE = `code,name,description
IT_HARDWARE,IT hardware,"Laptops, desktops, servers, networking equipment."
CHEMICALS,Chemicals,"Lab reagents, solvents and consumable chemicals."`;

export default function AdminCategories() {
  const { session } = useSession();
  const user = session?.user;
  const [data, setData] = useState<CategoryData | null>(null);
  const [filter, setFilter] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  // Add form
  const [nCode, setNCode] = useState('');
  const [nName, setNName] = useState('');
  const [nDesc, setNDesc] = useState('');

  // Edit form — which code is currently being edited, if any
  const [editing, setEditing] = useState<string | null>(null);
  const [eName, setEName] = useState('');
  const [eDesc, setEDesc] = useState('');

  // Bulk import
  const [csv, setCsv] = useState('');
  const [importMode, setImportMode] = useState<'merge' | 'insert'>('merge');
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  // Which line category's vendor list is open in the Manage Vendors modal.
  const [manage, setManage] = useState<{ code: string; label: string } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const allowed = user ? canSeeScreen(user.role, 'admin-categories') : false;

  const load = useCallback(async () => {
    try {
      const { data: d } = await api.get<CategoryData>('/admin/categories');
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
      setErr((e as ApiError).message);
    } finally {
      setBusy('');
    }
  };

  const add = () =>
    act('add', async () => {
      if (!nCode.trim() || !nName.trim()) {
        setErr('A category needs both a code and a name.');
        return;
      }
      const { data: res } = await api.post<{ code: string; routable: boolean; warning: string | null }>(
        '/admin/categories',
        { code: nCode.trim(), name: nName.trim(), description: nDesc.trim() || undefined },
      );
      await load();
      setNCode(''); setNName(''); setNDesc('');
      // The warning is the whole point of the create path — surface it, do not swallow it.
      setMsg(res.warning ? `Added ${res.code}. ${res.warning}` : `Added ${res.code}.`);
    });

  const saveEdit = (c: Category) =>
    act(`save-${c.code}`, async () => {
      await api.put(`/admin/categories/${encodeURIComponent(c.code)}`, {
        name: eName.trim(),
        description: eDesc,
      });
      await load();
      setEditing(null);
      setMsg(`Saved ${c.code}.`);
    });

  const toggleActive = (c: Category) =>
    act(`toggle-${c.code}`, async () => {
      try {
        await api.put(`/admin/categories/${encodeURIComponent(c.code)}`, { active: !c.active });
        await load();
        setMsg(`${c.code} ${c.active ? 'deactivated' : 'reactivated'}.`);
      } catch (e) {
        // Deactivating an in-use category is refused with the dependent counts;
        // show the refusal rather than swallowing it.
        setErr((e as ApiError).message);
      }
    });

  const remove = (c: Category) =>
    act(`del-${c.code}`, async () => {
      await api.del(`/admin/categories/${encodeURIComponent(c.code)}`);
      await load();
      setMsg(`Deleted ${c.code}.`);
    });

  const runImport = () =>
    act('import', async () => {
      if (!csv.trim()) { setErr('Paste CSV text or choose a file first.'); return; }
      const { data: res } = await api.post<ImportResult>('/admin/categories/import', {
        csv, mode: importMode, skipInvalid,
      });
      setImportResult(res);
      await load();
      setMsg(
        `Imported: ${res.createdCount} created, ${res.updatedCount} updated, ` +
        `${res.skippedCount} skipped${res.errorCount ? `, ${res.errorCount} row(s) rejected` : ''}.`
      );
    });

  const onFile = (f: File | undefined) => {
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result ?? ''));
    reader.readAsText(f);
  };

  const q = filter.toLowerCase();
  const shown = (data?.categories ?? []).filter(
    (c) =>
      !q ||
      c.code.toLowerCase().includes(q) ||
      c.name.toLowerCase().includes(q) ||
      (c.description ?? '').toLowerCase().includes(q),
  );

  const unroutableList = useMemo(
    () => (data?.categories ?? []).filter((c) => c.active && !c.routable),
    [data],
  );

  // ── bulk import of vendor <-> line-category links ───────────────────────
  // These states are deliberately separate from the category-library importer
  // above (`csv` / `importMode` / `importResult` / `fileRef`). They used to
  // SHARE `csv`, which quietly meant the vendor panel validated the category
  // textarea, posted its contents to /vendors/categories/import, loaded its
  // template into the wrong box, and rendered its own results behind the
  // other importer's `importResult` guard — so a successful vendor import
  // displayed nothing at all.
  const [vendorCsv, setVendorCsv] = useState('');
  const [vendorImportMode, setVendorImportMode] = useState<'merge' | 'insert'>('merge');
  const [vendorSkipInvalid, setVendorSkipInvalid] = useState(false);
  const [vendorImportResult, setVendorImportResult] = useState<any>(null);
  const [vendorImportOpen, setVendorImportOpen] = useState(true);
  const vendorFileRef = useRef<HTMLInputElement | null>(null);

  const IMPORT_TEMPLATE = `vendor_code,category,is_active
V-00081,OFFICE_SUPPLIES,true
V-00082,Office supplies,true`;

  async function runVendorImport() {
    if (!vendorCsv.trim()) {
      setErr('Paste or upload some CSV first.');
      return;
    }
    await runImportBody(async () => {
      const r = await api.post('/vendors/categories/import', {
        csv: vendorCsv, mode: vendorImportMode, skipInvalid: vendorSkipInvalid,
      });
      setVendorImportResult(r.data);
      await load();
      setMsg(`Imported vendor links: ${r.data.createdCount} created, ${r.data.updatedCount} enabled, `
        + `${r.data.deactivatedCount} deactivated, ${r.data.errorCount} rejected.`);
    });
  }

  const onVendorFile = (f: File | undefined) => {
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => setVendorCsv(String(rd.result ?? ''));
    rd.readAsText(f);
  };

  /** Small adapter: the categories screen has no `act()` helper of its own. */
  async function runImportBody(fn: () => Promise<void>) {
    setBusy('vendor-import');
    try { await fn(); }
    catch (e) { setErr((e as ApiError).message); }
    finally { setBusy(''); }
  }

  return (
    <Shell
      title="Line Categories"
      subtitle="The vocabulary the New Purchase Request category dropdown reads"
      screenId="admin-categories"
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
      {allowed && msg && (
        <div className="card mb-4" style={{ borderColor: 'var(--accent)' }}>
          <div className="card-b">{msg}</div>
        </div>
      )}

      {allowed && !data && <div className="card"><div className="card-b">Loading categories…</div></div>}

      {/* ── bulk import: vendor <-> line category links ───────────────────
          This sits ABOVE the table, not below it. It used to be the last card
          on the page, which meant the feature nobody thinks to scroll for was
          also the feature furthest from the eye when you land here. */}
      {allowed && (
        <div className="card mb-4">
          <div className="card-h">
            <h3>Bulk import vendor links (CSV)</h3>
            <span className="meta">header row required: vendor_code, category, is_active</span>
            <button
              className="btn ghost sm"
              style={{ marginLeft: 'auto' }}
              onClick={() => setVendorImportOpen((o) => !o)}
            >
              {vendorImportOpen ? 'Hide' : 'Show'}
            </button>
          </div>
          {vendorImportOpen && (
            <div className="card-b">
              <div className="row-between mb-2" style={{ flexWrap: 'wrap', gap: 10 }}>
                <button className="btn ghost sm" onClick={() => setVendorCsv(IMPORT_TEMPLATE)}>Load template</button>
                <button className="btn ghost sm" onClick={() => vendorFileRef.current?.click()}>Choose a file…</button>
                <input
                  ref={vendorFileRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }}
                  onChange={(e) => onVendorFile(e.target.files?.[0])}
                />
                <label className="text-sm text-mute">
                  <input type="radio" name="vendorImportMode" checked={vendorImportMode === 'merge'} onChange={() => setVendorImportMode('merge')} />
                  {' '}merge — create missing, change existing
                </label>
                <label className="text-sm text-mute">
                  <input type="radio" name="vendorImportMode" checked={vendorImportMode === 'insert'} onChange={() => setVendorImportMode('insert')} />
                  {' '}insert only — never change an existing link
                </label>
                <label className="text-sm text-mute">
                  <input type="checkbox" checked={vendorSkipInvalid} onChange={(e) => setVendorSkipInvalid(e.target.checked)} />
                  {' '}skip invalid rows
                </label>
                <button className="btn primary sm" disabled={busy === 'vendor-import'} onClick={runVendorImport}>
                  {busy === 'vendor-import' ? 'Importing…' : 'Import CSV'}
                </button>
              </div>
              <textarea
                className="input" rows={5} value={vendorCsv} placeholder={IMPORT_TEMPLATE}
                onChange={(e) => setVendorCsv(e.target.value)}
                style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, width: '100%' }}
              />
              <p className="text-sm text-mute" style={{ marginTop: 6, marginBottom: 0 }}>
                <code>category</code> takes a line category code or its display name
                {' '}(<code>OFFICE_SUPPLIES</code> or <code>Office supplies</code>). Every row is
                validated before anything is written, so a bad row cannot leave a half-applied
                import. This imports <strong>vendor links</strong>; the category library itself is
                imported from the CSV panel further down. The same file runs from the command line
                with <code>npm run import:vendor-categories -- &lt;file&gt;</code>.
              </p>

              {vendorImportResult && (
                <div className="text-sm" style={{ marginTop: 10 }}>
                  <div>
                    <strong>Created {vendorImportResult.createdCount}</strong>
                    {vendorImportResult.created?.length > 0 && <> ({vendorImportResult.created.join(', ')})</>}
                    {' · '}
                    <strong>Enabled {vendorImportResult.updatedCount}</strong>
                    {vendorImportResult.updated?.length > 0 && <> ({vendorImportResult.updated.join(', ')})</>}
                    {' · '}
                    <strong>Deactivated {vendorImportResult.deactivatedCount}</strong>
                    {vendorImportResult.deactivated?.length > 0 && <> ({vendorImportResult.deactivated.join(', ')})</>}
                  </div>
                  {vendorImportResult.errorCount > 0 && (
                    <div style={{ color: 'var(--danger, #c0392b)', marginTop: 4 }}>
                      {vendorImportResult.errorCount} row(s) rejected:
                      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                        {vendorImportResult.errors.slice(0, 15).map((e: any, i: number) => (
                          <li key={i}>line {e.line} ({e.vendor}): {e.reason}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {allowed && data && (
        <>
          <div className="card mb-4">
            <div className="card-h">
              <h3>The library in numbers</h3>
              <span className="meta">selectable is not the same as routable</span>
            </div>
            <div className="card-b">
              <div className="stat-row">
                <div><div className="stat-n">{data.counts.total}</div><div className="text-sm text-mute">in the table</div></div>
                <div><div className="stat-n">{data.counts.active}</div><div className="text-sm text-mute">active</div></div>
                <div><div className="stat-n">{data.counts.selectable}</div><div className="text-sm text-mute">offered and routable</div></div>
                <div>
                  <div className="stat-n" style={data.counts.unroutable ? { color: 'var(--danger, #c0392b)' } : undefined}>
                    {data.counts.unroutable}
                  </div>
                  <div className="text-sm text-mute">offered but unroutable</div>
                </div>
              </div>
              <p className="text-sm text-mute" style={{ marginBottom: 0 }}>
                A row here makes a category <strong>selectable</strong> on the PR form. It does not make
                it <strong>routable</strong>. Routing is decided by the workflow engine, and a line
                rule only fires for a code the engine knows. A category the engine does not know is
                still accepted on a line, and then matches no rule — so the line is never rejected
                and never routed, and nothing complains.
              </p>
            </div>
          </div>

          {unroutableList.length > 0 && (
            <div className="card mb-4" style={{ borderColor: 'var(--warn, #b8860b)' }}>
              <div className="card-b">
                <strong>{unroutableList.length} active categor{unroutableList.length > 1 ? 'ies are' : 'y is'} offered but unroutable:</strong>{' '}
                {unroutableList.map((c) => c.code).join(', ')}. To route {unroutableList.length > 1 ? 'them' : 'it'},
                add {unroutableList.length > 1 ? 'them' : 'it'} to <code>LIGHT_ITEM_CATEGORIES</code> in
                <code> packages/workflow-engine/src/categories.ts</code> and extend the line rules in
                <code> workflow.steps_config</code>. That is a code change — it cannot be done from this screen.
              </div>
            </div>
          )}

          <div className="card mb-4">
            <div className="card-h"><h3>Add a category</h3><span className="meta">appears in the PR dropdown immediately</span></div>
            <div className="card-b">
              <div className="row-between" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 10 }}>
                <div style={{ flex: '1 1 190px' }}>
                  <label className="text-sm text-mute" htmlFor="nc-code">Code *</label>
                  <input id="nc-code" className="input" value={nCode} placeholder="CHEMICALS"
                    onChange={(e) => setNCode(e.target.value)} />
                </div>
                <div style={{ flex: '2 1 200px' }}>
                  <label className="text-sm text-mute" htmlFor="nc-name">Name *</label>
                  <input id="nc-name" className="input" value={nName} placeholder="Chemicals"
                    onChange={(e) => setNName(e.target.value)} />
                </div>
                <div style={{ flex: '3 1 260px' }}>
                  <label className="text-sm text-mute" htmlFor="nc-desc">Description</label>
                  <input id="nc-desc" className="input" value={nDesc} placeholder="Lab reagents, solvents and consumable chemicals."
                    onChange={(e) => setNDesc(e.target.value)} />
                </div>
                <button className="btn primary" disabled={busy === 'add'} onClick={add}>+ Add category</button>
              </div>
              <p className="text-sm text-mute" style={{ marginTop: 8, marginBottom: 0 }}>
                Codes are upper-cased and stored verbatim on <code>proc.pr_lines.category</code>, so
                they may contain letters, digits and underscores only.
              </p>
            </div>
          </div>

          <div className="card mb-4">
            <div className="card-h">
              <h3>Bulk import (CSV)</h3>
              <span className="meta">header row required: code, name, description</span>
            </div>
            <div className="card-b">
              <div className="row-between mb-2" style={{ flexWrap: 'wrap', gap: 10 }}>
                <button className="btn ghost sm" onClick={() => setCsv(TEMPLATE)}>Load template</button>
                <button className="btn ghost sm" onClick={() => fileRef.current?.click()}>Choose a file…</button>
                <input
                  ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }}
                  onChange={(e) => onFile(e.target.files?.[0])}
                />
                <label className="text-sm text-mute">
                  <input type="radio" checked={importMode === 'merge'} onChange={() => setImportMode('merge')} />
                  {' '}merge — insert new, update existing
                </label>
                <label className="text-sm text-mute">
                  <input type="radio" checked={importMode === 'insert'} onChange={() => setImportMode('insert')} />
                  {' '}insert only — never overwrite
                </label>
                <label className="text-sm text-mute">
                  <input type="checkbox" checked={skipInvalid} onChange={(e) => setSkipInvalid(e.target.checked)} />
                  {' '}skip invalid rows
                </label>
                <button className="btn primary sm" disabled={busy === 'import'} onClick={runImport}>
                  {busy === 'import' ? 'Importing…' : 'Import CSV'}
                </button>
              </div>
              <textarea
                className="input" rows={5} value={csv} placeholder={TEMPLATE}
                onChange={(e) => setCsv(e.target.value)}
                style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, width: '100%' }}
              />
              <p className="text-sm text-mute" style={{ marginTop: 6, marginBottom: 0 }}>
                Every row is validated before anything is written, so a bad row cannot leave a
                half-applied import. Without <em>skip invalid rows</em> the whole file is refused and
                the first bad rows are named by line number. The same CSV runs from the command line
                with <code>npm run import:categories -- &lt;file&gt;</code>.
              </p>

              {importResult && (
                <div style={{ marginTop: 10 }} className="text-sm">
                  <div>
                    <strong>Created {importResult.createdCount}</strong>
                    {importResult.created.length > 0 && <> ({importResult.created.join(', ')})</>}
                    {' · '}
                    <strong>Updated {importResult.updatedCount}</strong>
                    {importResult.updated.length > 0 && <> ({importResult.updated.join(', ')})</>}
                    {' · '}
                    <strong>Skipped {importResult.skippedCount}</strong>
                    {importResult.skipped.length > 0 && <> ({importResult.skipped.join(', ')})</>}
                  </div>
                  {importResult.errorCount > 0 && (
                    <div style={{ color: 'var(--danger, #c0392b)', marginTop: 4 }}>
                      {importResult.errorCount} row(s) rejected:{' '}
                      {importResult.errors.slice(0, 6).map((e) => `line ${e.line} (${e.code || 'blank'}) — ${e.reason}`).join('; ')}
                    </div>
                  )}
                  {importResult.warning && (
                    <div style={{ color: 'var(--warn, #b8860b)', marginTop: 4 }}>{importResult.warning}</div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-h">
              <h3>Categories</h3>
              <span className="meta">{shown.length} of {data.categories.length}</span>
            </div>
            <div className="card-b">
              {/* Vendors map to THESE SAME rows. That used to be false — vendor
                  mapping pointed at the D365 ItemGroup dimension, and this
                  paragraph existed to send people to /admin-dimensions. Migration
                  051 repointed the junction at core.categories, so there is one
                  vocabulary, one screen, and the split that made the vendor list
                  unreadable no longer exists. */}
              <p className="text-sm text-mute" style={{ marginTop: 0 }}>
                These are <strong>PR line</strong> categories — what a requisition line is about —
                and they are also the rows a <strong>vendor</strong> is mapped to. The
                {' '}<em>vendors</em> column counts the active mappings; <em>Manage vendors</em> opens
                the two-way editor for that one category. Deactivating a link keeps it readable and
                audited but stops it routing, which is why the switched-off count is shown apart
                from the active one.
              </p>

              <div className="row-between mb-2">
                <input
                  className="input" placeholder="Search code, name or description…"
                  value={filter} onChange={(e) => setFilter(e.target.value)}
                />
              </div>

              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 170 }}>code</th>
                    <th style={{ width: 180 }}>name</th>
                    <th>description</th>
                    <th style={{ width: 110 }}>used by</th>
                    <th style={{ width: 130 }}>routing</th>
                    <th style={{ width: 70 }}>active</th>
                    {/* Vendors get their own column rather than living inside the
                        action cell. A count is a fact about the row; an action is
                        something you do to it, and mixing the two made the actions
                        clump and the count impossible to scan down the page. */}
                    <th style={{ width: 190 }}>vendors</th>
                    <th style={{ width: 220 }} />
                  </tr>
                </thead>
                <tbody>
                  {shown.length === 0 && (
                    <tr><td colSpan={8} className="text-mute">No categories match “{filter}”.</td></tr>
                  )}
                  {shown.map((c) => (
                    <tr key={c.code} style={c.active ? undefined : { opacity: 0.55 }}>
                      <td><code>{c.code}</code></td>
                      <td>
                        {editing === c.code ? (
                          <input className="input sm" value={eName} onChange={(e) => setEName(e.target.value)} />
                        ) : (
                          c.name
                        )}
                      </td>
                      <td>
                        {editing === c.code ? (
                          <input className="input sm" value={eDesc} placeholder="Description"
                            onChange={(e) => setEDesc(e.target.value)} />
                        ) : (
                          <span className="text-mute">{c.description || '—'}</span>
                        )}
                      </td>
                      <td className="text-sm text-mute">
                        {c.itemCount} item{c.itemCount === 1 ? '' : 's'} · {c.lineCount} line{c.lineCount === 1 ? '' : 's'}
                      </td>
                      <td>
                        {c.routable
                          ? <span className="text-sm">routable</span>
                          : (
                            <span
                              className="text-sm"
                              style={{ color: 'var(--warn, #b8860b)' }}
                              title="Not in LIGHT_ITEM_CATEGORIES, so no line rule can match it"
                            >
                              unroutable
                            </span>
                          )}
                      </td>
                      <td>{c.active ? 'yes' : <span className="text-mute">no</span>}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span
                            className={c.vendorCount === 0 ? 'pill' : 'pill info'}
                            title={
                              c.vendorCount === 0
                                ? 'No active vendor serves this category, so an RFQ on it would find nobody'
                                : `${c.vendorCount} active vendor mapping(s)`
                            }
                            style={c.vendorCount === 0 ? { opacity: 0.7 } : undefined}
                          >
                            {c.vendorCount} vendor{c.vendorCount === 1 ? '' : 's'}
                          </span>
                          {/* Kept separate from the active count rather than merged
                              into it. "3 active, 2 turned off" is the whole fact;
                              a single "5" makes a switched-off vendor look live. */}
                          {c.vendorInactiveCount > 0 && (
                            <span className="text-sm text-mute" title="Deactivated mappings — still readable and audited, no longer routing">
                              +{c.vendorInactiveCount} off
                            </span>
                          )}
                          <button
                            className="btn ghost sm"
                            onClick={() => setManage({ code: c.code, label: `${c.code} · ${c.name}` })}
                          >
                            Manage vendors
                          </button>
                        </div>
                      </td>
                      {/* Category-level record maintenance. Its own cell, its own
                          group — not shuffled in with the vendor mapping control
                          above, so a mis-click cannot delete a category when the
                          intent was to look at who supplies it. */}
                      <td>
                        {editing === c.code ? (
                          <>
                            <button className="btn primary sm" disabled={busy === `save-${c.code}`}
                              onClick={() => saveEdit(c)}>Save</button>{' '}
                            <button className="btn ghost sm" onClick={() => setEditing(null)}>Cancel</button>
                          </>
                        ) : (
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            <button className="btn ghost sm" onClick={() => {
                              setEditing(c.code); setEName(c.name); setEDesc(c.description ?? '');
                            }}>Edit</button>
                            <button className="btn ghost sm" disabled={busy === `toggle-${c.code}`}
                              onClick={() => toggleActive(c)}>{c.active ? 'Disable' : 'Enable'}</button>
                            <button className="btn ghost sm" disabled={busy === `del-${c.code}`}
                              onClick={() => remove(c)}>Delete</button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-sm text-mute" style={{ marginTop: 10, marginBottom: 0 }}>
                A category in use cannot be disabled or deleted. The count above is why: stored lines
                and catalogue items would be left pointing at something the PR form can no longer
                offer. The API refuses with the exact numbers rather than letting the foreign key fail
                with a constraint name.
              </p>
            </div>
          </div>
        </>
      )}
      {allowed && msg && <p className="text-sm">{msg}</p>}

      {manage && (
        <ManageVendorsModal
          code={manage.code}
          label={manage.label}
          onClose={() => setManage(null)}
          onChanged={load}
        />
      )}
    </Shell>
  );
}
