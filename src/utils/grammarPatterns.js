// src/utils/grammarPatterns.js
// Recognising Grammar Index patterns in a Korean sentence, with no call to
// anything (audit G3, decision GS-D2).
//
// How it works, in one paragraph: a morphological analyser splits a sentence
// into labelled morphemes (올 수 있어요 -> 오/verb ㄹ/ending 수/bound-noun
// 있/verb 어요/ending). An entry's title already describes its pattern in a
// regular notation (~ㄹ/을 수 있다/없다). The title is expanded into its
// concrete forms, each is put on a dummy stem (받을 수 있다) and run through
// the SAME analyser, and the dummy is removed. What is left is the entry's
// "skeleton" (ㄹ + 수 + 있). A sentence contains the pattern when its
// morphemes contain the skeleton. No rule is written by hand per entry.
//
// The analyser is passed in (see koreanAnalyser.js for the browser and
// tests/load-analyser.mjs for the tests):
//   analyse(text) -> [{ text, pos, start, end }]   Sejong tags; start and
//                                                  end are character
//                                                  offsets of the word the
//                                                  morpheme belongs to
//
//   compilePatterns(entries, analyse) -> compiled   entries: [{ id, pattern }]
//   findPatterns(sentence, compiled, analyse, opts) -> [{ id, by, from, to }]
//
// Leaf module, no imports.

// ── Hangul ────────────────────────────────────────────────────
const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
const JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const isSyllable = (c) => c >= '가' && c <= '힣';
const isJamo = (c) => c >= 'ㄱ' && c <= 'ㅎ';
const hasHangul = (s) => /[가-힣ㄱ-ㅎ]/.test(s);
const splitSyllable = (c) => { const i = c.charCodeAt(0) - 0xAC00; return [Math.floor(i / 588), Math.floor((i % 588) / 28), i % 28]; };
const joinSyllable = (a, b, c) => String.fromCharCode(0xAC00 + a * 588 + b * 28 + c);
const chars = (s) => [...s];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cls = (s) => `[${s}]`;

// Every syllable ending in a given final consonant ("ㄹ" -> 갈 날 달 ...).
const syllablesEndingIn = (j) => { let s = ''; for (let a = 0; a < 19; a++) for (let b = 0; b < 21; b++) s += joinSyllable(a, b, JONG.indexOf(j)); return s; };
const JONG_CLASS = Object.fromEntries(['ㄴ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅆ'].map(j => [j, syllablesEndingIn(j)]));
// Syllables that can hide a fused 아/어 (가+아=가, 오+아=와, 하+여=해 ...),
// open and with a final ㅆ (갔 왔 했).
const FUSED_VOWELS = ['ㅏ', 'ㅓ', 'ㅐ', 'ㅔ', 'ㅕ', 'ㅘ', 'ㅝ', 'ㅙ', 'ㅞ'].map(v => JUNG.indexOf(v));
let FUSED_OPEN = '', FUSED_SS = '';
for (let a = 0; a < 19; a++) for (const b of FUSED_VOWELS) { FUSED_OPEN += joinSyllable(a, b, 0); FUSED_SS += joinSyllable(a, b, 20); }

// ── Reading a title ───────────────────────────────────────────
// Entries that name a topic, not a form: nothing to recognise.
const TOPIC = /^(?:[A-Za-z]{3,}|.*(?:체|불규칙|사이시옷|구두법|겹침|보조동사|단어 [사피]동)|은\/는 vs)/;

