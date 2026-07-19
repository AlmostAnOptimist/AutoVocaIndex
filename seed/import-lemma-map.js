// seed/import-lemma-map.js
// GLM seed import (Stage 5.1 / D11). Imports seed/globalLemmaMap.json
// into the target project's globalLemmaMap collection via the Admin SDK.
//
// updatedAt is written as the original ISO STRING, verbatim — never
// re-stamped, never converted to a Timestamp. The client trust gate
// compares this string against '2026-03-24'; an import that stamps "now"
// promotes every machine-generated seed-era junk row to trusted. The
// script aborts before writing anything if any row's updatedAt is not a
// string, and finishes with an automatic spot-check: the oldest
// pre-cutoff row is read back from the target project and compared
// against the JSON.
//
// Ordering (D10/D11): run this while the target project is still on
// Blaze, THEN downgrade the project to Spark. Safe to re-run — set()
// overwrites in place.
//
// Usage (from the repo root, firebase-admin already in node_modules):
//   node seed/import-lemma-map.js <path-to-service-account.json>
//
// The service account key file must live OUTSIDE the repo folder — its
// downloaded filename does not match the serviceAccount*.json ignore
// pattern, so saving it inside the working directory risks a commit.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import admin from 'firebase-admin';

const BATCH_CAP = 450; // Firestore hygiene: never exceed 450 ops per batch
const CUTOFF = '2026-03-24'; // GLM_SEED_END

const keyPath = process.argv[2];
if (!keyPath) {
  console.error('Usage: node seed/import-lemma-map.js <path-to-service-account.json>');
  process.exit(1);
}

const sa = JSON.parse(readFileSync(keyPath, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

const seedPath = join(dirname(fileURLToPath(import.meta.url)), 'globalLemmaMap.json');
const rows = JSON.parse(readFileSync(seedPath, 'utf8'));
const entries = Object.entries(rows);

if (!entries.length) {
  console.error('ABORT: seed/globalLemmaMap.json is empty.');
  process.exit(1);
}

// Pre-flight: every updatedAt must already be a string.
const bad = entries.filter(([, v]) => typeof v.updatedAt !== 'string');
if (bad.length) {
  console.error(`ABORT: ${bad.length} row(s) carry a non-string updatedAt. First offenders:`);
  console.error(bad.slice(0, 20).map(([k]) => k).join('\n'));
  process.exit(1);
}

console.log(`Importing ${entries.length} rows into ${sa.project_id} ...`);

let written = 0;
for (let i = 0; i < entries.length; i += BATCH_CAP) {
  const slice = entries.slice(i, i + BATCH_CAP);
  const batch = db.batch();
  for (const [key, v] of slice) {
    batch.set(db.collection('globalLemmaMap').doc(key), {
      cleanedLemma: v.cleanedLemma,
      contributorCount: v.contributorCount,
      updatedAt: v.updatedAt,
    });
  }
  await batch.commit();
  written += slice.length;
  console.log(`  ${written}/${entries.length}`);
}

// Spot-check (the 5.1 verification step, automated): oldest pre-cutoff
// row read back from the target — updatedAt must equal the JSON string.
const preCutoff = entries
  .filter(([, v]) => v.updatedAt < CUTOFF)
  .sort((a, b) => (a[1].updatedAt < b[1].updatedAt ? -1 : 1));

if (!preCutoff.length) {
  console.warn(`Spot-check skipped: no pre-${CUTOFF} rows in the seed file.`);
} else {
  const [key, expected] = preCutoff[0];
  const snap = await db.collection('globalLemmaMap').doc(key).get();
  const got = snap.exists ? snap.data() : null;
  const ok = !!got && got.updatedAt === expected.updatedAt;
  console.log(`Spot-check "${key}":`);
  console.log(`  expected updatedAt "${expected.updatedAt}"`);
  console.log(`  read back "${got ? got.updatedAt : '(missing)'}"`);
  if (!ok) {
    console.error('MISMATCH — the trust gate is compromised. Investigate before the Spark downgrade.');
    process.exit(1);
  }
  console.log('  verbatim OK');
}

console.log('Import complete. Next: downgrade the project Blaze -> Spark (D10).');
process.exit(0);
