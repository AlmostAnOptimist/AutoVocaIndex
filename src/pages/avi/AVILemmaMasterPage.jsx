// src/pages/avi/AVILemmaMasterPage.jsx
// AVI Lemma Master tab.
// LemmaCard: blur-to-save fields, related pills, search popup trigger, def1 refetch, delete.
// handleCardSave: full cascade for lemma/def1/def2 changes to wordInputs, sentenceInputs, flashcards.
// MiniSearchPopup: modal similarity search, opened from related pills or the magnifying glass button.

import { useState, useCallback, useMemo, useEffect, useRef, memo } from 'react';
import { createPortal } from 'react-dom';
import { doc, writeBatch, collection } from 'firebase/firestore';
import { db, auth } from '../../firebase.js';
import { useAppTheme } from '../../hooks/useAppTheme.js';
import { SH } from '../../theme/buildStyles.js';
import { Def1Display } from '../../components/avi/Def1Display.jsx';
import {
  uuid, normalizeLemma, fetchDefinition,
  hangulToJamo, editDistance, stripKoreanAffixes,
  tokenizeEnglish, DEFAULT_STOPWORDS, detectMode,
  applyRelationPin, applyRelationConnect, syncNuanceSource,
  updateLinkedCards,
} from '../../utils/aviUtils.js';
import { AVIMiniSearchPopup } from '../../components/avi/AVIMiniSearchPopup.jsx';
import { LemmaAutocompleteInput, LemmaMergeModal } from '../../components/avi/LemmaAutocompleteInput.jsx';
import { Icons, MagnifyIcon } from '../../components/Icons.jsx';
import { PaginationFooter } from '../../components/PaginationFooter.jsx';
import { usePaginationKeys } from '../../hooks/usePaginationKeys.js';

const isMobile = typeof window !== 'undefined' && window.innerWidth <= 700;
// Mobile cards are much heavier per-row than desktop's grid (two always-mounted
// textareas + a live autocomplete component, vs compact grid cells) — keeping
// far fewer of them mounted at once matters more on iOS Safari, which crashes
// a tab well before desktop browsers would even start to feel slow under the
// same memory pressure.
const LM_PAGE_SIZE = isMobile ? 20 : 100;

// updateLinkedCards now lives in aviUtils.js (shared with Word Input) and
// supports per-card updates via buildUpdates(card).

