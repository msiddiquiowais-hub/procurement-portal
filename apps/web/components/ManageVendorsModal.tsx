// `ManageVendorsModal` — the REVERSE half of the vendor <-> category mapping.
//
// WHY IT SITS ON THE LINE-CATEGORIES SCREEN
// -----------------------------------------
// It did not, at first. This modal was originally mounted on the D365 ItemGroup
// dimension because `core.vendor_categories` then FK'd that library, and putting
// it on admin-categories.tsx would have shown a list guaranteed to be empty or
// wrong.
//
// Migration 051 moved the vendor mapping onto the LINE categories — the same
// `core.categories` rows that screen edits — so the original objection no longer
// applies and the modal moved here. That is where the brief asked for it all
// along: one vocabulary, one screen, one Manage Vendors button.
//
// ── ONE DRAFT, ONE SAVE ────────────────────────────────────────────────────
//
// Every vendor is a checkbox in a single draft set. Ticking or unticking one
// changes nothing on the server; the draft is committed by the single
// "Save mappings" button at the foot of the modal.
//
// The previous version had a per-row "Link" button that wrote immediately, and
// a separate Deactivate per row. Mapping a supplier base onto a category is a
// bulk, deliberate act — twenty vendors at once — and a control that writes on
// click makes that both tedious (twenty round trips) and dangerous (twenty
// audited writes, no preview, one mis-click each).
//
// DEACTIVATE IS NOT UNLINK. Unticking a vendor here DEACTIVATES the mapping:
// the relationship is kept and stays readable, it just stops routing. Unlinking
// is a separate, deliberately awkward action (below), because it deletes the row
// and only the audit record survives.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';

type VendorLink = {
  id: string;
  vendorCode: string;
  legalName: string;
  state: string;
  isHold: boolean;
  riskScore: string | null;
  isActive: boolean;
  statusChangedAt: string;
  linkedAt: string;
  changedBy: { name: string; email: string } | null;
};

type CategoryPayload = {
  category: { id: string; code: string; name: string; active: boolean };
  vendors: VendorLink[];
  counts: { total: number; active: number; inactive: number };
};

type VendorSummary = {
  id: string;
  vendorCode: string;
  name: string;
  state: string;
  isHold: boolean;
};

type Props = {
  code: string;
  label: string;
  onClose: () => void;
  onChanged: () => void;
};

