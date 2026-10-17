// src/utils/lemmaSearchEngine.js
// AVI search engine (AS1 of the AVI search overhaul).
//
// One pure, synchronous module behind every AVI search surface: the Search
// tab, AVIMiniSearchPopup, Connect List, and the Lemma Master fuzzy
// fallback. No React, no Firestore, no page imports. The async global
// lemma map step (AS-D8 step 4) lives in the caller: it awaits
// resolveLemmaWithDictionary() and hands the result to findByLemmaText().
//
// Exports:
//   buildLemmaIndex(lemmaMaster)            — once per lemmaMaster identity (useMemo)
//   buildSurfaceMap(wordInputs, sentenceInputs)
//   resolveKorean(index, query, { surfaceMap })
//   findByLemmaText(index, text)
//   suggestLemmas(index, query, { limit, excludeIds })
//   relatedLemmas(index, anchorId, { cap })
//   searchEnglish(index, query, { limit, offset })
//   filterLemmaMaster(index, query)           — Lemma Master tab's literal filter (AS4)
//   lemmaVariants, stemOf, searchKey        — exported for the golden harness
//
// Regression gate: scripts/search-golden.mjs (canonical copy in the
// AutoVocaIndex repo). Add a golden case before changing any rule here.

import {
  normalizeLemma, hangulToJamo, editDistance,
  tokenizeEnglish, DEFAULT_STOPWORDS,
} from './aviUtils.js';

// ── Small helpers ─────────────────────────────────────────────

const nfc = (s) => String(s ?? '').normalize('NFC');

// Comparison key for a normalized form: spaces removed, so 연봉이높다 and
// 연봉이 높다 meet. Different lemmas that differ only by spacing are not a
// real-world case in the Lemma Master.
export function searchKey(s) {
  return nfc(s).replace(/\s+/g, '');
}

const isSyllable = (ch) => {
  const c = ch.charCodeAt(0);
  return c >= 0xAC00 && c <= 0xD7A3;
};

// [initial, medial, final] indices for one Hangul syllable, or null.
function decompose(ch) {
  if (!ch || !isSyllable(ch)) return null;
  const n = ch.charCodeAt(0) - 0xAC00;
  return [Math.floor(n / 588), Math.floor((n % 588) / 28), n % 28];
}

const syllableCount = (s) => [...String(s || '')].filter(isSyllable).length;

// ── Headword variants ─────────────────────────────────────────
// One Lemma Master entry can stand for several headwords:
//   보장하다 / 보장되다   → 보장하다, 보장되다          (slash alternatives)
//   입사(하다)            → 입사 하다, 입사하다, 입사   (optional ending)
//   향상(하다/되다)       → 향상하다, 향상되다, 향상
//   (주먹을) 날리다       → 주먹을 날리다               (leading parenthetical
//                           is never dropped: Stage 1E keeps the collocation
//                           distinct from 날리다)
// Every variant counts as an exact match for resolution (AS-D8 step 2).

// Split on '/' that sits outside parentheses.
function splitTopLevelSlash(s) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === '/' && depth === 0) { parts.push(cur); cur = ''; }
    else cur += ch;
  }
  parts.push(cur);
  return parts.map(p => p.trim()).filter(Boolean);
}

// Expand non-leading Hangul parentheticals into with/without forms.
// "입사(하다)" → ["입사하다", "입사"]; "향상(하다/되다)" → ["향상하다", "향상되다", "향상"].
function expandOptional(part) {
  const leading = part.match(/^\(([^)]*)\)\s*/);
  const head = leading ? leading[0] : '';
  const body = leading ? part.slice(head.length) : part;
  const m = body.match(/^(.*?)\(([^()]*[가-힣][^()]*)\)(.*)$/);
  if (!m) return [part];
  const [, before, inner, after] = m;
  const out = [];
  for (const alt of inner.split('/').map(x => x.trim()).filter(Boolean)) {
    out.push(...expandOptional(head + before + alt + after));
  }
  out.push(...expandOptional(head + (before + ' ' + after).replace(/\s+/g, ' ').trim()));
  return out;
}

