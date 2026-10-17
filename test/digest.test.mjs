// The digest message and its action rows. Pins the Discord limits (5 rows, 25
// options) and the empty-vs-cleared distinction that would otherwise freeze the
// live digest on its last unresolved chore.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDigestMessage,
  buildAllClearMessage,
  buildDigestMenu,
  digestBytes,
  fitDigestPayload,
  DIGEST_BUDGET_BYTES,
} from "../src/discord.js";

const TODAY = "2026-10-17";
let seq = 0;
const mk = (dueDate, who, title) => ({
  id: `i${++seq}`, identifier: `CHO-${100 + seq}`, title: title || `Chore ${seq}`,
  dueDate, assignee: who ? { name: who } : null,
  url: `https://linear.app/x/${seq}`, project: { name: "House Chores" }, team: { id: "T" },
});

test("the digest states the date outright", () => {
  const m = buildDigestMessage([mk(TODAY, "Alex")], {}, TODAY, [], [], null);
  assert.match(m.content, /Sat Oct 17/, "a relative Discord timestamp is not enough");
});

test("the remaining count covers today, overdue and undated — not later this week", () => {
  const issues = [
    mk("2026-10-15", "Alex"),  // overdue
    mk(TODAY, "Alex"),         // today
    mk("2026-10-19", "Alex"),  // later this week
    mk(null, null),            // undated
  ];
  const m = buildDigestMessage(issues, {}, TODAY, [], [], null);
  assert.match(m.content, /3 left/);
});

test("the count shrinks as chores are resolved", () => {
  const all = [mk(TODAY, "Alex", "A"), mk(TODAY, "Alex", "B"), mk(TODAY, "Alex", "C")];
  assert.match(buildDigestMessage(all, {}, TODAY, [], [], null).content, /3 left/);
  assert.match(buildDigestMessage(all.slice(2), {}, TODAY, [], [], null).content, /1 left/);
});

test("all-clear is dated, green, and drops the dropdowns", () => {
  const m = buildAllClearMessage(TODAY);
  assert.match(m.content, /Sat Oct 17/);
  assert.match(m.content, /All clear/);
  assert.deepEqual(m.components, [], "nothing left to act on");
  assert.deepEqual(m.allowed_mentions.parse, [], "must not ping anyone");
});

test("all-clear carries no streak number", () => {
  // choreStreak excludes today, so a number here would read one lower than the
  // day being looked at and disagree with the widget and the recap.
  const blob = JSON.stringify(buildAllClearMessage(TODAY));
  assert.ok(!/\d+\s*clear day/.test(blob), "the column of dated check marks IS the streak");
});

test("menu rows stay within Discord's 5-row limit", () => {
  const issues = [mk(TODAY, "Alex"), mk(TODAY, "Kristal"), mk(TODAY, null)];
  const rows = buildDigestMenu(issues, []);
  assert.ok(rows.length <= 5, `got ${rows.length} rows`);
  assert.ok(rows.length >= 3);
});

test("every select caps at 25 options even with far more chores", () => {
  const many = Array.from({ length: 40 }, (_, k) => mk(TODAY, "Alex", `Chore ${k}`));
  for (const row of buildDigestMenu(many, [])) {
    const c = row.components[0];
    assert.ok(c.options.length <= 25, `${c.custom_id} had ${c.options.length}`);
    assert.ok(c.max_values <= 25);
    assert.ok(c.max_values <= c.options.length, "max_values cannot exceed the options");
  }
});

test("snooze is offered for dated chores only", () => {
  const rows = buildDigestMenu([mk(TODAY, "Alex", "Dated"), mk(null, "Alex", "Undated")], []);
  const snooze = rows.map((r) => r.components[0]).find((c) => c.custom_id === "snooze-menu");
  assert.ok(snooze, "there should be a snooze row");
  assert.equal(snooze.options.length, 1, "snoozing an undated chore would invent a date");
  assert.match(snooze.options[0].label, /Dated/);
});

test("option values are action:issueId, with no repeated team id", () => {
  // The team id used to be a third part: the same UUID on every option of every
  // row, which helped push the message past Discord's total size cap.
  const rows = buildDigestMenu([mk(TODAY, "Alex", "X")], []);
  for (const row of rows) {
    for (const o of row.components[0].options) {
      const parts = o.value.split(":");
      assert.equal(parts.length, 2, `${o.value} should be action:issueId`);
      assert.ok(["done", "cancel", "claim", "snooze"].includes(parts[0]), parts[0]);
    }
  }
});

test("options carry no description — the embed above already says it", () => {
  const rows = buildDigestMenu([mk(TODAY, "Alex", "X")], []);
  for (const row of rows) {
    for (const o of row.components[0].options) {
      assert.equal(o.description, undefined, `${o.value} still has a description`);
    }
  }
});

test("a row with nothing to offer is omitted rather than sent empty", () => {
  // only unassigned work: nothing to mark done, nothing to cancel
  const rows = buildDigestMenu([mk(null, null, "Unowned")], []);
  const ids = rows.map((r) => r.components[0].custom_id);
  assert.ok(ids.includes("claim-menu"));
  assert.ok(!ids.includes("actions-menu"), "Discord rejects an empty select");
  assert.ok(!ids.includes("snooze-menu"), "undated, so nothing to push");
});

test("the embed description stays inside Discord's 4000-char limit", () => {
  const many = Array.from({ length: 120 }, (_, k) =>
    mk(TODAY, k % 2 ? "Alex" : "Kristal", `A fairly long chore title number ${k}`));
  const m = buildDigestMessage(many, {}, TODAY, [], [], null);
  assert.ok(m.embeds[0].description.length <= 4000, m.embeds[0].description.length);
});

