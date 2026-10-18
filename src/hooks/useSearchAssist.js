// src/hooks/useSearchAssist.js
// L4b: "did you mean" and dictionary-form matching for the Word Input and
// Sentence Input search bars, using the same cascade as the AVI Search tab
// (AS-D8 of the AVI search overhaul):
//   1. exact Lemma Master match, or a surface form you captured before
//      (synchronous, lemmaSearchEngine.resolveKorean);
//   2. otherwise the global lemma map, debounced so typing doesn't fire a
//      lookup per keystroke (resolveLemmaWithDictionary).
// Korean queries only. Returns:
//   anchor        — { lemma } when the query is a DIFFERENT form of a lemma
//                   you study (탐방로는 → 탐방로), else null
//   matchesAnchor — (lemma) => true for rows on that lemma
//   suggestions   — "Did you mean" lemmas for a query that matches nothing

import { useMemo, useEffect, useRef, useState } from 'react';
import { buildLemmaIndex, buildSurfaceMap, resolveKorean, findByLemmaText } from '../utils/lemmaSearchEngine.js';
import { resolveLemmaWithDictionary, normalizeLemma } from '../utils/aviUtils.js';

const DICT_DEBOUNCE_MS = 450;

export function useSearchAssist(data, query) {
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

  const raw = String(query || '').normalize('NFC').trim();
  const korean = raw.length > 0 && /[가-힣]/.test(raw);

  const sync = useMemo(
    () => (korean ? resolveKorean(index, raw, { surfaceMap, suggestionLimit: 6 }) : null),
    [korean, raw, index, surfaceMap]
  );

  // Step 2 result, tagged with the query it answers so a stale lookup is ignored.
  const [dict, setDict] = useState(null); // { query, entry } | null
  const tokenRef = useRef(0);
  const needDict = korean && !(sync && sync.entry);
  useEffect(() => {
    const token = ++tokenRef.current;
    if (!needDict) return undefined;
    const timer = setTimeout(async () => {
      let hit = null;
      try {
        const lemma = await resolveLemmaWithDictionary(raw, { localHeadwords });
        hit = lemma ? findByLemmaText(index, lemma) : null;
      } catch { hit = null; }
      if (token === tokenRef.current) setDict({ query: raw, entry: hit });
    }, DICT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [needDict, raw, index, localHeadwords]);

  const entry = (sync && sync.entry) || (dict && dict.query === raw ? dict.entry : null);
  const anchorNorm = entry ? normalizeLemma(entry.lemma) : '';
  const isSelf = !!entry && normalizeLemma(raw) === anchorNorm;
  const anchor = entry && !isSelf ? { lemma: entry.lemma } : null;

  return {
    anchor,
    matchesAnchor: (lemma) => !!anchor && normalizeLemma(lemma || '') === anchorNorm,
    anchorKey: anchor ? anchorNorm : '',
    suggestions: korean && !entry ? (sync?.suggestions || []).map(s => ({ lemmaID: s.lemmaID, lemma: s.lemma })) : [],
  };
}
