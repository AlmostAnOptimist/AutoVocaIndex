// src/utils/aviUtils.js
// Shared utility functions for all AVI tabs.
// Pure functions (normalizeLemma, cleanStagingText, extractLemmaFromText, etc.)
// plus Firebase helpers (lookupGlobalLemma, writeGlobalLemma)
// and definition fetching (fetchDefinition).
//
// fetchDefinition is simplified:
//   - Always serverless
//   - No client-side API key checks (keys live in Netlify env vars)
//   - Four active modes: krdict, krdict-ko, krdict-bi, api (Claude)

import { doc, getDoc, setDoc, writeBatch } from 'firebase/firestore';
import { toDateStr, computeStreak, logicalDateOf } from './dateUtils.js';
import { db } from '../firebase.js';
import { DEMO } from '../demo/demoConfig.js';
import { withCardStamp } from './cardStamp.js';
import { apiFetch } from './apiFetch.js';

// ── UUID ─────────────────────────────────────────────────────
export function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ── normalizeLemma ────────────────────────────────────────────
// Strips quotes, zero-width chars, usage annotations, tilde markers,
// Hanja brackets, trailing punctuation, and Korean-safe parentheticals.
export function normalizeLemma(s) {
  if (!s) return '';
  // NFC first: decomposed Hangul (jamo sequences) renders identically to
  // composed syllables but fails string equality — normalize before any
  // comparison so invisibly-different encodings can never split a lemma.
  s = String(s).normalize('NFC').trim();
  s = s.replace(/^[\s"'\u201C\u201D\u2018\u2019\u300C\u300E\u3008\u300A]+/, '')
       .replace(/[\s"'\u201C\u201D\u2018\u2019\u300D\u300F\u3009\u300B]+$/, '');
  s = s.replace(/\uFEFF|\u200B|\u200C|\u200D/g, '');
// Leading parenthetical: mirror the trailing rule — Hangul content is a
  // meaningful annotation ("(주먹을) 날리다" is a distinct collocation lemma,
  // not the same lemma as 날리다), so keep it in the normalized form;
  // non-Hangul content ("(1)", "(verb)") is dictionary noise and strips.
  s = s.replace(/^\(([^)]*)\)\s*/, (m, inner) => /[가-힣]/.test(inner) ? inner + ' ' : '');
  s = s.replace(/^~\S*\s*/, '');
  s = s.replace(/\s*\[[^\]]*\]\s*$/, '');
  s = s.replace(/[\s.,:;!?~\u2026\u00B7\u30FB\u3001\u3002\uFF0C\uFF0E\uFF01\uFF1F\uFF1A\uFF1B\uFF5E\u300D\u300F\u3009\u300B-]+$/, '');
  s = s.replace(/\s*\([^)]*\)\s*$/, (m) => {
    const inner = m.replace(/^\s*\(/, '').replace(/\)\s*$/, '');
    return /[가-힣]/.test(inner) ? ' ' + inner : '';
  });
  return s.replace(/\s+/g, ' ').trim();
}

// ── expandParenTerms ─────────────────────────────────────────
// Expands "word(suffix)" → ["word", "wordsuffix"].
function expandParenTerms(s) {
  const str = String(s || '').trim();
  if (!str) return [];
  const pm = str.match(/^([^()]+)\(([^()]+)\)$/);
  if (pm) {
    const base   = (pm[1] || '').trim();
    const inside = (pm[2] || '').trim();
    const out = [];
    if (base) out.push(base);
    if (base && inside) out.push(base + inside);
    return out;
  }
  return [str];
}

// ── buildFetchTerms ───────────────────────────────────────────
// Builds a list of dictionary lookup terms from a lemma,
// handling "/" splits and "(suffix)" expansions.
export function buildFetchTerms(lemma) {
  const norm = normalizeLemma(lemma);
  if (!norm) return [];
  const seen  = new Set();
  const terms = [];
  const add   = (t) => { const v = t.trim(); if (v && !seen.has(v)) { seen.add(v); terms.push(v); } };
  if (norm.includes('/')) {
    norm.split('/').forEach(part => expandParenTerms(part.trim()).forEach(add));
  } else {
    expandParenTerms(norm).forEach(add);
  }
  return terms;
}

// ── buildNoisePatterns ────────────────────────────────────────
function buildNoisePatterns(noiseBlocks = []) {
  return noiseBlocks
    .map(b => String(b).trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}

// ── cleanStagingText ──────────────────────────────────────────
// Strips e-book noise, takes first non-empty paragraph,
// and collapses whitespace.
export function cleanStagingText(raw, noiseBlocks = []) {
  if (!raw && raw !== 0) return '';
  raw = String(raw);
  let n = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const patterns = buildNoisePatterns(noiseBlocks);
  for (const pat of patterns) n = n.split(pat).join('');

  const builtInRe = [
    /교보e?Book에서?[\s\S]*?(?=\n\n|\n$|$)/gi,
    /자세히\s*보기\s*:?[^\n]*/gi,
    /https?:\/\/\S+/gi,
    /www\.\S+/gi,
    /auth_token=[A-Za-z0-9\-_]+/gi,
  ];
  for (const re of builtInRe) n = n.replace(re, '');

  const blocks = n.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  let first = blocks.length > 0 ? blocks[0] : n.trim();
  first = first.replace(/교보[\s\S]*$/i, '').replace(/^\s*[:\-–—]+/, '').trim();
  first = first.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  first = first.replace(/[\s\-–—:,;]+$/, '').trim();
  return first;
}

// ── KOREAN_VERB_ENDINGS ───────────────────────────────────────
// [LANG-SPECIFIC] The heuristic de-conjugation ending table (docs/08).
// Triples: [suffix, replacement, minStemSyllables]. The original rules
// keep minStem 1 (behavior preserved); Stage 3 additions require a stem
// of at least 2 Hangul syllables so two-syllable nouns whose final
// syllable happens to look like a particle (살해, 혐의) are never mangled.
// Matching is longest-suffix-first regardless of array order.
const KOREAN_VERB_ENDINGS = [
  ['습니다','다',1], ['ㅂ니다','다',1], ['었습니다','다',1], ['았습니다','다',1],
  ['겠습니다','다',1],
  ['었다','다',1], ['았다','다',1], ['하였다','하다',1],
  ['고 있다','다',1], ['고있다','다',1],
  ['어요','다',1], ['아요','다',1], ['여요','다',1],
  ['는다','다',1], ['은다','다',1],
  ['는데','다',1], ['은데','다',1],
  ['어서','다',1], ['아서','다',1],
  ['으면','다',1], ['면','다',1],
  ['지만','다',1],
  ['으로','',1], ['에서','',1], ['에게','',1], ['에게서','',1], ['한테','',1], ['한테서','',1],
  ['으로서','',1], ['로서','',1], ['으로써','',1], ['로써','',1],
  ['이라고','',1], ['라고','',1],
  ['이라는','',1], ['라는','',1], ['처럼','',2],
  ['이가','',1], ['가','',1], ['이','',1], ['을','',1], ['를','',1],
  ['은','',1], ['는','',1],
  // Stage 3 verbalizer bigrams (minStem 2)
  ['하는','하다',2], ['되는','되다',2], ['지는','지다',2], ['리는','리다',2],
  ['치는','치다',2], ['기는','기다',2], ['우는','우다',2], ['르는','르다',2], ['이는','이다',2],
  ['하게','하다',2], ['하지','하다',2], ['하고','하다',2], ['하며','하다',2],
  ['한','하다',2], ['할','하다',2], ['해','하다',2], ['했','하다',2],
  // Stage 3 bare connectives/particles (minStem 2) — Full configuration
  ['게','다',2], ['고','다',2], ['지','다',2], ['며','다',2], ['던','다',2],
  ['의','',2], ['로','',2], ['에','',2], ['도','',2], ['만','',2],
  ['들','',2], ['과','',2], ['와','',2],
  // Stage B connective/ending coverage. minStem 1 throughout: none of
  // these strings plausibly ends a noun. Collision-prone endings (러,
  // 네(요), 나(요), 자, 지(요), 냐, 보다, fused ㄹ/ㅂ forms, quotatives)
  // live in extractLemmaCandidates as validated candidates instead.
  // Golden cases: scripts/heuristics-golden.mjs.
  ['으려고','다',1], ['려고','다',1], ['으러','다',1],
  ['으면서','다',1], ['면서','다',1],
  ['어도','다',1], ['아도','다',1], ['여도','다',1],
  ['어야','다',1], ['아야','다',1], ['여야','다',1],
  ['이니까','',1], ['으니까','다',1], ['니까','다',1],
  ['다가','다',1], ['거든','다',1], ['잖아','다',1], ['잖아요','다',1],
  ['죠','다',1], ['거나','다',1],
  ['으십니까','다',1], ['십니까','다',1], ['습니까','다',1],
  ['으십니다','다',1], ['십니다','다',1],
  ['겠다','다',1], ['겠어','다',1],
  ['으세요','다',1], ['세요','다',1],
  ['을까','다',1], ['느냐','다',1], ['으냐','다',1],
  ['께서는','',1], ['께서도','',1], ['께서','',1],
  // L3 (lemma repair, Oct 2026). 다면 used to fall to the
  // bare 면 rule and gain a second 다 (원한다면→원한다다). Fused ㄴ다면
  // (원한다면→원하다) is a validated candidate below; 는다면 is exact here.
  ['는다면','다',1], ['다면','다',1], ['이라면','',1],
  // Noun particles/copula the table lacked. 이라서 and 이나 attach only after
  // a consonant-final noun, so they're safe to strip blind; vowel-final 라서
  // and 나 collide with verbs (모자라서, 가나요) and stay validated candidates.
  ['마다','',1], ['이나','',1], ['이라서','',1],
  // LM2 (Nov 2026). 는다 + an ending after a consonant stem is as
  // unambiguous as 는다면 (먹는다가, 먹는다는, 읽는다며→먹다/읽다). The
  // fused-ㄴ vowel-stem shapes (쓴다가→쓰다) and the particle 깨나 are
  // validated candidates in extractLemmaCandidates.
  ['는다가','다',1], ['는다는','다',1], ['는다며','다',1], ['는다면서','다',1],
  ['는다니','다',1], ['는다니까','다',1], ['는다지만','다',1], ['는다던','다',1],
  ['는다는데','다',1],
  // LM3 (Nov 18 2026). The plain statement of every 하다 and 되다 verb:
  // 한다/된다 are always 하다/되다 (no noun ends in them), so this is a
  // rule rather than a validated candidate (해석한다, 시작된다).
  ['한다','하다',1], ['된다','되다',1],
  // LM4 (Nov 20 2026). Copula shapes no verb takes, so the noun is safe to
  // strip blind: a verb ending in 이다 contracts instead (먹여요, 먹여, never
  // 먹이에요 or 먹이야) and takes 는 where the copula takes ㄴ (보이는데,
  // never 보인데). The 이- rows only apply after a consonant-final noun
  // (COPULA_I_SUFFIXES); 이었- is handled in copulaPastNoun. Verb endings
  // new in LM4 are in LM4_ROWS, not here.
  ['이에요','',1], ['이야','',1], ['이란','',1], ['이라도','',1], ['이라니','',1],
  ['이군요','',1], ['이군','',1], ['이구나','',1],
  ['인데','',1], ['인지','',1], ['인가','',1],
];
// Pre-sorted longest-first so 하는 wins over 는, 에서 over 에, etc.
const KVE_SORTED = [...KOREAN_VERB_ENDINGS].sort((a, b) => b[0].length - a[0].length);
// L3: the copula's 이 only surfaces after a consonant-final noun
// (학생이나, 학생이라서). After a vowel the 이 belongs to the noun itself —
// 고양이나 is 고양이 + 나, not 고양 + 이나 — so these rules are skipped
// there and the shorter rule (or a validated candidate) takes over.
const COPULA_I_SUFFIXES = new Set(['이나', '이라서', '이라면', '이니까', '이가', '이라고', '이라는',
  '이에요', '이야', '이란', '이라도', '이라니', '이군요', '이군', '이구나']);
// LM4: table endings that carry the honorific 시 themselves.
const HON_TABLE_SUFFIXES = new Set(['세요', '으세요', '십니다', '으십니다', '십니까', '으십니까']);
// LM4: N이었- is the copula's past after a consonant-final noun (출신이었어,
// 학생이었는데). A verb ending in 이다 contracts to 였 (움직였다), so the
// noun is safe to take blind. → the noun, or ''.
function copulaPastNoun(token) {
  // (이였 is a common misspelling of 이었.)
  const i = Math.max(token.indexOf('이었'), token.indexOf('이였'));
  if (i < 1 || token.length - i > 7) return '';
  const noun = token.slice(0, i);
  if (!/^[가-힣]+$/.test(noun) || !/^[가-힣]*$/.test(token.slice(i + 2))) return '';
  const d = decomposeSyllable(noun[noun.length - 1]);
  return d && d[2] !== 0 ? noun : '';
}

// ── Stage C: function-word stoplist ───────────────────────────
// Conjunctive adverbs and frequency adverbs that are dictionary headwords
// in their own right and must NEVER deconjugate — the suffix table mangles
// several (그리고→그리다, 그러면→그러다, 많이→많), and because some of
// those mangles ARE real headwords (그리다, 그러다), no amount of
// validation can reject them; only a stoplist can. Every entry must be its
// own headword, never a conjugated form. Enforced in three places:
// deconjugate (blind table), extractLemmaCandidates (freezes the candidate
// list at the identity so no sibling can validate past it), and
// resolveLemmaWithDictionary (blocks the seed tiers; an organic user
// correction, checked earlier, still overrides).
const KOREAN_FUNCTION_WORDS = new Set([
  // Conjunctive adverbs
  '그리고', '그래서', '그러나', '그런데', '그러면', '그러니까', '그러므로',
  '그렇지만', '그래도', '하지만', '또는', '혹은', '및', '즉', '또한',
  // Frequency/degree/manner adverbs
  '함께', '빨리', '많이', '같이', '아직', '이미', '매우', '아주', '정말',
  '진짜', '너무', '다시', '먼저', '서로', '가장', '별로', '계속', '자주',
  '항상', '거의', '바로', '이제', '벌써', '아마', '특히', '역시', '물론',
  // L3: bare adverbs that also read as conjugations (안→안다, 다→다다,
  // 없이→없, 잘→자다, 늘→늘다, 곧→곧다) — each is its own headword.
  '안', '못', '다', '잘', '없이', '곧', '늘', '좀', '꼭', '또', '더',
  // LM4: adverbs that end like one of the new endings (수록, 도록, 니, 든).
  '갈수록', '되도록', '오래도록', '그러니', '아무래도', '어쨌든', '아무튼', '언제든지', '얼마든지', '그다지',
]);
const isFunctionWord = (s) =>
  !!s && KOREAN_FUNCTION_WORDS.has(String(s).normalize('NFC'));

// ── Jamo compose / past-tense de-contraction ──────────────────
// hangulToJamo (below) only decomposes; these are the recomposition side,
// used to undo 았/었 absorbed into a syllable block (했→하, 갔→가, 왔→오,
// 줬→주, 렸→리). ㅕ→ㅣ is ambiguous (버렸→버리 vs 폈→펴); ㅣ measured
// better on the corpus and rare 펴-types recover via the GLM tier.
function composeSyllable(l, v, t) { return String.fromCharCode(0xAC00 + l * 588 + v * 28 + t); }
function decomposeSyllable(ch) {
  const code = ch.charCodeAt(0) - 0xAC00;
  if (code < 0 || code > 11171) return null;
  return [Math.floor(code / 588), Math.floor((code % 588) / 28), code % 28];
}
function decontractPastSyllable(ch) {
  const d = decomposeSyllable(ch);
  if (!d || d[2] !== 20) return null; // needs ㅆ batchim
  // Only contraction-capable vowels de-contract; lexical ㅆ stems (있다,
  // 재미있다, 맛있다) must never lose their batchim.
  if (![0, 1, 4, 6, 9, 10, 14].includes(d[1])) return null;
  const map = { 1: 0, 9: 8, 10: 11, 14: 13, 6: 20 }; // ㅐ→ㅏ, ㅘ→ㅗ, ㅙ→ㅚ, ㅝ→ㅜ, ㅕ→ㅣ
  const v = map[d[1]] !== undefined ? map[d[1]] : d[1];
  return composeSyllable(d[0], v, 0);
}
function hangulCount(s) {
  const m = String(s || '').match(/[가-힣]/g);
  return m ? m.length : 0;
}
// Stage D: a bare 었/았 syllable (ㅇ + ㅓ/ㅏ + ㅆ) is the past marker on a
// consonant stem (먹었다, 읽었다, 좋았다) or the past-perfect 었 (갔었다,
// 먹었었다). It carries no stem sound, so it is dropped whole — repeatedly,
// for the doubled past — instead of de-contracting to a bogus 먹어다.
function isBarePastSyllable(ch) {
  const d = ch ? decomposeSyllable(ch) : null;
  return !!d && d[0] === 11 && (d[1] === 0 || d[1] === 4) && d[2] === 20;
}
function decontractIfPast(cand) {
  if (!cand.endsWith('다') || cand.length < 2) return cand;
  // LM4: written 하였다 is 하 + 였, not a contraction of 하이다.
  if (cand.endsWith('하였다')) return cand.slice(0, -3) + '하다';
  while (cand.length >= 3 && isBarePastSyllable(cand[cand.length - 2]) && /[가-힣]/.test(cand[cand.length - 3])) {
    cand = cand.slice(0, -2) + '다';
  }
  const dc = decontractPastSyllable(cand[cand.length - 2]);
  if (!dc) return cand;
  let out = cand.slice(0, -2) + dc + '다';
  // 르-irregular second stage: the pattern [ㄹ-batchim][라/러]다 essentially
  // only arises from de-contracted 르-irregular pasts (몰랐다→몰라다→모르다,
  // 골랐다→고르다, 빨랐다→빠르다), so the rewrite is deterministic.
  if (out.length >= 3) {
    const dL = decomposeSyllable(out[out.length - 2]);
    const dP = decomposeSyllable(out[out.length - 3]);
    if (dL && dP && dP[2] === 8 && dL[0] === 5 && (dL[1] === 0 || dL[1] === 4) && dL[2] === 0) {
      out = out.slice(0, -3) + composeSyllable(dP[0], dP[1], 0) + '르다';
    }
  }
  return out;
}

// LM4: one tidy for every rule. Quote marks and closing punctuation come off
// both ends, in any order (출신이었어?" used to keep its quote mark in the
// candidate blocks, so none of them matched). Brackets stay: 마무리(하다)
// is the parenthetical lemma convention and must pass through whole.
const EDGE_QUOTES_LEAD = /^[\s\u2018\u2019\u201C\u201D"'`\u300C\u300E\u3008\u300A]+/;
const EDGE_QUOTES_TAIL = /[\s\u2018\u2019\u201C\u201D"'`\u300D\u300F\u3009\u300B]+$/;
const EDGE_PUNCT_TAIL = /[.,:;?!~\u2026\u00B7\u30FB\u3001\u3002\uFF0C\uFF0E\uFF01\uFF1F\uFF1A\uFF1B\uFF5E\u300D\u300F\u3009\u300B]+$/;
function tidySurface(s) {
  let out = String(s || '').trim();
  for (let i = 0; i < 4; i++) {
    const next = out.replace(EDGE_QUOTES_LEAD, '').replace(EDGE_QUOTES_TAIL, '').replace(EDGE_PUNCT_TAIL, '').trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

// ── extractLemmaFromText ──────────────────────────────────────
// Attempts to de-conjugate Korean text into dictionary headword form.
// Stage 3: the suffix table runs FIRST — the previous ends-with-다 early
// return made every 다-final table entry (습니다, 었다, 는다…) unreachable.
export function extractLemmaFromText(cleaned) {
  if (!cleaned) return '';
  const text  = String(cleaned).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n').map(l => l.replace(/\s+/g, ' ').trim());

  const tidy = tidySurface;

  const tryRules = (token) => {
    for (const rule of KVE_SORTED) {
      const suffix = rule[0], replacement = rule[1], minStem = rule[2];
      if (token.endsWith(suffix)) {
        const stem = token.slice(0, token.length - suffix.length);
        if (COPULA_I_SUFFIXES.has(suffix)) {
          const dS = stem ? decomposeSyllable(stem[stem.length - 1]) : null;
          if (!dS || dS[2] === 0) continue;
        }
        if (hangulCount(stem) >= minStem && /[가-힣]/.test(stem)) {
          let cand = replacement ? stem + replacement : stem;
          const dLast = decomposeSyllable(stem[stem.length - 1]);
          // L3: 는 after a consonant-final stem is always a verb form — the
          // topic marker after a consonant is 은 (넘는→넘다, 않는→않다).
          if (suffix === '는' && !replacement && dLast && dLast[2] !== 0) cand = stem + '다';
          // L3: a ㄹ-final stem before an 으-ending is always ㄷ-irregular —
          // real ㄹ-stems never take 으 (걸으러→걷다, 들으면→듣다).
          if (replacement === '다' && suffix[0] === '으' && dLast && dLast[2] === 8) {
            cand = stem.slice(0, -1) + composeSyllable(dLast[0], dLast[1], 7) + '다';
          } else if (replacement === '다' && /^[가-힣]+$/.test(stem)) {
            // LM4: the stem may still carry 겠, tense or the honorific
            // (하겠어요→하다, 하셨어요→하다, 하였습니다→하다; 계세요→계시다).
            const hon = HON_TABLE_SUFFIXES.has(suffix);
            const j = dLast ? dLast[2] : -1;
            const viaEu = suffix[0] === '으' && j === 0;   // 지으세요 → 짓다
            // (겠다/겠어 rules: hand the 겠 back so 아/어야겠 is seen whole.)
            // A ㄹ stem drops its ㄹ before ㄴ: 만드는데, 아니까 → 만들다, 알다.
            const lDrop = /^[는니네나냐느]/.test(suffix);
            const ls = viaEu ? euLemmas(stem, {}) : stemLemmas(suffix.startsWith('겠') ? stem + '겠' : stem, { honEnding: hon, lDrop });
            if (ls.length) return { lemma: ls[0], len: suffix.length };
          }
          return { lemma: decontractIfPast(cand) || token, len: suffix.length };
        }
      }
    }
    return null;
  };
  const deconjugate = (token) => {
    if (!token || !/[가-힣]/.test(token)) return token;
    if (isFunctionWord(token)) return token; // Stage C: never deconjugate
    // LM4: the copula's past after a consonant-final noun (출신이었어→출신).
    const copNoun = copulaPastNoun(token);
    if (copNoun) return copNoun;
    // LM4: written 하여 (대하여, 관하여, 하여서) is 하다; no noun ends in it.
    const hayeo = token.match(/^([가-힣]*)하여(서|도|야|요)?$/);
    if (hayeo) return hayeo[1] + '하다';
    // LM4: the table and the ending peeler both answer; the longer ending
    // wins (하더라도 is 더라도, not the table's 도), the table on a tie.
    const peeled = peelPrimary(token);
    const direct = tryRules(token);
    if (direct !== null) return peeled && peeled.len > direct.len ? peeled.lemma : direct.lemma;
    // Polite-요 retry: no rule matched the full token — peel a trailing 요
    // and run the table once more (는요→는→strip, 거든요→거든, 을까요→
    // 을까…). Conservative: the bare form is adopted only when a rule
    // actually fires on it, so 요-final nouns (필요) never lose their 요.
    if (token.endsWith('요') && hangulCount(token) >= 2) {
      const retried = tryRules(token.slice(0, -1));
      if (retried !== null) return peeled && peeled.len > retried.len + 1 ? peeled.lemma : retried.lemma;
    }
    if (peeled) return peeled.lemma;
    return token;
  };

  for (const ln of lines) {
    if (!ln) continue;
    if (/[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(ln)) {
      const c = tidy(ln);
      if (!c) continue;
      const deconj = deconjugate(c);
      if (deconj && deconj !== c) return deconj;
      if (c.endsWith('다')) return decontractIfPast(c);
      return c;
    }
  }
  for (const ln of lines) {
    if (ln) { const c = tidy(ln); if (c) return c; }
  }
  return '';
}

// ── Stacked-particle peeling (L3) ─────────────────────────────
// Particle → which stem ending it attaches to: 'C' consonant-final,
// 'CX' consonant-final except ㄹ, 'V' vowel-final, 'VL' vowel- or ㄹ-final (로), 'A' either.
const OUTER_PARTICLES = [
  ['는', 'V'], ['은', 'C'], ['를', 'V'], ['을', 'C'], ['가', 'V'], ['이', 'C'],
  ['도', 'A'], ['만', 'A'], ['의', 'A'],
];
const INNER_PARTICLES = [
  ['에게서', 'A'], ['한테서', 'A'], ['에서', 'A'], ['에게', 'A'], ['한테', 'A'],
  ['까지', 'A'], ['부터', 'A'], ['처럼', 'A'], ['마다', 'A'], ['보다', 'A'],
  ['조차', 'A'], ['마저', 'A'], ['밖에', 'A'], ['하고', 'A'], ['이랑', 'C'],
  ['으로', 'CX'], ['이나', 'C'], ['로', 'VL'], ['랑', 'V'], ['와', 'V'], ['과', 'C'],
  ['께', 'A'], ['에', 'A'],
];
function particleFits(stem, rule) {
  const d = stem ? decomposeSyllable(stem[stem.length - 1]) : null;
  if (!d) return false;
  if (rule === 'A') return true;
  if (rule === 'C') return d[2] !== 0;
  if (rule === 'CX') return d[2] !== 0 && d[2] !== 8; // 으로: ㄹ takes 로
  if (rule === 'V') return d[2] === 0;
  if (rule === 'VL') return d[2] === 0 || d[2] === 8;
  return false;
}
function peelOne(w, list) {
  for (const [pt, rule] of list) {
    if (w.endsWith(pt)) {
      const stem = w.slice(0, -pt.length);
      if (hangulCount(stem) >= 1 && particleFits(stem, rule)) return stem;
    }
  }
  return null;
}
// Returns the deeper peels of a stacked-particle surface (two or more
// layers removed), deepest first; [] for anything that isn't stacked.
function stackedParticlePeels(surface) {
  let w = tidySurface(surface);
  if (w.endsWith('요') && hangulCount(w) >= 3) w = w.slice(0, -1);
  if (!/^[가-힣]+$/.test(w)) return [];
  const chain = [];
  const outer = peelOne(w, OUTER_PARTICLES);
  if (outer) { w = outer; chain.push(w); }
  const inner = peelOne(w, INNER_PARTICLES);
  // 하고 is also the verb 하다's connective (능멸하고도 → 능멸하다), so that
  // reading is offered ahead of the bare noun.
  const verbReading = inner && w.endsWith('하고') ? inner + '하다' : null;
  if (inner) { w = inner; chain.push(w); }
  // Plural 들, except the 아들 compounds (큰아들, 막내아들).
  if (w.endsWith('들') && hangulCount(w) >= 3 && !w.endsWith('아들')) { w = w.slice(0, -1); chain.push(w); }
  if (chain.length < 2) return [];
  const peels = chain.slice(1).reverse();
  return verbReading ? [verbReading, ...peels] : peels;
}

// ── LM4: ending peeler ────────────────────────────────────────
// The suffix table lists whole endings one by one and had no idea of how
// an ending attaches. This is the missing half: endings by attachment
// class, peeled from the end of a word to reach the stem, with the stem
// changes each class causes undone on the way (으 inserted after a
// consonant, ㄹ dropped, ㄷ/ㅅ/ㅂ irregulars, a fused ㄴ/ㄹ/ㅂ/ㅁ, tense,
// 겠, honorific 시).
//
// Classes:
//   A   any stem, unchanged                    먹더라, 가더라, 만들더라
//   N   any stem; a ㄹ stem drops its ㄹ          먹느라, 만드느라
//   U   으 after a consonant stem; ㄹ stays      먹으려다, 가려다, 만들려다
//   S   as U, but a ㄹ stem drops its ㄹ          먹으니, 만드니
//   Q   as S, and also straight onto a consonant stem (question 먹니)
//   Fㄴ Fㄹ Fㅂ Fㅁ  the ending starts with a consonant that sits under the
//       stem's last syllable (예쁜지, 갈수록, 갑시다, 함); after a
//       consonant stem it is spelled 은/을/읍/음 (좋은지, 먹을수록)
//   V   아/어 fused into the stem's last syllable, then 서, 야, 도 or 라
//       (해도, 가라, 누워서 → 눕다); older blocks cover part of this
//   E   어/아 written out after a consonant stem (먹어라)
// Sure:
//   y  safe to apply blind: no noun ends this way
//   e  safe only in the 으/은/을/읍/음 spelling (먹으니; 보니 could be 언니)
//   p  safe only after a tense or 겠 (했군; 장군 is a noun)
//   n  never blind: a dictionary-checked candidate
// Honorific endings (세요, 십시오, 셔서) carry the 시 themselves. 세요,
// 십니다 and 십니까 are also table rules; they are repeated here for the
// other readings (만드세요 → 만들다).
// A sure reading goes right after the primary. An unsure one goes to the
// end of the candidate list, behind everything the older blocks offer, so
// it only ever answers where those found nothing the dictionary confirms
// (친구나 stays 친구, 달려 stays 달리다, and 보니 gains 보다).
const LM4_ROWS = [];
{
  const add = (cls, sure, list, hon = false) => { for (const e of list.split(' ')) LM4_ROWS.push({ e, cls, sure, hon }); };
  add('A', 'y', '더라고 더라구 더라도 더라면 더라 더니만 더니 던데 던가 던지 더군 더구나 더냐 더구먼 자마자 도록 다시피 길래 든지 든가 거니와 구먼');
  add('A', 'p', '던 군 구나');
  // Never blind: 사건만, 보고서, 사고자, 반듯이 and 위노라 are nouns, adverbs and names.
  add('A', 'n', '듯이 듯 든 건만 건대 건 되 고서 고자 고는 고도 기는 기도 기만 기를 기가 기에는 기엔 기에 길 다니 자는 자면 재 구 노라');
  // 어라/아라 only after a consonant stem (먹어라); after a vowel it is a name or slang (고아라).
  add('E', 'y', '어라 아라');
  add('V', 'n', '서 야 도 라');
  add('N', 'y', '느라고 느라 느니 는군 는구나 는구먼 는지라 는지 는가 는걸');
  add('N', 'n', '는');   // attributive 는 on a ㄹ stem: 만드는 → 만들다
  add('U', 'y', '려는데 려는 려면 려던 려니까 려니 려나 려무나 렵니다 렵니까 므로 리라');
  // 려다(가) straight after a vowel is also 리 + 어다(가): 내려다, 데려다, 올려다.
  add('U', 'e', '려다가 려다 려 며 라 렴 마');
  add('U', 'n', '라는 래');
  add('S', 'y', '십시오 셔서 셔도 셔야 십시다 세요 십니다 십니까', true);
  add('Q', 'e', '니');
  add('Fㄴ', 'y', '지라');
  add('Fㄴ', 'e', '지 가');
  add('Fㄴ', 'n', '데 걸');
  add('Fㄹ', 'y', '수록 지라도 텐데 망정 뿐더러');
  add('Fㄹ', 'e', '지 게 걸 래 려고');
  add('Fㄹ', 'n', '까 지도');
  add('Fㅂ', 'y', '시다 니다 니까');
  add('Fㅁ', 'e', '으로써');   // 함으로써, but 사람으로써 is a noun
  add('Fㅁ', 'n', '');
}
const LM4_FUSED = { 'ㄴ': [4, '은'], 'ㄹ': [8, '을'], 'ㅂ': [17, '읍'], 'ㅁ': [16, '음'] };
// Verbs whose own stem ends in 시 (마시다, 모시다): the 시 is not the
// honorific. 계시다 and 주무시다 exist only with it.
const LEXICAL_SI = ['마시', '모시', '계시', '주무시', '잡수시', '부시', '쑤시', '적시'];
const HON_ONLY_STEMS = ['계', '주무'];
// Stems that only exist with their ㄹ: before a ㄹ-dropping ending 아, 드,
// 마, 노, 우 and 여 are 알다, 들다, 말다, 놀다, 울다 and 열다 (아세요, 드시고,
// 맙시다, 노느라); 아다, 드다… are not words, so the ㄹ form comes first.
// The same holds at the end of a longer stem for 아, 드, 마 and 노 (만드,
// 흔드, 뛰노: no verb ends in 아다, 드다, 마다 or 노다), but not for 우 and 여
// (배우다, 보이다 → 보여).
const lFirst = (b) => /[아드마노]$/.test(b) || b === '우' || b === '여';

// The fused-vowel restore shared with block (h): 해 → 하, 봐 → 보, 줘 → 주,
// 마셔 → 마시, 돼 → 되.
const FUSED_VOWEL_RESTORE = { 9: 8, 14: 13, 1: 0, 6: 20, 10: 11 };
const lastJong = (s) => { const d = s ? decomposeSyllable(s[s.length - 1]) : null; return d ? d[2] : -1; };
const withJong = (s, j) => { const d = decomposeSyllable(s[s.length - 1]); return s.slice(0, -1) + composeSyllable(d[0], d[1], j); };
const isHangulStem = (s) => !!s && /^[가-힣]+$/.test(s);

// A stem as it stands before an ending → its dictionary forms, most likely
// first. Undoes 겠, tense (했→하, 먹었→먹, 하였→하) and honorific 시.
//   lDrop      the ending makes a ㄹ stem drop its ㄹ, so also offer stem+ㄹ
//   honEnding  the ending held the 시 itself (세요, 십시오)
function stemLemmas(S, { lDrop = false, honEnding = false } = {}) {
  if (!isHangulStem(S)) return [];
  // No stem ends in 다: what stands before the ending is a quoted plain
  // statement (간다던데, 예쁘다더라, 있다는걸, 했다길래).
  if (S.length >= 2 && S.endsWith('다') && !honEnding) {
    const nda = fusedNdaReadings(S).readings;
    return nda.length ? nda : stemLemmas(S.slice(0, -1), {});
  }
  // …or a quoted copula after a consonant-final noun (학생이라던데 → 학생).
  if (S.length >= 3 && S.endsWith('이라') && lastJong(S.slice(0, -2)) > 0) return [S.slice(0, -2)];
  let st = S;
  if (st.length >= 2 && st.endsWith('겠')) {
    st = st.slice(0, -1);
    // 아/어야겠: 해야겠군요, 봐야겠다, 먹어야겠어 → 하다, 보다, 먹다.
    if (st.length >= 2 && st.endsWith('야')) {
      const u = st.slice(0, -1), d = decomposeSyllable(u[u.length - 1]);
      if (u.length >= 2 && (u.endsWith('어') || u.endsWith('아'))) return stemLemmas(u.slice(0, -1), {});
      if (d && d[2] === 0 && FUSED_VOWEL_RESTORE[d[1]] !== undefined) {
        const restored = u.slice(0, -1) + composeSyllable(d[0], FUSED_VOWEL_RESTORE[d[1]], 0) + '다';
        // 해 is 하 + 여; any other ㅐ is more often the stem's own (내야겠다).
        return u.endsWith('해') || d[1] !== 1 ? [restored, u + '다'] : [u + '다', restored];
      }
      if (d && d[2] === 0 && (d[1] === 0 || d[1] === 4)) return [u + '다'];
    }
  }
  let lemma;
  if (st.endsWith('하였')) lemma = st.slice(0, -1) + '다';
  else lemma = lastJong(st) === 20 ? decontractIfPast(st + '다') : st + '다';
  const base = lemma.slice(0, -1);
  const tensed = base !== S;
  const out = [];
  const add = (c) => { if (c && !out.includes(c)) out.push(c); };
  // A fused ㅐ past is 하 + 였 (했) or a stem that ends in ㅐ (냈 → 내다,
  // 보냈 → 보내다): the tense peel picks ㅏ, so the ㅐ stem is offered too.
  const dT = tensed ? decomposeSyllable(st[st.length - 1]) : null;
  const aeStem = dT && dT[2] === 20 && dT[1] === 1 ? withJong(st, 0) : '';
  // b다, and what b may be hiding: a ㅂ-irregular (도우 → 돕다) or a dropped ㄹ.
  const plain = (b, dropped) => {
    if (dropped && lFirst(b)) add(withJong(b, 8) + '다');
    add(b + '다');
    if (b.length >= 2 && b.endsWith('우') && lastJong(b.slice(0, -1)) === 0) add(withJong(b.slice(0, -1), 17) + '다');
    // (No ㄹ behind a copula-shaped stem: 것이 + ㅂ니다 is never 것일다.)
    if (dropped && lastJong(b) === 0 && !(b.length >= 2 && b.endsWith('이'))) add(withJong(b, 8) + '다');
  };
  if (honEnding) {
    if (HON_ONLY_STEMS.some(x => base.endsWith(x))) return [base + '시다'];
    plain(base, true);
    return out;
  }
  if (base.length >= 2 && base.endsWith('시') && !LEXICAL_SI.some(x => base.endsWith(x))) {
    const X = base.slice(0, -1);
    if (X.length >= 2 && X.endsWith('으')) {
      // 으시 only ever follows a consonant stem: 읽으시다 → 읽다, and the
      // irregulars 들으시다 → 듣다, 지으시다 → 짓다.
      const b = X.slice(0, -1), j = lastJong(b);
      add((j === 8 ? withJong(b, 7) : j === 0 ? withJong(b, 19) : b) + '다');
      add(base + '다');
      return out;
    }
    if (lastJong(X) === 0) {
      // 셨 (tense on top of 시) is the honorific far more often than a
      // 시-final verb (가셨어요 is 가다 before 가시다); bare 시 could be a
      // noun or a verb of its own (하시고, 가시고), so it stays first.
      if (tensed) { plain(X, true); add(base + '다'); }
      else { add(base + '다'); plain(X, true); }
      return out;
    }
  }
  plain(base, lDrop && !tensed);
  if (aeStem) add(aeStem + '다');
  if (dT && dT[2] === 20 && dT[0] !== 11 && base.length >= 1) {
    // What else a fused past may hide. ㅓ/ㅏ: a stem in ㅡ (컸 → 크다,
    // 바빴 → 바쁘다). ㅐ: a ㅎ-irregular (어땠 → 어떻다, 빨갰 → 빨갛다).
    if (dT[1] === 4 || dT[1] === 0) add(st.slice(0, -1) + composeSyllable(dT[0], 18, 0) + '다');
    if (dT[1] === 1) {
      add(st.slice(0, -1) + composeSyllable(dT[0], 4, 27) + '다');
      add(st.slice(0, -1) + composeSyllable(dT[0], 0, 27) + '다');
    }
  }
  return out;
}
// 으 + ending after a stem: regular after a consonant (먹으니), ㄷ-irregular
// after ㄹ (들으니 → 듣다; a real ㄹ stem never takes 으), ㅅ-irregular after
// a vowel (지으니 → 짓다; a real vowel stem never takes 으).
function euLemmas(b, opts) {
  if (!isHangulStem(b)) return [];
  const j = lastJong(b);
  if (j === 8) return [withJong(b, 7) + '다'];
  if (j === 0) return [withJong(b, 19) + '다'];
  return stemLemmas(b, opts);
}

// Every way an LM4 ending can be read off the end of q.
//   → [{ len, sure, readings }], longest ending first
function peelEndings(q) {
  const found = [];
  if (!q || hangulCount(q) < 2) return found;
  const hit = (len, sure, readings) => { if (readings.length) found.push({ len, sure, readings }); };
  for (const { e, cls, sure, hon } of LM4_ROWS) {
    const F = cls[0] === 'F' ? LM4_FUSED[cls[1]] : null;
    if (F) {
      const [j, syl] = F;
      if (q.endsWith(syl + e) && q.length > e.length + 1) {
        hit(e.length + 1.5, sure !== 'n', euLemmas(q.slice(0, -(e.length + 1)), {}));
      }
      if (q.endsWith(e) && q.length > e.length) {
        const st = e ? q.slice(0, -e.length) : q;
        const jj = lastJong(st);
        const sureF = sure === 'y';
        if (jj === j) {
          const open = withJong(st, 0);
          // A fused ㄹ may be the stem's own (만들지, 살게): offer both, the
          // stem's own first where the open stem is no word (알수록, 들수록).
          const more = j === 8 ? stemLemmas(st, {}) : [];
          const opened = stemLemmas(open, { lDrop: j !== 8 });
          hit(e.length + 0.5, sureF, lFirst(open) ? [...more, ...opened] : [...opened, ...more]);
        } else if (j === 16 && jj === 10) {
          hit(e.length + 0.5, sureF, [withJong(st, 8) + '다']); // 삶 → 살다
        }
      }
      continue;
    }
    if (!q.endsWith(e) || q.length <= e.length) continue;
    const S = q.slice(0, -e.length);
    if (!isHangulStem(S)) continue;
    if (cls === 'V') {
      const d = decomposeSyllable(S[S.length - 1]);
      if (d && d[2] === 0 && [0, 1, 4, 6, 9, 10, 14].includes(d[1])) {
        const rs = d[1] === 10 ? [] : [S + '다'];
        const rest = FUSED_VOWEL_RESTORE[d[1]];
        if (rest !== undefined) rs.push(S.slice(0, -1) + composeSyllable(d[0], rest, 0) + '다');
        // ㅂ-irregular: 누워서 → 눕다, 도와서 → 돕다.
        if (d[0] === 11 && (d[1] === 14 || d[1] === 9) && S.length >= 2 && lastJong(S.slice(0, -1)) === 0) {
          rs.push(withJong(S.slice(0, -1), 17) + '다');
        }
        hit(e.length, false, rs);
      }
      continue;
    }
    const pastStem = lastJong(S) === 20 || S.endsWith('겠');
    const sureBare = sure === 'y' || (sure === 'p' && pastStem);
    if (cls === 'E') {
      if (lastJong(S) > 0) hit(e.length, true, stemLemmas(S, {}));
    } else if (cls === 'A') {
      // 듯(이) follows a stem (하듯이) or an attributive (미친 듯이 written solid).
      const j = lastJong(S);
      const attr = (e === '듯' || e === '듯이') && (j === 4 || j === 8) ? stemLemmas(withJong(S, 0), { lDrop: j === 4 }) : [];
      hit(e.length, sureBare, [...attr, ...stemLemmas(S, {})]);
    } else if (cls === 'N') {
      hit(e.length, sureBare, stemLemmas(S, { lDrop: true }));
    } else {
      // U, S, Q: the 으 spelling first, then straight onto a vowel or ㄹ stem.
      const j = lastJong(S);
      if (S.length >= 2 && S.endsWith('으')) {
        hit(e.length + 1, sure !== 'n', euLemmas(S.slice(0, -1), { honEnding: hon }));
      } else if (j === 0) {
        const more = e === '려다' || e === '려다가' ? [S + '리다'] : [];
        hit(e.length, sureBare, [...stemLemmas(S, { lDrop: cls !== 'U', honEnding: hon }), ...more]);
      } else if (j === 8 && cls === 'U') {
        // A ㄹ stem (만들려면), or the colloquial extra ㄹ (할려면, 죽일려고).
        hit(e.length, sureBare, [...stemLemmas(S, {}), ...(e.startsWith('려') && e !== '려' ? stemLemmas(withJong(S, 0), {}) : [])]);
      } else if (cls === 'Q' && j !== 8) {
        hit(e.length, false, stemLemmas(S, {}));
      }
    }
  }
  return found.sort((a, b) => b.len - a.len);
}
// The peeler's blind answer for a word, if it has one: the longest sure
// ending. → { lemma, len } or null. A trailing polite 요 is looked through.
function peelPrimary(token) {
  for (const [q, extra] of [[token, 0], [token.endsWith('요') && hangulCount(token) >= 3 ? token.slice(0, -1) : '', 1]]) {
    if (!q) continue;
    const m = peelEndings(q)[0];
    if (m && m.sure) return { lemma: m.readings[0], len: m.len + extra };
  }
  return null;
}
// All the peeler's readings for a word, longest ending first (at most
// `cap` of each).  → { sure, unsure }
function peelReadings(t2, cap = 6) {
  const sure = [], unsure = [];
  const qs = [t2];
  if (t2.endsWith('요') && hangulCount(t2) >= 3) qs.push(t2.slice(0, -1));
  const all = qs.flatMap(q => peelEndings(q)).sort((a, b) => b.len - a.len);
  for (const m of all) {
    for (const r of m.readings) {
      if (r === t2 || sure.includes(r) || unsure.includes(r)) continue;
      (m.sure ? sure : unsure).push(r);
    }
  }
  return { sure: sure.slice(0, cap), unsure: unsure.slice(0, cap) };
}

// ── extractLemmaCandidates ────────────────────────────────────
// Ranked candidate lemmas for one surface token, including irregular-verb
// recoveries (ㅂ/르/ㄷ/ㅅ/으) that are too ambiguous to apply blind.
// Consumed by resolveLemmaWithDictionary, which only accepts a candidate
// after validating it as a headword against the global lemma map.
export function extractLemmaCandidates(surface) {
  return lemmaCandidates(surface).out;
}
// → { out, added }: the ranked list, and the readings LM4 added to it (the
// ones the resolver holds back when the surface is a dictionary word).
function lemmaCandidates(surface) {
  const out = [];
  const added = new Set();
  const push = (c) => { if (c && /[가-힣]/.test(c) && !out.includes(c)) out.push(c); };
  push(extractLemmaFromText(surface) || '');
  // Stage C: function words never conjugate — freeze the candidate list at
  // the identity so no sibling (그러나→그러다, 그러면→그러다) can validate
  // past it downstream.
  if (isFunctionWord(out[0])) return { out, added };

  // L3 — stacked particles (봄에는→봄, 친구들에게는→친구, 해녀들이→해녀).
  // The table strips one particle, so 봄에는 stopped at 봄에. Peel up to
  // three layers — outer (topic/object/subject/도/만/의), inner
  // (location, direction, 와/과…), plural 들 — and offer the results right
  // after the primary. Candidates only, never the primary: nouns ending in
  // a particle-shaped syllable (도로, 사과, 아들) must stay whole, and the
  // primary is checked first, so 도로는 still lands on 도로. Each particle
  // only peels where Korean allows it (이/을/은/과/으로 after a consonant,
  // 가/를/는/와/로 after a vowel), which keeps 만나는 from reaching 만.
  for (const c of stackedParticlePeels(surface)) push(c);

  // Peel only the polite 요 (and a fully spelled 었어요/았어요) so the
  // contracted stem stays intact: 들어요→들어, 더워요→더워, 써요→써.
  let t = tidySurface(surface);
  t = t.replace(/(었어요|았어요)$/, '').replace(/요$/, '');
  const nSyl = hangulCount(t);
  if (t && nSyl >= 1) {
    const last = t[t.length - 1];
    const dL = decomposeSyllable(last);
    if (nSyl >= 2) {
      const prev = t[t.length - 2];
      const dP = decomposeSyllable(prev);
      if (dL && dP) {
        // ㅂ-irregular: …워/…와 → previous syllable gains ㅂ (더워→덥다)
        if ((dL[1] === 14 || dL[1] === 9) && dL[2] === 0 && dL[0] === 11 && dP[2] === 0) {
          push(t.slice(0, -2) + composeSyllable(dP[0], dP[1], 17) + '다');
        }
        // 르-irregular: ㄹ-batchim + 라/러 → …르다 (몰라→모르다)
        if (dP[2] === 8 && (dL[1] === 0 || dL[1] === 4) && dL[0] === 5 && dL[2] === 0) {
          push(t.slice(0, -2) + composeSyllable(dP[0], dP[1], 0) + '르다');
        }
        // Bare 어/아 tail: 들어→들다 + ㄷ-irregular 듣다; 나아→ㅅ-irregular 낫다
        if (dL[0] === 11 && (dL[1] === 0 || dL[1] === 4) && dL[2] === 0) {
          push(t.slice(0, -1) + '다');
          if (dP[2] === 8) push(t.slice(0, -2) + composeSyllable(dP[0], dP[1], 7) + '다');
          if (dP[2] === 0) push(t.slice(0, -2) + composeSyllable(dP[0], dP[1], 19) + '다');
        }
      }
    }
    // 으-dropping: final ㅏ/ㅓ, no batchim → vowel becomes ㅡ (바빠→바쁘다,
    // 써→쓰다). Bogus candidates are harmless — they only survive
    // dictionary validation.
    if (dL && (dL[1] === 0 || dL[1] === 4) && dL[2] === 0 && dL[0] !== 11) {
      push(t.slice(0, -1) + composeSyllable(dL[0], 18, 0) + '다');
    }
  }

  // ㅂ-irregular from a de-contracted past: 더웠다 de-contracts to 더우다,
  // whose real lemma may be 덥다 — but X우다 is ambiguous (배우다 is a real
  // verb), so this is a validated candidate, never a blind rewrite.
  const p = out[0] || '';
  if (p.endsWith('우다') && p.length >= 3) {
    const dPrev = decomposeSyllable(p[p.length - 3]);
    if (dPrev && dPrev[2] === 0) {
      push(p.slice(0, -3) + composeSyllable(dPrev[0], dPrev[1], 17) + '다');
    }
  }

  // 여-contraction: X여 is usually X이다's stem + 어 (까닥여→까닥이다,
  // 반짝여→반짝이다) — validated candidate only.
  {
    const dY = t.length >= 2 ? decomposeSyllable(t[t.length - 1]) : null;
    if (dY && dY[0] === 11 && dY[1] === 6 && dY[2] === 0 && hangulCount(t) >= 2) {
      push(t.slice(0, -1) + '이다');
    }
  }
  // Stage 3.3 — validated alternatives for three ambiguity classes:
  const t2 = tidySurface(surface);
  // (a) X기 nominalizer vs noun ending in 기: 비치기→비치다 candidate;
  //     junk like 이야기→이야다 never survives validation.
  // L3: two-syllable surfaces too (가기→가다, 먹기→먹다); 2-syllable 기
  //     nouns (아기, 공기, 일기) carry trusted identity rows upstream.
  if (t2.endsWith('기') && hangulCount(t2) >= 2) {
    push(t2.slice(0, -1) + '다');
  }
  // (b) Bare particle strip as an alternative to verbalizer bigrams:
  //     이야기는 is noun+topic, not 이야기다 — offer 이야기 for validation.
  const PARTICLE_ALTS = ['에서','에게','까지','부터','조차','마저','는','은','이','가','을','를','도','만','의','와','과'];
  for (const pt of PARTICLE_ALTS) {
    if (t2.endsWith(pt) && hangulCount(t2.slice(0, -pt.length)) >= 2) {
      push(t2.slice(0, -pt.length));
      break;
    }
  }
  // (c) ㅂ-irregular adnominal: X운 → X-1+ㅂ다 (새로운→새롭다, 더운→덥다,
  //     무서운→무섭다). Nouns ending 운 (행운) produce junk candidates that
  //     fail validation harmlessly.
  if (t2.length >= 2) {
    const dLast = decomposeSyllable(t2[t2.length - 1]);
    const dPrev2 = decomposeSyllable(t2[t2.length - 2]);
    if (dLast && dLast[0] === 11 && dLast[1] === 13 && dLast[2] === 4 && dPrev2 && dPrev2[2] === 0) {
      push(t2.slice(0, -2) + composeSyllable(dPrev2[0], dPrev2[1], 17) + '다');
    }
  }
  // Stage 4 — beginner-coverage candidates (all validated, never blind):
  // (d) Fused attributive/prospective batchim on a vowel stem: strip a bare
  //     ㄴ/ㄹ final and offer stem+다 (예쁜→예쁘다, 큰→크다, 갈→가다); for
  //     ㄴ also the ㄹ-restored stem (산→살다). Nouns ending in ㄴ/ㄹ
  //     (시간, 물) produce junk candidates that fail validation harmlessly.
  // L3 — ㅎ-irregular attributives: 그런→그렇다, 어떤→어떻다, 빨간→빨갛다.
  //     Ranked ahead of (d) because when the ㅎ form validates it is the
  //     reading (그런 is almost never 그러다). Junk (간→갛다) fails
  //     validation harmlessly.
  if (t2.length >= 2) {
    const dH = decomposeSyllable(t2[t2.length - 1]);
    if (dH && dH[2] === 4 && (dH[1] === 0 || dH[1] === 4)) {
      push(t2.slice(0, -1) + composeSyllable(dH[0], dH[1], 27) + '다');
    }
  }
  if (t2.length >= 1) {
    const dF = decomposeSyllable(t2[t2.length - 1]);
    if (dF && (dF[2] === 4 || dF[2] === 8)) {
      push(t2.slice(0, -1) + composeSyllable(dF[0], dF[1], 0) + '다');
      if (dF[2] === 4) push(t2.slice(0, -1) + composeSyllable(dF[0], dF[1], 8) + '다');
    }
  }
  // (e) Syllabic 은/을 attributives on consonant stems (the particle strip
  //     already offers 작은→작; add the adjective/verb reading 작다) and
  //     는 on a vowel stem (하는→하다, 만나는→만나다).
  //     L3: a ㄹ-final stem before 은/을 is ㄷ-irregular — a real ㄹ-stem
  //     drops its ㄹ instead (들다→든/들) — so 들은/들을 offer 듣다.
  if ((t2.endsWith('은') || t2.endsWith('을')) && hangulCount(t2) >= 2) {
    const st = t2.slice(0, -1);
    const dSt = decomposeSyllable(st[st.length - 1]);
    if (dSt && dSt[2] === 8) push(st.slice(0, -1) + composeSyllable(dSt[0], dSt[1], 7) + '다');
    else push(st + '다');
  }
  if (t2.endsWith('는') && t2.length >= 2) {
    const st = t2.slice(0, -1);
    const dSt = decomposeSyllable(st[st.length - 1]);
    if (dSt && dSt[2] === 0) push(st + '다');
  }
  // (f) Copula peeling for nouns: 황새예요→황새, 학생입니다→학생,
  //     고양이야→고양이. All matches push (no break) — the shorter strips
  //     are junk that fails validation harmlessly.
  for (const cop of ['입니다', '이었어요', '이에요', '이었다', '이었어', '였어요', '예요', '였다', '였어', '이야', '야']) {
    if (t2.endsWith(cop) && hangulCount(t2.slice(0, -cop.length)) >= 1) {
      push(t2.slice(0, -cop.length));
    }
  }
  // (g) Fused-ㅆ past recovery, with an optional trailing 어/아 peeled first:
  //     갔다→가다, 봤어→보다, 됐다→되다, 먹었어→먹다. ㅐ is ambiguous
  //     (했→하다, 냈→내다) — offer both.
  //     Stage D: also runs on the 요-peeled surface (됐어요→되다,
  //     보냈어요→보내다), and a fused ㅓ/ㅏ past also offers the 으-dropped
  //     stem (예뻤어요→예쁘다, 바빴어요→바쁘다, 썼어요→쓰다).
  for (const src of (t2.endsWith('요') && t2.length >= 2 ? [t2, t2.slice(0, -1)] : [t2])) {
    let base = src.endsWith('다') ? src.slice(0, -1) : src;
    const dEnd = base.length >= 2 ? decomposeSyllable(base[base.length - 1]) : null;
    if (dEnd && dEnd[0] === 11 && (dEnd[1] === 0 || dEnd[1] === 4) && dEnd[2] === 0) {
      base = base.slice(0, -1);
    }
    const dS = base ? decomposeSyllable(base[base.length - 1]) : null;
    if (dS && dS[2] === 20) {
      const restored = { 9: 8, 14: 13, 10: 11 }[dS[1]];
      const vowels = [...new Set([restored ?? dS[1], dS[1], ...(dS[1] === 1 ? [0] : [])])];
      for (const v of vowels) {
        push(base.slice(0, -1) + composeSyllable(dS[0], v, 0) + '다');
      }
      // Bare 었/았: the ㅆ-stripped syllable is only the tense vowel — also
      // offer the stem without it (먹었어→먹다).
      if (dS[0] === 11 && (dS[1] === 0 || dS[1] === 4) && base.length >= 2) {
        push(base.slice(0, -1) + '다');
      }
      if (dS[0] !== 11 && (dS[1] === 0 || dS[1] === 4)) {
        push(base.slice(0, -1) + composeSyllable(dS[0], 18, 0) + '다');
      }
    }
  }
  // (h) Fused-vowel connectives: an ㅏ/ㅓ/ㅐ/ㅘ/ㅝ-final open syllable is
  //     usually stem+아/어 fusion — offer stem+다 and the contraction-
  //     restored stem (만나서→만나다, 가요→가다, 봐요→보다, 해요→하다).
  {
    const u = t.endsWith('서') ? t.slice(0, -1) : t;
    const dU = u ? decomposeSyllable(u[u.length - 1]) : null;
    // L3: ㅕ (지켜→지키다, 기다려→기다리다) and ㅙ (돼→되다) added.
    if (dU && dU[2] === 0 && [0, 1, 4, 6, 9, 10, 14].includes(dU[1]) && hangulCount(u) >= 1) {
      if (dU[1] !== 10) push(u + '다');
      const rest = { 9: 8, 14: 13, 1: 0, 6: 20, 10: 11 }[dU[1]];
      if (rest !== undefined) push(u.slice(0, -1) + composeSyllable(dU[0], rest, 0) + '다');
    }
  }
  // Stage B — validated candidates for collision-prone endings. Every push
  // here is guarded by headword validation in resolveLemmaWithDictionary;
  // blind table rules would mangle the collisions noted per line.
  {
    const b = t2.endsWith('요') ? t2.slice(0, -1) : t2;
    // Purpose 러 on a vowel stem (배우러→배우다) — blind mangles 러-final
    // loanwords (컨트롤러, 트레일러).
    if (b.endsWith('러') && hangulCount(b) >= 2) push(b.slice(0, -1) + '다');
    // Sentence enders 네(요)/나(요) (예쁘네→예쁘다, 가나요→가다) — blind
    // mangles 동네요/언니네/만나요.
    if ((b.endsWith('네') || b.endsWith('나')) && hangulCount(b) >= 2) push(b.slice(0, -1) + '다');
    // Proposative 자 (가자→가다) — blind mangles 여자/과자.
    if (b.endsWith('자') && hangulCount(b) >= 2) push(b.slice(0, -1) + '다');
    // 지(요) stays candidate-only — 바지요/아버지요 are polite noun echoes.
    if (b.endsWith('지') && hangulCount(b) >= 2) push(b.slice(0, -1) + '다');
    // Bare 냐 question (가냐→가다).
    if (b.endsWith('냐') && hangulCount(b) >= 2) push(b.slice(0, -1) + '다');
    // Fused 야 (가야→가다, 해야→하다, 와야→오다) — the copula strip in (f)
    // already offers the noun reading; this adds the verb reading with the
    // same contraction restore as (h).
    if (b.endsWith('야') && hangulCount(b) >= 2) {
      const st = b.slice(0, -1);
      const dSt = decomposeSyllable(st[st.length - 1]);
      push(st + '다');
      if (dSt && dSt[2] === 0) {
        const rest = { 9: 8, 14: 13, 1: 0, 6: 20, 10: 11 }[dSt[1]];
        if (rest !== undefined) push(st.slice(0, -1) + composeSyllable(dSt[0], rest, 0) + '다');
      }
    }
    // Comparison particle 보다 (나보다→나) — compound 보다 verbs (돌아보다)
    // are protected by the GLM identity tier upstream.
    if (b.endsWith('보다') && hangulCount(b) >= 3) push(b.slice(0, -2));
    // Bare 고 connective on a 1-syllable stem, below the table's minStem 2
    // (가고→가다, 자고→자다) — noun headwords (사고) are likewise protected
    // by the identity tier.
    if (b.endsWith('고') && hangulCount(b) === 2) push(b.slice(0, -1) + '다');
    // L3: adverbial 게 on a 1-syllable stem, same reason (쉽게→쉽다,
    // 크게→크다).
    // ㄹ-final stems (갈게, 살게) are the fused-future case just below.
    if (b.endsWith('게') && hangulCount(b) === 2) {
      const dG = decomposeSyllable(b[0]);
      if (dG && dG[2] !== 8) push(b[0] + '다');
    }
    // Fused-ㄹ futures/questions 게/까/래(+요): the ㄹ may be the
    // prospective (갈게→가다) or stem-final (살게→살다) — offer both,
    // ㄹ-stripped first (higher corpus frequency).
    const fut = b.slice(-1);
    if ((fut === '게' || fut === '까' || fut === '래') && b.length >= 2) {
      const st = b.slice(0, -1);
      const dSt = decomposeSyllable(st[st.length - 1]);
      if (dSt && dSt[2] === 8) {
        push(st.slice(0, -1) + composeSyllable(dSt[0], dSt[1], 0) + '다');
        push(st + '다');
      }
    }
    // Fused ㅂ니다/ㅂ니까 (갑니다→가다, 합니까→하다) — the syllabic
    // 습니다/습니까 forms are table rules; the fused ㅂ needs jamo work.
    if ((b.endsWith('니다') || b.endsWith('니까')) && b.length >= 3) {
      const dB = decomposeSyllable(b[b.length - 3]);
      if (dB && dB[2] === 17) push(b.slice(0, -3) + composeSyllable(dB[0], dB[1], 0) + '다');
    }
  }
  // L3 — vowel-final noun + copula/particle forms the table can't strip
  // blind: 커피나 (가나요 is a verb), 성수기라서 (모자라서 is a verb),
  // 친구라면 (모자라면), and attributive copula 인 (비수기인, 돌인 — 인
  // after any noun). The verb readings are offered above (모자라서 →
  // 모자라다 in (h)) and rank first; these add the noun reading.
  {
    const b = t2.endsWith('요') && hangulCount(t2) >= 3 ? t2.slice(0, -1) : t2;
    for (const suf of ['라서', '라면', '나']) {
      if (b.endsWith(suf)) {
        const st = b.slice(0, -suf.length);
        const dSt = st ? decomposeSyllable(st[st.length - 1]) : null;
        if (dSt && dSt[2] === 0 && hangulCount(st) >= 1) push(st);
        break;
      }
    }
    if (t2.endsWith('인') && hangulCount(t2) >= 2) push(t2.slice(0, -1));
    // The table's 이-copula rules read 고양이나 as 고양 + 이나; offer the
    // 이-final noun too (the resolver prefers it when both validate).
    for (const w of [t2, b]) {
      for (const suf of COPULA_I_SUFFIXES) {
        if (w.endsWith(suf) && hangulCount(w) > suf.length) { push(w.slice(0, -suf.length) + '이'); break; }
      }
    }
    // Conditional 다면 on a fused-ㄴ declarative: 원한다면→원하다,
    // 간다면→가다 (the table's 다면 rule leaves 원한다).
    if (b.endsWith('다면') && hangulCount(b) >= 3) {
      const st = b.slice(0, -2);
      const dN = decomposeSyllable(st[st.length - 1]);
      if (dN && dN[2] === 4) push(st.slice(0, -1) + composeSyllable(dN[0], dN[1], 0) + '다');
    }
  }
  // Stage B — honorific and future markers on the primary: 하셨다's primary
  // de-contracts to 하시다, and 가겠어요's to 가겠다 — peel 시다/으시다/겠다
  // down to the plain headword as a validated alternative.
  {
    const pr = out[0] || '';
    if (pr.endsWith('으시다') && hangulCount(pr) >= 4) push(pr.slice(0, -3) + '다');
    else if (pr.endsWith('시다') && hangulCount(pr) >= 3) push(pr.slice(0, -2) + '다');
    if (pr.endsWith('겠다') && hangulCount(pr) >= 3) push(pr.slice(0, -2) + '다');
  }
  // Stage B — quotative contractions (다고/라고/냐고/자고 families). The
  // remainder re-enters the normal shapes: verbatim 다-final quotes
  // (예쁘다고→예쁘다), fused-ㄴ declaratives (간다고→가다), syllabic
  // 는다/은다 (먹는다고→먹다), and stem quotes (가자고/가라고/먹으라고/
  // 가냐고→가다/먹다). The table's blind 라고/이라고 strips still supply
  // the noun-quote reading (사과라고→사과) as the primary.
  {
    const q = t2.endsWith('요') && t2.length >= 3 ? t2.slice(0, -1) : t2;
    const dago = q.endsWith('다고') ? q.slice(0, -2) : null;
    if (dago && hangulCount(dago) >= 1) {
      push(dago + '다');
      const dQ = decomposeSyllable(dago[dago.length - 1]);
      if (dQ && dQ[2] === 4) push(dago.slice(0, -1) + composeSyllable(dQ[0], dQ[1], 0) + '다');
      if (dago.endsWith('는') || dago.endsWith('은')) push(dago.slice(0, -1) + '다');
    }
    for (const suf of ['으라고', '라고', '으냐고', '느냐고', '냐고', '자고']) {
      if (q.endsWith(suf)) {
        const st = q.slice(0, -suf.length);
        if (hangulCount(st) >= 1) push(st + '다');
        break;
      }
    }
    // Stage D: contracted quotative 대(요) = 다고 해(요) (먹었대요→먹다,
    // 간대요→가다). 기대요-type nouns yield junk that fails validation.
    if (q.endsWith('대') && hangulCount(q) >= 2) {
      const st = q.slice(0, -1);
      push(st + '다');
      const dQ = decomposeSyllable(st[st.length - 1]);
      if (dQ && dQ[2] === 4) push(st.slice(0, -1) + composeSyllable(dQ[0], dQ[1], 0) + '다');
      if (st.endsWith('는') || st.endsWith('은')) push(st.slice(0, -1) + '다');
    }
  }
  // Stage D — past-marker peel. Any candidate still carrying a past marker
  // (먹었다 from 먹었네요/먹었나요, 들었다, 예뻤다) also offers its
  // dictionary form, ranked directly after the primary: the GLM tier only
  // checks the first few candidates, and the peeled form is the likeliest
  // reading of a past-tense surface. Irregular companions ride along as
  // validated-only alternatives: ㄹ→ㄷ after a dropped 었 (들었다→듣다),
  // ㅅ restored on an open stem (나았다→낫다), 으-dropping after a fused
  // ㅓ/ㅏ (예뻤다→예쁘다).
  {
    const extra = [];
    const add = (c) => { if (c && /[가-힣]/.test(c) && !out.includes(c) && !extra.includes(c)) extra.push(c); };
    // Seed with the surface cut just after its last ㅆ syllable (들었어요→
    // 들었다, 먹었는데요→먹었다): the primary may already be peeled, which
    // would hide the irregular companions.
    const seeds = [...out];
    for (let i = t2.length - 1; i >= 1; i--) {
      const dI = decomposeSyllable(t2[i]);
      if (dI && dI[2] === 20) { seeds.push(t2.slice(0, i + 1) + '다'); break; }
    }
    for (const c of seeds) {
      if (!c.endsWith('다') || c.length < 2) continue;
      const d = decomposeSyllable(c[c.length - 2]);
      if (!d || d[2] !== 20) continue;
      const peeled = decontractIfPast(c);
      if (peeled === c) continue;
      add(peeled);
      const dP = peeled.length >= 2 ? decomposeSyllable(peeled[peeled.length - 2]) : null;
      if (!dP) continue;
      const head = peeled.slice(0, -2);
      if (isBarePastSyllable(c[c.length - 2])) {
        if (dP[2] === 8) add(head + composeSyllable(dP[0], dP[1], 7) + '다');
        if (dP[2] === 0) add(head + composeSyllable(dP[0], dP[1], 19) + '다');
      } else if ((d[1] === 0 || d[1] === 4) && d[0] !== 11 && dP[2] === 0) {
        add(head + composeSyllable(dP[0], 18, 0) + '다');
      } else if (d[1] === 9 && d[0] !== 11 && dP[2] === 0) {
        // ㅎ dropped before a fused 와: 놨다→놓다.
        add(head + composeSyllable(dP[0], dP[1], 27) + '다');
      } else if (d[0] === 11 && (d[1] === 9 || d[1] === 14) && c.length >= 3) {
        // ㅂ-irregular 왔/웠 on an open stem: 도왔다→돕다, 쉬웠다→쉽다.
        const dB = decomposeSyllable(c[c.length - 3]);
        if (dB && dB[2] === 0) add(c.slice(0, -3) + composeSyllable(dB[0], dB[1], 17) + '다');
      }
    }
    if (extra.length) out.splice(1, 0, ...extra);
  }
  // LM2 — the plain statement ㄴ다/는다 with an ending after it (가, 는, 며,
  // 면서, 니, 니까, 지만, 던, 는데…), polite 요 allowed. On a vowel stem the
  // ㄴ is fused into the last syllable, so the table leaves 쓴다가→쓴다 and
  // 간다며→간다다: offer the stem without the ㄴ (쓰다, 가다) and with ㄹ
  // restored for ㄹ stems (만든다가→만들다), ranked right after the primary
  // so the dictionary check reaches them. The primary still comes first, so
  // a noun + particle keeps its noun (판다가→판다). 다면/다고/대 have their
  // own blocks above.
  // LM3 — bare ㄴ다 too (간다, 만난다, 쓴다): the same readings. The surface
  // is never checked as its own candidate, so the resolver keeps a surface
  // that is a dictionary word itself (판다, 안다) ahead of these
  // (bareNdaReadings, resolveLemmaDetailed).
  {
    const extra = [];
    const add = (c) => { if (c && !out.includes(c) && !extra.includes(c)) extra.push(c); };
    for (const c of fusedNdaReadings(t2).readings) add(c);
    if (extra.length) out.splice(1, 0, ...extra);
  }
  // LM2 — the particle 깨나, "quite a bit of" (힘깨나, 돈깨나). Never the
  // primary and ranked last: 어깨나 and 참깨나 are 어깨/참깨 + 나, and that
  // reading is already a candidate above, so it is checked first.
  if (t2.endsWith('깨나') && hangulCount(t2) >= 3) push(t2.slice(0, -2));
  // ── LM4 ──
  // Everything from here on is recorded in `added`.
  const pushNew = (c) => { if (c && /[가-힣]/.test(c) && !out.includes(c)) { out.push(c); added.add(c); } };
  const insertAfter = (c, after) => {
    if (!c || !/[가-힣]/.test(c) || out.includes(c)) return;
    const at = out.indexOf(after);
    out.splice(at < 0 ? out.length : at + 1, 0, c);
    added.add(c);
  };
  const peeled = peelReadings(t2);
  // The peeler's sure readings, right after the primary (one already
  // further down the list moves up).
  {
    const extra = peeled.sure.filter(c => c !== out[0]);
    if (extra.length) {
      for (const c of extra) if (!out.includes(c)) added.add(c);
      const rest = out.slice(1).filter(c => !extra.includes(c));
      out.splice(1, out.length - 1, ...extra, ...rest);
    }
  }
  // What follows from the shape of the primary and of the sure readings:
  //   honorific  X시다 → X다 (하시고 → 하시다 → 하다)
  //   copula     X이다 → X  (학생이고 → 학생이다 → 학생); the verb reading
  //              stays ahead, so 보이고 is still 보이다
  //   a dropped ㄹ before ㄴ/ㅅ: 만드는데 → 만드다 → 만들다
  for (const c of [out[0], ...peeled.sure]) {
    if (!c || !c.endsWith('다')) continue;
    if (c.endsWith('시다') && hangulCount(c) >= 3) {
      let prev = c;
      for (const l of stemLemmas(c.slice(0, -1), {})) { if (l !== c) { insertAfter(l, prev); prev = out.includes(l) ? l : prev; } }
    }
    if (c.endsWith('이다') && hangulCount(c) >= 3) insertAfter(c.slice(0, -2), c);
  }
  {
    const p = out[0] || '';
    const st = p.endsWith('다') ? p.slice(0, -1) : '';
    if (st && p !== t2 && t2.startsWith(st) && t2.length > st.length && lastJong(st) === 0 && !st.endsWith('이')
      && '는니네나냐느세시십'.includes(t2[st.length])) insertAfter(withJong(st, 8) + '다', p);
  }
  // The same two shapes on the older blocks' candidates (하신 → 하시다 →
  // 하다; 학생이네 → 학생이다 → 학생), and the peeler's unsure readings:
  // behind everything older.
  for (const c of peeled.unsure) pushNew(c);
  for (const c of out.slice(1, 8)) {
    if (!c.endsWith('다')) continue;
    if (c.endsWith('시다') && hangulCount(c) >= 3) for (const l of stemLemmas(c.slice(0, -1), {})) pushNew(l);
    if (c.endsWith('이다') && hangulCount(c) >= 3) pushNew(c.slice(0, -2));
  }
  // Noun readings, last of all:
  //   the copula with its 이 dropped after a vowel-final noun (친구고, 친구다 → 친구)
  {
    const p = out[0] || '';
    if (p.endsWith('다') && p.length >= 3) {
      const st = p.slice(0, -1);
      if (lastJong(st) === 0 && hangulCount(st) >= 2 && t2.startsWith(st) && !st.endsWith('이')) pushNew(st);
    }
  }
  //   the copula before ㄹ (학생일 때 → 학생), and 라도/라니/란 after a
  //   vowel-final noun (친구라도 → 친구)
  if (t2.endsWith('일') && hangulCount(t2) >= 2) pushNew(t2.slice(0, -1));
  for (const suf of ['라도', '라니', '란']) {
    if (t2.endsWith(suf) && t2.length > suf.length) {
      const st = t2.slice(0, -suf.length);
      if (lastJong(st) === 0) pushNew(st);
      break;
    }
  }
  //   a one-syllable noun and its particle (집에, 말로, 손과, 집까지): the
  //   table only strips these from longer nouns, to keep 사과 and 도로 whole
  for (const [pt, rule] of SHORT_NOUN_PARTICLES) {
    if (t2.endsWith(pt) && t2.length === pt.length + 1 && particleFits(t2[0], rule)) { pushNew(t2[0]); break; }
  }
  return { out, added };
}
const SHORT_NOUN_PARTICLES = [
  ['까지', 'A'], ['부터', 'A'], ['처럼', 'A'], ['조차', 'A'], ['마저', 'A'], ['밖에', 'A'], ['하고', 'A'],
  ['이랑', 'C'], ['랑', 'V'], ['에', 'A'], ['로', 'VL'], ['의', 'A'], ['도', 'A'], ['만', 'A'], ['과', 'C'], ['와', 'V'],
];
// LM4: the readings the resolver must not let beat a surface that is a
// dictionary word itself: everything LM4 reads into it (멍하니 the adverb
// is not 멍하다 + 니; 편지, 파일 and 아래 are nouns; 보이다 is not 보 + 이다)
// and LM3's bare ㄴ다 readings. They are still offered as alternates.
function guardedReadings(raw) {
  const set = new Set(bareNdaReadings(raw));
  for (const c of lemmaCandidates(raw).added) set.add(c);
  // A dictionary verb in 시다 typed as it stands (가시다, 드시다) is not the
  // honorific of a shorter verb.
  const t = tidySurface(normalizeLemma(raw) || raw);
  if (t.endsWith('시다') && t.length >= 3) for (const l of stemLemmas(t.slice(0, -1), {})) set.add(l);
  return set;
}
// LM2: endings that follow a plain-statement 다, longest first. LM3: ''
// (bare 다) last.
const FUSED_DA_TAILS = ['는데', '면서', '니까', '지만', '기에', '길래', '더라', '가', '는', '며', '니', '던', ''];

// LM2/LM3: the dictionary forms behind a plain-statement ㄴ다/는다, with or
// without an ending after it. → { bare, readings }: bare when nothing
// follows the 다. 하/되 never hide a ㄹ, so 할다/될다 are never offered.
function fusedNdaReadings(t2) {
  const readings = [];
  const q = t2.endsWith('요') && hangulCount(t2) >= 3 ? t2.slice(0, -1) : t2;
  const tail = FUSED_DA_TAILS.find(x => q.endsWith('다' + x));
  if (tail === undefined) return { bare: false, readings };
  const st = q.slice(0, -(tail.length + 1));
  const dN = st ? decomposeSyllable(st[st.length - 1]) : null;
  // 는 is itself a ㄴ-final syllable: after a longer stem it is the 는다
  // of a consonant stem (먹는다가→먹다); alone it is 늘다 (는다가).
  if (st.endsWith('는') && hangulCount(st) >= 2) {
    readings.push(st.slice(0, -1) + '다');
  } else if (dN && dN[2] === 4) {
    const head = st.slice(0, -1);
    const open = composeSyllable(dN[0], dN[1], 0);
    readings.push(head + open + '다');
    if (open !== '하' && open !== '되') readings.push(head + composeSyllable(dN[0], dN[1], 8) + '다');
  }
  return { bare: tail === '', readings };
}
// LM3: the readings the resolver must not let beat a surface that is a
// dictionary word itself (판다 the noun, 안다 "to hug"). Only the bare
// shape: with an ending after it the table's primary already comes first.
function bareNdaReadings(raw) {
  const t = normalizeLemma(raw) || raw;
  const r = fusedNdaReadings(t);
  return r.bare ? r.readings : [];
}

// ── detectMode ────────────────────────────────────────────────
export function detectMode(s) {
  if (/[가-힣]/.test(s)) return 'Korean';
  if (/[A-Za-z]/.test(s)) return 'English';
  return 'Korean';
}

// ── hangulToJamo ──────────────────────────────────────────────
// Decomposes Hangul syllable blocks into individual jamo characters.
// Used for near-match scoring in Search.
export function hangulToJamo(s) {
  const CHO  = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
  const JUNG = ['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅗ','ㅘ','ㅙ','ㅚ','ㅛ','ㅜ','ㅝ','ㅞ','ㅟ','ㅠ','ㅡ','ㅢ','ㅣ'];
  const JONG  = ['','ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xAC00 && code <= 0xD7A3) {
      const n = code - 0xAC00;
      out.push(CHO[Math.floor(n / (21 * 28))], JUNG[Math.floor((n % (21 * 28)) / 28)], JONG[n % 28]);
    } else {
      out.push(s[i]);
    }
  }
  return out.join('');
}

// ── editDistance ──────────────────────────────────────────────
// Levenshtein edit distance with early-exit optimization.
export function editDistance(a, b, maxDist = 3) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i-1] === b[j-1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j-1] + 1, prev[j-1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDist) return maxDist + 1;
    curr.forEach((v, idx) => { prev[idx] = v; });
  }
  return prev[b.length];
}

// ── stripKoreanAffixes ────────────────────────────────────────
// [LANG-SPECIFIC] Affix stripping rules for the lemma heuristic (docs/08).
export function stripKoreanAffixes(s) {
  s = String(s || '').trim();
  s = s.replace(/(을|를|이|가|들|도)$/, '');
  s = s.replace(/(하다|되다|지다|스럽다)$/, '');
  return s.replace(/·/g, ' ').replace(/[^\w가-힣]+$/, '').trim();
}

// ── English stopwords & tokenization ─────────────────────────
export const DEFAULT_STOPWORDS = new Set([
  'a','about','am','an','and','are','as','at','be','been','being','but','by',
  'come','did','do','does','done','etc','for','from','had','has','have','he',
  'her','him','his','i','if','in','into','is','it','its','make','me','my','of',
  'on','or','our','over','people','person','sb','she','someone','something',
  'sth','than','that','the','their','them','then','these','they','thing','this',
  'those','to','under','up','was','we','were','with','you','your',
]);

function normalizeEnglishToken(t) {
  t = String(t || '').toLowerCase().trim().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  if (!t) return '';
  if (t.length > 4 && /ing$/.test(t)) t = t.replace(/ing$/, '');
  if (t.length > 3 && /ed$/.test(t))  t = t.replace(/ed$/, '');
  if (t.length > 3 && /ly$/.test(t))  t = t.replace(/ly$/, '');
  if (t.length > 3 && /es$/.test(t))  t = t.replace(/es$/, '');
  else if (t.length > 3 && /s$/.test(t) && !/(ous|ss|us|is)$/.test(t)) t = t.replace(/s$/, '');
  return t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

export function tokenizeEnglish(text, stopwords = DEFAULT_STOPWORDS) {
  const s = String(text || '').toLowerCase().replace(/[\n\r\t]+/g, ' ').replace(/[^a-z0-9]+/g, ' ');
  return s.split(/\s+/).filter(Boolean)
    .map(normalizeEnglishToken)
    .filter(t => t && t.length >= 2 && !stopwords.has(t));
}

// ── Global lemma map ──────────────────────────────────────────
// Top-level Firestore collection shared across the app.

function globalLemmaKey(surface) {
  return String(surface || '')
    .trim().toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[\/\\]/g, '-')
    .slice(0, 200) || '_empty';
}

// ── GLM seed trust window ─────────────────────────────────────
// The global lemma map was bulk-seeded 2026-03-21..23. Seed rows whose
// mapping merely restates the surface (key == cleanedLemma) are reliable
// headword evidence; seed rows that REWRITE the surface include known
// machine-generated errors (처지→처자다, 까닥여→퇴창) and are not trusted
// as mappings. Anything written after the window is an organic correction
// and fully trusted.
const GLM_SEED_END = '2026-03-24';

function glmEntryIsOrganic(entry) {
  return (entry?.updatedAt || '') >= GLM_SEED_END || (entry?.contributorCount || 0) >= 2;
}

// L2 (lemma repair, Oct 2026): the Oct 2026 cleanup vetted
// every seed row against a morphological analyzer and a dictionary word
// list, and wrote two flags:
//   verified: true  — the mapping was confirmed independently → trusted.
//   headword: true  — the key itself is a dictionary word, whatever its
//                     row maps to (봄 is a word even though its row reads
//                     it as a form of 보다).
// An unvetted identity row is no longer headword evidence on its own: the
// seed held junk identities (할다, 다다, 이요) that let wrong candidates
// win. Organic rows (user corrections) stay fully trusted, and vetted
// rows keep their seed-era updatedAt, so a user correction still
// overrides them (writeGlobalLemma).
function glmEntryTrust(key, entry) {
  if (!entry) return { headword: false, mapping: null };
  const lemma    = entry.cleanedLemma || '';
  const organic  = glmEntryIsOrganic(entry);
  const verified = entry.verified === true;
  const identity = globalLemmaKey(lemma) === key;
  return {
    headword: entry.headword === true || (identity && (organic || verified)),
    mapping:  (organic || verified) ? lemma : null,
  };
}

async function fetchGlmEntry(key) {
  try {
    const snap = await getDoc(doc(db, 'globalLemmaMap', key));
    return snap.exists() ? snap.data() : null;
  } catch { return null; }
}

export async function lookupGlobalLemma(surface) {
  if (!surface) return null;
  const key   = globalLemmaKey(surface);
  const entry = await fetchGlmEntry(key);
  return glmEntryTrust(key, entry).mapping;
}

// ── resolveLemmaWithDictionary ────────────────────────────────
// Full async cascade for one surface: trusted GLM mapping first (raw key,
// then normalized key — GLM keys were written from raw staged inputs,
// some with trailing punctuation), then heuristic candidates including
// irregular recoveries validated as headwords against the GLM, then the
// sync heuristic result. Candidates come from the RAW surface:
// extractLemmaFromText tidies punctuation internally, and inputs typed
// directly in the parenthetical lemma convention (마무리(하다)) must pass
// through untouched.
export async function resolveLemmaWithDictionary(surface, opts = {}) {
  return (await resolveLemmaDetailed(surface, { ...opts, withAlternates: false })).lemma;
}

// LM4: a second opinion on a word's dictionary form, from outside the
// rules. The app registers the Korean analyser (lemmaSecondOpinion.js); with
// nothing registered the resolver works from the rules alone.
//   fn(surface, context) → Promise<string[]>   likeliest reading first
// A reading is only ever a candidate: it is checked against the dictionary
// like the rules' own, and ranked right after the rules' first answer. A
// slow, failed or empty answer changes nothing.
let lemmaSecondOpinion = null;
const SECOND_OPINION_MS = 4000;
export function setLemmaSecondOpinion(fn) { lemmaSecondOpinion = typeof fn === 'function' ? fn : null; }
async function secondOpinionReadings(surface, context) {
  if (!lemmaSecondOpinion) return [];
  let timer = null;
  try {
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), SECOND_OPINION_MS); });
    const got = await Promise.race([Promise.resolve().then(() => lemmaSecondOpinion(surface, context)), late]);
    return Array.isArray(got) ? got.filter(c => typeof c === 'string' && /[가-힣]/.test(c)).slice(0, 2) : [];
  } catch { return []; } finally { if (timer) clearTimeout(timer); }
}

