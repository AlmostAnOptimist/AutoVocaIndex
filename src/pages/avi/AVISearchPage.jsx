// src/pages/avi/AVISearchPage.jsx
// AVI Search tab — similarity search, pin/hide, connection basket, connect list.
// Kink #12: Connect List auto-populates with the currently resolved lemma.
// pendingQuery ref: when goToSearch(query) is called from another tab,
// the search runs automatically on mount.

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useAppTheme } from '../../hooks/useAppTheme.js';
import { SH } from '../../theme/buildStyles.js';
import { Def1Display } from '../../components/avi/Def1Display.jsx';
import { Icons } from '../../components/Icons.jsx';
import {
  normalizeLemma, hangulToJamo, editDistance,
  stripKoreanAffixes, tokenizeEnglish, DEFAULT_STOPWORDS, detectMode,
  applyRelationPin, applyRelationConnect,
} from '../../utils/aviUtils.js';

const isMobile = typeof window !== 'undefined' && window.innerWidth <= 700;

// ── ConnectListModal ─────────────────────────────────────────
// Paste a list of words, resolve to lemmas, connect them all.
// initialWord pre-populates the textarea.
function ConnectListModal({ data, updateData, initialWord, onClose, C, S, showAVIToast }) {
  const [raw,       setRaw]       = useState(() => initialWord ? initialWord + '\n' : '');
  const [resolved,  setResolved]  = useState([]); // { input, lemma, found }
  const [relType,   setRelType]   = useState('Form');
  const [connected, setConnected] = useState(false);

  const resolveAll = () => {
    const lines = raw.split(/[\n,]+/).map(l => l.trim()).filter(Boolean);
    const results = lines.map(input => {
      const normIn = normalizeLemma(input);
      // Exact match
      let match = data.lemmaMaster.find(l => normalizeLemma(l.lemma) === normIn);
      // Word input fallback
      if (!match) {
        const wi = data.wordInputs.find(w => w.input === input || normalizeLemma(w.lemma) === normIn);
        if (wi) match = data.lemmaMaster.find(l => normalizeLemma(l.lemma) === normalizeLemma(wi.lemma));
      }
      // Prefix
      if (!match) match = data.lemmaMaster.find(l => normalizeLemma(l.lemma).startsWith(normIn));
      // Contains
      if (!match) match = data.lemmaMaster.find(l => normalizeLemma(l.lemma).includes(normIn));
      // Jamo edit distance
      if (!match) {
        const jamoIn = hangulToJamo(normIn);
        const candidate = data.lemmaMaster
          .map(l => ({ l, d: editDistance(jamoIn, hangulToJamo(normalizeLemma(l.lemma)), 2) }))
          .filter(x => x.d <= 2)
          .sort((a, b) => a.d - b.d)[0];
        if (candidate) match = candidate.l;
      }
      return { input, lemma: match?.lemma || input, lemmaID: match?.lemmaID || null, found: !!match };
    });
    setResolved(results);
  };

  const connectAll = () => {
    const items = resolved.filter(r => r.lemmaID);
    if (items.length < 2) return;
    updateData(prev => applyRelationConnect(prev, items.map(r => r.lemmaID), relType, showAVIToast));
    setConnected(true);
    setTimeout(() => { setConnected(false); setResolved([]); setRaw(''); onClose(); }, 2000);
  };

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: '12px', padding: '24px', width: 'min(92vw, 520px)', maxHeight: '80vh', overflowY: 'auto', boxShadow: '0 8px 40px rgba(0,0,0,0.5)' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
          <span style={{ fontFamily: SH.fd, fontWeight: 700, fontSize: '14px', color: C.text }}>Connect List</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.textM, fontSize: '18px', cursor: 'pointer' }}>✕</button>
        </div>
        <div style={{ fontSize: '12px', color: C.textM, marginBottom: '10px' }}>
          Enter one word per line (or comma-separated). Each will be resolved to its lemma, then all pairs connected.
        </div>
        <textarea
          style={{ width: '100%', minHeight: '120px', padding: '8px 10px', borderRadius: '6px', border: `1px solid ${C.border}`, background: C.bg, color: C.text, fontSize: '13px', fontFamily: SH.fk, outline: 'none', resize: 'vertical', boxSizing: 'border-box', lineHeight: 1.6 }}
          placeholder="가리다&#10;가르다&#10;가르치다"
          value={raw}
          onChange={e => setRaw(e.target.value)}
        />

        {/* Relationship type */}
        <div style={{ display: 'flex', gap: '6px', margin: '10px 0' }}>
          {['Form', 'Meaning', 'Both'].map(t => (
            <button key={t} onClick={() => setRelType(t)} style={{ padding: '4px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 600, border: `1px solid ${relType === t ? C.accent : C.border}`, background: relType === t ? C.accentSoft : 'transparent', color: relType === t ? C.accent : C.textS, cursor: 'pointer' }}>{t}</button>
          ))}
          <button onClick={resolveAll} style={{ marginLeft: 'auto', padding: '4px 14px', borderRadius: '6px', fontSize: '12px', fontWeight: 600, background: C.raised, border: `1px solid ${C.border}`, color: C.text, cursor: 'pointer' }}>Resolve</button>
        </div>

        {/* Resolved results */}
        {resolved.length > 0 && (
          <div style={{ border: `1px solid ${C.border}`, borderRadius: '8px', overflow: 'hidden', marginBottom: '14px' }}>
            {resolved.map((r, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '7px 12px', borderBottom: i < resolved.length - 1 ? `1px solid ${C.border}` : 'none', background: r.found ? 'transparent' : `${C.danger}08` }}>
                <span style={{ fontFamily: SH.fk, fontSize: '13px', color: C.textM, flexShrink: 0 }}>{r.input}</span>
                <span style={{ color: C.textM, fontSize: '12px' }}>→</span>
                <span style={{ fontFamily: SH.fk, fontSize: '13px', color: r.found ? C.accent : C.danger, fontWeight: r.found ? 600 : 400 }}>{r.lemma}</span>
                {!r.found && <span style={{ fontSize: '10px', color: C.danger, marginLeft: 'auto' }}>not found</span>}
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px' }}>
          {connected ? (
            <div style={{ flex: 1, padding: '10px', borderRadius: '8px', background: C.success, color: '#fff', textAlign: 'center', fontSize: '13px', fontWeight: 600 }}>✓ Connected</div>
          ) : (
            <button
              onClick={connectAll}
              disabled={resolved.filter(r => r.lemmaID).length < 2}
              style={{ ...S.btnPrimary, ...S.btnMetallic, flex: 1, padding: '10px', borderRadius: '8px', fontSize: '13px', fontWeight: 600, opacity: resolved.filter(r => r.lemmaID).length < 2 ? 0.5 : 1 }}
            >
              Connect All as {relType}
            </button>
          )}
          <button onClick={onClose} style={{ padding: '10px 16px', borderRadius: '8px', fontSize: '13px', background: C.raised, border: `1px solid ${C.border}`, color: C.text, cursor: 'pointer' }}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Main page ────────────────────────────────────────────────
export function AVISearchPage({ data, updateData, pendingQuery, showAVIToast }) {
  const { C, S } = useAppTheme();

  const [query,            setQuery]            = useState('');
  const [modeOverride,     setModeOverride]      = useState('Auto');
  const [resolved,         setResolved]          = useState(null);
  const [nearMatchOptions, setNearMatchOptions]  = useState([]);
  const [wordResults,      setWordResults]       = useState([]);
  const [sentenceResults,  setSentenceResults]   = useState([]);
  const [status,           setStatus]            = useState('');
  const [sentExpanded,     setSentExpanded]      = useState(false);
  const [basket,           setBasket]            = useState([]);
  const [basketRelType,    setBasketRelType]      = useState('Form');
  const [basketConnected,  setBasketConnected]   = useState(false);
  const [basketCollapsed,  setBasketCollapsed]   = useState(false);
  const [showConnectList,  setShowConnectList]   = useState(false);

  // Measured height of the resolved-info sticky layer. The table header
  // sticks just below this value instead of covering it, so Def2/Def1
  // stay visible as reference while working through the candidates table.
  // Measured via ResizeObserver rather than hardcoded since Def2 can wrap
  // to different heights depending on window width.
  const [riHeight, setRiHeight] = useState(0);
  const riObserverRef = useRef(null);
  const setRiNode = useCallback((node) => {
    if (riObserverRef.current) { riObserverRef.current.disconnect(); riObserverRef.current = null; }
    if (node) {
      const ro = new ResizeObserver(() => setRiHeight(node.offsetHeight));
      ro.observe(node);
      riObserverRef.current = ro;
      setRiHeight(node.offsetHeight);
    } else {
      setRiHeight(0);
    }
  }, []);
  // ── Auto-run search from pendingQuery (set by goToSearch) ──
  useEffect(() => {
    if (pendingQuery?.current) {
      const q = pendingQuery.current;
      pendingQuery.current = '';
      setQuery(q);
      runSearch(q, 'Auto');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function sortResults(results) {
    return [...results].sort((a, b) => {
      if ((a.pinForm || a.pinMeaning) && !(b.pinForm || b.pinMeaning)) return -1;
      if (!(a.pinForm || a.pinMeaning) && (b.pinForm || b.pinMeaning)) return 1;
      if (a.hide && !b.hide) return 1;
      if (!a.hide && b.hide) return -1;
      return 0;
    });
  }

  const runSearch = useCallback((q = query, mode = modeOverride) => {
    const raw = (q || '').trim();
    if (!raw) return;
    setStatus('');
    setWordResults([]);
    setSentenceResults([]);
    setResolved(null);
    setNearMatchOptions([]);

    const detectedMode = mode === 'Auto' ? detectMode(raw) : mode;

    if (detectedMode === 'Korean') {
      const normQ = normalizeLemma(raw);
      let resolvedEntry = null;
      let stat = '';

      // 1. Verbatim match — raw input exactly matches a lemma (e.g. '분명히' → '분명히')
      resolvedEntry = data.lemmaMaster.find(l => l.lemma === raw);
      if (resolvedEntry) stat = 'Exact';

      // 2. Normalized exact match (e.g. normalized form matches stored lemma)
      if (!resolvedEntry) {
        resolvedEntry = data.lemmaMaster.find(l => normalizeLemma(l.lemma) === normQ);
        if (resolvedEntry) stat = 'Exact';
      }

      // Collect other matches (prefix, contains, near) — always, regardless of resolution above.
      // These populate the "Other matches" dropdown, excluding the resolved entry.
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

      // Jamo near-match — threshold scales with query length to avoid false positives
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

      setNearMatchOptions(otherMatches.slice(0, 6));

      if (!resolvedEntry) { setStatus('No match'); return; }
      setStatus(stat);
      setResolved({
        resolvedLemma: resolvedEntry.lemma,
        def1: resolvedEntry.def1,
        def2: resolvedEntry.def2,
        lemmaID: resolvedEntry.lemmaID,
      });

      // Auto-add resolved lemma to basket as center
      setBasket(prev => {
        if (prev.some(b => b.lemmaID === resolvedEntry.lemmaID)) return prev;
        return [{ lemmaID: resolvedEntry.lemmaID, lemma: resolvedEntry.lemma, isCenter: true }, ...prev];
      });

      // Related lemma scoring — includes prefix/contains and definition overlap
      const resolvedDefTokens = tokenizeEnglish(
        (resolvedEntry.def1 || '') + ' ' + (resolvedEntry.def2 || ''),
        DEFAULT_STOPWORDS
      );

      const results = data.lemmaMaster
        .filter(l => l.lemmaID !== resolvedEntry.lemmaID)
        .map(l => {
          const normL = normalizeLemma(l.lemma);
          const jamoL = hangulToJamo(normL);
          const dist  = editDistance(jamoQ, jamoL, 8);

          // Prefix / contains bonuses
          const queryInLemma  = normL.startsWith(normQ) || normL.includes(normQ);
          const lemmaInQuery  = normQ.startsWith(normL) || (normL.length > 1 && normQ.includes(normL));

          // Shared Korean syllable blocks
          const sharedKorean  = [...normQ].filter(ch => normL.includes(ch) && /[가-힣]/.test(ch)).length;

          // English definition token overlap
          const lemmaDefTokens = tokenizeEnglish((l.def1 || '') + ' ' + (l.def2 || ''), DEFAULT_STOPWORDS);
          const defOverlap = resolvedDefTokens.filter(t => lemmaDefTokens.includes(t)).length;

          // Composite score
          let score = 0;
          // Force-include any lemma that starts with or contains the query syllables
          const forceInclude = normL.startsWith(normQ) || normL.includes(normQ) ||
            normQ.startsWith(normL) || (normL.length > 1 && normQ.includes(normL));
          if (forceInclude) score += 12;
          if (queryInLemma)  score += 0; // already handled above, keep for clarity
          if (lemmaInQuery && normL.length > 1) score += 9;
          score += sharedKorean * 2;
          score += defOverlap * 3;
          if (dist <= 2)     score += (3 - dist);

          const relFormIds    = (resolvedEntry.relatedForm    || '').split(',').map(s => s.trim()).filter(Boolean);
          const relMeaningIds = (resolvedEntry.relatedMeaning || '').split(',').map(s => s.trim()).filter(Boolean);
          const hiddenIds     = (resolvedEntry.hiddenRelated  || '').split(',').map(s => s.trim()).filter(Boolean);
          const pinForm    = relFormIds.includes(l.lemmaID);
          const pinMeaning = relMeaningIds.includes(l.lemmaID);
          const hide       = hiddenIds.includes(l.lemmaID);

          let tag = '';
          if (queryInLemma || lemmaInQuery) tag = 'contains';
          else if (dist <= 2)               tag = 'near';
          else if (defOverlap > 0)          tag = 'meaning';
          else if (sharedKorean >= 2)       tag = 'shared';
          if (pinForm)    tag = 'form';
          if (pinMeaning) tag = 'meaning';

          return { ...l, score, pinForm, pinMeaning, hide, tag };
        })
        .filter(l => l.score >= 2 || l.pinForm || l.pinMeaning || l.hide);

      // Pinned connections are never capped — they only grow over time, and
      // capping them would shrink the discovery pool for exactly the words
      // that have accumulated the most confirmed synonyms. Hidden entries
      // stay ordinary candidates subject to the normal cap, same as always.
      const pinned = results.filter(l => l.pinForm || l.pinMeaning);
      const rest = results
        .filter(l => !(l.pinForm || l.pinMeaning))
        .sort((a, b) => b.score - a.score)
        .slice(0, 40);

      setWordResults(sortResults([...pinned, ...rest]));

      // Matching sentences (deduplicated by sentence text)
      const rawSents = data.sentenceInputs.filter(s =>
        normalizeLemma(s.targetWord) === normQ || s.sentence?.includes(raw)
      );
      const seenSents = new Set();
      setSentenceResults(rawSents.filter(s => {
        if (seenSents.has(s.sentence)) return false;
        seenSents.add(s.sentence);
        return true;
      }));

    } else {
      // English search
      const qTokens = tokenizeEnglish(raw, DEFAULT_STOPWORDS);
      if (!qTokens.length) { setStatus('No match'); return; }

      const results = data.lemmaMaster.map(l => {
        const defTokens = tokenizeEnglish((l.def1 || '') + ' ' + (l.def2 || ''), DEFAULT_STOPWORDS);
        const shared = qTokens.filter(t => defTokens.includes(t)).length;
        if (!shared) return null;
        return { ...l, score: shared, pinForm: false, pinMeaning: false, hide: false, tag: 'en' };
      }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 20);

      if (!results.length) { setStatus('No match'); return; }
      setStatus(`${results.length} matches`);
      setWordResults(results);
    }
  }, [query, modeOverride, data]);

  const handleNearMatchPick = (lemma) => { runSearch(lemma, modeOverride); };

  // ── Pin / hide toggle (bidirectional) ────────────────────────
  const handlePinToggle = (lemmaID, type, val) => {
    if (!resolved?.lemmaID) return;
    updateData(prev => applyRelationPin(prev, resolved.lemmaID, lemmaID, type, val, showAVIToast));
    setWordResults(prev => sortResults(prev.map(r =>
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
    updateData(prev => applyRelationConnect(prev, items.map(b => b.lemmaID), basketRelType, showAVIToast));
    setBasketConnected(true);
    setTimeout(() => { setBasketConnected(false); setBasket([]); }, 3000);
  };

  // ── Derived summary ──────────────────────────────────────────
  const pinnedForm    = wordResults.filter(r => r.pinForm    && !r.hide).map(r => r.lemma);
  const pinnedMeaning = wordResults.filter(r => r.pinMeaning && !r.hide).map(r => r.lemma);
  const hiddenItems   = wordResults.filter(r => r.hide).map(r => r.lemma);
  const candidates    = wordResults.filter(r => !r.pinForm && !r.pinMeaning && !r.hide).map(r => r.lemma);

  const hasSearch     = !!status;
  const basketVisible = basket.length > 0;

  // ── Styles ───────────────────────────────────────────────────
  const thStyle = {
    padding: '6px 10px', fontSize: '10px', fontWeight: 700,
    letterSpacing: '0.07em', textTransform: 'uppercase', color: C.textM,
    borderBottom: `2px solid ${C.border}`, textAlign: 'left', whiteSpace: 'nowrap',
    position: 'sticky', top: 0, background: C.raised, zIndex: 4,
  };
  // Related Lemmas table header only: sticks below the resolved-info
  // layer (riHeight) instead of covering it.
  const relatedThStyle = { ...thStyle, top: riHeight };
  const tdStyle = {
    padding: '6px 10px', fontSize: '12px', color: C.text,
    verticalAlign: 'top', borderBottom: `1px solid ${C.border}`,
  };
  const selectStyle = {
    fontSize: '12px', padding: '6px 8px', borderRadius: '6px',
    border: `1px solid ${C.border}`, background: C.raised,
    color: C.text, cursor: 'pointer', outline: 'none',
  };

  return (
    <div style={{ paddingBottom: basketVisible ? (basketCollapsed ? '56px' : '120px') : '0' }}>

      {/* ── Search bar layer (sticky — covers the AVI tab strip) ── */}
      <div style={{ position: 'sticky', top: 0, zIndex: 2, background: C.bg, paddingBottom: '14px' }}>
  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>

    {/* Resolved lemma — shown left of search bar once a search has run */}
    {hasSearch && (
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
        <span style={{ fontFamily: SH.fk, fontSize: '15px', fontWeight: 700, color: C.accent, flexShrink: 0 }}>
          {resolved?.resolvedLemma || '—'}
        </span>
        <span style={{ fontSize: '10px', background: C.raised, border: `1px solid ${C.border}`, borderRadius: '4px', padding: '1px 6px', color: C.textM, fontFamily: SH.fm, flexShrink: 0 }}>
          {status}
        </span>
        {nearMatchOptions.length > 0 && (
          <select
            style={{ ...selectStyle, fontFamily: SH.fk, fontSize: '12px' }}
            value=""
            onChange={e => { if (e.target.value) handleNearMatchPick(e.target.value); }}
          >
            <option value="" disabled>Other matches</option>
            {nearMatchOptions.map(opt => <option key={opt.lemmaID} value={opt.lemma}>{opt.lemma}</option>)}
          </select>
        )}
      </div>
    )}

    <input
      style={{ flex: 1, minWidth: '160px', padding: '8px 12px', borderRadius: '8px', border: `1px solid ${C.border}`, background: C.bg, color: C.text, fontSize: '13px', fontFamily: SH.fk, outline: 'none' }}
      placeholder="Search Korean word or English meaning…"
      value={query}
      onChange={e => setQuery(e.target.value)}
      onKeyDown={e => e.key === 'Enter' && runSearch()}
    />
    <select style={selectStyle} value={modeOverride} onChange={e => setModeOverride(e.target.value)}>
      <option>Auto</option>
      <option>Korean</option>
      <option>English</option>
    </select>
    <button onClick={() => runSearch()} style={{ ...S.btnPrimary, padding: '8px 16px', borderRadius: '8px', fontSize: '13px', fontWeight: 600 }}>Search</button>
    <button onClick={() => setShowConnectList(true)} style={{ padding: '8px 14px', borderRadius: '8px', background: C.raised, border: `1px solid ${C.border}`, color: C.text, cursor: 'pointer', fontSize: '12px', whiteSpace: 'nowrap' }}>Connect List</button>
  </div>
  </div>

  {/* ── Resolved word info layer (sticky — covers the search bar) ── */}
  {hasSearch && (resolved?.def2 || resolved?.def1 || sentenceResults.length > 0) && (
    <div ref={setRiNode} style={{ position: 'sticky', top: 0, zIndex: 3, background: C.bg, paddingBottom: '14px' }}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      {resolved?.def2 && <div style={{ fontSize: '13px', color: C.text }}><span style={{ fontSize: '11px', color: C.textM, marginRight: '6px' }}>Def2:</span>{resolved.def2}</div>}
      {resolved?.def1 && <div style={{ fontSize: '12px', color: C.textM }}><span style={{ fontSize: '11px', marginRight: '6px' }}>Def1:</span>{resolved.def1.split('\n')[0]}</div>}

      {/* Sentences collapsible */}
      <div style={{ marginTop: '2px' }}>
        <button onClick={() => setSentExpanded(v => !v)} style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: '6px', color: C.textM, cursor: 'pointer', fontSize: '12px', padding: '3px 10px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontWeight: 700, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Sentences</span>
          <span style={{ background: C.raised, borderRadius: '10px', padding: '1px 6px', fontSize: '11px', fontFamily: SH.fm }}>{sentenceResults.length}</span>
          <span style={{ fontSize: '10px' }}>{sentExpanded ? '▲' : '▼'}</span>
        </button>
        {sentExpanded && sentenceResults.length > 0 && (
          <div style={{ marginTop: '6px', border: `1px solid ${C.border}`, borderRadius: '8px', overflow: 'hidden', maxHeight: '200px', overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr>{['Sentence', 'Source', '§', 'In Deck?'].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {sentenceResults.map(s => (
                  <tr key={s.uid}>
                    <td style={{ ...tdStyle, fontFamily: SH.fk }}>{s.sentence}</td>
                    <td style={tdStyle}><span style={{ fontSize: '11px', background: C.accentSoft, color: C.accent, borderRadius: '4px', padding: '1px 6px' }}>{s.source}</span></td>
                    <td style={{ ...tdStyle, fontFamily: SH.fm }}>{s.section || '—'}</td>
                    <td style={{ ...tdStyle, textAlign: 'center' }}><span style={{ color: s.uploaded ? C.success : C.textM }}>{s.uploaded ? '✓' : '○'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
    </div>
  )}

      {/* ── Summary line ──────────────────────────────────────── */}
      {hasSearch && wordResults.length > 0 && (
        <div style={{ flexShrink: 0, display: 'flex', gap: '18px', alignItems: 'center', flexWrap: 'wrap', fontSize: '11px', fontFamily: SH.fm, color: C.textM, marginBottom: '10px' }}>
          <span><span style={{ color: C.tL, fontWeight: 700, letterSpacing: '0.05em' }}>Pinned:</span> {pinnedForm.length} form · {pinnedMeaning.length} meaning</span>
          <span><span style={{ color: C.warning, fontWeight: 700, letterSpacing: '0.05em' }}>Candidates:</span> {candidates.length}</span>
          <span><span style={{ color: C.textM, fontWeight: 700, letterSpacing: '0.05em' }}>Hidden:</span> {hiddenItems.length}</span>
        </div>
      )}

      {/* ── Related lemmas (mobile: cards; desktop: table) ────── */}
      <div>
        {wordResults.length > 0 && (
          isMobile ? (
            <>
              <div style={relatedThStyle}>
                Related Lemmas ({wordResults.length})
              </div>
              {wordResults.map(r => {
                const inBasket = basket.some(b => b.lemmaID === r.lemmaID);
                return (
                  <div
                    key={r.lemmaID}
                    style={{
                      background: r.hide ? `${C.textM}10` : (r.pinForm || r.pinMeaning) ? `${C.accent}06` : C.surface,
                      border: `1px solid ${C.border}`, borderRadius: '10px', padding: '11px 12px', marginTop: '8px', opacity: r.hide ? 0.6 : 1,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                      <span style={{ fontFamily: SH.fk, fontWeight: 700, fontSize: '15px', color: C.accent }}>{r.lemma}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                        <span style={{ fontSize: '10px', background: C.raised, borderRadius: '4px', padding: '1px 6px', color: C.textM, fontFamily: SH.fm }}>{r.tag || '—'}</span>
                        <button
                          onClick={() => toggleBasket(r.lemmaID, r.lemma)}
                          title={inBasket ? 'Remove from basket' : 'Add to basket'}
                          style={{ background: inBasket ? C.accent : C.raised, color: inBasket ? '#fff' : C.textM, border: `1px solid ${inBasket ? C.accent : C.border}`, borderRadius: '6px', width: '24px', height: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}
                        >
                          {inBasket ? Icons.check : Icons.plus}
                        </button>
                      </div>
                    </div>

                    <div style={{ marginTop: '7px' }}>
                      <div style={{ fontSize: '9.5px', fontWeight: 700, color: C.textM, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '2px' }}>Definition 2</div>
                      <div style={{ fontSize: '12px', color: r.def2 ? C.text : C.textM, lineHeight: 1.5 }}>{r.def2 || '—'}</div>
                    </div>
                    <div style={{ marginTop: '6px' }}>
                      <div style={{ fontSize: '9.5px', fontWeight: 700, color: C.textM, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '2px' }}>Definition 1</div>
                      <Def1Display text={r.def1} />
                    </div>

                    <div style={{ display: 'flex', gap: '6px', marginTop: '10px' }}>
                      <button
                        onClick={() => handlePinToggle(r.lemmaID, 'pinForm', !r.pinForm)}
                        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', padding: '6px 4px', borderRadius: '6px', fontSize: '10.5px', fontWeight: 600, border: `1px solid ${r.pinForm ? C.accent : C.border}`, background: r.pinForm ? C.accentSoft : 'transparent', color: r.pinForm ? C.accent : C.textM, cursor: 'pointer' }}
                      >
                        {Icons.pin} Form
                      </button>
                      <button
                        onClick={() => handlePinToggle(r.lemmaID, 'pinMeaning', !r.pinMeaning)}
                        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', padding: '6px 4px', borderRadius: '6px', fontSize: '10.5px', fontWeight: 600, border: `1px solid ${r.pinMeaning ? C.accent : C.border}`, background: r.pinMeaning ? C.accentSoft : 'transparent', color: r.pinMeaning ? C.accent : C.textM, cursor: 'pointer' }}
                      >
                        {Icons.pin} Meaning
                      </button>
                      <button
                        onClick={() => handlePinToggle(r.lemmaID, 'hide', !r.hide)}
                        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', padding: '6px 4px', borderRadius: '6px', fontSize: '10.5px', fontWeight: 600, border: `1px solid ${r.hide ? C.danger : C.border}`, background: r.hide ? `${C.danger}15` : 'transparent', color: r.hide ? C.danger : C.textM, cursor: 'pointer' }}
                      >
                        {Icons.eyeSlash} Hide
                      </button>
                    </div>
                  </div>
                );
              })}
            </>
          ) : (
            <>
              <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textM, marginBottom: '6px' }}>
                Related Lemmas ({wordResults.length})
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead>
                  <tr>
                    {['Lemma', 'Definition 1', 'Definition 2', 'Tag', 'Pin Form', 'Pin Meaning', 'Hide', '+ Basket'].map(h => (
                      <th key={h} style={relatedThStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {wordResults.map(r => {
                    const inBasket = basket.some(b => b.lemmaID === r.lemmaID);
                    return (
                      <tr key={r.lemmaID} style={{ background: r.hide ? `${C.textM}10` : (r.pinForm || r.pinMeaning) ? `${C.accent}06` : 'transparent', opacity: r.hide ? 0.6 : 1 }}>
                        <td style={tdStyle}><span style={{ fontFamily: SH.fk, color: C.accent, fontWeight: 600 }}>{r.lemma}</span></td>
                        <td style={{ ...tdStyle, maxWidth: '180px' }}><Def1Display text={r.def1} /></td>
                        <td style={{ ...tdStyle, maxWidth: '180px', color: C.textM }}>{r.def2 || '—'}</td>
                        <td style={tdStyle}><span style={{ fontSize: '10px', background: C.raised, borderRadius: '4px', padding: '1px 5px', color: C.textM, fontFamily: SH.fm }}>{r.tag || '—'}</span></td>
                        <td style={{ ...tdStyle, textAlign: 'center' }}><input type="checkbox" checked={!!r.pinForm}    onChange={e => handlePinToggle(r.lemmaID, 'pinForm',    e.target.checked)} style={{ accentColor: C.accent, cursor: 'pointer' }} /></td>
                        <td style={{ ...tdStyle, textAlign: 'center' }}><input type="checkbox" checked={!!r.pinMeaning} onChange={e => handlePinToggle(r.lemmaID, 'pinMeaning', e.target.checked)} style={{ accentColor: C.accent, cursor: 'pointer' }} /></td>
                        <td style={{ ...tdStyle, textAlign: 'center' }}><input type="checkbox" checked={!!r.hide}       onChange={e => handlePinToggle(r.lemmaID, 'hide',       e.target.checked)} style={{ accentColor: C.accent, cursor: 'pointer' }} /></td>
                        <td style={{ ...tdStyle, textAlign: 'center' }}>
                          <button
                            onClick={() => toggleBasket(r.lemmaID, r.lemma)}
                            style={{ background: inBasket ? C.accent : C.raised, color: inBasket ? '#fff' : C.textM, border: `1px solid ${inBasket ? C.accent : C.border}`, borderRadius: '4px', padding: '2px 8px', fontSize: '11px', cursor: 'pointer', fontWeight: 600, transition: 'background 0.15s' }}
                          >
                            {inBasket ? '✓' : '+'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )
        )}
        {!hasSearch && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: C.textM, fontSize: '13px' }}>
            Search for a Korean word or English meaning to explore similarities.
          </div>
        )}
        {hasSearch && wordResults.length === 0 && (
          <div style={{ padding: '24px 0', textAlign: 'center', color: C.textM, fontSize: '13px' }}>
            No related lemmas found.
          </div>
        )}
      </div>

      {/* ── Connection Basket (floating pill ⇄ full bar) ──────── */}
      {basketVisible && createPortal(basketCollapsed ? (
        <button
          onClick={() => setBasketCollapsed(false)}
          style={{ position: 'fixed', bottom: isMobile ? '72px' : '16px', left: '50%', transform: 'translateX(-50%)', background: C.accent, color: '#fff', border: 'none', borderRadius: '20px', padding: '8px 18px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', boxShadow: '0 4px 16px rgba(0,0,0,0.3)', zIndex: 100 }}
        >
          Basket · {basket.length}
        </button>
      ) : (
        <div style={{ position: 'fixed', bottom: isMobile ? '56px' : 0, left: 0, right: 0, background: C.surface, borderTop: `2px solid ${C.accent}`, padding: '10px 20px', zIndex: 100, boxShadow: '0 -4px 20px rgba(0,0,0,0.2)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {!isMobile && <span style={{ fontWeight: 700, fontSize: '13px', color: C.text }}>Connection Basket</span>}
              <span style={{ background: C.accent, color: '#fff', fontSize: '11px', fontWeight: 700, padding: '1px 7px', borderRadius: '10px' }}>{basket.length}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: '4px' }}>
                {['Form', 'Meaning', 'Both'].map(t => (
                  <button key={t} onClick={() => setBasketRelType(t)} style={{ background: basketRelType === t ? C.accent : C.raised, color: basketRelType === t ? '#fff' : C.text, border: `1px solid ${basketRelType === t ? C.accent : C.border}`, borderRadius: '5px', padding: '3px 9px', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}>{t}</button>
                ))}
              </div>
              {basketConnected ? (
                <span style={{ background: C.success, color: '#fff', borderRadius: '6px', padding: '5px 14px', fontSize: '12px', fontWeight: 700 }}>✓ Connected</span>
              ) : (
                <button onClick={connectBasket} style={{ ...S.btnPrimary, borderRadius: '6px', padding: '5px 14px', fontSize: '12px', fontWeight: 700 }}>Connect All</button>
              )}
              <button onClick={() => setBasketCollapsed(true)} style={{ background: C.raised, border: `1px solid ${C.border}`, color: C.textM, borderRadius: '4px', padding: '3px 8px', cursor: 'pointer', fontSize: '13px' }}>▼</button>
              {!isMobile && (
                <button onClick={() => setBasket([])} style={{ background: 'none', border: 'none', color: C.danger, cursor: 'pointer', fontSize: '14px', fontWeight: 700 }}>✕</button>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
            {basket.map(b => (
              <div key={b.lemmaID} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', background: C.raised, border: `1px solid ${C.border}`, borderRadius: '16px', padding: '3px 10px', fontSize: '13px', color: C.text }}>
                <span style={{ fontFamily: SH.fk }}>{b.lemma}</span>
                {!b.isCenter && <button onClick={() => toggleBasket(b.lemmaID, b.lemma)} style={{ background: 'none', border: 'none', color: C.textM, cursor: 'pointer', fontSize: '11px', lineHeight: 1, padding: '0 2px' }}>✕</button>}
              </div>
            ))}
          </div>
        </div>
      ), document.body)}

      {/* ── Connect List modal ────────────────────────────────── */}
      {showConnectList && (
        <ConnectListModal
          data={data}
          updateData={updateData}
          initialWord={resolved?.resolvedLemma || ''}
          onClose={() => setShowConnectList(false)}
          C={C}
          S={S}
          showAVIToast={showAVIToast}
        />
      )}
    </div>
  );
}
