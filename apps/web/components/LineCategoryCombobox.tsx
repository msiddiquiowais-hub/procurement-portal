// `LineCategoryCombobox` — the category lookup for a PR line, laid out the way a
// Dynamics 365 lookup control is.
//
// WHY A LOOKUP AND NOT A <select>
// ------------------------------
// A native <select> with 50-100 categories is unusable: an unfiltered
// alphabetical list, no search, and the browser gives no room to show anything but
// the label. The user asked for this to behave like the D365 vendor/item lookup
// screens, and those screens are a small GRID with named columns under a search
// box. That is what this is.
//
// NAME AND DESCRIPTION ARE TWO COLUMNS, NOT ONE STRING
// ----------------------------------------------------
// The previous version stacked them, and that read as "squashed together": the
// name ran to the edge of the panel and the description wrapped underneath it
// with no alignment, so the eye could not pair a name with its description while
// scanning. Here they are a CSS grid with a fixed left column and a header row,
// so every description starts at the same x position — which is what makes it
// scannable rather than merely present.
//
// SEARCH RUNS OVER BOTH FIELDS INDEPENDENTLY
// -------------------------------------------
// Buyers search the name ("office"); integrators and suppliers search the code
// ("OFFICE_SUPPLIES"); and plenty of people only remember a word from the
// description ("stationery", "networking"). A lookup that only reads the name
// silently returns nothing for the other two, and the requester concludes the
// category does not exist.
//
// So the query is matched against name, code and description as three separate
// fields, and the ranking makes the match LOCATION visible:
//
//     0  code equals the query          IT_HARDWARE
//     1  code starts with it            IT_HARD…
//     2  NAME starts with it            "hardware" -> IT hardware
//     3  NAME contains it               mid-word: "hard"
//     4  DESCRIPTION contains it        "networking" -> IT hardware
//     5  every word found across both   "mesh chair" -> two words, one per field
//
// The matched text is highlighted in place with <mark>, in whichever column it
// was found. Without the highlight a description match looks identical to a name
// match and the user cannot tell why a row appeared — the highlight is what turns
// "why is this here?" into an obvious answer.
//
// WHAT IT IS AND IS NOT
// --------------------
// Still a HINT, not a gate. Leaving it empty is valid: the engine routes the line
// as OTHER. It never touches the free-text description beside it — the description
// is the requester's own wording, the category is only the routing key.
//
// No API calls. The vocabulary arrives as a prop from GET /lookups/categories.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type LineCategory = {
  code: string;
  name: string;
  description: string | null;
};

type Props = {
  categories: LineCategory[];
  /** The code currently chosen, or '' for none. */
  value: string;
  onChange: (code: string) => void;
  id?: string;
  disabled?: boolean;
  className?: string;
};

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
 * Rank a category against the query, or return null when it does not match.
 * Lower is better. The tiers encode WHICH field matched, which is the whole point
 * of searching name and description independently.
 *
 *     0  code equals the query          IT_HARDWARE
 *     1  NAME starts with it            "hardware" -> IT hardware
 *     2  NAME contains it               mid-word: "hard"
 *     3  code starts with it            "IT_" -> IT_HARDWARE
 *     4  code contains it               "it" also sits inside FACILITIES
 *     5  DESCRIPTION contains it        "networking" -> IT hardware
 *     6  every word found across both   "mesh chair" -> two words, one per field
 *
 * NAME outranks a code SUBSTRING on purpose. Typing "it" should surface IT
 * hardware and IT software first, not Facilities / FM — which contains "it" only
 * inside the code FACILITIES. An exact code match still wins outright, so typing
 * the full code finds it immediately; it is the incidental substring that must not
 * outrank the obvious name.
 */
