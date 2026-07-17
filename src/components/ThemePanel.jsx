import { useAppTheme } from '../hooks/useAppTheme.js';
import { Icons } from './Icons.jsx';
import { THEME_DEFS } from '../constants.js';

export function ThemePanel({ open, onClose }) {
  const { C, S, theme, setTheme } = useAppTheme();
  return (
    <>
      {open && <div style={{ position: 'fixed', inset: 0, zIndex: 199 }} onClick={onClose} />}
      <div style={S.themePanel(open)}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
          <span style={S.themePanelTitle}>Appearance</span>
          <button style={{ fontSize: '22px', color: C.textM }} onClick={onClose}>{Icons.x}</button>
        </div>
        {THEME_DEFS.map(t => (
          <div key={t.id} style={S.themeOption(theme === t.id)} onClick={() => setTheme(t.id)}>
            <div style={{ display: 'flex', flexWrap: 'wrap', width: '40px', height: '40px', borderRadius: '6px', overflow: 'hidden', flexShrink: 0 }}>
              {t.sw.map((sw, i) => (
                <div key={i} style={{ width: '50%', height: '50%', background: sw }} />
              ))}
            </div>
            <div>
              <div style={{ fontSize: '13px', fontWeight: 500, color: C.text, marginBottom: '2px' }}>{t.name}</div>
              <div style={{ fontSize: '11px', color: C.textM }}>{t.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}