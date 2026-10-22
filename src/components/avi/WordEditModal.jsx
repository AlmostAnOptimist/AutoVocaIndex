// src/components/avi/WordEditModal.jsx
// Shared word-row edit modal: Word Input row editing, reused by the Import
// tab's post-commit Fill-Def2 pass. Wide horizontal layout behind a scrim.
// Saves on the Save button, on scrim click, or when paging to another
// def2-less row; Escape or Cancel discards the current edits.
// Rendered through createPortal(document.body) so no ancestor transform or
// backdrop-filter can trap the fixed overlay (.fade-up containing-block trap).

import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAppTheme } from '../../hooks/useAppTheme.js';
import { SH } from '../../theme/buildStyles.js';
import { Def1Display } from './Def1Display.jsx';
import { LemmaAutocompleteInput } from './LemmaAutocompleteInput.jsx';
import { normalizeLemma, isRealDefinition } from '../../utils/aviUtils.js';

const isMobile = typeof window !== 'undefined' && (window.innerWidth <= 700 || window.matchMedia('(hover: none) and (pointer: coarse) and (orientation: portrait)').matches);

export function WordEditModal({
  rows,          // ordered array of word rows the modal can page across
  uid,           // uid of the row being edited (parent should key the modal by this)
  onSelectRow,   // (uid) => void — move the modal to another row
  updateRow,     // async (uid, edits) => void — the shared cascade
  toggleSkip,    // (uid, val) => void
  lemmaMaster,
  onClose,
}) {
  const { C, S } = useAppTheme();
  const row = rows.find(r => r.uid === uid);

  // `initial` is what the fields held when the modal opened. Dirty-checking
  // and saving work against it, not against the live row: the post-import
  // Def1 fill can update the row while the modal is open, and comparing to
  // the live row made untouched fields look edited — paging then wrote the
  // stale (often blank) def1 back over the fresh one and cascaded the blank
  // to Lemma Master. Only fields the user actually changed are saved.
  const [initial] = useState(() => ({
    lemma: row?.lemma || '', def1: row?.def1 || '', def2: row?.def2 || '',
  }));
  const [editVal, setEditVal] = useState(initial);
  const [def1Editing, setDef1Editing] = useState(false);
  const [saving, setSaving] = useState(false);
  // A3: def2 is sent only when typed here or picked in the choice panel;
  // otherwise the shared cascade decides (planLemmaCorrection).
  const [def2Typed, setDef2Typed] = useState(false);
  const [def2Pick, setDef2Pick] = useState(null); // { norm, key, value }
  const [flagChoice, setFlagChoice] = useState(false);

  // Escape discards
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // A3: correcting the lemma to one whose def2 differs from this row's asks
  // which def2 to use, like a Lemma Master merge. Typing a def2 here also
  // settles it. The pick belongs to the lemma it was made for.
  const curNorm          = normalizeLemma(editVal.lemma);
  const lemmaCorrected   = !!editVal.lemma && curNorm !== normalizeLemma(initial.lemma);
  const correctionTarget = lemmaCorrected
    ? (lemmaMaster || []).find(l => normalizeLemma(l.lemma) === curNorm) || null
    : null;
  const needsDef2Choice  = lemmaCorrected && !!initial.def2 && (correctionTarget?.def2 || '') !== initial.def2;
  const pickValid        = !!def2Pick && def2Pick.norm === curNorm;
  const def2Settled      = !needsDef2Choice || def2Typed || pickValid;
  const def2Options      = needsDef2Choice ? [
    { key: 'keep', tag: `Current, from ${initial.lemma}`, value: initial.def2 },
    correctionTarget?.def2
      ? { key: 'target', tag: `From ${correctionTarget.lemma}`, value: correctionTarget.def2 }
      : { key: 'clear', tag: 'Clear', value: '', note: 'No def2: the row waits for a new one' },
  ] : [];
  // What the Definition fields show without being typed in: the pick, or
  // the corrected lemma's entry, or the row's own.
  const def2Shown = def2Typed ? editVal.def2
    : pickValid ? def2Pick.value
    : lemmaCorrected && !needsDef2Choice ? (correctionTarget?.def2 || initial.def2)
    : initial.def2;
  const def1Shown = editVal.def1 !== initial.def1 ? editVal.def1
    : isRealDefinition(correctionTarget?.def1) ? correctionTarget.def1
    : (row?.def1 || '');

  const def2Out = def2Typed ? editVal.def2 : pickValid ? def2Pick.value : undefined;
  const changed = {};
  if (editVal.lemma !== initial.lemma) changed.lemma = editVal.lemma;
  if (editVal.def1  !== initial.def1)  changed.def1  = editVal.def1;
  if (def2Out !== undefined && (def2Out !== initial.def2 || lemmaCorrected)) changed.def2 = def2Out;
  const dirty = !!row && Object.keys(changed).length > 0;

  // Returns false when the save is held for the def2 choice.
  const save = useCallback(async () => {
    if (!row || !dirty || saving) return true;
    if (!def2Settled) { setFlagChoice(true); return false; }
    setSaving(true);
    try { await updateRow(row.uid, changed); }
    finally { setSaving(false); }
    return true;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row, dirty, saving, updateRow, editVal, def2Typed, def2Pick, def2Settled]);

  const saveAndClose = async () => { if (await save()) onClose(); };

  if (!row) return null;

  // Def2-less paging across the provided row order
  const idx        = rows.findIndex(r => r.uid === uid);
  const prevTarget = [...rows.slice(0, Math.max(idx, 0))].reverse().find(r => !r.def2);
  const nextTarget = rows.slice(idx + 1).find(r => !r.def2);
  const remaining  = rows.filter(r => !r.def2 && r.uid !== uid).length;

  const goTo = async (target) => {
    if (!target || saving) return;
    if (!(await save())) return;
    onSelectRow(target.uid);
  };

  const label = {
    fontSize: '9.5px', fontWeight: 700, color: C.textM,
    textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px',
  };
  const inputStyle = {
    width: '100%', padding: '6px 8px', borderRadius: '6px',
    fontSize: isMobile ? '16px' : '13px',
    border: `1px solid ${C.border}`, background: C.bg, color: C.text,
    outline: 'none', fontFamily: SH.fk, boxSizing: 'border-box',
  };
  const areaStyle = {
    ...inputStyle, resize: 'vertical',
    minHeight: isMobile ? '84px' : '120px', lineHeight: 1.5,
  };
  const pagerBtn = (disabled) => ({
    padding: '5px 10px', borderRadius: '6px', fontSize: '12px', fontWeight: 600,
    border: `1px solid ${C.border}`, background: 'transparent',
    color: disabled ? C.textM : C.text, cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.45 : 1,
  });

  return createPortal(
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
        zIndex: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={saveAndClose}
    >
      <div
        style={{
          background: C.surface, border: `1px solid ${C.border}`, borderRadius: '12px',
          padding: isMobile ? '16px' : '20px 22px',
          width: 'min(920px, calc(100vw - 40px))', maxHeight: '86vh',
          overflowY: 'auto', boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
          display: 'flex', flexDirection: 'column', gap: '14px',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header: surface form, source badge, close */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontFamily: SH.fk, fontWeight: 700, fontSize: '16px', color: C.text }}>
            {row.input}
          </span>
          <span style={{
            display: 'inline-block', padding: '2px 7px', borderRadius: '4px',
            fontSize: '11px', background: C.accentSoft, color: C.accent, fontFamily: SH.fm,
          }}>
            {row.source}{row.section ? ` · §${row.section}` : ''}
          </span>
          <button
            onClick={onClose}
            title="Close without saving (Esc)"
            style={{ marginLeft: 'auto', background: 'none', border: 'none', color: C.textM, fontSize: '18px', cursor: 'pointer', lineHeight: 1 }}
          >
            ✕
          </button>
        </div>

        {/* Body: Lemma | Definition 1 | Definition 2 */}
        <div style={{
          display: 'grid', gap: '16px',
          gridTemplateColumns: isMobile ? '1fr' : 'minmax(160px, 220px) 1fr 1fr',
          alignItems: 'start',
        }}>
          <div>
            <div style={label}>Lemma</div>
            <LemmaAutocompleteInput
              value={editVal.lemma}
              onChange={val => setEditVal(v => ({ ...v, lemma: val }))}
              // L4a: picking an existing Lemma Master entry brings its
              // definitions with it. A3: they show through def1Shown /
              // def2Shown rather than being copied into the fields, so they
              // are not saved as typed values, and a different def2 on the
              // row asks for a choice first.
              onSelectExisting={l => setEditVal(v => ({ ...v, lemma: l.lemma }))}
              lemmaMaster={lemmaMaster}
              inputStyle={inputStyle}
              lang="ko"
              C={C}
            />
          </div>
          <div>
            <div style={label}>Definition 1</div>
            {def1Editing
              ? <textarea
                  style={areaStyle}
                  value={editVal.def1}
                  onChange={e => setEditVal(v => ({ ...v, def1: e.target.value }))}
                  autoFocus
                />
              : <div style={{ minHeight: '24px' }}>
                  <Def1Display
                    // Untouched Def1 shows the live row, so a definition the
                    // background fill delivers while the modal is open appears
                    // (or the corrected lemma's real def1, A3).
                    text={def1Shown}
                    onClick={() => {
                      if (editVal.def1 === initial.def1) setEditVal(v => ({ ...v, def1: def1Shown }));
                      setDef1Editing(true);
                    }}
                  />
                </div>
            }
          </div>
          <div>
            <div style={label}>Definition 2</div>
            <textarea
              style={areaStyle}
              value={def2Shown}
              onChange={e => { setDef2Typed(true); setFlagChoice(false); setEditVal(v => ({ ...v, def2: e.target.value })); }}
              placeholder="Your own definition — creates the flashcard"
            />
          </div>
        </div>

        {/* A3: def2 choice when a lemma correction meets a different def2 */}
        {needsDef2Choice && !def2Typed && (
          <div style={{
            border: `1px solid ${flagChoice && !def2Settled ? (C.danger || '#c0392b') : C.border}`,
            borderRadius: '8px', padding: '12px 14px', background: C.raised,
          }}>
            <div style={label}>Choose Definition 2 for {editVal.lemma}</div>
            <div style={{ fontSize: '12px', color: flagChoice && !def2Settled ? (C.danger || '#c0392b') : C.textM, marginBottom: '10px', lineHeight: 1.5 }}>
              {correctionTarget?.def2
                ? `${correctionTarget.lemma} already has a different def2. The one you pick is used for this row, the Lemma Master entry and their cards.`
                : `${editVal.lemma} has no def2 yet. Keep this row's, or clear it and write a new one.`}
              {flagChoice && !def2Settled ? ' Pick one to save.' : ''}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '10px' }}>
              {def2Options.map(o => {
                const isChosen = pickValid && def2Pick.key === o.key;
                return (
                  <div key={o.key} style={{
                    border: `2px solid ${isChosen ? C.accent : C.border}`,
                    borderRadius: '8px', padding: '10px 12px',
                    background: isChosen ? C.accentSoft : C.surface,
                    display: 'flex', flexDirection: 'column', gap: '8px',
                  }}>
                    <div style={{ fontSize: '10px', color: C.textM, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      {o.tag}
                    </div>
                    <div style={{ fontSize: '12px', color: o.value ? C.text : C.textM, lineHeight: 1.5, flex: 1, whiteSpace: 'pre-wrap', fontFamily: SH.fk }}>
                      {o.value || o.note}
                    </div>
                    <button
                      onClick={() => { setDef2Pick({ norm: curNorm, key: o.key, value: o.value }); setFlagChoice(false); }}
                      style={{
                        alignSelf: 'flex-start', padding: '5px 10px', borderRadius: '5px', fontSize: '11px', fontWeight: 600,
                        border: `1px solid ${isChosen ? C.accent : C.border}`,
                        background: isChosen ? C.accent : 'transparent',
                        color: isChosen ? '#fff' : C.textM, cursor: 'pointer',
                      }}
                    >
                      {isChosen ? 'Selected' : 'Use this'}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Footer: skip, def2-less pager, save/cancel */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
          borderTop: `1px solid ${C.border}`, paddingTop: '12px',
        }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: C.textM, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!row.skipUpload}
              onChange={e => toggleSkip(row.uid, e.target.checked)}
              style={{ accentColor: C.accent, cursor: 'pointer' }}
            />
            Skip — no flashcard for this entry
          </label>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button style={pagerBtn(!prevTarget || saving)} disabled={!prevTarget || saving} onClick={() => goTo(prevTarget)}>
              ◀ Prev
            </button>
            <span style={{ fontSize: '11px', color: C.textM, fontFamily: SH.fm, whiteSpace: 'nowrap' }}>
              {remaining} other def2-less
            </span>
            <button style={pagerBtn(!nextTarget || saving)} disabled={!nextTarget || saving} onClick={() => goTo(nextTarget)}>
              Next ▶
            </button>
          </div>

          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              style={{ padding: '7px 14px', borderRadius: '6px', fontSize: '12px', background: 'transparent', color: C.textM, border: `1px solid ${C.border}`, cursor: 'pointer' }}
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              style={{ ...S.btnPrimary, padding: '7px 16px', borderRadius: '6px', fontSize: '12px', fontWeight: 700, opacity: saving ? 0.6 : 1 }}
              disabled={saving}
              onClick={saveAndClose}
            >
              {saving ? 'Saving…' : 'Save & Close'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}