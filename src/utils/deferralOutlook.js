// src/utils/deferralOutlook.js
// Deferral notices (DF-D1 to DF-D6). Pure; worked out live in App.jsx from
// the cards in memory and shown on Today and Flashcards.
//
// The daily cap ("Daily review cap", settings.srsSpikeCap) defers just enough
// cards on a day with more due than the cap (planTriage in fsrs.js). This
// looks ahead and says how many cards each of the next 7 days will defer, by
// running the real planTriage on each of those days (its `offset`) rather
// than a copy of its rule, so the forecast and the real run can't disagree.
//
// Assumes each day's reviews get finished: a day's pile is the cards due
// exactly on that day, plus the cards an earlier forecast day deferred onto
// it. `carry` adds cards to tomorrow's pile, for "if today's aren't finished".

import { isNewCard, isDueToday, getDueDateStr, buildDueLoad, planTriage, logicalDayStr, isDeferred } from './fsrs.js';

export const OUTLOOK_DAYS     = 7;
export const MAX_NOTICE_LINES = 3;

// One entry per day ahead (offset 1 = tomorrow):
//   { offset, day, due, deferred, over }
// `due` is the day's pile, `deferred` how many the cap will move, `over` how
// many stay above the cap because they can't be deferred (being learned or
// relearned, or under 21 days of stability).
// `cards` should already leave out paused decks.
export function deferralOutlook(cards, { cap, dsh = 3, days = OUTLOOK_DAYS, carry = [] } = {}) {
  const list = (cards || []).filter(c => c && c.type !== 'grammar' && !isNewCard(c));
  const byDay = new Map();
  const put = (day, c) => {
    const arr = byDay.get(day);
    if (arr) arr.push(c); else byDay.set(day, [c]);
  };
  for (const c of list) {
    const day = getDueDateStr(c);
    if (day) put(day, c);
  }
  const carryIds = new Set((carry || []).map(c => c && c.id));
  const carried  = carryIds.size ? list.filter(c => carryIds.has(c.id)) : [];
  const load = buildDueLoad(list);

  const out = [];
  for (let d = 1; d <= days; d++) {
    const day = logicalDayStr(d, dsh);
    let pile = byDay.get(day) || [];
    if (d === 1 && carried.length) pile = pile.concat(carried);

    const updates = pile.length > cap ? planTriage(pile, { cap, dsh, dueLoad: load, offset: d }) : [];
    if (updates.length) {
      // Put each deferred card on its landing day, so a deferral that pushes
      // a later day over the cap is counted there too.
      const byId = new Map(pile.map(c => [c.id, c]));
      for (const { id, ...fields } of updates) {
        put(fields.dueDay, { ...byId.get(id), ...fields });
        load.set(fields.dueDay, (load.get(fields.dueDay) || 0) + 1);
      }
    }
    out.push({
      offset: d, day,
      due: pile.length,
      deferred: updates.length,
      over: Math.max(0, pile.length - updates.length - cap),
    });
  }
  return out;
}

// Everything the notices and the Flashcards masthead need:
//   days         — deferralOutlook for the next 7 days
//   ifUnfinished — { left, deferred, over } when leaving today's remaining
//                  cards would raise tomorrow's deferrals (or its overflow);
//                  null otherwise
//   backlog      — cards deferred and not yet due again (DF-D9, DF-D12)
export function buildDeferralForecast(cards, { cap, dsh = 3 } = {}) {
  const active = (cards || []).filter(Boolean);
  const days = deferralOutlook(active, { cap, dsh });
  const left = active.filter(c => c.type !== 'grammar' && isDueToday(c, dsh));
  let ifUnfinished = null;
  if (left.length) {
    const [t] = deferralOutlook(active, { cap, dsh, days: 1, carry: left });
    const base = days[0] || { deferred: 0, over: 0 };
    if (t.deferred > base.deferred || t.over > base.over) {
      ifUnfinished = { left: left.length, deferred: t.deferred, over: t.over };
    }
  }
  const backlog = active.filter(c => isDeferred(c, dsh)).length;
  return { days, ifUnfinished, backlog };
}

// ── Wording ───────────────────────────────────────────────────

function dayLabel(offset, day) {
  if (offset === 1) return 'Tomorrow';
  const name = new Date(day + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' });
  // A week ahead falls on today's weekday name.
  return offset >= 7 ? `Next ${name}` : name;
}

// The notice lines, nearest day first, at most `max`:
//   { days: [{ key, text, over }], ifUnfinished: text | null }
// `over` marks a line about cards the cap can't move (shown with the alert icon).
export function deferralNoticeLines(forecast, { max = MAX_NOTICE_LINES } = {}) {
  if (!forecast) return { days: [], ifUnfinished: null };
  const days = (forecast.days || [])
    .filter(e => e.deferred > 0 || e.over > 0)
    .slice(0, max)
    .map(e => {
      const label = dayLabel(e.offset, e.day);
      let text;
      if (e.deferred > 0 && e.over > 0) text = `${label}: ${e.deferred} to be deferred, ${e.over} still over the cap`;
      else if (e.deferred > 0)          text = `${label}: ${e.deferred} ${e.deferred === 1 ? 'card' : 'cards'} to be deferred`;
      else                               text = `${label}: ${e.over} over the cap (too new to defer)`;
      return { key: e.day, text, over: e.over > 0 };
    });

  let ifUnfinished = null;
  const u = forecast.ifUnfinished;
  if (u) {
    const lead = u.left === 1 ? "If today's last card isn't finished" : `If today's ${u.left} aren't finished`;
    if (u.deferred > 0) ifUnfinished = `${lead}: ${u.deferred} deferred tomorrow${u.over > 0 ? `, ${u.over} over the cap` : ''}`;
    else                ifUnfinished = `${lead}: ${u.over} over the cap tomorrow`;
  }
  return { days, ifUnfinished };
}
