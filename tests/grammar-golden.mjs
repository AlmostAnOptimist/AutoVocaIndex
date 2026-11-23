// tests/grammar-golden.mjs
// Golden test set for src/utils/grammarQuizEngine.js (Grammar Quiz G1+).
//
// Run from the repo root:   node tests/grammar-golden.mjs
//
// Plain Node, no bundler: the engine has no imports. Exits 1 on any failure,
// so it can gate a commit. When changing validation or scoring rules, add
// their cases here FIRST.

import {
  buildConceptIndex, resolveRef, formatCompactCorpus, formatConceptDetails,
  buildGenerationRequest, validateGeneratedQuestions,
  buildAssessmentRequest, alignAssessment, buildExplainRequest, alignExplanations,
  slimConcept, shuffled, COMPACT_COMPARE_CAP, DETAIL_EXPLANATION_CAP,
  questionsPerRequest, planGenerationChunks, mergeGeneratedChunks,
  planAssessmentChunks, mergeAssessmentChunks, CHUNK_THEMES,
  buildSessionSnapshot, parseSessionSnapshot, snapshotProgress, SESSION_MAX_AGE_DAYS,
  scoreTranslationQuiz, formatPoints, TRANSLATION_CREDIT,
  scoreSelectionQuiz, buildSelectionCorrectionRows, grammarResultMode,
  toSavedSelections, readSavedSelections,
  summarizeQuizConcepts, cardIdsForConcepts,
} from '../src/utils/grammarQuizEngine.js';

let pass = 0, fail = 0;
const group = (name) => console.log(`\n${name}`);
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '  -> ' + detail}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const seeded = (seed = 7) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

// ── Fixture corpus (shape written by GrammarIndexPage's corpus rebuild) ──
const LONG_EXPLANATION = 'Function: Declarative indirect quotation\n' + '가'.repeat(2500);
const CORPUS = [
  { id: 'aaaaaaaaaaaaaaaaaaa1', term: '~(ㄴ/는)다고 하다', level: 'confident', compareTo: '~냐고 하다, ~(으)라고 하다, ~자고 하다', explanation: LONG_EXPLANATION },
  { id: 'aaaaaaaaaaaaaaaaaaa2', term: '~냐고 하다', level: 'practicing', compareTo: '', explanation: 'Interrogative indirect quotation.' },
  { id: 'aaaaaaaaaaaaaaaaaaa3', term: '~(으)라고 하다', level: 'introduced', compareTo: 'x'.repeat(400), explanation: '' },
  { id: 'aaaaaaaaaaaaaaaaaaa4', term: '~자고 하다', level: '', compareTo: '', explanation: 'Propositive.' },
  { id: 'aaaaaaaaaaaaaaaaaaa5', term: '~더라고요', level: 'practicing', compareTo: '~던데요', explanation: 'Retrospective.' },
  { id: 'aaaaaaaaaaaaaaaaaaa6', term: '   ', level: 'introduced', compareTo: '', explanation: 'blank term — must be skipped' },
  { id: '', term: '~no id', level: '', compareTo: '', explanation: '' },
  null,
];
const [E1, E2, E3, E4, E5] = CORPUS;

group('concept index and refs');
{
  const idx = buildConceptIndex(CORPUS);
  check('skips null, id-less and blank-term entries', idx.entries.length === 5, `got ${idx.entries.length}`);
  check('refs in corpus order', idx.refOf.get(E1.id) === 'G1' && idx.refOf.get(E5.id) === 'G5');
  check('resolveRef exact', resolveRef(idx, 'G3')?.id === E3.id);
  check('resolveRef tolerant of case, spaces, "ID:" prefix', resolveRef(idx, ' g2 ')?.id === E2.id && resolveRef(idx, 'ID: G4')?.id === E4.id);
  check('resolveRef unknown / non-string -> null', resolveRef(idx, 'G99') === null && resolveRef(idx, 7) === null && resolveRef(idx, null) === null);
  check('empty / bad corpus', buildConceptIndex(undefined).entries.length === 0 && buildConceptIndex('x').entries.length === 0);
}

