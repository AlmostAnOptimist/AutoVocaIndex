// src/components/settings/AppearanceKit.jsx
// The Appearance tab in Settings: the theme picker (switches the app's theme
// everywhere), the palette preview (flip through themes without applying
// them; every token as a colour block with its measured screen coverage)
// and the contrast check for the previewed theme.
// Leaf module: imports hooks, theme helpers and constants only.

import { useState } from 'react';
import { useAppTheme } from '../../hooks/useAppTheme.js';
import { SH } from '../../theme/buildStyles.js';
import { buildColors } from '../../theme/buildColors.js';
import { THEME_DEFS } from '../../constants.js';
import { Icons } from '../Icons.jsx';
import { TOKEN_GROUPS, TOKENS, BACKGROUND_TOKENS, resolveToken, checkContrast, formatShare } from '../../theme/themeTokens.js';
import { THEME_COVERAGE } from '../../theme/themeCoverage.js';
import { isMobile } from './SettingsKit.jsx';

const defOf = (id) => THEME_DEFS.find(t => t.id === id) || THEME_DEFS[0];

const Swatch4 = ({ sw, size = 40 }) => (
  <span aria-hidden="true" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', width: size, height: size, borderRadius: size > 20 ? '6px' : '3px', overflow: 'hidden', flexShrink: 0 }}>
    {sw.map((c, i) => <span key={i} style={{ background: c }} />)}
  </span>
);

// Compact current-theme readout (General tab, search results).
export function ThemeSummary() {
  const { C, theme } = useAppTheme();
  const def = defOf(theme);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: C.text }}>
      <Swatch4 sw={def.sw} size={18} />
      {def.name}
    </span>
  );
}

