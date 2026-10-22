// ── Task edit helpers (bug sweep N1, K3) ─────────────────────────────────────
// Leaf module: no page or hook imports.
//
// Pages hand TaskItem and the calendars render-only copies of tasks marked
// with underscore keys (_dateOcc, _doneRecord, _virtual, _followUp). Those
// markers describe one row on screen and must never be stored on the task.
// No stored task field starts with an underscore, so every such key is
// transient.

const isTransientKey = (k) => k.startsWith('_');

// The task without its render-only markers. Returns the same object when it
// has none, so callers can tell whether anything was removed.
export function stripTransientTaskFields(task) {
  if (!task || typeof task !== 'object') return task;
  const keys = Object.keys(task);
  if (!keys.some(isTransientKey)) return task;
  const out = {};
  for (const k of keys) if (!isTransientKey(k)) out[k] = task[k];
  return out;
}

// Cleans a loaded task list. repairedIds lists the tasks that carried
// markers (written by Edit Task before this fix), so the caller can write
// the cleaned docs back once.
export function stripTransientFromTasks(tasks) {
  const repairedIds = [];
  const out = (tasks || []).map(t => {
    const clean = stripTransientTaskFields(t);
    if (clean !== t) repairedIds.push(t.id);
    return clean;
  });
  return { tasks: repairedIds.length ? out : (tasks || []), repairedIds };
}

// The task Edit Task should open: the stored task with this id, never the
// row copy that was clicked (an Upcoming occurrence copy carries another
// day's date and the _dateOcc marker). Falls back to the cleaned copy.
export function resolveEditTarget(task, tasks) {
  if (!task) return task;
  const stored = (tasks || []).find(t => t.id === task.id);
  return stored || stripTransientTaskFields(task);
}

// Plain-JSON equality with sorted keys; null and undefined count as the same
// "no value" (the modal writes null where the stored task has no field).
function canon(v) {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return v.map(canon);
  if (typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v;
}
export const sameValue = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

// Applies the fields an editor changed onto the latest copy of a doc (K3).
//   latest: the doc as it is now
//   base:   the doc as the editor opened it (in the editor's own payload shape)
//   edited: what the editor saved
// A field counts as changed when edited and base differ (null and undefined
// alike, objects by content). skipKeys are never applied. Returns the merged
// doc and the keys that were applied.
export function applyFieldEdits(latest, base, edited, skipKeys = []) {
  const merged = { ...latest };
  const changed = [];
  const keys = new Set([...Object.keys(base || {}), ...Object.keys(edited || {})]);
  for (const k of keys) {
    if (k === 'id' || skipKeys.includes(k)) continue;
    if (sameValue(edited?.[k], base?.[k])) continue;
    if (edited?.[k] === undefined) delete merged[k];
    else merged[k] = edited[k];
    changed.push(k);
  }
  return { merged, changed };
}

// Applies an Edit Task save to the latest stored task (K3).
//   latest: the task as it is now (null if it was deleted meanwhile)
//   base:   the task as it was when the modal opened
//   edited: what the modal saved (base plus the form's fields)
// Only fields the modal actually changed are taken from `edited`; every other
// field keeps its latest value, so a completion, an engine roll or a remote
// refresh that landed while the modal was open is not reverted. Per-day
// check-offs come from the latest task, kept only for dates still on it.
// Returns null when the task no longer exists.
export function applyTaskEdit(latest, base, edited) {
  if (!latest) return null;
  const cleanEdited = stripTransientTaskFields(edited);
  if (!base) return cleanEdited;
  const cleanBase = stripTransientTaskFields(base);
  const { merged } = applyFieldEdits(stripTransientTaskFields(latest), cleanBase, cleanEdited, ['completedDates']);
  // Multi-date check-offs: the latest ones, limited to the saved dates; a
  // task that is no longer multi-date drops them (as the modal did).
  if (Array.isArray(merged.dates) && merged.dates.length > 1) {
    if (Array.isArray(latest.completedDates)) {
      merged.completedDates = latest.completedDates.filter(ds => merged.dates.includes(ds));
    } else {
      delete merged.completedDates;
    }
  } else {
    delete merged.completedDates;
  }
  return merged;
}
