// scripts/heuristics-golden.mjs
// Golden test set for the lemma heuristics (extractLemmaCandidates,
// extractLemmaFromText, seedMappingPlausible) in src/utils/aviUtils.js.
//
// Run from the repo root:   node scripts/heuristics-golden.mjs
//
// Bundles aviUtils with whichever bundler the repo ships — esbuild, or
// rolldown (the bundler inside Vite 8+) — stubbing the firebase and demo
// modules so the pure functions run in plain Node: no config, no network,
// no writes. Exits 1 on any regression, so it can gate a commit. When
// adding heuristic rules, add their cases here FIRST.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'src/utils/aviUtils.js');

// Everything firebase- or demo-flavored is replaced with inert exports; the
// functions under test never touch them.
const STUB = `
  export const db = null; export const auth = null;
  export const doc = () => null; export const getDoc = async () => null;
  export const setDoc = async () => null; export const writeBatch = () => null;
  export const DEMO = false; export const DEMO_TIER = 'public';
  export const DEMO_CAPS = {}; export const DEMO_LIMIT_NOTE = '';
  export const demoCapReached = () => false;
`;
const isStubbed = (id) =>
  /firebase/.test(id) || id.includes('/demo/') || /demoConfig(\.js)?$/.test(id);

const dir = await mkdtemp(join(tmpdir(), 'avi-golden-'));
const outfile = join(dir, 'aviUtils.bundle.mjs');

async function bundleWithEsbuild(esbuild) {
  await esbuild.build({
    entryPoints: [entry], bundle: true, format: 'esm', outfile,
    logLevel: 'silent',
    plugins: [{
      name: 'stub',
      setup(build) {
        build.onResolve({ filter: /.*/ }, args =>
          isStubbed(args.path) ? { path: args.path, namespace: 'stub' } : undefined);
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: STUB }));
      },
    }],
  });
}

async function bundleWithRolldown(rolldownMod) {
  const build = await rolldownMod.rolldown({
    input: entry,
    logLevel: 'silent',
    plugins: [{
      name: 'stub',
      resolveId(source) { return isStubbed(source) ? '\0stub' : null; },
      load(id) { return id === '\0stub' ? STUB : null; },
    }],
  });
  await build.write({ format: 'esm', file: outfile });
  await build.close();
}

let bundled = false;
try { await bundleWithEsbuild(await import('esbuild')); bundled = true; } catch {}
if (!bundled) {
  try { await bundleWithRolldown(await import('rolldown')); bundled = true; } catch (e) {
    console.error('Could not load esbuild or rolldown from node_modules.');
    console.error('Run `npm install` first (Vite 8+ provides rolldown), or `npm install -D esbuild`.');
    console.error(String(e));
    process.exit(1);
  }
}

const { extractLemmaCandidates, extractLemmaFromText, seedMappingPlausible, normalizeLemma } =
  await import(pathToFileURL(outfile).href);

