// src/utils/fsrs.js
// FSRS-5 spaced repetition algorithm.
// Reference weights: open-spaced-repetition/fsrs5 (published defaults).
// Replaced sm2.js (removed, bug sweep P3).

import { getLogicalDateStr, getLogicalToday, toDateStr } from './dateUtils.js';

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
// Cards may have:
//   card.dueDay      — YYYY-MM-DD string: the day the card is due (SC-D6).
//                      Written with every grade and deferral since Nov 2026.
//                      A plain date has no time zone, so it reads the same
//                      wherever the device is. Read first when it is current.
//   card.dueDayFor   — the exact card.due that dueDay was written with. When
//                      the two differ, something changed `due` without
//                      knowing about dueDay (a tab still running older code,
//                      say); dueDay is then out of date and is ignored.
//   card.due         — ISO timestamp string (FSRS): local midnight of the due
//                      day in the zone it was written in. Still written with
//                      every grade; read when there is no current dueDay.
//   card.nextDueDate — YYYY-MM-DD string    (SM-2 legacy, grammar cards)

const isDay = (v) => typeof v === 'string' && v.length === 10;
const hasCurrentDueDay = (card) => isDay(card.dueDay) && !!card.due && card.dueDayFor === card.due;

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
  if (hasCurrentDueDay(card)) return card.dueDay;
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

