// src/hooks/useSentenceCardCascade.js
// The sentence cardBack cascade (L6), moved verbatim out of AVIPage so the
// reading companion runs it too (RC-D2): when a Lemma Master entry gains a
// def2 after sentence rows were committed without one, the rows take it as
// their back and their cards are created.
//
// Mirrors the nuanceInFlight guard pattern: `cardBackInFlight` is a
// synchronous guard, so an overlapping run never starts a second card for a
// row whose creation is already under way.

import { useEffect, useRef } from 'react';
import { auth } from '../firebase.js';
import { normalizeLemma } from '../utils/aviUtils.js';
import { autoCreateSentenceCard } from '../utils/cardFactory.js';

export function useSentenceCardCascade({
  data, updateData, loading,
  cards, decks, updateCards, updateDecks, aviSources, settings,
}) {
  const cardBackInFlight = useRef(new Set());
  // A6: the effect runs on Lemma Master / sentence changes only, so it reads
  // the latest decks and cards (for the duplicate guard) through a ref.
  const cascadeLive = useRef({ decks, cards });
  cascadeLive.current = { decks, cards };
  useEffect(() => {
    if (loading) return;
    const uid = auth.currentUser?.uid;
    if (!uid) return;

    // L6: only a def2 releases a sentence card. A def1 alone (e.g. the
    // post-import Def1 fill) no longer creates cards before you've decided
    // whether to study or skip the word.
    const defByNorm = {};
    for (const l of data.lemmaMaster) {
      const k = normalizeLemma(l.lemma);
      const cb = l.def2 || '';
      if (k && cb) defByNorm[k] = cb;
    }

    const toFix = data.sentenceInputs.filter(s =>
      !s.cardBack && !s.skipUpload &&
      !cardBackInFlight.current.has(s.uid) &&
      defByNorm[normalizeLemma(s.targetWord)]
    );
    if (!toFix.length) return;

    const fixMap = Object.fromEntries(
      toFix.map(s => [s.uid, defByNorm[normalizeLemma(s.targetWord)]])
    );
    toFix.forEach(s => cardBackInFlight.current.add(s.uid));

    updateData(prev => ({
      ...prev,
      sentenceInputs: prev.sentenceInputs.map(s =>
        fixMap[s.uid] ? { ...s, cardBack: fixMap[s.uid] } : s
      ),
    }));

    for (const row of toFix) {
      const cardBack = fixMap[row.uid];
      autoCreateSentenceCard({
        entry: { ...row, cardBack },
        lemmaMaster: data.lemmaMaster,
        decks: cascadeLive.current.decks, cards: cascadeLive.current.cards,
        uid, updateCards, updateDecks, aviSources,
        dsh: settings?.dayStartHour ?? 3,
      }).then(() => {
        updateData(prev => ({
          ...prev,
          sentenceInputs: prev.sentenceInputs.map(s =>
            s.uid === row.uid ? { ...s, uploaded: true } : s
          ),
        }));
      }).catch(e => console.error('cardBack cascade: card creation failed', e))
        .finally(() => cardBackInFlight.current.delete(row.uid));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.lemmaMaster, data.sentenceInputs, loading]);
}
