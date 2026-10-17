// Turns computed insights into the monthly Discord post.
//
// Two renderers, same input. `renderPlain` is a template over the computed
// findings and always works. `writeWithClaude` asks a model to rephrase those
// same findings into something readable.
//
// The division of labour is deliberate and worth keeping: EVERY number and
// every recommendation comes from src/insights.js. The model is handed finished
// findings and asked to present them — it is never given raw data to draw
// conclusions from, and it is never the source of a figure. A monthly post with
// confident, slightly-wrong numbers is worse than no post at all, because you
// stop trusting the whole thing the first time you catch one.
//
// If ANTHROPIC_API_KEY is absent, or the call fails for any reason, the plain
// render goes out instead. The feature degrades to "less pretty", never to
// "silently missing".

// The problem and the fix belong to the CATEGORY, not to each chore. Stating
// them per line meant the same two sentences repeated three times over, which
// buried the one thing that differed: which chore, and by how much.
const KINDS = {
  "never-done": {
    label: "Never completed",
    advice:
      "Not once, across every occurrence. If these matter, something about them has to " +
      "change; if they do not, delete the template so it stops generating.",
  },
  "wrong-weekday": {
    label: "Scheduled on the wrong day",
    advice:
      "These are consistently finished later than their due date, on the same day each " +
      "time. Move each one to the day it actually gets done and the lateness disappears " +
      "without anyone changing what they do.",
  },
  "possibly-unlogged": {
    label: "Probably happening, just not logged",
    advice:
      "Punctual whenever they are recorded, but absent often. That pattern usually means " +
      "the work happened and the chore was never ticked. Worth confirming before changing " +
      "any schedule.",
  },
  "chronically-missed": {
    label: "Repeatedly missed",
    advice:
      "Not cancelled, just not done. Each is either harder than its estimate, lands at a " +
      "bad time, or wants splitting into smaller pieces.",
  },
  "too-frequent": {
    label: "Comes round too often",
    advice:
      "Cancelling is a deliberate “not this time”, so this often means they arrive more " +
      "frequently than they need to. Consider a longer cadence.",
  },
  "unclear-checklist": {
    label: "Checklist may be incomplete",
    advice:
      "Flagged as done-but-a-detail-was-missed more than once. Repeat flags on one chore " +
      "usually mean the checklist is missing a step, rather than that someone keeps being " +
      "careless.",
  },
  "load-drift": {
    label: "Effort split",
    advice:
      "Rotation is per-chore alternation, so a gap this size usually comes from who picks " +
      "up the extras rather than from the rotation itself.",
  },
};

// Order groups the way the findings are already ordered: most actionable first.
const groupFindings = (findings) => {
  const groups = [];
  const byKind = new Map();
  for (const f of findings) {
    if (!byKind.has(f.kind)) {
      const g = { kind: f.kind, items: [] };
      byKind.set(f.kind, g);
      groups.push(g);
    }
    byKind.get(f.kind).items.push(f);
  }
  return groups;
};

const fmtWindow = (d) =>
  `${d.since} to ${d.until} (${d.allTime ? "all time" : `${d.windowDays} days`})`;

export function renderPlain(data) {
  const s = data.summary;
  const lines = [];
  lines.push(`**Window:** ${fmtWindow(data)} · ${s.total} resolved chores`);
  lines.push(
    `**On time:** ${s.onTimePct === null ? "—" : `${s.onTimePct}%`} · ` +
      `${s.onTime} on time · ${s.late} late · ${s.missed} missed · ${s.canceled} cancelled`,
  );
  if (data.split?.length) {
    lines.push(
      `**Effort:** ` +
        data.split
          .map((p) => `${p.name} ${p.share}%${p.target != null ? ` (target ${p.target}%)` : ""}`)
          .join(" · "),
    );
  }
  lines.push("");

  if (!data.findings.length) {
    lines.push("Nothing stands out this month — no chore crossed a threshold worth acting on.");
    return lines.join("\n");
  }

  const groups = groupFindings(data.findings);
  const n = data.findings.length;
  lines.push(`**${n} thing${n === 1 ? "" : "s"} worth a look**`);

  for (const g of groups) {
    const meta = KINDS[g.kind] || { label: g.kind, advice: "" };
    lines.push("");
    lines.push(`**${meta.label}** (${g.items.length})`);
    if (meta.advice) lines.push(`*${meta.advice}*`);
    for (const f of g.items) {
      // `detail` is facts only — the advice was already stated for the group.
      // Older findings without one fall back to the standalone sentence.
      lines.push(`• ${f.detail || f.recommendation}`);
    }
  }
  return lines.join("\n");
}

