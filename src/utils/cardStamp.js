// src/utils/cardStamp.js
// The "changed at" stamp every flashcard write carries (offline decisions
// OF-D2).
//
// Another device learns that cards changed from the marker document
// (cardsMarker.js) and then asks only for the cards changed since it last
// looked. That question is answered from this stamp, so a card write that
// leaves it out goes unseen by other devices until their once-a-day full
// read. tests/card-stamp-scan-golden.mjs scans the source for card writes
// that don't use withCardStamp.
//
// The time is the server's, not the device's: a device whose clock runs
// behind could otherwise stamp a change as older than what the others have
// already seen. Cards in memory don't need the stamp; add it at the write.

import { serverTimestamp } from 'firebase/firestore';

export const CARD_CHANGED_FIELD = 'updatedAt';

// The fields for a card write (set or update), with the stamp added.
export function withCardStamp(fields) {
  return { ...fields, [CARD_CHANGED_FIELD]: serverTimestamp() };
}
