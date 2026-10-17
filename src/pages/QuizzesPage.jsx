// src/pages/QuizzesPage.jsx
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  collection, getDocs, addDoc, updateDoc, setDoc, query, orderBy, getDoc, doc as fsDoc,
  arrayUnion, arrayRemove,
} from 'firebase/firestore';
import { db, auth } from '../firebase.js';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { SH, frameBevel } from '../theme/buildStyles.js';
import { playSound, playQuizCompleteSound } from '../utils/soundEngine.js';
import { createCorrectionNote } from '../utils/createCorrectionNote.js';
import { callGrammarQuizAPI, callGrammarQuizChunks, describeGrammarQuizError } from '../utils/grammarQuizUtils.js';
import {
  buildGenerationRequest, validateGeneratedQuestions,
  planGenerationChunks, mergeGeneratedChunks,
  buildAssessmentRequest, planAssessmentChunks, mergeAssessmentChunks,
  buildExplainRequest, alignExplanations,
  buildSessionSnapshot, parseSessionSnapshot, snapshotProgress,
  scoreTranslationQuiz, formatPoints, overrideOptions, overrideAssessment,
  scoreSelectionQuiz, buildSelectionCorrectionRows, grammarResultMode,
  toSavedSelections, readSavedSelections,
  summarizeQuizConcepts, cardIdsForConcepts,
} from '../utils/grammarQuizEngine.js';
import {
  computeVocaBaseCredit, computeClozeCredit, applyHintPenalty,
  getVocaHints, isTwoSynonymFront, normalizeFrontForMatching,
  formatScore, computeRelatedCredit, findClozeTokenIndex,
} from '../utils/jamoUtils.js';
import { toDateStr, getLogicalToday } from '../utils/dateUtils.js';
import { isNewCard } from '../utils/fsrs.js';
import { normalizeLemma, getSourceSections, resolveLemmaWithDictionary } from '../utils/aviUtils.js';
import {
  ECHO_DEFAULTS, ECHO_CAP, ECHO_PLAYS_MAX, DIRS, buildItem, selectItems, canAdd, collides,
  def1ShortGloss, splitSenses, computeHints, createSession, currentRows,
  gradeRound, resolveRow, roundBlockers, commitRound, endSession, checkCorrection, buildSummary, isResumable,
  alternateText, alternateBlocker, withAlternates, buildWordRecord,
} from '../utils/echoEngine.js';
import {
  ECHO_SOURCE_IDS, indexEntries, sourceEntries, librarySourcesWithWords,
  librarySectionsWithWords, vocabDecks,
} from '../utils/echoSources.js';
import {
  buildLemmaIndex, buildSurfaceMap, filterLemmaMaster, resolveKorean,
  findByLemmaText, suggestLemmas, searchEnglish,
} from '../utils/lemmaSearchEngine.js';
import { SUGGESTION_KIND_LABEL } from '../hooks/useLemmaSearch.js';
import { getQuizStateReport } from '../utils/quizStateEngine.js';
import { wordAudioUrl, playAudioUrl } from '../utils/ttsUtils.js';
import { Icons } from '../components/Icons.jsx';
import { crowSrc as CrowImg, decoBlockStyle } from '../utils/decoAssets.js';
import { PaginationFooter } from '../components/PaginationFooter.jsx';
import { useGlobalKey } from '../hooks/useGlobalKey.js';
import { DEMO, DEMO_LIMIT_NOTE, demoCapReached } from '../demo/demoConfig.js';
import { usePaginationKeys } from '../hooks/usePaginationKeys.js';
import { GRAMMAR_MASTERY } from '../constants.js';
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
const isMobile = typeof window !== 'undefined' && (window.innerWidth <= 700 || window.matchMedia('(hover: none) and (pointer: coarse) and (orientation: portrait)').matches);
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

