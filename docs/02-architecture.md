# Architecture

This is the map of how AVI's pieces fit together — read it before modifying anything, and give it (with the data model guide) to any AI assistant you point at the code. It covers the stack, the repository layout, the module layers and their import rules, how data moves between the client and Firestore, how the serverless functions are routed, and finally one word traced end to end through the whole system.

Two companion documents go deeper where this one points: the [data model guide (03)](03-data-model.md) for every collection shape, and the [decisions-and-gotchas guide (06)](06-decisions-and-gotchas.md) for the traps and tradeoffs referenced throughout.

---

## Stack at a glance

AVI is a single-page React 19 application built with Vite, hosted as static files on Netlify. There is no application server: the client talks to Firestore directly through the Firebase SDK (auth via Firebase Authentication, Google sign-in), and four small Netlify serverless functions exist solely to hold API keys and talk to external services (KRDict, Anthropic, Google Cloud TTS) on the client's behalf. Everything else — scheduling math, lemma resolution, recurrence, stats — runs in the browser.

A demo-mode configuration exists behind `VITE_DEMO_MODE` / `VITE_DEMO_TIER` flags for the public demo site. In your deployment those flags are unset and the demo branches are dead code; you can ignore them entirely.

## Repository layout

```
src/
  App.jsx            root component — auth, boot loads, shared state,
                     rename/delete cascades, daily engines
  constants.js       shared vocabularies: categories, recurrence types,
                     appointment types, grammar mastery levels, storage keys
  pages/             one file per screen (TodayPage, AVIPage, FlashcardsPage,
                     QuizzesPage, ContentLibraryPage, GrammarIndexPage, ...)
  components/        shared UI — modals, pickers, nav, DatePicker, Icons,
                     AVILogo, Gazette components
  hooks/             useFirestore, useAVIData, useAppTheme, useDragSort,
                     keyboard/pagination helpers
  utils/             engines and utilities — fsrs, srsEngine, aviUtils,
                     cardFactory, importEngine, recurrenceEngine,
                     reviewStatsEngine, contentUtils, ttsUtils, dateUtils, ...
  theme/             buildColors, buildStyles, decoAssets, ThemeContext
  assets/            decorative art and gazette-plates/library/ — globbed,
                     optional, ships empty (see the theming guide)
netlify/functions/   the four serverless functions
public/              favicon.svg (the single-source logo), PWA icons,
                     manifest
seed/                globalLemmaMap.json + the Admin SDK import/export scripts
scripts/             demo-reaper.cjs — maintenance for the hosted demo;
                     inert in your deployment (no-ops without its secret)
.github/workflows/   the schedule that runs it (same inertness)
docs/                this documentation
netlify.toml         build settings and the /api/* redirects
vite.config.js       Vite build config
firestore.rules      security rules (see the data model guide)
```

`Icons.jsx` is the only icon source — every icon in the app is an inline SVG from that file. There are no emoji anywhere in the UI, by rule.

## Module layers and the import rules

The dependency direction is strictly downward:

```
pages  →  components  →  hooks  →  utils / theme  →  firebase.js
```

**The leaf-module rule.** Leaf modules — utilities, engines, shared components — never import page files. When two pages need the same logic, that logic moves down into a utility host rather than one page importing the other. This is not a style preference: import cycles between page files crash at *runtime* under Vite's bundle initialization (a TDZ error on a blank page) while building cleanly. The rule, the crash, and a real cured instance are documented in the gotchas guide; `contentUtils.js`, `cardFactory.js`, and `wordRowUpdater.js` are the standing precedents. Gate any change to the import graph with:

```
npx madge --circular --extensions js,jsx src/
```

**Engines come in two flavors.** Pure engines are plain functions with no React and no Firestore — `fsrs.js` (the FSRS-5 scheduler), `recurrenceEngine.js`, the row builders in `importEngine.js` — and are the easiest code in the tree to test, reuse, or port. Pipeline engines orchestrate Firestore alongside their math — `srsEngine.js` (the daily triage/forecast pipeline), `reviewStatsEngine.js` — and sit one layer up. When adding derived logic of your own, prefer the pure flavor and let a caller own the writes.

## App.jsx is the hub

`App.jsx` owns authentication, the boot sequence, and all cross-page shared state, handing data down to pages as props.

**Auth.** `onAuthStateChanged` drives everything: no user renders the sign-in screen (Google popup via `signInWithPopup`); a user kicks off the boot loads. Sign-out is a plain `signOut` call from Settings.

**Boot loads and the three data-access styles.** Different collections deliberately use different access patterns, and knowing which is which matters when you modify them:

1. *One-shot load, in-memory authority, debounced diff sync.* Tasks and settings (`useFirestore.js`, 1500 ms debounce) and the AVI input collections plus `lemmaMaster` (`useAVIData.js`, 800 ms) are loaded once with `getDocs`, edited as in-memory arrays, and persisted by diffing previous synced state against next — only changed documents are written, with the delete-all guard described in the gotchas guide. Pending changes flush on unmount.
2. *Live listeners.* `content_sources`, `content_sections`, and `appointments` are `onSnapshot` subscriptions in App.jsx — these are the collections that other surfaces (pickers, links, the Gazette) need to see change in real time.
3. *Direct writes at the interaction site.* Everything else — flashcards, decks, notes, grammar entries, quiz results, review logs — is read at mount where needed and written document-by-document as the user acts. Flashcards and decks specifically live in `useFlashcardData` (defined in App.jsx) and are shared by the Flashcards *and* Quizzes pages so neither duplicates the read.

All Firestore access is direct — there is no data-access layer, a known coupling and explicit non-goal discussed in the gotchas guide. Writes use `setDoc` + `{ merge: true }` or `updateDoc`; `undefined` never reaches a write.

