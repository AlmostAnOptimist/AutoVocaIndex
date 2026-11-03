# Decisions and Gotchas

This is the document that cannot be regenerated from the code alone: the hard-won learnings, deliberate tradeoffs, and traps discovered while building AVI. If you are modifying the template — or pointing an AI assistant at it — read this before touching anything, and hand it to the assistant alongside the architecture and data model guides.

Each entry follows the same shape: the **symptom** you'd see, the **cause** underneath it, the **rule** the codebase follows, and **where** that rule is applied. Entries marked *decision* rather than gotcha are deliberate design choices with their reasoning.

---

## Firestore and data

**`undefined` is rejected; `null` is the fallback.**
Symptom: a write silently fails or throws `Unsupported field value: undefined`.
Cause: Firestore rejects `undefined` field values outright.
Rule: never let `undefined` reach a write; `null` is the correct "no value."
Where: everywhere; the defensive version is `QuizzesPage.saveResult`, which round-trips quiz metadata through `JSON.parse(JSON.stringify(...))` before writing — JSON serialization silently drops `undefined` fields.

**Batched writes flush at 450–490 ops.**
Cause: Firestore's hard batch cap is 500.
Rule: flush before the cap; both thresholds exist in the tree (490 in the sync layers and the App-level cascades, 450 in the Content Library cascades) and both are safe. New bulk-write code should copy an existing flush pattern rather than invent one.
Where: `useFirestore.syncTasks`, `useAVIData.syncCollection`, the delete/merge cascades in `ContentLibraryPage.jsx`, `App.jsx`.

**The delete-all guard.**
Symptom (prevented): a sync pass wipes an entire collection.
Cause: the diff sync compares previous in-memory state to next; if a loading race ever produced a stale empty array as "next," the diff would read as "delete everything."
Rule: a pass that would delete every document in a collection of more than five is refused and logged. There is no legitimate "clear everything" action for these collections, so many-to-zero is always treated as a bug, not intent.
Where: `useAVIData.syncCollection`.

**The Lemma Master sync baseline is the loaded list.**
Symptom (prevented): the first AVI edit after opening the app rewrote the entire `lemmaMaster` collection, and an entry deleted or merged away by that first edit came back on the next visit.
Cause: the diff sync's baseline for `lemmaMaster` started as an empty list and was never set after the load, so the first pass saw every entry as new and saw nothing to delete.
Rule: when the load lands, the loaded entries become the baseline, and any save queued before the load is pointed at them too, so it can never read as "delete them all."
Where: the `lemmaMaster` load effect in `useAVIData.js`.

**A failed boot load must never fall through to the sync.**
Symptom (prevented): tasks deleted on another device come back, or newer edits are overwritten, after the app opens on a weak connection.
Cause: if the boot read fails and the app carries on as though it loaded, the diff sync has no Firestore baseline and treats this device's local snapshot (possibly days old) as the truth, writing it over the database.
Rule: `firestoreLoad` returns `'error'` on failure, distinct from `null` (a brand-new account). The boot load retries, then stays read-only: `dataLoaded` stays false, so the sync never starts, and the SRS pipeline waits for it too. Every caller must check for `'error'` explicitly. A bare `if (!remote) return;` lets the string through, and a failed background refresh then sets `tasks` to `undefined`.
Where: `useFirestore.firestoreLoad`; the boot load, the hourly run, and the visibility refresh in `App.jsx`.

**A refresh merges; it never replaces.**
Symptom (prevented): an edit made a second before switching apps comes back undone, on screen and then in Firestore; a definition filled on the phone is reverted by an edit on the laptop; a setting saved by one screen is put back by another.
Cause: the hourly and return-to-tab refreshes used to swap Firestore's copy in wholesale, dropping edits still waiting in the debounce; the sync baseline wasn't moved after a refresh, so the next diff wrote the old version back; and every save wrote this device's whole document (a stale AVI row, the whole settings doc).
Rule: three-way merge against the baseline (what this device last saved): a field or task changed here and not yet saved wins, everything else takes Firestore's version, including additions and deletions made elsewhere; then the refresh becomes the new baseline (a save already in flight can't put an older baseline back). Write only what changed: AVI rows field by field, `settings/main` key by key. A row deleted on another device stays deleted even if it was edited here. Waiting edits are flushed when the page is hidden.
Where: `mergeRemoteData` / `planRemoteRefresh` / `commitRefresh` in `useFirestore.js`; `mergeAviRows` (`aviRowMerge.js`) and `applyRemote` / `refreshRemote` in `useAVIData.js`; `refreshFromRemote` in `App.jsx`.

