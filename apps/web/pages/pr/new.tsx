import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { useSession } from '../../lib/session';
import { api } from '../../lib/api';
import Shell from '../../components/Shell';
import LineCategoryCombobox from '../../components/LineCategoryCombobox';

type Item = { id: string; item_code: string; name: string; category: string; uom: string; expense_type: string };
type CostCenter = { id: string; code: string; name: string; department_id: string | null };
type Department = { id: string; code: string; name: string; hod_user_id?: string | null };
/** A line category as core.categories serves it: the machine code plus the
 *  human name and description. The CODE is what gets submitted. */
type Category = { code: string; name: string; description: string | null };
type Uom = { code: string; name: string };

type LineRow = {
  barcode: string; detail: string; description: string;
  qty: number; uom: string; remarks: string;
  /** Catalogue item this line auto-matched, or '' when nothing matched.
   *  Free text is valid, so this is optional (migration 052 made item_id
   *  nullable). It is set by the suggester below, never by the requester — the
   *  catalogue dropdown that used to let them pin an override was removed. */
  itemId: string;
  /**
   * Line category code from core.categories, or '' when the requester has not
   * chosen one.
   *
   * Optional at data level (the column is nullable) but SUBMITTED whenever it
   * is set, because proc.pr_lines.category is what the workflow's line rules
   * read. Leaving it empty on every line is why all 918 stored lines were
   * unroutable: resolveLineCategory fell through to 'OTHER' and no rule matched.
   *
   * Deliberately INDEPENDENT of `description`. The description stays free text —
   * it is the requester's own wording of what they need — and the category is
   * the routing key. Choosing a category never types into the description, and
   * typing a description never overwrites the category.
   */
  category: string;
  /**
   * Unit price in PKR, or '' when nobody knows it yet.
   *
   * Optional by design. Most requests are raised before anyone has picked a
   * model or obtained a quote, and the price comes back with the RFQ. Leaving
   * this blank records "unknown", which the workflow treats as needing review
   * rather than as free.
   */
  unitPrice: string;
};

function freshLine(): LineRow {
  return { barcode: '', detail: '', description: '', qty: 1, uom: 'EA', remarks: '', itemId: '', category: '', unitPrice: '' };
}

