// src/utils/createCorrectionNote.js
// Creates a correction note document directly in Firestore.
// Used by QuizzesPage after grammar quiz assessment so NotesPage doesn't need modification.
//
// rows: [{ topic, original, corrected }]
// sourceLabel: string shown as the source (e.g. 'Grammar Quiz')

import { collection, doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase.js';
import { queueWrite } from './queuedWrite.js';

export async function createCorrectionNote({ uid, title, rows, sourceLabel }) {
  if (!uid) return null;
  try {
    const payload = {
      type:       'correction',
      title,
      sourceId:   null,
      sectionId:  null,
      sourceLabel: sourceLabel || 'Grammar Quiz',
      rows:       rows.map(r => ({
        topic:     r.topic     || 'quiz',
        original:  r.original  || '',
        corrected: r.corrected || '',
      })),
      createdAt: new Date().toISOString(),
    };
    // S6: the id is made here and the write queued, so a quiz finish never
    // waits on the network (the note syncs when there's a connection).
    const ref = doc(collection(db, 'users', uid, 'notes'));
    queueWrite(() => setDoc(ref, payload), 'createCorrectionNote: failed');
    return { id: ref.id, ...payload };
  } catch (e) {
    console.error('createCorrectionNote: failed', e);
    return null;
  }
}
