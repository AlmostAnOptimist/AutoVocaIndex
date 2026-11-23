// tests/lacking-def2-golden.mjs
// Golden test for src/utils/lackingDef2.js (audit batch B5): which words lack
// a Definition 2, how they are counted, and the order of the queue.
//
// Run from the repo root:   node tests/lacking-def2-golden.mjs   (or: npm test)
// Plain Node; the module has no imports. Exits 1 on any failure.

const { rowLacksDef2, lackingDef2Rows, lackingDef2Count, queueRows } = await import('../src/utils/lackingDef2.js');

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`);
}
const uids = (rows) => rows.map(r => r.uid);
const row = (uid, lemma, extra = {}) => ({ uid, lemma, input: lemma, def1: 'x', def2: '', ts: '2026-11-01T00:00:00.000Z', ...extra });

// ── One row ───────────────────────────────────────────────────
check('no Def2: lacking', rowLacksDef2(row('a', '먹다')), true);
check('has a Def2: not lacking', rowLacksDef2(row('a', '먹다', { def2: 'to eat' })), false);
check('a Def2 of only spaces is no Def2', rowLacksDef2(row('a', '먹다', { def2: '   ' })), true);
check('Def2 field missing altogether: lacking', rowLacksDef2({ uid: 'a', lemma: '먹다' }), true);
check('skipped: never lacking', rowLacksDef2(row('a', '먹다', { skipUpload: true })), false);
check('nothing at all', [rowLacksDef2(null), rowLacksDef2(undefined)], [false, false]);

// ── Not in a deck is not the same as lacking a Def2 ───────────
// The audit's note: rows that are not in decks although no word lacks a Def2.
{
  const rows = [
    row('reset', '가다', { def2: 'to go', uploaded: false, lastUncheckReason: 'Definition 2 edited' }),
    row('skipped', '오다', { skipUpload: true, uploaded: false }),
    row('skippedWithDef', '보다', { def2: 'to see', skipUpload: true }),
    row('inDeck', '하다', { def2: 'to do', uploaded: true }),
  ];
  check('reset rows and skipped rows are not counted', [lackingDef2Count(rows), uids(lackingDef2Rows(rows))], [0, []]);
}

// ── Counted once per word ─────────────────────────────────────
{
  const rows = [
    row('n1', '사과', { source: 'Book A', ts: '2026-11-03T00:00:00.000Z' }),
    row('n2', '사과', { source: 'Book B', ts: '2026-11-02T00:00:00.000Z' }),
    row('n3', '배', { ts: '2026-11-04T00:00:00.000Z' }),
  ];
  check('two rows of one word count once, by its oldest row', [lackingDef2Count(rows), uids(lackingDef2Rows(rows))], [2, ['n2', 'n3']]);
  const mixed = [row('m1', '사과', { def2: 'apple' }), row('m2', '사과')];
  check('a word with one filled row and one empty row still shows (the empty row)', uids(lackingDef2Rows(mixed)), ['m2']);
  const oneSkipped = [row('s1', '사과', { skipUpload: true }), row('s2', '사과', { source: 'Book B' })];
  check('skipped in one source, wanted in another: counted through the wanted row', uids(lackingDef2Rows(oneSkipped)), ['s2']);
}

// ── What makes two rows the same word is the caller's rule ────
{
  const rows = [row('p1', '먹다'), row('p2', ' 먹다 '), row('p3', '먹다 (eat)')];
  check('default: same text after trimming', uids(lackingDef2Rows(rows)), ['p1', 'p3']);
  const stripNote = (s) => String(s || '').replace(/\s*\(.*\)\s*$/, '').trim();
  check('with the caller\'s normalizer', uids(lackingDef2Rows(rows, stripNote)), ['p1']);
  const noLemma = [{ uid: 'x1', input: '달리', def2: '' }, { uid: 'x2', input: '달리', def2: '' }, { uid: 'x3', def2: '' }, { uid: 'x4', def2: '' }];
  check('no lemma: the typed form stands in; rows with neither are each their own', uids(lackingDef2Rows(noLemma)), ['x1', 'x3', 'x4']);
}

// ── Oldest first ──────────────────────────────────────────────
{
  const rows = [
    row('new', '셋', { ts: '2026-11-10T09:00:00.000Z' }),
    row('undated', '넷', { ts: undefined }),
    row('old', '하나', { ts: '2026-10-01T09:00:00.000Z' }),
    row('badDate', '다섯', { ts: 'not a date' }),
    row('mid', '둘', { ts: '2026-10-20T09:00:00.000Z' }),
  ];
  check('oldest first; rows with no usable time come last, in list order', uids(lackingDef2Rows(rows)), ['old', 'mid', 'new', 'undated', 'badDate']);
  const before = JSON.stringify(rows);
  lackingDef2Rows(rows);
  check('the list passed in is not reordered or changed', JSON.stringify(rows), before);
}

// ── Empty and missing input ───────────────────────────────────
check('no rows', [lackingDef2Count([]), lackingDef2Count(null), lackingDef2Count(undefined)], [0, 0, 0]);

// ── The queue keeps the rows it opened with ───────────────────
{
  const opened = [row('q1', '하나'), row('q2', '둘'), row('q3', '셋')];
  const order = uids(lackingDef2Rows(opened));
  // q1 gets its Def2, q2 is deleted on another device, a new row arrives.
  const later = [row('q9', '새말'), { ...opened[0], def2: 'one' }, opened[2]];
  const now = queueRows(later, order);
  check('a filled row stays in place so the modal can page on; a deleted row drops out; a new row does not join mid-session',
    now.map(r => [r.uid, r.def2]), [['q1', 'one'], ['q3', '']]);
  check('the count itself has moved on', lackingDef2Count(later), 2);
  check('nothing open', [queueRows(later, []), queueRows(later, null), queueRows(null, ['q1'])], [[], [], []]);
}

console.log(`lacking-def2-golden: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