// L3: how many candidates are validated against the GLM per surface. The
// stacked-particle peels sit right after the primary, so the irregular
// recoveries further down need the extra room.
const GLM_CANDIDATE_CHECKS = 10;
const MAX_ALTERNATES = 3;

// L3 (lemma repair, Oct 2026): the same cascade, also
// returning the other readings that validate as dictionary words, so the
// Import review and the Sentence Input picker can offer them one tap away
// when the most likely reading is wrong (봄 the noun vs 보다, 낮은 →
// 낮 vs 낮다, 들었어요 → 들다 vs 듣다).
//   { lemma, alternates: string[] }
// alternates are only computed with { withAlternates: true }; they never
// include the lemma itself, and function words get none.
// opts: localHeadwords, withAlternates, context (LM4: the sentence the word
// came from, for the second opinion).
export async function resolveLemmaDetailed(surface, opts = {}) {
  const raw = String(surface || '').trim();
  if (!raw) return { lemma: '', alternates: [] };
  // Optional synchronous validation set: normalized headwords the user
  // already studies (lemmaMaster lemma + cleanedLemma values).
  const localHeadwords = opts.localHeadwords || null;
  const withAlternates = !!opts.withAlternates;
  const isLocal = (c) => !!localHeadwords && (localHeadwords.has(c) || localHeadwords.has(normalizeLemma(c)));

  const variants = [raw, normalizeLemma(raw) || raw];
  // Bare contracted forms (더워, 몰라) often exist in the seed only in their
  // polite shape — include the +요 variant for corroboration.
  if (!raw.endsWith('요') && /[가-힣]$/.test(raw)) variants.push(raw + '요');
  const keys = [...new Set(variants.map(v => globalLemmaKey(v)))];
  // L2: the +요 variant exists to find a rewrite the seed only recorded in
  // its polite shape (더워요→덥다). Its identity row says nothing about the
  // bare surface — accepting it returned 이요 for 이 (and would return the
  // noun 가요 for 가).
  const yoKey = (!raw.endsWith('요') && /[가-힣]$/.test(raw)) ? globalLemmaKey(raw + '요') : null;
  let seedMapping = null;
  let rawIsHeadword = false;
  let trusted = null;
  for (const k of keys) {
    const entry = await fetchGlmEntry(k);
    const trust = glmEntryTrust(k, entry);
    if (k !== yoKey && trust.headword) rawIsHeadword = true;
    if (trust.mapping && !(k === yoKey && globalLemmaKey(trust.mapping) === k)) { trusted = trust.mapping; break; }
    // Remember an untrusted seed rewrite for corroboration below.
    if (!seedMapping && entry && entry.cleanedLemma) seedMapping = entry.cleanedLemma;
  }

  // Stage C: function words never conjugate. Placed after the trusted-GLM
  // loop so an organic user correction still overrides, and before every
  // seed tier so an untrusted seed rewrite (그리고→그리다) never can —
  // 그리다 IS a headword, so the C2 gate below could not reject it.
  if (!trusted && isFunctionWord(normalizeLemma(raw) || raw)) {
    return { lemma: normalizeLemma(raw) || raw, alternates: [] };
  }

  const heuristic = extractLemmaCandidates(raw);
  const primary = heuristic[0] || raw;
  // LM4: the second opinion's readings join right after the rules' first
  // answer. Not asked for when a trusted mapping already answered and no
  // alternates are wanted. opts.context is the sentence the word came from.
  const second = (trusted && !withAlternates) ? [] : await secondOpinionReadings(raw, opts.context);
  const candidates = second.length
    ? [primary, ...second.filter(c => c !== primary), ...heuristic.slice(1).filter(c => !second.includes(c))]
    : heuristic;
  const toCheck = candidates.filter(c => c && c !== raw).slice(0, GLM_CANDIDATE_CHECKS);

  // Headword validation of the candidates, in rank order. Skipped when a
  // trusted mapping already answered and no alternates were asked for.
  let validated = null;
  const validate = async () => {
    if (validated) return validated;
    const entries = await Promise.all(toCheck.map(c => isLocal(c) ? null : fetchGlmEntry(globalLemmaKey(c))));
    validated = toCheck.filter((c, i) => isLocal(c) || glmEntryTrust(globalLemmaKey(c), entries[i]).headword);
    return validated;
  };
  const finish = async (lemma) => {
    if (!withAlternates) return { lemma, alternates: [] };
    const alts = [];
    const add = (c) => {
      // The bare copula validates for any 이-final remainder; never a useful offer.
      if (c === '이다') return;
      if (c && c !== lemma && normalizeLemma(c) !== normalizeLemma(lemma) && !alts.includes(c)) alts.push(c);
    };
    // The surface itself when it is a dictionary word (봄, 보고 the noun).
    if (rawIsHeadword) add(normalizeLemma(raw) || raw);
    for (const c of await validate()) add(c);
    return { lemma, alternates: alts.slice(0, MAX_ALTERNATES) };
  };

  if (trusted) return finish(trusted);

  // LM3: a surface that is a dictionary word itself keeps itself ahead of
  // its bare-ㄴ다 readings (판다 stays the noun, 안다 stays "to hug"); the
  // readings still show as alternates.
  const guarded = rawIsHeadword ? guardedReadings(raw) : null;
  const eligible = (c) => !guarded || !guarded.has(c);

  // Local headword validation: free and synchronous — a candidate the user
  // already studies is accepted immediately (몰라요→모르다 when 모르다 is
  // in lemmaMaster).
  if (localHeadwords) {
    for (const c of candidates) {
      if (c && c !== raw && isLocal(c) && eligible(c)) return finish(c);
    }
  }

  // Dictionary validation outranks seed corroboration: the seed was
  // machine-generated with the same naive suffix assumptions as the
  // heuristic, so a validated headword candidate (이야기는→이야기) must
  // beat a seed row that merely agrees with a heuristic guess.
  const ok = (await validate()).filter(eligible);
  if (ok.length) {
    // L3: 고양이나 validates as both 고양 (+ 이나) and 고양이 (+ 나) — a
    // validated 이-final noun the surface spells out is the likelier one.
    const longer = ok[0] + '이';
    if (ok.includes(longer) && (normalizeLemma(raw) || raw).startsWith(longer)) return finish(longer);
    return finish(ok[0]);
  }

  // L3 — X어지다/X아지다 "become" verbs are productive and mostly absent
  // from the map (쉬워지다, 따뜻해지다): accept one when its base validates
  // (쉬워 → 쉽다).
  for (const c of toCheck) {
    if (!c.endsWith('지다') || hangulCount(c) < 3 || !eligible(c)) continue;
    const stem = c.slice(0, -2);
    const dS = decomposeSyllable(stem[stem.length - 1]);
    if (!dS || dS[2] !== 0 || ![0, 1, 4, 6, 9, 14].includes(dS[1])) continue; // fused 아/어/해/여/와/워
    const bases = extractLemmaCandidates(stem).filter(b => b.endsWith('다')).slice(0, 4);
    const rows = await Promise.all(bases.map(b => isLocal(b) ? null : fetchGlmEntry(globalLemmaKey(b))));
    if (bases.some((b, i) => isLocal(b) || glmEntryTrust(globalLemmaKey(b), rows[i]).headword)) return finish(c);
  }

  // Seed corroboration, last resort: the bulk seed's mappings are
  // individually untrusted, but a seed mapping that exactly matches an
  // independently jamo-derived candidate is two independent signals —
  // hallucinated junk (까닥여→퇴창) can never coincide with a candidate we
  // generated. Reached only when nothing validated as a headword.
  if (seedMapping && seedMapping !== raw && candidates.includes(seedMapping) && eligible(seedMapping)) return finish(seedMapping);

  // L3: a surface that is itself a dictionary word keeps itself rather
  // than taking an uncorroborated seed rewrite (봄 stayed 보다).
  if (rawIsHeadword) return finish(normalizeLemma(raw) || raw);

  // Option B structural gate: allow an uncorroborated seed rewrite through
  // when it is structurally consistent with the surface. Ranked below both
  // headword validation and candidate corroboration; a user correction
  // (organic, trusted, checked first) permanently outranks it.
  // Stage C: the 2-jamo shared prefix is trivially satisfied by any mapping
  // sharing the first consonant+vowel (가고→갓다, 빨리→빠우다 both passed),
  // so additionally require the mapping itself to validate as a GLM
  // headword — junk strings like 갓다/빠우다 have no identity row and are
  // rejected; legitimate irregulars (더워→덥다) keep passing. One extra
  // read, only in this last-resort branch.
  if (seedMapping && seedMappingPlausible(raw, seedMapping)) {
    const mKey = globalLemmaKey(seedMapping);
    if (glmEntryTrust(mKey, await fetchGlmEntry(mKey)).headword) return finish(seedMapping);
  }

  // LM4: nothing was confirmed and the rules left the word as it was: take
  // the second opinion's reading if it has one (a form the rules have no
  // ending for, of a word the map lacks).
  if (second.length && primary === tidySurface(raw) && second[0] !== primary) return finish(second[0]);

  // LM4: nothing was confirmed. An unknown word in a copula shape is far
  // more likely a noun the map lacks (a name, a loanword) than a verb
  // ending in 이다, so the noun is the better guess (민수입니다 → 민수).
  if (primary.endsWith('이다') && primary !== tidySurface(raw) && candidates.includes(primary.slice(0, -2))) {
    return finish(primary.slice(0, -2));
  }

  return finish(primary || raw);
}

