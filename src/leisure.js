// Recording the start of a leisure session — "were my chores done before I
// took my own time?"
//
// Shared by the `/chores leisure` slash command and the keyed `/leisure`
// endpoint behind the widget button, so both write identical rows. Lives in its
// own module because interactions.js cannot import index.js (circular) and this
// needs Linear queries, which don't belong in the D1 layer.

import { fetchAssignedActiveIssues, fetchRecentCompletedAssigned, getUsers } from "./linear.js";
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

export async function recordLeisure(env, { userId, person, note, source = "self" } = {}) {
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

  // What clock time to stamp on the row. A manual press is a real moment, so
  // use now. An automatic end-of-day row isn't: stamping 10pm on it would fill
  // the wind-down chart with a fake hour nobody chose. Instead, a day that
  // ended clear is timed by its LAST completion — the point the list actually
  // emptied, which is the closest honest answer to "when did the evening start".
  // A day that ended with work outstanding gets no time at all, and the chart
  // skips rows without one.
  let stamp = easternTime(now);
  if (source !== "self") {
    const last = doneToday
      .map((i) => i.completedAt)
      .filter(Boolean)
      .sort()
      .pop();
    stamp = clear && last ? easternTime(new Date(last)) : null;
  }

  const logged = await logLeisure(env, {
    person,
    startedAt: now.toISOString(),
    localDate: today,
    localTime: stamp,
    choresTotal: dueToday.length + doneToday.length,
    choresDone: doneToday.length,
    overdue: overdue.length,
    clear,
    source,
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

// End-of-day backstop: give EVERY day a verdict, not only the ones someone
// remembered to log. The rules are the household's own —
//   • chores all done, nothing logged  -> a win (doing them came before leisure)
//   • chores outstanding               -> a miss
// Without this, an unlogged day vanished entirely: not a win, not a miss, just
// absent, and the misses were the ones most likely to go unlogged. A manual
// press always takes precedence, since logLeisure never overwrites an existing
// row for the day.
export async function autoLogLeisure(env) {
  // Opt-in per person via LEISURE_PEOPLE. This is a personal habit tracker, not
  // a household metric — auto-logging everyone in the rotation would file
  // "missed" days against someone who never asked to be measured. Unset means
  // nobody is tracked automatically; the slash command and widget button still
  // work for anyone who deliberately uses them.
  const members = (env.LEISURE_PEOPLE || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (!members.length) return { logged: 0, skipped: 0, detail: ["LEISURE_PEOPLE not set"] };
  const users = await getUsers(env);
  let logged = 0;
  let skipped = 0;
  const detail = [];
  for (const raw of members) {
    const u = users.find((x) =>
      [x.displayName, x.name].some((n) => (n || "").toLowerCase().includes(raw.toLowerCase())),
    );
    if (!u) continue;
    const person = u.name || u.displayName;
    const r = await recordLeisure(env, { userId: u.id, person, source: "auto" }).catch((e) => {
      console.error(`auto leisure failed for ${person}:`, e.message);
      return null;
    });
    if (!r || r.error) continue;
    if (r.created) {
      logged++;
      detail.push(`${person}: ${r.clear ? "clear" : "missed"}`);
    } else {
      skipped++;
      detail.push(`${person}: already logged`);
    }
  }
  if (detail.length) console.log("Auto leisure:", detail.join(" | "));
  return { logged, skipped, detail };
}
