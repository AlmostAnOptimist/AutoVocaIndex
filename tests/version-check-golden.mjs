// tests/version-check-golden.mjs
// Golden test for src/utils/versionCheck.js (offline decisions OF-D3): the
// app notices a newer deployed build, asks the server sparingly, and never
// mistakes "can't tell" for "new version".
//
// Run from the repo root:   node tests/version-check-golden.mjs   (or: npm test)
// Plain Node; the module has no imports. Exits 1 on any failure.

const { RUNNING_BUILD, fetchDeployedBuild, createVersionWatch } = await import('../src/utils/versionCheck.js');

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`);
}
const json = (body, type = 'application/json', ok = true) => ({ ok, headers: { get: () => type }, json: async () => JSON.parse(body) });

check('outside a build there is no running id', RUNNING_BUILD, null);

// ── Reading the deployed build's id ───────────────────────────
{
  const asked = [];
  const ok = await fetchDeployedBuild(async (url, init) => { asked.push([url, init.cache]); return json('{"version":"b9","precache":[]}'); });
  check('deployed id: read from the asset manifest, never from a cached copy', [ok, asked], ['b9', [['/asset-manifest.json', 'no-store']]]);
  check("can't tell: offline, a server error, the page served in its place, bad or empty content",
    [await fetchDeployedBuild(async () => { throw new TypeError('Failed to fetch'); }),
     await fetchDeployedBuild(async () => json('{}', 'application/json', false)),
     await fetchDeployedBuild(async () => json('<!doctype html>', 'text/html; charset=utf-8')),
     await fetchDeployedBuild(async () => json('not json')),
     await fetchDeployedBuild(async () => json('{"version":""}')),
     await fetchDeployedBuild(async () => json('{"version":7}'))],
    [null, null, null, null, null, null]);
}

// ── Watching for a newer build ────────────────────────────────
{
  let t = 0, asks = 0, deployed = 'b1';
  const seen = [];
  const w = createVersionWatch({ running: 'b1', fetchDeployed: async () => { asks++; return deployed; }, onNew: (id) => seen.push(id), gapMs: 300000, now: () => t });
  await w.check();
  check('same build deployed: nothing to report', [asks, seen, w.found()], [1, [], false]);
  t += 60000; await w.check(); await w.check();
  check('asked at most once in five minutes', asks, 1);
  deployed = 'b2';
  t += 300000; await w.check();
  check('a newer build: reported once, with its id', [asks, seen, w.found()], [2, ['b2'], true]);
  t += 3600000; await w.check(); await w.check();
  check('after that it stops asking', [asks, seen], [2, ['b2']]);
}
{
  let t = 0, asks = 0;
  const seen = [];
  const answers = [null, null, 'b2'];
  const w = createVersionWatch({ running: 'b1', fetchDeployed: async () => answers[asks++], onNew: (id) => seen.push(id), gapMs: 1000, now: () => t });
  await w.check(); t += 1000; await w.check();
  check("can't tell (offline) is never a new version", [asks, seen], [2, []]);
  t += 1000; await w.check();
  check('back online with a newer build: reported', seen, ['b2']);
}
{
  let asks = 0, release;
  const w = createVersionWatch({ running: 'b1', fetchDeployed: () => { asks++; return new Promise(r => { release = () => r('b1'); }); }, onNew: () => {}, gapMs: 0, now: () => 0 });
  const first = w.check(); w.check(); w.check();
  check('one question at a time', asks, 1);
  release(); await first;
  let dev = 0;
  const none = createVersionWatch({ running: null, fetchDeployed: async () => { dev++; return 'b2'; }, onNew: () => { dev += 100; } });
  await none.check();
  check('development (no running id): never asks', dev, 0);
  let threw = 0;
  const bad = createVersionWatch({ running: 'b1', fetchDeployed: async () => { threw++; throw new Error('x'); }, onNew: () => {}, gapMs: 0, now: () => 0 });
  try { await bad.check(); } catch { /* the caller's fetch is expected not to throw */ }
  try { await bad.check(); } catch { /* same */ }
  check('a failed question does not block the next one', threw, 2);
}

console.log(`version-check-golden: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
