// Per-chore warning marks for the digest and the widget.
//
// Two signals, both derived rather than stored on the issue:
//
//   slipped     — how many consecutive PRIOR occurrences of this chore went
//                 unfinished. Deliberately independent of the on-miss policy:
//                 a `replace` chore's missed copy was archived and a `skip`
//                 chore's is still sitting open, but either way the point is
//                 the same — this keeps getting put off. The number is what
//                 matters; one slip is normal, two in a row is the problem.
//
//   needsDetail — someone noticed the last pass left something out. Aimed at
//                 the PERSON who did it: the flag is keyed by (chore, person)
//                 and only shows when that person is the one assigned next. If
//                 the chore rotates away they see nothing, because they didn't
//                 miss it. Spent once that person completes the chore again,
//                 so it never needs clearing by hand.
//
// Derivation beats a label on the issue: nothing to add at generation time,
// nothing to clean up, and completing something late silently fixes itself.

import { fetchChoreHistory } from "./linear.js";
import { activeDetailFlags } from "./db.js";

// An occurrence counts as slipped if its due date has passed and it was never
// completed. Canceled is excluded on purpose — deciding not to do something is
// a choice, not a slip, and treating it as one would punish using ✖ honestly.
const slippedOccurrence = (i, today) =>
  !!i.dueDate && i.dueDate < today && !i.completedAt && i.state?.type !== "canceled";

// Marks keyed by issue id for everything in `issues`, plus a title-keyed map so
// callers can mark occurrences that aren't in the history window yet.
export async function choreMarks(env, teamId, issues, today) {
  const empty = { byId: new Map(), byTitle: new Map() };
  if (!teamId || !issues?.length) return empty;

  const since = (() => {
    const [y, m, d] = today.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d - 120)).toISOString().slice(0, 10);
  })();

  let history = [];
  try {
    history = await fetchChoreHistory(env, teamId, since);
  } catch (e) {
    console.error("chore marks: history lookup failed:", e.message);
    return empty;
  }

  // Group every occurrence by title, oldest first.
  const byTitle = new Map();
  for (const h of history) {
    if (!h.title || !h.dueDate) continue;
    const k = h.title.toLowerCase();
    if (!byTitle.has(k)) byTitle.set(k, []);
    byTitle.get(k).push(h);
  }
  for (const list of byTitle.values()) list.sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  // Most recent completion per (title, person) — a detail flag is answered only
  // when THAT person does the chore again, not when their partner does.
  const lastDoneBy = new Map();
  for (const [k, list] of byTitle) {
    for (const i of list) {
      if (!i.completedAt || !i.assignee?.name) continue;
      const key = `${k}::${i.assignee.name.toLowerCase()}`;
      const prev = lastDoneBy.get(key);
      if (!prev || i.completedAt > prev) lastDoneBy.set(key, i.completedAt);
    }
  }

  const flags = await activeDetailFlags(env).catch((e) => {
    console.error("chore marks: detail flags lookup failed:", e.message);
    return new Map();
  });

  // How many consecutive occurrences before `dueDate` went unfinished.
  const slipStreak = (titleKey, dueDate) => {
    const prior = (byTitle.get(titleKey) || []).filter((i) => i.dueDate < dueDate);
    let n = 0;
    for (let k = prior.length - 1; k >= 0; k--) {
      if (!slippedOccurrence(prior[k], today)) break;
      n++;
    }
    return n;
  };

  // The note is aimed at the person who overlooked something, and it clears
  // when they next COMPLETE that chore — doing it properly is what answers it,
  // so missing the next occurrence doesn't quietly discharge the reminder. It
  // only ever shows on their own occurrences; if the chore rotates away, the
  // other person sees nothing, because they didn't miss it.
  const detailFor = (titleKey, assigneeName) => {
    if (!assigneeName) return false;
    const key = `${titleKey}::${assigneeName.toLowerCase()}`;
    const flag = flags.get(key);
    if (!flag) return false;
    const done = lastDoneBy.get(key);
    return !(done && done > flag.flaggedAt);
  };

  // If several future copies are on screen, only the soonest one for that
  // person carries the note — it's a reminder for the next go, not a banner.
  const claimed = new Set();
  const ordered = [...issues].sort((a, b) =>
    (a.dueDate || "9999-99-99").localeCompare(b.dueDate || "9999-99-99"),
  );
  const byId = new Map();
  const titleMarks = new Map();
  for (const i of ordered) {
    const k = (i.title || "").toLowerCase();
    const personKey = (i.assignee?.name || "").toLowerCase();
    const slot = `${k}::${personKey}`;
    let needsDetail = false;
    if (!claimed.has(slot) && detailFor(k, i.assignee?.name)) {
      needsDetail = true;
      claimed.add(slot);
    }
    const mark = { slipped: i.dueDate ? slipStreak(k, i.dueDate) : 0, needsDetail };
    if (mark.slipped || mark.needsDetail) {
      byId.set(i.id, mark);
      titleMarks.set(k, mark);
    }
  }
  return { byId, byTitle: titleMarks };
}

// Short prefix for a chore line. Escalates on repeats, because a mark that
// looks the same on the first and third miss stops being read.
export function markPrefix(mark) {
  if (!mark) return "";
  const bits = [];
  if (mark.slipped >= 2) bits.push(`🔴 **slipped ${mark.slipped}×**`);
  else if (mark.slipped === 1) bits.push("⚠️ slipped last time");
  if (mark.needsDetail) bits.push("🔍 check the checklist");
  return bits.length ? ` — ${bits.join(" · ")}` : "";
}
