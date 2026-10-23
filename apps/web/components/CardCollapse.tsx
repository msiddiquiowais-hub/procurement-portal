import { useEffect } from 'react';

/**
 * Every card in the app folds away when you click its header row.
 *
 * WHY IT IS DELEGATED INSTEAD OF A `<CollapsibleCard>` WRAPPER
 * ───────────────────────────────────────────────────────────
 * `.card-h` / `.card-b` is the house card pattern and appears ~100 times across
 * 40+ pages (admin, vendor portal, finance, procurement). A wrapper component
 * would mean editing every one of those call sites, and every site I failed to
 * reach would quietly stay stuck open. So the behaviour lives at the DOM layer
 * instead: one delegated listener plus one stylesheet rule, mounted once from
 * `Shell`. Every card gets it, including cards added later, and no existing
 * card markup changes.
 *
 * The trade is that collapsed state is NOT React state — it is a class on the
 * DOM node. That is deliberate and matches the owner's decision to reset on
 * every page load (no persistence), and it means folding a section never
 * triggers a re-render of the page behind it.
 *
 * GUARDS — what does NOT toggle:
 *  1. A click landing on a real control inside the header. The Issue RFQ dialog
 *     keeps its deadline field and Send button IN the header on purpose (see
 *     pages/pr/[id].tsx) so they stay put while the roster scrolls; clicking
 *     that deadline must type a date, not fold the dialog.
 *  2. Headers inside an overlay. The modals here are inline `position: fixed`
 *     divs with no shared class, so "is this in a modal?" is answered by asking
 *     the computed style of its ancestors rather than by a marker attribute.
 *  3. A `.card-h` whose card has no `.card-b` — a chevron over a header that
 *     would hide nothing is a lie about what the click does.
 */

/** A real control in the header owns its own click; the header does not fold. */
const INTERACTIVE =
  'a,button,input,select,textarea,label,summary,option,' +
  '[role="button"],[role="link"],[contenteditable="true"],[data-no-collapse]';

/** Is this node inside a position:fixed overlay? Walks up to the root. */
function insideOverlay(node: HTMLElement): boolean {
  let el: HTMLElement | null = node;
  // Bounded: a real tree is far shorter, and this runs per header per mutation.
  for (let i = 0; el && i < 40; i++) {
    if (getComputedStyle(el).position === 'fixed') return true;
    el = el.parentElement;
  }
  return false;
}

/** Can this header fold? A header with nothing to hide cannot. */
function collapsible(head: HTMLElement): boolean {
  const card = head.parentElement;
  if (!card || !card.classList.contains('card')) return false;
  if (!card.querySelector(':scope > .card-b')) return false;
  return !insideOverlay(head);
}

export default function CardCollapse() {
  useEffect(() => {
    /** Mark every foldable header on the page. Idempotent — cheap to re-run. */
    function decorate() {
      document.querySelectorAll<HTMLElement>('.card-h').forEach(head => {
        // Already decided, either way. Skipping 'skip' as well as 'done' matters:
        // re-running the fixed-ancestor walk on every mutation is pure waste.
        if (head.dataset.collapse) return;
        if (!collapsible(head)) {
          head.dataset.collapse = 'skip';
          return;
        }
        head.dataset.collapse = 'done';
        // No role="button": several headers legitimately contain controls, and a
        // button may not contain interactive descendants. Focusability plus
        // aria-expanded is the honest middle ground here.
        head.tabIndex = 0;
        head.setAttribute('aria-expanded', 'true');
        head.title = 'Click to fold this section';
      });
    }

    function toggle(head: HTMLElement) {
      const card = head.parentElement;
      if (!card) return;
      const folded = card.classList.toggle('is-folded');
      head.setAttribute('aria-expanded', String(!folded));
      head.title = folded ? 'Click to unfold this section' : 'Click to fold this section';
    }

    function onClick(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (!t || typeof t.closest !== 'function') return;
      if (t.closest(INTERACTIVE)) return;
      const head = t.closest<HTMLElement>('.card-h');
      if (!head || head.dataset.collapse !== 'done') return;
      toggle(head);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      const t = e.target as HTMLElement | null;
      if (!t || t !== e.currentTarget) return; // the header itself, not a child
      if ((t as HTMLElement).dataset?.collapse !== 'done') return;
      e.preventDefault(); // Space would otherwise scroll the page
      toggle(t as HTMLElement);
    }

    // Cards mount and re-render constantly (async payloads land after paint), so
    // new headers are picked up by watching the tree rather than only decorating
    // once on mount.
    //
    // This calls decorate() DIRECTLY, with no requestAnimationFrame in between.
    // An rAF-based coalesce was tried first and is a trap: rAF is paused in a
    // backgrounded tab, so on any page whose cards arrive after mount — the
    // dashboard fetches its queue — the single pending frame never ran and the
    // cards were never marked. MutationObserver already delivers one callback
    // per batch, so the browser does the coalescing for us.
    const observer = new MutationObserver(() => decorate());

    decorate();
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKeyDown);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKeyDown);
      observer.disconnect();
    };
  }, []);

  return null;
}