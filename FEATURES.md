# Features

The **linear-discord-bridge** is a single Cloudflare Worker that turns a Linear
workspace into a shared household chore system, with Discord as the day-to-day
interface. Everything runs on free tiers (Cloudflare Workers + D1, Linear free,
Discord).

- **Linear** holds the data: recurring-chore *templates* (definitions) and the
  actual *chores* (in the House Chores project).
- **The Worker** generates chores, posts to Discord, serves slash commands, and
  runs maintenance — daily on a cron plus on demand.
- **Discord** is how you interact: a daily digest with tap-to-complete buttons,
  and the `/chores` command for one-off changes.
- **D1** stores long-term analytics and pause history.

---

## How it runs

Two entry points in one Worker:

- **`fetch()`** — receives Linear webhooks (real-time events), Discord
  interactions (slash commands + buttons), and the toolkit/status endpoints.
- **`scheduled()`** — the daily cron (`0 12 * * *` UTC = 8am EDT / 7am EST).
  Every day: digest + cap check + auto-archive. **Mondays** add the weekly recap
  (generate the week + scoreboard + D1 snapshot). **Sundays** refresh template
  schedule comments.

All dates — "today", weekday, day-of-month, due dates, streaks — are computed in
**America/New_York** via `Intl.DateTimeFormat`, so they reflect the household's
real calendar day regardless of the UTC cron, and it's DST-safe. (The cron *hour*
is UTC and doesn't shift for DST — see the note in `wrangler.toml`.)

---

## Real-time activity mirror

Beyond the daily digest, the Worker mirrors Linear activity to Discord as it
happens (via Linear webhooks):

- **Issue events** — created / updated / completed / canceled / removed — post an
  embed with status, assignee, and priority, color- and emoji-coded by action
  (🆕 created · ✏️ updated · ✅ completed · 🚫 canceled · 🗑️ removed).
- **New comments** on issues post an embed too.
- **Recurring templates are excluded** (they live in the Recurring project), and
  any chore labeled **`silent`** is skipped — so routine generation doesn't spam
  the channel.
- **Per-team routing:** events post to `DISCORD_WEBHOOK_<TEAMKEY>` (e.g.
  `DISCORD_WEBHOOK_CHO`, `DISCORD_WEBHOOK_PRJ`) if set, otherwise
  `DISCORD_WEBHOOK_DEFAULT` — so different teams can go to different channels.

---

## Recurring chores (templates)

Recurring chores are defined as **template tickets** in the **Recurring** Linear
project. They're definitions, not chores to do — they stay in Backlog. Each
Monday the Worker reads them and generates that week's actual chores into
**House Chores** (assigned, due-dated, checklists copied). A 🔁 Schedule comment
on each template shows its cadence, active window, and next dates.

### Labels

| Label | Purpose |
|---|---|
| **frequency** (one) | `daily` `weekly` `biweekly` `triweekly` `semi-monthly` `monthly` `bimonthly` `semi-annually` `annually` |
| **weekday** (any) | `monday`…`sunday` for weekly-family cadences. **Omit** to make it an "any day" chore (due Sunday, or N/week via `count:`). |
| **month** (any) | `january`…`december`. Limits a chore to those months **every year** (works on *all* cadences — e.g. a weekly mow chore only May–Sep). For monthly-family cadences it also picks which month(s) the cycle lands on. |
| **day-of-month** | `first` / `middle` / `last` → 1st / 15th / last day (monthly-family). |
| **on-miss** | `skip` (you still owe it) / `replace` (default — supersede once overdue). |
| **paused** | Takes this one chore off-radar until removed (source of truth for seasonal pausing). Toggle from Discord with `/chores pause chore:` / `resume chore:`. |
| **silent** | Generate the chore without posting it to Discord. |
| any **room** label | Copied onto the spawned chore (e.g. `kitchen`). |

### Description directives

Parsed from the template description, then stripped from the spawned copy.

| Directive | Meaning |
|---|---|
| `start: 2026-06-27` | First eligible date; also **anchors** the recurrence cycle (every-N-weeks *and* every-N-months) from that date. |
| `end: 2026-10-31` | Last eligible date; stops recurring after it (one-time window — use month labels for a yearly season). |
| `count: 3` | "Any day" chore (weekly-family, no weekday label): times per week, auto-spread (3 → Mon/Wed/Fri). Default 1 (due Sunday). |
| `estimate: 30m` | Effort (`30m`, `1h30m`, …). The weekly 50/50 balance is by **total time**, not chore count. Unestimated chores default to 15 min. |
| `week: even`/`odd` (biweekly) or `week: 0`/`1`/`2` (triweekly) | Which cycle. |
| `dueafter: 2` | Due N days out instead of today. |
| `opposite: Cook Dinner` | Assign the *other* person from that chore's owner on the same day. |

