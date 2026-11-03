// src/utils/strayCards.js
// O2: flashcards left behind for words you no longer study. A word card in
// a source's word deck is a stray when that source has no Word Input row of
// the word left, or every row of it is skipped. A sentence card in the
// source's sentence deck is a stray when the word's rows in that source are
// all skipped (Skip carries the word's sentences with it). Before Skip and
// row deletion offered to remove cards, both could leave cards behind.
// 동의어 decks are left to the 동의어 cleanup.
// Pure: no Firestore. The removal plan has applyCardDedupe's shape.

import { normalizeLemma, isNuanceSourceTitle } from './aviUtils.js';

const SENT_SUFFIX = ' (sentence mining)';
const norm = (s) => normalizeLemma(s || '');

// words: Word Input rows ({ source, lemma, skipUpload })
// cards: { id, type, lemma, deckIds }
// decks: { id, name }
// sourceTitles: Content Library titles (row sources are added to them)
// Returns [{ cardId, deckId, deckName, lemma, kind, reason }], where kind is
// 'word' | 'sentence' and reason is 'deleted' | 'skipped'.
export function planStrayCards({ words, cards, decks, sourceTitles = [] }) {
  const rows = new Map(); // `${source}|${norm}` → { any, studied }
  const titles = new Set(sourceTitles.filter(Boolean));
  for (const w of words || []) {
    const n = norm(w.lemma);
    if (!n) continue;
    const src = w.source || '';
    if (src) titles.add(src);
    const k = `${src}|${n}`;
    const r = rows.get(k) || { any: false, studied: false };
    r.any = true;
    if (!w.skipUpload) r.studied = true;
    rows.set(k, r);
  }

  // Deck → the source it belongs to, and which kind of deck it is.
  const deckInfo = new Map();
  for (const d of decks || []) {
    const name = d.name || '';
    if (name.endsWith(SENT_SUFFIX)) {
      const src = name.slice(0, -SENT_SUFFIX.length);
      if (titles.has(src) && !isNuanceSourceTitle(src)) deckInfo.set(d.id, { name, source: src, kind: 'sentence' });
    } else if (titles.has(name) && !isNuanceSourceTitle(name)) {
      deckInfo.set(d.id, { name, source: name, kind: 'word' });
    }
  }

  const out = [];
  for (const c of cards || []) {
    if (!c || !c.id || c.type === 'grammar') continue;
    const n = norm(c.lemma);
    if (!n) continue;
    const isSentence = c.type === 'sentence';
    for (const deckId of c.deckIds || []) {
      const info = deckInfo.get(deckId);
      if (!info) continue;
      if (info.kind !== (isSentence ? 'sentence' : 'word')) continue;
      const r = rows.get(`${info.source}|${n}`);
      let reason = null;
      if (isSentence) {
        if (r && r.any && !r.studied) reason = 'skipped';
      } else if (!r) {
        reason = 'deleted';
      } else if (!r.studied) {
        reason = 'skipped';
      }
      if (reason) out.push({ cardId: c.id, deckId, deckName: info.name, lemma: c.lemma, kind: isSentence ? 'sentence' : 'word', reason });
    }
  }
  out.sort((a, b) => a.deckName.localeCompare(b.deckName) || (a.lemma || '').localeCompare(b.lemma || ''));
  return out;
}

// The chosen strays leave their decks: a card left in no deck is deleted,
// otherwise only those deck ids go. Same shape as planCardDedupe.
export function planStrayRemoval(cards, strays) {
  const leave = new Map(); // cardId → Set(deckId)
  for (const s of strays || []) {
    (leave.get(s.cardId) || leave.set(s.cardId, new Set()).get(s.cardId)).add(s.deckId);
  }
  const deletes = [], deckUpdates = [], decrements = new Map();
  for (const c of cards || []) {
    const out = leave.get(c.id);
    if (!out) continue;
    const rest = (c.deckIds || []).filter(d => !out.has(d));
    if (rest.length) deckUpdates.push({ id: c.id, deckIds: rest });
    else deletes.push(c.id);
    for (const d of out) {
      if ((c.deckIds || []).includes(d)) decrements.set(d, (decrements.get(d) || 0) + 1);
    }
  }
  return { deletes, deckUpdates, decrements, keeps: [] };
}
