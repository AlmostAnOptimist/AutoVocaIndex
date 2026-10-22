// ── Appointment follow-up promotion (bug sweep K5) ───────────────────────────
// Leaf module: no page or hook imports.
//
// When an appointment's date has passed and it has follow-ups queued, the
// next follow-up becomes the appointment's date and each past visit date is
// stamped "[YYYY-MM-DD]" at the top of its results. App runs this on every
// appointments snapshot and on the day flip.

// Whether results already carry a "[date]" stamp at the start of a line.
export function hasVisitStamp(results, date) {
  return (results || '').split('\n').some(line => line.trim().startsWith(`[${date}]`));
}

// Adds one visit stamp, oldest first so the newest ends on top. A date that
// is already stamped is left alone (K5: a promotion that runs twice, or one
// that runs again after an older date was written back, stamps once).
export function stampVisit(results, date) {
  const trimmed = (results || '').trim();
  if (hasVisitStamp(trimmed, date)) return results || '';
  if (!trimmed) return `[${date}]`;
  if (trimmed.startsWith('[')) return `[${date}]\n${trimmed}`;
  return `[${date}] ${trimmed}`;
}

// The promotion for one appointment, or null when it has nothing to promote.
// Returns the fields to write (date, time, results, followUpQueue,
// lastVisitDate; the legacy followUpDate/followUpTime are dropped by the
// caller) and whether a follow-up is still upcoming.
export function planFollowUpPromotion(appt, todayStr) {
  if (!appt || !appt.date || appt.date >= todayStr) return null;
  const legacy = appt.followUpDate && !appt.followUpQueue;
  if (!legacy && !(appt.followUpQueue || []).length) return null;

  const queue = (legacy
    ? [{ date: appt.followUpDate, time: appt.followUpTime || '' }]
    : [...appt.followUpQueue]
  ).sort((a, b) => a.date.localeCompare(b.date));

  const pastItems   = queue.filter(q => q.date <  todayStr);
  const futureItems = queue.filter(q => q.date >= todayStr);

  // All past dates in chronological order (original appt date first)
  const datesToLog = [appt.date, ...pastItems.map(q => q.date)].sort();
  let results = appt.results || '';
  datesToLog.forEach(d => { results = stampVisit(results, d); });

  const lastVisitDate = datesToLog[datesToLog.length - 1];
  const hasUpcoming   = futureItems.length > 0;
  return {
    fields: {
      date:          hasUpcoming ? futureItems[0].date         : lastVisitDate,
      time:          hasUpcoming ? (futureItems[0].time || '') : (appt.time || ''),
      results,
      followUpQueue: hasUpcoming ? futureItems.slice(1)        : [],
      lastVisitDate,
    },
    hasUpcoming,
  };
}
