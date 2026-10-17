// src/utils/echoEngine.js
// Pure Echo Quiz logic (Stage E1; decisions E-D2–E-D20 of the
// Echo Quiz design). Echo is the digital fold-over drill:
// each round has a prompt column and an answer column, and the corrected
// answer column (in canonical form) becomes the next round's prompts.
//
//   - items: one per Lemma Master entry (Korean = lemma, English = def2, or
//     the first short gloss of def1 when there is no def2)
//   - grading: correct / near-miss / incorrect for both directions, two-part
//     lemmas ("A / B"), relatedMeaning synonyms (correct), relatedForm
//     variants (near-miss), saved alternates (hook, E-D18)
//   - collisions: items whose English overlaps; at most one pair per session,
//     graded as a group; "(not X)" hints for overlaps outside the session
//   - rounds: direction flip, full or shrinking list, fixed rounds or
//     completionist with the 10-round cap, first-try records
//   - resume check and the session summary saved to echo_sessions
//
// Only import: jamoUtils.js (itself import-free). No Firebase, no React, no
// page imports — runs in plain Node, so a test harness can drive it. Session state
// is plain JSON so it can be saved for resume as is. Nothing here reads the
// clock or Math.random unless the caller lets it (timestamps and `rand` are
// parameters).

import {
  normalizeFrontForMatching, expandSlashVariants, jamoDistance, isTwoSynonymFront,
} from './jamoUtils.js';
import { spokenParts } from './spokenText.js';

export const ECHO_VERSION      = 1;
export const ECHO_CAP          = 10;   // completionist safety cap, rounds (E-D6)
export const ECHO_PLAYS_MAX    = 5;    // Dictation plays per focus or tap
export const RESUME_MAX_DAYS   = 14;   // same expiry as the grammar quiz resume
export const KO_NEAR_THRESHOLD = 0.4;  // jamoDistance; same as the typed quizzes
export const HINT_MAX_NAMES    = 2;

export const DIRS = { EN2KO: 'en2ko', KO2EN: 'ko2en', EAR: 'ear' };   // ear = Dictation (X4)
export const otherDir = (dir) => (dir === DIRS.EN2KO ? DIRS.KO2EN : DIRS.EN2KO);

export const ECHO_DEFAULTS = {
  size:       10,
  mode:       'rounds',     // 'rounds' | 'complete'
  rounds:     4,
  startDir:   DIRS.EN2KO,
  shrinking:  false,
  shuffle:    true,
  kind:       'echo',       // 'echo' (two-way) | 'dictation' (hear the word, type it; X-D10)
  koPrompt:   'text',       // Echo Korean→Meaning prompts: 'text' | 'audio' (X-D9)
  plays:      2,            // Dictation: times the word plays per focus or tap (1–5)
};

// ─────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────

const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/;
const LATIN  = /[a-z]/i;

const nfc = (s) => String(s ?? '').normalize('NFC');
const uniq = (arr) => [...new Set(arr)];