// A title -> its alternatives ("A / B", "A, B"), notes and stand-alone
// optional words removed. null for a topic.
export function patternAlternatives(pattern) {
  const term = String(pattern || '').trim();
  if (!term || !hasHangul(term) || TOPIC.test(term)) return null;
  let t = term.replace(/\?/g, '').replace(/"…"/g, 'N');
  // "(~았/었나 보다)", "(안 V아/어도 되다)": a bracketed form written as a
  // pattern is one more way of writing the entry.
  const extra = [];
  t = t.replace(/\s\(([^)]*(?:~|(?:^|\s)[VAN][가-힣ㄱ-ㅎ])[^)]*)\)/g, (m, inner) => { extra.push(inner); return ' '; });
  if (extra.length) t = `${t} / ${extra.join(' / ')}`;
  t = t.replace(/\s\([^)]*\)/g, ' ');                       // "(가다/오다)" standing alone: optional, dropped
  t = t.replace(/^\(([가-힣]+)\)\s/, '');                    // "(과연) ~ㄹ/을까"
  t = t.replace(/\((?:[^)]*[A-Za-z一-龥][^)]*)\)/g, ' ');     // notes in English or hanja
  t = t.replace(/\s\+\s/g, ' ').replace(/-(?=\s|$)/g, '').replace(/~(?=\s|$)/g, '');
  const alts = t.split(/\s\/\s|,\s/).map(s => s.trim()).filter(s => s && hasHangul(s));
  return alts.length ? alts : null;
}

// One written token -> its concrete forms:
//   (으)면 -> 으면, 면      ㄴ/은/는데도 -> ㄴ데도, 은데도, 는데도
//   느라(고) -> 느라, 느라고    있다/없다 -> 있다, 없다
export function expandToken(tok) {
  const lead = tok.match(/^\(([^)]+)\)(.*)$/);
  if (lead) {
    const rest = expandToken(lead[2]);
    return [...new Set([...lead[1].split('/').flatMap(o => rest.map(r => o + r)), ...rest])];
  }
  const opt = tok.match(/^([^(]*)\(([^)]+)\)(.*)$/);
  if (opt) return [...new Set([...expandToken(opt[1] + opt[3]), ...opt[2].split('/').flatMap(o => expandToken(opt[1] + o + opt[3]))])];
  const parts = tok.split('/');
  if (parts.length === 1) return [tok];
  // ㄴ/은/는데도: the alternatives are single units and the rest belongs to
  // each. 있다/없다: whole words.
  if (parts.slice(0, -1).every(p => chars(p).length === 1)) {
    const last = chars(parts[parts.length - 1]);
    return [...parts.slice(0, -1), last[0]].map(p => p + last.slice(1).join(''));
  }
  // 포함하다/되다: the second word replaces 하다, it does not stand alone.
  const head = parts[0];
  if (head.endsWith('하다') && chars(head).length > 2) return parts.map((p, i) => (i > 0 && LIGHT_VERBS.has(p) ? head.slice(0, -2) + p : p));
  return parts;
}
const LIGHT_VERBS = new Set(['되다', '시키다', '받다', '당하다']);

// An alternative -> every concrete reading of it, each a list of tokens:
//   { kind: 'attach', text }  written with ~, joined to a stem or a noun
//   { kind: 'stem', text }    V고, A게: joined to a verb or adjective
//   { kind: 'noun', text }    N때문에: joined to a noun
//   { kind: 'word', text }    a word of its own (수, 있다, 때문에)
//   { kind: 'slot' }          a bare N, V or A: something stands here
const MAX_READINGS = 64;
export function patternReadings(alternative) {
  let lists = [[]];
  for (const raw of alternative.split(/\s+/).filter(Boolean)) {
    if (/^[NVAB]$/.test(raw)) { lists = lists.map(l => [...l, { kind: 'slot' }]); continue; }
    let kind = 'word', body = raw;
    if (raw.startsWith('~')) { kind = 'attach'; body = raw.slice(1); }
    else if (/^N[^A-Za-z]/.test(raw)) { kind = 'noun'; body = raw.slice(1); }
    else if (/^[VA][^A-Za-z]/.test(raw)) { kind = 'stem'; body = raw.slice(1); }
    else if (/^[AB][은는을를이가에]/.test(raw)) { kind = 'noun'; body = raw.slice(1); }
    let forms = expandToken(body).filter(f => f && hasHangul(f));
    // ~ㄴ/는다고 is ~다고 after an adjective (바쁘다고), which titles leave out.
    if (kind === 'attach') forms = [...new Set(forms.flatMap(f => (f.startsWith('는다') ? [f, f.slice(1)] : [f])))];
    if (!forms.length) { lists = lists.map(l => [...l, { kind: 'slot' }]); continue; }
    lists = lists.flatMap(l => forms.map(f => [...l, { kind, text: f }])).slice(0, MAX_READINGS);
  }
  return lists.filter(l => l.some(t => t.kind !== 'slot'));
}