// The model gets the findings as data and a hard instruction not to invent
// anything. Temperature stays low: this is a rewrite task, not a creative one.
const SYSTEM = [
  "You write a short monthly chore-review note for a two-person household (Alex and Kristal).",
  "",
  "You are given findings that have ALREADY been computed from their chore log.",
  "Rules, in order of importance:",
  "1. Never invent, estimate, or recompute a number. Use only the figures given.",
  "   If a figure is not in the input, do not mention it.",
  "2. Never add a recommendation that is not in the input. You may reword and group",
  "   the given ones, and you may point out when several share a cause.",
  "3. Do not moralise, praise, or scold. These are two adults reviewing a schedule,",
  "   not students being graded. Say what the data shows and what to change.",
  "4. GROUP the findings by category. State the problem and the fix once per",
  "   category, then list the chores under it with only what differs (which chore,",
  "   which day, how many times). Do not repeat the same advice on every line.",
  "5. Be concise: a short opening line on where things stand, then the grouped",
  "   findings. Under 250 words total.",
  "6. Discord markdown only: ** for bold, * for italics, • for bullets. No headings,",
  "   no tables, no code blocks.",
].join("\n");

export async function writeWithClaude(env, data) {
  if (!env.ANTHROPIC_API_KEY) return null;
  const model = env.INSIGHTS_MODEL || "claude-sonnet-5-5";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 900,
        temperature: 0.2,
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content:
              "Here are this month's computed findings as JSON. Write the note.\n\n" +
              JSON.stringify(
                {
                  window: { since: data.since, until: data.until, days: data.windowDays },
                  summary: data.summary,
                  effortSplit: data.split,
                  // Pre-grouped, so the model is not asked to work out the
                  // categories itself — and so it cannot invent one.
                  findingsByCategory: groupFindings(data.findings).map((g) => ({
                    category: KINDS[g.kind]?.label || g.kind,
                    sharedAdvice: KINDS[g.kind]?.advice || "",
                    chores: g.items.map((f) => ({
                      chore: f.title,
                      facts: f.facts,
                      computedDetail: f.detail || null,
                      computedRecommendation: f.recommendation,
                    })),
                  })),
                },
                null,
                1,
              ),
          },
        ],
      }),
    });
    if (!res.ok) {
      console.error("Claude insights call failed:", res.status, (await res.text()).slice(0, 300));
      return null;
    }
    const body = await res.json();
    const text = (body.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    return text || null;
  } catch (e) {
    console.error("Claude insights call threw:", e.message);
    return null;
  }
}

// The embed. `source` records which renderer produced the body, so a post that
// reads oddly can be traced without guessing.
export async function buildInsightsPost(env, data) {
  const prose = await writeWithClaude(env, data);
  const body = prose || renderPlain(data);
  const source = prose ? "claude" : "computed";
  const footerBits = [
    `${data.findings.length} finding${data.findings.length === 1 ? "" : "s"}`,
    `${data.titlesConsidered} chores considered`,
    `${fmtWindow(data)}`,
  ];
  if (source === "claude") footerBits.push("wording by Claude, figures computed");
  return {
    source,
    message: {
      embeds: [
        {
          title: "🔎 Monthly chore review",
          description: body.slice(0, 4000),
          color: 0x5865f2,
          timestamp: new Date().toISOString(),
          footer: { text: footerBits.join(" · ") },
        },
      ],
    },
  };
}
