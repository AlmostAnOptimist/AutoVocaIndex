// src/utils/quizStateEngine.js
// "The State of Quizzes" — the lead report on the Quizzes page (Stage E5,
// E-D19 and E5 decisions of the Echo Quiz design). Replaces
// getQuizLeadStory, which picked one rule and wrote a sentence or two.
//
// The report always covers the whole quiz picture over a fixed window (the
// last 30 days, against the 30 before), whatever the Report Card's range
// toggle shows:
//   headline    — session count + the most notable finding
//   standfirst  — the 30-day average and its direction
//   paragraphs  — activity; scores; trouble spots (words and grammar
//                 concepts, cross-referenced with Grammar Index mastery);
//                 the Echo desk. A sentence is left out when its data isn't
//                 there; with any sessions on record the report never drops
//                 below two paragraphs.
//   teaser      — the first paragraph, for the Quizzes home screen
//
// Inputs (all optional): results (quiz_results docs: { type, score, date,
// meta }), echoSessions (echo_sessions docs, the echoEngine buildSummary
// shape), grammarEntries (live Grammar Index: { glossaryTerm, masteryLevel }),
// corpus (grammar_corpus entries: { term, level }, used when the live list
// lacks a term), today (logical 'YYYY-MM-DD'), dsh (day-start hour).
//
// Pure and deterministic: no Firebase, React or page imports (leaf module).
// Regression gate: scripts/quiz-golden.mjs.

import { toDateStr } from './dateUtils.js';

export const QS_WINDOW_DAYS    = 30;
const QUIET_DAYS               = 10;  // a quiz type gone this long is "quiet"
const STEADY_POINTS            = 5;   // under this, an average "held steady"
const HEADLINE_TYPE_MOVE       = 12;  // a type's move worth a headline
const HEADLINE_OVERALL_MOVE    = 8;   // the overall move worth a headline
const FORMAT_MIN_QUESTIONS     = 10;  // a Vocabulary format needs this many questions to be judged
const FORMAT_GAP               = 15;  // points between best and worst format to call one weak
const ECHO_CLEAN               = 90;  // first-try % both ways for "Echo runs clean"
const MILESTONES               = [10, 25, 50, 100, 150, 200, 250, 300, 400, 500, 750, 1000];

const KIND_LABEL = {
  voca: 'Vocabulary', echo: 'Echo', cloze: 'Cloze',
  grammar: 'Grammar', gt: 'Grammar Translation', gs: 'Grammar Selection',
};
const FORMAT_LABEL = { multiple: 'multiple choice', truefalse: 'true/false', type: 'typed answers' };
const FORMAT_HEAD  = { multiple: 'Multiple Choice', truefalse: 'True/False', type: 'Typed Answers' };

// ── Small helpers ─────────────────────────────────────────────

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const titleCase = (s) => s.split(' ').map(cap).join(' ');
// Running text: one–nine spelled out, 10 and up as numerals.
const num = (n) => (n >= 0 && n <= 9 ? WORDS[n] : String(n));
// Sentence starts and headlines: spelled out up to twenty.
const numWord = (n) => (n >= 0 && n <= 20 ? WORDS[n] : String(n));
const times = (n) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${num(n)} times`);
const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);
const pct = (x) => `${Math.round(x)}%`;
const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null);
const andList = (items) => {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
};
const normWord = (s) => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
const normKey  = (s) => normWord(s).replace(/\s+/g, '');

function daysBetween(fromStr, toStr) {
  const a = new Date(fromStr + 'T00:00:00');
  const b = new Date(toStr + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

// The logical day an ISO timestamp falls on (a session at 1am with a 3am day
// start belongs to the day before), in local time.
function logicalDay(iso, dsh) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  d.setHours(d.getHours() - (dsh || 0));
  return toDateStr(d);
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS   = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "today", "yesterday", "on Tuesday" (this past week), "on Oct 9".
function whenPhrase(day, today) {
  const ago = daysBetween(day, today);
  if (ago === 0) return 'today';
  if (ago === 1) return 'yesterday';
  const d = new Date(day + 'T00:00:00');
  if (ago < 7) return `on ${WEEKDAYS[d.getDay()]}`;
  return `on ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
