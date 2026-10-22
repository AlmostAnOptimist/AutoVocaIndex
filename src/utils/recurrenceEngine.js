import { getLogicalToday, toDateStr, parseDate, getTaskDates } from './dateUtils.js';

// F1 GUARD: recurrence and multi-date due dates are mutually exclusive by
// design, and push tasks are single-date. Recurring/push logic below only
// ever sees single-date tasks; multi-date tasks pass through untouched
// except overdue auto-unscheduling, which keys off their LAST date. Do not
// add dates[] handling to any recurrence logic.

export function getNextOccurrence(task, afterDate) {
  const r = task.recurrence || {};
  const base = new Date(afterDate);
  base.setDate(base.getDate() + 1);

  if (r.type === 'daily') return toDateStr(base);

  if (r.type === 'biweekly') {
    const orig = parseDate(task.date);
    if (!orig) return toDateStr(base);
    const d = new Date(orig);
    while (d <= afterDate) d.setDate(d.getDate() + 14);
    return toDateStr(d);
  }

  if (r.type === 'every_n_days') {
    const n = Math.max(2, Math.min(100, r.interval || 3));
    return toDateStr(new Date(afterDate.getTime() + n * 86400000));
  }

  if (r.type === 'specific_days' || r.type === 'twice_weekly') {
    const days = r.days || [];
    if (!days.length) return toDateStr(base);
    const DAY_MAP = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
    const targets = days.map(d => DAY_MAP[d]).filter(d => d !== undefined);
    const d = new Date(base);
    for (let i = 0; i < 14; i++) {
      if (targets.includes(d.getDay())) return toDateStr(d);
      d.setDate(d.getDate() + 1);
    }
    return toDateStr(base);
  }

  if (r.type === 'monthly_date') {
    const dom = Math.max(1, Math.min(31, r.dayOfMonth || 1));
    const d = new Date(afterDate.getFullYear(), afterDate.getMonth(), 1);
    for (let attempt = 0; attempt < 3; attempt++) {
      const maxDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      const candidate = new Date(d.getFullYear(), d.getMonth(), Math.min(dom, maxDay));
      if (candidate > afterDate) return toDateStr(candidate);
      d.setMonth(d.getMonth() + 1);
    }
    return toDateStr(base);
  }

  if (r.type === 'every_x_months_on_date') {
    const interval = Math.max(1, r.interval || 1);
    const dom = Math.max(1, Math.min(31, r.dayOfMonth || 1));
    const orig = parseDate(task.date);
    const startMonth = orig
      ? orig.getFullYear() * 12 + orig.getMonth()
      : afterDate.getFullYear() * 12 + afterDate.getMonth();
    const currentMonth = afterDate.getFullYear() * 12 + afterDate.getMonth();
    let monthsAhead = ((currentMonth - startMonth) % interval + interval) % interval;
    if (monthsAhead === 0) monthsAhead = interval;
    for (let attempt = 0; attempt < 3; attempt++) {
      const targetMonthAbs = currentMonth + monthsAhead + attempt * interval;
      const yr = Math.floor(targetMonthAbs / 12);
      const mo = targetMonthAbs % 12;
      const maxDay = new Date(yr, mo + 1, 0).getDate();
      const candidate = new Date(yr, mo, Math.min(dom, maxDay));
      if (candidate > afterDate) return toDateStr(candidate);
    }
    return toDateStr(base);
  }

  if (r.type === 'monthly_relative') {
    const weekMap = { first: 1, second: 2, third: 3, last: -1 };
    const dayMap  = { Monday:1, Tuesday:2, Wednesday:3, Thursday:4, Friday:5, Saturday:6, Sunday:0 };
    const week = weekMap[r.week || 'first'];
    const dow  = dayMap[r.dayOfWeek || 'Monday'];
    let m = new Date(afterDate.getFullYear(), afterDate.getMonth(), 1);
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = getNthWeekday(m.getFullYear(), m.getMonth(), dow, week);
      if (result && result > afterDate) return toDateStr(result);
      m.setMonth(m.getMonth() + 1);
    }
    return toDateStr(base);
  }

  if (r.type === 'every_x_months_on_weekday') {
    const interval = Math.max(1, r.interval || 1);
    const weekMap = { first: 1, second: 2, third: 3, last: -1 };
    const dayMap  = { Monday:1, Tuesday:2, Wednesday:3, Thursday:4, Friday:5, Saturday:6, Sunday:0 };
    const week = weekMap[r.week || 'first'];
    const dow  = dayMap[r.dayOfWeek || 'Monday'];
    const orig = parseDate(task.date);
    const startMonth = orig
      ? orig.getFullYear() * 12 + orig.getMonth()
      : afterDate.getFullYear() * 12 + afterDate.getMonth();
    const currentMonth = afterDate.getFullYear() * 12 + afterDate.getMonth();
    let monthsAhead = ((currentMonth - startMonth) % interval + interval) % interval;
    if (monthsAhead === 0) monthsAhead = interval;
    for (let attempt = 0; attempt < 4; attempt++) {
      const targetMonthAbs = currentMonth + monthsAhead + attempt * interval;
      const yr = Math.floor(targetMonthAbs / 12);
      const mo = targetMonthAbs % 12;
      const result = getNthWeekday(yr, mo, dow, week);
      if (result && result > afterDate) return toDateStr(result);
    }
    return toDateStr(base);
  }

  if (r.type === 'yearly') {
    const month = Math.max(0, Math.min(11, (r.monthOfYear ?? 0)));
    const dom   = Math.max(1, Math.min(31, r.dayOfMonth || 1));
    for (let yr = afterDate.getFullYear(); yr <= afterDate.getFullYear() + 2; yr++) {
      const maxDay = new Date(yr, month + 1, 0).getDate();
      const candidate = new Date(yr, month, Math.min(dom, maxDay));
      if (candidate > afterDate) return toDateStr(candidate);
    }
    return toDateStr(base);
  }

  return toDateStr(base);
}