Anything else in the description (e.g. a `- [ ]` checklist) is copied onto each
spawned chore.

> **Picking dates:** the day *within* a period comes from the selector label
> (weekday for weekly-family, day-of-month for monthly-family), not from
> `start`. The first chore lands exactly on `start` only when `start` matches
> that selector. `daily` and `semi-monthly` use the start day directly.

---

## Generation & assignment

- Runs the **Monday** cron: generates the coming week's chores (today + 6 days),
  each on its real due day.
- **Assignment** balances the week by **weighted effort**: each chore's
  `estimate:` minutes are distributed so each member's `minutes / weight` ratio
  stays even. Member weights come from `ROTATION_WEIGHTS` (default
  `Alex:60,Kristal:40` → a 60/40 split) with per-person overrides via
  `/chores weight`. Accounts for fixed owners and `opposite:` pairs.
- Put an explicit **assignee** on a template to fix that chore to one person
  (skips rotation).
- **Replace policy:** overdue copies of `replace` chores are archived so misses
  don't pile up.

---

## Pausing — two mechanisms

| | Per-chore (seasonal) | Global / per-person (transient) |
|---|---|---|
| **Trigger** | `/chores pause chore:<name>` | `/chores pause` / `/chores pause user:<name>` |
| **Stored as** | the `paused` **label** on the template | a **D1 row** (with date window) |
| **Duration** | indefinite (until removed) | `from:`/`to:` window, or open-ended |
| **Cleared by** | `/chores resume chore:` | `/chores resume` (± `user:`) |
| **History** | one comment per pause→resume cycle on the template | soft-cleared D1 rows, shown by `/chores pauses` |

- **Global** pause skips all generation in-window. **User** pause = "other
  person covers": the paused person drops from rotation (their rotating chores
  shift to the other) and chores fixed to them are skipped.
- A global vacation pause/resume **does not** clear a `paused` label, so
  seasonal chores survive a vacation cycle.
- Schedule comments are pause-aware (note the hold and skip held dates in Next).

---

## Discord slash commands

Autocomplete suggests real chores/people as you type, so no exact spelling
needed. Run `/chores help` in Discord for the in-channel version.

**View**
```
/tasks [user:<name>]            your (or someone's) open chores
/project project:<name>         open issues in a project
/unassigned                     open chores with no assignee
```

**Pause / resume**
```
/chores pause [from: to:]                pause everyone (vacation)
/chores pause user:<name> [from: to:]    opt one person out
/chores pause chore:<name>               take one chore off-radar (paused label)
/chores resume [user:|chore:]            clear holds / un-pause a chore
```

**Day-to-day**
```
/chores snooze chore:<name> [days:N]     push a due date out (default 1)
/chores skip chore:<name>                skip the current copy (returns next cycle)
/chores done chore:<name>                mark a chore done
/chores add title:<…> [due:YYYY-MM-DD] [assignee:<name>]
```

**Info & tuning**
```
/chores pauses                              what's currently paused (+ history)
/chores weight [user: value: reset:]        view/skew the rotation load (e.g. 60/40)
/chores help                                the command reference
```

---

## Daily digest & tap-to-complete

- The daily cron posts **today's + overdue** chores to `#due-today`, grouped by
  assignee, with @-mentions.
- It also lists **unassigned tasks due later this week** (within
  `UNASSIGNED_LOOKAHEAD_DAYS`, default 7) under a "🙋 Unassigned — due this week"
  section, so either person can claim them before they're due.
- When `DISCORD_BOT_TOKEN` + `DISCORD_DUE_CHANNEL_ID` are set, the digest is
  posted **by the bot** with a green **✓ Done button per chore** (up to 25).
  Tapping a button marks that chore done in Linear and removes the button.
  Without those, it falls back to a plain webhook digest (no buttons).
- *Why buttons, not emoji reactions:* reactions are delivered only over a
  persistent Discord Gateway connection, which a serverless Worker can't hold —
  button clicks arrive over the same HTTP path as slash commands.
- **"All done" celebration:** completing the last due chore posts a celebration.

---

## Phone status (widget + web)

