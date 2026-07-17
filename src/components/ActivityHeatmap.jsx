// src/components/ActivityHeatmap.jsx
// Single-color opacity heatmap for activity data.
// Used for: words added (AVIOverviewPage), cards reviewed (FlashcardsPage).
//
// Props:
//   data           { [YYYY-MM-DD]: number }
//   color          CSS color string — C.warning recommended
//   today          'YYYY-MM-DD'
//   monthsToShow   number (default 6)
//   windowEndYM    'YYYY-MM'
//   onWindowChange (newEndYM) => void
//   itemLabel      string used in tooltip (e.g. 'reviews', 'words added')

import { useMemo } from 'react';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { toDateStr } from '../utils/dateUtils.js';

// ── Layout constants ──────────────────────────────────────────
const isMobile = typeof window !== 'undefined' && window.innerWidth <= 700;

const CELL          = 16;
const GAP           = 2;
const DAY_LABEL_W   = 14;
const DAY_LABEL_GAP = 6;

const DAY_LABELS  = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Opacity range: smallest non-zero → MIN_ACTIVE, peak value → MAX.
const MIN_ACTIVE_OPACITY = 0.15;
const MAX_OPACITY        = 0.88;
const EMPTY_OPACITY      = 0.30;  // zero-count past/today cells
const FUTURE_OPACITY     = 0.08;  // future cells

// ── Date helpers ──────────────────────────────────────────────
const toMonIdx = (jsDay) => (jsDay + 6) % 7;

function getMondayOn(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - toMonIdx(d.getDay()));
  d.setHours(0, 0, 0, 0);
  return d;
}

