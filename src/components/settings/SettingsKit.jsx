// src/components/settings/SettingsKit.jsx
// Building blocks for the tabbed Settings page (ST1): header with settings
// search, the two-tier tab bar (sidebar section, then page) carried to the
// edge by a TabRail, the Rail plate that opens each tab, jewel-marked group
// headings, ledger rows, and the Pendant that closes each tab.
// Leaf module: imports hooks, theme helpers, Ornaments and the layout model.

import { useAppTheme } from '../../hooks/useAppTheme.js';
import { SH, frameBevel } from '../../theme/buildStyles.js';
import { Rail, Pendant, TabRail, useOrnament } from '../Ornaments.jsx';
import {
  SETTINGS_SECTIONS, SETTINGS_TABS, SETTING_META,
  sectionOfTab, tabsOfSetting, settingCount,
} from '../../utils/settingsLayout.js';

export const isMobile = typeof window !== 'undefined' && (window.innerWidth <= 700 || window.matchMedia('(hover: none) and (pointer: coarse) and (orientation: portrait)').matches);

// Beveled chip (S.recurChip), optionally in a category colour. The fill
// goes out as backgroundColor so a toggle never mixes the background
// shorthand with backgroundClip on rerender (React warns about that).
export function chipStyle(S, C, active, color) {
  const { background, ...base } = S.recurChip(active);
  if (!active || !color) return { ...base, backgroundColor: background };
  return { ...base, borderImageSource: frameBevel(color), backgroundColor: `${color}18`, color };
}

const Jewel = ({ size = 7, color, hollow, line }) => (
  <span aria-hidden="true" style={{
    display: 'inline-block', width: size, height: size, flexShrink: 0, transform: 'rotate(45deg)',
    background: hollow ? 'transparent' : color, border: hollow ? `1px solid ${line}` : 'none', boxSizing: 'border-box',
  }} />
);

// ── Header ───────────────────────────────────────────────────
export function SettingsHeader({ query, onQuery }) {
  const { C } = useAppTheme();
  return (
    <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: '8px 16px' }}>
      <h1 style={{ fontFamily: SH.fp, fontWeight: 400, fontSize: isMobile ? '32px' : '40px', letterSpacing: '0.02em', color: C.text, margin: 0, lineHeight: 1.05 }}>
        Settings
      </h1>
      <label htmlFor="settings-search" style={{ display: 'flex', alignItems: 'center', gap: '6px', borderBottom: `1px solid ${C.border}`, padding: '4px 2px', flex: isMobile ? '1 1 100%' : '0 1 220px', minWidth: 0 }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.textM} strokeWidth="2" aria-hidden="true" style={{ flexShrink: 0 }}>
          <circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" />
        </svg>
        <input
          id="settings-search" type="search" autoComplete="off" placeholder="Find a setting"
          value={query} onChange={e => onQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape' && query) { e.stopPropagation(); onQuery(''); } }}
          style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', outline: 'none', fontSize: '13.5px', color: C.text, padding: 0 }}
        />
        {query && (
          <button type="button" aria-label="Clear search" onClick={() => onQuery('')} style={{ color: C.textM, fontSize: '15px', lineHeight: 1, padding: '0 2px' }}>×</button>
        )}
      </label>
      <div style={{ flex: '1 1 100%', height: '1px', background: `linear-gradient(90deg, ${C.accent}, transparent)`, margin: '4px 0 2px' }} />
      <p style={{ flex: '1 1 100%', margin: 0, color: C.textS, fontSize: '13.5px', lineHeight: 1.55, maxWidth: '64ch' }}>
        Each page has its own tab. A setting more than one page uses appears on each of those tabs, and changing it in one place changes it everywhere.
      </p>
    </header>
  );
}

