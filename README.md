# linear-discord-bridge

A tiny Cloudflare Worker that sends **Linear → Discord** notifications for a
shared household workspace:

- **Real-time updates** — issue created / updated / completed / commented, posted
  as rich Discord embeds, routed per team.
- **Daily digest** — today's + overdue chores, **grouped by assignee and
  @-mentioning each person**, on a cron.
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
Manual toolkit (HTTP) ───────────────▶ Worker.fetch  ──▶ run cron / run week / replace / scoreboard
Cloudflare cron (daily) ─────────────▶ Worker.scheduled ─┬▶ due-date digest (by owner) ▶ Discord
                                                          ├▶ free-plan cap check ▶ Discord
                                                          └▶ Mondays: generate the week's chores
                                                                     + per-person scoreboard ▶ Discord
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
Each **Monday** the weekly recap reads template tickets from a Linear project and
generates the **coming week's** chores at once (each on its real due day), so the
full week is visible up front and can be done early. To add/change a chore you
just edit Linear — nothing to deploy. (Use `/run-week` to generate on demand,
e.g. to bootstrap mid-week.)

**One-time:** in the **Chores** team, create a project named **`Recurring`**
(must match `RECURRING_PROJECT` in `wrangler.toml`). Filter it out of your normal
views if you like — these are definitions, not chores.

**Per chore:** create a ticket in the `Recurring` project, title it the chore
name, and set the cadence with **labels** (type them in the label picker; Linear
creates them on the fly). The **description** is yours — put a checklist there
and it's copied verbatim onto every spawned chore.

Cadence is set with labels. Put each set in a Linear label **group** where noted
so only one can be picked at a time.

- **`frequency` group** (pick one): `daily`, `weekly`, `biweekly`, `triweekly`,
  `semi-monthly`, `monthly`, `bimonthly`, `semi-annually`, `annually`
- **weekday labels** (ungrouped, pick any): `monday` … `sunday` — used by
  `weekly`, `biweekly`, and `triweekly`
- **month labels** (ungrouped, pick any): `january` … `december` — which month(s)
  for `annually` / `semi-annually` / `bimonthly` (or use the `month:` directive)
- **`day-of-month` group** (pick one): `first` / `middle` / `last` →
  1st / 15th / last day — used by `monthly`, `bimonthly`, `semi-annually`,
  `annually`
- **collision group** (optional): `skip` / `replace` — default `replace`.
  `replace` only supersedes the previous copy once it's **overdue** (so you get
  the full window to finish on time); `skip` never makes a second copy while one
  is still open.
- **`paused` label** (optional): stops generating that chore until you remove it
  — ideal for seasonal chores (pause mowing in winter, resume in spring).

What each frequency does:
- `daily` — every day
- `weekly` — on its weekday labels
- `biweekly` — weekday labels, every other week (`week: even`/`odd` in
  description picks which; default even)
- `triweekly` — weekday labels, every third week (`week: 0`/`1`/`2` in
  description picks which; default 0)
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
- `week: even` / `week: odd` — biweekly phase; `week: 0`/`1`/`2` — triweekly phase
- `dueafter: 2` — due date N days out (default today)
- `opposite: Change sheets` — assign the *other* person from that chore's owner
  this run (both chores must be due the same day for it to apply)
- `start: 2026-06-27` — the first eligible date (nothing generates before it);
  for `biweekly`/`triweekly` it also **anchors** the cycle, so it proceeds every
  2 / 3 weeks from that date (no need to figure out even/odd)

Every other label (e.g. `kitchen`) is copied onto the spawned chore.