// ── Second opinion: the written form itself ───────────────────
// Only used for patterns with a distinctive fixed word (see isDistinctive).
function stemRegex(word) {            // 있다 -> 있, 하다 -> 하/해/했/한/할..., 쉽다 -> 쉽/쉬
  if (!word.endsWith('다') || chars(word).length < 2) return esc(word);
  const stem = chars(word).slice(0, -1), last = stem[stem.length - 1];
  if (!isSyllable(last)) return esc(stem.join(''));
  const [a, b, c] = splitSyllable(last), head = esc(stem.slice(0, -1).join(''));
  if (c !== 0) return JONG[c] === 'ㅂ' ? head + cls(last + joinSyllable(a, b, 0)) : head + esc(last);
  let set = '';
  for (let j = 0; j < 28; j++) set += joinSyllable(a, b, j);
  const fused = { 'ㅏ': 'ㅐ', 'ㅗ': 'ㅘ', 'ㅜ': 'ㅝ', 'ㅣ': 'ㅕ', 'ㅚ': 'ㅙ', 'ㅡ': 'ㅓ' }[JUNG[b]];
  if (fused) for (const j of [0, 20, 4, 8]) set += joinSyllable(a, JUNG.indexOf(fused), j);
  if (JUNG[b] === 'ㅡ') for (const j of [0, 20]) set += joinSyllable(a, JUNG.indexOf('ㅏ'), j);
  return head + cls(set);
}
function attachRegex(form) {
  const cs = chars(form), first = cs[0], rest = cs.slice(1).join('');
  const restRe = chars(rest).length > 1 && rest.endsWith('다') ? stemRegex(rest) : esc(rest);
  if (JONG_CLASS[first]) return cls(JONG_CLASS[first]) + restRe;
  if (first === '아' || first === '어') return `(?:[가-힣][아어여]|${cls(FUSED_OPEN)})${restRe}`;
  if (first === '았' || first === '었') return `(?:[가-힣][았었였]|${cls(FUSED_SS)})${restRe}`;
  if (cs.length > 1 && form.endsWith('다')) return `[가-힣]${stemRegex(form)}`;
  return `[가-힣]${esc(form)}`;
}
function surfaceRegex(reading) {
  let re = '';
  reading.forEach((t, i) => {
    let part;
    if (t.kind === 'slot') part = '[가-힣]+(?:\\s[가-힣]+){0,2}?';
    else if (t.kind === 'attach' || t.kind === 'stem') part = attachRegex(t.text);
    else if (t.kind === 'noun') part = `[가-힣]${esc(t.text.endsWith('다') ? t.text.slice(0, -1) : t.text)}`;
    else part = stemRegex(t.text);
    re += (i ? '\\s?' : '') + part;
  });
  if (reading[0].kind === 'word') re = `(?<![가-힣])${re}`;
  const last = reading[reading.length - 1];
  if (last.kind === 'word' && !last.text.endsWith('다')) re += '(?![가-힣])';
  return new RegExp(re, 'u');
}
// A reading is distinctive when it has a word of its own with at least two
// syllables of fixed text (때문에, 정도로, 이상, 나머지). Its written form is
// then unusual enough to trust when the analyser misreads the sentence.
// Short auxiliaries (~아/어 가다, ~고 있다) are not: 학교에 갔어요 looks like
// ~어 가다 on the surface.
// Nor is anything joined by 아/어: on the surface that is "any syllable
// with an open ㅏ or ㅓ", which 살다 보니까 satisfies for ~아/어 보니까.
const fixedText = (t) => (t.text.endsWith('다') ? t.text.slice(0, -1) : t.text);
const joined = (t) => t.kind === 'attach' || t.kind === 'stem' || t.kind === 'noun';
export function isDistinctive(reading) {
  return reading.some(t => t.kind === 'word' && chars(fixedText(t)).filter(isSyllable).length >= 2)
    && reading.some(joined)
    && !reading.some(t => joined(t) && /^[아어았었]/.test(t.text));
}

