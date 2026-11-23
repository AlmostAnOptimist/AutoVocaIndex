// src/utils/grammarSightings.js
// Grammar sightings (audit G3, decisions GS-D4 and GS-D10 to GS-D14): which
// finished sections await a review, what a review offers, and what keeping a
// sighting writes to an entry.
//
// A sighting is one of the user's own mined sentences that shows an entry's
// pattern. Kept, it becomes one of the entry's examples (or replaces one);
// there is no separate list.
//
// Pure. The analyser is passed in (src/utils/koreanAnalyser.js in the app,
// tests/load-analyser.mjs in tests). Leaf module: imports only
// grammarPatterns.js.

import { compilePatterns, findPatterns, entryPattern } from './grammarPatterns.js';

export const MAX_EXAMPLES = 6;   // an entry's examples in all (GS-D4)
export const PER_ENTRY = 3;      // candidates shown per entry at a time (GS-D6)

const tidy = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const hangul = /[가-힣]/;
const when = (ts) => { const n = Date.parse(ts); return Number.isFinite(n) ? n : 0; };

// An entry's example lines, as the entry panel and the card's audio count
// them: one per line, blanks dropped.
export const exampleLines = (entry) => String(entry?.examples || '').split('\n').map(s => s.trim()).filter(Boolean);

// Is this sentence already one of the lines? A line written by hand may
// carry a translation after the sentence, so a line that starts with the
// sentence counts too.
const hasExample = (lines, sentence) => lines.some(l => { const t = tidy(l); return t === sentence || t.startsWith(sentence + ' '); });

// ── What awaits review (GS-D11) ───────────────────────────────
// A unit is a finished section with sentences mined since its review stamp,
// or a finished source's sentences that have no section.
//   sources       Library sources ({ id, title, sourceStatus, watchStatus,
//                 archived, sectionOrder, sightingsReviewedAt })
//   sections      Library sections ({ id, resourceId, content, status,
//                 sightingsReviewedAt })
//   sentenceRows  AVI sentence rows ({ sentence, source, section, ts })
// A row belongs to a section when its source is the source's title and its
// section is the section's name, as the Library counts them. Rows that
// match nothing are not offered.
// Returns units in source order, then section order:
//   { key, kind: 'section' | 'source', sourceId, sourceTitle, sectionName,
//     sectionIds, reviewedAt, sentences: [text], total }
// `sentences` are the different sentences newer than the stamp; `total` is
// how many different sentences the unit has in all. `sectionIds` lists
// every section of that name in the source (two sections named alike share
// their rows, so they are reviewed and stamped together).
const finishedSection = (s) => s.status === 'Done' || s.status === 'Skip';
const sourceStatus = (src) => src.sourceStatus ?? src.watchStatus ?? 'Not started';

export function sightingUnits({ sources, sections, sentenceRows }) {
  const rowsByKey = new Map();
  for (const r of sentenceRows || []) {
    const text = tidy(r?.sentence);
    if (!r?.source || !hangul.test(text)) continue;
    const key = `${r.source}\u0000${r.section == null ? '' : String(r.section)}`;
    if (!rowsByKey.has(key)) rowsByKey.set(key, []);
    rowsByKey.get(key).push({ text, at: when(r.ts) });
  }
  const fresh = (rows, stamp) => {
    const since = stamp ? when(stamp) : null;
    const all = new Set(), now = new Set();
    for (const r of rows || []) {
      all.add(r.text);
      if (since === null || r.at > since) now.add(r.text);
    }
    return { sentences: [...now], total: all.size };
  };

  const units = [];
  const sorted = [...(sources || [])].filter(s => s?.title).sort((a, b) => String(a.title).localeCompare(String(b.title)));
  for (const src of sorted) {
    const own = (sections || []).filter(s => s.resourceId === src.id);
    const place = new Map((src.sectionOrder || []).map((id, i) => [id, i]));
    const ordered = [...own].sort((a, b) => (place.get(a.id) ?? Infinity) - (place.get(b.id) ?? Infinity)
      || String(a.content ?? '').localeCompare(String(b.content ?? ''), undefined, { numeric: true }));

    // Rows of the source that name no section.
    const srcFinished = sourceStatus(src) === 'Done' || !!src.archived || (own.length > 0 && own.every(finishedSection));
    if (srcFinished) {
      const f = fresh(rowsByKey.get(`${src.title}\u0000`), src.sightingsReviewedAt);
      if (f.sentences.length) {
        units.push({ key: `source:${src.id}`, kind: 'source', sourceId: src.id, sourceTitle: src.title, sectionName: '', sectionIds: [],
          reviewedAt: src.sightingsReviewedAt || null, ...f });
      }
    }

    const seen = new Set();
    for (const sec of ordered) {
      const name = sec.content == null ? '' : String(sec.content);
      if (!name || seen.has(name)) continue;
      const alike = ordered.filter(s => String(s.content ?? '') === name);
      seen.add(name);
      if (!alike.every(finishedSection)) continue;
      // Reviewed together, so the earliest stamp among them is the one that
      // holds for all (none on any of them = never reviewed).
      const stamps = alike.map(s => s.sightingsReviewedAt || null);
      const stamp = stamps.includes(null) ? null : stamps.sort((a, b) => when(a) - when(b))[0];
      const f = fresh(rowsByKey.get(`${src.title}\u0000${name}`), stamp);
      if (!f.sentences.length) continue;
      units.push({ key: `section:${alike[0].id}`, kind: 'section', sourceId: src.id, sourceTitle: src.title, sectionName: name,
        sectionIds: alike.map(s => s.id), reviewedAt: stamp, ...f });
    }
  }
  return units;
}

