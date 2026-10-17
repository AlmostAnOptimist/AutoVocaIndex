// src/pages/avi/AVIWordInputPage.jsx
// AVI Word Input tab.
// Handles word staging, inline editing, lemma cascade (with bug fixes),
// and automatic flashcard creation when def2 is present.

import { useState, useCallback, useEffect, useMemo, useRef, memo } from 'react';
import { auth } from '../../firebase.js';
import { useAppTheme } from '../../hooks/useAppTheme.js';
import { SH } from '../../theme/buildStyles.js';
import { Def1Display } from '../../components/avi/Def1Display.jsx';
import {
  extractLemmaFromText, writeGlobalLemma, fetchDefinition,
  getSourceSections, updateLinkedCards,
} from '../../utils/aviUtils.js';
import { AVIMiniSearchPopup } from '../../components/avi/AVIMiniSearchPopup.jsx';
import { autoCreateWordCard } from '../../utils/cardFactory.js';
import { stageWordInput } from '../../utils/wordStaging.js';
import { DEMO } from '../../demo/demoConfig.js';
import { WordEditModal } from '../../components/avi/WordEditModal.jsx';
import { makeUpdateRow } from '../../utils/wordRowUpdater.js';
import { Icons, MagnifyIcon } from '../../components/Icons.jsx';
import { PaginationFooter } from '../../components/PaginationFooter.jsx';
import { usePaginationKeys } from '../../hooks/usePaginationKeys.js';

const WI_PAGE_SIZE = 25;
const isMobile = typeof window !== 'undefined' && (window.innerWidth <= 700 || window.matchMedia('(hover: none) and (pointer: coarse) and (orientation: portrait)').matches);

// ── Auto-card creation ────────────────────────────────────────
// autoCreateWordCard and ensureNuanceFlashcard live in
// src/utils/cardFactory.js (leaf module — Fable sweep Round D, W7).

// Card back/front updates for word edits are handled by the shared
// aviUtils.updateLinkedCards helper (see updateRow's async tail).

