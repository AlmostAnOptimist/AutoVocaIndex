// src/components/Ornaments.jsx
// Art Deco ornament kit (O1). Flat line art drawn from the active theme's
// tokens, so every piece recolours with the theme. No image assets, so the
// kit also works in the AutoVocaIndex template (which commits no PNGs).
//
// Colour roles (useOrnament):
//   line   — heavy strokes, end caps        C.accent
//   thread — thin inner lines               C.accent2, or a per-theme pick
//   jewel  — small solid diamonds           C.tLa, or a per-theme pick
//   plate  — fill behind a label            C.cardBg || C.surface
//   ground — fill inside stacked diamonds   whatever the piece sits on (C.bg)
//
// Pieces: Rail (horizontal divider with a hexagon label plate), ScorePlate,
// Pendant (vertical diamond chain, 'open' or 'close'), Medallion (tall
// hexagon), CornerFrame, MiniRule, TabRail (extends a tab menu's line to
// the page edge), PendantFill (closing pendant that appears only when a
// column has spare height), and SessionIntro (the opening bookend screen).
// Everything but SessionIntro is decorative and aria-hidden.
// Leaf module: imports hooks and theme helpers only, never a page.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { useKeyShortcuts } from '../hooks/useKeyShortcuts.js';
import { SH } from '../theme/buildStyles.js';

const isMobile = typeof window !== 'undefined' && (window.innerWidth <= 700 || window.matchMedia('(hover: none) and (pointer: coarse) and (orientation: portrait)').matches);

// Per-theme thread/jewel picks where the defaults are too faint or too close
// to the line colour. Values name keys on C.
const ORN_ROLES = {
  hanok:   { thread: 'tL', jewel: 'danger' }, // sage thread, dancheong-red jewel
  feather: { thread: 'tL' },
  koi:     { thread: 'tL' },
  baroque: { jewel: 'danger' },
};

export function useOrnament() {
  const { C, theme } = useAppTheme();
  return useMemo(() => {
    const r = ORN_ROLES[theme] || {};
    return {
      line:   C.accent,
      thread: C[r.thread || 'accent2'] || C.accent2,
      jewel:  C[r.jewel || 'tLa'] || C.warning,
      plate:  C.cardBg || C.surface,
      ground: C.bg,
      text:   C.text,
    };
  }, [C, theme]);
}

// Solid colour of `over` laid at `alpha` on `base` (both #rrggbb). Used to
// match a tinted box background, e.g. GazetteBox's `${C.warning}11` wash.
export function blendHex(base, over, alpha) {
  const p = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const b = p(base), o = p(over);
  if (b.some(Number.isNaN) || o.some(Number.isNaN)) return base;
  return '#' + b.map((v, i) => Math.round(v + (o[i] - v) * alpha).toString(16).padStart(2, '0')).join('');
}

// Diamond centred on (cx, cy), half-width rx, half-height ry.
const dia = (cx, cy, rx, ry = rx) => `${cx - rx},${cy} ${cx},${cy - ry} ${cx + rx},${cy} ${cx},${cy + ry}`;

