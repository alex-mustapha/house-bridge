// Vacation / "hold" windows in D1: date ranges during which chore generation is
// suspended (e.g. a trip). Dependency-free (only env.DB + date strings passed
// in) so it can be imported by recurring.js without an import cycle.

const SCHEMA = `CREATE TABLE IF NOT EXISTS holds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  created_at TEXT
)`;

async function ensure(env) {
  await env.DB.prepare(SCHEMA).run();
}

// Record a hold window [start, end] (inclusive, YYYY-MM-DD).
export async function addHold(env, start, end, nowIso) {
  if (!env.DB) return false;
  await ensure(env);
  await env.DB.prepare(
    `INSERT INTO holds (start_date, end_date, created_at) VALUES (?1, ?2, ?3)`,
  )
    .bind(start, end, nowIso || "")
    .run();
  return true;
}

export async function getHolds(env) {
  if (!env.DB) return [];
  await ensure(env);
  const r = await env.DB.prepare(
    `SELECT start_date, end_date FROM holds ORDER BY start_date`,
  ).all();
  return r.results || [];
}

// Remove holds that haven't ended yet (active or upcoming); returns count removed.
export async function clearUpcomingHolds(env, today) {
  if (!env.DB) return 0;
  await ensure(env);
  const r = await env.DB.prepare(`DELETE FROM holds WHERE end_date >= ?1`).bind(today).run();
  return r.meta?.changes ?? 0;
}

// True if `ymd` falls within any hold window.
export function ymdHeld(holds, ymd) {
  return (holds || []).some((h) => ymd >= h.start_date && ymd <= h.end_date);
}
