// linear-discord-bridge — a Cloudflare Worker connecting Linear and Discord.
//
// Two entry points:
//   fetch()      - receives Linear webhooks (real-time) and serves the manual
//                  toolkit endpoints (see README "Manual toolkit").
//   scheduled()  - the daily cron: digest, recurring chores, cap check, and the
//                  Monday scoreboard.

import { verifyLinearSignature } from "./verify.js";
import {
  formatIssueEmbed,
  formatCommentEmbed,
  buildDigestMessage,
  buildCapWarningEmbed,
  buildAllDoneEmbed,
  buildScoreboardEmbed,
  postToDiscord,
} from "./discord.js";
import {
  fetchDueIssues,
  fetchActiveIssueCount,
  anyOpenDueByTeam,
  fetchChoreHistory,
  getTeamId,
} from "./linear.js";
import { runRecurring, forceReplace } from "./recurring.js";
import { computeStats } from "./stats.js";

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

export default {
  // Receives Linear webhooks (real-time issue/comment events).
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

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
    if (url.pathname === "/replace") {
      if (!authed(url, env)) return new Response("Not found", { status: 404 });
      const issue = url.searchParams.get("issue");
      if (!issue) return new Response("missing ?issue=<ID>\n", { status: 400 });
      ctx.waitUntil(forceReplace(env, issue));
      return new Response(`replacing ${issue}\n`, { status: 200 });
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

  // Daily cron: due-date digest + recurring-chore creation.
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
  const today = new Date().toISOString().slice(0, 10);
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
  // 1. Recurring chores FIRST, so the digest below reflects the freshly spawned
  //    tickets and never links to copies that `replace` is about to archive.
  try {
    await runRecurring(env);
  } catch (err) {
    console.error("Recurring chores failed:", err);
  }

  // 2. Due-date digest, split by owner with @-mentions.
  try {
    const issues = await fetchDueIssues(env);
    if (issues.length && env.DISCORD_WEBHOOK_DUE) {
      const today = new Date().toISOString().slice(0, 10);
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
  await postToDiscord(url, { embeds: [buildScoreboardEmbed(computeStats(history, now))] });
}
