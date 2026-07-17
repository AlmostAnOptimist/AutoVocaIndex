// src/components/avi/LemmaAutocompleteInput.jsx
// Shared lemma autocomplete input with portal dropdown.
// Also exports LemmaMergeModal for the Lemma Master merge flow.

import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { normalizeLemma } from '../../utils/aviUtils.js';
import { SH } from '../../theme/buildStyles.js';

// ── Substring matching ────────────────────────────────────────
// Returns all lemmas containing `query` as a substring (min 2 chars).
// Sorted by match position (earlier = first), then Korean alphabetical.
function getMatches(query, lemmaMaster, excludeLemmaID) {
  if (!query || !/[가-힣a-zA-Z0-9]/.test(query)) return [];
  const q = query.toLowerCase();
  const results = [];
  for (const l of lemmaMaster) {
    if (excludeLemmaID && l.lemmaID === excludeLemmaID) continue;
    const lemmaLower = (l.lemma || '').toLowerCase();
    const idx = lemmaLower.indexOf(q);
    if (idx !== -1) results.push({ ...l, _matchIdx: idx });
  }
  results.sort((a, b) =>
    a._matchIdx - b._matchIdx ||
    (a.lemma || '').localeCompare(b.lemma || '', 'ko')
  );
  return results;
}

// ── Portal dropdown ───────────────────────────────────────────
// Receives pre-computed `pos` from LemmaAutocompleteInput — avoids
// any ref-timing issues that arise when computing position inside
// a portal child's own effect.
function LemmaDropdown({ items, activeIdx, onSelect, pos, C }) {
  if (!items.length || !pos) return null;

  return createPortal(
    <div style={{
      position: 'fixed',
      top: pos.top + 2,
      left: pos.left,
      width: Math.max(pos.width, 240),
      maxHeight: '260px',
      overflowY: 'auto',
      background: C.surface,
      border: `1px solid ${C.border}`,
      borderRadius: '6px',
      boxShadow: '0 4px 20px rgba(0,0,0,0.35)',
      zIndex: 9999,
    }}>
      {items.map((l, i) => (
        <div
          key={l.lemmaID}
          onMouseDown={e => e.preventDefault()} // prevents blur on the anchor input before click fires
          onClick={() => onSelect(l)}
          style={{
            padding: '7px 12px',
            cursor: 'pointer',
            background: i === activeIdx ? C.accentSoft : 'transparent',
            color: i === activeIdx ? C.accent : C.text,
            borderBottom: i < items.length - 1 ? `1px solid ${C.border}` : 'none',
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
          }}
        >
          <span style={{ fontSize: '13px', fontFamily: SH.fk, fontWeight: 600 }}>
            {l.lemma}
          </span>
          {l.def2 && (
            <span style={{
              fontSize: '11px', color: C.textM,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {l.def2}
            </span>
          )}
        </div>
      ))}
    </div>,
    document.body
  );
}

// ── LemmaAutocompleteInput ────────────────────────────────────
// Drop-in replacement for a plain <input> wherever lemmas are edited.
// Free typing is always allowed; the dropdown is suggestive, not mandatory.
//
// Props:
//   value                — controlled input value
//   onChange(val)        — called on every keystroke
//   onBlur(val)          — called when field loses focus
//   onFocus(e)           — optional, passed through to the inner <input>
//   lemmaMaster          — full lemmaMaster array to search against
//   excludeLemmaID       — lemmaID to omit from results (pass current row's ID in LM)
//   onSelectExisting(l)  — called when user picks an existing entry from dropdown;
//                          in LM this triggers the merge flow; in WI/SI omit this prop
//   inputStyle           — style object passed to the inner <input>
//   lang, disabled, placeholder — passed through
//   C                    — color theme object
export function LemmaAutocompleteInput({
  value,
  onChange,
  onBlur,
  onFocus,
  lemmaMaster,
  excludeLemmaID,
  onSelectExisting,
  inputStyle,
  lang,
  disabled,
  placeholder,
  C,
}) {
  const [open,      setOpen]      = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [dropPos,   setDropPos]   = useState(null);
  const inputRef = useRef(null);

  const matches = getMatches(value, lemmaMaster || [], excludeLemmaID);
  const isOpen  = open && matches.length > 0;

  // Compute dropdown position from the input's current bounding rect.
  // Called whenever the dropdown should open or reposition.
  const updatePos = useCallback(() => {
    if (!inputRef.current) return;
    const r = inputRef.current.getBoundingClientRect();
    setDropPos({ top: r.bottom, left: r.left, width: r.width });
  }, []);

  // Keep position fresh while dropdown is open (handles scroll and resize).
  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener('scroll', updatePos, true);
    window.addEventListener('resize', updatePos);
    return () => {
      window.removeEventListener('scroll', updatePos, true);
      window.removeEventListener('resize', updatePos);
    };
  }, [isOpen, updatePos]);

  const handleSelect = (lemmaEntry) => {
    onChange(lemmaEntry.lemma);
    setOpen(false);
    setActiveIdx(-1);
    if (onSelectExisting) onSelectExisting(lemmaEntry);
  };

  const handleKeyDown = (e) => {
    if (!isOpen) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      handleSelect(matches[activeIdx]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setActiveIdx(-1);
    }
  };

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <input
        ref={inputRef}
        lang={lang}
        style={inputStyle}
        value={value}
        onChange={e => {
          onChange(e.target.value);
          setOpen(true);
          setActiveIdx(-1);
          updatePos();
        }}
        onKeyDown={handleKeyDown}
        onBlur={e => {
          setOpen(false);
          if (onBlur) onBlur(e.target.value);
        }}
        onFocus={e => {
          setOpen(true);
          updatePos();
          if (onFocus) onFocus(e);
        }}
        disabled={disabled}
        placeholder={placeholder}
      />
      {isOpen && (
        <LemmaDropdown
          items={matches}
          activeIdx={activeIdx}
          onSelect={handleSelect}
          pos={dropPos}
          C={C}
        />
      )}
    </div>
  );
}

