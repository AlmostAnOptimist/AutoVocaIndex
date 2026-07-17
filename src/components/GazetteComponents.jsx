// src/components/GazetteComponents.jsx
// Shared building blocks for the "Gazette" newspaper-style layout
//
// Every piece here reads colors from useAppTheme() exactly like the rest of
// the app — there is no separate Gazette palette to maintain. The only
// special handling is contrast: bestInk() picks whichever candidate color
// actually contrasts against the live theme's paper, by real WCAG luminance
// math, rather than a hardcoded per-theme list.
//
// Usage reminders for whoever wires these into a page (Stage 4/5):
// - DropCapLead's `columns` prop is NOT responsive on its own — pass
//   columns={isMobile ? 1 : 2} from the caller, following the app's existing
//   isMobile convention. Inline styles can't carry media queries.
// - Grid/column layout (how many GazetteBox/ClassifiedAdBox sit side by
//   side) is the calling page's responsibility — these components are each
//   a single box, agnostic to how many sit in a row.

import { useState, useEffect, useRef } from 'react';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { SH } from '../theme/buildStyles.js';

// ── Contrast helper ─────────────────────────────────────────────

function hexToRgb(hex) {
  if (typeof hex !== 'string' || hex[0] !== '#') return null;
  const parts = hex.length === 4
    ? hex.slice(1).split('').map(c => c + c)
    : [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)];
  return parts.map(p => parseInt(p, 16));
}

function relLuminance(rgb) {
  const [r, g, b] = rgb.map(v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(hexA, hexB) {
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  if (!a || !b) return 1;
  const lA = relLuminance(a) + 0.05;
  const lB = relLuminance(b) + 0.05;
  return lA > lB ? lA / lB : lB / lA;
}

// Returns whichever of `candidates` reads best against `paperHex`.
export function bestInk(paperHex, candidates) {
  let best = candidates[0], bestRatio = 0;
  for (const c of candidates) {
    const ratio = contrastRatio(paperHex, c);
    if (ratio > bestRatio) { bestRatio = ratio; best = c; }
  }
  return best;
}

function isHangul(ch) {
  return /[\u3131-\u318E\uAC00-\uD7A3]/.test(ch || '');
}

// Below this many characters, CSS multi-column layout fights a floated drop
// cap badly (not enough text to fill two columns or wrap around the float).
// Below this many characters, the drop cap itself is disproportionate to the
// content (a 2-character correction topic doesn't want a 3em glyph).
const MIN_CHARS_FOR_COLUMNS = 120;
const MIN_CHARS_FOR_DROPCAP = 20;

// ── GoldRule ─────────────────────────────────────────────────────
// The masthead's Oxford rule — a heavier ink line over a hairline, the
// traditional newspaper masthead treatment, drawn in theme ink. The gold
// foil gradient was retired in Phase B-1; the name is historical and kept
// to avoid touching every Gazette call site (rename candidate for a later
// tidy pass).

export function GoldRule() {
  const { C } = useAppTheme();
  const fade = (col) => `linear-gradient(90deg, transparent, ${col} 7%, ${col} 93%, transparent)`;
  return (
    <div style={{ margin: '12px 0 4px' }}>
      <div style={{ height: '2.5px', backgroundImage: fade(C.text) }} />
      <div style={{ height: '1px', marginTop: '2px', backgroundImage: fade(C.border) }} />
    </div>
  );
}

// ── BylineRule ───────────────────────────────────────────────────

export function BylineRule({ left, center, right }) {
  const { C } = useAppTheme();
  const style = { fontFamily: SH.fm, fontSize: '10px', letterSpacing: '0.06em', textTransform: 'uppercase', color: C.textM };
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: `2px solid ${C.text}`, paddingBottom: '6px', marginBottom: '22px' }}>
      <span style={style}>{left}</span>
      {center && <span style={style}>{center}</span>}
      <span style={style}>{right}</span>
    </div>
  );
}

// ── GazetteFlourish ──────────────────────────────────────────────
// Minimal placeholder ornament for flanking a masthead title. Swap for a
// real illustrated asset once the Art-Deco ornament sheet exists.

