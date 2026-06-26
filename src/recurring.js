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
//   day-of-month label (monthly/bimonthly/semi-annually/annually): first | middle | last
//                               -> 1st / 15th / last day of month
//   skip | replace (| always)   (optional collision policy; default replace)
//
//   Description directives (optional; parsed then stripped from the copy):
//     month: june          which month(s) for annually/semi-annually/bimonthly
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
  getLastAssignee,
  getIssueByIdentifier,
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
    } else {
      passthroughLabelIds.push(l.id); // a real label (room, etc.)
    }
  }
  return { config, passthroughLabelIds };
}

// month/week/dueafter live in the description; parsed then stripped from body.
const DESC_DIRECTIVE_RE = /^\s*(month|week|dueafter)\s*:/i;
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

function lastDayOfMonth(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
}

// first -> 1, middle -> 15, last -> last day; default first.
function targetDayOfMonth(chore, now) {
  if (chore.dom === "middle") return 15;
  if (chore.dom === "last") return lastDayOfMonth(now);
  return 1;
}

// Week number off the epoch; biweekly uses %2, triweekly uses %3, against the
// chore's chosen phase. Default phase 0.
function weekIndex(now) {
  const dayCount = Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 86_400_000,
  );
  return Math.floor(dayCount / 7);
}

function isDueToday(chore, now) {
  const weekday = now.getUTCDay();
  const dom = now.getUTCDate();
  const month = now.getUTCMonth() + 1;
  const onWeekday = (chore.days || []).map((d) => WEEKDAYS[d]).includes(weekday);
  const onTargetDay = dom === targetDayOfMonth(chore, now);
  const inMonths = (fallback) =>
    (chore.months?.length ? chore.months : fallback).includes(month);

  switch (chore.cadence) {
    case "daily":
      return true;
    case "weekly":
      return onWeekday;
    case "biweekly":
      return onWeekday && weekIndex(now) % 2 === (chore.weekPhase ?? 0);
    case "triweekly":
      return onWeekday && weekIndex(now) % 3 === (chore.weekPhase ?? 0);
    case "semi-monthly":
      return dom === 1 || dom === 15; // 1st and 15th
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
        months: descCfg.months,
        weekPhase: descCfg.weekPhase,
        dueAfterDays: descCfg.dueAfterDays,
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

  const today = new Date().toISOString().slice(0, 10);
  const result = await createIssue(env, {
    teamId: issue.team.id,
    title: issue.title,
    description: issue.description,
    dueDate: today,
    labelIds: (issue.labels?.nodes || []).map((l) => l.id),
    assigneeId,
  });
  if (result?.success) {
    console.log(`Replaced ${identifier} -> ${result.issue?.identifier}`);
  }
  return { ok: !!result?.success, identifier: result?.issue?.identifier };
}

export async function runRecurring(env) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const defs = (await buildDefs(env)).filter((c) => isDueToday(c, now));
  if (!defs.length) return;

  // Resolve the rotation roster once (if configured).
  let rotation = [];
  if (env.ROTATION_MEMBERS) {
    rotation = matchMembers(env.ROTATION_MEMBERS, await getUsers(env));
    if (rotation.length < 2) {
      console.warn(`Rotation disabled: matched ${rotation.length} member(s), need 2.`);
      rotation = [];
    }
  }

  for (const c of defs) {
    if (!c.teamId) {
      console.error(`Recurring "${c.title}": could not resolve a team.`);
      continue;
    }

    // Collision policy against any still-open spawned copy.
    const strategy = c.onExisting || "replace";
    if (strategy !== "always") {
      const open = await findOpenIssuesByTitle(env, c.teamId, c.title);
      if (open.length) {
        if (strategy === "skip") {
          console.log(`Skipping "${c.title}" — ${open.length} still open.`);
          continue;
        }
        if (strategy === "replace") {
          for (const issue of open) await archiveIssue(env, issue.id);
          console.log(`Replaced ${open.length} stale "${c.title}".`);
        }
      }
    }

    const dueDate = c.dueAfterDays
      ? new Date(Date.now() + c.dueAfterDays * 86_400_000).toISOString().slice(0, 10)
      : today;

    // Explicit template assignee is fixed; otherwise alternate from last time.
    let assigneeId = c.assigneeId;
    if (!assigneeId && rotation.length >= 2) {
      const last = await getLastAssignee(env, c.teamId, c.title);
      const idx = rotation.indexOf(last); // -1 if none/unknown -> starts at [0]
      assigneeId = rotation[(idx + 1) % rotation.length];
    }

    const result = await createIssue(env, {
      teamId: c.teamId,
      title: c.title,
      description: c.description,
      dueDate,
      labelIds: c.labelIds,
      assigneeId,
    });
    if (result?.success) {
      console.log(`Created recurring chore: ${c.title} (${result.issue?.identifier})`);
    }
  }
}
