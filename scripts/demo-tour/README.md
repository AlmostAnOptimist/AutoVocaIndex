# Demo tour recorder

Records a captioned video walkthrough of the hosted AutoVocaIndex demo, for anyone who can't try the demo itself (for example, when it has reached its daily limit).

The script drives the real demo in a browser. It opens on the logo, enters the sandbox, and visits Today, Appointments, the Content Library (front page, Library, Notes, Archive), AutoVocaIndex, Flashcards, Quizzes and the Grammar Index. Along the way it runs one pasted sentence all the way through: word selection, lemma resolution, dictionary definitions, automatic flashcards, grading, and a finished quiz. It closes by cycling through the themes and ends on the logo. Captions and a cursor dot are drawn on the page so viewers can follow along.

It is separate from the app: it has its own `package.json`, and nothing here is part of a normal install or build.

## Run it

From this folder, once:

```
npm install
npx playwright install chromium
```

Then:

```
node tour.mjs --headed
```

watches it run in a visible window. Use `--headed` for any recording you plan to publish: a visible window draws with your graphics card, while a background run draws in software, which on a slower computer can make the video stutter or freeze on pop-up windows. Without `--headed` it runs in the background, which is fine for a quick check that every scene still works. The window may be larger than your screen; that's expected, and the whole page is still recorded. While it runs, keep your mouse still (ideally off to the side or on another screen) and avoid typing, so nothing you do shows up in the video. Either way, each run gets its own folder named with the date and time, for example `output/2026-10-07_0215/`, holding:

- the video, `autovocaindex-tour-2026-10-07_0215.webm` (1920×1080, about 6½ minutes)
- `chapters.txt`, scene start times ready to paste into a YouTube description as chapters
- `tour-log.json`, listing each scene as ok or failed
- a `failed-<scene>.png` screenshot for any scene that failed

A new run never replaces an earlier recording. To watch a recording again, open its `.webm` file (double-click it, or drag it into Chrome or Edge). Running the script again records a new video and uses another demo account.

Options:

| Option | Default | |
|---|---|---|
| `--url <address>` | `https://autovocaindex.netlify.app` | Point it at another deployment of the demo |
| `--pace <number>` | `1` | Timing multiplier: `1.3` is slower, `0.8` is faster |
| `--out <folder>` | `output` | Where the dated run folders go |

## Editing captions and timing

Every caption is in the `CAP` list near the top of `tour.mjs`. Each caption stays up for its listed minimum time or its reading time (3 words per second), whichever is longer, and time spent on actions while it is showing counts toward that. So rewording a caption needs no timing changes.

## The sample review forecast

The demo's sample cards have almost no review history, so on their own they never fill Today's Reviews or trigger a spike warning. The tour opens the demo with `?tour` in the address, which makes those widgets show a sample forecast (34 reviews today and a 101-card spike tomorrow), so the video can show what the features look like in use. This only affects the demo, only with `?tour`, and nothing is saved. The sample numbers are in `tourSampleSnapshot` in `src/demo/demoConfig.js`.

## Chapters

At the start of each scene the tour flashes a tiny red marker (6 pixels, a second and a half) in the top-left corner. After recording, it finds those markers in the video using the ffmpeg that Playwright installs, so the chapter times match the video exactly, even if the recording ran slightly behind. If a scene's marker is missing from the video (a very busy computer can skip frames), that one chapter is estimated from the scenes around it, and the script names it so you can check it. If no markers can be read at all, `chapters.txt` falls back to clock times and the script says so; check those against the video before publishing.

The closing logo holds for about 6 seconds. That leaves room for YouTube's end-screen links, and it makes sure the final frames reach the video. Trim it in YouTube Studio if you want it shorter.

## When a scene fails

Each scene runs on its own. If a step can't find the button or field it expects (usually because the app's wording or layout changed), that scene is logged as failed, a screenshot is saved in that run's folder, and the tour moves on to the next scene. Update the matching step in `tour.mjs` and run it again.

## Cost

Each run uses one fresh demo account, about the same as one visitor (roughly 80 database writes on the demo's free plan, plus a few dictionary lookups). If the demo has reached its daily limit, the tour stops at the start and says so.
