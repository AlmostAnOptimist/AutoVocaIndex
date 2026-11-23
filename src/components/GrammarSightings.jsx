// src/components/GrammarSightings.jsx
// The sightings review (audit G3, decisions GS-D6 and GS-D10 to GS-D15).
// Opened from
// the Grammar Index.
//
// Three views in one panel:
//   the list    finished sections (and finished sources' section-less
//               sentences) that await review, by source, each with how many
//               sightings it holds
//   a review    one unit's sightings grouped by entry
//   one entry   (entryId given) every sighting of that entry across all the
//               sentences the user has mined, finished or reviewed or not: an
//               entry's own "from your sentences"
//
// In a review and for one entry, Add puts a sentence among an entry's
// examples and Replace puts it in the place of one of them. Choices are
// held and can be undone; nothing is written until Save, which saves each
// changed entry once (so its audio is re-recorded once). Finishing a unit's
// review also stamps the unit as reviewed; one entry's view stamps nothing.
//
// The list and a review each offer "Open in Library" for the source the
// sentences came from (onOpenSource), the way back for a review opened from
// the Library's mark.
//
// This component writes nothing itself: entries are saved through
// onSaveEntry (the Grammar Index's ordinary entry save) and the stamp
// through onStampUnit.
//
// The analyser loads when this opens. Reading the entries' patterns takes
// a moment, so it is done once and again only when a title or hint changes.

import { useState, useEffect, useMemo } from 'react';
import { loadAnalyser } from '../utils/koreanAnalyser.js';
import {
  MAX_EXAMPLES, PER_ENTRY, patternSignature, compileEntries, sightingGroups, countSightings, keepSightings, exampleOrigin,
  minedSentences, groupOf,
} from '../utils/grammarSightings.js';
import { SH } from '../theme/buildStyles.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const ENTRY_FIRST = 6;    // candidates shown at first in one entry's view
const SCAN_STEP = 40;     // sentences looked through between two repaints

// A sentence with the matched words marked.
function Marked({ sentence, marks, C }) {
  const spans = [...marks].sort((a, b) => a[0] - b[0]);
  const out = [];
  let at = 0;
  spans.forEach(([from, to], i) => {
    if (to <= at) return;
    const start = Math.max(from, at);
    if (start > at) out.push(<span key={`t${i}`}>{sentence.slice(at, start)}</span>);
    out.push(<span key={`m${i}`} style={{ color: C.accent, borderBottom: `1px solid ${C.accent}88` }}>{sentence.slice(start, to)}</span>);
    at = to;
  });
  if (at < sentence.length) out.push(<span key="end">{sentence.slice(at)}</span>);
  return <>{out}</>;
}

