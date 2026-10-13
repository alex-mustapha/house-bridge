// ONE definition of "streak", shared by the widget, the weekly recap and the
// dashboard.
//
// There used to be three independent copies and they reported three different
// numbers for the same day (widget 0 / recap 0 / dashboard 5 for Alex on
// 2026-10-13). They disagreed on the lookback window (60 / 30 / 41 days), on
// whether today counted, and — the big one — on whether a *cancelled* chore
// breaks a run. Don't re-fork this: feed it a day map and take the number.
//
// The definition:
//   * A day counts when you had at least one chore due and **resolved all of
//     them** — completed, or deliberately cancelled.
//   * Cancelling is a legitimate outcome, not a failure. `statusOf` already
//     keeps it out of the completion ratio rather than scoring it against you,
//     so it must not break a run either.
//   * Days with no chores due are **skipped** — nothing was asked of you, so
//     they neither break nor extend the run.
//   * **Today is excluded.** A streak is a record of finished days; counting a
//     day still in progress was what let the widget read one higher than the
//     recap for the same person.
export const STREAK_WINDOW_DAYS = 30;

// `YYYY-MM-DD` n days before `ymd`. Parsed as UTC noon so DST can't shift it.
export function shiftYmd(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - n, 12)).toISOString().slice(0, 10);
}

// `byDay`: ymd -> { total, resolved }. Anything falsy/missing = no chores.
export function choreStreak(byDay, today, days = STREAK_WINDOW_DAYS) {
  const get = byDay instanceof Map ? (k) => byDay.get(k) : (k) => byDay[k];
  let streak = 0;
  for (let n = 1; n <= days; n++) {
    const e = get(shiftYmd(today, n));
    if (!e || !e.total) continue; // chore-free day — bridge it
    if (e.resolved >= e.total) { streak++; continue; }
    break; // a finished day was left unresolved
  }
  return streak;
}

// True when a Linear issue counts as resolved for streak purposes.
export const issueResolved = (i) =>
  !!i.completedAt || i.state?.type === "completed" || i.state?.type === "canceled";

// Same question for a D1 `chore_log.status` (see db.statusOf).
export const statusResolved = (s) =>
  s === "on_time" || s === "late" || s === "canceled";

// Build the day map from Linear issues. `keyOf` lets callers scope it (per
// person, per household) and return null to drop an issue.
export function byDayFromIssues(issues, keyOf = () => "all") {
  const out = {};
  for (const i of issues) {
    if (!i.dueDate) continue;
    const k = keyOf(i);
    if (k === null || k === undefined) continue;
    const m = (out[k] ||= {});
    const e = (m[i.dueDate] ||= { total: 0, resolved: 0 });
    e.total++;
    if (issueResolved(i)) e.resolved++;
  }
  return out;
}

// One short label, so the three surfaces also agree on the *wording*. "N
// chore-days clear" read as jargon; "N-day streak" overclaimed calendar days.
export function streakLabel(n) {
  return n ? `🔥 ${n} clear day${n === 1 ? "" : "s"}` : "";
}
export const STREAK_FOOTNOTE =
  "Clear days = days you had chores and resolved them all (done or cancelled). Chore-free days are skipped; today isn't counted yet.";