const agoPhrase = (n) => (n === 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`);

// ── Sessions ──────────────────────────────────────────────────
// One flat list: quiz results and Echo sessions, each with its logical day,
// days ago, and kind (voca | cloze | gt | gs | echo).

function kindOfResult(r) {
  if (r.type === 'grammar') return r?.meta?.mode === 'selection' ? 'gs' : 'gt';
  return r.type === 'cloze' ? 'cloze' : r.type === 'voca' ? 'voca' : null;
}
const familyOf = (kind) => (kind === 'gt' || kind === 'gs' ? 'grammar' : kind);

function collectSessions(results, echoSessions, today, dsh) {
  const out = [];
  for (const r of results || []) {
    if (!r || !r.date) continue;
    const kind = kindOfResult(r);
    const day = logicalDay(r.date, dsh);
    if (!kind || !day) continue;
    const score = Number(r.score);
    out.push({ kind, family: familyOf(kind), day, ago: daysBetween(day, today), ts: r.date, score: isFinite(score) ? score : null, r });
  }
  for (const e of echoSessions || []) {
    const ts = e?.finishedAt || e?.startedAt;
    if (!ts) continue;
    const day = logicalDay(ts, dsh);
    if (!day) continue;
    out.push({ kind: 'echo', family: 'echo', day, ago: daysBetween(day, today), ts, score: null, e });
  }
  out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return out;
}

// Echo first-try totals for a set of sessions.
function echoFirstTry(sessions) {
  const t = { en2ko: { correct: 0, total: 0 }, ko2en: { correct: 0, total: 0 } };
  for (const s of sessions) {
    for (const dir of ['en2ko', 'ko2en']) {
      const f = s.e?.firstTry?.[dir];
      if (f && isFinite(f.correct) && isFinite(f.total)) { t[dir].correct += f.correct; t[dir].total += f.total; }
    }
  }
  return t;
}
const ftPct = (f) => (f.total ? (f.correct / f.total) * 100 : null);

// Dictation sessions (Echo X4, X-D17) are reported apart: their only first
// try is by ear, so they stay out of the two-way figures.
const isDictSession = (s) => s?.e?.kind === 'dictation';
function earFirstTry(sessions) {
  const t = { correct: 0, total: 0 };
  for (const s of sessions) {
    const f = s.e?.firstTry?.ear;
    if (f && isFinite(f.correct) && isFinite(f.total)) { t.correct += f.correct; t.total += f.total; }
  }
  return t;
}

// ── Analysis ──────────────────────────────────────────────────

function analyze({ results, echoSessions, grammarEntries, corpus, today, dsh }) {
  const all = collectSessions(results, echoSessions, today, dsh);
  const win   = all.filter(s => s.ago >= 0 && s.ago < QS_WINDOW_DAYS);
  const prior = all.filter(s => s.ago >= QS_WINDOW_DAYS && s.ago < QS_WINDOW_DAYS * 2);
  const scored = (list) => list.filter(s => s.score !== null);

  // Per kind
  const kinds = ['voca', 'echo', 'cloze', 'gt', 'gs'];
  const byKind = {};
  for (const k of kinds) {
    const w = win.filter(s => s.kind === k), p = prior.filter(s => s.kind === k);
    byKind[k] = {
      win: w, prior: p,
      avg: avg(scored(w).map(s => s.score)),
      priorAvg: avg(scored(p).map(s => s.score)),
    };
  }

  // Families gone quiet: used before, nothing for QUIET_DAYS+, while
  // something else ran more recently.
  const families = ['voca', 'echo', 'cloze', 'grammar'];
  const lastAgo = {};
  for (const f of families) {
    const last = [...all].reverse().find(s => s.family === f && s.ago >= 0);
    if (last) lastAgo[f] = last.ago;
  }
  const familiesUsed = families.filter(f => lastAgo[f] !== undefined);
  const latestAgo = familiesUsed.length ? Math.min(...familiesUsed.map(f => lastAgo[f])) : null;
  const quiet = familiesUsed
    .filter(f => lastAgo[f] >= QUIET_DAYS && lastAgo[f] > latestAgo)
    .sort((a, b) => lastAgo[b] - lastAgo[a]);

  // Streak of logical days with any session, ending today or yesterday.
  const days = new Set(all.map(s => s.day));
  let streak = 0;
  {
    const d = new Date(today + 'T00:00:00');
    if (!days.has(today)) d.setDate(d.getDate() - 1);
    while (days.has(toDateStr(d))) { streak++; d.setDate(d.getDate() - 1); }
  }

  // Vocabulary formats (meta.byType), this window and the one before.
  const formats = (list) => {
    const t = {};
    for (const s of list) {
      const bt = s.r?.meta?.byType;
      if (!bt || typeof bt !== 'object') continue;
      for (const [f, v] of Object.entries(bt)) {
        if (!FORMAT_LABEL[f] || !v || !isFinite(v.total)) continue;
        t[f] = t[f] || { correct: 0, total: 0 };
        t[f].correct += Number(v.correct) || 0; t[f].total += Number(v.total) || 0;
      }
    }
    const judged = Object.entries(t)
      .filter(([, v]) => v.total >= FORMAT_MIN_QUESTIONS)
      .map(([f, v]) => ({ f, pct: (v.correct / v.total) * 100 }))
      .sort((a, b) => a.pct - b.pct);
    if (judged.length < 2) return { judged, weak: null };
    const worst = judged[0], best = judged[judged.length - 1];
    return { judged, weak: best.pct - worst.pct >= FORMAT_GAP ? { worst, best } : null };
  };
  const fmt = formats(byKind.voca.win), fmtPrior = formats(byKind.voca.prior);
  const weakFormat = fmt.weak ? { ...fmt.weak, still: !!(fmtPrior.weak && fmtPrior.weak.worst.f === fmt.weak.worst.f) } : null;

  // Missed words across Vocabulary, Cloze and Echo (one count per session).
  const words = new Map();
  let wordTracked = false;
  for (const s of win) {
    let list = null;
    if (s.kind === 'voca' || s.kind === 'cloze') {
      if (Array.isArray(s.r?.meta?.missedTerms)) list = s.r.meta.missedTerms;
    } else if (s.kind === 'echo') {
      if (Array.isArray(s.e?.items)) list = s.e.items.filter(it => (it?.misses || 0) > 0).map(it => it.lemma);
    }
    if (!list) continue;
    wordTracked = true;
    const seen = new Set();
    for (const raw of list) {
      const key = normKey(raw);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const w = words.get(key) || { word: normWord(raw), count: 0, kinds: new Set(), lastTs: '' };
      w.count++; w.kinds.add(s.family); w.lastTs = s.ts;
      if (!/\s/.test(w.word) && /\s/.test(normWord(raw))) w.word = normWord(raw);   // show the spaced form
      words.set(key, w);
    }
  }
  const repeatWords = [...words.values()].filter(w => w.count >= 2)
    .sort((a, b) => b.count - a.count || b.lastTs.localeCompare(a.lastTs));

  // Grammar concepts: tested / missed per session, in order.
  const mastery = new Map();
  for (const c of corpus || []) if (c?.term) mastery.set(normWord(c.term), c.level || '');
  for (const g of grammarEntries || []) if (g?.glossaryTerm) mastery.set(normWord(g.glossaryTerm), g.masteryLevel || '');
  const concepts = new Map();
  let conceptTracked = false;
  for (const s of win) {
    if (s.family !== 'grammar') continue;
    const tested = s.r?.meta?.concepts;
    if (!Array.isArray(tested)) continue;
    conceptTracked = true;
    const missed = new Set((s.r.meta.missedConcepts || []).map(normWord));
    for (const raw of new Set(tested.map(normWord))) {
      if (!raw) continue;
      const c = concepts.get(raw) || { term: raw, tested: 0, missed: 0, events: [] };
      c.tested++;
      const ok = !missed.has(raw);
      if (!ok) c.missed++;
      c.events.push({ ok, day: s.day });
      concepts.set(raw, c);
    }
  }
  const conceptList = [...concepts.values()];
  const repeatConcepts = conceptList.filter(c => c.missed >= 2).sort((a, b) => b.missed - a.missed || b.tested - a.tested);
  const masteredMissed = conceptList
    .filter(c => c.missed >= 1 && mastery.get(c.term) === 'mastered')
    .sort((a, b) => b.missed - a.missed);
  const recovered = conceptList
    .map(c => {
      const lastMiss = c.events.map(e => !e.ok).lastIndexOf(true);
      const last = c.events[c.events.length - 1];
      return lastMiss >= 0 && last.ok && lastMiss < c.events.length - 1
        ? { term: c.term, missDay: c.events[lastMiss].day, cleanDay: last.day } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.cleanDay.localeCompare(a.cleanDay));

  // Echo
  const echoWin = byKind.echo.win;
  const echoTwoWay = echoWin.filter(s => !isDictSession(s));
  const echoDict = echoWin.filter(isDictSession);
  const echoFT = echoFirstTry(echoTwoWay);
  const earFT = earFirstTry(echoDict);
  // Words still unresolved the last time Echo saw them.
  const lastSeen = new Map();
  for (const s of echoWin) {
    for (const it of s.e?.items || []) {
      const key = normKey(it?.lemma);
      if (key) lastSeen.set(key, { word: normWord(it.lemma), resolved: !!it.resolved, dict: isDictSession(s) });
    }
  }
  const unresolvedSeen = [...lastSeen.values()].filter(x => !x.resolved);
  const echoUnresolved = unresolvedSeen.map(x => x.word);
  const unresolvedBy = unresolvedSeen.every(x => x.dict) ? 'ear' : unresolvedSeen.some(x => x.dict) ? 'mixed' : 'both';

  // Milestone crossed in the window (sessions of every kind).
  const total = all.length;
  const before = total - win.length;
  const milestone = [...MILESTONES].reverse().find(m => m > before && m <= total) || null;

  const scoredWin = scored(win), scoredPrior = scored(prior);
  return {
    all, win, prior, byKind, quiet, lastAgo, familiesUsed, streak, latestAgo,
    fmt, weakFormat, words, wordTracked, repeatWords,
    conceptTracked, conceptList, repeatConcepts, masteredMissed, recovered,
    echoWin, echoTwoWay, echoDict, echoFT, earFT, echoUnresolved, unresolvedBy, milestone, total,
    winAvg: avg(scoredWin.map(s => s.score)), priorAvg: avg(scoredPrior.map(s => s.score)),
    scoredWin, scoredPrior,
  };
}

// ── Paragraphs ────────────────────────────────────────────────

function activityParagraph(a) {
  const n = a.win.length, p = a.prior.length;
  const out = [];
  const opening = n <= 20 ? `${cap(numWord(n))} ${plural(n, 'quiz', 'quizzes')} in the last ${QS_WINDOW_DAYS} days`
                          : `The last ${QS_WINDOW_DAYS} days brought ${n} quizzes`;
  let cmp;
  if (p === n) cmp = `the same number as the ${QS_WINDOW_DAYS} days before`;
  else if (p === 0) cmp = a.all.length === n ? 'the first on record' : `after none at all in the ${QS_WINDOW_DAYS} days before`;
  else cmp = `${num(Math.abs(n - p))} ${n > p ? 'more' : 'fewer'} than the ${QS_WINDOW_DAYS} days before`;
  out.push(`${opening}, ${cmp}.`);

  // The split across quizzes. Grammar is one family with two kinds.
  const fam = ['voca', 'echo', 'cloze', 'grammar']
    .map(f => ({ f, n: a.win.filter(s => s.family === f).length }))
    .filter(x => x.n > 0)
    .sort((x, y) => y.n - x.n);
  const gt = a.byKind.gt.win.length, gs = a.byKind.gs.win.length;
  const grammarNote = gt && gs ? ` (${num(gt)} Translation, ${num(gs)} Selection)` : '';
  const echoN = a.echoWin.length, dictN = a.echoDict.length;
  const echoNote = dictN ? (dictN === echoN ? ' (all Dictation)' : ` (${num(dictN)} Dictation)`) : '';
  const note = (f) => (f === 'grammar' ? grammarNote : f === 'echo' ? echoNote : '');
  const ran = (x) => `${KIND_LABEL[x.f]} ${times(x.n)}${note(x.f)}`;
  const ranFirst = (list) => list.map((x, i) => (i === 0 ? `${KIND_LABEL[x.f]} ran ${times(x.n)}${note(x.f)}` : ran(x)));
  if (fam.length === 1) {
    const only = fam[0];
    const what = only.f === 'grammar'
      ? (gt && gs ? `Grammar${grammarNote}` : gs ? 'Grammar Selection' : 'Grammar Translation')
      : only.f === 'echo'
        ? (dictN === echoN ? 'Dictation' : `Echo${echoNote}`)
        : KIND_LABEL[only.f];
    out.push(n === 1 ? `It was ${/^[AEIOU]/.test(what) ? 'an' : 'a'} ${what} session.` : n === 2 ? `Both were ${what}.` : `All ${num(n)} were ${what}.`);
  } else if (fam.length > 1) {
    const [top, ...rest] = fam;
    if (top.n * 2 > n && top.n >= 3) {
      out.push(`${KIND_LABEL[top.f]} carried most of the load with ${num(top.n)} sessions; ${andList(ranFirst(rest))}.`);
    } else if (fam.every(x => x.n === top.n)) {
      out.push(`${andList(fam.map(x => KIND_LABEL[x.f]))} ran ${times(top.n)} each${grammarNote ? `, Grammar${grammarNote}` : ''}.`);
    } else {
      out.push(`${andList(ranFirst(fam))}.`);
    }
  }

  // Gone quiet, or nothing has.
  if (a.quiet.length === 1) {
    const f = a.quiet[0];
    out.push(`${KIND_LABEL[f]} hasn't run in ${a.lastAgo[f]} days.`);
  } else if (a.quiet.length > 1) {
    out.push(`${andList(a.quiet.map(f => KIND_LABEL[f]))} have gone quiet, at ${andList(a.quiet.map(f => String(a.lastAgo[f])))} days since their last sessions.`);
  } else if (a.familiesUsed.length >= 2 && n > 0) {
    out.push('Nothing has gone quiet.');
  }

  // Streak, or how long since the last one.
  if (a.streak >= 2) out.push(`A ${numWord(a.streak)}-day quiz streak is going.`);
  else if (a.latestAgo !== null && a.latestAgo >= 2) out.push(`The last quiz was ${agoPhrase(a.latestAgo)}.`);

  // Running total and milestone.
  if (a.milestone) out.push(`Somewhere in there came quiz number ${a.milestone}; the total on record now stands at ${a.total}.`);
  else if (a.total > n) out.push(`That brings the total on record to ${num(a.total)}.`);
  return out.join(' ');
}

