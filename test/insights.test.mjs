// The monthly review's rules. These produce ADVICE, so the thresholds matter as
// much as the arithmetic: the first version fired on absolute counts and
// reported "missed 3 of 38 (8%)" as a problem, which buried the findings that
// were actually worth acting on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, summarize, groupByTitle, parseTargetSplit, RULES } from "../src/insights.js";
import { renderPlain, buildInsightsPost } from "../src/insightspost.js";

// A row as chore_log stores it. `done` is the Eastern completion date.
const row = (title, due, status, done = null, assignee = "Alex") => ({
  title,
  assignee,
  due_date: due,
  completed_date: done,
  status,
});

// n occurrences of a weekly chore, due on `dueDow`, completed `offset` days later.
const weekly = (title, firstDue, n, offset, status = "late", assignee = "Alex") => {
  const out = [];
  const [y, m, d] = firstDue.split("-").map(Number);
  for (let k = 0; k < n; k++) {
    const due = new Date(Date.UTC(y, m - 1, d + k * 7));
    const done = new Date(Date.UTC(y, m - 1, d + k * 7 + offset));
    out.push(
      row(
        title,
        due.toISOString().slice(0, 10),
        status,
        status === "missed" || status === "canceled" ? null : done.toISOString().slice(0, 10),
        assignee,
      ),
    );
  }
  return out;
};

test("groupByTitle ignores unresolved and undated rows", () => {
  const g = groupByTitle([
    row("A", "2026-10-01", "on_time", "2026-10-01"),
    row("A", "2026-10-08", "open"),
    row("B", null, "on_time", "2026-10-01"),
  ]);
  assert.equal(g.length, 1);
  assert.equal(g[0].n, 1, "open and undated rows carry no signal");
});

test("summarize excludes cancellations from the rates", () => {
  const s = summarize([
    row("A", "2026-10-01", "on_time", "2026-10-01"),
    row("A", "2026-10-08", "missed"),
    row("A", "2026-10-15", "canceled"),
  ]);
  assert.equal(s.total, 3, "volume still counts them");
  assert.equal(s.canceled, 1);
  assert.equal(s.onTimePct, 50, "1 of 2 counted, not 1 of 3");
  assert.equal(s.completionPct, 50);
});

// --- wrong weekday: the rule that turns "always late" into "move it" ----------
test("a chore always finished a day late is reported as wrongly scheduled", () => {
  // Due Saturday, done Sunday, 8 times.
  const { findings } = analyze(weekly("Laundry", "2026-08-01", 8, 1));
  const f = findings.find((x) => x.kind === "wrong-weekday");
  assert.ok(f, "expected a wrong-weekday finding");
  assert.equal(f.facts.dueDay, "Sat");
  assert.equal(f.facts.actualDay, "Sun");
  assert.equal(f.facts.avgLateDays, 1);
  assert.match(f.recommendation, /Move Laundry from Sat to Sun/);
});

test("never once on time is called out as such", () => {
  const { findings } = analyze(weekly("Laundry", "2026-08-01", 8, 1));
  const f = findings.find((x) => x.kind === "wrong-weekday");
  assert.equal(f.facts.onTime, 0);
  assert.match(f.recommendation, /never been completed on time/);
});

test("a punctual chore produces no weekday finding", () => {
  const { findings } = analyze(weekly("Trash", "2026-08-03", 8, 0, "on_time"));
  assert.equal(findings.filter((f) => f.kind === "wrong-weekday").length, 0);
});

test("below the sample threshold nothing is recommended", () => {
  const rows = weekly("Rare", "2026-09-05", RULES.weekdayMinN - 1, 1);
  assert.equal(analyze(rows).findings.filter((f) => f.kind === "wrong-weekday").length, 0,
    "advice off a handful of points is a guess, not a recommendation");
});

// --- rates, not raw counts ----------------------------------------------------
test("a high count but low miss RATE is not a finding", () => {
  // 3 misses out of 40 is 8%: noise, not a problem.
  const rows = [...weekly("Kitchen", "2026-07-01", 37, 0, "on_time"), ...weekly("Kitchen", "2027-01-06", 3, 0, "missed")];
  const f = analyze(rows).findings.find((x) => x.kind === "chronically-missed");
  assert.equal(f, undefined, "8% should not be reported as chronically missed");
});

test("a high miss rate IS a finding", () => {
  // The completions have to be LATE. If a chore is punctual whenever it is
  // recorded and missing the rest of the time, that is the logging-gap pattern
  // below, not a chore anyone is struggling with — and that rule deliberately
  // outranks this one.
  const rows = [
    ...weekly("Mow", "2026-07-04", 4, 3, "late"),
    ...weekly("Mow", "2026-09-05", 6, 0, "missed"),
  ];
  const f = analyze(rows).findings.find((x) => x.kind === "chronically-missed");
  assert.ok(f, "60% missed should be reported");
  assert.equal(f.facts.missed, 6);
});

