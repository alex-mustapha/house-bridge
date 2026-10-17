// The digest message and its action rows. Pins the Discord limits (5 rows, 25
// options) and the empty-vs-cleared distinction that would otherwise freeze the
// live digest on its last unresolved chore.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDigestMessage,
  buildAllClearMessage,
  buildDigestMenu,
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

test("option values encode action:id:team so the handler can route them", () => {
  const rows = buildDigestMenu([mk(TODAY, "Alex", "X")], []);
  for (const row of rows) {
    for (const o of row.components[0].options) {
      const parts = o.value.split(":");
      assert.equal(parts.length, 3, o.value);
      assert.ok(["done", "cancel", "claim", "snooze"].includes(parts[0]), parts[0]);
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