group('corpus formatting');
{
  const idx = buildConceptIndex(CORPUS);
  const compact = formatCompactCorpus(idx);
  const lines = compact.split('\n');
  check('one compact line per usable entry', lines.length === 5);
  check('compact line shape', lines[0] === 'G1 | ~(ㄴ/는)다고 하다 | Level: confident | Compare: ~냐고 하다, ~(으)라고 하다, ~자고 하다', lines[0]);
  check('compact omits empty level/compare', lines[3] === 'G4 | ~자고 하다');
  check('compact never includes explanations', !compact.includes('Declarative') && !compact.includes('Propositive'));
  check(`compare-to clipped to ${COMPACT_COMPARE_CAP}`, lines[2].split('Compare: ')[1].length === COMPACT_COMPARE_CAP && lines[2].endsWith('…'));
  const detail = formatConceptDetails(idx, [E1, E4]);
  check('details keep explanation line breaks', detail.startsWith('G1 | ~(ㄴ/는)다고 하다') && detail.includes('\nFunction: Declarative indirect quotation\n'));
  check(`detail explanation clipped to ${DETAIL_EXPLANATION_CAP}`, detail.split('\n\n')[0].split('\n').slice(1).join('\n').length === DETAIL_EXPLANATION_CAP);
  check('detail with explanation: head line then text', detail.split('\n\n')[1] === 'G4 | ~자고 하다\nPropositive.');
  check('detail without explanation is just the head line', formatConceptDetails(idx, [E3]) === formatCompactCorpus(idx, [E3]));
}

group('generation requests');
{
  const drill = buildGenerationRequest({ mode: 'translation', transMode: 'drill', length: 5, selectedIds: [E3.id, E1.id] }, CORPUS);
  check('drill uses first selected in corpus order', drill.drillConceptId === E1.id);
  check('drill payload: only that concept, no corpus', drill.payload.detailText.startsWith('G1 |') && !drill.payload.detailText.includes('G3') && !('corpusText' in drill.payload));
  check('drill with no concept -> error', buildGenerationRequest({ mode: 'translation', transMode: 'drill', selectedIds: [] }, CORPUS).error === 'need_one_concept');
  const sel = buildGenerationRequest({ mode: 'selection', length: 3, selectedIds: [E2.id, E5.id] }, CORPUS);
  check('selection payload: details of chosen only', sel.payload.detailText.includes('G2 |') && sel.payload.detailText.includes('G5 |') && !sel.payload.detailText.includes('G1 |'));
  check('selection with one concept -> error', buildGenerationRequest({ mode: 'selection', selectedIds: [E2.id] }, CORPUS).error === 'need_two_concepts');
  const broad = buildGenerationRequest({ mode: 'translation', transMode: 'broad', length: 4, choiceCount: 4, selectedIds: [] }, CORPUS);
  check('broad free: full compact corpus, no candidates', broad.payload.corpusText.split('\n').length === 5 && broad.payload.candidateText === '' && broad.payload.restrict === false);
  const broadR = buildGenerationRequest({ mode: 'translation', transMode: 'broad', choiceCount: 6, selectedIds: [E2.id] }, CORPUS);
  check('broad focus: 1 candidate with 6 choices is allowed', !broadR.error && broadR.payload.restrict === true && broadR.payload.candidateText === 'G2 | ~냐고 하다 | Level: practicing');
  check('length clamped 1..20', buildGenerationRequest({ mode: 'translation', transMode: 'broad', length: 99 }, CORPUS).payload.length === 20
    && buildGenerationRequest({ mode: 'translation', transMode: 'broad', length: 0 }, CORPUS).payload.length === 5);
  check('bad choiceCount falls back to 4', buildGenerationRequest({ mode: 'translation', transMode: 'broad', choiceCount: 5 }, CORPUS).payload.choiceCount === 4);
  check('empty corpus -> error', buildGenerationRequest({ mode: 'selection', selectedIds: [] }, []).error === 'empty_corpus');
}

group('validation: drill');
{
  const req = buildGenerationRequest({ mode: 'translation', transMode: 'drill', selectedIds: [E1.id] }, CORPUS);
  const { questions, dropped } = validateGeneratedQuestions(req, { questions: [
    { english: ' She said she was busy. ', context: 'Relaying news.' },
    { english: '', context: 'no sentence' },
    null,
  ] });
  check('keeps good, drops blank and null', questions.length === 1 && dropped === 2, `${questions.length}/${dropped}`);
  check('concept attached by the client, slim', eq(questions[0].correctConcept, { id: E1.id, term: E1.term, level: 'confident' }) && questions[0].correctConceptId === E1.id);
  check('no explanation carried into quiz state', !JSON.stringify(questions).includes('Declarative'));
  check('missing questions array -> empty', validateGeneratedQuestions(req, {}).questions.length === 0 && validateGeneratedQuestions(req, null).questions.length === 0);
}

