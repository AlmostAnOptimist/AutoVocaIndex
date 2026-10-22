import { STORAGE_KEY } from '../constants.js';
import { uid } from './dateUtils.js';
import { toDateStr } from './dateUtils.js';
import { DEMO } from '../demo/demoConfig.js';

export function loadState() {
  if (DEMO) return null; // demo: never read the local baseline (cross-account bleed)
  try {
    const r = localStorage.getItem(STORAGE_KEY);
    if (r) {
      // savedAt is a diagnostic stamp (S10), not app data.
      const { savedAt: _savedAt, ...stored } = JSON.parse(r);
      return stored;
    }
  } catch {}
  return null;
}

// S10: a failed local save (storage full, private mode) is logged once per
// run of failures instead of being swallowed. The stamp shows in devtools
// how old the local snapshot is.
let saveFailureLogged = false;
export function saveState(data) {
  if (DEMO) return; // demo: never persist the local baseline
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...data, savedAt: new Date().toISOString() }));
    saveFailureLogged = false;
  } catch (e) {
    if (!saveFailureLogged) {
      console.error('AVI: saving the local copy failed (storage full or unavailable)', e);
      saveFailureLogged = true;
    }
  }
}

export function createInitialTasks() {
  const t  = toDateStr(new Date());
  const task = (overrides) => ({
    id: uid(), time: null, completed: false,
    notes: '', created: new Date().toISOString(),
    recurrence: { type: 'none' },
    ...overrides,
  });
  return [
    task({ title: 'Study session — Section 1',        category: 'lang', priority: 'high', date: t }),
    task({ title: 'Review grammar',                    category: 'lang', priority: 'high', date: t, recurrence: { type: 'daily' } }),
    task({ title: 'Mine three sentences from reading', category: 'lang', priority: 'low',  date: null }),
  ];
}