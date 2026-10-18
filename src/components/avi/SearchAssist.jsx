// src/components/avi/SearchAssist.jsx
// L4b: small shared pieces for the Word Input / Sentence Input search bars
// and the Import review list.
//   SearchAnchorNote — "Also showing rows for 탐방로" when the query is
//                      another form of a lemma you study
//   DidYouMean       — suggestion chips when a search matches nothing;
//                      tapping one replaces the search text
//   LemmaChoiceChips — Lemma Master matches under an Import review term;
//                      tapping one sets the term's lemma. L3: also the
//                      other dictionary readings of the form ("Or:")

import { SH } from '../../theme/buildStyles.js';

const chip = (C, active = false) => ({
  display: 'inline-flex', alignItems: 'center', gap: '5px',
  background: active ? C.accentSoft : 'transparent',
  border: `1px solid ${active ? C.accent : C.border}`,
  borderRadius: '999px', color: active ? C.accent : C.textS,
  cursor: 'pointer', fontSize: '11.5px', fontFamily: SH.fk, padding: '2px 10px',
});

export function SearchAnchorNote({ anchor, query, C }) {
  if (!anchor) return null;
  return (
    <div style={{ fontSize: '11.5px', color: C.textM, padding: '6px 12px' }}>
      Also showing rows for <span style={{ fontFamily: SH.fk, color: C.accent }}>{anchor.lemma}</span>
      {query ? <> (dictionary form of <span style={{ fontFamily: SH.fk }}>{query}</span>)</> : null}
    </div>
  );
}

export function DidYouMean({ suggestions, onPick, C }) {
  if (!suggestions || suggestions.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: '6px', marginTop: '10px' }}>
      <span style={{ fontSize: '12px', color: C.textM }}>Did you mean</span>
      {suggestions.map(s => (
        <button key={s.lemmaID || s.lemma} onClick={() => onPick(s.lemma)} style={chip(C, true)}>
          {s.lemma}
        </button>
      ))}
    </div>
  );
}

export function LemmaChoiceChips({ current, choices, alternates = [], onPick, disabled = false, C }) {
  const hasAlts = alternates && alternates.length > 0;
  if (!current && (!choices || choices.length === 0) && !hasAlts) return null;
  const tag = (hasDef2) => (
    <span style={{ fontFamily: SH.fm, fontSize: '9.5px', color: hasDef2 ? C.accent : C.textM }}>
      {hasDef2 ? 'def2' : 'no def2'}
    </span>
  );
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', paddingLeft: '28px' }}>
      {hasAlts && (
        <>
          <span style={{ fontSize: '11px', color: C.textM }}>Or:</span>
          {alternates.map(a => (
            <button
              key={`alt-${a}`}
              onClick={() => onPick(a)}
              disabled={disabled}
              title="Another dictionary reading of this form"
              style={{ ...chip(C), opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer' }}
            >
              {a}
            </button>
          ))}
        </>
      )}
      {current && (
        <span style={{ fontSize: '11px', color: C.textM }}>
          In Lemma Master {current.hasDef2 ? '— its def2 comes with it' : '— no def2 yet'}
        </span>
      )}
      {choices && choices.length > 0 && (
        <>
          <span style={{ fontSize: '11px', color: C.textM }}>{current ? 'Also:' : 'In Lemma Master:'}</span>
          {choices.map(c => (
            <button
              key={c.lemmaID}
              onClick={() => onPick(c.lemma)}
              disabled={disabled}
              title={c.why}
              style={{ ...chip(C), opacity: disabled ? 0.5 : 1, cursor: disabled ? 'default' : 'pointer' }}
            >
              {c.lemma} {tag(c.hasDef2)}
            </button>
          ))}
        </>
      )}
    </div>
  );
}