// ── Rail ─────────────────────────────────────────────────────
// Double rule + stacked diamonds + a hexagon label plate, drawn on a
// 340×60 grid and scaled to `width`. Shrinks with its container.
export function Rail({ label, width = 340, ground, style }) {
  const o = useOrnament();
  const g = ground || o.ground;
  return (
    <div aria-hidden="true" style={{ position: 'relative', width: `${width}px`, maxWidth: '100%', aspectRatio: '340 / 60', margin: '0 auto', flexShrink: 0, ...style }}>
      <svg width="100%" height="100%" viewBox="0 0 340 60" style={{ position: 'absolute', inset: 0, display: 'block' }}>
        <line x1="10" y1="30" x2="84" y2="30" stroke={o.thread} strokeWidth="1" />
        <line x1="256" y1="30" x2="330" y2="30" stroke={o.thread} strokeWidth="1" />
        <line x1="34" y1="23.5" x2="86" y2="23.5" stroke={o.thread} strokeWidth="1" />
        <line x1="254" y1="23.5" x2="306" y2="23.5" stroke={o.thread} strokeWidth="1" />
        <line x1="24" y1="36.5" x2="86" y2="36.5" stroke={o.line} strokeWidth="3" />
        <line x1="254" y1="36.5" x2="316" y2="36.5" stroke={o.line} strokeWidth="3" />
        <polygon points={dia(5, 30, 5)} fill={o.line} />
        <polygon points={dia(335, 30, 5)} fill={o.line} />
        <polygon points={dia(88, 30, 8)} fill={g} stroke={o.thread} strokeWidth="1.25" />
        <polygon points={dia(252, 30, 8)} fill={g} stroke={o.thread} strokeWidth="1.25" />
        <polygon points={dia(99, 30, 10)} fill={g} stroke={o.thread} strokeWidth="1.25" />
        <polygon points={dia(241, 30, 10)} fill={g} stroke={o.thread} strokeWidth="1.25" />
        <polygon points={dia(112, 30, 13)} fill={g} stroke={o.line} strokeWidth="2" />
        <polygon points={dia(228, 30, 13)} fill={g} stroke={o.line} strokeWidth="2" />
        <polygon points={dia(112, 30, 5)} fill={o.jewel} />
        <polygon points={dia(228, 30, 5)} fill={o.jewel} />
        <polygon points="126,30 140,14 200,14 214,30 200,46 140,46" fill={o.plate} stroke={o.line} strokeWidth="2" strokeLinejoin="miter" />
        <polygon points="133,30 143,19 197,19 207,30 197,41 143,41" fill="none" stroke={o.thread} strokeWidth="1" />
      </svg>
      {label && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: SH.fk, fontWeight: 700, fontSize: `${Math.round(width * 16 / 340)}px`, color: o.text, lineHeight: 1 }}>
          {label}
        </div>
      )}
    </div>
  );
}

// ── ScorePlate ───────────────────────────────────────────────
// A wide hexagon plate flanked by diamond clusters, for a quiz score.
export function ScorePlate({ children, width = 340, ground, style }) {
  const { C } = useAppTheme();
  const o = useOrnament();
  const g = ground || o.ground;
  return (
    <div style={{ position: 'relative', width: `${width}px`, maxWidth: '100%', aspectRatio: '340 / 110', margin: '0 auto', ...style }}>
      <svg aria-hidden="true" width="100%" height="100%" viewBox="0 0 340 110" style={{ position: 'absolute', inset: 0, display: 'block' }}>
        <line x1="10" y1="55" x2="40" y2="55" stroke={o.thread} strokeWidth="1" />
        <line x1="300" y1="55" x2="330" y2="55" stroke={o.thread} strokeWidth="1" />
        <line x1="22" y1="47" x2="44" y2="47" stroke={o.thread} strokeWidth="1" />
        <line x1="296" y1="47" x2="318" y2="47" stroke={o.thread} strokeWidth="1" />
        <line x1="18" y1="63" x2="44" y2="63" stroke={o.line} strokeWidth="3" />
        <line x1="296" y1="63" x2="322" y2="63" stroke={o.line} strokeWidth="3" />
        <polygon points={dia(5, 55, 5)} fill={o.line} />
        <polygon points={dia(335, 55, 5)} fill={o.line} />
        <polygon points={dia(44, 55, 8)} fill={g} stroke={o.thread} strokeWidth="1.25" />
        <polygon points={dia(296, 55, 8)} fill={g} stroke={o.thread} strokeWidth="1.25" />
        <polygon points={dia(54, 55, 10)} fill={g} stroke={o.thread} strokeWidth="1.25" />
        <polygon points={dia(286, 55, 10)} fill={g} stroke={o.thread} strokeWidth="1.25" />
        <polygon points={dia(66, 55, 12)} fill={g} stroke={o.line} strokeWidth="2" />
        <polygon points={dia(274, 55, 12)} fill={g} stroke={o.line} strokeWidth="2" />
        <polygon points={dia(66, 55, 5)} fill={o.jewel} />
        <polygon points={dia(274, 55, 5)} fill={o.jewel} />
        <polygon points="78,55 104,14 236,14 262,55 236,96 104,96" fill={o.plate} stroke={o.line} strokeWidth="2" strokeLinejoin="miter" />
        <polyline points="80,58 104,95 236,95 260,58" fill="none" stroke={o.line} strokeWidth="3.5" strokeLinejoin="miter" />
        <polygon points="88,55 108,22 232,22 252,55 232,88 108,88" fill="none" stroke={o.thread} strokeWidth="1" />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: SH.fd, fontSize: `${Math.round(width * 40 / 340)}px`, color: C.accent, lineHeight: 1 }}>
        {children}
      </div>
    </div>
  );
}

