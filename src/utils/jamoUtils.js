// src/utils/jamoUtils.js
// [LANG-SPECIFIC] Korean jamo decomposition and typed-answer grading utilities.
// Converting to another language: replace this module wholesale (see docs/08).

// ── Jamo tables ───────────────────────────────────────────────
const INITIALS = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const MEDIALS  = ['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅗ','ㅘ','ㅙ','ㅚ','ㅛ','ㅜ','ㅝ','ㅞ','ㅟ','ㅠ','ㅡ','ㅢ','ㅣ'];
const FINALS   = ['','ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];

function decomposeChar(ch) {
  const code = ch.charCodeAt(0);
  if (code < 0xAC00 || code > 0xD7A3) return [ch];
  const offset = code - 0xAC00;
  const fin = offset % 28;
  const med = Math.floor(offset / 28) % 21;
  const ini = Math.floor(offset / 28 / 21);
  const out = [INITIALS[ini], MEDIALS[med]];
  if (fin !== 0) out.push(FINALS[fin]);
  return out;
}

export function toJamo(str) {
  return str.split('').flatMap(decomposeChar);
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = [];
  for (let i = 0; i <= m; i++) {
    dp[i] = new Array(n + 1).fill(0);
    dp[i][0] = i;
  }
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

// Returns normalized jamo edit distance [0, 1] between two Korean strings.
// Spaces are stripped before comparison.
export function jamoDistance(a, b) {
  const ja = toJamo((a || '').replace(/\s+/g, ''));
  const jb = toJamo((b || '').replace(/\s+/g, ''));
  if (ja.length === 0 && jb.length === 0) return 0;
  const dist = levenshtein(ja, jb);
  return dist / Math.max(ja.length, jb.length);
}

// ── Syllable helpers ──────────────────────────────────────────

export function isHangulSyllable(ch) {
  const code = ch.charCodeAt(0);
  return code >= 0xAC00 && code <= 0xD7A3;
}

export function syllableCount(str) {
  return (str || '').split('').filter(isHangulSyllable).length;
}

function getFirstSyllable(str) {
  for (const ch of (str || '')) {
    if (isHangulSyllable(ch)) return ch;
  }
  return '';
}

// ── Front detection ───────────────────────────────────────────

// Two-synonym slash: space(s) on both sides of '/'
export function isTwoSynonymFront(front) {
  return /\s+\/\s+/.test((front || '').trim());
}

// ── Front normalization for answer matching ───────────────────
// Returns:
//   canonical    — the primary cleaned string to match against
//   extraVariants — additional strings that also earn full credit
export function normalizeFrontForMatching(front) {
  let s = (front || '').trim();
  const extraVariants = [];

  // 1. Leading space-separated parenthetical: '(~에서) 우러나다'
  //    Strip the paren block; the paren form is ALSO valid
  const leadMatch = s.match(/^\(([^)]+)\)\s+([\s\S]+)$/);
  if (leadMatch) {
    extraVariants.push(s);               // full form with paren is valid
    s = leadMatch[2].trim();
  }

  // 2. (을) / (를) — strip the whole parenthetical
  s = s.replace(/\((을|를)\)/g, '');

  // 3. Other mid-word parens — strip parens, keep content
  //    e.g. 허용(하다) → 허용하다 | 지목(하다/되다) → 지목하다/되다
  s = s.replace(/\(([^)]+)\)/g, '$1');

  s = s.replace(/\s+/g, ' ').trim();

  return { canonical: s, extraVariants };
}

// For a canonical string with an embedded (non-space-separated) slash,
// expands into all valid answer forms.
// e.g. '지목하다/되다' → ['지목하다', '지목되다', '지목하다/되다']
export function expandSlashVariants(canonical) {
  if (!canonical.includes('/') || /\s+\/\s+/.test(canonical)) {
    return [canonical];
  }

  const slashIdx = canonical.indexOf('/');
  const left  = canonical.slice(0, slashIdx);  // e.g. '지목하다'
  const right = canonical.slice(slashIdx + 1); // e.g. '되다'

  // Build the right-side combined form: strip the last N syllables from left,
  // where N = syllableCount(right), then append right.
  const rightSyls = syllableCount(right);
  const leftSyls  = syllableCount(left);
  const stemSyls  = leftSyls - rightSyls;

  let stem = '';
  let seen = 0;
  for (const ch of left) {
    if (seen >= stemSyls) break;
    if (isHangulSyllable(ch)) seen++;
    stem += ch;
  }
  const rightForm = stem + right; // e.g. '지목되다'

  // Deduplicate in case left === rightForm
  return [...new Set([left, rightForm, canonical])];
}

// ── Credit computation ────────────────────────────────────────

