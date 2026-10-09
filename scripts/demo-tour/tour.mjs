// scripts/demo-tour/tour.mjs
// Records a captioned video walkthrough of the hosted AutoVocaIndex demo.
//
// It drives the real demo in a browser: enters the sandbox, visits each
// area, and runs one pasted sentence through to graded flashcards and a
// finished quiz. Captions, a cursor dot and the logo cards are drawn on the
// page so viewers can follow along. Re-run it after each template update so
// the video always matches the current app.
//
// The demo is opened with ?tour, which makes Today and Flashcards show a
// sample review forecast (see DEMO_TOUR in src/demo/demoConfig.js): the
// demo's own sample cards are too few to fill those widgets.
//
// Each run uses one fresh demo account (about 80 database writes on the
// demo's free plan), the same as one visitor.
//
// Usage (from this folder):
//   npm install
//   npx playwright install chromium
//   node tour.mjs --headed      watch it run in a visible window
//   node tour.mjs               record the video (also works with --headed)
//
// Options:
//   --url <address>   demo address (default https://autovocaindex.netlify.app)
//   --pace <number>   timing multiplier; 1.3 is slower, 0.8 is faster (default 1)
//   --out <folder>    where recordings go (default output); each run gets
//                     its own dated subfolder with the video, chapters, log
//                     and any failure screenshots
//
// Caption timing: each caption stays up for its listed minimum or for its
// reading time (3 words per second), whichever is longer. Time spent on
// actions while a caption is showing counts toward it.
//
// Each scene runs on its own. If a step can't find what it's looking for,
// the scene is logged as failed with a screenshot, and the tour moves on.

