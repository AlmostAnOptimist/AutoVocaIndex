// src/utils/lackingDef2.js
// Which words lack a Definition 2 (audit batch B5, decisions B5-D1).
//
// A word lacks a Def2 when it has at least one word row with no Def2 that is
// not skipped. It is counted once per word, however many of its rows lack
// one. Rows are returned oldest first, so the queue starts with the word
// that has been waiting longest.
//
// Never counted: a skipped row, and a row that already has a Def2 (whether
// or not it is in a deck). This is the same test the Import tab's
// "Fill Def2" button uses for its rows.
//
// Leaf module, no imports. `normalize` decides when two rows are the same
// word; callers pass normalizeLemma from aviUtils.js.

const plain = (s) => String(s || '').normalize('NFC').trim();
// A row's `ts` is the ISO time it was added.
const addedAt = (row) => { const t = Date.parse(row.ts); return Number.isFinite(t) ? t : Infinity; };

export function rowLacksDef2(row) {
  return !!row && !row.skipUpload && !plain(row.def2);
}

export function lackingDef2Rows(wordInputs, normalize = plain) {
  const seen = new Set();
  const out = [];
  const rows = (wordInputs || [])
    .map((row, i) => ({ row, i }))
    .filter(({ row }) => rowLacksDef2(row))
    // Oldest first; rows with no time keep their place in the list, after
    // the dated ones.
    .sort((a, b) => {
      const ta = addedAt(a.row), tb = addedAt(b.row);
      return ta === tb ? a.i - b.i : ta - tb;
    });
  for (const { row } of rows) {
    const word = normalize(row.lemma) || normalize(row.input) || `row:${row.uid}`;
    if (seen.has(word)) continue;
    seen.add(word);
    out.push(row);
  }
  return out;
}

export function lackingDef2Count(wordInputs, normalize = plain) {
  return lackingDef2Rows(wordInputs, normalize).length;
}

// The queue keeps the rows it opened with (by uid, in order), so a row stays
// in place after its Def2 is filled and the modal can page on from it. Rows
// deleted meanwhile drop out.
export function queueRows(wordInputs, uids) {
  const byUid = new Map((wordInputs || []).map(r => [r.uid, r]));
  return (uids || []).map(u => byUid.get(u)).filter(Boolean);
}