**Auto-assignment (balanced).** Set `ROTATION_MEMBERS` to your two members
(names or emails — `wrangler secret put ROTATION_MEMBERS`, e.g. `Alex,Kristal`).
When the week is generated, chores are split **≈50/50 across the whole week**
rather than each alternating independently — so weeks aren't lopsided. Fixed
owners (a template with an explicit assignee) and `opposite:` pairs are counted
in, the lighter-loaded person gets each next chore (ties alternate from last
time), and which person eats the odd chore flips each week.

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
| `GET /run-cron?key=…` | Runs the daily cron now: digest + cap check (+ weekly generation & scoreboard if it's Monday). |
| `GET /run-week?key=…` | Generates the coming week's chores immediately, any day (bootstrap/test). |
| `GET /annotate?key=…` | Refreshes the "Schedule" comment on each Recurring template (cadence + next due dates). Also runs weekly (Sundays). |
| `GET /scoreboard?key=…` | Posts the per-person scoreboard immediately, any day. |
| `GET /stats?key=…&days=90` | Posts a long-term stats report (done / on-time / missed / completion %, per person, most-missed chores) from the D1 log over the window. |
| `GET /replace?key=…&issue=CHO-12` | Archives `CHO-12` and spawns a fresh copy (same title/labels/description, due today, assignee rotated to the other member). |
| `GET /done?key=…&match=bathroom` | Marks the soonest-due active chore whose title contains the text as **Done** (excludes templates). Powers voice/shortcut "I cleaned the bathroom". |
| `GET /` | Health check — returns `linear-discord-bridge ok`. |

### Voice / "I just cleaned the X" (Alexa, Shortcuts, etc.)
The `/done` endpoint marks a chore done by name, so any trigger can drive it:
- **Alexa (natural phrase):** a custom skill needs an invocation name, so to say a
  bare *"Alexa, I just cleaned the bathroom"* you use an **Alexa Routine** on that
  phrase + a webhook bridge (IFTTT "Say a specific phrase" → Webhooks, or Voice
  Monkey) that does `GET /done?key=…&match=bathroom`. One routine per chore phrase.
- **iPhone/Siri Shortcut:** a Shortcut that hits the same URL — no third party.

Marking done also fires the normal ✅ Discord post and the "all done today" check.

### Alexa custom skill ("Alexa, tell chores I cleaned the bathroom")
The Worker serves an Alexa endpoint at `POST /alexa`. Setup (all in the web
[Alexa Developer Console](https://developer.amazon.com/alexa/console/ask) — sign
in with the **same Amazon account as your Echo** so the dev skill works on your
devices without publishing):
1. **Create Skill** → name `Chores` → model **Custom** → hosting **Provision your
   own** → **Start from Scratch**.
2. **Build → Invocation** → invocation name: `chores`.
3. **Build → Interaction Model → JSON Editor** → paste `alexa-skill-model.json`
   → **Save** → **Build Model**.
4. **Build → Endpoint** → **HTTPS** → Default Region:
   `https://<your-worker>/alexa` → SSL cert type: *"…sub-domain of a domain that
   has a wildcard certificate…"* (true for `*.workers.dev`) → **Save**.
5. Copy the **Skill ID** (Endpoint page) → `wrangler secret put ALEXA_SKILL_ID`.
6. **Test** tab → set to **Development** → try "tell chores I cleaned the
   bathroom", then say it on your Echo.

The `MarkDoneIntent` captures the chore as free text and routes through the same
`markChoreDone` logic as `/done`.

```
curl "https://<worker>/run-cron?key=YOUR_KEY"
curl "https://<worker>/run-week?key=YOUR_KEY"
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
integration creates issues but not projects. Creating projects from Discord would
use the same custom slash-command mechanism as `/tasks` below — ask if you want
that command added.

## Discord slash commands

This Worker serves a Discord **interactions endpoint** (`POST /interactions`,
Ed25519-verified) for custom slash commands. Currently:

- **`/tasks [user]`** — lists a person's active (non-done) Linear tasks. Defaults
  to you; pass a user to see theirs. Reply is ephemeral (only you see it). Maps
  Discord users to Linear accounts via `DISCORD_MENTIONS`.

**One-time setup:**
1. Create an app at the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. **General Information** → copy the **Public Key** → `wrangler secret put DISCORD_PUBLIC_KEY`. Copy the **Application ID** (used below).
3. **Bot** → Add Bot → copy the **Bot Token** (used below).
4. `npm run deploy` so the endpoint is live with the public key set.
5. Back in **General Information**, set **Interactions Endpoint URL** to
   `https://<your-worker>/interactions` and save — Discord sends a signed PING the
   Worker must answer (it will, once `DISCORD_PUBLIC_KEY` is set).
6. Authorize the app in your server (scope `applications.commands`):
   `https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=applications.commands`
7. Register the command (guild commands appear instantly):
   ```
   $env:DISCORD_APP_ID="..."; $env:DISCORD_BOT_TOKEN="..."; $env:DISCORD_GUILD_ID="..."
   node scripts/register-commands.js
   ```
   (Get the server ID via Discord Developer Mode → right-click server → Copy Server ID.)

Then type `/tasks` in any channel the app can see.

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
| `DUE_LOOKAHEAD_DAYS` | `0` | Days ahead the digest includes; `0` = today + overdue. |
| `CAP_WARN_AT` | `220` | Active-issue count that triggers the cap warning. |
| `RECURRING_PROJECT` | `Recurring` | Project holding recurring templates. |
| `CHORES_TEAM` | `CHO` | Team key used for the scoreboard. |
| `CHORES_PROJECT` | `House Chores` | Project spawned chores are created in / tracked under. |

## Analytics (D1)
Linear's free plan has no Insights, so long-term tracking lives in a **Cloudflare
D1** database (`chore-stats`, bound as `DB`). Each Monday the recap snapshots the
last 30 days of chore outcomes into the `chore_log` table (upsert by issue id, so
late completions update in place). Query it any time with `/stats?key=…&days=N`,
which posts a report (done / on-time / missed / completion %, per-person split,
most-missed chores). It's well within D1's free tier (5 GB, 100k writes/day).

## Project structure
| File | Responsibility |
|---|---|
| `src/index.js` | Worker entry: webhook handler, cron jobs, toolkit endpoints. |
| `src/verify.js` | HMAC-SHA256 verification of Linear webhook signatures. |
| `src/linear.js` | Linear GraphQL client + all queries/mutations. |
| `src/discord.js` | Builds Discord embeds/messages and posts them. |
| `src/recurring.js` | Recurring-chore engine: label parsing, cadence, rotation, replace. |
| `src/stats.js` | Weekly scoreboard computation. |
| `src/db.js` | D1 analytics: weekly snapshot + `/stats` queries. |
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