**With the persistent cache, an awaited write can hang forever offline.**
Symptom (prevented): on the subway, grading a card does nothing and the card can't be graded again; a quiz never reaches its results; deleting a grammar entry freezes the panel.
Cause: Firestore applies the write to the local cache at once and keeps it, but the promise only settles when the server confirms, so code that `await`s it waits until the connection returns.
Rule: update memory first and queue the write without awaiting it (`queueWrite` in `queuedWrite.js`), reporting a refusal (and handling `not-found` for a doc deleted elsewhere). Make document ids up front with `doc(collection(...))` instead of `addDoc`. Await only where the next step genuinely needs the server (a Grammar Index create, which must confirm its id is free).
Where: grading in `FlashcardsPage.jsx`, quiz results and Echo sessions in `QuizzesPage.jsx`, `createCorrectionNote.js`, note saves in `NotesPage.jsx`, Grammar Index deletes.

**Absent, `null`, and `[]` are equivalent — and stripping is preferred.**
Cause: optional array fields (`dates`, `completedDates`, link arrays) accumulated two "no value" representations over time.
Rule: every reader guards (`Array.isArray` / `|| []`), so all three states are safe; when clearing a field, new code should *strip it from the object* rather than write an explicit `null`. Both patterns coexist in the shipped tree; don't churn old code to convert it.
Where: readers throughout; `recurrenceEngine.js` and `EditTaskModal.jsx` demonstrate the strip convention.

**Stale-while-revalidate paint.**
Symptom (prevented): blank screens while Firestore loads.
Cause: first paint would otherwise wait on network.
Rule: paint immediately from a localStorage cache, then unconditionally refetch; Firestore wins. The cache is a paint optimization, never a source of truth.
Where: task/settings state (`avi_v1` via `storage.js`), quiz results (`avi_quiz_results_{uid}`), Echo sessions (`avi_echo_sessions_{uid}`), theme (`avi_theme`).

**An "unconditional refetch" can still be answered from cache.**
Symptom: a card edited on one device (a new back, a corrected definition) keeps showing its old content on another device all day.
Cause: the app runs Firestore's persistent local cache (`firebase.js`), so a boot `getDocs` can be served from that cache instead of the server, and a phone resumed from the background never re-runs the boot load at all.
Rule: once per logical day per device, flashcards and decks are read with `getDocsFromServer`, at boot and again on returning to the tab. The day is stamped (`avi_fc_refresh_{uid}`) only after a successful server read, so an offline attempt retries on the next trigger. Rows merge by content, so unchanged cards keep their object identity and only changed rows re-render.
Where: `useFlashcardData` and `refreshFlashcardsIfStale` in `App.jsx`. As a repair, the Flashcards Clean up button also resyncs card backs from Lemma Master.

**Local-echo and loading races.** Seven verified instances of the same disease — async work racing in-memory state — each with its shipped cure:
- *Duplicate source on add:* an `addDoc` plus an optimistic state append can double up. Cure: guard the append — `prev.some(s => s.id === ref.id) ? prev : [...prev, ...]` (`ContentLibraryPage.handleAddSource`).
- *Duplicate deck on concurrent card creation:* two card factories miss the same not-yet-created deck and each create it. Cure: a shared in-flight promise map keyed on `(uid, deckName)` — first miss creates, everyone else awaits the same promise, entry removed on settle so a later-deleted deck is never resurrected (`cardFactory.resolveDeckId`).
- *Late-arriving props overwrite local edits:* App.jsx loads inputs asynchronously and can hand them to `useAVIData` after the user has already edited. Cure: a `hasEditedRef` — props catch-up is allowed only until the first local edit, after which local state is authoritative (`useAVIData`).
- *Background refresh clobbers a fresher list:* quiz results fetched during a session could be shorter than the in-memory list. Cure: higher count wins on merge (`QuizzesPage`).
- *Duplicate cards in a burst:* the Sentence Input add loop, an Import commit, or a double-fired handler calls the card factory several times from one closure-captured `cards` array, so a "does this card exist?" check passes for every caller. Cure: the duplicate check lives inside the factory itself (one word card per lemma per deck; one sentence card per target word and sentence per deck), and concurrent calls for the same key share one in-flight creation (`cardFactory.withCardCreateLock`). Every card-creating path passes the cards in memory to that check, and merges and lemma corrections collapse any duplicates they create. One survivor rule everywhere (`cardDedupe.js`): a reviewed card over a new one, then the oldest, then id; a duplicate that is also in another deck only leaves this deck. The Flashcards Clean up button applies the same rule to duplicates that predate the fix.
- *Duplicate rows on append:* the same race for word rows, sentence rows, and lemma entries. Cure: filter inside the functional updater, which always sees the latest state (`filterNewWordRows`, `filterNewSentenceRows`, `filterNewLemmas` in `aviUtils.js`).
- *A modal saves the copy it opened with:* Edit Task and the Appointment modal used to write their whole snapshot back, undoing a completion, roll or follow-up promotion that landed while they were open. Cure: send the snapshot as opened along with the edit, and apply only the fields that differ onto the latest document (`applyTaskEdit` / `applyFieldEdits` in `taskEdit.js`); a document deleted meanwhile is not recreated.
Rule for new code: any pairing of "await a write" with "update local state" needs one of these patterns.

