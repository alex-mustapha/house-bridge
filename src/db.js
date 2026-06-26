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

// on_time / late / missed / open, relative to today (Eastern).
function statusOf(h, today) {
  const completed = h.completedAt ? h.completedAt.slice(0, 10) : null;
  if (completed) return completed <= h.dueDate ? "on_time" : "late";
  return h.dueDate < today ? "missed" : "open";
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
  const stmts = history.map((h) =>
    env.DB.prepare(
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
      h.completedAt ? h.completedAt.slice(0, 10) : null,
      statusOf(h, today),
      now,
    ),
  );
  await env.DB.batch(stmts);
  console.log(`Logged ${stmts.length} chore outcomes to D1.`);
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
