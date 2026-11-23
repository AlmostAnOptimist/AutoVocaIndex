// tests/heuristics-golden.mjs
// Golden test set for the lemma heuristics (extractLemmaCandidates,
// extractLemmaFromText, seedMappingPlausible) in src/utils/aviUtils.js.
//
// Run from the repo root:   node tests/heuristics-golden.mjs
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
  export const serverTimestamp = () => null; // cardStamp.js, reached through aviUtils (audit B4c)
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
  'Stage D — past + polite endings': [
    ['먹었어요', '먹다'], ['읽었어요', '읽다'], ['좋았어요', '좋다'],
    ['앉았어요', '앉다'], ['재미있었어요', '재미있다'], ['들었어요', '듣다'],
    ['걸었어요', '걷다'], ['나았어요', '낫다'], ['됐어요', '되다'],
    ['예뻤어요', '예쁘다'], ['바빴어요', '바쁘다'], ['썼어요', '쓰다'],
    ['보냈어요', '보내다'], ['지냈어요', '지내다'], ['도왔어요', '돕다'],
    ['쉬웠어요', '쉽다'], ['놨어요', '놓다'], ['갔어요', '가다'],
    ['봤어요', '보다'], ['했어요', '하다'], ['갔었어요', '가다'],
    ['먹었었어요', '먹다'], ['먹었네요', '먹다'], ['먹었죠', '먹다'],
    ['먹었지요', '먹다'], ['먹었는데요', '먹다'], ['먹었거든요', '먹다'],
    ['먹었잖아요', '먹다'], ['먹었을까요', '먹다'], ['먹었나요', '먹다'],
    ['먹었대요', '먹다'], ['간대요', '가다'], ['먹었다고요', '먹다'],
    ['친구였어요', '친구'], ['학생이었어요', '학생'],
  ],
  // L3 (lemma repair, Oct 2026) — a real Oct 2026 import's failures
  // plus siblings of each rule.
  'L3 — stacked particles': [
    ['봄에는', '봄'], ['동쪽에는', '동쪽'], ['한가운데에는', '한가운데'],
    ['대중교통으로는', '대중교통'], ['해녀들이', '해녀'], ['학교에서는', '학교'],
    ['친구들과', '친구'], ['사람들을', '사람'], ['집에도', '집'],
    ['서울까지는', '서울'], ['친구들에게는', '친구'], ['바다에서도', '바다'],
    ['큰아들부터', '큰아들'], ['능멸하고도', '능멸하다'], ['친구하고도', '친구'],
  ],
  'L3 — ㅎ-irregular attributives': [
    ['그런', '그렇다'], ['이런', '이렇다'], ['어떤', '어떻다'], ['빨간', '빨갛다'],
  ],
  'L3 — 마다, (이)나, (이)라서, copula 인': [
    ['계절마다', '계절'], ['날마다', '날'], ['초콜릿이나', '초콜릿'],
    ['면허증이나', '면허증'], ['커피나', '커피'], ['성수기라서', '성수기'],
    ['학생이라서', '학생'], ['비수기인', '비수기'], ['돌인', '돌'], ['산인', '산'],
    ['모자라서', '모자라다'], ['고양이나', '고양이'], ['고양이라서', '고양이'],
  ],
  'L3 — 다면 / 라면': [
    ['원한다면', '원하다'], ['부담스럽다면', '부담스럽다'], ['먹는다면', '먹다'],
    ['간다면', '가다'], ['좋다면', '좋다'], ['학생이라면', '학생'], ['친구라면', '친구'],
  ],
  'L3 — 는 after a consonant stem': [
    ['넘는', '넘다'], ['않는', '않다'], ['먹는', '먹다'], ['읽는', '읽다'], ['있는', '있다'],
  ],
  'L3 — ㄷ-irregular before 으': [
    ['걸으러', '걷다'], ['들으면', '듣다'], ['물으니까', '묻다'],
    ['걸으면서', '걷다'], ['들은', '듣다'], ['들을', '듣다'],
  ],
  'L3 — ㅕ→ㅣ and ㅙ→ㅚ restores': [
    ['지켜야', '지키다'], ['지켜서', '지키다'], ['돼서', '되다'], ['돼요', '되다'],
    ['기다려요', '기다리다'], ['가르쳐요', '가르치다'], ['돼야', '되다'],
  ],
  'L3 — short stems (기, 게, 고)': [
    ['가기', '가다'], ['쉽게', '쉽다'], ['읽고', '읽다'], ['있고', '있다'],
    ['쉬워질', '쉬워지다'], ['못할', '못하다'], ['만든', '만들다'], ['잡은', '잡다'],
    ['낮은', '낮다'], ['내려오는', '내려오다'], ['올라가', '올라가다'], ['긴', '길다'],
  ],
  // LM2 (Nov 2026) — the plain statement ㄴ다/는다 with an ending after it.
  // On a vowel stem the ㄴ is fused into the last syllable (쓴다가, 간다는);
  // only 다면/다고/대 used to undo it. ㄹ stems lose their ㄹ (만든다가).
  'LM2 — fused ㄴ다 + ending': [
    ['쓴다가', '쓰다'], ['한다가', '하다'], ['만든다가', '만들다'],
    ['간다는', '가다'], ['간다며', '가다'], ['쓴다면서', '쓰다'],
    ['한다니', '하다'], ['한다니까', '하다'], ['간다지만', '가다'],
    ['간다던', '가다'], ['간다는데', '가다'], ['산다는', '사다'], ['산다는', '살다'],
    ['먹는다가', '먹다'], ['먹는다는', '먹다'], ['읽는다며', '읽다'],
    ['먹는다니까', '먹다'], ['먹는다는데', '먹다'],
  ],
  // LM3 (Nov 18 2026) — bare ㄴ다 with nothing after it. 한다/된다 are a
  // table rule (see PRIMARY); other vowel stems get validated candidates,
  // and the resolver keeps a surface that is a dictionary word itself
  // (판다, 안다; tests/lemma-resolver-golden.mjs).
  'LM3 — bare fused ㄴ다': [
    ['간다', '가다'], ['만난다', '만나다'], ['쓴다', '쓰다'], ['만든다', '만들다'],
    ['산다', '사다'], ['산다', '살다'], ['기다린다', '기다리다'], ['한다', '하다'],
    ['된다', '되다'], ['안다', '알다'],
  ],
  'LM2 — 깨나': [
    ['힘깨나', '힘'], ['돈깨나', '돈'], ['고생깨나', '고생'],
  ],
};