**Cascades.** Because AVI rows carry their source *title* (not ID — see the data model guide), renaming or deleting a Content Library source triggers an App-level cascade that batch-rewrites dependent word rows, sentence rows, tasks, and the current-source setting. If you add a new record type that references sources, wire it into these cascades.

**Engines and visibility.** The daily pipeline and other periodic engines run from App.jsx effects, gated on `document.visibilityState` and re-checked on `visibilitychange` so a forgotten background tab never writes or burns API quota.

**Paint strategy.** First paint comes from localStorage caches (`avi_*` keys), then an unconditional refetch lets Firestore win — the stale-while-revalidate pattern. localStorage is a paint optimization, never a source of truth. The theme follows the same rule (painted from `avi_theme`, corrected from `settings/main.theme` at boot); only the sound preferences (`avi_sound`, `avi_quiz_sounds`) are localStorage-only.

## Serverless functions and routing

| Function | Style | Purpose |
|---|---|---|
| `get-krdict-api.cjs` | v1 handler (CommonJS) | KRDict dictionary lookups |
| `get-definition.cjs` | v1 handler (CommonJS) | AI-assisted definitions (shape-constrained) |
| `generate-tts.cjs` | v1 handler (CommonJS) | Google Cloud TTS with bucket-cached audio |
| `grammar-quiz.js` | Functions 2.0 (ESM) | Grammar quiz generation and assessment |

All four are reached at `/api/<name>`, but by two mechanisms: `grammar-quiz` routes *itself* via its exported `config.path` (a Functions 2.0 feature, which also grants it a 30-second timeout for the larger prompts), while the three v1 handlers get their `/api` form from redirects in `netlify.toml` — v1 handlers don't support `config.path`. Those redirects sit above the SPA fallback (`/* → /index.html`) and must stay there; redirect order matters.

The functions are the key boundary: every external API secret (`KRDICT_API_KEY`, `ANTHROPIC_API_KEY`, the split `GCP_*` credentials) lives in function environment variables and never reaches the client. The `VITE_FIREBASE_*` values in the client bundle are public by design — Firebase web config is not a secret, which is why `netlify.toml` lists them in `SECRETS_SCAN_OMIT_KEYS` (details in the deployment guide). The three `.cjs` extensions are load-bearing; the gotchas guide explains why they must not be renamed.

The functions never touch Firestore. Anything worth persisting from a function's response — a fetched definition, a generated audio URL — is written by the client afterward.

## Local development

Run `netlify dev`, not `vite dev`. The Netlify CLI wraps the Vite server, serves the functions, applies the `netlify.toml` redirects, and injects environment variables; plain Vite serves none of that, so every `/api/*` call would 404. Open the wrapper's port (the one the CLI prints), not the raw Vite port it proxies. The setup guide covers the environment-variable injection trap when a directory is linked to a Netlify site.

## Theming

Components never hardcode colors or reusable styles. `useAppTheme()` returns `{ C, S }` — the active theme's color tokens and the style objects built from them by `buildColors.js` / `buildStyles.js` — and eight themes ship. The active theme persists in localStorage and in `settings/main` — Firestore wins at boot. The logo is deliberately outside this system: `AVILogo.jsx` renders `public/favicon.svg` with a fixed palette so the in-app mark always matches the favicon and PWA icon (rationale in the gotchas guide). Everything else — theme anatomy, adding a theme, typography, frame generators — lives in the theming guide.

Two layout conventions from the gotchas guide are worth flagging in the map: every fixed-position overlay renders through `createPortal(..., document.body)` (the containing-block trap), and `isMobile` is a module-level constant evaluated once at load, by decision.

The app ships a PWA manifest and icons, so a deployment is installable to a phone home screen as-is.

## One word, end to end

The whole architecture in a single trace. You're reading a novel you've cataloged in the Content Library, and it's set as your current source. You meet 훌륭한 and drop it into Word Input.

1. **Resolve.** `resolveLemmaWithDictionary` (`aviUtils.js`) probes the global lemma map with per-key `getDoc` reads — raw key, normalized key, `+요` variant — through the trust gate. On a trusted hit it returns the mapped lemma; otherwise the de-conjugation heuristics generate candidates, validated against your own `lemmaMaster` headwords first, then against the map, with seed corroboration as a last resort.
2. **Stage.** A row lands in `wordInputs` — surface form, resolved lemma, and provenance as your current source title and section — via the debounced diff sync.
3. **Define.** The reference definition arrives through `/api/get-krdict-api` (throttled client-side by the `aviApiRateLimit` setting) into `def1`; you distill your targeted definition into `def2`.
4. **Correct, maybe.** If the resolution was wrong and you fix the lemma on the row, both loops fire: `writeGlobalLemma` teaches the map (the map loop — next encounter resolves correctly everywhere), and the cascade helpers repair the linked lemma entry and any cards (the master loop). Fixing later in Lemma Master fires only the master loop — the asymmetry is documented in the gotchas guide.
5. **Card.** Completing `def2` triggers `autoCreateWordCard` (`cardFactory.js`): the lemma is ensured in `lemmaMaster`, the deck is found or created by source title (race-safe), the flashcard document is written with its `linkedAVILemmaId` back-reference, and TTS generation fires without awaiting through `/api/generate-tts` — the card is usable immediately and `audioUrl` arrives moments later.
6. **Study.** The card enters the FSRS lifecycle: the daily pipeline (`srsEngine.js`, cached per logical day in `dailyplan`) counts it when due, each grade rewrites its FSRS fields, and each review increments `reviewLog` and the `reviewStats` aggregate that feed the heatmap and streaks.

Every module the trace touched respects the layer diagram: the page called a hook, the hook called utilities, the utilities called Firestore and the functions — and nothing imported upward.
