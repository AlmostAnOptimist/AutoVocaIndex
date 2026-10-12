// src/utils/grammarQuizUtils.js
// Grammar quiz API call, used by QuizzesPage.
//
// The prompt templates, response schemas and pinned model live server-side in
// netlify/functions/grammar-quiz.js. Building requests and validating what
// comes back lives in grammarQuizEngine.js (pure, golden-tested).

import { apiFetch } from './apiFetch.js';

// The server aborts its Anthropic call at 50 s (Netlify's hard limit is 60 s),
// so the client waits a little longer than that before giving up itself.
const CLIENT_TIMEOUT_MS = 58000;

// Error with a machine-readable code, so the UI can say what went wrong:
//   timeout · too_long · refused · bad_json · upstream_busy · upstream ·
//   rate_limited · unauthorized · invalid_request · network · server
export class GrammarQuizError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'GrammarQuizError';
    this.code = code;
  }
}

const STATUS_CODES = { 400: 'invalid_request', 401: 'unauthorized', 403: 'unauthorized', 429: 'rate_limited' };

// Calls the grammar quiz endpoint with a structured payload and returns the
// parsed result object. Throws GrammarQuizError on any failure.
export async function callGrammarQuizAPI(payload) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);

  let res;
  try {
    res = await apiFetch('/api/grammar-quiz', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    clearTimeout(timer);
    if (e?.name === 'AbortError') throw new GrammarQuizError('timeout', 'No response within 58 seconds');
    throw new GrammarQuizError('network', e?.message);
  }
  clearTimeout(timer);

  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error page */ }

  if (!res.ok) {
    const code = (typeof data?.error === 'string' && /^[a-z_]+$/.test(data.error))
      ? data.error
      : (STATUS_CODES[res.status] || 'server');
    throw new GrammarQuizError(code, `API ${res.status}${data?.error ? `: ${data.error}` : ''}`);
  }
  if (!data || typeof data.result !== 'object' || data.result === null) {
    throw new GrammarQuizError('bad_json', 'Response had no result');
  }
  return data.result;
}

// Sends several payloads in parallel (G2 chunked requests) and returns
// Promise.allSettled results in the same order. Callers decide whether a
// partial success is usable (generation) or not (assessment).
export function callGrammarQuizChunks(payloads) {
  return Promise.allSettled(payloads.map(p => callGrammarQuizAPI(p)));
}

// Plain-language explanation of a failure, for the banners on the Quizzes
// home screen and the translation results screen.
const ERROR_TEXT = {
  timeout:       'The request took too long. Try again, or ask for fewer questions.',
  too_long:      'The response was too long to finish in one go. Try fewer questions or fewer concepts.',
  rate_limited:  'Too many requests in the last minute. Wait a moment, then try again.',
  upstream_busy: 'The AI service is busy right now. Try again in a moment.',
  unauthorized:  'The sign-in check failed. Refresh the page, then try again.',
  network:       'Couldn\'t reach the server. Check your connection, then try again.',
  no_questions:  'The questions that came back didn\'t pass the checks. Try again.',
  interrupted:   'This quiz was submitted but never assessed.',
};
export function describeGrammarQuizError(code) {
  return ERROR_TEXT[code] || 'Something went wrong on the server. Try again.';
}