// ── Morphemes ─────────────────────────────────────────────────
// Tag classes: endings, particles, bound nouns, verbs and adjectives,
// suffixes, nouns, adverbs and determiners, symbols, other.
const tagClass = (pos) => (pos[0] === 'E' ? 'E' : pos[0] === 'J' ? 'J' : pos === 'NNB' ? 'B' : pos[0] === 'V' ? 'V' : pos[0] === 'X' ? 'X' : pos[0] === 'N' ? 'N' : pos[0] === 'M' ? 'M' : pos[0] === 'S' ? 'S' : 'O');
// Forms that differ only by the sound before them are one form.
const PARTICLE_FORM = { '은': '는', '이': '가', '을': '를', '와': '과', '으로': '로', '이나': '나', '이랑': '랑', '이라도': '라도', '이란': '란', '이야말로': '야말로', '이라고': '라고', '이면': '면', '이든지': '든지' };
function canonical(form, c) {
  if (c === 'J') return PARTICLE_FORM[form] || form;
  if (c === 'B') return form === '거' ? '것' : form;
  if (c !== 'E') return form;
  let f = form.replace(/^으/, '').replace(/^을/, 'ㄹ').replace(/^은/, 'ㄴ').replace(/^음/, 'ㅁ').replace(/^습니/, 'ㅂ니').replace(/^읍/, 'ㅂ');
  f = f.replace(/^[아여]/, '어').replace(/^[았였]/, '었').replace(/요$/, '');
  return f || '요';
}
export function morphemes(text, analyse) {
  return fixUnknownParticles((analyse(text) || [])
    .map(t => ({ c: tagClass(t.pos), raw: t.text, start: t.start, end: t.end }))
    .filter(t => t.c !== 'S'))
    .map(t => ({ ...t, f: canonical(t.raw, t.c) }));
}
// LM2 (Nov 2026): particles the analyser doesn't know. 깨나 ("quite a bit
// of": 힘깨나, 돈깨나) comes back either inside one noun (책깨나/N) or as a
// noun + the verb 깨다 + an ending in the same word (친구 + 깨 + 나). Both
// become noun + 깨나/particle, so an N깨나 entry is found and 잠이 깨나 (the
// verb, at the start of its word) is not. 어깨나 is read as 어깨 + 나 and
// is left alone.
function fixUnknownParticles(toks) {
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i], n1 = toks[i + 1], n2 = toks[i + 2];
    if (t.c === 'N' && chars(t.raw).length >= 3 && t.raw.endsWith('깨나')) {
      out.push({ ...t, raw: t.raw.slice(0, -2) }, { ...t, c: 'J', raw: '깨나' });
      continue;
    }
    out.push(t);
    if (t.c === 'N' && n1 && n2 && n1.raw === '깨' && n1.c === 'V' && n2.raw === '나' && n2.c === 'E'
      && n1.start === t.start && n2.start === t.start) {
      out.push({ ...n1, c: 'J', raw: '깨나' });
      i += 2;
    }
  }
  return out;
}

