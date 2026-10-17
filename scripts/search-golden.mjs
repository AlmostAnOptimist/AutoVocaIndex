// scripts/search-golden.mjs
// Golden test set for the AVI search engine (src/utils/lemmaSearchEngine.js).
// Decisions: AS-D5 to AS-D11, AS-D18 and AS-D29 of the AVI search overhaul.
//
// Run from the repo root:   node scripts/search-golden.mjs
//
// Same mechanics as heuristics-golden.mjs: bundles the engine (and the
// aviUtils helpers it imports) with esbuild or rolldown, stubbing firebase
// and demo modules, then runs against a synthetic Lemma Master fixture.
// No config, no network, no writes. Exits 1 on any failure, so it gates a
// commit. When changing a rule in the engine, add its case here FIRST.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'src/utils/lemmaSearchEngine.js');

const STUB = `
  export const db = null; export const auth = null;
  export const doc = () => null; export const getDoc = async () => null;
  export const setDoc = async () => null; export const writeBatch = () => null;
  export const DEMO = false; export const DEMO_TIER = 'public';
  export const DEMO_CAPS = {}; export const DEMO_LIMIT_NOTE = '';
  export const demoCapReached = () => false;
  export const apiFetch = async () => { throw new Error('network disabled in golden harness'); };
`;
const isStubbed = (id) =>
  /firebase/.test(id) || id.includes('/demo/') || /demoConfig(\.js)?$/.test(id) || /apiFetch(\.js)?$/.test(id);

const dir = await mkdtemp(join(tmpdir(), 'avi-search-golden-'));
const outfile = join(dir, 'lemmaSearchEngine.bundle.mjs');

