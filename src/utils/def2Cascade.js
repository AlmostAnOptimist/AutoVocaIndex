// src/utils/def2Cascade.js
// A lemma's def2 changing outside Lemma Master (bug sweep A5: the Sentence
// Input pop-up). Pure; leaf module.

import { normalizeLemma } from './aviUtils.js';

// Which Lemma Master entries take a new def2 from the pop-up's terms:
// a non-empty def2 that differs from the entry's (an entry with none takes
// it too). findEntry(lemmaMaster, lemma) is the page's existing-entry lookup.
// Returns Map(lemmaID → { entry, def2, norm }).
export function planDef2Moves(terms, lemmaMaster, findEntry) {
  const moves = new Map();
  for (const t of terms || []) {
    const entry = findEntry(lemmaMaster, t.lemma);
    const typed = t.def2 || '';
    if (entry && typed && typed !== (entry.def2 || '')) {
      moves.set(entry.lemmaID, { entry, def2: typed, norm: normalizeLemma(entry.lemma) });
    }
  }
  return moves;
}

// Applies the moves the way a def2 edit in Lemma Master does: the entry takes
// the def2, the lemma's word rows follow (reset for review if uploaded), and
// sentence backs that were the old def2 follow. An empty back is left for
// AVIPage's cascade (L6); a hand-edited back is kept.
export function applyDef2Moves({ lemmaMaster, wordInputs, sentenceInputs }, moves, now, reason) {
  if (!moves || !moves.size) return { lemmaMaster, wordInputs, sentenceInputs };
  const byNorm = new Map([...moves.values()].map(m => [m.norm, m]));
  return {
    lemmaMaster: lemmaMaster.map(l => moves.has(l.lemmaID)
      ? { ...l, def2: moves.get(l.lemmaID).def2, lastUpdated: now, autoAddedBy: 'manual' } : l),
    wordInputs: wordInputs.map(w => {
      const m = byNorm.get(normalizeLemma(w.lemma));
      if (!m || (w.def2 || '') === m.def2) return w;
      return {
        ...w, def2: m.def2,
        ...(w.uploaded ? { uploaded: false, lastUncheckReason: reason, lastUncheckDate: now } : {}),
      };
    }),
    sentenceInputs: sentenceInputs.map(s => {
      const m = byNorm.get(normalizeLemma(s.targetWord));
      if (!m || !s.cardBack || !m.entry.def2 || s.cardBack !== m.entry.def2) return s;
      return {
        ...s, cardBack: m.def2,
        ...(s.uploaded ? { uploaded: false, lastUncheckReason: reason, lastUncheckDate: now } : {}),
      };
    }),
  };
}

// A card's back after the move: a vocab back is the lemma's def2; a sentence
// back follows only if it was the old def2. null = leave the card alone.
export function def2CardUpdate(card, oldDef2, def2) {
  if (card.type === 'sentence') return card.back === oldDef2 ? { back: def2 } : null;
  return card.back !== def2 ? { back: def2 } : null;
}
