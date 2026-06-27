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
<meta name="theme-color" content="#9d174d">
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font: 16px -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
    display: flex; align-items: center; justify-content: center;
    padding: max(16px, env(safe-area-inset-top)) 16px;
    background: #0b0b0f;
  }
  .card {
    width: 100%; max-width: 420px; min-height: 60vh;
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
  li .done {
    flex: none; margin-left: 10px; width: 42px; height: 42px; border-radius: 12px;
    border: 1px solid rgba(255,255,255,.5); background: rgba(255,255,255,.16);
    color: #fff; font-size: 19px; line-height: 1; cursor: pointer; -webkit-appearance: none;
  }
  li .done:active { background: rgba(255,255,255,.34); }
  li .done:disabled { opacity: .55; }
  li.completing .open { opacity: .5; text-decoration: line-through; }
  .empty { margin-top: 28px; font-size: 18px; opacity: .92; }
  .donehdr { margin: 22px 0 2px; font-size: 12px; letter-spacing: .04em;
    text-transform: uppercase; opacity: .75; }
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
  <ul id="list"></ul>
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
  function render(s) {
    const card = document.getElementById("card");
    const badge = document.getElementById("badge");
    const count = document.getElementById("count");
    const list = document.getElementById("list");
    const foot = document.getElementById("foot");
    const who = document.getElementById("who");
    const donewrap = document.getElementById("donewrap");
    card.classList.remove("done", "err");
    if (!s || s.error) {
      card.classList.add("err"); badge.textContent = "❔";
      count.textContent = "Unavailable"; list.innerHTML = "";
      donewrap.innerHTML = ""; foot.textContent = ""; return;
    }
    const tasks = s.tasks || [];
    if (s.done) {
      card.classList.add("done"); badge.textContent = "✅";
      count.textContent = "All done";
      list.innerHTML = '<div class="empty">Nice work — nothing left today. 🎉</div>';
      who.textContent = ${JSON.stringify(title)};
    } else {
      badge.textContent = "📋";
      count.textContent = s.remaining + (s.remaining === 1 ? " chore left" : " chores left");
      who.textContent = KEY ? "tap ✓ to mark done · tap a chore to open it" : "tap a chore to open it in Linear";
      list.innerHTML = tasks.map(t => {
        const t2 = esc(t.title);
        const href = esc(t.url || LINEAR_URL);
        const right = KEY
          ? '<button class="done" data-title="' + t2 + '" aria-label="Mark done">✓</button>'
          : '';
        return '<li><a class="open" href="' + href + '"><span class="dot"></span>' +
          '<span class="t">' + t2 + '</span>' + (KEY ? '' : '<span class="chev">›</span>') +
          '</a>' + right + '</li>';
      }).join("");
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

  // Mark a chore done via the keyed /done endpoint (event-delegated on the list).
  document.getElementById("list").addEventListener("click", async (e) => {
    const btn = e.target.closest(".done");
    if (!btn) return;
    e.preventDefault();
    btn.disabled = true;
    const li = btn.closest("li");
    li.classList.add("completing");
    try {
      const r = await fetch("/done?match=" + encodeURIComponent(btn.dataset.title) +
        "&key=" + encodeURIComponent(KEY), { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      await refresh();
    } catch (err) {
      li.classList.remove("completing");
      btn.disabled = false;
      btn.textContent = "!";
      setTimeout(() => { btn.textContent = "✓"; }, 1500);
    }
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
