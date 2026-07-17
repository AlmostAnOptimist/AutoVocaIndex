// src/utils/srsEngine.js
// SRS pipeline utilities, extracted from FlashcardsPage so they can run at App
// level (on any page open) and be re-run after review sessions.

import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase.js';
import { getLogicalDateStr, toDateStr } from './dateUtils.js';
import {
  isNewCard, isDueToday, triageBucket, compressInterval, getDueDateStr,
} from './fsrs.js';

const DAILY_CAP        = 80;
const FORECAST_DAYS    = 7;
const MAX_DISPLAY_SPIKES = 3;

// A card is "paused" (Phase D2) only when every deck it belongs to is paused;
// a card still live in any active deck keeps surfacing. Deck-less cards are
// never paused. Returns the input array unchanged when nothing is paused.
function filterActiveCards(cards, pausedDeckIds) {
  if (!pausedDeckIds || pausedDeckIds.length === 0) return cards;
  const paused = new Set(pausedDeckIds);
  return cards.filter(c => !(c.deckIds?.length && c.deckIds.every(id => paused.has(id))));
}

// ── Full daily pipeline (once per logical day, cached in Firestore) ────────────
//
// Pass 1 — reactive triage: moves overdue cards into their triage buckets.
// Pass 2 — spike forecast: looks 7 days ahead, records up to 3 spikes for display
//           and adds a task for the first uncovered one.
//
// Returns pipelineOutput:
//   { date, triaged, dueAtDayStart, spikes, spikeDetected, generatedAt }
//
// dueAtDayStart is a snapshot of how many non-grammar, non-new cards are due
// at the moment the pipeline runs — used as the fixed daily total in TodayPage.
export async function runDailyPipeline(uid, cards, dsh, addTask, existingTasks = [], pausedDeckIds = []) {
  const today   = getLogicalDateStr(dsh);
  const planRef = doc(db, 'users', uid, 'dailyplan', today);

  const cached = await getDoc(planRef);
  if (cached.exists()) return cached.data().pipelineOutput;

  // Cards in a fully-paused set are held out of triage, the due snapshot, and
  // the spike forecast (Phase D2).
  const activeCards = filterActiveCards(cards, pausedDeckIds);

  // Snapshot of cards due right now (fixed total shown in TodayPage all day).
  const dueAtDayStart = activeCards.filter(c => {
    if (c.type === 'grammar' || isNewCard(c)) return false;
    return isDueToday(c, dsh);
  }).length;

  // Pass 1 — triage
  const overdue = activeCards.filter(c => {
    if (c.type === 'grammar' || isNewCard(c)) return false;
    const dueDateStr = getDueDateStr(c);
    return dueDateStr && dueDateStr < today;
  });

  const updates = [];
  for (const card of overdue) {
    const bucket = triageBucket(card);
    if (bucket === 'defer') {
      updates.push({ id: card.id, ...compressInterval(card), triageBucket: 'defer', lastTriageDate: today });
    } else {
      updates.push({ id: card.id, triageBucket: bucket, lastTriageDate: today });
    }
  }
  for (const u of updates) {
    const { id, ...fields } = u;
    await updateDoc(doc(db, 'users', uid, 'flashcards', id), fields);
  }

  // Pass 2 — spike forecast
  const { spikes, spikeDetected } = _computeSpikes(activeCards, today, addTask, existingTasks);

  const output = {
    date: today,
    triaged: updates.length,
    dueAtDayStart,
    spikes,
    spikeDetected,
    generatedAt: new Date().toISOString(),
  };

  await setDoc(planRef, {
    logicalDate: today,
    pipelineOutput: output,
    generatedAt: new Date().toISOString(),
  });

  return output;
}

// ── Spike-only re-run (called after each review session) ──────────────────────
//
// Re-runs Pass 2 only with the current (post-session) card state so that cards
// added today are factored into the forecast immediately.
// Uses updateDoc with dot-notation to patch only the spike fields.
// Returns the full pipelineOutput (existing fields preserved).
export async function runSpikeForecast(uid, cards, dsh, addTask, existingTasks = [], pausedDeckIds = []) {
  const today   = getLogicalDateStr(dsh);
  const planRef = doc(db, 'users', uid, 'dailyplan', today);

  const activeCards = filterActiveCards(cards, pausedDeckIds);
  const { spikes, spikeDetected } = _computeSpikes(activeCards, today, addTask, existingTasks);

  // Read existing output so we can return a full merged object to the caller.
  let existingOutput = {};
  try {
    const snap = await getDoc(planRef);
    if (snap.exists()) existingOutput = snap.data().pipelineOutput || {};
  } catch {}

  try {
    // Dot-notation update touches only the spike fields, preserving triaged / dueAtDayStart.
    await updateDoc(planRef, {
      'pipelineOutput.spikes':        spikes,
      'pipelineOutput.spikeDetected': spikeDetected,
    });
  } catch {
    // Doc not yet written (edge case on first open of a new day) — write it fully.
    await setDoc(planRef, {
      logicalDate: today,
      pipelineOutput: { ...existingOutput, spikes, spikeDetected },
      generatedAt: new Date().toISOString(),
    });
  }

  return { ...existingOutput, spikes, spikeDetected };
}

// ── Internal: spike computation and task creation ─────────────────────────────
function _computeSpikes(cards, today, addTask, existingTasks) {
  const detectedSpikes = [];

  // Base the forecast on the logical today date, not the raw clock.
  // Using noon local avoids any DST edge case when doing setDate arithmetic.
  const baseDate = new Date(today + 'T12:00:00');

  for (let d = 1; d <= FORECAST_DAYS; d++) {
    const target = new Date(baseDate);
    target.setDate(baseDate.getDate() + d);

    // Snap to local midnight.
    target.setHours(0, 0, 0, 0);

    // Local date string — matches getDueDateStr() which now returns local dates.
    const targetStr = toDateStr(target);

    // taskDateStr and dayName use local date components for display and tasks.
    const taskDateStr = toDateStr(target);
    const dayName     = target.toLocaleDateString('en-US', { weekday: 'long' });

    const dueCount = cards.filter(c => {
      if (c.type === 'grammar' || isNewCard(c)) return false;
      return getDueDateStr(c) === targetStr;
    }).length;

    if (dueCount > DAILY_CAP) {
      detectedSpikes.push({ dueCount, taskDateStr, dayName });
    }
  }

  // Add a task for the first uncovered spike only (avoid duplicate tasks).
  let spikeDetected = false;
  for (const spike of detectedSpikes) {
    const covered = existingTasks.some(
      t => t.source === 'srs_forecast' && t.date === spike.taskDateStr
    );
    if (!covered) {
      spikeDetected = true;
      if (addTask) addTask({
        title:     `SRS review — spike incoming (${spike.dueCount} cards due)`,
        category:  'lang', priority: 'high',
        date:       spike.taskDateStr,
        time:       null, recurrence: { type: 'none' },
        completed:  false, notes: '', goalIds: [], source: 'srs_forecast',
      });
      break;
    }
  }

  // Return up to MAX_DISPLAY_SPIKES for TodayPage flag display.
  return { spikes: detectedSpikes.slice(0, MAX_DISPLAY_SPIKES), spikeDetected };
}
