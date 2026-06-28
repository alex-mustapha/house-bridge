// Pauses in D1: temporary suspensions of chore generation, scoped to the whole
// household (global), one person (user), or one chore (chore). Each has an
// inclusive [start, end] window; an open-ended pause uses end "9999-12-31" and
// runs until cleared. Dependency-free (env.DB + strings) to avoid import cycles.

const SCHEMA = `CREATE TABLE IF NOT EXISTS pauses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  target TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  created_at TEXT
)`;

async function ensure(env) {
  await env.DB.prepare(SCHEMA).run();
}

// scope: 'global' | 'user' | 'chore'; target: user name / chore title (null for global).
export async function addPause(env, { scope, target, start, end, nowIso }) {
  if (!env.DB) return false;
  await ensure(env);
  await env.DB.prepare(
    `INSERT INTO pauses (scope, target, start_date, end_date, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(scope, target ?? null, start, end, nowIso || "")
    .run();
  return true;
}

export async function getPauses(env) {
  if (!env.DB) return [];
  await ensure(env);
  const r = await env.DB.prepare(
    `SELECT scope, target, start_date, end_date FROM pauses ORDER BY start_date`,
  ).all();
  return r.results || [];
}

// Clear upcoming pauses (end_date >= today), optionally narrowed to a scope and
// (case-insensitive) target. Returns the number removed.
export async function clearPauses(env, today, filter) {
  if (!env.DB) return 0;
  await ensure(env);
  let sql = `DELETE FROM pauses WHERE end_date >= ?1`;
  const binds = [today];
  if (filter?.scope) {
    binds.push(filter.scope);
    sql += ` AND scope = ?${binds.length}`;
    if (filter.target != null) {
      binds.push(`%${filter.target.toLowerCase()}%`);
      sql += ` AND lower(target) LIKE ?${binds.length}`;
    }
  }
  const r = await env.DB.prepare(sql).bind(...binds).run();
  return r.meta?.changes ?? 0;
}

// Pauses whose window covers `ymd`.
export function pausesOn(pauses, ymd) {
  return (pauses || []).filter((p) => ymd >= p.start_date && ymd <= p.end_date);
}