import { chromium } from 'playwright';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const DEMO_URL = value('url', 'https://autovocaindex.netlify.app');
const PACE     = Number(value('pace', '1')) || 1;
const OUT_BASE = path.resolve(value('out', 'output'));
// One folder per run, named with the local date and time (e.g. 2026-10-07_0215),
// so a new recording never replaces an earlier one.
const p2 = n => String(n).padStart(2, '0');
const now = new Date();
const STAMP = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}_${p2(now.getHours())}${p2(now.getMinutes())}`;
const OUT = path.join(OUT_BASE, STAMP);
const HEADED   = flag('headed');
const WIDTH = 1920, HEIGHT = 1080;  // 16:9 fills YouTube's player; wide enough for the full sidebar (1340px+)

const READ_WORDS_PER_SEC = 3;       // comfortable caption reading speed
const MIN_SCENE_MS = 10500;         // YouTube chapters must be at least 10 seconds long
const OPENING_BG = '#1a1613';       // shown under the opening logo before the app paints

// The sentence the tour adds, the words it picks, and the short definitions
// it writes for them. Neither word is in the demo's sample data, so the
// new-word dialog appears.
const SENTENCE = '요즘 날씨가 좋아서 매일 공원에서 산책해요.';
const PICKS = [
  { pill: /^날씨가[.,!?]?$/,  term: '날씨', lemma: '날씨',     def2: 'weather' },
  { pill: /^산책해요[.,!?]?$/, term: '산책', lemma: '산책하다', def2: 'to take a walk' },
];

// Theme order in the Appearance panel. The closing scene starts after the
// demo's default (Hanok Dusk) and wraps around to end on it again.
// Front/back pairs of the vocabulary cards the quiz can ask about: the demo's
// sample cards (read from the template's own seed file) plus the tour's two
// new words. Used to pick quiz answers on purpose rather than at random.
async function loadCardPairs() {
  const pairs = PICKS.map(p => ({ front: p.lemma, back: p.def2 }));
  try {
    const seed = JSON.parse(await readFile(new URL('../../src/demo/demoSeed.json', import.meta.url), 'utf8'));
    for (const c of seed.flashcards || []) {
      const d = c.data || c;
      if (d.type === 'vocab' && d.front && d.back) pairs.push({ front: d.front, back: d.back });
    }
  } catch { /* seed file not found: answers fall back to the first choice */ }
  return pairs;
}

const THEMES = ['Ember', 'Clay', 'Baroque', 'Koi Rush', 'Feather', 'Hanok Dusk', 'Bauhaus Sun', 'Blossom Mist'];
const START_THEME = 'Hanok Dusk';

// ── Captions (edit wording here) ──────────────────────────────
const CAP = {
  opening:      'AutoVocaIndex: a self-hosted Korean study system built around the material you read and watch. It keeps all your sources and the words you learn from them neatly indexed and connected, and includes multiple practice methods.',
  sandbox:      'This is the public demo, a sandbox with a small sample data set that resets nightly.',
  today:        'Today is where your tasks for the day appear. If you have flashcard reviews due today, a progress bar will show how many you have left.',
  appts:        'Appointments is where you can keep track of classes or tutoring sessions.',
  apptLinks:    "An appointment can be linked to sources you're studying and your own notes.",
  clFront:      'The Content Library catalogs everything you study from (books, shows, podcasts, etc) and reports on it like the front page of a newspaper.',
  clScroll:     'Activity, sources that have gone inactive, and what is queued up next are all organized here, along with statistics.',
  clLibrary:    "The Library tab is the catalogue of all sources you're working on and your TBR list, separated by category. Each source holds a record of its sections, linked to grammatical concepts and your own notes.",
  clNotes:      "Your notes can be recorded and tagged in the Notes tab even if they're not connected to a source. You can separate questions you have and writing practice you've had corrected.",
  clArchive:    "The Archive tab is where you send sources you've completed or decided you don't want to continue without losing your records for them. The format mirrors the Library tab.",
  avi:          'AutoVocaIndex (AVI) is the vocabulary engine and index. Every word is tied to the source(s) where you found it.',
  aviStats:     'The main tab shows your stats by source and over time.',
  aviWays:      'There are 3 ways to enter new words: Import, Word Input, and Sentence Input.',
  pickSource:   'Pick the source you are studying…',
  paste:        '…type or paste a sentence from it…',
  pickWords:    '…and click the words you want to learn.',
  resolve:      'AVI resolves each word to its dictionary form, stripping particles and verb endings. You can correct it if needed.',
  define:       'Definitions arrive from the national Korean dictionary (KRDict). Add your own short definition: that is what your flashcard will show.',
  entries:      "Each word becomes an entry with its source(s), a dictionary record, and a flashcard, created automatically. Since these entries are from a full sentence, they'll get a flashcard for the individual word and a card for the word in context.",
  lemmaMaster:  'Lemma Master keeps one entry per word, however many times and places you encounter it. Updating the definition updates the flashcard for every source the word appears in, so your cards will always be in agreement.',
  flashcards:   'Flashcards are scheduled with FSRS, and each source gets its own deck(s). Sources with sentence entries get a word deck and a sentence deck.',
  recall1:      'Here are the two new cards. Recall the meaning, then reveal…',
  grade1:       '…and grade how well you remembered it. FSRS sets the next review.',
  recall2:      'Recall, reveal…',
  grade2:       '…and grade.',
  pauseDeck:    "If you want to take a break from studying a deck, click Pause. That deck's due cards will no longer count toward your Due Today total.",
  spike:        'You can even set a threshold in Settings to warn you about review-dense days ahead of time. The warning will show here and on Today.',
  quizzes:      'Quizzes draw on the same entries we added in AVI. Choose from vocabulary or cloze drills. You can also try AI-graded grammar drills (not available in demo).',
  quizAnswer:   'Pick an answer. Feedback is instant, with the right answer highlighted. (Instant Feedback can be turned off in the quiz settings.)',
  quizScores:   'Quiz scores are recorded so you can see your progress over time.',
  grammar:      'The Grammar Index documents patterns, with explanations, examples, mastery levels, and links to where you saw them.',
  grammarDeck:  'Your entries here supply the Grammar Deck in Flashcards so you can test your recall of the concepts. You can even tag similar concepts to compare the nuances.',
  closing:      'AutoVocaIndex is free and self-hosted (MIT license). Try the demo, or set up your own. All documentation, including a setup guide, can be found at: github.com/AlmostAnOptimist/AutoVocaIndex',
};

// ── On-page overlay: caption bar, cursor dot, logo card ───────
// Installed into every page load. Appended to <html>, outside the React
// root, so app re-renders never remove it.
function installOverlay({ openingLogo, openingBg }) {
  if (window.__tour || location.protocol === 'about:') return;
  const Z = '2147483647';
  const ensure = () => {
    if (document.getElementById('__tour_cap')) return;
    const cap = document.createElement('div');
    cap.id = '__tour_cap';
    Object.assign(cap.style, {
      position: 'fixed', left: '50%', bottom: '40px', transform: 'translateX(-50%)',
      maxWidth: '64%', padding: '16px 30px', borderRadius: '14px',
      background: 'rgba(22, 19, 16, 0.88)', color: '#f4efe6',
      font: '500 24px/1.45 system-ui, -apple-system, "Segoe UI", "Malgun Gothic", sans-serif',
      textAlign: 'center', zIndex: Z, opacity: '0',
      transition: 'opacity 0.35s ease', pointerEvents: 'none',
      boxShadow: '0 6px 30px rgba(0, 0, 0, 0.35)',
    });
    const dot = document.createElement('div');
    dot.id = '__tour_dot';
    Object.assign(dot.style, {
      position: 'fixed', left: '-40px', top: '-40px', width: '26px', height: '26px',
      margin: '-13px 0 0 -13px', borderRadius: '50%',
      background: 'rgba(255, 186, 84, 0.55)', border: '2px solid rgba(255, 255, 255, 0.95)',
      boxShadow: '0 0 0 2px rgba(0, 0, 0, 0.25)', zIndex: Z,
      pointerEvents: 'none', opacity: '0',
      transition: 'left 0.55s ease, top 0.55s ease, transform 0.15s ease, opacity 0.3s',
    });
    // Logo card: the app's own logo file (public/favicon.svg) on the page
    // background, sized to fill the frame above the caption bar.
    const logo = document.createElement('div');
    logo.id = '__tour_logo';
    Object.assign(logo.style, {
      position: 'fixed', inset: '0', zIndex: '2147483646', background: openingBg,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '4vh',
      opacity: openingLogo ? '1' : '0', transition: 'opacity 0.6s ease', pointerEvents: 'none',
    });
    const img = document.createElement('img');
    img.src = '/favicon.svg';
    Object.assign(img.style, { height: '80vh', width: '80vh', borderRadius: '11.2vh' });
    logo.append(img);
    // Chapter marker: a tiny red square in the top-left corner, flashed briefly
    // at each scene start and found in the finished
    // video to time the chapters.
    const mark = document.createElement('div');
    mark.id = '__tour_mark';
    Object.assign(mark.style, {
      position: 'fixed', left: '0', top: '0', width: '6px', height: '6px',
      background: '#ff0000', zIndex: Z, display: 'none', pointerEvents: 'none',
    });
    document.documentElement.append(logo, cap, dot, mark);
  };
  const pageBackground = () => {
    for (const el of [document.querySelector('#root > *'), document.body, document.documentElement]) {
      if (!el) continue;
      const bg = getComputedStyle(el).backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
    }
    return null;
  };
  window.__tour = {
    caption(text) {
      ensure();
      const cap = document.getElementById('__tour_cap');
      if (!text) { cap.style.opacity = '0'; return; }
      cap.textContent = text;
      cap.style.opacity = '1';
    },
    mark(ms) {
      ensure();
      const el = document.getElementById('__tour_mark');
      el.style.display = 'block';
      setTimeout(() => { el.style.display = 'none'; }, ms);
      // Resolve once the marker has been painted, before the scene's first action.
      return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    },
    logo(show) {
      ensure();
      const el = document.getElementById('__tour_logo');
      if (show) el.style.background = pageBackground() || el.style.background;
      el.style.opacity = show ? '1' : '0';
    },
    move(x, y) {
      ensure();
      const dot = document.getElementById('__tour_dot');
      dot.style.opacity = '1';
      dot.style.left = `${x}px`;
      dot.style.top = `${y}px`;
    },
    press() {
      const dot = document.getElementById('__tour_dot');
      if (!dot) return;
      dot.style.transform = 'scale(0.65)';
      setTimeout(() => { dot.style.transform = 'scale(1)'; }, 170);
    },
    // Moves the dot around an ellipse `loops` times, starting and ending at
    // the leftmost point.
    circle(cx, cy, rx, ry, loops, loopMs) {
      ensure();
      const dot = document.getElementById('__tour_dot');
      const saved = dot.style.transition;
      dot.style.opacity = '1';
      dot.style.transition = 'opacity 0.3s';
      return new Promise(resolve => {
        const start = performance.now(), total = loops * loopMs;
        const step = t => {
          const f = Math.min(1, (t - start) / total);
          const a = Math.PI + f * loops * 2 * Math.PI;
          dot.style.left = `${cx + rx * Math.cos(a)}px`;
          dot.style.top  = `${cy + ry * Math.sin(a)}px`;
          if (f < 1) requestAnimationFrame(step);
          else { dot.style.transition = saved; resolve(); }
        };
        requestAnimationFrame(step);
      });
    },
  };
  // Create the overlay right away (so the opening logo covers the first
  // paint), and again once the page has loaded in case it was replaced.
  if (document.documentElement) ensure();
  document.addEventListener('DOMContentLoaded', ensure);
}

// ── Helpers ───────────────────────────────────────────────────
let page;
let t0 = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pause = ms => page.waitForTimeout(ms * PACE);

// Caption timing. A caption stays up for at least max(minMs, reading time).
// `wait` is how long to hold before the next step runs; any time still owed
// is paid by settle(), which runs before the next caption and at scene end.
let current = null;
const readMs = text => Math.max(1500, (text.split(/\s+/).length / READ_WORDS_PER_SEC) * 1000);

async function settle() {
  if (!current) return;
  const left = current.shownAt + current.needMs - Date.now();
  current = null;
  if (left > 0) await sleep(left);
}

async function caption(text, minMs = 0, { wait } = {}) {
  await settle();
  await page.evaluate(t => window.__tour?.caption(t), text || '');
  if (!text) return;
  const needMs = Math.max(minMs, readMs(text)) * PACE;
  current = { shownAt: Date.now(), needMs };
  await sleep(wait === undefined ? needMs : wait * PACE);
}

async function clearCaption() {
  await settle();
  await page.evaluate(() => window.__tour?.caption(''));
}

async function pointAt(locator) {
  // Fixed-position panels can't be scrolled into view; carry on if so.
  await locator.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
  const box = await locator.boundingBox();
  if (!box) return;
  await page.evaluate(([x, y]) => window.__tour?.move(x, y), [box.x + box.width / 2, box.y + box.height / 2]);
  await pause(650);
}

async function click(locator, timeout = 15000) {
  const target = locator.filter({ visible: true }).first();
  await target.waitFor({ state: 'visible', timeout });
  await pointAt(target);
  await page.evaluate(() => window.__tour?.press());
  await target.click();
  await pause(450);
}

async function typeInto(locator, text) {
  const target = locator.filter({ visible: true }).first();
  await target.waitFor({ state: 'visible', timeout: 15000 });
  await pointAt(target);
  await target.click();
  await target.pressSequentially(text, { delay: 85 });
  await pause(400);
}

// Union of the on-screen boxes of every element the locator matches.
async function boxOfAll(locator) {
  return locator.evaluateAll(els => {
    const rs = els.map(e => e.getBoundingClientRect()).filter(r => r.width && r.height);
    if (!rs.length) return null;
    const x = Math.min(...rs.map(r => r.left)), y = Math.min(...rs.map(r => r.top));
    return { x, y, width: Math.max(...rs.map(r => r.right)) - x, height: Math.max(...rs.map(r => r.bottom)) - y };
  });
}

// Circles the cursor dot around an element (or around all matches with all: true).
async function circle(locator, { loops = 2, all = false, pad = 18 } = {}) {
  const first = locator.filter({ visible: true }).first();
  await first.waitFor({ state: 'visible', timeout: 15000 });
  await first.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
  const box = all ? await boxOfAll(locator) : await first.boundingBox();
  if (!box) return;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const rx = box.width / 2 + pad, ry = box.height / 2 + pad;
  await page.evaluate(([x, y]) => window.__tour?.move(x, y), [cx - rx, cy]);
  await pause(600);
  const loopMs = Math.round(Math.min(1600, Math.max(900, (rx + ry) * 2.2)) * PACE);
  await page.evaluate(a => window.__tour?.circle(...a), [cx, cy, rx, ry, loops, loopMs]);
  await pause(250);
}

async function scrollBy(dy, steps = 6) {
  await page.mouse.move(WIDTH * 0.6, HEIGHT * 0.5);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, dy / steps);
    await pause(140);
  }
  await restMouse();
}

// Moves the real (invisible) mouse to the window's right edge so hover
// tooltips and highlights close. The visible cursor dot stays where it is.
async function restMouse() {
  await page.mouse.move(WIDTH - 4, Math.round(HEIGHT * 0.5));
}

// Smoothly scrolls the scrollable box that contains `locator` to its end.
async function scrollContainerToEnd(locator) {
  const target = locator.first();
  await target.waitFor({ state: 'visible', timeout: 15000 });
  await target.evaluate(el => {
    let n = el.parentElement;
    while (n && !(/(auto|scroll)/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 4)) n = n.parentElement;
    (n || document.scrollingElement).scrollTo({ top: (n || document.scrollingElement).scrollHeight, behavior: 'smooth' });
  });
  await pause(1500);
}

async function nav(label) {
  await click(page.locator('.nav-hover').filter({ hasText: label }));
  await restMouse();
}
const button = (name, exact = false) => page.getByRole('button', { name, exact });
const visible = locator => locator.filter({ visible: true });
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${p2(s % 60)}`; };

