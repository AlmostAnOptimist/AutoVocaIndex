// ── Scroll helpers (bug sweep U2) ────────────────────────────────────────────
// Leaf module: DOM only, no React or app imports.

const scrolls = (el) => {
  const oy = window.getComputedStyle(el).overflowY;
  return oy === 'auto' || oy === 'scroll';
};

// Nearest scrolling ancestor of el (not el itself), or null for the window.
export function scrollParentOf(el) {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    if (scrolls(p)) return p;
  }
  return null;
}

// Brings the top of a list back into view after paging. If the list box
// scrolls on its own (desktop), it goes back to its top. If it flows at full
// height inside an outer scroller (AVI's Word/Sentence Input on mobile), the
// outer scroller moves up so the list's first row is at its top — only ever
// up, so a list whose top is already in view stays put.
export function scrollListToTop(el, behavior = 'smooth') {
  if (!el) return;
  if (scrolls(el) && el.scrollHeight > el.clientHeight) {
    el.scrollTo({ top: 0, behavior });
    return;
  }
  const sc = scrollParentOf(el);
  if (sc) {
    const target = sc.scrollTop + (el.getBoundingClientRect().top - sc.getBoundingClientRect().top);
    if (target < sc.scrollTop) sc.scrollTo({ top: Math.max(0, target), behavior });
  } else {
    const target = window.scrollY + el.getBoundingClientRect().top;
    if (target < window.scrollY) window.scrollTo({ top: Math.max(0, target), behavior });
  }
}
