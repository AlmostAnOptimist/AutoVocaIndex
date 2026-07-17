// src/components/GrammarCardPicker.jsx
// Shared card-selection UI for the Grammar Deck.
// Used two ways: inline (Grammar Index's select mode) and as a modal
// (Flashcards' Grammar Deck tile). One component, one set of selection logic —
// the consuming page decides layout via the `mode` prop.
import { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { SH } from '../theme/buildStyles.js';
import { GRAMMAR_MASTERY } from '../constants.js';

const FILTERS = [
  { id: 'all',        label: 'All' },
  { id: 'introduced', label: 'Introduced' },
  { id: 'practicing', label: 'Practicing' },
  { id: 'confident',  label: 'Confident' },
  { id: 'mastered',   label: 'Mastered' },
];

// "Ready to review" hint, derived from the mastery-floor nudge (card.nextDueDate).
// Purely informational — selection isn't gated by this, you can pick anything.
function readyHint(card) {
  if (!card.lastReview && !card.lastReviewed) return 'New';
  const raw = card.due || card.nextDueDate;
  if (!raw) return 'Ready';
  const dueMs = raw.length === 10 ? new Date(raw + 'T00:00:00').getTime() : new Date(raw).getTime();
  const diffDays = Math.ceil((dueMs - Date.now()) / 86_400_000);
  return diffDays <= 0 ? 'Ready' : `Ready in ${diffDays}d`;
}

export function GrammarCardPicker({ entries, cards, mode = 'modal', onStudySelected, onClose }) {
  const { C, S } = useAppTheme();
  const [search,      setSearch]      = useState('');
  const [filter,       setFilter]      = useState('all');
  const [selectedIds,  setSelectedIds] = useState([]); // entry IDs, in pick order

  // entryId -> linked grammar flashcard
  const cardByEntry = useMemo(() => {
    const m = {};
    (cards || []).forEach(c => { if (c.type === 'grammar' && c.linkedGrammarEntryId) m[c.linkedGrammarEntryId] = c; });
    return m;
  }, [cards]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (entries || [])
      .filter(e => filter === 'all' || e.masteryLevel === filter)
      .filter(e => !q || e.glossaryTerm?.toLowerCase().includes(q))
      .sort((a, b) => (a.entryNumber || 0) - (b.entryNumber || 0));
  }, [entries, filter, search]);

  const toggle = (entryId) => {
    if (!cardByEntry[entryId]) return; // no linked card — nothing to study
    setSelectedIds(prev => prev.includes(entryId) ? prev.filter(id => id !== entryId) : [...prev, entryId]);
  };

  const handleStudy = () => {
    const cardIds = selectedIds.map(id => cardByEntry[id]?.id).filter(Boolean);
    if (cardIds.length) onStudySelected(cardIds);
  };

  const content = (
    <>
      {/* Search */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px', flexShrink: 0 }}>
        <input
          autoFocus={mode === 'modal'}
          style={{ ...S.formInput, fontSize: '13px', marginBottom: 0, flex: 1 }}
          placeholder="Search grammar patterns…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {mode === 'modal' && onClose && (
          <button onClick={onClose} style={{ color: C.textM, fontSize: '18px', lineHeight: 1, padding: '2px', background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
        )}
      </div>

      {/* Mastery filter pills */}
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '14px', paddingBottom: '14px', borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
        {FILTERS.map(f => {
          const active = filter === f.id;
          const color  = f.id !== 'all' ? GRAMMAR_MASTERY[f.id]?.color : C.accent;
          return (
            <button key={f.id} onClick={() => setFilter(f.id)} style={{
              padding: '4px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: 500,
              border: `1px solid ${active ? (color || C.accent) : C.border}`,
              background: active ? `${color || C.accent}22` : 'transparent',
              color: active ? (color || C.accent) : C.textS,
              cursor: 'pointer', transition: 'all 0.15s',
            }}>
              {f.label}
            </button>
          );
        })}
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto', border: `1px solid ${C.border}`, borderRadius: '12px' }}>
        {visible.length === 0 ? (
          <div style={{ padding: '24px', textAlign: 'center', color: C.textM, fontSize: '13px', fontStyle: 'italic' }}>No entries match.</div>
        ) : (
          visible.map((entry, idx) => {
            const card       = cardByEntry[entry.id];
            const hasCard    = !!card;
            const isSelected = selectedIds.includes(entry.id);
            const mastery    = GRAMMAR_MASTERY[entry.masteryLevel] || GRAMMAR_MASTERY.introduced;
            const hint       = hasCard ? readyHint(card) : null;
            return (
              <div
                key={entry.id}
                onClick={() => toggle(entry.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 14px',
                  borderBottom: idx < visible.length - 1 ? `1px solid ${C.border}` : 'none',
                  background: isSelected ? C.accentSoft : 'transparent',
                  cursor: hasCard ? 'pointer' : 'default',
                  opacity: hasCard ? 1 : 0.45,
                  transition: 'background 0.15s',
                }}
                className={hasCard ? 'task-row' : undefined}
              >
                <div style={{
                  width: '14px', height: '14px', borderRadius: '4px', flexShrink: 0,
                  border: isSelected ? 'none' : `1.5px solid ${C.border}`,
                  background: isSelected ? C.accent : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {isSelected && <span style={{ color: '#fff', fontSize: '9px', lineHeight: 1 }}>✓</span>}
                </div>
                <span style={{ fontFamily: SH.fm, fontSize: '11px', color: C.textM, minWidth: '26px', flexShrink: 0 }}>
                  {entry.entryNumber}
                </span>
                <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: mastery.color, flexShrink: 0 }} />
                <span style={{ fontFamily: SH.fk, fontSize: '14px', fontWeight: 500, color: C.text, flex: 1 }}>
                  {entry.glossaryTerm}
                </span>
                {!hasCard && (
                  <span style={{ fontSize: '11px', color: C.textM, fontStyle: 'italic', flexShrink: 0 }}>No card</span>
                )}
                {hint && (
                  <span style={{
                    fontSize: '10px', fontWeight: 600, padding: '2px 8px', borderRadius: '10px', flexShrink: 0,
                    border: `1px solid ${C.border}`, color: hint === 'Ready' ? C.accent : C.textM,
                  }}>
                    {hint}
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Selection bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '14px', flexShrink: 0 }}>
        <span style={{ fontSize: '12px', color: C.textM }}>{selectedIds.length} selected</span>
        <div style={{ display: 'flex', gap: '8px', marginLeft: 'auto' }}>
          <button style={S.btnGhost} onClick={onClose}>Cancel</button>
          <button
            style={{ ...S.btnPrimary, ...S.btnMetallic, opacity: selectedIds.length ? 1 : 0.5 }}
            disabled={!selectedIds.length}
            onClick={handleStudy}
          >
            Study Selected{selectedIds.length ? ` (${selectedIds.length})` : ''}
          </button>
        </div>
      </div>
    </>
  );

  if (mode === 'inline') {
    return <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>{content}</div>;
  }

  // Modal mode — same overlay pattern as AVIMiniSearchPopup. Portaled to
  // document.body: the FlashcardsPage mount sits inside its `.fade-up` page
  // wrapper, whose persistent transform would trap this fixed overlay.
  return createPortal(
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: C.surface, border: `1px solid ${C.border}`, borderRadius: '12px', padding: '20px',
          width: 'min(94vw, 560px)', maxHeight: '82vh', display: 'flex', flexDirection: 'column',
          boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
        }}
      >
        {content}
      </div>
    </div>,
    document.body
  );
}