const results = [];
const chapters = [];
class StopTour extends Error {}

async function scene(name, fn, { critical = false } = {}) {
  const started = Date.now();
  chapters.push({ title: name, at: started - t0 });
  if (chapters.length > 1) {
    // Hold the marker long enough that a busy recording still captures it.
    await page.evaluate(() => window.__tour?.mark(1500)).catch(() => {});
    await sleep(300);
  }
  try {
    await fn();
    await settle();
    const spent = Date.now() - started;
    if (spent < MIN_SCENE_MS) await sleep(MIN_SCENE_MS - spent);
    await page.evaluate(() => window.__tour?.caption(''));
    await sleep(400);
    results.push({ scene: name, ok: true, start: mmss(started - t0), seconds: Math.round((Date.now() - started) / 1000) });
    console.log(`  ok    ${mmss(started - t0)}  ${name}`);
  } catch (e) {
    const shot = path.join(OUT, `failed-${slug(name)}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    const message = String(e?.message || e).split('\n')[0];
    results.push({ scene: name, ok: false, start: mmss(started - t0), error: message, screenshot: shot });
    console.log(`  FAIL  ${mmss(started - t0)}  ${name}: ${message}\n        screenshot: ${shot}`);
    current = null;
    await page.evaluate(() => { window.__tour?.caption(''); window.__tour?.logo(false); }).catch(() => {});
    if (e instanceof StopTour) throw e;
    if (critical) throw new StopTour(`"${name}" failed, so the rest of the tour can't run.`);
  }
}

// The word deck's tile for a source (the sentence deck's tile carries the
// same name plus a "(sentence mining)" label).
async function wordDeckTile(name) {
  const candidates = page.getByText(name, { exact: true });
  const n = await candidates.count();
  for (let i = 0; i < n; i++) {
    const c = candidates.nth(i);
    if (!(await c.isVisible())) continue;
    // Climb only while the ancestor still holds a single deck name, so the
    // check stays inside this tile and never reaches the neighbouring one.
    const isSentence = await c.evaluate((el, nm) => {
      for (let a = el; a; a = a.parentElement) {
        const text = a.textContent || '';
        if (text.split(nm).length - 1 > 1) return false;
        if (text.includes('(sentence mining)')) return true;
      }
      return false;
    }, name);
    if (!isSentence) return c;
  }
  throw new Error(`No word deck tile named "${name}"`);
}

// ── Chapter timing from the video ────────────────────────────
// Extracts the top-left corner of every video frame as a 1-pixel PNG, using
// the ffmpeg that Playwright installs for recording, and returns the time
// (ms) of each red chapter marker. Returns null if ffmpeg can't be found or
// run. (Playwright's ffmpeg is a minimal build: PNG is its only image output.)
function pngPixel(buf) {
  let o = 8;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    if (buf.toString('ascii', o + 4, o + 8) === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  return [raw[1], raw[2], raw[3]];   // 1×1 RGB: filter byte, then R, G, B
}

async function findChapterMarks(videoPath) {
  let ffmpegPath;
  try {
    const mod = await import('playwright-core/lib/server/registry/index');
    const registry = mod.registry ?? mod.default?.registry;
    ffmpegPath = registry?.findExecutable('ffmpeg')?.executablePath();
  } catch { return null; }
  if (!ffmpegPath) return null;
  const dir = path.join(OUT, '.frames');
  try {
    await mkdir(dir, { recursive: true });
    const ok = await new Promise(resolve => {
      const proc = spawn(ffmpegPath, ['-v', 'error', '-i', videoPath,
        '-vf', 'crop=4:4:1:1,scale=1:1:flags=area,format=rgb24', '-f', 'image2', path.join(dir, '%06d.png')]);
      proc.on('error', () => resolve(false));
      proc.on('close', code => resolve(code === 0));
    });
    if (!ok) return null;
    const files = (await readdir(dir)).filter(f => f.endsWith('.png')).sort();
    const FPS = 25;   // Playwright records at a constant 25 frames per second
    const marks = [];
    let inMark = false;
    for (let i = 0; i < files.length; i++) {
      const [r, g, b] = pngPixel(await readFile(path.join(dir, files[i])));
      const red = r > 120 && r - g > 60 && r - b > 60;
      const at = Math.round((i / FPS) * 1000);
      // A marker can flicker in the capture; ignore repeats within 2 seconds.
      if (red && !inMark && (!marks.length || at - marks[marks.length - 1] > 2000)) marks.push(at);
      inMark = red;
    }
    return marks;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Matches the markers found in the video to the scenes. Markers come in scene
// order, but the recording can run ahead of or behind the clock, so each
// marker goes to a scene by an in-order matching that keeps the total gap
// between marker times and the scenes' clock times as small as possible. A
// scene whose marker is missing is estimated from the previous matched scene
// (and reported).
function alignChapters(clock, marks) {
  const n = clock.length;
  if (!marks) return { starts: [...clock], estimated: [] };
  const m = marks.length;
  const SKIP_MARK = 1e9;   // markers are only drawn by the tour, so keep them all if possible
  // cost[i][j]: best total for scenes 1..i and markers 0..j-1
  const cost = Array.from({ length: n }, () => new Array(m + 1).fill(Infinity));
  const from = Array.from({ length: n }, () => new Array(m + 1).fill(null));
  for (let j = 0; j <= m; j++) cost[0][j] = j * SKIP_MARK;
  for (let i = 1; i < n; i++) {
    for (let j = 0; j <= m; j++) {
      let best = cost[i - 1][j], how = 'scene';                 // scene i has no marker
      if (j > 0 && cost[i][j - 1] + SKIP_MARK < best) { best = cost[i][j - 1] + SKIP_MARK; how = 'mark'; }
      if (j > 0 && cost[i - 1][j - 1] + Math.abs(marks[j - 1] - clock[i]) < best) {
        best = cost[i - 1][j - 1] + Math.abs(marks[j - 1] - clock[i]); how = 'match';
      }
      cost[i][j] = best; from[i][j] = how;
    }
  }
  const matched = new Array(n).fill(null);
  for (let i = n - 1, j = m; i > 0;) {
    const how = from[i][j];
    if (how === 'match') { matched[i] = marks[j - 1]; i--; j--; }
    else if (how === 'mark') j--;
    else i--;
  }
  const starts = [0];
  const estimated = [];
  let offset = 0;
  for (let i = 1; i < n; i++) {
    if (matched[i] != null) { starts.push(matched[i]); offset = matched[i] - clock[i]; }
    else { starts.push(Math.max(clock[i] + offset, starts[i - 1] + 1000)); estimated.push(i); }
  }
  return { starts, estimated };
}

// ── The tour ──────────────────────────────────────────────────
async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    recordVideo: { dir: OUT, size: { width: WIDTH, height: HEIGHT } },
    locale: 'en-US',
  });
  await context.addInitScript(installOverlay, { openingLogo: true, openingBg: OPENING_BG });
  page = await context.newPage();
  t0 = Date.now();
  await page.setContent(`<body style="margin:0;background:${OPENING_BG}"></body>`);

  const tourUrl = new URL(DEMO_URL);
  tourUrl.searchParams.set('tour', '1');
  console.log(`Recording the AutoVocaIndex tour from ${tourUrl}`);

  try {
    await scene('Introduction', async () => {
      await page.goto(tourUrl.toString(), { waitUntil: 'domcontentloaded' });
      const enter = button('Enter the demo', true);
      await caption(CAP.opening, 6500, { wait: 0 });
      await Promise.all([enter.waitFor({ state: 'visible', timeout: 30000 }), sleep(4000 * PACE)]);
      await page.evaluate(() => window.__tour?.logo(false));
      await click(enter);
      await caption(CAP.sandbox, 2500, { wait: 0 });
      const capacity = page.getByText("The demo has reached today's limit");
      const refused  = page.getByText('Could not enter the demo');
      await page.locator('.nav-hover').first().or(capacity).or(refused).first().waitFor({ state: 'visible', timeout: 90000 });
      if (await capacity.isVisible()) throw new StopTour('The demo has reached its daily limit. Try again after it resets.');
      if (await refused.isVisible()) throw new Error('The demo refused the sign-in ("Could not enter the demo").');
      await pause(2500);
    }, { critical: true });

    await scene('Today', async () => {
      await nav('Today');
      await caption(CAP.today, 4500);
    });

    await scene('Appointments', async () => {
      await nav('Appointments');
      await caption(CAP.appts, 2500);
      await click(page.getByText('김선생님'));
      await caption(CAP.apptLinks, 2500, { wait: 0 });
      await page.getByText('Main source').first().waitFor({ state: 'visible', timeout: 15000 });
      await pause(2000);
      await scrollContainerToEnd(page.getByText('Main source'));
      await settle();
      await click(visible(button('Cancel', true)).last());
    });

    await scene('Content Library', async () => {
      await nav('Content Library');
      await caption(CAP.clFront, 7000);
      await scrollBy(900);
      await caption(CAP.clScroll, 6000);
      await scrollBy(-900, 3);

      await click(button('Library', true));
      await pause(1000);
      await caption(CAP.clLibrary, 10000, { wait: 0 });
      await click(page.getByText('세종 5A', { exact: true }));
      const typeSelect = page.locator('select').filter({ has: page.locator('option', { hasText: 'Grammar: Practice' }) });
      await circle(typeSelect.first().locator('xpath=..'));
      await circle(page.locator('.section-row'), { all: true });
      await click(page.locator('.section-row').filter({ hasText: '1과' }).getByText('1과', { exact: true }));
      await circle(page.getByText('~에 따르면', { exact: true }).last(), { pad: 12 });

      await click(button('Notes', true));
      await caption(CAP.clNotes, 7000, { wait: 0 });
      await circle(button(/^Notes\b/).nth(1));
      await circle(button(/^Questions/));
      await circle(button(/^Corrections/));
      await click(button(/^Questions/));
      await click(page.getByText(/What is ~끼리/));
      await pause(1500);

      await click(button('Archive', true));
      await caption(CAP.clArchive, 4000);
    });

    await scene('AutoVocaIndex', async () => {
      await nav('AutoVocaIndex');
      await caption(CAP.avi, 3500);
      await scrollBy(800);
      await caption(CAP.aviStats, 3000);
      await scrollBy(-800, 3);
      await caption(CAP.aviWays, 4000, { wait: 0 });
      for (const tab of ['Import', 'Word Input', 'Sentence Input']) await circle(button(tab, true), { pad: 10 });
      await settle();
      await click(button('Sentence Input', true));

      await caption(CAP.pickSource, 1200);
      await typeInto(page.getByPlaceholder('— Source —'), 'AVI');
      await click(page.getByText('AVI Additions', { exact: true }));
      const sectionSelect = page.locator('select').filter({ has: page.locator('option', { hasText: '(All sections)' }) });
      await pointAt(sectionSelect.first());
      await sectionSelect.first().selectOption('1');
      await pause(600);

      await caption(CAP.paste, 600);
      await typeInto(page.getByPlaceholder('Paste sentence here…'), SENTENCE);
      await caption(CAP.pickWords, 800);
      for (const p of PICKS) await click(page.locator('span').filter({ hasText: p.pill }));
      await pause(800);
      await click(button('Add Selected'));

      await page.getByText('Step 1 — Confirm Lemmas').waitFor({ state: 'visible', timeout: 20000 });
      await caption(CAP.resolve, 5500);
      await click(button('Confirm & Fetch Definitions'));

      await page.getByText('Step 2 — Review Definitions').waitFor({ state: 'visible', timeout: 45000 });
      await caption(CAP.define, 3500, { wait: 3500 });
      const boxes = page.getByPlaceholder('Add your own definition…');
      const count = await boxes.count();
      for (let i = 0; i < PICKS.length && i < count; i++) {
        const card = page.locator('div').filter({ hasText: PICKS[i].term }).filter({ has: boxes }).last();
        const own = card.getByPlaceholder('Add your own definition…');
        await typeInto((await own.count()) ? own : boxes.nth(i), PICKS[i].def2);
      }
      await pause(800);
      await settle();
      await click(button('✓ Done'));
      await caption(CAP.entries, 7500);
      await click(button('Lemma Master', true));
      await caption(CAP.lemmaMaster, 6500);
    });

    await scene('Flashcards', async () => {
      await nav('Flashcards');
      await caption(CAP.flashcards, 5500);
      await click(await wordDeckTile('AVI Additions'));
      const study = button(/^Study \d+ new card/);
      if (await study.first().isVisible().catch(() => false)) await click(study);
      for (let i = 0; i < PICKS.length; i++) {
        const show = button('Show answer');
        await show.first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
        if (!(await show.first().isVisible().catch(() => false))) break;
        await caption(i === 0 ? CAP.recall1 : CAP.recall2, 1800);
        await click(show);
        await caption(i === 0 ? CAP.grade1 : CAP.grade2, 2500);
        await click(button(/^Good/));
      }
      await pause(1500);
      await clearCaption();
      const leave = visible(page.getByRole('button', { name: /^(Done|End)$/ }));
      if (await leave.first().isVisible().catch(() => false)) await click(leave);

      const pauseBtn = page.locator('button[title^="Pause"]');
      await pauseBtn.first().waitFor({ state: 'visible', timeout: 15000 });
      await caption(CAP.pauseDeck, 4500, { wait: 0 });
      await circle(pauseBtn, { pad: 10 });
      await settle();

      await scrollBy(-4000, 4);
      await caption(CAP.spike, 3500, { wait: 0 });
      await circle(page.locator('.nav-hover').filter({ hasText: 'Settings' }), { pad: 8 });
      await circle(page.getByText(/card spike on/).first(), { pad: 14 });
    });

    await scene('Quizzes', async () => {
      await nav('Quizzes');
      await caption(CAP.quizzes, 4500);
      await click(page.getByText('Vocabulary Quiz', { exact: true }));
      const minus = visible(button('−', true)).first();
      await minus.waitFor({ state: 'visible', timeout: 15000 });
      await pointAt(minus);
      for (let i = 0; i < 7; i++) { await minus.click(); await page.evaluate(() => window.__tour?.press()); await pause(180); }
      await click(button('Start Quiz', true));
      // Questions 1 and 3 are answered correctly; question 2 is missed on
      // purpose so the video shows the right answer highlighted after a miss.
      const cardPairs = await loadCardPairs();
      for (let i = 0; i < 3; i++) {
        const label = page.getByText(/^Choose the (Korean term|definition)$/).first();
        await label.waitFor({ state: 'visible', timeout: 15000 });
        if (i === 0) await caption(CAP.quizAnswer, 4500, { wait: 1500 });
        // The prompt is either a card's definition (answer: its Korean term)
        // or its term (answer: its definition); match it against both sides.
        const promptText = (await label.locator('xpath=preceding-sibling::div[1]').innerText().catch(() => '')).trim();
        const byBack = cardPairs.find(p => p.back === promptText);
        const byFront = cardPairs.find(p => p.front === promptText);
        const answer = byBack ? byBack.front : byFront ? byFront.back : null;
        const choices = label.locator('xpath=following-sibling::div[1]//button');
        const texts = (await choices.allInnerTexts()).map(t => t.trim());
        const right = answer ? texts.indexOf(answer) : -1;
        const pick = i === 1
          ? texts.findIndex((t, k) => k !== right)          // the deliberate miss
          : (right >= 0 ? right : 0);
        await click(choices.nth(Math.max(0, pick)));
        await pause(1300);
        const next = button(/^(Next|See results)$/);
        if (await next.first().isVisible().catch(() => false)) await click(next);
      }
      await settle();
      await pause(2000);
      const back = button('Back to Quizzes', true);
      if (await back.first().isVisible().catch(() => false)) await click(back);
      else await page.keyboard.press('Enter');
      await pause(600);
      await scrollBy(-3000, 3);
      await caption(CAP.quizScores, 3500);
    });

    await scene('Grammar Index', async () => {
      await nav('Grammar Index');
      await caption(CAP.grammar, 3000);
      await click(page.getByText('~아/어 버리다'));
      await pause(3000);
      await scrollContainerToEnd(page.getByText('Compare to'));
      await caption(CAP.grammarDeck, 4500);
    });

    await scene('Closing', async () => {
      await nav('Content Library');
      await click(button('Overview', true));
      await restMouse();
      await nav('Appearance');
      await page.getByText(THEMES[0], { exact: true }).filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 10000 });
      await pause(700);   // let the panel finish sliding in
      await caption(CAP.closing, 9000, { wait: 0 });
      const start = THEMES.indexOf(START_THEME);
      for (let k = 1; k <= THEMES.length; k++) {
        const name = THEMES[(start + k) % THEMES.length];
        const option = page.getByText(name, { exact: true }).filter({ visible: true }).last();
        await pointAt(option);
        await page.evaluate(() => window.__tour?.press());
        await option.click();
        await pause(1200 - 650);
      }
      await page.mouse.click(WIDTH * 0.3, HEIGHT * 0.5);   // click outside the panel to close it
      await clearCaption();
      await pause(700);
      await page.evaluate(() => window.__tour?.logo(true));
      // About 6 seconds of logo: long enough for the last frames to reach the
      // video even if the recording runs behind, and room for YouTube's
      // end-screen links (they need the final 5-20 seconds).
      await sleep(700 + 2000 * PACE + 4000);
    });
  } catch (e) {
    if (!(e instanceof StopTour)) throw e;
    console.log(`Tour stopped: ${e.message}`);
  }

  const video = page.video();
  await context.close();
  await browser.close();

  const finalPath = path.join(OUT, `autovocaindex-tour-${STAMP}.webm`);
  if (video) await rename(await video.path(), finalPath).catch(() => {});
  const found = video ? await findChapterMarks(finalPath) : null;
  const marks = found?.length ? found : null;
  const { starts, estimated } = alignChapters(chapters.map(c => c.at), marks);
  const chapterText = chapters.map((c, i) => `${i === 0 ? '0:00' : mmss(starts[i])} ${c.title}`).join('\n') + '\n';
  await writeFile(path.join(OUT, 'chapters.txt'), chapterText);
  await writeFile(path.join(OUT, 'tour-log.json'), JSON.stringify({ url: tourUrl.toString(), pace: PACE, recorded: STAMP, results }, null, 2));

  const failed = results.filter(r => !r.ok);
  console.log(`\nVideo: ${finalPath}`);
  const estNames = estimated.map(i => chapters[i].title);
  console.log(!marks
    ? `YouTube chapters (also saved as chapters.txt). These are clock estimates, because the scene markers couldn't be read from the video; check them against the video before publishing:\n${chapterText}`
    : estNames.length
      ? `YouTube chapters (also saved as chapters.txt). Timed from the video, except ${estNames.join(', ')}, whose marker wasn't found and was estimated; check ${estNames.length === 1 ? 'that one' : 'those'} against the video before publishing:\n${chapterText}`
      : `YouTube chapters, timed from the video (also saved as chapters.txt):\n${chapterText}`);
  console.log(failed.length
    ? `${failed.length} scene(s) failed; see the screenshots and tour-log.json in ${OUT}`
    : 'All scenes completed.');
}

main().catch(e => {
  console.error('Tour could not run:', e?.message || e);
  process.exitCode = 1;
});
