# house-bridge — project context for Claude

Cloudflare Worker that bridges **Linear** (chore definitions) and **Discord** (day-to-day control)
for a two-person household chore system (Alex + Kristal).

- Repo: `github.com/alex-mustapha/house-bridge`
- Local: `E:\projects\linear-discord-bridge`
- Live: `https://linear-discord-bridge.muffinfactory.workers.dev`
- See `README.md`, `FEATURES.md`, `SETUP.md` for the full picture. This file captures the
  non-obvious operational knowledge that isn't in those.

## Interaction model (design intent — honor this)
Two control surfaces, deliberately split:
- **Linear templates** (the Recurring project) define **permanent, repeating** chores via
  labels/directives: cadence, weekday, month, day-of-month, `start:`/`end:`, `count:`,
  `estimate:`, `silent`, `paused`, `opposite:`, `every: Nd|Nw|Nm`.
- **`/chores` Discord slash command** is for **one-off / transient** changes:
  `pause`/`resume` (scoped), `done`, `claim`, `unclaim`, `snooze`, `skip`, `add`, `pauses`,
  `weight`, `calendar`, `sync`, `help`. Discord is the user's preferred primary interface for
  everything except templating.

**New one-off scheduling features → add as `/chores` subcommands, NOT new endpoints/labels.**

Pause semantics:
- `/chores pause chore:<name>` toggles the **`paused` label** on the matching Recurring
  template(s) — source of truth for taking a chore off-radar. Adds a dated audit comment AND
  retracts already-generated future copies (reconcile).
- `/chores pause user:<name>` and `/chores pause everyone:true` are **D1 holds** with date
  windows (open-ended = until resume). **Guardrail:** no `user:` and no `everyone:true` →
  refuse (a global pause archives the whole window; never do it by accident).
- **User pause = "other person covers": reassign in place** (`coverUserPause`), NOT
  delete/recreate. Global pause archives the window + spawns Vacation Prep. Resume rebalances.
- Monthly-or-rarer chores skipped during a global pause get a **catch-up** make-up on resume /
  auto-expiry (`createCatchups`, `processExpiredPauses`).
- Holds are **soft-cleared** (status + cleared_at) so history is queryable via `/chores pauses`.

Long horizon + reconciliation:
- Generation materializes `GEN_HORIZON_DAYS` (30) ahead, capped at `GEN_MAX_CREATES` (40) per
  run (subrequest limit); dedup makes it a one-time fill. So changes must reconcile the existing
  window, not wait for next week: template edits (webhook → `runWeek`), `paused` label
  add/remove, and `/chores weight` (`rebalanceWindow`) all update materialized chores in place.
  Reconcile only touches future, not-yet-started chores. **Deleted-template orphans are NOT
  pruned** (deprioritized).
- Dates in `/chores pause` etc. are strict `YYYY-MM-DD` (a typo like `2026-07014` is rejected).

## Gotchas
- **Deploy → commit → push, same turn.** After every `npm run deploy`, immediately
  `git add -A && git commit && git push`. The repo must match what's deployed (a future GH
  Action will make push-to-deploy the trigger).
- **node/npm aren't on PATH in fresh shells here.** Prepend:
  `$env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")`
  before npm/wrangler. Git remote is SSH globally (`insteadOf` rewrite) — pushes need no auth prompt.
- **After editing slash commands** (`src/commands.js`), re-register by hitting
  **`/register-commands?key=<CRON_KEY>`** (uses the bot token already in Cloudflare, derives app
  id, auto-detects guild). `scripts/register-commands.js` is the local fallback.
- **Worker secrets are write-only** — you can't read `DISCORD_BOT_TOKEN` back out of wrangler.
  Slash-command mutations are safe without a secret (Ed25519-verified + guild-gated), unlike the
  keyed HTTP toolkit endpoints.
- **`LINEAR_API_KEY` is a dedicated bot user** (display name "muffin" / Chore Bot), not Alex's
  personal key. Linear forbids editing a comment authored by a *different* user
  ("Cannot modify Comment"), so code that refreshes comments (`annotateTemplates`, pause-cycle
  comments) must look up the viewer (`getViewerId`) and edit only its own comments, creating a
  fresh one otherwise.
- **Match identity by Linear user id, never name strings.** `name` and `displayName` diverge:
  - Alex: name `Alex`, displayName `kalinowski89`, id `04d81d50-eadf-42f8-81a2-c2a6fdb54f3e` (Discord OddRanger maps here)
  - Kristal: name `Kristal`, displayName `kristalwhelan1`, id `46625b52-b6c9-4593-b2a9-177844f2cb13`
  - muffin (bot): id `34acd77e-416d-4e50-97c7-4cb3c96f040c`
  Ownership checks compare ids (`resolveCaller id === issue.assignee.id`). For friendly Discord
  display, prefer `name` over `displayName`.
