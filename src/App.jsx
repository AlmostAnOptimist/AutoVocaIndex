import { useState, useEffect, useCallback, useRef, useMemo, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, updateDoc, collection, getDocs, getDocsFromServer, getDocsFromCache, writeBatch, query, where, setDoc, getDoc, onSnapshot, deleteDoc, deleteField } from 'firebase/firestore';
import { queueWrite } from './utils/queuedWrite.js';
import { useNewVersion } from './hooks/useNewVersion.js';
import {
  newestStamp, mergeChangedCards, createBumper, createRefreshGate,
  bumpCardsMarker, watchCardsMarker, readCardsChangedSince, onReviewInProgress,
} from './utils/cardsMarker.js';
import { db, auth } from './firebase.js';
import { ThemeContext } from './theme/ThemeContext.js';
import { useAppTheme } from './hooks/useAppTheme.js';
import { SH, frameBevelFilled } from './theme/buildStyles.js';
import { useOrnament } from './components/Ornaments.jsx';
import { MobileInfoSheet } from './components/MobileInfoSheet.jsx';

import { NavItem } from './components/NavItem.jsx';
import { fmtApptDate, fmtTime } from './components/AppointmentModal.jsx';
import { AddTaskModal } from './components/AddTaskModal.jsx';
import { EditTaskModal } from './components/EditTaskModal.jsx';
import { SignInScreen } from './components/SignInScreen.jsx';
import { Icons } from './components/Icons.jsx';

import { TodayPage } from './pages/TodayPage.jsx';
import { UpcomingPage } from './pages/UpcomingPage.jsx';
import { OverduePage } from './pages/OverduePage.jsx';
import { AppointmentsPage } from './pages/AppointmentsPage.jsx';
import { SettingsPage } from './pages/SettingsPage.jsx';
import { GrammarIndexPage } from './pages/GrammarIndexPage.jsx';
import { ContentLibraryPage, sectionTaskTitle } from './pages/ContentLibraryPage.jsx';
import { getSourceSections, normalizeLemma } from './utils/aviUtils.js';
import './utils/lemmaSecondOpinion.js'; // LM4: the analyser as the lemma resolver's second opinion
import { lackingDef2Rows } from './utils/lackingDef2.js';
import { loadGrammarEntries, readStored as readStoredGrammar, masteryCounts as grammarMasteryOf } from './utils/grammarEntriesStore.js';
import { AVISourceSearchSelect } from './components/avi/AVISourceSearchSelect.jsx';
import { AVIPage } from './pages/AVIPage.jsx';
import { ReadingCompanionPage } from './pages/ReadingCompanionPage.jsx';
import { NotesPage } from './pages/NotesPage.jsx';
import { FlashcardsPage } from './pages/FlashcardsPage.jsx';

import { lazyPage } from './components/LazyPage.jsx';

import { birbSrc, decoBlockStyle } from './utils/decoAssets.js';

import { uid, parseDate, toDateStr, getLogicalToday, getLogicalDateStr, getTaskDates, taskOccursOn, isDateDone } from './utils/dateUtils.js';
import { runDailyPipeline, filterActiveCards, DAILY_CAP } from './utils/srsEngine.js';
import { buildDeferralForecast } from './utils/deferralOutlook.js';
import { isDueToday } from './utils/fsrs.js';
import { runRecurrenceEngine, nextDueAfterCompletion, isOverdueTask, isUnscheduledTask } from './utils/recurrenceEngine.js';
import { mergeSameNameDecks } from './utils/cardDedupe.js';
import { getOrderedSectionsForSource, sectionDoneWrites } from './utils/contentUtils.js';
import { loadState, saveState, createInitialTasks } from './utils/storage.js';
import { firestoreLoad, useFirestoreSync, firestoreWriteTasksNow, firestoreWriteTaskFields, mergeRemoteData, mergeBootEdits, planRemoteRefresh } from './hooks/useFirestore.js';
import { DEMO, DEMO_LIMIT_NOTE, demoCapReached, isQuotaError, DEMO_TOUR, tourSampleSnapshot, tourSampleForecast } from './demo/demoConfig.js';
import { ensureDemoSeed } from './demo/seedCopy.js';
import { DemoBanner } from './demo/DemoBanner.jsx';
import { DemoCapacityScreen } from './demo/DemoCapacityScreen.jsx';
import { markAviRowsLoaded } from './hooks/useAVIData.js';
import { useLogicalDay } from './hooks/useLogicalDay.js';
import { resolveEditTarget, applyTaskEdit, applyFieldEdits, sameValue } from './utils/taskEdit.js';
import { planFollowUpPromotion } from './utils/apptPromotion.js';
import {
  THEME_KEY, SOUND_KEY, QUIZ_SOUND_KEY, CATEGORIES, themeIdOf,
  NAV_SECTIONS, PAGE_TITLES,
} from './constants.js';

// Loaded the first time they are opened, not with the rest of the app
// (offline decisions OF-D4). Don't import these two files normally anywhere:
// one ordinary import puts the whole page back into the first load
// (tests/lazy-pages-scan-golden.mjs checks).
const QuizzesPage  = lazyPage(() => import('./pages/QuizzesPage.jsx'),  m => m.QuizzesPage,  { label: 'Loading quizzes…' });
const DevDashboard = lazyPage(() => import('./pages/DevDashboard.jsx'), m => m.DevDashboard, { label: 'Loading Dev Dashboard…' });

// ── Shared flashcard data hook ────────────────────────────────
// Loads decks (phase 1) and cards (phase 2) once for the whole app session.
// Both FlashcardsPage and QuizzesPage receive this data as props — no duplicate reads.
// Decks: localStorage provides instant first render; Firestore refreshes in
// the background. Cards (offline decisions OF-D1): first shown from the copy
// Firestore itself keeps on the device, then refreshed from the server. The
// localStorage copy of the cards is gone: at about 3,400 cards it was
// roughly 2.5 MB of a 5 MB limit, rewritten on every grade. FC_CARDS_PREFIX
// is kept only to remove what older versions left behind.
const FC_CARDS_PREFIX = 'avi_fc_cards_';
const FC_DECKS_PREFIX = 'avi_fc_decks_';
// Per-device, per-uid stamp of the last logical day a forced server read of
// decks + flashcards succeeded. Drives the once-per-day freshness gate.
const FC_REFRESH_PREFIX = 'avi_fc_refresh_';

// Module-level so every component in this file can see it (AVISourceSelector
// in particular — it's defined outside the App function and was previously
// reaching for a local isMobile that didn't exist in its scope).
const isMobile = typeof window !== 'undefined' && (window.innerWidth <= 700 || window.matchMedia('(hover: none) and (pointer: coarse) and (orientation: portrait)').matches);

// Tablet rotation crosses the mobile/desktop layout boundary, but layout
// mode is baked in at module load — reload to re-evaluate. Gated to
// touch-only devices whose short edge exceeds the phone breakpoint, so
// phone rotation never triggers it.
// RC-D2: never on the reading companion. Its layout is fluid, and in split
// screen or pop-up view "orientation" is the window's shape, so resizing the
// pane would otherwise reload it (and empty its session list).
if (
  typeof window !== 'undefined' &&
  window.matchMedia('(hover: none) and (pointer: coarse)').matches &&
  Math.min(window.screen.width, window.screen.height) > 700
) {
  window.matchMedia('(orientation: portrait)').addEventListener('change', () => {
    if (window.location.hash === '#reading') return;
    location.reload();
  });
}

