// src/utils/grammarCorrections.js
// Correction links (audit G2, decision GS-D9): which Grammar Index entries
// a corrections session is about, worked out from its rows.
//
// A row suggests an entry when the entry's pattern shows in the row's
// corrected text and not in its original: the correction put that grammar
// in. A correction that only changes a word shows no difference and
// suggests nothing. It is a suggestion and a record only: linking writes
// the session's linkedGrammarIds, the link notes already use, and nothing
// about mastery, scheduling or the quiz.
//
// Every entry is looked for, including those switched off for sightings: a
// wrong particle is exactly the kind of correction worth recording, however
// common the particle.
//
// Pure. The analyser is passed in. Leaf module: imports only
// grammarPatterns.js.

import { findPatterns } from './grammarPatterns.js';

const hangul = /[가-힣]/;

// Rows hold rich text (highlights, links). Their plain text, one space
// where a block or line break was.
export function plainText(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ').trim();
}

//   rows      the session's rows ({ topic, original, corrected }, rich text)
//   entries   Grammar Index entries ({ id, glossaryTerm, entryNumber })
//   compiled  the entries' patterns (compileEntries in grammarSightings.js)
//   linked    entry ids the session already links to (not suggested again)
// A row counts only when both its original and its corrected text have
// Korean; with no original there is nothing to compare against.
// Returns [{ entryId, term, number, rows }]: `rows` is how many rows suggest
// the entry; most rows first, then by entry number.
export function correctionSuggestions({ rows, entries, compiled, analyse, linked }) {
  const byId = new Map((entries || []).map(e => [e.id, e]));
  const have = new Set(linked || []);
  const seen = new Map();
  for (const row of rows || []) {
    const original = plainText(row?.original), corrected = plainText(row?.corrected);
    if (!hangul.test(original) || !hangul.test(corrected) || original === corrected) continue;
    const before = new Set(findPatterns(original, compiled, analyse, { single: 'all' }).map(h => h.id));
    const after = new Set(findPatterns(corrected, compiled, analyse, { single: 'all' }).map(h => h.id));
    for (const id of after) if (!before.has(id) && !have.has(id) && byId.has(id)) seen.set(id, (seen.get(id) || 0) + 1);
  }
  return [...seen.entries()]
    .map(([id, n]) => ({ entryId: id, term: byId.get(id).glossaryTerm || '(no term)', number: byId.get(id).entryNumber ?? null, rows: n }))
    .sort((a, b) => b.rows - a.rows || (a.number ?? Infinity) - (b.number ?? Infinity) || String(a.term).localeCompare(String(b.term)));
}
