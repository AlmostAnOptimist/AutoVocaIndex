// netlify/functions/grammar-quiz.js
// Grammar quiz endpoint. The client sends only a structured quiz request
// (mode + fields below); this function owns the prompt templates, the JSON
// response schemas and the pinned Anthropic request — so the endpoint cannot
// be used as a general passthrough proxy.
// Modes: 'selection' | 'drill' | 'broad' | 'assess' | 'explain'.
//
// Grammar Quiz overhaul, stage G1:
//   - Concepts are referred to by short refs (G1, G2, …) assigned by the
//     client per request; the client maps refs back to corpus IDs and
//     validates everything (src/utils/grammarQuizEngine.js).
//   - Every mode uses schema-locked JSON (output_config.format).
//   - Returns { result } on success, or { error: <code> } with a status the
//     client can explain: too_long / refused / bad_json (502), timeout (504),
//     upstream_busy (503), upstream (502).
//   - Netlify's synchronous limit is a fixed 60 s, so the Anthropic call is
//     aborted at 50 s to return a clean 504 instead of being killed.

// Caller check (S-D2/S-D3): CJS helper, default-imported for ESM interop.
// firebase-admin is imported HERE, statically, and handed to the helper:
// Netlify's packager for this function format follows static imports but
// not a require() inside the helper, which left firebase-admin out of the
// package and crashed this function on load (G1 hotfix).
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import verifyUserLib from '../lib/verifyUser.cjs';
const { verifyUser, useFirebaseAdmin } = verifyUserLib;
// Not a React hook (the template's eslint config applies React rules repo-wide).
// eslint-disable-next-line react-hooks/rules-of-hooks
useFirebaseAdmin({ initializeApp, getApps, getAuth });

// G-D8: Sonnet 5.5 thinks by default and rejects thinking 'disabled';
// 'between_tools' is its lowest setting (no up-front thinking).
const MODEL               = 'claude-sonnet-5-5';
const THINKING            = { type: 'between_tools' };
const MAX_TOKENS          = 8000;
const UPSTREAM_TIMEOUT_MS = 50000;
const SYSTEM              = 'You write Korean grammar quiz material and assessments for an English-speaking learner. Follow the requested JSON schema exactly.';

// Field sanitizers: strings are length-capped, numbers clamped. Oversized or
// wrong-typed input degrades to a bounded value rather than erroring, except
// where a field is essential to the mode (checked in buildRequest).
const str = (v, cap) => (typeof v === 'string' ? v.slice(0, cap) : '');
const int = (v, min, max, dflt) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
// Parallel batches of one quiz each get a theme so they don't write the same
// sentences (G2). Must match CHUNK_THEMES in src/utils/grammarQuizEngine.js;
// anything else is ignored.
const THEMES = [
  'daily life and home',
  'work and school',
  'travel, places and getting around',
  'friends, family and feelings',
  'news, society and opinions',
  'hobbies, food and culture',
];
const themeLine = (v) => (THEMES.includes(v) ? `\n\nFor variety, set these questions mainly in this theme: ${v}.` : '');
// Caps a multi-line block at a line boundary, so no concept line is cut in half.
const linesCapped = (v, cap) => {
  const s = str(v, cap + 1);
  if (s.length <= cap) return s;
  const cut = s.lastIndexOf('\n', cap);
  console.warn(`grammar-quiz: block over ${cap} chars, trimmed at a line boundary`);
  return cut > 0 ? s.slice(0, cut) : s.slice(0, cap);
};

// ── Response schemas ──────────────────────────────────────────
// Structured outputs: every object needs additionalProperties: false and all
// properties required. Counts and lengths are enforced by the client.
const T_STR  = { type: 'string' };
const T_INT  = { type: 'integer' };
const T_BOOL = { type: 'boolean' };
const obj = (properties) => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
});
const arr = (items) => ({ type: 'array', items });

const SCHEMAS = {
  selection: obj({ questions: arr(obj({
    // G4: reason + fix explain each incorrect sentence ("" for correct ones)
    sentences: arr(obj({ text: T_STR, conceptRef: T_STR, correct: T_BOOL, reason: T_STR, fix: T_STR })),
  })) }),
  drill: obj({ questions: arr(obj({ english: T_STR, context: T_STR })) }),
  broad: obj({ questions: arr(obj({
    english: T_STR, context: T_STR, answerRef: T_STR, distractorRefs: arr(T_STR),
  })) }),
  assess: obj({ assessment: arr(obj({
    item: T_INT,
    verdict: { type: 'string', enum: ['O', '△', 'X'] },
    grammar: T_STR, vocabulary: T_STR, completeness: T_STR, corrected: T_STR,
  })) }),
  explain: obj({ explanations: arr(obj({ item: T_INT, text: T_STR })) }),
};

