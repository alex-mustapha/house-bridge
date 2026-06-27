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
    display: flex; align-items: center; gap: 11px;
    padding: 13px 4px; font-size: 16px;
    border-top: 1px solid rgba(255,255,255,.16);
  }
  li:last-child { border-bottom: 1px solid rgba(255,255,255,.16); }
  li .dot { width: 9px; height: 9px; border-radius: 50%; background: rgba(255,255,255,.9); flex: none; }
  .empty { margin-top: 28px; font-size: 18px; opacity: .92; }
  .foot { margin-top: 20px; font-size: 12px; opacity: .7; }
</style>
</head>
<body>
<a class="card" id="card" href="${LINEAR_URL}">
  <div class="head">
    <div class="badge" id="badge">📋</div>
    <div>
      <div class="count" id="count">…</div>
      <div class="who">${title} · tap to open Linear</div>
    </div>
  </div>
  <ul id="list"></ul>
  <div class="foot" id="foot"></div>
</a>
<script>
  const USER = ${JSON.stringify(user)};
  function render(s) {
    const card = document.getElementById("card");
    const badge = document.getElementById("badge");
    const count = document.getElementById("count");
    const list = document.getElementById("list");
    const foot = document.getElementById("foot");
    card.classList.remove("done", "err");
    if (!s || s.error) {
      card.classList.add("err"); badge.textContent = "❔";
      count.textContent = "Unavailable"; list.innerHTML = "";
      foot.textContent = ""; return;
    }
    const tasks = s.tasks || [];
    if (s.done) {
      card.classList.add("done"); badge.textContent = "✅";
      count.textContent = "All done";
      list.innerHTML = '<div class="empty">Nice work — nothing left today. 🎉</div>';
    } else {
      badge.textContent = "📋";
      count.textContent = s.remaining + (s.remaining === 1 ? " chore left" : " chores left");
      list.innerHTML = tasks.map(t =>
        '<li><span class="dot"></span><span>' + t.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])) + '</span></li>'
      ).join("");
    }
    const now = new Date();
    foot.textContent = "updated " + now.toLocaleTimeString([], {hour: "numeric", minute: "2-digit"});
  }
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