export function lemmaVariants(lemma) {
  const raw = nfc(lemma).trim();
  if (!raw) return [];
  const forms = new Set();
  const full = normalizeLemma(raw);
  if (full) forms.add(full);
  for (const part of splitTopLevelSlash(raw)) {
    for (const v of expandOptional(part)) {
      const n = normalizeLemma(v);
      if (n) forms.add(n);
    }
  }
  return [...forms];
}

// ── Stems ─────────────────────────────────────────────────────
// stem = form minus a final 다 (가르치다 → 가르치). Nouns are their own stem.
// root additionally strips 하다/되다/시키다/스럽다 (공부하다 → 공부).
export function stemOf(form) {
  const k = searchKey(form);
  return k.length >= 2 && k.endsWith('다') ? k.slice(0, -1) : k;
}

function rootOf(form) {
  const k = searchKey(form);
  const m = k.match(/^(.+?)(하다|되다|시키다|스럽다)$/);
  return m && syllableCount(m[1]) >= 1 ? m[1] : stemOf(k);
}

// ── Words (for collocations) ──────────────────────────────────
// 연봉이 높다 → {연봉, 높다}. Non-final words lose one common particle so the
// noun can meet its standalone entry; the final word is the predicate and
// stays as written.
const PARTICLE_RE = /(을|를|이|가|은|는|의|에|도|와|과|로|으로)$/;

function wordsOf(form) {
  // Only Hangul-bearing tokens are words: a stray "/" or "·" must never make
  // two entries look like collocations of each other.
  const ws = nfc(form).split(/\s+/).filter(w => /[가-힣]/.test(w));
  return ws.map((w, i) => {
    if (i === ws.length - 1) return w;
    const stripped = w.replace(PARTICLE_RE, '');
    return syllableCount(stripped) >= 1 ? stripped : w;
  });
}

// ── English definition tokens ─────────────────────────────────
// KRDict misses store the literal "Definition not found." — never let that
// placeholder make entries look related or match an English search. Pure
// numbers (sense numbering "10.", "11.") are dropped too.
const PLACEHOLDER_RE = /definition not found\.?/gi;

function defTokens(text) {
  const cleaned = nfc(text).replace(PLACEHOLDER_RE, ' ');
  return new Set(tokenizeEnglish(cleaned, DEFAULT_STOPWORDS).filter(t => !/^\d+$/.test(t)));
}