group('validation: broad');
{
  const cfg = { mode: 'translation', transMode: 'broad', choiceCount: 3, selectedIds: [] };
  const req = buildGenerationRequest(cfg, CORPUS);
  const parsed = { questions: [
    { english: 'A', context: 'c', answerRef: 'G1', distractorRefs: ['G2', 'G3', 'G4', 'G5'] },  // too many distractors
    { english: 'B', context: 'c', answerRef: 'G99', distractorRefs: ['G2'] },                 // invented answer
    { english: 'C', context: 'c', answerRef: 'G2', distractorRefs: ['G2', 'G2', 'G1'] },      // answer repeated as distractor
    { english: 'D', context: 'c', answerRef: 'G3', distractorRefs: ['G77', 'G3'] },           // no usable distractor
    { english: 'E', context: 'c', answerRef: 'g4', distractorRefs: ['G5', 'nope'] },          // lowercase ref, junk ref
  ] };
  let allHaveAnswer = true, noDupes = true, noNulls = true;
  for (let s = 1; s <= 200; s++) {
    const { questions } = validateGeneratedQuestions(req, parsed, { config: cfg, rand: seeded(s) });
    for (const q of questions) {
      const ids = q.choices.map(c => c && c.id);
      if (!ids.includes(q.correctConceptId)) allHaveAnswer = false;
      if (new Set(ids).size !== ids.length) noDupes = false;
      if (ids.some(x => !x)) noNulls = false;
    }
  }
  check('answer is ALWAYS among the choices (200 shuffles)', allHaveAnswer);
  check('never duplicate choices', noDupes);
  check('never null choices', noNulls);
  const { questions, dropped } = validateGeneratedQuestions(req, parsed, { config: cfg, rand: seeded(3) });
  check('drops invented answer and no-distractor question', questions.length === 3 && dropped === 2, `${questions.length}/${dropped}`);
  check('extra distractors capped to choiceCount-1', questions[0].choices.length === 3);
  check('repeated answer ignored as distractor', questions[1].choices.length === 2 && eq(questions[1].choices.map(c => c.id).sort(), [E1.id, E2.id].sort()));
  check('lowercase ref accepted, junk skipped', questions[2].correctConceptId === E4.id && questions[2].choices.length === 2);
  const cfgR = { ...cfg, selectedIds: [E2.id, E4.id] };
  const reqR = buildGenerationRequest(cfgR, CORPUS);
  const r = validateGeneratedQuestions(reqR, { questions: [
    { english: 'in focus', context: '', answerRef: 'G2', distractorRefs: ['G1', 'G5'] },
    { english: 'outside focus', context: '', answerRef: 'G5', distractorRefs: ['G2'] },
  ] }, { config: cfgR });
  check('focus: answers must be in focus set, distractors may be any', r.questions.length === 1 && r.dropped === 1 && r.questions[0].choices.length === 3);
  check('choices are slim', !JSON.stringify(questions).includes('Declarative') && questions[0].choices.every(c => Object.keys(c).join() === 'id,term,level'));
}

group('validation: selection');
{
  const cfg = { mode: 'selection', selectedIds: [E2.id, E4.id] };
  const req = buildGenerationRequest(cfg, CORPUS);
  const { questions, dropped } = validateGeneratedQuestions(req, { questions: [
    { sentences: [{ text: '뭐 먹냐고 물었어요.', conceptRef: 'G2', correct: true }, { text: '같이 가자고 했어요.', conceptRef: 'G4', correct: false }] },
    { sentences: [{ text: 'all wrong 1', conceptRef: 'G2', correct: false }, { text: 'all wrong 2', conceptRef: 'G4', correct: false }] },
    { sentences: [{ text: 'only one valid', conceptRef: 'G2', correct: true }, { text: 'not selected concept', conceptRef: 'G1', correct: false }] },
    { sentences: [{ text: 'ok', conceptRef: 'G2', correct: true }, { text: 'bad flag', conceptRef: 'G4', correct: 'yes' }, { text: 'ok2', conceptRef: 'G4', correct: true }] },
  ] }, { config: cfg });
  check('drops all-false and under-2-sentence questions', questions.length === 2 && dropped === 2, `${questions.length}/${dropped}`);
  check('concept is the corpus term, plus conceptId', questions[0].sentences[0].concept === '~냐고 하다' && questions[0].sentences[1].conceptId === E4.id);
  check('non-boolean "correct" sentence removed', questions[1].sentences.length === 2);
}

