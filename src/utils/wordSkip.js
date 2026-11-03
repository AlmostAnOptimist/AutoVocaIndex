// src/utils/wordSkip.js
// Skip is a decision about a WORD in a SOURCE, not about one row. Every
// Word Input row of the same lemma in the same source, and that word's
// sentence rows in the source, share it:
//   - turning Skip on syncs all of them and offers to remove cards the
//     word already has in the source's decks;
//   - turning Skip off syncs them back and restores the cards (vocab card
//     once the lemma has a def2; sentence cards only with a def2, per L6);
//     A10: a sentence row the word's Skip turned on (skippedWithWord) comes
//     back with it; one skipped on its own (or before this marker existed)
//     is listed, and you're asked whether it comes back too;
//   - new rows of a word already skipped in the source start skipped
//     (isSkippedInSource, used by staging, Sentence Input and Import).
// Leaf position: imports utilities and firebase only — never page files.

import { doc, writeBatch, increment } from 'firebase/firestore';
import { db } from '../firebase.js';
import { normalizeLemma } from './aviUtils.js';
import { autoCreateWordCard, autoCreateSentenceCard } from './cardFactory.js';

// Deck names match the card factories exactly.
const wordDeckName     = (source) => source || 'Unknown';
const sentenceDeckName = (source) => source ? `${source} (sentence mining)` : 'Sentence Mining';
const normOf           = (s) => normalizeLemma(s || '');

// True when any Word Input row of this lemma in this source is skipped.
export function isSkippedInSource(wordInputs, source, lemma) {
  const norm = normOf(lemma);
  if (!norm) return false;
  const src = source || '';
  return (wordInputs || []).some(w =>
    w && w.skipUpload && (w.source || '') === src && normOf(w.lemma) === norm
  );
}

// The cards a word has in its source's two decks.
export function findCardsForWord({ cards, decks, source, lemma }) {
  const norm = normOf(lemma);
  const wordDeck = (decks || []).find(d => d.name === wordDeckName(source)) || null;
  const sentDeck = (decks || []).find(d => d.name === sentenceDeckName(source)) || null;
  if (!norm) return { wordDeck, sentDeck, vocab: [], sentence: [] };
  const hasLemma = (c) => !!c.lemma && normOf(c.lemma) === norm;
  const inDeck   = (c, deck) => !!deck && (c.deckIds || []).includes(deck.id);
  const vocab    = (cards || []).filter(c =>
    c.type !== 'grammar' && c.type !== 'sentence' && hasLemma(c) && inDeck(c, wordDeck)
  );
  const sentence = (cards || []).filter(c =>
    c.type === 'sentence' && hasLemma(c) && inDeck(c, sentDeck)
  );
  return { wordDeck, sentDeck, vocab, sentence };
}

