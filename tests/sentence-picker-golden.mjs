// tests/sentence-picker-golden.mjs
// Golden test for tokenizeSentence in src/utils/sentenceStaging.js: which
// pills of a pasted sentence start selected in Sentence Input and the
// reading companion.
//
// Run from the repo root:   node tests/sentence-picker-golden.mjs   (or: npm test)
//
// LM2: a word skipped in any source starts unselected,
// even if another source still studies it ("a skip anywhere wins"), and is
// reported so the pill can be shown faded. Exits 1 on any failure.

import { bundleWithStub } from './bundle-with-stub.mjs';

const STUB = `
  export const db = null; export const auth = null;
  const none = () => null, later = async () => null;
  export const doc = none, collection = none, query = none, where = none, writeBatch = none;
  export const increment = none, arrayUnion = none, serverTimestamp = none;
  export const getDoc = later, getDocs = later, getDocsFromServer = later;
  export const setDoc = later, updateDoc = later, addDoc = later, deleteDoc = later;
  export const Timestamp = { now: none };
  export const DEMO = false; export const DEMO_TIER = 'public';
  export const DEMO_CAPS = {}; export const DEMO_LIMIT_NOTE = '';
  export const demoCapReached = () => false;
`;const { mod, cleanup } = await bundleWithStub('src/utils/sentenceStaging.js', STUB);
const { tokenizeSentence } = mod;

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`);
}
const pick = (text, rows) => {
  const r = tokenizeSentence(text, rows);
  return { tokens: r.tokens.map(t => t.token), auto: [...r.autoSelected], skipped: [...r.skipped] };
};

const rows = [
  { input: '숨어서', lemma: '숨다', source: 'A' },
  { input: '몰래', lemma: '몰래', source: 'A' },
  { input: '그녀는', lemma: '그녀', source: 'A', skipUpload: true },
  // 쓰다: studied in A, skipped in B. A skip anywhere wins.
  { input: '썼다', lemma: '쓰다', source: 'A' },
  { input: '써요', lemma: '쓰다', source: 'B', skipUpload: true },
  // 않다: skipped, matched through another row's surface
  { input: '않다', lemma: '않다', source: 'B', skipUpload: true },
];

check('known words are pre-selected; a skipped word is not, and is reported',
  pick('그녀는 문 뒤에 숨어서 몰래 엿들었다.', rows),
  { tokens: ['그녀는', '문', '뒤에', '숨어서', '몰래', '엿들었다.'], auto: [3, 4], skipped: [0] });

check('a skip in one source wins over study in another (썼다 is studied in A, 쓰다 skipped in B)',
  pick('편지를 썼다', rows), { tokens: ['편지를', '썼다'], auto: [], skipped: [1] });

check('a token matched by lemma whose word is skipped elsewhere',
  pick('않다 몰래', rows), { tokens: ['않다', '몰래'], auto: [1], skipped: [0] });

check('nothing skipped: unchanged from before',
  pick('숨어서 몰래', rows.filter(r => !r.skipUpload)), { tokens: ['숨어서', '몰래'], auto: [0, 1], skipped: [] });

check('no rows, empty text, null rows',
  [pick('문 앞에', []), pick('', rows), pick('문', null)],
  [{ tokens: ['문', '앞에'], auto: [], skipped: [] }, { tokens: [], auto: [], skipped: [] }, { tokens: ['문'], auto: [], skipped: [] }]);

await cleanup();
console.log(`sentence-picker-golden: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
