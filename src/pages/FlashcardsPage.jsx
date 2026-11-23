// src/pages/FlashcardsPage.jsx
import { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  collection, getDocs, getDoc, doc, updateDoc, writeBatch, setDoc, increment,
  query, where, documentId,
} from 'firebase/firestore';
import { db, auth } from '../firebase.js';
import { withCardStamp } from '../utils/cardStamp.js';
import { setReviewInProgress } from '../utils/cardsMarker.js';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { useKeyShortcuts } from '../hooks/useKeyShortcuts.js';
import { SH } from '../theme/buildStyles.js';
import {
  fsrsGrade, isDueToday, isNewCard, isDeferred, predictedRecall,
  getDueDateStr, buildDueLoad, AGAIN, FSRS_DEFAULTS,
} from '../utils/fsrs.js';
import { playSound } from '../utils/soundEngine.js';
import { normalizeLemma } from '../utils/aviUtils.js';
import { planCardDedupe, mergeSameNameDecks, planSeriesShare, applySeriesShare } from '../utils/cardDedupe.js';
import { pickEntriesByNorm, def2CardUpdate } from '../utils/def2Cascade.js';
import { buildSeriesGroups, wordSeries, sentenceSeries, isSeriesToken, SENTENCE_DECK_SUFFIX } from '../utils/seriesDecks.js';
import { getLogicalDateStr } from '../utils/dateUtils.js';
import { queueWrite, isNotFound } from '../utils/queuedWrite.js';
import { resetPageScroll } from '../utils/scrollUtils.js';
import { DeferralNotices } from '../components/DeferralNotices.jsx';
import { ActivityHeatmap, shiftMonth } from '../components/ActivityHeatmap.jsx';
import { applyReviewToStats, getEffectiveCurrentStreak, EMPTY_REVIEW_STATS } from '../utils/reviewStatsEngine.js';
import { createStatsGuard } from '../utils/reviewStatsGuard.js';
import { GazetteBox, BoxRow, GazetteMasthead, GoldRule, BylineRule, RecordsStrip, fmtRecordDate, fmtMonthLabel, fmtWeekRange } from '../components/GazetteComponents.jsx';
import { Icons } from '../components/Icons.jsx';
import { playCardAudio, playAudioUrl, generateGrammarCardAudio } from '../utils/ttsUtils.js';
import { GrammarCardPicker } from '../components/GrammarCardPicker.jsx';
import { SessionIntro, Medallion, MiniRule, Pendant } from '../components/Ornaments.jsx';
import { GRAMMAR_MASTERY } from '../constants.js';
import { DEMO } from '../demo/demoConfig.js';

// Adjust in Settings once that field is wired up.
const NEW_CARDS_PER_SESSION = 10;
// Deferred cards offered per 연기된 카드 round (DF-D10); the round can be repeated.
const DEFERRED_PER_ROUND = 20;

// Grade-confirmation pulse: how long the chosen grade button animates before
// the card advances. Overlapped with the Firestore write, so it only adds
// latency when the write is faster than this. Keep in sync with the
// `.grade-pulse` CSS animation duration in buildStyles.js.
const GRADE_ANIM_MS = 220;

const isMobile = typeof window !== 'undefined' && (window.innerWidth <= 700 || window.matchMedia('(hover: none) and (pointer: coarse) and (orientation: portrait)').matches);

// ── Grade buttons (Again / Hard / Good / Easy) ────────────────
// Order matches the planned swipe mapping: Again=left, Easy=right.
const GRADES = [
  { rating: 1, label: 'Again', color: '#E6935F' },
  { rating: 2, label: 'Hard',  color: '#C99655' },
  { rating: 3, label: 'Good',  color: '#A8965C' },
  { rating: 4, label: 'Easy',  color: '#7D9180' },
];

// ── Helpers ───────────────────────────────────────────────────
function formatLastStudied(iso, dsh = 3) {
  if (!iso) return null;
  const d = new Date(iso);
  // If the local hour is before the day-flip, the session belongs to the previous logical day.
  if (d.getHours() < dsh) d.setDate(d.getDate() - 1);
  const day = d.getDate();
  const mon = d.toLocaleString('en-GB', { month: 'short' });
  const yr  = String(d.getFullYear()).slice(2);
  return `${day} ${mon} '${yr}`;
}

// ── Records strip formatters ────────────────────────────────────
// reviewStats stores plain 'YYYY-MM-DD' / 'YYYY-MM' strings (not ISO
// timestamps), so these are small standalone formatters rather than reuses
// of formatLastStudied — output style matches it ("3 Jun '26") for
// consistency across the page.
// fmtRecordDate / fmtMonthLabel / fmtWeekRange moved to GazetteComponents.jsx
// (Stage A-3) — shared with the AVI Overview records strip.

// Renders sentence text with inputForm highlighted
function renderSentenceHighlight(sentence, inputForm, C) {
  if (!sentence || !inputForm) return sentence || '';
  const idx = sentence.indexOf(inputForm);
  if (idx === -1) return sentence;
  return (
    <>
      {sentence.slice(0, idx)}
      <span style={{
        background: C.accentSoft,
        color: C.accent,
        borderRadius: '3px',
        padding: '0 3px',
        fontWeight: 700,
      }}>
        {inputForm}
      </span>
      {sentence.slice(idx + inputForm.length)}
    </>
  );
}

// ── Context sentences (vocab cards) ──────────────────────────
// CX: the sentences mined for a word, from every source, shown below its
// vocab card. Skipped rows are left out (a skipped sentence is usually a bad
// one), the same sentence in two sources shows once, and a sentence that has
// a sentence card lends that card's sentence clip (no new audio is generated).
// A sentence card keeps two clips: audioUrl is the word on its own,
// sentenceAudioUrl is the whole sentence; only the sentence clip is used here.
const CONTEXT_SHOWN = 2;

function buildContextIndex(sentenceInputs, cards) {
  const audio = new Map();
  for (const c of cards || []) {
    if (c.type !== 'sentence' || !c.sentenceAudioUrl || !c.sentence) continue;
    audio.set(`${normalizeLemma(c.lemma || '')}|${c.sentence.normalize('NFC')}`, c.sentenceAudioUrl);
  }
  const index = new Map();
  for (const r of sentenceInputs || []) {
    if (!r || r.skipUpload || !r.sentence || !r.targetWord) continue;
    const norm = normalizeLemma(r.targetWord);
    if (!norm) continue;
    const sentence = r.sentence.normalize('NFC');
    if (!index.has(norm)) index.set(norm, []);
    index.get(norm).push({
      sentence,
      inputForm: r.inputForm || '',
      source:    r.source || '',
      ts:        r.ts || '',
      audioUrl:  audio.get(`${norm}|${sentence}`) || null,
    });
  }
  return index;
}

// The card's own sources first, then newest; one entry per sentence.
function contextFor(card, index) {
  if (!card || card.type !== 'vocab' || !index) return [];
  const rows = index.get(normalizeLemma(card.lemma || card.front || '')) || [];
  const own = new Set(card.deckNames || []);
  const sorted = [...rows].sort((a, b) => {
    const ao = own.has(a.source), bo = own.has(b.source);
    if (ao !== bo) return ao ? -1 : 1;
    return (b.ts || '').localeCompare(a.ts || '');
  });
  const seen = new Set();
  return sorted.filter(r => (seen.has(r.sentence) ? false : (seen.add(r.sentence), true)));
}

// SD-D2: of two cards for one word, a series deck shows the more overdue
// one: a reviewed card before a new one, then the earlier due date.
function moreOverdue(a, b) {
  const an = isNewCard(a), bn = isNewCard(b);
  if (an !== bn) return !an;
  return (getDueDateStr(a) || '9999') < (getDueDateStr(b) || '9999');
}

function deckType(deck) {
  if (!deck || deck.id === 'deck_grammar') return 'grammar';
  if (deck.id === 'all' || deck.id === 'all_words' || deck.id === 'all_sentences') return 'virtual';
  if (deck.name?.endsWith('(sentence mining)')) return 'sentence';
  return 'word';
}

function deckAccent(type, C) {
  if (type === 'grammar')  return C.danger;
  if (type === 'sentence') return C.accent2;
  return C.accent;
}

// ── Review session ────────────────────────────────────────────
//
// Session phases: opening_boundary → due → boundary_1_2 → new → boundary_2_3 → extra → finished
// DF2: an optional 연기된 카드 round (cards the daily cap deferred) may run after
// due cards or from "Nothing due today", 20 at a time: … → deferred →
// boundary_deferred → (deferred again | new | extra). Cards seen in a deferred
// round are left out of the full deck round.
//
// Again-queue logic:
//   - Pressing Again re-queues the card at the back of the current phase queue.
//   - If a card's Again count reaches the cap (from settings), it is carried over:
//     its 'due' is already set to the past by fsrsGrade, so it surfaces first next session.
//   - Boundary screens only appear once the phase queue (including any Again cards) is empty.
//   - When the session is ended manually, any Again'd cards still in the queue are already
//     written to Firestore with due=past, so they surface at the next session start.

