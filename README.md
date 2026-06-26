# linear-discord-bridge

A tiny Cloudflare Worker that sends **Linear → Discord** notifications for a
shared household workspace:

- **Real-time updates** — issue created / updated / completed / commented, posted
  as rich Discord embeds, routed per team.
- **Daily digest** — due/overdue chores, **split by owner and @-mentioning each
  person**, with room tags, on a cron.
- **Recurring chores** — a free replacement for Linear's paid recurring issues,
  authored entirely in Linear, with auto-assignment that alternates owners.
- **Free-plan cap warning** — pings `#bot-log` as you approach the 250 active-issue
  limit so you know when to archive.
- **"All done today" celebration** — when you complete a chore and nothing else
  due today/overdue remains in that team, posts a 🎉 to Discord.
- **Weekly scoreboard** — every Monday, a separate scoreboard per person
  (done, on-time, missed, streak).
- **Manual toolkit** — key-guarded HTTP endpoints to run the cron, force a
  replace, or post the scoreboard on demand.

Everything here runs on **free tiers** (Cloudflare Workers free plan, Linear free
plan, Discord webhooks). You will not hit a paywall.

> Note: Linear's *native* Discord integration is inbound only (`/linear issue`,
> `/linear search`, `/linear wrap`). It does **not** push updates to Discord.
> This Worker fills that gap. You can run both side by side.

---

## Recommended Discord layout (Layout A)

```
📥 INBOX
   # capture           ← capture chores with /linear issue from your phone
🧹 CHORES
   # chores-activity    ← all chore events (room shown as a label in the embed)
   # done               ← the satisfying "completed" wall
🛠️ PROJECTS
   # projects-activity
   # project-updates    ← weekly status posts
📅 DAILY
   # due-soon           ← morning digest, split by owner + @-mentions; also the
                          default home for the 🎉 celebration and weekly scoreboard
🤖 ADMIN
   # bot-log            ← Worker health + "near 250-issue cap" warnings
```

The 🎉 celebration and scoreboard default to `#due-soon`; set
`DISCORD_WEBHOOK_DONE` / `DISCORD_WEBHOOK_STATS` to give them their own channels.

Rooms (bedroom, bathroom, kitchen…) live as **Linear labels**, not channels —
so the feed stays quiet and the digest tags each item by room. Promote a room to
its own channel later only if it gets noisy enough to deserve one.

Webhook → channel mapping for this layout:
- `DISCORD_WEBHOOK_CHO` → `#chores-activity`
- `DISCORD_WEBHOOK_PRJ` → `#projects-activity`
- `DISCORD_WEBHOOK_DUE` → `#due-soon`
- `DISCORD_WEBHOOK_ADMIN` → `#bot-log`
- `DISCORD_WEBHOOK_DEFAULT` → fallback (point at `#chores-activity` to start)

## Architecture

```
Linear issue/comment event ──webhook──▶ Worker.fetch ──▶ Discord channel webhook
Manual toolkit (HTTP) ───────────────▶ Worker.fetch  ──▶ run cron / replace issue / scoreboard
Cloudflare cron (daily) ─────────────▶ Worker.scheduled ─┬▶ due-date digest (by owner) ▶ Discord
                                                          ├▶ create recurring chores in Linear
                                                          ├▶ free-plan cap check ▶ Discord
                                                          └▶ weekly scoreboard (Mondays) ▶ Discord
```

Why a Worker at all? Linear and Discord webhooks use **incompatible JSON
formats** — you can't point one at the other. The Worker translates between them
and is the thing that runs the daily timer.

---

## One-time setup

