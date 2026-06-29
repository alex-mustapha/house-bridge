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
  getDoneStateId,
  setIssueState,
  fetchSpawned,
  assignIssue,
  unassignIssue,
} from "./linear.js";
import { localDate, annotateTemplates, withTemplateLink, runWeek } from "./recurring.js";
import { addPause, clearPauses, getActivePauses, getPauseHistory } from "./pauses.js";
import { setWeight, clearWeight, listWeights } from "./weights.js";

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

export async function handleInteraction(interaction, env, ctx) {
  if (interaction.type === 1) return { type: 1 }; // PING -> PONG
  if (interaction.type === 3) return handleComponent(interaction, env); // button click
  if (interaction.type === 4) return autocompleteResponse(interaction, env); // option autocomplete
  if (interaction.type === 2) {
    switch (interaction.data?.name) {
      case "tasks":
        return tasksResponse(interaction, env);
      case "project":
        return projectResponse(interaction, env);
      case "unassigned":
        return unassignedResponse(interaction, env);
      case "chores":
        return choreCommand(interaction, env, ctx);
    }
  }
  return { type: 4, data: { content: "Unsupported command.", flags: EPHEMERAL } };
}

// The Linear user the clicker maps to (via DISCORD_MENTIONS), for "claim".
async function resolveCaller(env, interaction) {
  const discordId = interaction.member?.user?.id || interaction.user?.id;
  if (!discordId) return null;
  const byName = mentionMap(env.DISCORD_MENTIONS); // name(lower) -> discordId
  const name = Object.entries(byName).find(([, id]) => id === discordId)?.[0];
  if (!name) return null;
  const u = (await getUsers(env)).find((x) =>
    [x.displayName, x.name].some((n) => (n || "").toLowerCase() === name || (n || "").toLowerCase().includes(name)),
  );
  return u?.id || null;
}

// Button/menu clicks (message components). The digest's actions dropdown carries
// values "done:<id>:<team>" (mark done) or "claim:<id>:<team>" (assign to me).
async function handleComponent(interaction, env) {
  const cid = interaction.data?.custom_id || "";

  if (cid === "actions-menu" || cid === "done-menu") {
    const legacy = cid === "done-menu"; // old menu: values were "<id>:<team>"
    const vals = interaction.data?.values || [];
    const clicker = vals.some((v) => v.startsWith("claim:")) ? await resolveCaller(env, interaction) : null;
    const done = new Set();
    const claimed = new Set();
    for (const v of vals) {
      const [action, id, team] = legacy ? ["done", ...v.split(":")] : v.split(":");
      try {
        if (action === "done") {
          const stateId = team ? await getDoneStateId(env, team) : null;
          if (stateId && id && (await setIssueState(env, id, stateId))?.success) done.add(v);
        } else if (action === "claim" && clicker && id) {
          if ((await assignIssue(env, id, clicker))?.success) claimed.add(v);
        }
      } catch {
        /* skip this one */
      }
    }
    // Rebuild: drop completed options; turn claimed ones into "done" options.
    const msg = interaction.message || {};
    const components = (msg.components || [])
      .map((row) => ({
        ...row,
        components: (row.components || [])
          .map((c) => {
            if (c.type === 3 && (c.custom_id === "actions-menu" || c.custom_id === "done-menu")) {
              const opts = (c.options || [])
                .filter((o) => !done.has(o.value))
                .map((o) => {
                  if (!claimed.has(o.value)) return o;
                  const [, id, team] = o.value.split(":");
                  return { label: o.label.replace(/^🙋\s*/, "✓ "), value: `done:${id}:${team || ""}`, description: o.description };
                });
              return opts.length
                ? { ...c, custom_id: "actions-menu", options: opts, max_values: Math.min(opts.length, 25) }
                : null;
            }
            return c;
          })
          .filter(Boolean),
      }))
      .filter((row) => (row.components || []).length);
    return {
      type: 7,
      data: { content: msg.content || "", embeds: msg.embeds || [], components, allowed_mentions: { parse: [] } },
    };
  }

  if (cid.startsWith("done:")) {
    const [, issueId, teamId] = cid.split(":");
    let ok = false;
    try {
      const stateId = teamId ? await getDoneStateId(env, teamId) : null;
      if (stateId && issueId) ok = !!(await setIssueState(env, issueId, stateId))?.success;
    } catch {
      ok = false;
    }
    if (!ok) {
      return { type: 4, data: { content: "⚠️ Couldn't mark that done — try `/chores done`.", flags: EPHEMERAL } };
    }
    // Update the source message: drop the clicked button (and any now-empty rows).
    const msg = interaction.message || {};
    const components = (msg.components || [])
      .map((row) => ({ ...row, components: (row.components || []).filter((c) => c.custom_id !== cid) }))
      .filter((row) => (row.components || []).length);
    return {
      type: 7, // UPDATE_MESSAGE
      data: {
        content: msg.content || "",
        embeds: msg.embeds || [],
        components,
        allowed_mentions: { parse: [] }, // don't re-ping on edit
      },
    };
  }
  return { type: 6 }; // unknown component — ack with no change
}

