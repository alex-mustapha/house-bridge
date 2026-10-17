// Monthly recommendations from the chore log.
//
// Design rule: every number and every recommendation in here is COMPUTED, not
// generated. The prose layer may rephrase these findings, but it is never the
// source of a figure — a monthly post with confident, slightly-wrong numbers is
// worse than no post, because you stop trusting it after the first one you
// catch.
//
// `analyze` is pure: chore_log rows in, findings out. All the D1 work lives in
// gatherInsights, so the rules can be tested directly.

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Each rule carries a minimum sample size. The point of the thresholds is to
// avoid promoting noise to advice: "move it to Sunday" off two data points is a
// guess wearing a recommendation's clothes.
export const RULES = {
  weekdayMinN: 6, // completions needed before suggesting a different day
  weekdayMinShare: 0.4, // the modal completion day must hold this share
  cancelMinN: 5,
  cancelRate: 0.3, // cancelled this often -> the cadence is the problem
  missedMin: 3,
  // A RATE as well as a count. On count alone, "missed 3 of 38 (8%)" was
  // reported as a problem and buried the findings that actually mattered.
  missedRate: 0.25,
  deadMinN: 4, // never completed across this many tries
  loadDriftPts: 12, // percentage points off the configured target
  flagRepeat: 2,
};

