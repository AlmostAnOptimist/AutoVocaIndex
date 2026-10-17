// src/hooks/useLemmaSearch.js
// Shared search state for the AVI Search tab and AVIMiniSearchPopup (AS2).
// Wraps lemmaSearchEngine.js: builds the index and surface map, runs the
// resolution cascade (AS-D8) including the async global lemma map step,
// and derives related / English results from the CURRENT index — so a pin,
// hide or edit re-ranks immediately without re-running the search.
//
// AS3: the state lives in a "search store" (useSearchStore). The Search tab
// receives one lifted into AVIPage, so the search, the back trail, the
// typed text and the basket survive tab switches (AS-D14); the popup uses
// its own. The trail records each anchor in order; Back and the breadcrumb
// re-anchor without adding a new step (AS-D13).
//
// State shape:
//   mode      — null (no search yet) | 'ko' | 'en'
//   query     — the text that was searched
//   anchorId  — the resolved Lemma Master entry (Korean), or null
//   status    — 'exact' | 'surface' | 'dictionary' | 'picked' | 'pending' | 'none' | 'english'
//   via       — for 'surface' / 'dictionary': the lemma text the query mapped to
//   suggestions — "Did you mean" items when status is 'pending' or 'none'

import { useState, useMemo, useCallback, useRef } from 'react';
import {
  buildLemmaIndex, buildSurfaceMap, resolveKorean, findByLemmaText,
  relatedLemmas, searchEnglish,
} from '../utils/lemmaSearchEngine.js';
import { detectMode, resolveLemmaWithDictionary } from '../utils/aviUtils.js';

const EMPTY = { mode: null, query: '', anchorId: null, status: '', via: '', suggestions: [] };
const TRAIL_CAP = 20;

// All search state that should outlive the component showing it.
export function useSearchStore(englishPage = 20) {
  const [state, setState]               = useState(EMPTY);
  const [enLimit, setEnLimit]           = useState(englishPage);
  const [trail, setTrail]               = useState([]);   // anchored lemmaIDs, oldest first
  const [input, setInput]               = useState('');   // text in the search box
  const [modeOverride, setModeOverride] = useState('Auto');
  const [basket, setBasket]             = useState([]);
  const reqRef = useRef(0);
  return {
    state, setState, enLimit, setEnLimit, trail, setTrail,
    input, setInput, modeOverride, setModeOverride, basket, setBasket, reqRef,
  };
}

