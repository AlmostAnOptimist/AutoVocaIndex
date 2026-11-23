// tests/fsrs-golden.mjs
// Golden test set for the flashcard scheduler, src/utils/fsrs.js.
//
// Run from the repo root:   node tests/fsrs-golden.mjs   (or: npm test)
//
// fsrs.js imports only dateUtils.js, so plain Node resolves it directly. The
// clock is pinned (a stand-in Date) and the zone is Asia/Seoul, so every
// expected date below is exact. Exits 1 on any failure.
//
// These cases record what the scheduler does today. When a scheduling rule
// changes on purpose, change its case here FIRST, with a note saying why.

process.env.TZ = 'Asia/Seoul';

const RealDate = Date;
let NOW = 0;
class PinnedDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
  static now() { return NOW; }
}
globalThis.Date = PinnedDate;
const at  = (iso) => { NOW = new RealDate(iso).getTime(); };
const ago = (days) => new RealDate(NOW - days * 86400000).toISOString();

const {
  AGAIN, HARD, GOOD, EASY, FSRS_DEFAULTS,
  fsrsGrade, isNewCard, isDueToday, getDueDateStr, logicalDueISO, logicalDayStr,
  buildDueLoad, spreadWindow, spreadInterval, planTriage, predictedRecall, planDueDayStamps, isDeferred,
} = await import('../src/utils/fsrs.js');