// Takes the found cards out of the source's decks. A card that sits only
// in that deck is deleted; a card also filed in another deck keeps its
// other decks and just loses this one. Returns how many cards were affected.
export async function removeCardsForWord({ uid, found, updateCards, updateDecks }) {
  const plan = [];
  for (const [deck, list] of [[found.wordDeck, found.vocab], [found.sentDeck, found.sentence]]) {
    if (!deck) continue;
    for (const c of list) {
      plan.push({ id: c.id, deckId: deck.id, rest: (c.deckIds || []).filter(id => id !== deck.id) });
    }
  }
  if (!plan.length) return 0;

  const decrements = new Map();
  let batch = writeBatch(db);
  let ops   = 0;
  const flush = async () => {
    if (ops === 0) return;
    await batch.commit();
    batch = writeBatch(db);
    ops   = 0;
  };
  for (const p of plan) {
    const ref = doc(db, 'users', uid, 'flashcards', p.id);
    if (p.rest.length) batch.update(ref, { deckIds: p.rest });
    else batch.delete(ref);
    decrements.set(p.deckId, (decrements.get(p.deckId) || 0) + 1);
    ops++;
    if (ops >= 440) await flush();
  }
  for (const [deckId, n] of decrements) {
    batch.update(doc(db, 'users', uid, 'decks', deckId), { totalCards: increment(-n) });
    ops++;
    if (ops >= 440) await flush();
  }
  await flush();

  const byId = new Map(plan.map(p => [p.id, p]));
  updateCards(prev => prev
    ? prev.flatMap(c => {
        const p = byId.get(c.id);
        if (!p) return [c];
        return p.rest.length ? [{ ...c, deckIds: p.rest }] : [];
      })
    : prev);
  updateDecks(prev => prev.map(d =>
    decrements.has(d.id)
      ? { ...d, totalCards: Math.max(0, (d.totalCards || 0) - decrements.get(d.id)) }
      : d
  ));
  return plan.length;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// O2: deleting a Word Input row takes the word's flashcard with it (after
// confirming) once no studied row of that word is left in the source.
// Remaining rows that are skipped don't keep the card. Sentence cards stay:
// their sentence rows still exist. `data` is the state from before the
// delete; the deleted row is excluded by uid.
export async function removeCardsForDeletedRow({
  row, data, cards, decks, uid, updateCards, updateDecks, showAVIToast,
  confirmFn = (msg) => window.confirm(msg),
}) {
  const norm = normOf(row?.lemma);
  if (!norm || !uid) return 0;
  const src = row.source || '';
  const stillStudied = (data.wordInputs || []).some(w =>
    w.uid !== row.uid && (w.source || '') === src && normOf(w.lemma) === norm && !w.skipUpload
  );
  if (stillStudied) return 0;
  const found = findCardsForWord({ cards, decks, source: row.source, lemma: row.lemma });
  if (!found.vocab.length) return 0;
  const them = found.vocab.length === 1 ? 'it' : 'them';
  const msg =
    `"${row.lemma}" has ${plural(found.vocab.length, 'flashcard')} in "${found.wordDeck.name}" and no other Word Input row in this source.\n\n` +
    `Remove ${them} too? Review progress will be lost. A card that is also filed in another deck is only taken out of this source's deck.\n\n` +
    `OK removes ${them}. Cancel keeps ${them}.`;
  if (!confirmFn(msg)) return 0;
  try {
    const n = await removeCardsForWord({
      uid, found: { ...found, sentDeck: null, sentence: [] }, updateCards, updateDecks,
    });
    if (showAVIToast) showAVIToast(`Removed ${plural(n, 'card')} for ${row.lemma}`);
    return n;
  } catch (e) {
    console.error('Delete row: card removal failed', e);
    if (showAVIToast) showAVIToast('Could not remove the card. It is still in the deck.');
    return 0;
  }
}

// A10: the Skip fields of a sentence row that starts skipped because its
// word is skipped in the source (Sentence Input, Import).
export function inheritedSentenceSkip(skipped) {
  return skipped ? { skipUpload: true, skippedWithWord: true } : { skipUpload: false };
}

// A10: a sentence row skipped or un-skipped on its own drops the marker.
export function withOwnSentenceSkip(row, val) {
  const next = { ...row, skipUpload: val };
  delete next.skippedWithWord;
  return next;
}

const clipSentence = (s, n = 90) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// Sets Skip for the word behind `row` across its source, then removes
// (on skip, after confirming) or restores (on unskip) its cards.
export async function setWordSkip({
  row, val, data, updateData,
  cards, decks, uid, updateCards, updateDecks, aviSources, dsh,
  showAVIToast,
  confirmFn = (msg) => window.confirm(msg),
}) {
  if (!row) return;
  const norm = normOf(row.lemma);
  const src  = row.source || '';
  const sameWord = (w) => w.uid === row.uid ||
    (!!norm && (w.source || '') === src && normOf(w.lemma) === norm);
  const sameSent = (s) =>
    !!norm && (s.source || '') === src && normOf(s.targetWord) === norm;

  // A10: on un-skip, sentence rows skipped on their own (no skippedWithWord
  // marker) stay skipped unless you say they come back too. They are listed
  // so you can see which sentences they are.
  let bringBack = () => true;
  if (!val) {
    const ownSkipped = (data.sentenceInputs || []).filter(s => sameSent(s) && s.skipUpload && !s.skippedWithWord);
    if (ownSkipped.length) {
      const shown = ownSkipped.slice(0, 8).map(s => `• ${clipSentence(s.sentence)}`);
      if (ownSkipped.length > shown.length) shown.push(`…and ${ownSkipped.length - shown.length} more`);
      const these = ownSkipped.length === 1 ? 'This sentence' : `These ${ownSkipped.length} sentences`;
      const was = ownSkipped.length === 1 ? 'was' : 'were';
      const msg =
        `${these} of "${row.lemma}" in this source ${was} skipped on ${ownSkipped.length === 1 ? 'its' : 'their'} own:\n\n` +
        `${shown.join('\n')}\n\n` +
        `OK un-skips ${ownSkipped.length === 1 ? 'it' : 'them'} too. Cancel keeps ${ownSkipped.length === 1 ? 'it' : 'them'} skipped and still un-skips the word.`;
      if (!confirmFn(msg)) {
        const keep = new Set(ownSkipped.map(s => s.uid));
        bringBack = (s) => !keep.has(s.uid);
      }
    }
  }

  updateData(prev => ({
    ...prev,
    wordInputs: prev.wordInputs.map(w => sameWord(w) ? { ...w, skipUpload: val } : w),
    ...(prev.sentenceInputs ? {
      sentenceInputs: prev.sentenceInputs.map(s => {
        if (!sameSent(s)) return s;
        if (val) {
          // A row already skipped on its own keeps that (no marker).
          return s.skipUpload ? s : { ...s, skipUpload: true, skippedWithWord: true };
        }
        if (!s.skipUpload || !bringBack(s)) return s;
        return withOwnSentenceSkip(s, false);
      }),
    } : {}),
  }));

  if (!norm || !uid) return;

  // ── Skip on: offer to remove existing cards ──
  if (val) {
    const found = findCardsForWord({ cards, decks, source: row.source, lemma: row.lemma });
    const total = found.vocab.length + found.sentence.length;
    if (!total) return;
    const parts = [];
    if (found.vocab.length)    parts.push(`${plural(found.vocab.length, 'flashcard')} in "${found.wordDeck.name}"`);
    if (found.sentence.length) parts.push(`${plural(found.sentence.length, 'sentence card')} in "${found.sentDeck.name}"`);
    const them = total === 1 ? 'it' : 'them';
    const msg =
      `"${row.lemma}" already has ${parts.join(' and ')}.\n\n` +
      `Remove ${them}? Review progress on ${total === 1 ? 'that card' : 'those cards'} will be lost. ` +
      `A card that is also filed in another deck is only taken out of this source's deck.\n\n` +
      `OK removes ${them}. Cancel keeps ${them} and still skips the word.`;
    if (!confirmFn(msg)) return;
    try {
      const n = await removeCardsForWord({ uid, found, updateCards, updateDecks });
      updateData(prev => ({
        ...prev,
        wordInputs: prev.wordInputs.map(w => sameWord(w) ? { ...w, uploaded: false } : w),
        ...(prev.sentenceInputs ? {
          sentenceInputs: prev.sentenceInputs.map(s => sameSent(s) ? { ...s, uploaded: false } : s),
        } : {}),
      }));
      if (showAVIToast) showAVIToast(`Removed ${plural(n, 'card')} for ${row.lemma}`);
    } catch (e) {
      console.error('Skip: card removal failed', e);
      if (showAVIToast) showAVIToast('Could not remove the cards. They are still in the deck.');
    }
    return;
  }

  // ── Skip off: restore cards ──
  // The factories' own deck guards return an existing card instead of
  // duplicating it, so a card kept at skip time is simply reused. Sentence
  // rows with no back yet are left to AVIPage's def2 cascade.
  const lemmaEntry = (data.lemmaMaster || []).find(l => normOf(l.lemma) === norm);
  const def2 = lemmaEntry?.def2 || row.def2 || '';
  if (!def2) return;
  const common = {
    lemmaMaster: data.lemmaMaster || [],
    cards, decks, uid, updateCards, updateDecks, aviSources, dsh,
  };
  const jobs = [
    autoCreateWordCard({ ...common, entry: { ...row, def2, skipUpload: false } })
      .then(id => {
        if (!id) return;
        updateData(prev => ({
          ...prev,
          wordInputs: prev.wordInputs.map(w => sameWord(w) ? { ...w, uploaded: true } : w),
        }));
      }),
  ];
  for (const s of (data.sentenceInputs || []).filter(s => sameSent(s) && s.cardBack && (!s.skipUpload || bringBack(s)))) {
    jobs.push(
      autoCreateSentenceCard({ ...common, entry: { ...s, skipUpload: false } })
        .then(id => {
          if (!id) return;
          updateData(prev => ({
            ...prev,
            sentenceInputs: prev.sentenceInputs.map(x => x.uid === s.uid ? { ...x, uploaded: true } : x),
          }));
        })
    );
  }
  const results = await Promise.allSettled(jobs);
  for (const r of results) {
    if (r.status === 'rejected') console.error('Unskip: card restore failed', r.reason);
  }
}