function ReviewSession({ manualCards = [], dueCards, newCards, extraCards, deferredCards = [], deferredOnly = false, nextDueDate,
  onGrade, onEnd, soundProfile, onNavigateToGrammar, fsrsSettings, settings, reversed = false, contextIndex = null, C, S }) {

  const AGAIN_CAP = DEMO ? 1 : (fsrsSettings?.againCap ?? FSRS_DEFAULTS.againCap);

  // DF3: the masthead's Deferred corner opens a session that is only the
  // 연기된 카드 round (deferredOnly), starting straight into its first 20.
  const startDeferred = deferredOnly && deferredCards.length > 0;
  const firstDeferred = startDeferred ? deferredCards.slice(0, DEFERRED_PER_ROUND) : [];
  const initialPhase = manualCards.length > 0 ? 'manual' : startDeferred ? 'deferred' : dueCards.length > 0 ? 'due' : 'opening_boundary';
  const [phase,            setPhase]            = useState(initialPhase);
  // O1: opening bookend. Shown when a session starts straight into cards
  // ('Nothing due today' has its own screen, so it skips this). O3: also
  // shown at the start of every round begun from a choice screen (new
  // cards, full deck, due after selected), and skipped for a single-card
  // View Card jump, which should open the card at once.
  const [introOpen,        setIntroOpen]        = useState(
    (initialPhase === 'manual' && manualCards.length > 1) || initialPhase === 'due' || initialPhase === 'deferred'
  );
  const [queue,           setQueue]            = useState(() => manualCards.length > 0 ? [...manualCards] : startDeferred ? [...firstDeferred] : dueCards.length > 0 ? [...dueCards] : []);
  const [againCounts,      setAgainCounts]      = useState({}); // cardId -> Again count this phase
  const [revealed,         setRevealed]         = useState(false);
  const [revealedSections, setRevealedSections] = useState({});
  // CX: which card turn has its Context opened / all sentences shown. Keyed
  // by card id + turn so every card (an Again'd card coming back included)
  // starts closed without a reset effect.
  const [ctxOpenKey,       setCtxOpenKey]       = useState(null);
  const [ctxAllKey,        setCtxAllKey]        = useState(null);
  const [gradedRating,     setGradedRating]     = useState(null); // rating whose button is pulsing

  // Session stats
  const [successCount, setSuccessCount] = useState(0); // cards resolved with non-Again grade
  const [againTotal,   setAgainTotal]   = useState(0); // total Again presses
  const [carriedOver,  setCarriedOver]  = useState(0); // cards that hit the cap
  // U7: cards resolved before the current phase began, so the counter counts
  // this phase only (a skipped phase resolved nothing).
  const [phaseBase,    setPhaseBase]    = useState(0);

  // DF2: the 연기된 카드 round. deferredStart is how many deferred cards have
  // been put into rounds so far; deferredRound is the current round's cards.
  const [deferredStart, setDeferredStart] = useState(() => firstDeferred.length);
  const [deferredRound, setDeferredRound] = useState(() => firstDeferred);
  const deferredLeft = Math.max(0, deferredCards.length - deferredStart);
  const nextDeferred = Math.min(DEFERRED_PER_ROUND, deferredLeft);
  // The full deck round leaves out cards already seen in a deferred round.
  const extraLeft = useMemo(() => {
    if (!deferredStart) return extraCards;
    const seen = new Set(deferredCards.slice(0, deferredStart).map(c => c.id));
    return extraCards.filter(c => !seen.has(c.id));
  }, [extraCards, deferredCards, deferredStart]);

  const card = queue[0];

  // ── TTS audio state ───────────────────────────────────────
  // playingKey is null (nothing playing), 'main' (the whole-card button), or
  // an example-sentence index — only one clip plays at a time regardless of source.
  const [playingKey,   setPlayingKey]   = useState(null);
  const cancelAudioRef = useRef(null);
  const gradingRef     = useRef(false); // true while a grade is resolving; reset on next flip
  // S6: bumped every time a grade resolves, so the swipe fling is cleared even
  // when the same card comes back (an Again on the last card in the queue).
  const [turn,         setTurn]         = useState(0);

  const stopAudio = useCallback(() => {
    cancelAudioRef.current?.();
    cancelAudioRef.current = null;
    setPlayingKey(null);
  }, []);

  // Cancel any playing audio whenever the active card changes.
  const cardId = card?.id;
  useEffect(() => {
    return () => { stopAudio(); };
  }, [cardId, stopAudio]);

  const handlePlayAudio = useCallback(() => {
    if (!card?.audioUrl) return;
    if (playingKey === 'main') { stopAudio(); return; }
    stopAudio();
    const speed = settings?.ttsSpeed ?? 0.9;
    const { promise, cancel } = playCardAudio(card, speed);
    cancelAudioRef.current = cancel;
    setPlayingKey('main');
    promise.then(stopAudio).catch(stopAudio);
  }, [card, playingKey, settings, stopAudio]);

  const handlePlayExample = useCallback((idx, url) => {
    if (!url) return;
    if (playingKey === idx) { stopAudio(); return; }
    stopAudio();
    const speed = settings?.ttsSpeed ?? 0.9;
    const { promise, cancel } = playAudioUrl(url, speed);
    cancelAudioRef.current = cancel;
    setPlayingKey(idx);
    promise.then(stopAudio).catch(stopAudio);
  }, [playingKey, settings, stopAudio]);

  const startPhase = useCallback((newPhase) => {
    setPhase(newPhase);
    setIntroOpen(true); // O3: each round opens with its bookend
    setPhaseBase(successCount + carriedOver);
    setAgainCounts({});
    setRevealed(false);
    setRevealedSections({});
    if (newPhase === 'due')   setQueue([...dueCards]);
    if (newPhase === 'new')   setQueue([...newCards]);
    if (newPhase === 'extra') setQueue([...extraLeft]);
    if (newPhase === 'deferred') {
      const round = deferredCards.slice(deferredStart, deferredStart + DEFERRED_PER_ROUND);
      setDeferredRound(round);
      setDeferredStart(deferredStart + round.length);
      setQueue([...round]);
    }
  }, [dueCards, newCards, extraLeft, deferredCards, deferredStart, successCount, carriedOver]);

  const transitionPhase = useCallback((currentPhase) => {
    setRevealed(false);
    setRevealedSections({});
    if (currentPhase === 'manual') {
      if (dueCards.length > 0 || extraLeft.length > 0) setPhase('boundary_manual');
      else setPhase('finished');
    } else if (currentPhase === 'due') {
      if (newCards.length > 0 || deferredLeft > 0 || extraLeft.length > 0) setPhase('boundary_1_2');
      else setPhase('finished');
    } else if (currentPhase === 'deferred') {
      if (newCards.length > 0 || deferredLeft > 0 || extraLeft.length > 0) setPhase('boundary_deferred');
      else setPhase('finished');
    } else if (currentPhase === 'new') {
      if (extraLeft.length > 0) setPhase('boundary_2_3');
      else setPhase('finished');
    } else {
      setPhase('finished');
    }
  }, [dueCards.length, newCards.length, extraLeft.length, deferredLeft]);

  const handleGrade = useCallback(async (rating) => {
    if (!card || gradingRef.current) return;
    gradingRef.current = true;
    setGradedRating(rating);         // pulse the chosen grade button
    playSound(soundProfile || 'chirp');

    // onGrade writes to Firestore and returns the updated card object.
    // Overlap the write with the pulse window so the animation is visible
    // before the card advances (total wait is the max of the two, not the sum).
    // S6: onGrade queues its write and returns at once (offline included); if
    // it throws, the card stays put and can be graded again.
    let updatedCard;
    try {
      [updatedCard] = await Promise.all([
        onGrade(card, rating),
        new Promise((resolve) => setTimeout(resolve, GRADE_ANIM_MS)),
      ]);
    } catch (e) {
      console.error('ReviewSession: grading failed', e);
      gradingRef.current = false;
      setGradedRating(null);
      setTurn(t => t + 1);
      return;
    }
    setTurn(t => t + 1);

    if (rating === AGAIN) {
      const newCount = (againCounts[card.id] || 0) + 1;
      setAgainTotal(prev => prev + 1);
      setAgainCounts(prev => ({ ...prev, [card.id]: newCount }));

      if (newCount <= AGAIN_CAP) {
        // Re-queue at the back with the updated card state (new stability, due=past, etc.)
        setQueue(prev => [...prev.slice(1), updatedCard || card]);
        setRevealed(false);
        setRevealedSections({});
      } else {
        // Cap exceeded — card already has due=past in Firestore; carry it over.
        setCarriedOver(prev => prev + 1);
        const nextQueue = queue.slice(1);
        if (nextQueue.length === 0) transitionPhase(phase);
        else {
          setQueue(nextQueue);
          setRevealed(false);
          setRevealedSections({});
        }
      }
    } else {
      // Successful resolution
      setSuccessCount(prev => prev + 1);
      const nextQueue = queue.slice(1);
      if (nextQueue.length === 0) transitionPhase(phase);
      else {
        setQueue(nextQueue);
        setRevealed(false);
        setRevealedSections({});
      }
    }
  }, [card, queue, againCounts, phase, onGrade, soundProfile, transitionPhase, AGAIN_CAP]);

  // ── Keyboard shortcuts (Phase C2) ─────────────────────────
  // Space/Enter flip front→back; 1–4 grade Again/Hard/Good/Easy but only while
  // the back is showing. Grade keys route through the identical handleGrade
  // path as the buttons, so sound/TTS behaviour is inherited, not reimplemented.
  // Enabled only during an active card (never on boundary/finished screens).
  const flip = useCallback(() => {
    if (revealed) return;        // already showing the answer; nothing to flip
    gradingRef.current = false;  // re-arm grading for the newly revealed card
    setGradedRating(null);       // clear the previous pulse before the new card
    setRevealed(true);
  }, [revealed]);

  const inReview = !introOpen && !!card && ['manual', 'due', 'deferred', 'new', 'extra'].includes(phase);

  useKeyShortcuts(
    {
      ' ':      flip,
      'Enter':  flip,
      'Escape': onEnd,
      '1':      () => { if (revealed) handleGrade(GRADES[0].rating); },
      '2':      () => { if (revealed) handleGrade(GRADES[1].rating); },
      '3':      () => { if (revealed) handleGrade(GRADES[2].rating); },
      '4':      () => { if (revealed) handleGrade(GRADES[3].rating); },
    },
    inReview,
  );

  // ── Boundary-screen shortcuts (Phase C2) ──────────────────
  // No active card here (between-phase and finished screens). Esc ends the
  // session; Enter fires the top/primary option — the same action as the first
  // button rendered on each screen. Gated on onBoundary, which is disjoint from
  // inReview, so this never collides with the active-card keymap above.
  const onBoundary = ['opening_boundary', 'boundary_manual', 'boundary_1_2', 'boundary_deferred', 'boundary_2_3', 'finished'].includes(phase);

  // DF-D11: new cards stay the first choice; deferred cards come next.
  const advanceBoundary = useCallback(() => {
    if (phase === 'opening_boundary' || phase === 'boundary_1_2' || phase === 'boundary_deferred') {
      if (newCards.length > 0) startPhase('new');
      else if (deferredLeft > 0) startPhase('deferred');
      else if (extraLeft.length > 0) startPhase('extra');
      else onEnd();
    } else if (phase === 'boundary_manual') {
      if (dueCards.length > 0) startPhase('due');
      else if (extraLeft.length > 0) startPhase('extra');
      else onEnd();
    } else if (phase === 'boundary_2_3') {
      if (extraLeft.length > 0) startPhase('extra');
      else onEnd();
    } else {
      onEnd(); // finished → Done
    }
  }, [phase, newCards.length, dueCards.length, extraLeft.length, deferredLeft, startPhase, onEnd]);

  useKeyShortcuts(
    {
      'Escape': onEnd,
      'Enter':  advanceBoundary,
    },
    onBoundary,
  );

  // ── Mobile swipe-to-grade (Phase C2) ──────────────────────
  // Right = Easy, Left = Again, only while the back is showing. Horizontal-
  // dominant drags past the threshold grade the card; taps and vertical
  // scrolls pass straight through, so tap-to-flip and every button keep
  // working. Listeners attach to the card node (non-passive touchmove so we
  // can hold the page still mid-drag on iOS) and read live state through refs,
  // so they don't re-bind per card. Grading routes through handleGrade, so
  // sound, the grade pulse and the double-grade guard are all inherited.
  const cardElRef      = useRef(null);
  const swipeRef       = useRef({ x: 0, y: 0, dragging: false, axis: null });
  const revealedRef    = useRef(revealed);
  const handleGradeRef = useRef(handleGrade);
  useEffect(() => {
    revealedRef.current = revealed;
    handleGradeRef.current = handleGrade;
  });

  useEffect(() => {
    if (!window.matchMedia('(pointer: coarse)').matches) return;
    const el = cardElRef.current;
    if (!el) return; // no active card on this phase; re-runs when one mounts

    const SWIPE_MIN = 60;   // px of horizontal travel to grade
    const DOMINANCE = 1.5;  // |dx| must be >= 1.5x |dy| to count as horizontal
    const s = swipeRef.current;

    const settle = (animate) => {
      el.style.transition = animate ? 'transform 0.2s ease' : '';
      el.style.transform = '';
    };

    const onStart = (e) => {
      if (e.touches.length !== 1) return;
      s.x = e.touches[0].clientX;
      s.y = e.touches[0].clientY;
      s.dragging = true;
      s.axis = null;
      el.style.transition = '';
    };

    const onMove = (e) => {
      if (!s.dragging) return;
      const dx = e.touches[0].clientX - s.x;
      const dy = e.touches[0].clientY - s.y;
      if (s.axis === null && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
        s.axis = Math.abs(dx) >= DOMINANCE * Math.abs(dy) ? 'h' : 'v';
      }
      if (s.axis === 'h' && revealedRef.current) {
        e.preventDefault();               // hold the page still while dragging the card
        el.style.transform = `translateX(${dx}px)`;
      }
    };

    const onEnd = (e) => {
      if (!s.dragging) return;
      s.dragging = false;
      const t = e.changedTouches && e.changedTouches[0];
      const dx = t ? t.clientX - s.x : 0;
      if (s.axis === 'h' && revealedRef.current && !gradingRef.current && Math.abs(dx) >= SWIPE_MIN) {
        // Fling the card off in the swipe direction. The transform/opacity are
        // cleared the moment the next card mounts (layout effect below), so the
        // new card appears centred instead of the old one snapping back first.
        const off = (dx > 0 ? 1 : -1) * (window.innerWidth || 600);
        el.style.transition = 'transform 0.22s ease, opacity 0.22s ease';
        el.style.transform = `translateX(${off}px)`;
        el.style.opacity = '0';
        const rating = dx > 0 ? GRADES[3].rating : GRADES[0].rating; // right=Easy, left=Again
        handleGradeRef.current(rating);
      } else {
        settle(true);                     // below threshold — animate back to centre
      }
    };

    const onCancel = () => { s.dragging = false; settle(true); };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onCancel, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onCancel);
    };
  }, [phase, introOpen]); // O1: the first card mounts when the intro closes

  // Each screen of the session (intro, cards, round end, finished) starts at
  // the top: they replace one another in the page's shared scroller, so the
  // 새 카드 intro otherwise opened as far down as the round-end screen had
  // been scrolled to reach its button.
  useLayoutEffect(() => resetPageScroll(), [phase, introOpen]);

  // Clear any fling transform once the next card mounts, so it appears centred
  // (paired with the swipe fling in onEnd above). No-op for non-swipe advances,
  // where the transform is already empty. Runs before paint to avoid a flash.
  useLayoutEffect(() => {
    const el = cardElRef.current;
    if (!el) return;
    el.style.transition = '';
    el.style.transform = '';
    el.style.opacity = '';
  }, [cardId, turn]);

  // ── Opening bookend (O1) ─────────────────────────────────
  if (introOpen) {
    const count = (n, w) => `${n} ${w}${n !== 1 ? 's' : ''}`;
    // O3: the round decides the heading.
    const intro =
      phase === 'new'   ? { korean: '새 카드',   title: 'New Cards', detail: count(newCards.length, 'new card') }
      : phase === 'deferred' ? { korean: '연기된 카드', title: 'Deferred Cards', detail: `${deferredRound.length} deferred` }
      : phase === 'extra' ? { korean: '전체 카드', title: 'Full Deck', detail: count(extraLeft.length, 'card') }
      : phase === 'manual' ? { korean: '복습', title: 'Review Session', detail: `${manualCards.length} selected` }
      : { korean: '복습', title: 'Review Session', detail: `${dueCards.length} due${newCards.length > 0 ? ` · ${newCards.length} new` : ''}` };
    return (
      <SessionIntro
        kind="medallion"
        korean={intro.korean}
        title={intro.title}
        detail={intro.detail}
        sub={reversed ? 'Reversed' : null}
        onBegin={() => setIntroOpen(false)}
        onExit={onEnd}
      />
    );
  }

  // ── Finished (O1: closing bookend) ───────────────────────
  if (phase === 'finished') {
    const total = successCount + carriedOver;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }} className="fade-up">
        <Medallion>
          <div style={{ fontFamily: SH.fk, fontSize: '34px', fontWeight: 700, color: C.accent, lineHeight: 1 }}>완료</div>
          <div style={{ fontFamily: SH.fd, fontSize: '18px', color: C.text }}>Session complete</div>
          <MiniRule />
          <div style={{ display: 'flex', gap: '14px', marginTop: '2px' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontFamily: SH.fm, fontSize: '22px', color: C.accent }}>{successCount}</div>
              <div style={{ fontSize: '11px', color: C.textM, marginTop: '4px' }}>reviewed</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontFamily: SH.fm, fontSize: '22px', color: C.danger }}>{againTotal}</div>
              <div style={{ fontSize: '11px', color: C.textM, marginTop: '4px' }}>again</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontFamily: SH.fm, fontSize: '22px', color: C.textM }}>{carriedOver}</div>
              <div style={{ fontSize: '11px', color: C.textM, marginTop: '4px', whiteSpace: 'nowrap' }}>carried over</div>
            </div>
          </div>
        </Medallion>
        <Pendant variant="close" style={{ marginTop: '-1px' }} />
        <button style={{ ...S.btnPrimary, marginTop: '28px' }} onClick={onEnd}>Done</button>
      </div>
    );
  }

  // ── The 연기된 카드 button (DF-D11) ─────────────────────────
  // Second after Study new cards (which stays the Enter choice); primary when
  // there are no new cards to study. `more` after a deferred round. Aligned
  // like the screen's other buttons: left on "Nothing due today", centred on
  // the round-end screens.
  const deferredButton = (more, centred = true) => {
    if (!nextDeferred) return null;
    const k = nextDeferred;
    const label = more ? `Review ${k} more deferred` : `Review ${k} deferred card${k !== 1 ? 's' : ''}`;
    const base = newCards.length > 0 ? S.btnGhost : S.btnPrimary;
    return (
      <button style={centred ? { ...base, justifyContent: 'center' } : base} onClick={() => startPhase('deferred')}>
        {label}
      </button>
    );
  };

  // ── Boundary: nothing due today (opening) ────────────────
  if (phase === 'opening_boundary') {
    let nextLabel = null;
    if (nextDueDate) {
      const d = new Date(nextDueDate + 'T00:00:00');
      const day = d.getDate();
      const mon = d.toLocaleString('en-GB', { month: 'short' });
      nextLabel = `${day} ${mon}`;
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '400px', gap: '16px', maxWidth: '480px', margin: '0 auto' }} className="fade-up">
        <Pendant variant="open" height={110} />
        <div style={{ fontFamily: SH.fd, fontSize: '22px', color: C.text, textAlign: 'center' }}>
          Nothing due today
        </div>
        {nextLabel && (
          <div style={{ fontSize: '13px', color: C.textM, textAlign: 'center' }}>
            Next review due {nextLabel}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '100%', maxWidth: '280px', marginTop: '8px' }}>
          {newCards.length > 0 && (
            <button style={S.btnPrimary} onClick={() => startPhase('new')}>
              Study {newCards.length} new card{newCards.length !== 1 ? 's' : ''}
            </button>
          )}
          {deferredButton(false, false)}
          {extraLeft.length > 0 && (
            <button style={S.btnGhost} onClick={() => startPhase('extra')}>
              Browse full deck
            </button>
          )}
          <button style={{ ...S.btnGhost, opacity: 0.7 }} onClick={onEnd}>End</button>
        </div>
      </div>
    );
  }

  // ── Round ends (O2) ───────────────────────────────────────
  // A finished round (selected, due or new cards) gets the closing bookend:
  // the 완료 medallion with a short pendant, then the ways on. The session
  // end itself is the 'finished' screen above.
  const roundEnd = (title, count, buttons) => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '400px', maxWidth: '480px', margin: '0 auto' }} className="fade-up">
      <Medallion>
        <div style={{ fontFamily: SH.fk, fontSize: '34px', fontWeight: 700, color: C.accent, lineHeight: 1 }}>완료</div>
        <div style={{ fontFamily: SH.fd, fontSize: '18px', color: C.text }}>{title}</div>
        <MiniRule />
        {count != null && (
          <div style={{ fontFamily: SH.fm, fontSize: '13px', color: C.text }}>
            {count} card{count !== 1 ? 's' : ''} reviewed
          </div>
        )}
      </Medallion>
      <Pendant variant="close" height={110} style={{ marginTop: '-1px' }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '100%', maxWidth: '280px', marginTop: '24px' }}>
        {buttons}
        <button style={{ ...S.btnGhost, opacity: 0.7, justifyContent: 'center' }} onClick={onEnd}>End session</button>
      </div>
    </div>
  );

  // ── Boundary: after manually-selected cards ───────────────
  if (phase === 'boundary_manual') {
    return roundEnd('Selected cards complete', manualCards.length, (
      <>
        {dueCards.length > 0 && (
          <button style={{ ...S.btnPrimary, justifyContent: 'center' }} onClick={() => startPhase('due')}>
            Continue to {dueCards.length} due card{dueCards.length !== 1 ? 's' : ''}
          </button>
        )}
        {extraLeft.length > 0 && (
          <button style={{ ...S.btnGhost, justifyContent: 'center' }} onClick={() => startPhase('extra')}>
            {dueCards.length > 0 ? 'Skip to full deck' : 'Continue to full deck'}
          </button>
        )}
      </>
    ));
  }

  // ── Boundary: after due phase, and after a deferred round (DF2) ──
  if (phase === 'boundary_1_2' || phase === 'boundary_deferred') {
    const afterDeferred = phase === 'boundary_deferred';
    return roundEnd(
      afterDeferred ? 'Deferred cards complete' : 'Due cards complete',
      afterDeferred ? deferredRound.length : dueCards.length,
      (
        <>
          {newCards.length > 0 && (
            <button style={{ ...S.btnPrimary, justifyContent: 'center' }} onClick={() => startPhase('new')}>
              Study {newCards.length} new card{newCards.length !== 1 ? 's' : ''}
            </button>
          )}
          {deferredButton(afterDeferred)}
          {extraLeft.length > 0 && (
            <button style={{ ...S.btnGhost, justifyContent: 'center' }} onClick={() => startPhase('extra')}>
              {newCards.length > 0 || nextDeferred > 0 ? 'Skip to full deck' : 'Continue to full deck'}
            </button>
          )}
        </>
      ),
    );
  }

  // ── Boundary: after new cards phase ──────────────────────
  if (phase === 'boundary_2_3') {
    return roundEnd('New cards complete', newCards.length, (
      extraLeft.length > 0 && (
        <button style={{ ...S.btnPrimary, justifyContent: 'center' }} onClick={() => startPhase('extra')}>
          Continue to full deck
        </button>
      )
    ));
  }

  // ── Active card review ────────────────────────────────────
  if (!card) return null;
  const isSentence = card.type === 'sentence';
  const isGrammar  = card.type === 'grammar';
  // Reverse is a word-deck display flip (Phase D2): the prompt shows the English
  // (back) and the answer shows the Korean (front). Never applies to sentence or
  // grammar cards, so their branches below are untouched.
  const showReversed = reversed && !isSentence && !isGrammar;
  const promptText   = showReversed ? card.back : card.front;
  const answerText   = showReversed ? card.front : card.back;

  const phaseLabel = phase === 'manual' ? 'Selected' : phase === 'due' ? 'Due today' : phase === 'deferred' ? 'Deferred' : phase === 'new' ? 'New' : 'Full deck';
  // Show the original phase array length as the total, not the (growing) queue length.
  // This prevents the progress indicator from jumping when Again cards are re-queued.
  const phaseTotal    = phase === 'manual' ? manualCards.length : phase === 'due' ? dueCards.length : phase === 'deferred' ? deferredRound.length : phase === 'new' ? newCards.length : extraLeft.length;
  // U7: resolved in this phase = resolved overall minus what was resolved
  // before it began. Subtracting every earlier phase's full size counted a
  // skipped phase as done, so "Skip to full deck" sat at 1/N for a while.
  const phaseResolved = (successCount + carriedOver) - phaseBase;
  const phaseProgress = Math.min(Math.max(phaseResolved, 0) + 1, phaseTotal);

  // Per-card Again indicator
  const cardAgainCount = againCounts[card.id] || 0;

  // CX: context sentences below a vocab card. Hidden behind Context on the
  // front (and not offered there in reverse, where they'd give the Korean
  // away); shown automatically once the back is revealed.
  const isVocab     = card.type === 'vocab';
  const ctxKey      = `${card.id}|${turn}`;
  const ctxRows     = isVocab ? contextFor(card, contextIndex) : [];
  const ctxShowList = ctxRows.length > 0 && (revealed || ctxOpenKey === ctxKey);
  const ctxVisible  = ctxAllKey === ctxKey ? ctxRows : ctxRows.slice(0, CONTEXT_SHOWN);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '640px', margin: '0 auto', ...(isMobile && { paddingTop: '32px' }) }} className="fade-up quiz-session">
      {/* Progress */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div style={{ flex: 1, height: '4px', background: `${C.accent}22`, borderRadius: '2px', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${(phaseProgress / phaseTotal) * 100}%`, background: phase === 'extra' ? C.textM : C.accent, borderRadius: '2px', transition: 'width 0.3s' }} />
        </div>
        <span style={{ fontFamily: SH.fm, fontSize: '11px', color: C.textM, whiteSpace: 'nowrap' }}>
          {phaseProgress} / {phaseTotal}
          <span style={{ opacity: 0.6 }}> — {phaseLabel}</span>
        </span>
        <button
          onClick={onEnd}
          style={{ fontSize: '12px', color: C.textM, padding: '3px 10px', borderRadius: '6px', border: `1px solid ${C.border}`, background: 'transparent', cursor: 'pointer' }}
          className="btn-ghost"
        >
          End
        </button>
      </div>

      {/* Card */}
      <div ref={cardElRef} style={{ ...S.card, padding: '32px', minHeight: '220px', display: 'flex', flexDirection: 'column', gap: '16px', touchAction: 'pan-y' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textM, padding: '2px 8px', borderRadius: '10px', border: `1px solid ${C.border}` }}>
            {isGrammar ? 'Grammar' : isSentence ? 'Sentence' : 'Vocab'}
          </span>
          {card.deckNames?.length > 0 && (
            <span style={{ fontSize: '11px', color: C.textM }}>{card.deckNames[0]}</span>
          )}
          {cardAgainCount > 0 && (
            <span style={{ fontSize: '10px', fontWeight: 600, color: '#c0553a', padding: '2px 7px', borderRadius: '10px', border: '1px solid #c0553a44', background: '#c0553a11', marginLeft: 'auto' }}>
              Again {cardAgainCount}/{AGAIN_CAP}
            </span>
          )}
          {isGrammar && card.linkedGrammarEntryId && onNavigateToGrammar && (
            <button onClick={() => onNavigateToGrammar(card.linkedGrammarEntryId)} style={{ marginLeft: 'auto', fontSize: '11px', color: C.accent, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
              View Grammar Index →
            </button>
          )}
        </div>

        <div>
          {isSentence && card.lemma && (
            <div style={{ fontFamily: SH.fk, fontSize: '15px', fontWeight: 600, color: C.accent, marginBottom: '8px' }}>{card.lemma}</div>
          )}
          <div style={{ fontFamily: SH.fk, fontSize: isSentence ? '18px' : '26px', fontWeight: 500, color: C.text, lineHeight: 1.4 }}>
            {isSentence
              ? renderSentenceHighlight(card.sentence || card.front, card.inputForm, C)
              : promptText}
          </div>
        </div>

        {card.type !== 'grammar' && card.audioUrl && settings?.ttsEnabled !== false && (!showReversed || revealed) && (
          <button
            onClick={handlePlayAudio}
            style={{
              alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: '5px',
              padding: '4px 10px', borderRadius: '6px', cursor: 'pointer',
              border: `1px solid ${playingKey === 'main' ? C.accent : C.border}`,
              background: playingKey === 'main' ? C.accentSoft : 'transparent',
              color: playingKey === 'main' ? C.accent : C.textM,
              fontSize: '12px', transition: 'all 0.15s',
            }}
          >
            {playingKey === 'main' ? Icons.speakerPlaying : Icons.speaker}
          </button>
        )}

        {!revealed ? (
          <button
            onClick={flip}
            style={{ marginTop: 'auto', padding: '10px 20px', borderRadius: '8px', border: `1px solid ${C.border}`, background: 'transparent', color: C.textS, fontSize: '13px', cursor: 'pointer', transition: 'all 0.15s', alignSelf: 'center' }}
            className="btn-ghost"
          >
            Show answer
          </button>
        ) : isGrammar ? (
          <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {[
              { key: 'explanation', label: 'Explanation / Usage Rules', content: card.explanation },
              { key: 'examples',    label: 'Examples',                  content: null },
              { key: 'compareTo',   label: 'Compare to',                content: card.back },
            ].map(({ key, label, content }) => {
              // Prefer per-sentence audio once a card has been resynced; fall back to
              // splitting the raw examples text so the sentences still show before that.
              const exampleRows = key === 'examples'
                ? (card.exampleAudio?.length
                    ? card.exampleAudio
                    : (card.examples || '').split('\n').map(s => s.trim()).filter(Boolean).map(text => ({ text, url: null })))
                : null;
              return (
                <div key={key} style={{ border: `1px solid ${C.border}`, borderRadius: '8px', overflow: 'hidden' }}>
                  <button
                    onClick={() => setRevealedSections(prev => ({ ...prev, [key]: !prev[key] }))}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: revealedSections[key] ? C.accentSoft : C.bg, border: 'none', cursor: 'pointer', transition: 'background 0.15s' }}
                  >
                    <span style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textM }}>{label}</span>
                    <span style={{ fontSize: '12px', color: C.textM, transform: revealedSections[key] ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>›</span>
                  </button>
                  {revealedSections[key] && (
                    <div style={{ padding: '12px 14px', borderTop: `1px solid ${C.border}` }} className="fade-up">
                      {key === 'examples' ? (
                        exampleRows.length ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                            {exampleRows.map((ex, i) => (
                              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                                {ex.url && settings?.ttsEnabled !== false && (
                                  <button
                                    onClick={() => handlePlayExample(i, ex.url)}
                                    style={{
                                      flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                      width: '24px', height: '24px', borderRadius: '6px', cursor: 'pointer', marginTop: '1px',
                                      border: `1px solid ${playingKey === i ? C.accent : C.border}`,
                                      background: playingKey === i ? C.accentSoft : 'transparent',
                                      color: playingKey === i ? C.accent : C.textM,
                                    }}
                                  >
                                    {playingKey === i ? Icons.speakerPlaying : Icons.speaker}
                                  </button>
                                )}
                                <span style={{ fontFamily: SH.fk, fontSize: '14px', color: C.text, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{ex.text}</span>
                              </div>
                            ))}
                          </div>
                        ) : <div style={{ fontSize: '13px', color: C.textM, fontStyle: 'italic' }}>Not filled in yet.</div>
                      ) : content
                        ? <div style={{ fontSize: '14px', color: C.text, lineHeight: 1.7, whiteSpace: 'pre-wrap', fontFamily: key === 'compareTo' ? SH.fk : 'inherit' }}>{content}</div>
                        : <div style={{ fontSize: '13px', color: C.textM, fontStyle: 'italic' }}>Not filled in yet.</div>
                      }
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: '16px' }}>
            <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textM, marginBottom: '8px' }}>Answer</div>
            <div style={{ fontSize: '15px', color: C.text, lineHeight: 1.6, whiteSpace: 'pre-wrap', fontFamily: showReversed ? SH.fk : undefined }}>
              {answerText || <span style={{ color: C.textM, fontStyle: 'italic' }}>No answer added yet.</span>}
            </div>
            {card.notes && (
              <div style={{ marginTop: '12px', fontSize: '13px', color: C.textM, lineHeight: 1.6, fontStyle: 'italic' }}>{card.notes}</div>
            )}
          </div>
        )}
      </div>

      {/* Grade buttons */}
      {revealed && (
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }} className="fade-up">
          {GRADES.map(g => (
            <button
              key={g.rating}
              onClick={() => handleGrade(g.rating)}
              className={gradedRating === g.rating ? 'grade-pulse' : undefined}
              style={{ flex: 1, padding: '10px 4px', borderRadius: '8px', border: `1px solid ${g.color}44`, background: `${g.color}18`, color: g.color, fontSize: '12px', fontWeight: 500, cursor: 'pointer', transition: 'all 0.15s' }}
            >
              {g.label}
            </button>
          ))}
        </div>
      )}

      {/* CX: context sentences (vocab cards) */}
      {isVocab && ctxRows.length === 0 && (
        <div style={{ display: 'flex', justifyContent: 'center' }} className="fade-up">
          <Pendant variant="close" height={150} />
        </div>
      )}
      {isVocab && ctxRows.length > 0 && !ctxShowList && !showReversed && (
        <button
          onClick={() => setCtxOpenKey(ctxKey)}
          style={{ padding: '10px 20px', borderRadius: '8px', border: `1px solid ${C.border}`, background: 'transparent', color: C.textS, fontSize: '13px', cursor: 'pointer', transition: 'all 0.15s', alignSelf: 'center' }}
          className="btn-ghost"
        >
          Context
        </button>
      )}
      {ctxShowList && (
        <div style={{ border: `1px solid ${C.border}`, borderRadius: '8px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' }} className="fade-up">
          <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textM }}>Context</div>
          {ctxVisible.map((r, i) => (
            <div key={r.sentence} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
              {r.audioUrl && settings?.ttsEnabled !== false && (
                <button
                  onClick={() => handlePlayExample(`ctx${i}`, r.audioUrl)}
                  style={{
                    flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    width: '24px', height: '24px', borderRadius: '6px', cursor: 'pointer', marginTop: '2px',
                    border: `1px solid ${playingKey === `ctx${i}` ? C.accent : C.border}`,
                    background: playingKey === `ctx${i}` ? C.accentSoft : 'transparent',
                    color: playingKey === `ctx${i}` ? C.accent : C.textM,
                  }}
                >
                  {playingKey === `ctx${i}` ? Icons.speakerPlaying : Icons.speaker}
                </button>
              )}
              <span style={{ fontFamily: SH.fk, fontSize: '15px', color: C.text, lineHeight: 1.7 }}>
                {renderSentenceHighlight(r.sentence, r.inputForm, C)}
              </span>
            </div>
          ))}
          {ctxVisible.length < ctxRows.length && (
            <button
              onClick={() => setCtxAllKey(ctxKey)}
              style={{ alignSelf: 'flex-start', fontSize: '12px', color: C.accent, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              Show {ctxRows.length - ctxVisible.length} more
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Deck card ─────────────────────────────────────────────────
function DeckCard({ deck, totalCount, dueCount, newCount, masteryBreakdown, lastStudied, onClick, onSelectCards, onTogglePause, onToggleReverse, onEcho, C, S }) {
  const type   = deckType(deck);
  const accent = deckAccent(type, C);
  const isSentenceDeck = type === 'sentence';

  const baseName = isSentenceDeck
    ? deck.name.replace(' (sentence mining)', '')
    : deck.name;

  return (
    <div
      onClick={onClick}
      style={{ ...S.card, padding: '20px', cursor: 'pointer', transition: 'all 0.15s' }}
      className="btn-ghost"
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', marginBottom: '8px' }}>
        <div>
          <div style={{ fontFamily: SH.fk, fontSize: '15px', fontWeight: 500, color: C.text, lineHeight: 1.3 }}>
            {baseName}
          </div>
          {isSentenceDeck && (
            <div style={{ fontFamily: SH.fk, fontSize: '12px', color: C.textM, marginTop: '2px' }}>
              (sentence mining)
            </div>
          )}
        </div>
        <div style={{ flex: 1, height: '1px', marginTop: '9px', background: `linear-gradient(to right, ${accent}, ${accent}0D)`, flexShrink: 0 }} />
      </div>

      {/* Mastery breakdown (grammar deck) */}
      {masteryBreakdown && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '8px' }}>
          {Object.entries(GRAMMAR_MASTERY).map(([key, cfg]) => {
            const count = masteryBreakdown[key] || 0;
            if (!count) return null;
            return (
              <span key={key} style={{ fontSize: '10px', fontWeight: 600, color: cfg.color, padding: '1px 6px', borderRadius: '8px', border: `1px solid ${cfg.color}44` }}>
                {cfg.label} {count}
              </span>
            );
          })}
        </div>
      )}

      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        {totalCount !== null && (
          <span style={{ fontSize: '11px', color: C.textM }}>{totalCount} cards</span>
        )}
        {dueCount !== null && dueCount > 0 && (
          <span style={{ fontSize: '11px', fontWeight: 600, color: accent }}>{dueCount} due</span>
        )}
        {newCount !== null && newCount > 0 && (
          <span style={{ fontSize: '11px', color: C.textM }}>{newCount} new</span>
        )}
        {lastStudied && type !== 'word' && (
          <span style={{ fontSize: '11px', color: C.textM, marginLeft: 'auto' }}>{lastStudied}</span>
        )}
      </div>

      {onSelectCards && (
        <button
          onClick={(e) => { e.stopPropagation(); onSelectCards(); }}
          style={{ width: '100%', marginTop: '10px', padding: '6px', fontSize: '11px', borderRadius: '6px', border: `1px solid ${C.border}`, background: 'transparent', color: C.textM, cursor: 'pointer', transition: 'all 0.15s' }}
          className="btn-ghost"
        >
          Select cards to study
        </button>
      )}

      {type === 'word' && (onTogglePause || onToggleReverse || onEcho) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px' }}>
          {onTogglePause && (
            <button
              onClick={(e) => { e.stopPropagation(); onTogglePause(deck); }}
              title={deck.paused ? 'Resume — return this set to the review rotation' : 'Pause — hold this set out of the review rotation'}
              style={{ padding: '4px 5px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '5px', cursor: 'pointer', transition: 'all 0.15s', border: `1px solid ${deck.paused ? C.warning : C.border}`, background: deck.paused ? `${C.warning}18` : 'transparent', color: deck.paused ? C.warning : C.textM, flexShrink: 0 }}
            >
              {Icons.pause}
            </button>
          )}
          {onToggleReverse && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleReverse(deck); }}
              title={deck.reversed ? 'Studying back to front — tap to restore front to back' : 'Reverse — study this deck back to front'}
              style={{ padding: '4px 5px', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '5px', cursor: 'pointer', transition: 'all 0.15s', border: `1px solid ${deck.reversed ? C.accent : C.border}`, background: deck.reversed ? C.accentSoft : 'transparent', color: deck.reversed ? C.accent : C.textM, flexShrink: 0 }}
            >
              {Icons.flipH}
            </button>
          )}
          {onEcho && (
            <button
              onClick={(e) => { e.stopPropagation(); onEcho(deck); }}
              title="Echo Quiz with this deck's words"
              aria-label={`Echo Quiz with ${deck.name}`}
              style={{ padding: '3px 8px', fontSize: '11px', borderRadius: '5px', cursor: 'pointer', transition: 'all 0.15s', border: `1px solid ${C.border}`, background: 'transparent', color: C.textM, flexShrink: 0, lineHeight: 1.3 }}
            >
              Echo
            </button>
          )}
          {lastStudied && (
            <span style={{ fontSize: '11px', color: C.textM, marginLeft: 'auto' }}>{lastStudied}</span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Deck manager ──────────────────────────────────────────────
function DeckManager({ decks, cards, onDelete, onClose, C, S }) {
  const [selected,   setSelected]   = useState(new Set());
  const [confirming, setConfirming] = useState(false);

  const toggleDeck = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedDecks = decks.filter(d => selected.has(d.id));
  const totalCards    = selectedDecks.reduce((sum, d) => sum + (d.totalCards || 0), 0);
  // P5: cards that are also in a deck you're keeping stay in it.
  const keptShared = (cards || []).filter(c => {
    const ids = c.deckIds || [];
    return ids.some(id => selected.has(id)) && ids.some(id => !selected.has(id));
  }).length;

  // Both returns portal to document.body — DeckManager mounts inside
  // FlashcardsPage's `.fade-up` wrapper, whose persistent transform creates a
  // containing block that would trap these fixed overlays.
  if (confirming) {
    return createPortal(
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
        <div style={{ background: C.surface, borderRadius: '16px', padding: '28px', maxWidth: '480px', width: '100%' }}>
          <div style={{ fontFamily: SH.fd, fontSize: '20px', fontWeight: 300, color: C.text, marginBottom: '6px' }}>Confirm deletion</div>
          <p style={{ fontSize: '13px', color: C.textM, marginBottom: '16px', lineHeight: 1.6 }}>
            The following deck{selectedDecks.length !== 1 ? 's' : ''} and their cards will be permanently deleted:
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '8px' }}>
            {selectedDecks.map(d => (
              <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', borderRadius: '8px', background: `${C.danger}0d`, border: `1px solid ${C.danger}44` }}>
                <span style={{ fontSize: '13px', color: C.text, fontFamily: SH.fk }}>{d.name}</span>
                <span style={{ fontSize: '11px', color: C.textM }}>{d.totalCards || 0} cards</span>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: C.textM, padding: '4px 12px', marginBottom: keptShared ? '6px' : '20px' }}>
            <span>Total</span>
            <span>{totalCards} cards</span>
          </div>
          {keptShared > 0 && (
            <p style={{ fontSize: '12px', color: C.textM, padding: '0 12px', marginBottom: '20px', lineHeight: 1.6 }}>
              {keptShared} card{keptShared !== 1 ? 's are' : ' is'} also in another deck and will stay there with {keptShared !== 1 ? 'their' : 'its'} review history.
            </p>
          )}
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <button style={S.btnGhost} onClick={() => setConfirming(false)}>Back</button>
            <button
              style={{ ...S.btnPrimary, background: C.danger, borderColor: C.danger }}
              onClick={() => onDelete([...selected])}
            >
              Delete
            </button>
          </div>
        </div>
      </div>,
      document.body
    );
  }

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
      <div style={{ background: C.surface, borderRadius: '16px', padding: '28px', maxWidth: '480px', width: '100%', maxHeight: '80vh', overflowY: 'auto' }}>
        <div style={{ fontFamily: SH.fd, fontSize: '20px', fontWeight: 300, color: C.text, marginBottom: '20px' }}>Manage Decks</div>
        <p style={{ fontSize: '13px', color: C.textM, marginBottom: '16px', lineHeight: 1.6 }}>
          Select decks to delete. All cards belonging only to the deleted deck(s) will be removed.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px' }}>
          {decks.filter(d => d.id !== 'deck_grammar').map(deck => (
            <label key={deck.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '8px', border: `1px solid ${selected.has(deck.id) ? C.danger : C.border}`, background: selected.has(deck.id) ? `${C.danger}11` : 'transparent', cursor: 'pointer' }}>
              <input type="checkbox" checked={selected.has(deck.id)} onChange={() => toggleDeck(deck.id)} style={{ accentColor: C.danger, width: '15px', height: '15px' }} />
              <span style={{ fontSize: '13px', color: C.text, fontFamily: SH.fk }}>{deck.name}</span>
              {deck.totalCards != null && (
                <span style={{ fontSize: '11px', color: C.textM, marginLeft: 'auto' }}>{deck.totalCards} cards</span>
              )}
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button style={S.btnGhost} onClick={onClose}>Cancel</button>
          <button
            style={{ ...S.btnPrimary, background: selected.size > 0 ? C.danger : undefined, opacity: selected.size > 0 ? 1 : 0.4 }}
            disabled={selected.size === 0}
            onClick={() => setConfirming(true)}
          >
            Delete {selected.size > 0 ? `${selected.size} deck${selected.size > 1 ? 's' : ''}` : ''}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Main page ─────────────────────────────────────────────────
// onEchoDeck(deckId) (X3): opens the Echo setup on the Quizzes page with that deck chosen.
export function FlashcardsPage({ soundProfile, dsh, onNavigateToGrammar, cards, decks, fcLoading, updateCards, updateDecks, grammarMasteryCounts, grammarEntries, flashcardStudyTarget, setFlashcardStudyTarget, fsrsSettings = {}, srsSnapshot = {}, deferralForecast = null, settings = {}, onEchoDeck = null, onNotice = null, aviSources = [], sentenceInputs = [] }) {
  const { C, S } = useAppTheme();
  const [session,           setSession]           = useState(null);
  // OF-D2: while a session is open, cards changed on another device are not
  // read in; they arrive when it ends (the card data hook in App listens).
  const inReview = !!session;
  useEffect(() => {
    setReviewInProgress(inReview);
    return () => setReviewInProgress(false);
  }, [inReview]);
  const [managing,          setManaging]          = useState(false);
  const [cleanupResult,     setCleanupResult]     = useState(null);
  const [showGrammarPicker, setShowGrammarPicker] = useState(false);
  const [resyncing,         setResyncing]         = useState(false);
  const [resyncResult,      setResyncResult]      = useState(null);
  const uid = auth.currentUser?.uid;

  const todayStr = getLogicalDateStr(dsh ?? 3);

  // reviewLog and reviewStats are mirrored into refs alongside their React
  // state. The refs are what handleGrade reads from when computing the next
  // value — plain useState closures would risk reading a stale value if two
  // grades land before a re-render flushes (same race class as the
  // flashcard duplicate bug). State stays purely for rendering (the
  // heatmap's `data` prop, eventually the records strip).
  const [reviewLog,          setReviewLog]          = useState({});
  const reviewLogRef = useRef({});
  const [reviewHeatmapEndYM, setReviewHeatmapEndYM] = useState(() =>
    getLogicalDateStr(dsh ?? 3).slice(0, 7)
  );
  const [reviewStats, setReviewStats] = useState(null);

  // ── Load review log (bounded to a rolling window) ───────────
  // Fetches only the months actually needed instead of the whole
  // collection, which would otherwise grow forever. REVIEW_LOG_BUFFER_MONTHS
  // covers the heatmap's default 12-month view plus one month of slack;
  // paging the heatmap further back triggers loadReviewLogRange again for
  // whatever additional months aren't loaded yet (see
  // handleHeatmapWindowChange below). Document IDs are 'YYYY-MM-DD', so a
  // documentId() range query works directly with no separate indexed field.
  const REVIEW_LOG_BUFFER_MONTHS = 13;
  const loadedReviewLogStartYM = useRef(null); // oldest 'YYYY-MM' currently loaded

  const loadReviewLogRange = useCallback(async (startYM) => {
    if (!uid) return;
    try {
      const snap = await getDocs(query(
        collection(db, 'users', uid, 'reviewLog'),
        where(documentId(), '>=', `${startYM}-01`),
      ));
      const fetched = {};
      snap.forEach(d => { fetched[d.id] = d.data().count || 0; });
      // Newly-fetched (older) months merge under whatever's already loaded,
      // so today's optimistic grading updates are never clobbered.
      const merged = { ...fetched, ...reviewLogRef.current };
      reviewLogRef.current = merged;
      setReviewLog(merged);
      loadedReviewLogStartYM.current = startYM;
    } catch (e) {
      console.error('FlashcardsPage: reviewLog load failed', e);
    }
  }, [uid]);

  useEffect(() => {
    if (!uid) return;
    loadReviewLogRange(shiftMonth(todayStr.slice(0, 7), -(REVIEW_LOG_BUFFER_MONTHS - 1)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional one-time load on mount
  }, [uid]);

  // Expands the loaded window backward only when the heatmap is paged
  // somewhere not already covered, rather than loading full history upfront.
  const handleHeatmapWindowChange = useCallback((newEndYM) => {
    setReviewHeatmapEndYM(newEndYM);
    const monthsToShow = isMobile ? 3 : 12; // mirrors ActivityHeatmap's own default
    const neededStartYM = shiftMonth(newEndYM, -(monthsToShow - 1));
    if (loadedReviewLogStartYM.current && neededStartYM < loadedReviewLogStartYM.current) {
      loadReviewLogRange(neededStartYM);
    }
  }, [loadReviewLogRange]);

  // ── Load review stats ────────────────────────────────────────
  // One small doc (see utils/reviewStatsEngine.js) instead of recomputing
  // records from full history on every load. Until the DevDashboard
  // "Recompute review stats" button has been run once to seed it, this
  // reads as EMPTY_REVIEW_STATS rather than erroring.
  //
  // FS4: read before any write (utils/reviewStatsGuard.js). A grade made
  // before the records have loaded waits in the guard's backlog.
  const statsGuard = useMemo(() => createStatsGuard({
    load: async () => {
      const snap = await getDoc(doc(db, 'users', uid, 'settings', 'reviewStats'));
      return snap.exists() ? snap.data() : EMPTY_REVIEW_STATS;
    },
    save: (stats) => {
      setDoc(doc(db, 'users', uid, 'settings', 'reviewStats'), stats)
        .catch(e => console.error('reviewStats write failed', e));
    },
    apply: (stats, g) => applyReviewToStats(stats, g.logDate, g.newDayCount, g.dsh),
    onChange: setReviewStats,
  }), [uid]);

  useEffect(() => {
    if (uid) statsGuard.ensureLoaded();
  }, [uid, statsGuard]);

  // SC-D7: the records and today's count are read again when a session
  // starts. This page can sit open for hours, and reviews done on another
  // device in that time would otherwise be written over (the records) or
  // counted from 1 again (today's count). Neither read is waited on: grades
  // made before the records land are held by the guard, and the count takes
  // whichever is higher, what this device has or what was stored.
  const refreshReviewRecords = useCallback(() => {
    if (!uid) return;
    statsGuard.refresh();
    const logDate = getLogicalDateStr(dsh ?? 3);
    getDoc(doc(db, 'users', uid, 'reviewLog', logDate))
      .then(snap => {
        const stored = snap.exists() ? (snap.data().count || 0) : 0;
        if (stored > (reviewLogRef.current[logDate] || 0)) {
          reviewLogRef.current = { ...reviewLogRef.current, [logDate]: stored };
          setReviewLog(reviewLogRef.current);
        }
      })
      .catch(e => console.warn("FlashcardsPage: couldn't re-read today's review count", e));
  }, [uid, dsh, statsGuard]);

  // ── Deck total sync (runs once on mount when cards are ready) ─
  // Pipeline itself now runs at App level so it fires on any page open.
  const deckSyncRan = useRef(false);
  useEffect(() => {
    if (!uid || !cards || deckSyncRan.current) return;
    deckSyncRan.current = true;
    (async () => {
      try {
        const deckTotals = {};
        cards.forEach(c => {
          (c.deckIds || []).forEach(id => {
            deckTotals[id] = (deckTotals[id] || 0) + 1;
          });
        });
        // A deck whose last card is gone gets no entry above, so its stored
        // totalCards would stay stale; write 0 for it instead.
        decks.forEach(d => {
          if (d.id !== 'deck_grammar' && !(d.id in deckTotals) && d.totalCards) deckTotals[d.id] = 0;
        });
        const deckBatch = writeBatch(db);
        Object.entries(deckTotals).forEach(([deckId, count]) => {
          deckBatch.update(doc(db, 'users', uid, 'decks', deckId), { totalCards: count });
        });
        await deckBatch.commit();
        updateDecks(prev => prev.map(d => ({
          ...d,
          totalCards: deckTotals[d.id] ?? d.totalCards ?? 0,
        })));
      } catch (e) {
        console.error('FlashcardsPage: deck sync failed', e);
      }
    })();
  }, [uid, cards]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Deck name lookup ──────────────────────────────────────
  const deckNameMap = useMemo(() => {
    const m = {};
    decks.forEach(d => { m[d.id] = d.name; });
    return m;
  }, [decks]);

  // ── Enrich cards with deckNames ───────────────────────────
  const enrichedCards = useMemo(() => {
    if (!cards) return null;
    return cards.map(c => ({
      ...c,
      deckNames: (c.deckIds || []).map(id => deckNameMap[id]).filter(Boolean),
    }));
  }, [cards, deckNameMap]);

  // CX: sentence rows by word, for the context section below vocab cards.
  const contextIndex = useMemo(() => buildContextIndex(sentenceInputs, cards), [sentenceInputs, cards]);

  // ── Pause state (Phase D2) ────────────────────────────────
  // A card counts as paused only when every deck it belongs to is paused; a
  // card still live in any active deck keeps surfacing.
  const pausedDeckIds = useMemo(() => new Set(decks.filter(d => d.paused).map(d => d.id)), [decks]);
  const isCardPaused = useCallback(
    (c) => !!(c.deckIds?.length && c.deckIds.every(id => pausedDeckIds.has(id))),
    [pausedDeckIds],
  );

  // SC-D5: how many cards are already due on each day, so a new interval of
  // a week or more can land on a lighter day nearby (fsrsGrade). Rebuilt when
  // the cards change; handleGrade also adds each card it places, so two quick
  // grades can't both pick the same "empty" day before the rebuild.
  const dueLoadRef = useRef(null);
  useEffect(() => {
    dueLoadRef.current = buildDueLoad(cards, isCardPaused);
  }, [cards, isCardPaused]);

  const handleTogglePause = useCallback(async (deck) => {
    if (!uid) return;
    const next = !deck.paused;
    updateDecks(prev => prev.map(d => d.id === deck.id ? { ...d, paused: next } : d));
    try {
      await updateDoc(doc(db, 'users', uid, 'decks', deck.id), { paused: next });
    } catch (e) {
      console.error('FlashcardsPage: pause toggle failed', e);
    }
  }, [uid, updateDecks]);

  const handleToggleReverse = useCallback(async (deck) => {
    if (!uid) return;
    const next = !deck.reversed;
    updateDecks(prev => prev.map(d => d.id === deck.id ? { ...d, reversed: next } : d));
    try {
      await updateDoc(doc(db, 'users', uid, 'decks', deck.id), { reversed: next });
    } catch (e) {
      console.error('FlashcardsPage: reverse toggle failed', e);
    }
  }, [uid, updateDecks]);

  // ── Per-deck due/new counts ───────────────────────────────
  const deckStats = useMemo(() => {
    if (!enrichedCards) return {};
    const stats = {};
    enrichedCards.forEach(c => {
      if (c.type === 'grammar') return;
      (c.deckIds || []).forEach(id => {
        if (!stats[id]) stats[id] = { due: 0, new: 0, total: 0 };
        stats[id].total++;
        if (isDueToday(c, dsh ?? 3))    stats[id].due++;
        else if (isNewCard(c)) stats[id].new++;
      });
    });
    return stats;
  // T4: todayStr so due counts move on when the day flips with the page open.
  }, [enrichedCards, dsh, todayStr]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Series decks (SD-D1–SD-D4) ────────────────────────────
  // Virtual decks pooling the cards of a Content Library series' books: no
  // deck doc, the books' own cards, so a review here or in a book's deck
  // moves the same card. A word shared by two books is one card (SD-D8); a
  // word still carded separately in each shows once, the more overdue copy.
  const seriesGroups = useMemo(() => buildSeriesGroups(aviSources, decks), [aviSources, decks]);
  const seriesDecks = useMemo(() => {
    const word = new Set(wordSeries(seriesGroups).map(g => g.name));
    const sent = new Set(sentenceSeries(seriesGroups).map(g => g.name));
    const out = [];
    for (const g of seriesGroups) {
      if (word.has(g.name)) out.push({ id: g.wordId, name: g.name, memberIds: g.wordDeckIds });
      if (sent.has(g.name)) out.push({ id: g.sentenceId, name: g.name + SENTENCE_DECK_SUFFIX, memberIds: g.sentenceDeckIds });
    }
    return out;
  }, [seriesGroups]);

  const seriesPool = useCallback((sd) => {
    if (!enrichedCards || !sd) return [];
    const members = new Set(sd.memberIds);
    const best = new Map();
    for (const c of enrichedCards) {
      if (c.type === 'grammar' || isCardPaused(c)) continue;
      if (!(c.deckIds || []).some(id => members.has(id))) continue;
      const key = c.type === 'sentence'
        ? `s\u0000${normalizeLemma(c.lemma || '')}\u0000${(c.sentence || c.front || '').normalize('NFC')}`
        : `w\u0000${normalizeLemma(c.lemma || c.front || '')}`;
      const cur = best.get(key);
      if (!cur || moreOverdue(c, cur)) best.set(key, c);
    }
    return [...best.values()];
  }, [enrichedCards, isCardPaused]);

  const seriesStats = useMemo(() => {
    const out = {};
    for (const sd of seriesDecks) {
      const pool = seriesPool(sd);
      out[sd.id] = {
        total: pool.length,
        due:   pool.filter(c => isDueToday(c, dsh ?? 3)).length,
        new:   pool.filter(c => isNewCard(c)).length,
      };
    }
    return out;
  // todayStr: due counts move on when the day flips with the page open.
  }, [seriesDecks, seriesPool, dsh, todayStr]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Empty decks stay off the page ─────────────────────────
  // A deck with no cards is left out of Recent, Series and Decks (Manage
  // Decks still lists it so it can be deleted). Live count once cards load;
  // before that, the stored totalCards. The Grammar deck keeps its own rules.
  const deckCardTotal = useCallback((d) => {
    if (d.id === 'deck_grammar' || !enrichedCards) return d.totalCards ?? null;
    return deckStats[d.id]?.total ?? 0;
  }, [enrichedCards, deckStats]);
  const shownDecks = useMemo(
    () => decks.filter(d => d.id !== 'deck_grammar' && deckCardTotal(d) !== 0),
    [decks, deckCardTotal]
  );
  const shownSeriesDecks = useMemo(
    () => enrichedCards ? seriesDecks.filter(sd => (seriesStats[sd.id]?.total ?? 0) > 0) : seriesDecks,
    [enrichedCards, seriesDecks, seriesStats]
  );

  // ── Recently studied decks (up to 4, sorted by lastStudied desc) ─
  const recentDecks = useMemo(() => {
    return [...decks]
      .filter(d => !!d.lastStudied && deckCardTotal(d) !== 0)
      .sort((a, b) => b.lastStudied.localeCompare(a.lastStudied))
      .slice(0, 4);
  }, [decks, deckCardTotal]);

  // ── Recent Grammar (Dispatches box — mirrors Content Library's Gazette tab) ─
  const recentGrammarReviews = useMemo(() => (cards || [])
    .filter(c => c.type === 'grammar' && (c.lastReview || c.lastReviewed))
    .sort((a, b) => (b.lastReview || b.lastReviewed).localeCompare(a.lastReview || a.lastReviewed))
    .slice(0, 3)
    .map(c => {
      const entry = (grammarEntries || []).find(e => e.id === c.linkedGrammarEntryId);
      const rd = new Date(c.lastReview || c.lastReviewed);
      if (rd.getHours() < (dsh ?? 3)) rd.setDate(rd.getDate() - 1);
      return { entry, reviewDate: rd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) };
    })
    .filter(r => r.entry),
    [cards, grammarEntries, dsh]
  );

  // ── Records strip items (best day/week/month, longest + current streak) ─
  // Built from the incrementally-maintained reviewStats doc, not recomputed
  // from reviewLog — see utils/reviewStatsEngine.js. Each entry is omitted
  // entirely (rather than shown blank) until that record actually exists,
  // which in practice means right after the DevDashboard recompute has run
  // once to seed the doc.
  const recordsItems = useMemo(() => {
    if (!reviewStats) return [];
    const effectiveStreak = getEffectiveCurrentStreak(reviewStats, dsh ?? 3);
    return [
      reviewStats.bestDay && { label: 'Best Day', value: `${reviewStats.bestDay.count} · ${fmtRecordDate(reviewStats.bestDay.date)}` },
      reviewStats.bestWeek && { label: 'Best Week', value: `${reviewStats.bestWeek.count} · ${fmtWeekRange(reviewStats.bestWeek.weekStart)}` },
      reviewStats.bestMonth && { label: 'Best Month', value: `${reviewStats.bestMonth.count} · ${fmtMonthLabel(reviewStats.bestMonth.ym)}` },
      reviewStats.longestStreak && { label: 'Longest Streak', value: `${reviewStats.longestStreak.length}d` },
      { label: 'Current Streak', value: `${effectiveStreak}d` },
    ];
  }, [reviewStats, dsh]);

  // ── Start a session ───────────────────────────────────────
  const startSession = useCallback((deckId) => {
    if (!enrichedCards) return;

    if (deckId === 'deck_grammar') {
      const gramPool = enrichedCards.filter(c => c.type === 'grammar');
      const due      = gramPool.filter(c => isDueToday(c, dsh ?? 3)).sort((a, b) => (getDueDateStr(a) || '').localeCompare(getDueDateStr(b) || ''));
      const extra    = gramPool.filter(c => !isDueToday(c, dsh ?? 3)).sort((a, b) => (getDueDateStr(a) || '').localeCompare(getDueDateStr(b) || ''));
      if (!due.length && !extra.length) return;
      setSession({ deckId, dueCards: due, newCards: [], extraCards: extra, nextDueDate: null });
      return;
    }

    let pool;
    // 'deferred' (DF3, the masthead's Deferred corner): every non-paused deck,
    // like 'all', but the session is only the 연기된 카드 round.
    if (deckId === 'all' || deckId === 'deferred') pool = enrichedCards.filter(c => c.type !== 'grammar' && !isCardPaused(c));
    else if (deckId === 'all_words') pool = enrichedCards.filter(c => c.type === 'vocab' && !isCardPaused(c));
    else if (deckId === 'all_sentences') pool = enrichedCards.filter(c => c.type === 'sentence' && !isCardPaused(c));
    else if (isSeriesToken(deckId))  pool = seriesPool(seriesDecks.find(sd => sd.id === deckId));
    else                             pool = enrichedCards.filter(c => (c.deckIds || []).includes(deckId) && c.type !== 'grammar');

    if (!pool.length) return;

    const due = pool
      .filter(c => isDueToday(c, dsh ?? 3))
      .sort((a, b) => (getDueDateStr(a) || '').localeCompare(getDueDateStr(b) || ''));

    const allNew = pool
      .filter(isNewCard)
      .sort((a, b) => {
        if (a.createdAt && b.createdAt) return a.createdAt.localeCompare(b.createdAt);
        return a.id.localeCompare(b.id);
      });
    const newCards = allNew.slice(0, NEW_CARDS_PER_SESSION);

    const extra = pool
      .filter(c => !isDueToday(c, dsh ?? 3) && !isNewCard(c))
      .sort((a, b) => (getDueDateStr(a) || '').localeCompare(getDueDateStr(b) || ''));

    // DF-D10: cards the daily cap deferred and not yet due again (all are in
    // `extra` too). Most at risk of being forgotten first, then the one
    // deferred longest ago, then id.
    const recallNow = Date.now();
    const deferred = pool
      .filter(c => isDeferred(c, dsh ?? 3))
      .map(c => ({ c, r: predictedRecall(c, recallNow) }))
      .sort((a, b) =>
        a.r - b.r ||
        String(a.c.deferredFrom || '').localeCompare(String(b.c.deferredFrom || '')) ||
        String(a.c.id).localeCompare(String(b.c.id)))
      .map(x => x.c);

    if (deckId === 'deferred') {
      if (!deferred.length) return;
      setSession({ deckId, dueCards: [], newCards: [], extraCards: [], deferredCards: deferred, deferredOnly: true, nextDueDate: null, reversed: false });
      return;
    }

    if (!due.length && !newCards.length && !extra.length) return;

    const upcomingDates = pool
      .filter(c => !isNewCard(c) && !isDueToday(c, dsh ?? 3) && getDueDateStr(c))
      .map(c => getDueDateStr(c))
      .sort();
    const nextDueDate = upcomingDates[0] || null;

    // Reverse applies only when studying a specific word deck directly; virtual
    // collections always render canonical orientation (Phase D2).
    const deckObj  = decks.find(d => d.id === deckId);
    const reversed = deckObj?.reversed === true && deckType(deckObj) === 'word';

    refreshReviewRecords(); // SC-D7; grammar sessions don't touch the records
    setSession({ deckId, dueCards: due, newCards, extraCards: extra, deferredCards: deferred, nextDueDate, reversed });
  }, [enrichedCards, dsh, decks, isCardPaused, seriesPool, seriesDecks, refreshReviewRecords]);

  // ── Start a manual Grammar Deck session from a picked, ordered set of cardIds ─
  // Used by "View Card" (single card) and the Grammar Deck picker (multiple).
  // The rest of the grammar pool still follows behind as due → extra, same as
  // a normal Grammar Deck session — manual picks just run first.
  const startManualSession = useCallback((cardIds) => {
    if (!enrichedCards || !cardIds?.length) return;
    const manualSet   = new Set(cardIds);
    const manualCards = cardIds.map(id => enrichedCards.find(c => c.id === id)).filter(Boolean);
    if (!manualCards.length) return;
    const gramPool = enrichedCards.filter(c => c.type === 'grammar' && !manualSet.has(c.id));
    const due   = gramPool.filter(c => isDueToday(c, dsh ?? 3)).sort((a, b) => (getDueDateStr(a) || '').localeCompare(getDueDateStr(b) || ''));
    const extra = gramPool.filter(c => !isDueToday(c, dsh ?? 3)).sort((a, b) => (getDueDateStr(a) || '').localeCompare(getDueDateStr(b) || ''));
    setSession({ deckId: 'deck_grammar', manualCards, dueCards: due, newCards: [], extraCards: extra, nextDueDate: null });
  }, [enrichedCards, dsh]);

  // ── Consume an external study target (View Card, or a confirmed picker selection) ─
  useEffect(() => {
    if (!flashcardStudyTarget?.length || !enrichedCards) return;
    startManualSession(flashcardStudyTarget);
    setFlashcardStudyTarget && setFlashcardStudyTarget(null);
  }, [flashcardStudyTarget, enrichedCards, startManualSession, setFlashcardStudyTarget]);

  // ── Grade a card ──────────────────────────────────────────
  // Returns the updated card object so the session queue can stay current.
  // Grammar cards track when they're studied and how they're graded, but never
  // get an FSRS due date — they're surfaced by manual pick or the mastery-floor
  // nudge (nextDueDate), not by being "due."
  // S6: the card write is queued, not awaited — the persistent cache keeps it
  // and sends it when there's a connection, so grading never waits on the
  // network. A write the server refuses is reported; a card that no longer
  // exists (deleted on another page or device) leaves the session.
  const gradeFailed = useCallback((card) => (e) => {
    if (isNotFound(e)) {
      updateCards(prev => prev ? prev.filter(c => c.id !== card.id) : prev);
      onNotice?.('That card no longer exists, so its review was not saved.');
    } else {
      onNotice?.("A review didn't save. The card will be due again after a reload.");
    }
  }, [updateCards, onNotice]);

  const handleGrade = useCallback(async (card, rating) => {
    if (!uid) return null;

    if (card.type === 'grammar') {
      const now     = new Date().toISOString();
      const history = [...(card.gapEvents || []), { date: now, grade: rating }].slice(-100);
      const updates = { due: null, lastReview: now, lastGrade: rating, reps: (card.reps || 0) + 1, gapEvents: history };
      if (DEMO) return { ...card, ...updates }; // demo: inert grading — nothing persists (D5)
      updateCards(prev => prev ? prev.map(c => c.id === card.id ? { ...c, ...updates } : c) : prev);
      queueWrite(() => updateDoc(doc(db, 'users', uid, 'flashcards', card.id), withCardStamp(updates)),
        'FlashcardsPage: grade write failed', gradeFailed(card));
      return { ...card, ...updates };
    }

    // T1: logical-day due dates. SC-D5: spread over lighter days.
    const dueLoad = dueLoadRef.current;
    const updates = fsrsGrade(card, rating, fsrsSettings, dsh ?? 3, dueLoad);
    if (DEMO) return { ...card, ...updates }; // demo: inert grading — no card write, no reviewLog, no reviewStats (D5)
    if (dueLoad && updates.dueDay) dueLoad.set(updates.dueDay, (dueLoad.get(updates.dueDay) || 0) + 1);
    updateCards(prev => prev ? prev.map(c => c.id === card.id ? { ...c, ...updates } : c) : prev);
    queueWrite(() => updateDoc(doc(db, 'users', uid, 'flashcards', card.id), withCardStamp(updates)),
      'FlashcardsPage: grade write failed', gradeFailed(card));

    const logDate     = getLogicalDateStr(dsh ?? 3);
    const newDayCount = (reviewLogRef.current[logDate] || 0) + 1;
    setDoc(doc(db, 'users', uid, 'reviewLog', logDate), { count: increment(1) }, { merge: true })
      .catch(e => console.error('reviewLog write failed', e));
    reviewLogRef.current = { ...reviewLogRef.current, [logDate]: newDayCount };
    setReviewLog(reviewLogRef.current);

    statsGuard.record({ logDate, newDayCount, dsh: dsh ?? 3 });

    return { ...card, ...updates };
  }, [uid, updateCards, fsrsSettings, dsh, gradeFailed, statsGuard]);

  // ── End a session ─────────────────────────────────────────
  // Again cards still in the queue when the session ends are already written to
  // Firestore with due=past (from when Again was pressed), so they surface first
  // at the next session start with no additional writes needed.
  const handleEndSession = useCallback(() => {
    // Series decks are virtual (no deck doc to stamp).
    if (!DEMO && uid && session?.deckId && !['all', 'all_words', 'all_sentences', 'deferred'].includes(session.deckId) && !isSeriesToken(session.deckId)) {
      const now = new Date().toISOString();
      // S6: queued, so ending a session never waits on the network.
      const deckId = session.deckId;
      queueWrite(() => updateDoc(doc(db, 'users', uid, 'decks', deckId), { lastStudied: now }),
        'FlashcardsPage: lastStudied write failed');
      updateDecks(prev => prev.map(d => d.id === deckId ? { ...d, lastStudied: now } : d));
    }
    setSession(null);
    // On mobile the topbar is hidden, so the contentArea's scrollTop from
    // the session can leave the masthead above the visible viewport when
    // returning to the main page. requestAnimationFrame defers until after
    // the next browser paint so iOS scroll restoration has already run —
    // this reliably wins the reset race.
    if (isMobile) {
      requestAnimationFrame(() => {
        const el = document.querySelector('.content-pad');
        if (el) el.scrollTop = 0;
      });
    }
    // The deferral notices are worked out live in App from the cards in
    // memory (DF-D6), so nothing needs re-running here.
  }, [uid, session, updateDecks]);

  // ── Delete decks ──────────────────────────────────────────
  const handleDeleteDecks = useCallback(async (deckIds) => {
    if (!uid) return;
    setManaging(false);
    const deckIdSet = new Set(deckIds);
    // P5: a card that's also in a deck you're keeping only leaves
    // the deleted decks, with its review history (Cleanup's rule); a card in
    // no other deck is deleted, as before.
    const inDeleted = (cards || []).filter(c => (c.deckIds || []).some(id => deckIdSet.has(id)));
    const toDelete  = [];
    const toMove    = new Map(); // card id → remaining deck ids
    for (const c of inDeleted) {
      const remaining = (c.deckIds || []).filter(id => !deckIdSet.has(id));
      if (remaining.length) toMove.set(c.id, remaining);
      else toDelete.push(c);
    }

    let batch = writeBatch(db);
    let ops   = 0;
    const flush = async () => {
      if (ops === 0) return;
      await batch.commit();
      batch = writeBatch(db);
      ops   = 0;
    };

    for (const card of toDelete) {
      batch.delete(doc(db, 'users', uid, 'flashcards', card.id));
      ops++;
      if (ops >= 490) await flush();
    }
    for (const [cardId, remaining] of toMove) {
      batch.update(doc(db, 'users', uid, 'flashcards', cardId), withCardStamp({ deckIds: remaining }));
      ops++;
      if (ops >= 490) await flush();
    }
    for (const deckId of deckIds) {
      batch.delete(doc(db, 'users', uid, 'decks', deckId));
      ops++;
      if (ops >= 490) await flush();
    }
    await flush();

    const deleted = new Set(toDelete.map(c => c.id));
    updateCards(prev => prev
      ? prev.filter(c => !deleted.has(c.id)).map(c => toMove.has(c.id) ? { ...c, deckIds: toMove.get(c.id) } : c)
      : prev);
    updateDecks(prev => prev.filter(d => !deckIdSet.has(d.id)));
  }, [uid, cards, updateCards, updateDecks]);

  // ── Cleanup orphaned / backless cards + resync backs ──────
  const handleCleanup = useCallback(async () => {
    if (!uid) return;

    // Decks sharing one name (a rename onto a title that already had a
    // deck) are merged first, so the passes below see one deck per source.
    let mergeNote = null;
    try {
      const merged = await mergeSameNameDecks({ uid, updateCards, updateDecks });
      if (merged?.merges?.length) {
        const names = merged.merges.map(m => `“${m.name}”`).join(', ');
        mergeNote = `Merged duplicate deck${merged.merges.length !== 1 ? 's' : ''} ${names} (${merged.moved} card${merged.moved !== 1 ? 's' : ''} moved in`
          + (merged.duplicates ? `, ${merged.duplicates} duplicate${merged.duplicates !== 1 ? 's' : ''} removed)` : ')');
      }
    } catch (e) {
      console.error('Flashcards: duplicate deck merge failed', e);
    }

    // S5: decks are read fresh along with the cards. The in-memory list can
    // miss a deck made on another device since the last refresh, and every
    // card in it then looked "orphaned" and was deleted.
    let allCardsForCleanup, deckIdSet, freshDecks;
    try {
      const [snap, deckSnap] = await Promise.all([
        getDocs(collection(db, 'users', uid, 'flashcards')),
        getDocs(collection(db, 'users', uid, 'decks')),
      ]);
      allCardsForCleanup = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      deckIdSet = new Set([...deckSnap.docs.map(d => d.id), ...decks.map(d => d.id)]);
      freshDecks = deckSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
      console.error('Flashcards: cleanup read failed', e);
      return;
    }

    // SD-D8: a word carded separately in two books of one series becomes
    // one card in both decks (the one with more review history). Backless
    // cards are left to the pass below.
    let shareNote = null;
    try {
      const sharePlan = planSeriesShare(allCardsForCleanup.filter(c => c.back), buildSeriesGroups(aviSources, freshDecks));
      if (sharePlan.deletes.length || sharePlan.cardUpdates.length) {
        await applySeriesShare({ uid, plan: sharePlan, updateCards, updateDecks });
        const shareDeleted = new Set(sharePlan.deletes);
        const shareMoved   = new Map(sharePlan.cardUpdates.map(u => [u.id, u.deckIds]));
        allCardsForCleanup = allCardsForCleanup
          .filter(c => !shareDeleted.has(c.id))
          .map(c => shareMoved.has(c.id) ? { ...c, deckIds: shareMoved.get(c.id) } : c);
        shareNote = `${sharePlan.words} word${sharePlan.words !== 1 ? 's' : ''} now shared across a series`;
      }
    } catch (e) {
      console.error('Flashcards: series card share failed', e);
    }

    const toDelete = allCardsForCleanup.filter(c => {
      if (c.type === 'grammar') return false;
      const isBackless = c.back === '' || c.back == null;
      const isOrphaned = !(c.deckIds || []).some(id => deckIdSet.has(id));
      return isBackless || isOrphaned;
    });

    // ── Duplicate cards: one card per word per deck (cardDedupe, shared
    // with the Lemma Master merge and Word Input corrections). The
    // survivor keeps the older review history (reviewed over new, then
    // earliest createdAt, then id). A duplicate that is also in other decks
    // only leaves this deck (before: it was skipped, so the duplicate
    // stayed). Deck totalCards is decremented for these removals, since
    // unlike backless/orphaned cards they live in real decks.
    const deletingIds = new Set(toDelete.map(c => c.id));
    const dupPlan = planCardDedupe(
      allCardsForCleanup.filter(c => !deletingIds.has(c.id)),
      { deckIds: [...deckIdSet] },
    );
    const byIdForCleanup = new Map(allCardsForCleanup.map(c => [c.id, c]));
    for (const id of dupPlan.deletes) {
      deletingIds.add(id);
      toDelete.push(byIdForCleanup.get(id));
    }
    const deckLeaves     = dupPlan.deckUpdates;
    const deckDecrements = dupPlan.decrements;

    // ── Resync card backs from Lemma Master (def2 → back) ─────
    // Repairs cards whose back has drifted from their lemma's Definition 2.
    // The def2 edit cascade historically updated only cards matching one
    // linkedAVILemmaId, so a lemma whose cards carry different IDs kept an
    // old back on the cards the edit missed. Source of truth mirrors the
    // cascade and cardFactory: a card's back is its lemma's def2. Entries
    // without a def2 are skipped (never blank a back — the backless filter
    // above deletes those), grammar cards are untouched, and the matching
    // entry also repairs linkedAVILemmaId so future ID lookups converge.
    // LD-D5: the entry picker and the back rule are the ones the Dev
    // Dashboard's Def2 resync uses (def2Cascade), so the two tools agree.
    const resyncPairs = [];
    try {
      const lmSnap = await getDocs(collection(db, 'users', uid, 'lemmaMaster'));
      const bestByNorm = pickEntriesByNorm(lmSnap.docs.map(d => d.data()));
      for (const c of allCardsForCleanup) {
        if (c.type === 'grammar' || !c.lemma || deletingIds.has(c.id)) continue;
        const entry = bestByNorm.get(normalizeLemma(c.lemma));
        const u = entry ? def2CardUpdate(c, entry.def2) : null;
        if (!u) continue;
        if (entry.lemmaID && c.linkedAVILemmaId !== entry.lemmaID) u.linkedAVILemmaId = entry.lemmaID;
        resyncPairs.push([c.id, u]);
      }
    } catch (e) {
      console.error('Flashcards: def resync failed', e);
    }

    if (!toDelete.length && !resyncPairs.length && !deckLeaves.length) {
      const earlyNotes = [mergeNote, shareNote].filter(Boolean);
      setCleanupResult(earlyNotes.length ? `${earlyNotes.join(' · ')}.` : 'Nothing to clean up.');
      setTimeout(() => setCleanupResult(null), 5000);
      return;
    }

    let batch = writeBatch(db);
    let ops   = 0;
    const flush = async () => {
      if (ops === 0) return;
      await batch.commit();
      batch = writeBatch(db);
      ops   = 0;
    };

    for (const card of toDelete) {
      batch.delete(doc(db, 'users', uid, 'flashcards', card.id));
      ops++;
      if (ops >= 490) await flush();
    }
    for (const [cardId, u] of resyncPairs) {
      batch.update(doc(db, 'users', uid, 'flashcards', cardId), withCardStamp(u));
      ops++;
      if (ops >= 490) await flush();
    }
    for (const { id, deckIds } of deckLeaves) {
      batch.update(doc(db, 'users', uid, 'flashcards', id), withCardStamp({ deckIds }));
      ops++;
      if (ops >= 490) await flush();
    }
    for (const [deckId, n] of deckDecrements) {
      batch.update(doc(db, 'users', uid, 'decks', deckId), { totalCards: increment(-n) });
      ops++;
      if (ops >= 490) await flush();
    }
    await flush();

    const toDeleteIds = new Set(toDelete.map(c => c.id));
    const resyncById  = new Map(resyncPairs);
    const leaveById   = new Map(deckLeaves.map(u => [u.id, u.deckIds]));
    updateCards(prev => prev
      ? prev
          .filter(c => !toDeleteIds.has(c.id))
          .map(c => resyncById.has(c.id) ? { ...c, ...resyncById.get(c.id) } : c)
          .map(c => leaveById.has(c.id) ? { ...c, deckIds: leaveById.get(c.id) } : c)
      : prev);
    if (deckDecrements.size) {
      updateDecks(prev => prev.map(d =>
        deckDecrements.has(d.id)
          ? { ...d, totalCards: Math.max(0, (d.totalCards || 0) - deckDecrements.get(d.id)) }
          : d
      ));
    }
    const doneParts = [mergeNote, shareNote].filter(Boolean);
    if (toDelete.length)    doneParts.push(`${toDelete.length} card${toDelete.length !== 1 ? 's' : ''} removed`);
    if (deckLeaves.length)  doneParts.push(`${deckLeaves.length} duplicate${deckLeaves.length !== 1 ? 's' : ''} taken out of a deck`);
    if (resyncPairs.length) doneParts.push(`${resyncPairs.length} back${resyncPairs.length !== 1 ? 's' : ''} resynced`);
    setCleanupResult(doneParts.join(' · ') + '.');
    setTimeout(() => setCleanupResult(null), 5000);
  }, [uid, decks, updateCards, updateDecks, aviSources]);

  // ── Resync Grammar ─────────────────────────────────────────
  // Re-pushes explanation/examples from each grammar entry to its linked card
  // (covers cards that predate the dedicated explanation/examples fields) and
  // regenerates per-sentence example audio. Throttled like the TTS backfill,
  // since each entry can mean several TTS calls.
  const handleResyncGrammar = useCallback(async () => {
    if (!uid || !grammarEntries?.length || !cards?.length) return;
    setResyncing(true);
    let count = 0;
    for (const entry of grammarEntries) {
      const card = cards.find(c => c.type === 'grammar' && c.linkedGrammarEntryId === entry.id);
      if (!card) continue;
      const explanation = entry.explanation || '';
      const examples    = entry.examples    || '';
      try {
        await updateDoc(doc(db, 'users', uid, 'flashcards', card.id), withCardStamp({ explanation, examples, notes: null }));
        updateCards(prev => prev ? prev.map(c => c.id === card.id ? { ...c, explanation, examples, notes: null } : c) : prev);
        await generateGrammarCardAudio({
          examples, cardId: card.id, uid,
          onComplete: (exampleAudio) => updateCards(prev => prev ? prev.map(c => c.id === card.id ? { ...c, exampleAudio } : c) : prev),
        });      } catch (e) {
        console.error(`Resync Grammar: card ${card.id} failed`, e);
      }
      count++;
      await new Promise(r => setTimeout(r, 150));
    }
    setResyncing(false);
    setResyncResult(count);
    setTimeout(() => setResyncResult(null), 5000);
  }, [uid, grammarEntries, cards, updateCards]);

  // ── Loading state ─────────────────────────────────────────
  if (fcLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '300px', color: C.textM, fontSize: '13px' }}>
        Loading flashcards…
      </div>
    );
  }

  // ── Active session ────────────────────────────────────────
  if (session) {
    return (
      <ReviewSession
        manualCards={session.manualCards || []}
        dueCards={session.dueCards}
        newCards={session.newCards}
        extraCards={session.extraCards}
        deferredCards={session.deferredCards || []}
        deferredOnly={!!session.deferredOnly}
        nextDueDate={session.nextDueDate}
        onGrade={handleGrade}
        onEnd={handleEndSession}
        soundProfile={soundProfile}
        onNavigateToGrammar={onNavigateToGrammar}
        fsrsSettings={fsrsSettings}
        settings={settings}
        reversed={session.reversed}
        contextIndex={contextIndex}
        C={C} S={S}
      />
    );
  }

  // ── Total due across all cards ────────────────────────────
  const totalDue = enrichedCards
    ? enrichedCards.filter(c => c.type !== 'grammar' && isDueToday(c, dsh ?? 3) && !isCardPaused(c)).length
    : null;

  const virtualDecks = [
    { id: 'all',           name: 'All Cards' },
    { id: 'all_words',     name: 'All Words' },
    { id: 'all_sentences', name: 'All Sentences' },
  ];

  const cardsLoaded = enrichedCards !== null;

  return (
    // paddingTop on mobile ensures the masthead is never flush against the
    // top edge of the scroll container. The app uses black-translucent status
    // bar (index.html), so content renders edge-to-edge. Without this buffer
    // any zoom-induced visual viewport shift hides the masthead instantly.
    <div className="fade-up" style={isMobile ? { paddingTop: '24px' } : undefined}>

      {/* Masthead */}
      <GazetteMasthead
        cornerLeft={{
          value: totalDue ?? 0,
          label: 'Due Today',
          onClick: totalDue > 0 ? () => startSession('all') : undefined,
        }}
        cornerRight={{
          // DF-D12: cards deferred right now (the backlog), and how many the
          // cap moved this morning. Until the forecast is ready, this
          // morning's count.
          value: deferralForecast?.backlog ?? srsSnapshot?.triaged ?? 0,
          label: srsSnapshot?.triaged > 0 ? `Deferred · ${srsSnapshot.triaged} today` : 'Deferred',
          // DF3: opens the 연기된 카드 round across every deck, once the live
          // count is in and above 0.
          onClick: deferralForecast?.backlog > 0 ? () => startSession('deferred') : undefined,
        }}
        title="The Recaller Review"
        isMobile={isMobile}
      />
      <GoldRule />
      <BylineRule left="autovocaindex / flashcards" right={todayStr} />

      {/* Deferral notices (DF-D3 to DF-D5), in the spike flags' old place */}
      <DeferralNotices
        forecast={deferralForecast}
        wrapStyle={{ marginBottom: '20px', display: 'flex', flexDirection: 'column', gap: '8px', width: 'fit-content' }}
      />

      {/* Review heatmap */}
      <div style={{ marginBottom: '28px' }}>
        <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.textM, marginBottom: '12px' }}>
          Reviews
        </div>
        <ActivityHeatmap
          data={reviewLog}
          color={C.warning}
          today={todayStr}
          windowEndYM={reviewHeatmapEndYM}
          onWindowChange={handleHeatmapWindowChange}
          itemLabel="reviews"
        />
      </div>

      <RecordsStrip items={recordsItems} isMobile={isMobile} />

      {/* Caps the deck grids at 4 cards wide (220px + 12px gap each) so Recent/Decks
          stay compact and centered instead of stretching to fill the viewport.
          Collections and Grammar keep their existing internal column behavior,
          just relative to this width. Kept separate from the header/heatmap above
          so the heatmap can render at full page width without horizontal scrolling. */}
      <div style={{ maxWidth: 'calc(4 * 220px + 3 * 12px)', margin: '0 auto' }}>

      {/* Recent decks */}
      {recentDecks.length > 0 && (
        <div style={{ marginBottom: '28px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.textM, marginBottom: '12px' }}>
            Recent
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, 220px)', justifyContent: 'center', gap: '12px' }}>
            {recentDecks.map(deck => (
              <DeckCard
                key={deck.id}
                deck={deck}
                totalCount={deckCardTotal(deck)}
                dueCount={cardsLoaded ? (deckStats[deck.id]?.due ?? null) : null}
                newCount={cardsLoaded ? (deckStats[deck.id]?.new ?? null) : null}
                masteryBreakdown={null}
                lastStudied={deck.lastStudied ? formatLastStudied(deck.lastStudied, dsh ?? 3) : null}
                onClick={() => cardsLoaded ? startSession(deck.id) : null}
                onSelectCards={deck.id === 'deck_grammar' ? () => setShowGrammarPicker(true) : null}
                onTogglePause={handleTogglePause}
                onEcho={onEchoDeck ? (d) => onEchoDeck(d.id) : null}
                onToggleReverse={handleToggleReverse}
                C={C} S={S}
              />
            ))}
          </div>
          {!cardsLoaded && (
            <div style={{ fontSize: '11px', color: C.textM, marginTop: '8px', textAlign: 'center' }}>
              Loading cards…
            </div>
          )}
        </div>
      )}

      {/* Virtual decks */}
      <div style={{ marginBottom: '28px' }}>
        <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.textM, marginBottom: '12px' }}>
          Collections
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
          {virtualDecks.map(vd => (
            <DeckCard
              key={vd.id}
              deck={vd}
              totalCount={null}
              lastStudied={null}
              onClick={() => cardsLoaded ? startSession(vd.id) : null}
              C={C} S={S}
            />
          ))}
        </div>
        {!cardsLoaded && (
          <div style={{ fontSize: '11px', color: C.textM, marginTop: '8px', textAlign: 'center' }}>
            Loading cards…
          </div>
        )}
      </div>

        {/* Grammar deck */}
      {decks.some(d => d.id === 'deck_grammar') && (() => {
        const grammarDeck = decks.find(d => d.id === 'deck_grammar');
        return (
          <div style={{ marginBottom: '28px' }}>
            <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.textM, marginBottom: '12px' }}>
              Grammar
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(3, 1fr)', gap: '12px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <DeckCard
                  deck={grammarDeck}
                  totalCount={grammarDeck.totalCards ?? null}
                  dueCount={null}
                  newCount={null}
                  masteryBreakdown={grammarMasteryCounts || null}
                  lastStudied={grammarDeck.lastStudied ? formatLastStudied(grammarDeck.lastStudied, dsh ?? 3) : null}
                  onClick={() => cardsLoaded ? startSession('deck_grammar') : null}
                  C={C} S={S}
                />
                <button
                  style={{ ...S.btnGhost, fontSize: '11px', opacity: cardsLoaded ? 1 : 0.4 }}
                  disabled={!cardsLoaded}
                  onClick={() => setShowGrammarPicker(true)}
                >
                  Select cards to study
                </button>
              </div>
              {/* Desktop: column 2 left empty — the Dispatches box reads better at
                  single-column width (matching its Content Library counterpart) than
                  stretched across two columns. Mobile: two columns, no empty gap. */}
              <div style={{ gridColumn: isMobile ? '2 / 3' : '3 / 4' }}>
                <GazetteBox title="Dispatches">
                  <div style={{ fontSize: '10px', letterSpacing: '0.08em', textTransform: 'uppercase', color: C.accent, marginBottom: '6px' }}>Recent Grammar</div>
                  {recentGrammarReviews.length === 0 ? (
                    <div style={{ fontSize: '12px', color: C.textM, fontStyle: 'italic' }}>No grammar cards reviewed yet.</div>
                  ) : recentGrammarReviews.map(({ entry, reviewDate }) => (
                    <BoxRow key={entry.id} label={entry.glossaryTerm} value={reviewDate} />
                  ))}
                </GazetteBox>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Series decks (SD-D3): above the books' own decks */}
      {shownSeriesDecks.length > 0 && (
        <div style={{ marginBottom: '28px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.textM, marginBottom: '12px' }}>
            Series
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, 220px)', justifyContent: 'center', gap: '12px' }}>
            {shownSeriesDecks.map(sd => (
              <DeckCard
                key={sd.id}
                deck={sd}
                totalCount={cardsLoaded ? (seriesStats[sd.id]?.total ?? 0) : null}
                dueCount={cardsLoaded ? (seriesStats[sd.id]?.due ?? 0) : null}
                newCount={cardsLoaded ? (seriesStats[sd.id]?.new ?? 0) : null}
                masteryBreakdown={null}
                lastStudied={null}
                onClick={() => cardsLoaded ? startSession(sd.id) : null}
                onEcho={onEchoDeck ? (d) => onEchoDeck(d.id) : null}
                C={C} S={S}
              />
            ))}
          </div>
        </div>
      )}

      {/* Named decks */}
      {shownDecks.length > 0 && (
        <div>
          <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.textM, marginBottom: '12px' }}>
            Decks
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, 220px)', justifyContent: 'center', gap: '12px' }}>
            {shownDecks.map(deck => (
              <DeckCard
                key={deck.id}
                deck={deck}
                totalCount={deckCardTotal(deck)}
                dueCount={cardsLoaded ? (deckStats[deck.id]?.due ?? 0) : null}
                newCount={cardsLoaded ? (deckStats[deck.id]?.new ?? 0) : null}
                masteryBreakdown={null}
                lastStudied={deck.lastStudied ? formatLastStudied(deck.lastStudied, dsh ?? 3) : null}
                onClick={() => cardsLoaded ? startSession(deck.id) : null}
                onTogglePause={handleTogglePause}
                onEcho={onEchoDeck ? (d) => onEchoDeck(d.id) : null}
                onToggleReverse={handleToggleReverse}
                C={C} S={S}
              />
            ))}
          </div>
          {!cardsLoaded && (
            <div style={{ fontSize: '11px', color: C.textM, marginTop: '8px', textAlign: 'center' }}>
              Loading cards…
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {decks.length === 0 && (
        <div style={S.emptyState}>
          No decks yet. Approve items from the AVI queue to get started.
        </div>
      )}

      {/* Deck management */}
      <div style={{ marginTop: '32px', marginBottom: isMobile ? '72px' : 0 }}>
        {cleanupResult !== null && (
          <div style={{ ...S.infoBox, marginBottom: '12px', textAlign: 'center' }}>
            {cleanupResult}
          </div>
        )}
        {resyncResult !== null && (
          <div style={{ ...S.infoBox, marginBottom: '12px', textAlign: 'center' }}>
            {resyncResult} grammar card{resyncResult !== 1 ? 's' : ''} resynced.
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', gap: isMobile ? '8px' : '12px' }}>
          <button
            style={{ ...S.btnGhost, fontSize: isMobile ? '11px' : '12px', whiteSpace: 'nowrap', ...(isMobile && { padding: '7px 10px' }) }}
            onClick={() => setManaging(true)}
          >
            Manage Decks
          </button>
          <button
            style={{ ...S.btnGhost, fontSize: isMobile ? '11px' : '12px', whiteSpace: 'nowrap', opacity: cards ? 1 : 0.4, ...(isMobile && { padding: '7px 10px' }) }}
            disabled={!cards}
            onClick={handleCleanup}
          >
            Clean up cards
          </button>
          <button
            style={{ ...S.btnGhost, fontSize: isMobile ? '11px' : '12px', whiteSpace: 'nowrap', opacity: (resyncing || !grammarEntries?.length) ? 0.4 : 1, ...(isMobile && { padding: '7px 10px' }) }}
            disabled={resyncing || !grammarEntries?.length}
            onClick={handleResyncGrammar}
          >
            {resyncing ? 'Resyncing…' : 'Resync Grammar'}
          </button>
        </div>
      </div>

      </div>

      {managing && (
        <DeckManager
          decks={decks}
          cards={cards}
          onDelete={handleDeleteDecks}
          onClose={() => setManaging(false)}
          C={C} S={S}
        />
      )}

      {showGrammarPicker && (
        <GrammarCardPicker
          mode="modal"
          entries={grammarEntries || []}
          cards={cards || []}
          onStudySelected={(cardIds) => { setShowGrammarPicker(false); startManualSession(cardIds); }}
          onClose={() => setShowGrammarPicker(false)}
        />
      )}
    </div>
  );
}
