import { useState, useEffect, useRef } from 'react';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { SH } from '../theme/buildStyles.js';
import { Icons } from './Icons.jsx';
import { splitTime, joinTime, parseTypedTime } from '../utils/timeInput.js';

const isMobile = typeof window !== 'undefined' && (window.innerWidth <= 700 || window.matchMedia('(hover: none) and (pointer: coarse) and (orientation: portrait)').matches);

const HOURS   = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

// The time field for tasks and appointments: type a time, and an AM/PM
// toggle appears beside it (AM unless switched; a typed "pm" or a 24-hour
// hour sets it too). The clock opens a picker in DatePicker's style.
//   value / onChange: 'HH:MM' (24-hour) or '' — the stored shape, unchanged.
//   onInvalidChange(bool): text that isn't a time, so the form can hold Save.
//   onKeyDown: passed to the text box (Enter-to-add in follow-up rows).
//   compact: the narrow follow-up column.
//   align: which edge the picker lines up with ('left' | 'right').
export function TimePicker({ value, onChange, onInvalidChange, onKeyDown, compact = false, align = 'left', placeholder = 'e.g. 10:30' }) {
  const { C, S } = useAppTheme();
  const start = splitTime(value);
  const [text,    setText]    = useState(start.text);
  const [ampm,    setAmpm]    = useState(start.ampm);
  const [open,    setOpen]    = useState(false);
  const [touched, setTouched] = useState(false);
  const [focused, setFocused] = useState(false);
  // The value as this field last sent or received it. A different value
  // from outside (a reset, the follow-up row cleared after Add) replaces the
  // text; the field's own edits don't.
  const [seen, setSeen] = useState(value || '');
  const ref = useRef(null);
  if ((value || '') !== seen) {
    const s = splitTime(value);
    setSeen(value || '');
    setText(s.text);
    setAmpm(s.ampm);
    setTouched(false);
  }

  const parsed  = parseTypedTime(text, ampm);
  const invalid = parsed === null;

  const reportRef = useRef(onInvalidChange);
  useEffect(() => { reportRef.current = onInvalidChange; });
  useEffect(() => { if (reportRef.current) reportRef.current(invalid); }, [invalid]);
  // Unmounted (the section closed): nothing left to hold Save.
  useEffect(() => () => { if (reportRef.current) reportRef.current(false); }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const emit = (v) => {
    setSeen(v);
    if (v !== (value || '')) onChange(v);
  };

  const typed = (t) => {
    setText(t);
    const r = parseTypedTime(t, ampm);
    if (!r) { emit(''); return; }
    if (r.empty) { setAmpm('AM'); setTouched(false); emit(''); return; }
    if (r.ampm !== ampm) setAmpm(r.ampm);
    emit(r.value);
  };

  const setSide = (side) => {
    setAmpm(side);
    const r = parseTypedTime(text, ampm);
    if (r && !r.empty) { setText(r.text); emit(joinTime(r.hour, r.minute, side)); }
  };

  const pick = (hour, minute, side) => {
    setText(`${hour}:${String(minute).padStart(2, '0')}`);
    setAmpm(side);
    setTouched(false);
    emit(joinTime(hour, minute, side));
  };

  const clear = () => { setText(''); setAmpm('AM'); setTouched(false); emit(''); };

  const hasTime  = !!(parsed && !parsed.empty);
  const showSide = text.trim() !== '';
  const bad      = invalid && touched;
  const accent   = C.warning;

  const sideBtn = (side) => ({
    fontFamily: SH.fm, fontSize: compact ? '10.5px' : '11px', fontWeight: 600, letterSpacing: '0.04em',
    padding: compact ? '1px 5px' : '2px 7px', lineHeight: 1.4, cursor: 'pointer', flexShrink: 0,
    border: `1px solid ${accent}`, borderRadius: '3px',
    background: side === 'PM' ? accent : `${accent}1f`,
    color: side === 'PM' ? '#fff' : accent,
  });

  const cell = (on, disabled) => ({
    textAlign: 'center', padding: '5px 2px', borderRadius: '5px',
    fontSize: '12px', fontFamily: SH.fm, cursor: disabled ? 'default' : 'pointer',
    background: on ? accent : 'transparent',
    color: on ? '#fff' : C.text, opacity: disabled ? 0.35 : 1,
    fontWeight: on ? 600 : 400, transition: 'background 0.12s',
  });

  const groupLabel = {
    fontSize: '9px', fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase',
    color: C.textM, margin: '8px 0 4px',
  };

  return (
    <div ref={ref} style={{ position: 'relative', width: '100%' }}>
      <div
        style={{
          ...S.formInput,
          display: 'flex', alignItems: 'center', gap: compact ? '4px' : '6px',
          padding: compact ? '0 6px 0 8px' : '0 8px 0 12px',
          borderColor: bad ? C.danger : (focused || open) ? accent : C.border,
        }}
      >
        <input
          type="text"
          inputMode="numeric"
          autoComplete="off"
          aria-label="Time"
          aria-invalid={bad || undefined}
          value={text}
          placeholder={compact ? '--:--' : placeholder}
          onChange={e => typed(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setTouched(true);
            if (parsed && !parsed.empty) setText(parsed.text);
          }}
          onKeyDown={e => {
            // Enter submits the form; let it show why it was held.
            if (e.key === 'Enter' && invalid) setTouched(true);
            if (onKeyDown) onKeyDown(e);
          }}
          style={{
            flex: '1 1 auto', width: 0, minWidth: 0, background: 'transparent', border: 'none', outline: 'none',
            padding: '9px 0', lineHeight: '21px', fontFamily: SH.fm, fontSize: isMobile ? '16px' : '13.5px',
            color: C.bgText || C.text,
          }}
        />
        {showSide && (
          <button
            type="button"
            onClick={() => setSide(ampm === 'AM' ? 'PM' : 'AM')}
            title={`Switch to ${ampm === 'AM' ? 'PM' : 'AM'}`}
            aria-label={`${ampm}, switch to ${ampm === 'AM' ? 'PM' : 'AM'}`}
            style={sideBtn(ampm)}
          >
            {ampm}
          </button>
        )}
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          title="Pick a time"
          aria-label="Pick a time"
          aria-expanded={open}
          style={{ background: 'none', border: 'none', padding: '2px', cursor: 'pointer', color: open ? accent : C.textM, display: 'flex', flexShrink: 0 }}
        >
          {Icons.clock}
        </button>
      </div>

      {bad && (
        <div style={{ fontSize: '11px', color: C.danger, marginTop: '4px' }}>
          Not a time. Try 10:30.
        </div>
      )}

      {open && (
        <div
          onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }}
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', zIndex: 500,
            ...(align === 'right' ? { right: 0 } : { left: 0 }),
            background: C.cardBg || C.surface,
            border: `1px solid ${C.border}`, borderRadius: '10px',
            padding: '12px', boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
            width: '232px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontFamily: SH.fd, fontSize: '15px', color: hasTime ? C.text : C.textM }}>
              {hasTime ? `${parsed.text} ${parsed.ampm}` : 'No time'}
            </div>
            <div style={{ display: 'flex', gap: '4px' }}>
              {['AM', 'PM'].map(side => (
                <button
                  key={side}
                  type="button"
                  onClick={() => (hasTime ? pick(parsed.hour, parsed.minute, side) : setAmpm(side))}
                  style={{
                    fontFamily: SH.fm, fontSize: '11px', fontWeight: 600, padding: '3px 8px', cursor: 'pointer',
                    borderRadius: '4px', border: `1px solid ${ampm === side ? accent : C.border}`,
                    background: ampm === side ? `${accent}28` : 'transparent',
                    color: ampm === side ? accent : C.textM,
                  }}
                >
                  {side}
                </button>
              ))}
            </div>
          </div>

          <div style={groupLabel}>Hour</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '2px' }}>
            {HOURS.map(h => (
              <div key={h} role="button" onClick={() => pick(h, hasTime ? parsed.minute : 0, ampm)} style={cell(hasTime && parsed.hour === h, false)}>
                {h}
              </div>
            ))}
          </div>

          <div style={groupLabel}>Minute</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '2px' }}>
            {MINUTES.map(m => (
              <div
                key={m}
                role="button"
                aria-disabled={!hasTime || undefined}
                onClick={() => { if (hasTime) pick(parsed.hour, m, ampm); }}
                style={cell(hasTime && parsed.minute === m, !hasTime)}
              >
                {String(m).padStart(2, '0')}
              </div>
            ))}
          </div>

          <div style={{
            marginTop: '10px', paddingTop: '8px', borderTop: `1px solid ${C.border}`,
            display: 'flex', justifyContent: 'space-between',
          }}>
            <button
              type="button"
              onClick={() => { clear(); setOpen(false); }}
              style={{ fontSize: '11px', fontWeight: 500, color: C.textM, background: 'none', border: 'none', cursor: 'pointer', padding: '2px 8px' }}
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              style={{ fontSize: '11px', fontWeight: 500, color: accent, background: 'none', border: 'none', cursor: 'pointer', padding: '2px 8px' }}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
