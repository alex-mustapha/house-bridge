// Builds Discord messages/embeds (issue events, daily digest, cap warning,
// "all done" celebration, weekly scoreboard) and posts them to webhooks.

import { markPrefix } from "./marks.js";
import { STREAK_FOOTNOTE } from "./streak.js";

const COLORS = {
  created: 0x2ecc71, // green
  done: 0x2ecc71, // green
  updated: 0x3498db, // blue
  removed: 0x95a5a6, // grey
  comment: 0x9b59b6, // purple
  overdue: 0xe74c3c, // red
  dueToday: 0xf39c12, // orange
  dueSoon: 0x3498db, // blue
};

// Linear priority is 0..4.
const PRIORITY_LABELS = ["No priority", "Urgent", "High", "Medium", "Low"];

export function formatIssueEmbed(payload) {
  const { action, data } = payload;
  const url = payload.url || data.url || "https://linear.app";
  const id = data.identifier || "Issue";
  const title = data.title || "(untitled)";
  const stateName = data.state?.name;
  const stateType = data.state?.type;
  const assignee = data.assignee?.name;

  let verb, color, emoji;
  if (action === "create") {
    verb = "created";
    color = COLORS.created;
    emoji = "🆕";
  } else if (action === "remove") {
    verb = "removed";
    color = COLORS.removed;
    emoji = "🗑️";
  } else if (action === "update") {
    if (stateType === "completed") {
      verb = "completed";
      color = COLORS.done;
      emoji = "✅";
    } else if (stateType === "canceled") {
      verb = "canceled";
      color = COLORS.removed;
      emoji = "🚫";
    } else {
      verb = "updated";
      color = COLORS.updated;
      emoji = "✏️";
    }
  } else {
    return null;
  }

  const fields = [];
  if (stateName) fields.push({ name: "Status", value: stateName, inline: true });
  if (assignee) fields.push({ name: "Assignee", value: assignee, inline: true });
  if (typeof data.priority === "number" && data.priority > 0) {
    fields.push({
      name: "Priority",
      value: PRIORITY_LABELS[data.priority] ?? String(data.priority),
      inline: true,
    });
  }
  if (data.dueDate) fields.push({ name: "Due", value: data.dueDate, inline: true });

  return {
    title: `${emoji} ${id} ${verb}`,
    description: `**[${title}](${url})**`,
    color,
    fields,
    timestamp: new Date().toISOString(),
  };
}

function mentionFor(name, mentionMap) {
  if (!name || !mentionMap) return null;
  const n = name.toLowerCase();
  for (const [key, id] of Object.entries(mentionMap)) {
    if (n === key || n.includes(key) || key.includes(n)) return `<@${id}>`;
  }
  return null;
}