function scoresParagraph(a, today) {
  const out = [];
  // Clauses: { text, dir } — dir is +1 climbed, -1 slipped, 0 steady/new.
  const clauses = [];
  let newCount = 0;
  for (const k of ['voca', 'cloze', 'gt', 'gs']) {
    const b = a.byKind[k];
    if (b.avg === null) continue;
    const label = KIND_LABEL[k];
    const sessions = b.win.filter(s => s.score !== null).length;
    if (b.priorAvg === null) {
      const verb = newCount++ === 0 ? 'came in at' : 'averaged';
      clauses.push({ text: `${label} ${verb} ${pct(b.avg)}${sessions > 1 ? ` over ${num(sessions)} sessions` : ''}`, dir: 0 });
    } else {
      const d = Math.round(b.avg) - Math.round(b.priorAvg);
      if (Math.abs(d) < STEADY_POINTS) clauses.push({ text: `${label} held steady at ${pct(b.avg)}`, dir: 0 });
      else clauses.push({ text: `${label} ${d > 0 ? 'climbed' : 'slipped'} to ${pct(b.avg)} from ${pct(b.priorAvg)}`, dir: d > 0 ? 1 : -1 });
    }
  }
  // Two clauses to a sentence; "while" only when they pull different ways.
  for (let i = 0; i < clauses.length; i += 2) {
    const x = clauses[i], y = clauses[i + 1];
    if (!y) { out.push(`${x.text}.`); continue; }
    const contrast = x.dir !== y.dir && (x.dir !== 0 || y.dir !== 0);
    out.push(`${x.text}, ${contrast ? 'while' : 'and'} ${y.text}.`);
  }

  // Vocabulary formats.
  if (a.weakFormat) {
    const { worst, best, still } = a.weakFormat;
    out.push(`Inside the Vocabulary sessions, ${FORMAT_LABEL[worst.f]} ${still ? 'still lag' : 'lag'} at ${pct(worst.pct)}, against ${pct(best.pct)} on ${FORMAT_LABEL[best.f]}.`);
  } else if (a.fmt.judged.length >= 2) {
    const lo = a.fmt.judged[0], hi = a.fmt.judged[a.fmt.judged.length - 1];
    out.push(`Vocabulary formats are running close together, from ${pct(lo.pct)} on ${FORMAT_LABEL[lo.f]} to ${pct(hi.pct)} on ${FORMAT_LABEL[hi.f]}.`);
  }

  // Perfect scores, or the best session.
  const perfect = a.scoredWin.filter(s => s.score >= 100);
  if (perfect.length >= 2) out.push(`${cap(numWord(perfect.length))} sessions came back perfect.`);
  else if (perfect.length === 1) out.push(`One session came back perfect: ${KIND_LABEL[perfect[0].kind]}, ${whenPhrase(perfect[0].day, today)}.`);
  else if (a.scoredWin.length >= 3) {
    const best = [...a.scoredWin].sort((x, y) => y.score - x.score || y.ts.localeCompare(x.ts))[0];
    out.push(`The best was ${/^[AEIOU]/.test(KIND_LABEL[best.kind]) ? 'an' : 'a'} ${KIND_LABEL[best.kind]} session at ${pct(best.score)}, ${whenPhrase(best.day, today)}.`);
  }
  return out.join(' ');
}

