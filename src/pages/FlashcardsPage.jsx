// src/pages/FlashcardsPage.jsx
import { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  collection, getDocs, getDoc, doc, updateDoc, writeBatch, setDoc, increment,
  query, where, documentId,
} from 'firebase/firestore';
import { db, auth } from '../firebase.js';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { useKeyShortcuts } from '../hooks/useKeyShortcuts.js';
import { SH } from '../theme/buildStyles.js';
import {
  fsrsGrade, isDueToday, isNewCard, triageBucket, compressInterval,
  getDueDateStr, AGAIN, FSRS_DEFAULTS,
} from '../utils/fsrs.js';
import { playSound } from '../utils/soundEngine.js';
import { getLogicalDateStr } from '../utils/dateUtils.js';
import { runSpikeForecast } from '../utils/srsEngine.js';
import { ActivityHeatmap, shiftMonth } from '../components/ActivityHeatmap.jsx';
import { applyReviewToStats, getEffectiveCurrentStreak, EMPTY_REVIEW_STATS } from '../utils/reviewStatsEngine.js';
import { GazetteBox, BoxRow, GazetteMasthead, GoldRule, BylineRule, RecordsStrip, fmtRecordDate, fmtMonthLabel, fmtWeekRange } from '../components/GazetteComponents.jsx';
import { Icons } from '../components/Icons.jsx';
import { playCardAudio, playAudioUrl, generateGrammarCardAudio } from '../utils/ttsUtils.js';
import { GrammarCardPicker } from '../components/GrammarCardPicker.jsx';
import { GRAMMAR_MASTERY } from '../constants.js';
import { DEMO } from '../demo/demoConfig.js';

// Adjust in Settings once that field is wired up.
const NEW_CARDS_PER_SESSION = 10;

// Grade-confirmation pulse: how long the chosen grade button animates before
// the card advances. Overlapped with the Firestore write, so it only adds
// latency when the write is faster than this. Keep in sync with the
// `.grade-pulse` CSS animation duration in buildStyles.js.
const GRADE_ANIM_MS = 220;

const isMobile = typeof window !== 'undefined' && window.innerWidth <= 700;

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
//
// Again-queue logic:
//   - Pressing Again re-queues the card at the back of the current phase queue.
//   - If a card's Again count reaches the cap (from settings), it is carried over:
//     its 'due' is already set to the past by fsrsGrade, so it surfaces first next session.
//   - Boundary screens only appear once the phase queue (including any Again cards) is empty.
//   - When the session is ended manually, any Again'd cards still in the queue are already
//     written to Firestore with due=past, so they surface at the next session start.

