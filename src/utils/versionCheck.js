// src/utils/versionCheck.js
// Is a newer build of AutoVocaIndex deployed than the one running? (offline
// decisions OF-D3.) Leaf module: no imports.
//
// Each build has an id (vite.config.js). The running app carries it as
// __AVI_BUILD_ID__, and /asset-manifest.json on the server states the id
// of the build deployed now. When they differ, the app offers a reload; it
// never reloads by itself. In local development there is no build id and
// nothing is checked.

/* global __AVI_BUILD_ID__ */
export const RUNNING_BUILD = typeof __AVI_BUILD_ID__ !== 'undefined' ? __AVI_BUILD_ID__ : null;

// The deployed build's id, or null when it can't be told (offline, or the
// file isn't there and the server answered with the page instead).
export async function fetchDeployedBuild(fetchFn = fetch) {
  try {
    const res = await fetchFn('/asset-manifest.json', { cache: 'no-store' });
    if (!res.ok) return null;
    if ((res.headers.get('content-type') || '').includes('text/html')) return null;
    const manifest = await res.json();
    return typeof manifest?.version === 'string' && manifest.version ? manifest.version : null;
  } catch {
    return null;
  }
}

// check() asks at most once per gapMs and calls onNew(deployedId) the first
// time the deployed build differs from the running one. After that it stops
// asking: the answer can't change back. With no running id (development) it
// never asks.
export function createVersionWatch({ running, fetchDeployed, onNew, gapMs = 5 * 60 * 1000, now = Date.now }) {
  let last = -Infinity;
  let busy = false;
  let found = false;
  return {
    async check() {
      if (!running || found || busy) return;
      if (now() - last < gapMs) return;
      last = now();
      busy = true;
      try {
        const deployed = await fetchDeployed();
        if (deployed && deployed !== running && !found) { found = true; onNew(deployed); }
      } finally {
        busy = false;
      }
    },
    found: () => found,
  };
}
