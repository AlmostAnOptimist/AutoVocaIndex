// src/hooks/useKeyShortcuts.js
// Ergonomic key-map layer over useGlobalKey. Give it { [key]: handler } and
// an enabled flag; it dispatches by event.key and preventDefault()s ONLY the
// keys it handles. It intentionally reuses useGlobalKey for the single window
// listener, the typing guard (input/textarea/select/contenteditable), and the
// ref'd handler — no duplicate listener logic lives here.
import { useGlobalKey } from './useGlobalKey.js';

// map      — { [key: string]: (e: KeyboardEvent) => void }
// enabled  — boolean; pass false to disable (e.g. while a modal is open)
export function useKeyShortcuts(map, enabled = true) {
  useGlobalKey((e) => {
    const handler = map[e.key];
    if (!handler) return;
    e.preventDefault();
    handler(e);
  }, { enabled });
}