// ── MiniSearchPopup ──────────────────────────────────────────
// Compact similarity search modal. Opened from:
//   - Clicking a related lemma pill in LemmaCard
//   - Clicking the magnifying glass button on a LemmaCard or WordRow
function MiniSearchPopup({ initialQuery, data, updateData, onClose, C, S, showAVIToast }) {
  const [query,       setQuery]       = useState(initialQuery || '');
  const [resolved,    setResolved]    = useState(null);
  const [wordResults, setWordResults] = useState([]);
  const [status,      setStatus]      = useState('');
  const [basket,      setBasket]      = useState([]);
  const [relType,     setRelType]     = useState('Form');

  // Run search on mount if initialQuery provided
  useEffect(() => {
    if (initialQuery) runSearch(initialQuery);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function sortResults(results) {
    return [...results].sort((a, b) => {
      if (a.pinForm || a.pinMeaning) return -1;
      if (b.pinForm || b.pinMeaning) return 1;
      if (a.hide && !b.hide) return 1;
      if (!a.hide && b.hide) return -1;
      return 0;
    });
  }

  function runSearch(q = query) {
    const raw = (q || '').trim();
    if (!raw) return;
    setQuery(raw);
    setStatus('');
    setWordResults([]);
    setResolved(null);

    const mode = detectMode(raw);
    let resolvedEntry = null;

    if (mode === 'Korean') {
      const normQ = normalizeLemma(raw);
      resolvedEntry =
        data.lemmaMaster.find(l => normalizeLemma(l.lemma) === normQ) ||
        data.lemmaMaster.find(l => l.lemma.startsWith(raw)) ||
        data.lemmaMaster.find(l => l.lemma.includes(raw));

      if (!resolvedEntry) { setStatus('No match'); return; }
      setResolved({ resolvedLemma: resolvedEntry.lemma, def1: resolvedEntry.def1, def2: resolvedEntry.def2, lemmaID: resolvedEntry.lemmaID });
      setStatus('Exact');

      // Build results: other lemmas with similar jamo or shared Korean chars
      const jamoQ  = hangulToJamo(normQ);
      const results = data.lemmaMaster
        .filter(l => l.lemmaID !== resolvedEntry.lemmaID)
        .map(l => {
          const normL = normalizeLemma(l.lemma);
          const jamoL = hangulToJamo(normL);
          const dist  = editDistance(jamoQ, jamoL, 4);
          const sharedChars = [...normQ].filter(ch => normL.includes(ch) && /[가-힣]/.test(ch)).length;
          const score = sharedChars * 2 - dist;
          const pinForm    = (resolvedEntry.relatedForm    || '').split(',').map(s => s.trim()).includes(l.lemmaID);
          const pinMeaning = (resolvedEntry.relatedMeaning || '').split(',').map(s => s.trim()).includes(l.lemmaID);
          const hide       = (resolvedEntry.hiddenRelated  || '').split(',').map(s => s.trim()).includes(l.lemmaID);
          return { ...l, score, dist, pinForm, pinMeaning, hide, tag: dist <= 2 ? 'near' : sharedChars > 0 ? 'shared' : '' };
        })
        .filter(l => l.score > 0 || l.pinForm || l.pinMeaning);

      // Pinned connections are never capped — only the discovery pool is.
      const pinned = results.filter(l => l.pinForm || l.pinMeaning);
      const rest = results
        .filter(l => !(l.pinForm || l.pinMeaning))
        .sort((a, b) => b.score - a.score)
        .slice(0, 30);

      setWordResults(sortResults([...pinned, ...rest]));
    } else {
      // English search: tokenize query and match against def1/def2
      const qTokens = tokenizeEnglish(raw, DEFAULT_STOPWORDS);
      if (!qTokens.length) { setStatus('No match'); return; }

      resolvedEntry = null;
      const results = data.lemmaMaster.map(l => {
        const defTokens = tokenizeEnglish((l.def1 || '') + ' ' + (l.def2 || ''), DEFAULT_STOPWORDS);
        const shared = qTokens.filter(t => defTokens.includes(t)).length;
        if (!shared) return null;
        return { ...l, score: shared, pinForm: false, pinMeaning: false, hide: false, tag: '' };
      }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 20);

      if (!results.length) { setStatus('No match'); return; }
      setStatus('English match');
      setWordResults(results);
    }

    // Auto-add resolved lemma to basket as center
    if (resolvedEntry) {
      setBasket(prev => {
        if (prev.some(b => b.lemmaID === resolvedEntry.lemmaID)) return prev;
        return [{ lemmaID: resolvedEntry.lemmaID, lemma: resolvedEntry.lemma, isCenter: true }, ...prev];
      });
    }
  }

  const handlePinToggle = (lemmaID, type, val) => {
    if (!resolved?.lemmaID) return;
    updateData(prev => applyRelationPin(prev, resolved.lemmaID, lemmaID, type, val, showAVIToast));
    setWordResults(prev => sortResults(prev.map(r =>
      r.lemmaID !== lemmaID ? r : {
        ...r,
        pinForm:    type === 'pinForm'    ? val : r.pinForm,
        pinMeaning: type === 'pinMeaning' ? val : r.pinMeaning,
        hide:       type === 'hide'       ? val : r.hide,
      }
    )));
  };

  const toggleBasket = (lemmaID, lemma) => {
    setBasket(prev => prev.find(b => b.lemmaID === lemmaID)
      ? prev.filter(b => b.lemmaID !== lemmaID)
      : [...prev, { lemmaID, lemma }]
    );
  };

  const connectBasket = () => {
    const items = basket.filter(b => b.lemmaID);
    if (items.length < 2) return;
    updateData(prev => applyRelationConnect(prev, items.map(b => b.lemmaID), relType, showAVIToast));
    setBasket([]);
  };

  const thS = { padding: '5px 8px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: C.textM, borderBottom: `1px solid ${C.border}`, textAlign: 'left', whiteSpace: 'nowrap' };
  const tdS = { padding: '5px 8px', fontSize: '12px', color: C.text, borderBottom: `1px solid ${C.border}`, verticalAlign: 'top' };

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: '12px', padding: '20px', width: 'min(94vw, 720px)', maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 8px 40px rgba(0,0,0,0.5)' }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
          <input
            style={{ flex: 1, padding: '6px 10px', borderRadius: '6px', border: `1px solid ${C.border}`, background: C.bg, color: C.text, fontSize: '13px', fontFamily: SH.fk, outline: 'none' }}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && runSearch()}
            placeholder="Korean word or English meaning…"
          />
          <button onClick={() => runSearch()} style={{ ...S.btnPrimary, ...S.btnMetallic, padding: '6px 14px', borderRadius: '6px', fontSize: '13px', fontWeight: 600 }}>Search</button>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.textM, fontSize: '18px', cursor: 'pointer', lineHeight: 1, padding: '0 4px' }}>✕</button>
        </div>

        {/* Resolved lemma */}
        {resolved && (
          <div style={{ marginBottom: '12px', padding: '8px 12px', background: C.raised, borderRadius: '8px', border: `1px solid ${C.border}` }}>
            <span style={{ fontFamily: SH.fk, fontSize: '16px', fontWeight: 700, color: C.accent }}>{resolved.resolvedLemma}</span>
            {resolved.def2 && <div style={{ fontSize: '12px', color: C.text, marginTop: '3px' }}>{resolved.def2}</div>}
            {resolved.def1 && !resolved.def2 && <div style={{ fontSize: '12px', color: C.textM, marginTop: '3px' }}>{resolved.def1.split('\n')[0]}</div>}
          </div>
        )}

        {/* Results */}
        {wordResults.length > 0 && (
          <div style={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: '8px', marginBottom: '12px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr>
                  {['Lemma', 'Def 2', 'Tag', 'Pin Form', 'Pin Meaning', 'Hide', '+ Basket'].map(h => (
                    <th key={h} style={thS}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {wordResults.map(r => {
                  const inBasket = basket.some(b => b.lemmaID === r.lemmaID);
                  return (
                    <tr key={r.lemmaID} style={{ background: r.hide ? `${C.textM}10` : r.pinForm || r.pinMeaning ? `${C.accent}08` : 'transparent', opacity: r.hide ? 0.5 : 1 }}>
                      <td style={tdS}><span style={{ fontFamily: SH.fk, color: C.accent }}>{r.lemma}</span></td>
                      <td style={{ ...tdS, maxWidth: '160px', color: C.textM }}>{r.def2 || r.def1?.split('\n')[0] || '—'}</td>
                      <td style={tdS}><span style={{ fontSize: '10px', background: C.raised, borderRadius: '4px', padding: '1px 5px', color: C.textM, fontFamily: SH.fm }}>{r.tag || '—'}</span></td>
                      <td style={{ ...tdS, textAlign: 'center' }}><input type="checkbox" checked={!!r.pinForm} onChange={e => handlePinToggle(r.lemmaID, 'pinForm', e.target.checked)} style={{ accentColor: C.accent }} /></td>
                      <td style={{ ...tdS, textAlign: 'center' }}><input type="checkbox" checked={!!r.pinMeaning} onChange={e => handlePinToggle(r.lemmaID, 'pinMeaning', e.target.checked)} style={{ accentColor: C.accent }} /></td>
                      <td style={{ ...tdS, textAlign: 'center' }}><input type="checkbox" checked={!!r.hide} onChange={e => handlePinToggle(r.lemmaID, 'hide', e.target.checked)} style={{ accentColor: C.accent }} /></td>
                      <td style={{ ...tdS, textAlign: 'center' }}>
                        <button onClick={() => toggleBasket(r.lemmaID, r.lemma)} style={{ background: inBasket ? C.accent : C.raised, color: inBasket ? '#fff' : C.textM, border: `1px solid ${inBasket ? C.accent : C.border}`, borderRadius: '4px', padding: '1px 8px', fontSize: '11px', cursor: 'pointer', fontWeight: 600 }}>
                          {inBasket ? '✓' : '+'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {status === 'No match' && <div style={{ color: C.textM, fontSize: '13px', marginBottom: '12px' }}>No related lemmas found.</div>}

        {/* Basket */}
        {basket.length >= 2 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '10px 12px', background: C.raised, borderRadius: '8px', border: `1px solid ${C.border}` }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: C.text, flexShrink: 0 }}>Connect:</span>
            {basket.map(b => (
              <span key={b.lemmaID} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', background: C.accentSoft, border: `1px solid ${C.accent}44`, borderRadius: '12px', padding: '2px 8px', fontSize: '12px', color: C.accent, fontFamily: SH.fk }}>
                {b.lemma}
                {!b.isCenter && <button onClick={() => toggleBasket(b.lemmaID, b.lemma)} style={{ background: 'none', border: 'none', color: C.accent, cursor: 'pointer', fontSize: '11px', lineHeight: 1, padding: '0 1px' }}>✕</button>}
              </span>
            ))}
            <div style={{ display: 'flex', gap: '4px', marginLeft: 'auto' }}>
              {['Form', 'Meaning', 'Both'].map(t => (
                <button key={t} onClick={() => setRelType(t)} style={{ background: relType === t ? C.accent : C.surface, color: relType === t ? '#fff' : C.text, border: `1px solid ${relType === t ? C.accent : C.border}`, borderRadius: '5px', padding: '2px 8px', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}>{t}</button>
              ))}
              <button onClick={connectBasket} style={{ ...S.btnPrimary, ...S.btnMetallic, borderRadius: '6px', padding: '4px 12px', fontSize: '12px', fontWeight: 700, marginLeft: '4px' }}>Connect All</button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

// ── LemmaCard ────────────────────────────────────────────────
const LemmaCard = memo(function LemmaCard({ l, lemmaMaster, lemmaSourcesMap, fetching, onSave, onRefetchDef1, onDelete, onLemmaClick, wordInputs, sentenceInputs, onMerge, editingLemmaID, setEditingLemmaID, C }) {
  const [lemmaVal,    setLemmaVal]    = useState(l.lemma || '');
  const [def1Val,     setDef1Val]     = useState(l.def1  || '');
  const [def2Val,     setDef2Val]     = useState(l.def2  || '');
  const [mergeTarget, setMergeTarget] = useState(null); // selected lemma entry to merge into

  useEffect(() => { setLemmaVal(l.lemma || ''); }, [l.lemma]);
  useEffect(() => { setDef1Val(l.def1  || ''); }, [l.def1]);
  useEffect(() => { setDef2Val(l.def2  || ''); }, [l.def2]);

  // Called when the lemma field blurs with a changed value.
  // If the new value matches an existing lemma, open the merge modal instead of saving.
  const handleLemmaBlur = (value) => {
    if (value === (l.lemma || '')) return;
    const normVal  = normalizeLemma(value);
    const existing = lemmaMaster.find(
      x => x.lemmaID !== l.lemmaID && normalizeLemma(x.lemma) === normVal
    );
    if (existing) { setMergeTarget(existing); return; }
    onSave(l.lemmaID, 'lemma', value);
  };

  // Called when user selects an existing lemma from the autocomplete dropdown.
  const handleSelectExistingLemma = (lemmaEntry) => {
    setMergeTarget(lemmaEntry);
  };

  const handleBlur = (field, value) => {
    const original = field === 'def1' ? l.def1 : l.def2;
    if (value === (original || '')) return;
    onSave(l.lemmaID, field, value);
  };

  const relatedPills = (idStr, label) => {
    const ids = (idStr || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return null;
    const names = ids.map(id => lemmaMaster.find(x => x.lemmaID === id)?.lemma).filter(Boolean);
    if (!names.length) return null;
    return (
      <div style={{ marginTop: '4px' }}>
        <div style={{ fontSize: '9px', color: C.textM, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, marginBottom: '3px' }}>{label}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
          {names.map((name, i) => (
            <span key={i} onClick={() => onLemmaClick && onLemmaClick(name)} style={{ fontSize: '11px', color: C.tL, cursor: 'pointer', background: `${C.tL}18`, borderRadius: '3px', padding: '1px 6px', fontFamily: SH.fk }}>
              {name}
            </span>
          ))}
        </div>
      </div>
    );
  };

  const sources = lemmaSourcesMap[normalizeLemma(l.lemma) || ''] || [];
  const isFetching = fetching === l.lemmaID;

  const fieldBase = {
    background: 'transparent', border: '1px solid transparent', borderRadius: '4px',
    color: C.text, outline: 'none', width: '100%', resize: 'vertical',
    transition: 'border-color 0.15s, background 0.15s', fontFamily: 'inherit',
  };

  if (isMobile) {
    const formPills    = relatedPills(l.relatedForm,    'Form');
    const meaningPills = relatedPills(l.relatedMeaning, 'Meaning');
    const isEditing    = editingLemmaID === l.lemmaID;

    const startEdit = () => setEditingLemmaID(l.lemmaID);

    const saveEdit = () => {
      if (lemmaVal !== (l.lemma || '')) {
        const normVal  = normalizeLemma(lemmaVal);
        const existing = lemmaMaster.find(x => x.lemmaID !== l.lemmaID && normalizeLemma(x.lemma) === normVal);
        if (existing) { setMergeTarget(existing); return; }
        onSave(l.lemmaID, 'lemma', lemmaVal);
      }
      if (def2Val !== (l.def2 || '')) onSave(l.lemmaID, 'def2', def2Val);
      if (def1Val !== (l.def1 || '')) onSave(l.lemmaID, 'def1', def1Val);
      setEditingLemmaID(null);
    };

    const cancelEdit = () => {
      setLemmaVal(l.lemma || '');
      setDef1Val(l.def1 || '');
      setDef2Val(l.def2 || '');
      setEditingLemmaID(null);
    };

    return (
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: '10px', padding: '12px 14px', marginBottom: '8px' }}>
        {mergeTarget && (
          <LemmaMergeModal
            editedLemma={l}
            selectedLemma={mergeTarget}
            lemmaMaster={lemmaMaster}
            wordInputs={wordInputs}
            sentenceInputs={sentenceInputs}
            onConfirm={(survivingDef2) => {
              onMerge(l.lemmaID, mergeTarget.lemmaID, survivingDef2);
              setMergeTarget(null);
              setEditingLemmaID(null);
            }}
            onCancel={() => { setLemmaVal(l.lemma || ''); setMergeTarget(null); }}
            C={C}
          />
        )}

        {isEditing ? (
          <>
            <LemmaAutocompleteInput
              value={lemmaVal}
              onChange={setLemmaVal}
              lemmaMaster={lemmaMaster}
              excludeLemmaID={l.lemmaID}
              inputStyle={{ ...fieldBase, fontFamily: SH.fk, fontWeight: 700, color: C.accent, fontSize: '16px', padding: '2px 4px', border: `1px solid ${C.border}`, background: C.bg }}
              lang="ko"
              C={C}
            />
            {(formPills || meaningPills) && (
              <div style={{ display: 'flex', gap: '14px', marginTop: '8px' }}>
                {formPills    && <div style={{ flex: 1, minWidth: 0 }}>{formPills}</div>}
                {meaningPills && <div style={{ flex: 1, minWidth: 0 }}>{meaningPills}</div>}
              </div>
            )}
            <div style={{ marginTop: '10px' }}>
              <div style={{ fontSize: '9.5px', fontWeight: 700, color: C.textM, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '3px' }}>Definition 2</div>
              <textarea
                style={{ ...fieldBase, fontSize: '12px', lineHeight: 1.6, padding: '6px 8px', minHeight: '60px', border: `1px solid ${C.border}`, background: C.bg }}
                value={def2Val}
                onChange={e => setDef2Val(e.target.value)}
              />
            </div>
            <div style={{ marginTop: '8px' }}>
              <div style={{ fontSize: '9.5px', fontWeight: 700, color: C.textM, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '3px' }}>Definition 1</div>
              <textarea
                style={{ ...fieldBase, fontSize: '12px', lineHeight: 1.6, padding: '6px 8px', minHeight: '60px', border: `1px solid ${C.border}`, background: C.bg }}
                value={def1Val}
                onChange={e => setDef1Val(e.target.value)}
              />
            </div>
            <div style={{ display: 'flex', gap: '6px', marginTop: '10px' }}>
              <button style={{ ...S.btnPrimary, flex: 1, padding: '7px', borderRadius: '6px', fontSize: '12px', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }} onClick={saveEdit}>
                {Icons.check} Save
              </button>
              <button style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px', padding: '7px', borderRadius: '6px', fontSize: '12px', border: `1px solid ${C.border}`, background: 'transparent', color: C.textM, cursor: 'pointer' }} onClick={cancelEdit}>
                {Icons.x} Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            <div onClick={startEdit} style={{ cursor: 'pointer' }}>
              <div style={{ fontFamily: SH.fk, fontWeight: 700, fontSize: '16px', color: C.accent }}>{l.lemma}</div>
              {(formPills || meaningPills) && (
                <div style={{ display: 'flex', gap: '14px', marginTop: '6px' }}>
                  {formPills    && <div style={{ flex: 1, minWidth: 0 }}>{formPills}</div>}
                  {meaningPills && <div style={{ flex: 1, minWidth: 0 }}>{meaningPills}</div>}
                </div>
              )}
              <div style={{ marginTop: '8px' }}>
                <div style={{ fontSize: '9.5px', fontWeight: 700, color: C.textM, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '2px' }}>Definition 2</div>
                <div style={{ fontSize: '12px', lineHeight: 1.5, color: l.def2 ? C.text : C.textM, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {l.def2 || '—'}
                </div>
              </div>
              <div style={{ marginTop: '6px' }}>
                <div style={{ fontSize: '9.5px', fontWeight: 700, color: C.textM, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '2px' }}>Definition 1</div>
                <div style={{ fontSize: '12px', lineHeight: 1.5, color: l.def1 ? C.text : C.textM, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {l.def1 || '—'}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '6px', marginTop: '10px' }}>
              <button
                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', padding: '6px 8px', borderRadius: '6px', fontSize: '11px', border: `1px solid ${C.border}`, background: 'transparent', color: C.textM, cursor: isFetching ? 'default' : 'pointer', opacity: isFetching ? 0.5 : 1 }}
                onClick={() => onRefetchDef1(l.lemmaID)}
                disabled={isFetching}
                title="Re-fetch Definition 1 from dictionary"
              >
                {isFetching ? <span className="icon-spin" style={{ display: 'inline-flex' }}>{Icons.refresh}</span> : Icons.refresh} Def1
              </button>
              <button
                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', padding: '6px 8px', borderRadius: '6px', fontSize: '11px', border: `1px solid ${C.border}`, background: 'transparent', color: C.textM, cursor: 'pointer' }}
                onClick={() => onLemmaClick && onLemmaClick(l.lemma)}
                title={`Search similarity for "${l.lemma}"`}
              >
                <MagnifyIcon size={11} /> Search
              </button>
              <button
                style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', padding: '6px 8px', borderRadius: '6px', fontSize: '11px', border: `1px solid ${C.border}`, background: 'transparent', color: C.danger, cursor: 'pointer' }}
                onClick={() => onDelete(l.lemmaID)}
                title="Delete this lemma and its Word Input rows"
              >
                {Icons.trash} Delete
              </button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center', marginTop: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
              {sources.length === 0
                ? <span style={{ fontSize: '11px', color: C.textM }}>—</span>
                : sources.map(s => (
                    <span key={s} style={{ fontSize: '11px', background: C.accentSoft, color: C.accent, borderRadius: '4px', padding: '1px 6px', fontFamily: SH.fm }}>{s}</span>
                  ))
              }
              <span style={{ marginLeft: 'auto', fontSize: '10.5px', color: C.textM, fontFamily: SH.fm }}>{l.lastUpdated ? new Date(l.lastUpdated).toLocaleDateString() : '—'}</span>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: '10px', marginBottom: '8px', overflow: 'hidden' }}>
      {/* Top row */}
      <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr 1fr 88px', borderBottom: `1px solid ${C.border}` }}>

        {/* Lemma + relations */}
        <div style={{ padding: '12px 14px', borderRight: `1px solid ${C.border}` }}>
          <LemmaAutocompleteInput
            value={lemmaVal}
            onChange={setLemmaVal}
            onBlur={handleLemmaBlur}
            onFocus={e => { e.target.style.background = C.raised; e.target.style.borderColor = C.border; }}
            onSelectExisting={handleSelectExistingLemma}
            lemmaMaster={lemmaMaster}
            excludeLemmaID={l.lemmaID}
            inputStyle={{ ...fieldBase, fontFamily: SH.fk, fontWeight: 700, color: C.accent, fontSize: '16px', padding: '2px 4px', marginBottom: '6px' }}
            lang="ko"
            C={C}
          />
          {relatedPills(l.relatedForm,    'Form')}
          {relatedPills(l.relatedMeaning, 'Meaning')}
        </div>

        {/* Merge modal — portal-rendered, shown when a lemma edit targets an existing entry */}
        {mergeTarget && (
          <LemmaMergeModal
            editedLemma={l}
            selectedLemma={mergeTarget}
            lemmaMaster={lemmaMaster}
            wordInputs={wordInputs}
            sentenceInputs={sentenceInputs}
            onConfirm={(survivingDef2) => {
              onMerge(l.lemmaID, mergeTarget.lemmaID, survivingDef2);
              setMergeTarget(null);
            }}
            onCancel={() => { setLemmaVal(l.lemma || ''); setMergeTarget(null); }}
            C={C}
          />
        )}

        {/* Def1 */}
        <div style={{ padding: '12px 14px', borderRight: `1px solid ${C.border}` }}>
          <textarea
            style={{ ...fieldBase, fontSize: '12px', lineHeight: 1.6, padding: '2px 4px', minHeight: '80px' }}
            value={def1Val}
            onChange={e => setDef1Val(e.target.value)}
            onBlur={e => handleBlur('def1', e.target.value)}
            onFocus={e => { e.target.style.background = C.raised; e.target.style.borderColor = C.border; }}
            placeholder="—"
          />
        </div>

        {/* Def2 */}
        <div style={{ padding: '12px 14px', borderRight: `1px solid ${C.border}` }}>
          <textarea
            style={{ ...fieldBase, fontSize: '12px', lineHeight: 1.6, padding: '2px 4px', minHeight: '80px' }}
            value={def2Val}
            onChange={e => setDef2Val(e.target.value)}
            onBlur={e => handleBlur('def2', e.target.value)}
            onFocus={e => { e.target.style.background = C.raised; e.target.style.borderColor = C.border; }}
            placeholder="—"
          />
        </div>

        {/* Buttons */}
        <div style={{ padding: '12px 10px', display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'stretch' }}>
          <button
            style={{ padding: '4px 8px', borderRadius: '6px', fontSize: '11px', border: `1px solid ${C.border}`, background: 'transparent', color: C.textM, cursor: isFetching ? 'default' : 'pointer', opacity: isFetching ? 0.5 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
            onClick={() => onRefetchDef1(l.lemmaID)}
            disabled={isFetching}
            title="Re-fetch Definition 1 from dictionary"
          >
            {isFetching ? <span className="icon-spin" style={{ display: 'inline-flex' }}>{Icons.refresh}</span> : Icons.refresh} Def1
          </button>
          <button
            style={{ padding: '4px 8px', borderRadius: '6px', fontSize: '11px', border: `1px solid ${C.border}`, background: 'transparent', color: C.textM, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
            onClick={() => onLemmaClick && onLemmaClick(l.lemma)}
            title={`Search similarity for "${l.lemma}"`}
          >
            <MagnifyIcon size={11} /> Search
          </button>
          <button
            style={{ padding: '4px 8px', borderRadius: '6px', fontSize: '11px', border: `1px solid ${C.border}`, background: 'transparent', color: C.danger, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
            onClick={() => onDelete(l.lemmaID)}
            title="Delete this lemma and its Word Input rows"
          >
            {Icons.trash} Delete
          </button>
        </div>
      </div>

      {/* Bottom row: sources + metadata */}
      <div style={{ display: 'grid', gridTemplateColumns: 'calc(200px + 1fr) 1fr 88px' }}>
        <div style={{ padding: '5px 14px', borderRight: `1px solid ${C.border}`, display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center', minHeight: '28px' }}>
          {sources.length === 0
            ? <span style={{ fontSize: '11px', color: C.textM }}>—</span>
            : sources.map(s => (
                <span key={s} style={{ fontSize: '11px', background: C.accentSoft, color: C.accent, borderRadius: '4px', padding: '1px 6px', fontFamily: SH.fm }}>{s}</span>
              ))
          }
        </div>
        <div style={{ padding: '5px 14px', display: 'flex', gap: '10px', alignItems: 'center', borderRight: `1px solid ${C.border}` }}>
          <span style={{ fontSize: '11px', color: C.textM, fontFamily: SH.fm }}>{l.lastUpdated ? new Date(l.lastUpdated).toLocaleDateString() : '—'}</span>
          <span style={{ fontSize: '10px', background: C.raised, borderRadius: '4px', padding: '1px 5px', color: C.textM }}>{l.autoAddedBy || ''}</span>
        </div>
        <div />
      </div>
    </div>
  );
});

// ── Main page ────────────────────────────────────────────────
export function AVILemmaMasterPage({
  data, updateData, showAVIToast,
  cards, updateCards,
  lmPage, setLmPage,
}) {
  const { C, S } = useAppTheme();
  const uid = auth.currentUser?.uid;

  const [filter,      setFilter]      = useState('');
  const [fetching,    setFetching]    = useState(null);
  const [lemmaPopup,  setLemmaPopup]  = useState(null); // lemma string to open popup for
  const [editingLemmaID, setEditingLemmaID] = useState(null); // mobile only — which card (if any) is in edit mode
  const scrollRef = useRef(null);

  const scrollToTop = () => scrollRef?.current?.scrollTo({ top: 0, behavior: 'smooth' });

  const sortOrder = data.aviSettings.lemmaSortOrder || 'recent';
  const setSortOrder = (val) => {
    updateData(prev => ({ ...prev, aviSettings: { ...prev.aviSettings, lemmaSortOrder: val } }));
  };

  // ── Sources map ──────────────────────────────────────────────
  const lemmaSourcesMap = useMemo(() => {
    const map = {};
    const add = (key, source, section) => {
      if (!key || !source) return;
      if (!map[key]) map[key] = new Set();
      map[key].add(section ? `${source} §${section}` : source);
    };
    for (const w of data.wordInputs) add(normalizeLemma(w.lemma), w.source, w.section);
    for (const s of data.sentenceInputs) add(normalizeLemma(s.targetWord), s.source, s.section);
    const result = {};
    for (const [k, v] of Object.entries(map)) result[k] = [...v].sort();
    return result;
  }, [data.wordInputs, data.sentenceInputs]);

  // ── Filtered + sorted list ───────────────────────────────────
  const filtered = useMemo(() => {
    let list = data.lemmaMaster.filter(l => {
      if (!filter) return true;
      const f = filter.toLowerCase();
      return (l.lemma || '').includes(filter) ||
             (l.def1  || '').toLowerCase().includes(f) ||
             (l.def2  || '').toLowerCase().includes(f);
    });

    // Sort: lemma matches first, then def matches; within each tier, apply lemmaSortOrder
    const inLemma = list.filter(l => (l.lemma || '').includes(filter));
    const inDef   = list.filter(l =>
      !(l.lemma || '').includes(filter) && (
        (l.def1 || '').toLowerCase().includes(filter.toLowerCase()) ||
        (l.def2 || '').toLowerCase().includes(filter.toLowerCase())
      )
    );

    const applyOrder = (arr) => {
      if (sortOrder === 'alpha') {
        return [...arr].sort((a, b) => (a.lemma || '').localeCompare(b.lemma || '', 'ko'));
      }
      return [...arr].sort((a, b) => (b.lastUpdated || '').localeCompare(a.lastUpdated || ''));
    };

    // When no filter, just apply sort order to everything
    if (!filter) return applyOrder(list);

    return [...applyOrder(inLemma), ...applyOrder(inDef)];
  }, [data.lemmaMaster, filter, sortOrder]);

  const totalPages   = Math.ceil(filtered.length / LM_PAGE_SIZE);
  const page         = Math.min(lmPage, Math.max(0, totalPages - 1));
  const filteredPage = filtered.slice(page * LM_PAGE_SIZE, (page + 1) * LM_PAGE_SIZE);

  // ←/→ paginate the lemma list; disabled while the search popup or a mobile
  // card editor is open.
  usePaginationKeys({
    page,
    totalPages,
    setPage: (p) => {
      setLmPage(p);
      scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    },
    enabled: !lemmaPopup && !editingLemmaID,
  });

  // Reset to page 0 when filter or sort changes
  useEffect(() => { setLmPage(0); }, [filter, sortOrder, setLmPage]);

  // ── handleCardSave ───────────────────────────────────────────
  const handleCardSave = useCallback(async (lemmaID, field, value) => {
    const lmatch = data.lemmaMaster.find(l => l.lemmaID === lemmaID);
    if (!lmatch) return;
    const oldLemma = lmatch.lemma || '';
    const oldNorm  = normalizeLemma(oldLemma);
    const now      = new Date().toISOString();

    if (field === 'lemma') {
      const newNorm      = normalizeLemma(value);
      const lemmaChanged = newNorm !== oldNorm;

      // Update lemmaMaster + cascade to wordInputs and sentenceInputs
      updateData(prev => ({
        ...prev,
        lemmaMaster: prev.lemmaMaster.map(l => l.lemmaID !== lemmaID ? l : {
          ...l, lemma: value, cleanedLemma: newNorm, lastUpdated: now, autoAddedBy: 'manual',
        }),
        wordInputs: lemmaChanged
          ? prev.wordInputs.map(w => normalizeLemma(w.lemma) !== oldNorm ? w : {
              ...w,
              lemma: value,
              ...(w.uploaded ? { uploaded: false, lastUncheckReason: 'Lemma renamed in Lemma Master', lastUncheckDate: now } : {}),
            })
          : prev.wordInputs,
        sentenceInputs: lemmaChanged
          ? prev.sentenceInputs.map(s => normalizeLemma(s.targetWord) !== oldNorm ? s : { ...s, targetWord: value })
          : prev.sentenceInputs,
      }));

      // Update linked flashcards
      if (lemmaChanged) {
        updateLinkedCards({
          lemmaID, lemmaText: lmatch.lemma,
          buildUpdates: (c) => c.type === 'sentence'
            ? { front: value + '\n' + (c.sentence || ''), lemma: value }
            : { front: value, lemma: value },
          cards, uid, updateCards,
        }).catch(e => console.error('LM lemma: card update failed', e));

        // Re-fetch def1 for new lemma
        setFetching(lemmaID);
        try {
          const def1 = await fetchDefinition(value, data.aviSettings);
          if (def1 && def1 !== '__RATE_LIMITED__' && def1 !== '__NO_API_KEY__') {
            updateData(prev => ({
              ...prev,
              lemmaMaster: prev.lemmaMaster.map(l => l.lemmaID === lemmaID ? { ...l, def1, lastUpdated: new Date().toISOString() } : l),
              wordInputs:  prev.wordInputs.map(w => normalizeLemma(w.lemma) === newNorm ? { ...w, def1 } : w),
            }));
          }
        } catch {} finally { setFetching(null); }
      }

    } else if (field === 'def1') {
      const oldDef1 = lmatch.def1 || '';
      updateData(prev => ({
        ...prev,
        lemmaMaster: prev.lemmaMaster.map(l => l.lemmaID !== lemmaID ? l : { ...l, def1: value, lastUpdated: now, autoAddedBy: 'manual' }),
        wordInputs:  prev.wordInputs.map(w => normalizeLemma(w.lemma) === oldNorm ? { ...w, def1: value } : w),
        // Sentence rows whose cardBack was derived from def1 (no def2 on the
        // lemma) follow it; the exact-match guard protects hand-edited backs.
        sentenceInputs: prev.sentenceInputs.map(s =>
          normalizeLemma(s.targetWord) === oldNorm && oldDef1 && s.cardBack === oldDef1
            ? { ...s, cardBack: value }
            : s
        ),
      }));
      // Cards whose back equals the old def1 follow too.
      if (oldDef1 && value !== oldDef1) {
        updateLinkedCards({
          lemmaID, lemmaText: lmatch.lemma,
          buildUpdates: (c) => c.back === oldDef1 ? { back: value } : null,
          cards, uid, updateCards,
        }).catch(e => console.error('LM def1: card update failed', e));
      }

    } else if (field === 'def2') {
      const def2Changed = value !== (lmatch.def2 || '');
      updateData(prev => ({
        ...prev,
        lemmaMaster: prev.lemmaMaster.map(l => l.lemmaID !== lemmaID ? l : { ...l, def2: value, lastUpdated: now, autoAddedBy: 'manual' }),
        wordInputs: prev.wordInputs.map(w => {
          if (normalizeLemma(w.lemma) !== oldNorm) return w;
          const wasUploaded = w.uploaded;
          return {
            ...w, def2: value,
            ...(def2Changed && wasUploaded ? { uploaded: false, lastUncheckReason: 'Definition 2 edited in Lemma Master', lastUncheckDate: now } : {}),
          };
        }),
        sentenceInputs: prev.sentenceInputs.map(s => {
          if (normalizeLemma(s.targetWord) !== oldNorm) return s;
          const cardBack = value || lmatch.def1 || s.cardBack;
          const changed  = cardBack !== s.cardBack;
          return {
            ...s, cardBack,
            ...(changed && s.uploaded ? { uploaded: false, lastUncheckReason: 'Definition 2 changed in Lemma Master', lastUncheckDate: now } : {}),
          };
        }),
      }));

      // Update linked flashcard backs
      if (def2Changed) {
        updateLinkedCards({ lemmaID, lemmaText: lmatch.lemma, updates: { back: value }, cards, uid, updateCards })
          .catch(e => console.error('LM def2: card update failed', e));

        // Count reset entries for toast
        const resetCount = data.wordInputs.filter(w => normalizeLemma(w.lemma) === oldNorm && w.uploaded).length +
                           data.sentenceInputs.filter(s => normalizeLemma(s.targetWord) === oldNorm && s.uploaded).length;
        if (resetCount > 0) {
          showAVIToast(`Updated "${oldLemma}" — ${resetCount} card${resetCount > 1 ? 's' : ''} reset for review`);
        }
      }
    }
  }, [data, updateData, cards, uid, updateCards, showAVIToast]);

  // ── Merge two lemmas ─────────────────────────────────────────
  // Deletes the edited entry, updates the survivor with the chosen def2 and
  // additive relation fields, then reassigns all Word Input and Sentence Input rows.
  const handleMerge = useCallback((editedLemmaID, survivingLemmaID, survivingDef2) => {
    updateData(prev => {
      const edited   = prev.lemmaMaster.find(l => l.lemmaID === editedLemmaID);
      const survivor = prev.lemmaMaster.find(l => l.lemmaID === survivingLemmaID);
      if (!edited || !survivor) return prev;

      const editedNorm    = normalizeLemma(edited.lemma);
      const survivorLemma = survivor.lemma;
      const now           = new Date().toISOString();

      // Additive merge: union of both sets, minus any reference to the edited entry
      const mergeField = (survivorField, editedField) => {
        const s = new Set((survivorField || '').split(',').map(x => x.trim()).filter(Boolean));
        for (const id of (editedField || '').split(',').map(x => x.trim()).filter(Boolean)) {
          if (id && id !== editedLemmaID) s.add(id);
        }
        s.delete(editedLemmaID); // clean up any stale self-reference
        return [...s].join(',');
      };

      const mergedLemmaMaster = prev.lemmaMaster
        .filter(l => l.lemmaID !== editedLemmaID)
        .map(l => l.lemmaID !== survivingLemmaID ? l : {
          ...l,
          def2:           survivingDef2,
          relatedForm:    mergeField(l.relatedForm,    edited.relatedForm),
          relatedMeaning: mergeField(l.relatedMeaning, edited.relatedMeaning),
          hiddenRelated:  mergeField(l.hiddenRelated,  edited.hiddenRelated),
          lastUpdated:    now,
          autoAddedBy:    'manual',
        });

      const mergedWordInputs = prev.wordInputs.map(w => {
        if (normalizeLemma(w.lemma) !== editedNorm) return w;
        const def2Changed = (survivingDef2 || '') !== (w.def2 || '');
        return {
          ...w,
          lemma: survivorLemma,
          def2:  survivingDef2 || '',
          ...(def2Changed && w.uploaded ? {
            uploaded: false, lastUncheckReason: 'lemma merged', lastUncheckDate: now,
          } : {}),
        };
      });

      // The edited lemma's wordInputs row (if it had its own 동의어/유의어 capture)
      // just got relabeled to the survivor's lemma above — if the survivor already
      // had its own capture too, this collapses the resulting duplicate down to
      // one, and otherwise adds/removes based on the merged relatedMeaning.
      const { wordInputs: finalWordInputs, added, removed } = syncNuanceSource(
        mergedWordInputs, mergedLemmaMaster, [survivingLemmaID]
      );
      if (added.length)   showAVIToast(`Added to 동의어/유의어: ${added.join(', ')}`, 'goToNuanceSource');
      if (removed.length) showAVIToast(`Removed from 동의어/유의어: ${removed.join(', ')}`, 'goToNuanceSource');

      return {
        ...prev,
        lemmaMaster: mergedLemmaMaster,
        wordInputs: finalWordInputs,
        sentenceInputs: prev.sentenceInputs.map(s => {
          if (normalizeLemma(s.targetWord) !== editedNorm) return s;
          const cardBack = survivingDef2 || survivor.def1 || edited.def1 || s.cardBack;
          const changed  = cardBack !== s.cardBack;
          return {
            ...s,
            targetWord: survivorLemma,
            cardFront:  survivorLemma + '\n' + (s.sentence || ''),
            cardBack,
            ...(changed && s.uploaded ? {
              uploaded: false, lastUncheckReason: 'lemma merged', lastUncheckDate: now,
            } : {}),
          };
        }),
      };
    });

    // Cascade to flashcards: the edited lemma's cards adopt the survivor's
    // lemma text and link ID, with per-type fronts (sentence fronts keep
    // their sentence text) and the chosen def2 as back when one was picked.
    const editedPre   = data.lemmaMaster.find(l => l.lemmaID === editedLemmaID);
    const survivorPre = data.lemmaMaster.find(l => l.lemmaID === survivingLemmaID);
    if (editedPre && survivorPre) {
      updateLinkedCards({
        lemmaID: editedLemmaID, lemmaText: editedPre.lemma,
        buildUpdates: (c) => ({
          lemma: survivorPre.lemma,
          front: c.type === 'sentence'
            ? survivorPre.lemma + '\n' + (c.sentence || '')
            : survivorPre.lemma,
          linkedAVILemmaId: survivingLemmaID,
          ...(survivingDef2 ? { back: survivingDef2 } : {}),
        }),
        cards, uid, updateCards,
      }).catch(e => console.error('LM merge: card update failed', e));
    }
  }, [updateData, showAVIToast, data, cards, uid, updateCards]);

  // ── Refetch def1 ─────────────────────────────────────────────
  const refetchDef1 = useCallback(async (lemmaID) => {
    const l = data.lemmaMaster.find(x => x.lemmaID === lemmaID);
    if (!l) return;
    setFetching(lemmaID);
    try {
      const def1 = await fetchDefinition(l.lemma, data.aviSettings);
      if (def1 === '__RATE_LIMITED__') { showAVIToast('API rate limit reached.'); return; }
      const oldDef1 = l.def1 || '';
      updateData(prev => ({
        ...prev,
        lemmaMaster: prev.lemmaMaster.map(x => x.lemmaID === lemmaID ? { ...x, def1, lastUpdated: new Date().toISOString() } : x),
        wordInputs:  prev.wordInputs.map(w => normalizeLemma(w.lemma) === normalizeLemma(l.lemma) ? { ...w, def1 } : w),
        sentenceInputs: prev.sentenceInputs.map(s =>
          normalizeLemma(s.targetWord) === normalizeLemma(l.lemma) && oldDef1 && s.cardBack === oldDef1
            ? { ...s, cardBack: def1 }
            : s
        ),
      }));
      if (oldDef1 && def1 !== oldDef1) {
        updateLinkedCards({
          lemmaID, lemmaText: l.lemma,
          buildUpdates: (c) => c.back === oldDef1 ? { back: def1 } : null,
          cards, uid, updateCards,
        }).catch(() => {});
      }
    } catch { showAVIToast('Definition fetch failed.'); }
    finally { setFetching(null); }
  }, [data, updateData, showAVIToast]);

  // ── Delete lemma ─────────────────────────────────────────────
  const deleteLemma = useCallback((lemmaID) => {
    const l = data.lemmaMaster.find(x => x.lemmaID === lemmaID);
    if (!l) return;
    const norm      = normalizeLemma(l.lemma) || l.cleanedLemma || '';
    const wordCount = data.wordInputs.filter(w => normalizeLemma(w.lemma) === norm).length;
    const sentCount = data.sentenceInputs.filter(s => normalizeLemma(s.targetWord) === norm).length;
    const cardCount = (cards || []).filter(c =>
      c.linkedAVILemmaId === lemmaID ||
      (c.type !== 'grammar' && c.lemma && normalizeLemma(c.lemma) === norm)
    ).length;
    const parts = [];
    if (wordCount) parts.push(`${wordCount} Word Input row${wordCount > 1 ? 's' : ''}`);
    if (sentCount) parts.push(`${sentCount} Sentence row${sentCount > 1 ? 's' : ''}`);
    const msg = parts.length > 0
      ? `Delete lemma "${l.lemma}"? This will also delete ${parts.join(' and ')}.` +
        (cardCount ? ` ${cardCount} linked flashcard${cardCount > 1 ? 's' : ''} will be kept.` : '')
      : `Delete lemma "${l.lemma}" from Lemma Master?`;
    if (!window.confirm(msg)) return;
    updateData(prev => ({
      ...prev,
      lemmaMaster:    prev.lemmaMaster.filter(x => x.lemmaID !== lemmaID),
      wordInputs:     prev.wordInputs.filter(w => normalizeLemma(w.lemma) !== norm),
      sentenceInputs: prev.sentenceInputs.filter(s => normalizeLemma(s.targetWord) !== norm),
    }));
  }, [data, updateData, cards]);

  // ── Dedupe ───────────────────────────────────────────────────
  const dedupeAll = () => {
    const keptByKey = {};
    const kept = [];
    const idRemap = {}; // removed lemmaID -> kept lemmaID
    for (const l of [...data.lemmaMaster].sort((a, b) => (b.def2 ? 1 : 0) - (a.def2 ? 1 : 0))) {
      const key = l.cleanedLemma || normalizeLemma(l.lemma);
      if (!keptByKey[key]) { keptByKey[key] = l; kept.push(l); }
      else idRemap[l.lemmaID] = keptByKey[key].lemmaID;
    }
    const removed = data.lemmaMaster.length - kept.length;
    if (removed === 0) { showAVIToast('No duplicates found.'); return; }

    // Remap relation fields on the kept entries so nothing references a
    // removed lemmaID; self-references produced by the remap are dropped.
    const remapField = (entry, field) => {
      const ids = (entry[field] || '').split(',').map(s => s.trim()).filter(Boolean);
      const out = [...new Set(ids.map(id => idRemap[id] || id))].filter(id => id !== entry.lemmaID);
      return out.join(',');
    };
    const remappedKept = kept.map(l => ({
      ...l,
      relatedForm:    remapField(l, 'relatedForm'),
      relatedMeaning: remapField(l, 'relatedMeaning'),
      hiddenRelated:  remapField(l, 'hiddenRelated'),
    }));
    updateData(prev => ({ ...prev, lemmaMaster: remappedKept }));

    // Repoint cards linked to removed entries at the surviving lemmaID.
    const uidNow = auth.currentUser?.uid;
    if (uidNow && cards?.length) {
      const toFix = cards.filter(c => c.linkedAVILemmaId && idRemap[c.linkedAVILemmaId]);
      if (toFix.length) {
        const batch = writeBatch(db);
        toFix.forEach(c => batch.update(doc(db, 'users', uidNow, 'flashcards', c.id), {
          linkedAVILemmaId: idRemap[c.linkedAVILemmaId],
        }));
        batch.commit().then(() => {
          updateCards(prev => prev ? prev.map(c =>
            c.linkedAVILemmaId && idRemap[c.linkedAVILemmaId]
              ? { ...c, linkedAVILemmaId: idRemap[c.linkedAVILemmaId] }
              : c
          ) : prev);
        }).catch(e => console.error('Dedupe: card relink failed', e));
      }
    }
    showAVIToast(`Deduped: removed ${removed} duplicate${removed > 1 ? 's' : ''}.`);
  };

  // ── Render ───────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', flexShrink: 0, flexWrap: 'wrap' }}>
        <input
          style={{ flex: 1, minWidth: '160px', padding: '6px 10px', borderRadius: '6px', border: `1px solid ${C.border}`, background: C.bg, color: C.text, fontSize: '13px', outline: 'none' }}
          placeholder="Filter lemmas…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <select
          style={{ padding: '6px 8px', borderRadius: '6px', border: `1px solid ${C.border}`, background: C.raised, color: C.text, fontSize: '12px', outline: 'none', cursor: 'pointer' }}
          value={sortOrder}
          onChange={e => setSortOrder(e.target.value)}
        >
          <option value="recent">↓ Recent</option>
          <option value="alpha">A → Z</option>
        </select>
        <button
          style={{ padding: '6px 12px', borderRadius: '6px', border: `1px solid ${C.border}`, background: 'transparent', color: C.textM, fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '5px' }}
          onClick={dedupeAll}
        >
          {Icons.refresh} Dedupe
        </button>
        <span style={{ fontSize: '11px', color: C.textM, fontFamily: SH.fm, flexShrink: 0 }}>
          {data.lemmaMaster.length} entries
        </span>
      </div>

      {/* Column headers (desktop grid only — mobile cards don't have columns) */}
      {!isMobile && (
      <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr 1fr 88px', background: C.raised, border: `1px solid ${C.border}`, borderRadius: '6px 6px 0 0', marginBottom: '2px', flexShrink: 0 }}>
        {['Lemma / Relations', 'Definition 1', 'Definition 2', ''].map((h, i) => (
          <div key={i} style={{ padding: '5px 14px', fontSize: '10px', fontWeight: 700, color: C.textM, letterSpacing: '0.07em', textTransform: 'uppercase' }}>{h}</div>
        ))}
      </div>
      )}

      {/* Scrollable card list */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', paddingRight: '2px' }}>
        {filtered.length === 0 && (
          <div style={{ padding: '24px', textAlign: 'center', color: C.textM, fontSize: '13px' }}>No lemmas found.</div>
        )}
        {filteredPage.map(l => (
          <LemmaCard
                      key={l.lemmaID}
                      l={l}
                      lemmaMaster={data.lemmaMaster}
                      lemmaSourcesMap={lemmaSourcesMap}
                      fetching={fetching}
                      onSave={handleCardSave}
                      onRefetchDef1={refetchDef1}
                      onDelete={deleteLemma}
                      onLemmaClick={(term) => setLemmaPopup(term)}
                      wordInputs={data.wordInputs}
                      sentenceInputs={data.sentenceInputs}
                      onMerge={handleMerge}
                      editingLemmaID={editingLemmaID}
                      setEditingLemmaID={setEditingLemmaID}
                      C={C}
                    />
        ))}
      </div>

      {/* Pagination */}
      <PaginationFooter
        page={page}
        totalPages={totalPages}
        count={filtered.length}
        onFirst={() => { setLmPage(0); scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); }}
        onPrev={() => { setLmPage(p => Math.max(0, p - 1)); scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); }}
        onNext={() => { setLmPage(p => Math.min(totalPages - 1, p + 1)); scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); }}
        onLast={() => { setLmPage(totalPages - 1); scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); }}
        C={C}
      />

      {/* MiniSearchPopup */}
      {lemmaPopup && (
        <MiniSearchPopup
          initialQuery={lemmaPopup}
          data={data}
          updateData={updateData}
          onClose={() => setLemmaPopup(null)}
          C={C}
          S={S}
          showAVIToast={showAVIToast}
        />
      )}
    </div>
  );
}

