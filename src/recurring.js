// Free replacement for Linear's paid "recurring issues" feature.
//
// PRIMARY source: template tickets in a Linear project (default "Recurring").
// Cadence is expressed with LABELS; the description is free for a checklist and
// is copied verbatim onto each spawned chore. No code edit / deploy needed.
//
//   frequency label (pick one): daily | weekly | biweekly | triweekly |
//                               semi-monthly | monthly | bimonthly |
//                               semi-annually | annually
//   weekday labels (weekly/biweekly/triweekly; pick any): monday .. sunday
//                               -> omit on a weekly-family chore for "any day":
//                                  due Sunday (or N spread days via `count:`)
//   month labels (any cadence; pick any): january .. december
//                               -> limits recurrence to those months, every year
//                                  (e.g. a weekly chore only May–Sep). For
//                                  monthly-family cadences they also pick which
//                                  month(s) the cycle lands on.
//   day-of-month label (monthly/bimonthly/semi-annually/annually): first | middle | last
//                               -> 1st / 15th / last day of month
//   skip | replace (| always)   (optional collision policy; default replace)
//   paused                       (optional) -> stop generating until removed
//   silent                       (optional) -> generate without a Discord post
//
//   Description directives (optional; parsed then stripped from the copy):
//     week: even | odd      which week for biweekly (default even/0)
//     week: 0 | 1 | 2       which week for triweekly (default 0)
//     dueafter: 2           due date N days out (default today)
//     count: 3              "anyday" chore: times/week on auto-spread days
//     estimate: 30m         effort (e.g. 30m, 1h30m) — weekly balance is by total time
//     opposite: <title>     assign the other person from that chore on the same day
//     start: 2026-06-27     first eligible date; also anchors the every-N-weeks cycle
//     end: 2026-10-31       last eligible date; stops recurring after it
//
//   Every other label (e.g. "kitchen") is copied onto the spawned chore.
//
// SECONDARY source: the static RECURRING array below — optional, for chores you
// prefer to keep in code. Leave it empty to rely entirely on Linear.

import {
  getTeamId,
  getLabelIds,
  createIssue,
  findOpenIssuesByTitle,
  archiveIssue,
  fetchRecurringTemplates,
  getUsers,
  getIssueByIdentifier,
  getTodoStateId,
  getProjectId,
  fetchSpawned,
  fetchRecentSpawned,
  fetchTemplatesForAnnotation,
  upsertComment,
  getViewerId,
} from "./linear.js";
import { getActivePauses, pausesOn, markPauseCleared } from "./pauses.js";
import { getWeightResolver } from "./weights.js";

const MON_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SCHEDULE_MARKER = "🔁 **Schedule**";

const WEEKDAYS = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const CADENCE = new Set([
  "daily",
  "weekly",
  "biweekly",
  "triweekly",
  "semi-monthly",
  "monthly",
  "bimonthly",
  "semi-annually",
  "annually",
]);

const DAY_OF_MONTH = new Set(["first", "middle", "last"]);

const ONMISS = new Set(["always", "skip", "replace"]);

// "anyday" chores (weekly-family cadence with no weekday label) get weekday(s)
// synthesized by how many times per week they run (`count:`), spread across the
// week so generation/assignment/annotation all work via the normal weekly path.
// Default effort (minutes) for a chore with no `estimate:` — so unestimated
// chores still balance ≈evenly by count.
const DEFAULT_EST_MIN = 15;

const ANYDAY_SPREAD = {
  1: ["sunday"], // once — due end of week
  2: ["wednesday", "sunday"],
  3: ["monday", "wednesday", "friday"],
  4: ["monday", "wednesday", "friday", "sunday"],
  5: ["monday", "tuesday", "wednesday", "thursday", "friday"],
  6: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
  7: ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
};

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9,
  sept: 9, oct: 10, nov: 11, dec: 12,
};

// Optional in-code chores. teamKey + label NAMES + cadence fields.
export const RECURRING = [
  // { title: "Pay rent", teamKey: "CHO", cadence: "monthly", dom: "first", dueAfterDays: 3 },
];

// Extract cadence from a template's labels. Returns the parsed config plus the
// IDs of the "real" labels (everything not a cadence directive) to copy along.
function parseLabelConfig(labelNodes) {
  const config = {};
  const passthroughLabelIds = [];

  for (const l of labelNodes) {
    const name = l.name.toLowerCase().replace(/\s+/g, "");
    if (CADENCE.has(name)) {
      config.cadence = name;
    } else if (name in WEEKDAYS) {
      (config.days ||= []).push(name); // monday..sunday (weekly/biweekly)
    } else if (DAY_OF_MONTH.has(name)) {
      config.dom = name; // first | middle | last
    } else if (ONMISS.has(name)) {
      config.onExisting = name; // skip | replace | always
    } else if (name in MONTHS) {
      (config.months ||= []).push(MONTHS[name]); // jan..dec (annual/semi/bimonthly)
    } else if (name === "paused") {
      config.paused = true; // skip generation while present
    } else if (name === "catchup") {
      config.catchup = true; // a skipped occurrence becomes a make-up on return
    } else {
      passthroughLabelIds.push(l.id); // a real label (room, etc.)
    }
  }
  return { config, passthroughLabelIds };
}

