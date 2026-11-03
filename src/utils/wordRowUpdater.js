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
  isRealDefinition, resolveCorrectedDef1,
} from './aviUtils.js';
import { planCardDedupe, applyCardDedupe, dedupeLemmaRows, planDeckLeave, planIsEmpty } from './cardDedupe.js';
import { applyDef2Write, def2CardUpdate, applyDef1BackFollow, def1CardUpdate } from './def2Cascade.js';

// ── Lemma correction: which definitions win (bug sweep A2/A3) ─────────
// A corrected row takes the corrected lemma's definitions, not the wrong
// lemma's, and a lookup never overwrites real data:
//   def1 — typed in this save > the existing entry's real def1 > lookup
//          (resolveCorrectedDef1: a miss keeps the old def1 only when just
//          a parenthetical changed). An existing entry's real def1 is never
//          replaced by a lookup; a blank or missed one is filled.
//   def2 — typed or picked in this save (WordEditModal asks when the row's
//          def2 and the corrected lemma's differ) > the existing entry's
//          def2 > the row's own. A correction never blanks an existing
//          entry's def2.
// The row mirrors the entry it lands on. Pure; used inside the state
// updater and again for the card updates that follow it.
export function planLemmaCorrection({ row, edits, newLemma, target, fetchedDef1 }) {
  const oldDef1 = row.def1 || '';
  const oldDef2 = row.def2 || '';
  const typedDef1 = edits.def1 !== undefined;
  const typedDef2 = edits.def2 !== undefined;

  const def1 = typedDef1 ? edits.def1
    : isRealDefinition(target?.def1) ? target.def1
    : resolveCorrectedDef1(fetchedDef1, oldDef1, row.lemma, newLemma);
  const def2 = typedDef2 ? edits.def2 : (target?.def2 || oldDef2);

  if (!target) return { oldDef1, oldDef2, def1, def2, entryDef1: def1, entryDef2: def2 };

  const tDef1 = target.def1 || '';
  let entryDef1 = tDef1;
  if (typedDef1) entryDef1 = edits.def1;
  else if (isRealDefinition(def1) && !isRealDefinition(tDef1)) entryDef1 = def1;
  else if (!tDef1 && def1) entryDef1 = def1;
  const entryDef2 = def2 || target.def2 || '';
  return { oldDef1, oldDef2, def1: entryDef1, def2: entryDef2, entryDef1, entryDef2 };
}

