// linear-discord-bridge — a Cloudflare Worker connecting Linear and Discord.
//
// Two entry points:
//   fetch()      - receives Linear webhooks (real-time) and serves the manual
//                  toolkit endpoints (see README "Manual toolkit").
//   scheduled()  - daily: due-date digest + cap check. On Mondays it also runs
//                  the weekly recap: generate the coming week's chores + post
//                  the per-person scoreboard.

import { verifyLinearSignature } from "./verify.js";
import {
  formatIssueEmbed,
  formatCommentEmbed,
  buildDigestMessage,
  buildCapWarningEmbed,
  buildScoreboardMessage,
  buildStatsEmbed,
  buildDigestMenu,
  postViaBot,
  postToDiscord,
} from "./discord.js";
import { logChores, queryStats, queryDashboard } from "./db.js";
import {
  fetchDueIssues,
  fetchActiveIssueCount,
  anyOpenDueByTeam,
  fetchChoreHistory,
  getTeamId,
  markChoreDone,
  getUsers,
  fetchAssignedActiveIssues,
  fetchRecentCompletedAssigned,
  fetchAssignedDueInWindow,
  getLabelNameMap,
  fetchCompletedBefore,
  archiveIssue,
  fetchUnassignedActive,
  deleteComment,
  fetchRecurringTemplates,
  fetchChoresForCalendar,
} from "./linear.js";
import { runWeek, forceReplace, localDate, annotateTemplates, describeTemplate, parseDuration } from "./recurring.js";
import { computeStats } from "./stats.js";
import { verifyDiscordSignature, handleInteraction } from "./interactions.js";
import { renderWidgetPage } from "./widgetpage.js";
import { COMMANDS } from "./commands.js";
import { renderDashboardPage } from "./dashboardpage.js";
import { buildICS } from "./calendar.js";
import { verifyAlexaRequest, handleAlexa } from "./alexa.js";

// Parse DISCORD_MENTIONS ("Alex:123,Kristal:456") into { alex: "123", ... }.
function parseMentions(spec) {
  const map = {};
  if (!spec) return map;
  for (const pair of spec.split(",")) {
    const [k, v] = pair.split(":").map((s) => s.trim());
    if (k && v) map[k.toLowerCase()] = v;
  }
  return map;
}

// Guard for the manual toolkit endpoints: requires ?key=<CRON_KEY>.
function authed(url, env) {
  return Boolean(env.CRON_KEY) && url.searchParams.get("key") === env.CRON_KEY;
}

// Shift an Eastern calendar date string (YYYY-MM-DD) back by n days.
function ymdMinus(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}

// Consecutive-day streak: walking back from `today`, count days where every
// chore due that day is completed. Days with no chores bridge the streak (don't
// count, don't break). Today not-yet-finished doesn't break it; a missed past
// day does.
function computeStreak(issues, today, recurringName) {
  const byDay = new Map();
  for (const i of issues) {
    if (!i.dueDate || i.project?.name === recurringName) continue;
    const e = byDay.get(i.dueDate) || { total: 0, done: 0 };
    e.total++;
    if (i.state?.type === "completed") e.done++;
    byDay.set(i.dueDate, e);
  }
  let streak = 0;
  for (let d = 0; d < 60; d++) {
    const e = byDay.get(ymdMinus(today, d));
    if (!e || e.total === 0) continue; // no chores that day — bridge
    if (e.done === e.total) { streak++; continue; } // cleared the day
    if (d === 0) continue; // today still in progress — don't break
    break; // a past day was missed
  }
  return streak;
}

// Unassigned, non-template chores due within UNASSIGNED_LOOKAHEAD_DAYS (default
// 7) — surfaced to both people so they can claim things before they're due.
async function unassignedDueSoon(env) {
  const recurring = env.RECURRING_PROJECT || "Recurring";
  const days = parseInt(env.UNASSIGNED_LOOKAHEAD_DAYS || "7", 10);
  const until = localDate(new Date(Date.now() + days * 86_400_000)).ymd;
  return (await fetchUnassignedActive(env))
    .filter((i) => i.project?.name !== recurring && i.dueDate && i.dueDate <= until)
    .sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""))
    .map((i) => ({ title: i.title, url: i.url, dueDate: i.dueDate, id: i.id, teamId: i.team?.id }));
}