function familyNames(set) {
  const order = ['voca', 'cloze', 'echo'];
  return andList(order.filter(f => set.has(f)).map(f => KIND_LABEL[f]));
}

function troubleParagraph(a, today) {
  const out = [];
  // Words
  if (a.repeatWords.length) {
    const top = a.repeatWords.slice(0, 3);
    const more = a.repeatWords.length - top.length;
    const head = (w) => `${w.word}${w.count >= 3 ? ` ${times(w.count)}` : ''}${w.kinds.size > 1 ? `, across ${familyNames(w.kinds)}` : ` in ${familyNames(w.kinds)}`}`;
    if (a.repeatWords.length === 1) {
      out.push(`One word has been missed more than once in the last ${QS_WINDOW_DAYS} days: ${top[0].word}, ${times(top[0].count)}${top[0].kinds.size > 1 ? ` across ${familyNames(top[0].kinds)}` : ` in ${familyNames(top[0].kinds)}`}.`);
    } else {
      const rest = top.slice(1).map(w => w.word);
      out.push(`${cap(numWord(a.repeatWords.length))} words have been missed more than once in the last ${QS_WINDOW_DAYS} days: ${head(top[0])}, then ${andList(rest)}${more > 0 ? `, plus ${num(more)} more` : ''}.`);
    }
  } else if (a.words.size > 0) {
    out.push(`${cap(numWord(a.words.size))} different ${plural(a.words.size, 'word was', 'words were')} missed in the last ${QS_WINDOW_DAYS} days, none of them more than once.`);
  } else if (a.wordTracked) {
    out.push(`No word was missed in the last ${QS_WINDOW_DAYS} days.`);
  }

  // Grammar concepts
  const named = new Set();
  if (a.repeatConcepts.length) {
    const c = a.repeatConcepts[0];
    named.add(c.term);
    const how = c.missed === c.tested
      ? (c.tested === 2 ? 'in both sessions that tested it' : `in all ${num(c.tested)} sessions that tested it`)
      : `in ${num(c.missed)} of the ${num(c.tested)} sessions that tested it`;
    const extra = a.repeatConcepts[1] ? `, and ${a.repeatConcepts[1].term} has repeated as well` : '';
    if (a.repeatConcepts[1]) named.add(a.repeatConcepts[1].term);
    out.push(`On the grammar side, ${c.term} was missed ${how}${extra}.`);
  }
  // Cross-reference: a missed concept the Grammar Index calls Mastered.
  const mm = a.masteredMissed[0];
  if (mm) {
    if (named.has(mm.term)) {
      const subject = named.size === 1 ? 'It' : mm.term;
      out.push(`${subject} is marked Mastered in the Grammar Index, so it may be worth a fresh look.`);
    } else {
      const missedWhen = mm.missed === 1
        ? whenPhrase(mm.events.find(e => !e.ok).day, today)
        : `${times(mm.missed)} in the last ${QS_WINDOW_DAYS} days`;
      out.push(`${named.size ? '' : 'On the grammar side, '}${mm.term} is marked Mastered in the Grammar Index, but was missed ${missedWhen}.`);
    }
    named.add(mm.term);
  }
  const rec = a.recovered.find(r => !named.has(r.term));
  if (rec) {
    out.push(`${named.size ? 'Meanwhile, ' : 'On the grammar side, '}${rec.term}, missed ${whenPhrase(rec.missDay, today)}, came back clean ${whenPhrase(rec.cleanDay, today)}.`);
  }
  if (!named.size && !rec && a.conceptTracked && a.conceptList.length) {
    out.push(`Every grammar concept tested in the last ${QS_WINDOW_DAYS} days came through clean: ${num(a.conceptList.length)} in all.`);
  }
  return out.join(' ');
}

