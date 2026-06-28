// Registers the slash commands for your Discord server (guild commands appear
// instantly). Usually easier: hit the worker's /register-commands?key=<CRON_KEY>
// endpoint, which uses the bot token already in Cloudflare. This script is the
// local fallback:
//
//   $env:DISCORD_APP_ID="..."; $env:DISCORD_BOT_TOKEN="..."; $env:DISCORD_GUILD_ID="...";
//   node scripts/register-commands.js

import { COMMANDS } from "../src/commands.js";

const appId = process.env.DISCORD_APP_ID;
const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!appId || !token || !guildId) {
  console.error("Set DISCORD_APP_ID, DISCORD_BOT_TOKEN, and DISCORD_GUILD_ID.");
  process.exit(1);
}

const res = await fetch(
  `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`,
  {
    method: "PUT",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(COMMANDS),
  },
);

console.log("Status:", res.status);
console.log(await res.text());
