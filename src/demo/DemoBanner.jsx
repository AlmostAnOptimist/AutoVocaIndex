// src/demo/DemoBanner.jsx
// Demo banner + expandable guide (7E). Two variants: 'chip' renders the
// compact pill for the desktop topbar date slot; 'strip' renders the slim
// persistent bar mounted above the content area (mobile on every page;
// desktop on the AVI page, whose topbar slot holds the source selector).
// The guide opens as a portal overlay on document.body — never inside a
// transformed ancestor (the .fade-up containing-block gotcha).
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { SH } from '../theme/buildStyles.js';
import { DEMO_TIER, DEMO_CAPS } from './demoConfig.js';

const REPO_URL = 'https://github.com/AlmostAnOptimist/AutoVocaIndex';

export function DemoBanner({ variant = 'chip' }) {
  const { C, S } = useAppTheme();
  const [open, setOpen] = useState(false);

  const chip = (
    <button
      onClick={() => setOpen(true)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '8px',
        background: 'transparent', border: `1px solid ${C.border}`,
        borderRadius: '999px', padding: '4px 12px',
        cursor: 'pointer', color: C.textM, fontSize: '12px', fontFamily: SH.fm,
      }}
    >
      <span>Demo · resets nightly</span>
      <span style={{
        border: `1px solid ${C.accent}`, color: C.accent, borderRadius: '999px',
        padding: '1px 8px', fontWeight: 600,
      }}>
        Guide ▾
      </span>
    </button>
  );

  return (
    <>
      {variant === 'strip' ? (
        <div style={{
          display: 'flex', justifyContent: 'center', padding: '6px 10px',
          borderBottom: `1px solid ${C.border}`, background: C.raised, flexShrink: 0,
        }}>
          {chip}
        </div>
      ) : chip}
      {open && createPortal(
        <div
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 4000,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
            padding: '48px 16px 16px',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: C.bg, border: `1px solid ${C.border}`, borderRadius: '14px',
              maxWidth: '560px', width: '100%', maxHeight: '80vh', overflowY: 'auto',
              padding: '22px 24px', color: C.text, boxSizing: 'border-box',
            }}
          >
            <div style={{ fontFamily: SH.fd, fontSize: '20px', marginBottom: '10px' }}>
              AutoVocaIndex Demo
            </div>
            <p style={{ fontSize: '13px', lineHeight: 1.7, color: C.textS, margin: '0 0 12px' }}>
              This is a sandboxed demo. Everything you add lives in a private
              anonymous account and is wiped nightly at 03:00 KST.
            </p>
            <p style={{ fontSize: '13px', lineHeight: 1.7, color: C.textS, margin: '0 0 12px' }}>
              Suggested flow: choose AVI Additions in the source selector at
              the top of the AVI page, add a sentence in Sentence Input and
              pick target words, follow the lemma resolve and definition fetch,
              head to Flashcards to see the created cards, grade a few, then
              try a vocabulary or cloze quiz in Quizzes.
            </p>
            <p style={{ fontSize: '13px', lineHeight: 1.7, color: C.textS, margin: '0 0 12px' }}>
              This {DEMO_TIER} demo allows {DEMO_CAPS.sentences} sentences of up
              to {DEMO_CAPS.wordsPerSentence} target words each, {DEMO_CAPS.cards} new
              cards, {DEMO_CAPS.quizSessions} quiz sessions, {DEMO_CAPS.tasks} tasks,
              and {DEMO_CAPS.appointments} appointments. Grading is unlimited but
              nothing is persisted. Grammar entries, the Content Library, dictionary 
              settings, AI definitions, audio, and import commits are locked.
            </p>
            <p style={{ fontSize: '13px', lineHeight: 1.7, color: C.textS, margin: '0 0 16px' }}>
              To go further, deploy your own copy — the template is free and
              self-hosted:{' '}
              <a href={REPO_URL} target="_blank" rel="noreferrer" style={{ color: C.accent }}>
                github.com/AlmostAnOptimist/AutoVocaIndex
              </a>
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button style={S.btnGhost} onClick={() => setOpen(false)}>Close</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}