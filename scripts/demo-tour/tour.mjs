// scripts/demo-tour/tour.mjs
// Records a captioned video walkthrough of the hosted AutoVocaIndex demo.
//
// It drives the real demo in a browser: enters the sandbox, visits each
// area, and runs one word from a pasted sentence through to a graded
// flashcard and a quiz question. Captions and a cursor dot are drawn on the
// page so viewers can follow along. Re-run it after each template update so
// the video always matches the current app.
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
//   --pace <number>   pause multiplier; 1.3 is slower, 0.8 is faster (default 1)
//   --out <folder>    where the video, log and screenshots go (default output)
//
// Each scene runs on its own. If a step can't find what it's looking for,
// the scene is logged as failed with a screenshot, and the tour moves on.

import { chromium } from 'playwright';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const DEMO_URL = value('url', 'https://autovocaindex.netlify.app');
const PACE     = Number(value('pace', '1')) || 1;
const OUT      = path.resolve(value('out', 'output'));
const HEADED   = flag('headed');
const WIDTH = 1440, HEIGHT = 900;   // wide enough for the full sidebar (1340px+)

// The sentence the tour adds, the words it picks, and the short definitions
// it writes for them. Neither word is in the demo's sample data, so the
// new-word dialog appears.
const SENTENCE = '요즘 날씨가 좋아서 매일 공원에서 산책해요.';
const PICKS = [
  { pill: /^날씨가[.,!?]?$/,  term: '날씨',   def2: 'weather' },
  { pill: /^산책해요[.,!?]?$/, term: '산책', def2: 'to take a walk' },
];

// ── On-page overlay: caption bar + cursor dot ─────────────────
// Installed into every page load. Appended to <html>, outside the React
// root, so app re-renders never remove it.
function installOverlay() {
  if (window.__tour) return;
  const ensure = () => {
    if (document.getElementById('__tour_cap')) return;
    const cap = document.createElement('div');
    cap.id = '__tour_cap';
    Object.assign(cap.style, {
      position: 'fixed', left: '50%', bottom: '36px', transform: 'translateX(-50%)',
      maxWidth: '70%', padding: '14px 26px', borderRadius: '14px',
      background: 'rgba(22, 19, 16, 0.88)', color: '#f4efe6',
      font: '500 20px/1.45 system-ui, -apple-system, "Segoe UI", "Malgun Gothic", sans-serif',
      textAlign: 'center', zIndex: '2147483647', opacity: '0',
      transition: 'opacity 0.35s ease', pointerEvents: 'none',
      boxShadow: '0 6px 30px rgba(0, 0, 0, 0.35)',
    });
    const dot = document.createElement('div');
    dot.id = '__tour_dot';
    Object.assign(dot.style, {
      position: 'fixed', left: '-40px', top: '-40px', width: '22px', height: '22px',
      margin: '-11px 0 0 -11px', borderRadius: '50%',
      background: 'rgba(255, 186, 84, 0.55)', border: '2px solid rgba(255, 255, 255, 0.95)',
      boxShadow: '0 0 0 2px rgba(0, 0, 0, 0.25)', zIndex: '2147483647',
      pointerEvents: 'none', opacity: '0',
      transition: 'left 0.55s ease, top 0.55s ease, transform 0.15s ease, opacity 0.3s',
    });
    document.documentElement.append(cap, dot);
  };
  window.__tour = {
    caption(text) {
      ensure();
      const cap = document.getElementById('__tour_cap');
      if (!text) { cap.style.opacity = '0'; return; }
      cap.textContent = text;
      cap.style.opacity = '1';
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
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensure);
  else ensure();
}

// ── Helpers ───────────────────────────────────────────────────
let page;
const pause = ms => page.waitForTimeout(ms * PACE);

async function caption(text, holdMs = 0) {
  await page.evaluate(t => window.__tour?.caption(t), text);
  if (holdMs) await pause(holdMs);
}

async function pointAt(locator) {
  await locator.scrollIntoViewIfNeeded({ timeout: 10000 });
  const box = await locator.boundingBox();
  if (!box) return;
  await page.evaluate(([x, y]) => window.__tour?.move(x, y), [box.x + box.width / 2, box.y + box.height / 2]);
  await pause(650);
}

async function click(locator, timeout = 15000) {
  const target = locator.first();
  await target.waitFor({ state: 'visible', timeout });
  await pointAt(target);
  await page.evaluate(() => window.__tour?.press());
  await target.click();
  await pause(450);
}

async function typeInto(locator, text) {
  const target = locator.first();
  await target.waitFor({ state: 'visible', timeout: 15000 });
  await pointAt(target);
  await target.click();
  await target.pressSequentially(text, { delay: 85 });
  await pause(400);
}

async function scrollBy(dy, steps = 6) {
  await page.mouse.move(WIDTH * 0.6, HEIGHT * 0.5);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, dy / steps);
    await pause(140);
  }
}

