// src/utils/wordRowUpdater.js
// The Word Input row-edit cascade (lemma rename with migrate-all prompt,
// def1/def2 propagation to siblings, sentence rows, lemmaMaster, and linked
// flashcards, plus auto card creation) — extracted verbatim from
// AVIWordInputPage.jsx so the Import tab's post-commit Fill-Def2 pass can
// drive the identical logic through the shared WordEditModal.
// autoCreateWordCard is injected by the caller: this module must not import
// the page files (circular-import / TDZ guard).

import { auth } from '../firebase.js';
import {
  uuid, normalizeLemma, writeGlobalLemma, fetchDefinition, updateLinkedCards,
} from './aviUtils.js';

export function makeUpdateRow({
  data, updateData, cards, updateCards, decks, updateDecks, aviSources,
  autoCreateWordCard, dsh = 3,
}) {
  return async (uid, allEdits) => {
      const originalRow = data.wordInputs.find(w => w.uid === uid);
      if (!originalRow) return;

      const newLemmaText = allEdits.lemma;
      const lemmaChanged = newLemmaText !== undefined &&
        normalizeLemma(newLemmaText) !== normalizeLemma(originalRow.lemma);

      // Fetch fresh def1 if lemma changed
      let fetchedDef1 = null;
      if (lemmaChanged && newLemmaText) {
        try {
          const result = await fetchDefinition(newLemmaText, data.aviSettings);
          if (result !== '__RATE_LIMITED__') fetchedDef1 = result || null;
        } catch {}

        // Write corrected surface → lemma mapping to global map
        if (originalRow.input) {
          writeGlobalLemma(originalRow.input, normalizeLemma(newLemmaText));
        }
      }

      // When other rows share the now-corrected old lemma, offer to migrate
      // them all — a lemma edit usually means the auto-assignment was wrong
      // everywhere, not that this one row should detach.
      let migrateOthers = false;
      if (lemmaChanged && newLemmaText) {
        const normOldPre = normalizeLemma(originalRow.lemma);
        const others = data.wordInputs.filter(w => w.uid !== uid && normalizeLemma(w.lemma) === normOldPre);
        if (others.length > 0) {
          migrateOthers = window.confirm(
            `${others.length} other row${others.length === 1 ? '' : 's'} use the lemma "${originalRow.lemma}". Update ${others.length === 1 ? 'it' : 'them all'} to "${newLemmaText}" as well? Cancel keeps them on the old lemma.`
          );
        }
      }

      updateData(prev => {
        const originalRow = prev.wordInputs.find(w => w.uid === uid);
        if (!originalRow) return prev;

        // Build the updated row
        const next = { ...originalRow, ...allEdits };
        if (lemmaChanged && fetchedDef1 !== null) next.def1 = fetchedDef1;

        // If editing a key field on an already-uploaded entry, uncheck it
        const def2Changed = allEdits.def2 !== undefined && allEdits.def2 !== originalRow.def2;
        const def1Changed = allEdits.def1 !== undefined && allEdits.def1 !== originalRow.def1;
        const now = new Date().toISOString();

        if ((lemmaChanged || def1Changed || def2Changed) && originalRow.uploaded) {
          next.uploaded          = false;
          next.lastUncheckReason = 'fields edited';
          next.lastUncheckDate   = now;
        }

        let updatedWordInputs = prev.wordInputs.map(w => w.uid === uid ? next : w);
        let updatedLemmaMaster = [...prev.lemmaMaster];
        let updatedSentenceInputs = prev.sentenceInputs;

        // def2 changed → propagate to lemmaMaster and all other rows sharing this lemma
        if (def2Changed) {
          const normLemma = normalizeLemma(next.lemma);
          updatedLemmaMaster = updatedLemmaMaster.map(l =>
            normalizeLemma(l.lemma) === normLemma
              ? { ...l, def2: allEdits.def2, lastUpdated: now, autoAddedBy: 'manual' }
              : l
          );
          updatedWordInputs = updatedWordInputs.map(w => {
            if (w.uid === uid) return w;
            if (normalizeLemma(w.lemma) !== normalizeLemma(next.lemma)) return w;
            return {
              ...w,
              def2: allEdits.def2,
              ...(w.uploaded ? {
                uploaded:          false,
                lastUncheckReason: 'Definition 2 updated for this lemma',
                lastUncheckDate:   now,
              } : {}),
            };
          });
          // Sentence rows sharing this lemma follow too (mirror of the Lemma
          // Master def2 cascade): cardBack = def2, falling back to def1.
          updatedSentenceInputs = updatedSentenceInputs.map(s => {
            if (normalizeLemma(s.targetWord) !== normLemma) return s;
            const cardBack = allEdits.def2 || next.def1 || s.cardBack;
            const changed  = cardBack !== s.cardBack;
            return {
              ...s, cardBack,
              ...(changed && s.uploaded ? {
                uploaded:          false,
                lastUncheckReason: 'Definition 2 updated for this lemma',
                lastUncheckDate:   now,
              } : {}),
            };
          });
        }

        // def1 changed (lemma unchanged) → sync to lemmaMaster + sibling rows
        if (def1Changed && !lemmaChanged) {
          const normLemma = normalizeLemma(next.lemma);
          updatedLemmaMaster = updatedLemmaMaster.map(l =>
            normalizeLemma(l.lemma) === normLemma
              ? { ...l, def1: allEdits.def1, lastUpdated: now, autoAddedBy: 'manual' }
              : l
          );
          updatedWordInputs = updatedWordInputs.map(w =>
            w.uid !== uid && normalizeLemma(w.lemma) === normLemma
              ? { ...w, def1: allEdits.def1 }
              : w
          );
        }

        // Lemma changed — create/rename/attach in lemmaMaster
        if (lemmaChanged && newLemmaText) {
          const normNew = normalizeLemma(newLemmaText);
          const normOld = normalizeLemma(originalRow.lemma);

          // Migrate the other rows first (confirmed above); downstream logic
          // then sees zero remaining users of the old lemma, renames the
          // entry in place, and the orphan check clears any leftover.
          if (migrateOthers) {
            updatedWordInputs = updatedWordInputs.map(w => {
              if (w.uid === uid || normalizeLemma(w.lemma) !== normOld) return w;
              return {
                ...w, lemma: newLemmaText,
                ...(w.uploaded ? { uploaded: false, lastUncheckReason: 'lemma corrected', lastUncheckDate: now } : {}),
              };
            });
          }
          const existingNew = updatedLemmaMaster.find(l => normalizeLemma(l.lemma) === normNew);
          const existingOld = updatedLemmaMaster.find(l => normalizeLemma(l.lemma) === normOld);

          if (existingNew) {
            // New lemma already exists — attach this entry to it
            if (fetchedDef1) {
              updatedLemmaMaster = updatedLemmaMaster.map(l =>
                normalizeLemma(l.lemma) === normNew ? { ...l, def1: fetchedDef1, lastUpdated: now } : l
              );
            }
            // Inherit def2 from existing lemma if this entry has none
            const existingDef2 = existingNew.def2 || '';
            if (existingDef2 && !next.def2) next.def2 = existingDef2;

          } else {
            // Bug #2 fix: check whether other entries still reference the old lemma.
            const otherUsersOfOldLemma = updatedWordInputs.filter(
              w => w.uid !== uid && normalizeLemma(w.lemma) === normOld
            );

            if (otherUsersOfOldLemma.length > 0) {
              // Old lemma is still needed — create a NEW entry for the new lemma
              updatedLemmaMaster = [...updatedLemmaMaster, {
                lemma:          newLemmaText,
                def1:           fetchedDef1 || next.def1 || '',
                def2:           next.def2   || '',
                relatedForm:    '',
                relatedMeaning: '',
                hiddenRelated:  '',
                lastUpdated:    now,
                autoAddedBy:    'manual',
                cleanedLemma:   normNew,
                originUID:      originalRow.uid,
                lemmaID:        uuid(),
              }];
            } else if (existingOld) {
              // Safe to rename — nothing else depends on the old lemma
              updatedLemmaMaster = updatedLemmaMaster.map(l =>
                normalizeLemma(l.lemma) === normOld
                  ? { ...l, lemma: newLemmaText, cleanedLemma: normNew, def1: fetchedDef1 || l.def1, lastUpdated: now, autoAddedBy: 'manual' }
                  : l
              );
            } else {
              // Old lemma didn't exist — create new entry
              updatedLemmaMaster = [...updatedLemmaMaster, {
                lemma:          newLemmaText,
                def1:           fetchedDef1 || next.def1 || '',
                def2:           next.def2   || '',
                relatedForm:    '',
                relatedMeaning: '',
                hiddenRelated:  '',
                lastUpdated:    now,
                autoAddedBy:    'manual',
                cleanedLemma:   normNew,
                originUID:      originalRow.uid,
                lemmaID:        uuid(),
              }];
            }
          }

          // Orphan check: if nothing references the old lemma anymore, remove it
          const oldNorm = normalizeLemma(originalRow.lemma);
          const oldStillUsed = updatedWordInputs.some(w => normalizeLemma(w.lemma) === oldNorm);
          if (!oldStillUsed) {
            updatedLemmaMaster = updatedLemmaMaster.filter(
              l => normalizeLemma(l.lemma) !== oldNorm
            );
          }
        }

        // Cascade targetWord + cardFront on sentence rows when the lemma is renamed.
        if (lemmaChanged && newLemmaText) {
          const normOldSent = normalizeLemma(originalRow.lemma);
          updatedSentenceInputs = updatedSentenceInputs.map(s => {
            if (normalizeLemma(s.targetWord) !== normOldSent) return s;
            return {
              ...s,
              targetWord: newLemmaText,
              cardFront:  newLemmaText + '\n' + (s.sentence || ''),
            };
          });
        }

        return { ...prev, wordInputs: updatedWordInputs, lemmaMaster: updatedLemmaMaster, sentenceInputs: updatedSentenceInputs };
      });

      // Async: update flashcard backs whenever def2 changed — sibling rows
      // sharing this lemma may hold uploaded cards even when this row doesn't,
      // and the helper no-ops when nothing matches.
      if (allEdits.def2 !== undefined && allEdits.def2 !== originalRow.def2) {
        const lemmaEntry = data.lemmaMaster.find(
          l => normalizeLemma(l.lemma) === normalizeLemma(originalRow.lemma)
        );
        updateLinkedCards({
          lemmaID:   lemmaEntry?.lemmaID || null,
          lemmaText: originalRow.lemma,
          updates:   { back: allEdits.def2 },
          cards,
          uid:       auth.currentUser?.uid,
          updateCards,
        }).catch(e => console.error('Word Input: card back update failed', e));
      }

      // Async: cascade a lemma rename to linked flashcards when the old lemma
      // is fully vacated (sole user, or migrate-all confirmed). A partial
      // detach keeps the old cards serving the remaining rows. Sentence-card
      // fronts keep their sentence text; links repair to the surviving entry.
      if (lemmaChanged && newLemmaText) {
        const normOldCards = normalizeLemma(originalRow.lemma);
        const othersRemain = !migrateOthers && data.wordInputs.some(
          w => w.uid !== uid && normalizeLemma(w.lemma) === normOldCards
        );
        if (!othersRemain) {
          const oldEntry    = data.lemmaMaster.find(l => normalizeLemma(l.lemma) === normOldCards);
          const targetEntry = data.lemmaMaster.find(
            l => normalizeLemma(l.lemma) === normalizeLemma(newLemmaText)
          ) || oldEntry;
          updateLinkedCards({
            lemmaID:   oldEntry?.lemmaID || null,
            lemmaText: originalRow.lemma,
            buildUpdates: (c) => ({
              lemma: newLemmaText,
              front: c.type === 'sentence'
                ? newLemmaText + '\n' + (c.sentence || '')
                : newLemmaText,
              ...(targetEntry && targetEntry.lemmaID !== oldEntry?.lemmaID
                ? { linkedAVILemmaId: targetEntry.lemmaID }
                : {}),
            }),
            cards,
            uid:       auth.currentUser?.uid,
            updateCards,
          }).catch(e => console.error('Word Input: card lemma update failed', e));
        }
      }

      // Async: auto-create card if def2 newly added on an unuploaded entry —
      // unless the target deck already holds a card for this lemma (the same
      // guard as ensureNuanceFlashcard: a second-section row of an already-
      // carded word gets the row for section counts, not a duplicate card).
      if (
        allEdits.def2 &&
        !originalRow.def2 &&
        !originalRow.uploaded &&
        !originalRow.skipUpload
      ) {
        const finalLemma = allEdits.lemma !== undefined ? allEdits.lemma : originalRow.lemma;
        const targetDeck = decks.find(d => d.name === originalRow.source);
        const dupInDeck  = !!targetDeck && (cards || []).some(c =>
          c.type !== 'grammar' && c.lemma &&
          normalizeLemma(c.lemma) === normalizeLemma(finalLemma) &&
          (c.deckIds || []).includes(targetDeck.id)
        );
        if (dupInDeck) {
          updateData(prev => ({
            ...prev,
            wordInputs: prev.wordInputs.map(w =>
              w.uid === uid ? { ...w, uploaded: true } : w
            ),
          }));
          return;
        }
        const updatedEntry = { ...originalRow, ...allEdits };
        autoCreateWordCard({
          entry:       updatedEntry,
          lemmaMaster: data.lemmaMaster,
          decks,
          uid:         auth.currentUser?.uid,
          updateCards,
          updateDecks,
          aviSources,
          dsh,
        }).then(() => {
          updateData(prev => ({
            ...prev,
            wordInputs: prev.wordInputs.map(w =>
              w.uid === uid ? { ...w, uploaded: true } : w
            ),
          }));
        }).catch(e => console.error('Word Input: card creation on edit failed', e));
      }
  };
}