// ── WordRow ────────────────────────────────────────────────────
// View-only rows — all editing goes through the shared WordEditModal
// (opened by tapping the row content).
const WordRow = memo(function WordRow({
  w, onEdit,
  toggleSkip, deleteRow,
  isOrphaned, onSourceClick, onOpenSearch,
  highlighted, C,
}) {
  const rowBg =
    highlighted         ? `${C.accent}26` :
    w.lastUncheckReason ? `${C.warning}10` :
    w.uploaded          ? `${C.success}08` :
    isOrphaned          ? `${C.danger}08`  :
    'transparent';

  const td = {
    padding: '7px 10px', fontSize: '12px', color: C.text,
    verticalAlign: 'top', borderBottom: `1px solid ${C.border}`,
  };

  if (isMobile) {
    return (
      <div style={{ background: rowBg === 'transparent' ? C.surface : rowBg, border: `1px solid ${C.border}`, borderRadius: '10px', padding: '11px 12px', marginBottom: '8px', transition: 'background 0.4s' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }} onClick={() => onEdit(w)}>
          <span style={{ fontFamily: SH.fk, fontWeight: 700, fontSize: '15px', color: C.accent, cursor: 'pointer' }}>{w.lemma}</span>
          <span
            onClick={e => { e.stopPropagation(); onSourceClick(w.source, w.section); }}
            style={{ display: 'inline-block', padding: '2px 7px', borderRadius: '4px', fontSize: '10.5px', background: isOrphaned ? `${C.danger}18` : C.accentSoft, color: isOrphaned ? C.danger : C.accent, cursor: 'pointer', fontFamily: SH.fm, flexShrink: 0 }}
          >
            {w.source}{w.section ? ` · §${w.section}` : ''}
          </span>
        </div>
        <div
          onClick={() => onEdit(w)}
          style={{ fontSize: '11.5px', lineHeight: 1.5, cursor: 'pointer', marginTop: '4px', color: w.def2 ? C.textS : C.textM, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
        >
          {w.def2 || '—'}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '9px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: C.textM, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!w.skipUpload}
              onChange={e => toggleSkip(w.uid, e.target.checked)}
              style={{ accentColor: C.accent, cursor: 'pointer' }}
            />
            Skip
          </label>
          <div style={{ display: 'flex', gap: '14px' }}>
            <button
              onClick={() => onOpenSearch(w.lemma)}
              style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'none', border: 'none', color: C.textM, cursor: 'pointer', fontSize: '11px', padding: 0 }}
            >
              <MagnifyIcon size={11} /> Search
            </button>
            <button
              onClick={() => deleteRow(w.uid)}
              style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'none', border: 'none', color: C.danger, cursor: 'pointer', fontSize: '11px', padding: 0 }}
            >
              {Icons.trash} Delete
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <tr style={{ background: rowBg, transition: 'background 0.4s' }}>
      {/* Input (surface form) */}
      <td style={td}>
        <span style={{ fontFamily: SH.fk, fontSize: '13px', fontWeight: 500 }}>{w.input}</span>
      </td>

      {/* Lemma */}
      <td style={td}>
        <span
          style={{ fontFamily: SH.fk, fontSize: '13px', color: C.accent, cursor: 'pointer' }}
          onClick={() => onEdit(w)}
        >
          {w.lemma}
        </span>
      </td>

      {/* Definition 1 */}
      <td style={{ ...td, maxWidth: '220px' }}>
        <Def1Display text={w.def1} onClick={() => onEdit(w)} />
      </td>

      {/* Definition 2 */}
      <td style={{ ...td, maxWidth: '220px' }}>
        <div
          style={{ fontSize: '12px', lineHeight: 1.5, cursor: 'pointer', minHeight: '20px', color: w.def2 ? C.text : C.textM, whiteSpace: 'pre-wrap' }}
          onClick={() => onEdit(w)}
        >
          {w.def2 || '—'}
        </div>
      </td>

      {/* Source · § */}
      <td style={td}>
        <span
          style={{
            display: 'inline-block', padding: '2px 7px', borderRadius: '4px', fontSize: '11px',
            background: isOrphaned ? `${C.danger}18` : C.accentSoft,
            color: isOrphaned ? C.danger : C.accent,
            cursor: 'pointer', fontFamily: SH.fm,
          }}
          title="Open in Source view"
          onClick={() => onSourceClick(w.source, w.section)}
        >
          {w.source}{w.section ? ` · §${w.section}` : ''}
        </span>
      </td>

      {/* Skip */}
      <td style={{ ...td, textAlign: 'center', width: '50px' }}>
        <input
          type="checkbox"
          checked={!!w.skipUpload}
          onChange={e => toggleSkip(w.uid, e.target.checked)}
          style={{ accentColor: C.accent, cursor: 'pointer' }}
          title="Skip — don't create a flashcard for this entry"
        />
      </td>

      {/* Action buttons */}
      <td style={{ ...td, width: '52px' }}>
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
          <button
            style={{
              background: 'none', border: 'none', color: C.textM,
              cursor: 'pointer', padding: '2px 3px', lineHeight: 1,
              borderRadius: '4px',
            }}
            title={`Search similarity for "${w.lemma}"`}
            onClick={() => onOpenSearch(w.lemma)}
          >
            <MagnifyIcon size={13} />
          </button>
          <button
            style={{
              background: 'none', border: 'none', color: C.textM,
              cursor: 'pointer', fontSize: '14px', lineHeight: 1,
              padding: '2px 3px', borderRadius: '4px',
            }}
            title="Delete this Word Input row (Lemma Master not affected)"
            onClick={() => deleteRow(w.uid)}
          >
            ✕
          </button>
        </div>
      </td>
    </tr>
  );
});

