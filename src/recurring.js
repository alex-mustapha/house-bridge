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
//   month labels (annually/semi-annually/bimonthly; pick any): january .. december
//   day-of-month label (monthly/bimonthly/semi-annually/annually): first | middle | last
//                               -> 1st / 15th / last day of month
//   skip | replace (| always)   (optional collision policy; default replace)
//
//   Description directives (optional; parsed then stripped from the copy):
//     month: june          alternative to month labels (which month(s))
//     week: even | odd      which week for biweekly (default even/0)
//     week: 0 | 1 | 2       which week for triweekly (default 0)
//     dueafter: 2           due date N days out (default today)
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
} from "./linear.js";

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
    } else {
      passthroughLabelIds.push(l.id); // a real label (room, etc.)
    }
  }
  return { config, passthroughLabelIds };
}

// Combine month labels and any `month:` description directive into a deduped list.
function mergeMonths(a, b) {
  const set = [...new Set([...(a || []), ...(b || [])])];
  return set.length ? set : undefined;
}

// month/week/dueafter/opposite live in the description; parsed then stripped.
const DESC_DIRECTIVE_RE = /^\s*(month|week|dueafter|opposite)\s*:/i;
function parseDescriptionConfig(description) {
  const cfg = {};
  if (!description) return cfg;

  const monthLine = description.match(/^\s*month\s*:\s*(.+)$/im);
  if (monthLine) {
    const months = monthLine[1]
      .split(/[,\s]+/)
      .map((s) => MONTHS[s.toLowerCase()] || parseInt(s, 10))
      .filter((n) => n >= 1 && n <= 12);
    if (months.length) cfg.months = months;
  }
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

function isDueToday(chore, now) {
  const L = localDate(now);
  const onWeekday = (chore.days || []).map((d) => WEEKDAYS[d]).includes(L.weekday);
  const onTargetDay = L.dom === targetDayOfMonth(chore, L);
  const inMonths = (fallback) =>
    (chore.months?.length ? chore.months : fallback).includes(L.month);

  switch (chore.cadence) {
    case "daily":
      return true;
    case "weekly":
      return onWeekday;
    case "biweekly":
      return onWeekday && L.weekIndex % 2 === (chore.weekPhase ?? 0);
    case "triweekly":
      return onWeekday && L.weekIndex % 3 === (chore.weekPhase ?? 0);
    case "semi-monthly":
      return L.dom === 1 || L.dom === 15; // 1st and 15th
    case "monthly":
      return onTargetDay;
    case "bimonthly":
      return inMonths([1, 3, 5, 7, 9, 11]) && onTargetDay;
    case "semi-annually":
      return inMonths([1, 7]) && onTargetDay;
    case "annually":
      return inMonths([1]) && onTargetDay;
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
      const descCfg = parseDescriptionConfig(t.description);
      defs.push({
        title: t.title,
        teamId: t.team?.id,
        labelIds: passthroughLabelIds,
        description: stripDescription(t.description),
        onExisting: config.onExisting || "replace",
        cadence: config.cadence,
        days: config.days,
        dom: config.dom,
        months: mergeMonths(config.months, descCfg.months),
        weekPhase: descCfg.weekPhase,
        dueAfterDays: descCfg.dueAfterDays,
        opposite: descCfg.opposite, // assign opposite of this chore's owner
        assigneeId: t.assignee?.id, // explicit owner on the template = fixed
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
export async function runWeek(env) {
  const defs = await buildDefs(env);
  if (!defs.length) return;

  let rotation = [];
  if (env.ROTATION_MEMBERS) {
    rotation = matchMembers(env.ROTATION_MEMBERS, await getUsers(env));
    if (rotation.length < 2) {
      console.warn(`Rotation disabled: matched ${rotation.length} member(s), need 2.`);
      rotation = [];
    }
  }

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
  // occurrence that already exists.
  const plan = [];
  for (let d = 0; d < 7; d++) {
    const L = localDate(new Date(base.getTime() + d * 86_400_000));
    for (const c of defs) {
      if (!c.teamId || !isDueToday(c, new Date(`${L.ymd}T12:00:00Z`))) continue;
      const dueDate = c.dueAfterDays
        ? new Date(Date.UTC(L.year, L.month - 1, L.dom) + c.dueAfterDays * 86_400_000)
            .toISOString()
            .slice(0, 10)
        : L.ymd;
      const key = `${c.teamId}::${c.title}@${dueDate}`;
      if (existing.has(key)) continue;
      existing.add(key);
      plan.push({ c, dueDate });
    }
  }

  // CLEANUP (replace policy): archive open copies whose due date is past, so
  // missed occurrences don't pile up.
  const toArchive = [];
  for (const teamId of teamIds) {
    for (const n of ctx.spawned[teamId]) {
      if (!n.dueDate || n.dueDate >= todayYmd || !isOpen(n)) continue;
      const c = defs.find((x) => x.teamId === teamId && x.title === n.title);
      if (c && (c.onExisting || "replace") === "replace") toArchive.push(n.id);
    }
  }

  // ASSIGN per occurrence, balancing the week ≈50/50. Seed counts from chores
  // already assigned this week so mid-week re-runs stay balanced.
  if (rotation.length >= 2 && plan.length) {
    const [A, B] = rotation;
    const counts = { [A]: 0, [B]: 0 };
    for (const teamId of teamIds) {
      for (const n of ctx.spawned[teamId]) {
        if (!isOpen(n) || !n.dueDate || n.dueDate < todayYmd || n.dueDate > horizonEnd) continue;
        const id = n.assignee?.id;
        if (id in counts) counts[id]++;
      }
    }
    const seed = localDate(base).weekIndex % 2 === 0 ? A : B;
    const bump = (id) => {
      if (id in counts) counts[id]++;
    };
    for (const e of plan) {
      if (e.c.assigneeId) {
        e.assignee = e.c.assigneeId;
        bump(e.assignee);
      }
    }
    for (const e of plan) {
      if (e.c.assigneeId || e.c.opposite) continue;
      let cand;
      if (counts[A] < counts[B]) cand = A;
      else if (counts[B] < counts[A]) cand = B;
      else {
        const last = ctx.lastByTitle[e.c.teamId]?.[e.c.title];
        cand = last === A ? B : last === B ? A : seed;
      }
      e.assignee = cand;
      bump(cand);
    }
    for (const e of plan) {
      if (!e.c.opposite) continue;
      const sib = plan.find(
        (x) => x.c.teamId === e.c.teamId && x.c.title === e.c.opposite && x.dueDate === e.dueDate,
      );
      const cand =
        sib?.assignee != null
          ? rotation.find((id) => id !== sib.assignee) ?? sib.assignee
          : counts[A] <= counts[B] ? A : B;
      e.assignee = cand;
      bump(cand);
    }
  } else {
    for (const e of plan) e.assignee = e.c.assigneeId;
  }

  // EXECUTE.
  for (const id of toArchive) await archiveIssue(env, id);
  for (const e of plan) {
    const result = await createIssue(env, {
      teamId: e.c.teamId,
      title: e.c.title,
      description: e.c.description,
      dueDate: e.dueDate,
      labelIds: e.c.labelIds,
      assigneeId: e.assignee,
      stateId: ctx.todoStates[e.c.teamId],
      projectId,
    });
    if (result?.success) {
      console.log(`Created recurring chore: ${e.c.title} (${result.issue?.identifier}) due ${e.dueDate}`);
    }
  }
}
