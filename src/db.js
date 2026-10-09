// Long-term chore analytics in Cloudflare D1 (free tier). The Monday recap
// snapshots recent chore outcomes (upsert by issue id); /stats queries them.

import { getTeamId, fetchChoreHistory } from "./linear.js";
import { localDate } from "./recurring.js";

const SCHEMA = `CREATE TABLE IF NOT EXISTS chore_log (
  id TEXT PRIMARY KEY,
  title TEXT,
  assignee TEXT,
  due_date TEXT,
  completed_date TEXT,
  status TEXT,
  recorded_at TEXT
)`;

async function ensureSchema(env) {
  await env.DB.prepare(SCHEMA).run();
}

// on_time / late / missed / open. Completion is compared in Eastern (not UTC),
// so an evening-of-the-due-day finish counts as on time.
// `canceled` is its own outcome on purpose: a chore you decided not to do is
// neither work completed nor work missed. Folding it into either misreports
// what happened — counting it done inflates the record, counting it missed
// punishes a deliberate call.
function statusOf(completedYmd, dueDate, today, stateType) {
  if (stateType === "canceled") return "canceled";
  if (completedYmd) return completedYmd <= dueDate ? "on_time" : "late";
  return dueDate < today ? "missed" : "open";
}

// Snapshot the last 30 days of chore outcomes into D1, upserting by issue id so
// re-runs and late completions update in place. Run weekly (Monday recap).
export async function logChores(env) {
  if (!env.DB) return;
  await ensureSchema(env);

  const teamId = await getTeamId(env, env.CHORES_TEAM || "CHO");
  if (!teamId) return;
  const today = localDate(new Date()).ymd;
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const history = (await fetchChoreHistory(env, teamId, since)).filter(
    (h) => h.dueDate && h.identifier,
  );
  if (!history.length) return;

  const now = new Date().toISOString();
  const stmts = history.map((h) => {
    const completedYmd = h.completedAt ? localDate(new Date(h.completedAt)).ymd : null;
    return env.DB.prepare(
      `INSERT INTO chore_log (id, title, assignee, due_date, completed_date, status, recorded_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT(id) DO UPDATE SET
         title = ?2, assignee = ?3, due_date = ?4,
         completed_date = ?5, status = ?6, recorded_at = ?7`,
    ).bind(
      h.identifier,
      h.title || "",
      h.assignee?.name || null,
      h.dueDate,
      completedYmd,
      statusOf(completedYmd, h.dueDate, today, h.state?.type),
      now,
    );
  });
  await env.DB.batch(stmts);
  console.log(`Logged ${stmts.length} chore outcomes to D1.`);
}

const MON_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Trend buckets for the range: daily (≤10d), weekly (≤120d), monthly (a year).
// Oldest -> newest. Split out from the tallying so the same buckets can be
// scored per person as well as for the household — comparing two lines on one
// set of buckets is the whole point.
function trendBuckets(today, days) {
  const shift = (n) => {
    const [y, m, dd] = today.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, dd - n)).toISOString().slice(0, 10);
  };
  const out = [];
  if (days <= 10) {
    for (let i = days - 1; i >= 0; i--) {
      const day = shift(i);
      out.push({ label: day.slice(5), lo: day, hi: day });
    }
  } else if (days <= 120) {
    const weeks = Math.ceil(days / 7);
    for (let w = weeks - 1; w >= 0; w--) {
      out.push({ label: shift(w * 7).slice(5), lo: shift(w * 7 + 6), hi: shift(w * 7) });
    }
  } else {
    const [cy, cm] = today.split("-").map(Number);
    for (let m = 11; m >= 0; m--) {
      const idx = cm - 1 - m;
      const y = cy + Math.floor(idx / 12);
      const mo = ((idx % 12) + 12) % 12;
      const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
      out.push({
        label: MON_ABBR[mo],
        lo: `${y}-${String(mo + 1).padStart(2, "0")}-01`,
        hi: `${y}-${String(mo + 1).padStart(2, "0")}-${String(last).padStart(2, "0")}`,
      });
    }
  }
  return out;
}

// Completion % for one bucket, or null when nothing was due (so the line gaps
// rather than plotting a misleading 0%).
function pctIn(rows, { lo, hi }) {
  let done = 0;
  let miss = 0;
  for (const r of rows) {
    if (r.due < lo || r.due > hi) continue;
    if (r.status === "on_time" || r.status === "late") done++;
    else if (r.status === "missed") miss++;
  }
  const t = done + miss;
  return t ? Math.round((done / t) * 100) : null;
}

