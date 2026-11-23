// src/utils/sentenceStaging.js
// Sentence Input's add pipeline (reading companion decision RC-D10). Moved
// out of AVISentenceInputPage so Sentence Input and the reading companion add sentences through one pipeline, the way
// stageWordInput (wordStaging.js) serves Word Input and Search.
//
// The steps, unchanged from Sentence Input:
//   1. tokenizeSentence — the sentence becomes word pills; words already in
//      Word Input (by surface or lemma) are pre-selected, unless the word is
//      skipped in any source (LM2).
//   2. collectSelectedTerms — the picked pills and phrase become terms.
//   3. stageSelectedTerms — known words get their sentence rows now (and a
//      Word Input row for this source when it has none); new words get their
//      lemma resolved (with other readings) and come back for confirmation.
//   4. fetchTermDefinitions — confirmation step 1: an existing entry's defs,
//      else a dictionary def1 (Tier 2 only for an untouched machine guess).
//   5. commitConfirmedTerms — confirmation done: global lemma corrections,
//      new Lemma Master entries and Word Input rows, the def2 moves (A5),
//      sentence rows, and their cards.
//
// `ctx` is what every step needs from the page:
//   { data, updateData, showAVIToast, cards, decks, uid, updateCards,
//     updateDecks, aviSources, dsh }
// `data` is the page's render-time copy, as the page's callbacks used it.
//
// Leaf module: imports only utilities.

import {
  uuid, normalizeLemma, extractLemmaFromText,
  fetchDefinitionWithFallback, resolveLemmaDetailed,
  writeGlobalLemma, updateLinkedCards,
  filterNewSentenceRows, filterNewWordRows, filterNewLemmas,
} from './aviUtils.js';
import { autoCreateWordCard, autoCreateSentenceCard } from './cardFactory.js';
import { isSkippedInSource, inheritedSentenceSkip } from './wordSkip.js';
import { findLemmaEntryAny, canonicalLemma } from './lemmaSuggest.js';
import { planDef2Moves, applyDef2Moves, def2CardUpdate } from './def2Cascade.js';
import { DEMO, DEMO_CAPS, DEMO_LIMIT_NOTE, demoCapReached } from '../demo/demoConfig.js';

// The Lemma Master entry a picked term lands on (exact, cleaned or variant
// match) — the lookup commitConfirmedTerms uses to decide "existing".
export function findPickEntry(lemmaMaster, lemma) {
  const norm = normalizeLemma(lemma);
  return (lemmaMaster || []).find(l => l.cleanedLemma === norm || l.lemma === lemma)
    || findLemmaEntryAny(lemmaMaster || [], lemma) || null;
}

// ── 1. Tokenize and auto-select ───────────────────────────────
// Returns { tokens: [{ token }], autoSelected: Set(index), skipped: Set(index) }.
// LM2: a skip anywhere wins. A token whose word has
// a skipped Word Input row in any source starts unselected, even if another
// source still studies it, and is listed in `skipped` so the pill can show
// why. Tapping it still picks it. "Its word" is every lemma of the rows the
// token matches, so 써요 is caught by a skipped 쓰다 row elsewhere.
export function tokenizeSentence(text, wordInputs) {
  const tokens = String(text || '').trim().split(/\s+/).filter(Boolean);
  const rows = wordInputs || [];
  const skippedLemmas = new Set(rows.filter(w => w && w.skipUpload).map(w => normalizeLemma(w.lemma || '')).filter(Boolean));
  const autoSelected = new Set();
  const skipped = new Set();
  tokens.forEach((token, idx) => {
    const normTok = normalizeLemma(token);
    const matches = rows.filter(w => w && (w.input === token || normalizeLemma(w.lemma) === normTok));
    if (!matches.length) return;
    if (matches.some(w => w.skipUpload || skippedLemmas.has(normalizeLemma(w.lemma || '')))) skipped.add(idx);
    else autoSelected.add(idx);
  });
  // Demo: at most DEMO_CAPS.wordsPerSentence pre-selected words (D5).
  if (DEMO && autoSelected.size > DEMO_CAPS.wordsPerSentence) {
    return { tokens: tokens.map(t => ({ token: t })), autoSelected: new Set([...autoSelected].slice(0, DEMO_CAPS.wordsPerSentence)), skipped };
  }
  return { tokens: tokens.map(t => ({ token: t })), autoSelected, skipped };
}