function VocaQuizConfig({ open, decks, onStart, onBack, C, S }) {
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

  const vocaDecks = decks.filter(d => !isGrammarDeck(d) && !d.name?.endsWith('(sentence mining)'));
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
// ECHO QUIZ SETUP (Stage E2 of the Echo Quiz decisions)
// ─────────────────────────────────────────────────────────────
// Pick where the words come from, adjust the list (× drops a word and the
// next one fills in; search adds your own), and set the round options. The
// list is built by echoEngine.selectItems, which also keeps at most one
// look-alike pair (E-D10). Settings persist on this device; the list doesn't.
const ECHO_CONFIG_KEY = 'avi_quiz_echo_config';
const ECHO_CONFIG_DEFAULTS = {
  ...ECHO_DEFAULTS,
  source:     'due',     // 'due' | 'recent' | 'trouble' | 'library' | 'deck' | 'manual'
  deckIds:    [],        // deck source; empty = all vocab decks
  libSource:  '',        // library source title
  libSection: '',        // '' = all sections
  checkMode:  'column',  // 'column' (whole column, then check) | 'row' (E-D8)
  correction: true,      // retype misses before the round closes (E-D9)
};
const ECHO_SIZE_MIN = 2;
const ECHO_REPEAT_GAP_MS = 700;   // pause between repeated Dictation plays
const ECHO_SIZE_MAX = 30;
const ECHO_SOURCE_LABELS = {
  due: 'Due today', recent: 'Recent words', trouble: 'Trouble words',
  library: 'Content Library', deck: 'Deck', manual: 'My picks',
};

// Two linked rings: marks the one look-alike pair in a list.
const EchoPairIcon = ({ color }) => (
  <svg width="16" height="12" viewBox="0 0 16 12" fill="none" stroke={color} strokeWidth="1.6" aria-label="Look-alike pair">
    <circle cx="5.5" cy="6" r="4" /><circle cx="10.5" cy="6" r="4" />
  </svg>
);

function EchoSwitch({ on, onClick, C }) {
  return (
    <button onClick={onClick} role="switch" aria-checked={on} style={{
      width: '44px', height: '24px', borderRadius: '12px', border: 'none', cursor: 'pointer', flexShrink: 0,
      background: on ? C.accent : C.border, position: 'relative', transition: 'background 0.2s',
    }}>
      <div style={{ position: 'absolute', top: '3px', left: on ? '23px' : '3px', width: '18px', height: '18px', borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
    </button>
  );
}

// Small seeded generator so a shuffled source (Library, Deck) keeps the same
// order while the setup is open, and reshuffles when the source changes.
function echoRng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// Mounted only while open, so every opening starts a fresh list. `seed`
// (picked when the tile is tapped) varies the Library / Deck shuffle.
// `preset` (X2/X3) opens it preloaded: { source, added?, deckIds? }. A preset
// is for this opening only: your saved source and decks stay as they were
// unless you pick a source yourself.
function EchoQuizConfig({ seed, preset = null, onBack, onStart, cards, decks, wordInputs, lemmaMaster, aviSources, aviSections, dsh, C, S }) {
  const [config, setConfig] = useState(() => {
    // Demo: no text-to-speech (D9), so the audio drills stay off.
    const saved = { ...loadConfig(ECHO_CONFIG_KEY, ECHO_CONFIG_DEFAULTS), ...(DEMO ? { kind: 'echo', koPrompt: 'text' } : {}) };
    if (!preset?.source) return saved;
    return { ...saved, source: preset.source, ...(Array.isArray(preset.deckIds) ? { deckIds: preset.deckIds } : {}) };
  });
  const storedRef = useRef(preset?.source ? loadConfig(ECHO_CONFIG_KEY, ECHO_CONFIG_DEFAULTS) : null);
  const [added,    setAdded]    = useState(() => (Array.isArray(preset?.added) ? preset.added : []));  // lemmaIDs picked by search, in order
  const [excluded, setExcluded] = useState([]);         // lemmaIDs dropped with ×
  const [query,    setQuery]    = useState('');
  const [notice,   setNotice]   = useState(null);       // why a search pick couldn't be added
  const [reshuffle, setReshuffle] = useState(0);        // bumped when the source changes

  const set = (patch) => setConfig(prev => {
    const next = { ...prev, ...patch };
    if (patch.source !== undefined) storedRef.current = null;   // a source you picked is yours to keep
    const kept = storedRef.current;
    saveConfig(ECHO_CONFIG_KEY, kept ? { ...next, source: kept.source, deckIds: kept.deckIds } : next);
    return next;
  });
  // A new source starts a fresh list; your own picks stay.
  const setSource = (patch) => { set(patch); setExcluded([]); setReshuffle(n => n + 1); };

  const index = useMemo(() => indexEntries(lemmaMaster, normalizeLemma), [lemmaMaster]);
  // Items are built on demand (only the current source's words and search hits).
  const itemOf = useCallback((entry) => (entry ? buildItem(entry, index.byId) : null), [index]);

  const baseCtx = useMemo(() => ({
    cards, decks, wordInputs, normalize: normalizeLemma, dsh, index,
  }), [cards, decks, wordInputs, dsh, index]);

  const counts = useMemo(() => ({
    due:     sourceEntries('due', baseCtx).filter(e => itemOf(e)).length,
    trouble: sourceEntries('trouble', baseCtx).filter(e => itemOf(e)).length,
  }), [baseCtx, itemOf]);

  const candidates = useMemo(() => {
    const ctx = { ...baseCtx, deckIds: config.deckIds, sourceTitle: config.libSource, section: config.libSection, rand: echoRng(seed + reshuffle * 7919) };
    const skip = new Set(excluded);
    return sourceEntries(config.source, ctx).filter(e => !skip.has(e.lemmaID)).map(itemOf).filter(Boolean);
  }, [baseCtx, config.source, config.deckIds, config.libSource, config.libSection, seed, reshuffle, excluded, itemOf]);

  const addedItems = useMemo(() => added.map(id => itemOf(index.byId.get(id))).filter(Boolean), [added, index, itemOf]);
  const manual = config.source === 'manual';
  const target = manual ? addedItems.length : Math.max(config.size, addedItems.length);
  const selection = useMemo(
    () => selectItems([...addedItems, ...candidates], target),
    [addedItems, candidates, target]
  );
  const items = selection.items;
  const pairIds = selection.pair || [];
  const short = !manual && items.length < config.size;

  // Content Library pickers: sources with word rows; that source's sections.
  const libSources = useMemo(() => librarySourcesWithWords(wordInputs), [wordInputs]);
  const libSections = useMemo(() => {
    if (!config.libSource) return [];
    const ordered = getSourceSections(aviSources || [], aviSections || [], config.libSource).map(s => s.content || '');
    return librarySectionsWithWords(wordInputs, config.libSource, ordered);
  }, [wordInputs, aviSources, aviSections, config.libSource]);
  const deckChoices = useMemo(() => vocabDecks(decks), [decks]);

  // Search to add your own words, with the AVI search engine (lemmaSearchEngine.js):
  // the same rules as the Lemma Master filter and its "Did you mean" fallback.
  // The index is built only once you start typing.
  const ECHO_SEARCH_LIMIT = 6;
  const typed = query.trim();
  const searching = typed !== '';
  const searchIndex = useMemo(() => (searching ? buildLemmaIndex(lemmaMaster) : null), [lemmaMaster, searching]);
  const surfaceMap  = useMemo(() => (searching ? buildSurfaceMap(wordInputs || []) : null), [wordInputs, searching]);
  const literal = useMemo(() => {
    if (!searchIndex || !typed) return { mode: 'all', hits: [] };
    const f = filterLemmaMaster(searchIndex, typed);
    if (f.mode === 'ko') {
      // Tiers: exact, starts with, contains, definition text. Shorter lemmas first in each.
      const byLength = (a, b) => a.lemma.length - b.lemma.length || a.lemma.localeCompare(b.lemma, 'ko');
      return { mode: 'ko', hits: f.tiers.flatMap(t => [...t].sort(byLength)).slice(0, ECHO_SEARCH_LIMIT) };
    }
    // English: every word must match the start of a definition word (so a
    // half-typed word already finds), ranked the way the Search tab ranks
    // (a def2 that is exactly the gloss first); half-typed-only matches after.
    const score = new Map(
      searchEnglish(searchIndex, typed, { limit: searchIndex.N || 1 }).results.map(r => [r.lemmaID, r.score])
    );
    const hits = f.tiers.flat()
      .map((e, i) => ({ e, i, s: score.has(e.id) ? score.get(e.id) : -1 }))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map(x => x.e);
    return { mode: 'en', hits: hits.slice(0, ECHO_SEARCH_LIMIT) };
  }, [searchIndex, typed]);

  // Korean with no literal match: "Did you mean". A form you typed in Word
  // Input, the dictionary form from the global lemma map (reads Firestore, so
  // it waits for a pause and remembers each answer), then close spellings.
  const needsFuzzy = literal.mode === 'ko' && literal.hits.length === 0;
  const localHeadwords = useMemo(() => {
    const set = new Set();
    if (!needsFuzzy) return set;
    for (const l of lemmaMaster || []) { if (l.lemma) set.add(l.lemma); if (l.cleanedLemma) set.add(l.cleanedLemma); }
    return set;
  }, [lemmaMaster, needsFuzzy]);
  const [dictHit, setDictHit] = useState(null);   // { query, entry } (entry null when nothing found)
  const dictCache = useRef(new Map());
  useEffect(() => {
    if (!needsFuzzy || !searchIndex) return undefined;
    const q = typed;
    if (dictCache.current.has(q)) { setDictHit({ query: q, entry: dictCache.current.get(q) }); return undefined; }
    let cancelled = false;
    const t = setTimeout(async () => {
      let entry = null;
      try {
        const lemma = await resolveLemmaWithDictionary(q, { localHeadwords });
        const hit = lemma ? findByLemmaText(searchIndex, lemma) : null;
        entry = hit ? hit.ref : null;
      } catch { entry = null; }
      dictCache.current.set(q, entry);
      if (!cancelled) setDictHit({ query: q, entry });
    }, 600);
    return () => { cancelled = true; clearTimeout(t); };
  }, [needsFuzzy, typed, searchIndex, localHeadwords]);
  const dictPending = needsFuzzy && !(dictHit && dictHit.query === typed);

  // Rows: { entry (the Lemma Master entry), label ("Did you mean" reason, or null) }.
  const results = useMemo(() => {
    if (!needsFuzzy) return literal.hits.map(e => ({ entry: e.ref, label: null }));
    const out = [];
    const seen = new Set();
    const push = (entry, label) => {
      if (entry && entry.lemmaID && !seen.has(entry.lemmaID)) { seen.add(entry.lemmaID); out.push({ entry, label }); }
    };
    const r = resolveKorean(searchIndex, typed, { surfaceMap });
    if (r.entry) push(r.entry.ref, 'from your input');
    if (dictHit && dictHit.query === typed) push(dictHit.entry, 'dictionary form');
    for (const s of suggestLemmas(searchIndex, typed, { limit: ECHO_SEARCH_LIMIT })) push(s.entry.ref, SUGGESTION_KIND_LABEL[s.kind]);
    return out.slice(0, ECHO_SEARCH_LIMIT);
  }, [needsFuzzy, literal, searchIndex, typed, surfaceMap, dictHit]);
  const addedPair = useMemo(() => selectItems(addedItems, addedItems.length).pair, [addedItems]);
  const pickStatus = (entry) => {
    const it = itemOf(entry);
    if (!it) return 'no definition';
    if (items.some(x => x.id === it.id)) return 'in the list';
    if (!canAdd(it, addedItems, addedPair)) {
      const other = addedItems.find(x => collides(x, it));
      return other ? `too close to ${other.ko}` : 'already listed';
    }
    return null;
  };
  const addPick = (entry) => {
    const status = pickStatus(entry);
    if (status) {
      setNotice(status.startsWith('too close')
        ? `${entry.lemma} is ${status}, and the list already has its one look-alike pair.`
        : null);
      return;
    }
    setAdded(prev => [...prev, entry.lemmaID]);
    setExcluded(prev => prev.filter(id => id !== entry.lemmaID));
    setQuery(''); setNotice(null);
  };
  const removeItem = (id) => {
    if (added.includes(id)) setAdded(prev => prev.filter(x => x !== id));
    else setExcluded(prev => [...prev, id]);
  };

  const canStart = items.length >= ECHO_SIZE_MIN;

  const firstLine = (s) => String(s || '').split('\n').map(l => l.trim()).find(Boolean) || '';
  // First sense without its number: "1.[명사] guarantee(d)…" → "[명사] guarantee(d)…"
  const gist = (en) => splitSenses(en)[0]?.display || firstLine(en);
  const selectStyle = {
    padding: '7px 10px', borderRadius: '8px', fontSize: isMobile ? '16px' : '13px', maxWidth: '100%',
    border: `1px solid ${C.border}`, background: C.bg, color: C.text, outline: 'none',
  };
  const sourceLabel = (id) => {
    const n = counts[id];
    return n !== undefined ? `${ECHO_SOURCE_LABELS[id]} · ${n}` : ECHO_SOURCE_LABELS[id];
  };

  return createPortal(
    <div style={S.overlay} onClick={e => { if (e.target === e.currentTarget) onBack(); }}>
      <div style={S.modal} className="slide-up">
        <div style={{ ...S.modalHeader, marginBottom: '16px' }}>
          <span style={S.modalTitle}>Echo Quiz</span>
          <button onClick={onBack} aria-label="Close" style={{ background: 'none', border: 'none', color: C.textM, cursor: 'pointer', fontSize: '18px', padding: '2px' }}>✕</button>
        </div>

        <div style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '16px', padding: '0 20px', marginBottom: '16px' }}>
          {/* Where the words come from */}
          <ConfigRow label="Words from" C={C}>
            {ECHO_SOURCE_IDS.map(id => (
              <ToggleChip key={id} label={sourceLabel(id)} active={config.source === id} onClick={() => setSource({ source: id })} C={C} />
            ))}
          </ConfigRow>

          {config.source === 'library' && (
            <ConfigRow label="Source" C={C}>
              <select value={config.libSource} onChange={e => setSource({ libSource: e.target.value, libSection: '' })} style={selectStyle}>
                <option value="">Choose a source…</option>
                {libSources.map(s => <option key={s.title} value={s.title}>{s.title} ({s.count})</option>)}
              </select>
              {config.libSource && libSections.length > 0 && (
                <select value={config.libSection} onChange={e => setSource({ libSection: e.target.value })} style={selectStyle}>
                  <option value="">All sections</option>
                  {libSections.map(s => <option key={s.name} value={s.name}>§{s.name} ({s.count})</option>)}
                </select>
              )}
            </ConfigRow>
          )}

          {config.source === 'deck' && deckChoices.length > 0 && (
            <ConfigRow label="Decks" C={C}>
              <ToggleChip label="All decks" active={config.deckIds.length === 0} onClick={() => setSource({ deckIds: [] })} C={C} />
              {deckChoices.map(d => (
                <ToggleChip key={d.id} label={d.name} active={config.deckIds.includes(d.id)} C={C}
                  onClick={() => setSource({ deckIds: config.deckIds.includes(d.id) ? config.deckIds.filter(x => x !== d.id) : [...config.deckIds, d.id] })} />
              ))}
            </ConfigRow>
          )}

          {!manual && (
            <ConfigRow label="List size" C={C} noBorder>
              <Stepper value={config.size} onChange={v => set({ size: v })} min={ECHO_SIZE_MIN} max={ECHO_SIZE_MAX} C={C} />
            </ConfigRow>
          )}
        </div>

        {/* The list */}
        <div style={{ marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px', marginBottom: '8px' }}>
            <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.textM }}>
              Words ({items.length})
            </div>
            {pairIds.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: C.textM }}>
                <EchoPairIcon color={C.accent} /> look-alikes: either order
              </div>
            )}
          </div>

          {items.length > 0 && (
            <div style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '12px', overflow: 'hidden' }}>
              {items.map((it, i) => (
                <div key={it.id} style={{
                  display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px',
                  borderTop: i ? `1px solid ${C.border}` : 'none',
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: SH.fk, fontSize: '15px', color: C.text }}>{it.ko}</div>
                    <div style={{ fontSize: '12px', color: C.textM, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{gist(it.en)}</div>
                  </div>
                  {pairIds.includes(it.id) && <EchoPairIcon color={C.accent} />}
                  <button
                    onClick={() => removeItem(it.id)}
                    title={added.includes(it.id) || manual ? 'Remove' : 'Remove (the next word fills in)'}
                    aria-label={`Remove ${it.ko}`}
                    style={{ background: 'none', border: 'none', color: C.textM, cursor: 'pointer', fontSize: '18px', padding: '4px 6px', flexShrink: 0 }}
                  >×</button>
                </div>
              ))}
            </div>
          )}

          {(items.length === 0 || short) && (
            <div style={{ fontSize: '12px', color: C.textM, marginTop: '8px' }}>
              {manual
                ? 'Search below to add the words you want.'
                : config.source === 'library' && !config.libSource
                  ? 'Choose a source.'
                  : items.length === 0
                    ? 'No words with a definition here. Try another source, or add words below.'
                    : `Only ${items.length} word${items.length === 1 ? '' : 's'} available here.`}
            </div>
          )}

          {/* Add your own */}
          <div style={{ marginTop: '12px' }}>
            <input
              type="text"
              lang="ko"
              value={query}
              onChange={e => { setQuery(e.target.value); setNotice(null); }}
              placeholder="Add a word (Korean or English)…"
              style={{
                width: '100%', boxSizing: 'border-box', padding: '9px 12px', borderRadius: '8px',
                fontSize: isMobile ? '16px' : '13px', border: `1px solid ${C.border}`, background: C.bg, color: C.text, outline: 'none',
              }}
            />
            {notice && <div style={{ fontSize: '12px', color: C.danger, marginTop: '6px' }}>{notice}</div>}
            {query.trim() && (
              <div style={{ marginTop: '6px', background: C.raised, border: `1px solid ${C.border}`, borderRadius: '10px', overflow: 'hidden' }}>
                {results.length === 0 && (
                  <div style={{ padding: '8px 12px', fontSize: '12px', color: C.textM }}>
                    {dictPending ? 'Checking the dictionary…' : 'No matches in Lemma Master.'}
                  </div>
                )}
                {needsFuzzy && results.length > 0 && (
                  <div style={{ padding: '7px 12px 5px', fontSize: '11px', color: C.textM }}>
                    No exact match. Did you mean:
                  </div>
                )}
                {results.map(({ entry: e, label }, i) => {
                  const status = pickStatus(e);
                  return (
                    <button key={e.lemmaID} onClick={() => addPick(e)} disabled={!!status && !status.startsWith('too close')} style={{
                      display: 'flex', width: '100%', alignItems: 'center', gap: '10px', textAlign: 'left',
                      padding: '8px 12px', background: 'none', border: 'none', borderTop: i || needsFuzzy ? `1px solid ${C.border}` : 'none',
                      cursor: status ? 'default' : 'pointer', opacity: status ? 0.55 : 1, color: C.text,
                    }}>
                      <span style={{ fontFamily: SH.fk, fontSize: '14px', flexShrink: 0 }}>{e.lemma}</span>
                      <span style={{ flex: 1, minWidth: 0, fontSize: '12px', color: C.textM, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {status || gist(e.def2 || def1ShortGloss(e.def1) || '')}
                      </span>
                      {label && <span style={{ fontSize: '11px', color: C.accent, flexShrink: 0 }}>{label}</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Round options */}
        <div style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '16px', padding: '0 20px', marginBottom: '20px' }}>
          {!DEMO && (
            <ConfigRow label="Drill" C={C}>
              <ToggleChip label="Echo (both ways)" active={config.kind !== 'dictation'} onClick={() => set({ kind: 'echo' })} C={C} />
              <ToggleChip label="Dictation" active={config.kind === 'dictation'} onClick={() => set({ kind: 'dictation' })} C={C} />
            </ConfigRow>
          )}
          {config.kind === 'dictation' && (
            <div style={{ fontSize: '11px', color: C.textM, margin: '-6px 0 10px' }}>
              Hear each word and type it. Every round repeats by ear; showing the meaning counts as a hint.
            </div>
          )}
          {config.kind === 'dictation' && (
            <>
              <ConfigRow label="Plays per tap" C={C}>
                <Stepper value={config.plays ?? 2} onChange={v => set({ plays: v })} min={1} max={ECHO_PLAYS_MAX} C={C} />
              </ConfigRow>
              <div style={{ fontSize: '11px', color: C.textM, margin: '-6px 0 10px' }}>
                How many times the word plays when its row comes into focus, and each time you press play.
              </div>
            </>
          )}
          <ConfigRow label="Rounds" C={C}>
            <ToggleChip label="Set number" active={config.mode === 'rounds'} onClick={() => set({ mode: 'rounds' })} C={C} />
            <ToggleChip label="Until all correct" active={config.mode === 'complete'} onClick={() => set({ mode: 'complete' })} C={C} />
            {config.mode === 'rounds' && (
              <Stepper value={config.rounds} onChange={v => set({ rounds: v })} min={1} max={ECHO_CAP} C={C} />
            )}
          </ConfigRow>
          {config.mode === 'complete' && (
            <div style={{ fontSize: '11px', color: C.textM, margin: '-6px 0 10px' }}>
              {config.kind === 'dictation' ? 'Every word right once by ear.' : 'Every word right once each way.'} Stops after {ECHO_CAP} rounds.
            </div>
          )}
          {config.kind !== 'dictation' && (
            <>
              <ConfigRow label="Start with" C={C}>
                <ToggleChip label="English → Korean" active={config.startDir === DIRS.EN2KO} onClick={() => set({ startDir: DIRS.EN2KO })} C={C} />
                <ToggleChip label="Korean → English" active={config.startDir === DIRS.KO2EN} onClick={() => set({ startDir: DIRS.KO2EN })} C={C} />
              </ConfigRow>
              {!DEMO && (
                <ConfigRow label="Korean prompts" C={C}>
                  <ToggleChip label="Text" active={config.koPrompt !== 'audio'} onClick={() => set({ koPrompt: 'text' })} C={C} />
                  <ToggleChip label="Audio" active={config.koPrompt === 'audio'} onClick={() => set({ koPrompt: 'audio' })} C={C} />
                </ConfigRow>
              )}
              {DEMO && (
                <div style={{ fontSize: '11px', color: C.textM, margin: '10px 0' }}>
                  Audio prompts and Dictation are not available in the demo.
                </div>
              )}
              {config.koPrompt === 'audio' && (
                <div style={{ fontSize: '11px', color: C.textM, margin: '-6px 0 10px' }}>
                  Korean → English rounds play the word instead of showing it. Showing it counts as a hint.
                </div>
              )}
            </>
          )}
          <ConfigRow label="Each round" C={C}>
            <ToggleChip label="Full list" active={!config.shrinking} onClick={() => set({ shrinking: false })} C={C} />
            <ToggleChip label="Shrinking list" active={config.shrinking} onClick={() => set({ shrinking: true })} C={C} />
          </ConfigRow>
          {config.shrinking && (
            <div style={{ fontSize: '11px', color: C.textM, margin: '-6px 0 10px' }}>
              {config.kind === 'dictation' ? "A word drops out once you've had it right by ear." : "A word drops out once you've had it right both ways."}
            </div>
          )}
          <ConfigRow label="Check answers" C={C}>
            <ToggleChip label="Whole column" active={config.checkMode !== 'row'} onClick={() => set({ checkMode: 'column' })} C={C} />
            <ToggleChip label="Row by row" active={config.checkMode === 'row'} onClick={() => set({ checkMode: 'row' })} C={C} />
          </ConfigRow>
          <div style={{ padding: '14px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', borderBottom: `1px solid ${C.border}` }}>
            <div style={{ fontSize: '13px', color: C.textS }}>Shuffle each round</div>
            <EchoSwitch on={config.shuffle} onClick={() => set({ shuffle: !config.shuffle })} C={C} />
          </div>
          <div style={{ padding: '14px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
            <div>
              <div style={{ fontSize: '13px', color: C.textS }}>Retype mistakes</div>
              <div style={{ fontSize: '11px', color: C.textM, marginTop: '2px' }}>Write the right answer before the round closes</div>
            </div>
            <EchoSwitch on={config.correction} onClick={() => set({ correction: !config.correction })} C={C} />
          </div>
        </div>

        <button
          style={{ ...S.btnPrimary, width: '100%', justifyContent: 'center', padding: '12px', fontSize: '14px', opacity: canStart ? 1 : 0.5 }}
          onClick={() => canStart && onStart({ items, pair: selection.pair, config })}
          disabled={!canStart}
        >
          {canStart ? `Start ${config.kind === 'dictation' ? 'Dictation' : 'Echo'} · ${items.length} words` : `Add at least ${ECHO_SIZE_MIN} words`}
        </button>
      </div>
    </div>,
    document.body
  );
}

// ─────────────────────────────────────────────────────────────
// ECHO QUIZ SESSION (Stage E3)
// ─────────────────────────────────────────────────────────────
// One round = the prompt column + your answer column. Whole-column mode:
// write every answer, then Check. Row-by-row mode: each row is checked as you
// leave it (Enter / Next / ✓). After checking, every row shows the Lemma
// Master answer (E-D11); close answers need Accept or Reject; anything not
// accepted can be overridden ("I was right"); misses are retyped before the
// round closes unless that setting is off (E-D9). Decisions can be undone
// until the round closes. The next round's prompts are this round's answers
// in canonical form (echoEngine.commitRound, E-D3).

const echoInputStyle = (C, done) => ({
  width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '8px',
  fontSize: isMobile ? '16px' : '15px', lineHeight: 1.3,
  border: `1.5px solid ${done ? 'transparent' : C.border}`, background: done ? 'transparent' : C.bg,
  color: C.text, outline: 'none',
});

// Status line for a checked row.
function echoStatus(r, decision) {
  if (r.accepted === true) {
    if (r.overridden) return { text: 'Marked right', tone: 'ok' };
    if (r.nearAccepted) return { text: 'Accepted', tone: 'ok' };
    if (r.via === 'synonym') return { text: 'Right — a synonym', tone: 'ok' };
    if (r.via === 'alternate') return { text: 'Right — a saved alternate', tone: 'ok' };
    if (r.via === 'pair') return { text: 'Right — either order', tone: 'ok' };
    return { text: 'Right', tone: 'ok' };
  }
  if (r.accepted === null) {
    const why = r.via === 'form' ? 'a related form' : r.via === 'partial' ? 'part of it' : 'a small slip';
    return { text: `Close — ${why}. Count it?`, tone: 'near' };
  }
  if (decision === 'reject') return { text: 'Not counted', tone: 'miss' };
  if (r.verdict === 'blank') return { text: 'Left blank', tone: 'miss' };
  if (r.via === 'close') return { text: 'Close — one sound off', tone: 'miss' };   // Dictation (X-D14)
  return { text: 'Not quite', tone: 'miss' };
}

// initialDraft: the round's answers and decisions saved on this device (E4
// resume), used only when it belongs to this session and round. onDraft is
// told about every change so the parent can save it.
// alternatesOf(id) → the entry's saved alternates; onSaveAlternate(id, text,
// remove) → Promise<boolean> (X1, E-D18).
// audioOf(id) → { status: 'pending' | 'ready' | 'failed', url } for audio
// prompts (X4); ttsSpeed from Settings.
function EchoRound({ state, initialDraft, onDraft, onCommit, onEnd, alternatesOf, onSaveAlternate, audioOf, ttsSpeed = 0.9, C, S }) {
  const rows    = useMemo(() => currentRows(state), [state]);
  const itemMap = useMemo(() => new Map(state.items.map(i => [i.id, i])), [state.items]);
  const cfg     = state.config;
  const rowMode = cfg.checkMode === 'row';
  const correctionOn = cfg.correction !== false;
  const en2ko   = state.dir === DIRS.EN2KO;
  const dictation = state.dir === DIRS.EAR;   // Dictation (X4): hear the word, type it
  const koAnswer  = en2ko || dictation;       // the answer column is Korean

  const draft = initialDraft && initialDraft.startedAt === state.startedAt && initialDraft.round === state.round ? initialDraft : null;
  const asMap = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
  const [answers,     setAnswers]     = useState(() => asMap(draft?.answers));
  const [submitted,   setSubmitted]   = useState(() => (Array.isArray(draft?.submitted) ? draft.submitted.filter(id => state.order.includes(id)) : []));  // checked row ids
  const [decisions,   setDecisions]   = useState(() => asMap(draft?.decisions));  // id → 'accept' | 'reject' | 'override'
  const [corrections, setCorrections] = useState(() => asMap(draft?.corrections));
  // Saved alternates this round (X1): id → { text, status: 'saving' | 'saved' | 'error' }.
  const [alts, setAlts] = useState(() => Object.fromEntries(Object.entries(asMap(draft?.alternates))
    .filter(([id, a]) => state.order.includes(id) && a && typeof a.text === 'string')
    .map(([id, a]) => [id, { text: a.text, status: 'saved' }])));
  // Hidden prompts shown before checking (X4): id → true; each counts as a hint.
  const [revealed, setRevealed] = useState(() => Object.fromEntries(Object.entries(asMap(draft?.revealed)).filter(([id, v]) => v && state.order.includes(id))));
  const [confirmEnd,  setConfirmEnd]  = useState(false);
  const inputRefs  = useRef({});

  // Audio prompts (X4): the play button replays freely; the first play is
  // automatic once the row's answer box has focus and its audio is ready.
  const playingRef = useRef(null);
  const autoPlayed = useRef(new Set());
  const [playingId, setPlayingId] = useState(null);
  // Dictation plays the word cfg.plays times per focus or tap, with a short
  // gap between plays; Echo's audio prompts play it once.
  const playsPerTap = dictation ? Math.min(ECHO_PLAYS_MAX, Math.max(1, Number(cfg.plays) || 2)) : 1;
  const play = (id) => {
    const a = audioOf ? audioOf(id) : null;
    if (!a || a.status !== 'ready' || !a.url) return;
    playingRef.current?.cancel?.();
    let cancelled = false;
    let clip = null;
    const h = { cancel() { cancelled = true; clip?.cancel?.(); } };
    playingRef.current = h;
    setPlayingId(id);
    (async () => {
      for (let k = 0; k < playsPerTap && !cancelled; k++) {
        if (k) await new Promise(r => setTimeout(r, ECHO_REPEAT_GAP_MS));
        if (cancelled) break;
        clip = playAudioUrl(a.url, ttsSpeed);
        try { await clip.promise; } catch { break; }
      }
      if (playingRef.current === h) { playingRef.current = null; setPlayingId(null); }
    })();
  };
  const autoPlay = (row) => {
    if (!row.prompt.audio || isChecked(row.id) || autoPlayed.current.has(row.id)) return;
    const a = audioOf ? audioOf(row.id) : null;
    if (!a || a.status !== 'ready') return;
    autoPlayed.current.add(row.id);
    play(row.id);
  };
  useEffect(() => () => playingRef.current?.cancel?.(), []);
  // Plays once the focused row's audio is ready (it may still be generating).
  const [focusedId, setFocusedId] = useState(null);
  const focusedAudio = focusedId && audioOf ? audioOf(focusedId)?.status : null;
  useEffect(() => {
    if (focusedAudio !== 'ready') return;
    const row = rows.find(r => r.id === focusedId);
    if (row) autoPlay(row);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedId, focusedAudio]);
  const reveal = (id) => setRevealed(prev => ({ ...prev, [id]: true }));
  const checkBtnRef = useRef(null);
  const committedRef = useRef(false); // one commit per round (E-D14)

  // Report the round so far, for resume (E4).
  useEffect(() => {
    const savedAlts = Object.fromEntries(Object.entries(alts).filter(([, a]) => a.status === 'saved').map(([id, a]) => [id, { text: a.text }]));
    onDraft?.({ startedAt: state.startedAt, round: state.round, answers, submitted, decisions, corrections, alternates: savedAlts, revealed });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers, submitted, decisions, corrections, alts, revealed]);

  // Each round starts at the top (the page keeps its scroll position otherwise).
  useEffect(() => {
    requestAnimationFrame(() => {
      const pad = document.querySelector('.content-pad');
      if (pad) pad.scrollTop = 0;
      window.scrollTo(0, 0);
    });
  }, []);

  const isChecked = (id) => submitted.includes(id);
  const allChecked = submitted.length === rows.length;

  const graded = useMemo(() => {
    const sent = Object.fromEntries(rows.map(r => [r.id, submitted.includes(r.id) ? (answers[r.id] ?? '') : '']));
    const g = gradeRound(state, sent);
    return { ...g, rows: g.rows.map(r => (decisions[r.id] ? resolveRow(r, decisions[r.id]) : r)) };
  }, [state, rows, answers, submitted, decisions]);
  const gradedById = useMemo(() => new Map(graded.rows.map(r => [r.id, r])), [graded]);
  const blockers = allChecked ? roundBlockers(state, graded, corrections, { skipCorrection: !correctionOn }) : null;

  const focusInput = (id) => {
    const el = inputRefs.current[id];
    if (el) el.focus();
  };
  const nextUnchecked = (fromId, checked) => {
    const ids = rows.map(r => r.id);
    const start = ids.indexOf(fromId);
    for (let k = 1; k <= ids.length; k++) {
      const id = ids[(start + k) % ids.length];
      if (!checked.includes(id)) return id;
    }
    return null;
  };

  const checkAll = () => {
    setSubmitted(rows.map(r => r.id));
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  };
  const checkRow = (id) => {
    if (isChecked(id)) return;
    const next = [...submitted, id];
    setSubmitted(next);
    const n = nextUnchecked(id, next);
    if (n) setTimeout(() => focusInput(n), 0);
  };

  // Enter = next row (whole-column mode) or check this row (row mode).
  // Ignored while the Korean keyboard is still building a syllable.
  const onAnswerKey = (e, id, idx) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (rowMode) { checkRow(id); return; }
    const next = rows[idx + 1];
    if (next) focusInput(next.id);
    else checkBtnRef.current?.focus();
  };
  const onCorrectionKey = (e, id) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    const missIds = graded.rows.filter(r => r.accepted === false).map(r => r.id);
    const next = missIds[missIds.indexOf(id) + 1];
    if (next) inputRefs.current[`fix-${next}`]?.focus();
  };
  // Phone: keep the row being typed in clear of the keyboard.
  const onFocusRow = (e) => {
    if (!isMobile) return;
    const el = e.target.closest('[data-echo-row]');
    setTimeout(() => el?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 250);
  };

  // Saved alternates (X1): written to the Lemma Master entry at once; the
  // session's later rounds accept them from the next round on.
  const saveAlt = async (id) => {
    const text = alternateText(answers[id] ?? '');
    if (!text || !onSaveAlternate) return;
    setAlts(prev => ({ ...prev, [id]: { text, status: 'saving' } }));
    const ok = await onSaveAlternate(id, text, false);
    setAlts(prev => ({ ...prev, [id]: { text, status: ok ? 'saved' : 'error' } }));
  };
  const unsaveAlt = async (id) => {
    const a = alts[id];
    if (!a) return;
    setAlts(prev => { const next = { ...prev }; delete next[id]; return next; });
    if (a.status !== 'saved' || !onSaveAlternate) return;
    const ok = await onSaveAlternate(id, a.text, true);
    if (!ok) setAlts(prev => ({ ...prev, [id]: { text: a.text, status: 'saved' } }));
  };

  const decide = (id, action) => {
    if (!action && decisions[id] === 'override' && alts[id]) unsaveAlt(id);
    setDecisions(prev => {
      const next = { ...prev };
      if (action) next[id] = action; else delete next[id];
      return next;
    });
  };

  const commit = () => {
    if (!blockers?.ok || committedRef.current) return;
    committedRef.current = true;
    const saved = Object.entries(alts).filter(([, a]) => a.status === 'saved').map(([id, a]) => ({ id, text: a.text }));
    onCommit(withAlternates(commitRound(state, graded, { hinted: revealed }), saved));
  };

  // Header progress: rounds mode = rounds done; until-correct = words done both ways.
  const resolvedCount = state.items.filter(i => (dictation ? state.progress[i.id].ear : state.progress[i.id].en2ko && state.progress[i.id].ko2en)).length;
  const pct = cfg.mode === 'complete'
    ? (resolvedCount / state.items.length) * 100
    : ((state.round - 1) / cfg.rounds) * 100;
  const lastFixedRound = cfg.mode === 'rounds' && state.round >= cfg.rounds;
  const cols = en2ko ? '3fr 2fr' : '2fr 3fr'; // longer text gets the wider column (E-D15)
  const toneColor = { ok: C.success || '#5a8a5a', near: C.warning, miss: C.danger };

  const blockerText = blockers && !blockers.ok
    ? [
        blockers.undecided.length ? `decide ${blockers.undecided.length} close answer${blockers.undecided.length === 1 ? '' : 's'}` : '',
        blockers.uncorrected.length ? `retype ${blockers.uncorrected.length} answer${blockers.uncorrected.length === 1 ? '' : 's'}` : '',
      ].filter(Boolean).join(' · ')
    : '';

  const smallBtn = (primary) => ({
    fontSize: '12px', padding: '4px 11px', borderRadius: '6px', cursor: 'pointer',
    color: primary ? C.accent : C.textM,
    background: primary ? C.accentSoft : 'transparent',
    border: `1px solid ${primary ? `${C.accent}44` : C.border}`,
  });

  return (
    <div style={{ maxWidth: '720px', margin: '0 auto' }} className="fade-up quiz-session">
      {/* Sticky header */}
      <div style={{ position: 'sticky', top: 0, zIndex: 10, background: C.bg, paddingTop: isMobile ? '12px' : '4px', paddingBottom: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: SH.fd, fontSize: '17px', color: C.text }}>
              Round {state.round}{cfg.mode === 'rounds' ? ` of ${cfg.rounds}` : ''}
            </div>
            <div style={{ fontSize: '11px', color: C.textM }}>
              {dictation ? 'Dictation' : en2ko ? 'English → Korean' : 'Korean → English'} · {rows.length} word{rows.length === 1 ? '' : 's'}
              {cfg.mode === 'complete' ? ` · ${resolvedCount}/${state.items.length} ${dictation ? 'right by ear' : 'done both ways'}` : ''}
            </div>
          </div>
          <button onClick={() => setConfirmEnd(v => !v)} style={{
            fontSize: '12px', color: C.textM, padding: '3px 10px', borderRadius: '6px',
            border: `1px solid ${C.border}`, background: 'transparent', cursor: 'pointer', flexShrink: 0,
          }}>End</button>
        </div>
        <div style={{ height: '4px', background: `${C.accent}22`, borderRadius: '2px', marginTop: '8px' }}>
          <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: C.accent, borderRadius: '2px', transition: 'width 0.3s' }} />
        </div>
        {confirmEnd && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '10px', fontSize: '12px', color: C.textS }}>
            End now? This round won't count.
            <button onClick={() => onEnd(endSession(state))} style={smallBtn(true)}>End session</button>
            <button onClick={() => setConfirmEnd(false)} style={smallBtn(false)}>Keep going</button>
          </div>
        )}
      </div>

      {/* Column labels */}
      <div style={{ display: 'grid', gridTemplateColumns: cols, gap: '10px', padding: '0 12px 6px', fontSize: '10px', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.textM }}>
        <div>{dictation ? 'Listen' : en2ko ? 'Meaning' : cfg.koPrompt === 'audio' ? 'Korean (listen)' : 'Korean'}</div>
        <div>{koAnswer ? 'Korean' : 'Meaning'}</div>
      </div>

      <div style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '12px' }}>
        {rows.map((row, idx) => {
          const item    = itemMap.get(row.id);
          const checked = isChecked(row.id);
          const g       = gradedById.get(row.id);
          const decision = decisions[row.id];
          const st      = checked ? echoStatus(g, decision) : null;
          const fixOk   = checked && g.accepted === false && checkCorrection(item, state.dir, corrections[row.id] ?? '');
          const truest  = koAnswer ? item.ko : item.en;
          // Audio prompts (X4): hidden until checked or revealed; with no audio
          // the row falls back to text (Dictation shows the meaning instead).
          const au       = row.prompt.audio ? (audioOf ? audioOf(row.id) : null) : null;
          const audioOff = !!row.prompt.audio && (!au || au.status === 'failed');
          const showText = !row.prompt.audio || audioOff || checked || !!revealed[row.id];
          const promptText = row.prompt.audio && dictation ? row.prompt.reveal : row.prompt.text;
          const promptKo   = row.prompt.kind === 'ko' && !(row.prompt.audio && dictation);
          return (
            <div key={row.id} data-echo-row style={{ padding: '10px 12px', borderTop: idx ? `1px solid ${C.border}` : 'none' }}>
              <div style={{ display: 'grid', gridTemplateColumns: cols, gap: '10px', alignItems: 'start' }}>
                {/* Prompt */}
                <div style={{ minWidth: 0 }}>
                  {row.prompt.audio && !audioOff && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: showText ? '4px' : 0 }}>
                      <button
                        onClick={() => play(row.id)}
                        disabled={au?.status !== 'ready'}
                        aria-label={`Play word ${idx + 1}`}
                        title="Play"
                        style={{
                          flexShrink: 0, width: '32px', height: '32px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                          border: `1px solid ${playingId === row.id ? C.accent : C.border}`, background: playingId === row.id ? C.accentSoft : 'transparent',
                          color: C.accent, cursor: au?.status === 'ready' ? 'pointer' : 'default', opacity: au?.status === 'ready' ? 1 : 0.5,
                        }}
                      >{playingId === row.id ? Icons.speakerPlaying : Icons.speaker}</button>
                      {au?.status === 'pending' && <span style={{ fontSize: '11px', color: C.textM }}>Loading audio…</span>}
                      {!checked && !revealed[row.id] && (
                        <button onClick={() => reveal(row.id)} style={{ background: 'none', border: 'none', padding: 0, fontSize: '11.5px', color: C.textM, textDecoration: 'underline', cursor: 'pointer' }}>
                          {dictation ? 'Show meaning' : 'Show word'}
                        </button>
                      )}
                      {!checked && revealed[row.id] && <span style={{ fontSize: '11px', color: C.warning }}>hint used</span>}
                    </div>
                  )}
                  {showText && (
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
                      <div style={{
                        flex: 1, minWidth: 0, color: C.text, whiteSpace: 'pre-line', overflowWrap: 'break-word',
                        wordBreak: promptKo ? 'keep-all' : 'normal',
                        fontFamily: promptKo ? SH.fk : 'inherit',
                        fontSize: promptKo ? '16px' : '13.5px', lineHeight: 1.45,
                      }}>{promptText}</div>
                      {row.pairId && <EchoPairIcon color={C.accent} />}
                    </div>
                  )}
                  {audioOff && !checked && (
                    <div style={{ fontSize: '11px', color: C.textM, marginTop: '2px' }}>
                      {dictation ? 'Audio unavailable: type the word for this meaning.' : 'Audio unavailable: showing the word.'}
                    </div>
                  )}
                  {row.hint && <div style={{ fontSize: '11px', color: C.textM, marginTop: '2px' }}>{row.hint}</div>}
                  {row.twoPart && !checked && <div style={{ fontSize: '11px', color: C.textM, marginTop: '2px' }}>Two parts — separate with / or ,</div>}
                </div>
                {/* Answer */}
                <div style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {checked ? (
                    <div style={{
                      flex: 1, padding: '8px 0', overflowWrap: 'break-word', wordBreak: koAnswer ? 'keep-all' : 'normal',
                      fontFamily: koAnswer ? SH.fk : 'inherit', fontSize: koAnswer ? '16px' : '14px',
                      color: toneColor[st.tone],
                    }}>{(answers[row.id] || '').trim() || '—'}</div>
                  ) : (
                    <>
                      <input
                        ref={el => { inputRefs.current[row.id] = el; }}
                        lang={koAnswer ? 'ko' : 'en'}
                        value={answers[row.id] ?? ''}
                        onChange={e => setAnswers(prev => ({ ...prev, [row.id]: e.target.value }))}
                        onKeyDown={e => onAnswerKey(e, row.id, idx)}
                        onFocus={e => { onFocusRow(e); setFocusedId(row.id); }}
                        autoFocus={idx === 0}
                        enterKeyHint={idx === rows.length - 1 && !rowMode ? 'done' : 'next'}
                        autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
                        aria-label={`Answer ${idx + 1}`}
                        style={echoInputStyle(C, false)}
                      />
                      {rowMode && (
                        <button onClick={() => checkRow(row.id)} aria-label={`Check answer ${idx + 1}`} style={{
                          flexShrink: 0, width: '30px', height: '30px', borderRadius: '6px', cursor: 'pointer',
                          border: `1px solid ${C.border}`, background: 'transparent', color: C.accent, fontSize: '15px',
                        }}>✓</button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Feedback: status, the Lemma Master answer, decisions, retype */}
              {checked && (
                <div style={{ marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '11.5px', fontWeight: 600, color: toneColor[st.tone] }}>{st.text}</span>
                    <span style={{
                      fontSize: koAnswer ? '14px' : '12.5px', fontFamily: koAnswer ? SH.fk : 'inherit',
                      color: C.textS, whiteSpace: 'pre-line', overflowWrap: 'break-word', wordBreak: koAnswer ? 'keep-all' : 'normal',
                    }}>{truest}</span>
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {g.accepted === null && (
                      <>
                        <button onClick={() => decide(row.id, 'accept')} style={smallBtn(true)}>Accept</button>
                        <button onClick={() => decide(row.id, 'reject')} style={smallBtn(false)}>Reject</button>
                      </>
                    )}
                    {g.accepted === false && (
                      <button onClick={() => decide(row.id, 'override')} style={smallBtn(true)}>I was right</button>
                    )}
                    {decision && <button onClick={() => decide(row.id, null)} style={smallBtn(false)}>Undo</button>}
                  </div>
                  {decision === 'override' && onSaveAlternate && !dictation && !(row.pairId && en2ko) && (() => {
                    const a = alts[row.id];
                    const note = { fontSize: '11.5px', color: C.textM, display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' };
                    if (a?.status === 'saved') {
                      return (
                        <div style={note}>
                          <span>Saved as an alternate. It counts as right from now on.</span>
                          <button onClick={() => unsaveAlt(row.id)} style={smallBtn(false)}>Unsave</button>
                        </div>
                      );
                    }
                    if (a?.status === 'saving') return <div style={note}>Saving…</div>;
                    const why = alternateBlocker(item, state.dir, answers[row.id] ?? '', alternatesOf ? alternatesOf(row.id) : []);
                    if (why === 'full') return <div style={note}>This word already has the maximum number of saved alternates.</div>;
                    if (why) return null;
                    return (
                      <div style={note}>
                        <button onClick={() => saveAlt(row.id)} style={smallBtn(false)}>Save as alternate</button>
                        {a?.status === 'error' && <span style={{ color: C.danger }}>Couldn't save. Try again?</span>}
                      </div>
                    );
                  })()}
                  {g.accepted === false && correctionOn && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <input
                        ref={el => { inputRefs.current[`fix-${row.id}`] = el; }}
                        lang={koAnswer ? 'ko' : 'en'}
                        value={corrections[row.id] ?? ''}
                        onChange={e => setCorrections(prev => ({ ...prev, [row.id]: e.target.value }))}
                        onKeyDown={e => onCorrectionKey(e, row.id)}
                        onFocus={onFocusRow}
                        placeholder="Retype the answer"
                        enterKeyHint="next"
                        autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
                        aria-label={`Retype answer ${idx + 1}`}
                        style={{ ...echoInputStyle(C, false), borderColor: fixOk ? (C.success || '#5a8a5a') : C.border }}
                      />
                      <span style={{ width: '18px', flexShrink: 0, color: C.success || '#5a8a5a', fontSize: '15px' }} aria-label={fixOk ? 'Retyped correctly' : undefined}>{fixOk ? '✓' : ''}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div style={{ marginTop: '14px', display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '6px' }}>
        {!allChecked && !rowMode && (
          <button ref={checkBtnRef} onClick={checkAll} style={{ ...S.btnPrimary, justifyContent: 'center', padding: '11px', fontSize: '14px' }}>
            Check answers
          </button>
        )}
        {!allChecked && rowMode && (
          <div style={{ fontSize: '12px', color: C.textM, textAlign: 'center' }}>{submitted.length} of {rows.length} checked</div>
        )}
        {allChecked && (
          <>
            <button onClick={commit} disabled={!blockers?.ok} style={{
              ...S.btnPrimary, justifyContent: 'center', padding: '11px', fontSize: '14px', opacity: blockers?.ok ? 1 : 0.5,
            }}>
              {lastFixedRound ? 'Finish' : 'Next round'}
            </button>
            {blockerText && <div style={{ fontSize: '12px', color: C.textM, textAlign: 'center' }}>First {blockerText}.</div>}
          </>
        )}
      </div>
    </div>
  );
}

// End of a session (Stage E4): how it went, word by word. The parent saves the
// summary to echo_sessions once (E-D12, E-D14) and passes the save status in.
// The summary's title, first-try tiles and word table (E4), shared by the
// end-of-session screen and the Examiner's Echo log (X2). glossOf(lemmaID)
// returns a short gloss for the word, or null.
function EchoSummaryBody({ sum, glossOf, C }) {
  const pctOf = (x) => (x?.total ? `${Math.round((x.correct / x.total) * 100)}%` : '—');
  const title = sum.endReason === 'complete' ? 'All done both ways'
    : sum.endReason === 'cap' ? `Stopped after ${ECHO_CAP} rounds`
    : sum.endReason === 'ended' ? 'Session ended'
    : 'Session complete';
  const modeText = sum.config?.mode === 'complete' ? ' · until all correct' : '';
  // Words still to work on first, then the most-missed.
  const rows = (sum.items || [])
    .map((it, i) => ({ ...it, i }))
    .sort((a, b) => (a.resolved - b.resolved) || (b.misses - a.misses) || (a.i - b.i));
  const mark = (v) => (v === 'correct' ? { t: '✓', c: C.success || '#5a8a5a' } : v === 'incorrect' ? { t: '✗', c: C.danger } : { t: '–', c: C.textM });
  const colW = '44px';
  const firstTry = sum.firstTry || {};
  const dict = sum.kind === 'dictation';   // X-D17
  const tiles = dict ? [['By ear', firstTry.ear]] : [['English → Korean', firstTry.en2ko], ['Korean → English', firstTry.ko2en]];
  const tableCols = dict ? `1fr ${colW} ${colW}` : `1fr ${colW} ${colW} ${colW}`;

  return (
    <>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontFamily: SH.fd, fontSize: '24px', color: C.text }}>{title}</div>
        <div style={{ fontSize: '12px', color: C.textM, marginTop: '4px' }}>
          {dict ? 'Dictation · ' : ''}{sum.roundsPlayed} round{sum.roundsPlayed === 1 ? '' : 's'} · {sum.itemCount} words{modeText}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: dict ? '1fr' : '1fr 1fr', gap: '12px' }}>
        {tiles.map(([label, x]) => (
          <div key={label} style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '12px', padding: '14px', textAlign: 'center' }}>
            <div style={{ fontFamily: SH.fm, fontSize: '22px', color: C.accent }}>{pctOf(x)}</div>
            <div style={{ fontSize: '11px', color: C.textM, marginTop: '4px' }}>{label}</div>
            <div style={{ fontSize: '10.5px', color: C.textM }}>first try{x?.total ? ` · ${x.correct}/${x.total}` : ''}</div>
          </div>
        ))}
      </div>

      {/* Word by word */}
      <div style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '12px', overflow: 'hidden' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: tableCols, gap: '6px', padding: '8px 12px',
          fontSize: '10px', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.textM,
          borderBottom: `1px solid ${C.border}`,
        }}>
          <div>Word</div>
          {dict ? (
            <div style={{ textAlign: 'center' }} title="First try, by ear">Ear</div>
          ) : (
            <>
              <div style={{ textAlign: 'center' }} title="First try, English → Korean">EN→KO</div>
              <div style={{ textAlign: 'center' }} title="First try, Korean → English">KO→EN</div>
            </>
          )}
          <div style={{ textAlign: 'center' }}>Missed</div>
        </div>
        {rows.map((r, k) => {
          const gloss = glossOf ? glossOf(r.lemmaID) : null;
          const a = mark(dict ? r.firstTry?.ear : r.firstTry?.en2ko), b = mark(r.firstTry?.ko2en);
          const notes = [
            !r.resolved ? (dict ? 'not yet right by ear' : 'not yet right both ways') : '',
            r.overrides ? `marked right ×${r.overrides}` : '',
            r.nearAccepted ? `close answer accepted ×${r.nearAccepted}` : '',
          ].filter(Boolean).join(' · ');
          return (
            <div key={r.lemmaID} style={{
              display: 'grid', gridTemplateColumns: tableCols, gap: '6px', alignItems: 'center',
              padding: '8px 12px', borderTop: k ? `1px solid ${C.border}` : 'none',
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: SH.fk, fontSize: '15px', color: C.text, wordBreak: 'keep-all', overflowWrap: 'break-word' }}>{r.lemma}</div>
                {gloss && <div style={{ fontSize: '11.5px', color: C.textM, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{gloss}</div>}
                {notes && <div style={{ fontSize: '10.5px', color: r.resolved ? C.textM : C.warning, marginTop: '1px' }}>{notes}</div>}
              </div>
              <div style={{ textAlign: 'center', color: a.c, fontSize: '15px' }}>{a.t}</div>
              {!dict && <div style={{ textAlign: 'center', color: b.c, fontSize: '15px' }}>{b.t}</div>}
              <div style={{ textAlign: 'center', fontFamily: SH.fm, fontSize: '13px', color: r.misses ? C.danger : C.textM }}>{r.misses}</div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function EchoSummary({ state, save, onRetrySave, onPracticeMissed, onAgain, onDone, C, S }) {
  const sum = useMemo(() => buildSummary(state), [state]);
  useGlobalKey(e => { if (e.key === 'Enter') onDone(); });
  const itemMap = useMemo(() => new Map(state.items.map(i => [i.id, i])), [state.items]);
  const missed = sum.items.filter(it => it.misses > 0 || !it.resolved);
  const gist = (en) => splitSenses(en)[0]?.display || String(en || '').split('\n')[0];
  const glossOf = (id) => { const item = itemMap.get(id); return item ? gist(item.en) : null; };
  const saveText = !save ? '' : save.status === 'saving' ? 'Saving…'
    : save.status === 'saved' ? 'Saved to your Echo history.'
    : save.status === 'skipped' ? 'No rounds were finished, so nothing was saved.'
    : save.status === 'error' ? "Couldn't save this session." : '';

  return (
    <div style={{ maxWidth: '620px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '16px', ...(isMobile && { paddingTop: '24px' }) }} className="fade-up quiz-session">
      <EchoSummaryBody sum={sum} glossOf={glossOf} C={C} />
      {saveText && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', fontSize: '11.5px', color: save.status === 'error' ? C.danger : C.textM }}>
          {saveText}
          {save.status === 'error' && (
            <button onClick={onRetrySave} style={{ ...S.btnGhost, padding: '3px 10px', fontSize: '12px' }}>Retry</button>
          )}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: '8px', justifyContent: 'flex-end' }}>
        {missed.length > 0 && missed.length < sum.itemCount && (
          <button style={{ ...S.btnPrimary, justifyContent: 'center' }} onClick={() => onPracticeMissed(missed.map(m => m.lemmaID))}>
            Practice the missed words ({missed.length})
          </button>
        )}
        <button style={{ ...S.btnGhost, justifyContent: 'center' }} onClick={onAgain}>Run it again</button>
        <button style={{ ...S.btnGhost, justifyContent: 'center' }} onClick={onDone}>Back to Quizzes</button>
      </div>
    </div>
  );
}

// Runs a session: one keyed EchoRound per round (so each round starts with
// empty answers, or the saved draft when resuming), then the summary. Hides
// the phone's bottom nav while rounds are on screen (E-D15; CSS rule in
// buildStyles.js).
function EchoSession({ state, draft, onDraft, onChange, save, onRetrySave, onPracticeMissed, onAgain, onExit, alternatesOf, onSaveAlternate, audioOf, ttsSpeed, C, S }) {
  useEffect(() => {
    if (state.done) return undefined;
    document.body.classList.add('echo-active');
    return () => document.body.classList.remove('echo-active');
  }, [state.done]);
  if (state.done) {
    return <EchoSummary state={state} save={save} onRetrySave={onRetrySave} onPracticeMissed={onPracticeMissed} onAgain={onAgain} onDone={onExit} C={C} S={S} />;
  }
  return <EchoRound key={`${state.startedAt}|${state.round}`} state={state} initialDraft={draft} onDraft={onDraft} onCommit={onChange} onEnd={onChange} alternatesOf={alternatesOf} onSaveAlternate={onSaveAlternate} audioOf={audioOf} ttsSpeed={ttsSpeed} C={C} S={S} />;
}

// ─────────────────────────────────────────────────────────────
// WEIGHTED CARD SELECTION
// ─────────────────────────────────────────────────────────────
// Weight formula (applied within the selected pool):
//   never reviewed                       → weight 1 (neutral)
// FSRS cards (have stability — every card graded since the FSRS switch):
//   lapses > 3 or difficulty > 7         → base weight 3 (same "struggling"
//                                          thresholds as triageBucket)
//   otherwise                            → base weight 1
//   state learning/relearning            → weight × 2 (last answer was Again)
// Legacy SM-2 cards (no stability):
//   easeFactor < 2.0                     → base weight 3
//   otherwise                            → base weight 1
//   lastGrade < 3 (and grade exists)     → weight × 2
//   no SM-2 history (repetitions === 0)  → weight 1 (neutral)
// FSRS grading never writes the SM-2 fields, so reading only those left
// every FSRS card at weight 1 and the weak-card bias silently off.
function cardWeight(card) {
  if (isNewCard(card)) return 1;
  if (card.stability) {
    const base = (card.lapses ?? 0) > 3 || (card.difficulty ?? 5) > 7 ? 3 : 1;
    const lastWasAgain = card.state === 'learning' || card.state === 'relearning';
    return lastWasAgain ? base * 2 : base;
  }
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
function HardModeLoading({ C, label = 'Preparing quiz…' }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', minHeight: '320px', gap: '20px',
    }}>
      <CrowLoader />
      <div style={{ fontSize: '13px', color: C.textM }}>{label}</div>
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

  // Single-fire guard: the save awaits before the view changes, so on a slow
  // connection the session UI (Continue / End) stays tappable for seconds.
  // A second tap would re-run the finish math (double-counting the last
  // matching set) and save a duplicate result doc.
  const finishedRef = useRef(false);
  const finishOnce = (...args) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onFinish(...args);
  };

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
              // Total counts only answered linear questions (matching the
              // cloze End behavior) so unanswered questions don't silently
              // drag the score down without appearing in the results tiles.
              const creditSum   = questions.reduce((s, qu) => s + (qu.credit ?? (qu.isCorrect ? 1.0 : 0.0)), 0);
              const matchCredit = matchCorrects.reduce((s, r) => s + r.correct, 0);
              const matchTotal  = matchCorrects.reduce((s, r) => s + r.total, 0);
              const answeredCount = questions.filter(qu => qu.answered).length;
              finishOnce(questions, creditSum + matchCredit, (answeredCount + matchTotal) || 1, matchMisses, matchTotal);
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
        finishOnce(qs, creditSum, qs.length, matchMisses, 0);
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
    if (finishedRef.current) return;
    const newCorrects = [...matchCorrects, { correct, total }];
    const newMisses   = [...matchMisses, ...wrongPairs];
    setMatchCorrects(newCorrects);
    setMatchMisses(newMisses);
    // Direct values (not functional updates) so a double-tap on Continue
    // before React commits is idempotent instead of double-advancing.
    setMatchTermsDone(matchTermsDone + total);
    setMatchLiveCount(0);

    if (matchSetIdx + 1 >= matchSets.length) {
      const linearCredit = questions.reduce((s, qu) => s + (qu.credit ?? (qu.isCorrect ? 1.0 : 0.0)), 0);
      const matchCredit  = newCorrects.reduce((s, r) => s + r.correct, 0);
      const matchQTotal  = newCorrects.reduce((s, r) => s + r.total, 0);
      finishOnce(questions, linearCredit + matchCredit, linearTotal + matchQTotal, newMisses, matchQTotal);
    } else {
      setMatchSetIdx(matchSetIdx + 1);
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
            // isComposing: the Korean keyboard is still building a syllable.
            // That Enter only finishes the syllable; submitting on it can
            // send twice and skip past the feedback.
            onKeyDown={e => e.key === 'Enter' && !e.nativeEvent.isComposing && handleSubmit()}
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
  const [localQs, setLocalQs] = useState(questions);
  const [saving,  setSaving]  = useState(false);
  useGlobalKey(e => { if (e.key === 'Enter') onDone(); });

  // Resync if the parent hands down a different questions array (e.g. a
  // late-landing duplicate finish over a slow connection replaced lastResult).
  useEffect(() => { setLocalQs(questions); }, [questions]);

  const getCredit = q => q.credit ?? (q.isCorrect ? 1.0 : 0.0);

  // Headline % derives from the same per-question credits the tiles use —
  // one source of truth, so the headline and tiles can never disagree.
  const liveCorrect = localQs.reduce((s, q) => s + getCredit(q), 0)
                    + Math.max(0, matchTotal - matchMisses.length);
  const rawPct = total > 0 ? liveCorrect / total * 100 : 0;
  const pct    = formatScore(Math.round(rawPct * 10) / 10);

  const answered = localQs.filter(q => q.answered);

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
// single (G3): pick exactly one concept (Drill) — a tap replaces the choice.
function ConceptPicker({ corpus, selectedIds, onChange, required, single = false, C, S }) {
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
      : single ? [id] : [...selectedIds, id]);
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
function GrammarQuizConfig({ open, onBack, onStart, corpus, C, S }) {
  const [config, setConfig] = useState(() => loadConfig(GRAMMAR_CONFIG_KEY, GRAMMAR_DEFAULTS));
  const set = (key, val) => setConfig(prev => {
    const next = { ...prev, [key]: val };
    saveConfig(GRAMMAR_CONFIG_KEY, next);
    return next;
  });

  const isDrill       = config.transMode === 'drill';
  const isSelection   = config.mode === 'selection';
  const isTranslation = config.mode === 'translation';

  // Drill requires at least 1 concept; Selection requires at least 2
  const minSelected = isSelection ? 2 : 1;
  const canStart = corpus.length > 0 &&
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
              ? <ConceptPicker corpus={corpus} selectedIds={config.selectedIds} onChange={v => set('selectedIds', v)} single={isDrill} C={C} S={S} />
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

        {isSelection && config.selectedIds.length < 2 && config.selectedIds.length > 0 && (
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

// ── Grammar notice banner (G2) ────────────────────────────────
// A short notice with up to two actions: failed requests (tone 'error') and
// the device-only resume offer (tone 'info').
function GrammarNotice({ tone = 'info', title, text, actions = [], C, S }) {
  const color = tone === 'error' ? C.danger : C.accent;
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} style={{
      display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap',
      background: `${color}10`, border: `1px solid ${color}30`, borderRadius: '10px',
      padding: '12px 16px', marginBottom: '20px',
    }}>
      <div style={{ flex: '1 1 220px', minWidth: 0 }}>
        {title && <div style={{ fontSize: '13px', color: C.text, fontWeight: 600, marginBottom: text ? '2px' : 0 }}>{title}</div>}
        {text && <div style={{ fontSize: '12px', color: C.textS, lineHeight: 1.5 }}>{text}</div>}
      </div>
      {actions.length > 0 && (
        <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
          {actions.map(a => (
            <button
              key={a.label}
              onClick={a.onClick}
              style={{ ...(a.primary ? S.btnPrimary : S.btnGhost), padding: '7px 14px', fontSize: '12px' }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Grammar session header (G2) ───────────────────────────────
// Progress bar, counter and End. End asks first; ending discards the session,
// including its device-only resume snapshot.
function GrammarSessionHeader({ idx, total, isLast, onEnd, C, S }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div style={{ marginBottom: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div style={{ flex: 1, height: '4px', background: `${C.accent}22`, borderRadius: '2px' }}>
          <div style={{ height: '100%', width: `${((isLast ? total : idx) / total) * 100}%`, background: C.accent, borderRadius: '2px', transition: 'width 0.3s' }} />
        </div>
        <span style={{ fontFamily: SH.fm, fontSize: '11px', color: C.textM }}>{idx + 1} / {total}</span>
        {onEnd && !confirming && (
          <button
            onClick={() => setConfirming(true)}
            style={{ fontSize: '11px', color: C.textM, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            End
          </button>
        )}
      </div>
      {confirming && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '12px',
          padding: '10px 14px', borderRadius: '10px', background: `${C.danger}10`, border: `1px solid ${C.danger}30`,
        }}>
          <span style={{ flex: '1 1 200px', fontSize: '12px', color: C.textS, lineHeight: 1.5 }}>
            End this quiz? Your answers so far won't be assessed or kept.
          </span>
          <button onClick={() => setConfirming(false)} style={{ ...S.btnGhost, padding: '6px 12px', fontSize: '12px' }}>Keep going</button>
          <button onClick={onEnd} style={{ ...S.btnPrimary, padding: '6px 12px', fontSize: '12px' }}>End quiz</button>
        </div>
      )}
    </div>
  );
}

// ── Grammar Translation Session ───────────────────────────────
// initial: optional resume state { idx, translations, conceptChoices } (G2).
// onProgress fires on every change so QuizzesPage can keep the device-only
// snapshot current; onEnd discards the session.
function GrammarTranslationSession({ questions, config, initial, onProgress, onEnd, onFinish, C, S }) {
  const [idx,            setIdx]            = useState(() => initial?.idx || 0);
  const [translations,   setTranslations]   = useState(() => initial?.translations || questions.map(() => ''));
  // Chosen concept per question (Broad mode only)
  const [conceptChoices, setConceptChoices] = useState(() => initial?.conceptChoices || questions.map(() => null));
  const [submitted,      setSubmitted]      = useState(false);
  const submittedRef = useRef(false); // double-submit guard (same race as the old VocaQuizSession double finish)

  const q          = questions[idx];
  const isBroad    = config?.transMode === 'broad';
  const isLast     = idx === questions.length - 1;
  const selectedId = conceptChoices[idx] || null;

  // Keep the resume snapshot current. Only this session's own state matters
  // here; onProgress is read fresh from props each time.
  useEffect(() => {
    onProgress?.({ idx, translations, conceptChoices });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, translations, conceptChoices]);

  const updateTranslation = (val) => {
    setTranslations(prev => prev.map((t, i) => i === idx ? val : t));
  };

  const updateConcept = (id) => {
    setConceptChoices(prev => prev.map((c, i) => i === idx ? id : c));
  };

  const handleSubmit = () => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    setSubmitted(true);
    onFinish({ translations, conceptChoices });
  };

  if (!q) return null;

  return (
    <div style={{ maxWidth: '680px', margin: '0 auto' }} className="fade-up quiz-session">
      <GrammarSessionHeader idx={idx} total={questions.length} isLast={isLast} onEnd={onEnd} C={C} S={S} />

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
          onClick={() => setIdx(prev => Math.max(0, prev - 1))}
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
          <button onClick={() => { quizSound('mouse_click'); setIdx(prev => prev + 1); }} style={{ ...S.btnPrimary, padding: '10px 24px' }}>
            Next
          </button>
        )}
      </div>
    </div>
  );
}

// ── Concepts in this quiz (G5) ────────────────────────────────
// Each tested concept with its current Grammar Index mastery, a link to its
// entry (mastery is changed there — never from the quiz, G-D6) and to its
// Grammar Deck card, plus one "Practice missed concepts" session (G-D15).
// links: { cards, masteryOf(id), onOpenEntry(id), onPracticeCards(cardIds) }
// from QuizzesPage; the buttons hide when a callback isn't wired.
function GrammarConceptLinks({ kind, questions, score, links, C, S }) {
  const concepts = useMemo(() => summarizeQuizConcepts(kind, questions, score), [kind, questions, score]);
  if (!links || !concepts.length) return null;
  const missedCards = cardIdsForConcepts(concepts.filter(c => c.missed).map(c => c.id), links.cards).cardIds;
  const label = { fontSize: '10px', fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: C.textM };
  const small = { padding: '5px 10px', fontSize: '11.5px' };
  return (
    <div style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '14px', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
        <span style={label}>Concepts in this quiz</span>
        {links.onPracticeCards && missedCards.length > 0 && (
          <button style={{ ...S.btnPrimary, ...small }} onClick={() => links.onPracticeCards(missedCards)}>
            Practice missed concepts ({missedCards.length})
          </button>
        )}
      </div>
      {concepts.map(c => {
        const m = GRAMMAR_MASTERY[links.masteryOf?.(c.id)] || GRAMMAR_MASTERY.introduced;
        const cardId = cardIdsForConcepts([c.id], links.cards).cardIds[0];
        return (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '8px 10px', flexWrap: 'wrap', paddingTop: '8px', borderTop: `1px solid ${C.border}` }}>
            <span style={{ fontFamily: SH.fk, fontSize: '13.5px', color: C.text, flex: '1 1 140px', minWidth: 0 }}>{c.term}</span>
            <span style={{ fontSize: '11px', fontStyle: 'italic', color: c.missed ? C.danger : C.textM }}>{c.missed ? 'Missed' : 'All correct'}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: C.textS }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: m.color, border: `1px solid ${C.border}` }} />
              {m.label}
            </span>
            {links.onOpenEntry && (
              <button style={{ ...S.btnGhost, ...small }} onClick={() => links.onOpenEntry(c.id)}>Grammar Index</button>
            )}
            {links.onPracticeCards && (cardId
              ? <button style={{ ...S.btnGhost, ...small }} onClick={() => links.onPracticeCards([cardId])}>Card</button>
              : <span style={{ fontSize: '11px', color: C.textM }}>No card</span>)}
          </div>
        );
      })}
    </div>
  );
}

// The same concept links inside a Report Card quiz record (G5), so they can
// still be reached after leaving the results screen.
function GrammarDetailConcepts({ detail, links, C, S }) {
  const kind = detail?.mode === 'selection' ? 'selection' : 'translation';
  const score = useMemo(() => {
    if (kind === 'selection') return scoreSelectionQuiz(detail.questions, readSavedSelections(detail.selections));
    return detail?.assessment ? scoreTranslationQuiz(detail.questions, detail.assessment, detail.conceptChoices) : null;
  }, [detail, kind]);
  return <GrammarConceptLinks kind={kind} questions={detail.questions} score={score} links={links} C={C} S={S} />;
}

// ── Grammar Translation Results ───────────────────────────────
const VERDICT_STYLE = {
  'O': { symbol: 'O', color: '#5a8a5a' },
  '△': { symbol: '△', color: '#b87c2a' },
  'X': { symbol: 'X', color: '#a03030' },
};

// The concept line on a translation question (G3). Drill: the target concept.
// Broad: the answer, plus what the learner picked when it was wrong or missing.
// Shared by the results screen and the Report Card detail. chosenId is null
// for "no pick" and undefined for "no record" (quizzes saved before G3).
function GrammarConceptPick({ q, chosenId, C }) {
  const answer = q?.correctConcept?.term || '—';
  const label = { fontSize: '10px', fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: C.textM };
  const chip = (text, color, bg) => (
    <span style={{ fontSize: '12px', color, fontFamily: SH.fk, background: bg, borderRadius: '6px', padding: '4px 10px' }}>{text}</span>
  );
  if (!Array.isArray(q?.choices) || !q.choices.length || chosenId === undefined) {
    return <div style={{ alignSelf: 'flex-start' }}>{chip(answer, C.accent, C.accentSoft)}</div>;
  }
  const chosen = q.choices.find(c => c && c.id === chosenId) || null;
  if (chosen && chosen.id === q.correctConceptId) {
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 10px' }}>
        {chip(answer, C.accent, C.accentSoft)}
        <span style={label}>Your pick · correct</span>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 10px' }}>
      <span style={label}>Answer</span>
      {chip(answer, C.accent, C.accentSoft)}
      {chosen
        ? <><span style={label}>You chose</span>{chip(chosen.term, C.danger, `${C.danger}12`)}</>
        : <span style={label}>No concept chosen</span>}
    </div>
  );
}

// assessErrorCode: set when the assessment failed or never ran (G2); the
// screen then offers Retry / Assess now instead of a score.
// Scoring (G3): Drill = translation credit (O 1, △ 0.5, X 0); Broad = 0.5 for
// the concept pick + 0.5 × translation credit. See scoreTranslationQuiz.
function GrammarTranslationResults({ questions, translations, conceptChoices, assessment, assessErrorCode, onRetryAssess, onOverride, links, onDone, C, S }) {
  // Enter = Back to Quizzes, except while a Retry button is showing (G2), so
  // pressing Enter on Retry doesn't also leave the screen.
  useGlobalKey(e => { if (e.key === 'Enter') onDone(); }, { enabled: !!assessment });
  const score = useMemo(
    () => scoreTranslationQuiz(questions, assessment, conceptChoices),
    [questions, assessment, conceptChoices]
  );

  return (
    <div style={{ maxWidth: '680px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '20px' }} className="fade-up quiz-session">
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontFamily: SH.fm, fontSize: '38px', color: C.accent }}>{assessment ? `${score.pct}%` : '—'}</div>
        <div style={{ fontSize: '12px', color: C.textM, marginTop: '4px' }}>
          {assessment
            ? `${formatPoints(score.points)} / ${score.total} points · ${score.fullyCorrect} fully correct`
            : 'Not assessed yet'}
        </div>
      </div>

      {!assessment && assessErrorCode && onRetryAssess && (
        <GrammarNotice
          tone="error"
          title={assessErrorCode === 'interrupted' ? 'Not assessed yet' : 'Assessment failed'}
          text={assessErrorCode === 'interrupted'
            ? 'This quiz was submitted but never assessed. Your translations are below.'
            : `${describeGrammarQuizError(assessErrorCode)} Your translations are kept.`}
          actions={[{ label: assessErrorCode === 'interrupted' ? 'Assess now' : 'Retry assessment', primary: true, onClick: onRetryAssess }]}
          C={C} S={S}
        />
      )}

      {/* Concept links (G5) — once there's a score to base "missed" on */}
      {assessment && <GrammarConceptLinks kind="translation" questions={questions} score={score} links={links} C={C} S={S} />}

      {questions.map((q, i) => {
        const a  = assessment?.[i];
        const vs = a ? VERDICT_STYLE[a.verdict] || VERDICT_STYLE['X'] : null;
        const p  = score.perQuestion[i];
        return (
          <div key={i} style={{
            background: C.raised, border: `1px solid ${C.border}`, borderRadius: '14px',
            padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: '12px',
          }}>
            {/* Header: sentence + verdict and points */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '15px', color: C.text, lineHeight: 1.5, marginBottom: '4px' }}>{q.english}</div>
                {q.context && <div style={{ fontSize: '11px', color: C.textM, fontStyle: 'italic' }}>{q.context}</div>}
              </div>
              {(vs || (assessment && p)) && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px', flexShrink: 0 }}>
                  {vs && <div style={{ fontFamily: SH.fm, fontSize: '28px', color: vs.color, lineHeight: 1 }}>{vs.symbol}</div>}
                  {assessment && p && (
                    <div style={{ fontFamily: SH.fm, fontSize: '11px', color: C.textM }}>{formatPoints(p.points)} / 1</div>
                  )}
                </div>
              )}
            </div>

            {/* Concept: target (Drill) or answer vs. pick (Broad) */}
            <GrammarConceptPick q={q} chosenId={conceptChoices?.[i]} C={C} />

            {/* Your translation */}
            <div>
              <div style={{ fontSize: '10px', fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: C.textM, marginBottom: '4px' }}>Your translation</div>
              <div style={{ fontFamily: SH.fk, fontSize: '14px', color: C.text, lineHeight: 1.6 }}>
                {translations[i] || <span style={{ color: C.textM, fontStyle: 'italic' }}>No translation entered</span>}
              </div>
            </div>

            {/* Corrected sentence (△ and X; an O only when the assessor fixed a typo or spacing slip) */}
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

            {/* Override the translation verdict (like the Vocabulary Quiz):
                raise X → △ / O or △ → O, or undo. A Broad concept pick
                is never overridden. */}
            {a && onOverride && (a.overriddenFrom || overrideOptions(a).length > 0) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                {a.overriddenFrom && (
                  <span style={{ fontSize: '11px', color: C.textM }}>Overridden — assessed {a.overriddenFrom}</span>
                )}
                {overrideOptions(a).map(v => (
                  <button
                    key={v}
                    onClick={() => onOverride(i, v)}
                    style={{
                      fontSize: '12px', color: C.accent,
                      background: C.accentSoft, border: `1px solid ${C.accent}44`,
                      borderRadius: '6px', padding: '4px 12px', cursor: 'pointer',
                    }}
                  >
                    {v === 'O' ? 'Mark as correct' : 'Mark as partial'}
                  </button>
                ))}
                {a.overriddenFrom && (
                  <button
                    onClick={() => onOverride(i, null)}
                    style={{
                      fontSize: '12px', color: C.textM, background: 'none',
                      border: `1px solid ${C.border}`, borderRadius: '6px', padding: '4px 12px', cursor: 'pointer',
                    }}
                  >
                    Undo
                  </button>
                )}
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
// initial: optional resume state { idx, selections } (G2). Selections are
// kept as arrays of sentence indexes so they can be saved as they are.
function GrammarSelectionSession({ questions, initial, onProgress, onEnd, onFinish, C, S }) {
  const [idx,        setIdx]        = useState(() => initial?.idx || 0);
  const [selections, setSelections] = useState(() => initial?.selections || questions.map(() => []));
  const [submitted,  setSubmitted]  = useState(false);
  const submittedRef = useRef(false); // double-submit guard

  const q = questions[idx];
  const isLast = idx === questions.length - 1;

  useEffect(() => {
    onProgress?.({ idx, selections });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, selections]);

  const toggleSentence = (sentIdx) => {
    if (submittedRef.current) return;
    setSelections(prev => prev.map((s, i) => {
      if (i !== idx) return s;
      return s.includes(sentIdx) ? s.filter(x => x !== sentIdx) : [...s, sentIdx];
    }));
  };

  const handleSubmit = () => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    setSubmitted(true);
    onFinish(selections.map(s => [...s]));
  };

  if (!q) return null;

  return (
    <div style={{ maxWidth: '680px', margin: '0 auto' }} className="fade-up quiz-session">
      <GrammarSessionHeader idx={idx} total={questions.length} isLast={isLast} onEnd={onEnd} C={C} S={S} />

      <div style={{ fontSize: '11px', color: C.textM, marginBottom: '14px', lineHeight: 1.5 }}>
        Select all grammatically and contextually correct sentences.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '24px' }}>
        {q.sentences.map((sent, si) => {
          const isSelected = selections[idx].includes(si);
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
          onClick={() => setIdx(prev => Math.max(0, prev - 1))}
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
// Review list for a Selection quiz (G4): per question, whether it was fully
// right, then each sentence with the concept it tested, what the learner did,
// and — for incorrect sentences — the corrected form and why. Shared by the
// results screen and the Report Card detail.
function GrammarSelectionReview({ questions, selections, explanations = {}, C }) {
  const score = useMemo(() => scoreSelectionQuiz(questions, selections), [questions, selections]);
  const label = { fontSize: '10px', fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: C.textM };
  return (questions || []).map((q, qi) => {
    const pq = score.perQuestion[qi];
    return (
      <div key={qi} style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '14px', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={label}>Question {qi + 1}</span>
          <span style={{ fontSize: '11px', fontWeight: 600, color: pq?.correct ? C.accent : C.danger }}>
            {pq?.correct ? 'All right' : 'Not quite'}
          </span>
        </div>
        {(q.sentences || []).map((s, si) => {
          const st = pq?.sentences[si] || { selected: false, isRight: !s.correct };
          let borderColor = C.border, bgColor = 'transparent', textColor = C.textM;
          if (s.correct && st.selected)        { borderColor = C.warning; bgColor = `${C.warning}18`; textColor = C.warning; }
          else if (s.correct && !st.selected)  { borderColor = C.danger;  bgColor = `${C.danger}12`;  textColor = C.danger;  }
          else if (!s.correct && st.selected)  { borderColor = C.danger;  bgColor = `${C.danger}12`;  textColor = C.danger;  }
          const note = s.correct
            ? (st.selected ? 'Correct — you selected it' : 'Correct — you missed it')
            : (st.selected ? 'Incorrect — you selected it' : 'Incorrect — you left it out');
          const exp = explanations[`${qi}-${si}`];
          return (
            <div key={si} style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
              <div style={{
                padding: '11px 16px', borderRadius: '10px', fontSize: '14px',
                border: `1.5px solid ${borderColor}`, background: bgColor,
                color: textColor, fontFamily: SH.fk, lineHeight: 1.6,
              }}>
                {s.text}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 10px', paddingLeft: '4px' }}>
                {s.concept && (
                  <span style={{ fontSize: '11px', color: C.accent, fontFamily: SH.fk, background: C.accentSoft, borderRadius: '6px', padding: '2px 8px' }}>{s.concept}</span>
                )}
                <span style={{ fontSize: '11px', fontStyle: 'italic', color: st.isRight ? C.textM : C.danger }}>{note}</span>
              </div>
              {!s.correct && (s.fix || s.reason) && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', paddingLeft: '4px' }}>
                  {s.fix && (
                    <div style={{ fontFamily: SH.fk, fontSize: '13px', color: C.text, lineHeight: 1.6, padding: '6px 10px', background: `${C.accent}0e`, borderRadius: '7px', borderLeft: `3px solid ${C.accent}` }}>
                      {s.fix}
                    </div>
                  )}
                  {s.reason && <div style={{ fontSize: '12px', color: C.textS, lineHeight: 1.5 }}>{s.reason}</div>}
                </div>
              )}
              {exp && <div style={{ fontSize: '12.5px', color: C.textS, lineHeight: 1.6, paddingLeft: '4px' }}>{exp}</div>}
            </div>
          );
        })}
      </div>
    );
  });
}

// Scoring (G4): a question counts only when the selection matches the correct
// sentences exactly. onExplanations(map) receives every explanation fetched so
// far, keyed "question-sentence", so QuizzesPage can save them with the result.
function GrammarSelectionResults({ questions, userSelections, onExplanations, links, onDone, C, S }) {
  const [showExplainModal, setShowExplainModal] = useState(false);
  const [toExplain,        setToExplain]        = useState(new Set()); // Set of "qi-si" keys
  const [explanations,     setExplanations]     = useState({});
  const [explaining,       setExplaining]       = useState(false);
  const [explainError,     setExplainError]     = useState(false);
  useGlobalKey(e => { if (e.key === 'Enter') onDone(); }, { enabled: !showExplainModal });

  const score = useMemo(() => scoreSelectionQuiz(questions, userSelections), [questions, userSelections]);

  // Every misjudged sentence, for the explanation modal
  const allMistakes = questions.flatMap((q, qi) =>
    (q.sentences || []).map((s, si) => ({ s, si, st: score.perQuestion[qi]?.sentences[si] }))
      .filter(({ st }) => st && !st.isRight)
      .map(({ s, si, st }) => ({ key: `${qi}-${si}`, qi, si, text: s.text, concept: s.concept, correct: s.correct, userSelected: st.selected }))
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

    try {
      // Structured request — the server owns the explanation prompt template.
      // Explanations are matched by item number, never position (G1), and
      // merged so an earlier round's explanations stay visible.
      const parsed = await callGrammarQuizAPI(buildExplainRequest(items));
      const texts  = alignExplanations(parsed, items.length);
      const next   = { ...explanations };
      items.forEach((m, i) => { if (texts[i]) next[m.key] = texts[i]; });
      setExplanations(next);
      onExplanations?.(next);
    } catch (e) {
      console.error('Selection explanation failed:', e);
      setExplainError(true);
    } finally {
      setExplaining(false);
    }
  };

  return (
    <div style={{ maxWidth: '680px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '20px' }} className="fade-up quiz-session">
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontFamily: SH.fm, fontSize: '38px', color: C.accent }}>{score.pct}%</div>
        <div style={{ fontSize: '12px', color: C.textM, marginTop: '4px' }}>
          {score.points} / {score.total} questions fully right
        </div>
      </div>

      <GrammarConceptLinks kind="selection" questions={questions} score={score} links={links} C={C} S={S} />

      <GrammarSelectionReview questions={questions} selections={userSelections} explanations={explanations} C={C} />

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
    if (!byDate[key]) byDate[key] = { voca: [], gram: [], gramSel: [], cloze: [] };
    if (r.type === 'voca')    byDate[key].voca.push(r.score);
    // Grammar splits into Translation (gram) and Selection (gramSel) — G4
    if (r.type === 'grammar') byDate[key][grammarResultMode(r) === 'selection' ? 'gramSel' : 'gram'].push(r.score);
    if (r.type === 'cloze')   byDate[key].cloze.push(r.score);
  }
 return Object.entries(byDate).sort(([a], [b]) => a.localeCompare(b)).map(([date, d]) => {
    const vocaScore  = d.voca.length  ? Math.round(d.voca.reduce((s, v)  => s + v, 0) / d.voca.length)  : null;
    const gramScore  = d.gram.length  ? Math.round(d.gram.reduce((s, v)  => s + v, 0) / d.gram.length)  : null;
    const gramSelScore = d.gramSel.length ? Math.round(d.gramSel.reduce((s, v) => s + v, 0) / d.gramSel.length) : null;
    const clozeScore = d.cloze.length ? Math.round(d.cloze.reduce((s, v) => s + v, 0) / d.cloze.length) : null;
    // Combined cross-type trend — equal-weighted average of the three
    // per-type daily averages (a type with one result counts the same as a
    // type with ten); allCount below tracks raw volume instead, for the
    // combined line's variable thickness.
    const typeAverages = [vocaScore, gramScore, gramSelScore, clozeScore].filter(v => v !== null);
    const allScore = typeAverages.length ? Math.round(typeAverages.reduce((s, v) => s + v, 0) / typeAverages.length) : null;
    const allCount = d.voca.length + d.gram.length + d.gramSel.length + d.cloze.length;
    return {
      dateLabel: date.slice(5),
      vocaScore, gramScore, gramSelScore, clozeScore,
      vocaAll: d.voca, gramAll: d.gram, gramSelAll: d.gramSel, clozeAll: d.cloze,
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
  // Grammar results show which kind of grammar quiz they were (G4)
  const typeLabel = isVoca ? 'Voca' : isCloze ? 'Cloze' : grammarResultMode(r) === 'selection' ? 'Selection' : 'Translation';
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

      {/* Grammar · Selection (G4) — hollow circles, dotted line, grammar colour */}
      {data.map((d, i) => {
        const scores = d.gramSelAll || (d.gramSelScore != null ? [d.gramSelScore] : []);
        if (!scores.length) return null;
        return clusterScores(scores).map((pt, k) => (
          <circle
            key={`gss-${i}-${k}`}
            cx={(toX(i) + pt.xOffset).toFixed(1)}
            cy={toY(pt.score).toFixed(1)}
            r="3"
            fill="none" stroke={gramColor} strokeWidth="1.2"
            opacity={pt.opacity.toFixed(2)}
          />
        ));
      })}
      {buildPath(data.map(d => d.gramSelScore ?? null)) && (
        <path d={buildPath(data.map(d => d.gramSelScore ?? null))}
          fill="none" stroke={gramColor} strokeWidth="2"
          strokeDasharray="1.5,3.5" strokeLinejoin="round" strokeLinecap="round" />
      )}
      {data.map((d, i) => d.gramSelScore != null && (
        <circle key={`gsm-${i}`} cx={toX(i)} cy={toY(d.gramSelScore)} r="3.5" fill={C.bg} stroke={gramColor} strokeWidth="1.5" />
      ))}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────
// ECHO HISTORY ON THE EXAMINER (X2)
// ─────────────────────────────────────────────────────────────
const ECHO_END_LABEL = { rounds: 'Complete', complete: 'All done both ways', cap: 'Stopped at the cap', ended: 'Ended early' };
const echoDay = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : toDateStr(d); };
const echoPct = (x) => (x?.total ? `${Math.round((x.correct / x.total) * 100)}%` : '—');
const echoGloss = (e) => (e ? (splitSenses(e.def2 || '')[0]?.display || def1ShortGloss(e.def1) || '') : '');

// One saved Echo session in the Echo Log.
function EchoLogRow({ s, last, onClick, C }) {
  return (
    <div
      onClick={onClick}
      onMouseEnter={e => { e.currentTarget.style.background = `${C.accent}08`; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px',
        padding: '10px 16px', borderBottom: last ? 'none' : `1px solid ${C.border}`,
        fontSize: '12.5px', cursor: 'pointer', transition: 'background 0.1s',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span style={{
            fontSize: '10px', fontWeight: 600, textTransform: 'uppercase', padding: '2px 7px', borderRadius: '10px',
            color: C.warning, background: `${C.warning}18`,
          }}>{s.kind === 'dictation' ? 'Dictation' : 'Echo'}</span>
          <span style={{ color: C.textM }}>{echoDay(s.finishedAt || s.startedAt)}</span>
        </div>
        <div style={{ fontSize: '11px', color: C.textM, marginTop: '3px' }}>
          {s.itemCount ?? 0} words · {s.roundsPlayed ?? 0} round{s.roundsPlayed === 1 ? '' : 's'} · {ECHO_END_LABEL[s.endReason] || 'Complete'}
        </div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        {s.kind === 'dictation' ? (
          <>
            <div style={{ fontFamily: SH.fm, fontSize: '13px', color: C.accent }}>{echoPct(s.firstTry?.ear)}</div>
            <div style={{ fontSize: '10px', color: C.textM }}>first try by ear</div>
          </>
        ) : (
          <>
            <div style={{ fontFamily: SH.fm, fontSize: '13px', color: C.accent }}>{echoPct(s.firstTry?.en2ko)} · {echoPct(s.firstTry?.ko2en)}</div>
            <div style={{ fontSize: '10px', color: C.textM }}>first try EN→KO · KO→EN</div>
          </>
        )}
      </div>
    </div>
  );
}

// A saved session's summary, read-only, from the Echo Log.
function EchoHistoryModal({ session, byId, onClose, C, S }) {
  useGlobalKey(e => { if (e.key === 'Escape') onClose(); });
  const glossOf = (id) => echoGloss(byId.get(id)) || null;
  return createPortal(
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 200,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
    }} onClick={onClose}>
      <div style={{ ...S.modal, maxWidth: '620px', maxHeight: 'min(80vh, calc(100dvh - 32px))', display: 'flex', flexDirection: 'column', gap: '16px' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '12px', color: C.textM }}>Echo · {echoDay(session.finishedAt || session.startedAt)}</span>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: C.textM, cursor: 'pointer', fontSize: '18px', padding: '2px' }}>✕</button>
        </div>
        <EchoSummaryBody sum={session} glossOf={glossOf} C={C} />
      </div>
    </div>,
    document.body,
  );
}

// Every word Echo has seen (X-D6): first try each way, misses, last seen,
// a three-session trend, saved alternates (× removes, X-D3), and ticks for
// "Practice these", which opens the Echo setup with the ticked words.
const WR_PAGE_SIZE = 10;
function EchoWordRecord({ sessions, lemmaMaster, onRemoveAlternate, onPractice, C, S }) {
  const [query,  setQuery]  = useState('');
  const [page,   setPage]   = useState(0);
  const [ticked, setTicked] = useState([]);
  const record = useMemo(() => buildWordRecord(sessions), [sessions]);
  const byId = useMemo(() => new Map((lemmaMaster || []).filter(e => e?.lemmaID).map(e => [e.lemmaID, e])), [lemmaMaster]);
  const rows = useMemo(() => {
    const q = query.normalize('NFC').trim().toLowerCase();
    if (!q) return record;
    const qk = q.replace(/\s+/g, '');
    return record.filter(r => {
      const e = byId.get(r.lemmaID);
      const ko = String(e?.lemma || r.lemma).normalize('NFC').toLowerCase().replace(/\s+/g, '');
      const en = `${e?.def2 || ''}\n${e?.def1 || ''}`.toLowerCase();
      return ko.includes(qk) || en.includes(q);
    });
  }, [record, query, byId]);
  const totalPages = Math.max(1, Math.ceil(rows.length / WR_PAGE_SIZE));
  const pg = Math.min(page, totalPages - 1);
  const shown = rows.slice(pg * WR_PAGE_SIZE, (pg + 1) * WR_PAGE_SIZE);
  const usable = ticked.filter(id => byId.has(id));
  const toggle = (id) => setTicked(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  const lastSeen = (iso) => { const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
  const cols = isMobile ? '24px minmax(0, 1fr) auto' : '24px minmax(0, 1fr) 62px 62px 62px 56px 52px 58px 64px';
  const head = { fontSize: '10px', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.textM, textAlign: 'center' };
  const trendMarks = (trend) => (
    <span title="Last three sessions, oldest first" style={{ letterSpacing: '2px', whiteSpace: 'nowrap' }}>
      {trend.map((ok, i) => <span key={i} style={{ color: ok ? (C.success || '#5a8a5a') : C.danger }}>{ok ? '✓' : '✗'}</span>)}
    </span>
  );

  if (!record.length) {
    return <div style={{ fontSize: '12px', color: C.textM, fontStyle: 'italic', padding: '14px 0' }}>No Echo sessions yet. Words show up here after your first one.</div>;
  }
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <input
          type="text" lang="ko" value={query}
          onChange={e => { setQuery(e.target.value); setPage(0); }}
          placeholder="Search words or meanings…"
          aria-label="Search the word record"
          style={{
            flex: '1 1 200px', minWidth: 0, padding: '7px 10px', borderRadius: '8px', outline: 'none',
            fontSize: isMobile ? '16px' : '13px', border: `1px solid ${C.border}`, background: C.bg, color: C.text,
          }}
        />
        {ticked.length > 0 && (
          <button onClick={() => setTicked([])} style={{ ...S.btnGhost, padding: '6px 12px', fontSize: '12px' }}>Clear</button>
        )}
        <button
          onClick={() => usable.length >= 2 && onPractice(usable)}
          disabled={usable.length < 2}
          title={usable.length < 2 ? 'Tick at least two words' : undefined}
          style={{ ...S.btnPrimary, padding: '6px 14px', fontSize: '12px', opacity: usable.length < 2 ? 0.5 : 1 }}
        >
          Practice these{usable.length ? ` (${usable.length})` : ''}
        </button>
      </div>
      <div style={{ fontSize: '11px', color: C.textM, marginBottom: '8px' }}>
        {record.length} word{record.length === 1 ? '' : 's'} across {sessions.length} Echo session{sessions.length === 1 ? '' : 's'}, hardest first.
      </div>

      <div style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '12px', overflow: 'hidden' }}>
        {!isMobile && (
          <div style={{ display: 'grid', gridTemplateColumns: cols, gap: '8px', padding: '8px 12px', borderBottom: `1px solid ${C.border}` }}>
            <div />
            <div style={{ ...head, textAlign: 'left' }}>Word</div>
            <div style={head}>Sessions</div>
            <div style={head} title="First try, English → Korean">EN→KO</div>
            <div style={head} title="First try, Korean → English">KO→EN</div>
            <div style={head} title="First try by ear (Dictation)">By ear</div>
            <div style={head}>Missed</div>
            <div style={head}>Trend</div>
            <div style={head}>Last seen</div>
          </div>
        )}
        {shown.length === 0 && <div style={{ padding: '12px', fontSize: '12px', color: C.textM }}>No words match.</div>}
        {shown.map((r, k) => {
          const e = byId.get(r.lemmaID);
          const alts = Array.isArray(e?.echoAlternates) ? e.echoAlternates : [];
          const ft = (x) => (x.total ? `${x.correct}/${x.total}` : '–');
          const cell = { textAlign: 'center', fontFamily: SH.fm, fontSize: '12.5px', color: C.textS };
          return (
            <div key={r.lemmaID} style={{ display: 'grid', gridTemplateColumns: cols, gap: '8px', alignItems: 'start', padding: '9px 12px', borderTop: k ? `1px solid ${C.border}` : 'none' }}>
              <input
                type="checkbox" checked={ticked.includes(r.lemmaID)} disabled={!e}
                onChange={() => toggle(r.lemmaID)}
                aria-label={`Tick ${e?.lemma || r.lemma}`}
                title={e ? undefined : 'No longer in Lemma Master'}
                style={{ marginTop: '3px', accentColor: C.accent, cursor: e ? 'pointer' : 'default' }}
              />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: SH.fk, fontSize: '15px', color: C.text, wordBreak: 'keep-all', overflowWrap: 'break-word' }}>{e?.lemma || r.lemma}</div>
                {e && <div style={{ fontSize: '11.5px', color: C.textM, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{echoGloss(e)}</div>}
                {isMobile && (
                  <div style={{ fontSize: '11px', color: C.textM, marginTop: '2px' }}>
                    {r.sessions} session{r.sessions === 1 ? '' : 's'} · EN→KO {ft(r.en2ko)} · KO→EN {ft(r.ko2en)}{r.ear?.total ? ` · by ear ${ft(r.ear)}` : ''} · {r.misses} missed · {lastSeen(r.lastSeen)}
                  </div>
                )}
                {r.unresolved && <div style={{ fontSize: '10.5px', color: C.warning, marginTop: '1px' }}>{r.lastKind === 'dictation' ? 'not yet right by ear' : 'not yet right both ways'}</div>}
                {alts.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center', marginTop: '4px' }}>
                    <span style={{ fontSize: '10.5px', color: C.textM }}>Alternates:</span>
                    {alts.map(a => (
                      <span key={a} style={{ display: 'inline-flex', alignItems: 'center', gap: '2px', fontSize: '11px', padding: '1px 3px 1px 7px', borderRadius: '10px', border: `1px solid ${C.border}`, color: C.textS }}>
                        {a}
                        <button
                          onClick={() => onRemoveAlternate && onRemoveAlternate(r.lemmaID, a)}
                          aria-label={`Remove alternate ${a}`}
                          title="Remove this alternate"
                          style={{ background: 'none', border: 'none', color: C.textM, cursor: 'pointer', fontSize: '12px', padding: '0 3px', lineHeight: 1 }}
                        >×</button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {isMobile ? (
                <div style={{ paddingTop: '2px' }}>{trendMarks(r.trend)}</div>
              ) : (
                <>
                  <div style={cell}>{r.sessions}</div>
                  <div style={cell}>{ft(r.en2ko)}</div>
                  <div style={cell}>{ft(r.ko2en)}</div>
                  <div style={cell}>{ft(r.ear || { correct: 0, total: 0 })}</div>
                  <div style={{ ...cell, color: r.misses ? C.danger : C.textM }}>{r.misses}</div>
                  <div style={{ textAlign: 'center' }}>{trendMarks(r.trend)}</div>
                  <div style={{ ...cell, fontFamily: 'inherit', fontSize: '11.5px', color: C.textM }}>{lastSeen(r.lastSeen)}</div>
                </>
              )}
            </div>
          );
        })}
      </div>
      {totalPages > 1 && (
        <PaginationFooter
          page={pg}
          totalPages={totalPages}
          count={rows.length}
          singular="word"
          onFirst={() => setPage(0)}
          onPrev={() => setPage(p => Math.max(0, p - 1))}
          onNext={() => setPage(p => Math.min(totalPages - 1, p + 1))}
          onLast={() => setPage(totalPages - 1)}
          C={C}
        />
      )}
    </div>
  );
}

function ReportCard({ results, report, echoCount = 0, echoSessions = [], lemmaMaster = [], onRemoveAlternate, onPracticeEcho, links, C, S, dsh = 3 }) {
  const [range,          setRange]          = useState('30');
  const [selectedResult, setSelectedResult] = useState(null); // { result, detail }
  const [rawPage,        setRawPage]        = useState(0);
  const [echoPage,       setEchoPage]       = useState(0);    // Echo Log page (X2)
  const [openEcho,       setOpenEcho]       = useState(null); // saved Echo session shown in the modal

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

  // Echo Log (X2): same range as the Session Log, newest first.
  const echoFiltered = useMemo(() => {
    const at = (e) => new Date(e.finishedAt || e.startedAt);
    let list = (echoSessions || []).filter(e => !isNaN(at(e)));
    if (range !== 'all') {
      const cutoff = getLogicalToday(dsh);
      cutoff.setDate(cutoff.getDate() - parseInt(range));
      list = list.filter(e => at(e) >= cutoff);
    }
    return list.sort((a, b) => String(b.finishedAt || b.startedAt).localeCompare(String(a.finishedAt || a.startedAt)));
  }, [echoSessions, range, dsh]);
  const echoTotalPages = Math.max(1, Math.ceil(echoFiltered.length / RC_PAGE_SIZE));
  const echoPg         = Math.min(echoPage, echoTotalPages - 1);
  const echoPaged      = echoFiltered.slice(echoPg * RC_PAGE_SIZE, (echoPg + 1) * RC_PAGE_SIZE);
  const lemmaById      = useMemo(() => new Map((lemmaMaster || []).filter(e => e?.lemmaID).map(e => [e.lemmaID, e])), [lemmaMaster]);

  // By The Numbers sits beside The State of Quizzes, so it uses the same
  // fixed window (the last 30 days); Sessions counts Echo too.
  const numbers30 = useMemo(() => {
    const cutoff = getLogicalToday(dsh);
    cutoff.setDate(cutoff.getDate() - 29);
    const scored = results.filter(r => new Date(r.date) >= cutoff)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const echo = (echoSessions || []).filter(e => new Date(e.finishedAt || e.startedAt) >= cutoff).length;
    return {
      sessions: scored.length + echo,
      best:     scored.length ? Math.max(...scored.map(r => r.score)) : null,
      recent:   scored.length ? scored[0].score : null,
      perfect:  scored.filter(r => r.score === 100).length,
    };
  }, [results, echoSessions, dsh]);
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
  // Grammar averages are kept per kind (G4): Translation and Selection score differently
  const gramTR = filtered.filter(r => r.type === 'grammar' && grammarResultMode(r) === 'translation');
  const gramSR = filtered.filter(r => r.type === 'grammar' && grammarResultMode(r) === 'selection');
  const clozeR = filtered.filter(r => r.type === 'cloze');
  const avgV   = vocaR.length  ? Math.round(vocaR.reduce((s, r) => s + r.score, 0) / vocaR.length)   : null;
  const avgGT  = gramTR.length ? Math.round(gramTR.reduce((s, r) => s + r.score, 0) / gramTR.length) : null;
  const avgGS  = gramSR.length ? Math.round(gramSR.reduce((s, r) => s + r.score, 0) / gramSR.length) : null;
  const avgC   = clozeR.length ? Math.round(clozeR.reduce((s, r) => s + r.score, 0) / clozeR.length) : null;
  const rangeAvg   = filtered.length ? Math.round(filtered.reduce((s, r) => s + r.score, 0) / filtered.length) : null;
  const rangeLabel = range === 'all' ? 'All Time' : `${range}-Day`;

  // Masthead vitals — drawn from full unfiltered history, independent of the range toggle below
  const todayStr     = toDateStr(getLogicalToday(dsh));
  const mastheadDate = new Date(todayStr + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const last7        = results.filter(r => { const c = getLogicalToday(dsh); c.setDate(c.getDate() - 7); return new Date(r.date) >= c; });
  const last7Avg     = last7.length ? Math.round(last7.reduce((s, r) => s + r.score, 0) / last7.length) : null;

  // Lead story: the State of Quizzes report (E5), computed by the parent so
  // the home teaser and this page tell the same story.
  const lead = report;

  return (
    <div className="fade-up" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <GazetteMasthead
        cornerLeft={{ value: `${results.length + echoCount} Session${results.length + echoCount === 1 ? '' : 's'}`, label: last7Avg != null ? `${last7Avg}% This Week` : 'No Scores This Week' }}
        cornerRight={{ value: mastheadDate, label: todayStr.slice(0, 4) }}
        title="The Examiner"
        subtitle="A Record of Scores, Sessions, and Standing"
        isMobile={isMobile}
      />
      <GoldRule />
      <BylineRule left="autovocaindex / quizzes" right={todayStr} />

      {/* Lead story, with By The Numbers beside it (X2) */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 1fr) 240px', gap: isMobile ? '20px' : '28px', alignItems: 'start' }}>
        <div style={{ minWidth: 0 }}>
          <GazetteKicker>{lead.kicker}</GazetteKicker>
          <GazetteHeadline>{lead.headline}</GazetteHeadline>
          {lead.standfirst && <GazetteStandfirst>{lead.standfirst}</GazetteStandfirst>}
          <DropCapLead text={lead.leadParagraph} columns={isMobile ? 1 : 2} />
        </div>
        <GazetteBox title="By The Numbers · 30 Days">
          <BoxRow label="Sessions" value={numbers30.sessions} />
          <BoxRow label="Best Score" value={numbers30.best !== null ? `${numbers30.best}%` : '—'} />
          <BoxRow label="Most Recent" value={numbers30.recent !== null ? `${numbers30.recent}%` : '—'} />
          <BoxRow label="Perfect Scores" value={numbers30.perfect} />
        </GazetteBox>
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
          <GazetteFig caption={`${rangeLabel === 'All Time' ? 'All-time' : `Last ${range} days`} — Vocabulary, Cloze, and Grammar (Translation and Selection) scores`}>
            <MiniLineChart data={chartData} width={560} height={160} C={C} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px', marginTop: '8px', justifyContent: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: C.textM }}>
                <div style={{ width: '20px', height: '2px', background: C.accent }} /> Vocabulary
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: C.textM }}>
                <div style={{ width: '20px', height: '0', borderTop: `2px dashed ${C.accent2 || C.success}` }} /> Grammar · Translation
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: C.textM }}>
                <svg width="20" height="8" aria-hidden="true">
                  <line x1="1" y1="4" x2="19" y2="4" stroke={C.accent2 || C.success} strokeWidth="2" strokeDasharray="1.5,3.5" strokeLinecap="round" />
                  <circle cx="10" cy="4" r="3" fill={C.bg} stroke={C.accent2 || C.success} strokeWidth="1.5" />
                </svg> Grammar · Selection
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: C.textM }}>
                <span style={{ color: C.danger || '#c97d3a', fontWeight: 700, letterSpacing: '1px' }}>— —</span> Cloze
              </div>
            </div>
          </GazetteFig>
        ) : (
          <div style={{ fontSize: '12px', color: C.textM, fontStyle: 'italic', padding: '14px 0' }}>Not enough history in this range yet.</div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px', marginTop: '16px' }}>
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
          {avgGT !== null && (
            <div style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '12px', padding: '16px', textAlign: 'center' }}>
              <div style={{ fontFamily: SH.fm, fontSize: '22px', color: C.accent2 || C.success }}>{avgGT}%</div>
              <div style={{ fontSize: '11px', color: C.textM, marginTop: '4px' }}>Avg grammar translation score</div>
            </div>
          )}
          {avgGS !== null && (
            <div style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '12px', padding: '16px', textAlign: 'center' }}>
              <div style={{ fontFamily: SH.fm, fontSize: '22px', color: C.accent2 || C.success }}>{avgGS}%</div>
              <div style={{ fontSize: '11px', color: C.textM, marginTop: '4px' }}>Avg grammar selection score</div>
            </div>
          )}
        </div>
      </div>

      {/* Word Record (X2): every word Echo has seen */}
      <div>
        <GazetteKicker>Word Record</GazetteKicker>
        <EchoWordRecord sessions={echoSessions} lemmaMaster={lemmaMaster} onRemoveAlternate={onRemoveAlternate} onPractice={onPracticeEcho} C={C} S={S} />
      </div>

      {/* Session Log (Vocabulary, Cloze, Grammar) | Echo Log (X2) */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: isMobile ? '24px' : '28px', alignItems: 'start' }}>
        <div>
          <GazetteKicker>Session Log</GazetteKicker>
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

        <div>
          <GazetteKicker>Echo Log</GazetteKicker>
          {echoPaged.length > 0 ? (
            <>
              <div style={{ background: C.raised, border: `1px solid ${C.border}`, borderRadius: '12px', overflow: 'hidden' }}>
                {echoPaged.map((s, i, arr) => (
                  <EchoLogRow key={s.id || s.startedAt || i} s={s} last={i === arr.length - 1} onClick={() => setOpenEcho(s)} C={C} />
                ))}
              </div>
              <PaginationFooter
                page={echoPg}
                totalPages={echoTotalPages}
                count={echoFiltered.length}
                singular="session"
                onFirst={() => setEchoPage(0)}
                onPrev={() => setEchoPage(p => Math.max(0, p - 1))}
                onNext={() => setEchoPage(p => Math.min(echoTotalPages - 1, p + 1))}
                onLast={() => setEchoPage(echoTotalPages - 1)}
                C={C}
              />
            </>
          ) : (
            <div style={{ fontSize: '12px', color: C.textM, fontStyle: 'italic', padding: '14px 0' }}>No Echo sessions in this range.</div>
          )}
        </div>
      </div>

      {openEcho && <EchoHistoryModal session={openEcho} byId={lemmaById} onClose={() => setOpenEcho(null)} C={C} S={S} />}

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
                  {selectedResult.result.type === 'voca' ? 'Voca' : selectedResult.result.type === 'cloze' ? 'Cloze'
                    : grammarResultMode(selectedResult.result) === 'selection' ? 'Grammar · Selection' : 'Grammar · Translation'}
                </span>
                <span style={{ fontSize: '12px', color: C.textM }}>{selectedResult.result.date?.split('T')[0]}</span>
              </div>
              <span style={{ fontFamily: SH.fm, fontSize: '24px', color: selectedResult.result.score >= 90 ? C.warning : selectedResult.result.score >= 70 ? C.accent : C.danger }}>
                {selectedResult.result.score}%
              </span>
            </div>

            {/* Grammar result detail */}
            {/* Concept links (G5) — the same links as the results screen */}
            {selectedResult.detail?.type === 'grammar' && Array.isArray(selectedResult.detail.questions) && (
              <div style={{ marginBottom: '16px' }}>
                <GrammarDetailConcepts detail={selectedResult.detail} links={links} C={C} S={S} />
              </div>
            )}

            {/* Selection quiz detail (G4) */}
            {selectedResult.detail?.type === 'grammar' && selectedResult.detail.mode === 'selection' && Array.isArray(selectedResult.detail.questions) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <GrammarSelectionReview
                  questions={selectedResult.detail.questions}
                  selections={readSavedSelections(selectedResult.detail.selections)}
                  explanations={selectedResult.detail.explanations || {}}
                  C={C}
                />
              </div>
            )}

            {selectedResult.detail?.type === 'grammar' && selectedResult.detail.mode !== 'selection' && selectedResult.detail.questions && (
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
                        {vs && (
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flexShrink: 0 }}>
                            <div style={{ fontFamily: SH.fm, fontSize: '22px', color: vs.color }}>{vs.symbol}</div>
                            {a.overriddenFrom && <div style={{ fontSize: '10px', color: C.textM }}>overridden (was {a.overriddenFrom})</div>}
                          </div>
                        )}
                      </div>
                      {q.correctConcept?.term && (
                        <GrammarConceptPick q={q} chosenId={selectedResult.detail.conceptChoices?.[i]} C={C} />
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
            // isComposing guard: see the voca Type input
            onKeyDown={e => e.key === 'Enter' && !e.nativeEvent.isComposing && handleSubmit()}
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
  useGlobalKey(e => { if (e.key === 'Enter') onDone(); });
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
// One-line summary of an unfinished grammar session for the resume banner (G2).
// Banner text for an unfinished Echo session (E4).
function describeEchoResume(saved, now = Date.now()) {
  const st = saved.state;
  const mins = Math.max(0, Math.round((now - Date.parse(saved.savedAt)) / 60000));
  const ago = mins < 1 ? 'just now'
    : mins < 60 ? `${mins} min ago`
    : mins < 1440 ? `${Math.round(mins / 60)} h ago`
    : `${Math.round(mins / 1440)} d ago`;
  const round = st.config.mode === 'complete' ? `Round ${st.round}` : `Round ${st.round} of ${st.config.rounds}`;
  const dir = st.config?.kind === 'dictation' ? 'Dictation' : st.dir === DIRS.EN2KO ? 'English → Korean' : 'Korean → English';
  return `${round} · ${dir} · ${st.items.length} words · saved ${ago}`;
}

function describeGrammarResume(snap, now = Date.now()) {
  const { answered, total } = snapshotProgress(snap);
  const kind = snap.kind === 'selection' ? 'Selection'
    : snap.config?.transMode === 'drill' ? 'Translation · Drill' : 'Translation · Broad';
  const mins = Math.max(0, Math.round((now - Date.parse(snap.savedAt)) / 60000));
  const ago = mins < 1 ? 'just now'
    : mins < 60 ? `${mins} min ago`
    : mins < 1440 ? `${Math.round(mins / 60)} h ago`
    : `${Math.round(mins / 1440)} d ago`;
  const progress = snap.phase === 'assessing' ? `all ${total} answers submitted` : `${answered} of ${total} answered`;
  return `${kind} · ${progress} · saved ${ago}`;
}

const QR_PREFIX = 'avi_quiz_results_';
const ES_PREFIX = 'avi_echo_sessions_';   // echo_sessions cache, read by the State of Quizzes report (E5)
function qrRead(key)      { try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : null; } catch { return null; } }
function qrWrite(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }

// grammarEntries / onNavigateToGrammar / onPracticeGrammarCards (G5) come from
// App: live mastery levels, open a Grammar Index entry, and start a Grammar
// Deck study session with the given card ids.
// echoDeckTarget / onEchoDeckTargetUsed (X3): a deck card's Echo button sends
// its deck id here; the Echo setup opens with that deck chosen.
export function QuizzesPage({ soundProfile, quizSoundsEnabled = true, cards: propCards, decks: propDecks, settings, grammarEntries, onNavigateToGrammar, onPracticeGrammarCards, wordInputs = [], aviSources = [], aviSections = [], echoDeckTarget = null, onEchoDeckTargetUsed = null }) {
  const { C, S } = useAppTheme();
  const uid = auth.currentUser?.uid;
  // Keep module-level ref current so every sub-component in this file reads
  // the correct enabled state without receiving it as a prop.
  _quizSoundsRef.current = quizSoundsEnabled;
  const dsh = settings?.dayStartHour ?? 3;

  const [view,      setView]      = useState('home');
  const [configModal, setConfigModal] = useState(null); // null | 'voca' | 'cloze' | 'grammar' | 'echo'
  const [echoState,   setEchoState]   = useState(null); // Echo session (echoEngine state, E2)
  const [echoSeed,    setEchoSeed]    = useState(0);    // Echo setup shuffle seed, picked per opening
  const [echoDraft,   setEchoDraft]   = useState(null); // saved in-round draft handed to a resumed round (E4)
  const [echoResume,  setEchoResume]  = useState(null); // unfinished Echo session offered on home (E4)
  const [echoSave,    setEchoSave]    = useState(null); // { status: 'saving' | 'saved' | 'error' | 'skipped', summary }
  const [echoPreset,  setEchoPreset]  = useState(null); // Echo setup opened preloaded (X2 Practice these, X3 deck shortcut)
  const [results,   setResults]   = useState(() => qrRead(uid ? QR_PREFIX + uid : null) || []);
  const [resultsLoading, setResultsLoading] = useState(true);
  const [echoSessions, setEchoSessions] = useState(() => qrRead(uid ? ES_PREFIX + uid : null) || []);

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
  const [gramError,        setGramError]        = useState(null); // { kind: 'generate' | 'assess', code } (G2)
  const [gramResume,       setGramResume]       = useState(null); // unfinished session offered on home (G2)
  const [gramInitial,      setGramInitial]      = useState(null); // resume state handed to a session (G2)
  const [gramSelectionResultId, setGramSelectionResultId] = useState(null); // detail record for saving explanations (G4)
  const [gramTranslationResultId, setGramTranslationResultId] = useState(null); // result + detail record that verdict overrides update
  // Latest assessment, updated synchronously by overrides so two quick taps
  // never build on a stale copy before React re-renders.
  const gramAssessmentRef = useRef(null);
  useEffect(() => { gramAssessmentRef.current = gramAssessment; }, [gramAssessment]);

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

  // Concept links on grammar results (G5): live mastery from the Grammar Index
  // when App passes it, otherwise the level recorded in the quiz corpus.
  const gramLinks = useMemo(() => {
    const live = new Map((grammarEntries || []).map(e => [e.id, e.masteryLevel]));
    const recorded = new Map(gramCorpus.map(e => [e.id, e.level]));
    return {
      cards,
      masteryOf:       (id) => live.get(id) || recorded.get(id) || 'introduced',
      onOpenEntry:     onNavigateToGrammar    || null,
      onPracticeCards: onPracticeGrammarCards || null,
    };
  }, [grammarEntries, gramCorpus, cards, onNavigateToGrammar, onPracticeGrammarCards]);

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

  // Load echo_sessions for the State of Quizzes report (E5): cache first,
  // refresh in the background. Not needed to show the page, so no spinner.
  useEffect(() => {
    if (!uid) return;
    const esKey = ES_PREFIX + uid;
    (async () => {
      try {
        const snap = await getDocs(collection(db, 'users', uid, 'echo_sessions'));
        const fresh = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        setEchoSessions(prev => (prev.length > fresh.length ? prev : fresh));
        qrWrite(esKey, fresh);
      } catch (e) {
        console.error('QuizzesPage: echo sessions load error', e);
      }
    })();
  }, [uid]);

  // The State of Quizzes (E5): last 30 days against the 30 before, for the
  // Examiner's lead story and the home teaser.
  const reportToday = toDateStr(getLogicalToday(dsh));
  const quizReport = useMemo(() => getQuizStateReport({
    results, echoSessions, grammarEntries: grammarEntries || [], corpus: gramCorpus, today: reportToday, dsh,
  }), [results, echoSessions, grammarEntries, gramCorpus, reportToday, dsh]);

  // Deck-card shortcut (X3, X-D8): the Echo setup with that deck chosen, for
  // this opening only (saved source and decks stay as they were).
  useEffect(() => {
    if (!echoDeckTarget) return;
    setEchoPreset({ source: 'deck', deckIds: [echoDeckTarget] });
    setEchoSeed(Math.floor(Math.random() * 2 ** 31));
    setView('home');
    setConfigModal('echo');
    onEchoDeckTargetUsed?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [echoDeckTarget]);

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

  // Updates a saved quiz result in Firestore (used by override on results screen).
  // metaPatch: optional meta fields to replace too (e.g. missedConcepts).
  const updateResult = useCallback(async (resultId, newCorrect, total, metaPatch = null) => {
      if (!uid || !resultId) return;
      const rawScore = total > 0 ? newCorrect / total * 100 : 0;
      const newScore = Math.round(rawScore * 10) / 10;
      const fsPatch = { correct: newCorrect, score: newScore };
      if (metaPatch) for (const [k, v] of Object.entries(metaPatch)) fsPatch[`meta.${k}`] = v;
      try {
        await updateDoc(fsDoc(db, 'users', uid, 'quiz_results', resultId), fsPatch);
        setResults(prev => {
          const next = prev.map(r => r.id === resultId
            ? { ...r, correct: newCorrect, score: newScore, ...(metaPatch ? { meta: { ...(r.meta || {}), ...metaPatch } } : {}) }
            : r);
          qrWrite(QR_PREFIX + uid, next);
          return next;
        });
      } catch (e) {
        console.error('QuizzesPage: updateResult failed', e);
      }
    }, [uid]);

  // ── Grammar quiz: device-only resume snapshot (G2, G-D7) ──
  // One unfinished session per user, saved on this device only. Written on
  // every answer, kept through a failed assessment, cleared when results are
  // saved, when the quiz is ended, or when a new quiz starts.
  const gramSnapKey = uid ? `avi_grammar_session_v1_${uid}` : null;

  const saveGramSnapshot = useCallback((s) => {
    if (gramSnapKey) qrWrite(gramSnapKey, buildSessionSnapshot(s));
  }, [gramSnapKey]);

  const clearGramSnapshot = useCallback(() => {
    if (gramSnapKey) { try { localStorage.removeItem(gramSnapKey); } catch {} }
    setGramResume(null);
  }, [gramSnapKey]);

  // Offer an unfinished session whenever the home screen shows.
  useEffect(() => {
    if (view !== 'home' || !gramSnapKey) return;
    setGramResume(parseSessionSnapshot(qrRead(gramSnapKey)));
  }, [view, gramSnapKey]);

  const handleTranslationProgress = useCallback(({ idx, translations, conceptChoices }) => {
    saveGramSnapshot({ kind: 'translation', phase: 'answering', config: gramConfig, questions: gramQuestions, idx, translations, conceptChoices });
  }, [saveGramSnapshot, gramConfig, gramQuestions]);

  const handleSelectionProgress = useCallback(({ idx, selections }) => {
    saveGramSnapshot({ kind: 'selection', phase: 'answering', config: gramConfig, questions: gramQuestions, idx, selections });
  }, [saveGramSnapshot, gramConfig, gramQuestions]);

  const handleGrammarEnd = useCallback(() => {
    clearGramSnapshot();
    setGramInitial(null);
    setView('home');
  }, [clearGramSnapshot]);

  // ── Grammar quiz: call API to generate questions ──────────
  // Request building and response validation live in grammarQuizEngine.js:
  // short concept refs, a compact corpus, and every question checked against
  // the corpus (G1). Quizzes over 10 questions go out as parallel batches that
  // are validated one by one, then merged and de-duplicated (G2).
  const handleGrammarStart = useCallback(async (config) => {
    setGramConfig(config);
    setGramAssessment(null);
    setGramTranslations(null);
    setGramConceptChoices(null);
    setGramSelections(null);
    setGramError(null);
    setGramInitial(null);
    clearGramSnapshot(); // a new quiz replaces any unfinished one

    const request = buildGenerationRequest(config, gramCorpus);
    if (request.error) {
      console.error('Grammar quiz request not built:', request.error);
      setGramError({ kind: 'generate', code: 'invalid_request' });
      return;
    }

    setView('grammar_loading');
    try {
      const settled = await callGrammarQuizChunks(planGenerationChunks(request));
      const ok = settled.filter(s => s.status === 'fulfilled');
      if (!ok.length) throw settled[0].reason;
      if (ok.length < settled.length) {
        console.warn(`Grammar quiz: ${settled.length - ok.length} of ${settled.length} batches failed`, settled.find(s => s.status === 'rejected')?.reason);
      }
      const merged = mergeGeneratedChunks(ok.map(s => validateGeneratedQuestions(request, s.value, { config })));
      if (merged.dropped || merged.duplicates) {
        console.warn(`Grammar quiz: dropped ${merged.dropped} malformed and ${merged.duplicates} duplicate question(s)`);
      }
      if (!merged.questions.length) throw Object.assign(new Error('No usable questions returned'), { code: 'no_questions' });
      setGramQuestions(merged.questions);
      setView(request.mode === 'selection' ? 'grammar_selection' : 'grammar_translation');
    } catch (e) {
      console.error('Grammar quiz generation failed:', e?.code || '', e);
      setGramError({ kind: 'generate', code: e?.code || 'server' });
      setView('home');
    }
  }, [gramCorpus, clearGramSnapshot]);

  // ── Translation: assess the answers ────────────────────────
  // Sent in batches of up to 10 items (G2). Any failed batch fails the whole
  // assessment so it can be retried as one. The snapshot stays in phase
  // 'assessing' until results are saved, so neither a failure nor closing the
  // app loses the translations.
  const runGrammarAssessment = useCallback(async (translations, conceptChoices) => {
    setGramError(null);
    setGramTranslationResultId(null);
    setView('grammar_assessing');

    const uid = auth.currentUser?.uid;

    try {
      const n = gramQuestions.length;
      const settled = await callGrammarQuizChunks(planAssessmentChunks(buildAssessmentRequest(gramQuestions, translations, conceptChoices)));
      const failed = settled.find(s => s.status === 'rejected');
      if (failed) throw failed.reason;
      // Matched by item number, never position: one entry per question, null
      // where the assessor skipped or garbled an item.
      const assessment = mergeAssessmentChunks(settled.map(s => s.value), n);
      if (assessment.every(a => a === null)) throw Object.assign(new Error('No usable assessments returned'), { code: 'bad_json' });
      setGramAssessment(assessment);

      // Create correction note once we have the full assessment
      if (uid) {
        const rows = gramQuestions.map((q, i) => ({
          topic:     q.correctConcept?.term || 'quiz',
          original:  translations[i] || '',
          corrected: assessment[i]?.corrected || '',
        }));
        const dateStr = toDateStr(getLogicalToday(dsh));
        await createCorrectionNote({
          uid,
          title:       `Grammar Quiz — ${dateStr}`,
          rows,
          sourceLabel: 'Grammar Quiz',
        });
      }

      // Save score to quiz_results, tagged with concept metadata for headlines.
      // G3: points, not O-count — Drill = translation credit (O 1, △ 0.5,
      // X 0); Broad = 0.5 for the pick + 0.5 × translation credit. A concept
      // counts as missed when any of its questions fell short of full credit.
      const score = scoreTranslationQuiz(gramQuestions, assessment, conceptChoices);
      const { id: resultId } = await saveResult('grammar', score.points, score.total, {
        mode: 'translation',
        transMode: gramConfig?.transMode || null,
        concepts: score.concepts,
        missedConcepts: score.missedConcepts,
        scoring: 'g3',
      });

      // Full per-question detail, kept separately so it's only fetched on demand
      if (resultId && uid) {
        try {
          await setDoc(fsDoc(db, 'users', uid, 'quiz_result_details', resultId), {
            type:        'grammar',
            questions:   gramQuestions,
            translations,
            conceptChoices: (conceptChoices || []).map(c => c || null),
            assessment,
          });
        } catch (e) {
          console.error('QuizzesPage: detail save failed', e);
        }
      }
      if (resultId) setGramTranslationResultId(resultId);

      clearGramSnapshot();
      setView('grammar_translation_results');
    } catch (e) {
      console.error('Grammar assessment failed:', e?.code || '', e);
      setGramAssessment(null);
      setGramError({ kind: 'assess', code: e?.code || 'server' });
      setView('grammar_translation_results');
    }
  }, [gramQuestions, gramConfig, saveResult, dsh, clearGramSnapshot]);

  // ── Translation: learner overrides a verdict ───────────────
  // verdict: '△' (Mark as partial) | 'O' (Mark as correct) | null (Undo).
  // Rescored and saved like the Vocabulary Quiz overrides: the result's score
  // and missedConcepts, plus the detail record so the Report Card agrees.
  const handleTranslationOverride = useCallback(async (i, verdict) => {
    const base = gramAssessmentRef.current;
    const next = overrideAssessment(base, i, verdict);
    if (!next || next === base) return;
    gramAssessmentRef.current = next;
    setGramAssessment(next);
    const uid = auth.currentUser?.uid;
    if (!uid || !gramTranslationResultId) return;
    const score = scoreTranslationQuiz(gramQuestions, next, gramConceptChoices);
    await updateResult(gramTranslationResultId, score.points, score.total, { missedConcepts: score.missedConcepts });
    try {
      await setDoc(fsDoc(db, 'users', uid, 'quiz_result_details', gramTranslationResultId), { assessment: next }, { merge: true });
    } catch (e) {
      console.error('QuizzesPage: override detail save failed', e);
    }
  }, [gramTranslationResultId, gramQuestions, gramConceptChoices, updateResult]);

  const handleGrammarTranslationFinish = useCallback(({ translations, conceptChoices }) => {
    setGramTranslations(translations);
    setGramConceptChoices(conceptChoices);
    setGramInitial(null);
    saveGramSnapshot({
      kind: 'translation', phase: 'assessing', config: gramConfig, questions: gramQuestions,
      idx: Math.max(0, gramQuestions.length - 1), translations, conceptChoices,
    });
    runGrammarAssessment(translations, conceptChoices);
  }, [saveGramSnapshot, gramConfig, gramQuestions, runGrammarAssessment]);

  // ── Selection: receive answers, score, save (G4) ──────────
  // Per-question scoring: a question counts only when the selection matches
  // the correct sentences exactly. Selected incorrect sentences go into a
  // correction note with their fixes, and the full quiz is kept as a detail
  // record so the Report Card can show it.
  const handleGrammarSelectionFinish = useCallback(async (selections) => {
    setGramSelections(selections);
    setGramInitial(null);
    setGramSelectionResultId(null);
    clearGramSnapshot();
    const uid = auth.currentUser?.uid;
    const score = scoreSelectionQuiz(gramQuestions, selections);
    const rows = buildSelectionCorrectionRows(gramQuestions, selections);
    if (uid && rows.length) {
      const dateStr = toDateStr(getLogicalToday(dsh));
      await createCorrectionNote({
        uid,
        title:       `Grammar Selection Quiz — ${dateStr}`,
        rows,
        sourceLabel: 'Grammar Quiz',
      });
    }
    const { id: resultId } = await saveResult('grammar', score.points, score.total, {
      mode: 'selection',
      concepts: score.concepts,
      missedConcepts: score.missedConcepts,
      scoring: 'g4',
    });
    if (resultId && uid) {
      try {
        await setDoc(fsDoc(db, 'users', uid, 'quiz_result_details', resultId), {
          type:         'grammar',
          mode:         'selection',
          questions:    gramQuestions,
          selections:   toSavedSelections(selections),
          explanations: {},
        });
        setGramSelectionResultId(resultId);
      } catch (e) {
        console.error('QuizzesPage: selection detail save failed', e);
      }
    }
    setView('grammar_selection_results');
  }, [saveResult, gramQuestions, clearGramSnapshot, dsh]);

  // Explanations fetched on the Selection results screen are saved into the
  // quiz's detail record, so the Report Card shows them too (G4).
  const handleSelectionExplanations = useCallback(async (explanations) => {
    const uid = auth.currentUser?.uid;
    if (!uid || !gramSelectionResultId) return;
    try {
      await setDoc(fsDoc(db, 'users', uid, 'quiz_result_details', gramSelectionResultId), { explanations }, { merge: true });
    } catch (e) {
      console.error('QuizzesPage: explanation save failed', e);
    }
  }, [gramSelectionResultId]);

  // ── Resume an unfinished session from this device (G2) ─────
  const handleGrammarResume = useCallback(() => {
    const snap = gramResume;
    if (!snap) return;
    setGramError(null);
    setGramConfig(snap.config);
    setGramQuestions(snap.questions);
    setGramAssessment(null);
    setGramSelections(null);
    if (snap.kind === 'selection') {
      setGramInitial({ idx: snap.idx, selections: snap.selections });
      setView('grammar_selection');
    } else if (snap.phase === 'assessing') {
      // Submitted but never assessed: open the results screen with Assess now.
      setGramTranslations(snap.translations);
      setGramConceptChoices(snap.conceptChoices);
      setGramInitial(null);
      setGramError({ kind: 'assess', code: 'interrupted' });
      setView('grammar_translation_results');
    } else {
      setGramInitial({ idx: snap.idx, translations: snap.translations, conceptChoices: snap.conceptChoices });
      setView('grammar_translation');
    }
  }, [gramResume]);

  // ── Echo: device-only resume (E4, E-D13) ──────────────────
  // The session state plus the current round's draft, saved on this device on
  // every committed round and (shortly after) every change inside a round.
  // Cleared when the session ends or is discarded, or a new one starts.
  const echoSnapKey = uid ? `avi_echo_session_${uid}` : null;
  const echoDraftTimer = useRef(null);
  const echoStateRef = useRef(null);
  useEffect(() => { echoStateRef.current = echoState; }, [echoState]);

  const writeEchoSnapshot = useCallback((state, draft) => {
    if (!echoSnapKey || !state || state.done) return;
    qrWrite(echoSnapKey, { savedAt: new Date().toISOString(), state, draft: draft || null });
  }, [echoSnapKey]);

  const clearEchoSnapshot = useCallback(() => {
    clearTimeout(echoDraftTimer.current);
    if (echoSnapKey) { try { localStorage.removeItem(echoSnapKey); } catch { /* storage unavailable */ } }
    setEchoResume(null);
  }, [echoSnapKey]);

  // Offer an unfinished session whenever the home screen shows.
  useEffect(() => {
    if (view !== 'home' || !echoSnapKey) return;
    const saved = qrRead(echoSnapKey);
    setEchoResume(isResumable(saved, Date.now()) ? saved : null);
  }, [view, echoSnapKey]);

  const handleEchoDraft = useCallback((draft) => {
    clearTimeout(echoDraftTimer.current);
    echoDraftTimer.current = setTimeout(() => {
      const cur = echoStateRef.current;
      if (cur && !cur.done && cur.startedAt === draft.startedAt && cur.round === draft.round) writeEchoSnapshot(cur, draft);
    }, 400);
  }, [writeEchoSnapshot]);
  useEffect(() => () => clearTimeout(echoDraftTimer.current), []);

  // ── Echo: save the summary once (E-D12, E-D14) ─────────────
  const echoSavedRef = useRef(new Set()); // startedAt of sessions already sent
  // Saved alternates (X1, E-D18): only that entry's echoAlternates field is
  // touched (arrayUnion / arrayRemove), nothing else on the entry is rewritten.
  const saveEchoAlternate = useCallback(async (lemmaID, text, remove = false) => {
    if (!uid || !lemmaID || !text) return false;
    try {
      await updateDoc(fsDoc(db, 'users', uid, 'lemmaMaster', lemmaID), {
        echoAlternates: remove ? arrayRemove(text) : arrayUnion(text),
      });
      setLemmaMaster(prev => prev.map(e => {
        if (e.lemmaID !== lemmaID) return e;
        const list = Array.isArray(e.echoAlternates) ? e.echoAlternates : [];
        return { ...e, echoAlternates: remove ? list.filter(a => a !== text) : (list.includes(text) ? list : [...list, text]) };
      }));
      return true;
    } catch (e) {
      console.error('QuizzesPage: saving an Echo alternate failed', e);
      return false;
    }
  }, [uid]);
  const echoAlternatesOf = useCallback((lemmaID) => {
    const e = lemmaMaster.find(x => x.lemmaID === lemmaID);
    return Array.isArray(e?.echoAlternates) ? e.echoAlternates : [];
  }, [lemmaMaster]);

  const sendEchoSummary = useCallback(async (summary) => {
    if (!uid) { setEchoSave({ status: 'error', summary }); return; }
    setEchoSave({ status: 'saving', summary });
    try {
      const saved = JSON.parse(JSON.stringify(summary));
      const ref = await addDoc(collection(db, 'users', uid, 'echo_sessions'), saved);
      setEchoSave({ status: 'saved', summary });
      setEchoSessions(prev => {
        const next = [...prev, { id: ref.id, ...saved }];
        qrWrite(ES_PREFIX + uid, next);
        return next;
      });
    } catch (e) {
      console.error('QuizzesPage: echo session save failed', e);
      setEchoSave({ status: 'error', summary });
    }
  }, [uid]);

  // Every round commit and End come through here.
  const handleEchoChange = useCallback((next) => {
    setEchoState(next);
    setEchoDraft(null);
    clearTimeout(echoDraftTimer.current);
    if (!next.done) { writeEchoSnapshot(next, null); return; }
    clearEchoSnapshot();
    if (echoSavedRef.current.has(next.startedAt)) return;
    echoSavedRef.current.add(next.startedAt);
    if (next.rounds.length === 0) { setEchoSave({ status: 'skipped' }); return; }
    const summary = buildSummary(next, new Date().toISOString());
    const firsts = [summary.firstTry.en2ko, summary.firstTry.ko2en, summary.firstTry.ear].filter(Boolean);
    const tries = firsts.reduce((n, x) => n + x.total, 0);
    quizCompleteSound(tries ? (firsts.reduce((n, x) => n + x.correct, 0) / tries) * 100 : 0);
    sendEchoSummary(summary);
  }, [writeEchoSnapshot, clearEchoSnapshot, sendEchoSummary]);

  // ── Echo: start a session from the setup (E2) ──────────────
  // Hints ("(not X)") look across the whole Lemma Master (E-D10).
  // Audio for a session's words (X4, X-D11/X-D15): the word's flashcard audio,
  // otherwise generated now (cached server-side) without making a card. Only
  // for Dictation and audio prompts. A newer session cancels an older fetch.
  const [echoAudio, setEchoAudio] = useState({});   // lemmaID → { status, url }
  const echoAudioRun = useRef(0);
  const prepareEchoAudio = useCallback((state) => {
    const run = ++echoAudioRun.current;
    const needs = state && (state.config?.kind === 'dictation' || state.config?.koPrompt === 'audio');
    if (!needs) { setEchoAudio({}); return; }
    const cardAudio = new Map();
    for (const c of enrichedCards) {
      if (!c?.audioUrl || c.type === 'grammar' || c.type === 'sentence') continue;
      if (c.linkedAVILemmaId && !cardAudio.has(`id:${c.linkedAVILemmaId}`)) cardAudio.set(`id:${c.linkedAVILemmaId}`, c.audioUrl);
      const k = normalizeLemma(c.lemma || c.front || '');
      if (k && !cardAudio.has(`k:${k}`)) cardAudio.set(`k:${k}`, c.audioUrl);
    }
    const init = {};
    const missing = [];
    for (const it of state.items) {
      const url = cardAudio.get(`id:${it.id}`) || cardAudio.get(`k:${normalizeLemma(it.ko)}`);
      if (url) init[it.id] = { status: 'ready', url };
      else { init[it.id] = { status: 'pending', url: null }; missing.push(it); }
    }
    setEchoAudio(init);
    (async () => {
      for (const it of missing) {
        const url = await wordAudioUrl(it.ko);
        if (echoAudioRun.current !== run) return;
        setEchoAudio(prev => ({ ...prev, [it.id]: url ? { status: 'ready', url } : { status: 'failed', url: null } }));
      }
    })();
  }, [enrichedCards]);
  const echoAudioOf = useCallback((id) => echoAudio[id] || null, [echoAudio]);

  const handleEchoStart = useCallback(({ items, pair, config }) => {
    const byId = new Map(lemmaMaster.filter(e => e?.lemmaID).map(e => [e.lemmaID, e]));
    const allItems = lemmaMaster.map(e => buildItem(e, byId)).filter(Boolean);
    const state = createSession({
      items, pair, hints: computeHints(items, allItems), config,
      startedAt: new Date().toISOString(),
    });
    if (!state) return;
    clearEchoSnapshot();
    writeEchoSnapshot(state, null);
    setEchoDraft(null);
    setEchoSave(null);
    setEchoState(state);
    prepareEchoAudio(state);
    setView('echo_session');
  }, [lemmaMaster, clearEchoSnapshot, writeEchoSnapshot, prepareEchoAudio]);

  // From the summary: the same words again, or only the missed ones (the
  // list builder re-checks the look-alike pair).
  const handleEchoRestart = useCallback((ids) => {
    if (!echoState) return;
    const keep = ids ? echoState.items.filter(i => ids.includes(i.id)) : echoState.items;
    const sel = selectItems(keep, keep.length);
    handleEchoStart({ items: sel.items, pair: sel.pair, config: echoState.config });
  }, [echoState, handleEchoStart]);

  // Word Record "Practice these" (X2): the Echo setup, preloaded with the
  // ticked words as your picks, so rounds and options can be set first.
  const handleEchoPractice = useCallback((ids) => {
    setEchoPreset({ source: 'manual', added: ids });
    setEchoSeed(Math.floor(Math.random() * 2 ** 31));
    setView('home');
    setConfigModal('echo');
  }, []);

  const handleEchoResume = useCallback(() => {
    const saved = echoResume;
    if (!saved) return;
    setEchoSave(null);
    setEchoDraft(saved.draft || null);
    setEchoState(saved.state);
    prepareEchoAudio(saved.state);
    setView('echo_session');
  }, [echoResume, prepareEchoAudio]);

  // ── handleVocaStart ────────────────────────────────────────
  const handleVocaStart = useCallback((config, vocaDecks) => {
    if (DEMO) config = { ...config, deckIds: [] }; // demo: all decks (7D)
    const pool = enrichedCards.filter(c => {
      if (c.type === 'grammar') return false;
      if (c.type === 'sentence') return false; // voca formats are word-card only; sentence recall lives in cloze
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
  const echoLast7 = echoSessions.filter(e => { const c = getLogicalToday(dsh); c.setDate(c.getDate() - 7); return new Date(e.finishedAt || e.startedAt) >= c; });
  // Demo cap (7C): Echo sessions count toward the quiz-session cap too.
  const quizCapHit = DEMO && demoCapReached([...results, ...echoSessions], 'quizSessions');

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
  if (view === 'grammar_assessing') {
    return <HardModeLoading C={C} label="Preparing feedback…" />;
  }
  if (view === 'grammar_translation') {
    return (
      <GrammarTranslationSession
        questions={gramQuestions}
        config={gramConfig}
        initial={gramInitial}
        onProgress={handleTranslationProgress}
        onEnd={handleGrammarEnd}
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
        conceptChoices={gramConceptChoices}
        assessment={gramAssessment}
        assessErrorCode={gramError?.kind === 'assess' ? gramError.code : null}
        onRetryAssess={() => runGrammarAssessment(gramTranslations || [], gramConceptChoices || [])}
        onOverride={handleTranslationOverride}
        links={gramLinks}
        onDone={() => setView('home')}
        C={C} S={S}
      />
    );
  }
  if (view === 'grammar_selection') {
    return (
      <GrammarSelectionSession
        questions={gramQuestions}
        initial={gramInitial}
        onProgress={handleSelectionProgress}
        onEnd={handleGrammarEnd}
        onFinish={handleGrammarSelectionFinish}
        C={C} S={S}
      />
    );
  }
  if (view === 'echo_session' && echoState) {
    return (
      <EchoSession
        state={echoState}
        draft={echoDraft}
        onDraft={handleEchoDraft}
        onChange={handleEchoChange}
        save={echoSave}
        onRetrySave={() => { if (echoSave?.summary && echoSave.status === 'error') sendEchoSummary(echoSave.summary); }}
        onPracticeMissed={(ids) => handleEchoRestart(ids)}
        onAgain={() => handleEchoRestart(null)}
        onExit={() => { setEchoState(null); setEchoSave(null); setView('home'); }}
        alternatesOf={echoAlternatesOf}
        onSaveAlternate={saveEchoAlternate}
        audioOf={echoAudioOf}
        ttsSpeed={settings?.ttsSpeed ?? 0.9}
        C={C} S={S}
      />
    );
  }
  if (view === 'grammar_selection_results') {
    return (
      <GrammarSelectionResults
        questions={gramQuestions}
        userSelections={gramSelections || []}
        onExplanations={handleSelectionExplanations}
        links={gramLinks}
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
                <ReportCard
                  results={results} report={quizReport} echoCount={echoSessions.length}
                  echoSessions={echoSessions} lemmaMaster={lemmaMaster}
                  onRemoveAlternate={(lemmaID, text) => saveEchoAlternate(lemmaID, text, true)}
                  onPracticeEcho={handleEchoPractice}
                  links={gramLinks} C={C} S={S} dsh={dsh}
                />
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
      {/* Grammar quiz notices (G2): a failed generation, and an unfinished
          session saved on this device */}
      {gramError?.kind === 'generate' && (
        <GrammarNotice
          tone="error"
          title="Couldn't create the grammar quiz"
          text={describeGrammarQuizError(gramError.code)}
          actions={[
            ...(gramConfig ? [{ label: 'Try again', primary: true, onClick: () => handleGrammarStart(gramConfig) }] : []),
            { label: 'Dismiss', onClick: () => setGramError(null) },
          ]}
          C={C} S={S}
        />
      )}
      {gramResume && (
        <GrammarNotice
          tone="info"
          title={gramResume.phase === 'assessing' ? 'Grammar quiz waiting for feedback' : 'Unfinished grammar quiz'}
          text={describeGrammarResume(gramResume)}
          actions={[
            { label: gramResume.phase === 'assessing' ? 'Open' : 'Resume', primary: true, onClick: handleGrammarResume },
            { label: 'Discard', onClick: clearGramSnapshot },
          ]}
          C={C} S={S}
        />
      )}
      {echoResume && (
        <GrammarNotice
          tone="info"
          title="Unfinished Echo Quiz"
          text={describeEchoResume(echoResume)}
          actions={[
            { label: 'Resume', primary: true, onClick: handleEchoResume },
            { label: 'Discard', onClick: clearEchoSnapshot },
          ]}
          C={C} S={S}
        />
      )}
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
          {quizCapHit && (
            <div style={{ fontSize: '12px', color: C.warning, fontWeight: 500, lineHeight: 1.5 }}>
              {DEMO_LIMIT_NOTE}
            </div>
          )}
          <GazetteSplitFig
            label="Vocabulary Quiz"
            description="Multiple choice, true/false, typed answers, and matching — choose your formats, decks, and question counts."
            bestFor="Best for quick sessions."
            flip={false}
            onClick={() => { if (quizCapHit) return; quizSound('mouse_click'); setConfigModal('voca'); }}
          />
          <GazetteSplitFig
            label="Echo Quiz"
            description="The fold-over drill: write the Korean for each meaning, then the meaning for each word. Your corrected answers become the next round's prompts."
            bestFor="Best for locking in a word list."
            flip={true}
            onClick={() => { if (quizCapHit) return; quizSound('mouse_click'); setEchoPreset(null); setEchoSeed(Math.floor(Math.random() * 2 ** 31)); setConfigModal('echo'); }}
          />
          <GazetteSplitFig
            label="Cloze Quiz"
            description="Fill-in-the-blank questions built from your sentence-mining decks, answered by typing or selecting from choices."
            bestFor="Best for in-context vocabulary recall."
            flip={false}
            onClick={() => { if (quizCapHit) return; quizSound('mouse_click'); setConfigModal('cloze'); }}
          />
          <div style={DEMO ? { opacity: 0.45, pointerEvents: 'none' } : undefined}>
            <GazetteSplitFig
              label="Grammar Quiz"
              description="Translation drills, broader practice, or side-by-side concept comparisons, assessed by AI with correction notes."
              bestFor="Best for direct comparison and explanation."
              flip={true}
              onClick={() => { quizSound('mouse_click'); setConfigModal('grammar'); }}
            />
          </div>
          {DEMO && (
            <div style={{ fontSize: '11px', color: C.textM, marginTop: '-4px' }}>
              Grammar quizzes are not available in the demo.
            </div>
          )}

          {(results.length > 0 || echoSessions.length > 0) && (
            <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
              {[
                { label: 'This week', value: last7.length + echoLast7.length },
                avgLast7 !== null ? { label: 'Avg score', note: 'excluding Echo', value: `${avgLast7}%` } : null,
                { label: 'All time',  value: results.length + echoSessions.length },
              ].filter(Boolean).map(({ label, note, value }) => (
                <div key={label} style={{
                  flex: 1, background: C.raised, border: `1px solid ${C.border}`,
                  borderRadius: '10px', padding: '10px 12px', textAlign: 'center',
                }}>
                  <div style={{ fontFamily: SH.fm, fontSize: '17px', color: C.accent }}>{value}</div>
                  <div style={{ fontSize: '10px', color: C.textM, marginTop: '2px' }}>{label}</div>
                  {note && <div style={{ fontSize: '9px', color: C.textM, opacity: 0.8, marginTop: '1px', fontStyle: 'italic' }}>{note}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* The State of Quizzes teaser (E5): headline, standfirst, opening paragraph */}
      {(results.length > 0 || echoSessions.length > 0) && (
        <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: '28px', marginBottom: '32px' }}>
          <GazetteKicker>{quizReport.kicker}</GazetteKicker>
          <GazetteHeadline size="md">{quizReport.headline}</GazetteHeadline>
          {quizReport.standfirst && <GazetteStandfirst>{quizReport.standfirst}</GazetteStandfirst>}
          <DropCapLead text={quizReport.teaser} columns={isMobile ? 1 : 2} />
          <button onClick={() => setView('report')} style={{
            fontSize: '11px', color: C.accent, background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          }}>
            Read the full report →
          </button>
        </div>
      )}

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
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px', marginTop: '8px', justifyContent: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: C.textM }}>
                <div style={{ width: '20px', height: '2px', background: C.accent }} /> Vocabulary
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: C.textM }}>
                <div style={{ width: '20px', height: '0', borderTop: `2px dashed ${C.accent2 || C.success}` }} /> Grammar · Translation
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: C.textM }}>
                <svg width="20" height="8" aria-hidden="true">
                  <line x1="1" y1="4" x2="19" y2="4" stroke={C.accent2 || C.success} strokeWidth="2" strokeDasharray="1.5,3.5" strokeLinecap="round" />
                  <circle cx="10" cy="4" r="3" fill={C.bg} stroke={C.accent2 || C.success} strokeWidth="1.5" />
                </svg> Grammar · Selection
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
        C={C} S={S}
      />
      {configModal === 'echo' && <EchoQuizConfig
        seed={echoSeed}
        preset={echoPreset}
        onBack={() => { setConfigModal(null); setEchoPreset(null); }}
        onStart={(setup) => { setConfigModal(null); setEchoPreset(null); handleEchoStart(setup); }}
        cards={enrichedCards}
        decks={decks}
        wordInputs={wordInputs}
        lemmaMaster={lemmaMaster}
        aviSources={aviSources}
        aviSections={aviSections}
        dsh={dsh}
        C={C} S={S}
      />}
    </div>
  );
}
