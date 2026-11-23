// tests/lemma-resolver-golden.mjs
// Golden test for resolveLemmaDetailed in src/utils/aviUtils.js: how a
// candidate list from extractLemmaCandidates meets the global lemma map.
// The map is a stand-in (a few rows, below), so this tests the resolver's
// choices, not the real map's contents.
//
// Run from the repo root:   node tests/lemma-resolver-golden.mjs   (or: npm test)
//
// LM3 (Nov 18 2026): bare ㄴ다 forms (간다, 쓴다) are resolved through their
// readings, but a surface that is a dictionary word itself keeps itself
// (판다 the noun, 안다 "to hug"), with the readings offered as alternates —
// from the map, from the user's own Lemma Master, and against a seed row.
// LM4 (Nov 20 2026): the same for everything the ending peeler reads into
// a word (멍하니 the adverb keeps itself, 멍하다 is offered); a verb ending
// in 이다 beats the noun inside it and a noun + 이다 gives the noun; an
// unknown word in a copula shape falls back to the noun; and the second
// opinion (the analyser in the app, a stand-in here) is one more candidate
// right after the rules' first answer, never the judge.
// Exits 1 on any failure.

import { bundleWithStub } from './bundle-with-stub.mjs';

const STUB = `
  export const db = null; export const auth = null;
  const none = () => null, later = async () => null;
  export const doc = (_db, col, key) => ({ col, key });
  export const getDoc = async (ref) => {
    const row = (globalThis.__glm || {})[ref && ref.key];
    return { exists: () => !!row, data: () => row };
  };
  export const collection = none, query = none, where = none, writeBatch = none;
  export const increment = none, arrayUnion = none, serverTimestamp = none;
  export const getDocs = later, getDocsFromServer = later;
  export const setDoc = later, updateDoc = later, addDoc = later, deleteDoc = later;
  export const Timestamp = { now: none };
  export const DEMO = false; export const DEMO_TIER = 'public';
  export const DEMO_CAPS = {}; export const DEMO_LIMIT_NOTE = '';
  export const demoCapReached = () => false;
`;
const { mod, cleanup } = await bundleWithStub('src/utils/aviUtils.js', STUB);
const { resolveLemmaDetailed, setLemmaSecondOpinion } = mod;