test("the digest never leaks the private leisure tracker", () => {
  const m = buildDigestMessage([mk(TODAY, "Alex")], {}, TODAY, [], [], null);
  assert.ok(!/leisure/i.test(JSON.stringify(m)));
});

// --- size: the regression that silently stopped the digest posting ------------
test("a busy day fits inside the Discord size budget", () => {
  // 15 chores is a real day and is what got rejected at 13,374 bytes.
  const issues = Array.from({ length: 15 }, (_, k) =>
    mk(k % 3 === 0 ? "2026-10-15" : TODAY, k % 2 ? "Alex" : "Kristal",
       `A realistically long chore title ${k}`));
  const msg = buildDigestMessage(issues, {}, TODAY, [], [], null);
  const payload = { ...msg, components: buildDigestMenu(issues, []) };
  assert.ok(
    digestBytes(payload) <= DIGEST_BUDGET_BYTES,
    `${digestBytes(payload)}B exceeds the ${DIGEST_BUDGET_BYTES}B budget`,
  );
});

test("sections are included by default and omitted only when asked", () => {
  const issues = [mk(TODAY, "Alex", "Today"), mk("2026-10-19", "Alex", "Later")];
  const anytime = [{ title: "Patch driveway", url: "u", createdAt: "2026-01-01" }];

  const full = buildDigestMessage(issues, {}, TODAY, [], anytime, null);
  assert.match(full.embeds[0].description, /Anytime/);
  assert.match(full.embeds[0].description, /Upcoming/);

  const noAnytime = buildDigestMessage(issues, {}, TODAY, [], anytime, null, { includeAnytime: false });
  assert.ok(!/Anytime/.test(noAnytime.embeds[0].description));
  assert.match(noAnytime.embeds[0].description, /Upcoming/, "upcoming survives the first cut");

  const minimal = buildDigestMessage(issues, {}, TODAY, [], anytime, null, {
    includeAnytime: false, includeUpcoming: false,
  });
  assert.ok(!/Anytime/.test(minimal.embeds[0].description));
  assert.ok(!/Upcoming/.test(minimal.embeds[0].description));
  assert.match(minimal.embeds[0].description, /Today/, "today is never shed");
});

test("shedding sections makes the payload strictly smaller", () => {
  const issues = Array.from({ length: 12 }, (_, k) => mk(k < 6 ? TODAY : "2026-10-19", "Alex", `Chore ${k}`));
  const anytime = [{ title: "Patch driveway", url: "u", createdAt: "2026-01-01" }];
  const size = (o) => digestBytes(buildDigestMessage(issues, {}, TODAY, [], anytime, null, o));
  const full = size({});
  const noAny = size({ includeAnytime: false });
  const least = size({ includeAnytime: false, includeUpcoming: false });
  assert.ok(noAny < full, "dropping Anytime must shrink it");
  assert.ok(least < noAny, "dropping Upcoming must shrink it further");
});

test("fitDigestPayload leaves a payload under budget untouched", () => {
  const msg = buildDigestMessage([mk(TODAY, "Alex")], {}, TODAY, [], [], null);
  const payload = { ...msg, components: buildDigestMenu([mk(TODAY, "Alex")], []) };
  const r = fitDigestPayload(payload);
  assert.deepEqual(r.dropped, []);
  assert.equal(r.trimmedTo, null);
  assert.equal(r.payload, payload, "must be the same object, not a rebuild");
});

test("fitDigestPayload sheds dropdowns, and never the Mark done row", () => {
  const many = Array.from({ length: 25 }, (_, k) =>
    mk(TODAY, "Alex", `An extremely long chore title used to blow the size budget ${k}`));
  const msg = buildDigestMessage(many, {}, TODAY, [], [], null);
  const payload = { ...msg, components: buildDigestMenu(many, []) };
  const before = digestBytes(payload);

  // A budget above the embed floor (fitDigestPayload only sheds COMPONENTS —
  // the embed is the caller's job, via the includeAnytime/includeUpcoming
  // levels) but below the full payload, so shedding is actually exercised.
  // The achievable floor is the embed plus one trimmed "Mark done" row, so the
  // budget has to leave room for that much.
  const embedFloor = digestBytes({ ...msg, components: [] });
  const budget = embedFloor + 1000;
  const r = fitDigestPayload(payload, budget);

  assert.ok(r.bytes < before, `expected shrinkage, got ${before}B -> ${r.bytes}B`);
  assert.ok(r.bytes <= budget, `${r.bytes}B still over the ${budget}B budget`);
  assert.ok(r.dropped.length > 0, "something should have been shed");
  const left = r.payload.components.map((c) => c.components[0].custom_id);
  assert.ok(left.includes("actions-menu"), "Mark done must never be dropped");
  assert.ok(!r.dropped.includes("actions-menu"));
});

test("the embed can never alone exceed the budget, so a fit is always reachable", () => {
  // buildDigestMessage caps the description at 4000 chars; that plus a minimal
  // component set has to leave room, or fitDigestPayload could not succeed.
  const many = Array.from({ length: 200 }, (_, k) =>
    mk(TODAY, k % 2 ? "Alex" : "Kristal", `A very long chore title to pad the embed out ${k}`));
  const msg = buildDigestMessage(many, {}, TODAY, [], [], null);
  const floor = digestBytes({ ...msg, components: [] });
  assert.ok(
    floor < DIGEST_BUDGET_BYTES,
    `embed floor ${floor}B leaves no room under the ${DIGEST_BUDGET_BYTES}B budget`,
  );
});
