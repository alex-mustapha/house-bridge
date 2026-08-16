// Computes the weekly recap, broken down per assignee, from chore history
// (issues with due dates, completion timestamps, and assignees). Pure logic.
// All dates are Eastern (via localDate) so an evening-of-the-due-day completion
// counts as on time, not late.

import { localDate } from "./recurring.js";

function shiftDays(now, n) {
  return new Date(now.getTime() - n * 86_400_000);
}
const eastern = (d) => localDate(d).ymd;

export function computeStats(issues, now) {
  const day = (n) => eastern(shiftDays(now, n));
  // The recap covers a *finished* week ending yesterday, so every day in it is
  // final — anything not completed is a miss, with no "but today isn't over"
  // ambiguity. The prior week is tallied the same way to show the trend.
  const cur = { from: day(7), to: day(1) };
  const prev = { from: day(14), to: day(8) };

  const tally = ({ from, to }) => {
    const acc = {};
    for (const i of issues) {
      if (!i.dueDate || i.dueDate < from || i.dueDate > to) continue;
      const who = i.assignee?.name;
      if (!who) continue; // unassigned chores aren't part of a personal score
      const a = (acc[who] ||= { done: 0, onTime: 0, late: 0, missed: 0, total: 0 });
      a.total++;
      const completed = i.completedAt ? eastern(new Date(i.completedAt)) : null;
      if (!completed) {
        a.missed++;
      } else {
        a.done++;
        if (completed <= i.dueDate) a.onTime++;
        else a.late++;
      }
    }
    return acc;
  };
  const curAcc = tally(cur);
  const prevAcc = tally(prev);
  const pct = (a) => (a && a.total ? Math.round((a.done / a.total) * 100) : null);

  // Consecutive *chore-days* (days on which the person actually had something
  // due) ending yesterday with everything completed. Days with no chores are
  // skipped rather than counted, so this is deliberately NOT a calendar-day
  // streak — a week off doesn't build one, and it's labelled accordingly.
  const byDayPerson = {};
  for (const i of issues) {
    const who = i.assignee?.name;
    if (!i.dueDate || !who) continue;
    ((byDayPerson[who] ||= {})[i.dueDate] ||= []).push(i);
  }
  const streakFor = (name) => {
    const byDay = byDayPerson[name] || {};
    let s = 0;
    for (let n = 1; n <= 30; n++) {
      const items = byDay[eastern(shiftDays(now, n))];
      if (!items) continue;
      if (items.every((i) => i.completedAt)) s++;
      else break;
    }
    return s;
  };

  const people = [...new Set([...Object.keys(curAcc), ...Object.keys(prevAcc)])]
    .map((name) => {
      const a = curAcc[name] || { done: 0, onTime: 0, late: 0, missed: 0, total: 0 };
      const p = pct(a);
      const pp = pct(prevAcc[name]);
      return { name, ...a, pct: p, prevPct: pp, delta: p !== null && pp !== null ? p - pp : null, streak: streakFor(name) };
    })
    .sort((a, b) => b.total - a.total || b.done - a.done);

  const sum = (acc) =>
    Object.values(acc).reduce(
      (t, a) => ({ done: t.done + a.done, total: t.total + a.total }),
      { done: 0, total: 0 },
    );
  const h = sum(curAcc);
  const hp = sum(prevAcc);
  const hPct = pct(h);
  const hPrev = pct(hp);

  // What actually got missed, named — the part that makes the recap actionable.
  const missed = issues
    .filter((i) => i.dueDate >= cur.from && i.dueDate <= cur.to && !i.completedAt && i.assignee?.name)
    .map((i) => ({ title: i.title, who: i.assignee.name, dueDate: i.dueDate }))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  return {
    people,
    window: cur,
    household: { ...h, pct: hPct, prevPct: hPrev, delta: hPct !== null && hPrev !== null ? hPct - hPrev : null },
    missed,
  };
}