function echoParagraph(a) {
  const s = a.echoTwoWay;
  if (!a.echoWin.length) return '';
  const out = [];
  if (s.length) {
    const words = s.reduce((n, x) => n + (Number(x.e?.itemCount) || 0), 0);
    const rounds = s.reduce((n, x) => n + (Number(x.e?.roundsPlayed) || 0), 0);
    if (s.length === 1) {
      const e = s[0].e || {};
      const w = Number(e.itemCount) || 0, r = Number(e.roundsPlayed) || 0;
      const unresolved = (e.unresolved || []).length;
      const roundsTxt = `${num(r)} ${plural(r, 'round')}`;
      switch (e.endReason) {
        case 'complete': out.push(`The one Echo session ran ${num(w)} words until every one was right both ways, in ${roundsTxt}.`); break;
        case 'cap':      out.push(`The one Echo session stopped at the ${r}-round cap with ${num(unresolved)} of its ${num(w)} words still unresolved.`); break;
        case 'ended':    out.push(`The one Echo session, ${num(w)} words, was ended early after ${roundsTxt}.`); break;
        default:         out.push(`The one Echo session ran ${num(w)} words through ${roundsTxt}.`);
      }
    } else {
      out.push(`${cap(numWord(s.length))} Echo sessions covered ${num(words)} words over ${num(rounds)} rounds.`);
      const ended = s.filter(x => x.e?.endReason === 'ended').length;
      const capped = s.filter(x => x.e?.endReason === 'cap').length;
      const notes = [];
      if (capped) notes.push(`${num(capped)} stopped at the 10-round cap`);
      if (ended) notes.push(`${num(ended)} ${plural(ended, 'was', 'were')} ended early`);
      if (notes.length) out.push(`${cap(andList(notes))}.`);
    }
    const ko = ftPct(a.echoFT.en2ko), en = ftPct(a.echoFT.ko2en);
    const overrides = s.reduce((n, x) => n + (Number(x.e?.overrideCount) || 0), 0);
    if (ko !== null || en !== null) {
      const parts = [];
      if (ko !== null) parts.push(`${pct(ko)} writing Korean`);
      if (en !== null) parts.push(`${pct(en)} writing meanings`);
      const byHand = overrides ? `, with ${num(overrides)} ${plural(overrides, 'answer')} marked right by hand` : '';
      out.push(`First-try accuracy was ${andList(parts)}${byHand}.`);
    }
  }
  // Dictation, reported apart (X-D17).
  const d = a.echoDict;
  if (d.length) {
    if (d.length === 1) {
      const e = d[0].e || {};
      const w = Number(e.itemCount) || 0, r = Number(e.roundsPlayed) || 0;
      const roundsTxt = `${num(r)} ${plural(r, 'round')}`;
      const lead = 'The one Dictation session';
      switch (e.endReason) {
        case 'complete': out.push(`${lead} ran ${num(w)} words until every one was right by ear, in ${roundsTxt}.`); break;
        case 'cap':      out.push(`${lead} stopped at the ${r}-round cap with ${num((e.unresolved || []).length)} of its ${num(w)} words still unresolved.`); break;
        case 'ended':    out.push(`${lead}, ${num(w)} words, was ended early after ${roundsTxt}.`); break;
        default:         out.push(`${lead} ran ${num(w)} words through ${roundsTxt}.`);
      }
    } else {
      const dw = d.reduce((n, x) => n + (Number(x.e?.itemCount) || 0), 0);
      const dr = d.reduce((n, x) => n + (Number(x.e?.roundsPlayed) || 0), 0);
      out.push(`${cap(numWord(d.length))} Dictation sessions covered ${num(dw)} words over ${num(dr)} rounds.`);
    }
    const ear = ftPct(a.earFT);
    if (ear !== null) out.push(`${pct(ear)} of the words were right by ear on the first try.`);
  }
  if (a.echoUnresolved.length) {
    const named = a.echoUnresolved.slice(0, 2);
    const more = a.echoUnresolved.length - named.length;
    const how = a.unresolvedBy === 'ear' ? 'right by ear' : a.unresolvedBy === 'mixed' ? 'right' : 'right both ways';
    out.push(`${andList(named)}${more ? ` and ${num(more)} more` : ''} ${a.echoUnresolved.length === 1 ? 'is' : 'are'} still waiting to come out ${how}.`);
  }
  return out.join(' ');
}

