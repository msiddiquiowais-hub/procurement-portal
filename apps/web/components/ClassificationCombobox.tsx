// `ClassificationCombobox` — the per-line Capex/Opex selector, as ONE control
// instead of a wall of five chips.
//
// WHY A LOOKUP AND NOT A <select>
// ------------------------------
// The previous control rendered all five classes at once, as toggle chips, inside
// a 340px column. Five labels did not fit, so they wrapped onto three rows and
// pushed the row taller than the item description beside it. That is a wall of
// controls where the reader wants a single answer.
//
// WHY A LOOKUP AND NOT A NATIVE <select> EITHER
// ---------------------------------------------
// The five values are today. They are also pinned by the database
// (`pr_lines_classification_check`, migration 022) and are the contract the D365
// payload builder emits, so the vocabulary is not this component's to change.
// But the day it grows past ten entries a native <select> becomes the thing
// LineCategoryCombobox's own header warns about: an unfiltered list, no search,
// and a native popup the browser sizes however it likes — which on a row near the
// bottom of a long table opens off-screen or scrolls with no indication that
// there is more below.
//
// So the panel is PORTALLED to <body>, positioned against MEASURED viewport
// space, and capped in height, exactly as `LineCategoryCombobox` does. A long
// list scrolls inside a bounded panel; the page behind it never moves.
//
// WHAT EACH ROW SHOWS, AND WHY IT SHOWS THE OUTCOME
// -------------------------------------------------
// Two columns: the class, and what the class DOES to the line in D365. The right
// column is not decoration.
//
// `CAPEX_ASSET` and `CAPEX_INFRA` both emit ProcurementCategory CAPEX and
// InventoryProfile 'Capitalised→FixedAssetRegister' — an identical payload for the
// same line (apps/api/src/d365/d365.payload.ts). The three OPEX values are
// identical among themselves for the same reason. Printing the outcome next to
// the choice makes that visible to the person choosing, which is the only form
// of it worth acting on. It changes no value and asserts no opinion: the split is
// still decided by the SQL prefix match in the award trigger, which reads
// 'CAPEX%' / 'OPEX%', and the vocabulary keeps its machine-value prefixes.
//
// THE VOCABULARY IS IMPORTED, NEVER RETYPED
// -----------------------------------------
// `CLASSIFICATIONS` comes from @procurement/d365-client so this control can only
// ever offer a class the ERP knows and the CHECK constraint accepts.
//
// SELECTING IS FREE. SAVING IS DELIBERATE.
// ----------------------------------------
// Nothing here calls the API. `onChange` reports the pick to the surrounding
// form, and the form's own Save button is what writes — the same contract
// `CategoryCombobox` and `LineCategoryCombobox` both keep, so a stray click in
// the list is never an audited database write.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CLASSIFICATIONS } from '@procurement/d365-client';

/** One entry of the shared vocabulary, with its fields widened to `string`. */
type Choice = {
  value: string;
  label: string;
  cls: string;
  gl: string;
  capex: boolean;
};

/**
 * What this class does to the line downstream.
 *
 * Read off the payload builder rather than restated: a capital line is
 * capitalised onto the fixed-asset register, an operating line is expensed to
 * its GL. The GL PREFIX is taken from the class's own `gl` contract, the same
 * value `pr/create.tsx` seeds an empty GL account from — so the two cannot
 * disagree about what "6xxx" means.
 *
 * Exported because the mapping is the claim worth pinning: `CAPEX_ASSET` and
 * `CAPEX_INFRA` return the SAME string, and so do the three OPEX values. If a
 * future change made one of them differ, that is a real change to the D365
 * contract and the test should say so out loud.
 */
export function outcome(c: Choice): string {
  return c.capex ? 'Fixed Asset Register' : `Expensed · GL ${c.gl.split(' ')[0]}`;
}

/** The shared vocabulary, widened to `string` so it is readable from a test. */
export const CLASSIFICATION_CHOICES: Choice[] = CLASSIFICATIONS.map((c) => ({ ...c }));

