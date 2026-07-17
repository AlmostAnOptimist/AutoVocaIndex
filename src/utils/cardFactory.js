// src/utils/cardFactory.js
// Auto-created flashcard factories, shared by the AVI Word Input, Sentence
// Input, and Import tabs plus AVIPage's nuance/auto-add paths. Extracted
// verbatim from AVIWordInputPage.jsx / AVISentenceInputPage.jsx (Fable sweep
// Round D, W7) so pages no longer import each other. Leaf position: this
// module imports utilities and firebase only — NEVER page files (the
// circular-import / TDZ guard, wordRowUpdater precedent).

import { doc, collection, setDoc, updateDoc, increment } from 'firebase/firestore';
import { db } from '../firebase.js';
import { normalizeLemma } from './aviUtils.js';
import { generateVocabCardAudio, generateSentenceCardAudio } from './ttsUtils.js';
import { toDateStr, getLogicalToday } from './dateUtils.js';

// ── Race-safe deck resolution ─────────────────────────────────
// Multiple card creations can run concurrently against the same stale
// in-memory decks array (e.g. the Sentence Input add loop fires word and
// sentence card factories without awaiting). Each would miss the deck and
// create a duplicate. This resolver keeps one in-flight creation promise
// per (uid, deckName): the first miss creates it, and every concurrent
// caller awaits that same promise. Entries are removed on settle so a deck
// deleted later in the session is never resurrected from a stale cache.
const deckCreatesInFlight = new Map(); // `${uid}|${deckName}` -> Promise<deckId>

async function resolveDeckId({ uid, deckName, sourceTitle, decks, aviSources, updateDecks }) {
  const existing = decks.find(d => d.name === deckName);
  if (existing) return existing.id;

  const key = `${uid}|${deckName}`;
  if (deckCreatesInFlight.has(key)) return deckCreatesInFlight.get(key);

  const creation = (async () => {
    const sourceCLId = aviSources?.find(s => s.title === sourceTitle)?.id || null;
    const deckRef    = doc(collection(db, 'users', uid, 'decks'));
    const newDeckData = {
      name:           deckName,
      linkedSourceId: sourceCLId,
      createdAt:      new Date().toISOString(),
      description:    '',
    };
    await setDoc(deckRef, newDeckData);
    updateDecks(prev =>
      prev.some(d => d.id === deckRef.id)
        ? prev
        : [...prev, { id: deckRef.id, ...newDeckData }].sort((a, b) => a.name.localeCompare(b.name))
    );
    return deckRef.id;
  })();

  deckCreatesInFlight.set(key, creation);
  try {
    return await creation;
  } finally {
    deckCreatesInFlight.delete(key);
  }
}

// ── Auto-card creation ────────────────────────────────────────
// Creates a vocab flashcard for a word entry.
// Returns the new card's Firestore ID, or null on failure.
export async function autoCreateWordCard({
  entry, lemmaMaster, decks, uid,
  updateCards, updateDecks, aviSources, dsh = 3,
}) {
  if (!entry.def2 || entry.skipUpload || !uid) return null;

  const lemmaEntry = lemmaMaster.find(l =>
    normalizeLemma(l.lemma) === normalizeLemma(entry.lemma)
  );
  const lemmaID = lemmaEntry?.lemmaID || null;

  // Find or create the deck (race-safe via the shared resolver above)
  const deckName = entry.source || 'Unknown';
  const deckId = await resolveDeckId({
    uid, deckName, sourceTitle: deckName, decks, aviSources, updateDecks,
  });

  const today    = toDateStr(getLogicalToday(dsh));
  const cardData = {
    type:                 'vocab',
    front:                entry.lemma,
    back:                 entry.def2,
    notes:                '',
    lemma:                entry.lemma,
    deckIds:              [deckId],
    linkedAVILemmaId:     lemmaID,
    linkedGrammarEntryId: null,
    easeFactor:           2.5,
    interval:             1,
    repetitions:          0,
    nextDueDate:          today,
    lastGrade:            null,
    lastReviewed:         null,
    gapEvents:            [],
    triageBucket:         null,
    lastTriageDate:       null,
    createdAt:            new Date().toISOString(),
  };

  const cardRef = doc(collection(db, 'users', uid, 'flashcards'));
  await setDoc(cardRef, cardData);
  await updateDoc(doc(db, 'users', uid, 'decks', deckId), { totalCards: increment(1) });

  updateCards(prev => [...(prev || []), { id: cardRef.id, ...cardData }]);
  updateDecks(prev =>
    prev.map(d => d.id === deckId ? { ...d, totalCards: (d.totalCards || 0) + 1 } : d)
  );

  // Fire TTS generation without awaiting — card is usable immediately, audio arrives shortly after.
  generateVocabCardAudio({ lemma: entry.lemma, cardId: cardRef.id, uid });

  return cardRef.id;
}

