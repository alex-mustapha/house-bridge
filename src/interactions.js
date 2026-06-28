// Discord slash-command (HTTP interactions) support: Ed25519 request
// verification and the /tasks command, which lists a user's active Linear
// issues. Discord POSTs to the Worker's /interactions endpoint.

import {
  getUsers,
  fetchAssignedActiveIssues,
  fetchProjectNames,
  fetchActiveByProject,
  fetchUnassignedActive,
  markChoreDone,
  findActiveByTitle,
  archiveIssue,
  updateIssueDueDate,
  createIssue,
  getProjectId,
  getTodoStateId,
  getTeamId,
} from "./linear.js";
import { localDate } from "./recurring.js";
import { addHold, clearUpcomingHolds } from "./holds.js";

const WD = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-06-27" -> "Saturday, Jun 27" as a day-group header, with overdue/today
// markers relative to `today`.
function dayHeader(ymd, today) {
  const [y, m, d] = ymd.split("-").map(Number);
  const label = `${WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${MON[m - 1]} ${d}`;
  if (ymd < today) return `🔴 ${label} · overdue`;
  if (ymd === today) return `🟠 ${label} · today`;
  return label;
}

const EPHEMERAL = 64; // interaction response flag: only the caller sees it

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

// Import the app's Ed25519 public key, tolerating both algorithm names the
// Cloudflare runtime has used ("Ed25519" and legacy "NODE-ED25519").
async function importEdKey(raw) {
  try {
    return await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "NODE-ED25519", namedCurve: "NODE-ED25519" },
      false,
      ["verify"],
    );
  }
}

// Discord signs each request; verify it with the app's public key (hex).
export async function verifyDiscordSignature(publicKeyHex, signature, timestamp, body) {
  if (!publicKeyHex || !signature || !timestamp) return false;
  try {
    const key = await importEdKey(hexToBytes(publicKeyHex));
    return await crypto.subtle.verify(
      key.algorithm?.name || "Ed25519",
      key,
      hexToBytes(signature),
      new TextEncoder().encode(timestamp + body),
    );
  } catch (err) {
    console.error("Discord signature verify error:", err);
    return false;
  }
}

// name -> discordId map from DISCORD_MENTIONS ("Alex:111,Kristal:222").
function mentionMap(spec) {
  const map = {};
  if (!spec) return map;
  for (const pair of spec.split(",")) {
    const [k, v] = pair.split(":").map((s) => s.trim());
    if (k && v) map[k.toLowerCase()] = v;
  }
  return map;
}

export async function handleInteraction(interaction, env) {
  if (interaction.type === 1) return { type: 1 }; // PING -> PONG
  if (interaction.type === 4) return autocompleteResponse(interaction, env); // option autocomplete
  if (interaction.type === 2) {
    switch (interaction.data?.name) {
      case "tasks":
        return tasksResponse(interaction, env);
      case "project":
        return projectResponse(interaction, env);
      case "unassigned":
        return unassignedResponse(interaction, env);
      case "chore":
        return choreCommand(interaction, env);
    }
  }
  return { type: 4, data: { content: "Unsupported command.", flags: EPHEMERAL } };
}

// Live project list for the /project command's autocomplete.
async function autocompleteResponse(interaction, env) {
  if (interaction.data?.name !== "project") return { type: 8, data: { choices: [] } };
  const focused = (interaction.data.options || []).find((o) => o.focused);
  const typed = (focused?.value || "").toLowerCase();
  const names = await fetchProjectNames(env);
  const choices = names
    .filter((n) => n.toLowerCase().includes(typed))
    .slice(0, 25)
    .map((n) => ({ name: n, value: n }));
  return { type: 8, data: { choices } };
}

