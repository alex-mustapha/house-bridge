// linear-discord-bridge — a Cloudflare Worker connecting Linear and Discord.
//
// Two entry points:
//   fetch()      - receives Linear webhooks (real-time) and serves the manual
//                  toolkit endpoints (see README "Manual toolkit").
//   scheduled()  - daily: due-date digest + cap check. On Mondays it also runs
//                  the weekly recap: generate the coming week's chores + post
//                  the per-person scoreboard.

import { verifyLinearSignature } from "./verify.js";
import { choreProjects, choresTeam, recurringProject } from "./config.js";
import {
  formatIssueEmbed,
  buildDigestMessage,
  buildCapWarningEmbed,
  buildScoreboardMessage,
  buildStatsEmbed,
  buildDigestMenu,
  buildAllClearMessage,
  digestBytes,
  fitDigestPayload,
  DIGEST_BUDGET_BYTES,
  postViaBot,
  editViaBot,
  postToDiscord,
} from "./discord.js";
import { logChores, queryStats, queryDashboard, queryLeisure } from "./db.js";
import { saveDigestMessage, getDigestMessage, clearDigestMessage } from "./db.js";
import {
  fetchDueIssues,
  fetchActiveIssueCount,
  fetchActiveBreakdown,
  anyOpenDueByTeam,
  fetchChoreHistory,
  fetchRecentCompleted,
  getTeamId,
  markChoreDone,
  cancelChore,
  snoozeChore,
  unarchiveIssue,
  markClaimed,
  markSnoozed,
  fetchUndatedActive,
  findActiveByTitle,
  assignIssue,
  getUsers,
  fetchAssignedActiveIssues,
  fetchRecentCompletedAssigned,
  fetchAssignedDueInWindow,
  getLabelNameMap,
  fetchArchivableBefore,
  archiveIssue,
  fetchUnassignedActive,
  deleteComment,
  fetchRecurringTemplates,
  fetchChoresForCalendar,
} from "./linear.js";
import { frequentChoreTitles, runWeek, forceReplace, localDate, annotateTemplates, describeTemplate, describeAllTemplates, parseDuration, processExpiredPauses, choreCost } from "./recurring.js";
import { computeStats } from "./stats.js";
import { byDayFromIssues, choreStreak, STREAK_WINDOW_DAYS } from "./streak.js";
import { verifyDiscordSignature, handleInteraction } from "./interactions.js";
import { renderWidgetPage } from "./widgetpage.js";
import { recordLeisure, autoLogLeisure } from "./leisure.js";
import { choreMarks } from "./marks.js";

// The end-of-day leisure backstop runs on its own schedule; everything else
// is the morning run. Keep in sync with `crons` in wrangler.toml.
const LEISURE_CRON = "0 2 * * *";
import { COMMANDS } from "./commands.js";
import { renderDashboardPage } from "./dashboardpage.js";
import { buildICS } from "./calendar.js";

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

// Per-user streak for the widget / `/status`. Definition lives in ./streak.js.
function computeStreak(issues, today, recurringName) {
  // Shared definition — see ./streak.js. This used to walk 60 days, count today,
  // and treat a cancelled chore as a broken day, none of which matched the
  // recap or the dashboard.
  const byDay = byDayFromIssues(
    issues.filter((i) => i.project?.name !== recurringName),
  ).all;
  return choreStreak(byDay || {}, today);
}

// Unassigned, non-template chores due within UNASSIGNED_LOOKAHEAD_DAYS (default
// 7) — surfaced to both people so they can claim things before they're due.
async function unassignedDueSoon(env) {
  const recurring = recurringProject(env);
  const days = parseInt(env.UNASSIGNED_LOOKAHEAD_DAYS || "7", 10);
  const until = localDate(new Date(Date.now() + days * 86_400_000)).ymd;
  return (await fetchUnassignedActive(env))
    .filter((i) => i.project?.name !== recurring && i.dueDate && i.dueDate <= until)
    .sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""))
    .map((i) => ({ title: i.title, url: i.url, dueDate: i.dueDate, id: i.id, teamId: i.team?.id }));
}

// The "Anytime" pool: open work carrying no due date, oldest first. Ranked by
// age alone — deliberately no priority field to maintain, since the whole point
// of this system is that scheduling lives in labels and directives rather than
// in hand-tended Linear metadata.
async function anytimePool(env, limit = 2) {
  const recurring = recurringProject(env);
  const today = localDate(new Date()).ymd;
  const [ty, tm, td] = today.split("-").map(Number);
  const rows = (await fetchUndatedActive(env, 50).catch((e) => {
    console.error("anytime pool lookup failed:", e.message);
    return [];
  })).filter((i) => i.project?.name !== recurring);
  return rows.slice(0, limit).map((i) => {
    const c = i.createdAt ? new Date(i.createdAt) : null;
    const ageDays = c
      ? Math.max(
          0,
          Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), c.getUTCDate())) / 86_400_000),
        )
      : null;
    return {
      title: i.title,
      url: i.url,
      project: i.project?.name || null,
      assignee: i.assignee?.name || null,
      ageDays,
    };
  });
}