**Firestore is called directly throughout — known coupling, explicit non-goal** *(decision)*.
There is no data-access layer; pages and utilities import `firebase/firestore` and call it. Making the database swappable would mean routing all access through a single adapter and forbidding `firebase/firestore` imports in page files — the leaf-module rule applied to the data layer. This was deliberately not done: retrofitting that abstraction late carries a high chance of introducing exactly the race/duplication bugs cataloged above. Consequence, stated plainly: migrating to a different database means rewriting the access layer, not flipping a setting.

**The global lemma map is read per-key, never as a collection.**
Cause: the map is large (it ships bulk-seeded) and Firestore bills per document read.
Rule: every lookup is a single `getDoc` on a derived key; nothing ever loads or queries the collection. This is what makes shipping the full seed affordable — read cost scales with words you resolve, not map size.
Where: `aviUtils.fetchGlmEntry` and every caller.

**The GLM trust gate — and why seed `updatedAt` values are sacred.**
Symptom (prevented): machine-generated seed errors (e.g. a junk surface→lemma rewrite) resolving words wrongly forever.
Cause: the bulk seed was generated with the same naive suffix assumptions as the heuristic, and some rows are wrong.
Rule: an entry's mapping is trusted only if *organic* — `updatedAt >= '2026-03-24'` (a **string** comparison; all timestamps in this model are ISO strings) or `contributorCount >= 2` — or marked `verified` by the Oct 2026 vetting. Headword evidence needs `headword: true`, or an identity row that is organic or verified: an unvetted identity row is not enough, because the old seed held junk identities (할다, 다다, 이요) that let wrong candidates win. Unvetted rewrites are followed only when independently corroborated by a jamo-derived candidate or, failing that, when structurally consistent with the surface (`seedMappingPlausible` — shared leading jamo or strip shape; hallucinated rows share nothing and stay dormant). Dictionary/headword validation outranks both, and an organic user correction outranks everything.
Consequence: the seed import **must preserve `updatedAt` values verbatim**. An import that stamps "now" promotes every junk row past the gate in one stroke — this is the single most damaging mistake available in setup.
Where: `aviUtils.glmEntryTrust` / `resolveLemmaWithDictionary`; the import warning in the setup guide.

**GLM conflicts are first-writer-wins — documented limitation, not a bug** *(decision)*.
A manual correction overwrites a conflicting *seed-era* row, but a conflict between two *organic* mappings is silently dropped: whoever wrote first wins. Fine for a single learner; imperfect for a shared multi-user map, where a wrong early correction can only be displaced by editing rows, not by out-voting. Accepted as-is; a voting or moderation scheme was out of scope.
Where: `aviUtils.writeGlobalLemma`.

**The correction loops are asymmetric — separated by *where* you correct, not what.**
Symptom: you rename a bad lemma in Lemma Master, and the same wrong resolution happens again on your next entry of that word.
Cause: fixing a lemma on a *row* (Word Input, the Sentence Input picker, Import review) has the surface form in hand, so both loops fire — the map learns (`writeGlobalLemma`) *and* the cascade repairs linked records. Fixing a lemma in *Lemma Master* has no surface form, so only the master loop fires: everything already linked is repaired, but AVI learns nothing about future resolution.
Rule of thumb: when a bad lemma traces back to a mis-resolution, correct it at a row if you can. Lemma Master fixes the past; only rows teach the future.
Where: the row edit paths and `handlePopupDone` (both loops) vs. the Lemma Master save path (master loop only).

**A definition has one writer** *(decision)*.
Symptom (prevented): a word's card says one thing, its sentence cards another, and the Lemma Master a third, depending on which screen last edited it.
Rule: every `def2` change, from any screen, goes through `applyDef2Write` in `def2Cascade.js`, and every card back through `def2CardUpdate`: the Lemma Master entries, word and 동의어 rows, sentence backs and card backs change together. A sentence card's back is the word card's back. Clearing a `def2` clears it on the entry and the word rows but leaves sentence and card backs as they were until a new one is saved (a back is never written empty). A sentence back may be the word's `def1` only while the word has no `def2`, and follows `def1` edits until then (`applyDef1BackFollow`). The Dev Dashboard's Def2 resync applies the same rule to existing data.
Where: `def2Cascade.js`; callers in `AVILemmaMasterPage.jsx`, `AVISentenceInputPage.jsx`, `wordRowUpdater.js` and the Dev Dashboard.