// ── Golden cases ──────────────────────────────────────────────
// [surface, expectedLemma] — passes when expectedLemma appears anywhere in
// extractLemmaCandidates(surface). The heuristic is a candidate generator:
// wrong siblings in the list are fine, the right answer missing is not.
const CANDIDATE_CASES = {
  'table regulars & particles': [
    ['먹는다', '먹다'], ['먹었습니다', '먹다'], ['좋아요', '좋다'],
    ['만나서', '만나다'], ['읽으면', '읽다'], ['재미있지만', '재미있다'],
    ['하는', '하다'], ['새는', '새'], ['이야기는', '이야기'],
    ['책을', '책'], ['학교에서', '학교'], ['친구처럼', '친구'],
    ['맛있지만', '맛있다'], ['재미있어요', '재미있다'],
  ],
  'irregular recoveries (pre-existing)': [
    ['더워', '덥다'], ['더워요', '덥다'], ['몰라', '모르다'],
    ['몰라요', '모르다'], ['몰랐다', '모르다'], ['들어', '듣다'],
    ['들어요', '듣다'], ['나아', '낫다'], ['바빠', '바쁘다'],
    ['써', '쓰다'], ['써요', '쓰다'], ['새로운', '새롭다'],
    ['무서운', '무섭다'], ['더운', '덥다'], ['까닥여', '까닥이다'],
    ['반짝여', '반짝이다'], ['비치기', '비치다'],
  ],
  'Stage 4d — fused ㄴ/ㄹ attributives': [
    ['예쁜', '예쁘다'], ['큰', '크다'], ['온', '오다'], ['간', '가다'],
    ['산', '살다'], ['예쁠', '예쁘다'], ['클', '크다'],
  ],
  'Stage 4e — syllabic 은/을': [
    ['작은', '작다'], ['높은', '높다'], ['먹을', '먹다'], ['좋은', '좋다'],
  ],
  'Stage 4f — copula peeling': [
    ['황새예요', '황새'], ['학생입니다', '학생'], ['의사예요', '의사'],
    ['고양이야', '고양이'], ['친구였다', '친구'], ['선생님이에요', '선생님'],
  ],
  'Stage 4g — fused-ㅆ pasts': [
    ['갔다', '가다'], ['왔다', '오다'], ['봤다', '보다'], ['봤어', '보다'],
    ['됐다', '되다'], ['줬다', '주다'], ['했다', '하다'], ['냈다', '내다'],
    ['샀다', '사다'], ['먹었어', '먹다'],
  ],
  'Stage 4h — fused-vowel connectives': [
    ['만나요', '만나다'], ['가요', '가다'], ['와서', '오다'],
    ['해요', '하다'], ['건너서', '건너다'], ['만나는', '만나다'],
    ['보는', '보다'],
  ],
  'punctuation stripping (CJK & typographic marks)': [
    ['날리다.', '날리다'], ['날리다\u2026', '날리다'],
    ['\u300C날리다\u300D', '날리다'], ['날렸다~', '날리다'],
    ['\u300E몰라요\u300F', '모르다'], ['해요\uFF01', '하다'],
  ],
  'Stage B — table connectives & endings': [
    ['가려고', '가다'], ['먹으려고', '먹다'], ['하려고', '하다'],
    ['먹으러', '먹다'], ['가면서', '가다'], ['먹으면서', '먹다'],
    ['먹어도', '먹다'], ['같아도', '같다'], ['먹어야', '먹다'],
    ['가니까', '가다'], ['먹으니까', '먹다'], ['학생이니까', '학생'],
    ['가다가', '가다'], ['먹거든', '먹다'], ['먹잖아', '먹다'],
    ['가죠', '가다'], ['먹거나', '먹다'], ['먹습니까', '먹다'],
    ['하십니다', '하다'], ['하겠다', '하다'], ['하겠어', '하다'],
    ['가세요', '가다'], ['잡으세요', '잡다'], ['먹을까', '먹다'],
    ['먹느냐', '먹다'], ['선생님께서', '선생님'],
  ],
  'Stage B — polite-요 retry': [
    ['저는요', '저'], ['먹으니까요', '먹다'], ['먹거든요', '먹다'],
    ['먹잖아요', '먹다'], ['먹을까요', '먹다'], ['우리도요', '우리'],
  ],
  'Stage B — validated candidates': [
    ['배우러', '배우다'], ['예쁘네', '예쁘다'], ['가네요', '가다'],
    ['가나요', '가다'], ['가자', '가다'], ['가지요', '가다'],
    ['나보다', '나'], ['갈게', '가다'], ['살게', '살다'],
    ['갈까요', '가다'], ['갈래', '가다'], ['하시다', '하다'],
    ['하셨다', '하다'], ['갑니다', '가다'], ['합니까', '하다'],
    ['가냐', '가다'], ['가야', '가다'], ['해야', '하다'],
    ['와야', '오다'], ['가겠어요', '가다'], ['가고', '가다'],
    ['자고', '자다'],
  ],
  'Stage B — quotatives': [
    ['간다고', '가다'], ['먹는다고', '먹다'], ['예쁘다고', '예쁘다'],
    ['가자고', '가다'], ['가라고', '가다'], ['먹으라고', '먹다'],
    ['가냐고', '가다'], ['먹느냐고', '먹다'],
  ],
};

// Words the suffix table must never touch: primary result stays identity.
// (Bare nouns like 이야기 that a naive strip WOULD touch are protected at
// the system level by trusted identity rows in the map, not here.)
const IDENTITY_CASES = [
  '시험', '안정', '사람', '시간', '살해', '혐의', '황새', '맛있다', '재미있다',
  // Stage B collision guards: the new table entries must leave these
  // untouched (candidate-tier siblings are fine; blind mangling is not).
  '컨트롤러', '트레일러', '사고', '과자', '여자', '바지', '동네',
];

