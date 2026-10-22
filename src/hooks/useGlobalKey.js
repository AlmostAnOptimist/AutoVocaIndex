// src/hooks/useGlobalKey.js
// Global keydown hook used by quiz and list-navigation features.
// Automatically skips events that originate from any interactive input element
// (input, textarea, select, or contenteditable) so keyboard shortcuts never
// conflict with typing. Pass allowInInput: true to override this guard.
import { useEffect, useRef } from 'react';
import { isComposingKey } from '../utils/keyUtils.js';

function isInInput(e) {
  const el = e.target;
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

// handler  — function(e: KeyboardEvent): void
// options  — { enabled?: boolean, allowInInput?: boolean }
//
// Uses a ref to hold the latest handler so the window listener is only
// re-registered when `enabled` or `allowInInput` changes, not on every render.
export function useGlobalKey(handler, { enabled = true, allowInInput = false } = {}) {
  const handlerRef = useRef(handler);
  useEffect(() => { handlerRef.current = handler; });

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e) => {
      if (!allowInInput && isInInput(e)) return;
      handlerRef.current(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, allowInInput]);
}

// U9: Enter = Done on a results screen. A plain global Enter fired on the
// same keystroke burst that finished the quiz (a key held down, or a quick
// second press), so the results flashed by unread. This one:
//   - is armed only DONE_KEY_ARM_MS after the screen appears (or after
//     `enabled` turns on), so the Enter that ended the quiz can't also leave;
//   - ignores auto-repeat from a held key and an IME-composing Enter;
//   - leaves Enter on a focused button or link to that control.
export const DONE_KEY_ARM_MS = 600;
export function useDoneKey(onDone, { enabled = true, armMs = DONE_KEY_ARM_MS } = {}) {
  const armedAt = useRef(Infinity);
  useEffect(() => {
    armedAt.current = enabled ? Date.now() + armMs : Infinity;
  }, [enabled, armMs]);
  useGlobalKey(e => {
    if (e.key !== 'Enter' || e.repeat || isComposingKey(e)) return;
    if (Date.now() < armedAt.current) return;
    if (e.target?.closest?.('button, a, [role="button"]')) return;
    onDone();
  }, { enabled });
}
