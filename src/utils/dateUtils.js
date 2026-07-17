export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function getLogicalToday(dsh = 3) {
  const now = new Date();
  if (now.getHours() < dsh) {
    // Before the day-start hour — still the previous logical day
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    return yesterday;
  }
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function toDateStr(d) {
  const yr  = d.getFullYear();
  const mo  = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${yr}-${mo}-${day}`;
}

export function parseDate(s) {
  return s ? new Date(s + 'T00:00:00') : null;
}

export function isToday(d, dsh) {
  if (!d) return false;
  const t = getLogicalToday(dsh);
  return d.getFullYear() === t.getFullYear() &&
         d.getMonth()    === t.getMonth()    &&
         d.getDate()     === t.getDate();
}

export function isTomorrow(d, dsh) {
  if (!d) return false;
  const t = getLogicalToday(dsh);
  const tm = new Date(t);
  tm.setDate(tm.getDate() + 1);
  return d.getFullYear() === tm.getFullYear() &&
         d.getMonth()    === tm.getMonth()    &&
         d.getDate()     === tm.getDate();
}

export function isThisWeek(d, dsh) {
  if (!d) return false;
  const t = getLogicalToday(dsh);
  const e = new Date(t);
  e.setDate(e.getDate() + 7);
  return d > t && d <= e;
}

export function isThisMonth(d, dsh) {
  if (!d) return false;
  const t = getLogicalToday(dsh);
  const e = new Date(t.getFullYear(), t.getMonth() + 1, 0);
  return d > t && d <= e;
}

export function isPast(d, dsh) {
  if (!d) return false;
  return d < getLogicalToday(dsh);
}

export function fmtDate(d) {
  return d ? d.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric'
  }) : '';
}

// Returns today's logical date as a YYYY-MM-DD string, respecting the day-start hour.
// Uses the same local-hour / UTC-date approach as the original FlashcardsPage helper
// so dailyplan doc keys stay consistent.
export function getLogicalDateStr(dsh = 3) {
  return toDateStr(getLogicalToday(dsh));
}

export function getGreeting(dsh) {
  const h = new Date().getHours();
  const e = ((h - dsh) + 24) % 24;
  if (e < 5)  return 'Good evening.';
  if (e < 12) return 'Good morning.';
  if (e < 17) return 'Good afternoon.';
  return 'Good evening.';
}

// Counts the current consecutive-day streak ending at "today" (logical, respecting
// the day-start hour), given a map of { 'YYYY-MM-DD': count }. If today has no
// entry yet, the streak counts through yesterday instead of dropping to 0 — a
// streak shouldn't look broken just because today's session hasn't happened yet.
export function computeStreak(dayMap, dsh = 3) {
  if (!dayMap) return 0;
  let cursor = getLogicalToday(dsh);
  if (!dayMap[toDateStr(cursor)]) {
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - 1);
  }
  let streak = 0;
  while (dayMap[toDateStr(cursor)]) {
    streak++;
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - 1);
  }
  return streak;
}

// ── Multi-date task helpers (Phase F1) ─────────────────────────────
// Tasks may carry dates: string[] (sorted, unique, YYYY-MM-DD). The legacy
// date field remains the anchor (earliest date). All consumers read through
// these helpers — never t.date / t.dates directly.

// Every due date for a task. Falls back to [t.date] for legacy single-date
// docs. Defensively sorted; string sort is correct for YYYY-MM-DD.
export function getTaskDates(t) {
  if (!t) return [];
  if (Array.isArray(t.dates) && t.dates.length) return [...t.dates].sort();
  return t.date ? [t.date] : [];
}

export function taskOccursOn(t, dateStr) {
  return getTaskDates(t).includes(dateStr);
}

// Earliest due date (the anchor written to the legacy date field).
export function taskAnchorDate(t) {
  const d = getTaskDates(t);
  return d.length ? d[0] : null;
}

// Latest due date. Overdue and true-completion semantics key off this.
export function taskLastDate(t) {
  const d = getTaskDates(t);
  return d.length ? d[d.length - 1] : null;
}

export function isLastDate(t, dateStr) {
  const last = taskLastDate(t);
  return !!last && last === dateStr;
}

// DISPLAY rule: a date's row reads as done if that date was checked off,
// or the whole task is finished (a finished item reads finished everywhere).
export function isDateDone(t, dateStr) {
  return !!t.completed || (t.completedDates || []).includes(dateStr);
}

// COUNTING rule: a date bumps completion counts only via completedDates
// membership on multi-date tasks — finishing a whole task early must not
// bump counts for the non-interacted dates. Single-date tasks keep their
// existing completed-flag counting unchanged.
export function isDateCounted(t, dateStr) {
  if (getTaskDates(t).length > 1) return (t.completedDates || []).includes(dateStr);
  return !!t.completed;
}