---

## Dates and scheduling

**Spike warnings only mean something on their own day** *(decision)*.
Symptom (prevented): yesterday's "review spike" reminders pile up in Overdue, then drift into Unscheduled after 14 days.
Rule: a task with `source: 'srs_forecast'` that wasn't checked off by the end of its day, or that the 14-day rule left with no date, is deleted by `runRecurrenceEngine` (`isMissedSpikeTask`). Checked-off ones stay like any finished task, and Always On tasks are never touched.

**Every "what day is it" goes through the logical day.**
Symptom: reviews done at 1 a.m. land on the wrong day; streaks break at midnight.
Cause: the user's day doesn't flip at midnight — it flips at `settings.dayStartHour` (default 3).
Rule: always `getLogicalToday(dsh)` / `getLogicalDateStr(dsh)` with the *threaded* `dsh` — never zero-arg (the default masks a threading gap) and never raw `new Date()` for date defaults, display, or document keys. `reviewLog` and `dailyplan` document IDs are logical dates, so this convention is baked into the data itself. Two corollaries: a stored ISO timestamp is bucketed with `logicalDateOf(iso, dsh)`, never `iso.slice(0, 10)` (that's the UTC date, a day behind for anything stored before 9 a.m. in Korea); and a due date is computed from the logical day (`logicalDueISO` in `fsrs.js`), or a 1:30 a.m. review adds a day to its interval. `dsh` is read with `?? 3`, never `|| 3`, so the Midnight option (0) works.
Where: `dateUtils.js` and every date site.

**"Today" must follow the day flip while the app stays open.**
Symptom (prevented): a tab left open overnight keeps yesterday's tasks on Today, shows nothing overdue, and doesn't run the review pipeline for the new day.
Cause: values memoized on `dsh` alone never recompute when the date changes.
Rule: the logical day is state (`useLogicalDay` in App, re-checked at each day-start and on returning to the tab) and is passed down; memos that depend on "today" key on the day, not on `dsh`. A flip with the app open runs the same resync a tab return runs, once.
Where: `useLogicalDay.js`; the day-flip effect in `App.jsx`; Today, Overdue, Flashcards, the Library overview hook.

**A recurring task several occurrences behind catches up in one run.**
Symptom (prevented): a daily task missed for five days stays invisible (Today shows only today, Overdue skips daily tasks) while it steps forward one occurrence per engine run.
Rule: `rollRecurringTask` repeats the roll until the occurrence doesn't roll (capped), and `nextDueAfterCompletion` gives the date the engine will actually land on, so Upcoming shows the right next date after a late completion.
Where: `recurrenceEngine.js`.

**A manual task order belongs to one day** *(decision)*.
A drag on Today or Upcoming stamps `sortOrder` with `sortOrderDate`; the rank applies only on that day, and a drop onto another day's row does nothing. An order without a day (from before this rule) is ignored. Overdue and Unscheduled sort by date and priority and don't drag.
Where: `dragSort.js`, `useDragSort.js`.

**The Overdue badge counts exactly what the Overdue page lists** *(decision)*.
The badge is overdue plus unscheduled: both the page and the badge use `isOverdueTask(t, dsh, today)` and `isUnscheduledTask(t)` from `recurrenceEngine.js`, so recurring tasks still inside their window count and Always On (persistent) tasks don't. Add any new overdue rule there, never in one place only.
Where: `recurrenceEngine.js`, `OverduePage.jsx`, the badge in `App.jsx`.

**Grammar cards live outside FSRS entirely** *(decision)*.
Grammar patterns aren't discrete recall facts, so interval math fits them poorly. Grading a grammar card writes only `{ due: null, lastReview, lastGrade, reps, gapEvents }` — no stability, no interval — and grammar reviews are excluded from `reviewLog`, `reviewStats`, the daily pipeline's triage, and the due snapshot. The Grammar Deck is a browse-and-refresh surface driven by mastery levels, not a scheduler.
Where: the type branch in `FlashcardsPage.handleGrade`; `type === 'grammar'` exclusions in `srsEngine.js`.

**Two card formats coexist; readers must handle both.**
Cause: cards are created with SM-2-shaped placeholder fields and converted to FSRS fields by their first grade; an ungraded card keeps the creation shape indefinitely.
Rule: due/new logic goes through the dual-format helpers (`getDueDateStr` reads `due` or `nextDueDate`; `isNewCard` handles the no-`state` case); `!!card.stability` is the "is this FSRS" test. Never read `card.due` or `card.nextDueDate` directly in new code.
Where: `fsrs.js` helpers and their callers.

**Sentence cards may lack the `sentence` field — cloze parses `front`.**
Cause: the `sentence` field was added after early sentence cards existed; older or imported cards carry only `front` (`lemma\nsentence`).
Rule: never assume `sentence` exists on a sentence card. The cloze builder falls back to extracting the sentence from `front` (everything after the first newline) and back-fills a missing `inputForm` by matching the card's lemma and source against `wordInputs`; a card still lacking either is excluded from the pool rather than erroring. Any tooling that touches sentence cards — exports, migrations — needs the same front-substring fallback.
Where: the cloze pool builder in `QuizzesPage.jsx`; `cardFactory.js` writes `sentence` on all new cards.

---

## CSS and layout

**The containing-block trap: `position: fixed` inside `.fade-up`.**
Symptom: a fixed-position overlay (modal, popup, mobile nav) renders clipped, offset, or scrolls with its parent instead of pinning to the viewport.
Cause: `.fade-up` animates with `fill-mode: both`, which retains `transform: translateY(0)` after the animation — and *any* retained transform makes that element the containing block for fixed-position descendants. `backdropFilter` on an ancestor springs the same trap.
Rule: every fixed-position overlay renders through `createPortal(..., document.body)`. No exceptions — the bug only appears when a page later gains an animation or filter, which is why it recurs.
Where: multiple portal sites across the tree; the trap is documented in comments in `QuizzesPage.jsx` and `WordEditModal.jsx`.

**iOS Safari: focused inputs auto-zoom below 16px.**
Symptom: tapping an input zooms the whole page on iPhone.
Rule: the mobile media block forces `input, textarea, select { font-size: 16px !important; }` globally — don't undercut it with inline smaller sizes on mobile-reachable inputs.
Where: `buildStyles.js` mobile block; rationale comment in `QuizzesPage.jsx`.

**iOS Safari: `padding-bottom` on non-body scroll containers is unreliable as a scroll boundary.**
Symptom: the last rows of a scrollable list sit under the mobile nav and can't be scrolled into view.
Rule: use a rendered spacer element at the end of the scrollable content instead of container `padding-bottom`.
Where: applied in the mobile scroll surfaces. AVI's scroll shell is the clearest example: an `AVI_BOTTOM_CLEARANCE` spacer ends the scrollable content, and the `content-pad-flush` class switches off the content area's own bottom padding on that page. Treat this as the standing rule for any new scrollable sheet or list.

**iOS Safari: `100vh` clips under the browser chrome.**
Symptom: modal frames extend past the visible viewport top/bottom on iOS.
Rule: cap overlay heights with `dvh` — the shipped modal style uses `maxHeight: min(90vh, calc(100dvh - 32px))`.
Where: `buildStyles.js` modal style (comment documents it as the 90vh clipping fix).

**iOS Safari: scroll restoration races your own scroll reset.**
Symptom: returning from a full-screen session leaves the page scrolled so the masthead is above the viewport.
Rule: defer the reset with `requestAnimationFrame` so it runs after iOS's own scroll restoration — the deferred write reliably wins.
Where: `FlashcardsPage.handleEndSession`.

**Wide scrollable content: `overflow-x: auto` captures `position: sticky` children.**
Symptom: a sticky header inside a horizontally scrollable region stops sticking vertically.
Cause: the overflow container becomes the sticky element's scroll context on both axes.
Rule: give the wide content `width: fit-content; margin: 0 auto` inside a normal-flow wrapper rather than wrapping the sticky element in the overflow container.

**Module-level `isMobile` is frozen at load** *(decision)*.
Symptom (dev-only in practice): with DevTools docked narrow at load, the desktop page shows the mobile nav, hides deco images, and nudges the header — and stays that way after undocking.
Cause: `isMobile` is evaluated once at module load (`window.innerWidth <= 700`); nothing re-evaluates on resize.
Decision: a resize-reactive hook conversion was scoped, then deliberately scrapped — the real-world cost is a reload after rotating/resizing, and the conversion would have touched ~20 files late in extraction. Do not "fix" this without knowing it was weighed; a reload resolves it.

**Handhelds are for quick adds and reference, not full sessions** *(decision, posture)*.
Some pages are genuinely unwieldy on small screens — an accepted tradeoff, not a defect. The mobile experience is tuned for capture (drop in a word the moment you meet it) and lookup; plan full study sessions for a larger screen.

---

## Build and module graph

**Circular imports crash at runtime, not build time.**
Symptom: a blank page with a TDZ error (`Cannot access 'X' before initialization`) after an apparently clean build.
Cause: Vite/Rollup's bundle initialization order breaks on import cycles between page files.
Rule: the leaf-module rule — leaf modules (utilities, engines, shared components) never import page files; shared logic gets extracted to a utility host instead. Gate any import-graph change with `npx madge --circular --extensions js,jsx src/`.
Where: `contentUtils.js`'s header comment documents a real instance (ContentLibraryPage ↔ Gazette ↔ overview data) and the extraction that cured it; `cardFactory.js` and `wordRowUpdater.js` are further precedents.

**The ad-blocker path trap.**
Symptom: a blank page in dev with a single `ERR_BLOCKED_BY_CLIENT` in the console — while production is fine.
Cause: in dev mode, `import.meta.glob` requests assets by their raw folder paths, and ad blockers filter paths matching patterns like `/ads/`. Production bundles are immune (hashed flat filenames), which makes this a maddening dev-only failure.
Rule: keep globbed asset folders out of blocker-matching names. `gazette-plates/` is named with this in mind — don't rename it, or add new asset folders, into the trap.

**The three `.cjs` function files are `.cjs` deliberately.**
Symptom (if violated): `netlify dev` serves no functions locally while production keeps working.
Cause: the root `package.json` is `"type": "module"`, and these handlers are CommonJS — the extension is what tells the local loader.
Rule: leave the extensions alone; don't let a cleanup pass rename them to `.js`.
Where: `get-krdict-api.cjs`, `get-definition.cjs`, `generate-tts.cjs` (`grammar-quiz.js` is ESM and correctly `.js`).

**The logo is single-sourced from `public/favicon.svg`** *(decision)*.
`AVILogo.jsx` renders the same asset the browser tab uses, with a fixed palette by design — it deliberately does *not* recolor with the active theme, so the in-app mark, the favicon, and the installed-app icon always match. To rebrand your deployment, replace `public/favicon.svg` (and the PWA icon sizes) and everything updates together; don't wire the logo to theme colors, which would split it from the favicon again.

---

## Async and state

**Background tabs must not write.**
Symptom (prevented): a forgotten background tab's timers fight the active tab's writes, or burn API quota.
Rule: periodic engines check `document.visibilityState` before acting and re-run on `visibilitychange`; long-running loops (the Import pipeline's fetch loop) pause while hidden and resume on return.
Where: the engine effects in `App.jsx`; the hidden-state wait loops in `AVIImportPage.jsx`.

**Debounced syncs flush on unmount and when the page is hidden.**
Symptom (prevented): the last edit before navigating away, closing the tab or switching apps never persists (iOS suspends timers in the background).
Rule: any debounced writer flushes pending state in its cleanup and on `visibilitychange` → hidden / `pagehide`. The same goes for editors with their own autosave: the note editor saves a waiting edit on close, switch, leaving the page and hide instead of cancelling the timer.
Where: `useAVIData` and `useFirestore` (`flush()`); `NoteEditor` in `NotesPage.jsx`.

**iOS can corrupt localStorage; boot has to survive it.**
Symptom (prevented): the app white-screens on every load until site data is cleared by hand.
Cause: iOS Safari can evict or partially corrupt localStorage while the app is in the background, and the first render reads the persisted snapshot synchronously, so a bad value throws before anything appears.
Rule: an error boundary wraps the app and turns a render-time crash into a screen with one button, "Reset local data and reload." It clears localStorage only: real data reloads from Firestore, and the sign-in (kept in IndexedDB) survives. It catches render and lifecycle errors, not async rejections or event handlers, which don't blank the screen.
Where: `BootErrorBoundary` in `main.jsx`.

**Every hook goes above every early return.**
Symptom: a page shows its loading screen, then the boot error screen ("couldn't finish loading", offering to reset local data) the moment its data arrives, though nothing local is wrong.
Cause: React needs the same hooks in the same order on every render. A `useRef` or effect placed below `if (loading) return …` runs only once loading ends, so the second render has more hooks than the first and React throws; `BootErrorBoundary` catches it and reads it as corrupted local data.
Rule: declare every hook before the first early return. ESLint's `react-hooks/rules-of-hooks` flags this; treat a new finding as a bug, not noise.
Where: the Dev Dashboard's tab-switch scroll effect sits above its loading return for this reason.

**Search spends network reads only on an explicit search** *(decision)*.
Symptom (prevented): typing in a search box fires a Firestore read per keystroke.
Rule: everything that can be answered from data already in memory (exact and headword-variant matches, forms you've typed in Word Input or Sentence Input, fuzzy suggestions) runs synchronously while you type. The global lemma map lookup, which reads Firestore, runs only when a search is submitted, or after a pause: 600 ms in the Lemma Master and Echo "did you mean" fallbacks, which also cache answers per query, and 450 ms in the Word Input and Sentence Input search bars (only when nothing in memory matched). A lemma map answer is used only if that lemma is already in your Lemma Master.
Where: `useLemmaSearch.js` (`run`, `resolveConnectLines`); the fallbacks in `AVILemmaMasterPage.jsx` and the Echo setup in `QuizzesPage.jsx`; `useSearchAssist.js` for the two input search bars.

**Echo sessions are kept apart from quiz scores** *(decision)*.
Cause: Echo measures first-try accuracy in each direction across several rounds, and Dictation has a single direction; neither is a quiz score, and averaging them with Vocabulary or Cloze scores would distort both.
Rule: Echo saves to its own collection (`echo_sessions`, never `quiz_results`), is left out of score averages and the score trend, and is counted in session totals and reported in its own paragraph of the Quizzes report. Echo also never writes to FSRS.
Where: `sendEchoSummary` in `QuizzesPage.jsx`; `getQuizStateReport` in `quizStateEngine.js`.

---

## Language and content quirks

**Commas occur inside Korean text — pick delimiters accordingly.**
Cause: Korean grammar pattern titles legitimately contain commas, so comma-delimited storage would corrupt them.
Rule: `grammar_entries.compareTo` stores its list **pipe-separated** (`A | B | C`). Conversely, `lemmaMaster`'s `relatedForm` / `relatedMeaning` / `hiddenRelated` *are* comma-split by their readers — values in those fields must not contain commas. Any new multi-value string field holding Korean text should use the pipe.
Where: the separator comment atop the compare picker in `GrammarIndexPage.jsx`; the `split(',')` readers in `aviUtils.js`.

**Resolution heuristics carry deliberate quirks worth knowing before you touch them.**
- Candidates are generated from the **raw** surface: inputs typed in the parenthetical lemma convention (`마무리(하다)`) must pass through untouched, and tidying happens inside extraction.
- Bare contracted forms (더워, 몰라) often exist in the seed only in polite shape, so lookup probes a `+요` variant for corroboration.
- GLM keys were historically written from raw staged inputs — some carry trailing punctuation — so lookup tries the raw key before the normalized key.
- A candidate the user already studies (`lemmaMaster` headwords) is accepted immediately: free, synchronous, and more reliable than any remote signal.
- Stacked particles (봄에는, 친구들에게는) are peeled into candidates, never applied blind: nouns ending in a particle-shaped syllable (도로, 사과, 아들) must survive, and the primary heuristic, which is checked first, keeps them whole. Each particle only peels where Korean allows it (이/을/은/과/으로 after a consonant, 가/를/는/와/로 after a vowel).
- Some shapes are deterministic and rewrite the primary directly: 는 after a consonant-final stem is a verb (넘는 → 넘다), and a ㄹ-final stem before an 으-ending is ㄷ-irregular (걸으러 → 걷다). The copula-이 rules (이나, 이라서, 이라면…) skip vowel-final stems, and when both X and X이 validate (고양 / 고양이 for 고양이나) the resolver prefers X이.
- Genuinely ambiguous forms (낮은: 낮 or 낮다; 들었어요: 들다 or 듣다) resolve to the likelier reading and offer the other as a one-tap alternate; don't try to settle them with more rules.
- Lemmas in the `(주먹을) 날리다` shape (a leading Hangul parenthetical) are distinct entries from `날리다`, and search keeps them apart: no matching rule ever drops a leading parenthetical, while optional endings (`입사(하다)`) and slash forms (`보장하다 / 보장되다`) count as headword variants of their entry. In quizzes, typing the collocation without parentheses (`주먹을 날리다`) earns full credit.
- Auto-added synonym/nuance rows use the reserved source title `동의어` (`NUANCE_SOURCE_TITLE` in `aviUtils.js`; the older title `동의어/유의어`, `LEGACY_NUANCE_SOURCE_TITLE`, is still recognized, and rows are added under whichever title the list already uses). Don't create a real source with either name. A word stays in that source only while it has a synonym that still exists; when it loses its last one, its row and its card in that deck go.
- Import treats a leading bare number ("3 ") as a list marker only when two lines open with consecutive numbers; "3 년 전에…" keeps its number. "1.", "1)", "(1)" and circled digits are always stripped.
Where: `aviUtils.resolveLemmaWithDictionary` and its comments — read them in full before modifying resolution.

---

## Security decisions

**There is no generic Anthropic proxy in the tree — deliberately** *(decision)*.
An earlier open passthrough endpoint was deleted because an unauthenticated proxy exposes the paid API key to anyone who finds the URL, and the grammar-quiz function was later constrained for the same reason. Both shipped Anthropic endpoints are now pinned server-side: `get-definition` (fixed persona, Haiku, 1024-token cap; the client sends only the lemma, capped at 200 characters) and `grammar-quiz` (owns all five prompt templates and their JSON response schemas; pinned Sonnet model, 8000-token cap; every request field validated and length-capped, unrecognized requests rejected with a 400). On top of that, every function now requires a verified sign-in on `ALLOWED_UIDS` (next entry), so a stranger who finds the URLs gets a 401 — but even an allowed caller can't use either endpoint as a general passthrough. Keep it that way: never accept a model, token count, raw messages array, or system prompt from the client. The proxy pattern, its cost/access tiers, and the auth-guard recipe for genuinely flexible endpoints are taught in the AI-assisted-building guide.

**GCP credentials are split across three env vars** *(decision)*.
`GCP_CLIENT_EMAIL` / `GCP_PRIVATE_KEY` / `GCP_PRIVATE_KEY_ID` instead of one JSON blob, because the full service-account JSON exceeds the 4 KB Lambda environment limit. Not a style choice — recombining them will break deployment.

**`writeGlobalLemma` is deliberately failure-tolerant.**
The whole write is try/catch-wrapped and no-ops silently on permission failure — map-loop learning is best-effort by design, so a deployment whose rules deny `globalLemmaMap` writes (the hosted demo does this to protect its map from anonymous visitors) simply stops learning rather than breaking intake. If you modify the write path, preserve that swallow-and-continue behavior.

**Every function requires a sign-in on `ALLOWED_UIDS`, and an empty allowlist refuses everyone** *(decision)*.
Symptom (if misconfigured): every dictionary lookup, AI definition, grammar quiz and TTS request fails — lookups come back with no definition (Import reports that definitions couldn't be reached), audio never attaches — and the function logs say `ALLOWED_UIDS is not set` or `uid not on ALLOWED_UIDS`.
Cause: "signed in" alone isn't enough, because anyone with a Google account can sign into a deployed copy and would otherwise spend your keys. So each function verifies the Firebase ID token the client sends (`apiFetch.js` → `netlify/lib/verifyUser.cjs`) and then requires the uid to be listed. A missing allowlist fails closed on purpose: a skipped setup step should break loudly, not leave the keys open.
Rule: set `ALLOWED_UIDS` locally and on Netlify (setup step 5, deployment step 3). New client calls to `/api/*` must go through `apiFetch`, never plain `fetch`, or they'll get a 401. Never accept an API key from the client either — the server's environment variable is the only key (the old Settings key field is gone; `settings.anthropicApiKey` is unused).
Where: `netlify/lib/verifyUser.cjs`, `src/utils/apiFetch.js`. The hosted demo is the one exception: demo visitors sign in anonymously with uids that can't be listed, so in demo mode `get-krdict-api` still requires a valid token but skips the allowlist (its burst fence still applies); the other three functions are off in demo mode.

**`grammar-quiz.js` must import `firebase-admin` itself.**
Symptom (if violated): the grammar quiz fails on every request with a Netlify-generated 502, and the function log shows `Cannot find module 'firebase-admin/app'` — while the three `.cjs` functions work fine.
Cause: Netlify packages the Functions 2.0 file by tracing its own static imports; it doesn't follow a `require()` inside the shared CommonJS helper, so firebase-admin was left out of that function's package. The `.cjs` functions are packaged with require-tracing and are unaffected.
Rule: keep the static `firebase-admin/app` and `firebase-admin/auth` imports at the top of `grammar-quiz.js` and the `useFirebaseAdmin()` hand-off to the helper. After changing any function or the helper, package them with `@netlify/zip-it-and-ship-it` (the tool Netlify uses) and invoke each package from its own folder — tests run inside the project, with every package present, can't catch this.
Where: top of `netlify/functions/grammar-quiz.js`; `useFirebaseAdmin` in `netlify/lib/verifyUser.cjs`.

**Netlify's 60-second function limit is fixed.**
Symptom (prevented): long grammar quizzes timing out, or the client giving up while the function is still working.
Cause: synchronous functions get a fixed 60 s that `config` can't raise (an old `timeout: 30` key in `grammar-quiz.js` did nothing).
Rule: the function aborts its Anthropic call at 50 s and returns a clean 504; the client waits 58 s; generation and assessment are split into parallel requests of up to 10 questions (Selection: a 40-sentence budget per request), each given a different theme so batches don't overlap. Keep any new long-running call inside the same budget.
Where: `UPSTREAM_TIMEOUT_MS` in `grammar-quiz.js`; the chunk planners in `src/utils/grammarQuizEngine.js`; the client timeout in `src/utils/grammarQuizUtils.js`.
