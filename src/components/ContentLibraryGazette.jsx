// src/components/ContentLibraryGazette.jsx
// Gazette-style replacement for the Content Library Overview tab. Same prop
// shape as CLOverviewTab (drop-in swap from ContentLibraryPage.jsx).
// CLOverviewTab itself is left in place, untouched, in ContentLibraryPage.jsx.
//
// Note: "cards due today" / "review streak" / a true study-activity heatmap
// all live in AVI/Flashcards' own data (reviewLog, wordsByDay), which this
// page never receives — that's a separate data domain, not just a missing
// prop. The Fig. panel here uses Library's own activity signal instead
// (source lastActivityAt + note/correction createdAt). Pulling AVI's study
// data in too is a real follow-up decision, not done here.

import { useState, useMemo, useRef } from 'react';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { SH } from '../theme/buildStyles.js';
import { toDateStr, computeStreak } from '../utils/dateUtils.js';
import { buildWordsByDay } from '../utils/aviUtils.js';
import { pickAd } from '../utils/plateEngine.js';
import { useLibraryOverviewData } from '../hooks/useLibraryOverviewData.js';
import { getLibraryLeadStory } from '../utils/headlineEngine.js';
import { typeColor, getSourceStatus } from '../utils/contentUtils.js';
import { ActivityHeatmap } from './ActivityHeatmap.jsx';
import {
  GazetteMasthead, GoldRule, BylineRule, GazetteKicker, GazetteHeadline,
  GazetteStandfirst, DropCapLead, GazetteBox, BoxRow, NoticeEntry,
  GazetteFig, ClassifiedAdBox, GazetteColumnFeature, GazetteAdSpace,
} from './GazetteComponents.jsx';

// Lazy glob — only the one image actually selected for today ever gets
// fetched (see GazetteAdSpace), not the whole pool. filenames/loaders are
// static (computed once at module load, since Vite resolves the glob at
// build time), so there's no reason to recompute them per render.
const libraryAdPool = import.meta.glob('../assets/gazette-plates/library/*.{png,jpg,jpeg,PNG,JPG,JPEG}');
const libraryAdLoaders = Object.fromEntries(
  Object.entries(libraryAdPool).map(([path, loader]) => [path.split('/').pop(), loader])
);
const libraryAdFilenames = Object.keys(libraryAdLoaders);

// One Active/Adrift list row — title, status meta, thin progress bar.
// Gazette-styled rather than reusing CLOverviewTab's card treatment, to
// match the rest of this page's restrained hairline aesthetic.
function LibrarySourceItem({ src, sectionsBySource, fmtDaysAgo, onNavigateToSource, faded, C }) {
  const secs   = sectionsBySource[src.id] || [];
  const done   = secs.filter(s => s.status === 'Done').length;
  const active = secs.filter(s => s.status !== 'Skip').length;
  const noSecs = !secs.length;
  const col    = typeColor(src.type);
  const level  = src.levelMin
    ? (src.levelMax && src.levelMax !== src.levelMin ? `${src.levelMin}–${src.levelMax}` : src.levelMin)
    : null;
  const pct = active > 0 ? Math.round((done / active) * 100) : 0;

  return (
    <div onClick={() => onNavigateToSource('library', src.id)} style={{ padding: '9px 0', borderBottom: `1px solid ${C.border}`, cursor: 'pointer', opacity: faded ? 0.7 : 1 }}>
      <div style={{ fontSize: '13px', fontWeight: 600, color: C.text, marginBottom: '3px' }}>{level ? `${level} · ` : ''}{src.title}</div>
      <div style={{ fontSize: '11px', color: C.textM }}>
        {noSecs ? getSourceStatus(src) : `${done} of ${active} done`}{src.lastActivityAt ? ` · ${fmtDaysAgo(src.lastActivityAt)}` : ''}
      </div>
      {!noSecs && (
        <div style={{ height: '4px', background: C.border, borderRadius: '3px', marginTop: '6px', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: col, borderRadius: '3px' }} />
        </div>
      )}
    </div>
  );
}

