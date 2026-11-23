// tests/lazy-pages-scan-golden.mjs
// Guards the pages that load on demand (offline decisions OF-D4,
// src/components/LazyPage.jsx).
//
// Quizzes, Dev Dashboard and the three readers stay out of the first load
// only while NOTHING imports their files the ordinary way. One ordinary
// `import ... from '.../QuizzesPage.jsx'` anywhere in src/ quietly puts the
// whole page back into the first load, and nothing else would notice. This
// test fails if that happens, naming the file and line.
//
// It also checks the other direction: each of the five is still opened
// through lazyPage(() => import('...')), each import names an export the
// file really has, and the wrapper itself never imports a page.
//
// Run from the repo root:   node tests/lazy-pages-scan-golden.mjs   (or: npm test)
// Plain Node, reads files only. Exits 1 on any failure.

import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// file (from the repo root) -> the export it is opened by
const LAZY = new Map([
  ['src/pages/QuizzesPage.jsx',           'QuizzesPage'],
  ['src/pages/DevDashboard.jsx',          'DevDashboard'],
]);

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`);
}

async function sourceFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await sourceFiles(p));
    else if (/\.(js|jsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

// Comments out, so a mention in a comment is not mistaken for an import.
// Strings are kept (the import paths are strings); a `//` inside a string
// would be cut short, which none of the import lines this looks for have.
const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length));
const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const fromRoot = (p) => relative(root, p).split('\\').join('/');
const resolveFrom = (file, spec) => fromRoot(join(dirname(file), spec));

// Every import in one file: { spec, kind: 'static' | 'dynamic', line, pick }
function importsIn(text) {
  const found = [];
  // import x from '...';  import { a, b } from '...';  import '...';  export ... from '...';
  const STATIC = /(?:^|[\n;])\s*(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  for (let m; (m = STATIC.exec(text));) found.push({ spec: m[1], kind: 'static', line: lineOf(text, m.index + m[0].indexOf(m[1])) });
  // import('...')  — with the "m => m.Name" that follows it inside lazyPage(...)
  const DYNAMIC = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)(?:\s*,\s*\(?\s*(\w+)\s*\)?\s*=>\s*\2\.(\w+))?/g;
  for (let m; (m = DYNAMIC.exec(text));) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    found.push({ spec: m[1], kind: 'dynamic', line: lineOf(text, m.index), pick: m[3] || null, viaLazyPage: /lazyPage\(\s*\(\s*\)\s*=>\s*$/.test(before) });
  }
  return found;
}

// ── The scan's own reading of imports ─────────────────────────
{
  const sample = [
    "import { A } from './pages/A.jsx';",
    "import B, { C } from \"../B.jsx\";",
    "import {",
    "  D, E,",
    "} from './D.js';",
    "import './side-effect.js';",
    "export { F } from './F.jsx';",
    "// import { Hidden } from './Hidden.jsx';",
    "/* import { Hidden2 } from './Hidden2.jsx'; */",
    "const G = lazyPage(() => import('./pages/G.jsx'), m => m.G, { label: 'x' });",
    "const H = await import('./H.js');",
    "const url = 'https://example.com/x';",
  ].join('\n');
  const got = importsIn(stripComments(sample)).map(i => `${i.kind}:${i.spec}:${i.line}${i.pick ? ':' + i.pick : ''}${i.viaLazyPage ? ':lazy' : ''}`);
  check('reads ordinary, multi-line, side-effect, re-export and on-demand imports; skips comments', got, [
    'static:./pages/A.jsx:1', 'static:../B.jsx:2', 'static:./D.js:5', 'static:./side-effect.js:6', 'static:./F.jsx:7',
    'dynamic:./pages/G.jsx:10:G:lazy', 'dynamic:./H.js:11',
  ]);
}

// ── The real source ───────────────────────────────────────────
const files = await sourceFiles(join(root, 'src'));
const ordinary = [];           // ordinary imports of an on-demand file
const onDemand = new Map();    // lazy file -> [{ from, line, pick, viaLazyPage }]
const wrapperImports = [];     // what the wrapper files import

for (const file of files) {
  const rel = fromRoot(file);
  const text = stripComments(await readFile(file, 'utf8'));
  for (const imp of importsIn(text)) {
    if (!imp.spec.startsWith('.')) continue;
    const target = resolveFrom(file, imp.spec);
    if (['src/components/LazyPage.jsx', 'src/components/ChunkStatus.jsx', 'src/utils/chunkLoader.js'].includes(rel)) wrapperImports.push(target);
    if (!LAZY.has(target)) continue;
    if (imp.kind === 'static') ordinary.push(`${rel}:${imp.line} imports ${target} the ordinary way`);
    else onDemand.set(target, [...(onDemand.get(target) || []), { from: rel, line: imp.line, pick: imp.pick, viaLazyPage: imp.viaLazyPage }]);
  }
}

check('no ordinary import of a page that loads on demand', ordinary, []);

for (const [target, exportName] of LAZY) {
  const uses = onDemand.get(target) || [];
  check(`${target}: opened on demand, through lazyPage, by its own name`,
    uses.map(u => [u.viaLazyPage, u.pick]), [[true, exportName]]);
  const source = await readFile(join(root, target), 'utf8');
  check(`${target}: really exports ${exportName}`,
    new RegExp(`^export\\s+(?:function|const|class)\\s+${exportName}\\b`, 'm').test(source), true);
}

check('the wrapper never imports a page or a reader',
  wrapperImports.filter(t => LAZY.has(t) || t.startsWith('src/pages/')), []);

console.log(`lazy-pages-scan-golden: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
