// tests/run-goldens.mjs
// Runs every golden test in tests/ and prints one summary line each.
// Run from the repo root:   npm test      (or: node tests/run-goldens.mjs)
// Exits 1 if any test fails. Some of the tests bundle a source file first and
// need esbuild or rolldown from node_modules, so run `npm install` once.

import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const files = (await readdir(here)).filter(f => f.endsWith('-golden.mjs')).sort();

let failed = 0;
for (const f of files) {
  // Asia/Seoul, so the date-dependent cases match the app's own time zone.
  const r = spawnSync(process.execPath, [join(here, f)], {
    cwd: root, encoding: 'utf8', env: { ...process.env, TZ: 'Asia/Seoul' },
  });
  const lines = ((r.stdout || '') + (r.stderr || '')).trim().split('\n');
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${f.padEnd(26)} ${lines[lines.length - 1]}`);
  if (!ok) console.log(lines.filter(l => l.startsWith('FAIL')).slice(0, 10).map(l => '      ' + l).join('\n'));
}
console.log(`\n${files.length - failed}/${files.length} tests pass`);
process.exit(failed ? 1 : 0);