group('assessment');
{
  const qs = [{ english: 'a', context: '', correctConcept: slimConcept(E1) }, { english: 'b' }, { english: 'c' }];
  const req = buildAssessmentRequest(qs, ['가', undefined]);
  check('items numbered from 1, blanks become ""', eq(req.items.map(i => [i.item, i.userKorean]), [[1, '가'], [2, ''], [3, '']]) && req.items[0].targetConcept === E1.term);
  const aligned = alignAssessment({ assessment: [
    { item: 3, verdict: 'X', grammar: 'g', vocabulary: 'v', completeness: 'c', corrected: '고친 문장' },
    { item: 1, verdict: 'O', grammar: 'g', vocabulary: 'v', completeness: 'c', corrected: '오타 고친 문장' },
    { item: 1, verdict: 'X', grammar: 'dup', vocabulary: '', completeness: '', corrected: '' },
    { item: 9, verdict: 'O' },
    { item: 2, verdict: 'maybe' },
  ] }, 3);
  check('matched by item number, not position', aligned[0]?.verdict === 'O' && aligned[2]?.verdict === 'X');
  check('first answer for an item wins', aligned[0].grammar === 'g');
  check('invalid verdict -> null slot', aligned[1] === null);
  // Oct 16 2026 (typo leniency): a typo or spacing slip no longer lowers the
  // verdict, so an O can carry the fixed sentence. Before that an O dropped it.
  check('O keeps a typo fix; X keeps its correction', aligned[0].corrected === '오타 고친 문장' && aligned[2].corrected === '고친 문장');
  check('O with no fix -> null', alignAssessment({ assessment: [{ item: 1, verdict: 'O', grammar: '', vocabulary: '', completeness: '', corrected: ' ' }] }, 1)[0].corrected === null);
  check('no undefined anywhere (Firestore-safe)', !JSON.stringify(aligned, (k, v) => (v === undefined ? '__UNDEF__' : v)).includes('__UNDEF__'));
  check('garbage response -> all null, right length', eq(alignAssessment(null, 2), [null, null]) && eq(alignAssessment({ assessment: 'x' }, 1), [null]));
}

group('explanations');
{
  const req = buildExplainRequest([{ text: 's1', concept: 'c', errorType: 'missed_correct' }, { text: 's2', concept: 'c', errorType: 'whatever' }]);
  check('numbered items, errorType normalized', req.items[0].item === 1 && req.items[1].errorType === 'selected_wrong');
  check('aligned by item', eq(alignExplanations({ explanations: [{ item: 2, text: ' two ' }, { item: 1, text: 'one' }, { item: 5, text: 'x' }] }, 2), ['one', 'two']));
  check('missing -> empty strings', eq(alignExplanations({}, 2), ['', '']));
}

group('shuffle');
{
  const base = [1, 2, 3, 4, 5];
  const s = shuffled(base, seeded(11));
  check('returns a permutation, input untouched', eq([...s].sort(), base) && eq(base, [1, 2, 3, 4, 5]));
}