// All-time standing, for a 30-day window with nothing in it.
function standingParagraph(a) {
  const out = [];
  const parts = [];
  for (const k of ['voca', 'cloze', 'gt', 'gs']) {
    const list = a.all.filter(s => s.kind === k && s.score !== null);
    if (list.length) parts.push(`${KIND_LABEL[k]} averages ${pct(avg(list.map(s => s.score)))} over ${num(list.length)} ${plural(list.length, 'session')}`);
  }
  if (parts.length) out.push(`On the all-time books, ${andList(parts)}.`);
  const echoAll = a.all.filter(s => s.kind === 'echo');
  if (echoAll.length) {
    const ft = echoFirstTry(echoAll.filter(x => !isDictSession(x)));
    const ko = ftPct(ft.en2ko), en = ftPct(ft.ko2en);
    const ear = ftPct(earFirstTry(echoAll.filter(isDictSession)));
    const acc = [ko !== null ? `${pct(ko)} writing Korean` : null, en !== null ? `${pct(en)} writing meanings` : null, ear !== null ? `${pct(ear)} by ear` : null].filter(Boolean);
    out.push(`Echo has ${num(echoAll.length)} ${plural(echoAll.length, 'session')} on file${acc.length ? `, with first-try accuracy of ${andList(acc)}` : ''}.`);
  }
  return out.join(' ');
}

