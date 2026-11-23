// tests/review-stats-golden.mjs
// Golden test for the review records (audit FS4):
//   src/utils/reviewStatsGuard.js  - never saved before they have been read,
//                                    and read again at each session start
//   src/utils/reviewStatsEngine.js - what one more grade does to them
//
// Run from the repo root:   node tests/review-stats-golden.mjs   (or: npm test)
// The guard has no imports. The engine imports Firebase for its recompute,
// so it is bundled with a stand-in (bundle-with-stub.mjs); nothing here
// reads or writes Firestore. Exits 1 on any failure.

import { bundleWithStub } from './bundle-with-stub.mjs';

process.env.TZ = 'Asia/Seoul';
const { createStatsGuard } = await import('../src/utils/reviewStatsGuard.js');
const { mod: engine, cleanup } = await bundleWithStub('src/utils/reviewStatsEngine.js', `
  export const db = {};
  export const collection = () => ({}), doc = () => ({});
  export const getDocs = async () => ({ forEach() {} }), setDoc = async () => {};
`);
const { applyReviewToStats, EMPTY_REVIEW_STATS } = engine;

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`);
}
const tick = () => new Promise(r => setTimeout(r, 0));
const quiet = async (fn) => { const keep = console.error; console.error = () => {}; try { await fn(); } finally { console.error = keep; } };

// A stand-in for the records: a running total, on top of what was stored.
const STORED = { total: 500, best: 80 };
const apply  = (stats, g) => ({ ...stats, total: stats.total + 1, last: g.n });
function rig(load) {
  const saves = [], seen = [];
  const guard = createStatsGuard({ load, save: s => saves.push(s), apply, onChange: s => seen.push(s) });
  return { guard, saves, seen };
}

// 1. Load, then grade: the usual order.
{
  const { guard, saves, seen } = rig(async () => STORED);
  guard.ensureLoaded();
  await tick();
  check('loaded records are shown and not written back', [seen, saves], [[STORED], []]);
  guard.record({ n: 1 });
  check('a grade after the load is applied and saved', saves, [{ total: 501, best: 80, last: 1 }]);
}

// 2. Grades that beat the load: nothing is saved until it lands.
{
  let finish;
  const { guard, saves } = rig(() => new Promise(r => { finish = r; }));
  guard.ensureLoaded();
  guard.record({ n: 1 });
  guard.record({ n: 2 });
  await tick();
  check('before the load lands: nothing saved, two grades held', [saves, guard.pending(), guard.isLoaded()], [[], 2, false]);
  finish(STORED);
  await tick();
  check('after: held grades applied on top of the stored records, saved once',
    [saves, guard.pending()], [[{ total: 502, best: 80, last: 2 }], 0]);
  check('the stored best day survives', saves[0].best, 80);
}

// 3. The load fails (offline, nothing cached): never write, try again later.
await quiet(async () => {
  let attempts = 0, ok = false;
  const { guard, saves } = rig(async () => { attempts++; if (!ok) throw new Error('offline'); return STORED; });
  guard.ensureLoaded();
  await tick();
  guard.record({ n: 1 });
  await tick();
  check('failed load: no save, grade held, load tried again at the grade', [saves, guard.pending(), attempts], [[], 1, 2]);
  ok = true;
  guard.record({ n: 2 });
  await tick();
  check('once readable: both grades applied to the stored records', saves, [{ total: 502, best: 80, last: 2 }]);
});

// 4. No records stored yet: the empty shape is a real answer.
{
  const { guard, saves } = rig(async () => ({ total: 0, best: null }));
  guard.record({ n: 1 });
  await tick();
  check('first ever grade starts the records', saves, [{ total: 1, best: null, last: 1 }]);
}

// 5. One load at a time.
{
  let loads = 0;
  const { guard } = rig(() => { loads++; return new Promise(() => {}); });
  guard.ensureLoaded(); guard.ensureLoaded(); guard.record({ n: 1 });
  await tick();
  check('repeat calls share one load', loads, 1);
}

// 6. Session start (SC-D7): read the records again before grading.
{
  let stored = STORED;
  const { guard, saves, seen } = rig(async () => stored);
  guard.ensureLoaded();
  await tick();
  stored = { total: 560, best: 95 };            // another device reviewed 60 cards since
  guard.refresh();
  await tick();
  check('refresh: the newer records are shown, nothing is written', [seen[seen.length - 1], saves], [{ total: 560, best: 95 }, []]);
  guard.record({ n: 1 });
  check('refresh: the next grade builds on the newer records', saves, [{ total: 561, best: 95, last: 1 }]);
}
// Without the refresh, the first grade would have saved 501 over the other
// device's 560. Grades made while the fresh copy is on its way wait for it.
{
  let finish, calls = 0;
  const { guard, saves } = rig(() => (++calls === 1 ? Promise.resolve(STORED) : new Promise(r => { finish = r; })));
  guard.ensureLoaded();
  await tick();
  guard.refresh();
  await tick();
  guard.record({ n: 1 });
  guard.record({ n: 2 });
  check('refresh on its way: grades are held, nothing saved', [saves, guard.pending()], [[], 2]);
  guard.refresh();
  await tick();
  check('refresh on its way: a second call does not start another read', calls, 2);
  finish({ total: 560, best: 95 });
  await tick();
  check('refresh landed: held grades applied to the newer records, saved once', [saves, guard.pending()], [[{ total: 562, best: 95, last: 2 }], 0]);
  guard.record({ n: 3 });
  check('and grading carries on from there', saves[saves.length - 1], { total: 563, best: 95, last: 3 });
}
// The read fails (offline): keep going from the copy already held.
await quiet(async () => {
  let ok = true;
  const { guard, saves, seen } = rig(async () => { if (!ok) throw new Error('offline'); return STORED; });
  guard.ensureLoaded();
  await tick();
  ok = false;
  guard.refresh();
  guard.record({ n: 1 });
  await tick();
  check('refresh failed: the held grade is applied to the copy in memory', saves, [{ total: 501, best: 80, last: 1 }]);
  guard.refresh();
  await tick();
  check('refresh failed with nothing held: no write, no change', [saves.length, seen.length], [1, 2]);
  guard.record({ n: 2 });
  check('grading still works afterwards', saves[saves.length - 1], { total: 502, best: 80, last: 2 });
});
// Before the first load has landed, refresh is just the load.
{
  let loads = 0;
  const { guard, saves } = rig(async () => { loads++; return STORED; });
  guard.refresh(); guard.refresh();
  await tick();
  check('refresh before any load: one read, nothing written', [loads, guard.isLoaded(), saves], [1, true, []]);
}

// 7. What one more grade does to the records (reviewStatsEngine.js).
{
  const base = { ...EMPTY_REVIEW_STATS, totalAllTime: 900, bestDay: { date: '2026-10-01', count: 120 },
    currentWeekStart: '2026-11-09', currentWeekCount: 40, currentMonthYM: '2026-11', currentMonthCount: 300,
    lastReviewDate: '2026-11-10', currentStreakLength: 12, longestStreak: { length: 30, endDate: '2026-09-01' } };
  const first = applyReviewToStats(base, '2026-11-11', 1, 3);
  check('first grade of a day: streak grows by one, totals by one',
    [first.currentStreakLength, first.lastReviewDate, first.totalAllTime, first.currentWeekCount, first.currentMonthCount],
    [13, '2026-11-11', 901, 41, 301]);
  const second = applyReviewToStats(first, '2026-11-11', 2, 3);
  check('second grade the same day: streak unchanged', [second.currentStreakLength, second.totalAllTime], [13, 902]);
  // SC-D7: another device already reviewed today; this one's count starts at 1.
  const elsewhere = applyReviewToStats(first, '2026-11-11', 1, 3);
  check('count of 1 on a day already in the records: the streak does not grow again',
    [elsewhere.currentStreakLength, elsewhere.totalAllTime], [13, 902]);
  // And the other way round: the count is past 1 but the records missed the day.
  const missed = applyReviewToStats(base, '2026-11-11', 5, 3);
  check('day missing from the records: picked up whatever the count says', [missed.currentStreakLength, missed.lastReviewDate], [13, '2026-11-11']);
  const gap = applyReviewToStats(base, '2026-11-13', 1, 3);
  check('a missed day resets the streak to 1', [gap.currentStreakLength, gap.longestStreak], [1, { length: 30, endDate: '2026-09-01' }]);
  const record = applyReviewToStats({ ...base, currentStreakLength: 30 }, '2026-11-11', 1, 3);
  check('a longer streak becomes the record', record.longestStreak, { length: 31, endDate: '2026-11-11' });
  check('best day moves only when beaten',
    [applyReviewToStats(base, '2026-11-11', 120, 3).bestDay, applyReviewToStats(base, '2026-11-11', 121, 3).bestDay],
    [{ date: '2026-10-01', count: 120 }, { date: '2026-11-11', count: 121 }]);
  check('a new week and month start their counts at 1',
    (() => { const s = applyReviewToStats(base, '2026-12-01', 1, 3); return [s.currentWeekStart, s.currentWeekCount, s.currentMonthYM, s.currentMonthCount]; })(),
    ['2026-11-30', 1, '2026-12', 1]);
  check('first ever grade', (() => { const s = applyReviewToStats(null, '2026-11-11', 1, 3); return [s.totalAllTime, s.currentStreakLength, s.longestStreak]; })(),
    [1, 1, { length: 1, endDate: '2026-11-11' }]);
  check('the records passed in are not changed', base.currentStreakLength, 12);
}

await cleanup();
console.log(`review-stats-golden: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
