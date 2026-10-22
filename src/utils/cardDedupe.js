// src/utils/cardDedupe.js
// One card per word per deck (bug sweep A6, A9, A14). The rule shared by
// Flashcards Cleanup, the Lemma Master merge and Word Input lemma
// corrections:
//   - one vocab card per (deck, lemma); one sentence card per
//     (deck, lemma, sentence) — the cardFactory guard identities;
//   - the survivor keeps the older review history: a reviewed card beats a
//     new one, then the earliest createdAt, then the id;
//   - a losing card that is in no other deck is deleted; one that is also
//     in other decks only leaves this deck.
// Rows follow the same idea after a merge or correction: one word row per
// (source, section, lemma) and one sentence row per (source, lemma,
// sentence) — the filterNew* identities in aviUtils — keeping the older row.
// Leaf module: no page imports.

import { doc, writeBatch, increment } from 'firebase/firestore';
import { db } from '../firebase.js';
import { normalizeLemma } from './aviUtils.js';
import { isNewCard } from './fsrs.js';

const nfc = (s) => String(s || '').normalize('NFC');

export function compareCardSurvivor(a, b) {
  const an = isNewCard(a) ? 1 : 0, bn = isNewCard(b) ? 1 : 0;
  if (an !== bn) return an - bn;
  const ac = a.createdAt || '', bc = b.createdAt || '';
  if (ac !== bc) return ac.localeCompare(bc);
  return String(a.id).localeCompare(String(b.id));
}

// Plans the removals that leave one card per word per deck. Pure.
// Options narrow the pass: deckIds (only these decks), lemmas (only these
// words). Returns { deletes: [id], deckUpdates: [{ id, deckIds }],
// decrements: Map(deckId → count removed), keeps: [card] } — keeps are the
// survivors of groups that had duplicates.
export function planCardDedupe(cards, { deckIds = null, lemmas = null } = {}) {
  const deckSet  = deckIds ? new Set(deckIds) : null;
  const lemmaSet = lemmas ? new Set([...lemmas].map(normalizeLemma)) : null;
  const byId   = new Map();
  const groups = new Map();
  for (const c of cards || []) {
    if (!c || !c.id || c.type === 'grammar' || !c.lemma) continue;
    byId.set(c.id, c);
    const norm = normalizeLemma(c.lemma);
    if (lemmaSet && !lemmaSet.has(norm)) continue;
    for (const deckId of c.deckIds || []) {
      if (deckSet && !deckSet.has(deckId)) continue;
      const key = c.type === 'sentence'
        ? `${deckId}\u0000s\u0000${norm}\u0000${nfc(c.sentence)}`
        : `${deckId}\u0000w\u0000${norm}`;
      if (!groups.has(key)) groups.set(key, { deckId, cards: [] });
      groups.get(key).cards.push(c);
    }
  }
  const leave = new Map(); // card id → Set of deck ids it leaves
  const keepIds = new Set();
  for (const { deckId, cards: group } of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(compareCardSurvivor);
    keepIds.add(sorted[0].id);
    for (const c of sorted.slice(1)) {
      if (!leave.has(c.id)) leave.set(c.id, new Set());
      leave.get(c.id).add(deckId);
    }
  }
  const deletes = [], deckUpdates = [], decrements = new Map();
  for (const [id, ds] of leave) {
    const remaining = (byId.get(id).deckIds || []).filter(d => !ds.has(d));
    if (remaining.length) deckUpdates.push({ id, deckIds: remaining });
    else deletes.push(id);
    for (const d of ds) decrements.set(d, (decrements.get(d) || 0) + 1);
  }
  const keeps = [...keepIds].filter(id => !leave.has(id) || deckUpdates.some(u => u.id === id)).map(id => byId.get(id));
  return { deletes, deckUpdates, decrements, keeps };
}

export const planIsEmpty = (plan) => !plan.deletes.length && !plan.deckUpdates.length;

// R1: the cards of these words leave these decks — deleted when that leaves
// them in no deck, otherwise only the deck ids go. Same plan shape as
// planCardDedupe (for applyCardDedupe), with no survivors. Pure.
export function planDeckLeave(cards, deckIds, lemmas) {
  const deckSet  = new Set(deckIds || []);
  const lemmaSet = new Set([...(lemmas || [])].map(normalizeLemma).filter(Boolean));
  const deletes = [], deckUpdates = [], decrements = new Map();
  for (const c of cards || []) {
    if (!c || !c.id || c.type === 'grammar' || !c.lemma) continue;
    if (!lemmaSet.has(normalizeLemma(c.lemma))) continue;
    const leaving = (c.deckIds || []).filter(d => deckSet.has(d));
    if (!leaving.length) continue;
    const remaining = (c.deckIds || []).filter(d => !deckSet.has(d));
    if (remaining.length) deckUpdates.push({ id: c.id, deckIds: remaining });
    else deletes.push(c.id);
    for (const d of leaving) decrements.set(d, (decrements.get(d) || 0) + 1);
  }
  return { deletes, deckUpdates, decrements, keeps: [] };
}