// "30m" / "1h" / "1h30m" / "45" -> minutes. Used by `estimate:`.
export function parseDuration(s) {
  const t = (s || "").trim().toLowerCase();
  let min = 0;
  let matched = false;
  const h = t.match(/(\d+)\s*h/);
  if (h) { min += parseInt(h[1], 10) * 60; matched = true; }
  const m = t.match(/(\d+)\s*m/);
  if (m) { min += parseInt(m[1], 10); matched = true; }
  if (!matched) { const n = parseInt(t, 10); if (!Number.isNaN(n)) min = n; }
  return min > 0 ? min : undefined;
}

// week/dueafter/opposite/start/end/count/estimate live in the description;
// parsed then stripped. (Months come from labels only.)
const DESC_DIRECTIVE_RE = /^\s*(week|dueafter|opposite|start|end|count|estimate)\s*:/i;
function parseDescriptionConfig(description) {
  const cfg = {};
  if (!description) return cfg;

  // count: N -> times per week for an "anyday" chore (1..7).
  const cnt = description.match(/^\s*count\s*:\s*(\d+)\s*$/im);
  if (cnt) cfg.count = Math.max(1, Math.min(7, parseInt(cnt[1], 10)));
  // estimate: 30m / 1h30m -> effort in minutes (weights the weekly balance).
  const est = description.match(/^\s*estimate\s*:\s*(.+)$/im);
  if (est) cfg.estimate = parseDuration(est[1]);
  // week phase for biweekly (even/odd) and triweekly (0/1/2).
  const weekLine = description.match(/^\s*week\s*:\s*(even|odd|\d+)\s*$/im);
  if (weekLine) {
    const w = weekLine[1].toLowerCase();
    cfg.weekPhase = w === "even" ? 0 : w === "odd" ? 1 : parseInt(w, 10);
  }
  const da = description.match(/^\s*dueafter\s*:\s*(\d{1,3})\s*$/im);
  if (da) cfg.dueAfterDays = parseInt(da[1], 10);
  // opposite: <chore title> -> assign the other member from that chore this run
  const opp = description.match(/^\s*opposite\s*:\s*(.+)$/im);
  if (opp) cfg.opposite = opp[1].trim();
  // start: YYYY-MM-DD -> first eligible date; also anchors the biweekly/triweekly cycle
  const st = description.match(/^\s*start\s*:\s*(\d{4}-\d{2}-\d{2})\s*$/im);
  if (st) cfg.start = st[1];
  // end: YYYY-MM-DD -> last eligible date; stops recurring after it
  const en = description.match(/^\s*end\s*:\s*(\d{4}-\d{2}-\d{2})\s*$/im);
  if (en) cfg.end = en[1];
  return cfg;
}
function stripDescription(description) {
  if (!description) return undefined;
  const body = description
    .split("\n")
    .filter((line) => !DESC_DIRECTIVE_RE.test(line))
    .join("\n")
    .trim();
  return body || undefined;
}

// Resolve the comma-separated ROTATION_MEMBERS (names or emails) to user IDs,
// in order. The order defines the alternation (first listed gets a fresh chore).
function matchMembers(spec, users) {
  const ids = [];
  for (const raw of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const tok = raw.toLowerCase();
    const exact = users.find(
      (u) =>
        (u.email || "").toLowerCase() === tok ||
        (u.displayName || "").toLowerCase() === tok ||
        (u.name || "").toLowerCase() === tok,
    );
    const fuzzy =
      exact ||
      users.find(
        (u) =>
          (u.displayName || "").toLowerCase().includes(tok) ||
          (u.name || "").toLowerCase().includes(tok),
      );
    if (fuzzy) {
      ids.push(fuzzy.id);
      console.log(`Rotation: "${raw}" -> ${fuzzy.name || fuzzy.displayName}`);
    } else {
      console.warn(`Rotation: no user matched "${raw}"`);
    }
  }
  return ids;
}

// Current date in America/New_York (Eastern). Computing the day in local time
// (not UTC) means weekday / day-of-month / week-phase / due dates reflect the
// household's actual calendar day no matter when the UTC cron fires. DST-safe.
export function localDate(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  const year = +get("year");
  const month = +get("month");
  const day = +get("day");
  const utcMidnight = Date.UTC(year, month - 1, day);
  return {
    ymd: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: new Date(utcMidnight).getUTCDay(),
    dom: day,
    month,
    year,
    weekIndex: Math.floor(utcMidnight / 86_400_000 / 7),
  };
}

function lastDayOfMonth(L) {
  return new Date(Date.UTC(L.year, L.month, 0)).getUTCDate();
}