// Days elapsed since the card was last reviewed (as of nowMs, default now).
function daysSinceLastReview(card, nowMs = Date.now()) {
  const raw = card.lastReview || card.lastReviewed;
  if (!raw) return 0;
  return Math.max(0, (nowMs - new Date(raw).getTime()) / 86_400_000);
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

// ── Logical-day due dates (bug sweep T1) ──────────────────────
// A due date is a logical day: the day-start hour (dsh) decides which day
// "today" is, exactly as isDueToday reads it. Counting from the wall-clock
// date instead put every review done between midnight and dsh one day late
// (1:30 AM on Oct 21 is still Oct 20; interval 1 must land on Oct 21).
// Returns local midnight of (logical today + days), as an ISO timestamp.
export function logicalDueISO(days, dsh = 3) {
  const d = getLogicalToday(dsh);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

// The logical day `days` from now, as a plain date.
export function logicalDayStr(days, dsh = 3) {
  const d = getLogicalToday(dsh);
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}

// ── Day load and interval spread (SC-D5) ──────────────────────
// How many cards are already due on each day: Map of 'YYYY-MM-DD' -> count.
// New and grammar cards don't count; `isSkipped` leaves out paused cards.
export function buildDueLoad(cards, isSkipped) {
  const load = new Map();
  for (const c of cards || []) {
    if (!c || c.type === 'grammar' || isNewCard(c)) continue;
    if (isSkipped && isSkipped(c)) continue;
    const day = getDueDateStr(c);
    if (day) load.set(day, (load.get(day) || 0) + 1);
  }
  return load;
}

// Cards with the same stability always earn the same interval, so they pile
// up on one day. An interval of a week or more may land a little either
// side of the computed day: within 5% of the interval, at least 1 day and at
// most 7. Shorter intervals are never moved.
export const SPREAD_MIN_INTERVAL = 7;
export function spreadWindow(interval) {
  if (!(interval >= SPREAD_MIN_INTERVAL)) return 0;
  return Math.min(7, Math.max(1, Math.round(interval * 0.05)));
}

// The interval to use: the day in the window with the fewest cards already
// due; on a tie the day closest to the computed one, then the earlier. No
// randomness, so the same deck always gives the same answer. Without a load
// map the interval comes back unchanged.
export function spreadInterval(interval, dueLoad, { dsh = 3, maximumInterval = FSRS_DEFAULTS.maximumInterval } = {}) {
  const w = spreadWindow(interval);
  if (!w || !dueLoad) return interval;
  let best = interval, bestLoad = Infinity, bestDist = Infinity;
  for (let delta = -w; delta <= w; delta++) {
    const days = interval + delta;
    if (days < 1 || days > maximumInterval) continue;
    const load = dueLoad.get(logicalDayStr(days, dsh)) || 0;
    const dist = Math.abs(delta);
    if (load < bestLoad || (load === bestLoad && dist < bestDist)) {
      best = days; bestLoad = load; bestDist = dist;
    }
  }
  return best;
}

// ── Daily triage (SC-D1 to SC-D3) ─────────────────────────────
// Relief for a day with more due than the cap, and only then. `dueCards` is
// the day's pile: every card due today or earlier in an active deck (no new
// or grammar cards). Returns the card writes; empty when the pile fits.
//
// Deferred: just enough cards to bring the pile down to the cap, those most
// likely to be remembered today first. Never a card being learned or
// relearned, never one with stability under 21 days, and never an older
// SM-2 card. If there aren't enough such cards the pile stays over the cap.
//
// How far: up to 15% of the card's stability (1 to 21 days), on the lightest
// day in that window. Only the due date moves (T9); stability is untouched,
// and FSRS accounts for the extra days when the card is next reviewed.
export const DEFER_MIN_STABILITY = 21;
export const DEFER_SHARE         = 0.15;
export const DEFER_MAX_DAYS      = 21;

// Chance the card is remembered right now, by the FSRS forgetting curve.
// `nowMs` lets the deferral forecast ask the same question of a later day.
export function predictedRecall(card, nowMs = Date.now()) {
  return retrievability(Math.max(daysSinceLastReview(card, nowMs), 0.1), card.stability || 1);
}

// `offset` (deferral notices, DF-D2): plan as if the clock were `offset`
// days on. "Today", the landing days and each card's predicted recall all
// move with it, so the forecast asks exactly what the pipeline will ask on
// that day. 0 (the default) is the real run.
//
// Each deferred card is also marked (DF-D9): `deferredFor` is the `due` the
// deferral gave it, and `deferredFrom` the day it was due before the first
// deferral (kept if it is deferred again before being reviewed).
export function planTriage(dueCards, { cap, dsh = 3, dueLoad, offset = 0 } = {}) {
  const pile   = dueCards || [];
  const excess = pile.length - cap;
  if (!(excess > 0)) return [];

  const today = logicalDayStr(offset, dsh);
  const nowMs = Date.now() + offset * 86_400_000;
  const load  = new Map(dueLoad || []);
  const eligible = pile
    .filter(c => c.state === 'review' && (c.stability || 0) >= DEFER_MIN_STABILITY)
    .map(c => ({ card: c, recall: predictedRecall(c, nowMs) }))
    .sort((a, b) =>
      b.recall - a.recall ||
      b.card.stability - a.card.stability ||
      String(a.card.id).localeCompare(String(b.card.id)));

  const updates = [];
  for (const { card } of eligible.slice(0, excess)) {
    const maxDays = Math.min(DEFER_MAX_DAYS, Math.max(1, Math.round(card.stability * DEFER_SHARE)));
    let best = 1, bestLoad = Infinity;
    for (let d = 1; d <= maxDays; d++) {
      const n = load.get(logicalDayStr(offset + d, dsh)) || 0;
      if (n < bestLoad) { best = d; bestLoad = n; }
    }
    const dueDay = logicalDayStr(offset + best, dsh);
    load.set(dueDay, bestLoad + 1);
    const due = logicalDueISO(offset + best, dsh);
    const deferredFrom = isMarkedDeferred(card) && isDay(card.deferredFrom)
      ? card.deferredFrom
      : (getDueDateStr(card) || today);
    updates.push({
      id: card.id, due, dueDay, dueDayFor: due,
      deferredFor: due, deferredFrom,
      triageBucket: 'defer', lastTriageDate: today,
    });
  }
  return updates;
}

// ── Deferred cards (DF-D9) ────────────────────────────────────
// A deferral's mark holds while the card's `due` is still the one the
// deferral gave it. Any grade writes a new `due` (also from a tab running
// older code), so the mark goes stale by itself and nothing has to clear it.
// The last review must also be older than the deferral's day, for the rare
// grade that lands on the very same day.
function isMarkedDeferred(card) {
  return !!card && !!card.deferredFor && card.deferredFor === card.due;
}
function logicalDayOf(iso, dsh) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  d.setHours(d.getHours() - dsh);
  return toDateStr(d);
}
// Deferred and not yet due again: these are the cards the deferred round offers.
export function isDeferred(card, dsh = 3) {
  if (!isMarkedDeferred(card) || isNewCard(card) || card.type === 'grammar') return false;
  const rev = card.lastReview || card.lastReviewed;
  if (rev && isDay(card.lastTriageDate)) {
    const revDay = logicalDayOf(rev, dsh);
    if (revDay && revDay >= card.lastTriageDate) return false;
  }
  return !isDueToday(card, dsh);
}

// ── One-time stamp of dueDay on existing cards (SC-D6) ────────
// The writes for the Dev Dashboard's "Stamp due days": every reviewed,
// non-grammar card whose due date is a timestamp without a current dueDay.
// Purely additive; `due` itself is not touched. Run where the cards were
// reviewed (Korea), since it reads the old timestamps in the device's zone.
// Older SM-2 cards already hold a plain date and need nothing.
export function planDueDayStamps(cards) {
  const stamps = [];
  for (const c of cards || []) {
    if (!c || c.type === 'grammar' || isNewCard(c)) continue;
    if (typeof c.due !== 'string' || isDay(c.due) || hasCurrentDueDay(c)) continue;
    const day = getDueDateStr({ due: c.due });
    if (isDay(day) && !day.includes('NaN')) stamps.push({ id: c.id, dueDay: day, dueDayFor: c.due });
  }
  return stamps;
}

// ── Main grading function ─────────────────────────────────────
//
// card     — the current card object (SM-2, FSRS, or unreviewed — all handled)
// rating   — AGAIN | HARD | GOOD | EASY
// settings — from data.settings.fsrs (falls back to FSRS_DEFAULTS for each key)
//
// dsh      — day-start hour; the next due date counts from the logical day (T1)
// dueLoad  — optional Map from buildDueLoad; when given, an interval of a
//            week or more is spread to a lighter nearby day (SC-D5)
//
// Returns a plain object of updated fields to write to Firestore.
// Never mutates the input card.

export function fsrsGrade(card, rating, settings = {}, dsh = 3, dueLoad = null) {
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
      // SC-D4: a card that was known and is being relearned loses half its
      // stability with each further Again (FSRS-5's same-day rule, weights
      // 17 and 18), never below the floor. Before, the second Again threw
      // away the card's whole history. A card still being learned for the
      // first time has no history to keep and stays at the floor.
      stability    = state === 'relearning'
        ? Math.max(W[0], (card.stability || W[0]) * Math.exp(W[17] * (AGAIN - 3 + W[18])))
        : W[0];
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
  // dueDay is the same day as a plain date (SC-D6); readers use it first.
  let due, dueDay;
  if (intervalDays === 0) {
    // Due immediately — 1 second in the past so it always reads as overdue.
    // This handles again-queue carry-over: if the session ends before this
    // card is resolved, it surfaces at the very start of the next session.
    due    = new Date(now.getTime() - 1000).toISOString();
    dueDay = logicalDayStr(0, dsh);
  } else {
    intervalDays = spreadInterval(intervalDays, dueLoad, { dsh, maximumInterval });
    due    = logicalDueISO(intervalDays, dsh);
    dueDay = logicalDayStr(intervalDays, dsh);
  }

  return {
    state:      newState,
    stability:  parseFloat((stability || W[0]).toFixed(4)),
    difficulty: parseFloat((difficulty || 5).toFixed(4)),
    due,
    dueDay,
    dueDayFor: due,
    lastReview: now.toISOString(),
    lapses:     rating === AGAIN ? (card.lapses || 0) + 1 : (card.lapses || 0),
    reps:       (card.reps || 0) + 1,
  };
}