// Dummy stems the analyser reads reliably: a consonant stem, a vowel stem,
// an ㅏ stem (for 아/았 forms), and two nouns.
const DUMMY = { verbC: '받', verbV: '마시', verbA: '찾', nounC: '사람', nounV: '친구' };
function attachTo(stem, form) {
  const cs = chars(form);
  if (!isJamo(cs[0])) return stem + form;
  const s = chars(stem), [a, b] = splitSyllable(s[s.length - 1]);
  return s.slice(0, -1).join('') + joinSyllable(a, b, JONG.indexOf(cs[0])) + cs.slice(1).join('');
}
function dummyPhrase(reading, mode) {
  return reading.map((t) => {
    if (t.kind === 'slot') return null;
    if (t.kind === 'word') return { text: t.text, dummy: null };
    const first = chars(t.text)[0];
    const asNoun = t.kind === 'noun' || (t.kind === 'attach' && mode === 'noun');
    const stem = asNoun
      ? (/^[이으은을과]/.test(t.text) ? DUMMY.nounC : DUMMY.nounV)
      : (isJamo(first) ? DUMMY.verbV : /^[아았]/.test(first) ? DUMMY.verbA : DUMMY.verbC);
    return { text: attachTo(stem, t.text), dummy: stem };
  });
}
// A reading -> its skeleton: segments of { f, c } with null where something
// stands between them. null when the analyser doesn't read the dummy phrase
// the way it was built.
function skeletonFor(reading, mode, analyse) {
  const words = dummyPhrase(reading, mode);
  const segs = [];
  let ok = true, run = [];
  const flush = () => {
    if (!run.length) return;
    const phrase = run.map(w => w.text).join(' ');
    const dummies = run.filter(w => w.dummy).map(w => w.dummy);
    // A form that ends a sentence (…다, …요) is analysed as one; anything
    // else is given a clause to lead into, which is then cut off again.
    const endsDa = phrase.endsWith('다'), final = endsDa || phrase.endsWith('요');
    const inPhrase = (toks) => toks.filter(t => t.start < chars(phrase).length);
    let seg = final ? morphemes(`${phrase}.`, analyse) : inPhrase(morphemes(`${phrase} 그래요.`, analyse));
    // A dictionary 다 after a stem (있다, 하다) is not part of the pattern;
    // 다 as the ending itself (~ㄴ/는다) is. If dropping it leaves only the
    // dummy stem, the 다 WAS the pattern (~다): read it as a connective.
    if (endsDa && seg.length > 1 && seg[seg.length - 1].raw === '다' && ['V', 'X'].includes(seg[seg.length - 2].c)) {
      const trimmed = seg.slice(0, -1);
      const onlyDummies = trimmed.every(t => dummies.includes(t.raw) && (t.c === 'V' || t.c === 'N'));
      seg = onlyDummies ? inPhrase(morphemes(`${phrase} 그래요.`, analyse)) : trimmed;
    }
    let cur = [], stems = 0;
    seg.forEach((t, i) => {
      if (dummies.includes(t.raw) && (t.c === 'V' || t.c === 'N')) {
        stems++;
        if (cur.length) { segs.push(cur); cur = []; }
        if (i > 0) segs.push(null);
        return;
      }
      cur.push({ f: t.f, c: t.c });
    });
    if (cur.length) segs.push(cur);
    if (stems !== dummies.length) ok = false;
    run = [];
  };
  for (const w of words) { if (w === null) { flush(); segs.push(null); } else run.push(w); }
  flush();
  if (!ok || !segs.some(s => s && s.length)) return null;
  while (segs.length && segs[segs.length - 1] === null) segs.pop();
  return segs.filter((s, i) => !(s === null && segs[i - 1] === null));
}
// A form written with ~ may join a verb (~는 바람에) or a noun (~답다,
// ~까지). Both are tried when the verb reading fails or leaves a stray noun
// that the title never wrote (받답다 read as 받 + 답/noun + 다).
function readingSkeleton(reading, analyse) {
  const asVerb = skeletonFor(reading, 'verb', analyse);
  if (!reading.some(t => t.kind === 'attach')) return asVerb;
  const written = new Set(reading.filter(t => t.kind === 'word').map(t => (t.text.endsWith('다') ? t.text.slice(0, -1) : t.text)));
  const stray = (sk) => sk.filter(Boolean).flat().some(m => m.c === 'N' && ![...written].some(w => w.includes(m.f) || m.f.includes(w)));
  if (asVerb && !stray(asVerb)) return asVerb;
  const asNoun = skeletonFor(reading, 'noun', analyse);
  if (asNoun && (!asVerb || !stray(asNoun))) return asNoun;
  return asVerb;
}
const skeletonSize = (sk) => sk.reduce((n, seg) => n + (seg ? seg.length : 0), 0);
export const skeletonText = (sk) => sk.map(seg => (seg === null ? '…' : seg.map(m => `${m.f}/${m.c}`).join('+'))).join(' ');
// The same, for showing to a person: "ㄹ + 수 + 있", "든지 … 든지".
export const skeletonLabel = (sk) => sk.map(seg => (seg === null ? '…' : seg.map(m => m.f).join(' + '))).join(' ');

