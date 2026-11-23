// tests/grammar-patterns-golden.mjs
// Golden test for the grammar pattern recogniser (audit G3):
//   src/utils/grammarPatterns.js       reading titles, skeletons, finding
//   src/utils/grammarPatternCheck.js   the Pattern check's report
// run with the real analyser kept in src/vendor/garu-ko.
//
// The counts below are what THIS version of the analyser finds. If the
// analyser's files are ever replaced, this test shows what changed: read
// the differences before accepting them.
//
// Fixtures: tests/fixtures/grammar-patterns.json (360 Grammar Index titles
// and 79 sentences written for the test; no study data).
//
// Run from the repo root:   node tests/grammar-patterns-golden.mjs   (or: npm test)
// Plain Node. Exits 1 on any failure.

import { readFileSync } from 'node:fs';
import { loadAnalyser } from './load-analyser.mjs';

const G = await import('../src/utils/grammarPatterns.js');
const { patternCheckReport, commonEntries, commonMinimum, checkEntry, COMMON_SHARE } = await import('../src/utils/grammarPatternCheck.js');
const fx = JSON.parse(readFileSync(new URL('./fixtures/grammar-patterns.json', import.meta.url), 'utf8'));
const analyse = await loadAnalyser();

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`);
}

// ── The analyser itself ───────────────────────────────────────
check('analyser: morphemes with tags and the word each belongs to',
  analyse('비가 올 수 있어요.').map(t => `${t.text}/${t.pos}@${t.start}-${t.end}`),
  ['비/NNG@0-2', '가/JKS@0-2', '오/VV@3-4', 'ㄹ/ETM@3-4', '수/NNB@5-6', '있/VA@7-11', '어요/EF@7-11', './SF@7-11']);
check('analyser: nothing in, nothing out', analyse(''), []);

// ── Reading a title ───────────────────────────────────────────
check('alternatives: split on " / " and ", "; notes and stand-alone optional words dropped', [
  G.patternAlternatives('~기 때문에 / N 때문에'), G.patternAlternatives('~는지, ~ㄴ/은지, ~ㄹ/을지'),
  G.patternAlternatives('~(으)러 (가다/오다)'), G.patternAlternatives('~ㄴ/은 지 (time elapsed)'), G.patternAlternatives('(과연) ~ㄹ/을까?'),
], [['~기 때문에', 'N 때문에'], ['~는지', '~ㄴ/은지', '~ㄹ/을지'], ['~(으)러'], ['~ㄴ/은 지'], ['~ㄹ/을까']]);
check('alternatives: a topic has no form', [G.patternAlternatives('반말체'), G.patternAlternatives('Loan Words/Konglish'), G.patternAlternatives(''), G.patternAlternatives(null)], [null, null, null, null]);
check('expand: optional parts and alternatives', [
  G.expandToken('(으)면'), G.expandToken('ㄴ/은/는데도'), G.expandToken('느라(고)'), G.expandToken('있다/없다'), G.expandToken('적(이)'), G.expandToken('(이)나'),
], [['으면', '면'], ['ㄴ데도', '은데도', '는데도'], ['느라', '느라고'], ['있다', '없다'], ['적', '적이'], ['이나', '나']]);
const readings = (alt) => G.patternReadings(alt).map(r => r.map(t => `${t.kind}:${t.text || ''}`).join(' '));
check('readings: joined endings, words of their own, and a place where something stands', [
  readings('~ㄹ/을 수 있다/없다'), readings('N 때문에'), readings('아무리 ~아/어도'),
], [['attach:ㄹ word:수 word:있다', 'attach:ㄹ word:수 word:없다', 'attach:을 word:수 word:있다', 'attach:을 word:수 word:없다'], ['slot: word:때문에'], ['word:아무리 attach:아도', 'word:아무리 attach:어도']]);

// ── Skeletons ─────────────────────────────────────────────────
const one = (t) => { const [c] = G.compilePatterns([{ id: t, pattern: t }], analyse); return [c.kind, c.skeletons.map(s => s.text), c.surface.length]; };
check('skeleton: ㄹ and 을 are one form; the dictionary 다 is not part of it', one('~ㄹ/을 수 있다/없다'), ['specific', ['ㄹ/E+수/B+있/V', 'ㄹ/E+수/B+없/V'], 0]);
check('skeleton: a noun reading leaves a place for the noun', one('~기 때문에 / N 때문에'), ['specific', ['기/E+때문/B+에/J', '… 때문/B+에/J'], 1]);
check('skeleton: an optional particle gives both readings', one('~ㄴ/은 적(이) 있다/없다'), ['specific', ['ㄴ/E+적/B+가/J+있/V', 'ㄴ/E+적/B+가/J+없/V', 'ㄴ/E+적/B+있/V', 'ㄴ/E+적/B+없/V'], 4]);
check('skeleton: a repeated ending has a gap between', one('~든지 ~든지 / ~든 ~든'), ['specific', ['든지/E … 든지/E', '든/E … 든/E'], 0]);
check('skeleton: one morpheme is "single", however long it is written', [one('~자마자'), one('~게')], [['single', ['자마자/E'], 0], ['single', ['게/E'], 0]]);
check('skeleton: 다 as the pattern itself is kept; longest readings first', one('~다(가) / ~았/었다(가)'), ['specific', ['었/E+다/E', '었/E+다가/E', '다/E', '다가/E'], 0]);
check('skeleton: a mixed entry has both kinds of reading', one('못 / ~지 못하다'), ['specific', ['지/E+못하/V', '못/M'], 1]);
check('skeleton: a topic has none', one('반말체'), ['topic', [], 0]);

const compiled = G.compilePatterns(fx.terms.map(t => ({ id: t, pattern: t })), analyse);
const kinds = {}; for (const c of compiled) kinds[c.kind] = (kinds[c.kind] || 0) + 1;
check('all 360 titles: every pattern title can be read', kinds, { specific: 240, single: 98, topic: 22 });

// ── Finding ───────────────────────────────────────────────────
const show = (s, opts) => G.findPatterns(s, compiled, analyse, opts).map(h => [h.id, h.by, s.slice(h.from, h.to), h.size]);
check('most specific wins: ~수도 있다, not also ~수 있다', show('내일은 비가 올 수도 있어요.'), [['~ㄹ/을 수도 있다/없다', 'morphemes', '올 수도 있어요.', 4]]);
check('most specific wins: ~고 싶어 하다, not also ~고 싶다 or ~아/어하다', show('동생은 강아지를 키우고 싶어 해요.'), [['~고 싶어 하다', 'morphemes', '키우고 싶어 해요.', 4]]);
check('two patterns on different stretches are both kept, each with its own words',
  show('제주도에 가 본 적이 있어요.'), [['~아/어 보다', 'morphemes', '가 본', 2], ['~ㄴ/은 적(이) 있다/없다', 'morphemes', '본 적이 있어요.', 4]]);
check('a neighbour is not swallowed: ~ㄹ게요 after ~아/어 오다 (asked for by id)',
  show('시장에 가는 김에 과일도 사 올게요.', { single: new Set(['~ㄹ/을게(요)']) }),
  [['~는 김에', 'morphemes', '가는 김에', 3], ['~ㄹ/을게(요)', 'morphemes', '올게요.', 1], ['~아/어 오다', 'morphemes', '사 올게요.', 2]]);
check('second opinion: the analyser misreads 한, the written form still finds ~ㄴ/은 이상',
  show('약속을 한 이상 꼭 지켜야 해요.'), [['~아/어야 하다/되다 / ~았/었어야 하다/되다', 'morphemes', '지켜야 해요.', 2], ['~ㄴ/은 이상', 'surface', '한 이상', 0]]);
check('no Korean, nothing, null', [G.findPatterns('Hello there.', compiled, analyse), G.findPatterns('', compiled, analyse), G.findPatterns(null, compiled, analyse)], [[], [], []]);

// Found by running the Pattern check on the real Grammar Index (Nov 13,
// 2026). The sentences here are written for the test.
{
  const found = (title, s, opts = { single: 'all' }) => G.findPatterns(s, G.compilePatterns([{ id: title, pattern: title }], analyse), analyse, opts).length > 0;
  check('거 is 것', found('~ㄴ/은/는/ㄹ/을 것(거)', '책상 위에 있는 거 봤어요?'), true);
  // LM2 (Nov 2026): 깨나 is a particle the analyser doesn't know. It comes
  // back inside one noun (책깨나) or as noun + the verb 깨다 (친구깨나).
  check('깨나: the title reads as the particle, not the verb 깨다', one('N깨나'), ['single', ['깨나/J'], 0]);
  check('깨나: found both ways the analyser splits it; the verb and 어깨나 are not', [
    found('N깨나', '그는 힘깨나 쓴다.'), found('N깨나', '책깨나 읽었다.'), found('N깨나', '친구깨나 있다.'),
    found('N깨나', '잠이 깨나 봐요.'), found('N깨나', '어깨나 허리가 아프다.'),
  ], [true, true, true, false, false]);
  check('adjectives take 다 where verbs take ㄴ/는다: ~다고, ~다니까', [
    found('~ㄴ/는다고, ~았/었다고, ~다고 했다/그랬다', '친구가 바쁘다고 해서 못 만났어요.'),
    found('~ㄴ/는다니까, ~았/었다니까, ~자니까, ~(으)라니까, ~(이)라니까', '지금은 바쁘다니까.'),
  ], [true, true]);
  check('a bracketed form written as a pattern is another reading', [
    G.patternAlternatives('~지 않아도 되다 (안 V아/어도 되다)'), found('~지 않아도 되다 (안 V아/어도 되다)', '오늘은 안 가도 돼요.'),
    G.patternAlternatives('~나 보다 / ~ㄴ/은가 보다 (~았/었나 보다)'),
  ], [['~지 않아도 되다', '안 V아/어도 되다'], true, ['~나 보다', '~ㄴ/은가 보다', '~았/었나 보다']]);
  check('포함하다/되다 is 포함하다 and 포함되다, never a bare 되다', [
    G.expandToken('포함하다/되다'), G.expandToken('하다/되다'),
    found('포함하다/되다, 제외하다/되다', '세금이 포함된 가격이에요.'), found('포함하다/되다, 제외하다/되다', '삼 년이 됐어요.'),
  ], [['포함하다', '포함되다'], ['하다', '되다'], true, false]);
  check('a suffix joins a noun, not a verb: ~답다 is read as the suffix', one('~답다'), ['single', ['답/X'], 0]);
  check('a suffix inside a word the analyser keeps whole: 갑작스럽다', [found('~스럽다', '갑작스러운 소식에 놀랐다.'), found('~답다', '어른다운 행동을 했다.')], [true, true]);
  check('an auxiliary inside a word the analyser keeps whole: 좋아하다, 쉬워지다; but 가지다 is not ~아/어지다', [
    found('~아/어하다 / ~아/어하지 말다', '동생이 강아지를 좋아했다.'), found('~아/어지다', '한국어가 점점 쉬워지고 있어요.'), found('~아/어지다', '가방을 가지고 왔어요.'),
  ], [true, true, false]);
}

// Look-alikes: the same letters, not the pattern. Checked with one-morpheme
// readings on, which is where a surface match would be fooled.
const TRAPS = [
  ['가게에서 과일을 샀어요.', '~게'], ['친구와 이야기를 했어요.', '~기 (nominalization)'], ['그 아이는 수를 잘 세요.', '~ㄹ/을 수 있다/없다'],
  ['바람이 많이 불어요.', '~는 바람에'], ['길에서 선생님을 만났어요.', '~는 길(에) / ~는 길이다'], ['저는 고기를 좋아해요.', '~기 (nominalization)'],
  ['지난 주말에 편지를 썼어요.', '~ㄴ/은/는 편이다'], ['그 사람은 척추를 다쳤어요.', '~ㄴ/은/는 척하다'], ['김에 밥을 싸서 먹었어요.', '~는 김에'],
];
check('traps: every look-alike title is in the list', TRAPS.every(([, t]) => fx.terms.includes(t)), true);
check('traps: none is taken for its pattern', TRAPS.filter(([s, t]) => G.findPatterns(s, compiled, analyse, { single: 'all' }).some(h => h.id === t)).map(([s]) => s), []);

// The 79 sentences, each written to show the titles listed with it.
function sweep(opts) {
  let found = 0; const missed = [], extra = [], bySurface = [];
  fx.sentences.forEach(([s, gold], i) => {
    const hits = G.findPatterns(s, compiled, analyse, opts);
    for (const g of gold) { const h = hits.find(x => x.id === g); if (!h) missed.push(`${i}:${g}`); else { found++; if (h.by === 'surface') bySurface.push(`${i}:${g}`); } }
    for (const h of hits) if (!gold.includes(h.id)) extra.push(`${i}:${h.id}`);
  });
  return { found, missed, extra, bySurface };
}
check('fixture: 79 sentences, 90 labels', [fx.sentences.length, fx.sentences.reduce((n, [, g]) => n + g.length, 0)], [79, 90]);
{
  const d = sweep({});
  check('by default (readings of two or more morphemes): 63 of 90 labels', [d.found, d.missed.length], [63, 27]);
  // Ten matches beyond the labels. Eight are real (될 거예요 is ~ㄹ 것(거),
  // 좋아하다 is ~아/어하다, 듣기는 쉬운 is ~기 쉽다, 아무 말도). Two are the
  // known loose ends: ~기는(요) on 듣기는 (a shared form), and ~아/어지다 on
  // 넘어지다, a word of its own that only looks built that way.
  check('by default: the matches beyond the labels', d.extra,
    ['14:~아/어지다', '30:~기 쉽다/어렵다', '30:~기는(요) / ~긴(요)', '52:~ㄴ/은/는/ㄹ/을 것(거)', '53:~아/어하다 / ~아/어하지 말다', '57:아무 N(이)나 / 아무 N도', '59:~ㄴ/은/는/ㄹ/을 것(거)', '60:~ㄴ/은/는/ㄹ/을 것(거)', '72:~아/어하다 / ~아/어하지 말다', '78:~ㄴ/은/는/ㄹ/을 것(거)']);
  check('by default: three found by the written form only', d.bySurface, ['58:~ㄴ/은 이상', '59:~ㄹ/을 바에(야)', '65:~ㄹ/을 정도로 / ~ㄹ/을 정도이다']);
}
{
  const a = sweep({ single: 'all' });
  check('with one-morpheme readings: 86 of 90 labels', a.found, 86);
  // Three are the most-specific rule at work (아무리 ~어도, ~어도 되다,
  // ~어야 하다 win over the bare ending); one is a real miss (알게 될
  // misread by the analyser).
  check('with one-morpheme readings: the four not found', a.missed, ['18:~아/어도', '26:~아/어도', '27:~아/어야', '78:~게 되다']);
  check('with one-morpheme readings: particles and endings fire everywhere', a.extra.length, 199);
}

// ── The Pattern check's report ────────────────────────────────
{
  const entries = [
    { id: 'e1', glossaryTerm: '~ㄹ/을 수 있다/없다', entryNumber: 1, examples: '저는 수영할 수 있어요. I can swim.\n내일은 갈 수 없어요.\n\nEnglish only line' },
    { id: 'e2', glossaryTerm: '~는 바람에', entryNumber: 2, examples: '비가 오는 바람에 못 갔어요.\n바람이 많이 불어요.' },
    { id: 'e3', glossaryTerm: '~자마자', entryNumber: 3, examples: '' },
    { id: 'e4', glossaryTerm: '반말체', entryNumber: 4, examples: '밥 먹었어?' },
    { id: 'e5', glossaryTerm: '~기는(요)', entryNumber: 5, examples: '잘하기는요.' },
    { id: 'e6', glossaryTerm: 'Odd title', patternHint: '~ㄴ/은 지', entryNumber: 6, examples: '한국에 온 지 삼 년이 됐어요.' },
    { id: 'e7', glossaryTerm: '~ㄹ/을 수 있다', entryNumber: 7, examples: '할 수 있어요.' },
    { id: 'e8', glossaryTerm: '~을/를', entryNumber: 8, examples: '밥을 먹어요.' },
  ];
  const sentences = ['저는 수영할 수 있어요.', '저는 수영할 수 있어요.', '  ', 'no korean', '비가 오는 바람에 밥을 못 먹었어요.', '집에 오자마자 밥을 먹었어요.', null];
  const r = patternCheckReport(entries, sentences, analyse);
  check('report: kinds (a hint stands in for a title that is not a pattern)', [r.counts, r.unread], [{ entries: 8, topic: 1, single: 2, specific: 5, unread: 0 }, []]);
  check('report: own examples: lines without Korean are not counted; a topic and an entry without examples are not checked',
    [r.own.withExamples, r.own.withoutExamples, r.own.lines, r.own.linesFound, r.own.linesBySurfaceOnly], [6, 1, 8, 7, 0]);
  check('report: found in every line', r.own.all.map(x => x.id), ['e1', 'e5', 'e6', 'e7', 'e8']);
  check('report: found in some, with the line that was missed', r.own.some.map(x => [x.id, x.found, x.lines, x.missed]), [['e2', 1, 2, ['바람이 많이 불어요.']]]);
  check('report: found in none', r.own.none, []);
  check('report: each row says what it is', r.own.all.find(x => x.id === 'e6'),
    { id: 'e6', term: 'Odd title', number: 6, kind: 'specific', hinted: true, off: false, kept: false, lines: 1, found: 1, missed: [], reads: ['ㄴ/E+지/B'] });
  check('report: mined sentences are counted once each, blanks and non-Korean left out', [r.mined.sentences, r.mined.withALongerPattern, r.mined.neverSeen], [3, 2, 2]);
  check('report: how often each entry is seen (by any reading, and by its longer readings alone), most frequent first',
    r.mined.frequency.map(f => [f.id, f.sentences, f.longer, f.kind]),
    [['e8', 2, 0, 'single'], ['e2', 1, 1, 'specific'], ['e7', 1, 1, 'specific'], ['e1', 1, 1, 'specific'], ['e3', 1, 0, 'single'], ['e5', 0, 0, 'specific'], ['e6', 0, 0, 'specific']]);

  const same = patternCheckReport([{ id: 'a', glossaryTerm: '~는 바람에' }, { id: 'b', glossaryTerm: '~는 바람에', patternHint: '' }, { id: 'c', glossaryTerm: '~는 김에' }], [], analyse);
  check('report: entries whose patterns read alike are grouped', same.sharedForms.map(g => [g.reads, g.entries.map(e => e.id)]), [['는/E+바람/B+에/J', ['a', 'b']]]);
  const none = patternCheckReport([{ id: 'n', glossaryTerm: '~는 바람에', entryNumber: 9, examples: '바람이 불어요.' }], null, analyse);
  check('report: an entry not found in any example shows how it was read', none.own.none.map(x => [x.id, x.reads, x.missed]), [['n', ['는/E+바람/B+에/J'], ['바람이 불어요.']]]);
  check('report: no entries, no sentences', (() => { const e = patternCheckReport([], [], analyse); return [e.counts, e.own.lines, e.mined.sentences, e.sharedForms]; })(), [{ entries: 0, topic: 0, single: 0, specific: 0, unread: 0 }, 0, 0, []]);
}

// ── Hints, the sightings switch and the common-entry rule (G3b) ──
{
  check('entryPattern: the hint when there is one, else the title; blanks are no hint',
    [G.entryPattern({ glossaryTerm: ' ~고 ', patternHint: '  ' }), G.entryPattern({ glossaryTerm: '~고', patternHint: ' ~고서 ' }), G.entryPattern({}), G.entryPattern(null)],
    ['~고', '~고서', '', '']);

  const one = (entry, typed) => { const r = checkEntry(entry, analyse, typed); return [r.kind, r.reads, r.writtenForm, r.found, r.lines, r.missed]; };
  check('checkEntry: how an entry is read, in plain form, and its own examples (lines without Korean not counted)',
    one({ id: 'e1', glossaryTerm: '~ㄹ/을 수 있다/없다', examples: '저는 수영할 수 있어요. I can swim.\n내일은 갈 수 없어요.\n\nEnglish only' }),
    ['specific', ['ㄹ + 수 + 있', 'ㄹ + 수 + 없'], false, 2, 2, []]);
  check('checkEntry: the lines it is not found in are listed',
    one({ id: 'e2', glossaryTerm: '~는 바람에', examples: '비가 오는 바람에 못 갔어요.\n바람이 많이 불어요.' }),
    ['specific', ['는 + 바람 + 에'], true, 1, 2, ['바람이 많이 불어요.']]);
  check('checkEntry: a gap between parts shows as …', one({ id: 'x', glossaryTerm: '~든지 ~든지' })[1], ['든지 … 든지']);
  check('checkEntry: a topic has nothing to find', one({ id: 'e4', glossaryTerm: '반말체', examples: '밥 먹었어?' }), ['topic', [], false, 0, 1, ['밥 먹었어?']]);
  check('checkEntry: a typed hint is tried before it is saved', one({ id: 'e4', glossaryTerm: '반말체', examples: '밥 먹었어?' }, '~아/어'), ['single', ['어'], false, 1, 1, []]);
  check('checkEntry: the saved hint is used when nothing is passed', one({ id: 'e6', glossaryTerm: 'Odd title', patternHint: '~ㄴ/은 지', examples: '한국에 온 지 삼 년이 됐어요.' }), ['specific', ['ㄴ + 지'], false, 1, 1, []]);
  check('checkEntry: a hint cleared in the box falls back to the title, not to the saved hint',
    one({ id: 'e6', glossaryTerm: '~는 바람에', patternHint: '~ㄴ/은 지', examples: '한국에 온 지 삼 년이 됐어요.' }, '  ')[1], ['는 + 바람 + 에']);
  // The two hints a second Pattern check run called for: each drops the
  // bare one-part form (다, 고) that made the entry fire in a third or a
  // tenth of the sentences.
  check('checkEntry: ~다(가) as titled reads the bare 다 too', one({ id: 'e9', glossaryTerm: '~다(가) / ~았/었다(가)' })[1], ['었 + 다', '었 + 다가', '다', '다가']);
  check('checkEntry: hinted to ~다가, a plain declarative no longer counts',
    one({ id: 'e9', glossaryTerm: '~다(가) / ~았/었다(가)', examples: '학교에 가다가 친구를 만났어요.\n밥을 먹는다.' }, '~다가 / ~았/었다가'),
    ['specific', ['었 + 다가', '다가'], false, 1, 2, ['밥을 먹는다.']]);
  check('checkEntry: V고 나서 hinted to drop the bare 고',
    one({ id: 'e10', glossaryTerm: 'V고 나서 / V고(서)', examples: '밥을 먹고 나서 잤어요.\n밥을 먹고 잤어요.\n밥을 먹고서 잤어요.' }, 'V고 나서 / V고서'),
    ['specific', ['고 + 나 + 어서', '고서'], true, 2, 3, ['밥을 먹고 잤어요.']]);
  check('checkEntry: nothing in', one({}), ['topic', [], false, 0, 0, []]);

  // The switch has three states: absent (on, nobody chose), true (off),
  // false (on, chosen in the entry's panel).
  const entries = [
    { id: 'p', glossaryTerm: '~을/를', entryNumber: 1 },
    { id: 'q', glossaryTerm: '~에', entryNumber: 2, sightingsOff: true },
    { id: 'k', glossaryTerm: '~이/가', entryNumber: 3, sightingsOff: false },
    { id: 'r', glossaryTerm: '~자마자', entryNumber: 4 },
    { id: 's', glossaryTerm: '~는 바람에', entryNumber: 5 },
  ];
  const sentences = ['밥을 먹었어요.', '책을 읽어요.', '집에 가요.', '학교에 가요.', '비가 와요.', '눈이 와요.', '집에 오자마자 잤어요.', '물을 마셔요.'];
  const r = patternCheckReport(entries, sentences, analyse);
  check('report: each row carries the state of its switch',
    r.mined.frequency.map(f => [f.id, f.sentences, f.off, f.kept]),
    [['q', 3, true, false], ['p', 3, false, false], ['k', 2, false, true], ['r', 1, false, false], ['s', 0, false, false]]);
  check('common entries: the cut-off is 3% of the mined sentences', COMMON_SHARE, 0.03);
  check('common entries: over the share, still on, and never switched by hand', commonEntries(r).map(f => f.id), ['p', 'r']);
  check('common entries: the share is strictly "more than"', [commonEntries(r, 3 / 8).map(f => f.id), commonEntries(r, 0.3).map(f => f.id), commonEntries(r, 1 / 8).map(f => f.id)], [[], ['p'], ['p']]);
  check('common entries: the rule in whole sentences (of 564: 17 or more; exactly 3% is not "more than")',
    [commonMinimum(564), commonMinimum(79), commonMinimum(100), commonMinimum(8, 3 / 8), commonMinimum(8, 0.3), commonMinimum(10), commonMinimum(1), commonMinimum(0), commonMinimum(undefined)],
    [17, 3, 4, 4, 3, 1, 1, 0, 0]);
  check('common entries: the whole-sentence rule and the list agree',
    [1, 2, 3, 5, 8, 33, 34, 100, 564, 1000].every(total => { const n = commonMinimum(total); return n / total > COMMON_SHARE && (n === 1 || (n - 1) / total <= COMMON_SHARE); }), true);
  check('common entries: no mined sentences, nothing to switch off', [commonEntries(patternCheckReport(entries, [], analyse)), commonEntries(null)], [[], []]);
}

console.log(`grammar-patterns-golden: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
