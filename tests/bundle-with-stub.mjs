// tests/bundle-with-stub.mjs
// Shared by the tests whose source file imports Firebase. Bundles one source
// file with esbuild or rolldown (whichever node_modules has), swapping every
// Firebase import for the stand-in the test supplies, and imports the result.
// No config, no network. Not a test itself (the runner only picks up
// *-golden.mjs).
//
//   const { mod, cleanup } = await bundleWithStub('src/utils/srsEngine.js', STUB);
//   ... use mod.runDailyPipeline ...
//   await cleanup();
//
// A third argument swaps other packages too, by exact import name:
//   bundleWithStub('src/hooks/useFirestore.js', STUB, { react: REACT_STAND_IN })

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const isFirebase = (id) => /firebase/.test(id);
// Vite's import.meta.env, as a normal (non-demo) build sees it, for modules
// that read it (demo/demoConfig.js).
const ENV = { 'import.meta.env': JSON.stringify({ MODE: 'test', DEV: false, PROD: true }) };

export async function bundleWithStub(entryFromRoot, stubSource, others = {}) {
  const isStubbed = (id) => isFirebase(id) || Object.hasOwn(others, id);
  const sourceFor = (id) => (Object.hasOwn(others, id) ? others[id] : stubSource);
  const entry   = join(root, entryFromRoot);
  const dir     = await mkdtemp(join(tmpdir(), 'avi-golden-'));
  const outfile = join(dir, basename(entryFromRoot).replace(/\.jsx?$/, '.bundle.mjs'));
  let bundled = false;
  try {
    const esbuild = await import('esbuild');
    await esbuild.build({
      entryPoints: [entry], bundle: true, format: 'esm', outfile, logLevel: 'silent', define: ENV,
      plugins: [{ name: 'stub', setup(build) {
        build.onResolve({ filter: /.*/ }, a => (isStubbed(a.path) ? { path: a.path, namespace: 'stub' } : undefined));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, a => ({ contents: sourceFor(a.path) }));
      } }],
    });
    bundled = true;
  } catch { /* fall through to rolldown */ }
  if (!bundled) {
    try {
      const { rolldown } = await import('rolldown');
      const build = await rolldown({
        input: entry, logLevel: 'silent', transform: { define: ENV },
        plugins: [{ name: 'stub',
          resolveId(source) { return isStubbed(source) ? `\0stub:${source}` : null; },
          load(id) { return id.startsWith('\0stub:') ? sourceFor(id.slice(6)) : null; } }],
      });
      await build.write({ format: 'esm', file: outfile });
      await build.close();
    } catch (e) {
      console.error('Could not load esbuild or rolldown from node_modules. Run `npm install` first.');
      console.error(String(e));
      process.exit(1);
    }
  }
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
