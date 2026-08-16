# Features

The **linear-discord-bridge** is a single Cloudflare Worker that turns a Linear
workspace into a shared household chore system, with Discord as the day-to-day
interface and personal calendars as a passive view. Everything runs on free
tiers (Cloudflare Workers + D1, Linear free, Discord).

- **Linear** holds the data: recurring-chore *templates* (definitions) and the
  actual *chores* (in the House Chores project) plus one-off tasks (Ad Hoc).
- **The Worker** generates chores, posts to Discord, serves slash commands,
  reconciles changes, serves calendar feeds + a stats dashboard, and runs
  maintenance — daily on a cron plus on demand.
- **Discord** is how you interact: a daily digest with an actions dropdown, and
  the `/chores` command for one-off changes.
- **Calendars** (iOS/Google via ICS subscription) show upcoming chores passively.
- **D1** stores long-term analytics, pause history, and rotation-weight overrides.

---

## How it runs

Two entry points in one Worker:

- **`fetch()`** — receives Linear webhooks (real-time events), Discord
  interactions (slash commands + menus), calendar/status/dashboard pages, and the
  keyed toolkit endpoints.
- **`scheduled()`** — the daily cron (`0 12 * * *` UTC = 8am EDT / 7am EST).
  Every day: digest + cap check + auto-archive. **Mondays** add the weekly recap
  (settle expired pauses → generate the window → scoreboard → D1 snapshot).
  **Sundays** refresh template schedule comments.

All dates — "today", weekday, day-of-month, due dates, streaks — are computed in
**America/New_York** via `Intl.DateTimeFormat`, so they reflect the household's
real calendar day regardless of the UTC cron, and it's DST-safe. (The cron *hour*
is UTC and doesn't shift for DST — see the note in `wrangler.toml`.)

---

## Real-time activity mirror

The Worker mirrors **meaningful** Linear issue changes to Discord as they happen
(via webhooks), deliberately kept quiet:

- **Issue events** — created / completed / canceled / removed, and updates that
  change a **surfaced field** (title, status, assignee, priority, due date) — post
  a color/emoji-coded embed.
- **Comments are never echoed**, and **description-only edits are skipped** — so
  ticking a checklist box, or the bot's own schedule comments, don't spam the
  channel. (Linear's webhook `updatedFrom` tells us which fields changed.)
- **Recurring templates are excluded** from the mirror; any chore labeled
  **`silent`** is skipped too.
- **Per-team routing:** events post to `DISCORD_WEBHOOK_<TEAMKEY>` (e.g.
  `DISCORD_WEBHOOK_CHO`) if set, else `DISCORD_WEBHOOK_DEFAULT`.

Editing a **Recurring template** in Linear (a day/cadence change, or toggling the
`paused` label) doesn't post, but **triggers an immediate reconcile** of the
materialized window (see *Reconciliation*).

---

## Recurring chores (templates)

Recurring chores are defined as **template tickets** in the **Recurring** Linear
project. They're definitions, not chores to do — they stay in Backlog. The Worker
reads them and generates actual chores into **House Chores** (assigned, due-dated,
checklists copied). A 🔁 Schedule comment on each template shows its cadence,
active window, effort, and next dates.

### Labels

| Label | Purpose |
|---|---|
| **frequency** (one) | `daily` `weekly` `biweekly` `triweekly` `semi-monthly` `monthly` `bimonthly` `semi-annually` `annually`. *(Optional if you use the `every:` directive.)* |
| **weekday** (any) | `monday`…`sunday` for weekly-family cadences. **Omit** to make it an "any day" chore (due Sunday, or N/week via `count:`). |
| **month** (any) | `january`…`december`. Limits a chore to those months **every year** (all cadences — e.g. a weekly mow chore only May–Sep). For monthly-family cadences it also picks which month(s) the cycle lands on. |
| **day-of-month** | `first` / `middle` / `last` → 1st / 15th / last day (monthly-family). |
| **on-miss** | `replace` (default) — an overdue copy is **archived** by the Monday sweep and superseded next cycle. **`skip`** — never swept: the overdue copy **survives until completed**, and each recurrence still generates. Use `skip` for anything that can't just be missed (e.g. *Refill Olive's meds*); `replace` is right for chores where missing one is genuinely fine. |
| **paused** | Takes this one chore off-radar until removed (source of truth for seasonal pausing). Toggle from Discord with `/chores pause chore:` / `resume chore:`. Adding it also **retracts** already-generated future copies. |
| **silent** | Generate the chore without posting it to Discord. |
| any **room** label | Copied onto the spawned chore (e.g. `kitchen`). |