export function GazetteFlourish({ flip = false }) {
  const { C } = useAppTheme();
  return (
    <svg width="46" height="14" viewBox="0 0 46 14" style={flip ? { transform: 'scaleX(-1)' } : undefined}>
      <line x1="0" y1="7" x2="16" y2="7" stroke={C.textM} strokeWidth="1" />
      <circle cx="20" cy="7" r="2.5" fill={C.textM} />
      <path d="M24 7 L46 7" stroke={C.textM} strokeWidth="1" />
    </svg>
  );
}

// ── GazetteMasthead ──────────────────────────────────────────────
// cornerLeft / cornerRight: { value, label } small boxed stat in each corner.
// title: plain-text wordmark (Limelight).
// [LANG-SPECIFIC] koreanPrefix: optional Hangul text rendered in Hahmlet before `title`,
//   e.g. koreanPrefix="한국어" title="Gazette".

export function GazetteMasthead({ cornerLeft, cornerRight, title, koreanPrefix, subtitle, isMobile = false }) {
  const { C } = useAppTheme();
  const cornerStyle = {
    border: `1px solid ${C.border}`, padding: '7px 12px', textAlign: 'center',
    minWidth: isMobile ? 0 : '108px', flex: isMobile ? 1 : undefined,
    fontFamily: SH.fm, fontSize: '10px', letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textM,
  };
  // A corner becomes a real <button> when given onClick — e.g. Recaller
  // Review's "due today" corner doubling as the Review All Due action — so
  // the stat and the action fold into one element instead of needing a
  // separate CTA button alongside it. Visually identical to the plain
  // corner otherwise; every other caller (no onClick passed) is unaffected.
  const interactiveCornerStyle = { ...cornerStyle, background: 'none', appearance: 'none', cursor: 'pointer' };
  const cornerValueStyle = { display: 'block', fontSize: '13px', color: C.text, marginBottom: '2px', letterSpacing: '0.02em' };
  const renderCorner = (corner) => corner?.onClick ? (
    <button onClick={corner.onClick} style={interactiveCornerStyle}>
      <b style={cornerValueStyle}>{corner?.value}</b>
      {corner?.label}
    </button>
  ) : (
    <div style={cornerStyle}>
      <b style={cornerValueStyle}>{corner?.value}</b>
      {corner?.label}
    </div>
  );
  const cornerLeftBox  = renderCorner(cornerLeft);
  const cornerRightBox = renderCorner(cornerRight);
  const titleBlock = (
    <div style={{ flex: 1, textAlign: 'center' }}>
      <div style={{ fontFamily: SH.fd, fontSize: isMobile ? '32px' : '46px', lineHeight: 1.1, color: C.text, whiteSpace: isMobile ? 'normal' : 'nowrap' }}>
        {koreanPrefix && <span style={{ fontFamily: SH.fk, fontSize: '0.82em' }}>{koreanPrefix} </span>}
        {title}
      </div>
      {subtitle && (
        <div style={{ fontFamily: SH.fp, fontStyle: 'italic', fontSize: '12.5px', letterSpacing: '0.06em', color: C.textS, marginTop: '4px' }}>
          {subtitle}
        </div>
      )}
    </div>
  );

  if (isMobile) {
    return (
      <div style={{ marginBottom: '10px' }}>
        {titleBlock}
        <div style={{ display: 'flex', gap: '10px', marginTop: '12px' }}>
          {cornerLeftBox}
          {cornerRightBox}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '18px', marginBottom: '10px' }}>
      {cornerLeftBox}
      {titleBlock}
      {cornerRightBox}
    </div>
  );
}

// ── Kicker / Headline / Standfirst ───────────────────────────────

export function GazetteKicker({ children }) {
  const { C } = useAppTheme();
  return (
    <div style={{ fontFamily: SH.fp, fontSize: '11.5px', fontWeight: 600, letterSpacing: '0.18em', textTransform: 'uppercase', color: C.accent, marginBottom: '6px' }}>
      {children}
    </div>
  );
}

