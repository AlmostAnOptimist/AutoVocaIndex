// src/utils/importEngine.js
// Pure logic for the AVI Import tab: sentence segmentation, word-list
// parsing, and chunking. No Firebase, no React, and no direct aviUtils
// imports — anything that needs app services (text cleaning now; lemma
// cascade lookups in Stage 9.2) is injected as a function parameter, so
// this module runs unmodified in a bare node harness for verification.

export const IMPORT_LIMITS = {
  desktop: { sentences: 200, words: 1000 },
  // Mobile matches the confirmed-rendering page sizes of Sentence/Word Input.
  mobile:  { sentences: 50,  words: 25 },
};

const TERMINAL_SPLIT = /([.!?…。！？]+)/;
const TERMINAL_ONLY  = /^[.!?…。！？]+$/;

// Characters that, when they immediately follow terminal punctuation,
// mean the terminal belongs inside a quotation — do not break there.
const CLOSING_QUOTES = new Set(['"', '\u201D', '\u2019', "'", '\u300D', '\u300F', '\u3009', '\u300B', ')']);

export function countHangulSyllables(s) {
  const m = String(s || '').match(/[\uAC00-\uD7A3]/g);
  return m ? m.length : 0;
}

// Leading list-marker patterns: "1 ", "1. ", "1) ", "(1) ", and circled
// digits. The dot form requires trailing whitespace so a line that opens
// with a decimal number (3.5점을 받았어요) survives untouched.
const LIST_MARKERS = [
  /^\s*\(\d{1,4}\)\s*/,
  /^\s*\d{1,4}\)\s*/,
  /^\s*\d{1,4}\.\s+/,
  /^\s*\d{1,4}\s+/,
  /^\s*[\u2460-\u2473]\s*/,
];

export function stripListMarker(line) {
  const s = String(line || '');
  for (const pat of LIST_MARKERS) {
    if (pat.test(s)) return s.replace(pat, '');
  }
  return s;
}

// Split pasted prose into sentences.
// Rules (locked in D9.2): break on . ! ? … 。！？ and newlines; terminal
// punctuation inside quotes stays attached to its sentence; decimal
// points do not break; fragments under 4 Hangul syllables merge into
// the preceding sentence.
export function segmentSentences(text) {
  const parts = [];

  String(text || '').split(/\n+/).forEach(line => {
    const pieces = stripListMarker(line).split(TERMINAL_SPLIT);
    let buf = '';
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      if (!TERMINAL_ONLY.test(piece)) { buf += piece; continue; }
      buf += piece;
      const next = pieces[i + 1] || '';
      // Terminal inside a quotation: 그는 "가자!"라고 말했다.
      if (next && CLOSING_QUOTES.has(next.charAt(0))) continue;
      // Decimal number: 3.5
      if (piece === '.' && /\d$/.test(buf.slice(0, -1)) && /^\d/.test(next)) continue;
      const t = buf.trim();
      if (t) parts.push(t);
      buf = '';
    }
    const tail = buf.trim();
    if (tail) parts.push(tail);
  });

  // Merge short fragments into the preceding sentence. A short fragment
  // with no preceding sentence (it opens the text) prefixes the next one
  // instead of standing alone.
  const merged = [];
  let pendingPrefix = '';
  for (const p of parts) {
    const isShort = countHangulSyllables(p) < 4;
    if (isShort && merged.length) { merged[merged.length - 1] += ' ' + p; continue; }
    if (isShort) { pendingPrefix += (pendingPrefix ? ' ' : '') + p; continue; }
    merged.push(pendingPrefix ? pendingPrefix + ' ' + p : p);
    pendingPrefix = '';
  }
  if (pendingPrefix) merged.push(pendingPrefix);
  return merged;
}

// Parse a pasted word list: one term per line, cleaned via the injected
// cleaner (the page passes cleanStagingText bound to the user's noise
// blocks), duplicates within the paste collapsed by surface form.
// Cross-referencing against existing wordInputs is Stage 9.2
// classification work, not parsing work — it does not happen here.
export function segmentWords(text, cleanFn) {
  const clean = typeof cleanFn === 'function' ? cleanFn : (s) => String(s || '').trim();
  const seen = new Set();
  const out = [];
  String(text || '').split(/\n+/).forEach(line => {
    const t = String(clean(stripListMarker(line)) || '').trim();
    if (!t) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  });
  return out;
}