// LM4 (Nov 20 2026) — the endings sweep. 'surface>lemma' pairs: the lemma
// must be among the candidates the resolver actually checks against the
// dictionary (the first RANK_LIMIT after the surface itself; keep it equal
// to GLM_CANDIDATE_CHECKS in aviUtils.js). Before LM4 the rules offered the
// right lemma for about a third of these.
const RANK_LIMIT = 10;
const RANKED_CASES = {
  'LM4 — quote marks around the word': `
    출신이었어?">출신 “출신이었어?”>출신 '먹었어.'>먹다 "했더니>하다 「갔더니」>가다 학생이에요!">학생`,
  'LM4 — 느라(고)': `
    하느라>하다 먹느라>먹다 공부하느라고>공부하다 기다리느라>기다리다 만드느라>만들다
    찾느라고>찾다 사느라>살다 사느라>사다 노느라>놀다 듣느라>듣다`,
  'LM4 — 니': `
    보니>보다 먹으니>먹다 가니>가다 좋으니>좋다 했으니>하다 사니>살다 사니>사다 들으니>듣다
    더우니>덥다 지으니>짓다 만드니>만들다 예쁘니>예쁘다 하니>하다 먹니>먹다 했니>하다
    멍하니>멍하다 하느니>하다 하다니>하다`,
  'LM4 — 군, 구나': `
    그렇군>그렇다 그렇군요>그렇다 예쁘군>예쁘다 가는군>가다 가는군요>가다 먹는군>먹다
    했군>하다 했군요>하다 먹었군요>먹다 그렇구나>그렇다 가는구나>가다 먹는구나>먹다
    했구나>하다 좋구나>좋다 좋겠군>좋다 사는군요>살다 만드는구나>만들다 하구먼>하다
    하는군요>하다 하더군요>하다 좋더군>좋다 하구요>하다`,
  'LM4 — 더라, 더니, 던': `
    하더라>하다 먹더라>먹다 좋더라>좋다 가더라고>가다 가더라고요>가다 했더라>하다
    먹었더라고요>먹다 예쁘더라구요>예쁘다 하더라도>하다 먹더라도>먹다 하더니>하다
    먹더니>먹다 했더니>하다 갔더니>가다 들었더니>듣다 하던데>하다 먹던데요>먹다 했던>하다
    하던>하다 먹던>먹다 먹었던>먹다 하더니만>하다 했더라면>하다 하던가>하다
    만들더라>만들다 하였던>하다`,
  'LM4 — 이다 after a noun': `
    비명이다>비명 학생이다>학생 친구다>친구 책이다>책 출신이었어>출신 출신이었다>출신
    학생이었어요>학생 집이었다>집 친구였어>친구 친구였다>친구 친구였어요>친구
    학생이야>학생 돈이야>돈 친구야>친구 학생이에요>학생 친구예요>친구 고양이에요>고양이
    고양이였다>고양이 학생입니다>학생 친구입니다>친구 학생인데>학생 친구인데>친구
    아이인데>아이 학생이지만>학생 친구지만>친구 학생이고>학생 친구고>친구
    학생이니까>학생 친구니까>친구 학생이라고>학생 학생일>학생 학생이었던>학생
    학생이었는데>학생 학생이었지만>학생 학생이지>학생 학생이죠>학생 학생이네>학생
    학생이네요>학생 학생이잖아>학생 학생이거든>학생 학생이면>학생 학생이어서>학생
    학생이라>학생 친구라서>친구 친구라도>친구 학생이라도>학생 학생이었으니까>학생
    학생이겠지>학생 학생일까>학생 학생인가>학생 학생인지>학생 학생이란>학생
    학생이며>학생 학생이자>학생 것이다>것 거야>거 때문이다>때문 때문이야>때문
    사람이었다>사람 학생이더라>학생 학생이군요>학생 학생이구나>학생
    선생님이세요>선생님 선생님이셨다>선생님 의사세요>의사 택시니까>택시 낚시고>낚시`,
  'LM4 — 이다 verbs keep themselves': `
    보이고>보이다 먹이고>먹이다 움직였다>움직이다 보입니다>보이다 높였다>높이다
    보였어요>보이다 끄덕이며>끄덕이다 속였다>속이다`,
  'LM4 — (으)려': `
    하려다>하다 하려다가>하다 먹으려다>먹다 먹으려다가>먹다 가려다가>가다
    만들려다>만들다 들으려다가>듣다 도우려다>돕다 지으려다>짓다 하려고>하다
    먹으려고>먹다 하려는>하다 먹으려는>먹다 하려면>하다 먹으려면>먹다 가려면>가다
    하려던>하다 하려니>하다 하려니까>하다 하려는데>하다 가려고요>가다 하려>하다
    먹으려>먹다 할려고>하다 먹을려고>먹다 하려나>하다 하려무나>하다 하렴>하다`,
  'LM4 — honorific 시': `
    하시다>하다 하신다>하다 하셨다>하다 하셨어요>하다 하세요>하다 하십니다>하다
    하시는>하다 하신>하다 하실>하다 하시고>하다 하시면>하다 하셔서>하다 가셨어요>가다
    오시는>오다 읽으시다>읽다 읽으셨어요>읽다 읽으세요>읽다 좋으시다>좋다
    계세요>계시다 계셨다>계시다 주무세요>주무시다 드세요>들다 말씀하셨다>말씀하다
    하십시오>하다 앉으십시오>앉다 가시죠>가다 아시다>알다 아세요>알다 만드세요>만들다
    들으세요>듣다 도우세요>돕다 마셨다>마시다 마시고>마시다 모셨어요>모시다
    만드셨어요>만들다 들으셨어요>듣다 도우셨어요>돕다 하시는데>하다 하시지만>하다`,
  'LM4 — formal': `
    합니다>하다 먹습니다>먹다 합니까>하다 먹습니까>먹다 했습니다>하다 먹었습니다>먹다
    갑니다>가다 삽니다>살다 삽니다>사다 좋습니다>좋다 하겠습니다>하다
    감사합니다>감사하다 합시다>하다 먹읍시다>먹다 갑시다>가다 만듭시다>만들다
    하였다>하다 하였습니다>하다 하여>하다 대하여>대하다 관하여>관하다`,
  'LM4 — connectives': `
    하자마자>하다 먹자마자>먹다 만들자마자>만들다 하도록>하다 먹도록>먹다 하든지>하다
    하거나>하다 먹거나>먹다 하길래>하다 하기에>하다 하다시피>하다 알다시피>알다
    하듯이>하다 하듯>하다 할수록>하다 먹을수록>먹다 만들수록>만들다 들을수록>듣다
    예쁠수록>예쁘다 하면서>하다 먹으면서>먹다 하며>하다 먹으며>먹다 들으며>듣다
    하므로>하다 먹으므로>먹다 하고서>하다 하고자>하다 하다가>하다 했다가>하다
    먹었다가>먹다 하건>하다 하건만>하다 먹지만>먹다 하는데>하다 먹는데>먹다
    좋은데>좋다 예쁜데>예쁘다 할지라도>하다 하자면>하다 하거든>하다 먹거든요>먹다
    하고는>하다 하고도>하다 해도>하다 먹어도>먹다 해야>하다 먹어야>먹다 해서>하다
    먹어서>먹다 하러>하다 먹으러>먹다 하든>하다 하되>하다 하거니와>하다 하건대>하다
    하노라>하다 하리라>하다 하는지라>하다 한지라>하다 할망정>하다 할뿐더러>하다`,
  'LM4 — clause endings': `
    하지>하다 하게>하다 먹게>먹다 하기>하다 먹기>먹다 먹음>먹다 했음>하다 하다고>하다
    했다고>하다 하자고>하다 하라고>하다 먹으라고>먹다 하냐고>하다 하느냐고>하다
    한대>하다 한대요>하다 하래>하다 하재>하다 한다는>하다 했다는>하다 하라는>하다
    하자는>하다 하는지>하다 했는지>하다 먹는지>먹다 만드는지>만들다 할지>하다
    먹을지>먹다 좋은지>좋다 예쁜지>예쁘다 했었다>하다 했었어요>하다 하겠다>하다
    하겠어요>하다 먹겠지>먹다 했겠다>하다 할게>하다 할게요>하다 먹을게요>먹다
    할래>하다 할래요>하다 먹을래요>먹다 할까>하다 할까요>하다 먹을까>먹다 할걸>하다
    먹을걸>먹다 할텐데>하다 먹을텐데>먹다 하네>하다 하네요>하다 먹네요>먹다
    하잖아>하다 하잖아요>하다 했잖아>하다 하는걸>하다 하나요>하다 먹나요>먹다
    하는가>하다 한가>하다 좋은가요>좋다 예쁜가요>예쁘다 하냐>하다 하느냐>하다
    했냐>하다 해라>하다 먹어라>먹다 하자>하다 먹자>먹다 하지요>하다 하죠>하다
    하고요>하다 하려나>하다 하기는>하다 하기도>하다 하기만>하다 하기를>하다
    하길>하다 하기가>하다 먹기에는>먹다 하기엔>하다 함으로써>하다 했으면>하다
    했으면서>하다 했는데>하다 했지만>하다 했어도>하다 했거든>하다 했나>하다
    했네>하다 했지>하다 했죠>하다 했대>하다 했을>하다 했을까>하다 했을텐데>하다`,
  'LM4 — one-syllable nouns, ㅂ-irregulars, a dropped ㄹ, quotes, 야겠': `
    집에>집 앞에>앞 말로>말 손과>손 개와>개 위의>위 집까지>집 물처럼>물 누워서>눕다
    도와서>돕다 추워도>춥다 만드는데>만들다 만드니까>만들다 아니까>알다 사는데>살다
    만드는>만들다 학생일>학생 친구라도>친구 죽일려면>죽이다 해야겠군요>하다
    먹어야겠다>먹다 봐야겠어요>보다 간다던데>가다 예쁘다더라>예쁘다 있다는걸>있다
    학생이라던데>학생 어땠는지>어떻다 컸던>크다 알아냈는지>알아내다 미친듯이>미치다
    맙시다>말다 애도하렵니다>애도하다 데려다>데리다 내려다>내리다`,
};