// ── seedMappingPlausible ──────────────────────────────────────
// Structural sanity for an uncorroborated seed rewrite: accept only a
// mapping that is the surface minus trailing material (particle/copula
// strip shape) or a 다-final headword sharing the surface's leading jamo
// without ballooning in length. Hallucinated rows (까닥여→퇴창) share no
// prefix and are rejected; the residual risk is a naive-suffix mangle
// that happens to share a prefix, which validation above never reaches
// and a single user correction permanently overrides.
function jamoPrefixShare(a, b) {
  const J = (s) => {
    const o = [];
    for (const ch of s) {
      const d = decomposeSyllable(ch);
      if (d) { o.push('c' + d[0], 'v' + d[1]); if (d[2]) o.push('f' + d[2]); }
      else o.push(ch);
    }
    return o;
  };
  const ja = J(a), jb = J(b);
  let n = 0;
  while (n < ja.length && n < jb.length && ja[n] === jb[n]) n++;
  return n;
}

export function seedMappingPlausible(raw, mapping) {
  if (!raw || !mapping || mapping === raw) return false;
  if (!/[가-힣]/.test(mapping)) return false;
  if (raw.startsWith(mapping)) return true;
  if (!mapping.endsWith('다')) return false;
  if (hangulCount(mapping) > hangulCount(raw) + 1) return false;
  return jamoPrefixShare(raw, mapping) >= 2;
}