// ── Headline ──────────────────────────────────────────────────

function finding(a) {
  if (a.quiet.length) return `${andList(a.quiet.map(f => KIND_LABEL[f]))} Gone Quiet`;
  const topWord = a.repeatWords[0];
  if (topWord && topWord.count >= 3) return `${topWord.word} Keeps Coming Back`;
  if (a.weakFormat) return `${FORMAT_HEAD[a.weakFormat.worst.f]} ${a.weakFormat.still ? 'Still ' : ''}the Weak Spot`;
  for (const k of ['voca', 'cloze', 'gt', 'gs']) {
    const b = a.byKind[k];
    if (b.avg === null || b.priorAvg === null) continue;
    if (b.win.filter(s => s.score !== null).length < 2 || b.prior.filter(s => s.score !== null).length < 2) continue;
    const d = Math.round(b.avg) - Math.round(b.priorAvg);
    if (Math.abs(d) >= HEADLINE_TYPE_MOVE) return `${KIND_LABEL[k]} Scores ${d > 0 ? 'on the Rise' : 'Slipping'}`;
  }
  if (topWord) return `${topWord.word} Missed Twice`;
  if (a.masteredMissed.length) return `${a.masteredMissed[0].term} Slips Despite Mastered Status`;
  if (a.winAvg !== null && a.priorAvg !== null) {
    const d = Math.round(a.winAvg) - Math.round(a.priorAvg);
    if (Math.abs(d) >= HEADLINE_OVERALL_MOVE) return `Scores ${d > 0 ? 'Up' : 'Down'} ${Math.abs(d)} Points`;
  }
  if (a.recovered.length) return `${a.recovered[0].term} Back on Track`;
  const ko = ftPct(a.echoFT.en2ko), en = ftPct(a.echoFT.ko2en);
  if (ko !== null && en !== null && ko >= ECHO_CLEAN && en >= ECHO_CLEAN) return 'Echo Runs Clean Both Ways';
  if (a.milestone) return `Quiz ${a.milestone} on the Books`;
  if (a.winAvg !== null) return `Averaging ${pct(a.winAvg)}`;
  return 'A Steady Stretch';
}

