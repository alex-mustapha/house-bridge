// The streak definition. There were once three of these and they returned
// 0 / 0 / 5 for the same person on the same day; the disagreements were the
// lookback window, whether today counted, and whether a cancelled chore breaks
// a run. Each of those is pinned below.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  choreStreak,
  byDayFromIssues,
  issueResolved,
  statusResolved,
  shiftYmd,
  STREAK_WINDOW_DAYS,
} from "../src/streak.js";

const TODAY = "2026-10-17";
const day = (n) => shiftYmd(TODAY, n);
const map = (pairs) => Object.fromEntries(pairs.map(([n, t, r]) => [day(n), { total: t, resolved: r }]));

test("shiftYmd walks back across a month boundary", () => {
  assert.equal(shiftYmd("2026-10-01", 1), "2026-09-30");
  assert.equal(shiftYmd("2026-03-01", 1), "2026-02-28");
  assert.equal(shiftYmd("2028-03-01", 1), "2028-02-29"); // leap year
});

test("counts consecutive fully-resolved days", () => {
  assert.equal(choreStreak(map([[1, 2, 2], [2, 1, 1], [3, 3, 3]]), TODAY), 3);
});

test("breaks on a finished day left unresolved", () => {
  assert.equal(choreStreak(map([[1, 2, 2], [2, 2, 1], [3, 1, 1]]), TODAY), 1);
});

test("chore-free days bridge rather than break or count", () => {
  // nothing on day 2 at all
  assert.equal(choreStreak(map([[1, 1, 1], [3, 1, 1]]), TODAY), 2);
});

test("TODAY is excluded — a streak is a record of finished days", () => {
  // today is unresolved; yesterday is clean. Must be 1, not 0.
  assert.equal(choreStreak(map([[0, 5, 0], [1, 1, 1]]), TODAY), 1);
  // and a clean today must not inflate it
  assert.equal(choreStreak(map([[0, 1, 1], [1, 1, 1]]), TODAY), 1);
});

test("window is bounded and shared", () => {
  assert.equal(STREAK_WINDOW_DAYS, 30);
  const every = {};
  for (let n = 1; n <= 60; n++) every[day(n)] = { total: 1, resolved: 1 };
  assert.equal(choreStreak(every, TODAY), 30, "must cap at the shared window");
  assert.equal(choreStreak(every, TODAY, 5), 5, "explicit window honoured");
});

test("an empty or missing map is a zero streak, not a crash", () => {
  assert.equal(choreStreak({}, TODAY), 0);
  assert.equal(choreStreak(new Map(), TODAY), 0);
});

test("accepts a Map as well as a plain object", () => {
  const m = new Map([[day(1), { total: 1, resolved: 1 }], [day(2), { total: 1, resolved: 1 }]]);
  assert.equal(choreStreak(m, TODAY), 2);
});

// --- the one that caused the visible divergence -------------------------------
test("a CANCELLED chore resolves a day and does not break the run", () => {
  const issues = [
    { dueDate: day(1), state: { type: "completed" }, completedAt: "x" },
    { dueDate: day(2), state: { type: "canceled" } },           // no completedAt
    { dueDate: day(3), state: { type: "completed" }, completedAt: "x" },
  ];
  const byDay = byDayFromIssues(issues).all;
  assert.equal(choreStreak(byDay, TODAY), 3, "cancelling is a decision, not a failure");
});

test("issueResolved: done or cancelled, nothing else", () => {
  assert.equal(issueResolved({ completedAt: "2026-10-16T00:00:00Z" }), true);
  assert.equal(issueResolved({ state: { type: "completed" } }), true);
  assert.equal(issueResolved({ state: { type: "canceled" } }), true);
  assert.equal(issueResolved({ state: { type: "started" } }), false);
  assert.equal(issueResolved({ state: { type: "unstarted" } }), false);
  assert.equal(issueResolved({}), false);
});

test("statusResolved mirrors issueResolved for D1 rows", () => {
  for (const s of ["on_time", "late", "canceled"]) assert.equal(statusResolved(s), true, s);
  for (const s of ["missed", "open", undefined]) assert.equal(statusResolved(s), false, String(s));
});

test("byDayFromIssues groups per key and drops undated work", () => {
  const issues = [
    { dueDate: day(1), assignee: { name: "Alex" }, state: { type: "completed" } },
    { dueDate: day(1), assignee: { name: "Kristal" }, state: { type: "started" } },
    { dueDate: null, assignee: { name: "Alex" }, state: { type: "completed" } },
  ];
  const by = byDayFromIssues(issues, (i) => i.assignee?.name ?? null);
  assert.equal(by.Alex[day(1)].total, 1, "undated issue must not be counted");
  assert.equal(by.Alex[day(1)].resolved, 1);
  assert.equal(by.Kristal[day(1)].resolved, 0);
});

test("keyOf returning null drops the issue entirely", () => {
  const by = byDayFromIssues([{ dueDate: day(1), state: { type: "completed" } }], () => null);
  assert.deepEqual(by, {});
});
