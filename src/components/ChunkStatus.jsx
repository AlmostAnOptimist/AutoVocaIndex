// src/components/ChunkStatus.jsx
// What shows in place of a page or reader that loads on demand (offline
// decisions OF-D4, src/components/LazyPage.jsx) while its file is on the way,
// or when the file couldn't be loaded.
//
// Loading: nothing for the first moment, so a fast load doesn't flicker, then
// the label. Failed: a message with Try again and Reload.
//
// overlay: for the full-screen readers. Drawn over the whole screen through a
// portal, like the readers themselves, with a Close button when onClose is
// given.

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAppTheme } from '../hooks/useAppTheme.js';

const SHOW_LOADING_AFTER_MS = 200;

export function ChunkStatus({ failed, label, overlay, onRetry, onClose }) {
  const { C, S } = useAppTheme();
  const [showLoading, setShowLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setShowLoading(true), SHOW_LOADING_AFTER_MS);
    return () => clearTimeout(t);
  }, []);

  if (!failed && !showLoading) return null;

  const body = failed ? (
    <div role="alert" style={{ maxWidth: '340px', textAlign: 'center', color: C.text, fontSize: '14px', lineHeight: 1.5 }}>
      <div style={{ marginBottom: '6px', fontWeight: 600 }}>This page couldn't be loaded.</div>
      <div style={{ marginBottom: '16px', color: C.textS, fontSize: '13px' }}>
        Check your connection and try again. If it keeps happening, reload AutoVocaIndex.
      </div>
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
        <button style={S.btnPrimary} onClick={onRetry}>Try again</button>
        <button style={S.btnGhost} onClick={() => window.location.reload()}>Reload</button>
        {overlay && onClose && <button style={S.btnGhost} onClick={onClose}>Close</button>}
      </div>
    </div>
  ) : (
    <div style={{ color: C.textM, fontSize: '13px' }}>{label}</div>
  );

  if (overlay) {
    return createPortal(
      <div style={{
        position: 'fixed', inset: 0, zIndex: 250, background: C.bg,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px',
      }}>
        {body}
      </div>,
      document.body,
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '300px', padding: '24px' }}>
      {body}
    </div>
  );
}