// Autocomplete (type 8) responses.
async function autocompleteResponse(interaction, env) {
  if (interaction.data?.name === "project") {
    const focused = (interaction.data.options || []).find((o) => o.focused);
    const typed = (focused?.value || "").toLowerCase();
    return acChoices((await fetchProjectNames(env)).filter((n) => n.toLowerCase().includes(typed)));
  }
  if (interaction.data?.name === "chores") return choreAutocomplete(interaction, env);
  return { type: 8, data: { choices: [] } };
}

// Turn a list of strings into an autocomplete response (deduped, max 25).
function acChoices(values) {
  const seen = new Set();
  const choices = [];
  for (const v of values) {
    const key = (v || "").toLowerCase();
    if (!v || seen.has(key)) continue;
    seen.add(key);
    choices.push({ name: v.slice(0, 100), value: v.slice(0, 100) });
    if (choices.length >= 25) break;
  }
  return { type: 8, data: { choices } };
}

// Suggestions for /chores options: chore titles (scoped per subcommand) and people.
async function choreAutocomplete(interaction, env) {
  const sub = (interaction.data.options || [])[0];
  const opt = (sub?.options || []).find((o) => o.focused);
  if (!opt) return acChoices([]);
  const typed = (opt.value || "").toLowerCase();
  const match = (s) => (s || "").toLowerCase().includes(typed);

  if (opt.name === "user" || opt.name === "assignee") {
    return acChoices((await getUsers(env)).map((u) => u.displayName || u.name).filter(match));
  }
  if (opt.name === "chore") {
    const recurring = env.RECURRING_PROJECT || "Recurring";
    if (sub.name === "pause") {
      // any recurring template
      return acChoices((await fetchRecurringTemplates(env, recurring)).map((t) => t.title).filter(match));
    }
    if (sub.name === "resume") {
      // only templates currently carrying the `paused` label
      const paused = (await fetchRecurringTemplates(env, recurring))
        .filter((t) => (t.labels?.nodes || []).some((l) => (l.name || "").toLowerCase() === "paused"))
        .map((t) => t.title);
      return acChoices(paused.filter(match));
    }
    if (sub.name === "unclaim") {
      // unclaim drops one of *your* chores -> suggest only chores you own,
      // queried directly so we don't miss any past the 25-row match cap.
      const id = await resolveCaller(env, interaction);
      if (!id) return acChoices([]);
      const projects = choreProjects(env);
      const mine = (await fetchAssignedActiveIssues(env, id))
        .filter((i) => projects.includes(i.project?.name))
        .map((i) => i.title)
        .filter(match);
      return acChoices(mine);
    }
    const active = await findActiveByTitle(env, typed, choreProjects(env));
    // claim grabs work nobody owns yet -> only suggest unassigned chores, which
    // keeps the list short (assigned recurring chores are hidden).
    const pool = sub.name === "claim" ? active.filter((i) => !i.assignee?.name) : active;
    // snooze / skip / done / claim -> active chores in House Chores + Ad Hoc
    return acChoices(pool.map((i) => i.title).filter(match));
  }
  return acChoices([]);
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

// Edit the original (deferred) interaction reply once background work finishes.
// Uses the interaction token (self-authorizing) — no bot auth needed.
async function editInteractionReply(interaction, content) {
  const url = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) console.error("Interaction follow-up failed:", res.status, await res.text());
}

