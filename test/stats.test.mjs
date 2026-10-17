// The weekly recap. Two things are pinned hard: cancelled work is its own
// outcome (it used to fall through the !completedAt branch and be scored as a
// MISS, deflating the ratio and naming deliberate cancellations under "what
// slipped"), and the window is the finished week ending yesterday.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStats } from "../src/stats.js";

const NOW = new Date("2026-10-17T16:00:00Z"); // Saturday
const ymd = (n) => new Date(Date.UTC(2026, 9, 17 - n)).toISOString().slice(0, 10);

let seq = 0;
// outcome: "on_time" | "late:N" | "missed" | "canceled"
const mk = (dayAgo, who, outcome, title) => {
  const due = ymd(dayAgo);
  const i = {
    identifier: `CHO-${++seq}`, title: title || `Chore ${seq}`, dueDate: due,
    assignee: who ? { name: who } : null, completedAt: null, state: { type: "completed" },
  };
  if (outcome === "missed") i.state = { type: "started" };
  else if (outcome === "canceled") i.state = { type: "canceled" };
  else {
    const late = outcome.startsWith("late") ? Number(outcome.split(":")[1]) : 0;
    const [y, m, d] = due.split("-").map(Number);
    i.completedAt = new Date(Date.UTC(y, m - 1, d + late, 20)).toISOString();
  }
  return i;
};

test("window is the finished week ending yesterday — today is excluded", () => {
  const s = computeStats([mk(0, "Alex", "missed"), mk(1, "Alex", "on_time")], NOW);
  assert.equal(s.window.to, ymd(1), "ends yesterday");
  assert.equal(s.window.from, ymd(7));
  assert.equal(s.household.total, 1, "today's chore must not be in the window");
});

test("a CANCELLED chore is not a miss", () => {
  const s = computeStats([mk(2, "Alex", "canceled")], NOW);
  assert.equal(s.household.canceled, 1);
  assert.equal(s.household.missed, 0, "cancelled must never be scored as missed");
  assert.equal(s.household.counted, 0, "and must be outside the on-time denominator");
  assert.equal(s.household.onTimePct, null, "nothing scoreable means no percentage");
  assert.deepEqual(s.missed, [], "and must not appear in 'what slipped'");
});

test("cancelling cannot inflate the on-time rate", () => {
  const clean = computeStats([mk(2, "Alex", "on_time"), mk(3, "Alex", "missed")], NOW);
  const withCancel = computeStats(
    [mk(2, "Alex", "on_time"), mk(3, "Alex", "missed"), mk(4, "Alex", "canceled")], NOW,
  );
  assert.equal(clean.household.onTimePct, 50);
  assert.equal(withCancel.household.onTimePct, 50, "a cancellation must not move the rate");
  assert.equal(withCancel.household.total, 3, "but it still counts toward volume");
});

test("on-time / late / missed are tallied distinctly", () => {
  const s = computeStats(
    [mk(2, "Alex", "on_time"), mk(3, "Alex", "late:2"), mk(4, "Alex", "missed")], NOW,
  );
  assert.equal(s.household.onTime, 1);
  assert.equal(s.household.late, 1);
  assert.equal(s.household.missed, 1);
  assert.equal(s.household.done, 2, "late still counts as done");
  assert.equal(s.household.onTimePct, 33);
});

test("lateness carries magnitude and names the worst offender", () => {
  const s = computeStats(
    [mk(2, "Alex", "late:1"), mk(3, "Alex", "late:9", "Nero bath")], NOW,
  );
  assert.equal(s.household.avgLate, 5);
  assert.equal(s.household.worst.title, "Nero bath");
  assert.equal(s.household.worst.daysLate, 9);
});

test("unassigned work counts for the household but not for a person", () => {
  const s = computeStats([mk(2, null, "missed", "Recycling"), mk(3, "Alex", "on_time")], NOW);
  assert.equal(s.household.total, 2);
  assert.deepEqual(s.people.map((p) => p.name), ["Alex"]);
  assert.ok(s.missed.some((m) => m.who === "Unassigned"), "still named in what slipped");
});

test("the trend compares against the week before", () => {
  const cur = [mk(2, "Alex", "on_time"), mk(3, "Alex", "on_time")];
  const prev = [mk(9, "Alex", "missed"), mk(10, "Alex", "on_time")];
  const s = computeStats([...cur, ...prev], NOW);
  assert.equal(s.household.onTimePct, 100);
  assert.equal(s.household.prevOnTimePct, 50);
  assert.equal(s.household.delta, 50);
});

test("chronic offenders are surfaced from the wider history", () => {
  const s = computeStats(
    [mk(3, "Alex", "missed", "Clean the kitchen"),
     mk(12, "Alex", "missed", "Clean the kitchen"),
     mk(25, "Alex", "missed", "Clean the kitchen"),
     mk(4, "Alex", "missed", "One-off")], NOW,
  );
  assert.equal(s.chronic[0].title, "Clean the kitchen");
  assert.equal(s.chronic[0].n, 3);
  assert.ok(!s.chronic.some((c) => c.title === "One-off"), "a single miss is not chronic");
});

test("an empty history does not throw", () => {
  const s = computeStats([], NOW);
  assert.deepEqual(s.people, []);
  assert.equal(s.household.total, 0);
  assert.deepEqual(s.missed, []);
});

test("per-person figures are independent", () => {
  const s = computeStats(
    [mk(2, "Alex", "on_time"), mk(3, "Alex", "on_time"),
     mk(2, "Kristal", "missed"), mk(3, "Kristal", "on_time")], NOW,
  );
  const by = Object.fromEntries(s.people.map((p) => [p.name, p]));
  assert.equal(by.Alex.onTimePct, 100);
  assert.equal(by.Kristal.onTimePct, 50);
});