### Description directives

Parsed from the template description, then stripped from the spawned copy.

| Directive | Meaning |
|---|---|
| `start: 2026-06-27` | First eligible date; also **anchors** every-N-weeks / every-N-months / `every:` cycles. |
| `end: 2026-10-31` | Last eligible date; stops recurring after it. |
| `every: N[d\|w\|m]` | **Rolling interval** from `start:` (required): `d`=days (default), `w`=weeks, `m`=calendar months. e.g. `every: 3d`, `every: 2w`, `every: 3m`. No frequency label needed. |
| `count: 3` | "Any day" chore (weekly-family, no weekday label): times per week, auto-spread. Default 1 (due Sunday). |
| `estimate: 30m` | **Time** (`30m`, `1h30m`, …). Unestimated chores default to 15 min. |
| `effort: 1..5` | **Difficulty** (1 easiest, 5 hardest, default 3 = neutral). Multiplies the time-based balance cost (`0.5×`…`2×`), so a long-but-easy chore counts less and a short-but-hard one more. |
| `week: even`/`odd` (biweekly) or `0`/`1`/`2` (triweekly) | Which cycle. |
| `dueafter: 2` | Due N days out instead of today. |
| `opposite: Cook Dinner` | Assign the *other* person from that chore's owner on the same day. |
| `assign: monday=Kristal, friday=Alex` | **Per-weekday fixed owner.** Splits one chore across people by day, so a single template can cover "Kristal cooks Mon/Wed, Alex cooks Fri" without duplicating it. Weekdays you don't list fall through to normal rotation, so `assign: friday=Alex` pins only Fridays. A template-level **assignee** pins *every* occurrence and wins outright. Names match loosely, same as elsewhere. |

Anything else in the description (e.g. a `- [ ]` checklist) is copied onto each
spawned chore.

---

## Generation & assignment

- **Horizon:** the Worker materializes chores up to **`GEN_HORIZON_DAYS`** ahead
  (default **14**). A larger horizon is a **one-time fill** — because generation
  dedups by `(team, title, due date)`, later runs only create the new far days.
- **One-time fill safety:** each run creates at most **`GEN_MAX_CREATES`**
  (default 40) chores to stay under the Worker's 50-subrequest limit. A big
  initial fill reports "N still to create — run `/chores sync` again to finish";
  normal weekly runs never hit it.
- **Assignment is rotation-first.** Each chore **title alternates owner every
  occurrence** — whoever did it last doesn't get it next time. This is the
  primary rule, so no one gets the same chore two cycles running, and it holds
  across a whole horizon fill (the last-owner state updates as the window is
  planned, not just from a pre-run snapshot).
- **Load balancing is a tiebreak only.** Effort-adjusted time
  (`cost = estimate × effortMultiplier(effort)`, compared as `cost / weight`)
  now decides only titles with **no rotation history** — a brand-new chore.
  Member weights still come from `ROTATION_WEIGHTS` (default
  `Alex:60,Kristal:40`) with overrides via `/chores weight`. *Consequence:*
  strict alternation can leave weighted minutes uneven; that's the intended
  trade — predictable turns beat a balanced ledger.
- If the person whose turn it is is **paused** that day, the other covers, and
  the turn passes normally on the next occurrence.
- Put an explicit **assignee** on a template to **pin** that chore to one person
  (it then never rotates) — the supported way to make a chore "sticky".
- Use **`assign:`** to pin *particular weekdays* to particular people while
  leaving the rest rotating. Any title that's hand-managed this way (template
  assignee, `assign:`, or `opposite:`) is skipped by `/chores reshuffle` and
  `/chores weight`, so manual arrangements are never reshuffled away.