let pass = 0, fail = 0;
const stable = (v) => {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
};
function check(name, actual, expected) {
  const a = stable(actual), e = stable(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`);
}
// The parts of a grade result worth pinning: state, memory numbers, the day
// it lands on ('now' = due again in this session), and the counters.
// Every result must also carry the day as a plain date (dueDay, SC-D6) and
// it must be the same day the timestamp falls on here.
const today = () => logicalDayStr(0, 3);
const view = (u) => {
  const again = new RealDate(u.due).getTime() === NOW - 1000;
  const stamp = getDueDateStr({ due: u.due });
  if (u.dueDay !== (again ? today() : stamp) || u.dueDayFor !== u.due) {
    fail++;
    console.error(`FAIL  dueDay ${u.dueDay} / dueDayFor ${u.dueDayFor} do not match the due timestamp ${u.due}`);
  }
  return {
    state: u.state, s: u.stability, d: u.difficulty,
    due: again ? 'now' : stamp,
    lapses: u.lapses, reps: u.reps,
  };
};

// ── A new card's first review ─────────────────────────────────
at('2026-11-10T14:00:00+09:00');
const NEW = { state: 'new' };
check('new: Again -> learning, back in this session', view(fsrsGrade(NEW, AGAIN)),
  { state: 'learning', s: 0.4026, d: 7.1949, due: 'now', lapses: 1, reps: 1 });
check('new: Hard -> review tomorrow', view(fsrsGrade(NEW, HARD)),
  { state: 'review', s: 1.1839, d: 6.4883, due: '2026-11-11', lapses: 0, reps: 1 });
check('new: Good -> review tomorrow', view(fsrsGrade(NEW, GOOD)),
  { state: 'review', s: 3.173, d: 5.2824, due: '2026-11-11', lapses: 0, reps: 1 });
check('new: Easy -> review in 3 days', view(fsrsGrade(NEW, EASY)),
  { state: 'review', s: 15.6911, d: 3.2245, due: '2026-11-13', lapses: 0, reps: 1 });
check('new: graduating / easy interval settings',
  [getDueDateStr(fsrsGrade(NEW, GOOD, { graduatingInterval: 2, easyInterval: 5 })),
   getDueDateStr(fsrsGrade(NEW, EASY, { graduatingInterval: 2, easyInterval: 5 }))],
  ['2026-11-12', '2026-11-15']);
check('lastReview is the moment of grading', fsrsGrade(NEW, GOOD).lastReview, '2026-11-10T05:00:00.000Z');
check('input card is never changed', (() => { const c = { state: 'new' }; fsrsGrade(c, GOOD); return c; })(), { state: 'new' });
check('defaults', FSRS_DEFAULTS, { desiredRetention: 0.9, maximumInterval: 1095, graduatingInterval: 1, easyInterval: 3, againCap: 2 });

// ── A card in review, seen on its due day ─────────────────────
const REV = { state: 'review', stability: 10, difficulty: 5, lastReview: ago(10), lapses: 0, reps: 3 };
check('review: Again -> relearning', view(fsrsGrade(REV, AGAIN)),
  { state: 'relearning', s: 2.1077, d: 6.607, due: 'now', lapses: 1, reps: 4 });
check('review: Hard', view(fsrsGrade(REV, HARD)),
  { state: 'review', s: 15.3139, d: 5.7994, due: '2026-11-25', lapses: 0, reps: 4 });
check('review: Good', view(fsrsGrade(REV, GOOD)),
  { state: 'review', s: 32.9543, d: 4.9918, due: '2026-12-13', lapses: 0, reps: 4 });
check('review: Easy', view(fsrsGrade(REV, EASY)),
  { state: 'review', s: 78.6287, d: 4.1842, due: '2027-01-28', lapses: 0, reps: 4 });
check('review: seen 10 days late and still known -> a bigger gain', view(fsrsGrade({ ...REV, lastReview: ago(20) }, GOOD)),
  { state: 'review', s: 51.7649, d: 4.9918, due: '2027-01-01', lapses: 0, reps: 4 });
check('review: a lower retention target spaces further', getDueDateStr(fsrsGrade(REV, GOOD, { desiredRetention: 0.8 })), '2027-01-28');
const HUGE = { ...REV, stability: 2000, lastReview: ago(900) };
check('review: capped at the maximum interval (1095 days)', getDueDateStr(fsrsGrade(HUGE, GOOD)), '2029-11-09');
check('review: maximum interval setting', getDueDateStr(fsrsGrade(HUGE, GOOD, { maximumInterval: 365 })), '2027-11-10');

// ── Forgetting a mature card ──────────────────────────────────
const MATURE = { state: 'review', stability: 100, difficulty: 5, lastReview: ago(100), lapses: 1, reps: 9 };
const lapsed = fsrsGrade(MATURE, AGAIN);
check('mature: first Again uses the lapse formula (100 days -> about 6)', view(lapsed),
  { state: 'relearning', s: 5.9551, d: 6.607, due: 'now', lapses: 2, reps: 10 });
const RELEARN = { ...MATURE, ...lapsed, lastReview: ago(10 / 1440) }; // seen again 10 minutes later
// Audit FS3, changed in B2b (SC-D4). Was: a second Again dropped the card to
// the new-card floor (0.4026). Now each further Again halves what is left.
const again2 = fsrsGrade(RELEARN, AGAIN);
check('relearning: a second Again halves the stability', view(again2),
  { state: 'relearning', s: 2.9837, d: 7.6875, due: 'now', lapses: 3, reps: 11 });
const again3 = fsrsGrade({ ...RELEARN, ...again2 }, AGAIN);
check('relearning: a third halves it again', again3.stability, 1.4949);
let floor = { ...RELEARN, ...again2 };
for (let i = 0; i < 8; i++) floor = { ...floor, ...fsrsGrade(floor, AGAIN) };
check('relearning: never below the floor', floor.stability, 0.4026);
check('relearning: Good after two Agains builds on the halved value', view(fsrsGrade({ ...RELEARN, ...again2 }, GOOD)).state, 'review');
check('relearning: Good -> back to review', view(fsrsGrade(RELEARN, GOOD)),
  { state: 'review', s: 6.1546, d: 6.5914, due: '2026-11-16', lapses: 2, reps: 11 });
check('relearning: Easy', view(fsrsGrade(RELEARN, EASY)),
  { state: 'review', s: 6.6257, d: 6.0434, due: '2026-11-17', lapses: 2, reps: 11 });

// ── A card still being learned ────────────────────────────────
const LEARN = { state: 'learning', stability: 0.4026, difficulty: 7.1949, lastReview: ago(10 / 1440), lapses: 1, reps: 1 };
check('learning: Again stays in learning', view(fsrsGrade(LEARN, AGAIN)),
  { state: 'learning', s: 0.4026, d: 8.0828, due: 'now', lapses: 2, reps: 2 });
check('learning: Good graduates', view(fsrsGrade(LEARN, GOOD)),
  { state: 'review', s: 0.6349, d: 7.1766, due: '2026-11-11', lapses: 1, reps: 2 });
// Every Again press is a lapse, in any state.
check('lapses: every Again counts; other grades never do',
  [fsrsGrade(NEW, AGAIN).lapses, fsrsGrade(LEARN, AGAIN).lapses, fsrsGrade(RELEARN, AGAIN).lapses, fsrsGrade(REV, AGAIN).lapses,
   fsrsGrade(REV, HARD).lapses, fsrsGrade(REV, GOOD).lapses, fsrsGrade(REV, EASY).lapses],
  [1, 2, 3, 1, 0, 0, 0]);

// ── The logical day (bug sweep T1) ────────────────────────────
at('2026-11-11T01:30:00+09:00'); // still logical Nov 10 with a 3 AM day start
check('1:30 AM, day start 3: tomorrow is Nov 11', getDueDateStr(fsrsGrade(NEW, GOOD, {}, 3)), '2026-11-11');
check('1:30 AM, day start 0: tomorrow is Nov 12', getDueDateStr(fsrsGrade(NEW, GOOD, {}, 0)), '2026-11-12');
check('logicalDueISO is local midnight of the day', logicalDueISO(1, 3), '2026-11-10T15:00:00.000Z');
check('isDueToday: due on the logical day or before',
  [isDueToday({ state: 'review', due: '2026-11-09T15:00:00.000Z' }, 3),   // Nov 10
   isDueToday({ state: 'review', due: '2026-11-10T15:00:00.000Z' }, 3),   // Nov 11: not yet at 1:30 AM
   isDueToday({ state: 'review', due: '2026-11-10T15:00:00.000Z' }, 0),   // Nov 11 with a midnight day start
   isDueToday({ state: 'review', nextDueDate: '2026-11-10' }, 3),
   isDueToday({ state: 'new', due: '2026-11-01T15:00:00.000Z' }, 3),
   isDueToday({ state: 'review' }, 3)],
  [true, false, true, true, false, false]);

// ── Small helpers ─────────────────────────────────────────────
check('isNewCard',
  [isNewCard({ state: 'new' }), isNewCard({ state: 'review' }), isNewCard({}), isNewCard({ reps: 2 }),
   isNewCard({ lastGrade: 3 }), isNewCard({ lastReviewed: '2026-01-01' })],
  [true, false, true, false, false, false]);
check('getDueDateStr: timestamp -> local day; plain date as is; none',
  [getDueDateStr({ due: '2026-11-10T15:00:00.000Z' }), getDueDateStr({ nextDueDate: '2026-11-20' }),
   getDueDateStr({ due: '2026-11-12T15:00:00.000Z', nextDueDate: '2026-01-01' }), getDueDateStr({})],
  ['2026-11-11', '2026-11-20', '2026-11-13', null]);

// ── The due day as a plain date (SC-D6, audit FS9) ────────────
at('2026-11-10T14:00:00+09:00');
const KST = (day) => new RealDate(`${day}T00:00:00+09:00`).toISOString(); // midnight in Korea
const paired = (day, extra = {}) => ({ state: 'review', due: KST(day), dueDay: day, dueDayFor: KST(day), ...extra });
check('getDueDateStr: a current dueDay is read first',
  [getDueDateStr({ due: KST('2026-11-11'), dueDay: '2026-11-20', dueDayFor: KST('2026-11-11') }),
   getDueDateStr(paired('2026-11-11'))],
  ['2026-11-20', '2026-11-11']);
// `due` changed by something that doesn't know about dueDay (a tab still on
// older code): the dueDay left behind is out of date and must not be used.
check('getDueDateStr: a dueDay written for a different due date is ignored',
  [getDueDateStr({ due: KST('2026-12-01'), dueDay: '2026-11-11', dueDayFor: KST('2026-11-11') }),
   getDueDateStr({ due: KST('2026-12-01'), dueDay: '2026-11-11' }),
   getDueDateStr({ due: null, nextDueDate: '2026-11-20', dueDay: '2026-11-11', dueDayFor: KST('2026-11-11') }),
   getDueDateStr({ due: KST('2026-12-01'), dueDay: 'bad', dueDayFor: KST('2026-12-01') })],
  ['2026-12-01', '2026-12-01', '2026-11-20', '2026-12-01']);
check('grade results carry dueDay', [fsrsGrade(NEW, GOOD).dueDay, fsrsGrade(NEW, AGAIN).dueDay, fsrsGrade(REV, GOOD).dueDay],
  ['2026-11-11', '2026-11-10', '2026-12-13']);
check('a graded card reads back on its due day', getDueDateStr({ ...REV, ...fsrsGrade(REV, GOOD) }), '2026-12-13');
// A card graded in Korea, due Nov 12 there, read on a trip to Amsterdam on
// the morning of Nov 11. The timestamp alone reads as Nov 11 (a day early,
// every day of the trip); the plain date reads the same anywhere.
{
  const graded = paired('2026-11-12');
  const old    = { state: 'review', due: KST('2026-11-12') };
  process.env.TZ = 'Europe/Amsterdam';
  at('2026-11-11T09:00:00+01:00');
  check('abroad: timestamp alone is a day early; dueDay is not',
    [getDueDateStr(old), isDueToday(old, 3), getDueDateStr(graded), isDueToday(graded, 3)],
    ['2026-11-11', true, '2026-11-12', false]);
  process.env.TZ = 'Asia/Seoul';
  at('2026-11-10T14:00:00+09:00');
}
check('stamp: one write per reviewed card whose timestamp has no current dueDay',
  planDueDayStamps([
    { id: 'ts', state: 'review', due: KST('2026-11-11') },
    { id: 'again', state: 'relearning', due: '2026-11-08T03:00:00.000Z' },
    { id: 'stale', state: 'review', due: KST('2026-12-01'), dueDay: '2026-11-11', dueDayFor: KST('2026-11-11') },
    { id: 'done', ...paired('2026-11-11') },
    { id: 'sm2', nextDueDate: '2026-12-01', reps: 3 },
    { id: 'plain', state: 'review', due: '2026-12-01' },
    { id: 'new', state: 'new', due: KST('2026-11-01') },
    { id: 'gram', type: 'grammar', state: 'review', due: KST('2026-11-20') },
    { id: 'none', state: 'review' },
    { id: 'junk', state: 'review', due: 'not a date at all' },
    null,
  ]),
  [{ id: 'ts', dueDay: '2026-11-11', dueDayFor: KST('2026-11-11') },
   { id: 'again', dueDay: '2026-11-08', dueDayFor: '2026-11-08T03:00:00.000Z' },
   { id: 'stale', dueDay: '2026-12-01', dueDayFor: KST('2026-12-01') }]);
check('stamp: a stamped card reads the same day as before',
  (() => { const c = { id: 'ts', state: 'review', due: KST('2026-11-11') }; const [st] = planDueDayStamps([c]); return [getDueDateStr(c), getDueDateStr({ ...c, ...st })]; })(),
  ['2026-11-11', '2026-11-11']);
check('stamp: nothing to do, bad input', [planDueDayStamps([]), planDueDayStamps(undefined)], [[], []]);

// ── Spreading intervals over lighter days (SC-D5, audit FS7) ──
at('2026-11-10T14:00:00+09:00');
check('spread window: 5% of the interval, 1 to 7 days, nothing under a week',
  [1, 6, 7, 10, 30, 50, 100, 140, 400].map(spreadWindow), [0, 0, 1, 1, 2, 3, 5, 7, 7]);
const loadOf = (obj) => new Map(Object.entries(obj));
check('spread: no load map -> the computed interval', [spreadInterval(33), spreadInterval(33, null)], [33, 33]);
check('spread: every day equal -> the computed day', spreadInterval(33, loadOf({})), 33);
// 33 days from Nov 10 is Dec 13; the window is Dec 11 to Dec 15.
check('spread: moves to the lightest day in the window',
  spreadInterval(33, loadOf({ '2026-12-11': 4, '2026-12-12': 2, '2026-12-13': 9, '2026-12-14': 3, '2026-12-15': 1 })), 35);
check('spread: tie -> the day closest to the computed one',
  spreadInterval(33, loadOf({ '2026-12-11': 0, '2026-12-12': 5, '2026-12-13': 9, '2026-12-14': 0, '2026-12-15': 0 })), 34);
check('spread: tie at the same distance -> the earlier day',
  spreadInterval(33, loadOf({ '2026-12-11': 5, '2026-12-12': 1, '2026-12-13': 9, '2026-12-14': 1, '2026-12-15': 5 })), 32);
check('spread: days outside the window are ignored',
  spreadInterval(33, loadOf({ '2026-12-11': 3, '2026-12-12': 3, '2026-12-13': 3, '2026-12-14': 3, '2026-12-15': 3, '2026-12-10': 0, '2026-12-16': 0 })), 33);
check('spread: a short interval is never moved', spreadInterval(6, loadOf({ '2026-11-16': 99 })), 6);
check('spread: never past the maximum interval',
  spreadInterval(1095, loadOf({ '2029-11-09': 50 })) <= 1095, true);
{
  const busy = loadOf({ '2026-12-12': 6, '2026-12-13': 40, '2026-12-14': 6 });
  const plain = fsrsGrade(REV, GOOD), spread = fsrsGrade(REV, GOOD, {}, 3, busy);
  check('grade with a load map: lands on a lighter day nearby', [plain.dueDay, view(spread).due, spread.dueDay], ['2026-12-13', '2026-12-11', '2026-12-11']);
  check('grade with a load map: memory numbers are untouched', [spread.stability, spread.difficulty], [plain.stability, plain.difficulty]);
  check('grade with a load map: tomorrow stays tomorrow', fsrsGrade(NEW, GOOD, {}, 3, loadOf({ '2026-11-11': 500 })).dueDay, '2026-11-11');
  check('grade with a load map: Again is still due now', view(fsrsGrade(REV, AGAIN, {}, 3, busy)).due, 'now');
}
check('load: reviewed cards by due day; not new, grammar or skipped cards',
  [...buildDueLoad([
    { id: 'a', ...paired('2026-11-12') },
    { id: 'b', state: 'review', due: '2026-11-11T15:00:00.000Z' },
    { id: 'c', state: 'relearning', due: '2026-11-08T03:00:00.000Z' },
    { id: 'n', state: 'new', nextDueDate: '2026-11-12' },
    { id: 'g', type: 'grammar', state: 'review', nextDueDate: '2026-11-12' },
    { id: 'p', ...paired('2026-11-12'), paused: true },
    { id: 'x', state: 'review' },
  ], c => c.paused)].sort(),
  [['2026-11-08', 1], ['2026-11-12', 2]]);

// ── Triage (SC-D1 to SC-D3, audit FS1) ────────────────────────
// Changed in B2b. Was: every overdue card that was easy and stable moved out
// by 70% of its stability, on any day. Now: only on a day over the cap, only
// as many cards as needed, and no further than 15% of stability (21 days).
const rc = (id, stability, daysAgo, extra = {}) =>
  ({ id, state: 'review', stability, difficulty: 5, lastReview: ago(daysAgo), due: '2026-11-09T15:00:00.000Z', ...extra });
check('recall: the chance a card is remembered today',
  [predictedRecall(rc('a', 100, 100)), predictedRecall(rc('b', 100, 10)), predictedRecall(rc('c', 30, 60))].map(n => +n.toFixed(4)),
  [0.9, 0.9885, 0.825]);
const PILE = [
  rc('fresh', 100, 20),                       // most likely remembered
  rc('ontime', 100, 100),
  rc('stale', 30, 60),                        // least likely of the eligible
  rc('young', 20, 20),                        // stability under 21: never deferred
  rc('relearn', 60, 1, { state: 'relearning' }),
  rc('learn', 0.4, 0, { state: 'learning' }),
  { id: 'sm2', easeFactor: 2.5, repetitions: 5, interval: 40, nextDueDate: '2026-11-09' },
];
check('triage: a pile at or under the cap is left alone',
  [planTriage(PILE, { cap: 7 }), planTriage(PILE, { cap: 80 }), planTriage([], { cap: 80 }), planTriage(undefined, { cap: 80 })], [[], [], [], []]);
check('triage: over by one -> one card, the most likely remembered', planTriage(PILE, { cap: 6 }).map(u => u.id), ['fresh']);
check('triage: over by two -> the two most likely', planTriage(PILE, { cap: 5 }).map(u => u.id), ['fresh', 'ontime']);
check('triage: cards being learned, relearned or young are never moved; the pile can stay over the cap',
  planTriage(PILE, { cap: 1 }).map(u => u.id), ['fresh', 'ontime', 'stale']);
// Changed in DF1: a deferral also marks the card (deferredFor, deferredFrom; DF-D9).
check('triage: what is written (due day moves; memory numbers do not)', planTriage(PILE, { cap: 6 })[0],
  { id: 'fresh', due: '2026-11-10T15:00:00.000Z', dueDay: '2026-11-11', dueDayFor: '2026-11-10T15:00:00.000Z',
    deferredFor: '2026-11-10T15:00:00.000Z', deferredFrom: '2026-11-10', triageBucket: 'defer', lastTriageDate: '2026-11-10' });
check('triage: deferred cards fill the next days one by one when those days are empty',
  planTriage(PILE, { cap: 4 }).map(u => u.dueDay), ['2026-11-11', '2026-11-12', '2026-11-13']);
// How far: 15% of stability, 1 to 21 days, onto the lightest day in reach.
const reach = (stability, load) => planTriage([rc('c', stability, 5)], { cap: 0, dueLoad: load })[0].dueDay;
const full  = (days, n) => { const m = new Map(); for (let d = 1; d <= days; d++) m.set(logicalDayStr(d, 3), n); return m; };
check('triage: reach is 15% of stability (21 days -> 3, 100 -> 15, 400 -> 21)',
  [reach(21, full(2, 9)), reach(21, full(3, 9)), reach(100, full(14, 9)), reach(100, full(15, 9)), reach(400, full(20, 9)), reach(400, full(30, 9))],
  ['2026-11-13', '2026-11-11', '2026-11-25', '2026-11-11', '2026-12-01', '2026-11-11']);
check('triage: picks the lightest day in reach, the earliest on a tie',
  reach(100, loadOf({ '2026-11-11': 30, '2026-11-12': 12, '2026-11-13': 40, '2026-11-14': 12 })), '2026-11-15');
check('triage: the load map passed in is not changed',
  (() => { const m = loadOf({ '2026-11-11': 3 }); planTriage(PILE, { cap: 4, dueLoad: m }); return [...m]; })(), [['2026-11-11', 3]]);
check('triage: equal recall -> higher stability first, then id',
  planTriage([rc('b', 50, 50), rc('a', 50, 50), rc('z', 100, 100)], { cap: 0 }).map(u => u.id), ['z', 'a', 'b']);

// ── Planning a later day (DF-D2) ──────────────────────────────
// The deferral notices run planTriage as if the clock were `offset` days on.
// It must give exactly what the real run gives on that day.
{
  const LOAD = loadOf({ '2026-11-12': 4, '2026-11-13': 1, '2026-11-14': 6, '2026-11-16': 2 });
  const ahead = (offset) => planTriage(PILE, { cap: 2, dueLoad: LOAD, offset });
  const a1 = ahead(1), a3 = ahead(3);
  at('2026-11-11T14:00:00+09:00');
  const r1 = planTriage(PILE, { cap: 2, dueLoad: LOAD });
  at('2026-11-13T14:00:00+09:00');
  const r3 = planTriage(PILE, { cap: 2, dueLoad: LOAD });
  at('2026-11-10T14:00:00+09:00');
  check('offset 1 = the real run tomorrow (cards, days, stamps)', a1, r1);
  check('offset 3 = the real run three days on (recall moves with it, so the order can change)', a3, r3);
  check('offset 0 is the real run today', planTriage(PILE, { cap: 2, dueLoad: LOAD, offset: 0 }), planTriage(PILE, { cap: 2, dueLoad: LOAD }));
  check('an offset lands deferrals after its own day', a1.every(u => u.dueDay > '2026-11-11') && a1.every(u => u.lastTriageDate === '2026-11-11'), true);
}

// ── Deferred cards (DF-D9) ────────────────────────────────────
{
  const base = rc('d', 100, 20);
  const [u] = planTriage([base], { cap: 0 });
  const { id: _id, ...fields } = u;
  const deferred = { ...base, ...fields, type: 'vocab' };
  check('a deferred card counts as deferred', isDeferred(deferred, 3), true);
  // Deferred again when it comes due, before being reviewed: the first day stays.
  at(`${deferred.dueDay}T14:00:00+09:00`);
  check('once due again it is no longer "deferred" (it is in the due pile)', isDeferred(deferred, 3), false);
  const [again] = planTriage([deferred], { cap: 0 });
  check('deferred a second time: deferredFrom keeps the first day', [again.deferredFrom, again.deferredFor === again.due], ['2026-11-10', true]);
  at('2026-11-10T14:00:00+09:00');
  const graded = { ...deferred, ...fsrsGrade(deferred, GOOD, {}, 3) };
  check('a grade ends it', isDeferred(graded, 3), false);
  check('a change to due alone ends it (a tab running older code)', isDeferred({ ...deferred, due: '2026-11-30T15:00:00.000Z' }, 3), false);
  check('a review on or after the deferral day ends it, even if due happens to match',
    isDeferred({ ...deferred, lastReview: '2026-11-10T06:00:00.000Z' }, 3), false);
  check('never for new or grammar cards, or a card never deferred',
    [isDeferred({ ...deferred, state: 'new' }, 3), isDeferred({ ...deferred, type: 'grammar' }, 3), isDeferred(base, 3)], [false, false, false]);
  check('older triage stamps alone do not count (no deferredFor)',
    isDeferred({ ...base, due: '2026-12-30T15:00:00.000Z', triageBucket: 'defer', lastTriageDate: '2026-10-01' }, 3), false);
}

console.log(`fsrs-golden: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