// Duplicate-sentence guard: exact (sentence, target, source) dupes are
// skipped; a re-add under a corrected target is allowed and flagged for
// review in Recent with the original target noted.
export function classifySentenceDup(sentenceInputs, sentence, targetWord, source) {
  const normT = normalizeLemma(targetWord);
  const sameSent = (sentenceInputs || []).filter(s => s.sentence === sentence && s.source === source);
  if (sameSent.some(s => normalizeLemma(s.targetWord) === normT)) return { skip: true };
  if (sameSent.length > 0) {
    return { skip: false, note: `same sentence previously added with target "${sameSent[0].targetWord}"` };
  }
  return { skip: false };
}

// A phrase's lemma: its last word lemmatized, the rest kept as typed.
export function lemmatizePhrase(tokens) {
  if (!tokens.length) return '';
  const lastLemma = extractLemmaFromText(tokens[tokens.length - 1]) || tokens[tokens.length - 1];
  return tokens.length === 1 ? lastLemma : [...tokens.slice(0, -1), lastLemma].join(' ');
}

// ── 2. Picked pills → terms ───────────────────────────────────
// tokens: the token strings; allSelected: Set of picked indices (auto first,
// then manual, as the page builds it); phrase: { text, indices } or null.
export function collectSelectedTerms(tokens, allSelected, phrase) {
  const terms = [];
  allSelected.forEach(idx => terms.push({ input: tokens[idx], isPhrase: false }));
  if (phrase) {
    const phraseTokens = phrase.indices.map(i => tokens[i]);
    terms.push({ input: phrase.text, isPhrase: true, phraseTokens });
    for (const i of phrase.indices) {
      if (!allSelected.has(i)) terms.push({ input: tokens[i], isPhrase: false });
    }
  }
  return terms;
}

// ── Sentence rows ─────────────────────────────────────────────
// items: [{ target, input, back(lemmaEntry) }]. Builds the rows (one per
// lemma per sentence; exact duplicates skipped), shows the skipped-duplicate
// toast, and appends the rows. Returns { rows, skippedDupes }.
export function addSentenceRows(ctx, { items, sentence, source, section }) {
  const { data, updateData, showAVIToast } = ctx;
  const lemmaMap = {};
  for (const l of data.lemmaMaster) {
    lemmaMap[l.lemma] = l;
    if (l.cleanedLemma) lemmaMap[l.cleanedLemma] = l;
  }
  const newRows = [];
  const skippedDupes = [];
  const batchSeen = new Set();
  for (const item of items) {
    const safeTarget = item.target;
    // Intra-batch dedupe: the same token repeated in one sentence (or two
    // surface forms resolving to one lemma) collapses to a single row —
    // classifySentenceDup only sees rows persisted before this call.
    if (batchSeen.has(normalizeLemma(safeTarget))) continue;
    batchSeen.add(normalizeLemma(safeTarget));
    const dup = classifySentenceDup(data.sentenceInputs, sentence, safeTarget, source);
    if (dup.skip) { skippedDupes.push(safeTarget); continue; }
    const lEntry    = lemmaMap[safeTarget] || lemmaMap[normalizeLemma(safeTarget)] || {};
    const cardBack  = item.back(lEntry);
    // inputForm: the surface form appearing in the sentence
    const inputForm = item.input && sentence.includes(item.input) ? item.input : '';
    const sid       = uuid();
    newRows.push({
      uid: sid, ts: new Date().toISOString(),
      sentence, targetWord: safeTarget,
      cardFront: safeTarget + '\n' + sentence,
      cardBack,
      inputForm,
      source, section,
      uploaded: false, ...inheritedSentenceSkip(isSkippedInSource(data.wordInputs, source, safeTarget)),
      lastUncheckReason: dup.note || '',
      lastUncheckDate:   dup.note ? new Date().toISOString() : '',
    });
  }
  if (skippedDupes.length && showAVIToast) {
    showAVIToast(`Skipped duplicate sentence row${skippedDupes.length > 1 ? 's' : ''}: ${skippedDupes.join(', ')}`);
  }
  if (newRows.length) {
    updateData(prev => ({
      ...prev,
      sentenceInputs: [...filterNewSentenceRows(prev.sentenceInputs, newRows), ...prev.sentenceInputs],
    }));
  }
  return { rows: newRows, skippedDupes };
}