function getNthWeekday(year, month, dow, n) {
  if (n === -1) {
    const last = new Date(year, month + 1, 0);
    while (last.getDay() !== dow) last.setDate(last.getDate() - 1);
    return last;
  }
  const d = new Date(year, month, 1);
  while (d.getDay() !== dow) d.setDate(d.getDate() + 1);
  d.setDate(d.getDate() + (n - 1) * 7);
  if (d.getMonth() !== month) return null;
  return d;
}

export function getWindowEnd(task) {
  const dueDate = parseDate(task.date);
  if (!dueDate) return null;
  const r = task.recurrence || {};

  if (r.type === 'daily') return dueDate;

  if (r.type === 'specific_days' || r.type === 'twice_weekly') {
    const days = r.days || [];
    if (!days.length) {
      const end = new Date(dueDate); end.setDate(end.getDate() + 6); return end;
    }
    const DAY_MAP = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
    const targets = days.map(d => DAY_MAP[d]).filter(d => d !== undefined);
    const d = new Date(dueDate);
    d.setDate(d.getDate() + 1);
    for (let i = 0; i < 7; i++) {
      if (targets.includes(d.getDay())) {
        const end = new Date(d);
        end.setDate(end.getDate() - 1);
        return end;
      }
      d.setDate(d.getDate() + 1);
    }
    const end = new Date(dueDate); end.setDate(end.getDate() + 6); return end;
  }

  if (r.type === 'biweekly') {
    const end = new Date(dueDate); end.setDate(end.getDate() + 13); return end;
  }
  if (r.type === 'every_n_days') {
    const n = Math.max(2, Math.min(100, r.interval || 3));
    const end = new Date(dueDate); end.setDate(end.getDate() + n - 1); return end;
  }
  if (r.type === 'monthly_date' || r.type === 'monthly_relative') {
    return new Date(dueDate.getFullYear(), dueDate.getMonth() + 1, 0);
  }
  if (r.type === 'every_x_months_on_date' || r.type === 'every_x_months_on_weekday') {
    const interval = Math.max(1, r.interval || 1);
    return new Date(dueDate.getFullYear(), dueDate.getMonth() + interval, 0);
  }
  if (r.type === 'yearly') {
    return new Date(dueDate.getFullYear(), 11, 31);
  }
  return dueDate;
}

const OVERDUE_AUTO_UNSCHEDULE_DAYS = 14;

// T8: enough steps for a daily task missed for almost three years.
const MAX_CATCH_UP_STEPS = 1000;