group('G2: chunk planning');
{
  const mk = (cfg) => buildGenerationRequest(cfg, CORPUS);
  const broad = (n) => mk({ mode: 'translation', transMode: 'broad', length: n, choiceCount: 4, selectedIds: [] });
  check('10 questions -> one request, unchanged, no theme', (() => { const p = planGenerationChunks(broad(10)); return p.length === 1 && p[0] === broad(10).payload || (p.length === 1 && !('theme' in p[0]) && p[0].length === 10); })());
  const p20 = planGenerationChunks(broad(20), seeded(1));
  check('20 questions -> two requests of 10', eq(p20.map(p => p.length), [10, 10]));
  const p15 = planGenerationChunks(broad(15), seeded(1));
  check('15 questions -> 8 + 7', eq(p15.map(p => p.length), [8, 7]));
  check('chunks keep the same corpus and settings', p20.every(p => p.corpusText === broad(20).payload.corpusText && p.choiceCount === 4 && p.mode === 'broad'));
  check('each chunk gets a different whitelisted theme', p20[0].theme !== p20[1].theme && p20.every(p => CHUNK_THEMES.includes(p.theme)));
  const sel2 = mk({ mode: 'selection', length: 20, selectedIds: [E1.id, E2.id] });
  const sel5 = mk({ mode: 'selection', length: 20, selectedIds: [E1.id, E2.id, E3.id, E4.id, E5.id] });
  check('selection chunk size follows the sentence budget', questionsPerRequest(sel2) === 10 && questionsPerRequest(sel5) === 8);
  check('selection 20 x 5 concepts -> 3 requests (7+7+6)', eq(planGenerationChunks(sel5, seeded(2)).map(p => p.length), [7, 7, 6]));
  const drill = mk({ mode: 'translation', transMode: 'drill', length: 20, selectedIds: [E1.id] });
  check('drill 20 -> 2 requests', planGenerationChunks(drill, seeded(3)).length === 2);
}

group('G2: merging chunks');
{
  const q = (english) => ({ english, context: '', correctConceptId: 'x', correctConcept: { id: 'x', term: 't', level: '' }, choices: null });
  const merged = mergeGeneratedChunks([
    { questions: [q('She said she was busy.'), q('He asked where I live.')], dropped: 1 },
    { questions: [q('she said she was  busy'), q('They told us to wait.')], dropped: 2 },
    null,
  ]);
  check('duplicates across chunks removed (case/punctuation/spaces)', merged.questions.length === 3 && merged.duplicates === 1);
  check('dropped counts summed', merged.dropped === 3);
  check('order preserved', merged.questions.map(x => x.english)[2] === 'They told us to wait.');
  const s = (a, b) => ({ sentences: [{ text: a, concept: 'c', conceptId: 'x', correct: true }, { text: b, concept: 'c', conceptId: 'y', correct: false }] });
  check('selection duplicates keyed on all sentences', mergeGeneratedChunks([{ questions: [s('가', '나')] }, { questions: [s('가', '나'), s('가', '다')] }]).questions.length === 2);
}

group('G2: assessment chunks');
{
  const qs = Array.from({ length: 23 }, (_, i) => ({ english: `q${i + 1}` }));
  const req = buildAssessmentRequest(qs, []);
  const parts = planAssessmentChunks(req);
  check('23 items -> 8 + 8 + 7', eq(parts.map(p => p.items.length), [8, 8, 7]));
  check('item numbers stay global and contiguous', eq(parts.flatMap(p => p.items.map(i => i.item)), Array.from({ length: 23 }, (_, i) => i + 1)));
  check('10 items -> single request (same object)', planAssessmentChunks(buildAssessmentRequest(qs.slice(0, 10), [])).length === 1);
  const a = (item, verdict) => ({ item, verdict, grammar: '', vocabulary: '', completeness: '', corrected: verdict === 'O' ? '' : 'fix' });
  const merged = mergeAssessmentChunks([{ assessment: [a(2, 'X'), a(1, 'O')] }, { assessment: [a(3, '△')] }, { nope: 1 }], 3);
  check('merged by item number across chunks', merged.map(x => x?.verdict).join() === 'O,X,△');
}