// first -> 1, middle -> 15, last -> last day; default first.
function targetDayOfMonth(chore, L) {
  if (chore.dom === "middle") return 15;
  if (chore.dom === "last") return lastDayOfMonth(L);
  return 1;
}

// Append a link back to the source template so any spawned chore has a one-click
// path to edit its definition.
export function withTemplateLink(description, url) {
  if (!url) return description || "";
  return `${description ? `${description}\n\n` : ""}— [recurring template ↗](${url})`;
}

// Absolute month index (year*12 + month) of a YYYY-MM-DD date, for anchoring
// every-N-months cadences to a template's start month.
function monthIndexOf(ymd) {
  const [y, m] = ymd.split("-").map(Number);
  return y * 12 + (m - 1);
}

function isDueToday(chore, now) {
  const L = localDate(now);
  if (chore.start && L.ymd < chore.start) return false; // hasn't started yet
  if (chore.end && L.ymd > chore.end) return false; // past its end date
  // Month labels gate every cadence (seasonal, repeats yearly). For monthly-family
  // cadences monthlyDue also reads months to pick the landing month.
  if (chore.months?.length && !chore.months.includes(L.month)) return false;
  const onWeekday = (chore.days || []).map((d) => WEEKDAYS[d]).includes(L.weekday);
  const onTargetDay = L.dom === targetDayOfMonth(chore, L);
  // A start date anchors the every-N-weeks cycle; otherwise use the week: phase.
  const phase = (n) =>
    chore.anchorWeek != null ? ((chore.anchorWeek % n) + n) % n : (chore.weekPhase ?? 0);
  // Every-N-months cadence on the target day. Explicit month labels win; else a
  // start date anchors the cycle to its own month; else a fixed fallback set.
  const Lmi = L.year * 12 + (L.month - 1);
  const monthlyDue = (n, fallback) => {
    if (!onTargetDay) return false;
    if (chore.months?.length) return chore.months.includes(L.month);
    if (chore.anchorMonth != null) return (((Lmi - chore.anchorMonth) % n) + n) % n === 0;
    return fallback.includes(L.month);
  };

  switch (chore.cadence) {
    case "daily":
      return true;
    case "weekly":
      return onWeekday;
    case "biweekly":
      return onWeekday && L.weekIndex % 2 === phase(2);
    case "triweekly":
      return onWeekday && L.weekIndex % 3 === phase(3);
    case "semi-monthly": {
      // Twice a month: anchored to the start day (and ~15 days later) if a start
      // date is given; otherwise the conventional 1st and 15th.
      if (chore.start) {
        const last = lastDayOfMonth(L);
        const d0 = Math.min(Number(chore.start.slice(8, 10)), last);
        const d1 = Math.min(d0 + 15, last);
        return L.dom === d0 || L.dom === d1;
      }
      return L.dom === 1 || L.dom === 15;
    }
    case "monthly":
      return onTargetDay;
    case "bimonthly":
      return monthlyDue(2, [1, 3, 5, 7, 9, 11]);
    case "semi-annually":
      return monthlyDue(6, [1, 7]);
    case "annually":
      return monthlyDue(12, [1]);
    default:
      console.error(`Unknown/absent cadence for "${chore.title}"`);
      return false;
  }
}

// Normalize both sources into a common shape with teamId + labelIds resolved.
async function buildDefs(env) {
  const defs = [];

  // Linear templates (primary).
  try {
    const projectName = env.RECURRING_PROJECT || "Recurring";
    const templates = await fetchRecurringTemplates(env, projectName);
    for (const t of templates) {
      const { config, passthroughLabelIds } = parseLabelConfig(t.labels?.nodes || []);
      if (!config.cadence) {
        console.warn(`Template "${t.title}" has no frequency label — skipping.`);
        continue;
      }
      if (config.paused) continue; // `paused` label -> don't generate
      const descCfg = parseDescriptionConfig(t.description);
      // "anyday": a weekly-family chore with no weekday label runs `count` times
      // per week on auto-spread days (default once, due Sunday).
      const weeklyFamily = ["weekly", "biweekly", "triweekly"].includes(config.cadence);
      const anyday = weeklyFamily && !(config.days && config.days.length);
      const count = anyday ? descCfg.count || 1 : undefined;
      const days = anyday ? ANYDAY_SPREAD[count] : config.days;
      defs.push({
        title: t.title,
        teamId: t.team?.id,
        labelIds: passthroughLabelIds,
        description: stripDescription(t.description),
        templateUrl: t.url, // link back to the template from the spawned chore
        onExisting: config.onExisting || "replace",
        catchup: config.catchup, // `catchup` label -> skipped occurrences owe a make-up
        cadence: config.cadence,
        days,
        anyday,
        count,
        estimate: descCfg.estimate,
        dom: config.dom,
        months: config.months,
        weekPhase: descCfg.weekPhase,
        dueAfterDays: descCfg.dueAfterDays,
        opposite: descCfg.opposite, // assign opposite of this chore's owner
        assigneeId: t.assignee?.id, // explicit owner on the template = fixed
        start: descCfg.start, // first eligible date
        end: descCfg.end, // last eligible date
        anchorWeek: descCfg.start
          ? localDate(new Date(`${descCfg.start}T12:00:00Z`)).weekIndex
          : undefined,
        anchorMonth: descCfg.start ? monthIndexOf(descCfg.start) : undefined,
      });
    }
  } catch (err) {
    console.error("Reading recurring templates failed:", err);
  }

  // Static array (secondary).
  for (const c of RECURRING) {
    defs.push({
      ...c,
      teamId: await getTeamId(env, c.teamKey),
      labelIds: await getLabelIds(env, c.labels),
      onExisting: c.onExisting || "always",
    });
  }

  return defs;
}

