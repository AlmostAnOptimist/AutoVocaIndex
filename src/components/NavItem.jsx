import { useAppTheme } from '../hooks/useAppTheme.js';

export function NavItem({ icon, label, active, badge, badgeDanger, phase, onClick, collapsed }) {
  const { C, S } = useAppTheme();
  if (collapsed) {
    // Icon rail (Phase E1): icon centered, count badge shrunk to a corner
    // marker, label carried by the title tooltip. Phase badges hide.
    return (
      <div style={{ ...S.navItem(active), justifyContent: 'center', position: 'relative', padding: '10px 0' }} className="nav-hover" onClick={onClick} title={label}>
        <span style={{ opacity: 0.75, display: 'flex', alignItems: 'center' }}>{icon}</span>
        {badge !== undefined && badge > 0 && (
          <span style={{ ...S.navBadge(badgeDanger), position: 'absolute', top: '3px', right: '5px', marginLeft: 0, fontSize: '9px', padding: '0 4px', minWidth: '14px' }}>{badge}</span>
        )}
      </div>
    );
  }
  return (
    <div style={S.navItem(active)} className="nav-hover" onClick={onClick}>
      <span style={{ opacity: 0.75, display: 'flex', alignItems: 'center' }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {badge !== undefined && badge > 0 && (
        <span style={S.navBadge(badgeDanger)}>{badge}</span>
      )}
      {phase && <span style={S.phaseBadge}>P{phase}</span>}
    </div>
  );
}