// Chores status widget for iPhone via the free Scriptable app.
//
// Setup:
//   1. Install "Scriptable" from the App Store.
//   2. New script -> paste this in -> set the three constants below.
//   3. Long-press your Lock Screen (or Home Screen) -> Customize -> add a
//      Scriptable widget -> pick this script.
//      - Lock Screen "inline" slot (above the clock) shows a one-liner.
//      - Lock Screen "circular" slot shows ✅ / ❗N.
//
// Shows ✅ when today's chores are done, ❗ with a count when some are still due.

const WORKER = "https://linear-discord-bridge.muffinfactory.workers.dev";
const KEY = "YOUR_CRON_KEY"; // your CRON_KEY
const USER = "Alex"; // your Linear name (omit ?user for whole-household status)

let done = false;
let remaining = 0;
let ok = true;
try {
  const url = `${WORKER}/status?key=${encodeURIComponent(KEY)}${USER ? `&user=${encodeURIComponent(USER)}` : ""}`;
  const r = await new Request(url).loadJSON();
  if (r.error) ok = false;
  else {
    done = r.done;
    remaining = r.remaining;
  }
} catch (e) {
  ok = false;
}

const fam = config.widgetFamily;
const w = new ListWidget();

if (fam === "accessoryInline") {
  // One line above the clock on the Lock Screen.
  w.addText(!ok ? "Chores ?" : done ? "✅ Chores done" : `❗ ${remaining} chore${remaining === 1 ? "" : "s"} left`);
} else if (fam === "accessoryCircular") {
  const t = w.addText(!ok ? "?" : done ? "✅" : `❗${remaining}`);
  t.font = Font.boldSystemFont(20);
  t.centerAlignText();
} else if (fam === "accessoryRectangular") {
  const t = w.addText(!ok ? "Chores: ?" : done ? "✅ All done today" : `❗ ${remaining} chore${remaining === 1 ? "" : "s"} left`);
  t.font = Font.semiboldSystemFont(14);
} else {
  // Home Screen widget.
  w.backgroundColor = !ok ? new Color("#3a3a3a") : done ? new Color("#1f6f3f") : new Color("#7a1f1f");
  const t = w.addText(!ok ? "Chores: ?" : done ? "✅ All done" : `❗ ${remaining} left`);
  t.textColor = Color.white();
  t.font = Font.boldSystemFont(20);
  w.addSpacer(4);
  const s = w.addText("today's chores");
  s.textColor = Color.white();
  s.font = Font.systemFont(11);
}

Script.setWidget(w);
Script.complete();
