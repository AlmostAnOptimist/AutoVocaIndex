import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, updateDoc, collection, getDocs, writeBatch, query, where, setDoc, getDoc, onSnapshot, deleteDoc } from 'firebase/firestore';
import { db, auth } from './firebase.js';
import { ThemeContext } from './theme/ThemeContext.js';
import { useAppTheme } from './hooks/useAppTheme.js';
import { buildGlobalStyles, SH, frameBevelFilled } from './theme/buildStyles.js';
import { MobileInfoSheet } from './components/MobileInfoSheet.jsx';
import { buildColors } from './theme/buildColors.js';

import { NavItem } from './components/NavItem.jsx';
import { ThemePanel } from './components/ThemePanel.jsx';
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
import { getSourceSections } from './utils/aviUtils.js';
import { AVISourceSearchSelect } from './components/avi/AVISourceSearchSelect.jsx';
import { AVIPage } from './pages/AVIPage.jsx';
import { QuizzesPage } from './pages/QuizzesPage.jsx';
import { NotesPage } from './pages/NotesPage.jsx';
import { FlashcardsPage } from './pages/FlashcardsPage.jsx';

import { DevDashboard } from './pages/DevDashboard.jsx';

import { birbSrc, decoBlockStyle } from './utils/decoAssets.js';

import { uid, parseDate, isToday, isPast, toDateStr, getLogicalToday, getLogicalDateStr, getTaskDates, taskOccursOn, taskLastDate, isDateDone } from './utils/dateUtils.js';
import { runDailyPipeline } from './utils/srsEngine.js';
import { isDueToday } from './utils/fsrs.js';
import { runRecurrenceEngine, getNextOccurrence } from './utils/recurrenceEngine.js';
import { getOrderedSectionsForSource } from './utils/contentUtils.js';
import { loadState, saveState, createInitialTasks } from './utils/storage.js';
import { firestoreLoad, useFirestoreSync, firestoreWriteTasksNow } from './hooks/useFirestore.js';
import { DEMO, DEMO_LIMIT_NOTE, demoCapReached } from './demo/demoConfig.js';
import { ensureDemoSeed } from './demo/seedCopy.js';
import { DemoBanner } from './demo/DemoBanner.jsx';
import {
  THEME_KEY, SOUND_KEY, QUIZ_SOUND_KEY, CATEGORIES,
  NAV_SECTIONS, PAGE_TITLES,
} from './constants.js';

// ── Shared flashcard data hook ────────────────────────────────
// Loads decks (phase 1) and cards (phase 2) once for the whole app session.
// Both FlashcardsPage and QuizzesPage receive this data as props — no duplicate reads.
// localStorage provides instant first render; Firestore refreshes in the background.
const FC_CARDS_PREFIX = 'avi_fc_cards_';
const FC_DECKS_PREFIX = 'avi_fc_decks_';

// Module-level so every component in this file can see it (AVISourceSelector
// in particular — it's defined outside the App function and was previously
// reaching for a local isMobile that didn't exist in its scope).
const isMobile = typeof window !== 'undefined' && window.innerWidth <= 700;

