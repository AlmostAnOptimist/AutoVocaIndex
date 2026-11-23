// tests/grammar-sightings-golden.mjs
// Golden test for grammar sightings (audit G3, GS-D4 and GS-D10 to GS-D14):
//   src/utils/grammarSightings.js   what awaits review, what a review
//                                   offers, what keeping a sighting writes
// run with the real analyser kept in src/vendor/garu-ko. The sentences are
// written for the test; no study data.
//
// Run from the repo root:   node tests/grammar-sightings-golden.mjs   (or: npm test)
// Plain Node. Exits 1 on any failure.

import { loadAnalyser } from './load-analyser.mjs';

const S = await import('../src/utils/grammarSightings.js');
const analyse = await loadAnalyser();

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`);
}

// ── What awaits review ────────────────────────────────────────
{
  const sources = [
    { id: 'b', title: 'Book', sectionOrder: ['b2', 'b1', 'b3', 'b4'] },
    { id: 'a', title: 'Article', sourceStatus: 'Done' },
    { id: 'v', title: 'Videos', watchStatus: 'In Progress' },
    { id: 'old', title: 'Old', archived: true, sightingsReviewedAt: '2026-05-01T00:00:00.000Z' },
    { id: 'untitled' },
  ];
  const sections = [
    { id: 'b1', resourceId: 'b', content: 'Chapter 1', status: 'Done' },
    { id: 'b2', resourceId: 'b', content: 'Chapter 2', status: 'Done', sightingsReviewedAt: '2026-06-01T00:00:00.000Z' },
    { id: 'b3', resourceId: 'b', content: 'Chapter 3', status: 'In Progress' },
    { id: 'b4', resourceId: 'b', content: 'Chapter 4', status: 'Skip' },
    { id: 'v1', resourceId: 'v', content: 'Episode 1', status: 'Done', sightingsReviewedAt: '2026-06-01T00:00:00.000Z' },
    { id: 'v2', resourceId: 'v', content: 'Episode 1', status: 'Done' },
    { id: 'v3', resourceId: 'v', content: 'Episode 2', status: 'Done' },
    { id: 'v4', resourceId: 'v', content: 'Episode 2', status: 'Not started' },
  ];
  const row = (sentence, source, section, ts) => ({ sentence, source, section, ts, targetWord: 'x' });
  const rows = [
    row('비가 와요.', 'Book', 'Chapter 1', '2026-05-10T00:00:00.000Z'),
    row('비가  와요. ', 'Book', 'Chapter 1', '2026-05-11T00:00:00.000Z'),   // the same sentence, another word mined
    row('눈이 와요.', 'Book', 'Chapter 1', ''),
    row('No Korean here', 'Book', 'Chapter 1', '2026-05-10T00:00:00.000Z'),
    row('옛날 문장이에요.', 'Book', 'Chapter 2', '2026-05-20T00:00:00.000Z'),       // before the stamp
    row('새 문장이에요.', 'Book', 'Chapter 2', '2026-06-02T00:00:00.000Z'),          // after it
    row('아직 읽는 중이에요.', 'Book', 'Chapter 3', '2026-06-02T00:00:00.000Z'),     // section not finished
    row('건너뛴 장이에요.', 'Book', 'Chapter 4', '2026-06-02T00:00:00.000Z'),
    row('장이 없는 문장이에요.', 'Book', null, '2026-06-02T00:00:00.000Z'),          // Book is not finished as a whole
    row('기사 문장이에요.', 'Article', null, '2026-06-02T00:00:00.000Z'),
    row('기사 문장 둘이에요.', 'Article', '', '2026-06-03T00:00:00.000Z'),
    row('일화 문장이에요.', 'Videos', 'Episode 1', '2026-06-05T00:00:00.000Z'),
    row('이화 문장이에요.', 'Videos', 'Episode 2', '2026-06-05T00:00:00.000Z'),      // one Episode 2 is not finished
    row('오래된 문장이에요.', 'Old', null, '2026-04-01T00:00:00.000Z'),              // before the source's stamp
    row('어디에도 없어요.', 'Gone', 'Chapter 1', '2026-06-02T00:00:00.000Z'),        // matches nothing
    row('숫자 장이에요.', 'Book', 7, '2026-06-02T00:00:00.000Z'),
    { sentence: '출처가 없어요.', ts: '2026-06-02T00:00:00.000Z' },
    null,
  ];
  const units = S.sightingUnits({ sources, sections, sentenceRows: rows });
  check('units: finished sections with sentences newer than their stamp, in source then section order',
    units.map(u => [u.key, u.kind, u.sourceTitle, u.sectionName, u.sectionIds, u.reviewedAt, u.sentences, u.total]),
    [
      ['source:a', 'source', 'Article', '', [], null, ['기사 문장이에요.', '기사 문장 둘이에요.'], 2],
      ['section:b2', 'section', 'Book', 'Chapter 2', ['b2'], '2026-06-01T00:00:00.000Z', ['새 문장이에요.'], 2],
      ['section:b1', 'section', 'Book', 'Chapter 1', ['b1'], null, ['비가 와요.', '눈이 와요.'], 2],
      ['section:b4', 'section', 'Book', 'Chapter 4', ['b4'], null, ['건너뛴 장이에요.'], 1],
      ['section:v1', 'section', 'Videos', 'Episode 1', ['v1', 'v2'], null, ['일화 문장이에요.'], 1],
    ]);
  // Stamping the unit (every section of that name) clears it; a sentence
  // mined afterwards brings it back with that sentence alone.
  const stamp = '2026-06-10T00:00:00.000Z';
  const stamped = sections.map(s => (['v1', 'v2', 'b1'].includes(s.id) ? { ...s, sightingsReviewedAt: stamp } : s));
  check('units: a stamped unit is gone', S.sightingUnits({ sources, sections: stamped, sentenceRows: rows }).map(u => u.key), ['source:a', 'section:b2', 'section:b4']);
  const later = [...rows, row('나중에 캔 문장이에요.', 'Book', 'Chapter 1', '2026-06-11T00:00:00.000Z')];
  check('units: a sentence mined after the stamp is offered next time, alone',
    S.sightingUnits({ sources, sections: stamped, sentenceRows: later }).filter(u => u.key === 'section:b1').map(u => [u.sentences, u.total]), [[['나중에 캔 문장이에요.'], 3]]);
  check('units: a source finished as a whole offers its section-less sentences; its stamp works the same way',
    [S.sightingUnits({ sources: [{ ...sources[0], sectionOrder: [] }], sections: sections.filter(s => s.resourceId === 'b').map(s => ({ ...s, status: 'Done' })), sentenceRows: rows }).map(u => u.key),
      S.sightingUnits({ sources: [{ ...sources[1], sightingsReviewedAt: '2026-06-02T12:00:00.000Z' }], sections: [], sentenceRows: rows }).map(u => [u.key, u.sentences])],
    [['source:b', 'section:b1', 'section:b2', 'section:b3', 'section:b4'], [['source:a', ['기사 문장 둘이에요.']]]]);
  check('units: nothing in, nothing out', [S.sightingUnits({}), S.sightingUnits({ sources, sections, sentenceRows: [] })], [[], []]);
}

// ── What a review offers ──────────────────────────────────────
const entries = [
  { id: 'baram', glossaryTerm: '~는 바람에', entryNumber: 142, examples: '비가 오는 바람에 못 갔어요.' },
  { id: 'jamaja', glossaryTerm: '~자마자', entryNumber: 88 },
  { id: 'su', glossaryTerm: '~ㄹ/을 수 있다/없다', entryNumber: 106, sightingsOff: true },
  { id: 'sudo', glossaryTerm: '~ㄹ/을 수도 있다/없다', entryNumber: 107, sightingsOff: true },
  { id: 'eul', glossaryTerm: '~을/를', entryNumber: 115, sightingsOff: true },
  { id: 'myeonseo', glossaryTerm: '~(으)면서', entryNumber: 61, examples: 'a\nb\nc\nd\ne\nf' },
  { id: 'topic', glossaryTerm: '반말체', entryNumber: 4 },
  { id: 'kept', glossaryTerm: '~고 싶다', entryNumber: 110, sightingsOff: false, examples: '집에 가고 싶어요. I want to go home.' },
  { id: 'hinted', glossaryTerm: '~다(가) / ~았/었다(가)', patternHint: '~다가 / ~았/었다가', entryNumber: 38 },
];
const compiled = S.compileEntries(entries, analyse);
{
  const sentences = [
    '길이 막히는 바람에 회의에 늦었습니다.',
    '늦잠을 자는 바람에 버스를 놓쳤어.',
    '비가 오는 바람에 못 갔어요.',            // already this entry's example
    '집에 오자마자 잠들었다.',
    '집에  오자마자 잠들었다. ',               // the same sentence again
    '내일은 비가 올 수도 있어요.',             // only switched-off entries
    '그는 웃으면서 대답했다.',
    '집에 가고 싶어요.',                       // already an example, with a translation after it
    '빨리 집에 가고 싶다.',
    '학교에 가다가 친구를 만났다.',
    '바람이 많이 분다.',
    'no korean', '', null,
  ];
  const groups = S.sightingGroups({ entries, sentences, compiled, analyse });
  check('groups: entries with no examples first, then fewest, full ones last; candidates shortest first, with the matched words marked',
    groups.map(g => [g.entryId, g.number, g.lines.length, g.full, g.candidates.map(c => [c.sentence, c.marks.map(([a, b]) => c.sentence.slice(a, b))])]),
    [
      ['hinted', 38, 0, false, [['학교에 가다가 친구를 만났다.', ['가다가']]]],
      ['jamaja', 88, 0, false, [['집에 오자마자 잠들었다.', ['오자마자']]]],
      ['kept', 110, 1, false, [['빨리 집에 가고 싶다.', ['가고 싶다.']]]],
      ['baram', 142, 1, false, [['늦잠을 자는 바람에 버스를 놓쳤어.', ['자는 바람에']], ['길이 막히는 바람에 회의에 늦었습니다.', ['막히는 바람에']]]],
      ['myeonseo', 61, 6, true, [['그는 웃으면서 대답했다.', ['웃으면서']]]],
    ]);
  check('groups: how many sightings', S.countSightings(groups), 6);
  check('groups: for one entry alone (its own panel)', S.sightingGroups({ entries, sentences, compiled, analyse, opts: { only: 'baram' } }).map(g => [g.entryId, g.candidates.length]), [['baram', 2]]);
  // A switched-off longer entry keeps its sentence: it is not handed to
  // the shorter entry it contains.
  const on = entries.map(e => (e.id === 'su' ? { ...e, sightingsOff: false } : e));
  check('groups: most specific wins before switched-off entries are dropped',
    S.sightingGroups({ entries: on, sentences: ['내일은 비가 올 수도 있어요.', '저는 수영할 수 있어요.'], compiled, analyse }).map(g => [g.entryId, g.candidates.map(c => c.sentence)]),
    [['su', ['저는 수영할 수 있어요.']]]);
  // Where each sentence was mined travels with it; plain strings have none.
  const placed = S.sightingGroups({ entries, compiled, analyse, sentences: [
    { sentence: '집에 오자마자 잠들었다.', source: 'Book', section: 'Chapter 1' },
    { sentence: '집에 오자마자 잠들었다.', source: 'Later', section: 'Other' },      // a repeat: the first is kept
    { sentence: '문을 열자마자 나갔다.', source: 'Article' },
    '기사를 읽자마자 전화했다.', { sentence: '' }, { source: 'x' }, null,
  ] });
  check('groups: each candidate carries where it was mined',
    placed.map(g => [g.entryId, g.candidates.map(c => [c.sentence, c.source, c.section])]),
    [['jamaja', [['문을 열자마자 나갔다.', 'Article', null], ['집에 오자마자 잠들었다.', 'Book', 'Chapter 1'], ['기사를 읽자마자 전화했다.', null, null]]]]);
  // An entry's own panel: that entry alone, even when it is switched off.
  check('groups: an entry asked for by name is offered even when switched off; the most specific still wins',
    [S.sightingGroups({ entries, sentences: ['저는 수영할 수 있어요.', '내일은 비가 올 수도 있어요.'], compiled, analyse, opts: { only: 'su' } }).length,
      S.sightingGroups({ entries, sentences: ['저는 수영할 수 있어요.', '내일은 비가 올 수도 있어요.'], compiled, analyse, opts: { only: 'su', includeOff: true } }).map(g => [g.entryId, g.candidates.map(c => c.sentence)]),
      S.sightingGroups({ entries, sentences: ['밥 먹었어?'], compiled, analyse, opts: { only: 'topic', includeOff: true } })],
    [0, [['su', ['저는 수영할 수 있어요.']]], []]);
  check('groupOf: an entry and its candidates, shortest first, the input left alone',
    (() => { const c = [{ sentence: '긴 문장이에요.' }, { sentence: '짧아요.' }]; const g = S.groupOf({ id: 'x', examples: 'a\nb' }, c); return [g.entryId, g.term, g.number, g.lines, g.full, g.candidates.map(x => x.sentence), c[0].sentence, S.groupOf({ id: 'y' }).candidates]; })(),
    ['x', '(no term)', null, ['a', 'b'], false, ['짧아요.', '긴 문장이에요.'], '긴 문장이에요.', []]);
  check('groups: nothing in, nothing out', [S.sightingGroups({ entries, sentences: [], compiled, analyse }), S.sightingGroups({ entries: [], sentences, compiled: [], analyse }), S.countSightings(null)], [[], [], 0]);
  check('patterns are recompiled only when a title or hint changes',
    [S.patternSignature(entries) === S.patternSignature(entries.map(e => ({ ...e, examples: 'x', sightingsOff: true }))),
      S.patternSignature(entries) === S.patternSignature(entries.map(e => (e.id === 'baram' ? { ...e, patternHint: '~는 바람' } : e)))], [true, false]);
}

// ── Keeping sightings ─────────────────────────────────────────
{
  const from = { source: 'Book', section: 'Chapter 1' };
  const k = (entry, choices) => { const r = S.keepSightings(entry, choices); return [r.examples, r.exampleSources, r.changed, r.added, r.replaced, r.refused]; };
  check('keep: added to an entry with no examples', k({}, [{ sentence: ' 집에  오자마자 잠들었다. ', ...from }]),
    ['집에 오자마자 잠들었다.', [{ text: '집에 오자마자 잠들었다.', ...from }], true, ['집에 오자마자 잠들었다.'], [], []]);
  check('keep: added after the lines already there; those lines, their order and blank lines untouched; trailing blanks trimmed',
    k({ examples: '첫째 줄.\n\n  둘째 줄. Second.\n\n' }, [{ sentence: '셋째 줄.', source: 'Article' }]),
    ['첫째 줄.\n\n  둘째 줄. Second.\n셋째 줄.', [{ text: '셋째 줄.', source: 'Article', section: null }], true, ['셋째 줄.'], [], []]);
  check('keep: replacing puts the sighting in the old line\'s place and drops the old line\'s record',
    k({ examples: '하나.\n둘.\n셋.', exampleSources: [{ text: '둘.', source: 'Old', section: 'S' }, { text: '셋.', source: 'Old', section: null }] }, [{ sentence: '새 문장.', replace: '둘.', ...from }]),
    ['하나.\n새 문장.\n셋.', [{ text: '셋.', source: 'Old', section: null }, { text: '새 문장.', ...from }], true, [], [{ sentence: '새 문장.', was: '둘.' }], []]);
  const six = { examples: 'a\nb\nc\nd\ne\nf' };
  check('keep: a full entry takes a replacement but not an addition',
    k(six, [{ sentence: '더하기.', ...from }, { sentence: '바꾸기.', replace: 'c', ...from }]),
    ['a\nb\n바꾸기.\nd\ne\nf', [{ text: '바꾸기.', ...from }], true, [], [{ sentence: '바꾸기.', was: 'c' }], [{ sentence: '더하기.', why: 'the entry is full' }]]);
  check('keep: additions stop at six', (() => { const r = S.keepSightings({ examples: 'a\nb\nc\nd' }, ['일.', '이.', '삼.'].map(sentence => ({ sentence, ...from }))); return [r.examples, r.added, r.refused]; })(),
    ['a\nb\nc\nd\n일.\n이.', ['일.', '이.'], [{ sentence: '삼.', why: 'the entry is full' }]]);
  check('keep: an entry already over six is left as it is except for a replacement',
    (() => { const r = S.keepSightings({ examples: 'a\nb\nc\nd\ne\nf\ng\nh' }, [{ sentence: '새.', replace: 'h', ...from }]); return [r.examples, S.exampleLines({ examples: r.examples }).length]; })(), ['a\nb\nc\nd\ne\nf\ng\n새.', 8]);
  check('keep: not twice, and not in place of a line that is gone',
    k({ examples: '하나.' }, [{ sentence: '하나.', ...from }, { sentence: '둘.', replace: '없는 줄.', ...from }, { sentence: '', ...from }, null]),
    ['하나.', [], false, [], [], [{ sentence: '하나.', why: 'already an example' }, { sentence: '둘.', why: 'the example to replace is gone' }]]);
  check('keep: a sighting can take the place of one added a moment before',
    k({ examples: '하나.' }, [{ sentence: '둘.', ...from }, { sentence: '셋.', replace: '둘.', source: 'Article' }]),
    ['하나.\n셋.', [{ text: '셋.', source: 'Article', section: null }], true, ['둘.'], [{ sentence: '셋.', was: '둘.' }], []]);
  check('keep: records for lines edited away by hand are dropped, the rest kept; nothing is ever undefined',
    (() => { const r = S.keepSightings({ examples: '남은 줄.', exampleSources: [{ text: '고친 줄.', source: 'Old' }, { text: '남은 줄.', source: 'Old' }, null, 'junk'] }, [{ sentence: '새.' }]);
      return [r.exampleSources, JSON.stringify(r).includes('undefined'), Object.values(r.exampleSources[1]).includes(undefined)]; })(),
    [[{ text: '남은 줄.', source: 'Old', section: null }, { text: '새.', source: null, section: null }], false, false]);
  check('keep: no choices, no change', k({ examples: 'a\nb', exampleSources: [{ text: 'a', source: 'S', section: null }] }, []), ['a\nb', [{ text: 'a', source: 'S', section: null }], false, [], [], []]);

  const e = { examples: '하나.\n둘.', exampleSources: [{ text: '하나.', source: 'Book', section: 'Chapter 1' }, { text: '둘.', source: 'Article', section: null }, { text: '셋.', source: null }] };
  check('origin: the label beside an example; none for a line written by hand',
    [S.exampleOrigin(e, ' 하나. '), S.exampleOrigin(e, '둘.'), S.exampleOrigin(e, '셋.'), S.exampleOrigin(e, '넷.'), S.exampleOrigin({}, '하나.'), S.exampleOrigin({ exampleSources: 'bad' }, '하나.')],
    ['Book · Chapter 1', 'Article', '', '', '', '']);
  check('limits', [S.MAX_EXAMPLES, S.PER_ENTRY], [6, 3]);
}

// ── Everything mined, and the Library's marks ─────────────────
{
  const rows = [
    { sentence: '같은 문장이에요.', source: 'Later', section: 'B', ts: '2026-06-05T00:00:00.000Z' },
    { sentence: ' 같은  문장이에요. ', source: 'First', section: 'A', ts: '2026-06-01T00:00:00.000Z' },
    { sentence: '장이 없어요.', source: 'Article', section: '', ts: '2026-06-02T00:00:00.000Z' },
    { sentence: '숫자 장이에요.', source: 'Book', section: 7, ts: '2026-06-02T00:00:00.000Z' },
    { sentence: '아무것도 없어요.' },
    { sentence: 'No Korean', source: 'Book' }, { source: 'Book' }, null,
  ];
  check('mined: each different sentence once, with where it was first mined; finished or reviewed makes no difference',
    S.minedSentences(rows), [
      { sentence: '같은 문장이에요.', source: 'First', section: 'A' },
      { sentence: '장이 없어요.', source: 'Article', section: null },
      { sentence: '숫자 장이에요.', source: 'Book', section: '7' },
      { sentence: '아무것도 없어요.', source: null, section: null },
    ]);
  check('mined: nothing in, nothing out', [S.minedSentences(), S.minedSentences([])], [[], []]);
  check('marks: which unit each section and each source belongs to',
    S.sightingMarks([
      { key: 'source:a', kind: 'source', sourceId: 'a', sectionIds: [] },
      { key: 'section:v1', kind: 'section', sourceId: 'v', sectionIds: ['v1', 'v2'] },
      { key: 'section:b1', kind: 'section', sourceId: 'b', sectionIds: ['b1'] },
    ]), { bySection: { v1: 'section:v1', v2: 'section:v1', b1: 'section:b1' }, bySource: { a: 'source:a' } });
  check('marks: nothing in, nothing out', [S.sightingMarks(), S.sightingMarks([])], [{ bySection: {}, bySource: {} }, { bySection: {}, bySource: {} }]);
}

console.log(`grammar-sightings-golden: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