// Cap a parsed item list to the per-run soft limit. The remainder is
// held (as parsed items, so nothing is re-parsed) and offered through
// the Continue import flow.
export function chunkItems(items, limit) {
  const arr = Array.isArray(items) ? items : [];
  const max = Number(limit) > 0 ? Number(limit) : arr.length;
  return { chunk: arr.slice(0, max), remainder: arr.slice(max) };
}

// ── Stage 9.2/9.3: import plan and commit-row construction ────
// Still pure: wordInputs/lemmaMaster arrive as plain arrays, and cleaning,
// normalization, and id generation are injected.

// Tokenize one sentence for import: whitespace split, cleaned, Korean
// tokens only, deduplicated within the sentence.
export function tokenizeSentenceForImport(sentence, cleanFn) {
  const clean = typeof cleanFn === 'function' ? cleanFn : (s) => String(s || '').trim();
  const seen = new Set();
  const out = [];
  for (const rawTok of String(sentence || '').split(/\s+/)) {
    const t = String(clean(rawTok) || '').trim();
    if (!t || !/[가-힣]/.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// Classify a chunk into new terms and already-known terms. Known = the
// surface matches an existing wordInput by raw input or by normalized
// lemma — the same predicate as live staging. Sentence indices are
// retained so sentence mode can attach each term to its sentences.
export function buildImportPlan(mode, items, deps) {
  const { wordInputs = [], cleanFn, normalizeLemma } = deps || {};
  const nl = typeof normalizeLemma === 'function' ? normalizeLemma : (s) => String(s || '').trim();

  // Non-Hangul (English/loanword) surfaces match case-insensitively,
  // consistent with segmentWords' within-paste dedupe.
  const surfKey = (s) => /[가-힣]/.test(s) ? s : String(s).toLowerCase();
  const inputSet = new Set();
  const lemmaByNorm = new Map();
  for (const w of wordInputs) {
    if (w.input) inputSet.add(surfKey(w.input));
    if (w.lemma) lemmaByNorm.set(nl(w.lemma), w.lemma);
  }

  const newByKey = new Map();
  const knownByInput = new Map();

  const addTerm = (surface, sentenceIdx) => {
    const nk = nl(surface) || surface;
    const knownLemma = inputSet.has(surfKey(surface))
      ? surface
      : (lemmaByNorm.has(nk) ? lemmaByNorm.get(nk) : null);
    if (knownLemma !== null) {
      let k = knownByInput.get(surface);
      if (!k) { k = { input: surface, matchedLemma: knownLemma, sentenceIdxs: [] }; knownByInput.set(surface, k); }
      if (sentenceIdx != null) k.sentenceIdxs.push(sentenceIdx);
      return;
    }
    let t = newByKey.get(nk);
    if (!t) { t = { input: surface, lemma: '', resolvedLemma: '', included: true, sentenceIdxs: [] }; newByKey.set(nk, t); }
    if (sentenceIdx != null) t.sentenceIdxs.push(sentenceIdx);
  };

  if (mode === 'word') {
    for (const w of items) addTerm(w, null);
  } else {
    items.forEach((s, i) => {
      for (const t of tokenizeSentenceForImport(s, cleanFn)) addTerm(t, i);
    });
  }
  return { newTerms: [...newByKey.values()], knownTerms: [...knownByInput.values()] };
}

// Build the commit rows for the included, lemma-final terms of one chunk.
// Field sets mirror the live staging flows exactly (handlePopupDone and
// createSentenceRowsWithLemma): no new fields, no undefined values, defs
// filled only from an existing lemmaMaster entry — never fetched here.
export function buildCommitRows({ mode, terms, sentences, lemmaMaster, source, section, uuid, normalizeLemma, knownTerms = [], includeKnownSentences = false }) {
  const nl = typeof normalizeLemma === 'function' ? normalizeLemma : (s) => String(s || '').trim();
  const now = new Date().toISOString();

  const lemmaMap = {};
  for (const l of lemmaMaster || []) {
    lemmaMap[l.lemma] = l;
    if (l.cleanedLemma) lemmaMap[l.cleanedLemma] = l;
  }

  const newWordInputs = [];
  const newLemmas = [];
  const newSentenceRows = [];

  for (const t of terms || []) {
    const lemma = t.lemma || t.input;
    const norm = nl(lemma);
    let lEntry = lemmaMap[lemma] || lemmaMap[norm] || null;
    const def1 = lEntry?.def1 || '';
    const def2 = lEntry?.def2 || '';
    if (!lEntry) {
      lEntry = {
        lemma, def1: '', def2: '',
        relatedForm: '', relatedMeaning: '', hiddenRelated: '',
        lastUpdated: now, autoAddedBy: 'import',
        cleanedLemma: norm, originUID: uuid(), lemmaID: uuid(),
      };
      newLemmas.push(lEntry);
      lemmaMap[lemma] = lEntry;
      lemmaMap[norm] = lEntry;
    }
    newWordInputs.push({
      uid: uuid(), ts: now, input: t.input,
      source, section,
      lemma, def1, def2,
      uploaded: false, skipUpload: false,
      lastUncheckReason: '', lastUncheckDate: '',
    });
    if (mode === 'sentence') {
      for (const idx of [...new Set(t.sentenceIdxs || [])]) {
        const sentence = sentences[idx];
        if (!sentence) continue;
        newSentenceRows.push({
          uid: uuid(), ts: now,
          sentence, targetWord: lemma,
          cardFront: lemma + '\n' + sentence,
          cardBack: def2 || def1 || '',
          inputForm: sentence.includes(t.input) ? t.input : '',
          source, section,
          uploaded: false, skipUpload: false,
          lastUncheckReason: '', lastUncheckDate: '',
        });
      }
    }
  }
  // Sentence rows for already-known terms — opt-in via the Import intake
  // toggle. No new word rows or lemmas; defs come from the existing entry.
  if (mode === 'sentence' && includeKnownSentences) {
    for (const k of knownTerms || []) {
      const lemma  = k.matchedLemma || k.input;
      const lEntry = lemmaMap[lemma] || lemmaMap[nl(lemma)] || null;
      const def1 = lEntry?.def1 || '';
      const def2 = lEntry?.def2 || '';
      for (const idx of [...new Set(k.sentenceIdxs || [])]) {
        const sentence = sentences[idx];
        if (!sentence) continue;
        newSentenceRows.push({
          uid: uuid(), ts: now,
          sentence, targetWord: lemma,
          cardFront: lemma + '\n' + sentence,
          cardBack: def2 || def1 || '',
          inputForm: sentence.includes(k.input) ? k.input : '',
          source, section,
          uploaded: false, skipUpload: false,
          lastUncheckReason: '', lastUncheckDate: '',
        });
      }
    }
  }
  return { newWordInputs, newLemmas, newSentenceRows };
}

// ── Stage 9.5: subtitle markup stripping ──────────────────────
// Converts .srt / .vtt subtitle text into plain prose lines: drops
// headers, NOTE/STYLE/REGION blocks, cue identifiers, sequence numbers,
// and timestamp lines; strips inline tags (<i>, <c>, <v Name>) and
// ASS-style overrides; collapses the duplicate consecutive lines that
// rolling captions produce.
export function detectUploadKind(filename) {
  const m = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

export function stripSubtitleMarkup(text, kind) {
  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out = [];
  let skipBlock = false;
  const TIME = /-->/;
  for (let i = 0; i < lines.length; i++) {
    let ln = lines[i].trim();
    if (!ln) { skipBlock = false; continue; }
    if (kind === 'vtt') {
      if (/^WEBVTT/i.test(ln)) continue;
      if (/^(NOTE|STYLE|REGION)\b/.test(ln)) { skipBlock = true; continue; }
      if (skipBlock) continue;
      // A cue identifier is a line immediately followed by a timestamp.
      const next = (lines[i + 1] || '').trim();
      if (!TIME.test(ln) && TIME.test(next)) continue;
    }
    if (TIME.test(ln)) continue;
    if (/^\d+$/.test(ln)) continue;
    ln = ln.replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').trim();
    if (!ln) continue;
    if (out.length && out[out.length - 1] === ln) continue;
    out.push(ln);
  }
  return out.join('\n');
}