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
