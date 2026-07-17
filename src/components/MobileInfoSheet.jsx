// Generic mobile bottom sheet for "tap to see full detail" patterns across
// AVI's mobile layouts (Word Input, Lemma Master, Source, Search) — one
// shared implementation instead of four bespoke popups.

import { useAppTheme } from '../hooks/useAppTheme.js';

export function MobileInfoSheet({ open, onClose, title, children }) {
  const { C } = useAppTheme();
  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1400, display: 'flex', alignItems: 'flex-end' }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ width: '100%', background: C.surface, borderTop: `1px solid ${C.border}`, borderRadius: '18px 18px 0 0', padding: '10px 18px 22px', maxHeight: '70vh', overflowY: 'auto' }}
      >
        <div style={{ width: '36px', height: '4px', background: C.border, borderRadius: '2px', margin: '0 auto 12px' }} />
        {title && (
          <div style={{ fontWeight: 700, fontSize: '16px', color: C.accent, marginBottom: '8px' }}>
            {title}
          </div>
        )}
        <div style={{ fontSize: '12.5px', color: C.textS, lineHeight: 1.6, marginBottom: '14px' }}>
          {children}
        </div>
        <button
          onClick={onClose}
          style={{ width: '100%', padding: '10px', borderRadius: '8px', background: C.raised, border: `1px solid ${C.border}`, color: C.textS, fontWeight: 700, fontSize: '12.5px', cursor: 'pointer' }}
        >
          Close
        </button>
      </div>
    </div>
  );
}