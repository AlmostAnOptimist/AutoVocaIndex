// src/pages/avi/AVILemmaMasterPage.jsx
// AVI Lemma Master tab.
// LemmaCard: blur-to-save fields, related pills, search popup trigger, def1 refetch, delete.
// handleCardSave: full cascade for lemma/def1/def2 changes to wordInputs, sentenceInputs, flashcards.
// AVIMiniSearchPopup (shared component): similarity search, opened from related pills or the magnifying glass button.
// AS4: the filter runs on lemmaSearchEngine.js (tiered literal matching, "Did you mean"
// fallback), plus No def2 / No source chips; filter text and chips are lifted into AVIPage.

import { useState, useCallback, useMemo, useEffect, useRef, memo } from 'react';
import { doc, writeBatch, collection } from 'firebase/firestore';
import { db, auth } from '../../firebase.js';
import { useAppTheme } from '../../hooks/useAppTheme.js';
import { SH } from '../../theme/buildStyles.js';
import { Def1Display } from '../../components/avi/Def1Display.jsx';
import {
  uuid, normalizeLemma, fetchDefinition,
  stripKoreanAffixes, syncNuanceSource,
  updateLinkedCards, resolveLemmaWithDictionary,
} from '../../utils/aviUtils.js';
import {
  buildLemmaIndex, buildSurfaceMap, filterLemmaMaster,
  suggestLemmas, resolveKorean, findByLemmaText,
} from '../../utils/lemmaSearchEngine.js';
import { SUGGESTION_KIND_LABEL } from '../../hooks/useLemmaSearch.js';
import { AVIMiniSearchPopup } from '../../components/avi/AVIMiniSearchPopup.jsx';
import { LemmaAutocompleteInput, LemmaMergeModal } from '../../components/avi/LemmaAutocompleteInput.jsx';
import { Icons, MagnifyIcon } from '../../components/Icons.jsx';
import { PaginationFooter } from '../../components/PaginationFooter.jsx';
import { usePaginationKeys } from '../../hooks/usePaginationKeys.js';

const isMobile = typeof window !== 'undefined' && (window.innerWidth <= 700 || window.matchMedia('(hover: none) and (pointer: coarse) and (orientation: portrait)').matches);
// Mobile cards are much heavier per-row than desktop's grid (two always-mounted
// textareas + a live autocomplete component, vs compact grid cells) — keeping
// far fewer of them mounted at once matters more on iOS Safari, which crashes
// a tab well before desktop browsers would even start to feel slow under the
// same memory pressure.
const LM_PAGE_SIZE = isMobile ? 20 : 100;

// updateLinkedCards now lives in aviUtils.js (shared with Word Input) and
// supports per-card updates via buildUpdates(card).