// Whole days between two YYYY-MM-DD dates (UTC midnights — DST can't skew it).
function daysBetween(from, to) {
  const ms = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

// How late things actually were, rather than a binary late/on-time. One day late
// and two weeks late are very different, and collapsing them hides whether
// things are drifting further out or tightening up.
const LATE_BUCKETS = [
  { label: "On time", test: (d) => d <= 0 },
  { label: "1 day", test: (d) => d === 1 },
  { label: "2–3 days", test: (d) => d >= 2 && d <= 3 },
  { label: "4–7 days", test: (d) => d >= 4 && d <= 7 },
  { label: "8+ days", test: (d) => d >= 8 },
];

function buildLateness(rows, today) {
  const counts = LATE_BUCKETS.map((b) => ({ label: b.label, n: 0 }));
  let neverDone = 0;
  const perPerson = {};
  const allLate = [];
  for (const r of rows) {
    const who = r.assignee || "Unassigned";
    const p = (perPerson[who] ||= { late: [], onTime: 0, missed: 0 });
    if (r.status === "canceled") continue; // deliberately dropped — not late, not missed
    if (r.status === "missed") {
      neverDone++;
      p.missed++;
      continue;
    }
    if (!r.done) continue; // completed but no date recorded — can't measure
    const late = Math.max(0, daysBetween(r.due, r.done));
    const idx = LATE_BUCKETS.findIndex((b) => b.test(late));
    if (idx >= 0) counts[idx].n++;
    if (late > 0) {
      allLate.push(late);
      p.late.push(late);
    } else p.onTime++;
  }
  const avg = (a) => (a.length ? Math.round((a.reduce((s, n) => s + n, 0) / a.length) * 10) / 10 : null);
  const median = (a) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
  };
  return {
    buckets: [...counts, { label: "Never done", n: neverDone }],
    avgDaysLate: avg(allLate),
    medianDaysLate: median(allLate),
    worstDaysLate: allLate.length ? Math.max(...allLate) : null,
    byPerson: Object.entries(perPerson)
      .map(([name, v]) => ({
        name,
        lateCount: v.late.length,
        onTime: v.onTime,
        missed: v.missed,
        avgDaysLate: avg(v.late),
        worstDaysLate: v.late.length ? Math.max(...v.late) : null,
      }))
      .sort((a, b) => (b.avgDaysLate || 0) - (a.avgDaysLate || 0)),
  };
}

// Everything the /dashboard page needs, over the last `days` days. `estimateOf`
// (title -> minutes) powers the effort split.
export async function queryDashboard(env, estimateOf, days = 30) {
  if (!env.DB) return null;
  await ensureSchema(env);
  const today = localDate(new Date()).ymd;
  const shift = (n) => {
    const [y, m, dd] = today.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, dd - n)).toISOString().slice(0, 10);
  };
  // Fetch enough for both the range and the streak walk-back (~41 days).
  const lookback = Math.max(days, 60);
  const rows =
    (
      await env.DB.prepare(
        `SELECT title, assignee, due_date AS due, completed_date AS done, status
         FROM chore_log WHERE due_date >= ?1 AND status != 'open'`,
      )
        .bind(shift(lookback - 1))
        .all()
    ).results || [];

  const since = shift(days - 1);
  const est = (t) => (estimateOf ? estimateOf(t) : 15);

  const summary = { done: 0, onTime: 0, late: 0, missed: 0, canceled: 0 };
  const byPerson = {};
  const effort = {};
  const missCount = {};
  const dayMap = {}; // person -> { due -> hasMiss }  (full lookback, for streaks)
  for (const r of rows) {
    const who = r.assignee || "Unassigned";
    (dayMap[who] ||= {});
    dayMap[who][r.due] = dayMap[who][r.due] || r.status === "missed";
    if (r.due < since) continue; // range window for the tallies below
    if (r.status === "missed") missCount[r.title] = (missCount[r.title] || 0) + 1;
    const p = (byPerson[who] ||= { onTime: 0, late: 0, missed: 0, canceled: 0 });
    if (r.status === "on_time") { summary.done++; summary.onTime++; p.onTime++; }
    else if (r.status === "late") { summary.done++; summary.late++; p.late++; }
    else if (r.status === "missed") { summary.missed++; p.missed++; }
    else if (r.status === "canceled") { summary.canceled++; p.canceled++; }
    if ((r.status === "on_time" || r.status === "late") && r.assignee) {
      effort[r.assignee] = (effort[r.assignee] || 0) + est(r.title);
    }
  }
  // Cancelled work is deliberately outside the completion ratio — it's neither
  // credit nor failure. It's reported as its own number so a rising cancel
  // count can't quietly pass for a rising completion rate.
  const resolved = summary.done + summary.missed;
  summary.completionPct = resolved ? Math.round((summary.done / resolved) * 100) : 0;
  summary.onTimePct = summary.done ? Math.round((summary.onTime / summary.done) * 100) : 0;

  // Per-person streak (range-independent): walk back from yesterday.
  const streaks = {};
  for (const who of Object.keys(dayMap)) {
    let s = 0;
    for (let n = 1; n <= 41; n++) {
      const hasMiss = dayMap[who][shift(n)];
      if (hasMiss === undefined) continue;
      if (hasMiss) break;
      s++;
    }
    streaks[who] = s;
  }

  const missed = Object.entries(missCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([title, n]) => ({ title, n }));

  // One set of buckets scored per person, so each line is directly comparable —
  // an individual's improvement shows up on their own line instead of being
  // averaged into a single household number.
  const inRange = rows.filter((r) => r.due >= since);
  const buckets = trendBuckets(today, days);
  const names = [...new Set(inRange.map((r) => r.assignee).filter(Boolean))].sort();
  const trendByPerson = names.map((name) => {
    const mine = inRange.filter((r) => r.assignee === name);
    return { name, points: buckets.map((b) => pctIn(mine, b)) };
  });

  return {
    days,
    summary,
    byPerson: Object.entries(byPerson).map(([name, v]) => ({ name, ...v })),
    trendLabels: buckets.map((b) => b.label),
    trendByPerson,
    // Household line kept for the overall shape; drawn faintly behind the
    // per-person ones rather than instead of them.
    trend: buckets.map((b) => ({ label: b.label, pct: pctIn(inRange, b) })),
    lateness: buildLateness(inRange, today),
    // How often chores have needed another pass — the counterpart to
    // completion %, which can't see work that was finished but not finished
    // properly.
    needsWork: await detailFlagStats(env, since).catch(() => null),
    missed,
    effort: Object.entries(effort).map(([name, minutes]) => ({ name, minutes })),
    streaks,
  };
}

