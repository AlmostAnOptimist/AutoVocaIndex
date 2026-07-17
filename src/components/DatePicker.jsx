import { useState, useEffect, useRef } from 'react';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { SH } from '../theme/buildStyles.js';
import { getLogicalToday } from '../utils/dateUtils.js';


const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function parseYMD(str) {
  if (!str) return null;
  const [y, m, d] = str.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function toYMD(d) {
  if (!d) return '';
  const yr  = d.getFullYear();
  const mo  = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${yr}-${mo}-${day}`;
}

function sameDay(a, b) {
  if (!a || !b) return false;
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth()    === b.getMonth()    &&
         a.getDate()     === b.getDate();
}

export function DatePicker({ value, onChange, placeholder = 'Select date', dsh = 3 }) {
  const { C, S } = useAppTheme();
  const [open, setOpen]         = useState(false);
  const [viewYear, setViewYear] = useState(null);
  const [viewMonth, setViewMonth] = useState(null);
  const ref = useRef(null);

  const selected = parseYMD(value);
  const today    = getLogicalToday(dsh);

  // Initialise viewport to selected date or today
  useEffect(() => {
    const base = selected || today;
    setViewYear(base.getFullYear());
    setViewMonth(base.getMonth());
  }, [open]); // re-initialise each time picker opens

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (viewYear === null) return null;

  const goPrevMonth = () => {
    if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); }
    else setViewMonth(m => m - 1);
  };
  const goNextMonth = () => {
    if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); }
    else setViewMonth(m => m + 1);
  };

  // Build calendar cells — Monday start
  const firstDay    = new Date(viewYear, viewMonth, 1);
  const startOffset = (firstDay.getDay() + 6) % 7; // Mon=0 … Sun=6
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const cells       = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const selectDay = (day) => {
    const d = new Date(viewYear, viewMonth, day);
    onChange(toYMD(d));
    setOpen(false);
  };

  const clearDate = (e) => {
    e.stopPropagation();
    onChange('');
  };

  // Display label
  const displayLabel = selected
    ? selected.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
    : placeholder;

  return (
    <div ref={ref} style={{ position: 'relative', width: '100%' }}>

      {/* Trigger button */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          ...S.formInput,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          cursor: 'pointer', userSelect: 'none',
          color: selected ? (C.bgText || C.text) : C.textM,
        }}
      >
        <span style={{ fontSize: '13.5px' }}>{displayLabel}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {selected && (
            <span
              onClick={clearDate}
              style={{ fontSize: '14px', color: C.textM, lineHeight: 1, padding: '0 2px' }}
              title="Clear date"
            >
              ×
            </span>
          )}
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
            <rect x="1" y="2" width="10" height="9" rx="1.5" stroke={C.textM} strokeWidth="1.2"/>
            <path d="M4 1v2M8 1v2" stroke={C.textM} strokeWidth="1.2" strokeLinecap="round"/>
            <path d="M1 5h10" stroke={C.textM} strokeWidth="1.2"/>
          </svg>
        </div>
      </div>

      {/* Calendar dropdown */}
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 500,
          background: C.cardBg || C.surface,
          border: `1px solid ${C.border}`,
          borderRadius: '10px',
          padding: '12px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
          minWidth: '260px',
          width: '100%',
        }}>

          {/* Month navigation */}
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: '10px' }}>
            <button
              onClick={goPrevMonth}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: C.textM, fontSize: '16px', lineHeight: 1,
                padding: '2px 8px', borderRadius: '4px',
              }}
            >&#8249;</button>
            <div style={{
              flex: 1, textAlign: 'center',
              fontFamily: SH.fd, fontSize: '14px',
              color: C.text,
            }}>
              {MONTHS[viewMonth]} {viewYear}
            </div>
            <button
              onClick={goNextMonth}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: C.textM, fontSize: '16px', lineHeight: 1,
                padding: '2px 8px', borderRadius: '4px',
              }}
            >&#8250;</button>
          </div>

          {/* Weekday headers */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)',
            gap: '2px', marginBottom: '4px',
          }}>
            {WEEKDAYS.map(d => (
              <div key={d} style={{
                textAlign: 'center', fontSize: '9px', fontWeight: 600,
                letterSpacing: '0.07em', textTransform: 'uppercase',
                color: C.textM, padding: '2px 0',
              }}>{d}</div>
            ))}
          </div>

          {/* Day grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px' }}>
            {cells.map((day, i) => {
              if (!day) return <div key={`e-${i}`} />;
              const thisDate  = new Date(viewYear, viewMonth, day);
              const isSelected = sameDay(thisDate, selected);
              const isToday    = sameDay(thisDate, today);

              return (
                <div
                  key={day}
                  onClick={() => selectDay(day)}
                  style={{
                    textAlign: 'center',
                    padding: '5px 2px',
                    borderRadius: '5px',
                    fontSize: '12px',
                    fontFamily: SH.fm,
                    cursor: 'pointer',
                    background: isSelected
                      ? C.warning
                      : isToday
                        ? `${C.warning}28`
                        : 'transparent',
                    color: isSelected
                      ? '#fff'
                      : isToday
                        ? C.warning
                        : C.text,
                    fontWeight: isSelected || isToday ? 600 : 400,
                    transition: 'background 0.12s',
                  }}
                >
                  {day}
                </div>
              );
            })}
          </div>

          {/* Today shortcut */}
          <div style={{
            marginTop: '10px', paddingTop: '8px',
            borderTop: `1px solid ${C.border}`,
            display: 'flex', justifyContent: 'center',
          }}>
            <button
              onClick={() => { onChange(toYMD(today)); setOpen(false); }}
              style={{
                fontSize: '11px', fontWeight: 500,
                color: C.warning, background: 'none',
                border: 'none', cursor: 'pointer',
                padding: '2px 8px',
              }}
            >
              Today
            </button>
          </div>

        </div>
      )}
    </div>
  );
}