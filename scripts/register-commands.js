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
  {
    name: "chore",
    description: "One-off chore changes (hold, snooze, skip, add, done)",
    options: [
      {
        type: 1, // SUB_COMMAND
        name: "pause",
        description: "Pause chores (no scope = everyone; no dates = until you resume)",
        options: [
          { type: 3, name: "user", description: "Pause just this person (sick/away)", required: false },
          { type: 3, name: "chore", description: "Pause just this chore (title or part)", required: false },
          { type: 3, name: "from", description: "Start date YYYY-MM-DD (default today)", required: false },
          { type: 3, name: "to", description: "End date YYYY-MM-DD (default: indefinite)", required: false },
        ],
      },
      {
        type: 1,
        name: "resume",
        description: "Clear pauses (no scope = all; or pass user/chore)",
        options: [
          { type: 3, name: "user", description: "Resume just this person", required: false },
          { type: 3, name: "chore", description: "Resume just this chore (title or part)", required: false },
        ],
      },
      {
        type: 1,
        name: "snooze",
        description: "Push a chore's due date out",
        options: [
          { type: 3, name: "chore", description: "Chore title (or part of it)", required: true },
          { type: 4, name: "days", description: "Days to push (default 1)", required: false },
        ],
      },
      {
        type: 1,
        name: "skip",
        description: "Skip a chore this time (archives the current copy)",
        options: [
          { type: 3, name: "chore", description: "Chore title (or part of it)", required: true },
        ],
      },
      {
        type: 1,
        name: "done",
        description: "Mark a chore done",
        options: [
          { type: 3, name: "chore", description: "Chore title (or part of it)", required: true },
        ],
      },
      {
        type: 1,
        name: "add",
        description: "Add a one-off chore",
        options: [
          { type: 3, name: "title", description: "Chore title", required: true },
          { type: 3, name: "due", description: "Due date YYYY-MM-DD (default today)", required: false },
          { type: 3, name: "assignee", description: "Who to assign (name); default unassigned", required: false },
        ],
      },
    ],
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
