// src/pages/avi/AVISentenceInputPage.jsx
// AVI Sentence Input tab — combined Pick mode (replaces separate Drop/Pick).
// Tokenizes pasted sentence, auto-selects tokens matching existing wordInputs,
// allows manual selection/deselection and phrase drag-selection.
// New tokens go through the 2-step PickWordPopup (confirm lemma → review definitions).
// Flashcards auto-created when cardBack is present. No cloze generation.

import { useState, useCallback, useRef, useEffect, useMemo, memo } from 'react';
import { createPortal } from 'react-dom';
import { auth } from '../../firebase.js';
import { useAppTheme } from '../../hooks/useAppTheme.js';
import { SH } from '../../theme/buildStyles.js';
import { Def1Display } from '../../components/avi/Def1Display.jsx';
import {
  uuid, normalizeLemma, extractLemmaFromText,
  fetchDefinitionWithFallback,
  getSourceSections, resolveLemmaDetailed,
  writeGlobalLemma, updateLinkedCards,
  filterNewSentenceRows, filterNewWordRows, filterNewLemmas,
} from '../../utils/aviUtils.js';
import { SentenceEditModal } from '../../components/avi/SentenceEditModal.jsx';
import { autoCreateWordCard, autoCreateSentenceCard } from '../../utils/cardFactory.js';
import { DEMO, DEMO_CAPS, DEMO_LIMIT_NOTE, demoCapReached } from '../../demo/demoConfig.js';
import { isSkippedInSource, inheritedSentenceSkip, withOwnSentenceSkip } from '../../utils/wordSkip.js';
import { LemmaAutocompleteInput } from '../../components/avi/LemmaAutocompleteInput.jsx';
import { Icons } from '../../components/Icons.jsx';
import { PaginationFooter } from '../../components/PaginationFooter.jsx';
import { usePaginationKeys } from '../../hooks/usePaginationKeys.js';
import { useSearchAssist } from '../../hooks/useSearchAssist.js';
import { SearchAnchorNote, DidYouMean } from '../../components/avi/SearchAssist.jsx';
import { scrollListToTop } from '../../utils/scrollUtils.js';
import { findLemmaEntryAny, canonicalLemma, otherReadings } from '../../utils/lemmaSuggest.js';
import { planDef2Moves, applyDef2Moves, def2CardUpdate, applyDef2Write } from '../../utils/def2Cascade.js';

// The Lemma Master entry a picked term lands on (exact, cleaned or variant
// match) — the same lookup handlePopupDone uses to decide "existing".
function findPickEntry(lemmaMaster, lemma) {
  const norm = normalizeLemma(lemma);
  return (lemmaMaster || []).find(l => l.cleanedLemma === norm || l.lemma === lemma)
    || findLemmaEntryAny(lemmaMaster || [], lemma) || null;
}

const SI_PAGE_SIZE = 50;
const isMobile = typeof window !== 'undefined' && (window.innerWidth <= 700 || window.matchMedia('(hover: none) and (pointer: coarse) and (orientation: portrait)').matches);

// ── Auto-card creation for sentence entries ───────────────────
// autoCreateSentenceCard lives in src/utils/cardFactory.js
// (leaf module — Fable sweep Round D, W7).

