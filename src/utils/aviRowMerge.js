// src/utils/aviRowMerge.js
// S4: keeping AVI rows (word inputs, sentence inputs, Lemma Master entries)
// in step across devices. Leaf module: no imports.
//
// rowFieldChanges — the fields that differ between two versions of a row, so
//   a save writes only what this device changed and leaves fields another
//   device changed alone.
// mergeAviRows — three-way merge of this device's rows (local) with a fresh
//   read (remote), using the last saved state (base) to tell what changed
//   here: a field changed here and not yet saved wins; every other field
//   takes the remote value. Rows added elsewhere come in. A row deleted
//   elsewhere stays deleted, even if it was changed here (most row writes
//   are automatic: uploaded flags, cascades, Def1 fill). A row added or
//   deleted here and not yet saved keeps that change.

const enc = (v) => (v === undefined ? undefined : JSON.stringify(v));

// Field-by-field equality, ignoring key order at the top level. A field set
// to undefined counts as absent (Firestore can't store undefined).
export function rowsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (enc(a[k]) !== enc(b[k])) return false;
  return true;
}

// { set: { field: value }, removed: [field] } for the fields that differ,
// or null when nothing does.
export function rowFieldChanges(prev, next) {
  const set = {};
  const removed = [];
  const keys = new Set([...Object.keys(prev || {}), ...Object.keys(next || {})]);
  for (const k of keys) {
    const nv = next ? next[k] : undefined;
    const pv = prev ? prev[k] : undefined;
    if (enc(nv) === enc(pv)) continue;
    if (nv === undefined) removed.push(k);
    else set[k] = nv;
  }
  return (Object.keys(set).length || removed.length) ? { set, removed } : null;
}

// Field-level three-way merge of one row present both here and remotely.
function mergeRow(local, remote, base) {
  const b = base || {};
  const out = {};
  const keys = new Set([...Object.keys(remote), ...Object.keys(local), ...Object.keys(b)]);
  for (const k of keys) {
    const lv = local[k];
    const v = enc(lv) !== enc(b[k]) ? lv : remote[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// Returns { rows, localChanges, added, updated, dropped }:
//   rows          the merged list (the local array itself when nothing changed)
//   localChanges  rows that still differ from remote (unsaved changes here)
//   added/updated/dropped  what the remote read changed on this device
export function mergeAviRows(localArr, remoteArr, baseArr, keyFn) {
  const local  = localArr  || [];
  const remote = remoteArr || [];
  const index = (arr) => {
    const m = new Map();
    for (const r of arr) { const k = keyFn(r); if (k != null && k !== '') m.set(k, r); }
    return m;
  };
  const L = index(local);
  const R = index(remote);
  const B = index(baseArr || []);

  const kept = [];
  let localChanges = 0, updated = 0, dropped = 0;
  for (const l of local) {
    const k = keyFn(l);
    if (k == null || k === '') { kept.push(l); continue; }
    if (L.get(k) !== l) continue;              // duplicate key: keep the last copy only
    const b = B.get(k);
    const r = R.get(k);
    if (r === undefined) {
      if (b !== undefined) { dropped++; continue; }   // deleted elsewhere
      kept.push(l); localChanges++; continue;          // added here, not saved yet
    }
    const unchangedHere = b !== undefined && rowsEqual(l, b);
    const m = unchangedHere ? r : mergeRow(l, r, b);
    if (!rowsEqual(m, r)) localChanges++;
    if (rowsEqual(m, l)) { kept.push(l); continue; }
    kept.push(m); updated++;
  }

  const fresh = [];
  for (const r of remote) {
    const k = keyFn(r);
    if (k == null || k === '' || L.has(k) || R.get(k) !== r) continue;
    if (B.has(k)) { localChanges++; continue; }      // deleted here, not saved yet
    fresh.push(r);                                    // added elsewhere
  }

  const changed = fresh.length > 0 || updated > 0 || dropped > 0;
  return {
    rows: changed ? [...fresh, ...kept] : local,
    localChanges, added: fresh.length, updated, dropped,
  };
}