// Manually archive an issue and spawn a fresh copy (same title/team/labels/
// description), rotating the assignee to the other member. Used by /replace.
export async function forceReplace(env, identifier) {
  const issue = await getIssueByIdentifier(env, identifier);
  if (!issue) {
    console.error(`Replace: issue "${identifier}" not found`);
    return { ok: false, reason: "not found" };
  }
  await archiveIssue(env, issue.id);

  let assigneeId = issue.assignee?.id;
  if (env.ROTATION_MEMBERS) {
    const rotation = matchMembers(env.ROTATION_MEMBERS, await getUsers(env));
    if (rotation.length >= 2) {
      const idx = rotation.indexOf(issue.assignee?.id);
      assigneeId = rotation[(idx + 1) % rotation.length];
    }
  }

  const today = localDate(new Date()).ymd;
  const result = await createIssue(env, {
    teamId: issue.team.id,
    title: issue.title,
    description: issue.description,
    dueDate: today,
    labelIds: (issue.labels?.nodes || []).map((l) => l.id),
    assigneeId,
    stateId: await getTodoStateId(env, issue.team.id),
    projectId: await getProjectId(env, env.CHORES_PROJECT || "House Chores"),
  });
  if (result?.success) {
    console.log(`Replaced ${identifier} -> ${result.issue?.identifier}`);
  }
  return { ok: !!result?.success, identifier: result?.issue?.identifier };
}

