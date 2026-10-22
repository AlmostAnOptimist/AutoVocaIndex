// src/hooks/useAVIData.js
// Firestore load/save for AVI collections: lemmaMaster.
// content_sources and content_sections, wordInputs, sentenceInputs are loaded by App.jsx and passed as props.
// currentSource/currentSection live in App.jsx's data.settings (aviCurrentSource/aviCurrentSection).
// AVI-specific settings are stored as avi-prefixed fields inside the shared settings/main document.
// Called once from AVIPage.jsx. Pattern matches useFirestore.js exactly.

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  collection, doc, getDoc, getDocs, getDocsFromServer, setDoc, updateDoc, deleteDoc, deleteField, writeBatch,
  query, where,
} from 'firebase/firestore';
import { db, auth } from '../firebase.js';
import { mergeAviRows, rowFieldChanges } from '../utils/aviRowMerge.js';
import { queueWrite } from '../utils/queuedWrite.js';

const DEBOUNCE_MS = 800;

// ── S4: how fresh App's copy of the word/sentence rows is ─────
// App reads the rows once at boot and AVI starts from that copy, so edits
// made on another device (or by the Dev Dashboard in another tab) never
// arrived. The rows count as stale once the app has been in the background
// for a minute or more, or 15 minutes after they were read; AVI then re-reads
// them when it opens, or when it comes back to the front while open.
const ROWS_MAX_AGE_MS   = 15 * 60_000;
const AWAY_STALE_MS     = 60_000;
const REFRESH_MIN_GAP_MS = 60_000;
const rowsFreshness = { loadedAt: 0, stale: true, hiddenAt: 0 };

export function markAviRowsLoaded() {
  rowsFreshness.loadedAt = Date.now();
  rowsFreshness.stale = false;
}

// S8: work that outlives the AVI page (Import's background Def1 fill)
// marks the rows stale after saving to them directly, so AVI re-reads them
// when it opens.
export function markAviRowsStale() {
  rowsFreshness.stale = true;
}

export function aviRowsStale(now = Date.now()) {
  return rowsFreshness.stale || !rowsFreshness.loadedAt || now - rowsFreshness.loadedAt > ROWS_MAX_AGE_MS;
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      rowsFreshness.hiddenAt = Date.now();
    } else if (rowsFreshness.hiddenAt) {
      if (Date.now() - rowsFreshness.hiddenAt >= AWAY_STALE_MS) rowsFreshness.stale = true;
      rowsFreshness.hiddenAt = 0;
    }
  });
}

// ── Firestore path helpers ────────────────────────────────────
const wordInputsCol  = (uid) => collection(db, 'users', uid, 'wordInputs');
const sentInputsCol  = (uid) => collection(db, 'users', uid, 'sentenceInputs');
const lemmaMasterCol = (uid) => collection(db, 'users', uid, 'lemmaMaster');
const settingsDoc    = (uid) => doc(db, 'users', uid, 'settings', 'main');

const wordDoc  = (uid, id) => doc(db, 'users', uid, 'wordInputs', id);
const sentDoc  = (uid, id) => doc(db, 'users', uid, 'sentenceInputs', id);
const lemmaDoc = (uid, id) => doc(db, 'users', uid, 'lemmaMaster', id);

// ── S8: background work that outlives the AVI page ───────────
// Import's background Def1 fill keeps running after you leave AVI (by
// design: it's data). Its updates go to whichever AVI page is open now —
// including one opened again later — and, while AVI is closed, straight to
// Firestore.
let liveAviUpdate = null;

export function updateAviIfOpen(updater) {
  if (!liveAviUpdate) return false;
  liveAviUpdate(updater);
  return true;
}

