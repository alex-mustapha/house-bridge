// Recording the start of a leisure session — "were my chores done before I
// took my own time?"
//
// Shared by the `/chores leisure` slash command and the keyed `/leisure`
// endpoint behind the widget button, so both write identical rows. Lives in its
// own module because interactions.js cannot import index.js (circular) and this
// needs Linear queries, which don't belong in the D1 layer.

import { fetchAssignedActiveIssues, fetchRecentCompletedAssigned } from "./linear.js";
import { localDate } from "./recurring.js";
import { logLeisure, queryLeisure } from "./db.js";

// Eastern wall-clock HH:MM — localDate() carries the date but no time, and the
// start time is the point of the record.
const easternTime = (d) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);

export async function recordLeisure(env, { userId, person, note } = {}) {
  if (!userId || !person) return { error: "Couldn't match you to a Linear user." };
  const now = new Date();
  const today = localDate(now).ymd;
  const recurring = env.RECURRING_PROJECT || "Recurring";

  // Everything of theirs still open and due today or earlier. Overdue is
  // counted separately: a months-old one-off shouldn't make a clear slate
  // permanently unreachable, so "clear" means *today's* work is done, with the
  // overdue count reported alongside.
  const open = (await fetchAssignedActiveIssues(env, userId)).filter(
    (i) => i.project?.name !== recurring && i.dueDate && i.dueDate <= today,
  );
  const dueToday = open.filter((i) => i.dueDate === today);
  const overdue = open.filter((i) => i.dueDate < today);
  const doneToday = (await fetchRecentCompletedAssigned(env, userId)).filter(
    (i) =>
      i.project?.name !== recurring &&
      i.completedAt &&
      localDate(new Date(i.completedAt)).ymd === today,
  );
  const clear = dueToday.length === 0;

  const logged = await logLeisure(env, {
    person,
    startedAt: now.toISOString(),
    localDate: today,
    localTime: easternTime(now),
    choresTotal: dueToday.length + doneToday.length,
    choresDone: doneToday.length,
    overdue: overdue.length,
    clear,
    source: "self",
    note: note || null,
  });

  return {
    person,
    today,
    time: easternTime(now),
    clear,
    created: !!logged?.created,
    existing: logged && !logged.created ? logged.row : null,
    dueToday: dueToday.map((i) => i.title),
    doneToday: doneToday.length,
    overdue: overdue.length,
    history: await queryLeisure(env, person, 30),
  };
}
