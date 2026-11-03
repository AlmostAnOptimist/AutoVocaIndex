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
| Firestore auto-IDs (`addDoc` / `doc(collection(...))`) | `content_sources`, `content_sections`, `decks`, `flashcards`, `quiz_results`, `echo_sessions`, `notes` |
| Deterministic / fixed IDs | `settings/main`, `settings/reviewStats`, `grammar_entries/grammar_{n}`, `reviewLog/{YYYY-MM-DD}`, `dailyplan/{YYYY-MM-DD}`, `decks/deck_grammar`, `grammar_corpus/index`, `globalLemmaMap/{derived key}` |

For the app-generated group, the ID value is also stored as a field on the document (`uid` on AVI input rows, `lemmaID` on lemma entries, `id` on appointments) and the sync layer keys diffs on that field.

**Timestamps and dates.** Full timestamps are ISO 8601 strings (`new Date().toISOString()`); calendar dates are `'YYYY-MM-DD'` strings. There are no Firestore `Timestamp` objects anywhere in the model — this matters most for `globalLemmaMap.updatedAt`, which the trust gate compares *as a string* (see that section).

**The logical day.** Every "what day is it for the user" question goes through `getLogicalToday(dsh)` / `getLogicalDateStr(dsh)`, where `dsh` is `settings.dayStartHour` (default 3). Before the day-start hour, it is still "yesterday." `reviewLog` and `dailyplan` document IDs are logical-day dates, so a 1 a.m. review session lands on the previous day's log. The same rule applies to everything derived from a timestamp: FSRS due dates count from the logical day, and AVI's Added Today, heatmap and streaks, the Gazette activity map, quiz charts and ranges, and Echo dates all bucket a stored ISO timestamp by the logical day it falls on (`logicalDateOf(iso, dsh)` in `dateUtils.js`), never by its UTC date (`iso.slice(0, 10)` is a day off for anything stored before 9 a.m. in Korea).

**Batches.** Batched writes flush at 450–490 operations depending on the site (Firestore's hard cap is 500). If you add bulk-write code, stay under 490 and reuse the existing flush pattern.

**Two persistence styles.** Tasks and the AVI input collections use a *debounced diff sync*: the page edits an in-memory array, and a hook (`useFirestore.js` at 1500 ms, `useAVIData.js` at 800 ms) diffs the previous synced state against the next and writes only changed documents — tasks whole, existing AVI rows field by field (`updateDoc` of the changed fields; a removed field is `deleteField()`), `settings/main` key by key. Waiting changes are also written when the page is hidden. A refresh from Firestore is merged into what's on screen rather than replacing it (an edit not yet saved wins; other devices' changes, additions and deletions come in), and a row deleted on another device stays deleted even if it was edited here. Everything else uses direct per-document writes at the interaction site. The diff sync includes a delete-all guard: a pass that would delete every document in a collection of more than five is refused and logged, because a sudden many-to-zero jump is almost always a stale-empty-state bug, not an intentional bulk delete (`useAVIData.syncCollection`).

---

## Path map