// ── Pendant ──────────────────────────────────────────────────
// Vertical chain: 'open' starts at a jewel and descends into a diamond
// cluster (sits above whatever it opens); 'close' hangs from a cluster and
// ends in a jewel. `height` stretches the stem (in drawing units; 110 is the
// shortest that keeps the threads); `scale` enlarges the whole chain.
export function Pendant({ variant = 'open', height = 150, scale = 1, ground, style }) {
  const o = useOrnament();
  const g = ground || o.ground;
  const L = Math.max(110, Math.round(height));
  const open = variant === 'open';
  return (
    <svg aria-hidden="true" width={60 * scale} height={L * scale} viewBox={`0 0 60 ${L}`} style={{ display: 'block', flexShrink: 0, ...style }}>
      {open ? (
        <>
          <line x1="30" y1="12" x2="30" y2={L - 32} stroke={o.line} strokeWidth="2" />
          <line x1="22.5" y1="36" x2="22.5" y2={L - 46} stroke={o.thread} strokeWidth="1" />
          <line x1="37.5" y1="36" x2="37.5" y2={L - 46} stroke={o.thread} strokeWidth="1" />
          <polygon points={dia(22.5, 36, 2.5, 5)} fill={o.thread} />
          <polygon points={dia(37.5, 36, 2.5, 5)} fill={o.thread} />
          <polygon points={dia(30, 6, 6)} fill={o.jewel} />
          <polygon points={dia(30, L - 46, 8)} fill={g} stroke={o.thread} strokeWidth="1.25" />
          <polygon points={dia(30, L - 34, 11)} fill={g} stroke={o.thread} strokeWidth="1.25" />
          <polygon points={dia(30, L - 19, 16)} fill={g} stroke={o.line} strokeWidth="2" />
          <polygon points={dia(30, L - 19, 6)} fill={o.jewel} />
        </>
      ) : (
        <>
          <line x1="30" y1="32" x2="30" y2={L - 12} stroke={o.line} strokeWidth="2" />
          <line x1="22.5" y1="46" x2="22.5" y2={L - 36} stroke={o.thread} strokeWidth="1" />
          <line x1="37.5" y1="46" x2="37.5" y2={L - 36} stroke={o.thread} strokeWidth="1" />
          <polygon points={dia(22.5, L - 36, 2.5, 5)} fill={o.thread} />
          <polygon points={dia(37.5, L - 36, 2.5, 5)} fill={o.thread} />
          <polygon points={dia(30, L - 6, 6)} fill={o.jewel} />
          <polygon points={dia(30, 46, 8)} fill={g} stroke={o.thread} strokeWidth="1.25" />
          <polygon points={dia(30, 34, 11)} fill={g} stroke={o.thread} strokeWidth="1.25" />
          <polygon points={dia(30, 19, 16)} fill={g} stroke={o.line} strokeWidth="2" />
          <polygon points={dia(30, 19, 6)} fill={o.jewel} />
        </>
      )}
    </svg>
  );
}

// ── Medallion ────────────────────────────────────────────────
// Tall hexagon (points up and down) holding a short stack of content.
export function Medallion({ children, style }) {
  const o = useOrnament();
  return (
    <div style={{ position: 'relative', width: '260px', height: '300px', flexShrink: 0, ...style }}>
      <svg aria-hidden="true" width="260" height="300" viewBox="0 0 260 300" style={{ position: 'absolute', inset: 0, display: 'block' }}>
        <polygon points="130,1 259,62 259,238 130,299 1,238 1,62" fill={o.plate} stroke={o.line} strokeWidth="2" />
        <polyline points="3,237 130,297 257,237" fill="none" stroke={o.line} strokeWidth="4" strokeLinejoin="miter" />
        <polygon points="130,12 248,68 248,232 130,288 12,232 12,68" fill="none" stroke={o.thread} strokeWidth="1" />
        <polygon points={dia(12, 68, 4, 5)} fill={o.jewel} />
        <polygon points={dia(248, 68, 4, 5)} fill={o.jewel} />
        <polygon points={dia(12, 232, 4, 5)} fill={o.jewel} />
        <polygon points={dia(248, 232, 4, 5)} fill={o.jewel} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px', padding: '0 24px', textAlign: 'center' }}>
        {children}
      </div>
    </div>
  );
}