// Daily digest of today's + overdue chores, grouped by assignee — each person's
// past-due work listed above what's due today. Owners are @-pinged in `content`
// (mentions only notify from content, not the embed).
export function buildDigestMessage(issues, mentionMap, today, unassignedSoon = [], anytime = [], marks = null) {
  // Person-first: everything one person owns sits under their own heading, with
  // their past-due work called out above what's due today. A single flat
  // past-due list made it impossible to see your own share at a glance — you
  // had to read every line's owner suffix — and it grows unreadable as older
  // items accumulate, which they now do by design (rarer chores are no longer
  // swept). Grouping also drops the repeated "· Name" from every line.
  const groups = new Map(); // owner name | "Unassigned" -> { overdue[], todayish[], week[] }
  const bucket = (key) => {
    if (!groups.has(key)) groups.set(key, { overdue: [], todayish: [], week: [] });
    return groups.get(key);
  };
  for (const i of issues) {
    const b = bucket(i.assignee?.name || "Unassigned");
    if (i.dueDate && i.dueDate < today) b.overdue.push(i);
    else if (i.dueDate && i.dueDate > today) b.week.push(i); // later this week
    else b.todayish.push(i); // today, or undated
  }

  // Deterministic order, with Unassigned last so it reads as a footer rather
  // than a person.
  const names = [...groups.keys()].sort((a, b) =>
    a === "Unassigned" ? 1 : b === "Unassigned" ? -1 : a.localeCompare(b),
  );

  // One block per person: past due, today, then what's coming for them. Keeping
  // upcoming inside the person's own block means you read your whole picture in
  // one place instead of scrolling to a separate list and re-finding your name.
  // Warning marks (repeatedly put off, or a detail was missed last pass). Only
  // flagged chores carry anything, so an ordinary day reads exactly as before.
  const mk = (i) => markPrefix(marks?.byId?.get(i.id));

  const sections = [];
  for (const name of names) {
    const { overdue, todayish, week } = groups.get(name);
    if (!overdue.length && !todayish.length && !week.length) continue;
    const parts = [`**${name}**`];
    if (overdue.length) {
      const od = [...overdue]
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate)) // oldest first
        .map((i) => {
          const days = daysBetween(i.dueDate, today);
          return `• [${i.title}](${i.url}) — ${days} day${days === 1 ? "" : "s"} late${mk(i)}`;
        });
      parts.push(`⏰ *Past due (${overdue.length})*`, ...od);
    }
    if (todayish.length) {
      // Label "today" only when another group sits alongside it to separate from.
      if (overdue.length || week.length) parts.push("📅 *Today*");
      parts.push(...todayish.map((i) => `• [${i.title}](${i.url})${mk(i)}`));
    }
    if (week.length) {
      // Routine weekly chores are filtered out upstream, so what lands here is
      // the stuff worth a heads-up: ad-hoc, project work, and chores that come
      // round every few months.
      parts.push(
        name === "Unassigned" ? "🔜 *Upcoming — up for grabs*" : "🔜 *Upcoming*",
        ...[...week]
          .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
          .map((i) => `• ${fmtDue(i.dueDate)} — [${i.title}](${i.url})`),
      );
    }
    sections.push(parts.join("\n"));
  }

  // Undated work, oldest first. Nothing else in the digest can surface these —
  // every other list is keyed on a due date — so without this they're invisible
  // until someone goes looking in Linear.
  if (anytime.length) {
    const lines = anytime.map((i) => {
      const bits = [i.project, i.assignee, i.ageDays != null ? `${i.ageDays}d old` : null].filter(Boolean);
      return `• [${i.title}](${i.url})${bits.length ? ` — ${bits.join(" · ")}` : ""}`;
    });
    sections.push(`🧺 **Anytime** — no due date, grab one if you've got a gap\n${lines.join("\n")}`);
  }

  // Legacy arg: unclaimed work due soon. Now normally empty because the digest
  // pulls the full week above (unassigned included), but kept so an explicit
  // list still renders rather than being silently dropped.
  if (unassignedSoon.length) {
    const seen = new Set(issues.map((i) => i.id ?? i.url));
    const extra = unassignedSoon.filter((i) => !seen.has(i.id ?? i.url));
    if (extra.length) {
      const us = extra.map((i) => `• [${i.title}](${i.url}) — due ${fmtDue(i.dueDate)}`).join("\n");
      sections.push(`🙋 **Unassigned — due this week**\n${us}`);
    }
  }

  // Ping counts span overdue + today's, not just `groups` (which is today-only
  // now) — otherwise a day whose only work is past due would @-mention nobody.
  // Counts cover TODAY + past due only. The week section is context, not a
  // to-do list — folding it in would inflate the number people glance at.
  const perOwner = new Map();
  for (const i of issues) {
    const name = i.assignee?.name;
    if (!name) continue;
    if (i.dueDate && i.dueDate > today) continue; // later this week — not "on you now"
    perOwner.set(name, (perOwner.get(name) || 0) + 1);
  }
  const pings = [...perOwner.entries()].map(
    ([name, n]) => `${mentionFor(name, mentionMap) || name} — ${n}`,
  );

  // Bar color carries meaning: red if anything's overdue, green if nothing's
  // due, otherwise a calm blue.
  const hasOverdue = issues.some((i) => i.dueDate && i.dueDate < today);
  const color = !issues.length ? COLORS.done : hasOverdue ? COLORS.overdue : COLORS.dueSoon;

  // The date is stated outright. It used to be implied only by Discord's own
  // relative timestamp ("Yesterday at 8:00"), which is useless when scrolling
  // back. The count makes progress legible: the same message shrinking from
  // "4 left" to "1 left" is the point of editing it in place.
  const remaining = issues.filter((i) => !i.dueDate || i.dueDate <= today).length;
  return {
    content:
      `🔔 **Today's chores — ${fmtDue(today)}**` +
      (remaining ? ` · ${remaining} left` : "") +
      (pings.length ? `\n${pings.join(" · ")}` : ""),
    embeds: [
      {
        description: sections.join("\n\n").slice(0, 4000) || "Nothing due today.",
        color,
        timestamp: new Date().toISOString(),
      },
    ],
    allowed_mentions: { parse: ["users"] },
  };
}

