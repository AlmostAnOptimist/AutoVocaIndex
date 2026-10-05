# Demo tour recorder

Records a captioned video walkthrough of the hosted AutoVocaIndex demo, for anyone who can't try the demo itself (for example, when it has reached its daily limit).

The script drives the real demo in a browser. It enters the sandbox, visits Today, the Content Library, AVI, Flashcards, Quizzes and the Grammar Index, and runs one pasted sentence all the way through: word selection, lemma resolution, dictionary definitions, an automatic flashcard, grading, and a quiz question. Captions and a cursor dot are drawn on the page so viewers can follow along.

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

watches it run in a visible window. Without `--headed` it runs in the background. Either way, the video is saved to `output/autovocaindex-tour-YYYY-MM-DD.webm`, next to a `tour-log-YYYY-MM-DD.json` that lists each scene as ok or failed.

Options:

| Option | Default | |
|---|---|---|
| `--url <address>` | `https://autovocaindex.netlify.app` | Point it at another deployment of the demo |
| `--pace <number>` | `1` | Pause multiplier: `1.3` is slower, `0.8` is faster |
| `--out <folder>` | `output` | Where the video, log and screenshots go |

## When a scene fails

Each scene runs on its own. If a step can't find the button or field it expects (usually because the app's wording or layout changed), that scene is logged as failed, a screenshot is saved as `output/failed-<scene>.png`, and the tour moves on to the next scene. Update the matching step in `tour.mjs` and run it again.

## Cost

Each run uses one fresh demo account, about the same as one visitor (roughly 80 database writes on the demo's free plan, plus a few dictionary lookups). If the demo has reached its daily limit, the tour stops at the start and says so.
