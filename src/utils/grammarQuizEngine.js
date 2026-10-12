// src/utils/grammarQuizEngine.js
// Pure grammar quiz logic (decisions G-D9 / G-D10 of the grammar quiz overhaul):
//   - concept refs: the model sees short refs (G1, G2, … in corpus order)
//     instead of 20-character Firestore IDs; refs are mapped back here
//   - corpus formatting: a compact line per entry for Broad mode, full
//     explanations only for the concepts in play
//   - request builders for every mode (the prompt templates and response
//     schemas themselves live server-side in netlify/functions/grammar-quiz.js)
//   - validation of everything the model returns, against the corpus
//   - alignment of assessments / explanations by item number, never position
//
// No imports: no Firebase, no React, no fetch. Runs in plain Node for
// scripts/grammar-golden.mjs.

export const COMPACT_COMPARE_CAP    = 120;  // chars of compare-to per compact line
export const DETAIL_EXPLANATION_CAP = 1800; // chars of explanation per concept in play

const VERDICTS = ['O', '△', 'X'];

const cleanLine = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// Fisher–Yates on a copy. `rand` is injectable so tests can be deterministic.
export function shuffled(arr, rand = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Slim concept shape kept on questions and saved in result details.
// Full explanations stay out of quiz state and Firestore detail docs.
export function slimConcept(e) {
  return e ? { id: e.id, term: cleanLine(e.term), level: cleanLine(e.level) } : null;
}

// ── Concept index ─────────────────────────────────────────────
// Usable entries only (an id and a term), in corpus order. Refs are stable
// within one request — that is all they need to be.
export function buildConceptIndex(corpus) {
  const entries = (Array.isArray(corpus) ? corpus : [])
    .filter(e => e && typeof e.id === 'string' && e.id && cleanLine(e.term));
  const refOf = new Map();
  const byRef = new Map();
  entries.forEach((e, i) => {
    const ref = `G${i + 1}`;
    refOf.set(e.id, ref);
    byRef.set(ref, e);
  });
  return { entries, refOf, byRef };
}

// Accepts "G12", "g12", " G12 " — and tolerates a stray "ID:" prefix.
export function resolveRef(index, ref) {
  if (typeof ref !== 'string') return null;
  const key = ref.trim().replace(/^ID:\s*/i, '').toUpperCase();
  return index.byRef.get(key) || null;
}

// ── Corpus formatting ─────────────────────────────────────────
export function formatCompactLine(index, e) {
  const parts = [index.refOf.get(e.id), cleanLine(e.term)];
  const level = cleanLine(e.level);
  if (level) parts.push(`Level: ${level}`);
  const cmp = cleanLine(e.compareTo);
  if (cmp) parts.push(`Compare: ${clip(cmp, COMPACT_COMPARE_CAP)}`);
  return parts.join(' | ');
}

export function formatCompactCorpus(index, entries = index.entries) {
  return entries.map(e => formatCompactLine(index, e)).join('\n');
}

// Full detail for concepts in play. Explanation line breaks are kept.
export function formatConceptDetails(index, entries) {
  return entries.map(e => {
    const head = formatCompactLine(index, e);
    const exp = typeof e.explanation === 'string' ? e.explanation.trim() : '';
    return exp ? `${head}\n${clip(exp, DETAIL_EXPLANATION_CAP)}` : head;
  }).join('\n\n');
}

// ── Generation requests ───────────────────────────────────────
// config: { mode: 'translation'|'selection', transMode: 'drill'|'broad',
//           length, choiceCount, selectedIds }
// Returns { mode, payload, index } or { error }.
export function buildGenerationRequest(config, corpus) {
  const index = buildConceptIndex(corpus);
  if (!index.entries.length) return { error: 'empty_corpus' };

  const selectedSet = new Set(Array.isArray(config?.selectedIds) ? config.selectedIds : []);
  // Corpus order, not click order — deterministic and matches the picker.
  const selected = index.entries.filter(e => selectedSet.has(e.id));
  const length = Math.min(20, Math.max(1, parseInt(config?.length, 10) || 5));

  if (config?.mode === 'selection') {
    if (selected.length < 2) return { error: 'need_two_concepts' };
    return {
      mode: 'selection', index, conceptCount: selected.length,
      payload: { mode: 'selection', length, detailText: formatConceptDetails(index, selected) },
    };
  }

  if (config?.transMode === 'drill') {
    if (selected.length < 1) return { error: 'need_one_concept' };
    const concept = selected[0];
    return {
      mode: 'drill', index, drillConceptId: concept.id,
      payload: { mode: 'drill', length, detailText: formatConceptDetails(index, [concept]) },
    };
  }

  // Focus concepts restrict the ANSWERS only; distractors may come from the
  // whole corpus, so a small focus set still fills every choice.
  const choiceCount = [2, 3, 4, 6].includes(config?.choiceCount) ? config.choiceCount : 4;
  const restrict = selected.length > 0;
  return {
    mode: 'broad', index,
    payload: {
      mode: 'broad', length, choiceCount, restrict,
      corpusText:    formatCompactCorpus(index),
      candidateText: restrict ? formatCompactCorpus(index, selected) : '',
    },
  };
}

// ── Generated-question validation ─────────────────────────────
// Returns { questions, dropped }. Every returned question is safe to render:
// broad choices always include the answer, contain no nulls or duplicates;
// selection questions have ≥2 sentences and ≥1 correct one.
export function validateGeneratedQuestions(request, parsed, { config = {}, rand = Math.random } = {}) {
  const raw = Array.isArray(parsed?.questions) ? parsed.questions : [];
  const { mode, index } = request;
  const out = [];
  let dropped = 0;

  if (mode === 'drill') {
    const concept = slimConcept(index.entries.find(e => e.id === request.drillConceptId));
    for (const q of raw) {
      const english = cleanLine(q?.english);
      if (!english || !concept) { dropped++; continue; }
      out.push({
        english, context: cleanLine(q?.context),
        correctConceptId: concept.id, correctConcept: concept, choices: null,
      });
    }
    return { questions: out, dropped };
  }

  if (mode === 'broad') {
    const choiceCount = [2, 3, 4, 6].includes(config.choiceCount) ? config.choiceCount : 4;
    const candidateIds = new Set(Array.isArray(config.selectedIds) ? config.selectedIds : []);
    const restrict = candidateIds.size > 0;
    const answerAllowed = (e) => e && (!restrict || candidateIds.has(e.id));
    for (const q of raw) {
      const english = cleanLine(q?.english);
      const answer = resolveRef(index, q?.answerRef);
      if (!english || !answerAllowed(answer)) { dropped++; continue; }
      const seen = new Set([answer.id]);
      const distractors = [];
      for (const ref of (Array.isArray(q?.distractorRefs) ? q.distractorRefs : [])) {
        const d = resolveRef(index, ref);
        if (!d || seen.has(d.id)) continue;
        seen.add(d.id);
        distractors.push(d);
        if (distractors.length === choiceCount - 1) break; // cap BEFORE adding the answer
      }
      if (distractors.length < 1) { dropped++; continue; } // need at least 2 options
      const correctConcept = slimConcept(answer);
      out.push({
        english, context: cleanLine(q?.context),
        correctConceptId: answer.id, correctConcept,
        choices: shuffled([correctConcept, ...distractors.map(slimConcept)], rand),
      });
    }
    return { questions: out, dropped };
  }

  if (mode === 'selection') {
    const selectedIds = new Set(Array.isArray(config.selectedIds) ? config.selectedIds : []);
    for (const q of raw) {
      const sentences = [];
      for (const s of (Array.isArray(q?.sentences) ? q.sentences : [])) {
        const text = cleanLine(s?.text);
        const c = resolveRef(index, s?.conceptRef);
        if (!text || !c || !selectedIds.has(c.id) || typeof s?.correct !== 'boolean') continue;
        sentences.push({
          text, concept: cleanLine(c.term), conceptId: c.id, correct: s.correct,
          // G4: why an incorrect sentence is wrong, and its corrected form
          reason: s.correct ? '' : cleanLine(s?.reason),
          fix:    s.correct ? '' : cleanLine(s?.fix),
        });
      }
      if (sentences.length < 2 || !sentences.some(s => s.correct)) { dropped++; continue; }
      out.push({ sentences });
    }
    return { questions: out, dropped };
  }

  return { questions: [], dropped: raw.length };
}

// ── Assessment ────────────────────────────────────────────────
// Items are numbered from 1 so the response can be matched by number.
// conceptChoices (Broad only, G3): the concept id the learner picked per
// question; sent as "chosenConcept" so the assessor can address a wrong pick.
export function buildAssessmentRequest(questions, translations, conceptChoices) {
  return {
    mode: 'assess',
    items: (questions || []).map((q, i) => ({
      item:          i + 1,
      english:       q?.english || '',
      context:       q?.context || '',
      targetConcept: q?.correctConcept?.term || '',
      chosenConcept: chosenTerm(q, conceptChoices && conceptChoices[i]),
      userKorean:    (translations && translations[i]) || '',
    })),
  };
}

// The term of the choice the learner picked, or '' (no pick / not Broad).
function chosenTerm(q, chosenId) {
  if (!chosenId || !Array.isArray(q?.choices)) return '';
  return q.choices.find(c => c && c.id === chosenId)?.term || '';
}

// Returns an array of length n: a clean assessment object per question, or
// null where the model skipped / garbled that item. Never undefined fields
// (Firestore rejects undefined).
export function alignAssessment(parsed, n) {
  const out = Array.from({ length: n }, () => null);
  for (const a of (Array.isArray(parsed?.assessment) ? parsed.assessment : [])) {
    const i = Number.isInteger(a?.item) ? a.item - 1 : -1;
    if (i < 0 || i >= n || out[i] || !VERDICTS.includes(a?.verdict)) continue;
    const corrected = cleanLine(a.corrected);
    out[i] = {
      verdict:      a.verdict,
      grammar:      cleanLine(a.grammar),
      vocabulary:   cleanLine(a.vocabulary),
      completeness: cleanLine(a.completeness),
      corrected:    a.verdict === 'O' || !corrected ? null : corrected,
    };
  }
  return out;
}

// ── Selection explanations ────────────────────────────────────
// items: [{ text, concept, errorType: 'missed_correct' | 'selected_wrong' }]
export function buildExplainRequest(items) {
  return {
    mode: 'explain',
    items: (items || []).map((m, i) => ({
      item:      i + 1,
      text:      m?.text || '',
      concept:   m?.concept || '',
      errorType: m?.errorType === 'missed_correct' ? 'missed_correct' : 'selected_wrong',
    })),
  };
}

// Returns an array of length n of explanation strings ('' where missing).
export function alignExplanations(parsed, n) {
  const out = Array.from({ length: n }, () => '');
  for (const x of (Array.isArray(parsed?.explanations) ? parsed.explanations : [])) {
    const i = Number.isInteger(x?.item) ? x.item - 1 : -1;
    if (i < 0 || i >= n || out[i]) continue;
    out[i] = typeof x?.text === 'string' ? x.text.trim() : '';
  }
  return out;
}

// ── Chunked requests (G2, G-D11) ──────────────────────────────
// A 5-question Broad generation takes ~7 s, so 10 questions per request keeps
// each call well inside the server's 50 s budget. Selection questions carry
// one sentence per concept, so their chunk size follows a sentence budget.
export const MAX_QUESTIONS_PER_REQUEST = 10;
export const SELECTION_SENTENCE_BUDGET = 40;
export const MAX_ASSESS_ITEMS_PER_REQUEST = 10;

// Parallel batches each get a different theme so they don't write the same
// sentences. The server accepts only these exact strings (same list there).
export const CHUNK_THEMES = [
  'daily life and home',
  'work and school',
  'travel, places and getting around',
  'friends, family and feelings',
  'news, society and opinions',
  'hobbies, food and culture',
];

// Splits n into k near-equal parts: 15 → [8, 7], 20 → [10, 10].
function splitEvenly(n, k) {
  const base = Math.floor(n / k), extra = n % k;
  return Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));
}

