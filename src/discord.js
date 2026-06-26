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
export function buildDigestMessage(issues, mentionMap, today) {
  const groups = new Map(); // owner name | "Unassigned" -> issues[]
  for (const i of issues) {
    const key = i.assignee?.name || "Unassigned";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }

  const line = (i) =>
    `• ${i.dueDate && i.dueDate < today ? "🔴 " : ""}[${i.title}](${i.url})`;
  const sections = [...groups.entries()].map(
    ([name, items]) => `**${name}**\n${items.map(line).join("\n")}`,
  );

  const pings = [...groups.entries()]
    .filter(([name]) => name !== "Unassigned")
    .map(([name, items]) => `${mentionFor(name, mentionMap) || name} — ${items.length}`);

  return {
    content: `🔔 **Today's chores**${pings.length ? `\n${pings.join(" · ")}` : ""}`,
    embeds: [
      {
        title: "Today's chores",
        description: sections.join("\n\n").slice(0, 4000),
        color: COLORS.dueToday,
        timestamp: new Date().toISOString(),
      },
    ],
    allowed_mentions: { parse: ["users"] },
  };
}

// One embed per person, so each gets their own weekly scoreboard.
export function buildScoreboardMessage(stats) {
  const embeds = stats.people.map((p) => ({
    title: `📊 ${p.name} — last week`,
    description:
      `✅ **${p.done}** done (${p.onTime} on time, ${p.late} late)\n` +
      `❌ **${p.missed}** missed\n` +
      `🔥 ${p.streak}-day streak`,
    color: 0x9b59b6, // purple
    timestamp: new Date().toISOString(),
  }));

  if (!embeds.length) {
    embeds.push({
      title: "📊 Last week",
      description: "No chores in the last 7 days.",
      color: 0x9b59b6,
      timestamp: new Date().toISOString(),
    });
  }
  return { embeds };
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

export function buildAllDoneEmbed(teamName) {
  return {
    title: "🎉 All done for today!",
    description: `Every chore due today${teamName ? ` in ${teamName}` : ""} is complete. Nice work! 🧹✨`,
    color: 0x2ecc71, // green
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
