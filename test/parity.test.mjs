// Guards the bug class that has bitten three times: a scheduling directive
// added to the label parser but wired into only some of the places that build a
// chore. `weekdays-only` shipped wired into 2 of 3 sites, `paused` into 2 of 3.
// scheduleFromConfig is now the single builder, and these tests fail if a new
// directive bypasses it.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLabelConfig,
  parseDescriptionConfig,
  scheduleFromConfig,
  describeSchedule,
  isDueToday,
  nextOccurrences,
} from "../src/recurring.js";

const labels = (...names) => names.map((n, i) => ({ id: `L${i}`, name: n }));
const sched = (names, desc = "") =>
  scheduleFromConfig(parseLabelConfig(labels(...names)).config, parseDescriptionConfig(desc));

// Config keys that are deliberately NOT part of the schedule shape.
const NOT_SCHEDULE = new Set([
  "onExisting", // miss policy, resolved separately by defaultOnMiss
  "paused",     // gating: buildDefs skips the template, summarize reports it
]);

test("every schedule-relevant label directive reaches scheduleFromConfig", () => {
  // Feed one label of each kind and collect what the parser can set.
  const all = labels(
    "weekly", "monday", "middle", "october", "skip", "paused", "weekdays-only",
  );
  const { config } = parseLabelConfig(all);
  const produced = Object.keys(config);
  assert.ok(produced.length >= 6, `parser set surprisingly little: ${produced}`);

  const shape = scheduleFromConfig(config, parseDescriptionConfig(""));
  for (const key of produced) {
    if (NOT_SCHEDULE.has(key)) continue;
    assert.ok(
      key in shape,
      `parseLabelConfig sets "${key}" but scheduleFromConfig drops it — ` +
        `wire it into the shared builder, or add it to NOT_SCHEDULE with a reason`,
    );
  }
});

test("weekdays-only survives the label -> config -> schedule pipeline", () => {
  assert.equal(sched(["monthly", "middle", "weekdays-only"]).weekdaysOnly, true);
  assert.equal(sched(["monthly", "middle"]).weekdaysOnly, undefined);
});

test("weekdays-only accepts its documented spellings", () => {
  for (const spelling of ["weekdays-only", "weekdaysonly", "weekday", "businessday", "Weekdays-Only", "WEEKDAY"]) {
    assert.equal(sched(["monthly", "middle", spelling]).weekdaysOnly, true, spelling);
  }
});

test("label parsing is case- and whitespace-insensitive", () => {
  const s = sched(["Weekly", " MONDAY "]);
  assert.equal(s.cadence, "weekly");
  assert.deepEqual(s.days, ["monday"]);
});

test("non-directive labels are passed through, directives are not", () => {
  const { config, passthroughLabelIds } = parseLabelConfig(
    labels("weekly", "saturday", "outside", "kitchen"),
  );
  assert.equal(config.cadence, "weekly");
  assert.equal(passthroughLabelIds.length, 2, "outside + kitchen ride along to the chore");
});

test("the schedule shape drives BOTH the description and the dates", () => {
  // If a directive reached only one of these, they would disagree — which is
  // precisely what /describe did while generation was already correct.
  const s = sched(["monthly", "middle", "weekdays-only"]);
  assert.match(describeSchedule(s), /weekdays only/, "summary must mention it");
  for (const d of nextOccurrences(s, 6)) {
    const [y, m, dd] = d.split("-").map(Number);
    const wd = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
    assert.ok(![0, 6].includes(wd), `${d} is a weekend but the summary claims weekdays only`);
  }
});

test("describeSchedule and isDueToday agree on the same shape", () => {
  const s = sched(["weekly", "saturday"]);
  assert.match(describeSchedule(s), /Sat/);
  const next = nextOccurrences(s, 1)[0];
  assert.equal(isDueToday(s, new Date(`${next}T16:00:00Z`)), true);
});

test("anyday: a weekly chore with no weekday label gets spread days", () => {
  const once = sched(["weekly"]);
  assert.equal(once.anyday, true);
  assert.equal(once.count, 1);
  assert.ok(Array.isArray(once.days) && once.days.length === 1);

  const thrice = sched(["weekly"], "count: 3");
  assert.equal(thrice.count, 3);
  assert.equal(thrice.days.length, 3, "three spread days for three times a week");
});

test("a weekday label switches anyday off", () => {
  const s = sched(["weekly", "tuesday"]);
  assert.equal(s.anyday, false);
  assert.deepEqual(s.days, ["tuesday"]);
});

test("description directives land on the schedule shape", () => {
  const s = sched(["weekly", "monday"], "estimate: 45m\neffort: 4\nstart: 2026-11-02");
  assert.equal(s.estimate, 45);
  assert.equal(s.effort, 4);
  assert.equal(s.start, "2026-11-02");
  assert.equal(typeof s.anchorWeek, "number", "start: must anchor the week phase");
});