export function GazetteHeadline({ children, size = 'lg' }) {
  const { C } = useAppTheme();
  return (
    <div style={{ fontFamily: SH.fd, fontSize: size === 'lg' ? '32px' : '24px', lineHeight: 1.12, color: C.text, marginBottom: '8px' }}>
      {children}
    </div>
  );
}

export function GazetteStandfirst({ children }) {
  const { C } = useAppTheme();
  return (
    <div style={{ fontFamily: SH.fb, fontStyle: 'italic', fontSize: '14px', color: C.textS, marginBottom: '14px', lineHeight: 1.5 }}>
      {children}
    </div>
  );
}

// ── DropCapLead ──────────────────────────────────────────────────
// `text` may be a single string or an array of paragraph strings — only the
// first paragraph gets the drop cap. The drop cap's font/scale/color is
// chosen by checking the actual first character (Hangul vs Latin), not by
// any language flag passed in.

export function DropCapLead({ text, columns = 2 }) {
  const { C } = useAppTheme();
  const paragraphs = Array.isArray(text) ? text : [text];
  const [first, ...restParas] = paragraphs;
  if (!first) return null;

  const totalLength = paragraphs.join(' ').length;
  // Both back off automatically based on actual content length, rather than
  // trusting every caller to pass the right `columns` value — short content
  // (a note preview, a single short phrase) breaks badly otherwise.
  const effectiveColumns = totalLength < MIN_CHARS_FOR_COLUMNS ? 1 : columns;
  const useDropCap = totalLength >= MIN_CHARS_FOR_DROPCAP;

  const firstChar = first.charAt(0);
  const rest = first.slice(1);
  const kr = isHangul(firstChar);
  const dropColor = bestInk(C.bg, [C.goldDeep, C.accent]);
  const pStyle = { fontFamily: SH.fb, fontSize: '13.5px', lineHeight: 1.68, color: C.textS, margin: '0 0 10px' };

  return (
    <div style={{ columnCount: effectiveColumns, columnGap: '26px' }}>
      <p style={pStyle}>
        {useDropCap ? (
          <>
            <span style={{
              fontFamily: kr ? SH.fk : SH.fd,
              fontWeight: kr ? 600 : 400,
              fontSize: kr ? '2.3em' : '3.1em',
              lineHeight: kr ? 0.85 : 0.78,
              float: 'left',
              padding: kr ? '0 8px 0 0' : '2px 8px 0 0',
              color: dropColor,
            }}>{firstChar}</span>
            {rest}
          </>
        ) : first}
      </p>
      {restParas.map((p, i) => <p key={i} style={pStyle}>{p}</p>)}
    </div>
  );
}

// ── GazetteBox / BoxRow / ForecastRow / NoticeEntry / BoxQuote ──
// One generic boxed-sidebar shell, reused for Almanac, Forecast, Notices,
// Dispatches, Letters To The Editor. variant="warning" gives the
// public-notice treatment (e.g. "Sources Gone Adrift").

export function GazetteBox({ title, variant = 'default', children }) {
  const { C } = useAppTheme();
  const warn = variant === 'warning';
  return (
    <div style={{
      border: `${warn ? 2 : 1}px solid ${warn ? C.warning : C.borderB}`,
      background: warn ? `${C.warning}11` : C.surface,
      padding: '14px 16px',
    }}>
      <div style={{
        fontFamily: SH.fb, fontWeight: 700, fontSize: '11px', letterSpacing: '0.13em', textTransform: 'uppercase',
        color: warn ? C.warning : C.text, borderBottom: `1px solid ${warn ? C.warning : C.border}`,
        paddingBottom: '7px', marginBottom: '10px',
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

// Label/value row (Almanac-style). `delta`, if given, follows the app's
// existing convention — pass it only where down=good/up=bad actually
// applies (e.g. weight); omit it otherwise and just format `value` yourself.
export function BoxRow({ label, value, delta }) {
  const { C } = useAppTheme();
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '5px 0', borderBottom: `1px solid ${C.border}`, fontSize: '12px' }}>
      <span style={{ color: C.textM, letterSpacing: '0.03em' }}>{label}</span>
      <span style={{ fontFamily: SH.fm, color: C.text, fontSize: '12.5px' }}>
        {value}{' '}
        {delta != null && (
          <span style={{ color: delta <= 0 ? C.success : C.danger }}>{delta > 0 ? `+${delta}` : delta}</span>
        )}
      </span>
    </div>
  );
}

export function ForecastRow({ label, pct, color }) {
  const { C } = useAppTheme();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', fontSize: '12px', color: C.textS }}>
      <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: color || C.accent, flexShrink: 0 }} />
      {label}
      <span style={{ marginLeft: 'auto', fontFamily: SH.fm, fontSize: '10.5px', color: C.textM }}>{pct}</span>
    </div>
  );
}

