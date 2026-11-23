// src/utils/srsEngine.js
// SRS pipeline utilities, extracted from FlashcardsPage so they can run at App
// level (on any page open) and be re-run after review sessions.

import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase.js';
import { getLogicalDateStr } from './dateUtils.js';
import { isNewCard, isDueToday, planTriage, buildDueLoad } from './fsrs.js';
import { queueWrite } from './queuedWrite.js';
import { withCardStamp } from './cardStamp.js';

export const DAILY_CAP = 80;

// A card is "paused" (Phase D2) only when every deck it belongs to is paused;
// a card still live in any active deck keeps surfacing. Deck-less cards are
// never paused. Returns the input array unchanged when nothing is paused.
export function filterActiveCards(cards, pausedDeckIds) {
  if (!pausedDeckIds || pausedDeckIds.length === 0) return cards;
  const paused = new Set(pausedDeckIds);
  return cards.filter(c => !(c.deckIds?.length && c.deckIds.every(id => paused.has(id))));
}

// ── Full daily pipeline (once per logical day, cached in Firestore) ────────────
//
// Triage: only on a day with more due than the cap (dailyCap, the "Daily
// review cap" setting, settings.srsSpikeCap). Defers just enough of the cards
// most likely to be remembered to bring the day down to the cap (planTriage
// in fsrs.js). On any other day nothing is moved.
//
// The 7-day look ahead is no longer part of the plan: the deferral notices
// are worked out live from the cards in memory (deferralOutlook.js, DF-D6),
// and no spike task is created any more (DF-D7). Plans saved by older code
// may still carry spikes / spikeDetected / tomorrowCount; nothing reads them.
//
// Returns pipelineOutput:
//   { date, triaged, dueAtDayStart, dueCardIds, generatedAt }
// `triaged` is the number of cards deferred.
// When the pipeline ran here (not read back from today's saved plan), the
// result also carries cardUpdates — the triage fields written to each card —
// so the caller can apply them in memory instead of re-reading every card
// (bug sweep P2). cardUpdates is not saved with the plan.
//
// dueAtDayStart is a snapshot of how many non-grammar, non-new cards are due
// once the pipeline has run (deferred cards are no longer due, so they are not
// in it) — used as the fixed daily total in TodayPage.
export async function runDailyPipeline(uid, cards, dsh, pausedDeckIds = [], dailyCap = DAILY_CAP) {
  const today   = getLogicalDateStr(dsh);
  const planRef = doc(db, 'users', uid, 'dailyplan', today);

  // Offline on a new day there is no saved plan to read and the read fails.
  // Build the plan from the cards in memory instead of giving up for the day
  // (deferrals are the same whichever device works them out).
  let cached = null;
  try {
    cached = await getDoc(planRef);
  } catch (e) {
    console.warn("SRS pipeline: couldn't read today's plan; building it here", e);
  }
  if (cached?.exists()) return cached.data().pipelineOutput;

  // Cards in a fully-paused set are held out of triage and the due snapshot
  // (Phase D2).
  const activeCards = filterActiveCards(cards, pausedDeckIds);

  // The day's pile: every reviewed card due today or earlier.
  const pile = activeCards.filter(c => {
    if (c.type === 'grammar' || isNewCard(c)) return false;
    return isDueToday(c, dsh);
  });

  // Queued, not awaited (the S6 pattern): the day's totals never wait on the
  // network, and offline the writes sit in Firestore's local queue. One write
  // per card, so a card deleted on another device can't sink the others.
  const updates = planTriage(pile, { cap: dailyCap, dsh, dueLoad: buildDueLoad(activeCards) });
  for (const { id, ...fields } of updates) {
    queueWrite(() => updateDoc(doc(db, 'users', uid, 'flashcards', id), withCardStamp(fields)),
      'SRS pipeline: triage write failed');
  }

  // Snapshot of the cards left due (fixed total shown in TodayPage all day).
  // IDs are kept so TodayPage can count how many of *these* cards remain due —
  // new-card reviews and paused-deck overdue cards can never leak into that count.
  const moved      = new Map(updates.map(({ id, ...fields }) => [id, fields]));
  const dueCardIds = pile.filter(c => !moved.has(c.id)).map(c => c.id);
  const dueAtDayStart = dueCardIds.length;

  const output = {
    date: today,
    triaged: updates.length,
    dueAtDayStart,
    dueCardIds,
    generatedAt: new Date().toISOString(),
  };

  queueWrite(() => setDoc(planRef, {
    logicalDate: today,
    pipelineOutput: output,
    generatedAt: new Date().toISOString(),
  }), 'SRS pipeline: plan write failed');

  return { ...output, cardUpdates: updates };
}
