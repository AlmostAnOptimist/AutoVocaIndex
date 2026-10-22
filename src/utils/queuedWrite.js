// ── Queued Firestore writes (bug sweep S6) ───────────────────────────────────
// Leaf module: no page, hook or firebase imports.
//
// The app's Firestore uses the persistent local cache: a write is applied to the
// cache at once, kept on the device (it survives closing the app) and sent
// when there is a connection. Its promise, though, resolves only when the
// server confirms, so on the subway an awaited write never settles. Screens
// that must not wait on the network (grading a card, finishing a quiz) queue
// the write instead and carry on; a write the server later refuses (the doc
// was deleted, a permission error) is reported through onError.

// makeWrite: () => the write's promise. A synchronous throw (invalid data)
// is reported the same way as a rejection.
export function queueWrite(makeWrite, label, onError) {
  const report = (e) => {
    console.error(label, e);
    try { onError?.(e); } catch (err) { console.error(label, 'onError failed', err); }
  };
  let p;
  try { p = makeWrite(); } catch (e) { report(e); return; }
  Promise.resolve(p).catch(report);
}

export const isNotFound = (e) => e?.code === 'not-found';

// True only when the browser says it is offline (undefined counts as online).
export const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