// ── LemmaMergeModal ───────────────────────────────────────────
// Shown in Lemma Master when a lemma edit resolves to an existing entry.
// Rendered via portal so it appears above all other content.
//
// Sections:
//   1. Def2 picker — only if both entries have a def2 (auto-selects if only one does)
//   2. Relation field additions — read-only preview of additive merge
//   3. Reassignment list — Word Input and Sentence Input rows that will be re-pointed
//   4. Confirm / Cancel
//
// Props:
//   editedLemma    — entry being edited (will be deleted on confirm)
//   selectedLemma  — surviving entry (picked from dropdown or typed match)
//   lemmaMaster    — full array (used to resolve relation field IDs to display names)
//   wordInputs     — for reassignment preview
//   sentenceInputs — for reassignment preview
//   onConfirm(survivingDef2) — called with the chosen def2 string
//   onCancel       — resets the edit field and dismisses
//   C
export function LemmaMergeModal({
  editedLemma,
  selectedLemma,
  lemmaMaster,
  wordInputs,
  sentenceInputs,
  onConfirm,
  onCancel,
  C,
}) {
  const hasBothDef2 = !!(editedLemma.def2 && selectedLemma.def2);
  const autoDef2    = editedLemma.def2 || selectedLemma.def2 || '';
  const [chosenDef2, setChosenDef2] = useState(hasBothDef2 ? null : autoDef2);

  const editedNorm      = normalizeLemma(editedLemma.lemma);
  const reassignedWords = wordInputs.filter(w => normalizeLemma(w.lemma) === editedNorm);
  const reassignedSents = sentenceInputs.filter(s => normalizeLemma(s.targetWord) === editedNorm);

  // ID → display name map for relation fields
  const idToLemma = {};
  for (const l of lemmaMaster) idToLemma[l.lemmaID] = l.lemma;

  // IDs present in edited's field but not already in survivor's, and not the survivor itself
  const getAdded = (survivorField, editedField) => {
    const inSurvivor = new Set(
      (survivorField || '').split(',').map(s => s.trim()).filter(Boolean)
    );
    return (editedField || '')
      .split(',').map(s => s.trim()).filter(Boolean)
      .filter(id => !inSurvivor.has(id) && id !== selectedLemma.lemmaID);
  };

  const addedForm    = getAdded(selectedLemma.relatedForm,    editedLemma.relatedForm);
  const addedMeaning = getAdded(selectedLemma.relatedMeaning, editedLemma.relatedMeaning);
  const addedHidden  = getAdded(selectedLemma.hiddenRelated,  editedLemma.hiddenRelated);
  const hasRelAdditions = addedForm.length + addedMeaning.length + addedHidden.length > 0;

  const renderIDs  = (ids) => ids.map(id => idToLemma[id] || id).join(', ');
  const canConfirm = !hasBothDef2 || chosenDef2 !== null;

  return createPortal(
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
        zIndex: 1500, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onCancel}
    >
      <div
        style={{
          background: C.surface, border: `1px solid ${C.border}`, borderRadius: '12px',
          padding: '24px', width: 'min(92vw, 560px)', maxHeight: '85vh',
          overflowY: 'auto', boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
        }}
        onClick={e => e.stopPropagation()}
      >

        {/* Header */}
        <div style={{ marginBottom: '18px' }}>
          <div style={{ fontFamily: SH.fd, fontSize: '14px', fontWeight: 700, color: C.text, marginBottom: '6px' }}>
            Merge Lemmas
          </div>
          <div style={{ fontSize: '12px', color: C.textM, lineHeight: 1.6 }}>
            <span style={{ fontFamily: SH.fk, color: C.danger || '#c0392b', fontWeight: 600 }}>
              {editedLemma.lemma}
            </span>
            {' '}will be deleted and its linked rows reassigned to{' '}
            <span style={{ fontFamily: SH.fk, color: C.accent, fontWeight: 600 }}>
              {selectedLemma.lemma}
            </span>.
          </div>
        </div>

        {/* Def2 picker — only rendered when both entries have a def2 */}
        {hasBothDef2 && (
          <div style={{ marginBottom: '20px' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: C.textM, marginBottom: '10px' }}>
              Choose Definition 2 for surviving entry
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              {[
                { entry: editedLemma,   tag: 'From ' + editedLemma.lemma },
                { entry: selectedLemma, tag: 'From ' + selectedLemma.lemma },
              ].map(({ entry, tag }) => {
                const isChosen = chosenDef2 === entry.def2;
                return (
                  <div key={entry.lemmaID} style={{
                    border: `2px solid ${isChosen ? C.accent : C.border}`,
                    borderRadius: '8px', padding: '12px',
                    background: isChosen ? C.accentSoft : C.raised,
                    display: 'flex', flexDirection: 'column', gap: '8px',
                  }}>
                    <div style={{ fontSize: '10px', color: C.textM, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      {tag}
                    </div>
                    <div style={{ fontSize: '12px', color: C.text, lineHeight: 1.5, flex: 1, whiteSpace: 'pre-wrap' }}>
                      {entry.def2}
                    </div>
                    <button
                      onClick={() => setChosenDef2(entry.def2)}
                      style={{
                        padding: '5px 10px', borderRadius: '5px', fontSize: '11px', fontWeight: 600,
                        border: `1px solid ${isChosen ? C.accent : C.border}`,
                        background: isChosen ? C.accent : 'transparent',
                        color: isChosen ? '#fff' : C.textM,
                        cursor: 'pointer',
                      }}
                    >
                      {isChosen ? '✓ Selected' : 'Use this'}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Relation field additions — read-only preview */}
        {hasRelAdditions && (
          <div style={{ marginBottom: '18px', padding: '12px 14px', background: C.raised, borderRadius: '8px', border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.textM, marginBottom: '8px' }}>
              Relation fields to add to {selectedLemma.lemma}
            </div>
            {addedForm.length > 0 && (
              <div style={{ fontSize: '12px', color: C.text, marginBottom: '4px' }}>
                <span style={{ color: C.textM }}>Related Form: </span>{renderIDs(addedForm)}
              </div>
            )}
            {addedMeaning.length > 0 && (
              <div style={{ fontSize: '12px', color: C.text, marginBottom: '4px' }}>
                <span style={{ color: C.textM }}>Related Meaning: </span>{renderIDs(addedMeaning)}
              </div>
            )}
            {addedHidden.length > 0 && (
              <div style={{ fontSize: '12px', color: C.text }}>
                <span style={{ color: C.textM }}>Hidden Related: </span>{renderIDs(addedHidden)}
              </div>
            )}
          </div>
        )}

        {/* Reassignment list */}
        <div style={{ marginBottom: '20px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.textM, marginBottom: '8px' }}>
            Rows to reassign to {selectedLemma.lemma}
          </div>
          {reassignedWords.length === 0 && reassignedSents.length === 0
            ? <div style={{ fontSize: '12px', color: C.textM }}>No linked rows to reassign.</div>
            : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '160px', overflowY: 'auto' }}>
                {reassignedWords.map(w => (
                  <div key={w.uid} style={{ fontSize: '12px', color: C.text, padding: '4px 8px', background: C.raised, borderRadius: '4px' }}>
                    <span style={{ fontSize: '10px', color: C.textM, textTransform: 'uppercase', letterSpacing: '0.05em', marginRight: '6px' }}>Word</span>
                    <span style={{ fontFamily: SH.fk, color: C.accent }}>{w.input}</span>
                    {w.def2 && <span style={{ color: C.textM }}> — {w.def2}</span>}
                  </div>
                ))}
                {reassignedSents.map(s => (
                  <div key={s.uid} style={{ fontSize: '12px', color: C.text, padding: '4px 8px', background: C.raised, borderRadius: '4px' }}>
                    <span style={{ fontSize: '10px', color: C.textM, textTransform: 'uppercase', letterSpacing: '0.05em', marginRight: '6px' }}>Sent</span>
                    <span style={{ color: C.textM }}>
                      {(s.sentence || '').slice(0, 70)}{(s.sentence || '').length > 70 ? '…' : ''}
                    </span>
                  </div>
                ))}
              </div>
            )
          }
        </div>

        {/* Confirm / Cancel */}
        <div style={{
          display: 'flex', gap: '10px', justifyContent: 'flex-end',
          borderTop: `1px solid ${C.border}`, paddingTop: '14px',
        }}>
          <button
            onClick={onCancel}
            style={{
              padding: '8px 18px', borderRadius: '7px', fontSize: '13px',
              border: `1px solid ${C.border}`, background: 'transparent',
              color: C.textM, cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => canConfirm && onConfirm(chosenDef2 ?? autoDef2)}
            disabled={!canConfirm}
            style={{
              padding: '8px 18px', borderRadius: '7px', fontSize: '13px', fontWeight: 600,
              border: 'none',
              background: canConfirm ? (C.danger || '#c0392b') : C.border,
              color: '#fff',
              cursor: canConfirm ? 'pointer' : 'default',
              opacity: canConfirm ? 1 : 0.5,
            }}
          >
            Confirm Merge
          </button>
        </div>

      </div>
    </div>,
    document.body
  );
}