// ── Main page ──────────────────────────────────────────────────
export function AVIWordInputPage({
  data, updateData, showAVIToast,
  currentSource, currentSection,
  aviSources, aviSections,
  cards, decks, updateCards, updateDecks,
  goToSource, goToSearch, dsh,
  inputSearch, setInputSearch,
}) {
  const { C, S } = useAppTheme();
  const uid = auth.currentUser?.uid;
  const needsSection = getSourceSections(aviSources, aviSections, currentSource).length > 0 && !currentSection;

  const [stagingText,  setStagingText]  = useState('');
  const [processing,   setProcessing]   = useState(false);
  const [wordPage,     setWordPage]     = useState(0);
  const [editModalUid, setEditModalUid] = useState(null);
  const [highlightUid, setHighlightUid] = useState(null);
  const scrollRef = useRef(null);
  const [searchPopup, setSearchPopup] = useState(null);

  const scrollToTop = () =>
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });

  // ── Stage a new word ────────────────────────────────────────
  // The pipeline itself lives in utils/wordStaging.js (AS5a), shared with the
  // Search tab's "Add to Word Input" dialog. This page keeps the UI around it.
  const handleStageWord = async () => {
    if (DEMO) return; // demo: intake flows through the Sentence Input picker (D5)
    const raw = stagingText.trim();
    if (!raw) return;
    if (!currentSource || needsSection) return; // blocked by UI

    setProcessing(true);
    try {
      const result = await stageWordInput({
        surface: raw,
        source:  currentSource,
        section: currentSection,
        data, updateData,
        cards, decks, uid, updateCards, updateDecks, aviSources, dsh,
        showAVIToast,
        onStaged: () => {
          setStagingText('');
          setWordPage(0);
        },
      });

      // Duplicate staging guard: jump to and highlight the existing row.
      if (result.status === 'duplicate') {
        const exactDup = result.row;
        const sorted = [...data.wordInputs].sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
        const idx = sorted.findIndex(w => w.uid === exactDup.uid);
        if (idx >= 0) setWordPage(Math.floor(idx / WI_PAGE_SIZE));
        setHighlightUid(exactDup.uid);
        window.setTimeout(() => setHighlightUid(null), 2600);
        showAVIToast('Already staged in this section — showing the existing row.');
        setStagingText('');
      }
    } catch (e) {
      console.error('Word Input: stage failed', e);
    } finally {
      setProcessing(false);
    }
  };

  // ── Toggle skip ─────────────────────────────────────────────
  // Bug #1 fix: was incorrectly setting `uploaded` instead of `skipUpload`.
  const toggleSkip = useCallback((uid, val) => {
    updateData(prev => ({
      ...prev,
      wordInputs: prev.wordInputs.map(w =>
        w.uid === uid ? { ...w, skipUpload: val } : w
      ),
    }));
  }, [updateData]);

  // ── Delete row ──────────────────────────────────────────────
  const deleteRow = useCallback((uid) => {
    if (!window.confirm('Delete this Word Input row? The Lemma Master entry will not be affected.')) return;
    updateData(prev => ({
      ...prev,
      wordInputs: prev.wordInputs.filter(w => w.uid !== uid),
    }));
  }, [updateData]);

  // ── Update row (edit save) ──────────────────────────────────
  // The full edit cascade lives in utils/wordRowUpdater.js, shared with the
  // Import tab's post-commit Fill-Def2 pass. autoCreateWordCard is injected
  // there to avoid a circular import.
  const updateRow = useMemo(() => makeUpdateRow({
    data, updateData, cards, updateCards, decks, updateDecks, aviSources,
    autoCreateWordCard, dsh,
  }), [data, updateData, cards, updateCards, decks, updateDecks, aviSources, dsh]);

  // ── Search + pagination ─────────────────────────────────────
  // The query lives in AVIPage (rendered in the sticky tab strip on
  // desktop; the mobile input below binds to the same state). NFC on both
  // sides so pre-repair decomposed rows still match a composed query.
  const q = (inputSearch || '').normalize('NFC').trim().toLowerCase();
  const matchesSearch = (w) => !q ||
    [w.input, w.lemma, w.def1, w.def2]
      .some(f => (f || '').normalize('NFC').toLowerCase().includes(q));
  const allWords     = [...data.wordInputs].filter(matchesSearch).sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));

  // Back to page 0 whenever the query changes so results are visible.
  useEffect(() => { setWordPage(0); }, [inputSearch]);
  const totalPages   = Math.ceil(allWords.length / WI_PAGE_SIZE);
  const page         = Math.min(wordPage, Math.max(0, totalPages - 1));
  const pagedWords   = allWords.slice(page * WI_PAGE_SIZE, (page + 1) * WI_PAGE_SIZE);

  // ←/→ paginate the word table; disabled while search popup or edit modal is open.
  usePaginationKeys({
    page,
    totalPages,
    setPage: (p) => { setWordPage(p); scrollToTop(); },
    enabled: !searchPopup && !editModalUid,
  });

  const activeSourceNames = new Set((aviSources || []).map(s => s.title));

  // ── Render ──────────────────────────────────────────────────
  const thStyle = {
    padding: '7px 10px', fontSize: '10px', fontWeight: 700,
    letterSpacing: '0.07em', textTransform: 'uppercase',
    color: C.textM, borderBottom: `2px solid ${C.border}`,
    textAlign: 'left', whiteSpace: 'nowrap',
    position: 'sticky', top: 0, background: C.raised, zIndex: 1,
  };

  return (
    <>
      <div className="avi-input-layout" style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: '16px', height: isMobile ? 'auto' : '100%' }}>

      {/* ── Staging panel ──────────────────────────────────── */}
      <div className="avi-staging-panel" style={{
        width: isMobile ? '100%' : '280px', flexShrink: 0,
        display: 'flex', flexDirection: 'column', gap: '10px',
        overflowY: 'auto',
      }}>

        <div style={{ fontFamily: SH.fd, fontSize: '14px', color: C.text }}>
          ◈ Word Staging
        </div>
        <div style={{ fontSize: '12px', color: C.textM, lineHeight: 1.5 }}>
          Paste a word or phrase. It will be cleaned, lemmatized, and have a dictionary definition fetched automatically.
        </div>
        {DEMO && (
          <div style={{ fontSize: '12px', color: C.warning, fontWeight: 500, lineHeight: 1.5 }}>
            Word adding is disabled in the demo. Add a sentence in Sentence Input and choose target words there — new words arrive through the picker.
          </div>
        )}
        <textarea
          style={{
            width: '100%', padding: '10px 12px', borderRadius: '8px', fontSize: '13px',
            border: `1px solid ${C.border}`, background: C.bg, color: C.text,
            outline: 'none', resize: 'vertical', minHeight: '100px', lineHeight: 1.6,
            fontFamily: SH.fk, boxSizing: 'border-box',
          }}
          placeholder="Paste word or phrase here…"
          value={stagingText}
          onChange={e => setStagingText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleStageWord();
          }}
          rows={4}
          disabled={DEMO}
        />
        {!currentSource && (
          <div style={{ fontSize: '11px', color: C.warning, fontWeight: 500 }}>
            ← Select a source in the top bar before staging.
          </div>
        )}
        {currentSource && needsSection && (
          <div style={{ fontSize: '11px', color: C.warning, fontWeight: 500 }}>
            ← This source has sections — pick one in the top bar before staging.
          </div>
        )}
        <button
          style={{
            ...S.btnPrimary,
            padding: '9px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 600,
            opacity: (DEMO || processing || !stagingText.trim() || !currentSource || needsSection) ? 0.5 : 1,
            transition: 'opacity 0.15s',
          }}
          onClick={handleStageWord}
          disabled={DEMO || processing || !stagingText.trim() || !currentSource || needsSection}
        >
          {processing
            ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}><span className="icon-spin" style={{ display: 'inline-flex' }}>{Icons.refresh}</span> Processing…</span>
            : <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>{Icons.plus} Add Word</span>
          }
        </button>
        <div style={{ fontSize: '11px', color: C.textM, fontFamily: SH.fm }}>
          {q
            ? `${allWords.length} of ${data.wordInputs.length} match`
            : `${allWords.length} ${allWords.length === 1 ? 'entry' : 'entries'}`}
        </div>
      </div>

      {/* ── Word table ─────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>

        {/* Mobile search — the desktop input lives in AVIPage's tab strip */}
        {isMobile && (
          <input
            type="text"
            value={inputSearch || ''}
            onChange={e => setInputSearch(e.target.value)}
            placeholder="Search words…"
            style={{
              fontSize: '16px', padding: '8px 12px', borderRadius: '8px',
              border: `1px solid ${C.border}`, background: C.surface, color: C.text,
              outline: 'none', marginBottom: '10px', width: '100%', boxSizing: 'border-box',
            }}
          />
        )}

        {/* Scrollable table area (mobile: card list instead of a table) */}
        <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', overflowX: isMobile ? 'hidden' : 'auto' }}>
          {isMobile ? (
            <>
              {pagedWords.length === 0 && (
                <div style={{ padding: '24px', textAlign: 'center', color: C.textM, fontSize: '13px' }}>
                  {q ? 'No entries match your search.' : 'No entries yet. Paste a word above.'}
                </div>
              )}
              {pagedWords.map(w => (
                <WordRow
                  key={w.uid}
                  w={w}
                  onEdit={(row) => setEditModalUid(row.uid)}
                  toggleSkip={toggleSkip}
                  deleteRow={deleteRow}
                  isOrphaned={!!w.source && !activeSourceNames.has(w.source)}
                  onSourceClick={goToSource}
                  onOpenSearch={(lemma) => setSearchPopup(lemma)}
                  highlighted={highlightUid === w.uid}
                  C={C}
                />
              ))}
            </>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr>
                  {['INPUT', 'Lemma', 'Definition 1', 'Def 2', 'Source · §', 'Skip?', ''].map(h => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pagedWords.length === 0 && (
                  <tr>
                    <td colSpan={7} style={{ padding: '24px', textAlign: 'center', color: C.textM, fontSize: '13px' }}>
                      {q ? 'No entries match your search.' : 'No entries yet. Paste a word above.'}
                    </td>
                  </tr>
                )}
                {pagedWords.map(w => (
                  <WordRow
                    key={w.uid}
                    w={w}
                    onEdit={(row) => setEditModalUid(row.uid)}
                    toggleSkip={toggleSkip}
                    deleteRow={deleteRow}
                    isOrphaned={!!w.source && !activeSourceNames.has(w.source)}
                    onSourceClick={goToSource}
                    onOpenSearch={(lemma) => setSearchPopup(lemma)}
                    highlighted={highlightUid === w.uid}
                    C={C}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        <PaginationFooter
          page={page}
          totalPages={totalPages}
          count={allWords.length}
          onFirst={() => { setWordPage(0); scrollToTop(); }}
          onPrev={() => { setWordPage(page - 1); scrollToTop(); }}
          onNext={() => { setWordPage(page + 1); scrollToTop(); }}
          onLast={() => { setWordPage(totalPages - 1); scrollToTop(); }}
          C={C}
        />
      </div>
    </div>

      {editModalUid && (
        <WordEditModal
          key={editModalUid}
          rows={allWords}
          uid={editModalUid}
          onSelectRow={setEditModalUid}
          updateRow={updateRow}
          toggleSkip={toggleSkip}
          lemmaMaster={data.lemmaMaster}
          onClose={() => setEditModalUid(null)}
        />
      )}

      {searchPopup && (
        <AVIMiniSearchPopup
          initialQuery={searchPopup}
          data={data}
          updateData={updateData}
          onClose={() => setSearchPopup(null)}
          onOpenInSearch={goToSearch ? (q) => { setSearchPopup(null); goToSearch(q); } : undefined}
          showAVIToast={showAVIToast}
          staging={{ currentSource, currentSection, aviSources, aviSections, cards, decks, updateCards, updateDecks, dsh }}
        />
      )}
    </>
  );
}