// Saves a background-fetched def1 while AVI is closed: to the given word
// rows and to the lemma's Lemma Master entries (found by cleanedLemma),
// each only while its def1 is still empty. Reads come from the device
// cache when offline; the write is queued (S6). AVI re-reads Lemma Master
// on every open, and the rows are marked stale so it re-reads those too.
export async function saveDef1WhileClosed({ rowUids, lemmaNorm, def1 }) {
  const uid = auth.currentUser?.uid;
  if (!uid || !def1) return;
  const writes = [];
  const rowSnaps = await Promise.all((rowUids || []).map(id => getDoc(wordDoc(uid, id))));
  rowSnaps.forEach((snap, i) => {
    if (snap.exists() && !snap.data().def1) writes.push([wordDoc(uid, rowUids[i]), { def1 }]);
  });
  if (lemmaNorm) {
    const lmSnap = await getDocs(query(lemmaMasterCol(uid), where('cleanedLemma', '==', lemmaNorm)));
    const now = new Date().toISOString();
    lmSnap.docs.forEach(d => {
      if (!d.data().def1) writes.push([d.ref, { def1, lastUpdated: now }]);
    });
  }
  if (!writes.length) return;
  markAviRowsStale();
  const batch = writeBatch(db);
  writes.forEach(([ref, fields]) => batch.update(ref, fields));
  queueWrite(() => batch.commit(), 'S8: saving a background definition failed:');
}

// ── Default AVI settings ──────────────────────────────────────
// Does NOT include currentSource/currentSection — those live in App.jsx's data.settings.
const DEFAULT_AVI_SETTINGS = {
  dictMode:                 'krdict',
  lemmaSortOrder:           'recent',
  chartOrder:               [],
  overviewStatVis:          { words: true, sentences: true },
  showSourcelessInOverview: true,
  noiseBlocks:              [],
  stopwordProfile:          '',
  apiRateLimit:             5,
  importKnownSentences:     false,
};

// ── Extract AVI settings from the shared settings/main document ──
function extractAviSettings(settingsData) {
  if (!settingsData) return { ...DEFAULT_AVI_SETTINGS };
  return {
    dictMode:                 settingsData.aviDictMode                 ?? DEFAULT_AVI_SETTINGS.dictMode,
    lemmaSortOrder:           settingsData.aviLemmaSortOrder           ?? DEFAULT_AVI_SETTINGS.lemmaSortOrder,
    chartOrder:               settingsData.aviChartOrder               ?? DEFAULT_AVI_SETTINGS.chartOrder,
    overviewStatVis:          settingsData.aviOverviewStatVis          ?? DEFAULT_AVI_SETTINGS.overviewStatVis,
    showSourcelessInOverview: settingsData.aviShowSourcelessInOverview ?? DEFAULT_AVI_SETTINGS.showSourcelessInOverview,
    noiseBlocks:              settingsData.aviNoiseBlocks              ?? DEFAULT_AVI_SETTINGS.noiseBlocks,
    stopwordProfile:          settingsData.aviStopwordProfile          ?? DEFAULT_AVI_SETTINGS.stopwordProfile,
    apiRateLimit:             settingsData.aviApiRateLimit             ?? DEFAULT_AVI_SETTINGS.apiRateLimit,
    importKnownSentences:     settingsData.aviImportKnownSentences     ?? DEFAULT_AVI_SETTINGS.importKnownSentences,
  };
}

// ── Build the avi-prefixed payload for writing back to settings/main ──
// Only avi* keys are written — other app fields are untouched via merge: true.
function buildAviSettingsPayload(aviSettings) {
  return {
    aviDictMode:                 aviSettings.dictMode,
    aviLemmaSortOrder:           aviSettings.lemmaSortOrder,
    aviChartOrder:               aviSettings.chartOrder,
    aviOverviewStatVis:          aviSettings.overviewStatVis,
    aviShowSourcelessInOverview: aviSettings.showSourcelessInOverview,
    aviNoiseBlocks:              aviSettings.noiseBlocks,
    aviStopwordProfile:          aviSettings.stopwordProfile,
aviApiRateLimit:             aviSettings.apiRateLimit,
    aviImportKnownSentences:     aviSettings.importKnownSentences,
  };
}

// ── Load AVI collections for the current user ─────────────────
export async function aviLoad(uid) {
  try {
    const lemmaSnap   = await getDocs(lemmaMasterCol(uid));
    const lemmaMaster = lemmaSnap.docs.map(d => ({ ...d.data() }));
    return { lemmaMaster };
  } catch (e) {
    console.error('useAVIData: load failed', e);
    return null;
  }
}

