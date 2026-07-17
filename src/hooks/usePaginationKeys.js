// src/hooks/usePaginationKeys.js
// Arrow-key pagination: ArrowLeft → previous page, ArrowRight → next page.
// Built on useKeyShortcuts for consistent typing-guard and event handling.
// Never wraps — clamps at first and last page.
//
// page       — zero-indexed current page (pass the clamped value)
// totalPages — total number of pages
// setPage    — raw page setter; may be wrapped with scroll/side-effect logic
// enabled    — pass false while any modal or popup on the page is open
import { useKeyShortcuts } from './useKeyShortcuts.js';

export function usePaginationKeys({ page, totalPages, setPage, enabled = true }) {
  useKeyShortcuts({
    ArrowLeft:  () => { if (page > 0) setPage(page - 1); },
    ArrowRight: () => { if (page < totalPages - 1) setPage(page + 1); },
  }, enabled);
}