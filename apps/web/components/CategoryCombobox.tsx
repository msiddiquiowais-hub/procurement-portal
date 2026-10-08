// `CategoryCombobox` — a searchable multi-select over the LINE categories.
//
// THIS COMPONENT NEVER CALLS THE API.
//
// It is a controlled selector: it renders the library, reports what the user
// picked through `onToggle`, and draws nothing else. Every save happens when
// the surrounding form's Save button is pressed.
//
// That separation is the whole point. The previous control committed as soon as
// you clicked a result, which meant a stray click in a long list was an
// irreversible, audited database write — the user had no chance to see what
// they had done before it happened. Selecting is free; saving is deliberate.
//
// SEARCH IS BY CODE *AND* DISPLAY NAME
// ------------------------------------
// core.categories carries both `code` (OFFICE_SUPPLIES) and `name` (Office
// supplies). Buyers know the second, integrators and suppliers send the first,
// and the field accepts either.
//
// DEACTIVATED CATEGORIES ARE STILL OFFERED
// -----------------------------------------
// A retired category keeps its vendor links; those links stay readable and
// auditable, and the ability to RE-ACTIVATE one is the only way to undo an
// accidental deactivation. Hiding the row would make that impossible from the
// UI, so it is shown and marked instead.

import { useEffect, useMemo, useRef, useState } from 'react';

export type CategoryOption = {
  id: string;
  code: string;
  name: string;
  active: boolean;
  activeVendors: number;
  inactiveVendors: number;
};

/**
 * One SAVED mapping row, as the server returns it.
 *
 * Distinct from the draft above: this is what is in the database, including the
 * links that are currently deactivated. The panel renders both — the draft being
 * edited, and the saved state — so an operator can see the difference between
 * "not saved yet" and "saved but switched off".
 */
export type CategoryLink = {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  createdAt: string;
  statusChangedAt: string;
  changedBy: { name: string; email: string } | null;
  createdBy: string | null;
};

type Props = {
  /** Every line category the system knows about, active or not. */
  library: CategoryOption[];
  /** Codes currently in the UNSAVED draft. */
  draft: string[];
  /** Report a click. The parent decides what, if anything, to persist. */
  onToggle: (code: string) => void;
  disabled?: boolean;
};

export default function CategoryCombobox({ library, draft, onToggle, disabled }: Props) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const draftSet = useMemo(() => new Set(draft), [draft]);
  const byCode = useMemo(() => {
    const m = new Map<string, CategoryOption>();
    for (const c of library) m.set(c.code, c);
    return m;
  }, [library]);

  const options = useMemo(() => {
    const term = q.trim().toLowerCase();
    return library
      .filter((g) => !term
        || g.code.toLowerCase().includes(term)
        || g.name.toLowerCase().includes(term))
      .sort((a, b) => {
        // Anything already chosen floats to the top, so it is always one click
        // away to remove without hunting for it in the list.
        const ad = draftSet.has(a.code) ? 0 : 1;
        const bd = draftSet.has(b.code) ? 0 : 1;
        if (ad !== bd) return ad - bd;
        if (a.active !== b.active) return a.active ? -1 : 1;
        return a.code.localeCompare(b.code);
      });
  }, [library, q, draftSet]);

  // A click elsewhere closes the list. Without this the dropdown sits over the
  // table and swallows the row underneath it.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  useEffect(() => { setCursor(0); }, [q]);

  const add = (code: string) => {
    onToggle(code);
    setQ('');
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      setCursor((c) => {
        const n = options.length;
        if (n === 0) return 0;
        return (c + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      });
    } else if (e.key === 'Enter') {
      const opt = options[cursor];
      if (opt) { add(opt.code); e.preventDefault(); }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div>
      {/* ── the UNSAVED draft ───────────────────────────────────────────── */}
      <div
        style={{
          minHeight: draft.length ? undefined : 34,
          padding: draft.length ? '8px 10px' : '8px 10px',
          border: '1px dashed var(--border, #ccc)',
          borderRadius: 8,
          marginBottom: 10,
        }}
      >
        {draft.length === 0 ? (
          <span className="text-sm text-mute">
            Nothing selected yet. A vendor with no line category is excluded from automatically
            generated RFQs — rule 3/4.
          </span>
        ) : (
          draft.map((code) => {
            const c = byCode.get(code);
            const inactive = c ? !c.active : false;
            return (
              <span
                key={code}
                className={`pill ${inactive ? 'draft' : 'info'}`}
                style={{ marginRight: 6, marginBottom: 4 }}
              >
                {code}
                {c ? ` · ${c.name}` : ''}
                {inactive && ' · retired'}
                <button
                  type="button"
                  aria-label={`Remove ${code} from the draft`}
                  disabled={disabled}
                  onClick={() => onToggle(code)}
                  style={{
                    marginLeft: 6, border: 0, background: 'transparent',
                    cursor: disabled ? 'not-allowed' : 'pointer', font: 'inherit',
                  }}
                >
                  ×
                </button>
              </span>
            );
          })
        )}
      </div>

      {/* ── search ──────────────────────────────────────────────────────── */}
      <div ref={boxRef} style={{ position: 'relative' }}>
        <input
          ref={inputRef}
          type="text"
          className="inp"
          disabled={disabled}
          placeholder="Search line categories by code or name…"
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          aria-expanded={open}
          aria-label="Search line categories"
        />
        {open && (
          <div style={{
            position: 'absolute', zIndex: 20, left: 0, right: 0, top: '100%',
            background: 'var(--surface, #fff)', border: '1px solid var(--border)',
            borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,.14)',
            maxHeight: 260, overflowY: 'auto', marginTop: 4,
          }}>
            {options.length === 0 && (
              <div className="text-sm text-mute" style={{ padding: 12 }}>
                No line category matches “{q.trim()}”.
              </div>
            )}
            {options.map((g, i) => {
              const chosen = draftSet.has(g.code);
              return (
                <button
                  key={g.code}
                  type="button"
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => add(g.code)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    padding: '8px 12px', border: 0, background: 'transparent',
                    cursor: 'pointer', font: 'inherit',
                    borderTop: i === 0 ? 0 : '1px solid var(--border, #eee)',
                  }}
                >
                  <div>
                    <span style={{ fontWeight: 600, marginRight: 6 }}>{chosen ? '✓' : '+'}</span>
                    <span className="mono">{g.code}</span>
                    <span style={{ marginLeft: 8 }}>{g.name}</span>
                    {!g.active && <span className="pill draft" style={{ marginLeft: 8 }}>retired</span>}
                  </div>
                  <div className="text-sm text-mute">
                    {g.activeVendors + g.inactiveVendors > 0
                      ? `${g.activeVendors} vendor(s) linked`
                      : 'no vendors linked yet'}
                    {!g.active && ' · cannot route new RFQs'}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}