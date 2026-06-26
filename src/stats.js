// Computes the weekly scoreboard, broken down per assignee, from chore history
// (issues with due dates, completion timestamps, and assignees). Pure logic.

function ymd(d) {
  return d.toISOString().slice(0, 10);
}
function shiftDays(now, n) {
  return new Date(now.getTime() - n * 86_400_000);
}

export function computeStats(issues, now) {
  const today = ymd(now);
  const weekAgo = ymd(shiftDays(now, 7));

  // Per-person tallies over the last 7 days (by due date).
  const acc = {};
  const ensure = (name) =>
    (acc[name] ||= { done: 0, onTime: 0, late: 0, missed: 0 });

  for (const i of issues) {
    if (!i.dueDate || i.dueDate < weekAgo || i.dueDate > today) continue;
    const who = i.assignee?.name;
    if (!who) continue; // unassigned chores aren't relevant to per-person scores
    const a = ensure(who);
    const completed = i.completedAt ? i.completedAt.slice(0, 10) : null;
    if (completed) {
      a.done++;
      if (completed <= i.dueDate) a.onTime++;
      else a.late++;
    } else if (i.dueDate < today) {
      a.missed++; // past due, never completed
    }
  }

  // Per-person streak: consecutive prior days (ending yesterday) on which every
  // chore assigned to that person and due that day was completed.
  const byDayPerson = {};
  for (const i of issues) {
    if (!i.dueDate) continue;
    const who = i.assignee?.name;
    if (!who) continue;
    ((byDayPerson[who] ||= {})[i.dueDate] ||= []).push(i);
  }
  const streakFor = (name) => {
    const byDay = byDayPerson[name] || {};
    let s = 0;
    for (let n = 1; n <= 30; n++) {
      const items = byDay[ymd(shiftDays(now, n))];
      if (!items) continue;
      if (items.every((i) => i.completedAt)) s++;
      else break;
    }
    return s;
  };

  const people = Object.keys(acc)
    .map((name) => ({ name, ...acc[name], streak: streakFor(name) }))
    .sort((a, b) => b.done - a.done);

  return { people };
}
