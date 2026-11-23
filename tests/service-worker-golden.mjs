// tests/service-worker-golden.mjs
// Golden test for AutoVocaIndex's service worker, public/sw.js (offline decisions
// OF-D3): the page comes from the network whenever the network answers, the
// saved copy opens when it doesn't, hashed assets are served from the device,
// and requests that must never be touched aren't.
//
// Run from the repo root:   node tests/service-worker-golden.mjs   (or: npm test)
// The worker's file is run as it is inside a stand-in for the browser's
// service worker environment: a made-up cache store, network and timers.
// Nothing is fetched. Exits 1 on any failure.

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(join(root, 'public', 'sw.js'), 'utf8');
const ORIGIN = 'https://avi.test';

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`);
}
const tick = () => new Promise(r => setImmediate(r));
const html = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const file = (body, type = 'application/javascript') => new Response(body, { status: 200, headers: { 'content-type': type } });
const text = async (res) => (res ? res.text() : null);

// A fresh worker in a fresh made-up browser.
function boot() {
  const handlers = {};
  const stores = new Map();                       // cache name -> Map(url -> Response)
  const abs = (key) => new URL(typeof key === 'string' ? key : key.url, ORIGIN).href;
  const cacheApi = {
    open: async (name) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      return {
        match: async (key) => (m.has(abs(key)) ? m.get(abs(key)).clone() : undefined),
        put: async (key, res) => { m.set(abs(key), res); },
        delete: async (key) => m.delete(abs(key)),
        keys: async () => [...m.keys()].map(url => ({ url })),
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
  };
  const net = { routes: new Map(), log: [], offline: false };
  const fetchStub = (input, init) => {
    const url = abs(input);
    net.log.push({ url, mode: init?.mode ?? (typeof input === 'string' ? undefined : input.mode) });
    if (net.offline) return Promise.reject(new TypeError('Failed to fetch'));
    const route = net.routes.get(url);
    if (!route) return Promise.resolve(html('<!doctype html>page', 200)); // Netlify: any unknown path is the page
    return typeof route === 'function' ? route() : Promise.resolve(route.clone());
  };
  const timers = [];
  let claimed = false, skipped = false;
  const self = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    location: { origin: ORIGIN },
    skipWaiting: () => { skipped = true; },
    clients: { claim: async () => { claimed = true; } },
    registration: {},
  };
  const context = vm.createContext({
    self, caches: cacheApi, fetch: fetchStub, URL, Response, Promise, Set, Map, console,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (id) => { if (id) timers[id - 1] = null; },
  });
  vm.runInContext(source, context);
  const request = (path, { method = 'GET', mode = 'no-cors' } = {}) => ({ url: abs(path), method, mode });
  // Sends a fetch event; resolves to the worker's answer, or 'untouched'.
  const send = (path, opts) => {
    let answer = 'untouched';
    handlers.fetch({ request: request(path, opts), respondWith: (p) => { answer = p; } });
    return answer;
  };
  const saved = (name = 'avi-static-v1') => [...(stores.get(name) || new Map()).keys()].map(u => u.replace(ORIGIN, '')).sort();
  return {
    handlers, net, send, saved, stores,
    fireTimers: () => { for (const t of timers.splice(0)) if (t) t(); },
    state: () => ({ claimed, skipped }),
    put: async (path, res) => (await cacheApi.open('avi-static-v1')).put(path, res),
  };
}

// ── 1. What is never touched ──────────────────────────────────
{
  const w = boot();
  check('untouched: writes, Firestore, sign-in, the functions, audio, the worker file, the manifest, source maps',
    [w.send('/anything', { method: 'POST' }),
     w.send('https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel'),
     w.send('https://identitytoolkit.googleapis.com/v1/accounts:lookup'),
     w.send('https://storage.googleapis.com/avi-tts-audio/a.mp3'),
     w.send('/api/generate-tts'), w.send('/.netlify/functions/get-definition'), w.send('/__/auth/handler'),
     w.send('/sw.js'), w.send('/asset-manifest.json'), w.send('/assets/index-abc.js.map')],
    Array(10).fill('untouched'));
  check('untouched: nothing was fetched or saved for them', [w.net.log.length, w.saved()], [0, []]);
}

// ── 2. The page: network first ────────────────────────────────
{
  const w = boot();
  w.net.routes.set(`${ORIGIN}/`, html('page v1'));
  check('page, first visit: from the network', await text(await w.send('/', { mode: 'navigate' })), 'page v1');
  await tick();
  check('page: a copy is saved', w.saved(), ['/index.html']);

  w.net.routes.set(`${ORIGIN}/`, html('page v2'));
  check('page, after a push: the new one, at once', await text(await w.send('/', { mode: 'navigate' })), 'page v2');
  await tick();
  w.net.offline = true;
  check('page, no connection: the saved copy (the newest one seen)', await text(await w.send('/', { mode: 'navigate' })), 'page v2');
  check('page, no connection, any address in the app: the saved copy', await text(await w.send('/anything#flashcards', { mode: 'navigate' })), 'page v2');

  // The network is there but slow: the saved copy opens after the wait, and
  // the late answer still replaces the saved copy for next time.
  w.net.offline = false;
  let finish;
  w.net.routes.set(`${ORIGIN}/`, () => new Promise(r => { finish = () => r(html('page v3')); }));
  const slow = w.send('/', { mode: 'navigate' });
  await tick(); w.fireTimers();
  check('page, slow network: the saved copy opens when the wait is over', await text(await slow), 'page v2');
  finish(); await tick(); await tick();
  w.net.offline = true;
  check('page: the late answer was saved for next time', await text(await w.send('/', { mode: 'navigate' })), 'page v3');

  w.net.offline = false;
  w.net.routes.set(`${ORIGIN}/`, html('server error', 500));
  check('page, server error: the saved copy', await text(await w.send('/', { mode: 'navigate' })), 'page v3');
  await tick();
  w.net.offline = true;
  check('page: an error answer never replaces the saved copy', await text(await w.send('/', { mode: 'navigate' })), 'page v3');
}
{
  const w = boot();
  w.net.offline = true;
  let failed = false;
  try { await w.send('/', { mode: 'navigate' }); } catch { failed = true; }
  check('page, no connection and nothing saved yet: fails as it would without the worker', failed, true);
}

// ── 3. Hashed assets: the saved copy first ────────────────────
{
  const w = boot();
  w.net.routes.set(`${ORIGIN}/assets/index-abc.js`, file('script'));
  check('asset, first time: from the network', await text(await w.send('/assets/index-abc.js')), 'script');
  await tick();
  const before = w.net.log.length;
  check('asset, again: from the device, no request', [await text(await w.send('/assets/index-abc.js')), w.net.log.length - before], ['script', 0]);
  w.net.offline = true;
  check('asset, no connection: from the device', await text(await w.send('/assets/index-abc.js')), 'script');
  w.net.offline = false;
  // A file from an older build is gone; Netlify answers with the page.
  check('asset that no longer exists: the answer is passed on', await text(await w.send('/assets/index-old.js')), '<!doctype html>page');
  await tick();
  check('asset that no longer exists: the page is never saved under its name', w.saved(), ['/assets/index-abc.js']);
  w.net.routes.set(`${ORIGIN}/assets/panel-123.png`, file('picture', 'image/png'));
  await w.send('/assets/panel-123.png'); await tick();
  check('pictures are saved as they are viewed', w.saved(), ['/assets/index-abc.js', '/assets/panel-123.png']);
}

// ── 4. Icons and the manifest: network first, saved copy as fallback ──
{
  const w = boot();
  w.net.routes.set(`${ORIGIN}/manifest.json`, file('{"v":1}', 'application/json'));
  check('plain file: from the network', await text(await w.send('/manifest.json')), '{"v":1}');
  await tick();
  w.net.routes.set(`${ORIGIN}/manifest.json`, file('{"v":2}', 'application/json'));
  check('plain file: a change is picked up at once', await text(await w.send('/manifest.json')), '{"v":2}');
  await tick();
  w.net.offline = true;
  check('plain file, no connection: the saved copy', await text(await w.send('/manifest.json')), '{"v":2}');
  let failed = false;
  try { await w.send('/icons/never-seen.png'); } catch { failed = true; }
  check('plain file, no connection, never seen: fails', failed, true);
}

// ── 5. Google Fonts ───────────────────────────────────────────
{
  const w = boot();
  const css = 'https://fonts.googleapis.com/css2?family=Hahmlet';
  w.net.routes.set(css, file('@font-face{}', 'text/css'));
  check('font stylesheet, first time: from the network, asked for with CORS',
    [await text(await w.send(css)), w.net.log[0].mode], ['@font-face{}', 'cors']);
  await tick();
  w.net.routes.set(css, file('@font-face{new}', 'text/css'));
  check('font stylesheet, again: the saved copy at once', await text(await w.send(css)), '@font-face{}');
  await tick();
  w.net.offline = true;
  check('font stylesheet: refreshed in the background, there next time, even offline', await text(await w.send(css)), '@font-face{new}');
  await tick();
  const woff = 'https://fonts.gstatic.com/s/hahmlet/v1/a.woff2';
  let failed = false;
  try { await w.send(woff); } catch { failed = true; }
  check('a font never used before is not there offline', failed, true);
}

// ── 6. Precache after a deploy ────────────────────────────────
{
  const w = boot();
  const manifest = (version) => file(JSON.stringify({
    version,
    precache: ['/assets/index-new.js', '/assets/Quizzes-new.js', '/assets/index-new.css', '/icons/avi-192.png'],
    assets: ['/assets/index-new.js', '/assets/Quizzes-new.js', '/assets/index-new.css', '/assets/panel-123.png'],
  }), 'application/json');
  for (const p of ['/assets/index-new.js', '/assets/Quizzes-new.js', '/assets/index-new.css', '/icons/avi-192.png']) w.net.routes.set(ORIGIN + p, file(`file ${p}`));
  // What the device holds from the build before, plus things that must survive.
  await w.put('/index.html', html('page'));
  await w.put('/assets/index-old.js', file('old script'));
  await w.put('/assets/old-picture.png', file('old picture', 'image/png'));
  await w.put('/assets/panel-123.png', file('picture still in the build', 'image/png'));
  await w.put('/assets/index-new.js', file('already here'));
  await w.put('https://fonts.gstatic.com/s/hahmlet/v1/a.woff2', file('font', 'font/woff2'));
  const run = async (version) => { let p; w.handlers.message({ data: { type: 'precache', version }, waitUntil: (x) => { p = x; } }); return p; };

  w.net.routes.set(`${ORIGIN}/asset-manifest.json`, manifest('build-9'));
  const before = w.saved();
  check('precache, a newer deploy than the page running: nothing is touched',
    [await run('build-8'), w.saved()], [{ ok: false, reason: 'another version' }, before]);

  w.net.log.length = 0;
  check('precache, same version: saves what is missing, removes what the build no longer has',
    await run('build-9'), { ok: true, saved: 3, failed: 0, removed: 2 });
  check('precache: every script and style is on the device, the page, fonts and current pictures kept, old files gone', w.saved(),
    ['/assets/Quizzes-new.js', '/assets/index-new.css', '/assets/index-new.js', '/assets/panel-123.png', '/icons/avi-192.png', '/index.html', 'https://fonts.gstatic.com/s/hahmlet/v1/a.woff2']);
  check('precache: a file already on the device is not downloaded again',
    w.net.log.map(l => l.url.replace(ORIGIN, '')).includes('/assets/index-new.js'), false);
  check('precache again: nothing to do', await run('build-9'), { ok: true, saved: 0, failed: 0, removed: 0 });
  w.net.offline = true;
  check('after precache, offline: a page never opened since the deploy still loads', await text(await w.send('/assets/Quizzes-new.js')), 'file /assets/Quizzes-new.js');
  check('precache, no connection: gives up quietly', await run('build-9'), { ok: false, reason: 'failed' });
  w.net.offline = false;
  w.net.routes.delete(`${ORIGIN}/asset-manifest.json`);   // Netlify would answer with the page
  check('precache, no manifest on the server: nothing is touched', await run('build-9'), { ok: false, reason: 'no manifest' });
  let other = 'not called';
  w.handlers.message({ data: { type: 'something else' }, waitUntil: () => { other = 'called'; } });
  check('other messages are ignored', other, 'not called');
}

// The very first visit: the page loaded before the worker existed.
{
  const w = boot();
  w.net.routes.set(`${ORIGIN}/`, html('page v1'));
  w.net.routes.set(`${ORIGIN}/asset-manifest.json`, file(JSON.stringify({ version: 'b1', precache: [], assets: [] }), 'application/json'));
  let p; w.handlers.message({ data: { type: 'precache', version: 'b1' }, waitUntil: (x) => { p = x; } });
  await p;
  w.net.offline = true;
  check('first visit: precache saves the page too, so the next start can be offline',
    [w.saved(), await text(await w.send('/', { mode: 'navigate' }))], [['/index.html'], 'page v1']);
}

// ── 7. Install and activate ───────────────────────────────────
{
  const w = boot();
  w.stores.set('avi-static-v0', new Map([['x', 1]]));
  w.stores.set('someone-elses-cache', new Map());
  w.handlers.install({});
  let done;
  w.handlers.activate({ waitUntil: (p) => { done = p; } });
  await done;
  check('a new worker takes over at once and clears only its own older stores',
    [w.state(), [...w.stores.keys()]], [{ claimed: true, skipped: true }, ['someone-elses-cache']]);
}

console.log(`service-worker-golden: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
