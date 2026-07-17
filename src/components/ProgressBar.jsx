import { useState, useEffect, useRef } from 'react';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { SH } from '../theme/buildStyles.js';

export function ProgressBar({ done, total, color, label, onComplete }) {
  const { C } = useAppTheme();
  const prevRef = useRef(done);
  const [burst, setBurst] = useState(false);
  const [particles, setParticles] = useState([]);
  const col = color || C.accent;

  // Over-quota: any reviews done when none were due, or more done than due.
  const overQuota = (total === 0 && done > 0) || (total > 0 && done > total);

  // When over-quota the bar fills to 100% and glows persistently.
  const pct      = overQuota ? 100 : (total > 0 ? Math.round((done / total) * 100) : 0);
  const complete  = !overQuota && pct === 100 && total > 0;

  useEffect(() => {
    const wasComplete = total > 0 && prevRef.current === total;
    if (complete && !wasComplete) {
      setBurst(true);
      setParticles(Array.from({ length: 12 }, (_, i) => ({
        id: i,
        dx: (Math.random() - 0.5) * 90,
        dy: -(Math.random() * 70 + 20),
        col: [col, C.accent2, '#fff', col + 'aa'][i % 4],
      })));
      setTimeout(() => { setBurst(false); setParticles([]); }, 900);
      if (onComplete) onComplete();
    }
    prevRef.current = done;
  }, [done, total, complete]);

  // Burst takes priority so the one-shot animation plays on exact completion.
  // Over-quota uses a slower looping version of the same keyframe.
  const animStr = burst
    ? 'progressGlow 0.7s ease'
    : overQuota
      ? 'progressGlow 2.8s ease-in-out infinite'
      : 'none';

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: C.textM, marginBottom: '5px' }}>
        <span>{label || 'Progress'}</span>
        <span style={{ color: col, fontFamily: SH.fm, fontWeight: (complete || overQuota) ? 600 : 400 }}>
          {done} / {total}
        </span>
      </div>
      <div style={{ height: '5px', background: `${col}22`, borderRadius: '3px', overflow: 'visible', position: 'relative' }}>
        <div style={{
          height: '100%', width: `${pct}%`, background: col, borderRadius: '3px',
          transition: 'width 0.4s ease',
          animation: animStr,
        }} />
      </div>
      {particles.map(p => (
        <div key={p.id} style={{
          position: 'absolute', bottom: '0px', left: `${Math.min(pct, 98)}%`,
          '--dx': `${p.dx}px`, '--dy': `${p.dy}px`,
          width: '5px', height: '5px', borderRadius: '50%',
          background: p.col, pointerEvents: 'none',
          animation: 'particlePop 0.85s ease-out forwards',
        }} />
      ))}
    </div>
  );
}