// LM2: candidates that must NOT be offered. (LM3 removed 판다 → 파다/팔다:
// bare ㄴ다 readings are now offered, and the resolver keeps a surface that
// is itself a dictionary word; see tests/lemma-resolver-golden.mjs.)
const NOT_OFFERED_CASES = [
  ['먹는다', '먹느다'], ['먹는다', '먹늘다'], ['해석한다', '해석할다'], ['한다', '할다'],
  ['시작된다', '시작될다'], ['바다', '바'],
];

// LM2: [surface, first, second] — first must be offered ahead of second,
// because the resolver takes the first candidate the dictionary confirms.
// A noun + particle keeps its noun ahead of a fused-ㄴ reading; 어깨나 is
// 어깨 + 나, not 어 + 깨나.
const ORDER_CASES = [
  ['판다가', '판다', '파다'], ['판다는', '판다', '팔다'], ['신다가', '신다', '시다'],
  ['어깨나', '어깨', '어'], ['참깨나', '참깨', '참'],
  // LM3: the 4d attributive reading and the bare-ㄴ다 reading agree on order.
  ['산다', '사다', '살다'], ['만든다', '만드다', '만들다'],
  // LM4: a verb that ends in 이다 is offered ahead of the noun reading
  // (보이고 is 보이다, not 보 + 이고); the plain verb ahead of an honorific
  // look-alike (가셨어요 is 가다 before 가시다); the noun ahead of junk.
  ['보이고', '보이다', '보'], ['먹이고', '먹이다', '먹'], ['보입니다', '보이다', '보'],
  ['가셨어요', '가다', '가시다'], ['친구나', '친구', '친다'], ['누구나', '누구', '누다'],
  ['학생이고', '학생이다', '학생'],
  // LM4: an unsure new reading never gets ahead of what the older blocks
  // offer: 달려 is 달리다 before 달 + 려, 따라 is 따르다 before 따 + 라.
  ['달려', '달리다', '달다'], ['따라', '따르다', '따다'], ['내려', '내리다', '내다'],
  ['실려', '실리다', '시다'], ['바래', '바라다', '바다'],
];