// ── Lemma correction: what moves with the corrected rows (bug sweep A13) ──
// movedRows are the word rows being corrected (the edited row, plus the
// others when "Update them all" was confirmed); remainingRows are the word
// rows left on the old lemma. When none remain, everything on the old lemma
// moves (vacated). Otherwise only what belongs to the moved rows does:
//   - a whole source the old lemma no longer has word rows in (its deck's
//     vocab card and every sentence row and card in it);
//   - a sentence row in the same source and section whose word form is a
//     moved row's input, unless a remaining row matches it equally.
// Sentence rows in sources the correction never touched stay put.
export function makeCorrectionScope({ movedRows, remainingRows }) {
  const vacated = remainingRows.length === 0;
  const nfc = (s) => String(s || '').normalize('NFC').trim();
  const movedSources     = new Set(movedRows.map(w => w.source));
  const remainingSources = new Set(remainingRows.map(w => w.source));
  const wholeSource = (src) => movedSources.has(src) && !remainingSources.has(src);
  const matches = (s, w) =>
    w.source === s.source &&
    String(w.section ?? '') === String(s.section ?? '') &&
    !!nfc(w.input) &&
    (s.inputForm ? nfc(s.inputForm) === nfc(w.input) : nfc(s.sentence).includes(nfc(w.input)));
  const sentenceFollows = (s) => vacated || wholeSource(s.source) ||
    (movedRows.some(w => matches(s, w)) && !remainingRows.some(w => matches(s, w)));
  return { vacated, wholeSource, sentenceFollows };
}

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

      // A2: look up def1 for the corrected lemma only when nothing better is
      // at hand. A def1 typed in this save, or the existing entry's real
      // def1, wins and is never replaced by a lookup.
      const targetPre = lemmaChanged && newLemmaText
        ? data.lemmaMaster.find(l => normalizeLemma(l.lemma) === normalizeLemma(newLemmaText)) || null
        : null;
      let fetchedDef1 = '';
      if (lemmaChanged && newLemmaText) {
        if (allEdits.def1 === undefined && !isRealDefinition(targetPre?.def1)) {
          try { fetchedDef1 = (await fetchDefinition(newLemmaText, data.aviSettings)) || ''; } catch {}
        }

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

      // A3: the corrected lemma's definitions, from the same snapshot the
      // card updates below use.
      const correctionPre = lemmaChanged && newLemmaText
        ? planLemmaCorrection({ row: originalRow, edits: allEdits, newLemma: newLemmaText, target: targetPre, fetchedDef1 })
        : null;
      // A13: what moves with the corrected rows, from the same snapshot.
      const normOldPre = normalizeLemma(originalRow.lemma);
      const scopePre = correctionPre ? makeCorrectionScope({
        movedRows:     data.wordInputs.filter(w => w.uid === uid || (migrateOthers && normalizeLemma(w.lemma) === normOldPre)),
        remainingRows: data.wordInputs.filter(w => w.uid !== uid && !migrateOthers && normalizeLemma(w.lemma) === normOldPre),
      }) : null;
      // A new Lemma Master entry's id is fixed here so the cards that move
      // to it (or are created for it) can link to it.
      const newEntryId = uuid();

      updateData(prev => {
        const originalRow = prev.wordInputs.find(w => w.uid === uid);
        if (!originalRow) return prev;

        // A2/A3: on a lemma correction, plan against the live state.
        const correction = lemmaChanged && newLemmaText
          ? planLemmaCorrection({
              row: originalRow, edits: allEdits, newLemma: newLemmaText, fetchedDef1,
              target: prev.lemmaMaster.find(l => normalizeLemma(l.lemma) === normalizeLemma(newLemmaText)) || null,
            })
          : null;

        // Build the updated row
        const next = { ...originalRow, ...allEdits };
        if (correction) { next.def1 = correction.def1; next.def2 = correction.def2; }

        // If editing a key field on an already-uploaded entry, uncheck it.
        // A11: def1 isn't on the card, so a def1-only edit leaves the row
        // uploaded (it used to reset it and fill Recent with noise).
        const def2Changed = allEdits.def2 !== undefined && allEdits.def2 !== originalRow.def2;
        const def1Changed = allEdits.def1 !== undefined && allEdits.def1 !== originalRow.def1;
        const now = new Date().toISOString();

        if ((lemmaChanged || def2Changed) && originalRow.uploaded) {
          next.uploaded          = false;
          next.lastUncheckReason = 'fields edited';
          next.lastUncheckDate   = now;
        }

        let updatedWordInputs = prev.wordInputs.map(w => w.uid === uid ? next : w);
        let updatedLemmaMaster = [...prev.lemmaMaster];
        let updatedSentenceInputs = prev.sentenceInputs;

        // def2 changed → the one def2 writer (LD-D1): Lemma Master, the other
        // word and 동의어 rows, and every sentence back with a value (an empty
        // back waits for AVIPage's cascade, L6). Clearing keeps sentence
        // backs (LD-D2). A lemma correction handles its own definitions below.
        if (def2Changed && !correction) {
          const written = applyDef2Write(
            { lemmaMaster: updatedLemmaMaster, wordInputs: updatedWordInputs, sentenceInputs: updatedSentenceInputs },
            { lemma: next.lemma, def2: allEdits.def2, now, reason: 'Definition 2 updated for this lemma' },
          );
          updatedLemmaMaster    = written.lemmaMaster;
          updatedWordInputs     = written.wordInputs;
          updatedSentenceInputs = written.sentenceInputs;
        }

        // def1 changed (lemma unchanged) → sync to lemmaMaster + sibling rows
        if (def1Changed && !lemmaChanged) {
          const normLemma = normalizeLemma(next.lemma);
          const entryPre  = updatedLemmaMaster.find(l => normalizeLemma(l.lemma) === normLemma) || null;
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
          // LD-D3: sentence backs that are the def1 follow it while the word
          // has no def2 (same rule as a def1 edit in Lemma Master).
          updatedSentenceInputs = applyDef1BackFollow(updatedSentenceInputs, {
            lemma: next.lemma, oldDef1: entryPre?.def1 || originalRow.def1 || '',
            def1: allEdits.def1, hasDef2: !!(entryPre?.def2 || next.def2),
          });
        }

        // Lemma changed — create/rename/attach in lemmaMaster
        if (lemmaChanged && newLemmaText) {
          const normNew = normalizeLemma(newLemmaText);
          const normOld = normalizeLemma(originalRow.lemma);

          // Migrate the other rows first (confirmed above); downstream logic
          // then sees zero remaining users of the old lemma, renames the
          // entry in place, and the orphan check clears any leftover.
          // A3: migrated rows take the corrected lemma's definitions too.
          if (migrateOthers) {
            updatedWordInputs = updatedWordInputs.map(w => {
              if (w.uid === uid || normalizeLemma(w.lemma) !== normOld) return w;
              return {
                ...w, lemma: newLemmaText, def1: correction.def1, def2: correction.def2,
                ...(w.uploaded ? { uploaded: false, lastUncheckReason: 'lemma corrected', lastUncheckDate: now } : {}),
              };
            });
          }
          const existingNew = updatedLemmaMaster.find(l => normalizeLemma(l.lemma) === normNew);
          const existingOld = updatedLemmaMaster.find(l => normalizeLemma(l.lemma) === normOld);

          if (existingNew) {
            // New lemma already exists — attach this row to it. A2: its real
            // def1 is never overwritten by the lookup; it changes only for a
            // typed def1, or to fill a blank or missed one. A def2 picked in
            // this save becomes the entry's and reaches its other rows.
            const { entryDef1, entryDef2 } = correction;
            const def1Moved = entryDef1 !== (existingNew.def1 || '');
            const def2Moved = entryDef2 !== (existingNew.def2 || '');
            if (def1Moved || def2Moved) {
              updatedLemmaMaster = updatedLemmaMaster.map(l =>
                normalizeLemma(l.lemma) === normNew
                  ? { ...l, def1: entryDef1, def2: entryDef2, lastUpdated: now, autoAddedBy: 'manual' }
                  : l
              );
              updatedWordInputs = updatedWordInputs.map(w => {
                if (w.uid === uid || normalizeLemma(w.lemma) !== normNew) return w;
                return {
                  ...w,
                  ...(def1Moved ? { def1: entryDef1 } : {}),
                  ...(def2Moved ? {
                    def2: entryDef2,
                    ...(w.uploaded ? { uploaded: false, lastUncheckReason: 'Definition 2 updated for this lemma', lastUncheckDate: now } : {}),
                  } : {}),
                };
              });
              if (def2Moved) {
                updatedSentenceInputs = updatedSentenceInputs.map(s => {
                  // L6: an empty back is waiting for AVIPage's cascade.
                  if (normalizeLemma(s.targetWord) !== normNew || !s.cardBack) return s;
                  const cardBack = entryDef2 || s.cardBack;
                  return {
                    ...s, cardBack,
                    ...(cardBack !== s.cardBack && s.uploaded ? { uploaded: false, lastUncheckReason: 'Definition 2 updated for this lemma', lastUncheckDate: now } : {}),
                  };
                });
              }
            }

          } else {
            // Bug #2 fix: check whether other entries still reference the old lemma.
            const otherUsersOfOldLemma = updatedWordInputs.filter(
              w => w.uid !== uid && normalizeLemma(w.lemma) === normOld
            );

            if (otherUsersOfOldLemma.length > 0) {
              // Old lemma is still needed — create a NEW entry for the new lemma
              updatedLemmaMaster = [...updatedLemmaMaster, {
                lemma:          newLemmaText,
                def1:           correction.entryDef1,
                def2:           correction.entryDef2,
                relatedForm:    '',
                relatedMeaning: '',
                hiddenRelated:  '',
                lastUpdated:    now,
                autoAddedBy:    'manual',
                cleanedLemma:   normNew,
                originUID:      originalRow.uid,
                lemmaID:        newEntryId,
              }];
            } else if (existingOld) {
              // Safe to rename — nothing else depends on the old lemma
              updatedLemmaMaster = updatedLemmaMaster.map(l =>
                normalizeLemma(l.lemma) === normOld
                  ? { ...l, lemma: newLemmaText, cleanedLemma: normNew, def1: correction.entryDef1, def2: correction.entryDef2, lastUpdated: now, autoAddedBy: 'manual' }
                  : l
              );
            } else {
              // Old lemma didn't exist — create new entry
              updatedLemmaMaster = [...updatedLemmaMaster, {
                lemma:          newLemmaText,
                def1:           correction.entryDef1,
                def2:           correction.entryDef2,
                relatedForm:    '',
                relatedMeaning: '',
                hiddenRelated:  '',
                lastUpdated:    now,
                autoAddedBy:    'manual',
                cleanedLemma:   normNew,
                originUID:      originalRow.uid,
                lemmaID:        newEntryId,
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
        // A3: a back that came from the old lemma's definitions follows the
        // corrected ones. An empty back stays empty for AVIPage's cascade
        // (L6); a hand-edited back is kept.
        // A13: when other word rows stay on the old lemma, only the sentence
        // rows that belong to the corrected rows move (makeCorrectionScope).
        if (lemmaChanged && newLemmaText) {
          const normOldSent = normalizeLemma(originalRow.lemma);
          const { def1: newDef1, def2: newDef2 } = correction;
          const newBack = newDef2 || (isRealDefinition(newDef1) ? newDef1 : '');
          const scope = makeCorrectionScope({
            movedRows:     prev.wordInputs.filter(w => w.uid === uid || (migrateOthers && normalizeLemma(w.lemma) === normOldSent)),
            remainingRows: updatedWordInputs.filter(w => normalizeLemma(w.lemma) === normOldSent),
          });
          updatedSentenceInputs = updatedSentenceInputs.map(s => {
            if (normalizeLemma(s.targetWord) !== normOldSent || !scope.sentenceFollows(s)) return s;
            // LD-D1: a sentence back is the word's back — any back follows the
            // corrected lemma's (its def2, or its def1 while it has none).
            // An empty back stays empty for AVIPage's cascade (L6).
            const cardBack = s.cardBack && newBack ? newBack : s.cardBack;
            return {
              ...s,
              targetWord: newLemmaText,
              cardFront:  newLemmaText + '\n' + (s.sentence || ''),
              cardBack,
              ...(cardBack !== s.cardBack && s.uploaded ? { uploaded: false, lastUncheckReason: 'lemma corrected', lastUncheckDate: now } : {}),
            };
          });
        }

        // A14: rows that now collide with the corrected lemma's own rows
        // (same source and section, or same source and sentence) collapse
        // to the older row — the identity Import uses (cardDedupe).
        if (correction) {
          const prevWordUids = new Set(prev.wordInputs.filter(w => normalizeLemma(w.lemma) === normalizeLemma(newLemmaText)).map(w => w.uid));
          const prevSentUids = new Set(prev.sentenceInputs.filter(x => normalizeLemma(x.targetWord) === normalizeLemma(newLemmaText)).map(x => x.uid));
          const deduped = dedupeLemmaRows(
            { wordInputs: updatedWordInputs, sentenceInputs: updatedSentenceInputs }, [newLemmaText],
            r => prevWordUids.has(r.uid) || prevSentUids.has(r.uid), // rows already on it win ties
          );
          updatedWordInputs     = deduped.wordInputs;
          updatedSentenceInputs = deduped.sentenceInputs;
        }

        return { ...prev, wordInputs: updatedWordInputs, lemmaMaster: updatedLemmaMaster, sentenceInputs: updatedSentenceInputs };
      });

      // Async: update flashcard backs whenever def2 changed — sibling rows
      // sharing this lemma may hold uploaded cards even when this row doesn't,
      // and the helper no-ops when nothing matches. (A lemma correction
      // updates its cards below.)
      // LD-D2: a cleared def2 leaves the cards' backs as they are.
      if (!correctionPre && allEdits.def2 && allEdits.def2 !== originalRow.def2) {
        const lemmaEntry = data.lemmaMaster.find(
          l => normalizeLemma(l.lemma) === normalizeLemma(originalRow.lemma)
        );
        updateLinkedCards({
          lemmaID:   lemmaEntry?.lemmaID || null,
          lemmaText: originalRow.lemma,
          buildUpdates: (c) => def2CardUpdate(c, allEdits.def2),
          cards,
          uid:       auth.currentUser?.uid,
          updateCards,
        }).catch(e => console.error('Word Input: card back update failed', e));
      }

      // LD-D3: a def1 edit reaches cards whose back is the def1, while the
      // word has no def2.
      if (!correctionPre && allEdits.def1 !== undefined && allEdits.def1 !== originalRow.def1) {
        const lemmaEntry = data.lemmaMaster.find(
          l => normalizeLemma(l.lemma) === normalizeLemma(originalRow.lemma)
        );
        const oldDef1 = lemmaEntry?.def1 || originalRow.def1 || '';
        const hasDef2 = !!(lemmaEntry?.def2 || allEdits.def2 || originalRow.def2);
        if (oldDef1 && !hasDef2) {
          updateLinkedCards({
            lemmaID:   lemmaEntry?.lemmaID || null,
            lemmaText: originalRow.lemma,
            buildUpdates: (c) => def1CardUpdate(c, { oldDef1, def1: allEdits.def1, hasDef2: false }),
            cards,
            uid:       auth.currentUser?.uid,
            updateCards,
          }).catch(e => console.error('Word Input: card def1 back update failed', e));
        }
      }

      // Async: cascade a lemma rename to linked flashcards. When the old
      // lemma is fully vacated (sole user, or migrate-all confirmed) every
      // card moves. A13: otherwise only the cards that belong to the moved
      // rows do — the vocab card of a deck the old lemma has left, and the
      // sentence cards of sentence rows that moved — and the rest keep
      // serving the remaining rows. Sentence-card fronts keep their sentence
      // text; links repair to the corrected lemma's entry.
      const normOldCards = normalizeLemma(originalRow.lemma);
      const oldEntryPre  = correctionPre
        ? data.lemmaMaster.find(l => normalizeLemma(l.lemma) === normOldCards) || null
        : null;
      // The entry the corrected rows land on: the existing corrected lemma,
      // the old entry renamed in place (vacated), or the new entry.
      const targetIdPre = correctionPre
        ? targetPre?.lemmaID || (scopePre.vacated && oldEntryPre ? oldEntryPre.lemmaID : newEntryId)
        : null;
      let cardMoves = () => false;
      if (correctionPre) {
        const deckNames = (c) => (decks || []).filter(d => (c.deckIds || []).includes(d.id)).map(d => d.name);
        // Sentence cards live in "<source> (sentence mining)" decks (cardFactory),
        // so a sentence row is matched to its card by that deck and the sentence.
        const sentDeck  = (src) => src ? `${src} (sentence mining)` : 'Sentence Mining';
        const sentKey   = (deckName, sentence) => `${deckName}\u0000${(sentence || '').normalize('NFC')}`;
        const movedSent = new Set(), keptSent = new Set();
        for (const s of data.sentenceInputs || []) {
          if (normalizeLemma(s.targetWord) !== normOldCards) continue;
          (scopePre.sentenceFollows(s) ? movedSent : keptSent).add(sentKey(sentDeck(s.source), s.sentence));
        }
        cardMoves = (c) => {
          if (c.type === 'grammar') return false;
          const onOld = (oldEntryPre && c.linkedAVILemmaId === oldEntryPre.lemmaID) ||
            (!!c.lemma && normalizeLemma(c.lemma) === normOldCards);
          if (!onOld) return false;
          if (scopePre.vacated) return true;
          const names = deckNames(c);
          if (!names.length) return false;
          return c.type === 'sentence'
            ? names.some(n => movedSent.has(sentKey(n, c.sentence)) && !keptSent.has(sentKey(n, c.sentence)))
            : names.every(n => scopePre.wholeSource(n));
        };
      }
      if (lemmaChanged && newLemmaText) {
        const oldEntry = oldEntryPre;
        const targetId = targetIdPre;
        // A3 / LD-D1: a moved card's back follows the corrected lemma's
        // definitions (its def2, or a sentence card's def1 while it has none);
        // never blanked.
        const { def1: newDef1, def2: newDef2 } = correctionPre;
        if ((cards || []).some(cardMoves)) {
          // A14: a moved card that lands in a deck already holding a card for
          // the corrected lemma collapses with it once the rename is in:
          // one card per word per deck, the older review history kept, and a
          // vocab survivor's back set to the corrected lemma's def2.
          const projected = (cards || []).map(c => cardMoves(c)
            ? { ...c, lemma: newLemmaText, ...(targetId ? { linkedAVILemmaId: targetId } : {}) } : c);
          const movedDecks = [...new Set((cards || []).filter(cardMoves).flatMap(c => c.deckIds || []))];
          const dedupePlan = planCardDedupe(projected, { lemmas: [newLemmaText], deckIds: movedDecks });
          const entryDef2  = correctionPre.entryDef2;
          updateLinkedCards({
            lemmaID:   oldEntry?.lemmaID || null,
            lemmaText: originalRow.lemma,
            buildUpdates: (c) => {
              if (!cardMoves(c)) return null;
              const back = c.type === 'sentence'
                ? newDef2 || (isRealDefinition(newDef1) ? newDef1 : '')
                : newDef2;
              const follow = !!back && c.back !== back;
              return {
                lemma: newLemmaText,
                front: c.type === 'sentence'
                  ? newLemmaText + '\n' + (c.sentence || '')
                  : newLemmaText,
                ...(follow ? { back } : {}),
                ...(targetId && targetId !== oldEntry?.lemmaID
                  ? { linkedAVILemmaId: targetId }
                  : {}),
              };
            },
            cards,
            uid:       auth.currentUser?.uid,
            updateCards,
          })
            .then(() => applyCardDedupe({
              uid: auth.currentUser?.uid, plan: dedupePlan, updateCards, updateDecks,
              survivorUpdates: (c) => (entryDef2 && c.type !== 'sentence' && c.back !== entryDef2)
                ? { back: entryDef2 } : null,
            }))
            .catch(e => console.error('Word Input: card lemma update failed', e));
        }

        // SD-D8: a word card shared by several books of a series stays on the
        // old lemma while other books still use it, but leaves the decks of
        // the books the old lemma has left (the corrected row gets the
        // corrected lemma's card below).
        if (scopePre && !scopePre.vacated) {
          const leftDeckIds = (decks || [])
            .filter(d => d.name && !d.name.endsWith(' (sentence mining)') && scopePre.wholeSource(d.name))
            .map(d => d.id);
          const stayingShared = (cards || []).filter(c => c.type !== 'grammar' && c.type !== 'sentence' && !cardMoves(c));
          const leavePlan = leftDeckIds.length ? planDeckLeave(stayingShared, leftDeckIds, [originalRow.lemma]) : null;
          if (leavePlan && !planIsEmpty(leavePlan)) {
            applyCardDedupe({ uid: auth.currentUser?.uid, plan: leavePlan, updateCards, updateDecks })
              .catch(e => console.error('Word Input: shared card deck leave failed', e));
          }
        }
      }

      // Async (A3): when the correction gave an existing entry a new def2
      // (picked in WordEditModal), that entry's own cards follow, as they do
      // for a def2 edit.
      if (correctionPre && targetPre && correctionPre.entryDef2 &&
          correctionPre.entryDef2 !== (targetPre.def2 || '')) {
        updateLinkedCards({
          lemmaID:   targetPre.lemmaID || null,
          lemmaText: targetPre.lemma,
          updates:   { back: correctionPre.entryDef2 },
          cards,
          uid:       auth.currentUser?.uid,
          updateCards,
        }).catch(e => console.error('Word Input: corrected lemma card back update failed', e));
      }

      // Async: auto-create card if def2 newly added on an unuploaded entry —
      // unless the target deck already holds a card for this lemma (the same
      // guard as ensureNuanceFlashcard: a second-section row of an already-
      // carded word gets the row for section counts, not a duplicate card).
      // A3: a correction that brings the row a def2 counts as adding one.
      // A13: a corrected row with a def2 also gets a card when none ends up
      // in its deck for the corrected lemma — e.g. its old card stayed behind
      // for the rows still on the old lemma. Cards moving into the deck
      // count (cardMoves), so a moved card is never duplicated.
      const addedDef2 = correctionPre ? correctionPre.def2 : allEdits.def2;
      if (
        addedDef2 &&
        !originalRow.skipUpload &&
        (correctionPre || (!originalRow.def2 && !originalRow.uploaded))
      ) {
        const finalLemma = allEdits.lemma !== undefined ? allEdits.lemma : originalRow.lemma;
        const targetDeck = decks.find(d => d.name === originalRow.source);
        const dupInDeck  = !!targetDeck && (cards || []).some(c =>
          c.type !== 'grammar' && (c.deckIds || []).includes(targetDeck.id) &&
          ((c.lemma && normalizeLemma(c.lemma) === normalizeLemma(finalLemma)) || cardMoves(c))
        );
        if (dupInDeck) {
          // A row reset for review by the correction stays reset (Recent).
          if (!originalRow.uploaded) {
            updateData(prev => ({
              ...prev,
              wordInputs: prev.wordInputs.map(w =>
                w.uid === uid ? { ...w, uploaded: true } : w
              ),
            }));
          }
          return;
        }
        const updatedEntry = {
          ...originalRow, ...allEdits,
          ...(correctionPre ? { def1: correctionPre.def1, def2: correctionPre.def2 } : {}),
        };
        // The corrected lemma's entry may be new or renamed in place and not
        // in data yet under its new name; include it so the card links to it.
        const lemmaMasterForCard = correctionPre && !targetPre
          ? [{ lemma: newLemmaText, lemmaID: targetIdPre }, ...data.lemmaMaster]
          : data.lemmaMaster;
        autoCreateWordCard({
          entry:       updatedEntry,
          lemmaMaster: lemmaMasterForCard,
          cards,
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