group('G2: session snapshots');
{
  const now = new Date('2026-10-12T00:00:00Z');
  const tq = [{ english: 'a' }, { english: 'b' }, { english: 'c' }];
  const snap = buildSessionSnapshot({ kind: 'translation', config: { mode: 'translation', transMode: 'broad' }, questions: tq, idx: 1, translations: ['가', '', '다'], conceptChoices: ['id1', null, null] }, now);
  const back = parseSessionSnapshot(JSON.stringify(snap), now);
  check('translation snapshot round-trips', back && back.idx === 1 && eq(back.translations, ['가', '', '다']) && eq(back.conceptChoices, ['id1', null, null]) && back.phase === 'answering');
  check('progress counts answered translations', eq(snapshotProgress(back), { answered: 2, total: 3 }));
  check('assessing phase kept for translation', parseSessionSnapshot({ ...snap, phase: 'assessing' }, now)?.phase === 'assessing');
  const later = new Date(now.getTime() + (SESSION_MAX_AGE_DAYS * 86400000) + 1000);
  check(`older than ${SESSION_MAX_AGE_DAYS} days -> null`, parseSessionSnapshot(snap, later) === null);
  check('future-dated -> null', parseSessionSnapshot({ ...snap, savedAt: '2027-01-01T00:00:00Z' }, now) === null);
  check('corrupt JSON / wrong version / no questions -> null', parseSessionSnapshot('{oops', now) === null && parseSessionSnapshot({ ...snap, v: 2 }, now) === null && parseSessionSnapshot({ ...snap, questions: [] }, now) === null);
  check('short arrays padded, junk replaced, idx clamped', (() => { const r = parseSessionSnapshot({ ...snap, idx: 99, translations: ['가', 7], conceptChoices: 'x' }, now); return r.idx === 2 && eq(r.translations, ['가', '', '']) && eq(r.conceptChoices, [null, null, null]); })());
  const sq = [{ sentences: [{ text: 'x' }, { text: 'y' }] }, { sentences: [{ text: 'z' }, { text: 'w' }, { text: 'v' }] }];
  const ss = parseSessionSnapshot(buildSessionSnapshot({ kind: 'selection', questions: sq, idx: 0, selections: [[0, 1, 1, 5], 'bad'] }, now), now);
  check('selection indexes validated and de-duplicated', eq(ss.selections, [[0, 1], []]) && eq(snapshotProgress(ss), { answered: 1, total: 2 }));
  check('selection never has an assessing phase', parseSessionSnapshot({ ...buildSessionSnapshot({ kind: 'selection', questions: sq }, now), phase: 'assessing' }, now) === null);
  check('translation questions must have english', parseSessionSnapshot({ ...snap, questions: [{ nope: 1 }] }, now) === null);
}

group('G3: chosen concept in assessment requests');
{
  const c1 = slimConcept(E1), c2 = slimConcept(E2);
  const broadQ = { english: 'a', context: '', correctConceptId: E1.id, correctConcept: c1, choices: [c2, c1] };
  const drillQ = { english: 'b', context: '', correctConceptId: E1.id, correctConcept: c1, choices: null };
  const req = buildAssessmentRequest([broadQ, broadQ, drillQ, broadQ], ['', '', '', ''], [E2.id, null, E1.id, 'not-a-choice']);
  check('wrong pick sent as its term', req.items[0].chosenConcept === E2.term);
  check('no pick -> ""', req.items[1].chosenConcept === '');
  check('drill never sends a pick', req.items[2].chosenConcept === '');
  check('id not among the choices -> ""', req.items[3].chosenConcept === '');
  check('old two-argument call still works', buildAssessmentRequest([broadQ], ['x']).items[0].chosenConcept === '');
}