// ── MiniRule ─────────────────────────────────────────────────
export function MiniRule({ width = 90 }) {
  const o = useOrnament();
  return (
    <svg aria-hidden="true" width={width} height="10" viewBox="0 0 90 10" style={{ display: 'block', flexShrink: 0 }}>
      <line x1="0" y1="5" x2="38" y2="5" stroke={o.thread} strokeWidth="1" />
      <polygon points={dia(45, 5, 4)} fill={o.jewel} />
      <line x1="52" y1="5" x2="90" y2="5" stroke={o.thread} strokeWidth="1" />
    </svg>
  );
}

// ── CornerFrame ──────────────────────────────────────────────
// Double frame (heavier base) with a jewel at each inner corner.
export function CornerFrame({ children, style, innerStyle }) {
  const o = useOrnament();
  const corner = { position: 'absolute', width: '10px', height: '10px', background: o.jewel, transform: 'rotate(45deg)' };
  return (
    <div style={{ position: 'relative', boxSizing: 'border-box', border: `1.5px solid ${o.line}`, borderBottomWidth: '5px', background: o.plate, padding: '10px', ...style }}>
      <div style={{ boxSizing: 'border-box', border: `1px solid ${o.thread}`, padding: '28px 18px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', ...innerStyle }}>
        {children}
      </div>
      <div aria-hidden="true" style={{ ...corner, top: '5px', left: '5px' }} />
      <div aria-hidden="true" style={{ ...corner, top: '5px', right: '5px' }} />
      <div aria-hidden="true" style={{ ...corner, bottom: '5px', left: '5px' }} />
      <div aria-hidden="true" style={{ ...corner, bottom: '5px', right: '5px' }} />
    </div>
  );
}

