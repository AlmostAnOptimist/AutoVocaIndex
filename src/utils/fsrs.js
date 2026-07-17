// src/utils/fsrs.js
// FSRS-5 spaced repetition algorithm.
// Reference weights: open-spaced-repetition/fsrs5 (published defaults).
// Replaces sm2.js — update every import that references sm2.js to point here.

import { getLogicalDateStr } from './dateUtils.js';

// ── Published FSRS-5 default weights (w0–w18) ─────────────────
const W = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925,
  1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
];

// Power-law forgetting curve constants (from the FSRS-5 spec)
const FACTOR = 19 / 81; // F
const DECAY  = -0.5;    // C

// ── Rating constants ──────────────────────────────────────────
export const AGAIN = 1;
export const HARD  = 2;
export const GOOD  = 3;
export const EASY  = 4;

// ── Default settings (mirrors SettingsPage defaults) ──────────
export const FSRS_DEFAULTS = {
  desiredRetention:   0.9,
  maximumInterval:    1095, // 3 years
  graduatingInterval: 1,
  easyInterval:       3,
  againCap:           2,
};

// ── Core math ─────────────────────────────────────────────────

// Recall probability after t days with stability s.
function retrievability(t, s) {
  return Math.pow(1 + FACTOR * (t / s), DECAY);
}

// Next interval (days) given desired retention r_d and stability s.
// When r_d = 0.9, this equals s exactly — an elegant property of the chosen constants.
function computeInterval(r_d, s) {
  return (s / FACTOR) * (Math.pow(r_d, 1 / DECAY) - 1);
}

// Initial stability for a brand-new card's first review.
function initialStability(rating) {
  switch (rating) {
    case AGAIN: return W[0]; // ~0.40 days
    case HARD:  return W[1]; // ~1.18 days
    case GOOD:  return W[2]; // ~3.17 days
    case EASY:  return W[3]; // ~15.69 days
    default:    return W[2];
  }
}

// Initial difficulty for a brand-new card's first review.
function initialDifficulty(rating) {
  return clampD(W[4] - Math.exp(W[5] * (rating - 1)) + 1);
}

// Updated difficulty after a repeat review.
function nextDifficulty(d, rating) {
  const meanReversion = W[7] * initialDifficulty(EASY) + (1 - W[7]) * shiftDifficulty(d, rating);
  return clampD(meanReversion);
}

function shiftDifficulty(d, rating) {
  return d + (-W[6] * (rating - 3)) * ((10 - d) / 9);
}

function clampD(d) {
  return Math.min(10, Math.max(1, d));
}

// Stability after a successful review (Hard, Good, or Easy).
function stabilitySuccess(d, s, r, rating) {
  const hardPenalty = rating === HARD ? W[15] : 1;
  const easyBonus   = rating === EASY ? W[16] : 1;
  return s * (
    1 +
    Math.exp(W[8]) *
    (11 - d) *
    Math.pow(s, -W[9]) *
    (Math.exp(W[10] * (1 - r)) - 1) *
    hardPenalty *
    easyBonus
  );
}

// Stability after a failed review (Again / lapse). Cannot exceed current stability.
function stabilityFailure(d, s, r) {
  const raw = W[11] *
    Math.pow(d, -W[12]) *
    (Math.pow(s + 1, W[13]) - 1) *
    Math.exp(W[14] * (1 - r));
  return Math.min(raw, s);
}

// ── Due date utilities ────────────────────────────────────────
// Cards may have either:
//   card.due         — ISO timestamp string (FSRS, new format)
//   card.nextDueDate — YYYY-MM-DD string    (SM-2 legacy)

function getDueMs(card) {
  const raw = card.due || card.nextDueDate;
  if (!raw) return null;
  if (raw.length === 10) {
    // YYYY-MM-DD — treat as start of day in local time
    return new Date(raw + 'T00:00:00').getTime();
  }
  return new Date(raw).getTime();
}