function score(cat: LineCategory, query: string, tokens: string[]): number | null {
  if (!query) return 0;
  const code = cat.code.toLowerCase();
  const name = (cat.name || '').toLowerCase();
  const desc = (cat.description || '').toLowerCase();

  if (code === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (code.startsWith(query)) return 3;
  if (code.includes(query)) return 4;
  if (desc.includes(query)) return 5;

  // Every word must appear SOMEWHERE across both fields, so "office supplies"
  // and "supplies office" both match while "office networking" does not.
  if (!tokens.length) return null;
  const haystack = `${code} ${name} ${desc}`;
  for (const t of tokens) {
    if (!haystack.includes(t)) return null;
  }
  return 6;
}

/**
 * Wrap every occurrence of `query` in <mark>, so the user can see which field
 * matched. Returns an array of strings and marks, never HTML — nothing here is
 * interpolated into a string, so a category called `<img onerror>` cannot become
 * markup.
 */
function highlight(text: string, query: string): (string | { m: string })[] {
  if (!text) return [];
  if (!query) return [text];
  const out: (string | { m: string })[] = [];
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  let from = 0;
  // Bounded so a pathological repeat cannot spin here.
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

function Render({ parts, className }: { parts: (string | { m: string })[]; className?: string }) {
  return (
    <>
      {parts.map((p, i) =>
        typeof p === 'string'
          ? <span key={i}>{p}</span>
          : <mark key={i} className={className}>{p.m}</mark>
      )}
    </>
  );
}

export default function LineCategoryCombobox({
  categories,
  value,
  onChange,
  id,
  disabled,
  className,
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
   * <body>.
   *
   * `anchorBottom` picks which edge is pinned: below the trigger normally, or
   * the viewport floor when there is no room underneath. Pinning the FLOOR rather
   * than computing "trigger.top - panelHeight" is deliberate — the panel's height
   * depends on how many categories matched, so any height arithmetic here goes
   * stale the moment the list changes.
   */
  const [pos, setPos] = useState<{
    left: number; width: number; top?: number; bottom?: number; maxHeight: number;
  } | null>(null);

  const selected = useMemo(
    () => categories.find((c) => c.code === value) ?? null,
    [categories, value],
  );

  const query = q.trim().toLowerCase();
  const tokens = useMemo(() => tokenize(q), [q]);

  const matches = useMemo(() => {
    const scored: { cat: LineCategory; s: number }[] = [];
    for (const c of categories) {
      const s = score(c, query, tokens);
      if (s !== null) scored.push({ cat: c, s });
    }
    scored.sort((a, b) => (a.s !== b.s ? a.s - b.s : a.cat.name.localeCompare(b.cat.name)));
    return scored.map((x) => x.cat);
  }, [categories, query, tokens]);

  // A click outside closes the list. The trigger lives in the table; the panel is
  // portalled to <body>, so BOTH are tested — checking only the wrapper would let
  // every click inside the panel count as "outside" and close it on selection.
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

  /**
   * Re-anchor the panel whenever the page moves.
   *
   * `capture: true` is required: a `position: fixed` panel does not travel with
   * the trigger when an ANCESTOR scrolls, and the line items grid is inside a
   * horizontally scrollable wrapper. Without capture the panel detaches from its
   * trigger and appears to belong to a different row.
   */
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

  /**
   * Measure the trigger and place the panel in the space that actually exists.
   *
   * The previous version positioned the panel with CSS `position: absolute` inside
   * the table cell, and that was the bug: `.pr-items-card` and `.pr-items-scroll`
   * both set `overflow`, so the panel was CLIPPED to the card — on a row near the
   * bottom of the grid only its first row was visible, and the rest of the
   * categories were unreachable no matter how long the list. A dropdown whose
   * contents are cut off by an ancestor's overflow is not a styling nit; it hides
   * data.
   */
  function updatePos() {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gutter = 12;
    // Wide enough for two readable columns, but never wider than the viewport.
    const width = Math.max(320, Math.min(620, r.width, vw - gutter * 2));

    let left = r.left;
    if (left + width > vw - gutter) left = vw - gutter - width;
    if (left < gutter) left = gutter;

    const spaceBelow = vh - r.bottom - gutter;
    const spaceAbove = r.top - gutter;
    const MIN_USEFUL = 220;

    if (spaceBelow >= MIN_USEFUL) {
      setPos({ left, width, top: r.bottom + 4, maxHeight: Math.min(420, spaceBelow) });
    } else if (spaceAbove >= MIN_USEFUL) {
      // Anchor the floor instead of subtracting a guessed height.
      setPos({ left, width, bottom: gutter, maxHeight: Math.min(420, spaceAbove) });
    } else {
      // Nowhere has room — use the larger side and let it scroll.
      const useBelow = spaceBelow >= spaceAbove;
      setPos(
        useBelow
          ? { left, width, top: r.bottom + 4, maxHeight: Math.max(160, spaceBelow) }
          : { left, width, bottom: gutter, maxHeight: Math.max(160, spaceAbove) },
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

  function choose(code: string) {
    onChange(code);
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
      // Enter picks the highlighted row. It must NOT submit the form — a
      // keyboard user reaching for a category should not accidentally raise a
      // purchase requisition.
      e.preventDefault();
      const m = matches[cursor];
      if (m) choose(m.code);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePanel(true);
    } else if (e.key === 'Tab' && open) {
      closePanel(false);
    }
  }

  return (
    <div ref={wrapRef} className={`lcc ${className || ''}`.trim()}>
      {/* The panel is PORTALLED to <body>.
          It has to be: inside the cell it is clipped by `.pr-items-card` and
          `.pr-items-scroll`, both of which set `overflow`, which is exactly what
          cut the category list off after the first row.
          `open` is false during SSR, so the portal never renders server-side. */}
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
              placeholder="Search by name or description…"
              value={q}
              disabled={disabled}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKeyDown}
              aria-expanded="true"
              aria-controls={id ? `${id}-listbox` : undefined}
              aria-activedescendant={id && matches[cursor] ? `${id}-opt-${cursor}` : undefined}
              role="combobox"
              aria-autocomplete="list"
              aria-label="Search categories by name or description"
            />
            <button
              type="button"
              className="lcc-close"
              title="Close (Esc)"
              aria-label="Close category search"
              onClick={() => closePanel(true)}
            >
              ×
            </button>
          </div>

          <div className="lcc-list" ref={listRef} role="listbox" id={id ? `${id}-listbox` : undefined}>
            {/* ── the column headers. Without them the two columns are just text;
                    with them this reads as the lookup grid it is meant to be. ── */}
            <div className="lcc-head" aria-hidden="true">
              <span className="lcc-head-name">CATEGORY NAME</span>
              <span className="lcc-head-desc">DESCRIPTION</span>
            </div>

            {matches.length === 0 && (
              <div className="lcc-empty">
                No category matches “{q.trim()}”.
                <div className="lcc-empty-hint">
                  Search covers both the name and the description. Leave it unset
                  and the line still routes normally.
                </div>
              </div>
            )}

            {matches.map((c, i) => {
              const isSel = c.code === value;
              const isCur = i === cursor;
              return (
                <div
                  key={c.code}
                  id={id ? `${id}-opt-${i}` : undefined}
                  role="option"
                  aria-selected={isSel}
                  aria-label={`${c.name} — ${c.description || 'no description'}`}
                  data-active={isCur ? 'true' : 'false'}
                  className={`lcc-opt${isCur ? ' is-cursor' : ''}${isSel ? ' is-selected' : ''}`}
                  onMouseEnter={() => setCursor(i)}
                  onMouseDown={(e) => e.preventDefault()}  // keep focus in the search box
                  onClick={() => choose(c.code)}
                >
                  {/* LEFT COLUMN — the name, with its machine code beneath it. */}
                  <div className="lcc-cell-name">
                    <span className="lcc-opt-name">
                      {isSel && <span className="lcc-check" aria-hidden="true">✓ </span>}
                      <Render parts={highlight(c.name, query)} />
                    </span>
                    <span className="lcc-opt-code">
                      <Render parts={highlight(c.code, query)} />
                    </span>
                  </div>

                  {/* RIGHT COLUMN — the description, in its own column, aligned
                      across every row so names and descriptions can be paired
                      while scanning. */}
                  <div className="lcc-cell-desc">
                    {c.description
                      ? <Render parts={highlight(c.description, query)} />
                      : <span className="lcc-no-desc">No description on file</span>}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="lcc-foot">
            <button type="button" className="lcc-clear" onClick={() => choose('')}>
              Not stated
            </button>
            <span className="lcc-count">
              {matches.length} of {categories.length}
            </span>
          </div>
        </div>,
          document.body,
        )
        : null}

      {/* The trigger renders underneath the portal, so it keeps its place in the
          grid even while the list is open and floats above the table. */}
      <button
          ref={triggerRef}
          type="button"
          data-trigger
          id={id}
          disabled={disabled}
          className={`lcc-trigger${selected ? ' has-value' : ''}`}
          onClick={openPanel}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openPanel();
            }
          }}
          aria-haspopup="listbox"
          aria-expanded="false"
          aria-label={selected ? `Category: ${selected.name}. Change` : 'Choose a category'}
        >
          <span className="lcc-trigger-label">
            {selected ? (
              <>
                <span className="lcc-trigger-name">{selected.name}</span>
                <span className="lcc-trigger-code">{selected.code}</span>
              </>
            ) : (
              <span className="lcc-trigger-empty">— not stated —</span>
            )}
          </span>
          <span className="lcc-caret" aria-hidden="true">▾</span>
        </button>
    </div>
  );
}