- `opposite:` pairs still assign the other person from the paired chore.
- **Replace policy:** overdue copies of `replace` chores are archived (Monday
  cron only) so misses don't pile up. `/chores sync` skips this so a mid-week run
  never sweeps a not-yet-done chore.
  > ⚠️ Archiving is **not** completing. A `replace` chore that was still open and
  > past due is archived *unfinished* — it leaves active views with no record in
  > Discord, and archived issues are excluded from the scoreboard, so it isn't
  > even counted as missed. That's fine for genuinely forgivable chores and wrong
  > for anything that must eventually happen — label those **`on-miss: skip`**.

---

## Reconciliation (keeps the materialized window honest)

With a long horizon you can't wait for "next week" to fix the schedule, so
changes reconcile the already-generated chores — usually **immediately**:

| Change | Effect on existing chores | When |
|---|---|---|
| Template **day/cadence** edit | archive the stale day + create the new one | Linear webhook (instant) · Monday · `/chores sync` |
| **`paused` label** added | archive its future not-yet-started copies | webhook · Monday · sync |
| **`paused` label** removed | regenerate its upcoming copies | `/chores resume chore:` · webhook · Monday |
| **Global pause** | archive the window's chores + spawn Vacation Prep | `/chores pause everyone:true` (instant) |
| **User pause** | **reassign** that person's chores to the other, in place | `/chores pause user:` (instant) |
| **Resume** | clear the hold, make catch-ups, refill, rebalance | `/chores resume` (instant) |
| **Weight change** | reassign future rotating chores to match the new split | `/chores weight` (instant) |
| Template **deletion** | *(not reconciled — orphans linger; no prune)* | — |

Reconciliation only ever touches **future, not-yet-started** chores; past-due and
in-progress ones are left alone. Reassignments/rebalances are in place (no
delete/recreate), capped at `GEN_MAX_CREATES` per run.

---

## Catch-up chores (rare chores survive a pause)

A pause normally *forgives* skipped chores. But anything **monthly or rarer**
(`monthly`, `bimonthly`, `semi-annually`, `annually`, and any `every: Nm`) that
had ≥1 occurrence inside a **global** pause window owes **one** make-up when you
return — you shouldn't lose the once-a-month maintenance over a vacation.

- Fires on **`/chores resume`** and on the **Monday cron** for dated pauses that
  expired on their own.
- One make-up per chore (not one per skipped day), idempotent, due the return day.
- Assigned to the template's **fixed owner** if it has one, else **unassigned &
  claimable**. Marked "🧺 Catch-up after the … pause".
- Daily/weekly/biweekly/triweekly/semi-monthly chores are **forgiven** (no make-up).

---

## Pausing — two mechanisms

| | Per-chore (seasonal) | Global / per-person (transient) |
|---|---|---|
| **Trigger** | `/chores pause chore:<name>` | `/chores pause everyone:true` / `/chores pause user:<name>` |
| **Stored as** | the `paused` **label** on the template | a **D1 row** (with date window) |
| **Duration** | indefinite (until removed) | `from:`/`to:` window, or open-ended |
| **Cleared by** | `/chores resume chore:` | `/chores resume` (± `user:`) |
| **History** | one comment per pause→resume cycle | soft-cleared D1 rows, shown by `/chores pauses` |

- **Guardrail:** a pause with no `user:` **refuses** unless you pass
  **`everyone:true`** — a global pause archives *every* chore in the window, so it
  can't be triggered by accident (e.g. forgetting `user:`).
- **Global** pause archives the window and spawns the **Vacation Prep** checklist
  (`VACATION_PREP_TITLE`, unassigned, due the pause start).
- **User** pause = "the other person covers": the paused person's in-window chores
  are **reassigned in place** to the other, and future generation drops them from
  rotation. On resume the window is **rebalanced** to fold them back in.
- A global vacation pause/resume **does not** touch a `paused` label, so seasonal
  chores survive a vacation cycle.
- **Dates are strict `YYYY-MM-DD`** — a malformed `from:`/`to:` is rejected.

---

## Discord slash commands

Autocomplete suggests real chores/people as you type. Run `/chores help` in
Discord for the in-channel version. **After editing commands, re-register** (hit
`/register-commands?key=<CRON_KEY>`).

**View**
```
/tasks [user:<name>]            your (or someone's) open chores
/project project:<name>         open issues in a project
/unassigned                     open chores with no assignee
```

