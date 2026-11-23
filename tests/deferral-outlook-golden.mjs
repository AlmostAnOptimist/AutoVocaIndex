// tests/deferral-outlook-golden.mjs
// Golden test for the deferral notices, src/utils/deferralOutlook.js
// (DF-D1 to DF-D6): what the daily cap will defer on each of the next 7
// days, the "if today's aren't finished" line, the deferred backlog, and the
// wording. The forecast must agree with the real pipeline run on the day.
//
// Run from the repo root:   node tests/deferral-outlook-golden.mjs   (or: npm test)
//
// deferralOutlook.js imports only fsrs.js and dateUtils.js, so plain Node
// resolves it. The clock is pinned and the zone is Asia/Seoul.

process.env.TZ = 'Asia/Seoul';

const RealDate = Date;
let NOW = 0;
class PinnedDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
  static now() { return NOW; }
}
globalThis.Date = PinnedDate;
const at = (iso) => { NOW = new RealDate(iso).getTime(); };
at('2026-11-10T14:00:00+09:00'); // logical Nov 10 (Tuesday), day start 3 AM

const { deferralOutlook, buildDeferralForecast, deferralNoticeLines } = await import('../src/utils/deferralOutlook.js');
const { planTriage, buildDueLoad, isDueToday, getDueDateStr, logicalDueISO, logicalDayStr } = await import('../src/utils/fsrs.js');

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.error(`FAIL  ${name}\n  expected: ${e}\n  actual:   ${a}`);
}

const DSH = 3;
const ago = (days) => new RealDate(NOW - days * 86400000).toISOString();
// A card due `offset` days from today (negative = overdue).
let n = 0;
const card = (offset, extra = {}) => {
  const due = logicalDueISO(offset, DSH);
  return { id: `c${++n}`, type: 'vocab', state: 'review', stability: 60, difficulty: 5,
    lastReview: ago(30 + (n % 7)), due, dueDay: logicalDayStr(offset, DSH), dueDayFor: due, deckIds: ['d1'], ...extra };
};
const young = (offset) => card(offset, { stability: 8 });
const many = (k, make) => Array.from({ length: k }, make);
const pick = (o) => o.map(e => [e.offset, e.due, e.deferred, e.over]);

// 1. Nothing over the cap: nothing to say.
{
  const cards = [...many(5, () => card(1)), ...many(3, () => card(2)), ...many(2, () => card(-1))];
  const out = deferralOutlook(cards, { cap: 5, dsh: DSH });
  check('7 days are looked at, tomorrow first', [out.length, out[0].day, out[6].day], [7, '2026-11-11', '2026-11-17']);
  check('under or at the cap: no deferrals, nothing over', out.every(e => e.deferred === 0 && e.over === 0), true);
  check('no notice lines', deferralNoticeLines({ days: out, ifUnfinished: null }), { days: [], ifUnfinished: null });
}

// 2. One day over the cap: the excess, as the real rule picks it.
{
  const cards = many(7, () => card(1));
  const out = deferralOutlook(cards, { cap: 5, dsh: DSH });
  check('tomorrow over by 2: 2 to be deferred', pick(out.slice(0, 1)), [[1, 7, 2, 0]]);
  check('the deferred cards land later in the week', out.slice(1).reduce((t, e) => t + e.due, 0), 2);
}

// 3. Not enough cards that can wait: the rest stays over the cap (DF-D5).
{
  const some = [card(1), ...many(4, () => young(1))];
  const none = many(5, () => young(2));
  const out = deferralOutlook([...some, ...none], { cap: 2, dsh: DSH });
  check('1 can wait, 2 stay over', pick(out.slice(0, 2)), [[1, 5, 1, 2], [2, 5, 0, 3]]);
  check('wording for both kinds of day', deferralNoticeLines({ days: out }).days.map(d => [d.text, d.over]), [
    ['Tomorrow: 1 to be deferred, 2 still over the cap', true],
    ['Thursday: 3 over the cap (too new to defer)', true],
  ]);
}

// 4. A deferral that pushes a later day over the cap is counted there.
{
  // Stability 21: reach is 3 days. Days 2 to 4 are at the cap with cards
  // too young to move, so tomorrow's deferral lands on day 2 (the earliest
  // of equally loaded days), and day 2 has to defer it again, onto day 5
  // (the only empty day in its reach).
  const cards = [...many(4, () => card(1, { stability: 21 })), ...[2, 3, 4].flatMap(d => many(3, () => young(d)))];
  const out = deferralOutlook(cards, { cap: 3, dsh: DSH });
  check('knock-on: day 2 defers the card tomorrow pushed onto it', pick(out.slice(0, 5)), [[1, 4, 1, 0], [2, 4, 1, 0], [3, 3, 0, 0], [4, 3, 0, 0], [5, 1, 0, 0]]);
}

// 5. New, grammar and learning cards.
{
  const cards = [
    ...many(5, () => card(1)),
    ...many(4, () => card(1, { state: 'new' })),
    { id: 'g1', type: 'grammar', nextDueDate: '2026-11-11', state: 'review' },
    card(1, { state: 'learning', stability: 2 }),
  ];
  const out = deferralOutlook(cards, { cap: 5, dsh: DSH });
  check('new and grammar cards never count; a learning card counts but cannot be moved', pick(out.slice(0, 1)), [[1, 6, 1, 0]]);
}

