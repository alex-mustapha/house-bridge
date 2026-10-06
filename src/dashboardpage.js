// Mobile-friendly chore-stats dashboard served at /dashboard. Server-renders the
// page with live data inlined; Chart.js (CDN) draws the charts client-side.

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

const RANGE_LABEL = { 7: "7 days", 30: "30 days", 90: "90 days", 365: "1 year" };

// `leisure` is only ever passed when the page was requested for one named
// person (/dashboard?user=…). The shared link pinned in Discord never carries
// it, so this panel stays off the household view.
export function renderDashboardPage(data, range = 30, leisure = null) {
  const streaks =
    Object.entries(data.streaks || {})
      .map(([n, s]) => `${esc(n)} ${s}`)
      .join(" · ") || "—";
  const rlabel = RANGE_LABEL[range] || `${range} days`;
  const qUser = leisure ? `&user=${encodeURIComponent(leisure.person)}` : "";
  const rangeBar = [[7, "7d"], [30, "30d"], [90, "90d"], [365, "1y"]]
    .map(([d, l]) => `<a class="rg${d === range ? " on" : ""}" href="/dashboard?range=${d}${qUser}">${l}</a>`)
    .join("");
  const leisurePanel = leisure
    ? `
  <div class="panel"><h2>🎮 Chores before leisure — ${esc(leisure.person)} · last ${leisure.days}d</h2>
    <div class="cards" style="margin-bottom:12px">
      <div class="card"><div class="lbl">Clear slate</div><div class="val">${
        leisure.clearPct === null ? "—" : leisure.clearPct + "%"
      }</div></div>
      <div class="card"><div class="lbl">🔥 In a row</div><div class="val">${leisure.streak}</div></div>
    </div>
    <div class="cw" style="height:170px"><canvas id="leisure"></canvas></div>
    <ul class="missed" id="leisurelist"></ul>
    <p class="empty" style="margin-top:8px">${leisure.clear} of ${leisure.total} sessions started with today's chores done. Private to you.</p>
  </div>`
    : "";
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
  <div class="panel"><h2>Completion trend — per person</h2><div class="cw"><canvas id="trend"></canvas></div></div>
  <div class="panel"><h2>How late — ${rlabel}</h2>
    <div class="cw" style="height:190px"><canvas id="lateness"></canvas></div>
    <ul class="missed" id="lateby"></ul></div>${leisurePanel}
  <div class="panel"><h2>Effort split — ${rlabel}</h2><div class="cw" style="height:200px"><canvas id="effort"></canvas></div></div>
  <div class="panel"><h2>Most missed — ${rlabel}</h2><ul class="missed" id="missed"></ul></div>
  <div class="foot" id="foot"></div>
</div>
<script>const DATA = ${JSON.stringify(data)};${
  leisure ? `\nconst DATA_LEISURE = ${JSON.stringify(leisure)};` : ""
}</script>
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

  // One line per person, so an individual's improvement is visible on its own
  // line instead of being averaged away. Household stays as a faint dashed
  // reference behind them.
  const PERSON_COLORS = [blue, purple, teal, amber, coral];
  const tbp = DATA.trendByPerson || [];
  const tlabels = DATA.trendLabels || (DATA.trend || []).map(t => t.label);
  const trendSets = tbp.map((p, i) => ({
    label: p.name, data: p.points, borderColor: PERSON_COLORS[i % PERSON_COLORS.length],
    backgroundColor: PERSON_COLORS[i % PERSON_COLORS.length], fill: false,
    tension: 0.3, spanGaps: true, pointRadius: 3, borderWidth: 2
  }));
  if (trendSets.length > 1) trendSets.push({
    label: "Household", data: (DATA.trend || []).map(t => t.pct), borderColor: "rgba(255,255,255,0.28)",
    backgroundColor: "transparent", borderDash: [5, 4], fill: false, tension: 0.3,
    spanGaps: true, pointRadius: 0, borderWidth: 1.5
  });
  new Chart(document.getElementById("trend"), {
    type: "line",
    data: { labels: tlabels, datasets: trendSets },
    options: { responsive:true, maintainAspectRatio:false,
      scales:{ y:{ min:0, max:100, grid:{color:grid}, ticks:{ callback:v=>v+"%" } }, x:{ grid:{display:false} } },
      plugins:{ legend:{ position:"bottom" },
        tooltip:{ callbacks:{ label: c => c.dataset.label + ": " + (c.raw === null ? "no chores due" : c.raw + "%") } } } }
  });

  // How late, not just late — one day and two weeks are different outcomes.
  const lt = (DATA.lateness && DATA.lateness.buckets) || [];
  if (lt.some(b => b.n)) {
    new Chart(document.getElementById("lateness"), {
      type: "bar",
      data: { labels: lt.map(b => b.label), datasets: [
        { data: lt.map(b => b.n),
          backgroundColor: [teal, "#b9cf4a", amber, coral, "#d6453b", "#6b6b74"], borderWidth: 0 } ] },
      options: { responsive:true, maintainAspectRatio:false,
        scales:{ y:{ grid:{color:grid}, ticks:{precision:0} }, x:{ grid:{display:false} } },
        plugins:{ legend:{ display:false },
          tooltip:{ callbacks:{ label: c => c.raw + " chore" + (c.raw === 1 ? "" : "s") } } } }
    });
  } else {
    document.getElementById("lateness").parentElement.innerHTML = '<p class="empty">Nothing resolved yet in this range.</p>';
  }

  const lby = document.getElementById("lateby");
  const lp = (DATA.lateness && DATA.lateness.byPerson) || [];
  const L = DATA.lateness || {};
  const head = L.avgDaysLate === null || L.avgDaysLate === undefined
    ? '' : '<li><span>Average when late</span><span class="n">' + L.avgDaysLate + ' days (worst ' + L.worstDaysLate + ')</span></li>';
  lby.innerHTML = head + lp.map(p =>
    '<li><span>' + p.name.replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])) + '</span><span class="n">' +
    (p.avgDaysLate === null ? 'never late' : p.avgDaysLate + 'd avg · worst ' + p.worstDaysLate + 'd') +
    (p.missed ? ' · ' + p.missed + ' never done' : '') + '</span></li>').join("");

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