```
users/{uid}/
  tasks/{uid()}                    appointments/{uid()}
  content_sources/{auto}           content_sections/{auto}
  wordInputs/{row.uid}             sentenceInputs/{row.uid}
  lemmaMaster/{lemmaID}            decks/{auto | deck_grammar}
  flashcards/{auto}                quiz_results/{auto}
  echo_sessions/{auto}
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
| `completedAt` | string \| null | Reset to `null` when a recurring task advances or a task is reset |
| `persistent` | boolean | Persistent tasks skip all recurrence/overdue logic |
| `push` | boolean | Push-forward behavior for non-recurring tasks; forced `false` on multi-date tasks |
| `activeToday`, `activatedOn` | boolean, string \| null | Unscheduled-task activation |
| `autoDatedOnComplete` | boolean | Set when a dateless, non-recurring task is completed: `date` is filled with that logical day so the task leaves Unscheduled and stays on the month calendar as a done record (struck through on desktop, a faded dot on mobile). Unchecking it clears `date` and returns it to Unscheduled |
| `source` | string | `'srs_forecast'` on spike-warning tasks created by the daily pipeline. One left unchecked after its day (or left with no date by the 14-day overdue rule) is deleted by the recurrence engine instead of moving to Overdue; a checked-off one stays like any task (`isMissedSpikeTask`) |
| `srsReconciledDate` | string | Spike tasks only. On the task's own day the pipeline rewrites the card count in its title to the actual day-start total, or completes the task if that total is at or under `srsSpikeCap`; this stamp limits that to once per day so a manual uncheck or rename is never overridden |
| `created` | string | ISO timestamp |
| `linkedSectionId` | string | Present on tasks created from a Content Library section |
| `isAppointmentTask`, `appointmentId`, `apptProvider`, `linkedApptId` | mixed | Present on appointment-linked tasks (reminder tasks and follow-ups) |
| `sortOrder`, `sortOrderDate` | number, string | Manual drag order (Today, Upcoming). The rank counts only on `sortOrderDate`, the day it was dragged on; on any other day the task sorts normally. A `sortOrder` without `sortOrderDate` (from before this rule) is ignored |

Fields starting with `_` (`_dateOcc`, `_doneRecord`) exist only on render copies — Upcoming shows each day of a multi-date task, and done records, as copies — and are never stored. Edit Task opens the stored task, never the copy, and saves only the fields you changed onto the task as it is at Save (`applyTaskEdit` in `taskEdit.js`), so a completion, roll or refresh that landed while the modal was open is kept. `firestoreLoad` strips any `_` field that reached Firestore before this rule, and the boot load writes the cleaned docs back once.

**Recurrence object.** `type` is one of `none`, `daily`, `specific_days`, `twice_weekly`, `biweekly`, `every_n_days`, `monthly_date`, `monthly_relative`, `every_x_months_on_date`, `every_x_months_on_weekday`, `yearly` (`RECUR_TYPES` in `constants.js`). Depending on type it also carries `days` (weekday names), `interval` (number), `dayOfMonth`, `week` (`first`/`second`/`third`/`last`), and `dayOfWeek`. When the engine advances a completed recurring task it additionally writes `nextDue` and `lastReset` into the recurrence object. Completing a recurring task stores `nextDue` as the date the engine will actually move it to (`nextDueAfterCompletion`; "every N days" counts from the due date). A task several occurrences behind catches up in one engine run (`rollRecurringTask`), not one step per run.

**Recurrence and `dates` are mutually exclusive by construction** — the modals enforce it, and no recurrence code handles `dates[]`.

## users/{uid}/appointments/{apptId}

Scheduled sessions (tutoring, classes, exchanges). Document ID is `uid()`, duplicated in the `id` field. Written from `AppointmentModal.jsx`, by the follow-up promotion effect in `App.jsx`, and by `saveTask` when the linked task is edited. Every update is field-level: the modal sends the payload it would have saved untouched along with the new one, and App applies only the changed fields onto the appointment as it is at Save (`applyFieldEdits` in `taskEdit.js`; an appointment deleted while the modal was open is not recreated); promotion and section links are merge writes of their own fields (`patchAppointment`); the linked-task edit writes results, category, date, time and the follow-up queue only when they were changed in that modal. A new appointment is written whole.

| Field | Type | Notes |
|---|---|---|
| `id` | string | Same as document ID |
| `date`, `time` | string | `time` may be `''` |
| `type` | string | From `APPOINTMENT_TYPES.lang` (`Tutoring`, `Class`, `Language Exchange`, `Other`) plus any `settings.customApptTypes` |
| `provider` | string | |
| `category` | string | `'lang'` |
| `summary`, `results` | string | Pre-session notes / post-session outcomes |
| `outcome` | string \| null | |
| `followUpQueue` | array | `{ date, time }` entries (`time` may be `''`), kept date-sorted. When the appointment's date passes, the earliest queued date becomes its new `date`/`time` and each passed date is logged into `results` as a `[YYYY-MM-DD]` line, once per date (`planFollowUpPromotion` in `apptPromotion.js` skips a date already stamped at the start of a line). Editable from `AppointmentModal.jsx` or from the linked task's edit window (`EditTaskModal.jsx`). Legacy single `followUpDate` / `followUpTime` fields are migrated into the queue on read and stripped or nulled on write |
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
| `type` | string | From `TYPES` in `contentUtils.js`: `Grammar`, `Grammar: Practice`, `Reading: Bilingual`, `Reading: Korean Only`, `Dubbed`, `Subbed`, `Native`, `Reference`. A source with any other value (a removed type) is listed under Reference with a "type not set" flag, and its type picker shows "Choose type…" (`isKnownSourceType`) |
| `subtype` | string \| null | Under Reference, `'YouTube'` marks a YouTube channel kept for listening or reinforcement: its sections are videos, it shows a watch line ("3 watched · 2 to watch · last watched Oct 12") instead of a progress bar, watched videos list below the rest, it sits in its own group below the other references, and it stays passive media (`isYouTubeReference` in `contentUtils.js`) |
| `url`, `origin` | string | |
| `levelMin`, `levelMax` | string \| null | |
| `studyIntent` | string \| null | `'mining'` exempts a source from the passive-media exclusion in stats |
| `series`, `seriesOrder` | string \| null, number \| null | Created as `null`; set from the source's detail panel. Sources sharing a `series` name, in `seriesOrder`, form a series (series decks, below) |
| `sourceStatus` | string | `'Not started'`, `'In Progress'`, `'Done'`, ... Read through `getSourceStatus()`, which falls back to the legacy `watchStatus` field on old documents |
| `lastActivityAt` | string \| null | ISO timestamp, bumped by section activity — a section marked Done or In Progress or scheduled, wherever that happens (Library, Today, Appointments, Planner; `sectionDoneWrites` in `contentUtils.js`) |
| `createdAt` | string | |
| `sectionOrder` | string[] | Optional; section IDs in drag-reorder order. Absent = natural sort |
| `costs` | array | Same row shape as appointment costs |
| `linkedNoteIds` | string[] | Notes linked at source level |
| `isSourceless` | boolean | Present (`true`) only on the special catch-all "Sourceless" source, created on demand by the source-delete cascade |
| `pendingArchive`, `pendingArchiveDate` | boolean, string | Set when the source's last open section is finished (every section Done or Skip), wherever it was finished |

**Active and Adrift** are computed on every render, nothing stored (`useLibraryOverviewData.js`): a started source goes Adrift once it has had no qualifying activity for `adriftDays`, even with sections Done or In Progress. A Scheduled source or section holds it in Active only while its task's date is today or later; an overdue schedule doesn't count. Word lists (the 동의어 source, Reference › Word List) and passive media stay off the Overview.

**Provenance is by title, not ID.** AVI input rows store the source *title* string and section *content* string (see `wordInputs`), and deck auto-creation matches `deck.name === source title`. Renaming a source is handled by an app-level cascade that rewrites dependent rows — if you write your own tooling, do not rename a source title in isolation.

## users/{uid}/content_sections/{sectionId}

Chapters/episodes/units of a source. Firestore auto-ID.

| Field | Type | Notes |
|---|---|---|
| `content` | string | The section label — created as `'1'`, `'2'`, ... but freely editable text; natural-sorted for display, with "Information" sections floated first |
| `resourceId` | string | Parent source's document ID |
| `status` | string | `'Not started'`, `'Scheduled'`, `'In Progress'`, `'Done'`, `'Skip'` |
| `previousStatus` | string \| null | Stashed when marking Done so undo can restore |
| `url` | string \| null | On a YouTube reference's videos, the link pasted with + Add videos (one section per pasted line; a line that is a link is both the title and the `url`) |
| `linkedTaskId` | string \| null | The task created by "Schedule". Deleting the section or its source, or moving it to Not started or Skip, deletes that task if it is an unfinished one-off (a recurring one only loses the link; a finished one is history and stays); In Progress keeps it |
| `lastActivityAt` | string | |
| `createdAt` | string | |
| `glossaryTermIds` | string[] | Grammar Index entries noticed in this section (the grammar↔section link lives here, on the section) |
| `linkedNoteIds` | string[] | Notes linked to this section |

## users/{uid}/wordInputs/{row.uid}

The staging table for word entries — the heart of the Gather step. Synced by the diff layer in `useAVIData.js`, keyed on the row's `uid` field. Rows are constructed identically at every intake site: Word Input and the Search tab's Add to Word Input (both through `stageWordInput` in `wordStaging.js`, which also runs the duplicate guard, the def1 fetch, the Lemma Master entry and the auto card), the Sentence Input word picker in `AVISentenceInputPage.handlePopupDone`, and Import's `buildCommitRows` in `importEngine.js`.

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
| `skipUpload` | boolean | User opted this row out of card creation. Skip is per word per source: new rows of a word skipped in that source start skipped, skipping a word also skips its sentence rows there, and turning Skip on for a word that already has a card asks whether to remove it |
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
| `cardBack` | string | The lemma's `def2`, the same as the word card's back. A row whose lemma has no `def2` yet keeps an empty back and gets no card; the card is created once the lemma gets a `def2`, wherever it is written. Every `def2` change goes through one writer (`applyDef2Write` in `def2Cascade.js`), which updates the Lemma Master entries, the word and 동의어 rows, every sentence back and every card back together; clearing a `def2` keeps the existing backs until a new one is saved. A back may be the word's `def1` only while the word has no `def2` |
| `source`, `section` | string | Title/content strings, as on word rows |
| `uploaded`, `skipUpload`, `lastUncheckReason`, `lastUncheckDate` | | As on word rows |
| `skippedWithWord` | boolean | `true` on a sentence row skipped because its word was skipped in that source; un-skipping the word un-skips only these, and asks about the word's other skipped sentence rows (`wordSkip.js`). Absent otherwise |

## users/{uid}/lemmaMaster/{lemmaID}

One row per resolved lemma — the record behind the Lemma Master page and the fan-out point of the master loop. Document ID is the row's `lemmaID` field.

| Field | Type | Notes |
|---|---|---|
| `lemma` | string | The headword as entered/resolved |
| `cleanedLemma` | string | `normalizeLemma(lemma)` — the normalized join key used everywhere lemmas are matched |
| `def1`, `def2` | string | Reference and targeted definitions; editing here cascades to linked rows and cards |
| `relatedForm`, `relatedMeaning`, `hiddenRelated` | string | Related-word annotations: comma-separated `lemmaID`s, set by pinning, hiding and Connect List in Search (`applyRelationPin` / `applyRelationConnect`). Echo counts `relatedMeaning` lemmas as correct answers and treats `relatedForm` lemmas as close answers |
| `echoAlternates` | string[] | Answers saved as correct from the Echo Quiz ("Save as alternate"). Written alone with `arrayUnion` / `arrayRemove`, hidden on the Lemma Master page, and unioned when two entries are merged. An array, not a comma string, because English alternates can contain commas. Absent until the first save |
| `lastUpdated` | string | ISO timestamp |
| `autoAddedBy` | string | Provenance of auto-created entries (`'pick'` from the sentence picker, `'import'` from Import); absent on manually created entries |
| `originUID` | string | `uid()` at creation |
| `lemmaID` | string | `uid()`; also the document ID |

Deleting an entry removes its id from every other entry's relation fields; a merge repoints them to the survivor (`stripLemmaRelations`), so a word whose only synonym is gone leaves the 동의어 source and its card leaves that deck.

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

**Series decks are virtual too.** For each Content Library series, `buildSeriesGroups` (`seriesDecks.js`) matches its sources' decks by title and offers a word series deck and a "(sentence mining)" series deck once at least two books have a deck of that kind. Nothing is stored: a series session pools the books' own cards (one per word, the most overdue; cards paused in every deck skipped) and writes no `lastStudied`. Quizzes select a series with the tokens `series:<name>` / `series-sm:<name>`, expanded to the books' deck ids at start (`expandDeckSelection`); pause and reverse stay per book.

**One word card per series.** A new word row in a series book whose word already has a card in another book of that series joins that card (the book's deck is added to its `deckIds`, the deck's `totalCards` goes up) instead of creating a second card, so review history carries across books (`findSeriesCard` / `joinCardToDeck` in `cardFactory.js`; vocab only, sentence cards stay per book). Flashcards Clean up merges words carded separately before this rule: the card with more history survives (`compareHistorySurvivor`: reviewed over new, then more reps, then earliest `createdAt`) and the others leave the series' decks (`planSeriesShare` in `cardDedupe.js`).

**Decks are found by name, so two decks with one name split a source's cards.** Clean up cards first merges same-name decks (`mergeSameNameDecks`): the deck with the most cards survives (then the earliest `createdAt`, then id), the others' cards move in, one card per word per deck is restored, emptied decks are deleted, and the survivor's `totalCards` is recounted and its `linkedSourceId` pointed at the live source of that title. A source rename onto a title that already has a deck runs the same merge.

Deleting a deck deletes the cards that are in no other deck; a card also in a deck you keep only leaves the deleted one, with its review history.

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
| `triageBucket`, `lastTriageDate` | string \| null | Written by the daily pipeline's overdue triage. A deferral moves only the due date (logical today + about 70% of stability); stability and difficulty are left alone |
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

**One card per word per deck.** A vocab card is identified by deck + normalized lemma, a sentence card by deck + lemma + NFC sentence. Every card-creating path passes the cards in memory to the factory's duplicate guard, and merges, corrections and Flashcards Cleanup collapse duplicates with one survivor rule: a reviewed card over a new one, then the earliest `createdAt`, then id (`cardDedupe.js`). A duplicate also in another deck only leaves this one.

**Type-specific fields.** Vocab: `lemma`. Sentence: `lemma`, `sentence`, `inputForm`. Grammar: created with `nextDueDate: null` (scheduled only after its first Grammar Deck review).

**Grammar cards are graded outside FSRS.** `FlashcardsPage.handleGrade` branches on type: a grammar grade writes only `{ due: null, lastReview, lastGrade, reps, gapEvents }` (history capped at the last 100 events) — no stability/difficulty, no interval math. Grammar grades also do **not** write to `reviewLog` or `reviewStats`; those track FSRS reviews only.

**TTS fields** (written by `ttsUtils.js` after async generation): `audioUrl` (vocab front audio), `sentenceAudioUrl` (sentence audio), `exampleAudio` (array of per-line clips for grammar-entry example blocks; setting it clears the legacy single-clip `audioUrl` to `null`). A clip's file name is derived from the spoken word, so `wordAudioMatches(card)` can tell when a renamed card's audio still says the old word; renames fetch the new word's clip, and the Dev Dashboard's audio scan lists older ones. "Needs audio" means `cardNeedsAudio`: grammar cards with examples and no `exampleAudio`, other cards with no `audioUrl` (the Settings count and the backfill use the same rule).

## users/{uid}/quiz_results/{resultId}

One document per completed quiz session. `{ type, score (0–100, one decimal), correct, total, date (ISO), meta }` — `meta` is quiz-type-specific and is JSON-cleaned before writing (the `undefined`-stripping backstop). Loaded with `orderBy('date', 'asc')` and cached in localStorage per user (`avi_quiz_results_{uid}`) for instant paint.

Grammar results carry `meta.mode` (`'selection'`, otherwise Translation; older untagged results count as Translation) and `meta.scoring` (`'g3'` for point-scored Translation, `'g4'` for per-question Selection). Translation scores are points, so `correct` can be fractional (0.5 per concept pick plus 0.5 per translation in Broad mode; △ earns half). The per-question record for a result lives in `users/{uid}/quiz_result_details/{resultId}` — for grammar, the questions, answers, assessments, concept picks, and for Selection the picks as `[{ picked: [...] }]` (Firestore can't nest an array directly inside an array) plus explanations merged in as they're fetched. An unfinished grammar session is kept on the device only (`avi_grammar_session_v1_{uid}` in localStorage, ignored after 14 days), never in Firestore.

## users/{uid}/echo_sessions/{sessionId}

One document per finished Echo Quiz session (Echo two-way or Dictation), kept apart from `quiz_results` so the score charts and averages are untouched. `{ v, kind ('echo' | 'dictation'), startedAt, finishedAt, endReason, config, itemCount, roundsPlayed, firstTry { en2ko, ko2en, ear: { correct, total } }, missedCount, overrideCount, unresolved [lemmaID], pair, items [{ lemmaID, lemma, misses, overrides, nearAccepted, hintsUsed, firstTry, resolved }] }`, built by `echoEngine.buildSummary` and JSON-cleaned before writing. Saved once per session (a session ended before any round finished writes nothing). Cached per user in localStorage (`avi_echo_sessions_{uid}`) and read by the Quizzes report and the Word Record. An unfinished session is kept on the device only (`avi_echo_session_{uid}`, ignored after 14 days); Echo setup options are saved under `avi_quiz_echo_config`.

## users/{uid}/grammar_entries/{grammar_n}

Grammar Index entries. Document ID is `grammar_N`: a new entry takes the first N past every id *and* entry number in use, confirmed free in Firestore, and is created with `setDoc` (never `updateDoc` onto an existing doc). Deleting an entry renumbers the ones after it but keeps their ids, so ids and `entryNumber` drift apart — never derive one from the other.

| Field | Type | Notes |
|---|---|---|
| `glossaryTerm` | string | The pattern name |
| `compareTo` | string | Similar patterns as a **pipe-separated** string (`A | B | C`) — pipes because commas legitimately occur inside Korean grammar titles |
| `explanation`, `examples` | string | Free text |
| `masteryLevel` | string | `introduced` \| `practicing` \| `confident` \| `mastered` |
| `masteryLevelChangedAt` | string | Stamped only when the level actually changes |
| `entryNumber` | number | |
| `createdAt` | string | |

Creating an entry also creates its linked grammar flashcard in `deck_grammar` (front = `glossaryTerm`, back = `compareTo`). The entry→section link is stored on the *section* (`glossaryTermIds`), and entry→note links are stored on the *note* (`linkedGrammarIds`) — the entry document itself carries no link arrays. Deleting an entry removes its id from every section, source and note that links it (found with `array-contains`, so links made on another device count); the Dev Dashboard's Grammar Index check lists dead links left from before.

## users/{uid}/grammar_corpus/index

A single denormalized document rebuilt (debounced 2 s) when grammar entries change — written only when its content differs from what this device last wrote (a fingerprint in localStorage, `avi_grammar_corpus_sig_{uid}`) — so the grammar-quiz function call can send a compact corpus instead of the client re-deriving it: `{ entries: [{ id, term, level, compareTo, explanation }], updatedAt }`.

## users/{uid}/notes/{noteId}

Notes, questions, and corrections share this collection, discriminated by shape.

**Regular notes** (questions are notes whose `tags` include `'question'`): `title`, `bodyHtml` (rich text), `tags` (string[]), `answered` (boolean, for questions), `linkedGrammarIds` (string[]), `linkedSourceId` / `linkedSectionId` / `linkedApptId` (string \| null), `createdAt`, `updatedAt`.

**Correction sets** (`type: 'correction'`): `title`, `rows` (array of `{ topic, original, corrected }`), `sourceId` / `sectionId` / `linkedApptId` (string \| null), `locked` (boolean), `createdAt`, `updatedAt`. The grammar quizzes create these directly via `createCorrectionNote.js` with an additional `sourceLabel` field — Translation from its assessment, Selection with one row per incorrect sentence the learner selected.

## users/{uid}/reviewLog/{YYYY-MM-DD}

One document per logical day with a single `count` field, written with `increment(1)` per FSRS grade. Grammar reviews are excluded by design. This is the raw feed for the activity heatmap.

## users/{uid}/settings/reviewStats

An incrementally maintained aggregate over `reviewLog` so the Flashcards page never re-reads the whole history: `{ totalAllTime, bestDay {date, count}, bestWeek {weekStart, count}, bestMonth {ym, count}, longestStreak {length, endDate}, currentWeekStart, currentWeekCount, currentMonthYM, currentMonthCount, lastReviewDate, currentStreakLength }` (`reviewStatsEngine.js`). Weeks start Monday, matching the heatmap grid. Ties keep the original record date. Updated per grade via `applyReviewToStats`; a full recompute exists as a DevDashboard repair tool. **May not exist yet on a fresh account — readers must tolerate its absence.**

## users/{uid}/dailyplan/{YYYY-MM-DD}

The once-per-logical-day SRS pipeline cache (`srsEngine.js`): `{ logicalDate, pipelineOutput: { date, triaged, dueAtDayStart, dueCardIds, spikes, spikeDetected, tomorrowCount, generatedAt }, generatedAt }`. `dueAtDayStart` freezes the day's due total for the Today page, and `dueCardIds` lists those cards so Reviews Left counts only cards from that set that are still due (new-card reviews and paused decks can't skew it). `tomorrowCount` drives the "Tomorrow: N cards due if reviews incomplete" warning. The post-session spike re-run patches only `pipelineOutput.spikes` / `pipelineOutput.spikeDetected` / `pipelineOutput.tomorrowCount` via dot-notation `updateDoc`.

## users/{uid}/settings/main

The single shared settings document. Two writers merge into it independently: the app-settings sync (`useFirestore.js`, which writes only the keys it changed, each replaced whole via `setDoc` with `mergeFields`) and the AVI-settings sync (`useAVIData.js`, which reads/writes only `avi`-prefixed keys and mirrors them into App's copy). Neither ever writes back a key the other owns. The active theme is stored here (`theme`) *and* mirrored to localStorage (`avi_theme`) for first paint — Firestore wins at boot. Sound preferences, by contrast, are localStorage-only (`avi_sound`, `avi_quiz_sounds`).

| Field | Default | Notes |
|---|---|---|
| `theme` | `'ember'` fallback; new accounts seeded `'hanok'` | Active theme id; restored from here at boot and re-mirrored to localStorage |
| `dayStartHour` | 3 | The `dsh` behind the logical-day convention |
| `defaultCategory` | | |
| `fsrs` | `{}` | `{ desiredRetention (0.9), maximumInterval (1095), graduatingInterval (1), easyInterval (3) }`; each key falls back to `FSRS_DEFAULTS` |
| `srsSpikeCap` | 80 | The Daily Review Cap (Settings; minimum 10). Forecast days above it are flagged as spikes; also used by the "tomorrow" warning and the spike-task rollover reconcile. Absent means `DAILY_CAP` (80) from `srsEngine.js` |
| `ttsEnabled`, `ttsSpeed`, `autoTtsOnImport` | | TTS toggles |
| `anthropicApiKey` | | Legacy and unused. Older versions stored a key here from a Settings field that only unlocked the grammar-quiz button; the field is gone and nothing reads this value. Accounts that set it may still have it |
| `customApptTypes` | | Extra appointment types; readers accept array or keyed-object-of-arrays |
| `exchangeRates`, `ratesUpdated` | | `{ USD, EUR, ... }` as KRW-per-unit numbers; `ratesUpdated` is a `'YYYY-MM-DD'` stamp |
| `adriftDays` | 14 | Content Library: days without activity before a started source counts as Adrift |
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

## users/{uid}/settings/gazetteAdAliases, settings/devActionRuns and meta/grammar_cleanup

`gazetteAdAliases` is a `{ filename: aliasString }` map for Gazette plate labeling, edited from DevDashboard; the Gazette degrades gracefully when it is absent or empty. `devActionRuns` is `{ actionKey: ISO timestamp }`, the last successful run of each Dev Dashboard action (written on success only, read only by the dashboard; the boot load reads `settings/main` alone, so it never reaches the app). `meta/grammar_cleanup` is a one-time migration flag document.

---

## globalLemmaMap/{key} (top-level)

The surface-form→lemma lookup behind the Resolve step. It lives at the top level (outside `users/{uid}`, alongside the DevDashboard's `dev` tree), but in a personal deployment it is yours alone: it sits in your own Firebase project, populated by the shipped seed and grown by your corrections, and nothing about it leaves your project. In a deliberate multi-user deployment — a study group or family sharing one Firebase project — every user reads and writes the same map and improves it together, which is why the rules scope it to any authenticated user rather than a single owner. Access is **per-key `getDoc` only**; nothing ever loads the collection, so read cost scales with words resolved, not map size. All logic lives in `aviUtils.js`.

**Key derivation** (`globalLemmaKey`): trim → lowercase → whitespace to `_` → `/` and `\` to `-` → cap at 200 chars → `'_empty'` fallback.

| Field | Type | Notes |
|---|---|---|
| `cleanedLemma` | string | The mapped lemma |
| `contributorCount` | number | Incremented when a write agrees with the stored mapping |
| `updatedAt` | string | **ISO string, compared as a string.** Load-bearing — see the trust gate |
| `verified` | boolean | Set by the Oct 2026 seed vetting: the mapping was confirmed by a morphological analyzer or a dictionary word list. Absent on unvetted rows |
| `headword` | boolean | Set by the vetting: the key itself is a dictionary word, whatever its row maps to (봄 is a word even though its row reads it as a form of 보다). Absent otherwise |

**The trust gate.** The map ships bulk-seeded, and the original seed included machine-generated errors. An entry's *mapping* is followed on its own authority if the row is *organic* — `updatedAt >= '2026-03-24'` (a string comparison against the seed cutoff) or `contributorCount >= 2` — or `verified`. An entry counts as *headword evidence* (its key is a real word, so a candidate equal to it is accepted) if it has `headword: true`, or if its mapping restates its own key (`globalLemmaKey(cleanedLemma) === key`) and the row is organic or verified. An unvetted seed row is neither: its rewrite is used only when corroborated by an independently derived heuristic candidate, or — as a last-resort structural fallback — when the rewrite is structurally consistent with the surface (`seedMappingPlausible`) and itself validates as a headword. A user correction writes an organic row that permanently outranks all of this. A map imported from a seed older than the Oct 2026 vetting has no flags, so it validates only organic rows; resolution then leans on the heuristics, which still work, with fewer one-tap alternatives.

**Resolution order** (`resolveLemmaDetailed`, wrapped by `resolveLemmaWithDictionary`): trusted map hit on the raw/normalized/`+요` key variants (the `+요` row's own identity is ignored, so 이 never resolves to 이요) → function words returned as they are (그리고, 안, 다…) → local-headword validation (a de-conjugation candidate the user already studies in `lemmaMaster` is accepted immediately) → headword validation of the first 8 candidates against the map, in rank order → an X어지다/X아지다 candidate whose base validates (쉬워질 → 쉬워지다, since 쉽다 is a word) → seed corroboration (an untrusted seed mapping is followed only if it exactly matches an independently derived candidate — two independent signals) → the surface itself, when its own row marks it a headword → the structural fallback → the top heuristic candidate. Dictionary validation deliberately outranks seed corroboration, because the seed was generated with the same naive suffix assumptions as the heuristic. With `withAlternates: true` it also returns up to three other readings that validated (and the surface itself when it is a headword); Import and the Sentence Input picker show them as one-tap choices.

**Write policy** (`writeGlobalLemma`, fired only on *explicit user corrections* at intake sites, including picking an "Or:" reading): writes merge into the existing row, so the vetting flags survive; agreement increments `contributorCount`; a correction that conflicts with a non-organic (seed-era) row overwrites it; a conflict with an organic row is silently dropped — **first-writer-wins**. That is fine for a single-user deployment and a documented limitation for shared multi-user maps. The whole write is try/catch-wrapped and no-ops silently if rules ever deny it — map learning is best-effort by design, and intake keeps working without it. Preserve that failure tolerance if you modify the write path.

**Seeding.** `seed/globalLemmaMap.json` plus the import script populate the map. The shipped seed was vetted in Oct 2026: over 1.1 million rows are `verified`, junk rows (machine-invented strings, a noun with the wrong particle form such as 협장는, stray commentary text) were removed, wrong mappings were repaired, and about 42,000 rows were added for dictionary words the seed lacked. Rows added by the vetting carry the seed-era `updatedAt` `2026-03-23T23:59:59.999Z`, so they behave like the rest of the seed (a user correction still overrides them). The `updatedAt` values must be imported **verbatim** — an import that stamps "now" would turn every unvetted seed row into a trusted one. The seed is Korean-specific; other languages start with an empty map, and everything above still works (the map just grows organically).

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
