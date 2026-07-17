// src/pages/avi/AVISourcePage.jsx
// AVI Source tab — filtered view of uploaded word/sentence entries by source and section.
// Section chart shows vertical bars per section (uploaded solid, pending faded).
// Source·§ column visibility matches Review tab behavior:
//   - Both source and section selected → hide Source·§ entirely
//   - Only source selected → show §N only
//   - No source selected → show Source · §N

import { useMemo, useState, useEffect } from 'react';
import { useAppTheme } from '../../hooks/useAppTheme.js';
import { SH } from '../../theme/buildStyles.js';
import { Def1Display } from '../../components/avi/Def1Display.jsx';
import { normalizeLemma, getSourceSections, NUANCE_SOURCE_TITLE } from '../../utils/aviUtils.js';
import { AVISourceSearchSelect } from '../../components/avi/AVISourceSearchSelect.jsx';

const isMobile = typeof window !== 'undefined' && window.innerWidth <= 700;

export function AVISourcePage({
  data,
  aviSources,
  aviSections,
  srcFilter, setSrcFilter,
  secFilter, setSecFilter,
}) {
  const { C } = useAppTheme();
  const { wordInputs, sentenceInputs, lemmaMaster } = data;
  const [mobileSeg, setMobileSeg] = useState('words'); // mobile only — which list is showing

  // Default to first source if none selected
  useEffect(() => {
    if (!srcFilter && aviSources.length > 0) {
      setSrcFilter(aviSources[0].title);
    }
  }, [srcFilter, aviSources, setSrcFilter]);

  const activeSrc = aviSources.find(s => s.title === srcFilter);

  // Sections for this source, naturally sorted
  const srcSections = useMemo(() => getSourceSections(aviSources, aviSections, srcFilter), [aviSources, aviSections, srcFilter]);

  // Section number options for the filter dropdown
  // AVI stores section as number string ("1", "2"…), matching the trailing digit
  const secNumbers = srcSections.map(s => {
    const m = (s.content || '').match(/(\d+)$/);
    return m ? String(parseInt(m[1])) : s.content;
  });

  const matchFilter = (row) => {
    if (srcFilter && row.source !== srcFilter) return false;
    if (secFilter && secFilter !== '(All)' && String(row.section) !== String(secFilter)) return false;
    return true;
  };

  const uploadedWords = wordInputs
    .filter(w => w.uploaded && matchFilter(w))
    .sort((a, b) => {
      const sa = parseInt(String(a.section)) || 0;
      const sb = parseInt(String(b.section)) || 0;
      if (sa !== sb) return sa - sb;
      return (a.lemma || '').localeCompare(b.lemma || '', 'ko');
    });

  // ── relatedMeaning clustering (동의어/유의어 only) ─────────────
  // Groups words tagged as related-in-meaning so they sit adjacent, with
  // alternating row backgrounds marking each group's boundary — including
  // singletons, which each count as their own group. Restricted to links
  // between lemmas that are both actually visible in this filtered list;
  // a relatedMeaning link to a lemma not tagged to this source doesn't
  // pull anything in.
  const isNuanceSource = srcFilter === NUANCE_SOURCE_TITLE;
  const { orderedWords, rowBg } = useMemo(() => {
    if (!isNuanceSource || uploadedWords.length === 0) {
      return { orderedWords: uploadedWords, rowBg: new Map() };
    }

    const byNormLemma = new Map();
    lemmaMaster.forEach(l => byNormLemma.set(normalizeLemma(l.lemma), l));
    const byLemmaID = new Map();
    lemmaMaster.forEach(l => byLemmaID.set(l.lemmaID, l));

    const visibleNorms = new Set(uploadedWords.map(w => normalizeLemma(w.lemma)));

    const parent = new Map();
    const find = (x) => {
      if (!parent.has(x)) parent.set(x, x);
      let root = x;
      while (parent.get(root) !== root) root = parent.get(root);
      parent.set(x, root);
      return root;
    };
    const union = (a, b) => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };

    visibleNorms.forEach(norm => find(norm));
    visibleNorms.forEach(norm => {
      const entry = byNormLemma.get(norm);
      if (!entry) return;
      const relIds = (entry.relatedMeaning || '').split(',').map(s => s.trim()).filter(Boolean);
      relIds.forEach(otherId => {
        const otherEntry = byLemmaID.get(otherId);
        if (!otherEntry) return;
        const otherNorm = normalizeLemma(otherEntry.lemma);
        if (visibleNorms.has(otherNorm)) union(norm, otherNorm);
      });
    });

    const groups = new Map();
    uploadedWords.forEach(w => {
      const root = find(normalizeLemma(w.lemma));
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(w);
    });

    const groupList = [...groups.values()].map(rows =>
      rows.slice().sort((a, b) => (a.lemma || '').localeCompare(b.lemma || '', 'ko'))
    );
    groupList.sort((a, b) => (a[0].lemma || '').localeCompare(b[0].lemma || '', 'ko'));

    const ordered = [];
    const bgMap = new Map();
    let flip = false;
    groupList.forEach(group => {
      group.forEach(row => {
        ordered.push(row);
        bgMap.set(row.uid, flip ? C.surface : C.bg);
      });
      flip = !flip;
    });

    return { orderedWords: ordered, rowBg: bgMap };
  }, [isNuanceSource, uploadedWords, lemmaMaster, C.bg, C.surface]);

  const uploadedSentences = sentenceInputs
    .filter(s => s.uploaded && matchFilter(s))
    .sort((a, b) => {
      const sa = parseInt(String(a.section)) || 0;
      const sb = parseInt(String(b.section)) || 0;
      if (sa !== sb) return sa - sb;
      return (a.targetWord || '').localeCompare(b.targetWord || '', 'ko');
    });
  const uniqueLemmas      = [...new Set(uploadedWords.map(w => normalizeLemma(w.lemma)).filter(Boolean))];

  // Column visibility
  const showSource  = !srcFilter;
  const showSection = !secFilter || secFilter === '(All)';

  // ── Section chart data ──────────────────────────────────────
  const secStats = useMemo(() => {
    if (!activeSrc) return [];
    return secNumbers.map(sec => {
      const secWords = wordInputs.filter(w => w.source === srcFilter && String(w.section) === String(sec));
      const secSents = sentenceInputs.filter(s => s.source === srcFilter && String(s.section) === String(sec));
      return {
        sec,
        uploadedW: secWords.filter(w => w.uploaded).length,
        pendingW:  secWords.filter(w => !w.uploaded && !w.skipUpload).length,
        uploadedS: secSents.filter(s => s.uploaded).length,
        pendingS:  secSents.filter(s => !s.uploaded && !s.skipUpload).length,
        totalW:    secWords.length,
        totalS:    secSents.length,
      };
    });
  }, [activeSrc, srcFilter, secNumbers, wordInputs, sentenceInputs]);

  const maxVal = Math.max(...secStats.map(s => s.totalW + s.totalS), 1);
  const BAR_H  = 80; // px

  const thStyle = {
    padding: '6px 10px', fontSize: '10px', fontWeight: 700,
    letterSpacing: '0.07em', textTransform: 'uppercase',
    color: C.textM, borderBottom: `2px solid ${C.border}`,
    textAlign: 'left', whiteSpace: 'nowrap',
    position: 'sticky', top: 0, background: C.raised, zIndex: 1,
  };

  const tdStyle = {
    padding: '6px 10px', fontSize: '12px', color: C.text,
    verticalAlign: 'top', borderBottom: `1px solid ${C.border}`,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: '100%' }}>

      {/* ── Filters ────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0, flexWrap: 'wrap' }}>
        <AVISourceSearchSelect
          sources={aviSources}
          value={srcFilter}
          onChange={title => { setSrcFilter(title); setSecFilter('(All)'); }}
          excludePassive
          style={{ width: '180px' }}
          C={C}
        />
        <select
          value={secFilter}
          onChange={e => setSecFilter(e.target.value)}
          disabled={!activeSrc || secNumbers.length === 0}
          style={{ ...selectStyle(C), opacity: (!activeSrc || secNumbers.length === 0) ? 0.4 : 1 }}
        >
          <option value="(All)">(All)</option>
          {secNumbers.map(n => <option key={n} value={String(n)}>§{n}</option>)}
        </select>
        <div style={{ marginLeft: '8px', display: 'flex', gap: '10px' }}>
          <StatBadge value={uniqueLemmas.length} label="unique lemmas" C={C} />
          <StatBadge value={uploadedSentences.length} label="sentences" C={C} />
        </div>
      </div>

      {/* ── Section chart ─────────────────────────────────── */}
      {srcFilter && secStats.length > 0 && (
        <div style={{
          border: `1px solid ${C.border}`, borderRadius: '10px',
          padding: '14px 16px', flexShrink: 0, background: C.surface,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
            <div style={{
              fontFamily: SH.fd, fontSize: '13px',
              fontWeight: 700, color: C.textM,
            }}>
              Progress by Section
            </div>
            <div style={{ display: 'flex', gap: '14px' }}>
              <ChartLegend color={C.accent}           label="Words" C={C} />
              <ChartLegend color={C.accent2 || C.tL}  label="Sentences" C={C} />
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <div style={{
              display: 'flex', alignItems: 'flex-end', gap: '5px',
              minWidth: `${secStats.length * 32}px`, paddingBottom: '4px',
            }}>
              {secStats.map(({ sec, uploadedW, pendingW, uploadedS, pendingS, totalW, totalS }) => {
                const upWH   = (uploadedW / maxVal) * BAR_H;
                const pendWH = (pendingW  / maxVal) * BAR_H;
                const upSH   = (uploadedS / maxVal) * BAR_H;
                const pendSH = (pendingS  / maxVal) * BAR_H;
                const tooltip = totalW + totalS > 0
                  ? `§${sec}\nWords: ${uploadedW} uploaded${pendingW > 0 ? `, ${pendingW} pending` : ''}\nSentences: ${uploadedS} uploaded${pendingS > 0 ? `, ${pendingS} pending` : ''}`
                  : `§${sec} — no entries`;

                return (
                  <div
                    key={sec}
                    title={tooltip}
                    onClick={() => setSecFilter(String(sec))}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center',
                      gap: '3px', flex: '1 0 26px', cursor: 'pointer',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-end', gap: '2px', height: `${BAR_H}px` }}>
                      {/* Word bar */}
                      <div style={{ width: '10px', display: 'flex', flexDirection: 'column-reverse', height: `${BAR_H}px` }}>
                        {uploadedW > 0 && <div style={{ width: '100%', height: `${upWH}px`, background: C.accent, borderRadius: '2px 2px 0 0', transition: 'height 0.4s' }} />}
                        {pendingW  > 0 && <div style={{ width: '100%', height: `${pendWH}px`, background: C.accent, opacity: 0.3, transition: 'height 0.4s' }} />}
                      </div>
                      {/* Sentence bar */}
                      <div style={{ width: '10px', display: 'flex', flexDirection: 'column-reverse', height: `${BAR_H}px` }}>
                        {uploadedS > 0 && <div style={{ width: '100%', height: `${upSH}px`, background: C.accent2 || C.tL, borderRadius: '2px 2px 0 0', transition: 'height 0.4s' }} />}
                        {pendingS  > 0 && <div style={{ width: '100%', height: `${pendSH}px`, background: C.accent2 || C.tL, opacity: 0.3, transition: 'height 0.4s' }} />}
                      </div>
                    </div>
                    <div style={{ fontSize: '9px', color: C.textM, fontFamily: SH.fm }}>§{sec}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ── Tables (mobile: segmented toggle + card list instead) ── */}
      {isMobile ? (
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ display: 'flex', background: C.raised, border: `1px solid ${C.border}`, borderRadius: '9px', padding: '3px', marginBottom: '12px', flexShrink: 0 }}>
            <div
              onClick={() => setMobileSeg('words')}
              style={{ flex: 1, textAlign: 'center', padding: '7px 0', borderRadius: '7px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', background: mobileSeg === 'words' ? C.accent : 'transparent', color: mobileSeg === 'words' ? '#fff' : C.textM }}
            >
              Words · {uploadedWords.length}
            </div>
            <div
              onClick={() => setMobileSeg('sentences')}
              style={{ flex: 1, textAlign: 'center', padding: '7px 0', borderRadius: '7px', fontSize: '12px', fontWeight: 700, cursor: 'pointer', background: mobileSeg === 'sentences' ? C.accent : 'transparent', color: mobileSeg === 'sentences' ? '#fff' : C.textM }}
            >
              Sentences · {uploadedSentences.length}
            </div>
          </div>

          {mobileSeg === 'words' ? (
            <>
              {orderedWords.length === 0 && (
                <div style={{ padding: '24px', textAlign: 'center', color: C.textM, fontSize: '13px' }}>
                  No uploaded words for this source.
                </div>
              )}
              {orderedWords.map(w => (
                <div key={w.uid} style={{ background: isNuanceSource ? (rowBg.get(w.uid) || C.bg) : C.surface, border: `1px solid ${C.border}`, borderRadius: '9px', padding: '10px 12px', marginBottom: '7px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' }}>
                    <span style={{ fontFamily: SH.fk, fontWeight: 600, color: C.accent, fontSize: '14px' }}>{w.lemma}</span>
                    {(showSource || showSection) && (
                      <span style={{ fontSize: '10.5px', fontFamily: SH.fm, color: C.textM, background: C.raised, borderRadius: '4px', padding: '1px 6px', flexShrink: 0 }}>
                        {showSource && showSection
                          ? `${w.source}${w.section ? ` · §${w.section}` : ''}`
                          : showSource ? (w.source || '—')
                          : (w.section ? `§${w.section}` : '—')}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '9.5px', fontWeight: 700, color: C.textM, textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: '5px' }}>Definition 2</div>
                  <div style={{ fontSize: '12px', color: w.def2 ? C.text : C.textM, lineHeight: 1.5, marginTop: '2px' }}>{w.def2 || '—'}</div>
                </div>
              ))}
            </>
          ) : (
            <>
              {uploadedSentences.length === 0 && (
                <div style={{ padding: '24px', textAlign: 'center', color: C.textM, fontSize: '13px' }}>
                  No uploaded sentences for this source.
                </div>
              )}
              {uploadedSentences.map(s => (
                <div key={s.uid} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: '9px', padding: '10px 12px', marginBottom: '7px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' }}>
                    <span style={{ fontFamily: SH.fk, fontWeight: 600, color: C.accent2 || C.tL, fontSize: '14px' }}>{s.targetWord}</span>
                    {(showSource || showSection) && (
                      <span style={{ fontSize: '10.5px', fontFamily: SH.fm, color: C.textM, background: C.raised, borderRadius: '4px', padding: '1px 6px', flexShrink: 0 }}>
                        {showSource && showSection
                          ? `${s.source}${s.section ? ` · §${s.section}` : ''}`
                          : showSource ? (s.source || '—')
                          : (s.section ? `§${s.section}` : '—')}
                      </span>
                    )}
                  </div>
                  <div style={{ fontFamily: SH.fk, fontSize: '13px', lineHeight: 1.5, color: C.text, marginTop: '5px' }}>{s.sentence}</div>
                </div>
              ))}
            </>
          )}
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', gap: '16px', minHeight: 0 }}>

          {/* Words */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em',
              textTransform: 'uppercase', color: C.textM, marginBottom: '8px',
            }}>
              Word Inputs (Uploaded) — {uploadedWords.length}
            </div>
            <div style={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: '8px', overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead>
                  <tr>
                    <th style={{ ...thStyle, width: '140px' }}>Lemma</th>
                    <th style={thStyle}>Def 2</th>
                    {(showSource || showSection) && (
                      <th style={thStyle}>{showSource ? 'Source · §' : '§'}</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {uploadedWords.length === 0 && (
                    <tr><td colSpan={3} style={{ ...tdStyle, color: C.textM, textAlign: 'center', padding: '20px' }}>
                      No uploaded words for this source.
                    </td></tr>
                  )}
                  {orderedWords.map(w => (
                    <tr key={w.uid} style={{ background: isNuanceSource ? (rowBg.get(w.uid) || C.bg) : 'transparent' }}>
                      <td style={{ ...tdStyle, width: '140px' }}>
                        <span style={{ fontFamily: SH.fk, fontWeight: 600, color: C.accent }}>{w.lemma}</span>
                      </td>
                      <td style={{ ...tdStyle, maxWidth: '200px' }}>
                        <div style={{ fontSize: '12px', color: C.text, lineHeight: 1.4 }}>{w.def2 || '—'}</div>
                      </td>
                      {(showSource || showSection) && (
                        <td style={tdStyle}>
                          <span style={{
                            fontSize: '11px', fontFamily: SH.fm, color: C.textM,
                            background: C.raised, borderRadius: '4px', padding: '1px 6px',
                          }}>
                            {showSource && showSection
                              ? `${w.source}${w.section ? ` · §${w.section}` : ''}`
                              : showSource ? (w.source || '—')
                              : (w.section ? `§${w.section}` : '—')}
                          </span>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Sentences */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em',
              textTransform: 'uppercase', color: C.textM, marginBottom: '8px',
            }}>
              Sentence Inputs (Uploaded) — {uploadedSentences.length}
            </div>
            <div style={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: '8px', overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead>
                  <tr>
                    <th style={{ ...thStyle, width: '140px' }}>Target Word</th>
                    <th style={thStyle}>Sentence</th>
                    {(showSource || showSection) && (
                      <th style={thStyle}>{showSource ? 'Source · §' : '§'}</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {uploadedSentences.length === 0 && (
                    <tr><td colSpan={3} style={{ ...tdStyle, color: C.textM, textAlign: 'center', padding: '20px' }}>
                      No uploaded sentences for this source.
                    </td></tr>
                  )}
                  {uploadedSentences.map(s => (
                    <tr key={s.uid}>
                      <td style={{ ...tdStyle, width: '140px' }}>
                        <span style={{ fontFamily: SH.fk, fontWeight: 600, color: C.accent2 || C.tL }}>
                          {s.targetWord}
                        </span>
                      </td>
                      <td style={{ ...tdStyle, maxWidth: '260px' }}>
                        <span style={{ fontFamily: SH.fk, fontSize: '13px', lineHeight: 1.5 }}>{s.sentence}</span>
                      </td>
                      {(showSource || showSection) && (
                        <td style={tdStyle}>
                          <span style={{
                            fontSize: '11px', fontFamily: SH.fm, color: C.textM,
                            background: C.raised, borderRadius: '4px', padding: '1px 6px',
                          }}>
                            {showSource && showSection
                              ? `${s.source}${s.section ? ` · §${s.section}` : ''}`
                              : showSource ? (s.source || '—')
                              : (s.section ? `§${s.section}` : '—')}
                          </span>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatBadge({ value, label, C }) {
  return (
    <span style={{ fontSize: '11px', color: C.textM, fontFamily: SH.fm }}>
      <span style={{ color: C.text, fontWeight: 600 }}>{value}</span> {label}
    </span>
  );
}

function ChartLegend({ color, label, C }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: C.textM }}>
      <span style={{ display: 'inline-flex', gap: '2px' }}>
        <span style={{ width: '10px', height: '8px', background: color, borderRadius: '2px' }} />
        <span style={{ width: '10px', height: '8px', background: color, opacity: 0.3, borderRadius: '2px' }} />
      </span>
      {label}
    </div>
  );
}

function selectStyle(C) {
  return {
    fontSize: '12px', padding: '4px 8px', borderRadius: '6px',
    border: `1px solid ${C.border}`, background: C.raised,
    color: C.text, cursor: 'pointer', outline: 'none',
  };
}
