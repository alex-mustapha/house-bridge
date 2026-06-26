// Discord slash-command (HTTP interactions) support: Ed25519 request
// verification and the /tasks command, which lists a user's active Linear
// issues. Discord POSTs to the Worker's /interactions endpoint.

import { getUsers, fetchAssignedActiveIssues } from "./linear.js";
import { localDate } from "./recurring.js";

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-06-27" -> "🟠 Sat Jun 27" (weekday + date, with overdue/today marker).
function formatDue(ymd, today) {
  const [y, m, d] = ymd.split("-").map(Number);
  const wd = WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const mark = ymd < today ? "🔴 " : ymd === today ? "🟠 " : "";
  return `${mark}${wd} ${MON[m - 1]} ${d}`;
}

const EPHEMERAL = 64; // interaction response flag: only the caller sees it

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

// Import the app's Ed25519 public key, tolerating both algorithm names the
// Cloudflare runtime has used ("Ed25519" and legacy "NODE-ED25519").
async function importEdKey(raw) {
  try {
    return await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "NODE-ED25519", namedCurve: "NODE-ED25519" },
      false,
      ["verify"],
    );
  }
}

// Discord signs each request; verify it with the app's public key (hex).
export async function verifyDiscordSignature(publicKeyHex, signature, timestamp, body) {
  if (!publicKeyHex || !signature || !timestamp) return false;
  try {
    const key = await importEdKey(hexToBytes(publicKeyHex));
    return await crypto.subtle.verify(
      key.algorithm?.name || "Ed25519",
      key,
      hexToBytes(signature),
      new TextEncoder().encode(timestamp + body),
    );
  } catch (err) {
    console.error("Discord signature verify error:", err);
    return false;
  }
}

// name -> discordId map from DISCORD_MENTIONS ("Alex:111,Kristal:222").
function mentionMap(spec) {
  const map = {};
  if (!spec) return map;
  for (const pair of spec.split(",")) {
    const [k, v] = pair.split(":").map((s) => s.trim());
    if (k && v) map[k.toLowerCase()] = v;
  }
  return map;
}

export async function handleInteraction(interaction, env) {
  if (interaction.type === 1) return { type: 1 }; // PING -> PONG
  if (interaction.type === 2 && interaction.data?.name === "tasks") {
    return tasksResponse(interaction, env);
  }
  return { type: 4, data: { content: "Unsupported command.", flags: EPHEMERAL } };
}

async function tasksResponse(interaction, env) {
  // Target: the optional "user" option, else the caller.
  const opt = (interaction.data.options || []).find((o) => o.name === "user");
  const discordId = opt?.value || interaction.member?.user?.id || interaction.user?.id;

  // Discord id -> configured name -> Linear user.
  const byName = mentionMap(env.DISCORD_MENTIONS);
  const name = Object.entries(byName).find(([, id]) => id === discordId)?.[0];
  if (!name) {
    return reply(`No Linear mapping for <@${discordId}>. Add them to DISCORD_MENTIONS.`);
  }

  const users = await getUsers(env);
  const user = users.find(
    (u) =>
      (u.displayName || "").toLowerCase() === name ||
      (u.name || "").toLowerCase() === name ||
      (u.displayName || "").toLowerCase().includes(name) ||
      (u.name || "").toLowerCase().includes(name),
  );
  if (!user) return reply(`Couldn't find a Linear user matching "${name}".`);

  // Exclude recurring-chore templates (they live in the Recurring project).
  const recurringProject = env.RECURRING_PROJECT || "Recurring";
  const issues = (await fetchAssignedActiveIssues(env, user.id)).filter(
    (i) => i.project?.name !== recurringProject,
  );
  if (!issues.length) {
    return reply(`🎉 ${user.name || name} has no open tasks.`);
  }

  issues.sort((a, b) => (a.dueDate || "9999-99-99").localeCompare(b.dueDate || "9999-99-99"));
  const today = localDate(new Date()).ymd;
  const lines = issues.map(
    (i) =>
      `• \`${i.identifier}\` ${i.title}` +
      `${i.dueDate ? ` — ${formatDue(i.dueDate, today)}` : ""}` +
      `${i.state?.name ? ` _(${i.state.name})_` : ""}`,
  );

  return {
    type: 4,
    data: {
      embeds: [
        {
          title: `📋 ${user.name || name} — ${issues.length} open task${issues.length === 1 ? "" : "s"}`,
          description: lines.join("\n").slice(0, 4000),
          color: 0x5e6ad2,
        },
      ],
      flags: EPHEMERAL,
    },
  };
}

function reply(content) {
  return { type: 4, data: { content, flags: EPHEMERAL } };
}
