// ── Typed time with an AM/PM toggle ──────────────────────────────────────────
// Leaf module: no page or hook imports.
//
// Times are stored as 'HH:MM' (24-hour) or '' for none, as before. The time
// field shows them as 12-hour text plus an AM/PM toggle: the browser's own
// time box saved nothing when AM/PM was left blank, so the toggle always has
// a side (AM unless switched).

// 'HH:MM' -> { text: 'h:mm', ampm: 'AM' | 'PM' } (empty for '' or junk).
export function splitTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value || '');
  if (!m) return { text: '', ampm: 'AM' };
  const h = Number(m[1]);
  if (h > 23 || Number(m[2]) > 59) return { text: '', ampm: 'AM' };
  return { text: `${h % 12 || 12}:${m[2]}`, ampm: h >= 12 ? 'PM' : 'AM' };
}

// 12-hour parts -> 'HH:MM'.
export function joinTime(hour12, minute, ampm) {
  const h = (hour12 % 12) + (ampm === 'PM' ? 12 : 0);
  return `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// What was typed, read against the toggle's side. Accepts 10:30, 10.30,
// 10 30, 1030, 930, 9 and a trailing am/pm (which sets the side). An hour of
// 13–23 is read as 24-hour (PM); 0 is 12 AM.
//   ''          -> { empty: true }
//   recognised  -> { value: 'HH:MM', text: 'h:mm', ampm, hour, minute }
//   otherwise   -> null
export function parseTypedTime(raw, ampm = 'AM') {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return { empty: true };
  let side = ampm === 'PM' ? 'PM' : 'AM';
  const suffix = /\s*([ap])\.?\s*(m\.?)?$/.exec(s);
  if (suffix) {
    side = suffix[1] === 'p' ? 'PM' : 'AM';
    s = s.slice(0, suffix.index).trim();
  }
  const m = /^(\d{1,2})(?:[:.\s]?(\d{2}))?$/.exec(s);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  if (hour === 0) { hour = 12; side = 'AM'; }
  else if (hour > 12) { hour -= 12; side = 'PM'; }
  return {
    value: joinTime(hour, minute, side),
    text: `${hour}:${String(minute).padStart(2, '0')}`,
    ampm: side, hour, minute,
  };
}