// Placeholder for the future Goals page — renders inside whichever of
// Active/Adrift currently has fewer sources, so the two-column band stays
// visually balanced rather than one side trailing off shorter than the other.
function GoalsPlaceholder({ C }) {
  return (
    <div style={{ border: `1px dashed ${C.borderB}`, padding: '10px 12px', marginTop: '10px', textAlign: 'center' }}>
      <div style={{ fontFamily: SH.fb, fontWeight: 700, fontSize: '11px', letterSpacing: '0.04em', textTransform: 'uppercase', fontStyle: 'italic', color: C.textM, marginBottom: '4px' }}>
        Goals — Coming Soon
      </div>
      <div style={{ fontFamily: SH.fp, fontStyle: 'italic', fontSize: '10.5px', color: C.textM }}>
        A future notice, reserved.
      </div>
    </div>
  );
}

export function ContentLibraryGazette(props) {
  const { C } = useAppTheme();
  const {
    sources, sections, sectionsBySource, allNotes, correctionSessions,
    grammarEntries, grammarMasteryCounts, appointments, cards, decks,
    adriftDays, dsh, onNavigateToSource, onNavigateToNote, onNavigateToCorrection,
    wordInputs, sentenceInputs, adAliases,
  } = props;

  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 700;
  const [carouselIdx, setCarouselIdx] = useState(0);
  const [lettersPage, setLettersPage] = useState(0);  const [activityEndYM, setActivityEndYM] = useState(null);
  const lettersBoxRef = useRef(null);  // fold-line snap target for the ad (Stage A-2)

  const {
    todayStr, activeSources, adriftSources, queueByTier,
    recentGrammarReviews, recentLangAppt, openQuestions, carouselNotes,
    fmtDaysAgo, stripHtml,
  } = useLibraryOverviewData({ sources, sectionsBySource, allNotes, correctionSessions, grammarEntries, cards, appointments, adriftDays, dsh });

  const lead = useMemo(
    () => getLibraryLeadStory({ adriftSources, queueByTier, grammarEntries, openQuestions, allNotes, correctionSessions, today: todayStr }),
    [adriftSources, queueByTier, grammarEntries, openQuestions, allNotes, correctionSessions, todayStr]
  );

  // Library's own activity signal — not AVI's. See file header note.
  const libraryActivityByDay = useMemo(() => {
    const map = {};
    const bump = (iso) => { if (!iso) return; const d = iso.slice(0, 10); map[d] = (map[d] || 0) + 1; };
    (sources || []).forEach(s => bump(s.lastActivityAt));
    (allNotes || []).forEach(n => bump(n.createdAt));
    (correctionSessions || []).forEach(s => bump(s.createdAt));
    return map;
  }, [sources, allNotes, correctionSessions]);

  const tierCompletedCounts = useMemo(() => {
    const counts = { grammar: 0, mining: 0, casual: 0 };
    (sources || []).forEach(s => {
      if (getSourceStatus(s) === 'Done' && counts[s.studyIntent] !== undefined) counts[s.studyIntent]++;
    });
    return counts;
  }, [sources]);

  // Archived is a distinct signal from "Done" (a source can be archived via a
  // different flow without literally being status='Done') — genuinely separate
  // filler material, not a repeat of tierCompletedCounts.
  const tierArchivedCounts = useMemo(() => {
    const counts = { grammar: 0, mining: 0, casual: 0 };
    (sources || []).forEach(s => {
      if (s.archived && counts[s.studyIntent] !== undefined) counts[s.studyIntent]++;
    });
    return counts;
  }, [sources]);

  const sourceTypeCounts = useMemo(() => {
    const counts = {};
    (sources || []).forEach(s => { if (s.type) counts[s.type] = (counts[s.type] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3);
  }, [sources]);

  // AVI's own activity signal (word/sentence mining), threaded in from
  // App.jsx — same data AVIOverviewPage's heatmap already uses, just not
  // previously passed this far. Resolves the gap noted in the spec doc.
  const aviStreak = useMemo(
    () => computeStreak(buildWordsByDay(wordInputs, sentenceInputs), dsh),
    [wordInputs, sentenceInputs, dsh]
  );

  const TIER_META = { grammar: { label: 'Study Queue', tag: 'grammar-tier sources, ready when you are' }, mining: { label: 'Mining Queue', tag: 'vocabulary & sentence harvest' }, casual: { label: 'Casual Queue', tag: 'passive exposure, low pressure' } };

  const mastheadDate = new Date(todayStr + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const carouselNote = carouselNotes[carouselIdx] || null;
  // A note never has `rows`; a correction session always does — structural
  // check, not a `type` field that may or may not be set.
  const carouselIsCorrection = Array.isArray(carouselNote?.rows);
  // Title always shows, regardless of body content — a slide is never blank
  // just because the body happens to be short or empty. Same title fallback
  // already used elsewhere for corrections (corrLabel).
  const carouselTitle = carouselNote
    ? (carouselNote.title || carouselNote.sourceLabel || (carouselIsCorrection ? 'Correction' : 'Note'))
    : '';
  const carouselBody = carouselNote
    ? carouselIsCorrection
      ? (carouselNote.rows || []).map(r => r.original).filter(Boolean)
      : stripHtml(carouselNote.bodyHtml).slice(0, 500)
    : '';
  const handleCarouselClick = () => {
    if (!carouselNote) return;
    if (carouselIsCorrection) onNavigateToCorrection?.(carouselNote.id);
    else onNavigateToNote?.(carouselNote.id);
  };

  // Today's ad — matches whatever the lead headline names (lead.subjects),
  // falling back to plain random when nothing matches or the headline
  // doesn't name a real source (rules 3–5). Clickable only when a real
  // match drove the pick.
  const adPick = useMemo(
    () => pickAd({ filenames: libraryAdFilenames, aliasMap: adAliases || {}, subjects: lead.subjects || [], dateSeed: todayStr, salt: 'library-ad' }),
    [adAliases, lead.subjects, todayStr]
  );

  return (
    <div className="fade-up" style={{ display: 'flex', flexDirection: 'column', gap: '24px', paddingBottom: isMobile ? '58px' : 0 }}>
      <GazetteMasthead
        cornerLeft={{ value: `${activeSources.length} Active`, label: `${adriftSources.length} Adrift` }}
        cornerRight={{ value: mastheadDate, label: todayStr.slice(0, 4) }}
        title="Hanok Gazette"
        subtitle="A Record of Sources, Study, and Stray Questions"
        isMobile={isMobile}
      />
      <GoldRule />
      <BylineRule left="autovocaindex / content" center={`Adrift threshold ${adriftDays ?? 14}d`} right={todayStr} />

      {/* Lead story + rail */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '320px 1fr', gap: '30px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <GazetteBox title="Dispatches">
            <div style={{ fontSize: '10px', letterSpacing: '0.08em', textTransform: 'uppercase', color: C.accent, marginBottom: '6px' }}>Recent Grammar</div>
            {recentGrammarReviews.length === 0 ? (
              <div style={{ fontSize: '12px', color: C.textM, fontStyle: 'italic', marginBottom: '10px' }}>No grammar cards reviewed yet.</div>
            ) : recentGrammarReviews.map(({ entry, reviewDate }) => (
              <BoxRow key={entry.id} label={entry.glossaryTerm} value={reviewDate} />
            ))}
            <div style={{ fontSize: '10px', letterSpacing: '0.08em', textTransform: 'uppercase', color: C.accent, margin: '12px 0 6px' }}>Recent Lesson</div>
            {!recentLangAppt ? (
              <div style={{ fontSize: '12px', color: C.textM, fontStyle: 'italic' }}>No lessons scheduled.</div>
            ) : (
              <NoticeEntry
                name={recentLangAppt.type ? `${recentLangAppt.type} — ${recentLangAppt.provider || ''}` : (recentLangAppt.provider || 'Tutor')}
                meta={`${recentLangAppt.date}${recentLangAppt.time ? ' · ' + recentLangAppt.time : ''}`}
                flag={(recentLangAppt.followUpQueue || []).length === 0 ? 'No Follow-Up Scheduled' : null}
                last
              />
            )}
          </GazetteBox>

          {/* The ad in the right column snaps its bottom edge to this box's
              bottom edge when the two land close (the "fold" — see
              GazetteAdSpace's snapToRef). The old 30px offset buffer that
              deliberately mismatched the edges is retired. */}
          <div ref={lettersBoxRef}>
          <GazetteBox title="Letters To The Editor">            {(() => {
              const LETTERS_SLOTS = 4;
              const totalPages  = Math.max(1, Math.ceil(openQuestions.length / LETTERS_SLOTS));
              const safePage    = Math.min(lettersPage, totalPages - 1);
              const isLastPage  = safePage === totalPages - 1;
              const hasMore     = totalPages > 1;
              const shown       = openQuestions.slice(safePage * LETTERS_SLOTS, safePage * LETTERS_SLOTS + LETTERS_SLOTS);
              const nextBatch   = hasMore && !isLastPage ? Math.min(LETTERS_SLOTS, openQuestions.length - (safePage + 1) * LETTERS_SLOTS) : 0;
              const advanceStyle = {
                fontSize: '10.5px', fontStyle: 'italic', color: C.textM, padding: '6px 0', textAlign: 'center',
                background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', width: '100%', marginTop: '6px',
              };
              return openQuestions.length === 0 ? (
                <div style={{ fontSize: '12px', color: C.textM, fontStyle: 'italic' }}>No open questions.</div>
              ) : (
                <>
                  {shown.map((n, i) => (
                    <NoticeEntry key={n.id} name={n.title} meta={n.createdAt ? new Date(n.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''} last={i === shown.length - 1} onClick={() => onNavigateToNote?.(n.id)} />
                  ))}
                  {!isLastPage && (
                    <button onClick={() => setLettersPage(p => p + 1)} style={advanceStyle}>+{nextBatch} more waiting →</button>
                  )}
                  {isLastPage && hasMore && (
                    <button onClick={() => setLettersPage(0)} style={advanceStyle}>‹ Back to start</button>
                  )}
                </>
              );
            })()}
          </GazetteBox>
          </div>
        </div>

        {/* Headline (its own internal 2-column flow once there's enough
            content) on top; the ad spans that same full column width below
            it — not split per sub-column — growing to fill whatever's left
            down toward Letters' height. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', height: isMobile ? 'auto' : '100%' }}>
          <div>
            <GazetteKicker>{lead.kicker}</GazetteKicker>
            <GazetteHeadline>{lead.headline}</GazetteHeadline>
            {lead.standfirst && <GazetteStandfirst>{lead.standfirst}</GazetteStandfirst>}
            <DropCapLead text={lead.leadParagraph} columns={isMobile ? 1 : 2} />
          </div>
          <GazetteAdSpace
            pool={libraryAdLoaders}
            filename={adPick?.filename}
            onClick={adPick?.subject ? () => onNavigateToSource('library', adPick.subject.id) : undefined}
            fill={!isMobile}
            snapToRef={isMobile ? null : lettersBoxRef}
          />
        </div>
      </div>

      {/* Active | Adrift */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '30px' }}>
        <div>
          <div style={{ fontFamily: SH.fb, fontWeight: 700, fontSize: '12px', letterSpacing: '0.1em', textTransform: 'uppercase', color: C.accent2, paddingBottom: '6px', borderBottom: `2px solid ${C.accent2}`, marginBottom: '4px' }}>Active</div>
          {activeSources.length === 0
            ? <div style={{ fontSize: '12px', color: C.textM, fontStyle: 'italic', padding: '9px 0' }}>Nothing active.</div>
            : activeSources.map(src => <LibrarySourceItem key={src.id} src={src} sectionsBySource={sectionsBySource} fmtDaysAgo={fmtDaysAgo} onNavigateToSource={onNavigateToSource} C={C} />)
          }
          {activeSources.length <= adriftSources.length && <GoalsPlaceholder C={C} />}
        </div>
        <GazetteBox title="Sources Gone Adrift" variant={adriftSources.length > 0 ? 'warning' : 'default'}>
          {adriftSources.length === 0
            ? <div style={{ fontSize: '12px', color: C.textM, fontStyle: 'italic' }}>Nothing adrift.</div>
            : adriftSources.map(src => <LibrarySourceItem key={src.id} src={src} sectionsBySource={sectionsBySource} fmtDaysAgo={fmtDaysAgo} onNavigateToSource={onNavigateToSource} faded C={C} />)
          }
          {activeSources.length > adriftSources.length && <GoalsPlaceholder C={C} />}
        </GazetteBox>
      </div>

      {/* Library activity + by the numbers */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '30px' }}>
        <GazetteFig caption="Library Activity — twelve-month view">
          <ActivityHeatmap data={libraryActivityByDay} today={todayStr} color={C.accent2} itemLabel="updates" monthsToShow={isMobile ? 3 : 12} windowEndYM={activityEndYM} onWindowChange={setActivityEndYM} />
        </GazetteFig>
        <GazetteBox title="By The Numbers">
          <BoxRow label="Grammar mastered" value={`${grammarMasteryCounts?.mastered ?? 0} / ${grammarMasteryCounts?.all ?? 0}`} />
          <BoxRow label="Grammar practicing" value={grammarMasteryCounts?.practicing ?? 0} />
          <BoxRow label="Active / adrift" value={`${activeSources.length} / ${adriftSources.length}`} />
          <BoxRow label="AVI streak" value={`${aviStreak} day${aviStreak === 1 ? '' : 's'}`} />
          {sourceTypeCounts.map(([type, count]) => (
            <BoxRow key={type} label={type} value={count} />
          ))}
        </GazetteBox>
      </div>

      {/* Today's Column — notes carousel, script-aware drop cap */}
      {carouselNotes.length > 0 && (
        <div onClick={handleCarouselClick} style={{ cursor: 'pointer' }}>
          <GazetteColumnFeature
            byline="Today's Column — Recent Notes"
            meta={`‹ ${carouselIdx + 1} of ${carouselNotes.length} ›`}
            title={carouselTitle}
            text={carouselBody}
            columns={isMobile ? 1 : 2}
            side={
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'center', justifyContent: 'center' }}>
                <button onClick={(e) => { e.stopPropagation(); setCarouselIdx(i => (i - 1 + carouselNotes.length) % carouselNotes.length); }} style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: '6px', padding: '4px 10px', cursor: 'pointer', color: C.textM }}>‹ Prev</button>
                <button onClick={(e) => { e.stopPropagation(); setCarouselIdx(i => (i + 1) % carouselNotes.length); }} style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: '6px', padding: '4px 10px', cursor: 'pointer', color: C.textM }}>Next ›</button>
              </div>
            }
          />
        </div>
      )}

      {/* Classified queue */}
      <div>
        <GazetteKicker>The Queue</GazetteKicker>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr 1fr', gap: '18px' }}>
          {['grammar', 'mining', 'casual'].map(tk => {
            const items = (queueByTier[tk] || []).map(src => {
              const meta = `${src.levelMin ? (src.levelMax && src.levelMax !== src.levelMin ? `${src.levelMin}–${src.levelMax}` : src.levelMin) + ' · ' : ''}${src._total || 0}§`;
              return {
                id: src.id,
                title: src.title,
                meta,
                // Same navigation as Active/Adrift items — previously the
                // only place in the Queue with no click-through at all,
                // found while wiring up the ad space's click-through.
                onClick: () => onNavigateToSource('library', src.id),
                // Paused sources route through the exact same queue logic as a
                // never-started one (no priority bump) — this badge is purely
                // visual, so the two read as distinct at a glance.
                node: src.paused ? (
                  <>
                    <span style={{ fontSize: '9px', fontFamily: SH.fp, color: C.warning, border: `1px solid ${C.warning}`, borderRadius: '8px', padding: '0 5px', marginRight: '5px' }}>Paused</span>
                    <b style={{ color: C.text }}>{src.title}</b> — {meta}
                  </>
                ) : undefined,
              };
            });
            return (
              <ClassifiedAdBox
                key={tk}
                title={TIER_META[tk].label}
                tagline={TIER_META[tk].tag}
                items={items}
                fillerFacts={[
                  `${tierCompletedCounts[tk]} ${TIER_META[tk].label.split(' ')[0].toLowerCase()}-tier source${tierCompletedCounts[tk] === 1 ? '' : 's'} completed to date.`,
                  `${tierArchivedCounts[tk]} more sit in the Archive.`,
                ]}              />
            );
          })}
        </div>
      </div>

    </div>
  );
}