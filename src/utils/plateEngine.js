// src/utils/plateEngine.js
// (named to avoid ad-blocker URL filters, which match "adengine" in dev-mode module paths)
// Deterministic "ad of the day" selection for the Gazette ad space, used
// by the Content Library. No randomness library — a same-day pick is
// always the same pick, computed by hashing a seed string into an index,
// not stored anywhere.
//
// Content Library passes real `subjects` (sources the day's headline
// actually names, each { id, title } — see headlineEngine.js) and an alias
// map loaded from Firestore (users/{uid}/settings/gazetteAdAliases, edited
// via the Dev Dashboard). A caller with no matching concept can pass
// subjects: [] and aliasMap: {}, which makes the pick plain random by
// construction rather than a special-cased branch.

// Small string hash → deterministic non-negative integer. Not
// cryptographic; just needs to scatter different seed strings evenly
// across an index range.
function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function seededIndex(seed, length) {
  if (!length) return -1;
  return hashString(seed) % length;
}

function normalize(s) {
  return (s || '').toLowerCase().replace(/[\s.,!?'"()[\]{}\-–—:;·…]/g, '');
}

/**
 * filenames: string[] — every image currently in the pool (filenames only,
 *   from a lazy import.meta.glob — see GazetteAdSpace in GazetteComponents.jsx).
 * aliasMap: { [filename]: string } — comma-separated aliases, as edited in
 *   DevDashboard. Pass {} for a page with no matching concept.
 * subjects: { id, title }[] — real sources the day's headline names. Pass
 *   [] for a page with no matching concept.
 * dateSeed: a stable per-day string (the page's todayStr).
 * salt: a short string distinguishing this pool from any other sharing the
 *   same dateSeed, so two pools never move in lockstep just because they
 *   happen to be the same size on the same day.
 *
 * Returns null if the pool is empty. Otherwise { filename, subject }, where
 * `subject` is the matched { id, title } when a match drove the pick, or
 * null when the pick was plain random — callers use this to decide whether
 * the ad should be clickable.
 */
export function pickAd({ filenames, aliasMap = {}, subjects = [], dateSeed, salt }) {
  if (!filenames || filenames.length === 0) return null;

  const normSubjects = subjects
    .map(s => ({ ...s, _norm: normalize(s.title) }))
    .filter(s => s._norm);

  const matches = [];
  if (normSubjects.length) {
    for (const filename of filenames) {
      const aliasStr = aliasMap[filename];
      if (!aliasStr) continue;
      const aliases = aliasStr.split(',').map(normalize).filter(Boolean);
      if (!aliases.length) continue;
      const hit = normSubjects.find(s => aliases.some(a => s._norm.includes(a) || a.includes(s._norm)));
      if (hit) matches.push({ filename, subject: { id: hit.id, title: hit.title } });
    }
  }

  if (matches.length) {
    const idx = seededIndex(`${dateSeed}|${salt}|match`, matches.length);
    return matches[idx];
  }

  const idx = seededIndex(`${dateSeed}|${salt}|random`, filenames.length);
  return { filename: filenames[idx], subject: null };
}