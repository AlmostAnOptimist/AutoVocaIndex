// src/hooks/useGlobalKey.js
// Global keydown hook used by quiz and list-navigation features.
// Automatically skips events that originate from any interactive input element
// (input, textarea, select, or contenteditable) so keyboard shortcuts never
// conflict with typing. Pass allowInInput: true to override this guard.
import { useEffect, useRef } from 'react';

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