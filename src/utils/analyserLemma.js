// src/utils/analyserLemma.js
// A dictionary form read off the Korean analyser's morphemes: the lemma
// resolver's second opinion (LM4).
//
// The rules in aviUtils.js peel endings they have been taught; the analyser
// (src/utils/koreanAnalyser.js, the one grammar sightings uses) knows the
// endings as a system and has a lexicon, so it reads forms the rules were
// never taught. It is weaker where the rules are strong (ㄷ/ㅅ irregulars,
// plurals, 깨나) and it can misread a word on its own (가니 as a name), so
// its reading is only ever one more candidate for the dictionary check,
// ranked after the rules' own first answer. See resolveLemmaDetailed.
//
// Pure: the analyser is passed in. Wired up in lemmaSecondOpinion.js.

const NOUN = new Set(['NNG', 'NNP', 'NNB', 'NR', 'NP', 'XR', 'SL', 'SH', 'SN']);
const VERB = new Set(['VV', 'VA', 'VX', 'VCN']);
const ADVERB = new Set(['MAG', 'MAJ', 'MM', 'IC']);
const isMark = (pos) => /^S[FPSEOW]$/.test(pos || '');
const hangul = (s) => /[가-힣]/.test(s || '');

const EDGE = /^[\s‘’“”"'`「『〈《]+|[\s‘’“”"'`」』〉》.,:;?!~…·・、。，．！？：；～]+$/g;
const tidy = (s) => String(s || '').trim().replace(EDGE, '').replace(EDGE, '');

// The morphemes of one written word → its dictionary forms, likeliest
// first ([] when the analysis says nothing useful).
//   verb or adjective stem            하/VV + 느라고        → 하다
//   noun (+ noun…) + 하다/되다/스럽다   공부/NNG + 하/XSV     → 공부하다
//   noun, with the plural 들 dropped   친구/NNG + 들/XSN     → 친구
//   adverb + verb written solid       다시/MAG + 보/VV      → 보다
//   못/안 + 하다/되다                   못/MAG + 하/XSV       → 못하다
export function readingsFromTokens(tokens) {
  const t = (tokens || []).filter(x => x && x.text && !isMark(x.pos));
  if (!t.length) return [];
  let i = 0;
  let prefix = '';
  if (t[0].pos === 'XPN' && t[1]) { prefix = t[0].text; i = 1; }
  const f = t[i];
  if (VERB.has(f.pos)) return hangul(f.text) ? [prefix + f.text + '다'] : [];
  if (ADVERB.has(f.pos)) {
    const next = t[i + 1];
    if (next && (next.pos === 'XSV' || next.pos === 'XSA')) return [prefix + f.text + next.text + '다'];
    if (next && VERB.has(next.pos) && hangul(next.text)) return [next.text + '다', prefix + f.text];
    return [prefix + f.text];
  }
  if (NOUN.has(f.pos)) {
    let noun = prefix + f.text;
    i++;
    while (t[i] && (NOUN.has(t[i].pos) || t[i].pos === 'XSN')) {
      if (t[i].pos === 'XSN' && t[i].text === '들') { i++; break; }
      noun += t[i].text;
      i++;
    }
    if (t[i] && (t[i].pos === 'XSV' || t[i].pos === 'XSA')) return [noun + t[i].text + '다', noun];
    return hangul(noun) ? [noun] : [];
  }
  return [];
}

// The analyser's morphemes for `surface`: read inside `context` (the
// sentence it came from) when the word can be found there, which settles
// what a lone word leaves open (가니 the name or 가다), otherwise alone.
export function wordTokens(analyse, surface, context) {
  const word = tidy(surface);
  if (!word || !hangul(word) || /\s/.test(word)) return [];
  const sentence = String(context || '');
  const at = sentence ? sentence.indexOf(word) : -1;
  if (at >= 0) {
    const all = analyse(sentence) || [];
    const inWord = all.filter(x => typeof x.start === 'number' && x.start <= at && at < x.end);
    if (inWord.length) return inWord;
  }
  return analyse(word) || [];
}

export function analyserReadings(analyse, surface, context) {
  const word = tidy(surface);
  return readingsFromTokens(wordTokens(analyse, surface, context)).filter(r => r && r !== word);
}