// ── TabRail ──────────────────────────────────────────────────
// Sits beside a tab menu (flex sibling) and carries its line to the edge:
// a diamond cluster against the menu, a thin-over-heavy double rule, and an
// end cap. side='left' mirrors it for menus centred on phones. Collapses to
// nothing when there's no room.
export function TabRail({ side = 'right', ground }) {
  const o = useOrnament();
  const g = ground || o.ground;
  const left = side === 'left';
  return (
    <div aria-hidden="true" style={{ flex: '1 1 0', minWidth: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', flexDirection: left ? 'row-reverse' : 'row', alignSelf: 'center' }}>
      <svg width="32" height="16" viewBox="0 0 32 16" style={{ display: 'block', flexShrink: 0, transform: left ? 'scaleX(-1)' : undefined }}>
        <polygon points={dia(26, 8, 6, 5)} fill={g} stroke={o.thread} strokeWidth="1" />
        <polygon points={dia(17, 8, 6, 6)} fill={g} stroke={o.thread} strokeWidth="1" />
        <polygon points={dia(8, 8, 7)} fill={g} stroke={o.line} strokeWidth="1.5" />
        <polygon points={dia(8, 8, 3)} fill={o.jewel} />
      </svg>
      <div style={{ flex: 1, minWidth: 0, height: '6px', boxSizing: 'border-box', borderTop: `1px solid ${o.thread}`, borderBottom: `2px solid ${o.line}` }} />
      <svg width="8" height="8" viewBox="0 0 8 8" style={{ display: 'block', flexShrink: 0 }}>
        <polygon points={dia(4, 4, 4)} fill={o.line} />
      </svg>
    </div>
  );
}

// ── PendantFill ──────────────────────────────────────────────
// Put this last in a flex column that's stretched to a taller neighbour
// (e.g. one of two grid columns, or a full-height side panel). It takes the
// spare height and, when there is at least `min` px of it, hangs a pendant
// there, stretched to fill (up to `max` px tall). It adds no height of its
// own (the pendant is absolutely placed) unless `reserve` is set, which
// keeps `min` px open so the pendant always shows at its base size.
//   top / bottom — px kept clear above and below the pendant
//   scale        — enlarges the chain (wide panels)
export function PendantFill({ variant = 'close', min = 180, max = 320, top = 14, bottom = 14, scale = 1, reserve = false, ground }) {
  const ref = useRef(null);
  const [h, setH] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => setH(Math.floor(entry.contentRect.height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const len = Math.min(max, h - top - bottom) / scale; // drawing units
  return (
    <div ref={ref} aria-hidden="true" style={{ flex: reserve ? '1 0 auto' : '1 1 0', minHeight: reserve ? `${min}px` : 0, position: 'relative' }}>
      {h >= min && len >= 110 && (
        <div style={{ position: 'absolute', top: `${top}px`, left: '50%', transform: 'translateX(-50%)' }}>
          <Pendant variant={variant} height={len} scale={scale} ground={ground} />
        </div>
      )}
    </div>
  );
}

// ── SessionIntro ─────────────────────────────────────────────
// Opening bookend for a flashcard or quiz session. Starts the session on
// its own after `delay` ms (O2: 3 s, up from 1.6), or at once on a tap,
// Enter or Space, so it never costs an extra tap; a hint under the button
// says so. Escape calls onExit when one is given.
//   kind 'medallion' — open pendant into a medallion (flashcards)
//   kind 'frame'     — corner frame with a 시작 rail (quizzes)
export function SessionIntro({ kind = 'medallion', korean, title, detail, sub, onBegin, onExit, delay = 3000 }) {
  const { C, S } = useAppTheme();
  const o = useOrnament();
  const doneRef  = useRef(false);
  const beginRef = useRef(onBegin);
  useEffect(() => { beginRef.current = onBegin; });

  const begin = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    beginRef.current?.();
  };

  useEffect(() => {
    const t = setTimeout(begin, delay);
    return () => clearTimeout(t);
  }, [delay]);

  useKeyShortcuts({
    'Enter':  begin,
    ' ':      begin,
    ...(onExit ? { 'Escape': () => { doneRef.current = true; onExit(); } } : {}),
  }, true);

  return (
    <div
      onClick={begin}
      className="fade-up"
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '420px', cursor: 'pointer', userSelect: 'none', WebkitUserSelect: 'none', ...(isMobile && { paddingTop: '24px' }) }}
    >
      {kind === 'medallion' ? (
        <>
          <Pendant variant="open" />
          <Medallion style={{ marginTop: '-1px' }}>
            <div style={{ fontFamily: SH.fk, fontSize: '36px', fontWeight: 700, color: C.accent, lineHeight: 1 }}>{korean}</div>
            <div style={{ fontFamily: SH.fd, fontSize: '18px', color: C.text }}>{title}</div>
            <MiniRule />
            {detail && <div style={{ fontFamily: SH.fm, fontSize: '13px', color: C.text }}>{detail}</div>}
            {sub && <div style={{ fontStyle: 'italic', fontSize: '12.5px', color: C.textS }}>{sub}</div>}
          </Medallion>
        </>
      ) : (
        <CornerFrame style={{ width: '100%', maxWidth: '380px' }}>
          <div style={{ fontFamily: SH.fp, fontSize: '12.5px', fontWeight: 600, letterSpacing: '0.18em', textTransform: 'uppercase', color: C.textS, textAlign: 'center' }}>{title}</div>
          <div style={{ fontFamily: SH.fk, fontSize: '34px', fontWeight: 700, color: C.accent, lineHeight: 1.15, textAlign: 'center' }}>{korean}</div>
          <Rail label="시작" width={300} ground={o.plate} style={{ margin: '6px auto 4px' }} />
          {detail && <div style={{ fontFamily: SH.fm, fontSize: '13px', color: C.text, textAlign: 'center' }}>{detail}</div>}
          {sub && <div style={{ fontStyle: 'italic', fontSize: '12.5px', color: C.textS, textAlign: 'center' }}>{sub}</div>}
        </CornerFrame>
      )}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); begin(); }}
        style={{ ...S.btnGhost, marginTop: '28px' }}
      >
        Begin
      </button>
      <div style={{ marginTop: '10px', fontFamily: SH.fm, fontSize: '11px', color: C.textS }}>
        {isMobile ? 'Tap to start now.' : 'Click or press Enter to start now.'}
      </div>
    </div>
  );
}
