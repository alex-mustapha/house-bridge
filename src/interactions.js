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
  findTemplatesByTitle,
  updateIssueLabels,
  getLabelIds,
  upsertComment,
  fetchRecurringTemplates,
} from "./linear.js";
import { localDate } from "./recurring.js";
import { addPause, clearPauses, getActivePauses, getPauseHistory } from "./pauses.js";

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
    case "pause": {
      const today = localDate(new Date()).ymd;
      // chore scope -> the `paused` label on the template (the source of truth,
      // indefinite; great for variable seasons). Date options don't apply here.
      if (o.chore) {
        return setPausedLabel(env, o.chore, true, today);
      }
      // global / user -> a D1 pause window.
      if (!env.DB) return reply("Pause storage unavailable (no DB).");
      if (o.from && !isYmd(o.from)) return reply("`from` must be `YYYY-MM-DD`.");
      if (o.to && !isYmd(o.to)) return reply("`to` must be `YYYY-MM-DD`.");
      const from = o.from || today;
      const to = o.to || "9999-12-31";
      if (to < from) return reply("`to` must be on or after `from`.");
      let scope = "global";
      let target = null;
      let label = "**all chores**";
      if (o.user) {
        const u = (await getUsers(env)).find((x) =>
          [x.displayName, x.name].some((n) => (n || "").toLowerCase().includes(o.user.toLowerCase())),
        );
        if (!u) return reply(`No Linear user matching "${o.user}".`);
        scope = "user";
        target = u.displayName || u.name;
        label = `**${target}**'s chores (the other person covers)`;
      }
      await addPause(env, { scope, target, start: from, end: to, nowIso: new Date().toISOString() });
      const window = to === "9999-12-31" ? `**indefinitely** (from ${from})` : `**${from} → ${to}**`;
      const undo = scope === "user" ? ` user:${target}` : "";
      return say(`⏸️ Paused ${label} ${window}. Use \`/chore resume${undo}\` to clear.`);
    }
    case "resume": {
      const today = localDate(new Date()).ymd;
      if (o.chore) return setPausedLabel(env, o.chore, false, today);
      if (!env.DB) return reply("Pause storage unavailable (no DB).");
      let filter;
      let label = "all pauses";
      if (o.user) { filter = { scope: "user", target: o.user }; label = `${o.user}'s pauses`; }
      const n = await clearPauses(env, today, filter);
      return say(n ? `▶️ Resumed — cleared ${n} pause${n === 1 ? "" : "s"}.` : `No upcoming ${label} to clear.`);
    }
    case "pauses":
      return pausesList(env);
    case "help":
      return reply(choreHelp());
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

// Add/remove the `paused` label on recurring templates matching `text`, with a
// dated audit comment on each. The label is the source of truth for taking a
// chore off-radar (e.g. seasonal); buildDefs skips paused templates.
async function setPausedLabel(env, text, add, today) {
  const tpls = await findTemplatesByTitle(env, text, env.RECURRING_PROJECT || "Recurring");
  if (!tpls.length) return reply(`No recurring template matching "${text}".`);
  const [pausedId] = await getLabelIds(env, ["paused"]);
  if (!pausedId) return reply("No `paused` label exists in the workspace — create it first.");
  const done = [];
  for (const t of tpls) {
    const ids = (t.labels?.nodes || []).map((l) => l.id);
    const has = ids.includes(pausedId);
    if (add && !has) {
      await updateIssueLabels(env, t.id, [...ids, pausedId]);
      await upsertComment(env, t.id, null, `⏸️ **Paused** ${today} via /chore — off-radar until resumed.`);
      done.push(t.title);
    } else if (!add && has) {
      await updateIssueLabels(env, t.id, ids.filter((id) => id !== pausedId));
      await upsertComment(env, t.id, null, `▶️ **Resumed** ${today} via /chore.`);
      done.push(t.title);
    }
  }
  if (!done.length) {
    return reply(add ? `"${text}" is already paused (or no match).` : `No paused template matched "${text}".`);
  }
  return say(
    add
      ? `⏸️ Paused **${done.join(", ")}** (added the \`paused\` label). \`/chore resume chore:${text}\` brings it back.`
      : `▶️ Resumed **${done.join(", ")}** (removed the \`paused\` label).`,
  );
}

// What's currently paused (everyone/person holds + paused-labeled chores) plus
// recent hold history.
async function pausesList(env) {
  const active = env.DB ? await getActivePauses(env) : [];
  const holds = active.map((p) => {
    const who = p.scope === "global" ? "Everyone" : p.target;
    const win = p.end_date === "9999-12-31" ? `since ${p.start_date}` : `${p.start_date} → ${p.end_date}`;
    return `• ${who} — ${win}`;
  });
  const pausedChores = (await fetchRecurringTemplates(env, env.RECURRING_PROJECT || "Recurring"))
    .filter((t) => (t.labels?.nodes || []).some((l) => (l.name || "").toLowerCase() === "paused"))
    .map((t) => `• ${t.title}`);
  const hist = (env.DB ? await getPauseHistory(env, 5) : []).map((h) => {
    const who = h.scope === "global" ? "Everyone" : h.target;
    const end = h.end_date === "9999-12-31" ? "…" : h.end_date;
    return `• ${who} ${h.start_date}→${end} (${h.status})`;
  });
  const sections = [
    `**⏸️ Holds (everyone / a person)**\n${holds.length ? holds.join("\n") : "_none_"}`,
    `**🏷️ Paused chores (label)**\n${pausedChores.length ? pausedChores.join("\n") : "_none_"}`,
  ];
  if (hist.length) sections.push(`**🕘 Recent holds**\n${hist.join("\n")}`);
  return reply(sections.join("\n\n"));
}

function choreHelp() {
  return [
    "**`/chore` — household chore controls**",
    "",
    "__Pause / resume__",
    "• `/chore pause` — pause **everyone** (vacation). Add `from:`/`to:` (YYYY-MM-DD) for a window; omit = until you resume.",
    "• `/chore pause user:<name>` — opt one person out (sick/away); their chores shift to the other.",
    "• `/chore pause chore:<name>` — take a chore off-radar (adds the `paused` label; best for variable seasons like mowing).",
    "• `/chore resume` — clear all everyone/person holds.",
    "• `/chore resume user:<name>` — clear that person's hold.  `/chore resume chore:<name>` — un-pause that chore.",
    "",
    "__Day-to-day__",
    "• `/chore snooze chore:<name> [days:N]` — push a chore's due date out (default 1).",
    "• `/chore skip chore:<name>` — skip the current copy; it returns next cycle.",
    "• `/chore add title:<…> [due:YYYY-MM-DD] [assignee:<name>]` — add a one-off chore.",
    "• `/chore done chore:<name>` — mark a chore done.",
    "",
    "__Info__",
    "• `/chore pauses` — what's currently paused (+ recent).",
    "• `/chore help` — this message.",
    "",
    "Names match loosely (partial, case-insensitive). Permanent recurring chores are defined as **templates** in Linear's _Recurring_ project; `/tasks`, `/project`, `/unassigned` list issues.",
  ].join("\n");
}
