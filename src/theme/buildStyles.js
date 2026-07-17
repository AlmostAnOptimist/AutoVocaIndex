export const SH = {
  fd: "'Limelight', Georgia, cursive",
  fb: "'Bitter', Georgia, serif",
  fm: "'DM Mono', monospace",
  fk: "'Hahmlet', serif", // [LANG-SPECIFIC] Korean text face (docs/08)
  fp: "'Poiret One', sans-serif",
};

// ── Frame builders (Phase B-1) ─────────────────────────────────
// Corner treatments are 9-slice SVG border-images generated per theme.
// border-image is pure paint: it never clips children, never creates a
// containing block for fixed-position descendants (the filter/clip-path
// hazard — same family as the .fade-up gotcha), and it stays put on
// scrolling containers. Corner slices map 1:1 onto border-image-width px,
// which keeps 1px lines truly 1px.
// Elements wearing a frame should set backgroundClip: 'padding-box' so any
// background (including hover-set ones) can't poke square corners past the
// beveled lines.

// Octagon path: straight edges at `inset`; 45° corners cut along x+y=diagSum.
function octPath(size, inset, diagSum) {
  const i = inset, d = diagSum, S = size;
  const p = [
    [d - i, i], [S - (d - i), i], [S - i, d - i], [S - i, S - (d - i)],
    [S - (d - i), S - i], [d - i, S - i], [i, S - (d - i)], [i, d - i],
  ];
  return 'M' + p.map(([x, y]) => `${+x.toFixed(2)} ${+y.toFixed(2)}`).join(' L') + ' Z';
}