// Stage D — the heuristic primary is what gets saved when no candidate
// validates, so unambiguous past forms must land on the headword itself
// (the old table rule de-contracted 먹었다 to 먹어다).
const PRIMARY_CASES = [
  ['먹었어요', '먹다'], ['읽었어요', '읽다'], ['좋았어요', '좋다'],
  ['앉았어요', '앉다'], ['재미있었어요', '재미있다'], ['있었어요', '있다'],
  ['됐어요', '되다'], ['갔었어요', '가다'], ['먹었었어요', '먹다'],
  ['먹었죠', '먹다'], ['먹었지요', '먹다'], ['먹었는데요', '먹다'],
  ['먹었거든요', '먹다'], ['먹었잖아요', '먹다'], ['먹었을까요', '먹다'],
  ['갔어요', '가다'], ['했어요', '하다'], ['먹었습니다', '먹다'],
  ['먹었다', '먹다'], ['몰랐어요', '모르다'],
  // L3: deterministic shapes land on the headword even before validation.
  ['넘는', '넘다'], ['않는', '않다'], ['걸으러', '걷다'], ['들으면', '듣다'],
  ['부담스럽다면', '부담스럽다'], ['먹는다면', '먹다'], ['계절마다', '계절'],
  ['초콜릿이나', '초콜릿'], ['학생이라서', '학생'], ['학생이라면', '학생'],
  // LM2: 는다 after a consonant stem is unambiguous.
  // A noun + 가 keeps its noun as the primary (판다가 is not 파다).
  ['먹는다가', '먹다'], ['먹는다는', '먹다'], ['읽는다며', '읽다'],
  ['먹는다니까', '먹다'], ['먹는다는데', '먹다'],
  ['판다가', '판다'],
  // LM3: 한다/된다 are always 하다/되다 (no noun ends in them).
  ['해석한다', '해석하다'], ['공부한다', '공부하다'], ['시작된다', '시작되다'],
  ['해석된다', '해석되다'], ['원한다', '원하다'], ['안된다', '안되다'],
  // LM4: endings that only ever follow a verb or adjective stem land on
  // the dictionary form without the dictionary's help.
  ['먹느라', '먹다'], ['공부하느라고', '공부하다'], ['하더라고요', '하다'], ['했더니', '하다'],
  ['먹던데요', '먹다'], ['먹더라도', '먹다'], ['했던', '하다'], ['먹자마자', '먹다'],
  ['먹도록', '먹다'], ['먹으려다가', '먹다'], ['들으려다가', '듣다'], ['하려던', '하다'],
  ['먹으려는', '먹다'], ['하려면', '하다'], ['먹으니', '먹다'], ['들으니', '듣다'],
  ['지으니', '짓다'], ['먹으며', '먹다'], ['먹으므로', '먹다'], ['가는군요', '가다'],
  ['했군요', '하다'], ['좋겠군요', '좋다'], ['먹는구나', '먹다'], ['했구나', '하다'],
  ['먹을수록', '먹다'], ['먹을게요', '먹다'], ['먹을지', '먹다'], ['좋은지', '좋다'],
  ['먹는지', '먹다'], ['했는지', '하다'], ['먹읍시다', '먹다'], ['합시다', '하다'],
  ['갑니다', '가다'], ['합니까', '하다'], ['감사합니다', '감사하다'], ['하십시오', '하다'],
  ['읽으셨어요', '읽다'], ['하셨어요', '하다'], ['가셨어요', '가다'], ['읽으세요', '읽다'],
  ['마셨다', '마시다'], ['모셨어요', '모시다'], ['계세요', '계시다'], ['주무세요', '주무시다'],
  ['하였다', '하다'], ['하였습니다', '하다'], ['대하여', '대하다'], ['하다시피', '하다'],
  ['하길래', '하다'], ['하든지', '하다'], ['하거니와', '하다'], ['할텐데', '하다'],
  ['먹어라', '먹다'], ['먹었더라고요', '먹다'], ['하더군요', '하다'],
  // LM4: copula shapes no verb takes land on the noun.
  ['출신이었어', '출신'], ['출신이었다', '출신'], ['학생이었어요', '학생'], ['학생이에요', '학생'],
  ['학생이야', '학생'], ['학생인데', '학생'], ['학생인지', '학생'], ['학생이군요', '학생'],
  ['학생이구나', '학생'], ['학생이란', '학생'], ['학생이라도', '학생'],
  // LM4: quote marks no longer stop the rules.
  ['출신이었어?"', '출신'], ['“먹었어요.”', '먹다'], ["'했더니", '하다'],
  // LM4: a ㄹ stem that drops its ㄹ, 아/어야겠, and nouns the new endings
  // must leave to the table (사건 + 만, 사람 + 으로써).
  ['만드는데', '만들다'], ['맙시다', '말다'], ['먹어야겠다', '먹다'], ['해야겠군요', '하다'],
  ['사건만', '사건'], ['사람으로써', '사람'],
];