// Rows as the Oct 2026 cleanup left them: `headword: true` marks a key that
// is a dictionary word. Seed-era dates, so nothing is trusted as a mapping
// unless `verified`.
const SEED = '2026-03-22';
const word = (w) => ({ cleanedLemma: w, headword: true, updatedAt: SEED });
globalThis.__glm = {
  '가다': word('가다'), '만나다': word('만나다'), '쓰다': word('쓰다'), '만들다': word('만들다'),
  '사다': word('사다'), '살다': word('살다'), '울다': word('울다'), '해석하다': word('해석하다'),
  '파다': word('파다'), '팔다': word('팔다'), '알다': word('알다'), '시다': word('시다'),
  // Dictionary words that look like a bare ㄴ다 form.
  '판다': word('판다'), '안다': word('안다'), '신다': word('신다'),
  // A dictionary-word key whose unverified seed row rewrites it into its
  // bare reading (까다 is not a headword here, so only the seed path could
  // pick it): must not win either.
  '깐다': { cleanedLemma: '까다', headword: true, updatedAt: SEED },
  // LM4
  '멍하니': word('멍하니'), '멍하다': word('멍하다'), '하다': word('하다'), '먹다': word('먹다'),
  '학생': word('학생'), '비명': word('비명'), '출신': word('출신'), '친구': word('친구'),
  '보이다': word('보이다'), '보': word('보'), '움직이다': word('움직이다'), '가시다': word('가시다'),
  '계시다': word('계시다'), '감시': word('감시'), '감다': word('감다'), '보고서': word('보고서'),
  '보다': word('보다'), '편지': word('편지'), '펴다': word('펴다'), '낚시': word('낚시'), '낚다': word('낚다'),
  '듣다': word('듣다'), '들다': word('들다'), '고양이': word('고양이'), '고양': word('고양'),
  '파일': word('파일'), '파': word('파'), '아래': word('아래'), '사실': word('사실'), '사과': word('사과'),
  '사': word('사'), '아시아': word('아시아'), '지도': word('지도'), '지다': word('지다'), '집': word('집'),
  '달리다': word('달리다'), '달다': word('달다'), '눕다': word('눕다'), '만들다': word('만들다'),
  '이미지': word('이미지'), '이미': word('이미'),
};

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`);
}
const lemma = async (s, opts) => (await resolveLemmaDetailed(s, opts)).lemma;
const both = async (s, opts) => resolveLemmaDetailed(s, { withAlternates: true, ...opts });

check('bare ㄴ다 on a vowel stem resolves to its verb',
  [await lemma('간다'), await lemma('만난다'), await lemma('쓴다'), await lemma('운다')],
  ['가다', '만나다', '쓰다', '울다']);
check('bare ㄴ다 on a ㄹ stem resolves to the ㄹ verb', await lemma('만든다'), '만들다');
check('한다 is a rule: 해석한다 → 해석하다 with nothing to validate', await lemma('공부한다'), '공부하다');
check('ambiguous 산다: 사다, with 살다 offered', await both('산다'), { lemma: '사다', alternates: ['살다'] });

check('a dictionary word keeps itself; its verb readings are offered',
  [await both('판다'), await both('안다'), await both('신다')],
  [{ lemma: '판다', alternates: ['파다', '팔다'] }, { lemma: '안다', alternates: ['알다'] }, { lemma: '신다', alternates: ['시다'] }]);
check('…also when the reading is in your own Lemma Master',
  await lemma('판다', { localHeadwords: new Set(['팔다']) }), '판다');
check('…and your Lemma Master still decides for a word that is not one itself',
  await lemma('산다', { localHeadwords: new Set(['살다']) }), '살다');
check('a seed row rewriting a dictionary-word surface into a bare reading does not win',
  await lemma('깐다'), '깐다');
check('with an ending after it the noun stays first anyway (판다가 → 판다)', await lemma('판다가'), '판다');

// ── LM4 ───────────────────────────────────────────────────────
check('LM4: endings the rules now know, confirmed by the dictionary',
  [await lemma('먹느라고'), await lemma('하더라고요'), await lemma('먹으려다가'), await lemma('했더니'), await lemma('가셨어요'), await lemma('들으니')],
  ['먹다', '하다', '먹다', '하다', '가다', '듣다']);
check('LM4: quote marks around the word no longer stop the rules',
  [await lemma('출신이었어?"'), await lemma('“먹었더라고요.”')], ['출신', '먹다']);
check('LM4: 멍하니 is a dictionary adverb and keeps itself; 멍하다 is offered',
  await both('멍하니'), { lemma: '멍하니', alternates: ['멍하다'] });
check('LM4: other dictionary words that end like an ending keep themselves',
  [await lemma('보고서'), await lemma('편지'), await lemma('계시다'), await lemma('가시다')], ['보고서', '편지', '계시다', '가시다']);
check('LM4: noun + 이다 gives the noun, in any form',
  [await lemma('비명이다'), await lemma('학생이고'), await lemma('학생이지만'), await lemma('학생입니다'), await lemma('친구였다'), await lemma('친구니까'), await lemma('친구다')],
  ['비명', '학생', '학생', '학생', '친구', '친구', '친구']);
check('LM4: a verb ending in 이다 beats the noun inside it',
  [await lemma('보이다'), await lemma('보이고'), await lemma('보입니다'), await lemma('움직였다')], ['보이다', '보이다', '보이다', '움직이다']);
check('LM4: 고양이에요 prefers the noun the word spells out', await lemma('고양이에요'), '고양이');
check('LM4: nothing confirmed, copula shape: the noun is the guess (a name the map lacks)',
  [await lemma('민수입니다'), await lemma('토시바였어요')], ['민수', '토시바']);

check('LM4: nouns that end like a new reading keep themselves (the map has 파, 사, 알다, 사다, 지다, 이미 too)',
  [await lemma('파일'), await lemma('아래'), await lemma('사실'), await lemma('사과'), await lemma('아시아'), await lemma('지도'), await lemma('이미지')],
  ['파일', '아래', '사실', '사과', '아시아', '지도', '이미지']);
check('LM4: a one-syllable noun and its particle; a ㅂ-irregular before 서; a dropped ㄹ',
  [await lemma('집에'), await lemma('누워서'), await lemma('만드는데')], ['집', '눕다', '만들다']);
check('LM4: an unsure new reading stays behind the older one (달려 is 달리다, with 달다 offered)',
  await both('달려'), { lemma: '달리다', alternates: ['달다'] });

// The second opinion. A stand-in for the analyser: canned readings per word.
const calls = [];
const canned = { '감시니까': ['감시'], '낚시고': ['낚시'], '꼼지락대걸랑': ['꼼지락대다'], '판다': ['팔다'], '먹느라고': ['먹다'], '들으니': ['들다'] };
setLemmaSecondOpinion(async (surface, context) => { calls.push([surface, context || '']); return canned[surface] || []; });
check('second opinion: 감시니까 and 낚시고 are nouns, as it says',
  [await lemma('감시니까'), await lemma('낚시고')], ['감시', '낚시']);
setLemmaSecondOpinion(null);
check('…(on the rules alone the same two words read as honorific verbs)', [await lemma('감시니까'), await lemma('낚시고')], ['감다', '낚다']);
setLemmaSecondOpinion(async (surface, context) => { calls.push([surface, context || '']); return canned[surface] || []; });
check('second opinion: ranked after the rules\' first answer, so a ㄷ-irregular the rules settle stays (들으니 → 듣다)',
  await lemma('들으니'), '듣다');
check('second opinion: cannot beat a surface that is a dictionary word (판다)', await lemma('판다'), '판다');
check('second opinion: used when nothing is confirmed and the rules left the word alone',
  await lemma('꼼지락대걸랑'), '꼼지락대다');
calls.length = 0;
await resolveLemmaDetailed('감시니까', { context: '감시니까 조심해.' });
check('second opinion: is given the sentence the word came from', calls, [['감시니까', '감시니까 조심해.']]);
setLemmaSecondOpinion(async () => { throw new Error('analyser failed to load'); });
check('second opinion: a failure leaves the rules\' answer', [await lemma('먹느라고'), await lemma('감시니까')], ['먹다', '감다']);
setLemmaSecondOpinion(async () => 'not a list');
check('second opinion: a malformed answer is ignored', await lemma('먹느라고'), '먹다');
setLemmaSecondOpinion(null);

await cleanup();
console.log(`lemma-resolver-golden: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
