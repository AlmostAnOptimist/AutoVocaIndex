// src/pages/avi/AVISearchPage.jsx
// AVI Search tab — similarity search, pin/hide, connection basket, connect list.
// AS2: resolution and ranking come from lemmaSearchEngine.js through the
// useLemmaSearch hook (AVI search overhaul decisions).
// AS3: click a lemma to pivot (with a back trail), state lifted into AVIPage
// so it survives tab switches, compact sticky header, Def2 first, sources.
// Kink #12: Connect List auto-populates with the currently resolved lemma.
// pendingQuery ref: when goToSearch(query) is called from another tab,
// the search runs automatically on mount.
// AS5b: a Korean search with no match offers "Look up definition" and
// "Add to Word Input" (AVIAddToWordInput.jsx); a staged word pivots the
// search onto its lemma once the Lemma Master has it.

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useAppTheme } from '../../hooks/useAppTheme.js';
import {
  useLemmaSearch, SUGGESTION_KIND_LABEL, rowTag, statusLabel, resolveConnectLines,
} from '../../hooks/useLemmaSearch.js';
import { SH } from '../../theme/buildStyles.js';
import { Def1Display } from '../../components/avi/Def1Display.jsx';
import { AVINoMatchActions } from '../../components/avi/AVIAddToWordInput.jsx';
import { Icons, MagnifyIcon } from '../../components/Icons.jsx';
import { normalizeLemma, applyRelationPin, applyRelationConnect } from '../../utils/aviUtils.js';
import { searchKey } from '../../utils/lemmaSearchEngine.js';

const isMobile = typeof window !== 'undefined' && (window.innerWidth <= 700 || window.matchMedia('(hover: none) and (pointer: coarse) and (orientation: portrait)').matches);

// Nearest scrolling ancestor (AVIPage's scroll shell), or null for the window.
function scrollParentOf(el) {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const oy = window.getComputedStyle(p).overflowY;
    if (oy === 'auto' || oy === 'scroll') return p;
  }
  return null;
}

