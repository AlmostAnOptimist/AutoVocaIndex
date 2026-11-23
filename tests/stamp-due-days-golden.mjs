// tests/stamp-due-days-golden.mjs
// Golden test for the one-time "Stamp due days" action,
// src/utils/stampDueDays.js (scheduler SC-D6): which cards it writes to, that
// it only ever adds dueDay and dueDayFor, and that it refuses to run offline.
// Which day each card gets is pinned in fsrs-golden.mjs (planDueDayStamps).
//
// Run from the repo root:   node tests/stamp-due-days-golden.mjs   (or: npm test)
// Firebase is replaced by a stand-in (bundle-with-stub.mjs); nothing here
// reads or writes Firestore. Exits 1 on any failure.

import { bundleWithStub } from './bundle-with-stub.mjs';

process.env.TZ = 'Asia/Seoul';
const { mod, cleanup } = await bundleWithStub('src/utils/stampDueDays.js', `
  export const db = {};
  export const collection = (_db, ...path) => ({ path: path.join('/') });
  export const doc = (_db, ...path) => ({ path: path.join('/') });
  export const getDocs = (ref) => globalThis.__fs.getDocs(ref);
  export const writeBatch = () => globalThis.__fs.writeBatch();
  export const serverTimestamp = () => ({ __serverTime: true });
`);
const { readDueDayStamps, stampDueDays, deviceZone } = mod;

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`);
}

// A stand-in Firestore holding `cards`. failAtBatch: that commit is refused.
function firestore(cards, { fromCache = false, failAtBatch = 0 } = {}) {
  const log = { reads: 0, batches: [], paths: [] };
  globalThis.__fs = {
    getDocs: (ref) => {
      log.reads++; log.paths.push(ref.path);
      return Promise.resolve({ metadata: { fromCache }, docs: cards.map(({ id, ...data }) => ({ id, data: () => data })) });
    },
    writeBatch: () => {
      const writes = [];
      return {
        update: (ref, fields) => writes.push({ path: ref.path, fields }),
        commit: async () => {
          if (failAtBatch && log.batches.length + 1 === failAtBatch) throw new Error('refused');
          log.batches.push(writes);
          // The stand-in keeps what was written, like the real thing.
          for (const w of writes) Object.assign(cards.find(c => c.id === w.path.split('/').pop()), w.fields);
        },
      };
    },
  };
  return log;
}
const KST = (day) => new Date(`${day}T00:00:00+09:00`).toISOString();
const deck = () => [
  { id: 'a', type: 'vocab', state: 'review', due: KST('2026-11-11'), stability: 12, front: 'x' },
  { id: 'b', type: 'sentence', state: 'relearning', due: '2026-11-08T03:00:00.000Z' },
  { id: 'done', type: 'vocab', state: 'review', due: KST('2026-11-20'), dueDay: '2026-11-20', dueDayFor: KST('2026-11-20') },
  { id: 'new', type: 'vocab', state: 'new', nextDueDate: '2026-11-01' },
  { id: 'gram', type: 'grammar', state: 'review', nextDueDate: '2026-11-20', due: null },
];

// 1. Check: reads, counts, writes nothing.
{
  const log = firestore(deck());
  const { total, stamps, fromCache } = await readDueDayStamps('u1');
  check('check: counts the cards that need a due day', [total, stamps.map(s => s.id), fromCache], [5, ['a', 'b'], false]);
  check('check: reads the flashcards, writes nothing', [log.paths, log.batches.length], [['users/u1/flashcards'], 0]);
}

// 2. Stamp: only dueDay and dueDayFor, only on the cards that need them.
{
  const cards = deck();
  const before = JSON.parse(JSON.stringify(cards));
  const log = firestore(cards);
  const progress = [];
  const n = await stampDueDays('u1', (done, total) => progress.push([done, total]));
  check('stamp: what is written', log.batches,
    // updatedAt is the changed-at stamp every card write carries (OF-D2).
    [[{ path: 'users/u1/flashcards/a', fields: { dueDay: '2026-11-11', dueDayFor: KST('2026-11-11'), updatedAt: { __serverTime: true } } },
      { path: 'users/u1/flashcards/b', fields: { dueDay: '2026-11-08', dueDayFor: '2026-11-08T03:00:00.000Z', updatedAt: { __serverTime: true } } }]]);
  check('stamp: returns the count and reports progress', [n, progress], [2, [[2, 2]]]);
  check('stamp: nothing else on any card changes (besides the changed-at stamp)',
    cards.map(({ dueDay, dueDayFor, updatedAt, ...rest }) => rest), before.map(({ dueDay, dueDayFor, updatedAt, ...rest }) => rest));
  const again = firestore(cards);
  check('stamp: a second run finds nothing to do', [await stampDueDays('u1'), again.batches.length], [0, 0]);
}

// 3. A full deck goes in batches of 450.
{
  const many = Array.from({ length: 1000 }, (_, i) => ({ id: `c${i}`, type: 'vocab', state: 'review', due: KST('2026-11-11') }));
  const log = firestore(many);
  const progress = [];
  const n = await stampDueDays('u1', (done, total) => progress.push([done, total]));
  check('batches: 1000 cards in 450 + 450 + 100', [n, log.batches.map(b => b.length), progress],
    [1000, [450, 450, 100], [[450, 1000], [900, 1000], [1000, 1000]]]);
}

// 4. Stopped partway: the next run carries on with what is left.
{
  const many = Array.from({ length: 1000 }, (_, i) => ({ id: `c${i}`, type: 'vocab', state: 'review', due: KST('2026-11-11') }));
  firestore(many, { failAtBatch: 2 });
  let threw = false;
  try { await stampDueDays('u1'); } catch { threw = true; }
  check('refused batch: the run stops with an error, the first batch kept', [threw, many.filter(c => c.dueDay).length], [true, 450]);
  const log = firestore(many);
  check('run again: only the remaining cards are written', [await stampDueDays('u1'), log.batches.map(b => b.length)], [550, [450, 100]]);
}

// 5. Offline (cards came from the local cache): refuse, write nothing.
{
  const log = firestore(deck(), { fromCache: true });
  let code = null;
  try { await stampDueDays('u1'); } catch (e) { code = e.code; }
  check('offline: refused before any write', [code, log.batches.length], ['unavailable', 0]);
}

check('device zone', deviceZone(), 'Asia/Seoul');

await cleanup();
console.log(`stamp-due-days-golden: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
