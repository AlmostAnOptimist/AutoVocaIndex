// src/components/GrammarRecognition.jsx
// The "Recognition" part of a Grammar Index entry (audit G3, decision GS-D3):
// how the entry's pattern is read, whether it is found in its own examples, the
// switch for collecting sightings, and an optional hint.
//
//   entry.sightingsOff   true = don't collect sightings for this entry.
//                        Absent or false = collect (every entry starts on).
//   entry.patternHint    a pattern in the same notation as titles; when
//                        present it replaces the title for recognition.
//
// Neither field touches the entry's card, its audio or its mastery; they
// are saved through the page's ordinary entry save.
//
// The analyser loads the first time this part is opened. Typing a hint
// shows how it would be read before it is saved.

import { useState, useEffect, useMemo } from 'react';
import { loadAnalyser } from '../utils/koreanAnalyser.js';
import { checkEntry } from '../utils/grammarPatternCheck.js';
import { SH } from '../theme/buildStyles.js';
import { isSubmitEnter } from '../utils/keyUtils.js';

export function GrammarRecognition({ entry, onSave, readOnly = false, C }) {
  const [analyse, setAnalyse] = useState(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState(entry.patternHint || '');

  useEffect(() => {
    let live = true;
    loadAnalyser().then(
      (a) => { if (live) setAnalyse(() => a); },
      (e) => { console.error('Grammar Index: the analyser could not be loaded', e); if (live) setFailed(true); },
    );
    return () => { live = false; };
  }, []);

  const saved = String(entry.patternHint || '').trim();
  const typed = draft.trim();
  const result = useMemo(() => (analyse ? checkEntry(entry, analyse, typed) : null), [analyse, entry, typed]);

  const commitHint = () => { if (!readOnly && typed !== saved) onSave({ patternHint: typed }); };
  const on = !entry.sightingsOff;

  const small = { fontSize: '12px', color: C.textS, lineHeight: 1.6 };
  const dim = { color: C.textM };
  const kr = { fontFamily: SH.fk, color: C.text };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: C.text, cursor: readOnly ? 'default' : 'pointer' }}>
        <input type="checkbox" checked={on} disabled={readOnly} onChange={e => onSave({ sightingsOff: !e.target.checked })} />
        Collect sightings for this entry
      </label>

      <div style={small}>
        {failed && <span style={{ color: C.danger }}>The recogniser could not be loaded. Check the connection and open this part again.</span>}
        {!failed && !result && <span style={dim}>Loading…</span>}
        {result && result.kind === 'topic' && <span>This entry names a topic, not a form, so there is nothing to recognise. A hint can give it one.</span>}
        {result && result.kind === 'unread' && <span style={{ color: C.warning }}>This could not be read as a pattern.</span>}
        {result && result.reads.length > 0 && (
          <div>
            <span style={dim}>Read as{typed ? (typed === saved ? ' (from the hint)' : ' (the hint as typed, not saved yet)') : ''}: </span>
            {result.reads.map((r, i) => <span key={r}>{i > 0 && <span style={dim}>{'  |  '}</span>}<span style={kr}>{r}</span></span>)}
            {result.writtenForm && <span style={dim}> (also by its written form)</span>}
          </div>
        )}
        {result && result.lines > 0 && (
          <div style={{ marginTop: '4px' }}>
            Found in <span style={{ fontFamily: SH.fm, color: C.text }}>{result.found}</span> of <span style={{ fontFamily: SH.fm, color: C.text }}>{result.lines}</span> of its example lines.
            {result.missed.map(line => <div key={line} style={{ ...kr, paddingLeft: '12px', color: C.textS }}>— {line}</div>)}
          </div>
        )}
        {result && result.lines === 0 && result.kind !== 'topic' && <div style={{ ...dim, marginTop: '4px' }}>No examples yet to check it against.</div>}
      </div>

      <div>
        <div style={{ ...small, ...dim, marginBottom: '4px' }}>
          Hint (optional): the pattern written as in a title, used in place of the title. Separate several with " / ".
        </div>
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commitHint}
          onKeyDown={e => { if (isSubmitEnter(e)) { e.preventDefault(); e.currentTarget.blur(); } }}
          placeholder="~다가 / ~았/었다가"
          style={{
            width: '100%', boxSizing: 'border-box', padding: '7px 10px', borderRadius: '6px',
            border: `1px solid ${C.border}`, background: C.surface, color: C.text,
            fontFamily: SH.fk, fontSize: '13px',
          }}
        />
      </div>
    </div>
  );
}