export function useLemmaSearch(data, { cap = 40, englishPage = 20, store: externalStore = null } = {}) {
  const index = useMemo(() => buildLemmaIndex(data.lemmaMaster), [data.lemmaMaster]);
  const surfaceMap = useMemo(
    () => buildSurfaceMap(data.wordInputs, data.sentenceInputs),
    [data.wordInputs, data.sentenceInputs]
  );
  // Same validation set Word Input staging passes to the global lemma map.
  const localHeadwords = useMemo(() => {
    const set = new Set();
    for (const l of data.lemmaMaster || []) {
      if (l.lemma) set.add(l.lemma);
      if (l.cleanedLemma) set.add(l.cleanedLemma);
    }
    return set;
  }, [data.lemmaMaster]);

  const ownStore = useSearchStore(englishPage);
  const store = externalStore || ownStore;
  const { state, setState, enLimit, setEnLimit, trail, setTrail, reqRef } = store;
  const indexRef = useRef(index);
  indexRef.current = index;

  // Append an anchor to the trail (no-op if it is already the current step).
  const pushTrail = useCallback((lemmaID) => {
    setTrail(prev => (prev[prev.length - 1] === lemmaID ? prev : [...prev, lemmaID].slice(-TRAIL_CAP)));
  }, [setTrail]);

  // Resolves to the anchored Lemma Master object (Korean hit), or null.
  const run = useCallback(async (q, modeOverride = 'Auto') => {
    const raw = String(q || '').trim();
    if (!raw) return null;
    const token = ++reqRef.current;
    const mode = modeOverride === 'Auto' ? detectMode(raw) : modeOverride;

    if (mode === 'English') {
      setEnLimit(englishPage);
      setState({ ...EMPTY, mode: 'en', query: raw, status: 'english' });
      return null;
    }

    const r = resolveKorean(index, raw, { surfaceMap });
    if (r.entry) {
      setState({ ...EMPTY, mode: 'ko', query: raw, anchorId: r.entry.id, status: r.status, via: r.via || '' });
      pushTrail(r.entry.id);
      return r.entry.ref;
    }

    // AS-D8 step 4: global lemma map. Suggestions show while it runs.
    setState({ ...EMPTY, mode: 'ko', query: raw, status: 'pending', suggestions: r.suggestions });
    let hit = null;
    try {
      const lemma = await resolveLemmaWithDictionary(raw, { localHeadwords });
      hit = lemma ? findByLemmaText(indexRef.current, lemma) : null;
    } catch { hit = null; }
    if (token !== reqRef.current) return null;   // a newer search started
    if (hit) {
      setState({ ...EMPTY, mode: 'ko', query: raw, anchorId: hit.id, status: 'dictionary', via: hit.lemma });
      pushTrail(hit.id);
      return hit.ref;
    }
    setState(s => ({ ...s, status: 'none' }));
    return null;
  }, [index, surfaceMap, localHeadwords, englishPage, setState, setEnLimit, reqRef, pushTrail]);

  // Anchor directly on a known entry: a picked suggestion or a pivot (AS-D13).
  // `push: false` re-anchors without adding a trail step (Back, breadcrumb).
  const searchById = useCallback((lemmaID, { push = true } = {}) => {
    const e = indexRef.current.byId.get(lemmaID);
    if (!e) return null;
    ++reqRef.current;
    setState({ ...EMPTY, mode: 'ko', query: e.lemma, anchorId: e.id, status: 'picked' });
    if (push) pushTrail(e.id);
    return e.ref;
  }, [setState, reqRef, pushTrail]);

  // Trail steps that still exist in the Lemma Master (a deleted lemma drops out).
  const trailEntries = useMemo(
    () => trail.map((id, i) => ({ i, lemmaID: id, lemma: index.byId.get(id)?.lemma })).filter(t => t.lemma),
    [trail, index]
  );

  // Re-anchor on trail step `i`, dropping every later step.
  const jumpTo = useCallback((i) => {
    const id = trail[i];
    if (id === undefined) return null;
    setTrail(prev => prev.slice(0, i + 1));
    return searchById(id, { push: false });
  }, [trail, setTrail, searchById]);

  // Back: the latest surviving step before the current anchor. If the current
  // search is not anchored (English, no match), Back returns to the last anchor.
  const back = useCallback(() => {
    const live = trailEntries;
    if (!live.length) return null;
    const last = live[live.length - 1];
    const onLast = state.mode === 'ko' && state.anchorId === last.lemmaID;
    const target = onLast ? live[live.length - 2] : last;
    return target ? jumpTo(target.i) : null;
  }, [trailEntries, state.mode, state.anchorId, jumpTo]);

  const related = useMemo(
    () => (state.mode === 'ko' && state.anchorId ? relatedLemmas(index, state.anchorId, { cap }) : null),
    [index, state.mode, state.anchorId, cap]
  );
  const english = useMemo(
    () => (state.mode === 'en' ? searchEnglish(index, state.query, { limit: enLimit }) : null),
    [index, state.mode, state.query, enLimit]
  );
  // The anchored entry's CURRENT Lemma Master object (defs stay live after edits).
  const anchor = state.anchorId ? index.byId.get(state.anchorId)?.ref || null : null;
  const onLastStep = state.mode === 'ko' && trailEntries.length > 0 && trailEntries[trailEntries.length - 1].lemmaID === state.anchorId;
  const canBack = trailEntries.length > (onLastStep ? 1 : 0);

  const showMore = useCallback(() => setEnLimit(n => n + englishPage), [setEnLimit, englishPage]);

  return {
    index, surfaceMap, localHeadwords, store,
    ...state, anchor, related, english,
    trail: trailEntries, canBack,
    run, searchById, back, jumpTo, showMore,
  };
}

// ── Shared display helpers (Search tab + popup) ───────────────

export const SUGGESTION_KIND_LABEL = { prefix: 'starts with', contains: 'contains', near: 'similar spelling' };

// Tag cell for a result row: the relation if pinned, else the strongest reason.
export function rowTag(r) {
  if (r.pinForm && r.pinMeaning) return 'form + meaning';
  if (r.pinForm) return 'form';
  if (r.pinMeaning) return 'meaning';
  return (r.reasons && r.reasons[0]) || '';
}

// Status chip beside the resolved lemma.
export function statusLabel(s) {
  switch (s.status) {
    case 'exact':      return 'Exact';
    case 'picked':     return 'Picked';
    case 'surface':    return `from “${s.query}”`;
    case 'dictionary': return `dictionary form of “${s.query}”`;
    case 'pending':    return 'Checking dictionary…';
    case 'none':       return 'No exact match';
    case 'english':    return s.english ? `Showing ${s.english.results.length} of ${s.english.total}` : '';
    default:           return '';
  }
}

// Connect List (AS-D21): resolve each line through the same cascade as the
// Search tab, including the global lemma map. Lines that only reach the
// fuzzy step come back with suggestions for the user to pick from.
// `search` is the useLemmaSearch() result (index, surfaceMap, localHeadwords).
export async function resolveConnectLines(lines, { index, surfaceMap, localHeadwords }) {
  return Promise.all(lines.map(async (input) => {
    const r = resolveKorean(index, input, { surfaceMap });
    if (r.entry) return { input, status: r.status, entry: r.entry.ref, suggestions: [], pickedId: '' };
    let hit = null;
    if (/[가-힣]/.test(input)) {
      try {
        const lemma = await resolveLemmaWithDictionary(input, { localHeadwords });
        hit = lemma ? findByLemmaText(index, lemma) : null;
      } catch { hit = null; }
    }
    if (hit) return { input, status: 'dictionary', entry: hit.ref, suggestions: [], pickedId: '' };
    return { input, status: 'none', entry: null, suggestions: r.suggestions, pickedId: '' };
  }));
}
