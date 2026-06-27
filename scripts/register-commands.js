// Registers the /tasks slash command for your Discord server (guild commands
// appear instantly). Run once after creating the Discord application:
//
//   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... \
//     node scripts/register-commands.js
//
// (On Windows PowerShell:
//   $env:DISCORD_APP_ID="..."; $env:DISCORD_BOT_TOKEN="..."; $env:DISCORD_GUILD_ID="...";
//   node scripts/register-commands.js )

const appId = process.env.DISCORD_APP_ID;
const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!appId || !token || !guildId) {
  console.error("Set DISCORD_APP_ID, DISCORD_BOT_TOKEN, and DISCORD_GUILD_ID.");
  process.exit(1);
}

const commands = [
  {
    name: "tasks",
    description: "List active Linear tasks assigned to a person",
    options: [
      {
        type: 6, // USER
        name: "user",
        description: "Whose tasks to show (defaults to you)",
        required: false,
      },
    ],
  },
  {
    name: "project",
    description: "List open issues in a project",
    options: [
      {
        type: 3, // STRING
        name: "project",
        description: "Which project",
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "unassigned",
    description: "List open issues with no assignee (excludes recurring templates)",
    options: [],
  },
];

const res = await fetch(
  `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`,
  {
    method: "PUT",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  },
);

console.log("Status:", res.status);
console.log(await res.text());