// ── fetchDefinitionWithFallback ───────────────────────────────
// Tier 2: a KRDict miss on a machine-resolved lemma is strong evidence the
// resolution was wrong — dictionary reality outranks the heuristic. Retry
// the fetch with the next distinct candidates for the original surface;
// the first candidate with a real entry wins and is adopted as the lemma.
// Pass an empty surface to disable the retry (user-supplied or locally
// mapped lemmas are respected as-is).
export async function fetchDefinitionWithFallback(surface, lemma, aviSettings) {
  const first = await fetchDefinition(lemma, aviSettings);
  if (first === 'Definition not found.' && surface) {
    const alts = extractLemmaCandidates(surface).filter(c => c && c !== lemma).slice(0, 2);
    for (const c of alts) {
      const d = await fetchDefinition(c, aviSettings);
      if (d === '__RATE_LIMITED__') break;
      if (d && d !== 'Definition not found.') return { lemma: c, def1: d };
    }
  }
  return { lemma, def1: first === '__RATE_LIMITED__' ? first : (first || '') };
}

export async function writeGlobalLemma(surface, cleanedLemma) {
  if (DEMO) return; // demo: rules deny GLM writes server-side; skip the attempt entirely
  if (!surface || !cleanedLemma) return;
  try {
    const key = globalLemmaKey(surface);
    const ref = doc(db, 'globalLemmaMap', key);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const existing = snap.data();
      // L2: merge, so the cleanup's headword flag (a fact about the key, not
      // the mapping) survives a correction.
      if (existing.cleanedLemma === cleanedLemma) {
        await setDoc(ref, {
          cleanedLemma,
          contributorCount: (existing.contributorCount || 1) + 1,
          updatedAt: new Date().toISOString(),
        }, { merge: true });
      } else if (!glmEntryIsOrganic(existing)) {
        // Seed-era rows with rewritten mappings include machine-generated
        // errors — a manual correction overrides them, vetted rows included.
        await setDoc(ref, { cleanedLemma, contributorCount: 1, updatedAt: new Date().toISOString() }, { merge: true });
      }
      // Organic conflicting entries keep first-writer-wins.
    } else {
      await setDoc(ref, { cleanedLemma, contributorCount: 1, updatedAt: new Date().toISOString() });
    }
  } catch {}
}

