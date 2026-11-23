// tests/grammar-corrections-golden.mjs
// Golden test for correction links (audit G2, GS-D9):
//   src/utils/grammarCorrections.js   which entries a corrections session's
//                                     rows suggest
// run with the real analyser kept in src/vendor/garu-ko. The sentences are
// written for the test; no study data.
//
// Run from the repo root:   node tests/grammar-corrections-golden.mjs   (or: npm test)
// Plain Node. Exits 1 on any failure.

import { loadAnalyser } from './load-analyser.mjs';

const K = await import('../src/utils/grammarCorrections.js');
const { compileEntries } = await import('../src/utils/grammarSightings.js');
const analyse = await loadAnalyser();

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`);
}

check('plain text: tags and entities out, a space where a block or a line broke',
  [K.plainText('<p>밥<span style="background:yellow">을</span> 먹어요.</p><p>둘째&nbsp;줄 &amp; 끝</p>'), K.plainText('첫 줄<br>둘째 줄'), K.plainText('<a href="x">링크</a>'), K.plainText(null), K.plainText('  그냥  글  ')],
  ['밥을 먹어요. 둘째 줄 & 끝', '첫 줄 둘째 줄', '링크', '', '그냥 글']);

const entries = [
  // The two particle entries carry a hint that says "after a noun". Read from
  // their titles alone, ~을/를 and ~이/가 are also taken for the verb endings
  // spelled the same way (할, 먹을): see the decisions doc, G3e "As built".
  { id: 'eul', glossaryTerm: '~을/를 (object particle)', patternHint: 'N을/를', entryNumber: 115, sightingsOff: true },
  { id: 'iga', glossaryTerm: '~이/가', patternHint: 'N이/가', entryNumber: 331, sightingsOff: true },
  { id: 'baram', glossaryTerm: '~는 바람에', entryNumber: 142 },
  { id: 'su', glossaryTerm: '~ㄹ/을 수 있다/없다', entryNumber: 106 },
  { id: 'sipda', glossaryTerm: '~고 싶다', entryNumber: 110 },
  { id: 'topic', glossaryTerm: '반말체', entryNumber: 4 },
];
const compiled = compileEntries(entries, analyse);
const s = (rows, linked) => K.correctionSuggestions({ rows, entries, compiled, analyse, linked }).map(x => [x.entryId, x.rows]);

check('a wrong particle: the corrected one is suggested, though switched off for sightings', s([{ original: '친구가 만났어요.', corrected: '친구를 만났어요.' }]), [['eul', 1]]);
check('a pattern the correction put in', s([{ original: '비가 와서 못 갔어요.', corrected: '<p>비가 오는 <b>바람에</b> 못 갔어요.</p>' }]), [['baram', 1]]);
check('a pattern in both texts is not suggested', s([{ original: '저는 수영할 수 있어요.', corrected: '저는 수영을 할 수 있어요.' }]), [['eul', 1]]);
check('a word changed and nothing else: no suggestion', s([{ original: '사과를 먹고 싶어요.', corrected: '배를 먹고 싶어요.' }]), []);
check('a row needs Korean on both sides, and a difference', s([
  { original: '', corrected: '친구를 만났어요.' }, { original: '친구가 만났어요.', corrected: '' }, { original: 'English', corrected: '친구를 만났어요.' },
  { original: '친구를 만났어요.', corrected: '<p>친구를  만났어요.</p>' }, {}, null,
]), []);
check('across rows: most rows first, then by entry number', s([
  { topic: 'particles', original: '친구가 만났어요.', corrected: '친구를 만났어요.' },
  { original: '밥이 먹어요.', corrected: '밥을 먹어요.' },
  { original: '수영해요.', corrected: '수영할 수 있어요.' },
  { original: '집에 가요.', corrected: '집에 가고 싶어요.' },
]), [['eul', 2], ['su', 1], ['sipda', 1]]);
check('entries already linked are not suggested again', s([
  { original: '친구가 만났어요.', corrected: '친구를 만났어요.' }, { original: '수영해요.', corrected: '수영할 수 있어요.' },
], ['eul']), [['su', 1]]);
check('each suggestion says which entry it is', K.correctionSuggestions({ rows: [{ original: '수영해요.', corrected: '수영할 수 있어요.' }], entries, compiled, analyse }),
  [{ entryId: 'su', term: '~ㄹ/을 수 있다/없다', number: 106, rows: 1 }]);
check('nothing in, nothing out', [K.correctionSuggestions({ rows: [], entries, compiled, analyse }), K.correctionSuggestions({ entries, compiled, analyse }), K.correctionSuggestions({ rows: [{ original: '친구가 만났어요.', corrected: '친구를 만났어요.' }], entries: [], compiled: [], analyse })], [[], [], []]);

console.log(`grammar-corrections-golden: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
