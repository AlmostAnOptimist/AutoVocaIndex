// seed/export-lemma-map.js
// One-time GLM seed export (Stage 5.1 / D11). Dumps the globalLemmaMap
// collection to seed/globalLemmaMap.json next to this script.
//
// updatedAt is carried through as the original ISO STRING, verbatim.
// The client trust gate (GLM_SEED_END = '2026-03-24' in aviUtils.js)
// compares updatedAt as a string; any conversion or re-stamping would
// promote machine-generated seed-era junk rows to trusted. The script
// ABORTS if any row's updatedAt is not already a string.
//
// Only cleanedLemma, contributorCount, and updatedAt are exported —
// any other fields on a row are dropped.
//
// Usage (from the repo root, firebase-admin already in node_modules):
//   node seed/export-lemma-map.js <path-to-service-account.json>
//
// The service account key file must live OUTSIDE the repo folder — its
// downloaded filename does not match the serviceAccount*.json ignore
// pattern, so saving it inside the working directory risks a commit.

import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import admin from 'firebase-admin';

const CUTOFF = '2026-03-24'; // GLM_SEED_END — used for the report split only

const keyPath = process.argv[2];
if (!keyPath) {
  console.error('Usage: node seed/export-lemma-map.js <path-to-service-account.json>');
  process.exit(1);
}

const sa = JSON.parse(readFileSync(keyPath, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();

console.log(`Exporting globalLemmaMap from ${sa.project_id} ...`);

const snap = await db.collection('globalLemmaMap').get();

const out = {};
const badUpdatedAt = [];
let preCutoff = 0;

for (const docSnap of snap.docs) {
  const d = docSnap.data();
  const row = {
    cleanedLemma: d.cleanedLemma ?? '',
    contributorCount: d.contributorCount ?? 1,
    updatedAt: d.updatedAt,
  };
  if (typeof row.updatedAt !== 'string') {
    badUpdatedAt.push(docSnap.id);
  } else if (row.updatedAt < CUTOFF) {
    preCutoff++;
  }
  out[docSnap.id] = row;
}

if (badUpdatedAt.length) {
  console.error(`ABORT: ${badUpdatedAt.length} row(s) carry a non-string updatedAt`);
  console.error('(exporting these would corrupt the trust gate). First offenders:');
  console.error(badUpdatedAt.slice(0, 20).join('\n'));
  process.exit(1);
}

const total = snap.size;
const outPath = join(dirname(fileURLToPath(import.meta.url)), 'globalLemmaMap.json.gz');
writeFileSync(outPath, gzipSync(JSON.stringify(out)));

console.log(`Wrote ${total} rows to ${outPath}`);
console.log(`  pre-${CUTOFF} (seed-era): ${preCutoff}`);
console.log(`  ${CUTOFF} and later (organic): ${total - preCutoff}`);
console.log('Sample rows (eyeball for anything that should not ship):');
for (const [k, v] of Object.entries(out).slice(0, 3)) {
  console.log(`  ${k} -> ${JSON.stringify(v)}`);
}
process.exit(0);
