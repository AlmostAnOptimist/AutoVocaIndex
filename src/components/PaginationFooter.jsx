// src/components/PaginationFooter.jsx
// Shared Prev/Next pagination control for paged tables/lists.
// Standardized behavior: renders nothing when there's only one page (or zero) —
// matching AVILemmaMasterPage's original behavior, now the app-wide standard.
// First/Last jump buttons appear when totalPages > 2 and onFirst/onLast are provided.
import { SH } from '../theme/buildStyles.js';
import { Icons } from './Icons.jsx';

export function PaginationFooter({ page, totalPages, count, onPrev, onNext, onFirst, onLast, singular = 'entry', plural, C }) {
  if (totalPages <= 1) return null;
  const pluralForm = plural || (singular === 'entry' ? 'entries' : `${singular}s`);
  const label = count === 1 ? singular : pluralForm;
  const showEnds = totalPages > 2 && !!onFirst && !!onLast;

  return (
    <div style={{
      flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '10px 0 4px', borderTop: `1px solid ${C.border}`, marginTop: '4px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        {showEnds && (
          <button
            style={pageBtn(C, page === 0, true)}
            disabled={page === 0}
            onClick={onFirst}
            title="First page"
          ><span style={{ display: 'inline-flex', alignItems: 'center' }}>{Icons.skipFirst}</span></button>
        )}
        <button
          style={pageBtn(C, page === 0)}
          disabled={page === 0}
          onClick={onPrev}
        ><span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>{Icons.chevronLeft} Prev</span></button>
      </div>

      <span style={{ fontSize: '12px', color: C.textM, fontFamily: SH.fm }}>
        {page + 1} / {totalPages} · {count} {label}
      </span>

      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <button
          style={pageBtn(C, page >= totalPages - 1)}
          disabled={page >= totalPages - 1}
          onClick={onNext}
        ><span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>Next {Icons.chevronRight}</span></button>
        {showEnds && (
          <button
            style={pageBtn(C, page >= totalPages - 1, true)}
            disabled={page >= totalPages - 1}
            onClick={onLast}
            title="Last page"
          ><span style={{ display: 'inline-flex', alignItems: 'center' }}>{Icons.skipLast}</span></button>
        )}
      </div>
    </div>
  );
}

function pageBtn(C, disabled, compact = false) {
  return {
    padding: compact ? '4px 7px' : '4px 12px',
    borderRadius: '6px', fontSize: '12px',
    border: `1px solid ${C.border}`, background: 'transparent',
    color: C.textM, cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.35 : 1,
    lineHeight: 1,
  };
}