// ── Update flashcard fields by linkedAVILemmaId ───────────────
// Shared by Lemma Master and Word Input cascades. Matches cards by the
// UNION of the ID lookup and the normalized-lemma-text lookup: one lemma's
// cards can carry different linkedAVILemmaId values (a stale ID left by a
// deleted-then-recreated entry, a nuance-deck card minted against a later
// entry), and the old ID-first/text-fallback order silently skipped those
// siblings whenever the ID matched at least one card — a def2 edit then
// updated one card and left the others stale. Repairs linkedAVILemmaId on
// matched cards as a side-effect unless the caller's updates already set it.
// Accepts either a static `updates` object or a per-card `buildUpdates(card)`
// function — return null/undefined from buildUpdates to skip that card.
// A8: what runs after cards are renamed (AVIPage registers the TTS refresh,
// ttsUtils.refreshRenamedCardAudio). Set from outside so this module's
// imports, and the golden harnesses that bundle it, stay as they were.
let renamedCardsHandler = null;
export function setRenamedCardsHandler(fn) { renamedCardsHandler = typeof fn === 'function' ? fn : null; }

export async function updateLinkedCards({ lemmaID, lemmaText, updates, buildUpdates, cards, uid, updateCards, memoryFirst = false }) {
  if ((!lemmaID && !lemmaText) || !cards || !uid) return;

  const byIdMatch = lemmaID ? cards.filter(c => c.linkedAVILemmaId === lemmaID) : [];
  const normText  = lemmaText ? normalizeLemma(lemmaText) : '';
  const byTextMatch = normText
    ? cards.filter(c => c.type !== 'grammar' && c.lemma && normalizeLemma(c.lemma) === normText)
    : [];
  const linkedMap = new Map();
  for (const c of [...byIdMatch, ...byTextMatch]) linkedMap.set(c.id, c);
  const linked = [...linkedMap.values()];
  if (!linked.length) {
    console.warn('updateLinkedCards: no cards found for lemmaID', lemmaID, '/ lemma', lemmaText);
    return;
  }

  const pairs = [];
  for (const c of linked) {
    const base = buildUpdates ? buildUpdates(c) : { ...updates };
    if (!base) continue;
    const cardUpdates = { ...base };
    if (lemmaID && c.linkedAVILemmaId !== lemmaID && cardUpdates.linkedAVILemmaId === undefined) {
      cardUpdates.linkedAVILemmaId = lemmaID;
    }
    pairs.push([c, cardUpdates]);
  }
  if (!pairs.length) return;

  // memoryFirst: the cards change on screen in the same update as the
  // caller's rows (the merge uses it, so the 동의어 card effect sees the
  // renamed card instead of making a second one); the write follows.
  const byId = new Map(pairs.map(([c, u]) => [c.id, u]));
  const applyInMemory = () => updateCards(prev => {
    if (!prev) return prev;
    return prev.map(c => byId.has(c.id) ? { ...c, ...byId.get(c.id) } : c);
  });
  if (memoryFirst) applyInMemory();

  const batch = writeBatch(db);
  pairs.forEach(([c, u]) => batch.update(doc(db, 'users', uid, 'flashcards', c.id), withCardStamp(u)));
  await batch.commit();

  if (!memoryFirst) applyInMemory();

  // A8: renamed cards get word audio for the new word (Echo's Dictation and
  // audio prompts reuse it). Runs in the background.
  const renamed = pairs
    .filter(([c, u]) => c.type !== 'grammar' && u.lemma !== undefined &&
      normalizeLemma(u.lemma || '') !== normalizeLemma(c.lemma || ''))
    .map(([c, u]) => ({ ...c, ...u }));
  if (renamed.length && renamedCardsHandler) {
    Promise.resolve()
      .then(() => renamedCardsHandler({ cards: renamed, uid, updateCards }))
      .catch(e => console.error('updateLinkedCards: audio refresh failed', e));
  }
}