export default function ManageVendorsModal({ code, label, onClose, onChanged }: Props) {
  const [data, setData] = useState<CategoryPayload | null>(null);
  const [all, setAll] = useState<VendorSummary[]>([]);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  /**
   * The draft: vendor ids that SHOULD be active for this category.
   *
   * Seeded from the server on every load, so a reload discards an unsaved edit
   * rather than silently keeping a stale one.
   */
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [baseline, setBaseline] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const [linksRes, listRes] = await Promise.all([
        api.get(`/vendors/categories/${code}`),
        api.get('/vendors'),
      ]);
      const links: VendorLink[] = linksRes?.data?.vendors ?? [];
      const rows = (listRes?.data?.rows ?? []) as VendorSummary[];
      setData(linksRes.data);
      setAll(rows);
      const active = new Set(links.filter((l) => l.isActive).map((l) => l.id));
      setDraft(active);
      setBaseline(active);
      setErr('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [code]);

  useEffect(() => { load(); }, [load]);

  // Escape closes. Without it the modal has no keyboard exit at all.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const linkById = useMemo(() => {
    const m = new Map<string, VendorLink>();
    for (const l of data?.vendors ?? []) m.set(l.id, l);
    return m;
  }, [data]);

  const added = useMemo(
    () => [...draft].filter((id) => !baseline.has(id)),
    [draft, baseline],
  );
  const removed = useMemo(
    () => [...baseline].filter((id) => !draft.has(id)),
    [draft, baseline],
  );
  const changed = added.length > 0 || removed.length > 0;

  const term = q.trim().toLowerCase();
  const shown = all
    .map((v) => ({
      ...v,
      link: linkById.get(v.id) ?? null,
      inDraft: draft.has(v.id),
      // A vendor whose link exists but is deactivated is hidden by default:
      // it is neither a clean "not mapped" nor a clean "active", and showing it
      // mixed in with the unlinked ones invites a duplicate mapping.
      hiddenLink: !!linkById.get(v.id) && !linkById.get(v.id)!.isActive,
    }))
    .filter((v) => (showInactive ? true : !v.hiddenLink))
    .filter((v) => !term
      || v.vendorCode.toLowerCase().includes(term)
      || v.name.toLowerCase().includes(term))
    .sort((a, b) => {
      // Checked first, then everything else alphabetically. The operator is
      // assembling a set, so what they have already chosen is what they need
      // to see most.
      if (a.inDraft !== b.inDraft) return a.inDraft ? -1 : 1;
      return a.vendorCode.localeCompare(b.vendorCode);
    });

  async function save() {
    if (!reason.trim()) {
      setOk('');
      setErr('A reason is required. A mapping nobody can explain later is a flag, not a control.');
      return;
    }
    setBusy(true); setErr(''); setOk('');
    try {
      // One call per vendor that actually changed, and no call at all when
      // nothing did. A "save" that writes 20 identical PATCHes would put 20
      // identical rows in the audit trail and teach the reader nothing.
      const work: Promise<unknown>[] = [];
      for (const id of added) {
        const v = all.find((x) => x.id === id);
        if (!v) continue;
        if (linkById.has(id)) {
          // Already linked but deactivated — turn it back on in place.
          work.push(api.patch(`/vendors/${id}/categories/${code}`, {
            isActive: true, reason: reason.trim(),
          }));
        } else {
          // Not linked at all: create it by re-submitting that vendor's whole
          // active set plus this category. Reading the current set first is what
          // keeps this from silently deactivating the groups the operator did
          // not touch.
          work.push(
            api.get(`/vendors/${id}/categories`).then((cur) => {
              const active = (cur?.data?.categories ?? [])
                .filter((c: any) => c.isActive).map((c: any) => c.code);
              if (!active.includes(code)) active.push(code);
              return api.post(`/vendors/${id}/categories`, {
                categories: active,
                reason: `${reason.trim()} (linked ${v.vendorCode} to ${code})`,
              });
            }),
          );
        }
      }
      for (const id of removed) {
        work.push(api.patch(`/vendors/${id}/categories/${code}`, {
          isActive: false, reason: reason.trim(),
        }));
      }

      await Promise.all(work);
      setReason('');
      setOk(`Saved. ${added.length} enabled, ${removed.length} deactivated.`);
      await load();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Forget the relationship. Deliberately NOT part of the draft. */
  async function unlink(vendorId: string, vendorCode: string) {
    if (!reason.trim()) {
      setOk('');
      setErr('A reason is required before unlinking.');
      return;
    }
    setBusy(true); setErr(''); setOk('');
    try {
      await api.del(`/vendors/${vendorId}/categories/${code}`, { reason: reason.trim() });
      setReason('');
      setOk(`${vendorCode} unlinked. The audit trail keeps the record.`);
      await load();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Vendors for ${label}`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(15,23,42,.45)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '32px 16px',
        overflowY: 'auto',
      }}
    >
      <div className="card" style={{ width: '100%', maxWidth: 820, margin: 0 }}>
        <div className="card-h">
          <h3>Manage vendors — {label}</h3>
          <span className="meta">
            {data ? `${data.counts.active} active · ${data.counts.inactive} deactivated` : ''}
          </span>
        </div>
        <div className="card-b">
          {err && <div className="text-sm" style={{ color: 'var(--danger, #c0392b)' }}>{err}</div>}
          {ok && <div className="text-sm" style={{ color: 'var(--ok, #0a7)' }}>{ok}</div>}
          {!data && !err && <div className="text-mute">Loading…</div>}

          {data && (
            <>
              <p className="text-sm text-mute" style={{ marginTop: 0 }}>
                Tick the vendors that should serve <code>{code}</code>. Nothing is saved until you
                press <strong>Save mappings</strong>. Unticking deactivates a mapping — the
                relationship is kept and stays readable, it simply stops routing.
              </p>

              <div className="row-between mb-2" style={{ gap: 10, flexWrap: 'wrap' }}>
                <input
                  className="input"
                  autoFocus
                  placeholder="Search vendors by code or name…"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  style={{ flex: '1 1 220px' }}
                />
                <label className="text-sm text-mute">
                  <input
                    type="checkbox"
                    checked={showInactive}
                    onChange={(e) => setShowInactive(e.target.checked)}
                  />
                  {' '}show deactivated ({data.counts.inactive})
                </label>
                <span className="text-sm text-mute">{draft.size} selected</span>
              </div>

              <div style={{
                border: '1px solid var(--border, #ddd)', borderRadius: 8,
                maxHeight: 340, overflowY: 'auto',
              }}>
                {shown.length === 0 && (
                  <div className="text-sm text-mute" style={{ padding: 12 }}>
                    No vendor matches “{q.trim()}”.
                  </div>
                )}
                {shown.map((v) => (
                  <label
                    key={v.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '8px 12px', cursor: 'pointer',
                      borderTop: '1px solid var(--border, #eee)',
                      background: v.inDraft ? 'rgba(16,185,129,.06)' : 'transparent',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={v.inDraft}
                      disabled={busy}
                      onChange={() => setDraft((d) => {
                        const n = new Set(d);
                        if (n.has(v.id)) n.delete(v.id); else n.add(v.id);
                        return n;
                      })}
                      style={{ width: 16, height: 16, cursor: busy ? 'not-allowed' : 'pointer' }}
                    />
                    <span className="mono" style={{ minWidth: 88 }}>{v.vendorCode}</span>
                    <span style={{ flex: 1 }}>{v.name}</span>
                    {v.link && !v.link.isActive && <span className="pill draft">was deactivated</span>}
                    {v.isHold && <span className="pill danger">On hold</span>}
                    {v.link && (
                      <button
                        type="button"
                        className="btn ghost sm"
                        disabled={busy}
                        title="Unlink — deletes the mapping. Only the audit record remains."
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (globalThis.confirm?.(
                            `Unlink ${v.vendorCode} from ${code}?\n\n`
                            + 'The mapping is deleted. The audit trail keeps the record, and past '
                            + 'PRs and POs are unaffected.',
                          )) unlink(v.id, v.vendorCode);
                        }}
                      >
                        Unlink
                      </button>
                    )}
                  </label>
                ))}
              </div>

              {changed && (
                <div className="text-sm" style={{ marginTop: 10 }}>
                  <strong>Unsaved changes:</strong>{' '}
                  {added.length > 0 && `+${added.length} to enable `}
                  {removed.length > 0 && `−${removed.length} to deactivate`}
                </div>
              )}

              <div style={{ marginTop: 12 }}>
                <input
                  type="text"
                  placeholder="Reason for this change (recorded permanently)"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  style={{ width: '100%' }}
                />
              </div>

              <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  className="btn primary"
                  disabled={busy || !changed || !reason.trim()}
                  onClick={save}
                >
                  {busy ? 'Saving…' : 'Save mappings'}
                </button>
                <button
                  className="btn"
                  disabled={busy || !changed}
                  onClick={() => { setDraft(baseline); setErr(''); setOk(''); }}
                >
                  Reset
                </button>
                <button className="btn ghost" style={{ marginLeft: 'auto' }} onClick={onClose}>
                  Close
                </button>
              </div>
              {changed && !reason.trim() && (
                <p className="text-sm text-mute" style={{ marginTop: 6, marginBottom: 0 }}>
                  A reason is required before saving.
                </p>
              )}

              <p className="text-sm text-mute" style={{ marginTop: 12, marginBottom: 0 }}>
                Past PRs and purchase orders are never affected by anything on this screen — it
                governs future eligibility only.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}