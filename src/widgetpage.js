// A styled, mobile-friendly status page served at /widget?user=<name>.
//
// It mirrors the iOS Scriptable widget's gradient card and chore list, but as a
// web page so any phone (Android included) can use it: open in the browser and
// "Add to Home screen" to get an app-like icon that opens this live view.
// Auto-refreshes every 60s and whenever the page is brought back to focus.

const LINEAR_URL = "https://linear.app/alex-kristal/my-issues"; // opens on tap

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

// Inline the first render's data so it shows instantly; client JS refreshes it.
export function renderWidgetPage(user, status) {
  const data = JSON.stringify(status);
  const title = user ? `${esc(user)}'s chores` : "House chores";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Chores">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#9d174d">
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  /* min-height, not height: the body has to be free to grow past the viewport
     once there are enough chores, or the page simply can't scroll. */
  html, body { min-height: 100%; }
  body {
    font: 16px -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
    display: flex; justify-content: center;
    /* Vertical centring is done with an auto margin on the card rather than
       align-items:center. Centring an overflowing flex item pushes its top
       edge above the scroll origin, so the first chores become unreachable —
       auto margins collapse to 0 instead of overflowing.
       (No backticks in here: the page is a template literal.) */
    align-items: flex-start;
    padding: max(16px, env(safe-area-inset-top)) 16px
             max(16px, env(safe-area-inset-bottom)) 16px;
    background: #0b0b0f;
  }
  .card {
    width: 100%; max-width: 420px; min-height: 60vh;
    margin: auto; /* centres when it fits, scrolls cleanly when it doesn't */
    border-radius: 28px; padding: 26px 24px;
    color: #fff; text-decoration: none;
    display: flex; flex-direction: column;
    box-shadow: 0 18px 50px rgba(0,0,0,.45);
    transition: background .4s ease;
    background: linear-gradient(135deg, #fb7185, #9d174d);
  }
  .card.done { background: linear-gradient(135deg, #34d399, #047857); }
  .card.err  { background: linear-gradient(135deg, #475569, #1e293b); }
  .head { display: flex; align-items: center; gap: 12px; }
  .badge {
    width: 46px; height: 46px; border-radius: 14px; flex: none;
    display: flex; align-items: center; justify-content: center;
    font-size: 24px; background: rgba(255,255,255,.18);
    backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  }
  .count { font-size: 30px; font-weight: 800; line-height: 1.1; }
  .who { font-size: 13px; opacity: .82; margin-top: 2px; }
  .streak { margin-top: 14px; font-size: 15px; font-weight: 700; display: none; }
  .streak.show { display: block; }
  .streak.big { font-size: 19px; }
  ul { list-style: none; margin: 22px 0 0; flex: 1; }
  li {
    display: flex; align-items: center;
    border-top: 1px solid rgba(255,255,255,.16);
  }
  li:last-child { border-bottom: 1px solid rgba(255,255,255,.16); }
  li .open {
    display: flex; align-items: center; gap: 11px; flex: 1; min-width: 0;
    padding: 14px 4px; font-size: 16px; color: #fff; text-decoration: none;
    -webkit-tap-highlight-color: rgba(255,255,255,.15);
  }
  li .open:active { background: rgba(255,255,255,.12); }
  li .open span.t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  li .dot { width: 9px; height: 9px; border-radius: 50%; background: rgba(255,255,255,.9); flex: none; }
  li .chev { margin-left: auto; opacity: .6; font-size: 18px; }
  #leisurewrap { margin-top: 22px; }
  .leisurebtn {
    width: 100%; padding: 14px; border-radius: 14px; font-size: 16px; font-weight: 600;
    border: 1px solid rgba(255,255,255,.35); background: rgba(255,255,255,.13);
    color: #fff; cursor: pointer; -webkit-appearance: none;
  }
  .leisurebtn:active { background: rgba(255,255,255,.28); }
  .leisurebtn:disabled { opacity: .6; }
  .leisuremsg { margin-top: 8px; font-size: 13px; opacity: .85; text-align: center; }
  li.taskrow { flex-wrap: wrap; }
  .steps-toggle {
    flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px;
    background: none; border: 0; padding: 0; margin: 0; text-align: left;
    color: inherit; font: inherit; cursor: pointer; -webkit-appearance: none;
  }
  .caret { margin-left: auto; opacity: .6; font-size: 13px; }
  .steps {
    flex-basis: 100%; margin: 8px 0 2px; padding: 10px 12px; border-radius: 12px;
    background: rgba(0,0,0,.18); font-size: 14px;
  }
  ul.steplist { list-style: none; margin: 0; padding: 0; }
  ul.steplist li { padding: 3px 0; opacity: .95; }
  ul.steplist li.sdone { opacity: .55; text-decoration: line-through; }
  .stepnote { margin: 4px 0; opacity: .8; }
  .steplink { display: inline-block; margin-top: 8px; font-size: 13px; opacity: .8; color: #fff; }
  li .claim {
    flex: none; margin-left: 8px; width: 34px; height: 34px; align-self: center;
    border-radius: 10px; border: 1px solid rgba(255,255,255,.3);
    background: rgba(255,255,255,.1); color: #fff; font-size: 15px; line-height: 1;
    cursor: pointer; -webkit-appearance: none;
  }
  li .claim:active { background: rgba(255,255,255,.3); }
  li .claim:disabled { opacity: .5; }
  li .done, li .cancel {
    flex: none; margin-left: 10px; width: 42px; height: 42px; border-radius: 12px;
    border: 1px solid rgba(255,255,255,.5); background: rgba(255,255,255,.16);
    color: #fff; font-size: 19px; line-height: 1; cursor: pointer; -webkit-appearance: none;
  }
  /* Cancel is deliberately quieter than done: it's the exception, and it
     shouldn't be the easy thumb-target next to a 42px primary action. */
  li .cancel {
    margin-left: 6px; width: 36px; height: 36px; align-self: center;
    border-color: rgba(255,255,255,.28); background: rgba(255,255,255,.07);
    font-size: 15px; opacity: .8;
  }
  li .done:active, li .cancel:active { background: rgba(255,255,255,.34); }
  li .done:disabled, li .cancel:disabled { opacity: .55; }
  li.completing .open { opacity: .5; text-decoration: line-through; }
  .empty { margin-top: 28px; font-size: 18px; opacity: .92; }
  .donehdr { margin: 22px 0 2px; font-size: 12px; letter-spacing: .04em;
    text-transform: uppercase; opacity: .75; }
  /* Secondary lists of ACTIVE work — the other person's chores, up-for-grabs,
     Anytime. Same compact layout as the done list, but emphatically NOT struck
     through: these are outstanding, and donelist's line-through made them read
     as already finished. */
  ul.sublist li { display: flex; align-items: center; }
  ul.sublist li a { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; }
  ul.donelist li a { opacity: .7; }
  ul.donelist li a .t { text-decoration: line-through; }
  ul.donelist li .check { color: #fff; opacity: .85; flex: none; }
  .foot { margin-top: 20px; font-size: 12px; opacity: .7; }
  .foot a { color: #fff; opacity: .85; }
</style>
</head>
<body>
<div class="card" id="card">
  <div class="head">
    <div class="badge" id="badge">📋</div>
    <div>
      <div class="count" id="count">…</div>
      <div class="who" id="who">${title}</div>
    </div>
  </div>
  <div class="streak" id="streak"></div>
  <ul id="list"></ul>
  <div id="unassignedwrap"></div>
  <div id="leisurewrap"></div>
  <div id="donewrap"></div>
  <div class="foot" id="foot"></div>
</div>
<script>
  const USER = ${JSON.stringify(user)};
  const LINEAR_URL = ${JSON.stringify(LINEAR_URL)};
  // Read the key from THIS page's URL (kept out of the served HTML / repo).
  // When present, each chore gets a "done" button; otherwise the page is read-only.
  const KEY = new URLSearchParams(location.search).get("key") || "";
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function fmtDue(ymd) {
    if (!ymd) return "";
    const [y,m,d] = ymd.split("-").map(Number);
    const WD = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const MO = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return WD[new Date(Date.UTC(y,m-1,d)).getUTCDay()] + " " + MO[m-1] + " " + d;
  }
  function render(s) {
    const card = document.getElementById("card");
    const badge = document.getElementById("badge");
    const count = document.getElementById("count");
    const list = document.getElementById("list");
    const foot = document.getElementById("foot");
    const who = document.getElementById("who");
    const donewrap = document.getElementById("donewrap");
    const streak = document.getElementById("streak");
    card.classList.remove("done", "err");
    if (!s || s.error) {
      card.classList.add("err"); badge.textContent = "❔";
      count.textContent = "Unavailable"; list.innerHTML = "";
      donewrap.innerHTML = ""; streak.className = "streak"; foot.textContent = "";
      const uwErr = document.getElementById("unassignedwrap"); if (uwErr) uwErr.innerHTML = "";
      return;
    }
    const n = s.streak || 0;
    streak.textContent = n > 0 ? "🔥 " + n + "-day streak" : "";
    streak.className = "streak" + (n > 0 ? " show" : "") + (s.done && n > 0 ? " big" : "");
    const tasks = s.tasks || [];
    if (s.done) {
      card.classList.add("done"); badge.textContent = "✅";
      count.textContent = "All done";
      list.innerHTML = '<div class="empty">Nice work — nothing left today. 🎉</div>';
      who.textContent = ${JSON.stringify(title)};
    } else {
      badge.textContent = "📋";
      count.textContent = s.remaining + (s.remaining === 1 ? " chore left" : " chores left");
      who.textContent = KEY ? "✓ done · ✖ not doing it · tap a chore to open" : "tap a chore to open it in Linear";
      list.innerHTML = tasks.map((t, idx) => {
        const t2 = esc(t.title);
        const href = esc(t.url || LINEAR_URL);
        // ✓ = did it, ✖ = decided not to. Separate buttons so the stats can
        // tell actual work from work that was dropped.
        const right = KEY
          ? '<button class="done" data-title="' + t2 + '" aria-label="Mark done">✓</button>' +
            '<button class="cancel" data-title="' + t2 + '" aria-label="Cancel — not doing this">✖</button>'
          : '';
        // Tapping the title expands the chore's own checklist in place, rather
        // than bouncing out to Linear to find out what "done" actually means.
        // The ↗ keeps the old behaviour available for anyone who wants the
        // full issue.
        const hasSteps = !!t.steps;
        const head = hasSteps
          ? '<button class="open steps-toggle" data-steps="' + idx + '" aria-expanded="false">' +
              '<span class="dot"></span><span class="t">' + t2 + '</span>' +
              '<span class="caret">▾</span></button>'
          : '<a class="open" href="' + href + '"><span class="dot"></span>' +
              '<span class="t">' + t2 + '</span>' +
              (KEY ? '' : '<span class="chev">›</span>') + '</a>';
        const body = hasSteps
          ? '<div class="steps" id="steps-' + idx + '" hidden>' + renderSteps(t.steps) +
              '<a class="steplink" href="' + href + '">open in Linear ↗</a></div>'
          : '';
        return '<li class="taskrow">' + head + right + body + '</li>';
      }).join("");
    }
    // Anything else going: the other person's outstanding chores, then
    // unclaimed work. Both get a 🙋 "take it" button when a key is present, so
    // you can pull something onto your own plate without leaving the page.
    const unassigned = s.unassignedSoon || [];
    const others = s.others || [];
    renderLeisure(s);
    const uw = document.getElementById("unassignedwrap");
    if (uw) {
      const grab = (t) => KEY
        ? '<button class="claim" data-title="' + esc(t.title) + '" aria-label="Take this chore">🙋</button>'
        : '';
      let html = "";
      for (const o of others) {
        html += '<div class="donehdr">' + esc(o.name) + " · " + o.tasks.length + ' left</div>' +
          '<ul class="sublist">' + o.tasks.map((t) =>
            '<li><a class="open" href="' + esc(t.url || LINEAR_URL) + '">' +
            '<span class="dot"></span><span class="t">' + esc(t.title) + '</span></a>' +
            grab(t) + '</li>'
          ).join("") + '</ul>';
      }
      // Undated work, oldest first — the only place it surfaces on the phone.
      const anytime = s.anytime || [];
      if (anytime.length) {
        html += '<div class="donehdr">🧺 Anytime · no due date</div>' +
          '<ul class="sublist">' + anytime.map((t) => {
            const meta = [t.project, t.assignee, t.ageDays != null ? t.ageDays + 'd old' : null]
              .filter(Boolean).join(' · ');
            return '<li><a class="open" href="' + esc(t.url || LINEAR_URL) + '">' +
              '<span class="dot"></span><span class="t">' + esc(t.title) + '</span>' +
              (meta ? '<span class="chev">' + esc(meta) + '</span>' : '') + '</a>' +
              grab(t) + '</li>';
          }).join("") + '</ul>';
      }
      if (unassigned.length) {
        html += '<div class="donehdr">🙋 Up for grabs · ' + unassigned.length + '</div>' +
          '<ul class="sublist">' + unassigned.map((t) =>
            '<li><a class="open" href="' + esc(t.url || LINEAR_URL) + '">' +
            '<span class="dot"></span><span class="t">' + esc(t.title) + '</span>' +
            '<span class="chev">' + esc(fmtDue(t.dueDate)) + '</span></a>' +
            grab(t) + '</li>'
          ).join("") + '</ul>';
      }
      uw.innerHTML = html;
    }

    // "Done today" section (tap an item to reopen it in Linear if mistaken).
    const completed = s.completed || [];
    if (completed.length) {
      donewrap.innerHTML = '<div class="donehdr">Done today · ' + completed.length + '</div>' +
        '<ul class="donelist">' + completed.map(t =>
          '<li><a class="open" href="' + esc(t.url || LINEAR_URL) + '">' +
          '<span class="check">✓</span><span class="t">' + esc(t.title) + '</span></a></li>'
        ).join("") + '</ul>';
    } else {
      donewrap.innerHTML = "";
    }
    const now = new Date();
    foot.innerHTML = 'updated ' + now.toLocaleTimeString([], {hour: "numeric", minute: "2-digit"}) +
      ' · <a href="' + esc(LINEAR_URL) + '">open in Linear</a>';
  }

  // Resolve a chore via the keyed endpoints (event-delegated on the list).
  // ✓ -> /done (work completed), ✖ -> /cancel (decided not to do it). Both
  // clear it off the list; only the first counts as work done.
  // 🙋 Take a chore that's someone else's or unassigned: reassigns it to the
  // user this widget is for, then refreshes so it moves into your own list.
  document.getElementById("unassignedwrap")?.addEventListener("click", async (e) => {
    const btn = e.target.closest(".claim");
    if (!btn) return;
    e.preventDefault();
    btn.disabled = true;
    try {
      const r = await fetch("/claim?match=" + encodeURIComponent(btn.dataset.title) +
        "&user=" + encodeURIComponent(USER) +
        "&key=" + encodeURIComponent(KEY), { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      await refresh();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "!";
      setTimeout(() => { btn.textContent = "🙋"; }, 1500);
    }
  });

  document.getElementById("list").addEventListener("click", async (e) => {
    const btn = e.target.closest(".done, .cancel");
    if (!btn) return;
    e.preventDefault();
    const isCancel = btn.classList.contains("cancel");
    const glyph = isCancel ? "✖" : "✓";
    const li = btn.closest("li");
    const siblings = li.querySelectorAll("button");
    siblings.forEach(b => { b.disabled = true; });
    li.classList.add("completing");
    try {
      const r = await fetch((isCancel ? "/cancel?match=" : "/done?match=") +
        encodeURIComponent(btn.dataset.title) +
        "&key=" + encodeURIComponent(KEY), { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      await refresh();
    } catch (err) {
      li.classList.remove("completing");
      siblings.forEach(b => { b.disabled = false; });
      btn.textContent = "!";
      setTimeout(() => { btn.textContent = glyph; }, 1500);
    }
  });

  // "Starting my own time" — logs today's leisure start and whether the day's
  // chores were already done. Only the FIRST press of the day is recorded, so
  // pressing again just reports what's on file. Needs a key and a named user:
  // the row is per person, and the keyless widget is read-only.
  function renderLeisure(s) {
    const wrap = document.getElementById("leisurewrap");
    if (!wrap || !KEY || !USER) return;
    if (wrap.dataset.done === "1") return; // already pressed this session
    wrap.innerHTML =
      '<button class="leisurebtn" id="leisurebtn">🎮 Starting my own time</button>' +
      '<div class="leisuremsg" id="leisuremsg"></div>';
    document.getElementById("leisurebtn").addEventListener("click", async () => {
      const btn = document.getElementById("leisurebtn");
      const msg = document.getElementById("leisuremsg");
      btn.disabled = true;
      msg.textContent = "logging…";
      try {
        const r = await fetch("/leisure?user=" + encodeURIComponent(USER) +
          "&key=" + encodeURIComponent(KEY), { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const d = await r.json();
        wrap.dataset.done = "1";
        const h = d.history || {};
        const tail = h.total
          ? " · " + h.clear + "/" + h.total + " days clear" + (h.streak ? " · 🔥" + h.streak : "")
          : "";
        if (!d.created) {
          const e = d.existing || {};
          btn.textContent = "🎮 Already logged" + (e.time ? " at " + e.time : "");
          msg.textContent = (e.clear ? "chores were clear ✅" : "chores were pending ⚠️") +
            " — only the first start of the day counts" + tail;
        } else if (d.clear) {
          btn.textContent = "✅ Logged — chores clear";
          msg.textContent = d.doneToday + " done today" +
            (d.overdue ? " · " + d.overdue + " older item(s) past due, not counted" : "") + tail;
        } else {
          btn.textContent = "⚠️ Logged — " + d.dueToday.length + " still due";
          msg.textContent = d.dueToday.slice(0, 3).join(" · ") + tail;
        }
      } catch (err) {
        btn.disabled = false;
        msg.textContent = "couldn't log that — try again";
      }
    });
  }


  // Render a chore's own description as a compact checklist. Markdown checkbox
  // lines become bullets; everything else is kept as plain text so notes and
  // instructions survive. Escaped throughout — this is issue content.
  function renderSteps(raw) {
    // NOTE: this whole page is a JS template literal, so any backslash meant
    // for the browser must be written DOUBLED here. Written singly, the escape
    // is consumed when the page is built and the served regex ends up
    // unterminated — which takes the entire script, and so the whole page,
    // down. (Mind this in comments too, not just code.)
    const lines = String(raw).split(/\\r?\\n/).map(l => l.trim()).filter(Boolean);
    let out = "";
    let open = false;
    for (const line of lines) {
      const box = line.match(/^[-*]\\s*\\[( |x|X)\\]\\s*(.+)$/);
      const bullet = line.match(/^[-*]\\s+(.+)$/);
      if (box || bullet) {
        if (!open) { out += '<ul class="steplist">'; open = true; }
        const done = box && box[1].toLowerCase() === "x";
        const text = esc(box ? box[2] : bullet[1]);
        out += '<li' + (done ? ' class="sdone"' : '') + '>' + (done ? "☑" : "☐") + " " + text + "</li>";
      } else {
        if (open) { out += "</ul>"; open = false; }
        out += '<p class="stepnote">' + esc(line) + "</p>";
      }
    }
    if (open) out += "</ul>";
    return out || '<p class="stepnote">No checklist on this one.</p>';
  }

  // Expand/collapse a chore's checklist. Event-delegated so it survives the
  // list being re-rendered on every refresh.
  document.getElementById("list").addEventListener("click", (e) => {
    const btn = e.target.closest(".steps-toggle");
    if (!btn) return;
    e.preventDefault();
    const panel = document.getElementById("steps-" + btn.dataset.steps);
    if (!panel) return;
    const nowOpen = panel.hidden;
    panel.hidden = !nowOpen;
    btn.setAttribute("aria-expanded", String(nowOpen));
    const caret = btn.querySelector(".caret");
    if (caret) caret.textContent = nowOpen ? "▴" : "▾";
  });

  async function refresh() {
    try {
      const r = await fetch("/status" + (USER ? "?user=" + encodeURIComponent(USER) : ""), {cache: "no-store"});
      render(await r.json());
    } catch (e) { /* keep last good render */ }
  }
  render(${data});             // instant first paint from server data
  refresh();                   // then confirm fresh
  setInterval(refresh, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
</script>
</body>
</html>`;
}
