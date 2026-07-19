// src/pages/QuizzesPage.jsx
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  collection, getDocs, addDoc, updateDoc, setDoc, query, orderBy, getDoc, doc as fsDoc,
} from 'firebase/firestore';
import { db, auth } from '../firebase.js';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { SH, frameBevel } from '../theme/buildStyles.js';
import { playSound, playQuizCompleteSound } from '../utils/soundEngine.js';
import { createCorrectionNote } from '../utils/createCorrectionNote.js';
import {
  buildGrammarDrillPayload,
  buildGrammarAssessmentPayload,
  callGrammarQuizAPI,
  parseDrillQuestions,
  parseGrammarAssessment,
} from '../utils/grammarQuizUtils.js';
import {
  computeVocaBaseCredit, computeClozeCredit, applyHintPenalty,
  getVocaHints, isTwoSynonymFront, normalizeFrontForMatching,
  formatScore, computeRelatedCredit, findClozeTokenIndex,
} from '../utils/jamoUtils.js';
import { toDateStr, getLogicalToday } from '../utils/dateUtils.js';
import { getQuizLeadStory } from '../utils/headlineEngine.js';
import { crowSrc as CrowImg, decoBlockStyle } from '../utils/decoAssets.js';
import { PaginationFooter } from '../components/PaginationFooter.jsx';
import { useGlobalKey } from '../hooks/useGlobalKey.js';
import { DEMO, DEMO_LIMIT_NOTE, demoCapReached } from '../demo/demoConfig.js';
import { usePaginationKeys } from '../hooks/usePaginationKeys.js';
import {
  GazetteMasthead, GoldRule, BylineRule, GazetteKicker, GazetteHeadline,
  GazetteStandfirst, DropCapLead, GazetteFig, GazetteBox, BoxRow, GazetteSplitFig,
} from '../components/GazetteComponents.jsx';

// Module-level ref updated by QuizzesPage on every render, so all sub-components
// in this file share the quiz-sounds enabled state without prop drilling.
const _quizSoundsRef = { current: true };
function quizSound(name)          { if (_quizSoundsRef.current) playSound(name); }
function quizCompleteSound(score) { if (_quizSoundsRef.current) playQuizCompleteSound(score); }

// ── Constants ─────────────────────────────────────────────────
const GRAMMAR_DECK_ID    = 'deck_grammar';
const VOCA_CONFIG_KEY    = 'avi_quiz_voca_config';
const CLOZE_CONFIG_KEY = 'avi_quiz_cloze_config';
const CLOZE_DEFAULTS = {
  deckIds:       [], // empty = all sentence mining decks
  questionCount: 10,
  mode:          'type', // 'type' | 'select'
  choiceCount:   4,
};
const GRAMMAR_CONFIG_KEY = 'avi_quiz_grammar_config';
const isMobile = typeof window !== 'undefined' && window.innerWidth <= 700;
const RC_PAGE_SIZE = 5; // Session Log rows per page (similar height to By the Numbers box beside it)

// ── Config persistence ────────────────────────────────────────
function loadConfig(key, defaults) {
  try {
    const s = localStorage.getItem(key);
    return s ? { ...defaults, ...JSON.parse(s) } : defaults;
  } catch { return defaults; }
}
function saveConfig(key, config) {
  try { localStorage.setItem(key, JSON.stringify(config)); } catch {}
}

// ── Helpers ───────────────────────────────────────────────────
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function isGrammarDeck(deck) {
  return deck.id === GRAMMAR_DECK_ID || deck.type === 'grammar';
}

// ── Confetti ──────────────────────────────────────────────────
function Confetti({ active }) {
  const canvasRef = useRef(null);
  const animRef   = useRef(null);

  useEffect(() => {
    if (!active) {
      cancelAnimationFrame(animRef.current);
      const ctx = canvasRef.current?.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;

    const COLORS  = ['#F5B800','#c97d3a','#8fb4a8','#b85f25','#7a9e6e','#ffffff','#e8c870','#d4a06a'];
    const GLITTER = ['#fffbe0','#fff5a0','#ffe060','#ffffff'];
    const particles = [];

    for (let i = 0; i < 140; i++) {
      particles.push({
        x: Math.random() * canvas.width, y: Math.random() * canvas.height * -0.3 - 10,
        vx: (Math.random() - 0.5) * 4, vy: Math.random() * 3 + 2,
        rot: Math.random() * 360, vr: (Math.random() - 0.5) * 8,
        w: Math.random() * 8 + 4, h: Math.random() * 5 + 3,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        alpha: 1, glitter: false,
      });
    }
    for (let i = 0; i < 80; i++) {
      particles.push({
        x: Math.random() * canvas.width, y: Math.random() * canvas.height * -0.5,
        vx: (Math.random() - 0.5) * 2, vy: Math.random() * 2 + 1,
        rot: 0, vr: 0, w: Math.random() * 4 + 1, h: Math.random() * 4 + 1,
        color: GLITTER[Math.floor(Math.random() * GLITTER.length)],
        alpha: 1, glitter: true,
      });
    }

    const tick = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let alive = false;
      for (const p of particles) {
        p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.vy += 0.05; p.alpha -= 0.004;
        if (p.alpha <= 0) continue;
        alive = true;
        ctx.save();
        ctx.globalAlpha = p.alpha;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot * Math.PI / 180);
        ctx.fillStyle = p.color;
        if (p.glitter) { ctx.beginPath(); ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2); ctx.fill(); }
        else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (alive) animRef.current = requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
  }, [active]);

  if (!active) return null;
  return <canvas ref={canvasRef} style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 500 }} />;
}

// ── UI primitives ─────────────────────────────────────────────
function ToggleChip({ label, active, onClick, C }) {
  // Single-bevel frame (B-1 Deploy 3) — matches the app-wide chip language.
  return (
    <button onClick={onClick} style={{
      padding: '3px 9px', fontSize: '12.5px', fontWeight: 500,
      cursor: 'pointer', transition: 'color 0.15s, background 0.15s',
      border: '4px solid transparent', borderRadius: 0,
      borderImageSource: frameBevel(active ? C.accent : C.border),
      borderImageSlice: 6, borderImageWidth: '5px', borderImageRepeat: 'stretch',
      background: active ? C.accentSoft : 'transparent', backgroundClip: 'padding-box',
      color: active ? C.accent : C.textS,
    }}>
      {label}
    </button>
  );
}

