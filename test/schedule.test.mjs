// The cadence engine. isDueToday is asked about ONE DAY AT A TIME, which is why
// a date nudged out of its month would skip a whole cycle — that constraint is
// pinned here, along with the weekdays-only nudge and the cadence-derived
// on-miss default.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isDueToday,
  nextOccurrences,
  targetDayOfMonth,
  defaultOnMiss,
  localDate,
} from "../src/recurring.js";

// Noon UTC is mid-morning Eastern, so the calendar day is unambiguous either
// side of a DST change.
const at = (ymd) => new Date(`${ymd}T16:00:00Z`);
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const wdOf = (ymd) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

test("localDate reports the Eastern calendar day", () => {
  assert.equal(localDate(at("2026-10-17")).ymd, "2026-10-17");
  // 03:00 UTC is still the previous evening in Eastern
  assert.equal(localDate(new Date("2026-10-17T03:00:00Z")).ymd, "2026-10-16");
});

test("daily is due every day", () => {
  for (const d of ["2026-10-17", "2026-10-18", "2026-02-29"]) {
    assert.equal(isDueToday({ cadence: "daily" }, at(d)), true, d);
  }
});

test("weekly fires only on its weekday", () => {
  const chore = { cadence: "weekly", days: ["saturday"] };
  assert.equal(isDueToday(chore, at("2026-10-17")), true, "Oct 17 2026 is a Saturday");
  assert.equal(isDueToday(chore, at("2026-10-18")), false);
  assert.equal(isDueToday(chore, at("2026-10-24")), true);
});

test("monthly + middle lands on the 15th", () => {
  const chore = { cadence: "monthly", dom: "middle" };
  assert.equal(isDueToday(chore, at("2026-11-15")), true);
  assert.equal(isDueToday(chore, at("2026-11-16")), false);
});

test("start: and end: bound the schedule", () => {
  const chore = { cadence: "daily", start: "2026-10-18", end: "2026-10-20" };
  assert.equal(isDueToday(chore, at("2026-10-17")), false, "before start");
  assert.equal(isDueToday(chore, at("2026-10-19")), true);
  assert.equal(isDueToday(chore, at("2026-10-21")), false, "after end");
});

test("month labels gate every cadence", () => {
  const chore = { cadence: "monthly", dom: "first", months: [4, 10] };
  assert.equal(isDueToday(chore, at("2026-10-01")), true);
  assert.equal(isDueToday(chore, at("2026-11-01")), false);
});

test("interval counts from the start anchor", () => {
  const chore = { cadence: "interval", intervalDays: 3, start: "2026-10-01" };
  assert.equal(isDueToday(chore, at("2026-10-01")), true);
  assert.equal(isDueToday(chore, at("2026-10-04")), true);
  assert.equal(isDueToday(chore, at("2026-10-05")), false);
  assert.equal(isDueToday(chore, at("2026-09-28")), false, "before the anchor");
});

// --- weekdays-only ------------------------------------------------------------
test("weekdays-only: weekend landings move, weekday landings do not", () => {
  let weekend = 0;
  for (const y of [2026, 2027, 2028]) {
    for (let m = 1; m <= 12; m++) {
      const L = { year: y, month: m };
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      for (const dom of ["first", "middle", "last"]) {
        const plain = targetDayOfMonth({ dom }, L);
        const got = targetDayOfMonth({ dom, weekdaysOnly: true }, L);
        const ymd = (d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const baseWd = wdOf(ymd(plain));
        if (baseWd === 0 || baseWd === 6) {
          weekend++;
          assert.ok(![0, 6].includes(wdOf(ymd(got))), `${ymd(plain)} still weekend`);
          assert.ok(Math.abs(got - plain) <= 2, `${ymd(plain)} moved too far`);
        } else {
          assert.equal(got, plain, `${ymd(plain)} is a weekday and must not move`);
        }
        assert.ok(got >= 1 && got <= last, `${ymd(got)} left its month`);
      }
    }
  }
  assert.ok(weekend > 20, `expected plenty of weekend landings, saw ${weekend}`);
});

test("weekdays-only: Saturday goes back to Friday, Sunday forward to Monday", () => {
  // 2027-05-15 is a Saturday; 2026-11-15 is a Sunday
  assert.equal(targetDayOfMonth({ dom: "middle", weekdaysOnly: true }, { year: 2027, month: 5 }), 14);
  assert.equal(targetDayOfMonth({ dom: "middle", weekdaysOnly: true }, { year: 2026, month: 11 }), 16);
});

test("weekdays-only never leaves the month", () => {
  // 2026-08-01 is a Saturday: cannot go back to July, so forward to Monday 3rd
  assert.equal(targetDayOfMonth({ dom: "first", weekdaysOnly: true }, { year: 2026, month: 8 }), 3);
  // 2026-05-31 is a Sunday: cannot go forward to June, so back to Friday 29th
  assert.equal(targetDayOfMonth({ dom: "last", weekdaysOnly: true }, { year: 2026, month: 5 }), 29);
});

test("weekdays-only is inert without the flag", () => {
  assert.equal(targetDayOfMonth({ dom: "middle" }, { year: 2027, month: 5 }), 15);
  assert.equal(targetDayOfMonth({ dom: "first" }, { year: 2026, month: 8 }), 1);
});

test("a weekdays-only schedule never yields a weekend occurrence", () => {
  const chore = { cadence: "monthly", dom: "middle", weekdaysOnly: true };
  const got = nextOccurrences(chore, 12);
  assert.equal(got.length, 12);
  for (const d of got) assert.ok(![0, 6].includes(wdOf(d)), `${d} is a ${WD[wdOf(d)]}`);
});

// --- on-miss default ----------------------------------------------------------
test("defaultOnMiss: weekly-or-more-frequent is swept, rarer survives", () => {
  assert.equal(defaultOnMiss({ cadence: "daily" }), "replace");
  assert.equal(defaultOnMiss({ cadence: "weekly" }), "replace");
  assert.equal(defaultOnMiss({ cadence: "monthly" }), "skip");
  assert.equal(defaultOnMiss({ cadence: "annually" }), "skip");
  assert.equal(defaultOnMiss({ cadence: "interval", intervalDays: 7 }), "replace", "<=7d is frequent");
  assert.equal(defaultOnMiss({ cadence: "interval", intervalDays: 8 }), "skip");
});

test("nextOccurrences returns ascending dates and honours the skip predicate", () => {
  const chore = { cadence: "weekly", days: ["saturday"] };
  const got = nextOccurrences(chore, 3);
  assert.equal(got.length, 3);
  assert.deepEqual([...got].sort(), got, "must be ascending");
  const skipped = nextOccurrences(chore, 3, (ymd) => ymd === got[0]);
  assert.ok(!skipped.includes(got[0]), "skip predicate must exclude held dates");
});
