// src/hooks/useLibraryOverviewData.js
// Active/adrift/queue/recent-activity derivation for the Content Library
// overview surface — extracted from the old CLOverviewTab in
// ContentLibraryPage.jsx (since removed, bug sweep P3) for ContentLibraryGazette.

import { useMemo, useCallback } from 'react';
import { getLogicalDateStr, getTaskDates, isDateDone } from '../utils/dateUtils.js';
import { isPassiveMediaExcluded, getSourceStatus, stripHtml } from '../utils/contentUtils.js';
import { isNuanceSourceTitle } from '../utils/aviUtils.js';

const CEFR = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

// Sources the Overview leaves out of Active, Adrift and the queues: passive
// media, and word lists (the 동의어 list and any Reference › Word List
// source), which are studied through AVI and flashcards rather than read
// or watched. They stay in the Library tab.
function isOverviewHidden(src) {
  return isPassiveMediaExcluded(src) || src.subtype === 'Word List' || isNuanceSourceTitle(src.title);
}
const cefrIdx = (level) => CEFR.indexOf(level);

export function useLibraryOverviewData({
  sources, sectionsBySource, allNotes, correctionSessions,
  grammarEntries, cards, appointments, adriftDays, dsh, tasks,
}) {
  // T4: today is read on every render (App re-renders when the day flips)
  // and the rest keys on the string; memoizing it on dsh alone froze the
  // Overview on the day the page was opened.
  const todayStr      = getLogicalDateStr(dsh);
  const logicalToday = useMemo(() => new Date(todayStr + 'T00:00:00'), [todayStr]);
  const todayMs       = useMemo(() => logicalToday.getTime(), [logicalToday]);
  const adriftLimit   = adriftDays ?? 14;

  // Whole logical days between a timestamp and today. The timestamp is
  // first mapped to its own logical day (before the day-start hour still
  // belongs to the previous day), then compared to today's midnight. The
  // old version measured from today's midnight to the exact timestamp,
  // which ran a day short (an edit earlier today came out as -1).
  const daysSince = useCallback((iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    if (d.getHours() < dsh) d.setDate(d.getDate() - 1);
    const dayMs = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    return Math.max(0, Math.round((todayMs - dayMs) / 86400000));
  }, [todayMs, dsh]);

  const fmtDaysAgo = useCallback((iso) => {
    const days = daysSince(iso);
    if (days === null) return '';
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }, [daysSince]);

  const tasksById = useMemo(() => {
    const m = new Map();
    (tasks || []).forEach(t => { if (t?.id) m.set(t.id, t); });
    return m;
  }, [tasks]);

  // A linked task still has an unfinished due date today or later.
  // Overdue-only, finished, or missing tasks don't count.
  const taskIsUpcoming = useCallback((taskId) => {
    const t = taskId ? tasksById.get(taskId) : null;
    if (!t || t.completed) return false;
    return getTaskDates(t).some(d => d >= todayStr && !isDateDone(t, d));
  }, [tasksById, todayStr]);

  // A Scheduled source or section whose task date hasn't passed yet is a
  // standing plan, so it holds the source in Active regardless of age.
  const hasUpcomingSchedule = useCallback((src) => {
    if (getSourceStatus(src) === 'Scheduled' && taskIsUpcoming(src.linkedTaskId)) return true;
    return (sectionsBySource[src.id] || []).some(s => s.status === 'Scheduled' && taskIsUpcoming(s.linkedTaskId));
  }, [sectionsBySource, taskIsUpcoming]);

  // No qualifying activity (Done, In Progress, or scheduling) for at least
  // the Settings threshold, and no upcoming schedule. Sources with no
  // timestamp at all can't be judged and never count as stale.
  const isStale = useCallback((src) => {
    if (hasUpcomingSchedule(src)) return false;
    const days = daysSince(src.lastActivityAt);
    return days !== null && days >= adriftLimit;
  }, [hasUpcomingSchedule, daysSince, adriftLimit]);

  const isComplete = useCallback((src) => {
    if (src.archived || src.pendingArchive) return true;
    const st = getSourceStatus(src);
    if (st === 'Done') return true;
    const secs = sectionsBySource[src.id] || [];
    if (!secs.length) return st === 'Skip';
    return secs.every(s => s.status === 'Done' || s.status === 'Skip');
  }, [sectionsBySource]);

  // Started and not finished, judged by status alone.
  const isEngaged = useCallback((src) => {
    if (src.paused) return false;
    if (isComplete(src)) return false;
    const st = getSourceStatus(src);
    if (st === 'In Progress' || st === 'Scheduled') return true;
    return (sectionsBySource[src.id] || []).some(s =>
      s.status === 'In Progress' || s.status === 'Scheduled' || s.status === 'Done'
    );
  }, [sectionsBySource, isComplete]);

  // Staleness overrides status: a started source with no recent activity
  // goes Adrift even though it has sections Done or In Progress. This is
  // computed fresh on every render, so older sources need no backfill.
  const isActive = useCallback((src) => isEngaged(src) && !isStale(src), [isEngaged, isStale]);

  const isAdrift = useCallback((src) => {
    if (src.paused) return false;
    if (isActive(src) || isComplete(src)) return false;
    if (!src.lastActivityAt) return false;
    // lastActivityAt only ever advances forward (set on a move to Done or
    // Scheduled) — it's never cleared when that move gets undone. So a
    // section briefly marked Done and immediately reverted leaves a stale
    // timestamp behind even though the source now shows zero progress. If
    // every section currently reads "Not started" (or, for section-less
    // sources, sourceStatus does), there's nothing to call stalled — it's
    // effectively unstarted and belongs back in the Queue, regardless of
    // how old that leftover timestamp is. A source with some sections
    // genuinely Skipped (real, deliberate engagement) and a stale timestamp
    // can still be legitimately adrift — this only screens out the
    // "looks untouched" case specifically.
    const secs = sectionsBySource[src.id] || [];
    const looksUntouched = secs.length
      ? secs.every(s => s.status === 'Not started')
      : getSourceStatus(src) === 'Not started';
    if (looksUntouched) return false;
    return isStale(src);
  }, [isActive, isComplete, isStale, sectionsBySource]);

  const activeSources = useMemo(() => sources.filter(s => isActive(s) && !isOverviewHidden(s)), [sources, isActive]);
  const adriftSources  = useMemo(() => sources.filter(s => isAdrift(s) && !isOverviewHidden(s)), [sources, isAdrift]);

  const activeRange = useMemo(() => {
    const pool = activeSources.length ? activeSources : adriftSources;
    let min = Infinity, max = -Infinity;
    pool.forEach(src => {
      const lo = cefrIdx(src.levelMin);
      const hi = cefrIdx(src.levelMax ?? src.levelMin);
      if (lo >= 0) min = Math.min(min, lo);
      if (hi >= 0) max = Math.max(max, hi);
    });
    return (min <= max && isFinite(min)) ? { min, max } : null;
  }, [activeSources, adriftSources]);

  const queueByTier = useMemo(() => {
    const notQueue = (s) => isActive(s) || isAdrift(s) || isComplete(s);
    const candidates = sources.filter(s => !notQueue(s) && !isOverviewHidden(s)).map(src => {
      const totalSections = (sectionsBySource[src.id] || []).length;
      const seriesBlocked = src.series && src.seriesOrder != null &&
        sources.some(o => o.id !== src.id && o.series === src.series &&
          o.seriesOrder != null && parseFloat(o.seriesOrder) < parseFloat(src.seriesOrder) && !notQueue(o));
      if (seriesBlocked) return null;
      const waiting = src.series && src.seriesOrder != null &&
        [...activeSources, ...adriftSources].some(o => o.series === src.series && o.seriesOrder != null &&
          parseFloat(o.seriesOrder) < parseFloat(src.seriesOrder));
      const lo = cefrIdx(src.levelMin);
      const hi = cefrIdx(src.levelMax ?? src.levelMin);
      let bucket = 2, dist = 0, exactMatch = false;
      if (lo >= 0 && hi >= 0) {
        bucket = 0;
        if (!activeRange) { dist = lo; }
        else if (lo >= activeRange.min && hi <= activeRange.max) { dist = 0; exactMatch = true; }
        else if (hi < activeRange.min) { dist = activeRange.min - hi; }
        else if (lo > activeRange.max) { dist = lo - activeRange.max; }
      }
      return { ...src, _total: totalSections, _waiting: waiting, _exact: exactMatch, _key: [bucket, dist, totalSections] };
    }).filter(Boolean);

    const practiceIds = new Set(candidates.filter(s => s.type === 'Grammar').flatMap(s => s.linkedPracticeSourceIds || []));
    const sortFn = (a, b) => { for (let i = 0; i < 3; i++) if (a._key[i] !== b._key[i]) return a._key[i] - b._key[i]; return 0; };

    const tiers = { grammar: [], mining: [], casual: [] };
    candidates.forEach(src => {
      const tier = src.studyIntent;
      if (!tier || !tiers[tier] || practiceIds.has(src.id)) return;
      tiers[tier].push({ ...src, _practiceItems: (src.linkedPracticeSourceIds || []).map(id => candidates.find(c => c.id === id)).filter(Boolean) });
    });
    Object.keys(tiers).forEach(k => tiers[k].sort(sortFn));
    return tiers;
  }, [sources, sectionsBySource, isActive, isAdrift, isComplete, activeSources, adriftSources, activeRange]);

  const recentGrammarReviews = useMemo(() => (cards || [])
    .filter(c => c.type === 'grammar' && (c.lastReview || c.lastReviewed))
    .sort((a, b) => (b.lastReview || b.lastReviewed).localeCompare(a.lastReview || a.lastReviewed))
    .slice(0, 3)
    .map(c => {
      const entry = grammarEntries.find(e => e.id === c.linkedGrammarEntryId);
      const ml = ['introduced', 'practicing', 'confident', 'mastered'].indexOf(entry?.masteryLevel || 'introduced');
      const rd = new Date(c.lastReview || c.lastReviewed);
      if (rd.getHours() < dsh) rd.setDate(rd.getDate() - 1);
      return { entry, masteryLevel: ml === -1 ? 0 : ml, reviewDate: rd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) };
    })
    .filter(r => r.entry),
    [cards, grammarEntries, dsh]
  );

  const recentLangAppt = useMemo(() =>
    (appointments || []).filter(a => a.category === 'lang' && a.date < todayStr).sort((a, b) => b.date.localeCompare(a.date))[0] || null,
    [appointments, todayStr]
  );

  const openQuestions = useMemo(() =>
    (allNotes || []).filter(n => (n.tags || []).includes('question') && !n.answered)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')),
    [allNotes]
  );

  const carouselNotes = useMemo(() =>
    [...(allNotes || []).filter(n => !(n.tags || []).includes('question')), ...(correctionSessions || [])]
      .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''))
      .slice(0, 8),
    [allNotes, correctionSessions]
  );

  return {
    todayStr, activeSources, adriftSources, queueByTier,
    recentGrammarReviews, recentLangAppt, openQuestions, carouselNotes,
    fmtDaysAgo, stripHtml,
  };
}