// ── PickWordPopup — 2-step new-word confirmation ──────────────
export function PickWordPopup({ terms, step, fetching, onConfirmStep1, onDone, onClose, lemmaMaster, C, S }) {
  const [editedTerms, setEditedTerms] = useState(() =>
    terms.map(t => ({ ...t, skipped: false }))
  );
  useEffect(() => {
    setEditedTerms(terms.map(t => ({ ...t, skipped: false })));
  }, [terms]);

  // A def2 belongs to the lemma, so typing one for 탐방로와 fills it in for
  // 탐방로는 too when both resolved to 탐방로 (skipped terms are left alone).
  const updateTerm   = (i, field, val) =>
    setEditedTerms(prev => {
      if (field !== 'def2') return prev.map((t, idx) => idx === i ? { ...t, [field]: val } : t);
      const key = normalizeLemma(prev[i]?.lemma || '');
      return prev.map((t, idx) =>
        idx === i || (key && !t.skipped && normalizeLemma(t.lemma || '') === key)
          ? { ...t, def2: val }
          : t
      );
    });
  // Inputs that share each term's lemma, for the "shared with" note.
  const sameLemmaInputs = (i) => {
    const key = normalizeLemma(editedTerms[i]?.lemma || '');
    if (!key) return [];
    return editedTerms
      .filter((t, idx) => idx !== i && !t.skipped && normalizeLemma(t.lemma || '') === key)
      .map(t => t.input);
  };
  const toggleSkip   = (i) =>
    setEditedTerms(prev => prev.map((t, idx) => idx === i ? { ...t, skipped: !t.skipped } : t));
  const activeTerms  = editedTerms.filter(t => !t.skipped);

  const inputStyle = {
    background: C.bg, border: `1px solid ${C.border}`, borderRadius: '4px',
    color: C.text, padding: '4px 8px', fontSize: '13px',
    fontFamily: SH.fk, width: '100%', outline: 'none',
  };

  return createPortal(
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        zIndex: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: C.surface, border: `1px solid ${C.border}`, borderRadius: '12px',
          padding: '24px', width: 'min(92vw, 600px)', maxHeight: '85vh',
          overflowY: 'auto', boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
          <span style={{ fontFamily: SH.fd, fontWeight: 700, fontSize: '14px', color: C.text }}>
            {step === 1 ? 'Step 1 — Confirm Lemmas' : 'Step 2 — Review Definitions'}
          </span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.textM, fontSize: '18px', cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ fontSize: '12px', color: C.textM, marginBottom: '14px' }}>
          {step === 1
            ? 'Review the resolved lemma for each new word. Edit if needed, or skip words you already know.'
            : 'Definitions fetched. Optionally add Definition 2, then click Done.'}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '18px' }}>
          {editedTerms.map((t, i) => (
            <div key={i} style={{
              background: C.raised, border: `1px solid ${C.border}`, borderRadius: '8px',
              padding: '12px 14px', opacity: t.skipped ? 0.4 : 1, transition: 'opacity 0.15s',
            }}>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', marginBottom: step === 2 && !t.skipped ? '8px' : 0 }}>
                <div style={{ flexShrink: 0 }}>
                  <div style={{ fontSize: '10px', color: C.textM, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '3px' }}>Input</div>
                  <span style={{ fontFamily: SH.fk, fontSize: '14px', color: C.textM }}>{t.input}</span>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '10px', color: C.textM, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '3px' }}>Lemma</div>
                  {step === 1
                    ? <LemmaAutocompleteInput
                        value={t.lemma}
                        onChange={val => updateTerm(i, 'lemma', val)}
                        lemmaMaster={lemmaMaster}
                        inputStyle={inputStyle}
                        lang="ko"
                        disabled={t.skipped}
                        C={C}
                      />
                    : <span style={{ fontFamily: SH.fk, fontSize: '14px', color: C.accent }}>{t.lemma}</span>
                  }
                  {step === 1 && !t.skipped && !t.isPhrase && (() => {
                    // L3: dictionary-validated readings (and the original
                    // guess, to undo an edit) instead of raw jamo guesses.
                    const alts = otherReadings(t);
                    if (!alts.length) return null;
                    return (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' }}>
                        {alts.map(c => (
                          <button key={c} onClick={() => updateTerm(i, 'lemma', c)} style={{
                            background: C.accentSoft, border: `1px solid ${C.accent}`,
                            borderRadius: '999px', color: C.accent, cursor: 'pointer',
                            fontSize: '11px', fontFamily: SH.fk, padding: '2px 9px',
                          }}>
                            {c}
                          </button>
                        ))}
                      </div>
                    );
                  })()}
                </div>
                {!t.isPhrase && (
                  <button onClick={() => toggleSkip(i)} style={{
                    flexShrink: 0, background: 'none', border: `1px solid ${C.border}`,
                    borderRadius: '4px', color: t.skipped ? C.accent : C.textM,
                    fontSize: '11px', padding: '3px 7px', cursor: 'pointer',
                  }}>
                    {t.skipped ? '⟲ Undo' : 'Skip'}
                  </button>
                )}
              </div>
              {step === 2 && !t.skipped && (
                <>
                  {t.def1 && (
                    <div style={{ marginBottom: '8px' }}>
                      <div style={{ fontSize: '10px', color: C.textM, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '3px' }}>Definition 1</div>
                      <Def1Display text={t.def1} />
                    </div>
                  )}
                  <div>
                    <div style={{ fontSize: '10px', color: C.textM, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '3px' }}>Definition 2 (optional)</div>
                    <textarea
                      style={{ ...inputStyle, resize: 'vertical', minHeight: '40px', fontFamily: 'inherit', fontSize: '12px' }}
                      value={t.def2 || ''}
                      onChange={e => updateTerm(i, 'def2', e.target.value)}
                      placeholder="Add your own definition…"
                    />
                    {sameLemmaInputs(i).length > 0 && (
                      <div style={{ fontSize: '10.5px', color: C.textM, marginTop: '3px' }}>
                        Shared with {sameLemmaInputs(i).join(', ')} (same lemma)
                      </div>
                    )}
                    {(() => {
                      // A5: a def2 that differs from the one Lemma Master
                      // already has replaces it everywhere on Done; say so,
                      // and offer to keep Lemma Master's instead.
                      const entry = findPickEntry(lemmaMaster, t.lemma);
                      if (!entry?.def2 || !t.def2 || t.def2 === entry.def2) return null;
                      return (
                        <div style={{ marginTop: '6px', padding: '8px 10px', borderRadius: '6px', border: `1px solid ${C.border}`, background: C.surface, fontSize: '11.5px', color: C.textM, lineHeight: 1.5 }}>
                          <span style={{ fontFamily: SH.fk, color: C.text }}>{entry.lemma}</span> already has a different Definition 2:{' '}
                          <span style={{ color: C.text, whiteSpace: 'pre-wrap' }}>{entry.def2}</span>
                          <div style={{ marginTop: '2px' }}>Done uses yours for this word everywhere: Lemma Master, its other rows and its cards.</div>
                          <button
                            onClick={() => updateTerm(i, 'def2', entry.def2)}
                            style={{ marginTop: '6px', padding: '4px 10px', borderRadius: '5px', fontSize: '11px', fontWeight: 600, border: `1px solid ${C.border}`, background: 'transparent', color: C.textM, cursor: 'pointer' }}
                          >
                            Keep Lemma Master's
                          </button>
                        </div>
                      );
                    })()}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          {step === 1 ? (
            <button
              style={{
                ...S.btnPrimary, ...S.btnMetallic,
                flex: 1, padding: '10px', borderRadius: '8px', fontSize: '13px', fontWeight: 600,
                opacity: (fetching || activeTerms.length === 0) ? 0.6 : 1,
              }}
              onClick={() => onConfirmStep1(activeTerms)}
              disabled={fetching || activeTerms.length === 0}
            >
              {fetching ? '⟳ Fetching definitions…' : '▸ Confirm & Fetch Definitions'}
            </button>
          ) : (
            <button
              style={{
                ...S.btnPrimary, ...S.btnMetallic,
                flex: 1, padding: '10px', borderRadius: '8px', fontSize: '13px', fontWeight: 600,
                opacity: activeTerms.length === 0 ? 0.6 : 1,
              }}
              onClick={() => onDone(activeTerms)}
              disabled={activeTerms.length === 0}
            >
              ✓ Done
            </button>
          )}
          <button onClick={onClose} style={{
            background: C.raised, border: `1px solid ${C.border}`, color: C.text,
            borderRadius: '8px', padding: '10px 16px', fontSize: '13px', cursor: 'pointer',
          }}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── SentenceRow ───────────────────────────────────────────────
const SentenceRow = memo(function SentenceRow({
  s, toggleSkip, deleteRow, onReopenPicker, onSourceClick, onEdit, C,
}) {
  const td = {
    padding: '7px 10px', fontSize: '12px', color: C.text,
    verticalAlign: 'top', borderBottom: `1px solid ${C.border}`,
  };
  const rowBg =
    s.lastUncheckReason ? `${C.warning}10` :
    s.uploaded          ? `${C.success}08` :
    'transparent';

  if (isMobile) {
    return (
      <div style={{ background: rowBg === 'transparent' ? C.surface : rowBg, border: `1px solid ${C.border}`, borderRadius: '10px', padding: '11px 12px', marginBottom: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
          <span onClick={() => onEdit(s)} style={{ fontFamily: SH.fk, fontWeight: 600, fontSize: '14px', color: C.accent2 || C.tL, cursor: 'pointer' }}>{s.targetWord}</span>
          <span
            onClick={() => onSourceClick(s.source, s.section)}
            style={{ display: 'inline-block', padding: '2px 7px', borderRadius: '4px', fontSize: '10.5px', background: C.accentSoft, color: C.accent, cursor: 'pointer', fontFamily: SH.fm, flexShrink: 0 }}
          >
            {s.source}{s.section ? ` · §${s.section}` : ''}
          </span>
        </div>
        <div onClick={() => onEdit(s)} style={{ fontFamily: SH.fk, fontSize: '13px', lineHeight: 1.5, color: C.text, marginTop: '5px', cursor: 'pointer' }}>
          {s.sentence}
        </div>
        <div onClick={() => onEdit(s)} style={{ fontSize: '11.5px', color: s.cardBack ? C.textS : C.textM, lineHeight: 1.5, marginTop: '5px', cursor: 'pointer' }}>
          {s.cardBack || '—'}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '9px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: C.textM, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!s.skipUpload}
              onChange={e => toggleSkip(s.uid, e.target.checked)}
              style={{ accentColor: C.accent, cursor: 'pointer' }}
            />
            Skip
          </label>
          <div style={{ display: 'flex', gap: '14px' }}>
            <button
              onClick={() => onReopenPicker(s)}
              style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'none', border: 'none', color: C.textM, cursor: 'pointer', fontSize: '11px', padding: 0 }}
            >
              {Icons.plus} Add words
            </button>
            <button
              onClick={() => deleteRow(s.uid)}
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
    <tr style={{ background: rowBg }}>
      <td style={td}>
        <span onClick={() => onEdit(s)} style={{ fontFamily: SH.fk, fontSize: '13px', lineHeight: 1.5, cursor: 'pointer' }}>{s.sentence}</span>
      </td>
      <td style={{ ...td, width: '140px' }}>
        <span onClick={() => onEdit(s)} style={{ fontFamily: SH.fk, fontWeight: 600, color: C.accent2 || C.tL, cursor: 'pointer' }}>{s.targetWord}</span>
      </td>
      <td style={{ ...td, maxWidth: '200px' }}>
        <div onClick={() => onEdit(s)} style={{ fontSize: '12px', color: C.text, lineHeight: 1.4, cursor: 'pointer', minHeight: '18px' }}>{s.cardBack || '—'}</div>
      </td>
      <td style={td}>
        <span
          style={{
            display: 'inline-block', padding: '2px 7px', borderRadius: '4px',
            fontSize: '11px', background: C.accentSoft, color: C.accent,
            cursor: 'pointer', fontFamily: SH.fm,
          }}
          title="Open in Source view"
          onClick={() => onSourceClick(s.source, s.section)}
        >
          {s.source}{s.section ? ` · §${s.section}` : ''}
        </span>
      </td>
      <td style={{ ...td, textAlign: 'center', width: '50px' }}>
        <input
          type="checkbox"
          checked={!!s.skipUpload}
          onChange={e => toggleSkip(s.uid, e.target.checked)}
          style={{ accentColor: C.accent, cursor: 'pointer' }}
          title="Skip — don't create a flashcard for this entry"
        />
      </td>
      <td style={{ ...td, width: '52px' }}>
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
          <button
            title="Add more words from this sentence"
            onClick={() => onReopenPicker(s)}
            style={{
              background: 'none', border: 'none', color: C.textM,
              cursor: 'pointer', lineHeight: 1,
              padding: '2px 3px', borderRadius: '4px',
            }}
          >
            {Icons.plus}
          </button>
          <button
            title="Delete this sentence entry"
            onClick={() => deleteRow(s.uid)}
            style={{
              background: 'none', border: 'none', color: C.textM,
              cursor: 'pointer', fontSize: '14px', lineHeight: 1,
              padding: '2px 3px', borderRadius: '4px',
            }}
          >
            ✕
          </button>
        </div>
      </td>
    </tr>
  );
});

// ── Main page ─────────────────────────────────────────────────
export function AVISentenceInputPage({
  data, updateData, showAVIToast,
  currentSource, currentSection,
  aviSources, aviSections,
  cards, decks, updateCards, updateDecks,
  goToSource, dsh,
  siPage, setSiPage,
  inputSearch, setInputSearch,
}) {
  const { C, S } = useAppTheme();
  const needsSection = getSourceSections(aviSources, aviSections, currentSource).length > 0 && !currentSection;
  const uid = auth.currentUser?.uid;

  // ── Pick state ───────────────────────────────────────────────
  const [pickSentence,    setPickSentence]    = useState('');
  const [pickTokens,      setPickTokens]      = useState([]);
  const [pickSelected,    setPickSelected]    = useState(new Set()); // indices of manually selected tokens
  const [pickPhrase,      setPickPhrase]      = useState(null);     // { text, indices }
  const [autoSelected,    setAutoSelected]    = useState(new Set()); // indices auto-matched to wordInputs
  const [reopenFor,       setReopenFor]       = useState(null);     // sentence uid being re-picked

  // ── Add Selected re-entrancy guard ───────────────────────────
  // Ref is the actual guard (synchronous — a state check can be bypassed by
  // a double-click that lands before React re-renders); state only dims the button.
  const addingSelRef = useRef(false);
  const [addingSelected, setAddingSelected] = useState(false);

  // ── Popup state ──────────────────────────────────────────────
  const [pickPopup,       setPickPopup]       = useState(null); // { newTerms, existingInputs }
  const [pickPopupStep,   setPickPopupStep]   = useState(1);
  const [popupFetching,   setPopupFetching]   = useState(false);

  const scrollRef = useRef(null);
  // U2: on mobile the list flows inside AVI's scroll shell, so scrolling the
  // list box itself did nothing; this moves whichever box actually scrolls.
  const scrollToTop = () => scrollListToTop(scrollRef.current);
  const [sentEditUid, setSentEditUid] = useState(null);

  // Re-pick context: rows added while re-picking an existing sentence keep
  // that row's source/section instead of the current topbar selection.
  const reopenRow  = reopenFor ? data.sentenceInputs.find(s => s.uid === reopenFor) : null;
  const effSource  = reopenRow?.source  ?? currentSource;
  const effSection = reopenRow?.section ?? currentSection;

  // Duplicate-sentence guard: exact (sentence, target, source) dupes are
  // skipped; a re-add under a corrected target is allowed and flagged for
  // review in Recent with the original target noted.
  const classifySentenceDup = useCallback((sentence, targetWord, source) => {
    const normT = normalizeLemma(targetWord);
    const sameSent = data.sentenceInputs.filter(s => s.sentence === sentence && s.source === source);
    if (sameSent.some(s => normalizeLemma(s.targetWord) === normT)) return { skip: true };
    if (sameSent.length > 0) {
      return { skip: false, note: `same sentence previously added with target "${sameSent[0].targetWord}"` };
    }
    return { skip: false };
  }, [data.sentenceInputs]);

  // ── Tokenize and auto-select ─────────────────────────────────
  const handlePickInput = useCallback((text, existingUid = null) => {
    if (DEMO && existingUid === null && demoCapReached(data.sentenceInputs, 'sentences')) {
      showAVIToast(DEMO_LIMIT_NOTE);
      return;
    }
    setPickSentence(text);
    setPickPhrase(null);
    setReopenFor(existingUid);

    const tokens = text.trim().split(/\s+/).filter(Boolean);
    setPickTokens(tokens.map(t => ({ token: t })));

    // Auto-select tokens that match existing wordInputs (by input or lemma)
    const autoSet = new Set();
    tokens.forEach((token, idx) => {
      const normTok = normalizeLemma(token);
      const matches = data.wordInputs.some(w =>
        w.input === token || normalizeLemma(w.lemma) === normTok
      );
      if (matches) autoSet.add(idx);
    });
    let finalAuto = autoSet;
    if (DEMO && autoSet.size > DEMO_CAPS.wordsPerSentence) {
      finalAuto = new Set([...autoSet].slice(0, DEMO_CAPS.wordsPerSentence));
    }
    setAutoSelected(finalAuto);
    setPickSelected(new Set()); // clear manual selections
  }, [data.wordInputs, data.sentenceInputs, showAVIToast]);

  // ── Token selection (manual toggle) ─────────────────────────
  const toggleToken = (idx) => {
    if (autoSelected.has(idx)) {
      // Deselecting an auto-selected token removes it from auto set
      setAutoSelected(prev => { const next = new Set(prev); next.delete(idx); return next; });
    } else {
      if (DEMO && !pickSelected.has(idx) &&
          autoSelected.size + pickSelected.size + (pickPhrase ? 1 : 0) >= DEMO_CAPS.wordsPerSentence) {
        showAVIToast(`Demo: up to ${DEMO_CAPS.wordsPerSentence} target words per sentence.`);
        return;
      }
      setPickSelected(prev => {
        const next = new Set(prev);
        if (next.has(idx)) next.delete(idx); else next.add(idx);
        return next;
      });
    }
  };

  // ── Phrase drag ──────────────────────────────────────────────
  const dragStart = useRef(null);
  const didDrag   = useRef(false);

  const handlePillMouseDown = (idx) => { dragStart.current = idx; didDrag.current = false; };
  const handlePillMouseEnter = (idx) => {
    if (dragStart.current !== null && idx !== dragStart.current) didDrag.current = true;
  };
  const handlePillMouseUp = (idx) => {
    const start = dragStart.current;
    dragStart.current = null;
    if (start === null) return;
    if (!didDrag.current) {
      toggleToken(idx);
    } else if (DEMO && !pickPhrase &&
               autoSelected.size + pickSelected.size >= DEMO_CAPS.wordsPerSentence) {
      showAVIToast(`Demo: up to ${DEMO_CAPS.wordsPerSentence} target words per sentence.`);
    } else {
      const lo = Math.min(start, idx);
      const hi = Math.max(start, idx);
      const indices = [];
      for (let i = lo; i <= hi; i++) indices.push(i);
      const text = indices.map(i => pickTokens[i].token).join(' ');
      setPickPhrase({ text, indices });
    }
    didDrag.current = false;
  };

  // All selected indices (auto + manual) minus phrase
  const allSelected = new Set([...autoSelected, ...pickSelected]);
  const hasSelection = allSelected.size > 0 || pickPhrase;

  // ── Lemmatize a phrase ───────────────────────────────────────
  const lemmatizePhrase = (tokens) => {
    if (!tokens.length) return '';
    const lastLemma = extractLemmaFromText(tokens[tokens.length - 1]) || tokens[tokens.length - 1];
    return tokens.length === 1 ? lastLemma : [...tokens.slice(0, -1), lastLemma].join(' ');
  };

  // ── Build sentence rows for existing wordInput terms ─────────
  const createSentenceRows = useCallback((inputTokens, sentence, sentUid = null) => {
    const lemmaMap = {};
    for (const l of data.lemmaMaster) {
      lemmaMap[l.lemma] = l;
      if (l.cleanedLemma) lemmaMap[l.cleanedLemma] = l;
    }
    const newRows = [];
    const skippedDupes = [];
    const batchSeen = new Set();
    for (const input of inputTokens) {
      const wi = data.wordInputs.find(w =>
        w.input === input || normalizeLemma(w.lemma) === normalizeLemma(input)
      );
      const safeTarget = wi?.lemma || input;
      // Intra-batch dedupe: the same token repeated in one sentence (or two
      // surface forms resolving to one lemma) collapses to a single row —
      // classifySentenceDup only sees rows persisted before this call.
      if (batchSeen.has(normalizeLemma(safeTarget))) continue;
      batchSeen.add(normalizeLemma(safeTarget));
      const dup = classifySentenceDup(sentence, safeTarget, effSource);
      if (dup.skip) { skippedDupes.push(safeTarget); continue; }
      const lEntry     = lemmaMap[safeTarget] || lemmaMap[normalizeLemma(safeTarget)] || {};
      // L6: sentence cards wait for a def2 — an empty back is filled (and the
      // card created) by AVIPage's cascade once the lemma has one.
      const cardBack   = lEntry.def2 || wi?.def2 || '';
      // Find inputForm: the surface form appearing in the sentence
      const inputForm  = sentence.includes(input) ? input : '';
      const sid        = sentUid || uuid();
      newRows.push({
        uid: sid, ts: new Date().toISOString(),
        sentence, targetWord: safeTarget,
        cardFront: safeTarget + '\n' + sentence,
        cardBack,
        inputForm,
        source: effSource, section: effSection,
        uploaded: false, ...inheritedSentenceSkip(isSkippedInSource(data.wordInputs, effSource, safeTarget)),
        lastUncheckReason: dup.note || '',
        lastUncheckDate:   dup.note ? new Date().toISOString() : '',
      });
    }
    if (skippedDupes.length && showAVIToast) {
      showAVIToast(`Skipped duplicate sentence row${skippedDupes.length > 1 ? 's' : ''}: ${skippedDupes.join(', ')}`);
    }
    if (newRows.length) {
      updateData(prev => ({
        ...prev,
        sentenceInputs: [...filterNewSentenceRows(prev.sentenceInputs, newRows), ...prev.sentenceInputs],
      }));
    }
    return newRows;
  }, [data.wordInputs, data.lemmaMaster, effSource, effSection, classifySentenceDup, showAVIToast, updateData]);

  // ── Build rows for terms confirmed via popup ─────────────────
  const createSentenceRowsWithLemma = useCallback((terms, sentence) => {
    const lemmaMap = {};
    for (const l of data.lemmaMaster) {
      lemmaMap[l.lemma] = l;
      if (l.cleanedLemma) lemmaMap[l.cleanedLemma] = l;
    }
    const newRows = [];
    const skippedDupes = [];
    const batchSeen = new Set();
    for (const t of terms) {
      const safeTarget = t.lemma || t.input;
      // Intra-batch dedupe — see createSentenceRows above.
      if (batchSeen.has(normalizeLemma(safeTarget))) continue;
      batchSeen.add(normalizeLemma(safeTarget));
      const dup = classifySentenceDup(sentence, safeTarget, effSource);
      if (dup.skip) { skippedDupes.push(safeTarget); continue; }
      const lEntry     = lemmaMap[safeTarget] || lemmaMap[normalizeLemma(safeTarget)] || {};
      // A5: the def2 from the pop-up (prefilled with Lemma Master's, so it
      // differs only when you changed it) — Done makes it the lemma's.
      const cardBack   = t.def2 || lEntry.def2 || ''; // L6: waits for a def2
      const inputForm  = t.input && sentence.includes(t.input) ? t.input : '';
      const sid        = uuid();
      newRows.push({
        uid: sid, ts: new Date().toISOString(),
        sentence, targetWord: safeTarget,
        cardFront: safeTarget + '\n' + sentence,
        cardBack,
        inputForm,
        source: effSource, section: effSection,
        uploaded: false, ...inheritedSentenceSkip(isSkippedInSource(data.wordInputs, effSource, safeTarget)),
        lastUncheckReason: dup.note || '',
        lastUncheckDate:   dup.note ? new Date().toISOString() : '',
      });
    }
    if (skippedDupes.length && showAVIToast) {
      showAVIToast(`Skipped duplicate sentence row${skippedDupes.length > 1 ? 's' : ''}: ${skippedDupes.join(', ')}`);
    }
    if (newRows.length) {
      updateData(prev => ({
        ...prev,
        sentenceInputs: [...filterNewSentenceRows(prev.sentenceInputs, newRows), ...prev.sentenceInputs],
      }));
    }
    return newRows;
  }, [data.wordInputs, data.lemmaMaster, effSource, effSection, classifySentenceDup, showAVIToast, updateData]);

  // ── Add Selected ─────────────────────────────────────────────
  const handleAddSelected = useCallback(async () => {
    if (!currentSource || needsSection || addingSelRef.current) return;
    addingSelRef.current = true;
    setAddingSelected(true);
    try {
    const tokens = pickTokens.map(t => t.token);

    const terms = [];
    allSelected.forEach(idx => terms.push({ input: tokens[idx], isPhrase: false }));
    if (pickPhrase) {
      const phraseTokens = pickPhrase.indices.map(i => tokens[i]);
      terms.push({ input: pickPhrase.text, isPhrase: true, phraseTokens });
      for (const i of pickPhrase.indices) {
        if (!allSelected.has(i)) terms.push({ input: tokens[i], isPhrase: false });
      }
    }
    if (!terms.length) return;

    const existingInputs = [];
    const newTerms       = [];

    for (const t of terms) {
  const normTok = normalizeLemma(t.input);
  const existingWI = data.wordInputs.find(w =>
    w.input === t.input || normalizeLemma(w.lemma) === normTok
  );
  if (existingWI) {
    existingInputs.push(t.input);
    // If no word input exists for the current source, create one
    const alreadyInSource = data.wordInputs.some(w =>
      (w.input === t.input || normalizeLemma(w.lemma) === normTok) &&
      w.source === effSource
    );
    if (!alreadyInSource && effSource) {
      const lemmaEntry = data.lemmaMaster.find(
        l => normalizeLemma(l.lemma) === normalizeLemma(existingWI.lemma)
      );
      const newWI = {
        uid: uuid(), ts: new Date().toISOString(),
        input: t.input,
        source: effSource, section: effSection,
        lemma: existingWI.lemma,
        def1: lemmaEntry?.def1 || existingWI.def1 || '',
        def2: lemmaEntry?.def2 || existingWI.def2 || '',
        uploaded: false, skipUpload: false,
        lastUncheckReason: '', lastUncheckDate: '',
      };
      updateData(prev => {
        // Race-proof recheck: functional updaters see the latest state, so
        // a burst of same-lemma terms (or a double-fired handler) cannot
        // append the row twice — the closure-captured alreadyInSource check
        // above cannot guarantee that on its own.
        const dupRow = prev.wordInputs.some(w =>
          (w.input === t.input || normalizeLemma(w.lemma) === normTok) &&
          w.source === effSource
        );
        return dupRow ? prev : { ...prev, wordInputs: [newWI, ...prev.wordInputs] };
      });
      // Auto-create word card if def2 is present
      if (newWI.def2) {
        autoCreateWordCard({
          entry: newWI, lemmaMaster: data.lemmaMaster,
          cards, decks, uid, updateCards, updateDecks, aviSources, dsh, // A6: cards feed the duplicate guard
        }).then(() => {
          updateData(prev => ({
            ...prev,
            wordInputs: prev.wordInputs.map(w =>
              w.uid === newWI.uid ? { ...w, uploaded: true } : w
            ),
          }));
        }).catch(() => {});
      }
    }
  } else {
        newTerms.push({
          input: t.input, lemma: '', def1: '', def2: '',
          isPhrase: t.isPhrase || false,
          phraseTokens: t.phraseTokens || null,
        });
      }
    }

    // Resolve lemmas for new terms via the full dictionary cascade:
    // trusted GLM mapping, then heuristic candidates (including irregular
    // recoveries) validated as headwords, then the sync heuristic. Tier 1
    // (prior local mapping) is the existingWI branch above. Lookups run
    // in parallel across terms.
    if (newTerms.length > 0) {
      const localHeadwords = new Set();
      for (const l of (data.lemmaMaster || [])) {
        if (l.lemma) localHeadwords.add(l.lemma);
        if (l.cleanedLemma) localHeadwords.add(l.cleanedLemma);
      }
      await Promise.all(newTerms.map(async (nt) => {
        let resolved = nt.input;
        let alternates = [];
        if (nt.isPhrase) {
          resolved = lemmatizePhrase(nt.phraseTokens || []);
        } else {
          // L3: the other dictionary readings ride along for Step 1's chips.
          const d = await resolveLemmaDetailed(nt.input, { localHeadwords, withAlternates: true });
          resolved = d.lemma || nt.input;
          alternates = d.alternates || [];
        }
        // L4d: adopt an existing entry's own text when it matches a variant
        // (입사하다 → 입사(하다)), so the term links instead of duplicating.
        nt.lemma = canonicalLemma(data.lemmaMaster, resolved);
        nt.resolvedLemma = nt.lemma;
        nt.alternates = alternates.map(a => canonicalLemma(data.lemmaMaster, a));
      }));
      // Drop the transient helper field so popup state shape is unchanged.
      newTerms.forEach(nt => { delete nt.phraseTokens; });
    }

    // Create rows for existing matches immediately
    if (existingInputs.length > 0) {
      const rows = createSentenceRows(existingInputs, pickSentence);
      // Auto-create cards for rows with cardBack
      if (DEMO && demoCapReached(cards, 'cards') && rows.some(r => r.cardBack && !r.skipUpload)) {
        showAVIToast(DEMO_LIMIT_NOTE);
      }
      for (const row of rows) {
        if (row.cardBack && !row.skipUpload) {
          autoCreateSentenceCard({
            entry: row, lemmaMaster: data.lemmaMaster,
            cards, decks, uid, updateCards, updateDecks, aviSources, dsh, // A6
          }).then(() => {
            updateData(prev => ({
              ...prev,
              sentenceInputs: prev.sentenceInputs.map(s =>
                s.uid === row.uid ? { ...s, uploaded: true } : s
              ),
            }));
          }).catch(e => console.error('Sentence card creation failed', e));
        }
      }
    }

    if (newTerms.length > 0) {
      setPickPopup({ newTerms, existingInputs });
      setPickPopupStep(1);
    } else {
      setSiPage(0);
      resetPick();
    }
    } finally {
      addingSelRef.current = false;
      setAddingSelected(false);
    }
  }, [pickTokens, allSelected, pickPhrase, pickSentence, currentSource, currentSection,
            effSource, effSection,
            data, cards, decks, uid, updateCards, updateDecks, aviSources,
            createSentenceRows, updateData, setSiPage]);

  // ── Popup step 1: fetch definitions ─────────────────────────
  const handlePopupStep1 = async (terms) => {
    setPopupFetching(true);
    const updated = await Promise.all(terms.map(async t => {
      const existing = data.lemmaMaster.find(
        l => l.lemma === t.lemma || normalizeLemma(l.lemma) === normalizeLemma(t.lemma)
      ) || findLemmaEntryAny(data.lemmaMaster, t.lemma); // L4d: 입사하다 → 입사(하다)
      if (existing) return { ...t, lemma: existing.lemma, def1: existing.def1 || '', def2: existing.def2 || '' };
      try {
        // Tier 2: retry a dictionary miss with the surface's next candidates —
        // only when the lemma is still the machine's own untouched guess.
        const fb = await fetchDefinitionWithFallback(
          (!t.isPhrase && t.lemma === t.resolvedLemma) ? t.input : '', t.lemma, data.aviSettings);
        if (fb.lemma !== t.lemma) {
          const adopted = data.lemmaMaster.find(
            l => l.lemma === fb.lemma || normalizeLemma(l.lemma) === normalizeLemma(fb.lemma)
          );
          if (adopted) return { ...t, lemma: fb.lemma, def1: adopted.def1 || '', def2: adopted.def2 || '' };
        }
        return { ...t, lemma: fb.lemma, def1: fb.def1 === '__RATE_LIMITED__' ? '' : (fb.def1 || '') };
      } catch { return t; }
    }));
    setPickPopup(prev => ({ ...prev, newTerms: updated }));
    setPickPopupStep(2);
    setPopupFetching(false);
  };

  // ── Popup done: create word inputs + lemmas + sentence rows ──
  const handlePopupDone = useCallback((terms) => {
    const sentence = reopenFor
      ? (data.sentenceInputs.find(s => s.uid === reopenFor)?.sentence || pickSentence)
      : pickSentence;

    const newWordInputs = [];
    const newLemmas     = [];
    const now           = new Date().toISOString();

    // Popup-corrected lemmas feed the global lemma map — same policy as WI
    // edits and Import review corrections (explicit corrections only).
    for (const t of terms) {
      if (t.input && t.resolvedLemma && t.lemma && t.lemma !== t.resolvedLemma) {
        writeGlobalLemma(t.input, normalizeLemma(t.lemma));
      }
    }

    for (const t of terms) {
      const norm = normalizeLemma(t.lemma);
      const existingLM = findPickEntry(data.lemmaMaster, t.lemma); // L4d: variant match
      if (!existingLM) {
        newLemmas.push({
          lemma: t.lemma, def1: t.def1, def2: t.def2 || '',
          relatedForm: '', relatedMeaning: '', hiddenRelated: '',
          lastUpdated: now, autoAddedBy: 'pick',
          cleanedLemma: norm, originUID: uuid(), lemmaID: uuid(),
        });
      }
      if (!data.wordInputs.find(w => w.input === t.input)) {
        newWordInputs.push({
          uid: uuid(), ts: now, input: t.input,
          source: effSource, section: effSection,
          lemma: t.lemma, def1: t.def1, def2: t.def2 || '',
          uploaded: false, skipUpload: isSkippedInSource(data.wordInputs, effSource, t.lemma),
          lastUncheckReason: '', lastUncheckDate: '',
        });
      }
    }

    // A5: a def2 from the pop-up for a lemma Lemma Master already has
    // becomes that lemma's def2 (before, it reached only the new word row and
    // its card). An entry with no def2 gets it, which also releases sentence
    // rows waiting for one; a different one replaces it — the pop-up says so
    // and offers to keep Lemma Master's. Like a def2 edit in Lemma Master,
    // the lemma's other rows follow, sentence backs taken from the old def2
    // follow (hand-edited ones are kept), and so do its cards.
    const def2Moves = planDef2Moves(terms, data.lemmaMaster, findPickEntry);

    updateData(prev => {
      const moved = applyDef2Moves({
        lemmaMaster:    [...filterNewLemmas(prev.lemmaMaster, newLemmas), ...prev.lemmaMaster],
        wordInputs:     [...filterNewWordRows(prev.wordInputs, newWordInputs), ...prev.wordInputs],
        sentenceInputs: prev.sentenceInputs,
      }, def2Moves, now, 'Definition 2 updated in Sentence Input');
      return { ...prev, ...moved };
    });
    // LD-D1: every card of the word takes the def2 (a sentence card whose
    // back was a def1 too).
    for (const { entry, def2 } of def2Moves.values()) {
      updateLinkedCards({
        lemmaID: entry.lemmaID, lemmaText: entry.lemma,
        buildUpdates: (c) => def2CardUpdate(c, def2),
        cards, uid, updateCards,
      }).catch(e => console.error('Sentence Input: card back update failed', e));
    }

    // Create sentence rows using confirmed lemmas
    const rows = createSentenceRowsWithLemma(terms, sentence);

    // Auto-create cards for rows with cardBack
    if (DEMO && demoCapReached(cards, 'cards') && rows.some(r => r.cardBack && !r.skipUpload)) {
      showAVIToast(DEMO_LIMIT_NOTE);
    }
    for (const row of rows) {
      if (row.cardBack && !row.skipUpload) {
        autoCreateSentenceCard({
        entry: row, lemmaMaster: [...data.lemmaMaster, ...newLemmas],
        cards, decks, uid, updateCards, updateDecks, aviSources, dsh, // A6
        }).then(() => {
          updateData(prev => ({
            ...prev,
            sentenceInputs: prev.sentenceInputs.map(s =>
              s.uid === row.uid ? { ...s, uploaded: true } : s
            ),
          }));
        }).catch(e => console.error('Sentence card creation failed', e));
      }
    }

    for (const wi of newWordInputs) {
      if (wi.def2 && !wi.skipUpload) {
        autoCreateWordCard({
                  entry: wi, lemmaMaster: [...data.lemmaMaster, ...newLemmas],
                  cards, decks, uid, updateCards, updateDecks, aviSources, dsh, // A6
                }).then(() => {
          updateData(prev => ({
            ...prev,
            wordInputs: prev.wordInputs.map(w =>
              w.uid === wi.uid ? { ...w, uploaded: true } : w
            ),
          }));
        }).catch(() => {});
      }
    }

    setPickPopup(null);
    setSiPage(0);
    if (!reopenFor) resetPick();
    else setReopenFor(null);
 }, [
    reopenFor, pickSentence, data, currentSource, currentSection,
    effSource, effSection,
    cards, decks, uid, updateCards, updateDecks, aviSources,
    updateData, createSentenceRowsWithLemma, setSiPage,
  ]);

  const resetPick = () => {
    setPickSentence('');
    setPickTokens([]);
    setPickSelected(new Set());
    setAutoSelected(new Set());
    setPickPhrase(null);
  };

  // ── Sentence row edit (modal save) ─────────────────────────────
  const handleSentenceEditSave = useCallback(async (rowUid, edits) => {
    const row = data.sentenceInputs.find(s => s.uid === rowUid);
    if (!row) return;
    const targetChanged = edits.targetWord !== undefined && edits.targetWord !== row.targetWord;
    const skipChanged   = edits.skipUpload !== undefined && edits.skipUpload !== !!row.skipUpload;
    const now = new Date().toISOString();

    // LD-D1: a sentence card's back is its word's back, so a back typed here
    // is the word's Definition 2. It goes through the def2 writer for the
    // (new) target word after a confirmation that shows everything it
    // changes; Cancel keeps the current def2. An emptied back changes
    // nothing (LD-D2: backs are kept until a new def2 is saved). A word with
    // no Lemma Master entry keeps the old behavior: this row's back only.
    const typedBack = edits.cardBack !== undefined && edits.cardBack !== row.cardBack && edits.cardBack.trim()
      ? edits.cardBack : null;
    const backTarget = edits.targetWord !== undefined ? edits.targetWord : row.targetWord;
    const defEntry = typedBack
      ? data.lemmaMaster.find(l => normalizeLemma(l.lemma) === normalizeLemma(backTarget)) || null
      : null;
    let def2Write = null;
    let backChanged = false;
    if (typedBack && !defEntry) {
      backChanged = true;
    } else if (typedBack && defEntry) {
      if (typedBack === (defEntry.def2 || '')) {
        def2Write = { entry: defEntry, def2: typedBack }; // already the def2: just align this word's copies
      } else {
        const scope = applyDef2Write(data, { lemma: defEntry.lemma, def2: typedBack, now, reason: '' }).counts;
        const normT = normalizeLemma(defEntry.lemma);
        const cardCount = (cards || []).filter(c =>
          (c.linkedAVILemmaId === defEntry.lemmaID || (c.lemma && normalizeLemma(c.lemma) === normT)) &&
          def2CardUpdate(c, typedBack)).length;
        const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
        const ok = window.confirm(
          `Change Definition 2 for "${defEntry.lemma}"?\n\n` +
          `A sentence card shows its word's Definition 2, so this changes it everywhere: ` +
          `Lemma Master, ${plural(scope.wordRows, 'word row')}, ${plural(scope.sentenceRows, 'sentence row')} ` +
          `and ${plural(cardCount, 'card')}.\n\nCancel keeps the current Definition 2.`
        );
        if (ok) def2Write = { entry: defEntry, def2: typedBack };
      }
    }
    const rowEdits = { ...edits };
    if (!backChanged) delete rowEdits.cardBack;
    if (!targetChanged && !backChanged && !skipChanged && !def2Write) return;

    // Retarget without a manual back edit: the current back belonged to
    // the old target, so recompute it from the new target's defs. Blank
    // when the new target has none yet — a wrong-word definition is worse
    // than an empty one, and the row is unchecked below so its card
    // re-creates once defs arrive.
    const newTarget      = edits.targetWord !== undefined ? edits.targetWord : row.targetWord;
    const newTargetEntry = targetChanged
      ? data.lemmaMaster.find(l => normalizeLemma(l.lemma) === normalizeLemma(newTarget))
      : null;
    // L6: def2 only — with no def2 yet the back stays empty and AVIPage's
    // cascade creates the card when one arrives.
    const autoBack = (targetChanged && !backChanged)
      ? (newTargetEntry?.def2 || '')
      : null;

    updateData(prev => {
      const out = {
        ...prev,
        sentenceInputs: prev.sentenceInputs.map(s => {
          if (s.uid !== rowUid) return s;
          // A10: a Skip change here is this row's own (drops the word's marker).
          const next = skipChanged ? { ...withOwnSentenceSkip(s, rowEdits.skipUpload), ...rowEdits } : { ...s, ...rowEdits };
          if (targetChanged) next.cardFront = (rowEdits.targetWord || s.targetWord) + '\n' + (s.sentence || '');
          if (autoBack !== null) next.cardBack = autoBack;
          if ((targetChanged || backChanged) && s.uploaded) {
            next.uploaded          = false;
            next.lastUncheckReason = 'fields edited';
            next.lastUncheckDate   = now;
          }
          return next;
        }),
      };
      if (!def2Write) return out;
      // eslint-disable-next-line no-unused-vars
      const { counts, ...written } = applyDef2Write(out, {
        lemma: def2Write.entry.lemma, def2: def2Write.def2, now, reason: 'Definition 2 edited in Sentence Input',
      });
      return { ...out, ...written };
    });

    // Cascade to this row's card precisely: only sentence cards carrying
    // this exact sentence under the old target are touched.
    if (targetChanged || backChanged) {
          const oldEntry  = data.lemmaMaster.find(l => normalizeLemma(l.lemma) === normalizeLemma(row.targetWord));
      updateLinkedCards({
        lemmaID:   oldEntry?.lemmaID || null,
        lemmaText: row.targetWord,
        buildUpdates: (c) => {
          if (c.type !== 'sentence' || c.sentence !== row.sentence) return null;
          return {
            ...(targetChanged ? {
              lemma: newTarget,
              front: newTarget + '\n' + (c.sentence || ''),
              linkedAVILemmaId: newTargetEntry?.lemmaID || null,
            } : {}),
            ...(backChanged ? { back: edits.cardBack } : {}),
            ...(autoBack !== null && autoBack ? { back: autoBack } : {}),
            ...(def2Write && targetChanged ? { back: def2Write.def2 } : {}),
          };
        },
        cards, uid, updateCards,
      }).catch(e => console.error('Sentence edit: card update failed', e));
    }
    // LD-D1: the word's cards take the new def2.
    if (def2Write) {
      updateLinkedCards({
        lemmaID: def2Write.entry.lemmaID, lemmaText: def2Write.entry.lemma,
        buildUpdates: (c) => def2CardUpdate(c, def2Write.def2),
        cards, uid, updateCards,
      }).catch(e => console.error('Sentence edit: def2 card update failed', e));
    }
  }, [data, updateData, cards, uid, updateCards]);

  // ── Row actions ──────────────────────────────────────────────
  const toggleSkip = useCallback((uid, val) => {
    updateData(prev => ({
      ...prev,
      // A10: skipped or un-skipped on its own (drops the word's marker).
      sentenceInputs: prev.sentenceInputs.map(s =>
        s.uid === uid ? withOwnSentenceSkip(s, val) : s
      ),
    }));
  }, [updateData]);

  const deleteRow = useCallback((uid) => {
    if (!window.confirm('Delete this sentence entry?')) return;
    updateData(prev => ({
      ...prev,
      sentenceInputs: prev.sentenceInputs.filter(s => s.uid !== uid),
    }));
  }, [updateData]);

  const handleReopenPicker = useCallback((s) => {
    handlePickInput(s.sentence, s.uid);
  }, [handlePickInput]);

  // ── Search + pagination ──────────────────────────────────────
  // The query lives in AVIPage (rendered in the sticky tab strip on
  // desktop; the mobile input below binds to the same state). NFC on both
  // sides so pre-repair decomposed rows still match a composed query.
  const q = (inputSearch || '').normalize('NFC').trim().toLowerCase();
  // L4b: a Korean query that's another form of a lemma you study (탐방로는)
  // also matches that lemma's sentence rows; a query matching nothing offers
  // "Did you mean" lemmas. Same cascade as the Search tab.
  const assist = useSearchAssist(data, inputSearch);
  const { anchorKey } = assist;
  const sortedSentences = useMemo(() => {
    const match = (s) => !q ||
      [s.sentence, s.targetWord, s.cardBack]
        .some(f => (f || '').normalize('NFC').toLowerCase().includes(q)) ||
      (!!anchorKey && normalizeLemma(s.targetWord || '') === anchorKey);
    return [...data.sentenceInputs].filter(match).sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  }, [data.sentenceInputs, q, anchorKey]);

  // Back to page 0 when the query changes so results are visible. The ref
  // guard skips the mount run — siPage is lifted state that deliberately
  // persists across tab switches, and must not be reset by remounting.
  const searchInitRef = useRef(false);
  useEffect(() => {
    if (!searchInitRef.current) { searchInitRef.current = true; return; }
    setSiPage(0);
  }, [inputSearch, setSiPage]);
  const totalPages = Math.ceil(sortedSentences.length / SI_PAGE_SIZE);
  const page       = Math.min(siPage, Math.max(0, totalPages - 1));
  const pagedRows  = sortedSentences.slice(page * SI_PAGE_SIZE, (page + 1) * SI_PAGE_SIZE);

  // ←/→ paginate the sentence table; disabled while pick popup, edit modal, or
  // re-pick context (reopenFor) is active.
  usePaginationKeys({
    page,
    totalPages,
    setPage: (p) => { setSiPage(p); scrollToTop(); },
    enabled: !pickPopup && !sentEditUid && !reopenFor,
  });

  const thStyle = {
    padding: '7px 10px', fontSize: '10px', fontWeight: 700,
    letterSpacing: '0.07em', textTransform: 'uppercase', color: C.textM,
    borderBottom: `2px solid ${C.border}`, textAlign: 'left', whiteSpace: 'nowrap',
    position: 'sticky', top: 0, background: C.raised, zIndex: 1,
  };

  return (
    <div className="avi-input-layout" style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: '16px', height: isMobile ? 'auto' : '100%' }}>

      {/* ── Pick panel ─────────────────────────────────────── */}
      <div className="avi-staging-panel" style={{
        width: isMobile ? '100%' : '280px', flexShrink: 0,
        display: 'flex', flexDirection: 'column', gap: '10px',
        overflowY: 'auto',
      }}>
        <div style={{ fontFamily: SH.fd, fontSize: '14px', color: C.text }}>
          ◈ Sentence Staging
        </div>
        <div style={{ fontSize: '12px', color: C.textM, lineHeight: 1.5 }}>
          Paste a sentence. Pre-highlighted tokens match existing word entries. Click to (de)select words. Highlight to select a phrase.
        </div>
        <textarea
          style={{
            width: '100%', padding: '10px 12px', borderRadius: '8px', fontSize: '13px',
            border: `1px solid ${C.border}`, background: C.bg, color: C.text,
            outline: 'none', resize: 'vertical', minHeight: '80px', lineHeight: 1.6,
            fontFamily: SH.fk, boxSizing: 'border-box',
          }}
          placeholder="Paste sentence here…"
          value={pickSentence}
          onChange={e => handlePickInput(e.target.value)}
          rows={3}
        />

        {/* Token pills */}
        {pickTokens.length > 0 && (
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: '5px', padding: '8px',
            background: C.raised, borderRadius: '6px', border: `1px solid ${C.border}`,
            userSelect: 'none',
          }}>
            {pickTokens.map((t, i) => {
              const inPhrase   = pickPhrase?.indices.includes(i);
              const isAuto     = autoSelected.has(i);
              const isManual   = pickSelected.has(i);
              const isSelected = isAuto || isManual;
              return (
                <span
                  key={i}
                  onMouseDown={() => handlePillMouseDown(i)}
                  onMouseEnter={() => handlePillMouseEnter(i)}
                  onMouseUp={() => handlePillMouseUp(i)}
                  style={{
                    padding: '3px 9px', borderRadius: '14px', fontSize: '13px',
                    cursor: 'pointer', fontFamily: SH.fk,
                    background: isSelected ? C.accent : inPhrase ? C.accentSoft : C.surface,
                    color: isSelected ? '#fff' : inPhrase ? C.accent : C.text,
                    border: `1px solid ${isSelected ? C.accent : inPhrase ? C.accent : C.border}`,
                    transition: 'all 0.1s',
                    // Auto-selected tokens get a slightly different style
                    boxShadow: isAuto && !isManual ? `0 0 0 1px ${C.accent}` : 'none',
                  }}
                >
                  {t.token}
                </span>
              );
            })}
          </div>
        )}

        {/* Phrase indicator */}
        {pickPhrase && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: C.textM }}>
            <span>Phrase: <span style={{ color: C.accent, fontFamily: SH.fk }}>{pickPhrase.text}</span></span>
            <button onClick={() => setPickPhrase(null)} style={{ background: 'none', border: 'none', color: C.textM, cursor: 'pointer', fontSize: '13px' }}>✕</button>
          </div>
        )}

        {!currentSource && (
          <div style={{ fontSize: '11px', color: C.warning, fontWeight: 500 }}>
            ← Select a source in the top bar before adding.
          </div>
        )}
        {currentSource && needsSection && (
          <div style={{ fontSize: '11px', color: C.warning, fontWeight: 500 }}>
            ← This source has sections — pick one in the top bar before adding.
          </div>
        )}

        <button
          style={{
            ...S.btnPrimary,
            padding: '9px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 600,
            opacity: (!currentSource || !hasSelection || needsSection || addingSelected) ? 0.5 : 1, transition: 'opacity 0.15s',
          }}
          onClick={handleAddSelected}
          disabled={!currentSource || !hasSelection || needsSection || addingSelected}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>{Icons.plus} Add Selected</span>
        </button>

        <div style={{ fontSize: '11px', color: C.textM, fontFamily: SH.fm }}>
          {q
            ? `${sortedSentences.length} of ${data.sentenceInputs.length} match`
            : `${sortedSentences.length} ${sortedSentences.length === 1 ? 'entry' : 'entries'}`}
        </div>
      </div>

      {/* ── Sentence table (mobile: card list instead) ────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>

        {/* Mobile search — the desktop input lives in AVIPage's tab strip */}
        {isMobile && (
          <input
            type="text"
            value={inputSearch || ''}
            onChange={e => setInputSearch(e.target.value)}
            placeholder="Search sentences…"
            style={{
              fontSize: '16px', padding: '8px 12px', borderRadius: '8px',
              border: `1px solid ${C.border}`, background: C.surface, color: C.text,
              outline: 'none', marginBottom: '10px', width: '100%', boxSizing: 'border-box',
            }}
          />
        )}

        <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', overflowX: isMobile ? 'hidden' : 'auto' }}>
          {q && !!anchorKey && data.sentenceInputs.some(s => normalizeLemma(s.targetWord || '') === anchorKey) && (
            <SearchAnchorNote anchor={assist.anchor} query={(inputSearch || '').trim()} C={C} />
          )}
          {isMobile ? (
            <>
              {pagedRows.length === 0 && (
                <div style={{ padding: '24px', textAlign: 'center', color: C.textM, fontSize: '13px' }}>
                  {q ? 'No entries match your search.' : 'No entries yet. Paste a sentence above.'}
                  {q && <DidYouMean suggestions={assist.suggestions} onPick={setInputSearch} C={C} />}
                </div>
              )}
              {pagedRows.map(s => (
                <SentenceRow
                  key={s.uid}
                  s={s}
                  toggleSkip={toggleSkip}
                  deleteRow={deleteRow}
                  onReopenPicker={handleReopenPicker}
                  onSourceClick={goToSource}
                  onEdit={(row) => setSentEditUid(row.uid)}
                  C={C}
                />
              ))}
            </>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr>
                  {['Sentence', 'Target Word', 'Card Back', 'Source · §', 'Skip?', ''].map(h => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pagedRows.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ padding: '24px', textAlign: 'center', color: C.textM, fontSize: '13px' }}>
                      {q ? 'No entries match your search.' : 'No entries yet. Paste a sentence above.'}
                  {q && <DidYouMean suggestions={assist.suggestions} onPick={setInputSearch} C={C} />}
                    </td>
                  </tr>
                )}
                {pagedRows.map(s => (
                  <SentenceRow
                    key={s.uid}
                    s={s}
                    toggleSkip={toggleSkip}
                    deleteRow={deleteRow}
                    onReopenPicker={handleReopenPicker}
                    onSourceClick={goToSource}
                    onEdit={(row) => setSentEditUid(row.uid)}
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
          count={sortedSentences.length}
          onFirst={() => { setSiPage(0); scrollToTop(); }}
          onPrev={() => { setSiPage(page - 1); scrollToTop(); }}
          onNext={() => { setSiPage(page + 1); scrollToTop(); }}
          onLast={() => { setSiPage(totalPages - 1); scrollToTop(); }}
          C={C}
        />
      </div>

      {sentEditUid && (() => {
        const row = data.sentenceInputs.find(s => s.uid === sentEditUid);
        return row ? (
          <SentenceEditModal
            key={sentEditUid}
            row={row}
            lemmaMaster={data.lemmaMaster}
            onSave={handleSentenceEditSave}
            onClose={() => setSentEditUid(null)}
          />
        ) : null;
      })()}

      {/* ── Popup ────────────────────────────────────────────── */}
      {pickPopup && (
        <PickWordPopup
          terms={pickPopup.newTerms}
          step={pickPopupStep}
          fetching={popupFetching}
          onConfirmStep1={handlePopupStep1}
          onDone={handlePopupDone}
          onClose={() => {
            setPickPopup(null);
            if (!reopenFor) resetPick();
            else setReopenFor(null);
          }}
          lemmaMaster={data.lemmaMaster}
          C={C}
          S={S}
        />
      )}
    </div>
  );
}