const PARTIAL_THRESHOLD = 0.4; // max jamo distance for 0.5 credit

// Computes base credit (before hint penalties) for a typed voca answer.
// Returns 1.0, 0.5, or 0.0.
export function computeVocaBaseCredit(userAnswer, front) {
  if (!userAnswer || !front) return 0;
  const trimmed = userAnswer.trim();
  const normUser = trimmed.replace(/\s+/g, '');

  if (isTwoSynonymFront(front)) {
    return _scoreTwoSynonym(normUser, trimmed, front);
  }

  return _scoreSingle(normUser, front);
}

function _scoreSingle(normUser, front) {
  const { canonical, extraVariants } = normalizeFrontForMatching(front);
  const allVariants = [
    ...expandSlashVariants(canonical),
    ...extraVariants.flatMap(ev => expandSlashVariants(
      normalizeFrontForMatching(ev).canonical
    )),
    // Also accept the raw front with parens if user typed it exactly
    front.replace(/\s+/g, ''),
  ];

  for (const v of allVariants) {
    if (normUser === v.replace(/\s+/g, '')) return 1.0;
  }

  const bestDist = Math.min(...allVariants.map(v => jamoDistance(normUser, v.replace(/\s+/g, ''))));
  return bestDist <= PARTIAL_THRESHOLD ? 0.5 : 0.0;
}

function _scoreTwoSynonym(normUser, trimmedUser, front) {
  // Split the two halves
  const halves = front.split(/\s+\/\s+/);
  const [rawA, rawB] = halves;

  const { canonical: canonA } = normalizeFrontForMatching(rawA.trim());
  const { canonical: canonB } = normalizeFrontForMatching(rawB.trim());
  const variantsA = expandSlashVariants(canonA).map(v => v.replace(/\s+/g, ''));
  const variantsB = expandSlashVariants(canonB).map(v => v.replace(/\s+/g, ''));

  // User can separate with / or ,
  const userParts = trimmedUser.split(/\s*[/,]\s*/).map(p => p.trim().replace(/\s+/g, '')).filter(Boolean);

  const scoreHalf = (targetVariants) => {
    let best = 0;
    for (const up of userParts) {
      for (const tv of targetVariants) {
        if (up === tv) { best = 0.5; break; }
        const dist = jamoDistance(up, tv);
        if (dist <= PARTIAL_THRESHOLD) best = Math.max(best, 0.25);
      }
      if (best >= 0.5) break;
    }
    return best;
  };

  return scoreHalf(variantsA) + scoreHalf(variantsB); // 0.0 to 1.0
}

// Computes base credit for a cloze typed answer (no hints).
// Returns 1.0, 0.5, or 0.0.
export function computeClozeCredit(userAnswer, inputForm) {
  if (!userAnswer || !inputForm) return 0;
  const normUser = userAnswer.trim().replace(/\s+/g, '');
  const normTarget = inputForm.trim().replace(/\s+/g, '');
  if (normUser === normTarget) return 1.0;
  const dist = jamoDistance(normUser, normTarget);
  return dist <= PARTIAL_THRESHOLD ? 0.5 : 0.0;
}

// Applies hint penalties to a base credit score, floored at 0.
// hintsRevealed: 0, 1, or 2
export function applyHintPenalty(baseCredit, hintsRevealed) {
  const penalty = hintsRevealed >= 2 ? 0.3 : hintsRevealed === 1 ? 0.1 : 0;
  return Math.max(0, baseCredit - penalty);
}

// Computes partial credit based on whether the user's answer exactly matches
// a lemma from the answer's relatedForm or relatedMeaning sets.
// Returns 0.5 (matches both sets), 0.3 (matches one set), or 0.0 (matches neither).
// Comparison is normalized: trimmed with internal spaces removed.
export function computeRelatedCredit(userAnswer, relatedFormLemmas, relatedMeaningLemmas) {
  if (!userAnswer) return 0;
  const norm = s => (s || '').trim().replace(/\s+/g, '');
  const normUser = norm(userAnswer);
  if (!normUser) return 0;
  const inForm    = (relatedFormLemmas    || []).some(l => norm(l) === normUser);
  const inMeaning = (relatedMeaningLemmas || []).some(l => norm(l) === normUser);
  if (inForm && inMeaning) return 0.5;
  if (inForm || inMeaning) return 0.3;
  return 0.0;
}