// Group issues by due day (soonest first; undated last) into embed sections,
// formatting each line with `lineFn`.
function dayGroupedSections(issues, today, lineFn) {
  const groups = new Map();
  for (const i of issues) {
    const key = i.dueDate || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  return [...groups.keys()]
    .sort((a, b) => (a || "9999-99-99").localeCompare(b || "9999-99-99"))
    .map((key) => {
      const header = key ? dayHeader(key, today) : "No due date";
      return `**${header}**\n${groups.get(key).map(lineFn).join("\n")}`;
    });
}

function embedReply(title, sections) {
  return {
    type: 4,
    data: {
      embeds: [{ title, description: sections.join("\n\n").slice(0, 4000), color: 0x5e6ad2 }],
      flags: EPHEMERAL,
    },
  };
}

async function projectResponse(interaction, env) {
  const projectName = (interaction.data.options || []).find((o) => o.name === "project")?.value;
  if (!projectName) return reply("Pick a project.");
  const issues = await fetchActiveByProject(env, projectName);
  if (!issues.length) return reply(`🎉 No open issues in ${projectName}.`);
  const today = localDate(new Date()).ymd;
  const sections = dayGroupedSections(issues, today, (i) =>
    `• [${i.title}](${i.url})${i.assignee?.name ? ` — ${i.assignee.name}` : ""}`,
  );
  return embedReply(`📁 ${projectName} — ${issues.length} open`, sections);
}

async function unassignedResponse(interaction, env) {
  const recurring = env.RECURRING_PROJECT || "Recurring";
  const issues = (await fetchUnassignedActive(env)).filter(
    (i) => i.project?.name !== recurring,
  );
  if (!issues.length) return reply("🎉 Nothing unassigned.");
  const today = localDate(new Date()).ymd;

  // Group by due day, then sub-group by project within each day.
  const byDay = new Map();
  for (const i of issues) {
    const key = i.dueDate || "";
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(i);
  }
  const sections = [...byDay.keys()]
    .sort((a, b) => (a || "9999-99-99").localeCompare(b || "9999-99-99"))
    .map((dayKey) => {
      const header = dayKey ? dayHeader(dayKey, today) : "No due date";
      const byProject = new Map();
      for (const i of byDay.get(dayKey)) {
        const p = i.project?.name || "No project";
        if (!byProject.has(p)) byProject.set(p, []);
        byProject.get(p).push(i);
      }
      const blocks = [...byProject.keys()].sort().map((p) => {
        const lines = byProject.get(p).map((i) => `• [${i.title}](${i.url})`).join("\n");
        return `__${p}__\n${lines}`;
      });
      return `**${header}**\n${blocks.join("\n")}`;
    });

  return embedReply(`🙋 Unassigned — ${issues.length}`, sections);
}

async function tasksResponse(interaction, env) {
  // Target: the optional "user" option, else the caller.
  const opt = (interaction.data.options || []).find((o) => o.name === "user");
  const discordId = opt?.value || interaction.member?.user?.id || interaction.user?.id;

  // Discord id -> configured name -> Linear user.
  const byName = mentionMap(env.DISCORD_MENTIONS);
  const name = Object.entries(byName).find(([, id]) => id === discordId)?.[0];
  if (!name) {
    return reply(`No Linear mapping for <@${discordId}>. Add them to DISCORD_MENTIONS.`);
  }

  const users = await getUsers(env);
  const user = users.find(
    (u) =>
      (u.displayName || "").toLowerCase() === name ||
      (u.name || "").toLowerCase() === name ||
      (u.displayName || "").toLowerCase().includes(name) ||
      (u.name || "").toLowerCase().includes(name),
  );
  if (!user) return reply(`Couldn't find a Linear user matching "${name}".`);

  // Exclude recurring-chore templates (they live in the Recurring project).
  const recurringProject = env.RECURRING_PROJECT || "Recurring";
  const issues = (await fetchAssignedActiveIssues(env, user.id)).filter(
    (i) => i.project?.name !== recurringProject,
  );
  if (!issues.length) {
    return reply(`🎉 ${user.name || name} has no open tasks.`);
  }

  const today = localDate(new Date()).ymd;
  const sections = dayGroupedSections(issues, today, (i) => `• [${i.title}](${i.url})`);
  return embedReply(
    `📋 ${user.name || name} — ${issues.length} open task${issues.length === 1 ? "" : "s"}`,
    sections,
  );
}

function reply(content) {
  return { type: 4, data: { content, flags: EPHEMERAL } };
}

// Public (non-ephemeral) reply — used for mutations so both partners see them.
function say(content) {
  return { type: 4, data: { content } };
}

const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// /chore — the one-off control surface for scheduling changes (vacation holds,
// snooze, skip, add, done). Templates remain the source for permanent chores.
async function choreCommand(interaction, env) {
  const sub = (interaction.data.options || [])[0];
  const o = {};
  for (const opt of sub?.options || []) o[opt.name] = opt.value;
  const project = env.CHORES_PROJECT || "House Chores";

  switch (sub?.name) {
    case "hold": {
      if (!isYmd(o.from) || !isYmd(o.to)) return reply("Dates must be `YYYY-MM-DD`.");
      if (o.to < o.from) return reply("`to` must be on or after `from`.");
      if (!env.DB) return reply("Hold storage unavailable (no DB).");
      await addHold(env, o.from, o.to, new Date().toISOString());
      return say(`🏝️ Chores paused **${o.from} → ${o.to}** (inclusive). Nothing will be generated for those days. Use \`/chore resume\` to cancel.`);
    }
    case "resume": {
      if (!env.DB) return reply("Hold storage unavailable (no DB).");
      const n = await clearUpcomingHolds(env, localDate(new Date()).ymd);
      return say(n ? `▶️ Cleared ${n} upcoming hold${n === 1 ? "" : "s"}. Chores resume on schedule.` : "No upcoming holds to clear.");
    }
    case "snooze": {
      const issue = await pickChore(env, o.chore, project);
      if (!issue) return reply(`No active chore matching "${o.chore}".`);
      const days = Math.max(1, Math.min(60, parseInt(o.days, 10) || 1));
      const newDue = addDays(issue.dueDate || localDate(new Date()).ymd, days);
      const res = await updateIssueDueDate(env, issue.id, newDue);
      if (!res?.success) return reply("Couldn't update the due date.");
      return say(`😴 Snoozed **${issue.title}** ${days} day${days === 1 ? "" : "s"} → due ${newDue}.`);
    }
    case "skip": {
      const issue = await pickChore(env, o.chore, project);
      if (!issue) return reply(`No active chore matching "${o.chore}".`);
      const res = await archiveIssue(env, issue.id);
      if (!res?.success) return reply("Couldn't skip that chore.");
      return say(`⏭️ Skipped **${issue.title}** for now — it'll return on its next scheduled date.`);
    }
    case "done": {
      const r = await markChoreDone(env, o.chore);
      return r.ok ? say(`✅ ${r.message}.`) : reply(r.message);
    }
    case "add": {
      const teamId = await getTeamId(env, env.CHORES_TEAM || "CHO");
      if (!teamId) return reply("Chores team not found.");
      if (o.due && !isYmd(o.due)) return reply("`due` must be `YYYY-MM-DD`.");
      const dueDate = o.due || localDate(new Date()).ymd;
      let assigneeId;
      if (o.assignee) {
        const u = (await getUsers(env)).find((x) =>
          [x.displayName, x.name].some((n) => (n || "").toLowerCase().includes(o.assignee.toLowerCase())),
        );
        if (!u) return reply(`No Linear user matching "${o.assignee}".`);
        assigneeId = u.id;
      }
      const res = await createIssue(env, {
        teamId,
        title: o.title,
        dueDate,
        assigneeId,
        stateId: await getTodoStateId(env, teamId),
        projectId: await getProjectId(env, project),
      });
      if (!res?.success) return reply("Couldn't create the chore.");
      return say(`➕ Added **${o.title}** (due ${dueDate})${assigneeId ? ` for ${o.assignee}` : ""}.`);
    }
  }
  return reply("Unknown `/chore` subcommand.");
}

// Best active chore matching `text` (soonest-due first).
async function pickChore(env, text, project) {
  const matches = await findActiveByTitle(env, text, project);
  if (!matches.length) return null;
  matches.sort((a, b) => (a.dueDate || "9999-99-99").localeCompare(b.dueDate || "9999-99-99"));
  return matches[0];
}
