// Builds Discord messages/embeds (issue events, daily digest, cap warning,
// "all done" celebration, weekly scoreboard) and posts them to webhooks.

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

export function formatCommentEmbed(payload) {
  const { data } = payload;
  const url = payload.url || data.url || "https://linear.app";
  const body = (data.body || "").slice(0, 300);
  const author = data.user?.name || "Someone";
  const issueId = data.issue?.identifier || "an issue";
  return {
    title: `💬 New comment on ${issueId}`,
    description: body ? `${body}\n\n[View](${url})` : `[View](${url})`,
    color: COLORS.comment,
    author: { name: author },
    timestamp: new Date().toISOString(),
  };
}

// Match a Linear assignee name to a Discord mention from the name->id map.
function mentionFor(name, mentionMap) {
  if (!name || !mentionMap) return null;
  const n = name.toLowerCase();
  for (const [key, id] of Object.entries(mentionMap)) {
    if (n === key || n.includes(key) || key.includes(n)) return `<@${id}>`;
  }
  return null;
}

// Daily digest of today's + overdue chores, grouped by assignee. Owners are
// @-pinged in `content` (mentions only notify from content, not the embed);
// overdue lines get a 🔴 marker.
export function buildDigestMessage(issues, mentionMap, today, unassignedSoon = []) {
  // Past-due work gets its own section ahead of today's, rather than sitting
  // inside each person's list behind a small 🔴. Chores are allowed to slip —
  // but slipping should stay visible day to day, not be noticed only when the
  // Monday sweep makes them disappear.
  const overdue = issues.filter((i) => i.dueDate && i.dueDate < today);
  const current = issues.filter((i) => !i.dueDate || i.dueDate >= today);

  const groups = new Map(); // owner name | "Unassigned" -> issues[]
  for (const i of current) {
    const key = i.assignee?.name || "Unassigned";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }

  const sections = [];
  if (overdue.length) {
    const od = [...overdue]
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate)) // oldest first
      .map((i) => {
        const days = daysBetween(i.dueDate, today);
        const who = i.assignee?.name || "unassigned";
        return `• [${i.title}](${i.url}) — ${days} day${days === 1 ? "" : "s"} late · ${who}`;
      })
      .join("\n");
    sections.push(`⏰ **Past due**\n${od}`);
  }
  const line = (i) => `• [${i.title}](${i.url})`;
  sections.push(
    ...[...groups.entries()].map(([name, items]) => `**${name}**\n${items.map(line).join("\n")}`),
  );

  // Unclaimed work due later this week, so someone can grab it ahead of time.
  if (unassignedSoon.length) {
    const us = unassignedSoon
      .map((i) => `• [${i.title}](${i.url}) — due ${fmtDue(i.dueDate)}`)
      .join("\n");
    sections.push(`🙋 **Unassigned — due this week**\n${us}`);
  }

  // Ping counts span overdue + today's, not just `groups` (which is today-only
  // now) — otherwise a day whose only work is past due would @-mention nobody.
  const perOwner = new Map();
  for (const i of issues) {
    const name = i.assignee?.name;
    if (!name) continue;
    perOwner.set(name, (perOwner.get(name) || 0) + 1);
  }
  const pings = [...perOwner.entries()].map(
    ([name, n]) => `${mentionFor(name, mentionMap) || name} — ${n}`,
  );

  // Bar color carries meaning: red if anything's overdue, green if nothing's
  // due, otherwise a calm blue.
  const hasOverdue = issues.some((i) => i.dueDate && i.dueDate < today);
  const color = !issues.length ? COLORS.done : hasOverdue ? COLORS.overdue : COLORS.dueSoon;

  return {
    content: `🔔 **Today's chores**${pings.length ? `\n${pings.join(" · ")}` : ""}`,
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
  const options = [];
  for (const i of issues) {
    if (i.assignee?.name) {
      options.push({
        label: `✓ ${i.title}`.slice(0, 100),
        value: `done:${i.id}:${i.team?.id || ""}`,
        description: `${i.assignee.name}${i.dueDate ? ` · due ${i.dueDate}` : ""}`.slice(0, 100),
      });
    } else {
      options.push({
        label: `🙋 ${i.title}`.slice(0, 100),
        value: `claim:${i.id}:${i.team?.id || ""}`,
        description: `unassigned${i.dueDate ? ` · due ${i.dueDate}` : ""}`.slice(0, 100),
      });
    }
  }
  for (const i of soon) {
    options.push({
      label: `🙋 ${i.title}`.slice(0, 100),
      value: `claim:${i.id}:${i.teamId || ""}`,
      description: `unassigned${i.dueDate ? ` · due ${i.dueDate}` : ""}`.slice(0, 100),
    });
  }
  const opts = options.slice(0, 25);
  if (!opts.length) return [];
  return [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: "actions-menu",
          placeholder: "Mark done · claim a chore…",
          min_values: 1,
          max_values: Math.min(opts.length, 25),
          options: opts,
        },
      ],
    },
  ];
}