// Builds { prompt, schema } from a sanitized request body.
// Returns null when the request doesn't describe a valid quiz.
// [LANG-SPECIFIC] All templates are written for Korean (docs/08).
function buildRequest(body) {
  const mode   = body?.mode;
  const length = int(body?.length, 1, 20, 5);

  if (mode === 'selection') {
    const detailText = linesCapped(body?.detailText, 40000);
    if (!detailText) return null;
    return { schema: SCHEMAS.selection, prompt: `You are composing a Korean grammar quiz. For each question the learner sees several Korean sentences and must select every sentence that is grammatically and contextually correct.

CONCEPTS TO COMPARE (the learner chose these; each one starts with its ref, e.g. G12):
${detailText}

Write ${length} questions. Each question must:
- Contain exactly one sentence per concept above, with that concept's ref in "conceptRef"
- Have at least one correct sentence ("correct": true)
- Use natural Korean, varied in topic and register
- Make every incorrect sentence wrong specifically in its tagged concept — wrong form, nuance, or usage context. Do NOT use misspellings, vocabulary errors, or unrelated grammar mistakes. The error should be subtle enough that a learner might plausibly make it.
- For each incorrect sentence, set "reason" to one short English sentence naming the error, and "fix" to the corrected Korean sentence (change only what is wrong). For correct sentences, set both to an empty string.${themeLine(body?.theme)}` };
  }

  if (mode === 'drill') {
    const detailText = linesCapped(body?.detailText, 8000);
    if (!detailText) return null;
    return { schema: SCHEMAS.drill, prompt: `You are composing a Korean grammar translation quiz focused on one grammar concept.

TARGET CONCEPT:
${detailText}

Write ${length} varied English sentences that the learner should translate into Korean using this concept. For each:
- "english": a natural, conversational English sentence
- "context": a short blurb (1–2 sentences) describing the situation, register, or emotional nuance — enough to make the appropriate usage clear${themeLine(body?.theme)}` };
  }

  if (mode === 'broad') {
    const corpusText    = linesCapped(body?.corpusText, 120000);
    const choiceCount   = int(body?.choiceCount, 2, 6, 4);
    const candidateText = linesCapped(body?.candidateText, 40000);
    const restrict      = !!body?.restrict && !!candidateText;
    if (!corpusText) return null;
    return { schema: SCHEMAS.broad, prompt: `You are composing a Korean grammar translation quiz. Each question shows an English sentence with context and ${choiceCount} grammar concept choices: one correct and ${choiceCount - 1} confusable distractors. The learner picks the concept, then translates the sentence into Korean.

GRAMMAR CORPUS (one concept per line; each line starts with its ref, e.g. G12):
${corpusText}

${restrict ? `FOCUS CONCEPTS (every answer must be one of these):\n${candidateText}\n\n` : ''}Write ${length} questions. For each:
- "answerRef": the ref of the most appropriate concept${restrict ? ' from the focus concepts' : ' from the corpus'}; vary the answers across questions
- "distractorRefs": exactly ${choiceCount - 1} refs of OTHER concepts from the corpus that are genuinely confusable with the answer (similar function, register, or form)${restrict ? ', preferring other focus concepts when they are confusable' : ''}
- "english": a natural English sentence that calls for the answer concept
- "context": 1–2 sentences on situation, register, or emotional nuance that make the right concept clear, without naming or quoting any grammar pattern
Use only refs that appear in the corpus above.${themeLine(body?.theme)}` };
  }

  if (mode === 'assess') {
    const rawItems = Array.isArray(body?.items) ? body.items.slice(0, 30) : [];
    const items = rawItems.map((it, i) => ({
      item:          int(it?.item, 1, 30, i + 1),
      english:       str(it?.english, 2000),
      context:       str(it?.context, 2000),
      targetConcept: str(it?.targetConcept, 200),
      chosenConcept: str(it?.chosenConcept, 200),
      userKorean:    str(it?.userKorean, 2000),
    }));
    if (items.length === 0) return null;
    return { schema: SCHEMAS.assess, prompt: `You are assessing a Korean language learner's translations.

For each item, evaluate the learner's Korean translation ("userKorean") of the English sentence, given its context and target grammar concept, on three dimensions:
1. Grammar ("grammar"): Did they use the target grammar concept correctly?
2. Vocabulary ("vocabulary"): Are the word choices natural and appropriate?
3. Completeness ("completeness"): Does it express the full meaning of the English? Does it sound natural rather than foreign or robotic?
Keep each note brief.

Some items also have "chosenConcept": the concept the learner picked from multiple choices before translating (that pick is scored separately). When it is not empty and differs from "targetConcept", say briefly in the grammar note whether the translation used the chosen concept or the target one, and how they differ here. Judge the verdict on the translation itself.

Overall verdict:
- "O" = fully correct and natural
- "△" = understandable but has errors
- "X" = incorrect, unintelligible, or left blank

For △ and X, put a corrected Korean sentence in "corrected". For O, set "corrected" to an empty string.
Return exactly one assessment per item, with the item's number in "item".

Items:
${JSON.stringify(items)}` };
  }

  if (mode === 'explain') {
    const rawItems = Array.isArray(body?.items) ? body.items.slice(0, 30) : [];
    const items = rawItems.map((it, i) => ({
      item:      int(it?.item, 1, 30, i + 1),
      text:      str(it?.text, 500),
      concept:   str(it?.concept, 200),
      errorType: it?.errorType === 'missed_correct' ? 'missed_correct' : 'selected_wrong',
    })).filter(it => it.text && it.concept);
    if (!items.length) return null;
    return { schema: SCHEMAS.explain, prompt: `You are explaining Korean grammar mistakes to a language learner.

For each item, explain briefly why the sentence is correct or incorrect for the given grammar concept, and what the learner should understand. Return exactly one explanation per item, with the item's number in "item".

Items:
${items.map(m => `${m.item}. Sentence: "${m.text}"
   Grammar concept: ${m.concept}
   ${m.errorType === 'missed_correct'
     ? 'The learner did NOT select this sentence, but it is grammatically correct and appropriate. Explain why it is valid.'
     : 'The learner SELECTED this sentence, but it contains a grammar error. Explain what is wrong with it.'}`).join('\n\n')}` };
  }

  return null;
}

