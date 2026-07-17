// src/components/avi/SentenceEditModal.jsx
// Edit modal for Sentence Input rows: target word, card back, and skip.
// The sentence itself is shown read-only (rows are keyed to their sentence
// text; changing it would orphan the card matching). Save on the Save button
// or scrim click; Escape or Cancel discards.
// Rendered through createPortal(document.body) — containing-block trap guard.

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAppTheme } from '../../hooks/useAppTheme.js';
import { SH } from '../../theme/buildStyles.js';
import { LemmaAutocompleteInput } from './LemmaAutocompleteInput.jsx';

const isMobile = typeof window !== 'undefined' && window.innerWidth <= 700;

export function SentenceEditModal({ row, lemmaMaster, onSave, onClose }) {
  const { C, S } = useAppTheme();

  const [editVal, setEditVal] = useState(() => ({
    targetWord: row?.targetWord || '',
    cardBack:   row?.cardBack   || '',
    skipUpload: !!row?.skipUpload,
  }));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!row) return null;

  const dirty =
    editVal.targetWord !== (row.targetWord || '') ||
    editVal.cardBack   !== (row.cardBack   || '') ||
    editVal.skipUpload !== !!row.skipUpload;

  const saveAndClose = async () => {
    if (saving) return;
    if (!dirty) { onClose(); return; }
    setSaving(true);
    try { await onSave(row.uid, { ...editVal }); }
    finally { setSaving(false); onClose(); }
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
          width: 'min(720px, calc(100vw - 40px))', maxHeight: '86vh',
          overflowY: 'auto', boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
          display: 'flex', flexDirection: 'column', gap: '14px',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontFamily: SH.fd, fontWeight: 700, fontSize: '14px', color: C.text }}>
            Edit sentence entry
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

        <div>
          <div style={label}>Sentence</div>
          <div style={{ fontFamily: SH.fk, fontSize: '14px', lineHeight: 1.6, color: C.text }}>
            {row.sentence}
          </div>
        </div>

        <div style={{
          display: 'grid', gap: '16px',
          gridTemplateColumns: isMobile ? '1fr' : 'minmax(160px, 220px) 1fr',
          alignItems: 'start',
        }}>
          <div>
            <div style={label}>Target word</div>
            <LemmaAutocompleteInput
              value={editVal.targetWord}
              onChange={val => setEditVal(v => ({ ...v, targetWord: val }))}
              lemmaMaster={lemmaMaster}
              inputStyle={inputStyle}
              lang="ko"
              C={C}
            />
          </div>
          <div>
            <div style={label}>Card back</div>
            <textarea
              style={{ ...inputStyle, resize: 'vertical', minHeight: isMobile ? '84px' : '100px', lineHeight: 1.5 }}
              value={editVal.cardBack}
              onChange={e => setEditVal(v => ({ ...v, cardBack: e.target.value }))}
            />
          </div>
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
          borderTop: `1px solid ${C.border}`, paddingTop: '12px',
        }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: C.textM, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={editVal.skipUpload}
              onChange={e => setEditVal(v => ({ ...v, skipUpload: e.target.checked }))}
              style={{ accentColor: C.accent, cursor: 'pointer' }}
            />
            Skip — no flashcard for this entry
          </label>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
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