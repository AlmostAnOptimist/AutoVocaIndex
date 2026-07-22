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

**Absent, `null`, and `[]` are equivalent — and stripping is preferred.**
Cause: optional array fields (`dates`, `completedDates`, link arrays) accumulated two "no value" representations over time.
Rule: every reader guards (`Array.isArray` / `|| []`), so all three states are safe; when clearing a field, new code should *strip it from the object* rather than write an explicit `null`. Both patterns coexist in the shipped tree; don't churn old code to convert it.
Where: readers throughout; `recurrenceEngine.js` and `EditTaskModal.jsx` demonstrate the strip convention.

**Stale-while-revalidate paint.**
Symptom (prevented): blank screens while Firestore loads.
Cause: first paint would otherwise wait on network.
Rule: paint immediately from a localStorage cache, then unconditionally refetch; Firestore wins. The cache is a paint optimization, never a source of truth.
Where: task/settings state (`avi_v1` via `storage.js`), quiz results (`avi_quiz_results_{uid}`), theme (`avi_theme`).

**Local-echo and loading races.** Four verified instances of the same disease — async work racing in-memory state — each with its shipped cure:
- *Duplicate source on add:* an `addDoc` plus an optimistic state append can double up. Cure: guard the append — `prev.some(s => s.id === ref.id) ? prev : [...prev, ...]` (`ContentLibraryPage.handleAddSource`).
- *Duplicate deck on concurrent card creation:* two card factories miss the same not-yet-created deck and each create it. Cure: a shared in-flight promise map keyed on `(uid, deckName)` — first miss creates, everyone else awaits the same promise, entry removed on settle so a later-deleted deck is never resurrected (`cardFactory.resolveDeckId`).
- *Late-arriving props overwrite local edits:* App.jsx loads inputs asynchronously and can hand them to `useAVIData` after the user has already edited. Cure: a `hasEditedRef` — props catch-up is allowed only until the first local edit, after which local state is authoritative (`useAVIData`).
- *Background refresh clobbers a fresher list:* quiz results fetched during a session could be shorter than the in-memory list. Cure: higher count wins on merge (`QuizzesPage`).
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
Rule: an entry is fully trusted only if *organic* — `updatedAt >= '2026-03-24'` (a **string** comparison; all timestamps in this model are ISO strings) or `contributorCount >= 2`. Untrusted seed rows still count as headword evidence when the mapping restates its own key, and their rewrites are followed only when independently corroborated by a jamo-derived candidate or, failing that, when structurally consistent with the surface (`seedMappingPlausible` — shared leading jamo or strip shape; hallucinated rows share nothing and stay dormant). Dictionary/headword validation outranks both, and an organic user correction outranks everything.
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

---

## Dates and scheduling

**Every "what day is it" goes through the logical day.**
Symptom: reviews done at 1 a.m. land on the wrong day; streaks break at midnight.
Cause: the user's day doesn't flip at midnight — it flips at `settings.dayStartHour` (default 3).
Rule: always `getLogicalToday(dsh)` / `getLogicalDateStr(dsh)` with the *threaded* `dsh` — never zero-arg (the default masks a threading gap) and never raw `new Date()` for date defaults, display, or document keys. `reviewLog` and `dailyplan` document IDs are logical dates, so this convention is baked into the data itself.
Where: `dateUtils.js` and every date site.

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
Where: applied in the mobile scroll surfaces; treat as the standing rule for any new scrollable sheet or list.

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

**Debounced syncs flush on unmount.**
Symptom (prevented): the last edit before navigating away never persists.
Rule: any debounced writer must flush pending state in its cleanup.
Where: `useAVIData` (cleanup calls `flush()` if anything is pending); `useFirestore` follows the same pattern.

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
- Auto-added synonym/nuance rows use the reserved source title `동의어/유의어` (`NUANCE_SOURCE_TITLE` in `aviUtils.js`); don't create a real source with that name.
Where: `aviUtils.resolveLemmaWithDictionary` and its comments — read them in full before modifying resolution.

---

## Security decisions

**There is no generic Anthropic proxy in the tree — deliberately** *(decision)*.
An earlier open passthrough endpoint was deleted because an unauthenticated proxy exposes the paid API key to anyone who finds the URL, and the grammar-quiz function was later constrained for the same reason. Both shipped Anthropic endpoints are now pinned server-side: `get-definition` (fixed persona, Haiku, 1024-token cap; the client sends only the lemma) and `grammar-quiz` (owns all four prompt templates; pinned model, 4000-token cap; every request field validated and length-capped, unrecognized requests rejected with a 400). They remain public URLs — anyone who finds them can invoke the fixed tasks in bounded amounts — but neither can be used as a general passthrough. Keep it that way: never accept a model, token count, raw messages array, or system prompt from the client. The proxy pattern, its cost/access tiers, and the auth-guard recipe for genuinely flexible endpoints are taught in the AI-assisted-building guide.

**GCP credentials are split across three env vars** *(decision)*.
`GCP_CLIENT_EMAIL` / `GCP_PRIVATE_KEY` / `GCP_PRIVATE_KEY_ID` instead of one JSON blob, because the full service-account JSON exceeds the 4 KB Lambda environment limit. Not a style choice — recombining them will break deployment.

**`writeGlobalLemma` is deliberately failure-tolerant.**
The whole write is try/catch-wrapped and no-ops silently on permission failure — map-loop learning is best-effort by design, so a deployment whose rules deny `globalLemmaMap` writes (the hosted demo does this to protect its map from anonymous visitors) simply stops learning rather than breaking intake. If you modify the write path, preserve that swallow-and-continue behavior.

**`settings.anthropicApiKey` is a client-side gate, not the server's key.**
The Settings field enables grammar quizzes in the UI (`handleGrammarStart` returns early without it); the serverless functions authenticate with their own `ANTHROPIC_API_KEY` environment variable. Don't be surprised that the value entered in Settings is not what reaches Anthropic — and don't change the functions to accept a client-supplied key, which would let any authenticated user bill an arbitrary key through your endpoint.
