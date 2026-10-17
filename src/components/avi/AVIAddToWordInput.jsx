// src/components/avi/AVIAddToWordInput.jsx
// AS5b (AS-D27 of the AVI search overhaul): the two actions a
// Korean search offers when nothing in the Lemma Master matches exactly —
// shared by the Search tab and AVIMiniSearchPopup.
//
//   Look up definition — runs only on click (no API call is spent while
//     browsing). Resolves the query the way staging would and fetches def1
//     with the same Tier 2 fallback and the dictionary mode in Settings, so
//     the preview shows the lemma and definition "Add" would create.
//   Add to Word Input — opens a confirm dialog. The source is never assumed:
//     it starts at the top-bar source but is always shown and changeable,
//     the section is required when the chosen source has sections, and the
//     confirm button names the destination. Choosing another source here
//     does not touch the top bar. Staging runs through stageWordInput, the
//     same pipeline as Word Input (duplicate guard, lemma resolution, def1,
//     Lemma Master entry, auto flashcard in the CHOSEN source's deck).
//
// `staging` carries the host's source context and card plumbing:
//   { currentSource, currentSection, aviSources, aviSections,
//     cards, decks, updateCards, updateDecks, dsh }
// Without it the Add action is hidden and only Look up is offered.
// Demo: the Add action is hidden too (word intake flows through the
// Sentence Input picker, as on the Word Input page, D5).
// `onStaged({ lemmaID, row, isNewLemma, dest })` lets the host pivot onto
// the lemma and confirm the add; `onPickLemma(lemmaID)` re-anchors on an
// existing entry (a duplicate's lemma, or a lookup that turns out to be in
// the Lemma Master already).

import { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useAppTheme } from '../../hooks/useAppTheme.js';
import { SH } from '../../theme/buildStyles.js';
import { DEMO } from '../../demo/demoConfig.js';
import { Icons } from '../Icons.jsx';
import { Def1Display } from './Def1Display.jsx';
import { AVISourceSearchSelect } from './AVISourceSearchSelect.jsx';
import { auth } from '../../firebase.js';
import {
  normalizeLemma, cleanStagingText, getSourceSections,
  resolveLemmaWithDictionary, fetchDefinitionWithFallback,
} from '../../utils/aviUtils.js';
import { stageWordInput } from '../../utils/wordStaging.js';

const isMobile = typeof window !== 'undefined' && (window.innerWidth <= 700 || window.matchMedia('(hover: none) and (pointer: coarse) and (orientation: portrait)').matches);

// "A §3" or "A" — how a destination reads in the button and messages.
export function stagingDest(source, section) {
  return section ? `${source} §${section}` : source;
}

// Lemma Master entry for a lemma text, matched the way staging links rows.
function findLemmaEntry(lemmaMaster, lemmaText) {
  if (!lemmaText) return null;
  const norm = normalizeLemma(lemmaText);
  return (lemmaMaster || []).find(l =>
    l.cleanedLemma === norm || l.lemma === lemmaText || normalizeLemma(l.lemma) === norm
  ) || null;
}

