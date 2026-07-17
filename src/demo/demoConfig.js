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
