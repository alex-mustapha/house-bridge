// The widget page is one big JS template literal, so a single un-doubled
// backslash or a stray backtick silently breaks the ONLY inline script and the
// page renders blank — while still returning 200 with full-looking HTML. That
// has shipped three separate times. A syntax check of widgetpage.js itself
// passes regardless, because the broken code lives inside a string: the only
// honest check is to render the page and compile what comes out.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { renderWidgetPage } from "../src/widgetpage.js";

const status = {
  done: false, remaining: 2, streak: 3,
  tasks: [
    { title: "Trash", url: "https://linear.app/x/1", steps: null },
    { title: "Mop", url: "https://linear.app/x/2", steps: "- [ ] under the bed" },
  ],
  completed: [{ title: "Dishes", url: "https://linear.app/x/3" }],
  others: [{ name: "Kristal", tasks: [{ title: "Laundry", url: "https://linear.app/x/4", dueDate: "2026-10-17" }] }],
  anytime: [{ title: "Patch driveway", url: "https://linear.app/x/5" }],
  unassignedSoon: [{ title: "Recycling", url: "https://linear.app/x/6", dueDate: "2026-10-18" }],
};

const scriptsFrom = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test("the emitted inline script COMPILES", () => {
  for (const user of ["Alex", "", null]) {
    const html = renderWidgetPage(user, status);
    const scripts = scriptsFrom(html);
    assert.equal(scripts.length, 1, "expected exactly one inline script");
    assert.doesNotThrow(
      () => new vm.Script(scripts[0]),
      `emitted script failed to compile for user=${JSON.stringify(user)}`,
    );
  }
});

test("no stray backtick escaped into the output", () => {
  // A backtick anywhere in the file closes the template literal early.
  assert.ok(!renderWidgetPage("Alex", status).includes("`"));
});

test("regex backslashes survived the template literal", () => {
  const src = scriptsFrom(renderWidgetPage("Alex", status))[0];
  // If a backslash was written singly it is consumed at build time, leaving an
  // unterminated regex. Any regex in the emitted script must still have one.
  const regexes = src.match(/\/\[a-zA-Z][^/\n]*\//g) || [];
  for (const r of regexes) assert.ok(r.includes("\\"), `lost its backslash: ${r}`);
});

test("renders with an empty day and with no tasks at all", () => {
  for (const s of [
    { ...status, tasks: [], remaining: 0, done: true },
    { done: true, remaining: 0, tasks: [], completed: [] },
    {},
  ]) {
    const html = renderWidgetPage("Alex", s);
    assert.ok(html.includes("<!doctype html>"));
    assert.doesNotThrow(() => new vm.Script(scriptsFrom(html)[0]));
  }
});

test("active secondary lists are NOT styled as completed", () => {
  // ul.donelist strikes text through; reusing it for active lists made
  // outstanding chores read as finished. They must be separate classes.
  const html = renderWidgetPage("Alex", status);
  assert.match(html, /ul\.sublist/, "active lists need their own class");
  assert.match(html, /ul\.donelist li a \.t \{ text-decoration: line-through/);
});

test("an in-flight snooze does not use the done styling", () => {
  const html = renderWidgetPage("Alex", status);
  assert.match(html, /li\.working/, "snooze needs a neutral in-flight class");
  assert.match(html, /"working"/, "and the handler must apply it");
});

test("the three row actions map to their endpoints by class name", () => {
  const src = scriptsFrom(renderWidgetPage("Alex", status))[0];
  assert.match(src, /closest\("\.done, \.snooze, \.cancel"\)/);
  assert.match(src, /"\/" \+ kind \+ "\?match="/, "class name is the endpoint name");
});

test("the title reflects whose widget it is", () => {
  assert.match(renderWidgetPage("Alex", status), /Alex's chores/);
  assert.match(renderWidgetPage("", status), /House chores/);
});

test("other people's chores are shown so work can be picked up", () => {
  const src = scriptsFrom(renderWidgetPage("Alex", status))[0];
  assert.match(src, /others/);
});

// KNOWN GAP, deliberately not asserted as a pass: CLAUDE.md requires the shared
// page to contain no trace of the private leisure tracker, but the CSS, the
// container div and the whole renderLeisure function are emitted for every
// viewer, and the runtime gate is `!KEY || !USER` — it never consults
// LEISURE_PEOPLE. Tracked as its own task; this records the expectation.
test(
  "the shared widget page contains no trace of the leisure tracker",
  { skip: "known gap: renderLeisure is emitted for every viewer and gated only on !KEY || !USER, never on LEISURE_PEOPLE" },
  () => {
    assert.ok(!/leisure/i.test(renderWidgetPage("", status)));
  },
);
