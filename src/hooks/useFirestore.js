// src/hooks/useFirestore.js
// Firestore load/save for tasks and settings.
// Called once from App.jsx. localStorage stays as offline fallback.

import { useEffect, useRef, useCallback } from 'react';
import {
  collection, doc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, deleteField, FieldPath,
} from 'firebase/firestore';
import { db } from '../firebase.js';
import { stripTransientFromTasks } from '../utils/taskEdit.js';
import { rowFieldChanges } from '../utils/aviRowMerge.js';

const DEBOUNCE_MS = 1500;

// ── Firestore path helpers ────────────────────────────────────
function tasksCol(uid)      { return collection(db, 'users', uid, 'tasks'); }
function settingsDoc(uid)   { return doc(db, 'users', uid, 'settings', 'main'); }
function taskDoc(uid, id)   { return doc(db, 'users', uid, 'tasks', id); }

const sameValue = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

// ── Load all data for a user ──────────────────────────────────
export async function firestoreLoad(uid) {
  try {
    const [taskSnap, settingsSnap] = await Promise.all([
      getDocs(tasksCol(uid)),
      getDocs(collection(db, 'users', uid, 'settings')),
    ]);
    // N1: render-only markers (_dateOcc, _doneRecord) saved onto tasks by
    // Edit Task are dropped here; repairedTaskIds lets the boot load write
    // the cleaned docs back once.
    const { tasks, repairedIds } = stripTransientFromTasks(taskSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    const sDoc     = settingsSnap.docs.find(d => d.id === 'main');
    const settings = sDoc ? sDoc.data() : null;
    if (!tasks.length && !settings) return null; // new user
    return { tasks, settings, repairedTaskIds: repairedIds };
  } catch (e) {
    console.error('AVI: Firestore load failed', e);
    return 'error'; // distinct from null (new user) so callers can fail safe
  }
}

// ── Remote refresh merge (bug sweep S1; audit SY1, SY2) ───────
// Three-way merge of what's on screen (local), what Firestore just returned
// (remote) and what this device last confirmed it saved (base):
//   - a task field or settings key that differs between local and base is a
//     local change not yet saved; it wins. Every other field takes the
//     remote value (SY-D2: renamed here and ticked on the phone gives a
//     renamed, ticked task; before, the task from here won whole);
//   - tasks added on another device come in; a task deleted on another
//     device stays deleted, even if it was edited here (SY-D3);
//   - a task added or deleted here and not yet saved keeps that change.
// Pure. Without a base (nothing saved yet) remote wins, as before.
// The same field comparison (rowFieldChanges) decides what a save writes.
function mergeTaskFields(local, remote, base) {
  const changes = rowFieldChanges(base, local); // what this device changed
  if (!changes) return remote;
  const out = { ...remote, ...changes.set };
  for (const k of changes.removed) delete out[k];
  return out;
}

export function mergeTasks(localTasks, remoteTasks, baseTasks) {
  const baseMap   = new Map((baseTasks   || []).map(t => [t.id, t]));
  const remoteMap = new Map((remoteTasks || []).map(t => [t.id, t]));
  const out  = [];
  const seen = new Set();
  for (const t of localTasks || []) {
    seen.add(t.id);
    const b = baseMap.get(t.id);
    if (!b) { out.push(t); continue; }      // added here, not yet saved
    const r = remoteMap.get(t.id);
    if (!r) continue;                       // deleted on another device
    out.push(mergeTaskFields(t, r, b));
  }
  for (const r of remoteTasks || []) {
    if (seen.has(r.id) || baseMap.has(r.id)) continue; // already handled, or deleted here
    out.push(r);                                        // added on another device
  }
  return out;
}

export function mergeSettings(localSettings, remoteSettings, baseSettings) {
  if (!remoteSettings) return localSettings;
  const l = localSettings || {}, r = remoteSettings, b = baseSettings || {};
  const out = {};
  for (const k of new Set([...Object.keys(l), ...Object.keys(r), ...Object.keys(b)])) {
    const v = !sameValue(l[k], b[k]) ? l[k] : r[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function mergeRemoteData(local, remote, base) {
  if (!base) {
    return { ...local, tasks: remote.tasks || [], settings: remote.settings || local.settings };
  }
  return {
    ...local,
    tasks:    mergeTasks(local.tasks, remote.tasks, base.tasks),
    settings: mergeSettings(local.settings, remote.settings, base.settings),
  };
}

// SY-D1: the server copy arriving at startup. `opened` is the device's saved
// copy as the app first showed it, `screen` is what is on screen now, and
// `server` is the server copy (after the recurrence engine). The server copy
// wins, as it has since the September incident; only what changed on screen
// since opening is put back on top of it, field by field. Anything in the
// device's copy that was merely old differs from neither `opened` nor
// `screen`, so it loses. Without `opened` (a later load in the same session)
// the server copy replaces the screen, as before. Pure.
export function mergeBootEdits(screen, server, opened) {
  if (!opened || screen === opened) return server;
  return {
    settings: mergeSettings(screen.settings, server.settings, opened.settings),
    tasks:    mergeTasks(screen.tasks, server.tasks, opened.tasks),
  };
}

// S1: everything a remote refresh decides, in one pure step: merge the
// snapshot into local, run the recurrence engine on the result, and name
// what Firestore holds now (serverView) so the caller can write the
// difference. runEngine(tasks, dsh) → { tasks, changed }.
export function planRemoteRefresh({ local, remote, base, runEngine }) {
  const merged = mergeRemoteData(local, remote, base);
  const dsh = merged.settings?.dayStartHour ?? 3;
  const { tasks: rolled, changed } = runEngine(merged.tasks || [], dsh);
  return {
    merged,
    changed,
    next:       changed ? { ...merged, tasks: rolled } : merged,
    serverView: { tasks: remote.tasks || [], settings: remote.settings || {} },
  };
}

// ── Sync tasks: diff prev vs next, only write/delete what changed ─
// SY-D4: an existing task is saved as its changed fields only (a field
// removed here is deleted there), so a copy that is out of date on this
// device can no longer put back what another device changed. A new task is
// written whole; a removed one is deleted.
//
// Resolves to the ids of tasks that turned out to be deleted on another
// device (their update is refused with not-found). Those are not written
// back (SY-D3); the caller drops them from the screen. Firestore refuses the
// whole batch over one such task, so that batch is redone one write at a
// time and the others land.
const isNotFound = (e) => e?.code === 'not-found';

// (FieldPath, value, FieldPath, value, ...) for update(): exact field names,
// never read as dotted paths.
function fieldArgs(changes) {
  const args = [];
  for (const [k, v] of Object.entries(changes.set)) args.push(new FieldPath(k), v);
  for (const k of changes.removed) args.push(new FieldPath(k), deleteField());
  return args;
}

async function syncTasks(uid, prevTasks, nextTasks) {
  const prevMap = new Map((prevTasks || []).map(t => [t.id, t]));
  const nextMap = new Map((nextTasks || []).map(t => [t.id, t]));
  const gone = [];

  let batch = writeBatch(db);
  let batchOps = [];
  const MAX = 490;

  const flush = async () => {
    if (batchOps.length === 0) return;
    const opsNow = batchOps;
    const batchNow = batch;
    batch = writeBatch(db);
    batchOps = [];
    try {
      await batchNow.commit();
    } catch (e) {
      if (!isNotFound(e)) throw e;
      const results = await Promise.allSettled(opsNow.map(op => (
        op.kind === 'update' ? updateDoc(op.ref, ...op.args)
        : op.kind === 'set'  ? setDoc(op.ref, op.data)
        : deleteDoc(op.ref)
      )));
      results.forEach((res, i) => {
        if (res.status === 'fulfilled') return;
        if (isNotFound(res.reason) && opsNow[i].kind === 'update') gone.push(opsNow[i].id);
        else throw res.reason;
      });
    }
  };
  const add = async (op) => {
    if (batchOps.length >= MAX) await flush();
    if (op.kind === 'update') batch.update(op.ref, ...op.args);
    else if (op.kind === 'set') batch.set(op.ref, op.data);
    else batch.delete(op.ref);
    batchOps.push(op);
  };

  for (const [id, task] of nextMap) {
    const prev = prevMap.get(id);
    if (prev === task) continue;
    if (!prev) { await add({ kind: 'set', id, ref: taskDoc(uid, id), data: task }); continue; }
    const changes = rowFieldChanges(prev, task);
    if (changes) await add({ kind: 'update', id, ref: taskDoc(uid, id), args: fieldArgs(changes) });
  }

  for (const id of prevMap.keys()) {
    if (!nextMap.has(id)) await add({ kind: 'delete', id, ref: taskDoc(uid, id) });
  }

  await flush();
  return gone;
}

// ── Immediate task write (used after the engine runs on load) ─────────────
// Bypasses the debounce. S9: writes only the tasks that differ from
// prevTasks (what Firestore returned), not every task. A task missing from
// prevTasks is written whole, which is how the N1 repair replaces a task
// that carried render-only markers. Resolves to the ids of tasks deleted on
// another device meanwhile (see syncTasks).
export async function firestoreWriteTasksNow(uid, tasks, prevTasks = []) {
  return syncTasks(uid, prevTasks, tasks);
}

// One task, right now: the fields that differ between prevTask and nextTask
// (toggleTask's immediate write for a push task). Resolves to false when the
// task was deleted on another device, true otherwise.
export async function firestoreWriteTaskFields(uid, prevTask, nextTask) {
  const changes = rowFieldChanges(prevTask, nextTask);
  if (!changes) return true;
  try {
    await updateDoc(taskDoc(uid, nextTask.id), ...fieldArgs(changes));
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

// ── Sync settings ─────────────────────────────────────────────
// S3: writes only the keys that changed, each replaced whole (mergeFields),
// and deletes keys removed here. Keys this device never had — AVI's avi*
// settings, the migration flags other pages set with merge — are left alone,
// so a stale copy can no longer write them back or erase them.
async function syncSettings(uid, prevSettings, nextSettings) {
  const p = prevSettings || {}, n = nextSettings || {};
  const patch = {}, fields = [];
  for (const k of new Set([...Object.keys(p), ...Object.keys(n)])) {
    if (sameValue(p[k], n[k])) continue;
    patch[k] = n[k] === undefined ? deleteField() : n[k];
    fields.push(new FieldPath(k));
  }
  if (!fields.length) return;
  await setDoc(settingsDoc(uid), patch, { mergeFields: fields });
}

// ── Hook: call from App.jsx ───────────────────────────────────
// onTasksGone(ids): tasks a save found deleted on another device (SY-D3).
// They were not written back; the app removes them from the screen. The
// baseline keeps them, so the save that follows their removal asks Firestore
// to delete them (already true) and can never write one back whole.
export function useFirestoreSync(uid, setSyncStatus, onTasksGone) {
  const lastSynced  = useRef(null);
  const goneRef     = useRef(onTasksGone);
  useEffect(() => { goneRef.current = onTasksGone; }, [onTasksGone]);
  const reportGone  = useCallback((ids) => {
    if (ids && ids.length && goneRef.current) goneRef.current(ids);
  }, []);
  const pending     = useRef(null);
  const timer       = useRef(null);
  // S1: bumped whenever a remote refresh replaces the baseline, so a save
  // that started before it can't put its older snapshot back as the baseline.
  const baseGen     = useRef(0);

  // Seeds lastSynced with the initial Firestore data so the first debounced flush
  // only writes what actually changed locally, preventing redundant full rewrites.
  const seedLastSynced = useCallback((data) => {
    if (!lastSynced.current) {
      lastSynced.current = data;
    }
  }, []);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    timer.current = null;
    if (!uid || !pending.current) return;
    const next = pending.current;
    const gen  = baseGen.current;
    setSyncStatus('syncing');
    try {
      const prev = lastSynced.current || { tasks: [], settings: {} };
      const [gone] = await Promise.all([
        syncTasks(uid, prev.tasks, next.tasks || []),
        syncSettings(uid, prev.settings, next.settings || {}),
      ]);
      if (baseGen.current === gen) lastSynced.current = next;
      setSyncStatus('ok');
      reportGone(gone);
    } catch (e) {
      console.error('AVI: Firestore sync failed', e);
      setSyncStatus('error');
    }
  }, [uid, setSyncStatus, reportGone]);

  const setSyncTarget = useCallback((data) => {
    if (!uid) return;
    pending.current = data;
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, DEBOUNCE_MS);
  }, [uid, flush]);

  // S1: the baseline for a remote refresh's three-way merge.
  const getSyncBase = useCallback(() => lastSynced.current, []);

  // S1: a remote refresh merged `next` from `serverView` (what Firestore
  // returned). Write the difference now — local edits the merge kept, plus
  // engine rolls — and make `next` the baseline. If that write fails, fall
  // back to the server view as the baseline and queue `next` again, so the
  // debounced sync retries it.
  const commitRefresh = useCallback((serverView, next) => {
    if (!uid) return Promise.resolve();
    baseGen.current += 1;
    const gen = baseGen.current;
    lastSynced.current = next;
    return Promise.all([
      syncTasks(uid, serverView.tasks || [], next.tasks || []),
      syncSettings(uid, serverView.settings || {}, next.settings || {}),
    ]).then(([gone]) => reportGone(gone)).catch(e => {
      console.warn('AVI: refresh write failed', e);
      if (baseGen.current !== gen) return;
      lastSynced.current = serverView;
      pending.current = next;
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, DEBOUNCE_MS);
    });
  }, [uid, flush, reportGone]);

  // S2: save right away when the app is hidden or closed instead of waiting
  // out the debounce (iOS suspends timers). With Firestore's persistent cache
  // the write is queued locally and goes out when the connection allows.
  useEffect(() => {
    const flushIfWaiting = () => { if (timer.current) flush(); };
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushIfWaiting(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flushIfWaiting);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flushIfWaiting);
    };
  }, [flush]);

  useEffect(() => {
    return () => {
      if (timer.current) flush();
    };
  }, [flush]);

  return { setSyncTarget, seedLastSynced, getSyncBase, commitRefresh };
}
