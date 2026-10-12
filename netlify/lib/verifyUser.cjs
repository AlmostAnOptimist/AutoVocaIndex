// netlify/lib/verifyUser.cjs
// Shared caller check for every Netlify function (security decisions
// S-D2 / S-D3; setup in docs/04-setup.md and docs/05-deployment.md).
//
// The app sends the signed-in user's Firebase ID token as
// "Authorization: Bearer <token>". This verifies the token and then requires
// its uid to be listed in the ALLOWED_UIDS environment variable
// (comma-separated). If ALLOWED_UIDS is missing or empty, EVERY request is
// rejected — the allowlist is required setup, not optional.
//
// Demo site only: get-krdict-api passes { requireAllowlist: false } when
// DEMO_MODE is on, because demo visitors sign in anonymously with random
// uids that can never be listed. The token itself is still verified.
//
// Verifying a token needs only the Firebase project ID (no service-account
// key): firebase-admin checks the signature against Google's public keys.
//
// Lives outside netlify/functions so Netlify doesn't deploy it as a function.
//
// Returns { ok: true, uid } or { ok: false, status, error } — never throws.

// firebase-admin is supplied by the calling function or loaded lazily here.
// The newer-format function (grammar-quiz.js) must import firebase-admin
// itself and hand it over via useFirebaseAdmin(): Netlify's packager for
// that format follows the function's own static imports but not a require()
// inside this helper, so it left firebase-admin out of the package (found
// after S1; fixed in the G1 hotfix). The classic .cjs functions are packaged
// with require() tracing, so the lazy require below works for them.
let firebaseAdmin = null;

function useFirebaseAdmin(mods) {
  firebaseAdmin = mods;
}

function loadFirebaseAdmin() {
  if (!firebaseAdmin) {
    const { initializeApp, getApps } = require('firebase-admin/app');
    const { getAuth } = require('firebase-admin/auth');
    firebaseAdmin = { initializeApp, getApps, getAuth };
  }
  return firebaseAdmin;
}

function getProjectId() {
  return process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || '';
}

function getAllowedUids() {
  return (process.env.ALLOWED_UIDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

async function verifyUser(authHeader, { requireAllowlist = true } = {}) {
  const allowed = getAllowedUids();
  if (requireAllowlist && allowed.length === 0) {
    console.error('verifyUser: ALLOWED_UIDS is not set; rejecting all requests');
    return { ok: false, status: 403, error: 'Server allowlist not configured (ALLOWED_UIDS)' };
  }

  const projectId = getProjectId();
  if (!projectId) {
    console.error('verifyUser: no Firebase project ID (FIREBASE_PROJECT_ID / VITE_FIREBASE_PROJECT_ID)');
    return { ok: false, status: 500, error: 'Server sign-in check not configured' };
  }

  const match = /^Bearer\s+(\S+)\s*$/i.exec(typeof authHeader === 'string' ? authHeader : '');
  if (!match) {
    return { ok: false, status: 401, error: 'Missing sign-in token' };
  }

  let auth;
  try {
    const { initializeApp, getApps, getAuth } = loadFirebaseAdmin();
    const app = getApps()[0] || initializeApp({ projectId });
    auth = getAuth(app);
  } catch (e) {
    console.error('verifyUser: firebase-admin init failed:', e && e.message);
    return { ok: false, status: 500, error: 'Server sign-in check not configured' };
  }

  let decoded;
  try {
    decoded = await auth.verifyIdToken(match[1]);
  } catch (e) {
    console.warn('verifyUser: token rejected:', e && (e.code || e.message));
    return { ok: false, status: 401, error: 'Invalid or expired sign-in token' };
  }

  if (!decoded || (requireAllowlist && !allowed.includes(decoded.uid))) {
    console.warn('verifyUser: uid not on ALLOWED_UIDS:', decoded && decoded.uid);
    return { ok: false, status: 403, error: 'Not authorized' };
  }

  return { ok: true, uid: decoded.uid };
}

module.exports = { verifyUser, useFirebaseAdmin };