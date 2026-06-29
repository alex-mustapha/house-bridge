// Discord slash-command definitions, shared by the in-Worker /register-commands
// endpoint and the standalone scripts/register-commands.js. Edit here, then
// re-register (hit /register-commands?key=... or run the script).

export const COMMANDS = [
  {
    name: "tasks",
    description: "List active Linear tasks assigned to a person",
    options: [
      { type: 6, name: "user", description: "Whose tasks to show (defaults to you)", required: false },
    ],
  },
  {
    name: "project",
    description: "List open issues in a project",
    options: [
      { type: 3, name: "project", description: "Which project", required: true, autocomplete: true },
    ],
  },
  {
    name: "unassigned",
    description: "List open issues with no assignee (excludes recurring templates)",
    options: [],
  },
  {
    name: "chores",
    description: "One-off chore changes (pause, snooze, skip, add, done)",
    options: [
      {
        type: 1, // SUB_COMMAND
        name: "pause",
        description: "Pause chores (no scope = everyone; no dates = until you resume)",
        options: [
          { type: 3, name: "user", description: "Pause just this person (sick/away)", required: false, autocomplete: true },
          { type: 3, name: "chore", description: "Pause just this chore", required: false, autocomplete: true },
          { type: 3, name: "from", description: "Start date YYYY-MM-DD (default today)", required: false },
          { type: 3, name: "to", description: "End date YYYY-MM-DD (default: indefinite)", required: false },
        ],
      },
      {
        type: 1,
        name: "resume",
        description: "Clear pauses (no scope = all; or pass user/chore)",
        options: [
          { type: 3, name: "user", description: "Resume just this person", required: false, autocomplete: true },
          { type: 3, name: "chore", description: "Resume just this paused chore", required: false, autocomplete: true },
        ],
      },
      {
        type: 1,
        name: "pauses",
        description: "Show what's currently paused (holds + paused chores)",
      },
      {
        type: 1,
        name: "weight",
        description: "View or adjust rotation load skew between people",
        options: [
          { type: 3, name: "user", description: "Whose weight", required: false, autocomplete: true },
          { type: 4, name: "value", description: "New weight (higher = more chores)", required: false },
          { type: 5, name: "reset", description: "Reset this person to the default weight", required: false },
        ],
      },
      {
        type: 1,
        name: "help",
        description: "How to use the /chores commands",
      },
      {
        type: 1,
        name: "snooze",
        description: "Push a chore's due date out",
        options: [
          { type: 3, name: "chore", description: "Which chore", required: true, autocomplete: true },
          { type: 4, name: "days", description: "Days to push (default 1)", required: false },
        ],
      },
      {
        type: 1,
        name: "skip",
        description: "Skip a chore this time (archives the current copy)",
        options: [
          { type: 3, name: "chore", description: "Which chore", required: true, autocomplete: true },
        ],
      },
      {
        type: 1,
        name: "done",
        description: "Mark a chore done",
        options: [
          { type: 3, name: "chore", description: "Which chore", required: true, autocomplete: true },
        ],
      },
      {
        type: 1,
        name: "claim",
        description: "Take ownership of a chore (assigns it to you)",
        options: [
          { type: 3, name: "chore", description: "Which chore", required: true, autocomplete: true },
          { type: 3, name: "assignee", description: "Assign to someone else instead of you", required: false, autocomplete: true },
        ],
      },
      {
        type: 1,
        name: "unclaim",
        description: "Drop one of your chores back to the unassigned pool",
        options: [
          { type: 3, name: "chore", description: "Which of your chores", required: true, autocomplete: true },
        ],
      },
      {
        type: 1,
        name: "calendar",
        description: "Get the calendar-subscription links for your chores",
      },
      {
        type: 1,
        name: "sync",
        description: "Re-run the weekly generation now (idempotent — picks up new/changed templates)",
      },
      {
        type: 1,
        name: "add",
        description: "Add a one-off chore",
        options: [
          { type: 3, name: "title", description: "Chore title", required: true },
          { type: 3, name: "due", description: "Due date YYYY-MM-DD (default today)", required: false },
          { type: 3, name: "assignee", description: "Who to assign; default unassigned", required: false, autocomplete: true },
        ],
      },
    ],
  },
];
