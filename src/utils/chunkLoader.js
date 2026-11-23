// src/utils/chunkLoader.js
// Loads one on-demand part of the app (offline decisions OF-D4) and remembers
// it, so the page it holds opens instantly every time after the first.
//
//   const loader = createChunkLoader(() => import('../pages/X.jsx'), m => m.X);
//   loader.peek()   the loaded value, or null when it hasn't loaded yet
//   loader.load()   a promise for the value
//
// A load in progress is shared: asking twice fetches once. A failed load is
// not remembered, so asking again tries again (the device may have been
// offline the first time). No imports; used by src/components/LazyPage.jsx.

export function createChunkLoader(load, pick = (m) => m.default) {
  let value = null;
  let pending = null;

  return {
    peek: () => value,
    load() {
      if (value) return Promise.resolve(value);
      if (pending) return pending;
      const attempt = Promise.resolve()
        .then(load)
        .then((mod) => {
          const got = mod ? pick(mod) : null;
          if (!got) throw new Error('AVI: the loaded file does not hold what was asked for');
          value = got;
          return got;
        });
      // Clear the in-progress marker either way; only a success is kept.
      const clear = () => { if (pending === attempt) pending = null; };
      attempt.then(clear, clear);
      pending = attempt;
      return attempt;
    },
  };
}
