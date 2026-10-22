// src/utils/ttsUtils.js
// Client-side utilities for generating and playing TTS audio on flashcards.
// Generation calls the generate-tts Netlify function (which caches in GCS).
// Playback speed is applied client-side via HTMLMediaElement.playbackRate.

import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase.js';
import { apiFetch } from './apiFetch.js';
import { spokenLemma } from './spokenText.js';

// What a word card says (Echo X4, X-D12): parentheses dropped with their words
// read, slash and two-part forms read as both words.
const sayLemma = (lemma) => spokenLemma(lemma) || String(lemma || '').trim();

// ── Session cache ─────────────────────────────────────────────
// Avoids calling the function twice for the same text within a session.
const urlCache = new Map();

async function fetchAudioUrl(text) {
  const key = text.trim();
  if (urlCache.has(key)) return urlCache.get(key);

  const res = await apiFetch('/api/generate-tts', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ text: key }),
  });

  if (!res.ok) throw new Error(`TTS function returned ${res.status}`);
  const { url } = await res.json();
  urlCache.set(key, url);
  return url;
}

// ── Cache pre-warming ─────────────────────────────────────────
// Generate (and GCS-cache) audio for arbitrary text without a card to
// attach it to. Used by the Import tab's auto-TTS queue so audio is
// already cached when cards materialize later. Errors are swallowed —
// pre-warming is best-effort by design.
export async function prewarmTtsAudio(text) {
  if (!text || !String(text).trim()) return null;
  try { return await fetchAudioUrl(String(text)); } catch { return null; }
}

// ── Card-type generators ──────────────────────────────────────
// All are called fire-and-forget after card creation (no await at call site).

// A8: onComplete(updates), if given, runs once the audio is saved, so the
// caller can put it on the in-memory card (cards load once per day, so a
// card made today otherwise had no audio button until a reload). It runs
// as soon as the URL is known: offline, the Firestore write settles only
// when the connection is back, but it is already kept on the device.
export async function generateVocabCardAudio({ lemma, cardId, uid, onComplete }) {
  if (!lemma?.trim() || !cardId || !uid) return;
  try {
    const audioUrl = await fetchAudioUrl(sayLemma(lemma));
    const write = updateDoc(doc(db, 'users', uid, 'flashcards', cardId), { audioUrl });
    onComplete?.({ audioUrl });
    await write;
  } catch (err) {
    console.error('generateVocabCardAudio failed:', err);
  }
}

export async function generateSentenceCardAudio({ lemma, sentence, cardId, uid, onComplete }) {
  if (!cardId || !uid) return;
  try {
    const updates = {};
    if (lemma?.trim())    updates.audioUrl         = await fetchAudioUrl(sayLemma(lemma));
    if (sentence?.trim()) updates.sentenceAudioUrl = await fetchAudioUrl(sentence);
    if (Object.keys(updates).length > 0) {
      const write = updateDoc(doc(db, 'users', uid, 'flashcards', cardId), updates);
      onComplete?.(updates);
      await write;
    }
  } catch (err) {
    console.error('generateSentenceCardAudio failed:', err);
  }
}

// Examples are stored as a multi-line block, one sentence per line. Each line
// gets its own TTS clip so the card can offer per-sentence playback rather
// than one clip for the whole block. Clears the legacy single-clip `audioUrl`
// field, which this card type no longer uses.
// onComplete(exampleAudio), if provided, fires after the Firestore write
// succeeds so callers can patch in-memory card state immediately rather than
// waiting for the next reload (cards load once via getDocs, not a live
// listener, so this write wouldn't otherwise reach local state this session).
export async function generateGrammarCardAudio({ examples, cardId, uid, onComplete }) {
  if (!cardId || !uid) return;
  const sentences = (examples || '').split('\n').map(s => s.trim()).filter(Boolean);
  if (!sentences.length) {
    try {
      await updateDoc(doc(db, 'users', uid, 'flashcards', cardId), { audioUrl: null, exampleAudio: [] });
      onComplete?.([]);
    } catch (err) {
      console.error('generateGrammarCardAudio (clear) failed:', err);
    }
    return;
  }
  try {
    const exampleAudio = [];
    for (const text of sentences) {
      const url = await fetchAudioUrl(text);
      exampleAudio.push({ text, url });
    }
    await updateDoc(doc(db, 'users', uid, 'flashcards', cardId), { audioUrl: null, exampleAudio });
    onComplete?.(exampleAudio);
  } catch (err) {
    console.error('generateGrammarCardAudio failed:', err);
  }
}

// One-time refresh (X-D16): re-records a word or sentence card's word audio
// in the spoken form. Returns the new URL (or null on failure).
export async function regenerateLemmaAudio({ card, uid }) {
  const word = card?.type === 'sentence' ? card.lemma : card?.front;
  if (!word?.trim() || !card?.id || !uid) return null;
  try {
    const audioUrl = await fetchAudioUrl(sayLemma(word));
    await updateDoc(doc(db, 'users', uid, 'flashcards', card.id), { audioUrl });
    return audioUrl;
  } catch (err) {
    console.error('regenerateLemmaAudio failed:', err);
    return null;
  }
}

