// tests/recurrence-golden.mjs
// Golden test for "Every N days" in src/utils/recurrenceEngine.js (audit TZ1).
//
// Run from the repo root:   node tests/recurrence-golden.mjs   (or: npm test)
//
// "Every N days" must count calendar days. Counting N x 24 hours gives the
// same answer in Korea, but lands a day early across a clock change when the
// device is somewhere with daylight saving. The second half of this test
// runs itself again in Europe/Amsterdam to prove that case.
//
// Also: uncompleted SRS spike tasks are dropped at rollover whatever their
// date (DF-D7). The rest of the engine is covered by finance-golden.mjs
// (not in this repo).

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { getNextOccurrence, runRecurrenceEngine, isMissedSpikeTask } = await import('../src/utils/recurrenceEngine.js');

const pad = (n) => String(n).padStart(2, '0');
const str = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const task = (date, interval) => ({ date, recurrence: { type: 'every_n_days', interval } });
const next = (date, n) => getNextOccurrence(task(date, n), new Date(date + 'T00:00:00'));

// Child mode: print the answers for the clock-change dates and stop.
if (process.env.RECUR_ZONE_CHECK) {
  console.log(JSON.stringify([
    next('2026-10-24', 2), next('2026-10-24', 3), next('2026-10-24', 7),   // clocks go back Oct 25, 2026
    next('2027-03-27', 2), next('2027-03-27', 3),                          // clocks go forward Mar 28, 2027
  ]));
  process.exit(0);
}

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`);
}

check('every 2 days', next('2026-11-10', 2), '2026-11-12');
check('every 5 days across a month end', next('2026-11-28', 5), '2026-12-03');
check('every 3 days across a year end', next('2026-12-30', 3), '2027-01-02');
check('every 2 days across Feb 28 (not a leap year)', next('2027-02-27', 2), '2027-03-01');
check('every 2 days across Feb 29 (leap year)', next('2028-02-28', 2), '2028-03-01');
check('interval is kept between 2 and 100', [next('2026-11-10', 1), next('2026-11-10', 500)], ['2026-11-12', '2027-02-18']);
check('no interval set -> 3 days', getNextOccurrence({ date: '2026-11-10', recurrence: { type: 'every_n_days' } }, new Date('2026-11-10T00:00:00')), '2026-11-13');

// Every start day of two years x a spread of intervals, against plain
// calendar arithmetic.
let mismatches = 0, cases = 0;
for (let i = 0; i < 731; i++) {
  const start = new Date(2026, 0, 1 + i);
  for (const n of [2, 3, 7, 14, 30, 100]) {
    const want = new Date(start.getFullYear(), start.getMonth(), start.getDate() + n);
    cases++;
    if (next(str(start), n) !== str(want)) mismatches++;
  }
}
check(`calendar-day arithmetic on ${cases} cases`, mismatches, 0);

// ── Spike tasks (DF-D7) ───────────────────────────────────────
// Changed in DF1. Was: an uncompleted spike task was dropped only once its
// day had passed. Now no spike task is made, and any left uncompleted goes
// at the next rollover, on whatever date. Completed ones stay as history.
{
  const ahead = str(new Date(Date.now() + 3 * 86400000));
  const spike = (id, extra) => ({ id, title: 'SRS review — spike incoming (101 cards due)', source: 'srs_forecast',
    date: ahead, completed: false, recurrence: { type: 'none' }, ...extra });
  const tasks = [
    spike('future'),
    spike('pastDue', { date: '2026-01-05' }),
    spike('undated', { date: null }),
    spike('done', { completed: true, completedAt: '2026-01-05T10:00:00.000Z', date: '2026-01-05' }),
    spike('persistent', { persistent: true }),     // DF2: persistent ones go too
    { id: 'other', title: 'Laundry', date: ahead, completed: false, recurrence: { type: 'none' } },
  ];
  check('spike tasks: which count as left over', tasks.map(t => isMissedSpikeTask(t)), [true, true, true, false, true, false]);
  const res = runRecurrenceEngine(tasks, 3);
  const ids = (Array.isArray(res) ? res : res?.tasks || []).map(t => t.id);
  check('spike tasks: rollover drops the uncompleted ones, keeps the rest', ids, ['done', 'other']);
}

// The same engine in a zone with daylight saving.
const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
  encoding: 'utf8', env: { ...process.env, TZ: 'Europe/Amsterdam', RECUR_ZONE_CHECK: '1' },
});
let abroad = null;
try { abroad = JSON.parse(child.stdout.trim()); } catch { /* reported by the check below */ }
check('Amsterdam, across both clock changes', abroad,
  ['2026-10-26', '2026-10-27', '2026-10-31', '2027-03-29', '2027-03-30']);

console.log(`recurrence-golden: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
