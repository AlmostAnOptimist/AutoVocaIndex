// src/components/SignInScreen.jsx
// Shown when no user is signed in. Handles Google Sign-In.

import { useState } from 'react';
import { signInWithPopup, signInAnonymously } from 'firebase/auth';
import { auth, googleProvider } from '../firebase.js';
import { DEMO } from '../demo/demoConfig.js';
import { useAppTheme } from '../hooks/useAppTheme.js';
import { AVILogo } from './AVILogo.jsx';
import { buildGlobalStyles, SH } from '../theme/buildStyles.js';

export function SignInScreen({ preparing = false }) {
  const { C, S, G } = useAppTheme();
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);

  const handleSignIn = async () => {
    setLoading(true);
    setError(null);
    try {
      await signInWithPopup(auth, googleProvider);
      // onAuthStateChanged in App.jsx picks up the new user automatically
    } catch (e) {
      console.error('Sign-in failed:', e);
      setError('Sign-in failed. Please try again.');
      setLoading(false);
    }
  };

  const handleDemoEnter = async () => {
    setLoading(true);
    setError(null);
    try {
      await signInAnonymously(auth);
      // onAuthStateChanged in App.jsx picks up the new user; the demo seed
      // copy runs before any data loads (see the App.jsx seed gate).
    } catch (e) {
      console.error('Demo sign-in failed:', e);
      setError('Could not enter the demo. Please try again.');
      setLoading(false);
    }
  };

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
        gap: '24px',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px' }}>
          <AVILogo size={185} />
          <span style={{ fontFamily: SH.fd, fontSize: '28px', fontWeight: 700, color: C.text, letterSpacing: '-0.5px' }}>
            AutoVocaIndex
          </span>
        </div>

        <p style={{ color: C.textM, fontSize: '14px', margin: 0 }}>
          {preparing
            ? 'Preparing AVI sandbox…'
            : DEMO
              ? 'A sandboxed demo with sample data. Resets nightly.'
              : 'Sign in to sync your data across devices.'}
        </p>

        {DEMO && !preparing && (
          <button
            onClick={handleDemoEnter}
            disabled={loading}
            style={{
              padding: '10px 24px',
              borderRadius: '10px',
              border: `1px solid ${C.border}`,
              background: C.raised,
              color: C.text,
              fontSize: '14px',
              fontFamily: SH.fb,
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.6 : 1,
              transition: 'opacity 0.15s',
            }}
          >
            {loading ? 'Entering…' : 'Enter the demo'}
          </button>
        )}

        {!DEMO && !preparing && (
        <button
          onClick={handleSignIn}
          disabled={loading}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '10px 20px',
            borderRadius: '10px',
            border: `1px solid ${C.border}`,
            background: C.raised,
            color: C.text,
            fontSize: '14px',
            fontFamily: SH.fb,
            cursor: loading ? 'not-allowed' : 'pointer',
            opacity: loading ? 0.6 : 1,
            transition: 'opacity 0.15s',
          }}
        >
          {/* Google G SVG */}
          <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
            <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z" fill="#4285F4"/>
            <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
            <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
            <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
          </svg>
          {loading ? 'Signing in…' : 'Sign in with Google'}
        </button>
        )}

        {error && (
          <p style={{ color: C.danger || '#e05252', fontSize: '13px', margin: 0 }}>{error}</p>
        )}
      </div>
    </>
  );
}