function standfirst(a) {
  if (a.winAvg !== null) {
    let tail = '';
    if (a.priorAvg !== null) {
      const d = Math.round(a.winAvg) - Math.round(a.priorAvg);
      tail = d === 0 ? `, level with the ${QS_WINDOW_DAYS} days before`
                     : `, ${d > 0 ? 'up' : 'down'} ${Math.abs(d)} ${plural(Math.abs(d), 'point')} on the ${QS_WINDOW_DAYS} days before`;
    }
    return `${pct(a.winAvg)} average over ${QS_WINDOW_DAYS} days${tail}.`;
  }
  const ko = ftPct(a.echoFT.en2ko), en = ftPct(a.echoFT.ko2en);
  if (ko !== null || en !== null) {
    const all = (a.echoFT.en2ko.correct + a.echoFT.ko2en.correct) / (a.echoFT.en2ko.total + a.echoFT.ko2en.total) * 100;
    return `${pct(all)} first-try accuracy across ${num(a.echoTwoWay.length)} Echo ${plural(a.echoTwoWay.length, 'session')}.`;
  }
  const ear = ftPct(a.earFT);
  if (ear !== null) return `${pct(ear)} right by ear on the first try across ${num(a.echoDict.length)} Dictation ${plural(a.echoDict.length, 'session')}.`;
  return '';
}

// ── Public ────────────────────────────────────────────────────

/**
 * Returns { kicker, headline, standfirst, paragraphs, leadParagraph, teaser }.
 * `leadParagraph` is `paragraphs` (DropCapLead takes an array); `teaser` is
 * the first paragraph for the Quizzes home screen.
 */
export function getQuizStateReport({ results = [], echoSessions = [], grammarEntries = [], corpus = [], today, dsh = 3 } = {}) {
  const todayStr = today || toDateStr(new Date());
  const kicker = 'The State of Quizzes';
  const a = analyze({ results, echoSessions, grammarEntries, corpus, today: todayStr, dsh });

  if (a.all.length === 0) {
    const p = 'No quizzes have been taken yet. Once a few are on the books, this report will track how often each quiz runs, how scores are moving, which words and grammar points keep slipping, and how Echo sessions are going.';
    return { kicker, headline: 'No Quizzes Yet', standfirst: '', paragraphs: [p], leadParagraph: [p], teaser: p };
  }

  if (a.win.length === 0) {
    const last = a.all[a.all.length - 1];
    const lastTxt = last.kind === 'echo'
      ? `an Echo session ${agoPhrase(last.ago)}`
      : `${/^[AEIOU]/.test(KIND_LABEL[last.kind]) ? 'an' : 'a'} ${KIND_LABEL[last.kind]} session ${agoPhrase(last.ago)}, scoring ${pct(last.score ?? 0)}`;
    const scoredAll = a.all.filter(s => s.score !== null);
    const p1 = [`No quizzes in the last ${QS_WINDOW_DAYS} days. The last one was ${lastTxt}.`];
    p1.push(scoredAll.length
      ? `${cap(numWord(a.all.length))} ${plural(a.all.length, 'quiz', 'quizzes')} on record, averaging ${pct(avg(scoredAll.map(s => s.score)))} where scored.`
      : `${cap(numWord(a.all.length))} ${plural(a.all.length, 'session')} on record.`);
    const p2 = standingParagraph(a) || 'Pick any quiz to get the report moving again.';
    const paragraphs = [p1.join(' '), p2];
    return {
      kicker, headline: `No Quizzes in ${QS_WINDOW_DAYS} Days`,
      standfirst: `The last one was ${agoPhrase(last.ago)}.`,
      paragraphs, leadParagraph: paragraphs, teaser: paragraphs[0],
    };
  }

  const n = a.win.length;
  const headline = `${titleCase(numWord(n))} ${n === 1 ? 'Session' : 'Sessions'} in ${QS_WINDOW_DAYS} Days, ${finding(a)}`;
  const paragraphs = [activityParagraph(a), scoresParagraph(a, todayStr), troubleParagraph(a, todayStr), echoParagraph(a)]
    .filter(Boolean);
  if (paragraphs.length < 2) paragraphs.push(standingParagraph(a) || 'More sessions will fill in the score trends and trouble spots here.');
  return {
    kicker, headline, standfirst: standfirst(a),
    paragraphs, leadParagraph: paragraphs, teaser: paragraphs[0],
  };
}
