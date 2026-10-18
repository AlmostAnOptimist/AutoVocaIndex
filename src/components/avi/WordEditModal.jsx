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

  // Escape discards
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const changed = Object.fromEntries(
    ['lemma', 'def1', 'def2']
      .filter(k => editVal[k] !== initial[k])
      .map(k => [k, editVal[k]])
  );
  const dirty = !!row && Object.keys(changed).length > 0;

  const save = useCallback(async () => {
    if (!row || !dirty || saving) return;
    setSaving(true);
    try { await updateRow(row.uid, changed); }
    finally { setSaving(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row, dirty, saving, updateRow, editVal]);

  const saveAndClose = async () => { await save(); onClose(); };

  if (!row) return null;

  // Def2-less paging across the provided row order
  const idx        = rows.findIndex(r => r.uid === uid);
  const prevTarget = [...rows.slice(0, Math.max(idx, 0))].reverse().find(r => !r.def2);
  const nextTarget = rows.slice(idx + 1).find(r => !r.def2);
  const remaining  = rows.filter(r => !r.def2 && r.uid !== uid).length;

  const goTo = async (target) => {
    if (!target || saving) return;
    await save();
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
              // definitions with it, so the def2 it already has shows here
              // (editable — a change updates Lemma Master on save).
              onSelectExisting={l => setEditVal(v => ({
                ...v,
                lemma: l.lemma,
                def1: l.def1 || v.def1,
                def2: l.def2 || v.def2,
              }))}
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
                    // background fill delivers while the modal is open appears.
                    text={editVal.def1 !== initial.def1 ? editVal.def1 : (row.def1 || '')}
                    onClick={() => {
                      if (editVal.def1 === initial.def1) setEditVal(v => ({ ...v, def1: row.def1 || '' }));
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
              value={editVal.def2}
              onChange={e => setEditVal(v => ({ ...v, def2: e.target.value }))}
              placeholder="Your own definition — creates the flashcard"
            />
          </div>
        </div>

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