// src/utils/seriesDecks.js
// Series decks (Oct 2026).
// A Content Library series gets a virtual word deck and a virtual
// "(sentence mining)" deck that pool the cards of its books' decks. There
// is no deck doc: the cards are the books' own cards, so a review in either
// place moves the same card. Decks belong to a source by NAME, the way
// cardFactory files cards (deck name = source title, or title +
// " (sentence mining)").
//
// Quizzes keep a series pick in the same deckIds array as a token
// ("series:<name>" / "series-sm:<name>"), expanded to the books' deck ids
// when the quiz starts.
//
// Pure leaf module: no imports.

export const SENTENCE_DECK_SUFFIX = ' (sentence mining)';
const WORD_PREFIX     = 'series:';
const SENTENCE_PREFIX = 'series-sm:';

const clean = (s) => String(s || '').normalize('NFC').trim();

export const isSeriesToken = (id) =>
  typeof id === 'string' && (id.startsWith(WORD_PREFIX) || id.startsWith(SENTENCE_PREFIX));

export const seriesWordId     = (name) => WORD_PREFIX + name;
export const seriesSentenceId = (name) => SENTENCE_PREFIX + name;

function seriesOrderValue(src) {
  const n = parseFloat(src.seriesOrder);
  return Number.isFinite(n) ? n : Infinity;
}

// sources: Content Library sources ({ id, title, series, seriesOrder,
// archived? }); decks: deck docs. Returns one group per series name, books
// ordered by series order then title:
//   { name, wordId, sentenceId,
//     members: [{ sourceId, title, wordDeckId, sentenceDeckId }],
//     wordDeckIds, sentenceDeckIds }
// Archived sources stay in: a finished book's cards still belong to the series.
export function buildSeriesGroups(sources, decks) {
  const deckByName = new Map();
  for (const d of decks || []) {
    if (!d || !d.id || d.id === 'deck_grammar') continue;
    const k = clean(d.name);
    if (k && !deckByName.has(k)) deckByName.set(k, d.id);
  }
  const byName = new Map();
  for (const s of sources || []) {
    const name = clean(s?.series);
    const title = clean(s?.title);
    if (!name || !title) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(s);
  }
  const groups = [];
  for (const [name, srcs] of byName) {
    const members = [...srcs]
      .sort((a, b) => (seriesOrderValue(a) - seriesOrderValue(b)) || clean(a.title).localeCompare(clean(b.title)))
      .map(s => ({
        sourceId:       s.id,
        title:          clean(s.title),
        wordDeckId:     deckByName.get(clean(s.title)) || null,
        sentenceDeckId: deckByName.get(clean(s.title) + SENTENCE_DECK_SUFFIX) || null,
      }));
    groups.push({
      name,
      wordId:          seriesWordId(name),
      sentenceId:      seriesSentenceId(name),
      members,
      wordDeckIds:     members.map(m => m.wordDeckId).filter(Boolean),
      sentenceDeckIds: members.map(m => m.sentenceDeckId).filter(Boolean),
    });
  }
  return groups.sort((a, b) => a.name.localeCompare(b.name));
}

// Series worth a deck: at least two books with decks of that kind (SD-D7).
export const wordSeries     = (groups) => (groups || []).filter(g => g.wordDeckIds.length >= 2);
export const sentenceSeries = (groups) => (groups || []).filter(g => g.sentenceDeckIds.length >= 2);

// Titles of the other books in the series a source title belongs to (all
// series it's in, in case two sources share a title). Used by cardFactory to
// share one word card across a series (SD-D8).
export function seriesSiblingTitles(sourceTitle, sources) {
  const t = clean(sourceTitle);
  if (!t) return [];
  const names = new Set((sources || []).filter(s => clean(s?.title) === t && clean(s?.series)).map(s => clean(s.series)));
  if (!names.size) return [];
  return [...new Set((sources || [])
    .filter(s => names.has(clean(s?.series)) && clean(s?.title) && clean(s.title) !== t)
    .map(s => clean(s.title)))];
}

// The group (and kind) a token names, or null.
export function groupForToken(id, groups) {
  if (!isSeriesToken(id)) return null;
  for (const g of groups || []) {
    if (g.wordId === id)     return { group: g, kind: 'word' };
    if (g.sentenceId === id) return { group: g, kind: 'sentence' };
  }
  return null;
}

const memberIdsOf = (group, kind) => (kind === 'sentence' ? group.sentenceDeckIds : group.wordDeckIds);

// deckIds (deck ids and series tokens) → real deck ids, de-duplicated.
// A token whose series no longer exists expands to nothing.
export function expandDeckSelection(deckIds, groups) {
  const out = [];
  for (const id of deckIds || []) {
    if (isSeriesToken(id)) {
      const hit = groupForToken(id, groups);
      if (hit) out.push(...memberIdsOf(hit.group, hit.kind));
    } else {
      out.push(id);
    }
  }
  return [...new Set(out)];
}

// Series chip (SD-D5): on → the token replaces its books' deck ids; off → removed.
export function toggleSeriesSelection(deckIds, group, kind) {
  const token = kind === 'sentence' ? group.sentenceId : group.wordId;
  const cur = deckIds || [];
  if (cur.includes(token)) return cur.filter(id => id !== token);
  const members = new Set(memberIdsOf(group, kind));
  return [...cur.filter(id => !members.has(id)), token];
}

// Book chip (SD-D6): while its series is on, tapping a book turns the series
// off and selects only that book; otherwise a plain toggle.
export function toggleDeckSelection(deckIds, deckId, groups) {
  const cur = deckIds || [];
  for (const id of cur) {
    const hit = groupForToken(id, groups);
    if (hit && memberIdsOf(hit.group, hit.kind).includes(deckId)) {
      return [...cur.filter(x => x !== id), deckId];
    }
  }
  return cur.includes(deckId) ? cur.filter(x => x !== deckId) : [...cur, deckId];
}

// Display names for a selection (series by name, decks via deckNameMap).
export function selectionNames(deckIds, groups, deckNameMap) {
  return (deckIds || []).map(id => {
    const hit = groupForToken(id, groups);
    if (hit) return hit.kind === 'sentence' ? `${hit.group.name}${SENTENCE_DECK_SUFFIX}` : hit.group.name;
    return deckNameMap?.[id];
  }).filter(Boolean);
}
