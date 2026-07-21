# Converting to Another Language

AVI was built for studying Korean, but the Korean coupling is shallow and marked. The core machinery — the staging tables, the lemma map and its trust gate, the correction loops, decks, FSRS, quizzes, the Content Library — is language-agnostic infrastructure. What's Korean is the *content* layer plugged into it: the dictionary, the de-conjugation heuristics, the answer-grading normalizer, one font, one TTS voice, a few labels and prompts, and the seed data.

Every coupling site of the first kind is tagged with a `[LANG-SPECIFIC]` comment in the tree — search for that string and you have the primary conversion surface. This document walks each marker, states the contract a replacement must satisfy, and finishes with a secondary tier (script-detection regexes), a suggested conversion order, and a test plan. The frame throughout: **infrastructure you keep, Korean content you swap.**

---

## The marker map

| # | Site | What it is |
|---|---|---|
| 1 | `src/constants.js` — `CATEGORIES` | The `한국어` UI label on the study category |
| 2 | `src/theme/buildStyles.js` — `SH.fk` | Hahmlet, the Korean text face |
| 3 | `index.html` — Google Fonts link | Where Hahmlet is loaded |
| 4 | `src/utils/jamoUtils.js` — module header | Korean jamo decomposition and typed-answer grading — replaced wholesale |
| 5 | `src/utils/aviUtils.js` — `KOREAN_VERB_ENDINGS` | The heuristic de-conjugation ending table |
| 6 | `src/utils/aviUtils.js` — `stripKoreanAffixes` | Particle/affix stripping for the lemma heuristic |
| 7 | `src/components/GazetteComponents.jsx` — `GazetteMasthead` | The optional `koreanPrefix` masthead text rendered in Hahmlet |
| 8 | `netlify/functions/generate-tts.cjs` | The `ko-KR` voice configuration |
| 9 | `netlify/functions/get-definition.cjs` | The Korean-dictionary-assistant persona prompt |
| 10 | `netlify/functions/get-krdict-api.cjs` | KRDict, the Korean dictionary provider |
| 11 | `netlify/functions/grammar-quiz.js` — `buildPrompt` | The four grammar-quiz prompt templates |

One related surface carries no marker but belongs to the same job: the Hangul character-class regexes used for script detection, covered below.

## Labels and copy (markers 1, 7)

The study category's label is one string: `constants.js` ships `{ id: 'lang', label: '한국어', ... }` — change `label` to your language's name. Keep the `id` as `'lang'`; it's a join key (appointment types, default category), not display text. `GazetteMasthead` takes an optional `koreanPrefix` prop rendered in the Korean face before the wordmark — pass your language's text (and note it renders in `SH.fk`, so do the font swap too). Finally, sweep the Settings copy: the dictionary-mode option labels and descriptions in `SettingsPage.jsx` name KRDict explicitly and should describe whatever provider you wire in.

One more Korean string hides outside the marker map: `NUANCE_SOURCE_TITLE` in `aviUtils.js` (`동의어/유의어` — "synonyms/near-synonyms"), the reserved source title under which auto-added synonym rows are grouped. Because decks are named by source title, it is also the name of the deck those cards land in. Change the constant's value to your language's word for it at conversion time, before any rows exist — rows store the source string, so renaming later strands existing rows outside the special filter.

## Typography (markers 2, 3)

Hahmlet is the face for target-language text, referenced everywhere as `SH.fk`. Swap it in two places: the family in the `index.html` Google Fonts link, and the `SH.fk` value in `buildStyles.js` — components use the key, never the name, so nothing else changes. Pick a face with full coverage of your language's script; the theming guide covers the mechanics and the rest of the type system.

## The dictionary (marker 10) — and its contract

The boundary is clean: the serverless function fetches, the client parses, and the app only ever consumes a **plain definition string**.

Server side, `get-krdict-api.cjs` accepts `POST { lemma, lang }`, calls KRDict's search API with retry/timeout handling, and returns the raw response as `{ xml }`. Client side, `aviUtils.js` owns the rest: `fetchKrDictEn` / `fetchKrDictKo` post to the function and run `parseKrDictApiXml` over the payload; `fetchDefinition(lemma, aviSettings)` is the single entry point every page calls, dispatching on the `dictMode` setting (`krdict`, `krdict-ko`, `krdict-bi`, or `api`) and returning a string — with `'Definition not found.'` as the graceful miss and `''` for no-ops. It also pre-processes the lemma (`buildFetchTerms` handles slash-separated variants and parenthetical suffix expansion) before fetching each sub-term.

