// src/components/AVILogo.jsx
// AVI brand mark. Renders the same art as the favicon (public/favicon.svg)
// so the mark stays single-sourced with the browser/tab icon.
// Fixed brand palette (ember/cream/ink); intentionally not theme-tinted.

export function AVILogo({ size = 34 }) {
  return (
    <img
      src="/favicon.svg"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      style={{
        display: 'block',
        borderRadius: Math.round(size * 0.14),
        userSelect: 'none',
      }}
    />
  );
}