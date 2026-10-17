// src/utils/wordStaging.js
// Stage one surface form into Word Input (AS5a, AS-D30 of the AVI search
// overhaul). Moved verbatim out of
// AVIWordInputPage's handleStageWord so Word Input and the Search tab's
// "Add to Word Input" dialog (AS5b) stage words through one pipeline.
//
// What it does, in order (unchanged from Word Input):
//   1. Clean the pasted text (noise blocks, URLs, …).
//   2. Duplicate guard: same surface + source + section → no new row.
//   3. Resolve the lemma: a prior local mapping of the same surface, else the
//      trust-gated global lemma map / validated heuristic candidates.
//   4. Link an existing Lemma Master entry, or fetch def1 (with the Tier 2
//      fallback that may adopt a better lemma) for a new one.
//   5. Write the row (and a new Lemma Master entry if needed).
//   6. Auto-create the flashcard when def2 is present — unless the source's
//      deck already holds a card for the lemma.
//
// The caller owns the UI: what to do with a duplicate, clearing its input,
// paging, and the "busy" state. `onStaged(row)` runs right after the row is
// written and before card creation, matching Word Input's original timing.
// Errors other than card creation propagate to the caller.
//
// Returns one of:
//   { status: 'empty' }                          — nothing left after cleaning
//   { status: 'duplicate', row }                 — row already staged here
//   { status: 'staged', row, lemmaID, isNewLemma }
//
// Leaf module: imports only utilities.

import {
  uuid, normalizeLemma, cleanStagingText,
  resolveLemmaWithDictionary, fetchDefinitionWithFallback,
} from './aviUtils.js';
import { autoCreateWordCard } from './cardFactory.js';