/** Split a query into lowercased word tokens, ignoring punctuation. */
function tokenize(s: string): string[] {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Rank a class against the query, or null when it does not match. Lower is
 * better.
 *
 *     0  the VALUE equals the query        CAPEX_ASSET
 *     1  the LABEL starts with it          "capex a" -> Capex — Asset
 *     2  the LABEL contains it             "infra"   -> Capex — Infra
 *     3  the value starts with it          "OPEX"    -> the three opex rows
 *     4  the outcome contains it           "register" -> the two capex rows
 *     5  every word found anywhere         "opex service"
 *
 * The outcome is searched because it is on screen. A user who remembers that the
 * line ends up "on the asset register" should find the capex rows by typing that,
 * not conclude the list is broken.
 */
function score(c: Choice, query: string, tokens: string[]): number | null {
  if (!query) return 0;
  const value = c.value.toLowerCase();
  const label = c.label.toLowerCase();
  const out = outcome(c).toLowerCase();

  if (value === query) return 0;
  if (label.startsWith(query)) return 1;
  if (label.includes(query)) return 2;
  if (value.startsWith(query)) return 3;
  if (out.includes(query)) return 4;

  if (!tokens.length) return null;
  const haystack = `${value} ${label} ${out}`;
  for (const t of tokens) if (!haystack.includes(t)) return null;
  return 5;
}

/**
 * Wrap every occurrence of `query` in <mark>, so the user can see WHICH field
 * matched. Returns strings and marks, never HTML — a class called
 * `<img onerror>` cannot become markup.
 */
function highlight(text: string, query: string): (string | { m: string })[] {
  if (!text) return [];
  if (!query) return [text];
  const out: (string | { m: string })[] = [];
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  let from = 0;
  for (let guard = 0; guard < 200; guard++) {
    const at = lower.indexOf(needle, from);
    if (at === -1) break;
    if (at > from) out.push(text.slice(from, at));
    out.push({ m: text.slice(at, at + needle.length) });
    from = at + needle.length;
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

function Render({ parts }: { parts: (string | { m: string })[] }) {
  return (
    <>
      {parts.map((p, i) =>
        typeof p === 'string'
          ? <span key={i}>{p}</span>
          : <mark key={i}>{p.m}</mark>
      )}
    </>
  );
}

type Props = {
  /** The chosen class, or '' for none. */
  value: string;
  /** Report a pick. '' clears. The caller owns the side effects. */
  onChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  /** Shown on the trigger when nothing is chosen. */
  placeholder?: string;
};

export default function ClassificationCombobox({
  value,
  onChange,
  disabled,
  id,
  className,
  placeholder = '— Select Classification —',
}: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  /**
   * Where the panel goes, in VIEWPORT coordinates, because it is portalled to
   * <body>. `anchorBottom` picks which edge is pinned; the panel's height depends
   * on how many rows matched, so no height arithmetic here — measure the space
   * instead of guessing the panel.
   */
  const [pos, setPos] = useState<{
    left: number; width: number; top?: number; bottom?: number; maxHeight: number;
  } | null>(null);

  const selected = useMemo(
    () => CLASSIFICATION_CHOICES.find((c) => c.value === value) ?? null,
    [value],
  );

  const query = q.trim().toLowerCase();
  const tokens = useMemo(() => tokenize(q), [q]);

  const matches = useMemo(() => {
    const scored: { c: Choice; s: number }[] = [];
    for (const c of CLASSIFICATION_CHOICES) {
      const s = score(c, query, tokens);
      if (s !== null) scored.push({ c, s });
    }
    // Equal rank keeps the vocabulary's declared order (d365-client says that
    // order is what the screen renders), so the list never reshuffles itself
    // under the reader while they are reading it.
    scored.sort((a, b) => (a.s !== b.s ? a.s - b.s : 0));
    return scored.map((x) => x.c);
  }, [query, tokens]);

  // A click outside closes the list. The trigger lives in the table and the
  // panel is portalled, so BOTH are tested — checking only the wrapper would
  // treat every click inside the panel as outside and close it on selection.
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  // `capture: true` — a position:fixed panel does not travel with its trigger
  // when an ANCESTOR scrolls, and this trigger sits inside a horizontally
  // scrollable table wrapper. Without capture the panel detaches from its row.
  useEffect(() => {
    if (!open) return;
    const reposition = () => updatePos();
    reposition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open]);

  // A new query means a new result set, so the highlight goes back to the top.
  useEffect(() => { setCursor(0); }, [q]);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>('[data-active="true"]');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [cursor, open]);

  function updatePos() {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gutter = 12;
    const width = Math.max(300, Math.min(460, r.width, vw - gutter * 2));

    let left = r.left;
    if (left + width > vw - gutter) left = vw - gutter - width;
    if (left < gutter) left = gutter;

    const spaceBelow = vh - r.bottom - gutter;
    const spaceAbove = r.top - gutter;
    const MIN_USEFUL = 200;

    if (spaceBelow >= MIN_USEFUL) {
      setPos({ left, width, top: r.bottom + 4, maxHeight: Math.min(360, spaceBelow) });
    } else if (spaceAbove >= MIN_USEFUL) {
      setPos({ left, width, bottom: gutter, maxHeight: Math.min(360, spaceAbove) });
    } else {
      // Nowhere has room — take the larger side and let it scroll.
      const useBelow = spaceBelow >= spaceAbove;
      setPos(
        useBelow
          ? { left, width, top: r.bottom + 4, maxHeight: Math.max(150, spaceBelow) }
          : { left, width, bottom: gutter, maxHeight: Math.max(150, spaceAbove) },
      );
    }
  }

  function openPanel() {
    if (disabled) return;
    setOpen(true);
    setQ('');
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function closePanel(focusTrigger = false) {
    setOpen(false);
    setQ('');
    if (focusTrigger) {
      wrapRef.current?.querySelector<HTMLElement>('[data-trigger]')?.focus();
    }
  }

  function choose(v: string) {
    onChange(v);
    closePanel(true);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { openPanel(); return; }
      if (!matches.length) return;
      setCursor((c) => {
        const n = matches.length;
        return (c + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      });
    } else if (e.key === 'Enter') {
      // Enter picks the highlighted row and must NOT submit the form — reaching
      // for a class should not raise a purchase requisition.
      e.preventDefault();
      const m = matches[cursor];
      if (m) choose(m.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePanel(true);
    } else if (e.key === 'Tab' && open) {
      closePanel(false);
    }
  }

  return (
    <div ref={wrapRef} className={`clsx ${className || ''}`.trim()}>
      {/* Portalled, so no ancestor `overflow` can clip the list. `open` is false
          during SSR, so the portal never renders server-side. */}
      {open && pos && typeof document !== 'undefined'
        ? createPortal(
          <div
            ref={panelRef}
            className="lcc-panel"
            style={{
              left: pos.left,
              width: pos.width,
              top: pos.top,
              bottom: pos.bottom,
              maxHeight: pos.maxHeight,
            }}
          >
            <div className="lcc-searchrow">
              <input
                ref={inputRef}
                id={id}
                type="text"
                className="lcc-search"
                placeholder="Search by class, code or outcome…"
                value={q}
                disabled={disabled}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onKeyDown}
                aria-expanded="true"
                aria-controls={id ? `${id}-listbox` : undefined}
                aria-activedescendant={id && matches[cursor] ? `${id}-opt-${cursor}` : undefined}
                role="combobox"
                aria-autocomplete="list"
                aria-label="Search Capex and Opex classes"
              />
              <button
                type="button"
                className="lcc-close"
                title="Close (Esc)"
                aria-label="Close classification search"
                onClick={() => closePanel(true)}
              >
                ×
              </button>
            </div>

            <div className="lcc-list" ref={listRef} role="listbox" id={id ? `${id}-listbox` : undefined}>
              <div className="lcc-head" aria-hidden="true">
                <span className="lcc-head-name">CLASS</span>
                <span className="lcc-head-desc">POSTS TO</span>
              </div>

              {matches.length === 0 && (
                <div className="lcc-empty">
                  No class matches “{q.trim()}”.
                  <div className="lcc-empty-hint">
                    Search covers the class name, its code, and where the line posts.
                  </div>
                </div>
              )}

              {matches.map((c, i) => {
                const isSel = c.value === value;
                const isCur = i === cursor;
                return (
                  <div
                    key={c.value}
                    id={id ? `${id}-opt-${i}` : undefined}
                    role="option"
                    aria-selected={isSel}
                    aria-label={`${c.label} — posts to ${outcome(c)}`}
                    data-active={isCur ? 'true' : 'false'}
                    className={
                      `lcc-opt clsx-opt${isCur ? ' is-cursor' : ''}${isSel ? ' is-selected' : ''}` +
                      `${c.capex ? ' clsx-capex' : ' clsx-opex'}`
                    }
                    onMouseEnter={() => setCursor(i)}
                    onMouseDown={(e) => e.preventDefault()}  // keep focus in the search box
                    onClick={() => choose(c.value)}
                  >
                    <div className="lcc-cell-name">
                      <span className="lcc-opt-name">
                        {isSel && <span className="lcc-check" aria-hidden="true">✓ </span>}
                        <Render parts={highlight(c.label, query)} />
                      </span>
                      <span className="lcc-opt-code">
                        <Render parts={highlight(c.value, query)} />
                      </span>
                    </div>
                    <div className="lcc-cell-desc clsx-outcome">
                      <Render parts={highlight(outcome(c), query)} />
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="lcc-foot">
              <button
                type="button"
                className="lcc-clear"
                disabled={disabled || !selected}
                onClick={() => choose('')}
              >
                Clear selection
              </button>
              <span className="lcc-count">{matches.length} of {CLASSIFICATION_CHOICES.length}</span>
            </div>
          </div>,
          document.body,
        )
        : null}

      {/* The trigger renders UNDERNEATH the portal, so it keeps its place in the
          table while the list floats above it. */}
      <button
        ref={triggerRef}
        type="button"
        data-trigger
        id={id}
        disabled={disabled}
        className={`lcc-trigger clsx-trigger${selected ? ' has-value' : ''}${selected ? (selected.capex ? ' clsx-capex' : ' clsx-opex') : ''}`}
        onClick={openPanel}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openPanel();
          }
        }}
        aria-haspopup="listbox"
        aria-expanded="false"
        aria-label={selected ? `Classification: ${selected.label}. Change` : placeholder}
      >
        <span className="lcc-trigger-label">
          {selected ? (
            <span className="lcc-trigger-name">{selected.label}</span>
          ) : (
            <span className="lcc-trigger-empty">{placeholder}</span>
          )}
        </span>
        <span className="lcc-caret" aria-hidden="true">▾</span>
      </button>
    </div>
  );
}