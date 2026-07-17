// src/pages/avi/AVIRecentPage.jsx
// AVI Recent tab — shows entries reset by Lemma Master edits.
// Displays wordInputs and sentenceInputs where lastUncheckReason !== ''.
// "Looks good" clears the reason and restores uploaded=true.
// The linked flashcard was already updated by the Lemma Master cascade.

import { useState, useMemo } from 'react';
import { useAppTheme } from '../../hooks/useAppTheme.js';
import { SH } from '../../theme/buildStyles.js';

const SECTION_TABS = [
  { id: 'words',     label: 'Words'     },
  { id: 'sentences', label: 'Sentences' },
];

export function AVIRecentPage({
  data, updateData,
  aviSources, aviSections,
  goToSource, showAVIToast,
}) {
  const { C } = useAppTheme();
  const [activeSection, setActiveSection] = useState('words');
  const [srcFilter, setSrcFilter]         = useState('');
  const [secFilter, setSecFilter]         = useState('(All)');

  // ── Filter helpers ───────────────────────────────────────────
  const matchFilter = (row) => {
    if (srcFilter && row.source !== srcFilter) return false;
    if (secFilter && secFilter !== '(All)' && String(row.section) !== String(secFilter)) return false;
    return true;
  };

  // ── Reset entries (have lastUncheckReason, not skipped) ──────
  const resetWords = useMemo(() =>
    data.wordInputs
      .filter(w => w.lastUncheckReason && !w.skipUpload && matchFilter(w))
      .sort((a, b) => (b.lastUncheckDate || '').localeCompare(a.lastUncheckDate || '')),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.wordInputs, srcFilter, secFilter]
  );

  const resetSentences = useMemo(() =>
    data.sentenceInputs
      .filter(s => s.lastUncheckReason && !s.skipUpload && matchFilter(s))
      .sort((a, b) => (b.lastUncheckDate || '').localeCompare(a.lastUncheckDate || '')),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.sentenceInputs, srcFilter, secFilter]
  );

  const totalReset = resetWords.length + resetSentences.length;

  // ── "Looks good" — clear reason, restore uploaded ───────────
  const handleWordOk = (uid) => {
    updateData(prev => ({
      ...prev,
      wordInputs: prev.wordInputs.map(w =>
        w.uid === uid
          ? { ...w, uploaded: true, lastUncheckReason: '', lastUncheckDate: '' }
          : w
      ),
    }));
  };

  const handleSentenceOk = (uid) => {
    updateData(prev => ({
      ...prev,
      sentenceInputs: prev.sentenceInputs.map(s =>
        s.uid === uid
          ? { ...s, uploaded: true, lastUncheckReason: '', lastUncheckDate: '' }
          : s
      ),
    }));
  };

  // ── Bulk acknowledge ─────────────────────────────────────────
  const handleAcknowledgeAll = () => {
  const count = totalReset;
  updateData(prev => ({
    ...prev,
    wordInputs: prev.wordInputs.map(w =>
      w.lastUncheckReason && !w.skipUpload
        ? { ...w, uploaded: true, lastUncheckReason: '', lastUncheckDate: '' }
        : w
    ),
    sentenceInputs: prev.sentenceInputs.map(s =>
      s.lastUncheckReason && !s.skipUpload
        ? { ...s, uploaded: true, lastUncheckReason: '', lastUncheckDate: '' }
        : s
    ),
  }));
  showAVIToast(`${count} entr${count === 1 ? 'y' : 'ies'} acknowledged.`, 'goToFlashcards');
};

  // ── Section options for current source ───────────────────────
  const activeSrc  = aviSources.find(s => s.title === srcFilter);
  const secNumbers = activeSrc
    ? aviSections
        .filter(s => s.resourceId === activeSrc.id)
        .sort((a, b) => {
          const na = parseInt((a.content || '').match(/(\d+)$/)?.[1]) || 0;
          const nb = parseInt((b.content || '').match(/(\d+)$/)?.[1]) || 0;
          return na - nb;
        })
        .map(s => (s.content || '').match(/(\d+)$/)?.[1] || s.content)
    : [];

  // ── Styles ───────────────────────────────────────────────────
  const thStyle = {
    padding: '7px 10px', fontSize: '10px', fontWeight: 700,
    letterSpacing: '0.07em', textTransform: 'uppercase', color: C.textM,
    borderBottom: `2px solid ${C.border}`, textAlign: 'left', whiteSpace: 'nowrap',
    position: 'sticky', top: 0, background: C.raised, zIndex: 1,
  };
  const tdStyle = {
    padding: '7px 10px', fontSize: '12px', color: C.text,
    verticalAlign: 'top', borderBottom: `1px solid ${C.border}`,
  };
  const selectStyle = {
    fontSize: '12px', padding: '4px 8px', borderRadius: '6px',
    border: `1px solid ${C.border}`, background: C.raised,
    color: C.text, cursor: 'pointer', outline: 'none',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

      {/* ── Header ─────────────────────────────────────────── */}
      <div style={{ flexShrink: 0, marginBottom: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>

          {/* Source/section filters */}
          <select value={srcFilter} onChange={e => { setSrcFilter(e.target.value); setSecFilter('(All)'); }} style={selectStyle}>
            <option value="">All Sources</option>
            {aviSources.map(s => <option key={s.id} value={s.title}>{s.title}</option>)}
          </select>
          <select
            value={secFilter}
            onChange={e => setSecFilter(e.target.value)}
            disabled={!activeSrc || secNumbers.length === 0}
            style={{ ...selectStyle, opacity: (!activeSrc || secNumbers.length === 0) ? 0.4 : 1 }}
          >
            <option value="(All)">(All Sections)</option>
            {secNumbers.map(n => <option key={n} value={String(n)}>§{n}</option>)}
          </select>

          {/* Count badge */}
          <span style={{ fontSize: '12px', color: C.textM, fontFamily: SH.fm }}>
            {totalReset > 0
              ? <><span style={{ color: C.warning, fontWeight: 600 }}>{totalReset}</span> entries need review</>
              : <span style={{ color: C.success }}>✓ All caught up</span>
            }
          </span>

          {/* Acknowledge all */}
          {totalReset > 0 && (
            <button
              onClick={handleAcknowledgeAll}
              style={{
                marginLeft: 'auto', padding: '5px 14px', borderRadius: '6px',
                fontSize: '12px', fontWeight: 600,
                border: `1px solid ${C.border}`, background: C.raised,
                color: C.textM, cursor: 'pointer',
              }}
            >
              Acknowledge all
            </button>
          )}
        </div>

        {/* Section tabs */}
        <div style={{ display: 'flex', gap: '4px', background: C.cardBg || C.surface, border: `1px solid ${C.border}`, padding: '4px', borderRadius: '12px', width: 'fit-content' }}>
          {SECTION_TABS.map(t => {
            const count = t.id === 'words' ? resetWords.length : resetSentences.length;
            const active = activeSection === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setActiveSection(t.id)}
                style={{
                  padding: '6px 14px', borderRadius: '8px', fontSize: '12.5px', fontWeight: 500,
                  color: active ? C.text : C.textS, cursor: 'pointer', transition: 'all 0.15s',
                  background: active ? C.raised : 'transparent',
                  boxShadow: active ? '0 1px 4px rgba(0,0,0,0.2)' : 'none',
                  border: 'none',
                }}
              >
                {t.label}
                {count > 0 && (
                  <span style={{ marginLeft: '5px', fontSize: '11px', opacity: 0.6 }}>{count}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Table ──────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'auto' }}>

        {/* Empty state */}
        {totalReset === 0 && (
          <div style={{ padding: '48px 0', textAlign: 'center', color: C.textM, fontSize: '13px' }}>
            <div style={{ fontSize: '24px', marginBottom: '8px' }}>✓</div>
            No entries have been reset. Lemma Master edits will appear here for review.
          </div>
        )}

        {/* Words table */}
        {activeSection === 'words' && resetWords.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr>
                {['Lemma', 'Def 2', 'Reason', 'Source · §', ''].map(h => (
                  <th key={h} style={thStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {resetWords.map(w => (
                <tr key={w.uid} style={{ background: `${C.warning}08` }}>
                  <td style={tdStyle}>
                    <span style={{ fontFamily: SH.fk, fontWeight: 600, color: C.accent }}>{w.lemma}</span>
                    {w.input && w.input !== w.lemma && (
                      <div style={{ fontSize: '11px', color: C.textM, marginTop: '2px' }}>{w.input}</div>
                    )}
                  </td>
                  <td style={{ ...tdStyle, maxWidth: '220px' }}>
                    <div style={{ lineHeight: 1.5 }}>{w.def2 || <span style={{ color: C.textM }}>—</span>}</div>
                  </td>
                  <td style={{ ...tdStyle, maxWidth: '180px' }}>
                    <div style={{ fontSize: '11px', color: C.warning, fontStyle: 'italic', lineHeight: 1.4 }}>
                      {w.lastUncheckReason}
                    </div>
                    {w.lastUncheckDate && (
                      <div style={{ fontSize: '10px', color: C.textM, marginTop: '2px', fontFamily: SH.fm }}>
                        {new Date(w.lastUncheckDate).toLocaleDateString()}
                      </div>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <span
                      style={{ display: 'inline-block', padding: '2px 7px', borderRadius: '4px', fontSize: '11px', background: C.accentSoft, color: C.accent, cursor: 'pointer', fontFamily: SH.fm }}
                      onClick={() => goToSource(w.source, w.section)}
                      title="Open in Source view"
                    >
                      {w.source}{w.section ? ` · §${w.section}` : ''}
                    </span>
                  </td>
                  <td style={{ ...tdStyle, width: '100px' }}>
                    <button
                      onClick={() => handleWordOk(w.uid)}
                      style={{
                        padding: '4px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 600,
                        background: C.success, color: '#fff', border: 'none', cursor: 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      ✓ Looks good
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {activeSection === 'words' && resetWords.length === 0 && totalReset > 0 && (
          <div style={{ padding: '32px 0', textAlign: 'center', color: C.textM, fontSize: '13px' }}>
            No reset word entries{srcFilter ? ` for ${srcFilter}` : ''}.
          </div>
        )}

        {/* Sentences table */}
        {activeSection === 'sentences' && resetSentences.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr>
                {['Target Word', 'Card Back (updated)', 'Sentence', 'Reason', 'Source · §', ''].map(h => (
                  <th key={h} style={thStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {resetSentences.map(s => (
                <tr key={s.uid} style={{ background: `${C.warning}08` }}>
                  <td style={{ ...tdStyle, width: '140px' }}>
                    <span style={{ fontFamily: SH.fk, fontWeight: 600, color: C.accent2 || C.tL }}>{s.targetWord}</span>
                  </td>
                  <td style={{ ...tdStyle, maxWidth: '200px' }}>
                    <div style={{ lineHeight: 1.5 }}>{s.cardBack || <span style={{ color: C.textM }}>—</span>}</div>
                  </td>
                  <td style={{ ...tdStyle, maxWidth: '220px' }}>
                    <span style={{ fontFamily: SH.fk, fontSize: '13px', lineHeight: 1.5, color: C.textM }}>{s.sentence}</span>
                  </td>
                  <td style={{ ...tdStyle, maxWidth: '160px' }}>
                    <div style={{ fontSize: '11px', color: C.warning, fontStyle: 'italic', lineHeight: 1.4 }}>
                      {s.lastUncheckReason}
                    </div>
                    {s.lastUncheckDate && (
                      <div style={{ fontSize: '10px', color: C.textM, marginTop: '2px', fontFamily: SH.fm }}>
                        {new Date(s.lastUncheckDate).toLocaleDateString()}
                      </div>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <span
                      style={{ display: 'inline-block', padding: '2px 7px', borderRadius: '4px', fontSize: '11px', background: C.accentSoft, color: C.accent, cursor: 'pointer', fontFamily: SH.fm }}
                      onClick={() => goToSource(s.source, s.section)}
                      title="Open in Source view"
                    >
                      {s.source}{s.section ? ` · §${s.section}` : ''}
                    </span>
                  </td>
                  <td style={{ ...tdStyle, width: '100px' }}>
                    <button
                      onClick={() => handleSentenceOk(s.uid)}
                      style={{
                        padding: '4px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: 600,
                        background: C.success, color: '#fff', border: 'none', cursor: 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      ✓ Looks good
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {activeSection === 'sentences' && resetSentences.length === 0 && totalReset > 0 && (
          <div style={{ padding: '32px 0', textAlign: 'center', color: C.textM, fontSize: '13px' }}>
            No reset sentence entries{srcFilter ? ` for ${srcFilter}` : ''}.
          </div>
        )}
      </div>
    </div>
  );
}
