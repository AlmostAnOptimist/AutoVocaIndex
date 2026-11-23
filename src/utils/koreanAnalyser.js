// src/utils/koreanAnalyser.js
// The Korean morphological analyser, in the browser (audit G3, decision
// GS-D1). The engine and model live in the repo (src/vendor/garu-ko, see
// its README); nothing here calls a service.
//
//   const analyse = await loadAnalyser();
//   analyse('내일 비가 와요.') -> [{ text, pos, start, end }, ...]
//
// Loaded the first time it is asked for and kept for the session. The
// loader script comes in by a dynamic import and the engine and model by
// fetch, so none of it is part of the first load; the offline list in
// vite.config.js saves both files on the device after a deploy. A failed
// load is not remembered, so asking again tries again.
//
// Used with src/utils/grammarPatterns.js. Tests load the same files through
// tests/load-analyser.mjs.

import engineUrl from '../vendor/garu-ko/garu_wasm_bg.wasm?url';
import modelUrl from '../vendor/garu-ko/base.gmdl?url';

let ready = null;

export function loadAnalyser() {
  if (!ready) {
    ready = (async () => {
      const [glue, model] = await Promise.all([
        import('../vendor/garu-ko/garu_wasm.js'),
        fetch(modelUrl).then((r) => {
          if (!r.ok) throw new Error(`AVI: the analyser's model could not be loaded (${r.status})`);
          return r.arrayBuffer();
        }),
      ]);
      await glue.default({ module_or_path: engineUrl });
      const engine = new glue.GaruWasm(new Uint8Array(model), false);
      return (text) => (text ? engine.analyze(text).tokens : []);
    })();
    ready.catch(() => { ready = null; });
  }
  return ready;
}
