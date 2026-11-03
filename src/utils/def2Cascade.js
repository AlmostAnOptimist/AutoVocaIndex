// src/utils/def2Cascade.js
// The one rule for a word's definitions and their copies (Lemma Master
// definitions work, Oct 2026; decisions LD-D1–LD-D6). Pure; leaf module.
//
// A definition lives in the Lemma Master entry and is copied to the word
// rows, the 동의어 rows, the sentence rows' cardBack, and the cards' back.
// Every def2 change goes through applyDef2Write, and every card back through
// def2CardUpdate, so the copies can't drift apart:
//   - the entry, every word row and every 동의어 row of the word take the
//     def2 (a row that changes and was uploaded is reset for review, which
//     logs the change in Recent);
//   - a sentence card's back is the word card's back: every sentence row
//     with a back takes the def2. An empty back is waiting for a def2
//     (L6): AVIPage's cascade fills it and creates the card;
//   - every vocab and sentence card of the word takes back = def2;
//   - clearing a def2 clears it on the entry and the word rows, but sentence
//     backs and card backs keep their last value until a new def2 is saved
//     (LD-D2). A back is never written empty.
// A sentence back may be the word's def1 only while the word has no def2
// (LD-D3); applyDef1BackFollow keeps such backs in step with def1 edits.

import { normalizeLemma } from './aviUtils.js';

const changedRow = (row, fields, now, reason) => ({
  ...row, ...fields,
  ...(row.uploaded ? { uploaded: false, lastUncheckReason: reason, lastUncheckDate: now } : {}),
});

// Applies a def2 to a word (all Lemma Master entries with its normalized
// lemma) and to its row copies. Returns the three arrays (the same arrays
// when nothing changed) plus counts of what changed.
export function applyDef2Write({ lemmaMaster, wordInputs, sentenceInputs }, { lemma, def2, now, reason }) {
  const norm  = normalizeLemma(lemma || '');
  const value = def2 || '';
  const counts = { entries: 0, wordRows: 0, sentenceRows: 0 };
  if (!norm) return { lemmaMaster, wordInputs, sentenceInputs, counts };

  let lm = lemmaMaster;
  if ((lemmaMaster || []).some(l => normalizeLemma(l.lemma) === norm && (l.def2 || '') !== value)) {
    lm = lemmaMaster.map(l => {
      if (normalizeLemma(l.lemma) !== norm || (l.def2 || '') === value) return l;
      counts.entries++;
      return { ...l, def2: value, lastUpdated: now, autoAddedBy: 'manual' };
    });
  }

  let words = wordInputs;
  if ((wordInputs || []).some(w => normalizeLemma(w.lemma) === norm && (w.def2 || '') !== value)) {
    words = wordInputs.map(w => {
      if (normalizeLemma(w.lemma) !== norm || (w.def2 || '') === value) return w;
      counts.wordRows++;
      return changedRow(w, { def2: value }, now, reason);
    });
  }

  let sents = sentenceInputs;
  if (value && (sentenceInputs || []).some(s => normalizeLemma(s.targetWord) === norm && s.cardBack && s.cardBack !== value)) {
    sents = sentenceInputs.map(s => {
      if (normalizeLemma(s.targetWord) !== norm || !s.cardBack || s.cardBack === value) return s;
      counts.sentenceRows++;
      return changedRow(s, { cardBack: value }, now, reason);
    });
  }

  return { lemmaMaster: lm, wordInputs: words, sentenceInputs: sents, counts };
}

// A card's back after its word's def2 is set: back = def2 for vocab and
// sentence cards alike. null = leave the card alone (grammar cards, no
// def2, or already there).
export function def2CardUpdate(card, def2) {
  if (!card || card.type === 'grammar' || !def2) return null;
  return card.back !== def2 ? { back: def2 } : null;
}

// Sentence backs that are the word's def1 follow a def1 change, but only
// while the word has no def2 (once it has one, every back is the def2).
export function applyDef1BackFollow(sentenceInputs, { lemma, oldDef1, def1, hasDef2 }) {
  const norm = normalizeLemma(lemma || '');
  if (hasDef2 || !oldDef1 || !def1 || oldDef1 === def1 || !norm) return sentenceInputs;
  if (!(sentenceInputs || []).some(s => normalizeLemma(s.targetWord) === norm && s.cardBack === oldDef1)) return sentenceInputs;
  return sentenceInputs.map(s =>
    normalizeLemma(s.targetWord) === norm && s.cardBack === oldDef1 ? { ...s, cardBack: def1 } : s);
}

