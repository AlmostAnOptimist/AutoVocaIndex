// src/utils/wordLookup.js
// The reading companion's automatic word lookup (RC-D7).
// It resolves a typed or pasted word the way
// stageWordInput (wordStaging.js) does, and says which of three things the
// companion should show before anything is added:
//
//   match      — the word is already in Lemma Master, exactly or as one of an
//                entry's forms (L4d: 향상되다 → 향상(하다/되다)); its defs fill in.
//                `choices` are the other close entries, for "Not this one?".
//   near       — no entry, but close ones exist ("Did you mean": the same form
//                added before, starts the same, one jamo off). No dictionary
//                call until asked for.
//   dictionary — nothing close, so the dictionary was asked (the dictionary
//                mode, with the Tier 2 retry); `def1` is what it found.
//   empty      — nothing left after noise cleaning.
//
// The Lemma Master check costs nothing; only `dictionary` (or a tap on
// "Look up in the dictionary") spends a dictionary call.
//
// Leaf module: imports only utilities. The network-facing steps can be
// swapped through `deps` for tests.

import {
  normalizeLemma, cleanStagingText,
  resolveLemmaWithDictionary, fetchDefinitionWithFallback,
} from './aviUtils.js';
import { findLemmaEntryAny, lemmaChoicesForTerm } from './lemmaSuggest.js';

// Same exact match stageWordInput uses (stored text, cleaned or normalized).
export function findExactLemmaEntry(lemmaMaster, lemmaText) {
  if (!lemmaText) return null;
  const norm = normalizeLemma(lemmaText);
  return (lemmaMaster || []).find(
    l => l.cleanedLemma === norm || l.lemma === lemmaText || normalizeLemma(l.lemma) === norm
  ) || null;
}

// True while the last character is a lone jamo (a syllable still being
// typed), so a pause there doesn't look up half a word.
export function endsMidSyllable(text) {
  return /[ㄱ-ㆎ]$/.test(String(text || '').trim());
}

// The lookup. `index` and `surfaceMap` come from lemmaSearchEngine
// (buildLemmaIndex / buildSurfaceMap) for the current Lemma Master and rows.
export async function lookupWord({ surface, data, index, surfaceMap = null, deps = {} }) {
  const resolve = deps.resolveLemma || resolveLemmaWithDictionary;
  const cleaned = cleanStagingText(surface, data.aviSettings?.noiseBlocks || []);
  if (!cleaned) return { status: 'empty' };

  // A prior local mapping of the same surface wins, as in Word Input.
  const localMatch = (data.wordInputs || []).find(w => w.input === cleaned && w.lemma);
  let lemma = localMatch ? localMatch.lemma : null;
  if (!lemma) {
    const localHeadwords = new Set();
    for (const l of (data.lemmaMaster || [])) {
      if (l.lemma) localHeadwords.add(l.lemma);
      if (l.cleanedLemma) localHeadwords.add(l.cleanedLemma);
    }
    lemma = await resolve(cleaned, { localHeadwords }) || cleaned;
  }
  const base = { cleaned, lemma, fromLocal: !!localMatch };

  const exact   = findExactLemmaEntry(data.lemmaMaster, lemma);
  const variant = exact ? null : findLemmaEntryAny(data.lemmaMaster || [], lemma);
  const entry   = exact || variant;
  const { choices } = lemmaChoicesForTerm(index, { input: cleaned, lemma: entry ? entry.lemma : lemma }, { surfaceMap });

  if (entry) {
    return {
      ...base, status: 'match', via: exact ? 'exact' : 'variant', entry,
      choices: choices.filter(c => c.lemmaID !== entry.lemmaID),
    };
  }
  if (choices.length) return { ...base, status: 'near', choices };
  return { ...base, ...(await lookupInDictionary({ ...base, data, deps })) };
}

// The dictionary step on its own: automatic when nothing was close, or on a
// tap. `allowVariant: false` (asked for from "Not this one?") keeps a Tier 2
// adoption from landing on the variant entry just turned down; an exact
// entry still links, so the same word is never added twice.
export async function lookupInDictionary({ cleaned, lemma, fromLocal = false, data, allowVariant = true, deps = {} }) {
  const fetchDef = deps.fetchDefinition || fetchDefinitionWithFallback;
  const fb = await fetchDef(fromLocal ? '' : cleaned, lemma, data.aviSettings);
  if (fb.def1 === '__RATE_LIMITED__') {
    return { status: 'dictionary', cleaned, lemma, def1: '', rateLimited: true };
  }
  if (fb.lemma !== lemma) {
    // Tier 2 adopted another reading: link it if Lemma Master has it.
    const hit = findExactLemmaEntry(data.lemmaMaster, fb.lemma)
      || (allowVariant ? findLemmaEntryAny(data.lemmaMaster || [], fb.lemma) : null);
    if (hit) return { status: 'match', via: 'adopted', cleaned, lemma: hit.lemma, entry: hit, choices: [] };
  }
  const def1 = fb.def1 || '';
  return {
    status: 'dictionary', cleaned, lemma: fb.lemma, def1,
    notFound: def1 === 'Definition not found.',
    unreachable: !def1,
  };
}

// What stageWordInput is handed for a lookup the companion settled on.
//   result  — a lookupWord / lookupInDictionary result
//   chosen  — a Lemma Master entry picked from "Did you mean" (optional)
//   refused — true when the dictionary was chosen over a variant match
export function resolvedForStaging(result, { chosen = null, refused = false } = {}) {
  if (chosen) return { lemma: chosen.lemma, def1: chosen.def1 || '', entryId: chosen.lemmaID };
  if (!result) return null;
  if (result.status === 'match') {
    return { lemma: result.entry.lemma, def1: result.entry.def1 || '', entryId: result.entry.lemmaID };
  }
  if (result.status === 'dictionary') {
    return { lemma: result.lemma, def1: result.unreachable ? '' : result.def1, entryId: null, noVariant: !!refused };
  }
  return null;
}
