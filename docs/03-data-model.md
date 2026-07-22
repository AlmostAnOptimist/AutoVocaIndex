# Data Model

This document is the contract for every piece of data AVI stores. Firestore is schemaless — nothing enforces these shapes except the code that reads and writes them — so if you extend or modify AVI, this is the reference for what each collection contains, who writes it, and what the readers expect. It pairs with the [architecture guide (02)](02-architecture.md) (which covers how modules connect) and is written against the code as shipped; where behavior is described, the source file is named so you can confirm against the tree.

All Firestore access is client-side through the Firebase SDK. The four Netlify functions never touch Firestore — they talk to external APIs (KRDict, Anthropic, Google Cloud TTS) and return results to the client, which then writes anything that needs persisting (for example, a card's `audioUrl` after TTS generation).

---

## Conventions (read these first)

**Writes.** New documents and updates use `setDoc` with `{ merge: true }` or `updateDoc`; bulk operations (the seed import, the rename/delete cascades) use batched writes under the flush caps described below. Never write `undefined` — Firestore rejects it outright. `null` is the correct "no value." (`QuizzesPage.saveResult` shows the defensive version of this rule: quiz metadata is round-tripped through `JSON.parse(JSON.stringify(...))` before writing, which silently drops any stray `undefined` fields.)

**Absent, `null`, and `[]` are equivalent for optional array fields.** Readers of `dates` / `completedDates` (and similar optional arrays) all guard with `Array.isArray(...)` or `|| []`. When returning a document to a "no value" state, prefer *stripping the field* from the object rather than writing an explicit `null` — both patterns exist in the tree and coexist safely, but new code should strip.

**Document IDs — three patterns are in use:**

| Pattern | Where |
|---|---|
| App-generated `uid()` (`Date.now().toString(36)` + random suffix, from `dateUtils.js`) | `tasks`, `appointments`, `wordInputs`, `sentenceInputs`, `lemmaMaster` |
| Firestore auto-IDs (`addDoc` / `doc(collection(...))`) | `content_sources`, `content_sections`, `decks`, `flashcards`, `quiz_results`, `notes` |
| Deterministic / fixed IDs | `settings/main`, `settings/reviewStats`, `grammar_entries/grammar_{n}`, `reviewLog/{YYYY-MM-DD}`, `dailyplan/{YYYY-MM-DD}`, `decks/deck_grammar`, `grammar_corpus/index`, `globalLemmaMap/{derived key}` |

For the app-generated group, the ID value is also stored as a field on the document (`uid` on AVI input rows, `lemmaID` on lemma entries, `id` on appointments) and the sync layer keys diffs on that field.

**Timestamps and dates.** Full timestamps are ISO 8601 strings (`new Date().toISOString()`); calendar dates are `'YYYY-MM-DD'` strings. There are no Firestore `Timestamp` objects anywhere in the model — this matters most for `globalLemmaMap.updatedAt`, which the trust gate compares *as a string* (see that section).

**The logical day.** Every "what day is it for the user" question goes through `getLogicalToday(dsh)` / `getLogicalDateStr(dsh)`, where `dsh` is `settings.dayStartHour` (default 3). Before the day-start hour, it is still "yesterday." `reviewLog` and `dailyplan` document IDs are logical-day dates, so a 1 a.m. review session lands on the previous day's log.

**Batches.** Batched writes flush at 450–490 operations depending on the site (Firestore's hard cap is 500). If you add bulk-write code, stay under 490 and reuse the existing flush pattern.

**Two persistence styles.** Tasks and the AVI input collections use a *debounced diff sync*: the page edits an in-memory array, and a hook (`useFirestore.js` at 1500 ms, `useAVIData.js` at 800 ms) diffs the previous synced state against the next and writes only changed documents. Everything else uses direct per-document writes at the interaction site. The diff sync includes a delete-all guard: a pass that would delete every document in a collection of more than five is refused and logged, because a sudden many-to-zero jump is almost always a stale-empty-state bug, not an intentional bulk delete (`useAVIData.syncCollection`).

---

## Path map

```
users/{uid}/
  tasks/{uid()}                    appointments/{uid()}
  content_sources/{auto}           content_sections/{auto}
  wordInputs/{row.uid}             sentenceInputs/{row.uid}
  lemmaMaster/{lemmaID}            decks/{auto | deck_grammar}
  flashcards/{auto}                quiz_results/{auto}
  grammar_entries/{grammar_n}      grammar_corpus/index
  notes/{auto}                     reviewLog/{YYYY-MM-DD}
  dailyplan/{YYYY-MM-DD}           meta/grammar_cleanup
  settings/{main | reviewStats | gazetteAdAliases}
globalLemmaMap/{derived key}
dev/{uid}/todos/{...}
```

---

## users/{uid}/tasks/{taskId}

The habit layer's to-do items. Written by the debounced diff sync in `useFirestore.js`; constructed in `AddTaskModal.jsx` / `EditTaskModal.jsx`; recurrence advancement in `recurrenceEngine.js`.

| Field | Type | Notes |
|---|---|---|
| `title` | string | |
| `category` | string | `'lang'` is the only category shipped (see `CATEGORIES` in `constants.js`) |
| `priority` | string | `'high'` \| `'med'` \| `'low'` |
| `date` | string \| null | `'YYYY-MM-DD'` due date; `null` = unscheduled |
| `time` | string \| null | `'HH:MM'` |
| `recurrence` | object | See below. `{ type: 'none' }` when non-recurring |
| `dates` | string[] | Only present on multi-date tasks (2+ dates). Mutually exclusive with recurrence |
| `completedDates` | string[] | Only on multi-date tasks; the subset of `dates` checked off |
| `notes` | string | For `keepRecord` recurring tasks, completion stamps (`[date] Done`) are prepended here on reset |
| `keepRecord` | boolean | |
| `completed` | boolean | |
| `completedAt` | string \| null | Reset to `null` when a recurring task advances |
| `persistent` | boolean | Persistent tasks skip all recurrence/overdue logic |
| `push` | boolean | Push-forward behavior for non-recurring tasks; forced `false` on multi-date tasks |
| `activeToday`, `activatedOn` | boolean, string \| null | Unscheduled-task activation |
| `created` | string | ISO timestamp |
| `linkedSectionId` | string | Present on tasks created from a Content Library section |
| `isAppointmentTask`, `appointmentId`, `apptProvider`, `linkedApptId` | mixed | Present on appointment-linked tasks (reminder tasks and follow-ups) |

**Recurrence object.** `type` is one of `none`, `daily`, `specific_days`, `twice_weekly`, `biweekly`, `every_n_days`, `monthly_date`, `monthly_relative`, `every_x_months_on_date`, `every_x_months_on_weekday`, `yearly` (`RECUR_TYPES` in `constants.js`). Depending on type it also carries `days` (weekday names), `interval` (number), `dayOfMonth`, `week` (`first`/`second`/`third`/`last`), and `dayOfWeek`. When the engine advances a completed recurring task it additionally writes `nextDue` and `lastReset` into the recurrence object.

**Recurrence and `dates` are mutually exclusive by construction** — the modals enforce it, and no recurrence code handles `dates[]`.

## users/{uid}/appointments/{apptId}

Scheduled sessions (tutoring, classes, exchanges). Document ID is `uid()`, duplicated in the `id` field. Written directly from `AppointmentModal.jsx`.

| Field | Type | Notes |
|---|---|---|
| `id` | string | Same as document ID |
| `date`, `time` | string | `time` may be `''` |
| `type` | string | From `APPOINTMENT_TYPES.lang` (`Tutoring`, `Class`, `Language Exchange`, `Other`) plus any `settings.customApptTypes` |
| `provider` | string | |
| `category` | string | `'lang'` |
| `summary`, `results` | string | Pre-session notes / post-session outcomes |
| `outcome` | string \| null | |
| `followUpQueue` | array | `{ id, title, date, notes }`-shaped rows, kept date-sorted; converted to tasks on save |
| `cost`, `costCurrency` | null | Written as literal `null` (legacy single-cost fields) |
| `costs` | array | `{ id, label, date, amount (number), currency, notes }` |
| `taskId` | string \| null | The linked reminder task |
| `lastVisitDate` | string \| null | |
| `created` | string | ISO timestamp |
| `mainSourceId`, `mainSectionId` | string \| null | Content Library links |
| `additionalSources` | array | `{ id, sourceId, sectionId (nullable), done }` |
| `reminderTaskIds` | string[] | |

## users/{uid}/content_sources/{sourceId}

One document per study material (a novel, a drama, a textbook). Firestore auto-ID. Written from `ContentLibraryPage.jsx`.

| Field | Type | Notes |
|---|---|---|
| `title` | string | Also the join key to AVI rows and decks — see the provenance note below |
| `type` | string | From `TYPES` in `contentUtils.js`: `Grammar`, `Grammar: Practice`, `Reading: Bilingual`, `Reading: Korean Only`, `Dubbed`, `Subbed`, `Native`, `Reference` |
| `subtype` | string \| null | |
| `url`, `origin` | string | |
| `levelMin`, `levelMax` | string \| null | |
| `studyIntent` | string \| null | `'mining'` exempts a source from the passive-media exclusion in stats |
| `series`, `seriesOrder` | null | Created as `null` |
| `sourceStatus` | string | `'Not started'`, `'In Progress'`, `'Done'`, ... Read through `getSourceStatus()`, which falls back to the legacy `watchStatus` field on old documents |
| `lastActivityAt` | string \| null | ISO timestamp, bumped by section activity |
| `createdAt` | string | |
| `sectionOrder` | string[] | Optional; section IDs in drag-reorder order. Absent = natural sort |
| `costs` | array | Same row shape as appointment costs |
| `linkedNoteIds` | string[] | Notes linked at source level |
| `isSourceless` | boolean | Present (`true`) only on the special catch-all "Sourceless" source, created on demand by the source-delete cascade |

**Provenance is by title, not ID.** AVI input rows store the source *title* string and section *content* string (see `wordInputs`), and deck auto-creation matches `deck.name === source title`. Renaming a source is handled by an app-level cascade that rewrites dependent rows — if you write your own tooling, do not rename a source title in isolation.

## users/{uid}/content_sections/{sectionId}

Chapters/episodes/units of a source. Firestore auto-ID.

| Field | Type | Notes |
|---|---|---|
| `content` | string | The section label — created as `'1'`, `'2'`, ... but freely editable text; natural-sorted for display, with "Information" sections floated first |
| `resourceId` | string | Parent source's document ID |
| `status` | string | `'Not started'`, `'Scheduled'`, `'In Progress'`, `'Done'`, `'Skip'` |
| `previousStatus` | string \| null | Stashed when marking Done so undo can restore |
| `url` | string \| null | |
| `linkedTaskId` | string \| null | The task created by "Schedule" |
| `lastActivityAt` | string | |
| `createdAt` | string | |
| `glossaryTermIds` | string[] | Grammar Index entries noticed in this section (the grammar↔section link lives here, on the section) |
| `linkedNoteIds` | string[] | Notes linked to this section |

## users/{uid}/wordInputs/{row.uid}

The staging table for word entries — the heart of the Gather step. Synced by the diff layer in `useAVIData.js`, keyed on the row's `uid` field. Rows are constructed identically at all three intake sites (Word Input, the Sentence Input word picker in `AVISentenceInputPage.handlePopupDone`, and Import's `buildCommitRows` in `importEngine.js`).

| Field | Type | Notes |
|---|---|---|
| `uid` | string | `uid()`; also the document ID |
| `ts` | string | ISO timestamp of entry |
| `input` | string | The surface form exactly as encountered |
| `source` | string | Source **title** (provenance) |
| `section` | string | Section **content** string |
| `lemma` | string | The resolved lemma (editable; correcting it fires the map loop) |
| `def1` | string | Reference definition (KRDict or AI fetch) |
| `def2` | string | The user's targeted definition — the one that goes on cards |
| `uploaded` | boolean | `true` once a flashcard has been created from this row |
| `skipUpload` | boolean | User opted this row out of card creation |
| `lastUncheckReason`, `lastUncheckDate` | string | Why/when a row was unchecked from upload; `''` when unused |

## users/{uid}/sentenceInputs/{row.uid}

Mined sentences, one row per (sentence, target word) pair — a sentence with two target words produces two rows, each becoming its own card.

| Field | Type | Notes |
|---|---|---|
| `uid`, `ts` | string | As above |
| `sentence` | string | Full sentence |
| `targetWord` | string | The lemma this row studies |
| `inputForm` | string | The surface form as it appears in the sentence; `''` if the lemma-form was typed directly |
| `cardFront` | string | `targetWord + '\n' + sentence` |
| `cardBack` | string | Definition text (from `def2`, falling back to `def1`) |
| `source`, `section` | string | Title/content strings, as on word rows |
| `uploaded`, `skipUpload`, `lastUncheckReason`, `lastUncheckDate` | | As on word rows |

## users/{uid}/lemmaMaster/{lemmaID}

One row per resolved lemma — the record behind the Lemma Master page and the fan-out point of the master loop. Document ID is the row's `lemmaID` field.

| Field | Type | Notes |
|---|---|---|
| `lemma` | string | The headword as entered/resolved |
| `cleanedLemma` | string | `normalizeLemma(lemma)` — the normalized join key used everywhere lemmas are matched |
| `def1`, `def2` | string | Reference and targeted definitions; editing here cascades to linked rows and cards |
| `relatedForm`, `relatedMeaning`, `hiddenRelated` | string | Related-word annotations |
| `lastUpdated` | string | ISO timestamp |
| `autoAddedBy` | string | Provenance of auto-created entries (`'pick'` from the sentence picker, `'import'` from Import); absent on manually created entries |
| `originUID` | string | `uid()` at creation |
| `lemmaID` | string | `uid()`; also the document ID |

Flashcards link back here via `linkedAVILemmaId` (= `lemmaID`). The cascade helper falls back to matching on normalized lemma text for cards created with a `null` link, and repairs the ID link as a side effect (`aviUtils.js`).

## users/{uid}/decks/{deckId}

| Field | Type | Notes |
|---|---|---|
| `name` | string | Word decks are named after the source title; sentence decks are `` `${source} (sentence mining)` `` |
| `linkedSourceId` | string \| null | Content Library source ID, resolved by title at creation |
| `description` | string | |
| `createdAt` | string | |
| `totalCards` | number | Maintained with `increment(1)` on card creation |
| `lastStudied` | string | Written at session end |
| `paused` | boolean | Paused decks are held out of triage, due counts, and the spike forecast; a card only counts as paused if *every* deck it belongs to is paused |

The Grammar deck uses the fixed ID `deck_grammar`. The Flashcards page also presents virtual collections (`all`, `all_words`, `all_sentences`) — these are UI-only deck IDs and are never stored.

Deck find-or-create during card auto-creation is race-safe via a shared in-flight promise map keyed on `(uid, deckName)` (`cardFactory.resolveDeckId`) — concurrent card creations for a new source await one creation instead of each creating a duplicate.

## users/{uid}/flashcards/{cardId}

Firestore auto-ID. Three card types share one collection, discriminated by `type`.

**Fields common to all types** (set at creation in `cardFactory.js` / `GrammarIndexPage.jsx`):

| Field | Type | Notes |
|---|---|---|
| `type` | string | `'vocab'` \| `'sentence'` \| `'grammar'` |
| `front`, `back`, `notes` | string | |
| `deckIds` | string[] | Cards can belong to multiple decks |
| `linkedAVILemmaId` | string \| null | → `lemmaMaster.lemmaID` |
| `linkedGrammarEntryId` | string \| null | → grammar entry ID (grammar cards only) |
| `gapEvents` | array | Grading history events |
| `triageBucket`, `lastTriageDate` | string \| null | Written by the daily pipeline's overdue triage |
| `createdAt` | string | |
| `easeFactor`, `interval`, `repetitions`, `nextDueDate`, `lastGrade`, `lastReviewed` | mixed | **SM-2-shaped creation fields.** Every card is created with these placeholder values (`2.5 / 1 / 0 / today / null / null`); the first grade writes the FSRS fields, which supersede them |

**FSRS fields**, written by `gradeCard` in `fsrs.js` on every grade of a vocab/sentence card:

| Field | Type | Notes |
|---|---|---|
| `state` | string | `'new'` → `'learning'` / `'relearning'` → `'review'` |
| `stability` | number | 4-decimal float |
| `difficulty` | number | 4-decimal float |
| `due` | string | ISO timestamp; an Again grade writes a due 1 second in the past so the card re-surfaces immediately |
| `lastReview` | string | ISO timestamp (distinct from the legacy `lastReviewed`) |
| `reps`, `lapses` | number | |

**Dual-format readers.** Because a card carries only the creation-shape fields until its first grade — and an ungraded card keeps them indefinitely — the due/new helpers accept both formats: `getDueDateStr` reads `due` (FSRS) or `nextDueDate` (legacy), and `isNewCard` treats a card with no `state` field as new only if it also has no `lastGrade`, `lastReviewed`, or `reps`. Presence of `stability` is the "is this an FSRS card" test throughout.

**Type-specific fields.** Vocab: `lemma`. Sentence: `lemma`, `sentence`, `inputForm`. Grammar: created with `nextDueDate: null` (scheduled only after its first Grammar Deck review).

**Grammar cards are graded outside FSRS.** `FlashcardsPage.handleGrade` branches on type: a grammar grade writes only `{ due: null, lastReview, lastGrade, reps, gapEvents }` (history capped at the last 100 events) — no stability/difficulty, no interval math. Grammar grades also do **not** write to `reviewLog` or `reviewStats`; those track FSRS reviews only.

**TTS fields** (written by `ttsUtils.js` after async generation): `audioUrl` (vocab front audio), `sentenceAudioUrl` (sentence audio), `exampleAudio` (array of per-line clips for grammar-entry example blocks; setting it clears the legacy single-clip `audioUrl` to `null`).

## users/{uid}/quiz_results/{resultId}

One document per completed quiz session. `{ type, score (0–100, one decimal), correct, total, date (ISO), meta }` — `meta` is quiz-type-specific and is JSON-cleaned before writing (the `undefined`-stripping backstop). Loaded with `orderBy('date', 'asc')` and cached in localStorage per user (`avi_quiz_results_{uid}`) for instant paint.

## users/{uid}/grammar_entries/{grammar_n}

Grammar Index entries. Document ID is `` `grammar_${entryNumber}` ``.

| Field | Type | Notes |
|---|---|---|
| `glossaryTerm` | string | The pattern name |
| `compareTo` | string | Similar patterns as a **pipe-separated** string (`A | B | C`) — pipes because commas legitimately occur inside Korean grammar titles |
| `explanation`, `examples` | string | Free text |
| `masteryLevel` | string | `introduced` \| `practicing` \| `confident` \| `mastered` |
| `masteryLevelChangedAt` | string | Stamped only when the level actually changes |
| `entryNumber` | number | |
| `createdAt` | string | |

Creating an entry also creates its linked grammar flashcard in `deck_grammar` (front = `glossaryTerm`, back = `compareTo`). The entry→section link is stored on the *section* (`glossaryTermIds`), and entry→note links are stored on the *note* (`linkedGrammarIds`) — the entry document itself carries no link arrays.

## users/{uid}/grammar_corpus/index

A single denormalized document rebuilt (debounced 2 s) whenever grammar entries change, so the grammar-quiz function call can send a compact corpus instead of the client re-deriving it: `{ entries: [{ id, term, level, compareTo, explanation }], updatedAt }`.

## users/{uid}/notes/{noteId}

Notes, questions, and corrections share this collection, discriminated by shape.

**Regular notes** (questions are notes whose `tags` include `'question'`): `title`, `bodyHtml` (rich text), `tags` (string[]), `answered` (boolean, for questions), `linkedGrammarIds` (string[]), `linkedSourceId` / `linkedSectionId` / `linkedApptId` (string \| null), `createdAt`, `updatedAt`.

**Correction sets** (`type: 'correction'`): `title`, `rows` (array of `{ topic, original, corrected }`), `sourceId` / `sectionId` / `linkedApptId` (string \| null), `locked` (boolean), `createdAt`, `updatedAt`. The grammar-quiz assessment path creates these directly via `createCorrectionNote.js` with an additional `sourceLabel` field.

## users/{uid}/reviewLog/{YYYY-MM-DD}

One document per logical day with a single `count` field, written with `increment(1)` per FSRS grade. Grammar reviews are excluded by design. This is the raw feed for the activity heatmap.

## users/{uid}/settings/reviewStats

An incrementally maintained aggregate over `reviewLog` so the Flashcards page never re-reads the whole history: `{ totalAllTime, bestDay {date, count}, bestWeek {weekStart, count}, bestMonth {ym, count}, longestStreak {length, endDate}, currentWeekStart, currentWeekCount, currentMonthYM, currentMonthCount, lastReviewDate, currentStreakLength }` (`reviewStatsEngine.js`). Weeks start Monday, matching the heatmap grid. Ties keep the original record date. Updated per grade via `applyReviewToStats`; a full recompute exists as a DevDashboard repair tool. **May not exist yet on a fresh account — readers must tolerate its absence.**

## users/{uid}/dailyplan/{YYYY-MM-DD}

The once-per-logical-day SRS pipeline cache (`srsEngine.js`): `{ logicalDate, pipelineOutput: { date, triaged, dueAtDayStart, spikes, spikeDetected, generatedAt }, generatedAt }`. `dueAtDayStart` freezes the day's due total for the Today page; the post-session spike re-run patches only `pipelineOutput.spikes` / `pipelineOutput.spikeDetected` via dot-notation `updateDoc`.

## users/{uid}/settings/main

The single shared settings document. Two writers merge into it independently: the app-settings sync (`useFirestore.js`) and the AVI-settings sync (`useAVIData.js`, which reads/writes only `avi`-prefixed keys). The active theme is stored here (`theme`) *and* mirrored to localStorage (`avi_theme`) for first paint — Firestore wins at boot. Sound preferences, by contrast, are localStorage-only (`avi_sound`, `avi_quiz_sounds`).

| Field | Default | Notes |
|---|---|---|
| `theme` | `'ember'` fallback; new accounts seeded `'hanok'` | Active theme id; restored from here at boot and re-mirrored to localStorage |
| `dayStartHour` | 3 | The `dsh` behind the logical-day convention |
| `defaultCategory` | | |
| `fsrs` | `{}` | `{ desiredRetention (0.9), maximumInterval (1095), graduatingInterval (1), easyInterval (3) }`; each key falls back to `FSRS_DEFAULTS` |
| `ttsEnabled`, `ttsSpeed`, `autoTtsOnImport` | | TTS toggles |
| `anthropicApiKey` | | Stored from Settings; used client-side as the "grammar quizzes enabled" gate (`QuizzesPage.handleGrammarStart` returns early without it). The serverless functions authenticate with their own `ANTHROPIC_API_KEY` environment variable — this field's value is not what the server uses |
| `customApptTypes` | | Extra appointment types; readers accept array or keyed-object-of-arrays |
| `exchangeRates`, `ratesUpdated` | | `{ USD, EUR, ... }` as KRW-per-unit numbers; `ratesUpdated` is a `'YYYY-MM-DD'` stamp |
| `adriftDays` | | Unscheduled-task aging threshold |
| `aviCurrentSource`, `aviCurrentSection` | `''` | The active intake target — stored as title/content **strings**, and rewritten by the source-rename/delete cascades |
| `aviDictMode` | `'krdict'` | |
| `aviLemmaSortOrder` | `'recent'` | |
| `aviChartOrder` | `[]` | |
| `aviOverviewStatVis` | `{ words: true, sentences: true }` | |
| `aviShowSourcelessInOverview` | `true` | |
| `aviNoiseBlocks` | `[]` | |
| `aviStopwordProfile` | `''` | |
| `aviApiRateLimit` | `5` | Client-side throttle on definition fetches |
| `aviImportKnownSentences` | `false` | The Import intake toggle for sentence rows of already-known words |

**May not exist on a fresh account** — every reader falls back to defaults, and the AVI extractor returns a full default object when the document is absent.

## users/{uid}/settings/gazetteAdAliases and users/{uid}/meta/grammar_cleanup

`gazetteAdAliases` is a `{ filename: aliasString }` map for Gazette plate labeling, edited from DevDashboard; the Gazette degrades gracefully when it is absent or empty. `meta/grammar_cleanup` is a one-time migration flag document.

---

## globalLemmaMap/{key} (top-level)

The surface-form→lemma lookup behind the Resolve step. It lives at the top level (outside `users/{uid}`, alongside the DevDashboard's `dev` tree), but in a personal deployment it is yours alone: it sits in your own Firebase project, populated by the shipped seed and grown by your corrections, and nothing about it leaves your project. In a deliberate multi-user deployment — a study group or family sharing one Firebase project — every user reads and writes the same map and improves it together, which is why the rules scope it to any authenticated user rather than a single owner. Access is **per-key `getDoc` only**; nothing ever loads the collection, so read cost scales with words resolved, not map size. All logic lives in `aviUtils.js`.

**Key derivation** (`globalLemmaKey`): trim → lowercase → whitespace to `_` → `/` and `\` to `-` → cap at 200 chars → `'_empty'` fallback.

| Field | Type | Notes |
|---|---|---|
| `cleanedLemma` | string | The mapped lemma |
| `contributorCount` | number | Incremented when a write agrees with the stored mapping |
| `updatedAt` | string | **ISO string, compared as a string.** Load-bearing — see the trust gate |

**The trust gate.** The map ships bulk-seeded, and the seed includes machine-generated errors among rows that *rewrite* the surface. An entry is treated as *organic* (fully trusted) if `updatedAt >= '2026-03-24'` (a string comparison against the seed cutoff) or `contributorCount >= 2`. A non-organic entry is still trusted as *headword evidence* if its mapping merely restates its own key (`globalLemmaKey(cleanedLemma) === key`), but its rewrite mapping is not followed on its own authority: it is used when corroborated by an independently derived heuristic candidate, or — as a last-resort structural fallback — when the rewrite is structurally consistent with the surface (`seedMappingPlausible`: a strip-shaped prefix of the surface, or a 다-final headword sharing the surface's leading jamo without ballooning in length). A user correction writes an organic row that permanently outranks both paths.

**Resolution order** (`resolveLemmaWithDictionary`): trusted map hit on the raw/normalized/`+요` key variants → local-headword validation (a de-conjugation candidate the user already studies in `lemmaMaster` is accepted immediately) → dictionary/headword validation of candidates against the map → seed corroboration as last resort (an untrusted seed mapping is followed only if it exactly matches an independently derived candidate — two independent signals) → the top heuristic candidate. Dictionary validation deliberately outranks seed corroboration, because the seed was generated with the same naive suffix assumptions as the heuristic.

**Write policy** (`writeGlobalLemma`, fired only on *explicit user corrections* at intake sites): agreement increments `contributorCount`; a correction that conflicts with a non-organic (seed-era) row overwrites it; a conflict with an organic row is silently dropped — **first-writer-wins**. That is fine for a single-user deployment and a documented limitation for shared multi-user maps. The whole write is try/catch-wrapped and no-ops silently if rules ever deny it — map learning is best-effort by design, and intake keeps working without it. Preserve that failure tolerance if you modify the write path.

**Seeding.** `seed/globalLemmaMap.json` plus the import script populate the map. The `updatedAt` values must be imported **verbatim** — an import that stamps "now" would promote every pre-cutoff junk row past the trust gate. The seed is Korean-specific; other languages start with an empty map, and everything above still works (the map just grows organically).

---

## dev/{uid}/todos

DevDashboard's own to-do list, deliberately outside `users/{uid}`. Nothing in the production UI reads it.

---

## Security rules and indexes

The shipped `firestore.rules` express single-install semantics: `users/{uid}/**` and `dev/{uid}/**` are readable/writable only by their owner; `globalLemmaMap/{key}` is readable and writable by any authenticated user. Because the user match is a recursive wildcard (`{document=**}`), **any new subcollection you add under `users/{uid}` is automatically covered** — no rules change needed.

The app's queries are simple — whole-collection `getDocs` plus a few single-field queries (`quiz_results` ordered by `date`, an `isSourceless` equality lookup) — which Firestore's automatic single-field indexes cover. The shipped `firestore.indexes.json` is deliberately empty (`{ "indexes": [], "fieldOverrides": [] }`): no query in the app requires a composite index, so the empty list is the correct state, not a failed export. Deploy it alongside the rules; if you ever add a query that needs a composite index, this file is where it lives.

---

## Extending the model

AVI ships language-only, and the data model is built to be added to. If you want to track something new alongside your studies — a reading log with page counts, a tutoring budget, listening-hours stats — the pattern is already in front of you: add a collection under `users/{uid}` (the rules cover it automatically), follow the conventions at the top of this document (ISO strings, `'YYYY-MM-DD'` dates through the logical day, `null` never `undefined`, app IDs via `uid()` if you want diff-syncable rows), and pick one of the two persistence styles. `quiz_results` is a good minimal template for an append-only log; `tasks` + `useFirestore.js` is the template for an edited-in-memory, diff-synced collection; and the pure-engine pattern (`recurrenceEngine.js`, `reviewStatsEngine.js` — no React, no Firestore) is the place to put any derived math. Existing collections can be extended the same way: unknown fields are ignored by readers, so adding a field is safe as long as you supply it a `null`-safe default everywhere you read it.