// Double-line beveled frame (bevel ≈ 4px, two 1px lines, 1px gap,
// transparent interior). Used by the ex-metallic emphasis buttons.
// Pair with: border '7px solid transparent', borderImageSlice 8,
// borderImageWidth '8px'.
export function frameDoubleBevel(line) {
  const S = 40, R2 = Math.SQRT2;
  const d0 = 5; // outer diagonal x+y — raise to deepen the bevel
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${S}' height='${S}'>` +
    `<path d='${octPath(S, 0.5, d0)}' fill='none' stroke='${line}' stroke-width='1'/>` +
    `<path d='${octPath(S, 2.5, d0 + 2 * R2)}' fill='none' stroke='${line}' stroke-width='1'/>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

// Single-line beveled frame, transparent interior. For state-colored chips
// and pills whose background varies at the call site: the element keeps its
// own background (clipped to padding-box so it can't poke past the bevel),
// leaving a deliberate thin inset ring — the same breathing room the
// double-bevel buttons have. Pair with: border '4-5px solid transparent',
// borderImageSlice 6, borderImageWidth '5-6px'.
export function frameBevel(line) {
  const S = 40, d0 = 5;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${S}' height='${S}'>` +
    `<path d='${octPath(S, 0.5, d0)}' fill='none' stroke='${line}' stroke-width='1'/>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

// Single-line beveled frame with a solid interior. For containers whose
// background is fixed at the token level (cards, toasts, confirm boxes).
// Pair with: borderImageSlice '6 fill', borderImageWidth ~ border width + 1.
export function frameBevelFilled(line, fill, lineOpacity = 1) {
  const S = 40, d0 = 5;
  const p = octPath(S, 0.5, d0);
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${S}' height='${S}'>` +
    `<path d='${p}' fill='${fill}'/>` +
    `<path d='${p}' fill='none' stroke='${line}' stroke-opacity='${lineOpacity}' stroke-width='1'/>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

// The modal's square+rounded double frame (Phase B-1 Deploy 2): an outer
// square-cornered 1.5px line with the inner 1px rect's lines overshooting
// to cross it at the corners, joined by concave quarter-arcs — the
// certificate-plaque treatment from the reference. Interior fill rides the
// 'fill' slice keyword so the frame and background are one paint layer.
// Pair with: border '16px solid transparent', borderImageSlice '16 fill',
// borderImageWidth '16px'.
export function frameSquareRound(outer, inner, fill) {
  const S = 48;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${S}' height='${S}'>` +
    `<rect x='1.25' y='1.25' width='45.5' height='45.5' fill='${fill}'/>` +
    `<rect x='1.25' y='1.25' width='45.5' height='45.5' fill='none' stroke='${outer}' stroke-width='1.5'/>` +
    `<path d='M0.5 4.5 H47.5 M0.5 43.5 H47.5 M4.5 0.5 V47.5 M43.5 0.5 V47.5' fill='none' stroke='${inner}' stroke-width='1'/>` +
    `<path d='M13.5 4.5 A9 9 0 0 0 4.5 13.5 M43.5 13.5 A9 9 0 0 0 34.5 4.5 M4.5 34.5 A9 9 0 0 0 13.5 43.5 M34.5 43.5 A9 9 0 0 0 43.5 34.5' fill='none' stroke='${inner}' stroke-width='1'/>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

export function buildGlobalStyles(C) {
  const ct = C.bgText || C.text;
  return `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body, #root { height: 100%; }
  body { font-family: 'Bitter', Georgia, serif; background: ${C.bg}; color: ${ct}; font-size: 14px; line-height: 1.55; overflow: hidden; }
  ::-webkit-scrollbar { width: 4px; height: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 4px; }
  button { cursor: pointer; font-family: inherit; background: none; border: none; color: inherit; }
  input, textarea, select { font-family: inherit; }
  option { background: ${C.raised}; color: ${C.text}; }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes slideUp { from { transform: translateY(40px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  @keyframes toastIn { from { transform: translateX(-50%) translateY(20px); opacity: 0; } to { transform: translateX(-50%) translateY(0); opacity: 1; } }
  @keyframes progressGlow { 0% { filter: brightness(1); } 40% { filter: brightness(1.6) drop-shadow(0 0 6px ${C.accent}bb); } 100% { filter: brightness(1); } }
  @keyframes particlePop { 0% { opacity: 1; transform: translate(0,0) scale(1); } 100% { opacity: 0; transform: translate(var(--dx), var(--dy)) scale(0); } }
  @keyframes gradePulse { 0% { transform: scale(1); box-shadow: 0 0 0 0 currentColor; } 35% { transform: scale(1.1); box-shadow: 0 0 12px 2px currentColor; } 100% { transform: scale(1); box-shadow: 0 0 0 0 currentColor; } }
  .fade-up { animation: fadeUp 0.2s ease both; }
  .slide-up { animation: slideUp 0.28s cubic-bezier(0.34, 1.2, 0.64, 1) both; }
  .grade-pulse { animation: gradePulse 0.22s ease; }
  .task-row:last-child { border-bottom: none !important; }
  .task-row:hover { background: ${C.bg} !important; }
  .task-row:hover .edit-pencil { opacity: 0.5 !important; }
  .edit-pencil:hover { opacity: 1 !important; }
  .nav-hover:hover { background: rgba(0,0,0,0.07) !important; }
  .btn-ghost:hover { background: ${C.raised} !important; color: ${C.text} !important; }
  .btn-primary:hover { filter: brightness(1.1); }
  .quick-add-btn:hover { background: ${C.raised} !important; color: ${C.text} !important; border-color: ${C.borderB} !important; }
  @keyframes indexDown { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: translateY(0); } }
  .avi-index-panel { animation: indexDown 0.18s ease both; }
  @keyframes avi-spin { to { transform: rotate(360deg); } }
  .icon-spin { animation: avi-spin 0.8s linear infinite; }
  @media (max-width: 700px) {
    .sidebar { display: none !important; }
    .mobile-nav { display: flex !important; }
    .content-pad { padding: 16px !important; padding-bottom: 80px !important; }
    .today-grid { grid-template-columns: 1fr !important; }
    .stats-col { display: flex !important; flex-direction: column !important; gap: 14px !important; }
    .quiz-session { padding-bottom: 72px !important; }
    .quiz-macaw img { max-width: 100% !important; height: auto !important; }
    .review-card { overflow-y: auto !important; max-height: calc(100vh - 200px) !important; }
    .topbar-desktop { display: none !important; }
    .topbar { height: 52px !important; padding: 0 14px !important; }
    input, textarea, select { font-size: 16px !important; }
  }
`;
}

export function buildStyles(C) {
  const ct  = C.bgText  || C.text;
  const cts = C.bgTextS || C.textS;
  const ctm = C.bgTextM || C.textM;
  return {
    root: { display: 'flex', height: '100vh', background: C.bg, overflow: 'hidden' },
    sidebar: { width: '220px', minWidth: '220px', height: '100vh', background: C.surface, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0 },
    sidebarScroll: { flex: 1, overflowY: 'auto', overflowX: 'hidden' },
    main: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
    logoWrap: { padding: '0 18px', height: '74px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0, background: C.surface, position: 'sticky', top: 0, zIndex: 10 },
    logoText: { fontFamily: SH.fd, fontSize: '22px', fontWeight: 600, color: C.logoText, letterSpacing: '-0.5px', lineHeight: 1 },
    navSection: { padding: '14px 10px 4px' },
    navLabel: { fontSize: '10px', fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase', color: C.textM, padding: '0 8px', marginBottom: '4px', display: 'block' },
    navItem: (a) => ({ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 10px', borderRadius: '6px', cursor: 'pointer', fontSize: '13.5px', fontWeight: a ? 500 : 400, color: a ? (C.navTextActive || C.accent) : (C.navText || C.textS), background: a ? C.accentSoft : 'transparent', transition: 'all 0.15s', userSelect: 'none' }),
    navBadge: (d) => ({ marginLeft: 'auto', background: d ? C.danger : C.accent, color: d ? '#fff' : (C.accentText || '#fff'), fontSize: '10px', fontWeight: 600, padding: '1px 6px', borderRadius: '10px', minWidth: '18px', textAlign: 'center' }),
    phaseBadge: { fontSize: '9px', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '2px 6px', borderRadius: '10px', border: `1px solid ${C.border}`, color: C.textM, marginLeft: 'auto' },
    sidebarBottom: { padding: '12px 10px', borderTop: `1px solid ${C.border}`, background: C.surface, flexShrink: 0 },
    topbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px 0 28px', height: '74px', borderBottom: `1px solid ${C.border}`, background: C.surface, flexShrink: 0, gap: '20px', position: 'relative', zIndex: 10 },
    topbarDate: { fontFamily: SH.fd, fontSize: '14px', color: C.textM, letterSpacing: '0.01em' },
    topbarActions: { display: 'flex', alignItems: 'center', gap: '8px', marginLeft: 'auto' },
    btnPrimary: { display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '7px 14px', borderRadius: '3px', fontSize: '13px', fontWeight: 500, background: C.accent, color: C.accentText || '#fff', transition: 'all 0.15s', border: 'none', cursor: 'pointer' },
    // Ex-"metallic" emphasis button — now the double-bevel frame in theme
    // accent (Phase B-1). Composes over btnPrimary at ~38 call sites; the
    // border-image approach means none of them needed edits.
    btnMetallic: { background: 'transparent', backgroundClip: 'padding-box', border: '7px solid transparent', borderRadius: 0, borderImageSource: frameDoubleBevel(C.accent), borderImageSlice: 8, borderImageWidth: '8px', borderImageRepeat: 'stretch', color: C.accent, fontWeight: 600, padding: '2px 8px' },
    btnGhost: { display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 10px', fontSize: '13px', fontWeight: 400, color: cts, border: '5px solid transparent', borderRadius: 0, borderImageSource: frameBevel(C.border), borderImageSlice: 6, borderImageWidth: '6px', borderImageRepeat: 'stretch', transition: 'all 0.15s', background: 'transparent', backgroundClip: 'padding-box', cursor: 'pointer' },
    btnDanger: { display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '8px 18px', borderRadius: '3px', fontSize: '13px', fontWeight: 500, background: C.danger, color: '#fff', border: 'none', cursor: 'pointer', transition: 'all 0.15s' },
    contentArea: { flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '28px' },
    card: { background: 'transparent', backgroundClip: 'padding-box', border: '5px solid transparent', borderRadius: 0, borderImageSource: frameBevelFilled(C.border, C.cardBg || C.raised), borderImageSlice: '6 fill', borderImageWidth: '6px', borderImageRepeat: 'stretch', overflow: 'hidden' },
    statCard: { background: 'transparent', backgroundClip: 'padding-box', border: '5px solid transparent', borderRadius: 0, borderImageSource: frameBevelFilled(C.border, C.cardBg || C.raised), borderImageSlice: '6 fill', borderImageWidth: '6px', borderImageRepeat: 'stretch', padding: '12px' },
    statCardTitle: { fontSize: '11px', fontWeight: 500, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.textM, marginBottom: '12px' },
    taskItem: (c) => ({ display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '11px 16px', borderBottom: `1px solid ${C.border}`, transition: 'background 0.15s', cursor: 'default', opacity: c ? 0.55 : 1 }),
taskCheck: (c, p) => { const pc = p === 'high' ? C.danger : p === 'med' ? C.warning : C.textM; return { width: '18px', height: '18px', borderRadius: '50%', flexShrink: 0, marginTop: '1px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: c ? 'none' : `2.5px solid ${pc}`, opacity: (!c && p === 'low') ? 0.4 : 1, background: c ? C.accent : 'transparent', transition: 'all 0.15s', cursor: 'pointer' }; },
    taskTitle: (c) => ({ fontFamily: SH.fp, fontSize: '13.5px', color: c ? C.textM : (C.bgText || C.text), textDecoration: c ? 'line-through' : 'none', marginBottom: '3px', wordBreak: 'break-word' }),
    taskMeta: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
    taskTag: (cat) => { const m = { life: C.tL, lang: C.tLa, health: C.tH, finance: C.tF }; const col = m[cat] || C.textM; return { fontSize: '10px', fontWeight: 500, padding: '2px 7px', borderRadius: '3px', letterSpacing: '0.04em', textTransform: 'uppercase', color: col, background: `${col}22` }; },
    taskTime: (ov) => ({ fontSize: '11px', color: ov ? C.danger : C.textM }),
    recurBadge: { fontSize: '10px', color: C.textM },
    sectionHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' },
    sectionTitle: { fontFamily: SH.fd, fontSize: '15px', fontWeight: 400, color: cts, display: 'flex', alignItems: 'center', gap: '8px' },
    sectionAccent: (col) => ({ width: '3px', height: '14px', background: col, borderRadius: '2px', flexShrink: 0 }),
    greetH1: { fontFamily: SH.fd, fontSize: '30px', color: ct, lineHeight: 1.2, marginBottom: '4px' },
    greetSub: { color: ctm, fontSize: '13px', marginBottom: '28px' },
    catPills: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '20px' },
    catPill: (a) => ({ padding: '2px 9px', fontSize: '12px', fontWeight: 500, border: '4px solid transparent', borderRadius: 0, borderImageSource: frameBevel(a ? (C.accent2 || C.accent) : C.border), borderImageSlice: 6, borderImageWidth: '5px', borderImageRepeat: 'stretch', background: a ? (C.accent2Soft || C.accentSoft) : 'transparent', backgroundClip: 'padding-box', color: a ? (C.accent2 || C.accent) : cts, cursor: 'pointer', transition: 'color 0.15s, background 0.15s' }),
    todayGrid: { display: 'grid', gridTemplateColumns: '1fr 300px', gap: '20px', alignItems: 'start' },
    statsCol: { display: 'flex', flexDirection: 'column', gap: '14px' },
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(2px)', padding: '24px' },
    // Square+rounded double frame (B-1 Deploy 2). Interior fill comes from
    // the border-image 'fill' slice; dvh keeps the frame inside the visible
    // viewport on iOS (the 90vh top/bottom clipping fix).
    modal: { background: 'transparent', backgroundClip: 'padding-box', border: '16px solid transparent', borderRadius: 0, borderImageSource: frameSquareRound(C.borderB, C.border, C.cardBg || C.surface), borderImageSlice: '16 fill', borderImageWidth: '16px', borderImageRepeat: 'stretch', padding: '10px', width: '100%', maxWidth: '560px', maxHeight: 'min(90vh, calc(100dvh - 32px))', overflowY: 'auto' },
        modalTitle: { fontFamily: SH.fd, fontSize: '18px', fontWeight: 400, color: C.text },
    modalHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' },
    formGroup: { marginBottom: '16px' },
    formLabel: { display: 'block', fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textM, marginBottom: '6px' },
    formInput: { width: '100%', background: C.bg, border: `1px solid ${C.border}`, borderRadius: '2px', padding: '9px 12px', fontSize: '13.5px', color: C.bgText || C.text, outline: 'none', transition: 'border 0.15s' },
    formRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' },
    formActions: { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '20px', paddingTop: '16px', borderTop: `1px solid ${C.border}` },
    formSelect: { width: '100%', background: C.bg, border: `1px solid ${C.border}`, borderRadius: '2px', padding: '9px 12px', fontSize: '13.5px', color: C.bgText || C.text, outline: 'none', cursor: 'pointer', appearance: 'none', backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center' },
    recurChips: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
    recurChip: (a) => ({ fontFamily: SH.fp, padding: '2px 8px', fontSize: '11.5px', fontWeight: 500, border: '4px solid transparent', borderRadius: 0, borderImageSource: frameBevel(a ? C.accent : C.border), borderImageSlice: 6, borderImageWidth: '5px', borderImageRepeat: 'stretch', background: a ? C.accentSoft : 'transparent', backgroundClip: 'padding-box', color: a ? C.accent : C.textS, cursor: 'pointer', transition: 'color 0.15s, background 0.15s' }),
    dayChip: (a, dis) => ({ fontFamily: SH.fp, padding: '1px 6px', fontSize: '11px', fontWeight: 500, border: '4px solid transparent', borderRadius: 0, borderImageSource: frameBevel(a ? C.accent : C.border), borderImageSlice: 6, borderImageWidth: '5px', borderImageRepeat: 'stretch', background: a ? C.accentSoft : 'transparent', backgroundClip: 'padding-box', color: a ? C.accent : C.textS, cursor: dis ? 'default' : 'pointer', transition: 'color 0.15s, background 0.15s', minWidth: '38px', textAlign: 'center', opacity: dis ? 0.4 : 1 }),
    infoBox: { background: 'transparent', backgroundClip: 'padding-box', border: '5px solid transparent', borderRadius: 0, borderImageSource: frameBevelFilled(C.accent, C.accentSoft, 0.27), borderImageSlice: '6 fill', borderImageWidth: '6px', borderImageRepeat: 'stretch', padding: '5px 9px', fontSize: '12px', color: C.textS, marginTop: '8px', lineHeight: 1.5 },
    themePanel: (o) => ({ position: 'fixed', top: 0, right: o ? 0 : '-280px', width: '272px', height: '100vh', background: C.surface, borderLeft: `1px solid ${C.border}`, zIndex: 200, padding: '24px', overflowY: 'auto', transition: 'right 0.3s cubic-bezier(0.4,0,0.2,1)' }),
    themePanelTitle: { fontFamily: SH.fd, fontSize: '17px', fontWeight: 400, marginBottom: '20px', color: C.text },
    themeOption: (a) => ({ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px', borderRadius: '12px', cursor: 'pointer', marginBottom: '8px', border: `1.5px solid ${a ? C.accent : 'transparent'}`, background: a ? C.accentSoft : 'transparent', transition: 'all 0.15s' }),
    agendaTabs: { display: 'flex', gap: '4px', marginBottom: '24px', background: 'transparent', backgroundClip: 'padding-box', border: '5px solid transparent', borderRadius: 0, borderImageSource: frameBevelFilled(C.border, C.cardBg || C.surface), borderImageSlice: '6 fill', borderImageWidth: '6px', borderImageRepeat: 'stretch', width: 'fit-content' },
    agendaTab: (a) => ({ padding: '6px 14px', borderRadius: '4px', fontSize: '12.5px', fontWeight: 500, color: a ? C.text : C.textS, cursor: 'pointer', transition: 'all 0.15s', background: a ? C.raised : 'transparent', boxShadow: a ? '0 1px 4px rgba(0,0,0,0.2)' : 'none' }),
    dayGroup: { marginBottom: '24px' },
    dayHeader: { fontSize: '11px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: ctm, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '10px' },
    dayHeaderLine: { flex: 1, height: '1px', background: C.border },
    placeholder: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '400px', textAlign: 'center', gap: '14px' },
    placeholderH: { fontFamily: SH.fd, fontSize: '22px', color: cts, opacity: 0.6 },
    placeholderP: { fontSize: '13px', maxWidth: '280px', lineHeight: 1.6, color: ctm },
    emptyState: { textAlign: 'center', padding: '40px 20px', color: C.textM, fontSize: '13px' },
    toast: { position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)', background: 'transparent', backgroundClip: 'padding-box', border: '6px solid transparent', borderRadius: 0, borderImageSource: frameBevelFilled(C.borderB, C.raised), borderImageSlice: '6 fill', borderImageWidth: '6px', borderImageRepeat: 'stretch', padding: '5px 13px', fontSize: '13px', color: C.text, zIndex: 300, animation: 'toastIn 0.3s ease both', whiteSpace: 'nowrap', pointerEvents: 'none' },
    mobileNav: { display: 'none', position: 'fixed', bottom: 0, left: 0, right: 0, height: '56px', background: C.surface, borderTop: `1px solid ${C.border}`, zIndex: 50 },
    mobileNavItem: (a) => ({ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px', padding: '8px 4px', fontSize: '10px', color: a ? C.accent : C.textM, cursor: 'pointer', transition: 'color 0.15s' }),
    quickAddBtn: () => ({ display: 'inline-flex', alignItems: 'center', gap: '7px', padding: '4px 9px', fontSize: '12.5px', fontWeight: 500, background: 'transparent', backgroundClip: 'padding-box', border: '5px solid transparent', borderRadius: 0, borderImageSource: frameBevel(C.borderB || C.border), borderImageSlice: 6, borderImageWidth: '6px', borderImageRepeat: 'stretch', color: C.textS, transition: 'color 0.15s', cursor: 'pointer', whiteSpace: 'nowrap' }),
    quickAddDot: (col) => ({ width: '7px', height: '7px', borderRadius: '50%', background: col, flexShrink: 0 }),
    confirmOverlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' },
    confirmBox: { background: 'transparent', backgroundClip: 'padding-box', border: '8px solid transparent', borderRadius: 0, borderImageSource: frameBevelFilled(C.borderB, C.cardBg || C.surface), borderImageSlice: '6 fill', borderImageWidth: '8px', borderImageRepeat: 'stretch', padding: '16px', maxWidth: '320px', width: '90%', textAlign: 'center' },
    confirmTitle: { fontFamily: SH.fd, fontSize: '17px', fontWeight: 400, color: C.text, marginBottom: '8px' },
    confirmMsg: { fontSize: '13px', color: C.textM, marginBottom: '20px', lineHeight: 1.6 },
    confirmActions: { display: 'flex', gap: '8px', justifyContent: 'center' },
    syncDot: (status) => ({ width: '7px', height: '7px', borderRadius: '50%', background: status === 'ok' ? C.success : status === 'error' ? C.danger : status === 'syncing' ? C.warning : C.textM, transition: 'background 0.3s', flexShrink: 0 }),
    syncLabel: { fontSize: '10px', color: C.textM, fontFamily: SH.fm },
  };
}