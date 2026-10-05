// src/utils/contentUtils.js
// Shared utilities for Content Library data.
// Used by AppointmentsPage (source/section picker) and App.jsx (section auto-advance).
// The ordering logic mirrors ContentLibraryPage exactly so both places show
// sections in the same order.

// Splits a string into alternating text/number segments for natural sort.
// e.g. "T1C12" → ["t", 1, "c", 12]  →  T1C2 < T1C10 < T1C12
function naturalKey(str) {
  const parts = [];
  (str || '').replace(/(\d+)|(\D+)/g, (_, num, txt) => {
    parts.push(num ? parseInt(num, 10) : txt.toLowerCase());
  });
  return parts;
}

function naturalCompare(a, b) {
  const ka = naturalKey(a.content);
  const kb = naturalKey(b.content);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const av = ka[i] ?? '';
    const bv = kb[i] ?? '';
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

// Returns all sections for a source in display order.
// Respects sectionOrder (drag-reorder) when set; otherwise uses natural sort
// with "Information" sections first (matching ContentLibraryPage default).
export function getOrderedSectionsForSource(sections, sources, sourceId) {
  const src            = (sources  || []).find(s => s.id === sourceId);
  const sourceSections = (sections || []).filter(s => s.resourceId === sourceId);

  if (src?.sectionOrder?.length) {
    const orderMap = Object.fromEntries(src.sectionOrder.map((id, i) => [id, i]));
    return [...sourceSections].sort((a, b) => {
      const ai = orderMap[a.id] ?? Infinity;
      const bi = orderMap[b.id] ?? Infinity;
      if (ai !== bi) return ai - bi;
      return naturalCompare(a, b);
    });
  }

  return [...sourceSections].sort((a, b) => {
    const aInfo = a.content?.toLowerCase().includes('information') ? 0 : 1;
    const bInfo = b.content?.toLowerCase().includes('information') ? 0 : 1;
    if (aInfo !== bInfo) return aInfo - bInfo;
    return naturalCompare(a, b);
  });
}

// ── Source-type and status utilities ─────────────────────────────────────────
// These originally lived in ContentLibraryPage.jsx, but ContentLibraryGazette,
// useLibraryOverviewData, and UpcomingPage all import them — and
// ContentLibraryPage imports ContentLibraryGazette — creating circular imports
// that break Vite/Rollup's bundle initialisation order (TDZ crash).
// contentUtils.js has no imports of its own, so it is safe to be the host.

export const TYPES = [
  { id: 'Grammar',              color: '#F5C842', family: 'grammar'   },
  { id: 'Grammar: Practice',    color: '#C9973A', family: 'grammar'   },
  { id: 'Reading: Bilingual',   color: '#D96B6B', family: 'reading'   },
  { id: 'Reading: Korean Only', color: '#A83232', family: 'reading'   },
  { id: 'Dubbed',               color: '#2ABFBF', family: 'listening' },
  { id: 'Subbed',               color: '#1A8F8F', family: 'listening' },
  { id: 'Native',               color: '#0F5F5F', family: 'listening' },
  { id: 'Reference',            color: '#888',    family: 'reference' },
];

const TYPE_COLOR_MAP  = Object.fromEntries(TYPES.map(t => [t.id, t.color]));
export const TYPE_FAMILY_MAP = Object.fromEntries(TYPES.map(t => [t.id, t.family]));
export function typeColor(type) { return TYPE_COLOR_MAP[type] || '#888'; }

// Read sourceStatus with backward compat (old field was watchStatus).
export function getSourceStatus(source) {
  return source.sourceStatus ?? source.watchStatus ?? 'Not started';
}

const PASSIVE_MEDIA_ORIGINS = ['youtube', 'netflix', 'viki', 'disney', 'spotify'];
export function isPassiveMediaExcluded(src) {
  if (src.studyIntent === 'mining') return false;
  if (src.subtype === 'YouTube') return true;
  if (src.url?.includes('youtube.com')) return true;
  const origin = src.origin?.toLowerCase() || '';
  return PASSIVE_MEDIA_ORIGINS.some(kw => origin.includes(kw));
}

// ── HTML text helpers (shared by Notes, Dream Log, Content Library) ─
// Consolidated from five drifted local copies (I1-A). Plain-text extraction
// for previews/search, and paste sanitization for the WYSIWYG editors.

// Strip HTML to plain text. Block boundaries and <br> become a single space so
// "girly.</div><div>But" reads "girly. But"; <details> toggles collapse to
// "[toggle]"; entities are decoded; whitespace is collapsed.
export function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<details[^>]*>[\s\S]*?<\/details>/gi, '[toggle]')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr|section)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ').trim();
}

// Tags the editors keep on paste. Everything else is unwrapped to its text.
// Block-level tags map to <div> (what contentEditable itself produces for
// lines), so pasted paragraphs keep their line breaks without foreign markup.
const PASTE_KEEP  = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'a', 'ul', 'ol', 'li', 'br']);
const PASTE_BLOCK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'tr', 'section', 'article', 'header', 'footer']);
const PASTE_DROP  = new Set(['script', 'style', 'head', 'title', 'meta', 'link', 'noscript', 'template', 'iframe', 'object', 'embed']);

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sanitizeNode(node) {
  if (node.nodeType === 3) return escapeHtml(node.nodeValue);
  if (node.nodeType !== 1) return '';
  const tag = node.tagName.toLowerCase();
  if (PASTE_DROP.has(tag)) return '';
  const inner = Array.from(node.childNodes).map(sanitizeNode).join('');
  if (PASTE_KEEP.has(tag)) {
    if (tag === 'br') return '<br>';
    if (tag === 'a') {
      const href = node.getAttribute('href') || '';
      if (!/^https?:\/\//i.test(href)) return inner;
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
    }
    return `<${tag}>${inner}</${tag}>`;
  }
  if (tag === 'td' || tag === 'th') return inner + ' ';
  if (PASTE_BLOCK.has(tag)) return inner.trim() ? `<div>${inner}</div>` : '';
  return inner; // span, font, table cells, etc. — keep text, drop styling
}

// Reduce clipboard HTML to Chirp-styled markup: basic inline formatting,
// lists, links, and line breaks survive; inline styles, colors, backgrounds,
// fonts, classes, and unknown tags do not. Returns '' if nothing survives.
export function sanitizePastedHtml(html) {
  if (!html || typeof DOMParser === 'undefined') return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return Array.from(doc.body.childNodes).map(sanitizeNode).join('').trim();
}
