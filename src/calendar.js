// Builds an iCalendar (ICS) feed of chores for calendar-app subscriptions.
// Read-only: each person subscribes to their feed by URL and their calendar
// app polls it. We emit one all-day VEVENT per active, dated chore — no RRULE,
// since the Worker already materializes each week's instances as Linear issues
// (so rotation, pauses, and skips are reflected automatically).

// Escape a TEXT value per RFC 5545 (backslash, comma, semicolon, newlines).
function esc(s) {
  return String(s || "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// Fold a content line to <=75 octets with CRLF + leading space, per RFC 5545.
function fold(line) {
  if (line.length <= 75) return line;
  const out = [];
  let i = 0;
  while (i < line.length) {
    out.push((i === 0 ? "" : " ") + line.slice(i, i + (i === 0 ? 75 : 74)));
    i += i === 0 ? 75 : 74;
  }
  return out.join("\r\n");
}

// "2026-07-04" -> "20260704" (all-day DATE value).
const ymdToDate = (ymd) => ymd.replace(/-/g, "");

// "2026-07-04" + n days -> "YYYYMMDD" (for the exclusive all-day DTEND).
function ymdPlus(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10).replace(/-/g, "");
}

// Strip Linear's markdown checklist syntax down to a plain bulleted list so it
// reads cleanly in a calendar event body.
function plainBody(desc) {
  return (desc || "")
    .replace(/^\s*-\s*\[[ xX]\]\s*/gm, "• ")
    .replace(/^\s*-\s+/gm, "• ")
    .trim();
}

// chores: [{ identifier, title, dueDate, url, description, assignee? }]
export function buildICS(calName, chores) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//linear-discord-bridge//chores//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(calName)}`,
    "X-WR-TIMEZONE:America/New_York",
    // Hint apps to re-poll hourly (Apple honors this; Google ignores it).
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];

  for (const c of chores) {
    const body = [
      c.assignee?.name ? `Assignee: ${c.assignee.name}` : "Unassigned — claim it with /chores claim",
      plainBody(c.description),
      c.url ? `Open in Linear: ${c.url}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    lines.push(
      "BEGIN:VEVENT",
      `UID:${c.identifier}@chores.linear-discord-bridge`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${ymdToDate(c.dueDate)}`,
      `DTEND;VALUE=DATE:${ymdPlus(c.dueDate, 1)}`,
      `SUMMARY:${esc(c.title)}`,
      `DESCRIPTION:${esc(body)}`,
    );
    if (c.url) lines.push(`URL:${esc(c.url)}`);
    // A single day-of reminder at 9am (relative to the midnight all-day start).
    lines.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${esc(c.title)}`,
      "TRIGGER;RELATED=START:PT9H",
      "END:VALARM",
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
