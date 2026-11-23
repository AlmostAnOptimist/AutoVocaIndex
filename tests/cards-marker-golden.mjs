// tests/cards-marker-golden.mjs
// Golden test for keeping flashcards in step across devices,
// src/utils/cardsMarker.js and src/utils/cardStamp.js (offline decisions
// OF-D2): the marker is updated at most every 30 seconds, another device's
// update leads to a read of only the changed cards, at most once a minute
// and never during a review.
//
// Run from the repo root:   node tests/cards-marker-golden.mjs   (or: npm test)
// Firebase is replaced by a stand-in (bundle-with-stub.mjs); nothing here
// reads or writes Firestore. Exits 1 on any failure.

import { bundleWithStub } from './bundle-with-stub.mjs';

const STUB = `
  export const db = {};
  export const collection = (_db, ...path) => ({ path: path.join('/') });
  export const doc = (_db, ...path) => ({ path: path.join('/') });
  export const query = (col, ...filters) => ({ path: col.path, filters });
  export const where = (field, op, value) => ({ field, op, value });
  export const serverTimestamp = () => ({ __serverTime: true });
  export const setDoc = (ref, data) => globalThis.__fs.setDoc(ref, data);
  export const onSnapshot = (ref, next, err) => globalThis.__fs.onSnapshot(ref, next, err);
  export const getDocsFromServer = (q) => globalThis.__fs.getDocsFromServer(q);
`;
const { mod, cleanup } = await bundleWithStub('src/utils/cardsMarker.js', STUB);
const { mod: stampMod, cleanup: cleanup2 } = await bundleWithStub('src/utils/cardStamp.js', STUB);
const {
  compareStamps, newestStamp, mergeChangedCards, createBumper, createRefreshGate,
  bumpCardsMarker, watchCardsMarker, readCardsChangedSince,
} = mod;
const { withCardStamp, CARD_CHANGED_FIELD } = stampMod;

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`);
}
const ts = (seconds, nanoseconds = 0) => ({ seconds, nanoseconds });
const card = (id, at, extra = {}) => ({ id, back: 'b', ...(at ? { updatedAt: at } : {}), ...extra });

// A clock and timers under the test's control.
function clock() {
  let t = 0, seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { timers.set(++seq, { fn, at: t + ms }); return seq; },
    clearTimer: (id) => { timers.delete(id); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); t = due[1].at; due[1].fn();
      }
      t = end;
    },
    pending: () => timers.size,
  };
}

// ── 1. The stamp ──────────────────────────────────────────────
{
  const fields = { stability: 12, due: 'x' };
  check('stamp: adds the server time under updatedAt, keeps the fields, changes nothing passed in',
    [withCardStamp(fields), CARD_CHANGED_FIELD, fields],
    [{ stability: 12, due: 'x', updatedAt: { __serverTime: true } }, 'updatedAt', { stability: 12, due: 'x' }]);
  check('stamps compare by seconds, then nanoseconds',
    [compareStamps(ts(5), ts(4)) > 0, compareStamps(ts(5, 1), ts(5, 2)) < 0, compareStamps(ts(5, 7), ts(5, 7))], [true, true, 0]);
  check('newest stamp: the latest among the cards and the floor; unconfirmed and unstamped cards skipped',
    [newestStamp([card('a', ts(10)), card('b', ts(30, 5)), card('c'), card('d', null), null]),
     newestStamp([card('a', ts(10))], ts(50)), newestStamp([card('a', ts(60))], ts(50)),
     newestStamp([], null), newestStamp(undefined, ts(7)), newestStamp([card('a', { toMillis: 1 })])],
    [ts(30, 5), ts(50), ts(60), null, ts(7), null]);
}

// ── 2. Putting changed cards into memory ──────────────────────
{
  const prev = [card('a', ts(1)), card('b', ts(1)), card('c', ts(1))];
  const hasBack = (c) => c.type === 'grammar' || (c.back !== '' && c.back != null);
  check('merge: a changed card replaces its copy in place; a new one goes at the end',
    mergeChangedCards(prev, [card('b', ts(9), { stability: 40 }), card('new', ts(9))], hasBack).map(c => [c.id, c.updatedAt.seconds]),
    [['a', 1], ['b', 9], ['c', 1], ['new', 9]]);
  check('merge: untouched cards keep their identity',
    (() => { const out = mergeChangedCards(prev, [card('b', ts(9))], hasBack); return [out[0] === prev[0], out[1] === prev[1], out[2] === prev[2]]; })(),
    [true, false, true]);
  check('merge: nothing read -> the same list; not loaded yet stays not loaded',
    [mergeChangedCards(prev, [], hasBack) === prev, mergeChangedCards(prev, null, hasBack) === prev, mergeChangedCards(null, [card('x', ts(1))], hasBack)],
    [true, true, null]);
  check('merge: a card that lost its back leaves memory; a backless new card never enters; grammar cards always stay',
    mergeChangedCards(prev, [card('a', ts(9), { back: '' }), card('n', ts(9), { back: null }), card('g', ts(9), { back: '', type: 'grammar' })], hasBack).map(c => c.id),
    ['b', 'c', 'g']);
}

// ── 3. Updating the marker: at once, then at most every 30 seconds ──
{
  const c = clock();
  let bumps = 0;
  const b = createBumper({ bump: () => bumps++, gapMs: 30000, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  b.touch();
  check('bumper: the first change updates the marker at once', bumps, 1);
  for (let i = 0; i < 20; i++) { c.advance(1000); b.touch(); }            // 20 grades in 20 s
  check('bumper: changes inside the gap wait', [bumps, b.waiting()], [1, true]);
  c.advance(10000);
  check('bumper: one update when the gap is over', [bumps, b.waiting()], [2, false]);
  c.advance(120000);
  check('bumper: nothing more without a change', bumps, 2);
  b.touch();
  check('bumper: after a quiet spell the next change goes at once', bumps, 3);
  c.advance(5000); b.touch(); b.flush();
  check('bumper: flush sends a waiting update now (review ended, app hidden)', [bumps, b.waiting(), c.pending()], [4, false, 0]);
  b.flush();
  check('bumper: flush with nothing waiting does nothing', bumps, 4);
  // A 15-minute review, one grade every 10 seconds.
  const c2 = clock(); let n = 0;
  const b2 = createBumper({ bump: () => n++, gapMs: 30000, now: c2.now, setTimer: c2.setTimer, clearTimer: c2.clearTimer });
  for (let i = 0; i < 90; i++) { b2.touch(); c2.advance(10000); }
  b2.flush();
  check('bumper: a 15-minute review updates the marker about 30 times', n, 31);
}

// ── 4. Reading the changes: at most once a minute, never mid-review ──
{
  const c = clock();
  let runs = 0;
  const g = createRefreshGate({ run: () => runs++, gapMs: 60000, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  g.request();
  check('gate: the first request reads at once', runs, 1);
  g.request(); g.request(); c.advance(20000); g.request();
  check('gate: requests inside the minute wait', [runs, g.wanted()], [1, true]);
  c.advance(40000);
  check('gate: one read when the minute is over', [runs, g.wanted()], [2, false]);
  c.advance(300000);
  check('gate: nothing more without a request', runs, 2);

  // A review is in progress on this device.
  g.hold(true);
  g.request(); g.request();
  c.advance(600000);
  check('gate: during a review nothing is read, however long it takes', [runs, g.wanted()], [2, true]);
  g.hold(false);
  check('gate: the read happens when the review ends', [runs, g.wanted()], [3, false]);
  g.hold(true); g.hold(false);
  check('gate: a review with no request during it reads nothing', runs, 3);

  // A request already waiting out the minute when a review starts.
  g.request();
  check('gate: (waiting out the minute)', [runs, g.wanted()], [3, true]);
  g.hold(true);
  c.advance(120000);
  check('gate: a review that starts while a read is waiting holds it too', [runs, c.pending()], [3, 0]);
  g.hold(false);
  check('gate: and it runs at the end', runs, 4);
  g.request(); g.cancel(); c.advance(120000);
  check('gate: cancel drops a waiting read', [runs, g.wanted()], [4, false]);
}

// ── 5. Firestore: the marker and the changed-since read ───────
{
  const log = { sets: [], queries: [] };
  let listener = null, stopped = false;
  globalThis.__fs = {
    setDoc: async (ref, data) => { log.sets.push({ path: ref.path, data }); },
    onSnapshot: (ref, next) => { listener = { path: ref.path, next }; return () => { stopped = true; }; },
    getDocsFromServer: async (q) => {
      log.queries.push(q);
      return { docs: [card('b', ts(9)), card('n', ts(9))].map(({ id, ...data }) => ({ id, data: () => data })) };
    },
  };
  await bumpCardsMarker('u1');
  const mine = log.sets[0].data.by;
  check('marker: one small document, stamped with the server time and this device',
    [log.sets[0].path, log.sets[0].data.changedAt, typeof mine, mine.length > 0], ['users/u1/meta/cards', { __serverTime: true }, 'string', true]);

  let calls = 0;
  const stop = watchCardsMarker('u1', () => calls++);
  const snap = (data, pending = false) => listener.next({ exists: () => !!data, data: () => data, metadata: { hasPendingWrites: pending } });
  check('watch: listens to the marker document', listener.path, 'users/u1/meta/cards');
  snap({ changedAt: ts(100), by: 'other' });
  check('watch: the first reading is only the starting point', calls, 0);
  snap({ changedAt: ts(100), by: 'other' });
  check('watch: the same reading again is nothing new', calls, 0);
  snap({ changedAt: ts(130), by: 'other' });
  check('watch: another device moved the marker -> read the changes', calls, 1);
  snap({ changedAt: null, by: mine }, true);
  snap({ changedAt: ts(160), by: mine });
  check("watch: this device's own update, pending or confirmed, is not a reason to read", calls, 1);
  snap({ changedAt: ts(190), by: 'third' });
  check('watch: a third device counts too', calls, 2);
  stop();
  check('watch: stopping stops the listener', stopped, true);
  // A marker that doesn't exist yet (nobody has changed a card since the update).
  let calls2 = 0;
  watchCardsMarker('u1', () => calls2++);
  snap(null);
  snap({ changedAt: ts(5), by: 'other' });
  check('watch: no marker yet, then the first one from another device', calls2, 1);

  const rows = await readCardsChangedSince('u1', ts(100, 5));
  check('changed since: asks the server for cards stamped after the newest one seen',
    [log.queries[0].path, log.queries[0].filters, rows.map(r => r.id)],
    ['users/u1/flashcards', [{ field: 'updatedAt', op: '>', value: ts(100, 5) }], ['b', 'n']]);
  await readCardsChangedSince('u1', null);
  check('changed since: with nothing seen yet, every stamped card',
    [log.queries[1].filters[0].op, new Date(log.queries[1].filters[0].value).getTime()], ['>', 0]);
}

await cleanup(); await cleanup2();
console.log(`cards-marker-golden: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