// ── A8: does a card's word audio say its word? ────────────────
// generate-tts stores each clip as tts/<first 16 hex of sha256(text)>.mp3,
// so the file name tells which text it was made from. Returns true when it
// matches the word's spoken form, false when it doesn't, null when it can't
// tell (no audio, or no Web Crypto).
async function ttsFileKey(text) {
  const t = String(text || '').trim();
  if (!t || typeof crypto === 'undefined' || !crypto.subtle) return null;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

export async function wordAudioMatches(card) {
  const word = card?.type === 'sentence' ? card?.lemma : card?.front;
  if (!card?.audioUrl || !word?.trim()) return null;
  const key = await ttsFileKey(sayLemma(word));
  if (!key) return null;
  const m = /\/tts\/([0-9a-f]+)\.mp3/.exec(card.audioUrl);
  return m ? m[1] === key : null;
}

// A8: after cards are renamed, their word audio is re-recorded for the new
// word (Lemma Master rename, Word Input correction, merge, sentence
// retarget all rename through updateLinkedCards). Only cards whose spoken
// word actually changed are touched; the in-memory cards follow.
export async function refreshRenamedCardAudio({ cards, uid, updateCards }) {
  if (!uid) return;
  for (const card of cards || []) {
    if (!card?.id || card.type === 'grammar') continue;
    const word = card.type === 'sentence' ? card.lemma : card.front;
    if (!word?.trim()) continue;
    try {
      const audioUrl = await fetchAudioUrl(sayLemma(word));
      if (audioUrl === card.audioUrl) continue;
      const write = updateDoc(doc(db, 'users', uid, 'flashcards', card.id), { audioUrl });
      if (updateCards) {
        updateCards(prev => (prev ? prev.map(c => (c.id === card.id ? { ...c, audioUrl } : c)) : prev));
      }
      await write;
    } catch (err) {
      console.error('refreshRenamedCardAudio failed:', card.id, err);
    }
  }
}

// Audio for a Korean word without a card (Echo X4, X-D15): the spoken form,
// generated and cached server-side like prewarmTtsAudio. Null on failure.
export async function wordAudioUrl(lemma) {
  const say = sayLemma(lemma);
  if (!say) return null;
  try { return await fetchAudioUrl(say); } catch { return null; }
}

// ── Playback ──────────────────────────────────────────────────
// Plays the audio clips for a card sequentially.
// Sentence cards play word first, then full sentence.
// ttsSpeed is applied via playbackRate (browser pitch-corrected — no file regeneration needed).
// Returns { promise, cancel } so the caller can stop playback on card advance.

// Plays a single audio URL. Returns { promise, cancel } — the shared building
// block behind both whole-card playback and individual example-sentence playback.
export function playAudioUrl(url, ttsSpeed = 0.9) {
  let audio = null;

  const promise = new Promise((resolve, reject) => {
    audio = new Audio(url);
    audio.playbackRate = ttsSpeed;
    audio.onended = resolve;
    audio.onerror = () => reject(new Error(`Audio load failed: ${url}`));
    audio.play().catch(reject);
  });

  return {
    promise,
    cancel() {
      if (audio) { audio.pause(); audio = null; }
    },
  };
}

export function playCardAudio(card, ttsSpeed = 0.9) {
  const urls = [];
  if (card.type === 'sentence') {
    if (card.audioUrl)         urls.push(card.audioUrl);
    if (card.sentenceAudioUrl) urls.push(card.sentenceAudioUrl);
  } else {
    if (card.audioUrl) urls.push(card.audioUrl);
  }

  if (urls.length === 0) return { promise: Promise.resolve(), cancel: () => {} };

  let cancelled    = false;
  let activeCancel = null;

  const promise = (async () => {
    for (const url of urls) {
      if (cancelled) break;
      const { promise: clipPromise, cancel: clipCancel } = playAudioUrl(url, ttsSpeed);
      activeCancel = clipCancel;
      await clipPromise;
    }
  })();

  return {
    promise,
    cancel() {
      cancelled = true;
      activeCancel?.();
    },
  };
}

// ── Backfill ──────────────────────────────────────────────────
// Generates missing audio for all eligible cards, processed one at a time.
// Grammar cards are included only when their examples field is populated.
// onProgress(done, total) fires after each card.
// Pass an AbortSignal via `signal` to support cancellation.

// A card the backfill would generate audio for: a grammar card with example
// sentences and no example audio; any other card without audioUrl. Settings'
// "N cards missing audio" uses the same rule (bug sweep N7: it still read
// grammar examples from the old `notes` field and grammar audio from
// audioUrl, so its count disagreed with what the backfill would do).
export function cardNeedsAudio(c) {
  if (!c) return false;
  if (c.type === 'grammar') return !c.exampleAudio?.length && !!c.examples?.trim();
  return !c.audioUrl;
}

export async function backfillCardAudio({ cards, uid, onProgress, signal }) {
  const eligible = (cards || []).filter(cardNeedsAudio);

  const total = eligible.length;
  let done = 0;
  onProgress?.(0, total);

  for (const card of eligible) {
    if (signal?.aborted) break;
    try {
      if (card.type === 'sentence') {
        await generateSentenceCardAudio({ lemma: card.lemma, sentence: card.sentence, cardId: card.id, uid });
      } else if (card.type === 'grammar') {
        await generateGrammarCardAudio({ examples: card.examples, cardId: card.id, uid });
      } else {
        await generateVocabCardAudio({ lemma: card.front, cardId: card.id, uid });
      }
    } catch (err) {
      console.error(`Backfill: card ${card.id} failed`, err);
    }
    done++;
    onProgress?.(done, total);
    // Brief pause to avoid overwhelming the Netlify function concurrency limit.
    await new Promise(r => setTimeout(r, 150));
  }
}
