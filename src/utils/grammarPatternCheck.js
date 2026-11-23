// src/utils/grammarPatternCheck.js
// The Pattern check (audit G3, decision GS-D8): how well the recogniser in
// grammarPatterns.js does on the Grammar Index as it really is. Read-only;
// the Dev Dashboard panel shows what this returns.
//
//   patternCheckReport(entries, sentences, analyse)
//     entries    Grammar Index entries ({ id, glossaryTerm, patternHint,
//                sightingsOff, examples, entryNumber })
//     sentences  mined sentences (strings; repeats are counted once)
//     analyse    the analyser (koreanAnalyser.js)
//
// It answers three questions:
//   1. Can each entry's pattern be read from its title (or hint) at all?
//   2. Is each entry found in its own example lines? Those lines are
//      sentences already labelled with the right entry, so this is a real
//      test on real data. Entries not found are the ones needing a hint.
//   3. How often does each entry appear in the mined sentences? An entry
//      that appears in a large share of them (~을/를, ~에) is no use as a
//      sighting; one that appears now and then is.
//
// Leaf module: imports only grammarPatterns.js.

import { compilePatterns, findPatterns, entryPattern, skeletonLabel } from './grammarPatterns.js';

// An entry seen in more than this share of the mined sentences is too
// common to be worth collecting (~을/를, ~에, ~고): the one-time "switch off
// common entries" action in Dev Dashboard uses it. Chosen from real counts
// (decision GS-D3).
export const COMMON_SHARE = 0.03;

const hangul = /[가-힣]/;
const exampleLines = (entry) => String(entry.examples || '').split('\n').map(s => s.trim()).filter(s => hangul.test(s));

export function patternCheckReport(entries, sentences, analyse) {
  const list = (entries || []).map(e => ({ ...e, pattern: entryPattern(e) }));
  const compiled = compilePatterns(list.map(e => ({ id: e.id, pattern: e.pattern })), analyse);
  const byId = new Map(compiled.map(c => [c.id, c]));
  const label = (e) => ({ id: e.id, term: e.glossaryTerm || '(no term)', number: e.entryNumber ?? null, kind: byId.get(e.id).kind, hinted: !!String(e.patternHint || '').trim(), off: e.sightingsOff === true, kept: e.sightingsOff === false });

  const counts = { entries: list.length, topic: 0, single: 0, specific: 0, unread: 0 };
  for (const c of compiled) counts[c.kind]++;

  // 2. Own examples. Everything is looked for and nothing is dropped in
  // favour of a longer relative: the question is only "can it be seen".
  const own = { withExamples: 0, withoutExamples: 0, lines: 0, linesFound: 0, linesBySurfaceOnly: 0, all: [], some: [], none: [] };
  for (const e of list) {
    const c = byId.get(e.id);
    if (c.kind === 'topic') continue;
    const lines = exampleLines(e);
    if (!lines.length) { own.withoutExamples++; continue; }
    own.withExamples++;
    let found = 0; const missed = [];
    for (const line of lines) {
      const hit = c.kind === 'unread' ? null : findPatterns(line, [c], analyse, { single: 'all' })[0];
      if (hit) { found++; if (hit.by === 'surface') own.linesBySurfaceOnly++; } else missed.push(line);
    }
    own.lines += lines.length; own.linesFound += found;
    const row = { ...label(e), lines: lines.length, found, missed, reads: c.skeletons.map(s => s.text) };
    (found === lines.length ? own.all : found === 0 ? own.none : own.some).push(row);
  }

  // Entries whose patterns read exactly alike: they can't be told apart.
  const groups = new Map();
  for (const e of list) {
    const c = byId.get(e.id);
    if (!c.skeletons.length) continue;
    const key = c.skeletons.map(s => s.text).sort().join(' | ');
    groups.set(key, [...(groups.get(key) || []), label(e)]);
  }
  const sharedForms = [...groups.entries()].filter(([, g]) => g.length > 1).map(([reads, g]) => ({ reads, entries: g }));

  // 3. How often each entry appears in the mined sentences, with the
  // most-specific-wins rule on, as a review would see it.
  const unique = [...new Set((sentences || []).map(s => String(s || '').trim()).filter(s => hangul.test(s)))];
  // `sentences` counts every reading; `longer` counts only readings of two
  // or more parts, which is what an entry is found by unless its one-part
  // readings are switched on (~(으)면, N(이)면 is mostly its bare 면).
  const seenIn = new Map(), seenLonger = new Map();
  let sentencesWithAny = 0;
  for (const s of unique) {
    const longer = findPatterns(s, compiled, analyse);
    if (longer.length) sentencesWithAny++;
    for (const h of longer) seenLonger.set(h.id, (seenLonger.get(h.id) || 0) + 1);
    for (const h of findPatterns(s, compiled, analyse, { single: 'all' })) seenIn.set(h.id, (seenIn.get(h.id) || 0) + 1);
  }
  const frequency = list
    .filter(e => byId.get(e.id).kind === 'single' || byId.get(e.id).kind === 'specific')
    .map(e => ({ ...label(e), sentences: seenIn.get(e.id) || 0, longer: seenLonger.get(e.id) || 0 }))
    .sort((a, b) => b.sentences - a.sentences || String(a.term).localeCompare(String(b.term)));

  return {
    counts,
    unread: list.filter(e => byId.get(e.id).kind === 'unread').map(label),
    own,
    sharedForms,
    mined: { sentences: unique.length, withALongerPattern: sentencesWithAny, neverSeen: frequency.filter(f => f.sentences === 0).length, frequency },
  };
}

// The entries the "switch off common entries" action would switch off:
// seen (by any of their forms, which is how an entry that is on is looked
// for) in more than `share` of the mined sentences, and never switched by
// hand. sightingsOff has three states: absent (on, nobody has chosen),
// true (off), false (on, chosen in the entry's own panel). An entry the user
// has switched back on herself is left alone however common it is.
export function commonEntries(report, share = COMMON_SHARE) {
  const total = report?.mined?.sentences || 0;
  if (!total) return [];
  return report.mined.frequency.filter(f => !f.off && !f.kept && f.sentences / total > share);
}

// The smallest number of sentences that counts as "more than `share`" of
// `total`, for saying the rule in whole sentences (17 of 564, not "3%",
// which 16 of 564 also rounds to). 0 when there are no sentences.
export function commonMinimum(total, share = COMMON_SHARE) {
  if (!(total > 0)) return 0;
  let n = Math.max(1, Math.floor(total * share));
  while (n / total <= share) n++;
  while (n > 1 && (n - 1) / total > share) n--;
  return n;
}

// One entry, for its Recognition part in the Grammar Index: how its pattern
// is read, and whether it is found in its own example lines.
export function checkEntry(entry, analyse, patternOverride) {
  const pattern = patternOverride !== undefined ? (String(patternOverride).trim() || String(entry?.glossaryTerm || '').trim()) : entryPattern(entry);
  const [c] = compilePatterns([{ id: entry?.id ?? 'entry', pattern }], analyse);
  const lines = exampleLines(entry || {});
  const missed = c.kind === 'topic' || c.kind === 'unread' ? [...lines] : lines.filter(line => !findPatterns(line, [c], analyse, { single: 'all' }).length);
  return { kind: c.kind, reads: c.skeletons.map(s => skeletonLabel(s.parts)), writtenForm: c.surface.length > 0, lines: lines.length, found: lines.length - missed.length, missed };
}
