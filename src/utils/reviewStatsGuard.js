// src/utils/reviewStatsGuard.js
// Keeps the review records (best day, streaks, totals) from being written
// before they have been read (audit FS4).
//
// The records live in one small doc that is written whole after every grade.
// Written from the blank starting value, that wipes the all-time records;
// this happened whenever the first grade beat the load, or the load failed.
// The guard holds grades made before the load in a backlog, applies them on
// top of the loaded records when it lands, and tries a failed load again at
// the next grade. Nothing is ever saved until a load has succeeded.
//
// refresh() reads the records again (SC-D7), for the start of each review
// session: the copy in memory may be hours old, and reviews done on another
// device since then would be overwritten by the next save. Grades made while
// the fresh copy is on its way wait in the same backlog. If the read fails,
// they are applied to the copy already held, as before.
//
// Leaf module, no imports. The caller supplies:
//   load()            -> Promise of the stored records (or the empty shape
//                        when none exist yet); rejects when unreadable
//   save(stats)       -> writes the records
//   apply(stats, g)   -> the records after one more grade g
//   onChange(stats)   -> optional; called with every new value

export function createStatsGuard({ load, save, apply, onChange }) {
  let stats   = null;
  let loaded  = false;
  let loading = false;
  let backlog = [];

  const set = (next, write) => {
    stats = next;
    if (write) save(next);
    if (onChange) onChange(next);
  };

  function ensureLoaded() {
    if (loaded || loading) return;
    loading = true;
    Promise.resolve()
      .then(load)
      .then(found => {
        loaded = true;
        const pending = backlog;
        backlog = [];
        let next = found;
        for (const g of pending) next = apply(next, g);
        set(next, pending.length > 0);
      })
      .catch(e => console.error('reviewStats: load failed', e))
      .finally(() => { loading = false; });
  }

  function refresh() {
    if (!loaded) { ensureLoaded(); return; }
    if (loading) return;
    loading = true;
    const settle = (base) => {
      const pending = backlog;
      backlog = [];
      let next = base;
      for (const g of pending) next = apply(next, g);
      // Nothing new and no grades held: leave the value (and the screen) alone.
      if (pending.length > 0 || base !== stats) set(next, pending.length > 0);
    };
    Promise.resolve()
      .then(load)
      .then(found => settle(found), e => {
        console.error('reviewStats: refresh failed; keeping the copy in memory', e);
        settle(stats);
      })
      .catch(e => console.error('reviewStats: refresh could not be applied', e))
      .finally(() => { loading = false; });
  }

  function record(grade) {
    // While a load or refresh is on its way, hold the grade for its result.
    if (loaded && !loading) { set(apply(stats, grade), true); return; }
    backlog.push(grade);
    ensureLoaded();
  }

  return {
    ensureLoaded,
    refresh,
    record,
    isLoaded: () => loaded,
    pending:  () => backlog.length,
  };
}
