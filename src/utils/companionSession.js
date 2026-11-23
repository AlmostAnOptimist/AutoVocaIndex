// src/utils/companionSession.js
// The reading companion's session list (RC-D12) and its copy in Recent's
// "Last session" tab (RC-D13).
//
// The companion keeps the list in memory; it starts empty each time the
// companion opens. Each change also saves the whole list to one doc,
// users/{uid}/companion/lastSession, so Recent on any device shows the most
// recent session (including one still going). A new session's first entry
// replaces the doc. Its own doc, so it never touches settings/main.

import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from '../firebase.js';

const sessionDoc = (uid) => doc(db, 'users', uid, 'companion', 'lastSession');

export function newSessionId() {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// What one stage result says, in the list's words. Pure.
//   kind   — 'word' | 'sentence'
//   status — 'new' | 'existing' | 'duplicate' | 'skipped'
export function entryNote({ kind, status, def2Saved = false, section = '' }) {
  const what = kind === 'sentence' ? 'Sentence' : 'Word';
  if (status === 'duplicate') return `Already in ${section ? `§${section}` : 'this source'} · not added`;
  if (status === 'skipped')   return `${what} · added as skipped`;
  const lemma = status === 'new' ? 'new lemma' : 'already in Lemma Master';
  return `${what} · ${lemma}${def2Saved ? ', def2 saved' : ''}`;
}

// One list entry. `word` is what was added (the lemma), `query` what to
// search for in AVI's Search tab.
export function makeEntry({ kind, status, word, rowUid = null, source = '', section = '', def2Saved = false, at }) {
  return {
    id: `${kind}_${rowUid || word}_${Math.random().toString(36).slice(2, 7)}`,
    kind, status, word: word || '', rowUid: rowUid || null,
    source: source || '', section: section == null ? '' : String(section),
    note: entryNote({ kind, status, def2Saved, section }),
    at: at || new Date().toISOString(),
  };
}

export async function saveCompanionSession(uid, session) {
  if (!uid || !session) return;
  // No undefined values reach Firestore (null instead).
  const clean = {
    sessionId: session.sessionId,
    startedAt: session.startedAt,
    updatedAt: new Date().toISOString(),
    entries: (session.entries || []).map(e => ({
      id: e.id, kind: e.kind, status: e.status, word: e.word || '',
      rowUid: e.rowUid || null, source: e.source || '', section: e.section || '',
      note: e.note || '', at: e.at || '',
    })),
  };
  await setDoc(sessionDoc(uid), clean);
}

export async function loadCompanionSession(uid) {
  if (!uid) return null;
  const snap = await getDoc(sessionDoc(uid));
  return snap.exists() ? snap.data() : null;
}
