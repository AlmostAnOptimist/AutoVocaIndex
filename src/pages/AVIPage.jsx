// src/pages/AVIPage.jsx
// AVI shell: sub-nav routing, lifted state, 7-second toast system.
// Source selector lives in the App.jsx topbar — currentSource/currentSection
// come in as props from App.jsx (from data.settings.aviCurrentSource/Section).
// Tab content rendered by child page components (built in Phase 5).

import { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { useAVIData } from '../hooks/useAVIData.js';
import { SH } from '../theme/buildStyles.js';
import { auth } from '../firebase.js';
import { AVIOverviewPage } from './avi/AVIOverviewPage.jsx';
import { AVIImportPage } from './avi/AVIImportPage.jsx';
import { AVISourcePage } from './avi/AVISourcePage.jsx';
import { AVIWordInputPage } from './avi/AVIWordInputPage.jsx';
import { AVISentenceInputPage } from './avi/AVISentenceInputPage.jsx';
import { ensureNuanceFlashcard, autoCreateSentenceCard } from '../utils/cardFactory.js';
import { AVILemmaMasterPage } from './avi/AVILemmaMasterPage.jsx';
import { AVISearchPage } from './avi/AVISearchPage.jsx';
import { AVIRecentPage } from './avi/AVIRecentPage.jsx';
import { AVIMobileNav } from '../components/avi/AVIMobileNav.jsx';
import { NUANCE_SOURCE_TITLE, normalizeLemma } from '../utils/aviUtils.js';

const isMobile = typeof window !== 'undefined' && window.innerWidth <= 700;

// ── Tab persistence key ───────────────────────────────────────
const AVI_TAB_KEY = 'avi_tab';
const AVI_SRC_KEY = 'avi_src';
const AVI_SEC_KEY = 'avi_sec';

// ── Tab definitions ───────────────────────────────────────────
const AVI_TABS = [
  { id: 'overview',  label: 'Overview'       },
  { id: 'import',    label: 'Import'         },
  { id: 'word',      label: 'Word Input'     },
  { id: 'sentence',  label: 'Sentence Input' },
  { id: 'lemma',     label: 'Lemma Master'   },
  { id: 'search',    label: 'Search'         },
  { id: 'source',    label: 'Source'         },
  { id: 'recent',    label: 'Recent', badge: true },
];

// ── AVI Toast ─────────────────────────────────────────────────
// 7-second dismissible toast for lemma update notifications.
function AVIToast({ message, actionLabel, onAction, onDismiss, C }) {
  // Portaled to document.body — this mounts inside AVIPage's `.fade-up`
  // wrapper, whose persistent transform would otherwise position the toast
  // against the content area (off-center, wrong bottom) instead of the viewport.
  return createPortal(
    <div style={{
      position: 'fixed', bottom: '24px', left: '50%',
      transform: 'translateX(-50%)',
      background: C.raised, border: `1px solid ${C.accent}`,
      borderRadius: '10px', padding: '12px 18px',
      display: 'flex', alignItems: 'center', gap: '12px',
      boxShadow: '0 4px 20px rgba(0,0,0,0.25)',
      zIndex: 200, maxWidth: '480px', width: 'calc(100vw - 48px)',
      fontSize: '13px', color: C.text,
    }}>
      <span style={{ flex: 1, fontFamily: SH.fk }}>{message}</span>
      <button
        onClick={onAction}
        style={{
          fontSize: '12px', padding: '3px 10px', borderRadius: '6px',
          border: `1px solid ${C.accent}`, background: C.accentSoft,
          color: C.accent, cursor: 'pointer', flexShrink: 0, fontWeight: 600,
        }}
      >
        {actionLabel}
      </button>
      <button
        onClick={onDismiss}
        style={{
          background: 'none', border: 'none', color: C.textM,
          cursor: 'pointer', fontSize: '16px', lineHeight: 1,
          padding: '0 2px', flexShrink: 0,
        }}
      >
        ✕
      </button>
    </div>,
    document.body
  );
}

// ── Main page ─────────────────────────────────────────────────
export function AVIPage({
  // Flashcard props from App.jsx
  cards, decks, updateCards, updateDecks,
  // Source/section from App.jsx data.settings
  currentSource, currentSection,
  // Content Library sources and sections (loaded by App.jsx)
  aviSources, aviSections,
  // Pre-loaded AVI data from App.jsx (eliminates duplicate Firestore reads)
  wordInputs, sentenceInputs, settings, inputsLoaded, onAVIInputsChange,
  onNavigateToFlashcards,
}) {
  const { C } = useAppTheme();
    const { data, updateData, loading, syncStatus } = useAVIData({ wordInputs, sentenceInputs, settingsData: settings, inputsLoaded, onInputsChange: onAVIInputsChange });


  // ── Tab state — persists to localStorage ─────────────────────
  const [activeTab, setActiveTab] = useState(() => {
    try { return localStorage.getItem(AVI_TAB_KEY) || 'overview'; } catch { return 'overview'; }
  });

  const handleSetTab = useCallback((tab) => {
    setActiveTab(tab);
    try { localStorage.setItem(AVI_TAB_KEY, tab); } catch {}
  }, []);

  // ── Lifted pagination state (persists across tab switches) ────
  const [siPage,    setSiPage]    = useState(0);
  const [lmPage,    setLmPage]    = useState(0);
  const [srcFilter, setSrcFilterRaw] = useState(() => {
    try { return localStorage.getItem(AVI_SRC_KEY) || ''; } catch { return ''; }
  });
  const [secFilter, setSecFilterRaw] = useState(() => {
    try { return localStorage.getItem(AVI_SEC_KEY) || '(All)'; } catch { return '(All)'; }
  });

  const setSrcFilter = useCallback((val) => {
    setSrcFilterRaw(val);
    try { localStorage.setItem(AVI_SRC_KEY, val); } catch {}
  }, []);

  const setSecFilter = useCallback((val) => {
    setSecFilterRaw(val);
    try { localStorage.setItem(AVI_SEC_KEY, val); } catch {}
  }, []);

  // ── Toast system (7-second AVI notifications) ─────────────────
  const [toast,     setToast]     = useState(null);
  const toastTimer = useRef(null);

  const showAVIToast = useCallback((message, action) => {
    setToast({ message, action });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 7000);
  }, []);

  const dismissToast = useCallback(() => {
    clearTimeout(toastTimer.current);
    setToast(null);
  }, []);

  const navigateToRecent = useCallback(() => {
    handleSetTab('recent');
    dismissToast();
  }, [handleSetTab, dismissToast]);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // Reactive sync: ensure every 동의어/유의어-tagged lemma has its own
  // flashcard in that deck. Catches up on rows created by auto-add, merge,
  // or the one-time backfill — none of which pass through the edit
  // transition that normally triggers card creation.
  //
  // `nuanceInFlight` is a synchronous guard against a real race: creating a
  // card changes `cards`/`decks`, which re-triggers this effect, and React
  // state doesn't reflect an async write until it actually resolves — so an
  // overlapping run could see "no card yet" for a row whose creation is
  // already underway and start a second one. The ref updates immediately,
  // before any `await`, so a re-run always sees in-progress work regardless
  // of whether state has caught up yet.
  const nuanceInFlight = useRef(new Set());
  useEffect(() => {
    if (loading) return;
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    data.wordInputs
      .filter(w => w.source === NUANCE_SOURCE_TITLE)
      .forEach(row => {
        const key = normalizeLemma(row.lemma);
        if (nuanceInFlight.current.has(key)) return;
        const lemmaEntry = data.lemmaMaster.find(l => normalizeLemma(l.lemma) === key);
        if (!lemmaEntry) return;
        nuanceInFlight.current.add(key);
        ensureNuanceFlashcard({
          row, lemmaEntry, cards, decks, uid, updateCards, updateDecks, aviSources,
          dsh: settings?.dayStartHour ?? 3,
        })
          .catch(e => console.error('Nuance flashcard sync failed', e))
          .finally(() => nuanceInFlight.current.delete(key));
      });
  }, [data.wordInputs, data.lemmaMaster, cards, decks, aviSources, loading]);

  // ── Sentence cardBack cascade ─────────────────────────────────
  // When a lemmaMaster entry gains def1 or def2 after sentence rows were
  // committed (lazy import defs), propagate the new cardBack and trigger
  // card creation. Mirrors the nuanceInFlight guard pattern exactly.
  const cardBackInFlight = useRef(new Set());
  useEffect(() => {
    if (loading) return;
    const uid = auth.currentUser?.uid;
    if (!uid) return;

    const defByNorm = {};
    for (const l of data.lemmaMaster) {
      const k = normalizeLemma(l.lemma);
      const cb = l.def2 || l.def1 || '';
      if (k && cb) defByNorm[k] = cb;
    }

    const toFix = data.sentenceInputs.filter(s =>
      !s.cardBack && !s.skipUpload &&
      !cardBackInFlight.current.has(s.uid) &&
      defByNorm[normalizeLemma(s.targetWord)]
    );
    if (!toFix.length) return;

    const fixMap = Object.fromEntries(
      toFix.map(s => [s.uid, defByNorm[normalizeLemma(s.targetWord)]])
    );
    toFix.forEach(s => cardBackInFlight.current.add(s.uid));

    updateData(prev => ({
      ...prev,
      sentenceInputs: prev.sentenceInputs.map(s =>
        fixMap[s.uid] ? { ...s, cardBack: fixMap[s.uid] } : s
      ),
    }));

    for (const row of toFix) {
      const cardBack = fixMap[row.uid];
      autoCreateSentenceCard({
        entry: { ...row, cardBack },
        lemmaMaster: data.lemmaMaster,
        cards, decks, uid, updateCards, updateDecks, aviSources,
        dsh: settings?.dayStartHour ?? 3,
      }).then(() => {
        updateData(prev => ({
          ...prev,
          sentenceInputs: prev.sentenceInputs.map(s =>
            s.uid === row.uid ? { ...s, uploaded: true } : s
          ),
        }));
      }).catch(e => console.error('cardBack cascade: card creation failed', e))
        .finally(() => cardBackInFlight.current.delete(row.uid));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.lemmaMaster, data.sentenceInputs, loading]);

  // ── Recently reset badge count ────────────────────────────────
  const recentCount =
    data.wordInputs.filter(w => !w.uploaded && !w.skipUpload && w.lastUncheckReason).length +
    data.sentenceInputs.filter(s => !s.uploaded && !s.skipUpload && s.lastUncheckReason).length;

  // ── Shared props for all tab pages ────────────────────────────
  const sharedProps = {
    data, updateData, showAVIToast,
    settings,
    dsh: settings?.dayStartHour ?? 3,
    navigateToRecent: () => handleSetTab('recent'),
    setAVITab: handleSetTab,
    cards, decks, updateCards, updateDecks,
    // Source context (from App.jsx)
    currentSource, currentSection,
    aviSources:  aviSources  || [],
    aviSections: aviSections || [],
    // Lifted pagination
    siPage, setSiPage,
    lmPage, setLmPage,
    // Source tab filter
    srcFilter, setSrcFilter,
    secFilter, setSecFilter,
    // Cross-tab navigation
    goToSource: (src, sec) => {
      setSrcFilter(src || '');
      setSecFilter(sec ? String(sec) : '(All)');
      handleSetTab('source');
    },
    goToSearch: (query) => {
      pendingSearchQuery.current = query || '';
      handleSetTab('search');
    },
  };

  const pendingSearchQuery = useRef('');

  // Tabs that have adopted the flowing-content + sticky-stack layout
  // (Stage 2+). Everything else keeps today's self-contained internal
  // scroll box, so this is a no-op for them until they opt in.
  const FLOWING_TABS = ['search'];
  const isFlowing = FLOWING_TABS.includes(activeTab);

  if (loading) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        minHeight: '300px', color: C.textM, fontSize: '13px',
      }}>
        Loading AVI data…
      </div>
    );
  }

  return (
    <div className="fade-up" style={{ display: 'flex', flexDirection: 'column', height: '100%', paddingBottom: isMobile ? '56px' : 0 }}>

      {/* ── Scroll shell: sticky tab strip + tab content share one
           scrolling ancestor so flowing tabs can stack sticky layers
           on top of the tab strip. ─────────────────────────────── */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>

      {/* ── Sub-nav tab row — matches NotesPage style ─────────── */}
      {/* Mobile gets the Nav button + radial fan instead, portaled into
          App.jsx's header (see AVIMobileNav render below) — this whole
          row is desktop-only. */}
      {!isMobile && (
      <div style={{ flexShrink: 0, position: 'sticky', top: 0, zIndex: 1, background: C.bg, marginBottom: '16px' }}>
        <div style={{
          display: 'flex', gap: '4px',
          background: C.cardBg || C.surface,
          border: `1px solid ${C.border}`,
          padding: '4px', borderRadius: '12px',
          width: 'fit-content',
          overflowX: 'auto',
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
        }}>
          {AVI_TABS.map(tab => {
            const active = activeTab === tab.id;
            const badgeCount = tab.badge ? recentCount : 0;
            return (
              <button
                key={tab.id}
                onClick={() => handleSetTab(tab.id)}
                style={{
                  padding: '6px 14px', borderRadius: '8px',
                  fontSize: '12.5px', fontWeight: 500,
                  color: active ? C.text : C.textS,
                  cursor: 'pointer', transition: 'all 0.15s',
                  background: active ? C.raised : 'transparent',
                  boxShadow: active ? '0 1px 4px rgba(0,0,0,0.2)' : 'none',
                  border: 'none', whiteSpace: 'nowrap',
                }}
              >
                {tab.label}
                {badgeCount > 0 && (
                  <span style={{ marginLeft: '5px', fontSize: '11px', opacity: 0.6 }}>
                    {badgeCount}
                  </span>
                )}
              </button>
            );
          })}

          {/* Sync status dot — inside the pill strip, after the last tab */}
          <div style={{
            display: 'flex', alignItems: 'center',
            paddingLeft: '6px', paddingRight: '4px', flexShrink: 0,
          }}>
            <div style={{
              width: '6px', height: '6px', borderRadius: '50%',
              background:
                syncStatus === 'ok'      ? (C.success || '#5ba05b') :
                syncStatus === 'syncing' ? C.accent :
                syncStatus === 'error'   ? (C.danger  || '#c0392b') :
                C.textM,
            }} />
          </div>
        </div>
      </div>
      )}

      <AVIMobileNav
        tabs={AVI_TABS}
        activeTab={activeTab}
        onSelect={handleSetTab}
        recentCount={recentCount}
        syncStatus={syncStatus}
      />

      {/* ── Tab content ────────────────────────────────────────── */}
      <div style={{ flex: isFlowing ? 'none' : 1, minHeight: isFlowing ? 'auto' : 0 }}>
        {activeTab === 'overview'  && <AVIOverviewPage         {...sharedProps} />}
        {activeTab === 'import'    && <AVIImportPage           {...sharedProps} />}
        {activeTab === 'word'      && <AVIWordInputPage        {...sharedProps} />}
        {activeTab === 'sentence'  && <AVISentenceInputPage    {...sharedProps} />}
        {activeTab === 'lemma'     && <AVILemmaMasterPage      {...sharedProps} />}
        {activeTab === 'search'    && <AVISearchPage           {...sharedProps} pendingQuery={pendingSearchQuery} />}
        {activeTab === 'source'    && <AVISourcePage           {...sharedProps} />}
        {activeTab === 'recent'    && <AVIRecentPage           {...sharedProps} />}
      </div>

      </div>
      {/* ── AVI toast ─────────────────────────────────────────── */}
      {toast && (
        <AVIToast
          message={toast.message}
          actionLabel={toast.action === 'goToNuanceSource' ? 'View →' : toast.action === 'goToFlashcards' ? 'Study →' : 'Review →'}
          onAction={() => {
            if (toast.action === 'goToNuanceSource') {
              setSrcFilter(NUANCE_SOURCE_TITLE);
              setSecFilter('(All)');
              handleSetTab('source');
              dismissToast();
            } else if (toast.action === 'goToFlashcards') {
              onNavigateToFlashcards?.();
              dismissToast();
            } else {
              navigateToRecent();
            }
          }}
          onDismiss={dismissToast}
          C={C}
        />
      )}
    </div>
  );
}

// ── Placeholder tab components (replaced in Phase 5) ─────────
function TabPlaceholder({ label, data, currentSource, C }) {
  return (
    <div style={{ padding: '32px 0', color: C.textM, fontSize: '13px' }}>
      <div style={{
        fontFamily: SH.fd, fontSize: '18px',
        color: C.text, marginBottom: '20px',
      }}>
        {label}
      </div>
      <div style={{ fontFamily: SH.fm, fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <div>Words: {data.wordInputs.length}</div>
        <div>Sentences: {data.sentenceInputs.length}</div>
        <div>Lemmas: {data.lemmaMaster.length}</div>
        <div>Current source: {currentSource || '(none)'}</div>
        <div style={{ marginTop: '8px', color: C.textM, fontStyle: 'italic' }}>
          Tab content coming in Phase 5.
        </div>
      </div>
    </div>
  );
}