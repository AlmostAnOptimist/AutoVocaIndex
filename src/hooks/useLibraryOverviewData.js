// src/hooks/useLibraryOverviewData.js
// Active/adrift/queue/recent-activity derivation for the Content Library
// overview surface — extracted from CLOverviewTab (src/pages/ContentLibraryPage.jsx)
// so ContentLibraryGazette can reuse the exact same logic without copy-pasting
// ~150 lines of it. CLOverviewTab itself is left as-is; it's unused dead code
// now, not worth refactoring on its way out.

import { useMemo, useCallback } from 'react';
import { getLogicalToday, toDateStr } from '../utils/dateUtils.js';
import { isPassiveMediaExcluded, getSourceStatus } from '../utils/contentUtils.js';

const CEFR = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const cefrIdx = (level) => CEFR.indexOf(level);

export function useLibraryOverviewData({
  sources, sectionsBySource, allNotes, correctionSessions,
  grammarEntries, cards, appointments, adriftDays, dsh,
}) {
  const logicalToday = useMemo(() => getLogicalToday(dsh), [dsh]);
  const todayStr      = useMemo(() => toDateStr(logicalToday), [logicalToday]);
  const todayMs       = useMemo(() => logicalToday.getTime(), [logicalToday]);
  const adriftMs      = (adriftDays ?? 14) * 86400000;

  const fmtDaysAgo = useCallback((iso) => {
    if (!iso) return '';
    const days = Math.floor((todayMs - new Date(iso).getTime()) / 86400000);
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    return `${days} days ago`;
  }, [todayMs]);

  const stripHtml = useCallback((html) =>
    (html || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim(),
  []);

  const isComplete = useCallback((src) => {
    if (src.archived || src.pendingArchive) return true;
    const st = getSourceStatus(src);
    if (st === 'Done') return true;
    const secs = sectionsBySource[src.id] || [];
    if (!secs.length) return st === 'Skip';
    return secs.every(s => s.status === 'Done' || s.status === 'Skip');
  }, [sectionsBySource]);

  const isActive = useCallback((src) => {
    if (src.paused) return false;
    if (isComplete(src)) return false;
    const st = getSourceStatus(src);
    if (st === 'In Progress' || st === 'Scheduled') return true;
    return (sectionsBySource[src.id] || []).some(s =>
      s.status === 'In Progress' || s.status === 'Scheduled' || s.status === 'Done'
    );
  }, [sectionsBySource, isComplete]);

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
    return (todayMs - new Date(src.lastActivityAt).getTime()) > adriftMs;
  }, [isActive, isComplete, todayMs, adriftMs, sectionsBySource]);

  const activeSources = useMemo(() => sources.filter(s => isActive(s) && !isPassiveMediaExcluded(s)), [sources, isActive]);
  const adriftSources  = useMemo(() => sources.filter(s => isAdrift(s) && !isPassiveMediaExcluded(s)), [sources, isAdrift]);

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
    const candidates = sources.filter(s => !notQueue(s) && !isPassiveMediaExcluded(s)).map(src => {
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