// ── RecordsStrip ─────────────────────────────────────────────────
// A single row of label/value records (best day, longest streak, etc.)
// dispersed horizontally and wrapping onto additional lines on narrow
// viewports — distinct from BoxRow (stacked inside a box) and BylineRule
// (exactly three fixed slots, no wrapping). `items` is an array of
// { label, value } objects; falsy entries (e.g. a record that hasn't
// happened yet) are skipped rather than rendered empty.
// Record-date formatters for RecordsStrip values — moved here from
// FlashcardsPage (Stage A-3) so AVI's records strip shares one copy
// instead of growing a drifted sibling.
export function fmtRecordDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const mon  = date.toLocaleString('en-GB', { month: 'short' });
  return `${d} ${mon} '${String(y).slice(2)}`;
}

export function fmtMonthLabel(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-').map(Number);
  const mon = new Date(y, m - 1, 1).toLocaleString('en-GB', { month: 'short' });
  return `${mon} '${String(y).slice(2)}`;
}

export function fmtWeekRange(weekStartStr) {
  if (!weekStartStr) return '';
  const [y, m, d] = weekStartStr.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  const end   = new Date(y, m - 1, d + 6);
  const mon   = (dt) => dt.toLocaleString('en-GB', { month: 'short' });
  const yr    = String(end.getFullYear()).slice(2);
  return start.getMonth() === end.getMonth()
    ? `${start.getDate()}–${end.getDate()} ${mon(end)} '${yr}`
    : `${start.getDate()} ${mon(start)} – ${end.getDate()} ${mon(end)} '${yr}`;
}