function fcRead(key) {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : null; } catch { return null; }
}
function fcWrite(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

// Reads grammar mastery counts from localStorage so FlashcardsPage has data even
// before GrammarIndexPage mounts in the current session.
function readGrammarMasteryCounts() {
  try {
    const cached = localStorage.getItem('avi_grammar_entries');
    if (!cached) return null;
    const entries = JSON.parse(cached);
    const c = { all: entries.length, introduced: 0, practicing: 0, confident: 0, mastered: 0 };
    entries.forEach(e => { if (c[e.masteryLevel] !== undefined) c[e.masteryLevel]++; });
    return c;
  } catch { return null; }
}

// Same cache, full entries this time — lets the Grammar Deck picker in FlashcardsPage
// have data even before GrammarIndexPage has mounted in the current session.
function readGrammarEntries() {
  try {
    const cached = localStorage.getItem('avi_grammar_entries');
    return cached ? JSON.parse(cached) : [];
  } catch { return []; }
}

function useFlashcardData(uid) {
  const [decks,        setDecksState]  = useState(() => fcRead(uid ? FC_DECKS_PREFIX + uid : null) || []);
  const [cards,        setCardsState]  = useState(() => fcRead(uid ? FC_CARDS_PREFIX + uid : null));  // null = not yet loaded
  const [fcLoading,    setFcLoading]   = useState(() => !fcRead(uid ? FC_DECKS_PREFIX + uid : null));

  const decksKey = uid ? FC_DECKS_PREFIX + uid : null;
  const cardsKey = uid ? FC_CARDS_PREFIX + uid : null;

  // Stable updaters — write through to cache
  const updateCards = useCallback((updater) => {
    setCardsState(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      fcWrite(cardsKey, next);
      return next;
    });
  }, [cardsKey]);

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

    // Phase 1: decks (fast — lets FlashcardsPage grid render immediately)
    (async () => {
      try {
        const deckSnap = await getDocs(collection(db, 'users', uid, 'decks'));
        const deckRows = deckSnap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .sort((a, b) => {
            if (a.id === 'deck_grammar') return -1;
            if (b.id === 'deck_grammar') return 1;
            return (a.name || '').localeCompare(b.name || '');
          });
        setDecksState(deckRows);
        fcWrite(decksKey, deckRows);
      } catch (e) {
        console.error('App: deck load failed', e);
      } finally {
        setFcLoading(false);
      }
    })();

    // Phase 2: cards (background — pipeline runs here)
    (async () => {
      try {
        const cardSnap = await getDocs(collection(db, 'users', uid, 'flashcards'));
        const allRows  = cardSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        // Filter out backless vocabulary cards (grammar cards always kept)
        const cardRows = allRows.filter(c => c.type === 'grammar' || (c.back !== '' && c.back != null));
        setCardsState(cardRows);
        fcWrite(cardsKey, cardRows);
      } catch (e) {
        console.error('App: card load failed', e);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  return { cards, decks, fcLoading, updateCards, updateDecks };
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
        {srcSections.map(s => <option key={s.id} value={s.content.match(/(\d+)$/)?.[1] || s.content}>{s.content}</option>)}
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

// ── Nav icon map ────────────────────────────────────────────────────────────
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
  themeOpen, setThemeOpen,
  addOpen, setAddOpen, addCat,
  editTask, editOpen, openEdit, closeEdit,
  saveTask, deleteTask,
  toast, dsh, tasks,
  todayCount, overdueCount,
  toggleTask, addTask, openAddTask,patchTask,
  registerSectionUpdateCallback,
  updateData, soundProfile, setSoundProfile,
  quizSoundsEnabled, setQuizSoundsEnabled,
  syncStatus, user, onSignOut,
  flashcardDue,
  srsSnapshot, onPipelineResult,
  cards, decks, fcLoading, updateCards, updateDecks,
  noteTarget, setNoteTarget, grammarTarget, setGrammarTarget,
  grammarMasteryCounts, onMasteryCounts, getCardNextDueDate, onCardNextDueDateChanged,
  grammarEntries, onEntriesChange, flashcardStudyTarget, setFlashcardStudyTarget,
  correctionTarget, setCorrectionTarget,
  correctionSessionTarget, setCorrectionSessionTarget,
  contentSourceTarget, setContentSourceTarget,
  aviSources, aviSections, aviWordCounts, aviSentenceCounts,
  aviWordSectionCounts, aviSentSectionCounts,
  aviWordInputs, aviSentenceInputs, aviInputsLoaded, onAVISourceUpdate, onAVIInputsChange,
  appointments, saveAppointment, deleteAppointment,
  onSectionComplete,
  onSourcesChange, onSectionsChange, onSourceRename, onSourceCascadeComplete,
  plannerCommit,
}) {
  const { C, S, G, theme } = useAppTheme();
  const [moreOpen,              setMoreOpen]              = useState(false);
  const [pendingApptLink,       setPendingApptLink]       = useState(null);
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

  const upcomingLangAppt = useMemo(() => {    const todayStr = toDateStr(getLogicalToday(dsh));
    return appointments
      .filter(a => a.category === 'lang' && a.date >= todayStr)
      .sort((a, b) => a.date !== b.date ? a.date.localeCompare(b.date) : (a.time || '').localeCompare(b.time || ''))
      [0] || null;
  }, [appointments, dsh]);

  const dateStr = getLogicalToday(dsh).toLocaleDateString('en-US', {
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
            zIndex: 9,
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
            <NavItem icon={Icons.palette} label="Appearance" active={false} onClick={() => setThemeOpen(true)} collapsed={sidebarCollapsed} />
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
              ? <AVISourceSelector
                  sources={aviSources} sections={aviSections}
                  currentSource={data.settings?.aviCurrentSource || ''}
                  currentSection={data.settings?.aviCurrentSection || ''}
                  onUpdate={onAVISourceUpdate}
                  C={C} S={S}
                />
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
                ? <div id="avi-nav-slot" />
                : (page === 'content' || page === 'flashcards' || page === 'quizzes') && isMobile
                ? null
                : <QuickAddButtons onAdd={cat => openAddTask(cat)} />
              }
            </div>
          </div>
          {DEMO && (isMobile || page === 'avi') && <DemoBanner variant="strip" />}
          <div style={S.contentArea} className="content-pad">
            {page === 'today' && (
              <TodayPage
                {...sharedPageProps}
                cards={cards}
                srsSnapshot={srsSnapshot}
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
                  aviWordCounts={aviWordCounts}
                  aviSentenceCounts={aviSentenceCounts}
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
              />
            )}
{page === 'grammar'    && <GrammarIndexPage defaultOpenEntryId={grammarTarget} onNavigateToFlashcard={(cardIdOrIds) => { setFlashcardStudyTarget(Array.isArray(cardIdOrIds) ? cardIdOrIds : [cardIdOrIds]); setPage('flashcards'); }} onNavigateToNote={(noteId) => { setNoteTarget(noteId); setPage('content'); }} onNavigateToContent={(sourceId) => { setContentSourceTarget(sourceId); setPage('content'); }} onMasteryCounts={onMasteryCounts} onEntriesChange={onEntriesChange} getCardNextDueDate={getCardNextDueDate} onCardNextDueDateChanged={onCardNextDueDateChanged} updateCards={updateCards} cards={cards} />}
{page === 'content'  && <ContentLibraryPage showDecoPanel={showDecoPanel} soundProfile={soundProfile} onNavigateToGrammar={(entryId) => { setGrammarTarget(entryId); setPage('grammar'); }} onNavigateToNote={(noteId) => { setNoteTarget(noteId); setPage('content'); }} addTask={addTask} defaultOpenSourceId={contentSourceTarget} onNavigateToCorrection={(id) => { setCorrectionSessionTarget(id); setPage('content'); }}
 aviSources={aviSources} aviSections={aviSections} aviWordCounts={aviWordCounts} aviSentenceCounts={aviSentenceCounts} aviWordSectionCounts={aviWordSectionCounts} aviSentSectionCounts={aviSentSectionCounts} onSourcesChange={onSourcesChange} onSectionsChange={onSectionsChange} onSourceRename={onSourceRename} tasks={tasks} onCompleteLinkedTask={toggleTask} patchTask={patchTask} registerSectionUpdateCallback={registerSectionUpdateCallback} settings={data.settings || {}} appointments={appointments} cards={cards || []} decks={decks || []} grammarMasteryCounts={grammarMasteryCounts} noteTarget={noteTarget} correctionTarget={correctionTarget} correctionSessionTarget={correctionSessionTarget} pendingApptLink={pendingApptLink} onApptLinkConsumed={() => setPendingApptLink(null)}
wordInputs={aviWordInputs} sentenceInputs={aviSentenceInputs}
updateCards={updateCards} updateDecks={updateDecks} onSourceCascadeComplete={onSourceCascadeComplete}
triggerAddSource={clTriggerAddSource} triggerAddQuestion={clTriggerAddQuestion}
triggerAddNote={clTriggerAddNote} triggerAddCorrection={clTriggerAddCorrection} />}
{page === 'flashcards' && <FlashcardsPage soundProfile={soundProfile} dsh={dsh} addTask={addTask} tasks={tasks} onNavigateToGrammar={(entryId) => { setGrammarTarget(entryId); setPage('grammar'); }} cards={cards} decks={decks} fcLoading={fcLoading} updateCards={updateCards} updateDecks={updateDecks} grammarMasteryCounts={grammarMasteryCounts} grammarEntries={grammarEntries} flashcardStudyTarget={flashcardStudyTarget} setFlashcardStudyTarget={setFlashcardStudyTarget} fsrsSettings={data.settings?.fsrs || {}} srsSnapshot={srsSnapshot} onPipelineResult={onPipelineResult} settings={data.settings || {}} />}
{page === 'quizzes' && <QuizzesPage soundProfile={soundProfile} quizSoundsEnabled={quizSoundsEnabled} cards={cards} decks={decks} settings={data.settings || {}} />}

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
    inputsLoaded={aviInputsLoaded}
    settings={data.settings || {}}
    onNavigateToFlashcards={() => setPage('flashcards')}
  />
)}
          </div>
        </main>

        {/* PANELS & MODALS */}
        <ThemePanel open={themeOpen} onClose={() => setThemeOpen(false)} />
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
                          if (item.id === '__appearance') { setThemeOpen(true); setMoreOpen(false); }
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
  useEffect(() => {
    if (!DEMO || !authReady || !user || seedReady) return;
    let cancelled = false;
    ensureDemoSeed(user.uid)
      .catch(e => console.error('AVI: demo seed copy failed', e))
      .finally(() => { if (!cancelled) setSeedReady(true); });
    return () => { cancelled = true; };
  }, [authReady, user, seedReady]);

  // ── Theme ───────────────────────────────────────────────────
  const [themeState, setThemeState] = useState(() => {
    try { return localStorage.getItem(THEME_KEY) || 'ember'; } catch { return 'ember'; }
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

  const [dataLoaded, setDataLoaded] = useState(false); // true once Firestore load completes

  // ── Load from Firestore once auth is ready and user is signed in ──
  useEffect(() => {
    if (!authReady || !user || !seedReady) return;
    let cancelled = false;
    (async () => {
      const remote = await firestoreLoad(user.uid);
      if (cancelled) return;
      if (remote) {
        const dsh = remote.settings?.dayStartHour ?? 3;
        const { tasks: updatedTasks, changed } = runRecurrenceEngine(remote.tasks || [], dsh);
        const next = {
          settings: remote.settings || {},
          tasks: changed ? updatedTasks : (remote.tasks || []),
        };
        setData(next);
        // Seed lastSynced so the first debounced flush only writes local changes.
        seedLastSynced(next);
        // Keep localStorage in sync with what came from Firestore        
        saveState(next);
        // If the engine advanced tasks on load, write back to Firestore immediately
        // so a reload always gets the correct advanced state rather than stale data
        if (changed) {
          firestoreWriteTasksNow(user.uid, next.tasks).catch(e =>
            console.warn('AVI: post-engine Firestore write failed', e)
          );
        }
        // Restore theme from Firestore settings if present
        if (remote.settings?.theme) {
          setThemeState(remote.settings.theme);
          try { localStorage.setItem(THEME_KEY, remote.settings.theme); } catch {}
        }
      }
        // Load Content Library sources/sections for AVI source selector
      getDocs(collection(db, 'users', user.uid, 'content_sections'))
          .then(snap => setAviSections(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
          .catch(() => {});
        Promise.all([
          getDocs(collection(db, 'users', user.uid, 'wordInputs'))
            .then(snap => {
              const full = snap.docs.map(d => ({ ...d.data() }));
              setAviWordInputs(full);
              const src = {}, sec = {};
              full.forEach(({ source: s, section: n }) => {
                if (s) { src[s] = (src[s] || 0) + 1; }
                if (s && n != null) { const k = `${s}|${n}`; sec[k] = (sec[k] || 0) + 1; }
              });
              setAviWordCounts(src);
              setAviWordSectionCounts(sec);
            }).catch(() => {}),
          getDocs(collection(db, 'users', user.uid, 'sentenceInputs'))
            .then(snap => {
              const full = snap.docs.map(d => ({ ...d.data() }));
              setAviSentenceInputs(full);
              const src = {}, sec = {};
              full.forEach(({ source: s, section: n }) => {
                if (s) { src[s] = (src[s] || 0) + 1; }
                if (s && n != null) { const k = `${s}|${n}`; sec[k] = (sec[k] || 0) + 1; }
              });
              setAviSentenceCounts(src);
              setAviSentSectionCounts(sec);
            }).catch(() => {}),
        ]).then(() => setAviInputsLoaded(true));
      setDataLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [authReady, user, seedReady]);

  // ── Sync status & Firestore hook ─────────────────────────────
  const [syncStatus, setSyncStatus] = useState('local');
  const { cards, decks, fcLoading, updateCards, updateDecks } = useFlashcardData(seedReady ? (user?.uid ?? null) : null);

  // Deck IDs whose whole set is paused — held out of due counts, triage, and
  // the spike forecast (Phase D2).
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
    dueAtDayStart: 0, spikes: [], triaged: 0, spikeDetected: false,
  });
  const pipelineRanForUid = useRef(null);

  useEffect(() => {
    const uid = user?.uid;
    if (!uid || !cards) return;
    const dsh = data.settings?.dayStartHour ?? 3;
    const logicalDate = getLogicalDateStr(dsh);
    const pipelineKey = `${uid}:${logicalDate}`;
    if (pipelineRanForUid.current === pipelineKey) return;
    pipelineRanForUid.current = pipelineKey;
    (async () => {
      try {
        const result = await runDailyPipeline(uid, cards, dsh, DEMO ? () => null : addTask, data.tasks ?? [], pausedDeckIds);
        if (result) setSrsSnapshot(result);
        // If triage moved overdue cards, refresh card state from Firestore.
        if (result?.triaged > 0) {
          const { getDocs: gd, collection: col } = await import('firebase/firestore');
          const refreshed = await gd(col(db, 'users', uid, 'flashcards'));
          const refreshedRows = refreshed.docs.map(d => ({ id: d.id, ...d.data() }))
            .filter(c => c.type === 'grammar' || (c.back !== '' && c.back != null));
          updateCards(refreshedRows);
        }
      } catch (e) {
        console.error('App: SRS pipeline failed', e);
      }
    })();
  // cards intentionally included so the effect fires as soon as cards finish loading.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, cards]);

  // Called by FlashcardsPage after each session ends (spike-only re-run result).
  const onPipelineResult = useCallback((result) => {
    if (result) setSrsSnapshot(prev => ({ ...prev, ...result }));
  }, []);
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
  const [aviWordInputs,        setAviWordInputs]        = useState([]);
  const [aviSentenceInputs,    setAviSentenceInputs]    = useState([]);
  const [aviInputsLoaded,      setAviInputsLoaded]      = useState(false);
  const [aviWordCounts,        setAviWordCounts]        = useState({});
  const [aviSentenceCounts,    setAviSentenceCounts]    = useState({});
  const [aviWordSectionCounts, setAviWordSectionCounts] = useState({});
  // AVI pushes its live inputs up so these prop snapshots stay current —
  // they load once at boot via getDocs, and an AVIPage remount otherwise
  // re-initializes from the stale boot data (in-session additions vanish
  // from view until a full reload even though Firestore has them).
  const handleAVIInputsChange = useCallback((words, sents) => {
    setAviWordInputs(words || []);
    setAviSentenceInputs(sents || []);
    const src = {}, sec = {};
    (words || []).forEach(({ source: s, section: n }) => {
      if (s) { src[s] = (src[s] || 0) + 1; }
      if (s && n != null) { const k = `${s}|${n}`; sec[k] = (sec[k] || 0) + 1; }
    });
    setAviWordCounts(src);
    setAviWordSectionCounts(sec);
  }, []);
  const [aviSentSectionCounts, setAviSentSectionCounts] = useState({});

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
      setAviWordInputs(nextW);     setAviWordCounts(wc.src);     setAviWordSectionCounts(wc.sec);
      setAviSentenceInputs(nextS); setAviSentenceCounts(sc.src); setAviSentSectionCounts(sc.sec);
    } catch (e) {
      console.error('Source rename: AVI entry update failed', e);
    }
  }, [user, decks, updateDecks, aviWordInputs, aviSentenceInputs]);

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
      setAviWordCounts(wc.src);     setAviWordSectionCounts(wc.sec);
      setAviSentenceCounts(sc.src); setAviSentSectionCounts(sc.sec);
    } catch (e) { console.error('D3: AVI re-sync failed', e); }
  }, []);

  // ── CL → App state sync (ContentLibraryPage is source of truth) ──
  const handleSourcesChange  = useCallback((s) => setAviSources(s),  []);
  const handleSectionsChange = useCallback((s) => setAviSections(s), []);
  const [noteTarget,          setNoteTarget]          = useState(null);
  const [grammarTarget,       setGrammarTarget]       = useState(null);
  const [flashcardStudyTarget, setFlashcardStudyTarget] = useState(null); // ordered cardIds for a manual Grammar Deck session
  const [correctionTarget,        setCorrectionTarget]        = useState(null);
  const [correctionSessionTarget, setCorrectionSessionTarget] = useState(null);
  const [contentSourceTarget, setContentSourceTarget] = useState(null);
  const { setSyncTarget, seedLastSynced } = useFirestoreSync(user?.uid ?? null, setSyncStatus);

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
  const [page, setPage] = useState(() => {
    const hash = window.location.hash.replace('#', '');
    const valid = ['today','upcoming','overdue','appointments','flashcards','grammar','notes','content','quizzes','avi','settings'];
    return valid.includes(hash) ? hash : 'today';
  });
  const navigateTo = useCallback((id) => {
    setPage(id);
    window.location.hash = id;
  }, []);
  const [themeOpen, setThemeOpen] = useState(false);
  const [addOpen,   setAddOpen]   = useState(false);
  const [addCat,    setAddCat]    = useState(null);
  const [editTask,  setEditTask]  = useState(null);
  const [editOpen,  setEditOpen]  = useState(false);
  const [toast,     setToast]     = useState(null);

  const toastTimer = useRef(null);
  const recurTimer = useRef(null);
  const lastVisibilityRefresh = useRef(0);
  const sectionUpdateCallbackRef = useRef(null);

// Clear navigation targets when page changes
  useEffect(() => {
    if (page !== 'content')  setNoteTarget(null);
    if (page !== 'content')  setCorrectionTarget(null);
    if (page !== 'content')  setCorrectionSessionTarget(null);
    if (page !== 'grammar' && page !== 'content') setGrammarTarget(null);
    if (page !== 'content')  setContentSourceTarget(null);
    if (page !== 'flashcards') setFlashcardStudyTarget(null);
  }, [page]);

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
        const remote = await firestoreLoad(uid);
        if (!remote) return;
        const dsh = remote.settings?.dayStartHour ?? 3;
        const { tasks: updatedTasks, changed } = runRecurrenceEngine(remote.tasks || [], dsh);
        const freshTasks = changed ? updatedTasks : remote.tasks;
        setData(prev => ({
          ...prev,
          settings: remote.settings || prev.settings,
          tasks: freshTasks,
        }));
        if (changed) {
          firestoreWriteTasksNow(uid, freshTasks).catch(e =>
            console.warn('AVI: hourly engine write failed', e)
          );
        }
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
  useEffect(() => {
    if (!dataLoaded || !user?.uid) return;
    const handleVisibility = async () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastVisibilityRefresh.current < 60_000) return;
      lastVisibilityRefresh.current = now;
      try {
        const remote = await firestoreLoad(user.uid);
        if (!remote) return;
        const dsh = remote.settings?.dayStartHour ?? 3;
        const { tasks: updatedTasks, changed } = runRecurrenceEngine(remote.tasks || [], dsh);
        const freshTasks = changed ? updatedTasks : remote.tasks;

        // Refresh all data types, not just tasks
        setData(prev => ({
          ...prev,
          settings: remote.settings || prev.settings,
          tasks: freshTasks,
        }));

        if (changed) {
          firestoreWriteTasksNow(user.uid, freshTasks).catch(e =>
            console.warn('AVI: visibility refresh engine write failed', e)
          );
        }

        // Day-flip detection: if the pipeline ran for a different date, reset it
        // and refresh cards so the pipeline re-runs for the new logical day.
        const currentLogicalDate = getLogicalDateStr(dsh);
        const currentKey = `${user.uid}:${currentLogicalDate}`;
        if (pipelineRanForUid.current && pipelineRanForUid.current !== currentKey) {
          pipelineRanForUid.current = null;
          const { getDocs: gd, collection: col } = await import('firebase/firestore');
          const cardSnap = await gd(col(db, 'users', user.uid, 'flashcards'));
          const refreshedRows = cardSnap.docs.map(d => ({ id: d.id, ...d.data() }))
            .filter(c => c.type === 'grammar' || (c.back !== '' && c.back != null));
          updateCards(refreshedRows);
        }
      } catch (e) {
        console.warn('AVI: visibility refresh failed', e);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [dataLoaded, user?.uid]);

  // ── Helpers ───────────────────────────────────────────────────
  const updateData  = useCallback(u => setData(prev => u(prev)), []);
  const showToast   = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  }, []);

const toggleTask = useCallback((id, occDate, finishEntire) => {
    updateData(prev => {
      const task         = prev.tasks.find(t => t.id === id);
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
              const prevSt  = secSnap.data()?.status || 'Not started';
              if (prevSt === 'Done') return;
              const now     = new Date().toISOString();
              const updates = { status: 'Done', previousStatus: prevSt, lastActivityAt: now };
              await updateDoc(secRef, updates);
              sectionUpdateCallbackRef.current?.(task.linkedSectionId, updates);
            } catch (e) { console.error('Section auto-complete failed:', e); }
          })();
        }
      }

      const updatedTasks = prev.tasks.map(t => {
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
          const dsh = prev.settings?.dayStartHour ?? 3;
          const logicalToday = getLogicalToday(dsh);
          const nextDue = getNextOccurrence(t, logicalToday);
          return {
            ...t,
            completed: true,
            completedAt: new Date().toISOString(),
            recurrence: { ...t.recurrence, nextDue },
          };
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
          const updatedTask = updatedTasks.find(t => t.id === id);
          if (updatedTask) {
            setDoc(doc(db, 'users', uid, 'tasks', id), updatedTask)
              .catch(e => console.warn('AVI: push task immediate write failed', e));
          }
        }
      }

      return { ...prev, tasks: updatedTasks };
    });
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

    if (!createdTasks.length && !Object.keys(taskPatches).length) return false;

    // Tasks flow through the normal debounced whole-doc sync.
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

  const saveTask = useCallback((updatedTask) => {
    updateData(prev => ({
      ...prev,
      tasks: prev.tasks.map(t => t.id === updatedTask.id ? updatedTask : t),
    }));
    if (updatedTask.isAppointmentTask && updatedTask.appointmentId) {
      const uid = auth.currentUser?.uid;
      if (uid) {
        const apptSync = {
          results:     updatedTask.notes    || '',
          category:    updatedTask.category,
          lastUpdated: new Date().toISOString(),
        };
        if (updatedTask.date) apptSync.date = updatedTask.date;
        if (updatedTask.time != null) apptSync.time = updatedTask.time || '';
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

  const openEdit    = useCallback((task) => { setEditTask(task); setEditOpen(true); }, []);
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
      if (e.key === 'Escape') { setAddOpen(false); setThemeOpen(false); setEditOpen(false); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [openAddTask, data.settings?.defaultCategory]);

  // ── Derived values ────────────────────────────────────────────
  const dsh          = data.settings?.dayStartHour ?? 3;

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

  const saveAppointment = useCallback(async (appt) => {
    const uid = user?.uid;
    if (!uid) return;
    if (DEMO && !appointments.some(a => a.id === appt.id) &&
        demoCapReached(appointments, 'appointments')) {
      showToast(DEMO_LIMIT_NOTE);
      return;
    }
    try {
      await setDoc(doc(db, 'users', uid, 'appointments', appt.id), {
        ...appt, lastUpdated: new Date().toISOString(),
      });
    } catch (e) {
      console.error('App: saveAppointment failed', e);
    }
  }, [user?.uid, appointments, showToast]);

  const handleSectionComplete = useCallback(async (sectionId, sourceId, currentApptId) => {
    const uid = user?.uid;
    if (!uid || !sectionId) return;
    const alreadyDone = aviSections.find(s => s.id === sectionId)?.status === 'Done';
    if (alreadyDone) return;
    try {
      await setDoc(doc(db, 'users', uid, 'content_sections', sectionId),
        { status: 'Done' }, { merge: true });
    } catch (e) {
      console.error('handleSectionComplete: write failed', e);
      return;
    }
    const todayStr = toDateStr(getLogicalToday(dsh));
    const nextAppt = [...appointments]
      .filter(a => a.id !== currentApptId && a.mainSourceId === sourceId && a.date >= todayStr)
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    if (!nextAppt) return;
    const ordered     = getOrderedSectionsForSource(aviSections, aviSources, sourceId);
    const currentIdx  = ordered.findIndex(s => s.id === sectionId);
    const nextSection = currentIdx >= 0 ? ordered[currentIdx + 1] : null;
    await saveAppointment({ ...nextAppt, mainSectionId: nextSection?.id || null });
  }, [user?.uid, appointments, aviSections, aviSources, dsh, saveAppointment]);

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
  useEffect(() => {
    if (!user?.uid || !dataLoaded || appointments.length === 0) return;
    const logicalToday = getLogicalToday(dsh);
    const todayStr = toDateStr(logicalToday);

    const toPromote = appointments.filter(appt => {
      if (!appt.date || appt.date >= todayStr) return false;
      if (appt.followUpDate && !appt.followUpQueue) return true; // legacy migration
      return (appt.followUpQueue || []).length > 0;
    });

    if (toPromote.length === 0) return;

    toPromote.forEach(appt => {
      // Migrate legacy single followUpDate field to queue format
      let queue = appt.followUpQueue
        ? [...appt.followUpQueue]
        : [{ date: appt.followUpDate, time: appt.followUpTime || '' }];

      queue.sort((a, b) => a.date.localeCompare(b.date));

      const pastItems   = queue.filter(q => q.date <  todayStr);
      const futureItems = queue.filter(q => q.date >= todayStr);

      // All past dates in chronological order (original appt date first)
      const datesToLog = [appt.date, ...pastItems.map(q => q.date)].sort();

      // Accumulate results — oldest processed first so newest ends on top
      let results = appt.results || '';
      datesToLog.forEach(d => {
        const trimmed = results.trim();
        if (!trimmed)                results = `[${d}]`;
        else if (trimmed.startsWith('[')) results = `[${d}]\n${trimmed}`;
        else                         results = `[${d}] ${trimmed}`;
      });

      const lastVisitDate  = datesToLog[datesToLog.length - 1];
      const newDate        = futureItems.length > 0 ? futureItems[0].date         : lastVisitDate;
      const newTime        = futureItems.length > 0 ? (futureItems[0].time || '') : (appt.time || '');
      const remainingQueue = futureItems.length > 0 ? futureItems.slice(1)        : [];

      // Strip legacy fields before writing
      const { followUpDate: _fd, followUpTime: _ft, ...apptBase } = appt;
      const updatedAppt = { ...apptBase, date: newDate, time: newTime, results, followUpQueue: remainingQueue, lastVisitDate };

      saveAppointment(updatedAppt);

      if (appt.taskId) {
        const hasUpcoming = futureItems.length > 0;
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
  }, [appointments, dataLoaded, user?.uid, dsh, saveAppointment, updateData]);

  const todayBadgeStr = toDateStr(getLogicalToday(dsh));
  const todayCount   = tasks.filter(t => taskOccursOn(t, todayBadgeStr) && !isDateDone(t, todayBadgeStr)).length;
  const overdueCount = tasks.filter(t => {
    if (t.completed) return false;
    const last = taskLastDate(t);
    return (last && isPast(parseDate(last), dsh) && (!t.recurrence || t.recurrence.type === 'none')) || !last;
  }).length;

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
      <InnerApp
        data={data} page={page} setPage={navigateTo}
        themeOpen={themeOpen} setThemeOpen={setThemeOpen}
        addOpen={addOpen} setAddOpen={setAddOpen} addCat={addCat}
        editTask={editTask} editOpen={editOpen}
        openEdit={openEdit} closeEdit={closeEdit}
        saveTask={saveTask} deleteTask={deleteTask}
        toast={toast} dsh={dsh} tasks={tasks}
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
        srsSnapshot={srsSnapshot} onPipelineResult={onPipelineResult}
        cards={cards} decks={decks} fcLoading={fcLoading}
        updateCards={updateCards} updateDecks={updateDecks}
        noteTarget={noteTarget} setNoteTarget={setNoteTarget}
        grammarTarget={grammarTarget} setGrammarTarget={setGrammarTarget}
        grammarMasteryCounts={grammarMasteryCounts}
        onMasteryCounts={setGrammarMasteryCounts}
        getCardNextDueDate={getCardNextDueDate}
        onCardNextDueDateChanged={onCardNextDueDateChanged}
        grammarEntries={grammarEntries} onEntriesChange={setGrammarEntries}
        flashcardStudyTarget={flashcardStudyTarget} setFlashcardStudyTarget={setFlashcardStudyTarget}
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
