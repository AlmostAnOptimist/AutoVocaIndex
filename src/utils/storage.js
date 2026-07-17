import { STORAGE_KEY } from '../constants.js';
import { uid } from './dateUtils.js';
import { toDateStr } from './dateUtils.js';
import { DEMO } from '../demo/demoConfig.js';

export function loadState() {
  if (DEMO) return null; // demo: never read the local baseline (cross-account bleed)
  try {
    const r = localStorage.getItem(STORAGE_KEY);
    if (r) return JSON.parse(r);
  } catch {}
  return null;
}

export function saveState(data) {
  if (DEMO) return; // demo: never persist the local baseline
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {}
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