**Pause / resume**
```
/chores pause everyone:true [from: to:]   pause the whole household (vacation)
/chores pause user:<name> [from: to:]     opt one person out (other covers)
/chores pause chore:<name>                take one chore off-radar (paused label)
/chores resume [user:|chore:]             clear holds / un-pause a chore
```

**Day-to-day**
```
/chores done chore:<name>                 mark a chore done
/chores claim chore:<name> [assignee:]    take ownership (default: you)
/chores unclaim chore:<name>              drop one of your chores to unassigned
/chores snooze chore:<name> [days:N]      push a due date out (default 1)
/chores skip chore:<name>                 skip the current copy (returns next cycle)
/chores add title:<…> [due:] [assignee:]  add a one-off chore (→ Ad Hoc, no due date by default)
```

**Info & tuning**
```
/chores pauses                            what's currently paused (+ history)
/chores weight [user: value: reset:]      view/skew the rotation load (rebalances the window)
/chores calendar                          calendar-subscription links
/chores sync                              re-run generation now (idempotent; fills the horizon)
/chores help                              the command reference
```

`done` / `claim` / `unclaim` / `snooze` / `skip` search both **House Chores** and
**Ad Hoc**. `claim` autocomplete lists only unassigned chores; `unclaim` lists
only your own. Ownership is matched by Linear **user id**, not name.

---

## Daily digest & actions dropdown

- The daily cron posts **today's + overdue** chores to the due channel, grouped by
  assignee, with @-mentions. It also lists **unassigned chores due later this
  week** (within `UNASSIGNED_LOOKAHEAD_DAYS`, default 7).
- **⏰ Past due** is its own section at the top, oldest first, showing how many
  days late each chore is and who owns it. Chores are allowed to slip — the
  point is that slipping stays *visible daily*, instead of being noticed only
  when the Monday sweep makes it vanish. @-mention counts include past-due work,
  so a day with nothing new still pings whoever's carrying something.
- When `DISCORD_BOT_TOKEN` + `DISCORD_DUE_CHANNEL_ID` are set, the digest is posted
  **by the bot** with a single **actions dropdown** (multi-select, up to 25): pick
  "✓ &lt;chore&gt;" to mark an assigned chore done, or "🙋 &lt;chore&gt;" to claim an
  unassigned one. Falls back to a plain webhook digest (no menu) otherwise.
- *Why a menu, not emoji reactions:* reactions need a persistent Discord Gateway a
  serverless Worker can't hold; menu/button interactions arrive over the same HTTP
  path as slash commands.

---

## Calendars (ICS subscription)

The Worker serves read-only calendar feeds you subscribe to once; your calendar
app polls them and stays in sync. `/chores calendar` prints the URLs.

- **`/cal/alex.ics`**, **`/cal/kristal.ics`** — that person's assigned dated work.
- **`/cal/unassigned.ics`** — unassigned dated work anyone can grab.
- Feeds cover **all active dated issues workspace-wide** (chores *and* other
  projects like a shed build), excluding only the Recurring templates.
- Each chore is an **all-day event** on its due date with a Linear link and a 9am
  day-of reminder. Rebuilt live on every fetch, so it reflects the current
  schedule automatically.
- **Apple** honors a refresh interval (set it hourly). **Google** refreshes
  subscribed URLs on its own slow schedule (up to ~24h); on Android, subscribe via
  **ICSx⁵** to control the interval.

---

## Stats dashboard

- **`/dashboard`** — a mobile-friendly, dark, keyless page (Chart.js): completion
  %, on-time %, done count, current streaks, per-person stacked bar, completion
  trend, **effort split** (effort-adjusted minutes), and most-missed. A range bar
  switches **7 / 30 / 90 / 365** days (`?range=`). Reads from D1, so history
  survives Linear archiving. A link is pinned in **#recap** (`/pin-dashboard`).

---

## Phone status (widget + web)

- **`/status?user=<name>`** — JSON: `done`, `remaining`, today's `tasks`,
  `completed` today, `streak`. Keyless.
