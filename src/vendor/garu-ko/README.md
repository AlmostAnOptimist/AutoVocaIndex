# garu-ko, kept in the repo

The Korean morphological analyser AutoVocaIndex uses to recognise Grammar
Index patterns in a sentence (grammar sightings) and as the lemma resolver's
second opinion. It runs entirely in the browser. Nothing here calls a
service.

- **What:** garu-ko **0.13.0**, by Yongjin Cho, https://github.com/ongjin/garu
- **Copied from** the npm package `garu-ko@0.13.0` on Nov 13, 2026, unchanged.
- **Why it is here and not in package.json:** so it can never change or
  disappear underneath the app, and so the lock file is not touched.

## Files

| File | From the package | What it is |
|---|---|---|
| `garu_wasm.js` | `pkg/garu_wasm.js` | Loader for the engine |
| `snippets/…/inline0.js` | `pkg/snippets/…/inline0.js` | A one-line helper the loader imports |
| `garu_wasm_bg.wasm` | `pkg/garu_wasm_bg.wasm` | The engine (about 0.45 MB) |
| `base.gmdl` | `models/base.gmdl` | The model (about 1.34 MB) |
| `LICENSE`, `NOTICE` | same | Apache-2.0 licence and notice for the engine |
| `MODEL-NOTICE.md` | `models/NOTICE.md` | Attribution and terms for the dictionary data inside the model |
| `licenses/` | `models/licenses/` | The licence texts that notice refers to |

Not copied: the package's `dist/` wrappers (the app calls the loader directly
from `src/utils/koreanAnalyser.js`) and its provenance lists
(`models/bulk-provenance.json`, `models/sentence-provenance.json`), which are
in the package and the repository above.

## Used by

- `src/utils/koreanAnalyser.js` loads it in the browser, the first time it is
  needed and never with the first load.
- `tests/load-analyser.mjs` loads the same files in Node for the tests.

## Replacing it with a newer version

Only on purpose; nothing requires it. Copy the same files from the new
package over these, update the version above, then run `npm test`
(`grammar-patterns-golden` records what this version finds) and the Pattern
check in Dev Dashboard, and compare the counts before and after.

These files are not linted (`src/vendor` is ignored in both ESLint configs).