// Spawn every chore due on `now`'s local date — handling assignment (rotation +
// "opposite" coupling) and the overdue-only replace policy. `defs`/`rotation`
// are passed in so a whole week can be generated without re-fetching.
// Establish the coming week's chores (today + next 6 days), each on its real due
// day. Assignment is balanced across the whole week (≈50/50, accounting for
// fixed owners and "opposite" pairs) instead of per-chore alternation, so weeks
// aren't lopsided. Run weekly (during the Monday recap), not daily.
export async function runWeek(env, opts = {}) {
  const defs = await buildDefs(env);
  if (!defs.length) return { created: 0, archived: 0, moved: 0 };

  const users = await getUsers(env);
  let rotation = [];
  if (env.ROTATION_MEMBERS) {
    rotation = matchMembers(env.ROTATION_MEMBERS, users);
    if (rotation.length < 2) {
      console.warn(`Rotation disabled: matched ${rotation.length} member(s), need 2.`);
      rotation = [];
    }
  }

  // Pauses: global (skip all), chore (skip that title), user (drop from rotation
  // + skip their fixed chores) — each only on dates within its window.
  const pauses = await getActivePauses(env);
  const nameToId = (name) => {
    const want = (name || "").toLowerCase();
    const u = users.find((x) => [x.displayName, x.name].some((n) => (n || "").toLowerCase().includes(want)));
    return u?.id || null;
  };
  // Resolve user-pause targets to ids once; map kept with their windows.
  const userPauses = pauses
    .filter((p) => p.scope === "user")
    .map((p) => ({ ...p, userId: nameToId(p.target) }))
    .filter((p) => p.userId);
  const pausedUserIdsOn = (ymd) =>
    userPauses.filter((p) => ymd >= p.start_date && ymd <= p.end_date).map((p) => p.userId);

  // Prefetch per team (a few queries total) so planning needs no per-chore
  // lookups and the week stays under the Worker subrequest cap.
  const base = new Date();
  const todayYmd = localDate(base).ymd;
  const horizonEnd = localDate(new Date(base.getTime() + 6 * 86_400_000)).ymd;
  const isOpen = (n) => !["completed", "canceled"].includes(n.state?.type);

  const projectName = env.CHORES_PROJECT || "House Chores";
  const projectId = await getProjectId(env, projectName);

  const ctx = { todoStates: {}, spawned: {}, lastByTitle: {} };
  const teamIds = [...new Set(defs.map((c) => c.teamId).filter(Boolean))];
  for (const teamId of teamIds) {
    ctx.todoStates[teamId] = await getTodoStateId(env, teamId);
    ctx.spawned[teamId] = await fetchSpawned(env, teamId, projectName);

    const recent = await fetchRecentSpawned(env, teamId, projectName);
    recent.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    const lbt = {};
    for (const n of recent) if (!(n.title in lbt)) lbt[n.title] = n.assignee?.id || null;
    ctx.lastByTitle[teamId] = lbt;
  }

  // Dedup set: an occurrence already exists for this (team, title, due date).
  const existing = new Set();
  for (const teamId of teamIds) {
    for (const n of ctx.spawned[teamId]) {
      if (n.dueDate) existing.add(`${teamId}::${n.title}@${n.dueDate}`);
    }
  }

  // PLAN: one entry per (chore, day-it's-due) in the next 7 days, skipping any
  // occurrence that already exists. `correctKeys` is the full set the current
  // templates produce in-window (before dedup) — used below to reconcile chores
  // whose template moved them to a different day.
  const plan = [];
  const correctKeys = new Set();
  for (let d = 0; d < 7; d++) {
    const L = localDate(new Date(base.getTime() + d * 86_400_000));
    for (const c of defs) {
      if (!c.teamId || !isDueToday(c, new Date(`${L.ymd}T12:00:00Z`))) continue;
      const dueDate = c.dueAfterDays
        ? new Date(Date.UTC(L.year, L.month - 1, L.dom) + c.dueAfterDays * 86_400_000)
            .toISOString()
            .slice(0, 10)
        : L.ymd;
      // Global pause skips everything in-window; chore-level pausing is the
      // `paused` label (already filtered out in buildDefs); user pauses are
      // handled at assignment time.
      if (pausesOn(pauses, dueDate).some((p) => p.scope === "global")) continue;
      const key = `${c.teamId}::${c.title}@${dueDate}`;
      correctKeys.add(key);
      if (existing.has(key)) continue;
      existing.add(key);
      plan.push({ c, dueDate });
    }
  }

  // RECONCILE: a template whose schedule changed (e.g. moved Thu -> Fri) leaves
  // its old-day chore orphaned. Archive future, not-yet-started, in-window
  // copies whose title still has a template but whose due date the current
  // schedule no longer produces. Past-due and in-progress copies are left alone.
  const titlesWithDef = new Set(defs.filter((c) => c.teamId).map((c) => `${c.teamId}::${c.title}`));
  // Catch-up chores are deliberately off-schedule make-ups — never reconcile them.
  const catchupTitles = new Set(
    defs.filter((c) => c.teamId && c.catchup).map((c) => `${c.teamId}::${c.title}`),
  );
  const toReconcile = [];
  for (const teamId of teamIds) {
    for (const n of ctx.spawned[teamId]) {
      if (!n.dueDate || n.dueDate < todayYmd || n.dueDate > horizonEnd) continue;
      if (!isOpen(n) || n.state?.type === "started") continue;
      if (!titlesWithDef.has(`${teamId}::${n.title}`)) continue; // no template -> leave it
      if (catchupTitles.has(`${teamId}::${n.title}`)) continue; // off-schedule make-up
      if (!correctKeys.has(`${teamId}::${n.title}@${n.dueDate}`)) toReconcile.push(n.id);
    }
  }

  // CLEANUP (replace policy): archive open copies whose due date is past, so
  // missed occurrences don't pile up. Skipped on an on-demand mid-week sync so
  // a not-yet-done chore from earlier in the week isn't swept away.
  const toArchive = [];
  if (!opts.skipCleanup) {
    for (const teamId of teamIds) {
      for (const n of ctx.spawned[teamId]) {
        if (!n.dueDate || n.dueDate >= todayYmd || !isOpen(n)) continue;
        const c = defs.find((x) => x.teamId === teamId && x.title === n.title);
        if (c && (c.onExisting || "replace") === "replace") toArchive.push(n.id);
      }
    }
  }

  // Rotation members available on a given day (paused users dropped).
  const allowedOn = (ymd) => {
    const out = pausedUserIdsOn(ymd);
    return rotation.filter((id) => !out.includes(id));
  };

  // Per-member weights (e.g. Alex 60 / Kristal 40) — the balancer compares
  // weighted load (minutes / weight) so the higher-weight member carries more.
  const resolveWeight = await getWeightResolver(env);
  const nameOf = (id) => {
    const u = users.find((x) => x.id === id);
    return u?.displayName || u?.name || "";
  };

  // ASSIGN per occurrence, balancing the week by weighted effort. Seed counts
  // from chores already assigned this week so mid-week re-runs stay balanced.
  if (rotation.length >= 2 && plan.length) {
    const [A, B] = rotation;
    const wt = { [A]: resolveWeight(nameOf(A)), [B]: resolveWeight(nameOf(B)) };
    // Balance by total effort (minutes), so a 60-min chore counts more than a
    // 5-min one. Unestimated chores use DEFAULT_EST_MIN -> ≈count-balancing.
    const counts = { [A]: 0, [B]: 0 };
    const weightOf = (c) => (c && c.estimate) || DEFAULT_EST_MIN;
    // Whoever has the lower weighted load (minutes / member-weight) goes next.
    const lower = () => (counts[A] / wt[A] <= counts[B] / wt[B] ? A : B);
    for (const teamId of teamIds) {
      for (const n of ctx.spawned[teamId]) {
        if (!isOpen(n) || !n.dueDate || n.dueDate < todayYmd || n.dueDate > horizonEnd) continue;
        const id = n.assignee?.id;
        if (id in counts) counts[id] += weightOf(defs.find((x) => x.teamId === teamId && x.title === n.title));
      }
    }
    const seed = localDate(base).weekIndex % 2 === 0 ? A : B;
    const bump = (id, w) => {
      if (id in counts) counts[id] += w;
    };
    // Fixed-owner chores: skip if that owner is paused that day, else assign.
    for (const e of plan) {
      if (!e.c.assigneeId) continue;
      if (pausedUserIdsOn(e.dueDate).includes(e.c.assigneeId)) { e.skip = true; continue; }
      e.assignee = e.c.assigneeId;
      bump(e.assignee, weightOf(e.c));
    }
    // Rotating chores: assign among the members present that day, weighted.
    for (const e of plan) {
      if (e.c.assigneeId || e.c.opposite || e.skip) continue;
      const allowed = allowedOn(e.dueDate);
      if (!allowed.length) { e.skip = true; continue; } // everyone paused — skip
      let cand;
      if (allowed.length === 1) cand = allowed[0];
      else if (counts[A] / wt[A] < counts[B] / wt[B]) cand = A;
      else if (counts[B] / wt[B] < counts[A] / wt[A]) cand = B;
      else {
        const last = ctx.lastByTitle[e.c.teamId]?.[e.c.title];
        cand = last === A ? B : last === B ? A : seed;
      }
      e.assignee = cand;
      bump(cand, weightOf(e.c));
    }
    for (const e of plan) {
      if (!e.c.opposite || e.skip) continue;
      const allowed = allowedOn(e.dueDate);
      if (!allowed.length) { e.skip = true; continue; }
      const sib = plan.find(
        (x) => x.c.teamId === e.c.teamId && x.c.title === e.c.opposite && x.dueDate === e.dueDate,
      );
      let cand;
      if (sib?.assignee != null) {
        const other = rotation.find((id) => id !== sib.assignee);
        cand = allowed.includes(other) ? other : allowed[0];
      } else {
        cand = allowed.length === 1 ? allowed[0] : lower();
      }
      e.assignee = cand;
      bump(cand, weightOf(e.c));
    }
  } else {
    // No rotation: keep fixed owners, but skip a fixed chore whose owner is paused.
    for (const e of plan) {
      if (e.c.assigneeId && pausedUserIdsOn(e.dueDate).includes(e.c.assigneeId)) { e.skip = true; continue; }
      e.assignee = e.c.assigneeId;
    }
  }

  // EXECUTE.
  for (const id of [...toArchive, ...toReconcile]) await archiveIssue(env, id);
  let created = 0;
  for (const e of plan) {
    if (e.skip) continue; // paused (user out / everyone out)
    const result = await createIssue(env, {
      teamId: e.c.teamId,
      title: e.c.title,
      description: withTemplateLink(e.c.description, e.c.templateUrl),
      dueDate: e.dueDate,
      labelIds: e.c.labelIds,
      assigneeId: e.assignee,
      stateId: ctx.todoStates[e.c.teamId],
      projectId,
    });
    if (result?.success) {
      created++;
      console.log(`Created recurring chore: ${e.c.title} (${result.issue?.identifier}) due ${e.dueDate}`);
    }
  }
  // Idempotent: existing occurrences are skipped, so re-runs only fill in gaps.
  // `moved` = chores archived because their template's schedule no longer
  // produces that day (e.g. a day change); `archived` = past-due cleanup.
  return { created, archived: toArchive.length, moved: toReconcile.length };
}

