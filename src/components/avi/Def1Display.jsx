// src/components/avi/Def1Display.jsx
// Renders a KRDict definition string with collapsible "more senses" expander.
// Used in Word Input, Sentence Input, Lemma Master, and Search tabs.
//
// Props:
//   text     — the definition string (senses separated by "\n\n" or "\n\n-----\n\n")
//   onClick  — optional click handler (used to enter edit mode in parent)
//   C        — theme color object from useAppTheme()

import { useState } from 'react';
import { useAppTheme } from '../../hooks/useAppTheme.js';

const PREVIEW_SENSES = 2;

export function Def1Display({ text, onClick }) {
  const { C } = useAppTheme();
  const [expanded, setExpanded] = useState(false);

  // Collapse 3+ consecutive blank lines to 1 to save space
  const collapsed = text ? text.replace(/\n{3,}/g, '\n\n') : text;
  const senses    = collapsed
    ? collapsed.split(/\n\n(?:-----\n\n)?/).filter(s => s.trim())
    : [];

  const hasMore   = senses.length > PREVIEW_SENSES;
  const shown     = hasMore && !expanded ? senses.slice(0, PREVIEW_SENSES) : senses;
  const remaining = senses.length - PREVIEW_SENSES;

  if (!text) {
    return (
      <div
        style={{ fontSize: '12px', cursor: onClick ? 'text' : 'default', color: C.textM }}
        onClick={onClick}
      >
        —
      </div>
    );
  }

  return (
    <div style={{ fontSize: '12px', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
      <div
        style={{ cursor: onClick ? 'text' : 'default' }}
        onClick={onClick}
      >
        {shown.join('\n\n')}
      </div>
      {hasMore && (
        <div
          onClick={e => { e.stopPropagation(); setExpanded(v => !v); }}
          style={{
            fontSize: '11px',
            color: C.tL || C.accent,
            marginTop: '4px',
            userSelect: 'none',
            cursor: 'pointer',
          }}
        >
          {expanded ? '▲ Show less' : `▼ +${remaining} more sense${remaining > 1 ? 's' : ''}`}
        </div>
      )}
    </div>
  );
}