// What the digest becomes once everything due is resolved. A distinct, dated
// ✅ line per day means scrolling the channel shows the run of cleared days
// directly — which is the whole reason the digest is edited rather than
// re-posted.
//
// No streak number here on purpose: `choreStreak` excludes today (a streak is a
// record of finished days), so printing it beside "all clear" would read one
// lower than the day you are looking at and disagree with the widget and the
// recap. The column of ✅ dates IS the streak.
export function buildAllClearMessage(today) {
  return {
    content: `✅ **All clear — ${fmtDue(today)}**`,
    embeds: [
      {
        description: "Everything due today is done.",
        color: COLORS.done,
        timestamp: new Date().toISOString(),
      },
    ],
    components: [], // drop the dropdowns; there is nothing left to act on
    allowed_mentions: { parse: [] },
  };
}

// Whole days between two YYYY-MM-DD dates (UTC midnights, so DST can't skew it).
function daysBetween(from, to) {
  const ms = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

// "2026-07-06" -> "Mon Jul 6"
function fmtDue(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${MO[m - 1]} ${d}`;
}

// A single "Actions" dropdown for the daily digest (multi-select, up to 25):
// "✓ <chore>" marks an assigned chore done; "🙋 <chore>" claims an unassigned
// one (assigns it to whoever picked it). Option values encode action:id:team.
// Requires the digest to be posted by the bot (not a webhook).
export function buildDigestMenu(issues, soon = []) {
  // Three rows, one job each. Claiming used to be split — unassigned work in
  // the "mark done" row, taking over someone else's in its own — which meant
  // picking something up lived in two different places depending on whether
  // anyone happened to own it. All claiming is now in one row.
  const dones = [];
  const takeovers = [];
  const cancels = [];
  // One-tap "push it a day". Only dated chores: snoozing something undated
  // would invent a due date rather than move one, which isn't what the button
  // means. Anything beyond a single day is a manual due-date edit on purpose.
  const snoozes = [];

  for (const i of issues) {
    const team = i.team?.id || "";
    if (i.assignee?.name) {
      dones.push({
        label: `✓ ${i.title}`.slice(0, 100),
        value: `done:${i.id}:${team}`,
        description: `${i.assignee.name}${i.dueDate ? ` · due ${i.dueDate}` : ""}`.slice(0, 100),
      });
      cancels.push({
        label: `✖ ${i.title}`.slice(0, 100),
        value: `cancel:${i.id}:${team}`,
        description: `won't count as done${i.dueDate ? ` · due ${i.dueDate}` : ""}`.slice(0, 100),
      });
      // Options are fixed when the message is posted, so one list serves both
      // people — the handler assigns to whoever actually clicked.
      takeovers.push({
        label: `🙋 ${i.title}`.slice(0, 100),
        value: `claim:${i.id}:${team}`,
        description: `currently ${i.assignee.name} — take it on`.slice(0, 100),
      });
    } else {
      takeovers.push({
        label: `🙋 ${i.title}`.slice(0, 100),
        value: `claim:${i.id}:${team}`,
        description: `unassigned${i.dueDate ? ` · due ${i.dueDate}` : ""}`.slice(0, 100),
      });
    }
  }
  for (const i of issues) {
    if (!i.dueDate) continue;
    snoozes.push({
      label: `😴 ${i.title}`.slice(0, 100),
      value: `snooze:${i.id}:${i.team?.id || ""}`,
      description: `due ${i.dueDate} → tomorrow`.slice(0, 100),
    });
  }

  // Unclaimed work due later in the week — grabbable ahead of time.
  for (const i of soon) {
    takeovers.push({
      label: `🙋 ${i.title}`.slice(0, 100),
      value: `claim:${i.id}:${i.teamId || ""}`,
      description: `unassigned${i.dueDate ? ` · due ${i.dueDate}` : ""}`.slice(0, 100),
    });
  }

  // Each row stands alone: a day with only unassigned work still gets a claim
  // row even though there's nothing to mark done.
  const row = (id, placeholder, opts) => {
    const o = opts.slice(0, 25);
    if (!o.length) return null;
    return {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: id,
          placeholder,
          min_values: 1,
          max_values: Math.min(o.length, 25),
          options: o,
        },
      ],
    };
  };

  return [
    row("actions-menu", "✅ Mark done…", dones),
    row("claim-menu", "🙋 Claim a chore…", takeovers),
    row("snooze-menu", "😴 Push to tomorrow…", snoozes),
    row("cancel-menu", "❌ Cancel a chore…", cancels),
  ].filter(Boolean);
}