// ── S4: read Lemma Master (and the rows) from the server ──────
// Server-only, so an offline read fails instead of handing back the device
// cache as if it were what other devices saved.
async function aviLoadFromServer(uid, withRows) {
  const reads = [getDocsFromServer(lemmaMasterCol(uid))];
  if (withRows) reads.push(getDocsFromServer(wordInputsCol(uid)), getDocsFromServer(sentInputsCol(uid)));
  const [lemmaSnap, wordSnap, sentSnap] = await Promise.all(reads);
  const out = { lemmaMaster: lemmaSnap.docs.map(d => ({ ...d.data() })) };
  if (withRows) {
    out.wordInputs     = wordSnap.docs.map(d => ({ ...d.data() }));
    out.sentenceInputs = sentSnap.docs.map(d => ({ ...d.data() }));
  }
  return out;
}

const COLLECTION_KEYS = {
  wordInputs:     e => e.uid,
  sentenceInputs: e => e.uid,
  lemmaMaster:    e => e.lemmaID,
};

// ── Diff-based collection sync ────────────────────────────────
// S4: a row that already exists is saved field by field (only the fields
// this device changed), so another device's edit to a different field of
// the same row survives. New rows are written whole. A field-level save
// to a row deleted elsewhere is refused by Firestore; that row's id is
// returned in `missing` and the caller drops it (deleted elsewhere wins).
async function syncCollection(uid, docFn, prevArr, nextArr, keyFn) {
  const prevMap = Object.fromEntries((prevArr || []).map(e => [keyFn(e), e]));
  const nextMap = Object.fromEntries((nextArr || []).map(e => [keyFn(e), e]));
  const missing = [];

  let batch = writeBatch(db);
  let batchOps = [];
  const MAX = 490;

  const flush = async () => {
    if (batchOps.length === 0) return;
    const opsNow = batchOps;
    const batchNow = batch;
    batch = writeBatch(db);
    batchOps = [];
    try {
      await batchNow.commit();
    } catch (e) {
      if (e?.code !== 'not-found') throw e;
      // One row in the batch was deleted elsewhere and the whole batch was
      // refused. Redo the writes one at a time to find it.
      const results = await Promise.allSettled(opsNow.map(op => (
        op.kind === 'update' ? updateDoc(op.ref, op.data)
        : op.kind === 'set'  ? setDoc(op.ref, op.data)
        : deleteDoc(op.ref)
      )));
      results.forEach((res, i) => {
        if (res.status === 'fulfilled') return;
        if (res.reason?.code === 'not-found' && opsNow[i].kind === 'update') missing.push(opsNow[i].id);
        else throw res.reason;
      });
    }
  };
  const add = async (op) => {
    if (batchOps.length >= MAX) await flush();
    if (op.kind === 'update') batch.update(op.ref, op.data);
    else if (op.kind === 'set') batch.set(op.ref, op.data);
    else batch.delete(op.ref);
    batchOps.push(op);
  };

  for (const [id, entry] of Object.entries(nextMap)) {
    // Reference-equality short-circuit: unchanged rows keep object identity
    // across immutable updates (updaters spread only the rows they touch),
    // so an identical reference never needs the field compare. Flush
    // cost scales with rows actually edited, not collection size.
    if (prevMap[id] === entry) continue;
    if (!prevMap[id]) {
      await add({ kind: 'set', id, ref: docFn(uid, id), data: entry });
      continue;
    }
    const changes = rowFieldChanges(prevMap[id], entry);
    if (!changes) continue;
    const data = { ...changes.set };
    for (const k of changes.removed) data[k] = deleteField();
    await add({ kind: 'update', id, ref: docFn(uid, id), data });
  }

  // Safety net: never let a single sync pass delete an entire non-trivial
  // collection. There's no legitimate "clear everything" action in the app for
  // these collections — a sudden jump from many entries to zero is far more
  // likely a stale/empty local state (e.g. a loading race) than a real bulk
  // delete. Skip the deletes and warn instead; additions/updates above still go through.
  const prevCount = Object.keys(prevMap).length;
  const nextCount = Object.keys(nextMap).length;
  if (prevCount > 5 && nextCount === 0) {
    console.warn(`syncCollection: refusing to delete all ${prevCount} docs in one pass — this looks like a stale-empty-state bug, not an intentional bulk delete. No deletions performed.`);
    await flush();
    return { missing };
  }

  for (const id of Object.keys(prevMap)) {
    if (!nextMap[id]) await add({ kind: 'delete', id, ref: docFn(uid, id) });
  }

  await flush();
  return { missing };
}

