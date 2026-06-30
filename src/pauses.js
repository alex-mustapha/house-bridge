// Pauses in D1: temporary suspensions of chore generation for the whole
// household (global) or one person (user). Each has an inclusive [start, end]
// window; open-ended = end "9999-12-31" (until cleared). Rows are soft-cleared
// (status='cleared' + cleared_at) rather than deleted, so pause history is
// queryable. Chore-level pausing is NOT here — that's the `paused` label on the
// template (the source of truth, handled in recurring.js buildDefs).
//
// Dependency-free (env.DB + strings) to avoid import cycles.

const SCHEMA = `CREATE TABLE IF NOT EXISTS pauses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  target TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT,
  cleared_at TEXT
)`;

async function ensure(env) {
  await env.DB.prepare(SCHEMA).run();
  // Migrate tables created before status/cleared_at existed.
  for (const col of ["status TEXT NOT NULL DEFAULT 'active'", "cleared_at TEXT"]) {
    try {
      await env.DB.prepare(`ALTER TABLE pauses ADD COLUMN ${col}`).run();
    } catch {
      /* column already exists */
    }
  }
}

// scope: 'global' | 'user'; target: user name (null for global).
export async function addPause(env, { scope, target, start, end, nowIso }) {
  if (!env.DB) return false;
  await ensure(env);
  await env.DB.prepare(
    `INSERT INTO pauses (scope, target, start_date, end_date, status, created_at)
     VALUES (?1, ?2, ?3, ?4, 'active', ?5)`,
  )
    .bind(scope, target ?? null, start, end, nowIso || "")
    .run();
  return true;
}

// Active pauses only (what runWeek honors).
export async function getActivePauses(env) {
  if (!env.DB) return [];
  await ensure(env);
  const r = await env.DB.prepare(
    `SELECT id, scope, target, start_date, end_date, created_at
     FROM pauses WHERE status = 'active' ORDER BY start_date`,
  ).all();
  return r.results || [];
}

// Soft-clear a single pause by id (used for catch-up of expired pauses, which
// clearPauses can't reach since it only touches end_date >= today).
export async function markPauseCleared(env, id, nowIso, status = "cleared") {
  if (!env.DB) return false;
  await ensure(env);
  await env.DB.prepare(`UPDATE pauses SET status = ?1, cleared_at = ?2 WHERE id = ?3`)
    .bind(status, nowIso || "", id)
    .run();
  return true;
}

// Soft-clear upcoming active pauses (end_date >= today), optionally narrowed to
// a scope and (contains, case-insensitive) target. Returns the number cleared.
export async function clearPauses(env, today, filter) {
  if (!env.DB) return 0;
  await ensure(env);
  let sql = `UPDATE pauses SET status = 'cleared', cleared_at = ?1 WHERE status = 'active' AND end_date >= ?2`;
  const binds = [today, today];
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

// Most recent pauses (active + cleared) for the history view.
export async function getPauseHistory(env, limit) {
  if (!env.DB) return [];
  await ensure(env);
  const r = await env.DB.prepare(
    `SELECT scope, target, start_date, end_date, status, created_at, cleared_at
     FROM pauses ORDER BY id DESC LIMIT ?1`,
  )
    .bind(limit || 10)
    .all();
  return r.results || [];
}

// Pauses whose window covers `ymd`.
export function pausesOn(pauses, ymd) {
  return (pauses || []).filter((p) => ymd >= p.start_date && ymd <= p.end_date);
}