// Returns the CREATED MESSAGE (or null on failure), not just a boolean. The
// digest needs its own message id so it can be re-rendered in place when a
// chore is resolved somewhere other than Discord — the widget, or Linear itself.
// The id used to be thrown away, which is the only reason widget completions
// couldn't update the digest the way the dropdown already did.
export async function postViaBot(env, channelId, payload) {
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error("Bot message post failed:", res.status, await res.text());
    return null;
  }
  return await res.json().catch(() => null);
}

// Edit a message the bot posted. `status` comes back so the caller can tell a
// deleted message (404) from a transient failure and forget the stale id.
export async function editViaBot(env, channelId, messageId, payload) {
  try {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok) {
      console.error("Bot message edit failed:", res.status, await res.text());
      return { ok: false, status: res.status };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    console.error("Bot message edit threw:", e.message);
    return { ok: false, status: 0 };
  }
}

// Weekly recap embed. Leads with **on-time %** because that's the number that
// actually moves week to week; completion % was structurally pinned near the
// same value and made every recap look identical. Cancellations get their own
// count so they can't quietly inflate anything, lateness carries magnitude, and
// there's exactly one actionable line at the bottom.
//
// Deliberately NOT in here: anything from the leisure log. That's one person's
// private tracker and the shared surfaces must contain no trace of it.
export function buildScoreboardMessage(stats) {
  const { people, household, missed, chronic, window } = stats;
  const stamp = new Date().toISOString();
  if (!people.length && !household.total) {
    return {
      embeds: [
        { title: "📊 Weekly recap", description: "No chores were due last week.", color: 0x9b59b6, timestamp: stamp },
      ],
    };
  }

  // "▲ 12 pts" / "▼ 5 pts" against the week before — a number on its own can't
  // tell you whether things are getting better or worse.
  const trend = (d, unit = " pts") =>
    d === null || d === 0 ? "" : d > 0 ? ` ▲ ${d}${unit}` : ` ▼ ${Math.abs(d)}${unit}`;
  const pctText = (p) => (p === null ? "—" : `${p}%`);

  const lines = [];

  // Headline. With nothing scoreable (e.g. every chore cancelled) there's no
  // percentage to lead with, and leading with "—%" in a red band read as a
  // disaster week when nothing had actually gone wrong.
  const scoreable = household.counted > 0;
  if (scoreable) {
    lines.push(`🎯 **${pctText(household.onTimePct)} on time**${trend(household.delta)}`);
  } else {
    lines.push("😌 **Quiet week** — nothing was left to score.");
  }
  const mix = scoreable ? [`${household.onTime} of ${household.counted} on time`] : [];
  if (household.late) mix.push(`⏰ ${household.late} late`);
  if (household.missed) mix.push(`❌ ${household.missed} missed`);
  if (household.canceled) mix.push(`🚫 ${household.canceled} cancelled`);
  if (mix.length) lines.push(mix.join(" · "));
  lines.push("");

  // How late is late? "5 late" treated one day and eighteen days the same.
  if (household.avgLate !== null) {
    const w = household.worst;
    const worst = w && w.daysLate > household.avgLate ? ` — worst: ${w.title}, ${w.daysLate}d late` : "";
    lines.push(`⏰ **Late by ${household.avgLate}d on average**${worst}`);
    lines.push("");
  }

  // Per person — collapsed to one line when the two are close, because three
  // lines implying a race nobody's winning is just noise.
  const scored = people.filter((p) => p.onTimePct !== null);
  const close =
    scored.length === 2 && Math.abs(scored[0].onTimePct - scored[1].onTimePct) <= 10;
  const streakBit = (p) => (p.streak ? ` · 🔥 ${p.streak} clear day${p.streak === 1 ? "" : "s"}` : "");
  if (close) {
    const runs = scored.filter((p) => p.streak);
    lines.push(
      `🤝 **Evenly matched** — ${scored
        .map((p) => `${p.name} ${pctText(p.onTimePct)}`)
        .join(", ")}` +
        (runs.length ? `
${runs.map((p) => `${p.name} 🔥 ${p.streak} clear`).join(" · ")}` : ""),
    );
    lines.push("");
  } else {
    for (const p of people) {
      const head =
        p.onTimePct === null
          ? "nothing to score"
          : `${pctText(p.onTimePct)} on time${trend(p.delta)}`;
      lines.push(`**${p.name}** — ${head}${streakBit(p)}`);
      const bits = [];
      if (p.late) bits.push(`⏰ ${p.late} late${p.avgLate !== null ? ` (avg ${p.avgLate}d)` : ""}`);
      if (p.missed) bits.push(`❌ ${p.missed} missed`);
      if (p.canceled) bits.push(`🚫 ${p.canceled} cancelled`);
      if (bits.length) lines.push(bits.join(" · "));
    }
    lines.push("");
  }

  if (missed.length) {
    const shown = missed.slice(0, 8).map((m) => `• ${m.title} — ${m.who}, due ${fmtDue(m.dueDate)}`);
    if (missed.length > 8) shown.push(`• …and ${missed.length - 8} more`);
    lines.push(`❌ **What slipped**\n${shown.join("\n")}`);
  } else {
    lines.push("🎉 **Nothing slipped** — everything due last week got resolved.");
  }

  // One callout, not a list. A chore missed repeatedly is a scheduling problem,
  // not a willpower problem, so the suggested action is to change the schedule.
  if (chronic.length) {
    const c = chronic[0];
    lines.push("");
    lines.push(
      `👉 **Worth a look:** “${c.title}” has been missed ${c.n}× in the last 30 days.` +
        ` Reschedule it, split it, or drop the cadence — \`/chores help\` has the options.`,
    );
  }

  // Band tracks the headline metric so the colour means something. Previously
  // it read completion %, which almost never left the green band.
  const ot = household.onTimePct ?? 0;
  const color = !scoreable
    ? 0x9b59b6
    : ot >= 85 ? 0x2ecc71 : ot >= 65 ? 0xf1c40f : ot >= 40 ? 0xe67e22 : 0xe74c3c;
  const anyStreak = people.some((p) => p.streak);
  return {
    embeds: [
      {
        title: `📊 Weekly recap · ${fmtDue(window.from)} – ${fmtDue(window.to)}`,
        description: lines.join("\n").slice(0, 4000),
        color,
        timestamp: stamp,
        ...(anyStreak ? { footer: { text: STREAK_FOOTNOTE } } : {}),
      },
    ],
  };
}