export function shiftMonth(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function buildGrid(startYM, endYM) {
  const [sy, sm] = startYM.split('-').map(Number);
  const [ey, em] = endYM.split('-').map(Number);

  const rangeStart = new Date(sy, sm - 1, 1);
  const rangeEnd   = new Date(ey, em, 0);

  const gridStart = getMondayOn(rangeStart);
  const endDow    = toMonIdx(rangeEnd.getDay());
  const gridEnd   = new Date(rangeEnd);
  if (endDow !== 6) gridEnd.setDate(gridEnd.getDate() + (6 - endDow));

  const weeks = [];
  const cur   = new Date(gridStart);
  while (cur <= gridEnd) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      const ds      = toDateStr(cur);
      const inRange = cur >= rangeStart && cur <= rangeEnd;
      week.push(inRange ? ds : null);
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

// ── Opacity map ───────────────────────────────────────────────
// Normalises each day's count against the maximum in the visible window.
// Only non-zero past/today days get an entry; everything else uses the
// EMPTY or FUTURE constants directly at render time.
function buildOpacityMap(data, weeks, todayStr) {
  let maxVal = 0;
  for (const week of weeks) {
    for (const d of week) {
      if (d && d <= todayStr && (data[d] || 0) > maxVal) maxVal = data[d];
    }
  }
  if (maxVal === 0) return {};

  const map = {};
  for (const week of weeks) {
    for (const d of week) {
      if (d && d <= todayStr && data[d] > 0) {
        map[d] = MIN_ACTIVE_OPACITY + (data[d] / maxVal) * (MAX_OPACITY - MIN_ACTIVE_OPACITY);
      }
    }
  }
  return map;
}

// ── Component ─────────────────────────────────────────────────
export function ActivityHeatmap({
  data = {},
  color,
  today,
  monthsToShow = isMobile ? 3 : 12,
  windowEndYM,
  onWindowChange,
  itemLabel = 'entries',
}) {
  const { C } = useAppTheme();

  const todayStr  = today || toDateStr(new Date());
  const currentYM = todayStr.slice(0, 7);
  const endYM     = windowEndYM || currentYM;
  const startYM   = shiftMonth(endYM, -(monthsToShow - 1));

  const weeks      = useMemo(() => buildGrid(startYM, endYM),             [startYM, endYM]);
  const opacityMap = useMemo(() => buildOpacityMap(data, weeks, todayStr), [data, weeks, todayStr]);

  const cellColor = color || C.warning;
  const canGoFwd  = endYM < currentYM;

  return (
    <div>

      {/* ── Navigation ─────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
        <button
          onClick={() => onWindowChange?.(shiftMonth(endYM, -1))}
          style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: '6px', padding: '4px 10px', cursor: 'pointer', color: C.textM, fontSize: '14px' }}
        >
          ‹
        </button>
        <div style={{ fontSize: '12px', color: C.textM }}>
          {MONTH_NAMES[Number(startYM.slice(5, 7)) - 1]} {startYM.slice(0, 4)}
          {' – '}
          {MONTH_NAMES[Number(endYM.slice(5, 7)) - 1]} {endYM.slice(0, 4)}
        </div>
        <button
          onClick={() => canGoFwd && onWindowChange?.(shiftMonth(endYM, 1))}
          disabled={!canGoFwd}
          style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: '6px', padding: '4px 10px', cursor: canGoFwd ? 'pointer' : 'default', color: C.textM, fontSize: '14px', opacity: canGoFwd ? 1 : 0.3 }}
        >
          ›
        </button>
      </div>

      {/* ── Grid ──────────────────────────────────────────── */}
      {/* width:fit-content + margin:auto centers the grid when it fits its container,
          and degrades to normal left-aligned scrolling when it doesn't — avoids the
          flexbox justify-content:center + overflow bug where wide content becomes
          unreachable via normal scroll. The 4px top/left/right padding gives the
          today-cell's outline (2px solid + 1px offset = 3px of bleed) room to render
          without being clipped by the scrollport. */}
      <div style={{ overflowX: 'auto', padding: '4px 4px 28px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0, width: 'fit-content', margin: '0 auto' }}>

          {/* Day labels + week columns */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 0 }}>

            {/* Day labels */}
            <div style={{
              display: 'flex', flexDirection: 'column', gap: `${GAP}px`,
              width: `${DAY_LABEL_W}px`, flexShrink: 0,
              marginRight: `${DAY_LABEL_GAP}px`,
            }}>
              {DAY_LABELS.map((label, i) => (
                <div key={i} style={{
                  height: `${CELL}px`, lineHeight: `${CELL}px`,
                  fontSize: '9px', fontWeight: 600, color: C.textM,
                  textAlign: 'right', userSelect: 'none',
                  opacity: [0, 2, 4, 6].includes(i) ? 1 : 0,
                }}>
                  {label}
                </div>
              ))}
            </div>

            {/* Week columns */}
            <div style={{ display: 'flex', flexDirection: 'row', gap: `${GAP}px`, flexShrink: 0 }}>
              {weeks.map((week, colIdx) => (
                <div key={colIdx} style={{ display: 'flex', flexDirection: 'column', gap: `${GAP}px` }}>
                  {week.map((dateStr, rowIdx) => {
                    if (!dateStr) {
                      return <div key={rowIdx} style={{ width: CELL, height: CELL, flexShrink: 0 }} />;
                    }

                    const isFuture    = dateStr > todayStr;
                    const isToday     = dateStr === todayStr;
                    const count       = data[dateStr] || 0;
                    const fillOpacity = isFuture
                      ? FUTURE_OPACITY
                      : count > 0
                        ? (opacityMap[dateStr] ?? MIN_ACTIVE_OPACITY)
                        : EMPTY_OPACITY;
                    const fillColor   = count > 0 && !isFuture ? cellColor : C.border;
                    const tip         = count > 0 && !isFuture
                      ? `${dateStr}: ${count} ${typeof itemLabel === 'function' ? itemLabel(count) : itemLabel}`
                      : dateStr;

                    return (
                      // Outer wrapper owns the today outline at full opacity.
                      // Inner div owns the fill color at variable opacity.
                      <div
                        key={rowIdx}
                        title={tip}
                        style={{
                          width:         CELL,
                          height:        CELL,
                          borderRadius:  '3px',
                          flexShrink:    0,
                          position:      'relative',
                          outline:       isToday ? `2px solid ${C.accent}` : 'none',
                          outlineOffset: '1px',
                        }}
                      >
                        <div style={{
                          width:        '100%',
                          height:       '100%',
                          borderRadius: '3px',
                          background:   fillColor,
                          opacity:      fillOpacity,
                        }} />
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          {/* Month labels row */}
          <div style={{
            display:       'flex',
            flexDirection: 'row',
            gap:           `${GAP}px`,
            marginTop:     '5px',
            marginLeft:    `${DAY_LABEL_W + DAY_LABEL_GAP}px`,
          }}>
            {weeks.map((week, colIdx) => {
              const firstDate    = week.find(d => d != null);
              if (!firstDate) return <div key={colIdx} style={{ width: CELL, flexShrink: 0 }} />;
              const ym           = firstDate.slice(0, 7);
              const prevWeek     = colIdx > 0 ? weeks[colIdx - 1] : null;
              const prevFirst    = prevWeek?.find(d => d != null);
              const prevYm       = prevFirst?.slice(0, 7);
              const isMonthStart = ym !== prevYm;

              return (
                <div key={colIdx} style={{ width: CELL, flexShrink: 0, position: 'relative' }}>
                  {isMonthStart && (
                    <div style={{
                      position:      'absolute',
                      left:          0,
                      fontSize:      '9px',
                      fontWeight:    600,
                      color:         C.textM,
                      letterSpacing: '0.04em',
                      textTransform: 'uppercase',
                      userSelect:    'none',
                      whiteSpace:    'nowrap',
                    }}>
                      {(() => {
                        const [y, m] = ym.split('-').map(Number);
                        const label  = MONTH_NAMES[m - 1];
                        return (m === 1 || ym === startYM) ? `${label} '${ym.slice(2, 4)}` : label;
                      })()}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

        </div>
      </div>
    </div>
  );
}