// src/components/avi/AVIMiniSearchPopup.jsx
// Compact modal similarity search — shared by LemmaMasterPage and WordInputPage.
// AS2: runs on the same engine and hook as the Search tab (useLemmaSearch),
// so results, "Did you mean", the hidden group and English paging match.
// AS3: clicking a result's lemma re-centers the popup on it, with Back.
// AS4: initialLemmaID anchors on an exact entry (Lemma Master pills and
// buttons pass it); onOpenInSearch adds an "Open in Search tab" link.
// Opens pre-populated with initialQuery and auto-runs the search on mount.
// AS5b: a Korean search with no match offers "Look up definition" and, when
// the host passes `staging` (its source context and card plumbing), "Add to
// Word Input"; a staged word re-centers the popup on its lemma.

import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAppTheme } from '../../hooks/useAppTheme.js';
import {
  useLemmaSearch, SUGGESTION_KIND_LABEL, rowTag, statusLabel,
} from '../../hooks/useLemmaSearch.js';
import { SH } from '../../theme/buildStyles.js';
import { Icons } from '../Icons.jsx';
import { applyRelationPin, applyRelationConnect } from '../../utils/aviUtils.js';
import { AVINoMatchActions } from './AVIAddToWordInput.jsx';

const isMobile = typeof window !== 'undefined' && (window.innerWidth <= 700 || window.matchMedia('(hover: none) and (pointer: coarse) and (orientation: portrait)').matches);

