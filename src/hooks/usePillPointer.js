// src/hooks/usePillPointer.js
// Pointer tracking for rows of word pills (RC-D11): press on a pill, move
// across others, let go. Works with a mouse, a finger or a pen.
//
// The pickers used mouse events (mousedown / mouseenter / mouseup), which a
// touchscreen only fakes for a tap, so dragging across pills to pick a phrase
// did nothing on a tablet. A touch also captures the pointer to the pill it
// started on, so the pill under the finger is found from its position.
//
//   const { pillProps, containerProps, containerStyle } = usePillPointer({ onDown, onEnter, onUp });
//   <div {...containerProps} style={{ ...containerStyle }}>
//     {pills.map((p, i) => <span key={i} {...pillProps(i)} />)}
//   </div>
//
//   onDown(index)   pressed on a pill
//   onEnter(index)  the pointer moved onto another pill while pressed
//   onUp(index)     let go: the pill it was released on, or the last pill it
//                   was over when released anywhere else
//
// containerStyle is touchAction: 'none', so a drag across the pills doesn't
// scroll the page instead.

import { useRef, useCallback, useMemo, useEffect, useLayoutEffect } from 'react';

function pillIndexAt(e) {
  let el = null;
  if (typeof document !== 'undefined' && typeof document.elementFromPoint === 'function' && e.clientX != null) {
    try { el = document.elementFromPoint(e.clientX, e.clientY); } catch { el = null; }
  }
  if (!el || !el.closest) el = e.target;
  const pill = el && el.closest ? el.closest('[data-pill-idx]') : null;
  if (!pill) return null;
  const n = Number(pill.getAttribute('data-pill-idx'));
  return Number.isFinite(n) ? n : null;
}

const CONTAINER_STYLE = { touchAction: 'none' };

export function usePillPointer({ onDown, onEnter, onUp }) {
  const active = useRef(false);
  const last   = useRef(null);
  const cbs    = useRef({ onDown, onEnter, onUp });
  // The latest callbacks, for the handlers (pointer events come after layout).
  useLayoutEffect(() => { cbs.current = { onDown, onEnter, onUp }; });

  const finish = useCallback((e) => {
    if (!active.current) return;
    active.current = false;
    const i = e ? pillIndexAt(e) : null;
    cbs.current.onUp?.(i != null ? i : last.current);
  }, []);

  // A release outside the pills still ends the press.
  useEffect(() => {
    const up = (e) => finish(e);
    const cancel = () => finish(null);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [finish]);

  const pillProps = useCallback((idx) => ({
    'data-pill-idx': idx,
    onPointerDown: (e) => {
      if (e.button != null && e.button > 0) return; // primary button, touch or pen only
      active.current = true;
      last.current = idx;
      // Let pointermove report whichever pill is under the finger.
      try { e.currentTarget?.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
      cbs.current.onDown?.(idx);
    },
  }), []);

  const containerProps = useMemo(() => ({
    onPointerMove: (e) => {
      if (!active.current) return;
      const i = pillIndexAt(e);
      if (i == null || i === last.current) return;
      last.current = i;
      cbs.current.onEnter?.(i);
    },
    onPointerUp: (e) => finish(e),
  }), [finish]);

  return { pillProps, containerProps, containerStyle: CONTAINER_STYLE };
}