const dowOf = (ymd) => {
  if (!ymd) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

const daysBetween = (a, b) => {
  const p = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((p(a) - p(b)) / 86_400_000);
};

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

const modal = (counts) => {
  const e = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return e.length ? { key: Number(e[0][0]), n: e[0][1] } : null;
};

const avg = (nums) =>
  nums.length ? Math.round((nums.reduce((t, n) => t + n, 0) / nums.length) * 10) / 10 : 0;

// Group rows by chore title, with just enough detail for the rules below.
export function groupByTitle(rows) {
  const out = new Map();
  for (const r of rows || []) {
    if (!r.title || !r.due_date) continue;
    if (r.status === "open") continue; // unresolved: no signal either way
    if (!out.has(r.title)) {
      out.set(r.title, {
        title: r.title,
        n: 0,
        onTime: 0,
        late: 0,
        missed: 0,
        canceled: 0,
        dueDows: {},
        doneDows: {},
        lateDays: [],
      });
    }
    const g = out.get(r.title);
    g.n++;
    if (r.status === "on_time") g.onTime++;
    else if (r.status === "late") g.late++;
    else if (r.status === "missed") g.missed++;
    else if (r.status === "canceled") g.canceled++;

    const dd = dowOf(r.due_date);
    if (dd !== null) g.dueDows[dd] = (g.dueDows[dd] || 0) + 1;
    if (r.completed_date) {
      const cd = dowOf(r.completed_date);
      if (cd !== null) g.doneDows[cd] = (g.doneDows[cd] || 0) + 1;
      g.lateDays.push(Math.max(0, daysBetween(r.completed_date, r.due_date)));
    }
  }
  return [...out.values()];
}

export function analyze(rows, { targetSplit = {}, flagCounts = {}, estimateOf } = {}) {
  const groups = groupByTitle(rows);
  const findings = [];

  for (const g of groups) {
    const done = g.onTime + g.late;
    // Cancellations are decisions, not failures, so they stay out of the
    // denominator everywhere a rate is judged.
    const resolved = done + g.missed;
    const avgLate = avg(g.lateDays);

    // 1. The due day disagrees with the day it actually gets done. This is the
    //    highest-value rule: it converts "they keep being late" into "the date
    //    is wrong", which is fixable without anyone trying harder.
    const dueM = modal(g.dueDows);
    const doneM = modal(g.doneDows);
    if (
      done >= RULES.weekdayMinN &&
      dueM &&
      doneM &&
      doneM.key !== dueM.key &&
      doneM.n / done >= RULES.weekdayMinShare
    ) {
      findings.push({
        kind: "wrong-weekday",
        title: g.title,
        // A chore that has NEVER been on time is a stronger signal than one
        // that merely drifts.
        severity: g.onTime === 0 ? 4 : 3,
        n: done,
        facts: {
          dueDay: DOW[dueM.key],
          actualDay: DOW[doneM.key],
          actualCount: doneM.n,
          completions: done,
          onTime: g.onTime,
          avgLateDays: avgLate,
        },
        detail:
          `${g.title} — ${DOW[dueM.key]} → ${DOW[doneM.key]} ` +
          `(${doneM.n} of ${done}, avg ${avgLate}d late${g.onTime === 0 ? ", never on time" : ""})`,
        recommendation:
          `Move ${g.title} from ${DOW[dueM.key]} to ${DOW[doneM.key]}` +
          (g.onTime === 0
            ? `. It has never been completed on time in ${done} tries, averaging ${avgLate}d late.`
            : `, where it actually gets done ${doneM.n} of ${done} times (avg ${avgLate}d late).`),
      });
    }

    // 2. Cancelled so often that the cadence, not the weekday, is wrong.
    if (g.n >= RULES.cancelMinN && g.canceled / g.n >= RULES.cancelRate) {
      findings.push({
        kind: "too-frequent",
        title: g.title,
        severity: 2,
        n: g.n,
        facts: { canceled: g.canceled, occurrences: g.n, rate: pct(g.canceled, g.n) },
        detail: `${g.title} — cancelled ${g.canceled} of ${g.n} (${pct(g.canceled, g.n)}%)`,
        recommendation:
          `${g.title} was cancelled ${g.canceled} of ${g.n} times (${pct(g.canceled, g.n)}%). ` +
          `Cancelling is a deliberate "not this time", so it probably comes round more often ` +
          `than it needs to. Consider a longer cadence.`,
      });
    }

    // 3. Repeatedly left undone. Distinct from cancelled: nobody chose this.
    if (g.missed >= RULES.missedMin && resolved && g.missed / resolved >= RULES.missedRate) {
      findings.push({
        kind: "chronically-missed",
        title: g.title,
        severity: 4,
        n: g.n,
        facts: { missed: g.missed, occurrences: g.n, rate: pct(g.missed, g.n) },
        detail: `${g.title} — missed ${g.missed} of ${g.n} (${pct(g.missed, g.n)}%)`,
        recommendation:
          `${g.title} was missed ${g.missed} of ${g.n} times (${pct(g.missed, g.n)}%) — not ` +
          `cancelled, just not done. Either it is harder than its estimate, it lands at a bad ` +
          `time, or it wants splitting into smaller pieces.`,
      });
    }

    // 4. Never once completed. The strongest signal available.
    if (g.n >= RULES.deadMinN && done === 0) {
      findings.push({
        kind: "never-done",
        title: g.title,
        severity: 5,
        n: g.n,
        facts: { occurrences: g.n, missed: g.missed, canceled: g.canceled },
        detail: `${g.title} — 0 of ${g.n} ever completed`,
        recommendation:
          `${g.title} has not been completed once in ${g.n} occurrences. If it matters, ` +
          `something about it has to change; if it does not, delete the template so it stops ` +
          `generating.`,
      });
    }

    // 5. Roughly on time when recorded, but often not recorded at all. That
    //    pattern is a logging gap, not a chore problem — worth separating
    //    before "fixing" a schedule that is not actually broken.
    if (g.missed >= 3 && done >= 3 && avgLate <= 1 && resolved && g.missed / resolved >= 0.4) {
      findings.push({
        kind: "possibly-unlogged",
        title: g.title,
        severity: 1,
        n: g.n,
        facts: { missed: g.missed, completions: done, avgLateDays: avgLate },
        detail:
          `${g.title} — ${g.missed} missed, but only ${avgLate}d late when recorded`,
        recommendation:
          `${g.title} shows ${g.missed} misses, but when it is recorded it is only ${avgLate}d ` +
          `late on average. That usually means the work happened and the chore was not ticked. ` +
          `Worth confirming before changing its schedule.`,
      });
    }
  }

  // 6. Repeated "needs work" flags point at an unclear checklist, not a person.
  for (const [title, count] of Object.entries(flagCounts || {})) {
    if (count >= RULES.flagRepeat) {
      findings.push({
        kind: "unclear-checklist",
        title,
        severity: 2,
        n: count,
        facts: { flags: count },
        detail: `${title} — flagged ${count} times`,
        recommendation:
          `${title} has been flagged "done but a detail was missed" ${count} times. Repeat ` +
          `flags on one chore usually mean its checklist is incomplete, rather than that ` +
          `someone keeps being careless.`,
      });
    }
  }

  // 7. Effort split against the configured target.
  const load = {};
  let loadTotal = 0;
  for (const r of rows || []) {
    if (!r.assignee) continue;
    if (r.status !== "on_time" && r.status !== "late") continue;
    const mins = estimateOf ? estimateOf(r.title) : 15;
    load[r.assignee] = (load[r.assignee] || 0) + mins;
    loadTotal += mins;
  }
  const split = Object.entries(load)
    .map(([name, minutes]) => ({
      name,
      minutes,
      share: pct(minutes, loadTotal),
      target: targetSplit?.[name] ?? null,
    }))
    .sort((a, b) => b.minutes - a.minutes);

  for (const s of split) {
    if (s.target == null) continue;
    const drift = s.share - s.target;
    if (Math.abs(drift) >= RULES.loadDriftPts) {
      findings.push({
        kind: "load-drift",
        title: s.name,
        severity: 3,
        n: loadTotal,
        facts: { share: s.share, target: s.target, drift },
        detail:
          `${s.name} — ${s.share}% of effort vs ${s.target}% target ` +
          `(${drift > 0 ? "+" : ""}${drift} pts)`,
        recommendation:
          `${s.name} carried ${s.share}% of completed effort against a ${s.target}% target ` +
          `(${drift > 0 ? "+" : ""}${drift} pts). Rotation is per-chore alternation, so a gap ` +
          `this size usually comes from who picks up the extras rather than from the rotation.`,
      });
    }
  }

  // One finding per chore. Several rules can fire on the same title and they
  // are not equally useful — "move it to Sunday" beats "it gets missed a lot",
  // and for Grocery shop the missed-vs-unlogged rules gave outright
  // contradictory advice. Keep the most specific explanation per title; the
  // rest are the same observation seen from further away.
  //
  // Load drift is keyed by PERSON, not chore, so it is exempt from the dedupe.
  const PRIORITY = [
    "never-done",
    "wrong-weekday",
    "possibly-unlogged",
    "chronically-missed",
    "too-frequent",
    "unclear-checklist",
  ];
  const rank = (k) => {
    const i = PRIORITY.indexOf(k);
    return i === -1 ? PRIORITY.length : i;
  };
  const best = new Map();
  const keyed = [];
  for (const f of findings) {
    if (f.kind === "load-drift") {
      keyed.push(f);
      continue;
    }
    const prev = best.get(f.title);
    if (!prev || rank(f.kind) < rank(prev.kind)) best.set(f.title, f);
  }
  const deduped = [...best.values(), ...keyed];

  // Most actionable first. PRIORITY is the real ordering; `severity` only breaks
  // ties within a kind, by how much evidence there is.
  deduped.sort((a, b) => rank(a.kind) - rank(b.kind) || b.n - a.n);
  return { findings: deduped, split, titlesConsidered: groups.length };
}

// Headline counts for the window, so the post can open with where things stand
// before it starts recommending anything.
export function summarize(rows) {
  const s = { total: 0, onTime: 0, late: 0, missed: 0, canceled: 0 };
  for (const r of rows || []) {
    if (r.status === "open") continue;
    s.total++;
    if (r.status === "on_time") s.onTime++;
    else if (r.status === "late") s.late++;
    else if (r.status === "missed") s.missed++;
    else if (r.status === "canceled") s.canceled++;
  }
  const counted = s.onTime + s.late + s.missed; // cancellations excluded
  s.onTimePct = counted ? Math.round((s.onTime / counted) * 100) : null;
  s.completionPct = counted ? Math.round(((s.onTime + s.late) / counted) * 100) : null;
  return s;
}

// --- data gathering -----------------------------------------------------------

// Pull the window from D1 and run the rules. Separated from `analyze` so the
// rules stay pure and testable; everything that can fail at runtime is here.
export async function gatherInsights(env, { days = 120, estimateOf, targetSplit } = {}) {
  if (!env.DB) return null;
  // `days <= 0` means all time. A sentinel lower bound keeps the query shape
  // identical rather than branching the SQL; the window reported back is the
  // earliest row actually found, so the post states the real span rather than
  // a date from the year 1.
  const allTime = !Number.isFinite(days) || days <= 0;
  const since = allTime
    ? "0001-01-01"
    : new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const rows =
    (
      await env.DB.prepare(
        `SELECT title, assignee, due_date, completed_date, status
           FROM chore_log
          WHERE due_date >= ?1 AND due_date <= ?2`,
      )
        .bind(since, today)
        .all()
    ).results || [];

  // Repeat "needs work" flags, keyed by title.
  const flagCounts = {};
  try {
    const flags =
      (
        await env.DB.prepare(
          `SELECT title, COUNT(*) n FROM chore_detail_log
            WHERE flagged_at >= ?1 GROUP BY title_key`,
        )
          .bind(`${since}T00:00:00.000Z`)
          .all()
      ).results || [];
    for (const f of flags) flagCounts[f.title] = f.n;
  } catch (e) {
    console.error("insight flag lookup failed:", e.message);
  }

  const earliest = rows.reduce(
    (m, r) => (r.due_date && (!m || r.due_date < m) ? r.due_date : m),
    null,
  );

  return {
    windowDays: allTime ? null : days,
    allTime,
    since: earliest || (allTime ? today : since),
    until: today,
    summary: summarize(rows),
    ...analyze(rows, { targetSplit, flagCounts, estimateOf }),
  };
}

// Parse "Alex:60,Kristal:40" into { Alex: 60, Kristal: 40 }.
export function parseTargetSplit(spec) {
  const out = {};
  for (const pair of String(spec || "").split(",")) {
    const [k, v] = pair.split(":").map((s) => (s || "").trim());
    const n = parseInt(v, 10);
    if (k && Number.isFinite(n)) out[k] = n;
  }
  return out;
}
