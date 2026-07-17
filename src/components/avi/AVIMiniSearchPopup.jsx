// src/components/avi/AVIMiniSearchPopup.jsx
// Compact modal similarity search — shared by LemmaMasterPage and WordInputPage.
// Uses the same resolution and scoring logic as AVISearchPage.
// Opens pre-populated with initialQuery and auto-runs the search on mount.

import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAppTheme } from '../../hooks/useAppTheme.js';
import { SH } from '../../theme/buildStyles.js';
import { Def1Display } from './Def1Display.jsx';
import {
  normalizeLemma, hangulToJamo, editDistance,
  tokenizeEnglish, DEFAULT_STOPWORDS, detectMode,
  applyRelationPin, applyRelationConnect,
} from '../../utils/aviUtils.js';

export function AVIMiniSearchPopup({ initialQuery, data, updateData, onClose, showAVIToast }) {
  const { C, S } = useAppTheme();

  const [query,        setQuery]        = useState(initialQuery || '');
  const [resolved,     setResolved]     = useState(null);
  const [nearOptions,  setNearOptions]  = useState([]);
  const [results,      setResults]      = useState([]);
  const [status,       setStatus]       = useState('');
  const [basket,       setBasket]       = useState([]);
  const [relType,      setRelType]      = useState('Form');
  const [connected,    setConnected]    = useState(false);

  // Auto-run on mount
  useEffect(() => {
    if (initialQuery) runSearch(initialQuery);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function sortResults(list) {
    return [...list].sort((a, b) => {
      if ((a.pinForm || a.pinMeaning) && !(b.pinForm || b.pinMeaning)) return -1;
      if (!(a.pinForm || a.pinMeaning) && (b.pinForm || b.pinMeaning)) return 1;
      if (a.hide && !b.hide) return 1;
      if (!a.hide && b.hide) return -1;
      return 0;
    });
  }

  const runSearch = useCallback((q = query) => {
    const raw = (q || '').trim();
    if (!raw) return;
    setQuery(raw);
    setStatus('');
    setResults([]);
    setResolved(null);
    setNearOptions([]);

    const mode = detectMode(raw);

    if (mode === 'Korean') {
      const normQ = normalizeLemma(raw);
      let resolvedEntry = null;
      let stat = '';

      // 1. Verbatim match — raw input exactly matches a lemma
      resolvedEntry = data.lemmaMaster.find(l => l.lemma === raw);
      if (resolvedEntry) stat = 'Exact';

      // 2. Normalized exact match
      if (!resolvedEntry) {
        resolvedEntry = data.lemmaMaster.find(l => normalizeLemma(l.lemma) === normQ);
        if (resolvedEntry) stat = 'Exact';
      }

      // Collect other matches — always, regardless of resolution above.
      const otherMatches = [];
      const seen = new Set(resolvedEntry ? [resolvedEntry.lemmaID] : []);

      const addOther = (entry) => {
        if (!seen.has(entry.lemmaID)) { seen.add(entry.lemmaID); otherMatches.push(entry); }
      };

      // Prefix candidates
      const prefixMatches = data.lemmaMaster
        .filter(l => normalizeLemma(l.lemma).startsWith(normQ))
        .sort((a, b) => a.lemma.length - b.lemma.length);
      if (!resolvedEntry && prefixMatches.length > 0) {
        resolvedEntry = prefixMatches[0];
        stat = 'Prefix';
        seen.add(resolvedEntry.lemmaID);
        prefixMatches.slice(1).forEach(addOther);
      } else {
        prefixMatches.forEach(addOther);
      }

      // Contains candidates
      const containsMatches = data.lemmaMaster
        .filter(l => normalizeLemma(l.lemma).includes(normQ))
        .sort((a, b) => a.lemma.length - b.lemma.length);
      if (!resolvedEntry && containsMatches.length > 0) {
        resolvedEntry = containsMatches[0];
        stat = 'Contains';
        seen.add(resolvedEntry.lemmaID);
        containsMatches.slice(1).forEach(addOther);
      } else {
        containsMatches.forEach(addOther);
      }

      // Jamo near-match (threshold scales with length)
      const maxDist = normQ.length <= 2 ? 1 : normQ.length <= 4 ? 2 : 3;
      const jamoQ = hangulToJamo(normQ);
      const nearMatches = data.lemmaMaster
        .map(l => ({ l, d: editDistance(jamoQ, hangulToJamo(normalizeLemma(l.lemma)), maxDist) }))
        .filter(x => x.d <= maxDist)
        .sort((a, b) => a.d - b.d);
      if (!resolvedEntry && nearMatches.length > 0) {
        resolvedEntry = nearMatches[0].l;
        stat = `Near (d=${nearMatches[0].d})`;
        seen.add(resolvedEntry.lemmaID);
        nearMatches.slice(1).forEach(x => addOther(x.l));
      } else {
        nearMatches.forEach(x => addOther(x.l));
      }

      setNearOptions(otherMatches.slice(0, 6));

      if (!resolvedEntry) { setStatus('No match'); return; }
      setStatus(stat);
      setResolved({
        resolvedLemma: resolvedEntry.lemma,
        def1: resolvedEntry.def1,
        def2: resolvedEntry.def2,
        lemmaID: resolvedEntry.lemmaID,
      });

      // Auto-add to basket as center
      setBasket(prev => {
        if (prev.some(b => b.lemmaID === resolvedEntry.lemmaID)) return prev;
        return [{ lemmaID: resolvedEntry.lemmaID, lemma: resolvedEntry.lemma, isCenter: true }, ...prev];
      });

      // Score related lemmas
      const resolvedDefTokens = tokenizeEnglish(
        (resolvedEntry.def1 || '') + ' ' + (resolvedEntry.def2 || ''),
        DEFAULT_STOPWORDS
      );

      const scored = data.lemmaMaster
        .filter(l => l.lemmaID !== resolvedEntry.lemmaID)
        .map(l => {
          const normL   = normalizeLemma(l.lemma);
          const jamoL   = hangulToJamo(normL);
          const dist    = editDistance(jamoQ, jamoL, 8);
          const forceInclude = normL.startsWith(normQ) || normL.includes(normQ) ||
            normQ.startsWith(normL) || (normL.length > 1 && normQ.includes(normL));
          const sharedKorean = [...normQ].filter(ch => normL.includes(ch) && /[가-힣]/.test(ch)).length;
          const lemmaDefTokens = tokenizeEnglish((l.def1 || '') + ' ' + (l.def2 || ''), DEFAULT_STOPWORDS);
          const defOverlap = resolvedDefTokens.filter(t => lemmaDefTokens.includes(t)).length;

          let score = 0;
          if (forceInclude)                        score += 12;
          score += sharedKorean * 2;
          score += defOverlap * 3;
          if (dist <= 2)                           score += (3 - dist);

          const relFormIds    = (resolvedEntry.relatedForm    || '').split(',').map(s => s.trim()).filter(Boolean);
          const relMeaningIds = (resolvedEntry.relatedMeaning || '').split(',').map(s => s.trim()).filter(Boolean);
          const hiddenIds     = (resolvedEntry.hiddenRelated  || '').split(',').map(s => s.trim()).filter(Boolean);
          const pinForm    = relFormIds.includes(l.lemmaID);
          const pinMeaning = relMeaningIds.includes(l.lemmaID);
          const hide       = hiddenIds.includes(l.lemmaID);

          let tag = '';
          if (forceInclude)     tag = 'contains';
          else if (dist <= 2)   tag = 'near';
          else if (defOverlap)  tag = 'meaning';
          else if (sharedKorean >= 2) tag = 'shared';
          if (pinForm)    tag = 'form';
          if (pinMeaning) tag = 'meaning';

          return { ...l, score, pinForm, pinMeaning, hide, tag };
        })
        .filter(l => l.score >= 2 || l.pinForm || l.pinMeaning || l.hide);

      // Pinned connections are never capped — only the discovery pool is.
      const pinned = scored.filter(l => l.pinForm || l.pinMeaning);
      const rest = scored
        .filter(l => !(l.pinForm || l.pinMeaning))
        .sort((a, b) => b.score - a.score)
        .slice(0, 30);

      setResults(sortResults([...pinned, ...rest]));

    } else {
      // English
      const qTokens = tokenizeEnglish(raw, DEFAULT_STOPWORDS);
      if (!qTokens.length) { setStatus('No match'); return; }
      const scored = data.lemmaMaster.map(l => {
        const defTokens = tokenizeEnglish((l.def1 || '') + ' ' + (l.def2 || ''), DEFAULT_STOPWORDS);
        const shared = qTokens.filter(t => defTokens.includes(t)).length;
        if (!shared) return null;
        return { ...l, score: shared, pinForm: false, pinMeaning: false, hide: false, tag: 'en' };
      }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 20);
      if (!scored.length) { setStatus('No match'); return; }
      setStatus(`${scored.length} matches`);
      setResults(scored);
    }
  }, [query, data]);

  // ── Pin / hide (bidirectional) ───────────────────────────────
  const handlePin = (lemmaID, type, val) => {
    if (!resolved?.lemmaID) return;
    updateData(prev => applyRelationPin(prev, resolved.lemmaID, lemmaID, type, val, showAVIToast));
    setResults(prev => sortResults(prev.map(r =>
      r.lemmaID !== lemmaID ? r : {
        ...r,
        pinForm:    type === 'pinForm'    ? val : r.pinForm,
        pinMeaning: type === 'pinMeaning' ? val : r.pinMeaning,
        hide:       type === 'hide'       ? val
                  : ((type === 'pinForm' || type === 'pinMeaning') && val) ? false
                  : r.hide,
      }
    )));
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
          {resolved && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
              <span style={{ fontFamily: SH.fk, fontSize: '15px', fontWeight: 700, color: C.accent }}>{resolved.resolvedLemma}</span>
              <span style={{ fontSize: '10px', background: C.raised, border: `1px solid ${C.border}`, borderRadius: '4px', padding: '1px 6px', color: C.textM, fontFamily: SH.fm }}>{status}</span>
              {nearOptions.length > 0 && (
                <select
                  style={{ fontSize: '12px', fontFamily: SH.fk, background: C.bg, border: `1px solid ${C.border}`, borderRadius: '6px', padding: '3px 6px', color: C.text, outline: 'none', cursor: 'pointer' }}
                  value=""
                  onChange={e => { if (e.target.value) runSearch(e.target.value); }}
                >
                  <option value="" disabled>Other matches</option>
                  {nearOptions.map(opt => <option key={opt.lemmaID} value={opt.lemma}>{opt.lemma}</option>)}
                </select>
              )}
            </div>
          )}
          <input
            style={{ flex: 1, padding: '7px 10px', borderRadius: '8px', border: `1px solid ${C.border}`, background: C.bg, color: C.text, fontSize: '13px', fontFamily: SH.fk, outline: 'none' }}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && runSearch()}
            placeholder="Korean or English…"
          />
          : <button onClick={connectBasket} style={{ background: C.accent, color: '#fff', border: 'none', borderRadius: '6px', padding: '3px 12px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', marginLeft: '4px' }}>Connect All</button>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.textM, fontSize: '18px', cursor: 'pointer', lineHeight: 1, padding: '0 2px' }}>✕</button>
        </div>

        {/* Resolved def */}
        {resolved && (resolved.def2 || resolved.def1) && (
          <div style={{ marginBottom: '10px', flexShrink: 0, fontSize: '12px' }}>
            {resolved.def2 && <div style={{ color: C.text, marginBottom: '2px' }}><span style={{ color: C.textM, fontSize: '11px', marginRight: '6px' }}>Def2:</span>{resolved.def2}</div>}
            {resolved.def1 && <div style={{ color: C.textM }}><span style={{ fontSize: '11px', marginRight: '6px' }}>Def1:</span>{resolved.def1.split('\n')[0]}</div>}
          </div>
        )}

        {/* Results table */}
        <div style={{ flex: 1, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: '8px' }}>
          {status === 'No match' && (
            <div style={{ padding: '20px', textAlign: 'center', color: C.textM, fontSize: '13px' }}>No related lemmas found.</div>
          )}
          {results.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr>
                  {['Lemma', 'Def 2', 'Tag', 'Pin Form', 'Pin Meaning', 'Hide', '+ Basket'].map(h => (
                    <th key={h} style={thS}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {results.map(r => {
                  const inBasket = basket.some(b => b.lemmaID === r.lemmaID);
                  return (
                    <tr key={r.lemmaID} style={{ background: r.hide ? `${C.textM}10` : (r.pinForm || r.pinMeaning) ? `${C.accent}06` : 'transparent', opacity: r.hide ? 0.6 : 1 }}>
                      <td style={tdS}><span style={{ fontFamily: SH.fk, color: C.accent, fontWeight: 600 }}>{r.lemma}</span></td>
                      <td style={{ ...tdS, maxWidth: '160px', color: C.textM }}>{r.def2 || '—'}</td>
                      <td style={tdS}><span style={{ fontSize: '10px', background: C.raised, borderRadius: '4px', padding: '1px 5px', color: C.textM, fontFamily: SH.fm }}>{r.tag || '—'}</span></td>
                      <td style={{ ...tdS, textAlign: 'center' }}><input type="checkbox" checked={!!r.pinForm}    onChange={e => handlePin(r.lemmaID, 'pinForm',    e.target.checked)} style={{ accentColor: C.accent, cursor: 'pointer' }} /></td>
                      <td style={{ ...tdS, textAlign: 'center' }}><input type="checkbox" checked={!!r.pinMeaning} onChange={e => handlePin(r.lemmaID, 'pinMeaning', e.target.checked)} style={{ accentColor: C.accent, cursor: 'pointer' }} /></td>
                      <td style={{ ...tdS, textAlign: 'center' }}><input type="checkbox" checked={!!r.hide}       onChange={e => handlePin(r.lemmaID, 'hide',       e.target.checked)} style={{ accentColor: C.accent, cursor: 'pointer' }} /></td>
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
          )}
        </div>

        {/* Basket */}
        {basket.length >= 2 && (
          <div style={{ marginTop: '10px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '8px 10px', background: C.raised, borderRadius: '8px', border: `1px solid ${C.border}` }}>
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
