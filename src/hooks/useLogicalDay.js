// src/hooks/useLogicalDay.js
// Today's logical date ('YYYY-MM-DD', day-start-hour aware) as React state,
// so a component re-renders when the day flips while it stays open (bug
// sweep T4). A timer is set for the next day-start, capped at 30 minutes so
// a clock change or a sleeping laptop can't leave it far behind, and the
// day is checked again whenever the page comes back to the front.
//
// Used once, by App, which passes the day to InnerApp as `logicalDay`. Pages
// below re-render with it, so they read the day per render
// (getLogicalDateStr) and key their memos on that string instead of each
// running a timer of their own.

import { useState, useEffect } from 'react';
import { getLogicalDateStr, msUntilNextDayStart } from '../utils/dateUtils.js';

const MAX_WAIT_MS = 30 * 60 * 1000;

export function useLogicalDay(dsh = 3) {
  const [day, setDay] = useState(() => getLogicalDateStr(dsh));

  useEffect(() => {
    let timer = null;
    const check = () => {
      const now = getLogicalDateStr(dsh);
      setDay(prev => (prev === now ? prev : now));
    };
    const schedule = () => {
      clearTimeout(timer);
      // +1 s so the timer lands just after the boundary, not just before it.
      const wait = Math.min(msUntilNextDayStart(dsh) + 1000, MAX_WAIT_MS);
      timer = setTimeout(() => { check(); schedule(); }, wait);
    };
    const onFront = () => {
      if (document.visibilityState !== 'visible') return;
      check();
      schedule();
    };
    check();
    schedule();
    document.addEventListener('visibilitychange', onFront);
    window.addEventListener('focus', onFront);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onFront);
      window.removeEventListener('focus', onFront);
    };
  }, [dsh]);

  return day;
}