function Stepper({ value, onChange, min, max, C }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
      <button onClick={() => onChange(Math.max(min, value - 1))} style={{
        width: '28px', height: '28px', borderRadius: '6px', border: `1px solid ${C.border}`,
        background: 'transparent', color: C.textS, fontSize: '16px', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>−</button>
      <span style={{ fontFamily: SH.fm, fontSize: '16px', color: C.text, minWidth: '28px', textAlign: 'center' }}>{value}</span>
      <button onClick={() => onChange(Math.min(max, value + 1))} style={{
        width: '28px', height: '28px', borderRadius: '6px', border: `1px solid ${C.border}`,
        background: 'transparent', color: C.textS, fontSize: '16px', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>+</button>
    </div>
  );
}

function ConfigRow({ label, children, C, noBorder, alignStart }) {
  return (
    <div style={{
      display: 'flex', flexDirection: isMobile ? 'column' : 'row',
      alignItems: isMobile ? 'stretch' : (alignStart ? 'flex-start' : 'flex-start'),
      justifyContent: 'space-between',
      gap: isMobile ? '8px' : '20px', padding: '14px 0',
      borderBottom: noBorder ? 'none' : `1px solid ${C.border}`,
    }}>
      <div style={{ fontSize: '13px', color: C.textS, paddingTop: isMobile ? 0 : '5px', minWidth: isMobile ? 0 : '120px', flexShrink: 0 }}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: isMobile ? 'flex-start' : 'flex-end' }}>{children}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// VOCA QUIZ CONFIG
// ─────────────────────────────────────────────────────────────
const VOCA_DEFAULTS = {
  questionTypes:   ['multiple'],
  typeCounts:                 { multiple: 10, truefalse: 5, matching: 1, type: 5 },
  answerFormat:    'term',
  choiceCount:     4,
  deckIds:         [],
  instantFeedback: true,
};

// Compute total question count from typeCounts, treating 1 matching set = 10 questions
function computeTotal(types, typeCounts) {
  let total = 0;
  if (types.includes('multiple'))  total += typeCounts.multiple  || 0;
  if (types.includes('truefalse')) total += typeCounts.truefalse || 0;
  if (types.includes('type'))      total += typeCounts.type      || 0;
  if (types.includes('matching'))  total += (typeCounts.matching || 0) * 10;
  return total;
}

function VocaQuizConfig({ open, decks, onStart, onBack, apiKey, C, S }) {
  const [config, setConfig] = useState(() => loadConfig(VOCA_CONFIG_KEY, VOCA_DEFAULTS));

  const set = (key, val) => setConfig(prev => {
    const next = { ...prev, [key]: val };
    saveConfig(VOCA_CONFIG_KEY, next);
    return next;
  });

  const setTypeCount = (typeKey, val) => setConfig(prev => {
    const next = { ...prev, typeCounts: { ...prev.typeCounts, [typeKey]: val } };
    saveConfig(VOCA_CONFIG_KEY, next);
    return next;
  });

  const toggleType = (type) => {
    const types = config.questionTypes || ['multiple'];
    const next = types.includes(type)
      ? types.filter(t => t !== type)
      : [...types, type];
    // Must have at least one type
    if (next.length === 0) return;
    set('questionTypes', next);
  };

  const toggleDeck = (id) => {
    set('deckIds', config.deckIds.includes(id)
      ? config.deckIds.filter(d => d !== id)
      : [...config.deckIds, id]);
  };

  const types      = config.questionTypes || ['multiple'];
  const typeCounts = config.typeCounts    || VOCA_DEFAULTS.typeCounts;
  const total       = computeTotal(types, typeCounts);
  const hasType     = types.includes('type');
  const hasMCOrTF   = types.includes('multiple') || types.includes('truefalse');
  const hasLinear   = hasMCOrTF || hasType;
  const hasMatching = types.includes('matching');
    // "My answer is" only applies when MC or TF is active (Type always asks for Korean)
  const showAnswerFormat = hasMCOrTF;

  const vocaDecks = decks.filter(d => !isGrammarDeck(d));
  const canStart  = vocaDecks.length > 0;

  if (!open) return null;

  return createPortal(
    <div style={S.overlay} onClick={e => { if (e.target === e.currentTarget) onBack(); }}>
      <div style={S.modal} className="slide-up">
        <div style={{ ...S.modalHeader, marginBottom: '16px' }}>
          <span style={S.modalTitle}>Vocabulary Quiz</span>
          <button
            onClick={onBack}
            style={{ background: 'none', border: 'none', color: C.textM, cursor: 'pointer', fontSize: '18px', padding: '2px' }}
          >
            ✕
          </button>
        </div>

        <div style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '16px', padding: '0 20px', marginBottom: '20px' }}>

          {/* Total questions — read-only summary */}
          <ConfigRow label="Questions" C={C}>
            <span style={{ fontFamily: SH.fm, fontSize: '16px', color: C.text }}>{total}</span>
          </ConfigRow>

          {/* Question types — multi-select with inline per-type steppers */}
          <div style={{ padding: '14px 0', borderBottom: `1px solid ${C.border}` }}>
            <div style={{
              display: 'flex', flexDirection: isMobile ? 'column' : 'row',
              justifyContent: 'space-between', alignItems: isMobile ? 'stretch' : 'flex-start',
              gap: isMobile ? '8px' : '20px',
            }}>
              <div style={{ fontSize: '13px', color: C.textS, paddingTop: isMobile ? 0 : '5px', minWidth: isMobile ? 0 : '120px', flexShrink: 0 }}>Question type</div>
              {/* Mobile rows (Stage A-5): one full-width line per type — chip
                  left, stepper right — so nothing wraps unpredictably on
                  narrow screens. Desktop keeps its right-aligned chip column:
                  chips are first in the DOM, and row-reverse restores the
                  stepper-then-chip visual order there. */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', alignItems: isMobile ? 'stretch' : 'flex-end' }}>
                {/* Multiple choice chip + stepper */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', ...(isMobile ? { justifyContent: 'space-between' } : { flexDirection: 'row-reverse', flexWrap: 'wrap' }) }}>
                  <ToggleChip
                    label="Multiple choice"
                    active={types.includes('multiple')}
                    onClick={() => toggleType('multiple')}
                    C={C}
                  />
                  {types.includes('multiple') && (
                    <Stepper
                      value={typeCounts.multiple || 10}
                      onChange={v => setTypeCount('multiple', v)}
                      min={1} max={50} C={C}
                    />
                  )}
                </div>

                {/* True/False chip + stepper */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', ...(isMobile ? { justifyContent: 'space-between' } : { flexDirection: 'row-reverse', flexWrap: 'wrap' }) }}>
                  <ToggleChip
                    label="True / False"
                    active={types.includes('truefalse')}
                    onClick={() => toggleType('truefalse')}
                    C={C}
                  />
                  {types.includes('truefalse') && (
                    <Stepper
                      value={typeCounts.truefalse || 5}
                      onChange={v => setTypeCount('truefalse', v)}
                      min={1} max={50} C={C}
                    />
                  )}
                </div>

                {/* True/Type chip + stepper */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', ...(isMobile ? { justifyContent: 'space-between' } : { flexDirection: 'row-reverse', flexWrap: 'wrap' }) }}>
                   <ToggleChip
                      label="Type"
                      active={types.includes('type')}
                      onClick={() => toggleType('type')}
                      C={C}
                   />
                   {types.includes('type') && (
                      <Stepper
                         value={typeCounts.type || 5}
                         onChange={v => setTypeCount('type', v)}
                         min={1} max={50} C={C}
                      />
                   )}
                </div>

                {/* Matching chip + stepper */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', ...(isMobile ? { justifyContent: 'space-between' } : { flexDirection: 'row-reverse', flexWrap: 'wrap' }) }}>
                   <ToggleChip
                      label="Matching"
                      active={types.includes('matching')}
                      onClick={() => toggleType('matching')}
                      C={C}
                   />
                   {types.includes('matching') && (
                      <div style={isMobile
                        ? { display: 'flex', flexDirection: 'column-reverse', alignItems: 'flex-end', gap: '4px' }
                        : { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }
                      }>
                                  <span style={{ fontSize: '11px', color: C.textM }}>1 set = 10 terms</span>
                                  <Stepper
                                     value={typeCounts.matching || 1}
                                     onChange={v => setTypeCount('matching', v)}
                                     min={1} max={5} C={C}
                                  />
                      </div>
                   )}
                </div>
             </div>
          </div>
       </div>

          {/* Answer options — only when multiple choice is active */}
          {types.includes('multiple') && (
            <ConfigRow label="Answer options" C={C}>
              {[2, 3, 4, 6].map(n => (
                <ToggleChip key={n} label={`${n} choices`} active={config.choiceCount === n} onClick={() => set('choiceCount', n)} C={C} />
              ))}
            </ConfigRow>
          )}

          {/* My answer is — only when MC or TF is active (Type always targets Korean) */}
          {showAnswerFormat && (
             <ConfigRow label="My answer is" C={C}>
              <ToggleChip label="The Korean term" active={config.answerFormat === 'term'}       onClick={() => set('answerFormat', 'term')}       C={C} />
              <ToggleChip label="The definition"  active={config.answerFormat === 'definition'} onClick={() => set('answerFormat', 'definition')} C={C} />
              <ToggleChip label="Both (mixed)"    active={config.answerFormat === 'both'}       onClick={() => set('answerFormat', 'both')}       C={C} />
            </ConfigRow>
          )}

          {!DEMO && vocaDecks.length > 0 && (
            <ConfigRow label="Card pools" C={C}>
              <ToggleChip label="All decks" active={config.deckIds.length === 0} onClick={() => set('deckIds', [])} C={C} />
              {vocaDecks.map(d => (
                <ToggleChip key={d.id} label={d.name} active={config.deckIds.includes(d.id)} onClick={() => toggleDeck(d.id)} C={C} />
              ))}
            </ConfigRow>
          )}

          {hasLinear && (
            <div style={{ padding: '14px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: '13px', color: C.textS }}>Instant feedback</div>
              <button
                onClick={() => set('instantFeedback', !config.instantFeedback)}
                style={{
                  width: '44px', height: '24px', borderRadius: '12px', border: 'none', cursor: 'pointer',
                  background: config.instantFeedback ? C.accent : C.border, position: 'relative', transition: 'background 0.2s',
                }}
              >
                <div style={{
                  position: 'absolute', top: '3px',
                  left: config.instantFeedback ? '23px' : '3px',
                  width: '18px', height: '18px', borderRadius: '50%',
                  background: '#fff', transition: 'left 0.2s',
                }} />
              </button>
            </div>
          )}

        {!canStart && (
          <div style={{ ...S.infoBox, marginBottom: '16px' }}>
            No vocabulary cards found. Add cards to a non-grammar deck first.
          </div>
        )}

        <button
          style={{ ...S.btnPrimary, width: '100%', justifyContent: 'center', padding: '12px', fontSize: '14px', opacity: canStart ? 1 : 0.5 }}
          onClick={() => canStart && onStart(config, vocaDecks)}
          disabled={!canStart}
        >
          Start Quiz
        </button>
      </div>
      </div>
    </div>,
    document.body
  );
}

// ─────────────────────────────────────────────────────────────
// WEIGHTED CARD SELECTION
// ─────────────────────────────────────────────────────────────
// Weight formula (applied within the selected pool):
//   easeFactor < 2.0                    → base weight 3
//   otherwise                           → base weight 1
//   lastGrade < 3 (and grade exists)    → weight × 2
//   no SM-2 history (repetitions === 0) → weight 1 (neutral)
function cardWeight(card) {
  const ef    = card.easeFactor  ?? 2.5;
  const grade = card.lastGrade;
  const reps  = card.repetitions ?? 0;
  if (reps === 0 || grade == null) return 1;
  const base = ef < 2.0 ? 3 : 1;
  return grade < 3 ? base * 2 : base;
}

// Weighted random sample of `n` cards without replacement.
// Demo (7D): user-created cards are guaranteed into the sample first;
// seeded cards fill the remainder through the weighted draw.
function weightedSample(cards, n) {
  if (DEMO) {
    const user = cards.filter(c => c && !c.seeded);
    if (user.length > 0 && user.length < cards.length) {
      if (user.length >= n) return weightedDraw(user, n);
      return shuffleArray([...user, ...weightedDraw(cards.filter(c => c && c.seeded), n - user.length)]);
    }
  }
  return weightedDraw(cards, n);
}

function weightedDraw(cards, n) {
  if (cards.length <= n) return shuffleArray(cards);
  const pool    = [...cards];
  const result  = [];
  for (let i = 0; i < n; i++) {
    const totalW = pool.reduce((s, c) => s + cardWeight(c), 0);
    let r = Math.random() * totalW;
    let idx = 0;
    for (; idx < pool.length - 1; idx++) {
      r -= cardWeight(pool[idx]);
      if (r <= 0) break;
    }
    result.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
// BUILD QUESTIONS
// ─────────────────────────────────────────────────────────────
function buildMultipleChoice(cards, config, count) {
  const len = count !== undefined ? count : (config.length || 10);
  if (cards.length < 2) return [];
  // Weighted sample for question cards; random distractors from full pool
  const pool = weightedSample(cards, len);
  return pool.map((card, idx) => {
    const wantTerm = config.answerFormat === 'term' ? true
      : config.answerFormat === 'definition' ? false
      : idx % 2 === 0;
    const prompt  = wantTerm ? (card.back || card.notes || '—') : (card.front || '—');
    const correct = wantTerm ? (card.front || '—')              : (card.back || card.notes || '—');
    const distractorCards = shuffleArray(cards.filter(c => c.id !== card.id))
      .slice(0, config.choiceCount - 1);
    const distractors = distractorCards
      .map(c => wantTerm ? (c.front || '—') : (c.back || c.notes || '—'));
    const choiceCardMap = {};
    choiceCardMap[correct] = card;
    distractorCards.forEach((c, i) => { choiceCardMap[distractors[i]] = c; });
    return {
      type: 'multiple', card, prompt, correct, wantTerm,
      choices: shuffleArray([correct, ...distractors]),
      choiceCardMap,
      answered: false, userAnswer: null, isCorrect: null,
    };
  });
}

function buildTrueFalse(cards, config, count) {
  const len = count !== undefined ? count : (config.length || 10);
  if (cards.length < 2) return [];
  // Weighted sample for question cards
  const pool = weightedSample(cards, len);
  return pool.map((card, idx) => {
    const wantTerm = config.answerFormat === 'term' ? true
      : config.answerFormat === 'definition' ? false
      : idx % 2 === 0;
    const isReal    = Math.random() > 0.5;
    const otherCard = shuffleArray(cards.filter(c => c.id !== card.id))[0];
    const term = card.front || '—';
    const defn = isReal
      ? (card.back || card.notes || '—')
      : (otherCard?.back || otherCard?.notes || '—');
    return {
      type: 'truefalse', card, otherCard: isReal ? null : (otherCard || null), term, defn, wantTerm,
      correct: isReal ? 'true' : 'false',
      choices: ['true', 'false'],
      answered: false, userAnswer: null, isCorrect: null,
    };
  });
}

function buildMatchingSet(cards) {
  if (cards.length < 2) return null;
  const pool  = shuffleArray(cards).slice(0, 10);
  const pairs = pool.map(card => ({
    id:   card.id,
    term: card.front || '—',
    defn: card.back || card.notes || '—',
  }));
  return {
    type:     'matching',
    pairs,
    terms:    shuffleArray(pairs.map(p => ({ id: p.id, text: p.term }))),
    defns:    shuffleArray(pairs.map(p => ({ id: p.id, text: p.defn }))),
    matched:  {},
    selected: null,
    done:     false,
  };
}

// ── Related lemma resolution ──────────────────────────────────
// Given a card and the full lemmaMaster array, returns arrays of lemma
// strings for the card's relatedForm and relatedMeaning entries.
// Used to pre-compute related-credit targets at question-build time.
function resolveRelatedLemmas(card, lemmaMaster) {
  if (!card || !lemmaMaster || lemmaMaster.length === 0) {
    return { relatedFormLemmas: [], relatedMeaningLemmas: [] };
  }
  const normStr = s => (s || '').trim().toLowerCase();
  let entry = null;
  if (card.linkedAVILemmaId) {
    entry = lemmaMaster.find(l => l.lemmaID === card.linkedAVILemmaId);
  }
  if (!entry && card.lemma) {
    entry = lemmaMaster.find(l => normStr(l.lemma) === normStr(card.lemma));
  }
  if (!entry) return { relatedFormLemmas: [], relatedMeaningLemmas: [] };

  const parseIds = str => (str || '').split(',').map(s => s.trim()).filter(Boolean);
  const idToLemma = id => lemmaMaster.find(l => l.lemmaID === id)?.lemma || null;

  return {
    relatedFormLemmas:    parseIds(entry.relatedForm).map(idToLemma).filter(Boolean),
    relatedMeaningLemmas: parseIds(entry.relatedMeaning).map(idToLemma).filter(Boolean),
  };
}

function buildVocaTypeQuestions(cards, count, lemmaMaster) {
  if (cards.length === 0) return [];
  const n    = Math.min(count, cards.length);
  const pool = weightedSample(cards, n);
  return pool.map(card => {
    const { relatedFormLemmas, relatedMeaningLemmas } = resolveRelatedLemmas(card, lemmaMaster);
    return {
      type:     'voca_type',
      card,
      term:     card.front || '—',
      defn:     card.back  || card.notes || '—',
      relatedFormLemmas,
      relatedMeaningLemmas,
      answered: false, userAnswer: null, isCorrect: null, credit: null,
    };
  });
}

// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// HARD MODE COMPONENTS
// ─────────────────────────────────────────────────────────────

// Shared bobbing-crow loading visual — used by HardModeLoading below and by
// the Quizzes home view's initial-load placeholder.
function CrowLoader({ size = 100 }) {
  const { C } = useAppTheme();
  return (
    <>
      <style>{`
        @keyframes crow-bob {
          0%, 100% { transform: translateY(0px) scaleX(-1); }
          50%       { transform: translateY(-6px) scaleX(-1); }
        }
      `}</style>
      <div style={{ animation: 'crow-bob 1.4s ease-in-out infinite' }}>
{CrowImg
          ? <img src={CrowImg} alt="" style={{ width: `${size}px`, height: `${size}px`, objectFit: 'contain' }} />
          : <div style={{ ...decoBlockStyle(C), width: `${size}px`, height: `${size}px` }} />}
      </div>
    </>
  );
}

// Loading screen: bobbing crow + static label
function HardModeLoading({ C }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', minHeight: '320px', gap: '20px',
    }}>
      <CrowLoader />
      <div style={{ fontSize: '13px', color: C.textM }}>Preparing quiz…</div>
    </div>
  );
}

// Fading flag that covers the progress bar when Hard Mode falls back to standard
function HardModeFailedFlag({ C }) {
  const [visible, setVisible] = useState(true);
  const [fading,  setFading]  = useState(false);

  useEffect(() => {
    const fadeTimer = setTimeout(() => setFading(true), 4000);
    const hideTimer = setTimeout(() => setVisible(false), 5000);
    return () => { clearTimeout(fadeTimer); clearTimeout(hideTimer); };
  }, []);

  if (!visible) return null;
  return (
    <div style={{
      position: 'absolute', top: 0, left: 0, right: 0,
      background: `${C.danger}ee`, borderRadius: '6px',
      padding: '4px 12px',
      display: 'flex', alignItems: 'center',
      transition: 'opacity 1s ease',
      opacity: fading ? 0 : 1,
      zIndex: 20,
      pointerEvents: 'none',
    }}>
      <span style={{ fontSize: '11px', color: '#fff', fontWeight: 500 }}>
        Hard Mode unavailable — using standard distractors.
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SESSION COMPONENTS
// ─────────────────────────────────────────────────────────────

// Progress: fills to 100% once the last answer is submitted (waiting=true on last q)
function SessionHeader({ idx, total, waiting, onEnd, C }) {
  const progress = total > 0 ? Math.min(((idx + (waiting ? 1 : 0)) / total) * 100, 100) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
      <div style={{ flex: 1, height: '4px', background: `${C.accent}22`, borderRadius: '2px' }}>
        <div style={{ height: '100%', width: `${progress}%`, background: C.accent, borderRadius: '2px', transition: 'width 0.3s' }} />
      </div>
      <span style={{ fontFamily: SH.fm, fontSize: '11px', color: C.textM }}>{idx + 1} / {total}</span>
      <button onClick={onEnd} style={{
        fontSize: '12px', color: C.textM, padding: '3px 10px', borderRadius: '6px',
        border: `1px solid ${C.border}`, background: 'transparent', cursor: 'pointer',
      }}>End</button>
    </div>
  );
}

// FeedbackPanel — used by MultipleChoiceQ
// Shows pairings only for the unused distractor choices (correct is already evident from the marigold highlight above)
function FeedbackPanel({ q, C }) {
  const { isCorrect, correct, choices, wantTerm, card, choiceCardMap, userAnswer } = q;

  // Unused choices = everything except the correct answer (which is already marked above)
  const unusedChoices = (choices || []).filter(c => c !== correct);

  return (
    <div style={{
      background: isCorrect ? `${C.warning}18` : `${C.danger}14`,
      border: `1px solid ${isCorrect ? C.warning : C.danger}44`,
      borderRadius: '12px', padding: '14px 16px', marginTop: '12px',
    }} className="fade-up quiz-session">
      <div style={{
        fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em',
        textTransform: 'uppercase', color: isCorrect ? C.warning : C.danger,
        marginBottom: unusedChoices.length > 0 ? '10px' : '0',
      }}>
        {isCorrect ? 'Correct' : `Incorrect — answer: ${correct}`}
      </div>

      {/* Pairings for each unused distractor */}
      {unusedChoices.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          {unusedChoices.map((choice, i) => {
            const sourceCard = choiceCardMap?.[choice];
            const pairedText = sourceCard
              ? (wantTerm
                  ? (sourceCard.back || sourceCard.notes || '—')   // choice is the term, show definition
                  : (sourceCard.front || '—'))                      // choice is the definition, show term
              : null;
            return (
              // One flowing text block per pairing (Stage A-5): the term and its
              // dash are bound together with nowrap so they never separate,
              // and wrapped definition lines hang-indent 16px under the first.
              // wantTerm decides which side of the dash is the Korean term.
              <div key={i} style={{
                fontSize: '12.5px', opacity: 0.7, lineHeight: 1.55,
                paddingLeft: '16px', textIndent: '-16px',
              }}>
                {wantTerm ? (
                  <>
                    <span style={{ whiteSpace: 'nowrap' }}>
                      <span style={{ fontFamily: SH.fk, color: C.textM }}>{choice}</span>
                      {pairedText && <span style={{ color: C.textM }}> —</span>}
                    </span>
                    {pairedText && <span style={{ color: C.textS }}> {pairedText}</span>}
                  </>
                ) : (
                  <>
                    <span style={{ color: C.textM }}>{choice}</span>
                    {pairedText && (
                      <span style={{ whiteSpace: 'nowrap' }}>
                        <span style={{ color: C.textM }}> — </span>
                        <span style={{ fontFamily: SH.fk, color: C.textS }}>{pairedText}</span>
                      </span>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Multiple choice ───────────────────────────────────────────
// Correct answer highlighted in marigold (C.warning), wrong in danger
// If user answered wrong, correct choice still gets the marigold bold outline
function MultipleChoiceQ({ q, config, onAnswer, C, S }) {
  const [submitted, setSubmitted] = useState(false);
  const [chosen,    setChosen]    = useState(null);

  const handleChoice = (choice) => {
    if (submitted) return;
    const isCorrect = choice === q.correct;
    setChosen(choice); setSubmitted(true);
    quizSound(isCorrect ? 'warble' : 'quiz_wrong');
    onAnswer(choice, isCorrect);
  };

  // Digit keys 1–N pick the corresponding choice before submission
  useGlobalKey(e => {
    const n = parseInt(e.key);
    if (!isNaN(n) && n >= 1 && n <= q.choices.length) handleChoice(q.choices[n - 1]);
  }, { enabled: !submitted });

  return (
    <>
      <div style={{
        background: C.raised, border: `1px solid ${C.border}`, borderRadius: '16px',
        padding: '28px 32px', minHeight: '90px',
        display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '12px',
      }}>
        <div style={{
          fontFamily: q.wantTerm ? 'inherit' : SH.fk,
          fontSize: q.wantTerm ? '18px' : '26px',
          color: C.text, textAlign: 'center', lineHeight: 1.4,
        }}>
          {q.prompt}
        </div>
      </div>
      <div style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textM, marginBottom: '10px' }}>
        {q.wantTerm ? 'Choose the Korean term' : 'Choose the definition'}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {q.choices.map((choice, i) => {
          let borderColor = C.border, bgColor = 'transparent', textColor = C.text, borderWidth = '1.5px';
          if (submitted) {
            if (choice === q.correct) {
              // Always show correct in marigold — whether user got it right or wrong
              borderColor = C.warning;
              bgColor     = `${C.warning}18`;
              textColor   = C.warning;
              borderWidth = chosen !== q.correct ? '2.5px' : '1.5px'; // bolder outline when user chose wrong
            } else if (choice === chosen) {
              borderColor = C.danger;
              bgColor     = `${C.danger}12`;
              textColor   = C.danger;
            } else {
              textColor = C.textM;
            }
          }
          return (
            <button key={i} onClick={() => handleChoice(choice)} style={{
              width: '100%', textAlign: 'left', padding: '13px 18px',
              borderRadius: '10px', border: `${borderWidth} solid ${borderColor}`,
              background: bgColor, color: textColor, fontSize: '13.5px',
              cursor: submitted ? 'default' : 'pointer', transition: 'all 0.15s',
              fontFamily: q.wantTerm ? SH.fk : 'inherit',
            }}>
              {choice}
            </button>
          );
        })}
      </div>
      {config.instantFeedback && submitted && (
        <FeedbackPanel q={{ ...q, userAnswer: chosen, isCorrect: chosen === q.correct }} C={C} />
      )}
    </>
  );
}

// ── True / False ──────────────────────────────────────────────
// Feedback logic:
//   correct=true  + chosen=true  → pair already fully visible in question card; show nothing extra
//   correct=true  + chosen=false → pair was real but user doubted it; show the pair as reminder
//   correct=false + chosen=false → user correctly identified false; show real defn of term + which term owns the shown defn
//   correct=false + chosen=true  → user missed the fake pair; show same as above
function TrueFalseFeedback({ q, chosen, C }) {
  const isCorrect      = chosen === q.correct;
  const pairWasReal    = q.correct === 'true';   // the shown term+defn is a real match
  const shownDefnWasWrong = q.correct === 'false'; // the shown defn doesn't belong to the shown term

  // Real definition of the shown term
  const realTerm = q.card?.front || q.term || '—';
  const realDefn = q.card?.back  || q.card?.notes || '—';

  // Which term actually owns the false definition (only relevant when defn was wrong)
  const shownDefnOwner = shownDefnWasWrong && q.otherCard
    ? (q.otherCard.front || '—')
    : null;

  // When the pair was real AND the user got it right: both pieces are already visible — nothing to add
  const nothingToAdd = pairWasReal && isCorrect;

  return (
    <div style={{
      background: isCorrect ? `${C.warning}18` : `${C.danger}14`,
      border: `1px solid ${isCorrect ? C.warning : C.danger}44`,
      borderRadius: '12px', padding: '14px 16px', marginTop: '12px',
    }} className="fade-up quiz-session">
      <div style={{
        fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em',
        textTransform: 'uppercase', color: isCorrect ? C.warning : C.danger,
        marginBottom: nothingToAdd ? 0 : '10px',
      }}>
        {isCorrect ? 'Correct' : `Incorrect — the answer is ${q.correct === 'true' ? '"True"' : '"False"'}`}
      </div>

      {!nothingToAdd && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>

          {/* Real definition of the shown term — show unless pair was real + correct (already visible) */}
          {!(pairWasReal && isCorrect) && (
            <>
              <div style={{ fontSize: '12px', color: C.textM, marginBottom: '2px' }}>
                {realTerm} means:
              </div>
              <div style={{
                fontSize: '13px', color: C.text, fontStyle: 'italic',
                padding: '6px 10px', background: `${C.warning}12`, borderRadius: '6px',
                borderLeft: `3px solid ${C.warning}`,
              }}>
                {realDefn}
              </div>
            </>
          )}

          {/* Which term owns the shown (false) definition */}
          {shownDefnWasWrong && shownDefnOwner && (
            <>
              <div style={{ fontSize: '12px', color: C.textM, marginTop: '8px', marginBottom: '2px' }}>
                "{q.defn}" is actually the definition of:
              </div>
              <div style={{
                fontSize: '13px', fontFamily: SH.fk, color: C.text,
                padding: '6px 10px', background: `${C.accent}0e`, borderRadius: '6px',
                borderLeft: `3px solid ${C.accent}`,
              }}>
                {shownDefnOwner}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function TrueFalseQ({ q, config, onAnswer, C }) {
  const [submitted, setSubmitted] = useState(false);
  const [chosen,    setChosen]    = useState(null);

  const handleChoice = (choice) => {
    if (submitted) return;
    const isCorrect = choice === q.correct;
    setChosen(choice); setSubmitted(true);
    quizSound(isCorrect ? 'warble' : 'quiz_wrong');
    onAnswer(choice, isCorrect);
  };

  // T/t/1 → True, F/f/2 → False (before submission)
  useGlobalKey(e => {
    if (e.key === 't' || e.key === 'T' || e.key === '1') handleChoice('true');
    else if (e.key === 'f' || e.key === 'F' || e.key === '2') handleChoice('false');
  }, { enabled: !submitted });

  return (
    <>
      <div style={{
        background: C.raised, border: `1px solid ${C.border}`, borderRadius: '16px',
        padding: '28px 32px', marginBottom: '16px',
        display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'center',
      }}>
        <div style={{ fontFamily: SH.fk, fontSize: '24px', color: C.text }}>{q.term}</div>
        <div style={{ fontSize: '11px', color: C.textM }}>means</div>
        <div style={{ fontSize: '16px', color: C.textS, fontStyle: 'italic', textAlign: 'center' }}>{q.defn}</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        {['true', 'false'].map(choice => {
          let borderColor = C.border, bgColor = 'transparent', textColor = C.text, borderWidth = '1.5px';
          if (submitted) {
            if (choice === q.correct) {
              borderColor = C.warning;
              bgColor     = `${C.warning}18`;
              textColor   = C.warning;
              borderWidth = chosen !== q.correct ? '2.5px' : '1.5px';
            } else if (choice === chosen) {
              borderColor = C.danger;
              bgColor     = `${C.danger}12`;
              textColor   = C.danger;
            } else {
              textColor = C.textM;
            }
          }
          return (
            <button key={choice} onClick={() => handleChoice(choice)} style={{
              padding: '16px', borderRadius: '10px', border: `${borderWidth} solid ${borderColor}`,
              background: bgColor, color: textColor, fontSize: '15px', fontWeight: 500,
              cursor: submitted ? 'default' : 'pointer', transition: 'all 0.15s',
            }}>
              {choice === 'true' ? 'True' : 'False'}
            </button>
          );
        })}
      </div>
      {config.instantFeedback && submitted && (
        <TrueFalseFeedback q={q} chosen={chosen} C={C} />
      )}
    </>
  );
}

// ── Matching ──────────────────────────────────────────────────
// No progress bar rendered here. The parent (VocaQuizSession) owns the single
// unified bar. onLiveCount(n) is called whenever the matched-pair count changes.
function MatchingQ({ matchSet: initialSet, onFinish, onLiveCount, C, S }) {
  const [ms,           setMs]           = useState(initialSet);
  const [showResults,  setShowResults]  = useState(false);
  const [finalMatched, setFinalMatched] = useState(null);

  const handleSelect = useCallback((id, side) => {
    setMs(prev => {
      if (prev.done) return prev;
      const sel = prev.selected;

      if (sel && sel.id === id && sel.side === side) return { ...prev, selected: null };
      if (!sel) return { ...prev, selected: { id, side } };
      if (sel.side === side) return { ...prev, selected: { id, side } };

      const termId = side === 'term' ? id : sel.id;
      const defnId = side === 'defn' ? id : sel.id;

      const newMatched = { ...prev.matched };
      Object.keys(newMatched).forEach(k => {
        if (k === termId || newMatched[k] === defnId) delete newMatched[k];
      });
      newMatched[termId] = defnId;

      const newCount = Object.keys(newMatched).length;
      onLiveCount?.(newCount);

      const allDone = prev.pairs.every(p => newMatched[p.id] !== undefined);
      if (allDone) {
        const correctCount = prev.pairs.filter(p => newMatched[p.id] === p.id).length;
        setTimeout(() => {
          quizSound(correctCount === prev.pairs.length ? 'warble' : 'quiz_wrong');
          setFinalMatched(newMatched);
          setShowResults(true);
        }, 400);
      }
      return { ...prev, matched: newMatched, selected: null, done: allDone };
    });
  }, [onLiveCount]);

  const handleBreakMatch = (termId) => {
    setMs(prev => {
      if (prev.done || prev.selected) return prev;
      const newMatched = { ...prev.matched };
      delete newMatched[termId];
      onLiveCount?.(Object.keys(newMatched).length);
      return { ...prev, matched: newMatched };
    });
  };

  const { pairs, terms, defns, matched, selected, done } = ms;

  const getTermStatus = (id) => {
    if (matched[id] !== undefined) {
      if (done) return matched[id] === id ? 'correct' : 'wrong';
      return 'matched';
    }
    if (selected?.id === id && selected?.side === 'term') return 'selected';
    return 'idle';
  };

  const getDefnStatus = (id) => {
    const matchedTermId = Object.keys(matched).find(k => matched[k] === id);
    if (matchedTermId !== undefined) {
      if (done) return matched[matchedTermId] === matchedTermId ? 'correct' : 'wrong';
      return 'matched';
    }
    if (selected?.id === id && selected?.side === 'defn') return 'selected';
    return 'idle';
  };

  const itemStyle = (status) => {
    const base = {
      padding: '9px 12px', borderRadius: '8px', fontSize: '13px',
      cursor: done ? 'default' : 'pointer', transition: 'all 0.15s',
      textAlign: 'left', width: '100%', display: 'block', lineHeight: 1.4,
    };
    if (status === 'selected') return { ...base, border: `2px solid ${C.accent}`,     background: C.accentSoft,          color: C.accent  };
    if (status === 'matched')  return { ...base, border: `1.5px solid ${C.accent}44`, background: `${C.accent}0e`,       color: C.textS   };
    if (status === 'correct')  return { ...base, border: `1.5px solid ${C.warning}`,  background: `${C.warning}18`,      color: C.warning, cursor: 'default' };
    if (status === 'wrong')    return { ...base, border: `1.5px solid ${C.danger}`,   background: `${C.danger}12`,       color: C.danger,  cursor: 'default' };
    return { ...base, border: `1px solid ${C.border}`, background: 'transparent', color: C.text };
  };

  const totalPairs = pairs.length;

  // Results panel — shown after all terms matched, stays until Continue pressed
  if (showResults && finalMatched) {
    const correctCount = pairs.filter(p => finalMatched[p.id] === p.id).length;
    const wrongPairs   = pairs.filter(p => finalMatched[p.id] !== p.id);

    return (
      <div className="fade-up quiz-session">
        <div style={{
          background: C.raised, border: `1px solid ${C.border}`, borderRadius: '12px',
          padding: '16px 20px', marginBottom: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ fontSize: '13px', color: C.textS }}>Matched correctly</div>
          <div style={{ fontFamily: SH.fm, fontSize: '20px', color: correctCount === totalPairs ? C.warning : C.accent }}>
            {correctCount} / {totalPairs}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', alignItems: 'start', marginBottom: '16px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {terms.map(item => {
              const status = finalMatched[item.id] === item.id ? 'correct' : 'wrong';
              return (
                <div key={item.id} style={{ ...itemStyle(status), fontFamily: SH.fk }}>
                  {item.text}
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {defns.map(item => {
              const matchedTermId = Object.keys(finalMatched).find(k => finalMatched[k] === item.id);
              const status = matchedTermId && finalMatched[matchedTermId] === matchedTermId ? 'correct' : 'wrong';
              return (
                <div key={item.id} style={itemStyle(status)}>
                  {item.text}
                </div>
              );
            })}
          </div>
        </div>

        {wrongPairs.length > 0 && (
          <div style={{ marginBottom: '16px' }}>
            <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textM, marginBottom: '10px' }}>
              Correct pairings
            </div>
            <div style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '12px', overflow: 'hidden' }}>
              {wrongPairs.map((p, i) => (
                <div key={p.id} style={{
                                  fontSize: '13px', lineHeight: 1.55, color: C.textM,
                                  padding: '10px 16px', paddingLeft: '32px', textIndent: '-16px',
                                  borderBottom: i < wrongPairs.length - 1 ? `1px solid ${C.border}` : 'none',
                                }}>
                                  <span style={{ whiteSpace: 'nowrap' }}>
                                    <span style={{ fontFamily: SH.fk, fontSize: '13.5px', color: C.text }}>{p.term}</span>
                                    <span> —</span>
                                  </span>
                                  {' '}{p.defn}
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            style={{ ...S.btnPrimary, padding: '10px 24px' }}
            onClick={() => onFinish(correctCount, totalPairs, wrongPairs)}
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fade-up quiz-session">
      <div style={{ fontSize: '12px', color: C.textM, marginBottom: '14px' }}>
        Click a term, then its definition to pair them. Click a paired item (with nothing else selected) to break the pair.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {terms.map(item => {
            const status = getTermStatus(item.id);
            return (
              <button
                key={item.id}
                onClick={() => {
                  if (done) return;
                  if (status === 'matched' && !selected) { handleBreakMatch(item.id); return; }
                  handleSelect(item.id, 'term');
                }}
                style={{ ...itemStyle(status), fontFamily: SH.fk }}
              >
                {item.text}
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {defns.map(item => {
            const status = getDefnStatus(item.id);
            return (
              <button
                key={item.id}
                onClick={() => { if (!done) handleSelect(item.id, 'defn'); }}
                style={itemStyle(status)}
              >
                {item.text}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Full session wrapper ───────────────────────────────────────
// Handles mixed question types: linear questions first (MC + TF interleaved),
// then matching sets at the end (always last)
// ── Full session wrapper ───────────────────────────────────────
// ONE unified sticky progress bar, owned entirely here.
// MatchingQ reports its live pair count via onLiveCount callback.
// Progress formula:
//   Linear phase  → questions.filter(answered).length          / grandTotal
//   Matching phase → linearTotal + matchTermsDone + matchLiveCount / grandTotal
function VocaQuizSession({ questions: initialQuestions, matchSets, config, onFinish, C, S }) {
  const [questions,      setQuestions]      = useState(initialQuestions);
  const [idx,            setIdx]            = useState(0);
  const [waiting,        setWaiting]        = useState(false);
  const [matchSetIdx,    setMatchSetIdx]    = useState(0);
  const [inMatchPhase,   setInMatchPhase]   = useState(false);
  const [matchCorrects,  setMatchCorrects]  = useState([]);
  const [matchMisses,    setMatchMisses]    = useState([]);  // missed pairs from finished sets (Stage A-4)
  const [matchTermsDone, setMatchTermsDone] = useState(0);  // pairs completed in finished sets
  const [matchLiveCount, setMatchLiveCount] = useState(0);  // pairs matched in current active set

  const types       = config.questionTypes || [config.questionType || 'multiple'];
  const hasMatching = types.includes('matching') && matchSets && matchSets.length > 0;
  const linearTotal = questions.length;

  const matchTermsTotal = hasMatching
    ? matchSets.reduce((s, ms) => s + ms.pairs.length, 0)
    : 0;

  // Grand total: every linear question + every matching term across all sets
  const grandTotal  = linearTotal + matchTermsTotal;
  const onlyMatching = linearTotal === 0 && hasMatching;

  // ── Progress ───────────────────────────────────────────────
  // Using answered count (not idx) means the bar hits 100% the instant
  // the last answer/pair is submitted, before any Next/Continue button.
  const linearAnswered = questions.filter(qu => qu.answered).length;
  const progressDone   = (inMatchPhase || onlyMatching)
    ? linearTotal + matchTermsDone + matchLiveCount
    : linearAnswered;
  const progressPct    = grandTotal > 0 ? Math.min((progressDone / grandTotal) * 100, 100) : 0;

  // Counter label
  const currentMatchSet = matchSets?.[matchSetIdx];
  const matchSetSuffix  = (matchSets?.length ?? 0) > 1 ? ` — set ${matchSetIdx + 1}` : '';
  const counterLabel    = (inMatchPhase || onlyMatching)
    ? `${matchLiveCount} / ${currentMatchSet?.pairs?.length ?? 0}${matchSetSuffix}`
    : `${linearAnswered} / ${grandTotal}`;

  // ── Single sticky progress bar rendered at top of every phase ──
  const StickyBar = (
    <div style={{
      position: 'sticky', top: 0, zIndex: 10,
      background: C.bg || C.surface || 'var(--bg, #f5ede4)',
      paddingBottom: '12px', paddingTop: '4px',
    }}>
      {/* relative wrapper so the failure flag can overlay the bar absolutely */}
      <div style={{ position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ flex: 1, height: '4px', background: `${C.accent}22`, borderRadius: '2px' }}>
            <div style={{
              height: '100%', width: `${progressPct}%`,
              background: C.accent, borderRadius: '2px', transition: 'width 0.3s',
            }} />
          </div>
          <span style={{ fontFamily: SH.fm, fontSize: '11px', color: C.textM, flexShrink: 0 }}>
            {counterLabel}
          </span>
          <button
            onClick={() => {
              // Ending early still counts any matching sets already finished —
              // otherwise the saved score silently drops their credit.
              const creditSum   = questions.reduce((s, qu) => s + (qu.credit ?? (qu.isCorrect ? 1.0 : 0.0)), 0);
              const matchCredit = matchCorrects.reduce((s, r) => s + r.correct, 0);
              const matchTotal  = matchCorrects.reduce((s, r) => s + r.total, 0);
              onFinish(questions, creditSum + matchCredit, questions.length + matchTotal, matchMisses, matchTotal);
            }}
            style={{
              fontSize: '12px', color: C.textM, padding: '3px 10px', borderRadius: '6px',
              border: `1px solid ${C.border}`, background: 'transparent', cursor: 'pointer', flexShrink: 0,
            }}
          >End</button>
        </div>
      </div>
    </div>
  );

  // ── Advance through linear questions ──────────────────────
  const advance = (qs = questions) => {
    if (idx + 1 >= qs.length) {
      if (hasMatching) {
        setInMatchPhase(true);
        setMatchLiveCount(0);
        setWaiting(false);
      } else {
        const creditSum = qs.reduce((s, qu) => s + (qu.credit ?? (qu.isCorrect ? 1.0 : 0.0)), 0);
        onFinish(qs, creditSum, qs.length, matchMisses, 0);
      }
    } else {
      setIdx(prev => prev + 1);
      setWaiting(false);
    }
  };

  const handleAnswer = (userAnswer, isCorrectOrBase, hintsRevealed) => {
    let credit, isCorrect;
    const extraFields = {};
    if (hintsRevealed !== undefined) {
      // Voca type question: baseCredit + hint penalty
      credit    = applyHintPenalty(isCorrectOrBase, hintsRevealed);
      isCorrect = credit >= 1.0;
      extraFields.hintsRevealed = hintsRevealed;
    } else {
      // MC / TF: binary
      credit    = isCorrectOrBase ? 1.0 : 0.0;
      isCorrect = !!isCorrectOrBase;
    }
    const updated = questions.map((qu, i) =>
      i === idx ? { ...qu, answered: true, userAnswer, isCorrect, credit, ...extraFields } : qu
    );
    setQuestions(updated);
    if (config.instantFeedback) setWaiting(true);
    else setTimeout(() => advance(updated), 500);
  };

  // Override a type question's credit to full (during-quiz, instant feedback on)
  const handleOverride = () => {
    setQuestions(prev => prev.map((qu, i) =>
      i === idx ? { ...qu, credit: 1.0, isCorrect: true } : qu
    ));
  };

  // Related partial override (during-quiz, instant feedback on)
  const handleRelatedOverride = (newCredit) => {
    setQuestions(prev => prev.map((qu, i) =>
      i === idx ? { ...qu, credit: newCredit, isCorrect: false } : qu
    ));
  };

  // Enter advances to the next question when the Next button is showing
  // (instant-feedback mode: after answer submitted, before clicking Next).
  // Disabled during the matching phase where Enter has no role.
  useGlobalKey(e => {
    if (e.key === 'Enter') advance();
  }, { enabled: waiting && !inMatchPhase });

  // ── Matching set finished ──────────────────────────────────
  const handleMatchFinish = (correct, total, wrongPairs = []) => {
    const newCorrects = [...matchCorrects, { correct, total }];
    const newMisses   = [...matchMisses, ...wrongPairs];
    setMatchCorrects(newCorrects);
    setMatchMisses(newMisses);
    setMatchTermsDone(prev => prev + total);
    setMatchLiveCount(0);

    if (matchSetIdx + 1 >= matchSets.length) {
      const linearCredit = questions.reduce((s, qu) => s + (qu.credit ?? (qu.isCorrect ? 1.0 : 0.0)), 0);
      const matchCredit  = newCorrects.reduce((s, r) => s + r.correct, 0);
      const matchQTotal  = newCorrects.reduce((s, r) => s + r.total, 0);
      onFinish(questions, linearCredit + matchCredit, linearTotal + matchQTotal, newMisses, matchQTotal);
    } else {
      setMatchSetIdx(prev => prev + 1);
    }
  };

  // ── Matching phase ─────────────────────────────────────────
  if (onlyMatching || inMatchPhase) {
    const setLabel = (matchSets?.length ?? 0) > 1 ? ` (${matchSetIdx + 1} of ${matchSets.length})` : '';
    return (
      <div style={{ maxWidth: '680px', margin: '0 auto' }} className="fade-up quiz-session">
        {StickyBar}
        <div style={{ fontFamily: SH.fd, fontSize: '20px', color: C.text, marginBottom: '20px' }}>
          Matching{setLabel}
        </div>
        <MatchingQ
          key={matchSetIdx}
          matchSet={currentMatchSet}
          onFinish={handleMatchFinish}
          onLiveCount={setMatchLiveCount}
          C={C} S={S}
        />
      </div>
    );
  }

  const q = questions[idx];
  if (!q) return null;

  const isLastLinear = idx + 1 >= linearTotal && !hasMatching;

  return (
    <div style={{ maxWidth: '600px', margin: '0 auto' }} className="fade-up quiz-session">
      {StickyBar}

      {q.type === 'multiple'  && <MultipleChoiceQ key={idx} q={q} config={config} onAnswer={handleAnswer} C={C} S={S} />}
      {q.type === 'truefalse' && <TrueFalseQ      key={idx} q={q} config={config} onAnswer={handleAnswer} C={C} />}
      {q.type === 'voca_type' && <VocaTypeQ                       key={idx} q={q} config={config} onAnswer={handleAnswer} onOverride={handleOverride} onRelatedOverride={handleRelatedOverride} C={C} S={S} />}

      {config.instantFeedback && waiting && (
        <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={() => advance()} style={{ ...S.btnPrimary, padding: '10px 24px' }}>
            {isLastLinear ? 'See results' : hasMatching && idx + 1 >= linearTotal ? 'Start Matching' : 'Next'}
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// VOCA TYPE QUESTION
// ─────────────────────────────────────────────────────────────
function VocaTypeQ({ q, config, onAnswer, onOverride, onRelatedOverride, C, S }) {
  const [input,             setInput]             = useState('');
  const [submitted,         setSubmitted]         = useState(false);
  const [hintsRevealed,     setHintsRevealed]     = useState(0);
  const [baseCredit,        setBaseCredit]        = useState(null);
  const [overridden,        setOverridden]        = useState(false);
  const [isRelatedPath,     setIsRelatedPath]     = useState(false);
  const [relatedOverridden, setRelatedOverridden] = useState(false);
  const [relatedOverrideCr, setRelatedOverrideCr] = useState(null);
  const inputRef = useRef(null);

  const hints    = useMemo(() => getVocaHints(q.card?.front || ''), [q.card?.front]);
  const isTwoSyn = useMemo(() => isTwoSynonymFront(q.card?.front || ''), [q.card?.front]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleSubmit = () => {
    if (!input.trim() || submitted) return;
    const spellingCr = computeVocaBaseCredit(input.trim(), q.card?.front || '');
    const relCr      = computeRelatedCredit(input.trim(), q.relatedFormLemmas, q.relatedMeaningLemmas);
    const bc = Math.max(spellingCr, relCr);
    setBaseCredit(bc);
    setIsRelatedPath(relCr > 0 && relCr >= spellingCr);
    setSubmitted(true);
    quizSound(bc >= 1.0 ? 'warble' : 'quiz_wrong');
    onAnswer(input.trim(), bc, hintsRevealed);
  };

  const handleOverrideClick = () => {
    setOverridden(true);
    onOverride?.();
  };

  const handleRelatedClick = () => {
    const rc = applyHintPenalty(0.5, hintsRevealed);
    setRelatedOverrideCr(rc);
    setRelatedOverridden(true);
    onRelatedOverride?.(rc);
  };

  const revealHint = () => {
    if (submitted || hintsRevealed >= (hints.hint2 ? 2 : 1)) return;
    setHintsRevealed(prev => prev + 1);
  };

  const maxHints      = hints.hint2 ? 2 : 1;
  const canRevealMore = !submitted && hintsRevealed < maxHints;
  const finalCredit   = submitted ? applyHintPenalty(baseCredit ?? 0, hintsRevealed) : null;

  const effectiveCredit = overridden
    ? 1.0
    : relatedOverridden
      ? (relatedOverrideCr ?? 0)
      : (finalCredit ?? 0);

  const isFullCredit  = effectiveCredit >= 1.0;
  const isPartial     = effectiveCredit > 0 && effectiveCredit < 1.0;

  const { canonical: correctDisplay } = normalizeFrontForMatching(q.card?.front || '');
  const showFeedback    = submitted && config.instantFeedback;
  const anyOverridden   = overridden || relatedOverridden;
  const showOverrideBtn = showFeedback && !anyOverridden && effectiveCredit < 1.0;
  const showRelatedBtn  = showFeedback && !anyOverridden && effectiveCredit < 1.0;

  const feedbackBg = overridden || isFullCredit
    ? `${C.warning}18`
    : isPartial ? `${C.accent}14` : `${C.danger}14`;
  const feedbackBorder = overridden || isFullCredit
    ? `${C.warning}44`
    : isPartial ? `${C.accent}44` : `${C.danger}44`;
  const feedbackColor = overridden || isFullCredit
    ? C.warning
    : isPartial ? C.accent : C.danger;

  const hintBtnLabel = hintsRevealed === 0
    ? 'Show hint'
    : (hints.hint2 && hintsRevealed < 2 ? 'Next hint' : 'Hint');

  const feedbackLabel = overridden
    ? 'Overridden — full credit'
    : isFullCredit
      ? 'Correct'
      : isPartial
        ? (relatedOverridden || isRelatedPath)
            ? `Partial — Related (${formatScore(effectiveCredit * 100)}%)`
            : `Partial — spelling (${formatScore(effectiveCredit * 100)}%)`
        : `Incorrect — answer: ${correctDisplay}`;

  return (
    <>
      {/* Definition prompt */}
      <div style={{
        background: C.raised, border: `1px solid ${C.border}`, borderRadius: '16px',
        padding: '28px 32px', marginBottom: '16px',
        display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'center',
      }}>
        <div style={{ fontSize: '11px', color: C.textM, letterSpacing: '0.06em', textTransform: 'uppercase' }}>What Korean word means:</div>
        <div style={{ fontSize: '17px', color: C.textS, fontStyle: 'italic', textAlign: 'center', lineHeight: 1.5, fontFamily: 'inherit' }}>
          {q.defn}
        </div>
      </div>

      {/* Two-synonym notice */}
      {isTwoSyn && !submitted && (
        <div style={{
          fontSize: '11.5px', color: C.textM, background: `${C.accent}0e`,
          border: `1px solid ${C.accent}22`, borderRadius: '8px',
          padding: '7px 12px', marginBottom: '10px',
        }}>
          This answer has two parts — separate them with / or ,
        </div>
      )}

      {/* Hint controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px' }}>
        <button
          onClick={revealHint}
          disabled={!canRevealMore}
          style={{
            fontSize: '12px',
            color: C.textM,
            background: 'none',
            border: `1px solid ${C.border}`,
            borderRadius: '6px',
            padding: '3px 10px',
            cursor: canRevealMore ? 'pointer' : 'default',
            opacity: canRevealMore ? 1 : 0.35,
            transition: 'opacity 0.15s',
          }}
        >
          {hintBtnLabel}
        </button>
        {hintsRevealed >= 1 && (
          <span style={{
            fontFamily: SH.fk, fontSize: '18px', color: C.textS,
            letterSpacing: '3px', userSelect: 'none',
          }}>
            {hintsRevealed >= 2 ? hints.hint2 : hints.hint1}
          </span>
        )}
      </div>

      {!submitted ? (
        <>
          <input
            ref={inputRef}
            lang="ko"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
            placeholder="Type the Korean word…"
            style={{
                          // 16px on mobile: iOS Safari auto-zooms any focused input whose
                          // font-size is below 16px, then leaves the page zoomed/clipped.
                          width: '100%', padding: '12px 14px', borderRadius: '10px', fontSize: isMobile ? '16px' : '15px',
              border: `1.5px solid ${C.border}`, background: C.bg, color: C.text,
              fontFamily: SH.fk, outline: 'none', boxSizing: 'border-box', marginBottom: '10px',
            }}
          />
          <button
            onClick={handleSubmit}
            disabled={!input.trim()}
            style={{ ...S.btnPrimary, width: '100%', justifyContent: 'center', padding: '11px', fontSize: '14px', opacity: input.trim() ? 1 : 0.5 }}
          >
            Submit
          </button>
        </>
      ) : showFeedback ? (
        <div style={{
          background: feedbackBg,
          border: `1px solid ${feedbackBorder}`,
          borderRadius: '12px', padding: '14px 16px',
        }} className="fade-up quiz-session">
          <div style={{
            fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
            color: feedbackColor,
            marginBottom: (overridden || isFullCredit) ? 0 : '8px',
          }}>
            {feedbackLabel}
          </div>
          {!overridden && !isFullCredit && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginTop: '6px' }}>
              <div>
                <div style={{ fontSize: '11px', color: C.textM, marginBottom: '4px' }}>You typed</div>
                <div style={{ fontFamily: SH.fk, fontSize: '15px', color: feedbackColor }}>{input.trim()}</div>
              </div>
              <div>
                <div style={{ fontSize: '11px', color: C.textM, marginBottom: '4px' }}>Correct</div>
                <div style={{ fontFamily: SH.fk, fontSize: '15px', color: C.textS }}>{correctDisplay}</div>
              </div>
            </div>
          )}
          {(showRelatedBtn || showOverrideBtn) && (
            <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
              {showRelatedBtn && (
                <button
                  onClick={handleRelatedClick}
                  style={{
                    fontSize: '12px', color: C.accent,
                    background: C.accentSoft, border: `1px solid ${C.accent}44`,
                    borderRadius: '6px', padding: '4px 12px', cursor: 'pointer',
                  }}
                >
                  Related
                </button>
              )}
              {showOverrideBtn && (
                <button
                  onClick={handleOverrideClick}
                  style={{
                    fontSize: '12px', color: C.accent,
                    background: C.accentSoft, border: `1px solid ${C.accent}44`,
                    borderRadius: '6px', padding: '4px 12px', cursor: 'pointer',
                  }}
                >
                  Mark as correct
                </button>
              )}
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// RESULTS
// ─────────────────────────────────────────────────────────────
function VocaQuizResults({ questions, correct, total, matchMisses = [], matchTotal = 0, resultId, config, onUpdateResult, onDone, C, S }) {
  const [localQs,      setLocalQs]      = useState(questions);
  const [localCorrect, setLocalCorrect] = useState(correct);
  const [saving,       setSaving]       = useState(false);

  const rawPct = total > 0 ? localCorrect / total * 100 : 0;
  const pct    = formatScore(Math.round(rawPct * 10) / 10);

  const answered = localQs.filter(q => q.answered);
  const getCredit = q => q.credit ?? (q.isCorrect ? 1.0 : 0.0);

  const correctCount   = answered.filter(q => getCredit(q) >= 1.0).length;
  const partialQs      = answered.filter(q => { const c = getCredit(q); return c > 0 && c < 1.0; });
  const incorrectQs    = answered.filter(q => getCredit(q) === 0);
  const partialCount   = partialQs.length;
  const incorrectCount = incorrectQs.length;

  // Matching pairs are binary and live outside the linear questions array,
  // so fold them into the tiles — otherwise Correct/Incorrect only covers
  // the linear questions and contradicts the headline score.
  const matchMissCount    = matchMisses.length;
  const matchCorrectCount = Math.max(0, matchTotal - matchMissCount);

  // For non-type missed items (MC / TF) — no override available, just show for review
  const missedNonType = answered.filter(q => q.type !== 'voca_type' && !q.isCorrect);
  // Matching misses join the review list in the same card shape the renderer expects
  const reviewMisses = [
    ...missedNonType,
    ...matchMisses.map(p => ({ card: { front: p.term, back: p.defn }, type: 'matching', userAnswer: null })),
  ];

  // Type questions needing override: only shown when instantFeedback was OFF
  // (if it was ON, overrides happened during the session)
  const instantFeedback = config?.instantFeedback !== false;
  const overrideable = instantFeedback ? [] :
    localQs.map((q, i) => ({ q, i })).filter(({ q }) =>
      q.type === 'voca_type' && q.answered && getCredit(q) < 1.0
    );

const handleOverride = async (qIdx) => {
    const newQs = localQs.map((q, i) => i !== qIdx ? q : { ...q, credit: 1.0, isCorrect: true });
    const newCorrect = newQs.reduce((s, q) => s + getCredit(q), 0) + matchCorrectCount;
    setLocalQs(newQs);
    setLocalCorrect(newCorrect);
    if (resultId && onUpdateResult) {
      setSaving(true);
      await onUpdateResult(resultId, newCorrect, total);
      setSaving(false);
    }
  };

  const handleRelatedOverride = async (qIdx) => {
    const q = localQs[qIdx];
    const newCredit = applyHintPenalty(0.5, q.hintsRevealed ?? 0);
    const newQs = localQs.map((qu, i) =>
      i !== qIdx ? qu : { ...qu, credit: newCredit, isCorrect: false, relatedOverride: true }
    );
    const newCorrect = newQs.reduce((s, qu) => s + getCredit(qu), 0) + matchCorrectCount;
    setLocalQs(newQs);
    setLocalCorrect(newCorrect);
    if (resultId && onUpdateResult) {
      setSaving(true);
      await onUpdateResult(resultId, newCorrect, total);
      setSaving(false);
    }
  };

  const { canonical: _unused } = normalizeFrontForMatching(''); // keep import alive

  return (
    <div style={{ maxWidth: '560px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '24px' }} className="fade-up quiz-session">
      {/* Score */}
      <div style={{ textAlign: 'center' }}>
                <div style={{ fontFamily: SH.fd, fontSize: '40px', color: C.accent }}>{pct}%</div>
        {rawPct >= 90 && <div style={{ marginTop: '10px', fontSize: '13px', color: C.warning, fontWeight: 500 }}>Excellent work!</div>}
      </div>

      {/* Correct / Partial / Incorrect stats */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
        {[
          { label: 'Correct',   value: correctCount + matchCorrectCount,   color: C.warning },
          { label: 'Partial',   value: partialCount,                        color: C.danger  },
          { label: 'Incorrect', value: incorrectCount + matchMissCount,     color: C.danger  },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '12px', padding: '16px', textAlign: 'center' }}>
            <div style={{ fontFamily: SH.fm, fontSize: '24px', color }}>{value}</div>
            <div style={{ fontSize: '11px', color: C.textM, marginTop: '4px' }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Overrideable type questions (instant feedback OFF) */}
      {overrideable.length > 0 && (
        <div>
          <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.textM, marginBottom: '10px' }}>
            Review typed answers
            {saving && <span style={{ fontWeight: 400, opacity: 0.6, marginLeft: '8px' }}>Saving…</span>}
          </div>
          <div style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '12px', overflow: 'hidden' }}>
            {overrideable.map(({ q, i }) => {
              const cr = getCredit(q);
              const { canonical } = normalizeFrontForMatching(q.card?.front || '');
              const isFullOverride    = cr >= 1.0;
              const isRelatedOverride = q.relatedOverride === true;
              const anyOverridden     = isFullOverride || isRelatedOverride;
              return (
                <div key={i} style={{
                  padding: '12px 16px',
                  borderBottom: i < overrideable[overrideable.length-1].i ? `1px solid ${C.border}` : 'none',
                  display: 'flex', flexDirection: 'column', gap: '6px',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
                    <div>
                      <div style={{ fontFamily: SH.fk, fontSize: '13.5px', color: C.text }}>{canonical}</div>
                      <div style={{ fontSize: '12px', color: C.textM, marginTop: '2px' }}>{q.defn}</div>
                    </div>
                    <div style={{ fontSize: '11px', textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ color: isFullOverride ? C.warning : cr > 0 ? C.accent : C.danger, fontWeight: 600 }}>
                        {isFullOverride
                          ? 'Overridden'
                          : isRelatedOverride
                            ? `Partial — Related (${formatScore(cr * 100)}%)`
                            : cr > 0
                              ? `Partial — spelling (${formatScore(cr * 100)}%)`
                              : 'Incorrect'}
                      </div>
                      <div style={{ color: C.textM, marginTop: '2px' }}>You: {q.userAnswer || '—'}</div>
                    </div>
                  </div>
                  {!anyOverridden && (
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        onClick={() => handleRelatedOverride(i)}
                        style={{
                          alignSelf: 'flex-start', fontSize: '12px', color: C.accent,
                          background: C.accentSoft, border: `1px solid ${C.accent}44`,
                          borderRadius: '6px', padding: '4px 12px', cursor: 'pointer',
                        }}
                      >
                        Related
                      </button>
                      <button
                        onClick={() => handleOverride(i)}
                        style={{
                          alignSelf: 'flex-start', fontSize: '12px', color: C.accent,
                          background: C.accentSoft, border: `1px solid ${C.accent}44`,
                          borderRadius: '6px', padding: '4px 12px', cursor: 'pointer',
                        }}
                      >
                        Mark as correct
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Missed items — linear (MC/TF) misses plus matching misses */}
      {reviewMisses.length > 0 && (
        <div>
          <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.textM, marginBottom: '10px' }}>
            Review — missed items
          </div>
          <div style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '12px', overflow: 'hidden' }}>
            {reviewMisses.map((q, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'flex-start', gap: '12px',
                padding: '11px 16px', borderBottom: i < reviewMisses.length - 1 ? `1px solid ${C.border}` : 'none',
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: SH.fk, fontSize: '13.5px', color: C.text }}>{q.card?.front || q.term || '—'}</div>
                  <div style={{ fontSize: '12px', color: C.textM, marginTop: '2px' }}>{q.card?.back || q.card?.notes || q.defn || '—'}</div>
                </div>
                {q.userAnswer && (
                  <div style={{ fontSize: '11px', color: C.danger, textAlign: 'right', flexShrink: 0 }}>
                    You said: {q.userAnswer}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button style={S.btnGhost} onClick={onDone}>Back to Quizzes</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// GRAMMAR QUIZ STUB
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// GRAMMAR QUIZ
// ─────────────────────────────────────────────────────────────

const GRAMMAR_DEFAULTS = {
  mode:         'translation', // 'translation' | 'selection'
  transMode:    'broad',       // 'drill' | 'broad' (translation sub-mode)
  length:       5,
  choiceCount:  4,
  selectedIds:  [],            // concept IDs — required for drill, optional for broad/selection
};

// ── Concept picker: searchable list with level filter ────────
function ConceptPicker({ corpus, selectedIds, onChange, required, C, S }) {
  const [search,      setSearch]      = useState('');
  const [levelFilter, setLevelFilter] = useState('all');

  const levels = useMemo(() => {
    const s = new Set(corpus.map(e => e.level).filter(Boolean));
    return ['all', ...Array.from(s).sort()];
  }, [corpus]);

  const visible = useMemo(() => corpus.filter(e => {
    const matchLevel = levelFilter === 'all' || e.level === levelFilter;
    const matchSearch = !search || e.term.toLowerCase().includes(search.toLowerCase());
    return matchLevel && matchSearch;
  }), [corpus, search, levelFilter]);

  const toggle = (id) => {
    onChange(selectedIds.includes(id)
      ? selectedIds.filter(x => x !== id)
      : [...selectedIds, id]);
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
        <input
          type="text"
          placeholder="Search concepts…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            flex: 1, padding: '7px 12px', borderRadius: '8px', fontSize: isMobile ? '16px' : '13px',
            border: `1px solid ${C.border}`, background: C.bg, color: C.text, outline: 'none',
          }}
        />
        <select
          value={levelFilter}
          onChange={e => setLevelFilter(e.target.value)}
          style={{
            padding: '7px 10px', borderRadius: '8px', fontSize: '12px',
            border: `1px solid ${C.border}`, background: C.bg, color: C.text, outline: 'none',
          }}
        >
          {levels.map(l => <option key={l} value={l}>{l === 'all' ? 'All levels' : l}</option>)}
        </select>
      </div>

      {selectedIds.length > 0 && (
        <div style={{ fontSize: '11px', color: C.textM, marginBottom: '8px' }}>
          {selectedIds.length} selected
          <button
            onClick={() => onChange([])}
            style={{ marginLeft: '8px', fontSize: '11px', color: C.danger, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            Clear all
          </button>
        </div>
      )}

      {/* Selected concepts that are currently hidden by search/filter — always shown */}
      {(() => {
        const visibleIds = new Set(visible.map(e => e.id));
        const hiddenSelected = corpus.filter(e => selectedIds.includes(e.id) && !visibleIds.has(e.id));
        if (!hiddenSelected.length) return null;
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '6px', paddingBottom: '6px', borderBottom: `1px dashed ${C.border}` }}>
            {hiddenSelected.map(e => (
              <button
                key={e.id}
                onClick={() => toggle(e.id)}
                style={{
                  textAlign: 'left', padding: '7px 12px', borderRadius: '8px', fontSize: '13px',
                  border: `1.5px solid ${C.accent}`,
                  background: C.accentSoft,
                  color: C.accent,
                  cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}
              >
                <span style={{ fontFamily: SH.fk }}>{e.term}</span>
                <span style={{ fontSize: '10px', color: C.accent }}>{e.level}</span>
              </button>
            ))}
          </div>
        );
      })()}

      <div style={{ maxHeight: '200px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {visible.length === 0 && (
          <div style={{ fontSize: '12px', color: C.textM, padding: '8px 0' }}>No concepts match.</div>
        )}
        {visible.map(e => {
          const active = selectedIds.includes(e.id);
          return (
            <button
              key={e.id}
              onClick={() => toggle(e.id)}
              style={{
                textAlign: 'left', padding: '7px 12px', borderRadius: '8px', fontSize: '13px',
                border: `1.5px solid ${active ? C.accent : C.border}`,
                background: active ? C.accentSoft : 'transparent',
                color: active ? C.accent : C.text,
                cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}
            >
              <span style={{ fontFamily: SH.fk }}>{e.term}</span>
              <span style={{ fontSize: '10px', color: active ? C.accent : C.textM }}>{e.level}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Grammar Quiz Config ───────────────────────────────────────
function GrammarQuizConfig({ open, onBack, onStart, corpus, apiKey, C, S }) {
  const [config, setConfig] = useState(() => loadConfig(GRAMMAR_CONFIG_KEY, GRAMMAR_DEFAULTS));
  const set = (key, val) => setConfig(prev => {
    const next = { ...prev, [key]: val };
    saveConfig(GRAMMAR_CONFIG_KEY, next);
    return next;
  });

  const isDrill       = config.transMode === 'drill';
  const isSelection   = config.mode === 'selection';
  const isTranslation = config.mode === 'translation';
  const hasKey        = !!apiKey;

  // Drill requires at least 1 concept; Selection requires at least 2
  const minSelected = isSelection ? 2 : 1;
  const canStart = hasKey && corpus.length > 0 &&
    (!isDrill || config.selectedIds.length >= 1) &&
    (!isSelection || config.selectedIds.length >= 2);

  if (!open) return null;

  return createPortal(
    <div style={S.overlay} onClick={e => { if (e.target === e.currentTarget) onBack(); }}>
      <div style={S.modal} className="slide-up">
        <div style={{ ...S.modalHeader, marginBottom: '16px' }}>
          <span style={S.modalTitle}>Grammar Quiz</span>
          <button
            onClick={onBack}
            style={{ background: 'none', border: 'none', color: C.textM, cursor: 'pointer', fontSize: '18px', padding: '2px' }}
          >
            ✕
          </button>
        </div>

        <div style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '16px', padding: '0 20px', marginBottom: '20px' }}>

          {/* Quiz mode */}
          <ConfigRow label="Quiz mode" C={C}>
            <ToggleChip label="Translation" active={isTranslation} onClick={() => { set('mode', 'translation'); set('selectedIds', []); }} C={C} />
            <ToggleChip label="Selection"   active={isSelection}   onClick={() => { set('mode', 'selection');   set('selectedIds', []); }} C={C} />
          </ConfigRow>

          {/* Translation sub-mode */}
          {isTranslation && (
            <ConfigRow label="Translation mode" C={C}>
              <ToggleChip label="Drill"  active={isDrill}  onClick={() => { set('transMode', 'drill');  set('selectedIds', []); }} C={C} />
              <ToggleChip label="Broad"  active={!isDrill} onClick={() => { set('transMode', 'broad');  set('selectedIds', []); }} C={C} />
            </ConfigRow>
          )}

          {/* Concept picker */}
          {/* Drill: required (1+). Broad: optional. Selection: required (2+). */}
          <div style={{ padding: '14px 0', borderBottom: `1px solid ${C.border}` }}>
            <div style={{ fontSize: '13px', color: C.textS, marginBottom: '10px' }}>
              {isDrill      ? 'Grammar concept (required)'
               : isSelection ? 'Grammar concepts to compare (min. 2)'
               : 'Focus concepts (optional — leave empty for free selection)'}
            </div>
            {corpus.length > 0
              ? <ConceptPicker corpus={corpus} selectedIds={config.selectedIds} onChange={v => set('selectedIds', v)} C={C} S={S} />
              : <div style={{ fontSize: '12px', color: C.textM }}>Loading grammar index…</div>
            }
          </div>

          {/* Questions */}
          <ConfigRow label="Questions" C={C}>
            <Stepper value={config.length} onChange={v => set('length', v)} min={1} max={20} C={C} />
          </ConfigRow>

          {/* Answer options — only for Broad translation */}
          {isTranslation && !isDrill && (
            <ConfigRow label="Answer options" C={C} noBorder>
              {[2, 3, 4, 6].map(n => (
                <ToggleChip key={n} label={`${n} choices`} active={config.choiceCount === n} onClick={() => set('choiceCount', n)} C={C} />
              ))}
            </ConfigRow>
          )}
        </div>

        {!hasKey && (
          <div style={{
            fontSize: '12px', color: C.danger,
            background: `${C.danger}10`, border: `1px solid ${C.danger}30`,
            borderRadius: '8px', padding: '10px 14px', marginBottom: '16px', lineHeight: 1.5,
          }}>
            An API key is required for grammar quizzes. Add one in Settings.
          </div>
        )}

        {hasKey && isSelection && config.selectedIds.length < 2 && config.selectedIds.length > 0 && (
          <div style={{
            fontSize: '12px', color: C.textM,
            background: `${C.accent}0e`, border: `1px solid ${C.accent}30`,
            borderRadius: '8px', padding: '10px 14px', marginBottom: '16px',
          }}>
            Select at least 2 concepts to compare.
          </div>
        )}

        <button
          style={{ ...S.btnPrimary, width: '100%', justifyContent: 'center', padding: '12px', fontSize: '14px', opacity: canStart ? 1 : 0.5 }}
          onClick={() => { if (canStart) { quizSound('mouse_click'); onStart(config); } }}
          disabled={!canStart}
        >
          Start Quiz
        </button>
      </div>
    </div>,
    document.body
  );
}

// ── Grammar Translation Session ───────────────────────────────
function GrammarTranslationSession({ questions, config, onFinish, C, S }) {
  const [idx,         setIdx]         = useState(0);
  const [translations, setTranslations] = useState(() => questions.map(() => ''));
  const [submitted,   setSubmitted]   = useState(false);
  const [selectedId,  setSelectedId]  = useState(null); // chosen concept in Broad mode

  // Per-question concept selection tracking (Broad mode only)
  const [conceptChoices, setConceptChoices] = useState(() => questions.map(() => null));

  const q = questions[idx];
  const isBroad = config.transMode === 'broad';
  const isLast  = idx === questions.length - 1;

  const updateTranslation = (val) => {
    setTranslations(prev => prev.map((t, i) => i === idx ? val : t));
  };

  const updateConcept = (id) => {
    setConceptChoices(prev => prev.map((c, i) => i === idx ? id : c));
    setSelectedId(id);
  };

  const handleNext = () => {
    setSelectedId(conceptChoices[idx + 1] || null);
    setIdx(prev => prev + 1);
  };

  const handleSubmit = () => {
    setSubmitted(true);
    onFinish({ translations, conceptChoices });
  };

  // Restore selected concept when navigating back/forward
  useEffect(() => {
    setSelectedId(conceptChoices[idx] || null);
  }, [idx]);

  if (!q) return null;

  return (
    <div style={{ maxWidth: '680px', margin: '0 auto' }} className="fade-up quiz-session">
      {/* Progress */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
        <div style={{ flex: 1, height: '4px', background: `${C.accent}22`, borderRadius: '2px' }}>
          <div style={{ height: '100%', width: `${((isLast ? questions.length : idx) / questions.length) * 100}%`, background: C.accent, borderRadius: '2px', transition: 'width 0.3s' }} />
        </div>
        <span style={{ fontFamily: SH.fm, fontSize: '11px', color: C.textM }}>{idx + 1} / {questions.length}</span>
      </div>

      {/* English sentence + context */}
      <div style={{
        background: C.raised, border: `1px solid ${C.border}`, borderRadius: '16px',
        padding: '24px 28px', marginBottom: '16px',
      }}>
        <div style={{ fontSize: '17px', color: C.text, lineHeight: 1.5, marginBottom: '12px' }}>
          {q.english}
        </div>
        {q.context && (
          <div style={{
            fontSize: '12px', color: C.textM, fontStyle: 'italic',
            borderTop: `1px solid ${C.border}`, paddingTop: '10px', lineHeight: 1.5,
          }}>
            {q.context}
          </div>
        )}
      </div>

      {/* Broad mode: concept chips to choose from */}
      {isBroad && q.choices && (
        <div style={{ marginBottom: '16px' }}>
          <div style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textM, marginBottom: '8px' }}>
            Choose the grammar concept
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {q.choices.map(c => (
              <button
                key={c.id}
                onClick={() => updateConcept(c.id)}
                style={{
                  textAlign: 'left', padding: '11px 16px', borderRadius: '10px', fontSize: '13.5px',
                  border: `1.5px solid ${selectedId === c.id ? C.warning : C.border}`,
                  background: selectedId === c.id ? `${C.warning}18` : 'transparent',
                  color: selectedId === c.id ? C.warning : C.text,
                  cursor: 'pointer', transition: 'all 0.15s', fontFamily: SH.fk,
                }}
              >
                {c.term}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Korean translation input */}
      <div style={{ marginBottom: '16px' }}>
        <div style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textM, marginBottom: '8px' }}>
          Your Korean translation
        </div>
        <textarea
          value={translations[idx]}
          onChange={e => updateTranslation(e.target.value)}
          placeholder="한국어로 번역하세요…"
          rows={3}
          style={{
                      width: '100%', padding: '12px 14px', borderRadius: '10px', fontSize: isMobile ? '16px' : '14px',
            border: `1.5px solid ${C.border}`, background: C.bg, color: C.text,
            fontFamily: SH.fk, resize: 'vertical', outline: 'none', boxSizing: 'border-box',
            lineHeight: 1.6,
          }}
        />
      </div>

      {/* Navigation */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button
          onClick={() => { setIdx(prev => prev - 1); setSelectedId(conceptChoices[idx - 1] || null); }}
          disabled={idx === 0}
          style={{
            fontSize: '12px', color: idx === 0 ? C.textM : C.accent, background: 'none', border: 'none',
            cursor: idx === 0 ? 'default' : 'pointer', padding: 0, opacity: idx === 0 ? 0.4 : 1,
          }}
        >
          ← Previous
        </button>

        {isLast ? (
          <button
            disabled={submitted}
            style={{ ...S.btnPrimary, padding: '10px 24px', opacity: submitted ? 0.5 : 1 }}
            onClick={() => { quizSound('mouse_click'); handleSubmit(); }}
          >
            Submit for assessment
          </button>
        ) : (
          <button onClick={() => { quizSound('mouse_click'); handleNext(); }} style={{ ...S.btnPrimary, padding: '10px 24px' }}>
            Next
          </button>
        )}
      </div>
    </div>
  );
}

// ── Grammar Translation Results ───────────────────────────────
const VERDICT_STYLE = {
  'O': { symbol: 'O', color: '#5a8a5a' },
  '△': { symbol: '△', color: '#b87c2a' },
  'X': { symbol: 'X', color: '#a03030' },
};

function GrammarTranslationResults({ questions, translations, assessment, onDone, C, S }) {
  const pct = assessment
    ? Math.round((assessment.filter(a => a.verdict === 'O').length / assessment.length) * 100)
    : 0;

  return (
    <div style={{ maxWidth: '680px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '20px' }} className="fade-up quiz-session">
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontFamily: SH.fm, fontSize: '38px', color: C.accent }}>{pct}%</div>
        <div style={{ fontSize: '12px', color: C.textM, marginTop: '4px' }}>
          {assessment?.filter(a => a.verdict === 'O').length} / {assessment?.length} fully correct
        </div>
      </div>

      {questions.map((q, i) => {
        const a = assessment?.[i];
        const vs = a ? VERDICT_STYLE[a.verdict] || VERDICT_STYLE['X'] : null;
        return (
          <div key={i} style={{
            background: C.raised, border: `1px solid ${C.border}`, borderRadius: '14px',
            padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: '12px',
          }}>
            {/* Header: verdict + correct concept */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '15px', color: C.text, lineHeight: 1.5, marginBottom: '4px' }}>{q.english}</div>
                {q.context && <div style={{ fontSize: '11px', color: C.textM, fontStyle: 'italic' }}>{q.context}</div>}
              </div>
              {vs && (
                <div style={{ fontFamily: SH.fm, fontSize: '28px', color: vs.color, flexShrink: 0, lineHeight: 1 }}>{vs.symbol}</div>
              )}
            </div>

            {/* Correct grammar concept revealed */}
            <div style={{
              fontSize: '12px', color: C.accent, fontFamily: SH.fk,
              background: C.accentSoft, borderRadius: '6px', padding: '5px 10px', alignSelf: 'flex-start',
            }}>
              {q.correctConcept?.term || '—'}
            </div>

            {/* Your translation */}
            <div>
              <div style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: C.textM, marginBottom: '4px' }}>Your translation</div>
              <div style={{ fontFamily: SH.fk, fontSize: '14px', color: C.text, lineHeight: 1.6 }}>
                {translations[i] || <span style={{ color: C.textM, fontStyle: 'italic' }}>No translation entered</span>}
              </div>
            </div>

            {/* Corrected sentence (shown for △ and X only) */}
            {a?.corrected && (
              <div>
                <div style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: C.textM, marginBottom: '4px' }}>Suggested correction</div>
                <div style={{
                  fontFamily: SH.fk, fontSize: '14px', color: C.text, lineHeight: 1.6,
                  padding: '8px 12px', background: `${C.accent}0e`, borderRadius: '8px',
                  borderLeft: `3px solid ${C.accent}`,
                }}>
                  {a.corrected}
                </div>
              </div>
            )}

            {/* Assessment dimensions */}
            {a && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', borderTop: `1px solid ${C.border}`, paddingTop: '12px' }}>
                {[
                  { label: 'Grammar',      note: a.grammar },
                  { label: 'Vocabulary',   note: a.vocabulary },
                  { label: 'Completeness', note: a.completeness },
                ].map(({ label, note }) => note && (
                  <div key={label} style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: '10px', alignItems: 'flex-start' }}>
                    <div style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: C.textM, paddingTop: '2px' }}>{label}</div>
                    <div style={{ fontSize: '12.5px', color: C.textS, lineHeight: 1.5 }}>{note}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button style={S.btnGhost} onClick={onDone}>Back to Quizzes</button>
      </div>
    </div>
  );
}

// ── Grammar Selection Session ─────────────────────────────────
function GrammarSelectionSession({ questions, onFinish, C, S }) {
  const [idx,         setIdx]         = useState(0);
  const [selections,  setSelections]  = useState(() => questions.map(() => new Set()));
  const [submitted,   setSubmitted]   = useState(false);

  const q = questions[idx];
  const isLast = idx === questions.length - 1;

  const toggleSentence = (sentIdx) => {
    if (submitted) return;
    setSelections(prev => {
      const next = prev.map((s, i) => {
        if (i !== idx) return s;
        const ns = new Set(s);
        ns.has(sentIdx) ? ns.delete(sentIdx) : ns.add(sentIdx);
        return ns;
      });
      return next;
    });
  };

  const handleSubmit = () => {
    setSubmitted(true);
    // Convert Sets to arrays for serialization
    onFinish(selections.map(s => Array.from(s)));
  };

  if (!q) return null;

  return (
    <div style={{ maxWidth: '680px', margin: '0 auto' }} className="fade-up quiz-session">
      {/* Progress */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
        <div style={{ flex: 1, height: '4px', background: `${C.accent}22`, borderRadius: '2px' }}>
          <div style={{ height: '100%', width: `${((isLast ? questions.length : idx) / questions.length) * 100}%`, background: C.accent, borderRadius: '2px', transition: 'width 0.3s' }} />
        </div>
        <span style={{ fontFamily: SH.fm, fontSize: '11px', color: C.textM }}>{idx + 1} / {questions.length}</span>
      </div>

      <div style={{ fontSize: '11px', color: C.textM, marginBottom: '14px', lineHeight: 1.5 }}>
        Select all grammatically and contextually correct sentences.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '24px' }}>
        {q.sentences.map((sent, si) => {
          const isSelected = selections[idx].has(si);
          return (
            <button
              key={si}
              onClick={() => toggleSentence(si)}
              style={{
                textAlign: 'left', padding: '14px 18px', borderRadius: '10px', fontSize: '14px',
                border: `1.5px solid ${isSelected ? C.warning : C.border}`,
                background: isSelected ? `${C.warning}18` : 'transparent',
                color: isSelected ? C.warning : C.text,
                cursor: 'pointer', transition: 'all 0.15s', fontFamily: SH.fk, lineHeight: 1.6,
              }}
            >
              {sent.text}
            </button>
          );
        })}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button
          onClick={() => setIdx(prev => prev - 1)}
          disabled={idx === 0}
          style={{
            fontSize: '12px', color: idx === 0 ? C.textM : C.accent,
            background: 'none', border: 'none', cursor: idx === 0 ? 'default' : 'pointer',
            padding: 0, opacity: idx === 0 ? 0.4 : 1,
          }}
        >
          ← Previous
        </button>

        {isLast ? (
          <button
            onClick={() => { quizSound('mouse_click'); handleSubmit(); }}
            disabled={submitted}
            style={{ ...S.btnPrimary, padding: '10px 24px', opacity: submitted ? 0.5 : 1 }}
          >
            Submit
          </button>
        ) : (
          <button onClick={() => { quizSound('mouse_click'); setIdx(prev => prev + 1); }} style={{ ...S.btnPrimary, padding: '10px 24px' }}>
            Next
          </button>
        )}
      </div>
    </div>
  );
}

// ── Grammar Selection Results ─────────────────────────────────
function GrammarSelectionResults({ questions, userSelections, onDone, C, S }) {
  const [showExplainModal, setShowExplainModal] = useState(false);
  const [toExplain,        setToExplain]        = useState(new Set()); // Set of "qi-si" keys
  const [explanations,     setExplanations]     = useState({});
  const [explaining,       setExplaining]       = useState(false);
  const [explainError,     setExplainError]     = useState(false);

  // Determine correct/incorrect per sentence per question
  const results = questions.map((q, qi) => {
    const userSet    = new Set(userSelections[qi] || []);
    const correctSet = new Set(q.sentences.map((s, si) => s.correct ? si : null).filter(x => x !== null));
    return q.sentences.map((s, si) => {
      const userSelected   = userSet.has(si);
      const shouldSelect   = s.correct;
      const isRight = userSelected === shouldSelect;
      return { si, text: s.text, concept: s.concept, correct: shouldSelect, userSelected, isRight };
    });
  });

  // Collect all mistakes for the explanation modal
  const allMistakes = results.flatMap((qResults, qi) =>
    qResults
      .filter(r => !r.isRight)
      .map(r => ({ key: `${qi}-${r.si}`, qi, si: r.si, text: r.text, concept: r.concept, correct: r.correct, userSelected: r.userSelected }))
  );

  const toggleExplain = (key) => {
    setToExplain(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const handleGetExplanations = async () => {
    const items = allMistakes
      .filter(m => toExplain.has(m.key))
      .map(m => ({
        ...m,
        errorType: m.correct && !m.userSelected ? 'missed_correct' : 'selected_wrong',
      }));
    if (!items.length) return;
    setExplaining(true);
    setExplainError(false);

    const prompt = `You are explaining Korean grammar mistakes to a language learner.

    For each item, explain briefly why the sentence is correct or incorrect for the given grammar concept, and what the learner should understand.

    Items:
    ${items.map((m, i) => `${i + 1}. Sentence: "${m.text}"
       Grammar concept: ${m.concept}
       Error type: ${m.errorType === 'missed_correct'
         ? 'The learner did NOT select this sentence, but it is grammatically correct and appropriate. Explain why it is valid.'
         : 'The learner SELECTED this sentence, but it contains a grammar error. Explain what is wrong with it.'
       }`).join('\n\n')}

Respond with ONLY a JSON object:
{
  "explanations": ["explanation for item 1", "explanation for item 2"]
}`;

    try {
      const res = await fetch('/api/grammar-quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model:      'claude-sonnet-4-20250514',
          max_tokens: 2000,
          system:     'You output only valid JSON. No prose, no markdown fences.',
          messages:   [{ role: 'user', content: prompt }],
        }),
      });
      if (res.ok) {
        const data   = await res.json();
        const raw    = data.content?.find(b => b.type === 'text')?.text || '';
        const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
        const expMap = {};
        items.forEach((m, i) => { expMap[m.key] = parsed.explanations?.[i] || ''; });
        setExplanations(expMap);
      } else {
        setExplainError(true);
      }
    } catch (e) {
      console.error('Selection explanation failed:', e);
      setExplainError(true);
    } finally {
      setExplaining(false);
    }
  };

  const totalSentences = results.reduce((s, r) => s + r.length, 0);
  const correctCount   = results.reduce((s, r) => s + r.filter(x => x.isRight).length, 0);
  const pct            = Math.round((correctCount / totalSentences) * 100);

  return (
    <div style={{ maxWidth: '680px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '20px' }} className="fade-up quiz-session">
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontFamily: SH.fm, fontSize: '38px', color: C.accent }}>{pct}%</div>
        <div style={{ fontSize: '12px', color: C.textM, marginTop: '4px' }}>
          {correctCount} / {totalSentences} correct
        </div>
      </div>

      {/* Question results */}
      {results.map((qResults, qi) => (
        <div key={qi} style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '14px', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {qResults.map(r => {
            let borderColor = C.border, bgColor = 'transparent', textColor = C.text;
            if (r.correct && r.userSelected)  { borderColor = C.warning; bgColor = `${C.warning}18`; textColor = C.warning; }
            else if (r.correct && !r.userSelected) { borderColor = C.danger;  bgColor = `${C.danger}12`;  textColor = C.danger;  }
            else if (!r.correct && r.userSelected) { borderColor = C.danger;  bgColor = `${C.danger}12`;  textColor = C.danger;  }
            else { textColor = C.textM; }
            return (
              <div key={r.si} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div style={{
                  padding: '11px 16px', borderRadius: '10px', fontSize: '14px',
                  border: `1.5px solid ${borderColor}`, background: bgColor,
                  color: textColor, fontFamily: SH.fk, lineHeight: 1.6,
                }}>
                  {r.text}
                </div>
                {r.correct && !r.userSelected && (
                  <div style={{ fontSize: '11px', color: C.danger, paddingLeft: '4px', fontStyle: 'italic' }}>
                    This sentence is acceptable — you did not select it.
                  </div>
                )}
                {!r.correct && r.userSelected && (
                  <div style={{ fontSize: '11px', color: C.danger, paddingLeft: '4px', fontStyle: 'italic' }}>
                    This sentence is not correct for this grammar usage — it should not have been selected.
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {/* Explanation button */}
      {allMistakes.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <button
            style={{ ...S.btnGhost, padding: '10px 24px' }}
            onClick={() => setShowExplainModal(true)}
          >
            Explanation
          </button>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button style={S.btnGhost} onClick={onDone}>Back to Quizzes</button>
      </div>

      {/* Explanation modal — portaled: this component's own `.fade-up`
          wrapper creates a containing block that would trap the fixed overlay */}
      {showExplainModal && createPortal(
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 200,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
        }}>
          <div style={{
            ...S.modal, maxHeight: 'min(80vh, calc(100dvh - 32px))',
          }}>
            <div style={{ fontFamily: SH.fd, fontSize: '17px', color: C.text, marginBottom: '16px' }}>
              Select sentences to explain
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px' }}>
              {allMistakes.map(m => {
                const sel = toExplain.has(m.key);
                const exp = explanations[m.key];
                return (
                  <div key={m.key} style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <button
                      onClick={() => toggleExplain(m.key)}
                      style={{
                        textAlign: 'left', padding: '11px 14px', borderRadius: '10px', fontSize: '13.5px',
                        border: `1.5px solid ${sel ? C.accent : C.border}`,
                        background: sel ? C.accentSoft : 'transparent',
                        color: sel ? C.accent : C.text,
                        cursor: 'pointer', fontFamily: SH.fk, lineHeight: 1.5,
                      }}
                    >
                      {m.text}
                    </button>
                    {exp && (
                      <div style={{ fontSize: '12.5px', color: C.textS, lineHeight: 1.6, padding: '0 4px' }}>{exp}</div>
                    )}
                  </div>
                );
              })}
            </div>

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', alignItems: 'center' }}>
              {explainError && (
                <span style={{ fontSize: '12px', color: C.danger }}>
                  Request failed — please try again.
                </span>
              )}
              <button style={S.btnGhost} onClick={() => setShowExplainModal(false)}>Close</button>
              {toExplain.size > 0 && (
                <button
                  style={{ ...S.btnPrimary, padding: '10px 20px', opacity: explaining ? 0.6 : 1 }}
                  onClick={handleGetExplanations}
                  disabled={explaining}
                >
                  {explaining ? 'Getting explanations…' : 'Get explanation'}
                </button>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// REPORT CARD
// ─────────────────────────────────────────────────────────────
// Compute clustered X positions for a group of scores at the same value.
// Returns { score, xOffset, opacity } per point with organic random jitter.
function clusterScores(scores) {
  if (!scores || scores.length === 0) return [];
  const sorted = [...scores].sort((a, b) => b - a);
  const maxS   = sorted[0];
  const minS   = sorted[sorted.length - 1];
  const range  = maxS - minS;

  // Group identical values for horizontal spread
  const groupCount = {};
  scores.forEach(s => { groupCount[s] = (groupCount[s] || 0) + 1; });

  // Pre-assign offsets per group
  const groupOffsets = {};
  Object.entries(groupCount).forEach(([val, count]) => {
    const offsets = [];
    for (let k = 0; k < count; k++) {
      if (count === 1) {
        offsets.push(0);
      } else {
        const step   = k - (count - 1) / 2;
        const base   = step * 5;
        const jitter = (Math.random() - 0.5) * 4;
        offsets.push(base + jitter);
      }
    }
    groupOffsets[val] = offsets;
  });

  const groupIdx = {};
  return scores.map(s => {
    groupIdx[s] = (groupIdx[s] || 0);
    const xOffset = groupOffsets[s][groupIdx[s]];
    groupIdx[s]++;
    const opacity = range === 0 ? 1 : 0.4 + 0.6 * ((s - minS) / range);
    return { score: s, xOffset, opacity };
  });
}

// Groups quiz results by date and averages scores per type — shared between
// the home preview chart and the Report Card's range-filtered chart. Caller
// is responsible for any date-range pre-filtering before passing `list` in.
function buildQuizChartData(list) {
  const byDate = {};
  for (const r of list) {
    const key = r.date?.split('T')[0] || r.date;
    if (!byDate[key]) byDate[key] = { voca: [], gram: [], cloze: [] };
    if (r.type === 'voca')    byDate[key].voca.push(r.score);
    if (r.type === 'grammar') byDate[key].gram.push(r.score);
    if (r.type === 'cloze')   byDate[key].cloze.push(r.score);
  }
 return Object.entries(byDate).sort(([a], [b]) => a.localeCompare(b)).map(([date, d]) => {
    const vocaScore  = d.voca.length  ? Math.round(d.voca.reduce((s, v)  => s + v, 0) / d.voca.length)  : null;
    const gramScore  = d.gram.length  ? Math.round(d.gram.reduce((s, v)  => s + v, 0) / d.gram.length)  : null;
    const clozeScore = d.cloze.length ? Math.round(d.cloze.reduce((s, v) => s + v, 0) / d.cloze.length) : null;
    // Combined cross-type trend — equal-weighted average of the three
    // per-type daily averages (a type with one result counts the same as a
    // type with ten); allCount below tracks raw volume instead, for the
    // combined line's variable thickness.
    const typeAverages = [vocaScore, gramScore, clozeScore].filter(v => v !== null);
    const allScore = typeAverages.length ? Math.round(typeAverages.reduce((s, v) => s + v, 0) / typeAverages.length) : null;
    const allCount = d.voca.length + d.gram.length + d.cloze.length;
    return {
      dateLabel: date.slice(5),
      vocaScore, gramScore, clozeScore,
      vocaAll: d.voca, gramAll: d.gram, clozeAll: d.cloze,
      allScore, allCount,
    };
  });
}

// One result row — type badge, date, score — shared between the home
// preview list and the Report Card table. `onClick` omitted entirely (not
// just falsy) when not provided, so non-interactive rows skip the hover
// handlers and pointer cursor rather than faking an inert click target.
function QuizResultRow({ r, last, padding, onClick, C }) {
  const isVoca  = r.type === 'voca';
  const isCloze = r.type === 'cloze';
  const typeColor = isVoca ? C.accent : isCloze ? (C.success || '#7a9e6e') : (C.accent2 || C.success);
  const typeBg    = isVoca ? C.accentSoft : isCloze ? `${C.success || '#7a9e6e'}18` : (C.accent2Soft || `${C.success}18`);
  const typeLabel = isVoca ? 'Voca' : isCloze ? 'Cloze' : 'Grammar';
  const scoreColor = r.score >= 90 ? C.warning : r.score >= 70 ? C.accent : C.danger;

  const rowProps = onClick ? {
    onClick,
    onMouseEnter: e => e.currentTarget.style.background = `${C.accent}08`,
    onMouseLeave: e => e.currentTarget.style.background = 'transparent',
  } : {};

  return (
    <div
      {...rowProps}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: padding || '8px 0', borderBottom: last ? 'none' : `1px solid ${C.border}`,
        fontSize: '12.5px', cursor: onClick ? 'pointer' : 'default', transition: 'background 0.1s',
      }}
    >
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <span style={{
          fontSize: '10px', fontWeight: 600, textTransform: 'uppercase',
          padding: '2px 7px', borderRadius: '10px',
          color: typeColor, background: typeBg,
          }}>{typeLabel}</span>
        <span style={{ color: C.textM }}>{r.date?.split('T')[0]}</span>
      </div>
      <span style={{ fontFamily: SH.fm, color: scoreColor }}>
        {r.score}%
      </span>
    </div>
  );
}

// Builds a closed SVG polygon path for a variable-width ribbon trend line.
// Points must be pre-filtered (no nulls). Each point carries a `count`
// value; scaleHW maps count → half-width (the offset each side of center).
// Interior joints use a miter bisector so the ribbon tapers cleanly through
// each bend; the miter extension is capped at MAX_MITER× the half-width to
// prevent runaway spikes at very sharp corners.
function buildRibbonPath(points, scaleHW) {
  if (points.length < 2) return '';
  const n = points.length;
  const hws = points.map(p => scaleHW(p.count));
  const MAX_MITER = 3;

  // Segment direction angles (one per adjacent pair of points)
  const angles = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = points[i + 1].x - points[i].x;
    const dy = points[i + 1].y - points[i].y;
    const len = Math.sqrt(dx * dx + dy * dy);
    angles.push(len > 0 ? Math.atan2(dy, dx) : (angles[angles.length - 1] ?? 0));
  }

  const topRail = [], botRail = [];
  for (let i = 0; i < n; i++) {
    const hw = hws[i];
    if (i === 0) {
      // Start cap: perpendicular to first segment
      const nx = -Math.sin(angles[0]), ny = Math.cos(angles[0]);
      topRail.push({ x: points[i].x + hw * nx, y: points[i].y + hw * ny });
      botRail.push({ x: points[i].x - hw * nx, y: points[i].y - hw * ny });
    } else if (i === n - 1) {
      // End cap: perpendicular to last segment
      const nx = -Math.sin(angles[n - 2]), ny = Math.cos(angles[n - 2]);
      topRail.push({ x: points[i].x + hw * nx, y: points[i].y + hw * ny });
      botRail.push({ x: points[i].x - hw * nx, y: points[i].y - hw * ny });
    } else {
      // Interior joint: bisector of the two adjacent segment normals.
      // Miter offset = hw / (n1 · bisector_unit); clamped to avoid spikes.
      const n1x = -Math.sin(angles[i - 1]), n1y = Math.cos(angles[i - 1]);
      const n2x = -Math.sin(angles[i]),     n2y = Math.cos(angles[i]);
      const bx = n1x + n2x, by = n1y + n2y;
      const bLen = Math.sqrt(bx * bx + by * by);
      if (bLen < 0.001) {
        // Near U-turn — fall back to first segment's normal
        topRail.push({ x: points[i].x + hw * n1x, y: points[i].y + hw * n1y });
        botRail.push({ x: points[i].x - hw * n1x, y: points[i].y - hw * n1y });
      } else {
        const bnx = bx / bLen, bny = by / bLen;
        const dot = Math.max(n1x * bnx + n1y * bny, 1 / MAX_MITER);
        const miter = hw / dot;
        topRail.push({ x: points[i].x + miter * bnx, y: points[i].y + miter * bny });
        botRail.push({ x: points[i].x - miter * bnx, y: points[i].y - miter * bny });
      }
    }
  }

  // Top rail L→R, bottom rail R→L, closed
  const poly = [...topRail, ...[...botRail].reverse()];
  return poly.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') + ' Z';
}

function MiniLineChart({ data, width = 560, height = 180, C }) {
  if (!data || data.length < 2) return null;
  const n        = data.length;
  const pad      = { t: 16, r: 12, b: 36, l: 36 };
  const W        = width - pad.l - pad.r;
  const H        = height - pad.t - pad.b;
  const toX      = i => pad.l + (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const toY      = v => pad.t + H - (v / 100) * H;
  const gramColor = C.accent2 || C.success;

  // Combined cross-type trend ribbon — filled polygon via buildRibbonPath.
  // Quadratic scale keeps low-volume days thin and high-volume days bold:
  // 1 quiz → 2px half-width (4px band), 10+ quizzes → 16px half-width (32px band).
  const ALL_MIN_HW = 2, ALL_MAX_HW = 16, ALL_MAX_COUNT = 10;
  const scaleHalfWidth = (count) => {
    const t = Math.min(1, Math.max(0, (count - 1) / (ALL_MAX_COUNT - 1)));
    return ALL_MIN_HW + t * t * (ALL_MAX_HW - ALL_MIN_HW);
  };
  const allPoints = data
    .map((d, i) => (d.allScore != null ? { x: toX(i), y: toY(d.allScore), count: d.allCount || 1 } : null))
    .filter(Boolean);
  const allRibbonPath = buildRibbonPath(allPoints, scaleHalfWidth);

  const buildPath = (pts) => {
    const valid = pts.map((v, i) => v !== null ? { x: toX(i), y: toY(v) } : null).filter(Boolean);
    if (valid.length < 2) return '';
    return valid.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  };

  const vocaPoints = data.map(d => d.vocaScore ?? null);
  const gramPoints = data.map(d => d.gramScore ?? null);

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} style={{ overflow: 'visible' }}>
      {/* Grid */}
      {[0, 25, 50, 75, 100].map(v => (
        <g key={v}>
          <line x1={pad.l} y1={toY(v)} x2={pad.l + W} y2={toY(v)} stroke={C.border} strokeWidth="1" strokeDasharray="3,4" />
          <text x={pad.l - 6} y={toY(v) + 4} textAnchor="end" fontSize="9" fill={C.textM} fontFamily={SH.fm}>{v}</text>
        </g>
      ))}

      {/* X labels */}
      {data.map((d, i) => (n <= 10 || i % Math.ceil(n / 8) === 0) && (
        <text key={i} x={toX(i)} y={height - 4} textAnchor="middle" fontSize="9" fill={C.textM} fontFamily={SH.fm}>{d.dateLabel}</text>
      ))}

      {/* Combined cross-type trend — filled polygon ribbon, behind everything else */}
      {allRibbonPath && (
        <path d={allRibbonPath} fill={C.text} fillOpacity="0.18" stroke="none" />
      )}

      {/* Individual voca scatter points (◈, rendered before trend line) */}
      {data.map((d, i) => {
        const scores = d.vocaAll || (d.vocaScore !== null ? [d.vocaScore] : []);
        if (!scores.length) return null;
        return clusterScores(scores).map((pt, k) => (
          <text
            key={`vs-${i}-${k}`}
            x={(toX(i) + pt.xOffset).toFixed(1)}
            y={toY(pt.score).toFixed(1)}
            textAnchor="middle" dominantBaseline="middle"
            fontSize="9" fill={C.accent}
            opacity={pt.opacity.toFixed(2)}
            style={{ userSelect: 'none' }}
          >◈</text>
        ));
      })}

      {/* Individual gram scatter points (circle, rendered before trend line) */}
      {data.map((d, i) => {
        const scores = d.gramAll || (d.gramScore !== null ? [d.gramScore] : []);
        if (!scores.length) return null;
        return clusterScores(scores).map((pt, k) => (
          <circle
            key={`gs-${i}-${k}`}
            cx={(toX(i) + pt.xOffset).toFixed(1)}
            cy={toY(pt.score).toFixed(1)}
            r="3"
            fill={gramColor}
            opacity={pt.opacity.toFixed(2)}
          />
        ));
      })}

      {/* Trend lines */}
      {buildPath(vocaPoints) && (
        <path d={buildPath(vocaPoints)} fill="none" stroke={C.accent} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      )}
      {buildPath(gramPoints) && (
        <path d={buildPath(gramPoints)} fill="none" stroke={gramColor} strokeWidth="2" strokeDasharray="5,3" strokeLinejoin="round" strokeLinecap="round" />
      )}

      {/* Voca trend markers (◈, on top) */}
      {vocaPoints.map((v, i) => v !== null && (
        <text
          key={`vm-${i}`}
          x={toX(i).toFixed(1)} y={toY(v).toFixed(1)}
          textAnchor="middle" dominantBaseline="middle"
          fontSize="11" fill={C.accent}
          style={{ userSelect: 'none' }}
        >◈</text>
      ))}

      {/* Gram trend markers (circle, on top) */}
      {gramPoints.map((v, i) => v !== null && (
        <circle key={`gm-${i}`} cx={toX(i)} cy={toY(v)} r="3" fill={gramColor} />
      ))}
            {/* Cloze scatter points (✦) */}
            {data.map((d, i) => {
              const scores = d.clozeAll || (d.clozeScore !== null ? [d.clozeScore] : []);
              if (!scores.length) return null;
              return clusterScores(scores).map((pt, k) => (
                <text key={`cs-${i}-${k}`}
                  x={(toX(i) + pt.xOffset).toFixed(1)} y={toY(pt.score).toFixed(1)}
                  textAnchor="middle" dominantBaseline="middle"
                  fontSize="9" fill={C.danger || '#c97d3a'} opacity={pt.opacity.toFixed(2)}
                  style={{ userSelect: 'none' }}>✦</text>
              ));
            })}

            {/* Cloze trend line — rust, long dash */}
            {buildPath(data.map(d => d.clozeScore ?? null)) && (
              <path d={buildPath(data.map(d => d.clozeScore ?? null))}
                fill="none" stroke={C.danger || '#c97d3a'} strokeWidth="2"
                strokeDasharray="8,4" strokeLinejoin="round" strokeLinecap="round" />
            )}

            {/* Cloze trend markers (✦) */}
            {data.map((d, i) => d.clozeScore != null && (
              <text key={`cm-${i}`}
                x={toX(i).toFixed(1)} y={toY(d.clozeScore).toFixed(1)}
                textAnchor="middle" dominantBaseline="middle"
                fontSize="11" fill={C.danger || '#c97d3a'}
                style={{ userSelect: 'none' }}>✦</text>
            ))}
    </svg>
  );
}

function ReportCard({ results, C, S, dsh = 3 }) {
  const [range,          setRange]          = useState('30');
  const [selectedResult, setSelectedResult] = useState(null); // { result, detail }
  const [rawPage,        setRawPage]        = useState(0);

  const openResult = (r) => {
    setSelectedResult({ result: r, detail: null, detailLoading: !!r.id });
    if (!r.id) return;
    (async () => {
      let detail = null;
      try {
        const uid = auth.currentUser?.uid;
        if (uid) {
          const snap = await getDoc(fsDoc(db, 'users', uid, 'quiz_result_details', r.id));
          if (snap.exists()) detail = snap.data();
        }
      } catch (e) {
        console.error('ReportCard: detail fetch failed', e);
      }
      // Only apply if the popup is still showing this same result (guards
      // against a slow fetch landing after the user opened a different row)
      setSelectedResult(prev => (prev && prev.result.id === r.id) ? { ...prev, detail, detailLoading: false } : prev);
    })();
  };

  const filtered = useMemo(() => {
    if (range === 'all') return results;
    const cutoff = getLogicalToday(dsh);
    cutoff.setDate(cutoff.getDate() - parseInt(range));
    return results.filter(r => new Date(r.date) >= cutoff);
  }, [results, range, dsh]);

  const sortedFiltered = useMemo(() => [...filtered].reverse(), [filtered]);
  const totalPages = Math.max(1, Math.ceil(sortedFiltered.length / RC_PAGE_SIZE));
  const page       = Math.min(rawPage, Math.max(0, totalPages - 1));
  const pagedRows  = sortedFiltered.slice(page * RC_PAGE_SIZE, (page + 1) * RC_PAGE_SIZE);

  // ←/→ paginate the session log; disabled while the result detail popup is open.
  usePaginationKeys({
    page,
    totalPages,
    setPage: setRawPage,
    enabled: !selectedResult,
  });

  const chartData = useMemo(() => buildQuizChartData(filtered), [filtered]);
  const vocaR  = filtered.filter(r => r.type === 'voca');
  const gramR  = filtered.filter(r => r.type === 'grammar');
  const clozeR = filtered.filter(r => r.type === 'cloze');
  const avgV   = vocaR.length  ? Math.round(vocaR.reduce((s, r) => s + r.score, 0) / vocaR.length)   : null;
  const avgG   = gramR.length  ? Math.round(gramR.reduce((s, r) => s + r.score, 0) / gramR.length)   : null;
  const avgC   = clozeR.length ? Math.round(clozeR.reduce((s, r) => s + r.score, 0) / clozeR.length) : null;
  const rangeAvg   = filtered.length ? Math.round(filtered.reduce((s, r) => s + r.score, 0) / filtered.length) : null;
  const rangeLabel = range === 'all' ? 'All Time' : `${range}-Day`;

  // Masthead vitals — drawn from full unfiltered history, independent of the range toggle below
  const todayStr     = toDateStr(getLogicalToday(dsh));
  const mastheadDate = new Date(todayStr + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const last7        = results.filter(r => { const c = getLogicalToday(dsh); c.setDate(c.getDate() - 7); return new Date(r.date) >= c; });
  const last7Avg     = last7.length ? Math.round(last7.reduce((s, r) => s + r.score, 0) / last7.length) : null;

  const lead = useMemo(() => getQuizLeadStory({ results, today: todayStr }), [results, todayStr]);

  return (
    <div className="fade-up" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <GazetteMasthead
        cornerLeft={{ value: `${results.length} Session${results.length === 1 ? '' : 's'}`, label: last7Avg != null ? `${last7Avg}% This Week` : 'No Sessions This Week' }}
        cornerRight={{ value: mastheadDate, label: todayStr.slice(0, 4) }}
        title="The Examiner"
        subtitle="A Record of Scores, Sessions, and Standing"
        isMobile={isMobile}
      />
      <GoldRule />
      <BylineRule left="autovocaindex / quizzes" right={todayStr} />

      {/* Lead story */}
      <div>
        <GazetteKicker>{lead.kicker}</GazetteKicker>
        <GazetteHeadline>{lead.headline}</GazetteHeadline>
        {lead.standfirst && <GazetteStandfirst>{lead.standfirst}</GazetteStandfirst>}
        <DropCapLead text={lead.leadParagraph} columns={isMobile ? 1 : 2} />
      </div>

      {/* Score trend — range toggle, chart, per-type breakdown */}
      <div>
        <GazetteKicker>Score Trend</GazetteKicker>
        <GazetteHeadline size="md">
          {rangeAvg !== null
            ? `${rangeLabel} Average: ${rangeAvg}%`
            : `No Sessions In ${rangeLabel === 'All Time' ? 'This Range' : `The Last ${range} Days`}`}
        </GazetteHeadline>

        <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
          {['7', '30', '90', 'all'].map(r => (
            <ToggleChip key={r} label={r === 'all' ? 'All time' : `${r}d`} active={range === r} onClick={() => setRange(r)} C={C} />
          ))}
        </div>

        {chartData.length >= 2 ? (
          <GazetteFig caption={`${rangeLabel === 'All Time' ? 'All-time' : `Last ${range} days`} — Vocabulary, Cloze, and Grammar scores`}>
            <MiniLineChart data={chartData} width={560} height={160} C={C} />
            <div style={{ display: 'flex', gap: '16px', marginTop: '8px', justifyContent: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: C.textM }}>
                <div style={{ width: '20px', height: '2px', background: C.accent }} /> Vocabulary
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: C.textM }}>
                <div style={{ width: '20px', height: '0', borderTop: `2px dashed ${C.accent2 || C.success}` }} /> Grammar
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: C.textM }}>
                <span style={{ color: C.danger || '#c97d3a', fontWeight: 700, letterSpacing: '1px' }}>— —</span> Cloze
              </div>
            </div>
          </GazetteFig>
        ) : (
          <div style={{ fontSize: '12px', color: C.textM, fontStyle: 'italic', padding: '14px 0' }}>Not enough history in this range yet.</div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr 1fr', gap: '12px', marginTop: '16px' }}>
          {avgV !== null && (
            <div style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '12px', padding: '16px', textAlign: 'center' }}>
              <div style={{ fontFamily: SH.fm, fontSize: '22px', color: C.accent }}>{avgV}%</div>
              <div style={{ fontSize: '11px', color: C.textM, marginTop: '4px' }}>Avg vocabulary score</div>
            </div>
          )}
          {avgC !== null && (
            <div style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '12px', padding: '16px', textAlign: 'center' }}>
              <div style={{ fontFamily: SH.fm, fontSize: '22px', color: C.danger }}>{avgC}%</div>
              <div style={{ fontSize: '11px', color: C.textM, marginTop: '4px' }}>Avg cloze score</div>
            </div>
          )}
          {avgG !== null && (
            <div style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '12px', padding: '16px', textAlign: 'center' }}>
              <div style={{ fontFamily: SH.fm, fontSize: '22px', color: C.accent2 || C.success }}>{avgG}%</div>
              <div style={{ fontSize: '11px', color: C.textM, marginTop: '4px' }}>Avg grammar score</div>
            </div>
          )}
        </div>
      </div>

      {/* Session log */}
      <div>
        <GazetteKicker>Session Log</GazetteKicker>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 240px', gap: '20px' }}>
          <div>
            {pagedRows.length > 0 ? (
              <>
                <div style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '12px', overflow: 'hidden' }}>
                  {pagedRows.map((r, i, arr) => (
                    <QuizResultRow
                      key={r.id || i}
                      r={r}
                      last={i === arr.length - 1}
                      padding="10px 16px"
                      onClick={() => openResult(r)}
                      C={C}
                    />
                  ))}
                </div>
                <PaginationFooter
                  page={page}
                  totalPages={totalPages}
                  count={sortedFiltered.length}
                  singular="quiz"
                  onFirst={() => setRawPage(0)}
                  onPrev={() => setRawPage(p => Math.max(0, p - 1))}
                  onNext={() => setRawPage(p => Math.min(totalPages - 1, p + 1))}
                  onLast={() => setRawPage(totalPages - 1)}
                  C={C}
                />
              </>
            ) : (
              <div style={{ fontSize: '12px', color: C.textM, fontStyle: 'italic', padding: '14px 0' }}>No sessions in this range.</div>
            )}
          </div>

          <GazetteBox title="By The Numbers">
            <BoxRow label="Sessions" value={filtered.length} />
            <BoxRow label="Best Score" value={filtered.length ? `${Math.max(...filtered.map(r => r.score))}%` : '—'} />
            <BoxRow label="Most Recent" value={sortedFiltered[0] ? `${sortedFiltered[0].score}%` : '—'} />
            <BoxRow label="Perfect Scores" value={filtered.filter(r => r.score === 100).length} />
          </GazetteBox>
        </div>
      </div>

      {/* Result detail popup — portaled to document.body so it anchors to the
          real viewport, not to this page's .fade-up wrapper (a persisting
          `transform: translateY(0)` from that animation's fill-mode:both
          creates a new containing block for position:fixed descendants,
          which otherwise centers the popup against the whole page's height
          instead of the visible viewport) */}
      {selectedResult && createPortal(
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 200,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
        }} onClick={() => setSelectedResult(null)}>
          <div
            style={{
              ...S.modal, maxWidth: '640px', maxHeight: 'min(80vh, calc(100dvh - 32px))',
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <div>
                <span style={{
                  fontSize: '10px', fontWeight: 600, textTransform: 'uppercase',
                  padding: '2px 7px', borderRadius: '10px', marginRight: '8px',
                  color: selectedResult.result.type === 'voca' ? C.accent : selectedResult.result.type === 'cloze' ? (C.danger || '#c0553a') : (C.accent2 || C.success),
                  background: selectedResult.result.type === 'voca' ? C.accentSoft : selectedResult.result.type === 'cloze' ? `${C.danger || '#c0553a'}18` : (C.accent2Soft || `${C.success}18`),
                  }}>
                  {selectedResult.result.type === 'voca' ? 'Voca' : selectedResult.result.type === 'cloze' ? 'Cloze' : 'Grammar'}
                </span>
                <span style={{ fontSize: '12px', color: C.textM }}>{selectedResult.result.date?.split('T')[0]}</span>
              </div>
              <span style={{ fontFamily: SH.fm, fontSize: '24px', color: selectedResult.result.score >= 90 ? C.warning : selectedResult.result.score >= 70 ? C.accent : C.danger }}>
                {selectedResult.result.score}%
              </span>
            </div>

            {/* Grammar result detail */}
            {selectedResult.detail?.type === 'grammar' && selectedResult.detail.questions && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                {selectedResult.detail.questions.map((q, i) => {
                  const a  = selectedResult.detail.assessment?.[i];
                  const vs = a ? VERDICT_STYLE[a.verdict] || VERDICT_STYLE['X'] : null;
                  return (
                    <div key={i} style={{
                      background: C.raised, border: `1px solid ${C.border}`, borderRadius: '12px',
                      padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '10px',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
                        <div style={{ fontSize: '14px', color: C.text, lineHeight: 1.5, flex: 1 }}>{q.english}</div>
                        {vs && <div style={{ fontFamily: SH.fm, fontSize: '22px', color: vs.color, flexShrink: 0 }}>{vs.symbol}</div>}
                      </div>
                      {q.correctConcept?.term && (
                        <div style={{ fontSize: '12px', color: C.accent, fontFamily: SH.fk, background: C.accentSoft, borderRadius: '6px', padding: '4px 10px', alignSelf: 'flex-start' }}>
                          {q.correctConcept.term}
                        </div>
                      )}
                      <div style={{ fontFamily: SH.fk, fontSize: '13.5px', color: C.text, lineHeight: 1.6 }}>
                        {selectedResult.detail.translations?.[i] || <span style={{ color: C.textM, fontStyle: 'italic' }}>No translation entered</span>}
                      </div>
                      {a?.corrected && (
                        <div style={{ fontFamily: SH.fk, fontSize: '13px', color: C.textS, lineHeight: 1.6, padding: '7px 10px', background: `${C.accent}0e`, borderRadius: '7px', borderLeft: `3px solid ${C.accent}` }}>
                          {a.corrected}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Voca / Cloze detail — read straight from the result doc's meta
                (missedDetail, Stage A-4); no separate detail doc exists or is
                needed for these types. Older sessions fall back to the capped
                missedTerms list; oldest sessions have neither. */}
            {selectedResult.result.type !== 'grammar' && (() => {
              const meta   = selectedResult.result.meta || {};
              const detail = Array.isArray(meta.missedDetail) ? meta.missedDetail : null;
              const terms  = Array.isArray(meta.missedTerms)  ? meta.missedTerms  : null;
              const header = (
                <div style={{ fontSize: '13px', color: C.textM, textAlign: 'center', marginBottom: '14px' }}>
                  {selectedResult.result.correct} / {selectedResult.result.total} correct
                </div>
              );
              if (detail && detail.length > 0) {
                return (
                  <div>
                    {header}
                    <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.textM, marginBottom: '10px' }}>
                      Missed items
                    </div>
                    <div style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '12px', padding: '4px 16px' }}>
                      {detail.map((d, i) => (
                        <div key={i} style={{
                          fontSize: '13px', lineHeight: 1.55, color: C.textS,
                          paddingTop: '8px', paddingBottom: '8px', paddingLeft: '16px', textIndent: '-16px',
                          borderBottom: i < detail.length - 1 ? `1px solid ${C.border}` : 'none',
                        }}>
                          <span style={{ whiteSpace: 'nowrap' }}>
                            <span style={{ fontFamily: SH.fk, color: C.text }}>{d.term}</span>
                            <span style={{ color: C.textM }}> —</span>
                          </span>
                          {' '}
                          {d.answer || <span style={{ fontStyle: 'italic', color: C.textM }}>no stored answer</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              }
              if (detail) {
                return (
                  <div>
                    {header}
                    <div style={{ fontSize: '13px', color: C.textM, textAlign: 'center', padding: '4px 0' }}>
                      Nothing missed — a clean session.
                    </div>
                  </div>
                );
              }
              if (terms && terms.length > 0) {
                return (
                  <div>
                    {header}
                    <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.textM, marginBottom: '10px' }}>
                      Missed terms
                    </div>
                    <div style={{ fontFamily: SH.fk, fontSize: '13.5px', color: C.text, lineHeight: 1.8 }}>
                      {terms.join('  ·  ')}
                    </div>
                    <div style={{ fontSize: '11px', color: C.textM, marginTop: '8px', opacity: 0.7 }}>
                      Logged before answer recording was added — terms only, capped at five.
                    </div>
                  </div>
                );
              }
              return (
                <div style={{ fontSize: '13px', color: C.textM, textAlign: 'center', padding: '20px 0' }}>
                  {selectedResult.result.correct} / {selectedResult.result.total} correct
                  <div style={{ fontSize: '12px', marginTop: '8px', opacity: 0.6 }}>No per-question record was kept for this session.</div>
                </div>
              );
            })()}

            {/* Detail still loading (grammar only — voca/cloze render from meta above) */}
            {selectedResult.result.type === 'grammar' && selectedResult.detailLoading && (
                          <div style={{ fontSize: '13px', color: C.textM, textAlign: 'center', padding: '20px 0' }}>
                            Loading…
                          </div>
            )}

            {/* No detail stored (grammar only) */}
            {selectedResult.result.type === 'grammar' && !selectedResult.detailLoading && !selectedResult.detail && (
                          <div style={{ fontSize: '13px', color: C.textM, textAlign: 'center', padding: '20px 0' }}>
                            {selectedResult.result.correct} / {selectedResult.result.total} correct
                            <div style={{ fontSize: '12px', marginTop: '8px', opacity: 0.6 }}>Full result detail is only available for quizzes taken after this feature was added.</div>
                          </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '20px' }}>
              <button style={S.btnGhost} onClick={() => setSelectedResult(null)}>Close</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

function buildClozeQuestions(sentenceCards, wordInputForms, config, lemmaMaster) {
  // Drop cards where inputForm doesn't appear at a word boundary in the sentence
  const pool = sentenceCards.filter(c =>
    c.sentence && c.inputForm && findClozeTokenIndex(c.sentence, c.inputForm) !== -1
  );
  if (pool.length === 0) return [];

  const count   = Math.min(config.questionCount, pool.length);
  const sampled = weightedSample(pool, count);

  if (config.mode === 'type') {
    return sampled.map(card => {
      const { relatedFormLemmas, relatedMeaningLemmas } = resolveRelatedLemmas(card, lemmaMaster);
      return {
        type: 'cloze_type',
        card,
        sentence:  card.sentence,
        inputForm: card.inputForm,
        lemma:     card.lemma || '',
        hint:      card.back  || '',
        relatedFormLemmas,
        relatedMeaningLemmas,
        answered: false, userAnswer: null, isCorrect: null,
      };
    });
  }

  // Select mode — distractor pool is all word input surface forms from the same source(s)
  const uniqueInputs = [...new Set(wordInputForms)];

  return sampled.map(card => {
    const { relatedFormLemmas, relatedMeaningLemmas } = resolveRelatedLemmas(card, lemmaMaster);
    const correct     = card.inputForm;
    const others      = shuffleArray(uniqueInputs.filter(f => f !== correct));
    const distractors = others.slice(0, config.choiceCount - 1);
    const choices     = shuffleArray([correct, ...distractors]);
    return {
      type: 'cloze_select',
      card,
      sentence:  card.sentence,
      inputForm: card.inputForm,
      lemma:     card.lemma || '',
      hint:      card.back  || '',
      correct,
      choices,
      relatedFormLemmas,
      relatedMeaningLemmas,
      answered: false, userAnswer: null, isCorrect: null,
    };
  });
}

// ── Sentence display with blank ───────────────────────────────
// Replaces inputForm with a styled blank. Used in both modes.
function SentenceWithBlank({ sentence, inputForm, revealed, revealedText, C }) {
  if (!sentence || !inputForm) {
    return (
      <div style={{ fontFamily: SH.fk, fontSize: '20px', color: C.text, lineHeight: 1.6 }}>
        {sentence}
      </div>
    );
  }

  const idx = findClozeTokenIndex(sentence, inputForm);
  if (idx === -1) {
    return (
      <div style={{ fontFamily: SH.fk, fontSize: '20px', color: C.text, lineHeight: 1.6 }}>
        {sentence}
      </div>
    );
  }

  const before = sentence.slice(0, idx);
  const after  = sentence.slice(idx + inputForm.length);
  const blankW = Math.max(60, inputForm.length * 14);

  return (
    <div style={{ fontFamily: SH.fk, fontSize: '20px', color: C.text, lineHeight: 1.8, wordBreak: 'keep-all' }}>
      {before}
      {revealed ? (
        <span style={{
          color: C.accent, fontWeight: 700,
          borderBottom: `2px solid ${C.accent}`,
          padding: '0 2px',
        }}>
          {revealedText || inputForm}
        </span>
      ) : (
        <span style={{
          display: 'inline-block',
          width:   `${blankW}px`,
          borderBottom: `2.5px solid ${C.accent}`,
          margin: '0 2px',
          verticalAlign: 'bottom',
          minWidth: '40px',
        }} />
      )}
      {after}
    </div>
  );
}

function ClozeQuizConfig({ open, sentenceDecks, allSentenceDecks, onStart, onBack, C, S }) {
  const [config, setConfig] = useState(() => loadConfig(CLOZE_CONFIG_KEY, CLOZE_DEFAULTS));

  const set = (key, val) => setConfig(prev => {
    const next = { ...prev, [key]: val };
    saveConfig(CLOZE_CONFIG_KEY, next);
    return next;
  });

  const toggleDeck = (id) => {
    set('deckIds', config.deckIds.includes(id)
      ? config.deckIds.filter(d => d !== id)
      : [...config.deckIds, id]);
  };

  const canStart = sentenceDecks.length > 0;

  if (!open) return null;

  return createPortal(
    <div style={S.overlay} onClick={e => { if (e.target === e.currentTarget) onBack(); }}>
      <div style={S.modal} className="slide-up">
        <div style={{ ...S.modalHeader, marginBottom: '16px' }}>
          <span style={S.modalTitle}>Cloze Quiz</span>
          <button
            onClick={onBack}
            style={{ background: 'none', border: 'none', color: C.textM, cursor: 'pointer', fontSize: '18px', padding: '2px' }}
          >
            ✕
          </button>
        </div>

        <div style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '16px', padding: '0 20px', marginBottom: '20px' }}>

          {/* Mode */}
          <ConfigRow label="Mode" C={C}>
            <ToggleChip label="Type"   active={config.mode === 'type'}   onClick={() => set('mode', 'type')}   C={C} />
            <ToggleChip label="Select" active={config.mode === 'select'} onClick={() => set('mode', 'select')} C={C} />
          </ConfigRow>

          {/* Choice count — only for Select mode */}
          {config.mode === 'select' && (
            <ConfigRow label="Answer options" C={C}>
              {[2, 3, 4, 6].map(n => (
                <ToggleChip key={n} label={`${n} choices`} active={config.choiceCount === n} onClick={() => set('choiceCount', n)} C={C} />
              ))}
            </ConfigRow>
          )}

          {/* Question count */}
          <ConfigRow label="Questions" C={C}>
            <Stepper value={config.questionCount} onChange={v => set('questionCount', v)} min={1} max={50} C={C} />
          </ConfigRow>

          {/* Deck filter */}
            {!DEMO && sentenceDecks.length > 0 && (
            <ConfigRow label="Card pools" C={C} noBorder>
              <ToggleChip label="All decks" active={config.deckIds.length === 0} onClick={() => set('deckIds', [])} C={C} />
              {sentenceDecks.map(d => (
                <ToggleChip
                  key={d.id}
                  label={d.name.replace(' (sentence mining)', '')}
                  active={config.deckIds.includes(d.id)}
                  onClick={() => toggleDeck(d.id)}
                  C={C}
                />
              ))}
            </ConfigRow>
          )}
        </div>

        {!canStart && (
          <div style={{ ...S.infoBox, marginBottom: '16px' }}>
            No sentence mining cards found. Add sentences via AVI Sentence Input first.
          </div>
        )}

        <button
          style={{ ...S.btnPrimary, width: '100%', justifyContent: 'center', padding: '12px', fontSize: '14px', opacity: canStart ? 1 : 0.5 }}
          onClick={() => canStart && onStart(config)}
          disabled={!canStart}
        >
          Start Quiz
        </button>
      </div>
    </div>,
    document.body
  );
}

function ClozeTypeQ({ q, onAnswer, onOverride, onRelatedOverride, C, S }) {
  const [input,             setInput]             = useState('');
  const [submitted,         setSubmitted]         = useState(false);
  const [hintShown,         setHintShown]         = useState(false);
  const [credit,            setCredit]            = useState(null);
  const [overridden,        setOverridden]        = useState(false);
  const [isRelatedPath,     setIsRelatedPath]     = useState(false);
  const [relatedOverridden, setRelatedOverridden] = useState(false);
  const [relatedOverrideCr, setRelatedOverrideCr] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleSubmit = () => {
    if (!input.trim() || submitted) return;
    const spellingCr = computeClozeCredit(input.trim(), q.inputForm);
    const relCr      = computeRelatedCredit(input.trim(), q.relatedFormLemmas, q.relatedMeaningLemmas);
    const cr = Math.max(spellingCr, relCr);
    setCredit(cr);
    setIsRelatedPath(relCr > 0 && relCr >= spellingCr);
    setSubmitted(true);
    quizSound(cr >= 1.0 ? 'warble' : 'quiz_wrong');
    onAnswer(input.trim(), cr);
  };

  const handleOverrideClick = () => {
    setOverridden(true);
    onOverride?.();
  };

  const handleRelatedClick = () => {
    // Cloze has no hint penalty system — flat 0.5
    setRelatedOverrideCr(0.5);
    setRelatedOverridden(true);
    onRelatedOverride?.(0.5);
  };

  const anyOverridden   = overridden || relatedOverridden;
  const effectiveCredit = overridden
    ? 1.0
    : relatedOverridden
      ? (relatedOverrideCr ?? 0)
      : (credit ?? 0);
  const isFullCredit    = effectiveCredit >= 1.0;
  const isPartial       = effectiveCredit > 0 && effectiveCredit < 1.0;
  const showOverrideBtn = submitted && !anyOverridden && credit < 1.0;
  const showRelatedBtn  = submitted && !anyOverridden && credit < 1.0;

  const feedbackColor = overridden || isFullCredit ? C.warning : isPartial ? C.accent : C.danger;
  const feedbackBg    = overridden || isFullCredit ? `${C.warning}18` : isPartial ? `${C.accent}14` : `${C.danger}14`;
  const feedbackBorder= overridden || isFullCredit ? `${C.warning}44` : isPartial ? `${C.accent}44` : `${C.danger}44`;

  const feedbackLabel = overridden
    ? 'Overridden — full credit'
    : isFullCredit
      ? 'Correct'
      : isPartial
        ? (relatedOverridden || isRelatedPath)
            ? `Partial — Related (${formatScore(effectiveCredit * 100)}%)`
            : `Partial — spelling (${formatScore(effectiveCredit * 100)}%)`
        : `Incorrect — answer: ${q.inputForm}`;

  return (
    <>
      <div style={{
        background: C.raised, border: `1px solid ${C.border}`, borderRadius: '16px',
        padding: '24px 28px', marginBottom: '16px',
      }}>
        <SentenceWithBlank
          sentence={q.sentence}
          inputForm={q.inputForm}
          revealed={submitted}
          revealedText={submitted ? q.inputForm : null}
          C={C}
        />
      </div>

      {q.hint && (
        <div style={{ marginBottom: '14px' }}>
          <button
            onClick={() => setHintShown(v => !v)}
            style={{ fontSize: '12px', color: C.textM, background: 'none', border: `1px solid ${C.border}`, borderRadius: '6px', padding: '3px 10px', cursor: 'pointer' }}
          >
            {hintShown ? 'Hide hint' : 'Show hint'}
          </button>
          {hintShown && (
            <div style={{ marginTop: '8px', fontSize: '13px', color: C.textS, fontStyle: 'italic', lineHeight: 1.5 }}>
              {q.hint}
            </div>
          )}
        </div>
      )}

      {!submitted ? (
        <>
          <input
            ref={inputRef}
            lang="ko"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
            placeholder="Type the missing word…"
            style={{
                          // 16px on mobile prevents the iOS focus auto-zoom (see voca Type input)
                          width: '100%', padding: '12px 14px', borderRadius: '10px', fontSize: isMobile ? '16px' : '15px',
              border: `1.5px solid ${C.border}`, background: C.bg, color: C.text,
              fontFamily: SH.fk, outline: 'none', boxSizing: 'border-box', marginBottom: '10px',
            }}
          />
          <button
            onClick={handleSubmit}
            disabled={!input.trim()}
            style={{ ...S.btnPrimary, width: '100%', justifyContent: 'center', padding: '11px', fontSize: '14px', opacity: input.trim() ? 1 : 0.5 }}
          >
            Submit
          </button>
        </>
      ) : (
        <div style={{
          background: feedbackBg, border: `1px solid ${feedbackBorder}`,
          borderRadius: '12px', padding: '14px 16px',
        }} className="fade-up quiz-session">
          <div style={{
            fontSize: '11px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
            color: feedbackColor, marginBottom: (overridden || isFullCredit) ? 0 : '8px',
          }}>
            {feedbackLabel}
          </div>
          {!overridden && !isFullCredit && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginTop: '6px' }}>
              <div>
                <div style={{ fontSize: '11px', color: C.textM, marginBottom: '4px' }}>You typed</div>
                <div style={{ fontFamily: SH.fk, fontSize: '15px', color: feedbackColor }}>{input.trim()}</div>
              </div>
              <div>
                <div style={{ fontSize: '11px', color: C.textM, marginBottom: '4px' }}>Correct</div>
                <div style={{ fontFamily: SH.fk, fontSize: '15px', color: C.textS }}>{q.inputForm}</div>
              </div>
            </div>
          )}
          {(showRelatedBtn || showOverrideBtn) && (
            <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
              {showRelatedBtn && (
                <button
                  onClick={handleRelatedClick}
                  style={{
                    fontSize: '12px', color: C.accent,
                    background: C.accentSoft, border: `1px solid ${C.accent}44`,
                    borderRadius: '6px', padding: '4px 12px', cursor: 'pointer',
                  }}
                >
                  Related
                </button>
              )}
              {showOverrideBtn && (
                <button
                  onClick={handleOverrideClick}
                  style={{
                    fontSize: '12px', color: C.accent,
                    background: C.accentSoft, border: `1px solid ${C.accent}44`,
                    borderRadius: '6px', padding: '4px 12px', cursor: 'pointer',
                  }}
                >
                  Mark as correct
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function ClozeSelectQ({ q, onAnswer, C }) {
  const [submitted, setSubmitted] = useState(false);
  const [chosen,    setChosen]    = useState(null);
  const [hintShown, setHintShown] = useState(false);

  const handleChoice = (choice) => {
    if (submitted) return;
    const isCorrect = choice === q.correct;
    setChosen(choice);
    setSubmitted(true);
    quizSound(isCorrect ? 'warble' : 'quiz_wrong');
    onAnswer(choice, isCorrect ? 1.0 : 0.0);
  };

  // Digit keys 1–N pick the corresponding choice before submission
  useGlobalKey(e => {
    const n = parseInt(e.key);
    if (!isNaN(n) && n >= 1 && n <= q.choices.length) handleChoice(q.choices[n - 1]);
  }, { enabled: !submitted });

  return (
    <>
      {/* Sentence with blank */}
            <div style={{
              background: C.raised, border: `1px solid ${C.border}`, borderRadius: '16px',
              padding: '24px 28px', marginBottom: '14px',
            }}>
              <SentenceWithBlank
          sentence={q.sentence}
          inputForm={q.inputForm}
          revealed={submitted}
          revealedText={submitted ? q.correct : null}
          C={C}
        />
      </div>

      {/* Hint toggle */}
      {q.hint && (
        <div style={{ marginBottom: '14px' }}>
          <button
            onClick={() => setHintShown(v => !v)}
            style={{ fontSize: '12px', color: C.textM, background: 'none', border: `1px solid ${C.border}`, borderRadius: '6px', padding: '3px 10px', cursor: 'pointer' }}
          >
            {hintShown ? 'Hide hint' : 'Show hint'}
          </button>
          {hintShown && (
            <div style={{ marginTop: '8px', fontSize: '13px', color: C.textS, fontStyle: 'italic', lineHeight: 1.5 }}>
              {q.hint}
            </div>
          )}
        </div>
      )}

      {/* Choices */}
      <div style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textM, marginBottom: '10px' }}>
        Choose the missing word
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {q.choices.map((choice, i) => {
          let borderColor = C.border, bgColor = 'transparent', textColor = C.text, borderWidth = '1.5px';
          if (submitted) {
            if (choice === q.correct) {
              borderColor = C.warning; bgColor = `${C.warning}18`; textColor = C.warning;
              borderWidth = chosen !== q.correct ? '2.5px' : '1.5px';
            } else if (choice === chosen) {
              borderColor = C.danger; bgColor = `${C.danger}12`; textColor = C.danger;
            } else {
              textColor = C.textM;
            }
          }
          return (
            <button key={i} onClick={() => handleChoice(choice)} style={{
              width: '100%', textAlign: 'left', padding: '12px 18px',
              borderRadius: '10px', border: `${borderWidth} solid ${borderColor}`,
              background: bgColor, color: textColor, fontSize: '14px',
              cursor: submitted ? 'default' : 'pointer', transition: 'all 0.15s',
              fontFamily: SH.fk,
            }}>
              {choice}
            </button>
          );
        })}
      </div>
    </>
  );
}

function ClozeQuizSession({ questions: initialQuestions, onFinish, C, S }) {
  const [questions, setQuestions] = useState(initialQuestions);
  const [idx,       setIdx]       = useState(0);
  const [waiting,   setWaiting]   = useState(false);

  const total    = questions.length;
  const answered = questions.filter(q => q.answered).length;
  const progressPct = total > 0 ? Math.min((answered / total) * 100, 100) : 0;

  const getCredit = q => q.credit ?? (q.isCorrect ? 1.0 : 0.0);

  const handleAnswer = (userAnswer, credit) => {
     // credit is a number (1.0 / 0.5 / 0.0) for cloze_type; boolean-derived for cloze_select
     const cr        = typeof credit === 'number' ? credit : (credit ? 1.0 : 0.0);
     const isCorrect = cr >= 1.0;
     const updated   = questions.map((q, i) =>
        i === idx ? { ...q, answered: true, userAnswer, isCorrect, credit: cr } : q
     );
     setQuestions(updated);
     setWaiting(true);
  };

  const handleOverride = () => {
     setQuestions(prev => prev.map((q, i) =>
        i === idx ? { ...q, credit: 1.0, isCorrect: true } : q
     ));
  };

  const handleRelatedOverride = (newCredit) => {
    setQuestions(prev => prev.map((q, i) =>
      i === idx ? { ...q, credit: newCredit, isCorrect: false } : q
    ));
  };

  const advance = () => {
    if (idx + 1 >= questions.length) {
      const creditSum = questions.reduce((s, q) => s + getCredit(q), 0);
      onFinish(questions, creditSum, questions.length);
    } else {
      setIdx(prev => prev + 1);
      setWaiting(false);
    }
  };

  // Enter key advances when waiting (after answer submitted, before Next click)
  useGlobalKey(e => {
    if (e.key === 'Enter') advance();
  }, { enabled: waiting });

  const q = questions[idx];
  if (!q) return null;

  return (
    <div style={{ maxWidth: '620px', margin: '0 auto' }} className="fade-up quiz-session">
      {/* Progress bar */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 10,
        background: C.bg || C.surface,
        paddingBottom: '12px', paddingTop: '4px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ flex: 1, height: '4px', background: `${C.accent}22`, borderRadius: '2px' }}>
            <div style={{ height: '100%', width: `${progressPct}%`, background: C.accent, borderRadius: '2px', transition: 'width 0.3s' }} />
          </div>
          <span style={{ fontFamily: SH.fm, fontSize: '11px', color: C.textM, flexShrink: 0 }}>
            {answered} / {total}
          </span>
          <button
            onClick={() => {
              const creditSum = questions.reduce((s, q) => s + getCredit(q), 0);
              onFinish(questions, creditSum, questions.filter(q => q.answered).length || 1);
            }}
            style={{ fontSize: '12px', color: C.textM, padding: '3px 10px', borderRadius: '6px', border: `1px solid ${C.border}`, background: 'transparent', cursor: 'pointer', flexShrink: 0 }}
          >
            End
          </button>
        </div>
      </div>

      {q.type === 'cloze_type'   && <ClozeTypeQ   key={idx} q={q} onAnswer={handleAnswer} onOverride={handleOverride} onRelatedOverride={handleRelatedOverride} C={C} S={S} />}
      {q.type === 'cloze_select' && <ClozeSelectQ key={idx} q={q} onAnswer={handleAnswer} C={C} />}

      {waiting && (
        <div style={{ marginTop: '16px', display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={advance} style={{ ...S.btnPrimary, padding: '10px 24px' }}>
            {idx + 1 >= total ? 'See results' : 'Next'}
          </button>
        </div>
      )}
    </div>
  );
}

function ClozeQuizResults({ questions, correct, total, onDone, C, S }) {
  const rawPct = total > 0 ? correct / total * 100 : 0;
  const pct    = formatScore(Math.round(rawPct * 10) / 10);

  const answered       = questions.filter(q => q.answered);
  const getCredit      = q => q.credit ?? (q.isCorrect ? 1.0 : 0.0);
  const correctCount   = answered.filter(q => getCredit(q) >= 1.0).length;
  const partialQs      = answered.filter(q => { const c = getCredit(q); return c > 0 && c < 1.0; });
  const incorrectQs    = answered.filter(q => getCredit(q) === 0);

  // Combine partial + wrong for the review list (overrides happened during session)
  const reviewItems = answered.filter(q => getCredit(q) < 1.0);

  return (
    <div style={{ maxWidth: '560px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '24px' }} className="fade-up quiz-session">
      <div style={{ textAlign: 'center' }}>
                <div style={{ fontFamily: SH.fd, fontSize: '40px', color: C.accent }}>{pct}%</div>
        {rawPct >= 90 && <div style={{ marginTop: '10px', fontSize: '13px', color: C.warning, fontWeight: 500 }}>Excellent!</div>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
        {[
          { label: 'Correct',   value: correctCount,      color: C.warning },
          { label: 'Partial',   value: partialQs.length,  color: C.danger  },
          { label: 'Incorrect', value: incorrectQs.length, color: C.danger  },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '12px', padding: '16px', textAlign: 'center' }}>
            <div style={{ fontFamily: SH.fm, fontSize: '24px', color }}>{value}</div>
            <div style={{ fontSize: '11px', color: C.textM, marginTop: '4px' }}>{label}</div>
          </div>
        ))}
      </div>

      {reviewItems.length > 0 && (
        <div>
          <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.textM, marginBottom: '10px' }}>
            Review
          </div>
          <div style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '12px', overflow: 'hidden' }}>
            {reviewItems.map((q, i) => {
              const cr = getCredit(q);
              const isPartial = cr > 0 && cr < 1.0;
              return (
                <div key={i} style={{
                  display: 'flex', flexDirection: 'column', gap: '6px',
                  padding: '12px 16px', borderBottom: i < reviewItems.length - 1 ? `1px solid ${C.border}` : 'none',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily: SH.fk, fontSize: '13.5px', color: C.text }}>{q.inputForm}</div>
                      <div style={{ fontSize: '12px', color: C.textM, marginTop: '2px', fontStyle: 'italic' }}>{q.lemma}</div>
                    </div>
                    <div style={{ fontSize: '11px', color: isPartial ? C.accent : C.danger, textAlign: 'right', flexShrink: 0, fontWeight: 600 }}>
                      {isPartial ? `Partial (${formatScore(cr * 100)}%)` : 'Incorrect'}
                    </div>
                  </div>
                  {q.userAnswer && (
                    <div style={{ fontSize: '12px', color: C.textM }}>
                      You typed: <span style={{ fontFamily: SH.fk, color: isPartial ? C.accent : C.danger }}>{q.userAnswer}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button style={S.btnGhost} onClick={onDone}>Back to Quizzes</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// MAIN QUIZZES PAGE
// ─────────────────────────────────────────────────────────────
// cards and decks come from App via shared useFlashcardData — no duplicate reads.
// Only quiz_results is loaded here (quiz-specific, not shared with Flashcards).
const QR_PREFIX = 'avi_quiz_results_';
function qrRead(key)      { try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : null; } catch { return null; } }
function qrWrite(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }

export function QuizzesPage({ soundProfile, quizSoundsEnabled = true, cards: propCards, decks: propDecks, settings }) {
  const { C, S } = useAppTheme();
  const uid = auth.currentUser?.uid;
  // Keep module-level ref current so every sub-component in this file reads
  // the correct enabled state without receiving it as a prop.
  _quizSoundsRef.current = quizSoundsEnabled;
  const dsh = settings?.dayStartHour ?? 3;

  const [view,      setView]      = useState('home');
  const [configModal, setConfigModal] = useState(null); // null | 'voca' | 'cloze' | 'grammar'
  const [results,   setResults]   = useState(() => qrRead(uid ? QR_PREFIX + uid : null) || []);
  const [resultsLoading, setResultsLoading] = useState(true);

  const [activeQuestions, setActiveQuestions] = useState([]);
  const [activeMatchSets, setActiveMatchSets] = useState([]);
  const [quizConfig,      setQuizConfig]      = useState(null);
  const [lastResult,      setLastResult]      = useState(null);
  const [confetti,        setConfetti]        = useState(false);

  // Cloze quiz state
  const [clozeQuestions, setClozeQuestions] = useState([]);
  const [clozeConfig,    setClozeConfig]    = useState(null);
  const [clozeResult,    setClozeResult]    = useState(null);

  // Grammar quiz state
  const [gramCorpus,       setGramCorpus]       = useState([]);
  const [gramQuestions,    setGramQuestions]    = useState([]);
  const [gramConfig,       setGramConfig]       = useState(null);
  const [gramTranslations, setGramTranslations] = useState(null); // from translation session
  const [gramConceptChoices, setGramConceptChoices] = useState(null);
  const [gramAssessment,   setGramAssessment]   = useState(null);
  const [gramSelections,   setGramSelections]   = useState(null);

  // lemmaMaster — loaded once for related-form credit resolution
  const [lemmaMaster, setLemmaMaster] = useState([]);

  // Load grammar corpus from Firestore on mount
  useEffect(() => {
    if (!uid) return;
    (async () => {
      try {
        const snap = await getDoc(fsDoc(db, 'users', uid, 'grammar_corpus', 'index'));
        if (snap.exists()) setGramCorpus(snap.data().entries || []);
      } catch (e) {
        console.error('QuizzesPage: grammar corpus load failed', e);
      }
    })();
  }, [uid]);

  // Load lemmaMaster from Firestore on mount
  useEffect(() => {
    if (!uid) return;
    getDocs(collection(db, 'users', uid, 'lemmaMaster'))
      .then(snap => setLemmaMaster(snap.docs.map(d => d.data())))
      .catch(() => {});
  }, [uid]);

  // Use props directly — these come from App's shared useFlashcardData
  const cards = propCards || [];
  const decks  = propDecks || [];

  // Load only quiz_results from Firestore (serve cache immediately, refresh in background)
  useEffect(() => {
    if (!uid) return;
    const qrKey = QR_PREFIX + uid;
    const cached = qrRead(qrKey);
    if (cached) {
      setResults(cached);
      setResultsLoading(false);
    }
    (async () => {
      try {
        const resultSnap = await getDocs(query(collection(db, 'users', uid, 'quiz_results'), orderBy('date', 'asc')));
        const fresh = resultSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        setResults(prev => {
          // Keep any results that were added after the load started (higher count wins)
          if (prev.length > fresh.length) return prev;
          return fresh;
        });
        qrWrite(qrKey, fresh);
      } catch (e) {
        console.error('QuizzesPage: results load error', e);
      } finally {
        setResultsLoading(false);
      }
    })();
  }, [uid]);

  // Reset scroll position when returning to the home/report views on mobile.
  // The topbar is height-collapsed for quizzes on mobile, so the content area
  // extends to the top of the viewport. Without this, the content-pad's
  // scrollTop from a quiz session persists when returning home. Uses rAF so
  // it fires after the browser paints, reliably after iOS scroll restoration.
  useEffect(() => {
    if (!isMobile) return;
    if (view !== 'home' && view !== 'report') return;
    requestAnimationFrame(() => {
      const el = document.querySelector('.content-pad');
      if (el) el.scrollTop = 0;
    });
  }, [view]);

  const deckNameMap = useMemo(() => {
    const m = {}; decks.forEach(d => { m[d.id] = d.name; }); return m;
  }, [decks]);

  const enrichedCards = useMemo(() =>
    cards.map(c => ({ ...c, deckNames: (c.deckIds || []).map(id => deckNameMap[id]).filter(Boolean) })),
    [cards, deckNameMap]);

  const saveResult = useCallback(async (type, correct, total, meta = null) => {
    if (!uid) return { score: 0, id: null };
    const rawScore  = total > 0 ? correct / total * 100 : 0;
    const score      = Math.round(rawScore * 10) / 10; // max 1 decimal place
    // Round-trip through JSON to silently drop any stray `undefined` fields —
    // Firestore rejects undefined values outright, so this is a cheap backstop
    // on top of each caller already building clean meta objects.
    const cleanMeta = meta ? JSON.parse(JSON.stringify(meta)) : null;
    const entry    = { type, score, correct, total, date: new Date().toISOString(), meta: cleanMeta };
    try {
      const ref = await addDoc(collection(db, 'users', uid, 'quiz_results'), entry);
      setResults(prev => {
        const next = [...prev, { id: ref.id, ...entry }];
        qrWrite(QR_PREFIX + uid, next);
        return next;
      });
      return { score, id: ref.id };
    } catch (e) {
      console.error('QuizzesPage: save result failed', e);
      return { score, id: null };
    }
  }, [uid]);

  // Updates a saved quiz result in Firestore (used by override on results screen)
  const updateResult = useCallback(async (resultId, newCorrect, total) => {
      if (!uid || !resultId) return;
      const rawScore = total > 0 ? newCorrect / total * 100 : 0;
      const newScore = Math.round(rawScore * 10) / 10;
      try {
        await updateDoc(fsDoc(db, 'users', uid, 'quiz_results', resultId), {
          correct: newCorrect,
          score:   newScore,
        });
        setResults(prev => {
          const next = prev.map(r => r.id === resultId ? { ...r, correct: newCorrect, score: newScore } : r);
          qrWrite(QR_PREFIX + uid, next);
          return next;
        });
      } catch (e) {
        console.error('QuizzesPage: updateResult failed', e);
      }
    }, [uid]);

  // ── Grammar quiz: call API to generate questions ──────────
  const handleGrammarStart = useCallback(async (config) => {
    const apiKey = settings?.anthropicApiKey;
    if (!apiKey) return;

    setGramConfig(config);
    setGramAssessment(null);
    setGramTranslations(null);
    setGramConceptChoices(null);
    setGramSelections(null);
    setView('grammar_loading');

    const isSelection   = config.mode === 'selection';
    const isDrill       = !isSelection && config.transMode === 'drill';
    const isBroad       = !isSelection && !isDrill;

    // Build concept subset for the prompt
    const candidateConcepts = config.selectedIds.length > 0
      ? gramCorpus.filter(e => config.selectedIds.includes(e.id))
      : gramCorpus;

    const corpusText = gramCorpus.map(e =>
      `ID:${e.id} | ${e.term} | Level:${e.level}${e.compareTo ? ` | Compare:${e.compareTo}` : ''}${e.explanation ? ` | Explanation:${e.explanation}` : ''}`
    ).join('\n');

    const candidateText = candidateConcepts.map(e => `ID:${e.id} | ${e.term}`).join('\n');

    let payload = null;

    if (isSelection) {
      payload = { mode: 'selection', corpusText, candidateText, length: config.length };
    } else if (isDrill) {
      const concept = candidateConcepts[0];
      payload = buildGrammarDrillPayload(concept, config.length, corpusText);
    } else {
      // Broad mode
      payload = {
        mode:        'broad',
        corpusText,
        candidateText,
        length:      config.length,
        choiceCount: config.choiceCount,
        restrict:    config.selectedIds.length > 0,
      };
    }

    try {
      const parsed = await callGrammarQuizAPI(payload);

      const corpusById = Object.fromEntries(gramCorpus.map(e => [e.id, e]));

      // Enrich questions with concept objects
      const enriched = parsed.questions.map(q => {
        if (isSelection) return q;
        if (isDrill) return { ...q, correctConcept: corpusById[q.correctConceptId] || null, choices: null };
        // Broad mode — attach concept objects and shuffle choices
        const correctConcept = corpusById[q.correctConceptId] || null;
        const choices = shuffleArray([
          correctConcept,
          ...(q.distractorIds || []).map(id => corpusById[id]).filter(Boolean),
        ]).slice(0, config.choiceCount);
        return { ...q, correctConcept, choices };
      });

      setGramQuestions(enriched);
      setView(isSelection ? 'grammar_selection' : 'grammar_translation');
    } catch (e) {
      console.error('Grammar quiz generation failed:', e);
      setView('grammar_config');
    }
  }, [gramCorpus, settings]);

  // ── Translation: receive answers, call API for assessment ──
  const handleGrammarTranslationFinish = useCallback(async ({ translations, conceptChoices }) => {
    setGramTranslations(translations);
    setGramConceptChoices(conceptChoices);
    setView('grammar_loading');

    const uid    = auth.currentUser?.uid;
    const isDrill = gramConfig?.transMode === 'drill';

    const payload = buildGrammarAssessmentPayload(gramQuestions, translations);

        try {
                    const parsed = await callGrammarQuizAPI(payload);

          setGramAssessment(parseGrammarAssessment(parsed));

      // Create correction note once we have the full assessment
      if (uid) {
        const rows = gramQuestions.map((q, i) => ({
          topic:     q.correctConcept?.term || 'quiz',
          original:  translations[i] || '',
          corrected: parsed.assessment?.[i]?.corrected || '',
        }));
        const dateStr = toDateStr(getLogicalToday(dsh));
        await createCorrectionNote({
          uid,
          title:       `Grammar Quiz — ${dateStr}`,
          rows,
          sourceLabel: 'Grammar Quiz',
        });
      }

      // Save score to quiz_results, tagged with concept metadata for headlines
      const oCount = parsed.assessment?.filter(a => a.verdict === 'O').length || 0;
      const concepts = [...new Set(gramQuestions.map(q => q.correctConcept?.term).filter(Boolean))];
      const missedConcepts = [...new Set(
        gramQuestions
          .filter((q, i) => parsed.assessment?.[i]?.verdict !== 'O')
          .map(q => q.correctConcept?.term)
          .filter(Boolean)
      )];
      const { id: resultId } = await saveResult('grammar', oCount, gramQuestions.length, {
        mode: 'translation',
        transMode: gramConfig?.transMode || null,
        concepts,
        missedConcepts,
      });

      // Full per-question detail, kept separately so it's only fetched on demand
      if (resultId && uid) {
        try {
          await setDoc(fsDoc(db, 'users', uid, 'quiz_result_details', resultId), {
            type:        'grammar',
            questions:   gramQuestions,
            translations,
            assessment:  parsed.assessment,
          });
        } catch (e) {
          console.error('QuizzesPage: detail save failed', e);
        }
      }

      setView('grammar_translation_results');
    } catch (e) {
      console.error('Grammar assessment failed:', e);
      // Still show results with whatever assessment we have
      setView('grammar_translation_results');
    }
  }, [gramQuestions, gramConfig, saveResult]);

  // ── Selection: receive answers, show results client-side ──
  const handleGrammarSelectionFinish = useCallback(async (selections) => {
    setGramSelections(selections);
    let correct = 0, totalSentences = 0;
    const concepts = new Set(), missedConcepts = new Set();
    gramQuestions.forEach((q, qi) => {
      const userSet = new Set(selections[qi] || []);
      (q.sentences || []).forEach((s, si) => {
        totalSentences++;
        const isRight = userSet.has(si) === s.correct;
        if (isRight) correct++;
        if (s.concept) {
          concepts.add(s.concept);
          if (!isRight) missedConcepts.add(s.concept);
        }
      });
    });
    await saveResult('grammar', correct, totalSentences, {
      mode: 'selection',
      concepts: [...concepts],
      missedConcepts: [...missedConcepts],
    });
    setView('grammar_selection_results');
  }, [saveResult, gramQuestions]);

  // ── handleVocaStart ────────────────────────────────────────
  const handleVocaStart = useCallback((config, vocaDecks) => {
    if (DEMO) config = { ...config, deckIds: [] }; // demo: all decks (7D)
    const pool = enrichedCards.filter(c => {
      if (c.type === 'grammar') return false;
      if ((c.deckIds || []).includes(GRAMMAR_DECK_ID)) return false;
      if (config.deckIds.length === 0) {
        return vocaDecks.some(d => (c.deckIds || []).includes(d.id));
      }
      return config.deckIds.some(id => (c.deckIds || []).includes(id));
    });

    if (pool.length < 2) return;

    const types      = config.questionTypes || ['multiple'];
    const typeCounts = config.typeCounts    || VOCA_DEFAULTS.typeCounts;

    // Build linear questions (MC + TF + Type), shuffled together
    let linearQs = [];
    if (types.includes('multiple')) {
      linearQs = linearQs.concat(buildMultipleChoice(pool, config, typeCounts.multiple || 5));
    }
    if (types.includes('truefalse')) {
      linearQs = linearQs.concat(buildTrueFalse(pool, config, typeCounts.truefalse || 5));
    }
    if (types.includes('type')) {
      linearQs = linearQs.concat(buildVocaTypeQuestions(pool, typeCounts.type || 5, lemmaMaster));
    }
    linearQs = shuffleArray(linearQs);

    // Build matching sets — always last
    let matchSets = [];
    if (types.includes('matching')) {
      const numSets = typeCounts.matching || 1;
      for (let i = 0; i < numSets; i++) {
        const ms = buildMatchingSet(pool);
        if (ms) matchSets.push(ms);
      }
    }

    if (linearQs.length === 0 && matchSets.length === 0) return;

    setActiveQuestions(linearQs);
    setActiveMatchSets(matchSets);
    setQuizConfig(config);
    setView('voca_session');
  }, [enrichedCards]);

    const handleVocaFinish = useCallback(async (questions, correct, total, matchMisses = [], matchTotal = 0) => {
    const byType = {};
    for (const q of questions) {
      const t = q.type === 'voca_type' ? 'type' : q.type;
      if (!byType[t]) byType[t] = { correct: 0, total: 0 };
      byType[t].total++;
      if (q.isCorrect) byType[t].correct++;
    }
    // Missed items with their correct answers, stored on the result doc's
    // meta (Stage A-4) — rendered in the Examiner's session-log popup. The
    // plain missedTerms string list stays alongside it (headlineEngine reads
    // it), now uncapped and answered-only. Matching misses arrive separately
    // as term/defn pairs since they never enter the linear questions array.
    const missedDetail = [
      ...questions
        .filter(q => q.answered && !q.isCorrect)
        .map(q => ({
          term:   q.card?.front || q.term || '',
          answer: q.card?.back || q.card?.notes || q.defn || '',
        })),
      ...matchMisses.map(p => ({ term: p.term || '', answer: p.defn || '' })),
    ].filter(d => d.term);
    const missedTerms = missedDetail.map(d => d.term);
    const deckIds = quizConfig?.deckIds || [];
    const { score, id: resultId } = await saveResult('voca', correct, total, {
      deckIds,
      deckNames: deckIds.map(id => deckNameMap[id]).filter(Boolean),
      questionTypes: quizConfig?.questionTypes || [],
      byType,
      missedTerms,
      missedDetail,
    });
    setLastResult({ questions, correct, total, score, resultId, matchMisses, matchTotal });
    quizCompleteSound(score);
    if (score >= 90) {
      setConfetti(true);
      setTimeout(() => setConfetti(false), 5500);
    }
    setView('voca_results');
  }, [saveResult, quizConfig, deckNameMap]);

   const handleClozeStart = useCallback(async (config) => {
  if (DEMO) config = { ...config, deckIds: [] }; // demo: all decks (7D)
  const sentenceDecks = decks.filter(d => d.name?.endsWith('(sentence mining)'));
  const activeDeckIds = config.deckIds.length > 0
    ? config.deckIds
    : sentenceDecks.map(d => d.id);

  const activeSourceNames = new Set(
    decks
      .filter(d => activeDeckIds.includes(d.id))
      .map(d => d.name.replace(' (sentence mining)', ''))
  );

  // Deck → source name lookup
  const deckSourceMap = {};
  for (const d of decks) {
    if (d.name?.endsWith('(sentence mining)')) {
      deckSourceMap[d.id] = d.name.replace(' (sentence mining)', '');
    }
  }

  // Sentence cards — don't require inputForm yet; resolve it below
    const sentenceCardsRaw = enrichedCards.filter(c =>
      c.type === 'sentence' &&
      (c.deckIds || []).some(id => activeDeckIds.includes(id)) &&
      (c.sentence || c.front?.includes('\n'))
    );

  if (sentenceCardsRaw.length === 0) return;

  // Load word inputs for these sources (needed for both inputForm resolution and distractors)
  let wordInputs = [];
  try {
    const snap = await getDocs(collection(db, 'users', uid, 'wordInputs'));
    wordInputs = snap.docs
      .map(d => d.data())
      .filter(w => activeSourceNames.has(w.source) && w.input);
  } catch (e) {
    console.error('Cloze quiz: failed to load word inputs', e);
  }
  // Resolve inputForm for cards that don't have it (older entries)
    const norm = s => (s || '').trim().toLowerCase();
    const sentenceCards = sentenceCardsRaw.map(c => {
      // Extract sentence for old-format cards (front = "lemma\nsentence")
      const sentence = c.sentence ||
        (c.front?.includes('\n') ? c.front.split('\n').slice(1).join('\n') : c.front) || '';
      const base = { ...c, sentence };
      if (base.inputForm) return base;
      const sourceName = (c.deckIds || []).map(id => deckSourceMap[id]).find(Boolean);
      if (!sourceName) return base;
      const wi = wordInputs.find(w =>
        norm(w.lemma) === norm(c.lemma) && w.source === sourceName
      );
      return wi ? { ...base, inputForm: wi.input } : base;
    }).filter(c => c.inputForm && c.sentence);

    if (sentenceCards.length === 0) return;

  const wordInputForms = wordInputs.map(w => w.input);
  const questions = buildClozeQuestions(sentenceCards, wordInputForms, config, lemmaMaster);
  if (questions.length === 0) return;

  setClozeConfig({ ...config, activeDeckIds, sourceNames: [...activeSourceNames] });
  setClozeQuestions(questions);
  setView('cloze_session');
}, [enrichedCards, decks, uid]);

     const handleClozeFinish = useCallback(async (questions, correct, total) => {
       // Missed lemmas + the exact form that filled the blank (Stage A-4) —
       // stored on the result doc's meta for the session-log popup. Only
       // answered misses count; missedTerms stays as strings for
       // headlineEngine, now uncapped.
       const missedDetail = questions
         .filter(q => q.answered && !q.isCorrect)
         .map(q => ({ term: q.lemma || '', answer: q.inputForm || '' }))
         .filter(d => d.term);
       const missedTerms = missedDetail.map(d => d.term);
       const { score, id: resultId } = await saveResult('cloze', correct, total, {
         deckIds: clozeConfig?.activeDeckIds || [],
         sourceNames: clozeConfig?.sourceNames || [],
         mode: clozeConfig?.mode || 'type',
         missedTerms,
         missedDetail,
       });
       setClozeResult({ questions, correct, total, score, resultId });
       quizCompleteSound(score);
       if (score >= 90) {
         setConfetti(true);
         setTimeout(() => setConfetti(false), 5500);
       }
       setView('cloze_results');
     }, [saveResult, clozeConfig]);

  // ── Derived data for home view ────────────────────────────
  const last7     = results.filter(r => { const c = getLogicalToday(dsh); c.setDate(c.getDate() - 7); return new Date(r.date) >= c; });
  const vocaLast7 = last7.filter(r => r.type === 'voca');
  const avgLast7  = last7.length ? Math.round(last7.reduce((s, r) => s + r.score, 0) / last7.length) : null;

  const homeChartData = useMemo(() => {
    const c30 = getLogicalToday(dsh); c30.setDate(c30.getDate() - 30);
    const last30 = results.filter(r => new Date(r.date) >= c30);
    return buildQuizChartData(last30);
  }, [results, dsh]);

  if (propCards === null) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '300px', color: C.textM, fontSize: '13px' }}>
        Loading…
      </div>
    );
  }

  // Sub-views
  
  if (view === 'voca_session') {
    return (
      <VocaQuizSession
        questions={activeQuestions}
        matchSets={activeMatchSets}
        config={quizConfig}
        onFinish={handleVocaFinish}
        C={C} S={S}
      />
    );
  }
  if (view === 'voca_results') {
    return (
      <>
        <Confetti active={confetti} />
        <VocaQuizResults
          questions={lastResult?.questions || []}
          correct={lastResult?.correct || 0}
          total={lastResult?.total || 0}
          matchMisses={lastResult?.matchMisses || []}
          matchTotal={lastResult?.matchTotal || 0}
          resultId={lastResult?.resultId}
          config={quizConfig}
          onUpdateResult={updateResult}
          onDone={() => setView('home')}
          C={C} S={S}
        />
      </>
    );
  }
  
  if (view === 'grammar_loading') {
    return <HardModeLoading C={C} />;
  }
  if (view === 'grammar_translation') {
    return (
      <GrammarTranslationSession
        questions={gramQuestions}
        config={gramConfig}
        onFinish={handleGrammarTranslationFinish}
        C={C} S={S}
      />
    );
  }
  if (view === 'grammar_translation_results') {
    return (
      <GrammarTranslationResults
        questions={gramQuestions}
        translations={gramTranslations || []}
        assessment={gramAssessment}
        onDone={() => setView('home')}
        C={C} S={S}
      />
    );
  }
  if (view === 'grammar_selection') {
    return (
      <GrammarSelectionSession
        questions={gramQuestions}
        onFinish={handleGrammarSelectionFinish}
        C={C} S={S}
      />
    );
  }
  if (view === 'grammar_selection_results') {
    return (
      <GrammarSelectionResults
        questions={gramQuestions}
        userSelections={gramSelections || []}
        onDone={() => setView('home')}
        C={C} S={S}
      />
    );
  }
  if (view === 'report') {
    return (
      <div className="fade-up quiz-session" style={isMobile ? { paddingTop: '24px' } : undefined}>
        <button onClick={() => setView('home')} style={{
          fontSize: '12px', color: C.textM, marginBottom: '20px',
          display: 'flex', alignItems: 'center', gap: '6px',
          background: 'none', border: 'none', cursor: 'pointer', padding: 0,
        }}>
          ← Back
        </button>
                <ReportCard results={results} C={C} S={S} dsh={dsh} />
      </div>
    );
  }
    if (view === 'cloze_session') {
      return (
        <ClozeQuizSession
          questions={clozeQuestions}
          onFinish={handleClozeFinish}
          C={C} S={S}
        />
      );
    }
    if (view === 'cloze_results') {
      return (
        <>
          <Confetti active={confetti} />
          <ClozeQuizResults
            questions={clozeResult?.questions || []}
            correct={clozeResult?.correct || 0}
            total={clozeResult?.total || 0}
            resultId={clozeResult?.resultId}
            onDone={() => setView('home')}
            C={C} S={S}
          />
        </>
      );
    }

  // ── Home ──────────────────────────────────────────────────
  if (resultsLoading) {
    return (
      <div className="fade-up quiz-session" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '320px', ...(isMobile && { paddingTop: '24px' }) }}>
        <CrowLoader />
      </div>
    );
  }
 return (
    <div className="fade-up quiz-session" style={isMobile ? { paddingTop: '24px' } : undefined}>
      <div className="quiz-home-grid" style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '32px', alignItems: 'center', marginBottom: '40px' }}>
        {!isMobile && (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
            {CrowImg ? (
              <img
                src={CrowImg}
                alt="Decorative crow"
                style={{
                    width: 'auto',
                    height: '266px',
                    objectFit: 'contain',
                    userSelect: 'none',
                    transform: 'scaleX(-1)',
                  }}
              />
            ) : (
              <div style={{ ...decoBlockStyle(C), width: '200px', height: '266px' }} />
            )}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {DEMO && demoCapReached(results, 'quizSessions') && (
            <div style={{ fontSize: '12px', color: C.warning, fontWeight: 500, lineHeight: 1.5 }}>
              {DEMO_LIMIT_NOTE}
            </div>
          )}
          <GazetteSplitFig
            label="Vocabulary Quiz"
            description="Multiple choice, true/false, typed answers, and matching — choose your formats, decks, and question counts."
            bestFor="Best for quick sessions."
            flip={false}
            onClick={() => { if (DEMO && demoCapReached(results, 'quizSessions')) return; quizSound('mouse_click'); setConfigModal('voca'); }}
          />
          <GazetteSplitFig
            label="Cloze Quiz"
            description="Fill-in-the-blank questions built from your sentence-mining decks, answered by typing or selecting from choices."
            bestFor="Best for in-context vocabulary recall."
            flip={true}
            onClick={() => { if (DEMO && demoCapReached(results, 'quizSessions')) return; quizSound('mouse_click'); setConfigModal('cloze'); }}
          />
          <div style={DEMO ? { opacity: 0.45, pointerEvents: 'none' } : undefined}>
            <GazetteSplitFig
              label="Grammar Quiz"
              description="Translation drills, broader practice, or side-by-side concept comparisons, assessed by AI with correction notes."
              bestFor="Best for direct comparison and explanation."
              flip={false}
              onClick={() => { quizSound('mouse_click'); setConfigModal('grammar'); }}
            />
          </div>
          {DEMO && (
            <div style={{ fontSize: '11px', color: C.textM, marginTop: '-4px' }}>
              Grammar quizzes are not available in the demo.
            </div>
          )}

          {results.length > 0 && (
            <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
              {[
                { label: 'This week', value: last7.length },
                avgLast7 !== null ? { label: 'Avg score', value: `${avgLast7}%` } : null,
                { label: 'All time',  value: results.length },
              ].filter(Boolean).map(({ label, value }) => (
                <div key={label} style={{
                  flex: 1, background: C.raised, border: `1px solid ${C.border}`,
                  borderRadius: '10px', padding: '10px 12px', textAlign: 'center',
                }}>
                  <div style={{ fontFamily: SH.fm, fontSize: '17px', color: C.accent }}>{value}</div>
                  <div style={{ fontSize: '10px', color: C.textM, marginTop: '2px' }}>{label}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: '28px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
          <div style={{ fontFamily: SH.fd, fontSize: '18px', color: C.text }}>
            Recently Reported
          </div>
          {results.length > 0 && (
            <button onClick={() => setView('report')} style={{
              fontSize: '11px', color: C.accent, background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            }}>
              Peruse the full article →
            </button>
          )}
        </div>

        {results.length === 0 ? (
          <div style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '12px', padding: '32px', textAlign: 'center' }}>
            {CrowImg
              ? <img src={CrowImg} alt="" style={{ width: '48px', height: '48px', objectFit: 'contain', opacity: 0.3, marginBottom: '12px', transform: 'scaleX(-1)' }} />
              : <div style={{ ...decoBlockStyle(C), width: '48px', height: '48px', margin: '0 auto 12px' }} />}
            <div style={{ fontSize: '12px', color: C.textM }}>Complete a quiz to start tracking your progress.</div>
          </div>
        ) : homeChartData.length >= 2 ? (
          <div style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '12px', padding: '16px' }}>
            <MiniLineChart data={homeChartData} width={560} height={160} C={C} />
            <div style={{ display: 'flex', gap: '16px', marginTop: '8px', justifyContent: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: C.textM }}>
                <div style={{ width: '20px', height: '2px', background: C.accent }} /> Vocabulary
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: C.textM }}>
                <div style={{ width: '20px', height: '0', borderTop: `2px dashed ${C.accent2 || C.success}` }} /> Grammar
              </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: C.textM }}>
                    <span style={{ color: C.danger || '#c97d3a', fontWeight: 700, letterSpacing: '1px' }}>— —</span> Cloze
                  </div>
            </div>
          </div>
        ) : (
          <div style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '12px', padding: '20px' }}>
            {[...results].reverse().slice(0, 5).map((r, i, arr) => (
              <QuizResultRow key={i} r={r} last={i === arr.length - 1} C={C} />
            ))}
          </div>
        )}
      </div>

      <VocaQuizConfig
        open={configModal === 'voca'}
        decks={decks}
        onStart={(config, vocaDecks) => { setConfigModal(null); handleVocaStart(config, vocaDecks); }}
        onBack={() => setConfigModal(null)}
        C={C} S={S}
      />
      <ClozeQuizConfig
        open={configModal === 'cloze'}
        sentenceDecks={decks.filter(d => d.name?.endsWith('(sentence mining)'))}
        onStart={(config) => { setConfigModal(null); handleClozeStart(config); }}
        onBack={() => setConfigModal(null)}
        C={C} S={S}
      />
      <GrammarQuizConfig
        open={configModal === 'grammar'}
        onBack={() => setConfigModal(null)}
        onStart={(config) => { setConfigModal(null); handleGrammarStart(config); }}
        corpus={gramCorpus}
        apiKey={settings?.anthropicApiKey}
        C={C} S={S}
      />
    </div>
  );
}
