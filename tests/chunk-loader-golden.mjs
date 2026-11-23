// tests/chunk-loader-golden.mjs
// Golden test for src/utils/chunkLoader.js (offline decisions OF-D4): a page
// that loads on demand is fetched once, remembered, and a failed load can be
// tried again.
//
// Run from the repo root:   node tests/chunk-loader-golden.mjs   (or: npm test)
// Plain Node; the module has no imports. Exits 1 on any failure.

const { createChunkLoader } = await import('../src/utils/chunkLoader.js');

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`);
}
const outcome = (p) => p.then(v => ['ok', v], e => ['failed', String(e.message || e)]);
const Page = () => 'page';

// ── A good load ───────────────────────────────────────────────
{
  let fetched = 0;
  const loader = createChunkLoader(async () => { fetched++; return { QuizzesPage: Page, other: 1 }; }, m => m.QuizzesPage);
  check('nothing is fetched until the page is opened', [loader.peek(), fetched], [null, 0]);
  const first = loader.load(), second = loader.load();
  check('opening twice at once fetches once', [first === second, fetched], [true, 0]);
  const got = await first;
  check('the named page comes back', [got === Page, fetched], [true, 1]);
  check('it is remembered, so the next open is instant', [loader.peek() === Page, (await loader.load()) === Page, fetched], [true, true, 1]);
}

// ── The default pick ──────────────────────────────────────────
{
  const loader = createChunkLoader(async () => ({ default: Page }));
  check('with no pick, the file\'s default export is used', (await loader.load()) === Page, true);
}

// ── A failed load can be retried ──────────────────────────────
{
  let fetched = 0;
  const loader = createChunkLoader(async () => {
    fetched++;
    if (fetched < 3) throw new TypeError('Failed to fetch dynamically imported module');
    return { Reader: Page };
  }, m => m.Reader);
  check('offline: the load fails', await outcome(loader.load()), ['failed', 'Failed to fetch dynamically imported module']);
  check('a failure is not remembered', [loader.peek(), fetched], [null, 1]);
  check('trying again fetches again, and can fail again', [await outcome(loader.load()), fetched], [['failed', 'Failed to fetch dynamically imported module'], 2]);
  check('back online: the retry succeeds', [(await loader.load()) === Page, fetched, loader.peek() === Page], [true, 3, true]);
}

// ── A load that throws straight away, not through a promise ───
{
  const loader = createChunkLoader(() => { throw new Error('boom'); });
  check('a load that throws at once is a failed load, not a crash', await outcome(loader.load()), ['failed', 'boom']);
}

// ── The file arrives without the page in it ───────────────────
{
  const wrongName = createChunkLoader(async () => ({ SomethingElse: Page }), m => m.QuizzesPage);
  check('file loaded but the page is not in it: a failure, never a blank page',
    [await outcome(wrongName.load()), wrongName.peek()],
    [['failed', 'AVI: the loaded file does not hold what was asked for'], null]);
  const nothing = createChunkLoader(async () => undefined, m => m.QuizzesPage);
  check('file loaded as nothing at all: a failure too', (await outcome(nothing.load()))[0], 'failed');
}

// ── Each page has its own loader ──────────────────────────────
{
  const A = () => 'a';
  const a = createChunkLoader(async () => ({ A }), m => m.A);
  const b = createChunkLoader(async () => { throw new Error('offline'); }, m => m.B);
  const results = [await outcome(a.load()), await outcome(b.load())];
  check('one page failing does not affect another', [results[0][0], results[1][0], a.peek() === A, b.peek()], ['ok', 'failed', true, null]);
}

console.log(`chunk-loader-golden: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
