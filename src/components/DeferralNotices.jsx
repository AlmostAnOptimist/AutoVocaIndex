// src/components/DeferralNotices.jsx
// Deferral notices (DF-D3 to DF-D5), shown on Today and Flashcards in the
// places the spike notices used to be, in the same boxes.
//
//   grouped  (Today)      — the day lines share one solid box
//   separate (Flashcards) — each day line has its own box
// The "if today's aren't finished" line (DF-D4) always has its own dashed box.

import { useAppTheme } from '../hooks/useAppTheme.js';
import { Icons } from './Icons.jsx';
import { deferralNoticeLines } from '../utils/deferralOutlook.js';

export function DeferralNotices({ forecast, grouped = false, wrapStyle }) {
  const { C } = useAppTheme();
  const { days, ifUnfinished } = deferralNoticeLines(forecast);
  if (!days.length && !ifUnfinished) return null;

  const box = (dashed) => ({
    padding: '10px 12px', borderRadius: '8px',
    border: `1px ${dashed ? 'dashed' : 'solid'} ${C.warning}`,
    background: `${C.warning}${dashed ? '09' : '11'}`,
  });
  const line = (icon, text) => (
    <>
      <span style={{ color: C.warning, display: 'flex', flexShrink: 0 }}>{icon}</span>
      <div style={{ fontSize: '12px', fontWeight: 500, color: C.warning }}>{text}</div>
    </>
  );
  const row = { display: 'flex', alignItems: 'center', gap: '8px' };
  const dayIcon = (d) => (d.over ? Icons.alert : Icons.clock);

  const dayBoxes = !days.length ? null : grouped ? (
    <div style={box(false)}>
      {days.map((d, i) => (
        <div key={d.key} style={{ ...row, marginTop: i > 0 ? '6px' : 0 }}>{line(dayIcon(d), d.text)}</div>
      ))}
    </div>
  ) : days.map(d => (
    <div key={d.key} style={{ ...box(false), ...row }}>{line(dayIcon(d), d.text)}</div>
  ));

  const unfinished = ifUnfinished && (
    <div style={{ ...box(true), ...row }}>{line(Icons.alert, ifUnfinished)}</div>
  );

  // Today places the boxes straight into its stats column (which spaces
  // them); Flashcards wraps them in its own column.
  if (!wrapStyle) return <>{dayBoxes}{unfinished}</>;
  return <div style={wrapStyle}>{dayBoxes}{unfinished}</div>;
}