// 6. "If today's aren't finished" (DF-D4).
{
  const cards = [...many(3, () => card(-1)), ...many(3, () => card(1))];
  const f = buildDeferralForecast(cards, { cap: 4, dsh: DSH });
  check('finished: nothing tomorrow; unfinished: 2 deferred', [f.days[0].deferred, f.ifUnfinished], [0, { left: 3, deferred: 2, over: 0 }]);
  check('the dashed line', deferralNoticeLines(f).ifUnfinished, "If today's 3 aren't finished: 2 deferred tomorrow");
  const one = buildDeferralForecast([card(0), ...many(4, () => card(1))], { cap: 4, dsh: DSH });
  check('one card left', deferralNoticeLines(one).ifUnfinished, "If today's last card isn't finished: 1 deferred tomorrow");
  const roomy = buildDeferralForecast([card(0), card(1)], { cap: 4, dsh: DSH });
  check('leaving them changes nothing: no line', roomy.ifUnfinished, null);
  const stuck = buildDeferralForecast([young(0), young(0), ...many(4, () => young(1))], { cap: 4, dsh: DSH });
  check('leaving them only adds cards that cannot move', deferralNoticeLines(stuck).ifUnfinished, "If today's 2 aren't finished: 2 over the cap tomorrow");
  const done = buildDeferralForecast(many(6, () => card(1)), { cap: 4, dsh: DSH });
  check('nothing left today: no line, even with deferrals ahead', [done.ifUnfinished, done.days[0].deferred], [null, 2]);
}

// 7. The backlog: cards deferred and not yet due again (DF-D9, DF-D12).
{
  const pile = many(5, () => card(0));
  const updates = planTriage(pile, { cap: 3, dsh: DSH, dueLoad: buildDueLoad(pile) });
  const after = pile.map(c => { const u = updates.find(x => x.id === c.id); if (!u) return c; const { id: _i, ...f } = u; return { ...c, ...f }; });
  check('backlog counts the cards deferred today', buildDeferralForecast(after, { cap: 3, dsh: DSH }).backlog, 2);
  const graded = after.map(c => c.deferredFor ? { ...c, due: logicalDueISO(9, DSH), lastReview: new RealDate(NOW).toISOString() } : c);
  check('a graded card leaves it', buildDeferralForecast(graded, { cap: 3, dsh: DSH }).backlog, 0);
}

// 8. Wording: at most 3 lines, nearest first; a week ahead says "Next".
{
  const days = [1, 2, 3, 4, 5, 6, 7].map(o => ({ offset: o, day: logicalDayStr(o, DSH), due: 9, deferred: o === 2 ? 0 : 1, over: 0 }));
  check('3 lines, nearest first, days with nothing skipped', deferralNoticeLines({ days }).days.map(d => d.text),
    ['Tomorrow: 1 card to be deferred', 'Friday: 1 card to be deferred', 'Saturday: 1 card to be deferred']);
  check('a week ahead', deferralNoticeLines({ days: [days[6]] }).days[0].text, 'Next Tuesday: 1 card to be deferred');
  check('no forecast yet: nothing', deferralNoticeLines(null), { days: [], ifUnfinished: null });
}

// 9. The forecast agrees with the real run (DF-D2). A mixed deck: tomorrow's
// pile with today's unfinished cards carried over must defer exactly as the
// pipeline does when the clock moves on a day with no reviews; and the day
// after, once tomorrow's remaining cards are reviewed, the same again.
{
  n = 0;
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const deck = [];
  for (let i = 0; i < 280; i++) {
    const off = Math.floor(rnd() * 9) - 2;             // due from 2 days ago to 6 ahead
    const st = rnd() < 0.3 ? 5 + rnd() * 15 : 21 + rnd() * 300;
    const c = card(off, { stability: +st.toFixed(2), lastReview: ago(1 + rnd() * st * 1.3) });
    if (rnd() < 0.08) c.state = 'relearning';
    deck.push(c);
  }
  const cap = 22;
  const carry = deck.filter(c => isDueToday(c, DSH));
  const out = deferralOutlook(deck, { cap, dsh: DSH, carry });

  // Real run tomorrow: no reviews today, so every due card is in the pile.
  at('2026-11-11T14:00:00+09:00');
  const pile1 = deck.filter(c => isDueToday(c, DSH));
  const real1 = planTriage(pile1, { cap, dsh: DSH, dueLoad: buildDueLoad(deck) });
  check('tomorrow: forecast = real run', [out[0].due, out[0].deferred, out[0].over],
    [pile1.length, real1.length, Math.max(0, pile1.length - real1.length - cap)]);

  // Tomorrow's remaining cards get reviewed (they move far out of the week),
  // the deferred ones go to their new days; then the day after.
  const moved = new Map(real1.map(({ id, ...f }) => [id, f]));
  const day2deck = deck.map(c => {
    if (moved.has(c.id)) return { ...c, ...moved.get(c.id) };
    if (isDueToday(c, DSH)) return { ...c, due: logicalDueISO(60, DSH), dueDay: logicalDayStr(60, DSH), dueDayFor: logicalDueISO(60, DSH), lastReview: new RealDate(NOW).toISOString() };
    return c;
  });
  at('2026-11-12T14:00:00+09:00');
  const pile2 = day2deck.filter(c => isDueToday(c, DSH));
  const real2 = planTriage(pile2, { cap, dsh: DSH, dueLoad: buildDueLoad(day2deck) });
  check('the day after: forecast = real run', [out[1].due, out[1].deferred, out[1].over],
    [pile2.length, real2.length, Math.max(0, pile2.length - real2.length - cap)]);
  check('the deck is busy enough to test it (both days defer, some cards stay over)', [real1.length > 0, real2.length > 0, out[0].over > 0], [true, true, true]);
  at('2026-11-10T14:00:00+09:00');
  void getDueDateStr;
}

console.log(`deferral-outlook-golden: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