export function RecordsStrip({ items, isMobile = false }) {
  const { C } = useAppTheme();
  const shown = (items || []).filter(Boolean);
  if (!shown.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: isMobile ? 'center' : undefined, flexWrap: isMobile ? undefined : 'wrap', justifyContent: 'center', gap: isMobile ? '4px' : '6px 22px', marginBottom: '28px' }}>
      {shown.map((item, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
          <span style={{ fontFamily: SH.fb, fontWeight: 700, fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: C.textM }}>
            {item.label}
          </span>
          <span style={{ fontFamily: SH.fm, fontSize: '13px', color: C.text }}>
            {item.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export function NoticeEntry({ name, meta, flag, last, onClick }) {
  const { C } = useAppTheme();
  return (
    <div onClick={onClick} style={{ padding: '8px 0', borderBottom: last ? 'none' : `1px solid ${C.border}`, fontSize: '12px', cursor: onClick ? 'pointer' : 'default' }}>
      <div style={{ fontWeight: 600, color: C.text, fontSize: '12.5px' }}>{name}</div>
      <div style={{ color: C.textM, fontSize: '11px', marginTop: '2px' }}>{meta}</div>
      {flag && (
        <span style={{
          marginTop: '5px', display: 'inline-block', border: `1px solid ${C.danger}`, color: C.danger,
          fontFamily: SH.fp, fontSize: '10.5px', letterSpacing: '0.07em', textTransform: 'uppercase', padding: '2px 8px',
        }}>{flag}</span>
      )}
    </div>
  );
}

// A short quoted excerpt inside a box — e.g. "From the Doctor's Desk".
export function BoxQuote({ label, children }) {
  const { C } = useAppTheme();
  return (
    <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: `1px dashed ${C.border}`, fontSize: '11px', fontStyle: 'italic', color: C.textS, lineHeight: 1.5 }}>
      <b style={{ fontStyle: 'normal', color: C.textM, fontSize: '10px', letterSpacing: '0.05em', textTransform: 'uppercase', display: 'block', marginBottom: '3px' }}>{label}</b>
      "{children}"
    </div>
  );
}

// ── GazetteFig ───────────────────────────────────────────────────
// A bordered "engraving" panel for a chart/diagram, with an italic caption.

export function GazetteFig({ caption, children }) {
  const { C } = useAppTheme();
  return (
    <div>
      <div style={{ border: `1px solid ${C.border}`, background: C.surface, padding: '16px' }}>
        {children}
      </div>
      {caption && (
        <div style={{ fontFamily: SH.fb, fontStyle: 'italic', fontSize: '11px', color: C.textM, textAlign: 'center', marginTop: '8px' }}>
          {caption}
        </div>
      )}
    </div>
  );
}

// ── GazetteSplitFig ────────────────────────────────────────────────
// A two-part feature box: a label on one side, a short description (plus
// an optional italic closing line) on the other. `flip` swaps which side
// holds which — pass it alternating across a stack of these for the
// classic "every other row reversed" classified-ad rhythm. Clickable
// when `onClick` is given; renders as a plain box otherwise.

export function GazetteSplitFig({ label, description, bestFor, flip = false, onClick }) {
  const { C } = useAppTheme();
  const [hover, setHover] = useState(false);

  const labelBlock = (
    <div style={{
      flex: '0 0 34%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '14px 12px', textAlign: 'center',
    }}>
      <span style={{ fontFamily: SH.fd, fontSize: '17px', color: C.text, lineHeight: 1.25 }}>{label}</span>
    </div>
  );
  const descBlock = (
    <div style={{ flex: '1 1 auto', padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: '5px', justifyContent: 'center' }}>
      <div style={{ fontFamily: SH.fb, fontSize: '12.5px', color: C.textS, lineHeight: 1.5 }}>{description}</div>
      {bestFor && (
        <div style={{ fontFamily: SH.fb, fontStyle: 'italic', fontSize: '12px', color: C.textM, lineHeight: 1.4 }}>{bestFor}</div>
      )}
    </div>
  );
  const divider = <div style={{ width: '1px', background: C.borderB, alignSelf: 'stretch' }} />;

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'stretch', width: '100%', textAlign: 'left',
        border: `1px solid ${C.borderB}`, background: hover ? C.raised : C.surface,
        cursor: onClick ? 'pointer' : 'default', padding: 0, minHeight: '82px',
        transition: 'background 0.15s', font: 'inherit',
      }}
    >
      {flip ? <>{descBlock}{divider}{labelBlock}</> : <>{labelBlock}{divider}{descBlock}</>}
    </button>
  );
}

// ── ClassifiedAdBox ──────────────────────────────────────────────
// One queue-tier column (Study / Mining / Casual). Real items render first,
// capped at `slots`; anything beyond that collapses into a single "+N more"
// line instead of growing the box. If there are fewer than `slots` real
// items, real history-derived fillerFacts pad the remainder — never
// invented text. A small ornament always anchors the bottom of the box via
// flex + marginTop:auto, regardless of how many rows ended up above it.