// The card side of the same rule: a card whose back is the old def1 follows,
// only while the word has no def2.
export function def1CardUpdate(card, { oldDef1, def1, hasDef2 }) {
  if (!card || card.type === 'grammar' || hasDef2 || !oldDef1 || !def1 || oldDef1 === def1) return null;
  return card.back === oldDef1 ? { back: def1 } : null;
}

// Which Lemma Master entry speaks for a word when duplicates exist: one
// with a def2 over one without, then the most recently updated (D1).
// Returns Map(normalized lemma → entry).
export function pickEntriesByNorm(entries) {
  const best = new Map();
  for (const l of entries || []) {
    const k = normalizeLemma((l && l.lemma) || '');
    if (!k) continue;
    const cur = best.get(k);
    const better = !cur ||
      (!!l.def2 && !cur.def2) ||
      (!!l.def2 === !!cur.def2 && (l.lastUpdated || '') > (cur.lastUpdated || ''));
    if (better) best.set(k, l);
  }
  return best;
}

// The repair plan: every copy of a definition that differs from its word's
// Lemma Master def2 (Dev Dashboard Def2 resync; Flashcards Cleanup uses the
// card part). Words with no def2 are left alone. Returns the updates plus
// what is worth listing:
//   wordUpdates      [{ item, def2 }]       word rows → the entry's def2
//   sentenceUpdates  [{ item, cardBack }]   sentence rows with a back → def2
//   cardUpdates      [{ item, back }]       vocab and sentence cards → def2
//   wordNoCanon      [item]  a row has a def2 its entry lacks (never erased)
//   def1Backs        [item]  sentence backs that are the def1 of a word with no def2 (allowed, LD-D3)
//   otherBacks       [item]  sentence backs of a word with no def2 that are neither its def1 nor empty
//   emptyBackCards   [item]  cards with no back (Cleanup deletes these)
export function planDef2Align({ entries, wordRows, sentenceRows, cards }) {
  const byNorm = pickEntriesByNorm(entries);
  const plan = {
    wordUpdates: [], sentenceUpdates: [], cardUpdates: [],
    wordNoCanon: [], def1Backs: [], otherBacks: [], emptyBackCards: [],
  };
  for (const w of wordRows || []) {
    const e = byNorm.get(normalizeLemma(w.lemma || ''));
    if (!e || (w.def2 || '') === (e.def2 || '')) continue;
    if (e.def2) plan.wordUpdates.push({ item: w, def2: e.def2 });
    else plan.wordNoCanon.push(w);
  }
  for (const s of sentenceRows || []) {
    const e = byNorm.get(normalizeLemma(s.targetWord || ''));
    if (!e || !s.cardBack) continue;
    if (e.def2) {
      if (s.cardBack !== e.def2) plan.sentenceUpdates.push({ item: s, cardBack: e.def2 });
    } else if (s.cardBack === (e.def1 || '')) {
      plan.def1Backs.push(s);
    } else {
      plan.otherBacks.push(s);
    }
  }
  for (const c of cards || []) {
    if (!c || c.type === 'grammar') continue;
    if (c.back === '' || c.back == null) plan.emptyBackCards.push(c);
    const e = c.lemma ? byNorm.get(normalizeLemma(c.lemma)) : null;
    const u = e ? def2CardUpdate(c, e.def2) : null;
    if (u) plan.cardUpdates.push({ item: c, back: u.back, lemmaID: e.lemmaID || null });
  }
  return plan;
}

// ── Sentence Input pop-up (bug sweep A5) ──────────────────────
// Which Lemma Master entries take a new def2 from the pop-up's terms: a
// non-empty def2 that differs from the entry's (an entry with none takes it
// too). findEntry(lemmaMaster, lemma) is the page's existing-entry lookup.
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

// Applies the pop-up's moves through applyDef2Write.
export function applyDef2Moves(data, moves, now, reason) {
  let out = { lemmaMaster: data.lemmaMaster, wordInputs: data.wordInputs, sentenceInputs: data.sentenceInputs };
  if (!moves || !moves.size) return out;
  for (const m of moves.values()) {
    const r = applyDef2Write(out, { lemma: m.entry.lemma, def2: m.def2, now, reason });
    out = { lemmaMaster: r.lemmaMaster, wordInputs: r.wordInputs, sentenceInputs: r.sentenceInputs };
  }
  return out;
}
