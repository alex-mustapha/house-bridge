// Chores status widget for iPhone via the free Scriptable app.
//
// Setup:
//   1. Install "Scriptable" from the App Store.
//   2. New script -> paste this in. (Set USER to your Linear name; /status needs no key.)
//   3. Long-press Lock Screen (or Home Screen) -> Customize -> add a Scriptable
//      widget -> pick this script.
//   Tapping the widget opens your open tasks in Linear.

const WORKER = "https://linear-discord-bridge.muffinfactory.workers.dev";
const USER = "Alex"; // your Linear name (set "" for whole-household status)
const TAP_URL = "https://linear.app/alex-kristal/my-issues"; // opens on tap

if (config.runsInWidget) {
  Script.setWidget(await buildWidget());
} else {
  // Tapped (or run manually) -> jump to Linear. This covers Lock Screen widgets,
  // which run the script on tap instead of honoring widget.url.
  Safari.open(TAP_URL);
}
Script.complete();

async function buildWidget() {
  let done = false;
  let remaining = 0;
  let tasks = [];
  let ok = true;
  try {
    const url = `${WORKER}/status${USER ? `?user=${encodeURIComponent(USER)}` : ""}`;
    const r = await new Request(url).loadJSON();
    if (r.error) ok = false;
    else {
      done = r.done;
      remaining = r.remaining;
      tasks = r.tasks || [];
    }
  } catch (e) {
    ok = false;
  }

  const fam = config.widgetFamily;
  const w = new ListWidget();

  if (fam === "accessoryInline") {
    // Inline (single line, next to the clock): count only.
    w.addText(!ok ? "Chores ?" : done ? "✅ Chores done" : `❗ ${remaining} chore${remaining === 1 ? "" : "s"} left`);
  } else if (fam === "accessoryCircular") {
    const t = w.addText(!ok ? "?" : done ? "✅" : `❗${remaining}`);
    t.font = Font.boldSystemFont(20);
    t.centerAlignText();
  } else if (fam === "accessoryRectangular") {
    // Rectangular Lock Screen: header + up to 3 chore titles.
    const head = w.addText(!ok ? "Chores: ?" : done ? "✅ All done today" : `❗ ${remaining} chore${remaining === 1 ? "" : "s"} left`);
    head.font = Font.semiboldSystemFont(13);
    for (const line of listLines(tasks, 3, 24)) {
      const t = w.addText(line);
      t.font = Font.systemFont(11);
    }
  } else {
    // Home Screen (small/medium/large): colored card, header + chore list.
    w.backgroundColor = !ok ? new Color("#3a3a3a") : done ? new Color("#1f6f3f") : new Color("#7a1f1f");
    const head = w.addText(!ok ? "Chores: ?" : done ? "✅ All done" : `❗ ${remaining} left`);
    head.textColor = Color.white();
    head.font = Font.boldSystemFont(18);
    w.addSpacer(4);
    if (!done && ok && tasks.length) {
      const max = fam === "systemSmall" ? 3 : 6;
      for (const line of listLines(tasks, max, 34)) {
        const t = w.addText(line);
        t.textColor = Color.white();
        t.font = Font.systemFont(12);
      }
    } else {
      const s = w.addText("today's chores");
      s.textColor = Color.white();
      s.font = Font.systemFont(11);
    }
  }

  w.url = TAP_URL; // Home Screen taps open directly
  return w;
}

// Format up to `max` task titles as "• title" lines (truncated to `width`),
// adding a "+N more" line when the list is longer.
function listLines(tasks, max, width) {
  const out = [];
  const shown = tasks.slice(0, max);
  for (const title of shown) {
    const t = title.length > width ? title.slice(0, width - 1) + "…" : title;
    out.push("• " + t);
  }
  if (tasks.length > shown.length) out.push(`+${tasks.length - shown.length} more`);
  return out;
}
