// src/utils/stampDueDays.js
// One-time action behind the Dev Dashboard's "Stamp due days" (SC-D6).
//
// Since the November 2026 update every grade and deferral writes the due day as a plain date
// (dueDay) beside the due timestamp, so a card is due on the same day
// wherever the device is. Cards last reviewed before that only have the
// timestamp, which reads a day early or late in another time zone. This
// gives those cards their dueDay now instead of at their next review.
//
// Adds two fields per card (dueDay, dueDayFor) and changes nothing else. The
// plan itself is planDueDayStamps in fsrs.js. Safe to repeat: stamped cards
// are skipped, so a run that stops partway carries on from where it stopped.

import { collection, getDocs, doc, writeBatch } from 'firebase/firestore';
import { db } from '../firebase.js';
import { planDueDayStamps } from './fsrs.js';
import { withCardStamp } from './cardStamp.js';

// The timestamps are read in the device's own zone, so this should run on a
// device set to the zone the cards were reviewed in.
export function deviceZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
}

const BATCH = 450;

// Reads every card and works out what would be written. Writes nothing.
export async function readDueDayStamps(uid) {
  const snap  = await getDocs(collection(db, 'users', uid, 'flashcards'));
  const cards = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return { total: cards.length, stamps: planDueDayStamps(cards), fromCache: snap.metadata.fromCache };
}

// Reads the cards again and writes the stamps, so a card reviewed since the
// last check is planned from its current due date. Resolves to the number of
// cards stamped.
export async function stampDueDays(uid, onProgress) {
  const { stamps, fromCache } = await readDueDayStamps(uid);
  if (fromCache) throw Object.assign(new Error('offline'), { code: 'unavailable' });
  for (let i = 0; i < stamps.length; i += BATCH) {
    const batch = writeBatch(db);
    for (const { id, ...fields } of stamps.slice(i, i + BATCH)) {
      batch.update(doc(db, 'users', uid, 'flashcards', id), withCardStamp(fields));
    }
    await batch.commit();
    if (onProgress) onProgress(Math.min(i + BATCH, stamps.length), stamps.length);
  }
  return stamps.length;
}
