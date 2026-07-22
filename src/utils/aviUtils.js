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
import { toDateStr, computeStreak } from './dateUtils.js';
import { db } from '../firebase.js';
import { DEMO } from '../demo/demoConfig.js';

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
  s = String(s).trim();
  s = s.replace(/^[\s"'\u201C\u201D\u2018\u2019]+/, '')
       .replace(/[\s"'\u201C\u201D\u2018\u2019]+$/, '');
  s = s.replace(/\uFEFF|\u200B|\u200C|\u200D/g, '');
  s = s.replace(/^\([^)]*\)\s*/, '');
  s = s.replace(/^~\S*\s*/, '');
  s = s.replace(/\s*\[[^\]]*\]\s*$/, '');
  s = s.replace(/[\s.,:;!?-]+$/, '');
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
];
// Pre-sorted longest-first so 하는 wins over 는, 에서 over 에, etc.
const KVE_SORTED = [...KOREAN_VERB_ENDINGS].sort((a, b) => b[0].length - a[0].length);

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
  if (![0, 1, 4, 6, 9, 14].includes(d[1])) return null;
  const map = { 1: 0, 9: 8, 14: 13, 6: 20 }; // ㅐ→ㅏ, ㅘ→ㅗ, ㅝ→ㅜ, ㅕ→ㅣ
  const v = map[d[1]] !== undefined ? map[d[1]] : d[1];
  return composeSyllable(d[0], v, 0);
}
function hangulCount(s) {
  const m = String(s || '').match(/[가-힣]/g);
  return m ? m.length : 0;
}
function decontractIfPast(cand) {
  if (!cand.endsWith('다') || cand.length < 2) return cand;
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

// ── extractLemmaFromText ──────────────────────────────────────
// Attempts to de-conjugate Korean text into dictionary headword form.
// Stage 3: the suffix table runs FIRST — the previous ends-with-다 early
// return made every 다-final table entry (습니다, 었다, 는다…) unreachable.
export function extractLemmaFromText(cleaned) {
  if (!cleaned) return '';
  const text  = String(cleaned).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n').map(l => l.replace(/\s+/g, ' ').trim());

  const tidy = (s) => {
    if (!s) return '';
    s = s.replace(/^[\u2018\u2019\u201C\u201D"'`]+\s*/g, '')
         .replace(/\s*[\u2018\u2019\u201C\u201D"'`]+$/g, '');
    return s.replace(/[.,:;?!]+$/, '').trim();
  };

  const deconjugate = (token) => {
    if (!token || !/[가-힣]/.test(token)) return token;
    for (const rule of KVE_SORTED) {
      const suffix = rule[0], replacement = rule[1], minStem = rule[2];
      if (token.endsWith(suffix)) {
        const stem = token.slice(0, token.length - suffix.length);
        if (hangulCount(stem) >= minStem && /[가-힣]/.test(stem)) {
          const cand = replacement ? stem + replacement : stem;
          return decontractIfPast(cand) || token;
        }
      }
    }
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

// ── extractLemmaCandidates ────────────────────────────────────
// Ranked candidate lemmas for one surface token, including irregular-verb
// recoveries (ㅂ/르/ㄷ/ㅅ/으) that are too ambiguous to apply blind.
// Consumed by resolveLemmaWithDictionary, which only accepts a candidate
// after validating it as a headword against the global lemma map.
export function extractLemmaCandidates(surface) {
  const out = [];
  const push = (c) => { if (c && /[가-힣]/.test(c) && !out.includes(c)) out.push(c); };
  push(extractLemmaFromText(surface) || '');

  // Peel only the polite 요 (and a fully spelled 었어요/았어요) so the
  // contracted stem stays intact: 들어요→들어, 더워요→더워, 써요→써.
  let t = String(surface || '').trim().replace(/[.,:;?!]+$/, '');
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
  const t2 = String(surface || '').trim().replace(/[.,:;?!]+$/, '');
  // (a) X기 nominalizer vs noun ending in 기: 비치기→비치다 candidate;
  //     junk like 이야기→이야다 never survives validation.
  if (t2.endsWith('기') && hangulCount(t2) >= 3) {
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
  if ((t2.endsWith('은') || t2.endsWith('을')) && hangulCount(t2) >= 2) {
    push(t2.slice(0, -1) + '다');
  }
  if (t2.endsWith('는') && t2.length >= 2) {
    const st = t2.slice(0, -1);
    const dSt = decomposeSyllable(st[st.length - 1]);
    if (dSt && dSt[2] === 0) push(st + '다');
  }
  // (f) Copula peeling for nouns: 황새예요→황새, 학생입니다→학생,
  //     고양이야→고양이. All matches push (no break) — the shorter strips
  //     are junk that fails validation harmlessly.
  for (const cop of ['입니다', '이에요', '이었다', '예요', '였다', '이야', '야']) {
    if (t2.endsWith(cop) && hangulCount(t2.slice(0, -cop.length)) >= 1) {
      push(t2.slice(0, -cop.length));
    }
  }
  // (g) Fused-ㅆ past recovery, with an optional trailing 어/아 peeled first:
  //     갔다→가다, 봤어→보다, 됐다→되다, 먹었어→먹다. ㅐ is ambiguous
  //     (했→하다, 냈→내다) — offer both.
  {
    let base = t2.endsWith('다') ? t2.slice(0, -1) : t2;
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
    }
  }
  // (h) Fused-vowel connectives: an ㅏ/ㅓ/ㅐ/ㅘ/ㅝ-final open syllable is
  //     usually stem+아/어 fusion — offer stem+다 and the contraction-
  //     restored stem (만나서→만나다, 가요→가다, 봐요→보다, 해요→하다).
  {
    const u = t.endsWith('서') ? t.slice(0, -1) : t;
    const dU = u ? decomposeSyllable(u[u.length - 1]) : null;
    if (dU && dU[2] === 0 && [0, 1, 4, 9, 14].includes(dU[1]) && hangulCount(u) >= 1) {
      push(u + '다');
      const rest = { 9: 8, 14: 13, 1: 0 }[dU[1]];
      if (rest !== undefined) push(u.slice(0, -1) + composeSyllable(dU[0], rest, 0) + '다');
    }
  }
  return out;
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

function glmEntryTrust(key, entry) {
  if (!entry) return { headword: false, mapping: null };
  const lemma    = entry.cleanedLemma || '';
  const organic  = glmEntryIsOrganic(entry);
  const identity = globalLemmaKey(lemma) === key;
  return { headword: identity || organic, mapping: (organic || identity) ? lemma : null };
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
  const raw = String(surface || '').trim();
  if (!raw) return '';
  // Optional synchronous validation set: normalized headwords the user
  // already studies (lemmaMaster lemma + cleanedLemma values).
  const localHeadwords = opts.localHeadwords || null;

const variants = [raw, normalizeLemma(raw) || raw];
  // Bare contracted forms (더워, 몰라) often exist in the seed only in their
  // polite shape — include the +요 variant for corroboration.
  if (!raw.endsWith('요') && /[가-힣]$/.test(raw)) variants.push(raw + '요');
  const keys = [...new Set(variants.map(v => globalLemmaKey(v)))];
  let seedMapping = null;
  for (const k of keys) {
    const entry = await fetchGlmEntry(k);
    const trust = glmEntryTrust(k, entry);
    if (trust.mapping) return trust.mapping;
    // Remember an untrusted seed rewrite for corroboration below.
    if (!seedMapping && entry && entry.cleanedLemma) seedMapping = entry.cleanedLemma;
  }

  const candidates = extractLemmaCandidates(raw);
  const primary = candidates[0] || raw;

  // Local headword validation: free and synchronous — a candidate the user
  // already studies is accepted immediately (몰라요→모르다 when 모르다 is
  // in lemmaMaster).
  if (localHeadwords) {
    for (const c of candidates) {
      if (c && c !== raw && (localHeadwords.has(c) || localHeadwords.has(normalizeLemma(c)))) return c;
    }
  }

  // Dictionary validation outranks seed corroboration: the seed was
  // machine-generated with the same naive suffix assumptions as the
  // heuristic, so a validated headword candidate (이야기는→이야기) must
  // beat a seed row that merely agrees with a heuristic guess.
  const toCheck = candidates.filter(c => c && c !== raw).slice(0, 4);
  if (toCheck.length) {
    const entries = await Promise.all(toCheck.map(c => fetchGlmEntry(globalLemmaKey(c))));
    for (let i = 0; i < toCheck.length; i++) {
      const tr = glmEntryTrust(globalLemmaKey(toCheck[i]), entries[i]);
      if (tr.headword) return toCheck[i];
    }
  }

  // Seed corroboration, last resort: the bulk seed's mappings are
  // individually untrusted, but a seed mapping that exactly matches an
  // independently jamo-derived candidate is two independent signals —
  // hallucinated junk (까닥여→퇴창) can never coincide with a candidate we
  // generated. Reached only when nothing validated as a headword.
  if (seedMapping && seedMapping !== raw && candidates.includes(seedMapping)) return seedMapping;

  // Option B structural gate: allow an uncorroborated seed rewrite through
  // when it is structurally consistent with the surface. Ranked below both
  // headword validation and candidate corroboration; a user correction
  // (organic, trusted, checked first) permanently outranks it.
  if (seedMapping && seedMappingPlausible(raw, seedMapping)) return seedMapping;

  return primary || raw;
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
      if (existing.cleanedLemma === cleanedLemma) {
        await setDoc(ref, {
          cleanedLemma,
          contributorCount: (existing.contributorCount || 1) + 1,
          updatedAt: new Date().toISOString(),
        });
      } else if (!glmEntryIsOrganic(existing)) {
        // Seed-era rows with rewritten mappings include machine-generated
        // errors — a manual correction overrides them.
        await setDoc(ref, { cleanedLemma, contributorCount: 1, updatedAt: new Date().toISOString() });
      }
      // Organic conflicting entries keep first-writer-wins.
    } else {
      await setDoc(ref, { cleanedLemma, contributorCount: 1, updatedAt: new Date().toISOString() });
    }
  } catch {}
}

// ── Update flashcard fields by linkedAVILemmaId ───────────────
// Shared by Lemma Master and Word Input cascades. Falls back to normalized
// lemma text if no cards are found by ID (covers cards created with
// linkedAVILemmaId: null), and repairs linkedAVILemmaId on matched cards as
// a side-effect unless the caller's updates already set it.
// Accepts either a static `updates` object or a per-card `buildUpdates(card)`
// function — return null/undefined from buildUpdates to skip that card.
export async function updateLinkedCards({ lemmaID, lemmaText, updates, buildUpdates, cards, uid, updateCards }) {
  if ((!lemmaID && !lemmaText) || !cards || !uid) return;

  // Primary lookup by lemmaID
  let linked = lemmaID ? cards.filter(c => c.linkedAVILemmaId === lemmaID) : [];

  // Fallback: find non-grammar cards by normalized lemma text
  if (!linked.length && lemmaText) {
    const norm = normalizeLemma(lemmaText);
    linked = cards.filter(c =>
      c.type !== 'grammar' && c.lemma && normalizeLemma(c.lemma) === norm
    );
    if (!linked.length) {
      console.warn('updateLinkedCards: no cards found for lemmaID', lemmaID, '/ lemma', lemmaText);
      return;
    }
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

  const batch = writeBatch(db);
  pairs.forEach(([c, u]) => batch.update(doc(db, 'users', uid, 'flashcards', c.id), u));
  await batch.commit();

  const byId = new Map(pairs.map(([c, u]) => [c.id, u]));
  updateCards(prev => {
    if (!prev) return prev;
    return prev.map(c => byId.has(c.id) ? { ...c, ...byId.get(c.id) } : c);
  });
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
async function fetchKrDictEn(lemma) {
  if (!lemma) return '';
  try {
    const resp = await fetch('/api/get-krdict-api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lemma, lang: 'eng' }),
    });
    if (resp.ok) {
      const json   = await resp.json();
      const result = parseKrDictApiXml(json.xml || '', 'eng', lemma);
      if (result) return result;
    }
  } catch {}
  return 'Definition not found.';
}

// ── KRDict (Korean) via Netlify function ──────────────────────
async function fetchKrDictKo(lemma) {
  if (!lemma) return '';
  try {
    const resp = await fetch('/api/get-krdict-api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lemma, lang: 'kor' }),
    });
    if (resp.ok) {
      const json   = await resp.json();
      const result = parseKrDictApiXml(json.xml || '', 'kor', lemma);
      if (result) return result;
    }
  } catch {}
  return 'Definition not found.';
}

// ── KRDict bilingual ──────────────────────────────────────────
const BILINGUAL_SEPARATOR = '\n\n· · ·\n\n';

async function fetchKrDictBilingual(lemma) {
  const [en, ko] = await Promise.all([fetchKrDictEn(lemma), fetchKrDictKo(lemma)]);
  const parts = [en, ko].filter(d => d && d !== 'Definition not found.');
  return parts.length === 0 ? 'Definition not found.' : parts.join(BILINGUAL_SEPARATOR);
}

// ── Claude API via Netlify function ───────────────────────────
// No client-side API key needed — key is configured in Netlify env.
async function fetchClaudeDefinition(lemma, apiRateLimit = 5) {
  if (!lemma || lemma.length > 80) return '';
  if (!apiRateLimitOk(apiRateLimit)) return '__RATE_LIMITED__';
  try {
    const resp = await fetch('/api/get-definition', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lemma }),
    });
    if (!resp.ok) throw new Error('Function error: ' + resp.status);
    const json = await resp.json();
    return json.definition?.trim() || 'Definition not found.';
  } catch {
    return 'Definition not found.';
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
  const blocks = await Promise.all(terms.map(async (t) => {
    const def = await fetchOne(t);
    return def || 'Definition not found.';
  }));
  return blocks.join('\n\n-----\n\n');
}

// ── Shared lemma-relation mutation logic ──────────────────────
// Used by every place that creates/edits relatedForm/relatedMeaning/hiddenRelated
// pins on lemmaMaster entries: AVILemmaMasterPage's MiniSearchPopup, AVIMiniSearchPopup
// (Word Input), AVISearchPage, and AVISearchPage's ConnectListModal.

export const NUANCE_SOURCE_TITLE = '동의어/유의어';

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

// Keeps 동의어/유의어 membership consistent with each affected lemma's current
// relatedMeaning state: adds a capture if meaning is non-empty and none exists
// yet, removes the capture if meaning is now empty, and collapses duplicates
// down to one (covers the lemma-merge case, where both sides could have had
// their own capture before merging). Runs after every pin/connect action,
// regardless of relation type — checking final state rather than trying to
// detect "did meaning specifically change" is simpler and correct either way.
export function syncNuanceSource(wordInputs, lemmaMaster, affectedLemmaIDs) {
  const added = [];
  const removed = [];
  let next = wordInputs;

  affectedLemmaIDs.forEach(lemmaID => {
    const entry = lemmaMaster.find(l => l.lemmaID === lemmaID);
    if (!entry) return;
    const hasMeaning = (entry.relatedMeaning || '').split(',').map(s => s.trim()).filter(Boolean).length > 0;
    const norm = normalizeLemma(entry.lemma);
    const existing = next.filter(w => w.source === NUANCE_SOURCE_TITLE && normalizeLemma(w.lemma) === norm);

    if (hasMeaning && existing.length === 0) {
      const newRow = {
        uid: uuid(),
        ts: new Date().toISOString(),
        input: entry.lemma,
        source: NUANCE_SOURCE_TITLE,
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

function notifyNuanceSync(showAVIToast, added, removed) {
  if (!showAVIToast) return;
  if (added.length)   showAVIToast(`Added to 동의어/유의어: ${added.join(', ')}`, 'goToNuanceSource');
  if (removed.length) showAVIToast(`Removed from 동의어/유의어: ${removed.join(', ')}`, 'goToNuanceSource');
}

// Bidirectional pin/hide toggle between two lemmas (the per-row checkboxes).
// `type` is 'pinForm' | 'pinMeaning' | 'hide'. `showAVIToast` is optional —
// pass it to get feedback when this action adds/removes a 동의어/유의어 capture.
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
// Returns the sections belonging to a source (by title), sorted by trailing
// section number. Used anywhere that needs to know "does this source have
// sections, and which ones" — the topbar source selector, the Source tab,
// and the section-required gating on the input pages.
export function getSourceSections(aviSources, aviSections, sourceTitle) {
  const src = aviSources.find(s => s.title === sourceTitle);
  if (!src) return [];
  return aviSections
    .filter(s => s.resourceId === src.id)
    .sort((a, b) => {
      const na = parseInt((a.content || '').match(/(\d+)$/)?.[1]) || 0;
      const nb = parseInt((b.content || '').match(/(\d+)$/)?.[1]) || 0;
      return na - nb;
    });
}

// Builds a { 'YYYY-MM-DD': count } map of word/sentence mining activity —
// used by AVIOverviewPage's heatmap, and shared with anything else that
// wants the same day-by-day activity signal (e.g. a streak computation).
export function buildWordsByDay(wordInputs, sentenceInputs) {
  const map = {};
  for (const w of wordInputs || []) {
    const d = w.ts?.slice(0, 10);
    if (d) map[d] = (map[d] || 0) + 1;
  }
  for (const s of sentenceInputs || []) {
    const d = s.ts?.slice(0, 10);
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