${leisure ? `
  // Only emitted for a per-person view — the shared page carries no trace of it.
  {
    const LZ = DATA_LEISURE;
    new Chart(document.getElementById("leisure"), {
      type: "line",
      data: { labels: LZ.labels, datasets: [
        { label:"Clear slate %", data: LZ.points, borderColor: teal,
          backgroundColor:"rgba(29,185,129,0.14)", fill:true, tension:0.3, spanGaps:true, pointRadius:3 } ] },
      options: { responsive:true, maintainAspectRatio:false,
        scales:{ y:{ min:0, max:100, grid:{color:grid}, ticks:{ callback:v=>v+"%" } }, x:{ grid:{display:false} } },
        plugins:{ legend:{ display:false },
          tooltip:{ callbacks:{ label: c => c.raw === null ? "no sessions logged" : c.raw + "% clear" } } } }
    });
    document.getElementById("leisurelist").innerHTML = (LZ.recent || []).map(r =>
      '<li><span>' + r.date + (r.time ? ' ' + r.time : '') + '</span><span class="n">' +
      (r.clear ? '✅ clear' : '⚠️ ' + (r.total - r.done) + ' left') + '</span></li>').join("")
      || '<li class="empty">No sessions logged yet — run /chores leisure.</li>';
  }` : ""}

  document.getElementById("foot").textContent = "updated " + new Date().toLocaleString([], {month:"short", day:"numeric", hour:"numeric", minute:"2-digit"});
</script>
</body>
</html>`;
}