// Fisher–Yates on a copy; `rand` injectable for tests.
export function shuffled(arr, rand = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Splits on any of `seps` characters, but never inside (...) or [...].
function splitTopLevel(s, seps) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    else if ((ch === ')' || ch === ']') && depth > 0) depth--;
    if (depth === 0 && seps.includes(ch)) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────
// Korean side
// ─────────────────────────────────────────────────────────────
// [LANG-SPECIFIC] Target-language answer grading: normalization, two-part
// lemmas and spelling variants through jamoUtils.js (docs/08).

// Answer-side Korean normalization: NFC, no spaces, no trailing punctuation.
export function normKo(s) {
  return nfc(s).trim().replace(/[.,!?~…。、]+$/u, '').replace(/\s+/g, '');
}

// All accepted spellings of one Korean half, via the same jamoUtils rules the
// Vocabulary Quiz uses ((을)/(를), leading parentheticals, 하다/되다 slashes).
function koHalfVariants(raw) {
  const half = nfc(raw).trim();
  if (!half) return [];
  const { canonical, extraVariants } = normalizeFrontForMatching(half);
  const v = [
    ...expandSlashVariants(canonical),
    ...extraVariants.flatMap(ev => expandSlashVariants(normalizeFrontForMatching(ev).canonical)),
    half,
    half.replace(/[()]/g, ''),   // (주먹을) 날리다 → 주먹을 날리다
  ];
  return uniq(v.map(normKo).filter(Boolean));
}

// A lemma's Korean answer parts: one part normally, two for "A / B" lemmas.
export function koParts(lemma) {
  const s = nfc(lemma).trim();
  if (isTwoSynonymFront(s)) {
    const halves = s.split(/\s+\/\s+/);
    if (halves.length === 2) return halves.map(koHalfVariants);
  }
  return [koHalfVariants(s)];
}

// ─────────────────────────────────────────────────────────────
// English side
// ─────────────────────────────────────────────────────────────

// [LANG-SPECIFIC] Definition-language (English) normalization: leading
// to/a/the/be and filler words. Adapt if your definitions aren't in English (docs/08).
const FILLER = new Set(['someone', 'something', 'somebody', 'sb', 'sth', "one's", 'oneself', 'etc']);
const LEADING = /^(?:(?:to|a|an|the|be)\s+)+/;

// Answer-side English normalization. Used for both typed answers and keys.
export function normEn(s) {
  let t = nfc(s).toLowerCase()
    .replace(/[‘’]/g, "'").replace(/[“”"]/g, ' ')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[가-힣ᄀ-ᇿ㄰-㆏]+/g, ' ')
    .replace(/-/g, ' ')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  t = t.replace(LEADING, '');
  t = t.split(' ').filter(w => w && !FILLER.has(w)).join(' ');
  return t.replace(LEADING, '').trim();
}

// Optional pieces inside one gloss:
//   work(ing) → "working", "work"      (attached parenthetical = optional suffix)
//   switch (over) → "switch over", "switch"   (spaced Latin parenthetical = optional)
//   [transition] → an extra alternative     (bracketed Latin text)
//   (국물 등이), [명사] → dropped            (Hangul notes / POS tags)
//   possibility/potential for development → one variant per slash option
const VARIANT_CAP = 16;
function glossVariants(gloss) {
  let forms = [gloss];
  const extras = [];
  gloss.replace(/\[([^\]]*)\]/g, (m, inner) => {
    if (LATIN.test(inner) && !HANGUL.test(inner)) extras.push(inner);
    return m;
  });
  const parenRe = /(\S?)\(([^)]*)\)/;
  for (let guard = 0; guard < 6; guard++) {
    const next = [];
    let changed = false;
    for (const f of forms) {
      const m = f.match(parenRe);
      if (!m) { next.push(f); continue; }
      changed = true;
      const [whole, before, inner] = m;
      const at = m.index;
      const head = f.slice(0, at), tail = f.slice(at + whole.length);
      if (HANGUL.test(inner) || !LATIN.test(inner)) {
        next.push(head + before + ' ' + tail);
      } else if (before && /\S/.test(before)) {
        next.push(head + before + inner + tail, head + before + tail);   // attached: work(ing)
      } else {
        next.push(head + before + inner + ' ' + tail, head + before + ' ' + tail); // spaced: (over)
      }
    }
    forms = uniq(next).slice(0, VARIANT_CAP);
    if (!changed) break;
  }
  // slash tokens: look/watch → look | watch (cartesian, capped)
  const slashed = [];
  for (const f of forms) {
    let acc = [''];
    for (const tok of f.split(/\s+/)) {
      const opts = /\S\/\S/.test(tok) ? tok.split('/').filter(Boolean) : [tok];
      acc = acc.flatMap(a => opts.map(o => (a ? a + ' ' : '') + o)).slice(0, VARIANT_CAP);
    }
    slashed.push(...acc);
  }
  return uniq([...slashed, ...extras].map(normEn).filter(k => k.length >= 2)).slice(0, VARIANT_CAP);
}

// def2 → senses. Numbered senses ("1.", "2.(눈빛이)", "1.[명사]") and line
// breaks separate senses; ";", "," and a spaced " / " separate glosses inside
// a sense (never inside brackets). Each sense keeps its display text.
export function splitSenses(text) {
  const src = nfc(text).replace(/\r\n?/g, '\n').trim();
  if (!src) return [];
  const chunks = src
    .split(/(?:^|\n|\s)\d{1,2}\.(?!\d)\s*/)
    .flatMap(c => c.split(/\n+/))
    .map(c => c.trim())
    .filter(Boolean);
  const senses = [];
  for (const chunk of chunks) {
    const glosses = splitTopLevel(chunk.replace(/\s\/\s/g, ';'), [';', ',']);
    const keys = uniq(glosses.flatMap(glossVariants));
    if (keys.length) senses.push({ display: chunk, keys });
  }
  return senses;
}

// def1 fallback (E-D20): the first sense's short gloss — the part before the
// first ": " of the first numbered line. KRDict placeholders, rate-limit
// markers, [headword · pos] blocks and Korean-only text are unusable (null).
export function def1ShortGloss(def1) {
  const src = nfc(def1).replace(/\r\n?/g, '\n').split(/\n\s*·\s·\s·\s*\n/)[0].trim();
  if (!src || /^definition not found\.?$/i.test(src) || src.startsWith('__')) return null;
  const line = src.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('['));
  if (!line) return null;
  let g = line.replace(/^\d{1,2}\.\s*/, '');
  const colon = g.indexOf(': ');
  if (colon > 0) g = g.slice(0, colon);
  g = g.trim();
  if (!g || !LATIN.test(g) || /^definition not found/i.test(g)) return null;
  return g.length > 80 ? g.slice(0, 79).trim() + '…' : g;
}

