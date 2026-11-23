// src/theme/themeTokens.js
// The colour tokens buildColors() returns, grouped and described for the
// Appearance tab in Settings, plus the contrast check it runs on a theme.
// Pure module: no React, no imports.

// [group, [[token, what it colours]]], in the order the tab lists them.
export const TOKEN_GROUPS = [
  ['Backgrounds', [['bg', 'Page background'], ['surface', 'Header, sidebar, panels'], ['raised', 'Cards, inputs, menus']]],
  ['Borders', [['border', 'Dividers, card edges'], ['borderB', 'Strong edges, hover']]],
  ['Text', [['text', 'Main text'], ['textS', 'Secondary text'], ['textM', 'Hints, labels, dates'], ['accentText', 'Text on accent buttons']]],
  ['Accents', [['accent', 'Buttons, links, active items'], ['accentSoft', 'Selected and hover tints'], ['accent2', 'Second accent'], ['accent2Soft', 'Second accent tint'], ['logoText', 'AutoVocaIndex wordmark']]],
  ['Status', [['danger', 'Errors, overdue'], ['success', 'Done, synced'], ['warning', 'Warnings, due soon']]],
  ['Category tags', [['tLa', '한국어'], ['tL', 'Life'], ['tH', 'Health'], ['tF', 'Finance']]],
];

export const TOKENS = TOKEN_GROUPS.flatMap(([, list]) => list.map(([k]) => k));
export const BACKGROUND_TOKENS = ['bg', 'surface', 'raised'];

// A screen share in percent, as the coverage rows show it:
// 55% · 1.2% · 0.32% · <0.05%
export function formatShare(x) {
  if (!(x > 0)) return '0%';
  if (x >= 10) return `${Math.round(x)}%`;
  if (x >= 1) return `${x.toFixed(1)}%`;
  if (x >= 0.05) return `${x.toFixed(2)}%`;
  return '<0.05%';
}

// Tokens a theme may leave out, and what the code uses instead.
const FALLBACKS = { accentText: '#ffffff' };

// { value, fallback } — fallback is true when the theme leaves the token
// out and the code's own default is used instead.
export function resolveToken(C, key) {
  if (C && C[key] !== undefined) return { value: C[key], fallback: false };
  return { value: FALLBACKS[key] ?? 'transparent', fallback: true };
}

// '#rgb', '#rrggbb' or 'rgb(a)(...)' → [r, g, b, a]; null if unreadable.
export function parseColour(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (/^#[0-9a-f]{3}$/i.test(t)) return [1, 2, 3].map(i => parseInt(t[i] + t[i], 16)).concat(1);
  if (/^#[0-9a-f]{6}$/i.test(t)) return [1, 3, 5].map(i => parseInt(t.slice(i, i + 2), 16)).concat(1);
  const m = t.match(/^rgba?\(([^)]+)\)$/i);
  if (!m) return null;
  const n = m[1].split(',').map(x => parseFloat(x));
  if (n.length < 3 || n.slice(0, 3).some(Number.isNaN)) return null;
  return [n[0], n[1], n[2], Number.isNaN(n[3]) || n[3] === undefined ? 1 : n[3]];
}

// A colour laid over an opaque base, as the [r, g, b] the eye sees.
function over(colour, base) {
  const c = parseColour(colour), b = parseColour(base) || [0, 0, 0, 1];
  if (!c) return b.slice(0, 3);
  return [0, 1, 2].map(i => c[i] * c[3] + b[i] * (1 - c[3]));
}

const channel = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

// WCAG contrast ratio of fg on bg. A translucent bg is first laid over
// `base` (the page background), a translucent fg over the result.
export function contrastRatio(fg, bg, base = '#000000') {
  const back = over(bg, base);
  const front = over(fg, `rgb(${back.join(',')})`);
  const a = luminance(front), b = luminance(back);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// The pairs the tab checks: [fg, bg, ratio needed, what the pair is].
// Body text needs 4.5:1; icons, bold labels and large text need 3:1.
export const CONTRAST_PAIRS = [
  ['text', 'bg', 4.5, 'Main text on the page'],
  ['text', 'surface', 4.5, 'Main text in panels'],
  ['textS', 'surface', 4.5, 'Secondary text'],
  ['textM', 'surface', 4.5, 'Hints and labels'],
  ['textM', 'raised', 4.5, 'Hints on cards'],
  ['accentText', 'accent', 4.5, 'Button labels'],
  ['accent', 'surface', 3, 'Links, icons, active items'],
  ['accent2', 'surface', 3, 'Second accent marks'],
  ['danger', 'surface', 3, 'Overdue, errors'],
  ['warning', 'surface', 3, 'Warnings'],
  ['success', 'surface', 3, 'Done, synced'],
  ['tLa', 'surface', 3, '한국어 tag'],
  ['tF', 'surface', 3, 'Finance tag'],
];

// level: 'pass' | 'large' (only large or bold text) | 'low'.
export function contrastVerdict(ratio, need) {
  if (ratio >= 4.5) return { level: 'pass', label: need > 3 ? 'Passes for body text' : 'Passes' };
  if (ratio >= 3) return need > 3
    ? { level: 'large', label: 'Large or bold text only' }
    : { level: 'pass', label: 'Passes for icons and labels' };
  return { level: 'low', label: 'Hard to read' };
}

// Every pair for one theme's colours, with its ratio and verdict.
export function checkContrast(C) {
  return CONTRAST_PAIRS.map(([fg, bg, need, use]) => {
    const f = resolveToken(C, fg).value, b = resolveToken(C, bg).value;
    const ratio = contrastRatio(f, b, C?.bg);
    return { fg, bg, need, use, fgValue: f, bgValue: b, ratio, ...contrastVerdict(ratio, need) };
  });
}
