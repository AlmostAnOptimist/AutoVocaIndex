// tests/analyser-lemma-golden.mjs
// Golden test for src/utils/analyserLemma.js: the dictionary form read off
// the Korean analyser's morphemes, which the lemma resolver uses as its
// second opinion (LM4). Runs the real analyser from src/vendor/garu-ko.
//
// Run from the repo root:   node tests/analyser-lemma-golden.mjs   (or: npm test)
//
// These pin what the analyser gives today. If its files are replaced, a
// changed reading here is the first thing to look at. Exits 1 on any failure.

import { loadAnalyser } from './load-analyser.mjs';
import { readingsFromTokens, analyserReadings, wordTokens } from '../src/utils/analyserLemma.js';

const analyse = await loadAnalyser();
let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`);
}
const first = (w, ctx) => analyserReadings(analyse, w, ctx)[0] ?? null;

check('endings the rules were never taught, each to its verb',
  ['하느라고', '먹더라고요', '가자마자', '읽으셨어요', '좋구나', '했더니', '먹으려다가', '하거니와', '갑니다'].map(w => first(w)),
  ['하다', '먹다', '가다', '읽다', '좋다', '하다', '먹다', '하다', '가다']);
check('noun + 이다 in any form gives the noun',
  ['출신이었어', '학생입니다', '친구였어요', '학생이지만', '선생님이세요'].map(w => first(w)),
  ['출신', '학생', '친구', '학생', '선생님']);
check('a 하다 verb is put back together; the plural 들 is dropped',
  [first('공부하느라고'), first('깨끗했다'), first('친구들이'), first('사람들을')],
  ['공부하다', '깨끗하다', '친구', '사람']);
check('an adverb written solid with its verb gives the verb; 못 + 하다 is 못하다',
  [analyserReadings(analyse, '다시봐야겠어요'), first('못합니다')], [['보다', '다시'], '못하다']);
check('quote marks and punctuation around the word are ignored',
  [first('"출신이었어?"'), first('“먹었어요.”')], ['출신', '먹다']);
check('a word that is already its own dictionary form says nothing',
  [analyserReadings(analyse, '학교'), analyserReadings(analyse, '먹다'), analyserReadings(analyse, '')], [[], [], []]);
check('alone, 가니 is misread as a name (nothing useful); in its sentence it is 가다',
  [analyserReadings(analyse, '가니'), first('가니', '엄마가 가니 나도 갔다.')], [[], '가다']);
check('the word is read where it stands in the sentence, not at its first look-alike',
  wordTokens(analyse, '갔다', '엄마가 가니 나도 갔다.').map(t => t.text), ['가', '았', '다', '.']);
check('a phrase, or a word not in the sentence, is read alone or not at all',
  [analyserReadings(analyse, '숨을 죽이고'), first('먹더라', '전혀 다른 문장이다.')], [[], '먹다']);
check('readingsFromTokens: nothing for an empty or particle-first analysis',
  [readingsFromTokens([]), readingsFromTokens(null), readingsFromTokens([{ text: '는', pos: 'JX' }]), readingsFromTokens([{ text: '이', pos: 'VCP' }, { text: '다', pos: 'EF' }])],
  [[], [], [], []]);

console.log(`analyser-lemma-golden: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