// ── ConnectListModal ─────────────────────────────────────────
// Paste a list of words, resolve each through the search engine (AS-D21),
// then connect them all. initialWord pre-populates the textarea. A line that
// only has "did you mean" suggestions is left out until one is picked.
function ConnectListModal({ search, updateData, initialWord, onClose, C, S, showAVIToast }) {
  const [raw,       setRaw]       = useState(() => initialWord ? initialWord + '\n' : '');
  const [resolved,  setResolved]  = useState([]); // { input, status, entry, suggestions, pickedId }
  const [resolving, setResolving] = useState(false);
  const [relType,   setRelType]   = useState('Form');
  const [connected, setConnected] = useState(false);
  const reqRef = useRef(0);

  const resolveAll = async () => {
    const lines = raw.split(/[\n,]+/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;
    const token = ++reqRef.current;
    setResolving(true);
    const results = await resolveConnectLines(lines, search);
    if (token !== reqRef.current) return;   // edited or re-resolved meanwhile
    setResolved(results);
    setResolving(false);
  };

  const idOf = (r) => r.entry?.lemmaID || r.pickedId || null;
  const pick = (i, lemmaID) => setResolved(prev => prev.map((r, j) => j === i ? { ...r, pickedId: lemmaID } : r));

  // Two lines can resolve to the same lemma (가르치다 / 가르쳐, or a repeated
  // line). Connecting a lemma to itself writes a self-link, so connect the
  // set of distinct IDs only.
  const uniqueIDs = [...new Set(resolved.map(idOf).filter(Boolean))];

  const connectAll = () => {
    if (uniqueIDs.length < 2) return;
    updateData(prev => applyRelationConnect(prev, uniqueIDs, relType, showAVIToast));
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
          style={{ width: '100%', minHeight: '120px', padding: '8px 10px', borderRadius: '6px', border: `1px solid ${C.border}`, background: C.bg, color: C.text, fontSize: isMobile ? '16px' : '13px', fontFamily: SH.fk, outline: 'none', resize: 'vertical', boxSizing: 'border-box', lineHeight: 1.6 }}
          placeholder="가리다&#10;가르다&#10;가르치다"
          value={raw}
          onChange={e => { setRaw(e.target.value); ++reqRef.current; setResolving(false); setResolved([]); }}
        />

        {/* Relationship type */}
        <div style={{ display: 'flex', gap: '6px', margin: '10px 0' }}>
          {['Form', 'Meaning', 'Both'].map(t => (
            <button key={t} onClick={() => setRelType(t)} style={{ padding: '4px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 600, border: `1px solid ${relType === t ? C.accent : C.border}`, background: relType === t ? C.accentSoft : 'transparent', color: relType === t ? C.accent : C.textS, cursor: 'pointer' }}>{t}</button>
          ))}
          <button onClick={resolveAll} disabled={resolving} style={{ marginLeft: 'auto', padding: '4px 14px', borderRadius: '6px', fontSize: '12px', fontWeight: 600, background: C.raised, border: `1px solid ${C.border}`, color: C.text, cursor: resolving ? 'default' : 'pointer', opacity: resolving ? 0.6 : 1 }}>{resolving ? 'Resolving…' : 'Resolve'}</button>
        </div>

        {/* Resolved results */}
        {resolved.length > 0 && (
          <div style={{ border: `1px solid ${C.border}`, borderRadius: '8px', overflow: 'hidden', marginBottom: '14px' }}>
            {resolved.map((r, i) => {
              const id   = idOf(r);
              const dup  = id && resolved.findIndex(x => idOf(x) === id) < i;
              const note = r.status === 'surface' ? 'from your input' : r.status === 'dictionary' ? 'dictionary form' : '';
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '7px 12px', borderBottom: i < resolved.length - 1 ? `1px solid ${C.border}` : 'none', background: id ? 'transparent' : `${C.danger}08` }}>
                  <span style={{ fontFamily: SH.fk, fontSize: '13px', color: C.textM, flexShrink: 0 }}>{r.input}</span>
                  <span style={{ color: C.textM, fontSize: '12px' }}>→</span>
                  {r.entry ? (
                    <span style={{ fontFamily: SH.fk, fontSize: '13px', color: C.accent, fontWeight: 600 }}>{r.entry.lemma}</span>
                  ) : r.suggestions.length > 0 ? (
                    <select
                      value={r.pickedId}
                      onChange={e => pick(i, e.target.value)}
                      style={{ fontFamily: SH.fk, fontSize: isMobile ? '16px' : '12px', padding: '3px 6px', borderRadius: '6px', border: `1px solid ${r.pickedId ? C.accent : C.border}`, background: C.bg, color: C.text, outline: 'none', cursor: 'pointer', maxWidth: '100%' }}
                    >
                      <option value="">Pick one…</option>
                      {r.suggestions.map(s => <option key={s.lemmaID} value={s.lemmaID}>{s.lemma} ({SUGGESTION_KIND_LABEL[s.kind]})</option>)}
                    </select>
                  ) : (
                    <span style={{ fontFamily: SH.fk, fontSize: '13px', color: C.danger }}>{r.input}</span>
                  )}
                  {note && <span style={{ fontSize: '10px', color: C.textM }}>{note}</span>}
                  {!id && r.suggestions.length === 0 && <span style={{ fontSize: '10px', color: C.danger, marginLeft: 'auto' }}>not found</span>}
                  {!id && r.suggestions.length > 0 && <span style={{ fontSize: '10px', color: C.warning, marginLeft: 'auto' }}>pick one</span>}
                  {dup && <span style={{ fontSize: '10px', color: C.textM, marginLeft: 'auto' }}>duplicate</span>}
                </div>
              );
            })}
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px' }}>
          {connected ? (
            <div style={{ flex: 1, padding: '10px', borderRadius: '8px', background: C.success, color: '#fff', textAlign: 'center', fontSize: '13px', fontWeight: 600 }}>✓ Connected</div>
          ) : (
            <button
              onClick={connectAll}
              disabled={uniqueIDs.length < 2}
              style={{ ...S.btnPrimary, ...S.btnMetallic, flex: 1, padding: '10px', borderRadius: '8px', fontSize: '13px', fontWeight: 600, opacity: uniqueIDs.length < 2 ? 0.5 : 1 }}
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
export function AVISearchPage({
  data, updateData, pendingQuery, showAVIToast, searchStore, goToSource,
  currentSource, currentSection, aviSources, aviSections,
  cards, decks, updateCards, updateDecks, dsh,
}) {
  const { C, S } = useAppTheme();
  // searchStore is lifted into AVIPage (AS-D14): the search, back trail,
  // typed text and basket survive tab switches. Without it the hook keeps
  // its own store, which lasts only while this tab is open.
  const search = useLemmaSearch(data, { store: searchStore });
  const { mode, status, anchor, related, english } = search;
  const {
    input: query, setInput: setQuery,
    modeOverride, setModeOverride,
    basket, setBasket,
  } = search.store;

  const [sentExpanded,     setSentExpanded]      = useState(false);
  const [hiddenOpen,       setHiddenOpen]        = useState(false);
  const [basketRelType,    setBasketRelType]      = useState('Form');
  const [basketConnected,  setBasketConnected]   = useState(false);
  const [basketCollapsed,  setBasketCollapsed]   = useState(false);
  const [showConnectList,  setShowConnectList]   = useState(false);
  // AS5b: lemma to anchor on once a staged word's entry is in the index, and
  // the confirmation shown above its info block.
  const [pivotTo,          setPivotTo]           = useState(null);
  const [stagedNote,       setStagedNote]        = useState(null);
  const staging = useMemo(() => ({
    currentSource, currentSection, aviSources, aviSections,
    cards, decks, updateCards, updateDecks, dsh,
  }), [currentSource, currentSection, aviSources, aviSections, cards, decks, updateCards, updateDecks, dsh]);

  // Measured height of the compact sticky header (AS-D15). The table header
  // sticks just below this value instead of covering it, so Def2 stays
  // visible as reference while working through the candidates table.
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

  // ── Basket center (AS-D12) ───────────────────────────────────
  // A new anchor replaces the previous center instead of stacking; picks stay.
  const setCenter = useCallback((ref) => {
    if (!ref) return;
    setBasket(prev => [
      { lemmaID: ref.lemmaID, lemma: ref.lemma, isCenter: true },
      ...prev.filter(b => !b.isCenter && b.lemmaID !== ref.lemmaID),
    ]);
  }, [setBasket]);

  const searchBarRef = useRef(null);
  const infoRef      = useRef(null);
  const inputRef     = useRef(null);
  const scrollToTop  = () => {
    const sc = scrollParentOf(searchBarRef.current);
    if (sc) sc.scrollTo({ top: 0, behavior: 'smooth' }); else window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const { run, searchById, back, jumpTo } = search;
  const runSearch = useCallback(async (q = query, m = modeOverride) => {
    if (!String(q || '').trim()) return;
    setHiddenOpen(false);
    setStagedNote(null);
    const ref = await run(q, m);
    setCenter(ref);
  }, [query, modeOverride, run, setCenter]);

  // Re-anchor on a lemma the user picked: a "Did you mean" suggestion
  // (AS-D11), a result row (pivot, AS-D13), Back, or a breadcrumb step.
  const anchorOn = (ref) => {
    if (!ref) return;
    setQuery(ref.lemma);
    setHiddenOpen(false);
    setSentExpanded(false);
    setStagedNote(n => (n && n.lemmaID === ref.lemmaID ? n : null));
    setCenter(ref);
    scrollToTop();
  };
  const pickLemma = (lemmaID) => anchorOn(searchById(lemmaID));
  const pivot     = (lemmaID) => anchorOn(searchById(lemmaID));
  const goBack    = () => anchorOn(back());
  const goToStep  = (i) => anchorOn(jumpTo(i));

  // A newly created lemma reaches the index on the next render, so the pivot
  // waits for it (an existing lemma is there already).
  useEffect(() => {
    if (pivotTo && search.index.byId.has(pivotTo)) {
      setPivotTo(null);
      pivot(pivotTo);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pivotTo, search.index]);
  const onStaged = ({ lemmaID, row, isNewLemma, dest }) => {
    setStagedNote({ lemmaID, surface: row.input, dest, isNewLemma });
    if (lemmaID) setPivotTo(lemmaID);
  };

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

  // ── Pin / hide toggle (bidirectional) ────────────────────────
  // Results are derived from the live Lemma Master, so the row moves between
  // Pinned / Candidates / Hidden on the next render — no local copy to patch.
  const handlePinToggle = (lemmaID, type, val) => {
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
    updateData(prev => applyRelationConnect(prev, items.map(b => b.lemmaID), basketRelType, showAVIToast));
    setBasketConnected(true);
    setTimeout(() => { setBasketConnected(false); setBasket([]); }, 3000);
  };

  // ── Sentences for the anchored lemma (AS-D19) ────────────────
  // targetWord matching any headword variant of the anchor (보장되다 finds
  // 보장하다 / 보장되다 rows), plus sentence text containing the stem (final
  // 다 dropped) when the stem is 2+ syllables — a one-syllable stem
  // (가다 → 가) would match nearly every sentence.
  const sentenceResults = useMemo(() => {
    if (!anchor) return [];
    const entry = search.index.byId.get(anchor.lemmaID);
    const norm  = normalizeLemma(anchor.lemma);
    const keys  = new Set(entry ? entry.keys : [searchKey(norm)]);
    const textStem     = norm.endsWith('다') ? norm.slice(0, -1) : norm;
    const useTextMatch = textStem.replace(/\s/g, '').length >= 2;
    const seen = new Set();
    return data.sentenceInputs.filter(s => {
      const hit = keys.has(searchKey(normalizeLemma(s.targetWord))) ||
        (useTextMatch && String(s.sentence || '').normalize('NFC').includes(textStem));
      if (!hit || seen.has(s.sentence)) return false;
      seen.add(s.sentence);
      return true;
    });
  }, [anchor, search.index, data.sentenceInputs]);

  // ── Sources for the anchored lemma (AS-D17) ──────────────────
  // Same matching as the sentences above: any Word Input or Sentence Input
  // row filed under one of the anchor's headword variants.
  const anchorSources = useMemo(() => {
    if (!anchor) return [];
    const entry = search.index.byId.get(anchor.lemmaID);
    const keys  = new Set(entry ? entry.keys : [searchKey(normalizeLemma(anchor.lemma))]);
    const map = new Map();
    const add = (word, source, section) => {
      if (!source || !keys.has(searchKey(normalizeLemma(word)))) return;
      const label = section ? `${source} §${section}` : source;
      if (!map.has(label)) map.set(label, { label, source, section: section || '' });
    };
    for (const w of data.wordInputs) add(w.lemma, w.source, w.section);
    for (const t of data.sentenceInputs) add(t.targetWord, t.source, t.section);
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, 'ko'));
  }, [anchor, search.index, data.wordInputs, data.sentenceInputs]);

  // ── Compact sticky header (AS-D15) ───────────────────────────
  // The full info block (Def2, Def1, sources, sentences) scrolls with the
  // page. Once it has scrolled up under the sticky search bar, a one-row
  // header takes its place: Back, the anchor lemma, Def2 (two lines at
  // most) and a search icon that jumps back to the search box.
  const [infoScrolledAway, setInfoScrolledAway] = useState(false);
  const anchorKey = mode === 'ko' && anchor ? anchor.lemmaID : '';
  useEffect(() => {
    const info = infoRef.current;
    if (!info) { setInfoScrolledAway(false); return undefined; }
    const scroller = scrollParentOf(info);
    let raf = 0;
    const check = () => {
      raf = 0;
      const top = (scroller ? scroller.getBoundingClientRect().top : 0) + (searchBarRef.current?.offsetHeight || 0);
      setInfoScrolledAway(info.getBoundingClientRect().bottom <= top);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(check); };
    // Scroll events don't bubble, but they do reach the document in the
    // capture phase — so this hears whichever ancestor actually scrolls.
    document.addEventListener('scroll', onScroll, { passive: true, capture: true });
    check();
    return () => { document.removeEventListener('scroll', onScroll, { capture: true }); if (raf) cancelAnimationFrame(raf); };
  }, [anchorKey]);

  // ── Derived view ─────────────────────────────────────────────
  const hasSearch      = mode !== null;
  // Pin / Hide need a resolved anchor lemma. English searches have none, so
  // their controls (and the pinned/candidates summary) are not shown.
  const canPin         = mode === 'ko' && !!anchor && !!related?.anchor;
  const pinnedRows     = canPin ? related.pinned     : [];
  const candidateRows  = canPin ? related.candidates : [];
  const hiddenRows     = canPin ? related.hidden     : [];
  const englishRows    = mode === 'en' && english ? english.results : [];
  const mainRows       = mode === 'en' ? englishRows : [...pinnedRows, ...candidateRows];
  // No exact match: nothing is anchored, the user picks from suggestions.
  const awaitingPick   = mode === 'ko' && !anchor && (status === 'pending' || status === 'none');
  const basketVisible  = basket.length > 0;
  const pinnedFormN    = pinnedRows.filter(r => r.pinForm).length;
  const pinnedMeaningN = pinnedRows.filter(r => r.pinMeaning).length;

  // ── Styles ───────────────────────────────────────────────────
  const thStyle = {
    padding: '6px 10px', fontSize: '10px', fontWeight: 700,
    letterSpacing: '0.07em', textTransform: 'uppercase', color: C.textM,
    borderBottom: `2px solid ${C.border}`, textAlign: 'left', whiteSpace: 'nowrap',
    position: 'sticky', top: 0, background: C.raised, zIndex: 4,
  };
  // Related Lemmas table header only: sticks below the compact header
  // (riHeight) instead of covering it.
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

  // Engine rows carry the Lemma Master object as `ref`; flatten so the
  // cells read def1/def2 the way they always have.
  const view = (r) => ({ ...r.ref, ...r });
  // AS-D16: Def2 (the user's own gloss) before Def1.
  const columns = ['Lemma', 'Definition 2', 'Definition 1', 'Tag', ...(canPin ? ['Pin Form', 'Pin Meaning', 'Hide'] : []), '+ Basket'];

  // A result's lemma is a link: clicking it re-centers the search (AS-D13).
  const lemmaLink = (r, size) => (
    <button
      onClick={() => pivot(r.lemmaID)}
      title={`Search ${r.lemma}`}
      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', fontFamily: SH.fk, fontWeight: size ? 700 : 600, fontSize: size || 'inherit', color: C.accent }}
    >
      {r.lemma}
    </button>
  );

  const renderCard = (row) => {
    const r = view(row);
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
          {lemmaLink(r, '15px')}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
            <span style={{ fontSize: '10px', background: C.raised, borderRadius: '4px', padding: '1px 6px', color: C.textM, fontFamily: SH.fm }}>{rowTag(r) || '—'}</span>
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

        {canPin && (
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
            {Icons.eyeSlash} {r.hide ? 'Unhide' : 'Hide'}
          </button>
        </div>
        )}
      </div>
    );
  };

  const renderTableRow = (row) => {
    const r = view(row);
    const inBasket = basket.some(b => b.lemmaID === r.lemmaID);
    return (
      <tr key={r.lemmaID} style={{ background: r.hide ? `${C.textM}10` : (r.pinForm || r.pinMeaning) ? `${C.accent}06` : 'transparent', opacity: r.hide ? 0.6 : 1 }}>
        <td style={tdStyle}>{lemmaLink(r)}</td>
        <td style={{ ...tdStyle, maxWidth: '180px', color: r.def2 ? C.text : C.textM }}>{r.def2 || '—'}</td>
        <td style={{ ...tdStyle, maxWidth: '180px' }}><Def1Display text={r.def1} /></td>
        <td style={tdStyle}><span style={{ fontSize: '10px', background: C.raised, borderRadius: '4px', padding: '1px 5px', color: C.textM, fontFamily: SH.fm }}>{rowTag(r) || '—'}</span></td>
        {canPin && (<>
        <td style={{ ...tdStyle, textAlign: 'center' }}><input type="checkbox" checked={!!r.pinForm}    onChange={e => handlePinToggle(r.lemmaID, 'pinForm',    e.target.checked)} style={{ accentColor: C.accent, cursor: 'pointer' }} /></td>
        <td style={{ ...tdStyle, textAlign: 'center' }}><input type="checkbox" checked={!!r.pinMeaning} onChange={e => handlePinToggle(r.lemmaID, 'pinMeaning', e.target.checked)} style={{ accentColor: C.accent, cursor: 'pointer' }} /></td>
        <td style={{ ...tdStyle, textAlign: 'center' }}><input type="checkbox" checked={!!r.hide}       onChange={e => handlePinToggle(r.lemmaID, 'hide',       e.target.checked)} style={{ accentColor: C.accent, cursor: 'pointer' }} /></td>
        </>)}
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
  };

  const resultsLabel = mode === 'en'
    ? `Definition matches (${english ? english.total : 0})`
    : `Related Lemmas (${mainRows.length})`;

  // Last five anchors of the trail; the current one is not a link.
  const crumbs = search.trail.slice(-5);
  const isCurrentStep = (t) => mode === 'ko' && t.i === search.trail[search.trail.length - 1]?.i && t.lemmaID === anchor?.lemmaID;

  return (
    <div style={{ paddingBottom: basketVisible ? (basketCollapsed ? '56px' : '120px') : '0' }}>

      {/* ── Compact sticky header (AS-D15). Zero-height sticky wrapper so it
           never shifts the layout; its content overlays the search bar
           once the full info block has scrolled away. ──────────────── */}
      {mode === 'ko' && anchor && infoScrolledAway && (
        <div style={{ position: 'sticky', top: 0, zIndex: 3, height: 0 }}>
          <div ref={setRiNode} style={{ position: 'absolute', left: 0, right: 0, top: 0, background: C.bg, paddingBottom: '10px', display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
            {search.canBack && (
              <button onClick={goBack} title="Back" style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '5px 9px', borderRadius: '6px', border: `1px solid ${C.border}`, background: C.raised, color: C.text, cursor: 'pointer', fontSize: '12px' }}>
                {Icons.chevronLeft} Back
              </button>
            )}
            <span style={{ flexShrink: 0, fontFamily: SH.fk, fontSize: '15px', fontWeight: 700, color: C.accent, paddingTop: '3px' }}>{anchor.lemma}</span>
            <div style={{ flex: 1, minWidth: 0, fontSize: '12px', color: anchor.def2 ? C.text : C.textM, lineHeight: 1.5, paddingTop: '4px', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
              {anchor.def2 || (anchor.def1 || '').split('\n')[0] || '—'}
            </div>
            <button onClick={() => { scrollToTop(); inputRef.current?.focus(); }} title="Back to the search box" style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '30px', height: '30px', borderRadius: '6px', border: `1px solid ${C.border}`, background: C.raised, color: C.text, cursor: 'pointer' }}>
              <MagnifyIcon size={13} />
            </button>
          </div>
        </div>
      )}

      {/* ── Search bar layer (sticky — covers the AVI tab strip) ── */}
      <div ref={searchBarRef} style={{ position: 'sticky', top: 0, zIndex: 2, background: C.bg, paddingBottom: '14px' }}>
  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>

    {/* Resolved lemma + how it was found — shown once a search has run */}
    {hasSearch && (
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
        {mode === 'ko' && (
          <span style={{ fontFamily: SH.fk, fontSize: '15px', fontWeight: 700, color: C.accent, flexShrink: 0 }}>
            {anchor?.lemma || '—'}
          </span>
        )}
        <span style={{ fontSize: '10px', background: C.raised, border: `1px solid ${C.border}`, borderRadius: '4px', padding: '1px 6px', color: C.textM, fontFamily: SH.fm, flexShrink: 0 }}>
          {statusLabel(search)}
        </span>
      </div>
    )}

    <input
      ref={inputRef}
      style={{ flex: 1, minWidth: '160px', padding: '8px 12px', borderRadius: '8px', border: `1px solid ${C.border}`, background: C.bg, color: C.text, fontSize: isMobile ? '16px' : '13px', fontFamily: SH.fk, outline: 'none' }}
      placeholder="Search Korean word or English meaning…"
      value={query}
      onChange={e => setQuery(e.target.value)}
      onKeyDown={e => e.key === 'Enter' && !e.nativeEvent.isComposing && runSearch()}
    />
    <select style={selectStyle} value={modeOverride} onChange={e => setModeOverride(e.target.value)}>
      <option>Auto</option>
      <option>Korean</option>
      <option>English</option>
    </select>
    <button onClick={() => runSearch()} style={{ ...S.btnPrimary, padding: '8px 16px', borderRadius: '8px', fontSize: '13px', fontWeight: 600 }}>Search</button>
    <button onClick={() => setShowConnectList(true)} style={{ padding: '8px 14px', borderRadius: '8px', background: C.raised, border: `1px solid ${C.border}`, color: C.text, cursor: 'pointer', fontSize: '12px', whiteSpace: 'nowrap' }}>Connect List</button>
  </div>

  {/* Back trail (AS-D13): Back plus the last five anchors */}
  {search.canBack && (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginTop: '8px', fontSize: '12px' }}>
      <button onClick={goBack} title="Back" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '3px 9px', borderRadius: '6px', border: `1px solid ${C.border}`, background: C.raised, color: C.text, cursor: 'pointer', fontSize: '12px' }}>
        {Icons.chevronLeft} Back
      </button>
      {crumbs.map((t, k) => (
        <span key={t.i} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          {k > 0 && <span style={{ color: C.textM, display: 'inline-flex' }}>{Icons.chevronRight}</span>}
          {isCurrentStep(t) ? (
            <span style={{ fontFamily: SH.fk, fontWeight: 700, color: C.text }}>{t.lemma}</span>
          ) : (
            <button onClick={() => goToStep(t.i)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: SH.fk, color: C.accent, fontSize: '12px' }}>{t.lemma}</button>
          )}
        </span>
      ))}
    </div>
  )}
  </div>

  {/* ── Did you mean (AS-D11): no exact match, nothing anchored ── */}
  {awaitingPick && (
    <div style={{ marginBottom: '14px', padding: '12px 14px', border: `1px solid ${C.border}`, borderRadius: '10px', background: C.surface }}>
      <div style={{ fontSize: '13px', color: C.text, marginBottom: search.suggestions.length ? '8px' : 0 }}>
        No exact match for <span style={{ fontFamily: SH.fk, fontWeight: 700 }}>{search.query}</span>.
        {status === 'pending' && <span style={{ color: C.textM }}> Checking the dictionary…</span>}
        {search.suggestions.length > 0 && ' Did you mean:'}
        {status === 'none' && search.suggestions.length === 0 && <span style={{ color: C.textM }}> Nothing similar in your Lemma Master.</span>}
      </div>
      {search.suggestions.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {search.suggestions.map(s => (
            <button
              key={s.lemmaID}
              onClick={() => pickLemma(s.lemmaID)}
              style={{ display: 'inline-flex', alignItems: 'baseline', gap: '6px', padding: '5px 10px', borderRadius: '16px', border: `1px solid ${C.border}`, background: C.raised, color: C.text, cursor: 'pointer' }}
            >
              <span style={{ fontFamily: SH.fk, fontSize: '13px', fontWeight: 600, color: C.accent }}>{s.lemma}</span>
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
        />
      )}
    </div>
  )}

  {/* ── Resolved word info (scrolls; the compact header takes over once it is gone) ── */}
  {mode === 'ko' && anchor && (
    <div ref={infoRef} style={{ paddingBottom: '14px' }}>
    {stagedNote && stagedNote.lemmaID === anchor.lemmaID && (
      <div style={{ marginBottom: '8px', padding: '6px 10px', borderRadius: '8px', border: `1px solid ${C.success}`, background: `${C.success}12`, fontSize: '12px', color: C.text }}>
        Added <span style={{ fontFamily: SH.fk, fontWeight: 700 }}>{stagedNote.surface}</span> to Word Input · {stagedNote.dest}.
        {stagedNote.isNewLemma && <span style={{ color: C.textM }}> New Lemma Master entry.</span>}
      </div>
    )}
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      {anchor.def2 && <div style={{ fontSize: '13px', color: C.text }}><span style={{ fontSize: '11px', color: C.textM, marginRight: '6px' }}>Def2:</span>{anchor.def2}</div>}
      {anchor.def1 && <div style={{ fontSize: '12px', color: C.textM }}><span style={{ fontSize: '11px', marginRight: '6px' }}>Def1:</span>{anchor.def1.split('\n')[0]}</div>}

      {/* Sources (AS-D17) — each opens the Source tab filtered to it */}
      {anchorSources.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center', marginTop: '2px' }}>
          <span style={{ fontSize: '11px', color: C.textM, marginRight: '2px' }}>Sources:</span>
          {anchorSources.map(src => goToSource ? (
            <button key={src.label} onClick={() => goToSource(src.source, src.section)} title={`Open ${src.label} in the Source tab`} style={{ fontSize: '11px', background: C.accentSoft, color: C.accent, border: 'none', borderRadius: '4px', padding: '1px 6px', fontFamily: SH.fm, cursor: 'pointer' }}>{src.label}</button>
          ) : (
            <span key={src.label} style={{ fontSize: '11px', background: C.accentSoft, color: C.accent, borderRadius: '4px', padding: '1px 6px', fontFamily: SH.fm }}>{src.label}</span>
          ))}
        </div>
      )}

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
      {canPin && (mainRows.length > 0 || hiddenRows.length > 0) && (
        <div style={{ flexShrink: 0, display: 'flex', gap: '18px', alignItems: 'center', flexWrap: 'wrap', fontSize: '11px', fontFamily: SH.fm, color: C.textM, marginBottom: '10px' }}>
          <span><span style={{ color: C.tL, fontWeight: 700, letterSpacing: '0.05em' }}>Pinned:</span> {pinnedFormN} form · {pinnedMeaningN} meaning</span>
          <span><span style={{ color: C.warning, fontWeight: 700, letterSpacing: '0.05em' }}>Candidates:</span> {candidateRows.length}{related.totalCandidates > candidateRows.length ? ` of ${related.totalCandidates}` : ''}</span>
          <span><span style={{ color: C.textM, fontWeight: 700, letterSpacing: '0.05em' }}>Hidden:</span> {hiddenRows.length}</span>
        </div>
      )}

      {/* ── Related lemmas / definition matches (mobile: cards; desktop: table) ── */}
      <div>
        {mainRows.length > 0 && (
          isMobile ? (
            <>
              <div style={relatedThStyle}>{resultsLabel}</div>
              {mainRows.map(renderCard)}
            </>
          ) : (
            <>
              <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textM, marginBottom: '6px' }}>
                {resultsLabel}
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead>
                  <tr>
                    {columns.map(h => (
                      <th key={h} style={relatedThStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {mainRows.map(renderTableRow)}
                </tbody>
              </table>
            </>
          )
        )}

        {/* English: 20 at a time (AS-D29) */}
        {mode === 'en' && english && englishRows.length < english.total && (
          <div style={{ textAlign: 'center', marginTop: '12px' }}>
            <button onClick={search.showMore} style={{ padding: '7px 16px', borderRadius: '8px', background: C.raised, border: `1px solid ${C.border}`, color: C.text, cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>
              Show more ({english.total - englishRows.length} more)
            </button>
          </div>
        )}

        {/* Hidden relations: collapsed, always reachable for unhiding (AS-D4 / AS-D10) */}
        {canPin && hiddenRows.length > 0 && (
          <div style={{ marginTop: '14px' }}>
            <button onClick={() => setHiddenOpen(v => !v)} style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: '6px', color: C.textM, cursor: 'pointer', fontSize: '12px', padding: '3px 10px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              {Icons.eyeSlash}
              <span style={{ fontWeight: 700, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Hidden</span>
              <span style={{ background: C.raised, borderRadius: '10px', padding: '1px 6px', fontSize: '11px', fontFamily: SH.fm }}>{hiddenRows.length}</span>
              <span style={{ fontSize: '10px' }}>{hiddenOpen ? '▲' : '▼'}</span>
            </button>
            {hiddenOpen && (isMobile ? hiddenRows.map(renderCard) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', marginTop: '6px' }}>
                <thead>
                  <tr>{columns.map(h => <th key={h} style={{ ...thStyle, position: 'static' }}>{h}</th>)}</tr>
                </thead>
                <tbody>{hiddenRows.map(renderTableRow)}</tbody>
              </table>
            ))}
          </div>
        )}

        {!hasSearch && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: C.textM, fontSize: '13px' }}>
            Search for a Korean word or English meaning to explore similarities.
          </div>
        )}
        {canPin && mainRows.length === 0 && hiddenRows.length === 0 && (
          <div style={{ padding: '24px 0', textAlign: 'center', color: C.textM, fontSize: '13px' }}>
            No related lemmas found.
          </div>
        )}
        {mode === 'en' && english && english.total === 0 && (
          <div style={{ padding: '24px 0', textAlign: 'center', color: C.textM, fontSize: '13px' }}>
            No matches in your definitions.
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
                <button onClick={connectBasket} disabled={basket.length < 2} title={basket.length < 2 ? 'Add at least two lemmas to connect' : undefined} style={{ ...S.btnPrimary, borderRadius: '6px', padding: '5px 14px', fontSize: '12px', fontWeight: 700, opacity: basket.length < 2 ? 0.5 : 1, cursor: basket.length < 2 ? 'default' : 'pointer' }}>Connect All</button>
              )}
              <button onClick={() => setBasketCollapsed(true)} style={{ background: C.raised, border: `1px solid ${C.border}`, color: C.textM, borderRadius: '4px', padding: '3px 8px', cursor: 'pointer', fontSize: '13px' }}>▼</button>
              <button onClick={() => setBasket([])} title="Clear basket" style={{ background: 'none', border: 'none', color: C.danger, cursor: 'pointer', fontSize: '14px', fontWeight: 700, padding: '3px 6px' }}>✕</button>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
            {basket.map(b => (
              <div key={b.lemmaID} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', background: C.raised, border: `1px solid ${C.border}`, borderRadius: '16px', padding: '3px 10px', fontSize: '13px', color: C.text }}>
                <span style={{ fontFamily: SH.fk }}>{b.lemma}</span>
                <button onClick={() => toggleBasket(b.lemmaID, b.lemma)} title="Remove from basket" style={{ background: 'none', border: 'none', color: C.textM, cursor: 'pointer', fontSize: '11px', lineHeight: 1, padding: '0 2px' }}>✕</button>
              </div>
            ))}
          </div>
        </div>
      ), document.body)}

      {/* ── Connect List modal ────────────────────────────────── */}
      {showConnectList && (
        <ConnectListModal
          search={search}
          updateData={updateData}
          initialWord={anchor?.lemma || ''}
          onClose={() => setShowConnectList(false)}
          C={C}
          S={S}
          showAVIToast={showAVIToast}
        />
      )}
    </div>
  );
}
