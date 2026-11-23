// public/sw.js — AutoVocaIndex's service worker (offline decisions OF-D3).
// Written by hand, no build step: this file is served as it is.
//
// What it does
//   The page         network first, so a push is picked up on the next online
//                    load exactly as before. Only when the network doesn't
//                    answer within PAGE_TIMEOUT_MS, or fails, does the copy
//                    saved on this device open.
//   /assets/*        scripts, styles and pictures built by Vite. Their names
//                    carry a hash of their content, so a saved copy never
//                    goes out of date: saved copy first, network otherwise.
//                    Scripts, styles and fonts are saved in the background
//                    after each deploy ("precache" below), so every page of
//                    the app opens offline. Pictures are saved as viewed.
//   Google Fonts     saved as used; the stylesheet is refreshed in the
//                    background.
//   Icons, manifest  network first, saved copy as the fallback.
//   Everything else  not touched: Firestore, sign-in, /api/*, Netlify
//                    functions, audio, anything that isn't a GET.
//
// Why a device can't get stuck on an old version: the page itself is never
// served from the saved copy while the network answers.
//
// To switch it off everywhere: replace this file's contents with
//   self.addEventListener('install', () => self.skipWaiting());
//   self.addEventListener('activate', (e) => e.waitUntil(
//     caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k))))
//       .then(() => self.registration.unregister())));
// and push. Each device removes it on its next online load.
//
// Tested by tests/service-worker-golden.mjs.

const CACHE = 'avi-static-v1';
const PAGE_KEY = '/index.html';
const PAGE_TIMEOUT_MS = 3000;
const MANIFEST_URL = '/asset-manifest.json';
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

const isHtml = (res) => (res.headers.get('content-type') || '').includes('text/html');
const openCache = () => caches.open(CACHE);

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('avi-static-') && n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

// ── The page ──────────────────────────────────────────────────
async function pageResponse(request) {
  const cache = await openCache();
  const network = fetch(request).then((res) => {
    // Netlify answers every path with the page, so any good HTML answer to a
    // navigation is the current page.
    if (res && res.ok && isHtml(res)) cache.put(PAGE_KEY, res.clone());
    return res;
  });
  const saved = await cache.match(PAGE_KEY);
  if (!saved) return network; // nothing saved yet: only the network can answer
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), PAGE_TIMEOUT_MS); });
  network.catch(() => {}); // if the timeout wins, a later failure has nowhere to go
  try {
    const res = await Promise.race([network, timeout]);
    return res && res.ok ? res : saved;
  } catch {
    return saved;
  } finally {
    clearTimeout(timer);
  }
}

// ── Hashed assets ─────────────────────────────────────────────
async function assetResponse(request) {
  const cache = await openCache();
  const saved = await cache.match(request.url);
  if (saved) return saved;
  const res = await fetch(request);
  // A file that no longer exists comes back as the page (HTML, status 200).
  // Never save that under a script's or picture's name.
  if (res && res.status === 200 && !isHtml(res)) cache.put(request.url, res.clone());
  return res;
}

// ── Icons, manifest.json and other plain files ────────────────
async function staticResponse(request) {
  const cache = await openCache();
  try {
    const res = await fetch(request);
    if (res && res.status === 200 && !isHtml(res)) cache.put(request.url, res.clone());
    return res;
  } catch (e) {
    const saved = await cache.match(request.url);
    if (saved) return saved;
    throw e;
  }
}

// ── Google Fonts ──────────────────────────────────────────────
// Fetched with CORS so the saved copy is an ordinary response (the page's
// own stylesheet request would give an opaque one, which browsers charge a
// large fixed size for).
async function fontResponse(request) {
  const cache = await openCache();
  const saved = await cache.match(request.url);
  const refresh = fetch(request.url, { mode: 'cors', credentials: 'omit' }).then((res) => {
    if (res && res.status === 200) cache.put(request.url, res.clone());
    return res;
  });
  if (!saved) return refresh;
  refresh.catch(() => {});
  return saved;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  // A browser quirk: such a request can't be repeated by a worker.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  const url = new URL(request.url);
  if (FONT_HOSTS.includes(url.hostname)) { event.respondWith(fontResponse(request)); return; }
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (path.startsWith('/api/') || path.startsWith('/.netlify/') || path.startsWith('/__/')) return;
  if (path === '/sw.js' || path === MANIFEST_URL || path.endsWith('.map')) return;
  if (request.mode === 'navigate') { event.respondWith(pageResponse(request)); return; }
  if (path.startsWith('/assets/')) { event.respondWith(assetResponse(request)); return; }
  event.respondWith(staticResponse(request));
});

// ── Precache: after each deploy, save what the app needs offline ──
// The page asks for this once it has loaded, naming the version it is
// running. The build writes /asset-manifest.json:
//   { version, precache: [paths to save now], assets: [every file under /assets/] }
// Saved copies of /assets/ files that the current build no longer has are
// removed. Nothing is touched unless the manifest is for the very version
// the page is running: if a newer deploy has landed since the page loaded,
// the saved page still needs the files it was built with.
async function precache(runningVersion) {
  const res = await fetch(MANIFEST_URL, { cache: 'no-store' });
  if (!res.ok || isHtml(res)) return { ok: false, reason: 'no manifest' };
  const manifest = await res.json();
  if (!manifest || manifest.version !== runningVersion) return { ok: false, reason: 'another version' };
  const cache = await openCache();
  // The page itself, on the first visit after the worker arrived: it was
  // loaded before the worker could save it.
  if (!(await cache.match(PAGE_KEY))) {
    try {
      const page = await fetch('/', { cache: 'no-store' });
      if (page.ok && isHtml(page)) await cache.put(PAGE_KEY, page);
    } catch { /* next online load saves it */ }
  }
  let saved = 0, failed = 0;
  for (const path of manifest.precache || []) {
    const url = new URL(path, self.location.origin).href;
    if (await cache.match(url)) continue;
    try {
      const file = await fetch(url);
      if (file.status === 200 && !isHtml(file)) { await cache.put(url, file); saved++; }
      else failed++;
    } catch {
      failed++;
    }
  }
  const current = new Set((manifest.assets || []).map(p => new URL(p, self.location.origin).href));
  let removed = 0;
  for (const request of await cache.keys()) {
    const url = new URL(request.url);
    if (url.origin === self.location.origin && url.pathname.startsWith('/assets/') && !current.has(url.href)) {
      await cache.delete(request);
      removed++;
    }
  }
  return { ok: true, saved, failed, removed };
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'precache') return;
  event.waitUntil(precache(data.version).catch(() => ({ ok: false, reason: 'failed' })));
});