// ── What a review offers (GS-D12) ─────────────────────────────
// Entries' patterns, read once. Recompile only when a title or hint changes
// (patternSignature says when).
export const patternSignature = (entries) => (entries || []).map(e => `${e.id}\u0000${entryPattern(e)}`).join('\u0001');
export const compileEntries = (entries, analyse) => compilePatterns((entries || []).map(e => ({ id: e.id, pattern: entryPattern(e) })), analyse);

// One entry's group: its header facts and its candidates, shortest first.
export function groupOf(entry, candidates) {
  const lines = exampleLines(entry);
  return {
    entryId: entry.id, term: entry.glossaryTerm || '(no term)', number: entry.entryNumber ?? null, lines, full: lines.length >= MAX_EXAMPLES,
    candidates: [...(candidates || [])].sort((a, b) => a.sentence.length - b.sentence.length || a.sentence.localeCompare(b.sentence)),
  };
}

// The sightings in a set of sentences, grouped by entry.
//   entries    Grammar Index entries ({ id, glossaryTerm, entryNumber,
//              examples, sightingsOff })
//   sentences  strings, or { sentence, source, section } to carry where
//              each was mined (repeats are offered once, the first kept)
//   compiled   compileEntries(entries, analyse)
//   opts.only        an entry id: offer for that entry alone
//   opts.includeOff  offer for switched-off entries too (an entry's own
//                    panel: the user asked for that entry by name)
// Every form of every entry is looked for and the most specific wins; only
// then are switched-off entries dropped, so a switched-off longer entry
// does not hand its sentence to a shorter one. A sentence already among an
// entry's examples is not offered for it.
// Returns [{ entryId, term, number, lines, full, candidates: [{ sentence,
// marks: [[from, to]], source, section }] }]: entries with no examples
// first, then fewest first, full entries last; candidates shortest first.
export function sightingGroups({ entries, sentences, compiled, analyse, opts = {} }) {
  const byId = new Map((entries || []).map(e => [e.id, e]));
  const linesOf = new Map((entries || []).map(e => [e.id, exampleLines(e)]));
  const groups = new Map();
  const unique = new Map();
  for (const item of sentences || []) {
    const given = item && typeof item === 'object';
    const sentence = tidy(given ? item.sentence : item);
    if (!hangul.test(sentence) || unique.has(sentence)) continue;
    unique.set(sentence, { source: (given && item.source) || null, section: (given && item.section) || null });
  }
  for (const [sentence, from] of unique) {
    const mine = new Map();
    for (const h of findPatterns(sentence, compiled, analyse, { single: 'all' })) {
      const e = byId.get(h.id);
      if (!e || (e.sightingsOff === true && !opts.includeOff)) continue;
      if (opts.only && h.id !== opts.only) continue;
      if (hasExample(linesOf.get(h.id), sentence)) continue;
      if (!mine.has(h.id)) mine.set(h.id, []);
      mine.get(h.id).push([h.from, h.to]);
    }
    for (const [id, marks] of mine) {
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push({ sentence, marks, ...from });
    }
  }
  return [...groups.entries()].map(([id, candidates]) => groupOf(byId.get(id), candidates))
    .sort((a, b) => (a.full - b.full) || (a.lines.length - b.lines.length) || ((a.number ?? Infinity) - (b.number ?? Infinity)) || String(a.term).localeCompare(String(b.term)));
}