// Today's chore status for a person (or the household if no user) — powers the
// phone widget. `remaining` counts active, non-template chores due today/overdue.
async function dayStatus(env, userName) {
  const today = localDate(new Date()).ymd;
  const recurring = env.RECURRING_PROJECT || "Recurring";
  const unassignedSoon = await unassignedDueSoon(env);
  if (userName) {
    const u = (await getUsers(env)).find((x) =>
      [x.displayName, x.name].some(
        (n) =>
          (n || "").toLowerCase() === userName.toLowerCase() ||
          (n || "").toLowerCase().includes(userName.toLowerCase()),
      ),
    );
    if (!u) return { error: "user not found" };
    const items = (await fetchAssignedActiveIssues(env, u.id)).filter(
      (i) => i.project?.name !== recurring && i.dueDate && i.dueDate <= today,
    );
    // Soonest-due first so the widget's short list shows the most pressing.
    items.sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""));
    const tasks = items.map((i) => ({ title: i.title, url: i.url }));
    // What they finished today (Eastern completion date), most recent first.
    const completed = (await fetchRecentCompletedAssigned(env, u.id))
      .filter(
        (i) =>
          i.project?.name !== recurring &&
          i.completedAt &&
          localDate(new Date(i.completedAt)).ymd === today,
      )
      .sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || ""))
      .map((i) => ({ title: i.title, url: i.url }));
    const windowIssues = await fetchAssignedDueInWindow(env, u.id, ymdMinus(today, 59), today);
    const streak = computeStreak(windowIssues, today, recurring);
    return { done: items.length === 0, remaining: items.length, tasks, completed, streak, unassignedSoon };
  }
  const teamId = await getTeamId(env, env.CHORES_TEAM || "CHO");
  const any = teamId ? await anyOpenDueByTeam(env, teamId, today) : false;
  return { done: !any, remaining: any ? 1 : 0, tasks: [], completed: [], streak: 0, unassignedSoon };
}


