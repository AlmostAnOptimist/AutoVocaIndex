// src/components/avi/AVISourceSearchSelect.jsx
// Compact searchable source picker — a real text input (so Hangul IME composition
// works naturally) with a filtered list below, instead of a native <select>.
// Shared by AVISourcePage.jsx (browsing) and App.jsx's topbar AVISourceSelector
// (capture target), so there's one place to fix instead of two that can drift.

import { useState, useRef } from 'react';
import { isPassiveMediaExcluded } from '../../utils/contentUtils.js';

export function AVISourceSearchSelect({
  sources, value, onChange, placeholder = '— Source —',
  excludePassive = false, style, C,
}) {
  const [open,  setOpen]  = useState(false);
  const [typed, setTyped] = useState('');
  const blurTimer = useRef(null);

  const pool = (excludePassive ? sources.filter(s => !isPassiveMediaExcluded(s)) : sources)
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title, 'ko'));

  const filtered = typed.trim()
    ? pool.filter(s => s.title.toLowerCase().includes(typed.trim().toLowerCase()))
    : pool;

  const pick = (title) => {
    onChange(title);
    setTyped('');
    setOpen(false);
  };

  return (
    <div style={{ position: 'relative', ...style }}>
      <input
        value={open ? typed : (value || '')}
        onChange={e => { setTyped(e.target.value); setOpen(true); }}
        onFocus={() => { setTyped(''); setOpen(true); }}
        onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 120); }}
        placeholder={placeholder}
        style={{
          fontSize: '12px', padding: '3px 8px', borderRadius: '6px',
          border: `1px solid ${C.border}`, background: C.raised,
          color: value ? C.text : C.textM, outline: 'none', width: '100%', boxSizing: 'border-box',
        }}
      />
      {open && (
        <div
          onMouseDown={e => { e.preventDefault(); clearTimeout(blurTimer.current); }}
          style={{
            position: 'absolute', top: 'calc(100% + 2px)', left: 0, right: 0,
            maxHeight: '220px', overflowY: 'auto', zIndex: 50,
            background: C.raised, border: `1px solid ${C.border}`,
            borderRadius: '8px', boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
          }}
        >
          <div onClick={() => pick('')} style={{ padding: '6px 10px', fontSize: '12px', color: C.textM, cursor: 'pointer' }}>
            {placeholder}
          </div>
          {filtered.length === 0 && (
            <div style={{ padding: '6px 10px', fontSize: '12px', color: C.textM, fontStyle: 'italic' }}>
              No matching sources
            </div>
          )}
          {filtered.map(s => (
            <div
              key={s.id}
              onClick={() => pick(s.title)}
              style={{
                padding: '6px 10px', fontSize: '12px', cursor: 'pointer',
                color: s.title === value ? C.accent : C.text,
                background: s.title === value ? `${C.accent}10` : 'transparent',
              }}
            >
              {s.title}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}