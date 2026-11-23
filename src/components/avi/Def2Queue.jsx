// src/components/avi/Def2Queue.jsx
// The Lacking Def2 queue (audit batch B5, decisions B5-D2): the Import tab's
// Fill Def2 modal, opened on every word that lacks a Definition 2, oldest
// first. Nothing new is saved here; a Def2 goes through the same shared row
// updater as Word Input and Import (the Lemma Master entry, the word's other
// rows, sentence backs and card creation all follow), and Skip works the
// same way too.
//
// Hosted by AVIPage, which has everything the modal needs loaded and holds
// which rows the queue opened with (so a row stays in place after it is
// filled and the modal can page on from it). Opened from Today's flag or
// row and from the AVI Overview card.

import { useMemo, useCallback, useEffect } from 'react';
import { WordEditModal } from './WordEditModal.jsx';
import { makeUpdateRow } from '../../utils/wordRowUpdater.js';
import { setWordSkip } from '../../utils/wordSkip.js';
import { autoCreateWordCard } from '../../utils/cardFactory.js';
import { queueRows } from '../../utils/lackingDef2.js';

export function Def2Queue({
  queue,       // { uids: [...], uid } — the rows it opened with and the one showing
  onSelect,    // (uid) => void
  onClose,     // () => void
  uid: userId,
  data, updateData,
  cards, decks, updateCards, updateDecks,
  aviSources, dsh, showAVIToast,
}) {
  const rows = useMemo(() => queueRows(data.wordInputs, queue.uids), [data.wordInputs, queue.uids]);
  // The row on screen; if it was deleted meanwhile, the next one still there.
  const current = rows.some(r => r.uid === queue.uid) ? queue.uid : (rows.find(r => !r.def2) || rows[0])?.uid;

  const updateRow = useMemo(() => makeUpdateRow({
    data, updateData, cards, updateCards, decks, updateDecks, aviSources,
    autoCreateWordCard, dsh,
  }), [data, updateData, cards, updateCards, decks, updateDecks, aviSources, dsh]);

  const toggleSkip = useCallback((rowUid, val) => {
    const row = (data.wordInputs || []).find(w => w.uid === rowUid);
    setWordSkip({ data, updateData, cards, decks, uid: userId, updateCards, updateDecks, aviSources, dsh, showAVIToast, row, val })
      .catch(e => console.error('Def2 queue: skip update failed', e));
  }, [data, updateData, cards, decks, userId, updateCards, updateDecks, aviSources, dsh, showAVIToast]);

  // Every row it opened with is gone: nothing to show, so close.
  const empty = !current;
  useEffect(() => { if (empty) onClose(); }, [empty, onClose]);
  if (empty) return null;

  return (
    <WordEditModal
      key={current}
      rows={rows}
      uid={current}
      onSelectRow={onSelect}
      updateRow={updateRow}
      toggleSkip={toggleSkip}
      lemmaMaster={data.lemmaMaster}
      onClose={onClose}
    />
  );
}