// ── Confirm dialog ───────────────────────────────────────────
export function AddToWordInputDialog({ initialSurface, data, updateData, staging, showAVIToast, onClose, onStaged, onPickLemma }) {
  const { C, S } = useAppTheme();
  const {
    currentSource = '', currentSection = '', aviSources = [], aviSections = [],
    cards, decks = [], updateCards, updateDecks, dsh,
  } = staging;

  const [surface, setSurface] = useState(initialSurface || '');
  const [source,  setSource]  = useState(currentSource || '');
  // The top-bar section only carries over while the top-bar source is chosen.
  const [section, setSection] = useState(currentSource ? (currentSection || '') : '');
  const [busy,    setBusy]    = useState(false);
  const [notice,  setNotice]  = useState(null);   // { kind: 'duplicate' | 'empty' | 'error', ... }

  const sections     = useMemo(() => getSourceSections(aviSources, aviSections, source), [aviSources, aviSections, source]);
  const needsSection = sections.length > 0 && !section;
  const canConfirm   = !busy && !!surface.trim() && !!source && !needsSection;

  const chooseSource = (title) => {
    setSource(title);
    setSection(title && title === currentSource ? (currentSection || '') : '');
    setNotice(null);
  };

  const confirm = async () => {
    if (!canConfirm) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await stageWordInput({
        surface: surface.trim(), source, section,
        data, updateData,
        cards, decks, uid: auth.currentUser?.uid, updateCards, updateDecks, aviSources, dsh,
        showAVIToast,
        logPrefix: 'Search: Add to Word Input',
      });
      if (result.status === 'empty') {
        setNotice({ kind: 'empty' });
      } else if (result.status === 'duplicate') {
        const entry = findLemmaEntry(data.lemmaMaster, result.row.lemma);
        setNotice({ kind: 'duplicate', row: result.row, lemmaID: entry?.lemmaID || null });
      } else {
        onStaged?.({ lemmaID: result.lemmaID, row: result.row, isNewLemma: result.isNewLemma, dest: stagingDest(source, section) });
        onClose();
        return;
      }
    } catch (e) {
      console.error('Search: Add to Word Input failed', e);
      setNotice({ kind: 'error' });
    }
    setBusy(false);
  };

  const fieldLabel = { fontSize: '11px', fontWeight: 700, color: C.textM, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' };
  const fieldInput = { width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: '6px', border: `1px solid ${C.border}`, background: C.bg, color: C.text, fontSize: isMobile ? '16px' : '13px', outline: 'none' };
  const confirmLabel = busy ? 'Adding…'
    : !source      ? 'Choose a source'
    : section      ? `Add to ${source} · §${section}`
    : needsSection ? `Add to ${source} · choose a section`
    : `Add to ${source}`;

  return createPortal(
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 900, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={() => { if (!busy) onClose(); }}
    >
      <div
        role="dialog"
        aria-label="Add to Word Input"
        style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: '12px', padding: '20px', width: 'min(92vw, 440px)', maxHeight: '86vh', overflowY: 'auto', boxShadow: '0 8px 40px rgba(0,0,0,0.5)' }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
          <span style={{ fontFamily: SH.fd, fontWeight: 700, fontSize: '14px', color: C.text }}>Add to Word Input</span>
          <button onClick={onClose} disabled={busy} title="Close" style={{ background: 'none', border: 'none', color: C.textM, fontSize: '18px', cursor: busy ? 'default' : 'pointer' }}>✕</button>
        </div>

        <div style={{ marginBottom: '12px' }}>
          <div style={fieldLabel}>Word</div>
          <input
            value={surface}
            onChange={e => { setSurface(e.target.value); setNotice(null); }}
            onKeyDown={e => e.key === 'Enter' && !e.nativeEvent.isComposing && confirm()}
            style={{ ...fieldInput, fontFamily: SH.fk }}
          />
        </div>

        <div style={{ marginBottom: '12px' }}>
          <div style={fieldLabel}>Source</div>
          <AVISourceSearchSelect
            sources={aviSources}
            value={source}
            onChange={chooseSource}
            excludePassive
            inputStyle={{ fontSize: isMobile ? '16px' : '13px', padding: '7px 10px', background: C.bg }}
            C={C}
          />
          {source && source !== currentSource && (
            <div style={{ fontSize: '11px', color: C.textM, marginTop: '4px' }}>
              Not the top-bar source{currentSource ? ` (${currentSource})` : ''}. The top bar stays as it is.
            </div>
          )}
        </div>

        {sections.length > 0 && (
          <div style={{ marginBottom: '12px' }}>
            <div style={fieldLabel}>Section</div>
            <select
              value={section}
              onChange={e => { setSection(e.target.value); setNotice(null); }}
              style={{ ...fieldInput, cursor: 'pointer', borderColor: needsSection ? C.warning : C.border }}
            >
              <option value="">— Choose a section —</option>
              {sections.map(s => <option key={s.id} value={s.content}>{s.content}</option>)}
            </select>
            {needsSection && <div style={{ fontSize: '11px', color: C.warning, marginTop: '4px' }}>{source} has sections. Choose one.</div>}
          </div>
        )}

        {notice?.kind === 'duplicate' && (
          <div style={{ marginBottom: '12px', padding: '8px 10px', borderRadius: '8px', border: `1px solid ${C.warning}`, background: `${C.warning}12`, fontSize: '12px', color: C.text, lineHeight: 1.5 }}>
            <span style={{ fontFamily: SH.fk, fontWeight: 700 }}>{notice.row.input}</span> is already in Word Input for {stagingDest(source, section)}
            {notice.row.lemma ? <> (lemma <span style={{ fontFamily: SH.fk }}>{notice.row.lemma}</span>)</> : null}. No new row was added.
            {notice.lemmaID && onPickLemma && (
              <div style={{ marginTop: '6px' }}>
                <button onClick={() => { onPickLemma(notice.lemmaID); onClose(); }} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', background: 'none', border: 'none', padding: 0, color: C.accent, cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>
                  Search {notice.row.lemma} {Icons.chevronRight}
                </button>
              </div>
            )}
          </div>
        )}
        {notice?.kind === 'empty' && (
          <div style={{ marginBottom: '12px', fontSize: '12px', color: C.danger }}>Nothing is left of this text after cleaning (links and noise blocks are removed).</div>
        )}
        {notice?.kind === 'error' && (
          <div style={{ marginBottom: '12px', fontSize: '12px', color: C.danger }}>Something went wrong while adding the word. Nothing was added; try again.</div>
        )}

        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={confirm}
            disabled={!canConfirm}
            style={{ ...S.btnPrimary, flex: 1, justifyContent: 'center', padding: '10px', borderRadius: '8px', fontSize: '13px', fontWeight: 600, opacity: canConfirm ? 1 : 0.5, cursor: canConfirm ? 'pointer' : 'default' }}
          >
            {confirmLabel}
          </button>
          <button onClick={onClose} disabled={busy} style={{ padding: '10px 16px', borderRadius: '8px', fontSize: '13px', background: C.raised, border: `1px solid ${C.border}`, color: C.text, cursor: busy ? 'default' : 'pointer' }}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── No-match actions (Look up definition + Add to Word Input) ─
// Hosts render this with key={query} so a new search starts fresh.
export function AVINoMatchActions({ query, data, updateData, staging, showAVIToast, onStaged, onPickLemma, compact = false }) {
  const { C } = useAppTheme();
  const [lookup,     setLookup]     = useState(null);  // null | { state: 'loading' } | { state: 'done', lemma, def1, entryID }
  const [dialogOpen, setDialogOpen] = useState(false);

  const doLookup = async () => {
    const cleaned = cleanStagingText(query, data.aviSettings?.noiseBlocks || []);
    if (!cleaned) { setLookup({ state: 'done', lemma: '', def1: '', entryID: null }); return; }
    setLookup({ state: 'loading' });
    let lemma = cleaned, def1 = '';
    try {
      const localHeadwords = new Set();
      for (const l of data.lemmaMaster || []) {
        if (l.lemma) localHeadwords.add(l.lemma);
        if (l.cleanedLemma) localHeadwords.add(l.cleanedLemma);
      }
      lemma = await resolveLemmaWithDictionary(cleaned, { localHeadwords }) || cleaned;
      const fb = await fetchDefinitionWithFallback(cleaned, lemma, data.aviSettings || {});
      lemma = fb.lemma;
      def1  = fb.def1;
    } catch { def1 = ''; }
    setLookup({ state: 'done', lemma, def1, entryID: findLemmaEntry(data.lemmaMaster, lemma)?.lemmaID || null });
  };

  const btn = {
    display: 'inline-flex', alignItems: 'center', gap: '5px',
    padding: compact ? '4px 10px' : '5px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 600,
    border: `1px solid ${C.border}`, background: C.raised, color: C.text, cursor: 'pointer',
  };
  const rateLimited = lookup?.def1 === '__RATE_LIMITED__';
  const notFound    = lookup?.state === 'done' && !rateLimited && (!lookup.def1 || lookup.def1 === 'Definition not found.');

  return (
    <div style={{ marginTop: compact ? '8px' : '10px', paddingTop: compact ? '8px' : '10px', borderTop: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        <button onClick={doLookup} disabled={lookup?.state === 'loading'} style={{ ...btn, opacity: lookup?.state === 'loading' ? 0.6 : 1 }}>
          {Icons.bookOpen} {lookup?.state === 'loading' ? 'Looking up…' : 'Look up definition'}
        </button>
        {staging && !DEMO && (
          <button onClick={() => setDialogOpen(true)} style={{ ...btn, border: `1px solid ${C.accent}`, color: C.accent, background: C.accentSoft }}>
            {Icons.plus} Add to Word Input
          </button>
        )}
      </div>
      {staging && DEMO && (
        <div style={{ marginTop: '6px', fontSize: '11px', color: C.textM, lineHeight: 1.5 }}>
          Word adding is disabled in the demo. Add a sentence in Sentence Input and choose target words there.
        </div>
      )}

      {lookup?.state === 'done' && (
        <div style={{ marginTop: '8px', padding: '8px 10px', borderRadius: '8px', border: `1px solid ${C.border}`, background: C.bg, fontSize: '12px', color: C.text }}>
          {lookup.lemma && (
            <div style={{ marginBottom: '4px', color: C.textM }}>
              <span style={{ fontFamily: SH.fk, fontWeight: 700, fontSize: '13px', color: C.text }}>{lookup.lemma}</span>
              {lookup.lemma !== query.trim() && <span> · dictionary form of <span style={{ fontFamily: SH.fk }}>{query.trim()}</span></span>}
            </div>
          )}
          {rateLimited ? (
            <div style={{ color: C.danger }}>API rate limit reached — switch to KRDict mode in Settings.</div>
          ) : notFound ? (
            <div style={{ color: C.textM }}>No dictionary entry found.</div>
          ) : (
            <Def1Display text={lookup.def1} />
          )}
          {lookup.entryID && onPickLemma && (
            <div style={{ marginTop: '6px' }}>
              <button onClick={() => onPickLemma(lookup.entryID)} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', background: 'none', border: 'none', padding: 0, color: C.accent, cursor: 'pointer', fontSize: '12px', fontWeight: 600 }}>
                Already in your Lemma Master — search {lookup.lemma} {Icons.chevronRight}
              </button>
            </div>
          )}
        </div>
      )}

      {dialogOpen && staging && !DEMO && (
        <AddToWordInputDialog
          initialSurface={query}
          data={data}
          updateData={updateData}
          staging={staging}
          showAVIToast={showAVIToast}
          onClose={() => setDialogOpen(false)}
          onStaged={onStaged}
          onPickLemma={onPickLemma}
        />
      )}
    </div>
  );
}
