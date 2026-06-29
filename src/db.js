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

// Everything the /dashboard page needs, computed from the chore log. `estimateOf`
// (title -> minutes) powers the effort split. Window: last 42 days (for trend).
export async function queryDashboard(env, estimateOf) {
  if (!env.DB) return null;
  await ensureSchema(env);
  const today = localDate(new Date()).ymd;
  const d = (n) => {
    const [y, m, dd] = today.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, dd - n)).toISOString().slice(0, 10);
  };
  const since42 = d(41);
  const rows =
    (
      await env.DB.prepare(
        `SELECT title, assignee, due_date AS due, status FROM chore_log
         WHERE due_date >= ?1 AND status != 'open'`,
      )
        .bind(since42)
        .all()
    ).results || [];

  const since7 = d(6);
  const since30 = d(29);
  const est = (t) => (estimateOf ? estimateOf(t) : 15);

  // This week (last 7 days by due date).
  const wk = { done: 0, onTime: 0, late: 0, missed: 0 };
  const byPerson = {};
  const effort = {};
  const missCount = {};
  const dayMap = {}; // person -> { due -> hasMiss }
  for (const r of rows) {
    const who = r.assignee || "Unassigned";
    (dayMap[who] ||= {});
    dayMap[who][r.due] = dayMap[who][r.due] || r.status === "missed";

    if (r.due >= since30 && r.status === "missed") missCount[r.title] = (missCount[r.title] || 0) + 1;

    if (r.due < since7) continue;
    const p = (byPerson[who] ||= { onTime: 0, late: 0, missed: 0 });
    if (r.status === "on_time") { wk.done++; wk.onTime++; p.onTime++; }
    else if (r.status === "late") { wk.done++; wk.late++; p.late++; }
    else if (r.status === "missed") { wk.missed++; p.missed++; }
    if ((r.status === "on_time" || r.status === "late") && r.assignee) {
      effort[r.assignee] = (effort[r.assignee] || 0) + est(r.title);
    }
  }
  const resolved = wk.done + wk.missed;
  wk.completionPct = resolved ? Math.round((wk.done / resolved) * 100) : 0;
  wk.onTimePct = wk.done ? Math.round((wk.onTime / wk.done) * 100) : 0;

  // Weekly completion-rate trend (6 buckets, oldest -> newest).
  const trend = [];
  for (let w = 5; w >= 0; w--) {
    const lo = d(w * 7 + 6);
    const hi = d(w * 7);
    let done = 0;
    let miss = 0;
    for (const r of rows) {
      if (r.due < lo || r.due > hi) continue;
      if (r.status === "on_time" || r.status === "late") done++;
      else if (r.status === "missed") miss++;
    }
    const tot = done + miss;
    trend.push({ label: hi.slice(5), pct: tot ? Math.round((done / tot) * 100) : null });
  }

  // Per-person streak: walk back from yesterday; a day with chores must have no
  // miss; days with no chores bridge.
  const streaks = {};
  for (const who of Object.keys(dayMap)) {
    let s = 0;
    for (let n = 1; n <= 41; n++) {
      const hasMiss = dayMap[who][d(n)];
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
    week: wk,
    byPerson: Object.entries(byPerson).map(([name, v]) => ({ name, ...v })),
    trend,
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