// Ensures a lemma captured under a given source has its own independent
// flashcard in that source's deck — matching how any other multi-source
// capture already works (separate card, separate schedule, per deck).
// Needed because auto-add/backfill/merge-created wordInputs rows never pass
// through the edit transition that triggers autoCreateWordCard above.
export async function ensureNuanceFlashcard({
  row, lemmaEntry, cards, decks, uid, updateCards, updateDecks, aviSources, dsh = 3,
}) {
  if (!lemmaEntry?.def2 || !uid) return;

  const deck = decks.find(d => d.name === row.source);
  const alreadyHasCardInDeck = !!deck && cards.some(c =>
    normalizeLemma(c.lemma) === normalizeLemma(row.lemma) && (c.deckIds || []).includes(deck.id)
  );
  if (alreadyHasCardInDeck) return;

  await autoCreateWordCard({
    entry: { ...row, def2: lemmaEntry.def2 },
    lemmaMaster: [lemmaEntry],
    decks, uid, updateCards, updateDecks, aviSources, dsh,
  });
}

// ── Auto-card creation for sentence entries ───────────────────
export async function autoCreateSentenceCard({
  entry, lemmaMaster, decks, uid, updateCards, updateDecks, aviSources, dsh = 3,
}) {
  if (!entry.cardBack || entry.skipUpload || !uid) return null;

  const lemmaEntry = lemmaMaster.find(l =>
    normalizeLemma(l.lemma) === normalizeLemma(entry.targetWord)
  );
  const lemmaID = lemmaEntry?.lemmaID || null;

  // Sentence deck = source + " (sentence mining)"
  const deckName = entry.source ? `${entry.source} (sentence mining)` : 'Sentence Mining';
  const deckId = await resolveDeckId({
    uid, deckName, sourceTitle: entry.source, decks, aviSources, updateDecks,
  });

  const today    = toDateStr(getLogicalToday(dsh));
  const cardData = {
    type:                 'sentence',
    front:                entry.targetWord + '\n' + entry.sentence,
    sentence:             entry.sentence,
    lemma:                entry.targetWord,
    inputForm:            entry.inputForm || '',
    back:                 entry.cardBack,
    notes:                '',
    deckIds:              [deckId],
    linkedAVILemmaId:     lemmaID,
    linkedGrammarEntryId: null,
    easeFactor:           2.5,
    interval:             1,
    repetitions:          0,
    nextDueDate:          today,
    lastGrade:            null,
    lastReviewed:         null,
    gapEvents:            [],
    triageBucket:         null,
    lastTriageDate:       null,
    createdAt:            new Date().toISOString(),
  };

  const cardRef = doc(collection(db, 'users', uid, 'flashcards'));
  await setDoc(cardRef, cardData);
  await updateDoc(doc(db, 'users', uid, 'decks', deckId), { totalCards: increment(1) });
  updateCards(prev => [...(prev || []), { id: cardRef.id, ...cardData }]);
  updateDecks(prev =>
    prev.map(d => d.id === deckId ? { ...d, totalCards: (d.totalCards || 0) + 1 } : d)
  );

  // Fire TTS generation without awaiting — card is usable immediately, audio arrives shortly after.
  generateSentenceCardAudio({ lemma: entry.targetWord, sentence: entry.sentence, cardId: cardRef.id, uid });

  return cardRef.id;
}