// ── Rate limiter for Claude API ───────────────────────────────
const _RATE_KEY = 'avi-api-calls';

function _rateCalls() {
  const now = Date.now();
  try {
    const stored = JSON.parse(localStorage.getItem(_RATE_KEY) || '[]');
    return stored.filter(t => now - t < 60_000);
  } catch { return []; }
}

function apiRateLimitOk(maxPerMinute = 5) {
  const now   = Date.now();
  const calls = _rateCalls();
  const limit = Math.max(1, maxPerMinute);
  if (calls.length >= limit) return false;
  calls.push(now);
  try { localStorage.setItem(_RATE_KEY, JSON.stringify(calls)); } catch {}
  return true;
}

export function apiCallsRemaining(maxPerMinute = 5) {
  return Math.max(0, Math.max(1, maxPerMinute) - _rateCalls().length);
}

// ── KRDict XML parser ─────────────────────────────────────────
// Parses the XML response from the official KRDict API.
function parseKrDictApiXml(xml, lang, queriedLemma) {
  if (!xml) return '';
  try {
    const stripCdata = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim();
    const groups = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/gi;
    let im;

    while ((im = itemRe.exec(xml)) !== null) {
      const itemBlock = im[1];
      const wordMatch = itemBlock.match(/<word>([\s\S]*?)<\/word>/i);
      const headword  = wordMatch ? stripCdata(wordMatch[1]) : '';
      const posMatch  = itemBlock.match(/<pos>([\s\S]*?)<\/pos>/i);
      const pos       = posMatch ? stripCdata(posMatch[1]) : '';

      const senses = [];
      const senseRe = /<sense>([\s\S]*?)<\/sense>/gi;
      let sm;
      while ((sm = senseRe.exec(itemBlock)) !== null) {
        const block = sm[1];
        let def = '';
        if (lang === 'kor') {
          const defMatch = block.match(/<definition>([\s\S]*?)<\/definition>/i);
          def = defMatch ? stripCdata(defMatch[1]) : '';
        } else {
          const transBlock = block.match(/<translation>([\s\S]*?)<\/translation>/i);
          if (transBlock) {
            const tw  = transBlock[1].match(/<trans_word>([\s\S]*?)<\/trans_word>/i);
            const tdf = transBlock[1].match(/<trans_dfn>([\s\S]*?)<\/trans_dfn>/i);
            const w   = tw  ? stripCdata(tw[1])  : '';
            const d   = tdf ? stripCdata(tdf[1]) : '';
            def = w && d ? `${w}: ${d}` : w || d;
          }
        }
        if (def) senses.push(def);
      }

      if (senses.length > 0) groups.push({ headword, pos, senses });
    }

    if (groups.length === 0) return '';

    const lines = [];
    let num = 1;
    const normQ = (queriedLemma || '').trim().toLowerCase();

    for (let gi = 0; gi < groups.length; gi++) {
      const { headword, pos, senses } = groups[gi];
      const isExact = gi === 0 || headword.toLowerCase() === normQ;

      // Add headword label for non-primary headwords
      if (!isExact) {
        lines.push(`[${headword}${pos ? ' · ' + pos : ''}]`);
      }

      for (const sense of senses) {
        lines.push(`${num}. ${sense}`);
        num++;
      }
    }

    return lines.join('\n\n');
  } catch { return ''; }
}