// Cards for new sentence rows that already have a back (L6: a row with no
// back waits for its word's def2; AVIPage's cascade creates that card).
export function createSentenceRowCards(ctx, rows, lemmaMaster) {
  const { cards, decks, uid, updateCards, updateDecks, aviSources, dsh, updateData, showAVIToast } = ctx;
  // Demo: say so when the card cap stops these cards (cardFactory skips them).
  if (DEMO && showAVIToast && demoCapReached(cards, 'cards') && rows.some(r => r.cardBack && !r.skipUpload)) {
    showAVIToast(DEMO_LIMIT_NOTE);
  }
  for (const row of rows) {
    if (row.cardBack && !row.skipUpload) {
      autoCreateSentenceCard({
        entry: row, lemmaMaster,
        cards, decks, uid, updateCards, updateDecks, aviSources, dsh, // A6: cards feed the duplicate guard
      }).then(() => {
        updateData(prev => ({
          ...prev,
          sentenceInputs: prev.sentenceInputs.map(s =>
            s.uid === row.uid ? { ...s, uploaded: true } : s
          ),
        }));
      }).catch(e => console.error('Sentence card creation failed', e));
    }
  }
}

// ── 3. Add the picked terms ───────────────────────────────────
// Known words (already in Word Input by surface or lemma) get a Word Input
// row for this source when it has none (and its card when it has a def2),
// then their sentence rows and cards. New words come back with their lemma
// resolved through the full dictionary cascade, for confirmation.
// Returns { existingInputs, newTerms, rows, skippedDupes }.
export async function stageSelectedTerms(ctx, { terms, sentence, source, section }) {
  const { data, updateData, cards, decks, uid, updateCards, updateDecks, aviSources, dsh } = ctx;
  const existingInputs = [];
  const newTerms       = [];

  for (const t of terms) {
    const normTok = normalizeLemma(t.input);
    const existingWI = data.wordInputs.find(w =>
      w.input === t.input || normalizeLemma(w.lemma) === normTok
    );
    if (existingWI) {
      existingInputs.push(t.input);
      // If no word input exists for the current source, create one
      const alreadyInSource = data.wordInputs.some(w =>
        (w.input === t.input || normalizeLemma(w.lemma) === normTok) &&
        w.source === source
      );
      if (!alreadyInSource && source) {
        const lemmaEntry = data.lemmaMaster.find(
          l => normalizeLemma(l.lemma) === normalizeLemma(existingWI.lemma)
        );
        const newWI = {
          uid: uuid(), ts: new Date().toISOString(),
          input: t.input,
          source, section,
          lemma: existingWI.lemma,
          def1: lemmaEntry?.def1 || existingWI.def1 || '',
          def2: lemmaEntry?.def2 || existingWI.def2 || '',
          uploaded: false, skipUpload: false,
          lastUncheckReason: '', lastUncheckDate: '',
        };
        updateData(prev => {
          // Race-proof recheck: functional updaters see the latest state, so
          // a burst of same-lemma terms (or a double-fired handler) cannot
          // append the row twice — the closure-captured alreadyInSource check
          // above cannot guarantee that on its own.
          const dupRow = prev.wordInputs.some(w =>
            (w.input === t.input || normalizeLemma(w.lemma) === normTok) &&
            w.source === source
          );
          return dupRow ? prev : { ...prev, wordInputs: [newWI, ...prev.wordInputs] };
        });
        // Auto-create word card if def2 is present
        if (newWI.def2) {
          autoCreateWordCard({
            entry: newWI, lemmaMaster: data.lemmaMaster,
            cards, decks, uid, updateCards, updateDecks, aviSources, dsh, // A6: cards feed the duplicate guard
          }).then(() => {
            updateData(prev => ({
              ...prev,
              wordInputs: prev.wordInputs.map(w =>
                w.uid === newWI.uid ? { ...w, uploaded: true } : w
              ),
            }));
          }).catch(() => {});
        }
      }
    } else {
      newTerms.push({
        input: t.input, lemma: '', def1: '', def2: '',
        isPhrase: t.isPhrase || false,
        phraseTokens: t.phraseTokens || null,
      });
    }
  }

  // Resolve lemmas for new terms via the full dictionary cascade:
  // trusted GLM mapping, then heuristic candidates (including irregular
  // recoveries) validated as headwords, then the sync heuristic. Tier 1
  // (prior local mapping) is the existingWI branch above. Lookups run
  // in parallel across terms.
  if (newTerms.length > 0) {
    await resolveNewTerms(newTerms, data.lemmaMaster, sentence);
  }

  // Create rows for existing matches immediately
  let rows = [];
  let skippedDupes = [];
  if (existingInputs.length > 0) {
    ({ rows, skippedDupes } = addSentenceRows(ctx, {
      items: existingInputs.map(input => {
        const wi = data.wordInputs.find(w =>
          w.input === input || normalizeLemma(w.lemma) === normalizeLemma(input)
        );
        return {
          target: wi?.lemma || input,
          input,
          // L6: sentence cards wait for a def2 — an empty back is filled (and
          // the card created) by AVIPage's cascade once the lemma has one.
          back: (lEntry) => lEntry.def2 || wi?.def2 || '',
        };
      }),
      sentence, source, section,
    }));
    // Auto-create cards for rows with cardBack
    createSentenceRowCards(ctx, rows, data.lemmaMaster);
  }

  return { existingInputs, newTerms, rows, skippedDupes };
}