// ── Sync AVI settings (merge into shared settings/main doc) ──
async function syncAviSettings(uid, prevSettings, nextSettings) {
  if (JSON.stringify(prevSettings) === JSON.stringify(nextSettings)) return;
  await setDoc(settingsDoc(uid), buildAviSettingsPayload(nextSettings), { merge: true });
}

// ── Hook: call from AVIPage.jsx ───────────────────────────────
export function useAVIData({ wordInputs: initWords = [], sentenceInputs: initSents = [], settingsData = null, inputsLoaded = false, onInputsChange = null, onAviSettingsChange = null } = {}) {
  const uid = auth.currentUser?.uid;

  const initAviSettings = extractAviSettings(settingsData);
  const [data, setData] = useState({
    wordInputs:     initWords,
    sentenceInputs: initSents,
    lemmaMaster:    [],
    aviSettings:    initAviSettings,
  });
  const [lemmaMasterLoaded, setLemmaMasterLoaded] = useState(false);
  const [loading,    setLoading]    = useState(true);
  const [syncStatus, setSyncStatus] = useState('local');

  // S4: Lemma Master (and the rows, when stale) now load in refreshRemote below.

  // `loading` only clears once lemmaMaster has loaded AND App.jsx has confirmed
  // wordInputs/sentenceInputs have actually arrived — not just "currently empty,"
  // which is ambiguous with a genuinely-new, empty source/account.
  useEffect(() => {
    setLoading(!(lemmaMasterLoaded && inputsLoaded));
  }, [lemmaMasterLoaded, inputsLoaded]);

  // Initialise with pre-loaded data so the diff sync doesn't treat all
  // existing entries as new additions on the first user edit.
  const lastSynced = useRef({
    wordInputs:     initWords,
    sentenceInputs: initSents,
    lemmaMaster:    [],
    aviSettings:    initAviSettings,
  });
  const pending    = useRef(null);
  const timer      = useRef(null);
  // S4: latest local data (for the remote merge), whether this hook has read
  // the rows itself (then its copy is newer than App's props), and a guard
  // that keeps a save that was under way during a remote read from putting
  // its older snapshot back as the sync base.
  const dataRef        = useRef(data);
  dataRef.current      = data;
  const ownsRowsRef    = useRef(false);
  const baseGen        = useRef(0);
  const refreshingRef  = useRef(false);
  const lastRefreshAt  = useRef(0);
  const lmLoadedRef    = useRef(false);

  // App.jsx loads wordInputs/sentenceInputs/settings asynchronously and can pass
  // them into this hook after it has already mounted with empty/default values
  // (e.g. AVI opened before App.jsx's getDocs calls resolve). Catch up to whatever
  // arrives, as long as no local edit has happened yet. Once the user starts
  // editing, local state becomes authoritative and must not be overwritten by a
  // late-arriving prop snapshot.
  const hasEditedRef = useRef(false);
  useEffect(() => {
    if (hasEditedRef.current) return;
    if (ownsRowsRef.current) {
      // S4: the rows here came from this hook's own read and are newer than
      // App's props (which this hook keeps up to date); only settings catch up.
      setData(prev => ({ ...prev, aviSettings: initAviSettings }));
      lastSynced.current = { ...lastSynced.current, aviSettings: initAviSettings };
      return;
    }
    setData(prev => ({ ...prev, wordInputs: initWords, sentenceInputs: initSents, aviSettings: initAviSettings }));
    lastSynced.current = { ...lastSynced.current, wordInputs: initWords, sentenceInputs: initSents, aviSettings: initAviSettings };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initWords, initSents, settingsData]);

  // Push the live inputs up to App.jsx so its prop snapshots stay current.
  // App loads wordInputs/sentenceInputs once at boot (getDocs), and an
  // AVIPage remount after app-level navigation re-initializes from those
  // props — without this, in-session AVI additions vanish from view after
  // visiting another page (they remain safely synced in Firestore, but the
  // remount shows the stale boot snapshot).
  useEffect(() => {
    if ((!hasEditedRef.current && !ownsRowsRef.current) || !onInputsChange) return;
    onInputsChange(data.wordInputs, data.sentenceInputs);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.wordInputs, data.sentenceInputs, onInputsChange]);

  // S3: push AVI's own settings up to App.jsx too. App keeps the copy AVI
  // starts from on every visit; without this a changed sort order or Import
  // toggle reverted on the next visit.
  useEffect(() => {
    if (!hasEditedRef.current || !onAviSettingsChange) return;
    onAviSettingsChange(buildAviSettingsPayload(data.aviSettings));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.aviSettings, onAviSettingsChange]);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    timer.current = null;
    if (!uid || !pending.current) return;
    const next = pending.current;
    const gen = baseGen.current;
    setSyncStatus('syncing');
    try {
      const prev = lastSynced.current || {
        wordInputs: [], sentenceInputs: [], lemmaMaster: [],
        aviSettings: { ...DEFAULT_AVI_SETTINGS },
      };
      const [w, s, l] = await Promise.all([
        syncCollection(uid, wordDoc,  prev.wordInputs,     next.wordInputs,     COLLECTION_KEYS.wordInputs),
        syncCollection(uid, sentDoc,  prev.sentenceInputs, next.sentenceInputs, COLLECTION_KEYS.sentenceInputs),
        syncCollection(uid, lemmaDoc, prev.lemmaMaster,    next.lemmaMaster,    COLLECTION_KEYS.lemmaMaster),
        syncAviSettings(uid, prev.aviSettings, next.aviSettings),
      ]);
      // S4: rows another device deleted while they were changed here stay
      // deleted: they leave the saved state and this device's copy.
      const missing = { wordInputs: w.missing, sentenceInputs: s.missing, lemmaMaster: l.missing };
      const withoutMissing = (d) => {
        let out = d;
        for (const [key, ids] of Object.entries(missing)) {
          if (!ids.length) continue;
          const gone = new Set(ids);
          out = { ...out, [key]: (out[key] || []).filter(e => !gone.has(COLLECTION_KEYS[key](e))) };
        }
        return out;
      };
      // A remote read that started or finished while this save was under way
      // already set the base; this older snapshot must not replace it.
      if (!refreshingRef.current && gen === baseGen.current) lastSynced.current = withoutMissing(next);
      if (w.missing.length || s.missing.length || l.missing.length) {
        console.warn('useAVIData: rows deleted on another device were dropped here', missing);
        setData(prev => {
          const out = withoutMissing(prev);
          if (pending.current) pending.current = out;
          return out;
        });
      }
      setSyncStatus('ok');
    } catch (e) {
      console.error('useAVIData: sync failed', e);
      setSyncStatus('error');
    }
  }, [uid]);

  const updateData = useCallback((updater) => {
    hasEditedRef.current = true;
    setData(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      pending.current = next;
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, DEBOUNCE_MS);
      return next;
    });
  }, [flush]);

  // S8: this page is where background AVI updates go while it's open.
  useEffect(() => {
    liveAviUpdate = updateData;
    return () => { if (liveAviUpdate === updateData) liveAviUpdate = null; };
  }, [updateData]);

  // ── S4: bring in what other devices saved ───────────────────
  // Merges a remote read into this device's copy (mergeAviRows: changes made
  // here and not yet saved win field by field; everything else takes the
  // remote value). The remote read becomes the sync base, so the next save
  // writes exactly the changes still waiting here.
  const applyRemote = useCallback((remote) => {
    const keys = Object.keys(COLLECTION_KEYS).filter(k => Array.isArray(remote[k]));
    if (!keys.length) return;
    const local = dataRef.current;
    const base = lastSynced.current || {};
    let mergedData = local;
    let waiting = 0;
    for (const k of keys) {
      const res = mergeAviRows(local[k], remote[k], base[k], COLLECTION_KEYS[k]);
      waiting += res.localChanges;
      if (res.rows !== local[k]) mergedData = { ...mergedData, [k]: res.rows };
    }
    baseGen.current += 1;
    const nextBase = { ...base };
    for (const k of keys) nextBase[k] = remote[k];
    lastSynced.current = nextBase;
    if (keys.includes('wordInputs')) ownsRowsRef.current = true;
    setData(prev => {
      // An edit made after `local` was read is newer than both; it wins too.
      let out = mergedData;
      if (prev !== local) {
        out = prev;
        for (const k of keys) {
          const res = mergeAviRows(prev[k], mergedData[k], local[k], COLLECTION_KEYS[k]);
          if (res.rows !== prev[k]) out = { ...out, [k]: res.rows };
        }
      }
      if (pending.current || waiting) pending.current = out;
      return out;
    });
    if (waiting) {
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, DEBOUNCE_MS);
    }
  }, [flush]);

  // Reads Lemma Master (and the rows when asked) from the server and merges
  // them in. Returns false when the server couldn't be reached.
  const refreshRemote = useCallback(async ({ withRows }) => {
    if (!uid || refreshingRef.current) return false;
    refreshingRef.current = true;
    lastRefreshAt.current = Date.now();
    try {
      const remote = await aviLoadFromServer(uid, withRows);
      refreshingRef.current = false;
      applyRemote(remote);
      if (withRows) markAviRowsLoaded();
      return true;
    } catch (e) {
      console.warn('useAVIData: remote read failed', e);
      return false;
    } finally {
      refreshingRef.current = false;
    }
  }, [uid, applyRemote]);

  // Opening AVI: Lemma Master is always read; the rows too when App's copy
  // is stale. Waits for App's boot read of the rows (inputsLoaded), so a
  // cold start straight into AVI doesn't read them twice. `loading` holds
  // until this finishes, so the card cascades never see fresh Lemma Master
  // entries next to stale rows.
  const mountLoadStarted = useRef(false);
  useEffect(() => {
    if (!uid || !inputsLoaded || mountLoadStarted.current) return;
    mountLoadStarted.current = true;
    (async () => {
      const ok = await refreshRemote({ withRows: aviRowsStale() });
      if (!ok) {
        // Offline: Lemma Master from the device cache, as before S4.
        const cached = await aviLoad(uid);
        if (cached) applyRemote({ lemmaMaster: cached.lemmaMaster });
      }
      lmLoadedRef.current = true;
      setLemmaMasterLoaded(true);
    })();
  }, [uid, inputsLoaded, refreshRemote, applyRemote]);

  // Coming back to the front while AVI is open: re-read when the rows have
  // gone stale (a minute or more away, or 15 minutes old). At most once a
  // minute.
  useEffect(() => {
    if (!uid) return;
    const onFront = () => {
      if (document.visibilityState !== 'visible' || !lmLoadedRef.current) return;
      if (Date.now() - lastRefreshAt.current < REFRESH_MIN_GAP_MS) return;
      if (!aviRowsStale()) return;
      refreshRemote({ withRows: true });
    };
    document.addEventListener('visibilitychange', onFront);
    window.addEventListener('focus', onFront);
    return () => {
      document.removeEventListener('visibilitychange', onFront);
      window.removeEventListener('focus', onFront);
    };
  }, [uid, refreshRemote]);

  // S2: save right away when the app is hidden or closed instead of waiting
  // out the debounce (iOS suspends timers); Firestore's persistent cache
  // queues the write if the connection isn't there.
  useEffect(() => {
    const flushIfWaiting = () => { if (timer.current) flush(); };
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushIfWaiting(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flushIfWaiting);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flushIfWaiting);
    };
  }, [flush]);

  useEffect(() => {
    return () => {
      clearTimeout(timer.current);
      if (pending.current) flush();
    };
  }, [flush]);

  return { data, updateData, loading, syncStatus };
}