// Words the suffix table must never touch: primary result stays identity.
// (Bare nouns like 이야기 that a naive strip WOULD touch are protected at
// the system level by trusted identity rows in the map, not here.)
const IDENTITY_CASES = [
  '시험', '안정', '사람', '시간', '살해', '혐의', '황새', '맛있다', '재미있다',
  // Stage B collision guards: the new table entries must leave these
  // untouched (candidate-tier siblings are fine; blind mangling is not).
  '컨트롤러', '트레일러', '사고', '과자', '여자', '바지', '동네',
  // L3 collision guards: nouns that end in a particle-like syllable.
  '도로', '사과', '아들', '미로', '기와', '고구마', '바나나', '피아노',
  // L3: the copula-이 rules must not split a vowel-final noun ending in 이
  // (고양이나 can't be protected here — 고양 is consonant-final — so the
  // resolver prefers the 이-noun when both validate; see the candidates).
  '아이라서',
  // LM2: 깨나 is never stripped blind (어깨나 is 어깨 + 나; 깨나 alone is
  // the verb 깨다); the particle reading is a ranked candidate.
  '깨나', '판다', '어깨나', '힘깨나',
  // LM4: nouns and adverbs that end like one of the new endings.
  '어머니', '언니', '주머니', '바구니', '고니', '멍하니', '우두커니', '장군', '누군',
  '택시', '도시', '접시', '낚시', '편지', '먼지', '일지', '믿음', '웃음', '하마', '하나',
  '창고', '누구나', '모든', '반듯', '나라', '소라', '아니', '보이다', '움직이다', '비명이다',
  '갈수록', '되도록', '그러니', '아무래도', '어쨌든', '아무튼', '그다지',
  '파일', '사실', '아래', '수요일', '아시아', '보고서', '노래', '집에', '사과', '지도',
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

for (const [group, text] of Object.entries(RANKED_CASES)) {
  const cases = text.trim().split(/\s+(?=\S*>)/).map(p => { const i = p.lastIndexOf('>'); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; });
  const misses = [];
  for (const [surface, expected] of cases) {
    total++;
    const all = extractLemmaCandidates(surface);
    const checked = all.filter(c => c && c !== surface).slice(0, RANK_LIMIT);
    if (!checked.includes(expected)) { failures++; misses.push([surface, expected, all]); }
  }
  const n = cases.length;
  console.log(`${misses.length === 0 ? 'PASS' : 'FAIL'}  ${group}  (${n - misses.length}/${n})`);
  for (const [s, e, c] of misses) console.log(`      ${s} → expected ${e} in the first ${RANK_LIMIT}, got [${c.join(', ')}]`);
}

{
  const misses = [];
  for (const [surface, banned] of NOT_OFFERED_CASES) {
    total++;
    const cands = extractLemmaCandidates(surface);
    if (cands.includes(banned)) { failures++; misses.push([surface, banned, cands]); }
  }
  const n = NOT_OFFERED_CASES.length;
  console.log(`${misses.length === 0 ? 'PASS' : 'FAIL'}  LM2 — not offered  (${n - misses.length}/${n})`);
  for (const [s, b, c] of misses) console.log(`      ${s} → must not offer ${b}, got [${c.join(', ')}]`);
}

{
  const misses = [];
  for (const [surface, first, second] of ORDER_CASES) {
    total++;
    const cands = extractLemmaCandidates(surface);
    const a = cands.indexOf(first), b = cands.indexOf(second);
    if (a < 0 || (b >= 0 && b < a)) { failures++; misses.push([surface, first, second, cands]); }
  }
  const n = ORDER_CASES.length;
  console.log(`${misses.length === 0 ? 'PASS' : 'FAIL'}  LM2 — candidate order  (${n - misses.length}/${n})`);
  for (const [s, a, b, c] of misses) console.log(`      ${s} → ${a} must come before ${b}, got [${c.join(', ')}]`);
}

{
  const misses = [];
  for (const [surface, expected] of PRIMARY_CASES) {
    total++;
    const primary = extractLemmaFromText(surface);
    if (primary !== expected) { failures++; misses.push([surface, expected, primary]); }
  }
  console.log(`${misses.length === 0 ? 'PASS' : 'FAIL'}  Stage D — heuristic primary  (${PRIMARY_CASES.length - misses.length}/${PRIMARY_CASES.length})`);
  for (const [s, e, p] of misses) console.log(`      ${s} → expected ${e}, primary ${p}`);
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
    // L3: bare adverbs that also look like conjugations (안다, 다다, 없다…)
    '안', '못', '다', '잘', '없이', '곧', '늘', '좀', '꼭', '또', '더',
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
