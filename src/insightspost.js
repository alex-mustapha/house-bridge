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

const KIND_LABEL = {
  "never-done": "Never completed",
  "wrong-weekday": "Scheduled on the wrong day",
  "possibly-unlogged": "Probably happening, not being logged",
  "chronically-missed": "Repeatedly missed",
  "too-frequent": "Comes round too often",
  "unclear-checklist": "Checklist may be incomplete",
  "load-drift": "Effort split",
};

const fmtWindow = (d) => `${d.since} to ${d.until} (${d.windowDays} days)`;

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

  lines.push(`**${data.findings.length} thing${data.findings.length === 1 ? "" : "s"} worth a look**`);
  for (const f of data.findings) {
    lines.push(`• *${KIND_LABEL[f.kind] || f.kind}* — ${f.recommendation}`);
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
  "4. Be concise: a short opening line on where things stand, then the findings as",
  "   a brief bulleted list. Under 250 words total.",
  "5. Discord markdown only: ** for bold, * for italics, • for bullets. No headings,",
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
                  findings: data.findings.map((f) => ({
                    kind: f.kind,
                    chore: f.title,
                    facts: f.facts,
                    computedRecommendation: f.recommendation,
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