async function bundleWithEsbuild(esbuild) {
  await esbuild.build({
    entryPoints: [entry], bundle: true, format: 'esm', outfile, logLevel: 'silent',
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
    input: entry, logLevel: 'silent',
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

const {
  buildLemmaIndex, buildSurfaceMap, resolveKorean, findByLemmaText,
  suggestLemmas, relatedLemmas, searchEnglish, lemmaVariants, filterLemmaMaster,
} = await import(pathToFileURL(outfile).href);

// ── Fixture ───────────────────────────────────────────────────
// Shapes mirror real entries: slash lemmas, optional endings, collocations
// with the KRDict "Definition not found." placeholder, long numbered def1s.
const NF = 'Definition not found.';
let seq = 0;
const LM = [];
const ID = {};
function L(lemma, def2, def1 = '', rel = {}) {
  const lemmaID = 'id' + (++seq);
  ID[lemma] = lemmaID;
  LM.push({ lemmaID, lemma, def2, def1, relatedForm: '', relatedMeaning: '', hiddenRelated: '', ...rel });
  return lemmaID;
}
L('가르치다', 'to teach', '1. teach; instruct: To give someone knowledge or skills.');
L('가르침', 'teaching, lesson', '1. teaching; instruction: The act of giving knowledge.');
L('가르쳐 주다', 'to teach (someone), to show how');
L('가르다', 'to divide, to split', '1. divide; split: To cut something into parts.');
L('가리다', 'to cover, to hide; to be picky', '1. cover; screen: To block something from view.');
L('치다', 'to hit, to strike', '1. hit; strike: To touch something hard.');
L('가', 'edge, side', '1. edge; side: The outer part of something.');
L('먹다', 'to eat', '1. eat: To put food in the mouth.');
L('먹이', 'feed (for animals)', '1. feed: Food for animals.');
L('가다', 'to go', '1. go: To move from one place to another.');
L('자다', 'to sleep', '1. sleep: To rest the body.');
L('보다', 'to see, to watch', '1. see: To perceive with the eyes.');
L('사다', 'to buy', '1. buy: To get something by paying money.');
L('오다', 'to come', '1. come: To move toward the speaker.');
L('날리다', 'to fly (something), to let fly', '1. fly: To make something move through the air.');
L('(주먹을) 날리다', 'to throw a punch', NF);
L('연봉', 'annual salary', '1. annual salary: Wages paid for one year of work.');
L('높다', 'to be high, to be tall', '1. high: Far from the ground.');
L('연봉이 높다', 'high (yearly) salary / high annual income', NF);
L('만족도가 높다', 'high satisfaction', NF);
L('근무 환경이 좋다', 'to have a good work(ing) environment', NF);
L('발전 가능성이 있다', 'possibility/potential for development', NF);
L('보장하다 / 보장되다', '1.[명사] guarantee(d), [동사] to guarantee, assure; vouch for', '1. guarantee: To assure someone.\n\n-----\n\n1. be guaranteed: To be assured.');
L('입사(하다)', 'to join a company', '1. enter a company; join a company: To get a job with a company.');
L('향상(하다/되다)', 'to improve, to enhance', '');
L('두렵다', 'to be afraid, fear', '1. afraid; fearful: Worried that something bad will happen.');
L('무섭다', 'to be scary; to be afraid', '1. scary: Making one feel fear.');
L('겁나다', 'to be afraid', '1. be scared: To feel fear.');
L('고소공포증', 'being afraid of heights', '1. acrophobia: Fear of being in a high place.');
L('정규직 / 비정규직', 'permanent position / temporary position', '1. being regular: A job with a set period.');
L('안정', 'stability',
  '1. stability; equilibrium: A consistent state kept.\n\n[안정되다 · 동사]\n\n10. range of success: The state of being in range.\n\n11. stable period; plateau: A period that remains.');

// Relations: 가르치다 has 가르다 pinned as Form; 보다 has a zero-score Meaning
// pin (오다); 가리다 hides 사다 (zero score) plus a stale id.
const byLemma = (s) => LM.find(l => l.lemma === s);
byLemma('가르치다').relatedForm = ID['가르다'];
byLemma('가르다').relatedForm = ID['가르치다'];
byLemma('보다').relatedMeaning = ID['오다'];
byLemma('가리다').hiddenRelated = `${ID['사다']},stale-id-not-in-lemma-master`;

const wordInputs = [
  { input: '날려서', lemma: '날리다', ts: '2026-01-01T00:00:00Z' },
  { input: '가르쳐', lemma: '가르치다', ts: '2026-01-02T00:00:00Z' },
];
const sentenceInputs = [
  { inputForm: '높은 만족도를', targetWord: '만족도가 높다', ts: '2026-01-03T00:00:00Z' },
];

const index = buildLemmaIndex(LM);
const surfaceMap = buildSurfaceMap(wordInputs, sentenceInputs);

// ── Runner ────────────────────────────────────────────────────
let failures = 0, total = 0;
const groups = [];
function group(name, fn) {
  const misses = [];
  let n = 0;
  const check = (cond, msg) => { n++; total++; if (!cond) { failures++; misses.push(msg); } };
  fn(check);
  groups.push([name, n, misses]);
}
const ids = (items) => items.map(i => i.lemmaID);
const lemmas = (items) => items.map(i => i.lemma);
const rankOf = (items, lemma) => { const i = items.findIndex(x => x.lemma === lemma); return i < 0 ? Infinity : i; };

// ── Cases ─────────────────────────────────────────────────────

group('resolution: exact and verbatim (AS-D8 steps 1–2)', (check) => {
  const r = (q) => resolveKorean(index, q, { surfaceMap });
  check(r('가르치다').entry?.lemma === '가르치다' && r('가르치다').status === 'exact', '가르치다 → exact 가르치다');
  check(r('날리다').entry?.lemma === '날리다', '날리다 → 날리다, never the collocation');
  check(r('(주먹을) 날리다').entry?.lemma === '(주먹을) 날리다', '(주먹을) 날리다 → verbatim collocation');
  check(r('주먹을 날리다').entry?.lemma === '(주먹을) 날리다', '주먹을 날리다 → collocation via normalized form');
  check(r('연봉이높다').entry?.lemma === '연봉이 높다', '연봉이높다 (no space) → 연봉이 높다');
  check(r('가르치다'.normalize('NFD')).entry?.lemma === '가르치다', 'decomposed (NFD) query → 가르치다');
  check(r('  가르치다  ').entry?.lemma === '가르치다', 'surrounding spaces ignored');
});

group('resolution: headword variants count as exact', (check) => {
  const r = (q) => resolveKorean(index, q, { surfaceMap });
  check(r('보장되다').entry?.lemma === '보장하다 / 보장되다' && r('보장되다').status === 'exact', '보장되다 → 보장하다 / 보장되다 (exact)');
  check(r('보장하다').entry?.lemma === '보장하다 / 보장되다', '보장하다 → 보장하다 / 보장되다');
  check(r('입사하다').entry?.lemma === '입사(하다)', '입사하다 → 입사(하다)');
  check(r('입사').entry?.lemma === '입사(하다)', '입사 → 입사(하다)');
  check(r('향상되다').entry?.lemma === '향상(하다/되다)', '향상되다 → 향상(하다/되다)');
  check(r('향상').entry?.lemma === '향상(하다/되다)', '향상 → 향상(하다/되다)');
  check(!lemmaVariants('(주먹을) 날리다').includes('날리다'), 'leading parenthetical is never dropped from variants');
  check(findByLemmaText(index, '보장되다')?.lemma === '보장하다 / 보장되다', 'findByLemmaText uses variants (global lemma map step)');
  check(resolveKorean(index, '비정규직').entry?.lemma === '정규직 / 비정규직', '비정규직 → 정규직 / 비정규직 (second slash part)');
  check(findByLemmaText(index, '없는단어') === null, 'findByLemmaText returns null for a lemma not in Lemma Master');
});

group('resolution: surface forms (AS-D8 step 3)', (check) => {
  const r = (q) => resolveKorean(index, q, { surfaceMap });
  check(r('날려서').status === 'surface' && r('날려서').entry?.lemma === '날리다', '날려서 → 날리다 via Word Input surface');
  check(r('가르쳐').entry?.lemmaID === r('가르치다').entry?.lemmaID, '가르쳐 and 가르치다 resolve to the same lemma (no self-link in Connect List)');
  check(r('높은 만족도를').entry?.lemma === '만족도가 높다', 'Sentence Input inputForm → targetWord');
  check(resolveKorean(index, '날려서').status === 'none', 'without a surface map, 날려서 is not resolved');
});

group('resolution: no match gives labelled suggestions, no anchor (AS-D11)', (check) => {
  const typo = resolveKorean(index, '가르치디', { surfaceMap });
  check(typo.status === 'none' && typo.entry === null, '가르치디 → no anchor');
  check(typo.suggestions.some(s => s.lemma === '가르치다' && s.kind === 'near'), '가르치디 suggests 가르치다 as similar spelling');
  const pre = resolveKorean(index, '가르', { surfaceMap });
  check(pre.status === 'none', '가르 → no anchor');
  check(pre.suggestions.length > 0 && pre.suggestions.slice(0, 3).every(s => s.kind === 'prefix'), '가르 → starts-with suggestions first');
  const con = suggestLemmas(index, '날리');
  check(con.some(s => s.lemma === '(주먹을) 날리다' && s.kind === 'contains'), '날리 suggests (주먹을) 날리다 as contains');
  check(con[0]?.lemma === '날리다' && con[0]?.kind === 'prefix', '날리 → 날리다 first (prefix)');
  check(suggestLemmas(index, '가르', { limit: 2 }).length === 2, 'suggestion limit respected');
  check(!suggestLemmas(index, '가르', { excludeIds: [ID['가르다']] }).some(s => s.lemma === '가르다'), 'excludeIds respected');
});

group('ranking: word families beat substring false friends (AS-D9)', (check) => {
  const rel = relatedLemmas(index, ID['가르치다']);
  const c = rel.candidates;
  check(c.some(x => x.lemma === '가르침'), '가르침 is a candidate for 가르치다');
  check(c.some(x => x.lemma === '가르쳐 주다'), '가르쳐 주다 is a candidate for 가르치다');
  check(rankOf(c, '가르침') < rankOf(c, '치다'), '가르침 ranks above 치다');
  check(rankOf(c, '가르쳐 주다') < rankOf(c, '치다'), '가르쳐 주다 ranks above 치다');
  check(!c.some(x => x.lemma === '가'), 'single-syllable 가 does not qualify on a substring');
  check(c.some(x => x.lemma === '가리다' && x.reasons.includes('similar spelling')), '가리다 found as similar spelling');
  for (const v of ['자다', '보다', '사다', '오다']) check(!c.some(x => x.lemma === v), `${v} does not qualify on the shared 다`);
});

group('ranking: 먹다 family, no -다 noise', (check) => {
  const c = relatedLemmas(index, ID['먹다']).candidates;
  check(c.some(x => x.lemma === '먹이'), '먹이 is a candidate for 먹다');
  for (const v of ['가다', '자다', '보다', '사다', '오다', '가르치다']) check(!c.some(x => x.lemma === v), `${v} not a candidate for 먹다`);
});

group('ranking: collocations', (check) => {
  const nal = relatedLemmas(index, ID['날리다']).candidates;
  check(nal[0]?.lemma === '(주먹을) 날리다' && nal[0].reasons.includes('collocation'), '(주먹을) 날리다 is the top candidate for 날리다');
  const yb = relatedLemmas(index, ID['연봉']).candidates;
  check(yb.some(x => x.lemma === '연봉이 높다' && x.reasons.includes('collocation')), '연봉 → 연봉이 높다 (particle-stripped word)');
  const nop = relatedLemmas(index, ID['높다']).candidates;
  check(nop.some(x => x.lemma === '연봉이 높다') && nop.some(x => x.lemma === '만족도가 높다'), '높다 → both 높다 collocations');
  const coll = relatedLemmas(index, ID['연봉이 높다']).candidates;
  check(coll.some(x => x.lemma === '만족도가 높다'), '연봉이 높다 → 만족도가 높다 (shared word)');
  const slash = relatedLemmas(index, ID['정규직 / 비정규직']).candidates;
  check(!slash.some(x => x.lemma === '보장하다 / 보장되다' && x.reasons.includes('shared word')), 'two slash lemmas are not linked by the "/" itself');
});

group('ranking: the "Definition not found." placeholder is ignored', (check) => {
  const coll = relatedLemmas(index, ID['연봉이 높다']).candidates;
  check(!coll.some(x => x.lemma === '근무 환경이 좋다'), '근무 환경이 좋다 not related to 연봉이 높다');
  check(!coll.some(x => x.lemma === '발전 가능성이 있다'), '발전 가능성이 있다 not related to 연봉이 높다');
  check(!coll.some(x => x.reasons.includes('similar meaning') && x.lemma === '(주먹을) 날리다'), 'no meaning link between placeholder entries');
  check(searchEnglish(index, 'found').total === 0, 'English "found" matches no placeholder');
  check(searchEnglish(index, 'definition').total === 0, 'English "definition" matches no placeholder');
  check(searchEnglish(index, '10').total === 0, 'sense numbers are not tokens');
});

group('pins, hidden group and cap (AS-D10)', (check) => {
  const g = relatedLemmas(index, ID['가르치다']);
  check(g.pinned.some(x => x.lemma === '가르다' && x.pinForm), '가르다 is pinned (Form)');
  check(!g.candidates.some(x => x.lemma === '가르다'), 'a pinned lemma is not repeated in candidates');
  const b = relatedLemmas(index, ID['보다']);
  check(b.pinned.some(x => x.lemma === '오다' && x.pinMeaning), 'a zero-score pin is still included');
  const h = relatedLemmas(index, ID['가리다']);
  check(h.hidden.length === 1 && h.hidden[0].lemma === '사다' && h.hidden[0].hide, 'hidden group has 사다 (zero score); stale id skipped');
  check(!h.candidates.some(x => x.lemma === '사다'), 'hidden lemma not in candidates');

  // Cap: 60 related entries, cap 40.
  const big = [{ lemmaID: 'school', lemma: '학교', def2: 'school', def1: '' }];
  for (let i = 0; i < 60; i++) big.push({ lemmaID: 'sch' + i, lemma: '학교' + String.fromCharCode(0xAC00 + i * 7), def2: 'x', def1: '' });
  big[0].relatedForm = 'sch0';
  big[0].hiddenRelated = 'sch1';
  const bi = buildLemmaIndex(big);
  const capped = relatedLemmas(bi, 'school', { cap: 40 });
  check(capped.candidates.length === 40, `candidates capped at 40 (got ${capped.candidates.length})`);
  check(capped.totalCandidates === 58, `totalCandidates reports all (got ${capped.totalCandidates}; 60 minus 1 pinned minus 1 hidden)`);
  check(capped.pinned.length === 1 && capped.hidden.length === 1, 'pinned and hidden sit outside the cap');
  check(relatedLemmas(index, 'no-such-id').anchor === null, 'unknown anchor id returns an empty result');
});

group('English search (AS-D18, AS-D29)', (check) => {
  const all = searchEnglish(index, 'afraid', { limit: 50 });
  const exactSet = new Set(['두렵다', '무섭다', '겁나다']);
  const firstNonExact = all.results.findIndex(x => !exactSet.has(x.lemma));
  check(all.results.slice(0, 3).every(x => exactSet.has(x.lemma) && x.reasons.includes('exact gloss')), 'exact-gloss entries rank first for "afraid"');
  check(firstNonExact >= 3 && all.results[firstNonExact]?.lemma === '고소공포증', '고소공포증 (phrase only) ranks after all exact glosses');
  const page = searchEnglish(index, 'afraid', { limit: 2 });
  check(page.results.length === 2 && page.total === all.total && page.total >= 4, `total reported beyond the page (total ${page.total})`);
  const page2 = searchEnglish(index, 'afraid', { limit: 2, offset: 2 });
  check(page2.results.length === 2 && page2.results[0].lemma === all.results[2].lemma, 'offset pages through results ("Show more")');
  check(searchEnglish(index, 'to teach').results[0]?.lemma === '가르치다', '"to teach" → 가르치다 first');
  check(searchEnglish(index, 'the').total === 0, 'stopword-only query matches nothing');
  const sal = searchEnglish(index, 'annual salary');
  check(sal.results[0]?.lemma === '연봉', `"annual salary" → 연봉 first (got ${sal.results[0]?.lemma})`);
});

group('Lemma Master literal filter (AS4, AS-D22)', (check) => {
  const f = (q) => filterLemmaMaster(index, q);
  const tierOf = (r, lemma) => r.tiers.findIndex(t => t.some(e => e.lemma === lemma));
  const all = f('');
  check(all.mode === 'all' && all.total === LM.length, 'empty filter returns every entry');
  const ga = f('가르');
  check(ga.mode === 'ko' && ga.tiers[0].length === 0, '가르: no exact match');
  check(['가르치다', '가르침', '가르다', '가르쳐 주다'].every(l => tierOf(ga, l) === 1), '가르: the 가르- family is in the starts-with tier');
  check(tierOf(ga, '치다') === -1, '가르: 치다 is not a literal match');
  const exact = f('가르치다');
  check(exact.tiers[0].length === 1 && exact.tiers[0][0].lemma === '가르치다', '가르치다: exact tier first');
  check(tierOf(f('갈'), '가르치다') === 1 && tierOf(f('갈'), '가리다') === 1, '갈 (mid-syllable) already matches 가르치다 and 가리다 as starts-with');
  check(tierOf(f('주먹을 날리다'), '(주먹을) 날리다') === 0, '주먹을 날리다: exact match on the collocation');
  check(tierOf(f('주먹을날리다'), '(주먹을) 날리다') === 0, 'spacing ignored');
  const nal = f('날리다');
  check(tierOf(nal, '날리다') === 0 && tierOf(nal, '(주먹을) 날리다') === 2, '날리다: exact 날리다, collocation in contains');
  check(tierOf(f('입사하'), '입사(하다)') === 1, '입사하: optional ending matches as starts-with');
  check(tierOf(f('보장되다'), '보장하다 / 보장되다') === 0, '보장되다: exact via slash variant');
  check(tierOf(f('(주먹'), '(주먹을) 날리다') === 1, 'raw text with a parenthesis still matches');
  check(tierOf(f('안정되다'), '안정') === 3, '안정되다: found in 안정\'s definition text');
  check(tierOf(f('가르치다'.normalize('NFD')), '가르치다') === 0, 'decomposed (NFD) input');
  const en = f('teach');
  check(en.mode === 'en' && tierOf(en, '가르치다') === 0 && tierOf(en, '가르침') === 0, 'teach: def2 matches in the first tier');
  check(tierOf(f('stab'), '안정') === 0, 'stab (half-typed) finds stability');
  check(tierOf(f('afr'), '두렵다') === 0, 'afr (half-typed) finds afraid');
  check(f('found').total === 0 && f('definition').total === 0, 'the KRDict placeholder never matches');
  check(tierOf(f('annual salary'), '연봉') === 0 && tierOf(f('annual salary'), '높다') === -1, 'every English word must match');
  check(tierOf(f('acrophobia'), '고소공포증') === 1, 'def1-only match lands in the second tier');
  check(f('a').mode === 'en' && f('a').total > 0, 'a single letter falls back to plain text matching');
});

group('incremental rebuild (entry cache)', (check) => {
  // A pin replaces two Lemma Master objects (immutable update). The rebuilt
  // index must reflect the new relation — the cache keys on object identity.
  const base = LM.map(l => ({ ...l }));
  const i1 = buildLemmaIndex(base);
  const a = base.find(l => l.lemma === '먹다'), b = base.find(l => l.lemma === '먹이');
  check(!relatedLemmas(i1, a.lemmaID).pinned.some(x => x.lemma === '먹이'), 'before: 먹이 not pinned for 먹다');
  const next = base.map(l => l === a ? { ...l, relatedForm: b.lemmaID } : l === b ? { ...l, relatedForm: a.lemmaID } : l);
  const i2 = buildLemmaIndex(next);
  check(relatedLemmas(i2, a.lemmaID).pinned.some(x => x.lemma === '먹이' && x.pinForm), 'after: 먹이 pinned (Form) for 먹다');
  check(!relatedLemmas(i2, a.lemmaID).candidates.some(x => x.lemma === '먹이'), 'after: 먹이 left the candidates');
  check(!relatedLemmas(i1, a.lemmaID).pinned.some(x => x.lemma === '먹이'), 'the old index is unchanged');
  const edited = next.map(l => l.lemma === '가르침' ? { ...l, lemma: '가르침말' } : l);
  check(resolveKorean(buildLemmaIndex(edited), '가르침말').entry?.lemma === '가르침말', 'an edited lemma resolves under its new text');
  check(resolveKorean(buildLemmaIndex(edited), '가르침').entry === null, 'and no longer under its old text');
});

// ── Performance (not a semantic case; generous gates) ────────
group('performance (5,000 synthetic entries)', (check) => {
  const words = ['teach', 'eat', 'go', 'see', 'buy', 'state', 'action', 'high', 'salary', 'stable', 'cover', 'divide', 'improve', 'join', 'company', 'fear', 'scary', 'school', 'water', 'light'];
  let s = 12345;
  const rnd = (n) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };
  const syl = () => String.fromCharCode(0xAC00 + rnd(11172));
  const big = [];
  for (let i = 0; i < 5000; i++) {
    const len = 1 + rnd(3);
    let lemma = ''; for (let j = 0; j < len; j++) lemma += syl();
    if (rnd(2)) lemma += '다';
    if (rnd(10) === 0) lemma = syl() + syl() + '이 ' + lemma;
    big.push({ lemmaID: 'p' + i, lemma, def2: `to ${words[rnd(20)]} ${words[rnd(20)]}`, def1: `1. ${words[rnd(20)]}: ${words[rnd(20)]} ${words[rnd(20)]} ${words[rnd(20)]}.` });
  }
  let t = performance.now();
  const bi = buildLemmaIndex(big);
  const tIndex = performance.now() - t;
  // Rebuild after a pin: two objects replaced, the rest served from the cache.
  const pinned = big.map((l, k) => k === 10 || k === 20 ? { ...l, relatedForm: 'p' + (30 - k) } : l);
  t = performance.now();
  buildLemmaIndex(pinned);
  const tRebuild = performance.now() - t;
  t = performance.now();
  for (let k = 0; k < 5; k++) relatedLemmas(bi, 'p' + k * 97);
  const tRel = (performance.now() - t) / 5;
  t = performance.now();
  searchEnglish(bi, 'teach company');
  const tEn = performance.now() - t;
  t = performance.now();
  resolveKorean(bi, '가나다라마');
  const tMiss = performance.now() - t;
  console.log(`      index ${tIndex.toFixed(0)}ms · rebuild after pin ${tRebuild.toFixed(0)}ms · related ${tRel.toFixed(0)}ms · english ${tEn.toFixed(0)}ms · miss+suggest ${tMiss.toFixed(0)}ms`);
  check(tIndex < 2000, `index build under 2s (${tIndex.toFixed(0)}ms)`);
  check(tRebuild < tIndex / 3, `rebuild after a pin uses the cache (${tRebuild.toFixed(0)}ms vs ${tIndex.toFixed(0)}ms)`);
  check(tRel < 400, `related under 400ms (${tRel.toFixed(0)}ms)`);
  check(tEn < 200, `English under 200ms (${tEn.toFixed(0)}ms)`);
  check(tMiss < 400, `miss + suggestions under 400ms (${tMiss.toFixed(0)}ms)`);
});

// ── Report ────────────────────────────────────────────────────
for (const [name, n, misses] of groups) {
  console.log(`${misses.length === 0 ? 'PASS' : 'FAIL'}  ${name}  (${n - misses.length}/${n})`);
  for (const m of misses) console.log(`      ${m}`);
}
await rm(dir, { recursive: true, force: true });
console.log(`\n${total - failures}/${total} cases pass`);
process.exit(failures ? 1 : 0);