// Writes a plan (batched, 450 ops per batch) and mirrors it in memory.
// survivorUpdates(card) → fields to set on a surviving card (e.g. its back),
// or null.
export async function applyCardDedupe({ uid, plan, updateCards, updateDecks, survivorUpdates = null }) {
  if (!uid || !plan || planIsEmpty(plan)) return plan;
  const keepUpdates = new Map();
  if (survivorUpdates) {
    for (const c of plan.keeps || []) {
      const u = survivorUpdates(c);
      if (u && Object.keys(u).length) keepUpdates.set(c.id, u);
    }
  }
  let batch = writeBatch(db);
  let ops = 0;
  const step = async () => {
    ops++;
    if (ops >= 450) { await batch.commit(); batch = writeBatch(db); ops = 0; }
  };
  for (const id of plan.deletes) {
    batch.delete(doc(db, 'users', uid, 'flashcards', id)); await step();
  }
  for (const { id, deckIds } of plan.deckUpdates) {
    batch.update(doc(db, 'users', uid, 'flashcards', id), { deckIds }); await step();
  }
  for (const [id, u] of keepUpdates) {
    batch.update(doc(db, 'users', uid, 'flashcards', id), u); await step();
  }
  for (const [deckId, n] of plan.decrements) {
    batch.update(doc(db, 'users', uid, 'decks', deckId), { totalCards: increment(-n) }); await step();
  }
  if (ops > 0) await batch.commit();

  const deleted = new Set(plan.deletes);
  const moved   = new Map(plan.deckUpdates.map(u => [u.id, u.deckIds]));
  if (updateCards) {
    updateCards(prev => prev
      ? prev.filter(c => !deleted.has(c.id)).map(c => {
          let n = c;
          if (moved.has(c.id))       n = { ...n, deckIds: moved.get(c.id) };
          if (keepUpdates.has(c.id)) n = { ...n, ...keepUpdates.get(c.id) };
          return n;
        })
      : prev);
  }
  if (updateDecks && plan.decrements.size) {
    updateDecks(prev => (prev || []).map(d =>
      plan.decrements.has(d.id)
        ? { ...d, totalCards: Math.max(0, (d.totalCards || 0) - plan.decrements.get(d.id)) }
        : d));
  }
  return plan;
}

// One word row per (source, section, lemma) and one sentence row per
// (source, lemma, sentence) for the given lemmas, keeping the older row
// (earliest ts; a row without ts is older). On a tie the row that was
// already on the lemma (isIncumbent) wins, then the earlier position.
// Pure; returns the arrays unchanged (same references) when nothing collides.
export function dedupeLemmaRows({ wordInputs, sentenceInputs }, lemmas, isIncumbent = () => false) {
  const set = new Set((lemmas || []).map(normalizeLemma).filter(Boolean));
  const pass = (rows, lemmaOf, keyOf) => {
    const keep = new Map(); // key → row
    for (const r of rows || []) {
      const norm = normalizeLemma(lemmaOf(r));
      if (!set.has(norm)) continue;
      const k = keyOf(r, norm);
      const cur = keep.get(k);
      const rt = r.ts || '', ct = cur ? (cur.ts || '') : '';
      if (!cur || rt < ct || (rt === ct && isIncumbent(r) && !isIncumbent(cur))) keep.set(k, r);
    }
    let dropped = 0;
    const out = (rows || []).filter(r => {
      const norm = normalizeLemma(lemmaOf(r));
      if (!set.has(norm)) return true;
      const ok = keep.get(keyOf(r, norm)) === r;
      if (!ok) dropped++;
      return ok;
    });
    return dropped ? { rows: out, dropped } : { rows, dropped };
  };
  const w = pass(wordInputs, r => r.lemma, (r, n) => `${r.source}\u0000${r.section ?? ''}\u0000${n}`);
  const s = pass(sentenceInputs, r => r.targetWord, (r, n) => `${r.source}\u0000${n}\u0000${nfc(r.sentence)}`);
  return { wordInputs: w.rows, sentenceInputs: s.rows, droppedWords: w.dropped, droppedSentences: s.dropped };
}
