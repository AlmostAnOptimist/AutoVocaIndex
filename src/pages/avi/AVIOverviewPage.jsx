// src/pages/avi/AVIOverviewPage.jsx
// AVI Overview tab — stat cards and per-source bar chart.
// Stat cards are clickable and navigate to the relevant tab.
// Bar chart shows uploaded (solid) vs pending (faded) per source.

import { useMemo, useState } from 'react';
import { useAppTheme } from '../../hooks/useAppTheme.js';
import { SH } from '../../theme/buildStyles.js';
import { toDateStr, getLogicalToday } from '../../utils/dateUtils.js';
import { buildWordsByDay, buildAviRecords } from '../../utils/aviUtils.js';
import { ActivityHeatmap } from '../../components/ActivityHeatmap.jsx';
import {
  GazetteMasthead, GoldRule, BylineRule, RecordsStrip,
  fmtRecordDate, fmtMonthLabel, fmtWeekRange,
} from '../../components/GazetteComponents.jsx';

const isMobile = typeof window !== 'undefined' && window.innerWidth <= 700;

export function AVIOverviewPage({
  data,
  aviSources,
  setAVITab,
  goToSource,
  navigateToRecent,
  dsh,
}) {
  const { C } = useAppTheme();

  const { wordInputs, sentenceInputs, lemmaMaster, aviSettings } = data;
  const { overviewStatVis = {}, showSourcelessInOverview, chartOrder = [] } = aviSettings;

  // Logical today (3 AM day-flip) — the records strip's current streak and
  // the "Added Today" masthead vital both hinge on it.
  const todayStr = toDateStr(getLogicalToday(dsh ?? 3));
  const [heatmapEndYM, setHeatmapEndYM] = useState(() => {
    const d = getLogicalToday(dsh ?? 3);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });

  const wordsByDay = useMemo(
    () => buildWordsByDay(wordInputs, sentenceInputs),
    [wordInputs, sentenceInputs]
  );

  // ── Masthead + records strip (Stage A-3) ───────────────────
  const addedToday   = wordsByDay[todayStr] || 0;
  const mastheadDate = new Date(todayStr + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const aviRecords   = useMemo(() => buildAviRecords(wordsByDay, dsh ?? 3), [wordsByDay, dsh]);
  const recordsItems = useMemo(() => ([
    aviRecords.bestDay   && { label: 'Best Day',   value: `${aviRecords.bestDay.count} · ${fmtRecordDate(aviRecords.bestDay.date)}` },
    aviRecords.bestWeek  && { label: 'Best Week',  value: `${aviRecords.bestWeek.count} · ${fmtWeekRange(aviRecords.bestWeek.weekStart)}` },
    aviRecords.bestMonth && { label: 'Best Month', value: `${aviRecords.bestMonth.count} · ${fmtMonthLabel(aviRecords.bestMonth.ym)}` },
    aviRecords.longestStreak > 0 && { label: 'Longest Streak', value: `${aviRecords.longestStreak}d` },
    { label: 'Current Streak', value: `${aviRecords.currentStreak}d` },
  ]), [aviRecords]);

  // ── Totals ─────────────────────────────────────────────────
  const totalWords      = wordInputs.length;
  const totalSentences  = sentenceInputs.length;
  const totalLemmas     = lemmaMaster.length;
  const uploadedWords   = wordInputs.filter(w => w.uploaded).length;
  const uploadedSents   = sentenceInputs.filter(s => s.uploaded).length;
  const recentCount     =
    wordInputs.filter(w => !w.uploaded && !w.skipUpload && w.lastUncheckReason).length +
    sentenceInputs.filter(s => !s.uploaded && !s.skipUpload && s.lastUncheckReason).length;

  // ── Source chart data ──────────────────────────────────────
  // Build per-source stats from wordInputs and sentenceInputs.
  const sourceStats = useMemo(() => {
    const map = {};

    for (const w of wordInputs) {
      const key = w.source || '';
      if (!map[key]) map[key] = { uploadedW: 0, pendingW: 0, uploadedS: 0, pendingS: 0 };
      if (w.uploaded)                             map[key].uploadedW++;
      else if (!w.skipUpload)                     map[key].pendingW++;
    }
    for (const s of sentenceInputs) {
      const key = s.source || '';
      if (!map[key]) map[key] = { uploadedW: 0, pendingW: 0, uploadedS: 0, pendingS: 0 };
      if (s.uploaded)                             map[key].uploadedS++;
      else if (!s.skipUpload)                     map[key].pendingS++;
    }
    return map;
  }, [wordInputs, sentenceInputs]);

  // Order sources: chartOrder first, then remaining sources alphabetically.
  const orderedSources = useMemo(() => {
    const sourceTitles  = (aviSources || []).map(s => s.title);
    const inOrder       = chartOrder.filter(t => sourceTitles.includes(t) || sourceStats[t]);
    const remaining     = sourceTitles.filter(t => !inOrder.includes(t) && sourceStats[t]);
    const all           = [...inOrder, ...remaining];

    // Sourceless entries
    const hasSourceless = sourceStats[''] &&
      (sourceStats[''].uploadedW + sourceStats[''].pendingW +
       sourceStats[''].uploadedS + sourceStats[''].pendingS) > 0;

    return { ordered: all, hasSourceless };
  }, [aviSources, chartOrder, sourceStats]);

  const maxVal = useMemo(() => {
    const vals = Object.values(sourceStats).map(s =>
      s.uploadedW + s.pendingW + s.uploadedS + s.pendingS
    );
    return Math.max(...vals, 1);
  }, [sourceStats]);

  // ── Styles ─────────────────────────────────────────────────
  const cardStyle = {
    background:   C.surface,
    border:       `1px solid ${C.border}`,
    borderRadius: '10px',
    padding:      '16px 18px',
    cursor:       'pointer',
    transition:   'border-color 0.15s',
    flex:         '1 1 140px',
    minWidth:     '120px',
  };

  const cardLabelStyle = {
    fontSize:      '10px',
    fontWeight:    700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color:         C.textM,
    marginBottom:  '6px',
  };

  const cardValueStyle = {
    fontFamily: SH.fm,
    fontSize:   '28px',
    fontWeight: 600,
    color:      C.text,
    lineHeight:  1,
  };

  const sectionTitleStyle = {
    fontFamily:    SH.fd,
    fontSize:      '13px',
    fontWeight:    700,
    color:         C.textM,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    marginBottom:  '12px',
  };

  return (
    <div style={{ paddingBottom: '32px' }}>

      {/* Masthead (Stage A-3) */}
      <GazetteMasthead
        cornerLeft={{ value: addedToday, label: 'Added Today' }}
        cornerRight={{ value: mastheadDate, label: todayStr.slice(0, 4) }}
        title="AutoVocaIndex"
        subtitle="A Record of Lemmas and Their Connections"
        isMobile={isMobile}
      />
      <GoldRule />
      <div style={{ marginBottom: '24px' }}>
        <BylineRule left="autovocaindex / avi" right={todayStr} />
      </div>

      {/* ── Stat cards ─────────────────────────────────────── */}
      <div style={{ marginBottom: '28px' }}>
        <div style={sectionTitleStyle}>At a glance</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>

          {overviewStatVis.words !== false && (
            <div
              style={{ ...cardStyle, borderColor: C.accent }}
              onClick={() => setAVITab('word')}
              title="Go to Word Input"
            >
              <div style={cardLabelStyle}>Words</div>
              <div style={{ ...cardValueStyle, color: C.accent }}>{totalWords}</div>
              <div style={{ fontSize: '11px', color: C.textM, marginTop: '4px' }}>
                {uploadedWords} in decks
              </div>
            </div>
          )}

          {overviewStatVis.sentences !== false && (
            <div
              style={{ ...cardStyle, borderColor: C.accent2 || C.border }}
              onClick={() => setAVITab('sentence')}
              title="Go to Sentence Input"
            >
              <div style={cardLabelStyle}>Sentences</div>
              <div style={{ ...cardValueStyle, color: C.accent2 || C.textS }}>{totalSentences}</div>
              <div style={{ fontSize: '11px', color: C.textM, marginTop: '4px' }}>
                {uploadedSents} in decks
              </div>
            </div>
          )}

          <div
            style={{ ...cardStyle }}
            onClick={() => setAVITab('lemma')}
            title="Go to Lemma Master"
          >
            <div style={cardLabelStyle}>Lemmas</div>
            <div style={cardValueStyle}>{totalLemmas}</div>
          </div>

          {recentCount > 0 && (
            <div
              style={{ ...cardStyle, borderColor: C.warning }}
              onClick={navigateToRecent}
              title="Go to Recently Reset"
            >
              <div style={cardLabelStyle}>Recently Reset</div>
              <div style={{ ...cardValueStyle, color: C.warning }}>{recentCount}</div>
              <div style={{ fontSize: '11px', color: C.textM, marginTop: '4px' }}>
                need review
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Words added heatmap ─────────────────────────────── */}
      <div style={{ marginBottom: '28px' }}>
        <div style={sectionTitleStyle}>Words added</div>
        <ActivityHeatmap
          data={wordsByDay}
          color={C.warning}
          today={todayStr}
          windowEndYM={heatmapEndYM}
          onWindowChange={setHeatmapEndYM}
          itemLabel={(n) => n === 1 ? 'entry' : 'entries'}
        />
      </div>

      <RecordsStrip items={recordsItems} isMobile={isMobile} />

      {/* ── Source chart ─────────────────────────────────────── */}
      {orderedSources.ordered.length > 0 && (
        <div>
          <div style={sectionTitleStyle}>By source</div>

          {/* Legend */}
          <div style={{ display: 'flex', gap: '16px', marginBottom: '14px' }}>
            <LegendItem color={C.accent}             label="Words (in deck)" />
            <LegendItem color={C.accent}   faded      label="Words (pending)" />
            <LegendItem color={C.accent2 || C.textS} label="Sentences (in deck)" />
            <LegendItem color={C.accent2 || C.textS} faded label="Sentences (pending)" />
          </div>

          {/* Bars */}
          <div style={{
            border: `1px solid ${C.border}`, borderRadius: '10px', overflow: 'hidden',
          }}>
            {orderedSources.ordered.map((title, i) => {
              const stats = sourceStats[title] || { uploadedW: 0, pendingW: 0, uploadedS: 0, pendingS: 0 };
              const total = stats.uploadedW + stats.pendingW + stats.uploadedS + stats.pendingS;
              if (total === 0) return null;
              return (
                <SourceBar
                  key={title}
                  title={title}
                  stats={stats}
                  maxVal={maxVal}
                  last={i === orderedSources.ordered.length - 1 && !orderedSources.hasSourceless}
                  onClick={() => goToSource(title, '')}
                  C={C}
                />
              );
            })}

            {/* Sourceless row */}
            {showSourcelessInOverview && orderedSources.hasSourceless && (() => {
              const stats = sourceStats[''] || { uploadedW: 0, pendingW: 0, uploadedS: 0, pendingS: 0 };
              return (
                <SourceBar
                  key="__sourceless"
                  title="(no source)"
                  stats={stats}
                  maxVal={maxVal}
                  last
                  onClick={() => goToSource('', '')}
                  C={C}
                  muted
                />
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

// ── SourceBar ─────────────────────────────────────────────────
function SourceBar({ title, stats, maxVal, last, onClick, C, muted }) {
  const { uploadedW, pendingW, uploadedS, pendingS } = stats;
  const total = uploadedW + pendingW + uploadedS + pendingS;
  const BAR_W = 200; // max bar width in px

  const wUploaded = (uploadedW / maxVal) * BAR_W;
  const wPending  = (pendingW  / maxVal) * BAR_W;
  const sUploaded = (uploadedS / maxVal) * BAR_W;
  const sPending  = (pendingS  / maxVal) * BAR_W;

  const accent  = C.accent;
  const accent2 = C.accent2 || C.textS;

  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: '12px',
        padding: '10px 16px',
        borderBottom: last ? 'none' : `1px solid ${C.border}`,
        cursor: 'pointer',
        transition: 'background 0.12s',
        opacity: muted ? 0.65 : 1,
      }}
      className="task-row"
    >
      {/* Source name */}
      <div style={{
        width: '140px', flexShrink: 0, fontSize: '12px', fontWeight: 500,
        color: muted ? C.textM : C.text, textAlign: 'right',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        fontFamily: SH.fk,
      }} title={title}>
        {title}
      </div>

      {/* Bar area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {/* Words bar */}
        <div style={{ position: 'relative', height: '14px', background: `${accent}18`, borderRadius: '3px', display: 'flex' }}>
          {wUploaded > 0 && <div style={{ width: `${wUploaded}px`, height: '100%', background: accent, borderRadius: '2px 0 0 2px', transition: 'width 0.4s' }} />}
          {wPending  > 0 && <div style={{ width: `${wPending}px`,  height: '100%', background: accent, opacity: 0.3, transition: 'width 0.4s' }} />}
          {(uploadedW > 0 || pendingW > 0) && (
            <span style={{
              position: 'absolute',
              left: `${wUploaded + 4}px`,
              top: '50%', transform: 'translateY(-50%)',
              fontSize: '10px', fontFamily: SH.fm,
              color: C.text, fontWeight: 600,
              whiteSpace: 'nowrap',
            }}>
              {uploadedW}{pendingW > 0 ? `+${pendingW}` : ''}
            </span>
          )}
        </div>
        {/* Sentences bar */}
        <div style={{ position: 'relative', height: '14px', background: `${accent2}18`, borderRadius: '3px', display: 'flex' }}>
          {sUploaded > 0 && <div style={{ width: `${sUploaded}px`, height: '100%', background: accent2, borderRadius: '2px 0 0 2px', transition: 'width 0.4s' }} />}
          {sPending  > 0 && <div style={{ width: `${sPending}px`,  height: '100%', background: accent2, opacity: 0.3, transition: 'width 0.4s' }} />}
          {(uploadedS > 0 || pendingS > 0) && (
            <span style={{
              position: 'absolute',
              left: `${sUploaded + 4}px`,
              top: '50%', transform: 'translateY(-50%)',
              fontSize: '10px', fontFamily: SH.fm,
              color: C.text, fontWeight: 600,
              whiteSpace: 'nowrap',
            }}>
              {uploadedS}{pendingS > 0 ? `+${pendingS}` : ''}
            </span>
          )}
        </div>
      </div>

      {/* Total */}
      <div style={{ width: '36px', flexShrink: 0, textAlign: 'right', fontSize: '11px', fontFamily: SH.fm, color: C.textM }}>
        {total}
      </div>
    </div>
  );
}

// ── LegendItem ────────────────────────────────────────────────
function LegendItem({ color, label, faded }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px' }}>
      <div style={{
        width: '12px', height: '10px',
        background: color,
        opacity: faded ? 0.3 : 1,
        borderRadius: '2px',
        flexShrink: 0,
      }} />
      <span style={{ color: '#888' }}>{label}</span>
    </div>
  );
}