const nav = label => click(page.locator('.nav-hover').filter({ hasText: label }));
const button = (name, exact = false) => page.getByRole('button', { name, exact });
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const results = [];
class StopTour extends Error {}

async function scene(name, fn, { critical = false } = {}) {
  const started = Date.now();
  try {
    await fn();
    results.push({ scene: name, ok: true, seconds: Math.round((Date.now() - started) / 1000) });
    console.log(`  ok    ${name}`);
  } catch (e) {
    const shot = path.join(OUT, `failed-${slug(name)}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    const message = String(e?.message || e).split('\n')[0];
    results.push({ scene: name, ok: false, error: message, screenshot: shot });
    console.log(`  FAIL  ${name}: ${message}\n        screenshot: ${shot}`);
    await caption('').catch(() => {});
    if (e instanceof StopTour) throw e;
    if (critical) throw new StopTour(`"${name}" failed, so the rest of the tour can't run.`);
  }
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
  await context.addInitScript(installOverlay);
  page = await context.newPage();
  console.log(`Recording the AutoVocaIndex tour from ${DEMO_URL}`);

  try {
    await scene('Enter the demo', async () => {
      await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' });
      const enter = button('Enter the demo', true);
      await enter.waitFor({ state: 'visible', timeout: 30000 });
      await caption('AutoVocaIndex: a self-hosted Korean study system built around the material you actually read and watch.', 4500);
      await click(enter);
      await caption('This is the public demo, a sandbox with sample data that resets nightly.');
      const capacity = page.getByText("The demo has reached today's limit");
      const refused  = page.getByText('Could not enter the demo');
      await page.locator('.nav-hover').first().or(capacity).or(refused).first().waitFor({ state: 'visible', timeout: 90000 });
      if (await capacity.isVisible()) throw new StopTour('The demo has reached its daily limit. Try again after it resets.');
      if (await refused.isVisible()) throw new Error('The demo refused the sign-in ("Could not enter the demo").');
      await pause(2500);
    }, { critical: true });

    await scene('Today', async () => {
      await nav('Today');
      await caption('Today brings your tasks and the day\'s flashcard reviews together.', 4500);
    });

    await scene('Content Library', async () => {
      await nav('Content Library');
      await caption('The Content Library catalogs everything you study from (books, shows, podcasts) and reports on it like a front page.', 5000);
      await scrollBy(700);
      await caption('Activity, sources that have gone quiet, and what is queued up next.', 4000);
      await scrollBy(-700, 3);
    });

    await scene('Collect words from a sentence', async () => {
      await nav('AutoVocaIndex');
      await caption('AutoVocaIndex (AVI) is the vocabulary engine. Every word is tied to the source where you found it.', 4500);
      await click(button('Sentence Input', true));

      await caption('Pick the source you are studying…', 1200);
      await typeInto(page.getByPlaceholder('— Source —'), 'AVI');
      await click(page.getByText('AVI Additions', { exact: true }));
      const sectionSelect = page.locator('select').filter({ has: page.locator('option', { hasText: '(All sections)' }) });
      await pointAt(sectionSelect.first());
      await sectionSelect.first().selectOption('1');
      await pause(600);

      await caption('…paste a sentence from it…', 600);
      await typeInto(page.getByPlaceholder('Paste sentence here…'), SENTENCE);
      await caption('…and click the words you want to learn.', 800);
      for (const p of PICKS) await click(page.locator('span').filter({ hasText: p.pill }));
      await pause(800);
      await click(button('Add Selected'));

      await page.getByText('Step 1 — Confirm Lemmas').waitFor({ state: 'visible', timeout: 20000 });
      await caption('AVI resolves each word to its dictionary form, stripping particles and verb endings. You can correct it if needed.', 5500);
      await click(button('Confirm & Fetch Definitions'));

      await page.getByText('Step 2 — Review Definitions').waitFor({ state: 'visible', timeout: 45000 });
      await caption('Definitions arrive from the national Korean dictionary (KRDict). Add your own short definition: that is what your flashcard will show.', 3500);
      const boxes = page.getByPlaceholder('Add your own definition…');
      const count = await boxes.count();
      for (let i = 0; i < PICKS.length && i < count; i++) {
        const card = page.locator('div').filter({ hasText: PICKS[i].term }).filter({ has: boxes }).last();
        const own = card.getByPlaceholder('Add your own definition…');
        await typeInto((await own.count()) ? own : boxes.nth(i), PICKS[i].def2);
      }
      await pause(800);
      await click(button('✓ Done'));
      await caption('Each word becomes an entry with its source, a dictionary record, and a flashcard, created automatically.', 4500);
      await click(button('Lemma Master', true));
      await caption('Lemma Master keeps one entry per word, however many times and places you meet it.', 4500);
    });

    await scene('Flashcards', async () => {
      await nav('Flashcards');
      await caption('Flashcards are scheduled with FSRS, and each source gets its own deck.', 4500);
      await click(page.getByText('AVI Additions', { exact: true }));
      const study = button(/^Study \d+ new card/);
      if (await study.first().isVisible().catch(() => false)) await click(study);
      for (let i = 0; i < PICKS.length; i++) {
        const show = button('Show answer');
        if (!(await show.first().isVisible().catch(() => false))) {
          await show.first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
          if (!(await show.first().isVisible().catch(() => false))) break;
        }
        await caption(i === 0 ? 'Here are the two new cards. Recall the meaning, then reveal…' : 'Recall, reveal…', 1800);
        await click(show);
        await caption(i === 0 ? '…and grade how well you remembered it. FSRS sets the next review.' : '…and grade.', 2500);
        await click(button(/^Good/));
      }
      await pause(1500);
    });

    await scene('Quizzes', async () => {
      await nav('Quizzes');
      await caption('Quizzes draw on the same cards: vocabulary, cloze, and AI-graded grammar drills.', 4500);
      await click(page.getByText('Vocabulary Quiz', { exact: true }));
      await click(button('Start Quiz', true));
      for (let i = 0; i < 3; i++) {
        const prompt = page.getByText(/^Choose the (Korean term|definition)$/);
        await prompt.first().waitFor({ state: 'visible', timeout: 15000 });
        if (i === 0) await caption('Pick an answer. Feedback is instant, with the right answer highlighted.', 1500);
        const choices = prompt.first().locator('xpath=following-sibling::div[1]//button');
        await click(choices.nth(i % 2));
        await pause(1300);
        const next = button(/^(Next|See results)$/);
        if (await next.first().isVisible().catch(() => false)) await click(next);
      }
    });

    await scene('Grammar Index', async () => {
      await nav('Grammar Index');
      await caption('The Grammar Index documents patterns, with explanations, examples, mastery levels, and links to where you met them.', 3000);
      await click(page.getByText('~아/어 버리다'));
      await pause(4000);
    });

    await scene('Closing', async () => {
      await nav('Content Library');
      await caption('AutoVocaIndex is free and self-hosted (MIT license). Try the demo, or set up your own: github.com/AlmostAnOptimist/AutoVocaIndex', 7000);
      await caption('', 800);
    });
  } catch (e) {
    if (!(e instanceof StopTour)) throw e;
    console.log(`Tour stopped: ${e.message}`);
  }

  const video = page.video();
  await context.close();
  await browser.close();

  const stamp = new Date().toISOString().slice(0, 10);
  const finalPath = path.join(OUT, `autovocaindex-tour-${stamp}.webm`);
  if (video) await rename(await video.path(), finalPath).catch(() => {});
  await writeFile(path.join(OUT, `tour-log-${stamp}.json`), JSON.stringify({ url: DEMO_URL, pace: PACE, results }, null, 2));

  const failed = results.filter(r => !r.ok);
  console.log(`\nVideo: ${finalPath}`);
  console.log(failed.length
    ? `${failed.length} scene(s) failed; see the screenshots and tour-log-${stamp}.json in ${OUT}`
    : 'All scenes completed.');
}

main().catch(e => {
  console.error('Tour could not run:', e?.message || e);
  process.exitCode = 1;
});