// What an entry is recognised by: its hint if it has one, else its title
// (decision GS-D3).
export const entryPattern = (entry) => String(entry?.patternHint || '').trim() || String(entry?.glossaryTerm || '').trim();

// Two-syllable-or-longer nouns are read as bound or free from one context to
// the next (마련, 이상, 정도); 하/되 as verb or suffix. Single-syllable bound
// nouns (수, 지, 적, 것) must stay exact: 수 "number" is not 수 "can".
const NOUNISH = new Set(['N', 'B']), VERBISH = new Set(['V', 'X']);
const sameMorpheme = (a, b) => a.f === b.f && (a.c === b.c
  || (NOUNISH.has(a.c) && NOUNISH.has(b.c) && chars(a.f).length >= 2)
  || (VERBISH.has(a.c) && VERBISH.has(b.c)));

// Where a skeleton sits in a sentence's morphemes: { from, to } (indexes,
// inclusive) or null. Between two morphemes of one segment the sentence may
// carry up to two particles or adverbs the pattern doesn't mention
// (적이 있다, 면 안 되다); at a gap, one to six morphemes.
const MAX_GAP = 6, MAX_SKIPPED = 2;
// Some words are in the analyser's dictionary whole, so the pattern is
// inside one morpheme instead of beside it:
//   a suffix   갑작스럽 for ~스럽다, 아름답 for ~답다
//   an auxiliary on 아/어   좋아하 for ~아/어하다, 쉬워지 for ~아/어지다
const hasSuffix = (m, tok) => m.c === 'X' && tok.c === 'V' && tok.raw !== m.f && tok.raw.endsWith(m.f);
const FUSED_AUX = new Set(['하', '지']);
function isFusedAux(first, second, tok) {
  if (!(first.c === 'E' && first.f === '어' && second && second.c === 'V' && FUSED_AUX.has(second.f) && tok.c === 'V')) return false;
  const cs = chars(tok.raw);
  if (cs.length < 3 || cs[cs.length - 1] !== second.f || !isSyllable(cs[cs.length - 2])) return false;
  const [, vowel, final] = splitSyllable(cs[cs.length - 2]);
  return final === 0 && FUSED_VOWELS.includes(vowel);
}
const fits = (m, tok) => sameMorpheme(m, tok) || hasSuffix(m, tok);
function matchSkeleton(sk, toks) {
  const tryAt = (si, ti) => {
    if (si === sk.length) return ti - 1;
    const seg = sk[si];
    if (seg === null) {
      for (let g = 1; g <= MAX_GAP; g++) { const end = tryAt(si + 1, ti + g); if (end !== null) return end; }
      return si === 0 ? tryAt(si + 1, ti) : null;
    }
    let p = ti, skipped = 0;
    for (let k = 0; k < seg.length; k++) {
      if (toks[p] && isFusedAux(seg[k], seg[k + 1], toks[p])) { p++; k++; continue; }
      while (k > 0 && toks[p] && !fits(seg[k], toks[p]) && (toks[p].c === 'J' || toks[p].c === 'M') && skipped < MAX_SKIPPED) { p++; skipped++; }
      if (!toks[p] || !fits(seg[k], toks[p])) return null;
      p++;
    }
    return tryAt(si + 1, p);
  };
  for (let i = 0; i < toks.length; i++) {
    const end = tryAt(0, i);
    if (end !== null) return { from: i, to: Math.max(i, end) };
  }
  return null;
}