// Today's chore status for a person (or the household if no user) — powers the
// phone widget. `remaining` counts active, non-template chores due today/overdue.
async function dayStatus(env, userName) {
  const today = localDate(new Date()).ymd;
  const recurring = recurringProject(env);
  const unassignedSoon = await unassignedDueSoon(env);
  if (userName) {
    const users = await getUsers(env);
    const u = users.find((x) =>
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
    // `steps` powers the widget's expandable checklist: the chore's own copied
    // description, minus the trailing template backlink the generator appends
    // (useful in Linear, noise on a phone).
    const steps = (d) =>
      (d || "")
        .split(/\r?\n/)
        .filter((l) => !/^\s*—\s*\[recurring template/.test(l))
        .join("\n")
        .trim() || null;
    const tasks = items.map((i) => ({ title: i.title, url: i.url, steps: steps(i.description) }));
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
    // Only as far back as the streak actually walks — now that archived issues
    // are included, a 60-day window risks the 250-node cap.
    const windowIssues = await fetchAssignedDueInWindow(
      env, u.id, ymdMinus(today, STREAK_WINDOW_DAYS + 1), today,
    );
    const streak = computeStreak(windowIssues, today, recurring);

    // Everyone else's outstanding work, so the widget can answer "is there
    // anything I could take off their plate?" rather than only showing your own
    // list and going quiet the moment you're clear.
    const others = [];
    for (const raw of (env.ROTATION_MEMBERS || "").split(",").map((s) => s.trim()).filter(Boolean)) {
      const other = users.find((x) =>
        [x.displayName, x.name].some((n) => (n || "").toLowerCase().includes(raw.toLowerCase())),
      );
      if (!other || other.id === u.id) continue;
      const theirs = (await fetchAssignedActiveIssues(env, other.id))
        .filter((i) => i.project?.name !== recurring && i.dueDate && i.dueDate <= today)
        .sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""))
        .map((i) => ({ title: i.title, url: i.url, dueDate: i.dueDate }));
      if (theirs.length) others.push({ name: other.name || other.displayName, tasks: theirs });
    }

    return {
      done: items.length === 0,
      remaining: items.length,
      tasks,
      completed,
      streak,
      unassignedSoon,
      others,
      anytime: await anytimePool(env, 2),
    };
  }
  const teamId = await getTeamId(env, choresTeam(env));
  const any = teamId ? await anyOpenDueByTeam(env, teamId, today) : false;
  return { done: !any, remaining: any ? 1 : 0, tasks: [], completed: [], streak: 0, unassignedSoon };
}


