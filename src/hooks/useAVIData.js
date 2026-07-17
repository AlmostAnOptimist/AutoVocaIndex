// src/hooks/useAVIData.js
// Firestore load/save for AVI collections: lemmaMaster.
// content_sources and content_sections, wordInputs, sentenceInputs are loaded by App.jsx and passed as props.
// currentSource/currentSection live in App.jsx's data.settings (aviCurrentSource/aviCurrentSection).
// AVI-specific settings are stored as avi-prefixed fields inside the shared settings/main document.
// Called once from AVIPage.jsx. Pattern matches useFirestore.js exactly.

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  collection, doc, getDocs, setDoc, writeBatch,
} from 'firebase/firestore';
import { db, auth } from '../firebase.js';

const DEBOUNCE_MS = 800;

// ── Firestore path helpers ────────────────────────────────────
const wordInputsCol  = (uid) => collection(db, 'users', uid, 'wordInputs');
const sentInputsCol  = (uid) => collection(db, 'users', uid, 'sentenceInputs');
const lemmaMasterCol = (uid) => collection(db, 'users', uid, 'lemmaMaster');
const settingsDoc    = (uid) => doc(db, 'users', uid, 'settings', 'main');

const wordDoc  = (uid, id) => doc(db, 'users', uid, 'wordInputs', id);
const sentDoc  = (uid, id) => doc(db, 'users', uid, 'sentenceInputs', id);
const lemmaDoc = (uid, id) => doc(db, 'users', uid, 'lemmaMaster', id);

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

// ── Diff-based collection sync ────────────────────────────────
async function syncCollection(uid, docFn, prevArr, nextArr, keyFn) {
  const prevMap = Object.fromEntries((prevArr || []).map(e => [keyFn(e), e]));
  const nextMap = Object.fromEntries((nextArr || []).map(e => [keyFn(e), e]));

  let batch = writeBatch(db);
  let ops = 0;
  const MAX = 490;

  const flush = async () => {
    if (ops === 0) return;
    await batch.commit();
    batch = writeBatch(db);
    ops = 0;
  };

  for (const [id, entry] of Object.entries(nextMap)) {
    // Reference-equality short-circuit: unchanged rows keep object identity
    // across immutable updates (updaters spread only the rows they touch),
    // so an identical reference never needs the stringify compare. Flush
    // cost scales with rows actually edited, not collection size.
    if (prevMap[id] === entry) continue;
    if (!prevMap[id] || JSON.stringify(prevMap[id]) !== JSON.stringify(entry)) {
      if (ops >= MAX) await flush();
      batch.set(docFn(uid, id), entry);
      ops++;
    }
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
    return;
  }

  for (const id of Object.keys(prevMap)) {
    if (!nextMap[id]) {
      if (ops >= MAX) await flush();
      batch.delete(docFn(uid, id));
      ops++;
    }
  }

  await flush();
}

// ── Sync AVI settings (merge into shared settings/main doc) ──
async function syncAviSettings(uid, prevSettings, nextSettings) {
  if (JSON.stringify(prevSettings) === JSON.stringify(nextSettings)) return;
  await setDoc(settingsDoc(uid), buildAviSettingsPayload(nextSettings), { merge: true });
}

// ── Hook: call from AVIPage.jsx ───────────────────────────────
export function useAVIData({ wordInputs: initWords = [], sentenceInputs: initSents = [], settingsData = null, inputsLoaded = false, onInputsChange = null } = {}) {
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

  useEffect(() => {
    if (!uid) return;
    (async () => {
      const remote = await aviLoad(uid);
      if (remote) setData(prev => ({ ...prev, lemmaMaster: remote.lemmaMaster }));
      setLemmaMasterLoaded(true);
    })();
  }, [uid]);

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

  // App.jsx loads wordInputs/sentenceInputs/settings asynchronously and can pass
  // them into this hook after it has already mounted with empty/default values
  // (e.g. AVI opened before App.jsx's getDocs calls resolve). Catch up to whatever
  // arrives, as long as no local edit has happened yet. Once the user starts
  // editing, local state becomes authoritative and must not be overwritten by a
  // late-arriving prop snapshot.
  const hasEditedRef = useRef(false);
  useEffect(() => {
    if (hasEditedRef.current) return;
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
    if (!hasEditedRef.current || !onInputsChange) return;
    onInputsChange(data.wordInputs, data.sentenceInputs);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.wordInputs, data.sentenceInputs, onInputsChange]);

  const flush = useCallback(async () => {
    if (!uid || !pending.current) return;
    const next = pending.current;
    setSyncStatus('syncing');
    try {
      const prev = lastSynced.current || {
        wordInputs: [], sentenceInputs: [], lemmaMaster: [],
        aviSettings: { ...DEFAULT_AVI_SETTINGS },
      };
      await Promise.all([
        syncCollection(uid, wordDoc,  prev.wordInputs,     next.wordInputs,     e => e.uid),
        syncCollection(uid, sentDoc,  prev.sentenceInputs, next.sentenceInputs, e => e.uid),
        syncCollection(uid, lemmaDoc, prev.lemmaMaster,    next.lemmaMaster,    e => e.lemmaID),
        syncAviSettings(uid, prev.aviSettings, next.aviSettings),
      ]);
      lastSynced.current = next;
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

  useEffect(() => {
    return () => {
      clearTimeout(timer.current);
      if (pending.current) flush();
    };
  }, [flush]);

  return { data, updateData, loading, syncStatus };
}
