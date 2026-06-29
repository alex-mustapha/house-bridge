// Mobile-friendly chore-stats dashboard served at /dashboard. Server-renders the
// page with live data inlined; Chart.js (CDN) draws the charts client-side.

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

const RANGE_LABEL = { 7: "7 days", 30: "30 days", 90: "90 days", 365: "1 year" };

export function renderDashboardPage(data, range = 30) {
  const streaks =
    Object.entries(data.streaks || {})
      .map(([n, s]) => `${esc(n)} ${s}`)
      .join(" · ") || "—";
  const rlabel = RANGE_LABEL[range] || `${range} days`;
  const rangeBar = [[7, "7d"], [30, "30d"], [90, "90d"], [365, "1y"]]
    .map(([d, l]) => `<a class="rg${d === range ? " on" : ""}" href="/dashboard?range=${d}">${l}</a>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Chore stats">
<meta name="theme-color" content="#0b0b0f">
<title>Chore stats</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font: 16px -apple-system, system-ui, "Segoe UI", Roboto, sans-serif; background: #0b0b0f; color: #e8e8ea;
    padding: max(16px, env(safe-area-inset-top)) 14px 28px; }
  .wrap { max-width: 560px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
  h1 { font-size: 20px; font-weight: 700; margin: 4px 2px 0; }
  .cards { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
  .card { background: #17171c; border-radius: 14px; padding: 14px; }
  .card .lbl { font-size: 12px; color: #9a9aa2; }
  .card .val { font-size: 26px; font-weight: 700; margin-top: 3px; }
  .card .val.sm { font-size: 16px; font-weight: 600; }
  .panel { background: #17171c; border-radius: 16px; padding: 14px 16px; }
  .panel h2 { font-size: 14px; font-weight: 600; color: #c9c9cf; margin-bottom: 10px; }
  .rangebar { display: flex; gap: 8px; }
  .rangebar .rg { flex: 1; text-align: center; padding: 9px 0; border-radius: 10px; text-decoration: none;
    color: #c9c9cf; background: #17171c; font-size: 14px; font-weight: 600; }
  .rangebar .rg.on { background: #3b9eff; color: #04244a; }
  .cw { position: relative; height: 220px; }
  ul.missed { list-style: none; }
  ul.missed li { display: flex; justify-content: space-between; padding: 9px 0; font-size: 14px;
    border-top: 1px solid rgba(255,255,255,.08); }
  ul.missed li:first-child { border-top: none; }
  ul.missed .n { color: #9a9aa2; }
  .empty { color: #9a9aa2; font-size: 14px; }
  .foot { color: #6f6f77; font-size: 12px; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
  <h1>🧹 Chore stats</h1>
  <div class="rangebar">${rangeBar}</div>
  <div class="cards">
    <div class="card"><div class="lbl">Completion (${rlabel})</div><div class="val">${data.summary.completionPct}%</div></div>
    <div class="card"><div class="lbl">On time</div><div class="val">${data.summary.onTimePct}%</div></div>
    <div class="card"><div class="lbl">Done (${rlabel})</div><div class="val">${data.summary.done}</div></div>
    <div class="card"><div class="lbl">🔥 Streaks (current)</div><div class="val sm">${streaks}</div></div>
  </div>
  <div class="panel"><h2>Per person — ${rlabel}</h2><div class="cw"><canvas id="byperson"></canvas></div></div>
  <div class="panel"><h2>Completion rate trend</h2><div class="cw"><canvas id="trend"></canvas></div></div>
  <div class="panel"><h2>Effort split — ${rlabel}</h2><div class="cw" style="height:200px"><canvas id="effort"></canvas></div></div>
  <div class="panel"><h2>Most missed — ${rlabel}</h2><ul class="missed" id="missed"></ul></div>
  <div class="foot" id="foot"></div>
</div>
<script>const DATA = ${JSON.stringify(data)};</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<script>
  const teal="#1db981", amber="#f5a524", coral="#f5683b", blue="#3b9eff", purple="#8b80ff";
  Chart.defaults.color = "#9a9aa2";
  Chart.defaults.font.family = "-apple-system, system-ui, sans-serif";
  const grid = "rgba(255,255,255,0.08)";

  const bp = DATA.byPerson || [];
  new Chart(document.getElementById("byperson"), {
    type: "bar",
    data: { labels: bp.map(p => p.name), datasets: [
      { label: "On time", data: bp.map(p => p.onTime), backgroundColor: teal },
      { label: "Late", data: bp.map(p => p.late), backgroundColor: amber },
      { label: "Missed", data: bp.map(p => p.missed), backgroundColor: coral } ] },
    options: { responsive:true, maintainAspectRatio:false,
      scales:{ x:{ stacked:true, grid:{display:false} }, y:{ stacked:true, grid:{color:grid}, ticks:{precision:0} } },
      plugins:{ legend:{ position:"bottom" } } }
  });

  const tr = DATA.trend || [];
  new Chart(document.getElementById("trend"), {
    type: "line",
    data: { labels: tr.map(t => t.label), datasets: [
      { label:"Completion %", data: tr.map(t => t.pct), borderColor: blue,
        backgroundColor:"rgba(59,158,255,0.14)", fill:true, tension:0.3, spanGaps:true, pointRadius:3 } ] },
    options: { responsive:true, maintainAspectRatio:false,
      scales:{ y:{ min:0, max:100, grid:{color:grid}, ticks:{ callback:v=>v+"%" } }, x:{ grid:{display:false} } },
      plugins:{ legend:{ display:false } } }
  });

  const ef = DATA.effort || [];
  if (ef.length) {
    new Chart(document.getElementById("effort"), {
      type: "doughnut",
      data: { labels: ef.map(e => e.name + " " + e.minutes + "m"), datasets: [
        { data: ef.map(e => e.minutes), backgroundColor:[blue, purple, teal, amber], borderWidth:0 } ] },
      options: { responsive:true, maintainAspectRatio:false, cutout:"62%", plugins:{ legend:{ position:"bottom" } } }
    });
  } else {
    document.getElementById("effort").parentElement.innerHTML = '<p class="empty">No completed chores yet this week.</p>';
  }

  const ml = document.getElementById("missed");
  ml.innerHTML = (DATA.missed && DATA.missed.length)
    ? DATA.missed.map(m => '<li><span>' + m.title.replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])) + '</span><span class="n">' + m.n + ' missed</span></li>').join("")
    : '<li class="empty">Nothing missed 🎉</li>';

  document.getElementById("foot").textContent = "updated " + new Date().toLocaleString([], {month:"short", day:"numeric", hour:"numeric", minute:"2-digit"});
</script>
</body>
</html>`;
}
