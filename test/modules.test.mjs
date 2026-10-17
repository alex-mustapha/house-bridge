// `node --check` validates syntax only. It does not catch a function that is
// called but never imported — which is exactly what happened when the shared
// config helpers were introduced and one file lost its `choreProjects` import.
// Importing every module executes its top-level code and surfaces missing
// bindings, circular-import failures and TDZ errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = fs.readdirSync(SRC).filter((f) => f.endsWith(".js")).sort();

test("there is something to check", () => {
  assert.ok(files.length > 10, `only found ${files.length} modules`);
});

for (const f of files) {
  test(`${f} imports cleanly`, async () => {
    await assert.doesNotReject(
      () => import(new URL(`../src/${f}`, import.meta.url).href),
      `${f} failed to import — missing binding, circular import, or top-level throw`,
    );
  });
}

test("config defaults are not duplicated back into the modules", () => {
  // These four defaults were once spelled out inline 61 times. config.js is the
  // only place they belong.
  const patterns = [
    /CHORES_PROJECT \|\| "House Chores"/,
    /ADHOC_PROJECT \|\| "Ad Hoc"/,
    /RECURRING_PROJECT \|\| "Recurring"/,
    /CHORES_TEAM \|\| "CHO"/,
  ];
  for (const f of files) {
    if (f === "config.js") continue;
    const src = fs.readFileSync(path.join(SRC, f), "utf8");
    for (const p of patterns) {
      assert.ok(!p.test(src), `${f} re-declares a config default (${p}) — import it from config.js`);
    }
  }
});

test("no module reaches for a chore project without the helper", () => {
  const src = fs.readFileSync(path.join(SRC, "config.js"), "utf8");
  for (const fn of ["choresProject", "adhocProject", "recurringProject", "choresTeam", "choreProjects"]) {
    assert.match(src, new RegExp(`export const ${fn}`), `config.js should export ${fn}`);
  }
});

// --- static guards for bugs that pass every syntax check -----------------------
//
// Two real outages came from the config.js refactor, both invisible to
// `node --check` and to the import test above (importing a module never executes
// its functions):
//
//   const recurringProject = recurringProject(env);   // TDZ ReferenceError
//   if (choreProjects.includes(proj))                 // .includes on a function
//
// Both threw on the first lines of handleEvent, inside ctx.waitUntil, where
// nothing surfaces — so every Linear webhook died silently for hours.
//
// These checks use plain string work and regex LITERALS only. An earlier version
// built them with `new RegExp(\`\b...\`)`, where a template literal turns \b
// into a backspace character and \s into a bare "s" — the guards compiled to
// patterns that matched nothing and passed while the bug was present. If you
// change one, re-break the code and confirm it actually fails.

const HELPERS = [
  "choresProject",
  "adhocProject",
  "recurringProject",
  "choresTeam",
  "choreProjects",
];

// `const NAME = <rest>` — regex literal, so nothing re-escapes it.
const DECL = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+)$/;

const declarations = (src) =>
  src
    .split("\n")
    .map((line) => DECL.exec(line))
    .filter(Boolean)
    .map((m) => ({ name: m[1], rhs: m[2].trim() }));

test("no declaration initialises a variable from itself (TDZ)", () => {
  for (const f of files) {
    const src = fs.readFileSync(path.join(SRC, f), "utf8");
    for (const { name, rhs } of declarations(src)) {
      assert.ok(
        !(rhs.startsWith(name + "(") || rhs.startsWith(name + ".") || rhs.startsWith(name + ";")),
        `${f}: \`${name} = ${rhs.slice(0, 50)}\` reads ${name} inside its own ` +
          `initializer — a ReferenceError at runtime that passes a syntax check`,
      );
    }
  }
});

test("no local shadows an imported config helper", () => {
  for (const f of files) {
    if (f === "config.js") continue;
    const src = fs.readFileSync(path.join(SRC, f), "utf8");
    for (const { name } of declarations(src)) {
      assert.ok(
        !HELPERS.includes(name),
        `${f} declares a local named "${name}", shadowing the imported helper`,
      );
    }
  }
});

test("config helpers are always called, never used as a value", () => {
  for (const f of files) {
    if (f === "config.js") continue;
    const src = fs.readFileSync(path.join(SRC, f), "utf8");
    for (const h of HELPERS) {
      for (const bad of [h + ".", h + "["]) {
        assert.ok(
          !src.includes(bad),
          `${f} uses \`${bad}\` — ${h} is a function, so call it: ${h}(env)${bad.slice(-1)}..`,
        );
      }
    }
  }
});

test("handleEvent executes its opening lines without throwing", async () => {
  // The exact failure mode: a non-Issue payload returns early, so this runs
  // handleEvent's top with no network and no env beyond defaults. Either bug
  // above fails here instead of vanishing into waitUntil.
  const { handleEvent } = await import("../src/index.js");
  await assert.doesNotReject(
    () => handleEvent({ type: "Comment", action: "create", data: {} }, {}),
    "handleEvent threw before reaching its early return",
  );
});
