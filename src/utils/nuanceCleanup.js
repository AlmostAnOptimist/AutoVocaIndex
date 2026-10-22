// src/utils/nuanceCleanup.js
// Dev Dashboard → AVI Maintenance → 동의어 cleanup (bug sweep R1, R2).
// Clears what the two bugs left behind before they were fixed:
//   - relation ids that point at deleted Lemma Master entries (R2);
//   - 동의어 rows of words with no synonym left (R2 kept them there);
//   - those words' cards in the 동의어 deck (R1) — deleted when that is their
//     only deck, otherwise they only leave it.
// Words deleted from Lemma Master keep their cards, as the delete promised.
// Pure apart from the Firestore refs it carries through. Leaf module.

import { normalizeLemma, stripLemmaRelations, liveMeaningIds, isNuanceSourceTitle } from './aviUtils.js';
import { planDeckLeave } from './cardDedupe.js';

//   lm, words    — [{ ref, data }] (Firestore docs)
//   cards, decks — [{ id, ...data }]
// Returns relationUpdates [{ ref, fields, label }], rowDeletes [{ ref, label }],
// cardPlan (planDeckLeave shape, for applyCardDedupe) and cardLabels.
export function planNuanceCleanup({ lm, words, cards, decks }) {
  const entries  = lm.map(x => x.data);
  const existing = new Set(entries.map(e => e.lemmaID).filter(Boolean));
  const dead = new Set();
  for (const e of entries) {
    for (const f of ['relatedForm', 'relatedMeaning', 'hiddenRelated']) {
      String(e[f] || '').split(',').map(s => s.trim()).filter(Boolean)
        .forEach(id => { if (!existing.has(id)) dead.add(id); });
    }
  }
  const { lemmaMaster: cleaned } = stripLemmaRelations(entries, [...dead]);
  const relationUpdates = [];
  cleaned.forEach((e, i) => {
    if (e === entries[i]) return;
    relationUpdates.push({
      ref: lm[i].ref,
      fields: {
        relatedForm: e.relatedForm || '', relatedMeaning: e.relatedMeaning || '',
        hiddenRelated: e.hiddenRelated || '', lastUpdated: e.lastUpdated,
      },
      label: e.lemma || '(no lemma)',
    });
  });

  // Words in Lemma Master with no synonym left. With duplicate entries for
  // one word, the word keeps its place if any entry still has a synonym.
  const withSynonym = new Set(), noSynonym = new Set();
  for (const e of cleaned) {
    const k = normalizeLemma(e.lemma || '');
    if (!k) continue;
    if (liveMeaningIds(e, existing).length) withSynonym.add(k); else noSynonym.add(k);
  }
  withSynonym.forEach(k => noSynonym.delete(k));

  const rowDeletes = words
    .filter(({ data }) => isNuanceSourceTitle(data.source) && noSynonym.has(normalizeLemma(data.lemma || '')))
    .map(({ ref, data }) => ({ ref, label: data.lemma || '(no lemma)' }));

  const deckIds  = (decks || []).filter(d => isNuanceSourceTitle(d.name)).map(d => d.id);
  const cardPlan = planDeckLeave(cards, deckIds, noSynonym);
  const planned  = new Set([...cardPlan.deletes, ...cardPlan.deckUpdates.map(u => u.id)]);
  const cardLabels = (cards || []).filter(c => planned.has(c.id)).map(c => c.lemma || '(no lemma)');
  return { relationUpdates, rowDeletes, cardPlan, cardLabels };
}