// Aggregate stats over the last `days` days (excludes still-open occurrences).
export async function queryStats(env, days) {
  if (!env.DB) return null;
  await ensureSchema(env);
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const byPerson =
    (
      await env.DB.prepare(
        `SELECT COALESCE(assignee, 'Unassigned') person, status, COUNT(*) n
         FROM chore_log WHERE due_date >= ?1 AND status != 'open'
         GROUP BY person, status`,
      )
        .bind(since)
        .all()
    ).results || [];

  const missed =
    (
      await env.DB.prepare(
        `SELECT title, COUNT(*) n FROM chore_log
         WHERE due_date >= ?1 AND status = 'missed'
         GROUP BY title ORDER BY n DESC LIMIT 5`,
      )
        .bind(since)
        .all()
    ).results || [];

  return { days, byPerson, missed };
}

// ---------------------------------------------------------------------------
// Leisure log — "were my chores done before I started my own time?"
//
// Personal, not a household scoreboard: rows are per person, the slash command
// replies privately, and the dashboard only renders this when explicitly asked
// for one person. Nothing about it reaches the shared digest or recap.
//
// `source` is deliberately open ("self" today) so an automatic writer — Discord
// presence, a console integration — can log the same shape later without a
// schema change or any dashboard rework.
const LEISURE_SCHEMA = `CREATE TABLE IF NOT EXISTS leisure_log (
  id TEXT PRIMARY KEY,
  person TEXT NOT NULL,
  started_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  local_time TEXT,
  chores_total INTEGER,
  chores_done INTEGER,
  overdue INTEGER,
  clear INTEGER,
  source TEXT,
  note TEXT
)`;

async function ensureLeisureSchema(env) {
  await env.DB.prepare(LEISURE_SCHEMA).run();
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS leisure_person_date ON leisure_log (person, local_date)`,
  ).run();
}

// Record the day's leisure start. ONE ROW PER PERSON PER DAY, keyed on the local
// date: the question being tracked is "did I start my own time with the day's
// chores done", which is a daily yes/no — so the FIRST start of the day is what
// counts and later runs can't change it. Keying per session instead would let a
// single evening contribute several data points, and would quietly flatter the
// percentage on days you happened to log more than once.
//
// Returns { created, row } so the caller can tell you it's already recorded
// rather than silently doing nothing.
export async function logLeisure(env, s) {
  if (!env.DB) return null;
  await ensureLeisureSchema(env);
  const id = `${s.person}:${s.localDate}`;
  const existing = (
    await env.DB.prepare(
      `SELECT local_time AS time, chores_total AS total, chores_done AS done,
              overdue, clear, note FROM leisure_log WHERE id = ?1`,
    )
      .bind(id)
      .first()
  ) || null;
  if (existing) return { created: false, row: existing };

  await env.DB.prepare(
    `INSERT INTO leisure_log
       (id, person, started_at, local_date, local_time, chores_total, chores_done, overdue, clear, source, note)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(
      id,
      s.person,
      s.startedAt,
      s.localDate,
      s.localTime || null,
      s.choresTotal ?? 0,
      s.choresDone ?? 0,
      s.overdue ?? 0,
      s.clear ? 1 : 0,
      s.source || "self",
      s.note || null,
    )
    .run();
  return { created: true, row: null };
}