export function GrammarSightings({ units, entries, sentenceRows, entryId = null, onSaveEntry, onStampUnit, onOpenSource, onClose, startUnitKey = null, C, S }) {
  const [analyse, setAnalyse] = useState(null);
  const [failed, setFailed] = useState(false);
  const [compiled, setCompiled] = useState(null);       // { sig, list }
  const [counts, setCounts] = useState({});              // unit key -> { sig, sightings, entries }
  const [unitKey, setUnitKey] = useState(startUnitKey);
  const [choices, setChoices] = useState({});            // entry id -> [{ sentence, replace, source, section }]
  const [picking, setPicking] = useState(null);          // { entryId, cand }: choosing the example to replace
  const [more, setMore] = useState({});                  // entry id -> how many candidates are shown
  const [scan, setScan] = useState({ done: 0, total: 0, candidates: [], finished: false });   // one entry's view

  useEffect(() => {
    let live = true;
    loadAnalyser().then(
      (a) => { if (live) setAnalyse(() => a); },
      (e) => { console.error('Sightings: the analyser could not be loaded', e); if (live) setFailed(true); },
    );
    return () => { live = false; };
  }, []);

  // Read the entries' patterns once the analyser is in, and again only when
  // a title or hint has changed.
  const sig = useMemo(() => patternSignature(entries), [entries]);
  useEffect(() => {
    if (!analyse || compiled?.sig === sig) return undefined;
    let live = true;
    const t = setTimeout(() => { if (live) setCompiled({ sig, list: compileEntries(entries, analyse) }); }, 0);
    return () => { live = false; clearTimeout(t); };
  }, [analyse, sig, entries, compiled]);
  const ready = !!analyse && compiled?.sig === sig;

  // Count each listed unit's sightings, one unit at a time so the list
  // stays responsive. A unit is counted again when its sentences change.
  useEffect(() => {
    if (!ready || unitKey || entryId) return undefined;
    let live = true;
    (async () => {
      for (const u of units) {
        const usig = `${sig}\u0002${u.sentences.length}\u0002${u.reviewedAt || ''}`;
        if (counts[u.key]?.sig === usig) continue;
        await new Promise(r => setTimeout(r, 0));
        if (!live) return;
        const groups = sightingGroups({ entries, sentences: u.sentences, compiled: compiled.list, analyse });
        setCounts(prev => ({ ...prev, [u.key]: { sig: usig, sightings: countSightings(groups), entries: groups.length } }));
        return;   // the state change runs this effect again for the next unit
      }
    })();
    return () => { live = false; };
  }, [ready, unitKey, entryId, units, counts, sig, entries, compiled, analyse]);

  // One entry's view: look through everything the user has mined, a stretch at a
  // time. Done once per opening; the view closes on Save.
  const mined = useMemo(() => (entryId ? minedSentences(sentenceRows) : []), [entryId, sentenceRows]);
  useEffect(() => {
    if (!entryId || !ready || scan.finished) return undefined;
    let live = true;
    const t = setTimeout(() => {
      if (!live) return;
      const next = mined.slice(scan.done, scan.done + SCAN_STEP);
      const found = sightingGroups({ entries, sentences: next, compiled: compiled.list, analyse, opts: { only: entryId, includeOff: true } })[0]?.candidates || [];
      const done = Math.min(scan.done + SCAN_STEP, mined.length);
      setScan({ done, total: mined.length, candidates: [...scan.candidates, ...found], finished: done >= mined.length });
    }, 0);
    return () => { live = false; clearTimeout(t); };
  }, [entryId, ready, scan, mined, entries, compiled, analyse]);

  const unit = !entryId && unitKey ? units.find(u => u.key === unitKey) || null : null;
  const groups = useMemo(() => {
    if (!unit || !ready) return null;
    const sentences = unit.sentences.map(sentence => ({ sentence, source: unit.sourceTitle, section: unit.sectionName || null }));
    return sightingGroups({ entries, sentences, compiled: compiled.list, analyse });
  }, [unit, ready, entries, compiled, analyse]);
  const ownEntry = entryId ? entries.find(e => e.id === entryId) || null : null;
  const ownGroup = useMemo(() => (ownEntry ? groupOf(ownEntry, scan.candidates) : null), [ownEntry, scan.candidates]);

  const openUnit = (key) => { setUnitKey(key); setChoices({}); setPicking(null); setMore({}); };
  const backToList = () => { setUnitKey(null); setChoices({}); setPicking(null); setMore({}); };

  const chosen = (id, sentence) => (choices[id] || []).find(c => c.sentence === sentence) || null;
  const unchoose = (id, sentence) => setChoices(prev => ({ ...prev, [id]: (prev[id] || []).filter(c => c.sentence !== sentence) }));
  const choose = (id, cand, replace) => {
    setChoices(prev => ({ ...prev, [id]: [...(prev[id] || []).filter(c => c.sentence !== cand.sentence),
      { sentence: cand.sentence, replace: replace ?? null, source: cand.source ?? null, section: cand.section ?? null }] }));
    setPicking(null);
  };
  const nChanges = Object.values(choices).reduce((n, list) => n + list.length, 0);

  const saveChoices = () => {
    for (const [id, list] of Object.entries(choices)) {
      if (!list.length) continue;
      const entry = entries.find(e => e.id === id);
      if (!entry) continue;
      const kept = keepSightings(entry, list);
      if (kept.changed) onSaveEntry(id, { examples: kept.examples, exampleSources: kept.exampleSources });
    }
  };
  const finish = () => {
    if (!unit) return;
    saveChoices();
    onStampUnit(unit, new Date().toISOString());
    backToList();
  };
  const saveOwn = () => { saveChoices(); onClose(); };

  const empties = units.filter(u => counts[u.key]?.sightings === 0);
  const counted = units.every(u => counts[u.key]);

  // ── Styles ──
  const kr = { fontFamily: SH.fk, fontSize: '14px', lineHeight: 1.65, color: C.text };
  const label = { fontSize: '10px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.textM };
  const faint = { fontSize: '11px', color: C.textM, fontFamily: SH.fm };
  const chip = (strong, on) => ({
    fontSize: '11px', padding: '3px 10px', borderRadius: '6px', cursor: 'pointer', whiteSpace: 'nowrap',
    border: `1px solid ${strong || on ? C.accent : C.border}`, background: on ? C.accentSoft : 'transparent',
    color: strong || on ? C.accent : C.textS, fontWeight: strong || on ? 600 : 400,
  });
  const head = { padding: '18px 22px 12px', flexShrink: 0 };
  const body = { padding: '0 22px 6px', overflowY: 'auto', flex: 1, minHeight: 0 };
  const foot = { padding: '14px 22px', borderTop: `1px solid ${C.border}`, display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', background: C.raised, flexShrink: 0 };
  const sub = { fontSize: '12.5px', color: C.textS, marginTop: '4px', lineHeight: 1.55 };
  const unitName = (u) => (u.kind === 'source' ? 'Sentences with no section' : u.sectionName);
  // The way back to where the sentences came from: the source in the
  // Library. Leaving drops any held choices, so it is offered only while
  // there are none.
  const toLibrary = (sourceId, held) => onOpenSource && (
    <button data-open-source={sourceId} disabled={held} onClick={() => onOpenSource(sourceId)}
      title={held ? 'Save or drop your choices first: leaving this review would lose them.' : 'Open this source in the Library'}
      style={{ fontSize: '11px', padding: '2px 9px', borderRadius: '6px', background: 'transparent', color: held ? C.textM : C.textS, border: `1px solid ${C.border}`, cursor: held ? 'default' : 'pointer', opacity: held ? 0.5 : 1, whiteSpace: 'nowrap', fontFamily: 'inherit', fontWeight: 400 }}>
      Open in Library
    </button>
  );
  const noAnalyser = <span style={{ color: C.danger }}>The recogniser could not be loaded. Check the connection, then close this and open it again.</span>;

  // ── One entry's examples and candidates (a review and one entry's view) ──
  const renderGroup = (g, { from, first, origins, title }) => {
    const mine = choices[g.entryId] || [];
    const adds = mine.filter(c => !c.replace).length;
    const room = g.lines.length + adds < MAX_EXAMPLES;
    const taken = new Set(mine.filter(c => c.replace).map(c => c.replace));
    const pickingHere = picking && picking.entryId === g.entryId ? picking : null;
    const showing = more[g.entryId] || first;
    const entry = entries.find(e => e.id === g.entryId);
    return (
      <div key={g.entryId} data-entry={g.entryId} style={{ padding: '14px 0', borderTop: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '8px', flexWrap: 'wrap' }}>
          {title && <span style={{ fontFamily: SH.fk, fontSize: '16px', fontWeight: 700, color: C.text }}>{g.term}</span>}
          {title && <span style={faint}>#{g.number ?? '?'}</span>}
          <span style={{ ...faint, marginLeft: title ? 'auto' : 0 }}>
            {g.lines.length === 0 ? 'no examples yet' : g.full ? `${g.lines.length} of ${MAX_EXAMPLES} · full, replace only` : `${g.lines.length} of ${MAX_EXAMPLES} examples`}
          </span>
        </div>
        {g.lines.length > 0 && (
          <div style={{ marginBottom: '8px' }}>
            <div style={{ ...label, marginBottom: '4px' }}>
              Its examples now
              {pickingHere && <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400, color: C.accent }}> · tap the one it should replace</span>}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
              {g.lines.map((line, i) => {
                const gone = taken.has(line);
                const can = !!pickingHere && !gone;
                const origin = exampleOrigin(entry, line);
                return (
                  <div key={i} data-example={line} role={can ? 'button' : undefined}
                    onClick={can ? () => choose(g.entryId, pickingHere.cand, line) : undefined}
                    style={{ display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap', padding: pickingHere ? '4px 8px' : '0 8px', borderRadius: '6px', cursor: can ? 'pointer' : 'default',
                      border: pickingHere ? `1px dashed ${gone ? C.accent : (C.borderB || C.border)}` : '1px solid transparent', background: gone ? C.accentSoft : 'transparent' }}>
                    <span style={{ ...kr, fontSize: '13px', color: gone ? C.textM : C.textS, textDecoration: gone ? 'line-through' : 'none' }}>{line}</span>
                    {origin && <span style={faint}>{origin}</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {g.candidates.length > 0 && <div style={{ ...label, marginBottom: '4px' }}>{from}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {g.candidates.slice(0, showing).map(cand => {
            const mineHere = chosen(g.entryId, cand.sentence);
            const isPicking = pickingHere && pickingHere.cand.sentence === cand.sentence;
            const where = origins && cand.source ? (cand.section ? `${cand.source} · ${cand.section}` : cand.source) : '';
            return (
              <div key={cand.sentence} data-candidate={cand.sentence} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', flexWrap: 'wrap', padding: '7px 10px', borderRadius: '8px', background: C.raised, border: `1px solid ${isPicking ? C.accent : C.border}` }}>
                <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                  <span style={kr}><Marked sentence={cand.sentence} marks={cand.marks} C={C} /></span>
                  {where && <div style={{ ...faint, marginTop: '1px' }}>{where}</div>}
                  {mineHere && <div style={{ ...faint, color: C.accent, marginTop: '2px' }}>{mineHere.replace ? <>Will replace: <span style={{ fontFamily: SH.fk }}>{mineHere.replace}</span></> : 'Will be added'}</div>}
                </div>
                <div style={{ display: 'flex', gap: '6px', flexShrink: 0, marginTop: '2px', marginLeft: 'auto' }}>
                  {mineHere ? (
                    <button style={chip(false, true)} onClick={() => unchoose(g.entryId, cand.sentence)}>{mineHere.replace ? '✓ Replacing' : '✓ Added'} · Undo</button>
                  ) : isPicking ? (
                    <button style={chip(false, true)} onClick={() => setPicking(null)}>Cancel</button>
                  ) : (
                    <>
                      {room && <button style={chip(true)} onClick={() => choose(g.entryId, cand, null)}>Add</button>}
                      {g.lines.length > taken.size && <button style={chip(!room)} onClick={() => setPicking({ entryId: g.entryId, cand })}>Replace…</button>}
                    </>
                  )}
                </div>
              </div>
            );
          })}
          {g.candidates.length > showing && (
            <button onClick={() => setMore(prev => ({ ...prev, [g.entryId]: g.candidates.length }))}
              style={{ ...faint, textAlign: 'left', padding: '2px 10px', background: 'none', border: 'none', cursor: 'pointer' }}>
              Show {g.candidates.length - showing} more
            </button>
          )}
        </div>
      </div>
    );
  };

  // ── The list ──
  const bySource = [];
  for (const u of units) {
    const last = bySource[bySource.length - 1];
    if (last && last.sourceId === u.sourceId) last.units.push(u); else bySource.push({ sourceId: u.sourceId, title: u.sourceTitle, units: [u] });
  }
  const list = (
    <>
      <div style={head}>
        <div style={label}>Sightings to review</div>
        <div style={{ ...sub, marginTop: '6px' }}>
          {units.length === 0
            ? 'Nothing is waiting. A section appears here once it is finished and has sentences you mined from it.'
            : `${plural(units.length, 'finished section has', 'finished sections have')} sentences not yet looked through for grammar you keep entries on.`}
        </div>
        {failed && <div style={{ ...sub, marginTop: '6px' }}>{noAnalyser}</div>}
      </div>
      <div style={{ ...body, paddingBottom: '10px' }}>
        {bySource.map(src => (
          <div key={src.sourceId} style={{ padding: '12px 0', borderTop: `1px solid ${C.border}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
              <span style={{ fontSize: '14px', fontWeight: 600, color: C.text, flex: 1, minWidth: 0 }}>{src.title}</span>
              {toLibrary(src.sourceId, false)}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              {src.units.map(u => {
                const c = counts[u.key];
                return (
                  <button key={u.key} onClick={() => openUnit(u.key)} disabled={failed} data-unit={u.key}
                    style={{ display: 'flex', alignItems: 'baseline', gap: '10px', textAlign: 'left', padding: '7px 10px', borderRadius: '8px', background: C.raised, border: `1px solid ${C.border}`, cursor: failed ? 'default' : 'pointer', color: C.text }}>
                    <span style={{ fontSize: '13px', flex: 1, minWidth: 0 }}>{unitName(u)}</span>
                    <span style={faint}>{plural(u.sentences.length, 'sentence', 'sentences')}</span>
                    <span style={{ ...faint, color: c && c.sightings > 0 ? C.accent : C.textM, minWidth: '86px', textAlign: 'right' }}>
                      {!c ? (failed ? '' : '…') : c.sightings === 0 ? 'no sightings' : plural(c.sightings, 'sighting', 'sightings')}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div style={foot}>
        {counted && empties.length > 0 && (
          <button style={S.btnGhost} onClick={() => { const at = new Date().toISOString(); empties.forEach(u => onStampUnit(u, at)); }}>
            Clear the {empties.length} with no sightings
          </button>
        )}
        <button style={{ ...S.btnGhost, marginLeft: 'auto' }} onClick={onClose}>Close</button>
      </div>
    </>
  );

  // ── A review ──
  const review = unit && (
    <>
      <div style={head}>
        <div style={label}>Sightings to review</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '4px' }}>
          <span style={{ fontSize: '18px', fontWeight: 600, color: C.text, flex: '1 1 auto', minWidth: 0 }}>
            {unit.sourceTitle} <span style={{ color: C.textM, fontWeight: 400 }}>· {unitName(unit)}</span>
          </span>
          {toLibrary(unit.sourceId, nChanges > 0)}
        </div>
        <div style={sub}>
          {failed ? noAnalyser
            : !groups ? 'Reading your entries…'
            : groups.length === 0 ? `None of these ${plural(unit.sentences.length, 'sentence', 'sentences')} shows an entry that collects sightings.`
            : `${plural(countSightings(groups), 'sighting', 'sightings')} in ${plural(groups.length, 'entry', 'entries')}, from ${plural(unit.sentences.length, 'sentence', 'sentences')}. Nothing is saved until you press Save.`}
        </div>
      </div>
      <div style={body}>{(groups || []).map(g => renderGroup(g, { from: 'From this section', first: PER_ENTRY, origins: false, title: true }))}</div>
      <div style={foot}>
        <span style={faint}>{nChanges > 0 ? `${plural(nChanges, 'change', 'changes')} ready` : ''}</span>
        <button style={{ ...S.btnGhost, marginLeft: 'auto' }} onClick={backToList}>Not now</button>
        <button style={{ ...S.btnPrimary, opacity: groups ? 1 : 0.5 }} disabled={!groups} onClick={finish}>
          {nChanges > 0 ? 'Save and finish' : 'Finish, nothing to keep'}
        </button>
      </div>
    </>
  );

  // ── One entry's view ──
  const own = entryId && (
    <>
      <div style={head}>
        <div style={label}>From your sentences</div>
        <div style={{ fontFamily: SH.fk, fontSize: '18px', fontWeight: 700, marginTop: '4px', color: C.text }}>
          {ownEntry?.glossaryTerm || ''} <span style={{ ...faint, fontWeight: 400 }}>#{ownEntry?.entryNumber ?? '?'}</span>
        </div>
        <div style={sub}>
          {failed ? noAnalyser
            : !ownEntry ? 'This entry is no longer there.'
            : !ready ? 'Reading your entries…'
            : !scan.finished ? `Looking through your sentences… ${scan.done} of ${scan.total}`
            : scan.candidates.length === 0 ? `None of the ${plural(scan.total, 'sentence', 'sentences')} you have mined shows this entry${ownGroup?.lines.length ? ' beyond its examples' : ''}.`
            : `${plural(scan.candidates.length, 'sighting', 'sightings')} in the ${plural(scan.total, 'sentence', 'sentences')} you have mined. Nothing is saved until you press Save.`}
        </div>
      </div>
      <div style={body}>{ownGroup && ready && renderGroup(ownGroup, { from: 'From your sentences', first: ENTRY_FIRST, origins: true, title: false })}</div>
      <div style={foot}>
        <span style={faint}>{nChanges > 0 ? `${plural(nChanges, 'change', 'changes')} ready` : ''}</span>
        <button style={{ ...S.btnGhost, marginLeft: 'auto' }} onClick={onClose}>{nChanges > 0 ? 'Close without saving' : 'Close'}</button>
        {nChanges > 0 && <button style={S.btnPrimary} onClick={saveOwn}>Save</button>}
      </div>
    </>
  );

  return (
    <div style={S.overlay} onClick={unit || entryId ? undefined : onClose}>
      <div onClick={e => e.stopPropagation()} data-sightings={entryId ? 'entry' : unit ? 'review' : 'list'}
        style={{ width: '100%', maxWidth: '640px', maxHeight: '100%', display: 'flex', flexDirection: 'column', background: C.surface, color: C.text, border: `1px solid ${C.border}`, borderRadius: '14px', overflow: 'hidden' }}>
        {entryId ? own : unit ? review : list}
      </div>
    </div>
  );
}