// ── Tab bar ──────────────────────────────────────────────────
export function SettingsTabBar({ tab, onSection, onTab, searching }) {
  const { C } = useAppTheme();
  const o = useOrnament();
  const section = sectionOfTab(tab);
  const tabs = SETTINGS_SECTIONS.find(s => s.id === section).tabs;
  return (
    <div style={{ position: 'sticky', top: 0, zIndex: 5, background: C.bg, marginTop: '18px', paddingTop: '6px' }}>
      <div role="tablist" aria-label="Sections" style={{ display: 'flex', gap: '2px', overflowX: 'auto', scrollbarWidth: 'none' }}>
        {SETTINGS_SECTIONS.map(s => {
          const on = s.id === section;
          return (
            <button key={s.id} type="button" role="tab" aria-selected={on} onClick={() => onSection(s.id)} style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 10px 4px 0', marginRight: '8px',
              fontFamily: SH.fp, fontWeight: 600, fontSize: '12px', letterSpacing: '0.18em', textTransform: 'uppercase',
              color: on ? C.text : C.textM, whiteSpace: 'nowrap',
            }}>
              <Jewel size={6} color={o.jewel} hollow={!on} line={C.textM} />
              {s.label}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end' }}>
        <div role="tablist" aria-label="Pages" style={{ display: 'flex', gap: '2px', overflowX: 'auto', scrollbarWidth: 'none', flex: '0 1 auto', minWidth: 0, borderBottom: `1px solid ${C.border}` }}>
          {tabs.map(t => {
            const on = t === tab && !searching;
            return (
              <button key={t} type="button" role="tab" aria-selected={on} onClick={() => onTab(t)} style={{
                padding: '8px 10px', fontSize: '13.5px', whiteSpace: 'nowrap', marginBottom: '-1px',
                color: on ? C.text : C.textS, fontWeight: on ? 600 : 400,
                borderBottom: `2px solid ${on ? C.accent : 'transparent'}`,
              }}>
                {SETTINGS_TABS[t].label}
                <span style={{ fontFamily: SH.fm, fontSize: '10.5px', fontWeight: 400, color: C.textM, marginLeft: '5px' }}>{settingCount(t)}</span>
              </button>
            );
          })}
        </div>
        <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', alignSelf: 'center', marginTop: '6px' }}>
          <TabRail />
        </div>
      </div>
    </div>
  );
}

// ── Panel pieces ─────────────────────────────────────────────
export function PanelHead({ tab }) {
  const { C } = useAppTheme();
  const t = SETTINGS_TABS[tab];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', textAlign: 'center', paddingTop: '26px' }}>
      <Rail label={t.ko} width={300} />
      <p style={{ margin: 0, color: C.textS, fontSize: '13.5px', lineHeight: 1.55, maxWidth: '56ch' }}>{t.lede}</p>
    </div>
  );
}

export function PanelEnd() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', marginTop: '34px' }}>
      <Pendant variant="close" height={130} />
    </div>
  );
}

export function SettingsGroup({ title, children }) {
  const { C } = useAppTheme();
  const o = useOrnament();
  return (
    <section style={{ marginTop: '30px' }}>
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '0 0 4px', fontFamily: SH.fp, fontWeight: 600, fontSize: '13px', letterSpacing: '0.16em', textTransform: 'uppercase', color: C.textS }}>
        <Jewel color={o.jewel} />
        {title}
        <span aria-hidden="true" style={{ flex: 1, height: '1px', background: `linear-gradient(90deg, ${o.thread}, transparent)`, opacity: 0.7 }} />
      </h3>
      <div style={{ borderTop: `1px solid ${C.border}` }}>{children}</div>
    </section>
  );
}

// One setting as a ledger row. `here` is the tab being shown (null in
// search results, which list every tab the setting appears on).
// `block` puts the control under the text, full width.
export function SettingRow({ id, here, block, note, flash, onJump, children }) {
  const { C } = useAppTheme();
  const o = useOrnament();
  const meta = SETTING_META[id] || { label: id, desc: '' };
  const on = tabsOfSetting(id);
  const others = here === null ? on : on.filter(t => t !== here);
  const stacked = block || isMobile;
  return (
    <div
      id={`setting-${id}`}
      className={flash ? 'settings-flash' : undefined}
      style={{
        display: 'grid', gridTemplateColumns: stacked ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) auto',
        gap: '8px 20px', padding: '14px 0', borderBottom: `1px solid ${C.border}`, alignItems: 'start', scrollMarginTop: '120px',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '14px', fontWeight: 500, color: C.text }}>{meta.label}</div>
        {meta.desc && <div style={{ fontSize: '12.5px', color: C.textS, marginTop: '2px', lineHeight: 1.5, maxWidth: '60ch' }}>{meta.desc}</div>}
        {others.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 6px', marginTop: '6px', fontFamily: SH.fm, fontSize: '11px', color: C.textM }}>
            <Jewel size={6} color={o.jewel} />
            <span style={{ marginLeft: '2px' }}>{here === null ? 'On' : 'Also on'}</span>
            {others.map((t, i) => (
              <span key={t} style={{ display: 'inline-flex', gap: '6px' }}>
                <button type="button" onClick={() => onJump(t, id)} style={{ fontFamily: SH.fm, fontSize: '11px', color: C.accent, textDecoration: 'underline', textDecorationColor: C.border, textUnderlineOffset: '2px', padding: 0 }}>
                  {SETTINGS_TABS[t].label}
                </button>
                {i < others.length - 1 && <span aria-hidden="true">·</span>}
              </span>
            ))}
          </div>
        )}
      </div>
      <div style={{
        minWidth: 0, display: 'flex', flexWrap: 'wrap', gap: '8px',
        ...(stacked && block ? { flexDirection: 'column', alignItems: 'stretch' } : { alignItems: 'center', justifyContent: stacked ? 'flex-start' : 'flex-end' }),
      }}>
        {children}
        {note && <div style={{ flexBasis: '100%', fontSize: '12px', lineHeight: 1.5, color: note.error ? C.danger : C.textM, textAlign: stacked ? 'left' : 'right' }}>{note.text}</div>}
      </div>
    </div>
  );
}

// Small uppercase label inside a block control (e.g. "Period", "Health").
export function SubLabel({ children, color, style }) {
  const { C } = useAppTheme();
  return (
    <div style={{ fontFamily: SH.fp, fontWeight: 600, fontSize: '11.5px', letterSpacing: '0.14em', textTransform: 'uppercase', color: color || C.textM, marginBottom: '6px', ...style }}>
      {children}
    </div>
  );
}
