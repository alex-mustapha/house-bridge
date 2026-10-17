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

// --- TDZ / shadowing -----------------------------------------------------------
// The config refactor rewrote the right-hand side of
// `const recurringProject = env.RECURRING_PROJECT || "Recurring"` and left the
// left-hand side naming the same thing as the newly imported helper, producing
// `const recurringProject = recurringProject(env)`. That throws a
// ReferenceError the moment the line runs. It passed `node --check`, passed the
// import smoke test above (importing a module does not execute its functions),
// and killed every Linear webhook silently for hours.

test("no self-referencing declaration (TDZ ReferenceError)", () => {
  for (const f of files) {
    const src = fs.readFileSync(path.join(SRC, f), "utf8");
    const hits = src.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\s*\(/g);
    assert.equal(
      hits,
      null,
      `${f} declares a variable from itself (${hits && hits.join(", ")}) — ` +
        `this throws at runtime but passes a syntax check`,
    );
  }
});

test("no local shadows an imported config helper", () => {
  const HELPERS = ["choresProject", "adhocProject", "recurringProject", "choresTeam", "choreProjects"];
  for (const f of files) {
    if (f === "config.js") continue;
    const src = fs.readFileSync(path.join(SRC, f), "utf8");
    for (const h of HELPERS) {
      assert.ok(
        !new RegExp(`\b(?:const|let|var)\s+${h}\b`).test(src),
        `${f} declares a local named "${h}", shadowing the imported helper`,
      );
    }
  }
});

test("handleEvent executes its opening lines without throwing", async () => {
  // Exercises the exact line that broke: a non-Issue payload returns early, so
  // this runs handleEvent's top with no network and no env beyond defaults. A
  // TDZ error on those lines fails here instead of silently in waitUntil.
  const { handleEvent } = await import("../src/index.js");
  await assert.doesNotReject(
    () => handleEvent({ type: "Comment", action: "create", data: {} }, {}),
    "handleEvent threw before reaching its early return",
  );
});
