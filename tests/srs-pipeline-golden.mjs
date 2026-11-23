// tests/srs-pipeline-golden.mjs
// Golden test for the daily review pipeline, src/utils/srsEngine.js
// (audit FS1, FS2): when it defers cards, what it writes, and that it never
// waits on the network.
//
// Run from the repo root:   node tests/srs-pipeline-golden.mjs   (or: npm test)
//
// The engine is bundled with Firebase replaced by a stand-in this file
// controls (see bundle-with-stub.mjs). No config, no network, no writes.
// Exits 1 on any failure.

import { bundleWithStub } from './bundle-with-stub.mjs';

const STUB = `
  export const db = {};
  export const doc = (_db, ...path) => ({ path: path.join('/') });
  export const getDoc    = (ref)       => globalThis.__fs.getDoc(ref);
  export const setDoc    = (ref, data) => globalThis.__fs.setDoc(ref, data);
  export const updateDoc = (ref, data) => globalThis.__fs.updateDoc(ref, data);
  export const serverTimestamp = () => ({ __serverTime: true });
`;
const { mod, cleanup } = await bundleWithStub('src/utils/srsEngine.js', STUB);
const { runDailyPipeline } = mod;

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`);
}
const quiet = async (fn) => {
  const keep = [console.error, console.warn]; console.error = () => {}; console.warn = () => {};
  try { return await fn(); } finally { [console.error, console.warn] = keep; }
};
// Resolves to 'stuck' if the pipeline is still waiting after 300 ms.
const settle = (p) => Promise.race([p, new Promise(r => setTimeout(() => r('stuck'), 300))]);

// A stand-in Firestore. mode: 'ok' | 'hang' (never answers, like a write
// made offline) | 'refuse'. plan: today's saved plan, 'none', or 'unreadable'.
function firestore({ mode = 'ok', plan = 'none', refuseIds = [] } = {}) {
  const log = { updates: [], sets: [], reads: 0 };
  const answer = (fn) => (mode === 'hang' ? new Promise(() => {}) : Promise.resolve().then(fn));
  globalThis.__fs = {
    getDoc: () => {
      log.reads++;
      if (plan === 'unreadable') return Promise.reject(Object.assign(new Error('client is offline'), { code: 'unavailable' }));
      return Promise.resolve(plan === 'none'
        ? { exists: () => false }
        : { exists: () => true, data: () => ({ pipelineOutput: plan }) });
    },
    updateDoc: (ref, data) => {
      log.updates.push({ id: ref.path.split('/').pop(), data });
      const id = ref.path.split('/').pop();
      return answer(() => { if (mode === 'refuse' || refuseIds.includes(id)) throw Object.assign(new Error('gone'), { code: 'not-found' }); });
    },
    setDoc: (ref, data) => { log.sets.push({ path: ref.path, data }); return answer(() => {}); },
  };
  return log;
}

// Cards, relative to the real today (day start 3 AM, as in the app).
const DSH = 3;
const dayISO = (offset) => {
  const d = new Date(); if (d.getHours() < DSH) d.setDate(d.getDate() - 1);
  d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset);
  return d.toISOString();
};
const dayStr = (offset) => {
  const d = new Date(dayISO(offset));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const seen = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
const card = (id, offset, extra = {}) => ({ id, type: 'vocab', state: 'review', due: dayISO(offset), difficulty: 5, stability: 10, lapses: 0, lastReview: seen(10), deckIds: ['d1'], ...extra });
const CARDS = [
  card('known', -1, { stability: 100, lastReview: seen(30) }),   // well known: first to be deferred
  card('known2', -4, { stability: 40, lastReview: seen(44) }),   // known, a little less sure
  card('shaky', -1, { stability: 3 }),                           // stability under 21: never deferred
  card('plainLate', -2),                                         // the same
  card('today', 0),
  card('tomorrow', 1),
  card('brandNew', -1, { state: 'new' }),
  { id: 'grammar', type: 'grammar', nextDueDate: '2020-01-01', state: 'review' },
];
// The pile is five cards (four overdue and today's). The cap decides the rest.
// DF-D7: no addTask / task list any more.
const run = (cards = CARDS, paused = [], cap = 3) => runDailyPipeline('u1', cards, DSH, paused, cap);

// 1. A day under the cap: nothing is moved, however overdue (SC-D1).
{
  const log = firestore();
  const out = await run(CARDS, [], 80);
  await new Promise(r => setTimeout(r, 0));
  check('under the cap: no card writes, plan saved', [out.triaged, log.updates.length, log.sets.length], [0, 0, 1]);
  check('under the cap: everything due stays due', [out.dueAtDayStart, [...out.dueCardIds].sort()],
    [5, ['known', 'known2', 'plainLate', 'shaky', 'today']]);
  const log5 = firestore();
  const out5 = await run(CARDS, [], 5);
  check('exactly at the cap: nothing is moved', [out5.triaged, log5.updates.length, out5.dueAtDayStart], [0, 0, 5]);
}

// 2. A day over the cap: just enough cards are deferred (SC-D2).
{
  const log = firestore();
  const out = await run(CARDS, [], 4);
  check('over by one: one card deferred, the best known', [out.triaged, log.updates.map(u => u.id)], [1, ['known']]);
}
{
  const log = firestore();
  const out = await run();
  await new Promise(r => setTimeout(r, 0));
  check('over by two: one write per deferred card, nothing for the others', log.updates.map(u => u.id), ['known', 'known2']);
  // updatedAt is the changed-at stamp every card write carries (OF-D2).
  // DF-D9 adds the deferral marks, deferredFor and deferredFrom.
  check('a deferred card gets a new due date, its due day, the deferral marks, the triage stamps and the changed-at stamp, nothing else',
    Object.keys(log.updates[0].data).sort(), ['deferredFor', 'deferredFrom', 'due', 'dueDay', 'dueDayFor', 'lastTriageDate', 'triageBucket', 'updatedAt']);
  check('the deferral marks: the new due, and the day it was due before',
    [log.updates[0].data.deferredFor === log.updates[0].data.due, log.updates[0].data.deferredFrom], [true, dayStr(-1)]);
  check('deferred onto the lightest days ahead (tomorrow already has a card)',
    log.updates.map(u => u.data.dueDay), [dayStr(2), dayStr(3)]);
  check('the plan is saved once', [log.sets.length, log.sets[0].path.startsWith('users/u1/dailyplan/')], [1, true]);
  check('triaged counts the deferred cards', [out.triaged, log.sets[0].data.pipelineOutput.triaged], [2, 2]);
  check('the caller gets the same updates to apply in memory', out.cardUpdates.map(u => u.id), ['known', 'known2']);
  check('card updates are not saved inside the plan', 'cardUpdates' in log.sets[0].data.pipelineOutput, false);
  check("the day's total is what is left after deferral", [out.dueAtDayStart, [...out.dueCardIds].sort()],
    [3, ['plainLate', 'shaky', 'today']]);
  // DF-D6: the 7-day look ahead is worked out live (deferralOutlook.js),
  // so the plan no longer carries it.
  check('the plan carries no forecast', Object.keys(log.sets[0].data.pipelineOutput).sort(),
    ['date', 'dueAtDayStart', 'dueCardIds', 'generatedAt', 'triaged']);
}
{
  const log = firestore();
  const out = await run(CARDS, [], 1);
  check('not enough cards that can wait: the pile stays over the cap', [out.triaged, log.updates.map(u => u.id), out.dueAtDayStart],
    [2, ['known', 'known2'], 3]);
}

// 3. Offline: writes never come back. The day's totals must not wait.
{
  const log = firestore({ mode: 'hang' });
  const out = await settle(run());
  check('offline: the pipeline still finishes', out === 'stuck' ? 'stuck' : out.triaged, 2);
  check('offline: the writes were started (Firestore queues them)', [log.updates.length, log.sets.length], [2, 1]);
}

// 4. Offline on a new day: today's plan can't be read.
await quiet(async () => {
  firestore({ mode: 'hang', plan: 'unreadable' });
  const out = await settle(run());
  check("unreadable plan: built from the cards in memory", out === 'stuck' ? 'stuck' : [out.triaged, out.dueAtDayStart], [2, 3]);
});

// 5. Already run today (here or on another device): use the saved plan.
{
  const saved = { date: 'x', triaged: 7, dueAtDayStart: 30 };
  const log = firestore({ plan: saved });
  const out = await run();
  check('saved plan returned as is, nothing written', [out, log.updates.length, log.sets.length], [saved, 0, 0]);
}

// 6. A card deleted on another device doesn't stop the rest.
await quiet(async () => {
  const log = firestore({ refuseIds: ['known'] });
  const out = await settle(run());
  await new Promise(r => setTimeout(r, 0));
  check('one refused write: the other card and the plan still go', [out.triaged, log.updates.map(u => u.id), log.sets.length], [2, ['known', 'known2'], 1]);
});

// 7. Paused decks and quiet days.
{
  const log = firestore();
  const out = await run(CARDS, ['d1']);
  check('cards whose every deck is paused are left out', [out.triaged, out.dueAtDayStart, log.updates.length], [0, 0, 0]);
  const log2 = firestore();
  const out2 = await run([card('today', 0), card('tomorrow', 1)]);
  check('nothing overdue and under the cap: no card writes, plan saved', [out2.triaged, log2.updates.length, log2.sets.length], [0, 0, 1]);
}

await cleanup();
console.log(`srs-pipeline-golden: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
