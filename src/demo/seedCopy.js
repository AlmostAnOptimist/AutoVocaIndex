// src/demo/seedCopy.js
// Idempotent demo seed copy. Runs once per anonymous account, before any
// per-user data loads (App.jsx gates all loaders on seedReady).
//
// Idempotency: a flag doc (users/{uid}/settings/demoSeedFlag) is written
// LAST, after the main batch commits. If a copy is interrupted, the flag is
// absent and the next load re-runs the copy over the same fixed doc IDs —
// self-healing, no duplicates.
//
// Every seeded doc carries seeded: true. Caps, read-only locks, and the quiz
// user-card guarantee all key off the absence of that field.
//
// Date shift: all date-like string fields (YYYY-MM-DD and ISO timestamps)
// are shifted forward by the whole-day delta between the export stamp and
// today, so the account always reads as a recent snapshot rather than a
// stale one.

import { doc, getDoc, setDoc, writeBatch } from 'firebase/firestore';
import { db } from '../firebase.js';
import { createInitialTasks } from '../utils/storage.js';
import { toDateStr, uid as genId } from '../utils/dateUtils.js';
import seed from './demoSeed.json';

const DAY_MS = 86400000;

// ── Date shifting ─────────────────────────────────────────────
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function shiftValue(v, deltaMs) {
  if (typeof v !== 'string') return v;
  if (DATE_ONLY.test(v)) {
    const t = Date.parse(v + 'T00:00:00Z');
    if (Number.isNaN(t)) return v;
    return new Date(t + deltaMs).toISOString().slice(0, 10);
  }
  if (ISO_STAMP.test(v)) {
    const t = Date.parse(v);
    if (Number.isNaN(t)) return v;
    return new Date(t + deltaMs).toISOString();
  }
  return v;
}

// Deep-clones while shifting — the imported JSON module object is shared
// and must never be mutated.
function shiftDeep(obj, deltaMs) {
  if (Array.isArray(obj)) return obj.map(x => shiftDeep(x, deltaMs));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = shiftDeep(v, deltaMs);
    return out;
  }
  return shiftValue(obj, deltaMs);
}

// ── Authored docs (not in the export) ─────────────────────────
function buildAviAdditionsSource() {
  // Mirrors ContentLibraryPage handleAddSource's payload shape exactly —
  // this IS a user-add source, so it should look like one.
  return {
    title: 'AVI Additions',
    type: 'Vocabulary',
    url: null,
    origin: 'Self',
    subtype: null,
    levelMin: null,
    levelMax: null,
    studyIntent: null,
    series: null,
    seriesOrder: null,
    lastActivityAt: null,
    sourceStatus: 'Not started',
    createdAt: new Date().toISOString(),
  };
}

function buildDemoAppointment(apptId, taskId) {
  const now = new Date();
  const apptDate = toDateStr(new Date(now.getTime() + 3 * DAY_MS));
  // Shape mirrors AppointmentModal handleSave + saveAppointment's
  // lastUpdated stamp. Linked to 세종 5A / 2과 so the Content page's
  // next-lesson line and the section-complete flow have a live target.
  return {
    id: apptId,
    date: apptDate,
    time: '18:00',
    type: 'Tutoring',
    provider: '김선생님',
    category: 'lang',
    summary: '',
    results: '',
    outcome: null,
    followUpQueue: [],
    cost: null,
    costCurrency: null,
    costs: [],
    taskId,
    lastVisitDate: null,
    created: now.toISOString(),
    mainSourceId: 'source_세종_5a',
    mainSectionId: 'section_1223_세종_5a_2과',
    additionalSources: [],
    lastUpdated: now.toISOString(),
  };
}

function buildAppointmentTask(apptId, taskId, apptDate) {
  // Companion task, matching the shape AppointmentModal creates.
  return {
    id: taskId,
    title: 'Appt: Tutoring',
    category: 'lang',
    priority: 'med',
    date: apptDate,
    time: '18:00',
    recurrence: { type: 'none' },
    notes: '',
    keepRecord: false,
    completed: false,
    persistent: false,
    push: false,
    activeToday: false,
    activatedOn: null,
    created: new Date().toISOString(),
    isAppointmentTask: true,
    appointmentId: apptId,
    apptProvider: '김선생님',
  };
}

// ── Main entry ────────────────────────────────────────────────
// Returns true if a copy ran, false if the flag doc already existed.
export async function ensureDemoSeed(userId) {
  const flagRef = doc(db, 'users', userId, 'settings', 'demoSeedFlag');
  const flag = await getDoc(flagRef);
  if (flag.exists()) return false;

  const deltaMs =
    Math.floor((Date.now() - Date.parse(seed.exportedAt)) / DAY_MS) * DAY_MS;

  const batch = writeBatch(db);
  const put = (coll, id, data) => {
    if (!id) { console.warn('AVI demo seed: skipped doc with no id in', coll); return; }
    batch.set(doc(db, 'users', userId, coll, id), { ...data, seeded: true });
  };
  const shifted = (p) => shiftDeep(p.data, deltaMs);

  // Exported graph — doc ID conventions match the live app:
  // wordInputs/sentenceInputs use the row's uid field, lemmaMaster uses
  // lemmaID, everything else uses the exported doc id.
  put('content_sources', seed.source.id, shifted(seed.source));
  for (const p of seed.sections)        put('content_sections', p.id, shifted(p));
  for (const p of seed.wordInputs)      put('wordInputs', p.data.uid, shifted(p));
  for (const p of seed.sentenceInputs)  put('sentenceInputs', p.data.uid, shifted(p));
  for (const p of seed.lemmaMaster)     put('lemmaMaster', p.data.lemmaID, shifted(p));
  for (const p of seed.decks)           put('decks', p.id, shifted(p));
  for (const p of seed.flashcards)      put('flashcards', p.id, shifted(p));
  for (const p of seed.grammarEntries)  put('grammar_entries', p.id, shifted(p));
  for (const p of seed.notes)           put('notes', p.id, shifted(p));

  // Authored docs: intake source (+ one section), tasks, appointment pair,
  // settings. Task/appointment IDs are generated fresh per account.
  put('content_sources', 'source_avi_additions', buildAviAdditionsSource());
  put('content_sections', 'section_avi_additions_1', {
    content: '1',
    resourceId: 'source_avi_additions',
    status: 'Not started',
    createdAt: new Date().toISOString(),
  });

  for (const t of createInitialTasks()) put('tasks', t.id, t);

  const apptId = genId();
  const taskId = genId();
  const appt = buildDemoAppointment(apptId, taskId);
  put('appointments', apptId, appt);
  put('tasks', taskId, buildAppointmentTask(apptId, taskId, appt.date));

  put('settings', 'main', {
    theme: 'hanok',
    dayStartHour: 3,
    defaultCategory: 'lang',
  });

  await batch.commit();

  // Flag doc last — its absence marks an incomplete copy for self-healing.
  await setDoc(flagRef, {
    seeded: true,
    seededAt: new Date().toISOString(),
    seedVersion: seed.exportedAt,
  });
  return true;
}