So a conversion has three options, in ascending effort:

1. **AI-only:** skip a dictionary API entirely — set the default `dictMode` to `'api'` and rewrite the persona (next section). Zero parsing work; per-lookup cost applies.
2. **Swap the provider:** keep the function's shape (`POST { lemma, lang }` in, raw payload out, secrets stay server-side) and rewrite its URL plus the client-side parser for your provider's format. Your parser's only obligation is to return a readable definition string or `''`.
3. **Restructure:** if your provider's model doesn't fit the two-step shape, replace the fetcher pair in `aviUtils.js` outright — the rest of the app cares only that `fetchDefinition` keeps its signature and string return.

## The AI definition persona (marker 9)

`get-definition.cjs` accepts `POST { lemma }` and returns `{ definition }`. The marker sits on the system prompt — a Korean dictionary assistant instructed to answer in KRDict's style. Rewrite it for your language: what dictionary style to imitate, which definition language, and the same "return only the definition text" constraint. The prompt is pinned server-side by design (the endpoint accepts nothing but the lemma), so iterating on it is edit-and-retry — `netlify dev` reloads functions on save.

## TTS (marker 8)

One line in `generate-tts.cjs`: `voice: { languageCode: 'ko-KR', name: 'ko-KR-Wavenet-A' }`. Change both fields to any voice from Google Cloud TTS's catalog for your language. The caching layer is language-blind — audio is stored per exact text string — so switching voices mid-life simply generates fresh clips for new text; nothing breaks, though previously cached Korean-voice audio remains until you clear the bucket.

## The de-conjugation heuristics (markers 5, 6) — drop, degrade, or replace

The heuristics live in `aviUtils.js` (not in `jamoUtils.js` — that module has a different job, next section). Three pieces are Korean: the `KOREAN_VERB_ENDINGS` table (longest-suffix-first ending→replacement rules, with minimum-stem-length guards so short nouns that merely *look* conjugated are never mangled), `stripKoreanAffixes` (particle and light-verb stripping), and the irregular-verb recovery logic inside `extractLemmaCandidates` (ㅂ/르/ㄷ/ㅅ-irregular reconstructions like 더워→덥다, 몰라→모르다).

The contract is one function: **`extractLemmaCandidates(surface) → ranked string[]` of dictionary-form guesses, best first.** Everything downstream — map lookups, local-headword validation, seed corroboration, the staging default — consumes that list and already tolerates it being wrong or empty.

That tolerance is the honest good news for conversion: **you can drop the heuristics entirely and AVI still works.** Make `extractLemmaCandidates` return `[surface]` (identity) and resolution degrades to map-lookup-plus-manual-correction — every new form stages as itself, you fix the lemma on the row, the map loop learns the pair, and that form resolves correctly forever after. The system was designed so the map carries an ever-growing share of the load; heuristics only save first-encounter corrections. Write a lemmatizer for your language when — and only when — the manual-correction volume annoys you, and slot it in behind the same function signature. (`normalizeLemma`, by contrast, is mostly script-agnostic punctuation/whitespace tidying and largely survives conversion — its one Hangul-aware rule, keeping parenthetical Hangul as part of the lemma, is worth a read-through.)

Also delete or empty the `+요` politeness-variant probe in `resolveLemmaWithDictionary` — it's a Korean-specific lookup widening that would just waste reads for another language.

## Typed-answer grading (marker 4)

`jamoUtils.js` is the quiz-grading module, replaced wholesale. Its Korean core is jamo decomposition — Hangul syllables are decomposed into letter components (`toJamo`) so that typed-answer distance (`jamoDistance`, a Levenshtein over jamo) measures *typo size the way a Korean typist experiences it*, one wrong keystroke costing one unit rather than one whole syllable. On top of that sit the credit functions the Quizzes page consumes (they grade the vocabulary quiz's typed answers and the cloze quiz's Type mode; the Select modes need no grading): `computeVocaBaseCredit(userAnswer, front)`, `computeClozeCredit(userAnswer, inputForm)`, `applyHintPenalty`, `computeRelatedCredit`, `findClozeTokenIndex(sentence, inputForm)`, `getVocaHints(front)`, and helpers for slash-variant and synonym-pair card fronts.

