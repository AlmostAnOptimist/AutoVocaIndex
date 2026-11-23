// tests/grammar-entries-store-golden.mjs
// Golden test for reading Grammar Index entries once and again only when
// they change, src/utils/grammarEntriesStore.js: one marker read when
// nothing changed, a full read when another device (or another part of the
// app) changed entries, no re-read for this device's own Grammar Index
// edits, and this device's copy when the server can't be reached.
//
// Run from the repo root:   node tests/grammar-entries-store-golden.mjs   (or: npm test)
// Firebase is replaced by a stand-in (bundle-with-stub.mjs); nothing here
// reads or writes Firestore. Exits 1 on any failure.

import { bundleWithStub } from './bundle-with-stub.mjs';

const STUB = `
  export const db = {};
  export const collection = (_db, ...path) => ({ path: path.join('/') });
  export const doc = (_db, ...path) => ({ path: path.join('/') });
  export const increment = (by) => ({ __increment: by });
  export const setDoc = (ref, data, opts) => globalThis.__fs.setDoc(ref, data, opts);
  export const getDocFromServer = (ref) => globalThis.__fs.getDocFromServer(ref);
  export const getDocsFromServer = (ref) => globalThis.__fs.getDocsFromServer(ref);
  export const getDocsFromCache = (ref) => globalThis.__fs.getDocsFromCache(ref);
`;
const { mod, cleanup } = await bundleWithStub('src/utils/grammarEntriesStore.js', STUB);
const {
  GRAMMAR_CACHE_KEY, GRAMMAR_COUNT_KEY, sortEntries, masteryCounts, mustReadAll,
  readStored, writeStored, noteOwnChange, createGrammarLoader,
  loadGrammarEntries, bumpGrammarEntriesMarker, addGrammarMarkerBump, rememberGrammarEntries,
} = mod;

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`);
}

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    dump: () => Object.fromEntries(m),
  };
}
const E = (id, entryNumber, masteryLevel = 'introduced') => ({ id, entryNumber, glossaryTerm: id, masteryLevel });
const quiet = async (fn) => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };

// ── Pure helpers ──────────────────────────────────────────────
check('sortEntries by entry number, missing numbers first',
  sortEntries([E('b', 2), E('a', 1), { id: 'x' }]).map(e => e.id), ['x', 'a', 'b']);
check('masteryCounts', masteryCounts([E('a', 1), E('b', 2, 'mastered'), E('c', 3, 'odd')]),
  { all: 3, introduced: 1, practicing: 0, confident: 0, mastered: 1 });
check('mustReadAll: no copy', mustReadAll(0, 0, false), true);
check('mustReadAll: copy without a count (before this change)', mustReadAll(0, null, true), true);
check('mustReadAll: in step', mustReadAll(5, 5, true), false);
check('mustReadAll: server ahead', mustReadAll(6, 5, true), true);
check('mustReadAll: own changes still on their way', mustReadAll(4, 5, true), false);

{
  const st = memStorage();
  check('readStored: empty', readStored(st), { rows: null, n: null });
  writeStored(st, [E('a', 1)], 3);
  check('writeStored then readStored', readStored(st), { rows: [E('a', 1)], n: 3 });
  writeStored(st, [E('b', 1)]);
  check('writeStored without n keeps the count', readStored(st), { rows: [E('b', 1)], n: 3 });
  noteOwnChange(st);
  check('noteOwnChange adds 1', readStored(st).n, 4);
  const none = memStorage();
  noteOwnChange(none);
  check('noteOwnChange with no count stays unvouched', readStored(none).n, null);
  const junk = memStorage({ [GRAMMAR_CACHE_KEY]: '{not json', [GRAMMAR_COUNT_KEY]: 'x' });
  check('readStored: bad values read as nothing', readStored(junk), { rows: null, n: null });
  const full = memStorage({ [GRAMMAR_COUNT_KEY]: '7' });
  full.setItem = (k) => { if (k === GRAMMAR_CACHE_KEY) throw new Error('quota'); };
  writeStored(full, [E('a', 1)], 9);
  check('writeStored: rows that cannot be saved drop the count', full.getItem(GRAMMAR_COUNT_KEY), null);
}

// ── The loader ────────────────────────────────────────────────
function setup({ serverN = 0, entries = [E('b', 2), E('a', 1)], cached = null, storedN, t = 0 } = {}) {
  const init = {};
  if (cached) init[GRAMMAR_CACHE_KEY] = JSON.stringify(cached);
  if (storedN != null) init[GRAMMAR_COUNT_KEY] = String(storedN);
  const st = memStorage(init);
  const io = { countReads: 0, fullReads: 0, cacheReads: 0, offline: false, serverN, entries, t };
  const loader = createGrammarLoader({
    readCount: async () => { io.countReads++; if (io.offline) throw new Error('offline'); return io.serverN; },
    readAll:   async () => { io.fullReads++; if (io.offline) throw new Error('offline'); return io.entries; },
    readAllCached: async () => { io.cacheReads++; return io.entries; },
    storage: st, now: () => io.t, gapMs: 60000,
  });
  return { st, io, loader };
}

{
  const { st, io, loader } = setup({ serverN: 0 });
  const rows = await loader.load();
  check('first load ever: full read, sorted', [io.countReads, io.fullReads, rows.map(e => e.id)], [1, 1, ['a', 'b']]);
  check('first load ever: copy saved with the count', readStored(st).n, 0);
  io.t += 61000;
  await loader.load();
  check('next check, nothing changed: one marker read only', [io.countReads, io.fullReads], [2, 1]);
  io.t += 1000;
  await loader.load();
  check('within a minute: no read at all', [io.countReads, io.fullReads], [2, 1]);
  io.t += 61000; io.serverN = 1; io.entries = [E('a', 1), E('b', 2), E('c', 3)];
  const r2 = await loader.load();
  check('another device changed entries: full read', [io.countReads, io.fullReads, r2.length, readStored(st).n], [3, 2, 3, 1]);
}

{
  const { io, loader } = setup({ cached: [E('a', 1)] });
  await loader.load();
  check('copy from before this change (no count): full read once', io.fullReads, 1);
}

{
  // This device's Grammar Index edit: the copy already has it.
  const { st, io, loader } = setup({ serverN: 5, cached: [E('a', 1)], storedN: 5 });
  await loader.load();
  check('in step: no full read', io.fullReads, 0);
  writeStored(st, [E('a', 1), E('n', 2)]); // the page's entries after the edit
  noteOwnChange(st);                        // its marker bump
  io.serverN = 6;                           // the bump reaches the server
  io.t += 61000;
  const rows = await loader.load();
  check('own edit: no re-read, keeps the edited copy', [io.fullReads, rows.map(e => e.id)], [0, ['a', 'n']]);
}

{
  // Own edit and another device's edit in the same period.
  const { st, io, loader } = setup({ serverN: 5, cached: [E('a', 1)], storedN: 5 });
  noteOwnChange(st);
  io.serverN = 7;
  await loader.load();
  check('own edit plus another device: full read', io.fullReads, 1);
}

{
  // Own edits made offline, not yet on the server.
  const { st, io, loader } = setup({ serverN: 5, cached: [E('a', 1)], storedN: 5 });
  writeStored(st, [E('a', 1), E('o', 2)]);
  noteOwnChange(st);
  const rows = await loader.load();
  check('own offline edit not yet sent: copy kept', [io.fullReads, rows.length], [0, 2]);
}

{
  const { io, loader } = setup({ serverN: 3, cached: [E('a', 1)], storedN: 3 });
  io.offline = true;
  const rows = await quiet(() => loader.load());
  check('offline with a copy: the copy, no cache read', [rows.map(e => e.id), io.cacheReads], [['a'], 0]);
  io.offline = false;
  await loader.load();
  check('offline answer does not count as a check: next load checks', io.countReads, 2);
}

{
  const { io, loader } = setup({ entries: [E('z', 2), E('y', 1)] });
  io.offline = true;
  const rows = await quiet(() => loader.load());
  check('offline with no copy: Firestore\'s on-device copy', [rows.map(e => e.id), io.cacheReads], [['y', 'z'], 1]);
}

{
  const { io, loader } = setup({ serverN: 2 });
  const [a, b] = await Promise.all([loader.load(), loader.load()]);
  check('two callers at once share one check', [io.countReads, io.fullReads, a === b], [1, 1, true]);
}

{
  // A full read that fails halfway keeps the old copy and its count.
  const { st, io, loader } = setup({ serverN: 9, cached: [E('a', 1)], storedN: 4 });
  const readAll = io.entries;
  io.entries = null;
  const l2 = createGrammarLoader({
    readCount: async () => 9, readAll: async () => { throw new Error('dropped'); },
    readAllCached: async () => readAll, storage: st, now: () => 0,
  });
  const rows = await quiet(() => l2.load());
  check('failed full read: old copy, count unchanged', [rows.map(e => e.id), readStored(st).n], [['a'], 4]);
  void loader;
}

{
  // Storage that can't hold the copy (full): the answer still comes back,
  // and within the minute without another read.
  const { st, io, loader } = setup({ serverN: 1 });
  st.setItem = () => { throw new Error('quota'); };
  const a = await loader.load();
  io.t += 1000;
  const b = await loader.load();
  check('storage full: rows answered, no second read within the minute',
    [a.length, b.length, io.countReads, io.fullReads], [2, 2, 1, 1]);
}

// ── Firestore half ────────────────────────────────────────────
{
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const calls = [];
  let markerN = 4;
  globalThis.__fs = {
    setDoc: async (ref, data, opts) => { calls.push(['set', ref.path, data, opts]); },
    getDocFromServer: async (ref) => { calls.push(['getDoc', ref.path]); return { exists: () => markerN != null, data: () => ({ n: markerN }) }; },
    getDocsFromServer: async (ref) => { calls.push(['getDocs', ref.path]); return { docs: [{ id: 'g2', data: () => ({ entryNumber: 2 }) }, { id: 'g1', data: () => ({ entryNumber: 1 }) }] }; },
    getDocsFromCache: async () => ({ docs: [] }),
  };
  const rows = await loadGrammarEntries('u1');
  check('reads the marker, then the entries', calls.map(c => c.slice(0, 2)),
    [['getDoc', 'users/u1/meta/grammar'], ['getDocs', 'users/u1/grammar_entries']]);
  check('rows carry their ids, sorted', rows.map(r => r.id), ['g1', 'g2']);
  check('copy saved with the marker count', [JSON.parse(store.get(GRAMMAR_CACHE_KEY)).length, store.get(GRAMMAR_COUNT_KEY)], [2, '4']);

  calls.length = 0;
  bumpGrammarEntriesMarker('u1', { inMemory: true });
  await new Promise(r => setTimeout(r, 0));
  check('bump: increments n with merge', calls, [['set', 'users/u1/meta/grammar', { n: { __increment: 1 } }, { merge: true }]]);
  check('bump inMemory moves this copy\'s count', store.get(GRAMMAR_COUNT_KEY), '5');
  bumpGrammarEntriesMarker('u1');
  check('bump from elsewhere leaves the count', store.get(GRAMMAR_COUNT_KEY), '5');
  bumpGrammarEntriesMarker('');
  await new Promise(r => setTimeout(r, 0));
  check('no uid: no write', calls.length, 2);

  const batchOps = [];
  addGrammarMarkerBump({ set: (ref, data, opts) => batchOps.push([ref.path, data, opts]) }, 'u1');
  check('batch bump', batchOps, [['users/u1/meta/grammar', { n: { __increment: 1 } }, { merge: true }]]);

  rememberGrammarEntries([{ id: 'g9' }]);
  check('remember: rows saved, count untouched', [JSON.parse(store.get(GRAMMAR_CACHE_KEY))[0].id, store.get(GRAMMAR_COUNT_KEY)], ['g9', '5']);

  markerN = null; // marker doesn't exist yet: n counts as 0, behind the copy's 5
  calls.length = 0;
  const { mod: fresh, cleanup: c2 } = await bundleWithStub('src/utils/grammarEntriesStore.js', STUB);
  const kept = await fresh.loadGrammarEntries('u1');
  check('missing marker behind the copy: copy kept', [calls.map(c => c[0]), kept[0].id], [['getDoc'], 'g9']);
  await c2();
}

await cleanup();
console.log(`${pass}/${pass + fail} checks pass`);
process.exit(fail ? 1 : 0);
