// src/utils/echoSources.js
// Where an Echo Quiz word list comes from (Stage E2; E-D4 and "Sources" of
// the Echo Quiz design). Each source returns Lemma Master
// entries in priority order; echoEngine.buildItem / selectItems turn them into
// the session list (collision guard, size).
//
//   due      vocab cards due today (FSRS/SM-2 via fsrs.js), most overdue first;
//            cards whose decks are all paused are skipped
//   recent   word rows, newest first
//   trouble  vocab cards you struggle with (lapses / difficulty, legacy ease),
//            worst first; paused decks skipped
//   library  word rows from one Content Library source (and section), shuffled
//   deck     vocab cards in the chosen decks (all vocab decks when none), shuffled
//   manual   nothing automatic; words are added by search
//
// Pure: imports only fsrs.js (itself only dateUtils.js). normalizeLemma lives in
// aviUtils.js, which imports Firebase, so callers pass it in as `normalize`.
// Runs in plain Node for scripts/echo-golden.mjs.

import { isDueToday, isNewCard, getDueDateStr } from './fsrs.js';

export const ECHO_SOURCE_IDS = ['due', 'recent', 'trouble', 'library', 'deck', 'manual'];
export const GRAMMAR_DECK_ID = 'deck_grammar';

const shuffled = (arr, rand = Math.random) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// Decks a vocabulary quiz can draw from (same rule as the Vocabulary Quiz).
export function vocabDecks(decks) {
  return (decks || []).filter(d => d && d.id !== GRAMMAR_DECK_ID && d.type !== 'grammar' && !String(d.name || '').endsWith('(sentence mining)'));
}

export function isVocabCard(card) {
  if (!card || card.type === 'grammar' || card.type === 'sentence') return false;
  return !(card.deckIds || []).includes(GRAMMAR_DECK_ID);
}

// A card counts as paused only when every deck it belongs to is paused
// (same rule as the Cards page).
export function pausedDeckSet(decks) {
  return new Set((decks || []).filter(d => d && d.paused).map(d => d.id));
}
export function isCardPaused(card, paused) {
  const ids = card?.deckIds || [];
  return ids.length > 0 && ids.every(id => paused.has(id));
}

// How much a card is struggling, or null when it isn't. FSRS: the
// triageBucket / quiz-weighting thresholds (lapses > 3, difficulty > 7) plus a
// last answer of Again (learning / relearning). Legacy SM-2: ease below 2.0 or
// a failed last grade. Higher = worse.
export function struggleScore(card) {
  if (!card || isNewCard(card)) return null;
  if (card.stability) {
    const lapses = card.lapses ?? 0, d = card.difficulty ?? 5;
    const again = card.state === 'learning' || card.state === 'relearning';
    if (!(lapses > 3 || d > 7 || again)) return null;
    return lapses * 2 + Math.max(0, d - 5) + (again ? 5 : 0);
  }
  const ef = card.easeFactor ?? 2.5;
  const failed = card.lastGrade != null && card.lastGrade < 3;
  if (!(ef < 2.0 || failed)) return null;
  return Math.max(0, (2.5 - ef) * 5) + (failed ? 5 : 0);
}

// Lookup helpers. When two entries share a normalized lemma, the one with a
// def2 wins, then the most recently updated.
export function indexEntries(lemmaMaster, normalize) {
  const byId = new Map(), byNorm = new Map();
  for (const e of lemmaMaster || []) {
    if (!e?.lemmaID) continue;
    byId.set(e.lemmaID, e);
    const k = normalize(e.lemma || '');
    if (!k) continue;
    const cur = byNorm.get(k);
    const better = !cur
      || (!!e.def2 && !cur.def2)
      || (!!e.def2 === !!cur.def2 && String(e.lastUpdated || '') > String(cur.lastUpdated || ''));
    if (better) byNorm.set(k, e);
  }
  return { byId, byNorm };
}

export function entryForCard(card, idx, normalize) {
  if (card?.linkedAVILemmaId && idx.byId.has(card.linkedAVILemmaId)) return idx.byId.get(card.linkedAVILemmaId);
  const k = normalize(card?.lemma || card?.front || '');
  return (k && idx.byNorm.get(k)) || null;
}

export function entryForRow(row, idx, normalize) {
  const k = normalize(row?.lemma || '');
  return (k && idx.byNorm.get(k)) || null;
}

const uniqueEntries = (entries) => {
  const seen = new Set(), out = [];
  for (const e of entries) {
    if (!e || seen.has(e.lemmaID)) continue;
    seen.add(e.lemmaID);
    out.push(e);
  }
  return out;
};