For an alphabetic language, the honest minimal replacement is: keep the module's structure and exports, replace `toJamo` with a locale normalizer (lowercase, strip diacritics if you want typo forgiveness for them), and let the existing Levenshtein do the rest — the credit thresholds then operate on plain characters. For another syllabic or composed script, decide what a "one-keystroke typo" means there and make the decomposition reflect it. `findClozeTokenIndex` and `getVocaHints` embed assumptions about word boundaries and what a useful first-letter hint is; review both against your script.

## Script detection — the unmarked second tier

Several sites test "is this token in the target language" with a Hangul character class (`/[가-힣]/`). The one that matters most is the **Import tokenizer** in `importEngine.js`, which uses it to keep target-language tokens and route everything else to stopword handling; the others are display/search affordances in `aviUtils.js` and the AVI search, autocomplete, and Lemma Master pages. Convert by replacing the character class with your language's Unicode range (or a small `isTargetLanguage(token)` helper you introduce and reuse — the better long-term move). Grep for `가-힣` to enumerate every site; there are sixteen occurrences across seven files.

## Grammar quizzes and the Grammar Index

The Grammar Index itself is language-agnostic — free-text pattern names, explanations, examples — and needs no conversion beyond your own content. The **grammar-quiz prompt templates** are not: all four — `selection`, `drill`, `broad`, and `assess` (the grader for translation answers) — live server-side in `netlify/functions/grammar-quiz.js` under marker 11, and each explicitly frames translation into Korean and assessment of Korean output. (In the quiz config UI these surface as two modes, Translation — with drill and broad sub-modes, graded through `assess` — and Selection.) Rewrite them there, alongside the definition persona (they're the same kind of change) — the client only sends structured quiz config, so nothing client-side needs to change for the prompts themselves. Do check the quiz-config copy in `QuizzesPage.jsx` that says "Korean" in a few labels. The pipe-separated `compareTo` convention exists because commas occur inside Korean grammar titles — check whether your language has the same collision before simplifying it.

## The lemma map seed

**Do not import the Korean seed.** `seed/globalLemmaMap.json` is surface→lemma pairs for Korean; for any other language it is noise. Start with an empty map: skip the seed step in setup, and the map grows organically from your corrections — the map loop was designed to work exactly this way. The trust gate still governs organic growth correctly (everything you write post-dates the seed cutoff, so your entries are trusted immediately). That said, a seed is worth having eventually, and it's worth understanding why: the map shines exactly where a learner is weakest. When you meet an inflected form you don't recognize, you may not know enough to de-conjugate it yourself — you can't look up a dictionary form you can't derive. A well-stocked map resolves those forms *for* you, and that matters most in the beginner and intermediate stretch when unrecognized forms are the majority of what you meet. The heuristics are the other safety net, but a map hit is exact where a heuristic is a guess.

A basic recipe for generating one: start from a frequency list or corpus of common *inflected* forms in your language (course wordlists, subtitle corpora, graded readers), and produce surface→lemma pairs with whatever lemmatizer your language has — a morphological analyzer from an NLP library if one exists, or an LLM pass over the list if not (the Korean seed was machine-generated this way). Then apply the gate's lesson: bulk machine-generated mappings *will* contain junk, so stamp every generated row's `updatedAt` with a date before a cutoff of your choosing, set `GLM_SEED_END` in `aviUtils.js` to that cutoff, and import with the shipped script — `seed/import-lemma-map.js` works for any language's JSON in the same three-field format (see the data model guide). Your own corrections post-date the cutoff and are trusted immediately; the generated rows stay corroboration-only, exactly as the Korean seed does.

## What you don't touch

Everything else is infrastructure: Firestore collections and rules, the sync layers, the correction loops, `writeGlobalLemma` and the trust gate, decks and the card factory, FSRS, the daily pipeline, the Content Library, tasks and appointments, themes and frames. None of it knows what language it's carrying.

## Suggested order, and the test that proves it

Convert in this order — each step is independently verifiable: label and copy (1) → font (2, 3) → dictionary (10, 9) → TTS (8) → script detection tier → grading module (4) → quiz prompts → heuristics last, if at all (5, 6). Leave the seed step out of your setup entirely.

Then run the end-to-end test, which is just the architecture guide's trace in your language: catalog a source, enter a conjugated or inflected word, watch it stage (expect identity resolution if you dropped the heuristics), fix the lemma on the row, fetch a definition, write your `def2`, confirm the card lands in the source's deck with working audio, re-enter another form of the same word and watch the map loop resolve it — then take a vocabulary quiz and confirm typed-answer grading feels fair for your script. If all of that holds, the conversion is done.
