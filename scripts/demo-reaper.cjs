// scripts/demo-reaper.cjs
// Nightly demo reset (D6): deletes anonymous accounts older than 24 hours —
// their Firestore data first, then the auth user — and records a daily
// stats doc so visitor history accrues.
//
// Runs in GitHub Actions at 18:00 UTC (03:00 KST). Hard no-op when the
// FIREBASE_SERVICE_ACCOUNT env var (the DEMO_SERVICE_ACCOUNT repo secret)
// is absent, so forks and the template itself never reap anything.
//
// Stats: writes demo_stats/{YYYY-MM-DD} (KST date) via the Admin SDK.
// Client rules never grant access to demo_stats — read it in the Firebase
// console. Since accounts older than 24h at each nightly run are roughly
// the previous day's fresh visitors, `deleted` doubles as a daily visitor
// count.

const admin = require('firebase-admin');

const CUTOFF_MS = 24 * 60 * 60 * 1000;

async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.log('demo-reaper: FIREBASE_SERVICE_ACCOUNT not set — no-op.');
    return;
  }

  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(raw)),
  });
  const db = admin.firestore();
  const auth = admin.auth();

  const cutoff = Date.now() - CUTOFF_MS;
  let scanned = 0;
  let deleted = 0;
  let kept = 0;
  const failures = [];

  let pageToken = undefined;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const u of page.users) {
      const isAnonymous = (u.providerData || []).length === 0;
      if (!isAnonymous) continue;
      scanned++;
      const createdAt = Date.parse(u.metadata.creationTime);
      if (!(createdAt < cutoff)) { kept++; continue; }
      try {
        await db.recursiveDelete(db.collection('users').doc(u.uid));
        await auth.deleteUser(u.uid);
        deleted++;
      } catch (e) {
        failures.push(u.uid);
        console.error(`demo-reaper: failed to delete ${u.uid}:`, e.message);
      }
    }
    pageToken = page.pageToken;
  } while (pageToken);

  // KST calendar date for the stats doc id (run fires at 03:00 KST).
  const kstDate = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  await db.collection('demo_stats').doc(kstDate).set({
    date: kstDate,
    scanned,
    deleted,
    kept,
    failures: failures.length,
    ranAt: new Date().toISOString(),
  });

  console.log(
    `demo-reaper: scanned ${scanned} anonymous accounts — deleted ${deleted}, kept ${kept} (<24h), failures ${failures.length}.`
  );
  if (failures.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('demo-reaper: fatal', e);
  process.exit(1);
});