function ReviewSession({ manualCards = [], dueCards, newCards, extraCards, nextDueDate,
  onGrade, onEnd, soundProfile, onNavigateToGrammar, fsrsSettings, settings, reversed = false, C, S }) {

  const AGAIN_CAP = DEMO ? 1 : (fsrsSettings?.againCap ?? FSRS_DEFAULTS.againCap);

  const initialPhase = manualCards.length > 0 ? 'manual' : dueCards.length > 0 ? 'due' : 'opening_boundary';
  const [phase,            setPhase]            = useState(initialPhase);
  const [queue,            setQueue]            = useState(() => manualCards.length > 0 ? [...manualCards] : dueCards.length > 0 ? [...dueCards] : []);
  const [againCounts,      setAgainCounts]      = useState({}); // cardId -> Again count this phase
  const [revealed,         setRevealed]         = useState(false);
  const [revealedSections, setRevealedSections] = useState({});
  const [gradedRating,     setGradedRating]     = useState(null); // rating whose button is pulsing

  // Session stats
  const [successCount, setSuccessCount] = useState(0); // cards resolved with non-Again grade
  const [againTotal,   setAgainTotal]   = useState(0); // total Again presses
  const [carriedOver,  setCarriedOver]  = useState(0); // cards that hit the cap

  const card = queue[0];

  // ── TTS audio state ───────────────────────────────────────
  // playingKey is null (nothing playing), 'main' (the whole-card button), or
  // an example-sentence index — only one clip plays at a time regardless of source.
  const [playingKey,   setPlayingKey]   = useState(null);
  const cancelAudioRef = useRef(null);
  const gradingRef     = useRef(false); // true while a grade is resolving; reset on next flip

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
    setAgainCounts({});
    setRevealed(false);
    setRevealedSections({});
    if (newPhase === 'due')   setQueue([...dueCards]);
    if (newPhase === 'new')   setQueue([...newCards]);
    if (newPhase === 'extra') setQueue([...extraCards]);
  }, [dueCards, newCards, extraCards]);

  const transitionPhase = useCallback((currentPhase) => {
    setRevealed(false);
    setRevealedSections({});
    if (currentPhase === 'manual') {
      if (dueCards.length > 0 || extraCards.length > 0) setPhase('boundary_manual');
      else setPhase('finished');
    } else if (currentPhase === 'due') {
      if (newCards.length > 0 || extraCards.length > 0) setPhase('boundary_1_2');
      else setPhase('finished');
    } else if (currentPhase === 'new') {
      if (extraCards.length > 0) setPhase('boundary_2_3');
      else setPhase('finished');
    } else {
      setPhase('finished');
    }
  }, [dueCards.length, newCards.length, extraCards.length]);

  const handleGrade = useCallback(async (rating) => {
    if (!card || gradingRef.current) return;
    gradingRef.current = true;
    setGradedRating(rating);         // pulse the chosen grade button
    playSound(soundProfile || 'chirp');

    // onGrade writes to Firestore and returns the updated card object.
    // Overlap the write with the pulse window so the animation is visible
    // before the card advances (total wait is the max of the two, not the sum).
    const [updatedCard] = await Promise.all([
      onGrade(card, rating),
      new Promise((resolve) => setTimeout(resolve, GRADE_ANIM_MS)),
    ]);

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

  const inReview = !!card && ['manual', 'due', 'new', 'extra'].includes(phase);

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
  const onBoundary = ['opening_boundary', 'boundary_manual', 'boundary_1_2', 'boundary_2_3', 'finished'].includes(phase);

  const advanceBoundary = useCallback(() => {
    if (phase === 'opening_boundary' || phase === 'boundary_1_2') {
      if (newCards.length > 0) startPhase('new');
      else if (extraCards.length > 0) startPhase('extra');
      else onEnd();
    } else if (phase === 'boundary_manual') {
      if (dueCards.length > 0) startPhase('due');
      else if (extraCards.length > 0) startPhase('extra');
      else onEnd();
    } else if (phase === 'boundary_2_3') {
      if (extraCards.length > 0) startPhase('extra');
      else onEnd();
    } else {
      onEnd(); // finished → Done
    }
  }, [phase, newCards.length, dueCards.length, extraCards.length, startPhase, onEnd]);

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
    if (!isMobile) return;
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
  }, [phase]);

  // Clear any fling transform once the next card mounts, so it appears centred
  // (paired with the swipe fling in onEnd above). No-op for non-swipe advances,
  // where the transform is already empty. Runs before paint to avoid a flash.
  useLayoutEffect(() => {
    const el = cardElRef.current;
    if (!el) return;
    el.style.transition = '';
    el.style.transform = '';
    el.style.opacity = '';
  }, [cardId]);

  // ── Finished ─────────────────────────────────────────────
  if (phase === 'finished') {
    const total = successCount + carriedOver;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '400px', gap: '20px' }} className="fade-up">
        <div style={{ fontFamily: SH.fd, fontSize: '28px', color: C.text }}>Session complete</div>
        <div style={{ display: 'flex', gap: '24px' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontFamily: SH.fm, fontSize: '24px', color: C.accent }}>{successCount}</div>
            <div style={{ fontSize: '11px', color: C.textM, marginTop: '4px' }}>reviewed</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontFamily: SH.fm, fontSize: '24px', color: C.danger }}>{againTotal}</div>
            <div style={{ fontSize: '11px', color: C.textM, marginTop: '4px' }}>again</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontFamily: SH.fm, fontSize: '24px', color: C.textM }}>{carriedOver}</div>
            <div style={{ fontSize: '11px', color: C.textM, marginTop: '4px' }}>carried over</div>
          </div>
        </div>
        <button style={S.btnPrimary} onClick={onEnd}>Done</button>
      </div>
    );
  }

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
          {extraCards.length > 0 && (
            <button style={S.btnGhost} onClick={() => startPhase('extra')}>
              Browse full deck
            </button>
          )}
          <button style={{ ...S.btnGhost, opacity: 0.7 }} onClick={onEnd}>End</button>
        </div>
      </div>
    );
  }

  // ── Boundary: after manually-selected cards ───────────────
  if (phase === 'boundary_manual') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '400px', gap: '16px', maxWidth: '480px', margin: '0 auto' }} className="fade-up">
        <div style={{ fontFamily: SH.fd, fontSize: '22px', fontWeight: 300, fontStyle: 'italic', color: C.text, textAlign: 'center' }}>
          Selected cards complete
        </div>
        <div style={{ fontSize: '13px', color: C.textM, textAlign: 'center' }}>
          {manualCards.length} card{manualCards.length !== 1 ? 's' : ''} reviewed
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '100%', maxWidth: '280px', marginTop: '8px' }}>
          {dueCards.length > 0 && (
            <button style={S.btnPrimary} onClick={() => startPhase('due')}>
              Continue to {dueCards.length} due card{dueCards.length !== 1 ? 's' : ''}
            </button>
          )}
          {extraCards.length > 0 && (
            <button style={S.btnGhost} onClick={() => startPhase('extra')}>
              {dueCards.length > 0 ? 'Skip to full deck' : 'Continue to full deck'}
            </button>
          )}
          <button style={{ ...S.btnGhost, opacity: 0.7 }} onClick={onEnd}>End session</button>
        </div>
      </div>
    );
  }

  // ── Boundary: after due phase ─────────────────────────────
  if (phase === 'boundary_1_2') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '400px', gap: '16px', maxWidth: '480px', margin: '0 auto' }} className="fade-up">
        <div style={{ fontFamily: SH.fd, fontSize: '22px', fontWeight: 300, fontStyle: 'italic', color: C.text, textAlign: 'center' }}>
          Due cards complete
        </div>
        <div style={{ fontSize: '13px', color: C.textM, textAlign: 'center' }}>
          {dueCards.length} card{dueCards.length !== 1 ? 's' : ''} reviewed
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '100%', maxWidth: '280px', marginTop: '8px' }}>
          {newCards.length > 0 && (
            <button style={S.btnPrimary} onClick={() => startPhase('new')}>
              Study {newCards.length} new card{newCards.length !== 1 ? 's' : ''}
            </button>
          )}
          {extraCards.length > 0 && (
            <button style={S.btnGhost} onClick={() => startPhase('extra')}>
              {newCards.length > 0 ? 'Skip to full deck' : 'Continue to full deck'}
            </button>
          )}
          <button style={{ ...S.btnGhost, opacity: 0.7 }} onClick={onEnd}>End session</button>
        </div>
      </div>
    );
  }

  // ── Boundary: after new cards phase ──────────────────────
  if (phase === 'boundary_2_3') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '400px', gap: '16px', maxWidth: '480px', margin: '0 auto' }} className="fade-up">
        <div style={{ fontFamily: SH.fd, fontSize: '22px', fontWeight: 300, fontStyle: 'italic', color: C.text, textAlign: 'center' }}>
          New cards complete
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '100%', maxWidth: '280px', marginTop: '8px' }}>
          {extraCards.length > 0 && (
            <button style={S.btnPrimary} onClick={() => startPhase('extra')}>
              Continue to full deck
            </button>
          )}
          <button style={{ ...S.btnGhost, opacity: 0.7 }} onClick={onEnd}>End session</button>
        </div>
      </div>
    );
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

  const phaseLabel = phase === 'manual' ? 'Selected' : phase === 'due' ? 'Due today' : phase === 'new' ? 'New' : 'Full deck';
  // Show the original phase array length as the total, not the (growing) queue length.
  // This prevents the progress indicator from jumping when Again cards are re-queued.
  const phaseTotal    = phase === 'manual' ? manualCards.length : phase === 'due' ? dueCards.length : phase === 'new' ? newCards.length : extraCards.length;
  const phaseResolved = phase === 'manual'
    ? successCount + carriedOver
    : phase === 'due'
    ? (successCount + carriedOver) - manualCards.length
    : phase === 'new'
    ? (successCount + carriedOver) - manualCards.length - dueCards.length  // subtract manual + due-phase resolutions
    : (successCount + carriedOver) - manualCards.length - dueCards.length - newCards.length;
  const phaseProgress = Math.min(Math.max(phaseResolved, 0) + 1, phaseTotal);

  // Per-card Again indicator
  const cardAgainCount = againCounts[card.id] || 0;

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
    </div>
  );
}

