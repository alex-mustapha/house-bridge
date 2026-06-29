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
function statusOf(completedYmd, dueDate, today) {
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
      statusOf(completedYmd, h.dueDate, today),
      now,
    );
  });
  await env.DB.batch(stmts);
  console.log(`Logged ${stmts.length} chore outcomes to D1.`);
}

const MON_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Completion-rate trend bucketed by the range: daily (≤10d), weekly (≤120d), or
// monthly (a year). Oldest -> newest.
function buildTrend(rows, today, days) {
  const shift = (n) => {
    const [y, m, dd] = today.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, dd - n)).toISOString().slice(0, 10);
  };
  const tally = (lo, hi) => {
    let done = 0;
    let miss = 0;
    for (const r of rows) {
      if (r.due < lo || r.due > hi) continue;
      if (r.status === "on_time" || r.status === "late") done++;
      else if (r.status === "missed") miss++;
    }
    const t = done + miss;
    return t ? Math.round((done / t) * 100) : null;
  };
  const out = [];
  if (days <= 10) {
    for (let i = days - 1; i >= 0; i--) {
      const day = shift(i);
      out.push({ label: day.slice(5), pct: tally(day, day) });
    }
  } else if (days <= 120) {
    const weeks = Math.ceil(days / 7);
    for (let w = weeks - 1; w >= 0; w--) out.push({ label: shift(w * 7).slice(5), pct: tally(shift(w * 7 + 6), shift(w * 7)) });
  } else {
    const [cy, cm] = today.split("-").map(Number);
    for (let m = 11; m >= 0; m--) {
      const idx = cm - 1 - m;
      const y = cy + Math.floor(idx / 12);
      const mo = ((idx % 12) + 12) % 12;
      const lo = `${y}-${String(mo + 1).padStart(2, "0")}-01`;
      const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
      const hi = `${y}-${String(mo + 1).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
      out.push({ label: MON_ABBR[mo], pct: tally(lo, hi) });
    }
  }
  return out;
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
        `SELECT title, assignee, due_date AS due, status FROM chore_log
         WHERE due_date >= ?1 AND status != 'open'`,
      )
        .bind(shift(lookback - 1))
        .all()
    ).results || [];

  const since = shift(days - 1);
  const est = (t) => (estimateOf ? estimateOf(t) : 15);

  const summary = { done: 0, onTime: 0, late: 0, missed: 0 };
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
    const p = (byPerson[who] ||= { onTime: 0, late: 0, missed: 0 });
    if (r.status === "on_time") { summary.done++; summary.onTime++; p.onTime++; }
    else if (r.status === "late") { summary.done++; summary.late++; p.late++; }
    else if (r.status === "missed") { summary.missed++; p.missed++; }
    if ((r.status === "on_time" || r.status === "late") && r.assignee) {
      effort[r.assignee] = (effort[r.assignee] || 0) + est(r.title);
    }
  }
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

  return {
    days,
    summary,
    byPerson: Object.entries(byPerson).map(([name, v]) => ({ name, ...v })),
    trend: buildTrend(rows, today, days),
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
