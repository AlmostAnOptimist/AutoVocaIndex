// tests/pending-fields-golden.mjs
// Golden test for src/utils/pendingFields.js (audit CL1): fields from quick
// clicks on a Library status button are sent together, not just the last
// click's.
//
// Run from the repo root:   node tests/pending-fields-golden.mjs   (or: npm test)
// Plain Node; the module has no imports. Exits 1 on any failure.

const { createPendingFields } = await import('../src/utils/pendingFields.js');

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`);
}

{
  const p = createPendingFields();
  check('nothing waiting', [p.take('sec1'), p.size()], [null, 0]);
  p.add('sec1', { status: 'In Progress', lastActivityAt: 't1' });
  check('one click: its fields', p.take('sec1'), { status: 'In Progress', lastActivityAt: 't1' });
  check('taken once, then gone', [p.take('sec1'), p.size()], [null, 0]);
}
// The dead link: In Progress -> Skip releases the task (linkedTaskId: null),
// then a quick click back to Not started. Before, only the last click's
// fields were sent and the cleared link never reached Firestore.
{
  const p = createPendingFields();
  p.add('sec1', { status: 'Skip', linkedTaskId: null });
  p.add('sec1', { status: 'Not started' });
  check('two quick clicks: the cleared task link is still sent', p.take('sec1'), { status: 'Not started', linkedTaskId: null });
}
{
  const p = createPendingFields();
  p.add('sec1', { status: 'In Progress', lastActivityAt: 't1' });
  p.add('sec1', { status: 'Skip' });
  p.add('sec1', { status: 'Not started' });
  p.add('sec1', { status: 'In Progress', lastActivityAt: 't2' });
  check('later clicks win field by field', p.take('sec1'), { status: 'In Progress', lastActivityAt: 't2' });
}
{
  const p = createPendingFields();
  p.add('sec1', { status: 'Skip' });
  p.add('src_a', { sourceStatus: 'In Progress' });
  p.add('sec2', { status: 'In Progress' });
  check('each document keeps its own fields', [p.size(), p.take('src_a'), p.take('sec1'), p.take('sec2'), p.size()],
    [3, { sourceStatus: 'In Progress' }, { status: 'Skip' }, { status: 'In Progress' }, 0]);
  const given = { status: 'Skip' };
  p.add('sec1', given); p.add('sec1', { linkedTaskId: null });
  check('the object passed in is not changed', given, { status: 'Skip' });
}

console.log(`pending-fields-golden: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