- **`/status?user=<name>`** — JSON: `done`, `remaining`, today's `tasks` (with
  Linear links), what was `completed` today, and the consecutive-day `streak`.
  Keyless (read-only).
- **`/widget?user=<name>`** — a styled, auto-refreshing web page (gradient card,
  today's list, done-today, streak). "Add to Home Screen" for an app-like icon
  (works on Android + iOS). With `&key=<CRON_KEY>` it shows ✓ Done buttons.
- **iOS Scriptable widget** (`scriptable-chores-widget.js`) — a Home/Lock Screen
  widget showing remaining count / list / streak; taps open the today page.
- **Streak** = consecutive days where every chore due that day was completed
  (days with no chores bridge it; today-in-progress doesn't break it).

---

## Maintenance & analytics

- **Auto-archive:** chores completed more than `CHORE_RETENTION_DAYS` (default
  30) ago are archived (6 days/week, ≤`ARCHIVE_MAX` per run) so the active-issue
  count stays under Linear's free 250 cap. Manual backfill: `/archive?key=…`.
- **Cap warning:** posts to the admin channel once active issues reach
  `CAP_WARN_AT` (default 220).
- **Weekly scoreboard:** per-person done / on-time / late / missed + streak.
- **Stats (D1):** Monday snapshot of outcomes; query via `/stats?key=…&days=N`.

---

## Toolkit endpoints (key-guarded with `?key=<CRON_KEY>`)

| Endpoint | Action |
|---|---|
| `/run-cron` | Run the full daily cron now |
| `/run-week` | Generate the coming week's chores now |
| `/annotate` | Refresh template schedule comments |
| `/archive` | Archive old completed chores now |
| `/scoreboard` | Post the weekly scoreboard now |
| `/stats?days=N` | Stats summary |
| `/replace?issue=CHO-12` | Archive + recreate an issue (rotates assignee) |
| `/done?match=<text>` | Mark the best-matching chore done |
| `/botcheck` | Diagnose the bot token / channel for digest buttons |
| `/status` `/widget` | Phone status (keyless) |
| `/interactions` | Discord slash-command + button endpoint (Ed25519-verified) |

---

## Security & verification

- **Linear webhooks** are verified with HMAC-SHA256 against
  `LINEAR_WEBHOOK_SECRET`; a bad/absent signature is rejected (401).
- **Discord interactions** (slash commands + buttons) are verified with the app's
  Ed25519 public key (`DISCORD_PUBLIC_KEY`) and are inherently gated to your
  guild — so they need no shared secret.
- **Toolkit endpoints** that mutate or read sensitive data require
  `?key=<CRON_KEY>`. Read-only, non-sensitive status (`/status`, `/widget`) is
  intentionally **keyless** so the phone widget needs no secret. (`/widget` only
  exposes the ✓ Done buttons when opened with `&key=`.)

---

## Configuration

**Vars** (`wrangler.toml`): `DUE_LOOKAHEAD_DAYS`, `CAP_WARN_AT`,
`RECURRING_PROJECT`, `CHORES_TEAM`, `CHORES_PROJECT`, `DISCORD_DUE_CHANNEL_ID`,
`CHORE_RETENTION_DAYS`, `ARCHIVE_MAX`. `ROTATION_MEMBERS` and `DISCORD_MENTIONS`
map your two people for rotation and @-pings.

**Secrets** (`wrangler secret put`): `LINEAR_API_KEY` (the `Chore Bot` user's
key), `LINEAR_WEBHOOK_SECRET`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`,
`CRON_KEY`.

**Discord channels** (webhook URLs, set as secrets):

| Var | Used for |
|---|---|
| `DISCORD_WEBHOOK_DUE` | Daily digest (fallback when not bot-posting) |
| `DISCORD_DUE_CHANNEL_ID` + `DISCORD_BOT_TOKEN` | Bot-posted digest with ✓ Done buttons |
| `DISCORD_WEBHOOK_<TEAMKEY>` (e.g. `_CHO`) | Real-time events for that team |
| `DISCORD_WEBHOOK_DEFAULT` | Real-time events fallback |
| `DISCORD_WEBHOOK_DONE` | "All done" celebration (falls back to DUE/DEFAULT) |
| `DISCORD_WEBHOOK_ADMIN` | Free-tier cap warning |
| `DISCORD_WEBHOOK_STATS` | Stats posts (falls back to DUE/DEFAULT) |

> **After changing slash commands**, re-run `scripts/register-commands.js` so
> Discord picks them up. **After deploying**, commit and push.