// ── Cloze token boundary search ───────────────────────────────
// Returns the character index of the first occurrence of inputForm in sentence
// that sits at a Korean eojeol boundary (space-delimited), or -1 if none.
//
// "Before" boundary: start of string, space, opening punctuation, em/en dash, tilde.
// "After"  boundary: end of string, space, closing/sentence punctuation, em/en dash, tilde.
export function findClozeTokenIndex(sentence, inputForm) {
  if (!sentence || !inputForm) return -1;
  const BEFORE_OK = new Set([
    ' ', '"', "'", '(', '「', '『', '[', '{', '—', '–', '~', '～',
  ]);
  const AFTER_OK = new Set([
    ' ', '.', ',', '!', '?', '…', '。', '！', '？', '⋯', '、',
    '"', "'", ')', '」', '』', ']', '}', '—', '–', '~', '～',
  ]);
  let searchFrom = 0;
  while (searchFrom <= sentence.length - inputForm.length) {
    const idx = sentence.indexOf(inputForm, searchFrom);
    if (idx === -1) return -1;
    const charBefore = idx === 0 ? null : sentence[idx - 1];
    const charAfter  = idx + inputForm.length >= sentence.length
      ? null
      : sentence[idx + inputForm.length];
    const beforeOk = charBefore === null || BEFORE_OK.has(charBefore);
    const afterOk  = charAfter  === null || AFTER_OK.has(charAfter);
    if (beforeOk && afterOk) return idx;
    searchFrom = idx + 1;
  }
  return -1;
}

// ── Hint generation ───────────────────────────────────────────
// Returns { hint1: string, hint2: string|null, monosyllabic: bool }
//
// Monosyllabic words:  hint1 = '_'  |  hint2 = null
// Multi-syllable:      hint1 = first syllable only (e.g. '닿')
//                      hint2 = first syllable + '_' per remaining syllable (e.g. '닿_')
// Multi-word fronts:   per-word hints joined with an em-space (\u2003) for visibility
// Two-synonym fronts:  per-half hints joined with '   /   '
// Slash variants:      hint shows first syllable of left side + slash structure
export function getVocaHints(front) {
  if (!front) return { hint1: '_', hint2: null, monosyllabic: true };

  if (isTwoSynonymFront(front)) {
    const { canonical } = normalizeFrontForMatching(front);
    const halves = canonical.split(/\s+\/\s+/);
    const h1Parts = halves.map(h => _hint1ForWord(h.trim()));
    const h2Parts = halves.map(h => _hint2ForWord(h.trim()));
    const anyMulti = halves.some(h => syllableCount(h) > 1);
    return {
      hint1: h1Parts.join('\u2003/\u2003'),
      hint2: anyMulti ? h2Parts.join('\u2003/\u2003') : null,
      monosyllabic: !anyMulti,
    };
  }

  const { canonical } = normalizeFrontForMatching(front);
  // Split by spaces (words), preserve slash structure within each word
  const words = canonical.split(' ').filter(Boolean);
  if (words.length === 0) return { hint1: '_', hint2: null, monosyllabic: true };

  const anyMulti = words.some(w => syllableCount(w) > 1);
  const h1Parts  = words.map(w => _hint1ForWord(w));
  const h2Parts  = words.map(w => _hint2ForWord(w));

  return {
    hint1: h1Parts.join('\u2003'),       // em-space between words
    hint2: anyMulti ? h2Parts.join('\u2003') : null,
    monosyllabic: !anyMulti,
  };
}

// hint1 for a single word token (may contain embedded slash like 하다/되다)
function _hint1ForWord(word) {
  if (!word) return '_';
  // Embedded slash (no spaces): use left side's structure
  if (word.includes('/') && !/\s/.test(word)) {
    const parts = word.split('/');
    const leftFirst = getFirstSyllable(parts[0]);
    const rightFirst = getFirstSyllable(parts[1]);
    // hint1: first syllable of left part (the slash is structural, not shown in hint1)
    return leftFirst || '_';
  }
  const syls = syllableCount(word);
  if (syls <= 1) return '_';
  return getFirstSyllable(word) || '_';
}

// hint2 for a single word token
function _hint2ForWord(word) {
  if (!word) return '_';
  if (word.includes('/') && !/\s/.test(word)) {
    const parts = word.split('/');
    const leftH2  = _hint2Simple(parts[0]);
    const rightH2 = '_'.repeat(Math.max(1, syllableCount(parts[1])));
    return `${leftH2}/${rightH2}`;
  }
  return _hint2Simple(word);
}

// first syllable + underscore per remaining syllable
function _hint2Simple(word) {
  const syls = syllableCount(word);
  if (syls <= 1) return getFirstSyllable(word) || '_';
  return (getFirstSyllable(word) || '') + '_'.repeat(syls - 1);
}

// ── Score formatting ──────────────────────────────────────────
// Formats a score (potentially float) to at most 1 decimal place.
// e.g. 70.0 → "70", 70.5 → "70.5"
export function formatScore(score) {
  if (score == null) return '0';
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}