// ── Compile ───────────────────────────────────────────────────
// entries: [{ id, pattern }] where pattern is the entry's hint if it has
// one, else its title. Each compiled entry:
//   kind       'topic'    no form to recognise
//              'single'   every reading is one morpheme (~을/를, ~게, but
//                         also ~자마자, ~느라고)
//              'specific' at least one reading of two or more morphemes
//              'unread'   has a form, but no skeleton could be made from it
//   skeletons  [{ parts, size, text }]   size = how many morphemes
//   surface    [RegExp]   only for distinctive readings
// One-morpheme readings are only looked for when asked (findPatterns'
// opts.single), whether the entry is 'single' or mixed (못 / ~지 못하다).
export function compilePatterns(entries, analyse) {
  return (entries || []).map(({ id, pattern }) => {
    const alternatives = patternAlternatives(pattern);
    if (!alternatives) return { id, pattern, kind: 'topic', skeletons: [], surface: [] };
    const readings = alternatives.flatMap(patternReadings);
    const seen = new Set(), skeletons = [], surface = [];
    for (const reading of readings) {
      let parts = null;
      try { parts = readingSkeleton(reading, analyse); } catch { parts = null; }
      if (parts) {
        const text = skeletonText(parts);
        if (!seen.has(text)) { seen.add(text); skeletons.push({ parts, size: skeletonSize(parts), text }); }
      }
      if (isDistinctive(reading)) { try { surface.push(surfaceRegex(reading)); } catch { /* not expressible; the skeleton still stands */ } }
    }
    const kind = !skeletons.length ? (surface.length ? 'specific' : 'unread')
      : skeletons.every(s => s.size < 2) ? 'single' : 'specific';
    skeletons.sort((a, b) => b.size - a.size);
    return { id, pattern, kind, skeletons, surface };
  });
}

// ── Find ──────────────────────────────────────────────────────
// Which compiled entries a sentence shows. Each hit:
//   { id, by: 'morphemes' | 'surface', from, to, size }
// from/to are character offsets in the sentence (whole words), for marking
// the matched part.
//   opts.single   one-morpheme readings are looked for only for the entry
//                 ids in this Set, or for every entry when it is 'all'
//                 (GS-D3's switch). None by default.
// Most specific wins: a hit whose morphemes all belong to a larger hit on
// the same stretch is dropped (~ㄹ/을 수 있다 inside ~ㄹ/을 수도 있다).
// Entries of the same size on the same morphemes are all kept: they share
// a form.
const flat = (parts) => parts.filter(Boolean).flat();
const isSubsequence = (small, big) => {
  let i = 0;
  for (const m of big) if (i < small.length && sameMorpheme(small[i], m)) i++;
  return i === small.length;
};
export function findPatterns(sentence, compiled, analyse, opts = {}) {
  const text = String(sentence || '');
  if (!hasHangul(text)) return [];
  const toks = morphemes(text, analyse);
  const wantsSingle = (id) => opts.single === 'all' || !!(opts.single && opts.single.has && opts.single.has(id));
  const hits = [];
  for (const c of compiled) {
    if (c.kind === 'topic' || c.kind === 'unread') continue;
    const single = wantsSingle(c.id);
    let best = null;
    for (const sk of c.skeletons) {            // largest first
      if (sk.size < 2 && !single) continue;
      const m = matchSkeleton(sk.parts, toks);
      if (m) { best = { id: c.id, by: 'morphemes', from: toks[m.from].start, to: toks[m.to].end, size: sk.size, span: m, parts: sk.parts }; break; }
    }
    if (!best) {
      for (const re of c.surface) {
        const m = re.exec(text);
        if (m) { best = { id: c.id, by: 'surface', from: m.index, to: m.index + m[0].length, size: 0 }; break; }
      }
    }
    if (best) hits.push(best);
  }
  return hits
    .filter(h => h.by !== 'morphemes' || !hits.some(o => o !== h && o.by === 'morphemes' && o.size > h.size
      && o.span.from <= h.span.from && o.span.to >= h.span.to && isSubsequence(flat(h.parts), flat(o.parts))))
    .map(({ id, by, from, to, size }) => ({ id, by, from, to, size }));
}