// Rolls a recurring task forward as far as `logicalToday` calls for, in one
// go. A completed occurrence rolls once the day after its due date; a missed
// one once its grace window has ended (getWindowEnd); and the occurrence it
// lands on goes through the same test, so a task that's several steps behind
// catches up in a single run instead of one step per run (Sept incident
// patch 5). Each step counts from the due date, never from when the engine
// happens to run. Returns the same object when nothing moves.
export function rollRecurringTask(task, logicalToday) {
  let cur = task;
  for (let i = 0; i < MAX_CATCH_UP_STEPS; i++) {
    const dueDate = parseDate(cur.date);
    if (!dueDate) break;
    let shouldAdvance;
    if (cur.completed) {
      // Completed: advance as soon as the logical day has moved past the due date.
      shouldAdvance = logicalToday > dueDate;
    } else {
      // Missed: use the grace window so the task stays visible until
      // the next occurrence slot is about to begin.
      const windowEnd = getWindowEnd(cur);
      if (!windowEnd) break;
      shouldAdvance = logicalToday > windowEnd;
    }
    if (!shouldAdvance) break;

    const nextDate = getNextOccurrence(cur, dueDate);
    if (!nextDate || nextDate <= cur.date) break;

    let notes = cur.notes || '';
    if (cur.keepRecord && cur.completed && cur.date) {
      const entry = `[${cur.date}] Done`;
      notes = notes.trim() ? `${entry}\n${notes.trim()}` : entry;
    }

    cur = {
      ...cur,
      date: nextDate,
      completed: false,
      completedAt: null,
      notes,
      recurrence: {
        ...cur.recurrence,
        nextDue: nextDate,
        lastReset: toDateStr(logicalToday),
      },
    };
  }
  return cur;
}

// T7: where a recurring task completed today will land once the engine
// rolls it — the day after its due date, or today when it was finished
// late — so Upcoming's "next" date matches what actually happens.
export function nextDueAfterCompletion(task, logicalToday) {
  const due = parseDate(task.date);
  if (!due) return getNextOccurrence(task, logicalToday);
  const dayAfterDue = new Date(due);
  dayAfterDue.setDate(dayAfterDue.getDate() + 1);
  const rollDay = logicalToday > due ? logicalToday : dayAfterDue;
  const rolled = rollRecurringTask({ ...task, completed: true }, rollDay);
  return rolled.date !== task.date ? rolled.date : getNextOccurrence(task, due);
}

export function runRecurrenceEngine(tasks, dsh) {
  const logicalToday = getLogicalToday(dsh);
  const cutoff = new Date(logicalToday);
  cutoff.setDate(cutoff.getDate() - OVERDUE_AUTO_UNSCHEDULE_DAYS);

  let changed = false;

  const updated = tasks.map(task => {
    // ── Persistent tasks: skip all recurrence/overdue logic ──
    if (task.persistent) return task;

    // ── Multi-date tasks (F1): never pushed; overdue auto-unscheduling ──
    // keys off the LAST date and clears date, dates, and completedDates
    // together so the doc returns to legacy single-shape.
    const taskDates = getTaskDates(task);
    if (taskDates.length > 1) {
      if ((!task.recurrence || task.recurrence.type === 'none') && !task.completed) {
        const lastD = parseDate(taskDates[taskDates.length - 1]);
        if (lastD && lastD < cutoff) {
          changed = true;
          const { dates, completedDates, ...rest } = task;
          return { ...rest, date: null };
        }
      }
      return task;
    }

    // ── Push tasks: reset date to today on each rollover ──
    if (task.push && (!task.recurrence || task.recurrence.type === 'none')) {
      if (task.date && !task.completed) {
        const d = parseDate(task.date);
        if (d && d < logicalToday) {
          changed = true;
          return { ...task, date: toDateStr(logicalToday) };
        }
      }
      return task;
    }

    // ── Auto-unschedule non-recurring tasks more than 14 days overdue ──
    if (!task.recurrence || task.recurrence.type === 'none') {
      if (task.date && !task.completed) {
        const d = parseDate(task.date);
        if (d && d < cutoff) {
          changed = true;
          return { ...task, date: null };
        }
      }
      return task;
    }

    // ── Recurring tasks ──
    // T8: rolled all the way in one run (rollRecurringTask).
    if (!task.date) return task;
    const rolled = rollRecurringTask(task, logicalToday);
    if (rolled !== task) changed = true;
    return rolled;
  });

  return { tasks: updated, changed };
}