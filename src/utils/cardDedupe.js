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

import { doc, writeBatch, increment, collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../firebase.js';
import { normalizeLemma } from './aviUtils.js';
import { isNewCard } from './fsrs.js';
import { wordSeries } from './seriesDecks.js';

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

// ── Same-name decks (Oct 22 2026) ────────────────────────────
// Cards find their deck by NAME (cardFactory resolveDeckId), so two decks
// sharing a name split one source's cards between them. A source rename
// onto a title that already had a deck makes exactly that (the 헝거게임 →
// 헝거게임 1 case: a 3-card deck beside the 1145-card one). The merge keeps
// the deck with the most cards (its id, paused/reversed settings and
// lastStudied stay), then the earliest createdAt, then the id. The other
// decks' cards move into it, one card per word per deck is restored with
// the planCardDedupe rule (older review history wins), and the emptied
// decks are deleted. The survivor's linkedSourceId is pointed at the live
// Content Library source of that title when there is exactly one.

const SENTENCE_DECK_SUFFIX = ' (sentence mining)';
const deckNameKey = (name) => nfc(name).trim();

// Pure. decks: deck docs; cards: every card in those decks;
// sourceIdByTitle: Map(source title → content source id), optional.
export function planDeckNameMerge(decks, cards, sourceIdByTitle = null) {
  const groups = new Map();
  for (const d of decks || []) {
    if (!d || !d.id || d.id === 'deck_grammar' || d.type === 'grammar') continue;
    const k = deckNameKey(d.name);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  }
  const counts = new Map();
  for (const c of cards || []) for (const id of c.deckIds || []) counts.set(id, (counts.get(id) || 0) + 1);

  const remap  = new Map(); // loser deck id → survivor deck id
  const merges = [];
  for (const [name, members] of groups) {
    if (members.length < 2) continue;
    const [survivor, ...losers] = [...members].sort((a, b) =>
      ((counts.get(b.id) || 0) - (counts.get(a.id) || 0)) ||
      (a.createdAt || '').localeCompare(b.createdAt || '') ||
      String(a.id).localeCompare(String(b.id)));
    losers.forEach(l => remap.set(l.id, survivor.id));
    const baseTitle = name.endsWith(SENTENCE_DECK_SUFFIX) ? name.slice(0, -SENTENCE_DECK_SUFFIX.length) : name;
    const linkedSourceId = sourceIdByTitle?.get(baseTitle)
      || survivor.linkedSourceId
      || losers.find(l => l.linkedSourceId)?.linkedSourceId
      || null;
    merges.push({
      name, survivorId: survivor.id, loserIds: losers.map(l => l.id),
      linkedSourceId, relink: linkedSourceId !== (survivor.linkedSourceId || null),
    });
  }
  const empty = { merges, cardUpdates: [], deletes: [], totals: new Map(), moved: 0, duplicates: 0 };
  if (!merges.length) return empty;

  const movedIds = new Set();
  const remapped = (cards || []).map(c => {
    const ids = c.deckIds || [];
    if (!ids.some(id => remap.has(id))) return c;
    movedIds.add(c.id);
    return { ...c, deckIds: [...new Set(ids.map(id => remap.get(id) || id))] };
  });

  const survivorIds = merges.map(m => m.survivorId);
  const dedupe      = planCardDedupe(remapped, { deckIds: survivorIds });
  const deleteSet   = new Set(dedupe.deletes);
  const dedupeDecks = new Map(dedupe.deckUpdates.map(u => [u.id, u.deckIds]));

  const cardUpdates = [];
  const totals = new Map(survivorIds.map(id => [id, 0]));
  let movedKept = 0; // cards from a merged-away deck that now sit in the survivor
  for (const c of remapped) {
    if (deleteSet.has(c.id)) continue;
    const deckIds = dedupeDecks.get(c.id) || c.deckIds || [];
    if (dedupeDecks.has(c.id) || movedIds.has(c.id)) cardUpdates.push({ id: c.id, deckIds });
    for (const id of deckIds) if (totals.has(id)) totals.set(id, totals.get(id) + 1);
    if (movedIds.has(c.id) && deckIds.some(id => totals.has(id))) movedKept++;
  }
  return {
    merges, cardUpdates, deletes: dedupe.deletes, totals,
    moved: movedKept, duplicates: dedupe.deletes.length + dedupe.deckUpdates.length,
  };
}

// Reads the decks fresh (all of them, or only the given names), plans the
// merge, writes it (450 ops per batch) and mirrors it in memory.
// Returns the plan ({ merges: [] } when nothing shares a name).
export async function mergeSameNameDecks({ uid, names = null, updateCards, updateDecks }) {
  if (!uid) return null;
  const decksCol = collection(db, 'users', uid, 'decks');
  const snaps = names
    ? await Promise.all([...new Set(names.filter(Boolean))].map(n => getDocs(query(decksCol, where('name', '==', n)))))
    : [await getDocs(decksCol)];
  const deckMap = new Map();
  for (const snap of snaps) for (const d of snap.docs) deckMap.set(d.id, { id: d.id, ...d.data() });

  // Only decks that share a name matter from here on.
  const byKey = new Map();
  for (const d of deckMap.values()) {
    if (d.id === 'deck_grammar' || d.type === 'grammar') continue;
    const k = deckNameKey(d.name);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(d);
  }
  const dupDecks = [...byKey.values()].filter(g => g.length > 1).flat();
  if (!dupDecks.length) return { merges: [] };

  const cardMap = new Map();
  const fcCol   = collection(db, 'users', uid, 'flashcards');
  const ids     = dupDecks.map(d => d.id);
  for (let i = 0; i < ids.length; i += 10) {
    const snap = await getDocs(query(fcCol, where('deckIds', 'array-contains-any', ids.slice(i, i + 10))));
    for (const c of snap.docs) cardMap.set(c.id, { id: c.id, ...c.data() });
  }

  const sourceIdByTitle = new Map();
  const titles = new Set(dupDecks.map(d => {
    const k = deckNameKey(d.name);
    return k.endsWith(SENTENCE_DECK_SUFFIX) ? k.slice(0, -SENTENCE_DECK_SUFFIX.length) : k;
  }));
  const srcCol = collection(db, 'users', uid, 'content_sources');
  for (const t of titles) {
    try {
      const snap = await getDocs(query(srcCol, where('title', '==', t)));
      if (snap.docs.length === 1) sourceIdByTitle.set(t, snap.docs[0].id);
    } catch (e) {
      console.error('mergeSameNameDecks: source lookup failed', e);
    }
  }

  const plan = planDeckNameMerge(dupDecks, [...cardMap.values()], sourceIdByTitle);
  if (!plan.merges.length) return plan;

  let batch = writeBatch(db);
  let ops = 0;
  const step = async () => {
    ops++;
    if (ops >= 450) { await batch.commit(); batch = writeBatch(db); ops = 0; }
  };
  for (const id of plan.deletes) {
    batch.delete(doc(db, 'users', uid, 'flashcards', id)); await step();
  }
  for (const { id, deckIds } of plan.cardUpdates) {
    batch.update(doc(db, 'users', uid, 'flashcards', id), { deckIds }); await step();
  }
  for (const m of plan.merges) {
    const u = { totalCards: plan.totals.get(m.survivorId) || 0 };
    if (m.relink) u.linkedSourceId = m.linkedSourceId;
    batch.update(doc(db, 'users', uid, 'decks', m.survivorId), u); await step();
    for (const loserId of m.loserIds) {
      batch.delete(doc(db, 'users', uid, 'decks', loserId)); await step();
    }
  }
  if (ops > 0) await batch.commit();

  const deleted = new Set(plan.deletes);
  const moved   = new Map(plan.cardUpdates.map(u => [u.id, u.deckIds]));
  if (updateCards) {
    updateCards(prev => prev
      ? prev.filter(c => !deleted.has(c.id)).map(c => moved.has(c.id) ? { ...c, deckIds: moved.get(c.id) } : c)
      : prev);
  }
  if (updateDecks) {
    const losers = new Set(plan.merges.flatMap(m => m.loserIds));
    const bySurvivor = new Map(plan.merges.map(m => [m.survivorId, m]));
    updateDecks(prev => (prev || [])
      .filter(d => !losers.has(d.id))
      .map(d => {
        const m = bySurvivor.get(d.id);
        if (!m) return d;
        return { ...d, totalCards: plan.totals.get(d.id) || 0, ...(m.relink ? { linkedSourceId: m.linkedSourceId } : {}) };
      }));
  }
  return plan;
}

// ── One word card per series (SD-D8, Oct 22 2026) ────────────
// Words that were carded separately in two books of one Content Library
// series become one card in both books' decks. The survivor is the card
// with more review history: reviewed over new, then more reviews (reps),
// then the earliest createdAt, then the id. The other cards leave the
// series' decks (deleted when that was their only deck).

export function compareHistorySurvivor(a, b) {
  const an = isNewCard(a) ? 1 : 0, bn = isNewCard(b) ? 1 : 0;
  if (an !== bn) return an - bn;
  const ar = a.reps || a.repetitions || 0, br = b.reps || b.repetitions || 0;
  if (ar !== br) return br - ar;
  return compareCardSurvivor(a, b);
}

// Pure. groups: buildSeriesGroups(...). Returns { deletes: [id],
// cardUpdates: [{ id, deckIds }], deckDeltas: Map(deckId → ±n), words: n }.
export function planSeriesShare(cards, groups) {
  const deletes = new Set();
  const nextDecks = new Map(); // card id → deckIds after the share
  const deckDeltas = new Map();
  let words = 0;
  const bump = (id, n) => deckDeltas.set(id, (deckDeltas.get(id) || 0) + n);
  const deckIdsOf = (c) => nextDecks.get(c.id) || c.deckIds || [];
  for (const g of wordSeries(groups)) {
    const members = new Set(g.wordDeckIds);
    const byLemma = new Map();
    for (const c of cards || []) {
      if (!c || !c.id || deletes.has(c.id) || c.type === 'grammar' || c.type === 'sentence' || !c.lemma) continue;
      if (!deckIdsOf(c).some(id => members.has(id))) continue;
      const k = normalizeLemma(c.lemma);
      if (!byLemma.has(k)) byLemma.set(k, []);
      byLemma.get(k).push(c);
    }
    for (const group of byLemma.values()) {
      if (group.length < 2) continue;
      words++;
      const [survivor, ...losers] = [...group].sort(compareHistorySurvivor);
      const survivorDecks = new Set(deckIdsOf(survivor));
      for (const l of losers) {
        const lDecks = deckIdsOf(l);
        for (const id of lDecks) {
          if (!members.has(id)) continue;
          bump(id, -1);
          if (!survivorDecks.has(id)) { survivorDecks.add(id); bump(id, 1); }
        }
        const remaining = lDecks.filter(id => !members.has(id));
        if (remaining.length) nextDecks.set(l.id, remaining);
        else { deletes.add(l.id); nextDecks.delete(l.id); }
      }
      nextDecks.set(survivor.id, [...survivorDecks]);
    }
  }
  const byId = new Map((cards || []).map(c => [c.id, c]));
  const cardUpdates = [...nextDecks]
    .filter(([id, deckIds]) => {
      const before = byId.get(id)?.deckIds || [];
      return before.length !== deckIds.length || before.some(d => !deckIds.includes(d));
    })
    .map(([id, deckIds]) => ({ id, deckIds }));
  for (const [id, n] of deckDeltas) if (!n) deckDeltas.delete(id);
  return { deletes: [...deletes], cardUpdates, deckDeltas, words };
}

// Writes a planSeriesShare plan (450 ops per batch) and mirrors it in memory.
export async function applySeriesShare({ uid, plan, updateCards, updateDecks }) {
  if (!uid || !plan || (!plan.deletes.length && !plan.cardUpdates.length)) return plan;
  let batch = writeBatch(db);
  let ops = 0;
  const step = async () => {
    ops++;
    if (ops >= 450) { await batch.commit(); batch = writeBatch(db); ops = 0; }
  };
  for (const id of plan.deletes) {
    batch.delete(doc(db, 'users', uid, 'flashcards', id)); await step();
  }
  for (const { id, deckIds } of plan.cardUpdates) {
    batch.update(doc(db, 'users', uid, 'flashcards', id), { deckIds }); await step();
  }
  for (const [deckId, n] of plan.deckDeltas) {
    batch.update(doc(db, 'users', uid, 'decks', deckId), { totalCards: increment(n) }); await step();
  }
  if (ops > 0) await batch.commit();

  const deleted = new Set(plan.deletes);
  const moved   = new Map(plan.cardUpdates.map(u => [u.id, u.deckIds]));
  if (updateCards) {
    updateCards(prev => prev
      ? prev.filter(c => !deleted.has(c.id)).map(c => moved.has(c.id) ? { ...c, deckIds: moved.get(c.id) } : c)
      : prev);
  }
  if (updateDecks && plan.deckDeltas.size) {
    updateDecks(prev => (prev || []).map(d => plan.deckDeltas.has(d.id)
      ? { ...d, totalCards: Math.max(0, (d.totalCards || 0) + plan.deckDeltas.get(d.id)) }
      : d));
  }
  return plan;
}
