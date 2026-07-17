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

const isMobile = typeof window !== 'undefined' && window.innerWidth <= 700;

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

  const [editVal, setEditVal] = useState(() => ({
    lemma: row?.lemma || '', def1: row?.def1 || '', def2: row?.def2 || '',
  }));
  const [def1Editing, setDef1Editing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Escape discards
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const dirty = !!row && (
    editVal.lemma !== (row.lemma || '') ||
    editVal.def1  !== (row.def1  || '') ||
    editVal.def2  !== (row.def2  || '')
  );

  const save = useCallback(async () => {
    if (!row || !dirty || saving) return;
    setSaving(true);
    try { await updateRow(row.uid, { ...editVal }); }
    finally { setSaving(false); }
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
                  <Def1Display text={editVal.def1} onClick={() => setDef1Editing(true)} />
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