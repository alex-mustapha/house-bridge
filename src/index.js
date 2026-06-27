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
  buildAllDoneEmbed,
  buildScoreboardMessage,
  buildStatsEmbed,
  postToDiscord,
} from "./discord.js";
import { logChores, queryStats } from "./db.js";
import {
  fetchDueIssues,
  fetchActiveIssueCount,
  anyOpenDueByTeam,
  fetchChoreHistory,
  getTeamId,
  markChoreDone,
  getUsers,
  fetchAssignedActiveIssues,
} from "./linear.js";
import { runWeek, forceReplace, localDate, annotateTemplates } from "./recurring.js";
import { computeStats } from "./stats.js";
import { verifyDiscordSignature, handleInteraction } from "./interactions.js";
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

// Today's chore status for a person (or the household if no user) — powers the
// phone widget. `remaining` counts active, non-template chores due today/overdue.
async function dayStatus(env, userName) {
  const today = localDate(new Date()).ymd;
  const recurring = env.RECURRING_PROJECT || "Recurring";
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
    const tasks = items.map((i) => i.title);
    return { done: items.length === 0, remaining: items.length, tasks };
  }
  const teamId = await getTeamId(env, env.CHORES_TEAM || "CHO");
  const any = teamId ? await anyOpenDueByTeam(env, teamId, today) : false;
  return { done: !any, remaining: any ? 1 : 0, tasks: [] };
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
      const resp = await handleInteraction(interaction, env);
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
      ctx.waitUntil(annotateTemplates(env));
      return new Response("annotation triggered\n", { status: 200 });
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
        headers: { "Content-Type": "application/json" },
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

  await postToDiscord(webhookUrl, { embeds: [embed] });

  // Celebrate when completing a due chore clears the team's plate for today.
  if (type === "Issue" && action === "update" && data?.state?.type === "completed") {
    await maybeCelebrate(data, env);
  }
}

async function maybeCelebrate(data, env) {
  const today = localDate(new Date()).ymd;
  // Only relevant when the thing just completed was actually due today/earlier.
  if (!data.dueDate || data.dueDate > today || !data.team?.id) return;
  if (await anyOpenDueByTeam(env, data.team.id, today)) return; // still chores left

  const url =
    env.DISCORD_WEBHOOK_DONE || env.DISCORD_WEBHOOK_DUE || env.DISCORD_WEBHOOK_DEFAULT;
  if (url) await postToDiscord(url, { embeds: [buildAllDoneEmbed(data.team?.name)] });
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
    const issues = await fetchDueIssues(env);
    if (issues.length && env.DISCORD_WEBHOOK_DUE) {
      const today = localDate(new Date()).ymd;
      const mentions = parseMentions(env.DISCORD_MENTIONS);
      await postToDiscord(
        env.DISCORD_WEBHOOK_DUE,
        buildDigestMessage(issues, mentions, today),
      );
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
