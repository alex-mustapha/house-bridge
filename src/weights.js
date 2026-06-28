// Rotation weights: how to skew the weekly chore load between members. Base
// weights come from env.ROTATION_WEIGHTS (e.g. "Alex:60,Kristal:40"); temporary
// per-person overrides (for a good/bad week) live in D1 and win over the base.
// Higher weight = bigger share of the week's total effort (minutes).
//
// Dependency-free (env.DB + strings) to avoid import cycles.

const SCHEMA = `CREATE TABLE IF NOT EXISTS weights (name TEXT PRIMARY KEY, weight REAL)`;

async function ensure(env) {
  await env.DB.prepare(SCHEMA).run();
}

function parseBase(spec) {
  const out = {};
  for (const pair of (spec || "").split(",")) {
    const [k, v] = pair.split(":").map((s) => s.trim());
    const n = parseFloat(v);
    if (k && !Number.isNaN(n)) out[k] = n;
  }
  return out;
}

async function getOverrides(env) {
  if (!env.DB) return {};
  await ensure(env);
  const r = await env.DB.prepare(`SELECT name, weight FROM weights`).all();
  const map = {};
  for (const row of r.results || []) map[(row.name || "").toLowerCase()] = row.weight;
  return map;
}

export async function setWeight(env, name, weight) {
  if (!env.DB) return false;
  await ensure(env);
  await env.DB.prepare(
    `INSERT INTO weights (name, weight) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET weight = ?2`,
  )
    .bind(name.toLowerCase(), weight)
    .run();
  return true;
}

export async function clearWeight(env, name) {
  if (!env.DB) return 0;
  await ensure(env);
  const r = await env.DB.prepare(`DELETE FROM weights WHERE name = ?1`).bind(name.toLowerCase()).run();
  return r.meta?.changes ?? 0;
}

// (name) -> effective weight (override > base > 50). For the assignment balancer.
export async function getWeightResolver(env) {
  const base = parseBase(env.ROTATION_WEIGHTS || "Alex:60,Kristal:40");
  const baseLc = {};
  for (const [k, v] of Object.entries(base)) baseLc[k.toLowerCase()] = v;
  const overrides = await getOverrides(env);
  return (name) => {
    const k = (name || "").toLowerCase();
    const w = overrides[k] ?? baseLc[k] ?? 50;
    return w > 0 ? w : 1; // never zero (avoids divide-by-zero in balancing)
  };
}

// Rows for the /chores weight display: configured names with effective weights.
export async function listWeights(env) {
  const base = parseBase(env.ROTATION_WEIGHTS || "Alex:60,Kristal:40");
  const overrides = await getOverrides(env);
  return Object.entries(base).map(([name, b]) => {
    const ov = overrides[name.toLowerCase()];
    return { name, weight: ov ?? b, base: b, overridden: ov != null };
  });
}
