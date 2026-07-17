// src/utils/ttsUtils.js
// Client-side utilities for generating and playing TTS audio on flashcards.
// Generation calls the generate-tts Netlify function (which caches in GCS).
// Playback speed is applied client-side via HTMLMediaElement.playbackRate.

import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase.js';

// ── Session cache ─────────────────────────────────────────────
// Avoids calling the function twice for the same text within a session.
const urlCache = new Map();

async function fetchAudioUrl(text) {
  const key = text.trim();
  if (urlCache.has(key)) return urlCache.get(key);

  const res = await fetch('/api/generate-tts', {
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

export async function generateVocabCardAudio({ lemma, cardId, uid }) {
  if (!lemma?.trim() || !cardId || !uid) return;
  try {
    const audioUrl = await fetchAudioUrl(lemma);
    await updateDoc(doc(db, 'users', uid, 'flashcards', cardId), { audioUrl });
  } catch (err) {
    console.error('generateVocabCardAudio failed:', err);
  }
}

export async function generateSentenceCardAudio({ lemma, sentence, cardId, uid }) {
  if (!cardId || !uid) return;
  try {
    const updates = {};
    if (lemma?.trim())    updates.audioUrl         = await fetchAudioUrl(lemma);
    if (sentence?.trim()) updates.sentenceAudioUrl = await fetchAudioUrl(sentence);
    if (Object.keys(updates).length > 0) {
      await updateDoc(doc(db, 'users', uid, 'flashcards', cardId), updates);
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

export async function backfillCardAudio({ cards, uid, onProgress, signal }) {
  const eligible = (cards || []).filter(c => {
    if (c.type === 'grammar') return !c.exampleAudio?.length && !!c.examples?.trim();
    return !c.audioUrl;
  });

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