// Entries for one source, in priority order.
// ctx: { cards, decks, wordInputs, lemmaMaster, normalize, dsh, deckIds,
//        sourceTitle, section, rand }
export function sourceEntries(source, ctx) {
  const { cards = [], decks = [], wordInputs = [], normalize, dsh = 3, rand = Math.random } = ctx;
  const idx = ctx.index || indexEntries(ctx.lemmaMaster, normalize);
  const paused = pausedDeckSet(decks);
  const vocab = cards.filter(isVocabCard);

  if (source === 'due') {
    const due = vocab
      .filter(c => !isCardPaused(c, paused) && isDueToday(c, dsh))
      .sort((a, b) => String(getDueDateStr(a) || '').localeCompare(String(getDueDateStr(b) || ''))
        || (struggleScore(b) ?? 0) - (struggleScore(a) ?? 0));
    return uniqueEntries(due.map(c => entryForCard(c, idx, normalize)));
  }
  if (source === 'trouble') {
    const scored = vocab
      .filter(c => !isCardPaused(c, paused))
      .map(c => ({ c, s: struggleScore(c) }))
      .filter(x => x.s !== null)
      .sort((a, b) => b.s - a.s);
    return uniqueEntries(scored.map(x => entryForCard(x.c, idx, normalize)));
  }
  if (source === 'recent') {
    const rows = wordInputs
      .filter(w => w && !w.skipUpload && w.lemma)
      .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
    return uniqueEntries(rows.map(w => entryForRow(w, idx, normalize)));
  }
  if (source === 'library') {
    if (!ctx.sourceTitle) return [];
    const rows = wordInputs.filter(w => w && !w.skipUpload && w.lemma && w.source === ctx.sourceTitle
      && (!ctx.section || String(w.section ?? '') === String(ctx.section)));
    return uniqueEntries(shuffled(rows, rand).map(w => entryForRow(w, idx, normalize)));
  }
  if (source === 'deck') {
    const allowed = new Set((ctx.deckIds && ctx.deckIds.length ? ctx.deckIds : vocabDecks(decks).map(d => d.id)));
    const inDecks = vocab.filter(c => (c.deckIds || []).some(id => allowed.has(id)));
    return uniqueEntries(shuffled(inDecks, rand).map(c => entryForCard(c, idx, normalize)));
  }
  return [];
}

// Content Library sources that have word rows, with their row counts, by title.
export function librarySourcesWithWords(wordInputs) {
  const counts = new Map();
  for (const w of wordInputs || []) {
    if (!w || w.skipUpload || !w.lemma || !w.source) continue;
    counts.set(w.source, (counts.get(w.source) || 0) + 1);
  }
  return [...counts.entries()].map(([title, count]) => ({ title, count }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

// Sections of one source that have word rows, in the order given
// (getSourceSections order), plus any section values only the rows know.
export function librarySectionsWithWords(wordInputs, sourceTitle, orderedSectionNames = []) {
  const counts = new Map();
  for (const w of wordInputs || []) {
    if (!w || w.skipUpload || !w.lemma || w.source !== sourceTitle) continue;
    const s = String(w.section ?? '');
    if (!s) continue;
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  const ordered = orderedSectionNames.map(String).filter(s => counts.has(s));
  const extra = [...counts.keys()].filter(s => !ordered.includes(s)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return [...ordered, ...extra].map(name => ({ name, count: counts.get(name) }));
}

// Manual add: search Lemma Master by Korean (NFC, spaces ignored) or English
// (def2 / def1 text). Exact Korean first, then starts-with, then contains,
// then English matches. Returns entries, at most `limit`.
export function searchEntries(lemmaMaster, query, limit = 8) {
  const q = String(query || '').normalize('NFC').trim().toLowerCase();
  if (!q) return [];
  const qk = q.replace(/\s+/g, '');
  const tiers = [[], [], [], []];
  const hangul = /[가-힣]/.test(q);
  for (const e of lemmaMaster || []) {
    if (!e?.lemmaID || !e.lemma) continue;
    const k = String(e.lemma).normalize('NFC').toLowerCase().replace(/[\s()]/g, '');
    if (hangul) {
      if (k === qk) tiers[0].push(e);
      else if (k.startsWith(qk)) tiers[1].push(e);
      else if (k.includes(qk)) tiers[2].push(e);
    } else {
      const en = `${e.def2 || ''}\n${e.def1 || ''}`.toLowerCase();
      if (new RegExp(`(^|[^a-z])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(String(e.def2 || '').toLowerCase())) tiers[1].push(e);
      else if (en.includes(q)) tiers[3].push(e);
    }
  }
  return tiers.flat().slice(0, limit);
}