test("missed-and-punctual is a logging gap; missed-and-late is a real problem", () => {
  const punctual = [
    ...weekly("P", "2026-07-04", 4, 0, "on_time"),
    ...weekly("P", "2026-09-05", 6, 0, "missed"),
  ];
  const struggling = [
    ...weekly("S", "2026-07-04", 4, 3, "late"),
    ...weekly("S", "2026-09-05", 6, 0, "missed"),
  ];
  assert.equal(analyze(punctual).findings.find((f) => f.title === "P").kind, "possibly-unlogged");
  assert.equal(
    analyze(struggling).findings.find((f) => f.title === "S").kind,
    "chronically-missed",
  );
});

test("frequent cancellation reads as too-frequent, not as failure", () => {
  const rows = [...weekly("Litterbox", "2026-07-01", 5, 0, "on_time"), ...weekly("Litterbox", "2026-09-02", 5, 0, "canceled")];
  const kinds = analyze(rows).findings.map((f) => f.kind);
  assert.ok(kinds.includes("too-frequent"));
  assert.ok(!kinds.includes("chronically-missed"), "cancelling is a decision, not a miss");
});

test("never completed at all is the strongest finding", () => {
  const { findings } = analyze(weekly("Ghost", "2026-08-01", 6, 0, "missed"));
  assert.equal(findings[0].kind, "never-done");
  assert.match(findings[0].recommendation, /not been completed once/);
});

// --- dedupe and ordering ------------------------------------------------------
test("each chore yields at most one finding", () => {
  // This chore trips both wrong-weekday and chronically-missed.
  const rows = [...weekly("Laundry", "2026-07-04", 8, 1), ...weekly("Laundry", "2026-09-05", 4, 0, "missed")];
  const { findings } = analyze(rows);
  const titles = findings.filter((f) => f.kind !== "load-drift").map((f) => f.title);
  assert.equal(new Set(titles).size, titles.length, "no chore should appear twice");
});

test("the more specific explanation wins", () => {
  const rows = [...weekly("Laundry", "2026-07-04", 8, 1), ...weekly("Laundry", "2026-09-05", 4, 0, "missed")];
  const f = analyze(rows).findings.find((x) => x.title === "Laundry");
  assert.equal(f.kind, "wrong-weekday", "'move it to Sunday' beats 'it gets missed a lot'");
});

test("findings are ordered most actionable first", () => {
  const rows = [
    ...weekly("Ghost", "2026-08-01", 6, 0, "missed"),
    ...weekly("Laundry", "2026-07-04", 8, 1),
  ];
  const kinds = analyze(rows).findings.map((f) => f.kind);
  assert.equal(kinds[0], "never-done");
  assert.ok(kinds.indexOf("never-done") < kinds.indexOf("wrong-weekday"));
});

// --- the logging-gap distinction ----------------------------------------------
test("on-time-when-recorded but often missing reads as a logging gap", () => {
  const rows = [...weekly("Grocery", "2026-07-04", 4, 0, "on_time"), ...weekly("Grocery", "2026-08-08", 4, 0, "missed")];
  const f = analyze(rows).findings.find((x) => x.title === "Grocery");
  assert.equal(f.kind, "possibly-unlogged");
  assert.match(f.recommendation, /not ticked/);
});

// --- effort split -------------------------------------------------------------
test("load drift is reported against the configured target", () => {
  const rows = [
    ...weekly("A", "2026-08-01", 9, 0, "on_time", "Alex"),
    ...weekly("B", "2026-08-01", 1, 0, "on_time", "Kristal"),
  ];
  const { findings, split } = analyze(rows, { targetSplit: { Alex: 60, Kristal: 40 } });
  assert.equal(split.find((s) => s.name === "Alex").share, 90);
  const f = findings.find((x) => x.kind === "load-drift");
  assert.ok(f, "90% against a 60% target should be flagged");
  assert.equal(f.facts.drift, 30);
});

test("a split close to target is not flagged", () => {
  const rows = [
    ...weekly("A", "2026-08-01", 6, 0, "on_time", "Alex"),
    ...weekly("B", "2026-08-01", 4, 0, "on_time", "Kristal"),
  ];
  const { findings } = analyze(rows, { targetSplit: { Alex: 60, Kristal: 40 } });
  assert.equal(findings.filter((f) => f.kind === "load-drift").length, 0);
});

test("load drift survives the per-chore dedupe", () => {
  // It is keyed by person, not chore, so it must not be collapsed into a
  // same-named chore finding.
  const rows = [
    ...weekly("Alex", "2026-08-01", 9, 0, "on_time", "Alex"),
    ...weekly("B", "2026-08-01", 1, 0, "on_time", "Kristal"),
  ];
  const { findings } = analyze(rows, { targetSplit: { Alex: 60, Kristal: 40 } });
  assert.ok(findings.some((f) => f.kind === "load-drift"));
});