export function buildCapWarningEmbed(count, cap = 250) {
  const remaining = cap - count;
  return {
    title: "⚠️ Approaching Linear's free-plan limit",
    description:
      `You have **${count}** active issues. The free plan caps you at **${cap}**` +
      ` (only non-archived issues count).\n\n` +
      (remaining > 0
        ? `**${remaining}** slots left. Archive some completed issues to stay clear — ` +
          `archived issues don't count and you can keep an unlimited number.`
        : `You're at the limit — new issues are blocked until you archive some.`),
    color: 0xe67e22, // amber
    timestamp: new Date().toISOString(),
  };
}

// Long-term stats report from D1 aggregates (see db.queryStats).
export function buildStatsEmbed(stats) {
  const { days, byPerson, missed } = stats;
  const people = {};
  let done = 0;
  let onTime = 0;
  let missedTotal = 0;

  for (const r of byPerson) {
    const p = (people[r.person] ||= { done: 0, onTime: 0, missed: 0 });
    if (r.status === "on_time") {
      p.onTime += r.n;
      p.done += r.n;
      onTime += r.n;
      done += r.n;
    } else if (r.status === "late") {
      p.done += r.n;
      done += r.n;
    } else if (r.status === "missed") {
      p.missed += r.n;
      missedTotal += r.n;
    }
  }

  const total = done + missedTotal;
  const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
  const peopleLines =
    Object.entries(people)
      .map(([n, s]) => `**${n}** — ${s.done} done (${pct(s.onTime, s.done)}% on time) · ${s.missed} missed`)
      .join("\n") || "—";
  const missedLines = missed.length
    ? missed.map((m) => `• ${m.title} — ${m.n}`).join("\n")
    : "—";

  return {
    title: `📊 Chore stats — last ${days} days`,
    description:
      `✅ **${done}** done · ❌ **${missedTotal}** missed · ` +
      `${pct(done, total)}% completion · ${pct(onTime, done)}% on time\n\n` +
      `${peopleLines}\n\n**Most missed**\n${missedLines}`,
    color: 0x9b59b6, // purple
    timestamp: new Date().toISOString(),
  };
}

export async function postToDiscord(webhookUrl, body) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`Discord webhook failed: ${res.status} ${await res.text()}`);
  }
}