// Post a message as the bot (Bot token) so it can carry interactive buttons.
export async function postViaBot(env, channelId, payload) {
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error("Bot message post failed:", res.status, await res.text());
  return res.ok;
}

// A single weekly-recap embed. One card rather than one per person, so the two
// are directly comparable; each line leads with how much of their own load they
// cleared (done / assigned), since a raw "done" count says nothing without the
// denominator — 2 of 2 and 2 of 12 are very different weeks.
export function buildScoreboardMessage(stats) {
  const { people, household, missed, window } = stats;
  const stamp = new Date().toISOString();
  if (!people.length) {
    return {
      embeds: [
        { title: "📊 Weekly recap", description: "No chores were due last week.", color: 0x9b59b6, timestamp: stamp },
      ],
    };
  }

  // "▲ 12 pts" / "▼ 5 pts" against the week before — a number on its own can't
  // tell you whether things are getting better or worse.
  const trend = (d) => (d === null ? "" : d > 0 ? ` ▲ ${d} pts` : d < 0 ? ` ▼ ${Math.abs(d)} pts` : " ·  no change");
  const pctText = (p) => (p === null ? "—" : `${p}%`);

  const lines = [`**Household** — ${household.done} of ${household.total} done · **${pctText(household.pct)}**${trend(household.delta)}`, ""];
  for (const p of people) {
    lines.push(`**${p.name}** — ${p.done} of ${p.total} · **${pctText(p.pct)}**${trend(p.delta)}`);
    const bits = [`✅ ${p.onTime} on time`];
    if (p.late) bits.push(`⏰ ${p.late} late`);
    if (p.missed) bits.push(`❌ ${p.missed} missed`);
    // Labelled "chore-days" on purpose: it counts days you actually had chores
    // and cleared them, so it can span more than a week and a chore-free week
    // never builds one. Calling it an N-day streak was misleading.
    if (p.streak) bits.push(`🔥 ${p.streak} chore-day${p.streak === 1 ? "" : "s"} clear`);
    lines.push(bits.join(" · "));
    lines.push("");
  }

  if (missed.length) {
    const shown = missed.slice(0, 10).map((m) => `• ${m.title} — ${m.who}`);
    if (missed.length > 10) shown.push(`• …and ${missed.length - 10} more`);
    lines.push(`❌ **What slipped**\n${shown.join("\n")}`);
  } else {
    lines.push("🎉 **Nothing slipped** — everything due last week got done.");
  }

  // Green when the household cleared most of its load, amber mid, red when
  // more was missed than done.
  const pct = household.pct ?? 0;
  const color = pct >= 80 ? 0x2ecc71 : pct >= 50 ? 0xf39c12 : 0xe74c3c;
  return {
    embeds: [
      {
        title: `📊 Weekly recap · ${fmtDue(window.from)} – ${fmtDue(window.to)}`,
        description: lines.join("\n").slice(0, 4000),
        color,
        timestamp: stamp,
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
