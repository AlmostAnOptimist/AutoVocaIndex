import { useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { SH } from '../theme/buildStyles.js';

// Sidebar guide tooltip: appears after a sustained hover, not on quick
// mouse-through. Only items with a `desc` (the 9 main nav pages) trigger it.
const DESC_HOVER_DELAY_MS = 3000;
const DESC_TOOLTIP_WIDTH = 300;

export function NavItem({ icon, label, active, badge, badgeDanger, phase, onClick, collapsed, desc }) {
  const { C, S } = useAppTheme();
  const itemRef = useRef(null);
  const hoverTimer = useRef(null);
  const [tooltipPos, setTooltipPos] = useState(null);

  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  const handleMouseEnter = () => {
    if (!desc) return;
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      const rect = itemRef.current?.getBoundingClientRect();
      if (!rect) return;
      setTooltipPos({
        top: Math.max(8, Math.min(rect.top, window.innerHeight - 260)),
        left: rect.right + 10,
      });
    }, DESC_HOVER_DELAY_MS);
  };

  const handleMouseLeave = () => {
    clearTimeout(hoverTimer.current);
    setTooltipPos(null);
  };

  const tooltip = tooltipPos && createPortal(
    <div style={{
      position: 'fixed', top: `${tooltipPos.top}px`, left: `${tooltipPos.left}px`,
      width: `${DESC_TOOLTIP_WIDTH}px`, zIndex: 3000,
      background: C.surface, border: `1px solid ${C.borderB}`, borderRadius: '10px',
      padding: '12px 14px', boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
      pointerEvents: 'none',
    }}>
      <div style={{ fontFamily: SH.fp, fontSize: '11px', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.accent, marginBottom: '6px' }}>
        {label}
      </div>
      <div style={{ fontFamily: SH.fb, fontSize: '12.5px', lineHeight: 1.5, color: C.textS }}>
        {desc}
      </div>
    </div>,
    document.body
  );

  if (collapsed) {
    // Icon rail (Phase E1): icon centered, count badge shrunk to a corner
    // marker, label carried by the title tooltip. Phase badges hide.
    return (
      <div
        ref={itemRef}
        style={{ ...S.navItem(active), justifyContent: 'center', position: 'relative', padding: '10px 0' }}
        className="nav-hover"
        onClick={onClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        title={label}
      >
        <span style={{ opacity: 0.75, display: 'flex', alignItems: 'center' }}>{icon}</span>
        {badge !== undefined && badge > 0 && (
          <span style={{ ...S.navBadge(badgeDanger), position: 'absolute', top: '3px', right: '5px', marginLeft: 0, fontSize: '9px', padding: '0 4px', minWidth: '14px' }}>{badge}</span>
        )}
        {tooltip}
      </div>
    );
  }
  return (
    <div
      ref={itemRef}
      style={S.navItem(active)}
      className="nav-hover"
      onClick={onClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <span style={{ opacity: 0.75, display: 'flex', alignItems: 'center' }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {badge !== undefined && badge > 0 && (
        <span style={S.navBadge(badgeDanger)}>{badge}</span>
      )}
      {phase && <span style={S.phaseBadge}>P{phase}</span>}
      {tooltip}
    </div>
  );
}