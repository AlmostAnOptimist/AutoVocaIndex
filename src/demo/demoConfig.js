// src/demo/demoConfig.js
// Single switch for the hosted demo (D4) plus tier caps (D5/D12).
// The template ships with demo mode OFF. The hosted demo deploy sets
// VITE_DEMO_MODE=true and VITE_DEMO_TIER=beta|public in the Netlify env.
// Netlify functions read the separate non-VITE DEMO_MODE env var, since
// VITE_-prefixed vars are client-bundle-only.

export const DEMO = import.meta.env.VITE_DEMO_MODE === 'true';

export const DEMO_TIER =
  import.meta.env.VITE_DEMO_TIER === 'beta' ? 'beta' : 'public';

// Caps count USER-CREATED docs only — docs carrying seeded: true are
// excluded from every count. Grading is inert in demo (no writes), so it
// has no cap (D5 revised 2026-07-16).
export const DEMO_CAPS = DEMO_TIER === 'beta'
  ? { sentences: 10, wordsPerSentence: 3, cards: 40, quizSessions: 10, tasks: 10, appointments: 10 }
  : { sentences: 2,  wordsPerSentence: 3, cards: 8,  quizSessions: 2,  tasks: 2,  appointments: 2 };

export const DEMO_LIMIT_NOTE =
  'Demo limit reached — deploy your own AutoVocaIndex to go further.';

export const REPO_URL = 'https://github.com/AlmostAnOptimist/AutoVocaIndex';

// Link to the recorded walkthrough, shown on the capacity screen. Empty
// until a video is published; the link is hidden while it is empty.
export const DEMO_TOUR_URL = '';

// True when a Firestore call failed because the project's daily free-tier
// quota is used up (the demo runs on the Spark plan).
export function isQuotaError(e) {
  return e?.code === 'resource-exhausted' || /quota/i.test(e?.message || '');
}

// Firestore's free-tier quotas reset around midnight US Pacific time.
// Next midnight in America/Los_Angeles, as an absolute Date.
export function nextPacificMidnight(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', hourCycle: 'h23',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(now).map(p => [p.type, p.value])
  );
  const elapsedMs = ((Number(parts.hour) % 24) * 3600 + Number(parts.minute) * 60 + Number(parts.second)) * 1000;
  return new Date(now.getTime() - elapsedMs - now.getMilliseconds() + 24 * 3600 * 1000);
}

// ── Cap helpers (7C) ─────────────────────────────────────────
// Caps count docs LACKING seeded: true. Pass any doc array plus the
// DEMO_CAPS key; outside demo these always report "not reached".
export function nonSeededCount(arr) {
  return (arr || []).filter(d => d && !d.seeded).length;
}

export function demoCapReached(arr, capKey) {
  if (!DEMO) return false;
  const cap = DEMO_CAPS[capKey];
  if (typeof cap !== 'number') return false;
  return nonSeededCount(arr) >= cap;
}