function fcRead(key) {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : null; } catch { return null; }
}
function fcWrite(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

// Deck ordering shared by the load effect and the daily refresh: grammar deck
// first, then by name.
function sortDeckRows(rows) {
  return [...rows].sort((a, b) => {
    if (a.id === 'deck_grammar') return -1;
    if (b.id === 'deck_grammar') return 1;
    return (a.name || '').localeCompare(b.name || '');
  });
}

// Drops backless vocabulary cards (grammar cards always kept).
function filterCardRows(rows) {
  return rows.filter(c => c.type === 'grammar' || (c.back !== '' && c.back != null));
}

// Key-order-independent serialization for change detection. A Firestore row
// and a locally-merged row can carry identical fields in different key order,
// which plain JSON.stringify would misreport as a change.
function stableStringify(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort()
    .map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

// Returns `next` as the authoritative row set (server wins; rows deleted
// elsewhere drop out) but reuses the existing object for any row whose content
// is unchanged, so only rows that actually changed get a new reference.
function mergeRowsPreservingIdentity(prev, next) {
  if (!prev) return next;
  const byId = new Map(prev.map(r => [r.id, r]));
  return next.map(r => {
    const cur = byId.get(r.id);
    return cur && stableStringify(cur) === stableStringify(r) ? cur : r;
  });
}

// Grammar entries and their mastery counts from this device's copy, for the
// first paint; App replaces them from loadGrammarEntries when a page that
// shows them opens (grammarEntriesStore.js).
function readGrammarMasteryCounts() {
  const { rows } = readStoredGrammar(localStorage);
  return rows ? grammarMasteryOf(rows) : null;
}

function readGrammarEntries() {
  return readStoredGrammar(localStorage).rows || [];
}

// Pages that show grammar entries. Opening one checks the entries marker
// (one read) and reads the entries only if they changed.
const GRAMMAR_ENTRY_PAGES = new Set(['flashcards', 'quizzes', 'grammar', 'content']);

function useFlashcardData(uid, dsh = 3) {
  const [decks,        setDecksState]  = useState(() => fcRead(uid ? FC_DECKS_PREFIX + uid : null) || []);
  const [cards,        setCardsState]  = useState(null);  // null = not yet loaded
  const [fcLoading,    setFcLoading]   = useState(() => !fcRead(uid ? FC_DECKS_PREFIX + uid : null));

  const decksKey   = uid ? FC_DECKS_PREFIX + uid : null;
  const cardsKey   = uid ? FC_CARDS_PREFIX + uid : null;
  const refreshKey = uid ? FC_REFRESH_PREFIX + uid : null;

  // Latest day-start-hour, readable from callbacks without re-creating them
  // or re-running the load effect.
  const dshRef = useRef(dsh);
  dshRef.current = dsh;
  const refreshInFlight = useRef(null);

  // OF-D1: free the space the old localStorage copy of the cards took.
  useEffect(() => {
    if (!cardsKey) return;
    try { localStorage.removeItem(cardsKey); } catch { /* storage unavailable */ }
  }, [cardsKey]);

  // ── Keeping cards in step across devices (OF-D2; utils/cardsMarker.js) ──
  // The newest changed-at stamp read from the server so far; the next
  // "changed since" read starts from it.
  // Only rows that came from the server count. The on-device copy also
  // holds this device's own latest writes, and going by their stamps would
  // skip an older change made elsewhere that this device hasn't read yet.
  // stampsKnownRef: a full server read has happened, so "nothing newer than
  // lastStampRef" is a true statement (even while no card is stamped yet).
  const lastStampRef   = useRef(null);
  const stampsKnownRef = useRef(false);
  const noteStamps = useCallback((rows, { fullRead = false } = {}) => {
    lastStampRef.current = newestStamp(rows, lastStampRef.current);
    if (fullRead) stampsKnownRef.current = true;
  }, []);
  // The startup read of the cards, so a "changed since" read can wait for it.
  const bootCardsRef = useRef(null);
  // Says "cards changed here" to the other devices, at most every 30 seconds.
  const bumper = useMemo(() => createBumper({
    bump: () => { if (uid) queueWrite(() => bumpCardsMarker(uid), 'App: cards marker update failed'); },
  }), [uid]);

  // Stable updaters. updateCards is for changes made on this device: it also
  // lets the other devices know. Rows read from Firestore go in through
  // setCardsState directly, so a refresh never announces itself as a change.
  const updateCards = useCallback((updater) => {
    setCardsState(prev => (typeof updater === 'function' ? updater(prev) : updater));
    bumper.touch();
  }, [bumper]);

  const updateDecks = useCallback((updater) => {
    setDecksState(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      fcWrite(decksKey, next);
      return next;
    });
  }, [decksKey]);

  // Load effect — runs once per uid
  useEffect(() => {
    if (!uid) return;

    // Daily freshness gate. Once per logical day per device the boot read is
    // forced to the server so a cache-served load cannot pin stale card
    // content for the whole day. Otherwise the cheap cache-permitted read is
    // fine. The stamp is written only after BOTH phases succeed from the
    // server; a fallback to cache leaves it unset so the next trigger retries.
    const todayStr  = getLogicalDateStr(dshRef.current);
    const needFresh = fcRead(refreshKey) !== todayStr;
    const bootOk    = { decks: false, cards: false, fresh: needFresh };
    const readCol = async (ref) => {
      if (!needFresh) return getDocs(ref);
      try { return await getDocsFromServer(ref); }
      catch (e) {
        bootOk.fresh = false;
        console.warn('App: server read failed, falling back to cache', e);
        return getDocs(ref);
      }
    };
    const maybeStamp = () => {
      if (bootOk.decks && bootOk.cards && bootOk.fresh) fcWrite(refreshKey, todayStr);
    };

    // Phase 1: decks (fast — lets FlashcardsPage grid render immediately)
    (async () => {
      try {
        const deckSnap = await readCol(collection(db, 'users', uid, 'decks'));
        const deckRows = deckSnap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .sort((a, b) => {
            if (a.id === 'deck_grammar') return -1;
            if (b.id === 'deck_grammar') return 1;
            return (a.name || '').localeCompare(b.name || '');
          });
        setDecksState(deckRows);
        fcWrite(decksKey, deckRows);
        bootOk.decks = true;
        maybeStamp();
      } catch (e) {
        console.error('App: deck load failed', e);
      } finally {
        setFcLoading(false);
      }
    })();

    // Phase 2: cards (background — pipeline runs here)
    bootCardsRef.current = (async () => {
      // OF-D1: first, what Firestore already holds on this device. It is
      // there in a fraction of a second, with or without a connection, and
      // is replaced by the server read below. Skipped when the device has
      // no copy yet, and never put over rows that have already arrived.
      try {
        const cached = await getDocsFromCache(collection(db, 'users', uid, 'flashcards'));
        if (!cached.empty) {
          const cachedRows = filterCardRows(cached.docs.map(d => ({ id: d.id, ...d.data() })));
          setCardsState(prev => prev ?? cachedRows);
        }
      } catch (e) {
        console.warn('App: no on-device copy of the cards yet', e);
      }
      try {
        const cardSnap = await readCol(collection(db, 'users', uid, 'flashcards'));
        const allRows  = cardSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        // Filter out backless vocabulary cards (grammar cards always kept)
        const cardRows = allRows.filter(c => c.type === 'grammar' || (c.back !== '' && c.back != null));
        setCardsState(prev => mergeRowsPreservingIdentity(prev, cardRows));
        if (!cardSnap.metadata?.fromCache) noteStamps(allRows, { fullRead: true });
        bootOk.cards = true;
        maybeStamp();
      } catch (e) {
        console.error('App: card load failed', e);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  // Decks and every card, from the server (throws when it can't be reached).
  const readAllFromServer = useCallback(async () => {
    const [deckSnap, cardSnap] = await Promise.all([
      getDocsFromServer(collection(db, 'users', uid, 'decks')),
      getDocsFromServer(collection(db, 'users', uid, 'flashcards')),
    ]);
    const deckRows = sortDeckRows(deckSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    const allRows  = cardSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const cardRows = filterCardRows(allRows);
    updateDecks(prev => mergeRowsPreservingIdentity(prev, deckRows));
    setCardsState(prev => mergeRowsPreservingIdentity(prev, cardRows));
    noteStamps(allRows, { fullRead: true });
  }, [uid, updateDecks, noteStamps]);

  // Resume-time daily refresh. Warm resumes (bfcache / PWA restore) never
  // re-run the load effect above, so without this a card edited on another
  // device could stay hidden on this one indefinitely. Gated to one server
  // read of decks + flashcards per logical day per device; the stamp is
  // written only on success so an offline attempt retries on the next
  // trigger. Rows merge preserving object identity — unchanged cards keep
  // their references and only rows that actually changed are replaced.
  // A call made while a refresh is running waits for it (T4: the day-flip
  // resync and a tab return can overlap; the pipeline must not run on the
  // pre-refresh cards because the second caller returned early).
  const refreshFlashcardsIfStale = useCallback(() => {
    if (!uid) return Promise.resolve();
    if (refreshInFlight.current) return refreshInFlight.current;
    const todayStr = getLogicalDateStr(dshRef.current);
    if (fcRead(refreshKey) === todayStr) return Promise.resolve();
    refreshInFlight.current = (async () => {
    try {
      await readAllFromServer();
      fcWrite(refreshKey, todayStr);
    } catch (e) {
      console.warn('App: daily flashcard refresh failed (will retry on next trigger)', e);
    } finally {
      refreshInFlight.current = null;
    }
    })();
    return refreshInFlight.current;
  }, [uid, refreshKey, readAllFromServer]);

  // OF-D2: another device changed cards (the marker moved). Read only the
  // cards stamped since the newest one seen here, and the decks with them
  // (a few dozen documents; a new deck or a changed count comes along).
  // At most once a minute and never during a review: the gate holds the
  // read until the session ends. The daily read above stays as the
  // fallback for deleted cards and any write that missed the stamp.
  const readChangedCards = useCallback(async () => {
    if (!uid) return;
    try {
      // Let the startup read finish first; it may make this one unnecessary.
      try { await bootCardsRef.current; } catch { /* its own handler logged it */ }
      // No full server read yet on this run (the app started offline, from
      // the on-device copy): there is no "since" to ask from, so read all.
      if (!stampsKnownRef.current) { await readAllFromServer(); return; }
      const [rows, deckSnap] = await Promise.all([
        readCardsChangedSince(uid, lastStampRef.current),
        getDocsFromServer(collection(db, 'users', uid, 'decks')),
      ]);
      const deckRows = sortDeckRows(deckSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      updateDecks(prev => mergeRowsPreservingIdentity(prev, deckRows));
      if (!rows.length) return;
      noteStamps(rows);
      setCardsState(prev => mergeChangedCards(prev, rows, c => filterCardRows([c]).length > 0));
    } catch (e) {
      console.warn('App: reading changed cards failed (the daily refresh will catch up)', e);
    }
  }, [uid, updateDecks, noteStamps, readAllFromServer]);
  const changedGate = useMemo(() => createRefreshGate({ run: readChangedCards }), [readChangedCards]);
  useEffect(() => {
    if (!uid) return;
    const stopWatching = watchCardsMarker(uid, changedGate.request);
    // A review holds the read; when it ends, the read (if one is waiting)
    // runs and the marker update for the session's last grades goes out.
    const stopReview = onReviewInProgress((active) => {
      changedGate.hold(active);
      if (!active) bumper.flush();
    });
    const flushIfHidden = () => { if (document.visibilityState === 'hidden') bumper.flush(); };
    const flushNow = () => bumper.flush();
    document.addEventListener('visibilitychange', flushIfHidden);
    window.addEventListener('pagehide', flushNow);
    return () => {
      stopWatching();
      stopReview();
      changedGate.cancel();
      document.removeEventListener('visibilitychange', flushIfHidden);
      window.removeEventListener('pagehide', flushNow);
    };
  }, [uid, changedGate, bumper]);

  return { cards, decks, fcLoading, updateCards, updateDecks, refreshFlashcardsIfStale };
}

// ── Quick Add Buttons ─────────────────────────────────────────────────────────
function QuickAddButtons({ onAdd }) {
  const { C, S } = useAppTheme();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      {CATEGORIES.map(cat => (
        <button
          key={cat.id}
          style={S.quickAddBtn()}
          className="quick-add-btn"
          onClick={() => onAdd(cat.id)}
          title={`Add ${cat.label} task`}
        >
          <div style={S.quickAddDot(cat.color(C))} />
          {cat.label}
        </button>
      ))}
    </div>
  );
}

// ── AVI Source Selector (shown in topbar when on AVI page) ───
function AVISourceSelector({ sources, sections, currentSource, currentSection, onUpdate, C, S }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const activeSrc = sources.find(s => s.title === currentSource);
  const srcSections = getSourceSections(sources, sections, currentSource);

  const selects = (
    <>
      <AVISourceSearchSelect
        sources={sources}
        value={currentSource}
        onChange={title => onUpdate({ aviCurrentSource: title, aviCurrentSection: '' })}
        excludePassive
        style={{ width: isMobile ? '100%' : '140px' }}
        C={C}
      />
      <select value={currentSection} onChange={e => onUpdate({ aviCurrentSection: e.target.value })}
        disabled={!activeSrc || srcSections.length === 0}
        style={{ fontSize: '12px', padding: '3px 8px', borderRadius: '6px', border: `1px solid ${C.border}`, background: C.raised, color: C.text, cursor: activeSrc ? 'pointer' : 'default', outline: 'none', opacity: (!activeSrc || srcSections.length === 0) ? 0.4 : 1, maxWidth: isMobile ? 'none' : '90px', width: isMobile ? '100%' : undefined, marginTop: isMobile ? '10px' : 0 }}>
        <option value="">(All sections)</option>
        {srcSections.map(s => <option key={s.id} value={s.content}>{s.content}</option>)}
      </select>
    </>
  );

  if (isMobile) {
    return (
      <>
        <button
          onClick={() => setSheetOpen(true)}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', fontWeight: 600, color: C.textS, background: C.raised, border: `1px solid ${C.border}`, borderRadius: '7px', padding: '6px 9px', cursor: 'pointer', maxWidth: '150px' }}
        >
          <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: C.accent, flexShrink: 0 }} />
          <span style={{ fontFamily: SH.fk, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {currentSource || 'Select source'}
          </span>
        </button>
        <MobileInfoSheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Source">
          <div style={{ display: 'flex', flexDirection: 'column' }}>{selects}</div>
        </MobileInfoSheet>
      </>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span className="topbar-desktop" style={{ fontSize: '11px', fontWeight: 600, color: C.textM, letterSpacing: '0.06em', textTransform: 'uppercase', flexShrink: 0 }}>
          Source:
        </span>
        {selects}
    </div>
  );
}

// ── Reading companion button (RC-D4) ─────────────────────────
// In the header on AVI: between the source selector and Nav on mobile, to
// the right of the source and section selectors on desktop. Styled like the
// Content Library's Module Reader button, so it doesn't read as a chip.
function ReadingCompanionButton({ onOpen, C }) {
  const orn = useOrnament();
  return (
    <button type="button" onClick={onOpen} aria-label="Open the reading companion" title="Reading companion"
      style={{
        minHeight: isMobile ? 38 : 34, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '7px',
        cursor: 'pointer', padding: isMobile ? '0 11px' : '0 14px', flexShrink: 0,
        fontFamily: SH.fp, fontSize: '13px', fontWeight: 700, letterSpacing: '0.08em',
        background: C.accent, color: C.accentText || '#ffffff', border: `1px solid ${C.accent}`,
        boxShadow: `inset 0 0 0 2px ${C.accent}, inset 0 0 0 3px rgba(255,255,255,0.5)`,
      }}>
      <svg aria-hidden="true" width="16" height="15" viewBox="0 0 16 15"><path d="M8 3.2C6.4 2 4.2 1.6 1.5 1.8v10.4c2.7-.2 4.9.2 6.5 1.4 1.6-1.2 3.8-1.6 6.5-1.4V1.8C11.8 1.6 9.6 2 8 3.2z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /><line x1="8" y1="3.2" x2="8" y2="13.6" stroke="currentColor" strokeWidth="1.4" /><polygon points="8,6.6 9.4,8 8,9.4 6.6,8" fill={orn.jewel} /></svg>
      Reading
    </button>
  );
}

// ── Pages reachable by hash (U4) ──────────────────────────────────────────────
// Every nav item plus Settings. A reload or Back/Forward to one of these
// opens it; anything else (an empty hash) is Today. The old hard-coded list
// left out Finance and Health (a reload there went to Today) and had a
// 'notes' page the app doesn't render.
// RC-D2/RC-D3: plus the reading companion (#reading; the installed app's
// "Reading companion" shortcut opens it).
const PAGE_IDS = new Set([...NAV_SECTIONS.flatMap(s => s.items.map(i => i.id)), 'settings', 'reading']);
function pageFromHash(hash) {
  const id = String(hash || '').replace(/^#/, '');
  if (!id) return 'today';
  return PAGE_IDS.has(id) ? id : null;
}

// ── Nav icon map ──────────────────────────────────────────────────────────────
const NAV_ICONS = {
  today:       Icons.clock,
  upcoming:    Icons.cal,
  overdue:     Icons.alert,
  appointments: Icons.appt,
  grammar:     Icons.bookClosed,
  content:     Icons.bookOpen,
  flashcards:  Icons.cardDeck,
  quizzes:     Icons.q,
  avi:         Icons.diamond,
  notes:       Icons.note,
};

// ── Inner app (consumes ThemeContext) ─────────────────────────────────────────
function InnerApp({
  data, page, setPage,
  addOpen, setAddOpen, addCat,
  editTask, editOpen, openEdit, closeEdit,
  saveTask, deleteTask,
  toast, showToast, dsh, logicalDay, tasks,
  todayCount, overdueCount,
  toggleTask, addTask, openAddTask,patchTask,
  registerSectionUpdateCallback,
  updateData, soundProfile, setSoundProfile,
  quizSoundsEnabled, setQuizSoundsEnabled,
  syncStatus, user, onSignOut,
  flashcardDue,
  srsSnapshot, deferralForecast,
  cards, decks, fcLoading, updateCards, updateDecks,
  noteTarget, setNoteTarget, grammarTarget, setGrammarTarget, sightingsTarget, setSightingsTarget,
  grammarMasteryCounts, onMasteryCounts, getCardNextDueDate, onCardNextDueDateChanged,
  grammarEntries, onEntriesChange, flashcardStudyTarget, setFlashcardStudyTarget,
  echoDeckTarget, setEchoDeckTarget,
  correctionTarget, setCorrectionTarget,
  correctionSessionTarget, setCorrectionSessionTarget,
  contentSourceTarget, setContentSourceTarget,
  aviSources, aviSections,
  aviWordSectionCounts, aviSentSectionCounts,
  aviWordInputs, aviSentenceInputs, aviInputsLoaded, onAVISourceUpdate, onAVIInputsChange, onAviSettingsChange,
  appointments, saveAppointment, deleteAppointment,
  onSectionComplete,
  onSourcesChange, onSectionsChange, onSourceRename, onSourceCascadeComplete,
  plannerCommit,
}) {
  const { C, S, G, theme } = useAppTheme();
  // U1: every page opens at the top. All pages share one scroller
  // (.content-pad), so without this a page opened scrolled as far down as
  // the page before it.
  const contentRef = useRef(null);
  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [page]);
  const [moreOpen,              setMoreOpen]              = useState(false);
  // A Settings tab to open on arrival (the More menu's Appearance entry).
  const [settingsTabRequest,    setSettingsTabRequest]    = useState(null);
  const [pendingApptLink,       setPendingApptLink]       = useState(null);
  // Reading companion (RC-D12): a session entry opens in AVI's Search tab.
  const [aviSearchTarget,       setAviSearchTarget]       = useState(null);
  // Lacking Def2 (audit B5): how many words have no Definition 2, for
  // Today's flag. Tapping it sends a request to AVI, which hosts the queue
  // (the Import tab's Fill Def2 modal) because it has what the modal needs
  // loaded; closing the queue comes back to Today.
  const lackingDef2 = useMemo(() => lackingDef2Rows(aviWordInputs, normalizeLemma), [aviWordInputs]);
  const [def2QueueRequest, setDef2QueueRequest] = useState(null); // { uids, uid, from: 'today' } | null
  const openDef2QueueFromToday = useCallback(() => {
    if (!lackingDef2.length) return;
    setDef2QueueRequest({ uids: lackingDef2.map(r => r.uid), uid: lackingDef2[0].uid, from: 'today' });
    setPage('avi');
  }, [lackingDef2, setPage]);
  const [clTriggerAddSource,    setCLTriggerAddSource]    = useState(0);
  const [clTriggerAddQuestion,  setCLTriggerAddQuestion]  = useState(0);
  const [clTriggerAddNote,      setCLTriggerAddNote]      = useState(0);
const [clTriggerAddCorrection,setCLTriggerAddCorrection]= useState(0);

  // iOS keyboard scroll-restore: when an input focuses, Safari scrolls the
  // window itself to reveal it (even though the shell is overflow:hidden),
  // and never scrolls back after the keyboard closes -- the topbar ends up
  // pushed above the screen edge and stays there across page navigation.
  // On focusout, once no input/textarea/select holds focus, snap window
  // scroll back to origin. The timeout lets input-to-input focus moves
  // settle so the view doesn't jerk mid-typing.
  useEffect(() => {
    if (!isMobile) return;
    const restore = () => {
      setTimeout(() => {
        const el = document.activeElement;
        const stillTyping = el && (
          el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' || el.isContentEditable
        );
        if (!stillTyping && (window.scrollY !== 0 || window.scrollX !== 0)) {
          window.scrollTo(0, 0);
        }
      }, 100);
    };
    document.addEventListener('focusout', restore);
    return () => document.removeEventListener('focusout', restore);
  }, []);

  const upcomingLangAppt = useMemo(() => {
    return appointments
      .filter(a => a.category === 'lang' && a.date >= logicalDay)
      .sort((a, b) => a.date !== b.date ? a.date.localeCompare(b.date) : (a.time || '').localeCompare(b.time || ''))
      [0] || null;
  }, [appointments, logicalDay]);

  const dateStr = new Date(logicalDay + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  // ── Sidebar collapse (Phase E1) ──
  // Auto-collapses below 1340px -- the width at which the Content Library
  // deco panel can no longer render beside the full 220px sidebar. The
  // collapsed 56px icon rail buys the panel room down to ~1176px. A manual
  // toggle overrides auto and persists in localStorage; crossing the
  // threshold in either direction clears the override so auto takes back
  // over. Desktop-only: mobile hides the sidebar entirely via CSS.
  const [winW, setWinW] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1400));
  const [sidebarManual, setSidebarManual] = useState(() => {
    try { return localStorage.getItem('avi_sidebar'); } catch { return null; }
  });
  const prevAutoRef = useRef(null);
  useEffect(() => {
    if (isMobile) return;
    const onResize = () => setWinW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const autoCollapsed = winW < 1340;
  useEffect(() => {
    if (prevAutoRef.current !== null && prevAutoRef.current !== autoCollapsed) {
      setSidebarManual(null);
      try { localStorage.removeItem('avi_sidebar'); } catch {}
    }
    prevAutoRef.current = autoCollapsed;
  }, [autoCollapsed]);
  const sidebarCollapsed = !isMobile && (sidebarManual ? sidebarManual === 'collapsed' : autoCollapsed);
  const toggleSidebar = () => {
    const next = sidebarCollapsed ? 'open' : 'collapsed';
    setSidebarManual(next);
    try { localStorage.setItem('avi_sidebar', next); } catch {}
  };
  // Deco panel renders when the main area (window minus current sidebar
  // width) has at least the 1120px it needed under the old 1340px check.
  const showDecoPanel = !isMobile && (winW - (sidebarCollapsed ? 56 : 220)) >= 1120;

  const MNAV = [
  { id: 'today',      icon: Icons.clock,    l: 'Today'    },
  { id: 'flashcards', icon: Icons.cardDeck, l: 'Cards'    },
  { id: 'quizzes',    icon: Icons.q,        l: 'Quiz'     },
  { id: 'avi',        icon: Icons.diamond,  l: 'AVI'      },
  { id: '__more',     icon: Icons.list,     l: 'More'     },
];

  const sharedPageProps = { tasks, onToggle: toggleTask, onEdit: openEdit, dsh, soundProfile, updateData, flashcardDue, settings: data.settings || {}, appointments,
 };

  // ── Reading companion (RC-D2): its own page, without the sidebar, topbar
  // or tab bar, for a split-screen pane or a pop-up window beside a reader.
  if (page === 'reading') {
    return (
      <>
        <style>{G}</style>
        <ReadingCompanionPage
          cards={cards}
          decks={decks}
          updateCards={updateCards}
          updateDecks={updateDecks}
          aviSources={aviSources}
          aviSections={aviSections}
          wordInputs={aviWordInputs}
          sentenceInputs={aviSentenceInputs}
          inputsLoaded={aviInputsLoaded}
          settings={data.settings || {}}
          onAVIInputsChange={onAVIInputsChange}
          onAviSettingsChange={onAviSettingsChange}
          onSectionComplete={onSectionComplete}
          onOpenAVI={() => setPage('avi')}
          onOpenInSearch={(q) => { setAviSearchTarget(q || ''); setPage('avi'); }}
        />
      </>
    );
  }

  return (
    <>
      <style>{G}</style>
      <div style={S.root}>

        {/* Birb — fixed to viewport, only on Today page (desktop only) */}
        {(page === 'today' || page === 'appointments') && !isMobile && (
          <div style={{
            position: 'fixed',
            top: '74px',
            right: 0,
            bottom: 0,
            width: 'calc((100vw - 220px) / 3)',
            pointerEvents: 'none',
            // On Today the image sits one layer down so the Lacking Def2
            // flag, which hangs off the reviews card, can show over it
            // (audit B5). Nothing else on Today reaches under the image.
            zIndex: page === 'today' ? 0 : 9,
          }}>
            {birbSrc ? (
              <img
                src={birbSrc}
                alt="decorative birb"
                style={{ width: '100%', height: 'auto', display: 'block', opacity: 0.92 }}
              />
            ) : (
              <div style={{ ...decoBlockStyle(C), width: '100%', aspectRatio: '3 / 4', opacity: 0.5 }} />
            )}
          </div>
        )}

        {/* SIDEBAR */}
        <nav style={{ ...S.sidebar, ...(sidebarCollapsed && { width: '56px', minWidth: '56px' }), transition: 'width 0.2s ease, min-width 0.2s ease' }} className="sidebar">
          <div style={{ ...S.logoWrap, ...(sidebarCollapsed && { padding: 0, justifyContent: 'center' }) }}>
            {!sidebarCollapsed && <span style={S.logoText}>AutoVocaIndex</span>}
          </div>
          <div style={S.sidebarScroll}>
            <div
              onClick={toggleSidebar}
              className="nav-hover"
              title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              style={{ display: 'flex', justifyContent: sidebarCollapsed ? 'center' : 'flex-end', alignItems: 'center', padding: '6px 10px', cursor: 'pointer', color: C.textM, borderRadius: '6px', margin: '6px 6px 0' }}
            >
              {sidebarCollapsed ? Icons.chevronRight : Icons.chevronLeft}
            </div>
            {NAV_SECTIONS.map(sec => (
              <div key={sec.label} style={S.navSection}>
                {!sidebarCollapsed && <span style={S.navLabel}>{sec.label}</span>}
                {sec.items.map(item => (
                  <NavItem
                    key={item.id}
                    icon={NAV_ICONS[item.id]}
                    label={item.label}
                    desc={item.desc}
                    active={page === item.id}
                    badge={item.id === 'today' ? todayCount : item.id === 'overdue' ? overdueCount : item.id === 'flashcards' ? flashcardDue : undefined}
                    badgeDanger={item.badgeDanger}
                    phase={item.phase}
                    onClick={() => setPage(item.id)}
                    collapsed={sidebarCollapsed}
                  />
                ))}
              </div>
            ))}
            <div style={{ height: '60px' }} />
          </div>
          <div style={S.sidebarBottom}>
            <NavItem icon={Icons.gear} label="Settings" active={page === 'settings'} onClick={() => setPage('settings')} collapsed={sidebarCollapsed} />

            {/* Sync status -- the dot stays as the ambient sync-error
                indicator in both states; the text label hides in the rail.
                Full status, email, and sign out live in Settings (E1). */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: sidebarCollapsed ? 'center' : 'flex-start', gap: '6px', padding: '6px 10px', marginTop: '4px' }}>
              <div style={S.syncDot(syncStatus)} />
              {!sidebarCollapsed && (
                <span style={S.syncLabel}>
                  {syncStatus === 'ok'      ? 'Synced'     :
                   syncStatus === 'syncing' ? 'Syncing…'   :
                   syncStatus === 'error'   ? 'Sync error' : 'Local only'}
                </span>
              )}
            </div>
            {!sidebarCollapsed && (
              <a
                href="https://ko-fi.com/autovocaindex"
                target="_blank"
                rel="noopener noreferrer"
                style={{ display: 'block', padding: '10px 2px 0', textDecoration: 'none' }}
              >
                <img
                  src={['ember', 'baroque', 'feather'].includes(theme) ? '/kofi-dark.png' : '/kofi-beige.png'}
                  alt="Support me on Ko-fi"
                  style={{ width: '100%', height: 'auto', display: 'block' }}
                />
              </a>
            )}
          </div>
        </nav>

        {/* MAIN */}
        <main style={S.main}>
          <div style={{ ...S.topbar, justifyContent: isMobile ? 'center' : 'space-between', ...(isMobile && (page === 'flashcards' || page === 'quizzes' || page === 'grammar' || page === 'upcoming') && { height: 0, minHeight: 0, overflow: 'hidden', borderBottom: 'none', padding: 0 }) }}>
            {page === 'avi'
              ? <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                  <AVISourceSelector
                    sources={aviSources} sections={aviSections}
                    currentSource={data.settings?.aviCurrentSource || ''}
                    currentSection={data.settings?.aviCurrentSection || ''}
                    onUpdate={onAVISourceUpdate}
                    C={C} S={S}
                  />
                  {!isMobile && <ReadingCompanionButton onOpen={() => setPage('reading')} C={C} />}
                </div>
              : DEMO
              ? <div className="topbar-desktop" style={{ display: 'flex', alignItems: 'center' }}>
                  <DemoBanner variant="chip" />
                </div>
              : page === 'content'
              ? <div style={S.topbarDate} className="topbar-desktop">
                  {upcomingLangAppt
                    ? `${upcomingLangAppt.provider || 'Lesson'} · ${fmtApptDate(upcomingLangAppt.date)}${upcomingLangAppt.time ? ` · ${fmtTime(upcomingLangAppt.time)}` : ''}`
                    : <span style={{ opacity: 0.45 }}>No lessons scheduled</span>
                  }
                </div>
              : <div style={S.topbarDate} className="topbar-desktop">{dateStr}</div>
            }
            <div style={{ ...S.topbarActions, marginLeft: isMobile ? 0 : 'auto' }}>
              {page === 'content' && (
                <>
                  <button style={{ ...S.btnPrimary, ...S.btnMetallic }} onClick={() => setCLTriggerAddSource(n    => n + 1)}>+ Source</button>
                  <button style={{ ...S.btnPrimary, ...S.btnMetallic }} onClick={() => setCLTriggerAddQuestion(n  => n + 1)}>+ Q</button>
                  <button style={{ ...S.btnPrimary, ...S.btnMetallic }} onClick={() => setCLTriggerAddNote(n      => n + 1)}>+ Note</button>
                  <button style={{ ...S.btnPrimary, ...S.btnMetallic }} onClick={() => setCLTriggerAddCorrection(n => n + 1)}>+ Corrections</button>
                </>
              )}
              {page === 'avi' && isMobile
                ? <><ReadingCompanionButton onOpen={() => setPage('reading')} C={C} /><div id="avi-nav-slot" /></>
                : (page === 'content' || page === 'flashcards' || page === 'quizzes') && isMobile
                ? null
                : <QuickAddButtons onAdd={cat => openAddTask(cat)} />
              }
            </div>
          </div>
          {DEMO && (isMobile || page === 'avi') && <DemoBanner variant="strip" />}
          <div ref={contentRef} style={S.contentArea} className={page === 'avi' ? 'content-pad content-pad-flush' : 'content-pad'}>
            {page === 'today' && (
              <TodayPage
                {...sharedPageProps}
                cards={cards}
                lackingDef2Count={lackingDef2.length}
                onOpenDef2Queue={openDef2QueueFromToday}
                srsSnapshot={srsSnapshot}
                deferralForecast={deferralForecast}
              />
            )}
            {page === 'upcoming'    && <UpcomingPage     {...sharedPageProps} clSources={aviSources} clSections={aviSections} onPlannerCommit={plannerCommit} />}
            {page === 'overdue'     && <OverduePage      {...sharedPageProps} />}
            {page === 'appointments' && (
              <AppointmentsPage
                  appointments={appointments}
                  saveAppointment={saveAppointment}
                  deleteAppointment={deleteAppointment}
                  dsh={dsh}
                  settings={data.settings || {}}
                  updateData={updateData}
                  aviSources={aviSources}
                  aviSections={aviSections}
                  onSectionComplete={onSectionComplete}
                  tasks={tasks}
                  onToggle={toggleTask}
                  onDeleteTask={deleteTask}
                  onNavigateToNote={(id) => { setNoteTarget(id); setPage('content'); }}
                  onNavigateToCorrection={(id) => { setCorrectionSessionTarget(id); setPage('content'); }}
                  onNavigateToNewNote={(apptId) => { setPendingApptLink({ key: crypto.randomUUID(), apptId, mode: 'note' }); setPage('content'); }}
                  onNavigateToNewCorrection={(apptId) => { setPendingApptLink({ key: crypto.randomUUID(), apptId, mode: 'correction' }); setPage('content'); }}
                />
            )}
            {page === 'settings'    && (
              <SettingsPage
                settings={data.settings || {}}
                onUpdate={s => updateData(prev => ({ ...prev, settings: s }))}
                soundProfile={soundProfile}
                setSoundProfile={setSoundProfile}
                quizSoundsEnabled={quizSoundsEnabled}
                setQuizSoundsEnabled={setQuizSoundsEnabled}
                cards={cards}
                uid={user?.uid}
                user={user}
                syncStatus={syncStatus}
                onSignOut={onSignOut}
                tabRequest={settingsTabRequest}
                onTabRequestDone={() => setSettingsTabRequest(null)}
              />
            )}
{page === 'grammar'    && <GrammarIndexPage defaultOpenEntryId={grammarTarget} sightingsRequest={sightingsTarget} onSightingsRequestConsumed={() => setSightingsTarget(null)} sentenceInputs={aviSentenceInputs} librarySources={aviSources} librarySections={aviSections} onNavigateToFlashcard={(cardIdOrIds) => { setFlashcardStudyTarget(Array.isArray(cardIdOrIds) ? cardIdOrIds : [cardIdOrIds]); setPage('flashcards'); }} onNavigateToNote={(noteId) => { setNoteTarget(noteId); setPage('content'); }} onNavigateToContent={(sourceId) => { setContentSourceTarget(sourceId); setPage('content'); }} onMasteryCounts={onMasteryCounts} onEntriesChange={onEntriesChange} getCardNextDueDate={getCardNextDueDate} onCardNextDueDateChanged={onCardNextDueDateChanged} updateCards={updateCards} cards={cards} dsh={dsh} />}
{page === 'content'  && <ContentLibraryPage showDecoPanel={showDecoPanel} soundProfile={soundProfile} onNavigateToGrammar={(entryId) => { setGrammarTarget(entryId); setPage('grammar'); }} onReviewSightings={(unitKey) => { setGrammarTarget(null); setSightingsTarget(unitKey); setPage('grammar'); }} onNavigateToNote={(noteId) => { setNoteTarget(noteId); setPage('content'); }} addTask={addTask} defaultOpenSourceId={contentSourceTarget} onNavigateToCorrection={(id) => { setCorrectionSessionTarget(id); setPage('content'); }}
 aviSources={aviSources} aviSections={aviSections} aviWordSectionCounts={aviWordSectionCounts} aviSentSectionCounts={aviSentSectionCounts} onSourcesChange={onSourcesChange} onSectionsChange={onSectionsChange} onSourceRename={onSourceRename} tasks={tasks} onCompleteLinkedTask={toggleTask} patchTask={patchTask} registerSectionUpdateCallback={registerSectionUpdateCallback} settings={data.settings || {}} appointments={appointments} cards={cards || []} decks={decks || []} grammarMasteryCounts={grammarMasteryCounts} noteTarget={noteTarget} correctionTarget={correctionTarget} correctionSessionTarget={correctionSessionTarget} pendingApptLink={pendingApptLink} onApptLinkConsumed={() => setPendingApptLink(null)}
wordInputs={aviWordInputs} sentenceInputs={aviSentenceInputs}
updateCards={updateCards} updateDecks={updateDecks} onSourceCascadeComplete={onSourceCascadeComplete}
triggerAddSource={clTriggerAddSource} triggerAddQuestion={clTriggerAddQuestion}
triggerAddNote={clTriggerAddNote} triggerAddCorrection={clTriggerAddCorrection}
onDeleteTask={deleteTask} />}
{page === 'flashcards' && <FlashcardsPage soundProfile={soundProfile} dsh={dsh} onNavigateToGrammar={(entryId) => { setGrammarTarget(entryId); setPage('grammar'); }} cards={cards} decks={decks} fcLoading={fcLoading} updateCards={updateCards} updateDecks={updateDecks} grammarMasteryCounts={grammarMasteryCounts} grammarEntries={grammarEntries} flashcardStudyTarget={flashcardStudyTarget} setFlashcardStudyTarget={setFlashcardStudyTarget} fsrsSettings={data.settings?.fsrs || {}} srsSnapshot={srsSnapshot} deferralForecast={deferralForecast} settings={data.settings || {}} onEchoDeck={(deckId) => { setEchoDeckTarget(deckId); setPage('quizzes'); }} onNotice={showToast} aviSources={aviSources} sentenceInputs={aviSentenceInputs} />}
{page === 'quizzes' && <QuizzesPage soundProfile={soundProfile} quizSoundsEnabled={quizSoundsEnabled} cards={cards} decks={decks} settings={data.settings || {}} grammarEntries={grammarEntries} onNavigateToGrammar={(entryId) => { setGrammarTarget(entryId); setPage('grammar'); }} onPracticeGrammarCards={(cardIds) => { setFlashcardStudyTarget(cardIds); setPage('flashcards'); }} wordInputs={aviWordInputs} aviSources={aviSources} aviSections={aviSections} echoDeckTarget={echoDeckTarget} onEchoDeckTargetUsed={() => setEchoDeckTarget(null)} onNotice={showToast} />}
{page === 'avi' && (
  <AVIPage
    cards={cards}
    decks={decks}
    updateCards={updateCards}
    updateDecks={updateDecks}
    currentSource={data.settings?.aviCurrentSource || ''}
    currentSection={data.settings?.aviCurrentSection || ''}
    aviSources={aviSources}
    aviSections={aviSections}
    wordInputs={aviWordInputs}
    sentenceInputs={aviSentenceInputs}
    onAVIInputsChange={onAVIInputsChange}
    onAviSettingsChange={onAviSettingsChange}
    inputsLoaded={aviInputsLoaded}
    settings={data.settings || {}}
    onNavigateToFlashcards={() => setPage('flashcards')}
    searchTarget={aviSearchTarget}
    onSearchTargetConsumed={() => setAviSearchTarget(null)}
    def2QueueRequest={def2QueueRequest}
    onDef2QueueRequestConsumed={() => setDef2QueueRequest(null)}
    onDef2QueueReturn={() => setPage('today')}
  />
)}
            {/* U6: bottom clearance on phones/tablets for every page (CSS shows
                it there only); AVI keeps its own (flush layout). */}
            {page !== 'avi' && <div className="content-bottom-spacer" aria-hidden="true" />}
          </div>
        </main>

        {/* PANELS & MODALS */}
        <AddTaskModal
          open={addOpen}
          onClose={() => setAddOpen(false)}
          onSave={addTask}
          defaultCategory={addCat || data.settings?.defaultCategory || 'lang'}
          appointments={appointments}
          saveAppointment={saveAppointment}
          settings={data.settings || {}}
        />
        <EditTaskModal
          task={editTask}
          open={editOpen}
          onClose={closeEdit}
          onSave={saveTask}
          onDelete={deleteTask}
          appointments={appointments}
          dsh={dsh}
        />

        {toast && <div style={S.toast}>{toast}</div>}

        {/* MORE DRAWER — portaled to document.body so it stacks above any
            open detail panel (MobileInfoSheet overlays sit at z 1400, and the
            page tree can trap position:fixed via animation/filter containing
            blocks — the .fade-up gotcha). Scrim closes only the tray; picking
            a destination navigates, which unmounts any open panel —
            navigation wins. The scrim intercepts touch, so no scroll lock is
            needed (body is already overflow:hidden globally). */}
        {moreOpen && createPortal(
          <>
            <div
              style={{ position: 'fixed', inset: 0, zIndex: 1500, background: 'rgba(0,0,0,0.35)', overscrollBehavior: 'contain', touchAction: 'none' }}
              onClick={() => setMoreOpen(false)}
            />
            <div style={{
              position: 'fixed', bottom: '56px', left: '10px', right: '10px', zIndex: 1501,
              background: 'transparent', backgroundClip: 'padding-box',
              border: '8px solid transparent', borderRadius: 0,
              borderImageSource: frameBevelFilled(C.borderB, C.cardBg || C.surface),
              borderImageSlice: '6 fill', borderImageWidth: '8px', borderImageRepeat: 'stretch',
              display: 'flex', flexDirection: 'column', padding: '4px 0',
            }}>
              {[
                [
                  { id: 'overdue',      icon: Icons.alert,      l: 'Overdue'         },
                  { id: 'upcoming',     icon: Icons.cal,        l: 'Upcoming'        },
                  { id: 'appointments', icon: Icons.appt,       l: 'Appointments'    },
                ],
                [
                  { id: 'grammar',      icon: Icons.bookClosed, l: 'Grammar'         },
                  { id: 'content',      icon: Icons.bookOpen,   l: 'Content Library' },
                ],
                [
                  { id: 'settings',     icon: Icons.gear,       l: 'Settings'        },
                  { id: '__appearance', icon: Icons.palette,    l: 'Appearance'      },
                ],
              ].map((group, gi) => (
                <div key={gi} style={gi === 0 ? undefined : { borderTop: `1px solid ${C.borderB}`, marginTop: '4px', paddingTop: '4px' }}>
                  {group.map((item, ii) => {
                    const active = page === item.id;
                    return (
                      <div key={item.id}
                        onClick={() => {
                          if (item.id === '__appearance') { setSettingsTabRequest('appearance'); setPage('settings'); setMoreOpen(false); }
                          else { setPage(item.id); setMoreOpen(false); }
                        }}
                        style={{
                          display: 'flex', alignItems: 'center', gap: '14px',
                          padding: '12px 18px', fontSize: '14px', fontFamily: SH.fp,
                          letterSpacing: '0.05em',
                          color: active ? C.accent : C.text,
                          borderTop: ii === 0 ? 'none' : `1px solid ${C.border}`,
                          boxShadow: active ? `inset 3px 0 0 ${C.accent}` : 'none',
                          cursor: 'pointer',
                        }}
                      >
                        <span style={{ fontSize: '18px', display: 'flex', opacity: 0.8 }}>{item.icon}</span>
                        {item.l}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </>,
          document.body
        )}

        {/* MOBILE NAV */}
        <div style={S.mobileNav} className="mobile-nav">
          {MNAV.map(item => {
            const isMore   = item.id === '__more';
            const isActive = isMore ? moreOpen : page === item.id;
            return (
              <div key={item.id} style={S.mobileNavItem(isActive)}
                onClick={() => {
                  if (isMore)               { setMoreOpen(v => !v); }
                  else                      { setPage(item.id); setMoreOpen(false); }
                }}>
                <span style={{ fontSize: '18px', display: 'flex' }}>{item.icon}</span>
                {item.l}
              </div>
            );
          })}
        </div>

      </div>
    </>
  );
}

// ── Root app ───────────────────────────────────────────────────────
export default function App() {
  // ── Auth state ──────────────────────────────────────────────
  const [user,       setUser]       = useState(undefined); // undefined = loading, null = signed out
  const [authReady,  setAuthReady]  = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u ?? null);
      setAuthReady(true);
    });
    return unsub;
  }, []);

  // ── Demo seed gate ──────────────────────────────────────────
  // In demo mode nothing loads per-user data until the seed copy has
  // completed (idempotent — returns immediately once the flag doc exists).
  const [seedReady, setSeedReady] = useState(!DEMO);
  // True when the seed copy failed on the demo project's daily quota; the
  // app is replaced by DemoCapacityScreen instead of an empty sandbox.
  const [demoAtCapacity, setDemoAtCapacity] = useState(false);
  useEffect(() => {
    if (!DEMO || !authReady || !user || seedReady) return;
    let cancelled = false;
    ensureDemoSeed(user.uid)
      .catch(e => {
        console.error('AVI: demo seed copy failed', e);
        if (!cancelled && isQuotaError(e)) setDemoAtCapacity(true);
      })
      .finally(() => { if (!cancelled) setSeedReady(true); });
    return () => { cancelled = true; };
  }, [authReady, user, seedReady]);

  // ── Theme ───────────────────────────────────────────────────
  const [themeState, setThemeState] = useState(() => {
    try { return themeIdOf(localStorage.getItem(THEME_KEY) || 'ember'); } catch { return 'ember'; }
  });
  const setTheme = useCallback((t) => {
    setThemeState(t);
    try { localStorage.setItem(THEME_KEY, t); } catch {}
    setData(prev => ({ ...prev, settings: { ...prev.settings, theme: t } }));
  }, []);

  // ── Data state ──────────────────────────────────────────────
  const [data, setData] = useState(() => {
    // On first render, load from localStorage as the immediate baseline.
    // If the user is signed in, Firestore data will overwrite this shortly after.
    const stored = loadState();
    const base = stored || {
      settings: { theme: 'hanok', dayStartHour: 3, defaultCategory: 'lang' },
      // Demo: the seed provides tasks; an empty baseline prevents starter
      // tasks syncing up into a fresh anonymous account before the seed.
      tasks: DEMO ? [] : createInitialTasks(),
    };
    const dsh = base.settings?.dayStartHour ?? 3;
    const { tasks: updatedTasks, changed } = runRecurrenceEngine(base.tasks, dsh);
    if (changed) {
      const next = { ...base, tasks: updatedTasks };
      saveState(next);
      return next;
    }
    return base;
  });

  // S1: the latest rendered data, for refreshes that merge after an await.
  const dataRef = useRef(data);
  dataRef.current = data;
  // SY-D1: the device's saved copy exactly as first shown. When the server
  // copy arrives, whatever differs from this on screen was changed while it
  // loaded and is kept. Cleared once the first load has been applied.
  const openedDataRef = useRef(data);

  // SY-D3: a save found these tasks deleted on another device. They are not
  // written back; take them off the screen and say so (goneNoticeRef is
  // filled in once showToast exists, further down).
  const goneNoticeRef = useRef(null);
  const dropGoneTasks = useCallback((ids) => {
    if (!ids || !ids.length) return;
    setData(prev => {
      const tasks = (prev.tasks || []).filter(t => !ids.includes(t.id));
      return tasks.length === (prev.tasks || []).length ? prev : { ...prev, tasks };
    });
    if (goneNoticeRef.current) goneNoticeRef.current(ids.length);
  }, []);

  const [dataLoaded, setDataLoaded] = useState(false); // true once Firestore load completes
  // OF-D3: a newer build has been deployed. Offers a reload; "Later" hides
  // the banner until the next time the app comes back to the front.
  const newVersion = useNewVersion();
  const [newVersionLater, setNewVersionLater] = useState(false);
  useEffect(() => {
    if (!newVersion) return undefined;
    const show = () => { if (document.visibilityState === 'visible') setNewVersionLater(false); };
    document.addEventListener('visibilitychange', show);
    return () => document.removeEventListener('visibilitychange', show);
  }, [newVersion]);
  const [loadFailed, setLoadFailed] = useState(false);   // remote load exhausted all retries
  const [loadRetryNonce, setLoadRetryNonce] = useState(0); // bump to re-run the load effect

  // ── Load from Firestore once auth is ready and user is signed in ──
  useEffect(() => {
    if (!authReady || !user || !seedReady) return;
    let cancelled = false;
    (async () => {
      // Silent retry with backoff: transient failures must never fall through
      // to setDataLoaded(true) with an unseeded sync baseline, or the debounced
      // sync mass-writes the local (possibly stale) snapshot over Firestore.
      const RETRY_DELAYS = [2000, 6000, 15000];
      let remote = await firestoreLoad(user.uid);
      for (let i = 0; remote === 'error' && i < RETRY_DELAYS.length; i++) {
        await new Promise(res => setTimeout(res, RETRY_DELAYS[i]));
        if (cancelled) return;
        remote = await firestoreLoad(user.uid);
      }
      if (cancelled) return;
      if (remote === 'error') {
        // All attempts failed: stay in local read-only mode. dataLoaded stays
        // false, so the persist effect never enables Firestore sync.
        setLoadFailed(true);
        return;
      }
      setLoadFailed(false);
      if (remote) {
        const dsh = remote.settings?.dayStartHour ?? 3;
        const { tasks: updatedTasks, changed } = runRecurrenceEngine(remote.tasks || [], dsh);
        const next = {
          settings: remote.settings || {},
          tasks: changed ? updatedTasks : (remote.tasks || []),
        };
        // SY-D1: the server copy wins, as before, but an edit made while it
        // was loading (a task ticked in the first second or two, or anything
        // done after "couldn't load") is put back on top of it, field by
        // field. Data that was merely old on this device still loses: it
        // doesn't differ from what was first shown (mergeBootEdits).
        const opened = openedDataRef.current;
        openedDataRef.current = null;
        const screen = mergeBootEdits(dataRef.current, next, opened);
        setData(prev => mergeBootEdits(prev, next, opened));
        // Seed lastSynced with the server copy, so the first debounced flush
        // writes only local changes (which now includes those kept edits).
        seedLastSynced(next);
        // Keep localStorage in sync with what came from Firestore
        saveState(screen);
        // If the engine advanced tasks on load, write back to Firestore immediately
        // so a reload always gets the correct advanced state rather than stale data.
        // N1: tasks that came back with render-only markers are written back
        // clean too (left out of the diff base so they count as changed).
        const repairedIds = remote.repairedTaskIds || [];
        if (changed || repairedIds.length) {
          const writeBase = (remote.tasks || []).filter(t => !repairedIds.includes(t.id));
          firestoreWriteTasksNow(user.uid, next.tasks, writeBase).then(dropGoneTasks).catch(e =>
            console.warn('AVI: post-engine Firestore write failed', e)
          );
        }
        // Restore theme from Firestore settings if present (or the theme
        // picked while loading, which mergeBootEdits kept).
        if (screen.settings?.theme) {
          const restored = themeIdOf(screen.settings.theme);
          setThemeState(restored);
          try { localStorage.setItem(THEME_KEY, restored); } catch {}
        }
      }
        // Content Library sources and sections come from their live listeners
        // (below); audit SY4 removed a second read of content_sections here.
        Promise.all([
          getDocs(collection(db, 'users', user.uid, 'wordInputs'))
            .then(snap => {
              const full = snap.docs.map(d => ({ ...d.data() }));
              setAviWordInputs(full);
              const sec = {};
              full.forEach(({ source: s, section: n }) => {
                if (s && n != null) { const k = `${s}|${n}`; sec[k] = (sec[k] || 0) + 1; }
              });
              setAviWordSectionCounts(sec);
              return true;
            }).catch(() => false),
          getDocs(collection(db, 'users', user.uid, 'sentenceInputs'))
            .then(snap => {
              const full = snap.docs.map(d => ({ ...d.data() }));
              setAviSentenceInputs(full);
              const sec = {};
              full.forEach(({ source: s, section: n }) => {
                if (s && n != null) { const k = `${s}|${n}`; sec[k] = (sec[k] || 0) + 1; }
              });
              setAviSentSectionCounts(sec);
              return true;
            }).catch(() => false),
        ]).then(([wordsOk, sentsOk]) => {
          // S4: AVI re-reads the rows when this copy goes stale.
          if (wordsOk && sentsOk) markAviRowsLoaded();
          setAviInputsLoaded(true);
        });
      setDataLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [authReady, user, seedReady, loadRetryNonce]);

  // ── Sync status & Firestore hook ─────────────────────────────
  const [syncStatus, setSyncStatus] = useState('local');
  const { cards, decks, fcLoading, updateCards, updateDecks, refreshFlashcardsIfStale } = useFlashcardData(seedReady ? (user?.uid ?? null) : null, data.settings?.dayStartHour ?? 3);

  // Deck IDs whose whole set is paused — held out of due counts, triage, and
  // the deferral notices (Phase D2).
  const pausedDeckIds = useMemo(
    () => decks.filter(d => d.paused).map(d => d.id),
    [decks],
  );

  // Sidebar badge — derived live from cards so it's always accurate without
  // requiring the user to visit FlashcardsPage first.
  const flashcardDue = useMemo(() => {
    if (!cards) return 0;
    const dsh = data.settings?.dayStartHour ?? 3;
    const paused = new Set(pausedDeckIds);
    return cards.filter(c =>
      c.type !== 'grammar'
      && isDueToday(c, dsh)
      && !(c.deckIds?.length && c.deckIds.every(id => paused.has(id)))
    ).length;
  }, [cards, data.settings?.dayStartHour, pausedDeckIds]);

  // ── SRS pipeline — runs once per logical day on first card load ──
  // Keyed by uid + logical date so it re-runs on a new day even without a reload.
  const [srsSnapshot, setSrsSnapshot] = useState({
    dueAtDayStart: 0, triaged: 0,
  });
  const pipelineRanForUid = useRef(null);
  // P2: bumped on a day flip so the pipeline re-runs without re-reading
  // every card (the daily refresh has already brought them up to date).
  const [pipelineTick, setPipelineTick] = useState(0);

  useEffect(() => {
    const uid = user?.uid;
    if (!uid || !cards) return;
    if (!dataLoaded) return; // never run against pre-remote local state
    const dsh = data.settings?.dayStartHour ?? 3;
    const logicalDate = getLogicalDateStr(dsh);
    const pipelineKey = `${uid}:${logicalDate}`;
    if (pipelineRanForUid.current === pipelineKey) return;
    pipelineRanForUid.current = pipelineKey;
    (async () => {
      try {
        const pipelineResult = await runDailyPipeline(uid, cards, dsh, pausedDeckIds, data.settings?.srsSpikeCap ?? DAILY_CAP);
        const { cardUpdates, ...result } = pipelineResult || {};
        if (pipelineResult) setSrsSnapshot(DEMO_TOUR ? tourSampleSnapshot(result) : result);

        // If triage moved overdue cards, bring card state up to date.
        // P2: triage run here hands back what it wrote, so it's applied in
        // memory. A plan read back from earlier today (this device or
        // another) is re-read from Firestore only when the cards in memory
        // don't show that triage yet; before, every load on a day with
        // triage re-read every card.
        if (cardUpdates?.length) {
          const byId = new Map(cardUpdates.map(({ id, ...fields }) => [id, fields]));
          updateCards(prev => prev ? prev.map(c => byId.has(c.id) ? { ...c, ...byId.get(c.id) } : c) : prev);
        } else if (result?.triaged > 0) {
          const seen = cards.filter(c => c.lastTriageDate === logicalDate).length;
          if (seen < result.triaged) {
            const { getDocs: gd, collection: col } = await import('firebase/firestore');
            const refreshed = await gd(col(db, 'users', uid, 'flashcards'));
            const refreshedRows = refreshed.docs.map(d => ({ id: d.id, ...d.data() }))
              .filter(c => c.type === 'grammar' || (c.back !== '' && c.back != null));
            updateCards(refreshedRows);
          }
        }
      } catch (e) {
        console.error('App: SRS pipeline failed', e);
      }
    })();
  // cards intentionally included so the effect fires as soon as cards finish
  // loading; dataLoaded included so it fires once the remote load lands even
  // when cards won the race.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, cards, dataLoaded, pipelineTick]);

  // ── Deferral notices (DF-D6) ─────────────────────────────────
  // What the daily cap will defer on each of the next 7 days, worked out
  // live from the cards in memory (so it is current straight after a grade,
  // and the same on every device), plus the cards deferred right now. Held
  // until today's pipeline has run, so a pile about to be trimmed isn't
  // forecast from. Shown on Today and Flashcards.
  const srsCap = data.settings?.srsSpikeCap ?? DAILY_CAP;
  const deferralForecast = useMemo(() => {
    if (!cards) return null;
    const dsh = data.settings?.dayStartHour ?? 3;
    if (srsSnapshot.date !== getLogicalDateStr(dsh)) return null;
    if (DEMO_TOUR) return tourSampleForecast(srsSnapshot.date);
    return buildDeferralForecast(filterActiveCards(cards, pausedDeckIds), { cap: srsCap, dsh });
  }, [cards, pausedDeckIds, srsCap, data.settings?.dayStartHour, srsSnapshot.date]);
  const [grammarMasteryCounts, setGrammarMasteryCounts] = useState(readGrammarMasteryCounts);
  const [grammarEntries,       setGrammarEntries]       = useState(readGrammarEntries);

  const getCardNextDueDate = useCallback((cardId) => {
           const card = cards?.find(c => c.id === cardId);
           return card?.due ?? card?.nextDueDate ?? null;
         }, [cards]);

  const onCardNextDueDateChanged = useCallback((cardId, newNextDueDate) => {
    updateCards(prev => prev
      ? prev.map(c => c.id === cardId ? { ...c, nextDueDate: newNextDueDate } : c)
      : prev
    );
  }, [updateCards]);
  const [aviSources,           setAviSources]           = useState([]);
  const [aviSections,          setAviSections]          = useState([]);
  // K6: latest Library sources/sections for callbacks that don't re-bind
  // on them (toggleTask finishes linked sections from Today).
  const clLiveRef = useRef({ sources: [], sections: [] });
  clLiveRef.current = { sources: aviSources, sections: aviSections };
  const [aviWordInputs,        setAviWordInputs]        = useState([]);
  const [aviSentenceInputs,    setAviSentenceInputs]    = useState([]);
  const [aviInputsLoaded,      setAviInputsLoaded]      = useState(false);
  const [aviWordSectionCounts, setAviWordSectionCounts] = useState({});
  const [aviSentSectionCounts, setAviSentSectionCounts] = useState({});
  // AVI pushes its live inputs up so these prop snapshots stay current —
  // they load once at boot via getDocs, and an AVIPage remount otherwise
  // re-initializes from the stale boot data (in-session additions vanish
  // from view until a full reload even though Firestore has them).
  const handleAVIInputsChange = useCallback((words, sents) => {
    setAviWordInputs(words || []);
    setAviSentenceInputs(sents || []);
    // Per-section counts for the Library. Sentence counts follow too (they
    // used to stay at their boot values until a reload).
    const sectionCounts = (rows) => {
      const sec = {};
      (rows || []).forEach(({ source: s, section: n }) => {
        if (s && n != null) { const k = `${s}|${n}`; sec[k] = (sec[k] || 0) + 1; }
      });
      return sec;
    };
    setAviWordSectionCounts(sectionCounts(words));
    setAviSentSectionCounts(sectionCounts(sents));
  }, []);

  // ── Source rename cascade (called directly by ContentLibraryPage) ─
  const handleSourceRename = useCallback(async (oldTitle, newTitle) => {
    if (!oldTitle || !newTitle || oldTitle === newTitle) return;
    const uid = user?.uid;
    if (!uid) return;

    // 1. Update aviSources state so the topbar selector reflects the new name immediately
    setAviSources(prev =>
      prev.map(s => s.title === oldTitle ? { ...s, title: newTitle } : s)
    );
    updateData(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        aviCurrentSource: prev.settings?.aviCurrentSource === oldTitle
          ? newTitle
          : prev.settings?.aviCurrentSource,
      },
    }));

    // 2. Update deck names in state and Firestore
    const decksToUpdate = (decks || []).filter(d =>
      d.name === oldTitle || d.name === oldTitle + ' (sentence mining)'
    );
    if (decksToUpdate.length > 0) {
      const batch = writeBatch(db);
      decksToUpdate.forEach(d => {
        const newName = d.name === oldTitle
          ? newTitle
          : newTitle + ' (sentence mining)';
        batch.update(doc(db, 'users', uid, 'decks', d.id), { name: newName });
      });
      await batch.commit();
      updateDecks(prev => prev.map(d => {
        if (d.name === oldTitle) return { ...d, name: newTitle };
        if (d.name === oldTitle + ' (sentence mining)') return { ...d, name: newTitle + ' (sentence mining)' };
        return d;
      }));

      // A rename onto a title that already had a deck leaves two decks with
      // one name, splitting the source's cards. Fold them into one.
      try {
        await mergeSameNameDecks({ uid, names: [newTitle, newTitle + ' (sentence mining)'], updateCards, updateDecks });
      } catch (e) {
        console.error('Source rename: duplicate deck merge failed', e);
      }
    }

    // 3. Batch-update wordInputs and sentenceInputs in Firestore
    try {
      let batch2 = writeBatch(db);
      let ops = 0;
      const flush = async () => {
        if (ops === 0) return;
        await batch2.commit();
        batch2 = writeBatch(db);
        ops = 0;
      };
      const [wordSnap, sentSnap] = await Promise.all([
        getDocs(query(collection(db, 'users', uid, 'wordInputs'), where('source', '==', oldTitle))),
        getDocs(query(collection(db, 'users', uid, 'sentenceInputs'), where('source', '==', oldTitle))),
      ]);
      for (const d of [...wordSnap.docs, ...sentSnap.docs]) {
        batch2.update(d.ref, { source: newTitle });
        ops++;
        if (ops >= 490) await flush();
      }
      await flush();

      // 4. Refresh the in-memory AVI snapshots + counts so the topbar,
      // orphan highlighting, and any AVIPage remount see the new title
      // immediately — and so a dirty AVI session can't write a stale
      // oldTitle source back on its next row edit.
      const renameRows = (arr) => arr.map(r => r.source === oldTitle ? { ...r, source: newTitle } : r);
      const buildCounts = (arr) => {
        const src = {}, sec = {};
        arr.forEach(({ source: s, section: n }) => {
          if (s) src[s] = (src[s] || 0) + 1;
          if (s && n != null) { const k = `${s}|${n}`; sec[k] = (sec[k] || 0) + 1; }
        });
        return { src, sec };
      };
      const nextW = renameRows(aviWordInputs);
      const nextS = renameRows(aviSentenceInputs);
      const wc = buildCounts(nextW), sc = buildCounts(nextS);
      setAviWordInputs(nextW);     setAviWordSectionCounts(wc.sec);
      setAviSentenceInputs(nextS); setAviSentSectionCounts(sc.sec);
    } catch (e) {
      console.error('Source rename: AVI entry update failed', e);
    }
  }, [user, decks, updateDecks, updateCards, aviWordInputs, aviSentenceInputs]);

  // ── Phase D3: after a source cascade, reset the AVI selector if it pointed
  //    at the deleted source, then re-sync AVI entries + counts from Firestore ──
  const handleSourceCascadeComplete = useCallback(async (deletedTitle) => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    updateData(prev => (
      prev.settings?.aviCurrentSource === deletedTitle
        ? { ...prev, settings: { ...prev.settings, aviCurrentSource: '', aviCurrentSection: '' } }
        : prev
    ));
    try {
      const [wSnap, sSnap] = await Promise.all([
        getDocs(collection(db, 'users', uid, 'wordInputs')),
        getDocs(collection(db, 'users', uid, 'sentenceInputs')),
      ]);
      const buildCounts = (arr) => {
        const src = {}, sec = {};
        arr.forEach(({ source: s, section: n }) => {
          if (s) src[s] = (src[s] || 0) + 1;
          if (s && n != null) { const k = `${s}|${n}`; sec[k] = (sec[k] || 0) + 1; }
        });
        return { src, sec };
      };
      const wFull = wSnap.docs.map(d => ({ ...d.data() }));
      const sFull = sSnap.docs.map(d => ({ ...d.data() }));
      const wc = buildCounts(wFull);
      const sc = buildCounts(sFull);
      setAviWordInputs(wFull);      setAviSentenceInputs(sFull);
      setAviWordSectionCounts(wc.sec);
      setAviSentSectionCounts(sc.sec);
      markAviRowsLoaded();
    } catch (e) { console.error('D3: AVI re-sync failed', e); }
  }, []);

  // ── CL → App state sync (ContentLibraryPage is source of truth) ──
  const handleSourcesChange  = useCallback((s) => setAviSources(s),  []);
  const handleSectionsChange = useCallback((s) => setAviSections(s), []);
  const [noteTarget,          setNoteTarget]          = useState(null);
  const [grammarTarget,       setGrammarTarget]       = useState(null);
  // G3c2: a sightings review asked for from the Library; the Grammar Index takes it once.
  const [sightingsTarget,     setSightingsTarget]     = useState(null);
  const [flashcardStudyTarget, setFlashcardStudyTarget] = useState(null); // ordered cardIds for a manual Grammar Deck session
  const [echoDeckTarget,       setEchoDeckTarget]       = useState(null); // deck id for an Echo setup opened from a deck card (X3)
  const [correctionTarget,        setCorrectionTarget]        = useState(null);
  const [correctionSessionTarget, setCorrectionSessionTarget] = useState(null);
  const [contentSourceTarget, setContentSourceTarget] = useState(null);
  const { setSyncTarget, seedLastSynced, getSyncBase, commitRefresh } = useFirestoreSync(user?.uid ?? null, setSyncStatus, dropGoneTasks);

  // T4: the logical day as state that changes at the day flip (useLogicalDay),
  // so the resync below and InnerApp's "today" follow the new day at once.
  const appDayStr = useLogicalDay(data.settings?.dayStartHour ?? 3);

  // ── Persist on every data change ─────────────────────────────
  // Always write to localStorage (offline fallback).
  // If signed in and Firestore load has completed, also queue a Firestore write.
  useEffect(() => {
    saveState(data);
    if (user && dataLoaded) {
      setSyncTarget(data);
    }
  }, [data, user, dataLoaded, setSyncTarget]);

  // ── Sound ────────────────────────────────────────────────────
  const [soundProfile, setSoundProfile] = useState(() => {
    try { return localStorage.getItem(SOUND_KEY) || 'chirp'; } catch { return 'chirp'; }
  });
  useEffect(() => {
    try { localStorage.setItem(SOUND_KEY, soundProfile); } catch {}
  }, [soundProfile]);
  const [quizSoundsEnabled, setQuizSoundsEnabled] = useState(() => {
    try { return localStorage.getItem(QUIZ_SOUND_KEY) !== 'false'; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem(QUIZ_SOUND_KEY, quizSoundsEnabled ? 'true' : 'false'); } catch {}
  }, [quizSoundsEnabled]);

  // ── UI state ─────────────────────────────────────────────────
  const [page, setPage] = useState(() => pageFromHash(window.location.hash) || 'today');
  const navigateTo = useCallback((id) => {
    setPage(id);
    window.location.hash = id;
  }, []);
  // U4: every navigation adds a history entry (the hash); Back, Forward and
  // iOS swipe-back change the hash, and the page follows it. Nothing listened
  // before, so Back changed the address bar but not the page.
  useEffect(() => {
    const onHashChange = () => {
      const id = pageFromHash(window.location.hash);
      if (id) setPage(id);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  const [addOpen,   setAddOpen]   = useState(false);
  const [addCat,    setAddCat]    = useState(null);
  const [editTask,  setEditTask]  = useState(null);
  const [editOpen,  setEditOpen]  = useState(false);
  const [toast,     setToast]     = useState(null);

  const toastTimer = useRef(null);
  const recurTimer = useRef(null);
  const lastVisibilityRefresh = useRef(0);
  const sectionUpdateCallbackRef = useRef(null);

  // Grammar entries for Flashcards (Dispatches, the Grammar Deck picker),
  // Quizzes and the Grammar Index: loaded here rather than left to the copy
  // the Grammar Index page saves, which another device might never have.
  useEffect(() => {
    const uid = user?.uid;
    // Demo: not before the sample entries are written (seedReady), so the
    // first read can't save an empty copy.
    if (!uid || !seedReady || !GRAMMAR_ENTRY_PAGES.has(page)) return;
    // Not cancelled on leaving the page: the rows are right whichever page
    // is showing when they arrive.
    loadGrammarEntries(uid).then(rows => {
      setGrammarEntries(rows);
      setGrammarMasteryCounts(grammarMasteryOf(rows));
    });
  }, [user?.uid, page, seedReady]);

// Clear navigation targets when page changes
  useEffect(() => {
    if (page !== 'content')  setNoteTarget(null);
    if (page !== 'content')  setCorrectionTarget(null);
    if (page !== 'content')  setCorrectionSessionTarget(null);
    if (page !== 'grammar' && page !== 'content') setGrammarTarget(null);
    if (page !== 'content')  setContentSourceTarget(null);
    if (page !== 'flashcards') setFlashcardStudyTarget(null);
    if (page !== 'quizzes') setEchoDeckTarget(null);
  }, [page]);

  // ── S1: apply a Firestore snapshot without dropping local edits ──
  // Used by the hourly and return-to-app refreshes. The snapshot is merged
  // into what's on screen (mergeRemoteData: edits not yet saved win, other
  // devices' changes come in), the recurrence engine runs on the result, and
  // the difference from what Firestore returned (kept local edits plus rolls)
  // is written at once and becomes the sync baseline. Returns the merged
  // data, or null when nothing was loaded.
  const refreshFromRemote = useCallback(async (uidR) => {
    const remote = await firestoreLoad(uidR);
    if (!remote || remote === 'error') return null;
    const local = dataRef.current;
    const { next, serverView } = planRemoteRefresh({
      local, remote, base: getSyncBase(), runEngine: runRecurrenceEngine,
    });
    commitRefresh(serverView, next);
    // An edit made after `local` was read is newer than both; it wins too.
    setData(prev => (prev === local ? next : mergeRemoteData(prev, next, local)));
    return next;
  }, [getSyncBase, commitRefresh]);

  // ── S3: mirror AVI's own settings into App's copy ──────────────
  // AVI saves its avi* keys to settings/main itself; keeping App's copy in
  // step means an AVI revisit (which starts from App's copy) shows them.
  const handleAviSettingsChange = useCallback((payload) => {
    setData(prev => {
      const s = prev.settings || {};
      if (Object.keys(payload).every(k => JSON.stringify(s[k]) === JSON.stringify(payload[k]))) return prev;
      return { ...prev, settings: { ...s, ...payload } };
    });
  }, []);

  // ── Recurrence engine: run immediately on load, then hourly ───
  // Initial run uses local state (data was just loaded from Firestore).
  // Hourly interval reloads from Firestore first so the engine never runs on stale
  // in-memory state, preventing cross-device overwrites of completed push tasks.
  useEffect(() => {
    if (!dataLoaded || !user?.uid) return;
    const uid = user.uid;

    const initialRun = () => {
      if (document.visibilityState !== 'visible') return;
      setData(prev => {
        const dsh = prev.settings?.dayStartHour ?? 3;
        const { tasks: updated, changed } = runRecurrenceEngine(prev.tasks || [], dsh);
        return changed ? { ...prev, tasks: updated } : prev;
      });
    };

    const hourlyRun = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        await refreshFromRemote(uid);
      } catch (e) {
        console.warn('AVI: hourly Firestore reload failed', e);
      }
    };

    initialRun();
    recurTimer.current = setInterval(hourlyRun, 3_600_000);
    return () => clearInterval(recurTimer.current);
  }, [dataLoaded, user?.uid]);

// ── Visibility refresh: resync all data from Firestore when tab becomes active ──
  // Updates tasks and settings so cross-device changes are seen.
  // Also detects day flips: resets the pipeline guard and refreshes cards so the
  // SRS pipeline re-runs for the new logical day. Throttled to once per 60 seconds.
  // T4: the same resync also runs when the logical day flips while the app
  // stays open (effect below), so a tab left on screen overnight rolls its
  // tasks and re-runs the pipeline for the new day instead of waiting for
  // the hourly tick or a tab switch. One resync at a time; a second call
  // while one is running shares it. resyncDayRef is the logical day the
  // last resync checked, so a flip a tab return has already handled isn't
  // resynced a second time.
  const resyncRef    = useRef(null);
  const resyncDayRef = useRef(null);

  useEffect(() => {
    if (!dataLoaded || !user?.uid) return;
    let inFlight = null;
    const resync = () => {
      if (inFlight) return inFlight;
      inFlight = runResync().finally(() => { inFlight = null; });
      return inFlight;
    };
    const handleVisibility = async () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastVisibilityRefresh.current < 60_000) return;
      lastVisibilityRefresh.current = now;
      await resync();
    };
    const runResync = async () => {
      try {
        // S1: merged into what's on screen, so edits not yet saved survive.
        // T4: if the read fails (offline), the pipeline check below still
        // runs on the cards already in memory, so a day flip isn't missed.
        let refreshed = null;
        try {
          refreshed = await refreshFromRemote(user.uid);
        } catch (e) {
          console.warn('AVI: visibility refresh failed', e);
        }
        const dsh = (refreshed || dataRef.current).settings?.dayStartHour ?? 3;

        // Daily card/deck freshness (self-gated to one server read per logical
        // day). Awaited so the day-flip refresh below reads an already-updated
        // local cache instead of racing it.
        if (refreshed) await refreshFlashcardsIfStale();

        // Day-flip detection: if the pipeline ran for a different date, reset it
        // and re-run it for the new logical day. P2: the daily refresh above
        // has already read the cards from the server for the new day, so
        // they're not read a second time; the tick re-runs the pipeline.
        const currentLogicalDate = getLogicalDateStr(dsh);
        resyncDayRef.current = currentLogicalDate;
        const currentKey = `${user.uid}:${currentLogicalDate}`;
        if (pipelineRanForUid.current && pipelineRanForUid.current !== currentKey) {
          pipelineRanForUid.current = null;
          setPipelineTick(t => t + 1);
        }
      } catch (e) {
        console.warn('AVI: visibility refresh failed', e);
      }
    };
    resyncRef.current = resync;
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      resyncRef.current = null;
    };
  }, [dataLoaded, user?.uid]);

  // T4: day flip while the app is open → the resync above (unless one has
  // already run for the new day, e.g. the tab return that noticed the flip).
  const lastDayRef = useRef(appDayStr);
  useEffect(() => {
    if (lastDayRef.current === appDayStr) return;
    lastDayRef.current = appDayStr;
    if (!resyncRef.current || resyncDayRef.current === appDayStr) return;
    lastVisibilityRefresh.current = Date.now();
    resyncRef.current();
  }, [appDayStr]);

  // ── Helpers ───────────────────────────────────────────────────
  const updateData  = useCallback(u => setData(prev => u(prev)), []);
  const showToast   = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  }, []);
  // SY-D3: the notice dropGoneTasks shows (defined above, before showToast).
  useEffect(() => {
    goneNoticeRef.current = (n) => showToast(n === 1
      ? 'A task was deleted on another device and has been removed here.'
      : `${n} tasks were deleted on another device and have been removed here.`);
  }, [showToast]);

const toggleTask = useCallback((id, occDate, finishEntire) => {
    // Audit SY4: the Library writes that follow a completion, and the push
    // task's immediate write, start here from the data on screen. They used
    // to start inside the state updater below; an updater has to be free of
    // side effects, since React may run one more than once.
    const cur = dataRef.current;
    const task         = (cur.tasks || []).find(t => t.id === id);
    const taskDatesAll = getTaskDates(task || {});
    const multiTarget  = taskDatesAll.length > 1 && occDate;
    const lastOfTask   = taskDatesAll[taskDatesAll.length - 1];
    // True completion only — day-done checks on earlier dates must never
    // flip a linked CL section.
    const nowComplete = !task ? false
      : multiTarget
        ? !task.completed && (finishEntire || occDate === lastOfTask)
        : !task.completed;

// If completing a task linked to a section-less CL source (Planner
    // source-level placement), flip that source to Done.
    if (nowComplete && task?.linkedSourceId &&
        !(task?.recurrence && task.recurrence.type !== 'none')) {
      const uidS = auth.currentUser?.uid;
      if (uidS) {
        (async () => {
          try {
            const srcRef = doc(db, 'users', uidS, 'content_sources', task.linkedSourceId);
            const snap   = await getDoc(srcRef);
            const prevSt = snap.data()?.sourceStatus ?? snap.data()?.watchStatus ?? 'Not started';
            if (prevSt === 'Done') return;
            const nowIso  = new Date().toISOString();
            const updates = { sourceStatus: 'Done', previousStatus: prevSt, lastActivityAt: nowIso };
            await updateDoc(srcRef, updates);
            setAviSources(prev => prev.map(s => s.id === task.linkedSourceId ? { ...s, ...updates } : s));
          } catch (e) { console.error('Source auto-complete failed:', e); }
        })();
      }
    }

    // If completing a task linked to a CL section, flip that section to Done.
    // Skip recurring tasks (they don't represent a one-time section completion).
    if (nowComplete && task?.linkedSectionId &&
        !(task?.recurrence && task.recurrence.type !== 'none')) {
      const uid = auth.currentUser?.uid;
      if (uid) {
        (async () => {
          try {
            const secRef  = doc(db, 'users', uid, 'content_sections', task.linkedSectionId);
            const secSnap = await getDoc(secRef);
            const secData = secSnap.data() || {};
            if ((secData.status || 'Not started') === 'Done') return;
            // K6: stamp the source too (and flag it for archive when this
            // was its last open section), as the Library's own Done does.
            const live = clLiveRef.current;
            const { sectionUpdates: updates, sourceId, sourceUpdates } = sectionDoneWrites({
              section:  { id: task.linkedSectionId, ...secData },
              sections: live.sections,
              source:   live.sources.find(s => s.id === secData.resourceId) || null,
              nowIso:   new Date().toISOString(),
              logicalToday: getLogicalDateStr(cur.settings?.dayStartHour ?? 3),
            });
            await updateDoc(secRef, updates);
            sectionUpdateCallbackRef.current?.(task.linkedSectionId, updates);
            if (sourceId && sourceUpdates) {
              await updateDoc(doc(db, 'users', uid, 'content_sources', sourceId), sourceUpdates);
              setAviSources(p => p.map(s => s.id === sourceId ? { ...s, ...sourceUpdates } : s));
            }
          } catch (e) { console.error('Section auto-complete failed:', e); }
        })();
      }
    }

    const applyToggle = (tasks, settings) => tasks.map(t => {
      if (t.id !== id) return t;

      // ── Multi-date tasks (F1): per-date completion semantics ──
      const tDates = getTaskDates(t);
      if (tDates.length > 1 && occDate) {
        const last = tDates[tDates.length - 1];
        const cd   = t.completedDates || [];
        if (finishEntire) {
          // Finish the entire task early from occDate: completes the task
          // and records only the interacted date.
          if (t.completed) return t;
          return {
            ...t, completed: true, completedAt: new Date().toISOString(),
            completedDates: cd.includes(occDate) ? cd : [...cd, occDate].sort(),
          };
        }
        if (occDate === last) {
          // The last date's checkbox is true task completion.
          if (!t.completed) {
            return {
              ...t, completed: true, completedAt: new Date().toISOString(),
              completedDates: cd.includes(last) ? cd : [...cd, last].sort(),
            };
          }
          // Unchecking clears done and removes the last date only; dates
          // checked earlier keep their entries.
          return {
            ...t, completed: false, completedAt: null,
            completedDates: cd.filter(ds => ds !== last),
          };
        }
        // Earlier date: day-done toggle. Inert while the whole task is
        // finished — un-finish via the last date's checkbox instead.
        if (t.completed) return t;
        return {
          ...t,
          completedDates: cd.includes(occDate)
            ? cd.filter(ds => ds !== occDate)
            : [...cd, occDate].sort(),
        };
      }

      const completing = !t.completed;

      if (t.persistent && completing) {
        return { ...t, completed: true, completedAt: new Date().toISOString(), activeToday: false };
      }

      if (completing && t.recurrence && t.recurrence.type !== 'none' && t.date) {
        const dsh = settings?.dayStartHour ?? 3;
        const logicalToday = getLogicalToday(dsh);
        // T7: where the engine will actually move it (counted from the
        // due date), not today + the interval.
        const nextDue = nextDueAfterCompletion(t, logicalToday);
        return {
          ...t,
          completed: true,
          completedAt: new Date().toISOString(),
          recurrence: { ...t.recurrence, nextDue },
        };
      }

      // ── Unscheduled tasks (dateless, non-recurring): completing files
      // the task under today's logical date so it leaves Unscheduled,
      // shows in Today's done list, and survives rollover as a dated
      // record in the month calendar. Unchecking an auto-dated task
      // before rollover returns it to Unscheduled (the field is left out
      // here; the task sync deletes a field that is gone from the task).
      if (!t.date && completing && (!t.recurrence || t.recurrence.type === 'none')) {
        const dshU = settings?.dayStartHour ?? 3;
        return {
          ...t,
          completed: true,
          completedAt: new Date().toISOString(),
          date: toDateStr(getLogicalToday(dshU)),
          autoDatedOnComplete: true,
        };
      }
      if (t.autoDatedOnComplete && !completing) {
        const { autoDatedOnComplete: _adc, ...rest } = t;
        return { ...rest, completed: false, completedAt: null, date: null };
      }

      return {
        ...t,
        completed: completing,
        completedAt: completing ? new Date().toISOString() : null,
      };
    });

    // ── Push tasks: bypass debounce, write to Firestore immediately ──
    // Guards against lost completions when the tab closes or the network
    // flickers before the 1500ms debounced sync has a chance to fire.
    if (task?.push && taskDatesAll.length <= 1 && (!task.recurrence || task.recurrence.type === 'none')) {
      const uid = auth.currentUser?.uid;
      if (uid) {
        // SY-D4: only the fields the toggle changed, not the whole task. If
        // the task was deleted on another device nothing is written; the
        // regular save that follows takes it off the screen.
        const updatedTask = applyToggle(cur.tasks || [], cur.settings).find(t => t.id === id);
        if (updatedTask) {
          firestoreWriteTaskFields(uid, task, updatedTask)
            .catch(e => console.warn('AVI: push task immediate write failed', e));
        }
      }
    }

    updateData(prev => ({ ...prev, tasks: applyToggle(prev.tasks, prev.settings) }));
  }, [updateData]);

  const addTask = useCallback((task) => {
    if (DEMO && demoCapReached(data.tasks || [], 'tasks')) {
      showToast(DEMO_LIMIT_NOTE);
      return null;
    }
    const id = uid();
    updateData(prev => ({ ...prev, tasks: [...prev.tasks, { id, ...task }] }));
    showToast('Task added.');
    return id;
  }, [updateData, showToast, data.tasks]);

  const patchTask = useCallback((taskId, updates) => {
    updateData(prev => ({
      ...prev,
      tasks: prev.tasks.map(t => t.id === taskId ? { ...t, ...updates } : t),
    }));
    const uid = auth.currentUser?.uid;
    if (uid) {
      updateDoc(doc(db, 'users', uid, 'tasks', taskId), updates)
        .catch(e => console.error('patchTask failed:', e));
    }
  }, [updateData]);

  // Derived early: plannerCommit below reads `tasks` in its body and dependency
  // array, so the declaration must precede it (dep arrays evaluate every render;
  // a later `const` would still be in its temporal dead zone — TDZ crash).
  const tasks        = data.tasks || [];

// ── Planner Save commit (F2 Stage 3) ──
  // placements: [{ kind: 'section'|'source', sourceId, sectionId?, dates: [] }]
  // Reuses the Schedule wiring: section placements create/update the linked
  // lang task and write linkedTaskId back to the section; source placements
  // do the same against the source doc. Section/source Firestore writes are
  // batched in chunks of 450.
  const plannerCommit = useCallback(async (placements) => {
    const uidStr = auth.currentUser?.uid;
    if (!uidStr || !placements?.length) return false;
    const now = new Date().toISOString();
    const createdTasks = [];
    const taskPatches  = {};   // taskId -> { date, dates? } (dates stripped on apply; completedDates kept for surviving dates)
    const secWrites    = [];
    const srcWrites    = [];

    placements.forEach(p => {
      if (!p.dates || !p.dates.length) return;
      const dates  = [...new Set(p.dates)].sort();
      const anchor = dates[0];
      const multi  = dates.length > 1;
      const dateFields = multi ? { date: anchor, dates } : { date: anchor };

      if (p.kind === 'section') {
        const sec = aviSections.find(s => s.id === p.sectionId);
        if (!sec) return;
        const src   = aviSources.find(s => s.id === sec.resourceId);
        const title = sectionTaskTitle(src?.title || '', sec.content);
        const existing = sec.linkedTaskId ? tasks.find(t => t.id === sec.linkedTaskId && !t.completed) : null;
        let taskId;
        if (existing) {
          taskId = existing.id;
          taskPatches[taskId] = dateFields;
        } else {
          taskId = uid();
          createdTasks.push({ id: taskId, title, category: 'lang', ...dateFields, completed: false, linkedSectionId: sec.id });
        }
        secWrites.push({ id: sec.id, updates: { status: 'Scheduled', linkedTaskId: taskId, lastActivityAt: now } });
      } else if (p.kind === 'source') {
        const src = aviSources.find(s => s.id === p.sourceId);
        if (!src) return;
        const existing = src.linkedTaskId ? tasks.find(t => t.id === src.linkedTaskId && !t.completed) : null;
        let taskId;
        if (existing) {
          taskId = existing.id;
          taskPatches[taskId] = dateFields;
        } else {
          taskId = uid();
          createdTasks.push({ id: taskId, title: src.title || 'Untitled', category: 'lang', ...dateFields, completed: false, linkedSourceId: src.id });
        }
        srcWrites.push({ id: src.id, updates: { sourceStatus: 'Scheduled', linkedTaskId: taskId, lastActivityAt: now } });
      }
    });

    // K6: a section placement is activity for its source too, as scheduling a
    // section in the Library already is.
    const placedSecSources = new Set(secWrites
      .map(w => aviSections.find(s => s.id === w.id)?.resourceId)
      .filter(Boolean));
    placedSecSources.forEach(srcId => {
      const w = srcWrites.find(x => x.id === srcId);
      if (w) w.updates = { ...w.updates, lastActivityAt: now };
      else if (aviSources.some(s => s.id === srcId)) srcWrites.push({ id: srcId, updates: { lastActivityAt: now } });
    });

    if (!createdTasks.length && !Object.keys(taskPatches).length) return false;

    // Tasks flow through the normal debounced sync.
    updateData(prev => ({
      ...prev,
      tasks: [
        ...prev.tasks.map(t => {
          const patch = taskPatches[t.id];
          if (!patch) return t;
          const { dates: _d, completedDates: _cd, ...rest } = t;
          const next = { ...rest, ...patch };
          // Mirror EditTaskModal: when the re-plan is still multi-date, keep
          // completions for dates that survived it.
          if (Array.isArray(patch.dates) && Array.isArray(t.completedDates)) {
            next.completedDates = t.completedDates.filter(ds => patch.dates.includes(ds));
          }
          return next;
        }),
        ...createdTasks,
      ],
    }));

    // Local CL-state sync (App copy + ContentLibraryPage callback if mounted).
    if (secWrites.length) {
      setAviSections(prev => prev.map(s => {
        const w = secWrites.find(x => x.id === s.id);
        return w ? { ...s, ...w.updates } : s;
      }));
      secWrites.forEach(w => sectionUpdateCallbackRef.current?.(w.id, w.updates));
    }
    if (srcWrites.length) {
      setAviSources(prev => prev.map(s => {
        const w = srcWrites.find(x => x.id === s.id);
        return w ? { ...s, ...w.updates } : s;
      }));
    }

    // Section/source doc writes, batched ≤450 ops.
    try {
      const all = [
        ...secWrites.map(w => ({ coll: 'content_sections', ...w })),
        ...srcWrites.map(w => ({ coll: 'content_sources', ...w })),
      ];
      for (let i = 0; i < all.length; i += 450) {
        const batch = writeBatch(db);
        all.slice(i, i + 450).forEach(w => batch.update(doc(db, 'users', uidStr, w.coll, w.id), w.updates));
        await batch.commit();
      }
    } catch (e) {
      console.error('Planner commit failed:', e);
      showToast('Planner save failed.');
      return false;
    }
    showToast(`Saved ${placements.length} placement${placements.length === 1 ? '' : 's'}.`);
    return true;
  }, [aviSections, aviSources, tasks, updateData, showToast]);

  const registerSectionUpdateCallback = useCallback((fn) => {
    sectionUpdateCallbackRef.current = fn;
  }, []);

  const saveTask = useCallback((updatedTask, baseTask) => {
    // followUpQueue is a transient carrier from EditTaskModal's appointment
    // variant — it belongs on the appointment doc, never on the task doc.
    const { followUpQueue: fuQueue, ...taskToStore } = updatedTask;
    const { followUpQueue: fuBase, ...baseToApply } = baseTask || {};
    // N1/K3: apply only the fields the modal changed (vs baseTask, the task
    // as it was when the modal opened) onto the task as it is now, without
    // render-only markers. A completion, roll or refresh that landed while
    // the modal was open is kept.
    if (!(dataRef.current.tasks || []).some(t => t.id === taskToStore.id)) {
      showToast('This task was deleted, so the edit was not saved.');
      return;
    }
    updateData(prev => ({
      ...prev,
      tasks: prev.tasks.map(t => t.id === taskToStore.id ? (applyTaskEdit(t, baseTask ? baseToApply : baseTask, taskToStore) || t) : t),
    }));
    if (updatedTask.isAppointmentTask && updatedTask.appointmentId) {
      const uid = auth.currentUser?.uid;
      if (uid) {
        // K3: only fields changed in the modal reach the appointment, so a
        // follow-up promotion that landed while Edit Task was open keeps its
        // new date and visit stamps (writing the old date back made the next
        // promotion stamp the same visit again, K5). No base: all, as before.
        const changed = (k) => !baseTask || !sameValue(taskToStore[k], baseTask[k]);
        const apptSync = { lastUpdated: new Date().toISOString() };
        if (changed('notes'))    apptSync.results  = updatedTask.notes || '';
        if (changed('category')) apptSync.category = updatedTask.category;
        if (updatedTask.date && changed('date')) apptSync.date = updatedTask.date;
        // A cleared time reaches the appointment too (it used to keep its
        // old time); with no base, only a time that is set is sent, as before.
        if (changed('time') && (baseTask || updatedTask.time != null)) apptSync.time = updatedTask.time || '';
        if (fuQueue !== undefined && (!baseTask || fuBase === undefined || !sameValue(fuQueue, fuBase))) {
          // Queue edited from the task modal — legacy single-date fields
          // are nulled so the promotion effect and AppointmentModal read
          // only the queue (null is falsy at both check sites).
          apptSync.followUpQueue = fuQueue;
          apptSync.followUpDate  = null;
          apptSync.followUpTime  = null;
        }
        setDoc(doc(db, 'users', uid, 'appointments', updatedTask.appointmentId),
          apptSync,
          { merge: true }
        ).catch(e => console.error('App: appt sync from task failed', e));
      }
    }
    showToast('Task saved.');
  }, [updateData, showToast]);

  const deleteTask = useCallback((id) => {
    updateData(prev => {
      const task = prev.tasks.find(t => t.id === id);
      if (task?.isAppointmentTask && task?.appointmentId) {
        const uid = auth.currentUser?.uid;
        if (uid) {
          setDoc(doc(db, 'users', uid, 'appointments', task.appointmentId), {
            taskId: null,
            lastUpdated: new Date().toISOString(),
          }, { merge: true }).catch(e => console.error('App: appt unlink failed', e));
        }
      }
      return { ...prev, tasks: prev.tasks.filter(t => t.id !== id) };
    });
    showToast('Task deleted.');
  }, [updateData, showToast]);

  // N1: open the stored task, never the row copy that was clicked (Upcoming's
  // per-day copies carry another date and render-only markers).
  const openEdit    = useCallback((task) => { setEditTask(resolveEditTarget(task, dataRef.current.tasks)); setEditOpen(true); }, []);
  const closeEdit   = useCallback(() => { setEditOpen(false); setTimeout(() => setEditTask(null), 300); }, []);
  const openAddTask = useCallback((cat = null) => { setAddCat(cat); setAddOpen(true); }, []);

  const handleAVISourceUpdate = useCallback((updates) => {
    updateData(prev => ({
      ...prev,
      settings: { ...prev.settings, ...updates },
    }));
  }, [updateData]);

  const handleSignOut = useCallback(async () => {
    await signOut(auth);
    // Clear local data so the next user starts fresh (their data loads from Firestore on sign-in)
    setUser(null);
    setSyncStatus('local');
  }, []);

  // ── Keyboard shortcuts ────────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        openAddTask(data.settings?.defaultCategory || 'lang');
      }
      if (e.key === 'Escape') { setAddOpen(false); setEditOpen(false); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [openAddTask, data.settings?.defaultCategory]);

  // ── Derived values ────────────────────────────────────────────
  const dsh          = data.settings?.dayStartHour ?? 3;

  // T4: the logical day from render, so the follow-up promotion below
  // re-runs on the day flip.
  const todayStr = toDateStr(getLogicalToday(dsh));

// ── Content Library sources/sections — live listeners ─────────
  useEffect(() => {
    if (!user?.uid) return;
    const unsubSources  = onSnapshot(
      collection(db, 'users', user.uid, 'content_sources'),
      snap => setAviSources(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => {}
    );
    const unsubSections = onSnapshot(
      collection(db, 'users', user.uid, 'content_sections'),
      snap => setAviSections(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      () => {}
    );
    return () => { unsubSources(); unsubSections(); };
  }, [user?.uid]);

// ── Appointments (app-level) ──────────────────────────────────
  const [appointments, setAppointments] = useState([]);

  useEffect(() => {
    if (!user?.uid) return;
    const unsub = onSnapshot(
      collection(db, 'users', user.uid, 'appointments'),
      snap => setAppointments(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
      e => console.error('App: appointments listener error', e)
    );
    return unsub;
  }, [user?.uid]);

  // K3: the latest appointments, for saves that land after a modal was open.
  const appointmentsRef = useRef(appointments);
  appointmentsRef.current = appointments;

  // saveAppointment(appt)       — writes the whole doc (new appointments).
  // saveAppointment(appt, base) — Appointment modal save: base is the payload
  //   the modal would have saved untouched, so only the fields changed in the
  //   modal are applied onto the appointment as it is now. A follow-up
  //   promotion or another device's edit that landed meanwhile is kept.
  const saveAppointment = useCallback(async (appt, base) => {
    const uid = user?.uid;
    if (!uid) return;
    if (DEMO && !(appointmentsRef.current || []).some(a => a.id === appt.id) &&
        demoCapReached(appointmentsRef.current || [], 'appointments')) {
      showToast(DEMO_LIMIT_NOTE);
      return;
    }
    let toWrite = appt;
    if (base) {
      const latest = (appointmentsRef.current || []).find(a => a.id === appt.id);
      if (!latest) {
        showToast('This appointment was deleted, so the edit was not saved.');
        return;
      }
      const { lastUpdated: _lu, ...latestDoc } = latest;
      const { merged, changed } = applyFieldEdits(latestDoc, base, appt);
      // The modal works from the follow-up queue and the costs list; once it
      // saves either, the legacy single fields it migrated from go.
      if (Array.isArray(merged.followUpQueue)) { delete merged.followUpDate; delete merged.followUpTime; }
      if (changed.includes('costs')) { merged.cost = null; merged.costCurrency = null; }
      toWrite = merged;
    }
    try {
      await setDoc(doc(db, 'users', uid, 'appointments', toWrite.id), {
        ...toWrite, lastUpdated: new Date().toISOString(),
      });
    } catch (e) {
      console.error('App: saveAppointment failed', e);
    }
  }, [user?.uid, showToast]);

  // Field-level write (merge) for app-side updates to one appointment, so
  // they never write a stale copy of the rest of the doc.
  const patchAppointment = useCallback(async (id, fields) => {
    const uid = user?.uid;
    if (!uid || !id) return;
    try {
      await setDoc(doc(db, 'users', uid, 'appointments', id), {
        ...fields, lastUpdated: new Date().toISOString(),
      }, { merge: true });
    } catch (e) {
      console.error('App: patchAppointment failed', e);
      throw e;
    }
  }, [user?.uid]);

  const handleSectionComplete = useCallback(async (sectionId, sourceId, currentApptId) => {
    const uid = user?.uid;
    if (!uid || !sectionId) return;
    const section = aviSections.find(s => s.id === sectionId);
    if (section?.status === 'Done') return;
    const todayStr = toDateStr(getLogicalToday(dsh));
    // K6: previous status, activity stamps on the section and its source,
    // and the archive flag when it was the source's last open section.
    const srcId = section?.resourceId || sourceId || null;
    const { sectionUpdates, sourceUpdates } = sectionDoneWrites({
      section:  { id: sectionId, status: section?.status, resourceId: srcId },
      sections: aviSections,
      source:   aviSources.find(s => s.id === srcId) || null,
      nowIso:   new Date().toISOString(),
      logicalToday: todayStr,
    });
    try {
      await setDoc(doc(db, 'users', uid, 'content_sections', sectionId), sectionUpdates, { merge: true });
    } catch (e) {
      console.error('handleSectionComplete: write failed', e);
      return;
    }
    if (srcId && sourceUpdates) {
      setDoc(doc(db, 'users', uid, 'content_sources', srcId), sourceUpdates, { merge: true })
        .catch(e => console.error('handleSectionComplete: source stamp failed', e));
    }
    const nextAppt = [...appointments]
      .filter(a => a.id !== currentApptId && a.mainSourceId === sourceId && a.date >= todayStr)
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    if (!nextAppt) return;
    const ordered     = getOrderedSectionsForSource(aviSections, aviSources, sourceId);
    const currentIdx  = ordered.findIndex(s => s.id === sectionId);
    const nextSection = currentIdx >= 0 ? ordered[currentIdx + 1] : null;
    await patchAppointment(nextAppt.id, { mainSectionId: nextSection?.id || null }).catch(() => {});
  }, [user?.uid, appointments, aviSections, aviSources, dsh, patchAppointment]);

  const deleteAppointment = useCallback(async (id) => {
    const uid = user?.uid;
    if (!uid) return;
    const linked = appointments.find(a => a.id === id);
    if (linked?.taskId) {
      updateData(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== linked.taskId) }));
    }
    try {
      await deleteDoc(doc(db, 'users', uid, 'appointments', id));
    } catch (e) {
      console.error('App: deleteAppointment failed', e);
    }
  }, [user?.uid, appointments, updateData]);

// ── Appointment follow-up queue promotion ─────────────────────
  // T4: re-runs on the day flip (todayStr from render), so a follow-up due
  // today is promoted without waiting for an appointments change.
  // K5: the plan (apptPromotion.js) stamps each visit date once, even if it
  // runs again on an older copy; the write is field-level (merge), so it
  // can't put back a stale copy of fields it didn't change; and a promotion
  // already written for this appointment and date isn't written again while
  // the snapshot catches up.
  const promotingRef = useRef(new Map()); // appt id -> date it was promoted from
  useEffect(() => {
    if (!user?.uid || !dataLoaded || appointments.length === 0) return;

    const inFlight = promotingRef.current;
    for (const [id, fromDate] of inFlight) {
      const a = appointments.find(x => x.id === id);
      if (!a || a.date !== fromDate) inFlight.delete(id);
    }

    appointments.forEach(appt => {
      if (inFlight.get(appt.id) === appt.date) return;
      const plan = planFollowUpPromotion(appt, todayStr);
      if (!plan) return;
      const { date: newDate, time: newTime, results } = plan.fields;

      inFlight.set(appt.id, appt.date);
      patchAppointment(appt.id, {
        ...plan.fields,
        followUpDate: deleteField(),
        followUpTime: deleteField(),
      }).catch(() => { if (inFlight.get(appt.id) === appt.date) inFlight.delete(appt.id); });

      if (appt.taskId) {
        const hasUpcoming = plan.hasUpcoming;
        updateData(prev => {
          const exists = prev.tasks.some(t => t.id === appt.taskId);
          if (exists) {
            // A follow-up promoted to a future date must resurface as an
            // open task — clear the completed flag set when the previous
            // date was attended. When the queue is exhausted (no upcoming
            // items), leave completion untouched.
            return {
              ...prev,
              tasks: prev.tasks.map(t =>
                t.id === appt.taskId
                  ? { ...t, date: newDate, time: newTime || null, notes: results,
                      ...(hasUpcoming ? { completed: false, completedAt: null } : {}) }
                  : t
              ),
            };
          }
          if (!hasUpcoming) return prev;
          // The linked task was deleted at some point — recreate it so the
          // promoted follow-up actually appears in Today and Upcoming.
          return {
            ...prev,
            tasks: [...prev.tasks, {
              id: appt.taskId, title: `Appt: ${appt.type || 'Appointment'}`,
              category: appt.category || 'lang', priority: 'med',
              date: newDate, time: newTime || null,
              recurrence: { type: 'none' }, notes: results,
              keepRecord: false,
              completed: false, persistent: false, push: false,
              activeToday: false, activatedOn: null,
              created: new Date().toISOString(),
              isAppointmentTask: true, appointmentId: appt.id,
              apptProvider: appt.provider || '',
            }],
          };
        });
      }
    });
  }, [appointments, dataLoaded, user?.uid, todayStr, patchAppointment, updateData]);

  const todayBadgeStr = toDateStr(getLogicalToday(dsh));
  const todayCount   = tasks.filter(t => taskOccursOn(t, todayBadgeStr) && !isDateDone(t, todayBadgeStr)).length;
  // Same two lists the Overdue page shows: overdue + unscheduled.
  const overdueCount = tasks.filter(t => isOverdueTask(t, dsh) || isUnscheduledTask(t)).length;

  // ── Auth loading splash ───────────────────────────────────────
  // Show nothing while Firebase resolves auth state on first load (usually <300ms)
  if (!authReady) {
    return null;
  }

  // ── Sign-in gate ──────────────────────────────────────────────
  if (!user) {
    return (
      <ThemeContext.Provider value={{ theme: themeState, setTheme }}>
        <SignInScreen />
      </ThemeContext.Provider>
    );
  }

  // ── Demo at daily quota ──────────────────────────────────────
  if (DEMO && demoAtCapacity) {
    return (
      <ThemeContext.Provider value={{ theme: themeState, setTheme }}>
        <DemoCapacityScreen />
      </ThemeContext.Provider>
    );
  }

  // ── Demo seed splash ─────────────────────────────────────────
  if (DEMO && !seedReady) {
    return (
      <ThemeContext.Provider value={{ theme: themeState, setTheme }}>
        <SignInScreen preparing />
      </ThemeContext.Provider>
    );
  }

// ── Dev dashboard ─────────────────────────────────────────────
  if (window.location.hash === '#dev') {
    return (
      <ThemeContext.Provider value={{ theme: themeState, setTheme }}>
        <DevDashboard user={user} />
      </ThemeContext.Provider>
    );
  }

  // ── Main app ──────────────────────────────────────────────────
  return (
    <ThemeContext.Provider value={{ theme: themeState, setTheme }}>
      {loadFailed && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
          background: '#7a2e2e', color: '#fff', padding: '10px 16px',
          fontSize: 14, textAlign: 'center',
        }}>
          Couldn't reach the server — showing local data. Changes are not being saved.
          <button
            onClick={() => { setLoadFailed(false); setLoadRetryNonce(n => n + 1); }}
            style={{
              marginLeft: 12, padding: '4px 12px', border: '1px solid #fff',
              borderRadius: 6, background: 'transparent', color: '#fff', cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      )}
      {newVersion && !newVersionLater && !loadFailed && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9998,
          background: '#2c2620', color: '#f0e9df', fontSize: 14, textAlign: 'center',
          padding: 'calc(10px + env(safe-area-inset-top, 0px)) 16px 10px',
          boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
        }}>
          A new version of AutoVocaIndex is ready.
          <button
            onClick={() => window.location.reload()}
            style={{
              marginLeft: 12, padding: '4px 12px', border: '1px solid #c97d3a',
              borderRadius: 6, background: '#c97d3a', color: '#1a1613', fontWeight: 600, cursor: 'pointer',
            }}
          >
            Reload
          </button>
          <button
            onClick={() => setNewVersionLater(true)}
            style={{
              marginLeft: 8, padding: '4px 12px', border: '1px solid rgba(240,233,223,0.5)',
              borderRadius: 6, background: 'transparent', color: '#f0e9df', cursor: 'pointer',
            }}
          >
            Later
          </button>
        </div>
      )}
      <InnerApp
        data={data} page={page} setPage={navigateTo}
        addOpen={addOpen} setAddOpen={setAddOpen} addCat={addCat}
        editTask={editTask} editOpen={editOpen}
        openEdit={openEdit} closeEdit={closeEdit}
        saveTask={saveTask} deleteTask={deleteTask}
        toast={toast} showToast={showToast} dsh={dsh} logicalDay={appDayStr} tasks={tasks}
        todayCount={todayCount} overdueCount={overdueCount}
        toggleTask={toggleTask} addTask={addTask} openAddTask={openAddTask}
        patchTask={patchTask}
        registerSectionUpdateCallback={registerSectionUpdateCallback}
        updateData={updateData} soundProfile={soundProfile}
        setSoundProfile={setSoundProfile}
        quizSoundsEnabled={quizSoundsEnabled}
        setQuizSoundsEnabled={setQuizSoundsEnabled}
        syncStatus={syncStatus}
        user={user} onSignOut={handleSignOut}
        flashcardDue={flashcardDue}
        srsSnapshot={srsSnapshot} deferralForecast={deferralForecast}
        cards={cards} decks={decks} fcLoading={fcLoading}
        updateCards={updateCards} updateDecks={updateDecks}
        noteTarget={noteTarget} setNoteTarget={setNoteTarget}
        grammarTarget={grammarTarget} setGrammarTarget={setGrammarTarget}
        sightingsTarget={sightingsTarget} setSightingsTarget={setSightingsTarget}
        grammarMasteryCounts={grammarMasteryCounts}
        onMasteryCounts={setGrammarMasteryCounts}
        getCardNextDueDate={getCardNextDueDate}
        onCardNextDueDateChanged={onCardNextDueDateChanged}
        grammarEntries={grammarEntries} onEntriesChange={setGrammarEntries}
        flashcardStudyTarget={flashcardStudyTarget} setFlashcardStudyTarget={setFlashcardStudyTarget}
        echoDeckTarget={echoDeckTarget} setEchoDeckTarget={setEchoDeckTarget}
        correctionTarget={correctionTarget} setCorrectionTarget={setCorrectionTarget}
        correctionSessionTarget={correctionSessionTarget}         
        setCorrectionSessionTarget={setCorrectionSessionTarget}
        contentSourceTarget={contentSourceTarget} 
        setContentSourceTarget={setContentSourceTarget}
        aviSources={aviSources}
        aviSections={aviSections}
        aviWordSectionCounts={aviWordSectionCounts}
        aviSentSectionCounts={aviSentSectionCounts}
        aviWordInputs={aviWordInputs}
        aviSentenceInputs={aviSentenceInputs}
        aviInputsLoaded={aviInputsLoaded}
        onAVISourceUpdate={handleAVISourceUpdate}
        onAVIInputsChange={handleAVIInputsChange}
        onAviSettingsChange={handleAviSettingsChange}
        onSourceRename={handleSourceRename}
        onSourceCascadeComplete={handleSourceCascadeComplete}
        onSourcesChange={handleSourcesChange}
        onSectionsChange={handleSectionsChange}
        appointments={appointments}
        saveAppointment={saveAppointment}
        deleteAppointment={deleteAppointment}
        onSectionComplete={handleSectionComplete}
        plannerCommit={plannerCommit}
      />
    </ThemeContext.Provider>
  );
}
