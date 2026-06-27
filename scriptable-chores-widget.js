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
// Tapping opens today's chore list, where each task links into Linear to mark done.
const TAP_URL = `${WORKER}/widget?user=${encodeURIComponent(USER)}`;

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
    // Cache-bust + no-cache so a refresh always reflects chores just marked done.
    const q = USER ? `?user=${encodeURIComponent(USER)}&` : "?";
    const req = new Request(`${WORKER}/status${q}t=${Date.now()}`);
    req.headers = { "Cache-Control": "no-cache" };
    const r = await req.loadJSON();
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
    // Rectangular Lock Screen: iOS forces a flat monochrome render here, so
    // we just add an icon + a couple of titles. Background/colors are ignored.
    const row = w.addStack();
    row.centerAlignContent();
    const img = row.addImage(symbol(ok, done).image);
    img.imageSize = new Size(14, 14);
    row.addSpacer(5);
    const head = row.addText(!ok ? "Chores: ?" : done ? "All done today" : `${remaining} chore${remaining === 1 ? "" : "s"} left`);
    head.font = Font.semiboldSystemFont(13);
    for (const line of listLines(tasks, 2, 26)) {
      const t = w.addText(line);
      t.font = Font.systemFont(11);
    }
  } else {
    // Home Screen: gradient "glass" card with an icon header + chore list.
    const grad = new LinearGradient();
    grad.startPoint = new Point(0, 0);
    grad.endPoint = new Point(1, 1);
    grad.colors = !ok
      ? [new Color("#475569"), new Color("#1e293b")]
      : done
        ? [new Color("#34d399"), new Color("#047857")]
        : [new Color("#fb7185"), new Color("#9d174d")];
    const small = fam === "systemSmall";
    w.backgroundGradient = grad;
    w.cornerRadius = 24;
    w.setPadding(13, 15, 13, 15);

    const row = w.addStack();
    row.centerAlignContent();
    const img = row.addImage(symbol(ok, done).image);
    img.imageSize = small ? new Size(17, 17) : new Size(20, 20);
    img.tintColor = Color.white();
    row.addSpacer(6);
    const head = row.addText(!ok ? "Chores" : done ? "All done" : `${remaining} left`);
    head.textColor = Color.white();
    head.font = Font.boldSystemFont(small ? 16 : 18);

    w.addSpacer(small ? 6 : 8);
    if (!done && ok && tasks.length) {
      const max = small ? 4 : 6;
      const width = small ? 16 : 34;
      for (const line of listLines(tasks, max, width)) {
        const t = w.addText(line);
        t.textColor = new Color("#ffffff", 0.92);
        t.font = Font.mediumSystemFont(small ? 11 : 12);
        t.lineLimit = 1;
        t.minimumScaleFactor = 0.85;
      }
    } else {
      const s = w.addText(done && ok ? "Nice work — nothing left today." : "today's chores");
      s.textColor = new Color("#ffffff", 0.9);
      s.font = Font.systemFont(12);
    }
    w.addSpacer();
  }

  w.url = TAP_URL; // Home Screen taps open directly
  // Hint iOS to refresh ~10 min out (it still throttles; not instant).
  w.refreshAfterDate = new Date(Date.now() + 10 * 60 * 1000);
  return w;
}

// Pick an SF Symbol for the current state.
function symbol(ok, done) {
  const s = SFSymbol.named(!ok ? "questionmark.circle" : done ? "checkmark.seal.fill" : "checklist");
  s.applyFont(Font.semiboldSystemFont(18));
  return s;
}

// Format up to `max` task titles as "• title" lines (truncated to `width`),
// adding a "+N more" line when the list is longer.
function listLines(tasks, max, width) {
  const out = [];
  const shown = tasks.slice(0, max);
  for (const item of shown) {
    const title = typeof item === "string" ? item : item.title || "";
    const t = title.length > width ? title.slice(0, width - 1) + "…" : title;
    out.push("• " + t);
  }
  if (tasks.length > shown.length) out.push(`+${tasks.length - shown.length} more`);
  return out;
}
