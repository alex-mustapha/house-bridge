// Computes the weekly recap, broken down per assignee, from chore history
// (issues with due dates, completion timestamps, state and assignees). Pure
// logic. All dates are Eastern (via localDate) so an evening-of-the-due-day
// completion counts as on time, not late.
//
// Rebuilt 2026-10-13. What changed and why:
//   * **On-time % is the headline, not completion %.** Completion sat ~93% every
//     week because missed weekly chores get swept and rarer ones just stay open
//     — so the number that led the recap was the one that never moved. On-time %
//     responds to how the week actually went.
//   * **Cancelled is its own outcome.** It used to fall through the
//     `!completedAt` branch and be tallied as *missed*, which both deflated the
//     score and listed deliberately-cancelled chores under "what slipped".
//     CLAUDE.md already required it be excluded from the ratio; the dashboard
//     honored that and the recap didn't.
//   * **Lateness has magnitude.** "5 late" hid the difference between a day
//     late and eighteen days late.
//   * **The streak comes from ./streak.js**, shared with the widget and the
//     dashboard, which previously disagreed with this file by design.

import { localDate } from "./recurring.js";
import { byDayFromIssues, choreStreak } from "./streak.js";

function shiftDays(now, n) {
  return new Date(now.getTime() - n * 86_400_000);
}
const eastern = (d) => localDate(d).ymd;
const daysBetween = (a, b) => {
  const p = (s) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((p(a) - p(b)) / 86_400_000);
};

// An outcome per issue, so every consumer below branches the same way.
function outcomeOf(i) {
  if (i.state?.type === "canceled") return { kind: "canceled" };
  const completed = i.completedAt ? eastern(new Date(i.completedAt)) : null;
  if (!completed) return { kind: "missed" };
  if (completed <= i.dueDate) return { kind: "onTime" };
  return { kind: "late", daysLate: Math.max(1, daysBetween(completed, i.dueDate)) };
}

const blank = () => ({
  onTime: 0, late: 0, missed: 0, canceled: 0,
  done: 0, total: 0, counted: 0, lateDays: [], worst: null,
});

// `counted` is the denominator for on-time %: everything you were responsible
// for minus cancellations. `total` still includes them so the week's volume is
// honest.
function add(a, i, o) {
  a.total++;
  if (o.kind === "canceled") { a.canceled++; return; }
  a.counted++;
  if (o.kind === "missed") { a.missed++; return; }
  a.done++;
  if (o.kind === "onTime") { a.onTime++; return; }
  a.late++;
  a.lateDays.push(o.daysLate);
  if (!a.worst || o.daysLate > a.worst.daysLate) a.worst = { title: i.title, daysLate: o.daysLate };
}

function finish(a) {
  const onTimePct = a.counted ? Math.round((a.onTime / a.counted) * 100) : null;
  const resolved = a.done + a.missed;
  const completionPct = resolved ? Math.round((a.done / resolved) * 100) : null;
  const avgLate = a.lateDays.length
    ? Math.round((a.lateDays.reduce((t, n) => t + n, 0) / a.lateDays.length) * 10) / 10
    : null;
  return { ...a, onTimePct, completionPct, avgLate };
}

export function computeStats(issues, now) {
  const day = (n) => eastern(shiftDays(now, n));
  // The recap covers a *finished* week ending yesterday, so every day in it is
  // final — anything unresolved is a miss, with no "but today isn't over"
  // ambiguity. The prior week is tallied the same way to show the trend.
  const cur = { from: day(7), to: day(1) };
  const prev = { from: day(14), to: day(8) };
  const inWindow = (i, w) => i.dueDate && i.dueDate >= w.from && i.dueDate <= w.to;

  const tally = (w) => {
    const acc = {};
    const house = blank();
    for (const i of issues) {
      if (!inWindow(i, w)) continue;
      const o = outcomeOf(i);
      add(house, i, o);
      const who = i.assignee?.name;
      if (!who) continue; // unassigned chores count for the household, not a person
      add((acc[who] ||= blank()), i, o);
    }
    return { acc, house };
  };
  const c = tally(cur);
  const p = tally(prev);
  const dOf = (a, b) => (a !== null && b !== null ? a - b : null);

  // One streak definition for all three surfaces — see ./streak.js.
  const byPerson = byDayFromIssues(issues, (i) => i.assignee?.name ?? null);
  const yesterday = day(1);

  const people = [...new Set([...Object.keys(c.acc), ...Object.keys(p.acc)])]
    .map((name) => {
      const a = finish(c.acc[name] || blank());
      const b = finish(p.acc[name] || blank());
      return {
        name, ...a,
        prevOnTimePct: b.onTimePct,
        delta: dOf(a.onTimePct, b.onTimePct),
        // Walk from today so "clear days" means the same thing here as on the
        // widget; the helper excludes today itself.
        streak: choreStreak(byPerson[name] || {}, day(0)),
        _yesterday: yesterday,
      };
    })
    .sort((a, b) => b.counted - a.counted || b.onTime - a.onTime);

  const hc = finish(c.house);
  const hp = finish(p.house);

  // What actually slipped, named — cancellations excluded, since choosing not
  // to do something isn't the same as letting it rot.
  const missed = issues
    .filter((i) => inWindow(i, cur) && outcomeOf(i).kind === "missed")
    .map((i) => ({ title: i.title, who: i.assignee?.name || "Unassigned", dueDate: i.dueDate }))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  // The one actionable line. Over the whole history we're already holding (30
  // days), which chore keeps failing? A thing missed three times isn't a
  // nagging problem, it's a badly-scheduled chore.
  const repeats = {};
  for (const i of issues) {
    if (!i.dueDate || i.dueDate > cur.to) continue;
    if (outcomeOf(i).kind !== "missed") continue;
    (repeats[i.title] ||= { title: i.title, n: 0, lastDue: "" });
    repeats[i.title].n++;
    if (i.dueDate > repeats[i.title].lastDue) repeats[i.title].lastDue = i.dueDate;
  }
  const chronic = Object.values(repeats)
    .filter((r) => r.n >= 2)
    .sort((a, b) => b.n - a.n || b.lastDue.localeCompare(a.lastDue));

  return {
    people,
    window: cur,
    household: { ...hc, prevOnTimePct: hp.onTimePct, delta: dOf(hc.onTimePct, hp.onTimePct) },
    missed,
    chronic,
  };
}
