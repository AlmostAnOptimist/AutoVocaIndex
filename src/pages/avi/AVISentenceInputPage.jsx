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
  uuid, normalizeLemma, cleanStagingText, extractLemmaFromText,
  fetchDefinition, getSourceSections, resolveLemmaWithDictionary,
  writeGlobalLemma, updateLinkedCards,
} from '../../utils/aviUtils.js';
import { SentenceEditModal } from '../../components/avi/SentenceEditModal.jsx';
import { autoCreateWordCard, autoCreateSentenceCard } from '../../utils/cardFactory.js';
import { DEMO, DEMO_CAPS, DEMO_LIMIT_NOTE, demoCapReached } from '../../demo/demoConfig.js';
import { LemmaAutocompleteInput } from '../../components/avi/LemmaAutocompleteInput.jsx';
import { Icons } from '../../components/Icons.jsx';
import { PaginationFooter } from '../../components/PaginationFooter.jsx';
import { usePaginationKeys } from '../../hooks/usePaginationKeys.js';

const SI_PAGE_SIZE = 50;
const isMobile = typeof window !== 'undefined' && window.innerWidth <= 700;

// ── Auto-card creation for sentence entries ───────────────────
// autoCreateSentenceCard lives in src/utils/cardFactory.js
// (leaf module — Fable sweep Round D, W7).