// ── Deck card ─────────────────────────────────────────────────
function DeckCard({ deck, totalCount, dueCount, newCount, masteryBreakdown, lastStudied, onClick, onSelectCards, onTogglePause, onToggleReverse, C, S }) {
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

      {type === 'word' && (onTogglePause || onToggleReverse) && (
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
          {lastStudied && (
            <span style={{ fontSize: '11px', color: C.textM, marginLeft: 'auto' }}>{lastStudied}</span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Deck manager ──────────────────────────────────────────────
function DeckManager({ decks, onDelete, onClose, C, S }) {
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

  // Both returns portal to document.body — DeckManager mounts inside
  // FlashcardsPage's `.fade-up` wrapper, whose persistent transform creates a
  // containing block that would trap these fixed overlays.
  if (confirming) {
    return createPortal(
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
        <div style={{ background: C.surface, borderRadius: '16px', padding: '28px', maxWidth: '480px', width: '100%' }}>
          <div style={{ fontFamily: SH.fd, fontSize: '20px', fontWeight: 300, color: C.text, marginBottom: '6px' }}>Confirm deletion</div>
          <p style={{ fontSize: '13px', color: C.textM, marginBottom: '16px', lineHeight: 1.6 }}>
            The following deck{selectedDecks.length !== 1 ? 's' : ''} and all their cards will be permanently deleted:
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '8px' }}>
            {selectedDecks.map(d => (
              <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', borderRadius: '8px', background: `${C.danger}0d`, border: `1px solid ${C.danger}44` }}>
                <span style={{ fontSize: '13px', color: C.text, fontFamily: SH.fk }}>{d.name}</span>
                <span style={{ fontSize: '11px', color: C.textM }}>{d.totalCards || 0} cards</span>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: C.textM, padding: '4px 12px', marginBottom: '20px' }}>
            <span>Total</span>
            <span>{totalCards} cards</span>
          </div>
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
export function FlashcardsPage({ soundProfile, dsh, addTask, tasks, onNavigateToGrammar, cards, decks, fcLoading, updateCards, updateDecks, grammarMasteryCounts, grammarEntries, flashcardStudyTarget, setFlashcardStudyTarget, fsrsSettings = {}, srsSnapshot = {}, onPipelineResult, settings = {} }) {
  const { C, S } = useAppTheme();
  const [session,           setSession]           = useState(null);
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
  const reviewStatsRef = useRef(EMPTY_REVIEW_STATS);

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
  useEffect(() => {
    if (!uid) return;
    getDoc(doc(db, 'users', uid, 'settings', 'reviewStats'))
      .then(snap => {
        const loaded = snap.exists() ? snap.data() : EMPTY_REVIEW_STATS;
        reviewStatsRef.current = loaded;
        setReviewStats(loaded);
      })
      .catch(e => console.error('FlashcardsPage: reviewStats load failed', e));
  }, [uid]);

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
  }, [uid, cards]);

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

  // ── Pause state (Phase D2) ────────────────────────────────
  // A card counts as paused only when every deck it belongs to is paused; a
  // card still live in any active deck keeps surfacing.
  const pausedDeckIds = useMemo(() => new Set(decks.filter(d => d.paused).map(d => d.id)), [decks]);
  const isCardPaused = useCallback(
    (c) => !!(c.deckIds?.length && c.deckIds.every(id => pausedDeckIds.has(id))),
    [pausedDeckIds],
  );

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
        if (!stats[id]) stats[id] = { due: 0, new: 0 };
        if (isDueToday(c, dsh ?? 3))    stats[id].due++;
        else if (isNewCard(c)) stats[id].new++;
      });
    });
    return stats;
  }, [enrichedCards, dsh]);

  // ── Recently studied decks (up to 4, sorted by lastStudied desc) ─
  const recentDecks = useMemo(() => {
    return [...decks]
      .filter(d => !!d.lastStudied)
      .sort((a, b) => b.lastStudied.localeCompare(a.lastStudied))
      .slice(0, 4);
  }, [decks]);

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
    if (deckId === 'all')            pool = enrichedCards.filter(c => c.type !== 'grammar' && !isCardPaused(c));
    else if (deckId === 'all_words') pool = enrichedCards.filter(c => c.type === 'vocab' && !isCardPaused(c));
    else if (deckId === 'all_sentences') pool = enrichedCards.filter(c => c.type === 'sentence' && !isCardPaused(c));
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

    setSession({ deckId, dueCards: due, newCards, extraCards: extra, nextDueDate, reversed });
  }, [enrichedCards, dsh, decks, isCardPaused]);

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
  const handleGrade = useCallback(async (card, rating) => {
    if (!uid) return null;

    if (card.type === 'grammar') {
      const now     = new Date().toISOString();
      const history = [...(card.gapEvents || []), { date: now, grade: rating }].slice(-100);
      const updates = { due: null, lastReview: now, lastGrade: rating, reps: (card.reps || 0) + 1, gapEvents: history };
      if (DEMO) return { ...card, ...updates }; // demo: inert grading — nothing persists (D5)
      await updateDoc(doc(db, 'users', uid, 'flashcards', card.id), updates);
      updateCards(prev => prev ? prev.map(c => c.id === card.id ? { ...c, ...updates } : c) : prev);
      return { ...card, ...updates };
    }

    const updates = fsrsGrade(card, rating, fsrsSettings);
    if (DEMO) return { ...card, ...updates }; // demo: inert grading — no card write, no reviewLog, no reviewStats (D5)
    await updateDoc(doc(db, 'users', uid, 'flashcards', card.id), updates);
    updateCards(prev => prev ? prev.map(c => c.id === card.id ? { ...c, ...updates } : c) : prev);

    const logDate     = getLogicalDateStr(dsh ?? 3);
    const newDayCount = (reviewLogRef.current[logDate] || 0) + 1;
    setDoc(doc(db, 'users', uid, 'reviewLog', logDate), { count: increment(1) }, { merge: true })
      .catch(e => console.error('reviewLog write failed', e));
    reviewLogRef.current = { ...reviewLogRef.current, [logDate]: newDayCount };
    setReviewLog(reviewLogRef.current);

    const newStats = applyReviewToStats(reviewStatsRef.current, logDate, newDayCount, dsh ?? 3);
    setDoc(doc(db, 'users', uid, 'settings', 'reviewStats'), newStats)
      .catch(e => console.error('reviewStats write failed', e));
    reviewStatsRef.current = newStats;
    setReviewStats(newStats);

    return { ...card, ...updates };
  }, [uid, updateCards, fsrsSettings, dsh]);

  // ── End a session ─────────────────────────────────────────
  // Again cards still in the queue when the session ends are already written to
  // Firestore with due=past (from when Again was pressed), so they surface first
  // at the next session start with no additional writes needed.
  const handleEndSession = useCallback(async () => {
    if (!DEMO && uid && session?.deckId && !['all', 'all_words', 'all_sentences'].includes(session.deckId)) {
      const now = new Date().toISOString();
      await updateDoc(doc(db, 'users', uid, 'decks', session.deckId), { lastStudied: now });
      updateDecks(prev => prev.map(d => d.id === session.deckId ? { ...d, lastStudied: now } : d));
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
    }    // Re-run spike forecast with the post-session card state so that any large
    // batch of new cards reviewed today is immediately factored into the 7-day forecast.
    if (!DEMO && uid && cards && session?.deckId !== 'deck_grammar') {
      try {
        const result = await runSpikeForecast(uid, cards, dsh || 3, addTask, tasks || [], [...pausedDeckIds]);
        if (onPipelineResult) onPipelineResult(result);
      } catch (e) {
        console.error('FlashcardsPage: post-session spike forecast failed', e);
      }
    }
  }, [uid, session, updateDecks, cards, dsh, addTask, tasks, onPipelineResult, pausedDeckIds]);

  // ── Delete decks ──────────────────────────────────────────
  const handleDeleteDecks = useCallback(async (deckIds) => {
    if (!uid) return;
    setManaging(false);
    const deckIdSet = new Set(deckIds);
    const toDelete  = (cards || []).filter(c => (c.deckIds || []).some(id => deckIdSet.has(id)));

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
    for (const deckId of deckIds) {
      batch.delete(doc(db, 'users', uid, 'decks', deckId));
      ops++;
      if (ops >= 490) await flush();
    }
    await flush();

    updateCards(prev => prev ? prev.filter(c => !(c.deckIds || []).some(id => deckIdSet.has(id))) : prev);
    updateDecks(prev => prev.filter(d => !deckIdSet.has(d.id)));
  }, [uid, cards, updateCards, updateDecks]);

  // ── Cleanup orphaned / backless cards ─────────────────────
  const handleCleanup = useCallback(async () => {
    if (!uid) return;
    const deckIdSet = new Set(decks.map(d => d.id));

    let allCardsForCleanup;
    try {
      const snap = await getDocs(collection(db, 'users', uid, 'flashcards'));
      allCardsForCleanup = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
      console.error('Flashcards: cleanup read failed', e);
      return;
    }

    const toDelete = allCardsForCleanup.filter(c => {
      if (c.type === 'grammar') return false;
      const isBackless = c.back === '' || c.back == null;
      const isOrphaned = !(c.deckIds || []).some(id => deckIdSet.has(id));
      return isBackless || isOrphaned;
    });

    if (!toDelete.length) {
      setCleanupResult(0);
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
    await flush();

    const toDeleteIds = new Set(toDelete.map(c => c.id));
    updateCards(prev => prev ? prev.filter(c => !toDeleteIds.has(c.id)) : prev);
    setCleanupResult(toDelete.length);
    setTimeout(() => setCleanupResult(null), 5000);
  }, [uid, decks, updateCards]);

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
        await updateDoc(doc(db, 'users', uid, 'flashcards', card.id), { explanation, examples, notes: null });
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
        nextDueDate={session.nextDueDate}
        onGrade={handleGrade}
        onEnd={handleEndSession}
        soundProfile={soundProfile}
        onNavigateToGrammar={onNavigateToGrammar}
        fsrsSettings={fsrsSettings}
        settings={settings}
        reversed={session.reversed}
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
          value: srsSnapshot?.triaged ?? 0,
          label: srsSnapshot?.spikeDetected ? 'Triaged · Spike Flagged' : 'Triaged',
        }}
        title="The Recaller Review"
        isMobile={isMobile}
      />
      <GoldRule />
      <BylineRule left="autovocaindex / flashcards" right={todayStr} />

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
                totalCount={deck.totalCards ?? null}
                dueCount={cardsLoaded ? (deckStats[deck.id]?.due ?? null) : null}
                newCount={cardsLoaded ? (deckStats[deck.id]?.new ?? null) : null}
                masteryBreakdown={null}
                lastStudied={deck.lastStudied ? formatLastStudied(deck.lastStudied, dsh ?? 3) : null}
                onClick={() => cardsLoaded ? startSession(deck.id) : null}
                onSelectCards={deck.id === 'deck_grammar' ? () => setShowGrammarPicker(true) : null}
                onTogglePause={handleTogglePause}
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
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
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
              {/* Column 2 left empty — the Dispatches box reads better at single-column
                  width (matching its Content Library counterpart) than stretched across
                  two columns. */}
              <div style={{ gridColumn: '3 / 4' }}>
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

      {/* Named decks */}
      {decks.filter(d => d.id !== 'deck_grammar').length > 0 && (
        <div>
          <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.textM, marginBottom: '12px' }}>
            Decks
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, 220px)', justifyContent: 'center', gap: '12px' }}>
            {decks.filter(d => d.id !== 'deck_grammar').map(deck => (
              <DeckCard
                key={deck.id}
                deck={deck}
                totalCount={deck.totalCards ?? null}
                dueCount={cardsLoaded ? (deckStats[deck.id]?.due ?? 0) : null}
                newCount={cardsLoaded ? (deckStats[deck.id]?.new ?? 0) : null}
                masteryBreakdown={null}
                lastStudied={deck.lastStudied ? formatLastStudied(deck.lastStudied, dsh ?? 3) : null}
                onClick={() => cardsLoaded ? startSession(deck.id) : null}
                onTogglePause={handleTogglePause}
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
            {cleanupResult === 0
              ? 'Nothing to clean up.'
              : `${cleanupResult} card${cleanupResult !== 1 ? 's' : ''} removed.`
            }
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
