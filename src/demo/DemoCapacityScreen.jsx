// src/demo/DemoCapacityScreen.jsx
// Shown instead of the app when the demo's Firebase project has used up its
// free-tier daily quota (the seed copy for a new visitor fails with
// 'resource-exhausted'). Without this, a visitor would land in an empty
// sandbox whose saves quietly fail, or see the generic "Couldn't reach the
// server" banner, and neither tells them what actually happened.
//
// Firestore's free-tier quotas reset around midnight US Pacific time; the
// reset moment is shown in the visitor's own time zone.

import { useAppTheme } from '../hooks/useAppTheme.js';
import { AVILogo } from '../components/AVILogo.jsx';
import { SH } from '../theme/buildStyles.js';
import { REPO_URL, DEMO_TOUR_URL, nextPacificMidnight } from './demoConfig.js';

export function DemoCapacityScreen() {
  const { C, G } = useAppTheme();
  const resetAt = nextPacificMidnight().toLocaleString([], {
    weekday: 'short', hour: 'numeric', minute: '2-digit',
  });

  const linkStyle = { color: C.accent, fontSize: '14px', textDecoration: 'none' };

  return (
    <>
      <style>{G}</style>
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: C.bg,
        gap: '20px',
        padding: '24px 16px',
        boxSizing: 'border-box',
        textAlign: 'center',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px' }}>
          <AVILogo size={120} />
          <span style={{ fontFamily: SH.fd, fontSize: '24px', fontWeight: 700, color: C.text, letterSpacing: '-0.5px' }}>
            The demo has reached today's limit
          </span>
        </div>

        <p style={{ color: C.textS, fontSize: '14px', lineHeight: 1.7, margin: 0, maxWidth: '440px' }}>
          The public demo runs on a free database plan with a daily cap, and
          today's visitors have used it up. It resets around midnight US
          Pacific time, which is {resetAt} where you are.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
          {DEMO_TOUR_URL && (
            <a href={DEMO_TOUR_URL} target="_blank" rel="noreferrer" style={linkStyle}>
              Watch the video tour
            </a>
          )}
          <a href={`${REPO_URL}/blob/main/docs/01-overview.md`} target="_blank" rel="noreferrer" style={linkStyle}>
            Read what AutoVocaIndex does
          </a>
          <a href={`${REPO_URL}/blob/main/docs/04-setup.md`} target="_blank" rel="noreferrer" style={linkStyle}>
            Set up your own copy (free and self-hosted)
          </a>
        </div>

        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '10px 24px',
            borderRadius: '10px',
            border: `1px solid ${C.border}`,
            background: C.raised,
            color: C.text,
            fontSize: '14px',
            fontFamily: SH.fb,
            cursor: 'pointer',
          }}
        >
          Try again
        </button>
      </div>
    </>
  );
}