// normalizeLemma punctuation handling: [input, expected] — exact equality.
const NORMALIZE_CASES = [
  ['날리다.', '날리다'],
  ['날리다\u2026', '날리다'],           // ellipsis
  ['\u300C날리다\u300D', '날리다'],     // corner brackets
  ['\u300E날리다\u300F', '날리다'],     // white corner brackets
  ['날리다~', '날리다'],
  ['날리다\uFF01', '날리다'],           // full-width exclamation
  ['날리다\u3002', '날리다'],           // ideographic full stop
  ['(주먹을) 날리다', '주먹을 날리다'], // Stage 1E leading-parenthetical rule preserved
];

// seedMappingPlausible: [surface, mapping, expected]
const PLAUSIBLE_CASES = [
  ['예쁜', '예쁘다', true],       // fused attributive, shares jamo prefix
  ['황새예요', '황새', true],     // strip shape
  ['새는', '새', true],           // strip shape
  ['가', '가다', true],           // minimal headword extension
  ['까닥여', '퇴창', false],      // hallucination — no shared prefix
  ['먹어', '사다', false],        // unrelated headword
  ['좋아', '좋아합니다', false],  // balloons in length, not 다-final
  ['시험', '시험지', false],      // non-headword expansion
];

// ── Run ───────────────────────────────────────────────────────
let failures = 0, total = 0;

for (const [group, cases] of Object.entries(CANDIDATE_CASES)) {
  const misses = [];
  for (const [surface, expected] of cases) {
    total++;
    const cands = extractLemmaCandidates(surface);
    if (!cands.includes(expected)) { failures++; misses.push([surface, expected, cands]); }
  }
  const n = cases.length;
  console.log(`${misses.length === 0 ? 'PASS' : 'FAIL'}  ${group}  (${n - misses.length}/${n})`);
  for (const [s, e, c] of misses) console.log(`      ${s} → expected ${e}, got [${c.join(', ')}]`);
}

{
  const misses = [];
  for (const w of IDENTITY_CASES) {
    total++;
    const primary = extractLemmaFromText(w);
    if (primary !== w) { failures++; misses.push([w, primary]); }
  }
  console.log(`${misses.length === 0 ? 'PASS' : 'FAIL'}  identity (must-not-mangle)  (${IDENTITY_CASES.length - misses.length}/${IDENTITY_CASES.length})`);
    for (const [w, p] of misses) console.log(`      ${w} mangled to ${p}`);
}

{
  // Stage C — function-word stoplist: primary stays identity AND the
  // candidate list is frozen at [word], so mangles that are real headwords
  // (그러나→그러다) can never validate past it.
  const FUNCTION_WORD_CASES = [
    '그리고', '그래서', '그러나', '그런데', '그러면', '그러니까', '그래도',
    '하지만', '함께', '빨리', '많이', '같이', '정말', '너무', '또는',
  ];
  const misses = [];
  for (const w of FUNCTION_WORD_CASES) {
    total++;
    const primary = extractLemmaFromText(w);
    const cands = extractLemmaCandidates(w);
    if (primary !== w || cands.length !== 1 || cands[0] !== w) {
      failures++; misses.push([w, primary, cands]);
    }
  }
  console.log(`${misses.length === 0 ? 'PASS' : 'FAIL'}  Stage C — function-word stoplist  (${FUNCTION_WORD_CASES.length - misses.length}/${FUNCTION_WORD_CASES.length})`);
  for (const [w, p, c] of misses) console.log(`      ${w} → primary ${p}, candidates [${c.join(', ')}]`);
}

{
  const misses = [];
  for (const [inp, exp] of NORMALIZE_CASES) {
    total++;
    const got = normalizeLemma(inp);
    if (got !== exp) { failures++; misses.push([inp, exp, got]); }
  }
  console.log(`${misses.length === 0 ? 'PASS' : 'FAIL'}  normalizeLemma punctuation  (${NORMALIZE_CASES.length - misses.length}/${NORMALIZE_CASES.length})`);
  for (const [i, e, g] of misses) console.log(`      ${i} → expected ${e}, got ${g}`);
}

{
  const misses = [];
  for (const [s, m, exp] of PLAUSIBLE_CASES) {
    total++;
    const got = seedMappingPlausible(s, m);
    if (got !== exp) { failures++; misses.push([s, m, exp, got]); }
  }
  console.log(`${misses.length === 0 ? 'PASS' : 'FAIL'}  seedMappingPlausible  (${PLAUSIBLE_CASES.length - misses.length}/${PLAUSIBLE_CASES.length})`);
  for (const [s, m, e, g] of misses) console.log(`      (${s} → ${m}) expected ${e}, got ${g}`);
}

await rm(dir, { recursive: true, force: true });
console.log(`\n${total - failures}/${total} cases pass`);
process.exit(failures ? 1 : 0);
