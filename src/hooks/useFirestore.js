// src/hooks/useFirestore.js
// Firestore load/save for tasks and settings.
// Called once from App.jsx. localStorage stays as offline fallback.

import { useEffect, useRef, useCallback } from 'react';
import {
  collection, doc, getDocs, setDoc, deleteDoc, writeBatch,
} from 'firebase/firestore';
import { db } from '../firebase.js';

const DEBOUNCE_MS = 1500;

// ── Firestore path helpers ────────────────────────────────────
function tasksCol(uid)      { return collection(db, 'users', uid, 'tasks'); }
function settingsDoc(uid)   { return doc(db, 'users', uid, 'settings', 'main'); }
function taskDoc(uid, id)   { return doc(db, 'users', uid, 'tasks', id); }

// ── Load all data for a user ──────────────────────────────────
export async function firestoreLoad(uid) {
  try {
    const [taskSnap, settingsSnap] = await Promise.all([
      getDocs(tasksCol(uid)),
      getDocs(collection(db, 'users', uid, 'settings')),
    ]);
    const tasks    = taskSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const sDoc     = settingsSnap.docs.find(d => d.id === 'main');
    const settings = sDoc ? sDoc.data() : null;
    if (!tasks.length && !settings) return null; // new user
    return { tasks, settings };
  } catch (e) {
    console.error('AVI: Firestore load failed', e);
    return null;
  }
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

// ── Immediate full task write (used after engine runs on load) ────────────
// Bypasses the debounce. Writes all tasks that differ from the remote snapshot.
export async function firestoreWriteTasksNow(uid, tasks) {
  try {
    await syncTasks(uid, [], tasks); // pass empty prev so all are written
  } catch (e) {
    throw e;
  }
}

// ── Sync settings ─────────────────────────────────────────────
async function syncSettings(uid, prevSettings, nextSettings) {
  if (JSON.stringify(prevSettings) === JSON.stringify(nextSettings)) return;
  await setDoc(settingsDoc(uid), nextSettings);
}

// ── Hook: call from App.jsx ───────────────────────────────────
export function useFirestoreSync(uid, setSyncStatus) {
  const lastSynced  = useRef(null);
  const pending     = useRef(null);
  const timer       = useRef(null);

  // Seeds lastSynced with the initial Firestore data so the first debounced flush
  // only writes what actually changed locally, preventing redundant full rewrites.
  const seedLastSynced = useCallback((data) => {
    if (!lastSynced.current) {
      lastSynced.current = data;
    }
  }, []);

  const flush = useCallback(async () => {
    if (!uid || !pending.current) return;
    const next = pending.current;
    setSyncStatus('syncing');
    try {
      const prev = lastSynced.current || { tasks: [], settings: {} };
      await Promise.all([
        syncTasks(uid, prev.tasks, next.tasks || []),
        syncSettings(uid, prev.settings, next.settings || {}),
      ]);
      lastSynced.current = next;
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

  useEffect(() => {
    return () => {
      clearTimeout(timer.current);
      if (pending.current) flush();
    };
  }, [flush]);

  return { setSyncTarget, seedLastSynced };
}