// Resolves each new term's lemma in place (sets lemma, resolvedLemma and
// alternates; drops the transient phraseTokens).
// `sentence` (LM4) is the sentence the terms were picked from; the lemma
// resolver's second opinion reads each word in it.
export async function resolveNewTerms(newTerms, lemmaMaster, sentence = '') {
  const localHeadwords = new Set();
  for (const l of (lemmaMaster || [])) {
    if (l.lemma) localHeadwords.add(l.lemma);
    if (l.cleanedLemma) localHeadwords.add(l.cleanedLemma);
  }
  await Promise.all(newTerms.map(async (nt) => {
    let resolved = nt.input;
    let alternates = [];
    if (nt.isPhrase) {
      resolved = lemmatizePhrase(nt.phraseTokens || []);
    } else {
      // L3: the other dictionary readings ride along for Step 1's chips.
      const d = await resolveLemmaDetailed(nt.input, { localHeadwords, withAlternates: true, context: sentence });
      resolved = d.lemma || nt.input;
      alternates = d.alternates || [];
    }
    // L4d: adopt an existing entry's own text when it matches a variant
    // (입사하다 → 입사(하다)), so the term links instead of duplicating.
    nt.lemma = canonicalLemma(lemmaMaster, resolved);
    nt.resolvedLemma = nt.lemma;
    nt.alternates = alternates.map(a => canonicalLemma(lemmaMaster, a));
  }));
  // Drop the transient helper field so popup state shape is unchanged.
  newTerms.forEach(nt => { delete nt.phraseTokens; });
  return newTerms;
}

// ── 4. Definitions for confirmed lemmas ───────────────────────
export async function fetchTermDefinitions(terms, lemmaMaster, aviSettings) {
  return Promise.all(terms.map(async t => {
    const existing = lemmaMaster.find(
      l => l.lemma === t.lemma || normalizeLemma(l.lemma) === normalizeLemma(t.lemma)
    ) || findLemmaEntryAny(lemmaMaster, t.lemma); // L4d: 입사하다 → 입사(하다)
    if (existing) return { ...t, lemma: existing.lemma, def1: existing.def1 || '', def2: existing.def2 || '' };
    try {
      // Tier 2: retry a dictionary miss with the surface's next candidates —
      // only when the lemma is still the machine's own untouched guess.
      const fb = await fetchDefinitionWithFallback(
        (!t.isPhrase && t.lemma === t.resolvedLemma) ? t.input : '', t.lemma, aviSettings);
      if (fb.lemma !== t.lemma) {
        const adopted = lemmaMaster.find(
          l => l.lemma === fb.lemma || normalizeLemma(l.lemma) === normalizeLemma(fb.lemma)
        );
        if (adopted) return { ...t, lemma: fb.lemma, def1: adopted.def1 || '', def2: adopted.def2 || '' };
      }
      return { ...t, lemma: fb.lemma, def1: fb.def1 === '__RATE_LIMITED__' ? '' : (fb.def1 || '') };
    } catch { return t; }
  }));
}

