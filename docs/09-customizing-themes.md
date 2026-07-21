# Customizing Themes

This guide covers the design system: how theming works, what a theme is made of, how to add or modify one, the typography, the Art Deco frame treatments, the image placeholder system, and the Gazette plates. It's written for the most common customization path — making your deployment look like yours — and everything here can be done without touching any page logic.

---

## How theming works

Nothing in the components hardcodes a color or a reusable style. The chain is:

```
theme id ─→ buildColors(theme) ─→ buildStyles(C) ─→ useAppTheme()
             = C (color tokens)    = S (style objects)   returns { C, S, G, theme, setTheme }
                                   + buildGlobalStyles(C) = G (global CSS)
```

`buildColors.js` maps a theme id to a flat object of color tokens (`C`). `buildStyles.js` builds the shared style objects (`S`) from those tokens, plus the global stylesheet (`G`) — resets, animations, hover classes, the mobile media block. `useAppTheme()` memoizes all three per theme and is the only thing a component ever calls: `const { C, S } = useAppTheme();`. Change a token in one theme branch and every surface using it updates; that is the entire point of the architecture, and it's why the first rule of modification is *never inline a hex color in a component* — add or reuse a token.

**Persistence.** The active theme id is stored in two places on purpose: localStorage (`avi_theme`) so the very first paint is already in your theme, and the `theme` field of `settings/main` in Firestore so the choice follows you across devices. Boot order: paint from localStorage, then if Firestore settings carry a theme, adopt it and re-mirror to localStorage. Firestore wins. (The fallback default is `ember`; a brand-new account's seeded settings start on `hanok`.)

The theme picker itself (`ThemePanel.jsx`) is fully data-driven — it just maps over the registry, so a new theme appears in it with no picker changes.

## The themes

Eight ship, registered in `THEME_DEFS` (`constants.js`):

| id | Name | Character |
|---|---|---|
| `ember` | Ember | Warm dark — amber and rust (the default) |
| `clay` | Clay | Warm light — terracotta |
| `baroque` | Baroque | Gilded viridian — peacock and gold |
| `koi` | Koi Rush | Muted stone and warmth |
| `feather` | Feather | Mustard gold and pearl on near-black |
| `hanok` | Hanok Dusk | Korean roof-tile grays and ginkgo gold |
| `bauhaus` | Bauhaus Sun | Cream and poster orange |
| `blossom` | Blossom Mist | Spring fog, petal rose and moss |

## Anatomy of a theme

A theme is one return branch in `buildColors(theme)` — a flat object of tokens. Every theme supplies:

| Token(s) | Role |
|---|---|
| `bg`, `surface`, `raised` | The three elevation steps: page background, card surface, raised elements |
| `border`, `borderB` | Hairline border and the bolder frame-line color |
| `text`, `textS`, `textM` | Primary, secondary, and muted text |
| `accent`, `accentSoft` | The theme's primary accent and its translucent wash (an `rgba` of the same hue) |
| `accent2`, `accent2Soft` | The secondary accent pair |
| `danger`, `success`, `warning` | Status colors (a shared fallback trio is spread in first, so a theme may override any or all) |
| `tL`, `tLa`, `tH`, `tF` | Category color tokens — `tLa` is the language category's color; the others are spares kept for category re-expansion (see below) |
| `logoText` | The wordmark text color (the logo *mark* itself is fixed-palette by design — see the gotchas guide) |

Two tokens are optional and consumed through fallbacks: `accentText` (readable text placed *on* the accent — only themes whose accent is light enough to need it, like Baroque, define it) and `cardBg` (an alternate card fill; every consumer reads `C.cardBg || C.surface`). If you add an optional token of your own, follow that pattern — always consume it with a fallback so the other seven themes don't break.

Keep the pairs honest when editing: each `*Soft` should be an `rgba` of its solid partner, and `text` must stay readable on all three elevation steps.

## Adding a theme

1. Add a branch to `buildColors.js`: copy the closest existing theme (dark themes copy `ember`/`feather`, light ones `clay`/`bauhaus`) and edit tokens.
2. Register it in `THEME_DEFS` in `constants.js`: `{ id, name, desc, sw }`, where `sw` is four hex swatches shown as the picker's 2×2 preview tile.

That's the whole procedure — the panel, persistence, and every styled surface pick it up from there. Spot-check the places that exercise the most tokens: a modal (frame + form styles), the Flashcards session (grade buttons use the status trio), and the Content Library's Gazette front page.

## Typography

Five faces, defined once as the `SH` constants in `buildStyles.js` and loaded from Google Fonts in `index.html`:

| Key | Face | Role |
|---|---|---|
| `SH.fd` | Limelight | Display — mastheads, page titles, the wordmark |
| `SH.fb` | Bitter | Body text (also the global `body` font) |
| `SH.fp` | Poiret One | Task rows and chips |
| `SH.fk` | Hahmlet | Korean text — marked `[LANG-SPECIFIC]`; this is the face you swap when converting languages (see that guide) |
| `SH.fm` | DM Mono | Numeric/tabular figures |

To swap a face: change the family in the `index.html` Google Fonts link *and* the corresponding `SH` value (keep its fallback stack). Components reference the `SH` keys, never font names, so nothing else changes — rename values, never the keys. All five ship via Google Fonts, whose catalog is open-licensed; each face's license is on its Google Fonts specimen page if you plan to self-host or redistribute.

## Frames — the Deco treatment

The beveled Art Deco corners are not borders or clip-paths; they are **9-slice SVG border-images**, generated per theme by four builders in `buildStyles.js`:

| Builder | Produces |
|---|---|
| `frameBevel(line)` | Single-line beveled frame, transparent interior |
| `frameDoubleBevel(line)` | Two 1px lines with a 1px gap — the emphasis-button treatment |
| `frameBevelFilled(line, fill, lineOpacity)` | Beveled frame with a filled interior |
| `frameSquareRound(outer, inner, fill)` | The double square-plus-rounded modal frame |

This technique was chosen deliberately: border-image is pure paint. It never clips children and never creates a containing block for fixed-position descendants — the same trap family as the `.fade-up` gotcha — and it stays put on scrolling containers. Corner slices map 1:1 onto `border-image-width` pixels, which keeps 1px lines truly 1px.

Two pairing rules when applying a frame to a new element, both from the builders' own documentation: the element carries a transparent solid border sized to the frame (e.g. `border: '7px solid transparent'`, with matching `borderImageSlice`/`borderImageWidth`), and it sets `backgroundClip: 'padding-box'` so backgrounds — including hover-set ones — can't poke square corners past the beveled lines. Adjust line weight and bevel size by editing the builder parameters and the internal geometry (`octPath`), not by scaling with CSS.

## Images: decoAssets and the placeholder blocks

**The template repository commits no image assets.** Decorative art is resolved through `import.meta.glob` in `decoAssets.js`, so the build succeeds with the files absent — each export is a URL string or `null`. Render sites follow the never-collapse rule: where an image would sit, they reserve the same layout space and render `decoBlockStyle(C)` — a themed diagonal-hatch block — instead. Missing art degrades to deliberate texture, never to collapsed layout.

To supply your own art, drop PNGs into `src/assets/` under the filenames `decoAssets.js` picks (`birbs.png`, `perched_crow_Deco.png`, `DecoDividerPanel_gold.png`), or extend the file with your own globbed exports following the same null-safe pattern. It's a leaf module — it imports nothing — keep it that way.

## The Gazette and its plates

The Content Library's newsprint front page (`GazetteComponents.jsx`, `ContentLibraryGazette.jsx`) includes a vintage-ad space filled by `plateEngine.js`: a deterministic "plate of the day" — the pick is a hash of the date and pool, so it's stable all day without storing anything. The pool is whatever images exist in `src/assets/gazette-plates/library/` (lazily globbed); an optional alias map (`settings/gazetteAdAliases`, edited from the Dev Dashboard) lets a plate be matched to the source named in the day's headline. An empty pool renders nothing, gracefully — like the deco art, the template ships none.

To fill it, drop period-appropriate images into that folder. Keep the folder name: it (and the engine's name) were chosen to stay clear of ad-blocker URL filters, which match ad-ish path segments in dev-mode module URLs — the full story is in the gotchas guide.

## Category colors and re-expansion

The task system ships with the single language category (`CATEGORIES` in `constants.js`), whose entry takes its color from the theme: `color: (C) => C.tLa`. The spare category tokens every theme already carries (`tL`, `tH`, `tF`) exist precisely so you can re-expand: to add a category (say, general life tasks), add an entry to `CATEGORIES` with an unused token — `{ id: 'life', label: 'Life', color: (C) => C.tL }` — and it flows through task chips, pickers, and the appointment-type grouping (`APPOINTMENT_TYPES` is keyed by category id, so give a new category its own type list). Every theme colors the new category consistently with zero theme edits. The language label swap itself belongs to the language-conversion guide.

## What not to touch

The `SH` keys and `C` token *names* are referenced throughout the tree — change their values freely, never their names. The global class names in `buildGlobalStyles` (`.fade-up`, `.slide-up`, `.task-row`, `.sidebar`, `.mobile-nav`, ...) are behavior-bearing — animations, hover states, and the mobile layout switch all key off them. Keep the mobile block's `input, textarea, select { font-size: 16px !important; }` (the iOS focus-zoom guard) and the modal style's `dvh` height cap, both explained in the gotchas guide. And leave the logo outside the theme system: `logoText` colors the wordmark text, but the mark itself is single-sourced from `public/favicon.svg` with a fixed palette so it always matches the favicon and app icon — rebrand by replacing that file, not by theming the component.