export default function NewPr() {
  const { session, ready } = useSession();
  const router = useRouter();

  const [items, setItems] = useState<Item[]>([]);
  const [costCenters, setCostCenters] = useState<CostCenter[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [uoms, setUoms] = useState<Uom[]>([]);

  const [title, setTitle] = useState('');
  const [department, setDepartment] = useState('');
  const [justification, setJustification] = useState('');
  const [refPicCount, setRefPicCount] = useState(0);
  const [refPicKbs, setRefPicKbs] = useState(0);
  const [lines, setLines] = useState<LineRow[]>([freshLine(), freshLine(), freshLine()]);
  const [checked, setChecked] = useState<boolean[]>([false, false, false]);

  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!ready) return;                 // session not read from storage yet
    if (!session) { router.replace('/'); return; }
    // Categories and UOMs come from the database, not from a list in this file.
    // The category list used to be a hardcoded array in the workflow engine and
    // the UOM list a hardcoded 10-entry constant here that offered 10 of the 19
    // codes core.uom actually defines. Both are reference data, and reference
    // data in a form is a copy that drifts the moment the catalogue changes.
    Promise.all([
      api.get<Item[]>('/lookups/items').then(r => r.data as Item[]),
      api.get<CostCenter[]>('/lookups/cost-centers').then(r => r.data as CostCenter[]),
      api.get<Department[]>('/lookups/departments').then(r => r.data as Department[]),
      api.get<Category[]>('/lookups/categories').then(r => r.data as Category[]),
      api.get<Uom[]>('/lookups/uoms').then(r => r.data as Uom[]),
    ]).then(([its, ccs, deps, cats, uomList]) => {
      setItems(its);
      setCostCenters(ccs);
      setDepartments(deps);
      setCategories(cats);
      setUoms(uomList);
      // Default the UOM to the first real code the catalogue offers, rather
      // than to a literal 'EA' that may not exist. core.uom always has at
      // least one row, so the select is never left on an invalid value.
      if (uomList.length) {
        const fallback = uomList.find(u => u.code === 'EA') || uomList[0];
        setLines(prev => prev.map((l, i) => (i === 0 ? { ...l, uom: fallback.code } : l)));
      }
    }).catch(e => setErr(e.message));
  }, [ready, session]);

  if (!ready) return null;
  if (!session) return null;

  function updateLine(idx: number, patch: Partial<LineRow>) {
    setLines(ls => ls.map((l, i) => {
      if (i !== idx) return l;
      const next = { ...l, ...patch };
      // Typing in barcode / detail / description re-runs the catalogue suggester.
      //
      // It used to be guarded by `!itemIdPinned`, so a hand-picked item survived
      // later typing. The dropdown that set that flag is gone, so the guard went
      // with it rather than being left as a field nothing could ever set.
      const typed = ['barcode', 'detail', 'description'].some(k => k in patch);
      if (typed) next.itemId = suggestItem(next, items)?.id ?? '';
      return next;
    }));
  }
  function addLine() {
    setLines(ls => [...ls, freshLine()]);
    setChecked(c => [...c, false]);
  }
  function removeSelected() {
    setLines(ls => ls.filter((_, i) => !checked[i]));
    setChecked(c => c.filter((_, i) => !checked[i]));
  }
  function toggleAll(v: boolean) {
    setChecked(lines.map(() => v));
  }
  function toggleOne(idx: number, v: boolean) {
    setChecked(c => c.map((x, i) => i === idx ? v : x));
  }
  function pickPictureFiles(files: FileList | null) {
    if (!files) return;
    let count = 0, total = 0;
    for (const f of Array.from(files)) { count++; total += f.size; }
    setRefPicCount(c => c + count);
    setRefPicKbs(k => k + Math.round(total / 1024));
  }

  /**
   * Normalised compare key: lowercase, strip everything that is not alnum.
   * "PKB-CS-001" -> "pkbcs001", "Cardboard Sheet" -> "cardboardsheet".
   */
  function normKey(s: string): string {
    return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }
  function tokens(s: string): string[] {
    return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(t => t.length > 1);
  }

  /**
   * Resolve a form line to a catalog item.
   *
   * This REPLACES the old `items[0]` shortcut, which bound every PR line to
   * whatever the catalog happened to sort first (PKB-CS-001 Cardboard Sheet)
   * no matter what the requester typed.
   *
   * Signals, strongest first:
   *   1. barcode == item_code
   *   2. the typed text is a substring of the item name / code
   *   3. token overlap on distinctive tokens, tie-broken by shortest name
   *
   * Returns null when nothing matches. Callers must surface that as a
   * validation error rather than silently substituting another item.
   */
  function suggestItem(line: LineRow, itemList: Item[]): Item | null {
    if (!itemList.length) return null;

    // 1. barcode -> item_code
    const bc = normKey(line.barcode);
    if (bc) {
      const byCode = itemList.find(i => normKey(i.item_code) === bc);
      if (byCode) return byCode;
    }

    const lineText = `${line.detail} ${line.description}`.trim();
    if (!lineText) return null;
    const lineKey = normKey(lineText);

    // 2. whole typed text is contained in the item name or code
    const contained = itemList.find(i =>
      normKey(i.name).includes(lineKey) || normKey(i.item_code).includes(lineKey));
    if (contained && lineKey.length >= 3) return contained;

    // 3. token overlap
    const lineTokens = tokens(lineText);
    if (!lineTokens.length) return null;

    let best: { item: Item; hits: number; nameLen: number } | null = null;
    for (const it of itemList) {
      const itemTokens = new Set([...tokens(it.name), ...tokens(it.item_code)]);
      const hits = lineTokens.filter(t => itemTokens.has(t)).length;
      if (!hits) continue;
      if (!best || hits > best.hits || (hits === best.hits && it.name.length < best.nameLen)) {
        best = { item: it, hits, nameLen: it.name.length };
      }
    }
    if (!best) return null;
    // A single weak token ("the", "box") should not bind a catalog item.
    const distinctive = lineTokens.some(t => t.length >= 4 || /\d/.test(t));
    return distinctive ? best.item : null;
  }

  /** The catalog item a line is currently bound to (null when unresolved). */
  function boundItem(line: LineRow, itemList: Item[]): Item | null {
    return line.itemId ? (itemList.find(i => i.id === line.itemId) ?? null) : suggestItem(line, itemList);
  }

  /**
   * A line's price, if the requester stated one.
   *
   * There used to be a `unitPriceFor()` here that returned 50000 for any CAPEX
   * item and 1000 for any OPEX item. That was a guess dressed as a quote: a
   * laptop request nobody had costed was submitted as a confident PKR 50,000,
   * and that number then drove the management gate. If the price is not known
   * it is omitted, the API records it as NULL, and the PR is stored with
   * amount_status = 'UNKNOWN' so no threshold test can mistake missing for
   * cheap. The real figure arrives with the RFQ quotations.
   *
   * THE CATALOGUE LOOKUP WAS HERE ONCE AND HAD TO GO.
   *
   * This used to open with `if (!it) return undefined;` — it refused to price a
   * line that matched no item. That was harmless while every line HAD to match,
   * but it is a money bug the moment free text exists: the UNIT PRICE box is
   * right there on every row, and a requester who typed a free-text line AND a
   * price had that price silently dropped on submit. The PR then stored
   * unit_price_est = NULL, the total came out as UNKNOWN, and a line worth
   * money silently became a line with no money on it.
   *
   * The guard made no sense anyway — the price comes from the requester's
   * input, not from the catalogue row. Reading `unitPrice` and validating that
   * it is a non-negative finite number is the whole job.
   */
  function statedUnitPrice(line: LineRow, itemList: Item[]): number | undefined {
    void itemList; // retained in the signature; callers pass items, no lookup needed
    const raw = (line as any).unitPrice;
    if (raw === undefined || raw === null || raw === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }

  async function submit() {
    setErr(null);
    if (!title.trim()) { setErr('Title is required'); return; }
    if (!department) { setErr('Pick a department'); return; }
    if (!justification.trim()) { setErr('Justification is required'); return; }
    const filled = lines.filter(l => l.description.trim() && Number(l.qty) > 0);
    if (filled.length === 0) { setErr('Add at least one item line with a description and qty'); return; }

    // FREE TEXT IS A VALID LINE. There is no catalogue match requirement here any
    // more, and the reason is that the requirement was producing bad data rather
    // than good data: a requester who needed "two ergonomic chairs, mesh back, no
    // arms" was told to pick from a list, so they picked the nearest chair that
    // existed and the PR recorded an item nobody asked for. A line that says
    // plainly what it wants is better than a line that resolves to the wrong SKU.
    //
    // The lookup still runs, because a match is genuinely useful — it supplies the
    // GL account, the expense type and the default UOM. It is now a SUGGESTION the
    // requester can keep or override, not a gate.
    //
    // What stays refused is the opposite error: naming an item that is not in the
    // catalogue. That is still the database's foreign key to refuse, and the form
    // has no reason to send it.
    const resolved = filled.map(l => boundItem(l, items));

    // Department -> cost centre. The API derives pr.department_id from
    // cost_center_id, so this lookup is what actually fixes the department.
    // The old code used a tautological `.find(c => ... && true)` which always
    // returned costCenters[0] (PKB-LHR-001, Lahore Sales) no matter what the
    // requester picked.
    const dept = departments.find(d => d.code === department);
    if (!dept) { setErr('Pick a department'); return; }
    const deptCostCenter = costCenters.find(c => c.department_id === dept.id);
    if (!deptCostCenter) {
      setErr(`No active cost centre is mapped to ${dept.code} — ${dept.name}. Pick another department, or ask Finance to add a cost centre for it.`);
      return;
    }

    // CAPEX / OPEX / MIXED is derived from the BOUND items, not from a price
    // guess, so routing (warehouse check, management gate) keys off the truth.
    //
    // `resolved` can now contain nulls — that is a free-text line, which is
    // allowed. Two things had to change with it:
    //
    //  * the non-null assertion (`x!.expense_type`) is GONE. It was safe only
    //    while the function below had already rejected every null. With free
    //    text that guard no longer exists, and the assertion would have thrown a
    //    TypeError on the first unmatched line — a crash on the happy path.
    //  * nulls are skipped rather than counted. An unbound line has no
    //    expense_type to vote with, and it is the database's job to classify it
    //    (migration 052 defaults it to OPEX). Letting an unknown line vote would
    //    mean inventing a classification here.
    //
    // So: a PR of only free-text lines is classified OPEX, exactly as a PR whose
    // lines all resolve to OPEX items would be.
    const kinds = new Set(
      resolved.filter((x): x is Item => !!x).map((x) => x.expense_type),
    );
    const expenseType = kinds.size === 0 ? 'OPEX'
      : kinds.size === 1 ? ([...kinds][0] as 'CAPEX' | 'OPEX')
      : 'MIXED';

    const reqBy = new Date(); reqBy.setDate(reqBy.getDate() + 14);

    setBusy(true);
    try {
      const r = await api.post('/pr', {
        // Title must go to `title`. It used to be sent only as `scope`, leaving
        // pr.title NULL — the list view then fell back to the first line's
        // description, which is why the Title column showed "IS 16 GB Ram".
        title: title.trim(),
        scope: title.trim(),
        // Justification is the PR description. It was dropped entirely, so the
        // detail view fell back to `scope` and printed the title instead.
        description: justification.trim(),
        purpose: justification.trim(),
        expenseType,
        costCenterId: deptCostCenter.id,
        departments: [{ departmentId: dept.id, hodUserId: dept.hod_user_id ?? undefined, suggested: true }],
        requiredByDate: reqBy.toISOString().slice(0, 10),
        urgency: 'routine',
        lines: filled.map((l, i) => ({
          // OMITTED when the line matched nothing. This is the free-text path:
          // the API stores item_id NULL and the line reads as "described in the
          // requester's own words". It is omitted rather than sent as null so the
          // field is absent from the payload entirely, which is what makes
          // "no item" unambiguous to the server.
          ...(resolved[i] ? { itemId: resolved[i]!.id } : {}),
          quantity: Number(l.qty),
          uom: l.uom,
          // The category CODE, never the label. The dropdown only offers codes
          // that exist in core.categories, and proc.pr_lines.category has a
          // foreign key to that table, so an unknown value is refused by the
          // database rather than stored and silently unroutable.
          //
          // Sent only when chosen. A line with no category still submits
          // (the column is nullable and the engine falls back to 'OTHER'); the
          // dropdown is an aid, not a new gate, so nothing that submitted
          // before is now blocked.
          ...(l.category ? { category: l.category } : {}),
          // Omitted (not 0) when the requester gave no price. See statedUnitPrice.
          ...(statedUnitPrice(l, items) !== undefined
            ? { unitPriceEst: statedUnitPrice(l, items) }
            : {}),
          description: `${l.description}${l.remarks ? ` — ${l.remarks}` : ''}`,
        })),
      });
      router.push(`/pr/${(r.data as any).id}`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  const removeSelectedCount = checked.filter(Boolean).length;

  return (
    <Shell title="New Purchase Request" subtitle={`Master-detail · title, department, justification, reference pictures, plus a list of items. Routes to your HOD → Procurement → Finance → (Management, if total estimate > 2.5M) → D365.`}>
      <div className="card">
        <div className="card-b">
          <div className="pr-header-grid">
            <label className="pr-hdr-title field">
              <span className="lbl">TITLE <span className="req">*</span></span>
              <input type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Office laptops (Dell Latitude 7440)" />
            </label>
            <label className="pr-hdr-dept field">
              <span className="lbl">DEPARTMENT</span>
              <select value={department} onChange={e => setDepartment(e.target.value)}>
                <option value="">— Select department —</option>
                {departments.map(d => <option key={d.id} value={d.code}>{d.code} — {d.name}</option>)}
              </select>
            </label>
          </div>

          <div className="pr-header-grid pr-header-grid-row2">
            <label className="pr-hdr-just field">
              <span className="lbl">JUSTIFICATION <span className="req">*</span></span>
              <textarea rows={3} value={justification} onChange={e => setJustification(e.target.value)}
                placeholder="Replace end-of-life laptops for IT team (FY26 plan)." />
            </label>
            <div className="pr-hdr-attach field">
              <div className="lbl">Reference pictures (optional)</div>
              <div className="text-sm text-mute" style={{ marginBottom: 6 }}>
                Drop in up to 3 images — sample photos, links, screenshots.
              </div>
              <div className="light-image-uploader"
                onDragOver={e => { e.preventDefault(); }}
                onDrop={e => { e.preventDefault(); pickPictureFiles(e.dataTransfer.files); }}
                onClick={() => document.getElementById('light-image-file-input')?.click()}
                role="button" tabIndex={0}
              >
                <input id="light-image-file-input" type="file" accept="image/jpeg,image/jpg,image/png,image/webp" multiple style={{ display: 'none' }}
                  onChange={e => pickPictureFiles(e.target.files)} />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-mute)', lineHeight: 1.4 }}>
                    <b style={{ color: 'var(--text)' }}>Drag &amp; drop</b> JPG, PNG, or WebP here.<br />
                    <span>Up to 2 MB per file · 5 MB total.</span>
                  </div>
                  <button type="button" className="btn primary"
                    onClick={e => { e.stopPropagation(); document.getElementById('light-image-file-input')?.click(); }}>
                    Choose Files
                  </button>
                </div>
              </div>
              <div className="text-sm text-mute" style={{ marginBottom: 0 }}>
                <span className="light-image-count-chip">{refPicCount} pictures</span> ·
                <span> {refPicKbs} KB</span> ·
                <a href="#" onClick={e => { e.preventDefault(); document.getElementById('light-image-file-input')?.click(); }}> Add more</a>
              </div>
            </div>
          </div>

          <div className="section-h">Line items</div>
          <div className="pr-items-card">
            <div className="pr-items-head">
              <div className="pr-items-head-left">
                <h3 className="pr-items-title">What do you need?</h3>
                <p className="pr-items-sub">
                  Add one row per item, in your own words — a catalogue match is a suggestion, not a requirement.
                  Barcode and item detail are optional; leave blank if you don&apos;t know them.
                </p>
              </div>
              <div className="pr-items-head-right">
                <button type="button" className="pr-add-link" onClick={addLine}>+ Add item</button>
                <button type="button" className="pr-remove-selected" disabled={removeSelectedCount === 0} onClick={removeSelected}>
                  × Remove selected ({removeSelectedCount})
                </button>
              </div>
            </div>

            <div className="pr-items-scroll">
              <table className="pr-items-table">
                <thead>
                  <tr>
                    <th className="pr-col-check">
                      <input type="checkbox" checked={checked.length > 0 && checked.every(Boolean)} onChange={e => toggleAll(e.target.checked)} />
                    </th>
                    <th className="pr-col-barcode">BARCODE</th>
                    <th className="pr-col-detail">ITEM DETAIL</th>
                    <th className="pr-col-desc">DESCRIPTION <span className="req">*</span></th>
                    <th className="pr-col-qty">QTY <span className="req">*</span></th>
                    <th className="pr-col-uom">UOM <span className="req">*</span></th>
                    <th className="pr-col-category">CATEGORY</th>
                    <th className="pr-col-price">UNIT PRICE (PKR)</th>
                    <th className="pr-col-remarks">REMARKS</th>
                    <th className="pr-col-del"></th>
                  </tr>
                </thead>
                <tbody>
                {/* Rendered straight from `lines`, in the order the requester added
                    them. A sort/filter bar was tried here and removed on request:
                    this is a form, not a report, and a control strip above it made
                    the grid harder to read rather than easier. Line numbers the
                    approver sees therefore match what was typed. */}
                {lines.map((l, i) => {
                  const bound = boundItem(l, items);
                  return (
                  <tr key={i}>
                    <td className="pr-cell-check"><input type="checkbox" checked={!!checked[i]} onChange={e => toggleOne(i, e.target.checked)} /></td>
                    <td><input type="text" value={l.barcode} onChange={e => updateLine(i, { barcode: e.target.value })} placeholder="optional" /></td>
                    <td>
                      {/* Item detail is plain free text now.
                          The catalogue <select> that used to sit under this input was
                          removed on request. It was a third way of saying the same
                          thing on a row that already had four inputs, and its only
                          job — letting the requester override which catalogue item
                          the line was bound to — became unnecessary once the
                          description itself is free text and nothing is forced.

                          The BEHIND-THE-SCENES match stays, because it is not a
                          control the user has to read: a line typed as "Dell
                          Latitude 5550 Laptop" still binds to the laptop row and so
                          inherits its CAPEX expense type, GL account and default
                          UOM. That classification drives the warehouse check and the
                          management gate, so dropping it would quietly misfile
                          laptops as operating expenses. A line that matches nothing
                          simply attaches nothing and submits as written, which is
                          the whole point of free text. */}
                      <input type="text" value={l.detail} onChange={e => updateLine(i, { detail: e.target.value })} placeholder="optional" />
                    </td>
                      <td><input type="text" value={l.description} onChange={e => updateLine(i, { description: e.target.value })} placeholder="What do you need? (free text)" /></td>
                      <td><input type="number" min={1} step={1} value={l.qty} onChange={e => updateLine(i, { qty: Number(e.target.value) })} /></td>
                      <td>
                        {/* UOM codes now come from core.uom. The hardcoded list
                            offered 10 of the 19 defined codes, so picking
                            anything else failed on the proc.pr_lines.uom foreign
                            key with a constraint name rather than a useful
                            message. */}
                        <select value={l.uom} onChange={e => updateLine(i, { uom: e.target.value })}>
                          {uoms.map(u => <option key={u.code} value={u.code}>{u.code} — {u.name}</option>)}
                        </select>
                      </td>
                      <td className="pr-col-category">
                        {/* SEARCHABLE COMBOBOX over core.categories.
                            The plain <select> this replaced offered every
                            category in one unfiltered list, with the name and the
                            description run together on one line — unusable at 50+
                            entries and unreadable at any size. This searches as
                            you type across name, code and description, and shows
                            the name and description as separate lines.

                            Still an aid, not a gate: leaving it empty is valid and
                            the engine routes the line as OTHER. It never writes
                            into the free-text description beside it, because the
                            description is the requester's wording and the category
                            is only the routing key. */}
                        <LineCategoryCombobox
                          categories={categories}
                          value={l.category}
                          onChange={code => updateLine(i, { category: code })}
                        />
                      </td>
                      <td>
                        <input type="text" inputMode="decimal" value={l.unitPrice}
                          onChange={e => updateLine(i, { unitPrice: e.target.value })} placeholder="TBD" />
                      </td>
                      <td><input type="text" value={l.remarks} onChange={e => updateLine(i, { remarks: e.target.value })} placeholder="optional" /></td>
                      <td>
                        <button type="button" className="pr-row-del" title="Remove row"
                          onClick={() => { setLines(ls => ls.filter((_, j) => j !== i)); setChecked(c => c.filter((_, j) => j !== i)); }}>×</button>
                      </td>
                    </tr>
                  );
                })}
                </tbody>
              </table>
            </div>
          </div>

          {err && <div className="alert danger" style={{ marginTop: 14 }}>{err}</div>}

          <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={() => router.push('/dashboard')}>Cancel</button>
            <button type="button" className="btn primary" disabled={busy} onClick={submit}>
              {busy ? 'Submitting…' : 'Submit PR'}
            </button>
          </div>
        </div>
      </div>
    </Shell>
  );
}