// ── KRDict (English) via Netlify function ─────────────────────
// No client-side API key needed — key is configured in Netlify env.
// L1: two different outcomes, never conflated —
//   'Definition not found.' → KRDict answered and has no entry (a real miss;
//                             may trigger the Tier 2 candidate retry).
//   ''                      → KRDict could not be reached (502/503/504,
//                             network error). Nothing is saved, no candidate
//                             retry fires, and the row stays def1-less so a
//                             later refresh fills it.
// One client retry after a short pause covers a single bad function
// instance; the function itself already retries inside its time budget.
async function fetchKrDict(lemma, lang) {
  if (!lemma) return '';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1200));
    try {
      const resp = await apiFetch('/api/get-krdict-api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lemma, lang }),
      });
      if (resp.ok) {
        const json   = await resp.json();
        const result = parseKrDictApiXml(json.xml || '', lang, lemma);
        return result || 'Definition not found.';
      }
      // Only gateway/upstream failures are worth a retry; anything else
      // (401, 405, 400) will not change on a second try.
      if (![502, 503, 504].includes(resp.status)) return '';
    } catch {}
  }
  return '';
}

async function fetchKrDictEn(lemma) {
  return fetchKrDict(lemma, 'eng');
}

// ── KRDict (Korean) via Netlify function ──────────────────────
async function fetchKrDictKo(lemma) {
  return fetchKrDict(lemma, 'kor');
}

// ── KRDict bilingual ──────────────────────────────────────────
const BILINGUAL_SEPARATOR = '\n\n· · ·\n\n';

async function fetchKrDictBilingual(lemma) {
  const [en, ko] = await Promise.all([fetchKrDictEn(lemma), fetchKrDictKo(lemma)]);
  // L1: either half unreachable → report the whole lookup as unreachable,
  // so a half-filled bilingual def1 is never saved.
  if (en === '' || ko === '') return '';
  const parts = [en, ko].filter(d => d && d !== 'Definition not found.');
  return parts.length === 0 ? 'Definition not found.' : parts.join(BILINGUAL_SEPARATOR);
}

// ── Claude API via Netlify function ───────────────────────────
// No client-side API key needed — key is configured in Netlify env.
// A12: like KRDict mode (L1), a failed call (offline, timeout, expired
// sign-in, server error) returns '' — "couldn't reach the dictionary" — so
// callers keep the existing def1 instead of saving a fake miss. Only an
// answer with no definition in it is a real "Definition not found."
async function fetchClaudeDefinition(lemma, apiRateLimit = 5) {
  if (!lemma || lemma.length > 80) return '';
  if (!apiRateLimitOk(apiRateLimit)) return '__RATE_LIMITED__';
  try {
    const resp = await apiFetch('/api/get-definition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lemma }),
    });
    if (!resp.ok) throw new Error('Function error: ' + resp.status);
    const json = await resp.json();
    return json.definition?.trim() || 'Definition not found.';
  } catch (e) {
    console.warn('API dictionary unreachable:', e?.message || e);
    return '';
  }
}

// ── fetchDefinition — main entry point ────────────────────────
// Normalizes lemma, handles "/" splits and "(suffix)" expansions,
// fetches each sub-term and merges results.
//
// @param {string} lemma
// @param {object} aviSettings  — { dictMode, apiRateLimit }
export async function fetchDefinition(lemma, aviSettings = {}) {
  const mode         = aviSettings.dictMode    || 'krdict';
  const apiRateLimit = aviSettings.apiRateLimit ?? 5;
  const terms        = buildFetchTerms(lemma);
  if (terms.length === 0) return '';

  async function fetchOne(term) {
    if (mode === 'krdict')    return fetchKrDictEn(term);
    if (mode === 'krdict-ko') return fetchKrDictKo(term);
    if (mode === 'krdict-bi') return fetchKrDictBilingual(term);
    return fetchClaudeDefinition(term, apiRateLimit); // mode === 'api'
  }

  if (terms.length === 1) return fetchOne(terms[0]);

  // Composite: fetch each expanded term and merge
  const raw = await Promise.all(terms.map(t => fetchOne(t)));
  if (raw.includes('__RATE_LIMITED__')) return '__RATE_LIMITED__';
  // L1: a block that could not be reached makes the whole composite
  // unreachable, so a partial merge is never saved as def1 (A12: API mode too).
  if (raw.some(d => d === '')) return '';
  const blocks = raw.map(def => def || 'Definition not found.');
  return blocks.join('\n\n-----\n\n');
}

// ── Lemma-correction definition rules (bug sweep A1–A3) ───────
// A lookup result may replace a definition only when it is a real hit.
// '' (dictionary unreachable), the __RATE_LIMITED__ / __NO_API_KEY__
// sentinels, and results made only of "Definition not found." blocks
// (a miss, including every block of a composite) never count.
export function isRealDefinition(d) {
  if (!d || typeof d !== 'string' || d.startsWith('__')) return false;
  return d.replace(/definition not found\.?/gi, '').replace(/[\s\-·]/g, '') !== '';
}

// Two lemmas that differ only in parentheticals and spacing
// (날리다 → (주먹을) 날리다) name the same headword, so the old def1 still
// applies when the dictionary has nothing for the new form.
export function isLemmaVariant(a, b) {
  const core = s => String(s || '').normalize('NFC').replace(/\([^)]*\)/g, '').replace(/\s+/g, '');
  const ca = core(a);
  return !!ca && ca === core(b);
}

// def1 after a lemma correction or rename, when there is no typed def1
// and no existing entry with a real def1 to take it from:
//   real hit                       → the hit
//   same headword (variant)        → keep the current def1
//   different word, real miss      → "Definition not found."
//   different word, lookup failed  → '' so a later refresh fills it
export function resolveCorrectedDef1(fetched, currentDef1, oldLemma, newLemma) {
  if (isRealDefinition(fetched)) return fetched;
  if (isLemmaVariant(oldLemma, newLemma)) return currentDef1 || '';
  if (fetched && typeof fetched === 'string' && !fetched.startsWith('__')) return fetched;
  return '';
}

// ── Shared lemma-relation mutation logic ──────────────────────
// Used by every place that creates/edits relatedForm/relatedMeaning/hiddenRelated
// pins on lemmaMaster entries: AVILemmaMasterPage's MiniSearchPopup, AVIMiniSearchPopup
// (Word Input), AVISearchPage, and AVISearchPage's ConnectListModal.