// Leisure history for one person: how often their slate was clear when they
// started, the current run of clear starts, and the recent sessions.
export async function queryLeisure(env, person, days = 30) {
  if (!env.DB || !person) return null;
  await ensureLeisureSchema(env);
  const today = localDate(new Date()).ymd;
  const [y, m, d] = today.split("-").map(Number);
  const since = new Date(Date.UTC(y, m - 1, d - (days - 1))).toISOString().slice(0, 10);
  const rows =
    (
      await env.DB.prepare(
        `SELECT local_date AS date, local_time AS time, chores_total AS total,
                chores_done AS done, overdue, clear, source, note
         FROM leisure_log WHERE person = ?1 AND local_date >= ?2
         ORDER BY started_at DESC`,
      )
        .bind(person, since)
        .all()
    ).results || [];

  const total = rows.length; // one row per day, so this is "days logged"
  const clear = rows.filter((r) => r.clear).length;
  // Consecutive logged days that started clear, most recent first. Days with no
  // entry are simply absent rather than counted against you — not logging isn't
  // evidence of a bad day, so a gap neither breaks nor extends the run.
  let streak = 0;
  for (const r of rows) {
    if (!r.clear) break;
    streak++;
  }
  // Clear-rate per bucket, on the same buckets the chore trend uses, so the two
  // charts line up and you can see whether the habit tracks completion.
  const buckets = trendBuckets(today, days);
  const points = buckets.map((b) => {
    const inB = rows.filter((r) => r.date >= b.lo && r.date <= b.hi);
    return inB.length ? Math.round((inB.filter((r) => r.clear).length / inB.length) * 100) : null;
  });

  // When the day actually wound down. Times after midnight belong to the night
  // before, so anything before 4am is pushed past 24:00 — otherwise a 12:30am
  // finish plots as the earliest evening of the week instead of the latest.
  const DAY_BREAK = 4 * 60;
  const toMinutes = (t) => {
    if (!t || !/^\d{1,2}:\d{2}/.test(t)) return null;
    const [h, m] = t.split(":").map(Number);
    const mins = h * 60 + m;
    return mins < DAY_BREAK ? mins + 24 * 60 : mins;
  };
  const fmt = (mins) => {
    if (mins === null || mins === undefined) return null;
    const wrapped = Math.round(mins) % (24 * 60);
    const h24 = Math.floor(wrapped / 60);
    const m = wrapped % 60;
    const ampm = h24 >= 12 ? "pm" : "am";
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${h12}:${String(m).padStart(2, "0")}${ampm}`;
  };
  const startTimes = [...rows]
    .reverse() // oldest -> newest, so the chart reads left to right
    .map((r) => ({ date: r.date, minutes: toMinutes(r.time), clear: !!r.clear }))
    .filter((r) => r.minutes !== null);
  const mins = startTimes.map((r) => r.minutes).sort((a, b) => a - b);
  const median = mins.length
    ? mins.length % 2
      ? mins[(mins.length - 1) / 2]
      : (mins[mins.length / 2 - 1] + mins[mins.length / 2]) / 2
    : null;
  // Split by outcome: does the evening start earlier when the chores are done?
  const avgOf = (sel) => {
    const a = startTimes.filter(sel).map((r) => r.minutes);
    return a.length ? a.reduce((s, n) => s + n, 0) / a.length : null;
  };

  return {
    person,
    days,
    total,
    clear,
    clearPct: total ? Math.round((clear / total) * 100) : null,
    streak,
    labels: buckets.map((b) => b.label),
    points,
    startTimes,
    medianStart: fmt(median),
    earliestStart: fmt(mins[0]),
    latestStart: fmt(mins[mins.length - 1]),
    avgStartClear: fmt(avgOf((r) => r.clear)),
    avgStartNotClear: fmt(avgOf((r) => !r.clear)),
    recent: rows.slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// "Missed a detail" notes — APPEND-ONLY.
//
// Raised when someone notices the last pass of a chore left something out. The
// reminder is aimed at whoever did it: the next time that chore falls to them
// they're told to check the checklist. The chore itself stays done.
//
// Every raise is kept as its own row rather than upserting one row per
// (chore, person). An upsert answers "is there an outstanding note?" but
// destroys "how often has this chore needed another pass?", which is the more
// interesting question once there's a few months of it. The outstanding note
// is simply the most recent row for that pair.
const DETAIL_LOG_SCHEMA = `CREATE TABLE IF NOT EXISTS chore_detail_log (
  id TEXT PRIMARY KEY,
  title_key TEXT NOT NULL,
  person_key TEXT NOT NULL,
  title TEXT,
  person TEXT,
  flagged_at TEXT NOT NULL,
  flagged_by TEXT,
  note TEXT
)`;

async function ensureDetailLog(env) {
  await env.DB.prepare(DETAIL_LOG_SCHEMA).run();
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS detail_log_pair ON chore_detail_log (title_key, person_key)`,
  ).run();
}