- **`/widget?user=<name>`** — a styled auto-refreshing page ("Add to Home Screen").
- **iOS Scriptable widget** (`scriptable-chores-widget.js`).
- **Streak** = consecutive days where every chore due that day was completed
  (no-chore days bridge it; today-in-progress doesn't break it).

---

## Maintenance & analytics

- **Auto-archive:** chores completed more than `CHORE_RETENTION_DAYS` (default 30)
  ago are archived (≤`ARCHIVE_MAX` per run) so the active count stays under
  Linear's free 250 cap. Manual: `/archive?key=…`.
- **Cap warning:** posts to the admin channel once active issues reach
  `CAP_WARN_AT` (default 220). *(The 14-day horizon keeps this comfortable; a
  longer one runs much closer to the cap.)*
- **Weekly scoreboard:** per-person done / on-time / late / missed + streak.
  Completion is compared in Eastern; archived/canceled issues are excluded.
- **Stats (D1):** Monday snapshot of outcomes; query via `/stats?key=…&days=N`.

---

## Toolkit endpoints (key-guarded with `?key=<CRON_KEY>`)

| Endpoint | Action |
|---|---|
| `/run-cron` | Run the full daily cron now |
| `/run-week` | Generate the horizon now |
| `/annotate` | Refresh template schedule comments (returns a report) |
| `/archive` | Archive old completed chores now |
| `/scoreboard` · `/stats?days=N` | Post scoreboard / stats |
| `/replace?issue=CHO-12` | Archive + recreate an issue (rotates assignee) |
| `/done?match=<text>` | Mark the best-matching chore done |
| `/describe?q=<title>` | Diagnose what the engine parses for a template |
| `/delcomment?issue=…&id=…` | Delete a bot-authored comment |
| `/register-commands` | (Re)register slash commands with Discord |
| `/pin-dashboard` | Post + pin the dashboard link in #recap |
| `/botcheck` | Diagnose the bot token / channel for the digest |

**Keyless (read-only, non-sensitive):** `/status`, `/widget`, `/dashboard`,
`/cal/*.ics`. `/interactions` is the Ed25519-verified Discord endpoint.

---

## Security & verification

- **Linear webhooks** — HMAC-SHA256 against `LINEAR_WEBHOOK_SECRET`; bad/absent
  signature rejected (401).
- **Discord interactions** — verified with the app's Ed25519 key
  (`DISCORD_PUBLIC_KEY`) and inherently gated to your guild, so no shared secret.
- **Toolkit endpoints** that mutate or read sensitive data require `?key=<CRON_KEY>`.
  Status/widget/dashboard/calendar are intentionally keyless.

---

## Configuration

**Vars** (`wrangler.toml`): `DUE_LOOKAHEAD_DAYS`, `UNASSIGNED_LOOKAHEAD_DAYS`,
`CAP_WARN_AT`, `RECURRING_PROJECT`, `CHORES_TEAM`, `CHORES_PROJECT`,
`ADHOC_PROJECT`, `ROTATION_WEIGHTS`, `VACATION_PREP_TITLE`, `GEN_HORIZON_DAYS`,
`GEN_MAX_CREATES`, `PUBLIC_BASE_URL`, `DISCORD_DUE_CHANNEL_ID`,
`CHORE_RETENTION_DAYS`, `ARCHIVE_MAX`. `ROTATION_MEMBERS` and `DISCORD_MENTIONS`
map the two people for rotation and @-pings.

**Secrets** (`wrangler secret put`): `LINEAR_API_KEY` (the "muffin" bot user's
key), `LINEAR_WEBHOOK_SECRET`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN`,
`CRON_KEY`.

**Discord channels** (webhook URLs, set as secrets):

| Var | Used for |
|---|---|
| `DISCORD_WEBHOOK_DUE` | Daily digest (fallback when not bot-posting) |
| `DISCORD_DUE_CHANNEL_ID` + `DISCORD_BOT_TOKEN` | Bot-posted digest with the actions dropdown |
| `DISCORD_WEBHOOK_<TEAMKEY>` (e.g. `_CHO`) | Real-time events for that team |
| `DISCORD_WEBHOOK_DEFAULT` | Real-time events fallback |
| `DISCORD_WEBHOOK_ADMIN` | Free-tier cap warning |
| `DISCORD_WEBHOOK_STATS` | Stats posts (falls back to DUE/DEFAULT) |

> **After changing slash commands**, hit `/register-commands?key=…` so Discord
> picks them up. **After deploying**, commit and push.