// English answer parts: two halves when a two-part lemma's def2 has exactly
// two blocks separated by a line holding only "/"; otherwise one.
function enHalves(def2, isTwoPartKo) {
  if (isTwoPartKo) {
    const blocks = nfc(def2).replace(/\r\n?/g, '\n').split(/\n\s*\/\s*\n/);
    if (blocks.length === 2) {
      const halves = blocks.map(b => uniq(splitSenses(b).flatMap(s => s.keys)));
      if (halves.every(h => h.length)) return halves;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Items
// ─────────────────────────────────────────────────────────────

const parseIds = (str) => String(str || '').split(',').map(s => s.trim()).filter(Boolean);

// lemmaID → entry, built once per session setup.
export function indexLemmaMaster(entries) {
  const byId = new Map();
  for (const e of entries || []) if (e?.lemmaID) byId.set(e.lemmaID, e);
  return byId;
}

// One Lemma Master entry → Echo item, or null when it has no usable English
// side (E-D20) or no lemma.
export function buildItem(entry, byId = new Map()) {
  if (!entry?.lemmaID || !nfc(entry.lemma).trim()) return null;
  const def2 = nfc(entry.def2).trim();
  const short = def2 ? null : def1ShortGloss(entry.def1);
  const en = def2 || short;
  if (!en) return null;
  const senses = splitSenses(en);
  const enKeys = uniq(senses.flatMap(s => s.keys));
  if (!enKeys.length) return null;

  const ko = nfc(entry.lemma).trim();
  const parts = koParts(ko);
  const synonymIds = parseIds(entry.relatedMeaning).filter(id => id !== entry.lemmaID);
  const formIds    = parseIds(entry.relatedForm).filter(id => id !== entry.lemmaID);
  const lemmaOf = (id) => byId.get(id)?.lemma || null;
  const alternates = Array.isArray(entry.echoAlternates) ? entry.echoAlternates.filter(a => typeof a === 'string' && a.trim()) : [];

  return {
    id:          entry.lemmaID,
    ko,
    en,
    enSource:    def2 ? 'def2' : 'def1',
    koKey:       parts.map(p => p[0] || '').join('/'),
    koParts:     parts,
    enKeys,
    enHalves:    enHalves(en, parts.length === 2),
    synonymIds,
    synonyms:    synonymIds.map(id => ({ id, variants: koParts(lemmaOf(id) || '').flat() })).filter(s => s.variants.length),
    // near-miss forms: relatedForm lemmas, plus the lemma with its optional
    // parenthetical dropped (입사(하다) → 입사)
    forms:       uniq([
      ...formIds.map(lemmaOf).filter(Boolean).flatMap(l => koParts(l).flat()),
      ...(parts.length === 1 && /\(/.test(ko) ? [normKo(ko.replace(/\([^)]*\)/g, ''))] : []),
    ]).filter(f => f && !parts[0].includes(f)),
    alternates:  { ko: uniq(alternates.filter(a => HANGUL.test(a)).map(normKo)), en: uniq(alternates.filter(a => !HANGUL.test(a)).map(normEn).filter(Boolean)) },
  };
}

// ─────────────────────────────────────────────────────────────
// Grading
// ─────────────────────────────────────────────────────────────
// A graded answer: { verdict, via, matched }
//   verdict: 'correct' | 'near' | 'incorrect' | 'blank'
//   via:     'exact' | 'synonym' | 'alternate' | 'typo' | 'form' | 'partial' | null
// 'near' always needs the learner's accept/reject (E-D7).

const result = (verdict, via = null, matched = null) => ({ verdict, via, matched });

function bestKoMatch(ans, variants) {
  let best = Infinity, hit = null;
  for (const v of variants) {
    if (ans === v) return { dist: 0, hit: v };
    const d = jamoDistance(ans, v);
    if (d < best) { best = d; hit = v; }
  }
  return { dist: best, hit };
}

// opts.excludeIds: synonym ids not to accept (pair grading).
export function gradeKo(item, answer, opts = {}) {
  const ans = normKo(answer);
  if (!ans) return result('blank');
  const exclude = new Set(opts.excludeIds || []);

  if (item.koParts.length === 2) {
    const user = nfc(answer).split(/[/,，]/).map(normKo).filter(Boolean);
    const scoreHalf = (variants, u) => {
      const { dist } = bestKoMatch(u, variants);
      return dist === 0 ? 2 : dist <= KO_NEAR_THRESHOLD ? 1 : 0;
    };
    let best = [0, 0];
    if (user.length >= 2) {
      const [a, b] = item.koParts;
      for (const [x, y] of [[user[0], user[1]], [user[1], user[0]]]) {
        const s = [scoreHalf(a, x), scoreHalf(b, y)];
        if (s[0] + s[1] > best[0] + best[1]) best = s;
      }
    }
    if (best[0] === 2 && best[1] === 2) return result('correct', 'exact', item.ko);
    if (best[0] >= 1 && best[1] >= 1) return result('near', 'typo', item.ko);
    // fall through: a synonym or alternate can still match the whole answer
  } else {
    const own = bestKoMatch(ans, item.koParts[0]);
    if (own.dist === 0) return result('correct', 'exact', item.ko);
  }

  for (const syn of item.synonyms) {
    if (exclude.has(syn.id)) continue;
    if (syn.variants.includes(ans)) return result('correct', 'synonym', syn.variants[0]);
  }
  if (item.alternates.ko.includes(ans)) return result('correct', 'alternate', ans);
  if (item.koParts.length === 1) {
    if (item.forms.includes(ans)) return result('near', 'form', ans);
    const own = bestKoMatch(ans, item.koParts[0]);
    if (own.dist <= KO_NEAR_THRESHOLD) return result('near', 'typo', item.ko);
  }
  return result('incorrect');
}

const enNearLimit = (len) => (len < 4 ? 0 : len <= 7 ? 1 : len <= 12 ? 2 : 3);

function enNear(part, key) {
  const lim = enNearLimit(key.length);
  if (lim && levenshtein(part, key) <= lim) return 'typo';
  const pw = part.split(' '), kw = key.split(' ');
  if (pw.length !== kw.length) {
    const [small, big] = pw.length < kw.length ? [pw, kw] : [kw, pw];
    if (small.every(w => big.includes(w)) && small.some(w => w.length > 2)) return 'partial';
  }
  return null;
}

function matchEnKeys(parts, keys) {
  for (const p of parts) if (keys.includes(p)) return { verdict: 'correct', via: 'exact', matched: p };
  for (const p of parts) for (const k of keys) {
    const how = enNear(p, k);
    if (how) return { verdict: 'near', via: how, matched: k };
  }
  return null;
}

export function gradeEn(item, answer) {
  const raw = nfc(answer).trim();
  if (!raw) return result('blank');
  const parts = uniq([normEn(raw), ...splitTopLevel(raw, [',', ';', '/']).map(normEn)]).filter(Boolean);
  if (!parts.length) return result('incorrect');

  // Two-part item: both halves required (E-D7), each answered by a different
  // piece of the answer, separated by "/", "," or ";".
  if (item.enHalves) {
    const subs = uniq(splitTopLevel(raw, [',', ';', '/']).map(normEn).filter(Boolean));
    const hits = (keys) => subs.map((p, i) => ({ i, r: matchEnKeys([p], keys) })).filter(x => x.r);
    const h0 = hits(item.enHalves[0]), h1 = hits(item.enHalves[1]);
    let best = 0;
    for (const x of h0) for (const y of h1) {
      if (x.i === y.i) continue;
      best = Math.max(best, x.r.verdict === 'correct' && y.r.verdict === 'correct' ? 2 : 1);
    }
    if (best === 2) return result('correct', 'exact', item.en);
    if (parts.some(p => item.alternates.en.includes(p))) return result('correct', 'alternate', raw);
    if (best === 1) return result('near', 'typo', item.en);
    return result('incorrect');
  }

  const m = matchEnKeys(parts, item.enKeys);
  if (m?.verdict === 'correct') return result('correct', 'exact', m.matched);
  if (parts.some(p => item.alternates.en.includes(p))) return result('correct', 'alternate', raw);
  if (m) return result('near', m.via, m.matched);
  return result('incorrect');
}

// Dictation (X4, X-D14): the answer is the word heard, so only its spoken
// forms count (no synonyms, related forms or saved alternates); spacing is
// ignored. A one-sound slip is a miss ('incorrect', via 'close'), which the
// learner can still override. Two-part lemmas ("A / B") need both words, in
// either order; slash alternatives ("지목하다/되다") accept either word.
function earAccepted(text) {
  const raw = nfc(text).trim();
  return uniq([...spokenParts(raw), raw.replace(/[()]/g, '')].map(normKo).filter(Boolean));
}
export function gradeEar(item, answer) {
  const ans = normKo(answer);
  if (!ans) return result('blank');
  const pieces = nfc(answer).split(/[/,，、]/).map(normKo).filter(Boolean);
  const halves = item.koParts.length === 2 ? nfc(item.ko).split(/\s+\/\s+/) : null;

  if (halves && halves.length === 2) {
    const [A, B] = halves.map(earAccepted);
    const both = (x, y) => (A.includes(x) && B.includes(y)) || (A.includes(y) && B.includes(x));
    if (pieces.length === 2 && both(pieces[0], pieces[1])) return result('correct', 'exact', item.ko);
    if (A.some(a => B.some(b => ans === a + b || ans === b + a))) return result('correct', 'exact', item.ko);
    const near = (list, u) => bestKoMatch(u, list).dist <= KO_NEAR_THRESHOLD;
    const closeSplit = pieces.length === 2 && ((near(A, pieces[0]) && near(B, pieces[1])) || (near(A, pieces[1]) && near(B, pieces[0])));
    const closeJoined = A.some(a => B.some(b => bestKoMatch(ans, [a + b, b + a]).dist <= KO_NEAR_THRESHOLD));
    return closeSplit || closeJoined ? result('incorrect', 'close') : result('incorrect');
  }

  const ok = earAccepted(item.ko);
  if (pieces.length && pieces.every(u => ok.includes(u))) return result('correct', 'exact', item.ko);
  if (ok.includes(ans)) return result('correct', 'exact', item.ko);
  return bestKoMatch(ans, ok).dist <= KO_NEAR_THRESHOLD ? result('incorrect', 'close') : result('incorrect');
}

// Answer in the given direction: en2ko answers are Korean, ko2en English,
// ear (Dictation) Korean by ear.
export function gradeAnswer(item, dir, answer, opts) {
  if (dir === DIRS.EAR) return gradeEar(item, answer);
  return dir === DIRS.EN2KO ? gradeKo(item, answer, opts) : gradeEn(item, answer);
}

// Correction step (E-D9): the retyped answer must be the Lemma Master answer
// itself (any of its spellings / any def2 sense) — not a synonym or alternate.
export function checkCorrection(item, dir, text) {
  const g = gradeAnswer(item, dir, text);
  return g.verdict === 'correct' && g.via === 'exact';
}

// ─────────────────────────────────────────────────────────────
// Collisions, selection, hints (E-D10)
// ─────────────────────────────────────────────────────────────

// Two items collide when their English overlaps (a shared gloss key) or one
// lists the other as a relatedMeaning synonym — either way one Korean answer
// could fit the other's English prompt.
export function collides(a, b) {
  if (!a || !b || a.id === b.id) return false;
  if (a.synonymIds.includes(b.id) || b.synonymIds.includes(a.id)) return true;
  const keys = new Set(a.enKeys);
  return b.enKeys.some(k => keys.has(k));
}

// Greedy pick in priority order: dedupes by id and Korean, allows at most one
// colliding pair in the whole session, skips anything else that collides.
// Returns { items, pair: [idA, idB] | null, skipped: [{ id, reason }] }.
export function selectItems(candidates, size, opts = {}) {
  const items = [];
  const skipped = [];
  const seenIds = new Set(), seenKo = new Set();
  let pair = opts.pair ? [...opts.pair] : null;
  for (const it of candidates || []) {
    if (!it) continue;
    if (items.length >= size) break;
    if (seenIds.has(it.id) || seenKo.has(it.koKey)) { skipped.push({ id: it.id, reason: 'duplicate' }); continue; }
    const hits = items.filter(s => collides(s, it));
    if (hits.length === 0) {
      items.push(it);
    } else if (hits.length === 1 && !pair) {
      pair = [hits[0].id, it.id];
      items.push(it);
    } else {
      skipped.push({ id: it.id, reason: 'collision' }); continue;
    }
    seenIds.add(it.id); seenKo.add(it.koKey);
  }
  return { items, pair, skipped };
}

// Whether one more item can join an existing selection (hybrid add/swap).
export function canAdd(item, selected, pair) {
  if (selected.some(s => s.id === item.id || s.koKey === item.koKey)) return false;
  const hits = selected.filter(s => collides(s, item));
  return hits.length === 0 || (hits.length === 1 && !pair);
}

// "(not X, Y)" hints for EN→KO prompts: other Lemma Master items sharing an
// English key with this one but NOT in the session and not its accepted
// synonyms. Names already written in the def2 itself are skipped.
// Returns { [itemId]: '(not X)' }.
export function computeHints(sessionItems, allItems) {
  const inSession = new Set(sessionItems.map(i => i.id));
  const byKey = new Map();
  for (const it of allItems || []) {
    if (!it) continue;
    for (const k of it.enKeys) {
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(it);
    }
  }
  const hints = {};
  for (const it of sessionItems) {
    const names = [];
    const seen = new Set([it.id]);
    for (const k of it.enKeys) {
      for (const other of byKey.get(k) || []) {
        if (seen.has(other.id)) continue;
        seen.add(other.id);
        if (inSession.has(other.id) || it.synonymIds.includes(other.id) || other.synonymIds.includes(it.id)) continue;
        if (other.koKey === it.koKey) continue;
        if (it.en.includes(other.ko)) continue;
        names.push(other.ko);
      }
    }
    if (names.length) hints[it.id] = `(not ${names.slice(0, HINT_MAX_NAMES).join(', ')})`;
  }
  return hints;
}

// ─────────────────────────────────────────────────────────────
// Session state
// ─────────────────────────────────────────────────────────────
// {
//   v, startedAt, config, items, pair, hints,
//   round, dir, order: [ids],
//   progress: { [id]: { en2ko, ko2en, first: { en2ko, ko2en }, misses, overrides, nearAccepted, hintsUsed } },
//   rounds: [{ round, dir, rows: [{ id, answer, verdict, via, accepted, overridden, nearAccepted }] }],
//   done, endReason: null | 'rounds' | 'complete' | 'cap' | 'ended'
// }

function normConfig(c = {}) {
  const cfg = { ...ECHO_DEFAULTS, ...c };
  cfg.kind = cfg.kind === 'dictation' ? 'dictation' : 'echo';
  cfg.koPrompt = cfg.koPrompt === 'audio' ? 'audio' : 'text';
  cfg.plays = Math.min(ECHO_PLAYS_MAX, Math.max(1, Math.floor(Number(cfg.plays) || ECHO_DEFAULTS.plays)));
  cfg.mode = cfg.mode === 'complete' ? 'complete' : 'rounds';
  cfg.rounds = Math.max(1, Math.floor(Number(cfg.rounds) || ECHO_DEFAULTS.rounds));
  cfg.startDir = cfg.startDir === DIRS.KO2EN ? DIRS.KO2EN : DIRS.EN2KO;
  cfg.shrinking = !!cfg.shrinking;
  cfg.shuffle = !!cfg.shuffle;
  cfg.size = Math.max(1, Math.floor(Number(cfg.size) || ECHO_DEFAULTS.size));
  return cfg;
}

const emptyProgress = () => ({
  en2ko: false, ko2en: false, ear: false, first: { en2ko: null, ko2en: null, ear: null },
  misses: 0, overrides: 0, nearAccepted: 0, hintsUsed: 0,
});
const isDictation = (state) => state?.config?.kind === 'dictation';

// items: from selectItems; hints: from computeHints. Returns null for no items.
export function createSession({ items, pair = null, hints = {}, config, startedAt = null, rand = Math.random }) {
  if (!items?.length) return null;
  const cfg = normConfig(config);
  const ids = items.map(i => i.id);
  const progress = {};
  for (const id of ids) progress[id] = emptyProgress();
  return {
    v: ECHO_VERSION,
    startedAt,
    config: cfg,
    items,
    pair: cfg.kind === 'echo' && pair && pair.every(id => ids.includes(id)) ? pair : null,
    hints: hints || {},
    round: 1,
    dir: cfg.kind === 'dictation' ? DIRS.EAR : cfg.startDir,
    order: cfg.shuffle ? shuffled(ids, rand) : ids,
    progress,
    rounds: [],
    done: false,
    endReason: null,
  };
}

const itemMap = (state) => new Map(state.items.map(i => [i.id, i]));

// What the UI draws for the current round. Prompt kind 'en' | 'ko' (audio
// later, E-D16). Hints only on English prompts.
export function currentRows(state) {
  if (!state || state.done) return [];
  const map = itemMap(state);
  return state.order.map(id => {
    const it = map.get(id);
    if (state.dir === DIRS.EAR) {
      // Dictation: hear the word (audio), type it; the meaning is the hint.
      return {
        id,
        prompt:     { kind: 'ko', text: it.ko, audio: true, reveal: it.en },
        answerKind: 'ko',
        hint:       null,
        pairId:     null,
        twoPart:    it.koParts.length === 2,
      };
    }
    const en2ko = state.dir === DIRS.EN2KO;
    const audio = !en2ko && state.config.koPrompt === 'audio';   // X-D9: the Korean word only
    return {
      id,
      prompt:     en2ko ? { kind: 'en', text: it.en } : { kind: 'ko', text: it.ko, ...(audio ? { audio: true, reveal: it.ko } : {}) },
      answerKind: en2ko ? 'ko' : 'en',
      hint:       en2ko ? (state.hints[id] || null) : null,
      pairId:     state.pair && state.pair.includes(id) ? state.pair.join('|') : null,
      twoPart:    en2ko ? it.koParts.length === 2 : !!it.enHalves,
    };
  });
}

// Grades a whole column. answers: { [id]: string }. Pure: the session is not
// changed until commitRound. Near-misses start with accepted: null.
export function gradeRound(state, answers = {}) {
  const map = itemMap(state);
  const rows = state.order.map(id => {
    const g = gradeAnswer(map.get(id), state.dir, answers[id] ?? '');
    return {
      id, answer: answers[id] ?? '', verdict: g.verdict, via: g.via, matched: g.matched,
      accepted: g.verdict === 'correct' ? true : g.verdict === 'near' ? null : false,
      overridden: false, nearAccepted: false,
    };
  });

  // Pair grading (EN→KO only, both rows present): the two answers may come in
  // either order, but each word counts once — the partner is not a synonym here.
  if (state.pair && state.dir === DIRS.EN2KO) {
    const [a, b] = state.pair;
    const ia = rows.findIndex(r => r.id === a), ib = rows.findIndex(r => r.id === b);
    if (ia >= 0 && ib >= 0) {
      const A = map.get(a), B = map.get(b);
      const ansA = rows[ia].answer, ansB = rows[ib].answer;
      const score = (g) => (g.verdict === 'correct' ? 2 : g.verdict === 'near' ? 1 : 0);
      const straight = [gradeKo(A, ansA, { excludeIds: [b] }), gradeKo(B, ansB, { excludeIds: [a] })];
      const swapped  = [gradeKo(B, ansA, { excludeIds: [a] }), gradeKo(A, ansB, { excludeIds: [b] })];
      const useSwap = score(swapped[0]) + score(swapped[1]) > score(straight[0]) + score(straight[1]);
      const pick = useSwap ? swapped : straight;
      [ia, ib].forEach((idx, k) => {
        const g = pick[k];
        rows[idx] = {
          ...rows[idx], verdict: g.verdict, via: useSwap && g.verdict !== 'blank' && g.verdict !== 'incorrect' ? 'pair' : g.via, matched: g.matched,
          accepted: g.verdict === 'correct' ? true : g.verdict === 'near' ? null : false,
        };
      });
    }
  }
  return { round: state.round, dir: state.dir, rows };
}

// Learner decisions on a graded row: 'accept' / 'reject' a near-miss,
// 'override' anything not accepted ("I was right").
export function resolveRow(row, action) {
  if (action === 'accept' && row.verdict === 'near') return { ...row, accepted: true, nearAccepted: true };
  if (action === 'reject' && row.verdict === 'near') return { ...row, accepted: false, nearAccepted: false };
  if (action === 'override' && row.accepted !== true) return { ...row, accepted: true, overridden: true };
  return row;
}

// The round can close when every near-miss has been decided and, unless the
// correction step is skipped, every miss has a correct retype.
// corrections: { [id]: string }
export function roundBlockers(state, graded, corrections = {}, { skipCorrection = false } = {}) {
  const map = itemMap(state);
  const undecided = graded.rows.filter(r => r.accepted === null).map(r => r.id);
  const uncorrected = skipCorrection ? [] : graded.rows
    .filter(r => r.accepted === false && !checkCorrection(map.get(r.id), graded.dir, corrections[r.id] ?? ''))
    .map(r => r.id);
  return { undecided, uncorrected, ok: undecided.length === 0 && uncorrected.length === 0 };
}

// Done with a word: right both ways (Echo), or right once by ear (Dictation).
const isResolved = (p, kind = 'echo') => (kind === 'dictation' ? !!p.ear : p.en2ko && p.ko2en);

// Applies a fully decided round and moves to the next one (or ends).
// hinted: { [id]: true } for rows whose hidden prompt was revealed (X4).
export function commitRound(state, graded, { rand = Math.random, hinted = {} } = {}) {
  if (!state || state.done) return state;
  if (graded.round !== state.round || graded.dir !== state.dir) throw new Error('echo: graded round does not match session');
  if (graded.rows.some(r => r.accepted === null)) throw new Error('echo: near-misses still undecided');

  const progress = { ...state.progress };
  for (const r of graded.rows) {
    const p = { ...progress[r.id], first: { ...progress[r.id].first } };
    if (r.accepted) p[state.dir] = true;
    else p.misses += 1;
    if (r.overridden) p.overrides += 1;
    if (r.nearAccepted) p.nearAccepted += 1;
    if (hinted[r.id]) p.hintsUsed += 1;
    if (p.first[state.dir] === undefined || p.first[state.dir] === null) p.first[state.dir] = r.accepted ? 'correct' : 'incorrect';
    progress[r.id] = p;
  }

  const rounds = [...state.rounds, {
    round: state.round, dir: state.dir,
    rows: graded.rows.map(r => ({
      id: r.id, answer: r.answer ?? '', verdict: r.verdict, via: r.via ?? null,
      accepted: !!r.accepted, overridden: !!r.overridden, nearAccepted: !!r.nearAccepted,
      hinted: !!hinted[r.id],
    })),
  }];

  const cfg = state.config;
  const kind = isDictation(state) ? 'dictation' : 'echo';
  const allIds = state.items.map(i => i.id);
  const allResolved = allIds.every(id => isResolved(progress[id], kind));
  const base = { ...state, progress, rounds };

  let endReason = null;
  if (cfg.mode === 'complete') {
    if (allResolved) endReason = 'complete';
    else if (state.round >= ECHO_CAP) endReason = 'cap';
  } else {
    if (state.round >= cfg.rounds) endReason = 'rounds';
    else if (cfg.shrinking && allResolved) endReason = 'complete';
  }
  if (endReason) return { ...base, done: true, endReason };

  // Next round: direction flips (the answers become the prompts, E-D3);
  // Dictation repeats the same direction every round (X-D10).
  const kept = cfg.shrinking ? allIds.filter(id => !isResolved(progress[id], kind)) : allIds;
  const prevOrder = state.order.filter(id => kept.includes(id));
  const order = cfg.shuffle ? shuffled(kept, rand) : (prevOrder.length === kept.length ? prevOrder : kept);
  return { ...base, round: state.round + 1, dir: kind === 'dictation' ? DIRS.EAR : otherDir(state.dir), order };
}

// ─────────────────────────────────────────────────────────────
// Saved alternates (X1, E-D18)
// ─────────────────────────────────────────────────────────────
// An answer marked "I was right" can be saved on its Lemma Master entry
// (`echoAlternates`, an array of strings) so it counts as right from then on.
// Korean alternates answer Meaning→Korean rows; English ones Korean→Meaning.

export const ALTERNATES_MAX = 20;   // per Lemma Master entry

// The text saved for an answer: NFC, trimmed, inner spaces collapsed.
export function alternateText(answer) {
  return nfc(answer).trim().replace(/\s+/g, ' ');
}

// Why an answer can't be saved as an alternate for this item in this
// direction, or null when it can. `existing` is the entry's current
// echoAlternates array (for the cap).
//   'blank' | 'wrong-language' | 'already' | 'full'
export function alternateBlocker(item, dir, answer, existing = []) {
  const text = alternateText(answer);
  if (!text) return 'blank';
  const korean = HANGUL.test(text);
  if (dir === DIRS.EN2KO ? !korean : korean) return 'wrong-language';
  const key = dir === DIRS.EN2KO ? normKo(text) : normEn(text);
  if (!key) return 'blank';
  const list = dir === DIRS.EN2KO ? item.alternates.ko : item.alternates.en;
  if (list.includes(key)) return 'already';
  if ((existing || []).length >= ALTERNATES_MAX) return 'full';
  return null;
}

// Adds or removes saved alternates on the session's items, so later rounds
// accept them. changes: [{ id, text, remove? }]. Returns a new state.
export function withAlternates(state, changes = []) {
  if (!state || !changes.length) return state;
  const byId = new Map();
  for (const c of changes) {
    if (!c || !c.id) continue;
    const text = alternateText(c.text);
    if (!text) continue;
    if (!byId.has(c.id)) byId.set(c.id, []);
    byId.get(c.id).push({ text, remove: !!c.remove });
  }
  if (!byId.size) return state;
  const items = state.items.map(it => {
    const list = byId.get(it.id);
    if (!list) return it;
    let ko = [...it.alternates.ko], en = [...it.alternates.en];
    for (const { text, remove } of list) {
      if (HANGUL.test(text)) {
        const k = normKo(text);
        ko = remove ? ko.filter(x => x !== k) : uniq([...ko, k]);
      } else {
        const k = normEn(text);
        if (!k) continue;
        en = remove ? en.filter(x => x !== k) : uniq([...en, k]);
      }
    }
    return { ...it, alternates: { ko, en } };
  });
  return { ...state, items };
}

// ─────────────────────────────────────────────────────────────
// Word record (X2): every word across saved Echo sessions
// ─────────────────────────────────────────────────────────────
// sessions: echo_sessions docs (buildSummary shape). One row per lemmaID:
//   { lemmaID, lemma, sessions, en2ko: { correct, total }, ko2en: { correct, total },
//     ear: { correct, total } (Dictation, X-D17), misses, overrides, unresolved,
//     lastKind ('echo' | 'dictation', the latest session's), lastSeen, trend: [true | false] (last three sessions, oldest first; true =
//     no misses), wrongFirst }
// `lemma` is the most recent spelling the sessions recorded. Sorted hardest
// first: most first-try misses, then most misses, then most recently seen.
export const TREND_SESSIONS = 3;

export function buildWordRecord(sessions = []) {
  const ordered = (sessions || [])
    .filter(s => s && Array.isArray(s.items))
    .map(s => ({ s, ts: String(s.finishedAt || s.startedAt || '') }))
    .sort((a, b) => a.ts.localeCompare(b.ts));
  const rows = new Map();
  for (const { s, ts } of ordered) {
    for (const it of s.items) {
      if (!it || !it.lemmaID) continue;
      let r = rows.get(it.lemmaID);
      if (!r) {
        r = { lemmaID: it.lemmaID, lemma: '', sessions: 0, en2ko: { correct: 0, total: 0 }, ko2en: { correct: 0, total: 0 },
              ear: { correct: 0, total: 0 }, misses: 0, overrides: 0, unresolved: false, lastKind: 'echo', lastSeen: '', history: [] };
        rows.set(it.lemmaID, r);
      }
      if (it.lemma) r.lemma = nfc(it.lemma).trim();
      r.sessions += 1;
      for (const dir of ['en2ko', 'ko2en', 'ear']) {
        const f = it.firstTry?.[dir];
        if (f === 'correct' || f === 'incorrect') { r[dir].total += 1; if (f === 'correct') r[dir].correct += 1; }
      }
      const misses = Number(it.misses) || 0;
      r.misses += misses;
      r.overrides += Number(it.overrides) || 0;
      r.unresolved = it.resolved === false;
      r.lastKind = s.kind === 'dictation' ? 'dictation' : 'echo';
      r.lastSeen = ts;
      r.history.push(misses === 0);
    }
  }
  return [...rows.values()]
    .map(({ history, ...r }) => ({
      ...r,
      trend: history.slice(-TREND_SESSIONS),
      wrongFirst: (r.en2ko.total - r.en2ko.correct) + (r.ko2en.total - r.ko2en.correct) + (r.ear.total - r.ear.correct),
    }))
    .sort((a, b) => b.wrongFirst - a.wrongFirst || b.misses - a.misses || b.lastSeen.localeCompare(a.lastSeen));
}

// End button: stops where it is; the current round is not counted.
export function endSession(state) {
  if (!state || state.done) return state;
  return { ...state, done: true, endReason: 'ended' };
}

// ─────────────────────────────────────────────────────────────
// Resume (E-D13)
// ─────────────────────────────────────────────────────────────

// saved: { savedAt (ISO), state, answers? } as written to localStorage.
export function isResumable(saved, nowMs, maxDays = RESUME_MAX_DAYS) {
  const st = saved?.state;
  if (!st || st.v !== ECHO_VERSION || st.done || !Array.isArray(st.items) || !st.items.length) return false;
  if (!Array.isArray(st.order) || !st.order.length || !st.progress) return false;
  if (!st.order.every(id => st.items.some(i => i.id === id))) return false;
  const t = Date.parse(saved.savedAt);
  if (!Number.isFinite(t)) return false;
  return nowMs - t <= maxDays * 86400000;
}

// ─────────────────────────────────────────────────────────────
// Summary (E-D12) — the echo_sessions document. No undefined values.
// ─────────────────────────────────────────────────────────────

// Dictation sessions (X-D17) carry kind 'dictation' and firstTry.ear; their
// two-way figures stay at 0/0, so history and reports can keep them apart.
export function buildSummary(state, finishedAt = null) {
  const kind = isDictation(state) ? 'dictation' : 'echo';
  const dirs = kind === 'dictation' ? [DIRS.EN2KO, DIRS.KO2EN, DIRS.EAR] : [DIRS.EN2KO, DIRS.KO2EN];
  const firstTry = {};
  for (const d of dirs) {
    const vals = state.items.map(i => state.progress[i.id].first?.[d]).filter(v => v !== null && v !== undefined);
    firstTry[d] = { correct: vals.filter(v => v === 'correct').length, total: vals.length };
  }
  const items = state.items.map(i => {
    const p = state.progress[i.id];
    return {
      lemmaID:      i.id,
      lemma:        i.ko,
      misses:       p.misses,
      overrides:    p.overrides,
      nearAccepted: p.nearAccepted,
      hintsUsed:    p.hintsUsed,
      firstTry:     kind === 'dictation'
        ? { en2ko: null, ko2en: null, ear: p.first?.ear ?? null }
        : { en2ko: p.first.en2ko, ko2en: p.first.ko2en },
      resolved:     isResolved(p, kind),
    };
  });
  return {
    v:            ECHO_VERSION,
    kind,
    startedAt:    state.startedAt ?? null,
    finishedAt:   finishedAt ?? null,
    endReason:    state.endReason ?? null,
    config:       { ...state.config },
    itemCount:    state.items.length,
    roundsPlayed: state.rounds.length,
    firstTry,
    missedCount:  items.filter(i => i.misses > 0).length,
    overrideCount: items.reduce((s, i) => s + i.overrides, 0),
    unresolved:   items.filter(i => !i.resolved).map(i => i.lemmaID),
    pair:         state.pair ? [...state.pair] : null,
    items,
  };
}