export function ClassifiedAdBox({ title, tagline, items = [], fillerFacts = [], slots = 4 }) {
  const { C } = useAppTheme();
  const [page, setPage] = useState(0);

  const totalPages   = Math.max(1, Math.ceil(items.length / slots));
  const safePage      = Math.min(page, totalPages - 1);
  const isLastPage    = safePage === totalPages - 1;
  const hasMorePages  = totalPages > 1;
  const shown         = items.slice(safePage * slots, safePage * slots + slots);
  // Filler facts only ever appear on the last page — earlier pages are full
  // of real items by definition, so there's nothing to pad there.
  const fillers       = isLastPage ? fillerFacts.slice(0, Math.max(0, slots - shown.length)) : [];
  const nextBatchSize = hasMorePages && !isLastPage
    ? Math.min(slots, items.length - (safePage + 1) * slots)
    : 0;

  const advanceStyle = {
    fontSize: '10.5px', fontStyle: 'italic', color: C.textM, padding: '6px 0', textAlign: 'center',
    background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', width: '100%',
  };

  return (
    <div style={{
      border: `1.5px solid ${C.borderB}`, padding: '12px 14px', textAlign: 'center',
      display: 'flex', flexDirection: 'column', minHeight: '230px',
    }}>
      <div style={{
        fontFamily: SH.fb, fontWeight: 700, fontSize: '13px', letterSpacing: '0.04em', textTransform: 'uppercase',
        borderBottom: `1px solid ${C.border}`, paddingBottom: '6px', marginBottom: '8px', color: C.text,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span>{title}</span>
        {hasMorePages && (
          <span style={{ fontFamily: SH.fm, fontSize: '10px', color: C.textM, fontWeight: 400, letterSpacing: 0, textTransform: 'none' }}>
            {safePage + 1}/{totalPages}
          </span>
        )}
      </div>
      {tagline && (
        <div style={{ fontFamily: SH.fp, fontStyle: 'italic', fontSize: '10.5px', color: C.textM, marginBottom: '8px' }}>{tagline}</div>
      )}
      {shown.map((item, i) => (
        <div key={item.id ?? i} onClick={item.onClick} style={{
          fontSize: '11.5px', color: C.textS, padding: '4px 0', textAlign: 'left',
          borderTop: i === 0 ? 'none' : `1px dotted ${C.border}`,
          cursor: item.onClick ? 'pointer' : 'default',
        }}>
          {item.node ?? <><b style={{ color: C.text }}>{item.title}</b> — {item.meta}</>}
        </div>
      ))}
      {fillers.map((fact, i) => (
        <div key={i} style={{
          fontSize: '10.5px', fontStyle: 'italic', color: C.textM, padding: '6px 0', textAlign: 'left', lineHeight: 1.5,
          borderTop: (shown.length === 0 && i === 0) ? 'none' : `1px dotted ${C.border}`,
        }}>{fact}</div>
      ))}
      {!isLastPage && (
        <button onClick={() => setPage(p => p + 1)} style={advanceStyle}>+{nextBatchSize} more waiting →</button>
      )}
      {isLastPage && hasMorePages && (
        <button onClick={() => setPage(0)} style={advanceStyle}>‹ Back to start</button>
      )}
      <div style={{ marginTop: 'auto', paddingTop: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
        <span style={{ height: '1px', width: '18px', background: C.borderB }} />
        <span style={{ width: '4px', height: '4px', borderRadius: '50%', background: C.textM }} />
        <span style={{ height: '1px', width: '18px', background: C.borderB }} />
      </div>
    </div>
  );
}

// ── GazetteColumnFeature ─────────────────────────────────────────
// The recurring "column" treatment for Dream Log / Today's Column — a
// byline row over a double-rule top border, with a drop-cap lead and an
// optional side rail (a photo placeholder, carousel arrows, etc).

export function GazetteColumnFeature({ byline, meta, title, text, side, columns = 1 }) {
  const { C } = useAppTheme();
  return (
    <div style={{ borderTop: `3px double ${C.text}`, paddingTop: '16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '4px' }}>
        <span style={{ fontFamily: SH.fp, fontSize: '11px', letterSpacing: '0.1em', textTransform: 'uppercase', color: C.accent2 }}>{byline}</span>
        <span style={{ fontFamily: SH.fm, fontSize: '10.5px', color: C.textM }}>{meta}</span>
      </div>
      {title && (
        <div style={{ fontFamily: SH.fb, fontWeight: 700, fontSize: '15px', color: C.text, marginBottom: '8px' }}>{title}</div>
      )}
      {side ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 150px', gap: '24px' }}>
          <DropCapLead text={text} columns={columns} />
          {side}
        </div>
      ) : (
        <DropCapLead text={text} columns={columns} />
      )}
    </div>
  );
}

// ── PlaceholderBlock ─────────────────────────────────────────────
// Dashed stand-in for an illustrated asset that doesn't exist yet.

export function PlaceholderBlock({ label, height = 120 }) {
  const { C } = useAppTheme();
  return (
    <div style={{
      border: `1px dashed ${C.borderB}`,
      backgroundImage: `repeating-linear-gradient(135deg, ${C.accent}1A 0 10px, ${C.accent}0A 10px 20px)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
      fontFamily: SH.fm, fontSize: '10.5px', color: C.textM, letterSpacing: '0.03em', padding: '10px', height: `${height}px`,
    }}>
      {label}
    </div>
  );
}

// ── GazetteAdSpace ─────────────────────────────────────────────
// Renders today's selected ad image. `pool` is a lazy Vite glob loader map
// ({ filename: () => Promise<module> }) so only the one image actually
// picked for today is ever fetched, never the whole ad pool. Which filename
// gets selected is decided by plateEngine.js's pickAd() in the caller — this
// component only knows how to load and frame whatever filename it's given.
//
// No caption, by design (Stage 13 plan). Images vary wildly in aspect
// ratio, so the frame uses a fixed max-height with object-fit: contain
// (letterboxed on the panel's own surface color) rather than cropping.
// Renders nothing while loading, on an empty pool, or if nothing was
// selected — never a placeholder or broken-image state.
// `fill`: when true, the wrapper becomes a flex item that grows to consume
// whatever vertical space its flex-column parent gives it, and the image
// scales up to match (object-fit: contain still preserves aspect ratio —
// it letterboxes within the box rather than stretching or cropping).
// Intended for placement inside a sidebar column alongside other content,
// not for the old standalone full-width placement (still the default).
export function GazetteAdSpace({ pool, filename, onClick, fill = false, snapToRef = null, snapThreshold = 40, snapMax = 420 }) {
  const { C } = useAppTheme();
  const [url, setUrl] = useState(null);
  const [snapHeight, setSnapHeight] = useState(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    const loader = filename && pool && pool[filename];
    if (!loader) return;
    loader().then(mod => { if (!cancelled) setUrl(mod.default); }).catch(() => {});
    return () => { cancelled = true; };
  }, [filename, pool]);

  // Fold-line snap (Stage A-2). When snapToRef is provided (fill mode only),
  // measure the target box's bottom edge against this wrapper's top. The
  // frame's natural height is min(available space, snapMax); if aligning the
  // frame's bottom edge to the target's bottom edge would change its height
  // by no more than snapThreshold px, pin the frame to that exact height so
  // the two edges form a clean fold. snapMax is a hard ceiling — a snap that
  // would need more height never engages. ResizeObserver rather than a
  // one-shot measure: the ad image loads async and the target box changes
  // height (Letters pagination), and the snapped height never feeds back
  // into either observed element's size, so no observer loop is possible.
  useEffect(() => {
    if (!snapToRef || !url) { setSnapHeight(null); return; }
    const measure = () => {
      const wrap = wrapRef.current, target = snapToRef.current;
      if (!wrap || !target) { setSnapHeight(null); return; }
      const wrapRect = wrap.getBoundingClientRect();
      const targetBottom = target.getBoundingClientRect().bottom;
      const natural = Math.min(wrapRect.height, snapMax);
      const desired = targetBottom - wrapRect.top;
      if (desired > 0 && desired <= snapMax && Math.abs(desired - natural) <= snapThreshold) {
        setSnapHeight(Math.round(desired));
      } else {
        setSnapHeight(null);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (wrapRef.current) ro.observe(wrapRef.current);
    if (snapToRef.current) ro.observe(snapToRef.current);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [snapToRef, url, snapThreshold, snapMax]);

  if (!url) return null;

  const snapped = snapHeight != null;

  return (
    <div ref={wrapRef} onClick={onClick} style={{
      display: 'flex', justifyContent: 'center',
      alignItems: snapped ? 'flex-start' : 'center',
      cursor: onClick ? 'pointer' : 'default',
      ...(fill ? { flex: 1, minHeight: 0 } : {}),
    }}>
      <img src={url} alt="" style={{
        border: `1px solid ${C.border}`, background: C.surface, padding: '6px',
        ...(fill
          ? { width: '100%', height: snapped ? `${snapHeight}px` : '100%', maxHeight: `${snapMax}px`, objectFit: 'contain' }
          : { maxHeight: '240px', maxWidth: '100%', objectFit: 'contain' }),
      }} />
    </div>
  );
}