export function questionsPerRequest(request) {
  if (request?.mode === 'selection') {
    const perQuestion = Math.max(1, request.conceptCount || 2);
    return Math.max(1, Math.min(MAX_QUESTIONS_PER_REQUEST, Math.floor(SELECTION_SENTENCE_BUDGET / perQuestion)));
  }
  return MAX_QUESTIONS_PER_REQUEST;
}

// Returns the payloads to send in parallel. One payload (unchanged, no theme)
// when the quiz fits in a single request.
export function planGenerationChunks(request, rand = Math.random) {
  const total = request.payload.length;
  const k = Math.ceil(total / questionsPerRequest(request));
  if (k <= 1) return [request.payload];
  const offset = Math.floor(rand() * CHUNK_THEMES.length);
  return splitEvenly(total, k).map((length, i) => ({
    ...request.payload,
    length,
    theme: CHUNK_THEMES[(offset + i) % CHUNK_THEMES.length],
  }));
}

// Normalized text used to spot the same question coming back from two batches.
const dedupeKey = (q) => (q.sentences ? q.sentences.map(s => s.text).join(' / ') : q.english)
  .toLowerCase().replace(/[\s.,!?;:'"“”‘’()~…-]+/g, ' ').trim();

// validatedChunks: array of { questions, dropped } from validateGeneratedQuestions.
// Returns { questions, dropped, duplicates }.
export function mergeGeneratedChunks(validatedChunks) {
  const seen = new Set();
  const questions = [];
  let dropped = 0, duplicates = 0;
  for (const chunk of validatedChunks || []) {
    dropped += chunk?.dropped || 0;
    for (const q of (chunk?.questions || [])) {
      const key = dedupeKey(q);
      if (seen.has(key)) { duplicates++; continue; }
      seen.add(key);
      questions.push(q);
    }
  }
  return { questions, dropped, duplicates };
}

// Splits an assessment request into payloads of at most 10 items. Item
// numbers stay global, so the merged answers still align by number.
export function planAssessmentChunks(assessRequest) {
  const items = assessRequest?.items || [];
  if (items.length <= MAX_ASSESS_ITEMS_PER_REQUEST) return [assessRequest];
  const k = Math.ceil(items.length / MAX_ASSESS_ITEMS_PER_REQUEST);
  let start = 0;
  return splitEvenly(items.length, k).map(size => {
    const part = { ...assessRequest, items: items.slice(start, start + size) };
    start += size;
    return part;
  });
}

// Combines chunk results ({ assessment: [...] } each) into one array of
// length n aligned by item number.
export function mergeAssessmentChunks(parsedChunks, n) {
  const all = [];
  for (const p of parsedChunks || []) {
    if (Array.isArray(p?.assessment)) all.push(...p.assessment);
  }
  return alignAssessment({ assessment: all }, n);
}

// ── Device-only resume (G2, G-D7) ─────────────────────────────
// A snapshot of an unfinished session, saved to localStorage on this device
// only. phase 'answering' = still in the session; 'assessing' = translations
// submitted but the assessment never came back.
export const SESSION_SNAPSHOT_VERSION = 1;
export const SESSION_MAX_AGE_DAYS = 14;

export function buildSessionSnapshot(s, now = new Date()) {
  const snap = {
    v: SESSION_SNAPSHOT_VERSION,
    savedAt: now.toISOString(),
    kind: s.kind,
    phase: s.phase || 'answering',
    config: s.config || {},
    questions: s.questions || [],
    idx: s.idx || 0,
  };
  if (s.kind === 'translation') {
    snap.translations = s.translations || [];
    snap.conceptChoices = s.conceptChoices || [];
  } else {
    snap.selections = s.selections || [];
  }
  return snap;
}

// Returns a clean snapshot, or null when it is missing, corrupt, from another
// version, or older than SESSION_MAX_AGE_DAYS. Never throws.
export function parseSessionSnapshot(raw, now = new Date()) {
  try {
    const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!s || s.v !== SESSION_SNAPSHOT_VERSION) return null;
    if (!['translation', 'selection'].includes(s.kind)) return null;
    if (!['answering', 'assessing'].includes(s.phase)) return null;
    if (s.kind === 'selection' && s.phase !== 'answering') return null;
    const saved = Date.parse(s.savedAt);
    if (!Number.isFinite(saved) || now.getTime() - saved > SESSION_MAX_AGE_DAYS * 86400000 || saved > now.getTime() + 60000) return null;
    const questions = Array.isArray(s.questions) ? s.questions : [];
    const n = questions.length;
    if (!n) return null;
    if (s.kind === 'translation' && !questions.every(q => q && typeof q.english === 'string')) return null;
    if (s.kind === 'selection' && !questions.every(q => q && Array.isArray(q.sentences) && q.sentences.length)) return null;
    const idx = Number.isInteger(s.idx) ? Math.min(Math.max(s.idx, 0), n - 1) : 0;
    const out = {
      v: s.v, savedAt: s.savedAt, kind: s.kind, phase: s.phase,
      config: s.config && typeof s.config === 'object' ? s.config : {},
      questions, idx,
    };
    if (s.kind === 'translation') {
      const tr = Array.isArray(s.translations) ? s.translations : [];
      const cc = Array.isArray(s.conceptChoices) ? s.conceptChoices : [];
      out.translations   = questions.map((_, i) => (typeof tr[i] === 'string' ? tr[i] : ''));
      out.conceptChoices = questions.map((_, i) => (typeof cc[i] === 'string' ? cc[i] : null));
    } else {
      const sel = Array.isArray(s.selections) ? s.selections : [];
      out.selections = questions.map((q, i) => (Array.isArray(sel[i]) ? sel[i] : [])
        .filter(x => Number.isInteger(x) && x >= 0 && x < q.sentences.length)
        .filter((x, j, a) => a.indexOf(x) === j));
    }
    return out;
  } catch {
    return null;
  }
}

// How far into the quiz a snapshot is: answered translations, or questions
// with at least one sentence selected.
export function snapshotProgress(snap) {
  if (!snap) return { answered: 0, total: 0 };
  const total = snap.questions.length;
  const answered = snap.kind === 'translation'
    ? snap.translations.filter(t => t.trim()).length
    : snap.selections.filter(s => s.length).length;
  return { answered, total };
}

// ── Translation scoring (G3: G-D2, G-D3, G-D4) ────────────────
// Translation credit: O = 1, △ = 0.5 (half credit), X = 0. An item the
// assessor skipped (null) earns nothing.
export const TRANSLATION_CREDIT = { 'O': 1, '△': 0.5, 'X': 0 };

// Drill: each question is worth its translation credit.
// Broad (questions with choices): each question is worth 1 — 0.5 for picking
// the right concept + 0.5 × translation credit. No pick counts as a wrong pick.
// Returns { perQuestion, points, total, pct, fullyCorrect, concepts, missedConcepts }.
export function scoreTranslationQuiz(questions, assessment, conceptChoices) {
  const qs = Array.isArray(questions) ? questions : [];
  const perQuestion = qs.map((q, i) => {
    const a = assessment && assessment[i];
    const translation = a && a.verdict in TRANSLATION_CREDIT ? TRANSLATION_CREDIT[a.verdict] : 0;
    if (!Array.isArray(q?.choices) || !q.choices.length) {
      return { pick: null, translation, points: translation, full: translation === 1 };
    }
    const chosenId = (conceptChoices && conceptChoices[i]) || null;
    const chosen = q.choices.find(c => c && c.id === chosenId) || null;
    const correct = !!chosen && chosen.id === q.correctConceptId;
    const points = (correct ? 0.5 : 0) + 0.5 * translation;
    return {
      pick: { chosenId: chosen ? chosen.id : null, chosenTerm: chosen ? chosen.term : '', correct },
      translation, points, full: points === 1,
    };
  });
  const points = perQuestion.reduce((s, p) => s + p.points, 0);
  const total = perQuestion.length;
  const term = (q) => q?.correctConcept?.term;
  const concepts = [...new Set(qs.map(term).filter(Boolean))];
  const missedConcepts = [...new Set(qs.filter((q, i) => !perQuestion[i].full).map(term).filter(Boolean))];
  return {
    perQuestion, points, total,
    pct: total ? Math.round((points / total) * 100) : 0,
    fullyCorrect: perQuestion.filter(p => p.full).length,
    concepts, missedConcepts,
  };
}

// Points for display: 3 → "3", 2.5 → "2.5", 2.75 → "2.75".
export function formatPoints(n) {
  if (!Number.isFinite(n)) return '0';
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

// ── Selection scoring (G4: G-D5, G-D14) ───────────────────────
// A question counts only when the selected sentences are exactly the correct
// ones. A concept counts as missed when any of its sentences was misjudged
// (selected though wrong, or left out though correct).
// Returns { perQuestion, points, total, pct, concepts, missedConcepts }.
export function scoreSelectionQuiz(questions, selections) {
  const qs = Array.isArray(questions) ? questions : [];
  const concepts = new Set(), missed = new Set();
  const perQuestion = qs.map((q, qi) => {
    const chosen = new Set(Array.isArray(selections && selections[qi]) ? selections[qi] : []);
    const sentences = (Array.isArray(q?.sentences) ? q.sentences : []).map((s, si) => {
      const selected = chosen.has(si);
      const isRight = selected === !!s.correct;
      if (s.concept) {
        concepts.add(s.concept);
        if (!isRight) missed.add(s.concept);
      }
      return { selected, isRight };
    });
    return { correct: sentences.length > 0 && sentences.every(s => s.isRight), sentences };
  });
  const points = perQuestion.filter(p => p.correct).length;
  const total = perQuestion.length;
  return {
    perQuestion, points, total,
    pct: total ? Math.round((points / total) * 100) : 0,
    concepts: [...concepts], missedConcepts: [...missed],
  };
}

// Correction-note rows for a Selection quiz: one per incorrect sentence the
// learner selected, with its corrected form. Missed correct sentences need
// no correction, so they get no row.
export function buildSelectionCorrectionRows(questions, selections) {
  const rows = [];
  (Array.isArray(questions) ? questions : []).forEach((q, qi) => {
    const chosen = new Set(Array.isArray(selections && selections[qi]) ? selections[qi] : []);
    (q?.sentences || []).forEach((s, si) => {
      if (chosen.has(si) && !s.correct) {
        rows.push({ topic: s.concept || 'quiz', original: s.text || '', corrected: s.fix || '' });
      }
    });
  });
  return rows;
}

// Which kind of grammar quiz a saved result came from. Results saved before
// Selection was tagged (no meta.mode) were Translation quizzes.
export function grammarResultMode(r) {
  return r?.meta?.mode === 'selection' ? 'selection' : 'translation';
}

// Selections in a saved detail record are stored as [{ picked: [...] }]
// because Firestore can't hold an array directly inside an array (G4).
export function toSavedSelections(selections) {
  return (Array.isArray(selections) ? selections : []).map(s => ({ picked: Array.isArray(s) ? s : [] }));
}
export function readSavedSelections(saved) {
  return (Array.isArray(saved) ? saved : []).map(x => (Array.isArray(x) ? x : Array.isArray(x?.picked) ? x.picked : []));
}

// ── Concepts tested in a quiz (G5: G-D6, G-D15) ───────────────
// One entry per concept, in first-appearance order:
//   { id, term, count, missed }
// Translation: a concept is missed when any of its questions fell short of
// full credit. Selection: when any of its sentences was misjudged.
// `score` is the matching scoreTranslationQuiz / scoreSelectionQuiz result;
// without one (not assessed yet) nothing is marked missed.
export function summarizeQuizConcepts(kind, questions, score) {
  const list = [], byId = new Map();
  const touch = (id, term, ok) => {
    if (!id) return;
    let c = byId.get(id);
    if (!c) { c = { id, term: term || '', count: 0, missed: false }; byId.set(id, c); list.push(c); }
    c.count++;
    if (!ok) c.missed = true;
  };
  (Array.isArray(questions) ? questions : []).forEach((q, qi) => {
    if (kind === 'selection') {
      (q?.sentences || []).forEach((s, si) => {
        const st = score?.perQuestion?.[qi]?.sentences?.[si];
        touch(s?.conceptId, s?.concept, !st || st.isRight);
      });
    } else {
      const p = score?.perQuestion?.[qi];
      touch(q?.correctConceptId || q?.correctConcept?.id, q?.correctConcept?.term, !p || p.full);
    }
  });
  return list;
}

// Grammar Deck cards for a set of concepts (Grammar Index entry ids).
// Returns { cardIds, missing } — card ids in the same order as conceptIds,
// and the concept ids that have no Grammar Deck card.
export function cardIdsForConcepts(conceptIds, cards) {
  const byEntry = new Map();
  for (const c of (Array.isArray(cards) ? cards : [])) {
    if (c && c.type === 'grammar' && c.linkedGrammarEntryId && !byEntry.has(c.linkedGrammarEntryId)) {
      byEntry.set(c.linkedGrammarEntryId, c.id);
    }
  }
  const cardIds = [], missing = [];
  for (const id of (Array.isArray(conceptIds) ? conceptIds : [])) {
    const cardId = byEntry.get(id);
    if (cardId) { if (!cardIds.includes(cardId)) cardIds.push(cardId); }
    else missing.push(id);
  }
  return { cardIds, missing };
}