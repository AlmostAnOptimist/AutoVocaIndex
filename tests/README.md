# Tests

Golden tests for AutoVocaIndex's pure engines. Each one feeds fixed inputs to
a module in `src/utils/` and compares the result with a recorded answer, so a
change that alters behaviour shows up as a failed case. None of them needs a
Firebase project, a network connection or any configuration.

## Running

```
npm test
```

runs every `*-golden.mjs` here and prints one line per file. Run it before
committing a change to any file in the table. A single file runs on its own
too: `node tests/heuristics-golden.mjs`. Some tests bundle a source file
first with rolldown or esbuild from `node_modules`, so run `npm install` once.
`bundle-with-stub.mjs` (Firebase stand-ins) and `load-analyser.mjs` (the
Korean analyser in Node) are helpers, not tests.

## What's here

| Test | Guards |
|------|--------|
| `heuristics-golden.mjs` | Lemma heuristics in `aviUtils.js` |
| `lemma-resolver-golden.mjs` | How the lemma resolver, `resolveLemmaDetailed` in `aviUtils.js`, meets the global lemma map (a stand-in map): bare ㄴ다 forms reach their verb, but a surface that is a dictionary word itself keeps itself (판다, 안다, 멍하니, 파일) with the other readings as alternates; a verb ending in 이다 beats the noun inside it and a noun + 이다 gives the noun; quote marks around a word; and the second opinion (a stand-in for the analyser) as one more candidate after the rules' first answer, ignored when it fails |
| `analyser-lemma-golden.mjs` | The dictionary form read off the Korean analyser's morphemes, `analyserLemma.js` (the lemma resolver's second opinion), on the real analyser: verb endings, noun + 이다, 하다 verbs, a word read in its sentence |
| `search-golden.mjs` | AVI search, `lemmaSearchEngine.js` |
| `grammar-golden.mjs` | Grammar Quiz engine, `grammarQuizEngine.js` |
| `fsrs-golden.mjs` | The flashcard scheduler, `fsrs.js`: grading, due days, spreading intervals, triage, planning triage for a later day (the same answer as moving the clock), the deferral marks and `isDeferred`, the due-day stamp |
| `deferral-outlook-golden.mjs` | The deferral notices, `deferralOutlook.js`: what the daily cap will defer on each of the next 7 days, cards that stay over the cap, a deferral pushing a later day over, the "if today's aren't finished" line, the deferred backlog, the wording, and that the forecast matches the real run on the next two days |
| `srs-pipeline-golden.mjs` | The daily review pipeline, `srsEngine.js`: deferring only over the cap, what it writes (no forecast in the plan, no task), never waiting on the network |
| `review-stats-golden.mjs` | Review records: read before they are written and again at each session start, `reviewStatsGuard.js`; what a grade does to them, `reviewStatsEngine.js` |
| `stamp-due-days-golden.mjs` | The one-time Stamp due days action, `stampDueDays.js`: adds two fields and nothing else, batches, refuses offline |
| `sync-golden.mjs` | The task and settings sync, `useFirestore.js`: loading, the field-level merge at startup and on refresh, field-level saves, tasks deleted on another device, the sync hook |
| `cards-marker-golden.mjs` | Cards in step across devices, `cardsMarker.js` and `cardStamp.js`: marker updates at most every 30 seconds, changed cards read at most once a minute and never during a review |
| `card-stamp-scan-golden.mjs` | Scans `src/` for a flashcard write that leaves out the changed-at stamp (`withCardStamp`) |
| `card-factory-golden.mjs` | Card and deck creation in AVI, `cardFactory.js`: never waits on the network, never makes a duplicate |
| `pending-fields-golden.mjs` | Quick clicks on a Library status button send every click's fields, `pendingFields.js` |
| `service-worker-golden.mjs` | The service worker, `public/sw.js`: page from the network first, saved copy when it doesn't answer, hashed assets from the device, what is never touched, saving a build's files after a deploy |
| `version-check-golden.mjs` | Noticing a newer deployed build, `versionCheck.js` |
| `chunk-loader-golden.mjs` | A page that loads on demand is fetched once and remembered, and a failed load can be tried again, `chunkLoader.js` |
| `lazy-pages-scan-golden.mjs` | Scans `src/` for an ordinary import of Quizzes or Dev Dashboard, which would put it back into the first load |
| `sentence-picker-golden.mjs` | Which words of a pasted sentence start selected in Sentence Input and the reading companion: words already in Word Input, except a word skipped in any source, which starts unselected and is reported so its pill shows faded, `sentenceStaging.js` |
| `lacking-def2-golden.mjs` | Which words lack a Definition 2, counted once per word and never for a skipped row; the order of the fill queue, `lackingDef2.js` |
| `grammar-patterns-golden.mjs` | The grammar pattern recogniser with the real analyser from `src/vendor/garu-ko`: reading titles, skeletons, look-alike traps, 79 test sentences, the Pattern check's report, an entry's own check with and without a hint, and which entries count as too common to collect, `grammarPatterns.js`, `grammarPatternCheck.js`. Uses `load-analyser.mjs` and `fixtures/grammar-patterns.json` |
| `grammar-corrections-golden.mjs` | Correction links with the real analyser: a corrections session's rows as plain text, and which entries they suggest (in the corrected text and not the original; a word change suggests nothing; entries already linked left out; most rows first), `grammarCorrections.js`. Uses `load-analyser.mjs` |
| `grammar-sightings-golden.mjs` | Grammar sightings with the real analyser: which finished sections await a review (the stamp, sentences mined afterwards, sections named alike, section-less sentences of a finished source), what a review offers per entry (most specific first, switched-off entries, sentences already examples, order), what keeping a sighting writes (add, replace, the cap of 6, where it came from), every mined sentence for an entry's own view, and the Library's marks, `grammarSightings.js`. Uses `load-analyser.mjs` |
| `grammar-entries-store-golden.mjs` | Grammar entries read once and again only when they change, `grammarEntriesStore.js`: one marker read when nothing changed, a full read after another device's change, none after this device's own Grammar Index edits, this device's copy when offline |
| `recurrence-golden.mjs` | "Every N days" counts calendar days, and uncompleted SRS spike tasks are dropped at rollover, `recurrenceEngine.js` |
| `theme-golden.mjs` | The themes behind Settings > Appearance: every theme builds a full palette (`buildColors.js`), retired ids open as their successor (`themeIdOf`), the coverage data covers every token (`themeCoverage.js`), and the contrast check's maths (`themeTokens.js`) |
| `time-input-golden.mjs` | The typed time field with its AM/PM toggle, `timeInput.js` |

When a rule changes on purpose, change its case in the same commit and say
why in a comment beside it.

## The deploy gate

`npm run lint:gate` (see `eslint.gate.config.js`) is separate from these
tests. Netlify runs it before every build and stops the deploy on an error,
so the last good version stays live.