const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// The projects that hold do-able chores (recurring-generated + ad-hoc), searched
// by done/snooze/skip so ad-hoc chores stay actionable.
const choreProjects = (env) => [env.CHORES_PROJECT || "House Chores", env.ADHOC_PROJECT || "Ad Hoc"];

// /chores — the one-off control surface for scheduling changes (vacation holds,
// snooze, skip, add, done). Templates remain the source for permanent chores.
async function choreCommand(interaction, env, ctx) {
  const sub = (interaction.data.options || [])[0];
  const o = {};
  for (const opt of sub?.options || []) o[opt.name] = opt.value;
  // Refresh the templates' 🔁 schedule comments in the background so they reflect
  // the new pause/resume state without blocking the Discord reply.
  const refresh = () => ctx?.waitUntil?.(annotateTemplates(env));

  switch (sub?.name) {
    case "pause": {
      const today = localDate(new Date()).ymd;
      // chore scope -> the `paused` label on the template (the source of truth,
      // indefinite; great for variable seasons). Date options don't apply here.
      if (o.chore) {
        const r = await setPausedLabel(env, o.chore, true, today);
        refresh();
        return r;
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
      let pausedUserId = null;
      if (o.user) {
        const u = (await getUsers(env)).find((x) =>
          [x.displayName, x.name].some((n) => (n || "").toLowerCase().includes(o.user.toLowerCase())),
        );
        if (!u) return reply(`No Linear user matching "${o.user}".`);
        scope = "user";
        target = u.displayName || u.name;
        pausedUserId = u.id;
        label = `**${target}**'s chores (the other person covers)`;
      }
      await addPause(env, { scope, target, start: from, end: to, nowIso: new Date().toISOString() });
      // Also archive already-generated recurring chores in the window.
      const cleared = await clearGeneratedInWindow(env, { from, to, userId: pausedUserId });
      // On a whole-household pause, spawn the prep checklist due at the start.
      const prepNote = scope === "global" ? await spawnPrepChecklist(env, from) : "";
      refresh();
      const window = to === "9999-12-31" ? `**indefinitely** (from ${from})` : `**${from} → ${to}**`;
      const undo = scope === "user" ? ` user:${target}` : "";
      const clearedNote = cleared
        ? ` Archived **${cleared}** generated chore${cleared === 1 ? "" : "s"} already on the list for those days.`
        : "";
      return say(`⏸️ Paused ${label} ${window}.${clearedNote}${prepNote} Use \`/chores resume${undo}\` to lift it.`);
    }
    case "resume": {
      const today = localDate(new Date()).ymd;
      if (o.chore) {
        const r = await setPausedLabel(env, o.chore, false, today);
        refresh();
        return r;
      }
      if (!env.DB) return reply("Pause storage unavailable (no DB).");
      let filter;
      let label = "all pauses";
      if (o.user) { filter = { scope: "user", target: o.user }; label = `${o.user}'s pauses`; }
      const n = await clearPauses(env, today, filter);
      refresh();
      return say(n ? `▶️ Resumed — cleared ${n} pause${n === 1 ? "" : "s"}.` : `No upcoming ${label} to clear.`);
    }
    case "pauses":
      return pausesList(env);
    case "weight": {
      if (o.user && o.reset) {
        if (!env.DB) return reply("Weight storage unavailable (no DB).");
        await clearWeight(env, o.user);
        return say(`↩️ Reset **${o.user}**'s rotation weight to the default.`);
      }
      if (o.user && o.value != null) {
        if (!env.DB) return reply("Weight storage unavailable (no DB).");
        const v = Math.max(1, Math.min(1000, parseInt(o.value, 10)));
        await setWeight(env, o.user, v);
        return say(`⚖️ **${o.user}**'s rotation weight is now ${v}. Takes effect at the next weekly generation.`);
      }
      const rows = await listWeights(env);
      const total = rows.reduce((s, r) => s + r.weight, 0) || 1;
      const lines = rows.map(
        (r) => `• **${r.name}**: ${r.weight}${r.overridden ? " (override)" : ""} — ~${Math.round((r.weight / total) * 100)}% of the load`,
      );
      return reply(
        `⚖️ **Rotation weights** (higher = more chores)\n${lines.join("\n") || "_none configured_"}\n` +
          "Change with `/chores weight user:<name> value:<n>`, or `reset:true` to revert.",
      );
    }
    case "help":
      return reply(choreHelp());
    case "sync": {
      // Generation can outrun Discord's 3s window — defer, then edit the reply
      // with the summary. Idempotent: existing occurrences are skipped.
      ctx?.waitUntil?.(
        (async () => {
          try {
            const r = await runWeek(env, { skipCleanup: true });
            await editInteractionReply(
              interaction,
              `♻️ Reschedule complete — **${r.created}** new chore${r.created === 1 ? "" : "s"} created. ` +
                "Existing chores were left untouched (past-due ones are only cleared by the Monday run).",
            );
          } catch (e) {
            console.error("sync runWeek failed:", e);
            await editInteractionReply(interaction, "⚠️ Reschedule hit an error — check the logs.");
          }
        })(),
      );
      return { type: 5, data: { flags: EPHEMERAL } }; // deferred ephemeral reply
    }
    case "calendar": {
      const base = (env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
      return reply(
        "📆 **Subscribe to your chores in your calendar app**\n" +
          "Add these as a *subscribed calendar* (Apple: Settings → Calendar → Accounts → Add → Other → Add Subscribed Calendar; Google: Other calendars → From URL):\n" +
          `• **Alex** — ${base}/cal/alex.ics\n` +
          `• **Kristal** — ${base}/cal/kristal.ics\n` +
          `• **Unassigned** (grabbable) — ${base}/cal/unassigned.ics\n` +
          "_Each chore shows as an all-day event on its due date with a 9am reminder. Read-only — complete chores from Discord or Linear. Apple refreshes hourly; Google can lag up to a day._",
      );
    }
    case "snooze": {
      const issue = await pickChore(env, o.chore);
      if (!issue) return reply(`No active chore matching "${o.chore}".`);
      const days = Math.max(1, Math.min(60, parseInt(o.days, 10) || 1));
      const newDue = addDays(issue.dueDate || localDate(new Date()).ymd, days);
      const res = await updateIssueDueDate(env, issue.id, newDue);
      if (!res?.success) return reply("Couldn't update the due date.");
      return say(`😴 Snoozed **${issue.title}** ${days} day${days === 1 ? "" : "s"} → due ${newDue}.`);
    }
    case "skip": {
      const issue = await pickChore(env, o.chore);
      if (!issue) return reply(`No active chore matching "${o.chore}".`);
      const res = await archiveIssue(env, issue.id);
      if (!res?.success) return reply("Couldn't skip that chore.");
      return say(`⏭️ Skipped **${issue.title}** for now — it'll return on its next scheduled date.`);
    }
    case "done": {
      const r = await markChoreDone(env, o.chore);
      return r.ok ? say(`✅ ${r.message}.`) : reply(r.message);
    }
    case "claim": {
      const issue = await pickChore(env, o.chore);
      if (!issue) return reply(`No active chore matching "${o.chore}".`);
      let userId, who;
      if (o.assignee) {
        const u = (await getUsers(env)).find((x) =>
          [x.displayName, x.name].some((n) => (n || "").toLowerCase().includes(o.assignee.toLowerCase())),
        );
        if (!u) return reply(`No Linear user matching "${o.assignee}".`);
        userId = u.id;
        who = u.name || u.displayName;
      } else {
        userId = await resolveCaller(env, interaction);
        if (!userId) return reply("Couldn't match you to a Linear user — pass `assignee:` to claim for a named person.");
        const u = (await getUsers(env)).find((x) => x.id === userId);
        who = u?.name || u?.displayName || "you";
      }
      const res = await assignIssue(env, issue.id, userId);
      if (!res?.success) return reply("Couldn't assign that chore.");
      return say(`🙋 **${who}** claimed **${issue.title}**.`);
    }
    case "unclaim": {
      const meId = await resolveCaller(env, interaction);
      if (!meId) return reply("Couldn't match you to a Linear user.");
      const issue = await pickChore(env, o.chore);
      if (!issue) return reply(`No active chore matching "${o.chore}".`);
      if (issue.assignee?.id !== meId)
        return reply(
          issue.assignee?.name
            ? `**${issue.title}** is assigned to ${issue.assignee.name}, not you.`
            : `**${issue.title}** is already unassigned.`,
        );
      const res = await unassignIssue(env, issue.id);
      if (!res?.success) return reply("Couldn't unassign that chore.");
      return say(`🤚 Dropped **${issue.title}** back to the unassigned pool.`);
    }
    case "add": {
      const teamId = await getTeamId(env, env.CHORES_TEAM || "CHO");
      if (!teamId) return reply("Chores team not found.");
      if (o.due && !isYmd(o.due)) return reply("`due` must be `YYYY-MM-DD`.");
      const dueDate = o.due || null; // no due date unless one is given
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
        projectId: await getProjectId(env, env.ADHOC_PROJECT || "Ad Hoc"),
      });
      if (!res?.success) return reply("Couldn't create the chore.");
      return say(`➕ Added **${o.title}**${dueDate ? ` (due ${dueDate})` : ""} to Ad Hoc${assigneeId ? ` for ${o.assignee}` : ""}.`);
    }
  }
  return reply("Unknown `/chores` subcommand.");
}