const json = (status, payload) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // Demo mode (D9): the grammar quiz type is hidden in the demo UI; this
  // guard keeps the endpoint itself inert as defense in depth.
  if (Netlify.env.get('DEMO_MODE') === 'true') {
    return json(403, { error: 'disabled in demo' });
  }

  // Only signed-in users on ALLOWED_UIDS may spend the API key.
  const caller = await verifyUser(req.headers.get('authorization'));
  if (!caller.ok) {
    return json(caller.status, { error: caller.error });
  }

  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return json(500, { error: 'API key not configured' });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const built = buildRequest(body);
  if (!built) {
    return json(400, { error: 'Invalid quiz request' });
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:         MODEL,
        max_tokens:    MAX_TOKENS,
        thinking:      THINKING,
        system:        SYSTEM,
        messages:      [{ role: 'user', content: built.prompt }],
        output_config: { format: { type: 'json_schema', schema: built.schema } },
      }),
    });

    if (!upstream.ok) {
      const detail = (await upstream.text()).slice(0, 500);
      console.error('grammar-quiz: Anthropic error', upstream.status, detail);
      const busy = upstream.status === 429 || upstream.status === 529;
      return json(busy ? 503 : 502, { error: busy ? 'upstream_busy' : 'upstream', status: upstream.status });
    }

    const data = await upstream.json();
    if (data?.stop_reason === 'max_tokens') {
      console.warn('grammar-quiz: hit max_tokens', body?.mode, data?.usage);
      return json(502, { error: 'too_long' });
    }
    if (data?.stop_reason === 'refusal') {
      return json(502, { error: 'refused' });
    }

    const text = data?.content?.find(b => b.type === 'text')?.text || '';
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      console.error('grammar-quiz: unparseable model output', text.slice(0, 300));
      return json(502, { error: 'bad_json' });
    }
    return json(200, { result, usage: data?.usage || null });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      console.warn('grammar-quiz: Anthropic call exceeded', UPSTREAM_TIMEOUT_MS, 'ms', body?.mode);
      return json(504, { error: 'timeout' });
    }
    console.error('grammar-quiz: request failed', e);
    return json(502, { error: 'upstream' });
  }
};

export const config = {
  path: '/api/grammar-quiz',
  // Netlify's synchronous limit is a fixed 60 s and can't be configured here;
  // the Anthropic call is aborted at 50 s instead (UPSTREAM_TIMEOUT_MS).
  // Per-IP backstop (S-D6): 20 requests per 60 seconds (raised from 10 in G2:
  // a 20-question quiz is 2 generation + 2 assessment requests, plus retries).
  // Check the deploy log to confirm Netlify accepted the rule — an invalid
  // rule doesn't fail the deploy.
  rateLimit: {
    windowLimit: 20,
    windowSize:  60,
    aggregateBy: ['ip', 'domain'],
  },
};