const ymdAdd1 = (ymd) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

// Create the "catch-up" make-ups owed after a (global) pause: for each template
// carrying the `catchup` label that had >=1 scheduled occurrence inside the
// pause window [start, min(end, returnDate)], create ONE unassigned chore due
// `returnDate`. Idempotent (skips a title already due that day). Returns the
// titles created.
export async function createCatchups(env, { start, end, returnDate }) {
  const defs = (await buildDefs(env)).filter((c) => c.catchup && c.teamId);
  if (!defs.length) return { created: 0, titles: [] };

  const windowEnd = end && end < returnDate ? end : returnDate;
  if (windowEnd < start) return { created: 0, titles: [] };

  // Which catchup chores actually fell due while we were away.
  const owed = defs.filter((c) => {
    let cur = start;
    for (let guard = 0; cur <= windowEnd && guard < 400; guard++) {
      if (isDueToday(c, new Date(`${cur}T12:00:00Z`))) return true;
      cur = ymdAdd1(cur);
    }
    return false;
  });
  if (!owed.length) return { created: 0, titles: [] };

  const projectName = env.CHORES_PROJECT || "House Chores";
  const projectId = await getProjectId(env, projectName);

  // Dedup against open chores already due on the return date.
  const teamIds = [...new Set(owed.map((c) => c.teamId))];
  const existing = new Set();
  const todoStates = {};
  for (const teamId of teamIds) {
    todoStates[teamId] = await getTodoStateId(env, teamId);
    for (const n of await fetchSpawned(env, teamId, projectName)) {
      if (n.dueDate) existing.add(`${teamId}::${n.title}@${n.dueDate}`);
    }
  }

  const titles = [];
  const span = windowEnd === start ? start : `${start}–${windowEnd}`;
  for (const c of owed) {
    if (existing.has(`${c.teamId}::${c.title}@${returnDate}`)) continue;
    const res = await createIssue(env, {
      teamId: c.teamId,
      title: c.title,
      description: withTemplateLink(
        `🧺 Catch-up after the ${span} pause — this chore accumulates while paused, so it needs doing now.\n\n${c.description || ""}`.trim(),
        c.templateUrl,
      ),
      dueDate: returnDate,
      labelIds: c.labelIds,
      stateId: todoStates[c.teamId], // unassigned & claimable, per design
      projectId,
    });
    if (res?.success) titles.push(c.title);
  }
  return { created: titles.length, titles };
}