// Archive already-generated recurring chores whose due date falls in a pause
// window, so a pause clears the days now (not just future generation). STRICTLY
// limited to: House Chores project + title matches a Recurring template (i.e.
// engine-generated, never ad-hoc) + open + in-window + (assignee for user scope).
// Returns the count archived.
async function clearGeneratedInWindow(env, { from, to, userId }) {
  const teamId = await getTeamId(env, env.CHORES_TEAM || "CHO");
  if (!teamId) return 0;
  const templateTitles = new Set(
    (await fetchRecurringTemplates(env, env.RECURRING_PROJECT || "Recurring")).map((t) =>
      (t.title || "").toLowerCase(),
    ),
  );
  const spawned = await fetchSpawned(env, teamId, env.CHORES_PROJECT || "House Chores");
  const open = (n) => !["completed", "canceled"].includes(n.state?.type);
  let cleared = 0;
  for (const n of spawned) {
    if (!open(n) || !n.dueDate) continue;
    if (n.dueDate < from || n.dueDate > to) continue; // outside the pause window
    if (!templateTitles.has((n.title || "").toLowerCase())) continue; // generated recurring only
    if (userId && n.assignee?.id !== userId) continue; // user pause: only their chores
    const r = await archiveIssue(env, n.id);
    if (r?.success) cleared++;
  }
  return cleared;
}