group('G3: scoring');
{
  const c1 = slimConcept(E1), c2 = slimConcept(E2), c3 = slimConcept(E3);
  const B = (correct, choices) => ({ english: 'q', correctConceptId: correct.id, correctConcept: correct, choices });
  const D = (correct) => ({ english: 'q', correctConceptId: correct.id, correctConcept: correct, choices: null });
  const v = (verdict) => ({ verdict });
  check('credit table: O 1, △ 0.5, X 0', TRANSLATION_CREDIT['O'] === 1 && TRANSLATION_CREDIT['△'] === 0.5 && TRANSLATION_CREDIT['X'] === 0);
  const drill = scoreTranslationQuiz([D(c1), D(c1), D(c1), D(c1)], [v('O'), v('△'), v('X'), null], []);
  check('drill: O + △ + X + skipped = 1.5 / 4', drill.points === 1.5 && drill.total === 4 && drill.pct === 38);
  check('drill: only O is fully correct', drill.fullyCorrect === 1);
  const ch = [c1, c2, c3];
  const broad = scoreTranslationQuiz(
    [B(c1, ch), B(c1, ch), B(c2, ch), B(c2, ch), B(c3, ch), B(c3, ch)],
    [v('O'), v('O'), v('△'), v('X'), v('△'), null],
    [E1.id, E2.id, E2.id, E2.id, null, E3.id]);
  const pts = broad.perQuestion.map(p => p.points);
  check('broad: right pick + O = 1', pts[0] === 1);
  check('broad: wrong pick + O = 0.5', pts[1] === 0.5);
  check('broad: right pick + △ = 0.75', pts[2] === 0.75);
  check('broad: right pick + X = 0.5', pts[3] === 0.5);
  check('broad: no pick + △ = 0.25', pts[4] === 0.25);
  check('broad: right pick + not assessed = 0.5', pts[5] === 0.5);
  check('broad totals', broad.points === 3.5 && broad.total === 6 && broad.pct === 58 && broad.fullyCorrect === 1);
  check('pick details recorded', broad.perQuestion[1].pick.correct === false && broad.perQuestion[1].pick.chosenTerm === E2.term && broad.perQuestion[4].pick.chosenId === null);
  check('missed = every concept with a question below full credit', eq(broad.missedConcepts.sort(), [E1.term, E2.term, E3.term].sort()) && eq(broad.concepts.length, 3));
  check('all correct -> no missed concepts', scoreTranslationQuiz([B(c1, ch)], [v('O')], [E1.id]).missedConcepts.length === 0);
  check('no assessment at all -> picks still count', scoreTranslationQuiz([B(c1, ch), B(c2, ch)], null, [E1.id, E1.id]).points === 0.5);
  check('empty quiz', scoreTranslationQuiz([], [], []).pct === 0);
  check('formatPoints', formatPoints(3) === '3' && formatPoints(2.5) === '2.5' && formatPoints(2.75) === '2.75' && formatPoints(NaN) === '0');
}

group('G4: selection reasons and fixes');
{
  const cfg = { mode: 'selection', selectedIds: [E2.id, E4.id] };
  const req = buildGenerationRequest(cfg, CORPUS);
  const { questions } = validateGeneratedQuestions(req, { questions: [
    { sentences: [
      { text: '뭐 먹냐고 물었어요.', conceptRef: 'G2', correct: true, reason: 'should be dropped', fix: 'should be dropped' },
      { text: '같이 가자고 했어요다.', conceptRef: 'G4', correct: false, reason: ' Double ending. ', fix: '같이 가자고 했어요.' },
      { text: '가자고 했어', conceptRef: 'G4', correct: false },
    ] },
  ] }, { config: cfg });
  const [ok, bad, noFix] = questions[0].sentences;
  check('correct sentences carry no reason or fix', ok.reason === '' && ok.fix === '');
  check('incorrect sentence keeps a cleaned reason and fix', bad.reason === 'Double ending.' && bad.fix === '같이 가자고 했어요.');
  check('missing reason/fix -> empty strings (never undefined)', noFix.reason === '' && noFix.fix === '');
}

group('G4: selection scoring (per question)');
{
  const S = (...flags) => ({ sentences: flags.map((c, i) => ({ text: `s${i}`, concept: c ? 'A' : 'B', correct: c })) });
  const qs = [S(true, false), S(true, true, false), S(true, false), S(false, true)];
  const r = scoreSelectionQuiz(qs, [[0], [0], [0, 1], []]);
  check('exact match counts', r.perQuestion[0].correct === true);
  check('missing one correct sentence -> question wrong', r.perQuestion[1].correct === false);
  check('one extra wrong sentence -> question wrong', r.perQuestion[2].correct === false);
  check('selecting nothing earns nothing', r.perQuestion[3].correct === false);
  check('points = questions fully right', r.points === 1 && r.total === 4 && r.pct === 25);
  check('per-sentence verdicts recorded', r.perQuestion[2].sentences[1].selected === true && r.perQuestion[2].sentences[1].isRight === false);
  check('missed concepts come from misjudged sentences', eq(r.missedConcepts.sort(), ['A', 'B']) && eq(scoreSelectionQuiz([S(true, false)], [[0]]).missedConcepts, []));
  check('bad selections input is safe', scoreSelectionQuiz(qs, null).points === 0 && scoreSelectionQuiz([], []).pct === 0);
}