// ── LemmaCard ────────────────────────────────────────────────
const LemmaCard = memo(function LemmaCard({ l, lemmaMaster, lemmaSourcesMap, fetching, onSave, onRefetchDef1, onDelete, onLemmaClick, wordInputs, sentenceInputs, onMerge, editingLemmaID, setEditingLemmaID, C, S }) {
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
    // Pills carry the lemma's ID, so the popup anchors on exactly this entry (AS-D24).
    const linked = ids.map(id => ({ id, name: lemmaMaster.find(x => x.lemmaID === id)?.lemma })).filter(x => x.name);
    if (!linked.length) return null;
    return (
      <div style={{ marginTop: '4px' }}>
        <div style={{ fontSize: '9px', color: C.textM, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, marginBottom: '3px' }}>{label}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
          {linked.map(({ id, name }) => (
            <span key={id} onClick={e => { e.stopPropagation(); if (onLemmaClick) onLemmaClick(name, id); }} style={{ fontSize: '11px', color: C.tL, cursor: 'pointer', background: `${C.tL}18`, borderRadius: '3px', padding: '1px 6px', fontFamily: SH.fk }}>
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
                onClick={() => onLemmaClick && onLemmaClick(l.lemma, l.lemmaID)}
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
            onClick={() => onLemmaClick && onLemmaClick(l.lemma, l.lemmaID)}
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
  lmFilter, setLmFilter, lmChips, setLmChips,
  goToSearch,
  // AS5b: source context and card plumbing for the popup's "Add to Word Input"
  currentSource, currentSection, aviSources, aviSections, decks, updateDecks, dsh,
}) {
  const { C, S } = useAppTheme();
  const uid = auth.currentUser?.uid;

  // Filter text and maintenance chips live in AVIPage (AS-D24) so they stay
  // paired with lmPage across tab switches; local state is only a fallback.
  const [localFilter, setLocalFilter] = useState('');
  const [localChips,  setLocalChips]  = useState({ noDef2: false, noSource: false });
  const filterText    = lmFilter    ?? localFilter;
  const setFilterText = setLmFilter ?? setLocalFilter;
  const chips         = lmChips     ?? localChips;
  const setChips      = setLmChips  ?? setLocalChips;
  // The list follows the typed text after a short pause (AS-D22).
  const [filter, setFilter] = useState(filterText);
  useEffect(() => {
    const t = setTimeout(() => setFilter(filterText), 150);
    return () => clearTimeout(t);
  }, [filterText]);
  const setFilterNow = (v) => { setFilterText(v); setFilter(v); };

  const [fetching,    setFetching]    = useState(null);
  const [lemmaPopup,  setLemmaPopup]  = useState(null); // { query, id } to open the popup on
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

  // ── Filtered + sorted list (AS-D22, AS-D26) ──────────────────
  // Literal matching in tiers (Korean: exact → starts with → contains →
  // definition text; English: def2 → def1), the user's sort order within each
  // tier, then the No def2 / No source chips.
  const index   = useMemo(() => buildLemmaIndex(data.lemmaMaster), [data.lemmaMaster]);
  const literal = useMemo(() => filterLemmaMaster(index, filter), [index, filter]);
  const filtered = useMemo(() => {
    const applyOrder = (arr) => {
      if (sortOrder === 'alpha') {
        return [...arr].sort((a, b) => (a.lemma || '').localeCompare(b.lemma || '', 'ko'));
      }
      return [...arr].sort((a, b) => (b.lastUpdated || '').localeCompare(a.lastUpdated || ''));
    };
    const keep = (l) =>
      (!chips.noDef2   || !String(l.def2 || '').trim()) &&
      (!chips.noSource || !(lemmaSourcesMap[normalizeLemma(l.lemma) || ''] || []).length);
    // No filter text: every entry, exactly as stored (not just indexable ones).
    const tiers = literal.mode === 'all' ? [data.lemmaMaster] : literal.tiers.map(t => t.map(e => e.ref));
    return tiers.flatMap(t => applyOrder(t.filter(keep)));
  }, [literal, data.lemmaMaster, chips, lemmaSourcesMap, sortOrder]);
  const isFiltering = !!filter || chips.noDef2 || chips.noSource;

  // ── "Did you mean" fallback (AS-D23) ─────────────────────────
  // Only when Korean text matches nothing literally. Surface forms and the
  // engine's suggestions are instant; the global lemma map reads Firestore,
  // so it waits for a longer pause and remembers each answer.
  const surfaceMap = useMemo(
    () => buildSurfaceMap(data.wordInputs, data.sentenceInputs),
    [data.wordInputs, data.sentenceInputs]
  );
  const localHeadwords = useMemo(() => {
    const set = new Set();
    for (const l of data.lemmaMaster) { if (l.lemma) set.add(l.lemma); if (l.cleanedLemma) set.add(l.cleanedLemma); }
    return set;
  }, [data.lemmaMaster]);
  const needsFuzzy = literal.mode === 'ko' && literal.total === 0;
  const [dictHit, setDictHit] = useState(null);   // { query, lemmaID, lemma } | null
  const dictCache = useRef(new Map());
  useEffect(() => {
    if (!needsFuzzy) return undefined;
    const q = filter;
    if (dictCache.current.has(q)) { setDictHit(dictCache.current.get(q)); return undefined; }
    let cancelled = false;
    const t = setTimeout(async () => {
      let hit = null;
      try {
        const lemma = await resolveLemmaWithDictionary(q, { localHeadwords });
        const e = lemma ? findByLemmaText(index, lemma) : null;
        hit = e ? { query: q, lemmaID: e.id, lemma: e.lemma } : null;
      } catch { hit = null; }
      dictCache.current.set(q, hit);
      if (!cancelled) setDictHit(hit);
    }, 600);
    return () => { cancelled = true; clearTimeout(t); };
  }, [needsFuzzy, filter, index, localHeadwords]);
  const fuzzy = useMemo(() => {
    if (!needsFuzzy) return [];
    const out = [];
    const seen = new Set();
    const push = (lemmaID, lemma, label) => { if (!seen.has(lemmaID)) { seen.add(lemmaID); out.push({ lemmaID, lemma, label }); } };
    const r = resolveKorean(index, filter, { surfaceMap });
    if (r.entry) push(r.entry.id, r.entry.lemma, 'from your input');
    if (dictHit && dictHit.query === filter) push(dictHit.lemmaID, dictHit.lemma, 'dictionary form');
    for (const s of suggestLemmas(index, filter, { limit: 8 })) push(s.lemmaID, s.lemma, SUGGESTION_KIND_LABEL[s.kind]);
    return out.slice(0, 8);
  }, [needsFuzzy, index, filter, surfaceMap, dictHit]);

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

  // Reset to page 0 when the filter or sort actually changes — not on mount.
  // lmPage is lifted into AVIPage so the position survives tab switches; a
  // mount-time reset threw that away every time the tab opened.
  const prevFilterSortRef = useRef({ filter, sortOrder, noDef2: chips.noDef2, noSource: chips.noSource });
  useEffect(() => {
    const prev = prevFilterSortRef.current;
    if (prev.filter === filter && prev.sortOrder === sortOrder &&
        prev.noDef2 === chips.noDef2 && prev.noSource === chips.noSource) return;
    prevFilterSortRef.current = { filter, sortOrder, noDef2: chips.noDef2, noSource: chips.noSource };
    setLmPage(0);
  }, [filter, sortOrder, chips.noDef2, chips.noSource, setLmPage]);

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

      // Saved Echo alternates (X1, E-D18): the union of both entries'.
      // The field is only written when there is something to keep.
      const altsOf = (e) => (Array.isArray(e?.echoAlternates) ? e.echoAlternates : []);

      const mergedLemmaMaster = prev.lemmaMaster
        .filter(l => l.lemmaID !== editedLemmaID)
        .map(l => {
          if (l.lemmaID !== survivingLemmaID) return l;
          const alternates = [...new Set([...altsOf(l), ...altsOf(edited)])];
          return {
            ...l,
            def2:           survivingDef2,
            relatedForm:    mergeField(l.relatedForm,    edited.relatedForm),
            relatedMeaning: mergeField(l.relatedMeaning, edited.relatedMeaning),
            hiddenRelated:  mergeField(l.hiddenRelated,  edited.hiddenRelated),
            ...(alternates.length ? { echoAlternates: alternates } : {}),
            lastUpdated:    now,
            autoAddedBy:    'manual',
          };
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

      // The chosen def2 must also reach the survivor's own pre-existing rows.
      // Without this, a def2 picked in the merge lands on the Lemma Master
      // entry and the reassigned rows but silently skips rows already on the
      // surviving lemma, leaving them permanently desynced with no Recent
      // entry. Rows the block above already set to survivingDef2 are skipped
      // by the equality guard, so nothing is double-unchecked.
      const survivorNorm        = normalizeLemma(survivor.lemma);
      const survivorDef2Changed = (survivingDef2 || '') !== (survivor.def2 || '');
      const cascadedWordInputs  = !survivorDef2Changed ? mergedWordInputs : mergedWordInputs.map(w => {
        if (normalizeLemma(w.lemma) !== survivorNorm) return w;
        if ((w.def2 || '') === (survivingDef2 || '')) return w;
        return {
          ...w,
          def2: survivingDef2 || '',
          ...(w.uploaded ? {
            uploaded: false, lastUncheckReason: 'Definition 2 chosen in merge', lastUncheckDate: now,
          } : {}),
        };
      });

      // The edited lemma's wordInputs row (if it had its own 동의어/유의어 capture)
      // just got relabeled to the survivor's lemma above — if the survivor already
      // had its own capture too, this collapses the resulting duplicate down to
      // one, and otherwise adds/removes based on the merged relatedMeaning.
      const { wordInputs: finalWordInputs, added, removed } = syncNuanceSource(
        cascadedWordInputs, mergedLemmaMaster, [survivingLemmaID]
      );
      if (added.length)   showAVIToast(`Added to 동의어/유의어: ${added.join(', ')}`, 'goToNuanceSource');
      if (removed.length) showAVIToast(`Removed from 동의어/유의어: ${removed.join(', ')}`, 'goToNuanceSource');

      return {
        ...prev,
        lemmaMaster: mergedLemmaMaster,
        wordInputs: finalWordInputs,
        sentenceInputs: prev.sentenceInputs.map(s => {
          const norm = normalizeLemma(s.targetWord);
          if (norm === editedNorm) {
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
          }
          // Survivor's own sentence rows follow the chosen def2 too (mirror
          // of the word-row cascade above).
          if (survivorDef2Changed && norm === survivorNorm) {
            const cardBack = survivingDef2 || survivor.def1 || s.cardBack;
            const changed  = cardBack !== s.cardBack;
            if (!changed) return s;
            return {
              ...s, cardBack,
              ...(s.uploaded ? {
                uploaded: false, lastUncheckReason: 'Definition 2 chosen in merge', lastUncheckDate: now,
              } : {}),
            };
          }
          return s;
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

      // Survivor's own linked cards adopt the chosen def2 as back too —
      // the block above only reaches cards linked to the deleted entry.
      if (survivingDef2 && survivingDef2 !== (survivorPre.def2 || '')) {
        updateLinkedCards({
          lemmaID: survivingLemmaID, lemmaText: survivorPre.lemma,
          updates: { back: survivingDef2 },
          cards, uid, updateCards,
        }).catch(e => console.error('LM merge: survivor card update failed', e));
      }
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
    // Saved Echo alternates (X1, E-D18): a kept entry keeps its own plus those
    // of every duplicate folded into it.
    const altsOf = (e) => (Array.isArray(e?.echoAlternates) ? e.echoAlternates : []);
    const foldedAlts = {};
    for (const l of data.lemmaMaster) {
      const to = idRemap[l.lemmaID];
      if (to && altsOf(l).length) foldedAlts[to] = [...(foldedAlts[to] || []), ...altsOf(l)];
    }
    const remappedKept = kept.map(l => {
      const alternates = [...new Set([...altsOf(l), ...(foldedAlts[l.lemmaID] || [])])];
      return {
        ...l,
        relatedForm:    remapField(l, 'relatedForm'),
        relatedMeaning: remapField(l, 'relatedMeaning'),
        hiddenRelated:  remapField(l, 'hiddenRelated'),
        ...(alternates.length ? { echoAlternates: alternates } : {}),
      };
    });
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
        <div style={{ position: 'relative', flex: 1, minWidth: '160px', display: 'flex' }}>
          <input
            style={{ flex: 1, minWidth: 0, padding: '6px 28px 6px 10px', borderRadius: '6px', border: `1px solid ${C.border}`, background: C.bg, color: C.text, fontSize: isMobile ? '16px' : '13px', outline: 'none' }}
            placeholder="Filter lemmas…"
            value={filterText}
            onChange={e => setFilterText(e.target.value)}
          />
          {filterText && (
            <button onClick={() => setFilterNow('')} title="Clear filter" style={{ position: 'absolute', right: '4px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: C.textM, cursor: 'pointer', fontSize: '13px', padding: '2px 6px', lineHeight: 1 }}>✕</button>
          )}
        </div>
        {/* Maintenance chips (AS-D26) — combine with each other and the text */}
        {[['noDef2', 'No def2'], ['noSource', 'No source']].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setChips(prev => ({ ...prev, [key]: !prev[key] }))}
            title={key === 'noDef2' ? 'Only entries without a Definition 2' : 'Only entries no Word Input or Sentence Input row uses'}
            style={{ padding: '5px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: 600, border: `1px solid ${chips[key] ? C.accent : C.border}`, background: chips[key] ? C.accentSoft : 'transparent', color: chips[key] ? C.accent : C.textM, cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            {label}
          </button>
        ))}
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
          {isFiltering ? `${filtered.length} of ${data.lemmaMaster.length}` : `${data.lemmaMaster.length} entries`}
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
        {filtered.length === 0 && !needsFuzzy && (
          <div style={{ padding: '24px', textAlign: 'center', color: C.textM, fontSize: '13px' }}>
            {literal.total > 0 ? 'No lemmas match these filters.' : 'No lemmas found.'}
          </div>
        )}
        {needsFuzzy && (
          <div style={{ padding: '14px', border: `1px solid ${C.border}`, borderRadius: '10px', background: C.surface, marginBottom: '8px' }}>
            <div style={{ fontSize: '13px', color: C.text, marginBottom: fuzzy.length ? '8px' : 0 }}>
              No lemma matches <span style={{ fontFamily: SH.fk, fontWeight: 700 }}>{filter}</span>.
              {fuzzy.length > 0 ? ' Did you mean:' : <span style={{ color: C.textM }}> Nothing similar in your Lemma Master.</span>}
            </div>
            {fuzzy.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {fuzzy.map(s => (
                  <button key={s.lemmaID} onClick={() => setFilterNow(s.lemma)} style={{ display: 'inline-flex', alignItems: 'baseline', gap: '6px', padding: '5px 10px', borderRadius: '16px', border: `1px solid ${C.border}`, background: C.raised, color: C.text, cursor: 'pointer' }}>
                    <span style={{ fontFamily: SH.fk, fontSize: '13px', fontWeight: 600, color: C.accent }}>{s.lemma}</span>
                    <span style={{ fontSize: '10px', color: C.textM }}>{s.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
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
                      onLemmaClick={(term, id) => setLemmaPopup({ query: term, id })}
                      wordInputs={data.wordInputs}
                      sentenceInputs={data.sentenceInputs}
                      onMerge={handleMerge}
                      editingLemmaID={editingLemmaID}
                      setEditingLemmaID={setEditingLemmaID}
                      C={C}
                      S={S}
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

      {/* Similarity search popup (shared with Word Input) */}
      {lemmaPopup && (
        <AVIMiniSearchPopup
          initialQuery={lemmaPopup.query}
          initialLemmaID={lemmaPopup.id}
          data={data}
          updateData={updateData}
          onClose={() => setLemmaPopup(null)}
          onOpenInSearch={goToSearch ? (q) => { setLemmaPopup(null); goToSearch(q); } : undefined}
          showAVIToast={showAVIToast}
          staging={{ currentSource, currentSection, aviSources, aviSections, cards, decks, updateCards, updateDecks, dsh }}
        />
      )}
    </div>
  );
}