// On a global pause, spawn the prep-checklist template (VACATION_PREP_TITLE, a
// no-cadence template in Recurring) into House Chores, due at the pause start.
// Returns a note for the reply (or "" if there's no such template).
async function spawnPrepChecklist(env, dueDate) {
  const prepTitle = env.VACATION_PREP_TITLE || "Vacation Prep";
  const tpl = (await fetchRecurringTemplates(env, env.RECURRING_PROJECT || "Recurring")).find(
    (t) => (t.title || "").toLowerCase() === prepTitle.toLowerCase(),
  );
  if (!tpl) return "";
  const teamId = await getTeamId(env, env.CHORES_TEAM || "CHO");
  if (!teamId) return "";
  const res = await createIssue(env, {
    teamId,
    title: tpl.title,
    description: withTemplateLink(tpl.description, tpl.url),
    dueDate,
    stateId: await getTodoStateId(env, teamId),
    projectId: await getProjectId(env, env.CHORES_PROJECT || "House Chores"),
    labelIds: (tpl.labels?.nodes || []).map((l) => l.id),
  });
  return res?.success ? ` 📋 Added **${tpl.title}** (due ${dueDate}).` : "";
}

// Best active chore matching `text` (soonest-due first) across the chore projects.
async function pickChore(env, text) {
  const matches = await findActiveByTitle(env, text, choreProjects(env));
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
      // Start a fresh pause-cycle comment; resume edits this same comment.
      await upsertComment(env, t.id, null, `⏸️ **Paused** ${today}`);
      done.push(t.title);
    } else if (!add && has) {
      await updateIssueLabels(env, t.id, ids.filter((id) => id !== pausedId));
      // Close the cycle: edit the most recent open pause comment (paused, not yet
      // resumed) so one comment captures the whole pause -> resume span.
      const open = (t.comments?.nodes || [])
        .filter((c) => (c.body || "").includes("**Paused**") && !(c.body || "").includes("**Resumed**"))
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))[0];
      if (open) {
        await upsertComment(env, t.id, open.id, `${open.body} → ▶️ **Resumed** ${today}`);
      } else {
        await upsertComment(env, t.id, null, `▶️ **Resumed** ${today}`);
      }
      done.push(t.title);
    }
  }
  if (!done.length) {
    return reply(add ? `"${text}" is already paused (or no match).` : `No paused template matched "${text}".`);
  }
  return say(
    add
      ? `⏸️ Paused **${done.join(", ")}** (added the \`paused\` label). \`/chores resume chore:${text}\` brings it back.`
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
    "**`/chores` — household chore controls**",
    "",
    "__Pause / resume__",
    "• `/chores pause` — pause **everyone** (vacation). Add `from:`/`to:` (YYYY-MM-DD) for a window; omit = until you resume.",
    "• `/chores pause user:<name>` — opt one person out (sick/away); their chores shift to the other.",
    "• `/chores pause chore:<name>` — take a chore off-radar (adds the `paused` label; best for variable seasons like mowing).",
    "• `/chores resume` — clear all everyone/person holds.",
    "• `/chores resume user:<name>` — clear that person's hold.  `/chores resume chore:<name>` — un-pause that chore.",
    "",
    "__Day-to-day__",
    "• `/chores snooze chore:<name> [days:N]` — push a chore's due date out (default 1).",
    "• `/chores skip chore:<name>` — skip the current copy; it returns next cycle.",
    "• `/chores add title:<…> [due:YYYY-MM-DD] [assignee:<name>]` — add a one-off chore.",
    "• `/chores done chore:<name>` — mark a chore done.",
    "",
    "__Info & tuning__",
    "• `/chores pauses` — what's currently paused (+ recent).",
    "• `/chores weight [user:<name>] [value:<n>] [reset:true]` — view or skew the rotation load (e.g. 60/40).",
    "• `/chores help` — this message.",
    "",
    "Names match loosely (partial, case-insensitive). Permanent recurring chores are defined as **templates** in Linear's _Recurring_ project; `/tasks`, `/project`, `/unassigned` list issues.",
  ].join("\n");
}