// ── Theme picker ─────────────────────────────────────────────
export function ThemePicker({ onPicked }) {
  const { C, theme, setTheme } = useAppTheme();
  return (
    <div role="group" aria-label="Themes" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: '8px' }}>
      {THEME_DEFS.map(t => {
        const on = theme === t.id;
        return (
          <button
            key={t.id} type="button" aria-pressed={on}
            onClick={() => { setTheme(t.id); onPicked?.(t.id); }}
            style={{
              display: 'flex', alignItems: 'center', gap: '12px', padding: '11px 12px', borderRadius: '12px', textAlign: 'left',
              border: `1.5px solid ${on ? C.accent : 'transparent'}`, background: on ? C.accentSoft : 'transparent',
              cursor: 'pointer', transition: 'background 0.15s, border-color 0.15s',
            }}
            className={on ? undefined : 'btn-ghost'}
          >
            <Swatch4 sw={t.sw} />
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: C.text, marginBottom: '2px' }}>{t.name}</span>
              <span style={{ display: 'block', fontSize: '11px', color: C.textM, lineHeight: 1.4 }}>{t.desc}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ── Preview switcher (shared by the palette and contrast rows) ─
function PreviewSwitcher({ preview, setPreview }) {
  const { C, S, theme } = useAppTheme();
  const ids = THEME_DEFS.map(t => t.id);
  const at = Math.max(0, ids.indexOf(preview));
  const step = (d) => setPreview(ids[(at + d + ids.length) % ids.length]);
  const arrow = { ...S.btnGhost, width: '34px', height: '34px', padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '16px', flexShrink: 0 };
  const inUse = preview === theme;
  return (
    <div style={{ display: 'grid', gap: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <button type="button" aria-label="Previous theme" onClick={() => step(-1)} style={arrow} className="btn-ghost">{Icons.chevronLeft}</button>
        <span aria-live="polite" style={{ minWidth: '140px', textAlign: 'center', fontFamily: SH.fp, fontWeight: 600, fontSize: '19px', letterSpacing: '0.04em', color: C.text }}>{defOf(preview).name}</span>
        <button type="button" aria-label="Next theme" onClick={() => step(1)} style={arrow} className="btn-ghost">{Icons.chevronRight}</button>
        <span style={{ fontFamily: SH.fm, fontSize: '11px', padding: '3px 9px', borderRadius: '999px', border: `1px solid ${inUse ? C.border : C.accent}`, color: inUse ? C.textM : C.accent }}>
          {inUse ? 'In use' : 'Preview only'}
        </span>
      </div>
      <div role="group" aria-label="Preview theme" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
        {THEME_DEFS.map(t => {
          const on = t.id === preview;
          return (
            <button key={t.id} type="button" aria-pressed={on} onClick={() => setPreview(t.id)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '11.5px', padding: '4px 10px', borderRadius: '999px', border: `1px solid ${on ? C.text : C.border}`, color: on ? C.text : C.textS, cursor: 'pointer' }}>
              {t.name}
              {t.id === theme && <span aria-label="(in use)" style={{ width: '5px', height: '5px', borderRadius: '50%', background: C.accent }} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// The box that wears the previewed theme.
const stageStyle = (P) => ({ marginTop: '12px', padding: isMobile ? '14px 12px' : '18px', borderRadius: '12px', background: P.bg, color: P.text, border: `1px solid ${P.border}` });
const stageLabel = (P) => ({ fontFamily: SH.fp, fontWeight: 600, fontSize: '11.5px', letterSpacing: '0.14em', textTransform: 'uppercase', color: P.textM });

// ── Palette preview ──────────────────────────────────────────
export function PalettePreview({ preview, setPreview }) {
  const P = buildColors(preview);
  const [view, setView] = useState(isMobile ? 'phone' : 'desktop');
  const cov = THEME_COVERAGE[view];
  const val = (k) => resolveToken(P, k).value;
  const total = TOKENS.reduce((n, k) => n + (cov[k] || 0), 0);
  const bgShare = BACKGROUND_TOKENS.reduce((n, k) => n + (cov[k] || 0), 0);
  const rest = TOKENS.filter(k => !BACKGROUND_TOKENS.includes(k));
  const restShare = rest.reduce((n, k) => n + (cov[k] || 0), 0);
  const seg = (k, w) => <span key={k} title={`C.${k} · ${formatShare(cov[k])}`} style={{ width: `${w}%`, height: '100%', background: val(k) }} />;
  const bar = (h) => ({ display: 'flex', height: h, borderRadius: '6px', overflow: 'hidden', border: `1px solid ${P.border}` });
  const barLabel = { display: 'flex', justifyContent: 'space-between', gap: '10px', fontFamily: SH.fm, fontSize: '11px', color: P.textM, margin: '14px 0 6px' };
  const segBtn = (on) => ({ fontFamily: SH.fm, fontSize: '11px', padding: '5px 10px', color: on ? P.text : P.textS, background: on ? P.surface : 'transparent', cursor: 'pointer' });

  return (
    <div>
      <PreviewSwitcher preview={preview} setPreview={setPreview} />
      <div style={stageStyle(P)}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
          <span style={stageLabel(P)}>Screen coverage</span>
          <span role="group" aria-label="Screen size" style={{ display: 'inline-flex', border: `1px solid ${P.border}`, borderRadius: '8px', overflow: 'hidden' }}>
            <button type="button" aria-pressed={view === 'desktop'} onClick={() => setView('desktop')} style={segBtn(view === 'desktop')}>Desktop</button>
            <button type="button" aria-pressed={view === 'phone'} onClick={() => setView('phone')} style={segBtn(view === 'phone')}>Phone</button>
          </span>
        </div>

        <div style={barLabel}><span>Whole screen</span><span>backgrounds {formatShare(bgShare)}</span></div>
        <div style={bar('34px')} aria-hidden="true">{TOKENS.map(k => seg(k, (cov[k] || 0) / total * 100))}</div>
        <div style={barLabel}><span>Everything but the three backgrounds, enlarged</span><span>{formatShare(restShare)} of the screen</span></div>
        <div style={bar('22px')} aria-hidden="true">{rest.map(k => seg(k, (cov[k] || 0) / restShare * 100))}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', marginTop: '10px', fontSize: '11.5px', color: P.textS }}>
          {TOKEN_GROUPS.map(([g, list]) => (
            <span key={g} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontVariantNumeric: 'tabular-nums' }}>
              <span aria-hidden="true" style={{ width: '10px', height: '10px', borderRadius: '2px', border: `1px solid ${P.border}`, background: val(list[0][0]) }} />
              {g} {formatShare(list.reduce((n, [k]) => n + (cov[k] || 0), 0))}
            </span>
          ))}
        </div>

        {TOKEN_GROUPS.map(([g, list]) => (
          <div key={g} style={{ marginTop: '18px' }}>
            <div style={{ ...stageLabel(P), marginBottom: '4px' }}>{g}</div>
            {list.map(([k, role]) => {
              const r = resolveToken(P, k);
              const tint = r.value.startsWith('rgba');
              return (
                <div key={k} data-token={k} style={{
                  display: 'grid', alignItems: 'center', gap: isMobile ? '4px 12px' : '14px', padding: '6px 0', borderTop: `1px solid ${P.border}`,
                  gridTemplateColumns: isMobile ? 'minmax(0, 1fr) minmax(0, 1.2fr)' : 'minmax(0, 190px) minmax(0, 1fr) 140px',
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: SH.fm, fontSize: '12.5px', color: P.text }}>C.{k}</div>
                    <div style={{ fontSize: '11.5px', color: P.textM, marginTop: '1px' }}>{role}</div>
                  </div>
                  {/* a tint is shown laid over the panel colour, as it appears in the app */}
                  <div aria-hidden="true" style={{
                    height: '34px', borderRadius: '4px', border: '1px solid rgba(128,128,128,0.25)',
                    background: tint ? `linear-gradient(${r.value}, ${r.value}), ${P.surface}` : r.value,
                  }} />
                  <div style={{ fontFamily: SH.fm, fontSize: '11px', lineHeight: 1.5, color: P.textM, fontVariantNumeric: 'tabular-nums', ...(isMobile ? { gridColumn: '1 / -1', display: 'flex', flexWrap: 'wrap', gap: '0 12px' } : {}) }}>
                    <span style={{ display: 'block', color: P.textS, wordBreak: 'break-all' }}>{r.value}</span>
                    <span style={{ display: 'block' }}>{formatShare(cov[k])} of screen</span>
                    {r.fallback && <span style={{ display: 'block', fontStyle: 'italic' }}>Not set; falls back to {r.value}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
        <p style={{ fontSize: '11.5px', lineHeight: 1.6, color: P.textM, margin: '14px 0 0', maxWidth: '70ch' }}>
          Coverage is measured, then rounded: every main page rendered at desktop and phone size, with each colour swapped for a test colour so its pixels can be counted. Every theme shares one layout, so the proportions are the same across themes; only the colours change.
        </p>
      </div>
    </div>
  );
}

// ── Contrast check ───────────────────────────────────────────
export function ContrastCheck({ preview }) {
  const P = buildColors(preview);
  const rows = checkContrast(P);
  const pass = rows.filter(r => r.level === 'pass').length;
  const large = rows.filter(r => r.level === 'large').length;
  const low = rows.filter(r => r.level === 'low').length;
  const dot = (level) => ({
    width: '11px', height: '11px', borderRadius: '50%', border: `1.5px solid ${P.textS}`, flexShrink: 0, boxSizing: 'border-box',
    background: level === 'pass' ? P.textS : level === 'large' ? `linear-gradient(90deg, ${P.textS} 50%, transparent 50%)` : 'transparent',
  });
  return (
    <div style={stageStyle(P)}>
      <p style={{ fontSize: '12.5px', color: P.textS, margin: '0 0 10px', lineHeight: 1.6 }}>
        {defOf(preview).name}: {pass} of {rows.length} pairs pass{large ? `, ${large} only for large or bold text` : ''}{low ? `, ${low} hard to read` : ''}.
      </p>
      {rows.map(r => (
        <div key={`${r.fg}-${r.bg}`} data-pair={`${r.fg}/${r.bg}`} style={{
          display: 'grid', alignItems: 'center', gap: '6px 12px', padding: '7px 0', borderTop: `1px solid ${P.border}`, fontSize: '12.5px',
          gridTemplateColumns: isMobile ? 'minmax(0, 1fr) 64px' : 'minmax(0, 1fr) 118px 70px minmax(0, 170px)',
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: SH.fm, fontSize: '12px', color: P.text }}>{r.fg} on {r.bg}</div>
            <div style={{ fontSize: '11px', color: P.textM }}>{r.use}</div>
          </div>
          <div style={{ padding: '6px 10px', borderRadius: '6px', fontSize: '13px', border: '1px solid rgba(128,128,128,0.2)', background: r.bgValue, color: r.fgValue, whiteSpace: 'nowrap', overflow: 'hidden', ...(isMobile ? { gridColumn: '1 / -1', gridRow: 2 } : {}) }}>
            Aa 가나다
          </div>
          <div style={{ fontFamily: SH.fm, fontSize: '12.5px', textAlign: 'right', color: P.text, fontVariantNumeric: 'tabular-nums' }}>{r.ratio.toFixed(1)} : 1</div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', fontSize: '11.5px', color: P.textS, ...(isMobile ? { gridColumn: '1 / -1' } : {}) }}>
            <span aria-hidden="true" style={dot(r.level)} />{r.label}
          </div>
        </div>
      ))}
    </div>
  );
}