export default {
  // Receives Linear webhooks (real-time issue/comment events).
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Discord slash-command interactions (signed POST from Discord).
    if (url.pathname === "/interactions" && request.method === "POST") {
      const sig = request.headers.get("x-signature-ed25519");
      const ts = request.headers.get("x-signature-timestamp");
      const body = await request.text();
      if (!(await verifyDiscordSignature(env.DISCORD_PUBLIC_KEY, sig, ts, body))) {
        return new Response("invalid request signature", { status: 401 });
      }
      let interaction;
      try {
        interaction = JSON.parse(body);
      } catch {
        return new Response("bad json", { status: 400 });
      }
      const resp = await handleInteraction(interaction, env, ctx);
      return new Response(JSON.stringify(resp), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Alexa custom-skill requests (signed POST from Alexa).
    if (url.pathname === "/alexa" && request.method === "POST") {
      let payload;
      try {
        payload = JSON.parse(await request.text());
      } catch {
        return new Response("bad json", { status: 400 });
      }
      if (!verifyAlexaRequest(payload, env)) {
        return new Response("unauthorized", { status: 401 });
      }
      const resp = await handleAlexa(payload, env);
      return new Response(JSON.stringify(resp), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Manual toolkit (all require ?key=<CRON_KEY>; 404 otherwise). See README.
    if (url.pathname === "/run-cron") {
      if (!authed(url, env)) return new Response("Not found", { status: 404 });
      ctx.waitUntil(handleCron(env));
      return new Response("cron triggered\n", { status: 200 });
    }
    if (url.pathname === "/scoreboard") {
      if (!authed(url, env)) return new Response("Not found", { status: 404 });
      ctx.waitUntil(postScoreboard(env, true));
      return new Response("scoreboard triggered\n", { status: 200 });
    }
    if (url.pathname === "/stats") {
      if (!authed(url, env)) return new Response("Not found", { status: 404 });
      const days = parseInt(url.searchParams.get("days") || "90", 10);
      try {
        await logChores(env); // refresh the log so the report is current
      } catch (err) {
        console.error("D1 logging failed:", err);
      }
      const stats = await queryStats(env, days);
      if (!stats) return new Response("D1 not configured\n", { status: 200 });
      const target =
        env.DISCORD_WEBHOOK_STATS || env.DISCORD_WEBHOOK_DUE || env.DISCORD_WEBHOOK_DEFAULT;
      if (target) await postToDiscord(target, { embeds: [buildStatsEmbed(stats)] });
      return new Response("stats posted\n", { status: 200 });
    }
    if (url.pathname === "/replace") {
      if (!authed(url, env)) return new Response("Not found", { status: 404 });
      const issue = url.searchParams.get("issue");
      if (!issue) return new Response("missing ?issue=<ID>\n", { status: 400 });
      ctx.waitUntil(forceReplace(env, issue));
      return new Response(`replacing ${issue}\n`, { status: 200 });
    }
    if (url.pathname === "/run-week") {
      if (!authed(url, env)) return new Response("Not found", { status: 404 });
      ctx.waitUntil(runWeek(env));
      return new Response("week generation triggered\n", { status: 200 });
    }
    if (url.pathname === "/annotate") {
      if (!authed(url, env)) return new Response("Not found", { status: 404 });
      try {
        const report = await annotateTemplates(env);
        return new Response(JSON.stringify(report, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(`annotate error: ${e?.stack || e?.message || e}\n`, { status: 500 });
      }
    }
    if (url.pathname === "/archive") {
      if (!authed(url, env)) return new Response("Not found", { status: 404 });
      ctx.waitUntil(archiveOldChores(env));
      return new Response("archive triggered (run repeatedly to clear a backlog)\n", { status: 200 });
    }
    if (url.pathname === "/botcheck") {
      if (!authed(url, env)) return new Response("Not found", { status: 404 });
      return new Response(JSON.stringify(await botCheck(env), null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/register-commands") {
      if (!authed(url, env)) return new Response("Not found", { status: 404 });
      if (!env.DISCORD_BOT_TOKEN) return new Response("DISCORD_BOT_TOKEN not set\n", { status: 400 });
      const auth = { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` };
      try {
        const me = await fetch("https://discord.com/api/v10/users/@me", { headers: auth });
        if (!me.ok) return new Response(`bot token rejected: ${me.status}\n`, { status: 401 });
        const appId = (await me.json()).id;
        // Guild: ?guild=, else env, else auto-detect if the bot is in exactly one.
        let guild = url.searchParams.get("guild") || env.DISCORD_GUILD_ID;
        if (!guild) {
          const g = await fetch("https://discord.com/api/v10/users/@me/guilds", { headers: auth });
          const guilds = g.ok ? await g.json() : [];
          if (guilds.length === 1) guild = guilds[0].id;
          else return new Response(`Pass ?guild=<serverId> — bot is in ${guilds.length} servers.\n`, { status: 400 });
        }
        const res = await fetch(
          `https://discord.com/api/v10/applications/${appId}/guilds/${guild}/commands`,
          { method: "PUT", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(COMMANDS) },
        );
        const txt = await res.text();
        return new Response(`status ${res.status} (guild ${guild})\n${txt.slice(0, 1500)}\n`, {
          status: res.ok ? 200 : res.status,
        });
      } catch (e) {
        return new Response(`register error: ${e?.message || e}\n`, { status: 500 });
      }
    }
    if (url.pathname === "/pin-dashboard") {
      if (!authed(url, env)) return new Response("Not found", { status: 404 });
      if (!env.DISCORD_BOT_TOKEN) return new Response("DISCORD_BOT_TOKEN not set\n", { status: 400 });
      const auth = { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` };
      try {
        let guild = url.searchParams.get("guild") || env.DISCORD_GUILD_ID;
        if (!guild) {
          const g = await fetch("https://discord.com/api/v10/users/@me/guilds", { headers: auth });
          const guilds = g.ok ? await g.json() : [];
          if (guilds.length === 1) guild = guilds[0].id;
          else return new Response(`Pass ?guild=<serverId> (bot in ${guilds.length} servers).\n`, { status: 400 });
        }
        const chName = (url.searchParams.get("channel") || "recap").toLowerCase();
        const chRes = await fetch(`https://discord.com/api/v10/guilds/${guild}/channels`, { headers: auth });
        if (!chRes.ok) return new Response(`channels lookup: ${chRes.status}\n`, { status: chRes.status });
        const ch = (await chRes.json()).find((c) => c.type === 0 && (c.name || "").toLowerCase() === chName);
        if (!ch) return new Response(`No #${chName} text channel found.\n`, { status: 404 });
        const dashUrl = `${url.origin}/dashboard`;
        const postRes = await fetch(`https://discord.com/api/v10/channels/${ch.id}/messages`, {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `📊 **Chore stats dashboard** — live completion %, per-person breakdown, trend, and streaks.\n${dashUrl}`,
          }),
        });
        if (!postRes.ok) return new Response(`post failed: ${postRes.status} ${(await postRes.text()).slice(0, 200)}\n`, { status: postRes.status });
        const msg = await postRes.json();
        const pinRes = await fetch(`https://discord.com/api/v10/channels/${ch.id}/pins/${msg.id}`, { method: "PUT", headers: auth });
        return new Response(
          JSON.stringify({ posted: true, channel: ch.name, pinned: pinRes.ok, pinStatus: pinRes.status, url: dashUrl }, null, 2),
          { headers: { "Content-Type": "application/json" } },
        );
      } catch (e) {
        return new Response(`pin error: ${e?.message || e}\n`, { status: 500 });
      }
    }
    if (url.pathname === "/delcomment") {
      if (!authed(url, env)) return new Response("Not found", { status: 404 });
      const id = url.searchParams.get("id");
      if (!id) return new Response("missing ?id=<commentId>\n", { status: 400 });
      try {
        const r = await deleteComment(env, id);
        return new Response(JSON.stringify(r) + "\n", { status: 200 });
      } catch (e) {
        return new Response(`delete error: ${e?.message || e}\n`, { status: 500 });
      }
    }
    if (url.pathname === "/describe") {
      if (!authed(url, env)) return new Response("Not found", { status: 404 });
      const q = url.searchParams.get("q") || "";
      return new Response(JSON.stringify(await describeTemplate(env, q), null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/done") {
      if (!authed(url, env)) return new Response("Not found", { status: 404 });
      const match = url.searchParams.get("match");
      if (!match) return new Response("missing ?match=<text>\n", { status: 400 });
      const { message } = await markChoreDone(env, match);
      return new Response(message + "\n", { status: 200 });
    }
    if (url.pathname === "/status") {
      // Read-only, non-sensitive (just done/remaining counts) — left unguarded
      // so the phone widget needs no secret. All mutating endpoints stay keyed.
      const status = await dayStatus(env, url.searchParams.get("user") || "");
      return new Response(JSON.stringify(status), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
    if (url.pathname === "/widget") {
      // Styled HTML status page (Android-friendly "Add to Home screen" target).
      const user = url.searchParams.get("user") || "";
      const status = await dayStatus(env, user);
      return new Response(renderWidgetPage(user, status), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    if (url.pathname === "/dashboard") {
      // Keyless stats dashboard (chore names + counts only). Refresh the D1
      // snapshot first so the page is current, then aggregate + render.
      try {
        await logChores(env);
      } catch (e) {
        console.error("dashboard log refresh failed:", e);
      }
      const templates = await fetchRecurringTemplates(env, env.RECURRING_PROJECT || "Recurring");
      const estMap = {};
      for (const t of templates) {
        const m = (t.description || "").match(/^\s*estimate\s*:\s*(.+)$/im);
        const mins = m ? parseDuration(m[1]) : undefined;
        if (mins) estMap[(t.title || "").toLowerCase()] = mins;
      }
      const allowed = [7, 30, 90, 365];
      let range = parseInt(url.searchParams.get("range") || "30", 10);
      if (!allowed.includes(range)) range = 30;
      const data = await queryDashboard(env, (title) => estMap[(title || "").toLowerCase()] ?? 15, range);
      if (!data) return new Response("D1 not configured\n", { status: 200 });
      return new Response(renderDashboardPage(data, range), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    if (url.pathname.startsWith("/cal/") && url.pathname.endsWith(".ics")) {
      // Keyless ICS feed (chore titles + due dates only). Subscribe by URL:
      //   /cal/alex.ics, /cal/kristal.ics, /cal/unassigned.ics
      const who = url.pathname.slice(5, -4).toLowerCase();
      let chores;
      let calName;
      if (who === "unassigned") {
        chores = await fetchChoresForCalendar(env, { unassigned: true });
        calName = "Chores — Unassigned";
      } else {
        const user = (await getUsers(env)).find((u) =>
          [u.name, u.displayName].some((n) => (n || "").toLowerCase().includes(who)),
        );
        if (!user) return new Response("Unknown calendar\n", { status: 404 });
        chores = await fetchChoresForCalendar(env, { assigneeId: user.id });
        calName = `Chores — ${user.name}`;
      }
      return new Response(buildICS(calName, chores), {
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Disposition": `inline; filename="${who}.ics"`,
        },
      });
    }

    if (request.method === "GET") {
      return new Response("linear-discord-bridge ok\n", { status: 200 });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const raw = await request.text();
    const signature = request.headers.get("linear-signature");

    if (
      !signature ||
      !(await verifyLinearSignature(raw, signature, env.LINEAR_WEBHOOK_SECRET))
    ) {
      return new Response("Invalid signature", { status: 401 });
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }

    // Replay protection: reject events older than 60s.
    if (
      payload.webhookTimestamp &&
      Date.now() - payload.webhookTimestamp > 60_000
    ) {
      return new Response("Stale webhook", { status: 400 });
    }

    // Ack immediately; do the Discord post in the background so Linear
    // doesn't time out and retry.
    ctx.waitUntil(handleEvent(payload, env));
    return new Response("ok", { status: 200 });
  },

  // Daily: digest + cap. Mondays also generate the week + post the scoreboard.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCron(env));
  },
};

// Does the webhook issue carry a label named `name`? Prefer the payload's label
// objects; fall back to resolving labelIds against the workspace label map.
async function hasLabel(env, data, name) {
  const want = name.toLowerCase();
  if (Array.isArray(data?.labels) && data.labels.length) {
    return data.labels.some((l) => (l?.name || "").toLowerCase() === want);
  }
  if (Array.isArray(data?.labelIds) && data.labelIds.length) {
    const map = await getLabelNameMap(env);
    return data.labelIds.some((id) => (map[id] || "").toLowerCase() === want);
  }
  return false;
}

async function handleEvent(payload, env) {
  const { type, action, data } = payload;

  // Don't echo template tickets (they live in the Recurring project) to Discord.
  const recurringProject = env.RECURRING_PROJECT || "Recurring";
  if (data?.project?.name === recurringProject) return;

  let embed = null;

  if (type === "Issue") {
    embed = formatIssueEmbed(payload);
  } else if (type === "Comment" && action === "create") {
    embed = formatCommentEmbed(payload);
  }
  if (!embed) return;

  const teamKey = data?.team?.key || data?.issue?.team?.key;
  const webhookUrl = resolveWebhook(teamKey, env);
  if (!webhookUrl) {
    console.warn(`No Discord webhook for team "${teamKey}" and no default set.`);
    return;
  }

  // `silent`-labeled chores are generated/updated without echoing to Discord
  // (still counted everywhere).
  if (type === "Issue" && (await hasLabel(env, data, "silent"))) return;

  await postToDiscord(webhookUrl, { embeds: [embed] });
}

function resolveWebhook(teamKey, env) {
  if (teamKey && env[`DISCORD_WEBHOOK_${teamKey}`]) {
    return env[`DISCORD_WEBHOOK_${teamKey}`];
  }
  return env.DISCORD_WEBHOOK_DEFAULT || null;
}

async function handleCron(env) {
  const isMonday = localDate(new Date()).weekday === 1;

  // 1. Weekly recap (Mondays only): establish the coming week's chores up front,
  //    before the digest so it reflects them. Not part of the daily cadence.
  if (isMonday) {
    try {
      await runWeek(env);
    } catch (err) {
      console.error("Weekly generation failed:", err);
    }
  }

  // 2. Due-date digest, split by owner with @-mentions.
  try {
    const today = localDate(new Date()).ymd;
    const issues = await fetchDueIssues(env);
    // Unassigned due later this week (today/overdue ones already show above).
    const soon = (await unassignedDueSoon(env)).filter((i) => i.dueDate > today);
    if (issues.length || soon.length) {
      const mentions = parseMentions(env.DISCORD_MENTIONS);
      const msg = buildDigestMessage(issues, mentions, today, soon);
      // Bot-posted digest carries "✓ Done" buttons; falls back to the webhook
      // (no buttons) if the bot token / channel id aren't configured.
      if (env.DISCORD_BOT_TOKEN && env.DISCORD_DUE_CHANNEL_ID) {
        await postViaBot(env, env.DISCORD_DUE_CHANNEL_ID, {
          ...msg,
          components: buildDigestMenu(issues, soon),
        });
      } else if (env.DISCORD_WEBHOOK_DUE) {
        await postToDiscord(env.DISCORD_WEBHOOK_DUE, msg);
      }
    }
  } catch (err) {
    console.error("Digest failed:", err);
  }

  // 3. Free-plan cap warning.
  try {
    const warnAt = parseInt(env.CAP_WARN_AT || "220", 10);
    const { count } = await fetchActiveIssueCount(env);
    if (count >= warnAt && env.DISCORD_WEBHOOK_ADMIN) {
      await postToDiscord(env.DISCORD_WEBHOOK_ADMIN, {
        embeds: [buildCapWarningEmbed(count)],
      });
    }
  } catch (err) {
    console.error("Cap check failed:", err);
  }

  // 4. Weekly scoreboard (Mondays only).
  try {
    await postScoreboard(env, false);
  } catch (err) {
    console.error("Scoreboard failed:", err);
  }

  // 5. Snapshot the week's outcomes to D1 for long-term analytics (Mondays).
  if (isMonday) {
    try {
      await logChores(env);
    } catch (err) {
      console.error("D1 logging failed:", err);
    }
  }

  // 6. Refresh template schedule comments (Sundays — keeps "next" dates current
  //    without colliding with Monday's heavier generation run).
  if (localDate(new Date()).weekday === 0) {
    try {
      await annotateTemplates(env);
    } catch (err) {
      console.error("Annotate failed:", err);
    }
  }

  // 7. Auto-archive long-completed chores so the active-issue count stays under
  //    Linear's free-tier cap. Skip Mondays (Monday's run is already heavy) to
  //    stay under the per-invocation subrequest limit; runs the other 6 days.
  if (!isMonday) {
    try {
      await archiveOldChores(env);
    } catch (err) {
      console.error("Auto-archive failed:", err);
    }
  }
}

// Archive chores completed more than CHORE_RETENTION_DAYS ago (default 30), up
// to ARCHIVE_MAX per run (default 30) to respect the subrequest cap. Archived
// issues no longer count toward the free-tier active-issue limit.
// Diagnostic for the digest-buttons setup: is the bot token valid, and can the
// bot post to the configured channel? Posts a small test message on success.
async function botCheck(env) {
  const out = {
    hasToken: !!env.DISCORD_BOT_TOKEN,
    channelId: env.DISCORD_DUE_CHANNEL_ID || null,
  };
  if (!env.DISCORD_BOT_TOKEN) {
    out.error = "DISCORD_BOT_TOKEN is not set";
    return out;
  }
  const me = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
  });
  out.tokenValid = me.ok;
  if (me.ok) {
    const u = await me.json();
    out.botUser = u.username;
    out.botId = u.id;
  } else {
    out.tokenError = `${me.status} ${(await me.text()).slice(0, 200)}`;
    return out;
  }
  if (!env.DISCORD_DUE_CHANNEL_ID) {
    out.note = "Token is valid, but DISCORD_DUE_CHANNEL_ID isn't set — no channel to post to yet.";
    return out;
  }
  const post = await fetch(
    `https://discord.com/api/v10/channels/${env.DISCORD_DUE_CHANNEL_ID}/messages`,
    {
      method: "POST",
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "✅ chore-bot connectivity check — safe to ignore." }),
    },
  );
  out.canPostToChannel = post.ok;
  if (!post.ok) out.postError = `${post.status} ${(await post.text()).slice(0, 200)}`;
  return out;
}

async function archiveOldChores(env) {
  const days = parseInt(env.CHORE_RETENTION_DAYS || "30", 10);
  const max = parseInt(env.ARCHIVE_MAX || "30", 10);
  const before = new Date(Date.now() - days * 86_400_000).toISOString();
  const project = env.CHORES_PROJECT || "House Chores";
  const old = await fetchCompletedBefore(env, project, before, max);
  let n = 0;
  for (const i of old) {
    const r = await archiveIssue(env, i.id);
    if (r?.success) n++;
  }
  if (n) console.log(`Auto-archived ${n} chore(s) completed >${days}d ago.`);
  return n;
}

// Posts the weekly scoreboard. On the cron it only runs Mondays; `force` (the
// /scoreboard endpoint) runs it any day.
async function postScoreboard(env, force) {
  const now = new Date();
  if (!force && now.getUTCDay() !== 1) return;
  const teamId = await getTeamId(env, env.CHORES_TEAM || "CHO");
  const url =
    env.DISCORD_WEBHOOK_STATS || env.DISCORD_WEBHOOK_DUE || env.DISCORD_WEBHOOK_DEFAULT;
  if (!teamId || !url) return;
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  const history = await fetchChoreHistory(env, teamId, since);
  await postToDiscord(url, buildScoreboardMessage(computeStats(history, now)));
}
