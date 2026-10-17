// src/utils/spokenText.js
// What text-to-speech should say for a Lemma Master lemma (Echo X4, X-D12).
//   (주먹을) 날리다      → 주먹을 날리다        parentheses dropped, their words read
//   입사(하다)           → 입사하다
//   보장하다 / 보장되다  → 보장하다, 보장되다   both words, a short pause between
//   지목하다/되다        → 지목하다, 지목되다   slash forms read as both words
// Used for flashcard audio (ttsUtils.js), Echo's audio prompts and Dictation
// answers (echoEngine.js). Pure; imports only jamoUtils.js.

import { expandSlashVariants } from './jamoUtils.js';

const nfc = (s) => String(s ?? '').normalize('NFC');

// The words to say, in order: one per two-part half and slash alternative.
export function spokenParts(lemma) {
  const s = nfc(lemma).trim();
  if (!s) return [];
  const out = [];
  for (const half of s.split(/\s+\/\s+/)) {
    const flat = half.replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
    if (!flat) continue;
    for (const v of expandSlashVariants(flat)) {
      const t = v.trim();
      if (t && !t.includes('/') && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

// One string for text-to-speech; the comma gives the pause between words.
export function spokenLemma(lemma) {
  return spokenParts(lemma).join(', ');
}

// Does the spoken form differ from the lemma as written? (Cards whose audio
// predates spokenLemma said the parentheses or slashes literally.)
export function needsSpokenRefresh(lemma) {
  return /[()/]/.test(nfc(lemma));
}
