// src/utils/headlineEngine.js
// Deterministic, rule-based "lead story" selection for the
// Content Library Gazette page. No model calls, no AI-generated text —
// every headline is a template filled from data already computed elsewhere
// (CLOverviewTab). 
//
// Same inputs always produce the same output —
// so they're testable with mock data independent of any page layout.

import { toDateStr } from './dateUtils.js';

function daysBetween(fromStr, toStr) {
  const a = new Date(fromStr + 'T00:00:00');
  const b = new Date(toStr + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

// ── Content Library ──────────────────────────────────────────

const ADRIFT_HEADLINE_THRESHOLD   = 3;
const RECENT_MASTERY_WINDOW_DAYS  = 2;
const OPEN_QUESTION_STALE_DAYS    = 14;
const TIER_LABEL = { grammar: 'Study', mining: 'Mining', casual: 'Casual' };

/**
 * Builds a short, fact-grounded description of an adrift source for the
 * lead paragraph — Origin, Type/Subtype, Study Intent tier, days since last
 * activity, whether any notes/corrections exist for it, and whether it's
 * currently the reason a later series sibling shows up "waiting" in the
 * queue (cross-referenced via queueByTier's existing _waiting flag, not a
 * new field — an adrift source is never excluded from queue via
 * seriesBlocked, since that only applies to untouched siblings, but it can
 * still be the cause a fresh sibling is flagged _waiting).
 */
function describeAdriftSource(src, { allNotes, correctionSessions, queueByTier, todayStr }) {
  const bits = [];
  if (src.origin) bits.push(src.origin);
  bits.push(src.subtype ? `${src.type}/${src.subtype}` : (src.type || 'untyped'));
  const descriptor = bits.join(', ');
  const tierLabel = TIER_LABEL[src.studyIntent] || 'unsorted';

  const daysAgo = src.lastActivityAt
    ? daysBetween(toDateStr(new Date(src.lastActivityAt)), todayStr)
    : null;

  const hasWriting = (allNotes || []).some(n => n.linkedSourceId === src.id)
    || (correctionSessions || []).some(c => c.sourceId === src.id);

  const isBlocking = src.series && src.seriesOrder != null && Object.values(queueByTier || {})
    .some(tier => (tier || []).some(item =>
      item.series === src.series &&
      item.seriesOrder != null &&
      parseFloat(item.seriesOrder) > parseFloat(src.seriesOrder) &&
      item._waiting
    ));

  const sentences = [];
  sentences.push(`"${src.title}" has gone quiet — a ${descriptor} sitting in the ${tierLabel} tier.`);
  if (daysAgo != null) {
    sentences.push(daysAgo === 0
      ? 'There has been no further progress today.'
      : `It has been ${daysAgo} day${daysAgo === 1 ? '' : 's'} since anything moved on it.`);
  }
  sentences.push(hasWriting
    ? 'Evidence suggests a note or correction already exists for it, so there is at least some groundwork laid for whenever it picks back up.'
    : 'No notes or corrections have been unearthed thus far — whatever lies within this source is as yet unrecorded.');
  if (isBlocking) {
    sentences.push('Its sequel is currently sitting in the queue, waiting for this one to move first.');
  }
  return sentences.join(' ');
}

/**
 * deps: { adriftSources, queueByTier, grammarEntries, openQuestions, allNotes, correctionSessions, today }
 * — the same already-computed values CLOverviewTab already has in scope.
 *
 * Returns { kicker, headline, standfirst, leadParagraph }.
 */
export function getLibraryLeadStory({ adriftSources, queueByTier, grammarEntries, openQuestions, allNotes, correctionSessions, today }) {
  const todayStr = today || toDateStr(new Date());

  // 1. Sources gone adrift
  if ((adriftSources || []).length >= ADRIFT_HEADLINE_THRESHOLD) {
    const sorted = [...adriftSources].sort((a, b) => (a.lastActivityAt || '').localeCompare(b.lastActivityAt || ''));
    const [stalest, ...rest] = sorted;
    let leadParagraph = describeAdriftSource(stalest, { allNotes, correctionSessions, queueByTier, todayStr });
    // Only the titles actually named in the paragraph belong in `subjects` —
    // when rest.length > 2, the trailing "and N more" doesn't name them, so
    // they shouldn't be ad-matchable against today's headline either.
    const namedSubjects = [stalest];
    if (rest.length === 1) {
      leadParagraph += ` It is not alone — "${rest[0].title}" has drifted as well.`;
      namedSubjects.push(rest[0]);
    } else if (rest.length > 1) {
      const named = rest.slice(0, 2);
      const names = named.map(s => `"${s.title}"`).join(' and ');
      leadParagraph += ` It is not alone — ${names}${rest.length > 2 ? `, and ${rest.length - 2} more,` : ''} have likewise stalled.`;
      namedSubjects.push(...named);
    }
    return {
      kicker: 'Notices',
      headline: `${adriftSources.length} Sources Gone Adrift`,
      standfirst: 'No activity past the adrift threshold on several sources at once.',
      leadParagraph,
      subjects: namedSubjects.map(s => ({ id: s.id, title: s.title })),
    };
  }

  // 2. Exact-match queue candidate, checked grammar → mining → casual
  for (const tk of ['grammar', 'mining', 'casual']) {
    const exact = (queueByTier?.[tk] || []).find(s => s._exact);
    if (exact) {
      const bits = [];
      if (exact.origin) bits.push(exact.origin);
      bits.push(exact.subtype ? `${exact.type}/${exact.subtype}` : (exact.type || 'untyped'));
      const levelRange = exact.levelMin
        ? (exact.levelMax && exact.levelMax !== exact.levelMin ? `${exact.levelMin}–${exact.levelMax}` : exact.levelMin)
        : null;
      const sentences = [`"${exact.title}" sits at the front of the ${TIER_LABEL[tk]} tier, matched to your current level range.`];
      sentences.push(`It's a ${bits.join(', ')}${levelRange ? `, rated ${levelRange}` : ''}${exact._total ? `, with ${exact._total} section${exact._total === 1 ? '' : 's'}` : ''}.`);
      if (exact.series) sentences.push(`It's part of the "${exact.series}" series.`);
      sentences.push('Will this title be the next entrant in the Active arena? Check back tomorrow for the latest update.');
      return {
        kicker: 'Queue Report',
        headline: `Next Up: ${exact.title}`,
        standfirst: `Matched to your current level range — ${TIER_LABEL[tk]} tier.`,
        leadParagraph: sentences.join(' '),
        subjects: [{ id: exact.id, title: exact.title }],
      };
    }
  }

  // 3. Grammar entry recently promoted to Mastered (not any level bump —
  // only Mastered is headline-worthy, and only within a couple of days).
  const recentlyMastered = (grammarEntries || [])
    .filter(e => e.masteryLevel === 'mastered' && e.masteryLevelChangedAt)
    .filter(e => daysBetween(toDateStr(new Date(e.masteryLevelChangedAt)), todayStr) <= RECENT_MASTERY_WINDOW_DAYS)
    .sort((a, b) => b.masteryLevelChangedAt.localeCompare(a.masteryLevelChangedAt))[0];
  if (recentlyMastered) {
    const sentences = [`"${recentlyMastered.glossaryTerm}" moved to Mastered status this week.`];
    if (recentlyMastered.compareTo) {
      sentences.push(`It's often confused with ${recentlyMastered.compareTo}, but the distinction has clearly landed.`);
    }
    sentences.push('It now joins the grammar points that no longer need active review.');
    return {
      kicker: 'Dispatches', headline: `${recentlyMastered.glossaryTerm} Reaches Mastered Status`, standfirst: '',
      leadParagraph: sentences.join(' '),
    };
  }

  // 4. Oldest open question, past a staleness threshold
  const oldest = (openQuestions || [])[(openQuestions || []).length - 1];
  if (oldest?.createdAt) {
    const age = daysBetween(toDateStr(new Date(oldest.createdAt)), todayStr);
    if (age >= OPEN_QUESTION_STALE_DAYS) {
      const sentences = [`A question logged ${age} days ago is still waiting for an answer: "${oldest.title}".`];
      sentences.push(openQuestions.length > 1
        ? `It's one of ${openQuestions.length} open questions on file.`
        : "It's the only open question on file right now.");
      return {
        kicker: 'Letters To The Editor', headline: `Oldest Open Question: ${age} Days Unanswered`, standfirst: '',
        leadParagraph: sentences.join(' '),
      };
    }
  }

  // 5. Fallback — queue size across all three tiers
  const tierCounts = {
    grammar: queueByTier?.grammar?.length || 0,
    mining: queueByTier?.mining?.length || 0,
    casual: queueByTier?.casual?.length || 0,
  };
  const total = tierCounts.grammar + tierCounts.mining + tierCounts.casual;
  return {
    kicker: 'Queue Report',
    headline: `Queue Holds ${total} Source${total === 1 ? '' : 's'} Across Three Tiers`,
    standfirst: '',
    leadParagraph: `Nothing urgent today — ${total} source${total === 1 ? '' : 's'} sit across the three queues. Breaking it down, that's ${tierCounts.grammar} in Study, ${tierCounts.mining} in Mining, and ${tierCounts.casual} in Casual. Any one of them could be the next Active Source.`,
  };
}

// ── Quizzes ───────────────────────────────────────────────────
// Unlike Health and Library, there's no upstream engine pre-computing
// trends or flags here — quiz_results is the only input, so this function
// does its own aggregation directly off the raw array (still pure, still
// deterministic). `meta` (added per quiz type as of the Stage 3 data work)
// is optional on every result — older entries simply have `meta: null` —
// so every read below is defensive and every branch degrades gracefully
// when the richer fields aren't there.

const TYPE_LABEL              = { voca: 'Vocabulary', cloze: 'Cloze', grammar: 'Grammar' };
const QUIZ_GONE_QUIET_DAYS    = 10;
const QUIZ_TREND_WINDOW       = 3;   // sessions compared on each side
const QUIZ_TREND_THRESHOLD    = 12;  // percentage points
const QUIZ_RECURRING_WINDOW   = 5;   // most recent results scanned for repeat misses
const QUIZ_MILESTONE_COUNTS   = [10, 25, 50, 100, 150, 200, 250, 300, 400, 500];

/**
 * deps: { results, today } — `results` is the same quiz_results array
 * QuizzesPage already loads (each entry: { type, score, correct, total,
 * date, meta }).
 *
 * Returns { kicker, headline, standfirst, leadParagraph }. `leadParagraph`
 * may be a string or an array of up to two paragraph strings — DropCapLead
 * already accepts either.
 */
export function getQuizLeadStory({ results, today }) {
  const todayStr = today || toDateStr(new Date());
  const all = results || [];

  // 0. Nothing on record yet
  if (all.length === 0) {
    return {
      kicker: 'Score Report',
      headline: 'No Quizzes Yet',
      standfirst: '',
      leadParagraph: 'No quizzes have been taken yet. Once a few are on the books, this space will start tracking trends, milestones, and trouble spots.',
    };
  }

  const byDateDesc = [...all].sort((a, b) => b.date.localeCompare(a.date));
  const typesSeen  = ['voca', 'cloze', 'grammar'].filter(t => all.some(r => r.type === t));

  // 1. A type has gone quiet while the others stayed in rotation
  if (typesSeen.length >= 2) {
    const lastByType = {};
    for (const t of typesSeen) lastByType[t] = byDateDesc.find(r => r.type === t);
    const withGaps = typesSeen.map(t => ({
      type: t,
      gap: daysBetween(lastByType[t].date.slice(0, 10), todayStr),
    })).sort((a, b) => b.gap - a.gap);
    const [stalest] = withGaps;
    const overallGap = daysBetween(byDateDesc[0].date.slice(0, 10), todayStr);
    if (stalest.gap >= QUIZ_GONE_QUIET_DAYS && stalest.gap > overallGap) {
      const sentences = [`${TYPE_LABEL[stalest.type]} quizzes have gone quiet — it's been ${stalest.gap} days since the last one.`];
      const active = withGaps.find(w => w.type !== stalest.type && w.gap <= 3);
      if (active) {
        const activeMeta = lastByType[active.type].meta;
        const focus = activeMeta?.deckNames?.[0] || activeMeta?.sourceNames?.[0] || activeMeta?.concepts?.[0];
        sentences.push(focus
          ? `${TYPE_LABEL[active.type]} has stayed in rotation, most recently touching on ${focus}.`
          : `${TYPE_LABEL[active.type]} has stayed in rotation in the meantime.`);
      }
      return {
        kicker: 'Notices',
        headline: `${TYPE_LABEL[stalest.type]} Quizzes Gone Quiet`,
        standfirst: `${stalest.gap} days since the last one.`,
        leadParagraph: sentences.join(' '),
      };
    }
  }

  // 2. A term or concept keeps showing up as a miss across recent quizzes
  const recentForMisses = byDateDesc.slice(0, QUIZ_RECURRING_WINDOW);
  const missCounts = {};
  for (const r of recentForMisses) {
    const items = [...(r.meta?.missedTerms || []), ...(r.meta?.missedConcepts || [])];
    for (const item of new Set(items)) missCounts[item] = (missCounts[item] || 0) + 1;
  }
  const repeatMisses = Object.entries(missCounts).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]);
  if (repeatMisses.length > 0) {
    const [term, count] = repeatMisses[0];
    const sentences = [`"${term}" has come up as a miss in ${count} of the last ${recentForMisses.length} quizzes.`];
    if (repeatMisses.length > 1) {
      sentences.push(`It's not alone — "${repeatMisses[1][0]}" has repeated as well.`);
    } else {
      sentences.push("It's the only repeat offender in this stretch — worth a closer look next session.");
    }
    return {
      kicker: 'Dispatches',
      headline: `Recurring Trouble Spot: ${term}`,
      standfirst: `Missed in ${count} of the last ${recentForMisses.length} quizzes.`,
      leadParagraph: sentences.join(' '),
    };
  }

  // 3. A type's score has moved meaningfully over its last few sessions
  for (const t of typesSeen) {
    const typeResults = all.filter(r => r.type === t).sort((a, b) => a.date.localeCompare(b.date));
    if (typeResults.length < QUIZ_TREND_WINDOW * 2) continue;
    const recentN = typeResults.slice(-QUIZ_TREND_WINDOW);
    const priorN  = typeResults.slice(-QUIZ_TREND_WINDOW * 2, -QUIZ_TREND_WINDOW);
    const avg = arr => Math.round(arr.reduce((s, r) => s + r.score, 0) / arr.length);
    const recentAvg = avg(recentN), priorAvg = avg(priorN);
    const delta = recentAvg - priorAvg;
    if (Math.abs(delta) >= QUIZ_TREND_THRESHOLD) {
      const sentences = [`${TYPE_LABEL[t]} scores have ${delta > 0 ? 'climbed' : 'dropped'} ${Math.abs(delta)} points over the last ${QUIZ_TREND_WINDOW} sessions, now averaging ${recentAvg}%.`];
      sentences.push(`That's ${delta > 0 ? 'up' : 'down'} from a ${priorAvg}% average the ${QUIZ_TREND_WINDOW} sessions before that.`);
      const latestMeta = recentN[recentN.length - 1].meta;
      const focus = latestMeta?.deckNames?.[0] || latestMeta?.sourceNames?.[0] || latestMeta?.concepts?.[0];
      if (focus) sentences.push(`The most recent session touched on ${focus}.`);
      return {
        kicker: 'Score Report',
        headline: `${TYPE_LABEL[t]} Scores ${delta > 0 ? 'On The Rise' : 'Slipping'}`,
        standfirst: `${delta > 0 ? '+' : ''}${delta} points over the last ${QUIZ_TREND_WINDOW} sessions.`,
        leadParagraph: sentences.join(' '),
      };
    }
  }

  // 4. A round-number milestone, fired exactly on the session that hits it
  if (QUIZ_MILESTONE_COUNTS.includes(all.length)) {
    const overallAvg = Math.round(all.reduce((s, r) => s + r.score, 0) / all.length);
    const sentences = [`This marks quiz number ${all.length} since tracking began, with a running average of ${overallAvg}% across all of them.`];
    const byType = typesSeen.map(t => `${all.filter(r => r.type === t).length} ${TYPE_LABEL[t]}`);
    if (byType.length > 1) sentences.push(`That breaks down to ${byType.join(', ')}.`);
    return {
      kicker: 'Record Book',
      headline: `Quiz ${all.length}`,
      standfirst: `${overallAvg}% average across every quiz on record.`,
      leadParagraph: sentences.join(' '),
    };
  }

  // 5. This week vs. last week, overall
  const weekAvg = (startDaysAgo, endDaysAgo) => {
    const start = new Date(todayStr + 'T00:00:00'); start.setDate(start.getDate() - startDaysAgo);
    const end   = new Date(todayStr + 'T00:00:00'); end.setDate(end.getDate() - endDaysAgo);
    const inWindow = all.filter(r => { const d = new Date(r.date); return d >= start && d < end; });
    return inWindow.length ? { avg: Math.round(inWindow.reduce((s, r) => s + r.score, 0) / inWindow.length), count: inWindow.length } : null;
  };
  const thisWeek = weekAvg(7, 0);
  const lastWeek = weekAvg(14, 7);
  if (thisWeek && lastWeek && Math.abs(thisWeek.avg - lastWeek.avg) >= QUIZ_TREND_THRESHOLD) {
    const delta = thisWeek.avg - lastWeek.avg;
    return {
      kicker: 'Score Report',
      headline: delta > 0 ? 'A Strong Week For Scores' : 'A Rougher Week For Scores',
      standfirst: `${delta > 0 ? '+' : ''}${delta} points week over week.`,
      leadParagraph: `This week's ${thisWeek.count} quiz${thisWeek.count === 1 ? '' : 'zes'} averaged ${thisWeek.avg}%, compared to ${lastWeek.avg}% the week before.`,
    };
  }

  // 6. Fallback — calm overall status
  const last7 = all.filter(r => daysBetween(r.date.slice(0, 10), todayStr) <= 7);
  const overallAvg = Math.round(all.reduce((s, r) => s + r.score, 0) / all.length);
  const sentences = [`Nothing especially notable today — ${all.length} quiz${all.length === 1 ? '' : 'zes'} on record, averaging ${overallAvg}% overall.`];
  sentences.push(last7.length
    ? `${last7.length} of those came in the last week.`
    : 'None of those came in the last week, though.');
  return {
    kicker: 'Score Report',
    headline: `${overallAvg}% Average Across ${all.length} Quiz${all.length === 1 ? '' : 'zes'}`,
    standfirst: '',
    leadParagraph: sentences.join(' '),
  };
}