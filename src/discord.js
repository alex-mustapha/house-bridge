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

const WD = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-06-27" -> "Saturday, Jun 27" day-group header, with overdue/today marker.
function dayHeader(ymd, today) {
  const [y, m, d] = ymd.split("-").map(Number);
  const label = `${WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${MON[m - 1]} ${d}`;
  if (ymd < today) return `🔴 ${label} · overdue`;
  if (ymd === today) return `🟠 ${label} · today`;
  return label;
}

// Daily digest grouped by due day (mirrors /tasks): linked titles, no ticket
// number or status. Owners are still @-pinged in `content` (mentions only
// notify from content, not the embed), and each line notes whose chore it is.
export function buildDigestMessage(issues, mentionMap, today) {
  const groups = new Map(); // dueDate ("" if none) -> issues[]
  for (const i of issues) {
    const key = i.dueDate || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  const keys = [...groups.keys()].sort((a, b) =>
    (a || "9999-99-99").localeCompare(b || "9999-99-99"),
  );

  const sections = keys.map((key) => {
    const header = key ? dayHeader(key, today) : "No due date";
    const body = groups
      .get(key)
      .map((i) => `• [${i.title}](${i.url})${i.assignee?.name ? ` — ${i.assignee.name}` : ""}`)
      .join("\n");
    return `**${header}**\n${body}`;
  });

  // Ping each owner who has chores in the window, with their count.
  const counts = new Map();
  for (const i of issues) {
    const n = i.assignee?.name;
    if (n) counts.set(n, (counts.get(n) || 0) + 1);
  }
  const pings = [...counts.entries()].map(
    ([name, c]) => `${mentionFor(name, mentionMap) || name} — ${c}`,
  );

  return {
    content: `🔔 **Today's chores**${pings.length ? `\n${pings.join(" · ")}` : ""}`,
    embeds: [
      {
        title: "📅 Daily chores",
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
