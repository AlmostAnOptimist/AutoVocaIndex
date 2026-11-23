// src/utils/cardsMarker.js
// Keeps flashcards in step across devices (offline decisions OF-D2).
//
//   users/{uid}/meta/cards   { changedAt, by }   the marker
//
// A device that changes cards updates the marker, at most once every 30
// seconds while changes continue (createBumper). Every device watches it
// (watchCardsMarker); when another device moves it, this one reads only the
// cards stamped since it last looked (readCardsChangedSince; the stamp is
// cardStamp.js), at most once a minute and never during a review
// (createRefreshGate). The once-a-day full read in App.jsx stays as the
// fallback: it catches deleted cards, which a "changed since" read can't
// see, and any write that missed the stamp.
//
// The first half of this file is pure and tested by
// tests/cards-marker-golden.mjs; the Firestore calls are at the end.

import {
  doc, collection, query, where, setDoc, onSnapshot, getDocsFromServer, serverTimestamp,
} from 'firebase/firestore';
import { db } from '../firebase.js';
import { CARD_CHANGED_FIELD } from './cardStamp.js';

// ── Stamps ────────────────────────────────────────────────────
// A stamp is a Firestore Timestamp: { seconds, nanoseconds }.
const isStamp = (s) => !!s && typeof s.seconds === 'number' && typeof s.nanoseconds === 'number';
export const compareStamps = (a, b) => (a.seconds - b.seconds) || (a.nanoseconds - b.nanoseconds);

// The newest stamp among `cards` and `floor` (null when there is none). A
// card whose own write hasn't been confirmed yet has no stamp and is skipped.
export function newestStamp(cards, floor = null) {
  let best = isStamp(floor) ? floor : null;
  for (const c of cards || []) {
    const s = c?.[CARD_CHANGED_FIELD];
    if (isStamp(s) && (!best || compareStamps(s, best) > 0)) best = s;
  }
  return best;
}

// Puts cards read as "changed since" into the list in memory: a changed card
// replaces its older copy in place, a new one is added at the end. `keep`
// is the list's own filter (cards without a back are left out of memory);
// a changed card that no longer passes it is removed. Returns the same list
// when nothing was read, and null stays null (cards not loaded yet).
export function mergeChangedCards(prev, changed, keep = () => true) {
  if (!prev || !changed || !changed.length) return prev;
  const byId = new Map(changed.map(c => [c.id, c]));
  const out = [];
  for (const c of prev) {
    if (!byId.has(c.id)) { out.push(c); continue; }
    const next = byId.get(c.id);
    byId.delete(c.id);
    if (keep(next)) out.push(next);
  }
  for (const c of byId.values()) if (keep(c)) out.push(c);
  return out;
}

// ── Updating the marker, not too often ────────────────────────
// touch() on every card change: the first one updates the marker at once,
// later ones within gapMs are answered by a single update when the gap is
// over. flush() sends a waiting update now (review ended, app hidden).
export function createBumper({ bump, gapMs = 30000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let last = -Infinity;
  let timer = null;
  const fire = () => { timer = null; last = now(); bump(); };
  return {
    touch() {
      if (timer !== null) return;
      const wait = gapMs - (now() - last);
      if (wait <= 0) fire();
      else timer = setTimer(fire, wait);
    },
    flush() {
      if (timer === null) return;
      clearTimer(timer);
      fire();
    },
    waiting: () => timer !== null,
  };
}

// ── Reading the changes, not too often and never mid-review ───
// request() when the marker says another device changed cards. run() is
// called at most once per gapMs; a request inside the gap is answered when
// the gap is over. While held (a review is in progress) nothing runs; the
// request is remembered and answered on release.
export function createRefreshGate({ run, gapMs = 60000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let last = -Infinity;
  let timer = null;
  let held = false;
  let wanted = false;
  const go = () => { timer = null; wanted = false; last = now(); run(); };
  const request = () => {
    if (held) { wanted = true; return; }
    if (timer !== null) return;
    const wait = gapMs - (now() - last);
    if (wait <= 0) go();
    else timer = setTimer(() => { timer = null; request(); }, wait);
  };
  return {
    request,
    hold(on) {
      held = !!on;
      if (held) {
        if (timer !== null) { clearTimer(timer); timer = null; wanted = true; }
      } else if (wanted) {
        request();
      }
    },
    cancel() { if (timer !== null) clearTimer(timer); timer = null; wanted = false; },
    wanted: () => wanted || timer !== null,
  };
}

// ── Is a review in progress? ──────────────────────────────────
// The Flashcards page says so (setReviewInProgress); the card data hook in
// App.jsx listens (onReviewInProgress) and holds its gate. A listener that
// arrives late is told the current state at once.
let reviewInProgress = false;
let reviewListener = null;
export function setReviewInProgress(active) {
  reviewInProgress = !!active;
  if (reviewListener) reviewListener(reviewInProgress);
}
export function onReviewInProgress(listener) {
  reviewListener = listener;
  listener(reviewInProgress);
  return () => { if (reviewListener === listener) reviewListener = null; };
}

// ── Firestore ─────────────────────────────────────────────────
// One id per page load, so a device can tell its own marker updates apart.
const DEVICE_ID = Math.random().toString(36).slice(2, 10);

const markerDoc = (uid) => doc(db, 'users', uid, 'meta', 'cards');
const stampKey  = (s) => (isStamp(s) ? `${s.seconds}.${s.nanoseconds}` : '');

// Says "cards changed on this device". Resolves when the server has it.
export function bumpCardsMarker(uid) {
  return setDoc(markerDoc(uid), { changedAt: serverTimestamp(), by: DEVICE_ID });
}

// Calls onOtherDevice() each time another device moves the marker. The
// first reading is only the starting point: the cards were just read in
// full. Returns the function that stops watching.
export function watchCardsMarker(uid, onOtherDevice) {
  let seen;
  return onSnapshot(markerDoc(uid), (snap) => {
    if (snap.metadata.hasPendingWrites) return; // this device's own update, on its way
    const data  = snap.exists() ? snap.data() : null;
    const key   = stampKey(data?.changedAt);
    const first = seen === undefined;
    const moved = key !== seen;
    seen = key;
    if (first || !moved || data?.by === DEVICE_ID) return;
    onOtherDevice();
  }, (e) => console.warn('cardsMarker: watching the marker failed', e));
}

// The cards stamped after `since` (every stamped card when `since` is null),
// from the server.
export async function readCardsChangedSince(uid, since) {
  const cards = collection(db, 'users', uid, 'flashcards');
  const snap  = await getDocsFromServer(query(cards, where(CARD_CHANGED_FIELD, '>', isStamp(since) ? since : new Date(0))));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