export async function flagChoreDetail(env, { title, person, by, note } = {}) {
  if (!env.DB || !title || !person) return null;
  await ensureDetailLog(env);
  const at = new Date().toISOString();
  const titleKey = title.toLowerCase();
  const personKey = person.toLowerCase();
  await env.DB.prepare(
    `INSERT INTO chore_detail_log
       (id, title_key, person_key, title, person, flagged_at, flagged_by, note)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(`${titleKey}::${personKey}::${at}`, titleKey, personKey, title, person, at, by || null, note || null)
    .run();
  return { title, person, flaggedAt: at };
}

// Removes the most recent note for a chore (optionally for one person) — for
// retracting one raised by mistake. Older entries are left alone so the
// frequency history stays intact.
export async function clearChoreDetail(env, title, person) {
  if (!env.DB || !title) return 0;
  await ensureDetailLog(env);
  const where = person ? `title_key = ?1 AND person_key = ?2` : `title_key = ?1`;
  const binds = person ? [title.toLowerCase(), person.toLowerCase()] : [title.toLowerCase()];
  const r = await env.DB.prepare(
    `DELETE FROM chore_detail_log WHERE id = (
       SELECT id FROM chore_detail_log WHERE ${where} ORDER BY flagged_at DESC LIMIT 1
     )`,
  )
    .bind(...binds)
    .run();
  return r?.meta?.changes ?? 0;
}

// "<titleKey>::<personKey>" -> { person, flaggedAt } for the LATEST note on
// each pair. Whether it still applies is decided in marks.js, which knows when
// that person last completed the chore.
export async function activeDetailFlags(env) {
  const out = new Map();
  if (!env.DB) return out;
  await ensureDetailLog(env);
  const r = await env.DB.prepare(
    `SELECT title_key, person_key, person, MAX(flagged_at) AS flagged_at
     FROM chore_detail_log GROUP BY title_key, person_key`,
  ).all();
  for (const row of r.results || []) {
    out.set(`${row.title_key}::${row.person_key}`, { person: row.person, flaggedAt: row.flagged_at });
  }
  return out;
}

// Recent notes, newest first — for listing what's been raised.
export async function listDetailFlags(env, limit = 20) {
  if (!env.DB) return [];
  await ensureDetailLog(env);
  const r = await env.DB.prepare(
    `SELECT title, person, flagged_at, flagged_by, note
     FROM chore_detail_log ORDER BY flagged_at DESC LIMIT ?1`,
  )
    .bind(Math.max(1, Math.min(100, limit)))
    .all();
  return r.results || [];
}

// How often chores have needed another pass over a window — which chores, and
// who they landed on. Powers the dashboard breakdown.
export async function detailFlagStats(env, sinceYmd) {
  if (!env.DB) return null;
  await ensureDetailLog(env);
  const since = `${sinceYmd}T00:00:00.000Z`;
  const byTitle =
    (
      await env.DB.prepare(
        `SELECT title, COUNT(*) n FROM chore_detail_log
         WHERE flagged_at >= ?1 GROUP BY title_key ORDER BY n DESC, title LIMIT 8`,
      )
        .bind(since)
        .all()
    ).results || [];
  const byPerson =
    (
      await env.DB.prepare(
        `SELECT person, COUNT(*) n FROM chore_detail_log
         WHERE flagged_at >= ?1 GROUP BY person_key ORDER BY n DESC`,
      )
        .bind(since)
        .all()
    ).results || [];
  const total = byTitle.reduce((t, r) => t + r.n, 0);
  return { total, byTitle, byPerson };
}