export async function stageWordInput({
  surface, source, section,
  data, updateData,
  cards, decks, uid, updateCards, updateDecks, aviSources, dsh,
  showAVIToast,
  onStaged,
  logPrefix = 'Word Input',
}) {
  const cleaned = cleanStagingText(surface, data.aviSettings.noiseBlocks || []);
  if (!cleaned) return { status: 'empty' };

  // Duplicate staging guard: the same surface in the same section of the
  // same source doesn't need a second row. (Non-Hangul surfaces match
  // case-insensitively, consistent with the Import engine.)
  const surfKey  = (s) => /[가-힣]/.test(s) ? s : String(s).toLowerCase();
  const exactDup = data.wordInputs.find(w =>
    surfKey(w.input || '') === surfKey(cleaned) &&
    w.source === source &&
    String(w.section ?? '') === String(section ?? '')
  );
  if (exactDup) return { status: 'duplicate', row: exactDup };

  // 1. Check local word inputs for prior mapping of same surface form
  let lemmaText = null;
  const localMatch = data.wordInputs.find(w => w.input === cleaned && w.lemma);
  if (localMatch) lemmaText = localMatch.lemma;

  // 2+3. Trust-gated global lemma map, then heuristic candidates
  // (including irregular recoveries) validated as dictionary
  // headwords, then the sync heuristic.
  if (!lemmaText) {
    const localHeadwords = new Set();
    for (const l of (data.lemmaMaster || [])) {
      if (l.lemma) localHeadwords.add(l.lemma);
      if (l.cleanedLemma) localHeadwords.add(l.cleanedLemma);
    }
    lemmaText = await resolveLemmaWithDictionary(cleaned, { localHeadwords }) || cleaned;
  }

  let normLemma = normalizeLemma(lemmaText);
  let existingLemmaEntry = data.lemmaMaster.find(
    l => l.cleanedLemma === normLemma || l.lemma === lemmaText ||
         normalizeLemma(l.lemma) === normLemma
  );

  let def1 = '', def2 = '';
  if (existingLemmaEntry) {
    def1 = existingLemmaEntry.def1 || '';
    def2 = existingLemmaEntry.def2 || '';
  } else if (lemmaText && lemmaText.length <= 120) {
    // Tier 2: a dictionary miss on a machine-resolved lemma retries the
    // surface's next candidates; a hit adopts that lemma. Skipped when a
    // prior local mapping supplied the lemma. Adoption recomputes the
    // lemmaMaster link so an already-studied lemma is linked, not duplicated.
    const fb = await fetchDefinitionWithFallback(localMatch ? '' : cleaned, lemmaText, data.aviSettings);
    if (fb.def1 === '__RATE_LIMITED__') {
      showAVIToast('API rate limit reached — switch to KRDict mode in Settings.');
      def1 = '';
    } else {
      if (fb.lemma !== lemmaText) {
        lemmaText = fb.lemma;
        normLemma = normalizeLemma(lemmaText);
        existingLemmaEntry = data.lemmaMaster.find(
          l => l.cleanedLemma === normLemma || l.lemma === lemmaText ||
               normalizeLemma(l.lemma) === normLemma
        );
      }
      if (existingLemmaEntry) {
        def1 = existingLemmaEntry.def1 || fb.def1;
        def2 = existingLemmaEntry.def2 || '';
      } else {
        def1 = fb.def1;
      }
    }
  }

  const newUid = uuid();
  const newEntry = {
    uid:              newUid,
    ts:               new Date().toISOString(),
    input:            cleaned,
    source:           source,
    section:          section,
    lemma:            lemmaText,
    def1,
    def2,
    uploaded:         false,
    skipUpload:       false,
    lastUncheckReason: '',
    lastUncheckDate:   '',
  };

  // Update lemmaMaster if no existing entry
  let lemmaID = existingLemmaEntry ? existingLemmaEntry.lemmaID : null;
  if (!existingLemmaEntry) {
    const newLemma = {
      lemma:       lemmaText,
      def1,
      def2:        '',
      relatedForm:    '',
      relatedMeaning: '',
      hiddenRelated:  '',
      lastUpdated:  new Date().toISOString(),
      autoAddedBy:  'auto:staging',
      cleanedLemma: normLemma,
      originUID:    newUid,
      lemmaID:      uuid(),
    };
    lemmaID = newLemma.lemmaID;
    updateData(prev => ({
      ...prev,
      wordInputs:  [newEntry, ...prev.wordInputs],
      lemmaMaster: [...prev.lemmaMaster, newLemma],
    }));
  } else {
    updateData(prev => ({
      ...prev,
      wordInputs: [newEntry, ...prev.wordInputs],
    }));
  }

  if (onStaged) onStaged(newEntry);

  // Auto-create flashcard if def2 is present — unless the deck for this
  // source already holds a card for the lemma (same source, different
  // section: the row is wanted for section counts, a duplicate card is not).
  const targetDeck = decks.find(d => d.name === source);
  const cardExistsInDeck = !!targetDeck && (cards || []).some(c =>
    c.type !== 'grammar' && c.lemma &&
    normalizeLemma(c.lemma) === normLemma &&
    (c.deckIds || []).includes(targetDeck.id)
  );
  if (def2 && !newEntry.skipUpload && cardExistsInDeck) {
    updateData(prev => ({
      ...prev,
      wordInputs: prev.wordInputs.map(w =>
        w.uid === newUid ? { ...w, uploaded: true } : w
      ),
    }));
  } else if (def2 && !newEntry.skipUpload) {
    try {
      await autoCreateWordCard({
        entry:        newEntry,
        lemmaMaster:  data.lemmaMaster,
        decks,
        uid,
        updateCards,
        updateDecks,
        aviSources,
        dsh,
      });
      updateData(prev => ({
        ...prev,
        wordInputs: prev.wordInputs.map(w =>
          w.uid === newUid ? { ...w, uploaded: true } : w
        ),
      }));
    } catch (e) {
      console.error(`${logPrefix}: card creation failed`, e);
    }
  }

  return { status: 'staged', row: newEntry, lemmaID, isNewLemma: !existingLemmaEntry };
}
