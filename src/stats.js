// Computes the weekly scoreboard from chore history (issues with due dates,
// completion timestamps, and assignees). Pure logic, no I/O.

function ymd(d) {
  return d.toISOString().slice(0, 10);
}
function shiftDays(now, n) {
  return new Date(now.getTime() - n * 86_400_000);
}

export function computeStats(issues, now) {
  const today = ymd(now);
  const weekAgo = ymd(shiftDays(now, 7));

  let done = 0;
  let onTime = 0;
  let late = 0;
  let missed = 0;
  const byPerson = {};

  // Tallies over the last 7 days (by due date).
  for (const i of issues) {
    if (!i.dueDate || i.dueDate < weekAgo || i.dueDate > today) continue;
    const completed = i.completedAt ? i.completedAt.slice(0, 10) : null;
    if (completed) {
      done++;
      if (completed <= i.dueDate) onTime++;
      else late++;
      const p = i.assignee?.name || "Unassigned";
      byPerson[p] = (byPerson[p] || 0) + 1;
    } else if (i.dueDate < today) {
      missed++; // past due and never completed
    }
  }

  // Streak: consecutive prior days (ending yesterday) on which every chore due
  // that day was completed. Days with no chores are skipped, not counted.
  const byDay = {};
  for (const i of issues) {
    if (!i.dueDate) continue;
    (byDay[i.dueDate] ||= []).push(i);
  }
  let streak = 0;
  for (let n = 1; n <= 30; n++) {
    const items = byDay[ymd(shiftDays(now, n))];
    if (!items) continue;
    if (items.every((i) => i.completedAt)) streak++;
    else break;
  }

  return { done, onTime, late, missed, byPerson, streak };
}