group('G4: selection correction rows');
{
  const q = { sentences: [
    { text: '맞는 문장', concept: '~냐고 하다', correct: true, fix: '' },
    { text: '틀린 문장', concept: '~자고 하다', correct: false, fix: '고친 문장' },
    { text: '또 틀린 문장', concept: '~자고 하다', correct: false, fix: '' },
  ] };
  const rows = buildSelectionCorrectionRows([q], [[0, 1, 2]]);
  check('one row per selected incorrect sentence', rows.length === 2);
  check('row = concept, wrong sentence, its fix', eq(rows[0], { topic: '~자고 하다', original: '틀린 문장', corrected: '고친 문장' }) && rows[1].corrected === '');
  check('missed correct sentences make no row', buildSelectionCorrectionRows([q], [[]]).length === 0);
}

group('G4: result kinds');
{
  check('selection result', grammarResultMode({ type: 'grammar', meta: { mode: 'selection' } }) === 'selection');
  check('translation result', grammarResultMode({ type: 'grammar', meta: { mode: 'translation' } }) === 'translation');
  check('older result without meta -> translation', grammarResultMode({ type: 'grammar' }) === 'translation' && grammarResultMode(null) === 'translation');
}

group('G4: saved selections (Firestore has no arrays inside arrays)');
{
  const sel = [[0, 2], [], [1]];
  const saved = toSavedSelections(sel);
  check('stored as objects, no array directly inside an array', saved.every(x => !Array.isArray(x) && Array.isArray(x.picked)));
  check('round trip', eq(readSavedSelections(saved), sel));
  check('plain arrays (older shape) still read', eq(readSavedSelections(sel), sel));
  check('junk is safe', eq(readSavedSelections(null), []) && eq(readSavedSelections([{}, 'x']), [[], []]) && eq(toSavedSelections([null]), [{ picked: [] }]));
}

group('G5: concepts tested in a quiz');
{
  const c1 = slimConcept(E1), c2 = slimConcept(E2);
  const T = (c) => ({ english: 'q', correctConceptId: c.id, correctConcept: c, choices: null });
  const tq = [T(c1), T(c2), T(c1)];
  const tscore = scoreTranslationQuiz(tq, [{ verdict: 'O' }, { verdict: 'O' }, { verdict: '△' }], []);
  const ts = summarizeQuizConcepts('translation', tq, tscore);
  check('translation: one entry per concept, first-appearance order', eq(ts.map(c => c.id), [E1.id, E2.id]));
  check('translation: counts and missed', ts[0].count === 2 && ts[0].missed === true && ts[1].missed === false);
  check('translation: not assessed -> nothing missed', summarizeQuizConcepts('translation', tq, null).every(c => !c.missed));
  check('older records with only correctConcept.id still work', summarizeQuizConcepts('translation', [{ correctConcept: c2 }], null)[0].id === E2.id);
  const sq = [{ sentences: [{ text: 'a', concept: c1.term, conceptId: E1.id, correct: true }, { text: 'b', concept: c2.term, conceptId: E2.id, correct: false }] }];
  const ss = summarizeQuizConcepts('selection', sq, scoreSelectionQuiz(sq, [[0, 1]]));
  check('selection: concept missed when its sentence was misjudged', ss.find(c => c.id === E1.id).missed === false && ss.find(c => c.id === E2.id).missed === true);
  check('entries without a concept id are skipped', summarizeQuizConcepts('selection', [{ sentences: [{ text: 'x', correct: true }] }], null).length === 0);
}

group('G5: Grammar Deck cards for concepts');
{
  const cards = [
    { id: 'card_a', type: 'grammar', linkedGrammarEntryId: E1.id },
    { id: 'card_b', type: 'grammar', linkedGrammarEntryId: E2.id },
    { id: 'card_b2', type: 'grammar', linkedGrammarEntryId: E2.id },   // duplicate link: first wins
    { id: 'voca_1', type: 'vocab', linkedGrammarEntryId: E3.id },        // not a grammar card
  ];
  const r = cardIdsForConcepts([E2.id, E1.id, E3.id, E2.id], cards);
  check('card ids in concept order, no duplicates', eq(r.cardIds, ['card_b', 'card_a']));
  check('concepts without a grammar card listed as missing', eq(r.missing, [E3.id]));
  check('bad input is safe', eq(cardIdsForConcepts(null, null), { cardIds: [], missing: [] }));
}

console.log(`\n${pass}/${pass + fail} cases pass`);
process.exit(fail ? 1 : 0);
