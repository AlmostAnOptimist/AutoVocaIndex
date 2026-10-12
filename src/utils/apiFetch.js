// src/utils/apiFetch.js
// fetch() wrapper for the app's own /api/* Netlify functions (security
// decision S-D4).
//
// Attaches the signed-in user's Firebase ID token as
// "Authorization: Bearer <token>" so each function can verify the caller
// (netlify/lib/verifyUser.cjs). The Firebase SDK caches the token and
// refreshes it automatically shortly before it expires.
//
// With no signed-in user the request is still sent, just without the header;
// the function answers 401, which every caller already treats as a failed call.
// Leaf module: imports only firebase.js.

import { auth } from '../firebase.js';

export async function apiFetch(url, init = {}) {
  const headers = new Headers(init.headers || {});
  const user = auth?.currentUser;
  if (user) {
    const token = await user.getIdToken();
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(url, { ...init, headers });
}
