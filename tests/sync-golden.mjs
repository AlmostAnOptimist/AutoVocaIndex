// tests/sync-golden.mjs
// Golden test for the task and settings sync, src/hooks/useFirestore.js:
//   - what a load returns (new user, failure, repaired tasks),
//   - the three-way merge used when the server copy arrives (bug sweep S1,
//     audit SY1 and SY2), at startup and on a refresh,
//   - what a save writes to Firestore, and what happens when a task it
//     writes to was deleted on another device,
//   - the hook that ties these together (useFirestoreSync).
// Decisions SY-D1 to SY-D5.
//
// Run from the repo root:   node tests/sync-golden.mjs   (or: npm test)
// Firebase and React are replaced by stand-ins (bundle-with-stub.mjs);
// nothing here reads or writes Firestore. Exits 1 on any failure.

import { bundleWithStub } from './bundle-with-stub.mjs';

process.env.TZ = 'Asia/Seoul';

// Just enough of React to call the hook once as a plain function: refs and
// callbacks keep their identity, effects are collected and not run.
const REACT = `
  export const useRef = (v) => ({ current: v });
  export const useCallback = (f) => f;
  export const useEffect = (f) => { (globalThis.__effects ||= []).push(f); };
`;
const { mod, cleanup } = await bundleWithStub('src/hooks/useFirestore.js', `
  export const db = {};
  export const collection = (_db, ...path) => ({ path: path.join('/') });
  export const doc = (_db, ...path) => ({ path: path.join('/') });
  export const getDocs = (ref) => globalThis.__fs.getDocs(ref);
  export const setDoc = (ref, data, opts) => globalThis.__fs.setDoc(ref, data, opts);
  export const updateDoc = (ref, ...rest) => globalThis.__fs.updateDoc(ref, ...rest);
  export const deleteDoc = (ref) => globalThis.__fs.deleteDoc(ref);
  export const writeBatch = () => globalThis.__fs.writeBatch();
  export const deleteField = () => ({ __delete: true });
  export class FieldPath { constructor(...parts) { this.parts = parts; } }
`, { react: REACT });
const {
  firestoreLoad, mergeTasks, mergeSettings, mergeRemoteData, mergeBootEdits, planRemoteRefresh,
  firestoreWriteTasksNow, firestoreWriteTaskFields, useFirestoreSync,
} = mod;

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`);
}
async function quiet(fn) {
  const { error, warn } = console;
  console.error = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.error = error; console.warn = warn; }
}
const tick = () => new Promise(r => setTimeout(r, 0));

// A stand-in Firestore.
//   collections  { 'users/u1/tasks': [...docs] } for reads
//   missing      task ids that no longer exist: an update to one is refused
//                with not-found, and a batch holding one is refused whole
//   failCommit   every batch is refused with a different error
// Field updates arrive as (FieldPath, value, FieldPath, value, ...) and are
// logged as { field: value }; a removed field shows as { __delete: true }.
function firestore(collections = {}, { failRead = false, failCommit = false, missing = [] } = {}) {
  const log = { batches: [], singles: [], sets: [] };
  const fields = (rest) => {
    const out = {};
    for (let i = 0; i < rest.length; i += 2) out[rest[i].parts.join('.')] = rest[i + 1];
    return out;
  };
  const isMissing = (path) => missing.includes(path.split('/').pop());
  const notFound = () => Object.assign(new Error('No document to update'), { code: 'not-found' });
  globalThis.__fs = {
    getDocs: (ref) => failRead
      ? Promise.reject(new Error('unavailable'))
      : Promise.resolve({ docs: (collections[ref.path] || []).map(({ id, ...data }) => ({ id, data: () => data })) }),
    setDoc: async (ref, data, opts) => {
      if (ref.path.includes('/tasks/')) log.singles.push({ op: 'set', path: ref.path, data });
      else log.sets.push({ path: ref.path, data, opts });
    },
    updateDoc: async (ref, ...rest) => {
      if (isMissing(ref.path)) throw notFound();
      log.singles.push({ op: 'update', path: ref.path, data: fields(rest) });
    },
    deleteDoc: async (ref) => { log.singles.push({ op: 'delete', path: ref.path }); },
    writeBatch: () => {
      const ops = [];
      return {
        set:    (ref, data)    => ops.push({ op: 'set',    path: ref.path, data }),
        update: (ref, ...rest) => ops.push({ op: 'update', path: ref.path, data: fields(rest) }),
        delete: (ref)          => ops.push({ op: 'delete', path: ref.path }),
        commit: async () => {
          if (failCommit) throw new Error('refused');
          if (ops.some(o => o.op === 'update' && isMissing(o.path))) throw notFound();
          log.batches.push(ops.slice());
        },
      };
    },
  };
  return log;
}
const T = (id, extra = {}) => ({ id, title: `Task ${id}`, category: 'life', completed: false, ...extra });
const GONE = { __delete: true };

// ── 1. Load ───────────────────────────────────────────────────
{
  firestore({});
  check('load: no tasks and no settings is a new user (null)', await firestoreLoad('u1'), null);
  firestore({ 'users/u1/tasks': [T('a')], 'users/u1/settings': [{ id: 'main', theme: 'ember' }, { id: 'other', x: 1 }] });
  check('load: tasks and the main settings doc', await firestoreLoad('u1'),
    { tasks: [T('a')], settings: { theme: 'ember' }, repairedTaskIds: [] });
  firestore({ 'users/u1/tasks': [T('a')] });
  check('load: tasks without settings', (await firestoreLoad('u1')).settings, null);
  // N1: render-only markers saved onto a task by mistake are dropped on every load.
  firestore({ 'users/u1/tasks': [T('a', { _dateOcc: true }), T('b')], 'users/u1/settings': [{ id: 'main' }] });
  const repaired = await firestoreLoad('u1');
  check('load: render-only markers are stripped and the task is named for repair',
    [repaired.tasks, repaired.repairedTaskIds], [[T('a'), T('b')], ['a']]);
  await quiet(async () => {
    firestore({}, { failRead: true });
    check("load: a failed read is 'error', never null", await firestoreLoad('u1'), 'error');
  });
}

// ── 2. Merging tasks: local (on screen), remote (just read), base (last saved) ──
// Changed in B3b (SY-D2, SY-D3). Was: a task edited here won whole, and an
// edit here brought back a task deleted on another device.
{
  const base = [T('a'), T('b'), T('c')];
  check('merge: nothing changed here -> the remote copy, in local order',
    mergeTasks(base, [T('c', { title: 'C2' }), T('a'), T('b')], base), [T('a'), T('b'), T('c', { title: 'C2' })]);
  check('merge: a field edited here and not yet saved wins',
    mergeTasks([T('a', { title: 'mine' }), T('b'), T('c')], [T('a', { title: 'theirs' }), T('b'), T('c')], base),
    [T('a', { title: 'mine' }), T('b'), T('c')]);
  check('merge: renamed here, ticked there -> renamed and ticked',
    mergeTasks([T('a', { title: 'mine' })], [T('a', { completed: true, completedAt: 'x' })], [T('a')]),
    [T('a', { title: 'mine', completed: true, completedAt: 'x' })]);
  check('merge: a field removed here stays removed; one removed there goes',
    mergeTasks(
      [{ id: 'a', title: 'Task a', notes: 'n', date: '2026-11-12' }, T('b', { time: '09:00' })],
      [T('a', { notes: 'n', date: '2026-11-12' }), { id: 'b', title: 'Task b', category: 'life', completed: false }],
      [T('a', { notes: 'n', date: '2026-11-12' }), T('b', { time: '09:00' })]),
    // a: category and completed were removed here; b: time was removed there
    [{ id: 'a', title: 'Task a', notes: 'n', date: '2026-11-12' }, T('b')]);
  check('merge: a field added there comes in beside an edit here',
    mergeTasks([T('a', { title: 'mine' })], [T('a', { notes: 'theirs' })], [T('a')]), [T('a', { title: 'mine', notes: 'theirs' })]);
  check('merge: a nested value changed here replaces the whole value',
    mergeTasks([T('a', { recurrence: { type: 'weekly', days: [1] } })], [T('a', { recurrence: { type: 'daily', n: 2 } })], [T('a', { recurrence: { type: 'daily' } })]),
    [T('a', { recurrence: { type: 'weekly', days: [1] } })]);
  check('merge: key order alone is not a change',
    mergeTasks([{ title: 'Task a', id: 'a', category: 'life', completed: false }], [T('a', { title: 'theirs' })], [T('a')]),
    [T('a', { title: 'theirs' })]);
  check('merge: a task added on another device comes in, at the end',
    mergeTasks(base, [...base, T('d')], base), [...base, T('d')]);
  check('merge: a task deleted on another device goes',
    mergeTasks(base, [T('a'), T('c')], base), [T('a'), T('c')]);
  check('merge: a task deleted on another device stays deleted, even if edited here',
    mergeTasks([T('a', { title: 'mine' }), T('b')], [T('b')], [T('a'), T('b')]), [T('b')]);
  check('merge: a task added here and not yet saved stays',
    mergeTasks([...base, T('new')], base, base), [...base, T('new')]);
  check('merge: a task deleted here and not yet saved stays deleted, even if edited there',
    mergeTasks([T('a'), T('c')], [T('a'), T('b', { title: 'theirs' }), T('c')], base), [T('a'), T('c')]);
  const remoteA = T('a', { title: 'theirs' });
  check('merge: an untouched task is the remote object itself',
    mergeTasks([T('a')], [remoteA], [T('a')])[0] === remoteA, true);
}

// ── 3. Merging settings, key by key ───────────────────────────
{
  const base = { theme: 'ember', dayStartHour: 3, weightUnit: 'kg' };
  check('settings: a key changed here wins; others take remote; new remote keys come in',
    mergeSettings({ ...base, theme: 'clay' }, { ...base, dayStartHour: 4, aviNoise: ['x'] }, base),
    { theme: 'clay', dayStartHour: 4, weightUnit: 'kg', aviNoise: ['x'] });
  check('settings: a key removed here stays removed; one removed remotely goes',
    [mergeSettings({ theme: 'ember', dayStartHour: 3 }, base, base), mergeSettings(base, { theme: 'ember' }, base)],
    [{ theme: 'ember', dayStartHour: 3 }, { theme: 'ember' }]);
  check('settings: no remote settings -> local as is', mergeSettings(base, null, base), base);
}

// ── 4. The whole merge, and a refresh ─────────────────────────
{
  const local  = { tasks: [T('a', { title: 'mine' }), T('b')], settings: { theme: 'clay' }, extra: 1 };
  const remote = { tasks: [T('a', { notes: 'n' }), T('b', { completed: true }), T('c')], settings: { theme: 'ember', dayStartHour: 4 } };
  const base   = { tasks: [T('a'), T('b')], settings: { theme: 'ember' } };
  check('mergeRemoteData: with a base, three-way', mergeRemoteData(local, remote, base),
    { tasks: [T('a', { title: 'mine', notes: 'n' }), T('b', { completed: true }), T('c')], settings: { theme: 'clay', dayStartHour: 4 }, extra: 1 });
  check('mergeRemoteData: without a base, remote replaces local', mergeRemoteData(local, remote, null),
    { tasks: remote.tasks, settings: remote.settings, extra: 1 });
  check('mergeRemoteData: without a base or remote settings, local settings stay',
    mergeRemoteData(local, { tasks: [] }, null).settings, { theme: 'clay' });

  const roll = (tasks) => ({ tasks: tasks.map(t => (t.id === 'c' ? { ...t, rolled: true } : t)), changed: true });
  const plan = planRemoteRefresh({ local, remote, base, runEngine: roll });
  check('refresh: merged, then the engine run on the result',
    [plan.changed, plan.next.tasks.map(t => [t.id, t.title, !!t.rolled]), plan.merged.tasks.some(t => t.rolled)],
    [true, [['a', 'mine', false], ['b', 'Task b', false], ['c', 'Task c', true]], false]);
  check('refresh: the server view is what was read, untouched', plan.serverView, { tasks: remote.tasks, settings: remote.settings });
  let seenDsh = null;
  const still = planRemoteRefresh({ local, remote, base, runEngine: (tasks, dsh) => { seenDsh = dsh; return { tasks, changed: false }; } });
  check('refresh: nothing rolled -> next is the merge itself; the engine gets the merged day start',
    [still.next === still.merged, seenDsh], [true, 4]);
}

// ── 5. Startup: the server copy arrives (SY-D1) ───────────────
// opened = the device's saved copy as the app first showed it;
// screen = what is on screen when the server copy lands;
// server = the server copy (after the recurrence engine).
// Changed in B3b. Was: the server copy replaced the screen, so a task ticked
// while it loaded came unticked.
{
  // The device's copy is a week old: 'a' has an old date, 'old' was deleted
  // on the phone since, and the phone added 'new'.
  const opened = { tasks: [T('a', { date: '2026-11-05' }), T('b'), T('old')], settings: { theme: 'ember', dayStartHour: 3 }, leftover: 1 };
  const server = { tasks: [T('a', { date: '2026-11-12' }), T('b', { notes: 'from the phone' }), T('new')], settings: { theme: 'ember', dayStartHour: 4 } };
  check('startup: nothing touched -> exactly the server copy', mergeBootEdits(opened, server, opened), server);
  check('startup: an untouched screen that is a different object is still the server copy',
    mergeBootEdits(JSON.parse(JSON.stringify(opened)), server, opened), { settings: server.settings, tasks: server.tasks });

  const ticked = { ...opened, tasks: [T('a', { date: '2026-11-05', completed: true, completedAt: 'now' }), T('b'), T('old')] };
  check('startup: a task ticked while loading stays ticked; its old date does not come back',
    mergeBootEdits(ticked, server, opened).tasks,
    [T('a', { date: '2026-11-12', completed: true, completedAt: 'now' }), T('b', { notes: 'from the phone' }), T('new')]);
  check('startup: everything merely old on the device still loses',
    mergeBootEdits(ticked, server, opened).tasks.some(t => t.id === 'old' || t.date === '2026-11-05'), false);
  const added = { ...opened, tasks: [...opened.tasks, T('mine')] };
  check('startup: a task added while loading is kept',
    mergeBootEdits(added, server, opened).tasks.map(t => t.id), ['a', 'b', 'mine', 'new']);
  const editedOld = { ...opened, tasks: [T('a', { date: '2026-11-05' }), T('b'), T('old', { title: 'edited' })] };
  check('startup: an edit to a task deleted on another device is dropped with it',
    mergeBootEdits(editedOld, server, opened).tasks.map(t => t.id), ['a', 'b', 'new']);
  const deleted = { ...opened, tasks: [T('a', { date: '2026-11-05' }), T('old')] };
  check('startup: a task deleted while loading stays deleted',
    mergeBootEdits(deleted, server, opened).tasks.map(t => t.id), ['a', 'new']);
  const themed = { ...opened, settings: { ...opened.settings, theme: 'clay' } };
  check('startup: a setting changed while loading wins; the others take the server value',
    mergeBootEdits(themed, server, opened).settings, { theme: 'clay', dayStartHour: 4 });
  check('startup: only tasks and settings come out (as before)',
    Object.keys(mergeBootEdits(ticked, server, opened)).sort(), ['settings', 'tasks']);
  // A second load in the same session has no opening copy to compare with.
  check('startup: without an opening copy, the server copy replaces the screen', mergeBootEdits(ticked, server, null), server);
}

// ── 6. What a save writes (SY-D4) ─────────────────────────────
// Changed in B3b. Was: a changed task was written as a whole document, so
// fields changed on another device since this copy was read were put back.
{
  const prev = [T('a'), T('b'), T('c')];
  const log = firestore();
  check('save: nothing changed -> nothing written, nothing gone', [await firestoreWriteTasksNow('u1', prev, prev), log.batches], [[], []]);

  const log2 = firestore();
  await firestoreWriteTasksNow('u1', [T('a', { title: 'new title' }), T('c'), T('d')], prev);
  check('save: a changed task -> its changed fields only; a new one whole; a removed one deleted',
    log2.batches,
    [[{ op: 'update', path: 'users/u1/tasks/a', data: { title: 'new title' } },
      { op: 'set', path: 'users/u1/tasks/d', data: T('d') },
      { op: 'delete', path: 'users/u1/tasks/b' }]]);

  const log3 = firestore();
  await firestoreWriteTasksNow('u1', [T('a')]);
  check('save: with no earlier copy, every task is written whole', log3.batches, [[{ op: 'set', path: 'users/u1/tasks/a', data: T('a') }]]);

  // Un-completing an auto-dated task removes fields; they must go in Firestore too.
  const log4 = firestore();
  const done = T('a', { completed: true, completedAt: 'x', completedDate: '2026-11-12' });
  await firestoreWriteTasksNow('u1', [T('a', { completedAt: null })], [done]);
  check('save: a field removed here is removed there; null is written as null', log4.batches[0][0],
    { op: 'update', path: 'users/u1/tasks/a', data: { completed: false, completedAt: null, completedDate: GONE } });

  const log5 = firestore();
  await firestoreWriteTasksNow('u1', [T('a', { recurrence: { type: 'weekly', days: [1, 3] } })], [T('a', { recurrence: { type: 'daily' } })]);
  check('save: a nested value is written whole', log5.batches[0][0].data, { recurrence: { type: 'weekly', days: [1, 3] } });

  const log6 = firestore();
  await firestoreWriteTasksNow('u1', [{ completed: false, category: 'life', title: 'Task a', id: 'a' }], [T('a')]);
  check('save: key order alone writes nothing', log6.batches, []);

  const log7 = firestore();
  await firestoreWriteTasksNow('u1', [T('a', { 'odd.name': 1 })], [T('a')]);
  check('save: a field name is never read as a path', Object.keys(log7.batches[0][0].data), ['odd.name']);

  const many = Array.from({ length: 1000 }, (_, i) => T(`t${i}`));
  const log8 = firestore();
  await firestoreWriteTasksNow('u1', many, []);
  check('save: more than 490 writes go in several batches', log8.batches.map(b => b.length), [490, 490, 20]);

  await quiet(async () => {
    firestore({}, { failCommit: true });
    let threw = false;
    try { await firestoreWriteTasksNow('u1', [T('a')], []); } catch { threw = true; }
    check('save: a refused batch is reported to the caller', threw, true);
  });
}

// ── 7. Saving to a task deleted on another device (SY-D3, SY-D4) ──
{
  const prev = [T('a'), T('b'), T('c')];
  const next = [T('a', { title: 'edited' }), T('b', { title: 'also edited' }), T('new')];
  const log = firestore({}, { missing: ['a'] });
  const gone = await firestoreWriteTasksNow('u1', next, prev);
  check('gone: the deleted task is named, not brought back', gone, ['a']);
  check('gone: the rest of the save still lands, one write at a time',
    [log.batches, log.singles],
    [[], [{ op: 'update', path: 'users/u1/tasks/b', data: { title: 'also edited' } },
          { op: 'set', path: 'users/u1/tasks/new', data: T('new') },
          { op: 'delete', path: 'users/u1/tasks/c' }]]);

  // Only the batch holding the missing task is redone.
  const big  = Array.from({ length: 600 }, (_, i) => T(`t${i}`));
  const bigN = big.map((t, i) => (i === 500 ? { ...t, title: 'x' } : { ...t, notes: 'n' }));
  const log2 = firestore({}, { missing: ['t500'] });
  check('gone: other batches go through as batches',
    [await firestoreWriteTasksNow('u1', bigN, big), log2.batches.map(b => b.length), log2.singles.length], [['t500'], [490], 109]);

  // The push task's immediate write (toggleTask).
  const log3 = firestore();
  await firestoreWriteTaskFields('u1', T('p', { push: true }), T('p', { push: true, completed: true, completedAt: 'x' }));
  check('one task: its changed fields only', log3.singles,
    [{ op: 'update', path: 'users/u1/tasks/p', data: { completed: true, completedAt: 'x' } }]);
  const log4 = firestore();
  await firestoreWriteTaskFields('u1', T('p'), T('p'));
  check('one task: nothing changed -> no write', log4.singles, []);
  const log5 = firestore({}, { missing: ['p'] });
  check('one task: deleted elsewhere -> no write, no error, says so',
    [await firestoreWriteTaskFields('u1', T('p'), T('p', { completed: true })), log5.singles], [false, []]);
}

// ── 8. The hook: debounced saves, the baseline, tasks that are gone ──
{
  // Timers are captured, not waited for.
  const realSetTimeout = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  let timers = [];
  const hookTimers = () => {
    globalThis.setTimeout = (fn) => { timers.push(fn); return timers.length; };
    globalThis.clearTimeout = (id) => { if (id) timers[id - 1] = null; };
  };
  const realTimers = () => { globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClear; };
  const fire = async () => { const fns = timers.filter(Boolean); timers = []; realTimers(); for (const f of fns) await f(); await tick(); hookTimers(); };
  const rig = () => {
    const status = [], goneCalls = [];
    timers = [];
    const sync = useFirestoreSync('u1', s => status.push(s), ids => goneCalls.push(ids));
    return { sync, status, goneCalls };
  };
  const server = { tasks: [T('a'), T('b')], settings: { theme: 'ember' } };

  hookTimers();
  try {
    // A normal save: only the difference from the baseline, then the baseline moves.
    {
      const log = firestore();
      const { sync, status } = rig();
      sync.seedLastSynced(server);
      const edited = { tasks: [T('a', { title: 'x' }), T('b')], settings: { theme: 'clay' } };
      sync.setSyncTarget(edited);
      check('hook: nothing is written before the pause is over', log.batches, []);
      await fire();
      check('hook: the save writes the changed field and the changed setting',
        [log.batches, log.sets.map(s => s.data), status],
        [[[{ op: 'update', path: 'users/u1/tasks/a', data: { title: 'x' } }]], [{ theme: 'clay' }], ['syncing', 'ok']]);
      check('hook: what was saved becomes the baseline', sync.getSyncBase() === edited, true);
      sync.setSyncTarget(edited);
      await fire();
      check('hook: saving the same thing again writes nothing', log.batches.length, 1);
    }
    // The startup case end to end: baseline = server copy, screen = merged.
    {
      const log = firestore();
      const { sync } = rig();
      const opened = { tasks: [T('a', { date: 'old' }), T('b')], settings: { theme: 'ember' } };
      const screen = { ...opened, tasks: [T('a', { date: 'old', completed: true }), T('b')] };
      const srv    = { tasks: [T('a', { date: 'new' }), T('b')], settings: { theme: 'ember' } };
      sync.seedLastSynced(srv);
      sync.setSyncTarget(mergeBootEdits(screen, srv, opened));
      await fire();
      check('hook: after startup only the edit made while loading is written',
        [log.batches, log.sets], [[[{ op: 'update', path: 'users/u1/tasks/a', data: { completed: true } }]], []]);
    }
    // A task deleted on another device: named to the app, never written back.
    {
      const log = firestore({}, { missing: ['a'] });
      const { sync, status, goneCalls } = rig();
      sync.seedLastSynced(server);
      const edited = { tasks: [T('a', { title: 'x' }), T('b', { title: 'y' })], settings: server.settings };
      sync.setSyncTarget(edited);
      await fire();
      check('hook: the app is told which task is gone; the other edit is saved; no error shown',
        [goneCalls, log.singles, status],
        [[['a']], [{ op: 'update', path: 'users/u1/tasks/b', data: { title: 'y' } }], ['syncing', 'ok']]);
      // The app drops it from the screen; the next save must not recreate it.
      const after = { tasks: [T('b', { title: 'y' })], settings: server.settings };
      const log2 = firestore();
      sync.setSyncTarget(after);
      await fire();
      check('hook: once dropped from the screen it is never written whole again',
        [...log2.batches.flat(), ...log2.singles].filter(o => o.op === 'set'), []);
    }
    // A refused save: status says so, the baseline stays, the next save retries.
    await quiet(async () => {
      firestore({}, { failCommit: true });
      const { sync, status } = rig();
      sync.seedLastSynced(server);
      const edited = { tasks: [T('a', { title: 'x' }), T('b')], settings: server.settings };
      sync.setSyncTarget(edited);
      await fire();
      check('hook: a refused save shows an error and keeps the old baseline', [status, sync.getSyncBase() === server], [['syncing', 'error'], true]);
      const log = firestore();
      sync.setSyncTarget(edited);
      await fire();
      check('hook: the next save writes it', log.batches, [[{ op: 'update', path: 'users/u1/tasks/a', data: { title: 'x' } }]]);
    });
    // A refresh: the difference from what the server returned is written at once.
    {
      const log = firestore();
      const { sync } = rig();
      sync.seedLastSynced(server);
      const serverView = { tasks: [T('a', { notes: 'theirs' }), T('b')], settings: { theme: 'ember' } };
      const next = { tasks: [T('a', { notes: 'theirs', title: 'mine' }), T('b')], settings: { theme: 'ember' } };
      await sync.commitRefresh(serverView, next);
      check('hook: a refresh writes only what this device still has to say',
        [log.batches, sync.getSyncBase() === next], [[[{ op: 'update', path: 'users/u1/tasks/a', data: { title: 'mine' } }]], true]);
    }
    {
      firestore({}, { missing: ['a'] });
      const { sync, goneCalls } = rig();
      sync.seedLastSynced(server);
      await sync.commitRefresh(server, { tasks: [T('a', { title: 'mine' }), T('b')], settings: server.settings });
      check('hook: a task that vanished during a refresh is named too', goneCalls, [['a']]);
    }
    // No user: nothing happens.
    {
      const log = firestore();
      const status = [];
      const sync = useFirestoreSync(null, s => status.push(s));
      sync.setSyncTarget({ tasks: [T('a')], settings: {} });
      await fire();
      check('hook: signed out -> nothing is queued or written', [log.batches, status], [[], []]);
    }
  } finally { realTimers(); }
}

await cleanup();
console.log(`sync-golden: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
