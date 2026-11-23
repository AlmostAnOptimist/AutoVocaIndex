// src/utils/grammarEntriesStore.js
// Grammar Index entries, read once and re-read only when they change.
//
//   users/{uid}/meta/grammar   { n }   the marker: a count of entry changes
//
// Every write to grammar_entries also adds 1 to n (bumpGrammarEntriesMarker,
// or addGrammarMarkerBump inside a write batch), issued after the entry
// write so the server always has the entry before the count moves. Each
// device keeps its copy of the entries in localStorage together with the n
// that copy reflects. loadGrammarEntries reads the marker (one read) and
// reads all the entries only when the server's n is ahead of the copy's.
//
// A change made on the Grammar Index page is already in this device's copy
// (the page keeps the copy in step, rememberGrammarEntries), so that bump
// also moves the copy's n and costs this device no re-read. Increments
// never overwrite each other, so a change made on another device, even
// offline at the same moment, still leaves the server ahead of this copy.
// Changes made elsewhere on this device (imports, Dev Dashboard) don't move
// the copy's n, so this device re-reads once like any other.
//
// When the server's n is behind the copy's, this device's own changes are
// still on their way (made offline); the copy already has them, so it is
// kept.
//
// The first half of this file is pure and tested by
// tests/grammar-entries-store-golden.mjs; the Firestore calls are at the end.

import { doc, collection, setDoc, increment, getDocFromServer, getDocsFromServer, getDocsFromCache } from 'firebase/firestore';
import { db } from '../firebase.js';
import { queueWrite } from './queuedWrite.js';

export const GRAMMAR_CACHE_KEY = 'avi_grammar_entries';
export const GRAMMAR_COUNT_KEY = 'avi_grammar_entries_n';
// Callers on the same navigation (App, then the page itself) share one check.
export const CHECK_GAP_MS = 60 * 1000;

// ── Pure ──────────────────────────────────────────────────────
export const sortEntries = (rows) => [...(rows || [])].sort((a, b) => (a.entryNumber || 0) - (b.entryNumber || 0));

export function masteryCounts(entries) {
  const c = { all: (entries || []).length, introduced: 0, practicing: 0, confident: 0, mastered: 0 };
  (entries || []).forEach(e => { if (c[e.masteryLevel] !== undefined) c[e.masteryLevel]++; });
  return c;
}

// True when the copy can't be trusted: there is none, it predates the
// marker, or another device (or another part of the app) changed entries.
export function mustReadAll(serverN, storedN, hasRows) {
  return !hasRows || storedN == null || serverN > storedN;
}

// storage: anything with getItem/setItem (localStorage in the app). Every
// call is guarded: a full or unavailable storage only costs a re-read.
export function readStored(storage) {
  let rows = null, n = null;
  try {
    const raw = storage.getItem(GRAMMAR_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) rows = parsed;
  } catch { rows = null; }
  try {
    const raw = storage.getItem(GRAMMAR_COUNT_KEY);
    const num = raw == null ? NaN : Number(raw);
    if (Number.isFinite(num)) n = num;
  } catch { n = null; }
  return { rows, n };
}

// Saves the copy; with n, also the count it reflects. If the rows can't be
// saved the count is dropped, so a stale copy is never vouched for.
export function writeStored(storage, rows, n) {
  try {
    storage.setItem(GRAMMAR_CACHE_KEY, JSON.stringify(rows || []));
  } catch {
    try { storage.removeItem(GRAMMAR_COUNT_KEY); } catch { /* nothing more to do */ }
    return;
  }
  if (n === undefined) return;
  try { storage.setItem(GRAMMAR_COUNT_KEY, String(n)); } catch { /* re-read next time */ }
}

// A change already in this device's copy: the copy keeps up with the marker.
export function noteOwnChange(storage) {
  const { n } = readStored(storage);
  if (n == null) return;
  try { storage.setItem(GRAMMAR_COUNT_KEY, String(n + 1)); } catch { /* re-read next time */ }
}

// The loader, with its reads passed in. readCount: the server's n (0 when
// the marker doesn't exist yet). readAll: every entry, from the server.
// readAllCached: every entry from Firestore's copy on this device (offline
// with no copy of our own). load() never throws: if the server can't be
// reached it answers with what this device has.
export function createGrammarLoader({ readCount, readAll, readAllCached, storage, now = Date.now, gapMs = CHECK_GAP_MS }) {
  let checkedAt = -Infinity;
  let inflight = null;
  let lastRows = null; // the last check's answer, in case storage can't hold it
  return {
    load() {
      if (inflight) return inflight;
      const known = readStored(storage).rows || lastRows;
      if (known && now() - checkedAt < gapMs) return Promise.resolve(known);
      inflight = (async () => {
        try {
          const n = await readCount();          // the marker first, then the entries
          const s = readStored(storage);        // as it is now, after the wait
          if (!mustReadAll(n, s.n, !!s.rows)) { checkedAt = now(); lastRows = s.rows; return s.rows; }
          const rows = sortEntries(await readAll());
          writeStored(storage, rows, n);
          checkedAt = now();
          lastRows = rows;
          return rows;
        } catch (e) {
          console.warn('grammarEntriesStore: check failed, using this device\'s copy', e);
          const s = readStored(storage);
          if (s.rows || lastRows) return s.rows || lastRows;
          try { return sortEntries(await readAllCached()); } catch { return []; }
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },
  };
}

// ── Firestore ─────────────────────────────────────────────────
const markerDoc  = (uid) => doc(db, 'users', uid, 'meta', 'grammar');
const entriesCol = (uid) => collection(db, 'users', uid, 'grammar_entries');
const rowsOf     = (snap) => snap.docs.map(d => ({ id: d.id, ...d.data() }));
const BUMP       = () => ({ n: increment(1) });

const browserStorage = {
  getItem:    (k) => localStorage.getItem(k),
  setItem:    (k, v) => localStorage.setItem(k, v),
  removeItem: (k) => localStorage.removeItem(k),
};

let loader = null;
let loaderUid = null;
function loaderFor(uid) {
  if (loader && loaderUid === uid) return loader;
  loaderUid = uid;
  loader = createGrammarLoader({
    readCount: async () => {
      const snap = await getDocFromServer(markerDoc(uid));
      return snap.exists() ? (Number(snap.data()?.n) || 0) : 0;
    },
    readAll:       async () => rowsOf(await getDocsFromServer(entriesCol(uid))),
    readAllCached: async () => rowsOf(await getDocsFromCache(entriesCol(uid))),
    storage: browserStorage,
  });
  return loader;
}

// The entries, sorted by entry number. One read when nothing changed.
export const loadGrammarEntries = (uid) => loaderFor(uid).load();

// After a grammar_entries write is issued (not awaited). inMemory: the
// change is already in this device's copy (Grammar Index page edits).
export function bumpGrammarEntriesMarker(uid, { inMemory = false } = {}) {
  if (!uid) return;
  queueWrite(() => setDoc(markerDoc(uid), BUMP(), { merge: true }), 'Grammar entries marker: update failed');
  if (inMemory) noteOwnChange(browserStorage);
}

// The same, as one more write in a batch that changes entries (one op).
export function addGrammarMarkerBump(batch, uid) {
  batch.set(markerDoc(uid), BUMP(), { merge: true });
}

// The Grammar Index page's entries after any change it makes, so the copy
// matches what its bumps vouch for.
export function rememberGrammarEntries(rows) {
  writeStored(browserStorage, rows);
}
