// src/hooks/useFirestore.js
// Firestore load/save for tasks and settings.
// Called once from App.jsx. localStorage stays as offline fallback.

import { useEffect, useRef, useCallback } from 'react';
import {
  collection, doc, getDocs, setDoc, writeBatch, deleteField, FieldPath,
} from 'firebase/firestore';
import { db } from '../firebase.js';
import { stripTransientFromTasks } from '../utils/taskEdit.js';

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

// ── Remote refresh merge (bug sweep S1) ───────────────────────
// Three-way merge of what's on screen (local), what Firestore just returned
// (remote) and what this device last confirmed it saved (base):
//   - a task or settings key that differs between local and base is a local
//     change not yet saved (edit, add or delete) — it wins;
//   - anything unchanged locally takes the remote version, including remote
//     additions and remote deletions.
// Pure. Without a base (nothing saved yet) remote wins, as before.
export function mergeTasks(localTasks, remoteTasks, baseTasks) {
  const baseMap   = new Map((baseTasks   || []).map(t => [t.id, t]));
  const remoteMap = new Map((remoteTasks || []).map(t => [t.id, t]));
  const out  = [];
  const seen = new Set();
  for (const t of localTasks || []) {
    seen.add(t.id);
    if (!sameValue(t, baseMap.get(t.id))) { out.push(t); continue; } // local change wins
    if (remoteMap.has(t.id)) out.push(remoteMap.get(t.id));          // else remote (or deleted remotely)
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
async function syncTasks(uid, prevTasks, nextTasks) {
  const prevMap = Object.fromEntries((prevTasks || []).map(t => [t.id, t]));
  const nextMap = Object.fromEntries((nextTasks || []).map(t => [t.id, t]));

  let batch = writeBatch(db);
  let ops = 0;
  const MAX = 490;

  const flush = async () => {
    if (ops === 0) return;
    await batch.commit();
    batch = writeBatch(db);
    ops = 0;
  };

  for (const [id, task] of Object.entries(nextMap)) {
    if (!prevMap[id] || JSON.stringify(prevMap[id]) !== JSON.stringify(task)) {
      if (ops >= MAX) await flush();
      batch.set(taskDoc(uid, id), task);
      ops++;
    }
  }

  for (const id of Object.keys(prevMap)) {
    if (!nextMap[id]) {
      if (ops >= MAX) await flush();
      batch.delete(taskDoc(uid, id));
      ops++;
    }
  }

  await flush();
}

// ── Immediate task write (used after the engine runs on load) ─────────────
// Bypasses the debounce. S9: writes only the tasks that differ from
// prevTasks (what Firestore returned), not every task.
export async function firestoreWriteTasksNow(uid, tasks, prevTasks = []) {
  await syncTasks(uid, prevTasks, tasks);
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
export function useFirestoreSync(uid, setSyncStatus) {
  const lastSynced  = useRef(null);
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
      await Promise.all([
        syncTasks(uid, prev.tasks, next.tasks || []),
        syncSettings(uid, prev.settings, next.settings || {}),
      ]);
      if (baseGen.current === gen) lastSynced.current = next;
      setSyncStatus('ok');
    } catch (e) {
      console.error('AVI: Firestore sync failed', e);
      setSyncStatus('error');
    }
  }, [uid, setSyncStatus]);

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
    ]).catch(e => {
      console.warn('AVI: refresh write failed', e);
      if (baseGen.current !== gen) return;
      lastSynced.current = serverView;
      pending.current = next;
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, DEBOUNCE_MS);
    });
  }, [uid, flush]);

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