### 1. Prerequisites
- A free [Cloudflare account](https://dash.cloudflare.com/sign-up).
- Node.js + npm.
- Install deps: `npm install`
- Log in: `npx wrangler login`

### 2. Linear workspace
Create a **personal** Linear workspace (keep this separate from any work org),
then create two teams:
- **Chores** — team key `CHO`
- **Projects** — team key `PRJ`

Get a personal API key: Linear → **Settings → Security & access → Personal API
keys** → create one. This is your `LINEAR_API_KEY`.

### 3. Discord webhooks
In your Discord server, create the channels you want (e.g. `#chores`,
`#projects`, `#due-soon`). For each, go to **Channel Settings → Integrations →
Webhooks → New Webhook**, then **Copy Webhook URL**.

You'll map them like this:
- `DISCORD_WEBHOOK_CHO` → `#chores`
- `DISCORD_WEBHOOK_PRJ` → `#projects`
- `DISCORD_WEBHOOK_DUE` → `#due-soon`
- `DISCORD_WEBHOOK_DEFAULT` → fallback for any team without its own webhook

### 4. Set secrets
Pick a webhook secret string (any random value) — you'll reuse it in step 6.

```bash
wrangler secret put LINEAR_WEBHOOK_SECRET     # the random string you chose
wrangler secret put LINEAR_API_KEY            # from step 2
wrangler secret put DISCORD_WEBHOOK_DEFAULT
wrangler secret put DISCORD_WEBHOOK_CHO
wrangler secret put DISCORD_WEBHOOK_PRJ
wrangler secret put DISCORD_WEBHOOK_DUE
wrangler secret put DISCORD_WEBHOOK_ADMIN     # the #bot-log channel
```

(For local dev instead, copy `.dev.vars.example` to `.dev.vars` and fill it in.)

### 5. Deploy

```bash
npm run deploy
```

Wrangler prints your Worker URL, e.g.
`https://linear-discord-bridge.<your-subdomain>.workers.dev`.

### 6. Create the Linear webhook
Linear → **Settings → API → Webhooks → New webhook**:
- **URL**: your Worker URL from step 5
- **Secret**: the same string you set as `LINEAR_WEBHOOK_SECRET`
- **Data change events**: enable **Issues** and **Comments**

Save. Linear now POSTs events to the Worker, which verifies the signature and
forwards them to Discord.

### 7. Recurring chores — authored in Linear (no code)
The daily cron reads template tickets from a Linear project and spawns the real
chores. To add/change a chore you just edit Linear — nothing to deploy.

**One-time:** in the **Chores** team, create a project named **`Recurring`**
(must match `RECURRING_PROJECT` in `wrangler.toml`). Filter it out of your normal
views if you like — these are definitions, not chores.

**Per chore:** create a ticket in the `Recurring` project, title it the chore
name, and set the cadence with **labels** (type them in the label picker; Linear
creates them on the fly). The **description** is yours — put a checklist there
and it's copied verbatim onto every spawned chore.

Cadence is set with labels. Put each set in a Linear label **group** where noted
so only one can be picked at a time.

- **`frequency` group** (pick one): `daily`, `weekly`, `biweekly`,
  `semi-monthly`, `monthly`, `bimonthly`, `semi-annually`, `annually`
- **weekday labels** (ungrouped, pick any): `monday` … `sunday` — used by
  `weekly` and `biweekly`
- **`day-of-month` group** (pick one): `first` / `middle` / `last` →
  1st / 15th / last day — used by `monthly`, `bimonthly`, `semi-annually`,
  `annually`
- **collision group** (optional): `skip` / `replace` — default `replace`

What each frequency does:
- `daily` — every day
- `weekly` — on its weekday labels
- `biweekly` — weekday labels, every other week (`week: even`/`odd` in
  description picks which; default even)
- `semi-monthly` — 1st and 15th
- `monthly` — its day-of-month label, every month
- `bimonthly` — its day-of-month label, every other month (default odd months;
  `month:` overrides)
- `semi-annually` — its day-of-month label, twice a year (default Jan & Jul;
  `month:` overrides)
- `annually` — its day-of-month label, once a year (default January; set
  `month: june` etc. in the description)

Optional description directives (parsed, then stripped from the copied body):
- `month: june` or `month: jan, jul` — which month(s) for annual/semi-annual/bimonthly
- `week: even` / `week: odd` — biweekly phase
- `dueafter: 2` — due date N days out (default today)

Every other label (e.g. `kitchen`) is copied onto the spawned chore.

**Auto-assignment (rotation).** Set `ROTATION_MEMBERS` to your two members
(names or emails, in alternation order — `wrangler secret put ROTATION_MEMBERS`,
e.g. `Alex,Kristal`). Each time a chore spawns, the Worker looks up who had the
previous copy (archived included) and assigns the other person — so chores
switch off automatically. Give a template ticket an explicit assignee to opt it
out of rotation (fixed owner).

Example — kitchen cleaned M/W/F, deep-cleaned on the 1st of each month:
- Ticket `Clean the kitchen`: labels `weekly` `monday` `wednesday` `friday` `kitchen`
- Ticket `Deep clean the kitchen`: labels `monthly` `first` `skip` `kitchen`

> Power-user option: chores can also be hard-coded in the `RECURRING` array in
> `src/recurring.js`. Leave it empty to rely entirely on Linear.

### 8. (Optional) Enable the manual toolkit + extras
```
wrangler secret put CRON_KEY           # enables the on-demand endpoints
wrangler secret put DISCORD_MENTIONS   # Name:DiscordUserID,… for digest @-mentions
wrangler secret put ROTATION_MEMBERS   # Alex,Kristal — alternating assignment
npm run deploy
```
See **Manual toolkit** and **Configuration reference** below. Leave any of these
unset to disable that feature.

---

## Continuous deployment (draft)
`.github/workflows/deploy.yml` can deploy the Worker from GitHub via
`cloudflare/wrangler-action`. It's currently **manual-run only**
(`workflow_dispatch`) — primary deploys are still `npm run deploy`. To enable it:
add a `CLOUDFLARE_API_TOKEN` repo secret ("Edit Cloudflare Workers" token), then
run it from the Actions tab. Uncomment the `push:` trigger in the workflow to
auto-deploy on every push to `main`. It uploads code only — your Worker secrets
persist and aren't touched.

## Adjusting the schedule
The cron in `wrangler.toml` is in **UTC**. Change `crons` to hit your local
morning (the file has examples), then redeploy.

## Manual toolkit
On-demand HTTP endpoints for intervening outside the schedule. All require
`?key=<CRON_KEY>` and return `404` without a valid key. Trigger from a browser or
`curl`, and watch `npx wrangler tail` to see the result.

| Endpoint | What it does |
|---|---|
| `GET /run-cron?key=…` | Runs the full daily cron now: digest, recurring spawns, cap check (+ scoreboard if it's Monday). |
| `GET /scoreboard?key=…` | Posts the weekly scoreboard immediately, any day. |
| `GET /replace?key=…&issue=CHO-12` | Archives `CHO-12` and spawns a fresh copy (same title/labels/description, due today, assignee rotated to the other member). |
| `GET /` | Health check — returns `linear-discord-bridge ok`. |

```
curl "https://<worker>/run-cron?key=YOUR_KEY"
curl "https://<worker>/scoreboard?key=YOUR_KEY"
curl "https://<worker>/replace?key=YOUR_KEY&issue=CHO-12"
```
(Use `curl.exe` in Windows PowerShell, or just paste the URL into a browser.)

## Creating issues & projects from Discord

**Issues — Linear's native Discord integration (no code).**
1. Linear → **Settings → Features → Integrations → Discord** → enable it (a
   workspace admin, once) and authorize your Discord server.
2. Each member links their account, then in any channel:
   - `/linear issue` — create an issue (team, title, assignee, …)
   - `/linear search` — find and link an issue
   - `/linear wrap` — post what you completed in the last 24h

This is inbound only (Discord → Linear); this Worker handles everything outbound.
Run both side by side.

**Projects — not supported by the native integration.** Linear's Discord
integration creates issues but not projects. To create projects (or other custom
commands) from Discord you need a small **Discord slash-command app** that posts
to a Worker endpoint, which then calls Linear's API. That's a separate build
(create a Discord application, register slash commands, add an interactions
endpoint with Ed25519 request verification). It can live in this same Worker —
ask if you want it added.

## Configuration reference
Non-secret vars live in `wrangler.toml`; everything sensitive is a Wrangler
secret (`wrangler secret put NAME`). Local dev reads `.dev.vars` (see
`.dev.vars.example`).

**Secrets**
| Name | Required | Purpose |
|---|---|---|
| `LINEAR_WEBHOOK_SECRET` | yes | Verifies inbound Linear webhooks (Linear's signing secret). |
| `LINEAR_API_KEY` | yes | Linear personal API key for queries/mutations. |
| `DISCORD_WEBHOOK_<TEAMKEY>` | yes | Per-team activity channel, e.g. `DISCORD_WEBHOOK_CHO`. |
| `DISCORD_WEBHOOK_DEFAULT` | yes | Fallback channel for unmapped teams. |
| `DISCORD_WEBHOOK_DUE` | yes | Daily digest channel. |
| `DISCORD_WEBHOOK_ADMIN` | rec. | Cap warnings / bot log. |
| `DISCORD_WEBHOOK_DONE` | opt. | "All done" celebration (falls back to DUE → DEFAULT). |
| `DISCORD_WEBHOOK_STATS` | opt. | Weekly scoreboard (falls back to DUE → DEFAULT). |
| `DISCORD_MENTIONS` | opt. | `Name:DiscordUserID,…` so the digest @-mentions owners. |
| `ROTATION_MEMBERS` | opt. | `Alex,Kristal` — alternating auto-assignment. |
| `CRON_KEY` | opt. | Enables the manual toolkit endpoints. |

**Vars (`wrangler.toml`)**
| Name | Default | Purpose |
|---|---|---|
| `DUE_LOOKAHEAD_DAYS` | `3` | Digest look-ahead window (days). |
| `CAP_WARN_AT` | `220` | Active-issue count that triggers the cap warning. |
| `RECURRING_PROJECT` | `Recurring` | Project holding recurring templates. |
| `CHORES_TEAM` | `CHO` | Team key used for the scoreboard. |

## Project structure
| File | Responsibility |
|---|---|
| `src/index.js` | Worker entry: webhook handler, cron jobs, toolkit endpoints. |
| `src/verify.js` | HMAC-SHA256 verification of Linear webhook signatures. |
| `src/linear.js` | Linear GraphQL client + all queries/mutations. |
| `src/discord.js` | Builds Discord embeds/messages and posts them. |
| `src/recurring.js` | Recurring-chore engine: label parsing, cadence, rotation, replace. |
| `src/stats.js` | Weekly scoreboard computation. |
| `wrangler.toml` | Worker config, cron schedule, non-secret vars. |
| `SETUP.md` | First-time setup checklist. |

## Testing
- `npm run tail` — live-stream Worker logs while you create/update an issue.
- `curl https://<your-worker-url>/` — health check, returns `ok`.
- Trigger the cron locally: `npm run cron:test`, then visit the printed
  `/__scheduled` URL (wrangler prints exact instructions).

## Cost
| Piece | Cost |
|---|---|
| Cloudflare Worker (100k req/day + cron) | Free |
| Linear free plan (API + webhooks) | Free |
| Discord webhooks | Free |

Not free, and deliberately avoided here: Linear's native recurring issues (paid)
and Zapier/Make beyond their small free quotas.
