// src/utils/reviewStatsEngine.js
//
// Maintains users/{uid}/settings/reviewStats — a small, incrementally-updated
// aggregate of all-time review records (best day/week/month, longest streak,
// current streak) so FlashcardsPage never needs to re-read the full reviewLog
// history just to display them. Scope matches reviewLog itself: grammar-card
// reviews don't write to reviewLog (see FlashcardsPage's handleGrade) and so
// are correctly excluded here too.
//
// Two write paths share the same record-comparison rule (ties keep the
// original date — a record only moves when a new value strictly exceeds it):
//   - applyReviewToStats: called once per grade, alongside the existing
//     reviewLog increment write. No reads involved — the caller already has
//     the day's new running count in memory.
//   - computeReviewStats: a full recompute over the entire reviewLog
//     collection. Used to seed the doc the first time, and as a standing
//     on-demand repair tool (DevDashboard "Recompute review stats") if the
//     incremental numbers are ever suspected to have drifted. Not called on
//     normal page loads.

import { collection, getDocs, doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase.js';
import { toDateStr, getLogicalToday } from './dateUtils.js';

export const EMPTY_REVIEW_STATS = {
  totalAllTime: 0,
  bestDay: null,         // { date, count }
  bestWeek: null,        // { weekStart, count } — weekStart is Monday, matches the heatmap's week rows
  bestMonth: null,        // { ym, count }
  longestStreak: null,    // { length, endDate }
  currentWeekStart: null,
  currentWeekCount: 0,
  currentMonthYM: null,
  currentMonthCount: 0,
  lastReviewDate: null,
  currentStreakLength: 0,
};

// Monday-start week key for a date, formatted 'YYYY-MM-DD' — matches
// ActivityHeatmap's own Monday-start grid rows.
function getWeekStart(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const dow = (d.getDay() + 6) % 7; // 0 = Monday
  d.setDate(d.getDate() - dow);
  return toDateStr(d);
}

// Records only move when a candidate value strictly exceeds the existing
// one — a tie keeps the original record's date rather than overwriting it
// with today's, so the record's date doesn't "move" without the number
// actually changing.
function maybeUpdateRecord(record, candidateValue, candidateMeta) {
  if (candidateValue <= 0) return record;
  if (!record || candidateValue > record.count) {
    return { ...candidateMeta, count: candidateValue };
  }
  return record;
}

// Is `dateStr` still "alive" as a streak anchor relative to right now —
// i.e. today, or yesterday (so a streak doesn't look broken just because
// today's session hasn't happened yet). Same rule as dateUtils.computeStreak.
function isStreakAlive(dateStr, dsh) {
  if (!dateStr) return false;
  const today = getLogicalToday(dsh);
  const todayStr = toDateStr(today);
  if (dateStr === todayStr) return true;
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  return dateStr === toDateStr(yesterday);
}

// ── Full recompute ──────────────────────────────────────────────
// Pure function over a complete { 'YYYY-MM-DD': count } map (zero or
// missing entries are treated as no review that day).
export function computeReviewStats(reviewLog, dsh = 3) {
  const dates = Object.keys(reviewLog || {})
    .filter(d => (reviewLog[d] || 0) > 0)
    .sort();

  const stats = { ...EMPTY_REVIEW_STATS };
  let streak = 0;
  let prevDate = null;

  for (const dateStr of dates) {
    const count = reviewLog[dateStr] || 0;

    stats.totalAllTime += count;
    stats.bestDay = maybeUpdateRecord(stats.bestDay, count, { date: dateStr });

    const weekStart = getWeekStart(dateStr);
    stats.currentWeekCount = (weekStart === stats.currentWeekStart) ? stats.currentWeekCount + count : count;
    stats.currentWeekStart = weekStart;
    stats.bestWeek = maybeUpdateRecord(stats.bestWeek, stats.currentWeekCount, { weekStart });

    const ym = dateStr.slice(0, 7);
    stats.currentMonthCount = (ym === stats.currentMonthYM) ? stats.currentMonthCount + count : count;
    stats.currentMonthYM = ym;
    stats.bestMonth = maybeUpdateRecord(stats.bestMonth, stats.currentMonthCount, { ym });

    // Streak: consecutive calendar days with at least one review (gaps reset it).
    if (prevDate) {
      const expected = new Date(`${prevDate}T00:00:00`);
      expected.setDate(expected.getDate() + 1);
      streak = (toDateStr(expected) === dateStr) ? streak + 1 : 1;
    } else {
      streak = 1;
    }
    if (!stats.longestStreak || streak > stats.longestStreak.length) {
      stats.longestStreak = { length: streak, endDate: dateStr };
    }
    prevDate = dateStr;
  }

  stats.lastReviewDate = prevDate;
  stats.currentStreakLength = isStreakAlive(prevDate, dsh) ? streak : 0;

  return stats;
}

// ── Incremental update ──────────────────────────────────────────
// Applied once per grade alongside the existing reviewLog increment write.
// `newDayCount` is the logged day's running total *after* this grade
// (the caller already has this in memory — see FlashcardsPage.handleGrade).
export function applyReviewToStats(prevStats, dateStr, newDayCount, dsh = 3) {
  const stats = { ...EMPTY_REVIEW_STATS, ...(prevStats || {}) };
  const isFirstReviewToday = newDayCount === 1;

  stats.totalAllTime = (stats.totalAllTime || 0) + 1;
  stats.bestDay = maybeUpdateRecord(stats.bestDay, newDayCount, { date: dateStr });

  const weekStart = getWeekStart(dateStr);
  stats.currentWeekCount = (weekStart === stats.currentWeekStart) ? (stats.currentWeekCount || 0) + 1 : 1;
  stats.currentWeekStart = weekStart;
  stats.bestWeek = maybeUpdateRecord(stats.bestWeek, stats.currentWeekCount, { weekStart });

  const ym = dateStr.slice(0, 7);
  stats.currentMonthCount = (ym === stats.currentMonthYM) ? (stats.currentMonthCount || 0) + 1 : 1;
  stats.currentMonthYM = ym;
  stats.bestMonth = maybeUpdateRecord(stats.bestMonth, stats.currentMonthCount, { ym });

  if (isFirstReviewToday) {
    const prevLogical = new Date(`${dateStr}T00:00:00`);
    prevLogical.setDate(prevLogical.getDate() - 1);
    const expectedPrev = toDateStr(prevLogical);
    const newLength = (stats.lastReviewDate === expectedPrev) ? (stats.currentStreakLength || 0) + 1 : 1;
    stats.currentStreakLength = newLength;
    stats.lastReviewDate = dateStr;
    if (!stats.longestStreak || newLength > stats.longestStreak.length) {
      stats.longestStreak = { length: newLength, endDate: dateStr };
    }
  }

  return stats;
}

// Display-time helper: currentStreakLength is only refreshed when a grade
// happens, so between sessions it can go stale (e.g. you reviewed two days
// ago, haven't opened the app since — the stored number is still positive
// even though the streak is actually broken). Call this at render time
// against the freshly-loaded doc rather than trusting the stored field
// directly; no extra reads, it only uses fields already on the doc.
export function getEffectiveCurrentStreak(reviewStats, dsh = 3) {
  if (!reviewStats) return 0;
  return isStreakAlive(reviewStats.lastReviewDate, dsh) ? (reviewStats.currentStreakLength || 0) : 0;
}

// ── Firestore orchestration ───────────────────────────────────────
// Full read of the entire reviewLog collection + full overwrite of the
// reviewStats doc. Deliberately not used on normal page loads — only for
// the initial seed and DevDashboard's on-demand repair button.
export async function recomputeReviewStats(uid, dsh = 3) {
  const snap = await getDocs(collection(db, 'users', uid, 'reviewLog'));
  const log = {};
  snap.forEach(d => { log[d.id] = d.data().count || 0; });
  const stats = computeReviewStats(log, dsh);
  await setDoc(doc(db, 'users', uid, 'settings', 'reviewStats'), stats);
  return stats;
}