// The synonym word list (source, deck and rows share this title). It was
// '동의어/유의어' until Oct 2026; rows and decks still under the old title
// (before the Library rename runs its cascade) are recognized as the same
// list, and new rows join whichever title the list's rows already use.
export const NUANCE_SOURCE_TITLE = '동의어';
export const LEGACY_NUANCE_SOURCE_TITLE = '동의어/유의어';
export const isNuanceSourceTitle = (title) =>
  title === NUANCE_SOURCE_TITLE || title === LEGACY_NUANCE_SOURCE_TITLE;
export function nuanceSourceTitleIn(wordInputs) {
  return (wordInputs || []).find(w => isNuanceSourceTitle(w.source))?.source || NUANCE_SOURCE_TITLE;
}

// Relation ids that point at an existing Lemma Master entry (R2: a deleted
// entry's id can linger in other entries' relations; it doesn't count).
const relationIds = (field) => String(field || '').split(',').map(s => s.trim()).filter(Boolean);
export function liveMeaningIds(entry, lemmaIds) {
  return relationIds(entry?.relatedMeaning).filter(id => id !== entry.lemmaID && lemmaIds.has(id));
}

// R2: removes (or, with `remap`, repoints) relation ids on every entry —
// for a lemma delete (removedIds) or a merge (remap: edited id → survivor).
// Self-references the remap produces are dropped. Pure; entries that don't
// change keep their reference. Returns the ids of entries whose
// relatedMeaning changed, for syncNuanceSource.
export function stripLemmaRelations(lemmaMaster, removedIds = [], remap = {}) {
  const gone = new Set(removedIds);
  const affected = [];
  const now = new Date().toISOString();
  const next = lemmaMaster.map(l => {
    const clean = (field, skip = new Set()) =>
      [...new Set(relationIds(l[field]).map(id => remap[id] || id))]
        .filter(id => !gone.has(id) && id !== l.lemmaID && !skip.has(id));
    const formIds    = clean('relatedForm');
    const meaningIds = clean('relatedMeaning');
    // A remap can land one id in both a pin and the hidden list; the pin wins.
    const hiddenIds  = clean('hiddenRelated', new Set([...formIds, ...meaningIds]));
    const changed = (field, ids) => (ids.join(',') === relationIds(l[field]).join(',') ? null : ids.join(','));
    const form = changed('relatedForm', formIds), meaning = changed('relatedMeaning', meaningIds), hidden = changed('hiddenRelated', hiddenIds);
    if (form === null && meaning === null && hidden === null) return l;
    if (meaning !== null) affected.push(l.lemmaID);
    return {
      ...l,
      ...(form    !== null ? { relatedForm:    form    } : {}),
      ...(meaning !== null ? { relatedMeaning: meaning } : {}),
      ...(hidden  !== null ? { hiddenRelated:  hidden  } : {}),
      lastUpdated: now,
    };
  });
  return { lemmaMaster: next, affected };
}

function relationSets(entry) {
  return {
    form:    new Set((entry.relatedForm    || '').split(',').map(s => s.trim()).filter(Boolean)),
    meaning: new Set((entry.relatedMeaning || '').split(',').map(s => s.trim()).filter(Boolean)),
    hidden:  new Set((entry.hiddenRelated  || '').split(',').map(s => s.trim()).filter(Boolean)),
  };
}

function withRelationSets(entry, { form, meaning, hidden }) {
  return {
    ...entry,
    relatedForm:    [...form].join(','),
    relatedMeaning: [...meaning].join(','),
    hiddenRelated:  [...hidden].join(','),
    lastUpdated:    new Date().toISOString(),
  };
}

// Keeps 동의어 membership consistent with each affected lemma's current
// relatedMeaning state: adds a capture if meaning is non-empty and none exists
// yet, removes the capture if meaning is now empty, and collapses duplicates
// down to one (covers the lemma-merge case, where both sides could have had
// their own capture before merging). Runs after every pin/connect action,
// regardless of relation type — checking final state rather than trying to
// detect "did meaning specifically change" is simpler and correct either way.
// R2: only links to entries that still exist count as meaning links.
// R1: a capture removed here takes its card out of the deck too (AVIPage).
export function syncNuanceSource(wordInputs, lemmaMaster, affectedLemmaIDs) {
  const added = [];
  const removed = [];
  let next = wordInputs;
  const lemmaIds = new Set(lemmaMaster.map(l => l.lemmaID));
  const title = nuanceSourceTitleIn(wordInputs);

  affectedLemmaIDs.forEach(lemmaID => {
    const entry = lemmaMaster.find(l => l.lemmaID === lemmaID);
    if (!entry) return;
    const hasMeaning = liveMeaningIds(entry, lemmaIds).length > 0;
    const norm = normalizeLemma(entry.lemma);
    const existing = next.filter(w => isNuanceSourceTitle(w.source) && normalizeLemma(w.lemma) === norm);

    if (hasMeaning && existing.length === 0) {
      const newRow = {
        uid: uuid(),
        ts: new Date().toISOString(),
        input: entry.lemma,
        source: title,
        section: null,
        lemma: entry.lemma,
        def1: entry.def1 || '',
        def2: entry.def2 || '',
        uploaded: true,
        skipUpload: false,
        lastUncheckReason: '',
        lastUncheckDate: '',
      };
      next = [newRow, ...next];
      added.push(entry.lemma);
    } else if (hasMeaning && existing.length > 1) {
      const extraUids = new Set(existing.slice(1).map(w => w.uid));
      next = next.filter(w => !extraUids.has(w.uid));
    } else if (!hasMeaning && existing.length > 0) {
      const existingUids = new Set(existing.map(w => w.uid));
      next = next.filter(w => !existingUids.has(w.uid));
      removed.push(entry.lemma);
    }
  });

  return { wordInputs: next, added, removed };
}

export function notifyNuanceSync(showAVIToast, added, removed) {
  if (!showAVIToast) return;
  if (added.length)   showAVIToast(`Added to ${NUANCE_SOURCE_TITLE}: ${added.join(', ')}`, 'goToNuanceSource');
  if (removed.length) showAVIToast(`Removed from ${NUANCE_SOURCE_TITLE}: ${removed.join(', ')}`, 'goToNuanceSource');
}

// Bidirectional pin/hide toggle between two lemmas (the per-row checkboxes).
// `type` is 'pinForm' | 'pinMeaning' | 'hide'. `showAVIToast` is optional —
// pass it to get feedback when this action adds/removes a 동의어 capture.
export function applyRelationPin(prevData, anchorLemmaId, otherLemmaId, type, isChecked, showAVIToast) {
  const update = (entry, otherID) => {
    const { form, meaning, hidden } = relationSets(entry);
    if (type === 'pinForm') {
      if (isChecked) { form.add(otherID); hidden.delete(otherID); } else form.delete(otherID);
    } else if (type === 'pinMeaning') {
      if (isChecked) { meaning.add(otherID); hidden.delete(otherID); } else meaning.delete(otherID);
    } else {
      if (isChecked) { hidden.add(otherID); form.delete(otherID); meaning.delete(otherID); } else hidden.delete(otherID);
    }
    return withRelationSets(entry, { form, meaning, hidden });
  };
  const nextLemmaMaster = prevData.lemmaMaster.map(l => {
    if (l.lemmaID === anchorLemmaId) return update(l, otherLemmaId);
    if (l.lemmaID === otherLemmaId)  return update(l, anchorLemmaId);
    return l;
  });
  const { wordInputs: nextWordInputs, added, removed } = syncNuanceSource(
    prevData.wordInputs, nextLemmaMaster, [anchorLemmaId, otherLemmaId]
  );
  notifyNuanceSync(showAVIToast, added, removed);
  return { ...prevData, lemmaMaster: nextLemmaMaster, wordInputs: nextWordInputs };
}

// All-pairs "Connect" for a basket/list of lemmas. `relType` is 'Form' | 'Meaning' | 'Both'.
// `showAVIToast` is optional, same as above.
export function applyRelationConnect(prevData, lemmaIds, relType, showAVIToast) {
  const pairs = [];
  for (let i = 0; i < lemmaIds.length; i++)
    for (let j = i + 1; j < lemmaIds.length; j++)
      pairs.push([lemmaIds[i], lemmaIds[j]]);

  let lm = [...prevData.lemmaMaster];
  for (const [idA, idB] of pairs) {
    lm = lm.map(entry => {
      if (entry.lemmaID !== idA && entry.lemmaID !== idB) return entry;
      const otherId = entry.lemmaID === idA ? idB : idA;
      const { form, meaning, hidden } = relationSets(entry);
      if (relType === 'Form'    || relType === 'Both') { form.add(otherId);    hidden.delete(otherId); }
      if (relType === 'Meaning' || relType === 'Both') { meaning.add(otherId); hidden.delete(otherId); }
      return withRelationSets(entry, { form, meaning, hidden });
    });
  }
  const { wordInputs: nextWordInputs, added, removed } = syncNuanceSource(
    prevData.wordInputs, lm, lemmaIds
  );
  notifyNuanceSync(showAVIToast, added, removed);
  return { ...prevData, lemmaMaster: lm, wordInputs: nextWordInputs };
}

// ── Shared source/section lookup ───────────────────────────────
// Returns the sections belonging to a source (by title), in Content Library
// order: the source's explicit sectionOrder when present, natural compare on
// the full content string otherwise (so 문법 1.2 sorts after 문법 1.1 and
// named sections keep their CL position — no trailing-digit parsing). Used
// anywhere that needs to know "does this source have sections, and which
// ones" — the topbar source selector, the Source tab, and the
// section-required gating on the input pages.
export function getSourceSections(aviSources, aviSections, sourceTitle) {
  const src = aviSources.find(s => s.title === sourceTitle);
  if (!src) return [];
  const naturalKey = (str) => {
    const parts = [];
    (str || '').replace(/(\d+)|(\D+)/g, (_, num, txt) => { parts.push(num ? parseInt(num, 10) : txt.toLowerCase()); });
    return parts;
  };
  const naturalCompare = (a, b) => {
    const ka = naturalKey(a.content), kb = naturalKey(b.content);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      const av = ka[i] ?? '', bv = kb[i] ?? '';
      if (av < bv) return -1;
      if (av > bv) return 1;
    }
    return 0;
  };
  const list  = aviSections.filter(s => s.resourceId === src.id);
  const order = src.sectionOrder;
  if (order?.length) {
    const orderMap = Object.fromEntries(order.map((id, i) => [id, i]));
    return list.sort((a, b) => {
      const ai = orderMap[a.id] ?? Infinity, bi = orderMap[b.id] ?? Infinity;
      return ai !== bi ? ai - bi : naturalCompare(a, b);
    });
  }
  return list.sort(naturalCompare);
}

// Builds a { 'YYYY-MM-DD': count } map of word/sentence mining activity —
// used by AVIOverviewPage's heatmap, and shared with anything else that
// wants the same day-by-day activity signal (e.g. a streak computation).
// T2: rows count on the logical day they were added (local time, before
// the day-start hour = the day before). `ts` is a UTC ISO stamp, so its
// first ten characters put anything added before 9 AM KST on the day before.
export function buildWordsByDay(wordInputs, sentenceInputs, dsh = 3) {
  const map = {};
  for (const w of wordInputs || []) {
    const d = logicalDateOf(w.ts, dsh);
    if (d) map[d] = (map[d] || 0) + 1;
  }
  for (const s of sentenceInputs || []) {
    const d = logicalDateOf(s.ts, dsh);
    if (d) map[d] = (map[d] || 0) + 1;
  }
  return map;
}

// Personal-record stats for the AVI Overview records strip (Stage A-3),
// computed from the same wordsByDay map the heatmap renders — words and
// sentences both count (any addition counts). Pure math, no Firestore
// aggregate: unlike Flashcards' reviewStats, all AVI inputs are already
// loaded client-side, so records are cheap to derive on the fly.
// Week starts Monday, matching reviewStatsEngine and the heatmap rows.
// Current streak reuses computeStreak (dateUtils) — the same helper the
// Hanok Gazette's "AVI streak" row uses — so the two never drift, and it
// respects the logical day-flip (streak stays alive until logical today
// ends without an addition).
export function buildAviRecords(byDay, dsh = 3) {
  const empty = { bestDay: null, bestWeek: null, bestMonth: null, longestStreak: 0, currentStreak: 0 };
  if (!byDay) return empty;
  const dates = Object.keys(byDay).filter(d => byDay[d] > 0).sort();
  if (!dates.length) return empty;

  const pad = n => String(n).padStart(2, '0');
  const weekStartOf = (dateStr) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const dow = (dt.getDay() + 6) % 7; // 0 = Monday
    dt.setDate(dt.getDate() - dow);
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  };
  const prevDay = (dateStr) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    return toDateStr(new Date(y, m - 1, d - 1));
  };

  let bestDay = null;
  const weekTotals = {}, monthTotals = {};
  for (const d of dates) {
    const count = byDay[d];
    if (!bestDay || count > bestDay.count) bestDay = { date: d, count };
    const ws = weekStartOf(d);
    weekTotals[ws] = (weekTotals[ws] || 0) + count;
    const ym = d.slice(0, 7);
    monthTotals[ym] = (monthTotals[ym] || 0) + count;
  }
  let bestWeek = null;
  for (const [weekStart, count] of Object.entries(weekTotals)) {
    if (!bestWeek || count > bestWeek.count) bestWeek = { weekStart, count };
  }
  let bestMonth = null;
  for (const [ym, count] of Object.entries(monthTotals)) {
    if (!bestMonth || count > bestMonth.count) bestMonth = { ym, count };
  }

  const dateSet = new Set(dates);
  let longestStreak = 0;
  for (const d of dates) {
    if (dateSet.has(prevDay(d))) continue; // only start counting at streak heads
    let len = 1;
    let [y, m, dd] = d.split('-').map(Number);
    let next = toDateStr(new Date(y, m - 1, dd + 1));
    while (dateSet.has(next)) {
      len++;
      [y, m, dd] = next.split('-').map(Number);
      next = toDateStr(new Date(y, m - 1, dd + 1));
    }
    if (len > longestStreak) longestStreak = len;
  }

  return { bestDay, bestWeek, bestMonth, longestStreak, currentStreak: computeStreak(byDay, dsh) };
}


// ── Row-level duplicate filters (append-time backstops) ───────
// Used inside updateData functional updaters by the Sentence Input and
// Import flows. Functional updaters always see the latest state, so
// filtering here is race-proof against double-fired handlers and
// stale-closure bursts — the same race class as the cardFactory guards,
// applied to rows. Each filter also dedupes within the incoming batch
// itself (a repeated token in one sentence, two surface forms resolving
// to one lemma).

// One sentence row per (source, target lemma, sentence) — the same key
// as the Sentence Input page's classifySentenceDup.
export function filterNewSentenceRows(existingRows, newRows) {
  const keyOf = r => `${r.source}|${normalizeLemma(r.targetWord)}|${r.sentence}`;
  const seen = new Set((existingRows || []).map(keyOf));
  const out = [];
  for (const r of newRows || []) {
    const k = keyOf(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

// One word row per (source, section, lemma). Deliberately NOT keyed on
// source alone: a lemma recaptured in a later section of the same source
// still gets its row (section counts — the wordRowUpdater precedent).
// Stricter per-flow rules (alreadyInSource, input-anywhere) remain at
// their call sites as pre-checks; this is the uniform floor.
export function filterNewWordRows(existingRows, newRows) {
  const keyOf = r => `${r.source}|${r.section}|${normalizeLemma(r.lemma)}`;
  const seen = new Set((existingRows || []).map(keyOf));
  const out = [];
  for (const r of newRows || []) {
    const k = keyOf(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

// One lemmaMaster entry per normalized lemma.
export function filterNewLemmas(existingLemmas, newLemmas) {
  const keyOf = l => l.cleanedLemma || normalizeLemma(l.lemma);
  const seen = new Set((existingLemmas || []).map(keyOf));
  const out = [];
  for (const l of newLemmas || []) {
    const k = keyOf(l);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}