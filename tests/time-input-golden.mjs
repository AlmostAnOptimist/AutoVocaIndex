// tests/time-input-golden.mjs
// Golden test for the typed time field (src/utils/timeInput.js).
//
// Run from the repo root:   node tests/time-input-golden.mjs   (or: npm test)
// Plain Node. Exits 1 on any failure.

const { splitTime, joinTime, parseTypedTime } = await import('../src/utils/timeInput.js');

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`);
}
const v = (raw, side) => { const r = parseTypedTime(raw, side); return r && (r.empty ? 'empty' : [r.value, r.text, r.ampm]); };

// ── Stored value -> field ─────────────────────────────────────
check('split: morning', splitTime('09:05'), { text: '9:05', ampm: 'AM' });
check('split: afternoon', splitTime('14:30'), { text: '2:30', ampm: 'PM' });
check('split: noon', splitTime('12:00'), { text: '12:00', ampm: 'PM' });
check('split: midnight', splitTime('00:15'), { text: '12:15', ampm: 'AM' });
check('split: none', splitTime(''), { text: '', ampm: 'AM' });
check('split: null', splitTime(null), { text: '', ampm: 'AM' });
check('split: junk', splitTime('25:00'), { text: '', ampm: 'AM' });

// ── Field -> stored value ─────────────────────────────────────
check('join: 10:30 AM', joinTime(10, 30, 'AM'), '10:30');
check('join: 10:30 PM', joinTime(10, 30, 'PM'), '22:30');
check('join: 12 AM is 00', joinTime(12, 0, 'AM'), '00:00');
check('join: 12 PM is 12', joinTime(12, 45, 'PM'), '12:45');

// ── Typing (the side defaults to AM) ──────────────────────────
check('type: 10:30 reads as AM', v('10:30'), ['10:30', '10:30', 'AM']);
check('type: 10:30 with the toggle on PM', v('10:30', 'PM'), ['22:30', '10:30', 'PM']);
check('type: no colon (1030)', v('1030'), ['10:30', '10:30', 'AM']);
check('type: three digits (930)', v('930'), ['09:30', '9:30', 'AM']);
check('type: a dot (9.30)', v('9.30'), ['09:30', '9:30', 'AM']);
check('type: a space (9 30)', v('9 30'), ['09:30', '9:30', 'AM']);
check('type: hour only', v('9'), ['09:00', '9:00', 'AM']);
check('type: trailing pm sets PM', v('2:30pm'), ['14:30', '2:30', 'PM']);
check('type: trailing "p" sets PM', v('2:30 p'), ['14:30', '2:30', 'PM']);
check('type: trailing am overrides the toggle', v('2:30 am', 'PM'), ['02:30', '2:30', 'AM']);
check('type: 24-hour hour reads as PM', v('14:30'), ['14:30', '2:30', 'PM']);
check('type: 24-hour wins over an AM toggle', v('18:00', 'AM'), ['18:00', '6:00', 'PM']);
check('type: hour 0 is 12 AM', v('0:15', 'PM'), ['00:15', '12:15', 'AM']);
check('type: 12 on AM is just past midnight', v('12:30'), ['00:30', '12:30', 'AM']);
check('type: 12 on PM is just past noon', v('12:30', 'PM'), ['12:30', '12:30', 'PM']);
check('type: empty', v(''), 'empty');
check('type: spaces only', v('   '), 'empty');
check('type: hour 24 is not a time', v('24:00'), null);
check('type: minute 60 is not a time', v('10:60'), null);
check('type: one minute digit is not a time yet', v('10:3'), null);
check('type: letters are not a time', v('soon'), null);

console.log(`time-input-golden: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