// ── 5. Commit confirmed terms ─────────────────────────────────
// Creates the Lemma Master entries and Word Input rows the terms need, moves
// a changed def2 everywhere (A5), adds the sentence rows and creates cards.
// Returns { rows, skippedDupes, newLemmas, newWordInputs, def2Moves }.
export function commitConfirmedTerms(ctx, {
  terms, sentence, source, section,
  def2Reason = 'Definition 2 updated in Sentence Input',
  logPrefix = 'Sentence Input',
}) {
  const { data, updateData, cards, decks, uid, updateCards, updateDecks, aviSources, dsh } = ctx;
  const newWordInputs = [];
  const newLemmas     = [];
  const now           = new Date().toISOString();

  // Popup-corrected lemmas feed the global lemma map — same policy as WI
  // edits and Import review corrections (explicit corrections only).
  for (const t of terms) {
    if (t.input && t.resolvedLemma && t.lemma && t.lemma !== t.resolvedLemma) {
      writeGlobalLemma(t.input, normalizeLemma(t.lemma));
    }
  }

  for (const t of terms) {
    const norm = normalizeLemma(t.lemma);
    const existingLM = findPickEntry(data.lemmaMaster, t.lemma); // L4d: variant match
    if (!existingLM) {
      newLemmas.push({
        lemma: t.lemma, def1: t.def1, def2: t.def2 || '',
        relatedForm: '', relatedMeaning: '', hiddenRelated: '',
        lastUpdated: now, autoAddedBy: 'pick',
        cleanedLemma: norm, originUID: uuid(), lemmaID: uuid(),
      });
    }
    if (!data.wordInputs.find(w => w.input === t.input)) {
      newWordInputs.push({
        uid: uuid(), ts: now, input: t.input,
        source, section,
        lemma: t.lemma, def1: t.def1, def2: t.def2 || '',
        uploaded: false, skipUpload: isSkippedInSource(data.wordInputs, source, t.lemma),
        lastUncheckReason: '', lastUncheckDate: '',
      });
    }
  }

  // A5: a def2 from the pop-up for a lemma Lemma Master already has
  // becomes that lemma's def2 (before, it reached only the new word row and
  // its card). An entry with no def2 gets it, which also releases sentence
  // rows waiting for one; a different one replaces it — the pop-up says so
  // and offers to keep Lemma Master's. Like a def2 edit in Lemma Master,
  // the lemma's other rows follow, sentence backs taken from the old def2
  // follow (hand-edited ones are kept), and so do its cards.
  const def2Moves = planDef2Moves(terms, data.lemmaMaster, findPickEntry);

  updateData(prev => {
    const moved = applyDef2Moves({
      lemmaMaster:    [...filterNewLemmas(prev.lemmaMaster, newLemmas), ...prev.lemmaMaster],
      wordInputs:     [...filterNewWordRows(prev.wordInputs, newWordInputs), ...prev.wordInputs],
      sentenceInputs: prev.sentenceInputs,
    }, def2Moves, now, def2Reason);
    return { ...prev, ...moved };
  });
  // LD-D1: every card of the word takes the def2 (a sentence card whose
  // back was a def1 too).
  for (const { entry, def2 } of def2Moves.values()) {
    updateLinkedCards({
      lemmaID: entry.lemmaID, lemmaText: entry.lemma,
      buildUpdates: (c) => def2CardUpdate(c, def2),
      cards, uid, updateCards,
    }).catch(e => console.error(`${logPrefix}: card back update failed`, e));
  }

  // Create sentence rows using confirmed lemmas
  const { rows, skippedDupes } = addSentenceRows(ctx, {
    items: terms.map(t => ({
      target: t.lemma || t.input,
      input: t.input,
      // A5: the def2 from the pop-up (prefilled with Lemma Master's, so it
      // differs only when you changed it) — Done makes it the lemma's.
      back: (lEntry) => t.def2 || lEntry.def2 || '', // L6: waits for a def2
    })),
    sentence, source, section,
  });

  // Auto-create cards for rows with cardBack
  createSentenceRowCards(ctx, rows, [...data.lemmaMaster, ...newLemmas]);

  for (const wi of newWordInputs) {
    if (wi.def2 && !wi.skipUpload) {
      autoCreateWordCard({
        entry: wi, lemmaMaster: [...data.lemmaMaster, ...newLemmas],
        cards, decks, uid, updateCards, updateDecks, aviSources, dsh, // A6
      }).then(() => {
        updateData(prev => ({
          ...prev,
          wordInputs: prev.wordInputs.map(w =>
            w.uid === wi.uid ? { ...w, uploaded: true } : w
          ),
        }));
      }).catch(() => {});
    }
  }

  return { rows, skippedDupes, newLemmas, newWordInputs, def2Moves };
}
