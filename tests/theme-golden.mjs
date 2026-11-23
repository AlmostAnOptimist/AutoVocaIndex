// tests/theme-golden.mjs
// Golden test for the theme data behind Settings > Appearance: every theme
// in the picker builds a full palette, retired ids map to their successor,
// the coverage data covers every token, and the contrast check's maths
// matches the WCAG formula on known pairs.
//
// Run from the repo root:   node tests/theme-golden.mjs   (or: npm test)
// Plain Node; the modules have no imports. Exits 1 on any failure.

const { buildColors } = await import('../src/theme/buildColors.js');
const { THEME_DEFS, RETIRED_THEMES, themeIdOf } = await import('../src/constants.js');
const T = await import('../src/theme/themeTokens.js');
const { THEME_COVERAGE } = await import('../src/theme/themeCoverage.js');

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`);
}
const r1 = (x) => Math.round(x * 10) / 10;

// ── Themes ────────────────────────────────────────────────────
const ids = THEME_DEFS.map(t => t.id);
check('picker: eight themes, Shiner in place of Blossom Mist',
  ids, ['ember', 'clay', 'baroque', 'koi', 'feather', 'hanok', 'bauhaus', 'shiner']);
check('picker: ids are unique', new Set(ids).size, ids.length);

// Every theme but Ember has its own branch; a missing branch would fall
// through to Ember's colours.
const ember = buildColors('ember');
check('themes: each one builds its own palette, not the Ember fallback',
  ids.filter(id => id !== 'ember' && buildColors(id).bg === ember.bg), []);
const optional = ['accentText'];
check('themes: every theme sets every required token',
  ids.flatMap(id => T.TOKENS.filter(k => !optional.includes(k) && buildColors(id)[k] === undefined).map(k => `${id}.${k}`)), []);
check('themes: every token value is a colour the check can read',
  ids.flatMap(id => T.TOKENS.filter(k => T.parseColour(T.resolveToken(buildColors(id), k).value) === null).map(k => `${id}.${k}`)), []);
check('themes: every picker swatch is a colour', THEME_DEFS.flatMap(t => t.sw.filter(c => !T.parseColour(c))), []);

// ── Shiner ────────────────────────────────────────────────────
const sh = buildColors('shiner');
check('shiner: keeps the sallow gold accent and wordmark', [sh.accent, sh.logoText], ['#CFC14A', '#CFC14A']);
check('shiner: dark ink on the gold accent', sh.accentText, '#22200A');
check('shiner: every contrast pair passes', T.checkContrast(sh).filter(r => r.level !== 'pass').map(r => `${r.fg}/${r.bg}`), []);

// ── Retired ids ───────────────────────────────────────────────
check('retired: Blossom Mist opens as Shiner', [RETIRED_THEMES.blossom, themeIdOf('blossom')], ['shiner', 'shiner']);
check('retired: current ids pass through unchanged', ids.map(themeIdOf), ids);
check('retired: no retired id is still in the picker', Object.keys(RETIRED_THEMES).filter(id => ids.includes(id)), []);

// ── Token model ───────────────────────────────────────────────
check('tokens: listed once each', new Set(T.TOKENS).size, T.TOKENS.length);
check('tokens: backgrounds are the first group', T.TOKEN_GROUPS[0][1].map(([k]) => k), T.BACKGROUND_TOKENS);
check('tokens: a theme without accentText falls back to white',
  [T.resolveToken(ember, 'accentText'), T.resolveToken(sh, 'accentText')],
  [{ value: '#ffffff', fallback: true }, { value: '#22200A', fallback: false }]);

// ── Coverage ──────────────────────────────────────────────────
for (const view of ['desktop', 'phone']) {
  const cov = THEME_COVERAGE[view];
  check(`coverage ${view}: a share for every token, and nothing else`, [T.TOKENS.filter(k => typeof cov[k] !== 'number'), Object.keys(cov).filter(k => !T.TOKENS.includes(k))], [[], []]);
  check(`coverage ${view}: shares add up to 100%`, r1(T.TOKENS.reduce((n, k) => n + cov[k], 0)), 100);
  check(`coverage ${view}: backgrounds cover most of the screen`, T.BACKGROUND_TOKENS.reduce((n, k) => n + cov[k], 0) > 90, true);
}

check('coverage: shares read as the rows show them', [55.7, 1.07, 0.317, 0.026, 0].map(T.formatShare), ['56%', '1.1%', '0.32%', '<0.05%', '0%']);

// ── Contrast maths ────────────────────────────────────────────
check('contrast: black on white is 21:1, a colour on itself 1:1',
  [r1(T.contrastRatio('#000000', '#ffffff')), r1(T.contrastRatio('#c97d3a', '#c97d3a'))], [21, 1]);
check('contrast: order of the pair does not matter',
  r1(T.contrastRatio('#7a6655', '#231e19')), r1(T.contrastRatio('#231e19', '#7a6655')));
check('contrast: known pairs (WCAG reference values)',
  [r1(T.contrastRatio('#767676', '#ffffff')), r1(T.contrastRatio('#ffffff', '#0000ff'))], [4.5, 8.6]);
check('contrast: a translucent colour is laid over the page first',
  [r1(T.contrastRatio('#ffffff', 'rgba(0,0,0,0)', '#ffffff')), r1(T.contrastRatio('rgba(0,0,0,0.5)', '#ffffff')) < 21], [1, true]);
check('contrast: #rgb shorthand reads like #rrggbb', T.parseColour('#fa0'), [255, 170, 0, 1]);
check('verdict: body text needs 4.5, marks need 3',
  [[5, 4.5], [4, 4.5], [4, 3], [2.9, 3]].map(([x, n]) => T.contrastVerdict(x, n).level), ['pass', 'large', 'pass', 'low']);
check('check: one row per pair, each with a ratio and a verdict',
  T.checkContrast(ember).every(r => r.ratio >= 1 && ['pass', 'large', 'low'].includes(r.level)) && T.checkContrast(ember).length === T.CONTRAST_PAIRS.length, true);
check('check: Ember muted text on panels is flagged (3.0:1)',
  (({ ratio, level }) => [r1(ratio), level])(T.checkContrast(ember).find(r => r.fg === 'textM' && r.bg === 'surface')), [3, 'large']);

console.log(`theme-golden: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
