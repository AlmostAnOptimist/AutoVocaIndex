// Mobile replacement for AVI's tab strip (Phase E2 Stage 2): a "Nav"
// button portaled into the app header slot rendered by App.jsx while
// page === 'avi', opening a newsprint contents column -- the Gazette
// index treatment. The open panel + scrim portal to document.body so
// they stack above every detail panel and the mobile nav bar (the same
// pattern as the More tray; the scrim replaces the old document-level
// outside-click listener and intercepts background touch, so no scroll
// lock is needed).

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAppTheme } from '../../hooks/useAppTheme.js';
import { SH } from '../../theme/buildStyles.js';
import { Icons } from '../Icons.jsx';

export function AVIMobileNav({ tabs, activeTab, onSelect, recentCount, syncStatus, mountId = 'avi-nav-slot' }) {
  const { C } = useAppTheme();
  const [open, setOpen] = useState(false);
  const [slotEl, setSlotEl] = useState(null);

  // The slot only exists while page === 'avi' -- exactly when this
  // component exists too, so a mount-only lookup is safe.
  useEffect(() => { setSlotEl(document.getElementById(mountId)); }, [mountId]);

  if (!slotEl) return null;

  const dotColor =
    syncStatus === 'ok'      ? (C.success || '#5ba05b') :
    syncStatus === 'syncing' ? C.accent :
    syncStatus === 'error'   ? (C.danger  || '#c0392b') :
    C.textM;

  const dot = (
    <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: dotColor, flexShrink: 0, transition: 'background 0.3s' }} />
  );

  return (
    <>
      {createPortal(
        <button
          onClick={() => setOpen(v => !v)}
          style={{
            display: 'flex', alignItems: 'center', gap: '7px',
            fontFamily: SH.fp, fontSize: '12px', fontWeight: 700,
            letterSpacing: '0.14em', textTransform: 'uppercase',
            color: open ? C.accent : C.text, background: 'transparent',
            border: `1px solid ${open ? C.accent : C.borderB}`, borderRadius: 0,
            padding: '7px 12px', cursor: 'pointer',
          }}
        >
          {Icons.grid}
          Nav
          {dot}
        </button>,
        slotEl
      )}

      {open && createPortal(
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 1500, background: 'rgba(0,0,0,0.35)', overscrollBehavior: 'contain', touchAction: 'none' }}
            onClick={() => setOpen(false)}
          />
          <div className="avi-index-panel" style={{
            position: 'fixed', top: '58px', right: '10px', width: '236px', zIndex: 1501,
            background: C.surface, border: `1px solid ${C.borderB}`,
            boxShadow: '0 8px 28px rgba(0,0,0,0.5)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 14px 7px' }}>
              <span style={{ fontFamily: SH.fp, fontSize: '11px', fontWeight: 700, letterSpacing: '0.22em', textTransform: 'uppercase', color: C.textS }}>Index</span>
              {dot}
            </div>
            <div style={{ borderTop: `2px solid ${C.borderB}`, borderBottom: `1px solid ${C.border}`, height: '2px', margin: '0 10px' }} />
            {tabs.map((tab, i) => {
              const active = tab.id === activeTab;
              const badgeCount = tab.badge ? recentCount : 0;
              return (
                <div
                  key={tab.id}
                  onClick={() => { onSelect(tab.id); setOpen(false); }}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '11px 14px', fontFamily: SH.fp, fontSize: '12.5px',
                    letterSpacing: '0.1em', textTransform: 'uppercase',
                    color: active ? C.accent : C.textS,
                    borderTop: i === 0 ? 'none' : `1px solid ${C.border}`,
                    boxShadow: active ? `inset 3px 0 0 ${C.accent}` : 'none',
                    cursor: 'pointer',
                  }}
                >
                  {tab.label}
                  {badgeCount > 0 && (
                    <span style={{ fontFamily: SH.fm, fontSize: '11px', color: active ? C.accent : C.textM }}>{badgeCount}</span>
                  )}
                </div>
              );
            })}
            <div style={{ borderTop: `1px solid ${C.borderB}`, borderBottom: `1px solid ${C.border}`, height: '3px', margin: '0 10px 6px' }} />
          </div>
        </>,
        document.body
      )}
    </>
  );
}