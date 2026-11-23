import { readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// One id per build. The app carries it (src/utils/versionCheck.js) and
// asset-manifest.json states it, so an open app can tell that a newer build
// has been deployed, and the service worker can tell which build a list of
// files belongs to (offline decisions OF-D3).
const BUILD_ID = Date.now().toString(36);

// Writes dist/asset-manifest.json after a build:
//   version   this build's id
//   precache  what the service worker saves on the device after a deploy:
//             every script, style and font the build produced, the Korean
//             analyser's engine and model, plus the icons and the web app
//             manifest
//   assets    every file under /assets/ (pictures included), so the worker
//             can remove saved copies the build no longer has
// Source maps are left out of both. public/sw.js reads this file.
function assetManifest() {
  let outDir = 'dist';
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
  ));
  return {
    name: 'avi-asset-manifest',
    apply: 'build',
    configResolved(config) { outDir = resolve(config.root, config.build.outDir); },
    closeBundle() {
      const files = walk(outDir)
        .map(f => '/' + relative(outDir, f).split('\\').join('/'))
        .filter(p => !p.endsWith('.map'))
        .sort();
      const assets = files.filter(p => p.startsWith('/assets/'));
      const precache = [
        // wasm and gmdl: the Korean analyser's engine and model (audit G3,
        // GS-D1), saved with the build so recognition works offline.
        ...assets.filter(p => /\.(js|css|woff2?|ttf|otf|wasm|gmdl)$/.test(p)),
        ...files.filter(p => /^\/(icons\/[^/]+\.png|[^/]+\.png|favicon\.(svg|ico)|icons\.svg|manifest\.json)$/.test(p)),
      ];
      writeFileSync(join(outDir, 'asset-manifest.json'), JSON.stringify({ version: BUILD_ID, precache, assets }));
    },
  };
}

export default defineConfig({
  plugins: [react(), assetManifest()],
  define: {
    __AVI_BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  build: {
    sourcemap: true,
  },
  server: {
    proxy: {
      '/api/anthropic': {
        target: 'https://api.anthropic.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/anthropic/, ''),
      },
    },
  },
});
