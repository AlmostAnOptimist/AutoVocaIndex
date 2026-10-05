import { StrictMode, Component } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

// ── Boot error boundary ───────────────────────────────────────
// Any error thrown during render or a lifecycle method — including the
// synchronous localStorage read + recurrence-engine run in App's `data`
// useState initializer — is caught here instead of blanking the screen.
// iOS Safari can evict or partially corrupt localStorage in the background,
// which makes a persisted blob throw on the next boot and (with no boundary)
// white-screens every load until site data is cleared by hand. This turns
// that failure into a one-tap recovery: clear local data and reload. All
// real data lives in Firestore and reloads on the next boot; auth persists
// in IndexedDB, so this does NOT sign the user out. It catches render and
// lifecycle errors only — not async promise rejections or event handlers,
// which don't blank the screen.
class BootErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error('AVI: boot error boundary caught', error, info);
  }

  handleReset = () => {
    try { localStorage.clear(); } catch {}
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div style={{
        position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', padding: '24px',
        background: '#1a1613', color: '#f0e9df', textAlign: 'center',
        fontFamily: 'system-ui, -apple-system, sans-serif', lineHeight: 1.5,
      }}>
        <div style={{ maxWidth: '340px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none"
            stroke="#c8823c" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ marginBottom: '18px' }} aria-hidden="true">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <h1 style={{ fontSize: '18px', fontWeight: 700, margin: '0 0 10px' }}>
            AutoVocaIndex couldn't finish loading
          </h1>
          <p style={{ fontSize: '14px', margin: '0 0 22px', opacity: 0.85 }}>
            Some data saved on this device looks corrupted. Clearing it and reloading
            should fix it. Your synced data is safe — it will load back from the server,
            and you'll stay signed in.
          </p>
          <button onClick={this.handleReset} style={{
            appearance: 'none', border: '1px solid #c8823c', borderRadius: '8px',
            background: '#c8823c', color: '#1a1613', fontSize: '16px', fontWeight: 600,
            padding: '12px 22px', cursor: 'pointer', width: '100%',
          }}>
            Reset local data and reload
          </button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BootErrorBoundary>
      <App />
    </BootErrorBoundary>
  </StrictMode>
);