// Returns the due date as a YYYY-MM-DD string in LOCAL time, regardless of format.
// Used by the daily pipeline for date-string comparisons.
export function getDueDateStr(card) {
  const raw = card.due || card.nextDueDate;
  if (!raw) return null;
  if (raw.length === 10) return raw; // already a YYYY-MM-DD string (SM-2, grammar)
  // ISO timestamp: extract local date to avoid UTC/local mismatch
  // e.g. midnight KST = 15:00 previous day UTC, so raw.slice(0,10) gives the wrong date.
  const d = new Date(raw);
  const yr  = d.getFullYear();
  const mo  = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${yr}-${mo}-${day}`;
}

// Days elapsed since the card was last reviewed.
function daysSinceLastReview(card) {
  const raw = card.lastReview || card.lastReviewed;
  if (!raw) return 0;
  return Math.max(0, (Date.now() - new Date(raw).getTime()) / 86_400_000);
}

// ── Public card state helpers ─────────────────────────────────

export function isNewCard(card) {
  if (card.state === 'new') return true;
  if (card.state)           return false; // has a state but it is not 'new'
  // Legacy SM-2 card: no state field — infer from absence of any review history
  return !card.lastGrade && !card.lastReviewed && !card.reps;
}

// A card is due if its local due date is on or before the logical today.
// Accepts dsh (day-start hour) to respect the day-flip setting; defaults to 3.
// All cards due at any time within the logical day are surfaced together at day start.
export function isDueToday(card, dsh = 3) {
  if (isNewCard(card)) return false;
  const dueDateStr = getDueDateStr(card);
  if (!dueDateStr) return false;
  return dueDateStr <= getLogicalDateStr(dsh);
}

// ── Triage helpers (daily pipeline) ──────────────────────────
// Extended to handle both FSRS fields and SM-2 legacy fields.

export function triageBucket(card) {
  const isFSRS = !!card.stability;
  if (isFSRS) {
    const d   = card.difficulty ?? 5;
    const s   = card.stability  ?? 1;
    const lap = card.lapses     ?? 0;
    if (lap > 3 || d > 7 || s < 2) return 'now';
    if (d < 4 && s > 21)            return 'defer';
    return 'soon';
  } else {
    // SM-2 legacy
    const ef  = card.easeFactor   ?? 2.5;
    const rep = card.repetitions  ?? 0;
    if (ef < 1.8 || rep < 3)             return 'now';
    if (ef >= 2.4 && card.interval > 14) return 'defer';
    return 'soon';
  }
}

export function compressInterval(card) {
  const isFSRS = !!card.stability;
  if (isFSRS) {
    const s     = card.stability || 1;
    const ratio = Math.min(1, s / 30);
    const newS  = Math.max(1, parseFloat((s * ratio * 0.7).toFixed(4)));
    const next  = new Date();
    next.setDate(next.getDate() + Math.round(newS));
    return {
      stability:      newS,
      due:            next.toISOString(),
      triageBucket:   'defer',
      lastTriageDate: new Date().toISOString().split('T')[0],
    };
  } else {
    // SM-2 legacy
    const iv    = card.interval || 1;
    const ratio = Math.min(1, iv / 30);
    const newIv = Math.max(1, Math.round(iv * ratio * 0.7));
    const next  = new Date();
    next.setDate(next.getDate() + newIv);
    return {
      interval:       newIv,
      nextDueDate:    next.toISOString().split('T')[0],
      triageBucket:   'defer',
      lastTriageDate: new Date().toISOString().split('T')[0],
    };
  }
}

// ── Main grading function ─────────────────────────────────────
//
// card     — the current card object (SM-2, FSRS, or unreviewed — all handled)
// rating   — AGAIN | HARD | GOOD | EASY
// settings — from data.settings.fsrs (falls back to FSRS_DEFAULTS for each key)
//
// Returns a plain object of updated fields to write to Firestore.
// Never mutates the input card.

export function fsrsGrade(card, rating, settings = {}) {
  const {
    desiredRetention   = FSRS_DEFAULTS.desiredRetention,
    maximumInterval    = FSRS_DEFAULTS.maximumInterval,
    graduatingInterval = FSRS_DEFAULTS.graduatingInterval,
    easyInterval       = FSRS_DEFAULTS.easyInterval,
  } = settings;

  const now   = new Date();
  const state = card.state || 'new';
  const isNew = isNewCard(card);

  let stability, difficulty, newState, intervalDays;

  // ── New card: first ever review ────────────────────────────
  if (isNew) {
    stability  = initialStability(rating);
    difficulty = initialDifficulty(rating);

    if (rating === AGAIN) {
      newState     = 'learning';
      intervalDays = 0; // due immediately; handled by again-queue / carry-over
    } else if (rating === EASY) {
      newState     = 'review';
      intervalDays = easyInterval;
    } else {
      // Hard or Good: graduate with the standard short first interval
      newState     = 'review';
      intervalDays = graduatingInterval;
    }

  // ── Learning / relearning: not yet in stable review state ─
  } else if (state === 'learning' || state === 'relearning') {
    difficulty = nextDifficulty(card.difficulty || initialDifficulty(rating), rating);

    if (rating === AGAIN) {
      newState     = state; // stay in learning / relearning
      stability    = W[0];  // reset to minimum Again stability
      intervalDays = 0;
    } else {
      newState = 'review';
      if (card.stability) {
        const t   = daysSinceLastReview(card);
        const r   = retrievability(Math.max(t, 0.1), card.stability);
        stability = stabilitySuccess(difficulty, card.stability, r, rating);
      } else {
        stability = initialStability(rating);
      }
      const computed = Math.round(computeInterval(desiredRetention, stability));
      intervalDays = Math.min(
        Math.max(rating === EASY ? easyInterval : graduatingInterval, computed),
        maximumInterval
      );
    }

  // ── Review card: standard spaced repetition ────────────────
  } else {
    const t   = daysSinceLastReview(card);
    const r   = retrievability(Math.max(t, 0.1), card.stability || 1);
    difficulty = nextDifficulty(card.difficulty || 5, rating);

    if (rating === AGAIN) {
      newState     = 'relearning';
      stability    = stabilityFailure(card.difficulty || 5, card.stability || 1, r);
      intervalDays = 0;
    } else {
      newState     = 'review';
      stability    = stabilitySuccess(card.difficulty || 5, card.stability || 1, r, rating);
      const computed = Math.round(computeInterval(desiredRetention, stability));
      intervalDays = Math.min(Math.max(1, computed), maximumInterval);
    }
  }

  // ── Compute next due timestamp ─────────────────────────────
  let due;
  if (intervalDays === 0) {
    // Due immediately — 1 second in the past so it always reads as overdue.
    // This handles again-queue carry-over: if the session ends before this
    // card is resolved, it surfaces at the very start of the next session.
    due = new Date(now.getTime() - 1000).toISOString();
  } else {
    const d = new Date(now);
    d.setDate(d.getDate() + intervalDays);
    d.setHours(0, 0, 0, 0);
    due = d.toISOString();
  }

  return {
    state:      newState,
    stability:  parseFloat((stability || W[0]).toFixed(4)),
    difficulty: parseFloat((difficulty || 5).toFixed(4)),
    due,
    lastReview: now.toISOString(),
    lapses:     rating === AGAIN ? (card.lapses || 0) + 1 : (card.lapses || 0),
    reps:       (card.reps || 0) + 1,
  };
}