// Every HTTP route: Linear webhooks, Discord interactions, the keyed toolkit
// and the public pages. Named rather than inline in the default export so
// /admin can dispatch to it IN-PROCESS. A Worker cannot fetch its own hostname
// — Cloudflare rejects that with error 1042 — so the toolkit endpoints are
// unreachable over HTTP from inside the Worker, and an internal call is the
// only way to reuse them without duplicating the route logic.
async function handleRequest(request, env, ctx) {
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
      // In-process dispatcher for /admin: builds a keyed Request and runs it
      // through this same router, so the slash command and the curl command
      // exercise identical code with no network hop.
      const dispatch = (path) => {
        const sep = path.includes("?") ? "&" : "?";
        const u = `${url.origin}${path}${sep}key=${encodeURIComponent(env.CRON_KEY || "")}`;
        return handleRequest(new Request(u), env, ctx);
      };
      const resp = await handleInteraction(interaction, env, ctx, dispatch);
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
    if (url.pathname === "/capcheck") {
      if (!authed(url, env)) return new Response("Not found", { status: 404 });
      // Where the free-plan cap is going, and which lever to pull: future
      // chores (GEN_HORIZON_DAYS), completed-but-unarchived ones
      // (CHORE_RETENTION_DAYS), or work that isn't chores at all.
      const { rows, capped } = await fetchActiveBreakdown(env);
      const today = localDate(new Date()).ymd;
      const b = { total: rows.length, open: 0, completed: 0, canceled: 0, future: 0, pastDue: 0, undated: 0 };
      const byProject = {};
      const futureByWeek = {};
      for (const r of rows) {
        const t = r.state?.type;
        const proj = r.project?.name || "(no project)";
        (byProject[proj] ||= { total: 0, open: 0, completed: 0 }).total++;
        if (t === "completed") { b.completed++; byProject[proj].completed++; }
        else if (t === "canceled") b.canceled++;
        else {
          b.open++;
          byProject[proj].open++;
          if (!r.dueDate) b.undated++;
          else if (r.dueDate > today) {
            b.future++;
            const wk = Math.floor(
              (Date.UTC(...r.dueDate.split("-").map((n, i) => (i === 1 ? +n - 1 : +n))) -
                Date.UTC(...today.split("-").map((n, i) => (i === 1 ? +n - 1 : +n)))) /
                86_400_000 / 7,
            );
            futureByWeek[`+${wk}w`] = (futureByWeek[`+${wk}w`] || 0) + 1;
          } else if (r.dueDate < today) b.pastDue++;
        }
      }
      return new Response(
        JSON.stringify(
          {
            capWarnAt: parseInt(env.CAP_WARN_AT || "220", 10),
            freePlanCap: 250,
            counted: b,
            truncated: capped,
            levers: {
              GEN_HORIZON_DAYS: env.GEN_HORIZON_DAYS || "7 (default)",
              CHORE_RETENTION_DAYS: env.CHORE_RETENTION_DAYS || "30 (default)",
              ARCHIVE_MAX: env.ARCHIVE_MAX || "30 (default)",
            },
            futureOpenByWeek: futureByWeek,
            byProject: Object.fromEntries(
              Object.entries(byProject).sort((x, y) => y[1].total - x[1].total),
            ),
          },
          null,
          2,
        ),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.pathname === "/digest") {
      if (!authed(url, env)) return new Response("Not found", { status: 404 });
      // Just reposts today's chore list. Unlike /run-cron it does no generation,
      // no sweep, no archiving — nothing but the Discord post.
      // `&dry=1` returns the exact payload instead of posting it, with the
      // Discord limits that matter alongside it. There was no way to see what
      // Discord was actually being sent, which is what made a silent rejection
      // hard to diagnose.
      if (url.searchParams.get("dry")) {
        const built = await buildDigestPayload(env);
        if (!built) return new Response("null" + "\n", { status: 200 });
        const rows = (built.withMenu?.components || []).map((r) => {
          const c = r.components?.[0] || {};
          const opts = c.options || [];
          return {
            custom_id: c.custom_id,
            options: opts.length,
            min_values: c.min_values,
            max_values: c.max_values,
            dupValues: opts.length - new Set(opts.map((o) => o.value)).size,
            longestLabel: opts.reduce((m, o) => Math.max(m, (o.label || "").length), 0),
            longestDesc: opts.reduce((m, o) => Math.max(m, (o.description || "").length), 0),
            longestValue: opts.reduce((m, o) => Math.max(m, (o.value || "").length), 0),
          };
        });
        const report = {
          empty: built.empty,
          counts: { count: built.count, shown: built.shown, actionable: built.actionable },
          contentLen: built.withMenu?.content?.length ?? null,
          embedLen: built.withMenu?.embeds?.[0]?.description?.length ?? null,
          rowCount: rows.length,
          rows,
          payload: built.withMenu,
        };
        return new Response(JSON.stringify(report, null, 2) + "\n", {
          headers: { "Content-Type": "application/json" },
        });
      }
      const r = await postDigest(env).catch((e) => ({ error: e.message }));
      return new Response(`${JSON.stringify(r)}\n`, { status: 200 });
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
      // `?dry=1` reports what WOULD be archived without touching anything —
      // worth checking before clearing a backlog.
      if (url.searchParams.get("dry")) {
        return new Response(JSON.stringify(await archiveOldChores(env, { dryRun: true }), null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      }
      const r = await archiveOldChores(env);
      return new Response(`${JSON.stringify(r)}\nrun repeatedly to clear a backlog\n`, { status: 200 });
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
    // The exact lookup behind the `needswork` chore autocomplete. That path runs
    // inside Discord's 3s window and can't be deferred, so it needs to be
    // checkable without signing a Discord interaction — this is how you see
    // what the picker would offer, and how long it takes to produce it.
    if (url.pathname === "/recent-done") {
      if (!authed(url, env)) return new Response("Not found", { status: 404 });
      const days = parseInt(url.searchParams.get("days") || "21", 10);
      const t0 = Date.now();
      const teamId = await getTeamId(env, choresTeam(env));
      const rows = teamId ? await fetchRecentCompleted(env, teamId, { days }) : [];
      return new Response(
        JSON.stringify(
          {
            days,
            ms: Date.now() - t0,
            count: rows.length,
            titles: [...new Set(rows.map((r) => r.title))].slice(0, 25),
          },
          null,
          2,
        ),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.pathname === "/describe") {
      if (!authed(url, env)) return new Response("Not found", { status: 404 });
      const q = url.searchParams.get("q") || "";
      // No `q` -> the whole Recurring project grouped by miss policy. A per-title
      // lookup can't give a true inventory: a template whose next occurrence is
      // beyond the horizon is never materialized, so you can't discover it from
      // the calendar or chore list to look it up in the first place.
      const body = q ? await describeTemplate(env, q) : await describeAllTemplates(env);
      return new Response(JSON.stringify(body, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/done") {
      if (!authed(url, env)) return new Response("Not found", { status: 404 });
      const match = url.searchParams.get("match");
      if (!match) return new Response("missing ?match=<text>\n", { status: 400 });
      const { ok, message } = await markChoreDone(env, match);
      return new Response(message + "\n", { status: ok ? 200 : 404 });
    }
    if (url.pathname === "/leisure-sweep") {
      // Same thing the 10pm cron does — closes out today for anyone who didn't
      // log. Exposed so it can be tested and re-run without waiting for night.
      if (!authed(url, env)) return new Response("Not found", { status: 404 });
      return new Response(JSON.stringify(await autoLogLeisure(env), null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/leisure") {
      // Widget button: log that this person is starting their own time.
      // Shares recordLeisure with `/chores leisure`, so both write the same row.
      if (!authed(url, env)) return new Response("Not found", { status: 404 });
      const who = url.searchParams.get("user");
      if (!who) return new Response("need ?user=<name>\n", { status: 400 });
      const u = (await getUsers(env)).find((x) =>
        [x.displayName, x.name].some((n) => (n || "").toLowerCase().includes(who.toLowerCase())),
      );
      if (!u) return new Response(`No Linear user matching "${who}"\n`, { status: 404 });
      const r = await recordLeisure(env, {
        userId: u.id,
        person: u.name || u.displayName,
        note: url.searchParams.get("note"),
      });
      return new Response(JSON.stringify(r), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/unarchive") {
      // Undo an archive — the sweep removes unfinished work, so a wrong call
      // there needs a way back. Takes an issue identifier, e.g. CHO-359.
      if (!authed(url, env)) return new Response("Not found", { status: 404 });
      const issue = url.searchParams.get("issue");
      if (!issue) return new Response("need ?issue=CHO-123\n", { status: 400 });
      const r = await unarchiveIssue(env, issue).catch((e) => ({ error: e.message }));
      return new Response(`${JSON.stringify(r)}
`, { status: r?.success ? 200 : 500 });
    }
    if (url.pathname === "/claim") {
      // Take a chore onto your own plate — powers the widget's 🙋 on the other
      // person's work and on unclaimed chores.
      if (!authed(url, env)) return new Response("Not found", { status: 404 });
      const match = url.searchParams.get("match");
      const who = url.searchParams.get("user");
      if (!match || !who) return new Response("need ?match=<text>&user=<name>\n", { status: 400 });
      const target = (await getUsers(env)).find((x) =>
        [x.displayName, x.name].some((n) => (n || "").toLowerCase().includes(who.toLowerCase())),
      );
      if (!target) return new Response(`No Linear user matching "${who}"\n`, { status: 404 });
      const hits = await findActiveByTitle(env, match, choreProjects(env));
      if (!hits.length) return new Response(`No active chore matching "${match}"\n`, { status: 404 });
      hits.sort((a, b) => (a.dueDate || "9999-99-99").localeCompare(b.dueDate || "9999-99-99"));
      const prev = hits[0].assignee;
      const res = await assignIssue(env, hits[0].id, target.id);
      if (res?.success) {
        await markClaimed(env, hits[0].id); // deliberate: exempt from auto re-split
      }
      return new Response(
        res?.success ? `Assigned "${hits[0].title}" to ${target.name || who}\n` : "Assign failed\n",
        { status: res?.success ? 200 : 500 },
      );
    }
    if (url.pathname === "/cancel") {
      // Drop a chore without claiming the work was done. Powers the widget's ✖
      // and keeps "decided not to" out of the completion numbers.
      if (!authed(url, env)) return new Response("Not found", { status: 404 });
      const match = url.searchParams.get("match");
      if (!match) return new Response("missing ?match=<text>\n", { status: 400 });
      const { ok, message } = await cancelChore(env, match);
      return new Response(message + "\n", { status: ok ? 200 : 404 });
    }
    if (url.pathname === "/snooze") {
      // Powers the widget's snooze button, and nothing more involved: one day,
      // anchored to today so an overdue chore lands on tomorrow rather than on
      // another past date. Anything further out is a manual due-date edit in
      // Linear, deliberately.
      if (!authed(url, env)) return new Response("Not found", { status: 404 });
      const match = url.searchParams.get("match");
      if (!match) return new Response("missing ?match=<text>\n", { status: 400 });
      const { ok, message } = await snoozeChore(env, match, localDate(new Date()).ymd);
      return new Response(message + "\n", { status: ok ? 200 : 404 });
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
      const templates = await fetchRecurringTemplates(env, recurringProject(env));
      // Map each chore title to its effort-adjusted minutes, matching how the
      // weekly balancer weighs it (time × effort multiplier).
      const costMap = {};
      for (const t of templates) {
        const em = (t.description || "").match(/^\s*estimate\s*:\s*(.+)$/im);
        const mins = em ? parseDuration(em[1]) : undefined;
        const ef = (t.description || "").match(/^\s*effort\s*:\s*([1-5])\s*$/im);
        const effort = ef ? parseInt(ef[1], 10) : undefined;
        if (mins || effort) costMap[(t.title || "").toLowerCase()] = choreCost(mins, effort);
      }
      const allowed = [7, 30, 90, 365];
      let range = parseInt(url.searchParams.get("range") || "30", 10);
      if (!allowed.includes(range)) range = 30;
      const data = await queryDashboard(env, (title) => costMap[(title || "").toLowerCase()] ?? 15, range);
      if (!data) return new Response("D1 not configured\n", { status: 200 });
      // The leisure panel is opt-in per person via ?user=. The dashboard link
      // pinned in Discord has no `user`, so the household view never shows it —
      // this is a personal metric, not a shared scoreboard.
      const who = (url.searchParams.get("user") || "").trim();
      const leisure = who ? await queryLeisure(env, who, range) : null;
      return new Response(renderDashboardPage(data, range, leisure), {
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
}

export default {
  fetch: handleRequest,
  async scheduled(event, env, ctx) {
    // Two schedules. The late one (02:00 UTC = 10pm EDT the evening before)
    // only closes the leisure log for the day that's ending; the morning one is
    // the full daily run: generate + reconcile, digest, cap, archive, and the
    // weekly recap on Mondays.
    if (event?.cron === LEISURE_CRON) {
      ctx.waitUntil(autoLogLeisure(env).catch((e) => console.error("auto leisure failed:", e)));
      return;
    }
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

  // Template tickets (Recurring project) aren't echoed to Discord, but editing
  // one — a day/cadence change, or toggling the `paused` label — should
  // reconcile the already-materialized window right away (day-change reconcile +
  // paused-label retraction), instead of waiting for Monday or a manual sync.
  const recurringProject = recurringProject(env);
  if (data?.project?.name === recurringProject) {
    if (type === "Issue" && ["create", "update", "remove"].includes(action)) {
      await runWeek(env, { skipCleanup: true }).catch((e) => console.error("template-edit reconcile failed:", e));
    }
    return;
  }

  // Comments are no longer echoed to Discord (too noisy).
  if (type !== "Issue") return;

  // Keep today's digest message honest, whatever moved the chore.
  //
  // Every surface goes through Linear — the widget's /done and ✖, the /chores
  // commands, the digest dropdown, Linear's own UI — so this one hook covers
  // all of them, and it runs on the bot token rather than an interaction token,
  // so it still lands when a dropdown's response was lost.
  //
  // Placed above the description-only filter, which returns early without
  // posting an embed but can still change the board.
  //
  // `remove` is EXCLUDED, and that matters: the nightly auto-archive sweep fires
  // one remove webhook per issue, up to ARCHIVE_MAX (30) of them, and it runs
  // AFTER the digest has been posted — so including removes meant up to 30 full
  // digest rebuilds and 30 Discord edits every morning, against a channel edit
  // limit of roughly 5 per 5 seconds. Archived chores are resolved and older
  // than the retention window, so they were never on today's board anyway.
  //
  // Gated on the fields the digest actually renders, so a description edit
  // doesn't trigger a rebuild.
  if (action === "create" || action === "update") {
    const proj = data?.project?.name;
    const changed = Object.keys(payload.updatedFrom || {});
    const DIGEST_FIELDS = ["state", "stateId", "assignee", "assigneeId", "dueDate", "title"];
    const touches =
      action === "create" || !changed.length || changed.some((k) => DIGEST_FIELDS.includes(k));
    if (proj && choreProjects.includes(proj) && touches) {
      await refreshDigest(env).catch((e) => console.error("digest refresh failed:", e.message));
    }
  }

  // Archiving a chore fires one `remove` webhook PER ISSUE, so the auto-archive
  // sweep (up to ARCHIVE_MAX a run) would carpet the activity channel with
  // tombstones for work that was already finished days ago. A webhook can't be
  // batched — each event is its own request — so the per-issue events are
  // dropped here and `archiveOldChores` posts a single summary instead.
  //
  // Scoped to the chore projects: a removal in a real project (a shed build,
  // say) is still worth seeing. Set MIRROR_CHORE_REMOVALS=true to get them back.
  if (action === "remove" && env.MIRROR_CHORE_REMOVALS !== "true") {
    const proj = data?.project?.name;
    if (proj && choreProjects.includes(proj)) return;
  }

  // A due date changed by hand — in Linear, or by anything other than the
  // generator — is a deliberate reschedule. Tag it so the reconcile pass
  // doesn't mistake it for a stale copy and archive it overnight. Our own
  // /chores snooze tags it too; this is idempotent.
  if (action === "update" && payload.updatedFrom && "dueDate" in payload.updatedFrom) {
    const proj = data?.project?.name;
    if (proj && choreProjects.includes(proj) && data?.id) {
      await markSnoozed(env, data.id).catch((e) => console.error("auto-snooze tag failed:", e));
    }
  }

  // Skip description-only edits: only notify when a field we actually surface
  // changed (title, state, assignee, priority, due date). `updatedFrom` lists
  // the changed fields; if it's present and touches none of these, it's noise.
  if (action === "update") {
    const MEANINGFUL = ["title", "state", "stateId", "assignee", "assigneeId", "priority", "dueDate"];
    const changed = Object.keys(payload.updatedFrom || {});
    if (changed.length && !changed.some((k) => MEANINGFUL.includes(k))) return;
  }

  const embed = formatIssueEmbed(payload);
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

  // 1. Generation + reconcile, DAILY, before the digest so it reflects them.
  //    Runs every day rather than Mondays only so the horizon truly rolls (it
  //    used to shrink to ~8 days by Sunday), template edits and pause expiries
  //    settle within a day, and a swept chore is handed back to whoever let it
  //    slip the next morning instead of up to a week later.
  //
  //    Safe daily only because the sweep now has an explicit grace window
  //    (SWEEP_GRACE_DAYS) — its old "past due at all" test depended on running
  //    weekly to give chores any grace at all. Generation itself is idempotent
  //    (dedup by team+title+due date), so extra runs only fill gaps.
  try {
    // Settle catch-ups for any pause that expired on its own first, so the
    // make-ups exist before the digest.
    await processExpiredPauses(env);
  } catch (err) {
    console.error("Expired-pause catch-up failed:", err);
  }
  try {
    await runWeek(env);
  } catch (err) {
    console.error("Daily generation failed:", err);
  }

  // 2. Due-date digest, split by owner with @-mentions.
  try {
    await postDigest(env);
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
  //    Linear's free-tier cap. Skip Mondays — generation now runs daily, so the
  //    only remaining heavy day is Monday (recap + D1 snapshot on top of it) and
  //    that's where the per-invocation subrequest limit could bite. Other 6 days.
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

// Build and post today's digest. Split out from the cron so it can be reposted
// on its own via /digest — re-running the whole cron just to resend the list
// also runs generation and the overdue sweep, which is a lot of side effect for
// "send that message again". Read-only apart from the Discord post.
// Builds the digest payload WITHOUT posting it. Shared by the daily cron post
// and the live in-place refresh, so a re-render can never drift from what the
// cron would have produced — two copies of this logic would diverge the first
// time either changed.
async function buildDigestPayload(env) {
  const today = localDate(new Date()).ymd;
  // Pull the whole week in one query: the digest shows today + past due per
  // person, then the rest of the week per person underneath (unassigned work
  // included, so it can be picked up when someone has time).
  // Upcoming stops at the end of THIS calendar week (Mon–Sun) rather than
  // rolling 7 days forward. A rolling window means Sunday shows you next
  // Monday's chores, which is noise on the quietest day of the week — and it
  // blurs where one week ends and the next begins. Monday shows Mon–Sun,
  // Friday shows Fri–Sun, Sunday shows only Sunday.
  //
  // WEEK_LOOKAHEAD_DAYS is now a ceiling rather than the window itself: set it
  // lower to see less than the rest of the week, never more.
  const weekday = localDate(new Date()).weekday; // 0 = Sunday
  const toWeekEnd = weekday === 0 ? 0 : 7 - weekday;
  const cap = Math.max(0, parseInt(env.WEEK_LOOKAHEAD_DAYS || "14", 10) || 0);
  const week = Math.min(toWeekEnd, cap);
  const all = await fetchDueIssues(env, week);
  // fetchDueIssues excludes completed and canceled, so an empty result means
  // nothing in the window is outstanding. For the morning post that means
  // "don't post"; for a live refresh it means the day just got CLEARED, which
  // is the one state change worth showing. Returning null for both is what
  // would have frozen the digest on its last unresolved chore forever.
  if (!all.length) {
    return {
      today,
      empty: true,
      count: 0,
      shown: 0,
      actionable: 0,
      allClear: buildAllClearMessage(today),
    };
  }

  // The preview is for work you could otherwise forget: ad-hoc tasks, project
  // work, and chores that only come round every few months. Routine
  // weekly-or-more-often chores are dropped from it — they're already in
  // today's list on the day, and listing them ahead just buries the rest.
  // Today and past due are untouched; this only filters the forward view.
  const frequent = await frequentChoreTitles(env);
  const shown = all.filter(
    (i) => !(i.dueDate && i.dueDate > today && frequent.has((i.title || "").toLowerCase())),
  );
  // Warning marks: repeatedly put off, or a detail was missed last pass.
  const marks = await choreMarks(
    env,
    await getTeamId(env, choresTeam(env)),
    shown,
    today,
  ).catch((e) => {
    console.error("chore marks failed:", e.message);
    return null;
  });
  const mentions = parseMentions(env.DISCORD_MENTIONS);
  const anytime = await anytimePool(env, 2);

  // The dropdown stays scoped to what's actionable now — today, past due, and
  // any unassigned chore (claimable ahead of time). A select caps at 25
  // options, so feeding it a full week would push the chores you actually need
  // today off the end of the list.
  const actionable = all.filter(
    (i) => !i.dueDate || i.dueDate <= today || !i.assignee?.name,
  );
  const components = buildDigestMenu(actionable, []);

  // Discord refuses an oversized message outright (413 / code 40005), so on a
  // busy day the digest has to give something up. It sheds CONTENT, in order of
  // what matters least, and only when the full version would actually be
  // rejected — a normal day renders everything:
  //   1. the Anytime suggestions (undated, purely opportunistic)
  //   2. then Upcoming, for everyone (later this week is context, not today)
  // If even that is too big, fitDigestPayload drops whole dropdowns as a last
  // resort. "Mark done" and today/past-due are never shed.
  const LEVELS = [
    { label: "full", includeAnytime: true, includeUpcoming: true },
    { label: "without Anytime", includeAnytime: false, includeUpcoming: true },
    { label: "without Anytime or Upcoming", includeAnytime: false, includeUpcoming: false },
  ];
  let msg = null;
  let level = null;
  let withMenu = null;
  for (const lvl of LEVELS) {
    msg = buildDigestMessage(shown, mentions, today, [], anytime, marks, lvl);
    withMenu = { ...msg, components };
    level = lvl.label;
    if (digestBytes(withMenu) <= DIGEST_BUDGET_BYTES) break;
  }
  if (level !== "full") {
    console.warn(`digest too large for Discord — rendered ${level} (${digestBytes(withMenu)}B)`);
  }
  const fitted = fitDigestPayload(withMenu);

  return {
    today,
    empty: false,
    count: all.length,
    shown: shown.length,
    actionable: actionable.length,
    level,
    bytes: fitted.bytes,
    droppedRows: fitted.dropped,
    withMenu: fitted.payload,
    plain: msg,
  };
}

async function postDigest(env) {
  const built = await buildDigestPayload(env);
  // Nothing outstanding first thing in the morning: stay quiet rather than
  // opening the day with an "all clear" about chores nobody had yet. The
  // all-clear is a transition, and it's the refresh that renders it.
  if (!built || built.empty) return { posted: false, count: 0 };
  // Bot-posted digest carries the actions dropdown; falls back to the webhook
  // (no menu) if the bot token / channel id aren't configured.
  if (env.DISCORD_BOT_TOKEN && env.DISCORD_DUE_CHANNEL_ID) {
    const sent = await postViaBot(env, env.DISCORD_DUE_CHANNEL_ID, built.withMenu);
    // Report the failure instead of claiming success. This returned
    // `posted: true` regardless of what Discord said, so a rejected digest was
    // indistinguishable from a delivered one — which is exactly how it went
    // unnoticed.
    if (!sent.ok) {
      return {
        posted: false,
        count: built.count,
        discord: { status: sent.status, error: sent.error },
      };
    }
    // Remember which message this is so completions from any surface can edit
    // it instead of adding a line to the channel.
    if (sent.id) {
      await saveDigestMessage(env, {
        ymd: built.today,
        channelId: env.DISCORD_DUE_CHANNEL_ID,
        messageId: sent.id,
      }).catch((e) => console.error("remembering digest message failed:", e.message));
    }
  } else if (env.DISCORD_WEBHOOK_DUE) {
    await postToDiscord(env.DISCORD_WEBHOOK_DUE, built.plain);
  } else {
    return { posted: false, count: built.count };
  }
  return { posted: true, count: built.count, shown: built.shown, actionable: built.actionable };
}

// Re-render today's digest message in place.
//
// Every surface that resolves a chore does it through Linear — the widget's
// /done, the /chores commands, the digest dropdown, Linear's own UI — so the
// Linear webhook is the single hook that covers all of them. The digest
// dropdown already did this via its interaction token; this is what the widget
// was missing.
//
// Deliberately an EDIT, not a new message: with several completions a day, a
// line each would turn the channel into a feed, and the completion embed
// already goes to the activity channel. The trade-off is that Discord edits are
// silent — no ping, no channel bump — so this keeps the board accurate rather
// than announcing anything.
async function refreshDigest(env) {
  if (!env.DB) return { refreshed: false, reason: "no DB" };
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_DUE_CHANNEL_ID) {
    return { refreshed: false, reason: "bot not configured" };
  }
  const today = localDate(new Date()).ymd;
  const rec = await getDigestMessage(env, today).catch((e) => {
    console.error("digest message lookup failed:", e.message);
    return null;
  });
  // No digest posted yet today (or it went out via the webhook, which gives no
  // message id) — nothing to edit, and that's not an error.
  if (!rec?.message_id) return { refreshed: false, reason: "no digest message today" };
  const built = await buildDigestPayload(env);
  if (!built) return { refreshed: false, reason: "nothing due" };
  const payload = built.empty ? built.allClear : built.withMenu;
  const r = await editViaBot(env, rec.channel_id, rec.message_id, payload);
  if (!r.ok && r.status === 404) {
    // Someone deleted it; forget the id so we stop trying all day.
    await clearDigestMessage(env, today).catch(() => {});
    return { refreshed: false, reason: "message deleted" };
  }
  return { refreshed: r.ok, remaining: built.actionable };
}

// Archive resolved chores older than CHORE_RETENTION_DAYS so the active count
// stays under Linear's free-plan cap. Covers completed AND canceled work in
// both the chores and ad-hoc projects — archiving is not deletion: the issues
// stay in Linear's archive and D1 keeps the stats either way.
async function archiveOldChores(env, { dryRun = false } = {}) {
  const days = parseInt(env.CHORE_RETENTION_DAYS || "30", 10);
  const max = parseInt(env.ARCHIVE_MAX || "30", 10);
  const before = new Date(Date.now() - days * 86_400_000).toISOString();
  const projects = choreProjects(env);
  const old = await fetchArchivableBefore(env, projects, before, max);
  const byState = old.reduce((a, i) => {
    const t = i.state?.type || "unknown";
    a[t] = (a[t] || 0) + 1;
    return a;
  }, {});
  if (dryRun) return { dryRun: true, retentionDays: days, projects, found: old.length, byState };
  let n = 0;
  for (const i of old) {
    const r = await archiveIssue(env, i.id);
    if (r?.success) n++;
  }
  if (n) {
    console.log(`Auto-archived ${n} resolved chore(s) older than ${days}d.`, byState);
    // One line standing in for the per-issue `remove` events suppressed in
    // handleEvent — the sweep stays visible without burying the channel.
    const url = resolveWebhook(choresTeam(env), env);
    if (url) {
      const bits = [];
      if (byState.completed) bits.push(`${byState.completed} done`);
      if (byState.canceled) bits.push(`${byState.canceled} canceled`);
      const more = old.length >= parseInt(env.ARCHIVE_MAX || "30", 10) ? " · more to come tomorrow" : "";
      await postToDiscord(url, {
        embeds: [
          {
            description:
              `🗄️ Tidied up **${n}** finished chore${n === 1 ? "" : "s"}` +
              (bits.length ? ` (${bits.join(", ")})` : "") +
              ` older than ${days} days.${more}`,
            color: 0x6b6b74,
            timestamp: new Date().toISOString(),
          },
        ],
      }).catch((e) => console.error("archive summary post failed:", e));
    }
  }
  return { archived: n, found: old.length, byState, retentionDays: days };
}

// Posts the weekly scoreboard. On the cron it only runs Mondays; `force` (the
// /scoreboard endpoint) runs it any day.
async function postScoreboard(env, force) {
  const now = new Date();
  if (!force && now.getUTCDay() !== 1) return;
  const teamId = await getTeamId(env, choresTeam(env));
  const url =
    env.DISCORD_WEBHOOK_STATS || env.DISCORD_WEBHOOK_DUE || env.DISCORD_WEBHOOK_DEFAULT;
  if (!teamId || !url) return;
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  const history = await fetchChoreHistory(env, teamId, since);
  await postToDiscord(url, buildScoreboardMessage(computeStats(history, now)));
}