test("parseTargetSplit reads the ROTATION_WEIGHTS format", () => {
  assert.deepEqual(parseTargetSplit("Alex:60,Kristal:40"), { Alex: 60, Kristal: 40 });
  assert.deepEqual(parseTargetSplit(" Alex : 60 "), { Alex: 60 });
  assert.deepEqual(parseTargetSplit(""), {});
  assert.deepEqual(parseTargetSplit(undefined), {});
  assert.deepEqual(parseTargetSplit("garbage"), {});
});

// --- rendering ----------------------------------------------------------------
const sampleData = () => {
  const rows = [...weekly("Laundry", "2026-07-04", 8, 1), ...weekly("Trash", "2026-07-06", 8, 0, "on_time")];
  return {
    windowDays: 120,
    since: "2026-06-20",
    until: "2026-10-18",
    summary: summarize(rows),
    ...analyze(rows, { targetSplit: { Alex: 60, Kristal: 40 } }),
  };
};

test("the plain render states the window and the findings", () => {
  const out = renderPlain(sampleData());
  assert.match(out, /2026-06-20 to 2026-10-18/);
  // Grouped: the category and its advice are stated once, and the chore line
  // carries only what differs.
  assert.match(out, /\*\*Scheduled on the wrong day\*\*/);
  assert.match(out, /• Laundry — Sat → Sun/);
});

test("a quiet month says so rather than padding", () => {
  const out = renderPlain({
    windowDays: 30, since: "2026-09-18", until: "2026-10-18",
    summary: summarize([]), findings: [], split: [], titlesConsidered: 0,
  });
  assert.match(out, /Nothing stands out/);
});

test("without an API key the post falls back to the computed render", async () => {
  const { source, message } = await buildInsightsPost({}, sampleData());
  assert.equal(source, "computed", "no key must degrade to plain, not to silence");
  assert.match(message.embeds[0].description, /• Laundry — Sat → Sun/);
  assert.match(message.embeds[0].footer.text, /chores considered/);
});

test("the post stays inside Discord's embed limit", async () => {
  const rows = [];
  for (let k = 0; k < 40; k++) rows.push(...weekly(`A very long chore title number ${k}`, "2026-07-04", 8, 1));
  const data = {
    windowDays: 120, since: "2026-06-20", until: "2026-10-18",
    summary: summarize(rows), ...analyze(rows),
  };
  const { message } = await buildInsightsPost({}, data);
  assert.ok(message.embeds[0].description.length <= 4000);
});

test("the post never leaks the private leisure log", async () => {
  const { message } = await buildInsightsPost({}, sampleData());
  assert.ok(!/leisure/i.test(JSON.stringify(message)));
});

// --- grouping -----------------------------------------------------------------
// The first render repeated the category label AND the full advice on every
// line, so three wrong-weekday chores produced the same two sentences three
// times and buried the only part that differed: which chore, and by how much.
test("findings are grouped, with the advice stated once per category", () => {
  const rows = [
    ...weekly("Laundry", "2026-07-04", 8, 1),
    ...weekly("Sweeping", "2026-07-02", 8, 3),
    ...weekly("Mow", "2026-07-04", 4, 3, "late"),
    ...weekly("Mow", "2026-09-05", 6, 0, "missed"),
  ];
  const data = {
    windowDays: 120, since: "2026-06-20", until: "2026-10-18",
    summary: summarize(rows), ...analyze(rows),
  };
  const out = renderPlain(data);

  // The category heading appears exactly once even though two chores share it.
  const headings = out.match(/\*\*Scheduled on the wrong day\*\*/g) || [];
  assert.equal(headings.length, 1, "category stated once, not per chore");

  // And the shared advice sentence likewise.
  const advice = out.match(/Move each one to the day it actually gets done/g) || [];
  assert.equal(advice.length, 1, "advice stated once, not per chore");

  // Both chores are still listed, with their own numbers.
  assert.match(out, /• Laundry — Sat → Sun/);
  assert.match(out, /• Sweeping — Thu → Sun/);
});

test("each group reports how many chores are in it", () => {
  const rows = [...weekly("A", "2026-07-04", 8, 1), ...weekly("B", "2026-07-02", 8, 3)];
  const data = {
    windowDays: 120, since: "2026-06-20", until: "2026-10-18",
    summary: summarize(rows), ...analyze(rows),
  };
  assert.match(renderPlain(data), /\*\*Scheduled on the wrong day\*\* \(2\)/);
});

test("per-chore lines carry facts only, not repeated advice", () => {
  const rows = weekly("Laundry", "2026-07-04", 8, 1);
  const f = analyze(rows).findings[0];
  assert.ok(f.detail, "every finding needs a terse detail string");
  assert.ok(!/Move /.test(f.detail), "the advice belongs to the group, not the line");
  assert.match(f.detail, /Laundry/);
  assert.match(f.detail, /Sat → Sun/);
});

test("all time is labelled as such rather than as a day count", () => {
  const out = renderPlain({
    allTime: true, windowDays: null, since: "2026-06-25", until: "2026-10-17",
    summary: summarize([]), findings: [], split: [], titlesConsidered: 0,
  });
  assert.match(out, /\(all time\)/);
  assert.ok(!/null days/.test(out), "a null window must not render as 'null days'");
});