// Every different sentence the user has mined, each with where it was first
// mined, for an entry's own "from your sentences" (GS-D15, question 3).
// This is everything, finished section or not, reviewed or not.
export function minedSentences(sentenceRows) {
  const first = new Map();
  for (const r of sentenceRows || []) {
    const sentence = tidy(r?.sentence);
    if (!hangul.test(sentence)) continue;
    const at = when(r.ts), seen = first.get(sentence);
    if (!seen || at < seen.at) first.set(sentence, { sentence, source: r.source || null, section: r.section == null || r.section === '' ? null : String(r.section), at });
  }
  return [...first.values()].map(({ sentence, source, section }) => ({ sentence, source, section }));
}

// For the Library's mark on a finished section that awaits review: which
// unit each section (and each source, for its section-less sentences)
// belongs to. { bySection: { sectionId: unitKey }, bySource: { sourceId:
// unitKey } }
export function sightingMarks(units) {
  const bySection = {}, bySource = {};
  for (const u of units || []) {
    if (u.kind === 'source') bySource[u.sourceId] = u.key;
    else for (const id of u.sectionIds) bySection[id] = u.key;
  }
  return { bySection, bySource };
}

export const countSightings = (groups) => (groups || []).reduce((n, g) => n + g.candidates.length, 0);

// ── Keeping sightings (GS-D4, GS-D13, GS-D14) ─────────────────
// What an entry's examples become once the chosen sightings are kept.
//   entry     the entry as it is ({ examples, exampleSources })
//   choices   [{ sentence, replace, source, section }] in the order chosen;
//             `replace` is the example line it takes the place of, or
//             null / absent to add it as a new line
// Rules: an addition is taken only while the entry has fewer than
// MAX_EXAMPLES lines; a replacement at any time; a sentence already among
// the lines is not added twice; a replacement whose line is gone is not
// made. The example text is the sentence alone. Where each kept sighting
// came from is recorded beside it in exampleSources ([{ text, source,
// section }]), and records for lines no longer there are dropped.
// Returns { examples, exampleSources, changed, added, replaced, refused }.
// Other lines, their order and any blank lines between them are left as
// they were.
export function keepSightings(entry, choices) {
  const raw = String(entry?.examples || '').split('\n');
  while (raw.length && !raw[raw.length - 1].trim()) raw.pop();
  const count = () => raw.filter(l => l.trim()).length;
  const has = (text) => raw.some(l => tidy(l) === text);
  const came = new Map();
  const result = { added: [], replaced: [], refused: [] };

  for (const c of choices || []) {
    const sentence = tidy(c?.sentence);
    if (!sentence) continue;
    const from = { text: sentence, source: c.source ?? null, section: c.section ?? null };
    if (has(sentence)) { result.refused.push({ sentence, why: 'already an example' }); continue; }
    if (c.replace != null && c.replace !== '') {
      const old = tidy(c.replace);
      const i = raw.findIndex(l => tidy(l) === old);
      if (i < 0) { result.refused.push({ sentence, why: 'the example to replace is gone' }); continue; }
      raw[i] = sentence;
      came.delete(old);
      came.set(sentence, from);
      result.replaced.push({ sentence, was: old });
    } else {
      if (count() >= MAX_EXAMPLES) { result.refused.push({ sentence, why: 'the entry is full' }); continue; }
      raw.push(sentence);
      came.set(sentence, from);
      result.added.push(sentence);
    }
  }

  const present = new Set(raw.map(tidy).filter(Boolean));
  const kept = (Array.isArray(entry?.exampleSources) ? entry.exampleSources : [])
    .filter(s => s && present.has(tidy(s.text)) && !came.has(tidy(s.text)))
    .map(s => ({ text: tidy(s.text), source: s.source ?? null, section: s.section ?? null }));
  const exampleSources = [...kept, ...[...came.values()].filter(s => present.has(s.text))];
  return { examples: raw.join('\n'), exampleSources, changed: result.added.length + result.replaced.length > 0, ...result };
}

// Where an example line came from, for the faint label beside it: "Source ·
// Section", or '' for a line written by hand.
export function exampleOrigin(entry, line) {
  const text = tidy(line);
  const s = (Array.isArray(entry?.exampleSources) ? entry.exampleSources : []).find(x => x && tidy(x.text) === text);
  if (!s || !s.source) return '';
  return s.section ? `${s.source} · ${s.section}` : String(s.source);
}
