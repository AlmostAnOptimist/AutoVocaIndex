// src/utils/grammarQuizUtils.js
// Shared grammar quiz logic used by QuizzesPage and the FlashcardsPage grammar session.

// ── Prompt builders ───────────────────────────────────────────

// Builds the Drill-mode request payload for a single grammar concept.
// Used by QuizzesPage (Drill mode) and the grammar session mini-quiz (5 questions, fixed concept).
// The prompt template itself lives server-side in netlify/functions/grammar-quiz.js.
export function buildGrammarDrillPayload(concept, length, corpusText) {
  return {
    mode: 'drill',
    concept: { id: concept.id, term: concept.term, explanation: concept.explanation || '' },
    length,
    corpusText,
  };
}

// Builds the assessment request payload for a completed translation session.
// The prompt template itself lives server-side in netlify/functions/grammar-quiz.js.
export function buildGrammarAssessmentPayload(questions, translations) {
  const items = questions.map((q, i) => ({
    english:        q.english,
    context:        q.context || '',
    correctConcept: q.correctConcept?.term || '',
    userKorean:     translations[i] || '',
  }));
  return { mode: 'assess', items };
}

// ── API call wrapper ──────────────────────────────────────────

// Calls the grammar quiz endpoint with a structured payload and returns the
// parsed JSON response. The server owns the prompt templates and the pinned
// Anthropic request (model, token cap, system prompt) — see
// netlify/functions/grammar-quiz.js.
// Throws on network error, non-OK status, or parse failure.
export async function callGrammarQuizAPI(payload) {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch('/api/grammar-quiz', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    const raw  = data.content?.find(b => b.type === 'text')?.text || '';
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

// ── Response parsers ──────────────────────────────────────────

// Enriches raw drill question objects with correctConcept from the corpus.
// corpus: array of grammar entry objects with { id, term, ... }
export function parseDrillQuestions(parsed, corpus) {
  const corpusById = Object.fromEntries(corpus.map(e => [e.id, e]));
  return (parsed.questions || []).map(q => ({
    ...q,
    correctConcept: corpusById[q.correctConceptId] || null,
    choices:        null,
  }));
}

// Unwraps the assessment array from the parsed API response.
export function parseGrammarAssessment(parsed) {
  return parsed.assessment || [];
}

// ── Grammar session grading ───────────────────────────────────

// Maps a quiz score percentage to an SM-2 grade for the grammar flashcard session.
// <60% → 2 (Shaky), 61–90% → 3 (Familiar), 91–100% → 5 (Solid)
export function grammarScoreToGrade(pct) {
  if (pct <= 60) return 2;
  if (pct <= 90) return 3;
  return 5;
}

// Grade button config for the grammar session (subset of the full 5-grade scale).
export const GRAMMAR_GRADES = [
  { grade: 2, label: 'Shaky',    color: '#c0553a' },
  { grade: 3, label: 'Familiar', color: '#c9973a' },
  { grade: 5, label: 'Solid',    color: '#4a90d9' },
];