export function AVIMiniSearchPopup({ initialQuery, initialLemmaID, data, updateData, onClose, onOpenInSearch, showAVIToast, staging }) {
  const { C, S } = useAppTheme();
  const search = useLemmaSearch(data);
  const { mode, status, anchor, related, english, run, searchById, back } = search;

  const [query,      setQuery]      = useState(initialQuery || '');
  const [basket,     setBasket]     = useState([]);
  const [relType,    setRelType]    = useState('Form');
  const [connected,  setConnected]  = useState(false);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [pivotTo,    setPivotTo]    = useState(null);   // AS5b: staged lemma, anchored once indexed
  const [stagedNote, setStagedNote] = useState(null);

  // A new anchor replaces the previous basket center; picks stay (AS-D12).
  const setCenter = useCallback((ref) => {
    if (!ref) return;
    setBasket(prev => [
      { lemmaID: ref.lemmaID, lemma: ref.lemma, isCenter: true },
      ...prev.filter(b => !b.isCenter && b.lemmaID !== ref.lemmaID),
    ]);
  }, []);

  const runSearch = useCallback(async (q = query) => {
    const raw = String(q || '').trim();
    if (!raw) return;
    setQuery(raw);
    setHiddenOpen(false);
    setStagedNote(null);
    setCenter(await run(raw));
  }, [query, run, setCenter]);

  // A "Did you mean" pick, a clicked result (pivot), or Back.
  const anchorOn = (ref) => {
    if (!ref) return;
    setQuery(ref.lemma);
    setHiddenOpen(false);
    setStagedNote(n => (n && n.lemmaID === ref.lemmaID ? n : null));
    setCenter(ref);
  };
  const pickLemma = (lemmaID) => anchorOn(searchById(lemmaID));
  const goBack    = () => anchorOn(back());

  // A newly created lemma reaches the index on the next render.
  useEffect(() => {
    if (pivotTo && search.index.byId.has(pivotTo)) {
      setPivotTo(null);
      pickLemma(pivotTo);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pivotTo, search.index]);
  const onStaged = ({ lemmaID, row, isNewLemma, dest }) => {
    setStagedNote({ lemmaID, surface: row.input, dest, isNewLemma });
    if (lemmaID) setPivotTo(lemmaID);
  };

  // Auto-run on mount: anchor on the exact entry when an ID is given (falls
  // back to a text search if that entry no longer exists).
  useEffect(() => {
    const ref = initialLemmaID ? searchById(initialLemmaID) : null;
    if (ref) anchorOn(ref);
    else if (initialQuery) runSearch(initialQuery);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Pin / hide (bidirectional) ───────────────────────────────
  // Rows are derived from the live Lemma Master; they re-sort on the next render.
  const handlePin = (lemmaID, type, val) => {
    if (!anchor?.lemmaID) return;
    updateData(prev => applyRelationPin(prev, anchor.lemmaID, lemmaID, type, val, showAVIToast));
  };

  // ── Basket ───────────────────────────────────────────────────
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
    setConnected(true);
    setTimeout(() => { setConnected(false); setBasket([]); }, 2500);
  };

  // ── Derived view ─────────────────────────────────────────────
  const canPin        = mode === 'ko' && !!anchor && !!related?.anchor;
  const pinnedRows    = canPin ? related.pinned     : [];
  const candidateRows = canPin ? related.candidates : [];
  const hiddenRows    = canPin ? related.hidden     : [];
  const englishRows   = mode === 'en' && english ? english.results : [];
  const mainRows      = mode === 'en' ? englishRows : [...pinnedRows, ...candidateRows];
  const awaitingPick  = mode === 'ko' && !anchor && (status === 'pending' || status === 'none');
  const columns       = ['Lemma', 'Def 2', 'Tag', ...(canPin ? ['Pin Form', 'Pin Meaning', 'Hide'] : []), '+ Basket'];

  const thS = {
    padding: '5px 8px', fontSize: '10px', fontWeight: 700,
    letterSpacing: '0.07em', textTransform: 'uppercase', color: C.textM,
    borderBottom: `1px solid ${C.border}`, textAlign: 'left', whiteSpace: 'nowrap',
    position: 'sticky', top: 0, background: C.raised, zIndex: 1,
  };
  const tdS = {
    padding: '5px 8px', fontSize: '12px', color: C.text,
    borderBottom: `1px solid ${C.border}`, verticalAlign: 'top',
  };

  const renderRow = (r) => {
    const inBasket = basket.some(b => b.lemmaID === r.lemmaID);
    const def2 = r.ref?.def2 || '';
    return (
      <tr key={r.lemmaID} style={{ background: r.hide ? `${C.textM}10` : (r.pinForm || r.pinMeaning) ? `${C.accent}06` : 'transparent', opacity: r.hide ? 0.6 : 1 }}>
        <td style={tdS}>
          <button onClick={() => pickLemma(r.lemmaID)} title={`Search ${r.lemma}`} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', fontFamily: SH.fk, color: C.accent, fontWeight: 600, fontSize: 'inherit' }}>{r.lemma}</button>
        </td>
        <td style={{ ...tdS, maxWidth: '160px', color: def2 ? C.text : C.textM }}>{def2 || '—'}</td>
        <td style={tdS}><span style={{ fontSize: '10px', background: C.raised, borderRadius: '4px', padding: '1px 5px', color: C.textM, fontFamily: SH.fm }}>{rowTag(r) || '—'}</span></td>
        {canPin && (<>
        <td style={{ ...tdS, textAlign: 'center' }}><input type="checkbox" checked={!!r.pinForm}    onChange={e => handlePin(r.lemmaID, 'pinForm',    e.target.checked)} style={{ accentColor: C.accent, cursor: 'pointer' }} /></td>
        <td style={{ ...tdS, textAlign: 'center' }}><input type="checkbox" checked={!!r.pinMeaning} onChange={e => handlePin(r.lemmaID, 'pinMeaning', e.target.checked)} style={{ accentColor: C.accent, cursor: 'pointer' }} /></td>
        <td style={{ ...tdS, textAlign: 'center' }}><input type="checkbox" checked={!!r.hide}       onChange={e => handlePin(r.lemmaID, 'hide',       e.target.checked)} style={{ accentColor: C.accent, cursor: 'pointer' }} /></td>
        </>)}
        <td style={{ ...tdS, textAlign: 'center' }}>
          <button onClick={() => toggleBasket(r.lemmaID, r.lemma)} style={{ background: inBasket ? C.accent : C.raised, color: inBasket ? '#fff' : C.textM, border: `1px solid ${inBasket ? C.accent : C.border}`, borderRadius: '4px', padding: '1px 8px', fontSize: '11px', cursor: 'pointer', fontWeight: 600 }}>
            {inBasket ? '✓' : '+'}
          </button>
        </td>
      </tr>
    );
  };

  return createPortal(
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div
        style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: '12px', padding: '20px', width: 'min(94vw, 700px)', maxHeight: '82vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 40px rgba(0,0,0,0.5)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Search bar */}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px', flexShrink: 0 }}>
          {search.canBack && (
            <button onClick={goBack} title="Back" style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', borderRadius: '6px', border: `1px solid ${C.border}`, background: C.raised, color: C.text, cursor: 'pointer' }}>
              {Icons.chevronLeft}
            </button>
          )}
          {mode && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
              {mode === 'ko' && anchor && <span style={{ fontFamily: SH.fk, fontSize: '15px', fontWeight: 700, color: C.accent }}>{anchor.lemma}</span>}
              <span style={{ fontSize: '10px', background: C.raised, border: `1px solid ${C.border}`, borderRadius: '4px', padding: '1px 6px', color: C.textM, fontFamily: SH.fm }}>{statusLabel(search)}</span>
            </div>
          )}
          <input
            style={{ flex: 1, minWidth: 0, padding: '7px 10px', borderRadius: '8px', border: `1px solid ${C.border}`, background: C.bg, color: C.text, fontSize: isMobile ? '16px' : '13px', fontFamily: SH.fk, outline: 'none' }}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.nativeEvent.isComposing && runSearch()}
            placeholder="Korean or English…"
          />
          <button onClick={() => runSearch()} style={{ ...S.btnPrimary, ...S.btnMetallic, padding: '7px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 600, flexShrink: 0 }}>Search</button>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.textM, fontSize: '18px', cursor: 'pointer', lineHeight: 1, padding: '0 2px' }}>✕</button>
        </div>

        {/* Open the current search in the full Search tab (AS-D24) */}
        {onOpenInSearch && mode && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '-6px', marginBottom: '8px', flexShrink: 0 }}>
            <button
              onClick={() => onOpenInSearch(mode === 'ko' && anchor ? anchor.lemma : search.query)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', background: 'none', border: 'none', color: C.accent, cursor: 'pointer', fontSize: '12px', padding: 0 }}
            >
              Open in Search tab {Icons.chevronRight}
            </button>
          </div>
        )}

        {/* Did you mean (AS-D11) */}
        {awaitingPick && (
          <div style={{ marginBottom: '10px', flexShrink: 0, fontSize: '12px', color: C.text }}>
            <div style={{ marginBottom: search.suggestions.length ? '6px' : 0 }}>
              No exact match for <span style={{ fontFamily: SH.fk, fontWeight: 700 }}>{search.query}</span>.
              {status === 'pending' && <span style={{ color: C.textM }}> Checking the dictionary…</span>}
              {search.suggestions.length > 0 && ' Did you mean:'}
              {status === 'none' && search.suggestions.length === 0 && <span style={{ color: C.textM }}> Nothing similar in your Lemma Master.</span>}
            </div>
            {search.suggestions.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {search.suggestions.map(s => (
                  <button key={s.lemmaID} onClick={() => pickLemma(s.lemmaID)} style={{ display: 'inline-flex', alignItems: 'baseline', gap: '6px', padding: '4px 9px', borderRadius: '14px', border: `1px solid ${C.border}`, background: C.raised, color: C.text, cursor: 'pointer' }}>
                    <span style={{ fontFamily: SH.fk, fontSize: '12px', fontWeight: 600, color: C.accent }}>{s.lemma}</span>
                    <span style={{ fontSize: '10px', color: C.textM }}>{SUGGESTION_KIND_LABEL[s.kind]}</span>
                  </button>
                ))}
              </div>
            )}
            {/* AS5b (AS-D27): once the dictionary check has come back empty */}
            {status === 'none' && (
              <AVINoMatchActions
                key={search.query}
                query={search.query}
                data={data}
                updateData={updateData}
                staging={staging}
                showAVIToast={showAVIToast}
                onStaged={onStaged}
                onPickLemma={pickLemma}
                compact
              />
            )}
          </div>
        )}

        {mode === 'ko' && anchor && stagedNote && stagedNote.lemmaID === anchor.lemmaID && (
          <div style={{ marginBottom: '8px', flexShrink: 0, padding: '6px 10px', borderRadius: '8px', border: `1px solid ${C.success}`, background: `${C.success}12`, fontSize: '12px', color: C.text }}>
            Added <span style={{ fontFamily: SH.fk, fontWeight: 700 }}>{stagedNote.surface}</span> to Word Input · {stagedNote.dest}.
            {stagedNote.isNewLemma && <span style={{ color: C.textM }}> New Lemma Master entry.</span>}
          </div>
        )}

        {/* Resolved def */}
        {mode === 'ko' && anchor && (anchor.def2 || anchor.def1) && (
          <div style={{ marginBottom: '10px', flexShrink: 0, fontSize: '12px' }}>
            {anchor.def2 && <div style={{ color: C.text, marginBottom: '2px' }}><span style={{ color: C.textM, fontSize: '11px', marginRight: '6px' }}>Def2:</span>{anchor.def2}</div>}
            {anchor.def1 && <div style={{ color: C.textM }}><span style={{ fontSize: '11px', marginRight: '6px' }}>Def1:</span>{anchor.def1.split('\n')[0]}</div>}
          </div>
        )}

        {/* Results table */}
        <div style={{ flex: 1, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: '8px' }}>
          {((canPin && mainRows.length === 0 && hiddenRows.length === 0) || (mode === 'en' && english && english.total === 0)) && (
            <div style={{ padding: '20px', textAlign: 'center', color: C.textM, fontSize: '13px' }}>
              {mode === 'en' ? 'No matches in your definitions.' : 'No related lemmas found.'}
            </div>
          )}
          {mainRows.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr>
                  {columns.map(h => (
                    <th key={h} style={thS}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {mainRows.map(renderRow)}
              </tbody>
            </table>
          )}
          {mode === 'en' && english && englishRows.length < english.total && (
            <div style={{ textAlign: 'center', padding: '10px' }}>
              <button onClick={search.showMore} style={{ padding: '5px 14px', borderRadius: '6px', background: C.raised, border: `1px solid ${C.border}`, color: C.text, cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>
                Show more ({english.total - englishRows.length} more)
              </button>
            </div>
          )}
          {canPin && hiddenRows.length > 0 && (
            <div style={{ padding: '8px' }}>
              <button onClick={() => setHiddenOpen(v => !v)} style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: '6px', color: C.textM, cursor: 'pointer', fontSize: '11px', padding: '3px 10px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Hidden</span>
                <span style={{ background: C.raised, borderRadius: '10px', padding: '1px 6px', fontFamily: SH.fm }}>{hiddenRows.length}</span>
                <span style={{ fontSize: '10px' }}>{hiddenOpen ? '▲' : '▼'}</span>
              </button>
              {hiddenOpen && (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', marginTop: '6px' }}>
                  <tbody>{hiddenRows.map(renderRow)}</tbody>
                </table>
              )}
            </div>
          )}
        </div>

        {/* Basket */}
        {basket.length >= 2 && (
          <div style={{ marginTop: '10px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '8px 10px', background: C.raised, borderRadius: '8px', border: `1px solid ${C.border}` }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: C.text, flexShrink: 0 }}>Connect:</span>
            {basket.map(b => (
              <span key={b.lemmaID} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', background: C.accentSoft, border: `1px solid ${C.accent}44`, borderRadius: '12px', padding: '2px 8px', fontSize: '12px', color: C.accent, fontFamily: SH.fk }}>
                {b.lemma}
                <button onClick={() => toggleBasket(b.lemmaID, b.lemma)} title="Remove from basket" style={{ background: 'none', border: 'none', color: C.accent, cursor: 'pointer', fontSize: '11px', lineHeight: 1, padding: '0 1px' }}>✕</button>
              </span>
            ))}
            <div style={{ display: 'flex', gap: '4px', marginLeft: 'auto' }}>
              {['Form', 'Meaning', 'Both'].map(t => (
                <button key={t} onClick={() => setRelType(t)} style={{ background: relType === t ? C.accent : C.surface, color: relType === t ? '#fff' : C.text, border: `1px solid ${relType === t ? C.accent : C.border}`, borderRadius: '5px', padding: '2px 8px', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}>{t}</button>
              ))}
              {connected
                ? <span style={{ background: C.success, color: '#fff', borderRadius: '6px', padding: '3px 12px', fontSize: '12px', fontWeight: 700 }}>✓ Connected</span>
                : <button onClick={connectBasket} style={{ ...S.btnPrimary, ...S.btnMetallic, borderRadius: '6px', padding: '3px 12px', fontSize: '12px', fontWeight: 700, marginLeft: '4px' }}>Connect All</button>
              }
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