// ── PickWordPopup — 2-step new-word confirmation ──────────────
function PickWordPopup({ terms, step, fetching, onConfirmStep1, onDone, onClose, lemmaMaster, C, S }) {
  const [editedTerms, setEditedTerms] = useState(() =>
    terms.map(t => ({ ...t, skipped: false }))
  );
  useEffect(() => {
    setEditedTerms(terms.map(t => ({ ...t, skipped: false })));
  }, [terms]);

  const updateTerm   = (i, field, val) =>
    setEditedTerms(prev => prev.map((t, idx) => idx === i ? { ...t, [field]: val } : t));
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
                </div>
                {!t.isPhrase && (
                  <button onClick={() => toggleSkip(i)} style={{
                    flexShrink: 0, background: 'none', border: `1px solid ${C.border}`,
                    borderRadius: '4px', color: t.skipped ? C.accent : C.textM,
                    fontSize: '11px', padding: '3px 7px', cursor: 'pointer',
                  }}>
                    {t.skipped ? '↩ Undo' : 'Skip'}
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
              {fetching ? '⟳ Fetching definitions…' : '▶ Confirm & Fetch Definitions'}
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
  const scrollToTop = () => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
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
    for (const input of inputTokens) {
      const wi = data.wordInputs.find(w =>
        w.input === input || normalizeLemma(w.lemma) === normalizeLemma(input)
      );
      const safeTarget = wi?.lemma || input;
      const dup = classifySentenceDup(sentence, safeTarget, effSource);
      if (dup.skip) { skippedDupes.push(safeTarget); continue; }
      const lEntry     = lemmaMap[safeTarget] || lemmaMap[normalizeLemma(safeTarget)] || {};
      const cardBack   = lEntry.def2 || lEntry.def1 || wi?.def2 || wi?.def1 || '';
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
        uploaded: false, skipUpload: false,
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
        sentenceInputs: [...newRows, ...prev.sentenceInputs],
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
    for (const t of terms) {
      const safeTarget = t.lemma || t.input;
      const dup = classifySentenceDup(sentence, safeTarget, effSource);
      if (dup.skip) { skippedDupes.push(safeTarget); continue; }
      const lEntry     = lemmaMap[safeTarget] || lemmaMap[normalizeLemma(safeTarget)] || {};
      const cardBack   = lEntry.def2 || lEntry.def1 || t.def2 || t.def1 || '';
      const inputForm  = t.input && sentence.includes(t.input) ? t.input : '';
      const sid        = uuid();
      newRows.push({
        uid: sid, ts: new Date().toISOString(),
        sentence, targetWord: safeTarget,
        cardFront: safeTarget + '\n' + sentence,
        cardBack,
        inputForm,
        source: effSource, section: effSection,
        uploaded: false, skipUpload: false,
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
        sentenceInputs: [...newRows, ...prev.sentenceInputs],
      }));
    }
    return newRows;
  }, [data.lemmaMaster, effSource, effSection, classifySentenceDup, showAVIToast, updateData]);

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
      updateData(prev => ({
        ...prev,
        wordInputs: [newWI, ...prev.wordInputs],
      }));
      // Auto-create word card if def2 is present
      if (newWI.def2) {
        autoCreateWordCard({
          entry: newWI, lemmaMaster: data.lemmaMaster,
          cards, decks, uid, updateCards, updateDecks, aviSources, dsh,
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
        nt.lemma = nt.isPhrase
          ? lemmatizePhrase(nt.phraseTokens || [])
          : (await resolveLemmaWithDictionary(nt.input, { localHeadwords }) || nt.input);
        nt.resolvedLemma = nt.lemma;
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
            cards, decks, uid, updateCards, updateDecks, aviSources, dsh,
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
            data, decks, uid, updateCards, updateDecks, aviSources,
            createSentenceRows, updateData, setSiPage]);

  // ── Popup step 1: fetch definitions ─────────────────────────
  const handlePopupStep1 = async (terms) => {
    setPopupFetching(true);
    const updated = await Promise.all(terms.map(async t => {
      const existing = data.lemmaMaster.find(
        l => l.lemma === t.lemma || normalizeLemma(l.lemma) === normalizeLemma(t.lemma)
      );
      if (existing) return { ...t, def1: existing.def1 || '', def2: existing.def2 || '' };
      try {
        const def1 = await fetchDefinition(t.lemma, data.aviSettings);
        return { ...t, def1: def1 === '__RATE_LIMITED__' ? '' : (def1 || '') };
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
      const existingLM = data.lemmaMaster.find(
        l => l.cleanedLemma === norm || l.lemma === t.lemma
      );
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
          uploaded: false, skipUpload: false,
          lastUncheckReason: '', lastUncheckDate: '',
        });
      }
    }

    updateData(prev => ({
      ...prev,
      wordInputs:  [...newWordInputs, ...prev.wordInputs],
      lemmaMaster: [...newLemmas,     ...prev.lemmaMaster],
    }));

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
        cards, decks, uid, updateCards, updateDecks, aviSources, dsh,
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
      if (wi.def2) {
        autoCreateWordCard({
                  entry: wi, lemmaMaster: [...data.lemmaMaster, ...newLemmas],
                  cards, decks, uid, updateCards, updateDecks, aviSources, dsh,
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
    decks, uid, updateCards, updateDecks, aviSources,
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
    const backChanged   = edits.cardBack   !== undefined && edits.cardBack   !== row.cardBack;
    const skipChanged   = edits.skipUpload !== undefined && edits.skipUpload !== !!row.skipUpload;
    if (!targetChanged && !backChanged && !skipChanged) return;
    const now = new Date().toISOString();

    updateData(prev => ({
      ...prev,
      sentenceInputs: prev.sentenceInputs.map(s => {
        if (s.uid !== rowUid) return s;
        const next = { ...s, ...edits };
        if (targetChanged) next.cardFront = (edits.targetWord || s.targetWord) + '\n' + (s.sentence || '');
        if ((targetChanged || backChanged) && s.uploaded) {
          next.uploaded          = false;
          next.lastUncheckReason = 'fields edited';
          next.lastUncheckDate   = now;
        }
        return next;
      }),
    }));

    // Cascade to this row's card precisely: only sentence cards carrying
    // this exact sentence under the old target are touched.
    if (targetChanged || backChanged) {
      const oldEntry  = data.lemmaMaster.find(l => normalizeLemma(l.lemma) === normalizeLemma(row.targetWord));
      const newTarget = edits.targetWord !== undefined ? edits.targetWord : row.targetWord;
      const newEntry  = targetChanged
        ? data.lemmaMaster.find(l => normalizeLemma(l.lemma) === normalizeLemma(newTarget))
        : null;
      updateLinkedCards({
        lemmaID:   oldEntry?.lemmaID || null,
        lemmaText: row.targetWord,
        buildUpdates: (c) => {
          if (c.type !== 'sentence' || c.sentence !== row.sentence) return null;
          return {
            ...(targetChanged ? {
              lemma: newTarget,
              front: newTarget + '\n' + (c.sentence || ''),
              linkedAVILemmaId: newEntry?.lemmaID || null,
            } : {}),
            ...(backChanged ? { back: edits.cardBack } : {}),
          };
        },
        cards, uid, updateCards,
      }).catch(e => console.error('Sentence edit: card update failed', e));
    }
  }, [data, updateData, cards, uid, updateCards]);

  // ── Row actions ──────────────────────────────────────────────
  const toggleSkip = useCallback((uid, val) => {
    updateData(prev => ({
      ...prev,
      sentenceInputs: prev.sentenceInputs.map(s =>
        s.uid === uid ? { ...s, skipUpload: val } : s
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

  // ── Pagination ───────────────────────────────────────────────
  const sortedSentences = useMemo(() =>
    [...data.sentenceInputs].sort((a, b) => (b.ts || '').localeCompare(a.ts || '')),
    [data.sentenceInputs]
  );
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
          {sortedSentences.length} {sortedSentences.length === 1 ? 'entry' : 'entries'}
        </div>
      </div>

      {/* ── Sentence table (mobile: card list instead) ────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', overflowX: isMobile ? 'hidden' : 'auto' }}>
          {isMobile ? (
            <>
              {pagedRows.length === 0 && (
                <div style={{ padding: '24px', textAlign: 'center', color: C.textM, fontSize: '13px' }}>
                  No entries yet. Paste a sentence above.
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
                      No entries yet. Paste a sentence above.
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

