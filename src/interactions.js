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
  getCanceledStateId,
  cancelChore,
  setIssueState,
  fetchSpawned,
  assignIssue,
  unassignIssue,
  fetchIssueBrief,
  fetchRecentCompletedAssigned,
  fetchChoreHistory,
} from "./linear.js";
import { localDate, annotateTemplates, withTemplateLink, runWeek, createCatchups, rebalanceWindow, reshuffleWindow, coverUserPause } from "./recurring.js";
import { addPause, clearPauses, getActivePauses, getPauseHistory } from "./pauses.js";
import { setWeight, clearWeight, listWeights } from "./weights.js";
import { announceClaim } from "./discord.js";
import { recordLeisure } from "./leisure.js";
import { flagChoreDetail, clearChoreDetail } from "./db.js";

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

export async function handleInteraction(interaction, env, ctx, dispatch) {
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
      case "admin":
        return adminCommand(interaction, env, ctx, dispatch);
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

  if (["actions-menu", "done-menu", "cancel-menu", "claim-menu"].includes(cid)) {
    const legacy = cid === "done-menu"; // old menu: values were "<id>:<team>"
    const vals = interaction.data?.values || [];
    const clicker = vals.some((v) => v.startsWith("claim:")) ? await resolveCaller(env, interaction) : null;
    // Track resolved work by ISSUE ID, not by option value: each chore now has
    // both a "✓ done" and a "✖ cancel" entry, and acting on either must remove
    // both from the rebuilt menu.
    const resolvedIds = new Set();
    const claimed = new Set();
    const tookOver = [];
    for (const v of vals) {
      const [action, id, team] = legacy ? ["done", ...v.split(":")] : v.split(":");
      try {
        if (action === "done") {
          const stateId = team ? await getDoneStateId(env, team) : null;
          if (stateId && id && (await setIssueState(env, id, stateId))?.success) resolvedIds.add(id);
        } else if (action === "cancel") {
          const stateId = team ? await getCanceledStateId(env, team) : null;
          if (stateId && id && (await setIssueState(env, id, stateId))?.success) resolvedIds.add(id);
        } else if (action === "claim" && clicker && id) {
          // Read the current owner first: the mutation only reports the new
          // state, and the notification needs to name who it came off.
          const before = await fetchIssueBrief(env, id);
          if ((await assignIssue(env, id, clicker))?.success) {
            claimed.add(v);
            const prev = before?.assignee;
            // Re-claiming your own changes nothing, so stays quiet. Taking
            // someone else's names them; picking up unclaimed work doesn't.
            if (!prev?.id || prev.id !== clicker) {
              tookOver.push({
                title: before?.title || "a chore",
                from: prev?.id ? prev.name : null,
              });
            }
          }
        }
      } catch {
        /* skip this one */
      }
    }
    // Always announce in the due channel, never wherever the click happened —
    // the point is that the person who no longer owns it finds out.
    if (tookOver.length) {
      const users = await getUsers(env).catch(() => []);
      const who = users.find((u) => u.id === clicker);
      const taker = who?.name || who?.displayName || "Someone";
      for (const t of tookOver) {
        ctx?.waitUntil?.(announceClaim(env, { taker, title: t.title, from: t.from }));
      }
    }

    // Rebuild: drop completed options; turn claimed ones into "done" options.
    const msg = interaction.message || {};
    const components = (msg.components || [])
      .map((row) => ({
        ...row,
        components: (row.components || [])
          .map((c) => {
            if (
              c.type === 3 &&
              ["actions-menu", "done-menu", "cancel-menu", "claim-menu"].includes(c.custom_id)
            ) {
              const rowId = c.custom_id === "done-menu" ? "actions-menu" : c.custom_id;
              // The take-over row lists chores belonging to someone else. Once
              // one is claimed it's no longer a take-over for anybody, so it's
              // dropped — unlike the main row, where a claimed chore becomes a
              // "✓ done" option for its new owner.
              const isClaimRow = c.custom_id === "claim-menu";
              // Old "done-menu" rows stored "<id>:<team>"; current rows store
              // "<action>:<id>:<team>". Pull the issue id from the right slot or
              // pruning silently no-ops on an older digest.
              const legacyRow = c.custom_id === "done-menu";
              const optId = (v) => v.split(":")[legacyRow ? 0 : 1];
              const opts = (c.options || [])
                .filter((o) => !resolvedIds.has(optId(o.value)))
                .filter((o) => !(isClaimRow && claimed.has(o.value)))
                .map((o) => {
                  if (isClaimRow || !claimed.has(o.value)) return o;
                  const [, id, team] = o.value.split(":");
                  return { label: o.label.replace(/^🙋\s*/, "✓ "), value: `done:${id}:${team || ""}`, description: o.description };
                });
              return opts.length
                ? { ...c, custom_id: rowId, options: opts, max_values: Math.min(opts.length, 25) }
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
  if (interaction.data?.name === "admin") {
    const sub = (interaction.data.options || [])[0];
    const opt = (sub?.options || []).find((o) => o.focused);
    if (opt?.name !== "chore") return acChoices([]);
    const typed = (opt.value || "").toLowerCase();
    const tpls = await fetchRecurringTemplates(env, env.RECURRING_PROJECT || "Recurring");
    return acChoices(tpls.map((t) => t.title).filter((t) => (t || "").toLowerCase().includes(typed)));
  }
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
    if (sub.name === "needswork") {
      // You flag a chore after it's been done, so suggest recent completions
      // rather than the active list.
      const teamId = await getTeamId(env, env.CHORES_TEAM || "CHO");
      if (!teamId) return acChoices([]);
      const since = localDate(new Date(Date.now() - 30 * 86_400_000)).ymd;
      const hist = await fetchChoreHistory(env, teamId, since);
      const titles = hist
        .filter((h) => h.completedAt)
        .sort((a2, b2) => (b2.completedAt || "").localeCompare(a2.completedAt || ""))
        .map((h) => h.title);
      return acChoices(titles.filter(match));
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
    // snooze / skip / done / cancel / claim -> active chores in House Chores + Ad Hoc
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

// For commands whose work can exceed Discord's 3s reply window: acknowledge
// immediately with a deferred reply, run `worker()` in the background, then
// edit the reply with the string it returns. Defaults to a public reply.
function deferAndRun(interaction, ctx, worker, { ephemeral = false } = {}) {
  ctx?.waitUntil?.(
    (async () => {
      try {
        await editInteractionReply(interaction, await worker());
      } catch (e) {
        console.error("Deferred command failed:", e);
        // Surface the actual failure (Linear's message bubbles up through
        // linearQuery) — a generic "check the logs" made these undiagnosable.
        const detail = (e?.message || "").slice(0, 300);
        await editInteractionReply(
          interaction,
          `⚠️ That hit an error${detail ? `: ${detail}` : " — check the logs."}`,
        );
      }
    })(),
  );
  return { type: 5, data: ephemeral ? { flags: EPHEMERAL } : {} };
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
        return deferAndRun(interaction, ctx, async () => {
          const r = await setPausedLabel(env, o.chore, true, today);
          // Retract this chore's already-materialized future copies now.
          const wk = await runWeek(env, { skipCleanup: true }).catch(() => null);
          await annotateTemplates(env).catch((e) => console.error("annotate failed:", e));
          const note = wk?.moved ? ` Cleared **${wk.moved}** upcoming copy(ies).` : "";
          return r.data.content + note;
        });
      }
      // global / user -> a D1 pause window. (Validation stays synchronous so
      // input errors reply instantly; the Linear work is deferred.)
      if (!env.DB) return reply("Pause storage unavailable (no DB).");
      // Guardrail: a global pause archives EVERY chore in the window, so never
      // do it by accident — require an explicit everyone:true when no user given.
      if (!o.user && !o.everyone) {
        return reply(
          "⚠️ No `user:` given. To pause just one person use `user:<name>`. " +
            "To pause the **whole household** (this archives all chores in the window), re-run with `everyone:true`.",
        );
      }
      if (o.from && !isYmd(o.from)) return reply("`from` must be `YYYY-MM-DD` (e.g. 2026-07-14).");
      if (o.to && !isYmd(o.to)) return reply("`to` must be `YYYY-MM-DD` (e.g. 2026-07-14).");
      const from = o.from || today;
      const to = o.to || "9999-12-31";
      if (to < from) return reply("`to` must be on or after `from`.");
      return deferAndRun(interaction, ctx, async () => {
        let scope = "global";
        let target = null;
        let label = "**all chores**";
        let pausedUserId = null;
        if (o.user) {
          const u = (await getUsers(env)).find((x) =>
            [x.displayName, x.name].some((n) => (n || "").toLowerCase().includes(o.user.toLowerCase())),
          );
          if (!u) return `No Linear user matching "${o.user}".`;
          scope = "user";
          target = u.displayName || u.name;
          pausedUserId = u.id;
          label = `**${target}**'s chores (the other person covers)`;
        }
        await addPause(env, { scope, target, start: from, end: to, nowIso: new Date().toISOString() });
        let actionNote = "";
        let prepNote = "";
        if (scope === "user") {
          // The other person covers: reassign her in-window chores in place
          // (no delete/recreate). Future generation drops her from rotation.
          const moved = await coverUserPause(env, { userId: pausedUserId, from, to });
          actionNote = moved
            ? ` Reassigned **${moved}** of ${target}'s chores in that window to the other person.`
            : ` No chores of ${target}'s in that window needed covering.`;
        } else {
          // Whole household away: archive the in-window chores + spawn prep.
          const cleared = await clearGeneratedInWindow(env, { from, to });
          prepNote = await spawnPrepChecklist(env, from);
          actionNote = cleared
            ? ` Archived **${cleared}** chore${cleared === 1 ? "" : "s"} already on the list for those days.`
            : "";
        }
        await annotateTemplates(env).catch((e) => console.error("annotate failed:", e));
        const window = to === "9999-12-31" ? `**indefinitely** (from ${from})` : `**${from} → ${to}**`;
        const undo = scope === "user" ? ` user:${target}` : "";
        return `⏸️ Paused ${label} ${window}.${actionNote}${prepNote} Use \`/chores resume${undo}\` to lift it.`;
      });
    }
    case "resume": {
      const today = localDate(new Date()).ymd;
      if (o.chore) {
        return deferAndRun(interaction, ctx, async () => {
          const r = await setPausedLabel(env, o.chore, false, today);
          // Regenerate so the unpaused chore's upcoming occurrences come back.
          await runWeek(env, { skipCleanup: true }).catch(() => null);
          await annotateTemplates(env).catch((e) => console.error("annotate failed:", e));
          return r.data.content;
        });
      }
      if (!env.DB) return reply("Pause storage unavailable (no DB).");
      const filter = o.user ? { scope: "user", target: o.user } : undefined;
      const label = o.user ? `${o.user}'s pauses` : "all pauses";
      return deferAndRun(interaction, ctx, async () => {
        // Global pauses being lifted owe catch-ups for any accumulating chore.
        const globals = o.user ? [] : (await getActivePauses(env)).filter((p) => p.scope === "global");
        const n = await clearPauses(env, today, filter);
        const made = [];
        for (const p of globals) {
          const r = await createCatchups(env, {
            start: p.start_date,
            end: p.end_date === "9999-12-31" ? null : p.end_date,
            returnDate: today,
          });
          made.push(...r.titles);
        }
        // Refill any days a global pause was suppressing, then rebalance so a
        // returning person is folded back into the rotation for the window.
        await runWeek(env, { skipCleanup: true }).catch(() => null);
        const rb = n ? await rebalanceWindow(env).catch(() => null) : null;
        await annotateTemplates(env).catch((e) => console.error("annotate failed:", e));
        const base = n ? `▶️ Resumed — cleared ${n} pause${n === 1 ? "" : "s"}.` : `No upcoming ${label} to clear.`;
        const rebNote = rb?.reassigned ? ` Rebalanced **${rb.reassigned}** upcoming chore(s).` : "";
        const catchNote = made.length
          ? ` 🧺 Catch-up tasks created (unassigned — claim them): **${made.join("**, **")}**.`
          : "";
        return base + rebNote + catchNote;
      });
    }
    case "pauses":
      return deferAndRun(interaction, ctx, async () => (await pausesList(env)).data.content, {
        ephemeral: true,
      });
    case "weight": {
      if (o.user && o.reset) {
        if (!env.DB) return reply("Weight storage unavailable (no DB).");
        return deferAndRun(interaction, ctx, async () => {
          await clearWeight(env, o.user);
          const rb = await rebalanceWindow(env).catch(() => null);
          const note = rb?.reassigned ? ` Rebalanced **${rb.reassigned}** upcoming chore(s).` : "";
          return `↩️ Reset **${o.user}**'s rotation weight to the default.${note}`;
        });
      }
      if (o.user && o.value != null) {
        if (!env.DB) return reply("Weight storage unavailable (no DB).");
        const v = Math.max(1, Math.min(1000, parseInt(o.value, 10)));
        return deferAndRun(interaction, ctx, async () => {
          await setWeight(env, o.user, v);
          const rb = await rebalanceWindow(env).catch(() => null);
          const note = rb?.reassigned
            ? ` Rebalanced **${rb.reassigned}** upcoming chore(s) to match.`
            : " No upcoming chores needed reassigning.";
          return `⚖️ **${o.user}**'s rotation weight is now ${v}.${note}`;
        });
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
      return reply(choreHelp(env.RECURRING_PROJECT_URL));
    case "sync": {
      // Generation can outrun Discord's 3s window — defer, then edit the reply
      // with the summary. Idempotent: existing occurrences are skipped.
      ctx?.waitUntil?.(
        (async () => {
          try {
            const r = await runWeek(env, { skipCleanup: true });
            const moved = r.moved ? ` · **${r.moved}** stale day(s) removed` : "";
            const more = r.capped
              ? ` ⏳ Hit the per-run cap with **${r.remaining}** still to create — run \`/chores sync\` again to finish.`
              : "";
            await editInteractionReply(
              interaction,
              `♻️ Reschedule complete — **${r.created}** new chore${r.created === 1 ? "" : "s"} created${moved}.${more} ` +
                "Past-due and in-progress chores were left untouched (past-due cleanup runs Mondays only).",
            );
          } catch (e) {
            console.error("sync runWeek failed:", e);
            await editInteractionReply(interaction, "⚠️ Reschedule hit an error — check the logs.");
          }
        })(),
      );
      return { type: 5, data: { flags: EPHEMERAL } }; // deferred ephemeral reply
    }
    case "leisure": {
      // Private by construction: deferred EPHEMERAL, so only the caller sees it
      // and nothing lands in the shared channel. The recording itself lives in
      // leisure.js so the widget button writes identical rows.
      return deferAndRun(
        interaction,
        ctx,
        async () => {
          const meId = await resolveCaller(env, interaction);
          if (!meId) return "Couldn't match you to a Linear user.";
          const me = (await getUsers(env)).find((u) => u.id === meId);
          const r = await recordLeisure(env, {
            userId: meId,
            person: me?.name || me?.displayName || "unknown",
            note: o.note || null,
          });
          if (r.error) return r.error;

          const lines = [];
          if (!r.created) {
            // Already recorded today — the first start of the day is the one
            // that counts, so report it rather than overwriting.
            const e = r.existing || {};
            lines.push(
              `🎮 **Already logged today**${e.time ? ` at ${e.time}` : ""} — ` +
                (e.clear ? "chores were clear ✅" : `${(e.total ?? 0) - (e.done ?? 0)} still due ⚠️`),
              "_Only the first start of the day counts, so this won't change it._",
            );
          } else {
            lines.push(
              r.clear
                ? `🎮 Logged — **chores clear** ✅  (${r.doneToday} done today)`
                : `🎮 Logged — **${r.dueToday.length} still due today** ⚠️`,
            );
            if (!r.clear) lines.push(r.dueToday.slice(0, 5).map((t) => `• ${t}`).join("\n"));
            if (r.overdue) {
              lines.push(`_(${r.overdue} older item${r.overdue === 1 ? "" : "s"} past due, not counted)_`);
            }
          }
          const h = r.history;
          if (h) {
            lines.push(
              `\n📈 Last 30 days: **${h.clear}/${h.total}** day${h.total === 1 ? "" : "s"} started clear` +
                (h.clearPct === null ? "" : ` (${h.clearPct}%)`) +
                (h.streak ? ` · 🔥 ${h.streak} day${h.streak === 1 ? "" : "s"} in a row` : ""),
            );
          }
          return lines.join("\n");
        },
        { ephemeral: true },
      );
    }
    case "reshuffle": {
      // Repairs rotation on chores that were already materialized (generation
      // dedups, so it never revisits them). Deferred — it can touch the whole
      // materialized window.
      return deferAndRun(interaction, ctx, async () => {
        const r = await reshuffleWindow(env);
        if (!r.considered) return "🔀 Nothing upcoming to re-rotate.";
        if (!r.reassigned) return `🔀 Checked **${r.considered}** upcoming chore(s) — rotation already looks right.`;
        const more = r.capped ? " ⏳ Hit the per-run cap — run it again to finish." : "";
        return (
          `🔀 Re-rotated **${r.reassigned}** of **${r.considered}** upcoming chore(s) so they alternate again.${more} ` +
          "Pinned chores, `opposite:` pairs, in-progress and past-due chores were left alone."
        );
      });
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
    // The day-to-day mutations below all do 2-5 sequential Linear round-trips.
    // Run inline they raced Discord's 3s reply window; each is deferred so the
    // ack is instant and the Linear work finishes in the background.
    case "snooze": {
      return deferAndRun(interaction, ctx, async () => {
        const issue = await pickChore(env, o.chore);
        if (!issue) return `No active chore matching "${o.chore}".`;
        const days = Math.max(1, Math.min(60, parseInt(o.days, 10) || 1));
        const newDue = addDays(issue.dueDate || localDate(new Date()).ymd, days);
        const res = await updateIssueDueDate(env, issue.id, newDue);
        if (!res?.success) return "Couldn't update the due date.";
        return `😴 Snoozed **${issue.title}** ${days} day${days === 1 ? "" : "s"} → due ${newDue}.`;
      });
    }
    case "skip": {
      return deferAndRun(interaction, ctx, async () => {
        const issue = await pickChore(env, o.chore);
        if (!issue) return `No active chore matching "${o.chore}".`;
        const res = await archiveIssue(env, issue.id);
        if (!res?.success) return "Couldn't skip that chore.";
        return `⏭️ Skipped **${issue.title}** for now — it'll return on its next scheduled date.`;
      });
    }
    case "done": {
      return deferAndRun(interaction, ctx, async () => {
        const r = await markChoreDone(env, o.chore);
        return r.ok ? `✅ ${r.message}.` : r.message;
      });
    }
    case "needswork": {
      // "Done, but a detail got overlooked." The completed chore is left
      // completely alone — it stays done, because it was done. This only
      // records a note against the person who did it, which surfaces the next
      // time that chore lands on them: check the checklist, finish it fully.
      return deferAndRun(
        interaction,
        ctx,
        async () => {
          if (!env.DB) return "Flag storage unavailable (no DB).";
          const teamId = await getTeamId(env, env.CHORES_TEAM || "CHO");
          if (!teamId) return "Chores team not found.";

          if (o.clear) {
            const n = await clearChoreDetail(env, o.chore);
            return n
              ? `✅ Cleared the note on **${o.chore}**.`
              : `No outstanding note on **${o.chore}**.`;
          }

          // Who last actually did it — that's who the reminder is for.
          const since = localDate(new Date(Date.now() - 120 * 86_400_000)).ymd;
          const history = await fetchChoreHistory(env, teamId, since);
          const want = (o.chore || "").toLowerCase();
          const done = history
            .filter((h) => (h.title || "").toLowerCase().includes(want) && h.completedAt && h.assignee?.name)
            .sort((a, b) => b.completedAt.localeCompare(a.completedAt));
          if (!done.length) {
            return `Couldn't find a recently completed **${o.chore}** to attach that to.`;
          }
          const target = done[0];
          const person = target.assignee.name;

          const me = await resolveCaller(env, interaction);
          const byUser = me ? (await getUsers(env)).find((u) => u.id === me) : null;

          await flagChoreDetail(env, {
            title: target.title,
            person,
            by: byUser?.name || byUser?.displayName || null,
            note: o.note || null,
          });

          return (
            `🔍 Noted on **${target.title}** for **${person}**.\n` +
            `It stays marked done — they'll just get a reminder to check the checklist ` +
            `the next time it's assigned to them.` +
            (o.note ? `\n_"${o.note}"_` : "")
          );
        },
        { ephemeral: true },
      );
    }
    case "cancel": {
      // Distinct from `done`: clears the chore without recording work.
      return deferAndRun(interaction, ctx, async () => {
        const r = await cancelChore(env, o.chore);
        return r.ok ? `✖️ ${r.message} — not counted as done.` : r.message;
      });
    }
    case "claim": {
      return deferAndRun(interaction, ctx, async () => {
        // The chore lookup and the user list are independent — fetch together.
        const [issue, users] = await Promise.all([pickChore(env, o.chore), getUsers(env)]);
        if (!issue) return `No active chore matching "${o.chore}".`;
        let userId, who;
        if (o.assignee) {
          const u = users.find((x) =>
            [x.displayName, x.name].some((n) => (n || "").toLowerCase().includes(o.assignee.toLowerCase())),
          );
          if (!u) return `No Linear user matching "${o.assignee}".`;
          userId = u.id;
          who = u.name || u.displayName;
        } else {
          userId = await resolveCaller(env, interaction);
          if (!userId) return "Couldn't match you to a Linear user — pass `assignee:` to claim for a named person.";
          who = users.find((x) => x.id === userId)?.name || "you";
        }
        const prev = issue.assignee;
        const res = await assignIssue(env, issue.id, userId);
        if (!res?.success) return "Couldn't assign that chore.";
        // Announce in the due channel rather than wherever this was typed, so
        // it reaches the person who had it regardless of where you ran it.
        const announced = await announceClaim(env, {
          taker: who,
          title: issue.title,
          from: prev?.id && prev.id !== userId ? prev.name : null,
        });
        return `🙋 You claimed **${issue.title}**.${announced ? " Posted in the chores channel." : ""}`;
      }, { ephemeral: true });
    }
    case "unclaim": {
      return deferAndRun(interaction, ctx, async () => {
        const [meId, issue] = await Promise.all([resolveCaller(env, interaction), pickChore(env, o.chore)]);
        if (!meId) return "Couldn't match you to a Linear user.";
        if (!issue) return `No active chore matching "${o.chore}".`;
        if (issue.assignee?.id !== meId)
          return issue.assignee?.name
            ? `**${issue.title}** is assigned to ${issue.assignee.name}, not you.`
            : `**${issue.title}** is already unassigned.`;
        const res = await unassignIssue(env, issue.id);
        if (!res?.success) return "Couldn't unassign that chore.";
        return `🤚 Dropped **${issue.title}** back to the unassigned pool.`;
      });
    }
    case "add": {
      // Validate synchronously so a typo replies instantly, then defer: creating
      // an issue needs several Linear round-trips and used to run inline, which
      // regularly blew past Discord's 3s window and surfaced as "the application
      // did not respond" — often *after* the chore had actually been created.
      if (o.due && !isYmd(o.due)) return reply("`due` must be `YYYY-MM-DD`.");
      const dueDate = o.due || null; // no due date unless one is given
      return deferAndRun(interaction, ctx, async () => {
        // Independent lookups in parallel — one wave instead of three.
        const [teamId, projectId, users] = await Promise.all([
          getTeamId(env, env.CHORES_TEAM || "CHO"),
          getProjectId(env, env.ADHOC_PROJECT || "Ad Hoc"),
          o.assignee ? getUsers(env) : Promise.resolve(null),
        ]);
        if (!teamId) return "Chores team not found.";
        let assigneeId;
        if (o.assignee) {
          const u = (users || []).find((x) =>
            [x.displayName, x.name].some((n) => (n || "").toLowerCase().includes(o.assignee.toLowerCase())),
          );
          if (!u) return `No Linear user matching "${o.assignee}".`;
          assigneeId = u.id;
        }
        const res = await createIssue(env, {
          teamId,
          title: o.title,
          dueDate,
          assigneeId,
          stateId: await getTodoStateId(env, teamId),
          projectId,
        });
        if (!res?.success) return "Couldn't create the chore — Linear rejected it.";
        return `➕ Added **${o.title}**${dueDate ? ` (due ${dueDate})` : ""} to Ad Hoc${assigneeId ? ` for ${o.assignee}` : ""}.`;
      });
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

function choreHelp(recurringUrl) {
  return [
    "**`/chores` — household chore controls**",
    "",
    "__Pause / resume__ (dates are strict `YYYY-MM-DD`)",
    "• `/chores pause user:<name> [from: to:]` — opt one person out; their chores go to the other.",
    "• `/chores pause chore:<name>` — take one chore off-radar (seasonal, e.g. mowing).",
    "• `/chores pause everyone:true [from: to:]` — pause the **whole household** (vacation). `everyone:` is required: it archives the window.",
    "• `/chores resume [user:|chore:]` — clear holds / un-pause (rebalances on return).",
    "",
    "__Day-to-day__",
    "• `/chores done chore:<name>` — mark a chore done.",
    "• `/chores claim chore:<name> [assignee:]` — take ownership (default: you).",
    "• `/chores unclaim chore:<name>` — drop it back to unassigned.",
    "• `/chores snooze chore:<name> [days:N]` — push the due date out (default 1).",
    "• `/chores skip chore:<name>` — skip the current copy; it returns next cycle.",
    "• `/chores add title:<…> [due:] [assignee:]` — add a one-off chore (→ Ad Hoc).",
    "",
    "__Info & tuning__",
    "• `/chores pauses` — what's currently paused (+ recent).",
    "• `/chores weight [user:] [value:] [reset:]` — view/skew the rotation load.",
    "• `/chores calendar` — calendar-subscription links.",
    "• `/chores sync` — re-run generation now (idempotent).",
    "• `/chores reshuffle` — re-rotate upcoming chores so they alternate again.",
    "• `/chores cancel chore:<name>` — drop a chore you're not doing (**not** counted as done).",
    "• `/chores needswork chore:<name> [note:]` — done, but a detail was missed. Reminds whoever did it to check the checklist next time it's theirs. Stays marked done.",
    "• `/chores help` — this message.",
    "",
    // Recurring chores can't be created from Discord by design — this is the
    // one place someone looking for "how do I add a repeating chore?" will
    // land, so point them straight at the project rather than explaining it.
    recurringUrl
      ? `**Adding a repeating chore?** Those are Linear templates, not Discord — [open the Recurring project](${recurringUrl}) for the labels and directives.`
      : "**Adding a repeating chore?** They're defined as **templates** in Linear's _Recurring_ project, not from Discord.",
    "",
    "Names match loosely (partial, case-insensitive). `/tasks`, `/project`, `/unassigned` list issues.",
  ].join("\n");
}

// --- /admin -----------------------------------------------------------------
// The keyed HTTP toolkit, reachable from Discord without looking up a key.
//
// Routes run through `dispatch`, an in-process call into index.js's router
// supplied by the interactions entrypoint. Several handlers (pin-dashboard,
// register-commands, capcheck) are written inline against the Request object,
// so importing them here would be a circular import — and a Worker cannot
// fetch its own hostname either (Cloudflare error 1042), which ruled out the
// obvious HTTP call. Dispatching internally reuses the exact code path the curl
// commands exercise, with no second implementation to drift and no network hop.
// Slash commands are Ed25519-verified and guild-gated, so the key never leaves
// the Worker.
async function callToolkit(dispatch, path) {
  if (typeof dispatch !== "function") return { error: "No internal dispatcher available." };
  const res = await dispatch(path);
  const body = (await res.text()).trim();
  try {
    return { ok: res.ok, status: res.status, json: JSON.parse(body) };
  } catch {
    return { ok: res.ok, status: res.status, text: body };
  }
}

const adminFail = (r) =>
  `⚠️ ${r.error || `Endpoint returned ${r.status}`}${r.text ? ` — ${r.text.slice(0, 180)}` : ""}`;

async function adminCommand(interaction, env, ctx, dispatch) {
  const sub = (interaction.data.options || [])[0];
  const name = sub?.name;
  const o = Object.fromEntries((sub?.options || []).map((x) => [x.name, x.value]));

  return deferAndRun(
    interaction,
    ctx,
    async () => {
      switch (name) {
        case "digest": {
          const r = await callToolkit(dispatch, "/digest");
          if (!r.json) return adminFail(r);
          return r.json.posted
            ? `📣 Digest posted — **${r.json.count}** chore(s) in the window, ${r.json.actionable} actionable today.`
            : "Nothing due — no digest posted.";
        }
        case "recap": {
          const r = await callToolkit(dispatch, "/scoreboard");
          return r.ok ? "📊 Weekly recap posted." : adminFail(r);
        }
        case "dashboard": {
          const r = await callToolkit(dispatch, "/pin-dashboard");
          return r.ok ? "📌 Dashboard link posted and pinned." : adminFail(r);
        }
        case "cron": {
          const r = await callToolkit(dispatch, "/run-cron");
          return r.ok
            ? "⚙️ Daily cron triggered — generation, digest, cap check and archive."
            : adminFail(r);
        }
        case "register": {
          const r = await callToolkit(dispatch, "/register-commands");
          return r.ok ? "🔄 Slash commands re-registered with Discord." : adminFail(r);
        }
        case "botcheck": {
          const r = await callToolkit(dispatch, "/botcheck");
          if (!r.json) return r.ok ? (r.text || "(no output)").slice(0, 600) : adminFail(r);
          // Only the scalar pass/fail bits — the full payload is a wall of JSON.
          const lines = Object.entries(r.json)
            .filter(([, v]) => v === null || typeof v !== "object")
            .map(([k, v]) => `• ${k}: ${v === true ? "✅" : v === false ? "❌" : v}`);
          return `🤖 **Bot check**\n${lines.join("\n").slice(0, 1500)}`;
        }
        case "cap": {
          const r = await callToolkit(dispatch, "/capcheck");
          if (!r.json) return adminFail(r);
          const c = r.json.counted || {};
          const cap = r.json.freePlanCap || 250;
          const proj = Object.entries(r.json.byProject || {})
            .slice(0, 4)
            .map(([n, v]) => `${n} ${v.total}`)
            .join(" · ");
          const filled = Math.max(0, Math.min(20, Math.round(((c.total || 0) / cap) * 20)));
          const bar = "█".repeat(filled) + "░".repeat(20 - filled);
          return (
            `📦 **Linear usage** ${c.total}/${cap}  \`${bar}\`\n` +
            `open ${c.open} · done ${c.completed} · canceled ${c.canceled} · **${cap - (c.total || 0)} free**\n` +
            proj
          );
        }
        case "templates": {
          if (o.chore) {
            const r = await callToolkit(dispatch, `/describe?q=${encodeURIComponent(o.chore)}`);
            if (!r.json) return adminFail(r);
            const t = r.json;
            if (t.error) return `No template matching "${o.chore}".`;
            const owner = t.fixedAssignee
              ? `pinned to ${t.fixedAssignee}`
              : t.assignDays
                ? `assign: ${Object.entries(t.assignDays)
                    .map(([d, w]) => `${d.slice(0, 3)}=${w}`)
                    .join(", ")}`
                : t.opposite
                  ? `opposite of ${t.opposite}`
                  : "rotates";
            return (
              `🔁 **${t.title}**\n${t.schedule}\n` +
              `• owner: ${owner}\n` +
              `• on miss: **${t.onMiss}** ${t.sweptWhenOverdue ? "(wiped)" : "(stays until done)"}\n` +
              `• next: ${(t.next || []).slice(0, 3).join(", ")}`
            );
          }
          const r = await callToolkit(dispatch, "/describe");
          if (!r.json) return adminFail(r);
          const j = r.json;
          const survives = (j.survivesWhenMissed?.chores || []).map((c) => c.title);
          return (
            `🔁 **${j.total} recurring templates**\n` +
            `• ${j.sweptWhenMissed?.count ?? 0} wiped when missed · ${j.survivesWhenMissed?.count ?? 0} stay until done\n` +
            `• stay until done: ${survives.join(", ").slice(0, 900) || "none"}\n` +
            `_Pass_ \`chore:\` _for one template's full config._`
          );
        }
        case "archive": {
          const r = await callToolkit(dispatch, o.confirm ? "/archive" : "/archive?dry=1");
          if (!r.json) return adminFail(r);
          const j = r.json;
          const by = Object.entries(j.byState || {})
            .map(([k, v]) => `${v} ${k}`)
            .join(", ");
          if (!o.confirm) {
            return j.found
              ? `🗄️ **Dry run** — would archive **${j.found}**${by ? ` (${by})` : ""} finished over ${j.retentionDays}d ago.\nRun again with \`confirm:true\`.`
              : `🗄️ Nothing to archive — nothing finished more than ${j.retentionDays} days ago.`;
          }
          return j.archived
            ? `🗄️ Archived **${j.archived}**${by ? ` (${by})` : ""}. Run again if there's a backlog.`
            : "🗄️ Nothing to archive.";
        }
        default:
          return "Unknown admin subcommand.";
      }
    },
    { ephemeral: true },
  );
}