// def2 gloss segments for the exact-gloss bonus: "to be afraid (of); scared"
// → ["afraid", "scared"].
function glossSegments(def2) {
  return nfc(def2).toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .split(/[;,/\n]+/)
    .map(s => s.replace(/[^a-z\s'-]/g, ' ').replace(/\s+/g, ' ').trim())
    .map(s => s.replace(/^(to be|to|be)\s+/, ''))
    .filter(Boolean);
}

const glossOfQuery = (q) =>
  nfc(q).toLowerCase().replace(/[^a-z\s'-]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^(to be|to|be)\s+/, '');

// ── Index ─────────────────────────────────────────────────────

const splitIds = (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

// Per-entry derived data, cached by Lemma Master object identity. Lemma
// Master updates are immutable (a pin or an edit replaces only the touched
// objects), so a rebuild after a pin recomputes two entries, not thousands.
const entryCache = new WeakMap();

function deriveEntry(l) {
  const cached = entryCache.get(l);
  if (cached !== undefined) return cached;
  const e = computeEntry(l);
  entryCache.set(l, e);
  return e;
}

function computeEntry(l) {
  if (!l || !l.lemmaID || !l.lemma) return null;
  const raw = nfc(l.lemma).trim();
  const forms = lemmaVariants(raw);
  if (!forms.length) return null;
  // A slash lemma's combined form ("정규직 / 비정규직") is a list of
  // headwords, not a collocation: word matching uses its parts only.
  const wordForms = splitTopLevelSlash(raw).length > 1 ? forms.slice(1) : forms;
  const keys = [...new Set(forms.map(searchKey))];
  const stems = [...new Set(keys.map(stemOf))];
  const words = new Set(wordForms.flatMap(wordsOf));
  const d1 = defTokens(l.def1);
  const d2 = defTokens(l.def2);
  const e = {
    id: l.lemmaID, lemma: raw, ref: l,
    norm: forms[0], forms, keys, stems,
    roots: [...new Set(keys.map(rootOf))],
    stemJamo: stems.map(s => hangulToJamo(s)),
    keyJamo: keys.map(k => hangulToJamo(k)),            // aligned with keys
    keyStemJamo: keys.map(k => hangulToJamo(stemOf(k))), // aligned with keys
    multiWord: wordForms.some(f => wordsOf(f).length > 1),
    words, def1: d1, def2: d2,
    defAll: new Set([...d1, ...d2]),
    gloss: glossSegments(l.def2),
    def2Lower: nfc(l.def2).toLowerCase(),
    def1Lower: nfc(l.def1).toLowerCase().replace(PLACEHOLDER_RE, ' '),
    relatedForm: new Set(splitIds(l.relatedForm)),
    relatedMeaning: new Set(splitIds(l.relatedMeaning)),
    hiddenRelated: splitIds(l.hiddenRelated),
  };
  return e;
}

export function buildLemmaIndex(lemmaMaster) {
  const entries = [];
  const byId = new Map();
  const byKey = new Map();     // searchKey(variant) → entry[]
  const byRaw = new Map();     // NFC raw lemma → entry
  const df = new Map();        // def token → entry count
  const wordDf = new Map();    // collocation word → entry count

  for (const l of lemmaMaster || []) {
    if (!l || typeof l !== 'object') continue;
    const e = deriveEntry(l);
    if (!e) continue;
    entries.push(e);
    byId.set(e.id, e);
    if (!byRaw.has(e.lemma)) byRaw.set(e.lemma, e);
    for (const k of e.keys) {
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(e);
    }
    for (const t of e.defAll) df.set(t, (df.get(t) || 0) + 1);
    for (const w of e.words) wordDf.set(w, (wordDf.get(w) || 0) + 1);
  }

  return { entries, byId, byKey, byRaw, df, wordDf, N: entries.length };
}

const idf = (index, t) => Math.log(1 + index.N / (index.df.get(t) || 1));

// ── Exact lookup ──────────────────────────────────────────────
// Several entries can share a variant key (보장하다 alone and 보장하다 /
// 보장되다). Prefer the entry whose PRIMARY normalized form is the key, then
// the shorter lemma, then lemma order.
function pickExact(cands, key) {
  if (!cands || !cands.length) return null;
  return [...cands].sort((a, b) => {
    const pa = searchKey(a.norm) === key ? 0 : 1;
    const pb = searchKey(b.norm) === key ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (a.lemma.length !== b.lemma.length) return a.lemma.length - b.lemma.length;
    return a.lemma.localeCompare(b.lemma, 'ko');
  })[0];
}

export function findByLemmaText(index, text) {
  const raw = nfc(text).trim();
  if (!raw) return null;
  if (index.byRaw.has(raw)) return index.byRaw.get(raw);
  for (const v of lemmaVariants(raw)) {
    const k = searchKey(v);
    const hit = pickExact(index.byKey.get(k), k);
    if (hit) return hit;
  }
  return null;
}

// ── Surface map (AS-D8 step 3) ────────────────────────────────
// Surface forms the user has already mapped to a lemma: Word Input `input` →
// `lemma`, Sentence Input `inputForm` → `targetWord`. Latest row wins.
export function buildSurfaceMap(wordInputs = [], sentenceInputs = []) {
  const map = new Map();
  const stamp = new Map();
  const add = (surface, lemma, ts) => {
    if (!surface || !lemma) return;
    const k = searchKey(normalizeLemma(surface));
    if (!k) return;
    const t = String(ts || '');
    if (map.has(k) && stamp.get(k) > t) return;
    map.set(k, lemma); stamp.set(k, t);
  };
  for (const w of wordInputs) add(w.input, w.lemma, w.ts);
  for (const s of sentenceInputs) add(s.inputForm, s.targetWord, s.ts);
  return map;
}

// ── Suggestions (AS-D8 step 5 / AS-D11) ───────────────────────
// Labelled "Did you mean" candidates. Never an anchor on their own.
export function suggestLemmas(index, query, { limit = 8, excludeIds = [] } = {}) {
  const qk = searchKey(normalizeLemma(query));
  if (!qk) return [];
  const exclude = new Set(excludeIds);
  const qJamo = hangulToJamo(qk);
  const qStemJamo = hangulToJamo(stemOf(qk));
  const qLen = syllableCount(qk) || qk.length;
  const maxDist = qLen <= 2 ? 1 : qLen <= 4 ? 2 : 3;

  const prefix = [], contains = [], near = [];
  for (const e of index.entries) {
    if (exclude.has(e.id)) continue;
    let best = null;
    for (let i = 0; i < e.keys.length; i++) {
      const k = e.keys[i];
      if (k === qk) continue;
      if (k.startsWith(qk)) { best = { kind: 'prefix', rank: k.length - qk.length }; break; }
      if (k.includes(qk)) { if (!best || best.kind !== 'contains') best = { kind: 'contains', rank: k.length - qk.length }; continue; }
      if (best) continue;
      const d = Math.min(
        editDistance(qJamo, e.keyJamo[i], maxDist),
        editDistance(qJamo, e.keyStemJamo[i], maxDist),
        editDistance(qStemJamo, e.keyStemJamo[i], maxDist),
      );
      if (d <= maxDist) best = { kind: 'near', rank: d };
    }
    if (!best) continue;
    const item = { entry: e, lemmaID: e.id, lemma: e.lemma, kind: best.kind, rank: best.rank };
    (best.kind === 'prefix' ? prefix : best.kind === 'contains' ? contains : near).push(item);
  }
  const byRank = (a, b) => a.rank - b.rank || a.lemma.localeCompare(b.lemma, 'ko');
  prefix.sort(byRank); contains.sort(byRank); near.sort(byRank);
  // Close spellings (one jamo off) outrank loose substring hits.
  const close = near.filter(x => x.rank <= 1);
  const far   = near.filter(x => x.rank > 1);
  return [...prefix, ...close, ...contains, ...far].slice(0, limit);
}

// ── Resolution (AS-D8 steps 1–3, 5) ───────────────────────────
// status: 'exact' (steps 1–2) | 'surface' (step 3) | 'none'.
// On 'none' the caller may run the global lemma map (step 4) and, on a hit,
// call findByLemmaText(); otherwise it shows `suggestions`.
export function resolveKorean(index, query, { surfaceMap = null, suggestionLimit = 8 } = {}) {
  const raw = nfc(query).trim();
  if (!raw) return { status: 'none', entry: null, suggestions: [] };

  const verbatim = index.byRaw.get(raw);
  if (verbatim) return { status: 'exact', entry: verbatim, suggestions: [] };

  const qk = searchKey(normalizeLemma(raw));
  const exact = pickExact(index.byKey.get(qk), qk);
  if (exact) return { status: 'exact', entry: exact, suggestions: [] };

  if (surfaceMap && surfaceMap.size) {
    const mapped = surfaceMap.get(qk);
    const hit = mapped ? findByLemmaText(index, mapped) : null;
    if (hit) return { status: 'surface', entry: hit, via: mapped, suggestions: [] };
  }

  return { status: 'none', entry: null, suggestions: suggestLemmas(index, raw, { limit: suggestionLimit }) };
}

// ── Relatedness scoring (AS-D9) ───────────────────────────────

// Points for a shared stem start between two stems (no spaces).
function stemSharePoints(a, b) {
  const A = [...a], B = [...b];
  let S = 0;
  while (S < A.length && S < B.length && A[S] === B[S] && isSyllable(A[S])) S++;
  let P = false;
  if (S < A.length && S < B.length) {
    const da = decompose(A[S]), db = decompose(B[S]);
    P = !!(da && db && da[0] === db[0] && da[1] === db[1]);
  }
  const shortLen = Math.min(syllableCount(a), syllableCount(b));
  const longLen  = Math.max(syllableCount(a), syllableCount(b));
  if (S >= 2) {
    let pts = 10 + 2 * (S - 2) + (P ? 2 : 0);
    if (S === shortLen) pts += 3;
    else {
      const ja = hangulToJamo(a), jb = hangulToJamo(b);
      const [js, jl] = ja.length <= jb.length ? [ja, jb] : [jb, ja];
      if (jl.startsWith(js)) pts += 2;
    }
    return Math.min(pts, 18);
  }
  if (S === 1 && P) return 4;
  // One-syllable stems (크다 / 크기): weak, and only against short words.
  if (S === 1 && shortLen === 1 && longLen <= 2) return 3;
  return 0;
}

function bestStemShare(x, y) {
  let best = 0;
  for (const a of x.stems) for (const b of y.stems) {
    const p = stemSharePoints(a, b);
    if (p > best) best = p;
  }
  return best;
}

// Whole-word links between a single-word entry and a collocation that
// contains it (날리다 ↔ 주먹을 날리다, 연봉 ↔ 연봉이 높다), and shared rare words
// between two collocations.
function wordPoints(index, x, y) {
  const singleX = x.multiWord ? [] : x.keys;
  const singleY = y.multiWord ? [] : y.keys;
  for (const k of singleX) if (y.multiWord && y.words.has(k)) return { pts: 9, why: 'collocation' };
  for (const k of singleY) if (x.multiWord && x.words.has(k)) return { pts: 9, why: 'collocation' };
  if (x.multiWord && y.multiWord) {
    const rareCut = Math.max(3, Math.ceil(index.N * 0.02));
    let pts = 0;
    for (const w of x.words) {
      if (!y.words.has(w)) continue;
      pts = Math.max(pts, (index.wordDf.get(w) || 0) <= rareCut ? 4 : 1);
    }
    if (pts) return { pts, why: 'shared word' };
  }
  return { pts: 0, why: null };
}

function spellingPoints(x, y) {
  let best = 0;
  for (let i = 0; i < x.stems.length; i++) {
    if (syllableCount(x.stems[i]) < 2) continue;
    for (let j = 0; j < y.stems.length; j++) {
      if (syllableCount(y.stems[j]) < 2) continue;
      const d = editDistance(x.stemJamo[i], y.stemJamo[j], 2);
      // Form confusables (가리다 / 가르치다) are what Form relations are for,
      // so close spelling qualifies on its own: one jamo off 4.5, two off 3.
      if (d <= 2) best = Math.max(best, d === 0 ? 6 : d === 1 ? 4.5 : 3);
    }
  }
  return best;
}

// Weak: one key sits inside the other, not at its start and not as a whole
// word (치다 inside 가르치다). Never enough to qualify alone.
function substringPoints(x, y) {
  for (const a of x.keys) for (const b of y.keys) {
    const [s, l] = a.length <= b.length ? [a, b] : [b, a];
    if (syllableCount(s) < 2 || s === l) continue;
    if (l.includes(s) && !l.startsWith(s)) return 2;
  }
  return 0;
}

// Rare shared definition words count more; def2 (the user's own gloss) counts double.
function defPoints(index, x, y) {
  let sum = 0;
  const seen = new Set();
  const consider = (t) => {
    if (seen.has(t)) return;
    seen.add(t);
    const inX2 = x.def2.has(t), inY2 = y.def2.has(t);
    const inX = inX2 || x.def1.has(t), inY = inY2 || y.def1.has(t);
    if (!inX || !inY) return;
    const w = inX2 && inY2 ? 2 : (inX2 || inY2) ? 1 : 0.5;
    sum += w * idf(index, t);
  };
  for (const t of x.def2) consider(t);
  for (const t of x.def1) consider(t);
  return Math.min(12, sum * 0.6);
}

const MIN_SCORE = 3;

function scorePair(index, anchor, c) {
  const reasons = [];
  let score = 0;
  const stem = bestStemShare(anchor, c);
  if (stem) { score += stem; reasons.push('shared stem'); }
  const word = wordPoints(index, anchor, c);
  if (word.pts) { score += word.pts; reasons.push(word.why); }
  const spell = spellingPoints(anchor, c);
  if (spell) { score += spell; reasons.push('similar spelling'); }
  const sub = stem || word.pts ? 0 : substringPoints(anchor, c);
  if (sub) { score += sub; reasons.push('contains'); }
  const def = defPoints(index, anchor, c);
  if (def >= 0.5) { score += def; reasons.push('similar meaning'); }
  return { score: Math.round(score * 100) / 100, reasons };
}

// ── relatedLemmas (AS-D10) ────────────────────────────────────
// Returns { anchor, pinned, candidates, hidden, totalCandidates }.
//   pinned     — every Form/Meaning relation of the anchor, uncapped.
//   candidates — discovery results, score ≥ MIN_SCORE, capped at `cap`.
//   hidden     — every hidden relation of the anchor, from its own list,
//                whether or not it would have scored (AS-D4).
// Each item: { lemmaID, ref, lemma, score, reasons, tag, pinForm, pinMeaning, hide }.
export function relatedLemmas(index, anchorId, { cap = 40 } = {}) {
  const anchor = index.byId.get(anchorId);
  if (!anchor) return { anchor: null, pinned: [], candidates: [], hidden: [], totalCandidates: 0 };

  const hiddenSet = new Set(anchor.hiddenRelated);
  const item = (e, s, extra = {}) => ({
    lemmaID: e.id, ref: e.ref, lemma: e.lemma,
    score: s.score, reasons: s.reasons, tag: s.reasons[0] || '',
    pinForm: anchor.relatedForm.has(e.id),
    pinMeaning: anchor.relatedMeaning.has(e.id),
    hide: false,
    ...extra,
  });

  const pinned = [], pool = [];
  for (const e of index.entries) {
    if (e.id === anchor.id) continue;
    const isPinned = anchor.relatedForm.has(e.id) || anchor.relatedMeaning.has(e.id);
    if (!isPinned && hiddenSet.has(e.id)) continue;
    const s = scorePair(index, anchor, e);
    if (isPinned) pinned.push(item(e, s));
    else if (s.score >= MIN_SCORE) pool.push(item(e, s));
  }

  const order = (a, b) => b.score - a.score || a.lemma.localeCompare(b.lemma, 'ko');
  pinned.sort(order);
  pool.sort(order);

  const hidden = [];
  for (const id of anchor.hiddenRelated) {
    if (anchor.relatedForm.has(id) || anchor.relatedMeaning.has(id)) continue;
    const e = index.byId.get(id);
    if (!e || e.id === anchor.id) continue;   // stale id: skip
    hidden.push(item(e, scorePair(index, anchor, e), { hide: true }));
  }
  hidden.sort((a, b) => a.lemma.localeCompare(b.lemma, 'ko'));

  return {
    anchor: { lemmaID: anchor.id, ref: anchor.ref, lemma: anchor.lemma },
    pinned,
    candidates: pool.slice(0, cap),
    hidden,
    totalCandidates: pool.length,
  };
}

// ── searchEnglish (AS-D18 / AS-D29) ───────────────────────────
// Ranked by: exact def2 gloss, then how many query words matched, then
// rarity-weighted overlap (def2 double), with a bonus for the whole phrase.
// Returns { results, total } — `results` is the [offset, offset+limit) page.
export function searchEnglish(index, query, { limit = 20, offset = 0 } = {}) {
  const qTokens = [...new Set(tokenizeEnglish(nfc(query), DEFAULT_STOPWORDS).filter(t => !/^\d+$/.test(t)))];
  if (!qTokens.length) return { results: [], total: 0 };
  const qGloss  = glossOfQuery(query);
  const qPhrase = nfc(query).toLowerCase().replace(/\s+/g, ' ').trim();
  const multiWordPhrase = qPhrase.includes(' ');

  const scored = [];
  for (const e of index.entries) {
    let matched = 0, weight = 0;
    for (const t of qTokens) {
      if (e.def2.has(t))      { matched++; weight += 2 * idf(index, t); }
      else if (e.def1.has(t)) { matched++; weight += idf(index, t); }
    }
    if (!matched) continue;
    const exactGloss = !!qGloss && e.gloss.includes(qGloss);
    // An entry whose whole def2 is the query outranks one listing it as one
    // sense among several (가르치다 "to teach" over 가르쳐 주다 "to teach, to show how").
    const glossBonus = exactGloss ? 1000 + 60 / Math.max(1, e.gloss.length) : 0;
    const phrase = multiWordPhrase && (e.def2Lower.includes(qPhrase) || e.def1Lower.includes(qPhrase));
    const score = glossBonus + matched * 100 + weight + (phrase ? 5 : 0);
    scored.push({
      lemmaID: e.id, ref: e.ref, lemma: e.lemma,
      score: Math.round(score * 100) / 100,
      reasons: [exactGloss ? 'exact gloss' : phrase ? 'phrase' : 'definition'],
      tag: 'en', pinForm: false, pinMeaning: false, hide: false,
    });
  }
  scored.sort((a, b) => b.score - a.score || a.lemma.localeCompare(b.lemma, 'ko'));
  return { results: scored.slice(offset, offset + limit), total: scored.length };
}

// ── filterLemmaMaster (AS4, AS-D22) ───────────────────────────
// The Lemma Master tab's literal filter, in ranked tiers. Unlike search,
// nothing is fuzzy here: an entry appears only if it literally matches.
//   Korean:  exact → starts with → contains → definition text
//            (headword variants count; "starts with" works mid-syllable at
//            the jamo level, so 갈 on its way to 가르 already finds 가르치다)
//   English: def2 → def1, every query word matched as a word start, so a
//            half-typed "afr" finds "afraid"
// Returns { mode: 'all' | 'ko' | 'en', tiers: [[entry…]…], total }.
// Each tier keeps Lemma Master order; the page applies its sort within tiers.
const HANGUL_OR_JAMO = /[가-힣ㄱ-ㆎ]/;

export function filterLemmaMaster(index, query) {
  const raw = nfc(query).trim();
  if (!raw) return { mode: 'all', tiers: [index.entries], total: index.entries.length };

  if (HANGUL_OR_JAMO.test(raw)) {
    const qk = searchKey(normalizeLemma(raw)) || searchKey(raw);
    const qJamo = hangulToJamo(qk);
    const qLower = raw.toLowerCase();
    const exact = [], prefix = [], contains = [], definition = [];
    for (const e of index.entries) {
      const rawL = e.lemma.toLowerCase();
      if (e.keys.includes(qk) || e.lemma === raw) exact.push(e);
      else if (e.keyJamo.some(j => j.startsWith(qJamo)) || rawL.startsWith(qLower)) prefix.push(e);
      else if (e.keys.some(k => k.includes(qk)) || rawL.includes(qLower)) contains.push(e);
      else if (nfc(e.ref.def2).includes(raw) || nfc(e.ref.def1).includes(raw)) definition.push(e);
    }
    return { mode: 'ko', tiers: [exact, prefix, contains, definition], total: exact.length + prefix.length + contains.length + definition.length };
  }

  const qTokens = [...new Set(tokenizeEnglish(raw, DEFAULT_STOPWORDS).filter(t => !/^\d+$/.test(t)))];
  const inDef2 = [], inDef1 = [];
  if (qTokens.length) {
    const hasPrefix = (set, q) => { for (const t of set) if (t.startsWith(q)) return true; return false; };
    for (const e of index.entries) {
      if (qTokens.every(q => hasPrefix(e.def2, q))) inDef2.push(e);
      else if (qTokens.every(q => hasPrefix(e.defAll, q))) inDef1.push(e);
    }
  } else {
    // Only stopwords or a single letter so far: plain text match on the defs.
    const q = raw.toLowerCase();
    for (const e of index.entries) {
      if (e.def2Lower.includes(q)) inDef2.push(e);
      else if (e.def1Lower.includes(q)) inDef1.push(e);
    }
  }
  return { mode: 'en', tiers: [inDef2, inDef1], total: inDef2.length + inDef1.length };
}
