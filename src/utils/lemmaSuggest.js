// src/utils/lemmaSuggest.js
// L4b (lemma repair, Oct 2026): Lemma Master matches for an
// Import review term, so an already-studied lemma is one tap away instead of
// something to remember and dig out of the autocomplete dropdown.
//
// Pure and synchronous. Builds on lemmaSearchEngine.js without changing any
// of its rules (its golden harness stays the regression gate for those).
// Leaf module: utilities only, never page files.

import { buildLemmaIndex, resolveKorean, suggestLemmas, findByLemmaText } from './lemmaSearchEngine.js';
import { normalizeLemma } from './aviUtils.js';

// Short reason shown as a tooltip on each choice.
const WHY = {
  surface:  'same form you added before',
  exact:    'exact match',
  prefix:   'starts the same',
  near:     'similar spelling',
  contains: 'contains it',
};

const summarize = (e) => ({ lemmaID: e.id, lemma: e.lemma, hasDef2: !!(e.ref && e.ref.def2) });

// Returns { current, choices }:
//   current — the Lemma Master entry the term's lemma already matches, or null
//   choices — up to `limit` OTHER entries worth offering, best first:
//             the entry the surface form maps to (an earlier capture of the
//             same form), then close matches for the lemma and the surface
//             (same start, one-jamo-off spelling, containing it).
export function lemmaChoicesForTerm(index, { input = '', lemma = '' } = {}, { surfaceMap = null, limit = 4 } = {}) {
  const current = lemma ? findByLemmaText(index, lemma) : null;
  const seen = new Set(current ? [current.id] : []);
  const choices = [];
  const add = (e, why) => {
    if (!e || seen.has(e.id) || choices.length >= limit) return;
    seen.add(e.id);
    choices.push({ ...summarize(e), why });
  };

  if (input) {
    const r = resolveKorean(index, input, { surfaceMap, suggestionLimit: 0 });
    if (r.entry) add(r.entry, WHY[r.status] || WHY.exact);
  }
  for (const q of [lemma, input]) {
    if (!q) continue;
    for (const s of suggestLemmas(index, q, { limit: 6 })) {
      // Looser spellings (two or more jamo off) are noise in a review list.
      if (s.kind === 'near' && s.rank > 1) continue;
      add(s.entry, WHY[s.kind] || WHY.near);
    }
  }
  return { current: current ? summarize(current) : null, choices };
}

// ── Other dictionary readings (L3) ───────────────────────────
// The "Or:" chips under a review term: the machine's own reading (so an
// edit can be undone in one tap) plus the other readings that validated as
// dictionary words (resolveLemmaDetailed), minus the lemma the term has
// now and anything already offered as a Lemma Master choice.
export function otherReadings(term, choices = [], limit = 3) {
  const lemmaKey = normalizeLemma(term?.lemma || '');
  const taken = new Set([lemmaKey, ...(choices || []).map(c => normalizeLemma(c.lemma || ''))]);
  const out = [];
  for (const r of [term?.resolvedLemma, ...(term?.alternates || [])]) {
    const k = normalizeLemma(r || '');
    if (!r || !k || taken.has(k)) continue;
    taken.add(k);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

// ── Variant-aware Lemma Master lookup (L4d) ───────────────────
// Linking a new term to an existing entry used to compare stored text only
// (lemma / cleanedLemma / normalizeLemma), so 입사하다 never found 입사(하다),
// 향상되다 never found 향상(하다/되다), and 보장되다 never found
// 보장하다 / 보장되다 — each commit created a duplicate entry instead. This
// uses the search engine's headword variants, the same ones the review
// chips and the Search tab already use. A collocation is still its own
// lemma: 날리다 never matches (주먹을) 날리다 (Stage 1E), while the
// plain-joined 주먹을 날리다 does.
//
// The index is cached per lemmaMaster array (a new array after every edit),
// so repeated lookups during one commit share one build.
const indexCache = new WeakMap();
function indexFor(lemmaMaster) {
  if (!Array.isArray(lemmaMaster)) return buildLemmaIndex([]);
  let ix = indexCache.get(lemmaMaster);
  if (!ix) { ix = buildLemmaIndex(lemmaMaster); indexCache.set(lemmaMaster, ix); }
  return ix;
}

// The existing Lemma Master entry (the stored object) for a lemma text, or null.
export function findLemmaEntryAny(lemmaMaster, lemmaText) {
  if (!lemmaText) return null;
  const e = findByLemmaText(indexFor(lemmaMaster), lemmaText);
  return e ? e.ref : null;
}

// The lemma text to store for a term: the matching entry's own lemma when
// one exists (so the row links and its def2 comes along), else the input.
export function canonicalLemma(lemmaMaster, lemmaText) {
  const hit = findLemmaEntryAny(lemmaMaster, lemmaText);
  return hit ? hit.lemma : lemmaText;
}