// Monday housekeeping: any global pause that ended on its own (dated, now past,
// still active) gets its catch-ups created and is marked cleared so it won't
// fire again. Indefinite pauses are left for an explicit /chores resume.
export async function processExpiredPauses(env) {
  if (!env.DB) return { created: 0, titles: [] };
  const today = localDate(new Date()).ymd;
  const nowIso = new Date().toISOString();
  const titles = [];
  for (const p of await getActivePauses(env)) {
    if (p.scope !== "global" || p.end_date === "9999-12-31" || p.end_date >= today) continue;
    const r = await createCatchups(env, { start: p.start_date, end: p.end_date, returnDate: ymdAdd1(p.end_date) });
    titles.push(...r.titles);
    await markPauseCleared(env, p.id, nowIso, "expired");
  }
  return { created: titles.length, titles };
}

// "2026-09-01" -> "Sep 1, 2026"
function formatDate(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${MON_ABBR[m - 1]} ${d}, ${y}`;
}

// Human-readable cadence from a parsed chore config.
function describeSchedule(c) {
  const est = c.estimate ? ` · ~${c.estimate}m` : "";
  if (c.anyday) {
    const per = c.cadence === "biweekly" ? "every other week" : c.cadence === "triweekly" ? "every 3 weeks" : "week";
    const n = c.count || 1;
    return (n === 1 ? `Any day, once a ${per === "week" ? "week" : per}` : `${n}× per ${per}, flexible days`) + est;
  }
  return describeBase(c) + est;
}

function describeBase(c) {
  const days = (c.days || []).map((d) => d.charAt(0).toUpperCase() + d.slice(1, 3)).join(", ");
  const dom = c.dom === "middle" ? "the 15th" : c.dom === "last" ? "the last day" : "the 1st";
  const months = (c.months || []).map((m) => MON_ABBR[m - 1]).join(", ");
  const inMonths = months ? ` (${months})` : "";
  switch (c.cadence) {
    case "daily": return "Every day";
    case "weekly": return `Weekly on ${days || "—"}`;
    case "biweekly": return `Every other week on ${days || "—"}`;
    case "triweekly": return `Every 3 weeks on ${days || "—"}`;
    case "semi-monthly": return "Twice a month — the 1st & 15th";
    case "monthly": return `Monthly on ${dom}`;
    case "bimonthly": return `Every other month on ${dom}${inMonths}`;
    case "semi-annually": return `Twice a year on ${dom}${inMonths}`;
    case "annually": return `Once a year on ${dom}${inMonths}`;
    default: return "—";
  }
}

// Diagnostic: what the engine parses for the template matching `q` (by title).
export async function describeTemplate(env, q) {
  const project = env.RECURRING_PROJECT || "Recurring";
  const tpls = await fetchRecurringTemplates(env, project);
  const t = tpls.find((x) => x.title.toLowerCase().includes((q || "").toLowerCase()));
  if (!t) return { error: `no template matching "${q}"` };
  const { config } = parseLabelConfig(t.labels?.nodes || []);
  const descCfg = parseDescriptionConfig(t.description);
  const weeklyFamily = ["weekly", "biweekly", "triweekly"].includes(config.cadence);
  const anyday = weeklyFamily && !(config.days && config.days.length);
  const count = anyday ? descCfg.count || 1 : undefined;
  const chore = {
    cadence: config.cadence,
    days: anyday ? ANYDAY_SPREAD[count] : config.days,
    anyday,
    count,
    estimate: descCfg.estimate,
    dom: config.dom,
    months: config.months,
    weekPhase: descCfg.weekPhase,
    start: descCfg.start,
    end: descCfg.end,
    anchorWeek: descCfg.start ? localDate(new Date(`${descCfg.start}T12:00:00Z`)).weekIndex : undefined,
    anchorMonth: descCfg.start ? monthIndexOf(descCfg.start) : undefined,
  };
  return {
    title: t.title,
    rawLabels: (t.labels?.nodes || []).map((l) => l.name),
    parsedCadence: config.cadence || null,
    dom: config.dom || null,
    months: config.months || null,
    schedule: describeSchedule(chore),
    next: nextOccurrences(chore, 5),
  };
}

// The next `count` due dates for a chore (scans up to ~400 days; pure compute).
function nextOccurrences(chore, count, skip) {
  const out = [];
  const base = new Date();
  for (let d = 0; d < 400 && out.length < count; d++) {
    const day = new Date(base.getTime() + d * 86_400_000);
    if (!isDueToday(chore, day)) continue;
    const ymd = localDate(day).ymd;
    if (skip && skip(ymd)) continue; // e.g. a global hold window
    out.push(ymd);
  }
  return out;
}

// Add/refresh a "Schedule" comment on each template describing its cadence and
// next due dates. Comments aren't copied to spawned chores. Skips unchanged
// comments to avoid notification noise.
export async function annotateTemplates(env) {
  const projectName = env.RECURRING_PROJECT || "Recurring";
  const templates = await fetchTemplatesForAnnotation(env, projectName);

  // Active global holds make the schedule comment hold-aware: note the pause and
  // show the first dates that fall *after* it. Never let a pauses/DB hiccup kill
  // the whole annotation run.
  const todayYmd = localDate(new Date()).ymd;
  let globalHolds = [];
  try {
    globalHolds = (await getActivePauses(env)).filter(
      (p) => p.scope === "global" && p.end_date >= todayYmd,
    );
  } catch (err) {
    console.error("annotate: getActivePauses failed, ignoring holds:", err);
  }
  const isHeld = (ymd) => globalHolds.some((h) => ymd >= h.start_date && ymd <= h.end_date);
  const holdNote = globalHolds.length
    ? "\n" +
      globalHolds
        .map((h) => `⏸️ _Household paused ${h.end_date === "9999-12-31" ? "until resumed" : `until ${formatDate(h.end_date)}`}_`)
        .join("\n")
    : "";

  // Only edit comments we authored; otherwise create a fresh one (Linear blocks
  // editing another user's comment — e.g. older comments authored by a person
  // before the API key was switched to the bot).
  let viewerId = null;
  try {
    viewerId = await getViewerId(env);
  } catch (err) {
    console.error("annotate: getViewerId failed:", err);
  }

  const report = [];
  for (const t of templates) {
   try {
    const { config } = parseLabelConfig(t.labels?.nodes || []);
    if (!config.cadence) { report.push({ title: t.title, action: "no-cadence", labels: (t.labels?.nodes || []).map((l) => l.name) }); continue; }
    const descCfg = parseDescriptionConfig(t.description);

    const head = `${SCHEDULE_MARKER} _(auto-generated; not copied to spawned chores)_\n`;
    let body;
    if (config.paused) {
      body = `${head}⏸️ Paused — scheduling disabled. Remove the \`paused\` label to resume.`;
    } else {
      const weeklyFamily = ["weekly", "biweekly", "triweekly"].includes(config.cadence);
      const anyday = weeklyFamily && !(config.days && config.days.length);
      const count = anyday ? descCfg.count || 1 : undefined;
      const chore = {
        cadence: config.cadence,
        days: anyday ? ANYDAY_SPREAD[count] : config.days,
        anyday,
        count,
        estimate: descCfg.estimate,
        dom: config.dom,
        months: config.months,
        weekPhase: descCfg.weekPhase,
        start: descCfg.start,
        end: descCfg.end,
        anchorWeek: descCfg.start
          ? localDate(new Date(`${descCfg.start}T12:00:00Z`)).weekIndex
          : undefined,
        anchorMonth: descCfg.start ? monthIndexOf(descCfg.start) : undefined,
      };
      const next = nextOccurrences(chore, 3, isHeld).map(formatDate);
      const win = [];
      if (chore.start) win.push(`from ${formatDate(chore.start)}`);
      if (chore.end) win.push(`until ${formatDate(chore.end)}`);
      const winNote = win.length ? `\n_Active ${win.join(" ")}_` : "";
      body = `${head}${describeSchedule(chore)}${winNote}${holdNote}\n**Next:** ${next.join(" · ") || "—"}`;
    }

    const sched = (t.comments?.nodes || []).filter((c) => c.body?.startsWith(SCHEDULE_MARKER));
    // Prefer our own comment; if we don't own one, create a fresh one.
    const existing = viewerId ? sched.find((c) => c.user?.id === viewerId) || null : sched[0] || null;
    if (existing?.body === body) { report.push({ title: t.title, cadence: config.cadence, action: "unchanged" }); continue; }
    const res = await upsertComment(env, t.id, existing?.id, body);
    report.push({ title: t.title, cadence: config.cadence, action: existing ? "updated" : "created", ok: res?.success ?? null });
   } catch (err) {
     console.error(`annotate: failed for "${t.title}":`, err);
     report.push({ title: t.title, action: "error", error: String(err?.message || err) });
   }
  }
  return report;
}
