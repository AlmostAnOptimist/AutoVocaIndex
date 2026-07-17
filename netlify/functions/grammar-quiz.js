// netlify/functions/grammar-quiz.js
// Grammar quiz endpoint. The client sends only a structured quiz request
// (mode + fields below); this function owns the prompt templates and builds
// the Anthropic API call itself with a pinned model, token cap, and system
// prompt — so the endpoint cannot be used as a general passthrough proxy.
// Modes: 'selection' | 'drill' | 'broad' | 'assess'.

const MODEL      = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 4000;
const SYSTEM     = 'You output only valid JSON. No prose, no markdown fences.';

// Field sanitizers: strings are length-capped, numbers clamped. Oversized or
// wrong-typed input degrades to a bounded value rather than erroring, except
// where a field is essential to the mode (checked in buildPrompt).
const str = (v, cap) => (typeof v === 'string' ? v.slice(0, cap) : '');
const int = (v, min, max, dflt) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

// Builds the mode-specific prompt from a sanitized request body.
// Returns null when the request doesn't describe a valid quiz.
// [LANG-SPECIFIC] All four templates are written for Korean (docs/08).
function buildPrompt(body) {
  const mode          = body?.mode;
  const corpusText    = str(body?.corpusText, 60000);
  const candidateText = str(body?.candidateText, 20000);
  const length        = int(body?.length, 1, 20, 5);

  if (mode === 'selection') {
    if (!corpusText || !candidateText) return null;
    return `You are composing a Korean grammar quiz. The learner will see multiple Korean sentence variants for each question and must identify which are grammatically and contextually correct.

FULL GRAMMAR CORPUS (for reference):
${corpusText}

CONCEPTS TO COMPARE (the learner selected these to practice):
${candidateText}

Generate ${length} questions. Each question must:
- Use ALL of the selected concepts (one sentence variant per concept)
- At least one sentence per question must be correct
- Sentences should be natural Korean, varied in topic and register
- Incorrect sentences must contain grammatical errors specifically related to the grammar concepts being tested — wrong form,  nuance, or usage context. Do NOT use misspellings, vocabulary errors, or unrelated grammar mistakes. The error should be subtle enough that a learner might plausibly make it.
Respond with ONLY a JSON object:
{
  "questions": [
    {
      "sentences": [
        { "text": "Korean sentence", "concept": "concept term", "correct": true/false }
      ]
    }
  ]
}`;
  }

  if (mode === 'drill') {
    const concept = {
      id:          str(body?.concept?.id, 100),
      term:        str(body?.concept?.term, 200),
      explanation: str(body?.concept?.explanation, 2000),
    };
    if (!corpusText || !concept.term) return null;
    return `You are composing a Korean grammar translation quiz focused on one grammar concept.

FULL GRAMMAR CORPUS (for reference):
${corpusText}

TARGET CONCEPT: ${concept.term}${concept.explanation ? ` — ${concept.explanation}` : ''}

Generate ${length} varied English sentences that should be translated into Korean using "${concept.term}". Each sentence needs:
- A natural, conversational English sentence
- A short context blurb (1–2 sentences) describing the situation, register, or emotional nuance — enough to make the appropriate usage/nuance clear

Respond with ONLY a JSON object:
{
  "questions": [
    {
      "english": "English sentence",
      "context": "Context blurb",
      "correctConceptId": "${concept.id}",
      "choices": null
    }
  ]
}`;
  }

  if (mode === 'broad') {
    const choiceCount = int(body?.choiceCount, 2, 6, 4);
    const restrict    = !!body?.restrict && !!candidateText;
    if (!corpusText) return null;
    return `You are composing a Korean grammar translation quiz. Each question shows an English sentence with context and ${choiceCount} grammar concept choices (one correct, ${choiceCount - 1} confusable distractors).

FULL GRAMMAR CORPUS:
${corpusText}

${restrict ? `CANDIDATE CONCEPTS (restrict questions and distractors to these):\n${candidateText}\n\n` : ''}Generate ${length} varied English sentences. For each:
- Choose the most appropriate grammar concept from the ${restrict ? 'candidate concepts' : 'full corpus'}
- Select ${choiceCount - 1} distractor concept IDs that are genuinely confusable (similar function, register, or form)
- Write a short context blurb (1–2 sentences) describing situation, register, or emotional nuance

Respond with ONLY a JSON object:
{
  "questions": [
    {
      "english": "English sentence",
      "context": "Context blurb",
      "correctConceptId": "concept_id",
      "distractorIds": ["id1", "id2"]
    }
  ]
}`;
  }

  if (mode === 'assess') {
    const rawItems = Array.isArray(body?.items) ? body.items.slice(0, 30) : [];
    const items = rawItems.map(it => ({
      english:        str(it?.english, 2000),
      context:        str(it?.context, 2000),
      correctConcept: str(it?.correctConcept, 200),
      userKorean:     str(it?.userKorean, 2000),
    }));
    if (items.length === 0) return null;
    return `You are assessing a Korean language learner's translations.

For each sentence, evaluate the learner's Korean translation on three dimensions:
1. Grammar: Did they use the target grammar concept correctly?
2. Vocabulary: Are the word choices natural and appropriate?
3. Completeness: Does it express the full meaning of the English? Does it sound natural rather than foreign/robotic?

Overall verdict:
- "O" = fully correct and natural
- "△" = understandable but has errors
- "X" = incorrect or unintelligible

For △ and X verdicts, also provide a corrected Korean sentence. For O, set corrected to null.

Sentences to assess:
${JSON.stringify(items)}

Respond with ONLY a JSON object:
{
  "assessment": [
    {
      "verdict": "O" | "△" | "X",
      "grammar": "brief note",
      "vocabulary": "brief note",
      "completeness": "brief note including naturalness judgement",
      "corrected": "corrected Korean sentence or null"
    }
  ]
}`;
  }

  return null;
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // Demo mode (D9): the grammar quiz type is hidden in the demo UI; this
  // guard keeps the endpoint itself inert as defense in depth.
  if (Netlify.env.get('DEMO_MODE') === 'true') {
    return new Response(JSON.stringify({ error: 'disabled in demo' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'API key not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const prompt = buildPrompt(body);
  if (!prompt) {
    return new Response(JSON.stringify({ error: 'Invalid quiz request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     SYSTEM,
      messages:   [{ role: 'user', content: prompt }],
    }),
  });

  const data = await response.text();
  return new Response(data, {
    status: response.status,
    headers: { 'Content-Type': 'application/json' },
  });
};

export const config = {
  path: '/api/grammar-quiz',
  // 30 second timeout — grammar prompts are larger than voca distractor calls
  timeout: 30,
};