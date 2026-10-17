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
    const para1 = describeAdriftSource(stalest, { allNotes, correctionSessions, queueByTier, todayStr });

    // Second paragraph: the wider drift picture — how the rest break down by
    // tier and how long the field as a whole has been quiet.
    const namedSubjects = [stalest];
    const p2 = [];
    if (rest.length === 1) {
      p2.push(`It is not alone — "${rest[0].title}" has drifted as well.`);
      namedSubjects.push(rest[0]);
    } else if (rest.length > 1) {
      const named = rest.slice(0, 2);
      const names = named.map(s => `"${s.title}"`).join(' and ');
      p2.push(`It is not alone — ${names}${rest.length > 2 ? `, and ${rest.length - 2} more,` : ''} have likewise stalled.`);
      namedSubjects.push(...named);
    }
    const tierSpread = ['grammar', 'mining', 'casual']
      .map(tk => ({ tk, n: adriftSources.filter(s => s.studyIntent === tk).length }))
      .filter(x => x.n > 0);
    if (tierSpread.length > 1) {
      p2.push(`The drift spans ${tierSpread.map(x => `${x.n} in ${TIER_LABEL[x.tk]}`).join(', ')}.`);
    }
    const withWriting = adriftSources.filter(s =>
      (allNotes || []).some(n => n.linkedSourceId === s.id) ||
      (correctionSessions || []).some(c => c.sourceId === s.id)).length;
    p2.push(withWriting > 0
      ? `${withWriting} of the ${adriftSources.length} already ${withWriting === 1 ? 'has' : 'have'} notes or corrections on file — a foothold for whichever picks back up first.`
      : `None of the ${adriftSources.length} has any notes or corrections on file yet.`);

    return {
      kicker: 'Notices',
      headline: `${adriftSources.length} Sources Gone Adrift`,
      standfirst: 'No activity past the adrift threshold on several sources at once.',
      leadParagraph: [para1, p2.join(' ')],
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
      const p1 = [`"${exact.title}" sits at the front of the ${TIER_LABEL[tk]} tier, matched to your current level range.`];
      p1.push(`It's a ${bits.join(', ')}${levelRange ? `, rated ${levelRange}` : ''}${exact._total ? `, with ${exact._total} section${exact._total === 1 ? '' : 's'}` : ''}.`);
      if (exact.series) p1.push(`It's part of the "${exact.series}" series.`);

      // Second paragraph: the depth of the field behind it, so the lead reads
      // as a standings report rather than a single-line callout.
      const tierRest = (queueByTier[tk] || []).filter(s => s.id !== exact.id);
      const p2 = [];
      if (tierRest.length > 0) {
        const next = tierRest[0];
        p2.push(`Behind it, ${tierRest.length} other ${tierRest.length === 1 ? 'title waits' : 'titles wait'} in the ${TIER_LABEL[tk]} tier${next?.title ? `, led by "${next.title}"` : ''}.`);
      } else {
        p2.push(`Nothing else waits in the ${TIER_LABEL[tk]} tier — clear this one and the tier empties.`);
      }
      const otherTiers = ['grammar', 'mining', 'casual']
        .filter(t => t !== tk)
        .map(t => ({ t, n: (queueByTier?.[t] || []).length }))
        .filter(x => x.n > 0);
      if (otherTiers.length) {
        p2.push(`Elsewhere, ${otherTiers.map(x => `${x.n} ${x.n === 1 ? 'sits' : 'sit'} in ${TIER_LABEL[x.t]}`).join(' and ')}.`);
      }
      p2.push('Will this title be the next entrant in the Active arena? Check back tomorrow for the latest update.');
      return {
        kicker: 'Queue Report',
        headline: `Next Up: ${exact.title}`,
        standfirst: `Matched to your current level range — ${TIER_LABEL[tk]} tier.`,
        leadParagraph: [p1.join(' '), p2.join(' ')],
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
    const p1 = [`"${recentlyMastered.glossaryTerm}" moved to Mastered status this week.`];
    if (recentlyMastered.compareTo) {
      p1.push(`It's often confused with ${recentlyMastered.compareTo}, but the distinction has clearly landed.`);
    }
    if (recentlyMastered.pattern && recentlyMastered.pattern !== recentlyMastered.glossaryTerm) {
      p1.push(`The point turns on the ${recentlyMastered.pattern} pattern.`);
    }
    p1.push('It now joins the grammar points that no longer need active review.');

    // Second paragraph: where that leaves the grammar corpus overall.
    const all = grammarEntries || [];
    const masteredCount   = all.filter(e => e.masteryLevel === 'mastered').length;
    const practicingCount = all.filter(e => e.masteryLevel === 'practicing').length;
    const p2 = [`That brings the mastered count to ${masteredCount} of ${all.length} grammar ${all.length === 1 ? 'point' : 'points'} on record.`];
    p2.push(practicingCount > 0
      ? `Another ${practicingCount} ${practicingCount === 1 ? 'sits' : 'sit'} in active practice, working toward the same status.`
      : 'Nothing else is in active practice at the moment.');
    return {
      kicker: 'Dispatches', headline: `${recentlyMastered.glossaryTerm} Reaches Mastered Status`, standfirst: '',
      leadParagraph: [p1.join(' '), p2.join(' ')],
    };
  }

  // 4. Oldest open question, past a staleness threshold
  const oldest = (openQuestions || [])[(openQuestions || []).length - 1];
  if (oldest?.createdAt) {
    const age = daysBetween(toDateStr(new Date(oldest.createdAt)), todayStr);
    if (age >= OPEN_QUESTION_STALE_DAYS) {
      const p1 = [`A question logged ${age} days ago is still waiting for an answer: "${oldest.title}".`];
      p1.push(openQuestions.length > 1
        ? `It's one of ${openQuestions.length} open questions on file.`
        : "It's the only open question on file right now.");

      // Second paragraph: the age spread of the backlog behind it.
      const p2 = [];
      if (openQuestions.length > 1) {
        const newest = openQuestions[0];
        const newestAge = newest?.createdAt ? daysBetween(toDateStr(new Date(newest.createdAt)), todayStr) : null;
        const staleN = openQuestions.filter(q => q.createdAt && daysBetween(toDateStr(new Date(q.createdAt)), todayStr) >= OPEN_QUESTION_STALE_DAYS).length;
        p2.push(`${staleN} of the ${openQuestions.length} ${staleN === 1 ? 'has' : 'have'} now passed the two-week mark.`);
        if (newestAge != null) {
          p2.push(newestAge === 0
            ? 'The most recent went up today.'
            : `The most recent went up ${newestAge} day${newestAge === 1 ? '' : 's'} ago.`);
        }
      } else {
        p2.push('Clear this one and the Letters column empties entirely.');
      }
      return {
        kicker: 'Letters To The Editor', headline: `Oldest Open Question: ${age} Days Unanswered`, standfirst: '',
        leadParagraph: [p1.join(' '), p2.join(' ')],
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
  const grammarStanding = (grammarEntries || []);
  const masteredCount = grammarStanding.filter(e => e.masteryLevel === 'mastered').length;
  const p2Fallback = [];
  if (grammarStanding.length > 0) {
    p2Fallback.push(`On the grammar desk, ${masteredCount} of ${grammarStanding.length} ${grammarStanding.length === 1 ? 'point is' : 'points are'} mastered.`);
  }
  const openN = (openQuestions || []).length;
  p2Fallback.push(openN > 0
    ? `${openN} open question${openN === 1 ? '' : 's'} ${openN === 1 ? 'sits' : 'sit'} in the Letters column, none yet stale enough to lead.`
    : 'The Letters column is empty — no open questions on file.');
  return {
    kicker: 'Queue Report',
    headline: `Queue Holds ${total} Source${total === 1 ? '' : 's'} Across Three Tiers`,
    standfirst: '',
    leadParagraph: [
      `Nothing urgent today — ${total} source${total === 1 ? '' : 's'} sit across the three queues. Breaking it down, that's ${tierCounts.grammar} in Study, ${tierCounts.mining} in Mining, and ${tierCounts.casual} in Casual. Any one of them could be the next Active Source.`,
      p2Fallback.join(' '),
    ],
  };
}
